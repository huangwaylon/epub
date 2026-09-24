import { JpdictIdb, updateWithRetry } from '@birchill/jpdict-idb'
import { dict } from '../../stores/dict.svelte'
import { clearLookupCache, warmupLookup } from './lookupClient'
import { IPADIC_CACHE, ipadicUrls } from './ipadic'

/**
 * Owns the shared jpdict-idb instance and the dictionary's offline readiness: JMdict
 * (glosses, IndexedDB) and the IPADIC files kuromoji needs (Cache API, `cacheIpadic`).
 */

let db: JpdictIdb | null = null
let initPromise: Promise<JpdictIdb> | null = null

/** In-flight JMdict download, shared by every caller. */
let download: Promise<void> | null = null
/** jpdict-idb has a retry queued for a transient failure (offline / network). */
let retrying = false

function syncState(): void {
  if (!db) return
  const words = db.words
  dict.state = words.state
  const u = words.updateState
  if (u.type !== 'idle' && retrying) {
    retrying = false
    dict.error = undefined
  }
  if (u.type === 'updating') {
    dict.updating = true
    dict.progress = u.totalProgress ?? 0
  } else {
    // jpdict-idb reports 'idle' between a failed attempt and its scheduled retry.
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
      // Memoise success only: a failed open (iOS storage pressure, a versionchange) must
      // be retried by the next call, not cached for the session.
      initPromise = null
      throw err
    })
  }
  return initPromise
}

/** True once the words series is downloaded and queryable. Never throws. */
export async function isDictReady(): Promise<boolean> {
  // Kept in sync by the change listener; skips the IndexedDB round-trip on the tap path.
  if (dict.state === 'ok') return true
  try {
    const d = await getDb()
    return d.words.state === 'ok'
  } catch {
    // Awaited on the tap path: a throw would leave the popup stuck loading.
    return false
  }
}

/** A failure jpdict-idb retries on its own: offline (waits for `online`) or a scheduled backoff. */
function isTransient(error: Error, nextRetry?: Date): boolean {
  return error.name === 'OfflineError' || nextRetry !== undefined
}

function retryMessage(error: Error, nextRetry?: Date): string {
  if (error.name === 'OfflineError') return 'Offline — the download will resume when you reconnect.'
  const secs = nextRetry ? Math.max(1, Math.round((nextRetry.getTime() - Date.now()) / 1000)) : 0
  return secs ? `Connection problem — retrying in ${secs}s…` : 'Connection problem — retrying…'
}

/**
 * Download (or resume / update) JMdict; resolves when complete. All callers share one
 * download, because jpdict-idb ignores an overlapping `updateWithRetry` (keeping the first
 * call's callbacks). Calling again while a retry is queued runs it now. Transient failures
 * stay pending as `dictPhase() === 'retrying'`; only a permanent failure rejects.
 */
export function downloadDictionary(lang = 'en'): Promise<void> {
  if (download) {
    if (retrying && db) start(db, lang, true)
    return download
  }
  dict.error = undefined
  dict.progress = 0
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
        // A "no match" cached before the download may have an answer now.
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
  updateWithRetry({ ...callbacks, updateNow })
}

/**
 * Pre-fill the SW's IPADIC runtime cache (compressed bytes only; no worker, no trie) so
 * segmentation works offline. Skips cached files. `false` if any file failed or there is
 * no Cache API (e.g. a non-secure LAN dev origin); a later call fills in the rest.
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

async function downloadAndPrepare(lang: string, warm: boolean): Promise<void> {
  await downloadDictionary(lang)
  dict.warming = true
  try {
    await cacheIpadic()
    if (warm) await warmupLookup()
  } finally {
    dict.warming = false
  }
}

/** Shelf "Download": JMdict + IPADIC cache, without building the ~30 MB kuromoji trie. */
export function downloadAndCacheDictionary(lang = 'en'): Promise<void> {
  return downloadAndPrepare(lang, false)
}

/** Reader "Download": as above, then build kuromoji so the pending lookup is morphological. */
export function downloadAndWarmDictionary(lang = 'en'): Promise<void> {
  return downloadAndPrepare(lang, true)
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

/** Derived from the `dict` store, so it is reactive in a template / `$derived`. */
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
