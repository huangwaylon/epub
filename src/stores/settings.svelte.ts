import { DEFAULT_SETTINGS, type ReaderSettings } from '../services/types'
import { loadSettings, saveSettings } from '../services/storage/db'

/**
 * Global, app-wide reader preferences. Exported as a deep-reactive `$state`
 * object: components read `settings.x` directly and re-render on change.
 * Mutate only through `updateSettings` so changes persist and the theme applies.
 */
export const settings = $state<ReaderSettings>({ ...DEFAULT_SETTINGS })

let hydrated = false

export async function initSettings(): Promise<void> {
  try {
    const saved = await loadSettings()
    if (saved) Object.assign(settings, { ...DEFAULT_SETTINGS, ...saved })
  } catch {
    /* first run / storage unavailable — keep defaults */
  }
  hydrated = true
  applyTheme()
}

export function updateSettings(patch: Partial<ReaderSettings>): void {
  Object.assign(settings, patch)
  if (patch.theme) applyTheme()
  if (hydrated) void saveSettings({ ...settings })
}

/** Reflect the active theme onto <html> and the iOS status-bar / chrome colour. */
export function applyTheme(): void {
  const root = document.documentElement
  root.dataset.theme = settings.theme
  // Read back the resolved paper colour so the address bar / status bar match.
  const paper = getComputedStyle(root).getPropertyValue('--paper').trim()
  if (paper) {
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])')
    if (!meta) {
      meta = document.createElement('meta')
      meta.name = 'theme-color'
      document.head.appendChild(meta)
    }
    meta.content = paper
  }
}
