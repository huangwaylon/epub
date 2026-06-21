import * as kuromoji from '@sglkc/kuromoji'
import type { Tokenizer, IpadicFeatures } from '@sglkc/kuromoji'

/**
 * Japanese sentence segmentation via kuromoji (MeCab-style IPADIC morphological
 * analysis). This gives proper word boundaries — far better than greedy
 * dictionary-longest-match — so a tap anywhere in a word resolves the whole word.
 *
 * The IPADIC dictionary (~19 MB of *.dat.gz) is staged into `public/kuromoji/dict`
 * by `scripts/copy-kuromoji-dict.mjs` and fetched from `${BASE_URL}kuromoji/dict/`
 * at runtime; the service worker runtime-caches it for offline use (see
 * vite.config.ts). It loads lazily on first use; until it's ready, `lookup.ts`
 * falls back to greedy segmentation.
 */

/** Where the staged IPADIC dictionary is served (dev: `/…`, prod: `/epub/…`). */
const DIC_PATH = `${import.meta.env.BASE_URL}kuromoji/dict`

let tokenizer: Tokenizer<IpadicFeatures> | null = null
let buildPromise: Promise<Tokenizer<IpadicFeatures>> | null = null

/**
 * Lazily build the kuromoji tokenizer (one-time ~19 MB download, then SW-cached).
 * Idempotent — safe to call on every tap. Rejects (and clears so a later tap can
 * retry) if the dictionary can't be loaded.
 */
export function ensureSegmenter(): Promise<Tokenizer<IpadicFeatures>> {
  if (!buildPromise) {
    buildPromise = new Promise<Tokenizer<IpadicFeatures>>((resolve, reject) => {
      kuromoji.builder({ dicPath: DIC_PATH }).build((err, tok) => {
        if (err || !tok) reject(err ?? new Error('kuromoji build failed'))
        else resolve(tok)
      })
    }).then(
      (tok) => {
        tokenizer = tok
        return tok
      },
      (err) => {
        buildPromise = null // allow a later tap to retry the download
        throw err
      },
    )
  }
  return buildPromise
}

/** Whether the tokenizer has finished loading (synchronous). */
export function segmenterReady(): boolean {
  return tokenizer !== null
}

/**
 * Start index within `text` of the morphological token containing `tapOffset`, per
 * kuromoji — or `null` if the tokenizer isn't loaded yet (callers fall back to greedy
 * segmentation). `word_position` is a 1-based character index into the tokenized text.
 */
export function tokenStartAt(text: string, tapOffset: number): number | null {
  if (!tokenizer) return null
  let tokens: IpadicFeatures[]
  try {
    tokens = tokenizer.tokenize(text)
  } catch {
    return null
  }
  for (const t of tokens) {
    const start = t.word_position - 1
    if (tapOffset >= start && tapOffset < start + t.surface_form.length) return start
  }
  return null
}
