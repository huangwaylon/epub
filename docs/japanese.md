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
| Extract | `extract.ts` | main | Contiguous Japanese run around the tap (both sides, ruby-skipped) + tap offset within it. |
| Segment | `segment.ts` | worker | kuromoji tokenizes the run; returns the start of the token containing the tap. |
| Match | `lookup.ts` | worker | From the token start, longest-first: normalize → deinflect → `getWords` (JMdict). |
| Deinflect | `deinflect.ts` | worker | Pure string → candidate base forms (GPL; see §2). |
| DB lifecycle | `dictdb.ts` | main | Owns the shared `JpdictIdb`, drives download, syncs the `dict` store. |

**The resolution contract** (the authoritative statement; §4 details it): `lookupAt(text,
tapOffset)` first asks kuromoji for the **start of the token containing the tap**
(`tokenStartAt`), then runs `matchAt` from that start — so tapping 決 or 心 in 決心 both resolve
決心, and a JMdict compound *longer* than the IPADIC token is still found. While kuromoji loads
(or if it split a word JMdict lemmatizes differently), it falls back to **greedy
leftmost-covering**: scan candidate starts left-to-right from 0 to `tapOffset` and take the
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
| `@sglkc/kuromoji` | MeCab/IPADIC morphological analyzer (segmentation). Apache-2.0; ships the ~19 MB IPADIC dict. | `builder`, types `Tokenizer`, `IpadicFeatures` |

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

- **`getDb()`** — idempotent (memoized via `initPromise`). Constructs `JpdictIdb`, awaits
  `d.ready`, registers `addChangeListener(syncState)` (fires on `'stateupdated'`/`'deleted'`),
  then `syncState()`. All later DB advances re-sync the store.
- **`isDictReady()`** — `true` if `dict.state === 'ok'` (fast path, no IndexedDB round-trip on
  the hot path), else falls back to `getDb()` and checks `d.words.state === 'ok'`.
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
warming: boolean     // true while the ~19 MB IPADIC dict is being fetched + SW-cached (see §4)
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

### `matchAt(window, queryWords)` — longest match at one position

Longest dictionary form starting at the **beginning** of `window`:

```ts
const MAX_WINDOW = 16, MAX_RESULTS = 8
```

1. **Window cap.** `len` iterates `min(window.length, 16)` down to 1 (longest-first ⇒ greedy
   longest-match).
2. **Normalize.** `toNormalized(sub)` returns a **tuple** `[normalized, inputLengths]`; only the
   string is used (`const [normalized] = …`). Folds width/case, katakana→hiragana, long-vowel
   marks, etc. Skip the length if empty.
3. **Deinflect.** `deinflect(normalized)` → `CandidateWord[]` (always includes the surface form).
4. **Fire all queries up front.** Every candidate across every length is passed to `queryWords`
   *without awaiting*, so the IndexedDB reads run concurrently instead of as a serial await chain.
5. **Walk longest-first, read from cache.** For each length (longest first) and candidate,
   `await queryWords(cand.word)`, keep words passing `candidateMatches`, and return on the first
   non-empty length. `matchLength` = surface chars consumed. Returns `null` if nothing matched.

**`queryWords` = `makeQueryCache()`** wraps `getWords(term, { matchType: 'exact', limit: 8 })` in
a `Map`, caching the **promise** (so parallel probes for the same term collapse onto one read)
and `.catch(() => [])` (so a flaky IndexedDB read degrades to "no match for this candidate"
rather than aborting the whole tap). One cache is shared across the whole tap — every length and
start.

### `lookupAt(text, tapOffset)` — segment to the word under the tap

What tap-to-define calls (via the worker). Bounds-checks `tapOffset`, then consults a result LRU
before doing work:

- **Result LRU** — `RESULT_LRU` (max 200) keyed on `` `${segmenterReady()?1:0} ${tapOffset} ${text}` ``,
  so re-tapping a word skips the whole pipeline. The readiness bit means a greedy result cached
  *before* kuromoji loaded is superseded once it's ready.
