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
  /** Usage notes for this sense (JMdict `misc`), labelled — e.g. "usually kana",
   *  "colloquial", "honorific". Absent when there are none. */
  misc?: string[]
  /** Whether this sense applies to the matched spelling/reading (JMdict restricts some
   *  senses to particular kanji or kana forms). Matched senses are listed first; an
   *  unmatched one belongs to another spelling of the same entry. Absent ⇒ unknown
   *  (treat as matched). */
  matched?: boolean
}

export interface DictEntry {
  /** JMdict entry id — stable and unique, so a good `{#each}` key. */
  id?: number
  /** The written form that matched the tapped text: the matched kanji spelling, or the
   *  kana when the text was kana and the word is usually written in kana (or has no
   *  kanji at all). Falls back to the entry's first form. */
  headword: string
  /** Kana reading — the matched reading when the text was kana, else the first reading
   *  that applies to `headword`. */
  reading: string
  /** Pitch-accent position (mora index) of `reading`, if known. */
  pitch?: number
  /** True when `headword` is itself kana (so showing `reading` too is redundant). */
  kanaOnly: boolean
  senses: Sense[]
  /** Deinflection reasons that turned the tapped surface into this entry's dictionary
   *  form, outermost first (e.g. ["past"] for した → する). Empty for a surface match.
   *  Entries in one result can differ here, so render these per entry. */
  reasons?: string[]
}

export interface LookupResult {
  /**
   * Offset of the match within the text passed to `lookupAt`. With `matchLength` this
   * gives the matched word's span `[matchStart, matchStart + matchLength)`, which the
   * caller uses to build a DOM range for the tapped word (e.g. to highlight it).
   */
  matchStart: number
  /** Number of characters from `matchStart` that were matched. */
  matchLength: number
  /** Deinflection reasons of the **first** entry (= `entries[0].reasons`), kept for
   *  callers that render one reason row per result. Prefer `DictEntry.reasons`. */
  reasons: string[]
  entries: DictEntry[]
}
