import * as kuromoji from '@sglkc/kuromoji'
import { IPADIC_DIR } from './ipadic'

/**
 * Word boundaries via kuromoji (IPADIC). Boundaries only: token spans come from the
 * lattice's Viterbi best path, never `tokenize()`, whose feature strings need
 * `tid_pos.dat` — which is not shipped (see kuromojiLoader.cjs).
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

/** Build the tokenizer once (idempotent). A failed build is cleared so a later call retries. */
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
        buildPromise = null
        throw err
      },
    )
  }
  return buildPromise
}

/** Whether the tokenizer is built. */
export function segmenterReady(): boolean {
  return tokenizer !== null
}

/** kuromoji's sentence splitter (`Tokenizer.splitByPunctuation`): after each 、 or 。. */
const PUNCTUATION = /、|。/

/**
 * Token spans on kuromoji's best path — the same boundaries as `tokenize()` (pinned by
 * segment.golden.test.ts). Like `tokenize`, splits after each 、/。, but offsets each
 * sentence by its real position (`tokenize` uses the previous last token's *start*).
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

/** The token containing `tapOffset`, or `null` (not built, segmentation threw, no cover). */
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
