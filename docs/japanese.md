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
| Segment | `segment.ts` | worker | kuromoji tokenizes the run; returns the start of the token containing the tap. |
| Match | `lookup.ts` | worker | From the token start, longest-first: normalize → deinflect → `getWords` (JMdict). |
| Deinflect | `deinflect.ts` | worker | Pure string → candidate base forms (GPL; see §2). |
| DB lifecycle | `dictdb.ts` | main | Owns the shared `JpdictIdb`, drives download, syncs the `dict` store. |

Accuracy has **two** independent failure modes, and both are documented as first-class
concerns: resolving the wrong *character* (§6 — geometry, main thread) and resolving the
wrong *word span* from the right character (§4 — segmentation, worker).

**The resolution contract** (the authoritative statement; §4 details it): `lookupAt(text,
tapOffset)` first gives a still-building kuromoji a **bounded wait** (`settleSegmenter`,
`SEGMENTER_WAIT_MS = 1200`), then asks it for the **start of the token containing the tap**
(`tokenStartAt`) and runs `matchAt` from that start — so tapping 決 or 心 in 決心 both resolve
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
| `@sglkc/kuromoji` | MeCab/IPADIC morphological analyzer (segmentation). Apache-2.0; ships the IPADIC dict as 12 `*.dat.gz` — **~19 MB compressed on the wire, ≈95 MB once inflated** (measured: 100,260,388 bytes). | `builder`, types `Tokenizer`, `IpadicFeatures` |

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

`dictdb.ts` owns the single shared `JpdictIdb` instance and bridges its state into the `dict`
store. It runs on the **main thread** (the download); the worker opens its own read-only
connection to the same `jpdict` IndexedDB.

- **`getDb()`** — memoizes the **success only**. It constructs `JpdictIdb`, awaits `d.ready`,
  registers `addChangeListener(syncState)` (fires on `'stateupdated'`/`'deleted'`), then
  `syncState()`; on rejection it **clears `initPromise` and rethrows**. Caching a rejected
  init would poison the rest of the session — every later `isDictReady()`, hence every tap,
  would reject on that same stale promise and the popup would spin forever. Transient
  failures (a `versionchange` from another tab, IndexedDB refusing to open under iOS storage
  pressure) therefore retry on the next call.
- **`isDictReady()`** — `true` if `dict.state === 'ok'` (fast path, no IndexedDB round-trip on
  the hot path), else `getDb()` and `d.words.state === 'ok'`. **Cannot throw**: it catches and
  returns `false`, because it is awaited on the tap hot path where a throw would leave the
  popup stuck loading. "Not usable" is the honest answer and the caller already handles it
  (it offers the download); `getDb()` retries next tap.
- **`downloadDictionary(lang = 'en')`** — clears `dict.error`/`dict.progress`, then wraps
  `updateWithRetry({ db, lang, series: 'words', onUpdateComplete, onUpdateError })` in a promise.
- **`downloadAndWarmDictionary(lang = 'en')`** — the shared entry point both download UIs call:
  `await downloadDictionary(lang)`, then sets `dict.warming = true` and `await warmupLookup()`
  (`finally` clears `warming`) so the IPADIC dict is SW-cached **while still online** (§4, §7). The
  online-warm invariant lives here, once.
- **`ensureDictionary(lang = 'en')`** — download only if `words.state !== 'ok'`.
- **`cancelDownload()`** — `cancelUpdateWithRetry({ db, series: 'words' })` **only if `db` is
  non-null** (no-op before `getDb()` has run), then sets `dict.updating = false`.

`updateWithRetry` returns **`void`** — completion/failure/progress arrive only via its callbacks
and the change listener, so `downloadDictionary` manually bridges them to a promise. It fetches
version metadata + data files from the **`data.10ten.life` CDN**, parses them, and writes records
into jpdict-idb's IndexedDB store, retrying retriable failures with backoff. After success all
lookups are offline.

