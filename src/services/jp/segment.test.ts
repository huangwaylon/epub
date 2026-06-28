import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tokens shaped like kuromoji's `IpadicFeatures` — only the fields `tokenStartAt`
 * actually reads (`surface_form`, `word_position`). `word_position` is 1-based.
 */
type FakeToken = { surface_form: string; word_position: number }

/**
 * Build a contiguous token list from surface forms, assigning each a correct
 * 1-based `word_position` (so the first token starts at position 1 / offset 0).
 */
function tokensOf(...surfaces: string[]): FakeToken[] {
  let pos = 1
  return surfaces.map((surface_form) => {
    const token = { surface_form, word_position: pos }
    pos += surface_form.length
    return token
  })
}

/**
 * The current tokenizer behaviour the kuromoji mock should use. Each test sets
 * this before importing the module so the mocked `build` callback resolves with a
 * tokenizer whose `tokenize` delegates here. `null` simulates a failed build (the
 * `build` callback is invoked with an error).
 */
let tokenizeImpl: ((text: string) => FakeToken[]) | null = null

vi.mock('@sglkc/kuromoji', () => ({
  builder: () => ({
    build(cb: (err: Error | null, tok: unknown) => void) {
      if (!tokenizeImpl) {
        cb(new Error('kuromoji build failed (test)'), null)
        return
      }
      cb(null, { tokenize: (text: string) => tokenizeImpl!(text) })
    },
  }),
}))

/** Fresh module-private state (`tokenizer`/`buildPromise`) per import. */
async function loadModule() {
  return import('./segment')
}

beforeEach(() => {
  vi.resetModules()
  tokenizeImpl = null
})

describe('segment — segmenterReady / ensureSegmenter gating', () => {
  it('reports not-ready and returns null from tokenStartAt before ensureSegmenter resolves', async () => {
    tokenizeImpl = () => tokensOf('猫', 'が')
    const { segmenterReady, tokenStartAt } = await loadModule()
    expect(segmenterReady()).toBe(false)
    expect(tokenStartAt('猫が', 0)).toBe(null)
  })

  it('segmenterReady flips to true only after ensureSegmenter resolves', async () => {
    tokenizeImpl = () => tokensOf('猫')
    const { segmenterReady, ensureSegmenter } = await loadModule()
    expect(segmenterReady()).toBe(false)
    await ensureSegmenter()
    expect(segmenterReady()).toBe(true)
  })

  it('clears buildPromise on rejection so a retry can rebuild', async () => {
    // First build fails (tokenizeImpl null -> build cb invoked with an error).
    tokenizeImpl = null
    const { ensureSegmenter, segmenterReady } = await loadModule()
    await expect(ensureSegmenter()).rejects.toThrow(/kuromoji build failed/)
    expect(segmenterReady()).toBe(false)

    // A later call retries the build; this time it succeeds.
    tokenizeImpl = () => tokensOf('猫')
    await expect(ensureSegmenter()).resolves.toBeDefined()
    expect(segmenterReady()).toBe(true)
  })
})

describe('tokenStartAt — after the tokenizer is loaded', () => {
  it('returns the token start for a mid-word tap (word_position - 1)', async () => {
    // 食べる(0..2) | が(3) | 好き(4..5)
    tokenizeImpl = () => tokensOf('食べる', 'が', '好き')
    const { ensureSegmenter, tokenStartAt } = await loadModule()
    await ensureSegmenter()
    // Tap on the middle char 'べ' of 食べる -> start of 食べる is 0.
    expect(tokenStartAt('食べるが好き', 1)).toBe(0)
  })

  it('resolves boundary taps: first char, last char, and the next token start', async () => {
    // 食べる occupies offsets 0,1,2; が occupies offset 3; 好き occupies 4,5.
    tokenizeImpl = () => tokensOf('食べる', 'が', '好き')
    const { ensureSegmenter, tokenStartAt } = await loadModule()
    await ensureSegmenter()
    const text = '食べるが好き'
    expect(tokenStartAt(text, 0)).toBe(0) // first char of 食べる
    expect(tokenStartAt(text, 2)).toBe(0) // last char of 食べる (start + len - 1)
    expect(tokenStartAt(text, 3)).toBe(3) // first char of the next token が
    expect(tokenStartAt(text, 4)).toBe(4) // first char of 好き
    expect(tokenStartAt(text, 5)).toBe(4) // last char of 好き
  })

  it('converts 1-based word_position to 0-based for a token not at index 0', async () => {
    // First token 私(offset 0), then は(offset 1), then 学生(offsets 2,3).
    tokenizeImpl = () => tokensOf('私', 'は', '学生')
    const { ensureSegmenter, tokenStartAt } = await loadModule()
    await ensureSegmenter()
    // 学生 has word_position 3 -> 0-based start 2. Tap the 2nd char '生' (offset 3).
    expect(tokenStartAt('私は学生', 3)).toBe(2)
  })

  it('returns null when the tap offset is outside every token', async () => {
    tokenizeImpl = () => tokensOf('猫', 'が')
    const { ensureSegmenter, tokenStartAt } = await loadModule()
    await ensureSegmenter()
    expect(tokenStartAt('猫が', 5)).toBe(null)
  })

  it('returns null when tokenize() throws', async () => {
    tokenizeImpl = () => {
      throw new Error('tokenize blew up')
    }
    const { ensureSegmenter, tokenStartAt } = await loadModule()
    await ensureSegmenter()
    expect(tokenStartAt('猫が', 0)).toBe(null)
  })
})
