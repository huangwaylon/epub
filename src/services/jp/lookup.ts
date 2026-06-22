import { getWords } from '@birchill/jpdict-idb'
import { toNormalized } from '@birchill/normal-jp'
import { deinflect, Reason, type CandidateWord } from './deinflect'
import { ensureSegmenter, tokenStartAt } from './segment'

/** One dictionary sense: its parts of speech and English glosses. */
export interface Sense {
  pos: string[]
  glosses: string[]
}

export interface DictEntry {
  /** Primary written form (kanji if present, else kana). */
  headword: string
  /** Kana reading. */
  reading: string
  /** Pitch-accent position (mora index), if known. */
  pitch?: number
  /** True when the headword is itself just kana (so reading is redundant). */
  kanaOnly: boolean
  senses: Sense[]
}

export interface LookupResult {
  /**
   * Offset of the match within the text passed to `lookupAt` (0 for `lookup`,
   * which is forward-only from the window start). With `matchLength` this gives
   * the matched word's span `[matchStart, matchStart + matchLength)`, which the
   * caller uses to build a DOM range for the tapped word (e.g. to highlight it).
   */
  matchStart: number
  /** Number of characters from `matchStart` that were matched. */
  matchLength: number
  /** Human-readable deinflection reasons, outermost first. */
  reasons: string[]
  entries: DictEntry[]
}

const MAX_WINDOW = 16
const MAX_RESULTS = 8

const REASON_LABELS: Partial<Record<Reason, string>> = {
  [Reason.PolitePastNegative]: 'polite past negative',
  [Reason.PoliteNegative]: 'polite negative',
  [Reason.PoliteVolitional]: 'polite volitional',
  [Reason.Chau]: '-chau',
  [Reason.Sugiru]: '-sugiru',
  [Reason.PolitePast]: 'polite past',
  [Reason.Tara]: '-tara',
  [Reason.Tari]: '-tari',
  [Reason.Causative]: 'causative',
  [Reason.PotentialOrPassive]: 'potential or passive',
  [Reason.Toku]: '-toku',
  [Reason.Sou]: '-sou',
  [Reason.Tai]: '-tai',
  [Reason.Polite]: 'polite',
  [Reason.Respectful]: 'respectful',
  [Reason.Humble]: 'humble',
  [Reason.HumbleOrKansaiDialect]: 'humble or Kansai dialect',
  [Reason.Past]: 'past',
  [Reason.Negative]: 'negative',
  [Reason.Passive]: 'passive',
  [Reason.Ba]: '-ba',
  [Reason.Volitional]: 'volitional',
  [Reason.Potential]: 'potential',
  [Reason.EruUru]: '-eru / -uru',
  [Reason.CausativePassive]: 'causative passive',
  [Reason.Te]: '-te',
  [Reason.Zu]: '-zu',
  [Reason.Imperative]: 'imperative',
  [Reason.MasuStem]: 'masu stem',
  [Reason.Adv]: 'adverb',
  [Reason.Noun]: 'noun',
  [Reason.ImperativeNegative]: 'imperative negative',
  [Reason.Continuous]: 'continuous',
  [Reason.Ki]: '-ki',
  [Reason.SuruNoun]: 'suru noun',
  [Reason.ZaruWoEnai]: '-zaru wo enai',
  [Reason.NegativeTe]: 'negative -te',
  [Reason.Irregular]: 'irregular',
}

const POS_LABELS: Record<string, string> = {
  n: 'noun',
  pn: 'pronoun',
  adv: 'adverb',
  'adj-i': 'い-adjective',
  'adj-na': 'な-adjective',
  'adj-no': 'の-adjective',
  v1: 'ichidan verb',
  vk: 'kuru verb',
  vs: 'する verb',
  'vs-i': 'する verb',
  'vs-s': 'する verb',
  vt: 'transitive',
  vi: 'intransitive',
  exp: 'expression',
  int: 'interjection',
  prt: 'particle',
  conj: 'conjunction',
  'aux-v': 'auxiliary verb',
  suf: 'suffix',
  pref: 'prefix',
  ctr: 'counter',
}

function posLabel(code: string): string {
  if (POS_LABELS[code]) return POS_LABELS[code]
  if (code.startsWith('v5')) return 'godan verb'
  if (code.startsWith('adj')) return 'adjective'
  if (code.startsWith('v')) return 'verb'
  return code
}

const INFLECTABLE = /^(v1|v5|vk|vs|vz|vn|vr|adj-i|aux-v)/

/** A deinflected candidate is only valid if the dictionary entry is inflectable. */
function candidateMatches(word: any, cand: CandidateWord): boolean {
  if (!cand.reasonChains.length) return true // original surface form — always allowed
  const allPos: string[] = (word.s ?? []).flatMap((s: any) => s.pos ?? [])
  return allPos.some((p) => INFLECTABLE.test(p))
}

