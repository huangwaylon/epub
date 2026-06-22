# Japanese dictionary & text-parsing subsystem

This is Tsuzuri's headline feature: **tap a word in the reader → an offline dictionary
entry with deinflection**. Tapping a run of Japanese text extracts a forward window of
characters, reverse-conjugates ("deinflects") it into candidate dictionary forms, looks
those up in a JMdict-backed IndexedDB database, and renders the longest match in a popup.
Everything after the one-time dictionary download is fully offline.

All code lives in `src/services/jp/` plus the Svelte glue in `src/lib/reader/`. This
document is written for engineers/agents extending the feature; signatures below were read
directly from source and the installed type declarations.

---

## 1. Overview

Two engines combine so tapping *any* character of a word resolves the whole word: **kuromoji**
(MeCab-style IPADIC morphological analysis) finds word boundaries, and the **10ten** matcher
(normalize → deinflect → JMdict lookup) supplies the glosses (IPADIC has no English):

1. **Extract** the contiguous Japanese run *around* the tap — context on **both** sides,
   skipping furigana — plus the tap's offset within it (`src/services/jp/extract.ts`).
2. **Segment** with kuromoji (`src/services/jp/segment.ts`): tokenize the run and find the
   morphological token containing the tap; its start index is the word boundary. kuromoji
   loads lazily (~19 MB IPADIC, once) — until it's ready (or if it splits a word JMdict
   lemmatises differently) `lookupAt` falls back to **greedy leftmost-covering** (scan starts
   left-to-right, take the first longest match spanning the tap).
3. **Match** from the token start (`lookupAt` → `matchAt` in `src/services/jp/lookup.ts`): for
   length `len` longest-first, `slice(0, len)` → normalize → **deinflect**
   (`src/services/jp/deinflect.ts`) → `getWords(..., { matchType: 'exact' })` in the JMdict
   IndexedDB (`@birchill/jpdict-idb`). Starting at kuromoji's boundary means tapping 決 or 心 in
   決心 both resolve 決心, and a JMdict compound longer than the IPADIC token is still found.

The orchestration is in `src/services/jp/lookup.ts`; segmentation in `src/services/jp/segment.ts`;
readiness/download lifecycle in `src/services/jp/dictdb.ts`; reactive UI state is the `dict`
store (`src/stores/dict.svelte.ts`); the popup is `src/lib/reader/DictionaryPopup.svelte`; and
the tap→lookup wiring lives in `src/lib/reader/Reader.svelte`.

---

## 2. Packages & licensing

| Package | Role | Key exports used |
| --- | --- | --- |
| `@birchill/jpdict-idb` | The dictionary database: downloads JMdict into IndexedDB and queries it. | `JpdictIdb`, `getWords`, `updateWithRetry`, `cancelUpdateWithRetry`, types `WordResult`, `DataSeriesState`, `UpdateState` |
| `@birchill/normal-jp` | Japanese text normalization. | `toNormalized`, `kanaToHiragana` |
| `@sglkc/kuromoji` | MeCab-style (IPADIC) morphological analyser — word segmentation (`segment.ts`). Apache-2.0; ships the ~19 MB IPADIC dict. | `builder`, `Tokenizer`, `IpadicFeatures` |

The Birchill packages are by the 10ten author; all three are under permissive licenses (the
GPL comes only from the vendored `deinflect.ts` below).

### The vendored deinflection engine is GPL — so the whole app is GPL

