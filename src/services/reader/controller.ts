// Side-effect import registers the <foliate-view> custom element.
import '../../vendor/foliate-js/view.js'
import type { ReaderSettings } from '../types'
import { viewportSize } from '../viewport'
import { clampOutOfEnglish } from '../translation'
import { EnglishState } from './english'
import { DocumentInput, trackGestures } from './gestures'
import { HighlightPainter, drawHighlight } from './highlights'
import { appearanceCSS, readThemeTokens } from './styles'
import { Timers } from './timers'
import { PageTurner } from './turns'
import type { CharAt, FoliateView, ReaderCallbacks, TurnDir } from './types'

/**
 * Prefetch the chunks `view.open()` imports one inside another (zip → epub → paginator),
 * so a cold open isn't a serial waterfall. Same specifiers, so the module map dedupes.
 */
export function prefetchEngine(): void {
  const swallow = () => {} // the real import retries
  // @ts-ignore — vendored JS module, no type declarations
  void import('../../vendor/foliate-js/vendor/zip.js').catch(swallow)
  // @ts-ignore — vendored JS module, no type declarations
  void import('../../vendor/foliate-js/epub.js').catch(swallow)
  // @ts-ignore — vendored JS module, no type declarations
  void import('../../vendor/foliate-js/paginator.js').catch(swallow)
}

/** `Timers` keys owned by the controller (the helpers own theirs). */
const RESIZE = 'resize'
const NUDGE = 'nudge'

/**
 * Owns the <foliate-view> for one open book: open / re-open, layout and appearance, and
 * the wiring between foliate's events and the helpers — gestures (`./gestures`), page
 * turns (`./turns`), highlights (`./highlights`), English (`./english`).
 */
export class ReaderController {
  view: FoliateView
  #cb: ReaderCallbacks
  #settings: ReaderSettings
  lastCFI = ''
  bookDir: 'ltr' | 'rtl' = 'ltr'
  /** Content document → spine index (for CFI creation). */
  #docIndex = new WeakMap<Document, number>()
  #vertical = false
  /** Host gestures, foliate-view listeners, the in-flight transitionend. */
  #ac = new AbortController()
  /** Every pending timeout; `destroy()` clears them all. */
  #timers = new Timers()
  #docInput: DocumentInput
  #turner: PageTurner
  #highlights: HighlightPainter
  #english: EnglishState
  /** Re-checked after every await. */
  #destroyed = false