- **kuromoji path.** `void ensureSegmenter().catch(…)` kicks off the lazy build, then
  `tokenStartAt(text, tapOffset)` returns the token start (or `null` until ready). If non-null,
  `matchAt(text.slice(tokenStart), queryWords)`; keep it only if `matchLength > tapOffset −
  tokenStart` (i.e. the match actually spans the tap), rebasing `matchStart = tokenStart`.
- **Greedy fallback** (also while kuromoji loads). Scan `start` from 0 to `tapOffset`, return the
  first `matchAt` whose span covers the tap — the leftmost, most complete word. The run from
  `extract.ts` is clause-bounded and `MAX_BEFORE`-capped, so the scan is short; the shared
  `queryWords` cache keeps the extra starts cheap.
- Results are stored in the LRU (including `null`).

`lookup(window)` is a thin forward-only wrapper (`matchAt(window, makeQueryCache())`); prefer
`lookupAt` for taps.

### `warmup()` — build kuromoji eagerly

`await ensureSegmenter()`, returning `Promise<boolean>` (`true` once built / dict fetched, else
`false`). Callers gate an "offline-ready" state on it. Exposed to the main thread as
`warmupLookup()` (§7).

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

The 12 IPADIC `*.dat.gz` files are only fetched (and thus SW-cached) when the worker builds
kuromoji. The workbox config (`vite.config.ts`):

- **Runtime-caches** `/kuromoji/dict/*.dat.gz` with `CacheFirst`, cache `kuromoji-ipadic`,
  `expiration: { maxEntries: 16 }` and **no age expiry** — it's build-versioned immutable data, so
  an age purge would silently evict it from a long-lived offline install; `cleanupOutdatedCaches`
  handles cross-deploy staleness instead.
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

Why longest-match: Japanese has no inter-word spaces. `MAX_WINDOW = 16` caps each `matchAt`; the
run length is capped in `extract.ts`, so a tap runs `matchAt` from a small, bounded number of
starts with one shared query cache.

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

### `extractTextAt(doc, x, y)`

1. **Caret resolution** (`caretPosition`) — `doc.caretRangeFromPoint(x, y)` (WebKit/Chrome,
   returns a `Range`) first, else `doc.caretPositionFromPoint(x, y)` (Firefox). Both via `doc as
   any` (TS lib types are unreliable). Returns `{ node, offset }` or `null`.
2. **Glyph hit-test** (`pointOnGlyph`) — the key gate. `caretRangeFromPoint` snaps to the
   *nearest* text even in blank margins / inter-column gaps, so on a wall-to-wall Japanese page it
   reports a hit almost everywhere; **without this gate every tap would define.** It builds a
   `Range` over the single char at the caret offset (clamped to node end) and checks whether
   `(x, y)` lies in any client rect grown by a **per-axis, line-aware slack** (`glyphSlack`).
   Returns `null` (→ chrome toggle / dismiss) if not.

   `glyphSlack(win, el)` reads the parent's computed style:
   - **Cross axis** (line-stacking, carries leading): grown by `(lineHeight − fontSize)/2 +
     MIN_HIT_SLACK` — half the leading plus a 6px floor — so the *whole* line/column pitch is
     tappable and each side reaches exactly the midpoint to the neighbour (full coverage, no
     overlap). `MIN_HIT_SLACK = 6` is a floor for solid-set text (line-height ≈ 1) and matches the
     old flat slack so the box is never tighter than before.
   - **Reading axis** (glyphs contiguous, no inter-word spaces): only `MIN_HIT_SLACK + fontSize ·
     0.15` (`READING_SLACK_EM = 0.15`) — enough to forgive a near-miss without swallowing the
     blank at a column/line end.
   - In vertical (縦書き) writing columns stack horizontally so the cross axis is *x*; horizontal
     writing stacks lines vertically so it's *y*. Any non-`horizontal-*` mode is treated as
     vertical. Missing view/element ⇒ flat floor on both axes.

   The `leading = lineHeight − fontSize` estimate assumes ~1em-square glyphs, which holds because
   lookups are gated to CJK/kana (`WORD_CHAR`).
