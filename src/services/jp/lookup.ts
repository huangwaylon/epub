import { getWords } from '@birchill/jpdict-idb'
import { toNormalized } from '@birchill/normal-jp'
import { deinflect, Reason, WordType, type CandidateWord } from './deinflect'
import { ensureSegmenter, segmenterReady, tokenSpanAt } from './segment'
import type { DictEntry, LookupResult, Sense } from './lookupTypes'

/** Whether kuromoji is built (else lookups take the greedy fallback). */
export { segmenterReady as isSegmenterReady } from './segment'

/** Longest surface span one `matchAt` probes. Each length costs a deinflection pass and
 *  a `getWords` (3 IndexedDB transactions) per candidate; 12 comfortably exceeds the
 *  longest dictionary unit found in real prose. */
const MAX_WINDOW = 12
/** `getWords` limit per queried term. */
const MAX_RESULTS = 8
/** Cap on entries in one result, after merging every candidate at the winning length. */
const MAX_ENTRIES = 10

/** How long a tap waits for an in-flight kuromoji build before answering greedily. */
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

/**
 * A deinflected candidate is valid only if the entry's POS is a word type the rule can
 * produce (10ten's `entryMatchesType`) — otherwise した → ichidan しる matches godan 知る.
 */
function candidateMatches(word: any, cand: CandidateWord): boolean {
  if (!cand.reasonChains.length) return true // original surface form — always allowed
  const pos: string[] = (word.s ?? []).flatMap((s: any) => s.pos ?? [])
  const has = (test: (p: string) => boolean) => pos.some(test)
  const t = cand.type
  return (
    (!!(t & WordType.IchidanVerb) && has((p) => p.startsWith('v1'))) ||
    (!!(t & WordType.GodanVerb) && has((p) => p.startsWith('v5') || p.startsWith('v4'))) ||
    (!!(t & WordType.IAdj) && has((p) => p.startsWith('adj-i'))) ||
    (!!(t & WordType.KuruVerb) && has((p) => p === 'vk')) ||
    (!!(t & WordType.SuruVerb) && has((p) => p.startsWith('vs-'))) ||
    (!!(t & WordType.SpecialSuruVerb) && has((p) => p === 'vs-s' || p === 'vz')) ||
    (!!(t & WordType.NounVS) && has((p) => p === 'vs'))
  )
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

/** Any JMdict priority tag (news/ichi/spec/gai…) on a kanji or reading form. */
function isCommon(w: any): boolean {
  return [...(w.k ?? []), ...(w.r ?? [])].some((f: any) => Array.isArray(f.p) && f.p.length > 0)
}

/**
 * Raw `getWords` record → `DictEntry`, using jpdict-idb's `matchRange` (the form searched)
 * and `match` (forms/senses that go with it) flags so the card shows the tapped form. A kana
 * hit heads with the kana if the word has no kanji or is usually kana (≥ half the matched
 * senses `uk`), else with the kanji it belongs to (した → 下).
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

  // Stable partition: matched senses first.
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

/** Per-tap memoised `getWords`. Caches the promise so parallel probes share one read; a
 *  failed read resolves `[]` so it can't abort the whole tap. */
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
 * Longest dictionary match at the start of `window`, via normalize → deinflect → JMdict.
 * All queries are fired up front (concurrent reads), then lengths are walked longest-first.
 *
 * At the winning length every candidate contributes (deduped by id): した is both the
 * surface of 下 and the past of する. Surface entries lead unless the span overruns the
 * kuromoji token it starts in (`tokenLen`) — 勉強した is 勉強|し|た, so する leads there,
 * while 机のした keeps 下 first. `minLen` skips lengths that can't span the tap (lossless).
 */
async function matchAt(
  window: string,
  queryWords: (t: string) => Promise<any[]>,
  minLen = 1,
  tokenLen?: number,
): Promise<LookupResult | null> {
  const limit = Math.min(window.length, MAX_WINDOW)
  if (minLen > limit) return null
  const perLen: { len: number; candidates: CandidateWord[] }[] = []
  for (let len = limit; len >= minLen; len--) {
    const sub = window.slice(0, len)
    const [normalized] = toNormalized(sub)
    if (!normalized) continue
    const candidates = deinflect(normalized)
    perLen.push({ len, candidates })
    for (const cand of candidates) void queryWords(cand.word)
  }

  // A likely spurious conjugation parse (deinflection-only, no common word, overruns the
  // token — したよう as volitional of obscure したる) is held back: the longest shorter
  // length with a common word wins, else it stands. Surface matches are never demoted.
  let fallback: LookupResult | null = null
  for (const { len, candidates } of perLen) {
    const surface: DictEntry[] = []
    const deinflected: DictEntry[] = []
    const rareDeinflected: DictEntry[] = []
    const seen = new Set<number>()
    let common = false
    for (const cand of candidates) {
      const words = await queryWords(cand.word)
      for (const w of words) {
        if (!candidateMatches(w, cand)) continue
        if (typeof w.id === 'number') {
          if (seen.has(w.id)) continue // the least-inflected candidate wins
          seen.add(w.id)
        }
        const isCom = isCommon(w)
        if (isCom) common = true
        const entry = toEntry(w, reasonsToLabels(cand.reasonChains))
        if (cand.reasonChains.length) (isCom ? deinflected : rareDeinflected).push(entry)
        else surface.push(entry)
      }
    }
    // Across candidates (different base words) common words lead; jpdict ranks within one.
    deinflected.push(...rareDeinflected)
    if (!surface.length && !deinflected.length) continue
    const crossesToken = tokenLen !== undefined && len > tokenLen
    const entries = (crossesToken ? [...deinflected, ...surface] : [...surface, ...deinflected]).slice(0, MAX_ENTRIES)
    const result: LookupResult = {
      matchStart: 0, // relative to `window`; lookupAt rebases it onto the full text
      matchLength: len,
      reasons: entries[0].reasons ?? [],
      entries,
    }
    if (fallback) {
      if (common) return result
      continue
    }
    if (crossesToken && !surface.length && !common) {
      fallback = result
      continue
    }
    return result
  }
  return fallback
}

/** Set after a failed build (e.g. offline, IPADIC not cached): taps stop waiting on the
 *  build but still retry it in the background. */
let segmenterUnavailable = false

/** Build kuromoji and, in parallel, open this worker's IndexedDB connection; `true` once built. */
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

/** Give an in-flight kuromoji build up to `SEGMENTER_WAIT_MS` before the tap picks a path:
 *  the greedy fallback returns plausible-but-wrong spans, and the worker rebuilds often. */
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
  // Folded to non-rejecting before the race, so a late failure isn't unhandled.
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
  /** Kuromoji was ready when the path was chosen (so `result` is cacheable). Captured
   *  before the IndexedDB reads: a build finishing mid-lookup must not promote a greedy answer. */
  ready: boolean
}

/**
 * The entry for the word containing `text[tapOffset]`. Matches from the start of the
 * kuromoji token under the tap; if kuromoji isn't ready (after `settleSegmenter`) or its
 * token matches nothing, falls back to greedy leftmost-covering: the leftmost start whose
 * match spans the tap (決 or 心 in 決心 both → 決心). Not cached here — see lookupClient.
 */
export async function resolveLookup(text: string, tapOffset: number): Promise<LookupReply> {
  if (tapOffset < 0 || tapOffset >= text.length) return { result: null, ready: segmenterReady() }

  await settleSegmenter()
  // Decide the path — and record it — synchronously.
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

  // Greedy fallback: probe every start that can reach the tap concurrently, then take the
  // leftmost hit.
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
