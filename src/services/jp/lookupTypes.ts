/** Dependency-free lookup result types, so the main thread can `import type` them
 *  without pulling in the worker-only engine. */

export interface Sense {
  pos: string[]
  glosses: string[]
  /** Labelled JMdict `misc` notes ("usually kana", "colloquial", …). */
  misc?: string[]
  /** Whether this sense applies to the matched spelling/reading; absent ⇒ treat as matched. */
  matched?: boolean
}

export interface DictEntry {
  /** JMdict entry id (unique — a good `{#each}` key). */
  id?: number
  /** The matched written form (kanji spelling, or kana for usually-kana / kana-only words). */
  headword: string
  /** The matched reading, else the first reading that applies to `headword`. */
  reading: string
  /** Pitch-accent downstep (mora index) of `reading`. */
  pitch?: number
  /** `headword` is kana, so `reading` is redundant. */
  kanaOnly: boolean
  senses: Sense[]
  /** Deinflection reasons, outermost first (["past"] for した → する); per entry, since
   *  one result can mix inflected and surface matches. */
  reasons?: string[]
}

export interface LookupResult {
  /** Matched span `[matchStart, matchStart + matchLength)` within the looked-up text. */
  matchStart: number
  matchLength: number
  /** `entries[0].reasons`; prefer `DictEntry.reasons`. */
  reasons: string[]
  entries: DictEntry[]
}
