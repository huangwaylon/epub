import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { LookupResult } from './lookupTypes'

/**
 * `lookupClient` is pure plumbing — worker lifecycle, request/response correlation, and
 * the main-thread result cache — so we replace the Worker itself with a fake we can reply
 * from by hand. vitest runs in the `node` env where there is no global `Worker`, so
 * stubbing it is also what makes the module loadable at all.
 *
 * Each test imports a fresh copy of the module: the worker singleton, the id sequence and
 * `RESULT_CACHE` are all module-private state with no reset hook.
 */

type Posted = { type: string; id: number; text?: string; tapOffset?: number }

class FakeWorker {
  static instances: FakeWorker[] = []
  static constructFails = false

  posted: Posted[] = []
  terminated = false
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null

  constructor() {
    if (FakeWorker.constructFails) throw new Error('Worker unavailable')
    FakeWorker.instances.push(this)
  }

  postMessage(msg: Posted): void {
    this.posted.push(msg)
  }

  terminate(): void {
    this.terminated = true
  }

  /** Deliver a worker → main-thread reply for the request with this id. */
  reply(id: number, result: unknown, ready?: boolean): void {
    this.onmessage?.({ data: { id, result, ready } })
  }

  /** The id of the last request of the given type. */
  lastId(type: string): number {
    const m = [...this.posted].reverse().find((p) => p.type === type)
    if (!m) throw new Error(`no ${type} message posted`)
    return m.id
  }
}

function entry(headword: string): LookupResult {
  return { matchStart: 0, matchLength: headword.length, reasons: [], entries: [{ headword, reading: '', kanaOnly: false, senses: [] }] }
}

async function freshClient(): Promise<typeof import('./lookupClient')> {
  vi.resetModules()
  return import('./lookupClient')
}

/** The single worker the module under test just constructed. */
function only(): FakeWorker {
  expect(FakeWorker.instances.length).toBe(1)
  return FakeWorker.instances[0]
}

beforeEach(() => {
  FakeWorker.instances = []
  FakeWorker.constructFails = false
  vi.stubGlobal('Worker', FakeWorker)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('lookupAt', () => {
  it('posts the request to a lazily-created worker and resolves its reply', async () => {
    const { lookupAt } = await freshClient()
    const p = lookupAt('猫', 0)
    const w = only()
    expect(w.posted[0]).toMatchObject({ type: 'lookup', text: '猫', tapOffset: 0 })
    w.reply(w.lastId('lookup'), entry('猫'), true)
    expect((await p)!.entries[0].headword).toBe('猫')
  })

  it('resolves null (and does not throw) when the worker cannot be constructed', async () => {
    FakeWorker.constructFails = true
    const { lookupAt } = await freshClient()
    expect(await lookupAt('猫', 0)).toBeNull()
  })
})

describe('the main-thread result cache', () => {
  it('serves a repeat tap of a kuromoji-ready result without touching the worker', async () => {
    const { lookupAt } = await freshClient()
    const p = lookupAt('決心', 1)
    const w = only()
    w.reply(w.lastId('lookup'), entry('決心'), true)
    await p

    const again = await lookupAt('決心', 1)
    expect(again!.entries[0].headword).toBe('決心')
    expect(w.posted.filter((m) => m.type === 'lookup').length).toBe(1)
  })

  it('survives disposeLookup — the tap after a foreground needs no worker at all', async () => {
    // The reader sheds the worker after a sustained backgrounding and on exit; this cache
    // is what keeps the next taps instant and morphologically correct while the kuromoji
    // trie rebuilds.
    const { lookupAt, disposeLookup } = await freshClient()
    const p = lookupAt('決心', 1)
    const w = only()
    w.reply(w.lastId('lookup'), entry('決心'), true)
    await p

    disposeLookup()
    expect(w.terminated).toBe(true)

    const again = await lookupAt('決心', 1)
    expect(again!.entries[0].headword).toBe('決心')
    expect(FakeWorker.instances.length).toBe(1) // no replacement worker was constructed
  })

  it('caches a definitive "no match" from a ready segmenter', async () => {
    const { lookupAt } = await freshClient()
    const p = lookupAt('鬱蒼', 0)
    const w = only()
    w.reply(w.lastId('lookup'), null, true)
    expect(await p).toBeNull()

    expect(await lookupAt('鬱蒼', 0)).toBeNull()
    expect(w.posted.filter((m) => m.type === 'lookup').length).toBe(1)
  })

  it('does NOT cache a greedy-fallback result, so it is recomputed once kuromoji is up', async () => {
    const { lookupAt } = await freshClient()
    const p = lookupAt('今日本', 1)
    const w = only()
    w.reply(w.lastId('lookup'), entry('今日'), false) // segmenter wasn't ready
    expect((await p)!.entries[0].headword).toBe('今日')

    // Same tap again: it must go back to the worker rather than latching the provisional
    // answer for the rest of the session.
    const p2 = lookupAt('今日本', 1)
    expect(w.posted.filter((m) => m.type === 'lookup').length).toBe(2)
    w.reply(w.lastId('lookup'), entry('日本'), true)
    expect((await p2)!.entries[0].headword).toBe('日本')
  })
})

describe('pingLookup', () => {
  it('is false — without constructing a worker — when there is none', async () => {
    const { pingLookup } = await freshClient()
    expect(await pingLookup()).toBe(false)
    expect(FakeWorker.instances.length).toBe(0)
  })

  it('is true when the worker answers', async () => {
    const { lookupAt, pingLookup } = await freshClient()
    void lookupAt('猫', 0) // constructs the worker
    const w = only()
    const p = pingLookup()
    w.reply(w.lastId('ping'), true, true)
    expect(await p).toBe(true)
    expect(w.terminated).toBe(false)
  })

  it('drops a silently dead worker, so the next call builds a fresh one', async () => {
    vi.useFakeTimers()
    try {
      const { lookupAt, pingLookup } = await freshClient()
      const first = lookupAt('猫', 0)
      const w = only()

      const p = pingLookup(500)
      await vi.advanceTimersByTimeAsync(500)
      expect(await p).toBe(false)
      expect(w.terminated).toBe(true)
      expect(await first).toBeNull() // in-flight work fails fast instead of hanging

      void lookupAt('犬', 0)
      expect(FakeWorker.instances.length).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('warmupLookup', () => {
  it('resolves the worker’s build result', async () => {
    const { warmupLookup } = await freshClient()
    const p = warmupLookup()
    const w = only()
    expect(w.posted[0]).toMatchObject({ type: 'warmup' })
    w.reply(w.lastId('warmup'), true)
    expect(await p).toBe(true)
  })

  it('resolves false and drops the worker if the build never answers', async () => {
    vi.useFakeTimers()
    try {
      const { warmupLookup } = await freshClient()
      const p = warmupLookup()
      const w = only()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(await p).toBe(false)
      expect(w.terminated).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('lookup timeouts', () => {
  it('resolves null and replaces a worker that never replies', async () => {
    vi.useFakeTimers()
    try {
      const { lookupAt } = await freshClient()
      const p = lookupAt('猫', 0)
      const w = only()
      await vi.advanceTimersByTimeAsync(8000)
      expect(await p).toBeNull()
      expect(w.terminated).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
