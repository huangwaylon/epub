/**
 * Main-thread client for the dictionary lookup worker (`lookup.worker.ts`). Owns the
 * Worker, correlates request/response by id, and exposes the same `lookupAt` shape
 * the reader already used — so moving the heavy pipeline off-thread is transparent to
 * callers. The worker is created lazily on first use (or `warmupLookup`), keeping
 * kuromoji and jpdict-idb out of the startup bundle entirely.
 *
 * The whole lookup engine lives only in the worker bundle — there is no main-thread
 * fallback copy, which would otherwise duplicate kuromoji + jpdict-idb + the
 * deinflection table in the install precache. Module workers are universally available
 * on the target (iOS 26+ Safari); in the unreachable case where the Worker can't be
 * constructed, lookups resolve to `null` (the popup shows no result) rather than
 * crashing, and the rest of the reader is unaffected.
 *
 * The worker is disposable — the reader sheds it after 60 s in the background and on
 * exit, and iOS may kill it under memory pressure — so two things live here instead:
 * `RESULT_CACHE`, so recent answers outlive it, and `pingLookup()`, so the reader can
 * detect (and replace) a worker that died without telling anyone.
 *
 * Public API: `lookupAt`, `warmupLookup`, `pingLookup`, `disposeLookup`.
 */
import type { LookupResult } from './lookupTypes'

export type { Sense, DictEntry, LookupResult } from './lookupTypes'

/** A worker reply: `{ id, result, ready? }` (see lookup.worker.ts). */
interface Reply {
  result: unknown
  ready?: boolean
}

let worker: Worker | null = null
let seq = 0
/** Resolvers for in-flight requests, keyed by id. `null` ⇒ the worker went away. */
const pending = new Map<number, (reply: Reply | null) => void>()

/** Lookup results the worker produced with kuromoji **ready** — i.e. from the accurate
 *  morphological path — cached here on the main thread so they survive `disposeLookup()`
 *  and a worker crash. A re-tap of a recently-defined word answers instantly, without
 *  even constructing a worker, let alone waiting on a kuromoji rebuild that would
 *  otherwise push the tap onto the greedy fallback.
 *
 *  Only ready-derived results are stored (the worker tags each reply with the readiness
 *  captured when it chose its path), which is what makes this safe: a greedy fallback
 *  result can never be served in place of a morphological one. This is the only result
 *  cache in the pipeline. */
const RESULT_CACHE = new Map<string, LookupResult | null>()
const RESULT_CACHE_MAX = 200

function cacheKey(text: string, tapOffset: number): string {
  return `${tapOffset} ${text}`
}

function cacheGet(key: string): LookupResult | null | undefined {
  if (!RESULT_CACHE.has(key)) return undefined
  const v = RESULT_CACHE.get(key)
  RESULT_CACHE.delete(key) // re-insert to mark most-recently-used
  RESULT_CACHE.set(key, v!)
  return v
}

/** Drop every cached result — called when the dictionary data changes (a finished
 *  download), since a "no match" cached before it may now have an answer. */
export function clearLookupCache(): void {
  RESULT_CACHE.clear()
}

function cacheSet(key: string, value: LookupResult | null): void {
  RESULT_CACHE.set(key, value)
  if (RESULT_CACHE.size > RESULT_CACHE_MAX) RESULT_CACHE.delete(RESULT_CACHE.keys().next().value!)
}

/** Consecutive Worker *construction* failures. A single runtime worker error
 *  (e.g. an OOM-killed worker under iOS memory pressure) is NOT latched — the
 *  worker is simply recreated on the next call. Only repeated failures to even
 *  construct a Worker disable the feature, so a transient hiccup self-heals. */
let constructFailures = 0
const MAX_CONSTRUCT_FAILURES = 3

/** A tap-to-define round-trip (kuromoji segmentation + jpdict-idb lookup) is sub-100ms
 *  warm; this generous ceiling only fires when the worker is effectively gone, never on
 *  a slow-but-alive lookup. */
const LOOKUP_TIMEOUT_MS = 8000

/** The kuromoji build fetches ~11 MB of dict (from the Cache API once `cacheIpadic` has
 *  run, else the network) and parses it. The ceiling exists only so a *dead* worker
 *  (OOM-killed mid-build without firing `onerror` — the documented iOS failure mode)
 *  can't hang the warmup promise, and whatever UI awaits it, forever. */
const WARMUP_TIMEOUT_MS = 30000

/** Default `pingLookup` ceiling. The worker answers a ping as soon as its event loop is
 *  free; even mid-build its work is broken into async steps (fetch, native inflate, a
 *  ~tens-of-ms parse), so a live worker answers well inside this. */
const PING_TIMEOUT_MS = 2000

