import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { debounce } from './debounce'

// debounce() calls window.setTimeout/clearTimeout, so under the node env we shim a
// `window` that DELEGATES to globalThis timers — fake timers only patch globalThis,
// so the shim must forward rather than capture the originals.
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', {
    setTimeout: (cb: () => void, ms: number) => globalThis.setTimeout(cb, ms),
    clearTimeout: (id: number) => globalThis.clearTimeout(id),
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('debounce', () => {
  it('fires once after the delay', () => {
    const fn = vi.fn()
    const d = debounce(fn, 100)
    d()
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('coalesces rapid calls into a single trailing call with the latest args', () => {
    const fn = vi.fn()
    const d = debounce(fn, 100)
    d('a')
    vi.advanceTimersByTime(50)
    d('b')
    vi.advanceTimersByTime(50) // 50ms since 'b' — not yet
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50) // 100ms since 'b'
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('b')
  })

  it('cancel() drops a pending trailing call', () => {
    const fn = vi.fn()
    const d = debounce(fn, 100)
    d()
    d.cancel()
    vi.advanceTimersByTime(200)
    expect(fn).not.toHaveBeenCalled()
  })

  it('can be re-armed after cancel()', () => {
    const fn = vi.fn()
    const d = debounce(fn, 100)
    d()
    d.cancel()
    d()
    vi.advanceTimersByTime(100)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('passes through arguments', () => {
    const fn = vi.fn()
    const d = debounce(fn, 10)
    d(1, 'two', { three: true })
    vi.advanceTimersByTime(10)
    expect(fn).toHaveBeenCalledWith(1, 'two', { three: true })
  })
})
