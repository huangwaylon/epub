// @ts-ignore — vendored JS module, no type declarations
import { makeBook } from '../vendor/foliate-js/view.js'
import type { BookMeta } from './types'
import { putBook, getBookFile, deleteBook } from './storage/blobs'
import {
  deleteBookCascade,
  getAllBooks,
  getBookMeta,
  putBookMeta,
} from './storage/db'

/** EPUB title/author come back as either a plain string or a `{lang: value}` map. */
function flattenLangMap(x: unknown): string {
  if (!x) return ''
  if (typeof x === 'string') return x
  if (typeof x === 'object') {
    const map = x as Record<string, string>
    return map.ja ?? map.ja_JP ?? Object.values(map)[0] ?? ''
  }
  return ''
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Import an EPUB: dedupe by content hash, persist the bytes, then parse metadata
 * and cover via foliate. Returns the (new or existing) shelf entry.
 */
export async function importEpub(file: File): Promise<BookMeta> {
  const buf = await file.arrayBuffer()
  const id = await sha256Hex(buf)

  const existing = await getBookMeta(id)
  if (existing) {
    existing.lastOpenedAt = Date.now()
    await putBookMeta(existing)
    return existing
  }

  await putBook(id, buf)

  let title = file.name.replace(/\.epub$/i, '')
  let author = ''
  let language = ''
  let dir: 'ltr' | 'rtl' = 'ltr'
  let cover: Blob | undefined

  try {
    const book: any = await makeBook(new File([buf], file.name, { type: 'application/epub+zip' }))
    const meta = book?.metadata ?? {}
    title = flattenLangMap(meta.title) || title
    if (Array.isArray(meta.author)) {
      author = meta.author.map((a: any) => flattenLangMap(a?.name ?? a)).filter(Boolean).join('、')
    } else {
      author = flattenLangMap(meta.author)
    }
    language = (Array.isArray(meta.language) ? meta.language[0] : meta.language) ?? ''
    dir = book?.dir === 'rtl' ? 'rtl' : 'ltr'
    cover = (await book?.getCover?.()) ?? undefined
  } catch (err) {
    console.warn('Could not parse EPUB metadata; using fallbacks.', err)
  }

  const now = Date.now()
  const meta: BookMeta = {
    id,
    title,
    author,
    language,
    dir,
    cover,
    fileName: file.name,
    fileSize: buf.byteLength,
    addedAt: now,
    lastOpenedAt: now,
  }
  await putBookMeta(meta)
  return meta
}

/** Shelf listing, most-recently-opened first. */
export async function listBooks(): Promise<BookMeta[]> {
  const books = await getAllBooks()
  return books.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
}

export async function touchBook(id: string): Promise<void> {
  const meta = await getBookMeta(id)
  if (meta) {
    meta.lastOpenedAt = Date.now()
    await putBookMeta(meta)
  }
}

export async function removeBook(id: string): Promise<void> {
  await deleteBookCascade(id)
  await deleteBook(id)
}

export { getBookFile }
