import { viewportSize } from '../../services/viewport'

// Floating-layer placement (top-window coords) for the dictionary popup and selection
// toolbar, clamped inside the safe area.

/** Cached `--safe-*` insets: reading them forces a style flush on the tap path. */
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
// Registered once for the app lifetime.
const invalidateInsets = () => (insetCache = null)
window.addEventListener('resize', invalidateInsets)
window.addEventListener('orientationchange', invalidateInsets)
function safeInsets() {
  if (!insetCache) insetCache = readInsets()
  return insetCache
}

/** Centre on `centerX`, prefer above the anchor, flip below when it doesn't fit, clamp. */
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
  const { w: vw, h: vh } = viewportSize()

  let left = centerX - w / 2
  left = Math.max(mLeft, Math.min(vw - w - mRight, left))

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
 * Place a card next to the tapped word, never over it: above/below the word in horizontal
 * text; beside the column in 縦書き (left, else right, else above/below), since
 * above/below would cover the column being read.
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
  const { w: vw, h: vh } = viewportSize()

  let left: number
  if (rect.left - gap - w >= mLeft) left = rect.left - gap - w
  else if (rect.right + gap + w <= vw - mRight) left = rect.right + gap
  // Neither side fits (phone portrait): a clamped side would cover the word.
  else return placeAnchored((rect.left + rect.right) / 2, rect.top, rect.bottom, w, h, opts)
  left = Math.max(mLeft, Math.min(vw - w - mRight, left))

  let top = (rect.top + rect.bottom) / 2 - h / 2
  top = Math.max(mTop, Math.min(vh - h - mBottom, top))
  return { left, top }
}
