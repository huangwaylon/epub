import { mount } from 'svelte'
import { registerSW } from 'virtual:pwa-register'
import './app.css'
import App from './App.svelte'
import { initSettings } from './stores/settings.svelte'
import { validateRestoredRoute } from './stores/nav.svelte'
import { pwa } from './stores/pwa.svelte'
import { getBookMeta } from './services/storage/db'
import { requestPersistence } from './services/storage/persist'
import { initViewport } from './services/viewport'

// Seed settings from the synchronous localStorage mirror (the inline script in
// index.html has already set data-theme from it) and hydrate from IndexedDB in the
// background — mounting never waits on IDB, which can take a beat on a cold iOS launch.
void initSettings()

// Publish the real (visual) viewport height as --app-height so the full-screen shell
// tracks the screen on iOS — without this a cold PWA launch lays out against an
// under-reported viewport and a bottom bar shows a gap until rotation.
initViewport()

// A reader route restored from sessionStorage (an update-reload mid-book) is only
// honoured if that book is still on the shelf.
void validateRestoredRoute(async (id) => !!(await getBookMeta(id)))

// Ask the browser to keep our books & dictionary durable (no-op if already granted).
void requestPersistence()

/** Check for a new deploy at most this often, on return to the foreground. */
const SW_UPDATE_CHECK_MS = 60 * 60 * 1000

// Register the service worker; expose update availability to the UI.
const updateSW = registerSW({
  onNeedRefresh() {
    pwa.needRefresh = true
    pwa.update = () => updateSW(true)
  },
  onOfflineReady() {
    pwa.offlineReady = true
  },
  // An installed iOS PWA is rarely navigated fresh — it's resumed from the background —
  // so the browser's own navigation-time update check almost never runs. Poll when the
  // app comes back to the foreground instead, throttled to once an hour.
  onRegisteredSW(_url, registration) {
    if (!registration) return
    let lastCheck = Date.now()
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return
      if (Date.now() - lastCheck < SW_UPDATE_CHECK_MS) return
      lastCheck = Date.now()
      registration.update().catch(() => {})
    })
  },
})

// The kuromoji dict's runtime cache was renamed to 'kuromoji-ipadic-v2' (new dict
// contents); Workbox's cleanupOutdatedCaches only prunes *precaches*, so drop the old
// ~19 MB runtime cache ourselves.
if ('caches' in window) void caches.delete('kuromoji-ipadic').catch(() => {})

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
