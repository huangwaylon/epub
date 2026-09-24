# Tsuzuri — System Architecture

The system map: layers, entry point, stores, data flows and a file index. Subsystem
depth lives in [reader-engine.md](./reader-engine.md) (foliate, pagination, taps,
highlights), [japanese.md](./japanese.md) (dictionary and lookup),
[storage-pwa-ios.md](./storage-pwa-ios.md) (persistence, service worker, iOS),
[ui-and-design.md](./ui-and-design.md) (components, tokens) and
[development.md](./development.md) (scripts, testing, verification).

## 1. Overview

A single-page, offline-first, **backend-free** EPUB reader for Japanese books, shipped as
static files to GitHub Pages ([deployment.md](./deployment.md)). Features: paginated
縦書き/横書き reading via vendored foliate-js, offline tap-to-define (kuromoji segmentation +
vendored 10ten deinflection + JMdict via jpdict-idb, run in a Web Worker), CFI-anchored
highlights (always yellow) and bookmarks, and an installable iOS PWA.

**Runtime npm deps (4):** `@birchill/jpdict-idb`, `@birchill/normal-jp`, `@sglkc/kuromoji`,
`idb`. foliate-js (MIT) and the 10ten deinflector (**GPL-3.0-or-later**, which makes the
app GPL) are vendored.

## 2. Layers

Dependencies point strictly downward. No Svelte imports in `src/services/**`.

```
UI          src/App.svelte, src/lib/**           Svelte 5 components
  │ read/mutate stores, call services
STORES      src/stores/*.svelte.ts               module-level rune singletons
  │ call services, persist
SERVICES    src/services/**                      framework-agnostic: reader, library,
  │                                              storage, viewport, jp (+ lookup worker)
VENDORED    src/vendor/foliate-js, jp/deinflect.ts
  │
PLATFORM    OPFS (EPUB bytes) · IndexedDB (idb: app data; jpdict-idb: JMdict)
            · Cache API / service worker (app shell, kuromoji dict)
```

## 3. Entry point & routing

1. **`index.html`** — an inline script reads the localStorage settings mirror
   (`tsuzuri:settings`), resolves `'auto'` via `prefers-color-scheme`, and sets
   `<html data-theme>` + the `theme-color` meta before first paint.
