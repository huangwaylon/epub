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

beforeAll(async () => {
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', { documentElement: {} })
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (name: string) => insets[name] ?? '',
  }))
  ;({ placeAnchored } = await import('./anchoredPosition'))
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
