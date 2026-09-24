import { JpdictIdb, updateWithRetry } from '@birchill/jpdict-idb'
import { dict } from '../../stores/dict.svelte'
import { clearLookupCache, warmupLookup } from './lookupClient'
import { IPADIC_CACHE, ipadicUrls } from './ipadic'

/**
 * Owns the single shared jpdict-idb instance and the offline-readiness of the whole
 * dictionary feature. Two independent pieces of data make tap-to-define work offline:
 *
 * 1. **JMdict** (glosses) — downloaded once from data.10ten.life into IndexedDB by
 *    jpdict-idb and updated incrementally (`downloadDictionary`).
 * 2. **IPADIC** (kuromoji's word-boundary dictionary, ~11 MB) — static files shipped with
 *    the app, written into the service worker's runtime cache (`cacheIpadic`) so the
 *    lookup worker's first fetch, even offline, is served from it.
 *
 * Public API — what the shelf / reader UI calls:
 *
 * | Call | Use |
 * | --- | --- |
 * | `getDb()` | Initialise the `dict` store's status readout (call on mount). |
 * | `isDictReady()` | Tap hot path: is JMdict usable right now? Never throws. |
 * | `downloadDictionary()` | JMdict only. Dedupes concurrent calls; transient failures retry. |
 * | `cacheIpadic()` | IPADIC only → Cache API. No trie build, no worker. |
 * | `isIpadicCached()` | Whether every IPADIC file is already cached. |
 * | `downloadAndCacheDictionary()` | Shelf "Download": JMdict + IPADIC, nothing held in memory. |
 * | `downloadAndWarmDictionary()` | Reader "Download": the above, then build kuromoji for the tap that follows. |
 * | `warmupLookup()` | (re-exported from lookupClient) build kuromoji now, e.g. on book open. |
 * | `dictPhase()` | One reactive status value for UI copy (reads the `dict` store). |
 */

export { warmupLookup }

let db: JpdictIdb | null = null
let initPromise: Promise<JpdictIdb> | null = null

/** In-flight JMdict download, shared by every caller (see `downloadDictionary`). */
let download: Promise<void> | null = null
/** True while jpdict-idb is waiting to retry a transient failure (offline / network). */
let retrying = false

function syncState(): void {
  if (!db) return
  const words = db.words
  dict.state = words.state
  const u = words.updateState
  if (u.type !== 'idle' && retrying) {
    // A queued retry has started running: it's a normal download again.
    retrying = false
    dict.error = undefined
  }
  if (u.type === 'updating') {
    dict.updating = true
    dict.progress = u.totalProgress ?? 0
  } else {
    // 'checking' is in progress too; 'idle' is only really idle when no retry is queued
    // (jpdict-idb reports idle between a failed attempt and its scheduled retry).
    dict.updating = u.type === 'checking' || retrying
  }
}

export async function getDb(): Promise<JpdictIdb> {
  if (!initPromise) {
    initPromise = (async () => {
      const d = new JpdictIdb()
      await d.ready
      d.addChangeListener(syncState)
      db = d
      syncState()
      return d
    })().catch((err) => {
      // Memoise the *success* only. A rejected init — a `versionchange` from another tab,
      // or IndexedDB refusing to open under iOS storage pressure — would otherwise be
      // cached for the rest of the session, so every later `isDictReady()` (and hence
      // every tap) would reject on that same stale promise and the popup would spin
      // forever. Clearing it lets the next call retry a transient failure.
      initPromise = null
      throw err
    })
  }
  return initPromise
}

/** True once the words series is downloaded and queryable. Never throws. */
export async function isDictReady(): Promise<boolean> {
  // Fast path: the reactive `dict.state` is kept in sync by the change listener, so
  // once the dictionary is ready every subsequent tap skips the IndexedDB round-trip
  // that `getDb()` would otherwise await on the hot lookup path.
  if (dict.state === 'ok') return true
  try {
    const d = await getDb()
    return d.words.state === 'ok'
  } catch {
    // This is awaited on the tap hot path, where a throw would leave the popup stuck in
    // its loading state. "The dictionary isn't usable" is the honest answer, and the
    // caller already handles it (it offers the download); `getDb()` will retry next tap.
    return false
  }
}

/** A failure jpdict-idb will retry on its own: offline (it waits for `online`) or a
 *  network/download error it has scheduled a backoff retry for (`nextRetry`). */
function isTransient(error: Error, nextRetry?: Date): boolean {
  return error.name === 'OfflineError' || nextRetry !== undefined
}

function retryMessage(error: Error, nextRetry?: Date): string {
  if (error.name === 'OfflineError') return 'Offline — the download will resume when you reconnect.'
  const secs = nextRetry ? Math.max(1, Math.round((nextRetry.getTime() - Date.now()) / 1000)) : 0
  return secs ? `Connection problem — retrying in ${secs}s…` : 'Connection problem — retrying…'
}

/**
 * Download (or resume / update) the JMdict data. Resolves once it is complete.
 *
 * - **Deduped:** every caller shares one in-flight download. (jpdict-idb silently ignores
 *   an overlapping `updateWithRetry` — keeping the *first* call's callbacks — so a second
 *   independent call would otherwise never settle.) Calling again while a retry is
 *   queued forces the retry to run now.
 * - **Transient failures don't reject.** Offline, or a download error jpdict-idb has
 *   scheduled a retry for, leaves the download pending with `dict.updating` still true
 *   and `dict.error` explaining the wait (`dictPhase() === 'retrying'`); the promise
 *   resolves when a retry succeeds. Only a permanent failure rejects (with `dict.error`
 *   set and `dict.updating` false).
 */
