/**
 * iOS standalone-PWA viewport manager.
 *
 * **Cold-launch under-report.** A freshly opened Home Screen app on iPhone lays out as if
 * the window were shorter by the status-bar inset (852 → 793 px on a 393×852 phone):
 * `100dvh`, `innerHeight` and `visualViewport.height` all report the short value, and it
 * only corrects itself on a rotation. WebKit also paints nothing below the document's own
 * box, so sizing just the fixed reader overlay to the screen isn't enough — the overlay is
 * clipped at the short height (bottom bar cut off). So, in a full-screen standalone app we
 * publish the **screen** height (`fullScreenHeight`) as two root custom properties:
 *
 * - `--doc-height` → `html`, `body`, `#app` (app.css), making the document screen-tall.
 *   Only set when the screen height is known; otherwise they stay on `100dvh`.
 * - `--app-height` → the fixed `.reader` overlay (and loading/error screens): the larger of
 *   the visual viewport and the screen height.
 *
 * Neither value can feed back into layout (the screen size and the window *width* don't
 * change with document height), which is what made an earlier visualViewport-driven
 * in-flow height oscillate. Writes are coalesced to one per frame and gated by a 2px
 * threshold; rotation bursts just re-run `apply`.
 */

/**
 * The current viewport size. Prefers the visual viewport (lifted to the screen height
 * when `fullScreenHeight` knows it), but falls back to the layout viewport while pinch-zoomed —
 * there `visualViewport` reports the *zoomed* (shrunken) box, which must not drive the
 * reader page geometry.
 */
export function viewportSize(): { w: number; h: number } {
  const vv = globalThis.visualViewport
  const size = vv && vv.scale <= 1.01 ? { w: vv.width, h: vv.height } : { w: window.innerWidth, h: window.innerHeight }
  const full = fullScreenHeight(size.w)
  // Never *shrink* below what the viewport reports; only lift an under-report.
  if (full !== null && full > size.h) size.h = full
  return size
}

/** Running as an installed (Add to Home Screen) web app. */
function isStandalone(): boolean {
  return (
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    (globalThis.matchMedia?.('(display-mode: standalone)').matches ?? false)
  )
}

/**
 * In a full-screen standalone app the window *is* the screen, so its height is simply the
 * screen's long or short side. That's the one number iOS gets right at cold launch: on an
 * iPhone the first `visualViewport`/`innerHeight` of a freshly opened Home Screen app come
 * up short by the status-bar inset and stay short until a rotation (see the header).
 *
 * Only applies when the window's width matches a full screen side (±2px), i.e. not in an
 * iPad Split View / Slide Over / Stage Manager window, where the window is smaller than the
 * screen. The width is the reliable axis (the bug is height-only), and it also tells us the
 * orientation: `screen.width/height` don't swap on rotation in iOS, so compare to both.
 * Correct only because index.html uses `black-translucent` + `viewport-fit=cover`, which
 * extends the web view under the status bar to the full screen; with the `default` status
 * bar style the view starts below it and this would overshoot.
 */
export function fullScreenHeight(width: number): number | null {
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
  // Ignore sub-pixel / tiny jitter: only a real change moves the bar.
  if (Math.abs(h - lastH) >= 2) {
    lastH = h
    root.setProperty('--app-height', `${h}px`)
  }
  // The *document* must be screen-tall too, not just the fixed reader overlay: while iOS's
  // layout viewport is short (cold launch), WebKit paints only the document's own box, so
  // a screen-tall fixed overlay was simply clipped at the short height — the bottom bar cut
  // off, with the under-page background below it. This is safe to feed into in-flow layout
  // (unlike the old visualViewport-derived value, which oscillated) because it depends only
  // on the screen size and the window *width*, neither of which layout can change.
  const doc = fullScreenHeight(w)
  if (doc !== lastDoc) {
    lastDoc = doc
    if (doc === null) root.removeProperty('--doc-height')
    else root.setProperty('--doc-height', `${doc}px`)
  }
}

/** The document is `overflow: hidden`, but a screen-tall document inside a short layout
 *  viewport is still programmatically scrollable (focus, anchors) — keep it pinned. */
function pinScroll(): void {
  if (window.scrollX || window.scrollY) window.scrollTo(0, 0)
}

function schedule(): void {
  if (!raf) raf = requestAnimationFrame(apply)
}

/** Start publishing `--app-height`. Call once at startup (app-lifetime). */
export function initViewport(): void {
  apply()
  window.addEventListener('scroll', pinScroll, { passive: true })
  globalThis.visualViewport?.addEventListener('resize', schedule)
  window.addEventListener('resize', schedule)
  window.addEventListener('orientationchange', schedule)
  // Re-assert once the cold-launch viewport / safe-area insets settle — they can lag the
  // first paint by a few hundred ms in a standalone PWA, the window where the layout
  // viewport is too short and a bottom bar shows a gap. If `load` already fired (e.g. a
  // late caller), re-assert straight away instead.
  const reassert = () => {
    schedule()
    setTimeout(schedule, 300)
  }
  if (document.readyState === 'complete') reassert()
  else window.addEventListener('load', reassert, { once: true })
}
