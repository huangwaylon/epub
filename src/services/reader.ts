// Side-effect import registers the <foliate-view> custom element.
import '../vendor/foliate-js/view.js'
// @ts-ignore — vendored JS module, no type declarations
import { Overlayer } from '../vendor/foliate-js/overlayer.js'
import { HIGHLIGHT_HEX, type ReaderSettings } from './types'
import { viewportSize } from './viewport'
import { nearestFirst } from './cfi'

/**
 * Start fetching the chunks foliate loads lazily inside `view.open()` — the zip reader,
 * the EPUB parser and the paginator. Each is a separate dynamic `import()` *inside* the
 * previous step (unzip → parse → pick renderer), so on a cold open they were fetched one
 * after another: a serial chunk waterfall on the critical path. Requesting them all up
 * front (same specifiers, so Vite resolves the same chunks and the module map dedupes
 * them) turns that into one parallel round-trip. No vendor edit; safe to call repeatedly.
 */
export function prefetchEngine(): void {
  const swallow = () => {} // a failed prefetch just leaves the real import to retry
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
  /** `id` is foliate's unique per-item TOC id (assigned when the book opens). */
  tocItem?: { id?: number; label?: string; href?: string }
  range?: Range
}

/** A table-of-contents entry as exposed by foliate's `book.toc`. */
export interface TocItem {
  /** Unique within the book's TOC — foliate numbers every item on open. */
  id?: number
  label?: string
  href?: string
  subitems?: TocItem[]
}

/** A resolved single tap inside the rendered content (after filtering swipes/selection). */
export interface TapInfo {
  /**
   * The content document the tap landed in, or `null` for a tap in the surrounding
   * margins (which are outside the content iframe, so there's no word to define).
   */
  doc: Document | null
  /** Coordinates within the content iframe (for caretRangeFromPoint). */
  ix: number
  iy: number
  /** Coordinates in the top window (for positioning popups). */
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
  prev(distance?: number): Promise<void>
  next(distance?: number): Promise<void>
  goToFraction(frac: number): Promise<void>
  getCFI(index: number, range: Range): string
  /** Resolve a CFI to its spine index (+ a doc→Range anchor) synchronously. */
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
  /** A user-initiated page turn (swipe). Fires when a turn begins. */
  onTurn?: () => void
  onSelection?: (info: SelectionInfo) => void
  onSelectionCleared?: () => void
  /** A tap landed on an existing highlight (foliate's overlay hit-test). */
  onShowAnnotation?: (value: string, range: Range) => void
  /** A keydown inside a content document (iframe key events never reach the window). */
  onKey?: (e: KeyboardEvent) => void
}

const TAP_MOVE_TOLERANCE = 16
/**
 * Longest a stationary press can last and still count as a tap. Generous on purpose:
 * tap-to-define invites a *deliberate, aimed* press at a single 16px glyph (and a user
 * who just missed aims more carefully, i.e. slower), so a tight window silently drops
 * exactly the taps that matter most. Nothing else competes for a stationary press —
 * pagination needs `SWIPE_MIN_DISTANCE` of travel — and a real long-press hands off to
 * WebKit's selection, which `shouldIgnoreUp` catches.
 */
const TAP_MAX_MS = 700
/** Minimum horizontal travel (px) for a drag to count as a page-turn swipe. */
const SWIPE_MIN_DISTANCE = 45
/** One phase (out / in) of the horizontal page-turn slide. */
const TURN_PHASE_MS = 150
/**
 * A touch swipe is decided in `pointermove`, the moment the finger crosses
 * `SWIPE_MIN_DISTANCE`, rather than on lift — but only within this long of the press.
 * A quick flick is unambiguous; a press that has lingered may be an iOS long-press that
 * is about to become a text selection, so that stays with the `pointerup` decision.
 */
const SWIPE_DECIDE_MS = 500
/** First/last page: a short nudge-and-return instead of sliding out to nothing. */
const BOUNCE_PX = 28
const BOUNCE_MS = 110
/** How many highlights to (re)draw per task when a section's overlays are seeded. */
const HIGHLIGHT_DRAW_CHUNK = 24

/**
 * Builds the stylesheet foliate injects into each content document. Reads the
 * live theme tokens from the host so the page matches the app exactly.
 */
