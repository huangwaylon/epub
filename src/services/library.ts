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

/** Target width for stored cover thumbnails. The shelf renders covers ~120–170px
 *  wide; 320px stays crisp on 2–3× displays while keeping the stored (and later
 *  decoded) blob small, instead of holding the publisher's full-resolution art —
 *  often 1400×2100+ — in IndexedDB and in heap for every book on the shelf. */
const COVER_THUMB_WIDTH = 320

/**
 * Downscale a cover image to a small thumbnail at import time. Falls back to the
 * original blob on any failure (missing OffscreenCanvas, decode error, or if the
 * source is already small enough), so a cover is never lost to downscaling.
 */
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

/**
 * Import an EPUB: dedupe by content hash, persist the bytes, then parse metadata
 * and cover via foliate. Returns the (new or existing) shelf entry.
 */
export async function importEpub(file: File): Promise<BookMeta> {
  // Hash the bytes to dedupe by content. The ArrayBuffer is only needed for the
  // digest, so we don't hold it in a long-lived binding — it becomes GC-eligible
  // immediately after, keeping peak heap near 1× the file size rather than ~3×
  // (an oversized light-novel EPUB on an iPad can otherwise OOM the tab).
  const id = await sha256Hex(await file.arrayBuffer())

  const existing = await getBookMeta(id)
  if (existing) {
    existing.lastOpenedAt = Date.now()
    await putBookMeta(existing)
    return existing
  }

  // Store the original File directly (it's a Blob); putBook writes it to OPFS without
  // allocating a second copy. makeBook likewise reads ranges from the same File.
  await putBook(id, file)

  // From here on the bytes are already persisted, so any failure must roll them back —
  // otherwise a throw (most likely `putBookMeta` hitting quota on a near-full iPad)
  // would orphan multi-MB OPFS bytes with no `books` row pointing at them: invisible to
  // the shelf and to `removeBook` (which deletes by known id), leaking against quota.
  try {
    let title = file.name.replace(/\.epub$/i, '')
    let author = ''
    let language = ''
    let dir: 'ltr' | 'rtl' = 'ltr'
    let cover: Blob | undefined

    try {
      const book: any = await makeBook(file)
      const meta = book?.metadata ?? {}
      title = flattenLangMap(meta.title) || title
      if (Array.isArray(meta.author)) {
        author = meta.author.map((a: any) => flattenLangMap(a?.name ?? a)).filter(Boolean).join('、')
      } else {
        author = flattenLangMap(meta.author)
      }
      language = (Array.isArray(meta.language) ? meta.language[0] : meta.language) ?? ''
      dir = book?.dir === 'rtl' ? 'rtl' : 'ltr'
      cover = await thumbnailCover((await book?.getCover?.()) ?? undefined)
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
