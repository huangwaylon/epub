/**
 * Position a floating layer (the dictionary popup, a selection toolbar) of size
 * `w`×`h` near an anchor: prefer above it, flip below when there isn't room, and
 * clamp inside the viewport honouring the safe-area insets. All coordinates are in
 * top-window space. Shared by DictionaryPopup and SelectionToolbar so they stay in
 * sync and both respect the iPad's rounded corners / home indicator.
 */

/** Safe-area insets are effectively static per device/orientation but resolving them
 *  needs a `getComputedStyle` style-flush. `placeAnchored` runs on the latency-sensitive
 *  tap-to-define path, so cache the four `--safe-*` insets and only re-read them when the
 *  viewport actually changes (rotation / resize) rather than on every reposition. */
let insetCache: { top: number; bottom: number; left: number; right: number } | null = null
function readInsets() {
  const cs = getComputedStyle(document.documentElement)
  const inset = (name: string) => parseFloat(cs.getPropertyValue(name)) || 0
  return {
    top: inset('--safe-top'),
    bottom: inset('--safe-bottom'),
    left: inset('--safe-left'),
    right: inset('--safe-right'),
  }
}
function safeInsets() {
  if (!insetCache) {
    insetCache = readInsets()
    const invalidate = () => (insetCache = null)
    window.addEventListener('resize', invalidate)
    window.addEventListener('orientationchange', invalidate)
  }
  return insetCache
}

export function placeAnchored(
  centerX: number,
  anchorTop: number,
  anchorBottom: number,
  w: number,
  h: number,
  opts: { gap?: number; margin?: number } = {},
): { left: number; top: number } {
  const gap = opts.gap ?? 12
  const base = opts.margin ?? 10
  const ins = safeInsets()
  const mTop = base + ins.top
  const mBottom = base + ins.bottom
  const mLeft = base + ins.left
  const mRight = base + ins.right
  const vw = window.innerWidth
  const vh = window.innerHeight

  let left = centerX - w / 2
  left = Math.max(mLeft, Math.min(vw - w - mRight, left))

  // Prefer above the anchor; flip below if it would collide with the top margin.
  let top = anchorTop - h - gap
  if (top < mTop + 40) top = anchorBottom + gap
  top = Math.max(mTop, Math.min(vh - h - mBottom, top))

  return { left, top }
}
