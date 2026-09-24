import * as kuromoji from '@sglkc/kuromoji'
import { IPADIC_DIR } from './ipadic'

/**
 * Japanese word *boundaries* via kuromoji (MeCab-style IPADIC morphological analysis).
 * This is far better than greedy dictionary-longest-match — so a tap anywhere in a word
 * resolves the whole word.
 *
 * Only the boundaries are used: each token's start and length on the Viterbi best path
 * through kuromoji's word lattice. Kuromoji's own `tokenize()` additionally decodes every
 * token's POS/reading feature line from `tid_pos.dat` (≈40 MB inflated) — nothing in the
 * lookup needs those (JMdict supplies POS and readings), so that file is never staged or
 * fetched and `tokenize()` is never called (see kuromojiLoader.cjs).
 *
 * The trimmed IPADIC dictionary (~11 MB of *.dat.gz, ~27 MB inflated) is staged into
 * `public/kuromoji/dict` by `scripts/copy-kuromoji-dict.mjs` and fetched from
 * `${BASE_URL}kuromoji/dict/` at runtime; `cacheIpadic()` (dictdb.ts) pre-caches it for
 * offline use. It loads lazily on first use; until it's ready, `lookup.ts` falls back to
 * greedy segmentation.
 */

/** The parts of a kuromoji `ViterbiNode` this module reads. */
interface LatticeNode {
  /** 1-based start within the sentence (code-point index; our text is BMP-only). */
  start_pos: number
  surface_form: string
}

/** The parts of kuromoji's `Tokenizer` this module uses (`getLattice` + the searcher). */
export interface LatticeTokenizer {
  getLattice(sentence: string): unknown
  viterbi_searcher: { search(lattice: unknown): LatticeNode[] }
}

/** A token's span in the segmented text: `[start, end)` in UTF-16 units. */
export interface TokenSpan {
  start: number
  end: number
}

let tokenizer: LatticeTokenizer | null = null
let buildPromise: Promise<LatticeTokenizer> | null = null

/**
 * Lazily build the kuromoji tokenizer (fetches the IPADIC dict — from the Cache API once
 * `cacheIpadic()` has run). Idempotent — safe to call on every tap. Rejects (and clears so
 * a later tap can retry) if the dictionary can't be loaded.
 */
export function ensureSegmenter(): Promise<LatticeTokenizer> {
  if (!buildPromise) {
    buildPromise = new Promise<LatticeTokenizer>((resolve, reject) => {
      kuromoji.builder({ dicPath: IPADIC_DIR }).build((err, tok) => {
        if (err || !tok) reject(err ?? new Error('kuromoji build failed'))
        else resolve(tok as unknown as LatticeTokenizer)
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

/** kuromoji's sentence splitter (`Tokenizer.splitByPunctuation`): after each 、 or 。. */
const PUNCTUATION = /、|。/

/**
 * Token spans of `text` on kuromoji's best (Viterbi) path — the same boundaries
 * `tokenizer.tokenize(text)` produces (asserted by the golden test in segment.test.ts),
 * without decoding any feature strings. Like `tokenize`, the text is first split into
 * sentences after each 、/。; a sentence with no complete path contributes no spans.
 *
 * One deliberate difference: `tokenize` offsets each sentence by the *start* of the
 * previous sentence's last token, which is only right when that token is a single
 * character. Here each sentence is offset by its real position. The runs `extract.ts`
 * produces never contain 、/。, so for real taps there is exactly one sentence.
 */
export function tokenSpans(tok: LatticeTokenizer, text: string): TokenSpan[] {
  const spans: TokenSpan[] = []
  let offset = 0
  let tail = text
  while (tail) {
    const cut = tail.search(PUNCTUATION)
    const sentence = cut < 0 ? tail : tail.slice(0, cut + 1)
    tail = cut < 0 ? '' : tail.slice(cut + 1)
    const path = tok.viterbi_searcher.search(tok.getLattice(sentence))
    for (const node of path) {
      const start = offset + node.start_pos - 1
      spans.push({ start, end: start + node.surface_form.length })
    }
    offset += sentence.length
  }
  return spans
}

/**
 * The morphological token containing `tapOffset` in `text`, per kuromoji — or `null` if
 * the tokenizer isn't loaded yet (callers fall back to greedy segmentation), segmentation
 * threw, or no token covers the offset.
 */
export function tokenSpanAt(text: string, tapOffset: number): TokenSpan | null {
  if (!tokenizer) return null
  let spans: TokenSpan[]
  try {
    spans = tokenSpans(tokenizer, text)
  } catch {
    return null
  }
  for (const s of spans) if (tapOffset >= s.start && tapOffset < s.end) return s
  return null
}
