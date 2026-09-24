# Japanese dictionary & text parsing

Tap a word → an offline JMdict entry with deinflection. The main thread extracts the
Japanese run around the tap; a Web Worker segments it with **kuromoji** (IPADIC word
boundaries), deinflects candidates with the vendored **10ten** engine and queries JMdict via
**jpdict-idb**. After the one-time download everything is offline.

Code: `src/services/jp/`, UI glue in `src/lib/reader/Reader.svelte` and
`DictionaryPopup.svelte`, status in `src/stores/dict.svelte.ts`. Tap routing, popup
placement and highlight painting live in [reader-engine.md](reader-engine.md) (Taps &
gestures; Highlights & CFI).

## 1. Files

| File | Thread | Role |
| --- | --- | --- |
| `extract.ts` | main | Glyph under the tap (geometry) + the Japanese run around it; `rangeForSpan`. |
| `lookupClient.ts` | main | Owns the worker; `lookupAt`, `warmupLookup`, `pingLookup`, `disposeLookup`, `clearLookupCache`; the result cache. |
| `lookup.worker.ts` | worker | Message protocol over `lookup.ts`. |
| `lookup.ts` | worker | `resolveLookup`: segment → `matchAt` (normalize → deinflect → `getWords`) → ranking. |
| `segment.ts` | worker | kuromoji build + token spans from the Viterbi path. |
| `kuromojiLoader.cjs` | worker | Replacement kuromoji dictionary loader (aliased in `vite.config.ts`). |
| `ipadic.ts` | both | `IPADIC_DIR`, `IPADIC_FILES`, `IPADIC_CACHE`, `ipadicUrls()`. |
| `lookupTypes.ts` | both | `Sense`, `DictEntry`, `LookupResult` (type-only for the main thread). |
| `deinflect.ts` | worker | Vendored 10ten deinflector (**GPL-3.0-or-later**; `LICENSE-10ten`). |
| `dictdb.ts` | main | JMdict download lifecycle, IPADIC pre-cache, `dictPhase()`. |
| `scripts/copy-kuromoji-dict.mjs` | build | Stages the trimmed IPADIC into `public/kuromoji/dict/`. |

## 2. Packages & licensing

| Package | Role |
| --- | --- |
| `@birchill/jpdict-idb` | JMdict download into IndexedDB (`JpdictIdb`, `updateWithRetry`) and queries (`getWords`). Data from `data.10ten.life`. |
| `@birchill/normal-jp` | `toNormalized` (returns a **tuple** `[string, number[]]`); `kanaToHiragana` (used by `deinflect.ts`). |
| `@sglkc/kuromoji` | MeCab/IPADIC analyzer (Apache-2.0). Only `builder`, `Tokenizer#getLattice` and `viterbi_searcher` are used. |

`deinflect.ts` is copied from [10ten-ja-reader](https://github.com/birchill/10ten-ja-reader)
(`src/background/deinflect.ts`); its only edit is `const enum` → `enum` so `Reason` /
`WordType` survive esbuild's isolated-modules transpilation. Because it is bundled, **the
whole app is GPL-3.0-or-later**; relicensing means reimplementing it. Don't edit it.

## 3. Extraction (`extract.ts`, main thread)

```ts
extractTextAt(doc, x, y): { text, tapOffset, positions: CharPosition[] } | null
rangeForSpan(doc, positions, start, end): Range | null
```

`x, y` are iframe-local. `null` means blank space or a non-word glyph, and the reader treats
the tap as a chrome/dismiss tap instead.

### Glyph resolution (`resolveGlyph`)

`caretRangeFromPoint` / `caretPositionFromPoint` return the nearest caret **boundary**, which
moves to the next character once the point passes a glyph's mid-advance. Trusting that offset
picks the *next* character over the far half of every glyph. So the caret is only a seed:

1. `caretPosition` tries `caretRangeFromPoint`, then `caretPositionFromPoint`, both in
   `try/catch`. A non-Text seed returns `null`.
2. A seed inside `<rt>`/`<rp>` goes to `rubyBaseHit`, which picks the nearest **base**
   character of the enclosing `<ruby>`. Furigana is never looked up.
3. Candidates: the seed offset, `offset − 1`, and at a node boundary the adjacent text node's
   last/first character (`siblingText`, furigana skipped).
4. Each candidate's `charRect` (the **largest-area** client rect; WebKit adds a degenerate
   rect on the previous line/column for a line-start range) goes through `hitDistance`.
   Containment wins at once, otherwise the nearest candidate within slack wins, otherwise `null`.

