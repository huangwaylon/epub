/**
 * The English inserted into bundled books (docs/translation.md): a
 * `<span class="tsuzuri-en" data-tz="N">` directly after each translated unit — a leaf
 * block, or one `<br>`-separated line of it. Pure DOM helpers, no framework imports.
 */

export const EN_CLASS = 'tsuzuri-en'
/** Added to an individually revealed unit's English (styled like show-all English). */
export const EN_SHOWN_CLASS = 'tsuzuri-shown'
/** In the `<head>` of every chapter that carries English. */
export const EN_META_SELECTOR = 'meta[name="tsuzuri-translated"]'

const EN_RE = /(^|\s)tsuzuri-en(\s|$)/

/** Leaf-block tags a unit can be (mirrors `BLOCKS` in scripts/books/lib.mjs). */
const UNIT_BLOCKS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'dt', 'dd', 'blockquote', 'div',
  'td', 'th', 'caption', 'figcaption', 'section', 'article', 'header', 'footer',
])

const tag = (n: Node): string => ((n as Element).localName ?? n.nodeName ?? '').toLowerCase()

/** `n` is a translation element. */
export function isEnglish(n: Node | null | undefined): n is Element {
  return !!n && n.nodeType === 1 && EN_RE.test((n as Element).getAttribute?.('class') ?? '')
}

/** The translation element containing `node` (or `node` itself), else `null`. */
export function englishAncestor(node: Node | null | undefined): Element | null {
  for (let n = node; n; n = n.parentNode) if (isEnglish(n)) return n
  return null
}

/**
 * The English of the unit containing `node`, else `null` (untranslated, or not in a unit).
 * Climbs to the leaf block's child that holds `node`, then scans the following siblings
 * until the unit's `.tsuzuri-en` or the `<br>` that ends its line.
 */
export function unitEnglish(node: Node | null | undefined): Element | null {
  if (!node) return null
  const own = englishAncestor(node)
  if (own) return own
  let child: Node = node
  let parent = node.parentNode
  while (parent && !(parent.nodeType === 1 && UNIT_BLOCKS.has(tag(parent)))) {
    child = parent
    parent = parent.parentNode
  }
  if (!parent) return null
  for (let n = child.nextSibling; n; n = n.nextSibling) {
    if (n.nodeType !== 1) continue
    if (isEnglish(n)) return n
    if (tag(n) === 'br') return null
  }
  return null
}

/** The first / last text node under `root` in document order, outside any translation. */
function edgeText(root: Node, last: boolean): Text | null {
  if (root.nodeType === 3) return root as Text
  if (isEnglish(root)) return null
  for (let c = last ? root.lastChild : root.firstChild; c; c = last ? c.previousSibling : c.nextSibling) {
    const t = edgeText(c, last)
    if (t) return t
  }
  return null
}

/** The nearest text before (`'prev'`) / after (`'next'`) element `el`, outside translations. */
export function textBeside(el: Node, dir: 'prev' | 'next'): Text | null {
  for (let n: Node | null = el; n; n = n.parentNode) {
    for (let s = dir === 'prev' ? n.previousSibling : n.nextSibling; s; s = dir === 'prev' ? s.previousSibling : s.nextSibling) {
      const t = edgeText(s, dir === 'prev')
      if (t) return t
    }
  }
  return null
}

/**
 * `range` with ends that fell inside English moved out of it — the start to the next
 * Japanese text, the end to the previous — or `null` when nothing outside remains. The
 * range is modified in place (pass a clone to keep the original); a real Range collapses
 * if the ends cross.
 */
export function clampOutOfEnglish(range: Range): Range | null {
  const s = englishAncestor(range.startContainer)
  const e = englishAncestor(range.endContainer)
  if (s && s === e) return null
  if (s) {
    const t = textBeside(s, 'next')
    if (!t) return null
    range.setStart(t, 0)
  }
  if (e) {
    const t = textBeside(e, 'prev')
    if (!t) return null
    range.setEnd(t, t.data.length)
  }
  return range.collapsed ? null : range
}

/** `range` touches a translation. */
function touchesEnglish(range: Range): boolean {
  const root = range.commonAncestorContainer as Element
  for (const el of Array.from(root.querySelectorAll?.(`.${EN_CLASS}`) ?? [])) if (range.intersectsNode(el)) return true
  return false
}

/**
 * The text to copy / record for a selection: English excluded (and, when English had to be
 * removed, furigana too — the fragment's `textContent` would splice it in). A selection
 * wholly inside one translation copies that English.
 */
export function selectionText(range: Range, fallback: string): string {
  if (englishAncestor(range.commonAncestorContainer)) return fallback
  if (!touchesEnglish(range)) return fallback
  const frag = range.cloneContents()
  for (const el of Array.from(frag.querySelectorAll(`.${EN_CLASS}, rt, rp`))) el.remove()
  return (frag.textContent ?? '').trim()
}

/** The selection lies wholly inside one translation (nothing to highlight). */
export function selectionIsEnglish(range: Range): boolean {
  return !!englishAncestor(range.commonAncestorContainer)
}