export function downloadDictionary(lang = 'en'): Promise<void> {
  if (download) {
    if (retrying && db) start(db, lang, true)
    return download
  }
  dict.error = undefined
  dict.progress = 0 // clear any stale percentage from a prior (completed/failed) run
  let resolveDl!: () => void
  let rejectDl!: (e: unknown) => void
  const p = new Promise<void>((resolve, reject) => {
    resolveDl = resolve
    rejectDl = reject
  })
  const settle = (err?: unknown) => {
    download = null
    retrying = false
    if (err === undefined) resolveDl()
    else rejectDl(err)
  }
  download = p
  getDb().then(
    (d) => start(d, lang, false, settle),
    (err) => {
      dict.error = err instanceof Error ? err.message : String(err)
      settle(err ?? new Error('Dictionary database unavailable'))
    },
  )
  return p
}

/** Callbacks of the live download, reused when a queued retry is forced. */
let callbacks: Parameters<typeof updateWithRetry>[0] | null = null

function start(d: JpdictIdb, lang: string, updateNow: boolean, settle?: (err?: unknown) => void): void {
  if (settle) {
    callbacks = {
      db: d,
      lang,
      series: 'words',
      onUpdateComplete: () => {
        // A "no match" cached while the word list was missing/partial is stale now.
        clearLookupCache()
        dict.error = undefined
        retrying = false
        syncState()
        settle()
      },
      onUpdateError: ({ error, nextRetry }) => {
        if (error.name === 'AbortError') {
          retrying = false
          dict.updating = false
          settle(error)
          return
        }
        if (isTransient(error, nextRetry)) {
          retrying = true
          dict.updating = true
          dict.error = retryMessage(error, nextRetry)
          return
        }
        retrying = false
        dict.error = error.message
        dict.updating = false
        settle(error)
      },
    }
  }
  if (!callbacks) return
  dict.updating = true
  // With `updateNow`, jpdict-idb cancels a queued backoff retry and runs it immediately
  // (while offline it keeps waiting for `online`); `syncState` clears the retry message
  // once the attempt actually starts.
  updateWithRetry({ ...callbacks, updateNow })
}

/**
 * Write every staged IPADIC file into the service worker's kuromoji runtime cache, so
 * segmentation works offline without ever having built the trie while online. Only the
 * compressed bytes are handled (streamed by the browser straight into the cache) — no
 * worker, no inflate, nothing resident afterwards. Files already cached are skipped, so
 * this is cheap to repeat. Resolves `true` when all files are cached, `false` if any
 * could not be (offline, or no Cache API — e.g. a non-secure LAN dev origin); a later
 * call fills in the rest.
 */
export async function cacheIpadic(): Promise<boolean> {
  if (typeof caches === 'undefined') return false
  try {
    const cache = await caches.open(IPADIC_CACHE)
    const results = await Promise.all(
      ipadicUrls().map(async (url) => {
        if (await cache.match(url)) return true
        try {
          await cache.add(url) // rejects on a non-2xx response, so nothing bad is stored
          return true
        } catch {
          return false
        }
      }),
    )
    return results.every(Boolean)
  } catch {
    return false
  }
}

/** Whether every IPADIC file is in the Cache API (i.e. segmentation will work offline). */
export async function isIpadicCached(): Promise<boolean> {
  if (typeof caches === 'undefined') return false
  try {
    const cache = await caches.open(IPADIC_CACHE)
    const hits = await Promise.all(ipadicUrls().map((url) => cache.match(url)))
    return hits.every(Boolean)
  } catch {
    return false
  }
}

/**
 * The shelf's "Download": JMdict, then the IPADIC files into the Cache API. Makes
 * tap-to-define fully offline-capable **without** building the kuromoji trie (no worker,
 * no ~30 MB resident) while the user is only on the shelf. `dict.warming` is true during
 * the IPADIC step (`dictPhase() === 'preparing'`).
 */
export async function downloadAndCacheDictionary(lang = 'en'): Promise<void> {
  await downloadDictionary(lang)
  dict.warming = true
  try {
    await cacheIpadic()
  } finally {
    dict.warming = false
  }
}

/**
 * The reader's "Download" (from the popup, with a word waiting to be defined): as
 * `downloadAndCacheDictionary`, then build kuromoji so the re-run lookup takes the
 * morphological path. `dict.warming` stays true until the segmenter is ready.
 */
export async function downloadAndWarmDictionary(lang = 'en'): Promise<void> {
  await downloadDictionary(lang)
  dict.warming = true
  try {
    await cacheIpadic()
    await warmupLookup()
  } finally {
    dict.warming = false
  }
}

/** One status value for UI copy. */
export type DictPhase =
  /** Store not initialised yet (`getDb()` pending). */
  | 'checking'
  /** Not installed (or a previous download failed — see `dict.error`). Offer Download. */
  | 'missing'
  /** JMdict downloading; `dict.progress` is 0..1. */
  | 'downloading'
  /** Waiting to retry a transient failure; `dict.error` says why. Don't offer Download. */
  | 'retrying'
  /** JMdict is in; the IPADIC files are being cached / kuromoji built ("Preparing…"). */
  | 'preparing'
  /** Usable. */
  | 'ready'
  /** IndexedDB couldn't be opened at all. */
  | 'unavailable'

/**
 * The dictionary's phase, derived from the reactive `dict` store — so calling it from a
 * Svelte template or `$derived` is reactive.
 */
export function dictPhase(): DictPhase {
  if (dict.updating) return dict.error ? 'retrying' : 'downloading'
  if (dict.warming) return 'preparing'
  switch (dict.state) {
    case 'ok':
      return 'ready'
    case 'init':
      return 'checking'
    case 'unavailable':
      return 'unavailable'
    default:
      return 'missing'
  }
}
