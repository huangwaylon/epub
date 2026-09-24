# Japanese dictionary & text-parsing subsystem

Tsuzuri's headline feature: **tap a word in the reader → an offline dictionary entry with
deinflection**. A tap extracts the Japanese run around it, segments it to the word under the
tap, reverse-conjugates ("deinflects") candidate forms, looks them up in a JMdict-backed
IndexedDB, and renders the longest match in a popup. Everything after the one-time dictionary
download is fully offline.

All code lives in `src/services/jp/` plus Svelte glue in `src/lib/reader/`. Signatures below
were read from source. Audience: engineers/agents extending the pipeline.

---

## 1. Overview

Two engines combine so tapping *any* character of a word resolves the whole word: **kuromoji**
(MeCab-style IPADIC morphological analysis) finds word boundaries, and the **10ten** matcher
(normalize → deinflect → JMdict lookup) supplies the glosses (IPADIC has no English).

| Stage | File | Thread | Role |
| --- | --- | --- | --- |
| Extract | `extract.ts` | main | Resolves the glyph under the tap point from measured glyph boxes, then the contiguous Japanese run around it (both sides, ruby-skipped) + the tap offset within it. |
| Segment | `segment.ts` | worker | kuromoji's lattice + Viterbi best path over the run; returns the span of the token containing the tap (boundaries only — no feature strings). |
| Match | `lookup.ts` | worker | From the token start, longest-first: normalize → deinflect → `getWords` (JMdict); every candidate at the winning length is merged. |
| Deinflect | `deinflect.ts` | worker | Pure string → candidate base forms (GPL; see §2). |
| DB lifecycle | `dictdb.ts` | main | Owns the shared `JpdictIdb`, drives the JMdict download (deduped, retry-tolerant), pre-caches IPADIC (`cacheIpadic`), syncs the `dict` store. |

Accuracy has **two** independent failure modes, and both are documented as first-class
concerns: resolving the wrong *character* (§6 — geometry, main thread) and resolving the
wrong *word span* from the right character (§4 — segmentation, worker).

**The resolution contract** (the authoritative statement; §4 details it): `lookupAt(text,
tapOffset)` first gives a still-building kuromoji a **bounded wait** (`settleSegmenter`,
`SEGMENTER_WAIT_MS = 1200`), then asks it for the **start of the token containing the tap**
(`tokenSpanAt`) and runs `matchAt` from that start — so tapping 決 or 心 in 決心 both resolve
決心, and a JMdict compound *longer* than the IPADIC token is still found. If the build is
slower than that wait, has already failed, or split a word JMdict lemmatizes differently, it
falls back to **greedy leftmost-covering**: scan candidate starts left-to-right and take the
**first** (leftmost) whose match span covers the tap. At a single start, `matchAt` is
**longest-first** (greedy longest-match). So the two tie-breaks differ: *within* one start,
longest wins; *across* the greedy fallback's starts, leftmost wins.

The heavy pipeline runs in a **Web Worker** (`lookup.worker.ts`, fronted by `lookupClient.ts`)
so a tap never janks a page-turn; only the DOM parts (`extractTextAt`/`rangeForSpan`) stay on
the main thread. Reactive UI state is the `dict` store (`src/stores/dict.svelte.ts`); the popup
is `DictionaryPopup.svelte`; tap wiring is in `Reader.svelte`.

---

## 2. Packages & licensing

| Package | Role | Key exports |
| --- | --- | --- |
| `@birchill/jpdict-idb` | Downloads JMdict into IndexedDB and queries it. | `JpdictIdb`, `getWords`, `updateWithRetry`, `cancelUpdateWithRetry`; types `DataSeriesState`, `UpdateState` |
| `@birchill/normal-jp` | Japanese text normalization. | `toNormalized`, `kanaToHiragana` |
| `@sglkc/kuromoji` | MeCab/IPADIC morphological analyzer (segmentation). Apache-2.0; ships the IPADIC dict as 12 `*.dat.gz` (~19 MB compressed, ≈95 MB inflated). Tsuzuri stages a **trimmed 11-file set — 11.3 MB compressed (11,850,202 bytes), 27.4 MB inflated** — and loads it into **≈30 MB resident** (§4 "Memory"). | `builder` (+ internals `Tokenizer#getLattice`, `viterbi_searcher`) |

The Birchill packages are by the 10ten author; all three are permissively licensed.

### The vendored deinflection engine is GPL — so the whole app is GPL

