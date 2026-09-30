import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'

vi.mock('../vendor/foliate-js/view.js', () => ({ makeBook: vi.fn() }))

const epubA = new Uint8Array(Array.from({ length: 3000 }, (_, i) => i % 7))
const epubB = new Uint8Array(Array.from({ length: 2000 }, (_, i) => i % 11))
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const entries = [
  { slug: 'a', id: sha(epubA), title: 'A', author: '', file: 'a.epub', size: epubA.length },
  { slug: 'b', id: sha(epubB), title: 'B', author: '', file: 'b.epub', size: epubB.length },
]

function fakeFetch({ corruptB = false, offline = false } = {}) {
  return vi.fn(async (url: string) => {
    if (offline) throw new TypeError('Failed to fetch')
    if (url.endsWith('catalog.json')) return new Response(JSON.stringify(entries))
    if (url.endsWith('a.epub')) return new Response(epubA, { headers: { 'content-length': String(epubA.length) } })
    if (url.endsWith('b.epub')) return new Response(corruptB ? epubA : epubB)
    return new Response('', { status: 404 })
  }) as unknown as typeof fetch
}

async function fresh() {
  const { IDBFactory } = await import('fake-indexeddb')
  globalThis.indexedDB = new IDBFactory()
  vi.stubGlobal('navigator', { onLine: true })
  vi.resetModules()
  const store = await import('./catalog.svelte')
  const lib = await import('./library.svelte')
  const toast = await import('./toast.svelte')
  return { store, lib, toast }
}

beforeEach(() => vi.unstubAllGlobals())

describe('catalog store', () => {
  it('derives available → downloaded → available across download and delete', async () => {
    const { store, lib } = await fresh()
    await store.loadCatalog(fakeFetch())
    await lib.refreshLibrary()
    const [a] = store.catalog.entries
    expect(store.entryStatus(a).kind).toBe('available')

    const p = store.downloadBook(a.id, { fetchImpl: fakeFetch() })
    expect(store.entryStatus(a).kind).toBe('downloading')
    expect(await p).toBe(true)
    expect(store.entryStatus(a).kind).toBe('downloaded')
    expect(store.availableEntries().map((e) => e.slug)).toEqual(['b'])

    await lib.deleteBook(a.id)
    expect(store.entryStatus(a).kind).toBe('available')
    // Nothing re-imports it behind the user's back.
    await store.loadCatalog(fakeFetch())
    await lib.refreshLibrary()
    expect(lib.library.books).toEqual([])
  })

  it('records a checksum failure as an error status and toasts it', async () => {
    const { store, lib, toast } = await fresh()
    await store.loadCatalog(fakeFetch())
    await lib.refreshLibrary()
    const b = store.catalog.entries[1]
    expect(await store.downloadBook(b.id, { fetchImpl: fakeFetch({ corruptB: true }) })).toBe(false)
    expect(store.entryStatus(b)).toEqual({ kind: 'error', message: expect.stringMatching(/corrupted/) })
    expect(toast.toast.current?.message).toMatch(/corrupted/)
    expect(lib.library.books).toEqual([])
  })

  it('downloadAll imports every available book and reports partial failure once', async () => {
    const { store, lib, toast } = await fresh()
    await store.loadCatalog(fakeFetch())
    await lib.refreshLibrary()
    expect(await store.downloadAll({ fetchImpl: fakeFetch({ corruptB: true }) })).toEqual({ ok: 1, failed: 1 })
    expect(toast.toast.current?.message).toMatch(/Downloaded 1 of 2/)
    // Retry fixes the failed one only.
    expect(await store.downloadAll({ fetchImpl: fakeFetch() })).toEqual({ ok: 1, failed: 0 })
    expect(lib.library.books.map((x) => x.title).sort()).toEqual(['A', 'B'])
  })

  it('offline: catalog load failure is surfaced and retryable; downloads say offline', async () => {
    const { store, lib } = await fresh()
    await store.loadCatalog(fakeFetch({ offline: true }))
    expect(store.catalog.error).toBeTruthy()
    await store.loadCatalog(fakeFetch())
    expect(store.catalog.error).toBeNull()
    await lib.refreshLibrary()
    await store.downloadBook(store.catalog.entries[0].id, { fetchImpl: fakeFetch({ offline: true }) })
    expect(store.entryStatus(store.catalog.entries[0])).toMatchObject({ kind: 'error', message: expect.stringMatching(/offline/) })
  })
})
