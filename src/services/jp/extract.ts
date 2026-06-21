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

/** Trailing run of word-chars in `s` (its suffix), capped at `max` characters. */
function trailingRun(s: string, max: number): string {
  let i = s.length
  let n = 0
  while (i > 0 && n < max && WORD_CHAR.test(s.charAt(i - 1))) {
    i--
    n++
  }
  return s.slice(i)
}

/** Leading run of word-chars in `s` (its prefix), capped at `max` characters. */
function leadingRun(s: string, max: number): string {
  let i = 0
  const cap = Math.min(s.length, max)
  while (i < cap && WORD_CHAR.test(s.charAt(i))) i++
  return s.slice(0, i)
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

  // Forward run, starting at (and including) the tapped char.
  let after = tapNode.data.slice(pos.offset)
  walker.currentNode = tapNode
  while (after.length < MAX_AFTER) {
    const n = walker.nextNode() as Text | null
    if (!n) break
    after += n.data
  }
  after = leadingRun(after, MAX_AFTER)

  // Backward run, the word-chars immediately before the tap.
  let before = tapNode.data.slice(0, pos.offset)
  walker.currentNode = tapNode
  while (before.length < MAX_BEFORE) {
    const n = walker.previousNode() as Text | null
    if (!n) break
    before = n.data + before
  }
  before = trailingRun(before, MAX_BEFORE)

  const text = before + after
  if (!text) return null
  return { text, tapOffset: before.length }
}

/** Quick test for whether a string starts with a character worth looking up. */
export function looksJapanese(s: string): boolean {
  return WORD_CHAR.test(s.charAt(0))
}
