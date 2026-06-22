/**
 * Extracts the text needed to look up the word at a tap point. To make tapping
 * *any* character of a word resolve the whole word (not just the run from the
 * tapped character onward), we gather the contiguous Japanese run on **both**
 * sides of the tap and report the tap's offset within it; `lookup.ts` then
 * segments that run and returns the word covering the tap. Furigana (<rt>/<rp>)
 * is skipped so reading text doesn't pollute the window.
 */

export interface Extracted {
  /** Contiguous Japanese run around the tap (rt/rp excluded, clause-bounded). */
  text: string
  /** Index within `text` of the tapped character. */
  tapOffset: number
  /**
   * DOM location of each character in `text`: `positions[i]` is where `text[i]`
   * lives. Lets the caller rebuild a `Range` for any sub-span of the run — e.g.
   * to highlight the matched word `[matchStart, matchStart + matchLength)` after
   * a lookup. (The run can straddle multiple text nodes — a kanji compound with
   * ruby splits its base text — so an index→node map is the only safe bridge.)
   */
  positions: CharPosition[]
}

/** The DOM location of a single character in the extracted run. */
export interface CharPosition {
  node: Text
  offset: number
}

/** How many word-chars to gather before / after the tap (also stops at boundaries). */
const MAX_BEFORE = 12
const MAX_AFTER = 16

/** Characters that can be part of a Japanese word: kana, CJK ideographs, the
 *  long-vowel mark (ー) and the iteration mark (々). Anything else — punctuation,
 *  spaces, latin, digits — is a word boundary that bounds the lookup run. */
const WORD_CHAR = /[぀-ヿ㐀-鿿豈-﫿ー々]/

function caretPosition(doc: Document, x: number, y: number): { node: Node; offset: number } | null {
  const anyDoc = doc as any
  // WebKit implements caretRangeFromPoint; the standard caretPositionFromPoint is
  // the fallback for engines that prefer it. Try the WebKit one first.
  if (anyDoc.caretRangeFromPoint) {
    const r: Range | null = anyDoc.caretRangeFromPoint(x, y)
    if (r) return { node: r.startContainer, offset: r.startOffset }
  }
  if (anyDoc.caretPositionFromPoint) {
    const p = anyDoc.caretPositionFromPoint(x, y)
    if (p) return { node: p.offsetNode, offset: p.offset }
  }
  return null
}

/** Slack (px) around a glyph's box when deciding whether a tap actually hit text. */
const GLYPH_HIT_SLACK = 6

/**
 * Whether (x, y) lands on the glyph at/next to the caret. `caretRangeFromPoint`
 * snaps to the *nearest* text even in blank margins and inter-column gaps, so on a
 * page that is wall-to-wall Japanese it reports a hit almost everywhere. We bound
 * that by confirming the tap point is inside the glyph's own box, so taps on empty
 * space fall through to page-turn / chrome / dismiss instead of always defining.
 */
function pointOnGlyph(doc: Document, node: Node, offset: number, x: number, y: number): boolean {
  if (node.nodeType !== Node.TEXT_NODE) return false
  const data = (node as Text).data
  if (!data) return false
  // Test the character at the caret offset, clamping at the end of the node.
  let start = offset
  let end = offset + 1
  if (end > data.length) {
    start = Math.max(0, data.length - 1)
    end = data.length
  }
  if (start >= end) return false
  const range = doc.createRange()
  try {
    range.setStart(node, start)
    range.setEnd(node, end)
  } catch {
    return false
  }
  for (const r of range.getClientRects()) {
    if (
      x >= r.left - GLYPH_HIT_SLACK &&
      x <= r.right + GLYPH_HIT_SLACK &&
      y >= r.top - GLYPH_HIT_SLACK &&
      y <= r.bottom + GLYPH_HIT_SLACK
    )
      return true
  }
  return false
}

function isInRuby(node: Node): boolean {
  let el = node.parentElement
  while (el) {
    // XHTML keeps tag names lowercase, so compare case-insensitively.
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
  while (i > 0 && n < max && WORD_CHAR.test((cells[i - 1].node as Text).data.charAt(cells[i - 1].offset))) {
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

export function extractTextAt(doc: Document, x: number, y: number): Extracted | null {
  const pos = caretPosition(doc, x, y)
  if (!pos) return null
  // Only treat this as a word lookup if the tap actually landed on a glyph;
  // otherwise it's blank space and the caller should turn the page / toggle chrome.
  if (!pointOnGlyph(doc, pos.node, pos.offset, x, y)) return null
  if (pos.node.nodeType !== Node.TEXT_NODE) return null
  const tapNode = pos.node as Text
  if (pos.offset >= tapNode.data.length) return null
  // The tapped glyph is the character at pos.offset. Bail if it isn't a word char
  // (latin, punctuation, …) so the tap falls through to the chrome toggle.
  if (!WORD_CHAR.test(tapNode.data.charAt(pos.offset))) return null

  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (isInRuby(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })

  // Forward run, starting at (and including) the tapped char. Track each char's
  // DOM location so the caller can map a matched span back to a Range.
  let afterCells: CharPosition[] = []
  for (let k = pos.offset; k < tapNode.data.length; k++) afterCells.push({ node: tapNode, offset: k })
  walker.currentNode = tapNode
  while (afterCells.length < MAX_AFTER) {
    const n = walker.nextNode() as Text | null
    if (!n) break
    for (let k = 0; k < n.data.length; k++) afterCells.push({ node: n, offset: k })
  }
  afterCells = leadingRun(afterCells, MAX_AFTER)

  // Backward run, the word-chars immediately before the tap.
  let beforeCells: CharPosition[] = []
  for (let k = 0; k < pos.offset; k++) beforeCells.push({ node: tapNode, offset: k })
  walker.currentNode = tapNode
  while (beforeCells.length < MAX_BEFORE) {
    const n = walker.previousNode() as Text | null
    if (!n) break
    const pre: CharPosition[] = []
    for (let k = 0; k < n.data.length; k++) pre.push({ node: n, offset: k })
    beforeCells = pre.concat(beforeCells)
  }
  beforeCells = trailingRun(beforeCells, MAX_BEFORE)

  const positions = beforeCells.concat(afterCells)
  if (!positions.length) return null
  const text = positions.map((c) => c.node.data.charAt(c.offset)).join('')
  return { text, tapOffset: beforeCells.length, positions }
}

/**
 * Builds a DOM `Range` spanning `text[start, end)` from a `positions` map (see
 * `extractTextAt`). Used to highlight the exact word a tap looked up. Returns
 * null if the span is empty or out of range.
 */
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

/** Quick test for whether a string starts with a character worth looking up. */
export function looksJapanese(s: string): boolean {
  return WORD_CHAR.test(s.charAt(0))
}
