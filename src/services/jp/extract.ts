/**
 * The text to look up at a tap point: the glyph under the point (resolved geometrically —
 * the caret APIs are only a seed) and the contiguous Japanese run around it, furigana
 * excluded.
 */

export interface Extracted {
  /** Japanese run around the tap (rt/rp excluded; bounded by non-word chars, block / <br>
   *  breaks and `MAX_BEFORE`/`MAX_AFTER`). */
  text: string
  /** Index within `text` of the tapped character. */
  tapOffset: number
  /** DOM location of each `text[i]`. The run can straddle text nodes (ruby splits a
   *  compound's base), so this map is the only safe bridge back to a Range. */
  positions: CharPosition[]
}

export interface CharPosition {
  node: Text
  offset: number
}

/** Word-chars gathered before / after the tap. */
const MAX_BEFORE = 12
const MAX_AFTER = 16

/** Characters that can be part of a Japanese word; anything else bounds the run. Kana
 *  except ・ (U+30FB, it separates words: ジョン・スミス); 々〆〇; CJK Ext-A + Unified;
 *  CJK Compatibility. Keep the escapes: U+F900 looks identical to U+8C48, and a retyped
 *  range would swallow the surrogates. Astral CJK (Ext-B+) is out of scope. */
const WORD_CHAR = /[\u3040-\u30FA\u30FC-\u30FF\u3005-\u3007\u3400-\u9FFF\uF900-\uFAFF]/

/** Elements a run never crosses: blocks and `<br>` (new line) and `<img>` (an inline gaiji
 *  is a character the run can't see). Tag names, not computed `display`, for speed. */
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'BR', 'CAPTION', 'DD', 'DETAILS',
  'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2',
  'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'HTML', 'IMG', 'LI', 'MAIN', 'NAV', 'OL', 'P',
  'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
])

const isBlock = (el: Element): boolean => BLOCK_TAGS.has(el.tagName.toUpperCase())

/** The nearest block-level ancestor of `node`. */
function blockOf(node: Node): Element | null {
  let el = node.parentElement
  while (el && !isBlock(el)) el = el.parentElement
  return el
}

/** Whether a line break separates text node `a` from the following text node `b`
 *  (different blocks, or a `<br>` / block element between them). */
function breakBetween(doc: Document, a: Text, b: Text): boolean {
  if (blockOf(a) !== blockOf(b)) return true
  const w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  try {
    w.currentNode = a
  } catch {
    return false
  }
  for (let n = w.nextNode(); n && n !== b; n = w.nextNode()) {
    if (n.nodeType === Node.ELEMENT_NODE && isBlock(n as Element)) return true
  }
  return false
}

function caretPosition(doc: Document, x: number, y: number): { node: Node; offset: number } | null {
  const anyDoc = doc as any
  // WebKit's caretRangeFromPoint first, then the standard API. Either may throw (detached
  // doc, odd coordinates); never let that escape the tap handler.
  try {
    if (anyDoc.caretRangeFromPoint) {
      const r: Range | null = anyDoc.caretRangeFromPoint(x, y)
      if (r) return { node: r.startContainer, offset: r.startOffset }
    }
  } catch {
    /* fall through to caretPositionFromPoint */
  }
  try {
    if (anyDoc.caretPositionFromPoint) {
      const p = anyDoc.caretPositionFromPoint(x, y)
      if (p) return { node: p.offsetNode, offset: p.offset }
    }
  } catch {
    /* no caret at point */
  }
  return null
}

/** Minimum hit slack (px) on every side, for text set solid (no leading to borrow). */
const MIN_HIT_SLACK = 6
/** Extra reading-axis slack (× font size). Modest, so a tap past a line end stays blank. */
const READING_SLACK_EM = 0.15

/** Per-axis tap slack around a glyph's box, in px. */
interface GlyphSlack {
  x: number
  y: number
}

/**
 * Tap slack from the line metrics at `el`. The cross (line-stacking) axis gets half the
 * leading, so each line's target reaches exactly the midpoint to its neighbour; the reading
 * axis, where glyphs are contiguous, only a little. `leading = lineHeight − fontSize`
 * assumes ~1em-square glyphs, true for `WORD_CHAR`. Don't let it balloon: blank-tap
 * fall-through (chrome / dismiss) needs some taps to miss every glyph.
 */