`src/services/jp/deinflect.ts` is **copied verbatim** from
[`10ten-ja-reader`](https://github.com/birchill/10ten-ja-reader) (`src/background/deinflect.ts`),
which is licensed **GPL-3.0-or-later**. The license text is vendored alongside it at
`src/services/jp/LICENSE-10ten` (GNU GPL v3, 29 June 2007). Because GPL is copyleft and this
file is statically linked into the bundle, **the entire Tsuzuri application is effectively
GPL-3.0-or-later**. To relicense the app under anything else, `deinflect.ts` must be
**reimplemented from scratch** (the rule data and the reverse-conjugation algorithm are the
GPL part).

The only edit made to the vendored file is documented in its header (lines 1–6):

> `const enum` was changed to `enum` so the values survive esbuild's isolated-modules
> transpilation; otherwise unchanged.

This matters because Vite/esbuild compiles each file in isolation (`isolatedModules`) and
cannot inline `const enum` members across module boundaries; a plain `enum` emits a real
runtime object, so `Reason.*` / `WordType.*` values are available to `lookup.ts` (which
imports `Reason`) and at runtime.

---

## 3. Dictionary DB lifecycle (`dictdb.ts`)

`dictdb.ts` owns the single shared `JpdictIdb` instance and bridges its state into the `dict`
store.

### Singleton

```ts
let db: JpdictIdb | null = null
let initPromise: Promise<JpdictIdb> | null = null

export async function getDb(): Promise<JpdictIdb> {
  if (!initPromise) {
    initPromise = (async () => {
      const d = new JpdictIdb()
      await d.ready
      d.addChangeListener(syncState)   // re-sync the store on every DB change
      db = d
      syncState()
      return d
    })()
  }
  return initPromise
}
```

`getDb()` is idempotent (memoized via `initPromise`). `new JpdictIdb()` opens the underlying
IndexedDB; `await d.ready` resolves once it is open. The change listener (`addChangeListener`,
topic `'stateupdated' | 'deleted'`) re-runs `syncState()` whenever the DB advances.

### State sync

`JpdictIdb` exposes one `DataSeriesInfo` per series (`words`, `kanji`, `names`, `radicals`).
Only `words` is used. `DataSeriesInfo = { state: DataSeriesState; version; updateState: UpdateState }`.

```ts
function syncState(): void {
  if (!db) return
  const words = db.words
  dict.state = words.state                      // 'init' | 'empty' | 'ok' | 'unavailable'
  const u = words.updateState
  if (u.type === 'updating') {
    dict.updating = true
    dict.progress = u.totalProgress ?? 0        // 0..1
  } else if (u.type === 'checking') {
    dict.updating = true
  } else {                                       // 'idle'
    dict.updating = false
  }
}
```

`UpdateState` is a tagged union (from the type declarations):

| `type` | Extra fields |
| --- | --- |
| `'idle'` | `lastCheck` |
| `'checking'` | `series`, `lastCheck` |
| `'updating'` | `series`, `version`, `fileProgress`, `totalProgress`, `lastCheck` |

`DataSeriesState` is `'init' | 'empty' | 'ok' | 'unavailable'`; lookups are only possible in
state `'ok'`.

### Download / ensure / cancel

```ts
export function downloadDictionary(lang = 'en'): Promise<void>   // kick off / resume
export async function ensureDictionary(lang = 'en'): Promise<void> // download only if not 'ok'
export async function isDictReady(): Promise<boolean>            // d.words.state === 'ok'
export async function cancelDownload(): Promise<void>            // cancelUpdateWithRetry
```

`downloadDictionary` wraps `updateWithRetry` in a promise:

```ts
updateWithRetry({
  db: d,
  lang,                 // gloss language, e.g. 'en'
  series: 'words',
  onUpdateComplete: () => { syncState(); resolve() },
  onUpdateError: ({ error }) => { dict.error = error.message; dict.updating = false; reject(error) },
})
```

`updateWithRetry` (note: returns `void`, not a promise — the callbacks are the only signal)
fetches version metadata and data files from the **`data.10ten.life` CDN**, parses them, and
writes records into jpdict-idb's own IndexedDB store. On retriable failures it retries with
backoff. `cancelDownload` (`dictdb.ts:81`) calls `cancelUpdateWithRetry({ db, series: 'words' })`
**only when `db` is non-null** (guarded by `if (db)` — so it is a no-op before `getDb()` has
ever run), then unconditionally sets `dict.updating = false`.

After a successful download the data lives entirely in IndexedDB; all subsequent lookups are
offline and never touch the network.

### The `dict` store (`src/stores/dict.svelte.ts`)

```ts
export const dict = $state<{
  state: 'init' | 'empty' | 'ok' | 'unavailable'
  updating: boolean
  progress: number   // 0..1 while updating
  error?: string
}>({ state: 'init', updating: false, progress: 0 })
```

A Svelte 5 `$state` rune; consumed reactively by `DictionaryPopup.svelte` (download UI) and
`ShelfSettings.svelte` (status readout).

---

## 4. The lookup pipeline (`lookup.ts`)

### Public types

```ts
export interface Sense {
  pos: string[]      // human-readable parts of speech (via posLabel)
  glosses: string[]  // English definitions
}

export interface DictEntry {
  headword: string   // kanji form if present, else kana
  reading: string    // kana reading
  pitch?: number     // pitch-accent mora index, if known
  kanaOnly: boolean  // true when there is no kanji form (reading is redundant)
  senses: Sense[]
}

export interface LookupResult {
  matchStart: number   // offset of the match within the text passed to lookupAt (0 for `lookup`)
  matchLength: number  // # chars from matchStart that matched
  reasons: string[]    // human-readable deinflection reasons, outermost first
  entries: DictEntry[]
}
```

`matchStart` + `matchLength` give the matched word's span `[matchStart, matchStart+matchLength)`,
which the reader uses to rebuild a DOM range for the tapped word — e.g. to auto-highlight it
(see `docs/reader-engine.md` §10).

### `matchAt(window)` — longest match at one position

The core matcher takes the longest dictionary form starting at the **beginning** of `window`
(this was the whole of the old `lookup`; it is now a building block):

```ts
const MAX_WINDOW = 16
const MAX_RESULTS = 8

const limit = Math.min(window.length, MAX_WINDOW)
for (let len = limit; len > 0; len--) {
  const sub = window.slice(0, len)
  const [normalized] = toNormalized(sub)        // ← TUPLE destructure, see gotchas
  if (!normalized) continue

  const candidates = deinflect(normalized)
  for (const cand of candidates) {
    const words = await queryWords(cand.word)   // getWords, memoized across the whole tap
    if (!words.length) continue
    const matched = words.filter((w) => candidateMatches(w, cand))
    if (!matched.length) continue
    return {
      matchStart: 0,                             // relative to `window`; lookupAt rebases it
      matchLength: len,                          // surface chars consumed (the token's span)
      reasons: reasonsToLabels(cand.reasonChains),
      entries: matched.map(toEntry),
    }
  }
}
return null
```

Step by step:

1. **Window cap.** `len` iterates from `min(window.length, 16)` down to `1`. Longest-first
   gives greedy longest-match (e.g. `食べていました…` matches the full inflected verb before any
   shorter prefix).
2. **Normalize.** `toNormalized(sub)` returns a **tuple** `[normalized, inputLengths]`; only
   the string is used (`const [normalized] = ...`). It folds width/case, katakana→hiragana,
   long-vowel marks, etc., into a canonical lookup key.
3. **Deinflect.** `deinflect(normalized)` returns `CandidateWord[]`, always including the
   surface form itself plus every plausible reverse-conjugation.
4. **Query (memoized).** `queryWords(term)` wraps `getWords(term, { matchType: 'exact', limit: 8 })`
   in a `Map` cache built by `makeQueryCache()` and shared across the whole tap, so identical
   candidate strings (across lengths *and* starts) are queried once.
5. **Filter.** `candidateMatches(word, cand)` discards deinflections that don't make sense for
   the matched dictionary entry's part of speech (below).
6. **Return the longest.** The first `len` with ≥1 surviving entry wins; `matchLength` is the
   number of surface characters it consumed (the token's span). Returns `null` if nothing
   matched at any length.

### `lookupAt(text, tapOffset)` — segment to the word under the tap

This is what tap-to-define calls. It uses kuromoji's segmentation for the word boundary, then
`matchAt` for the entry, with a greedy fallback while the analyser loads:

```ts
export async function lookupAt(text: string, tapOffset: number): Promise<LookupResult | null> {
  const queryWords = makeQueryCache()

  void ensureSegmenter().catch(() => {})        // kick off the kuromoji load (non-blocking)
  const tokenStart = tokenStartAt(text, tapOffset)   // null until the tokenizer is ready
  if (tokenStart !== null) {
    const res = await matchAt(text.slice(tokenStart), queryWords)
    if (res && res.matchLength > tapOffset - tokenStart) { res.matchStart = tokenStart; return res }
  }

  // Greedy leftmost-covering fallback (also used while kuromoji loads).
  for (let start = 0; start <= tapOffset; start++) {
    const res = await matchAt(text.slice(start), queryWords)
    if (res && res.matchLength > tapOffset - start) { res.matchStart = start; return res }
  }
  return null
}
```

- **kuromoji path.** `tokenStartAt` (`segment.ts`) tokenizes the run and returns the start index
  of the token containing the tap; `matchAt` runs from there. So the boundary is MeCab-grade,
  and `matchAt`'s longest-match can still extend past the IPADIC token if JMdict has a longer
  compound. If JMdict has no entry spanning the tap from that start, it falls through.
- **Greedy fallback.** Scans starts left-to-right and returns the first longest match covering
  the tap — the leftmost (most complete) word. Used while kuromoji is still loading, and as a
  safety net. The run from `extract.ts` (§6) starts at a clause boundary and is bounded by
  `MAX_BEFORE`, so the scan is short; the shared `queryWords` cache keeps the extra starts cheap.
- `lookup(window)` still exists as a thin forward-only wrapper (`matchAt(window, …)`), but
  prefer `lookupAt` for taps so a mid-word tap resolves the whole word rather than a sub-word.

### Segmentation — `segment.ts` (kuromoji)

`segment.ts` owns a lazy kuromoji tokenizer singleton (mirrors `dictdb`'s pattern):

- `ensureSegmenter()` — builds the tokenizer once (idempotent). kuromoji fetches the IPADIC
  dict (~19 MB of `*.dat.gz`) from `${BASE_URL}kuromoji/dict/`; the service worker runtime-caches
  it for offline use (see `docs/deployment.md`). Rejects-and-clears on failure so a later tap retries.
- `segmenterReady()` — synchronous "is it built yet" check.
- `tokenStartAt(text, tapOffset)` — `tokenizer.tokenize(text)` then the token whose
  `[word_position-1, +surface_form.length)` span contains `tapOffset`; returns its start, or
  `null` if not ready.

> **Loader shim.** kuromoji's stock browser loader assumes the server returns the raw gzip
> stream and hangs silently if the server auto-decompresses it (Vite's dev server sets
> `Content-Encoding: gzip`). `src/services/jp/kuromojiLoader.cjs` replaces it with a defensive
> loader (gunzip only if the bytes are actually gzip), wired in via a Vite alias — see
> `vite.config.ts` and `docs/development.md`.

### `candidateMatches` — the POS heuristic

```ts
const INFLECTABLE = /^(v1|v5|vk|vs|vz|vn|vr|adj-i|aux-v)/

function candidateMatches(word: any, cand: CandidateWord): boolean {
  if (!cand.reasonChains.length) return true          // surface form — always accepted
  const allPos: string[] = (word.s ?? []).flatMap((s: any) => s.pos ?? [])
  return allPos.some((p) => INFLECTABLE.test(p))
}
```

- A candidate with **empty `reasonChains`** is the un-inflected surface form and is always
  accepted (e.g. a noun like `猫`).
- A **deinflected** candidate is only valid if the dictionary entry has at least one
  inflectable part of speech, matched by the `INFLECTABLE` regex against JMdict POS codes
  (`v1` ichidan, `v5*` godan, `vk` kuru, `vs`/`vz` suru, `vn`/`vr` irregular, `adj-i` i-adj,
  `aux-v` auxiliary). This prevents e.g. treating a noun as if it were a deinflected verb.
- This is a **coarse** heuristic: it checks only that the entry *can* inflect, not that the
  entry's specific class matches `cand.type` (the `WordType` bitfield). See §9 for tightening
  it with the full WordType↔POS mapping.

> Note: `candidateMatches` and `toEntry` operate on `getWords` results typed as `any` here,
> not the exported `WordResult` type — they read `w.k`, `w.r`, `w.s` and `s.pos`/`s.g`
> directly off the raw record shape.

### Helper tables

- **`REASON_LABELS: Partial<Record<Reason, string>>`** — maps the `Reason` enum to display
  strings (e.g. `Reason.PolitePast → 'polite past'`, `Reason.Te → '-te'`,
  `Reason.Causative → 'causative'`). Not every `Reason` has a label; unmapped ones are
  dropped by `reasonsToLabels`.
- **`POS_LABELS` + `posLabel(code)`** — maps JMdict POS codes to human strings. `posLabel`
  falls back by prefix: `v5*`→"godan verb", `adj*`→"adjective", `v*`→"verb", else the raw
  code. Examples: `n`→"noun", `adj-i`→"い-adjective", `vs`→"する verb", `aux-v`→"auxiliary verb".
- **`reasonsToLabels(chains: Reason[][]): string[]`** — takes the **first** reason chain
  (`chains[0]`), maps each `Reason` through `REASON_LABELS`, and filters out empties. Returns
  `[]` for the surface form.
- **`readingAccent(a): number | undefined`** — extracts the pitch-accent mora index from a
  reading-meta `a` field, which may be a `number` or an `Array<Accent>` (`{ i, pos? }`); reads
  `a` or `a[0].i`.
- **`toEntry(w)`** — projects a raw word record into `DictEntry`: `headword = w.k?.[0]?.ent ??
  w.r?.[0]?.ent`, `reading = w.r?.[0]?.ent`, `kanaOnly = !w.k?.length`, `pitch =
  readingAccent(w.r?.[0]?.a)`, and one `Sense` per `w.s[]` with `pos` mapped through
  `posLabel` and `glosses` from `g.str`.

### Why longest-match + performance cap

Japanese has no inter-word spaces, so `matchAt` greedily consumes the longest valid dictionary
form at a position, and `lookupAt` picks the leftmost such match covering the tap. `MAX_WINDOW
= 16` caps each `matchAt`; the run length is capped in `extract.ts` (`MAX_BEFORE` / `MAX_AFTER`),
so `lookupAt` runs `matchAt` from at most ~`MAX_BEFORE + 1` starts. `getWords` results are
memoized across the whole tap (one shared `makeQueryCache`), keeping a tap to a small, bounded
number of IndexedDB reads.

---

## 5. The deinflection engine (`deinflect.ts`)

A self-contained, rule-based **reverse conjugator**. Its only import is `kanaToHiragana` from
`@birchill/normal-jp`; it has no dependency on the dictionary, so it is pure string→candidates.

### Public surface

```ts
export enum Reason { PolitePastNegative, PoliteNegative, /* … */ NegativeTe, Irregular }
export { Type as WordType }                       // bitfield enum (re-exported)
export interface CandidateWord {
  word: string                  // the de-inflected candidate
  reasonChains: Array<Array<Reason>>  // sequences of rules applied; [] for the surface form
  type: number                  // bitfield of WordType flags this candidate could be
}
export function deinflect(word: string): Array<CandidateWord>
export const deinflectL10NKeys: { [key: number]: string }  // Reason → i18n key (10ten leftover; unused here)
```

### The model

- **`Reason`** enumerates human-readable inflection reasons (past, negative, potential,
  passive, causative, polite, `-te`, `-tai`, volitional, masu-stem, …). A `reasonChains` entry
  is an *ordered* list of reasons describing how the surface form was reduced; outermost
  inflection first.
- **`WordType` (`Type`) is a bitfield.** Final word types: `IchidanVerb (1<<0)`,
  `GodanVerb (1<<1)`, `IAdj (1<<2)`, `KuruVerb (1<<3)`, `SuruVerb (1<<4)`,
  `SpecialSuruVerb (1<<5)`, `NounVS (1<<6)`. **Intermediate** types: `Initial (1<<7)` (the
  original word, before any rule), `TaTeStem (1<<8)`, `DaDeStem (1<<9)`, `MasuStem (1<<10)`,
  `IrrealisStem (1<<11)`.
- **Rule data** (`deinflectRuleData`) is a large `[from, to, fromType, toType, reasons]`
  table, **not reproduced here**. Each rule rewrites a suffix `from`→`to`, but only fires
  when the current candidate's type intersects the rule's masks. Intermediate stem types
  exist precisely to constrain *when* a rule may apply — e.g. the `ます`→`` rule only fires
  against a `MasuStem`, so `食べろます` won't be (mis)parsed as "imperative < polite". Rules are
  grouped by `from` length (`getDeinflectRuleGroups`) and applied longest-suffix-first.
- **Algorithm.** `deinflect` seeds `result` with the original word (type =
  `0xffff ^ (TaTeStem | DaDeStem | IrrealisStem)`, `reasonChains = []`) and iterates a
  worklist, applying matching rules to produce new candidates, accumulating reason chains.
  Ichidan verbs have a single stem, so the stem→plain-form expansion is done
  programmatically (with special handling so a masu-stem of an ichidan verb isn't deinflected
  further). The output is the full set of plausible base forms; `lookup.ts` decides which are
  real by querying the dictionary.

The unit tests (§8) are the authoritative spec for the engine's observable behavior.

---

## 6. Word extraction (`extract.ts`)

```ts
export interface CharPosition { node: Text; offset: number }   // DOM location of one char
export interface Extracted {
  text: string                 // the contiguous Japanese run around the tap
  tapOffset: number            // index of the tapped char within `text`
  positions: CharPosition[]    // positions[i] = where text[i] lives in the DOM
}
const MAX_BEFORE = 12   // word-chars gathered before the tap
const MAX_AFTER = 16    // word-chars gathered from the tap forward

export function extractTextAt(doc: Document, x: number, y: number): Extracted | null
export function rangeForSpan(doc, positions, start, end): Range | null   // text[start,end) → Range
export function looksJapanese(s: string): boolean
```

### `extractTextAt(doc, x, y)`

1. **Caret resolution** (`caretPosition`) — tries `doc.caretRangeFromPoint(x, y)` (WebKit /
   Chrome, returns a `Range`) first, then falls back to `doc.caretPositionFromPoint(x, y)`
   (Firefox, returns `{ offsetNode, offset }`). Returns `{ node, offset }` or `null`. Both are
   accessed via `doc as any` because TS lib types don't reliably declare them.
2. **Glyph hit-test** (`pointOnGlyph`, `extract.ts:42`) — the most important gate. Once the
   caret resolves, `extractTextAt` calls `pointOnGlyph(doc, pos.node, pos.offset, x, y)` and
   **returns `null` if `(x, y)` is not inside the caret glyph's box** (the gate at
   `extract.ts:89`). `caretRangeFromPoint` snaps to the *nearest* text even in blank margins
   and inter-column gaps, so on a wall-to-wall Japanese page it reports a hit almost everywhere;
   without this gate **every tap would define**. `pointOnGlyph` builds a `Range` over the single
   character at the caret offset (clamped to the node end), and checks whether the point lies in
   any of its client rects, expanded by `GLYPH_HIT_SLACK = 6` px (`extract.ts:33`). A
   blank-space tap therefore fails the test, `extractTextAt` returns `null`, and the tap falls
   through to the reader-chrome toggle in `handleTap` (§7). (Pagination is by **swipe**, handled
   in the controller, not by tap — see `docs/reader-engine.md`.)
3. **TreeWalker over text nodes**, rejecting furigana:

   ```ts
   const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
     acceptNode: (n) => (isInRuby(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
   })
   ```

4. **`isInRuby(node)`** — walks ancestors; returns `true` if any is `<rt>` or `<rp>` (the
   furigana / fallback-parenthesis ruby elements). **Crucially it compares
   `el.tagName.toUpperCase()`** — EPUB content is XHTML, where `tagName` is lowercase
   (`"rt"`), unlike HTML (`"RT"`). See the gotcha in §10.
5. **Tapped-char gate.** The tapped glyph is the character at `pos.offset`; if it is **not a
   word char** (`WORD_CHAR = /[぀-ヿ㐀-鿿豈-﫿ー々]/` — kana, CJK ideographs, the long-vowel mark
   `ー`, the iteration mark `々`), return `null` so a latin/punctuation tap falls through to the
   chrome toggle. This subsumes the old `looksJapanese` pre-filter `Reader.svelte` used to apply.
6. **Collect the run on both sides.** Using the ruby-skipping walker, gather the contiguous
   word-char run **forward** from the tap (`node.data.slice(pos.offset)` then successive text
   nodes, capped at `MAX_AFTER`, stopping at the first non-word char) and **backward** from the
   tap (`node.data.slice(0, pos.offset)` then previous text nodes, the trailing word-char run,
   capped at `MAX_BEFORE`). Each character's `{node, offset}` is tracked alongside it (not just
   the string). Punctuation / spaces / latin bound the run on each side, so it stays within one
   clause.
7. Returns `{ text, tapOffset, positions }` where `text = before + after`, `tapOffset =
   before.length` (so `text[tapOffset]` is the tapped char), and `positions[i]` is the DOM
   `{node, offset}` of `text[i]`. `lookupAt` (§4) then segments `text` and returns the word
   covering `tapOffset` — this is what makes tapping *any* character of a word resolve the
   **whole** word. `positions` lets the caller rebuild a `Range` for the matched span via
   `rangeForSpan(doc, positions, matchStart, matchStart+matchLength)` — used to auto-highlight
   the looked-up word (`docs/reader-engine.md` §10). The run can straddle multiple text nodes (a
   kanji compound with ruby splits its base text), so an index→node map, not a string offset, is
   the only safe bridge back to the DOM.

### `looksJapanese(s)`

A cheap test of the **first character** against the same `WORD_CHAR` class
(`/[぀-ヿ㐀-鿿豈-﫿ー々]/` — hiragana/katakana, CJK Unified + Compatibility Ideographs, `ー`, `々`).
Still exported, but the lookup gate now lives inside `extractTextAt` (step 5); keep it for any
caller wanting a quick "is this Japanese?" check.

---

## 7. Reader integration (`Reader.svelte`)

Tap handling flows: `ReaderController` raises a `TapInfo`
(`{ doc, ix, iy, px, py }` — `ix/iy` are iframe-local coordinates for the caret APIs,
`px/py` are top-window coordinates for positioning the popup) → `onTap` → `handleTap`. A tap
never turns the page (pagination is by horizontal **swipe**, handled in the controller — see
`docs/reader-engine.md`); it only dismisses an open overlay, defines a word, or toggles the
reader chrome:

```ts
function handleTap(info: TapInfo) {
  // An open dictionary popup swallows the tap (dismiss + consume).
  if (dictState.open) {
    dictState.open = false
    return
  }
  // A tap in the top/bottom edge band toggles the reader chrome.
  if (inChromeToggleBand(info.py)) {
    chromeVisible = !chromeVisible
    return
  }
  // Otherwise (central reading area): define a tapped Japanese word — and on a real
  // match, auto-highlight it yellow. A central blank tap does nothing.
  if (settings.tapToDefine) tryDefine(info)
}
```

The glyph hit-test inside `extractTextAt` (§6) is what lets a blank-space tap fall through
`tryDefine` to the chrome toggle instead of always defining.

### `tryDefine(info)` → `openDefine(...)`

`tryDefine` extracts the run and hands off to `openDefine`, which opens the popup in the
loading state and kicks off the async lookup:

```ts
function tryDefine(info: TapInfo): boolean {
  if (!info.doc) return false
  const ex = extractTextAt(info.doc, info.ix, info.iy)
  if (!ex) return false                 // null ⇒ blank / non-word tap (gate is in extract.ts)
  openDefine({ text: ex.text, tapOffset: ex.tapOffset, px: info.px, py: info.py,
               doc: info.doc, positions: ex.positions })   // positions ⇒ can highlight the word
  return true
}
```

`openDefine` also handles the **tap-on-existing-highlight** path (`onShowAnnotation` passes
`existingCfi` + the word, no `doc`/`positions`), so the same popup serves both "define a fresh
word" and "reopen a highlighted word." It sets `dictState.lastKey` (a stable per-lookup key used
to discard stale taps), `dictState.cfi`/`highlighted`/`word` (for the footer toggle), and stashes
the in-flight `doc`/`positions` so the matched word's range can be built after the lookup.

