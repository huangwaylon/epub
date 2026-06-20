# Tsuzuri — System Architecture

This is the system-level map for **Tsuzuri** (綴), an installable iOS PWA for
reading Japanese EPUBs. It is written for engineers and LLM agents working on the
codebase. Every claim here is derived from the source under `src/`, `proxy/`,
`scripts/`, and `vite-plugins/`. For deep dives, see the [cross-references](#9-cross-references).

---

## 1. Overview

Tsuzuri is a single-page, offline-first reader that renders reflowable EPUBs
paginated like Apple Books. It is built for Japanese books but works for any
EPUB. Defining features:

- **Paginated 縦書き / 横書き reading.** CSS multi-column pagination via
  vendored foliate-js, honouring each book's declared writing mode and
  page-progression direction (`dir: 'ltr' | 'rtl'`), with a manual 縦/横 override
  (`settings.writingMode`). Tap zones (left / center / right) turn pages or toggle chrome.
- **Offline 10ten-style tap-to-define.** Tap a word → forward text run is
  extracted (skipping `<rt>/<rp>` furigana), deinflected (vendored 10ten engine),
  and looked up in JMdict held in IndexedDB. Shows reading, pitch accent, POS, and
  deinflection reasons. Fully offline after a one-time dictionary download.
- **Sentence translation.** Select text → translate via a same-origin endpoint
  (`/api/translate`) that proxies a translation API; results cached in IndexedDB
  for offline re-reads.
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
| **foliate-js** (vendored, **MIT**) | `src/vendor/foliate-js` | EPUB parsing + paginated rendering as a `<foliate-view>` custom element. Vendored (not npm) so `pdf.js` could be removed and `view.js` patched. No hard deps. |
| **@birchill/jpdict-idb** `^3.3` | `src/services/jp/dictdb.ts` | Downloads JMdict from data.10ten.life into its own IndexedDB and serves offline `getWords` lookups. |
| **@birchill/normal-jp** `^1.7` | jp lookup/deinflect | `toNormalized` (normalise lookup window) and `kanaToHiragana` (deinflection). |
| **vendored 10ten deinflect (GPL-3.0)** | `src/services/jp/deinflect.ts` | Verb/adjective deinflection rules + algorithm copied from 10ten-ja-reader. **⚠ GPL-3.0-or-later — see [§8](#8-key-design-decisions--trade-offs).** License at `src/services/jp/LICENSE-10ten`. |
| **idb** `^8` | `src/services/storage/db.ts` | Promise wrapper over IndexedDB for the app's structured data. |
| **sharp** + **fflate** (devDeps) | `scripts/*.mjs` | **Dev tooling only.** `gen-icons.mjs` rasterises PWA icons (sharp); `make-test-epub.mjs` builds a test EPUB (fflate + sharp). Not shipped. |
| **vitest** (devDep) | `*.test.ts` | Unit tests (e.g. `src/services/jp/deinflect.test.ts`). |

Runtime npm dependencies are only three: `@birchill/jpdict-idb`,
`@birchill/normal-jp`, `idb`. foliate-js and the 10ten deinflect engine are
vendored into the tree, not installed.

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
│  dict, nav, pwa.                │   │  library, translate, jp/*,         │
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
                          jpdict-idb: JMdict) · Service Worker · /api/translate
```

`src/main.ts` is the entry point ([§7](#7-entry-point--routing)); a Cloudflare
Worker in `proxy/` and a Vite middleware in `vite-plugins/` provide the
translation backend.

---

## 4. Module map

### Root / build
| Path | Responsibility |
|---|---|
| `index.html` | App shell; iOS PWA meta (status-bar, viewport-fit=cover), theme-color, mounts `/src/main.ts`. |
| `vite.config.ts` | Vite + svelte + `devTranslate()` + VitePWA (manifest, Workbox precache, `registerType: 'prompt'`, dev SW enabled). |
| `vitest.config.ts` | Test runner config. |
| `svelte.config.js`, `tsconfig*.json` | Svelte/TS compiler config. |
| `package.json` | Scripts (`dev`/`build`/`preview`/`test`/`check`); 3 runtime deps; dev tooling. |
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
| `lib/library/ShelfSettings.svelte` | App settings sheet: theme, dictionary download/status, translation target lang, storage usage. |
| `lib/reader/Reader.svelte` | **The reader screen.** Owns a `ReaderController`, wires all callbacks (relocate/tap/selection/show-annotation), manages chrome bars, dictionary popup, selection & highlight-edit toolbars, sheets (TOC/settings/notes/translation), progress persistence, bookmark toggle. |
| `lib/reader/ReaderSettings.svelte` | Display sheet: theme, serif/sans, font-size/line-height/margin steppers, writing-mode segmented; emits `onchange('appearance'\|'layout'\|'writingmode')`. |
| `lib/reader/TocSheet.svelte` | Flattens `book.toc` (with depth) → tappable nav list; highlights current section. |
| `lib/reader/DictionaryPopup.svelte` | Tap-to-define card: positioned near tap (viewport-clamped); loading / needs-download / results states; download CTA. |
| `lib/reader/SelectionToolbar.svelte` | Floating toolbar over a selection: colour swatches, copy, translate, delete (reused for both new-selection and highlight-edit modes). |
| `lib/reader/TranslationSheet.svelte` | Calls `translate()`, shows source/result/engine, copy; re-runs on new selection. |
| `lib/reader/AnnotationsPanel.svelte` | Notes sheet: tabs for highlights/bookmarks, sorted, tap to `goTo(cfi)`. |
| `lib/components/Sheet.svelte` | Bottom-sheet primitive (scrim, grip, `$bindable open`, title). |
| `lib/components/Segmented.svelte` | Generic segmented control (`<T extends string\|number>`). |
| `lib/components/Icon.svelte` | Inline 24×24 stroke-icon set (`PATHS` map, `currentColor`). |
| `lib/components/UpdateToast.svelte` | Reads `pwa` store; "new version ready → Refresh" toast. |
| `lib/actions/longpress.ts` | Svelte action: fires `onlongpress` after a stationary press-and-hold (shelf context menu). |
| `lib/util/debounce.ts` | Trailing-edge `debounce` (used for progress saves). |

### Services (`src/services/*.ts`)
| Path | Responsibility |
|---|---|
| `services/types.ts` | Core data model: `BookMeta`, `ReadingProgress`, `Annotation`, `ReaderSettings`, `DEFAULT_SETTINGS`, `HIGHLIGHT_HEX`. The persisted shapes. |
| `services/library.ts` | `importEpub` (sha-256 dedupe → OPFS bytes → foliate `makeBook` metadata/cover), `listBooks`, `touchBook`, `removeBook`; re-exports `getBookFile`. |
| `services/reader.ts` | **`ReaderController`** — creates/owns one `<foliate-view>`; injects appearance CSS from live theme tokens; applies page geometry; detects writing mode; custom tap detection → `TapInfo`; selection geometry → `SelectionInfo`; highlight add/remove/recolor/reapply; CFI for selections. |
| `services/translate.ts` | `translate(text, target, source='ja')`: IDB cache → `POST /api/translate` → cache result; `TranslateError`; `TRANSLATE_ENDPOINT`. |

### Services — storage (`src/services/storage/`)
| Path | Responsibility |
|---|---|
| `storage/db.ts` | `idb`-backed IndexedDB `tsuzuri` (v1): stores `books`, `progress`, `annotations` (`byBook` index), `settings`, `translations`, `bookBlobs`. CRUD + `deleteBookCascade`. |
| `storage/blobs.ts` | EPUB bytes: OPFS (`navigator.storage.getDirectory`, `books/<id>.epub`) with capability probe; **IndexedDB `bookBlobs` fallback**. `putBook`, `getBookFile` (returns a `File`), `deleteBook`. |
| `storage/persist.ts` | `requestPersistence` (`navigator.storage.persist`), `storageStatus` (`estimate`), `formatBytes`. |

### Services — Japanese (`src/services/jp/`)
| Path | Responsibility |
|---|---|
| `jp/dictdb.ts` | Single shared `JpdictIdb`; `getDb`, `isDictReady`, `downloadDictionary`/`ensureDictionary` (jpdict `updateWithRetry`), `cancelDownload`; mirrors state into the `dict` store. |
| `jp/extract.ts` | `extractTextAt(doc,x,y)`: caret-from-point → tree walker (rejecting `<rt>/<rp>`) → up to 16 chars forward. `looksJapanese`. |
| `jp/deinflect.ts` | **Vendored 10ten (GPL-3.0).** `deinflect(word)` → candidate words + reason chains; `Reason`/`WordType` enums; rule table. |
| `jp/lookup.ts` | `lookup(window)`: longest-match-first over a ≤16-char window; for each length: normalise → `deinflect` → `getWords` (exact) → filter by inflectable POS → map to `DictEntry`. POS/reason label maps. |
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

### Backend / scripts / plugins
| Path | Responsibility |
|---|---|
| `proxy/worker.ts` | **Production** Cloudflare Worker: `POST {text,source?,target?}` → DeepL → `{result, engine:'deepl'}`; CORS; API key from `DEEPL_API_KEY` secret. |
| `proxy/wrangler.toml`, `proxy/README.md` | Worker deploy config + docs. |
| `vite-plugins/dev-translate.ts` | **Dev-only** Vite middleware at `/api/translate`; proxies Google's keyless `gtx` endpoint; same contract as the worker. |
| `scripts/gen-icons.mjs` | Rasterises inline SVG → `public/icons/*.png` (sharp). |
| `scripts/make-test-epub.mjs` | Generates a vertical-writing RTL JP EPUB3 test fixture (fflate + sharp). |

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
to restore position; `#nudgeLayout()` re-renders at increasing delays to fix
first-paint under-measurement. TOC read from `controller.view.book.toc`. Then
`loadAnnotations(bookId)` + `controller.setHighlights(...)` seed overlays.
Tap zones (`onTap`/`handleTap`): center toggles chrome; left/right →
`goLeft`/`goRight` (direction-aware via `bookDir`).

### (c) Tap-to-define
foliate content doc fires `pointerup` → `ReaderController`'s custom tap detector
(filters moves/long presses/active selections) → `onTap` → `handleTap`. If
`settings.tapToDefine`, `tryDefine(info)`: `jp/extract.extractTextAt(doc, ix, iy)`
(caret-from-point, walks text skipping furigana, ≤16 chars) → `looksJapanese`.
Opens `DictionaryPopup` (loading) and `runLookup(text)`: `dictdb.isDictReady()`;
if not, popup shows download CTA → `downloadDictionary('en')`. If ready,
`jp/lookup.lookup(text)`: longest-prefix match → `toNormalized` → `deinflect` →
`getWords(term, {exact})` → filter inflectable POS → `DictEntry[]`. A stale-tap
guard (`dictState.lastText`) discards superseded lookups. (When highlights exist,
the tap action is deferred ~60ms so a highlight hit-test can cancel it.)

### (d) Select → highlight / bookmark
**Selection:** `selectionchange` (debounced 250ms) in the content doc →
`onSelection(SelectionInfo)` → `SelectionToolbar` over the selection rect.
**Highlight:** `createHighlight(color)` → `controller.cfiForSelection(doc, range)`
(`view.getCFI(index, range)`) → `annotations.saveAnnotation` (IDB + store) →
`controller.addHighlight(cfi, HIGHLIGHT_HEX[color])` → foliate `addAnnotation`
draws via the `draw-annotation` event. Tapping an existing highlight fires
foliate's `show-annotation` → `onShowAnnotation` → edit toolbar (recolor/delete).
**Bookmark:** footer button → `toggleBookmark()` toggles a `bookmark`-kind
`Annotation` at `currentCFI`. The notes panel (`AnnotationsPanel`) lists both and
navigates via `goTo(cfi)`.

### (e) Translate
`SelectionToolbar` translate → `translateSelection()` opens `TranslationSheet`
with the selected text → `services/translate.translate(text, settings.translationTargetLang)`:
checks `getCachedTranslation(key)` (key = `${target}:${hash(text)}`); on miss and
online, `POST /api/translate {text, source:'ja', target}` → `{result, engine}` →
`putCachedTranslation`. Dev: `vite-plugins/dev-translate.ts` (Google gtx).
Prod: `proxy/worker.ts` (DeepL). Offline cache miss throws `TranslateError`.

### (f) Progress persistence
foliate `relocate` event → `ReaderController.onRelocate` → `Reader.onRelocate`
(updates `fraction`, `currentCFI`, `sectionLabel`) → `saveProgress` (debounced
600ms) → `storage/db.putProgress({bookId, cfi, fraction, label, updatedAt})`.
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
| `settings` | `ReaderSettings` (theme, fontScale, lineHeight, marginScale, fontFamily, writingMode, tapToDefine, translationTargetLang) | `db.saveSettings` / `loadSettings` (IDB key `reader`) |
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
  also excludes `pdfjs` from precache) and (2) **patch `view.js`** directly.
  No `pdf` references remain in `view.js`. License is MIT, so this is fine to ship.
- **Single `ReaderController` owns the `<foliate-view>`.** All foliate interaction
  (open, layout, appearance, taps, selections, CFIs, highlights) is funneled
  through one class (`services/reader.ts`); `Reader.svelte` only wires callbacks
  and renders chrome. Custom tap detection replaces native tap handling so
  left/center/right zones map to page-turn / chrome / lookup.
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

---

## 9. Cross-references

Sibling deep-dive docs (relative to this file):

- [`./reader-engine.md`](./reader-engine.md) — foliate-js integration, pagination, CFIs, tap/selection geometry.
- [`./japanese.md`](./japanese.md) — extraction, deinflection, JMdict lookup, dictionary lifecycle.
- [`./storage-pwa-ios.md`](./storage-pwa-ios.md) — OPFS/IndexedDB, persistence, service worker, iOS install.
- [`./ui-and-design.md`](./ui-and-design.md) — Svelte components, design tokens, theming, sheets.
- [`./translation.md`](./translation.md) — translate flow, caching, dev middleware vs Cloudflare Worker.
- [`./development.md`](./development.md) — scripts, build, test, local on-device setup.
