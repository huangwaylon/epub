/** Persisted data model (IndexedDB, see storage/db.ts; EPUB bytes live in OPFS). */

/** Writing-mode override the reader can apply on top of what the EPUB declares. */
export type WritingModePref = 'auto' | 'horizontal' | 'vertical'

/** A concrete palette: what `<html data-theme>` is actually set to (see app.css). */
export type ResolvedTheme = 'light' | 'sepia' | 'dark'

/** The theme *preference*. 'auto' follows the OS (`prefers-color-scheme`): light ↔ dark. */
export type ThemeName = 'auto' | ResolvedTheme

/** A shelf entry. */
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

/** The single highlight colour; reads well behind text at the overlay's ~0.3 opacity. */
export const HIGHLIGHT_HEX = '#ffd54a'

/** A highlight or bookmark, anchored by CFI so it survives reflow / font changes. */
export interface Annotation {
  id: string
  bookId: string
  kind: 'highlight' | 'bookmark'
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
  /** Tap-to-define also highlights the looked-up word (a vocab record). */
  highlightLookups: boolean
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  theme: 'auto',
  fontScale: 1,
  lineHeight: 1.9,
  marginScale: 1,
  fontFamily: 'serif',
  writingMode: 'auto',
  highlightLookups: true,
}