/** Drop the current worker, failing anything in flight (resolve null, no crash). */
function dropWorker(): void {
  const w = worker
  worker = null
  try {
    w?.terminate()
  } catch {
    /* ignore */
  }
  const waiting = [...pending.values()]
  pending.clear()
  for (const resolve of waiting) resolve(null)
}

function getWorker(): Worker | null {
  if (worker) return worker
  if (constructFailures >= MAX_CONSTRUCT_FAILURES) return null
  try {
    worker = new Worker(new URL('./lookup.worker.ts', import.meta.url), { type: 'module' })
    constructFailures = 0
    worker.onmessage = (e: MessageEvent<{ id: number } & Reply>) => {
      const resolve = pending.get(e.data.id)
      if (resolve) {
        pending.delete(e.data.id)
        resolve(e.data)
      }
    }
    // A runtime error kills this worker instance but is recoverable: drop it (so the
    // next call lazily builds a fresh one) instead of disabling tap-to-define for the
    // whole session.
    worker.onerror = () => dropWorker()
  } catch {
    constructFailures++
    worker = null
    return null
  }
  return worker
}

/**
 * Post one request and resolve with its reply — or `null` if it can't be sent, the
 * worker dies, or no reply arrives within `timeoutMs`. iOS can reclaim a
 * backgrounded/under-pressure worker *without* firing `onerror`; the request would then
 * never get a reply, so every request is time-boxed, and a timeout drops the (presumed
 * dead) worker so the next call builds a fresh one.
 */
function request(w: Worker, msg: Record<string, unknown>, timeoutMs: number): Promise<Reply | null> {
  return new Promise<Reply | null>((resolve) => {
    const id = ++seq
    const timer = setTimeout(() => {
      if (pending.delete(id)) {
        dropWorker()
        resolve(null)
      }
    }, timeoutMs)
    pending.set(id, (reply) => {
      clearTimeout(timer)
      resolve(reply)
    })
    try {
      w.postMessage({ ...msg, id })
    } catch {
      pending.delete(id)
      clearTimeout(timer)
      resolve(null)
    }
  })
}

/** Eagerly spin up the worker, build kuromoji and open its IndexedDB connection (e.g. on
 *  book open, or right after the dictionary download) so the first tap-to-define hits
 *  the fast morphological path. Resolves `true` once the build completes, `false` if the
 *  worker is unavailable or the build failed. A plain perf warm can ignore the result. */
export async function warmupLookup(): Promise<boolean> {
  const w = getWorker()
  if (!w) return false
  const reply = await request(w, { type: 'warmup' }, WARMUP_TIMEOUT_MS)
  return reply?.result === true
}

/**
 * Cheap liveness probe for the reader to call on resume. Resolves `true` if a worker
 * exists and answered within `timeoutMs`. Resolves `false` if there is no worker (it was
 * shed or never built) **or** it failed to answer — in which case it has been dropped, so
 * the next `lookupAt`/`warmupLookup` builds a fresh one. Never constructs a worker itself.
 *
 * Typical use: `if (!(await pingLookup())) void warmupLookup()`.
 */
export async function pingLookup(timeoutMs = PING_TIMEOUT_MS): Promise<boolean> {
  const w = worker
  if (!w) return false
  const reply = await request(w, { type: 'ping' }, timeoutMs)
  return reply?.result === true
}

/**
 * Tear down the lookup worker (and the ~30 MB resident kuromoji dictionary it holds),
 * failing any in-flight lookups. Called when the reader unmounts, and after a sustained
 * backgrounding, so that memory isn't pinned while it isn't needed — important on a
 * memory-constrained iPad PWA. The worker is rebuilt lazily from the cached dict, with
 * no network.
 *
 * `RESULT_CACHE` deliberately survives this: it is plain data, not the trie, and it is
 * exactly what makes the first taps after a foreground fast and correct while the worker
 * rebuilds.
 */
export function disposeLookup(): void {
  dropWorker()
  constructFailures = 0
}

/** Look up the word covering `text[tapOffset]`. Resolves `null` for no match, and also
 *  (rather than throwing) when the worker is unavailable or unresponsive. */
export async function lookupAt(text: string, tapOffset: number): Promise<LookupResult | null> {
  const key = cacheKey(text, tapOffset)
  const cached = cacheGet(key)
  if (cached !== undefined) return cached
  const w = getWorker()
  if (!w) return null
  const reply = await request(w, { type: 'lookup', text, tapOffset }, LOOKUP_TIMEOUT_MS)
  if (!reply) return null
  const result = (reply.result as LookupResult | null) ?? null
  // Cache only what the morphological path produced (including a definitive "no
  // match"); a greedy-fallback answer is provisional and must be recomputed once the
  // segmenter is up.
  if (reply.ready === true) cacheSet(key, result)
  return result
}
