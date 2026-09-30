/**
 * Pointer input on the reading surface: the swipe / tap state machine (`trackGestures`),
 * attached to the `<foliate-view>` host for margins and, via `DocumentInput`, to each
 * content document with key forwarding and selection reporting. Taps are the hot path:
 * never add latency or a guard that can swallow one.
 */
import type { Timers } from './timers'
import type { SelectionInfo, TapInfo, TurnDir } from './types'

const TAP_MOVE_TOLERANCE = 16
/** Generous: an aimed press at a 16px glyph (or a careful retry) is slow; a long-press
 *  becomes a WebKit selection, which `shouldIgnoreUp` catches. */
const TAP_MAX_MS = 700
const SWIPE_MIN_DISTANCE = 45
/** A touch swipe is decided on move only this soon after the press; a lingering press
 *  may be an iOS long-press turning into a selection, so it waits for the lift. */
const SWIPE_DECIDE_MS = 500
/** `selectionchange` settles for this long before it is reported. */
const SELECTION_DEBOUNCE_MS = 250

export interface GestureOptions {
  shouldIgnoreUp?: (e: PointerEvent) => boolean
  /** False while a swipe must not be decided early (e.g. a text selection is live). */
  canSwipeEarly?: () => boolean
  onTap: (e: PointerEvent) => void
  /** The page follows the finger: drag left → the page on the right. */
  onSwipe: (dir: TurnDir) => void
}

/**
 * Pointer → swipe/tap state machine for a content document or the host (margins).
 * A quick one-finger touch swipe turns on the move and its lift is ignored; mouse/pen
 * (drag-select), a lingering press or a live selection wait for `pointerup`.
 */
export function trackGestures(target: Document | HTMLElement, opts: GestureOptions, signal: AbortSignal): void {
  let downX = 0
  let downY = 0
  let downT = 0
  let moved = false
  let active = false
  /** A second contact joined: never decide a swipe early. */
  let multi = false

  const swipe = (dx: number) => opts.onSwipe(dx < 0 ? 'right' : 'left')
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

export interface DocumentInputCallbacks {
  onTap: (info: TapInfo) => void
  onSwipe: (dir: TurnDir) => void
  onKey: (e: KeyboardEvent) => void
  onSelection: (info: SelectionInfo) => void
  onSelectionCleared: () => void
}

/**
 * Gestures, key forwarding and selection reporting for each loaded content document. One
 * AbortController per document: an abort signal pins its target, so a swapped-out
 * section's listeners must not live on a book-long signal. The selection debounce is
 * keyed by the document in the shared `Timers`.
 */
export class DocumentInput {
  #acs = new Map<Document, AbortController>()
  #timers: Timers
  #cb: DocumentInputCallbacks

  constructor(timers: Timers, callbacks: DocumentInputCallbacks) {
    this.#timers = timers
    this.#cb = callbacks
  }

  /** Abort every document's listeners and pending selection report. */
  abortAll(): void {
    for (const [doc, ac] of this.#acs) {
      this.#timers.clear(doc)
      ac.abort()
    }
    this.#acs.clear()
  }

  /** Attach to a freshly loaded document. */
  attach(doc: Document): void {
    // Drop controllers of this doc and of documents whose browsing context is gone.
    for (const [d, ac] of this.#acs) {
      if (d === doc || !d.defaultView) {
        ac.abort()
        this.#acs.delete(d)
        this.#timers.clear(d)
      }
    }
    const docAC = new AbortController()
    this.#acs.set(doc, docAC)
    const signal = docAC.signal
    const cb = this.#cb

    trackGestures(
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
          cb.onTap({ doc, ix: e.clientX, iy: e.clientY, px, py })
        },
        onSwipe: cb.onSwipe,
      },
      signal,
    )

    // Iframe key events never reach the top window.
    doc.addEventListener('keydown', (e) => cb.onKey(e), { signal })

    doc.addEventListener(
      'selectionchange',
      () => {
        this.#timers.set(doc, () => {
          const sel = doc.getSelection()
          if (sel && sel.type === 'Range' && sel.toString().trim().length > 0) {
            const range = sel.getRangeAt(0)
            const r = range.getBoundingClientRect()
            const frame = doc.defaultView?.frameElement as HTMLElement | null
            const fr = frame?.getBoundingClientRect()
            cb.onSelection({
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
            cb.onSelectionCleared()
          }
        }, SELECTION_DEBOUNCE_MS)
      },
      { signal },
    )
  }
}
