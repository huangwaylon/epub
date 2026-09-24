import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * The worker's message protocol, driven through a stubbed `self`. The lookup engine is
 * mocked; what matters here is that each reply carries the readiness the *lookup*
 * captured when it chose its path — never a fresh `isSegmenterReady()` read after the
 * IndexedDB awaits, which would tag a provisional greedy answer as authoritative once a
 * build finished mid-lookup (and the client would then cache it for the session).
 */

const resolveLookup = vi.fn()
const warmup = vi.fn(async () => true)
let segmenterReady = false
vi.mock('./lookup', () => ({
  resolveLookup: (text: string, tap: number) => resolveLookup(text, tap),
  warmup: () => warmup(),
  isSegmenterReady: () => segmenterReady,
}))

const posted: any[] = []
let onmessage: (e: { data: unknown }) => Promise<void>

beforeEach(async () => {
  posted.length = 0
  segmenterReady = false
  const self: any = { postMessage: (m: unknown) => posted.push(m) }
  vi.stubGlobal('self', self)
  vi.resetModules()
  await import('./lookup.worker')
  onmessage = self.onmessage
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('lookup.worker', () => {
  it('replies with the readiness captured at decision time, not after the lookup', async () => {
    resolveLookup.mockImplementation(async () => {
      segmenterReady = true // kuromoji finished while the greedy lookup was querying
      return { result: { matchStart: 0, matchLength: 1, reasons: [], entries: [] }, ready: false }
    })
    await onmessage({ data: { type: 'lookup', id: 1, text: '猫', tapOffset: 0 } })
    expect(posted).toEqual([{ id: 1, result: expect.any(Object), ready: false }])
  })

  it('answers a ping immediately with liveness and readiness', async () => {
    segmenterReady = true
    await onmessage({ data: { type: 'ping', id: 2 } })
    expect(posted).toEqual([{ id: 2, result: true, ready: true }])
  })

  it('reports the warmup result', async () => {
    await onmessage({ data: { type: 'warmup', id: 3 } })
    expect(posted).toEqual([{ id: 3, result: true }])
  })

  it('turns a lookup exception into a null, uncacheable reply', async () => {
    resolveLookup.mockRejectedValue(new Error('boom'))
    await onmessage({ data: { type: 'lookup', id: 4, text: '猫', tapOffset: 0 } })
    expect(posted[0]).toMatchObject({ id: 4, result: null })
    expect(posted[0].ready).toBeUndefined()
  })
})
