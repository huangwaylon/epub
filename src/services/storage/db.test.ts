import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { vi } from 'vitest'
import type { Annotation, BookMeta, ReadingProgress } from '../types'

/**
 * db.ts memoises a single connection in a module-scoped `dbPromise`, so we reset
 * the module between tests (clearing that cache) and swap in a fresh
 * fake-indexeddb factory. A dynamic import after the reset then opens a brand-new
 * empty database, isolating every test.
 */
type DbModule = typeof import('./db')

let mod: DbModule

function makeBook(id: string, overrides: Partial<BookMeta> = {}): BookMeta {
  return {
    id,
    title: `Title ${id}`,
    author: `Author ${id}`,
    language: 'ja',
    dir: 'rtl',
    fileName: `${id}.epub`,
    fileSize: 1234,
    addedAt: 1,
    lastOpenedAt: 2,
    ...overrides,
  }
}

function makeAnnotation(id: string, bookId: string, overrides: Partial<Annotation> = {}): Annotation {
  return {
    id,
    bookId,
    kind: 'highlight',
    cfi: `cfi-${id}`,
    text: `text-${id}`,
    createdAt: 1,
    ...overrides,
  }
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory()
  vi.resetModules()
  mod = await import('./db')
})

describe('storage/db schema', () => {
  it('creates all object stores and the annotations byBook index on upgrade', async () => {
    const handle = await mod.db()
    expect([...handle.objectStoreNames].sort()).toEqual(
      ['annotations', 'bookBlobs', 'books', 'progress', 'settings'].sort(),
    )
    const tx = handle.transaction('annotations')
    expect([...tx.objectStore('annotations').indexNames]).toContain('byBook')
    await tx.done
  })
})

describe('storage/db books', () => {
  it('round-trips book metadata via putBookMeta/getBookMeta', async () => {
    const book = makeBook('b1', { title: '月と猫' })
    await mod.putBookMeta(book)
    const got = await mod.getBookMeta('b1')
    expect(got).toEqual(book)
  })

  it('returns undefined for a missing book', async () => {
    expect(await mod.getBookMeta('nope')).toBeUndefined()
  })

  it('getAllBooks returns every stored book', async () => {
    await mod.putBookMeta(makeBook('b1'))
    await mod.putBookMeta(makeBook('b2'))
    await mod.putBookMeta(makeBook('b3'))
    const all = await mod.getAllBooks()
    expect(all.map((b) => b.id).sort()).toEqual(['b1', 'b2', 'b3'])
  })

  it('putBookMeta overwrites an existing record with the same id', async () => {
    await mod.putBookMeta(makeBook('b1', { title: 'first' }))
    await mod.putBookMeta(makeBook('b1', { title: 'second' }))
    const all = await mod.getAllBooks()
    expect(all).toHaveLength(1)
    expect(all[0].title).toBe('second')
  })
})

describe('storage/db annotations byBook index', () => {
  it('getAnnotations returns only annotations for the given bookId', async () => {
    await mod.putAnnotation(makeAnnotation('a1', 'b1'))
    await mod.putAnnotation(makeAnnotation('a2', 'b1'))
    await mod.putAnnotation(makeAnnotation('a3', 'b2'))

    const forB1 = await mod.getAnnotations('b1')
    expect(forB1.map((a) => a.id).sort()).toEqual(['a1', 'a2'])

    const forB2 = await mod.getAnnotations('b2')
    expect(forB2.map((a) => a.id)).toEqual(['a3'])

    expect(await mod.getAnnotations('absent')).toEqual([])
  })
})

describe('storage/db deleteBookCascade', () => {
  it('removes the book, its progress, and all its annotations together', async () => {
    await mod.putBookMeta(makeBook('b1'))
    await mod.putBookMeta(makeBook('b2'))

    const progress: ReadingProgress = { bookId: 'b1', cfi: 'cfi', fraction: 0.5, updatedAt: 1 }
    await mod.putProgress(progress)
    await mod.putProgress({ bookId: 'b2', cfi: 'cfi2', fraction: 0.1, updatedAt: 1 })

    await mod.putAnnotation(makeAnnotation('a1', 'b1'))
    await mod.putAnnotation(makeAnnotation('a2', 'b1'))
    await mod.putAnnotation(makeAnnotation('a3', 'b2'))

    await mod.deleteBookCascade('b1')

    // b1 and everything attached to it is gone.
    expect(await mod.getBookMeta('b1')).toBeUndefined()
    const handle = await mod.db()
    expect(await handle.get('progress', 'b1')).toBeUndefined()
    expect(await mod.getAnnotations('b1')).toEqual([])

    // b2 is untouched.
    expect(await mod.getBookMeta('b2')).toBeDefined()
    expect(await handle.get('progress', 'b2')).toBeDefined()
    expect((await mod.getAnnotations('b2')).map((a) => a.id)).toEqual(['a3'])
  })
})
