/**
 * Main-thread client for `lookup.worker.ts`: a lazy, disposable worker (shed by the reader
 * after 60 s backgrounded and on exit; iOS may kill it silently) plus the result cache
 * that outlives it. There is no main-thread fallback engine; without a worker lookups
 * resolve `null`.
 */
import type { LookupResult } from './lookupTypes'

export type { LookupResult } from './lookupTypes'

/** A worker reply (see lookup.worker.ts). */
interface Reply {
  result: unknown
  ready?: boolean
}

let worker: Worker | null = null
let seq = 0
/** Resolvers for in-flight requests, keyed by id. `null` ⇒ the worker went away. */
const pending = new Map<number, (reply: Reply | null) => void>()

/** LRU of results from the kuromoji path only (never greedy fallbacks, which are
 *  provisional). Lives here so it survives the worker being shed or killed. */
const RESULT_CACHE = new Map<string, LookupResult | null>()
const RESULT_CACHE_MAX = 200

function cacheKey(text: string, tapOffset: number): string {
  return `${tapOffset} ${text}`
}

function cacheGet(key: string): LookupResult | null | undefined {
  if (!RESULT_CACHE.has(key)) return undefined
  const v = RESULT_CACHE.get(key)
  RESULT_CACHE.delete(key) // re-insert as most-recently-used
  RESULT_CACHE.set(key, v!)
  return v
}

/** Drop every cached result (the dictionary data changed). */
export function clearLookupCache(): void {
  RESULT_CACHE.clear()
}

function cacheSet(key: string, value: LookupResult | null): void {
  RESULT_CACHE.set(key, value)
  if (RESULT_CACHE.size > RESULT_CACHE_MAX) RESULT_CACHE.delete(RESULT_CACHE.keys().next().value!)
}

/** Consecutive Worker *construction* failures; only these disable lookups. A runtime
 *  error (e.g. an iOS OOM kill) just recreates the worker on the next call. */
let constructFailures = 0
const MAX_CONSTRUCT_FAILURES = 3

/** Ceilings that only fire for a dead worker (iOS can kill one without `onerror`). */
const LOOKUP_TIMEOUT_MS = 8000
const WARMUP_TIMEOUT_MS = 30000

/** A live worker answers a ping even mid-build (the build is a series of async steps). */
const PING_TIMEOUT_MS = 2000

/** Drop the current worker, resolving everything in flight with `null`. */
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
    worker.onerror = () => dropWorker()
  } catch {
    constructFailures++
    worker = null
    return null
  }
  return worker
}

/** Post one request; resolves its reply, or `null` if unsendable, the worker died, or it
 *  timed out (which drops the presumed-dead worker so the next call builds a fresh one). */
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

/** Build kuromoji (and open the worker's IndexedDB) now; `true` once built. */
export async function warmupLookup(): Promise<boolean> {
  const w = getWorker()
  if (!w) return false
  const reply = await request(w, { type: 'warmup' }, WARMUP_TIMEOUT_MS)
  return reply?.result === true
}

/** Liveness probe for resume: `false` if there is no worker or it didn't answer (then it
 *  is dropped). Never constructs one. Use: `if (!(await pingLookup())) void warmupLookup()`. */
export async function pingLookup(timeoutMs = PING_TIMEOUT_MS): Promise<boolean> {
  const w = worker
  if (!w) return false
  const reply = await request(w, { type: 'ping' }, timeoutMs)
  return reply?.result === true
}

/** Terminate the worker (freeing ~30 MB of kuromoji), failing in-flight lookups.
 *  `RESULT_CACHE` deliberately survives. */
export function disposeLookup(): void {
  dropWorker()
  constructFailures = 0
}

/** The word covering `text[tapOffset]`; `null` for no match or an unavailable worker. Never throws. */
export async function lookupAt(text: string, tapOffset: number): Promise<LookupResult | null> {
  const key = cacheKey(text, tapOffset)
  const cached = cacheGet(key)
  if (cached !== undefined) return cached
  const w = getWorker()
  if (!w) return null
  const reply = await request(w, { type: 'lookup', text, tapOffset }, LOOKUP_TIMEOUT_MS)
  if (!reply) return null
  const result = (reply.result as LookupResult | null) ?? null
  if (reply.ready === true) cacheSet(key, result)
  return result
}
