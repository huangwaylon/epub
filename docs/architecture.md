# Tsuzuri — System Architecture

The system map: layers, entry point, stores, data flows and a file index. Subsystem depth:
[reader-engine.md](./reader-engine.md), [japanese.md](./japanese.md),
[storage-pwa-ios.md](./storage-pwa-ios.md), [ui-and-design.md](./ui-and-design.md),
[translation.md](./translation.md), [development.md](./development.md).

## 1. Layers

Dependencies point strictly downward. No Svelte imports in `src/services/**` (one exception:
`jp/dictdb.ts` writes `stores/dict.svelte`).

```
UI          src/App.svelte, src/lib/**           Svelte 5 components
  │ read/mutate stores, call services
STORES      src/stores/*.svelte.ts               module-level rune singletons
  │ call services, persist
SERVICES    src/services/**                      framework-agnostic: reader, library, catalog,
  │                                              storage, viewport, jp (+ lookup worker)
VENDORED    src/vendor/foliate-js (MIT), jp/deinflect.ts (GPL-3.0-or-later)
  │
PLATFORM    OPFS (EPUB bytes) · IndexedDB (idb: app data; jpdict-idb: JMdict)
            · Cache API / service worker (app shell, bundled catalog + covers, kuromoji dict)
```

## 2. Entry point & routing

1. **`index.html`**: an inline script reads the localStorage settings mirror
   (`tsuzuri:settings`), resolves `'auto'` via `prefers-color-scheme`, and sets
   `<html data-theme>` + `theme-color` before first paint.
