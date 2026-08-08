import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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

import { lookupAt, lookup, isSegmenterReady } from './lookup'

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

/** A fresh copy of the module, so the private `RESULT_LRU` and the remembered
 *  "kuromoji build failed" flag start clean — needed by the tests that assert
 *  *first-tap* behaviour (the state a worker is in right after being rebuilt). */
async function freshLookup(): Promise<typeof import('./lookup')> {
  vi.resetModules()
  return import('./lookup')
}

beforeEach(() => {
  getWords.mockReset()
  ensureSegmenter.mockClear()
  // Restore the default (resolves immediately); individual tests override it to model a
  // slow, stalled or failing kuromoji build.
  ensureSegmenter.mockImplementation(async () => undefined)
  segmenterReadyValue = false
  tokenStartImpl = () => null
  // RESULT_LRU is module-private with no reset export; tests use distinct inputs to
  // avoid cross-test cache hits. The few that probe caching reuse one input deliberately.
})

afterEach(() => {
  vi.useRealTimers()
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

  it('falls back to greedy when the kuromoji token start yields no covering match', async () => {
    // kuromoji split 早起き and reports a token starting at 2 (き). Only a match that
    // *spans* the tap is usable, and nothing in the dictionary starts at き, so lookupAt
    // drops the token path and the greedy scan resolves the whole compound from 0.
    segmenterReadyValue = true
    tokenStartImpl = () => 2
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

  it('prefers the leftmost covering start over a longer match further right', async () => {
    // Both 決心 (start 0, len 2) and 心配性 (start 1, len 3) cover a tap on 心 (offset 1).
    // Across starts the *leftmost* wins — the tie-break that makes tapping any character
    // of a word resolve the word it begins, not the one it merely continues into.
    segmenterReadyValue = false
    tokenStartImpl = () => null
    setDict({
      決心: [word({ k: '決心', r: 'けっしん', pos: ['n'], glosses: ['determination'] })],
      心配性: [word({ k: '心配性', r: 'しんぱいしょう', pos: ['n'], glosses: ['worrier'] })],
    })

    const res = await lookupAt('決心配性', 1)
    expect(res!.matchStart).toBe(0)
    expect(res!.matchLength).toBe(2)
    expect(res!.entries[0].headword).toBe('決心')
  })
})

// --- Waiting for kuromoji before deciding the path -------------------------
//
// The tokenizer is *not* built for the first taps after the lookup worker is created,
// and the worker is recreated on every foreground (Reader.svelte sheds it when the PWA
// is backgrounded). Racing that build silently downgrades those taps to the greedy
// fallback, which returns a plausible-but-wrong span — so lookupAt waits for it, with a
// ceiling.
//
// 今日本 is the discriminating case: a tap on 日 (offset 1) is answered 今日 by greedy
// leftmost-covering (start 0) but 日本 by kuromoji (which tokenises 今 | 日本).

describe('lookupAt — kuromoji readiness', () => {
  const AMBIGUOUS = {
    今日: [word({ k: '今日', r: 'きょう', pos: ['n'], glosses: ['today'] })],
    日本: [word({ k: '日本', r: 'にほん', pos: ['n'], glosses: ['Japan'] })],
  }

  it('waits for a build that is still in flight, so the tap takes the morphological path', async () => {
    segmenterReadyValue = false
    tokenStartImpl = () => (segmenterReadyValue ? 1 : null)
    // The build completes a tick after the tap arrives — the post-foreground window.
    ensureSegmenter.mockImplementation(async () => {
      await Promise.resolve()
      segmenterReadyValue = true
      return undefined
    })
    setDict(AMBIGUOUS)

    const { lookupAt: fresh } = await freshLookup()
    const res = await fresh('今日本', 1)
    expect(res!.matchStart).toBe(1)
    expect(res!.entries[0].headword).toBe('日本')
  })

  it('answers greedily when the build never completes, without hanging the tap', async () => {
    vi.useFakeTimers()
    segmenterReadyValue = false
    tokenStartImpl = () => null
    ensureSegmenter.mockImplementation(() => new Promise<undefined>(() => {})) // never settles
    setDict(AMBIGUOUS)

    const { lookupAt: fresh } = await freshLookup()
    let settled = false
    const p = fresh('今日本', 1).then((r) => {
      settled = true
      return r
    })
    // Still waiting on the segmenter: nothing has been decided yet.
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)

    // Past the ceiling it degrades to greedy leftmost-covering rather than hanging.
    await vi.advanceTimersByTimeAsync(1200)
    const res = await p
    expect(settled).toBe(true)
    expect(res!.matchStart).toBe(0)
    expect(res!.entries[0].headword).toBe('今日')
  })

  it('stops waiting on the build once it has failed (offline, IPADIC not cached)', async () => {
    vi.useFakeTimers()
    segmenterReadyValue = false
    tokenStartImpl = () => null
    // A build that fails after 500 ms — i.e. inside the wait window, so the first tap
    // learns about the failure.
    ensureSegmenter.mockImplementation(
      () =>
        new Promise<undefined>((_resolve, reject) => {
          setTimeout(() => reject(new Error('IPADIC fetch failed')), 500)
        }),
    )
    setDict({
      今日: AMBIGUOUS.今日,
      日本: AMBIGUOUS.日本,
      猫: [word({ k: '猫', r: 'ねこ', pos: ['n'], glosses: ['cat'] })],
    })

    const { lookupAt: fresh } = await freshLookup()
    const first = fresh('今日本', 1)
    await vi.advanceTimersByTimeAsync(500)
    expect((await first)!.entries[0].headword).toBe('今日') // greedy

    // The failure is remembered: this tap must resolve with NO timers advanced (a second
    // 1200 ms wait per tap on a fetch that cannot succeed would be pure latency), so
    // awaiting it directly under fake timers would deadlock if it re-waited.
    const res = await fresh('猫', 0)
    expect(res!.entries[0].headword).toBe('猫')
  })

  it('reports segmenter readiness to the caller (isSegmenterReady)', () => {
    segmenterReadyValue = false
    expect(isSegmenterReady()).toBe(false)
    segmenterReadyValue = true
    expect(isSegmenterReady()).toBe(true)
  })
})

// --- Query fan-out bounds (MAX_WINDOW + the covering-span prune) -----------
//
// Every extra (start, length) pair is a deinflection pass plus one `getWords` per
// candidate, and each `getWords` opens three IndexedDB transactions — the dominant cost
// of a tap on iOS. Two bounds keep it in check, both asserted here as behaviour:
// MAX_WINDOW = 12, and "never probe a span that can't cover the tap".

describe('lookupAt / lookup — query fan-out bounds', () => {
  const TWELVE = 'あいうえおかきくけこさし' // 12 chars
  const THIRTEEN = TWELVE + 'す' // 13 chars

  it('matches a 12-character surface form (the window cap is inclusive)', async () => {
    setDict({ [TWELVE]: [word({ r: TWELVE, pos: ['n'], glosses: ['twelve'] })] })
    const res = await lookup(THIRTEEN)
    expect(res!.matchLength).toBe(12)
  })

  it('never probes past 12 characters', async () => {
    setDict({ [THIRTEEN]: [word({ r: THIRTEEN, pos: ['n'], glosses: ['thirteen'] })] })
    // The only entry is 13 chars long, so the capped window can't reach it.
    expect(await lookup(THIRTEEN)).toBeNull()
    expect(getWords.mock.calls.map(([t]) => t)).not.toContain(THIRTEEN)
  })

  it('skips greedy starts and lengths that cannot reach the tap', async () => {
    segmenterReadyValue = false
    tokenStartImpl = () => null
    setDict({}) // force the full scan — nothing matches, so no early exit
    // 20 distinct kanji (no kana, so deinflection adds nothing), tap on 万 at offset 12.
    const text = '一二三四五六七八九十百千万億兆京垓子丑寅'
    expect(await lookupAt(text, 12)).toBeNull()

    const terms = getWords.mock.calls.map(([t]) => t as string)
    expect(terms.length).toBeGreaterThan(0)
    // No span of length <= 12 starting at offset 0 can reach offset 12, so start 0 is
    // never probed at all.
    expect(terms.some((t) => t.startsWith('一'))).toBe(false)
    // And within a start, only lengths that reach the tap are probed — so the single
    // 1-character probe is the tapped character itself.
    expect(terms.filter((t) => t.length === 1)).toEqual(['万'])
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
