/**
 * Extracts a forward run of text starting at a tap point inside the rendered
 * content, for dictionary lookup. Furigana (<rt>/<rp>) is skipped so the reading
 * text doesn't pollute the lookup window.
 */

export interface Extracted {
  /** Up to MAX_CHARS of text from the tap point onward (rt/rp excluded). */
  text: string
  /** The text node and offset where the run begins (for highlighting the match). */
  startNode: Text
  startOffset: number
}

const MAX_CHARS = 16

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

export function extractTextAt(doc: Document, x: number, y: number): Extracted | null {
  const pos = caretPosition(doc, x, y)
  if (!pos) return null
  // Only treat this as a word lookup if the tap actually landed on a glyph;
  // otherwise it's blank space and the caller should turn the page / toggle chrome.
  if (!pointOnGlyph(doc, pos.node, pos.offset, x, y)) return null

  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (isInRuby(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })

  // Position the walker at (or just after) the tapped node.
  let startNode: Text
  let startOffset: number
  walker.currentNode = pos.node
  if (pos.node.nodeType === Node.TEXT_NODE && !isInRuby(pos.node)) {
    startNode = pos.node as Text
    startOffset = pos.offset
  } else {
    const next = walker.nextNode() as Text | null
    if (!next) return null
    startNode = next
    startOffset = 0
  }

  let text = startNode.data.slice(startOffset)
  let node: Text | null = startNode
  while (text.length < MAX_CHARS) {
    node = walker.nextNode() as Text | null
    if (!node) break
    text += node.data
  }
  text = text.slice(0, MAX_CHARS)

  if (!text.trim()) return null
  return { text, startNode, startOffset }
}

/** Quick test for whether a string starts with a character worth looking up. */
export function looksJapanese(s: string): boolean {
  // Hiragana, katakana, CJK ideographs, or the long-vowel/iteration marks.
  return /[぀-ヿ㐀-鿿豈-﫿ー々]/.test(s.charAt(0))
}
