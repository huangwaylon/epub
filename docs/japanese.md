# Japanese dictionary & text parsing

Tap a word → an offline JMdict entry with deinflection. The main thread extracts the
Japanese run around the tap; a Web Worker segments it with **kuromoji** (IPADIC word
boundaries), deinflects candidates with the vendored **10ten** engine and queries JMdict via
**jpdict-idb**. After the one-time download everything is offline.

Code: `src/services/jp/`, status in `src/stores/dict.svelte.ts`, card in
`src/lib/reader/DictionaryPopup.svelte`. Tap routing, card state and placement, and
highlight painting are in [reader-engine.md](reader-engine.md) §8, §9, §11.

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
| `lookupTypes.ts` | both | `Sense`, `DictEntry`, `LookupResult`. |
| `deinflect.ts` | worker | Vendored 10ten deinflector (**GPL-3.0-or-later**; `LICENSE-10ten`). |
| `dictdb.ts` | main | JMdict download lifecycle, IPADIC pre-cache, `dictPhase()`. |
| `scripts/copy-kuromoji-dict.mjs` | build | Stages the trimmed IPADIC into `public/kuromoji/dict/`. |

## 2. Packages & licensing

| Package | Role |
| --- | --- |
| `@birchill/jpdict-idb` | JMdict download into IndexedDB (`JpdictIdb`, `updateWithRetry`) and queries (`getWords`). Data from `data.10ten.life`. |
| `@birchill/normal-jp` | `toNormalized` (returns a **tuple** `[string, number[]]`); `kanaToHiragana` (used by `deinflect.ts`). |
| `@sglkc/kuromoji` | MeCab/IPADIC analyzer (Apache-2.0). Only `builder`, `Tokenizer#getLattice` and `viterbi_searcher` are used. |

`deinflect.ts` is copied from 10ten-ja-reader (`src/background/deinflect.ts`); its only edit
is `const enum` → `enum` so `Reason` / `WordType` survive esbuild's isolated-modules
transpilation. Because it is bundled, the whole app is GPL-3.0-or-later; relicensing means
reimplementing it. Don't edit it.

## 3. Extraction (`extract.ts`, main thread)

```ts
extractTextAt(doc, x, y): { text, tapOffset, positions: CharPosition[] } | null
rangeForSpan(doc, positions, start, end): Range | null
```

`x, y` are iframe-local. `null` (blank space or a non-word glyph) makes the reader treat the
tap as a chrome/dismiss tap.

### Glyph resolution (`resolveGlyph`)

`caretRangeFromPoint` / `caretPositionFromPoint` return the nearest caret **boundary**, which
moves to the next character past a glyph's mid-advance; trusting it picks the next character
over the far half of every glyph. So the caret is only a seed:

1. `caretPosition` tries `caretRangeFromPoint`, then `caretPositionFromPoint`, both in
   `try/catch`. A non-Text seed returns `null`.
2. A seed inside English (`.tsuzuri-en`) is re-seeded at the end of the Japanese before it,
   so its last glyph and the first glyph after the English are candidates; a tap on the
   English itself hits no glyph.
3. A seed inside `<rt>`/`<rp>` goes to `rubyBaseHit`, which picks the nearest base character
   of the enclosing `<ruby>`. Furigana is never looked up.
4. Candidates: the seed offset, `offset − 1`, and at a node boundary the adjacent text node's
   last/first character (`siblingText`, furigana skipped).
5. Each candidate's `charRect` (the **largest-area** client rect; WebKit adds a degenerate
   rect on the previous line for a line-start range) goes through `hitDistance`. Containment
   wins, else the nearest candidate within slack, else `null`.

`glyphSlack` reads the parent's computed style:

| Axis | Slack | Why |
| --- | --- | --- |
| Cross (x in vertical modes, y in horizontal) | `(lineHeight − fontSize)/2 + MIN_HIT_SLACK` | Half the leading: each line's target reaches the midpoint to its neighbour. |
| Reading | `MIN_HIT_SLACK + fontSize × READING_SLACK_EM` | Glyphs are contiguous; only forgive a near-miss. |

