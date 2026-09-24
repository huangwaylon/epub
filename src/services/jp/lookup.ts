import { getWords } from '@birchill/jpdict-idb'
import { toNormalized } from '@birchill/normal-jp'
import { deinflect, Reason, type CandidateWord } from './deinflect'
import { ensureSegmenter, segmenterReady, tokenSpanAt } from './segment'
import type { DictEntry, LookupResult, Sense } from './lookupTypes'

export type { Sense, DictEntry, LookupResult } from './lookupTypes'

/** Longest surface span (in characters) a single `matchAt` will probe.
 *
 *  Every extra length costs one deinflection pass **and** a `getWords` per candidate —
 *  and each `getWords` opens three IndexedDB transactions internally, so the tail of
 *  this range is the most expensive part of a tap and the least likely to pay off.
 *  Measured over the ~137k characters of プロローグ〜エピローグ in また、同じ夢を見ていた
 *  (124,298 tap positions): the sub-window from a kuromoji token start averages 8.8
 *  chars, the longest IPADIC lexicon entry occurring *anywhere* in the book is 8 chars,
 *  and of the 110,949 distinct 13–16-char spans a tap would otherwise probe, **zero**
 *  are a single known dictionary unit — they are all multi-clause fragments
 *  (のかもしれないと思いました). 12 keeps a comfortable margin over the 8-char observed
 *  maximum for JMdict compounds that IPADIC splits, while cutting the warm token path
 *  from ~21 to ~17 distinct queried terms and the greedy fallback from ~204 to ~100. */
const MAX_WINDOW = 12
/** `getWords` limit per queried term. */
const MAX_RESULTS = 8
/** Cap on entries in one result, after merging every candidate at the winning length. */
const MAX_ENTRIES = 10

/** How long a tap will wait for the kuromoji build before giving up and taking the
 *  greedy fallback. The morphological path is what makes a tap land on the *right*
 *  word, so a tap should prefer to wait for it — but never at the cost of an
 *  unresponsive popup. The trie build is well under a second from the Cache API, so
 *  1.2 s covers a rebuild (the worker is shed after 60 s in the background and on reader
 *  exit, then rebuilt on return) without ever stalling the UI for long. */
const SEGMENTER_WAIT_MS = 1200

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
  vz: 'irregular する verb',
  vn: 'irregular verb',
  vr: 'irregular verb',
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

