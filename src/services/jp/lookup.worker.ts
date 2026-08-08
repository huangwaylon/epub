/**
 * Dictionary lookup worker. Runs the whole Japanese lookup pipeline — kuromoji
 * segmentation (incl. the ~19 MB IPADIC trie build), deinflection, and the JMdict
 * IndexedDB queries — off the main thread, so tap-to-define never stalls the reader
 * or janks a page-turn on iPad. The DOM-touching parts (caretRangeFromPoint, building
 * the highlight Range) stay on the main thread; this worker only takes
 * `{ text, tapOffset }` and returns a `LookupResult`.
 *
 * jpdict-idb's `getWords` opens its own read-only connection to the shared "jpdict"
 * IndexedDB, so the worker reads exactly the data the main thread downloaded — no
 * duplicate download, no message-passing of dictionary bytes.
 */
import { lookupAt, warmup, isSegmenterReady } from './lookup'

type Incoming =
  | { type: 'warmup'; id: number }
  | { type: 'ready'; id: number }
  | { type: 'lookup'; id: number; text: string; tapOffset: number }

self.onmessage = async (e: MessageEvent<Incoming>) => {
  const msg = e.data
  if (msg.type === 'warmup') {
    // Build kuromoji (fetching + SW-caching the IPADIC dict) and report back whether it
    // succeeded, so the main thread can gate its "offline-ready" state on it.
    const ready = await warmup()
    ;(self as unknown as Worker).postMessage({ id: msg.id, result: ready })
    return
  }
  if (msg.type === 'ready') {
    // Cheap synchronous status probe: is the tokenizer built? Lets the main thread
    // distinguish "segmentation is still loading" from "no dictionary match".
    ;(self as unknown as Worker).postMessage({ id: msg.id, result: isSegmenterReady() })
    return
  }
  if (msg.type === 'lookup') {
    try {
      const result = await lookupAt(msg.text, msg.tapOffset)
      // `ready` reports which path produced this result: only a morphological (kuromoji-
      // ready) result is authoritative enough for the client to cache across worker
      // disposal — see `lookupClient`.
      ;(self as unknown as Worker).postMessage({ id: msg.id, result, ready: isSegmenterReady() })
    } catch (err) {
      ;(self as unknown as Worker).postMessage({ id: msg.id, result: null, error: String(err) })
    }
  }
}