`glyphSlack` reads the parent's computed style:

| Axis | Slack | Why |
| --- | --- | --- |
| Cross (line stacking; x in vertical modes, y in horizontal) | `(lineHeight − fontSize)/2 + MIN_HIT_SLACK` | Half the leading: each line's target reaches exactly the midpoint to its neighbour. |
| Reading | `MIN_HIT_SLACK + fontSize × READING_SLACK_EM` | Glyphs are contiguous; only forgive a near-miss. |

`MIN_HIT_SLACK = 6` px, `READING_SLACK_EM = 0.15`, and `line-height: normal` counts as
`1.5 × fontSize`. Any non-`horizontal-*` writing mode counts as vertical. Keep the slack
small: blank-tap fall-through depends on some taps missing every glyph.

### Run gathering

- The tapped character must match `WORD_CHAR`: kana (U+3040–30FA, U+30FC–30FF, so **not** ・
  U+30FB, which separates words), 々〆〇 (U+3005–3007), CJK Ext-A + Unified (U+3400–9FFF) and
  CJK Compatibility (U+F900–FAFF). Keep the `\u` escapes (U+F900 looks like U+8C48). Astral
  CJK is out of scope.
- The run collects up to `MAX_BEFORE = 12` word-chars before and `MAX_AFTER = 16` from the
  tap, over a text-only TreeWalker that rejects `<rt>`/`<rp>` (`textWalker`). It is capped
  while scanning.
- It stops at any non-word character and at line breaks (`breakBetween`): the nodes' nearest
  block ancestors differ, or a block element, `<br>` or `<img>` (inline gaiji) sits between
  them. Blocks are matched by tag name (`BLOCK_TAGS`), not computed `display`.
- Tag names are compared with `toUpperCase()` because EPUB XHTML tag names are lowercase.
- `positions[i]` is the DOM location of `text[i]`. The reader builds the highlight range
  with `rangeForSpan` and spells the saved word from `positions`. **Never `range.toString()`
  a word with ruby**: the `<rt>` gets spliced in (決けっ心).

## 4. Lookup (`lookup.ts`, worker)

### `resolveLookup(text, tapOffset) → { result, ready }`

1. An out-of-range `tapOffset` returns `null`.
2. `settleSegmenter()` gives an in-flight kuromoji build up to `SEGMENTER_WAIT_MS = 1200`.
   After a failed build (`segmenterUnavailable`), taps stop waiting but kick a background
   retry; `warmup()` or a successful retry clears the flag.
3. `ready = segmenterReady()` and `tokenSpanAt` are read **synchronously, before any
   IndexedDB await**. `ready` tags the reply and decides cacheability, so a build finishing
   mid-lookup can't promote a greedy answer.
4. **Token path:** `matchAt(text.slice(token.start), q, tapOffset − token.start + 1, tokenLen)`,
   then `matchStart = token.start`.
5. **Greedy fallback** (not ready, or the token matched nothing): every start from
   `max(0, tapOffset − MAX_WINDOW + 1)` to `tapOffset` is probed concurrently, and the
   **leftmost** start whose match spans the tap wins (決 or 心 in 決心 → 決心).

`lookupAt(text, tapOffset)` returns just `result` (used by tests). One `makeQueryCache()`
per tap memoises `getWords(term, { matchType: 'exact', limit: MAX_RESULTS })` **promises**,
so parallel probes share reads. A rejected read resolves `[]`.

### `matchAt(window, queryWords, minLen = 1, tokenLen?)`

