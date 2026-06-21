/*
 * Defensive kuromoji dictionary loader. Replaces @sglkc/kuromoji's
 * BrowserDictionaryLoader (via a Vite resolve alias on NodeDictionaryLoader — see
 * vite.config.ts) so dictionary loading is robust to how the server delivers the
 * gzipped *.dat.gz files:
 *
 *   - If the response is the raw gzip stream (gzip magic 0x1f 0x8b present), inflate
 *     it with fflate — what GitHub Pages / most static hosts return.
 *   - If the server already decompressed it (it tagged the response
 *     `Content-Encoding: gzip`, so the browser inflated it transparently — Vite's
 *     dev/preview server does this), use the bytes as-is.
 *
 * The upstream loader assumed the former and hung silently in the latter case (its
 * gunzip throw wasn't routed to the callback). This keeps the same interface.
 */
const fflate = require('fflate')
const DictionaryLoader = require('@sglkc/kuromoji/src/loader/DictionaryLoader')

function DefensiveDictionaryLoader(dicPath) {
  DictionaryLoader.apply(this, [dicPath])
}

DefensiveDictionaryLoader.prototype = Object.create(DictionaryLoader.prototype)

DefensiveDictionaryLoader.prototype.loadArrayBuffer = function (url, callback) {
  fetch(url)
    .then(function (response) {
      if (!response.ok) throw new Error('kuromoji dict ' + response.status + ' for ' + url)
      return response.arrayBuffer()
    })
    .then(function (arraybuffer) {
      let bytes = new Uint8Array(arraybuffer)
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = fflate.gunzipSync(bytes)
      callback(null, bytes.buffer)
    })
    .catch(function (err) {
      callback(err, null)
    })
}

module.exports = DefensiveDictionaryLoader
