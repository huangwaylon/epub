import { describe, it, expect, beforeAll } from 'vitest'
import { extractTextAt, rangeForSpan, looksJapanese, type CharPosition } from './extract'

/*
 * extract.ts is the only part of the JP pipeline that touches the DOM, so we run it
 * against a hand-built fake Document (vitest is configured for the `node` env; jsdom
 * is not installed). We mock ONLY the surface the code actually reads:
 *
 *   Globals:   Node.TEXT_NODE / ELEMENT_NODE, NodeFilter.{SHOW_TEXT,FILTER_*}
 *   Document:  body, caretRangeFromPoint, createRange, createTreeWalker, defaultView
 *   Range:     setStart/setEnd, getClientRects  (rects are injected per-character)
 *   Window:    getComputedStyle -> { writingMode, fontSize, lineHeight }
 *   Text:      nodeType, data, parentElement
 *   Element:   tagName, parentElement
 *
 * The fake tree is a flat in-order list of Text nodes; the TreeWalker walks that list
 * applying the ruby (rt/rp) reject filter, which is all extractTextAt needs.
 */

// --- DOM constants the source references as globals (absent in node env) ---------
beforeAll(() => {
  ;(globalThis as any).Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 }
  ;(globalThis as any).NodeFilter = {
    SHOW_TEXT: 0x4,
    FILTER_ACCEPT: 1,
    FILTER_REJECT: 2,
    FILTER_SKIP: 3,
  }
})

// --- Minimal fake DOM ------------------------------------------------------------

interface FakeElement {
  tagName: string
  parentElement: FakeElement | null
}

interface FakeText {
  nodeType: number
  data: string
  /** Per-character client rects, keyed by offset. Drives pointOnGlyph hit-testing. */
  rects: Record<number, { left: number; right: number; top: number; bottom: number }>
  parentElement: FakeElement
}

function el(tagName: string, parent: FakeElement | null = null): FakeElement {
  return { tagName, parentElement: parent }
}

/** Build a Text node whose every offset gets a 16x16 box laid out left-to-right. */
function textNode(data: string, parent: FakeElement, originX = 0, glyph = 16): FakeText {
  const rects: FakeText['rects'] = {}
  for (let i = 0; i < data.length; i++) {
    const left = originX + i * glyph
    rects[i] = { left, right: left + glyph, top: 0, bottom: glyph }
  }
  return { nodeType: 3, data, rects, parentElement: parent }
}

interface FakeStyle {
  writingMode: string
  fontSize: string
  lineHeight: string
}

/**
 * Assemble a fake Document over an ordered list of Text nodes.
 * @param caretFor  maps (x,y) -> the node+offset caretRangeFromPoint should snap to.
 * @param style     computed style returned for every element.
 */
function makeDoc(
  nodes: FakeText[],
  caretFor: (x: number, y: number) => { node: FakeText; offset: number } | null,
  style: FakeStyle = { writingMode: 'horizontal-tb', fontSize: '16px', lineHeight: '16px' },
): any {
  const body = el('BODY')

  const createRange = () => {
    let startNode: FakeText | null = null
    let startOff = 0
    let endOff = 0
    return {
      setStart(n: FakeText, o: number) {
        startNode = n
        startOff = o
      },
      setEnd(_n: FakeText, o: number) {
        endOff = o
      },
      getClientRects() {
        if (!startNode) return []
        const out = []
        for (let i = startOff; i < endOff; i++) if (startNode.rects[i]) out.push(startNode.rects[i])
        return out
      },
    }
  }

  // TreeWalker over the flat `nodes` list, honouring the SHOW_TEXT + reject filter.
  const createTreeWalker = (_root: any, _what: number, filter: any) => {
    const accept = (n: FakeText) => (filter ? filter.acceptNode(n) : NodeFilter.FILTER_ACCEPT)
    const walker: any = {
      currentNode: null as FakeText | null,
      nextNode() {
        let i = walker.currentNode ? nodes.indexOf(walker.currentNode) : -1
        for (i = i + 1; i < nodes.length; i++) {
          if (accept(nodes[i]) === NodeFilter.FILTER_ACCEPT) {
            walker.currentNode = nodes[i]
            return nodes[i]
          }
        }
        return null
      },
      previousNode() {
        let i = walker.currentNode ? nodes.indexOf(walker.currentNode) : nodes.length
        for (i = i - 1; i >= 0; i--) {
          if (accept(nodes[i]) === NodeFilter.FILTER_ACCEPT) {
            walker.currentNode = nodes[i]
            return nodes[i]
          }
        }
        return null
      },
    }
    return walker
  }

  return {
    body,
    caretRangeFromPoint(x: number, y: number) {
      const hit = caretFor(x, y)
      if (!hit) return null
      return { startContainer: hit.node, startOffset: hit.offset }
    },
    createRange,
    createTreeWalker,
    defaultView: {
      getComputedStyle: (_el: FakeElement) => style,
    },
  }
}

