import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { VitePWA } from 'vite-plugin-pwa'

// `__APP_VERSION__` (commit date · short SHA) for the Settings "About" row.
function appVersion(): string {
  try {
    const sha = execSync('git rev-parse --short HEAD').toString().trim()
    const date = execSync('git log -1 --format=%cs').toString().trim() // YYYY-MM-DD
    return `${date} · ${sha}`
  } catch {
    return 'dev'
  }
}

export default defineConfig(({ command }) => {
  // GitHub Pages project site (https://<user>.github.io/epub/).
  const base = command === 'build' ? '/epub/' : '/'
  // Swap in our kuromoji dictionary loader. The regex matches the whole specifier so it
  // also pre-empts the package's `browser` field.
  const kuromojiLoader = fileURLToPath(new URL('./src/services/jp/kuromojiLoader.cjs', import.meta.url))
  const isLoader = (s: string) => /loader\/(?:Node|Browser)DictionaryLoader(?:\.js)?$/.test(s)
  return {
    base,
    define: {
      __APP_VERSION__: JSON.stringify(appVersion()),
    },
    resolve: {
      alias: [
        { find: /^.*\/loader\/(?:Node|Browser)DictionaryLoader(?:\.js)?$/, replacement: kuromojiLoader },
      ],
    },
    optimizeDeps: {
      // The dev prebundle ignores resolve.alias for a dep's internals, so alias here too.
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
        // Read by the OS at install only; don't precache.
        includeManifestIcons: false,
        manifest: {
          name: 'Tsuzuri — Japanese Reader',
          short_name: 'Tsuzuri',
          description: 'A clean, paginated EPUB reader for Japanese books, with built-in offline dictionary lookup.',
          lang: 'en',
          display: 'standalone',
          orientation: 'any',
          background_color: '#f6f3ec',
          theme_color: '#f6f3ec',
          start_url: base,
          scope: base,
          icons: [
            { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          // Control the first-visit page too, so the IPADIC dict fetched in that session is
          // runtime-cached. Updates still wait for the prompt (no skipWaiting mid-read).
          clientsClaim: true,
          // App shell only. Manifest icons and splash screens are fetched by the OS at install.
          globPatterns: ['**/*.{js,css,html}', 'favicon.svg', 'icons/apple-touch-icon-180.png'],
          // The IPADIC dict is runtime-cached (below). The foliate loaders are unreachable
          // (EPUB only, no TTS/search); the `foliate-` prefix comes from chunkFileNames.
          globIgnores: ['**/kuromoji/**', 'assets/foliate-{mobi,fb2,comic-book,tts,search}-*.js'],
          maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
          navigateFallback: `${base}index.html`,
          cleanupOutdatedCaches: true,
          // Deliberately NO expiration (age or maxEntries): the dict is an all-or-nothing
          // shard set, and evicting one shard leaves a partial dict that builds no trie.
          runtimeCaching: [
            {
              urlPattern: /\/kuromoji\/dict\/.*\.dat\.gz$/,
              handler: 'CacheFirst',
              options: {
                // Bump with the dict contents; keep in sync with IPADIC_CACHE (jp/ipadic.ts).
                cacheName: 'kuromoji-ipadic-v2',
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
        },
        devOptions: {
          // SW in `vite dev`, for on-device install/offline testing.
          enabled: true,
          type: 'module',
        },
      }),
    ],
    build: {
      rolldownOptions: {
        output: {
          // Prefix foliate chunks so globIgnores above can't match an app chunk.
          chunkFileNames(chunk) {
            const foliate = (id: string) => id.includes('/vendor/foliate-js/')
            const isFoliate = chunk.facadeModuleId
              ? foliate(chunk.facadeModuleId)
              : chunk.moduleIds.length > 0 && chunk.moduleIds.every(foliate)
            return isFoliate ? 'assets/foliate-[name]-[hash].js' : 'assets/[name]-[hash].js'
          },
        },
      },
    },
    server: {
      host: true, // expose on LAN for on-device iOS testing
    },
    worker: {
      format: 'es',
    },
  }
})
