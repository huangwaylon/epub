/**
 * Shared, dependency-free result types for the dictionary lookup. Kept in their own
 * module so the main thread (DictionaryPopup, Reader, the worker client) can import
 * the types with `import type` without pulling in the heavy lookup engine — kuromoji,
 * jpdict-idb, normal-jp, the deinflection table — which lives only in the worker bundle.
 */

/** One dictionary sense: its parts of speech and English glosses. */
export interface Sense {
  pos: string[]
  glosses: string[]
}

export interface DictEntry {
  /** Primary written form (kanji if present, else kana). */
  headword: string
  /** Kana reading. */
  reading: string
  /** Pitch-accent position (mora index), if known. */
  pitch?: number
  /** True when the headword is itself just kana (so reading is redundant). */
  kanaOnly: boolean
  senses: Sense[]
}

export interface LookupResult {
  /**
   * Offset of the match within the text passed to `lookupAt` (0 for `lookup`,
   * which is forward-only from the window start). With `matchLength` this gives
   * the matched word's span `[matchStart, matchStart + matchLength)`, which the
   * caller uses to build a DOM range for the tapped word (e.g. to highlight it).
   */
  matchStart: number
  /** Number of characters from `matchStart` that were matched. */
  matchLength: number
  /** Human-readable deinflection reasons, outermost first. */
  reasons: string[]
  entries: DictEntry[]
}
