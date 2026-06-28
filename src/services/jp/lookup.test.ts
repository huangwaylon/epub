import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mocks -----------------------------------------------------------------
//
// The lookup pipeline talks to two collaborators we replace here:
//  * `@birchill/jpdict-idb`'s `getWords` — the IndexedDB JMdict reader. We back it
//    with an in-memory dictionary keyed by the *deinflected* term `lookup.ts` queries.
//  * `./segment` — kuromoji. We control `segmenterReady`/`tokenStartAt` so we can
//    exercise both the morphological (kuromoji) path and the greedy fallback, and
//    `ensureSegmenter` is a no-op so no ~19 MB dict load is attempted.
//
// `deinflect` and `@birchill/normal-jp`'s `toNormalized` stay REAL, so the tests use
// genuine Japanese surface forms and the real candidate generation.

const getWords = vi.fn<(term: string, opts: unknown) => Promise<any[]>>()
vi.mock('@birchill/jpdict-idb', () => ({
  getWords: (term: string, opts: unknown) => getWords(term, opts),
}))

let segmenterReadyValue = false
let tokenStartImpl: (text: string, tapOffset: number) => number | null = () => null
const ensureSegmenter = vi.fn(async () => undefined)
vi.mock('./segment', () => ({
  ensureSegmenter: () => ensureSegmenter(),
  segmenterReady: () => segmenterReadyValue,
  tokenStartAt: (text: string, tapOffset: number) => tokenStartImpl(text, tapOffset),
}))

import { lookupAt, lookup } from './lookup'

// --- Dictionary builders ---------------------------------------------------

/** A JMdict word as `getWords` would return it (jpdict-idb internal shape). */
function word(opts: {
  k?: string
  r: string
  pos: string[]
  glosses: string[]
  accent?: number
}): any {
  return {
    k: opts.k ? [{ ent: opts.k }] : undefined,
    r: [{ ent: opts.r, a: opts.accent }],
    s: [{ pos: opts.pos, g: opts.glosses.map((str) => ({ str })) }],
  }
}

/** Install an in-memory dictionary; `getWords(term)` returns `dict[term] ?? []`. */
function setDict(dict: Record<string, any[]>): void {
  getWords.mockImplementation(async (term: string) => dict[term] ?? [])
}

beforeEach(() => {
  getWords.mockReset()
  ensureSegmenter.mockClear()
  segmenterReadyValue = false
  tokenStartImpl = () => null
  // RESULT_LRU is module-private with no reset export; tests use distinct inputs to
  // avoid cross-test cache hits. The few that probe caching reuse one input deliberately.
})

// --- lookupAt --------------------------------------------------------------

