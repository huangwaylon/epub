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

export async function refreshLibrary(): Promise<void> {
  const books = await listBooks()
  const progress: Record<string, ReadingProgress | undefined> = {}
  await Promise.all(
    books.map(async (b) => {
      progress[b.id] = await getProgress(b.id)
    }),
  )
  library.books = books
  library.progress = progress
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