/** Tap the centre of the glyph at `node`'s offset `o` (its rect midpoint). */
function center(node: FakeText, o: number): [number, number] {
  const r = node.rects[o]
  return [(r.left + r.right) / 2, (r.top + r.bottom) / 2]
}

// =================================================================================
describe('looksJapanese', () => {
  it('is true for kana', () => expect(looksJapanese('あ')).toBe(true))
  it('is true for katakana', () => expect(looksJapanese('カ')).toBe(true))
  it('is true for kanji', () => expect(looksJapanese('猫')).toBe(true))
  it('is false for latin', () => expect(looksJapanese('hello')).toBe(false))
  it('is false for an empty string', () => expect(looksJapanese('')).toBe(false))
  it('only inspects the first character', () => {
    expect(looksJapanese('aあ')).toBe(false)
    expect(looksJapanese('あa')).toBe(true)
  })
})

describe('extractTextAt', () => {
  it('gathers the contiguous run across multiple text nodes and reports tapOffset', () => {
    // Two nodes that together read 猫がすき; tap the が (node b, offset 0).
    const p = el('P')
    const a = textNode('猫', p, 0)
    const b = textNode('がすき', p, 16)
    const nodes = [a, b]
    const [x, y] = center(b, 0)
    const doc = makeDoc(nodes, (px, py) => (px === x && py === y ? { node: b, offset: 0 } : null))

    const res = extractTextAt(doc, x, y)
    expect(res).not.toBeNull()
    // Backward run picks up 猫 from the preceding node; forward run is がすき.
    expect(res!.text).toBe('猫がすき')
    expect(res!.tapOffset).toBe(1) // one char (猫) before the tap
    expect(res!.positions.length).toBe(4)
    // positions[0] lives in node a, the rest in node b.
    expect(res!.positions[0].node).toBe(a)
    expect(res!.positions[1].node).toBe(b)
  })

  it('skips furigana (rt/rp) nodes when building the run', () => {
    // 漢<rt>かん</rt>字 — the reading "かん" sits in an <rt> and must be excluded.
    const p = el('P')
    const ruby = el('RUBY', p)
    const rt = el('RT', ruby)
    const base1 = textNode('漢', ruby, 0)
    const reading = textNode('かん', rt, 16) // inside <rt>, rejected
    const base2 = textNode('字', ruby, 48)
    const nodes = [base1, reading, base2]
    const [x, y] = center(base1, 0)
    const doc = makeDoc(nodes, () => ({ node: base1, offset: 0 }))

    const res = extractTextAt(doc, x, y)
    expect(res).not.toBeNull()
    expect(res!.text).toBe('漢字') // reading skipped
    expect(res!.positions.some((c) => (c.node as any) === reading)).toBe(false)
  })

  it('returns null when the tap point is on blank space (no glyph hit)', () => {
    const p = el('P')
    const a = textNode('猫', p, 0) // glyph box [0,16]
    const doc = makeDoc([a], () => ({ node: a, offset: 0 }))
    // Tap far to the right of the glyph, past horizontal reading slack
    // (MIN_HIT_SLACK 6 + 16*0.15 = 8.4). x=100 is well beyond right+slack.
    const res = extractTextAt(doc, 100, 8)
    expect(res).toBeNull()
  })

  it('returns null when the caret offset is at/past the end of the node', () => {
    // caret snaps to offset == data.length: pos.offset >= length guard fires.
    const p = el('P')
    const a = textNode('猫', p, 0)
    const doc = makeDoc([a], () => ({ node: a, offset: 1 }))
    // Hit-test still needs to pass first: pointOnGlyph clamps end>length back to the
    // last glyph, so tap that glyph's centre.
    const [x, y] = center(a, 0)
    const res = extractTextAt(doc, x, y)
    expect(res).toBeNull()
  })

  it('returns null when caretRangeFromPoint finds nothing', () => {
    const p = el('P')
    const a = textNode('猫', p, 0)
    const doc = makeDoc([a], () => null)
    expect(extractTextAt(doc, 5, 5)).toBeNull()
  })

  it('returns null when the tapped char is not a word char (latin/punct)', () => {
    const p = el('P')
    const a = textNode('A', p, 0) // latin glyph
    const [x, y] = center(a, 0)
    const doc = makeDoc([a], () => ({ node: a, offset: 0 }))
    const res = extractTextAt(doc, x, y)
    expect(res).toBeNull()
  })

  it('stops the run at non-word chars (latin/punct/space boundaries)', () => {
    // すA猫 — tapping 猫 should not pull in the latin A before it.
    const p = el('P')
    const a = textNode('すA猫', p, 0)
    const [x, y] = center(a, 2) // tap 猫
    const doc = makeDoc([a], () => ({ node: a, offset: 2 }))
    const res = extractTextAt(doc, x, y)
    expect(res).not.toBeNull()
    expect(res!.text).toBe('猫') // A is a boundary; す is on the far side of it
    expect(res!.tapOffset).toBe(0)
  })

  it('treats ー (long vowel) and 々 (iteration mark) as word chars', () => {
    const p = el('P')
    const a = textNode('人々', p, 0)
    const [x, y] = center(a, 0)
    const doc = makeDoc([a], () => ({ node: a, offset: 0 }))
    const res = extractTextAt(doc, x, y)
    expect(res!.text).toBe('人々')
  })

  it('truncates the forward run at MAX_AFTER characters', () => {
    // 20 kana, tap the first; forward run capped at MAX_AFTER (16).
    const p = el('P')
    const data = 'あ'.repeat(20)
    const a = textNode(data, p, 0)
    const [x, y] = center(a, 0)
    const doc = makeDoc([a], () => ({ node: a, offset: 0 }))
    const res = extractTextAt(doc, x, y)
    expect(res!.text.length).toBe(16) // MAX_AFTER
    expect(res!.tapOffset).toBe(0)
  })

  it('truncates the backward run at MAX_BEFORE characters', () => {
    // 30 kana, tap the last; backward run capped at MAX_BEFORE (12), plus the tapped char.
    const p = el('P')
    const data = 'あ'.repeat(30)
    const a = textNode(data, p, 0)
    const tapOff = 29
    const [x, y] = center(a, tapOff)
    const doc = makeDoc([a], () => ({ node: a, offset: tapOff }))
    const res = extractTextAt(doc, x, y)
    // 12 before + the tapped char (and nothing after the last char)
    expect(res!.tapOffset).toBe(12) // MAX_BEFORE
    expect(res!.text.length).toBe(13)
  })

  it('uses a wider cross-axis slack in vertical writing mode', () => {
    // In vertical-rl the cross axis is x. A tap offset horizontally from the glyph by
    // ~half the leading should still hit vertically-set text but miss horizontal text.
    const verticalStyle: FakeStyle = { writingMode: 'vertical-rl', fontSize: '16px', lineHeight: '40px' }
    // leading = 40-16 = 24; crossSlack = 12 + MIN_HIT_SLACK(6) = 18 on the x axis.
    const p = el('P')
    const a = textNode('猫', p, 0) // box x:[0,16] y:[0,16]
    const tapX = 30 // 14px past right edge (16): inside 18px cross slack, outside reading slack
    const tapY = 8
    const docV = makeDoc([a], () => ({ node: a, offset: 0 }), verticalStyle)
    expect(extractTextAt(docV, tapX, tapY)).not.toBeNull()

    // Same tap against horizontal text (x slack is only the reading slack ~8.4px) misses.
    const horizStyle: FakeStyle = { writingMode: 'horizontal-tb', fontSize: '16px', lineHeight: '40px' }
    const a2 = textNode('猫', el('P'), 0)
    const docH = makeDoc([a2], () => ({ node: a2, offset: 0 }), horizStyle)
    expect(extractTextAt(docH, tapX, tapY)).toBeNull()
  })
})

