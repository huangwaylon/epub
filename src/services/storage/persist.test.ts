import { describe, it, expect, afterEach, vi } from 'vitest'
import { formatBytes, requestPersistence, storageStatus } from './persist'

describe('formatBytes', () => {
  it('renders zero without a decimal', () => {
    expect(formatBytes(0)).toBe('0 B')
  })
  it('keeps bytes whole and scales up with one decimal', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB')
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB')
  })
  it('caps the unit at GB for very large values', () => {
    expect(formatBytes(5 * 1024 ** 4)).toMatch(/GB$/)
  })
})

describe('requestPersistence', () => {
  const orig = globalThis.navigator
  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', { value: orig, configurable: true })
  })
  const stubNavigator = (storage: unknown) =>
    Object.defineProperty(globalThis, 'navigator', { value: { storage }, configurable: true })

  it('short-circuits to true when already persisted (no persist() call)', async () => {
    const persist = vi.fn()
    stubNavigator({ persisted: async () => true, persist })
    expect(await requestPersistence()).toBe(true)
    expect(persist).not.toHaveBeenCalled()
  })
  it('requests persistence when not yet persisted', async () => {
    stubNavigator({ persisted: async () => false, persist: async () => true })
    expect(await requestPersistence()).toBe(true)
  })
  it('returns false when the API is unavailable', async () => {
    stubNavigator(undefined)
    expect(await requestPersistence()).toBe(false)
  })
})

describe('storageStatus', () => {
  const orig = globalThis.navigator
  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', { value: orig, configurable: true })
  })
  it('reports zeros and unpersisted when the API is unavailable', async () => {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true })
    expect(await storageStatus()).toEqual({ persisted: false, usage: 0, quota: 0 })
  })
  it('surfaces estimate + persisted state when available', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { storage: { persisted: async () => true, estimate: async () => ({ usage: 100, quota: 200 }) } },
      configurable: true,
    })
    expect(await storageStatus()).toEqual({ persisted: true, usage: 100, quota: 200 })
  })
})
