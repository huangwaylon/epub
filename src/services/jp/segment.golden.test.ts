/// <reference types="node" />
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { tokenSpans, type LatticeTokenizer } from './segment'

/**
 * Golden test for the memory-lean segmentation path. Tsuzuri no longer runs kuromoji the
 * stock way; it
 *   - stages a *trimmed* IPADIC (scripts/copy-kuromoji-dict.mjs — padding cut, no tid_pos),
 *   - loads it through kuromojiLoader.cjs (DecompressionStream, flat target maps, tid_pos
 *     answered with an empty buffer), and
 *   - reads boundaries off the Viterbi path (`tokenSpans`) instead of `tokenize()`.
 * Each of those is claimed lossless for word boundaries. This asserts it end to end:
 * over a natural-prose corpus plus thousands of synthetic strings built from random
 * IPADIC surface forms, every token boundary must equal what stock kuromoji
 * (`NodeDictionaryLoader` over the untouched package dict + `tokenize`) produces.
 *
 * Runs against the real dictionary, so it is slow-ish (~5 s) and needs `npm install`.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '../../..')
const require = createRequire(import.meta.url)
const kuromojiDir = dirname(require.resolve('@sglkc/kuromoji/package.json'))
const packageDict = join(kuromojiDir, 'dict')

type Tok = LatticeTokenizer & { tokenize(text: string): { word_position: number; surface_form: string }[] }

let stock: Tok
let lean: Tok
let staged: string

function build(fn: (cb: (err: unknown, tok: Tok) => void) => void): Promise<Tok> {
  return new Promise((resolve, reject) => fn((err, tok) => (err ? reject(err) : resolve(tok))))
}

beforeAll(async () => {
  staged = mkdtempSync(join(tmpdir(), 'tsuzuri-ipadic-'))
  execFileSync(process.execPath, [join(root, 'scripts/copy-kuromoji-dict.mjs'), staged], { stdio: 'pipe' })

  // Stock kuromoji: Node's `require` ignores the package's `browser` field, so this is the
  // upstream NodeDictionaryLoader reading the untouched dict.
  stock = await build((cb) => require('@sglkc/kuromoji').builder({ dicPath: packageDict }).build(cb))

  // Tsuzuri's path: our loader over the staged files, served through a fetch stub.
  vi.stubGlobal('fetch', async (url: string) => new Response(readFileSync(url)))
  const Loader = require('./kuromojiLoader.cjs')
  const Tokenizer = require('@sglkc/kuromoji/src/Tokenizer')
  lean = await build((cb) => new Loader(staged).load((err: unknown, dic: unknown) => cb(err, err ? (null as any) : new Tokenizer(dic))))
}, 60_000)

afterAll(() => {
  vi.unstubAllGlobals()
  if (staged) rmSync(staged, { recursive: true, force: true })
})

/** Stock boundaries: `[start, end)` per token from `tokenize()`. */
function stockSpans(text: string): [number, number][] {
  return stock.tokenize(text).map((t) => [t.word_position - 1, t.word_position - 1 + t.surface_form.length])
}

function leanSpans(text: string): [number, number][] {
  return tokenSpans(lean, text).map((s) => [s.start, s.end])
}

/** IPADIC surface forms, read from the (package) feature file the app no longer ships. */
function lexicon(): string[] {
  const buf = gunzipSync(readFileSync(join(packageDict, 'tid_pos.dat.gz')))
  const out: string[] = []
  let s = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0) continue
    if (i > s) {
      const line = buf.subarray(s, i).toString('utf8')
      out.push(line.slice(0, line.indexOf(',')))
    }
    s = i + 1
  }
  return out
}

/** Deterministic PRNG (LCG) so a failure is reproducible. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
}

/** WORD_CHAR-only runs, i.e. what extract.ts actually hands the lookup. */
function runsOf(line: string): string[] {
  return line.split(/[^\u3040-\u30FA\u30FC-\u30FF\u3400-\u9FFF\uF900-\uFAFF\u3005-\u3007]+/).filter(Boolean)
}

describe('lean kuromoji path — golden boundaries vs stock tokenize()', () => {
  it('stages the trimmed dict without tid_pos', () => {
    const files = readdirSync(staged).filter((f) => f.endsWith('.dat.gz'))
    expect(files).not.toContain('tid_pos.dat.gz')
    expect(files.length).toBe(11)
  })

  it('does not materialise bogus character classes from unk_invoke padding', () => {
    const classes = (lean as any).unknown_dictionary.character_definition.invoke_definition_map.map.length
    expect(classes).toBe(11) // stock: ~150k, one per 7 bytes of zero padding
  })

  it('matches on natural prose (whole lines, with punctuation, and extract-style runs)', () => {
    const lines = readFileSync(join(here, '__fixtures__/corpus-ja.txt'), 'utf8').split('\n').filter(Boolean)
    const inputs = [...lines, ...lines.flatMap(runsOf)]
    let tokens = 0
    for (const text of inputs) {
      const expected = stockSpans(text)
      tokens += expected.length
      expect(leanSpans(text), text).toEqual(expected)
    }
    expect(tokens).toBeGreaterThan(1500)
  })

  it('matches on 5,000 synthetic strings of random IPADIC words', () => {
    const words = lexicon()
    expect(words.length).toBeGreaterThan(300_000)
    const rand = rng(20260924)
    let tokens = 0
    for (let i = 0; i < 5000; i++) {
      let text = ''
      const n = 2 + Math.floor(rand() * 8)
      for (let j = 0; j < n; j++) text += words[Math.floor(rand() * words.length)]
      const expected = stockSpans(text)
      tokens += expected.length
      expect(leanSpans(text), text).toEqual(expected)
    }
    expect(tokens).toBeGreaterThan(20_000)
  })
})