describe('rangeForSpan', () => {
  function positions(): { doc: any; positions: CharPosition[]; node: FakeText } {
    const node = textNode('猫がすき', el('P'), 0)
    const doc = makeDoc([node], () => null)
    const positions: CharPosition[] = []
    for (let i = 0; i < node.data.length; i++) positions.push({ node: node as any, offset: i })
    return { doc, positions, node }
  }

  it('builds a Range spanning [start, end)', () => {
    const { doc, positions: pos, node } = positions()
    let recordedStart: any
    let recordedEnd: any
    // Wrap createRange to capture the offsets the range was given.
    const realCreate = doc.createRange
    doc.createRange = () => {
      const r = realCreate()
      const origSetStart = r.setStart
      const origSetEnd = r.setEnd
      r.setStart = (n: any, o: number) => {
        recordedStart = { n, o }
        origSetStart(n, o)
      }
      r.setEnd = (n: any, o: number) => {
        recordedEnd = { n, o }
        origSetEnd(n, o)
      }
      return r
    }
    const range = rangeForSpan(doc, pos, 1, 3)
    expect(range).not.toBeNull()
    expect(recordedStart).toEqual({ n: node, o: 1 }) // first.offset
    expect(recordedEnd).toEqual({ n: node, o: 3 }) // last.offset + 1 (index 2 + 1)
  })

  it('returns null for an empty span (start >= end)', () => {
    const { doc, positions: pos } = positions()
    expect(rangeForSpan(doc, pos, 2, 2)).toBeNull()
  })

  it('returns null when out of range (negative start or end past length)', () => {
    const { doc, positions: pos } = positions()
    expect(rangeForSpan(doc, pos, -1, 2)).toBeNull()
    expect(rangeForSpan(doc, pos, 0, pos.length + 1)).toBeNull()
  })

  it('returns null when setEnd on last.offset+1 throws (try/catch path)', () => {
    const { doc, positions: pos } = positions()
    // Make setEnd throw, as a real Range does when the offset exceeds node length.
    doc.createRange = () => ({
      setStart() {},
      setEnd() {
        throw new RangeError('IndexSizeError')
      },
      getClientRects: () => [],
    })
    expect(rangeForSpan(doc, pos, 0, pos.length)).toBeNull()
  })
})
