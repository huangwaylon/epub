import type { BookMeta, ReadingProgress } from '../services/types'
import { importEpub, listBooks, removeBook, touchBook } from '../services/library'
import { getAllProgress } from '../services/storage/db'

/** Reactive shelf state: the list of books plus their reading progress. */
export const library = $state<{
  books: BookMeta[]
  progress: Record<string, ReadingProgress | undefined>
  loading: boolean
  /** In-flight imports. */
  importing: number
  /** Shown on the shelf: a standalone iOS PWA has no visible console. */
  importError: string | null
}>({
  books: [],
  progress: {},
  loading: true,
  importing: 0,
  importError: null,
})

/** Display fields only. Cover blobs are re-read (never identity-equal) but never change
 *  after import, so presence is enough. */
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

/** Lets a slow refresh drop its stale snapshot instead of overwriting a newer one. */
let refreshGen = 0

export async function refreshLibrary(): Promise<void> {
  const gen = ++refreshGen
  const [books, all] = await Promise.all([listBooks(), getAllProgress()])
  if (gen !== refreshGen) return
  const progress: Record<string, ReadingProgress | undefined> = {}
  const ids = new Set(books.map((b) => b.id))
  for (const p of all) if (ids.has(p.bookId)) progress[p.bookId] = p
  for (const id of ids) if (!(id in progress)) progress[id] = undefined

  // Keep unchanged books' object identity so BookCover doesn't re-create object URLs
  // (and re-decode every cover) on each refresh.
  const prev = new Map(library.books.map((b) => [b.id, b]))
  library.books = books.map((b) => {
    const old = prev.get(b.id)
    return old && bookMetaEqual(old, b) ? old : b
  })

  // Per key, so one changed book doesn't invalidate the whole map.
  const next = library.progress
  for (const id of Object.keys(next)) if (!(id in progress)) delete next[id]
  for (const [id, p] of Object.entries(progress)) {
    if (!progressEqual(next[id], p)) next[id] = p
  }
  library.loading = false
}

export async function importFiles(files: FileList | File[]): Promise<void> {
  const list = Array.from(files).filter((f) => /\.epub$/i.test(f.name) || f.type === 'application/epub+zip')
  if (!list.length) {
    if (Array.from(files).length) library.importError = 'That file isn’t an EPUB.'
    return
  }
  library.importError = null
  library.importing += list.length
  let failures = 0
  try {
    for (const file of list) {
      try {
        await importEpub(file)
        if (list.length > 1) refreshLibrary().catch(() => {})
      } catch (err) {
        failures += 1
        console.error('Import failed for', file.name, err)
      } finally {
        library.importing -= 1
      }
    }
  } finally {
    if (library.importing < 0) library.importing = 0
    if (failures > 0) {
      library.importError =
        failures === list.length
          ? `Couldn’t import ${failures === 1 ? 'the book' : `${failures} books`} — the file may be corrupt or storage is full.`
          : `Couldn’t import ${failures} of ${list.length} books.`
    }
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
