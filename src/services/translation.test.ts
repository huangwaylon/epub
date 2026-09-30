import { describe, it, expect, beforeAll } from 'vitest'
import { DOMParser } from '@xmldom/xmldom'
// @ts-ignore — vendored JS module, no type declarations
import * as CFI from '../vendor/foliate-js/epubcfi.js'
import {
  unitEnglish,
  englishAncestor,
  clampOutOfEnglish,
  selectionText,
  textFrom,
  packageHasEnglish,
  rectsOutsideEnglish,
} from './translation'

// xmldom supplies the tree (childNodes, siblings, attributes); the node env lacks the
// NodeFilter constants epubcfi.js reads, and xmldom has no Range, so both are faked.
beforeAll(() => {
  ;(globalThis as any).NodeFilter ??= { FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 }
})

const XHTML = 'http://www.w3.org/1999/xhtml'
const wrap = (body: string) => `<html xmlns="${XHTML}"><head><title>t</title></head><body>${body}</body></html>`
const parse = (body: string): Document => new DOMParser().parseFromString(wrap(body), 'application/xhtml+xml') as any

const EN = (n: number, text: string) => `<span class="tsuzuri-en" lang="en" data-tz="${n}">${text}</span>`
const JA =
  '<p id="a">今日は<ruby>雨<rt>あめ</rt></ruby>だ。<br/>明日も晴れ。</p>' + '<p>三つ目の段落。</p>'
const JA_EN =
  `<p id="a">今日は<ruby>雨<rt>あめ</rt></ruby>だ。${EN(0, 'Rain today.')}<br/>明日も晴れ。${EN(1, 'Sunny tomorrow too.')}</p>` +
  `<p>三つ目の段落。</p>`

/** A text node whose data starts with `prefix` (document order). */
function textStarting(doc: Document, prefix: string): Text {
  const walk = (n: Node): Text | null => {
    if (n.nodeType === 3 && (n as Text).data.startsWith(prefix)) return n as Text
    for (let c = n.firstChild; c; c = c.nextSibling) {
      const t = walk(c)
      if (t) return t
    }
    return null
  }
  const t = walk(doc.documentElement)
  if (!t) throw new Error(`no text starting ${prefix}`)
  return t
}

/** The Range surface epubcfi.js and clampOutOfEnglish touch. */
function fakeRange(sc: Node, so: number, ec: Node = sc, eo: number = so): any {
  const r: any = {
    startContainer: sc,
    startOffset: so,
    endContainer: ec,
    endOffset: eo,
    get collapsed() {
      return r.startContainer === r.endContainer && r.startOffset === r.endOffset
    },
    setStart(n: Node, o: number) {
      r.startContainer = n
      r.startOffset = o
    },
    setEnd(n: Node, o: number) {
      r.endContainer = n
      r.endOffset = o
    },
    setStartBefore() {},
    setStartAfter() {},
    setEndBefore() {},
    setEndAfter() {},
  }
  return r
}

function withRanges(doc: Document): Document {
  ;(doc as any).createRange = () => fakeRange(doc.documentElement, 0)
  return doc
}

describe('unitEnglish', () => {
  const doc = parse(JA_EN)
  it('finds the English after the tapped line', () => {
    expect(unitEnglish(textStarting(doc, '今日は'))?.getAttribute('data-tz')).toBe('0')
    expect(unitEnglish(textStarting(doc, '明日'))?.getAttribute('data-tz')).toBe('1')
  })
  it('climbs out of inline elements (ruby base and reading)', () => {
    expect(unitEnglish(textStarting(doc, '雨'))?.getAttribute('data-tz')).toBe('0')
    expect(unitEnglish(textStarting(doc, 'あめ'))?.getAttribute('data-tz')).toBe('0')
  })
  it('returns the English itself for a node inside it', () => {
    expect(unitEnglish(textStarting(doc, 'Sunny'))?.getAttribute('data-tz')).toBe('1')
  })
  it('stops at the <br> ending an untranslated line', () => {
    const d = parse(`<p>一行目。<br/>二行目。${EN(1, 'Line two.')}</p>`)
    expect(unitEnglish(textStarting(d, '一行目'))).toBeNull()
    expect(unitEnglish(textStarting(d, '二行目'))?.getAttribute('data-tz')).toBe('1')
  })
  it('returns null for an untranslated block', () => {
    expect(unitEnglish(textStarting(doc, '三つ目'))).toBeNull()
  })
  it('englishAncestor only matches inside a translation', () => {
    expect(englishAncestor(textStarting(doc, 'Rain'))).not.toBeNull()
    expect(englishAncestor(textStarting(doc, '今日は'))).toBeNull()
  })
})

