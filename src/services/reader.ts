// Side-effect import registers the <foliate-view> custom element.
import '../vendor/foliate-js/view.js'
// @ts-ignore — vendored JS module, no type declarations
import { Overlayer } from '../vendor/foliate-js/overlayer.js'
import { HIGHLIGHT_HEX, type ReaderSettings } from './types'
import { viewportSize } from './viewport'
import { nearestFirst } from './cfi'

/**
 * Prefetch the chunks `view.open()` imports one inside another (zip → epub → paginator),
 * so a cold open isn't a serial waterfall. Same specifiers, so the module map dedupes.
 */
export function prefetchEngine(): void {
  const swallow = () => {} // the real import retries
  // @ts-ignore — vendored JS module, no type declarations
  void import('../vendor/foliate-js/vendor/zip.js').catch(swallow)
  // @ts-ignore — vendored JS module, no type declarations
  void import('../vendor/foliate-js/epub.js').catch(swallow)
  // @ts-ignore — vendored JS module, no type declarations
  void import('../vendor/foliate-js/paginator.js').catch(swallow)
}

/** What we read off foliate's `relocate` event. */
export interface RelocateDetail {
  cfi: string
  fraction: number
  tocItem?: { id?: number; label?: string; href?: string }
  range?: Range
}

/** A table-of-contents entry as exposed by foliate's `book.toc`. */
export interface TocItem {
  /** Unique within the book's TOC (foliate numbers items on open). */
  id?: number
  label?: string
  href?: string
  subitems?: TocItem[]
}

/** A single tap on the reading surface (swipes and selection ends already filtered out). */
export interface TapInfo {
  /** The content document tapped, or `null` for a margin tap (outside the iframe). */
  doc: Document | null
  /** Iframe-local coordinates (for the caret APIs). */
  ix: number
  iy: number
  /** Top-window coordinates (popup placement, chrome band). */
  px: number
  py: number
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
  goToFraction(frac: number): Promise<void>
  getSectionFractions(): number[]
  getCFI(index: number, range: Range): string
  resolveCFI(cfi: string): { index: number; anchor?: unknown } | undefined
  addAnnotation(a: { value: string }, remove?: boolean): Promise<{ index: number; label: string }>
  deleteAnnotation(a: { value: string }): Promise<any>
  deselect(): void
  close(): void
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
  /** A user page turn is starting. */
  onTurn?: () => void
  onSelection?: (info: SelectionInfo) => void
  onSelectionCleared?: () => void
  /** A click hit an existing highlight (foliate's overlay hit-test). */
  onShowAnnotation?: (value: string, range: Range) => void
  /** A keydown inside a content document (iframe key events never reach the window). */
  onKey?: (e: KeyboardEvent) => void
}

const TAP_MOVE_TOLERANCE = 16
/** Generous: an aimed press at a 16px glyph (or a careful retry) is slow; a long-press
 *  becomes a WebKit selection, which `shouldIgnoreUp` catches. */
const TAP_MAX_MS = 700
const SWIPE_MIN_DISTANCE = 45
/** Page-turn push: old page drifts + fades out, new page drifts in + fades up. */
const TURN_OUT_MS = 90
const TURN_IN_MS = 170
const TURN_SHIFT_PX = 36
/** A touch swipe is decided on move only this soon after the press; a lingering press
 *  may be an iOS long-press turning into a selection, so it waits for the lift. */
const SWIPE_DECIDE_MS = 500
/** First/last page: nudge and return. */
const BOUNCE_PX = 28
const BOUNCE_MS = 110
/** Highlights drawn per task in a section sweep. */
const HIGHLIGHT_DRAW_CHUNK = 24

function reducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

