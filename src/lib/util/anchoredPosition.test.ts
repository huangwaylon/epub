import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

// anchoredPosition.ts registers resize/orientationchange listeners at module load and
// reads window.innerWidth/innerHeight + getComputedStyle(--safe-*) at call time. We
// hand-mock those globals (node env, no jsdom) and dynamically import after stubbing.

const insets: Record<string, string> = {}
const listeners: Record<string, Array<(e: any) => void>> = {}
const win = {
  innerWidth: 1194,
  innerHeight: 834,
  addEventListener: (type: string, cb: (e: any) => void) => {
    ;(listeners[type] ??= []).push(cb)
  },
  dispatchEvent: (e: { type: string }) => {
    for (const cb of listeners[e.type] ?? []) cb(e)
  },
}

let placeAnchored: typeof import('./anchoredPosition').placeAnchored
let placeNearWord: typeof import('./anchoredPosition').placeNearWord

beforeAll(async () => {
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', { documentElement: {} })
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (name: string) => insets[name] ?? '',
  }))
  ;({ placeAnchored, placeNearWord } = await import('./anchoredPosition'))
})

beforeEach(() => {
  for (const k of Object.keys(insets)) delete insets[k]
  win.innerWidth = 1194
  win.innerHeight = 834
  // Drop the module's inset cache so each test reads fresh --safe-* values.
  win.dispatchEvent({ type: 'resize' })
})

describe('placeAnchored', () => {
  it('places centred above the anchor when there is room', () => {
    const { left, top } = placeAnchored(600, 400, 420, 300, 160, { gap: 16 })
    expect(left).toBe(450) // 600 - 300/2
    expect(top).toBe(224) // 400 - 160 - 16
  })

  it('flips below when there is not room above for the full height', () => {
    const { top } = placeAnchored(600, 100, 120, 300, 160, { gap: 16 })
    // room above = 100 - 10(margin) - 16(gap) = 74 < 160 -> flip below anchorBottom+gap
    expect(top).toBe(136) // 120 + 16
  })

  it('clamps to the left margin when the anchor is near the left edge', () => {
    const { left } = placeAnchored(20, 400, 420, 300, 160)
    expect(left).toBe(10) // base margin, insets 0
  })

  it('clamps to the right margin when the anchor is near the right edge', () => {
    const { left } = placeAnchored(1190, 400, 420, 300, 160)
    expect(left).toBe(884) // vw - w - mRight = 1194 - 300 - 10
  })

  it('clamps the top to the bottom safe margin when forced below near the bottom edge', () => {
    // Little room above (flips below), but anchorBottom is near the bottom, so the
    // below position would overflow -> clamp to vh - h - mBottom.
    const { top } = placeAnchored(600, 100, 800, 300, 160)
    expect(top).toBe(664) // 834 - 160 - 10
  })

  it('honours left/right safe-area insets in the horizontal clamp', () => {
    insets['--safe-left'] = '44'
    win.dispatchEvent({ type: 'resize' }) // invalidate cached insets
    const { left } = placeAnchored(20, 400, 420, 300, 160)
    expect(left).toBe(54) // base 10 + inset 44
  })

  it('respects a custom margin', () => {
    const { left } = placeAnchored(0, 400, 420, 300, 160, { margin: 30 })
    expect(left).toBe(30)
  })
})

describe('placeNearWord', () => {
  const word = { left: 600, top: 300, right: 624, bottom: 372 } // a 3-glyph vertical word

  it('horizontal: above the word rect, centred on it', () => {
    const p = placeNearWord(word, 300, 160, false, { gap: 16 })
    expect(p.top).toBe(300 - 160 - 16)
    expect(p.left).toBe(612 - 150)
  })

  it('horizontal: flips below the word rect when there is no room above', () => {
    const p = placeNearWord({ left: 600, top: 60, right: 680, bottom: 90 }, 300, 160, false, { gap: 16 })
    expect(p.top).toBe(90 + 16)
  })

  it('vertical: to the left of the column when it fits, centred on the word', () => {
    const p = placeNearWord(word, 300, 160, true, { gap: 16 })
    expect(p.left).toBe(600 - 16 - 300)
    expect(p.top).toBe(336 - 80)
  })

  it('vertical: to the right when the left side has no room', () => {
    const near = { left: 200, top: 300, right: 224, bottom: 372 }
    const p = placeNearWord(near, 300, 160, true, { gap: 16 })
    expect(p.left).toBe(224 + 16)
  })

  it('vertical: never covers the column when either side fits; clamps top/bottom', () => {
    const low = { left: 600, top: 790, right: 624, bottom: 830 }
    const p = placeNearWord(low, 300, 160, true, { gap: 16 })
    expect(p.left + 300).toBeLessThanOrEqual(600)
    expect(p.top).toBe(834 - 160 - 10)
  })
})
