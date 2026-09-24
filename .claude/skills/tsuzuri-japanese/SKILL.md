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
   `caretRangeFromPoint` (WebKit) used only as a **seed** → `resolveGlyph` picks the character
   whose measured box actually contains the point (the caret APIs return a *boundary*, so
   trusting their offset mis-resolves the far half of every glyph; blank taps return null, and
   a tap on furigana redirects to the ruby base) →
   gathers the contiguous `WORD_CHAR` run on **both sides** of the tap (`MAX_BEFORE`/`MAX_AFTER`,
   **skipping `<rt>/<rp>` furigana**, stopping at punctuation, ・, and **paragraph / `<br>`
   breaks** via `breakBetween`) and the tap's offset. Returns `{text, tapOffset, positions}`
   (or null for blank/non-word taps).
2. **Segment** — `resolveLookup(text, tapOffset)` in `lookup.ts` (worker) waits ≤1.2 s for
   kuromoji, captures `ready`, then `tokenSpanAt` (`segment.ts`) gives the IPADIC token
   `{start, end}` containing the tap — from the **lattice + Viterbi path** (`tokenSpans`), never
   `tokenize()`. Until kuromoji is ready (or if its token yields no match) it falls back to
   **greedy leftmost-covering**, all starts probed concurrently, leftmost wins.
3. **Match** — from the token start, `matchAt` does longest-match-first (len 12→minLen:
   `toNormalized()` → `deinflect()` → `getWords(...,{matchType:'exact'})`, `candidateMatches`
   gating). At the winning length **every candidate is merged** (dedupe by id, per-entry
   `reasons`); deinflected entries lead when the span crosses the token end (勉強した → する, not
   下). `toEntry` uses jpdict-idb `match`/`matchRange` flags for headword/reading/sense order.
4. **Deinflect** — `deinflect(word)` in `deinflect.ts` (vendored from 10ten, **GPL-3.0**).
5. **DB** — `dictdb.ts`: `downloadDictionary` (JMdict, deduped, transient errors ⇒
   `'retrying'` not reject), `cacheIpadic` (IPADIC → Cache API `kuromoji-ipadic-v2`),
   `downloadAndCacheDictionary` (shelf) / `downloadAndWarmDictionary` (reader), `dictPhase()`
   for UI; the `dict` store holds `{state, updating, progress, warming, error}`.
6. **Client** — `lookupClient.ts`: `lookupAt`, `warmupLookup`, `pingLookup` (resume liveness),
   `disposeLookup`; the only result cache (`RESULT_CACHE`, ready-derived results only).
7. **UI** — `Reader.svelte` `tryDefine` → `DictionaryPopup.svelte`; `ShelfSettings.svelte`.

## Rules & gotchas
- **GPL:** `deinflect.ts` is GPL-3.0; reimplement it if you need to relicense the app.
- **Memory is the constraint (iOS kills the PWA).** kuromoji is ≈30 MB resident only because
  (a) `scripts/copy-kuromoji-dict.mjs` stages a **trimmed** IPADIC (11 files, 11.3 MB gz,
  27.4 MB inflated, **no `tid_pos`**), (b) `kuromojiLoader.cjs` (aliased in `vite.config.ts`)
  inflates with `DecompressionStream`, skips `tid_pos`, and flattens target maps into
  Int32Arrays, (c) boundaries come from the lattice. Don't call `tokenize()`/`getFeatures`, don't
  re-add a JS inflate lib, and keep `segment.golden.test.ts` green when touching any of this.
- **Keep three lists in sync:** `STAGED` (staging script), `IPADIC_FILES` (`ipadic.ts`), and the
  cache name `IPADIC_CACHE` = workbox `cacheName` in `vite.config.ts` (`kuromoji-ipadic-v2`).
- **Readiness is captured when the path is chosen**, never after the awaits; only ready results
  are cached (`RESULT_CACHE`).
- **`DictionaryPopup` each-key must include the index** (or use `entry.id`). JMdict homographs
  share headword+reading (e.g. 度).
- **`toNormalized` returns a TUPLE** `[string, number[]]`, not `{result}`.
- **Ruby skip uses `tagName.toUpperCase()`** — EPUB content is XHTML where tags are
  lowercase (`rt`). Same for block/`br` detection in `blockOf`/`breakBetween`.
- Word glosses are **always English** — `'en'` is hardcoded at every call site.
- `lookup.ts` reads jpdict records loosely (`any`, fields `id`/`k`/`r`/`s` + match flags).

## Common tasks
- **Tighten matching** → extend `candidateMatches` with a full WordType↔POS map (see
  10ten's `word-search` for reference).
- **Add kanji / name lookups** → use `getKanji` / `getNames` from `@birchill/jpdict-idb`
  and add a series to the download flow.
- **Pitch accent display** → `DictEntry.pitch` is already parsed (`readingAccent`); render it.
- **Tests** → all in `src/services/jp/*.test.ts` (`npm test`): deinflect, extract (fake DOM),
  segment + the real-dictionary golden test, lookup (mocked jpdict-idb), worker protocol,
  client, dictdb. Add a lookup case for any new ranking rule.

## Verify
`npm run check` and `npm test`, then the **tsuzuri-verify** skill: download the dictionary
in Settings and tap a conjugated word in the test EPUB (e.g. 美しかった → should resolve to
美しい with reason "past").
