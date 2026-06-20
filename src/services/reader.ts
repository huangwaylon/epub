// Side-effect import registers the <foliate-view> custom element.
import '../vendor/foliate-js/view.js'
// @ts-ignore — vendored JS module, no type declarations
import { Overlayer } from '../vendor/foliate-js/overlayer.js'
import type { ReaderSettings } from './types'

/** What we read off foliate's `relocate` event. */
export interface RelocateDetail {
  cfi: string
  fraction: number
  tocItem?: { label?: string; href?: string }
  range?: Range
}

/** A resolved single tap inside the rendered content (after filtering swipes/selection). */
export interface TapInfo {
  doc: Document
  /** Coordinates within the content iframe (for caretRangeFromPoint). */
  ix: number
  iy: number
  /** Coordinates in the top window (for positioning popups). */
  px: number
  py: number
  /** Horizontal zone of the tap across the page. */
  zone: 'left' | 'center' | 'right'
}

/** Minimal surface of foliate's <foliate-view> element that we use. */
interface FoliateView extends HTMLElement {
  book: any
  renderer: any
  open(book: File | Blob | string): Promise<void>
  init(opts: { lastLocation?: string; showTextStart?: boolean }): Promise<void>
  goTo(target: string | number): Promise<any>
  goLeft(): Promise<void>
  goRight(): Promise<void>
  prev(distance?: number): Promise<void>
  next(distance?: number): Promise<void>
  getCFI(index: number, range: Range): string
  addAnnotation(a: { value: string }, remove?: boolean): Promise<{ index: number; label: string }>
  deleteAnnotation(a: { value: string }): Promise<any>
  deselect(): void
}

/** A finished text selection, with viewport-relative geometry for the toolbar. */
export interface SelectionInfo {
  doc: Document
  range: Range
  text: string
  /** Bounding rect in top-window coordinates. */
  rect: { left: number; top: number; width: number; height: number }
}

export interface ReaderCallbacks {
  onRelocate?: (d: RelocateDetail) => void
  onLoad?: (doc: Document, index: number) => void
  onTap?: (info: TapInfo) => void
  onSelection?: (info: SelectionInfo) => void
  onSelectionCleared?: () => void
  /** A tap landed on an existing highlight (foliate's overlay hit-test). */
  onShowAnnotation?: (value: string, range: Range) => void
}

const TAP_MOVE_TOLERANCE = 10
const TAP_MAX_MS = 350

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/**
 * Builds the stylesheet foliate injects into each content document. Reads the
 * live theme tokens from the host so the page matches the app exactly.
 */
function appearanceCSS(s: ReaderSettings): string {
  const ink = cssVar('--ink')
  const accent = cssVar('--accent')
  const accentSoft = cssVar('--accent-soft')
  const family = s.fontFamily === 'sans' ? cssVar('--font-jp-sans') : cssVar('--font-serif')

  let wm = ''
  if (s.writingMode === 'vertical') wm = 'writing-mode: vertical-rl !important;'
  else if (s.writingMode === 'horizontal') wm = 'writing-mode: horizontal-tb !important;'

  return `
    @namespace epub "http://www.idpf.org/2007/ops";
    html {
      color: ${ink};
      background: transparent !important;
      font-size: ${Math.round(s.fontScale * 100)}%;
      -webkit-text-size-adjust: none;
      ${wm}
    }
    body {
      color: ${ink};
      background: transparent !important;
      font-family: ${family};
      /* Use our own selection toolbar instead of the native iOS callout menu. */
      -webkit-touch-callout: none;
    }
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
    a:any-link { color: ${accent}; }
    ::selection { background: ${accentSoft}; }
    rt { -webkit-user-select: none; user-select: none; }
    pre { white-space: pre-wrap !important; }
  `
}

/**
 * Owns a <foliate-view> for one open book: applies appearance, wires events,
 * exposes navigation, and translates raw taps into high-level TapInfo.
 */
export class ReaderController {
  view: FoliateView
  #cb: ReaderCallbacks
  #settings: ReaderSettings
  lastCFI = ''
  bookDir: 'ltr' | 'rtl' = 'ltr'
  /** Maps each loaded content document to its spine index (for CFI creation). */
  #docIndex = new WeakMap<Document, number>()
  /** Highlight CFI → colour, the source of truth when (re)drawing overlays. */
  #highlightColors = new Map<string, string>()
  /** Whether the current book renders vertically (縦書き); affects measure. */
  #vertical = false

  constructor(container: HTMLElement, settings: ReaderSettings, callbacks: ReaderCallbacks) {
    this.#settings = settings
    this.#cb = callbacks
    this.view = document.createElement('foliate-view') as FoliateView
    this.view.style.cssText = 'display:block;width:100%;height:100%'
    container.appendChild(this.view)
  }

