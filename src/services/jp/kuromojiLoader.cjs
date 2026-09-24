/*
 * Tsuzuri's kuromoji dictionary loader, aliased over @sglkc/kuromoji's loaders in
 * vite.config.ts. For memory and robustness on iOS:
 *
 * 1. Gunzips with native `DecompressionStream` only if the bytes carry the gzip magic —
 *    servers that send `Content-Encoding: gzip` (Vite dev) hand over inflated bytes.
 * 2. Answers `tid_pos.dat.gz` (≈40 MB of POS/reading strings, only read by `tokenize()`)
 *    with an empty buffer, unfetched; segment.ts takes boundaries from the lattice.
 * 3. Replaces `loadTargetMap`'s ~326k JS arrays with two Int32Arrays behind a Proxy whose
 *    `target_map[id]` is a subarray (kuromoji only reads `.length` and `[i]`). Installed
 *    per instance, leaving kuromoji's prototypes untouched.
 */
'use strict'

const DictionaryLoader = require('@sglkc/kuromoji/src/loader/DictionaryLoader')

/** Never fetched (header, point 2). */
const SKIPPED = /(?:^|\/)tid_pos\.dat\.gz$/

function gunzip(bytes) {
  const stream = new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).arrayBuffer()
}

/** Little-endian int32 read with kuromoji `ByteBuffer` semantics (past the end ⇒ 0). */
function readInt(bytes, view, p) {
  return p + 4 <= bytes.length ? view.getInt32(p, true) : 0
}

/** For ids with no mapping (never happens for a valid trie). */
const EMPTY = new Int32Array(0)

/** Parse a target map (`[count] ([key] [n] [value × n])*`, LE) by its header count, so
 *  trailing zero padding is never walked. */
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
  // Pass 2: counting sort, so duplicate keys concatenate in file order like upstream.
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
  this.dic.token_info_dictionary.loadTargetMap = loadFlatTargetMap
  this.dic.unknown_dictionary.loadTargetMap = loadFlatTargetMap
}

TsuzuriDictionaryLoader.prototype = Object.create(DictionaryLoader.prototype)

TsuzuriDictionaryLoader.prototype.loadArrayBuffer = function (url, callback) {
  if (SKIPPED.test(url)) {
    queueMicrotask(function () {
      callback(null, new ArrayBuffer(0))
    })
    return
  }
  // Network / SW first; offline in a worker the SW doesn't control, use cacheIpadic()'s copy.
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

/** Call kuromoji's callback outside the promise chain: a throw inside it would otherwise
 *  be swallowed and hang `ensureSegmenter()`. Rethrown on a fresh task it becomes a worker
 *  `error`, and the client replaces the worker. */
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
