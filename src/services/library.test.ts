import 'fake-indexeddb/auto'
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

describe('importEpub', () => {
  async function fresh() {
    const { IDBFactory } = await import('fake-indexeddb')
    globalThis.indexedDB = new IDBFactory()
    vi.stubGlobal('navigator', {}) // no OPFS → bytes go to the IndexedDB fallback
    vi.resetModules()
    const view = await import('../vendor/foliate-js/view.js')
    ;(view.makeBook as any).mockResolvedValue({ metadata: { title: { ja: '月と猫' } }, dir: 'rtl' })
    return {
      lib: await import('./library'),
      blobs: await import('./storage/blobs'),
      db: await import('./storage/db'),
    }
  }
  const epub = () => new File([new Uint8Array([1, 2, 3])], 'tsuki.epub', { type: 'application/epub+zip' })

  it('stores bytes and parsed metadata', async () => {
    const { lib, blobs } = await fresh()
    const meta = await lib.importEpub(epub())
    expect(meta.title).toBe('月と猫')
    expect(meta.dir).toBe('rtl')
    expect(await blobs.hasBook(meta.id)).toBe(true)
  })

  it('re-importing a book whose bytes are missing restores them', async () => {
    const { lib, blobs } = await fresh()
    const meta = await lib.importEpub(epub())
    await blobs.deleteBook(meta.id)
    expect(await blobs.hasBook(meta.id)).toBe(false)
    const again = await lib.importEpub(epub())
    expect(again.id).toBe(meta.id)
    expect(await blobs.hasBook(meta.id)).toBe(true)
  })

  it('rolls the bytes back when the metadata write fails', async () => {
    const { lib, db } = await fresh()
    const handle = await db.db()
    const put = handle.put.bind(handle)
    let blobWritten = false
    vi.spyOn(handle, 'put').mockImplementation((async (store: string, ...rest: unknown[]) => {
      if (store === 'books') throw new DOMException('quota', 'QuotaExceededError')
      if (store === 'bookBlobs') blobWritten = true
      return (put as any)(store, ...rest)
    }) as any)
    await expect(lib.importEpub(epub())).rejects.toBeDefined()
    vi.restoreAllMocks()
    expect(blobWritten).toBe(true)
    expect(await handle.getAll('bookBlobs')).toEqual([])
  })
})
