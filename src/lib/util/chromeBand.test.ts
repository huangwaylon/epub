import { describe, it, expect } from 'vitest'
import { inChromeToggleBand } from './chromeBand'

// The chrome-toggle band is 12% of viewport height, clamped to 80–160px, mirrored
// at the top and bottom edges. These cases pin the clamp boundaries and the
// edge-vs-centre routing that decides whether a tap reveals/hides the nav bars.
describe('inChromeToggleBand', () => {
  it('treats taps within the band at the top edge as a chrome toggle', () => {
    const vh = 834 // iPad landscape; band = clamp(80, 100.08, 160) = ~100
    expect(inChromeToggleBand(0, vh)).toBe(true)
    expect(inChromeToggleBand(90, vh)).toBe(true)
  })

  it('treats taps within the band at the bottom edge as a chrome toggle', () => {
    const vh = 834
    expect(inChromeToggleBand(vh, vh)).toBe(true)
    expect(inChromeToggleBand(vh - 90, vh)).toBe(true)
  })

  it('treats a central-reading-area tap as not a toggle', () => {
    expect(inChromeToggleBand(417, 834)).toBe(false)
  })

  it('clamps the band to a 160px maximum on a very tall viewport', () => {
    const vh = 2000 // 12% = 240, clamped to 160
    expect(inChromeToggleBand(160, vh)).toBe(true)
    expect(inChromeToggleBand(161, vh)).toBe(false)
    expect(inChromeToggleBand(vh - 161, vh)).toBe(false)
  })

  it('clamps the band to an 80px minimum on a short viewport', () => {
    const vh = 500 // 12% = 60, clamped up to 80
    expect(inChromeToggleBand(80, vh)).toBe(true)
    expect(inChromeToggleBand(81, vh)).toBe(false)
  })
})
