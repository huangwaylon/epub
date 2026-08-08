/**
 * Main-thread client for the dictionary lookup worker (`lookup.worker.ts`). Owns the
 * Worker, correlates request/response by id, and exposes the same `lookupAt` shape
 * the reader already used — so moving the heavy pipeline off-thread is transparent to
 * callers. The worker is created lazily on first use (or `warmupLookup`), keeping the
 * ~19 MB kuromoji engine and jpdict-idb out of the startup bundle entirely.
 *
 * The whole lookup engine lives only in the worker bundle — there is no main-thread
 * fallback copy, which would otherwise duplicate kuromoji + jpdict-idb + the
 * deinflection table in the install precache. Module workers are universally available
 * on the target (iOS 26+ Safari); in the unreachable case where the Worker can't be
 * constructed, lookups resolve to `null` (the popup shows no result) rather than
 * crashing, and the rest of the reader is unaffected.
 *
 * Two things live here rather than in the worker precisely *because* the worker is
 * disposable (it is shed on every backgrounding): `RESULT_CACHE`, so recent answers
 * outlive it, and `lookupReady()`, so the UI can tell a still-loading segmenter from a
 * genuine no-match.
 */
import type { LookupResult } from './lookupTypes'

export type { Sense, DictEntry, LookupResult } from './lookupTypes'

let worker: Worker | null = null
let seq = 0
// Resolvers for in-flight requests, keyed by id. Lookups resolve with a LookupResult
// (or null); warmup and the readiness probe resolve with a boolean — all flow back
// through the worker's `{ id, result }` message, so a single map serves them. The
// optional second argument carries the reply's `ready` flag (see `RESULT_CACHE`).
const pending = new Map<number, (r: any, ready?: boolean) => void>()

/** Lookup results the worker produced with kuromoji **ready** — i.e. from the accurate
 *  morphological path — cached here on the main thread so they survive `disposeLookup()`.
 *
 *  `lookup.ts` has its own (larger) LRU, but it lives *inside* the worker and the worker
 *  is shed on every backgrounding, so on iOS that cache is destroyed constantly. Keeping
 *  a copy out here means a re-tap of a recently-defined word answers instantly — without
 *  even constructing a worker, let alone waiting on the kuromoji rebuild that would
 *  otherwise push the tap onto the greedy fallback.
 *
 *  Only ready-derived results are stored, which is what makes this safe: a greedy
 *  fallback result can never be served in place of a morphological one, so this cache
 *  needs no equivalent of the worker LRU's readiness bit. Smaller than the worker's LRU
 *  (200) because it is never torn down and holds main-thread memory for the session. */
const RESULT_CACHE = new Map<string, LookupResult | null>()
const RESULT_CACHE_MAX = 100

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
 *  warm; this generous ceiling only fires when the worker is effectively gone (see
 *  `lookupAt`), never on a slow-but-alive lookup. */
const LOOKUP_TIMEOUT_MS = 8000

/** The cold kuromoji trie build reads the ~19 MB IPADIC dict and can run several
 *  seconds over a slow network on first download, so it gets a far more generous ceiling
 *  than a lookup. It exists only so a *dead* worker (OOM-killed mid-build without firing
 *  `onerror` — the documented iOS failure mode) can't hang the warmup promise forever:
 *  that would pin the dictionary-download "Caching…" UI and leave a dead worker that
 *  never self-heals (no later `lookupAt` timeout would fire if nothing taps). */
const WARMUP_TIMEOUT_MS = 30000

/** The readiness probe is answered synchronously by the worker, so any real delay means
 *  the worker is either mid-trie-build (CPU-bound, so it can't drain its message queue)
 *  or gone. Either way the honest answer is "not ready", and short — a caller is asking
 *  in order to update UI. */
const READY_TIMEOUT_MS = 2000

/** Drop the current worker, failing anything in flight (resolve null, no crash). */
function dropWorker(): void {
  const w = worker
  worker = null
  try {
    w?.terminate()
  } catch {
    /* ignore */
  }
  for (const [, resolve] of pending) resolve(null)
  pending.clear()
}