### State sync

Only the `words` series is used (`kanji`/`names`/`radicals` are ignored). `syncState()`:

```ts
dict.state = db.words.state                  // 'init' | 'empty' | 'ok' | 'unavailable'
const u = db.words.updateState
if (u.type === 'updating') { dict.updating = true; dict.progress = u.totalProgress ?? 0 }
else if (u.type === 'checking') { dict.updating = true }
else { dict.updating = false }               // 'idle'
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
warming: boolean     // true while the IPADIC dict (~19 MB compressed) is fetched + SW-cached (§4)
error?: string
```

---

## 4. The lookup pipeline (`lookup.ts`, in the worker)

### Result types (`lookupTypes.ts`)

Kept dependency-free so the main thread imports them with `import type` without pulling in the
heavy engine.

```ts
interface Sense { pos: string[]; glosses: string[] }
interface DictEntry { headword; reading; pitch?: number; kanaOnly: boolean; senses: Sense[] }
interface LookupResult { matchStart; matchLength; reasons: string[]; entries: DictEntry[] }
```

`matchStart` + `matchLength` give the matched span `[matchStart, matchStart + matchLength)` in
the text passed to `lookupAt`, which the reader maps back to a DOM range to auto-highlight the
word (see [reader-engine.md](reader-engine.md)).

### `matchAt(window, queryWords, minLen = 1)` — longest match at one position

Longest dictionary form starting at the **beginning** of `window`:

```ts
const MAX_WINDOW = 12, MAX_RESULTS = 8
```

1. **Window cap.** `len` iterates `min(window.length, MAX_WINDOW)` down to `minLen`
   (longest-first ⇒ greedy longest-match). If `minLen > limit` it returns `null` **without
   querying at all**.
2. **Normalize.** `toNormalized(sub)` returns a **tuple** `[normalized, inputLengths]`; only the
   string is used (`const [normalized] = …`). Folds width/case, katakana→hiragana, long-vowel
   marks, etc. Skip the length if empty.
3. **Deinflect.** `deinflect(normalized)` → `CandidateWord[]` (always includes the surface form).
4. **Fire all queries up front.** Every candidate across every length is passed to `queryWords`
   *without awaiting*, so the IndexedDB reads run concurrently instead of as a serial await chain.
5. **Walk longest-first, read from cache.** For each length (longest first) and candidate,
   `await queryWords(cand.word)`, keep words passing `candidateMatches`, and return on the first
   non-empty length. `matchLength` = surface chars consumed. Returns `null` if nothing matched.

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
left cannot reach the tap within the window cap. The leftmost covering match is unchanged; the
fan-out of a fallback tap roughly halves.

**`queryWords` = `makeQueryCache()`** wraps `getWords(term, { matchType: 'exact', limit: 8 })` in
a `Map`, caching the **promise** (so parallel probes for the same term collapse onto one read)
and `.catch(() => [])` (so a flaky IndexedDB read degrades to "no match for this candidate"
rather than aborting the whole tap). One cache is shared across the whole tap — every length and
start.

### `lookupAt(text, tapOffset)` — segment to the word under the tap

What tap-to-define calls (via the worker). Bounds-checks `tapOffset`, then:

- **Wait (briefly) for the segmenter — `settleSegmenter()`.** Done *before* the LRU probe, so
  the cache key's readiness bit reflects the path actually taken. A tap fired while the
  tokenizer is still building would otherwise fall straight into the greedy fallback and return
  a plausible-but-wrong span — and because the worker is shed after a long backgrounding (§7),
  that window recurs on every foreground cycle, not once per session. The build promise is
  folded to a non-rejecting one *before* the `Promise.race`, so a failure arriving after the
  timeout can't surface as an unhandled rejection; the timer is always cleared. Accuracy is
  worth a bounded wait; a hang is not, so a build slower than `SEGMENTER_WAIT_MS` (1200ms — a
  few hundred ms is typical from the SW cache) still degrades to greedy.