### `runLookup(text, tapOffset, key)`

```ts
async function runLookup(text: string, tapOffset: number, key: string) {
  if (!(await isDictReady())) {            // not downloaded yet → show download prompt
    if (!dictState.open || dictState.lastKey !== key) return
    dictState.loading = false
    dictState.needsDownload = true
    return
  }
  const res = await lookupAt(text, tapOffset)   // ← segment to the word under the tap
  // Ignore if the popup was dismissed or a newer tap superseded this lookup.
  if (!dictState.open || dictState.lastKey !== key) return
  dictState.loading = false
  dictState.result = res
  // On a real match for a fresh tap (not an already-highlighted word), auto-highlight it:
  // build the word range from the extract positions + res.matchStart/matchLength, CFI it,
  // saveAnnotation + controller.addHighlight. See docs/reader-engine.md §10.
  if (res && res.entries.length && !dictState.cfi && /* have doc+positions */ true) void autoHighlight(res, key)
}
```

The guard `!dictState.open || dictState.lastKey !== key` drops a late lookup two ways: if the
user has since **dismissed** the popup, or if a **newer tap** changed `lastKey` — so a slow
lookup never overwrites the popup with stale results. `autoHighlight` re-checks the same guard
after it builds the CFI (which is itself async-safe but cheap).