  async open(file: File, lastCFI?: string): Promise<void> {
    await this.view.open(file)
    this.bookDir = this.view.book?.dir === 'rtl' ? 'rtl' : 'ltr'

    this.view.addEventListener('relocate', (e: any) => {
      const d = e.detail
      this.lastCFI = d.cfi
      this.#cb.onRelocate?.({
        cfi: d.cfi,
        fraction: d.fraction ?? 0,
        tocItem: d.tocItem,
        range: d.range,
      })
    })
    this.view.addEventListener('load', (e: any) => {
      const { doc, index } = e.detail
      this.#docIndex.set(doc, index)
      // Detect the writing mode from the rendered document so we can pick a
      // measure that suits it (vertical wants tall columns; horizontal a short line).
      try {
        const wm = doc.defaultView.getComputedStyle(doc.documentElement).writingMode || ''
        const vertical = wm.startsWith('vertical')
        if (vertical !== this.#vertical) {
          this.#vertical = vertical
          this.applyLayout(this.#settings)
        }
      } catch {
        /* ignore */
      }
      this.#attachTaps(doc)
      this.#cb.onLoad?.(doc, index)
    })
    this.view.addEventListener('show-annotation', (e: any) => {
      this.#cb.onShowAnnotation?.(e.detail.value, e.detail.range)
    })
    // Re-draw stored highlights whenever a section's overlay becomes available.
    this.view.addEventListener('create-overlay', () => this.reapplyHighlights())
    this.view.addEventListener('draw-annotation', (e: any) => {
      const { draw, annotation } = e.detail
      const color = this.#highlightColors.get(annotation.value) ?? '#ffd54a'
      draw(Overlayer.highlight, { color })
    })

    this.applyAppearance(this.#settings)
    this.applyLayout(this.#settings)
    window.addEventListener('resize', this.#onResize)
    await this.view.init({ lastLocation: lastCFI || undefined, showTextStart: true })
    this.#nudgeLayout()
  }

  /**
   * Foliate's first paint can under-measure the column height (leaving dead
   * space at the bottom) before fonts/layout settle. Foliate's own re-layout is
   * just `renderer.render()`, so we call it again at a few increasing delays so
   * one lands after everything has settled. Cheap and idempotent.
   */
  #nudgeLayout(): void {
    const render = () => {
      try {
        this.view.renderer?.render?.()
      } catch {
        /* ignore */
      }
    }
    for (const t of [120, 350, 700, 1200]) setTimeout(render, t)
  }

  /** Re-applies the injected stylesheet (theme, fonts, spacing). Safe to call live. */
  applyAppearance(s: ReaderSettings): void {
    this.#settings = s
    this.view.renderer?.setStyles?.(appearanceCSS(s))
  }

  /**
   * Applies page-geometry attributes, tuned for comfortable reading and scaled
   * to the device. `max-inline-size` caps the line length (horizontal) / column
   * height (vertical); `max-block-size` caps the page height (horizontal) /
   * centres the text band (vertical) so wide iPad screens get framed margins
   * instead of edge-to-edge text. A two-page spread is used on wide screens.
   */
  applyLayout(s: ReaderSettings): void {
    this.#settings = s
    const r = this.view.renderer
    if (!r) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    const minDim = Math.min(vw, vh)
    const margin = Math.round(Math.max(28, Math.min(80, minDim * 0.075)) * s.marginScale)
    // Vertical text wants tall columns (large inline measure); horizontal wants a
    // comfortable line length.
    const maxInline = this.#vertical ? 1100 : 640
    r.setAttribute('margin', `${margin}px`)
    r.setAttribute('gap', '6%')
    r.setAttribute('max-inline-size', `${maxInline}px`)
    r.setAttribute('max-block-size', '880px')
    r.setAttribute('max-column-count', vw >= 820 ? '2' : '1')
    r.setAttribute('animated', '')
  }

  /** Re-tune geometry on rotation / window resize (e.g. iPad orientation change). */
  #onResize = () => {
    if (this.#resizeTimer) clearTimeout(this.#resizeTimer)
    this.#resizeTimer = window.setTimeout(() => this.applyLayout(this.#settings), 150)
  }
  #resizeTimer: number | undefined

  /**
   * Writing-mode changes must be re-detected from the content document, so we
   * re-open the book at the current location. Infrequent, so a reload is fine.
   */
  async reopenForWritingMode(file: File): Promise<void> {
    const at = this.lastCFI
    await this.view.open(file)
    this.applyAppearance(this.#settings)
    this.applyLayout(this.#settings)
    await this.view.init({ lastLocation: at || undefined, showTextStart: true })
    this.#nudgeLayout()
  }

  goLeft() {
    return this.view.goLeft()
  }
  goRight() {
    return this.view.goRight()
  }
  goTo(target: string | number) {
    return this.view.goTo(target)
  }

  /** Builds a CFI for a selection range living in a loaded content document. */
  cfiForSelection(doc: Document, range: Range): string | null {
    const index = this.#docIndex.get(doc)
    if (index === undefined) return null
    try {
      return this.view.getCFI(index, range)
    } catch {
      return null
    }
  }

  /** Adds (and immediately paints) a highlight. */
  async addHighlight(cfi: string, hex: string): Promise<void> {
    this.#highlightColors.set(cfi, hex)
    await this.view.addAnnotation({ value: cfi })
  }

  async removeHighlight(cfi: string): Promise<void> {
    this.#highlightColors.delete(cfi)
    await this.view.deleteAnnotation({ value: cfi })
  }

  /** Re-colour an existing highlight in place. */
  async recolorHighlight(cfi: string, hex: string): Promise<void> {
    this.#highlightColors.set(cfi, hex)
    await this.view.deleteAnnotation({ value: cfi })
    await this.view.addAnnotation({ value: cfi })
  }

  /** Seed the highlight set (e.g. on book open) so they draw as sections load. */
  setHighlights(items: Array<{ cfi: string; hex: string }>): void {
    this.#highlightColors.clear()
    for (const { cfi, hex } of items) this.#highlightColors.set(cfi, hex)
    void this.reapplyHighlights()
  }

  /** Ask foliate to (re)draw every known highlight; no-ops for unloaded sections. */
  reapplyHighlights(): void {
    for (const cfi of this.#highlightColors.keys()) {
      void this.view.addAnnotation({ value: cfi }).catch(() => {})
    }
  }

  clearSelection(): void {
    try {
      ;(this.view as any).deselect?.()
    } catch {
      /* ignore */
    }
  }

  destroy() {
    window.removeEventListener('resize', this.#onResize)
    if (this.#resizeTimer) clearTimeout(this.#resizeTimer)
    try {
      ;(this.view as any).close?.()
    } catch {
      /* ignore */
    }
    this.view.remove()
  }

  /** Attach our own tap detector to a freshly loaded content document. */
  #attachTaps(doc: Document) {
    let downX = 0
    let downY = 0
    let downT = 0
    let moved = false

    doc.addEventListener(
      'pointerdown',
      (e: PointerEvent) => {
        downX = e.clientX
        downY = e.clientY
        downT = e.timeStamp
        moved = false
      },
      { passive: true },
    )
    doc.addEventListener(
      'pointermove',
      (e: PointerEvent) => {
        if (Math.hypot(e.clientX - downX, e.clientY - downY) > TAP_MOVE_TOLERANCE) moved = true
      },
      { passive: true },
    )
    doc.addEventListener('pointerup', (e: PointerEvent) => {
      if (moved || e.timeStamp - downT > TAP_MAX_MS) return
      // Ignore taps that are really the end of a text selection.
      const sel = doc.getSelection()
      if (sel && sel.type === 'Range' && sel.toString().length > 0) return

      const frame = doc.defaultView?.frameElement as HTMLElement | null
      const rect = frame?.getBoundingClientRect()
      const px = (rect?.left ?? 0) + e.clientX
      const py = (rect?.top ?? 0) + e.clientY

      const w = doc.documentElement.clientWidth || window.innerWidth
      const third = w / 3
      const zone: TapInfo['zone'] = e.clientX < third ? 'left' : e.clientX > third * 2 ? 'right' : 'center'

      this.#cb.onTap?.({ doc, ix: e.clientX, iy: e.clientY, px, py, zone })
    })

    // Surface finished text selections for the highlight / translate toolbar.
    let selTimer: number | undefined
    doc.addEventListener('selectionchange', () => {
      if (selTimer) clearTimeout(selTimer)
      selTimer = window.setTimeout(() => {
        const sel = doc.getSelection()
        if (sel && sel.type === 'Range' && sel.toString().trim().length > 0) {
          const range = sel.getRangeAt(0)
          const r = range.getBoundingClientRect()
          const frame = doc.defaultView?.frameElement as HTMLElement | null
          const fr = frame?.getBoundingClientRect()
          this.#cb.onSelection?.({
            doc,
            range,
            text: sel.toString(),
            rect: {
              left: (fr?.left ?? 0) + r.left,
              top: (fr?.top ?? 0) + r.top,
              width: r.width,
              height: r.height,
            },
          })
        } else {
          this.#cb.onSelectionCleared?.()
        }
      }, 250)
    })
  }
}
