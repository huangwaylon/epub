// Stages kuromoji's IPADIC dict into public/kuromoji/dict (gitignored; run by `predev` /
// `prebuild`), trimmed losslessly so the worker holds ~30 MB instead of ~175 MB:
//
//   - `tid`, `unk`, `unk_pos`, `unk_map`, `unk_invoke` carry megabytes of zero padding from
//     kuromoji's fixed-size builder buffers. They are cut to their structural length
//     (asserted zero tail, costs spot-checked); kuromoji's ByteBuffer reads past-the-end
//     as 0, so this is invisible. `unk_invoke` matters most: its reader loops to the end
//     of the buffer, so the padding became ~150k bogus character classes.
//   - `tid_pos` (feature strings, ≈40 MB inflated) is not staged; see kuromojiLoader.cjs.
//   - The rest are copied byte-for-byte.
//
// Usage: node scripts/copy-kuromoji-dict.mjs [destDir]
import { mkdirSync, readdirSync, existsSync, statSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync, constants } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'node_modules/@sglkc/kuromoji/dict')
const dest = process.argv[2] ? resolve(process.argv[2]) : join(root, 'public/kuromoji/dict')

/** Files the runtime fetches. Keep in sync with `IPADIC_FILES` in src/services/jp/ipadic.ts. */
const STAGED = [
  'base.dat.gz',
  'check.dat.gz',
  'tid.dat.gz',
  'tid_map.dat.gz',
  'cc.dat.gz',
  'unk.dat.gz',
  'unk_pos.dat.gz',
  'unk_map.dat.gz',
  'unk_char.dat.gz',
  'unk_compat.dat.gz',
  'unk_invoke.dat.gz',
]
/** Bump when the transformation changes, to regenerate stale staged copies. */
const TRIM_VERSION = 1
const STAMP = '.staged.json'

if (!existsSync(src)) {
  // Don't fail the build: without the dict lookups fall back to greedy segmentation.
  console.warn(`[kuromoji] dict not found at ${src} — run \`npm install\`. Skipping.`)
  process.exit(0)
}

// --- structural lengths ------------------------------------------------------------

const i32 = (b, p) => (p + 4 <= b.length ? b.readInt32LE(p) : 0) // ByteBuffer semantics: past end ⇒ 0
const i16 = (b, p) => (p + 2 <= b.length ? b.readInt16LE(p) : 0)

/** Parse a target map (`[count] ([key] [n] [v × n])*`) using its header count. */
function parseTargetMap(b) {
  const count = i32(b, 0)
  const map = new Map()
  let p = 4
  for (let k = 0; k < count; k++) {
    const key = i32(b, p)
    const n = i32(b, p + 4)
    p += 8
    const vals = []
    for (let j = 0; j < n; j++, p += 4) vals.push(i32(b, p))
    map.set(key, vals)
  }
  return { map, end: p }
}

/** End of the NUL-terminated string at `p` (index just past the terminator). */
function strEnd(b, p) {
  while (p < b.length && b[p] !== 0) p++
  return Math.min(p + 1, b.length)
}

/** Length of `unk_invoke` holding exactly `classes` character-class records. */
function invokeEnd(b, classes) {
  let p = 0
  for (let c = 0; c < classes; c++) p = strEnd(b, p + 6) // is_always_invoke, is_grouping, max_length(int), name
  return p
}

const TOKEN_INFO_BYTES = 10 // left_id(2) right_id(2) word_cost(2) pos_id(4)

