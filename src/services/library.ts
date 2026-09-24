import type { BookMeta } from './types'
import { putBook, getBookFile, deleteBook, hasBook } from './storage/blobs'
import { deleteBookCascade, getAllBooks, getBookMeta, putBookMeta } from './storage/db'

/** EPUB title/author are a string or a `{lang: value}` map; prefer Japanese. */
export function flattenLangMap(x: unknown): string {
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

/** Shelf covers render ~120–170px wide; 320px stays crisp at 2–3× without storing (and
 *  decoding) full-resolution publisher art for every book. */
const COVER_THUMB_WIDTH = 320

/** Downscale a cover to a WebP thumbnail; returns the original on any failure. */
async function thumbnailCover(blob: Blob | undefined): Promise<Blob | undefined> {
  if (!blob) return undefined
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return blob
  let bmp: ImageBitmap | undefined
  try {
    bmp = await createImageBitmap(blob)
    if (bmp.width <= COVER_THUMB_WIDTH) return blob
    const w = COVER_THUMB_WIDTH
    const h = Math.max(1, Math.round((bmp.height * COVER_THUMB_WIDTH) / bmp.width))
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    if (!ctx) return blob
    ctx.drawImage(bmp, 0, 0, w, h)
    const out = await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 })
    // Tiny covers can grow when re-encoded — keep whichever is smaller.
    return out.size < blob.size ? out : blob
  } catch {
    return blob
  } finally {
    bmp?.close()
  }
}

/** Never throws: an unparseable book falls back to its file name and no cover. */
async function parseMeta(file: File) {
  const out = {
    title: file.name.replace(/\.epub$/i, ''),
    author: '',
    language: '',
    dir: 'ltr' as 'ltr' | 'rtl',
    cover: undefined as Blob | undefined,
  }
  try {
    // Dynamic so foliate stays off the shelf's cold-start path.
    // @ts-ignore — vendored JS module, no type declarations
    const { makeBook } = await import('../vendor/foliate-js/view.js')
    const book: any = await makeBook(file)
    const meta = book?.metadata ?? {}
    out.title = flattenLangMap(meta.title) || out.title
    if (Array.isArray(meta.author)) {
      out.author = meta.author.map((a: any) => flattenLangMap(a?.name ?? a)).filter(Boolean).join('、')
    } else {
      out.author = flattenLangMap(meta.author)
    }
    out.language = (Array.isArray(meta.language) ? meta.language[0] : meta.language) ?? ''
    out.dir = book?.dir === 'rtl' ? 'rtl' : 'ltr'
    out.cover = await thumbnailCover((await book?.getCover?.()) ?? undefined)
  } catch (err) {
    console.warn('Could not parse EPUB metadata; using fallbacks.', err)
  }
  return out
}

/** Import an EPUB, deduped by content hash. Returns the new or existing shelf entry. */
export async function importEpub(file: File): Promise<BookMeta> {
  // Don't bind the ArrayBuffer: keeps peak heap near 1× the file (large EPUBs can OOM an iPad tab).
  const id = await sha256Hex(await file.arrayBuffer())

  const existing = await getBookMeta(id)
  if (existing) {
    // Re-importing restores lost bytes (what the reader's "please re-import" message asks for).
    if (!(await hasBook(id))) await putBook(id, file)
    existing.lastOpenedAt = Date.now()
    await putBookMeta(existing)
    return existing
  }

  // On failure roll the bytes back, or they'd be orphaned (no `books` row) against quota.
  try {
    const [, parsed] = await Promise.all([putBook(id, file), parseMeta(file)])
    const now = Date.now()
    const meta: BookMeta = {
      id,
      ...parsed,
      fileName: file.name,
      fileSize: file.size,
      addedAt: now,
      lastOpenedAt: now,
    }
    await putBookMeta(meta)
    return meta
  } catch (err) {
    await deleteBook(id).catch(() => {})
    throw err
  }
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