describe('clampOutOfEnglish', () => {
  const doc = parse(JA_EN)
  it('moves an end inside English back to the end of the Japanese', () => {
    const ja = textStarting(doc, '今日は')
    const en = textStarting(doc, 'Rain')
    const r = clampOutOfEnglish(fakeRange(ja, 0, en, 4))!
    const da = textStarting(doc, 'だ。')
    expect(r.endContainer).toBe(da)
    expect(r.endOffset).toBe(2)
  })
  it('moves a start inside English forward to the next Japanese', () => {
    const en = textStarting(doc, 'Rain')
    const next = textStarting(doc, '明日')
    const r = clampOutOfEnglish(fakeRange(en, 2, next, 2))!
    expect(r.startContainer).toBe(next)
    expect(r.startOffset).toBe(0)
  })
  it('returns null for a range wholly inside English', () => {
    const en = textStarting(doc, 'Rain')
    expect(clampOutOfEnglish(fakeRange(en, 0, en, 4))).toBeNull()
  })
})

describe('CFIs ignore .tsuzuri-en (TSUZURI PATCH 5)', () => {
  const plain = withRanges(parse(JA))
  const translated = withRanges(parse(JA_EN))

  it('a position after inserted English has the untranslated CFI', () => {
    const a = CFI.fromRange(fakeRange(textStarting(plain, '明日'), 2))
    const b = CFI.fromRange(fakeRange(textStarting(translated, '明日'), 2))
    expect(b).toBe(a)
  })

  it('a range across a translated line has the untranslated CFI', () => {
    const range = (d: Document) => fakeRange(textStarting(d, '今日は'), 1, textStarting(d, '三つ目'), 2)
    expect(CFI.fromRange(range(translated))).toBe(CFI.fromRange(range(plain)))
  })

  it('an untranslated CFI resolves to the same text in the translated document', () => {
    const cfi = CFI.fromRange(fakeRange(textStarting(plain, '明日'), 2, textStarting(plain, '明日'), 4))
    const r = CFI.toRange(translated, CFI.parse(cfi))
    expect(r.startContainer).toBe(textStarting(translated, '明日'))
    expect(r.startOffset).toBe(2)
    expect(r.endOffset).toBe(4)
  })

  it('a start (or point) inside English moves forward to the text after it', () => {
    const inEn = CFI.fromRange(fakeRange(textStarting(translated, 'Rain'), 3))
    expect(inEn).toBe(CFI.fromRange(fakeRange(textStarting(plain, '明日'), 0)))
    const range = CFI.fromRange(fakeRange(textStarting(translated, 'Rain'), 3, textStarting(translated, '三つ目'), 2))
    expect(range).toBe(CFI.fromRange(fakeRange(textStarting(plain, '明日'), 0, textStarting(plain, '三つ目'), 2)))
  })

  it('a start in English ending its block moves into the next block', () => {
    const inEn = CFI.fromRange(fakeRange(textStarting(translated, 'Sunny'), 0))
    expect(inEn).toBe(CFI.fromRange(fakeRange(textStarting(plain, '三つ目'), 0)))
  })

  it('an end inside English moves back to the end of the text before it', () => {
    const range = CFI.fromRange(fakeRange(textStarting(translated, '今日は'), 1, textStarting(translated, 'Rain'), 3))
    expect(range).toBe(CFI.fromRange(fakeRange(textStarting(plain, '今日は'), 1, textStarting(plain, 'だ。'), 2)))
  })

  it('a start with no text after it falls back to the text before', () => {
    const d = withRanges(parse(`<p>最後。${EN(0, 'The end.')}</p>`))
    const p = withRanges(parse('<p>最後。</p>'))
    expect(CFI.fromRange(fakeRange(textStarting(d, 'The'), 2))).toBe(CFI.fromRange(fakeRange(textStarting(p, '最後'), 3)))
  })

  it('a range wholly inside one English is one point, not an inverted range', () => {
    const en = textStarting(translated, 'Rain')
    const cfi = CFI.fromRange(fakeRange(en, 0, en, 4))
    const at = CFI.fromRange(fakeRange(textStarting(plain, '明日'), 0))
    const p = CFI.parse(cfi)
    expect(CFI.compare(CFI.collapse(p), at)).toBe(0)
    expect(CFI.compare(CFI.collapse(p, true), at)).toBe(0)
  })

  it('leaves documents from older builds (.tsuzuri-ja) unfiltered', () => {
    const body =
      `<p><span class="tsuzuri-ja">今日は雨だ。</span>${EN(0, 'Rain today.')}<span class="tsuzuri-ja">明日も晴れ。</span></p>`
    const d = withRanges(parse(body))
    const r = () => fakeRange(textStarting(d, '明日'), 2)
    const unfiltered = CFI.fromRange(r(), () => 1 as const) // accept everything
    expect(CFI.fromRange(r())).toBe(unfiltered)
    const back = CFI.toRange(d, CFI.parse(unfiltered))
    expect(back.startContainer).toBe(textStarting(d, '明日'))
    expect(back.startOffset).toBe(2)
  })

  it('without the filter the English would shift the CFI (the patch matters)', () => {
    const none = () => 1 as const // FILTER_ACCEPT everything
    const a = CFI.fromRange(fakeRange(textStarting(plain, '明日'), 2), none)
    const b = CFI.fromRange(fakeRange(textStarting(translated, '明日'), 2), none)
    expect(b).not.toBe(a)
  })
})