function getWorker(): Worker | null {
  if (worker) return worker
  if (constructFailures >= MAX_CONSTRUCT_FAILURES) return null
  try {
    worker = new Worker(new URL('./lookup.worker.ts', import.meta.url), { type: 'module' })
    constructFailures = 0
    worker.onmessage = (e: MessageEvent<{ id: number; result: LookupResult | boolean | null; ready?: boolean }>) => {
      const resolve = pending.get(e.data.id)
      if (resolve) {
        pending.delete(e.data.id)
        resolve(e.data.result ?? null, e.data.ready)
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

/** Eagerly spin up the worker and build kuromoji (e.g. on book open, or right after the
 *  dictionary download) so the first tap-to-define hits the fast morphological path — and
 *  so the ~19 MB IPADIC dict is fetched and SW-runtime-cached *while still online*.
 *  Resolves `true` once the build (and thus the dict fetch) completes, `false` if the
 *  worker is unavailable or the build failed. Callers that report an "offline-ready"
 *  state should `await` this; a plain perf warm can ignore the result. */
export function warmupLookup(): Promise<boolean> {
  const w = getWorker()
  if (!w) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const id = ++seq
    // iOS can reclaim a backgrounded/under-pressure worker *without* firing `onerror` —
    // and the trie build is the longest, most memory-hungry op, so the likeliest to be
    // OOM-killed. Without a guard the warmup promise (and its `await`ers — the "Caching…"
    // state) would hang and the dead worker would never be replaced. Bail to false and
    // drop the worker so the next call rebuilds a fresh one, mirroring `lookupAt`.
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      if (pending.delete(id)) {
        dropWorker()
        resolve(false)
      }
    }, WARMUP_TIMEOUT_MS)
    const settle = (r: any) => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      resolve(r === true)
    }
    pending.set(id, settle)
    try {
      w.postMessage({ type: 'warmup', id })
    } catch {
      pending.delete(id)
      settle(false)
    }
  })
}

/**
 * Whether the worker's kuromoji segmenter is built, i.e. whether a lookup right now
 * resolves word boundaries morphologically or falls back to greedy leftmost-covering.
 * Lets the UI distinguish "segmentation is still loading, this answer may improve" from
 * "there is genuinely no dictionary match".
 *
 * Purely a status query: it never *constructs* a worker (no worker ⇒ `false`) and, unlike
 * `lookupAt`, a timeout here does not drop the worker — a slow reply most likely means the
 * worker is busy in the middle of the very trie build we're asking about.
 */
export function lookupReady(): Promise<boolean> {
  const w = worker
  if (!w) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const id = ++seq
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      if (pending.delete(id)) resolve(false)
    }, READY_TIMEOUT_MS)
    const settle = (r: any) => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      resolve(r === true)
    }
    pending.set(id, settle)
    try {
      w.postMessage({ type: 'ready', id })
    } catch {
      pending.delete(id)
      settle(false)
    }
  })
}

/**
 * Tear down the lookup worker (and the ~tens-of-MB resident kuromoji trie it holds),
 * failing any in-flight lookups. Called when the reader unmounts so that memory isn't
 * pinned while no book is open — important on a memory-constrained iPad PWA. The worker
 * is rebuilt lazily (and re-warmed via `warmupLookup`) from the SW-cached dict on the
 * next book open, with no network.
 *
 * `RESULT_CACHE` deliberately survives this: it is a few hundred KB of plain data, not
 * the trie, and it is exactly what makes the first taps after a foreground fast and
 * correct while the worker rebuilds.
 */
export function disposeLookup(): void {
  dropWorker()
  constructFailures = 0
  seq = 0
}

export function lookupAt(text: string, tapOffset: number): Promise<LookupResult | null> {
  const key = cacheKey(text, tapOffset)
  const cached = cacheGet(key)
  if (cached !== undefined) return Promise.resolve(cached)
  const w = getWorker()
  if (!w) return Promise.resolve(null)
  return new Promise<LookupResult | null>((resolve) => {
    const id = ++seq
    // iOS can reclaim a backgrounded/under-pressure worker *without* firing `onerror`;
    // the request would then never get a reply and this promise would hang, leaving the
    // popup spinning forever and the resolver pinned in `pending`. Guard every lookup
    // with a timeout that bails to null and drops the (presumed dead) worker, so the
    // next tap lazily rebuilds a fresh one.
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      if (pending.delete(id)) {
        dropWorker()
        resolve(null)
      }
    }, LOOKUP_TIMEOUT_MS)
    const settle = (r: LookupResult | null, ready?: boolean) => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      // Cache only what the morphological path produced (including a definitive "no
      // match"); a greedy-fallback answer is provisional and must be recomputed once
      // the segmenter is up.
      if (ready) cacheSet(key, r)
      resolve(r)
    }
    pending.set(id, settle)
    try {
      w.postMessage({ type: 'lookup', id, text, tapOffset })
    } catch {
      pending.delete(id)
      settle(null)
    }
  })
}
