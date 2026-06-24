# Tsuzuri — System Architecture

System-level map for **Tsuzuri** (綴), an installable iOS PWA for reading
Japanese EPUBs, paginated like Apple Books. Written for engineers and LLM agents
extending the code. Claims here are derived from `src/`, `scripts/`, and
`.github/workflows/`. For subsystem depth, see the [cross-references](#9-cross-references).

---

## 1. Overview

A single-page, offline-first, **backend-free** reader. Built for Japanese books;
works for any EPUB. Defining features:

- **Paginated 縦書き / 横書き reading** via CSS multi-column pagination (vendored
  foliate-js), honouring each book's writing mode and page-progression direction
  (`dir: 'ltr' | 'rtl'`), with a manual 縦/横 override (`settings.writingMode`).
- **Offline 10ten-style tap-to-define.** Tap a Japanese word → the surrounding run
  is extracted (skipping `<rt>/<rp>` furigana), segmented (kuromoji), deinflected
  (vendored 10ten engine), and looked up in JMdict (jpdict-idb). Shows reading,
  pitch accent, POS, and deinflection reasons. The whole pipeline runs in a Web
  Worker. The dictionary is the only language feature.
- **Highlights & bookmarks**, CFI-anchored so they survive reflow / font changes.
  Highlights are a **single colour (yellow)** — no colour picker; a looked-up word
  is auto-highlighted as a vocab record.
- **Installable PWA** — Add-to-Home-Screen on iOS, edge-to-edge layout, persistent
  storage, service-worker app-shell precache, "update ready" toast.

See [reader-engine.md](./reader-engine.md) and [japanese.md](./japanese.md) for the
reading and dictionary subsystems.

---

## 2. Tech stack

| Tech | Where | Why |
|---|---|---|
| **Svelte 5 (runes)** | all UI + stores | `$state`/`$derived`/`$effect`; stores are module-level rune singletons (no store contract). Mounted via `mount()`. |
| **Vite + vite-plugin-pwa** | build / SW | ESM dev server; PWA plugin generates the Workbox service worker + manifest. |
| **foliate-js** (vendored, **MIT**) | `src/vendor/foliate-js` | EPUB parsing + paginated rendering as a `<foliate-view>` custom element. Vendored so `pdf.js` could be removed and `view.js`/`paginator.js` patched (two "TSUZURI PATCH" edits). |
| **@birchill/jpdict-idb** | `src/services/jp/dictdb.ts` | Downloads JMdict from data.10ten.life into its own IndexedDB; serves offline `getWords` lookups. |
| **@birchill/normal-jp** | jp lookup/deinflect | Lookup-window normalisation and kana handling. |
| **@sglkc/kuromoji** | `src/services/jp/segment.ts` | MeCab/IPADIC morphological analyser → word segmentation for tap-to-define (Apache-2.0). Ships a ~19 MB dict (staged to `public/kuromoji/dict/`, runtime-cached). |
| **fflate** | `kuromojiLoader.cjs` | Gunzips the IPADIC dict (a defensive loader works around kuromoji's stock loader hanging on auto-gzipped responses). |
| **idb** | `src/services/storage/db.ts` | Promise wrapper over IndexedDB for structured data. |
| **vendored 10ten deinflect (GPL-3.0)** | `src/services/jp/deinflect.ts` | Verb/adjective deinflection copied from 10ten-ja-reader. **⚠ GPL-3.0-or-later — see [§8](#8-key-design-decisions--trade-offs).** License at `src/services/jp/LICENSE-10ten`. |
| **sharp** (devDep) | `scripts/*.mjs` | Dev tooling only: `gen-icons.mjs` rasterises PWA icons. Stripped from the CI build. |
| **vitest** (devDep) | `*.test.ts` | Unit tests (deinflection engine). |

**Five runtime npm dependencies:** `@birchill/jpdict-idb`, `@birchill/normal-jp`,
`@sglkc/kuromoji`, `fflate`, `idb`. foliate-js and the 10ten deinflect engine are
vendored into the tree, not installed.

---

## 3. Layered architecture

Strict downward dependency: UI imports stores and services; stores import services;
services import vendored engines and browser APIs. Vendored engines import nothing
from the app. **No Svelte imports in `src/services/**`.**

```
┌──────────────────────────────────────────────────────────────────────┐
│  UI — Svelte 5 components (src/App.svelte, src/lib/**)                  │
│  Shelf, Reader, sheets, popups, toolbars. Read stores, call services.  │
└───────────────┬──────────────────────────────────┬───────────────────┘
                │ read/mutate                       │ call
                ▼                                    ▼
┌────────────────────────────────┐  ┌──────────────────────────────────┐
│  STORES — src/stores/*.svelte.ts│ │  SERVICES — src/services/*         │
│  Rune singletons ($state).      │ │  Framework-agnostic logic:         │
│  settings, library, annotations,│─▶│  reader (ReaderController),        │
│  dict, nav, pwa.                │ │  library, jp/* (+ lookup worker),  │
│  Mutate via exported fns →      │ │  storage/*, viewport.              │
│  call services + persist.       │ └───────────────┬──────────────────┘
└─────────────────────────────────┘                │ wraps / drives
                                                    ▼
                                ┌──────────────────────────────────────┐
                                │  VENDORED — src/vendor/foliate-js      │
                                │  <foliate-view>, makeBook, Overlayer,  │
                                │  epub/epubcfi/paginator…               │
                                │  + jp/deinflect.ts (10ten, GPL)        │
                                └────────────────┬───────────────────────┘
                                                 │ browser platform
                                                 ▼
                       OPFS (EPUB bytes) · IndexedDB (idb: structured data;
                       jpdict-idb: JMdict) · Service Worker
```

`src/main.ts` is the entry point ([§7](#7-entry-point--routing)). The app ships as
static files to GitHub Pages — no backend ([deployment.md](./deployment.md)).

---

## 4. Module map

### Root / build
| Path | Responsibility |
|---|---|
| `index.html` | App shell; iOS PWA meta (status-bar, `viewport-fit=cover`); mounts `/src/main.ts`. |
| `vite.config.ts` | Vite + svelte + VitePWA (manifest, Workbox precache, `registerType: 'prompt'`, `clientsClaim: true`, dev SW); prod `base: '/epub/'`, dev `/`. kuromoji loader aliased in. |
| `vitest.config.ts`, `svelte.config.js`, `tsconfig*.json` | Test / compiler config. |
| `package.json` | Scripts (`dev`/`build`/`preview`/`test`/`check`; `predev`/`prebuild` stage the kuromoji dict); 5 runtime deps. |
| `public/` | `favicon.svg`, `icons/*.png`; `kuromoji/` (staged dict, gitignored). |
| `.github/workflows/deploy.yml` | CI: build on push to `main`, deploy `dist/` to Pages. See [deployment.md](./deployment.md). |

### Entry & app
| Path | Responsibility |
|---|---|
| `src/main.ts` | `await initSettings()`, `initViewport()`, `requestPersistence()`, `registerSW()` (wires `pwa` store), `mount(App)`. |
| `src/App.svelte` | Two-screen router view: `nav.route.name === 'reader'` → lazily-imported `Reader` (keyed on `bookId`), else `Shelf`; always renders `UpdateToast`. Falls back to a "back to library" message if the reader chunk fails to load. |
| `src/app.css` | Design tokens (CSS vars) for light/sepia/dark via `[data-theme]`; fonts, safe-area insets. |
| `src/vite-env.d.ts` | Ambient types (incl. `virtual:pwa-register`). |

### Stores (`src/stores/*.svelte.ts`)
| Path | Responsibility |
|---|---|
| `settings.svelte.ts` | Global `ReaderSettings` `$state`; `initSettings` (hydrate from IDB), `updateSettings` (mutate+persist), `applyTheme` (`<html data-theme>` + theme-color meta). |
| `library.svelte.ts` | Shelf `$state`: `books`, `progress`, `loading`, `importing`, `importError`. `refreshLibrary` (reconciles object identity to avoid re-decoding covers), `importFiles`, `deleteBook`, `markOpened`. |
| `annotations.svelte.ts` | Current book's `items` (highlights+bookmarks). `loadAnnotations`, `clearAnnotations`, `saveAnnotation`, `removeAnnotation` (in-place splice), `newId` (UUID). |
| `dict.svelte.ts` | Dictionary status: `state` (`init`/`empty`/`ok`/`unavailable`), `updating`, `progress`, `warming`, `error`. Mutated by `jp/dictdb.ts`. |
| `nav.svelte.ts` | In-memory router: `route` (`{name:'shelf'}` \| `{name:'reader',bookId}`), `openReader`, `openShelf`. |
| `pwa.svelte.ts` | SW update state: `needRefresh`, `offlineReady`, `update()`. Set by `main.ts`. |

### Components (`src/lib/**`)
Owned by [ui-and-design.md](./ui-and-design.md). Briefly: `library/Shelf.svelte`
(grid, import, long-press delete, settings sheet), `library/BookCover.svelte`,
`library/ShelfSettings.svelte` (theme, dictionary download, storage usage);
`reader/Reader.svelte` (the reader screen — owns a `ReaderController`, wires all
callbacks, manages chrome bands, dictionary popup, selection toolbar, scrubber,
sheets, progress, bookmarks), `reader/ReaderSettings.svelte`, `reader/TocSheet.svelte`,
`reader/DictionaryPopup.svelte`, `reader/SelectionToolbar.svelte`,
`reader/AnnotationsPanel.svelte`; `components/*` (Sheet, Segmented, Icon, UpdateToast);
`actions/longpress.ts`; `util/debounce.ts`, `util/anchoredPosition.ts`.

### Services (`src/services/*.ts`)
| Path | Responsibility |
|---|---|
| `types.ts` | Core persisted data model: `BookMeta`, `ReadingProgress`, `Annotation`, `ReaderSettings`, `DEFAULT_SETTINGS`, `HIGHLIGHT_HEX` (the single yellow). |
| `library.ts` | `importEpub` (sha-256 dedupe → OPFS bytes → foliate `makeBook` for metadata/cover, downscaled to a ~320px WebP thumbnail; rolls back bytes on metadata failure), `listBooks`, `touchBook`, `removeBook`; re-exports `getBookFile`. |
| `reader.ts` | **`ReaderController`** — owns one `<foliate-view>`; injects appearance CSS from live theme tokens; derives page geometry (per writing mode, viewport-based for vertical); detects writing mode; custom pointer state machine → swipe-to-turn + `TapInfo`; animates turns as a horizontal slide; selection geometry → `SelectionInfo`; highlight add/remove/reapply (single yellow); `goToFraction`; CFI for selections. See [reader-engine.md](./reader-engine.md). |
| `viewport.ts` | Publishes the visual-viewport height as `--app-height` (`initViewport`); `viewportSize()` (used by reader geometry). Papers over iOS cold-launch under-report and rotation jitter. See [storage-pwa-ios.md](./storage-pwa-ios.md). |

### Services — storage (`src/services/storage/`)
| Path | Responsibility |
|---|---|
| `db.ts` | `idb`-backed IndexedDB `tsuzuri` (v1): stores `books`, `progress`, `annotations` (`byBook` index), `settings`, `bookBlobs`. CRUD + `deleteBookCascade`. |
| `blobs.ts` | EPUB bytes: OPFS (`navigator.storage.getDirectory`, `books/<id>.epub`) behind a write-capability probe, with an **IndexedDB `bookBlobs` fallback**. `putBook`, `getBookFile` (returns a `File`), `deleteBook`. |
| `persist.ts` | `requestPersistence` (`navigator.storage.persist`), `storageStatus` (`estimate`), `formatBytes`. |

### Services — Japanese (`src/services/jp/`)
| Path | Responsibility |
|---|---|
| `dictdb.ts` | Single shared `JpdictIdb`; download/`ensureDictionary` lifecycle (jpdict `updateWithRetry`), `cancelDownload`; mirrors state into the `dict` store. |
| `extract.ts` | `extractTextAt(doc,x,y)`: caret-from-point → glyph hit-test → tree walker (rejecting `<rt>/<rp>`) gathering the word-char run on both sides of the tap → `{text, tapOffset}`. `rangeForSpan` (build a DOM range for the matched word). Main-thread (DOM) part of the pipeline. |
| `lookupClient.ts` | Main-thread client for the lookup worker: owns the `Worker`, correlates requests by id, exposes `lookupAt`, `warmupLookup`, `disposeLookup`. Lazy singleton; worker construction failures self-heal (only ≥3 disable the feature). |
| `lookup.worker.ts` | The lookup engine, off the main thread: kuromoji segment + deinflect + JMdict reads. Reads the same `jpdict` IndexedDB the main-thread download fills. |
| `lookup.ts` | The lookup algorithm run by the worker (`lookupAt` segment-and-match; `lookup` forward-only wrapper). |
| `lookupTypes.ts` | Dependency-free result types (`Sense`, `DictEntry`, `LookupResult`) shared by main thread and worker without pulling in the engine. |
| `segment.ts` | kuromoji tokenizer singleton (`ensureSegmenter`, lazy ~19 MB dict load, SW-cached). |
| `deinflect.ts` | **Vendored 10ten (GPL-3.0).** `deinflect(word)` → candidate words + reason chains; rule table. |
| `kuromojiLoader.cjs` | fflate-based gzip loader shim for kuromoji (aliased in `vite.config.ts`). |
| `deinflect.test.ts`, `LICENSE-10ten` | Vitest tests; GPL-3.0 license text. |

### Vendored engine (`src/vendor/foliate-js/`)
| Path | Responsibility |
|---|---|
| `view.js` | `<foliate-view>` element + `makeBook(file)`; the only entry the app imports (`reader.ts`, `library.ts`). PDF branch patched out. |
| `overlayer.js` | `Overlayer` — draws highlight overlays. |
| `epub.js`, `epubcfi.js` | EPUB container parsing; CFI generation/resolution. |
| `paginator.js`, `fixed-layout.js` | Reflowable (CSS columns) and fixed-layout renderers. Native touch turn patched out in `paginator.js`. |
| `mobi.js`, `fb2.js`, `comic-book.js`, `progress.js`, `search.js`, `tts.js`, `footnotes.js`, `dict.js`, `opds.js`, `quote-image.js`, `text-walker.js`, `uri-template.js` | Other formats / subsystems, mostly unused by Tsuzuri. |
| `vendor/fflate.js`, `vendor/zip.js` | foliate's own zip/inflate deps. |
| `LICENSE` | MIT (John Factotum). |

### Scripts
| Path | Responsibility |
|---|---|
| `scripts/copy-kuromoji-dict.mjs` | Stages the ~19 MB IPADIC dict into `public/kuromoji/dict/` (run via `predev`/`prebuild`). |
| `scripts/gen-icons.mjs` | Rasterises inline SVG → `public/icons/*.png` (sharp). |
| `scripts/make-test-epub.mjs` | Generates a vertical-RTL JP EPUB3 test fixture (fflate + sharp). |

---

## 5. Runtime data flows

### (a) Import an EPUB
`Shelf` file input → `library.importFiles(files)` (filters `.epub` /
`application/epub+zip`, tracks `importing` and `importError`) →
`services/library.importEpub(file)`: `sha256Hex(bytes)` = `id`. If `getBookMeta(id)`
exists, bump `lastOpenedAt` and return (dedupe). Else `blobs.putBook(id, file)`
(OPFS or IDB fallback), then `makeBook(file)` extracts title/author/language/`dir`/cover
(cover downscaled to a ~320px WebP thumbnail) → `putBookMeta`. Metadata failure rolls
the OPFS bytes back. After all files, `refreshLibrary()` reloads `books` + per-book
`getProgress`.

### (b) Open & read a book
`Shelf` → `markOpened(id)` → `nav.openReader(id)`. `App` swaps to a lazily-imported
`Reader` (keyed on `bookId`, so a new book remounts cleanly). `Reader.onMount`:
`Promise.all([getBookMeta, getBookFile, getProgress])` → `new ReaderController(host, settings, callbacks)`
→ `controller.open(file, progress?.cfi)`: `view.open(file)`, wire events, apply
appearance + layout, `view.init({lastLocation, showTextStart})`, one `#nudgeLayout()`
re-render (~250ms) plus a 150ms-debounced resize/visualViewport listener as hedges
against first-paint under-measurement. TOC from `controller.view.book.toc`. Then
`loadAnnotations(bookId)` + `setHighlights(...)` seed overlays. If the dictionary is
present, `warmupLookup()` is fired so the first tap is fast.

### (c) Tap & swipe model
The reader's only gestures are **swipe** and **tap**, both detected in
`ReaderController`'s pointer state machine (`#trackGestures`), attached to each content
document and to the host (for taps in the margins outside the iframe). foliate's own
touch page-turn is patched out (`paginator.js`), so all navigation is ours.

- **Swipe** (horizontal, `|dx| ≥ 45px` and `|dx| > |dy|`, no active selection, not
  pinch-zoomed) turns the page: drag left → `goRight()`, drag right → `goLeft()`
  ("page follows the finger"). `goLeft`/`goRight` are foliate's direction-aware nav,
  so the turn goes the right way in LTR, RTL, and 縦書き; they animate as a horizontal
  slide and fire `onTurn`.
- **Tap** (clean, quick, no swipe) → `onTap` → `Reader.handleTap`, in priority order:
  1. If the dictionary popup is open → dismiss it (anywhere on screen). Nothing else.
  2. Else if the tap is in the **top/bottom edge band** (`inChromeToggleBand`,
     ~12% of viewport height, 80–160px) → toggle the chrome bars.
  3. Else if the chrome is visible → hide it.
  4. Else (central reading area, chrome hidden, no popup) → `tryDefine(info)` if
     `settings.tapToDefine`.

  **A tap never turns the page, and a blank-centre tap does nothing** (there are no
  tap edge-rails). When highlights exist, the tap action is deferred ~60ms so a
  highlight hit-test (`show-annotation`) can cancel it.

`tryDefine`: `extract.extractTextAt(doc, ix, iy)` returns `{text, tapOffset}` (null on
a blank/non-word tap, so blank taps fall through to no-op). Opens `DictionaryPopup`
(loading) and `runLookup` → `lookupClient.lookupAt(text, tapOffset)` (worker). If the
dictionary isn't ready the popup shows a download CTA → `downloadDictionary` then
`warmupLookup`. A stale-tap guard (`lastKey`) discards superseded lookups; the matched
span is auto-highlighted via `rangeForSpan` + `cfiForSelection`. See
[japanese.md](./japanese.md).

### (d) Highlight / bookmark
**Selection:** `selectionchange` (debounced 250ms, per-document) → `onSelection` →
`SelectionToolbar` over the rect. **Highlight:** `cfiForSelection(doc, range)` →
`annotations.saveAnnotation` (IDB + store) → `controller.addHighlight(cfi)` → foliate
`addAnnotation`, drawn **yellow** (`HIGHLIGHT_HEX`) via `draw-annotation`. Tap-to-define
auto-highlights the looked-up word the same way. Tapping an existing highlight fires
`show-annotation` → reopens the dictionary popup with a remove toggle. **Bookmark:**
footer button toggles a `bookmark`-kind `Annotation` at `currentCFI`.
`AnnotationsPanel` lists both and navigates via `goTo(cfi)`.

### (e) Progress persistence
foliate `relocate` → `ReaderController` → `Reader.onRelocate` (updates `fraction`,
`currentCFI`, `sectionLabel`) → `saveProgress` (debounced), but only once a gesture
has marked user interaction (`relocate` carries no reason, so intent is tracked on the
gesture side) → `db.putProgress`. On next open, `getProgress(bookId).cfi` feeds
`view.init({lastLocation})`. The shelf reads `library.progress[id].fraction` for the
cover ring.

---

## 6. State management model

State lives in **module-level Svelte 5 rune singletons** (`src/stores/*.svelte.ts`).
Each exports a deep-reactive `$state(...)` object components read directly (e.g.
`library.books`, `settings.theme`). **Mutation goes through exported functions**, never
raw assignment from UI, so side effects (persistence, theme, derived reloads) happen
together. Because `$state` is deep-reactive, in-place mutation (`items.push`,
`Object.assign(settings, patch)`) is reactive. No global store framework.

| Store | Holds | Persisted via |
|---|---|---|
| `settings` | `ReaderSettings` (theme, fontScale, lineHeight, marginScale, fontFamily, writingMode, tapToDefine) | `db.saveSettings`/`loadSettings` (IDB key `reader`) |
| `library` | `books: BookMeta[]`, `progress`, `loading`, `importing`, `importError` | books/progress in IDB; bytes in OPFS |
| `annotations` | `items: Annotation[]` for the open book | `db` annotations store (`byBook` index) |
| `dict` | `state` / `updating` / `progress` / `warming` / `error` | reflects jpdict-idb's own IndexedDB |
| `nav` | `route` (shelf vs reader+bookId) | in-memory only |
| `pwa` | `needRefresh`, `offlineReady`, `update()` | in-memory; driven by `registerSW` |

---

## 7. Entry point & routing

`src/main.ts` runs at module top level:
1. `await initSettings()` — hydrate settings from IndexedDB and `applyTheme()` before
   first paint (`<html data-theme>` + theme-color meta).
2. `initViewport()` — start publishing `--app-height` from the visual viewport.
3. `void requestPersistence()` — request durable storage (fire-and-forget).
4. `registerSW({ onNeedRefresh, onOfflineReady })` — wires the `pwa` store; sets
   `pwa.update = () => updateSW(true)`.
5. `mount(App, { target: #app })`.

**Routing** is a two-screen in-memory router (`nav.svelte.ts`). `App.svelte` renders
`<Reader>` (lazy-imported, inside `{#key nav.route.bookId}` for a clean remount per
book) when in the reader route, else `<Shelf>`. `<UpdateToast>` is always mounted.

---

## 8. Key design decisions & trade-offs

- **foliate-js vendored, not npm.** No stable release; vendoring lets us (1) delete
  `pdf.js` (EPUB-only; `globIgnores` also keeps it out of precache) and (2) patch it —
  two documented "TSUZURI PATCH" edits: removing the PDF branch in `view.js`, and
  disabling foliate's own touch page-turn in `paginator.js` (`#onTouchMove` keeps
  `preventDefault()` but drops `scrollBy`; `#onTouchEnd` drops the velocity snap) so our
  swipe handler owns navigation. MIT, so fine to ship.
- **Single `ReaderController` owns the `<foliate-view>`.** All foliate interaction (open,
  layout, appearance, taps/swipes, selections, CFIs, highlights) funnels through one
  class; `Reader.svelte` only wires callbacks and renders chrome. Custom pointer handling
  replaces native gestures — see [§5(c)](#c-tap--swipe-model).
- **Lookup runs in a Web Worker.** kuromoji build + tokenize + deinflect + JMdict reads
  live only in `lookup.worker.ts` (no main-thread copy), so a tap never janks a page-turn
  and the heavy engine stays out of the startup bundle. Lazy singleton, warmed on book
  open, disposed on reader exit; rebuilds from the SW-cached dict with no network. See
  [japanese.md](./japanese.md).
- **Theme tokens are CSS vars applied two ways.** `applyTheme()` sets `<html data-theme>`
  and syncs `theme-color`. The reader reads those live tokens back (`getComputedStyle`)
  and injects them into the content iframe via `appearanceCSS()` (`renderer.setStyles`),
  so the rendered page matches the app chrome across themes/fonts.
- **Writing-mode override requires a reopen.** Vertical vs horizontal is re-detected from
  the rendered document, so changing `settings.writingMode` calls
  `reopenForWritingMode(file)` (reopen at current CFI) rather than a live restyle. The
  reopen `close()`s and `destroy()`s the old renderer + Book to avoid leaking a paginator
  / blob URLs per toggle.
- **Storage is split.** Large EPUB bytes → OPFS (durable, large quota on iOS 16.4+) with
  an IndexedDB `bookBlobs` fallback; structured data → IndexedDB (`idb`); JMdict →
  jpdict-idb's own IndexedDB. None go through the service worker (which precaches only the
  app shell + runtime-caches the kuromoji dict). See [storage-pwa-ios.md](./storage-pwa-ios.md).
- **⚠ GPL-3.0 constraint.** `src/services/jp/deinflect.ts` is copied from 10ten-ja-reader
  (GPL-3.0-or-later; `const enum`→`enum` is the only change). This imposes GPL obligations
  on the distributed app; `LICENSE-10ten` governs. To relicense, reimplement deinflection.
- **Backend-free static deploy.** Fully client-side, shipped to GitHub Pages at
  <https://huangwaylon.github.io/epub/> via `deploy.yml` (push to `main`). Production build
  uses `base: '/epub/'` (dev `/`); PWA `start_url`/`scope`/`navigateFallback` derive from
  it. CI strips the local-only `sharp` dep. See [deployment.md](./deployment.md).

---

## 9. Cross-references

- [`./reader-engine.md`](./reader-engine.md) — foliate integration, pagination, CFIs, tap/selection geometry, vertical layout.
- [`./japanese.md`](./japanese.md) — extraction, deinflection, JMdict lookup, the worker pipeline, dictionary lifecycle.
- [`./storage-pwa-ios.md`](./storage-pwa-ios.md) — OPFS/IndexedDB, persistence, viewport handling, service worker, iOS install.
- [`./ui-and-design.md`](./ui-and-design.md) — Svelte components, design tokens, theming, sheets.
- [`./deployment.md`](./deployment.md) — GitHub Pages CI, base path, PWA manifest, local-only `sharp`.
- [`./development.md`](./development.md) — scripts, build, test, local on-device setup.
</content>
</invoke>
