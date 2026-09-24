/**
 * Dictionary lookup worker. Runs the whole Japanese lookup pipeline — kuromoji
 * segmentation (incl. the IPADIC trie build), deinflection, and the JMdict IndexedDB
 * queries — off the main thread, so tap-to-define never stalls the reader or janks a
 * page-turn on iPad. The DOM-touching parts (glyph resolution, building the highlight
 * Range) stay on the main thread; this worker only takes `{ text, tapOffset }` and
 * returns a `LookupResult`.
 *
 * jpdict-idb's `getWords` opens its own read-only connection to the shared "jpdict"
 * IndexedDB, so the worker reads exactly the data the main thread downloaded — no
 * duplicate download, no message-passing of dictionary bytes.
 *
 * Protocol (every reply is `{ id, result, ready? }`):
 *   warmup → result: boolean  (kuromoji built; also opens the IndexedDB connection)
 *   ping   → result: true, ready: segmenter built   (liveness probe, answered at once)
 *   lookup → result: LookupResult | null, ready: whether the *path taken* was kuromoji's
 */
import { resolveLookup, warmup, isSegmenterReady } from './lookup'

type Incoming =
  | { type: 'warmup'; id: number }
  | { type: 'ping'; id: number }
  | { type: 'lookup'; id: number; text: string; tapOffset: number }

const post = (msg: unknown) => (self as unknown as Worker).postMessage(msg)

self.onmessage = async (e: MessageEvent<Incoming>) => {
  const msg = e.data
  if (msg.type === 'warmup') {
    post({ id: msg.id, result: await warmup() })
    return
  }
  if (msg.type === 'ping') {
    post({ id: msg.id, result: true, ready: isSegmenterReady() })
    return
  }
  if (msg.type === 'lookup') {
    try {
      // `ready` is the readiness captured when the lookup chose its path — not re-read
      // now, after the IndexedDB awaits: a build finishing mid-lookup would otherwise
      // tag a provisional greedy answer as authoritative, and the client would cache it.
      const { result, ready } = await resolveLookup(msg.text, msg.tapOffset)
      post({ id: msg.id, result, ready })
    } catch (err) {
      post({ id: msg.id, result: null, error: String(err) })
    }
  }
}
