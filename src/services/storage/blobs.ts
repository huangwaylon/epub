import { deleteBlobFallback, getBlobFallback, putBlobFallback } from './db'

/**
 * Stores raw EPUB bytes. Prefers the Origin Private File System (OPFS), which on
 * iOS 16.4+ gives durable, large-quota storage well suited to multi-MB files.
 * Falls back to an IndexedDB object store where OPFS (or its writable stream)
 * isn't available, so the app degrades gracefully on older engines.
 */

const BOOKS_DIR = 'books'

async function getBooksDir(): Promise<FileSystemDirectoryHandle | null> {
  if (!('storage' in navigator) || !navigator.storage?.getDirectory) return null
  try {
    const root = await navigator.storage.getDirectory()
    return await root.getDirectoryHandle(BOOKS_DIR, { create: true })
  } catch {
    return null
  }
}

/**
 * Detect once whether we can both create and write OPFS files in this engine.
 * Memoised as a single in-flight promise so concurrent callers share one probe
 * (rather than racing the boolean and one of them observing a stale result).
 */
let opfsProbe: Promise<boolean> | undefined
function canUseOpfs(): Promise<boolean> {
  return (opfsProbe ??= (async () => {
    const dir = await getBooksDir()
    if (!dir) return false
    try {
      const probe = await dir.getFileHandle('.probe', { create: true })
      if (typeof (probe as any).createWritable !== 'function') return false
      const w = await probe.createWritable()
      await w.write(new Blob([new Uint8Array([1])]))
      await w.close()
      return true
    } catch {
      return false
    } finally {
      // Remove the probe on every exit (success, no-createWritable, or throw) so we
      // never orphan a stray 1-byte file in OPFS.
      await dir.removeEntry('.probe').catch(() => {})
    }
  })())
}

function fileName(id: string): string {
  return `${id}.epub`
}

export async function putBook(id: string, data: Blob | ArrayBuffer): Promise<void> {
  const blob = data instanceof Blob ? data : new Blob([data])
  const dir = (await canUseOpfs()) ? await getBooksDir() : null
  if (!dir) {
    // OPFS unavailable, or its directory handle went away (revoked/transient).
    await putBlobFallback(id, blob)
    return
  }
  const fh = await dir.getFileHandle(fileName(id), { create: true })
  try {
    const w = await fh.createWritable()
    await w.write(blob)
    await w.close()
  } catch (err) {
    // getFileHandle({create:true}) already created a zero-length file; a failed
    // write/close (e.g. quota) would otherwise leave that partial .epub behind —
    // invisible to the shelf yet still counting against OPFS quota. Remove it.
    await dir.removeEntry(fileName(id)).catch(() => {})
    throw err
  }
}

/** Returns the EPUB as a File so it can be passed straight to foliate's `view.open`. */
export async function getBookFile(id: string): Promise<File | null> {
  if (await canUseOpfs()) {
    try {
      const dir = await getBooksDir()
      const fh = await dir!.getFileHandle(fileName(id))
      const file = await fh.getFile()
      // Normalise to a .epub-named File so foliate's type sniffing is happy.
      return new File([file], fileName(id), { type: 'application/epub+zip' })
    } catch {
      return null
    }
  }
  const blob = await getBlobFallback(id)
  return blob ? new File([blob], fileName(id), { type: 'application/epub+zip' }) : null
}

export async function deleteBook(id: string): Promise<void> {
  if (await canUseOpfs()) {
    const dir = await getBooksDir()
    await dir?.removeEntry(fileName(id)).catch(() => {})
  }
  // Always attempt fallback deletion too, in case it was stored before OPFS worked.
  await deleteBlobFallback(id).catch(() => {})
}
