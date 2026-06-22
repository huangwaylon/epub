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
const pending = new Map<number, (r: LookupResult | null) => void>()

/** Consecutive Worker *construction* failures. A single runtime worker error
 *  (e.g. an OOM-killed worker under iOS memory pressure) is NOT latched — the
 *  worker is simply recreated on the next call. Only repeated failures to even
 *  construct a Worker disable the feature, so a transient hiccup self-heals. */
let constructFailures = 0
const MAX_CONSTRUCT_FAILURES = 3

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
    worker.onmessage = (e: MessageEvent<{ id: number; result: LookupResult | null }>) => {
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

/** Eagerly spin up the worker and start building kuromoji (e.g. on book open) so the
 *  first tap-to-define hits the fast morphological path. No-op if the dictionary
 *  isn't downloaded yet (the worker's build just waits on the dict files). */
export function warmupLookup(): void {
  const w = getWorker()
  if (!w) return
  try {
    w.postMessage({ type: 'warmup' })
  } catch {
    /* worker unavailable — first tap will build kuromoji instead */
  }
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
}

export function lookupAt(text: string, tapOffset: number): Promise<LookupResult | null> {
  const w = getWorker()
  if (!w) return Promise.resolve(null)
  return new Promise<LookupResult | null>((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    try {
      w.postMessage({ type: 'lookup', id, text, tapOffset })
    } catch {
      pending.delete(id)
      resolve(null)
    }
  })
}
