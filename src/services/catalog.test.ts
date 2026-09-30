import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'

// Bundled downloads never parse with foliate; make that observable.
const { makeBook } = vi.hoisted(() => ({ makeBook: vi.fn() }))
vi.mock('../vendor/foliate-js/view.js', () => ({ makeBook }))

import { deriveStatus, readWithProgress, downloadErrorMessage, type CatalogEntry } from './catalog'

const bytes = new Uint8Array(Array.from({ length: 5000 }, (_, i) => i % 251))
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

function entry(over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    slug: 'tsuki',
    id: sha(bytes),
    title: '月と猫',
    author: '作者',
    language: 'ja',
    dir: 'rtl',
    file: 'tsuki.epub',
    size: bytes.length,
    cover: 'tsuki.webp',
    translation: { lang: 'en', coverage: 0.5 },
    ...over,
  }
}

/** A body delivered in `n` chunks, with or without Content-Length. */
function streamed(data: Uint8Array, n: number, headers: Record<string, string> = {}): Response {
  const step = Math.ceil(data.length / n)
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < data.length; i += step) c.enqueue(data.slice(i, i + step))
      c.close()
    },
  })
  return new Response(body, { headers })
}

function fakeFetch(epub: Uint8Array, opts: { cover?: boolean; status?: number } = {}) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url)
    if (u.endsWith('catalog.json')) return new Response(JSON.stringify([entry()]))
    if (u.endsWith('.webp'))
      return opts.cover === false ? new Response('', { status: 404 }) : new Response(new Blob([new Uint8Array([9, 9])], { type: 'image/webp' }))
    if (u.endsWith('.epub')) {
      if (opts.status) return new Response('', { status: opts.status })
      return streamed(epub, 4, { 'content-length': String(epub.length) })
    }
    return new Response('', { status: 404 })
  }) as unknown as typeof fetch
}

describe('deriveStatus', () => {
  const e = entry()
  it('is available with no job and not in the library', () => {
    expect(deriveStatus(e, new Set(), undefined)).toEqual({ kind: 'available' })
  })
  it('reports the job while downloading or failed', () => {
    expect(deriveStatus(e, new Set(), { kind: 'downloading', progress: 0.4 })).toEqual({ kind: 'downloading', progress: 0.4 })
    expect(deriveStatus(e, new Set(), { kind: 'error', message: 'x' })).toEqual({ kind: 'error', message: 'x' })
  })
  it('is downloaded whenever the library has the id, even with a stale job', () => {
    expect(deriveStatus(e, new Set([e.id]), { kind: 'error', message: 'x' })).toEqual({ kind: 'downloaded' })
  })
})

describe('readWithProgress', () => {
  it('reports monotonic progress against Content-Length, ending at 1', async () => {
    const seen: number[] = []
    const blob = await readWithProgress(streamed(bytes, 5, { 'content-length': String(bytes.length) }), 0, (p) => seen.push(p))
    expect(blob.size).toBe(bytes.length)
    expect(seen[0]).toBe(0)
    expect(seen.at(-1)).toBe(1)
    expect(seen.length).toBeGreaterThan(3)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1])
  })
  it('falls back to the catalog size without Content-Length, clamped to 1', async () => {
    const seen: number[] = []
    await readWithProgress(streamed(bytes, 4), bytes.length / 2, (p) => seen.push(p))
    expect(Math.max(...seen)).toBe(1)
    expect(seen[1]).toBeCloseTo(0.5, 1)
  })
  it('ignores Content-Length when the body is content-encoded', async () => {
    const seen: number[] = []
    await readWithProgress(streamed(bytes, 2, { 'content-length': '10', 'content-encoding': 'gzip' }), bytes.length, (p) => seen.push(p))
    expect(seen[1]).toBeCloseTo(0.5, 1)
  })
})

describe('downloadErrorMessage', () => {
  it('maps offline, checksum and quota failures', () => {
    expect(downloadErrorMessage(new TypeError('Failed to fetch'), true)).toMatch(/offline/)
    expect(downloadErrorMessage(new Error('x'), false)).toMatch(/offline/)
    expect(downloadErrorMessage(Object.assign(new Error('x'), { name: 'ChecksumError' }), true)).toMatch(/corrupted/)
    expect(downloadErrorMessage(new DOMException('q', 'QuotaExceededError'), true)).toMatch(/storage/)
    expect(downloadErrorMessage(new Error('HTTP 500'), true)).toMatch(/Couldn’t download/)
  })
})

describe('downloadEntry', () => {
  async function fresh() {
    const { IDBFactory } = await import('fake-indexeddb')
    globalThis.indexedDB = new IDBFactory()
    vi.stubGlobal('navigator', { onLine: true }) // no OPFS → IndexedDB fallback
    vi.resetModules()
    makeBook.mockClear()
    return {
      cat: await import('./catalog'),
      blobs: await import('./storage/blobs'),
      db: await import('./storage/db'),
    }
  }

  beforeEach(() => vi.unstubAllGlobals())

  it('imports with catalog metadata and cover, without parsing', async () => {
    const { cat, blobs } = await fresh()
    const progress: number[] = []
    const meta = await cat.downloadEntry(entry(), { fetchImpl: fakeFetch(bytes), onProgress: (p) => progress.push(p) })
    expect(meta.id).toBe(sha(bytes))
    expect(meta.title).toBe('月と猫')
    expect(meta.dir).toBe('rtl')
    expect(meta.cover?.size).toBe(2)
    expect(await blobs.hasBook(meta.id)).toBe(true)
    expect(makeBook).not.toHaveBeenCalled()
    expect(progress.at(-1)).toBe(1)
  })

  it('rejects a hash mismatch and stores nothing', async () => {
    const { cat, db, blobs } = await fresh()
    const tampered = bytes.slice()
    tampered[0] ^= 0xff
    await expect(cat.downloadEntry(entry(), { fetchImpl: fakeFetch(tampered) })).rejects.toMatchObject({ name: 'ChecksumError' })
    expect(await db.getAllBooks()).toEqual([])
    expect(await blobs.hasBook(sha(tampered))).toBe(false)
  })

  it('fails on an HTTP error; a missing cover is not fatal', async () => {
    const { cat } = await fresh()
    await expect(cat.downloadEntry(entry(), { fetchImpl: fakeFetch(bytes, { status: 404 }) })).rejects.toThrow(/404/)
    const meta = await cat.downloadEntry(entry(), { fetchImpl: fakeFetch(bytes, { cover: false }) })
    expect(meta.cover).toBeUndefined()
  })

  it('fetchCatalog drops malformed entries', async () => {
    const { cat } = await fresh()
    const f = vi.fn(async () => new Response(JSON.stringify([entry(), { id: 'nope' }, null]))) as unknown as typeof fetch
    expect((await cat.fetchCatalog(f)).map((e) => e.slug)).toEqual(['tsuki'])
  })
})
