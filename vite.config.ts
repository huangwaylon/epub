import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { VitePWA } from 'vite-plugin-pwa'

// A human-readable build version (commit date + short SHA) baked in at config time
// and exposed as the `__APP_VERSION__` global, so the Settings "About" section can
// show which build is running. Falls back to "dev" outside a git checkout.
function appVersion(): string {
  try {
    const sha = execSync('git rev-parse --short HEAD').toString().trim()
    const date = execSync('git log -1 --format=%cs').toString().trim() // YYYY-MM-DD
    return `${date} · ${sha}`
  } catch {
    return 'dev'
  }
}

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
    define: {
      __APP_VERSION__: JSON.stringify(appVersion()),
    },
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
          // Take control of the page as soon as the SW activates, even on the very
          // first visit. Without this, a freshly-installed SW doesn't control the
          // already-loaded page, so the kuromoji IPADIC dict the lookup worker fetches
          // *during that first session* (right after the dictionary download, via
          // warmupLookup) bypasses the SW and is never runtime-cached — and the first
          // offline tap would then fail to fetch it. `registerType: 'prompt'` still
          // governs *updates* (we never skipWaiting out from under a reading user).
          clientsClaim: true,
          // Precache the app shell. Books live in OPFS and the JMdict data lives in
          // jpdict's own IndexedDB, so neither is fetched through the service worker.
          // (No web fonts are bundled — the app uses the system JP stack — so there's
          // nothing to glob beyond JS/CSS/HTML and the favicon/icon images.)
          globPatterns: ['**/*.{js,css,html,svg,png}'],
          // PDF.js and the ~19 MB kuromoji IPADIC dict are large; keep them out of the
          // install-time precache (the dict is runtime-cached on first use, below).
          // Also drop foliate's format loaders this app can never reach — it opens
          // EPUB only, with no TTS/search UI — so the PWA install isn't padded with
          // ~17 KB of dead chunks the browser would never request.
          globIgnores: [
            '**/pdfjs/**',
            '**/kuromoji/**',
            '**/mobi-*.js',
            '**/fb2-*.js',
            '**/comic-book-*.js',
            '**/tts-*.js',
            '**/search-*.js',
          ],
          maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
          navigateFallback: `${base}index.html`,
          cleanupOutdatedCaches: true,
          // The kuromoji IPADIC dictionary (*.dat.gz under /kuromoji/dict/) is fetched
          // on first tap-to-define; cache it so word segmentation works offline after.
          // It's build-versioned immutable data, so there's deliberately NO expiry — by
          // age *or* entry count. The dict is an all-or-nothing set of ~12 files; an LRU
          // `maxEntries` cap would, once crossed (e.g. a future kuromoji bump adding
          // files), silently evict one shard and leave a *partial* dict, which makes the
          // trie build fail and degrades tap-to-define to greedy segmentation with no way
          // to refetch. `cleanupOutdatedCaches` already drops stale caches across deploys.
          runtimeCaching: [
            {
              urlPattern: /\/kuromoji\/dict\/.*\.dat\.gz$/,
              handler: 'CacheFirst',
              options: {
                cacheName: 'kuromoji-ipadic',
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