function glyphSlack(win: Window | null, el: Element | null): GlyphSlack {
  const cs = win && el ? win.getComputedStyle(el) : null
  const vertical = cs ? !cs.writingMode.startsWith('horizontal') : false
  const fontSize = (cs && parseFloat(cs.fontSize)) || 16
  // `line-height: normal` has no numeric px.
  let lineHeight = cs ? parseFloat(cs.lineHeight) : NaN
  if (!isFinite(lineHeight)) lineHeight = fontSize * 1.5
  const leading = Math.max(0, lineHeight - fontSize)
  const crossSlack = leading / 2 + MIN_HIT_SLACK
  const readingSlack = MIN_HIT_SLACK + fontSize * READING_SLACK_EM
  // Every non-horizontal mode stacks lines along x.
  return vertical ? { x: crossSlack, y: readingSlack } : { x: readingSlack, y: crossSlack }
}

/** The character under the tap point. */
interface GlyphHit {
  node: Text
  offset: number
  /** 0 when the point is inside the glyph's own box; otherwise how far outside (px). */
  distance: number
}

/**
 * A character's box: the largest-area client rect, since WebKit adds a degenerate rect at
 * the end of the previous line (in 縦書き, the column to the right) for a line-start range.
 * It is the font box, excluding leading — hence `glyphSlack`.
 */
function charRect(doc: Document, node: Text, offset: number): DOMRect | null {
  if (offset < 0 || offset >= node.data.length) return null
  const range = doc.createRange()
  try {
    range.setStart(node, offset)
    range.setEnd(node, offset + 1)
  } catch {
    return null
  }
  let best: DOMRect | null = null
  for (const r of range.getClientRects()) {
    if (!r.width || !r.height) continue
    if (!best || r.width * r.height > best.width * best.height) best = r
  }
  return best
}

/** `0` inside the box, the px overflow within `slack`, `null` outside the target. */
function hitDistance(r: DOMRect, x: number, y: number, slack: GlyphSlack): number | null {
  const dx = Math.max(r.left - x, x - r.right, 0)
  const dy = Math.max(r.top - y, y - r.bottom, 0)
  if (dx > slack.x || dy > slack.y) return null
  return dx + dy
}

function isInRuby(node: Node): boolean {
  let el = node.parentElement
  while (el) {
    // XHTML tag names are lowercase.
    const tag = el.tagName.toUpperCase()
    if (tag === 'RT' || tag === 'RP') return true
    el = el.parentElement
  }
  return false
}

/** Trailing run of word-chars in `cells` (its suffix), capped at `max` cells. */
function trailingRun(cells: CharPosition[], max: number): CharPosition[] {
  let i = cells.length
  let n = 0
  while (i > 0 && n < max && WORD_CHAR.test(cells[i - 1].node.data.charAt(cells[i - 1].offset))) {
    i--
    n++
  }
  return cells.slice(i)
}

/** Leading run of word-chars in `cells` (its prefix), capped at `max` cells. */
function leadingRun(cells: CharPosition[], max: number): CharPosition[] {
  let i = 0
  const cap = Math.min(cells.length, max)
  while (i < cap && WORD_CHAR.test(cells[i].node.data.charAt(cells[i].offset))) i++
  return cells.slice(0, i)
}

