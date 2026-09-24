import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * dictdb.ts against a fake jpdict-idb (the real one needs IndexedDB) and a plain-object
 * `dict` store (the real one is a Svelte rune module). Covers the download contract —
 * one shared download, transient failures as a waiting state rather than a rejection —
 * and `cacheIpadic`'s Cache API writes.
 */

const store = vi.hoisted(() => ({
  dict: { state: 'init', updating: false, progress: 0, warming: false, error: undefined as string | undefined },
}))
vi.mock('../../stores/dict.svelte', () => store)

const warmupLookup = vi.fn(async () => true)
vi.mock('./lookupClient', () => ({ warmupLookup: () => warmupLookup(), clearLookupCache: () => {} }))

type UpdateArgs = {
  onUpdateComplete: () => void
  onUpdateError: (p: { error: Error; nextRetry?: Date }) => void
  updateNow?: boolean
}
const updateCalls: UpdateArgs[] = []
const fakeDb = {
  ready: Promise.resolve(),
  words: { state: 'empty', updateState: { type: 'idle' } as any },
  listener: null as null | (() => void),
  addChangeListener(cb: () => void) {
    this.listener = cb
  },
}
vi.mock('@birchill/jpdict-idb', () => ({
  JpdictIdb: function () {
    return fakeDb
  },
  updateWithRetry: (args: UpdateArgs) => updateCalls.push(args),
}))

function named(name: string, message = name): Error {
  const e = new Error(message)
  e.name = name
  return e
}

async function fresh() {
  vi.resetModules()
  return import('./dictdb')
}

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  Object.assign(store.dict, { state: 'init', updating: false, progress: 0, warming: false, error: undefined })
  fakeDb.words.state = 'empty'
  fakeDb.words.updateState = { type: 'idle' }
  updateCalls.length = 0
  warmupLookup.mockClear()
})

afterEach(() => vi.unstubAllGlobals())

describe('downloadDictionary', () => {
  it('shares one in-flight download between callers (jpdict-idb ignores overlapping calls)', async () => {
    const { downloadDictionary } = await fresh()
    const a = downloadDictionary()
    const b = downloadDictionary()
    expect(b).toBe(a)
    await flush()
    expect(updateCalls.length).toBe(1)
    fakeDb.words.state = 'ok'
    updateCalls[0].onUpdateComplete()
    await expect(a).resolves.toBeUndefined()
    expect(store.dict.state).toBe('ok')
  })

  it('treats OfflineError as a waiting state, then resolves when the retry succeeds', async () => {
    const { downloadDictionary, dictPhase } = await fresh()
    let settled = false
    const p = downloadDictionary().finally(() => (settled = true))
    await flush()
    updateCalls[0].onUpdateError({ error: named('OfflineError') })
    await flush()
    expect(settled).toBe(false)
    expect(dictPhase()).toBe('retrying')
    expect(store.dict.error).toMatch(/offline/i)

    // Back online: jpdict-idb re-runs the update itself; progress clears the message.
    fakeDb.words.updateState = { type: 'updating', totalProgress: 0.5 }
    fakeDb.listener!()
    expect(dictPhase()).toBe('downloading')
    expect(store.dict.error).toBeUndefined()

    fakeDb.words.state = 'ok'
    fakeDb.words.updateState = { type: 'idle' }
    updateCalls[0].onUpdateComplete()
    await p
    expect(dictPhase()).toBe('ready')
  })

  it('treats a DownloadError with a scheduled retry as waiting; a repeat call forces it', async () => {
    const { downloadDictionary, dictPhase } = await fresh()
    const p = downloadDictionary()
    await flush()
    updateCalls[0].onUpdateError({ error: named('DownloadError', 'timeout'), nextRetry: new Date(Date.now() + 5000) })
    fakeDb.listener!() // jpdict-idb reports idle between attempts
    expect(dictPhase()).toBe('retrying')
    expect(store.dict.updating).toBe(true)

    expect(downloadDictionary()).toBe(p)
    expect(updateCalls.length).toBe(2)
    expect(updateCalls[1].updateNow).toBe(true)
    expect(updateCalls[1].onUpdateComplete).toBe(updateCalls[0].onUpdateComplete) // same settle path
  })

  it('rejects on a permanent failure and lets a later call start afresh', async () => {
    const { downloadDictionary, dictPhase } = await fresh()
    const p = downloadDictionary()
    await flush()
    updateCalls[0].onUpdateError({ error: named('DownloadError', 'Version file invalid') })
    await expect(p).rejects.toThrow('Version file invalid')
    expect(store.dict.error).toBe('Version file invalid')
    expect(dictPhase()).toBe('missing')

    const again = downloadDictionary()
    expect(again).not.toBe(p)
    await flush()
    expect(updateCalls.length).toBe(2)
  })
})

describe('cacheIpadic', () => {
  function fakeCaches(have: string[], failing: string[] = []) {
    const stored = new Set(have)
    const opened: string[] = []
    const cache = {
      match: async (url: string) => (stored.has(url) ? new Response('x') : undefined),
      add: async (url: string) => {
        if (failing.some((f) => url.endsWith(f))) throw new TypeError('offline')
        stored.add(url)
      },
    }
    vi.stubGlobal('caches', { open: async (name: string) => (opened.push(name), cache) })
    return { stored, opened }
  }

  it('writes every staged file (base-aware URLs) into the SW runtime cache, skipping cached ones', async () => {
    const { cacheIpadic } = await fresh()
    const { ipadicUrls, IPADIC_FILES } = await import('./ipadic')
    const urls = ipadicUrls()
    expect(urls[0]).toMatch(/\/kuromoji\/dict\/base\.dat\.gz$/)
    expect(IPADIC_FILES).not.toContain('tid_pos.dat.gz')
    const { stored, opened } = fakeCaches([urls[0]])
    expect(await cacheIpadic()).toBe(true)
    expect(opened[0]).toBe('kuromoji-ipadic-v2')
    expect(stored.size).toBe(IPADIC_FILES.length)
  })

  it('reports false when a file cannot be fetched, or there is no Cache API', async () => {
    const { cacheIpadic } = await fresh()
    fakeCaches([], ['cc.dat.gz'])
    expect(await cacheIpadic()).toBe(false)
    vi.stubGlobal('caches', undefined)
    expect(await cacheIpadic()).toBe(false)
  })
})

describe('download + prepare flows', () => {
  it('downloadAndCacheDictionary caches IPADIC without building the trie', async () => {
    const { downloadAndCacheDictionary } = await fresh()
    vi.stubGlobal('caches', {
      open: async () => ({ match: async () => undefined, add: async () => {} }),
    })
    const p = downloadAndCacheDictionary()
    await flush()
    updateCalls[0].onUpdateComplete()
    await p
    expect(warmupLookup).not.toHaveBeenCalled()
    expect(store.dict.warming).toBe(false)
  })

  it('downloadAndWarmDictionary also builds kuromoji, keeping `warming` up until it is ready', async () => {
    const { downloadAndWarmDictionary, dictPhase } = await fresh()
    vi.stubGlobal('caches', undefined)
    let finishWarm!: (v: boolean) => void
    warmupLookup.mockImplementationOnce(() => new Promise<boolean>((r) => (finishWarm = r)))
    const p = downloadAndWarmDictionary()
    await flush()
    fakeDb.words.state = 'ok'
    updateCalls[0].onUpdateComplete()
    await flush()
    expect(dictPhase()).toBe('preparing')
    finishWarm(true)
    await p
    expect(dictPhase()).toBe('ready')
  })
})
