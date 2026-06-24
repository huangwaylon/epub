import { mount } from 'svelte'
import { registerSW } from 'virtual:pwa-register'
import './app.css'
import App from './App.svelte'
import { initSettings } from './stores/settings.svelte'
import { pwa } from './stores/pwa.svelte'
import { requestPersistence } from './services/storage/persist'
import { initViewport } from './services/viewport'

// Apply saved theme/settings before first paint where possible.
await initSettings()

// Publish the real (visual) viewport height as --app-height so the full-screen shell
// tracks the screen on iOS — without this a cold PWA launch lays out against an
// under-reported viewport and a bottom bar shows a gap until rotation.
initViewport()

// Ask the browser to keep our books & dictionary durable (no-op if already granted).
void requestPersistence()

// Register the service worker; expose update availability to the UI.
const updateSW = registerSW({
  onNeedRefresh() {
    pwa.needRefresh = true
    pwa.update = () => updateSW(true)
  },
  onOfflineReady() {
    pwa.offlineReady = true
  },
})

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
