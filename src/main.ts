import { mount } from 'svelte'
import { registerSW } from 'virtual:pwa-register'
import './app.css'
import App from './App.svelte'
import { initSettings } from './stores/settings.svelte'
import { rememberRouteForReload, validateRestoredRoute } from './stores/nav.svelte'
import { pwa } from './stores/pwa.svelte'
import { getBookMeta } from './services/storage/db'
import { requestPersistence } from './services/storage/persist'
import { initViewport } from './services/viewport'

// Not awaited: IDB can take a beat on a cold iOS launch; the localStorage mirror covers first paint.
void initSettings()
initViewport()
void validateRestoredRoute(async (id) => !!(await getBookMeta(id)))
void requestPersistence()

const SW_UPDATE_CHECK_MS = 60 * 60 * 1000

const updateSW = registerSW({
  onNeedRefresh() {
    pwa.needRefresh = true
    pwa.update = () => {
      rememberRouteForReload()
      return updateSW(true)
    }
  },
  onOfflineReady() {
    pwa.offlineReady = true
  },
  // An installed iOS PWA is resumed, rarely navigated, so the browser's own update check
  // almost never runs. Check on return to the foreground instead, at most hourly.
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

// cleanupOutdatedCaches only prunes precaches, so drop the superseded runtime dict cache here.
if ('caches' in window) void caches.delete('kuromoji-ipadic').catch(() => {})

// Re-fill the offline IPADIC cache if the dictionary is installed (cheap when already cached).
// Idle-deferred and dynamic so jpdict-idb stays off the shelf's critical path.
setTimeout(() => {
  if (!navigator.onLine || !('caches' in window)) return
  void import('./services/jp/dictdb')
    .then(async (m) => {
      if (await m.isDictReady()) await m.cacheIpadic()
    })
    .catch(() => {})
}, 4000)

export default mount(App, { target: document.getElementById('app')! })
