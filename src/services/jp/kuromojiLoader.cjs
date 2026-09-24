/*
 * Tsuzuri's kuromoji dictionary loader. Replaces @sglkc/kuromoji's
 * BrowserDictionaryLoader (via a Vite resolve alias on NodeDictionaryLoader — see
 * vite.config.ts). Three jobs, all about memory and robustness on an iPad PWA:
 *
 * 1. **Native, defensive gunzip.** If the response is the raw gzip stream (magic
 *    0x1f 0x8b — what GitHub Pages / most static hosts return) it is inflated with the
 *    platform `DecompressionStream('gzip')`; if the server already decompressed it (it
 *    tagged the response `Content-Encoding: gzip`, so the browser inflated it
 *    transparently — Vite's dev/preview server does this) the bytes are used as-is. The
 *    upstream loader assumed the former and hung silently in the latter case (its gunzip
 *    throw wasn't routed to the callback). No JS inflate library ships in the bundle.
 *
 * 2. **No feature strings.** `tid_pos.dat.gz` (≈40 MB inflated: every token's POS /
 *    reading line) is only read by `Tokenizer#tokenize` → `getFeatures`. Tsuzuri takes
 *    token boundaries from the lattice + Viterbi path instead (segment.ts), so this
 *    loader answers that file with an empty buffer **without fetching it** — and the
 *    staging script (scripts/copy-kuromoji-dict.mjs) doesn't even stage it.
 *
 * 3. **Flat target maps.** Upstream `loadTargetMap` builds a JS object with one Array
 *    per trie id (~326k arrays for IPADIC — tens of MB of heap and a long GC-heavy
 *    parse). Here it is two Int32Arrays (offsets + values, ~3 MB) behind an object
 *    whose `target_map[id]` returns a `subarray` — the only way kuromoji reads it
 *    (`ViterbiBuilder#build`: `.length` and `[i]`). Installed per loader *instance*, so
 *    kuromoji's shared prototypes are left untouched.
 */
'use strict'

const DictionaryLoader = require('@sglkc/kuromoji/src/loader/DictionaryLoader')

/** Dictionary files the runtime never needs (see header, point 2). */
const SKIPPED = /(?:^|\/)tid_pos\.dat\.gz$/

/** Inflate gzip bytes with the platform decompressor. */
function gunzip(bytes) {
  const stream = new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).arrayBuffer()
}

/** Little-endian int32 read with kuromoji `ByteBuffer` semantics (past the end ⇒ 0). */
function readInt(bytes, view, p) {
  return p + 4 <= bytes.length ? view.getInt32(p, true) : 0
}

/** An empty, frozen value for ids with no mapping (never happens for a valid trie). */
const EMPTY = new Int32Array(0)

/**
 * Parse a kuromoji target map (`[count] ([key] [n] [value × n])*`, little endian) into
 * flat arrays. Uses the header count rather than looping to the end of the buffer, so
 * trailing zero padding (present in the stock files) is never walked.
 */
function flatTargetMap(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = readInt(bytes, view, 0)
  // Pass 1: key range and total value count.
  let p = 4
  let maxKey = -1
  let total = 0
  for (let k = 0; k < count && p < bytes.length; k++) {
    const key = readInt(bytes, view, p)
    const n = readInt(bytes, view, p + 4)
    if (key > maxKey) maxKey = key
    total += n
    p += 8 + 4 * n
  }
  // Pass 2: bucket values by key (a counting sort, so duplicate keys concatenate in
  // file order exactly like upstream `addMapping`).
  const starts = new Int32Array(maxKey + 2)
  p = 4
  for (let k = 0; k < count && p < bytes.length; k++) {
    const key = readInt(bytes, view, p)
    const n = readInt(bytes, view, p + 4)
    starts[key + 1] += n
    p += 8 + 4 * n
  }
  for (let i = 1; i < starts.length; i++) starts[i] += starts[i - 1]
  const fill = starts.slice(0, maxKey + 1)
  const values = new Int32Array(total)
  p = 4
  for (let k = 0; k < count && p < bytes.length; k++) {
    const key = readInt(bytes, view, p)
    const n = readInt(bytes, view, p + 4)
    p += 8
    for (let j = 0; j < n; j++, p += 4) values[fill[key]++] = readInt(bytes, view, p)
  }
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined
        const id = +prop
        if (!(id >= 0 && id <= maxKey)) return EMPTY
        return values.subarray(starts[id], starts[id + 1])
      },
    },
  )
}

/** Instance-level replacement for `TokenInfoDictionary#loadTargetMap`. */
function loadFlatTargetMap(arrayBuffer) {
  this.target_map = flatTargetMap(arrayBuffer)
  return this
}

function TsuzuriDictionaryLoader(dicPath) {
  DictionaryLoader.apply(this, [dicPath])
  // Shadow the prototype method on just these two instances; the stock Tokenizer /
  // ViterbiBuilder read `target_map[id]` and are otherwise unchanged.
  this.dic.token_info_dictionary.loadTargetMap = loadFlatTargetMap
  this.dic.unknown_dictionary.loadTargetMap = loadFlatTargetMap
}

TsuzuriDictionaryLoader.prototype = Object.create(DictionaryLoader.prototype)

TsuzuriDictionaryLoader.prototype.loadArrayBuffer = function (url, callback) {
  if (SKIPPED.test(url)) {
    // Not needed for boundary-only segmentation — skip the ~6 MB (40 MB inflated) file.
    queueMicrotask(function () {
      callback(null, new ArrayBuffer(0))
    })
    return
  }
  // Network (or the service worker) first; if that fails — offline in a worker the SW
  // doesn't control — fall back to the Cache API copy cacheIpadic() stored.
  fetch(url)
    .catch(function (err) {
      if (typeof caches === 'undefined') throw err
      return caches.match(url).then(function (hit) {
        if (!hit) throw err
        return hit
      })
    })
    .then(function (response) {
      if (!response.ok) throw new Error('kuromoji dict ' + response.status + ' for ' + url)
      return response.arrayBuffer()
    })
    .then(function (arraybuffer) {
      const bytes = new Uint8Array(arraybuffer)
      return bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzip(bytes) : arraybuffer
    })
    .then(
      function (buffer) {
        deliver(callback, null, buffer)
      },
      function (err) {
        deliver(callback, err, null)
      },
    )
}

/**
 * Invoke kuromoji's callback outside the promise chain. The callback runs the
 * dictionary assembly (and, for the last file, the whole build continuation), so a
 * throw from it must not be swallowed as an unhandled rejection — that would leave
 * `ensureSegmenter()` pending forever. Rethrown on a fresh task, it surfaces as a
 * worker `error` event, which the client treats as a dead worker and replaces.
 */
function deliver(callback, err, buffer) {
  try {
    callback(err, buffer)
  } catch (e) {
    setTimeout(function () {
      throw e
    })
  }
}

module.exports = TsuzuriDictionaryLoader
