/** Types shared by the reader modules; the public ones are re-exported from `./index`. */
import type { TextPoint } from '../translation'

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
  /** The book carries English (`.tsuzuri-en`); fired once per book. */
  onEnglish?: () => void
}

/** A horizontal page turn: `goLeft` / `goRight` (reading order depends on `book.dir`). */
export type TurnDir = 'left' | 'right'

/** One character in a content document. */
export type CharAt = TextPoint

/** Minimal surface of foliate's <foliate-view> element that we use. */
export interface FoliateView extends HTMLElement {
  book: any
  renderer: any
  /** The last `relocate` detail (foliate's own). */
  lastLocation?: { range?: Range }
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
