import { describe, it, expect } from 'vitest'
import { deinflect } from './deinflect'

/** Helper: the set of de-inflected base forms produced for a surface form. */
function bases(surface: string): string[] {
  return deinflect(surface).map((c) => c.word)
}

describe('deinflect (vendored from 10ten)', () => {
  it('reduces ichidan te-form continuous polite past to the plain form', () => {
    expect(bases('食べていました')).toContain('食べる')
  })

  it('reduces an i-adjective past form', () => {
    expect(bases('美しかった')).toContain('美しい')
  })

  it('reduces a godan past form', () => {
    expect(bases('走った')).toContain('走る')
  })

  it('reduces the -tai (desiderative) form', () => {
    expect(bases('読みたい')).toContain('読む')
  })

  it('reduces the volitional form', () => {
    expect(bases('行こう')).toContain('行く')
  })

  it('reduces passive/potential', () => {
    expect(bases('見られた')).toContain('見る')
  })

  it('always includes the original surface form as a candidate', () => {
    expect(bases('猫')).toContain('猫')
  })

  it('tags candidates with at least one inflectable word type when deinflected', () => {
    const cands = deinflect('食べていました')
    const taberu = cands.find((c) => c.word === '食べる')
    expect(taberu).toBeDefined()
    expect(taberu!.reasonChains.length).toBeGreaterThan(0)
  })
})