### `downloadDict()`

Triggered by the popup's download button (`ondownload`): calls `downloadDictionary('en')`,
clears `needsDownload`, sets `dictState.loading = true` (so the popup shows the spinner again
rather than the stale download prompt), and re-runs `runLookup(dictState.text,
dictState.tapOffset, dictState.lastKey)` so the originally-tapped word resolves once data is
present. Errors are swallowed here and surfaced via `dict.error` in the store.

### `DictionaryPopup.svelte`

Props: `{ open, x, y, loading, needsDownload, result, highlighted, ondownload, ontogglehighlight }`.
It positions itself near `(x, y)`, clamped to the viewport (prefers above the tap, flips below
if cramped), and renders one of four states in a scrolling `.body`, with a sticky `.actions`
footer (shown only when `result` has entries) holding a single **highlight toggle** — `Remove
highlight` when `highlighted`, else `Highlight` (a yellow swatch). The toggle calls
`ontogglehighlight` and the card stays open. The four body states:

| State | Renders |
| --- | --- |
| `loading` | a spinner |
| `needsDownload` | "Dictionary not installed" + a **Download** button; while `dict.updating`, a progress bar reading `dict.progress`; `dict.error` if present |
| `result` (truthy) | reason **chips** (`result.reasons`), then per-entry `headword` + (non-kana) `reading` + `[pitch]`, and an ordered list of senses (POS + `; `-joined glosses) |
| else | a "No dictionary match." empty state with a search icon |