- Lengths run from `min(window.length, MAX_WINDOW = 12)` down to `minLen`. `minLen` is the
  lossless "must span the tap" bound; if it is above the limit, nothing is queried.
- Per length: `const [normalized] = toNormalized(sub)`, then `deinflect(normalized)` (the
  surface form is candidate #0). All queries fire before any await.
- `candidateMatches` accepts a surface candidate always. A deinflected one needs an entry POS
  that matches `cand.type` (10ten's `entryMatchesType`): `v1*` ichidan, `v5*`/`v4*` godan,
  `adj-i*`, `vk`, `vs-*` suru, `vs-s`/`vz` special suru, `vs` noun-suru. Without this,
  した → ichidan しる matches godan 知る.
- **The first length with any hit wins, and every candidate at that length is merged**,
  deduped by entry id (the least-inflected candidate keeps it). Each entry carries its own
  `reasons`. Cap: `MAX_ENTRIES = 10`.

Ranking at the winning length:

| Rule | Example |
| --- | --- |
| Surface entries first, **unless** the span is longer than the kuromoji token it starts in (`len > tokenLen`); then deinflected entries lead. | 勉強した (勉強\|し\|た) → する "past" first; 机のした (one token) → 下 first. |
| Within deinflected entries, common ones (any `k[].p`/`r[].p` priority tag) come before uncommon ones. | した → する before したる. |
| If the longest span is deinflection-only, has no common word and crosses the token, it is held back: the longest shorter length with a common word wins, else it stands. Surface matches are never demoted. | したよう → した (する past), not volitional したる. |

### `toEntry` (raw `getWords` record → `DictEntry`)

jpdict-idb marks the searched form with `matchRange`, and the forms/senses that go with it
with `match`.

- **Kanji hit:** headword = that spelling; reading = the hit reading, else the first
  `match`ed reading, else the first reading.
- **Kana hit:** headword = the kana if the entry has no kanji or is *usually kana* (at least
  half the matched senses tagged `uk`), else the first `match`ed kanji (した → 下).
- `kanaOnly = !k.length || headword === reading`. `pitch` comes from the reading's `a` field
  (`readingAccent`).
- Senses: matched first (stable). POS goes through `POS_LABELS`/`posLabel` (prefix fallbacks
  `v5*` godan, `adj*`, `v*`), `misc` through `MISC_LABELS` (unlisted codes pass through raw),
  reasons through `REASON_LABELS` (first chain only; unmapped reasons dropped).
- Records are read loosely (`any`: `id`, `k`, `r`, `s`, `pos`, `g`, `misc`, `match`, `matchRange`).

### Result types (`lookupTypes.ts`)

`LookupResult { matchStart, matchLength, reasons /* = entries[0].reasons */, entries }`;
`DictEntry { id?, headword, reading, pitch?, kanaOnly, senses, reasons? }`;
`Sense { pos, glosses, misc?, matched? }`. Render `entry.reasons` **per entry**, since one
result can mix した → する (past) with the noun 下.

## 5. Segmentation & kuromoji memory

`segment.ts`:

- `ensureSegmenter()` runs `kuromoji.builder({ dicPath: IPADIC_DIR }).build()` once. On
  failure it clears the promise so the next call retries.
- `segmenterReady()` is synchronous. `lookup.ts` re-exports it as `isSegmenterReady`.
- `tokenSpans(tok, text)` splits after each 、/。 like kuromoji, then maps
  `viterbi_searcher.search(getLattice(sentence))` nodes to `[start, end)`. That gives the same
  boundaries as `tokenize()` but offsets each sentence by its real position. Extracted runs
  never contain 、/。.
- `tokenSpanAt(text, tapOffset)` returns the covering span, or `null`.

**Never call `tokenize()` / `getFeatures`**: `tid_pos` isn't shipped. If you need POS, use
JMdict's.

Resident memory is **≈30–33 MB** (stock kuromoji: ~175 MB). Three lossless changes get it
there:

| Where | What |
| --- | --- |
| `copy-kuromoji-dict.mjs` | Cuts `tid`, `unk`, `unk_pos`, `unk_map`, `unk_invoke` to their structural length. The cut is computed from the target maps, the furthest unknown-entry feature string and the character-class count; the tail must be all zeros, and token costs are spot-checked. Re-gzips at level 9. Copies `base`, `check`, `cc`, `unk_char`, `unk_compat`, `tid_map` byte-for-byte. Doesn't stage `tid_pos`, and deletes a stale copy. A `.staged.json` stamp (source sizes + `TRIM_VERSION`) skips regeneration. `node scripts/copy-kuromoji-dict.mjs [destDir]`. |
| `kuromojiLoader.cjs` | Gunzips with `DecompressionStream` only when the bytes start `1f 8b` (servers sending `Content-Encoding: gzip`, like Vite dev, hand over inflated bytes). Answers `tid_pos.dat.gz` with an empty buffer, unfetched. Replaces `loadTargetMap` per instance with flat `Int32Array`s behind a `Proxy` (`target_map[id]` → `subarray`). If `fetch` fails, falls back to `caches.match(url)`. Calls kuromoji's callback outside the promise chain and rethrows on a fresh task, so a failure becomes a worker `error` instead of a hang. |
| `segment.ts` | Boundaries from the lattice, which is what makes dropping `tid_pos` safe. |

| | Stock | Staged |
| --- | --- | --- |
| Files | 12 | 11 (`IPADIC_FILES`) |
| Gzipped | ~19 MB | 11.3 MB |
| Inflated | 95.6 MB | 27.4 MB |

Don't trim a file without a structural bound: `ByteBuffer` returns 0 for a read that
straddles the end, so blindly cutting "trailing zeros" can corrupt the last entry.
`segment.golden.test.ts` pins the boundaries to stock kuromoji. Keep it green.

## 6. Worker & client (`lookupClient.ts`, `lookup.worker.ts`)

Protocol (the reply is `{ id, result, ready? }`; a thrown lookup replies `result: null` with
no `ready`):

| Message | Reply |
| --- | --- |
| `warmup` | `result: boolean`: `warmup()` builds kuromoji and opens this worker's IndexedDB with a one-row `getWords('の')`. |
| `ping` | `result: true, ready: isSegmenterReady()`. |
| `lookup {text, tapOffset}` | `result: LookupResult \| null, ready` (captured at decision time, §4). |

| Client API | Behaviour |
| --- | --- |
| `lookupAt(text, tapOffset)` | Serves a `RESULT_CACHE` hit without touching the worker. Otherwise sends a request (8 s timeout) and caches the reply **only if `ready === true`** (including a definitive "no match"). Resolves `null` on any failure; never throws. |
| `warmupLookup()` | Builds kuromoji (30 s timeout) and returns `true` once built. |
| `pingLookup(timeoutMs = 2000)` | Returns `false` if there is no worker, or it didn't answer (then it is dropped). Never constructs one. |
| `disposeLookup()` | Terminates the worker, resolves in-flight requests with `null`, resets construct failures. The cache survives. |
| `clearLookupCache()` | Called by `dictdb` when a JMdict download completes. |

- **`RESULT_CACHE`** is an LRU of 200 keyed `` `${tapOffset} ${text}` `` on the main thread.
  It is the only result cache, holds ready-derived results only, and outlives the worker, so
  a re-tap answers without a rebuild.
- **Timeouts drop the worker**, because iOS can kill a worker without firing `onerror`.
  `onerror` also just drops it, and the next call builds a new one. Only
  `MAX_CONSTRUCT_FAILURES = 3` consecutive construction failures disable lookups.
- There is no main-thread copy of the engine; kuromoji, jpdict-idb and deinflect ship only
  in the worker chunk.

Lifecycle, driven by `Reader.svelte`:

- warmed at reader mount if `isDictReady()`
- disposed after `LOOKUP_IDLE_DISPOSE_MS = 60_000` of continuous backgrounding (re-checking
  `document.hidden`)
- on return, `pingLookup()` checks the worker and re-warms if it gets `false`
- disposed on reader exit

## 7. Dictionary lifecycle (`dictdb.ts`, main thread)

Only the jpdict-idb `words` series is used, and glosses are always English (`'en'` at every
call site).

| API | Behaviour |
| --- | --- |
| `getDb()` | Creates `JpdictIdb`, awaits `ready`, subscribes `syncState`. Memoises **success only**, so a failed open (iOS storage pressure, a versionchange) is retried on the next call. |
| `isDictReady()` | Fast path `dict.state === 'ok'`, else `getDb()` and checks `words.state`. **Never throws** (it is on the tap path). |
| `downloadDictionary(lang)` | JMdict only. Every caller shares one promise, because jpdict-idb silently ignores an overlapping `updateWithRetry` and keeps the first call's callbacks. A repeat call while a retry is queued re-issues it with `updateNow: true`. `OfflineError` or a scheduled retry (`nextRetry`) leaves the promise pending with `dict.error` explaining it. A permanent error or an `AbortError` rejects. On completion it calls `clearLookupCache()`. |
| `cacheIpadic()` | `cache.add`s each `ipadicUrls()` entry missing from Cache API `IPADIC_CACHE`. Compressed bytes only: no worker, no trie. Returns `false` if any file failed or there is no Cache API (non-secure LAN origin). |
| `downloadAndCacheDictionary(lang)` | Shelf: `downloadDictionary` → `cacheIpadic`, with `dict.warming` set for the second step. |
| `downloadAndWarmDictionary(lang)` | Reader popup: the same, then `warmupLookup()`. `warming` stays set until kuromoji is built. |
| `dictPhase()` | Reactive status derived from the `dict` store (below). |

`dict` store: `{ state: 'init'|'empty'|'ok'|'unavailable', updating, progress (0..1),
warming, error? }`. `syncState` copies `words.state`/`updateState`. A module `retrying` flag
keeps `updating` true through the `'idle'` that jpdict-idb reports between a failed attempt
and its retry, and is cleared (with the message) when the retry starts.

| `dictPhase()` | Condition (in order) | UI |
| --- | --- | --- |
| `'retrying'` | `updating && error` | message; no Download button |
| `'downloading'` | `updating` | progress bar |
| `'preparing'` | `warming` | "Preparing…" |
| `'ready'` | `state === 'ok'` | — |
| `'checking'` | `state === 'init'` | — |
| `'unavailable'` | `state === 'unavailable'` | "storage couldn't be opened" |
| `'missing'` | otherwise (`'empty'`, or a failed download with `error`) | Download |

**Callers.**

- `ShelfSettings.svelte` calls `getDb()` on mount, `cacheIpadic()` if JMdict is installed,
  and `downloadAndCacheDictionary('en')` for its button.
- `main.ts` idle-calls `cacheIpadic()` after 4 s when online and the dictionary is ready. It
  also deletes the obsolete `kuromoji-ipadic` cache.
- `Reader.svelte` calls `isDictReady()` before each lookup, sets `needsDownload` when that
  returns false, and calls `downloadAndWarmDictionary('en')` from the popup. It re-runs the
  pending lookup as soon as `dict.state === 'ok'`.

### IPADIC offline caching

The workbox runtime route `/kuromoji/dict/*.dat.gz` is `CacheFirst` into
**`kuromoji-ipadic-v2`**, with **no `expiration`** (not even `maxEntries`). The dict is
all-or-nothing, and a partial cache builds no trie. `**/kuromoji/**` is excluded from the
precache. `IPADIC_CACHE` must equal that `cacheName`, and `IPADIC_FILES` must equal `STAGED`
in the staging script. See [storage-pwa-ios.md](storage-pwa-ios.md) (PWA setup) for the rest
of the SW config.

## 8. Popup (`DictionaryPopup.svelte`)

Props: `open`, `anchor` (top-window rect of the glyph or matched word), `vertical`,
`loading`, `needsDownload`, `result`, `highlighted`, `onclose`, `ondownload`,
`ontogglehighlight`. Placement uses `placeNearWord` (`src/lib/util/anchoredPosition.ts`) in
the same flush as mount. The card never covers the anchor, and placement is detailed in
reader-engine.md.

| State | Renders |
| --- | --- |
| `needsDownload` | By `dictPhase()`: progress (`downloading`), retry message (`retrying`), "Preparing…" (`preparing`/`ready`/`checking`, never re-offering Download), "unavailable", else **Download dictionary** + `dict.error`. |
| `result` | Per entry: reason chips, headword, reading (unless `kanaOnly`), pitch, senses (POS, misc, `; `-joined glosses). While `loading` a re-targeted result stays visible, dimmed. |
| `loading`, no result | Skeleton, shown only after 150 ms. |
| else | "No dictionary match." |

A footer **Highlight / Remove highlight** toggle shows when there is a real match. The
`{#each}` key is `entry.id ?? headword + reading + ':' + i`, because JMdict homographs share
headword + reading (度) and a duplicate key breaks Svelte.

## 9. Tests (`npm test`)

| File | Covers |
| --- | --- |
| `deinflect.test.ts` | Plain forms among candidates (食べていました → 食べる, 美しかった → 美しい, …). |
| `extract.test.ts` | Fake DOM: mid-glyph and end-of-node correction, node crossing, furigana → base, blank ⇒ `null`, non-word gate, run caps, vertical slack, no run across blocks / `<br>`, ・ boundary, 〇/〆. |
| `segment.test.ts` | Build gating/retry, `tokenSpanAt` mapping (per-sentence offsets) with a fake tokenizer. |
| `segment.golden.test.ts` | Runs the staging script into a temp dir, then checks that stock kuromoji `tokenize()` and Tsuzuri's loader + `tokenSpans` produce identical boundaries over `__fixtures__/corpus-ja.txt` and 5,000 seeded random strings. Also checks there is no `tid_pos` and there are 11 character classes. |
| `lookup.test.ts` | Token vs. greedy paths, `settleSegmenter`, `minLen`/`MAX_WINDOW` bounds, `candidateMatches`, merging and ranking rules, `toEntry` match flags, `ready` at decision time, `warmup`. |
| `lookup.worker.test.ts` | Protocol: `ready` from the lookup, `ping`, `warmup`, thrown lookup ⇒ uncacheable `null`. |
| `lookupClient.test.ts` | Lazy construction, cache (ready-only, survives dispose), `pingLookup`, timeouts dropping the worker. |
| `dictdb.test.ts` | Shared download, transient ⇒ `'retrying'`, `updateNow`, permanent rejection, `cacheIpadic` (base-aware URLs, cache name, skip/failure), shelf vs. reader flows. |

Add a `lookup.test.ts` case for any new ranking rule.

## 10. Extending

- **Kanji / names:** `getKanji` / `getNames` from jpdict-idb, plus the `'kanji'` / `'names'`
  series in the download flow and new render paths.
- **Pitch contour:** `DictEntry.pitch` + `countMora` / `moraSubstring` from normal-jp.
- **Stricter deinflection gating:** extend `candidateMatches` toward 10ten's full
  WordType ↔ POS map.
- **Self-hosted data:** mirror `data.10ten.life` and point jpdict-idb at it.

## 11. Gotchas

- The caret APIs are a seed, never the answer (§3).
- Don't `range.toString()` ruby text. Spell words from `positions` or the stored annotation.
- `toNormalized` returns a tuple.
- Always download through `downloadDictionary`, never a raw `updateWithRetry`.
- `dict.state === 'ok'` is the only usable state.
- Never cache a not-ready result, and capture readiness before the awaits.
- Keep `STAGED` = `IPADIC_FILES`, and `IPADIC_CACHE` = the workbox `cacheName`. Never add
  `expiration` to that route.
- Don't reintroduce `tokenize()`, `tid_pos` (+40 MB resident) or a JS inflate library.
- Don't put a NUL byte in these sources: git then treats the file as binary.