2. **`src/main.ts`** (no top-level `await`):
   - `void initSettings()`: seed from the mirror, apply the theme, hydrate from IndexedDB
     in the background.
   - `initViewport()`: publish `--doc-height` / `--app-height`
     ([storage-pwa-ios.md §6](./storage-pwa-ios.md#6-ios-viewport--srcservicesviewportts)).
   - `void validateRestoredRoute(...)`: a reader route restored from sessionStorage falls
     back to the shelf if the book is gone.
   - `void requestPersistence()`.
   - `registerSW(...)`: wires the `pwa` store, and on return to the foreground calls
     `registration.update()` at most hourly.
   - Deletes the superseded `kuromoji-ipadic` cache, and 4 s later (online, dictionary
     installed) re-fills the IPADIC cache via a dynamic `dictdb` import (`cacheIpadic()`).
   - `mount(App)`.
3. **`src/App.svelte`** — `nav.route.name === 'reader'` renders the lazily loaded
   `Reader` (`loadReader()`, inside `{#key bookId}`), showing `LoadingScreen` while it
   loads, and **Try again** (full reload) / **Back to library** if the chunk fails.
   Otherwise it renders `Shelf`. `ToastHost` is always mounted. The reader chunk is warmed
   ~1.5 s after mount (idle callback) and on pointerdown on a cover.

**Lazy loading.** The shelf's critical path has no foliate: `library.ts` imports
`view.js` only on import, `ShelfSettings` is a dynamic import, the reader is its own chunk,
and the reader prefetches foliate's zip/epub/paginator chunks at mount.

## 4. Stores

Each store exports a `$state` object that components read directly. Mutate only through
the exported functions, so persistence and side effects happen together.

| Store | Holds | Key functions | Persisted in |
|---|---|---|---|
| `settings` | `settings: ReaderSettings`; `appearance.resolved` (theme with `'auto'` resolved, live) | `initSettings`, `updateSettings` | IDB `settings['reader']` (source of truth) + localStorage mirror `tsuzuri:settings` |
| `library` | `books`, `progress` (by id), `loading`, `importing`, `importError` | `refreshLibrary`, `importFiles`, `deleteBook`, `markOpened` | IDB `books` / `progress`; bytes in OPFS |
| `annotations` | `annotations.items`: an immutable `$state.raw` array for the open book, with non-reactive lookup maps | `loadAnnotations`, `clearAnnotations`, `isHighlighted`, `highlightAt`, `addHighlightRecord`, `removeHighlightRecord`, `saveAnnotation`, `removeAnnotation`, `newId` | IDB `annotations` (`byBook`) |
| `dict` | `state` (`init`/`empty`/`ok`/`unavailable`), `updating`, `progress`, `warming`, `error?` | mutated by `jp/dictdb.ts` | jpdict-idb's own IndexedDB |
| `nav` | `route`: `{name:'shelf'}` or `{name:'reader', bookId}` | `openReader`, `openShelf`, `rememberRouteForReload`, `validateRestoredRoute`, `loadReader`, `warmReader` | sessionStorage `tsuzuri:route`, written only just before a deliberate reload |
| `pwa` | `needRefresh`, `offlineReady`, `update()` | set by `main.ts` | memory |
| `toast` | `toast.current` (one toast at a time) | `showToast`, `actOnToast`, `dismissToast` | memory |

`refreshLibrary` uses a generation counter to drop stale results, and keeps unchanged
books' object identity so covers aren't re-decoded. Store conventions are covered in
[ui-and-design.md §1](./ui-and-design.md).

## 5. Data flows

**Import.** Shelf `<input type=file>` → `importFiles` (filters `.epub` /
`application/epub+zip`, imports sequentially, refreshes after each file of a batch) →
`importEpub`: `id` = SHA-256 of the bytes. If the id already exists, restore the bytes if
they're missing, bump `lastOpenedAt`, and return. Otherwise `putBook` (OPFS or IDB
fallback) runs in parallel with foliate's `makeBook` (title, author, language, `dir`,
cover → 320px WebP thumbnail), then `putBookMeta`. On failure the bytes are rolled back.
Details: [storage-pwa-ios.md §4](./storage-pwa-ios.md#4-library-import--srcserviceslibraryts).

**Open.** Cover tap → `openReader(id)` + background `markOpened(id)`. `Reader.onMount`
calls `prefetchEngine()` and warms the lookup worker, then runs
`Promise.all([getBookMeta, getBookFile, getProgress, loadAnnotations])`. A meta row with no
bytes shows a "please re-import" error. Next it creates `new ReaderController(host,
settings, callbacks)`, seeds highlights with `setHighlights(...)` **before**
`controller.open(file, progress?.cfi)`, then builds the TOC and chapter index. See
[reader-engine.md §3](./reader-engine.md).

**Tap / swipe.** `ReaderController#trackGestures` turns a horizontal swipe into a page
turn and a clean tap into `onTap`. With a card open, any tap only dismisses it. Otherwise
a tap on a Japanese glyph defines it (even in the nav-bar band) → `extractTextAt` (main
thread) → `lookupClient.lookupAt` (worker) → `DictionaryPopup` + yellow highlight. A tap
on blank paper toggles chrome in the top/bottom band, otherwise hides the bars. Details: [reader-engine.md §8](./reader-engine.md), [japanese.md](./japanese.md).

**Highlight / bookmark.** Selection → `SelectionToolbar` → `cfiForSelection` →
`addHighlight` in `Reader.svelte` (paint first, persist in the background, dedupe on CFI).
Bookmarks toggle a `bookmark` annotation at the current CFI. `AnnotationsPanel` lists both,
grouped by chapter. Details: [reader-engine.md §9](./reader-engine.md).

**Progress.** foliate `relocate` → `Reader.onRelocate` → debounced `saveProgress` →
`putProgress` (flushed on `pagehide` / destroy). The next open passes `progress.cfi` to
`view.init({ lastLocation })`, and the shelf ring reads `library.progress[id].fraction`.

**Update.** SW `onNeedRefresh` → `pwa.needRefresh` → `ToastHost` "A new version is ready" →
`pwa.update()` = `rememberRouteForReload()` + `updateSW(true)`. The reload reopens the
book.

## 6. File index

### Root & build
| Path | Role |
|---|---|
| `index.html` | App shell, iOS PWA meta, generated splash links, inline first-paint theme script. |
| `vite.config.ts` | Svelte + VitePWA (manifest, Workbox), `base` (`/epub/` build, `/` dev), kuromoji loader alias, `foliate-` chunk prefix, `__APP_VERSION__`. |
| `vitest.config.ts`, `tsconfig*.json` | Node-env tests (`src/**/*.test.ts`); app / node TS projects. |
| `.github/workflows/deploy.yml` | Build and deploy to Pages on push to `main`. |
| `scripts/copy-kuromoji-dict.mjs` | `predev` / `prebuild`: stage and trim the IPADIC dict into `public/kuromoji/dict/` (gitignored). |
| `scripts/gen-icons.mjs` | sharp: `public/icons/*.png`, `public/splash/*.png`, and the splash `<link>`s in `index.html`. |
| `scripts/make-test-epub.mjs` | fflate + sharp: `test-books/tsuki-to-neko.epub`. |

### App (`src/`)
| Path | Role |
|---|---|
| `main.ts`, `App.svelte` | Entry and two-screen router view (§3). |
| `app.css` | Design tokens and the light/sepia/dark palettes ([ui-and-design.md](./ui-and-design.md)). |
| `stores/*.svelte.ts` | §4. |
| `lib/library/` | `Shelf`, `BookCover`, `ShelfSettings`. |
| `lib/reader/` | `Reader` (screen wiring), `DictionaryPopup`, `SelectionToolbar`, `AnnotationsPanel`, `TocSheet`, `ReaderSettings`, `ProgressScrubber`. |
| `lib/components/` | `Sheet`, `Segmented`, `Icon`, `Toast`, `ToastHost`, `LoadingScreen`. |
| `lib/actions/`, `lib/util/` | `longpress`; `debounce`, `anchoredPosition`, `chromeBand`, `motion`. |

### Services (`src/services/`)
| Path | Role |
|---|---|
| `types.ts` | Persisted model: `BookMeta`, `ReadingProgress`, `Annotation`, `ReaderSettings`, `DEFAULT_SETTINGS`, `HIGHLIGHT_HEX`. |
| `library.ts` | `importEpub`, `listBooks`, `touchBook`, `removeBook`, `flattenLangMap`; re-exports `getBookFile`. |
| `reader.ts` | `ReaderController`: owns `<foliate-view>`; layout, appearance, gestures, page-turn slide, selection, highlights ([reader-engine.md](./reader-engine.md)). |
| `cfi.ts` | CFI parsing / ordering for the highlight sweep. |
| `viewport.ts` | `initViewport`, `viewportSize` ([storage-pwa-ios.md §6](./storage-pwa-ios.md#6-ios-viewport--srcservicesviewportts)). |
| `storage/db.ts`, `storage/blobs.ts`, `storage/persist.ts` | IndexedDB, EPUB bytes, Storage API ([storage-pwa-ios.md](./storage-pwa-ios.md)). |
| `jp/*` | `dictdb`, `lookupClient` ↔ `lookup.worker`, `lookup`, `segment`, `deinflect` (GPL), `extract`, `ipadic`, `kuromojiLoader.cjs` ([japanese.md](./japanese.md)). |

### Vendored (`src/vendor/foliate-js/`, MIT)
`view.js` (`<foliate-view>`, `makeBook`; the only module the app imports directly),
`paginator.js`, `epub.js`, `epubcfi.js`, `overlayer.js`, `vendor/zip.js`, plus unused
format modules (mobi, fb2, comic-book, tts, search, …), which are excluded from the
precache. The local patches (PDF removed from `view.js`; three `TSUZURI PATCH` edits in
`paginator.js`) are listed in [reader-engine.md §1](./reader-engine.md).
