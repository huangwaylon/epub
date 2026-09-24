/** Location and file set of the staged kuromoji IPADIC dict. Dependency-free: imported by
 *  both the worker (segment.ts) and the main thread (dictdb.ts). */

/** Served dict directory (dev `/kuromoji/dict`, prod `/epub/kuromoji/dict`). */
export const IPADIC_DIR = `${import.meta.env.BASE_URL}kuromoji/dict`

/**
 * Every file the runtime fetches; a partial set builds no trie. Must match `STAGED` in
 * scripts/copy-kuromoji-dict.mjs. `tid_pos.dat.gz` is never staged (see kuromojiLoader.cjs).
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

/** The SW runtime cache for the dict; must equal the workbox `cacheName` in vite.config.ts. */
export const IPADIC_CACHE = 'kuromoji-ipadic-v2'

/** Absolute dict URLs, resolved as the worker's `fetch` resolves them. */
export function ipadicUrls(base: string = globalThis.location?.href ?? 'http://localhost/'): string[] {
  return IPADIC_FILES.map((f) => new URL(`${IPADIC_DIR}/${f}`, base).href)
}
