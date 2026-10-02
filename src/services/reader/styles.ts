/**
 * The stylesheet injected into every content document (`renderer.setStyles`), built from
 * the reader settings and the host's theme tokens. Pure apart from `readThemeTokens` /
 * `reducedMotion`, which read the host document.
 */
import type { ReaderSettings } from '../types'
import { EN_CLASS } from '../translation'

/** Host CSS custom properties the content stylesheet uses (docs/ui-and-design.md). */
export interface ThemeTokens {
  ink: string
  inkSoft: string
  paper: string
  accent: string
  accentSoft: string
  fontJpSans: string
  fontSerif: string
  fontUi: string
  fontLatinSerif: string
  /** The resolved palette (`<html data-theme>`), '' if unset. */
  theme: string
}

/** One `getComputedStyle` read of the host's tokens. */
export function readThemeTokens(): ThemeTokens {
  const root = document.documentElement
  const cs = getComputedStyle(root)
  const tok = (name: string) => cs.getPropertyValue(name).trim()
  return {
    ink: tok('--ink'),
    inkSoft: tok('--ink-soft'),
    paper: tok('--paper'),
    accent: tok('--accent'),
    accentSoft: tok('--accent-soft'),
    fontJpSans: tok('--font-jp-sans'),
    fontSerif: tok('--font-serif'),
    fontUi: tok('--font-ui'),
    fontLatinSerif: tok('--font-latin-serif'),
    theme: root.dataset.theme ?? '',
  }
}

export function reducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

/** The content stylesheet for settings `s` on theme `t`. */
export function appearanceCSS(s: ReaderSettings, t: ThemeTokens): string {
  const family = s.fontFamily === 'sans' ? t.fontJpSans : t.fontSerif
  // A transparent iframe root composites over its default (white) canvas, so paint the
  // root with --paper. Key color-scheme off the resolved palette (the setting may be 'auto').
  const scheme = (t.theme || s.theme) === 'dark' ? 'dark' : 'light'

  let wm = ''
  if (s.writingMode === 'vertical') wm = 'writing-mode: vertical-rl !important;'
  else if (s.writingMode === 'horizontal') wm = 'writing-mode: horizontal-tb !important;'

  // English (docs/translation.md): hidden unless show-all is on. Set apart by face, size,
  // colour and spacing only — a border-inline-start would be a stray dash atop each
  // column in 縦書き. Logical properties only, so it reads right in either writing mode.
  const latin = s.fontFamily === 'sans' ? t.fontUi : t.fontLatinSerif
  const english = `
    .${EN_CLASS} { display: none; }${s.showEnglish ? `
    .${EN_CLASS} {
      display: block;
      margin-block: 0.35em 0.9em;
      font-family: ${latin};
      font-size: 0.85em;
      font-style: normal;
      font-weight: normal;
      line-height: 1.5;
      letter-spacing: normal;
      color: color-mix(in srgb, ${t.ink} 70%, ${t.paper});
      text-indent: 0;
      text-align: start;
      text-orientation: mixed;
      -webkit-hyphens: manual;
      hyphens: manual;
    }` : ''}`

  return `
    @namespace epub "http://www.idpf.org/2007/ops";
    html {
      color: ${t.ink};
      background: ${t.paper} !important;
      color-scheme: ${scheme};
      font-size: ${Math.round(s.fontScale * 100)}%;
      -webkit-text-size-adjust: none;
      ${wm}
    }
    body {
      color: ${t.ink};
      background: transparent !important;
      font-family: ${family};
      -webkit-touch-callout: none;
      /* No double-tap zoom (iOS ignores user-scalable): taps and swipes bail while zoomed. */
      touch-action: manipulation;
    }
    ${english}
    p, li, blockquote, dd {
      line-height: ${s.lineHeight};
      text-align: justify;
      -webkit-hyphens: auto;
      hyphens: auto;
      hanging-punctuation: allow-end last;
    }
    [align="left"] { text-align: left; }
    [align="center"] { text-align: center; }
    [align="right"] { text-align: right; }
    a:any-link { color: ${t.accent}; }
    ::selection { background: ${t.accentSoft}; }
    rt { -webkit-user-select: none; user-select: none; }
    pre { white-space: pre-wrap !important; }
  `
}