describe('selectionText', () => {
  /** A selection whose contents are all of `root`'s children. */
  const over = (root: Node, common: Node = root) =>
    ({ commonAncestorContainer: common, cloneContents: () => root.cloneNode(true) }) as any
  const body = (d: Document) => d.getElementsByTagName('body')[0]
  const PLAIN_TEXT = '今日は雨だ。\n明日も晴れ。\n三つ目の段落。'

  it('drops furigana and keeps line and block breaks', () => {
    expect(selectionText(over(body(parse(JA))))).toBe(PLAIN_TEXT)
  })

  it('gives the same text with English inserted (shown or hidden)', () => {
    expect(selectionText(over(body(parse(JA_EN))))).toBe(PLAIN_TEXT)
  })

  it('collapses source whitespace between blocks but keeps U+3000 indents', () => {
    const d = parse('<p>　一行目。</p>\n  <p>\n二行目。</p>')
    expect(selectionText(over(body(d)))).toBe('　一行目。\n二行目。')
  })

  it('keeps blank lines made of consecutive <br>s', () => {
    expect(selectionText(over(body(parse('<p>場面一。<br/><br/>場面二。</p>'))))).toBe('場面一。\n\n場面二。')
  })

  it('copies English when the selection lies inside one translation', () => {
    const en = textStarting(parse(JA_EN), 'Rain')
    expect(selectionText(over(en.parentNode!, en))).toBe('Rain today.')
  })
})

describe('textFrom', () => {
  const doc = parse(JA_EN)
  it('returns the boundary itself in Japanese text', () => {
    const t = textStarting(doc, '明日')
    expect(textFrom(t, 2)).toEqual({ node: t, offset: 2 })
  })
  it('moves out of English to the next Japanese', () => {
    expect(textFrom(textStarting(doc, 'Rain'), 3)).toEqual({ node: textStarting(doc, '明日'), offset: 0 })
    expect(textFrom(textStarting(doc, 'Sunny'), 0)?.node).toBe(textStarting(doc, '三つ目'))
  })
  it('skips furigana and resolves element boundaries', () => {
    expect(textFrom(textStarting(doc, 'あめ'), 0)?.node).toBe(textStarting(doc, 'だ。'))
    const p = doc.getElementsByTagName('p')[1]
    expect(textFrom(p.parentNode!, 1)?.node).toBe(textStarting(doc, '三つ目')) // body, before the 2nd <p>
  })
})

describe('packageHasEnglish', () => {
  const opf = (meta: string) =>
    new DOMParser().parseFromString(
      `<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata>${meta}</metadata></package>`,
      'application/xml',
    ) as any
  it('reads the EPUB 3 and EPUB 2 forms', () => {
    expect(packageHasEnglish(opf('<meta property="tsuzuri:translation">en</meta>'))).toBe(true)
    expect(packageHasEnglish(opf('<meta name="tsuzuri:translation" content="en"/>'))).toBe(true)
  })
  it('is false without the meta or a package', () => {
    expect(packageHasEnglish(opf('<meta property="dcterms:modified">2026</meta>'))).toBe(false)
    expect(packageHasEnglish(undefined)).toBe(false)
  })
})

describe('rectsOutsideEnglish', () => {
  const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom })
  it('drops the rects inside a displayed translation the range crosses', () => {
    const doc = parse(JA_EN)
    const p = doc.getElementsByTagName('p')[0] as any
    const [en0, en1] = Array.from(doc.getElementsByClassName('tsuzuri-en')) as any[]
    en0.getClientRects = () => [box(0, 20, 300, 40)]
    en1.getClientRects = () => [] // hidden
    const range = { commonAncestorContainer: p, intersectsNode: () => true } as any
    const ja = box(0, 0, 100, 16)
    const inEn = box(0, 22, 280, 38)
    expect(rectsOutsideEnglish(range, [ja, inEn, en0.getClientRects()[0]])).toEqual([ja])
  })
  it('returns the rects as is for a range within one text node', () => {
    const rects = [box(0, 0, 10, 10)]
    const range = { commonAncestorContainer: textStarting(parse(JA_EN), '今日は') } as any
    expect(rectsOutsideEnglish(range, rects)).toBe(rects)
  })
})
