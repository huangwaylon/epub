import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { VitePWA } from 'vite-plugin-pwa'
import { devTranslate } from './vite-plugins/dev-translate'

// https://vite.dev/config/
export default defineConfig(({ command }) => {
  // Served from a GitHub Pages project site at https://<user>.github.io/epub/, so the
  // production build needs the `/epub/` base. Keep dev at root for a clean local URL.
  const base = command === 'build' ? '/epub/' : '/'
  return {
    base,
    plugins: [
      svelte(),
      devTranslate(),
      VitePWA({
        registerType: 'prompt',
        includeAssets: ['favicon.svg', 'icons/apple-touch-icon-180.png'],
        manifest: {
          name: 'Tsuzuri — Japanese Reader',
          short_name: 'Tsuzuri',
          description: 'A clean, paginated EPUB reader for Japanese books, with built-in dictionary lookup and translation.',
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
          // Precache the app shell. Books live in OPFS and dictionary data lives in
          // jpdict's own IndexedDB, so neither is fetched through the service worker.
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
          // PDF.js is large and we are EPUB-focused; don't bloat the precache with it.
          globIgnores: ['**/pdfjs/**'],
          maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
          navigateFallback: `${base}index.html`,
          cleanupOutdatedCaches: true,
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