### Reaching download from settings

The dictionary download is **also** reachable from **Shelf Settings**
(`src/lib/library/ShelfSettings.svelte`), which has a "Japanese dictionary" section showing
`dict.state`/`dict.progress` and a **Download** button. The button calls a local `getDict()`
wrapper that `try`/`catch`es `downloadDictionary('en')` and surfaces any failure via
`dict.error`. `ShelfSettings` calls `getDb()` on mount purely to initialize the status
readout. The dictionary is the only language feature, and word lookups are always English
glosses, so `downloadDictionary` is invoked with a hardcoded `'en'` at every call site
(here and in `Reader.svelte`'s `downloadDict`).

---

## 8. Tests

`src/services/jp/deinflect.test.ts` (Vitest) is the spec for the deinflection engine. A
helper `bases(surface)` returns `deinflect(surface).map(c => c.word)`; the cases assert the
plain form is among the candidates:

| Surface form | Expected base | Inflection covered |
| --- | --- | --- |
| `食べていました` | `食べる` | ichidan te-form + continuous + polite past |
| `美しかった` | `美しい` | i-adjective past |
| `走った` | `走る` | godan past |
| `読みたい` | `読む` | -tai (desiderative) |
| `行こう` | `行く` | volitional |
| `見られた` | `見る` | passive / potential |
| `猫` | `猫` | surface form always included as a candidate |

A final test confirms that the `食べる` candidate produced from `食べていました` carries a
non-empty `reasonChains` (i.e. deinflected candidates are tagged with their reasons).

Run with `npm test`.

---

## 9. How to extend

- **Kanji / name lookup.** `@birchill/jpdict-idb` exports `getKanji({ kanji, lang })` and
  `getNames(search)` (plus their `'kanji'`/`'names'` series). Download those series via
  `updateWithRetry({ series: 'kanji' | 'names', … })` and add new render paths. `getKanji`
  returns rich `KanjiResult`s (readings, radicals, components, references).
- **Graphical pitch accent.** `DictEntry.pitch` is currently shown as `[n]`. Combine it with
  `countMora`/`moraSubstring` from `@birchill/normal-jp` to draw a proper pitch-accent
  contour over the reading.
- **Tighten `candidateMatches`.** Replace the coarse `INFLECTABLE` regex with the full
  `WordType`↔JMdict-POS mapping so a candidate's `cand.type` bitfield must actually match the
  entry's class (reference 10ten's `word-search` / `getMatchingCandidates`). This removes
  false positives where an unrelated inflectable entry shares a deinflected spelling.