/** The stylesheet injected into each content document, built from the host's theme tokens. */
function appearanceCSS(s: ReaderSettings): string {
  const cs = getComputedStyle(document.documentElement)
  const tok = (name: string) => cs.getPropertyValue(name).trim()
  const ink = tok('--ink')
  const paper = tok('--paper')
  const accent = tok('--accent')
  const accentSoft = tok('--accent-soft')
  const family = s.fontFamily === 'sans' ? tok('--font-jp-sans') : tok('--font-serif')
  // A transparent iframe root composites over its default (white) canvas, so paint the
  // root with --paper. Key color-scheme off the resolved palette (the setting may be 'auto').
  const scheme = (document.documentElement.dataset.theme || s.theme) === 'dark' ? 'dark' : 'light'

  let wm = ''
  if (s.writingMode === 'vertical') wm = 'writing-mode: vertical-rl !important;'
  else if (s.writingMode === 'horizontal') wm = 'writing-mode: horizontal-tb !important;'

  return `
    @namespace epub "http://www.idpf.org/2007/ops";
    html {
      color: ${ink};
      background: ${paper} !important;
      color-scheme: ${scheme};
      font-size: ${Math.round(s.fontScale * 100)}%;
      -webkit-text-size-adjust: none;
      ${wm}
    }
    body {
      color: ${ink};
      background: transparent !important;
      font-family: ${family};
      -webkit-touch-callout: none;
      /* No double-tap zoom (iOS ignores user-scalable): taps and swipes bail while zoomed. */
      touch-action: manipulation;
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

/** Owns the <foliate-view> for one open book: appearance, layout, gestures, highlights. */
export class ReaderController {
  view: FoliateView
  #cb: ReaderCallbacks
  #settings: ReaderSettings
  lastCFI = ''
  bookDir: 'ltr' | 'rtl' = 'ltr'
  /** Content document → spine index (for CFI creation). */
  #docIndex = new WeakMap<Document, number>()
  /** Highlighted CFIs: the render truth for overlays. */
  #highlights = new Set<string>()
  /** Highlight CFI → spine index, so a section draw only touches its own highlights. */
  #highlightIndex = new Map<string, number>()
  #vertical = false
  /** Host gestures, foliate-view listeners, the in-flight transitionend. */
  #ac = new AbortController()
  /** One controller per content document: an abort signal pins its target, so a
   *  swapped-out section's listeners must not live on the book-long `#ac`. */
  #docACs = new Map<Document, AbortController>()
  #turning = false
  /** Latest turn requested during a turn (rapid swipes coalesce to one). */
  #pendingDir: 'left' | 'right' | null = null
  /** Re-checked after every await. */
  #destroyed = false

  constructor(container: HTMLElement, settings: ReaderSettings, callbacks: ReaderCallbacks) {
    this.#settings = settings
    this.#cb = callbacks
    this.view = document.createElement('foliate-view') as FoliateView
    this.view.style.cssText = 'display:block;width:100%;height:100%'
    container.appendChild(this.view)
  }

  /** The book lays out vertically (縦書き). */
  get vertical(): boolean {
    return this.#vertical
  }

  async open(file: File, lastCFI?: string): Promise<void> {
    // Nearest-first hint for the opening section's highlight sweep (before any relocate).
    if (lastCFI) this.lastCFI = lastCFI
    await this.view.open(file)
    if (this.#destroyed) return this.#closeBook()
    this.bookDir = this.view.book?.dir === 'rtl' ? 'rtl' : 'ltr'
    this.#vertical = this.#expectVertical()
    this.#wireView()

    this.applyAppearance(this.#settings)
    this.applyLayout(this.#settings)
    this.#attachHostGestures()
    window.addEventListener('resize', this.#onResize)
    // iOS reports the post-launch viewport settle only as a visualViewport resize.
    globalThis.visualViewport?.addEventListener('resize', this.#onResize)
    await this.view.init({ lastLocation: lastCFI || undefined, showTextStart: true })
    if (this.#destroyed) return
    this.#nudgeLayout()
  }

  /**
   * Guess the writing mode before the first section loads, so the pre-init `applyLayout`
   * doesn't force a wasted render; the `load` handler corrects a wrong guess.
   * On 'auto', an rtl spine + Japanese language is almost always 縦書き.
   */
  #expectVertical(): boolean {
    const wm = this.#settings.writingMode
    if (wm !== 'auto') return wm === 'vertical'
    if (this.bookDir !== 'rtl') return false
    const lang = this.view.book?.metadata?.language
    const first = String((Array.isArray(lang) ? lang[0] : lang) ?? '')
    return /^ja(?:-|_|$)/i.test(first)
  }

  /** Attach once (from `open()`): these live on the persistent host and survive a re-open. */
  #wireView(): void {
    const signal = this.#ac.signal
    this.view.addEventListener('relocate', (e: any) => {
      const d = e.detail
      this.lastCFI = d.cfi
      this.#cb.onRelocate?.({
        cfi: d.cfi,
        fraction: d.fraction ?? 0,
        tocItem: d.tocItem,
        range: d.range,
      })
    }, { signal })
    this.view.addEventListener('load', (e: any) => {
      const { doc, index } = e.detail
      this.#docIndex.set(doc, index)
      // Must run before the writing mode is read (and before foliate's getDirection).
      this.#applyIntendedWritingMode(doc)
      // Read `body`, like foliate's getDirection, so our measure and its axis agree.
      let vertical = false
      try {
        const el = doc.body ?? doc.documentElement
        vertical = (doc.defaultView.getComputedStyle(el).writingMode || '').startsWith('vertical')
      } catch {
        /* ignore */
      }
      this.#applyPageProgression(doc, vertical)
      if (vertical !== this.#vertical) {
        this.#vertical = vertical
        this.applyLayout(this.#settings)
      }
      this.#attachTaps(doc)
      this.#cb.onLoad?.(doc, index)
    }, { signal })
    this.view.addEventListener('show-annotation', (e: any) => {
      this.#cb.onShowAnnotation?.(e.detail.value, e.detail.range)
    }, { signal })
    this.view.addEventListener('create-overlay', (e: any) => {
      const index = e.detail?.index
      this.#drawSections(index === undefined ? this.#loadedIndices() : new Set([index]))
    }, { signal })
    this.view.addEventListener('draw-annotation', (e: any) => {
      const { draw } = e.detail
      draw(Overlayer.highlight, { color: HIGHLIGHT_HEX })
    }, { signal })
  }

  /**
   * calibre-converted books declare 縦書き only via metadata + `class="vrtl"` on each root,
   * with no writing-mode CSS (foliate reads only `rendition:*`). On 'auto', honour `vrtl`
   * alone — guessing from lang/rtl spine would flip horizontal RTL-bound books.
   * Prepended so the book's own CSS still wins.
   */
  #applyIntendedWritingMode(doc: Document): void {
    if (this.#settings.writingMode !== 'auto') return
    const root = doc.documentElement
    if (!root?.classList.contains('vrtl')) return
    if (doc.querySelector('style[data-tsuzuri="intended-wm"]')) return
    const style = doc.createElement('style')
    style.dataset.tsuzuri = 'intended-wm'
    style.textContent = 'html{writing-mode:vertical-rl;}'
    doc.head?.insertBefore(style, doc.head.firstChild)
  }

  /**
   * An rtl spine with horizontal LTR text: foliate takes column order from the content's
   * CSS direction, not `book.dir`, so the spread would run left-to-right. Make the section
   * rtl (on both html and body — html alone doesn't flip the columns) and pin the text
   * back to ltr. Runs from `load`, before foliate's getDirection.
   */
  #applyPageProgression(doc: Document, vertical: boolean): void {
    if (this.bookDir !== 'rtl' || vertical || this.#settings.writingMode === 'vertical') return
    if (doc.documentElement.dir === 'rtl') return
    doc.documentElement.dir = 'rtl'
    doc.body.dir = 'rtl'
    const style = doc.createElement('style')
    style.dataset.tsuzuri = 'ltr-text'
    style.textContent =
      'body{text-align:left;}' +
      'p,div,h1,h2,h3,h4,h5,h6,li,blockquote,dd,dt,figcaption,td,th{direction:ltr;}'
    doc.head?.appendChild(style)
  }

  /** Hedge: re-derive the layout once the cold-launch iOS viewport has settled (a bare
   *  `render()` would reuse the stale caps). A no-op when nothing changed. */
  #nudgeLayout(): void {
    if (this.#nudgeTimer) clearTimeout(this.#nudgeTimer)
    this.#nudgeTimer = window.setTimeout(() => {
      this.#nudgeTimer = undefined
      try {
        this.applyLayout(this.#settings)
      } catch {
        /* ignore */
      }
    }, 250)
  }
  #nudgeTimer: number | undefined

  /** Re-applies the injected stylesheet (theme, fonts, spacing). Safe to call live. */
  applyAppearance(s: ReaderSettings): void {
    this.#settings = s
    this.view.renderer?.setStyles?.(appearanceCSS(s))
  }

  /**
   * Sets the paginator geometry. In 縦書き `max-inline-size` is the column height and
   * `max-block-size` the page width, both derived from the viewport so the column fills.
   * Idempotent.
   */
  applyLayout(s: ReaderSettings): void {
    this.#settings = s
    const r = this.view.renderer
    if (!r) return
    const { w: vw, h: vh } = viewportSize()
    const minDim = Math.min(vw, vh)
    const margin = Math.round(Math.max(28, Math.min(80, minDim * 0.075)) * s.marginScale)
    // Mirrors foliate's orientation container query (no spread in portrait).
    const cols = vw > vh && vw >= 820 ? 2 : 1

    let block: number
    let inline: number
    if (this.#vertical) {
      inline = Math.round(Math.max(320, vh - margin * 2))
      block = Math.round(vw - margin * 2)
    } else {
      block = 880
      inline = 640
    }

    // Any observed-attribute write re-renders, even with an unchanged value, and iOS fires
    // resize bursts on rotation — without this guard the page flickers.
    const last = this.#lastLayout
    if (
      last &&
      last.vertical === this.#vertical &&
      last.cols === cols &&
      last.margin === margin &&
      last.block === block &&
      last.inline === inline
    )
      return
    this.#lastLayout = { vertical: this.#vertical, cols, margin, block, inline }

    // Write only what changed; `max-inline-size` always and last — its callback is the
    // one that calls render(), so each change is exactly one relayout.
    if (!last || last.margin !== margin) r.setAttribute('margin', `${margin}px`)
    if (!last) r.setAttribute('gap', '6%')
    if (!last || last.cols !== cols) r.setAttribute('max-column-count', `${cols}`)
    if (!last || last.block !== block) r.setAttribute('max-block-size', `${block}px`)
    r.setAttribute('max-inline-size', `${inline}px`)
  }

  #lastLayout: { vertical: boolean; cols: number; margin: number; block: number; inline: number } | undefined

  /** Skipped while pinch-zoomed: visualViewport resizes during a pinch too. */
  #onResize = () => {
    if ((globalThis.visualViewport?.scale ?? 1) > 1.01) return
    if (this.#resizeTimer) clearTimeout(this.#resizeTimer)
    this.#resizeTimer = window.setTimeout(() => this.applyLayout(this.#settings), 150)
  }
  #resizeTimer: number | undefined
  /** selectionchange debounce per document (a 2-up spread has two). */
  #selTimers = new Map<Document, number>()

  /**
   * Re-open at the current location (the paginator only reads the writing mode on load).
   * Serialized: interleaved re-opens orphan a paginator; a superseded queued call is skipped.
   */
  reopenForWritingMode(file: File): Promise<void> {
    const gen = ++this.#reopenGen
    const run = () => (gen === this.#reopenGen && !this.#destroyed ? this.#reopen(file) : undefined)
    this.#reopenChain = this.#reopenChain.then(run, run)
    return this.#reopenChain
  }
  #reopenGen = 0
  #reopenChain: Promise<void> = Promise.resolve()

  /** foliate's `open()` appends a new paginator without removing the old one, so close
   *  the old renderer and Book first. Host listeners (`#wireView`) carry over. */
  async #reopen(file: File): Promise<void> {
    const at = this.lastCFI
    if (this.#nudgeTimer) clearTimeout(this.#nudgeTimer)
    if (this.#redrawTimer) clearTimeout(this.#redrawTimer)
    this.#redrawTimer = undefined
    this.#redrawGen++
    this.#pendingDir = null
    this.#abortDocListeners()
    this.#closeBook()
    await this.view.open(file)
    if (this.#destroyed) return this.#closeBook()
    this.bookDir = this.view.book?.dir === 'rtl' ? 'rtl' : 'ltr'
    this.#vertical = this.#expectVertical()
    this.#lastLayout = undefined // the new paginator has default attributes
    this.applyAppearance(this.#settings)
    this.applyLayout(this.#settings)
    await this.view.init({ lastLocation: at || undefined, showTextStart: true })
    if (this.#destroyed) return
    this.#nudgeLayout()
  }

  /** `close()` doesn't destroy the Book, whose Loader holds a blob URL per resource. */
  #closeBook(): void {
    const book = this.view.book
    try {
      this.view.close()
    } catch {
      /* ignore */
    }
    try {
      book?.destroy?.()
    } catch {
      /* ignore */
    }
  }

  #abortDocListeners(): void {
    for (const t of this.#selTimers.values()) clearTimeout(t)
    this.#selTimers.clear()
    for (const ac of this.#docACs.values()) ac.abort()
    this.#docACs.clear()
  }

  /**
   * Direction-aware turn (foliate's goLeft/goRight honour `book.dir`), animated as a
   * horizontal push by us: foliate's own `animated` turn slides vertically for 縦書き.
   */
  goLeft() {
    this.#cb.onTurn?.()
    return this.#turn('left')
  }
  goRight() {
    this.#cb.onTurn?.()
    return this.#turn('right')
  }
  /** The page *after* this one in reading order (Space) — left in an rtl book. */
  goForward() {
    return this.bookDir === 'rtl' ? this.goLeft() : this.goRight()
  }
  /** The page *before* this one in reading order (Shift-Space). */
  goBackward() {
    return this.bookDir === 'rtl' ? this.goRight() : this.goLeft()
  }

  async #turn(dir: 'left' | 'right'): Promise<void> {
    if (this.#turning) {
      this.#pendingDir = dir
      return
    }
    this.#turning = true
    try {
      if (this.#atEdge(dir)) await this.#bounce(dir)
      else await this.#slide(dir)
    } finally {
      this.#turning = false
      const next = this.#pendingDir
      this.#pendingDir = null
      if (next && !this.#destroyed) void this.#turn(next)
    }
  }

  /** Nowhere to turn `dir` to (`goLeft` is forward in an rtl book). */
  #atEdge(dir: 'left' | 'right'): boolean {
    const r = this.view.renderer
    if (!r) return false
    const forward = (dir === 'left') === (this.bookDir === 'rtl')
    try {
      return !!(forward ? r.atEnd : r.atStart)
    } catch {
      return false
    }
  }

  async #slide(dir: 'left' | 'right'): Promise<void> {
    const el = this.view
    // Both pages travel the way the content moves (goLeft ⇐ finger dragged right).
    const sign = dir === 'left' ? 1 : -1
    const shift = reducedMotion() ? 0 : TURN_SHIFT_PX
    await this.#transition(TURN_OUT_MS, 'cubic-bezier(.4, 0, 1, 1)', `translateX(${sign * shift}px)`, 0)
    if (this.#destroyed) return
    el.style.transition = 'none' // jump while invisible (instant: `animated` is off)
    try {
      await (dir === 'left' ? this.view.goLeft() : this.view.goRight())
    } catch {
      /* view may be tearing down */
    }
    if (this.#destroyed) return
    el.style.transform = `translateX(${-sign * shift}px)`
    // Commit the start position with transitions off, or the page animates in from the exit side.
    void el.offsetWidth
    await this.#transition(TURN_IN_MS, 'cubic-bezier(0, 0, .2, 1)', 'translateX(0)', 1)
    el.style.transition = ''
    el.style.transform = ''
    el.style.opacity = ''
  }

  async #bounce(dir: 'left' | 'right'): Promise<void> {
    const el = this.view
    const px = dir === 'left' ? BOUNCE_PX : -BOUNCE_PX
    await this.#transition(BOUNCE_MS, 'cubic-bezier(.3, 0, .5, 1)', `translateX(${px}px)`)
    if (this.#destroyed) return
    await this.#transition(BOUNCE_MS * 1.4, 'cubic-bezier(.2, 0, .2, 1)', 'translateX(0)')
    el.style.transition = ''
    el.style.transform = ''
  }

  /** Transition the view and resolve on `transitionend` (or a fallback timeout). */
  #transition(ms: number, easing: string, transform: string, opacity?: number): Promise<void> {
    const el = this.view
    return new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        if (this.#slideTimer) {
          clearTimeout(this.#slideTimer)
          this.#slideTimer = undefined
        }
        el.removeEventListener('transitionend', onEnd)
        resolve()
      }
      const onEnd = (e: TransitionEvent) => {
        // Key off opacity when animated: a reduced-motion turn has no transform change.
        if (e.propertyName === (opacity === undefined ? 'transform' : 'opacity')) finish()
      }
      el.addEventListener('transitionend', onEnd, { signal: this.#ac.signal })
      el.style.transition =
        opacity === undefined ? `transform ${ms}ms ${easing}` : `transform ${ms}ms ${easing}, opacity ${ms}ms ${easing}`
      void el.offsetWidth // commit the transition before the new transform
      el.style.transform = transform
      if (opacity !== undefined) el.style.opacity = String(opacity)
      this.#slideTimer = window.setTimeout(finish, ms + 120)
    })
  }
  #slideTimer: number | undefined

  goTo(target: string | number) {
    return this.view.goTo(target)
  }

  /** Seek to an overall-book fraction (0..1). */
  goToFraction(frac: number) {
    return this.view.goToFraction(Math.max(0, Math.min(1, frac)))
  }

  /** CFI for a range in a loaded content document. */
  cfiForSelection(doc: Document, range: Range): string | null {
    const index = this.#docIndex.get(doc)
    if (index === undefined) return null
    try {
      return this.view.getCFI(index, range)
    } catch {
      return null
    }
  }

  #indexForCFI(cfi: string): number | undefined {
    let idx = this.#highlightIndex.get(cfi)
    if (idx === undefined) {
      try {
        idx = this.view.resolveCFI(cfi)?.index
      } catch {
        idx = undefined
      }
      if (idx !== undefined) this.#highlightIndex.set(cfi, idx)
    }
    return idx
  }

  async addHighlight(cfi: string): Promise<void> {
    this.#highlights.add(cfi)
    this.#indexForCFI(cfi)
    await this.view.addAnnotation({ value: cfi })
  }

  async removeHighlight(cfi: string): Promise<void> {
    this.#highlights.delete(cfi)
    this.#highlightIndex.delete(cfi)
    await this.view.deleteAnnotation({ value: cfi })
  }

  /** Replace the highlight set. Call before `open()`: each section then draws its own
   *  share on `create-overlay`. After open it redraws only the loaded section(s). */
  setHighlights(cfis: Iterable<string>): void {
    this.#highlights = new Set(cfis)
    this.#highlightIndex.clear()
    const loaded = this.#loadedIndices()
    if (loaded.size) this.#drawSections(loaded)
  }

  #loadedIndices(): Set<number> {
    const out = new Set<number>()
    try {
      for (const c of this.view.renderer?.getContents?.() ?? []) if (typeof c.index === 'number') out.add(c.index)
    } catch {
      /* renderer not ready */
    }
    return out
  }

  /**
   * Draw the given sections' highlights nearest-first around `lastCFI`, in chunks that
   * yield between tasks: every looked-up word is highlighted, and each draw re-anchors and
   * measures a Range. A newer sweep abandons the one in flight.
   */
  #drawSections(indices: Set<number>): void {
    const gen = ++this.#redrawGen
    if (this.#redrawTimer) clearTimeout(this.#redrawTimer)
    this.#redrawTimer = undefined
    if (!indices.size) return
    let cfis: string[] = []
    for (const cfi of this.#highlights) {
      const i = this.#indexForCFI(cfi)
      if (i !== undefined && indices.has(i)) cfis.push(cfi)
    }
    if (!cfis.length) return
    if (this.lastCFI && cfis.length > HIGHLIGHT_DRAW_CHUNK) cfis = nearestFirst(cfis, this.lastCFI)
    const drawChunk = (from: number) => {
      if (gen !== this.#redrawGen) return
      const to = Math.min(from + HIGHLIGHT_DRAW_CHUNK, cfis.length)
      for (let i = from; i < to; i++) void this.view.addAnnotation({ value: cfis[i] }).catch(() => {})
      if (to < cfis.length) this.#redrawTimer = window.setTimeout(() => drawChunk(to), 0)
      else this.#redrawTimer = undefined
    }
    drawChunk(0)
  }
  #redrawGen = 0
  #redrawTimer: number | undefined

  clearSelection(): void {
    try {
      this.view.deselect()
    } catch {
      /* ignore */
    }
  }

  destroy() {
    this.#destroyed = true
    this.#reopenGen++ // cancel a queued re-open
    window.removeEventListener('resize', this.#onResize)
    globalThis.visualViewport?.removeEventListener('resize', this.#onResize)
    if (this.#resizeTimer) clearTimeout(this.#resizeTimer)
    if (this.#nudgeTimer) clearTimeout(this.#nudgeTimer)
    if (this.#slideTimer) clearTimeout(this.#slideTimer)
    if (this.#redrawTimer) clearTimeout(this.#redrawTimer)
    this.#redrawGen++
    this.#pendingDir = null
    this.#abortDocListeners()
    this.#ac.abort()
    this.#closeBook() // an open() in flight re-checks #destroyed and closes what it made
    this.view.remove()
  }

  /**
   * Pointer → swipe/tap state machine for a content document or the host (margins).
   * A quick one-finger touch swipe turns on the move and its lift is ignored; mouse/pen
   * (drag-select), a lingering press or a live selection wait for `pointerup`.
   */
  #trackGestures(
    target: Document | HTMLElement,
    opts: {
      shouldIgnoreUp?: (e: PointerEvent) => boolean
      /** False while a swipe must not be decided early (e.g. a text selection is live). */
      canSwipeEarly?: () => boolean
      onTap: (e: PointerEvent) => void
    },
    signal: AbortSignal = this.#ac.signal,
  ) {
    let downX = 0
    let downY = 0
    let downT = 0
    let moved = false
    let active = false
    /** A second contact joined: never decide a swipe early. */
    let multi = false

    const swipe = (dx: number) => {
      // The page follows the finger: drag left → the page on the right.
      if (dx < 0) void this.goRight()
      else void this.goLeft()
    }
    const zoomed = () => (globalThis.visualViewport?.scale ?? 1) > 1.01

    target.addEventListener(
      'pointerdown',
      (ev: Event) => {
        const e = ev as PointerEvent
        if (!e.isPrimary) {
          multi = true
          return
        }
        active = true
        multi = false
        downX = e.clientX
        downY = e.clientY
        downT = e.timeStamp
        moved = false
      },
      { passive: true, signal },
    )
    target.addEventListener(
      'pointermove',
      (ev: Event) => {
        const e = ev as PointerEvent
        // A second contact would be measured against the first finger's down point.
        if (!e.isPrimary || !active) return
        const dx = e.clientX - downX
        const dy = e.clientY - downY
        if (!moved && Math.hypot(dx, dy) > TAP_MOVE_TOLERANCE) moved = true
        if (
          e.pointerType === 'touch' &&
          !multi &&
          Math.abs(dx) >= SWIPE_MIN_DISTANCE &&
          Math.abs(dx) > Math.abs(dy) &&
          e.timeStamp - downT <= SWIPE_DECIDE_MS &&
          !zoomed() &&
          (opts.canSwipeEarly?.() ?? true)
        ) {
          active = false // consumed: the lift does nothing
          swipe(dx)
        }
      },
      { passive: true, signal },
    )
    target.addEventListener(
      'pointercancel',
      (ev: Event) => {
        if (!(ev as PointerEvent).isPrimary) return
        active = false
        moved = true
      },
      { passive: true, signal },
    )
    target.addEventListener(
      'pointerup',
      (ev: Event) => {
        const e = ev as PointerEvent
        // Check isPrimary before consuming `active`: a second finger lifting must not end the gesture.
        if (!e.isPrimary) return
        if (!active) return
        active = false
        if (opts.shouldIgnoreUp?.(e)) return
        if (zoomed()) return

        const dx = e.clientX - downX
        const dy = e.clientY - downY
        if (Math.abs(dx) >= SWIPE_MIN_DISTANCE && Math.abs(dx) > Math.abs(dy)) {
          swipe(dx)
          return
        }
        if (moved || e.timeStamp - downT > TAP_MAX_MS) return
        opts.onTap(e)
      },
      { passive: true, signal },
    )
  }

  /** The iframe covers only the text column; margin events bubble to the host (iframe
   *  events don't, so nothing is handled twice). */
  #attachHostGestures() {
    this.#trackGestures(this.view, {
      onTap: (e) => this.#cb.onTap?.({ doc: null, ix: 0, iy: 0, px: e.clientX, py: e.clientY }),
    })
  }

  /** Gestures, key forwarding and selection reporting for a freshly loaded document. */
  #attachTaps(doc: Document) {
    // Drop controllers of this doc and of documents whose browsing context is gone.
    for (const [d, ac] of this.#docACs) {
      if (d === doc || !d.defaultView) {
        ac.abort()
        this.#docACs.delete(d)
        const t = this.#selTimers.get(d)
        if (t) {
          clearTimeout(t)
          this.#selTimers.delete(d)
        }
      }
    }
    const docAC = new AbortController()
    this.#docACs.set(doc, docAC)
    const signal = docAC.signal

    this.#trackGestures(
      doc,
      {
        // Ignore only a press inside the live selection. WebKit collapses a selection after
        // our pointerup, so bailing on any selection would swallow the tap that dismisses it.
        shouldIgnoreUp: (e) => {
          const sel = doc.getSelection()
          if (!sel || sel.type !== 'Range' || !sel.toString().length) return false
          for (let i = 0; i < sel.rangeCount; i++)
            for (const r of sel.getRangeAt(i).getClientRects())
              if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom)
                return true
          try {
            sel.removeAllRanges()
          } catch {
            /* ignore */
          }
          return false
        },
        // The finger may be dragging a selection handle.
        canSwipeEarly: () => doc.getSelection()?.type !== 'Range',
        onTap: (e) => {
          const frame = doc.defaultView?.frameElement as HTMLElement | null
          const rect = frame?.getBoundingClientRect()
          const px = (rect?.left ?? 0) + e.clientX
          const py = (rect?.top ?? 0) + e.clientY
          this.#cb.onTap?.({ doc, ix: e.clientX, iy: e.clientY, px, py })
        },
      },
      signal,
    )

    // Iframe key events never reach the top window.
    doc.addEventListener('keydown', (e) => this.#cb.onKey?.(e), { signal })

    doc.addEventListener(
      'selectionchange',
      () => {
        const prev = this.#selTimers.get(doc)
        if (prev) clearTimeout(prev)
        this.#selTimers.set(
          doc,
          window.setTimeout(() => {
            this.#selTimers.delete(doc)
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
          }, 250),
        )
      },
      { signal },
    )
  }
}
