import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Unit tests for segment.ts's gating and span mapping against a fake kuromoji. (The real
 * dictionary — and equivalence with stock `tokenize()` — is covered by
 * segment.golden.test.ts.)
 *
 * The fake tokenizer exposes only what `tokenSpans` reads: `getLattice(sentence)` and
 * `viterbi_searcher.search(lattice)`, returning best-path nodes shaped like kuromoji's
 * `ViterbiNode` (`start_pos` is 1-based within the sentence).
 */
type FakeNode = { start_pos: number; surface_form: string }

/** Best-path nodes for a sentence made of these surface forms. */
function pathOf(...surfaces: string[]): FakeNode[] {
  let pos = 1
  return surfaces.map((surface_form) => {
    const node = { start_pos: pos, surface_form }
    pos += surface_form.length
    return node
  })
}

/**
 * The current segmentation behaviour: sentence → best path. `null` simulates a failed
 * build (the `build` callback is invoked with an error).
 */
let pathImpl: ((sentence: string) => FakeNode[]) | null = null

vi.mock('@sglkc/kuromoji', () => ({
  builder: () => ({
    build(cb: (err: Error | null, tok: unknown) => void) {
      if (!pathImpl) {
        cb(new Error('kuromoji build failed (test)'), null)
        return
      }
      cb(null, {
        getLattice: (sentence: string) => sentence,
        viterbi_searcher: { search: (sentence: string) => pathImpl!(sentence) },
      })
    },
  }),
}))

/** Fresh module-private state (`tokenizer`/`buildPromise`) per import. */
async function loadModule() {
  return import('./segment')
}

beforeEach(() => {
  vi.resetModules()
  pathImpl = null
})

describe('segment — segmenterReady / ensureSegmenter gating', () => {
  it('reports not-ready and returns null from tokenSpanAt before ensureSegmenter resolves', async () => {
    pathImpl = () => pathOf('猫', 'が')
    const { segmenterReady, tokenSpanAt } = await loadModule()
    expect(segmenterReady()).toBe(false)
    expect(tokenSpanAt('猫が', 0)).toBe(null)
  })

  it('segmenterReady flips to true only after ensureSegmenter resolves', async () => {
    pathImpl = () => pathOf('猫')
    const { segmenterReady, ensureSegmenter } = await loadModule()
    expect(segmenterReady()).toBe(false)
    await ensureSegmenter()
    expect(segmenterReady()).toBe(true)
  })

  it('clears buildPromise on rejection so a retry can rebuild', async () => {
    pathImpl = null
    const { ensureSegmenter, segmenterReady } = await loadModule()
    await expect(ensureSegmenter()).rejects.toThrow(/kuromoji build failed/)
    expect(segmenterReady()).toBe(false)

    pathImpl = () => pathOf('猫')
    await expect(ensureSegmenter()).resolves.toBeDefined()
    expect(segmenterReady()).toBe(true)
  })
})

describe('tokenSpanAt — after the tokenizer is loaded', () => {
  it('returns the whole token span for a mid-word tap', async () => {
    // 食べる(0..2) | が(3) | 好き(4..5)
    pathImpl = () => pathOf('食べる', 'が', '好き')
    const { ensureSegmenter, tokenSpanAt } = await loadModule()
    await ensureSegmenter()
    expect(tokenSpanAt('食べるが好き', 1)).toEqual({ start: 0, end: 3 })
  })

  it('resolves boundary taps: first char, last char, and the next token start', async () => {
    pathImpl = () => pathOf('食べる', 'が', '好き')
    const { ensureSegmenter, tokenSpanAt } = await loadModule()
    await ensureSegmenter()
    const text = '食べるが好き'
    expect(tokenSpanAt(text, 0)).toEqual({ start: 0, end: 3 })
    expect(tokenSpanAt(text, 2)).toEqual({ start: 0, end: 3 })
    expect(tokenSpanAt(text, 3)).toEqual({ start: 3, end: 4 })
    expect(tokenSpanAt(text, 4)).toEqual({ start: 4, end: 6 })
    expect(tokenSpanAt(text, 5)).toEqual({ start: 4, end: 6 })
  })

  it('offsets later sentences by their real position (split after 、/。)', async () => {
    // kuromoji segments each sentence separately; start_pos restarts at 1 in each.
    pathImpl = (s) => (s === '猫が、' ? pathOf('猫', 'が', '、') : pathOf('好き'))
    const { ensureSegmenter, tokenSpanAt } = await loadModule()
    await ensureSegmenter()
    expect(tokenSpanAt('猫が、好き', 4)).toEqual({ start: 3, end: 5 })
  })

  it('returns null when the tap offset is outside every token', async () => {
    pathImpl = () => pathOf('猫', 'が')
    const { ensureSegmenter, tokenSpanAt } = await loadModule()
    await ensureSegmenter()
    expect(tokenSpanAt('猫が', 5)).toBe(null)
  })

  it('returns null when segmentation throws', async () => {
    pathImpl = () => {
      throw new Error('lattice blew up')
    }
    const { ensureSegmenter, tokenSpanAt } = await loadModule()
    await ensureSegmenter()
    expect(tokenSpanAt('猫が', 0)).toBe(null)
  })
})