function appearanceCSS(s: ReaderSettings): string {
  // One getComputedStyle read (it forces a style flush); pull every token off it.
  const cs = getComputedStyle(document.documentElement)
  const tok = (name: string) => cs.getPropertyValue(name).trim()
  const ink = tok('--ink')
  const paper = tok('--paper')
  const accent = tok('--accent')
  const accentSoft = tok('--accent-soft')
  const family = s.fontFamily === 'sans' ? tok('--font-jp-sans') : tok('--font-serif')
  // The content iframe is its own document with no theme of its own. A transparent
  // root composites over the iframe's *default* canvas — which follows color-scheme
  // and is white unless told otherwise — so a transparent page reads light even in
  // dark mode. Paint the root with the resolved paper colour (so it matches the app
  // chrome and the margins exactly) and set color-scheme so form controls/scrollbars
  // follow the theme too.
  // Key off the *resolved* palette on <html data-theme>: the preference may be 'auto'.
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
      /* Use our own selection toolbar instead of the native iOS callout menu. */
      -webkit-touch-callout: none;
      /* Kill double-tap-to-zoom. iOS ignores maximum-scale/user-scalable, so a stray
         double tap while aiming at a word could leave the page zoomed — and both our tap
         detector and foliate's own page turn bail out while the visual viewport is scaled,
         so every tap and swipe would silently stop working until the reader pinched back
         out. The 'manipulation' value keeps pinch-zoom (accessibility) and drops only the
         double-tap gesture, which the reader has no use for. */
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
  /** Set of highlighted CFIs — the source of truth when (re)drawing overlays.
   *  Highlights are a single colour (yellow); there is no per-highlight colour. */
  #highlights = new Set<string>()
  /** Cache of each highlight CFI → its spine index, so the per-section overlay
   *  redraw only touches the highlights that live in the just-loaded section
   *  (instead of re-resolving every highlight in the book on every page-turn). */
  #highlightIndex = new Map<string, number>()
  /** Whether the current book renders vertically (縦書き); affects measure. */
  #vertical = false
  /** Aborts every per-document listener we attach, in one shot, on destroy. */
  #ac = new AbortController()
  /** Per-content-document listener controllers, so a section's listeners (and its
   *  reference to that document) die when the paginator swaps the document out. */
  #docACs = new Map<Document, AbortController>()
  /** Guards the page-turn slide so re-entrant taps don't overlap animations. */
  #turning = false
  #pendingDir: 'left' | 'right' | null = null
  /** Set by destroy(); every async path re-checks it after each await. */
  #destroyed = false

  constructor(container: HTMLElement, settings: ReaderSettings, callbacks: ReaderCallbacks) {
    this.#settings = settings
    this.#cb = callbacks
    this.view = document.createElement('foliate-view') as FoliateView
    this.view.style.cssText = 'display:block;width:100%;height:100%'
    container.appendChild(this.view)
  }

  /** Whether the open book is laid out vertically (縦書き) — the dictionary popup sits
   *  beside the tapped column rather than above it. */
  get vertical(): boolean {
    return this.#vertical
  }

  async open(file: File, lastCFI?: string): Promise<void> {
    // Where we're about to land, as a hint for the nearest-first highlight sweep that runs
    // on the opening section's `create-overlay` — before the first `relocate` reports it.
    if (lastCFI) this.lastCFI = lastCFI
    await this.view.open(file)
    if (this.#destroyed) return this.#closeBook() // left mid-open: don't leak the Book
    this.bookDir = this.view.book?.dir === 'rtl' ? 'rtl' : 'ltr'
    this.#vertical = this.#expectVertical()
    this.#wireView()

    this.applyAppearance(this.#settings)
    this.applyLayout(this.#settings)
    this.#attachHostGestures()
    window.addEventListener('resize', this.#onResize)
    // iOS settles the standalone PWA viewport *after* launch (safe-area insets, chrome)
    // and signals it via a visualViewport resize rather than a window resize — without
    // this listener the cold-launch dead band only clears on rotation. Guarded against
    // pinch-zoom in #onResize so a zoom gesture doesn't re-derive the page box.
    globalThis.visualViewport?.addEventListener('resize', this.#onResize)
    await this.view.init({ lastLocation: lastCFI || undefined, showTextStart: true })
    if (this.#destroyed) return
    this.#nudgeLayout()
  }

  /**
   * Best guess, before anything renders, of whether the book will lay out vertically.
   *
   * `applyLayout` runs before `view.init` so the first paint has the right geometry — but
   * the real writing mode is only known once a section document loads. With the old
   * `#vertical = false` default, every 縦書き book's first `load` flipped the flag and
   * re-ran `applyLayout`, whose `max-inline-size` change forces a paginator `render()` —
   * a full columnize of the section, inside foliate's `afterLoad`, with the *stale*
   * horizontal axis, immediately thrown away by foliate's own render a moment later.
   * Guessing right skips that render; guessing wrong costs exactly what it always did (the
   * `load` handler still corrects it). An explicit setting is authoritative; on 'auto', an
   * rtl spine + Japanese language is overwhelmingly a 縦書き novel.
   */
  #expectVertical(): boolean {
    const wm = this.#settings.writingMode
    if (wm !== 'auto') return wm === 'vertical'
    if (this.bookDir !== 'rtl') return false
    const lang = this.view.book?.metadata?.language
    const first = String((Array.isArray(lang) ? lang[0] : lang) ?? '')
    return /^ja(?:-|_|$)/i.test(first)
  }

  /**
   * Wire the foliate-view events to our callbacks. These listeners live on the
   * persistent `<foliate-view>` host (not the renderer), so they survive a
   * `reopenForWritingMode` re-open and must only be attached once — hence this is
   * called solely from `open()`. All are registered with `#ac.signal` so the single
   * `destroy()` abort removes them deterministically alongside the gesture listeners.
   */
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
      // A book may *intend* 縦書き without saying so in CSS — see #applyIntendedWritingMode.
      // Runs before the writing mode is read below (and before foliate's own getDirection),
      // so the very first paint is already vertical.
      this.#applyIntendedWritingMode(doc)
      // Detect the writing mode from the rendered document so we can pick a
      // measure that suits it (vertical wants tall columns; horizontal a short line).
      // Read the same element foliate's `getDirection` does (`body`), so our measure and
      // the paginator's axis can never disagree about a book that sets it on body only.
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
    // Re-draw stored highlights whenever a section's overlay becomes available —
    // only the highlights belonging to *that* section, not the whole book.
    this.view.addEventListener('create-overlay', (e: any) => this.reapplyHighlights(e.detail?.index), {
      signal,
    })
    this.view.addEventListener('draw-annotation', (e: any) => {
      const { draw } = e.detail
      draw(Overlayer.highlight, { color: HIGHLIGHT_HEX })
    }, { signal })
  }

  /**
   * Honour a book's *intended* vertical writing mode when its CSS never states one.
   *
   * Japanese novels converted by calibre are the common case: the OPF carries
   * `<meta name="primary-writing-mode" content="vertical-rl">` and every section's `<html>`
   * gets `class="vrtl"`, but **no stylesheet rule ever sets `writing-mode`** — calibre's
   * own viewer applies it from that metadata. foliate reads only the standard `rendition:*`
   * metadata, so such a book renders 横書き, and the reader has to know to flip the Writing
   * direction setting by hand for every book.
   *
   * With `writingMode: 'auto'` we therefore take the class as the declaration it was meant
   * to be. `vrtl` is the JP-EPUB idiom for "this book is 縦書き" (properly typeset ones pair
   * it with `.vrtl { -epub-writing-mode: vertical-rl }` — prefixed, which is why grepping
   * for the unprefixed property is not a reliable test of intent), so keying on it is
   * specific: no guessing from `lang` or the rtl spine direction, which would wrongly flip
   * the genuinely-horizontal RTL-bound books that `#applyPageProgression` exists to
   * support. The rule is **prepended** so a book that does declare its own writing-mode
   * still wins, and an explicit 横書き/縦書き setting overrides both (`appearanceCSS`
   * injects those with `!important`).
   */
  #applyIntendedWritingMode(doc: Document): void {
    if (this.#settings.writingMode !== 'auto') return
    const root = doc.documentElement
    if (!root?.classList.contains('vrtl')) return
    if (doc.querySelector('style[data-tsuzuri="intended-wm"]')) return
    const style = doc.createElement('style')
    style.dataset.tsuzuri = 'intended-wm'
    style.textContent = 'html{writing-mode:vertical-rl;}'
    // Prepend so the book's own stylesheets (and our appearance sheet) can still override.
    doc.head?.insertBefore(style, doc.head.firstChild)
  }

  /**
   * Honour the book's page-progression direction for the *column* layout, not just
   * navigation. A spine declared `page-progression-direction="rtl"` (right-to-left
   * page order) whose text is ordinary horizontal LTR — no vertical writing mode, no
   * `dir="rtl"` in its CSS — would otherwise paginate its 2-up spread left-to-right:
   * foliate derives the column order from the *content's own* CSS direction (ltr),
   * ignoring the rtl progression (`book.dir` only feeds the direction-aware
   * `goLeft`/`goRight`).
   *
   * The fix makes the section behave like a native RTL book — `dir="rtl"` on **both**
   * `documentElement` and `body` — so foliate's `getDirection` reports RTL and its
   * well-tested RTL path lays the columns right-to-left (the earlier page on the right)
   * with the matching negative-scroll math. `dir="rtl"` on the multicolumn container
   * (`documentElement`) alone does *not* flip the columns in this layout; the `body`
   * also has to be rtl. We then pin the inline **text** back to ltr with a `direction:
   * ltr` rule on the block elements, so the horizontal Japanese text itself still reads
   * left-to-right — only the page/column order is reversed.
   *
   * Runs inside foliate's `afterLoad` (the `load` event fires synchronously from it,
   * before `getDirection`), so the very first paint is already correct — no re-render
   * flash. Vertical (縦書き) books are left untouched: their right-to-left column
   * stacking already follows from `writing-mode: vertical-rl`.
   */
  #applyPageProgression(doc: Document, vertical: boolean): void {
    if (this.bookDir !== 'rtl' || vertical || this.#settings.writingMode === 'vertical') return
    if (doc.documentElement.dir === 'rtl') return
    doc.documentElement.dir = 'rtl'
    doc.body.dir = 'rtl'
    // Keep the horizontal text left-to-right; only the column/page order is rtl.
    const style = doc.createElement('style')
    style.dataset.tsuzuri = 'ltr-text'
    style.textContent =
      'body{text-align:left;}' +
      'p,div,h1,h2,h3,h4,h5,h6,li,blockquote,dd,dt,figcaption,td,th{direction:ltr;}'
    doc.head?.appendChild(style)
  }

  /**
   * `applyLayout` derives the vertical page box from the viewport, so the column
   * fills on the first paint (verified in desktop Chrome at iPad-landscape). The old
   * foliate under-measure quirk (docs §11) is unverified on real iOS, so we keep one
   * cheap re-layout after fonts/layout settle as a hedge; the resize listeners are the
   * reliable backstop if a real device still under-measures.
   *
   * Crucially this **re-runs `applyLayout`** (not a bare `render()`): on a cold iOS PWA
   * launch the viewport / safe-area insets settle slightly after first paint, so the
   * first `applyLayout` can derive a too-short vertical `max-inline-size` (the column
   * height) and leave a dead band under the nav bar — the band that vanishes on
   * rotation. Re-deriving here picks up the settled viewport without needing a rotation;
   * applyLayout no-ops if the geometry is in fact unchanged (so this costs nothing when
   * the first measure was already right).
   */
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
   * Applies page-geometry attributes, tuned for comfortable reading and scaled to
   * the device. The two axes swap meaning between writing modes (see the paginator
   * notes in docs/reader-engine.md §6/§7), so we compute the caps per mode:
   *
   * - Horizontal: `max-inline-size` is the line length, `max-block-size` the page
   *   height.
   * - Vertical (縦書き): `max-inline-size` becomes the column *height*, and
   *   `max-block-size` the across-page *width*.
   *
   * For vertical we derive both from the live viewport so the page box fits the
   * screen exactly and the column fills it. A hard-coded `max-inline-size` (the old
   * 1100) is what let the first vertical paint settle ~2× too tall, overflowing the
   * viewport and leaving a dead band (docs §11).
   */
  applyLayout(s: ReaderSettings): void {
    this.#settings = s
    const r = this.view.renderer
    if (!r) return
    const { w: vw, h: vh } = viewportSize()
    const minDim = Math.min(vw, vh)
    const margin = Math.round(Math.max(28, Math.min(80, minDim * 0.075)) * s.marginScale)
    // A two-page spread only applies in landscape on wide screens — this mirrors
    // foliate's orientation container-query, which collapses the spread in portrait.
    const cols = vw > vh && vw >= 820 ? 2 : 1

    let block: number
    let inline: number
    if (this.#vertical) {
      // Vertical 縦書き: `max-block-size` is the across-page *width*, `max-inline-size`
      // the column *height*. Derive both from the viewport so the box fits the screen
      // and the column fills it (a hard-coded inline size let the first paint settle
      // ~2× too tall, leaving a dead band — docs §11). Fill the width (only the margin
      // frames it) and the full height minus the margin band.
      inline = Math.round(Math.max(320, vh - margin * 2))
      block = Math.round(vw - margin * 2)
    } else {
      block = 880
      inline = 640
    }

    // Skip redundant work: setting an observed attribute re-fires foliate's
    // attributeChangedCallback → render() (a full iframe relayout + repaint) *even when
    // the value is unchanged*. iOS emits a burst of resize/visualViewport events during
    // a rotation (and `window.inner*` lags the settled viewport), so without this guard
    // each event repaints the page — the continuous flicker. Bail once the derived
    // geometry is stable; a rotation that returns to the same size then does no work.
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

    // Touch only what changed (each write restyles the paginator's grid) — except
    // `max-inline-size`, which is set whenever *anything* changed, and last: its
    // attributeChangedCallback is the one that explicitly calls render(), so it is what
    // guarantees exactly one relayout with every other attribute already in place.
    if (!last || last.margin !== margin) r.setAttribute('margin', `${margin}px`)
    if (!last) r.setAttribute('gap', '6%')
    if (!last || last.cols !== cols) r.setAttribute('max-column-count', `${cols}`)
    if (!last || last.block !== block) r.setAttribute('max-block-size', `${block}px`)
    r.setAttribute('max-inline-size', `${inline}px`)
  }

  /** Last geometry applied to the renderer; lets applyLayout skip redundant renders. */
  #lastLayout: { vertical: boolean; cols: number; margin: number; block: number; inline: number } | undefined

  /** Re-tune geometry on rotation / window resize / iOS viewport settle (e.g. iPad
   *  orientation change, or the standalone PWA viewport finalising after a cold launch).
   *  Skipped while pinch-zoomed (`scale > 1`) — visualViewport resize also fires during a
   *  pinch, and re-deriving the page box mid-zoom would fight the gesture. */
  #onResize = () => {
    if ((globalThis.visualViewport?.scale ?? 1) > 1.01) return
    if (this.#resizeTimer) clearTimeout(this.#resizeTimer)
    this.#resizeTimer = window.setTimeout(() => this.applyLayout(this.#settings), 150)
  }
  #resizeTimer: number | undefined
  /** Debounce timers for each loaded document's selectionchange, keyed by doc so a
   *  2-up spread's two documents don't share (and clobber) one timer. Cleared on destroy. */
  #selTimers = new Map<Document, number>()

  /**
   * Writing-mode changes must be re-detected from the content document, so we
   * re-open the book at the current location. Infrequent, so a reload is fine.
   *
   * **Serialized.** Each call queues behind the one in flight, and a call that is
   * superseded before it starts is skipped — so tapping 横書き/縦書き/Auto in quick
   * succession runs at most the current re-open plus the latest request. Unserialized,
   * two re-opens interleaved their `close()`/`open()` awaits and the loser's freshly
   * created paginator was never closed (an orphaned renderer: iframe document, two
   * ResizeObservers, touch listeners, the Book's blob URLs).
   */
  reopenForWritingMode(file: File): Promise<void> {
    const gen = ++this.#reopenGen
    const run = () => (gen === this.#reopenGen && !this.#destroyed ? this.#reopen(file) : undefined)
    this.#reopenChain = this.#reopenChain.then(run, run)
    return this.#reopenChain
  }
  #reopenGen = 0
  #reopenChain: Promise<void> = Promise.resolve()

  /**
   * `view.close()` first: foliate's `open()` creates a fresh `<foliate-paginator>`
   * and appends it without removing the previous one, so a bare re-open orphans the
   * old renderer — its iframe document, two ResizeObservers, and non-passive touch
   * listeners leak (one full paginator per toggle, confirmed via heap snapshot).
   * `close()` calls the old renderer's `destroy()` + `remove()`. Our foliate-view
   * listeners live on the persistent host (see `#wireView`), so they keep working
   * with the new renderer — no re-wiring needed.
   */
  async #reopen(file: File): Promise<void> {
    const at = this.lastCFI
    if (this.#nudgeTimer) clearTimeout(this.#nudgeTimer)
    if (this.#redrawTimer) clearTimeout(this.#redrawTimer)
    this.#redrawTimer = undefined
    this.#redrawGen++
    this.#pendingDir = null
    // The old renderer's documents are about to go; drop their listeners and timers now
    // rather than waiting for the next section load to notice they're dead.
    this.#abortDocListeners()
    // foliate's close() destroys the renderer but not the Book, whose Loader holds an
    // object URL per resolved resource (images, rewritten CSS). Destroy the old Book so
    // those blob URLs are revoked instead of leaking on every writing-mode toggle.
    this.#closeBook()
    await this.view.open(file)
    if (this.#destroyed) return this.#closeBook()
    this.bookDir = this.view.book?.dir === 'rtl' ? 'rtl' : 'ltr'
    this.#vertical = this.#expectVertical()
    // The fresh paginator starts with foliate's default geometry attributes, so the
    // idempotency cache from the old renderer no longer reflects reality — clear it
    // so applyLayout actually re-applies our attributes to the new renderer.
    this.#lastLayout = undefined
    this.applyAppearance(this.#settings)
    this.applyLayout(this.#settings)
    await this.view.init({ lastLocation: at || undefined, showTextStart: true })
    if (this.#destroyed) return
    this.#nudgeLayout()
  }

  /** Close the renderer and destroy the Book (revoking its resource blob URLs). */
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
   * Page turns are driven by horizontal **swipe** gestures (see `#attachTaps`) and
   * animate as a horizontal **slide** (like Books on iPad) rather than foliate's
   * native motion. Foliate stacks 縦書き pages on the vertical axis, so its own
   * animated turn slides up/down; we instead jump instantly (its `animated`
   * attribute is left off, and its own touch turn is patched out — see the paginator
   * notes in docs/reader-engine.md) and slide the whole view left/right over the
   * paper. The new page enters from the side the reader moved toward; the old page
   * leaves the opposite edge, so it reads as one continuous horizontal push.
   *
   * `goLeft`/`goRight` are foliate's direction-aware navigation (they honour the
   * book's page-progression direction), so a swipe turns the correct way in LTR,
   * RTL, and vertical (縦書き) books while always animating horizontally.
   *
   * (A literal page-curl isn't possible — the content is in a sandboxed, closed
   * shadow-DOM iframe that can't be rasterised — and only one page is rendered at a
   * time, so the vacated strip shows the paper background, which is the intent.)
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
      this.#pendingDir = dir // coalesce rapid taps: remember only the latest
      return
    }
    this.#turning = true
    try {
      // At the first/last page there is nothing to slide to: sliding the page out and the
      // same page back in read as a glitch. A short nudge says "that's the end" instead.
      if (this.#atEdge(dir)) await this.#bounce(dir)
      else await this.#slide(dir)
    } finally {
      this.#turning = false
      const next = this.#pendingDir
      this.#pendingDir = null
      if (next && !this.#destroyed) void this.#turn(next)
    }
  }

  /** Whether turning `dir` has nowhere to go (foliate: `goLeft` is `next` in an rtl book). */
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
    const exit = dir === 'left' ? '100%' : '-100%' // old page slides off this edge
    const enter = dir === 'left' ? '-100%' : '100%' // new page enters from this edge
    // Phase 1: slide the current page out (transitionend-driven so the phases stay
    // tight even under load — a drifting timer here would show a blank-paper gap).
    await this.#transition(TURN_PHASE_MS, 'cubic-bezier(.4, 0, 1, 1)', `translateX(${exit})`)
    if (this.#destroyed) return
    // Jump to the target page while off-screen (instant — `animated` is off).
    el.style.transition = 'none'
    try {
      await (dir === 'left' ? this.view.goLeft() : this.view.goRight())
    } catch {
      /* view may be tearing down */
    }
    if (this.#destroyed) return
    el.style.transform = `translateX(${enter})`
    // Phase 2: slide the new page in (`#transition` flushes the off-screen position first).
    await this.#transition(TURN_PHASE_MS, 'cubic-bezier(0, 0, .2, 1)', 'translateX(0)')
    el.style.transition = ''
    el.style.transform = ''
  }

  async #bounce(dir: 'left' | 'right'): Promise<void> {
    const el = this.view
    const px = dir === 'left' ? BOUNCE_PX : -BOUNCE_PX // follow the finger a little, then return
    await this.#transition(BOUNCE_MS, 'cubic-bezier(.3, 0, .5, 1)', `translateX(${px}px)`)
    if (this.#destroyed) return
    await this.#transition(BOUNCE_MS * 1.4, 'cubic-bezier(.2, 0, .2, 1)', 'translateX(0)')
    el.style.transition = ''
    el.style.transform = ''
  }

  /** Apply a transform transition and resolve when it ends (with a safety timeout). */
  #transition(ms: number, easing: string, transform: string): Promise<void> {
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
        if (e.propertyName === 'transform') finish()
      }
      // Register on the controller's abort signal so destroy() mid-turn removes the
      // listener (and the closure's reference to the view) deterministically.
      el.addEventListener('transitionend', onEnd, { signal: this.#ac.signal })
      el.style.transition = `transform ${ms}ms ${easing}`
      // Force a style flush so the transition (and, for phase 2, the off-screen start
      // position) is committed before the new transform — it then animates from here. The
      // old code waited a whole requestAnimationFrame per phase for the same effect: up to
      // ~16ms of dead time twice per turn.
      void el.offsetWidth
      el.style.transform = transform
      // Fallback if transitionend doesn't fire. Tracked on the instance so a destroy()
      // mid-turn clears it (the abort removes the transitionend listener but can't cancel
      // a bare setTimeout), rather than firing after teardown holding `el`.
      this.#slideTimer = window.setTimeout(finish, ms + 120)
    })
  }
  /** Safety-timeout handle for the in-flight page-turn slide (cleared on destroy). */
  #slideTimer: number | undefined

  goTo(target: string | number) {
    return this.view.goTo(target)
  }

  /** Seek to an overall-book fraction (0..1) — backs the progress scrubber. */
  goToFraction(frac: number) {
    return this.view.goToFraction(Math.max(0, Math.min(1, frac)))
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

  /** Resolve (and cache) the spine index a highlight CFI lives in. */
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

  /** Adds (and immediately paints) a yellow highlight. */
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

  /**
   * Seed the highlight set (the book's stored highlights). Call it **before** `open()`:
   * there is nothing to draw yet, and the opening section's `create-overlay` (fired during
   * `view.init`) then paints exactly that section's share on the normal per-section path.
   * Every other section draws on its own `create-overlay`. Called after open, it draws
   * only the currently loaded section(s) — never a sweep of the whole book, which parsed
   * and no-op'd an `addAnnotation` for every highlight on the book-open critical path.
   */
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
   * Ask foliate to (re)draw highlights; no-ops for unloaded sections. When a section
   * `index` is given (the `create-overlay` path) only that section's highlights are
   * redrawn — so a page-turn into a new section costs O(highlights-in-that-section),
   * not O(all-highlights-in-the-book). With no index it redraws the loaded section(s).
   */
  reapplyHighlights(index?: number): void {
    this.#drawSections(index === undefined ? this.#loadedIndices() : new Set([index]))
  }

  /**
   * Because tap-to-define highlights **every** looked-up word, a section's set grows
   * without bound over a book, and each draw is real work (parse the CFI, re-anchor it to
   * a Range over the live document, measure its client rects, build an SVG node). Painting
   * them in one loop froze the main thread on every section change once a reader had a few
   * hundred words. So: order them nearest-first around the current position (`nearestFirst`
   * — parse once, sort in document order, binary-search, walk outward) and paint in small
   * chunks, yielding between them. The page the reader is actually looking at fills in on
   * the first chunk; the rest of the section trickles in without ever blocking a swipe.
   * A generation counter makes a newer sweep abandon the one in flight.
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
  /** Invalidates an in-flight chunked highlight sweep. */
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
    this.#reopenGen++ // a queued writing-mode re-open must not start
    window.removeEventListener('resize', this.#onResize)
    globalThis.visualViewport?.removeEventListener('resize', this.#onResize)
    if (this.#resizeTimer) clearTimeout(this.#resizeTimer)
    if (this.#nudgeTimer) clearTimeout(this.#nudgeTimer)
    if (this.#slideTimer) clearTimeout(this.#slideTimer)
    if (this.#redrawTimer) clearTimeout(this.#redrawTimer)
    this.#redrawGen++
    this.#pendingDir = null
    this.#abortDocListeners()
    this.#ac.abort() // removes every host gesture + foliate-view listener at once
    // Revoke the EPUB's resource blob URLs (close() tears down the renderer but not
    // the Book, whose Loader cache holds them until destroy()). An open() still in
    // flight re-checks #destroyed and closes whatever it went on to create.
    this.#closeBook()
    this.view.remove()
  }

  /**
   * Shared pointer → gesture state machine, attached to either a content document
   * (the text column) or the host element (the surrounding margins). A horizontal
   * drag of `SWIPE_MIN_DISTANCE` turns the page; a clean, quick tap calls `onTap`.
   * Listeners are registered with `signal` — the controller-wide `#ac` for the host, or a
   * per-document controller for content documents (see `#attachTaps`) — so teardown is a
   * single abort either way.
   *
   * **Touch swipes turn on the move, not the lift.** As soon as a quick touch drag crosses
   * `SWIPE_MIN_DISTANCE` (horizontal-dominant, within `SWIPE_DECIDE_MS` of the press, one
   * finger, no live text selection, not pinch-zoomed) the turn fires and the gesture is
   * consumed, so its `pointerup` is ignored — the page starts moving while the finger is
   * still travelling, like Books. Everything else keeps the `pointerup` decision: mouse
   * and pen (a mouse drag across text is a drag-*select*), a press that lingered (an iOS
   * long-press that is becoming a selection), or a drag with a selection live (its handles).
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
    /** A second contact joined this gesture (pinch, palm): never decide a swipe early. */
    let multi = false

    const swipe = (dx: number) => {
      // "Page follows the finger": dragging left reveals the page on the right (goRight);
      // dragging right reveals the page on the left (goLeft). Both are direction-aware.
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
        // Only the primary pointer's travel can disqualify the tap. Without this a
        // second contact anywhere on the glass (a thumb resting on the bezel, a palm
        // graze) is measured against the *first* finger's down point, so its distant
        // coordinates instantly mark the gesture as "moved" and the tap is dropped.
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
          active = false // consumed: the lift is neither a tap nor a second turn
          swipe(dx)
        }
      },
      { passive: true, signal },
    )
    // A cancelled pointer (scroll handoff, palm rejection, gesture recognizer) is
    // never a tap — make sure a stray follow-up pointerup can't fire one.
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
        // Test `isPrimary` *before* consuming `active`: a non-primary pointerup (the
        // second finger lifting) must leave the in-flight primary gesture intact,
        // otherwise the real finger's own pointerup is discarded by `!active`.
        if (!e.isPrimary) return
        if (!active) return
        active = false
        // The end of a text selection is neither a tap nor a swipe — leave it for
        // the selection toolbar.
        if (opts.shouldIgnoreUp?.(e)) return

        // While the page is pinch-zoomed (a second finger was/is down) the pointer
        // coordinates are unreliable and a stray primary pointerup shouldn't turn the
        // page or define. The paginator already blocks its own turn on pinch; mirror
        // that here via the visual-viewport scale so an iPad pinch can't trigger a
        // spurious page turn.
        if (zoomed()) return

        const dx = e.clientX - downX
        const dy = e.clientY - downY

        // Horizontal swipe → turn the page. goLeft/goRight are direction-aware, so
        // the swipe reads correctly in LTR, RTL, and vertical (縦書き) books, and the
        // turn always animates as a horizontal slide.
        if (Math.abs(dx) >= SWIPE_MIN_DISTANCE && Math.abs(dx) > Math.abs(dy)) {
          swipe(dx)
          return
        }

        // Otherwise, only a clean, quick tap (negligible movement) counts. Swipes are
        // the sole pagination input.
        if (moved || e.timeStamp - downT > TAP_MAX_MS) return
        opts.onTap(e)
      },
      { passive: true, signal },
    )
  }

  /**
   * The content iframe only covers the text column, so swipes and taps in the
   * surrounding margins never reach the per-document listeners — those areas would be
   * dead. Attach the same gesture detection to the host element (the margins bubble
   * out of foliate's shadow DOM to it; events inside the iframe don't, so there's no
   * double-handling) so the whole reading surface responds. Taps here carry no content
   * document, so they route straight to the chrome toggle.
   */
  #attachHostGestures() {
    this.#trackGestures(this.view, {
      onTap: (e) => this.#cb.onTap?.({ doc: null, ix: 0, iy: 0, px: e.clientX, py: e.clientY }),
    })
  }

  /** Attach our own tap + swipe detector to a freshly loaded content document. */
  #attachTaps(doc: Document) {
    // The paginator swaps in a fresh document per section. Registering every one of those
    // documents' listeners on the book-long `#ac` kept each *detached* document reachable
    // (an addEventListener signal registers an abort algorithm that holds the target), so
    // a long session pinned every section's DOM it had ever visited. Give each document its
    // own controller and abort it once its browsing context is gone (`defaultView` null).
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
        // A live selection means this pointer sequence probably *ended* a drag-select, which
        // is the selection toolbar's business, not a tap. But a plain tap outside the
        // selection is how a reader dismisses it — and WebKit only collapses the selection
        // *after* our pointerup, so bailing on "a selection exists" swallows that tap (and
        // the next word lookup with it). So only bail when the press landed inside the
        // selection's own rects; otherwise clear it and let the tap through.
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
        // Never decide a swipe mid-move while a selection is live: the finger may be
        // dragging one of its handles.
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

    // Key events inside the iframe never reach the top window; forward them so page-turn
    // and Escape shortcuts work wherever focus is.
    doc.addEventListener('keydown', (e) => this.#cb.onKey?.(e), { signal })

    // Surface finished text selections for the highlight / translate toolbar.
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