function computeTrims(raw) {
  const tidMap = parseTargetMap(raw['tid_map.dat.gz']).map
  const unkMapParsed = parseTargetMap(raw['unk_map.dat.gz'])
  const maxValue = (m) => {
    let max = -1
    for (const vals of m.values()) for (const v of vals) if (v > max) max = v
    return max
  }
  const unk = raw['unk.dat.gz']
  // unk_pos must keep every feature string an unknown-token entry points at.
  let unkPosEnd = 0
  for (const id of [...unkMapParsed.map.values()].flat()) {
    unkPosEnd = Math.max(unkPosEnd, strEnd(raw['unk_pos.dat.gz'], i32(unk, id + 6)))
  }
  // One character class per unk_map key (class ids 0..n-1).
  const classes = unkMapParsed.map.size
  return {
    'tid.dat.gz': maxValue(tidMap) + TOKEN_INFO_BYTES,
    'unk.dat.gz': maxValue(unkMapParsed.map) + TOKEN_INFO_BYTES,
    'unk_map.dat.gz': unkMapParsed.end,
    'unk_pos.dat.gz': unkPosEnd,
    'unk_invoke.dat.gz': invokeEnd(raw['unk_invoke.dat.gz'], classes),
  }
}

/** Every byte past `len` must be zero, or the trim would lose data. */
function assertZeroTail(name, b, len) {
  for (let i = len; i < b.length; i++) {
    if (b[i] !== 0) throw new Error(`[kuromoji] refusing to trim ${name}: non-zero byte at ${i} (len ${len})`)
  }
}

/** Spot-check that the trimmed tid still yields the same token costs. */
function verifyTokenInfo(name, full, trimmed, ids) {
  for (const id of ids) {
    for (const off of [0, 2, 4]) {
      if (i16(full, id + off) !== i16(trimmed, id + off)) throw new Error(`[kuromoji] ${name} trim changed entry ${id}`)
    }
  }
}

// --- staging -----------------------------------------------------------------------

const sources = Object.fromEntries(
  readdirSync(src)
    .filter((f) => f.endsWith('.dat.gz'))
    .map((f) => [f, statSync(join(src, f)).size]),
)
const stamp = JSON.stringify({ version: TRIM_VERSION, sources })
const stampPath = join(dest, STAMP)
const current =
  existsSync(stampPath) &&
  readFileSync(stampPath, 'utf8') === stamp &&
  STAGED.every((f) => existsSync(join(dest, f)))

mkdirSync(dest, { recursive: true })
// Drop anything no longer staged (e.g. tid_pos.dat.gz), so it can't be served or cached.
for (const f of readdirSync(dest)) {
  if (f.endsWith('.dat.gz') && !STAGED.includes(f)) rmSync(join(dest, f))
}

if (current) {
  console.log(`[kuromoji] IPADIC dict already staged in ${dest} (${summary()})`)
  process.exit(0)
}

const raw = {}
for (const f of STAGED) raw[f] = gunzipSync(readFileSync(join(src, f)))
const trims = computeTrims(raw)
const entryIds = (f) => [...parseTargetMap(raw[f]).map.values()].flat()

let inflatedBefore = 0
let inflatedAfter = 0
for (const f of STAGED) {
  const full = raw[f]
  let out = full
  if (f in trims) {
    const len = Math.min(trims[f], full.length)
    assertZeroTail(f, full, len)
    out = full.subarray(0, len)
    if (f === 'tid.dat.gz') verifyTokenInfo(f, full, out, entryIds('tid_map.dat.gz'))
    if (f === 'unk.dat.gz') verifyTokenInfo(f, full, out, entryIds('unk_map.dat.gz'))
  }
  inflatedBefore += full.length
  inflatedAfter += out.length
  if (out === full) copyFileSync(join(src, f), join(dest, f))
  else writeFileSync(join(dest, f), gzipSync(out, { level: constants.Z_BEST_COMPRESSION }))
}
inflatedBefore += gunzipSync(readFileSync(join(src, 'tid_pos.dat.gz'))).length
writeFileSync(stampPath, stamp)
const mb = (n) => (n / 1048576).toFixed(1) + ' MB'
console.log(
  `[kuromoji] IPADIC dict staged in ${dest}: ${summary()}; inflated ${mb(inflatedBefore)} → ${mb(inflatedAfter)}`,
)

function summary() {
  const total = STAGED.reduce((n, f) => n + (existsSync(join(dest, f)) ? statSync(join(dest, f)).size : 0), 0)
  return `${STAGED.length} files, ${(total / 1048576).toFixed(1)} MB gzipped`
}
