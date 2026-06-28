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
// Insets only change on rotation / resize, so drop the cache then and re-read lazily.
// These listeners are registered exactly once for the app lifetime: the previous code
// re-added a fresh pair inside `safeInsets` every time the cache was rebuilt, so each
// rotation leaked two more listeners that accumulated unboundedly across a session.
const invalidateInsets = () => (insetCache = null)
window.addEventListener('resize', invalidateInsets)
window.addEventListener('orientationchange', invalidateInsets)
function safeInsets() {
  if (!insetCache) insetCache = readInsets()
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

  // Prefer above the anchor; flip below when there isn't room for the popup's full
  // height above it (compared against `h`, not a magic constant). The clamp below is
  // the real safe-area backstop; this just picks the side with room.
  let top = anchorTop - h - gap
  if (anchorTop - mTop - gap < h) top = anchorBottom + gap
  top = Math.max(mTop, Math.min(vh - h - mBottom, top))

  return { left, top }
}