- **`segmenterUnavailable` latch.** Once a build has failed (typically: offline before the
  IPADIC dict was SW-cached), taps stop *paying* the wait — they'd burn 1.2s each on a fetch
  that cannot succeed — but still kick off a background `ensureSegmenter()` retry, so the moment
  it succeeds subsequent taps take the morphological path again. `warmup()` clears the latch.
- **Result LRU** — `RESULT_LRU` (max 200) keyed `` `${segmenterReady()?1:0}|${tapOffset}|${text}` ``,
  so re-tapping a word skips the whole pipeline. The readiness bit means a greedy result cached
  *before* kuromoji loaded is superseded once it's ready. The separator is `|`, **not NUL**: a
  NUL in the source made git treat `lookup.ts` as binary and stop diffing it, and the run from
  `extract.ts` holds only `WORD_CHAR` characters, so `|` cannot collide.
- **kuromoji path.** `tokenStartAt(text, tapOffset)` returns the token start (or `null` if not
  ready). If non-null, `matchAt(text.slice(tokenStart), queryWords, tapOffset − tokenStart + 1)`
  — the `minLen` *is* the "must span the tap" test, so any non-null result is accepted, rebasing
  `matchStart = tokenStart`.
- **Greedy fallback.** Scan `start` from `max(0, tapOffset − MAX_WINDOW + 1)` to `tapOffset`,
  return the first `matchAt` hit — the leftmost, most complete word. The run from `extract.ts` is
  clause-bounded and `MAX_BEFORE`-capped, so the scan is short; the shared `queryWords` cache
  keeps the extra starts (and the token-path probes above) cheap.
- Results are stored in the LRU (including `null`).

`lookup(window)` is a thin forward-only wrapper (`matchAt(window, makeQueryCache())`); prefer
`lookupAt` for taps.

### `warmup()` / `isSegmenterReady()`

`warmup()` — `await ensureSegmenter()`, returning `Promise<boolean>` (`true` once built / dict
fetched, else `false`), and clears `segmenterUnavailable` on success. Callers gate an
"offline-ready" state on it. Exposed to the main thread as `warmupLookup()` (§7).

`isSegmenterReady()` — synchronous "is the tokenizer built", i.e. whether a lookup right now
resolves boundaries morphologically or greedily. Surfaced to the main thread two ways (§7): as
`lookupReady()` (an explicit `{type:'ready'}` probe) and as the `ready` flag riding every lookup
reply, which is what lets the client cache only authoritative results.

### Segmentation — `segment.ts` (kuromoji)