describe('lookupAt', () => {
  it('returns null for an out-of-bounds tapOffset (negative or >= length)', async () => {
    setDict({})
    expect(await lookupAt('猫', -1)).toBeNull()
    expect(await lookupAt('猫', 5)).toBeNull()
    expect(await lookupAt('', 0)).toBeNull()
    // Out-of-bounds short-circuits before any dictionary read.
    expect(getWords).not.toHaveBeenCalled()
  })

  it('resolves the whole word from a mid-word tap via the kuromoji token path', async () => {
    // kuromoji says the token "決心" starts at index 0; a tap on the 2nd char (心)
    // must still resolve 決心 because matchAt runs from the token start.
    segmenterReadyValue = true
    tokenStartImpl = (_text, _off) => 0
    setDict({ 決心: [word({ k: '決心', r: 'けっしん', pos: ['n'], glosses: ['determination'] })] })

    const res = await lookupAt('決心', 1)
    expect(res).not.toBeNull()
    expect(res!.matchStart).toBe(0)
    expect(res!.matchLength).toBe(2)
    expect(res!.entries[0].headword).toBe('決心')
    expect(res!.reasons).toEqual([])
  })

  it('falls back to greedy leftmost-covering when kuromoji is not ready', async () => {
    // segmenterReady is false and tokenStartAt returns null -> greedy scan from start.
    segmenterReadyValue = false
    tokenStartImpl = () => null
    setDict({ 決心: [word({ k: '決心', r: 'けっしん', pos: ['n'], glosses: ['determination'] })] })

    // Tap the 2nd char; greedy scan starts at 0, finds 決心 spanning the tap.
    const res = await lookupAt('決心', 1)
    expect(res).not.toBeNull()
    expect(res!.matchStart).toBe(0)
    expect(res!.matchLength).toBe(2)
    expect(res!.entries[0].headword).toBe('決心')
  })

  it('prefers the longest covering match in the greedy fallback', async () => {
    // Both 決 and 決心 are in the dict; a tap at offset 0 should take the longest
    // match that still covers the tap (決心), not the 1-char 決.
    segmenterReadyValue = false
    tokenStartImpl = () => null
    setDict({
      決: [word({ k: '決', r: 'けつ', pos: ['n'], glosses: ['decision'] })],
      決心: [word({ k: '決心', r: 'けっしん', pos: ['n'], glosses: ['determination'] })],
    })

    const res = await lookupAt('決心', 0)
    expect(res!.matchLength).toBe(2)
    expect(res!.entries[0].headword).toBe('決心')
  })

  it('returns null when nothing in the dictionary covers the tap', async () => {
    segmenterReadyValue = false
    setDict({}) // empty dictionary
    expect(await lookupAt('猫犬', 0)).toBeNull()
  })

  describe('RESULT_LRU caching', () => {
    it('a repeat lookup hits the cache and avoids a second getWords', async () => {
      segmenterReadyValue = false
      tokenStartImpl = () => null
      setDict({ 山: [word({ k: '山', r: 'やま', pos: ['n'], glosses: ['mountain'] })] })

      const first = await lookupAt('山', 0)
      const callsAfterFirst = getWords.mock.calls.length
      expect(callsAfterFirst).toBeGreaterThan(0)

      const second = await lookupAt('山', 0)
      // Identical input + readiness -> same cache key -> served from LRU, no new reads.
      expect(getWords.mock.calls.length).toBe(callsAfterFirst)
      expect(second).toEqual(first)
    })

    it('ready vs not-ready produce distinct cache keys (segmenterReady is part of the key)', async () => {
      tokenStartImpl = () => 0
      setDict({ 川: [word({ k: '川', r: 'かわ', pos: ['n'], glosses: ['river'] })] })

      segmenterReadyValue = false
      await lookupAt('川', 0)
      const callsNotReady = getWords.mock.calls.length

      // Flip readiness: same text/offset but a different LRU key, so it re-queries.
      segmenterReadyValue = true
      await lookupAt('川', 0)
      expect(getWords.mock.calls.length).toBeGreaterThan(callsNotReady)
    })
  })

  it('keeps the kuromoji token only if it actually covers the tap, else falls back', async () => {
    // kuromoji claims a 1-char token starting at 0, but the tap is at offset 2.
    // matchAt from the token start yields matchLength 1, which does NOT cover offset 2
    // (1 > 2-0 is false), so lookupAt drops it and the greedy scan resolves the word.
    segmenterReadyValue = true
    tokenStartImpl = () => 0
    setDict({
      早: [word({ k: '早', r: 'はや', pos: ['pref'], glosses: ['early'] })],
      早起き: [word({ k: '早起き', r: 'はやおき', pos: ['n', 'vs'], glosses: ['early rising'] })],
    })

    const res = await lookupAt('早起き', 2)
    expect(res).not.toBeNull()
    expect(res!.matchStart).toBe(0)
    expect(res!.matchLength).toBe(3)
    expect(res!.entries[0].headword).toBe('早起き')
  })
})

// --- matchAt (exercised via the forward-only `lookup` wrapper) -------------

