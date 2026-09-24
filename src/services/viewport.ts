/**
 * iOS standalone-PWA viewport manager.
 *
 * Two iOS behaviours make a `position:fixed; inset:0` / `100dvh` full-screen shell
 * unreliable, and this module is the single place that papers over both:
 *
 * 1. **Cold-launch under-report.** On a fresh Add-to-Home-Screen launch WebKit lays
 *    out before the standalone window metrics and `env(safe-area-inset-*)` settle, so
 *    the layout viewport (`100dvh`, the fixed containing block) is briefly too short.
 *    A bottom-anchored bar then sits with a gap below it that only clears on rotation.
 * 2. **Rotation jitter.** During/after a rotation iOS fires a *burst* of `resize` /
 *    `visualViewport` resize events while `window.innerWidth/innerHeight` lag the
 *    settled visual viewport.
 *
 * We publish the `visualViewport` height as `--app-height` on `:root` — lifted to the
 * screen height in a full-screen standalone app, since even `visualViewport` comes up
 * short on a cold iPhone launch (see `fullScreenHeight`). **Only the fixed, out-of-flow reader
 * overlay (`.reader`) consumes it** (with a `100dvh` fallback for the first frame before
 * JS runs) — applying it to in-flow elements (html/body/#app) changed the document
 * layout, which made iOS re-report a different `visualViewport` height and oscillate the
 * value (a resize→rewrite feedback loop that flickered the bottom bar). A fixed element
 * can't feed back into the layout viewport. Writes are coalesced to one per frame and
 * gated by a small px threshold, so a settled (or sub-pixel-jittering) viewport stops
 * producing work.
 */

/**
 * The current viewport size. Prefers the visual viewport (the reliable source on iOS,
 * including at cold launch), but falls back to the layout viewport while pinch-zoomed —
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
 * iPhone the first `visualViewport`/`innerHeight` of a freshly opened Home Screen app can
 * come up ~100px short — the Safari-toolbar allowance it never needed — and stays short
 * until a rotation, leaving a band of dead paper below the reader's bottom bar.
 *
 * Only applies when the window's width matches a full screen side (±2px), i.e. not in an
 * iPad Split View / Slide Over / Stage Manager window, where the window is smaller than the
 * screen. The width is the reliable axis (the bug is height-only), and it also tells us the
 * orientation: `screen.width/height` don't swap on rotation in iOS, so compare to both.
 * Correct only because index.html uses `black-translucent` + `viewport-fit=cover`, which
 * extends the web view under the status bar to the full screen; with the `default` status
 * bar style the view starts below it and this would overshoot.
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

function apply(): void {
  raf = 0
  const h = Math.round(viewportSize().h)
  // Ignore sub-pixel / tiny jitter: only a real change moves the bar. (The feedback loop
  // is already broken by keeping --app-height off in-flow elements; this is insurance.)
  if (Math.abs(h - lastH) < 2) return
  lastH = h
  document.documentElement.style.setProperty('--app-height', `${h}px`)
}

function schedule(): void {
  if (!raf) raf = requestAnimationFrame(apply)
}

/** Start publishing `--app-height`. Call once at startup (app-lifetime). */
export function initViewport(): void {
  apply()
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