function reasonsToLabels(chains: Reason[][]): string[] {
  const chain = chains[0]
  if (!chain?.length) return []
  return chain.map((r) => REASON_LABELS[r] ?? '').filter(Boolean)
}

function readingAccent(a: unknown): number | undefined {
  if (typeof a === 'number') return a
  if (Array.isArray(a) && a.length && typeof (a[0] as any).i === 'number') return (a[0] as any).i
  return undefined
}

function toEntry(w: any): DictEntry {
  const headword: string = w.k?.[0]?.ent ?? w.r?.[0]?.ent ?? ''
  const reading: string = w.r?.[0]?.ent ?? ''
  const kanaOnly = !w.k?.length
  return {
    headword,
    reading,
    kanaOnly,
    pitch: readingAccent(w.r?.[0]?.a),
    senses: (w.s ?? []).map((s: any) => ({
      pos: (s.pos ?? []).map(posLabel),
      glosses: (s.g ?? []).map((g: any) => g.str),
    })),
  }
}

/** A memoised `getWords` so the many length/start probes for one tap share queries. */
function makeQueryCache(): (term: string) => Promise<any[]> {
  const cache = new Map<string, any[]>()
  return async (term: string): Promise<any[]> => {
    let r = cache.get(term)
    if (!r) {
      r = await getWords(term, { matchType: 'exact', limit: MAX_RESULTS })
      cache.set(term, r)
    }
    return r
  }
}

/**
 * Longest dictionary match starting at the *beginning* of `window`, trying
 * deinflected forms (10ten-style). Returns null if nothing matches. `matchLength`
 * is the number of surface characters consumed (the token's span).
 */
async function matchAt(window: string, queryWords: (t: string) => Promise<any[]>): Promise<LookupResult | null> {
  const limit = Math.min(window.length, MAX_WINDOW)
  for (let len = limit; len > 0; len--) {
    const sub = window.slice(0, len)
    const [normalized] = toNormalized(sub)
    if (!normalized) continue

    const candidates = deinflect(normalized)
    for (const cand of candidates) {
      const words = await queryWords(cand.word)
      if (!words.length) continue
      const matched = words.filter((w) => candidateMatches(w, cand))
      if (!matched.length) continue
      return {
        matchStart: 0, // relative to `window`; lookupAt rebases it onto the full text
        matchLength: len,
        reasons: reasonsToLabels(cand.reasonChains),
        entries: matched.map(toEntry),
      }
    }
  }
  return null
}

/**
 * Looks up the longest dictionary match starting at the beginning of `window`.
 * Forward-only from the cursor; prefer `lookupAt` for tap-to-define so a tap in
 * the middle of a word still resolves the whole word.
 */
export async function lookup(window: string): Promise<LookupResult | null> {
  return matchAt(window, makeQueryCache())
}

/**
 * Returns the dictionary entry for the word that contains the character at
 * `tapOffset` in `text` — so tapping *any* character of a word resolves the whole
 * word, not just the run from the tapped character forward.
 *
 * Word boundaries come from **kuromoji** (MeCab-style IPADIC morphological analysis,
 * `segment.ts`): we take the token containing the tap and run `matchAt` from its
 * start (so deinflection + JMdict glosses still apply, and a JMdict compound longer
 * than the IPADIC token is still found). kuromoji loads lazily (~19 MB, once); until
 * it is ready — or if it split a word JMdict lemmatises differently — we fall back to
 * **greedy leftmost-covering**: scan starts left-to-right and take the first longest
 * match that spans the tap (the leftmost, most complete word — tapping 決 or 心 in
 * 決心 both resolve 決心).
 */
export async function lookupAt(text: string, tapOffset: number): Promise<LookupResult | null> {
  if (tapOffset < 0 || tapOffset >= text.length) return null
  const queryWords = makeQueryCache()

  // Kick off the kuromoji load on first use (non-blocking); use it once ready.
  void ensureSegmenter().catch(() => {})
  const tokenStart = tokenStartAt(text, tapOffset)
  if (tokenStart !== null) {
    const res = await matchAt(text.slice(tokenStart), queryWords)
    if (res && res.matchLength > tapOffset - tokenStart) {
      res.matchStart = tokenStart
      return res
    }
  }

  // Greedy fallback (also used while kuromoji is still loading).
  for (let start = 0; start <= tapOffset; start++) {
    const res = await matchAt(text.slice(start), queryWords)
    // The token spans [start, start + matchLength); keep it only if it covers the tap.
    if (res && res.matchLength > tapOffset - start) {
      res.matchStart = start
      return res
    }
  }
  return null
}
