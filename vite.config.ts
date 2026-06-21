import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig(({ command }) => {
  // Served from a GitHub Pages project site at https://<user>.github.io/epub/, so the
  // production build needs the `/epub/` base. Keep dev at root for a clean local URL.
  const base = command === 'build' ? '/epub/' : '/'
  // Replace kuromoji's dictionary loader with a defensive one (see the file header:
  // tolerates servers that auto-decompress the gzipped dict). The regex matches the
  // *whole* import specifier so the replacement is a clean absolute path, and pre-empts
  // the package's `browser` field (which would otherwise pick its own loader).
  const kuromojiLoader = fileURLToPath(new URL('./src/services/jp/kuromojiLoader.cjs', import.meta.url))
  const isLoader = (s: string) => /loader\/(?:Node|Browser)DictionaryLoader(?:\.js)?$/.test(s)
  return {
    base,
    resolve: {
      // Applies during the production build (Rolldown).
      alias: [
        { find: /^.*\/loader\/(?:Node|Browser)DictionaryLoader(?:\.js)?$/, replacement: kuromojiLoader },
      ],
    },
    optimizeDeps: {
      // The dev prebundle (Rolldown) doesn't honour resolve.alias for a dep's internals,
      // so alias the loader here too — otherwise the dev build uses kuromoji's own loader.
      rolldownOptions: {
        plugins: [
          {
            name: 'kuromoji-loader-alias',
            resolveId(source: string) {
              return isLoader(source) ? kuromojiLoader : null
            },
          },
        ],
      },
    },
    plugins: [
      svelte(),
      VitePWA({
        registerType: 'prompt',
        includeAssets: ['favicon.svg', 'icons/apple-touch-icon-180.png'],
        manifest: {
          name: 'Tsuzuri — Japanese Reader',
          short_name: 'Tsuzuri',
          description: 'A clean, paginated EPUB reader for Japanese books, with built-in offline dictionary lookup.',
          lang: 'en',
          display: 'standalone',
          orientation: 'any',
          background_color: '#f6f3ec',
          theme_color: '#f6f3ec',
          // Match the base so the installed PWA opens and scopes correctly under /epub/.
          start_url: base,
          scope: base,
          icons: [
            { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          // Precache the app shell. Books live in OPFS and the JMdict data lives in
          // jpdict's own IndexedDB, so neither is fetched through the service worker.
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
          // PDF.js and the ~19 MB kuromoji IPADIC dict are large; keep them out of the
          // install-time precache (the dict is runtime-cached on first use, below).
          globIgnores: ['**/pdfjs/**', '**/kuromoji/**'],
          maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
          navigateFallback: `${base}index.html`,
          cleanupOutdatedCaches: true,
          // The kuromoji IPADIC dictionary (*.dat.gz under /kuromoji/dict/) is fetched
          // on first tap-to-define; cache it so word segmentation works offline after.
          runtimeCaching: [
            {
              urlPattern: /\/kuromoji\/dict\/.*\.dat\.gz$/,
              handler: 'CacheFirst',
              options: {
                cacheName: 'kuromoji-ipadic',
                expiration: { maxEntries: 16, maxAgeSeconds: 60 * 60 * 24 * 180 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
        },
        devOptions: {
          // Enables the service worker in `vite dev` so on-device install/offline can be tested.
          enabled: true,
          type: 'module',
        },
      }),
    ],
    server: {
      host: true, // expose on LAN for on-device iOS testing
    },
    worker: {
      format: 'es',
    },
  }
})
