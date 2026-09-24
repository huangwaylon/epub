import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Annotation, BookMeta, ReaderSettings, ReadingProgress } from '../types'

/** All structured data. EPUB bytes live in OPFS (blobs.ts); `bookBlobs` is its fallback. */

interface StoredBlob {
  id: string
  blob: Blob
}

interface TsuzuriDB extends DBSchema {
  books: { key: string; value: BookMeta }
  progress: { key: string; value: ReadingProgress }
  annotations: {
    key: string
    value: Annotation
    indexes: { byBook: string }
  }
  settings: { key: string; value: ReaderSettings }
  bookBlobs: { key: string; value: StoredBlob }
}

const DB_NAME = 'tsuzuri'
const DB_VERSION = 1

let dbPromise: Promise<IDBPDatabase<TsuzuriDB>> | null = null

/**
 * Lazily opened shared connection. The cache is dropped when the connection dies so the
 * next call reopens: iOS WebKit severs IDB connections after long backgrounding
 * (`terminated`), and a newer build's upgrade fires `blocking` (we close so it can).
 */
export function db(): Promise<IDBPDatabase<TsuzuriDB>> {
  if (!dbPromise) {
    const p: Promise<IDBPDatabase<TsuzuriDB>> = openDB<TsuzuriDB>(DB_NAME, DB_VERSION, {
      upgrade(database, oldVersion) {
        // One `if (oldVersion < N)` step per version.
        if (oldVersion < 1) {
          database.createObjectStore('books', { keyPath: 'id' })
          database.createObjectStore('progress', { keyPath: 'bookId' })
          const ann = database.createObjectStore('annotations', { keyPath: 'id' })
          ann.createIndex('byBook', 'bookId')
          database.createObjectStore('settings')
          database.createObjectStore('bookBlobs', { keyPath: 'id' })
        }
      },
      blocking() {
        void p.then((d) => d.close())
        if (dbPromise === p) dbPromise = null
      },
      terminated() {
        if (dbPromise === p) dbPromise = null
      },
    })
    p.catch(() => {
      if (dbPromise === p) dbPromise = null
    })
    dbPromise = p
  }
  return dbPromise
}

/* ── Books ─────────────────────────────────────────────────────────────── */

export async function putBookMeta(meta: BookMeta): Promise<void> {
  await (await db()).put('books', meta)
}

export async function getBookMeta(id: string): Promise<BookMeta | undefined> {
  return (await db()).get('books', id)
}

export async function getAllBooks(): Promise<BookMeta[]> {
  return (await db()).getAll('books')
}

/* ── Progress ──────────────────────────────────────────────────────────── */

export async function getProgress(bookId: string): Promise<ReadingProgress | undefined> {
  return (await db()).get('progress', bookId)
}

/** Every book's progress in one read (the shelf's rings). */
export async function getAllProgress(): Promise<ReadingProgress[]> {
  return (await db()).getAll('progress')
}

export async function putProgress(p: ReadingProgress): Promise<void> {
  await (await db()).put('progress', p)
}

/* ── Annotations ───────────────────────────────────────────────────────── */

export async function getAnnotations(bookId: string): Promise<Annotation[]> {
  return (await db()).getAllFromIndex('annotations', 'byBook', bookId)
}

export async function putAnnotation(a: Annotation): Promise<void> {
  await (await db()).put('annotations', a)
}

export async function deleteAnnotation(id: string): Promise<void> {
  await (await db()).delete('annotations', id)
}

/** Remove a book's metadata, progress and annotations. The caller deletes the bytes. */
export async function deleteBookCascade(id: string): Promise<void> {
  const database = await db()
  const tx = database.transaction(['books', 'progress', 'annotations'], 'readwrite')
  await tx.objectStore('books').delete(id)
  await tx.objectStore('progress').delete(id)
  const annStore = tx.objectStore('annotations')
  let cursor = await annStore.index('byBook').openCursor(id)
  while (cursor) {
    await cursor.delete()
    cursor = await cursor.continue()
  }
  await tx.done
}

/* ── Settings ──────────────────────────────────────────────────────────── */

export async function loadSettings(): Promise<ReaderSettings | undefined> {
  return (await db()).get('settings', 'reader')
}

export async function saveSettings(s: ReaderSettings): Promise<void> {
  await (await db()).put('settings', s, 'reader')
}

/* ── Blob fallback (blobs.ts) ─────────────────────────────────────────── */

export async function putBlobFallback(id: string, blob: Blob): Promise<void> {
  await (await db()).put('bookBlobs', { id, blob })
}

export async function getBlobFallback(id: string): Promise<Blob | undefined> {
  return (await (await db()).get('bookBlobs', id))?.blob
}

export async function deleteBlobFallback(id: string): Promise<void> {
  await (await db()).delete('bookBlobs', id)
}
