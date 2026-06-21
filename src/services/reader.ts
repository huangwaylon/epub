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

/** A table-of-contents entry as exposed by foliate's `book.toc`. */
export interface TocItem {
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
  getCFI(index: number, range: Range): string
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
}

const TAP_MOVE_TOLERANCE = 16
const TAP_MAX_MS = 400
/** Minimum horizontal travel (px) for a drag to count as a page-turn swipe. */
const SWIPE_MIN_DISTANCE = 45
/** One phase (out / in) of the horizontal page-turn slide. */
const TURN_PHASE_MS = 150

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
  const scheme = s.theme === 'dark' ? 'dark' : 'light'

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
  /** Aborts every per-document listener we attach, in one shot, on destroy. */
  #ac = new AbortController()
  /** Guards the page-turn slide so re-entrant taps don't overlap animations. */
  #turning = false
  #pendingDir: 'left' | 'right' | null = null

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
    this.#attachHostGestures()
    window.addEventListener('resize', this.#onResize)
    await this.view.init({ lastLocation: lastCFI || undefined, showTextStart: true })
    this.#nudgeLayout()
  }

  /**
   * `applyLayout` derives the vertical page box from the viewport, so the column
   * fills on the first paint (verified in desktop Chrome at iPad-landscape). The old
   * foliate under-measure quirk (docs §11) is unverified on real iOS, so we keep one
   * cheap re-render after fonts/layout settle as a hedge; the resize listener is the
   * reliable backstop if a real device still under-measures.
   */
  #nudgeLayout(): void {
    setTimeout(() => {
      try {
        this.view.renderer?.render?.()
      } catch {
        /* ignore */
      }
    }, 250)
  }

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
    const vw = window.innerWidth
    const vh = window.innerHeight
    const minDim = Math.min(vw, vh)
    const margin = Math.round(Math.max(28, Math.min(80, minDim * 0.075)) * s.marginScale)
    // A two-page spread only applies in landscape on wide screens — this mirrors
    // foliate's orientation container-query, which collapses the spread in portrait.
    const cols = vw > vh && vw >= 820 ? 2 : 1

    r.setAttribute('margin', `${margin}px`)
    r.setAttribute('gap', '6%')
    r.setAttribute('max-column-count', `${cols}`)
    if (this.#vertical) {
      // Vertical 縦書き: `max-block-size` is the across-page *width*; `max-inline-size`
      // is the column *height*. Fill the available width (only the margin frames it)
      // and the full height minus the margin band, so the reading surface uses the
      // whole screen rather than floating in dead space. Foliate clamps the height to
      // what's available and, in landscape, its spread is 1, so we set the height
      // directly (the old hard-coded 1100 happened to clamp the same, but a too-large
      // value relative to the spread is what let the box settle mis-sized; deriving it
      // is deterministic).
      const colHeight = Math.max(320, vh - margin * 2)
      const bandWidth = vw - margin * 2
      r.setAttribute('max-block-size', `${Math.round(bandWidth)}px`)
      r.setAttribute('max-inline-size', `${Math.round(colHeight)}px`)
    } else {
      r.setAttribute('max-block-size', '880px')
      // Set last: changing max-inline-size forces foliate to re-render, so the other
      // attributes above are already in place when it does.
      r.setAttribute('max-inline-size', '640px')
    }
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

  async #turn(dir: 'left' | 'right'): Promise<void> {
    if (this.#turning) {
      this.#pendingDir = dir // coalesce rapid taps: remember only the latest
      return
    }
    this.#turning = true
    try {
      await this.#slide(dir)
    } finally {
      this.#turning = false
      const next = this.#pendingDir
      this.#pendingDir = null
      if (next) void this.#turn(next)
    }
  }

  async #slide(dir: 'left' | 'right'): Promise<void> {
    const el = this.view
    const exit = dir === 'left' ? '100%' : '-100%' // old page slides off this edge
    const enter = dir === 'left' ? '-100%' : '100%' // new page enters from this edge
    el.style.boxShadow = '0 0 28px rgba(0, 0, 0, 0.18)' // depth cue while the page moves
    // Phase 1: slide the current page out (transitionend-driven so the phases stay
    // tight even under load — a drifting timer here would show a blank-paper gap).
    await this.#transition(`transform ${TURN_PHASE_MS}ms cubic-bezier(.4, 0, 1, 1)`, `translateX(${exit})`)
    // Jump to the target page while off-screen (instant — `animated` is off).
    el.style.transition = 'none'
    try {
      await (dir === 'left' ? this.view.goLeft() : this.view.goRight())
    } catch {
      /* view may be tearing down */
    }
    el.style.transform = `translateX(${enter})`
    void el.offsetWidth // flush the off-screen position before transitioning back
    // Phase 2: slide the new page in.
    await this.#transition(`transform ${TURN_PHASE_MS}ms cubic-bezier(0, 0, .2, 1)`, 'translateX(0)')
    el.style.transition = ''
    el.style.transform = ''
    el.style.boxShadow = ''
  }

  /** Apply a transform transition and resolve when it ends (with a safety timeout). */
  #transition(transition: string, transform: string): Promise<void> {
    const el = this.view
    return new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        el.removeEventListener('transitionend', onEnd)
        resolve()
      }
      const onEnd = (e: TransitionEvent) => {
        if (e.propertyName === 'transform') finish()
      }
      el.addEventListener('transitionend', onEnd)
      el.style.transition = transition
      requestAnimationFrame(() => {
        el.style.transform = transform
      })
      setTimeout(finish, TURN_PHASE_MS + 120) // fallback if transitionend doesn't fire
    })
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
      this.view.deselect()
    } catch {
      /* ignore */
    }
  }

  destroy() {
    window.removeEventListener('resize', this.#onResize)
    if (this.#resizeTimer) clearTimeout(this.#resizeTimer)
    this.#pendingDir = null
    this.#ac.abort() // removes every per-document tap/selection listener at once
    try {
      this.view.close()
    } catch {
      /* ignore */
    }
    this.view.remove()
  }

  /**
   * Shared pointer → gesture state machine, attached to either a content document
   * (the text column) or the host element (the surrounding margins). A horizontal
   * drag of `SWIPE_MIN_DISTANCE` turns the page; a clean, quick tap calls `onTap`.
   * Every listener is registered with the controller's `#ac` signal so `destroy()`'s
   * single abort removes them all.
   */
  #trackGestures(
    target: Document | HTMLElement,
    opts: { shouldIgnoreUp?: () => boolean; onTap: (e: PointerEvent) => void },
  ) {
    const signal = this.#ac.signal
    let downX = 0
    let downY = 0
    let downT = 0
    let moved = false
    let active = false

    target.addEventListener(
      'pointerdown',
      (ev: Event) => {
        const e = ev as PointerEvent
        if (!e.isPrimary) return
        active = true
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
        if (active && Math.hypot(e.clientX - downX, e.clientY - downY) > TAP_MOVE_TOLERANCE) moved = true
      },
      { passive: true, signal },
    )
    // A cancelled pointer (scroll handoff, palm rejection, gesture recognizer) is
    // never a tap — make sure a stray follow-up pointerup can't fire one.
    target.addEventListener(
      'pointercancel',
      () => {
        active = false
        moved = true
      },
      { passive: true, signal },
    )
    target.addEventListener(
      'pointerup',
      (ev: Event) => {
        const e = ev as PointerEvent
        if (!active) return
        active = false
        if (!e.isPrimary) return
        // The end of a text selection is neither a tap nor a swipe — leave it for
        // the selection toolbar.
        if (opts.shouldIgnoreUp?.()) return

        const dx = e.clientX - downX
        const dy = e.clientY - downY

        // Horizontal swipe → turn the page. goLeft/goRight are direction-aware, so
        // the swipe reads correctly in LTR, RTL, and vertical (縦書き) books, and the
        // turn always animates as a horizontal slide. "Page follows the finger":
        // dragging left reveals the page on the right (goRight); dragging right
        // reveals the page on the left (goLeft).
        if (Math.abs(dx) >= SWIPE_MIN_DISTANCE && Math.abs(dx) > Math.abs(dy)) {
          if (dx < 0) void this.goRight()
          else void this.goLeft()
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
    this.#trackGestures(doc, {
      shouldIgnoreUp: () => {
        const sel = doc.getSelection()
        return !!(sel && sel.type === 'Range' && sel.toString().length > 0)
      },
      onTap: (e) => {
        const frame = doc.defaultView?.frameElement as HTMLElement | null
        const rect = frame?.getBoundingClientRect()
        const px = (rect?.left ?? 0) + e.clientX
        const py = (rect?.top ?? 0) + e.clientY
        this.#cb.onTap?.({ doc, ix: e.clientX, iy: e.clientY, px, py })
      },
    })

    // Surface finished text selections for the highlight / translate toolbar.
    const signal = this.#ac.signal
    let selTimer: number | undefined
    doc.addEventListener(
      'selectionchange',
      () => {
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
      },
      { signal },
    )
  }
}
