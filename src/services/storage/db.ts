import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Annotation, BookMeta, ReaderSettings, ReadingProgress } from '../types'

/**
 * IndexedDB holds all structured data: book metadata, reading progress,
 * annotations, settings, and a translation cache. The (potentially large) EPUB
 * bytes are stored separately — see blobs.ts (OPFS with an IDB fallback).
 */

export interface CachedTranslation {
  key: string // `${target}:${hash(text)}` — see services/translate.ts (small djb2 hash)
  text: string
  target: string
  result: string
  engine: string
  createdAt: number
}

/** Fallback object store for EPUB bytes when OPFS is unavailable. */
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
  translations: { key: string; value: CachedTranslation }
  bookBlobs: { key: string; value: StoredBlob }
}

const DB_NAME = 'tsuzuri'
const DB_VERSION = 1

let dbPromise: Promise<IDBPDatabase<TsuzuriDB>> | null = null

export function db(): Promise<IDBPDatabase<TsuzuriDB>> {
  if (!dbPromise) {
    dbPromise = openDB<TsuzuriDB>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        database.createObjectStore('books', { keyPath: 'id' })
        database.createObjectStore('progress', { keyPath: 'bookId' })
        const ann = database.createObjectStore('annotations', { keyPath: 'id' })
        ann.createIndex('byBook', 'bookId')
        database.createObjectStore('settings')
        database.createObjectStore('translations', { keyPath: 'key' })
        database.createObjectStore('bookBlobs', { keyPath: 'id' })
      },
    })
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

export async function deleteBookMeta(id: string): Promise<void> {
  await (await db()).delete('books', id)
}

/* ── Progress ──────────────────────────────────────────────────────────── */

export async function getProgress(bookId: string): Promise<ReadingProgress | undefined> {
  return (await db()).get('progress', bookId)
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

/** Remove a book and everything attached to it (blob deletion handled by caller). */
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

/* ── Translation cache ─────────────────────────────────────────────────── */

export async function getCachedTranslation(key: string): Promise<CachedTranslation | undefined> {
  return (await db()).get('translations', key)
}

export async function putCachedTranslation(t: CachedTranslation): Promise<void> {
  await (await db()).put('translations', t)
}

/* ── Blob fallback (used by blobs.ts when OPFS is unavailable) ──────────── */

export async function putBlobFallback(id: string, blob: Blob): Promise<void> {
  await (await db()).put('bookBlobs', { id, blob })
}

export async function getBlobFallback(id: string): Promise<Blob | undefined> {
  return (await (await db()).get('bookBlobs', id))?.blob
}

export async function deleteBlobFallback(id: string): Promise<void> {
  await (await db()).delete('bookBlobs', id)
}
