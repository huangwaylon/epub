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
let workerBroken = false
let seq = 0
const pending = new Map<number, (r: LookupResult | null) => void>()

function getWorker(): Worker | null {
  if (workerBroken) return null
  if (!worker) {
    try {
      worker = new Worker(new URL('./lookup.worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (e: MessageEvent<{ id: number; result: LookupResult | null }>) => {
        const resolve = pending.get(e.data.id)
        if (resolve) {
          pending.delete(e.data.id)
          resolve(e.data.result ?? null)
        }
      }
      worker.onerror = () => {
        // Disable the worker and unblock anything pending (resolve null, no crash).
        workerBroken = true
        worker = null
        for (const [, resolve] of pending) resolve(null)
        pending.clear()
      }
    } catch {
      workerBroken = true
      return null
    }
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