- **Self-host the dictionary data.** Downloads currently hit `data.10ten.life`. Mirror the
  data files and point jpdict-idb at your own origin if you need to remove the third-party
  dependency or control versioning.
- **Saved words.** Persist tapped `DictEntry`s (e.g. in the existing IndexedDB layer, see
  `docs/storage-pwa-ios.md`) for a review/flashcard feature.

---

## 10. Gotchas

- **XHTML lowercase `tagName` ruby bug (fixed).** EPUB content documents are XHTML, so
  `Element.tagName` is **lowercase** (`"rt"`), unlike HTML's uppercase. `isInRuby` must
  normalize via `el.tagName.toUpperCase()` before comparing to `'RT'`/`'RP'`. Without this the
  furigana-skip would silently fail and readings would pollute the lookup window. Preserve the
  case-insensitive compare in any edits to `extract.ts`.
- **`toNormalized` returns a TUPLE, not an object.** Its signature is
  `toNormalized(input: string): [string, number[]]` — destructure `const [normalized] = …`.
  Treating it as `{ result }` silently yields `undefined`.
- **GPL.** Editing/redistributing requires honoring GPL-3.0-or-later (see §2). Reimplement
  `deinflect.ts` to relicense.
- **First download is several MB.** The initial `words` series download is multi-MB over the
  network. The UI must surface progress (`dict.progress`, progress bar) and tolerate offline
  failure (`dict.error`, `onUpdateError`). All later lookups are offline.
