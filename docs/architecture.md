# Tsuzuri — System Architecture

This is the system-level map for **Tsuzuri** (綴), an installable iOS PWA for
reading Japanese EPUBs. It is written for engineers and LLM agents working on the
codebase. Every claim here is derived from the source under `src/`, `scripts/`,
and `.github/workflows/`. For deep dives, see the [cross-references](#9-cross-references).

---

## 1. Overview

Tsuzuri is a single-page, offline-first reader that renders reflowable EPUBs
paginated like Apple Books. It is built for Japanese books but works for any
EPUB. Defining features:

- **Paginated 縦書き / 横書き reading.** CSS multi-column pagination via
  vendored foliate-js, honouring each book's declared writing mode and
  page-progression direction (`dir: 'ltr' | 'rtl'`), with a manual 縦/横 override
  (`settings.writingMode`). Pages turn by horizontal swipe (direction-aware);
  a tap defines a word or toggles the reader chrome.
- **Offline 10ten-style tap-to-define.** Tap a word → the Japanese run *around* the
  tap is extracted (skipping `<rt>/<rp>` furigana), then **segmented** so the whole
  word under the tapped character is found (deinflected via the vendored 10ten engine)
  and looked up in JMdict held in IndexedDB. Shows reading, pitch accent, POS, and
  deinflection reasons. Fully offline after a one-time dictionary download. The
  dictionary is the only language feature; the app is fully client-side, no backend.
- **Highlights & bookmarks.** CFI-anchored (survive reflow / font changes), four
  highlight colours, notes/bookmarks panel.
- **Installable PWA.** Add-to-Home-Screen on iOS, edge-to-edge layout, persistent
  storage, service-worker app-shell precache, "update ready" toast.

---

## 2. Tech stack & rationale

| Tech | Where | Why |
|---|---|---|
| **Svelte 5 (runes)** `^5.55.5` | all UI + stores | Fine-grained reactivity via `$state`/`$derived`/`$effect`; stores are plain module-level rune singletons (no store contract needed). Mounted imperatively via `mount()`. |
| **Vite** `^8` + **vite-plugin-pwa** `^1.3` | build / SW | Fast ESM dev server; PWA plugin generates the Workbox service worker + manifest. `worker.format: 'es'` for jpdict's worker. |
| **foliate-js** (vendored, **MIT**) | `src/vendor/foliate-js` | EPUB parsing + paginated rendering as a `<foliate-view>` custom element. Vendored (not npm) so `pdf.js` could be removed and `view.js` / `paginator.js` patched (two documented "TSUZURI PATCH" edits). No hard deps. |
| **@birchill/jpdict-idb** `^3.3` | `src/services/jp/dictdb.ts` | Downloads JMdict from data.10ten.life into its own IndexedDB and serves offline `getWords` lookups. |
| **@birchill/normal-jp** `^1.7` | jp lookup/deinflect | `toNormalized` (normalise lookup window) and `kanaToHiragana` (deinflection). |
| **@sglkc/kuromoji** `^1.1` | `src/services/jp/segment.ts` | MeCab-style IPADIC morphological analyser → word segmentation for tap-to-define (Apache-2.0). Ships a ~19 MB dict (staged to `public/kuromoji/dict/`, runtime-cached). |
| **vendored 10ten deinflect (GPL-3.0)** | `src/services/jp/deinflect.ts` | Verb/adjective deinflection rules + algorithm copied from 10ten-ja-reader. **⚠ GPL-3.0-or-later — see [§8](#8-key-design-decisions--trade-offs).** License at `src/services/jp/LICENSE-10ten`. |
| **idb** `^8` | `src/services/storage/db.ts` | Promise wrapper over IndexedDB for the app's structured data. |
| **sharp** + **fflate** (devDeps) | `scripts/*.mjs` | **Dev tooling only.** `gen-icons.mjs` rasterises PWA icons (sharp); `make-test-epub.mjs` builds a test EPUB (fflate + sharp). Not shipped. |
| **vitest** (devDep) | `*.test.ts` | Unit tests (e.g. `src/services/jp/deinflect.test.ts`). |

Runtime npm dependencies are four: `@birchill/jpdict-idb`, `@birchill/normal-jp`,
`@sglkc/kuromoji`, `idb`. foliate-js and the 10ten deinflect engine are vendored
into the tree, not installed.

---

## 3. Layered architecture

Strict downward dependency: UI imports stores and services; stores import
services; services import vendored engines and browser APIs. Vendored engines
import nothing from the app.

```
┌──────────────────────────────────────────────────────────────────────┐
│  UI LAYER — Svelte 5 components (src/App.svelte, src/lib/**)            │
│  Shelf, Reader, Sheets, popups, toolbars. Read stores, call services.  │
└───────────────┬──────────────────────────────────┬───────────────────┘
                │ read/mutate                       │ call
                ▼                                    ▼
┌───────────────────────────────┐   ┌──────────────────────────────────┐
│  STORES — src/stores/*.svelte.ts│  │  SERVICES — src/services/*         │
│  Rune singletons ($state).      │  │  Framework-agnostic logic:         │
│  settings, library, annotations,│──▶│  reader (ReaderController),       │
│  dict, nav, pwa.                │   │  library, jp/*,                    │
│  Mutate via exported fns →      │   │  storage/* (db, blobs, persist).   │
│  call services + persist.       │   └───────────────┬──────────────────┘
└─────────────────────────────────┘                   │ wraps / drives
                                                       ▼
                                   ┌──────────────────────────────────────┐
                                   │  VENDORED ENGINES — src/vendor/        │
                                   │  foliate-js: <foliate-view>, makeBook, │
                                   │  Overlayer, epub/epubcfi/paginator…    │
                                   │  + jp/deinflect.ts (10ten, GPL)        │
                                   └────────────────┬───────────────────────┘
                                                    │ browser platform
                                                    ▼
                          OPFS (EPUB bytes) · IndexedDB (idb: structured data;
                          jpdict-idb: JMdict) · Service Worker
```

`src/main.ts` is the entry point ([§7](#7-entry-point--routing)). The app is fully
client-side with no backend; it ships as static files to GitHub Pages
([§8](#8-key-design-decisions--trade-offs), [deployment.md](./deployment.md)).

---

## 4. Module map

### Root / build
| Path | Responsibility |
|---|---|
| `index.html` | App shell; iOS PWA meta (status-bar, viewport-fit=cover), theme-color, mounts `/src/main.ts`. |
| `vite.config.ts` | Vite + svelte + VitePWA (manifest, Workbox precache, `registerType: 'prompt'`, dev SW enabled); production `base: '/epub/'`, dev `base: '/'`. |
| `vitest.config.ts` | Test runner config. |
| `svelte.config.js`, `tsconfig*.json` | Svelte/TS compiler config. |
| `package.json` | Scripts (`dev`/`build`/`preview`/`test`/`check`); 3 runtime deps; dev tooling. |
| `.github/workflows/deploy.yml` | CI: build on push to `main` and deploy `dist/` to GitHub Pages. See [deployment.md](./deployment.md). |
| `public/` | `favicon.svg`, `icons/*.png` (PWA icons). |
| `dev-dist/` | Generated dev service worker output (not source). |
| `test-books/` | `tsuki-to-neko.epub` test fixture. |

### Entry & app
| Path | Responsibility |
|---|---|
| `src/main.ts` | Entry: `await initSettings()`, `requestPersistence()`, `registerSW()` (wires `pwa` store), `mount(App)`. |
| `src/App.svelte` | Top-level router view: `{#if nav.route.name === 'reader'}` → `Reader` (keyed on `bookId`), else `Shelf`; always renders `UpdateToast`. |
| `src/app.css` | Design tokens (CSS vars) for light/sepia/dark themes via `[data-theme]`; fonts, safe-area insets, base styles. |
| `src/vite-env.d.ts` | Ambient types (incl. `virtual:pwa-register`). |

### UI — stores (`src/stores/*.svelte.ts`)
| Path | Responsibility |
|---|---|
| `settings.svelte.ts` | Global `ReaderSettings` `$state`; `initSettings` (hydrate from IDB), `updateSettings` (mutate+persist), `applyTheme` (sets `<html data-theme>` + theme-color meta). |
| `library.svelte.ts` | Shelf `$state`: `books`, `progress`, `loading`, `importing`. `refreshLibrary`, `importFiles`, `deleteBook`, `markOpened`. |
| `annotations.svelte.ts` | Current book's `items` (highlights+bookmarks). `loadAnnotations`, `clearAnnotations`, `saveAnnotation`, `removeAnnotation`, `newId` (UUID). |
| `dict.svelte.ts` | Dictionary status `$state`: `state` (`init`/`empty`/`ok`/`unavailable`), `updating`, `progress`, `error`. (Mutated by `jp/dictdb.ts`.) |
| `nav.svelte.ts` | In-memory router: `route` (`{name:'shelf'} | {name:'reader',bookId}`), `openReader`, `openShelf`. |
| `pwa.svelte.ts` | SW update state: `needRefresh`, `offlineReady`, `update()`. Set by `main.ts`. |

### UI — components (`src/lib/**`)
| Path | Responsibility |
|---|---|
| `lib/library/Shelf.svelte` | Library screen: grid of books, import (`<input type=file multiple>`), progress ring, long-press action sheet (delete), settings sheet. |
| `lib/library/BookCover.svelte` | Cover image from `book.cover` Blob (object URL, revoked on cleanup); hashed-hue placeholder spine fallback. |
| `lib/library/ShelfSettings.svelte` | App settings sheet: theme, dictionary download/status, storage usage. |
| `lib/reader/Reader.svelte` | **The reader screen.** Owns a `ReaderController`, wires all callbacks (relocate/tap/turn/selection/show-annotation), manages chrome bars, dictionary popup (with the highlight toggle), selection toolbar, progress scrubber, sheets (TOC/settings/notes), progress persistence, bookmark toggle. |
| `lib/reader/ReaderSettings.svelte` | Display sheet: theme, serif/sans, font-size/line-height/margin steppers, writing-mode segmented; emits `onchange('appearance'\|'layout'\|'writingmode')`. |
| `lib/reader/TocSheet.svelte` | Flattens `book.toc` (with depth) → tappable nav list; highlights current section. |
| `lib/reader/DictionaryPopup.svelte` | Tap-to-define card: positioned near tap (viewport-clamped); loading / needs-download / results states; download CTA. |
| `lib/reader/SelectionToolbar.svelte` | Floating toolbar over a selection: colour swatches, copy, delete (reused for both new-selection and highlight-edit modes). |
| `lib/reader/AnnotationsPanel.svelte` | Notes sheet: tabs for highlights/bookmarks, sorted, tap to `goTo(cfi)`. |
| `lib/components/Sheet.svelte` | Bottom-sheet primitive (scrim, grip, `$bindable open`, title). |
| `lib/components/Segmented.svelte` | Generic segmented control (`<T extends string\|number>`). |
| `lib/components/Icon.svelte` | Inline 24×24 stroke-icon set (`PATHS` map, `currentColor`). |
| `lib/components/UpdateToast.svelte` | Reads `pwa` store; "new version ready → Refresh" toast. |
| `lib/actions/longpress.ts` | Svelte action: fires `onlongpress` after a stationary press-and-hold (shelf context menu). |
| `lib/util/debounce.ts` | Trailing-edge `debounce` (used for progress saves). |
| `lib/util/anchoredPosition.ts` | `placeAnchored` — viewport-clamped (safe-area-aware) positioning for the dictionary popup and selection toolbar. |

### Services (`src/services/*.ts`)
| Path | Responsibility |
|---|---|
| `services/types.ts` | Core data model: `BookMeta`, `ReadingProgress`, `Annotation`, `ReaderSettings`, `DEFAULT_SETTINGS`, `HIGHLIGHT_HEX`. The persisted shapes. |
| `services/library.ts` | `importEpub` (sha-256 dedupe → OPFS bytes → foliate `makeBook` metadata/cover), `listBooks`, `touchBook`, `removeBook`; re-exports `getBookFile`. |
| `services/reader.ts` | **`ReaderController`** — creates/owns one `<foliate-view>`; injects appearance CSS from live theme tokens; applies page geometry; detects writing mode; custom pointer handling → swipe-to-turn + `TapInfo`; selection geometry → `SelectionInfo`; highlight add/remove/reapply (single yellow); `goToFraction` for the scrubber; CFI for selections. |

### Services — storage (`src/services/storage/`)
| Path | Responsibility |
|---|---|
| `storage/db.ts` | `idb`-backed IndexedDB `tsuzuri` (v1): stores `books`, `progress`, `annotations` (`byBook` index), `settings`, `bookBlobs`. CRUD + `deleteBookCascade`. |
| `storage/blobs.ts` | EPUB bytes: OPFS (`navigator.storage.getDirectory`, `books/<id>.epub`) with capability probe; **IndexedDB `bookBlobs` fallback**. `putBook`, `getBookFile` (returns a `File`), `deleteBook`. |
| `storage/persist.ts` | `requestPersistence` (`navigator.storage.persist`), `storageStatus` (`estimate`), `formatBytes`. |

### Services — Japanese (`src/services/jp/`)
| Path | Responsibility |
|---|---|
| `jp/dictdb.ts` | Single shared `JpdictIdb`; `getDb`, `isDictReady`, `downloadDictionary`/`ensureDictionary` (jpdict `updateWithRetry`), `cancelDownload`; mirrors state into the `dict` store. |
| `jp/extract.ts` | `extractTextAt(doc,x,y)`: caret-from-point → glyph hit-test → tree walker (rejecting `<rt>/<rp>`) gathering the word-char run on both sides of the tap → `{text, tapOffset}`. `looksJapanese`. |
| `jp/deinflect.ts` | **Vendored 10ten (GPL-3.0).** `deinflect(word)` → candidate words + reason chains; `Reason`/`WordType` enums; rule table. |
| `jp/lookup.ts` | `lookupAt(text, tapOffset)`: word under the tap = kuromoji's token (`segment.ts`) then `matchAt` from its start (normalise → `deinflect` → `getWords` exact → filter inflectable POS → `DictEntry`), with a greedy leftmost-covering fallback while kuromoji loads. POS/reason label maps. (`lookup(window)` = forward-only wrapper.) |
| `jp/segment.ts` | kuromoji (`@sglkc/kuromoji`, MeCab/IPADIC) tokenizer singleton: `ensureSegmenter` (lazy ~19 MB dict load, SW-cached), `segmenterReady`, `tokenStartAt`. `kuromojiLoader.cjs` is its gzip loader shim (aliased in `vite.config.ts`). |
| `jp/deinflect.test.ts` | Vitest unit tests for the deinflection engine. |
| `jp/LICENSE-10ten` | GPL-3.0 license text for the vendored deinflect code. |

### Vendored engine (`src/vendor/foliate-js/`)
| Path | Responsibility |
|---|---|
| `view.js` | Defines `<foliate-view>` (`class View extends HTMLElement`) + `makeBook(file)`; the only entry imported by the app (`reader.ts`, `library.ts`). |
| `overlayer.js` | `Overlayer` — draws highlight/underline annotation overlays (used for highlight rendering). |
| `epub.js`, `epubcfi.js` | EPUB container parsing; CFI generation/resolution (annotation/progress anchors). |
| `paginator.js`, `fixed-layout.js` | Reflowable (CSS columns) and fixed-layout renderers. |
| `mobi.js`, `fb2.js`, `comic-book.js` | Other format parsers (present but app is EPUB-focused). |
| `progress.js`, `search.js`, `tts.js`, `footnotes.js`, `dict.js`, `opds.js`, `quote-image.js`, `text-walker.js`, `uri-template.js` | foliate subsystems (progress, search, TTS, footnote popovers, etc.); mostly unused by Tsuzuri's UI. |
| `vendor/fflate.js`, `vendor/zip.js` | foliate's own zip/inflate deps. |
| `LICENSE` | MIT (John Factotum). |

### Scripts & CI
| Path | Responsibility |
|---|---|
| `scripts/gen-icons.mjs` | Rasterises inline SVG → `public/icons/*.png` (sharp). |
| `scripts/make-test-epub.mjs` | Generates a vertical-writing RTL JP EPUB3 test fixture (fflate + sharp). |
| `.github/workflows/deploy.yml` | Builds and deploys `dist/` to GitHub Pages on push to `main` (Node 22; strips local-only `sharp`). See [deployment.md](./deployment.md). |

---

## 5. Runtime data flows

### (a) Import an EPUB
`Shelf.svelte` file input → `library.importFiles(files)` (filters `.epub`,
increments `library.importing`) → `services/library.importEpub(file)`:
`file.arrayBuffer()` → `sha256Hex` = `id`. If `getBookMeta(id)` exists, bump
`lastOpenedAt` and return (dedupe). Else `storage/blobs.putBook(id, buf)`
(OPFS or IDB fallback), then `makeBook(...)` (foliate) extracts
title/author/language/`dir`/`cover` → `putBookMeta(meta)`. After all files,
`refreshLibrary()` reloads `library.books` + per-book `getProgress`.

### (b) Open & read a book
`Shelf` → `markOpened(id)` → `nav.openReader(id)`. `App.svelte` swaps to
`Reader` (keyed on `bookId`, so a new book remounts cleanly). `Reader.onMount`:
`Promise.all([getBookMeta, getBookFile, getProgress])` → `new ReaderController(host, settings, callbacks)`
(creates `<foliate-view>`) → `controller.open(file, progress?.cfi)`:
`view.open(file)`, wires `relocate`/`load`/`show-annotation`/`create-overlay`/`draw-annotation`,
`applyAppearance` + `applyLayout`, then `view.init({lastLocation, showTextStart})`
to restore position; a single `#nudgeLayout()` re-render (~250ms, `reader.ts:216`)
plus a 150ms-debounced resize listener (`reader.ts:283`) hedge against first-paint
under-measurement. TOC read from `controller.view.book.toc`. Then
`loadAnnotations(bookId)` + `controller.setHighlights(...)` seed overlays.
Page turns are by horizontal swipe (`onTurn`); a tap defines a word or toggles
chrome (see [§5(c)](#c-tap--define--turn--toggle-chrome)).

### (c) Tap → define / turn → toggle chrome
The reader's only gestures are **swipe** and **tap**, both detected in
`ReaderController`'s `pointerup` handler on the content doc (`reader.ts:508-515`).
foliate's own touch page-turn is patched out (a documented "TSUZURI PATCH" in
`paginator.js`), so all navigation is ours:

- **Swipe** (horizontal, `|dx| ≥ SWIPE_MIN_DISTANCE` = 45px and `|dx| > |dy|`,
  no active selection) turns the page: drag left → `goRight()`, drag right →
  `goLeft()` ("page follows the finger"). `goLeft`/`goRight` are foliate's
  direction-aware nav, so the turn goes the right way in LTR, RTL, and 縦書き;
  they animate as a horizontal slide and fire `onTurn`.
- **Tap** (no swipe) → `onTap` → `handleTap`: if the dictionary popup is open,
  dismiss it; else if `settings.tapToDefine` and the tap hit a Japanese glyph,
  `tryDefine(info)`; else toggle the reader chrome. **A tap never turns the page.**

`tryDefine(info)`: `jp/extract.extractTextAt(doc, ix, iy)` (caret-from-point,
glyph hit-test, gathers the word-char run on **both sides** of the tap skipping
furigana → `{text, tapOffset}`; null on a blank/non-word tap). Opens
`DictionaryPopup` (loading) and `runLookup(text, tapOffset, key)`:
`dictdb.isDictReady()`; if not, popup shows download CTA → `downloadDictionary('en')`.
If ready, `jp/lookup.lookupAt(text, tapOffset)`: **segments** the run — scans starts
0..tapOffset, longest-match each (`toNormalized` → `deinflect` → `getWords(term, {exact})`
→ filter inflectable POS), returns the leftmost match covering the tap → `DictEntry[]`.
A stale-tap guard (`dictState.lastKey`) discards superseded lookups. (When highlights
exist, the tap action is deferred ~60ms so a highlight hit-test can cancel it.)

### (d) Select / tap → highlight, bookmark
**Selection:** `selectionchange` (debounced 250ms) in the content doc →
`onSelection(SelectionInfo)` → `SelectionToolbar` over the selection rect.
**Highlight:** `createHighlight()` → `controller.cfiForSelection(doc, range)`
(`view.getCFI(index, range)`) → `annotations.saveAnnotation` (IDB + store) →
`controller.addHighlight(cfi)` → foliate `addAnnotation` draws (always yellow)
via the `draw-annotation` event. Tap-to-define also auto-highlights the looked-up
word the same way. Tapping an existing highlight fires foliate's `show-annotation`
→ `onShowAnnotation` → reopens the dictionary popup (definition + remove toggle).
**Bookmark:** footer button → `toggleBookmark()` toggles a `bookmark`-kind
`Annotation` at `currentCFI`. The notes panel (`AnnotationsPanel`) lists both and
navigates via `goTo(cfi)`.

### (e) Progress persistence
foliate `relocate` event → `ReaderController.onRelocate` → `Reader.onRelocate`
(updates `fraction`, `currentCFI`, `sectionLabel`) → `saveProgress` (debounced
600ms), but only once `userInteracted` is set by a gesture/navigation (`onTurn`,
`navigate`, `navAnnotation`) — the `relocate` event carries no `reason`, so intent
is tracked on the gesture side → `storage/db.putProgress({bookId, cfi, fraction, label, updatedAt})`.
On next open, `getProgress(bookId).cfi` is passed to `view.init({lastLocation})`.
The shelf reads `library.progress[id].fraction` for the cover ring.

---

## 6. State management model

State lives in **module-level Svelte 5 rune singletons** in
`src/stores/*.svelte.ts`. Each exports a deep-reactive `$state(...)` object that
components import and read directly (e.g. `library.books`, `settings.theme`).
**Mutation goes through exported functions**, never raw assignment from UI, so
that side effects (persistence, theme application, derived reloads) happen
together. Because `$state` is deep-reactive, in-place mutation
(`annotations.items.push(a)`, `Object.assign(settings, patch)`) is reactive.
Components derive view state locally with `$derived` and run side effects with
`$effect`. There is no global store framework — stores are plain modules.

| Store | Holds | Persisted via |
|---|---|---|
| `settings` | `ReaderSettings` (theme, fontScale, lineHeight, marginScale, fontFamily, writingMode, tapToDefine) | `db.saveSettings` / `loadSettings` (IDB key `reader`) |
| `library` | `books: BookMeta[]`, `progress`, `loading`, `importing` | books/progress in IDB; bytes in OPFS |
| `annotations` | `items: Annotation[]` for the open book | `db` annotations store (`byBook` index) |
| `dict` | dictionary `state` / `updating` / `progress` / `error` | (reflects jpdict-idb's own IndexedDB) |
| `nav` | `route` (shelf vs reader+bookId) | in-memory only |
| `pwa` | `needRefresh`, `offlineReady`, `update()` | in-memory; driven by `registerSW` |

---

## 7. Entry point & routing

`src/main.ts` runs at module top level:
1. `await initSettings()` — hydrate settings from IndexedDB and `applyTheme()`
   **before first paint** (`<html data-theme>` + theme-color meta).
2. `void requestPersistence()` — ask for durable storage (fire-and-forget).
3. `registerSW({ onNeedRefresh, onOfflineReady })` (`virtual:pwa-register`) —
   wires the `pwa` store; `pwa.update = () => updateSW(true)`.
4. `mount(App, { target: #app })` — Svelte 5 imperative mount.

**Routing** is a two-screen in-memory router (`nav.svelte.ts`). `App.svelte`:
`{#if nav.route.name === 'reader'}` renders `<Reader>` inside `{#key nav.route.bookId}`
(forces a clean remount per book), else `<Shelf>`. `<UpdateToast>` is always
mounted. `index.html` supplies iOS PWA meta and the `#app` mount target.

---

## 8. Key design decisions & trade-offs

- **foliate-js vendored, not npm.** It has no stable release and recommends
  vendoring. Copying it in lets us (1) **delete pdf.js** (EPUB-only; `globIgnores`
  also excludes `pdfjs` from precache) and (2) **patch it** directly — two
  documented "TSUZURI PATCH" edits: removing the PDF branch in `view.js`, and
  disabling foliate's own touch page-turn in `paginator.js` (`#onTouchMove` keeps
  `preventDefault()` but drops `scrollBy`; `#onTouchEnd` drops the velocity snap)
  so our own swipe handler owns navigation. License is MIT, so this is fine to ship.
- **Single `ReaderController` owns the `<foliate-view>`.** All foliate interaction
  (open, layout, appearance, taps, swipes, selections, CFIs, highlights) is funneled
  through one class (`services/reader.ts`); `Reader.svelte` only wires callbacks
  and renders chrome. Custom pointer handling replaces native gestures: a
  horizontal swipe turns the page (direction-aware), a tap defines a Japanese
  glyph or toggles chrome — see [§5(c)](#c-tap--define--turn--toggle-chrome).
- **Theme tokens are CSS vars applied two ways.** `applyTheme()` sets
  `<html data-theme>` (driving `--paper`, `--ink`, `--accent`… from `app.css`) and
  syncs the `theme-color` meta. The reader **reads those live tokens back**
  (`getComputedStyle`) and **injects them into the content iframe** via
  `appearanceCSS()` (`renderer.setStyles`), so the rendered page matches the app
  chrome exactly across themes/fonts. The content iframe is otherwise sandboxed.
- **Writing-mode override requires a reopen.** Vertical vs horizontal must be
  re-detected from the rendered document, so changing `settings.writingMode`
  calls `reopenForWritingMode(file)` (reopen at current CFI) rather than a live restyle.
- **Storage is split.** Large EPUB bytes → OPFS (durable, large quota on iOS
  16.4+) with an IndexedDB `bookBlobs` fallback; all structured data → IndexedDB
  (`idb`); JMdict → jpdict-idb's own IndexedDB. None of these go through the
  service worker (which only precaches the app shell).
- **⚠ GPL-3.0 constraint from vendored deinflect.** `src/services/jp/deinflect.ts`
  is copied from 10ten-ja-reader (GPL-3.0-or-later; `const enum`→`enum` is the only
  change). This imposes GPL obligations on the distributed app. Treat
  `LICENSE-10ten` as governing; do not assume the rest of the project's license
  overrides it. Any agent changing licensing posture must account for this.
- **Backend-free static deploy.** The app is fully client-side, so it ships as
  static files to **GitHub Pages** at <https://huangwaylon.github.io/epub/> via
  `.github/workflows/deploy.yml` (push to `main`). The production build uses
  `base: '/epub/'` (dev uses `/`), and the PWA `start_url`/`scope`/`navigateFallback`
  derive from that base. See [deployment.md](./deployment.md) for CI, base-path,
  and the local-only `sharp` handling.

---

## 9. Cross-references

Sibling deep-dive docs (relative to this file):

- [`./reader-engine.md`](./reader-engine.md) — foliate-js integration, pagination, CFIs, tap/selection geometry.
- [`./japanese.md`](./japanese.md) — extraction, deinflection, JMdict lookup, dictionary lifecycle.
- [`./storage-pwa-ios.md`](./storage-pwa-ios.md) — OPFS/IndexedDB, persistence, service worker, iOS install.
- [`./ui-and-design.md`](./ui-and-design.md) — Svelte components, design tokens, theming, sheets.
- [`./deployment.md`](./deployment.md) — GitHub Pages CI, base path, PWA manifest, local-only `sharp`.
- [`./development.md`](./development.md) — scripts, build, test, local on-device setup.
