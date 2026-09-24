import { describe, it, expect } from 'vitest'
import { nearestFirst, cfiWithinPage } from './cfi'

// Spine item /6/4 (section 1), text node /4/2/N — offsets within paragraph N.
const at = (para: number, off: number) => `epubcfi(/6/4!/4/${para * 2}/1:${off})`
const page = (fromPara: number, fromOff: number, toPara: number, toOff: number) =>
  `epubcfi(/6/4!/4,/${fromPara * 2}/1:${fromOff},/${toPara * 2}/1:${toOff})`

describe('nearestFirst', () => {
  it('walks outward from the current position in document order', () => {
    const cfis = [at(1, 0), at(9, 0), at(5, 0), at(3, 0), at(7, 0)]
    // "here" sits between paragraph 5 and 7.
    const out = nearestFirst(cfis, page(6, 0, 6, 50))
    expect(out).toEqual([at(7, 0), at(5, 0), at(9, 0), at(3, 0), at(1, 0)])
  })

  it('puts everything after when here precedes all, and before when it follows all', () => {
    const cfis = [at(3, 0), at(1, 0), at(2, 0)]
    expect(nearestFirst(cfis, at(0, 0))).toEqual([at(1, 0), at(2, 0), at(3, 0)])
    expect(nearestFirst(cfis, at(8, 0))).toEqual([at(3, 0), at(2, 0), at(1, 0)])
  })

  it('orders across sections, and a CFI at the page start comes first', () => {
    const other = 'epubcfi(/6/8!/4/2/1:0)' // a later spine item
    const cfis = [other, at(4, 3), at(4, 1)]
    expect(nearestFirst(cfis, at(4, 3))[0]).toBe(at(4, 3))
    expect(nearestFirst(cfis, at(4, 3))).toContain(other)
  })

  it('returns the input order when here is unparseable, and keeps every CFI', () => {
    const cfis = [at(2, 0), at(1, 0)]
    expect(nearestFirst(cfis, '')).toEqual(cfis)
    expect(nearestFirst(cfis, at(1, 5)).sort()).toEqual([...cfis].sort())
  })
})

describe('cfiWithinPage', () => {
  const p = page(2, 0, 4, 10)
  it('is start-inclusive, end-exclusive', () => {
    expect(cfiWithinPage(at(2, 0), p)).toBe(true)
    expect(cfiWithinPage(at(3, 7), p)).toBe(true)
    expect(cfiWithinPage(at(4, 10), p)).toBe(false)
    expect(cfiWithinPage(at(1, 99), p)).toBe(false)
  })
  it('uses the start of a range bookmark (the page it was saved on)', () => {
    expect(cfiWithinPage(page(3, 0, 5, 0), p)).toBe(true)
    expect(cfiWithinPage(page(4, 10, 6, 0), p)).toBe(false)
  })
  it('matches exact equality and rejects empty input', () => {
    expect(cfiWithinPage(p, p)).toBe(true)
    expect(cfiWithinPage('', p)).toBe(false)
    expect(cfiWithinPage(at(2, 0), '')).toBe(false)
  })
})
