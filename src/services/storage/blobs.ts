import { deleteBlobFallback, getBlobFallback, putBlobFallback } from './db'

/**
 * Stores raw EPUB bytes. Prefers the Origin Private File System (OPFS), which on
 * iOS 16.4+ gives durable, large-quota storage well suited to multi-MB files.
 * Falls back to an IndexedDB object store where OPFS (or its writable stream)
 * isn't available, so the app degrades gracefully on older engines.
 *
 * Reads always fall through to the IndexedDB store on an OPFS miss, so a book written
 * while OPFS was unavailable (older engine, a transient failure) stays readable.
 */

const BOOKS_DIR = 'books'

/**
 * Main-thread OPFS writes need `FileSystemFileHandle.createWritable` (older WebKit
 * only had sync access handles, in workers). A feature check replaces the old
 * per-session create/write/remove probe file; a write that still fails at runtime is
 * caught in `putBook` and routed to the IndexedDB fallback.
 */
function opfsSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof FileSystemFileHandle !== 'undefined' &&
    typeof FileSystemFileHandle.prototype.createWritable === 'function'
  )
}

/** The OPFS books directory, or null when unsupported / refused (e.g. SecurityError in
 *  some private modes). Not memoised: resolving it is cheap, and a handle can go stale. */
async function getBooksDir(): Promise<FileSystemDirectoryHandle | null> {
  if (!opfsSupported()) return null
  try {
    const root = await navigator.storage.getDirectory()
    return await root.getDirectoryHandle(BOOKS_DIR, { create: true })
  } catch {
    return null
  }
}

function fileName(id: string): string {
  return `${id}.epub`
}

function asEpubFile(blob: Blob, id: string): File {
  // Normalise to a .epub-named File so foliate's type sniffing is happy.
  return new File([blob], fileName(id), { type: 'application/epub+zip' })
}

function isQuotaError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'QuotaExceededError'
}

export async function putBook(id: string, data: Blob | ArrayBuffer): Promise<void> {
  const blob = data instanceof Blob ? data : new Blob([data])
  const dir = await getBooksDir()
  if (dir) {
    try {
      const fh = await dir.getFileHandle(fileName(id), { create: true })
      try {
        const w = await fh.createWritable()
        await w.write(blob)
        await w.close()
        return
      } catch (err) {
        // getFileHandle({create:true}) already created a zero-length file; a failed
        // write/close (e.g. quota) would otherwise leave that partial .epub behind —
        // invisible to the shelf yet still counting against OPFS quota. Remove it.
        await dir.removeEntry(fileName(id)).catch(() => {})
        throw err
      }
    } catch (err) {
      // Out of space is out of space — IndexedDB shares the origin quota, so don't
      // write the same bytes a second time. Anything else: try the fallback store.
      if (isQuotaError(err)) throw err
    }
  }
  await putBlobFallback(id, blob)
}

/** Returns the EPUB as a File so it can be passed straight to foliate's `view.open`. */
export async function getBookFile(id: string): Promise<File | null> {
  const dir = await getBooksDir()
  if (dir) {
    try {
      const file = await (await dir.getFileHandle(fileName(id))).getFile()
      if (file.size > 0) return asEpubFile(file, id)
    } catch {
      /* not in OPFS — try the fallback store */
    }
  }
  const blob = await getBlobFallback(id).catch(() => undefined)
  return blob ? asEpubFile(blob, id) : null
}

/** Whether the book's bytes are present (without reading them). */
export async function hasBook(id: string): Promise<boolean> {
  return (await getBookFile(id)) !== null
}

export async function deleteBook(id: string): Promise<void> {
  const dir = await getBooksDir()
  await dir?.removeEntry(fileName(id)).catch(() => {})
  // Always attempt fallback deletion too, in case it was stored before OPFS worked.
  await deleteBlobFallback(id).catch(() => {})
}
