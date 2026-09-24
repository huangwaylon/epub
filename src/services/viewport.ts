/**
 * iOS standalone-PWA viewport. On a cold Home Screen launch iPhone under-reports the
 * height by the status-bar inset (`100dvh`, `innerHeight`, `visualViewport` alike) until
 * a rotation, and WebKit paints nothing below the document's box. So in a full-screen
 * standalone app we publish the *screen* height: `--doc-height` (html/body/#app) and
 * `--app-height` (fixed overlays). Both depend only on screen size and window width, so
 * they can't feed back into layout.
 */

/** Visual viewport (lifted to the screen height when known); the layout viewport while
 *  pinch-zoomed, where `visualViewport` reports the shrunken box. */
export function viewportSize(): { w: number; h: number } {
  const vv = globalThis.visualViewport
  const size = vv && vv.scale <= 1.01 ? { w: vv.width, h: vv.height } : { w: window.innerWidth, h: window.innerHeight }
  const full = fullScreenHeight(size.w)
  if (full !== null && full > size.h) size.h = full
  return size
}

function isStandalone(): boolean {
  return (
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    (globalThis.matchMedia?.('(display-mode: standalone)').matches ?? false)
  )
}

/**
 * The screen height when standalone and the window spans a full screen side (not Split
 * View / Stage Manager). `screen` doesn't swap on iOS rotation, so orientation comes from
 * the width. Assumes index.html's `black-translucent` + `viewport-fit=cover`.
 */
function fullScreenHeight(width: number): number | null {
  if (!isStandalone() || !globalThis.screen) return null
  const short = Math.min(screen.width, screen.height)
  const long = Math.max(screen.width, screen.height)
  if (Math.abs(width - short) <= 2) return long // portrait
  if (Math.abs(width - long) <= 2) return short // landscape
  return null
}

let raf = 0
let lastH = -1
let lastDoc: number | null = -1

function apply(): void {
  raf = 0
  const { w, h: rawH } = viewportSize()
  const h = Math.round(rawH)
  const root = document.documentElement.style
  if (Math.abs(h - lastH) >= 2) {
    lastH = h
    root.setProperty('--app-height', `${h}px`)
  }
  const doc = fullScreenHeight(w)
  if (doc !== lastDoc) {
    lastDoc = doc
    if (doc === null) root.removeProperty('--doc-height')
    else root.setProperty('--doc-height', `${doc}px`)
  }
}

/** A screen-tall document in a short layout viewport is still programmatically
 *  scrollable (focus, anchors) despite `overflow: hidden` — keep it pinned. */
function pinScroll(): void {
  if (window.scrollX || window.scrollY) window.scrollTo(0, 0)
}

function schedule(): void {
  if (!raf) raf = requestAnimationFrame(apply)
}

/** Call once at startup. */
export function initViewport(): void {
  apply()
  window.addEventListener('scroll', pinScroll, { passive: true })
  globalThis.visualViewport?.addEventListener('resize', schedule)
  window.addEventListener('resize', schedule)
  window.addEventListener('orientationchange', schedule)
  // The cold-launch viewport / safe-area insets can settle a few hundred ms after first paint.
  const reassert = () => {
    schedule()
    setTimeout(schedule, 300)
  }
  if (document.readyState === 'complete') reassert()
  else window.addEventListener('load', reassert, { once: true })
}
