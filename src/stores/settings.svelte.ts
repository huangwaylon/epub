import { DEFAULT_SETTINGS, type ReaderSettings, type ResolvedTheme } from '../services/types'
import { loadSettings, saveSettings } from '../services/storage/db'

/**
 * Global, app-wide reader preferences. Exported as a deep-reactive `$state`
 * object: components read `settings.x` directly and re-render on change.
 * Mutate only through `updateSettings` so changes persist and the theme applies.
 *
 * IndexedDB is the source of truth, but startup never waits on it: a synchronous
 * localStorage mirror (`MIRROR_KEY`, also read by the inline script in index.html to
 * set `data-theme` before first paint) seeds the store, the app mounts at once, and
 * `initSettings` then hydrates from IDB in the background.
 */
export const settings = $state<ReaderSettings>({ ...DEFAULT_SETTINGS })

/** The concrete palette in effect — `settings.theme` with 'auto' resolved against the
 *  OS colour scheme. Live: flips when the OS appearance changes while on 'auto'. */
export const appearance = $state<{ resolved: ResolvedTheme }>({ resolved: 'light' })

/** Keep in sync with the inline theme script in index.html. */
const MIRROR_KEY = 'tsuzuri:settings'

/** Paper colours per palette (mirrors app.css) — the fallback for the theme-color meta
 *  when the stylesheet isn't applied yet (dev injects CSS from JS). Keep in sync with
 *  the inline script in index.html. */
const PAPER: Record<ResolvedTheme, string> = { light: '#f6f3ec', sepia: '#f4ecd8', dark: '#16140f' }

let hydrated = false
/** Keys the user changed before IDB hydration finished — those win over the stored copy. */
const touchedEarly = new Set<keyof ReaderSettings>()

/**
 * Keep only the fields `DEFAULT_SETTINGS` knows, so a stored copy from an older build
 * can't carry retired keys back in (they'd be re-persisted forever). The retired
 * `tapToDefine` switch simply drops: lookup is always on now, and its successor
 * `highlightLookups` takes its default.
 */
function known(saved: object): Partial<ReaderSettings> {
  const src = saved as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in src) out[k] = src[k]
  return out as Partial<ReaderSettings>
}

function readMirror(): Partial<ReaderSettings> | null {
  try {
    const raw = localStorage.getItem(MIRROR_KEY)
    return raw ? known(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

function writeMirror(): void {
  try {
    localStorage.setItem(MIRROR_KEY, JSON.stringify(settings))
  } catch {
    /* storage full / disabled — the mirror is only a first-paint hint */
  }
}

const darkQuery = (): MediaQueryList | null =>
  typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null

/**
 * Seed from the localStorage mirror and apply the theme synchronously, then hydrate
 * from IndexedDB. Call once at startup; don't await it before mounting.
 */
export async function initSettings(): Promise<void> {
  const mirrored = readMirror()
  if (mirrored) Object.assign(settings, { ...DEFAULT_SETTINGS, ...mirrored })
  applyTheme()
  darkQuery()?.addEventListener('change', () => {
    if (settings.theme === 'auto') applyTheme()
  })

  try {
    const saved = await loadSettings()
    if (saved) {
      const merged: Partial<ReaderSettings> = { ...DEFAULT_SETTINGS, ...known(saved) }
      for (const k of touchedEarly) delete merged[k]
      Object.assign(settings, merged)
    }
  } catch {
    /* storage unavailable — keep the mirror/defaults */
  }
  hydrated = true
  applyTheme()
  writeMirror()
  if (touchedEarly.size) void saveSettings({ ...settings })
  touchedEarly.clear()
}

export function updateSettings(patch: Partial<ReaderSettings>): void {
  Object.assign(settings, patch)
  if ('theme' in patch) applyTheme()
  writeMirror()
  if (hydrated) void saveSettings({ ...settings })
  else for (const k of Object.keys(patch)) touchedEarly.add(k as keyof ReaderSettings)
}

/** Reflect the resolved theme onto <html data-theme> and the iOS status-bar / chrome colour. */
function applyTheme(): void {
  const resolved: ResolvedTheme =
    settings.theme === 'auto' ? (darkQuery()?.matches ? 'dark' : 'light') : settings.theme
  appearance.resolved = resolved
  const root = document.documentElement
  root.dataset.theme = resolved
  // Read back the live paper colour so the status bar / chrome match app.css exactly.
  const paper = getComputedStyle(root).getPropertyValue('--paper').trim() || PAPER[resolved]
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (!meta) {
    meta = document.createElement('meta')
    meta.name = 'theme-color'
    document.head.appendChild(meta)
  }
  meta.content = paper
}
