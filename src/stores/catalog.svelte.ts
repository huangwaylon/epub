import {
  deriveStatus,
  downloadEntry,
  downloadErrorMessage,
  fetchCatalog,
  type CatalogEntry,
  type EntryStatus,
  type Job,
} from '../services/catalog'
import { requestPersistence } from '../services/storage/persist'
import { library, refreshLibrary } from './library.svelte'
import { showToast } from './toast.svelte'

/** Bundled books and their download state. Status is derived: an entry whose id is in the
 *  library is downloaded, so deleting the book makes it available again. */
export const catalog = $state<{
  entries: CatalogEntry[]
  loaded: boolean
  /** The catalog itself failed to load (offline before the SW cached it). */
  error: string | null
  jobs: Record<string, Job>
}>({
  entries: [],
  loaded: false,
  error: null,
  jobs: {},
})

let loading: Promise<void> | null = null

/** Idempotent; a failed load can be retried by calling again. */
export function loadCatalog(fetchImpl?: typeof fetch): Promise<void> {
  loading ??= fetchCatalog(fetchImpl)
    .then((entries) => {
      catalog.entries = entries
      catalog.error = null
    })
    .catch((err) => {
      console.warn('Could not load the book catalog', err)
      catalog.error = 'Couldn’t load the included books.'
      loading = null
    })
    .finally(() => {
      catalog.loaded = true
    })
  return loading
}

function libraryIds(): Set<string> {
  return new Set(library.books.map((b) => b.id))
}

export function entryStatus(entry: CatalogEntry): EntryStatus {
  return deriveStatus(entry, libraryIds(), catalog.jobs[entry.id])
}

/** Entries not yet in the library (in catalog order). */
export function availableEntries(): CatalogEntry[] {
  const ids = libraryIds()
  return catalog.entries.filter((e) => !ids.has(e.id))
}

let persistRequested = false

/** Returns true when the book is (now) in the library. `quiet` suppresses the toasts (batch). */
export async function downloadBook(
  id: string,
  { quiet = false, fetchImpl }: { quiet?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const entry = catalog.entries.find((e) => e.id === id)
  if (!entry) return false
  const status = entryStatus(entry)
  if (status.kind === 'downloaded') return true
  if (status.kind === 'downloading') return false
  if (!persistRequested) {
    persistRequested = true
    void requestPersistence()
  }
  catalog.jobs[id] = { kind: 'downloading', progress: 0 }
  try {
    await downloadEntry(entry, {
      fetchImpl,
      onProgress: (p) => {
        const job = catalog.jobs[id]
        // Whole percents only: one reactive write per percent, not per chunk.
        if (job?.kind === 'downloading' && Math.floor(p * 100) !== Math.floor(job.progress * 100)) job.progress = p
      },
    })
    await refreshLibrary()
    delete catalog.jobs[id]
    if (!quiet) showToast({ message: `Downloaded ${entry.title}` })
    return true
  } catch (err) {
    console.error('Download failed for', entry.file, err)
    const message = downloadErrorMessage(err)
    catalog.jobs[id] = { kind: 'error', message }
    if (!quiet) showToast({ message })
    return false
  }
}

/** Sequential (one EPUB in memory at a time), last entry first so the shelf (newest first)
 *  ends up in catalog order; one summary toast. */
export async function downloadAll(opts: { fetchImpl?: typeof fetch } = {}): Promise<{ ok: number; failed: number }> {
  const todo = availableEntries()
    .filter((e) => catalog.jobs[e.id]?.kind !== 'downloading')
    .reverse()
  let ok = 0
  let failed = 0
  let lastError: string | undefined
  for (const entry of todo) {
    if (await downloadBook(entry.id, { ...opts, quiet: true })) ok++
    else {
      failed++
      const job = catalog.jobs[entry.id]
      if (job?.kind === 'error') lastError = job.message
    }
  }
  if (failed === 0) {
    if (ok) showToast({ message: ok === 1 ? 'Downloaded 1 book' : `Downloaded ${ok} books` })
  } else {
    showToast({ message: ok ? `Downloaded ${ok} of ${todo.length}. ${lastError}` : (lastError ?? 'Downloads failed.') })
  }
  return { ok, failed }
}

/** Test hook. */
export function resetCatalog(): void {
  catalog.entries = []
  catalog.loaded = false
  catalog.error = null
  catalog.jobs = {}
  loading = null
  persistRequested = false
}