A lazy tokenizer singleton (mirrors `dictdb`'s pattern):

- **`ensureSegmenter()`** — builds the tokenizer once via `kuromoji.builder({ dicPath })`.
  kuromoji fetches IPADIC (`*.dat.gz`) from `${import.meta.env.BASE_URL}kuromoji/dict/`; the SW
  runtime-caches it (below). On failure it **rejects and clears `buildPromise`** so a later tap
  retries.
- **`segmenterReady()`** — synchronous "is it built".
- **`tokenStartAt(text, tapOffset)`** — `tokenizer.tokenize(text)` (in a try/catch), then the
  token whose `[word_position − 1, + surface_form.length)` span contains `tapOffset`; returns its
  start or `null`. (`word_position` is 1-based.)

> **Loader shim.** kuromoji's stock loader assumes the raw gzip stream and hangs silently if the
> server auto-decompresses it (Vite's dev server sets `Content-Encoding: gzip`).
> `kuromojiLoader.cjs` replaces it (gunzip with fflate only if the bytes carry the gzip magic
> `0x1f 0x8b`, else use as-is), aliased in via `vite.config.ts` — both `resolve.alias` (build) and
> `optimizeDeps.rolldownOptions` (dev prebundle). See [development.md](development.md).

### Offline caching of the IPADIC dict

The 12 IPADIC `*.dat.gz` files (~19 MB compressed; ≈95 MB inflated in the worker) are only
fetched — and thus SW-cached — when the worker builds kuromoji. The workbox config
(`vite.config.ts`):

- **Runtime-caches** `/kuromoji/dict/*.dat.gz` with `CacheFirst`, cache `kuromoji-ipadic`,
  `cacheableResponse: { statuses: [0, 200] }`, and **no `expiration` block at all** — no age
  purge *and* no `maxEntries` cap. It's build-versioned immutable data, so an age purge would
  silently evict it from a long-lived offline install; an LRU `maxEntries` cap is worse, because
  the dict is an all-or-nothing set and, once the cap were crossed (a future kuromoji bump adding
  a shard), it would evict one file and leave a **partial** dict — the trie build then fails and
  tap-to-define degrades to greedy segmentation with no way to refetch.
  `cleanupOutdatedCaches` handles cross-deploy staleness instead.
- Sets **`clientsClaim: true`** so a freshly-installed SW controls the already-loaded page
  immediately — otherwise the first-session dict fetch (right after download) would bypass the SW
  and never be cached.
- `globIgnores` excludes `**/kuromoji/**` from the install precache (it's too large; runtime-cached
  instead).

Because of this, the dict is SW-cached only on the kuromoji build, so the download flow warms it
while still online via `downloadAndWarmDictionary` (§3, §7). See [deployment.md](deployment.md).

### `candidateMatches` — the POS heuristic

```ts
const INFLECTABLE = /^(v1|v5|vk|vs|vz|vn|vr|adj-i|aux-v)/
function candidateMatches(word, cand) {
  if (!cand.reasonChains.length) return true              // surface form — always accepted
  return (word.s ?? []).flatMap(s => s.pos ?? []).some(p => INFLECTABLE.test(p))
}
```

A surface candidate (empty `reasonChains`, e.g. a noun 猫) is always accepted. A **deinflected**
candidate is valid only if the entry has an inflectable POS (`v1` ichidan, `v5*` godan, `vk` kuru,
`vs`/`vz` suru, `vn`/`vr` irregular, `adj-i` i-adj, `aux-v` aux), preventing e.g. treating a noun
as a deinflected verb. **Coarse**: it only checks the entry *can* inflect, not that its class
matches `cand.type` — see §9.

> `candidateMatches`/`toEntry` operate on raw `getWords` records typed `any`, reading `w.k`,
> `w.r`, `w.s`, `s.pos`/`s.g` directly.

### Helper tables

| Symbol | Role |
| --- | --- |
| `REASON_LABELS` | `Partial<Record<Reason, string>>` — `Reason` enum → display string (e.g. `PolitePast → 'polite past'`). Unmapped reasons are dropped. |
| `POS_LABELS` + `posLabel(code)` | JMdict POS → human string. `posLabel` falls back by prefix: `v5*`→"godan verb", `adj*`→"adjective", `v*`→"verb", else raw code. |
| `reasonsToLabels(chains)` | Maps the **first** chain (`chains[0]`) through `REASON_LABELS`, drops empties; `[]` for surface forms. |
| `readingAccent(a)` | Pitch-accent mora index from a reading-meta `a` field (a `number`, or `a[0].i` of an `Accent[]`). |
| `toEntry(w)` | Raw record → `DictEntry`: `headword = w.k?.[0]?.ent ?? w.r?.[0]?.ent`, `reading = w.r?.[0]?.ent`, `kanaOnly = !w.k?.length`, `pitch = readingAccent(w.r?.[0]?.a)`, one `Sense` per `w.s[]`. |

Why longest-match: Japanese has no inter-word spaces. `MAX_WINDOW = 12` caps each `matchAt`
([why 12](#window-cap)); the run length is capped in `extract.ts` and `minLen`
([why lossless](#minlen)) prunes the unusable lengths, so a tap runs `matchAt` from a small,
bounded number of starts with one shared query cache.

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
export function looksJapanese(s): boolean
```

Two jobs: **resolve the glyph under the point**, then **gather that word's
neighbourhood**. Internal helpers: `caretPosition`, `charRect`, `hitDistance`,
`glyphSlack`, `rubyBaseHit`, `resolveGlyph`, `isInRuby`, `textWalker`, `siblingText`,
`trailingRun`, `leadingRun`.

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
2. **Tapped-char gate.** If the resolved character isn't a word char
   (`WORD_CHAR = /[぀-ヿ㐀-鿿豈-﫿ー々]/` — kana U+3040–30FF, CJK Ext-A + Unified U+3400–9FFF, CJK
   Compatibility Ideographs **U+F900–FAFF**, the long-vowel `ー`, the iteration mark `々`), return
   `null`. This subsumes the old `looksJapanese` pre-filter. **Gotcha:** the compat-block start
   glyph is U+F900, visually identical to CJK-Unified U+8C48; writing U+8C48 would span
   U+8C48–FAFF and wrongly include the UTF-16 surrogate range U+D800–DFFF. The run iterates per
   UTF-16 unit, so astral CJK (Ext-B+) is out of scope.
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
   bound the run, keeping it in one clause.
6. Returns `{ text: before + after, tapOffset: before.length, positions }`. `positions[i]` is the
   DOM location of `text[i]`. The run can straddle text nodes (a kanji compound with ruby splits
   its base text), so an index→node map — not a string offset — is the only safe bridge back to the
   DOM; `rangeForSpan(doc, positions, start, end)` rebuilds a `Range` for any sub-span (used to
   auto-highlight the matched word). `positions` is also how the **saved word** is spelled — never
   `range.toString()`, which splices furigana in (§8).

### `looksJapanese(s)`

Tests the **first character** against `WORD_CHAR`. Still exported, but the lookup gate now lives
inside `extractTextAt`; keep it for a quick "is this Japanese?" check.

---

## 7. Worker lifecycle (`lookupClient.ts` / `lookup.worker.ts`)

The whole pipeline (kuromoji build + tokenize, deinflection, JMdict reads) runs in
`lookup.worker.ts`. `lookupClient.ts` owns the Worker, correlates request/response by integer
`id` over a shared `pending` map (a lookup resolves with `LookupResult | null`, a warmup or a
readiness probe with a `boolean` — all via the worker's `{ id, result }` message, whose optional
second field `ready` carries the segmenter's state), and exposes the same `lookupAt` shape callers
already used. The engine lives **only** in the worker bundle (no main-thread copy), keeping
kuromoji + jpdict-idb + the deinflection table out of the install precache.

| Function | Behaviour |
| --- | --- |
| `lookupAt(text, tapOffset)` | `RESULT_CACHE` hit ⇒ resolve immediately (no worker touched). Else posts `{ type: 'lookup', … }`; resolves `null` if the worker can't be constructed or `postMessage` throws; `LOOKUP_TIMEOUT_MS` 8000. |
| `warmupLookup()` | Posts `{ type: 'warmup' }`; `Promise<boolean>` — `true` once the worker's `ensureSegmenter()` resolves (i.e. the IPADIC dict has been fetched). `WARMUP_TIMEOUT_MS` 30000. |
| `lookupReady()` | Posts `{ type: 'ready' }` → the worker's `isSegmenterReady()`. **Never constructs a worker** (no worker ⇒ `false`) and a timeout (`READY_TIMEOUT_MS` 2000) does **not** drop the worker — a slow reply most likely means it is CPU-bound in the very trie build being asked about, so it can't drain its message queue. |
| `disposeLookup()` | `terminate()`s the worker and resolves all in-flight calls with `null`; resets construct-failure count. `RESULT_CACHE` deliberately survives. |

Two things live on the **client** side precisely *because* the worker is disposable:

- **`RESULT_CACHE`** (max 100, LRU, keyed `` `${tapOffset} ${text}` ``) caches **only
  ready-derived** results — the worker tags each reply with `ready: isSegmenterReady()` and the
  client stores the result only when that is true. `lookup.ts` has its own larger LRU (200), but
  that one lives *inside* the worker and dies with it, so on iOS it is destroyed on every long
  backgrounding. Keeping a copy out here means a re-tap of a recently defined word answers
  instantly — without constructing a worker at all, let alone waiting on the kuromoji rebuild that
  would otherwise push the tap onto the greedy fallback. Storing ready-derived results *only* is
  what makes this safe: a provisional greedy answer can never be served in place of a
  morphological one, so this cache needs no readiness bit of its own. It holds plain data (a few
  hundred KB), not the trie.
- **`lookupReady()`**, so the UI can distinguish "segmentation is still loading, this answer may
  improve" from "there is genuinely no dictionary match".

Lifecycle:

- **One lazy singleton worker**, created (module Worker) on first `lookupAt`/`warmupLookup`.
- **Warmed on book open** (`warmupLookup`, when the dict is present) so the first tap is fast —
  fire-and-forget there (pure perf).
- **Shed on a *sustained* backgrounding, not on hide.** `Reader.svelte`'s `visibilitychange`
  handler waits `LOOKUP_IDLE_DISPOSE_MS = 60_000` and re-checks `document.hidden` before calling
  `disposeLookup()`; returning first cancels the timer and skips the re-warm entirely (the worker
  was never disposed). Dispose-on-hide punished the common case — a glance at another app, a
  notification, Slide Over — because the rebuild window silently demoted taps to greedy
  segmentation, i.e. returned the wrong word with no signal to the reader, and rebuilding costs
  more transient memory than staying resident. See [reader-engine.md](reader-engine.md) §12.
- **Disposed on reader exit** (`disposeLookup` from `Reader.svelte` `onDestroy`) so the resident
  kuromoji trie isn't pinned while no book is open (iPad-PWA memory pressure). It rebuilds lazily
  and re-warms from the SW-cached dict on next open, **no network**.
- **Error recovery is non-latching**: a runtime `worker.onerror` (e.g. OOM-killed under iOS
  pressure) just `dropWorker()`s the instance; the next call builds a fresh one. Only **≥3
  consecutive *construction* failures** (`MAX_CONSTRUCT_FAILURES`) disable the feature, so a
  transient hiccup self-heals.

**Offline depends on warming kuromoji *before* going offline** (§4): the IPADIC dict is only
SW-cached when the worker builds kuromoji, so the download handlers warm it while still online via
`downloadAndWarmDictionary` (§3), which sets `dict.warming = true` ("Caching dictionary for offline
use…") until `warmupLookup()` resolves. Without this, a user who downloaded JMdict and went offline
before the IPADIC fetch finished would hit failed fetches and silently fall back to greedy
segmentation.

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
  download JMdict, then warm kuromoji while online so the IPADIC dict is SW-cached), clears
  `needsDownload`, re-runs `runLookup` for the originally-tapped word.

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
| `result` (truthy) | reason chips (`result.reasons`), then per entry `headword` + (non-kana) `reading` + `[pitch]` + senses (POS + `; `-joined glosses) |
| else | "No dictionary match." empty state |

### Reaching download from settings

Also reachable from **Shelf Settings** (`ShelfSettings.svelte`), "Japanese dictionary" section
showing `dict.state`/`dict.progress`/`dict.warming` and a **Download** button → `getDict()`
(`downloadAndWarmDictionary('en')` wrapped in try/catch surfacing `dict.error`). It calls `getDb()`
on mount to init the status readout. English glosses are the only language, so download is always
`'en'`.

---

## 9. Tests

`deinflect.test.ts` (Vitest) is the spec for the deinflection engine. `bases(surface) =
deinflect(surface).map(c => c.word)`; cases assert the plain form is among the candidates:

| Surface | Base | Inflection |
| --- | --- | --- |
| `食べていました` | `食べる` | ichidan te-form + continuous + polite past |
| `美しかった` | `美しい` | i-adjective past |
| `走った` | `走る` | godan past |
| `読みたい` | `読む` | -tai (desiderative) |
| `行こう` | `行く` | volitional |
| `見られた` | `見る` | passive / potential |
| `猫` | `猫` | surface form always included |

A final test confirms the `食べる` candidate from `食べていました` carries a non-empty `reasonChains`.
Run with `npm test`.

Three more suites cover the rest of the pipeline (all pure Node, no jsdom — see
[development.md](development.md) §9):

| File | Covers |
| --- | --- |
| `extract.test.ts` | `looksJapanese`, `rangeForSpan`, and the §6 glyph resolution against a hand-built fake `Document` with per-character rects: the mid-glyph correction (caret snapped past the tapped glyph), the end-of-node case, crossing into the previous text node at `offset 0`, the furigana→base redirect, blank-space ⇒ `null`, the non-word-char gate, run truncation at `MAX_BEFORE`/`MAX_AFTER`, and the wider cross-axis slack in vertical mode. |
| `lookup.test.ts` | The token vs. greedy paths and their tie-breaks, the `RESULT_LRU` (incl. the readiness bit), the `settleSegmenter` behaviours (waits for an in-flight build; answers greedily when a build never completes; stops waiting once one has failed), `isSegmenterReady`, the `MAX_WINDOW = 12` fan-out bounds (a 12-char surface still matches; nothing past 12 is probed; `minLen` prunes unusable starts/lengths), `candidateMatches`, per-term `getWords` rejection tolerance, POS labels. |
| `lookupClient.test.ts` | The client contract against a stub Worker: lazy construction, `null` (no throw) when a worker can't be constructed, `RESULT_CACHE` serving a repeat tap without touching the worker, the cache **surviving `disposeLookup()`**, caching a definitive ready "no match", **not** caching a greedy-fallback result, and `lookupReady()` — false with no worker (without constructing one) and not dropping the worker on a probe timeout. |

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
- **`getWords` uses `matchType: 'exact'` (`limit: 8`).** The longest-match loop provides the
  "segmentation"; `getWords` does no fuzzy/prefix matching here.
- **`updateWithRetry` returns `void`.** Progress/completion/failure arrive only via
  `onUpdateComplete`/`onUpdateError` + the change listener; `downloadDictionary` bridges to a
  promise.
- **`dict.state === 'ok'` is the only ready state.** `'init'`/`'empty'` = not usable;
  `'unavailable'` = DB couldn't open.
- **Popup `{#each}` keys include the index** (`entry.headword + entry.reading + ':' + i`). JMdict
  has homographs with identical headword+reading (e.g. 度/ど); keying on headword+reading alone
  throws Svelte's `each_key_duplicate` and the popup hangs. Keep the index.
- **Offline depends on warming kuromoji before going offline** (§4, §7). The download handlers
  `await warmupLookup()` to SW-cache the IPADIC dict while online.
- **No `expiration` on the `kuromoji-ipadic` runtime cache** — not even `maxEntries` (§4). The dict
  is an all-or-nothing shard set; a partial cache builds no trie and demotes every tap to greedy
  segmentation.
- **Never cache a not-ready lookup result across worker lifetimes.** The worker's `RESULT_LRU`
  keys on readiness and the client's `RESULT_CACHE` stores ready-derived results only (§7); a
  greedy answer is provisional and must be recomputed once kuromoji is up.
- **Don't put a NUL in these sources.** The LRU key separator is `|` because a NUL made git treat
  `lookup.ts` as binary and stop diffing it (§4).
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