`MIN_HIT_SLACK = 6` px, `READING_SLACK_EM = 0.15`, `line-height: normal` counts as
`1.5 × fontSize`, any non-`horizontal-*` mode is vertical. Keep the slack small: blank-tap
fall-through depends on some taps missing every glyph.

### Run gathering

- The tapped character must match `WORD_CHAR`: kana (U+3040–30FA, U+30FC–30FF, so not ・
  U+30FB, which separates words), 々〆〇 (U+3005–3007), CJK Ext-A + Unified (U+3400–9FFF),
  CJK Compatibility (U+F900–FAFF). Keep the `\u` escapes (U+F900 looks like U+8C48). Astral
  CJK is out of scope.
- The run takes up to `MAX_BEFORE = 12` word-chars before and `MAX_AFTER = 16` from the tap,
  over a text-only TreeWalker that rejects `<rt>`/`<rp>` and English (`textWalker`).
- It stops at any non-word character and at line breaks (`breakBetween`): different nearest
  block ancestors, or a block element, `<br>`, `<img>` (inline gaiji) or `.tsuzuri-en` between
  the nodes. Blocks are matched by tag name (`BLOCK_TAGS`), not computed `display`; tag names
  are compared with `toUpperCase()` because EPUB XHTML tag names are lowercase.
- `positions[i]` is the DOM location of `text[i]`. The reader builds the highlight range with
  `rangeForSpan` and spells the saved word from `positions`. **Never `range.toString()` a word
  with ruby**: the `<rt>` gets spliced in (決けっ心).

## 4. Lookup (`lookup.ts`, worker)

### `resolveLookup(text, tapOffset) → { result, ready }`

1. An out-of-range `tapOffset` returns `null`.
2. `settleSegmenter()` gives an in-flight kuromoji build up to `SEGMENTER_WAIT_MS = 1200`.
   After a failed build (`segmenterUnavailable`) taps stop waiting but kick a background
   retry; `warmup()` or a successful retry clears the flag.
3. `ready = segmenterReady()` and `tokenSpanAt` are read **synchronously, before any IndexedDB
   await**. `ready` decides cacheability, so a build finishing mid-lookup can't promote a
   greedy answer.
4. **Token path:** `matchAt(text.slice(token.start), q, tapOffset − token.start + 1, tokenLen)`.
5. **Greedy fallback** (not ready, or the token matched nothing): every start from
   `max(0, tapOffset − MAX_WINDOW + 1)` to `tapOffset` is probed concurrently; the leftmost
   start whose match spans the tap wins (決 or 心 in 決心 → 決心).

One `makeQueryCache()` per tap memoises `getWords(term, { matchType: 'exact', limit:
MAX_RESULTS })` promises, so parallel probes share reads. A rejected read resolves `[]`.

### `matchAt(window, queryWords, minLen = 1, tokenLen?)`