describe('matchAt (via lookup)', () => {
  it('returns the longest match starting at the window head', async () => {
    setDict({
      日: [word({ k: '日', r: 'ひ', pos: ['n'], glosses: ['day'] })],
      日本: [word({ k: '日本', r: 'にほん', pos: ['n'], glosses: ['Japan'] })],
      日本語: [word({ k: '日本語', r: 'にほんご', pos: ['n'], glosses: ['Japanese language'] })],
    })

    const res = await lookup('日本語')
    expect(res!.matchLength).toBe(3)
    expect(res!.entries[0].headword).toBe('日本語')
    expect(res!.matchStart).toBe(0)
  })

  it('rejects a deinflected candidate whose dictionary entry is not inflectable', async () => {
    // 食べた deinflects to 食べる (past). If the only entry for 食べる is tagged as a
    // plain noun (not inflectable), the deinflected candidate must be rejected by the
    // INFLECTABLE filter — so no past-tense verb match is produced for 食べた.
    setDict({
      食べた: [], // no surface-form entry
      食べる: [word({ k: '食べる', r: 'たべる', pos: ['n'], glosses: ['bogus noun'] })],
    })

    const res = await lookup('食べた')
    expect(res).toBeNull()
  })

  it('accepts a deinflected candidate when the entry IS inflectable (v1)', async () => {
    // Same input, but now 食べる is a real ichidan verb (v1, inflectable). The
    // deinflection 食べた -> 食べる (past) is accepted and the reason chain surfaces.
    setDict({
      食べた: [],
      食べる: [word({ k: '食べる', r: 'たべる', pos: ['v1', 'vt'], glosses: ['to eat'] })],
    })

    const res = await lookup('食べた')
    expect(res).not.toBeNull()
    expect(res!.entries[0].headword).toBe('食べる')
    expect(res!.reasons).toContain('past')
  })

  it('always accepts the original surface form even with a non-inflectable POS', async () => {
    // 猫 is a plain noun with no deinflection (reasonChains empty) -> always valid.
    setDict({ 猫: [word({ k: '猫', r: 'ねこ', pos: ['n'], glosses: ['cat'] })] })

    const res = await lookup('猫')
    expect(res).not.toBeNull()
    expect(res!.matchLength).toBe(1)
    expect(res!.reasons).toEqual([])
    expect(res!.entries[0].senses[0].pos).toContain('noun')
  })

  it('degrades a transient getWords rejection to "no match" (does not propagate)', async () => {
    // The query cache wraps getWords with .catch(() => []), so one failed read is an
    // empty result for that candidate rather than a rejected lookup.
    getWords.mockRejectedValue(new Error('IndexedDB hiccup'))
    await expect(lookup('猫')).resolves.toBeNull()
  })

  it('still resolves matches when only SOME probes reject (rejection is per-term)', async () => {
    getWords.mockImplementation(async (term: string) => {
      if (term === '犬') return [word({ k: '犬', r: 'いぬ', pos: ['n'], glosses: ['dog'] })]
      throw new Error('IndexedDB hiccup')
    })
    const res = await lookup('犬')
    expect(res).not.toBeNull()
    expect(res!.entries[0].headword).toBe('犬')
  })
})

// --- POS label rendering (incl. newly-added vz / vn / vr) ------------------

describe('POS label rendering', () => {
  const cases: { code: string; label: string }[] = [
    { code: 'vz', label: 'irregular する verb' },
    { code: 'vn', label: 'irregular verb' },
    { code: 'vr', label: 'irregular verb' },
    { code: 'n', label: 'noun' },
    { code: 'v1', label: 'ichidan verb' },
    { code: 'v5u', label: 'godan verb' }, // v5* prefix fallback
    { code: 'adj-na', label: 'な-adjective' },
  ]

  for (const { code, label } of cases) {
    it(`renders POS code "${code}" as "${label}"`, async () => {
      // Surface-form lookup (no deinflection) so the entry is always kept; the
      // rendered sense.pos is posLabel(code), asserted indirectly via lookup output.
      setDict({ テスト: [word({ k: 'テスト', r: 'てすと', pos: [code], glosses: ['test'] })] })
      const res = await lookup('テスト')
      expect(res!.entries[0].senses[0].pos).toEqual([label])
    })
  }
})
