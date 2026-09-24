import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { viewportSize } from './viewport'

// Node env, no jsdom: hand-mock the few globals viewportSize reads.
let standalone = true
const vv = { width: 393, height: 754, scale: 1, addEventListener() {} }

beforeEach(() => {
  standalone = true
  Object.assign(vv, { width: 393, height: 754, scale: 1 })
  vi.stubGlobal('visualViewport', vv)
  vi.stubGlobal('window', { innerWidth: vv.width, innerHeight: vv.height })
  vi.stubGlobal('navigator', {
    get standalone() {
      return standalone
    },
  })
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  vi.stubGlobal('screen', { width: 393, height: 852 }) // iPhone: portrait dims, never swap
})

afterEach(() => vi.unstubAllGlobals())

describe('viewportSize — iOS cold-launch under-report', () => {
  it('lifts a short standalone portrait height to the screen height', () => {
    expect(viewportSize()).toEqual({ w: 393, h: 852 })
  })

  it('uses the short screen side in landscape', () => {
    Object.assign(vv, { width: 852, height: 300 })
    expect(viewportSize()).toEqual({ w: 852, h: 393 })
  })

  it('leaves a correct report alone', () => {
    vv.height = 852
    expect(viewportSize().h).toBe(852)
  })

  it('does nothing in the Safari tab (not standalone)', () => {
    standalone = false
    expect(viewportSize().h).toBe(754)
  })

  it('does nothing in a windowed iPad app (Split View / Stage Manager)', () => {
    vi.stubGlobal('screen', { width: 1194, height: 834 })
    Object.assign(vv, { width: 700, height: 800 })
    expect(viewportSize()).toEqual({ w: 700, h: 800 })
  })
})

describe('initViewport — publishes the heights', () => {
  it('makes the document screen-tall in a full-screen standalone app, and only then', async () => {
    const props = new Map<string, string>()
    const style = {
      setProperty: (k: string, v: string) => props.set(k, v),
      removeProperty: (k: string) => props.delete(k),
    }
    vi.stubGlobal('document', { documentElement: { style }, readyState: 'complete' })
    vi.stubGlobal('window', { innerWidth: 393, innerHeight: 793, addEventListener() {}, scrollTo() {} })
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vv.height = 793 // the cold-launch under-report (852 − 59px status-bar inset)
    vi.resetModules()
    const { initViewport } = await import('./viewport')
    initViewport()
    expect(props.get('--doc-height')).toBe('852px')
    expect(props.get('--app-height')).toBe('852px')
  })

  it('leaves the document on 100dvh in a Safari tab', async () => {
    const props = new Map<string, string>()
    const style = {
      setProperty: (k: string, v: string) => props.set(k, v),
      removeProperty: (k: string) => props.delete(k),
    }
    vi.stubGlobal('document', { documentElement: { style }, readyState: 'complete' })
    vi.stubGlobal('window', { innerWidth: 393, innerHeight: 754, addEventListener() {}, scrollTo() {} })
    vi.stubGlobal('requestAnimationFrame', () => 1)
    standalone = false
    vv.height = 754
    vi.resetModules()
    const { initViewport } = await import('./viewport')
    initViewport()
    expect(props.has('--doc-height')).toBe(false)
    expect(props.get('--app-height')).toBe('754px')
  })
})
