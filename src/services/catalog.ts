/**
 * Bundled books: `public/books/catalog.json` (written by `npm run books:build`) lists EPUBs
 * shipped with the app. Nothing is imported until the user downloads a book; the EPUB then
 * goes through `importEpub` like a user import (OPFS, deduped by hash). `id` is the EPUB's
 * SHA-256, which is also its library id, so "downloaded" = "the library has this id".
 */
import { importEpub, type KnownMeta } from './library'
import type { BookMeta } from './types'

export interface CatalogEntry {
  slug: string
  /** SHA-256 hex of the EPUB = the library book id. */
  id: string
  title: string
  author: string
  language?: string
  dir?: 'ltr' | 'rtl'
  /** File names relative to `books/`. */
  file: string
  size: number
  cover?: string
  translation?: { lang: string; coverage: number }
}

export type EntryStatus =
  | { kind: 'available' }
  | { kind: 'downloading'; progress: number }
  | { kind: 'downloaded' }
  | { kind: 'error'; message: string }

/** In-flight or failed download state, keyed by entry id (the store keeps these). */
export type Job = { kind: 'downloading'; progress: number } | { kind: 'error'; message: string }

/** Being in the library wins over any stale job; otherwise the job, else available. */
export function deriveStatus(entry: CatalogEntry, libraryIds: ReadonlySet<string>, job?: Job): EntryStatus {
  if (libraryIds.has(entry.id)) return { kind: 'downloaded' }
  return job ?? { kind: 'available' }
}

export function bookUrl(path: string): string {
  return `${import.meta.env.BASE_URL}books/${path}`
}

function isEntry(x: unknown): x is CatalogEntry {
  const e = x as CatalogEntry
  return (
    !!e &&
    typeof e.id === 'string' &&
    /^[0-9a-f]{64}$/.test(e.id) &&
    typeof e.file === 'string' &&
    typeof e.title === 'string' &&
    typeof e.size === 'number'
  )
}

/** The precached catalog (served by the service worker offline). Malformed entries are dropped. */
export async function fetchCatalog(fetchImpl: typeof fetch = fetch): Promise<CatalogEntry[]> {
  const res = await fetchImpl(bookUrl('catalog.json'))
  if (!res.ok) throw new Error(`catalog.json: HTTP ${res.status}`)
  const data: unknown = await res.json()
  if (!Array.isArray(data)) throw new Error('catalog.json is not a list')
  return data.filter(isEntry)
}

/** Read a response body, reporting progress 0–1 against Content-Length (else `fallbackTotal`). */
export async function readWithProgress(
  res: Response,
  fallbackTotal: number,
  onProgress?: (fraction: number) => void,
): Promise<Blob> {
  // Content-Length is the encoded size; with Content-Encoding it can't measure decoded bytes.
  const header = res.headers.get('content-encoding') ? null : res.headers.get('content-length')
  const total = Number(header) > 0 ? Number(header) : fallbackTotal
  if (!res.body || !onProgress) return res.blob()
  const reader = res.body.getReader()
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let received = 0
  onProgress(0)
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.byteLength
    if (total > 0) onProgress(Math.min(1, received / total))
  }
  onProgress(1)
  return new Blob(chunks)
}

/** Friendly message for a failed download; the offline case is the common one on a phone. */
export function downloadErrorMessage(err: unknown, online = typeof navigator === 'undefined' || navigator.onLine !== false): string {
  if (!online || err instanceof TypeError) return 'You’re offline. Connect to download books.'
  if ((err as Error)?.name === 'ChecksumError') return 'The download was corrupted. Try again.'
  if ((err as Error)?.name === 'QuotaExceededError') return 'Not enough storage for this book.'
  return 'Couldn’t download the book. Try again.'
}

export interface DownloadOptions {
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

/** Fetch → verify SHA-256 = entry.id → import. Metadata comes from the catalog, so foliate
 *  isn't loaded. The cover is best-effort (usually served from the precache). */
export async function downloadEntry(entry: CatalogEntry, opts: DownloadOptions = {}): Promise<BookMeta> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const coverP = entry.cover
    ? fetchImpl(bookUrl(entry.cover), { signal: opts.signal })
        .then((r) => (r.ok ? r.blob() : undefined))
        .catch(() => undefined)
    : Promise.resolve(undefined)
  const res = await fetchImpl(bookUrl(entry.file), { signal: opts.signal })
  if (!res.ok) throw new Error(`${entry.file}: HTTP ${res.status}`)
  const bytes = await readWithProgress(res, entry.size, opts.onProgress)
  const meta: KnownMeta = {
    title: entry.title,
    author: entry.author ?? '',
    language: entry.language ?? 'ja',
    dir: entry.dir === 'ltr' ? 'ltr' : 'rtl',
    cover: await coverP,
  }
  const file = new File([bytes], entry.file, { type: 'application/epub+zip' })
  return importEpub(file, { expectedId: entry.id, meta })
}
