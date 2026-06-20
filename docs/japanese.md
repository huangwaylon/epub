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

The approach is borrowed wholesale from the **10ten Japanese Reader** browser extension:

1. **Extract** a short run of text (≤16 chars) starting at the tap point, skipping furigana
   (`src/services/jp/extract.ts`).
2. For each candidate length `len` (longest first), take `window.slice(0, len)`, normalize
   it, and **deinflect** it into a set of plain/base-form candidates
   (`src/services/jp/deinflect.ts`).
3. Look each candidate up in the JMdict IndexedDB via `getWords(..., { matchType: 'exact' })`
   (`@birchill/jpdict-idb`).
4. **Longest match wins**: the first `len` that yields a valid dictionary entry is returned;
   shorter lengths are never tried. This mirrors how Japanese (which has no inter-word
   spaces) must be greedily segmented from the cursor.

The orchestration is in `src/services/jp/lookup.ts`; readiness/download lifecycle is in
`src/services/jp/dictdb.ts`; reactive UI state is the `dict` store
(`src/stores/dict.svelte.ts`); the popup is `src/lib/reader/DictionaryPopup.svelte`; and the
tap→lookup wiring lives in `src/lib/reader/Reader.svelte`.

---

## 2. Packages & licensing

| Package | Role | Key exports used |
| --- | --- | --- |
| `@birchill/jpdict-idb` | The dictionary database: downloads JMdict into IndexedDB and queries it. | `JpdictIdb`, `getWords`, `updateWithRetry`, `cancelUpdateWithRetry`, types `WordResult`, `DataSeriesState`, `UpdateState` |
| `@birchill/normal-jp` | Japanese text normalization. | `toNormalized`, `kanaToHiragana` |

Both are by Birchill (the 10ten author), published under permissive licenses.

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
backoff. `cancelDownload` calls `cancelUpdateWithRetry({ db, series: 'words' })`.

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
  matchLength: number  // # chars from the start of the window that matched
  reasons: string[]    // human-readable deinflection reasons, outermost first
  entries: DictEntry[]
}
```

### `lookup(window: string): Promise<LookupResult | null>`

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
    const words = await queryWords(cand.word)   // getWords, memoized within this call
    if (!words.length) continue
    const matched = words.filter((w) => candidateMatches(w, cand))
    if (!matched.length) continue
    return {
      matchLength: len,
      reasons: reasonsToLabels(cand.reasonChains),
      entries: matched.map(toEntry),
    }
  }
}
return null
```

Step by step:

1. **Window cap.** `len` iterates from `min(window.length, 16)` down to `1`. Longest-first
   gives greedy longest-match segmentation (e.g. for `食べていました…` the full inflected verb
   is matched before any shorter prefix).
2. **Normalize.** `toNormalized(sub)` returns a **tuple** `[normalized, inputLengths]`; only
   the string is used (`const [normalized] = ...`). It folds width/case, katakana→hiragana,
   long-vowel marks, etc., into a canonical lookup key.
3. **Deinflect.** `deinflect(normalized)` returns `CandidateWord[]`, always including the
   surface form itself plus every plausible reverse-conjugation.
4. **Query (memoized).** `queryWords(term)` wraps `getWords(term, { matchType: 'exact', limit: 8 })`
   in a per-call `Map` cache, so identical candidate strings across different `len`/candidate
   combinations are queried once.
5. **Filter.** `candidateMatches(word, cand)` discards deinflections that don't make sense for
   the matched dictionary entry's part of speech (below).
6. **Return first hit.** The first `len` with ≥1 surviving entry wins; the function returns
   immediately. Returns `null` if nothing matched at any length.

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

Japanese has no spaces, so the segmenter must greedily consume the longest valid dictionary
form from the cursor. The `MAX_WINDOW = 16` cap bounds both the extraction window (§6) and the
lookup loop, and `getWords` results are memoized within a single `lookup` call, keeping a tap
to a small, bounded number of IndexedDB reads.

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
export interface Extracted { text: string; startNode: Text; startOffset: number }
const MAX_CHARS = 16

