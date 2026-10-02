import { describe, it, expect, afterEach } from 'vitest'
import { appearanceCSS, reducedMotion, type ThemeTokens } from './styles'
import { DEFAULT_SETTINGS, type ReaderSettings } from '../types'

const TOKENS: ThemeTokens = {
  ink: '#111',
  inkSoft: '#555',
  paper: '#fafafa',
  accent: '#c33',
  accentSoft: '#fcc',
  fontJpSans: 'JpSans',
  fontSerif: 'JpSerif',
  fontUi: 'UiSans',
  fontLatinSerif: 'LatinSerif',
  theme: 'light',
}
const css = (s: Partial<ReaderSettings> = {}, t: Partial<ThemeTokens> = {}) =>
  appearanceCSS({ ...DEFAULT_SETTINGS, ...s }, { ...TOKENS, ...t })

describe('appearanceCSS', () => {
  it('paints the root with --paper and keys color-scheme off the resolved palette', () => {
    expect(css()).toContain('background: #fafafa !important')
    expect(css({ theme: 'auto' }, { theme: 'dark' })).toContain('color-scheme: dark')
    expect(css({ theme: 'dark' }, { theme: '' })).toContain('color-scheme: dark')
    expect(css({ theme: 'dark' }, { theme: 'sepia' })).toContain('color-scheme: light')
  })

  it('forces the writing mode only when chosen explicitly', () => {
    expect(css({ writingMode: 'vertical' })).toContain('writing-mode: vertical-rl !important')
    expect(css({ writingMode: 'horizontal' })).toContain('writing-mode: horizontal-tb !important')
    expect(css({ writingMode: 'auto' })).not.toContain('writing-mode')
  })

  it('applies font family, scale and line height', () => {
    expect(css({ fontFamily: 'sans' })).toContain('font-family: JpSans')
    expect(css({ fontFamily: 'serif' })).toContain('font-family: JpSerif')
    expect(css({ fontScale: 1.25 })).toContain('font-size: 125%')
    expect(css({ lineHeight: 2 })).toContain('line-height: 2;')
  })

  it('keeps double-tap zoom off on the content body', () => {
    expect(css()).toMatch(/body \{[^}]*touch-action: manipulation/)
  })

  it('shows English only with show-all', () => {
    expect(css({ showEnglish: false })).not.toContain('display: block')
    expect(css({ showEnglish: true })).toMatch(/\.tsuzuri-en \{\s*display: block/)
    expect(css()).toContain('.tsuzuri-en { display: none; }')
  })

  it('draws no border on English (a stray dash atop each column in 縦書き)', () => {
    expect(css({ showEnglish: true })).not.toContain('border-inline-start')
  })

  it('sets English in a Latin face matching the chosen family', () => {
    expect(css({ fontFamily: 'sans', showEnglish: true })).toContain('font-family: UiSans')
    expect(css({ fontFamily: 'serif', showEnglish: true })).toContain('font-family: LatinSerif')
  })
})

describe('reducedMotion', () => {
  const g = globalThis as any
  const saved = g.matchMedia
  afterEach(() => {
    g.matchMedia = saved
  })
  it('follows prefers-reduced-motion, false without matchMedia', () => {
    g.matchMedia = (q: string) => ({ matches: q === '(prefers-reduced-motion: reduce)' })
    expect(reducedMotion()).toBe(true)
    g.matchMedia = () => ({ matches: false })
    expect(reducedMotion()).toBe(false)
    g.matchMedia = undefined
    expect(reducedMotion()).toBe(false)
  })
})
