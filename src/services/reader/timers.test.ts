import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { Timers } from './timers'

beforeAll(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', globalThis)
})
afterAll(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('Timers', () => {
  it('replaces a pending timeout under the same key', () => {
    const t = new Timers()
    const a = vi.fn()
    const b = vi.fn()
    t.set('k', a, 10)
    t.set('k', b, 10)
    vi.advanceTimersByTime(20)
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledOnce()
  })

  it('clears one key or all', () => {
    const t = new Timers()
    const a = vi.fn()
    const b = vi.fn()
    const doc = {}
    t.set('a', a, 10)
    t.set(doc, b, 10)
    t.clear('a')
    vi.advanceTimersByTime(20)
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledOnce()
    t.set('a', a, 10)
    t.set(doc, b, 10)
    t.clearAll()
    vi.advanceTimersByTime(20)
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledOnce()
  })

  it('a callback may re-arm its own key', () => {
    const t = new Timers()
    let n = 0
    const tick = () => {
      if (++n < 3) t.set('k', tick, 0)
    }
    t.set('k', tick, 0)
    vi.advanceTimersByTime(10)
    expect(n).toBe(3)
  })
})
