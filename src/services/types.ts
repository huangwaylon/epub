/**
 * Core data model shared across the app. These shapes are persisted:
 * book files live in OPFS, everything here lives in IndexedDB (see services/storage/db.ts).
 */

/** Writing-mode override the reader can apply on top of what the EPUB declares. */
export type WritingModePref = 'auto' | 'horizontal' | 'vertical'

export type ThemeName = 'light' | 'sepia' | 'dark'

/** Metadata for a book on the shelf. The actual .epub bytes live in OPFS under its id. */
export interface BookMeta {
  id: string // sha-256 of the file bytes
  title: string
  author: string
  language: string // BCP-47 tag from the EPUB, e.g. "ja"
  /** Page-progression direction declared by the EPUB ('rtl' for most vertical JP novels). */
  dir: 'ltr' | 'rtl'
  cover?: Blob
  fileName: string
  fileSize: number
  addedAt: number
  lastOpenedAt: number
}

/** Where the reader was last left off, per book. */
export interface ReadingProgress {
  bookId: string
  cfi: string // EPUB CFI from foliate's `relocate` event
  fraction: number // 0..1 overall progress, for the shelf ring
  label?: string // current TOC section label
  updatedAt: number
}

export type AnnotationKind = 'highlight' | 'bookmark'

/**
 * Highlights are a single colour — a yellow that reads well behind text at the
 * overlay's ~0.3 opacity. (The reader used to offer a colour picker; it was
 * dropped in favour of one consistent yellow that doubles as a vocab marker for
 * words you've looked up.)
 */
export const HIGHLIGHT_HEX = '#ffd54a'

/** A highlight or bookmark, anchored by CFI so it survives reflow / font changes. */
export interface Annotation {
  id: string
  bookId: string
  kind: AnnotationKind
  cfi: string
  /** Selected text (highlights) or a short context snippet (bookmarks). */
  text: string
  note?: string
  /** TOC label of the containing section, for grouping in the panel. */
  sectionLabel?: string
  createdAt: number
}

/** Per-reader appearance preferences (global, not per-book). */
export interface ReaderSettings {
  theme: ThemeName
  fontScale: number // 1 = 100%
  lineHeight: number
  marginScale: number // multiplies the base page margin
  fontFamily: 'serif' | 'sans'
  writingMode: WritingModePref
  /** Tap behaviour: a tap on a Japanese word looks it up (vs. only toggling chrome). */
  tapToDefine: boolean
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  theme: 'light',
  fontScale: 1,
  lineHeight: 1.9,
  marginScale: 1,
  fontFamily: 'serif',
  writingMode: 'auto',
  tapToDefine: true,
}
