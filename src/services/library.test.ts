import { describe, it, expect, vi } from 'vitest'

// library.ts imports the vendored foliate view (which touches browser globals at
// load) and the storage layer. We only exercise the pure metadata helper here, so
// stub the vendor module; idb-backed storage imports are inert until called.
vi.mock('../vendor/foliate-js/view.js', () => ({ makeBook: vi.fn() }))

import { flattenLangMap } from './library'

// EPUB title/author metadata arrives from foliate as either a plain string or a
// `{lang: value}` map; flattenLangMap normalises it, preferring Japanese.
describe('flattenLangMap', () => {
  it('passes a plain string through', () => {
    expect(flattenLangMap('成瀬は天下を取りにいく')).toBe('成瀬は天下を取りにいく')
  })
  it('prefers the ja entry of a lang map', () => {
    expect(flattenLangMap({ en: 'Naruse', ja: '成瀬' })).toBe('成瀬')
  })
  it('accepts ja_JP as the Japanese key', () => {
    expect(flattenLangMap({ ja_JP: '住野よる', en: 'Yoru Sumino' })).toBe('住野よる')
  })
  it('falls back to the first value when no Japanese key is present', () => {
    expect(flattenLangMap({ en: 'Sayaka Murata' })).toBe('Sayaka Murata')
  })
  it('returns empty string for null/undefined/empty', () => {
    expect(flattenLangMap(undefined)).toBe('')
    expect(flattenLangMap(null)).toBe('')
    expect(flattenLangMap('')).toBe('')
    expect(flattenLangMap({})).toBe('')
  })
})
