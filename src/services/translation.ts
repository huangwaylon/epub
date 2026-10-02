/**
 * The English inserted into bundled books (docs/translation.md): a
 * `<span class="tsuzuri-en" data-tz="N">` directly after each translated unit — a leaf
 * block, or one `<br>`-separated line of it. Pure DOM helpers, no framework imports.
 */

export const EN_CLASS = 'tsuzuri-en'
/** CSS Custom Highlight name tinting the unit whose English the card shows. */
export const UNIT_HIGHLIGHT = 'tz-unit'
/** In the `<head>` of every chapter that carries English. */
export const EN_META_SELECTOR = 'meta[name="tsuzuri-translated"]'
/** In the package (OPF) metadata of a book with any English: `<meta property=…>en</meta>`
 *  (EPUB 3) or `<meta name=… content="en"/>` (EPUB 2). */
export const EN_PACKAGE_META = 'tsuzuri:translation'

/** The package document declares English (`EN_PACKAGE_META`). */
export function packageHasEnglish(opf: Document | null | undefined): boolean {
  for (const m of Array.from(opf?.getElementsByTagNameNS?.('*', 'meta') ?? [])) {
    if (m.getAttribute('property') === EN_PACKAGE_META && m.textContent?.trim() === 'en') return true
    if (m.getAttribute('name') === EN_PACKAGE_META && m.getAttribute('content') === 'en') return true
  }
  return false
}

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

/** The first node of the unit whose English is `en`: its earliest previous sibling back to
 *  the previous English or `<br>` (else `en` itself, an empty unit). A range from before it
 *  to before `en` spans the unit's Japanese. */
export function unitStart(en: Element): Node {
  let first: Node = en
  for (let n = en.previousSibling; n; n = n.previousSibling) {
    if (n.nodeType === 1 && (isEnglish(n) || tag(n) === 'br')) break
    first = n
  }
  return first
}

/** One character in a content document. */
export interface TextPoint {
  node: Text
  offset: number
}

const isFurigana = (n: Node): boolean => n.nodeType === 1 && (tag(n) === 'rt' || tag(n) === 'rp')

/** The first / last non-blank text node under `root` in document order, outside
 *  translations and furigana. */
function edgeText(root: Node, last: boolean): Text | null {
  if (root.nodeType === 3) return /\S/.test((root as Text).data) ? (root as Text) : null
  if (isEnglish(root) || isFurigana(root)) return null
  for (let c = last ? root.lastChild : root.firstChild; c; c = last ? c.previousSibling : c.nextSibling) {
    const t = edgeText(c, last)
    if (t) return t
  }
  return null
}

/** The nearest non-blank text before (`'prev'`) / after (`'next'`) node `el` within
 *  `<body>`, outside translations and furigana. */
export function textBeside(el: Node, dir: 'prev' | 'next'): Text | null {
  for (let n: Node | null = el; n && tag(n) !== 'body'; n = n.parentNode) {
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

/** Elements that end a line when copied (unit blocks plus the containers around them). */
const LINE_BLOCKS = new Set([
  ...UNIT_BLOCKS, 'ul', 'ol', 'dl', 'table', 'tr', 'figure', 'pre', 'hr', 'aside', 'nav', 'main', 'body',
])

/**
 * The text to copy / record for a selection: furigana (`rt`/`rp`) and English — shown or
 * hidden — dropped, a line break at each `<br>` and block boundary, ASCII whitespace
 * collapsed (dropped between CJK characters; U+3000 indents kept). A selection wholly
 * inside one translation copies that English.
 */
export function selectionText(range: Range): string {
  const keepEnglish = !!englishAncestor(range.commonAncestorContainer)
  const out: string[] = []
  let lineStart = true // nothing yet, or a line break last
  let space = false // a collapsed space is pending
  const lineBreak = (always: boolean) => {
    space = false
    if (always || !lineStart) out.push('\n')
    lineStart = true
  }
  const walk = (root: Node) => {
    for (let c = root.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3 || c.nodeType === 4) {
        const t = (c as Text).data.replace(/[ \t\n\r\f]+/g, ' ')
        const core = t.replace(/^ | $/g, '')
        if (!core) {
          space ||= t === ' '
          continue
        }
        if ((space || t.startsWith(' ')) && !lineStart) out.push(' ')
        out.push(core)
        lineStart = false
        space = t.endsWith(' ')
      } else if (c.nodeType === 1) {
        const name = tag(c)
        if (name === 'rt' || name === 'rp' || (!keepEnglish && isEnglish(c))) continue
        if (name === 'br') {
          lineBreak(true)
          continue
        }
        const block = LINE_BLOCKS.has(name)
        if (block) lineBreak(false)
        walk(c)
        if (block) lineBreak(false)
      }
    }
  }
  walk(range.cloneContents())
  // Japanese has no word spaces: a hard-wrapped source newline between two CJK characters
  // collapses to nothing, not ' '.
  return out.join('').replace(CJK_GAP, '').replace(/^\n+|\n+$/g, '')
}

const CJK = '[\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}\\u3000-\\u303f\\uff00-\\uffef]'
const CJK_GAP = new RegExp(`(?<=${CJK}) (?=${CJK})`, 'gu')

/** The selection lies wholly inside one translation (nothing to highlight). */
export function selectionIsEnglish(range: Range): boolean {
  return !!englishAncestor(range.commonAncestorContainer)
}

type Box = { left: number; top: number; right: number; bottom: number }

/**
 * `rects` (a highlight range's client rects) minus those inside a displayed translation
 * the range crosses, so a highlight spanning units doesn't paint over visible English.
 * Hidden English has no boxes. A range within one text node returns `rects` as is.
 */
export function rectsOutsideEnglish<R extends Box>(range: Range, rects: ArrayLike<R>): ArrayLike<R> {
  const root = range.commonAncestorContainer as Element
  if (root.nodeType !== 1 || englishAncestor(root)) return rects
  const boxes: Box[] = []
  for (const el of Array.from(root.getElementsByClassName(EN_CLASS)))
    if (range.intersectsNode(el)) for (const b of Array.from(el.getClientRects())) boxes.push(b)
  if (!boxes.length) return rects
  const inside = (r: Box, b: Box) =>
    r.left >= b.left - 1 && r.right <= b.right + 1 && r.top >= b.top - 1 && r.bottom <= b.bottom + 1
  return Array.from(rects).filter((r) => !boxes.some((b) => inside(r, b)))
}
