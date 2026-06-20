/**
 * Position a floating layer (the dictionary popup, a selection toolbar) of size
 * `w`×`h` near an anchor: prefer above it, flip below when there isn't room, and
 * clamp inside the viewport honouring the safe-area insets. All coordinates are in
 * top-window space. Shared by DictionaryPopup and SelectionToolbar so they stay in
 * sync and both respect the iPad's rounded corners / home indicator.
 */
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
  const cs = getComputedStyle(document.documentElement)
  const inset = (name: string) => parseFloat(cs.getPropertyValue(name)) || 0
  const mTop = base + inset('--safe-top')
  const mBottom = base + inset('--safe-bottom')
  const mLeft = base + inset('--safe-left')
  const mRight = base + inset('--safe-right')
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