3. **TreeWalker over text nodes** rejecting ruby via `isInRuby` (`acceptNode`
   FILTER_REJECT/ACCEPT).
4. **`isInRuby(node)`** — walks ancestors; `true` if any is `<rt>`/`<rp>`. Compares
   `el.tagName.toUpperCase()` because EPUB content is XHTML where `tagName` is **lowercase**
   (`"rt"`) — see §10.
5. **Tapped-char gate.** If the char at `pos.offset` isn't a word char
   (`WORD_CHAR = /[぀-ヿ㐀-鿿豈-﫿ー々]/` — kana U+3040–30FF, CJK Ext-A + Unified U+3400–9FFF, CJK
   Compatibility Ideographs **U+F900–FAFF**, the long-vowel `ー`, the iteration mark `々`), return
   `null`. This subsumes the old `looksJapanese` pre-filter. **Gotcha:** the compat-block start
   glyph is U+F900, visually identical to CJK-Unified U+8C48; writing U+8C48 would span
   U+8C48–FAFF and wrongly include the UTF-16 surrogate range U+D800–DFFF. The run iterates per
   UTF-16 unit, so astral CJK (Ext-B+) is out of scope.
6. **Collect the run both sides.** Forward from the tap (capped at `MAX_AFTER`) and backward (the
   trailing word-char run before the tap, capped at `MAX_BEFORE`), each with its `{node, offset}`.
   Both loops are capped *during* the scan so a long single-`Text`-node paragraph never allocates a
   `CharPosition` per char only to discard it. Punctuation/space/latin bound the run, keeping it in
   one clause.
7. Returns `{ text: before + after, tapOffset: before.length, positions }`. `positions[i]` is the
   DOM location of `text[i]`. The run can straddle text nodes (a kanji compound with ruby splits
   its base text), so an index→node map — not a string offset — is the only safe bridge back to the
   DOM; `rangeForSpan(doc, positions, start, end)` rebuilds a `Range` for any sub-span (used to
   auto-highlight the matched word).

### `looksJapanese(s)`

Tests the **first character** against `WORD_CHAR`. Still exported, but the lookup gate now lives
inside `extractTextAt`; keep it for a quick "is this Japanese?" check.

---

## 7. Worker lifecycle (`lookupClient.ts` / `lookup.worker.ts`)

The whole pipeline (kuromoji build + tokenize, deinflection, JMdict reads) runs in
`lookup.worker.ts`. `lookupClient.ts` owns the Worker, correlates request/response by integer
`id` over a shared `pending` map (a lookup resolves with `LookupResult | null`, a warmup with a
`boolean` — both via the worker's `{ id, result }` message), and exposes the same `lookupAt`
shape callers already used. The engine lives **only** in the worker bundle (no main-thread copy),
keeping kuromoji + jpdict-idb + the deinflection table out of the install precache.

| Function | Behaviour |
| --- | --- |
| `lookupAt(text, tapOffset)` | Posts `{ type: 'lookup', … }`; resolves `null` if the worker can't be constructed or `postMessage` throws. |
| `warmupLookup()` | Posts `{ type: 'warmup' }`; `Promise<boolean>` — `true` once the worker's `ensureSegmenter()` resolves (i.e. the ~19 MB dict has been fetched). |
| `disposeLookup()` | `terminate()`s the worker and resolves all in-flight calls with `null`; resets construct-failure count. |

Lifecycle:

- **One lazy singleton worker**, created (module Worker) on first `lookupAt`/`warmupLookup`.
- **Warmed on book open** (`warmupLookup`, when the dict is present) so the first tap is fast —
  fire-and-forget there (pure perf).
- **Disposed on reader exit** (`disposeLookup` from `Reader.svelte` `onDestroy`) so the resident
  kuromoji trie (tens of MB) isn't pinned while no book is open (iPad-PWA memory pressure). It
  rebuilds lazily and re-warms from the SW-cached dict on next open, **no network**.
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
caret APIs, `px/py` top-window for popup positioning) → `onTap` → `handleTap`. A tap never turns
the page (pagination is by horizontal **swipe** — see [reader-engine.md](reader-engine.md)):

