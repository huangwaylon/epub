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
 */
import type { LookupResult } from './lookupTypes'

export type { Sense, DictEntry, LookupResult } from './lookupTypes'

let worker: Worker | null = null
let seq = 0
// Resolvers for in-flight requests, keyed by id. Lookups resolve with a LookupResult
// (or null); warmup resolves with a boolean "ready" flag — both flow back through the
// worker's `{ id, result }` message, so a single map serves both.
const pending = new Map<number, (r: any) => void>()

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
    worker.onmessage = (e: MessageEvent<{ id: number; result: LookupResult | boolean | null }>) => {
      const resolve = pending.get(e.data.id)
      if (resolve) {
        pending.delete(e.data.id)
        resolve(e.data.result ?? null)
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
    pending.set(id, (r) => resolve(r === true))
    try {
      w.postMessage({ type: 'warmup', id })
    } catch {
      pending.delete(id)
      resolve(false)
    }
  })
}

/**
 * Tear down the lookup worker (and the ~tens-of-MB resident kuromoji trie it holds),
 * failing any in-flight lookups. Called when the reader unmounts so that memory isn't
 * pinned while no book is open — important on a memory-constrained iPad PWA. The worker
 * is rebuilt lazily (and re-warmed via `warmupLookup`) from the SW-cached dict on the
 * next book open, with no network.
 */
export function disposeLookup(): void {
  dropWorker()
  constructFailures = 0
  seq = 0
}

export function lookupAt(text: string, tapOffset: number): Promise<LookupResult | null> {
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
    const settle = (r: LookupResult | null) => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
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