`deinflect.ts` is **copied verbatim** from
[`10ten-ja-reader`](https://github.com/birchill/10ten-ja-reader) (`src/background/deinflect.ts`),
licensed **GPL-3.0-or-later**; the license text is vendored at `src/services/jp/LICENSE-10ten`.
Because GPL is copyleft and this file is statically linked into the bundle, **the entire Tsuzuri
app is effectively GPL-3.0-or-later**. To relicense, `deinflect.ts` (the rule data + reverse
algorithm) must be **reimplemented from scratch**.

The only edit, per its header: `const enum` → `enum`, so values survive esbuild's
isolated-modules transpilation. Under `isolatedModules` esbuild can't inline `const enum`
members across files; a plain `enum` emits a runtime object, so `Reason.*` / `WordType.*` are
available to `lookup.ts` at runtime.

---

## 3. Dictionary DB lifecycle (`dictdb.ts`)

`dictdb.ts` owns the single shared `JpdictIdb` instance and the offline-readiness of the whole
feature, which needs **two** independent data sets: JMdict (glosses, IndexedDB, downloaded by
jpdict-idb) and IPADIC (kuromoji's boundary dictionary, static files in the Cache API). It runs
on the **main thread**; the worker opens its own read-only connection to the same `jpdict`
IndexedDB and fetches IPADIC through the service worker.

**Public API** (what the shelf, reader and popup call):

| Call | Behaviour |
| --- | --- |
| `getDb()` | Memoizes the **success only**: constructs `JpdictIdb`, awaits `ready`, registers `addChangeListener(syncState)`, `syncState()`. On rejection it **clears `initPromise` and rethrows** — caching a rejected init would make every later `isDictReady()` (hence every tap) reject on that stale promise and the popup spin forever. Call on mount to initialise the status readout. |
| `isDictReady()` | `true` if `dict.state === 'ok'` (fast path, no IndexedDB round-trip), else `getDb()` + `words.state === 'ok'`. **Never throws** (tap hot path) — returns `false`. |
| `downloadDictionary(lang='en')` | JMdict only; resolves when complete. **Deduped** (one shared in-flight promise) and **retry-tolerant** (below). |
| `cacheIpadic()` | Writes every staged IPADIC URL (`ipadicUrls()`, base-aware via `import.meta.env.BASE_URL`) into Cache API cache **`kuromoji-ipadic-v2`** — the same cache the SW's `CacheFirst` route reads — skipping files already cached. Compressed bytes only; no worker, no trie, nothing resident. `Promise<boolean>`: `false` if any file failed or there is no Cache API (non-secure dev origin); a later call fills in the rest. |
| `isIpadicCached()` | Whether all IPADIC files are in that cache. |
| `downloadAndCacheDictionary(lang)` | **Shelf** "Download": `downloadDictionary` → `cacheIpadic` (`dict.warming` true during the second step). Offline-capable without building the trie. |
| `downloadAndWarmDictionary(lang)` | **Reader/popup** "Download" (a word is waiting): as above, then `warmupLookup()` so the re-run lookup is morphological; `warming` stays true until the segmenter is up. |
| `warmupLookup()` | Re-exported from `lookupClient` (§7) — build kuromoji now (book open). |
| `dictPhase()` | One reactive status for UI copy (below). |

`updateWithRetry` returns **`void`** — completion/failure/progress arrive only via its callbacks
and the change listener, so `downloadDictionary` bridges them to a promise. Two jpdict-idb
behaviours shape that bridge:

- **Overlapping calls are silently dropped.** A second `updateWithRetry` for the same series
  logs "re-using existing invocation" and keeps the *first* call's callbacks, so an independent
  second promise would never settle. Hence the shared module-level `download` promise; calling
  again while a retry is queued re-issues `updateWithRetry({ updateNow: true })` with the same
  callbacks, which runs a backoff retry immediately (offline it keeps waiting for `online`).
- **Transient failures retry by themselves.** `OfflineError` (it listens for `online`) and a
  `DownloadError` for which it scheduled a backoff (`nextRetry` set) are **not** rejections: the
  promise stays pending, `dict.updating` stays true (a module `retrying` flag overrides the
  `'idle'` jpdict-idb reports between attempts), and `dict.error` explains the wait
  ("Offline — the download will resume…", "Connection problem — retrying in 5s…").
  `syncState` clears the message as soon as the retry actually starts. Only a permanent error
  (no retry scheduled) or an `AbortError` rejects.

`dictPhase(): DictPhase` — derived purely from the `dict` store, so it is reactive in a
template / `$derived`:

| Phase | Condition | UI |
| --- | --- | --- |
| `'checking'` | `state === 'init'` | status pending |
| `'missing'` | not installed / permanent failure (`dict.error`) | offer **Download** |
| `'downloading'` | `updating`, no error | progress bar (`dict.progress`) |
| `'retrying'` | `updating` **and** `dict.error` | show the message; offer "Retry now", **not** Download |
| `'preparing'` | `warming` | "Preparing…" (IPADIC caching / kuromoji build) |
| `'ready'` | `state === 'ok'` | — |
| `'unavailable'` | IndexedDB couldn't open | — |

It fetches version metadata + data files from the **`data.10ten.life` CDN**, parses them, and
writes records into jpdict-idb's IndexedDB store. After success all lookups are offline.

### State sync

Only the `words` series is used (`kanji`/`names`/`radicals` are ignored). `syncState()`:

```ts
dict.state = db.words.state                  // 'init' | 'empty' | 'ok' | 'unavailable'
const u = db.words.updateState
if (u.type === 'updating') { dict.updating = true; dict.progress = u.totalProgress ?? 0 }
else dict.updating = u.type === 'checking' || retrying   // 'idle' mid-retry still counts
```

`UpdateState` is a tagged union — `'idle'` / `'checking'` (+ `series`, `lastCheck`) / `'updating'`
(+ `series`, `version`, `fileProgress`, `totalProgress`, `lastCheck`). Lookups work only in
`DataSeriesState === 'ok'`.

### The `dict` store (`src/stores/dict.svelte.ts`)

A Svelte 5 `$state` rune consumed by `DictionaryPopup.svelte` and `ShelfSettings.svelte`:

```ts
state: 'init' | 'empty' | 'ok' | 'unavailable'
updating: boolean    // JMdict download/check in progress
progress: number     // 0..1 download progress
warming: boolean     // IPADIC being cached (cacheIpadic) and/or kuromoji built (downloadAndWarm…)
error?: string       // permanent failure, or — while `updating` — the transient retry message
```

---

## 4. The lookup pipeline (`lookup.ts`, in the worker)

### Result types (`lookupTypes.ts`)

Kept dependency-free so the main thread imports them with `import type` without pulling in the
heavy engine. All fields added since the first version are **optional**, so older renderers keep
working.

```ts
interface Sense {
  pos: string[]; glosses: string[]
  misc?: string[]      // labelled JMdict misc: 'usually kana', 'colloquial', 'honorific', …
  matched?: boolean    // applies to the matched spelling/reading (matched senses come first)
}
interface DictEntry {
  id?: number          // JMdict id — unique; a good {#each} key
  headword; reading; pitch?: number; kanaOnly: boolean; senses: Sense[]
  reasons?: string[]   // this entry's deinflection reasons (entries in one result can differ)
}
interface LookupResult { matchStart; matchLength; reasons: string[] /* = entries[0].reasons */; entries }
```

`matchStart` + `matchLength` give the matched span `[matchStart, matchStart + matchLength)` in
the text passed to `lookupAt`, which the reader maps back to a DOM range to auto-highlight the
word (see [reader-engine.md](reader-engine.md)). Because one result can now mix a deinflected
verb and a surface noun (した → する *past*, 下), render **`entry.reasons` per entry**; the
top-level `reasons` is kept only for backward compatibility.

### `matchAt(window, queryWords, minLen = 1, tokenLen?)` — longest match at one position

Longest dictionary form starting at the **beginning** of `window`:

```ts
const MAX_WINDOW = 12, MAX_RESULTS = 8 /* per getWords */, MAX_ENTRIES = 10 /* per result */
```

1. **Window cap.** `len` iterates `min(window.length, MAX_WINDOW)` down to `minLen`
   (longest-first ⇒ greedy longest-match). If `minLen > limit` it returns `null` **without
   querying at all**.
2. **Normalize.** `toNormalized(sub)` returns a **tuple** `[normalized, inputLengths]`; only the
   string is used (`const [normalized] = …`). Skip the length if empty.
3. **Deinflect.** `deinflect(normalized)` → `CandidateWord[]` (the surface form is always #0).
4. **Fire all queries up front.** Every candidate across every length is passed to `queryWords`
   *without awaiting*, so the IndexedDB reads run concurrently instead of as a serial await chain.
5. **Walk longest-first; at the first length with any hit, merge every candidate.** For each
   candidate, keep the words passing `candidateMatches`, **dedupe by entry `id`** (the first —
   least-inflected — candidate to reach an entry wins), and give each entry its own `reasons`.
   Surface-form entries are listed first, **unless the length exceeds `tokenLen`** (the matched
   span runs past the end of the kuromoji token it starts in), in which case deinflected entries
   lead. Returns `null` if nothing matched.

<a id="kana-verbs"></a>
**Why merge, and why the token rule.** Taking only the *first* candidate with a hit made kana
verbs resolve to nouns: した is both the surface of 下/舌 and the past of する, いた of 板 and いる,
きた of 北 and 来る — and the surface is always candidate #0. IPADIC tells them apart: 勉強した is
勉強|し|た, so a 2-char match from し *crosses* a token boundary ⇒ verb + auxiliary ⇒ する first;
机のした keeps した as one noun token ⇒ 下 first. Both readings stay in the card either way.

<a id="window-cap"></a>
**Why `MAX_WINDOW = 12`** (it was 16). Each extra length costs one deinflection pass **and** a
`getWords` per candidate — and `getWords` opens three IndexedDB transactions internally — so the
tail of the range is the most expensive part of a tap and the least likely to pay off. Measured
over the ~137k characters of プロローグ〜エピローグ in また、同じ夢を見ていた (124,298 tap
positions): the sub-window from a kuromoji token start averages **8.8** chars; the longest IPADIC
lexicon entry occurring *anywhere* in the book is **8** chars; and of the **110,949** distinct
13–16-char spans a tap would otherwise probe, **zero** are a single known dictionary unit — they
are all multi-clause fragments (のかもしれないと思いました). 12 keeps a comfortable margin over
the 8-char observed maximum, for JMdict compounds that IPADIC splits, while cutting the warm
token path from ~21 to ~17 distinct queried terms per tap and the greedy fallback from ~204 to
~100.

<a id="minlen"></a>
**`minLen` is a lossless bound, not a heuristic.** `lookupAt` only ever keeps a match that
*spans the tap*, so from a start `s` with the tap at `t` no length `≤ t − s` can be used; probing
them is pure IndexedDB waste. Both call sites pass `tapOffset − start + 1`. For the same reason
the greedy scan starts at `max(0, tapOffset − MAX_WINDOW + 1)` instead of 0 — a start further
left cannot reach the tap within the window cap.

**`queryWords` = `makeQueryCache()`** wraps `getWords(term, { matchType: 'exact', limit: 8 })` in
a `Map`, caching the **promise** (so parallel probes for the same term collapse onto one read)
and `.catch(() => [])` (so a flaky IndexedDB read degrades to "no match for this candidate"
rather than aborting the whole tap). One cache is shared across the whole tap — every length and
start.

### `resolveLookup(text, tapOffset)` / `lookupAt` — segment to the word under the tap

`resolveLookup` returns `{ result: LookupResult | null, ready: boolean }`; `lookupAt` is the same
minus `ready`. The worker uses `resolveLookup`. Bounds-checks `tapOffset`, then:

- **Wait (briefly) for the segmenter — `settleSegmenter()`.** A tap fired while the tokenizer is
  still building would otherwise fall straight into the greedy fallback and return a
  plausible-but-wrong span — and because the worker is shed after a long backgrounding and on
  reader exit (§7), that window recurs. The build promise is folded to a non-rejecting one
  *before* the `Promise.race`, so a failure arriving after the timeout can't surface as an
  unhandled rejection; the timer is always cleared. A build slower than `SEGMENTER_WAIT_MS`
  (1200ms) still degrades to greedy.
- **`segmenterUnavailable` latch.** Once a build has failed (typically: offline with IPADIC not
  cached), taps stop *paying* the wait but still kick off a background `ensureSegmenter()` retry.
  `warmup()` clears the latch.
- **`ready` is captured at decision time** — `segmenterReady()` read synchronously right after
  the settle, together with `tokenSpanAt`, *before* any IndexedDB await. Reading it after the
  lookup (as the worker once did) tagged a greedy answer as authoritative whenever the build
  finished mid-query, and the client then cached the wrong word for the session.
- **kuromoji path.** `tokenSpanAt(text, tapOffset)` → `{start, end}` (or `null`). If non-null,
  `matchAt(text.slice(start), queryWords, tapOffset − start + 1, end − start)` — the `minLen` *is*
  the "must span the tap" test, `tokenLen` drives the [kana-verb ordering](#kana-verbs), and the
  result is rebased to `matchStart = start`.
- **Greedy fallback.** Every start from `max(0, tapOffset − MAX_WINDOW + 1)` to `tapOffset` is
  probed **concurrently** (sharing the query cache), then read **in left-to-right order**, so the
  leftmost covering match still wins while the latency is one round of reads, not a serial scan.
- **No result cache in the worker.** The old `RESULT_LRU` died with the worker and duplicated the
  client's `RESULT_CACHE` (§7), which is now the only one.

### `warmup()` / `isSegmenterReady()`

`warmup()` — fires a one-row `getWords('の', { limit: 1 })` (opens the worker's IndexedDB
connection and warms the index, so the first tap doesn't pay it) in parallel with
`await ensureSegmenter()`; `Promise<boolean>` (`true` once built), clears `segmenterUnavailable`
on success. Exposed as `warmupLookup()` (§7).

`isSegmenterReady()` — synchronous "is the tokenizer built"; rides the worker's `ping` reply.

### Segmentation — `segment.ts` (kuromoji, boundaries only)

- **`ensureSegmenter()`** — builds once via `kuromoji.builder({ dicPath: IPADIC_DIR })`
  (`${BASE_URL}kuromoji/dict`, from `ipadic.ts`). On failure it **rejects and clears
  `buildPromise`** so a later tap retries.
- **`segmenterReady()`** — synchronous "is it built".
- **`tokenSpans(tok, text)`** — splits after each 、/。 (like kuromoji's `splitByPunctuation`),
  then for each sentence `tok.viterbi_searcher.search(tok.getLattice(sentence))` and maps every
  best-path node to `{ start: offset + start_pos − 1, end: start + surface_form.length }`. This is
  **exactly** the boundary set `tokenize()` produces (golden-tested, §9) but never calls
  `getFeatures`, so the POS/reading strings (`tid_pos.dat`, ≈40 MB inflated) are not needed at
  all. Nothing in the lookup used them — JMdict supplies POS and readings. (One deliberate
  divergence: `tokenize` offsets each later sentence by the *start* of the previous sentence's
  last token, correct only when that token is one character; `tokenSpans` uses the real offset.
  Runs from `extract.ts` never contain 、/。, so real taps are one sentence.)
- **`tokenSpanAt(text, tapOffset)`** — the span containing the tap, or `null` (not built,
  segmentation threw, or no covering token).

<a id="kuromoji-memory"></a>
### Memory: trimmed dict + lean loader

Stock kuromoji held **~175 MB** resident per build (≈95 MB of inflated typed arrays plus ~75 MB of
JS heap) — the single biggest reason iOS killed the PWA. Now **≈33 MB** (measured in Node after
GC: heap 6.5 MB + ArrayBuffers 26.5 MB; stock: heap 76.5 MB + ArrayBuffers 203 MB, of which Node's
gunzip path over-counts — the browser figure is ~175 MB). Three independent, lossless changes:

1. **Trimmed files** (`scripts/copy-kuromoji-dict.mjs`). kuromoji's builder wrote several files
   straight out of fixed 10 MB / 1 MB `ByteBuffer`s, so `tid` (10 MB → 3.9 MB), `unk`, `unk_pos`
   (10 MB → ~1.6 KB each), `unk_map`, `unk_invoke` (1 MB → 153 B) were mostly zero padding. The
   script cuts each to its **structural** length (max `tid_map`/`unk_map` value + 10 bytes per
   token entry; the furthest feature string an unknown entry points at; the exact 11
   character-class records), asserts everything past the cut is zero, spot-checks every token's
   costs, and re-gzips (level 9). `ByteBuffer` returns 0 for reads past the end, so padding and
   absence are indistinguishable. `unk_invoke` matters beyond bytes: `InvokeDefinitionMap.load`
   loops to the end of the buffer, so its padding became **~150k bogus `CharacterClass`
   objects** (now 11). `base`, `check`, `cc`, `unk_char`, `unk_compat` (fixed-size, directly
   indexed, read as Int32/Int16/Uint32 views) and `tid_map` are copied byte-for-byte.
   `tid_pos.dat.gz` is **not staged**, and a stale copy is deleted. A `.staged.json` stamp
   (source sizes + `TRIM_VERSION`) skips the ~2.5 s regeneration when current.
2. **`kuromojiLoader.cjs`** (aliased over kuromoji's loader in `vite.config.ts`):
   - gunzip with the platform **`DecompressionStream('gzip')`** — only when the bytes carry the
     gzip magic `0x1f 0x8b`, else used as-is (servers that set `Content-Encoding: gzip`, e.g.
     Vite dev, hand over already-inflated bytes; the stock loader hung there). No JS inflate
     library ships (fflate is now a devDependency, used only by `scripts/make-test-epub.mjs`;
     foliate keeps its own vendored copy for MOBI).
   - answers `tid_pos.dat.gz` with an empty buffer **without fetching**.
   - replaces `loadTargetMap` **per instance** (never the shared prototype) with flat arrays:
     `Int32Array` offsets (by trie id) + values, behind a `Proxy` whose `target_map[id]` returns a
     `subarray` — exactly how `ViterbiBuilder#build` reads it (`.length`, `[i]`). Stock built one
     JS Array per trie id (~326k). Uses the header count, so padding is never walked.
   - calls kuromoji's callback outside the promise chain, rethrowing a throw on a fresh task so it
     surfaces as a worker `error` (→ client replaces the worker) instead of a silent hang.
3. **Boundaries from the lattice** (`tokenSpans` above) — what makes dropping `tid_pos` safe.

| | Stock | Now |
| --- | --- | --- |
| Files fetched | 12 | 11 (no `tid_pos`) |
| Wire (gzip) | ~19 MB | **11.3 MB** (11,850,202 B) |
| Inflated | 95.6 MB | **27.4 MB** |
| Resident after build | ~175 MB | **≈30–33 MB** |
| Inflate time (Node 26, dev Mac) | fflate 275–350 ms (all 12) | `DecompressionStream` **23 ms** parallel / 62 ms serial (fflate on the trimmed set: 130 ms) |
| Worker warmup, desktop Chrome, localhost, cold | — | **88 ms** (a `ping` sent during the build answered in ~5 ms) |

### Offline caching of the IPADIC dict

The workbox config (`vite.config.ts`) runtime-caches `/kuromoji/dict/*.dat.gz` with `CacheFirst`
into **`kuromoji-ipadic-v2`** (`cacheableResponse: { statuses: [0, 200] }`), with **no
`expiration` block at all** — no age purge *and* no `maxEntries` cap. It's build-versioned
immutable data, and the dict is an all-or-nothing set: an LRU cap crossed by a future shard would
evict one file and leave a **partial** dict, the trie build then fails, and tap-to-define degrades
to greedy segmentation with no way to refetch. `clientsClaim: true` lets a fresh SW control the
already-loaded page; `globIgnores` keeps `**/kuromoji/**` out of the install precache. The cache
name is shared with `IPADIC_CACHE` in `ipadic.ts` — **they must match exactly**. (The `-v2`
suffix retires caches holding the old untrimmed files, which the new loader could still read.)

The cache is filled **two** ways: `cacheIpadic()` writes it directly from the main thread
(shelf download — no worker, no trie; also topped up on Settings open when JMdict is already
installed), and any worker build fetches through the SW. Either way, offline segmentation no
longer depends on having built the trie while online.

### `candidateMatches` — the POS heuristic

```ts
const INFLECTABLE = /^(v1|v5|vk|vs|vz|vn|vr|adj-i|aux-v)/
function candidateMatches(word, cand) {
  if (!cand.reasonChains.length) return true              // surface form — always accepted
  return (word.s ?? []).flatMap(s => s.pos ?? []).some(p => INFLECTABLE.test(p))
}
```

A surface candidate (empty `reasonChains`, e.g. a noun 猫) is always accepted. A **deinflected**
candidate is valid only if the entry has an inflectable POS, preventing e.g. treating a noun as a
deinflected verb. **Coarse**: it only checks the entry *can* inflect, not that its class matches
`cand.type` — see §10.

> `candidateMatches`/`toEntry` operate on raw `getWords` records typed `any`, reading `w.id`,
> `w.k`, `w.r`, `w.s`, `s.pos`/`s.g`/`s.misc` and the `match`/`matchRange` flags directly.

### `toEntry(w, reasons)` — honour jpdict-idb's match metadata

`getWords` flags what the search hit: `k[i].matchRange` / `r[i].matchRange` mark the spelling
searched; `match` marks every form that goes with it (a kanji hit flags its readings, a kana hit
flags the kanji it is a reading of); `s[i].match` marks the senses that apply.

- **Kanji hit** → headword = that spelling (想う, not the entry's first form 思う); reading = the
  first flagged reading.
- **Kana hit** → reading = the hit. Headword = the kana if the word has no kanji **or is usually
  kana** (≥ half the matched senses tagged `uk`, e.g. する, not 為る); otherwise the first flagged
  kanji (した → 下).
- `kanaOnly = !k.length || headword === reading`; `pitch` from the chosen reading.
- Senses: matched first (stable), each with `matched` and labelled `misc`.
- Records without match metadata (the tests' fakes) fall back to the old behaviour.

### Helper tables

| Symbol | Role |
| --- | --- |
| `REASON_LABELS` | `Partial<Record<Reason, string>>` — `Reason` enum → display string (e.g. `PolitePast → 'polite past'`). Unmapped reasons are dropped. |
| `POS_LABELS` + `posLabel(code)` | JMdict POS → human string. `posLabel` falls back by prefix: `v5*`→"godan verb", `adj*`→"adjective", `v*`→"verb", else raw code. |
| `MISC_LABELS` | JMdict `misc` → label (`uk` → "usually kana", `col`, `hon`, `hum`, `arch`, …); unlisted codes pass through raw. |
| `reasonsToLabels(chains)` | Maps the **first** chain (`chains[0]`) through `REASON_LABELS`, drops empties; `[]` for surface forms. |
| `readingAccent(a)` | Pitch-accent mora index from a reading-meta `a` field (a `number`, or `a[0].i` of an `Accent[]`). |

---

## 5. The deinflection engine (`deinflect.ts`)

A self-contained, rule-based **reverse conjugator**. Its only import is `kanaToHiragana`; it has
no dependency on the dictionary (pure string → candidates). The unit tests (§8) are the
authoritative spec.

```ts
export enum Reason { PolitePastNegative, …, Irregular }   // human-readable inflection reasons
export { Type as WordType }                                 // bitfield enum
export interface CandidateWord { word: string; reasonChains: Reason[][]; type: number }
export function deinflect(word: string): CandidateWord[]
export const deinflectL10NKeys: { [key: number]: string }  // Reason → i18n key (10ten leftover; unused)
```

- **`Reason`** — past, negative, potential, passive, causative, polite, `-te`, `-tai`,
  volitional, masu-stem, … A `reasonChains` entry is an *ordered* list, outermost inflection first.
- **`WordType` (`Type`) is a bitfield.** Final types: `IchidanVerb (1<<0)`, `GodanVerb (1<<1)`,
  `IAdj (1<<2)`, `KuruVerb (1<<3)`, `SuruVerb (1<<4)`, `SpecialSuruVerb (1<<5)`, `NounVS (1<<6)`.
  Intermediate types: `Initial (1<<7)` (original word), `TaTeStem (1<<8)`, `DaDeStem (1<<9)`,
  `MasuStem (1<<10)`, `IrrealisStem (1<<11)`.
- **Rule data** (`deinflectRuleData`) is a large `[from, to, fromType, toType, reasons]` table
  (each rule precomputes a `reasonsSet` when groups are assembled, to avoid per-iteration `Set`
  allocation). A rule rewrites suffix `from`→`to` only when the candidate's type intersects its
  masks. Intermediate stem types constrain *when* a rule fires — e.g. the `ます`→`` rule fires only
  against a `MasuStem`, so `食べろます` isn't misparsed as "imperative < polite". Rules are grouped by
  `from` length and applied longest-suffix-first (`getDeinflectRuleGroups`).
- **Algorithm.** `deinflect` seeds with the original word (type =
  `0xffff ^ (TaTeStem | DaDeStem | IrrealisStem)`, `reasonChains = []`) and iterates a worklist,
  applying matching rules and accumulating reason chains. Ichidan verbs have a single stem, so the
  stem→plain expansion is done programmatically (a masu-stem of an ichidan verb isn't deinflected
  further). Output is the full set of plausible base forms; `lookup.ts` decides which are real.

---

## 6. Word extraction (`extract.ts`, main thread)

```ts
interface CharPosition { node: Text; offset: number }      // DOM location of one char
interface Extracted { text: string; tapOffset: number; positions: CharPosition[] }
const MAX_BEFORE = 12, MAX_AFTER = 16                       // word-chars gathered each side

export function extractTextAt(doc, x, y): Extracted | null
export function rangeForSpan(doc, positions, start, end): Range | null
```

Two jobs: **resolve the glyph under the point**, then **gather that word's
neighbourhood**. Internal helpers: `caretPosition`, `charRect`, `hitDistance`,
`glyphSlack`, `rubyBaseHit`, `resolveGlyph`, `isInRuby`, `textWalker`, `siblingText`,
`trailingRun`, `leadingRun`, `blockOf`, `breakBetween`.

<a id="glyph-resolution"></a>
### Glyph resolution — `resolveGlyph(doc, x, y)`

*(Authoritative; reader-engine.md points here.)* **The caret is a seed, not an answer.**

`caretRangeFromPoint` / `caretPositionFromPoint` return the nearest caret **boundary**, not
the character containing the point: both WebKit (`offsetForPosition(…, includePartialGlyphs:
true)`) and Blink advance to the **next** character as soon as the point passes the current
glyph's mid-advance. Treating that offset as "the tapped glyph" mis-resolves the whole far
half of every glyph, and along the reading axis the error reads as *one character late* —
rightwards in 横書き, downwards in 縦書き — which is why aiming further back (left / up) used
to feel more accurate.

**Measured** — in **desktop Chrome** (2026-08-08) at iPad-landscape 1194×834, against a real
novel (また、同じ夢を見ていた): 1800 probe points over 120 visible glyphs, both writing modes,
driven through the DEV hook ([development.md](development.md) §6). Not yet re-measured on real
iOS — see [reader-engine.md](reader-engine.md)'s status block for what that leaves open.

| | Caret offset taken as the glyph | Geometric resolution |
| --- | --- | --- |
| Probes resolving the intended character | ~60% of each glyph's area | **100%** of base-text probes, both modes |
| Wrong word looked up | ~35% (far ~40% of each glyph → next char) | 0 |
| Dead taps (punctuation, or past the end of the text node ⇒ `null`) | ~5–13% | 0 |

End-to-end with the real dictionary: 18/18 near-edge and 18/18 far-edge taps produced the
correct word (the far-edge taps were ~60% wrong before). The only residual "mismatch" in the
harness was a furigana glyph correctly redirected to its base kanji (below).

So `resolveGlyph`:

1. **Seed.** `caretPosition(doc, x, y)` — `doc.caretRangeFromPoint` (WebKit/Chrome, returns a
   `Range`) first, else `doc.caretPositionFromPoint`; both via `doc as any` (TS lib types are
   unreliable) and both in `try/catch`, so a hostile coordinate or detached doc falls through
   to "no hit" instead of throwing out of the tap handler. Non-Text seed ⇒ `null`.
2. **Furigana redirect.** If the seed is inside `<rt>`/`<rp>`, hand off to `rubyBaseHit`
   (below) — the tap gets the *base* character, never the reading.
3. **Candidates.** The seed offset; the seed offset **− 1** (the mid-glyph correction, which
   also covers the caret snapping *past* the last character of the node); plus the adjacent
   text node when the seed sits on a node boundary (`offset <= 0` → previous node's last char,
   `offset >= data.length` → next node's first char, via `siblingText`, furigana skipped) — a
   kanji compound with ruby splits its base text, so node boundaries are common in Japanese
   EPUBs. Out-of-range candidates are dropped as they're pushed.
4. **Measure and pick.** For each candidate, `charRect` → `hitDistance`. **Exact containment
   wins immediately** (`distance === 0`); otherwise the nearest candidate still inside its
   slack wins. Nothing within slack ⇒ `null`, i.e. blank space, and the caller treats the tap
   as chrome-toggle / dismiss ([reader-engine.md](reader-engine.md) §8).

This is engine-independent — it corrects the mid-glyph rule, WebKit's line-snapping in
vertical writing modes, and the end-of-node case in one place — and costs a handful of
`getClientRects` calls. `pointOnGlyph`, the old boolean gate, no longer exists: its two
responsibilities are now `resolveGlyph` (*which* glyph) and `hitDistance` (*whether* a
near-miss counts).

**`charRect(doc, node, offset)`** — a `Range` over the single character, returning its
**largest-area** client rect. Two subtleties, both load-bearing:

- A one-character range normally has exactly one rect, but WebKit also emits a degenerate
  (zero-extent) rect at the **end of the previous line** for a range sitting at a line start —
  and in 縦書き the previous line is the column to the **right**, so accepting *any* rect would
  let a tap in one column validate a glyph in another. Zero-width/height rects are skipped and
  the largest remaining one wins.
- Per CSSOM-View the rect is the character's **font box** (ascent + descent × advance), **not**
  the line box, so it excludes the leading — which is exactly why `glyphSlack` adds half the
  leading itself.

**`hitDistance(rect, x, y, slack)`** — `0` when the point is inside the box, the px overflow
(`dx + dy`) when it is merely within `slack`, and `null` when it is outside the target
altogether.

**`glyphSlack(win, el)`** reads the parent's computed style. It only decides whether a
*near-miss* still counts; *which* glyph is chosen is settled geometrically above.

- **Cross axis** (line-stacking, carries the leading): grown by `(lineHeight − fontSize)/2 +
  MIN_HIT_SLACK` — half the leading plus a 6px floor — so the *whole* line/column pitch is
  tappable and each side reaches exactly the midpoint to the neighbour (full coverage, no
  overlap). `MIN_HIT_SLACK = 6` is the floor for solid-set text (line-height ≈ 1) and forgives
  a small near-miss just past the first/last glyph of a line.
- **Reading axis** (glyphs contiguous, no inter-word spaces): only `MIN_HIT_SLACK + fontSize ·
  READING_SLACK_EM` (0.15) — enough to forgive a near-miss without swallowing the blank at a
  column/line end.
- Vertical (縦書き) columns stack horizontally so the cross axis is *x*; horizontal writing
  stacks lines vertically so it's *y*. Any non-`horizontal-*` mode counts as vertical
  (vertical-rl/-lr, sideways-rl/-lr all stack lines horizontally). Missing view/element ⇒ flat
  floor on both axes.
- `leading = lineHeight − fontSize` assumes ~1em-square glyphs, which holds because lookups are
  gated to CJK/kana (`WORD_CHAR`). `line-height: normal` yields no numeric px, so it is
  approximated as `fontSize * 1.5`.
- **Don't let the slack balloon.** A page of Japanese is wall-to-wall glyphs, and the
  blank-space fall-through (chrome toggle / dismiss) depends on some taps missing every glyph.

**`rubyBaseHit(doc, node, x, y)`** — a tap that landed in furigana resolves to the nearest
character of the **base** text it annotates: walk up to the enclosing `<ruby>`, then scan every
non-`rt`/`rp` character inside it and keep the smallest `dx + dy` (no slack test — the tap has
already been established to be inside this ruby). In 縦書き the annotation column sits
immediately beside the base within the same line box (in 横書き, immediately above it), so a tap
aimed at the base easily lands in the reading; looking up the reading is both wrong *and* the
reason tapping felt misaligned, because the reader compensates by aiming away from the
annotation. Ruby bases are one to a few characters, so the scan is trivial. Previously
`isInRuby` was applied only to the TreeWalker filter — never to the caret result — so the
reading itself was looked up.

### `extractTextAt(doc, x, y)`

1. **`resolveGlyph`** (above). `null` ⇒ blank space (margin, inter-column gap, past the end of a
   line) ⇒ the caller toggles chrome / dismisses instead of defining.
2. **Tapped-char gate.** If the resolved character isn't a word char, return `null`.
   `WORD_CHAR = /[\u3040-\u30FA\u30FC-\u30FF\u3005-\u3007\u3400-\u9FFF\uF900-\uFAFF]/` —
   hiragana + katakana **except ・ (U+30FB)**, which separates words (ジョン・スミス: a tap on ス
   now resolves スミス, not the whole name); 々 〆 〇 (U+3005–3007: iteration mark, shime as in
   〆切, ideographic zero as in 二〇二四年); CJK Ext-A + Unified; CJK Compatibility Ideographs.
   Written with `\u` escapes on purpose: the compat-block start glyph U+F900 is visually
   identical to CJK-Unified U+8C48, and a retyped U+8C48 would span the UTF-16 surrogate range.
   The run iterates per UTF-16 unit, so astral CJK (Ext-B+) is out of scope.
3. **TreeWalker over text nodes** (`textWalker`) rejecting ruby via `isInRuby` (`acceptNode`
   FILTER_REJECT/ACCEPT). The same walker factory backs `siblingText`, so candidate discovery
   and run collection agree on what counts as text.
4. **`isInRuby(node)`** — walks ancestors; `true` if any is `<rt>`/`<rp>`. Compares
   `el.tagName.toUpperCase()` because EPUB content is XHTML where `tagName` is **lowercase**
   (`"rt"`) — see §11.
5. **Collect the run both sides.** Forward from the tapped char (capped at `MAX_AFTER`) and
   backward (the trailing word-char run before it, capped at `MAX_BEFORE`), each with its
   `{node, offset}`. Both loops are capped *during* the scan so a long single-`Text`-node
   paragraph never allocates a `CharPosition` per char only to discard it. Punctuation/space/latin
   bound the run, keeping it in one clause — and so do **line breaks**: stepping from one text
   node to the next stops when `breakBetween(doc, a, b)` — the nodes' nearest block ancestors
   (`blockOf`, by tag name: `P`, `DIV`, `H1`–`H6`, `LI`, …) differ, or a `<br>` / block element /
   `<img>` (inline gaiji) lies between them (a `SHOW_ELEMENT | SHOW_TEXT` walk from `a` to `b`).
   The text-only TreeWalker used to flow straight from the end of one paragraph into the next —
   adjacent columns in 縦書き — so a word could be segmented and highlighted across the break.
   Tag names, not computed `display`, keep this cheap on the tap path.
6. Returns `{ text: before + after, tapOffset: before.length, positions }`. `positions[i]` is the
   DOM location of `text[i]`. The run can straddle text nodes (a kanji compound with ruby splits
   its base text), so an index→node map — not a string offset — is the only safe bridge back to the
   DOM; `rangeForSpan(doc, positions, start, end)` rebuilds a `Range` for any sub-span (used to
   auto-highlight the matched word). `positions` is also how the **saved word** is spelled — never
   `range.toString()`, which splices furigana in (§8).

`looksJapanese` (a first-char `WORD_CHAR` test) was removed — the gate lives inside
`extractTextAt`.

---

## 7. Worker lifecycle (`lookupClient.ts` / `lookup.worker.ts`)

The whole pipeline (kuromoji build + segmentation, deinflection, JMdict reads) runs in
`lookup.worker.ts`. `lookupClient.ts` owns the Worker and funnels every call through one
`request(worker, msg, timeoutMs)` helper: it assigns an id, registers the resolver in `pending`,
posts, and resolves with the `{ id, result, ready? }` reply — or `null` if the post throws, the
worker dies (`dropWorker` fails everything in flight), or the timeout fires, in which case the
worker is dropped as presumed dead (iOS can reclaim a worker **without** firing `onerror`). The
engine lives **only** in the worker bundle, keeping kuromoji + jpdict-idb + the deinflection table
out of the install precache.

Worker protocol: `warmup` → `result: boolean`; `ping` → `result: true, ready`; `lookup` →
`result: LookupResult | null, ready` where `ready` is the readiness **captured when the lookup
chose its path** (§4), never re-read after the awaits. A thrown lookup replies `result: null`
with no `ready` (so it is never cached).

| Function | Behaviour |
| --- | --- |
| `lookupAt(text, tapOffset)` | `RESULT_CACHE` hit ⇒ resolve immediately (no worker touched). Else `request({type:'lookup'})`, `LOOKUP_TIMEOUT_MS` 8000; `null` on any failure. Caches the reply only when `ready === true`. |
| `warmupLookup()` | `request({type:'warmup'})`, `WARMUP_TIMEOUT_MS` 30000 → `true` once kuromoji is built (and the IndexedDB connection opened). |
| `pingLookup(timeoutMs = 2000)` | Liveness probe for **resume**. `true` if a worker exists and answered; `false` if there is none **or** it didn't answer — then it has been dropped, so the next call builds a fresh one. Never constructs a worker. Usage: `if (!(await pingLookup())) void warmupLookup()`. A live worker answers even mid-build (the build is fetch → native inflate → a short parse, all async steps). |
| `disposeLookup()` | `terminate()`s the worker, resolves all in-flight calls with `null`, resets the construct-failure count. `RESULT_CACHE` deliberately survives. |

`lookupReady()` (only tests used it) was replaced by `pingLookup`, whose reply also carries
`ready`.

**`RESULT_CACHE`** (max 200, LRU, keyed `` `${tapOffset} ${text}` ``) is the pipeline's **only**
result cache, and it lives on the main thread precisely because the worker is disposable: a
re-tap of a recently defined word answers instantly without constructing a worker, let alone
waiting on a rebuild. It stores **only ready-derived** results, so a provisional greedy answer can
never be served in place of a morphological one. Plain data, not the trie.

Lifecycle:

- **One lazy singleton worker**, created (module Worker) on first `lookupAt`/`warmupLookup`.
- **Warmed on book open** (`warmupLookup`, when the dict is present) — fire-and-forget.
- **Shed on a *sustained* backgrounding, not on hide.** `Reader.svelte`'s `visibilitychange`
  handler waits `LOOKUP_IDLE_DISPOSE_MS = 60_000` and re-checks `document.hidden` before calling
  `disposeLookup()`; returning first cancels the timer. On resume the reader should
  `pingLookup()` and re-warm on `false` (covers a worker iOS killed silently while backgrounded).
  See [reader-engine.md](reader-engine.md) §12.
- **Disposed on reader exit** (`disposeLookup` from `Reader.svelte` `onDestroy`) so the ~30 MB
  kuromoji dictionary isn't pinned while no book is open. It rebuilds from the Cache API on next
  open, **no network**.
- **Error recovery is non-latching**: a runtime `worker.onerror` just `dropWorker()`s; the next
  call builds a fresh one. Only **≥3 consecutive *construction* failures**
  (`MAX_CONSTRUCT_FAILURES`) disable the feature.

**Offline** no longer depends on a trie build while online: `cacheIpadic()` (§3) writes the
IPADIC files into the SW cache directly, so a user who downloads from the shelf and goes offline
before ever opening a book still gets morphological segmentation.

---

## 8. Reader integration (`Reader.svelte`)

`ReaderController` raises a `TapInfo` (`{ doc, ix, iy, px, py }` — `ix/iy` iframe-local for the
caret APIs, `px/py` top-window for popup positioning) → `onTap` → `handleTap`, synchronously (there
is no defer). A tap never turns the page (pagination is by horizontal **swipe** — see
[reader-engine.md](reader-engine.md)). **A glyph hit outranks all chrome:**

```ts
function handleTap(info) {
  // 1. On a word → define it. Wins over an open card (it re-targets) AND over the edge band.
  if (settings.tapToDefine && info.doc && tryDefine(info)) {
    tapDefinedAt = Date.now(); chromeVisible = false; return
  }
  if (dictState.open) { closeOverlays(); return }                  // 2. blank tap → dismiss card
  if (inChromeToggleBand(info.py, viewportSize().h)) {             // 3. blank tap in band → chrome
    chromeVisible = !chromeVisible; return
  }
  if (chromeVisible) { chromeVisible = false; return }             // 4. blank tap → hide chrome
}
```

The band is `clamp(80, vh*0.12, 160)` while the reading margin is only `clamp(28, minDim*0.075,
80)`, so at iPad landscape 1194×834 a 100px band overlaps ~37px of **live text** at each end of
every column (≈2 glyphs; ~18% of the page on an iPhone). Checking the band first made that text
permanently un-lookupable, and the old "card open ⇒ dismiss only" rule cost a wasted tap for every
word-to-word transition. `inChromeToggleBand(py, vh)` (`src/lib/util/chromeBand.ts`) takes the
**visual** viewport height (`viewportSize().h`, not `window.innerHeight`); see
[reader-engine.md](reader-engine.md) §8. The glyph resolution in `extractTextAt` (§6) is what makes
a blank tap fall through `tryDefine` to those chrome behaviours — the slack budget there and the
reachability of the chrome toggle are the same knob.

- **`tryDefine(info)`** — `extractTextAt(info.doc, info.ix, info.iy)`; `null` ⇒ blank/non-word tap
  and it returns `false` (which is what routes the tap onward). Otherwise `openDefine({ text,
  tapOffset, px, py, doc, positions })` and `true`.
- **`openDefine(o)`** — opens the popup in the loading state, sets `dictState` (incl. `lastKey =
  `${existingCfi}:${tapOffset}:${text}`` to discard stale taps, and the in-flight doc/positions),
  then `runLookup`. Also serves **tap-on-existing-highlight** (`onShowAnnotation` passes
  `existingCfi` + the **stored** word, no doc/positions), so one popup handles both "define fresh"
  and "reopen highlighted word".
- **`runLookup(text, tapOffset, key)`** —
  ```ts
  try {
    if (!(await isDictReady())) { /* if still current */ dictState.needsDownload = true; return }
    const res = await lookupAt(text, tapOffset)
    if (!dictState.open || dictState.lastKey !== key) return   // dismissed or superseded
    dictState.loading = false; dictState.result = res
    if (res && res.entries.length && !dictState.cfi && defineDoc && definePositions.length)
      void autoHighlight(res, key)
  } catch (err) { /* if still current */ dictState.loading = false; dictState.result = null }
  ```
  The `!open || lastKey !== key` guard drops a late lookup if the popup was dismissed or a newer
  tap superseded it. The **try/catch is not decorative**: a rejection here (historically a failed
  IndexedDB open) latched the spinner on for the whole session, so the card now always leaves the
  loading state — `isDictReady()` itself also no longer throws (§3).
- **`autoHighlight(res, key)`** — `rangeForSpan(defineDoc, definePositions, matchStart, matchStart
  + matchLength)` → `cfiForSelection` → re-check the guard → `saveAnnotation` +
  `controller.addHighlight` (existence checked with the O(1) `isHighlighted(cfi)`, §8a). The saved
  `text` is spelled from `definePositions.slice(start, end)`, **not** `range.toString()`: a range
  over a ruby-annotated compound spans the intervening `<rt>`, so stringifying it splices the
  furigana in (決**けっ**心), which then displays wrong in Notes and fails to look up when the
  highlight is re-tapped. `onShowAnnotation` correspondingly prefers the stored annotation `text`.
- **`downloadDict()`** (popup's `ondownload`) — `await downloadAndWarmDictionary('en')` (§3:
  download JMdict, cache IPADIC, then build kuromoji so the re-run tap is morphological), clears
  `needsDownload`, re-runs `runLookup` for the originally-tapped word. While `dictPhase()` is
  `'downloading'`/`'retrying'`/`'preparing'` the popup should show that state rather than
  re-offer Download.

### 8a. The `annotations` store's non-reactive indexes

Tap-to-define saves an annotation for **every** looked-up word, and the first thing each tap asks
is "is this CFI already highlighted?" — which was a `.some()` over a `$state`-proxied array (no
short-circuit, proxy overhead per element, growing with the book). `src/stores/annotations.svelte.ts`
therefore keeps two plain `Set`s beside `items`: `ids` and `highlightCFIs`, exposing
`isHighlighted(cfi)`. `items` remains the single source of truth for rendering; the sets are
rebuilt by `reindex()` in `loadAnnotations`, cleared by `clearAnnotations`, and maintained by
`saveAnnotation`/`removeAnnotation`. Removal drops a CFI from `highlightCFIs` only when **no other
highlight** shares it (a bookmark, or a re-added highlight, can).

### `DictionaryPopup.svelte`

Props: `{ open, x, y, loading, needsDownload, result, highlighted, ondownload, ontogglehighlight }`.
Positions near `(x, y)`, clamped to the viewport (prefers above the tap, flips below if cramped).
A sticky `.actions` footer (shown only when `result` has entries) holds one **highlight toggle** —
"Remove highlight" when `highlighted`, else "Highlight"; the card stays open. Body states:

| State | Renders |
| --- | --- |
| `loading` | spinner |
| `needsDownload` | "Dictionary not installed"; while `dict.updating`, a progress bar reading `dict.progress`; a **Download** button; `dict.error` if present |
| `result` (truthy) | per entry `headword` + (non-kana) `reading` + `[pitch]` + reason chips (`entry.reasons`; `result.reasons` = the first entry's) + senses (POS + `; `-joined glosses, optional `misc` labels; `matched: false` senses belong to another spelling) |
| else | "No dictionary match." empty state |

### Reaching download from settings

Also reachable from **Shelf Settings** (`ShelfSettings.svelte`), "Japanese dictionary" section:
status text and buttons are driven by `dictPhase()` (Download when `'missing'`, "Retry now" when
`'retrying'`, progress while downloading, "Preparing for offline use…" while `'preparing'`). The
button calls `downloadAndCacheDictionary('en')` — JMdict + IPADIC into the Cache API, **no**
trie build on the shelf. On mount it calls `getDb()` and, if JMdict is already installed,
`cacheIpadic()` to top up the offline IPADIC copy (a no-op when complete). English glosses are
the only language, so download is always `'en'`.

---

## 9. Tests

`deinflect.test.ts` (Vitest) is the spec for the deinflection engine. `bases(surface) =
deinflect(surface).map(c => c.word)`; cases assert the plain form is among the candidates
(食べていました → 食べる, 美しかった → 美しい, 走った → 走る, 読みたい → 読む, 行こう → 行く,
見られた → 見る, 猫 → 猫) and that the deinflected candidate carries a non-empty `reasonChains`.

The rest of the pipeline (all Node, no jsdom — see [development.md](development.md) §9):

| File | Covers |
| --- | --- |
| `extract.test.ts` | `rangeForSpan` and the §6 glyph resolution against a hand-built fake `Document` (per-character rects; the fake TreeWalker honours `whatToShow`): mid-glyph correction, end-of-node, previous-node crossing, furigana→base redirect, blank ⇒ `null`, the non-word gate, `MAX_BEFORE`/`MAX_AFTER`, vertical cross-axis slack, **no run across a paragraph or `<br>`** (inline spans still join), **・ as a boundary**, **〇/〆 as word chars**. |
| `segment.test.ts` | Build gating/retry and `tokenSpanAt` span mapping (incl. the per-sentence offset) against a fake lattice tokenizer. |
| `segment.golden.test.ts` | **Golden boundaries.** Stages the trimmed dict into a temp dir by running the real staging script, builds stock kuromoji (`NodeDictionaryLoader` over the untouched package dict + `tokenize()`) and Tsuzuri's path (`kuromojiLoader.cjs` over the staged files via a `fetch` stub + `tokenSpans`), and asserts identical `[start, end)` boundaries over the natural-prose fixture `__fixtures__/corpus-ja.txt` (57 lines, whole and as extract-style runs, ~1.5k+ tokens) and **5,000 seeded random strings of IPADIC surface forms** (20k+ tokens). Also: no `tid_pos` staged, 11 character classes (not ~150k). ~1 s. |
| `lookup.test.ts` | Token vs. greedy paths and their tie-breaks, `settleSegmenter` (waits for an in-flight build; greedy when it never completes; stops waiting once failed), `MAX_WINDOW` fan-out bounds and `minLen` pruning, `candidateMatches`, per-term `getWords` rejection tolerance, POS labels; **merging** at the winning length (勉強した → する first with `past`, 机の下 → 下, 机のした (one token) → 下 first, いた → いる, きた → 来る, id dedupe); **`toEntry` match flags** (matched kanji spelling, kana hit → kanji it belongs to, matched senses first, misc labels); **`ready` captured at decision time**; greedy starts probed **concurrently** with leftmost still winning; `warmup` opening IndexedDB. |
| `lookup.worker.test.ts` | The worker protocol via a stubbed `self`: `ready` comes from the lookup, not a post-await read; `ping`; `warmup`; a thrown lookup is an uncacheable `null`. |
| `lookupClient.test.ts` | Lazy construction, `null` when a worker can't be constructed, `RESULT_CACHE` serving repeats (and surviving `disposeLookup()`), caching a ready "no match", **not** caching greedy results, `pingLookup` (false without constructing; true on reply; drops a silent worker and fails its in-flight work), warmup and lookup timeouts dropping the worker. |
| `dictdb.test.ts` | Against a fake jpdict-idb: one shared download; `OfflineError` / `DownloadError`+`nextRetry` as `'retrying'` (not a rejection) that resolves on success; a repeat call forcing a queued retry (`updateNow`); permanent failure rejects; `cacheIpadic` writing base-aware URLs into `kuromoji-ipadic-v2` (skipping cached, `false` on failure / no Cache API); the shelf flow not building the trie; `downloadAndWarmDictionary` holding `'preparing'` until warm. |

---

## 10. How to extend

- **Kanji / name lookup.** `@birchill/jpdict-idb` exports `getKanji({ kanji, lang })` and
  `getNames(search)`; download those series via `updateWithRetry({ series: 'kanji' | 'names', … })`
  and add render paths. `getKanji` returns rich `KanjiResult`s.
- **Graphical pitch accent.** `DictEntry.pitch` is shown as `[n]`; combine with
  `countMora`/`moraSubstring` from `@birchill/normal-jp` to draw a contour.
- **Tighten `candidateMatches`.** Replace the coarse `INFLECTABLE` regex with a full
  `WordType`↔JMdict-POS mapping so `cand.type` must match the entry's class (cf. 10ten's
  `getMatchingCandidates`). Removes false positives where an unrelated inflectable entry shares a
  deinflected spelling.
- **Self-host the dictionary data.** Downloads hit `data.10ten.life`; mirror the files and point
  jpdict-idb at your own origin to drop the third-party dependency.
- **Saved words.** Persist tapped `DictEntry`s for a review/flashcard feature (see
  [storage-pwa-ios.md](storage-pwa-ios.md)).

---

## 11. Gotchas

- **GPL.** Editing/redistributing requires honoring GPL-3.0-or-later (§2). Reimplement
  `deinflect.ts` to relicense.
- **The caret APIs are a seed, never the answer** (§6). `caretRangeFromPoint` /
  `caretPositionFromPoint` return the nearest caret *boundary* and cross to the next character at
  each glyph's mid-advance, so any code that treats their offset as "the tapped character" is
  wrong over ~40% of every glyph. Resolve through `resolveGlyph`; `pointOnGlyph` no longer exists.
- **Never `range.toString()` a word that may carry ruby.** The range spans the `<rt>`, so the
  furigana is spliced into the string (決**けっ**心). Spell words from `positions` / the stored
  annotation `text` (§8).
- **XHTML lowercase `tagName`.** `isInRuby` must compare `el.tagName.toUpperCase()` — EPUB is XHTML
  (lowercase `tagName`). Without it the furigana-skip fails and readings pollute the window.
- **`toNormalized` returns a TUPLE.** `[string, number[]]` — destructure `const [normalized] = …`;
  treating it as an object yields `undefined`.
- **jpdict-idb drops overlapping `updateWithRetry` calls** (keeping the first call's callbacks);
  always go through `downloadDictionary`, which shares one promise (§3).
- **`getWords` uses `matchType: 'exact'` (`limit: 8`).** The longest-match loop provides the
  "segmentation"; `getWords` does no fuzzy/prefix matching here.
- **`updateWithRetry` returns `void`.** Progress/completion/failure arrive only via
  `onUpdateComplete`/`onUpdateError` + the change listener; `downloadDictionary` bridges to a
  promise, treating `OfflineError` / `nextRetry` as "still pending" (§3).
- **`dict.state === 'ok'` is the only ready state.** `'init'`/`'empty'` = not usable;
  `'unavailable'` = DB couldn't open.
- **Popup `{#each}` keys include the index** (`entry.headword + entry.reading + ':' + i`, or use
  the unique `entry.id`). JMdict
  has homographs with identical headword+reading (e.g. 度/ど); keying on headword+reading alone
  throws Svelte's `each_key_duplicate` and the popup hangs. Keep the index.
- **Offline IPADIC comes from `cacheIpadic()`** (§3), which writes cache `kuromoji-ipadic-v2`
  directly; its name must match the workbox `cacheName` in `vite.config.ts` exactly, and
  `IPADIC_FILES` (`ipadic.ts`) must match `STAGED` in the staging script.
- **No `expiration` on the IPADIC runtime cache** — not even `maxEntries` (§4). The dict is an
  all-or-nothing shard set; a partial cache builds no trie and demotes every tap to greedy
  segmentation.
- **Never call kuromoji's `tokenize()`** (or `getFeatures`) — `tid_pos.dat` is not shipped, so
  features are empty. Take boundaries from `tokenSpans` (§4); if you ever need POS, derive it from
  JMdict, or re-stage `tid_pos` knowingly (+40 MB resident).
- **Don't trim a dict file without a structural bound.** `ByteBuffer.getInt` returns 0 for a read
  that *straddles* the end, so cutting "trailing zeros" blindly can corrupt the last entry; the
  staging script computes exact lengths and verifies.
- **Never cache a not-ready lookup result**, and capture readiness when the path is chosen, not
  after the awaits (§4, §7). `RESULT_CACHE` stores ready-derived results only.
- **Render reasons per entry.** A result can mix a deinflected verb and a surface noun (§4).
- **Don't put a NUL in these sources** (git then treats the file as binary and stops diffing).
- **First download is several MB.** The `words` series is multi-MB; the UI surfaces progress
  (`dict.progress`) and tolerates offline failure (`dict.error`). All later lookups are offline.

---

## 12. Cross-references

- [reader-engine.md](reader-engine.md) — tap capture in the foliate iframe → `TapInfo`
  (`ix/iy` vs `px/py`); tap routing precedence; CFI/highlight painting; pagination by swipe.
- [development.md](development.md) — the DEV `window.__tsuzuri` hook and the puppeteer harness
  used to measure tap-hit accuracy inside the closed-shadow iframe; the Vitest setup.
- [storage-pwa-ios.md](storage-pwa-ios.md) — IndexedDB/OPFS persistence, annotations, iOS storage
  eviction (jpdict-idb keeps its own IndexedDB DB).
- [deployment.md](deployment.md) — SW runtime caching, base path, the staged kuromoji dict.
- [architecture.md](architecture.md) — where this subsystem sits.
