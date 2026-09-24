import { deleteBlobFallback, getBlobFallback, putBlobFallback } from './db'

/**
 * Raw EPUB bytes: OPFS (`books/<id>.epub`), with an IndexedDB fallback store. Reads fall
 * through to IndexedDB on an OPFS miss, so bytes written while OPFS failed stay readable.
 */

const BOOKS_DIR = 'books'

/** Main-thread OPFS writes need `createWritable` (older WebKit only had worker-side sync
 *  access handles). Runtime write failures still fall back in `putBook`. */
function opfsSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof FileSystemFileHandle !== 'undefined' &&
    typeof FileSystemFileHandle.prototype.createWritable === 'function'
  )
}

/** Null when unsupported or refused (SecurityError in some private modes). Not memoised:
 *  cheap, and a handle can go stale. */
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
  // foliate sniffs the type from the name / MIME.
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
        // Don't leave the (partial) file created above counting against quota.
        await dir.removeEntry(fileName(id)).catch(() => {})
        throw err
      }
    } catch (err) {
      // IndexedDB shares the origin quota, so a quota error won't succeed there either.
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

/** Whether the book's bytes are present. */
export async function hasBook(id: string): Promise<boolean> {
  return (await getBookFile(id)) !== null
}

export async function deleteBook(id: string): Promise<void> {
  const dir = await getBooksDir()
  await dir?.removeEntry(fileName(id)).catch(() => {})
  await deleteBlobFallback(id).catch(() => {})
}
