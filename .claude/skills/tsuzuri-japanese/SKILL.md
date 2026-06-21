---
name: tsuzuri-japanese
description: >-
  Use when working on Tsuzuri's Japanese language features — anything under
  src/services/jp/* (dictionary download, deinflection, lookup, word extraction)
  or the dictionary popup. Triggers: tap-to-define behavior, wrong/missing
  dictionary results, deinflection of conjugated verbs/adjectives, ruby/furigana
  handling in lookups, pitch accent or part-of-speech display, downloading/updating
  the JMdict data, or adding kanji/name lookups. Also for "lookup returns the wrong
  word", "furigana leaks into the search", or "dictionary won't download".
---

# Working on Tsuzuri's Japanese dictionary & parsing

**Read [`docs/japanese.md`](../../../docs/japanese.md) first** for the full pipeline,
signatures, and extension recipes. This skill is the quick procedure.

## Pipeline (tap → entry)
1. **Extract** — `extractTextAt(doc, x, y)` in `src/services/jp/extract.ts`: caret via
   `caretRangeFromPoint` (WebKit) → glyph hit-test (`pointOnGlyph`, blank taps return null) →
   gathers the contiguous word-char run on **both sides** of the tap (`MAX_BEFORE`/`MAX_AFTER`,
   **skipping `<rt>/<rp>` furigana**, clause-bounded) and the tap's offset. Returns
   `{text, tapOffset}` (or null for blank/non-word taps).
2. **Segment** — `lookupAt(text, tapOffset)` in `src/services/jp/lookup.ts` finds the word
   boundary via **kuromoji** (`segment.ts`, `tokenStartAt`): the MeCab/IPADIC token containing
   the tap. kuromoji loads lazily (~19 MB IPADIC); until ready (or if it splits a word JMdict
   lemmatises differently) it falls back to **greedy leftmost-covering** (scan starts
   0..tapOffset). So tapping any kanji of a word (決/心 in 決心) resolves the whole word.
3. **Match** — from the token start, `matchAt` does longest-match-first (len 16→1:
   `toNormalized()` → `deinflect()` → `getWords(...,{matchType:'exact'})`, `candidateMatches`
   gating) → `{matchLength, reasons, entries}`. (`lookup(window)` is the old forward-only wrapper.)
4. **Deinflect** — `deinflect(word)` in `src/services/jp/deinflect.ts` (vendored from 10ten,
   **GPL-3.0**) returns `CandidateWord[]` (`{word, type (WordType bitfield), reasonChains}`).
5. **DB** — `src/services/jp/dictdb.ts` owns the `JpdictIdb` singleton; `downloadDictionary`
   pulls JMdict from data.10ten.life into IndexedDB (offline after); the `dict` store
   (`src/stores/dict.svelte.ts`) holds `{state, updating, progress, error}`.
6. **UI** — `Reader.svelte` `tryDefine` → `DictionaryPopup.svelte`. Download is also
   reachable from `ShelfSettings.svelte`.

## Rules & gotchas
- **GPL:** `deinflect.ts` is GPL-3.0; reimplement it if you need to relicense the app.
- **kuromoji dict + loader shim.** The ~19 MB IPADIC dict is staged into `public/kuromoji/dict/`
  by `scripts/copy-kuromoji-dict.mjs` (via `predev`/`prebuild`; gitignored). kuromoji's stock
  loader hangs if the server auto-gzips the dict, so `src/services/jp/kuromojiLoader.cjs` is
  aliased in via `vite.config.ts` (`resolve.alias` + `optimizeDeps.rolldownOptions`). Symptom of
  breakage: dict popup stuck on the spinner + console `Uncaught (in promise)`.
- **`DictionaryPopup` each-key must include the index.** JMdict homographs share headword+reading
  (e.g. 度), so the `{#each result.entries (…)}` key uses `…+ ':' + i` — else `each_key_duplicate`
  crashes the popup. Don't drop the index.
- **`toNormalized` returns a TUPLE** `[string, number[]]`, not `{result}`.
- **Ruby skip uses `tagName.toUpperCase()`** — EPUB content is XHTML where tags are
  lowercase (`rt`), so a case-sensitive `=== 'RT'` check silently fails. Don't regress this.
- Word glosses are **always English** — `downloadDictionary('en')` is hardcoded at every
  call site. There is no sentence-translation feature; the dictionary is the only language
  feature, and it works fully offline once downloaded.
- `lookup.ts` reads jpdict records loosely (`any`, fields `k`/`r`/`s`) rather than the
  exported `WordResult` type.

## Common tasks
- **Tighten matching** → extend `candidateMatches` with a full WordType↔POS map (see
  10ten's `word-search` for reference).
- **Add kanji / name lookups** → use `getKanji` / `getNames` from `@birchill/jpdict-idb`
  and add a series to the download flow.
- **Pitch accent display** → `DictEntry.pitch` is already parsed (`readingAccent`); render it.
- **Tests** → `src/services/jp/deinflect.test.ts` (pure, runs in `npm test`). Add cases for
  new deinflection coverage.

## Verify
`npm run check` and `npm test`, then the **tsuzuri-verify** skill: download the dictionary
in Settings and tap a conjugated word in the test EPUB (e.g. 美しかった → should resolve to
美しい with reason "past").
