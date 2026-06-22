import type { BookMeta, ReadingProgress } from '../services/types'
import { importEpub, listBooks, removeBook, touchBook } from '../services/library'
import { getProgress } from '../services/storage/db'

/** Reactive shelf state: the list of books plus their reading progress. */
export const library = $state<{
  books: BookMeta[]
  progress: Record<string, ReadingProgress | undefined>
  loading: boolean
  importing: number // count of in-flight imports
}>({
  books: [],
  progress: {},
  loading: true,
  importing: 0,
})

/** Display-affecting fields only. Cover blobs are re-read from IDB on every refresh
 *  (so they're never identity-equal); a book's cover image never changes once
 *  imported, so comparing presence is enough to know the row is unchanged. */
function bookMetaEqual(a: BookMeta, b: BookMeta): boolean {
  return (
    a.title === b.title &&
    a.author === b.author &&
    a.lastOpenedAt === b.lastOpenedAt &&
    a.fileSize === b.fileSize &&
    a.dir === b.dir &&
    !!a.cover === !!b.cover
  )
}

function progressEqual(a: ReadingProgress | undefined, b: ReadingProgress | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.cfi === b.cfi && a.fraction === b.fraction && a.updatedAt === b.updatedAt
}

export async function refreshLibrary(): Promise<void> {
  const books = await listBooks()
  const progress: Record<string, ReadingProgress | undefined> = {}
  await Promise.all(
    books.map(async (b) => {
      progress[b.id] = await getProgress(b.id)
    }),
  )

  // Reconcile against the current list so unchanged books keep their existing
  // reactive object identity. Replacing the whole array (as before) handed every
  // BookCover a brand-new `book` proxy on each refresh — fired after every import,
  // delete, and book-open — which re-ran its objectURL effect and forced the browser
  // to re-decode every cover. Only books whose display fields actually changed get a
  // new reference; the rest (and their object URLs) are reused as-is.
  const prev = new Map(library.books.map((b) => [b.id, b]))
  library.books = books.map((b) => {
    const old = prev.get(b.id)
    return old && bookMetaEqual(old, b) ? old : b
  })

  // Update progress per key so one changed book doesn't invalidate the whole map.
  const next = library.progress
  for (const id of Object.keys(next)) if (!(id in progress)) delete next[id]
  for (const [id, p] of Object.entries(progress)) {
    if (!progressEqual(next[id], p)) next[id] = p
  }
  library.loading = false
}

export async function importFiles(files: FileList | File[]): Promise<void> {
  const list = Array.from(files).filter((f) => /\.epub$/i.test(f.name) || f.type === 'application/epub+zip')
  if (!list.length) return
  library.importing += list.length
  try {
    for (const file of list) {
      try {
        await importEpub(file)
      } catch (err) {
        console.error('Import failed for', file.name, err)
      } finally {
        library.importing -= 1
      }
    }
  } finally {
    if (library.importing < 0) library.importing = 0
    await refreshLibrary()
  }
}

export async function deleteBook(id: string): Promise<void> {
  await removeBook(id)
  await refreshLibrary()
}

export async function markOpened(id: string): Promise<void> {
  await touchBook(id)
}
