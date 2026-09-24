/**
 * Lookup worker: kuromoji, deinflection and JMdict reads (jpdict-idb opens its own
 * connection to the shared "jpdict" IndexedDB). Replies are `{ id, result, ready? }`:
 *   warmup → result: boolean (kuromoji built)
 *   ping   → result: true, ready: segmenter built
 *   lookup → result: LookupResult | null, ready: whether the path taken was kuromoji's
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
      // `ready` is captured when the path was chosen, not re-read now: a build finishing
      // mid-lookup must not mark a greedy answer as cacheable.
      const { result, ready } = await resolveLookup(msg.text, msg.tapOffset)
      post({ id: msg.id, result, ready })
    } catch (err) {
      post({ id: msg.id, result: null, error: String(err) })
    }
  }
}
