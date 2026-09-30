import {
  bookSlug,
  deriveStatus,
  downloadEntry,
  downloadErrorMessage,
  fetchCatalog,
  type CatalogEntry,
  type EntryStatus,
  type Job,
} from '../services/catalog'
import { supersedeBook } from '../services/library'
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

/** Library books that came from the catalog, by slug. */
function librarySlugs(): Map<string, string> {
  const slugs = new Set(catalog.entries.map((e) => e.slug))
  const out = new Map<string, string>()
  for (const b of library.books) {
    const slug = bookSlug(b, slugs)
    if (slug) out.set(slug, b.id)
  }
  return out
}

/** Library id of an older build of `entry`, if the user has one. */
function outdatedCopy(entry: CatalogEntry): string | undefined {
  const id = librarySlugs().get(entry.slug)
  return id && id !== entry.id ? id : undefined
}

export function entryStatus(entry: CatalogEntry): EntryStatus {
  return deriveStatus(entry, libraryIds(), catalog.jobs[entry.id], !!outdatedCopy(entry))
}

/** Entries not yet in the library (in catalog order). */
export function availableEntries(): CatalogEntry[] {
  const ids = libraryIds()
  return catalog.entries.filter((e) => !ids.has(e.id))
}

let persistRequested = false

const inflight = new Map<string, Promise<boolean>>()

/** Returns true when the book is (now) in the library. `quiet` suppresses the toasts (batch).
 *  A second call for a book already downloading joins that download. */
export function downloadBook(
  id: string,
  opts: { quiet?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const entry = catalog.entries.find((e) => e.id === id)
  if (!entry) return Promise.resolve(false)
  if (libraryIds().has(id)) return Promise.resolve(true)
  let job = inflight.get(id)
  if (!job) {
    job = runDownload(entry, opts).finally(() => inflight.delete(id))
    inflight.set(id, job)
  }
  return job
}

async function runDownload(
  entry: CatalogEntry,
  { quiet = false, fetchImpl }: { quiet?: boolean; fetchImpl?: typeof fetch },
): Promise<boolean> {
  if (!persistRequested) {
    persistRequested = true
    void requestPersistence()
  }
  const id = entry.id
  catalog.jobs[id] = { kind: 'downloading', progress: 0 }
  const onProgress = (p: number) => {
    const job = catalog.jobs[id]
    // Whole percents only: one reactive write per percent, not per chunk.
    if (job?.kind === 'downloading' && Math.floor(p * 100) !== Math.floor(job.progress * 100)) job.progress = p
  }
  try {
    let book
    try {
      book = await downloadEntry(entry, { fetchImpl, onProgress })
    } catch (err) {
      // This app build's catalog predates the deployed EPUB: retry once against the live one.
      if ((err as Error)?.name !== 'ChecksumError') throw err
      const live = (await fetchCatalog(fetchImpl, { fresh: true }).catch(() => [])).find((e) => e.slug === entry.slug)
      if (!live || live.id === entry.id) throw err
      book = await downloadEntry(live, { fetchImpl, onProgress })
      catalog.entries = catalog.entries.map((e) => (e.slug === live.slug ? live : e))
    }
    const older = outdatedCopy({ ...entry, id: book.id })
    if (older) await supersedeBook(older, book.id)
    await refreshLibrary()
    delete catalog.jobs[id]
    if (!quiet) showToast({ message: `${older ? 'Updated' : 'Downloaded'} ${entry.title}` })
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
    const why = lastError ?? 'Some downloads failed.'
    showToast({ message: ok ? `Downloaded ${ok} of ${todo.length}. ${why}` : why })
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
  inflight.clear()
}
