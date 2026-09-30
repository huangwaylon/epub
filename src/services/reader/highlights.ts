/**
 * Highlight painting: the render truth (`#highlights`, CFIs) and the section sweeps that
 * paint it through foliate's overlayer. Records live in the `annotations` store; this only
 * decides what is drawn, and when.
 */
// @ts-ignore — vendored JS module, no type declarations
import { Overlayer } from '../../vendor/foliate-js/overlayer.js'
import { HIGHLIGHT_HEX } from '../types'
import { nearestFirst } from '../cfi'
import { rectsOutsideEnglish } from '../translation'
import type { Timers } from './timers'
import type { FoliateView } from './types'

/** Highlights drawn per task in a section sweep. */
const HIGHLIGHT_DRAW_CHUNK = 24
/** `Timers` key of the sweep's next chunk. */
const REDRAW = 'redraw'

/** The `draw-annotation` handler: the only place a highlight is painted. Re-run on every
 *  overlay redraw, so English shown / hidden since is honoured. */
export function drawHighlight(detail: { draw: (func: unknown, opts: object) => void; range: Range }): void {
  const { draw, range } = detail
  draw((rects: DOMRectList, opts: object) => Overlayer.highlight(rectsOutsideEnglish(range, rects), opts), {
    color: HIGHLIGHT_HEX,
  })
}

export class HighlightPainter {
  #view: FoliateView
  #timers: Timers
  #lastCFI: () => string
  /** Highlighted CFIs: the render truth for overlays. */
  #highlights = new Set<string>()
  /** Highlight CFI → spine index, so a section draw only touches its own highlights. */
  #index = new Map<string, number>()
  /** A newer sweep (or `cancel`) abandons the one in flight. */
  #gen = 0

  /** `lastCFI`: the reading position, for nearest-first ordering. */
  constructor(view: FoliateView, timers: Timers, lastCFI: () => string) {
    this.#view = view
    this.#timers = timers
    this.#lastCFI = lastCFI
  }

  async add(cfi: string): Promise<void> {
    this.#highlights.add(cfi)
    this.#indexFor(cfi)
    await this.#view.addAnnotation({ value: cfi })
  }

  async remove(cfi: string): Promise<void> {
    this.#highlights.delete(cfi)
    this.#index.delete(cfi)
    await this.#view.deleteAnnotation({ value: cfi })
  }

  /** Replace the set. Call before `open()`: each section then draws its own share on
   *  `create-overlay`. After open it redraws only the loaded section(s). */
  set(cfis: Iterable<string>): void {
    this.#highlights = new Set(cfis)
    this.#index.clear()
    const loaded = this.loadedIndices()
    if (loaded.size) this.drawSections(loaded)
  }

  /** Abandon the sweep in flight. */
  cancel(): void {
    this.#gen++
    this.#timers.clear(REDRAW)
  }

  loadedIndices(): Set<number> {
    const out = new Set<number>()
    try {
      for (const c of this.#view.renderer?.getContents?.() ?? []) if (typeof c.index === 'number') out.add(c.index)
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
  drawSections(indices: Set<number>): void {
    this.cancel()
    const gen = this.#gen
    if (!indices.size) return
    let cfis: string[] = []
    for (const cfi of this.#highlights) {
      const i = this.#indexFor(cfi)
      if (i !== undefined && indices.has(i)) cfis.push(cfi)
    }
    if (!cfis.length) return
    const at = this.#lastCFI()
    if (at && cfis.length > HIGHLIGHT_DRAW_CHUNK) cfis = nearestFirst(cfis, at)
    const drawChunk = (from: number) => {
      if (gen !== this.#gen) return
      const to = Math.min(from + HIGHLIGHT_DRAW_CHUNK, cfis.length)
      for (let i = from; i < to; i++) void this.#view.addAnnotation({ value: cfis[i] }).catch(() => {})
      if (to < cfis.length) this.#timers.set(REDRAW, () => drawChunk(to), 0)
    }
    drawChunk(0)
  }

  #indexFor(cfi: string): number | undefined {
    let idx = this.#index.get(cfi)
    if (idx === undefined) {
      try {
        idx = this.#view.resolveCFI(cfi)?.index
      } catch {
        idx = undefined
      }
      if (idx !== undefined) this.#index.set(cfi, idx)
    }
    return idx
  }
}