export function extractTextAt(doc: Document, x: number, y: number): Extracted | null
export function looksJapanese(s: string): boolean
```

### `extractTextAt(doc, x, y)`

1. **Caret resolution** (`caretPosition`) — tries `doc.caretRangeFromPoint(x, y)` (WebKit /
   Chrome, returns a `Range`) first, then falls back to `doc.caretPositionFromPoint(x, y)`
   (Firefox, returns `{ offsetNode, offset }`). Returns `{ node, offset }` or `null`. Both are
   accessed via `doc as any` because TS lib types don't reliably declare them.
2. **TreeWalker over text nodes**, rejecting furigana:

   ```ts
   const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
     acceptNode: (n) => (isInRuby(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
   })
   ```

3. **`isInRuby(node)`** — walks ancestors; returns `true` if any is `<rt>` or `<rp>` (the
   furigana / fallback-parenthesis ruby elements). **Crucially it compares
   `el.tagName.toUpperCase()`** — EPUB content is XHTML, where `tagName` is lowercase
   (`"rt"`), unlike HTML (`"RT"`). See the gotcha in §10.
4. **Collect forward.** Positions the walker at the tapped text node (or the next text node if
   the tap landed on a non-text node / inside ruby), then appends `node.data` from successive
   accepted text nodes until `MAX_CHARS` (16) is reached, slicing to exactly 16. Returns
   `null` if the result is whitespace-only.
5. Returns `{ text, startNode, startOffset }` — `startNode`/`startOffset` are kept for
   highlighting the matched range (the popup itself does not currently consume them).

### `looksJapanese(s)`

A cheap pre-filter testing only the **first character** against
`/[぀-ヿ㐀-鿿豈-﫿ー々]/` — hiragana/katakana block, CJK Unified Ideographs, CJK
Compatibility Ideographs, the long-vowel mark `ー`, and the iteration mark `々`. Used to bail
out before doing any dictionary work on non-Japanese taps.

---

## 7. Reader integration (`Reader.svelte`)

Tap handling flows: `ReaderController` raises a `TapInfo`
(`{ doc, ix, iy, px, py, zone }` — `ix/iy` are iframe-local coordinates for the caret APIs,
`px/py` are top-window coordinates for positioning the popup) → `onTap` → `handleTap`. The
dictionary takes priority when enabled:

```ts
function handleTap(info: TapInfo) {
  if (settings.tapToDefine && tryDefine(info)) return   // dictionary wins
  // …otherwise paging / chrome toggle by info.zone
}
```

### `tryDefine(info): boolean`

```ts
function tryDefine(info: TapInfo): boolean {
  const ex = extractTextAt(info.doc, info.ix, info.iy)
  if (!ex || !looksJapanese(ex.text)) return false
  dictState.open = true
  dictState.x = info.px; dictState.y = info.py
  dictState.loading = true
  dictState.needsDownload = false
  dictState.result = null
  dictState.lastText = ex.text          // ← used to discard stale taps
  void runLookup(ex.text)
  return true
}
```

Returns `true` (consuming the tap) only when Japanese text was found. It opens the popup in
the loading state immediately, then kicks off the async lookup.

### `runLookup(text)`

```ts
async function runLookup(text: string) {
  if (!(await isDictReady())) {            // not downloaded yet → show download prompt
    dictState.loading = false
    dictState.needsDownload = true
    return
  }
  const res = await lookup(text)
  if (dictState.lastText !== text) return  // a newer tap superseded this lookup — drop it
  dictState.loading = false
  dictState.result = res
}
```

The **`lastText` guard** prevents a slow lookup from overwriting the popup with stale results
after the user has tapped a different word.

### `downloadDict()`

Triggered by the popup's download button (`ondownload`): calls `downloadDictionary('en')`,
clears `needsDownload`, and re-runs `runLookup(dictState.lastText)` so the originally-tapped
word resolves once data is present. Errors are swallowed here and surfaced via `dict.error`
in the store.

### `DictionaryPopup.svelte`

Props: `{ open, x, y, loading, needsDownload, result, ondownload }`. It positions itself near
`(x, y)`, clamped to the viewport (prefers above the tap, flips below if cramped), and renders
one of four states:

| State | Renders |
| --- | --- |
| `loading` | a spinner |
| `needsDownload` | "Dictionary not installed" + a **Download** button; while `dict.updating`, a progress bar reading `dict.progress`; `dict.error` if present |
| `result` (truthy) | reason **chips** (`result.reasons`), then per-entry `headword` + (non-kana) `reading` + `[pitch]`, and an ordered list of senses (POS + `; `-joined glosses) |
| else | a "No dictionary match." empty state with a search icon |

### Reaching download from settings

The dictionary download is **also** reachable from **Shelf Settings**
(`src/lib/library/ShelfSettings.svelte`), which has a "Japanese dictionary" section showing
`dict.state`/`dict.progress` and a **Download** button calling `downloadDictionary('en')`. It
calls `getDb()` on mount purely to initialize the status readout. (A separate "Translation
language" segmented control there is for sentence translation, not word lookup — word lookups
are always English glosses.)

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

---

## 11. Cross-references

- `docs/reader-engine.md` — how taps are captured in the foliate-rendered iframe and turned
  into `TapInfo` (`ix/iy` iframe-local vs `px/py` top-window coordinates) before reaching
  `tryDefine`.
- `docs/storage-pwa-ios.md` — the IndexedDB / persistence layer (jpdict-idb keeps its own
  IndexedDB database; relevant to storage-quota and iOS-eviction concerns).
- `docs/architecture.md` — where this subsystem sits in the overall app.