/** JMdict `misc` codes worth surfacing, labelled. Unlisted codes pass through raw. */
const MISC_LABELS: Record<string, string> = {
  uk: 'usually kana',
  abbr: 'abbreviation',
  arch: 'archaic',
  col: 'colloquial',
  dated: 'dated',
  derog: 'derogatory',
  fam: 'familiar',
  fem: 'female term',
  male: 'male term',
  form: 'formal',
  hon: 'honorific',
  hum: 'humble',
  pol: 'polite',
  id: 'idiomatic',
  joc: 'jocular',
  obs: 'obsolete',
  'on-mim': 'onomatopoeia',
  poet: 'poetic',
  proverb: 'proverb',
  rare: 'rare',
  sens: 'sensitive',
  sl: 'slang',
  vulg: 'vulgar',
  yoji: 'four-character idiom',
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

function toSense(s: any): Sense {
  const sense: Sense = {
    pos: (s.pos ?? []).map(posLabel),
    glosses: (s.g ?? []).map((g: any) => g.str),
  }
  if (s.misc?.length) sense.misc = s.misc.map((m: string) => MISC_LABELS[m] ?? m)
  if (typeof s.match === 'boolean') sense.matched = s.match
  return sense
}

/**
 * Raw `getWords` record → `DictEntry`, honouring jpdict-idb's match metadata so the
 * popup shows the form that was actually tapped:
 *
 * - `k[i].matchRange` / `r[i].matchRange` mark the spelling the search hit; `match`
 *   marks every kanji/kana form that goes with it (a kanji hit flags its readings, a kana
 *   hit flags the kanji it is a reading of), and `s[i].match` the senses that apply.
 * - A **kanji** hit shows that spelling with its first applicable reading.
 * - A **kana** hit shows the kana as the headword when the word is usually written in
 *   kana (most matched senses tagged `uk`, e.g. する) or has no kanji; otherwise the
 *   first kanji that reading belongs to (した → 下, not the entry's first spelling).
 * - Matched senses come first. Records without match metadata keep the old behaviour
 *   (first kanji, first reading, senses in order).
 */
function toEntry(w: any, reasons: string[]): DictEntry {
  const ks: any[] = w.k ?? []
  const rs: any[] = w.r ?? []
  const ss: any[] = w.s ?? []
  const kHit = ks.find((k) => k.matchRange)
  const rHit = rs.find((r) => r.matchRange)
  const readingRec = rHit ?? rs.find((r) => r.match) ?? rs[0]
  const reading: string = readingRec?.ent ?? ''

  const matchedSenses = ss.filter((s) => s.match !== false)
  const ukCount = matchedSenses.filter((s) => s.misc?.includes('uk')).length
  const usuallyKana = matchedSenses.length > 0 && ukCount * 2 >= matchedSenses.length

  let headword: string
  if (kHit) headword = kHit.ent
  else if (!ks.length || (rHit && usuallyKana)) headword = reading
  else headword = (ks.find((k) => k.match) ?? ks[0]).ent

  // Stable partition: senses that apply to the matched form first.
  const senses = [...matchedSenses, ...ss.filter((s) => s.match === false)].map(toSense)
  const entry: DictEntry = {
    headword,
    reading,
    kanaOnly: !ks.length || headword === reading,
    pitch: readingAccent(readingRec?.a),
    senses,
    reasons,
  }
  if (typeof w.id === 'number') entry.id = w.id
  return entry
}

/** A memoised `getWords` so the many length/start probes for one tap share queries.
 *  Caches the *promise* (not the resolved array) so concurrent probes for the same
 *  term — fired in parallel by `matchAt` — collapse onto a single IndexedDB read.
 *  A rejected read (e.g. a transient IndexedDB hiccup on iOS) resolves to an empty
 *  array rather than a rejected promise, so one failed probe degrades to "no match
 *  for this candidate" instead of aborting the whole tap's lookup. */
function makeQueryCache(): (term: string) => Promise<any[]> {
  const cache = new Map<string, Promise<any[]>>()
  return (term: string): Promise<any[]> => {
    let p = cache.get(term)
    if (!p) {
      p = getWords(term, { matchType: 'exact', limit: MAX_RESULTS }).catch(() => [])
      cache.set(term, p)
    }
    return p
  }
}

/**
 * Longest dictionary match starting at the *beginning* of `window`, trying
 * deinflected forms (10ten-style). Returns null if nothing matches. `matchLength`
 * is the number of surface characters consumed.
 *
 * All candidate queries (across every length and deinflection) are fired into the
 * shared cache up front so the IndexedDB reads run concurrently rather than as a
 * serial `await` chain; we then walk lengths longest-first and stop at the first length
 * with any match, reading each result from the now-resolved cache.
 *
 * **At the winning length every candidate contributes** — the surface form *and* each
 * deinflection — deduped by entry id, each entry carrying its own reasons. Taking only
 * the first candidate with a hit made kana verbs resolve to nouns: した is both the
 * surface of 下/舌 and the past of する, and the surface form is always candidate #0.
 *
 * Ordering among them: surface-form entries first, **unless** the matched span runs past
 * the end of the kuromoji token it starts in (`tokenLen`), in which case the deinflected
 * entries come first. That is exactly the kana-verb case — IPADIC splits 勉強した as
 * 勉強|し|た, so "した" crossing a boundary means the verb し + past た (→ する), while
 * 机の下 / 机のした keeps 下|した as one token and the noun stays first.
 *
 * `minLen` skips lengths the caller would throw away anyway. `lookupAt` only keeps a
 * match that *spans the tap*, so from a start `s` with the tap at `t` no length
 * `<= t - s` can ever be used; probing them is pure IndexedDB waste. It is a lossless
 * bound, not a heuristic — see `lookupAt`.
 */
async function matchAt(
  window: string,
  queryWords: (t: string) => Promise<any[]>,
  minLen = 1,
  tokenLen?: number,
): Promise<LookupResult | null> {
  const limit = Math.min(window.length, MAX_WINDOW)
  if (minLen > limit) return null // no usable length at this start — don't query at all
  const perLen: { len: number; candidates: CandidateWord[] }[] = []
  for (let len = limit; len >= minLen; len--) {
    const sub = window.slice(0, len)
    const [normalized] = toNormalized(sub)
    if (!normalized) continue
    const candidates = deinflect(normalized)
    perLen.push({ len, candidates })
    // Kick off (and cache) every candidate query without awaiting — they run in parallel.
    for (const cand of candidates) void queryWords(cand.word)
  }

  for (const { len, candidates } of perLen) {
    const surface: DictEntry[] = []
    const deinflected: DictEntry[] = []
    const seen = new Set<number>()
    for (const cand of candidates) {
      const words = await queryWords(cand.word)
      for (const w of words) {
        if (!candidateMatches(w, cand)) continue
        if (typeof w.id === 'number') {
          if (seen.has(w.id)) continue // first (i.e. least-inflected) candidate wins
          seen.add(w.id)
        }
        const entry = toEntry(w, reasonsToLabels(cand.reasonChains))
        ;(cand.reasonChains.length ? deinflected : surface).push(entry)
      }
    }
    if (!surface.length && !deinflected.length) continue
    const crossesToken = tokenLen !== undefined && len > tokenLen
    const entries = (crossesToken ? [...deinflected, ...surface] : [...surface, ...deinflected]).slice(0, MAX_ENTRIES)
    return {
      matchStart: 0, // relative to `window`; lookupAt rebases it onto the full text
      matchLength: len,
      reasons: entries[0].reasons ?? [],
      entries,
    }
  }
  return null
}

/** Set once a kuromoji build has failed (typically: offline before the IPADIC dict was
 *  cached). Taps then stop *waiting* on the build — they'd burn `SEGMENTER_WAIT_MS`
 *  each on a fetch that cannot succeed — but still kick off a background retry, so the
 *  moment it does succeed subsequent taps take the morphological path again. */
let segmenterUnavailable = false

/** Eagerly build the kuromoji tokenizer (e.g. when a book opens, or right after the
 *  dictionary download) so the first tap takes the fast morphological path rather than
 *  the greedy fallback. Also opens the worker's IndexedDB connection (a one-row
 *  `getWords`), in parallel, so the first tap doesn't pay that either. Resolves `true`
 *  once the tokenizer is built (dict fetched), or `false` if the build/fetch failed. */
export async function warmup(): Promise<boolean> {
  void getWords('の', { matchType: 'exact', limit: 1 }).catch(() => [])
  try {
    await ensureSegmenter()
    segmenterUnavailable = false
    return true
  } catch {
    return false
  }
}

/** Whether kuromoji is built — i.e. whether a lookup right now resolves word boundaries
 *  morphologically or falls back to greedy leftmost-covering. */
export function isSegmenterReady(): boolean {
  return segmenterReady()
}

/**
 * Give the kuromoji build a bounded chance to finish before this tap decides which path
 * to take. Without this a tap fired while the tokenizer is still building silently falls
 * into the greedy fallback and returns a plausible-but-wrong span — and since the worker
 * is rebuilt after every long backgrounding and every reader re-open, that window recurs,
 * not just once per session. Accuracy is worth a bounded wait; a hang is not, so a build
 * slower than `SEGMENTER_WAIT_MS` (or one that has already failed) still degrades to
 * greedy.
 */
async function settleSegmenter(): Promise<void> {
  if (segmenterReady()) return
  if (segmenterUnavailable) {
    void ensureSegmenter().then(
      () => {
        segmenterUnavailable = false
      },
      () => {},
    )
    return
  }
  // The build promise is folded to a non-rejecting one *before* the race, so a failure
  // arriving after the timeout can't surface as an unhandled rejection.
  const build = ensureSegmenter().then(
    () => {},
    () => {
      segmenterUnavailable = true
    },
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      build,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SEGMENTER_WAIT_MS)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** A lookup result plus which path produced it. */
export interface LookupReply {
  result: LookupResult | null
  /** Whether kuromoji was ready **when the path was chosen** — i.e. whether `result` is
   *  the authoritative morphological answer (cacheable across worker lifetimes) or a
   *  provisional greedy one. Captured at decision time, not after the IndexedDB reads: a
   *  build finishing *during* a greedy tap's queries must not promote that answer. */
  ready: boolean
}

/**
 * Returns the dictionary entry for the word that contains the character at
 * `tapOffset` in `text` — so tapping *any* character of a word resolves the whole
 * word, not just the run from the tapped character forward.
 *
 * Word boundaries come from **kuromoji** (MeCab-style IPADIC morphological analysis,
 * `segment.ts`): we take the token containing the tap and run `matchAt` from its
 * start (so deinflection + JMdict glosses still apply, and a JMdict compound longer
 * than the IPADIC token is still found). kuromoji loads lazily, and a tap gives that
 * build a bounded wait (`settleSegmenter`) rather than racing it, because answering from
 * the greedy fallback while the tokenizer is a few hundred ms from ready is how a tap
 * returns the *wrong* word. If the build is slower than that (or has failed) — or if
 * kuromoji split a word JMdict lemmatises differently — we fall back to **greedy
 * leftmost-covering**: take the leftmost start whose longest match spans the tap (the
 * leftmost, most complete word — tapping 決 or 心 in 決心 both resolve 決心).
 *
 * Both paths pass a `minLen` to `matchAt`: a match from start `s` is only usable if it
 * spans the tap, i.e. `matchLength > tapOffset - s`, so shorter lengths are never
 * queried and starts further left than `MAX_WINDOW` from the tap are skipped entirely
 * (they cannot reach it). This is exact — the leftmost covering match is unchanged — and
 * roughly halves the IndexedDB fan-out of a fallback tap.
 *
 * There is no result cache here: `lookupClient` keeps one on the main thread (which,
 * unlike anything in this worker, survives the worker being shed).
 */
export async function resolveLookup(text: string, tapOffset: number): Promise<LookupReply> {
  if (tapOffset < 0 || tapOffset >= text.length) return { result: null, ready: segmenterReady() }

  // Prefer the morphological path: wait (briefly) for the tokenizer before deciding.
  await settleSegmenter()
  // Decide the path — and record it — synchronously, right here.
  const ready = segmenterReady()
  const token = ready ? tokenSpanAt(text, tapOffset) : null

  const queryWords = makeQueryCache()

  if (token) {
    const res = await matchAt(
      text.slice(token.start),
      queryWords,
      tapOffset - token.start + 1,
      token.end - token.start,
    )
    if (res) {
      res.matchStart = token.start
      return { result: res, ready }
    }
  }

  // Greedy fallback. Starts more than MAX_WINDOW - 1 chars left of the tap can't produce
  // a span that reaches it, so the scan begins at the leftmost start that still can. All
  // starts are probed concurrently (sharing the per-tap query cache, so overlapping
  // candidates — and the token-path probes above — aren't re-queried), then read in
  // left-to-right order so the leftmost covering match still wins.
  const starts: number[] = []
  for (let s = Math.max(0, tapOffset - MAX_WINDOW + 1); s <= tapOffset; s++) starts.push(s)
  const probes = starts.map((s) =>
    matchAt(text.slice(s), queryWords, tapOffset - s + 1).catch(() => null),
  )
  for (let i = 0; i < probes.length; i++) {
    const res = await probes[i]
    if (res) {
      res.matchStart = starts[i]
      return { result: res, ready }
    }
  }
  return { result: null, ready }
}

/** `resolveLookup` without the readiness tag. */
export async function lookupAt(text: string, tapOffset: number): Promise<LookupResult | null> {
  return (await resolveLookup(text, tapOffset)).result
}