- Lengths run from `min(window.length, MAX_WINDOW = 12)` down to `minLen` (the "must span the
  tap" bound). All queries fire before any await.
- Per length: `const [normalized] = toNormalized(sub)`, then `deinflect(normalized)` (the
  surface form is candidate #0).
- `candidateMatches` accepts a surface candidate always. A deinflected one needs an entry POS
  matching `cand.type` (10ten's `entryMatchesType`): `v1*` ichidan, `v5*`/`v4*` godan,
  `adj-i*`, `vk`, `vs-*` suru, `vs-s`/`vz` special suru, `vs` noun-suru. Without this,
  した → ichidan しる matches godan 知る.
- **The first length with any hit wins, and every candidate at that length is merged**,
  deduped by entry id (the least-inflected candidate keeps it), each entry with its own
  `reasons`. Cap: `MAX_ENTRIES = 10`.

Ranking at the winning length:

| Rule | Example |
| --- | --- |
| Surface entries first, unless the span is longer than the kuromoji token it starts in (`len > tokenLen`); then deinflected entries lead. | 勉強した (勉強\|し\|た) → する "past" first; 机のした (one token) → 下 first. |
| Within deinflected entries, common ones (any `k[].p`/`r[].p`) before uncommon. | した → する before したる. |
| A longest span that is deinflection-only, has no common word and crosses the token is held back: the longest shorter length with a common word wins, else it stands. Surface matches are never demoted. | したよう → した (する past), not volitional したる. |

### `toEntry` (raw `getWords` record → `DictEntry`)

jpdict-idb marks the searched form with `matchRange` and the forms/senses that go with it
with `match`.

- **Kanji hit:** headword = that spelling; reading = the hit reading, else the first matched
  reading, else the first.
- **Kana hit:** headword = the kana if the entry has no kanji or is *usually kana* (at least
  half the matched senses tagged `uk`), else the first matched kanji (した → 下).
- `kanaOnly = !k.length || headword === reading`; `pitch` from the reading's `a` field.
- Senses: matched first (stable). POS via `POS_LABELS` (prefix fallbacks `v5*`, `adj*`,
  `v*`), `misc` via `MISC_LABELS` (unlisted codes pass through), reasons via `REASON_LABELS`
  (first chain only; unmapped dropped).

`LookupResult { matchStart, matchLength, reasons /* = entries[0].reasons */, entries }`;
`DictEntry { id?, headword, reading, pitch?, kanaOnly, senses, reasons? }`;
`Sense { pos, glosses, misc?, matched? }`. Render `entry.reasons` per entry: one result can
mix した → する (past) with the noun 下.

## 5. Segmentation & kuromoji memory

- `ensureSegmenter()` runs `kuromoji.builder({ dicPath: IPADIC_DIR }).build()` once; a failure
  clears the promise so the next call retries. `segmenterReady()` is synchronous.
- `tokenSpans(tok, text)` splits after each 、/。 like kuromoji, then maps
  `viterbi_searcher.search(getLattice(sentence))` nodes to `[start, end)`: the same boundaries
  as `tokenize()`, offset by each sentence's real position.
- `tokenSpanAt(text, tapOffset)` returns the covering span, or `null`.

**Never call `tokenize()` / `getFeatures`**: `tid_pos` isn't shipped. For POS, use JMdict's.

Resident memory is ≈30–33 MB (stock kuromoji: ~175 MB), from three lossless changes:

| Where | What |
| --- | --- |
| `copy-kuromoji-dict.mjs` | Cuts `tid`, `unk`, `unk_pos`, `unk_map`, `unk_invoke` to their structural length (from the target maps, the furthest unknown-entry feature string and the character-class count; the tail must be all zeros, token costs are spot-checked), re-gzips at level 9, copies the rest byte-for-byte, doesn't stage `tid_pos` (and deletes a stale copy). A `.staged.json` stamp (source sizes + `TRIM_VERSION`) skips regeneration. `node scripts/copy-kuromoji-dict.mjs [destDir]`. |
| `kuromojiLoader.cjs` | Gunzips with `DecompressionStream` only when the bytes start `1f 8b` (a server sending `Content-Encoding: gzip`, like Vite dev, hands over inflated bytes). Answers `tid_pos.dat.gz` with an empty buffer. Replaces `loadTargetMap` with flat `Int32Array`s behind a `Proxy`. Falls back to `caches.match(url)` if `fetch` fails. Calls kuromoji's callback outside the promise chain and rethrows on a fresh task, so a failure becomes a worker `error` instead of a hang. |
| `segment.ts` | Boundaries from the lattice, which makes dropping `tid_pos` safe. |

Stock: 12 files, ~19 MB gzipped, 95.6 MB inflated. Staged: 11 files (`IPADIC_FILES`),
11.3 MB, 27.4 MB.

Don't trim a file without a structural bound: `ByteBuffer` returns 0 for a read that straddles
the end, so cutting "trailing zeros" can corrupt the last entry. `segment.golden.test.ts` pins
the boundaries to stock kuromoji.

## 6. Worker & client (`lookupClient.ts`, `lookup.worker.ts`)

Replies are `{ id, result, ready? }`; a thrown lookup replies `result: null` with no `ready`.

| Message | Reply |
| --- | --- |
| `warmup` | `result: boolean`: builds kuromoji and opens the worker's IndexedDB with a one-row `getWords('の')`. |
| `ping` | `result: true, ready`. |
| `lookup {text, tapOffset}` | `result: LookupResult \| null, ready` (captured at decision time, §4). |

| Client API | Behaviour |
| --- | --- |
| `lookupAt(text, tapOffset)` | Serves a `RESULT_CACHE` hit without the worker. Otherwise requests (8 s timeout) and caches the reply only if `ready === true` (including a definitive "no match"). Resolves `null` on any failure; never throws. |
| `warmupLookup()` | Builds kuromoji (30 s timeout); `true` once built. |
| `pingLookup(timeoutMs = 2000)` | `false` if there is no worker or it didn't answer (then it is dropped). Never constructs one. |
| `disposeLookup()` | Terminates the worker, resolves in-flight requests with `null`, resets construct failures. The cache survives. |
| `clearLookupCache()` | Called by `dictdb` when a JMdict download completes. |

- `RESULT_CACHE`: LRU of 200 on the main thread, keyed `` `${tapOffset} ${text}` ``; outlives
  the worker, so a re-tap answers without a rebuild.
- Timeouts drop the worker, because iOS can kill one without firing `onerror`. `onerror` also
  drops it; the next call builds a new one. Only `MAX_CONSTRUCT_FAILURES = 3` consecutive
  construction failures disable lookups.
- kuromoji, jpdict-idb and deinflect ship only in the worker chunk; there is no main-thread
  fallback.

Lifecycle (`Reader.svelte`): warmed at mount if `isDictReady()`; disposed after
`LOOKUP_IDLE_DISPOSE_MS = 60_000` of continuous backgrounding (not on every hide: taps during a
rebuild fall back to greedy segmentation); on return `pingLookup()` and re-warm on `false`;
disposed on reader exit.

## 7. Dictionary lifecycle (`dictdb.ts`, main thread)

Only the jpdict-idb `words` series is used; glosses are English (`'en'` at every call site).

| API | Behaviour |
| --- | --- |
| `getDb()` | Creates `JpdictIdb`, awaits `ready`, subscribes `syncState`. Memoises success only, so a failed open (iOS storage pressure, a versionchange) retries next call. |
| `isDictReady()` | Fast path `dict.state === 'ok'`, else `getDb()` + `words.state`. Never throws (tap path). |
| `downloadDictionary(lang)` | Every caller shares one promise, because jpdict-idb silently ignores an overlapping `updateWithRetry` and keeps the first call's callbacks. A repeat call while a retry is queued re-issues with `updateNow: true`. `OfflineError` or a scheduled retry leaves the promise pending with `dict.error` set; a permanent error or `AbortError` rejects. Completion calls `clearLookupCache()`. |
| `cacheIpadic()` | `cache.add`s each `ipadicUrls()` entry missing from `IPADIC_CACHE` (compressed bytes only; no trie). `false` if any failed or there is no Cache API (non-secure LAN origin). |
| `downloadAndCacheDictionary(lang)` | Shelf: download → `cacheIpadic`, with `dict.warming` set for the second step. |
| `downloadAndWarmDictionary(lang)` | Card: the same, then `warmupLookup()`; `warming` stays set until kuromoji is built. |

`dict` store: `{ state: 'init'|'empty'|'ok'|'unavailable', updating, progress, warming,
error? }`. A module `retrying` flag keeps `updating` true through the `'idle'` jpdict-idb
reports between a failed attempt and its retry.

| `dictPhase()` | Condition (in order) |
| --- | --- |
| `'retrying'` | `updating && error` |
| `'downloading'` | `updating` |
| `'preparing'` | `warming` |
| `'ready'` | `state === 'ok'` |
| `'checking'` | `state === 'init'` |
| `'unavailable'` | `state === 'unavailable'` |
| `'missing'` | otherwise (`'empty'`, or a failed download with `error`) |

Callers: `ShelfSettings` (`getDb()` on mount, `cacheIpadic()` if installed, the Download
button); `main.ts` (idle `cacheIpadic()` after 4 s, deletes the obsolete `kuromoji-ipadic`
cache); the dictionary card (`isDictReady()` per lookup, Download →
`downloadAndWarmDictionary('en')`).

**IPADIC offline caching.** The workbox route `/kuromoji/dict/*.dat.gz` is `CacheFirst` into
`kuromoji-ipadic-v2` with **no `expiration`** (not even `maxEntries`): the dict is
all-or-nothing and a partial cache builds no trie. `**/kuromoji/**` is excluded from the
precache. `IPADIC_CACHE` must equal that `cacheName`, and `IPADIC_FILES` must equal `STAGED` in
the staging script. Rename the cache when the dict contents change and delete the old name in
`main.ts`.

## 8. Card (`DictionaryPopup.svelte`)

Props: `open`, `anchor` (top-window rect of the glyph or matched word), `vertical`,
`loading`, `needsDownload`, `result`, `highlighted`, `translation`, `translationOpen`,
`onclose`, `ondownload`, `ontogglehighlight`, `ontoggletranslation`.

| State | Renders |
| --- | --- |
| download needed, or downloading with no result | By `dictPhase()`: progress, retry message, "Preparing…" (`preparing`/`ready`/`checking`: never re-offer Download), "unavailable", else **Download dictionary** + `dict.error` (compact when the unit has a translation). jpdict-idb reports 'ok' early, so an empty answer mid-download shows progress, not "No match". |
| `result` | Per entry: reason chips, headword, reading (unless `kanaOnly`), pitch, senses. While `loading` a re-targeted result stays visible, dimmed. |
| `loading`, no result | Skeleton, shown only after 150 ms. |
| else | "No dictionary match." |

Below the body: the **Translation** section when `translation` is set (the unit's English,
horizontal in every writing mode; "Show translation" collapsed), then a **Highlight / Remove
highlight** toggle when there is a real match. The `{#each}` key is
`entry.id ?? headword + reading + ':' + i`, because JMdict homographs share headword +
reading (度) and a duplicate key breaks Svelte.

## 9. Tests (`npm test`)

| File | Covers |
| --- | --- |
| `deinflect.test.ts` | Plain forms among candidates (食べていました → 食べる, 美しかった → 美しい, …). |
| `extract.test.ts` | Fake DOM with per-character rects: mid-glyph and end-of-node correction, node crossing, furigana → base, blank ⇒ `null`, non-word gate, run caps, vertical slack, block / `<br>` / ・ boundaries, English. |
| `segment.test.ts` | Build gating/retry, `tokenSpanAt` per-sentence offsets (fake tokenizer). |
| `segment.golden.test.ts` | Runs the staging script into a temp dir; stock `tokenize()` and the lean loader + `tokenSpans` give identical boundaries over `__fixtures__/corpus-ja.txt` and 5,000 seeded random strings; no `tid_pos`; 11 character classes. |
| `lookup.test.ts` | Token vs. greedy paths, `settleSegmenter`, bounds, `candidateMatches`, merging and ranking, `toEntry`, `ready` at decision time, `warmup`. Add a case for any new ranking rule. |
| `lookup.worker.test.ts` | Protocol: `ready`, `ping`, `warmup`, thrown lookup ⇒ uncacheable `null`. |
| `lookupClient.test.ts` | Lazy construction, ready-only cache surviving dispose, `pingLookup`, timeouts dropping the worker. |
| `dictdb.test.ts` | Shared download, transient ⇒ `'retrying'`, `updateNow`, permanent rejection, `cacheIpadic`, shelf vs. card flows. |

## 10. Extending

- **Kanji / names:** `getKanji` / `getNames`, plus the `'kanji'` / `'names'` series in the
  download flow and new render paths.
- **Pitch contour:** `DictEntry.pitch` + `countMora` / `moraSubstring` from normal-jp.
- **Stricter deinflection gating:** extend `candidateMatches` toward 10ten's full WordType ↔
  POS map.
- **Self-hosted data:** mirror `data.10ten.life` and point jpdict-idb at it.

Don't put a NUL byte in these sources: git then treats the file as binary.