  constructor(container: HTMLElement, settings: ReaderSettings, callbacks: ReaderCallbacks) {
    this.#settings = settings
    this.#cb = callbacks
    this.view = document.createElement('foliate-view') as FoliateView
    this.view.style.cssText = 'display:block;width:100%;height:100%'
    container.appendChild(this.view)
    this.#docInput = new DocumentInput(this.#timers, {
      onTap: (info) => this.#cb.onTap?.(info),
      onSwipe: (dir) => void this.#go(dir),
      onKey: (e) => this.#cb.onKey?.(e),
      onSelection: (info) => this.#cb.onSelection?.(info),
      onSelectionCleared: () => this.#cb.onSelectionCleared?.(),
    })
    this.#turner = new PageTurner(this.view, {
      go: (dir) => (dir === 'left' ? this.view.goLeft() : this.view.goRight()),
      atEdge: (dir) => this.#atEdge(dir),
      alive: () => !this.#destroyed,
      timers: this.#timers,
      signal: this.#ac.signal,
    })
    this.#highlights = new HighlightPainter(this.view, this.#timers, () => this.lastCFI)
    this.#english = new EnglishState(this.view, this.#docIndex, settings.showEnglish, () => this.#cb.onEnglish?.())
  }

  /** The book lays out vertically (縦書き). */
  get vertical(): boolean {
    return this.#vertical
  }

  get hasEnglish(): boolean {
    return this.#english.has
  }

  async open(file: File, lastCFI?: string): Promise<void> {
    // Nearest-first hint for the opening section's highlight sweep (before any relocate).
    if (lastCFI) this.lastCFI = lastCFI
    await this.view.open(file)
    if (this.#destroyed) return this.#closeBook()
    this.bookDir = this.view.book?.dir === 'rtl' ? 'rtl' : 'ltr'
    this.#vertical = this.#expectVertical()
    this.#english.detect()
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
      this.#english.onLoad(doc, index)
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
      this.#docInput.attach(doc)
      this.#cb.onLoad?.(doc, index)
    }, { signal })
    this.view.addEventListener('show-annotation', (e: any) => {
      this.#cb.onShowAnnotation?.(e.detail.value, e.detail.range)
    }, { signal })
    this.view.addEventListener('create-overlay', (e: any) => {
      const index = e.detail?.index
      this.#highlights.drawSections(index === undefined ? this.#highlights.loadedIndices() : new Set([index]))
    }, { signal })
    this.view.addEventListener('draw-annotation', (e: any) => drawHighlight(e.detail), { signal })
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
    this.#timers.set(NUDGE, () => {
      try {
        this.applyLayout(this.#settings)
      } catch {
        /* ignore */
      }
    }, 250)
  }

  /** Re-applies the injected stylesheet (theme, fonts, spacing, English). Safe to call
   *  live; a show-all change clears individual reveals and keeps the page. */
  applyAppearance(s: ReaderSettings): void {
    this.#settings = s
    const keep = this.#english.setShowAll(s.showEnglish)
    this.view.renderer?.setStyles?.(appearanceCSS(s, readThemeTokens()))
    this.#english.keepPage(keep)
  }

  /** The unit whose English is `en` is individually revealed. */
  isRevealed(en: Element): boolean {
    return this.#english.isRevealed(en)
  }

  /** Reveal / hide one unit's English (while show-all is off), keeping `at` (the tapped
   *  glyph) on the page when given. */
  setRevealed(en: Element, on: boolean, at?: CharAt | null): void {
    this.#english.setRevealed(en, on, at)
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
    this.#timers.set(RESIZE, () => this.applyLayout(this.#settings), 150)
  }

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
    this.#timers.clear(NUDGE)
    this.#highlights.cancel()
    this.#turner.cancelPending()
    this.#docInput.abortAll()
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

  /**
   * Direction-aware turn (foliate's goLeft/goRight honour `book.dir`), animated as a
   * horizontal push by `PageTurner`: foliate's own `animated` turn slides vertically for 縦書き.
   */
  goLeft() {
    return this.#go('left')
  }
  goRight() {
    return this.#go('right')
  }
  /** The page *after* this one in reading order (Space) — left in an rtl book. */
  goForward() {
    return this.bookDir === 'rtl' ? this.goLeft() : this.goRight()
  }
  /** The page *before* this one in reading order (Shift-Space). */
  goBackward() {
    return this.bookDir === 'rtl' ? this.goRight() : this.goLeft()
  }

  #go(dir: TurnDir): Promise<void> {
    this.#cb.onTurn?.()
    return this.#turner.turn(dir)
  }

  /** Nowhere to turn `dir` to (`goLeft` is forward in an rtl book). */
  #atEdge(dir: TurnDir): boolean {
    const r = this.view.renderer
    if (!r) return false
    const forward = (dir === 'left') === (this.bookDir === 'rtl')
    try {
      return !!(forward ? r.atEnd : r.atStart)
    } catch {
      return false
    }
  }

  goTo(target: string | number) {
    return this.view.goTo(target)
  }

  /** Seek to an overall-book fraction (0..1). */
  goToFraction(frac: number) {
    return this.view.goToFraction(Math.max(0, Math.min(1, frac)))
  }

  /** CFI for a range in a loaded content document. Ends inside English are clamped to the
   *  Japanese (`null` if nothing remains): a highlight never spans into a translation. */
  cfiForSelection(doc: Document, range: Range): string | null {
    const index = this.#docIndex.get(doc)
    if (index === undefined) return null
    try {
      const r = clampOutOfEnglish(range.cloneRange())
      return r ? this.view.getCFI(index, r) : null
    } catch {
      return null
    }
  }

  addHighlight(cfi: string): Promise<void> {
    return this.#highlights.add(cfi)
  }

  removeHighlight(cfi: string): Promise<void> {
    return this.#highlights.remove(cfi)
  }

  /** Replace the highlight set. Call before `open()`: each section then draws its own
   *  share on `create-overlay`. After open it redraws only the loaded section(s). */
  setHighlights(cfis: Iterable<string>): void {
    this.#highlights.set(cfis)
  }

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
    this.#highlights.cancel()
    this.#turner.cancelPending()
    this.#docInput.abortAll()
    this.#timers.clearAll()
    this.#ac.abort()
    this.#closeBook() // an open() in flight re-checks #destroyed and closes what it made
    this.view.remove()
  }

  /** The iframe covers only the text column; margin events bubble to the host (iframe
   *  events don't, so nothing is handled twice). */
  #attachHostGestures() {
    trackGestures(
      this.view,
      {
        onTap: (e) => this.#cb.onTap?.({ doc: null, ix: 0, iy: 0, px: e.clientX, py: e.clientY }),
        onSwipe: (dir) => void this.#go(dir),
      },
      this.#ac.signal,
    )
  }
}