```ts
function handleTap(info) {
  if (dictState.open) { closeOverlays(); return }                  // open popup swallows the tap
  if (inChromeToggleBand(info.py, viewportSize().h)) {             // top/bottom band → chrome
    chromeVisible = !chromeVisible; return
  }
  if (chromeVisible) { chromeVisible = false; return }             // visible chrome → dismiss
  if (settings.tapToDefine) tryDefine(info)                        // central area: define
}
```

`inChromeToggleBand(py, vh)` (`src/lib/util/chromeBand.ts`) takes the **visual** viewport height
(`viewportSize().h`, not `window.innerHeight`); see [reader-engine.md](reader-engine.md) §8. The
glyph hit-test in `extractTextAt` (§6) is what lets a blank-space central tap fall through
`tryDefine` and do nothing.

- **`tryDefine(info)`** — `extractTextAt(info.doc, info.ix, info.iy)`; `null` ⇒ blank/non-word tap.
  Otherwise `openDefine({ text, tapOffset, px, py, doc, positions })`.
- **`openDefine(o)`** — opens the popup in the loading state, sets `dictState` (incl. `lastKey =
  `${existingCfi}:${tapOffset}:${text}`` to discard stale taps, and the in-flight doc/positions),
  then `runLookup`. Also serves **tap-on-existing-highlight** (`onShowAnnotation` passes
  `existingCfi` + word, no doc/positions), so one popup handles both "define fresh" and "reopen
  highlighted word".
- **`runLookup(text, tapOffset, key)`** —
  ```ts
  if (!(await isDictReady())) { /* if still current */ dictState.needsDownload = true; return }
  const res = await lookupAt(text, tapOffset)
  if (!dictState.open || dictState.lastKey !== key) return     // dismissed or superseded
  dictState.loading = false; dictState.result = res
  if (res && res.entries.length && !dictState.cfi && defineDoc && definePositions.length)
    void autoHighlight(res, key)
  ```
  The `!open || lastKey !== key` guard drops a late lookup if the popup was dismissed or a newer
  tap superseded it. **`autoHighlight`** builds the word range from the extract positions +
  `matchStart`/`matchLength`, CFIs it, re-checks the guard, then `saveAnnotation` +
  `controller.addHighlight` (see [reader-engine.md](reader-engine.md)).
- **`downloadDict()`** (popup's `ondownload`) — `await downloadAndWarmDictionary('en')` (§3:
  download JMdict, then warm kuromoji while online so the IPADIC dict is SW-cached), clears
  `needsDownload`, re-runs `runLookup` for the originally-tapped word.

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
- **First download is several MB.** The `words` series is multi-MB; the UI surfaces progress
  (`dict.progress`) and tolerates offline failure (`dict.error`). All later lookups are offline.

---

## 12. Cross-references

- [reader-engine.md](reader-engine.md) — tap capture in the foliate iframe → `TapInfo`
  (`ix/iy` vs `px/py`); CFI/highlight painting; pagination by swipe.
- [storage-pwa-ios.md](storage-pwa-ios.md) — IndexedDB/OPFS persistence, annotations, iOS storage
  eviction (jpdict-idb keeps its own IndexedDB DB).
- [deployment.md](deployment.md) — SW runtime caching, base path, the staged kuromoji dict.
- [architecture.md](architecture.md) — where this subsystem sits.
