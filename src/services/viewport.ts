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
 * The compositor-reported `visualViewport` size is reliable even at cold launch, so we
 * publish its height as `--app-height` on `:root`. **Only the fixed, out-of-flow reader
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
  if (vv && vv.scale <= 1.01) return { w: vv.width, h: vv.height }
  return { w: window.innerWidth, h: window.innerHeight }
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
  // viewport is too short and a bottom bar shows a gap. If `load` already fired (this
  // module runs after a top-level `await`, so it can), re-assert straight away instead.
  const reassert = () => {
    schedule()
    setTimeout(schedule, 300)
  }
  if (document.readyState === 'complete') reassert()
  else window.addEventListener('load', reassert, { once: true })
}
