/**
 * Where the staged kuromoji IPADIC dictionary lives, and which files make it up.
 * Dependency-free so both the worker (segment.ts) and the main thread (dictdb.ts's
 * `cacheIpadic`) can import it without pulling in kuromoji.
 */

/** Served directory of the staged dict (dev: `/kuromoji/dict`, prod: `/epub/kuromoji/dict`). */
export const IPADIC_DIR = `${import.meta.env.BASE_URL}kuromoji/dict`

/**
 * Every file the runtime fetches — all-or-nothing: a partial set builds no trie. Keep in
 * sync with `STAGED` in scripts/copy-kuromoji-dict.mjs. `tid_pos.dat.gz` is deliberately
 * absent (never staged, never fetched — see kuromojiLoader.cjs).
 */
export const IPADIC_FILES = [
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
] as const

/**
 * The service worker's runtime cache for the dict (workbox `CacheFirst`, vite.config.ts).
 * `cacheIpadic()` writes into this same cache, so the worker's first fetch — even offline —
 * is served from it. Must match the `cacheName` in vite.config.ts exactly.
 */
export const IPADIC_CACHE = 'kuromoji-ipadic-v2'

/** Absolute URLs of the dict files, resolved exactly as the worker's `fetch` resolves them. */
export function ipadicUrls(base: string = globalThis.location?.href ?? 'http://localhost/'): string[] {
  return IPADIC_FILES.map((f) => new URL(`${IPADIC_DIR}/${f}`, base).href)
}
