import { viewportSize } from '../../services/viewport'
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
  // The iOS-corrected viewport (a cold standalone launch under-reports innerHeight).
  const { w: vw, h: vh } = viewportSize()

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

/** A rectangle in top-window coordinates (a tapped glyph, a matched word). */
export interface AnchorRect {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * Place a `w`×`h` card next to the word the reader tapped, never over it.
 *
 * - **Horizontal text:** above the word's line, else below it (`placeAnchored` on the
 *   word rect — not the tap point, so a tall line or ruby never ends up under the card).
 * - **Vertical text (縦書き):** *beside* the column — to the left if the card fits there
 *   (the direction the reader's eye travels next in vertical-rl is leftward, but the
 *   column itself and those to its right stay readable), else to the right — vertically
 *   centred on the word and clamped inside the safe area. Above/below would cover the
 *   rest of the very column being read.
 */
export function placeNearWord(
  rect: AnchorRect,
  w: number,
  h: number,
  vertical: boolean,
  opts: { gap?: number; margin?: number } = {},
): { left: number; top: number } {
  if (!vertical) return placeAnchored((rect.left + rect.right) / 2, rect.top, rect.bottom, w, h, opts)
  const gap = opts.gap ?? 12
  const base = opts.margin ?? 10
  const ins = safeInsets()
  const mTop = base + ins.top
  const mBottom = base + ins.bottom
  const mLeft = base + ins.left
  const mRight = base + ins.right
  // The iOS-corrected viewport (a cold standalone launch under-reports innerHeight).
  const { w: vw, h: vh } = viewportSize()

  let left: number
  if (rect.left - gap - w >= mLeft) left = rect.left - gap - w
  else if (rect.right + gap + w <= vw - mRight) left = rect.right + gap
  // Neither side fits (a phone in portrait): clamping to a side would lay the card over
  // the word itself, so go above/below the word instead, like horizontal text.
  else return placeAnchored((rect.left + rect.right) / 2, rect.top, rect.bottom, w, h, opts)
  left = Math.max(mLeft, Math.min(vw - w - mRight, left))

  let top = (rect.top + rect.bottom) / 2 - h / 2
  top = Math.max(mTop, Math.min(vh - h - mBottom, top))
  return { left, top }
}
