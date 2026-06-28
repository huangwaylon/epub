import { JpdictIdb, updateWithRetry, cancelUpdateWithRetry } from '@birchill/jpdict-idb'
import { dict } from '../../stores/dict.svelte'
import { warmupLookup } from './lookupClient'

/**
 * Owns the single shared jpdict-idb instance. Dictionary data (JMdict) is
 * downloaded once from data.10ten.life into IndexedDB and updated incrementally;
 * after that all lookups are fully offline.
 */

let db: JpdictIdb | null = null
let initPromise: Promise<JpdictIdb> | null = null

function syncState(): void {
  if (!db) return
  const words = db.words
  dict.state = words.state
  const u = words.updateState
  if (u.type === 'updating') {
    dict.updating = true
    dict.progress = u.totalProgress ?? 0
  } else if (u.type === 'checking') {
    dict.updating = true
  } else {
    dict.updating = false
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
    })()
  }
  return initPromise
}

/** True once the words series is downloaded and queryable. */
export async function isDictReady(): Promise<boolean> {
  // Fast path: the reactive `dict.state` is kept in sync by the change listener, so
  // once the dictionary is ready every subsequent tap skips the IndexedDB round-trip
  // that `getDb()` would otherwise await on the hot lookup path.
  if (dict.state === 'ok') return true
  const d = await getDb()
  return d.words.state === 'ok'
}

/** Kick off (or resume) the JMdict download for the given gloss language. */
export function downloadDictionary(lang = 'en'): Promise<void> {
  dict.error = undefined
  dict.progress = 0 // clear any stale percentage from a prior (completed/failed) run
  return new Promise<void>((resolve, reject) => {
    getDb()
      .then((d) => {
        dict.updating = true
        updateWithRetry({
          db: d,
          lang,
          series: 'words',
          onUpdateComplete: () => {
            syncState()
            resolve()
          },
          onUpdateError: ({ error }) => {
            dict.error = error.message
            dict.updating = false
            reject(error)
          },
        })
      })
      .catch(reject)
  })
}

/** Ensure the dictionary is present; downloads on first use. */
export async function ensureDictionary(lang = 'en'): Promise<void> {
  const d = await getDb()
  if (d.words.state === 'ok') return
  await downloadDictionary(lang)
}

/**
 * Download the JMdict data, then warm the kuromoji segmenter **while still online**
 * so the service worker runtime-caches the ~19 MB IPADIC dict — the step that makes
 * tap-to-define segmentation work offline afterwards. `dict.warming` drives the
 * "Caching…" UI until the trie is cached. Shared by the shelf settings and the
 * in-reader download prompt so this online-warm invariant lives in one place.
 */
export async function downloadAndWarmDictionary(lang = 'en'): Promise<void> {
  await downloadDictionary(lang)
  dict.warming = true
  try {
    await warmupLookup()
  } finally {
    dict.warming = false
  }
}

export async function cancelDownload(): Promise<void> {
  if (db) cancelUpdateWithRetry({ db, series: 'words' })
  dict.updating = false
}