/** A TreeWalker over text nodes under `root`, skipping furigana. */
function textWalker(doc: Document, root: Node = doc.body): TreeWalker {
  return doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (isInRuby(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
}

/** The text node before / after `node` in document order (furigana skipped). */
function siblingText(doc: Document, node: Text, dir: 'prev' | 'next'): Text | null {
  const w = textWalker(doc)
  try {
    w.currentNode = node
  } catch {
    return null
  }
  return (dir === 'prev' ? w.previousNode() : w.nextNode()) as Text | null
}

/** A tap on furigana resolves to the nearest base character of the enclosing `<ruby>`
 *  (the reading sits right beside the base, so aimed taps often land on it). */
function rubyBaseHit(doc: Document, node: Text, x: number, y: number): GlyphHit | null {
  let el: Element | null = node.parentElement
  while (el && el.tagName.toUpperCase() !== 'RUBY') el = el.parentElement
  if (!el) return null
  const w = textWalker(doc, el)
  let best: GlyphHit | null = null
  let t: Text | null
  while ((t = w.nextNode() as Text | null)) {
    for (let k = 0; k < t.data.length; k++) {
      const r = charRect(doc, t, k)
      if (!r) continue
      const dx = Math.max(r.left - x, x - r.right, 0)
      const dy = Math.max(r.top - y, y - r.bottom, 0)
      const d = dx + dy
      if (!best || d < best.distance) best = { node: t, offset: k, distance: d }
    }
  }
  return best
}

/**
 * The glyph under (x, y). The caret APIs return the nearest caret *boundary*, which moves
 * to the next character past each glyph's mid-advance, so the caret is only a seed: measure
 * the seed character, its predecessor and (at a node boundary) the adjacent node's
 * character, and keep the box the point falls in.
 */
function resolveGlyph(doc: Document, x: number, y: number): GlyphHit | null {
  const pos = caretPosition(doc, x, y)
  if (!pos) return null
  if (pos.node.nodeType !== Node.TEXT_NODE) return null
  const seed = pos.node as Text

  if (isInRuby(seed)) return rubyBaseHit(doc, seed, x, y)

  const slack = glyphSlack(doc.defaultView, seed.parentElement)
  const candidates: { node: Text; offset: number }[] = []
  const push = (node: Text | null, offset: number) => {
    if (node && offset >= 0 && offset < node.data.length) candidates.push({ node, offset })
  }
  // The seed and its predecessor (the mid-glyph correction; also covers end-of-node).
  push(seed, pos.offset)
  push(seed, pos.offset - 1)
  if (pos.offset <= 0) {
    const prev = siblingText(doc, seed, 'prev')
    if (prev) push(prev, prev.data.length - 1)
  }
  if (pos.offset >= seed.data.length) {
    const next = siblingText(doc, seed, 'next')
    if (next) push(next, 0)
  }

  let best: GlyphHit | null = null
  for (const c of candidates) {
    const r = charRect(doc, c.node, c.offset)
    if (!r) continue
    const d = hitDistance(r, x, y, slack)
    if (d === null) continue
    if (d === 0) return { ...c, distance: 0 }
    if (!best || d < best.distance) best = { ...c, distance: d }
  }
  return best
}

/** The run to look up at (x, y), or `null` for a blank / non-word tap. */
export function extractTextAt(doc: Document, x: number, y: number): Extracted | null {
  const hit = resolveGlyph(doc, x, y)
  if (!hit) return null
  const tapNode = hit.node
  const tapOffset = hit.offset
  if (!WORD_CHAR.test(tapNode.data.charAt(tapOffset))) return null

  const walker = textWalker(doc)

  // Forward run from the tapped char. Capped while scanning, so a long paragraph node
  // doesn't allocate cells only to discard them.
  let afterCells: CharPosition[] = []
  for (let k = tapOffset; k < tapNode.data.length && afterCells.length < MAX_AFTER; k++)
    afterCells.push({ node: tapNode, offset: k })
  walker.currentNode = tapNode
  for (let last = tapNode; afterCells.length < MAX_AFTER; ) {
    const n = walker.nextNode() as Text | null
    if (!n || breakBetween(doc, last, n)) break
    for (let k = 0; k < n.data.length && afterCells.length < MAX_AFTER; k++) afterCells.push({ node: n, offset: k })
    last = n
  }
  afterCells = leadingRun(afterCells, MAX_AFTER)

  // Backward run: at most the last MAX_BEFORE chars before the tap.
  let beforeCells: CharPosition[] = []
  for (let k = Math.max(0, tapOffset - MAX_BEFORE); k < tapOffset; k++) beforeCells.push({ node: tapNode, offset: k })
  walker.currentNode = tapNode
  for (let next = tapNode; beforeCells.length < MAX_BEFORE; ) {
    const n = walker.previousNode() as Text | null
    if (!n || breakBetween(doc, n, next)) break
    next = n
    const need = MAX_BEFORE - beforeCells.length
    const pre: CharPosition[] = []
    for (let k = Math.max(0, n.data.length - need); k < n.data.length; k++) pre.push({ node: n, offset: k })
    beforeCells = pre.concat(beforeCells)
  }
  beforeCells = trailingRun(beforeCells, MAX_BEFORE)

  const positions = beforeCells.concat(afterCells)
  if (!positions.length) return null
  const text = positions.map((c) => c.node.data.charAt(c.offset)).join('')
  return { text, tapOffset: beforeCells.length, positions }
}

/** A Range over `text[start, end)` from `positions`, or `null` if empty / out of range. */
export function rangeForSpan(doc: Document, positions: CharPosition[], start: number, end: number): Range | null {
  if (start < 0 || end > positions.length || start >= end) return null
  const first = positions[start]
  const last = positions[end - 1]
  try {
    const range = doc.createRange()
    range.setStart(first.node, first.offset)
    range.setEnd(last.node, last.offset + 1)
    return range
  } catch {
    return null
  }
}