- **`getWords` uses `matchType: 'exact'`.** Lookup relies on exact-key matching (`limit: 8`).
  The longest-match loop is what provides "segmentation"; `getWords` itself does no fuzzy or
  prefix matching here (`'startsWith'` is available but unused).
- **`updateWithRetry` returns `void`.** Progress/completion/failure are delivered only via
  `onUpdateComplete` / `onUpdateError` and the change listener — there is no awaitable result;
  `downloadDictionary` manually bridges this into a promise.
- **`dict.state === 'ok'` is the only "ready" state.** `'init'`/`'empty'` mean not-yet-usable;
  `'unavailable'` means the DB couldn't be opened.
- **Dictionary popup keys must be unique (fixed).** `DictionaryPopup.svelte`'s `{#each
  result.entries (…)}` key includes the array index (`entry.headword + entry.reading + ':' + i`).
  JMdict has homographs with identical headword+reading (e.g. several 度/ど entries), so keying
  on `headword + reading` alone throws Svelte's `each_key_duplicate` and the popup hangs on the
  spinner. Keep the index in the key.
- **kuromoji loads lazily and segments on the main thread.** The first tap-to-define triggers a
  one-time ~19 MB IPADIC fetch + trie build (then SW-cached). Until it's ready, segmentation
  falls back to greedy. The gzip-decompression loader shim (`kuromojiLoader.cjs`) is required —
  see the note in §4 and `docs/development.md`.

---

## 11. Cross-references

- `docs/reader-engine.md` — how taps are captured in the foliate-rendered iframe and turned
  into `TapInfo` (`ix/iy` iframe-local vs `px/py` top-window coordinates) before reaching
  `tryDefine`.
- `docs/storage-pwa-ios.md` — the IndexedDB / persistence layer (jpdict-idb keeps its own
  IndexedDB database; relevant to storage-quota and iOS-eviction concerns).
- `docs/architecture.md` — where this subsystem sits in the overall app.
