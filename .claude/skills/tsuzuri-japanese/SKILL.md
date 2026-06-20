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
   `caretRangeFromPoint` (WebKit) → walks text nodes forward up to 16 chars, **skipping
   `<rt>/<rp>` furigana**. `looksJapanese()` gates whether it's a lookup.
2. **Lookup** — `lookup(window)` in `src/services/jp/lookup.ts`: longest-match-first
   (len 16→1); per length, `toNormalized()` then `deinflect()` then `getWords(...,{matchType:'exact'})`;
   `candidateMatches` accepts the surface form always, deinflected candidates only if the
   entry has an inflectable POS. Returns `{matchLength, reasons, entries}`.
3. **Deinflect** — `deinflect(word)` in `src/services/jp/deinflect.ts` (vendored from 10ten,
   **GPL-3.0**) returns `CandidateWord[]` (`{word, type (WordType bitfield), reasonChains}`).
4. **DB** — `src/services/jp/dictdb.ts` owns the `JpdictIdb` singleton; `downloadDictionary`
   pulls JMdict from data.10ten.life into IndexedDB (offline after); the `dict` store
   (`src/stores/dict.svelte.ts`) holds `{state, updating, progress, error}`.
5. **UI** — `Reader.svelte` `tryDefine` → `DictionaryPopup.svelte`. Download is also
   reachable from `ShelfSettings.svelte`.

## Rules & gotchas
- **GPL:** `deinflect.ts` is GPL-3.0; reimplement it if you need to relicense the app.
- **`toNormalized` returns a TUPLE** `[string, number[]]`, not `{result}`.
- **Ruby skip uses `tagName.toUpperCase()`** — EPUB content is XHTML where tags are
  lowercase (`rt`), so a case-sensitive `=== 'RT'` check silently fails. Don't regress this.
- Word glosses stay **English**; `settings.translationTargetLang` is only for *sentence*
  translation (a separate subsystem — see docs/translation.md).
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
