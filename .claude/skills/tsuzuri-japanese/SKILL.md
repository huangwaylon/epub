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

# Working on Tsuzuri's Japanese pipeline

Read [`docs/japanese.md`](../../../docs/japanese.md) first (the reference); this is the procedure.

## 1. Locate the stage
| Symptom | Stage | File |
| --- | --- | --- |
| Wrong character / dead tap / furigana looked up | glyph resolution, run gathering | `extract.ts` (main thread) |
| Right character, wrong word span | kuromoji token vs. greedy fallback | `lookup.ts` `resolveLookup`, `segment.ts` |
| Right span, wrong entry order / headword | `matchAt` ranking, `candidateMatches`, `toEntry` | `lookup.ts` |
| Conjugation not recognised | deinflection (vendored GPL, don't edit) | `deinflect.ts` |
| Stale / slow answers, worker dies | worker lifecycle, `RESULT_CACHE` | `lookupClient.ts`, `lookup.worker.ts` |
| Download / offline / "Preparing…" stuck | `downloadDictionary`, `cacheIpadic`, `dictPhase` | `dictdb.ts`, `stores/dict.svelte.ts` |
| Card content / states | popup | `src/lib/reader/DictionaryPopup.svelte` |
| Tap routing, card placement, highlight paint | reader | see the **tsuzuri-reader** skill |

## 2. Invariants to preserve
- The caret APIs are only a **seed**. Resolve the glyph geometrically (`resolveGlyph`),
  never from the caret offset.
- Furigana (`<rt>`/`<rp>`) never enters the run. Don't `range.toString()` ruby text; spell
  words from `positions`. Compare tag names with `toUpperCase()` (XHTML).
- `ready` is captured **before** the IndexedDB awaits, and only ready results are cached
  (`RESULT_CACHE`, main thread, survives the worker).
- kuromoji is boundaries-only: no `tokenize()`, no `tid_pos`, no JS inflate library. That is
  what keeps it at ≈30 MB resident on iOS.
- Keep in sync: `STAGED` (staging script) = `IPADIC_FILES` (`ipadic.ts`), and `IPADIC_CACHE`
  = workbox `cacheName` (`kuromoji-ipadic-v2`, no `expiration`).
- `downloadDictionary` is the only entry to `updateWithRetry` (jpdict-idb drops overlaps).
  `isDictReady()` never throws.
- `toNormalized` returns a tuple. Glosses are English only (`'en'`).
- `deinflect.ts` stays verbatim; the app is GPL-3.0-or-later because of it.

## 3. Change it
1. Write a failing test first in the matching `src/services/jp/*.test.ts`. A new ranking
   rule needs a `lookup.test.ts` case, and a DOM case goes in `extract.test.ts` (fake DOM).
2. Make the change. Keep comments to a line or two of *why*.
3. If you touched the staging script, the loader or `segment.ts`: run
   `node scripts/copy-kuromoji-dict.mjs` (11 files, 11.3 MB) and keep
   `segment.golden.test.ts` green.
4. Update `docs/japanese.md` wherever behaviour or constants changed.

## 4. Verify
- `npm run check` and `npm test`.
- Then use the **tsuzuri-verify** skill:
  1. Download the dictionary in Settings.
  2. In the test EPUB, tap 美しかった: expect 美しい with reason "past".
  3. Tap a ruby compound: no furigana in the word.
  4. Tap the first and last glyph of a column.
