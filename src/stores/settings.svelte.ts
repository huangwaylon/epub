import { DEFAULT_SETTINGS, type ReaderSettings, type ResolvedTheme } from '../services/types'
import { loadSettings, saveSettings } from '../services/storage/db'

/**
 * App-wide reader preferences; mutate only via `updateSettings`. IndexedDB is the source
 * of truth; a sync localStorage mirror seeds the store (and index.html's first-paint theme).
 */
export const settings = $state<ReaderSettings>({ ...DEFAULT_SETTINGS })

/** `settings.theme` with 'auto' resolved against the OS colour scheme (live). */
export const appearance = $state<{ resolved: ResolvedTheme }>({ resolved: 'light' })

/** Keep in sync with the inline theme script in index.html. */
const MIRROR_KEY = 'tsuzuri:settings'

/** theme-color fallback before the stylesheet applies (dev injects CSS from JS). Mirrors
 *  app.css; keep in sync with index.html. */
const PAPER: Record<ResolvedTheme, string> = { light: '#f6f3ec', sepia: '#f4ecd8', dark: '#16140f' }

let hydrated = false
/** Keys the user changed before IDB hydration finished — those win over the stored copy. */
const touchedEarly = new Set<keyof ReaderSettings>()

/** Keep only keys `DEFAULT_SETTINGS` knows, so retired keys aren't re-persisted forever. */
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

/** Seed from the mirror and apply the theme synchronously, then hydrate from IndexedDB.
 *  Call once at startup; don't await it before mounting. */
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
  const paper = getComputedStyle(root).getPropertyValue('--paper').trim() || PAPER[resolved]
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (!meta) {
    meta = document.createElement('meta')
    meta.name = 'theme-color'
    document.head.appendChild(meta)
  }
  meta.content = paper
}