2. **`src/main.ts`** (no top-level `await`): `void initSettings()` (mirror first, IndexedDB in
   the background), `initViewport()`, `validateRestoredRoute` (a restored reader route falls
   back to the shelf if the book is gone), `requestPersistence()`, `registerSW` (update check
   on foreground, at most hourly), the IPADIC cache housekeeping
   ([storage-pwa-ios.md §5](./storage-pwa-ios.md#5-pwa--viteconfigts-indexhtml-srcmaints)),
   then `mount(App)`.
3. **`src/App.svelte`**: `nav.route.name === 'reader'` renders the lazily loaded `Reader`
   (`loadReader()`, inside `{#key bookId}`) behind a `LoadingScreen`, with **Try again** (full
   reload) / **Back to library** if the chunk fails; otherwise `Shelf`. `ToastHost` is always
   mounted. The reader chunk is warmed ~1.5 s after mount (idle callback) and on pointerdown
   on a cover.

**Lazy loading.** The shelf's critical path has no foliate: `library.ts` imports `view.js` only
for a user-picked file (bundled downloads use catalog metadata), `ShelfSettings` is a dynamic
import, and the reader is its own chunk that prefetches foliate's zip/epub/paginator chunks at
mount.

## 3. Stores

Each store exports a `$state` object that components read directly; mutate only through the
exported functions so persistence and side effects run. `dict` and `pwa` are plain flag
objects written by their owners.

| Store | Holds | Key functions | Persisted in |
|---|---|---|---|
| `settings` | `settings: ReaderSettings`; `appearance.resolved` (live theme with `'auto'` resolved) | `initSettings`, `updateSettings` | IDB `settings['reader']` (source of truth) + localStorage mirror `tsuzuri:settings` |
| `library` | `books`, `progress` (by id), `loading`, `importing`, `importError` | `refreshLibrary`, `importFiles`, `deleteBook`, `markOpened` | IDB `books` / `progress`; bytes in OPFS |
| `catalog` | bundled `entries`, `loaded`, `error`, `jobs` (by id) | `loadCatalog`, `downloadBook`, `downloadAll`, `availableEntries`, `entryStatus` | memory (downloads land in `library`) |
| `annotations` | `items`: immutable `$state.raw` array for the open book, plus non-reactive lookup maps | `loadAnnotations`, `clearAnnotations`, `isHighlighted`, `highlightAt`, `addHighlightRecord`, `removeHighlightRecord`, `saveAnnotation`, `removeAnnotation` | IDB `annotations` (`byBook`) |
| `dict` | `state`, `updating`, `progress`, `warming`, `error?` | written by `jp/dictdb.ts` | jpdict-idb's own IndexedDB |
| `nav` | `route`: `{name:'shelf'}` or `{name:'reader', bookId}` | `openReader`, `openShelf`, `rememberRouteForReload`, `validateRestoredRoute`, `loadReader`, `warmReader` | sessionStorage `tsuzuri:route`, only just before a deliberate reload |
| `pwa` | `needRefresh`, `offlineReady`, `update()` | set by `main.ts` | memory |
| `toast` | `current` (one at a time) | `showToast`, `actOnToast`, `dismissToast` | memory |

`refreshLibrary` drops stale results with a generation counter and keeps unchanged books'
object identity so covers aren't re-decoded.

## 4. Data flows

| Flow | Path | Depth |
|---|---|---|
| Import | Shelf `<input type=file>` → `importFiles` (sequential, refresh after each) → `importEpub` (id = SHA-256, dedupe, bytes ‖ metadata, rollback) | [storage-pwa-ios.md §4](./storage-pwa-ios.md#4-library-import--srcserviceslibraryts) |
| Bundled books | `loadCatalog()` → **Included books** → `downloadBook` → `downloadEntry` (fetch, SHA-256 must equal the catalog id) → `importEpub` with catalog metadata | [storage-pwa-ios.md §4a](./storage-pwa-ios.md#4a-bundled-books--srcservicescatalogts) |
| Open | `openReader(id)` + `markOpened` → `Reader` mount → `ReaderController`, highlights seeded before `open(file, progress?.cfi)` | [reader-engine.md §11](./reader-engine.md) |
| Tap / swipe | `trackGestures` → swipe turns; tap → `extractTextAt` (main) → `lookupAt` (worker) → card + yellow highlight | [reader-engine.md §7–8](./reader-engine.md), [japanese.md](./japanese.md) |
| Highlight / bookmark | selection → `cfiForSelection` → `addHighlight` (paint first, persist in background, dedupe on CFI); bookmark at the current CFI | [reader-engine.md §9](./reader-engine.md) |
| Progress | `relocate` → debounced `saveProgress` → `putProgress` (flushed on hide / `pagehide` / destroy) → next open's `lastLocation`; shelf ring reads `progress[id].fraction` | [reader-engine.md §11](./reader-engine.md) |
| App update | SW `onNeedRefresh` → toast **Refresh** → `rememberRouteForReload()` + `updateSW(true)`; the reload reopens the book | [storage-pwa-ios.md §5](./storage-pwa-ios.md#5-pwa--viteconfigts-indexhtml-srcmaints) |

## 5. File index

### Root & build
| Path | Role |
|---|---|
| `index.html` | App shell, iOS PWA meta, generated splash links, inline first-paint theme script. |
| `vite.config.ts` | Svelte + VitePWA (manifest, Workbox), `base`, kuromoji loader alias, `foliate-` chunk prefix, `__APP_VERSION__`. |
| `vitest.config.ts`, `tsconfig*.json` | Node-env tests; app / node TS projects ([development.md](./development.md)). |
| `.github/workflows/deploy.yml` | Build and deploy to Pages ([deployment.md](./deployment.md)). |
| `scripts/copy-kuromoji-dict.mjs` | `predev` / `prebuild`: stage the trimmed IPADIC into `public/kuromoji/dict/` (gitignored). |
| `scripts/gen-icons.mjs`, `scripts/make-test-epub.mjs` | Icons + splash screens; the test EPUB. |
| `scripts/books/*`, `books/` | Bundled library sources and build → `public/books/` ([translation.md](./translation.md)). |
| `scripts/e2e/*` | puppeteer-core harness and scripted browser checks. |

### App (`src/`)
| Path | Role |
|---|---|
| `main.ts`, `App.svelte` | Entry and two-screen router (§2). |
| `app.css` | Tokens and palettes ([ui-and-design.md](./ui-and-design.md)). |
| `stores/*.svelte.ts` | §3. |
| `lib/library/` | `Shelf`, `BookCover`, `ShelfSettings`. |
| `lib/reader/` | `Reader`, `defineCard.svelte.ts`, `DictionaryPopup`, `SelectionToolbar`, `AnnotationsPanel`, `TocSheet`, `ReaderSettings`, `ProgressScrubber`. |
| `lib/components/` | `Sheet`, `Segmented`, `Icon`, `Toast`, `ToastHost`, `LoadingScreen`. |
| `lib/actions/`, `lib/util/` | `longpress`; `debounce`, `anchoredPosition`, `chromeBand`, `motion`. |
| `services/types.ts` | Persisted model, `DEFAULT_SETTINGS`, `HIGHLIGHT_HEX` ([storage-pwa-ios.md §1](./storage-pwa-ios.md)). |
| `services/library.ts`, `services/catalog.ts` | Import / list / remove / supersede; bundled catalog + download. |
| `services/reader/`, `chapters.ts`, `cfi.ts`, `translation.ts` | Reader engine and its pure helpers ([reader-engine.md](./reader-engine.md)). |
| `services/viewport.ts`, `services/storage/*` | iOS viewport; IndexedDB, EPUB bytes, Storage API ([storage-pwa-ios.md](./storage-pwa-ios.md)). |
| `services/jp/*` | Dictionary, lookup worker, extraction ([japanese.md](./japanese.md)). |
| `vendor/foliate-js/` | `view.js` (`<foliate-view>`, `makeBook`; the only module the app imports directly), `paginator.js`, `epub.js`, `epubcfi.js`, `overlayer.js`, `vendor/zip.js`, plus unused format modules excluded from the precache. Patches: PDF removed from `view.js`, patches 2–4 in `paginator.js`, the English CFI filter in `epubcfi.js` ([reader-engine.md §1](./reader-engine.md)). |
