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
