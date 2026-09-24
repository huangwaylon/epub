# Storage, Data Model, PWA & iOS Constraints

How **Tsuzuri** persists data, the shape of that data, how it ships as an installable
PWA, and the iOS constraints behind those choices. Paths are relative to the repo root.

**Two-tier persistence:**

- **Structured data** (book metadata, progress, annotations, settings) → **IndexedDB**
  via [`idb`](https://github.com/jakearchibald/idb) — `src/services/storage/db.ts`.
- **Raw EPUB bytes** (multi-MB) → **Origin Private File System (OPFS)** with a
  transparent IndexedDB fallback — `src/services/storage/blobs.ts`.

CFI (EPUB Canonical Fragment Identifier) strings anchor both progress and annotations, so
they survive reflow, font-size, and writing-mode changes.

---

## 1. Data model — `src/services/types.ts`

Single source of truth for every persisted shape.

A **CFI** (EPUB Canonical Fragment Identifier) is an opaque EPUB anchor for a
position or range, stable across reflow/font/writing-mode changes — see
[`docs/reader-engine.md`](./reader-engine.md) §10.

| Export | Kind | Value / store |
| --- | --- | --- |
| `WritingModePref` | type | `'auto' \| 'horizontal' \| 'vertical'` — reader override on top of the EPUB's declared mode. |
| `ResolvedTheme` | type | `'light' \| 'sepia' \| 'dark'` — a concrete palette; what `<html data-theme>` is set to. |
| `ThemeName` | type | `'auto' \| ResolvedTheme` — the stored preference; `'auto'` follows `prefers-color-scheme` (light ↔ dark). |
| `AnnotationKind` | type | `'highlight' \| 'bookmark'`. |
| `HIGHLIGHT_HEX` | const | `'#ffd54a'` — the single highlight colour (reads well behind text at ~0.3 overlay opacity). No colour picker, no per-highlight `color` field. |
| `BookMeta` | interface | Shelf entry, one per book → `books` store. |
| `ReadingProgress` | interface | Last-read position, one per book → `progress` store. |
| `Annotation` | interface | A CFI-anchored highlight or bookmark → `annotations` store. |
| `ReaderSettings` | interface | Global (not per-book) appearance/behaviour → `settings` store under key `'reader'`. |
| `DEFAULT_SETTINGS` | const | Seed `ReaderSettings`. |

### `BookMeta`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | **SHA-256 of the raw bytes** (lowercase hex). Also the OPFS filename stem and dedupe key. |
| `title` | `string` | EPUB metadata; falls back to filename minus `.epub`. |
| `author` | `string` | EPUB metadata; multiple authors joined with `、` (U+3001). |
| `language` | `string` | BCP-47 tag, e.g. `"ja"`. |
| `dir` | `'ltr' \| 'rtl'` | EPUB page-progression direction (`'rtl'` for most vertical JP novels). |
| `cover?` | `Blob` | Downscaled WebP thumbnail (see import flow). Stored inline in IndexedDB. |
| `fileName` | `string` | Original imported filename. |
| `fileSize` | `number` | `file.size`. |
| `addedAt` | `number` | Epoch ms of import. |
| `lastOpenedAt` | `number` | Epoch ms; drives shelf sort (desc), bumped on open/re-import. |

### `ReadingProgress`

| Field | Type | Notes |
| --- | --- | --- |
| `bookId` | `string` | keyPath; equals `BookMeta.id`. |
| `cfi` | `string` | CFI from foliate's `relocate` event — survives reflow. |
| `fraction` | `number` | `0..1` overall progress; drives the shelf ring. |
| `label?` | `string` | Current TOC section label. |
| `updatedAt` | `number` | Epoch ms. |

### `Annotation`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Primary key. |
| `bookId` | `string` | Indexed by `byBook` for per-book queries and cascade delete. |
| `kind` | `AnnotationKind` | `'highlight'` or `'bookmark'`. |
| `cfi` | `string` | Range (highlights) or point (bookmarks). |
| `text` | `string` | Selected text (highlights) / context snippet (bookmarks). For tap-to-define highlights, the looked-up word. |
| `note?` | `string` | Optional user note. |
| `sectionLabel?` | `string` | TOC label for grouping in the annotations panel. |
| `createdAt` | `number` | Epoch ms. |

### `ReaderSettings` / `DEFAULT_SETTINGS`

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `theme` | `ThemeName` | `'auto'` | New users follow the OS; existing users keep their stored value. |
| `fontScale` | `number` | `1` | `1` = 100%. |
| `lineHeight` | `number` | `1.9` | |
| `marginScale` | `number` | `1` | Multiplies the base page margin. |
| `fontFamily` | `'serif' \| 'sans'` | `'serif'` | |
| `writingMode` | `WritingModePref` | `'auto'` | |
| `tapToDefine` | `boolean` | `true` | Tap a JP word to look it up (vs. only toggling chrome). |

> Settings semantics and UI wiring: [`docs/ui-and-design.md`](./ui-and-design.md).

---

## 2. Blob storage (OPFS) — `src/services/storage/blobs.ts`

Layout: OPFS root (`navigator.storage.getDirectory()`) → `books/` directory → one
`${id}.epub` per book. The IndexedDB-backed `*BlobFallback` helpers from `db.ts` are the
fallback path.

**Feature detection — `opfsSupported()`.** A synchronous check for
`navigator.storage.getDirectory` **and** `FileSystemFileHandle.prototype.createWritable`
(older WebKit exposed OPFS with only worker-side sync access handles). This replaced a
per-session `.probe` file create/write/remove. Runtime failures are still handled:
`getBooksDir()` returns `null` (rather than throwing) when `getDirectory` rejects (e.g. a
private-mode `SecurityError`), and a failed OPFS write in `putBook` removes the partial file
and then **falls back to `bookBlobs`** — except for `QuotaExceededError`, which is rethrown
(IDB shares the origin quota, so writing the bytes again would just fail slower).

| Function | Signature | Behaviour |
| --- | --- | --- |
| `putBook` | `(id, data: Blob \| ArrayBuffer) => Promise<void>` | Normalises to `Blob`; writes `books/${id}.epub` via OPFS, else (unsupported, or a non-quota write failure) `putBlobFallback`. |
| `getBookFile` | `(id) => Promise<File \| null>` | Reads the OPFS file; on an OPFS **miss** (absent or zero-length) falls through to `getBlobFallback`. **Re-wraps** as `new File([...], '${id}.epub', { type: 'application/epub+zip' })`. `null` if absent from both. |
| `hasBook` | `(id) => Promise<boolean>` | `getBookFile(id) !== null` — used by the re-import path to restore lost bytes. |
| `deleteBook` | `(id) => Promise<void>` | Removes the OPFS entry (best-effort) **and** always calls `deleteBlobFallback` — covers bytes written before OPFS became usable. |

The normalised name/MIME on `getBookFile` let the `File` pass straight to foliate's
`view.open` / `makeBook` type-sniffing (see [`docs/architecture.md`](./architecture.md)).
`getBookFile` returning `null` is the "missing" signal callers rely on.

---

## 3. IndexedDB schema — `src/services/storage/db.ts`

Opened lazily via a memoised `db()` promise: `openDB<TsuzuriDB>('tsuzuri', 1, { upgrade,
blocking, terminated })`. DB name `tsuzuri`, **version 1**; `upgrade` creates every store
inside an `if (oldVersion < 1)` step (so future versions append steps — see §8).

**Connection lifecycle.** The cached promise is dropped (so the next `db()` reopens) when
the connection dies: `terminated` (iOS WebKit can sever IDB connections after long
backgrounding), `blocking` (a newer build in another tab wants to upgrade — we also
`close()` so it can proceed), or a failed open. Without this a dead handle would be reused
forever.

| Store | keyPath / key | Indexes | Value | Purpose |
| --- | --- | --- | --- | --- |
| `books` | `id` | — | `BookMeta` | Shelf metadata. |
| `progress` | `bookId` | — | `ReadingProgress` | One row per book. |
| `annotations` | `id` | `byBook` → `bookId` | `Annotation` | Highlights & bookmarks; `byBook` enables per-book listing and cascade delete. |
| `settings` | *(out-of-line)* | — | `ReaderSettings` | Single row under explicit key `'reader'`. |
| `bookBlobs` | `id` | — | `StoredBlob` (`{ id, blob }`) | OPFS fallback for EPUB bytes. |

### CRUD helpers

All `await db()` first, so they are safe before the DB has opened.

| Group | Functions |
| --- | --- |
| Books | `putBookMeta`, `getBookMeta`, `getAllBooks`, `deleteBookMeta` |
| Progress | `getProgress`, `getAllProgress` (every row, one transaction — the shelf), `putProgress` |
| Annotations | `getAnnotations` (via `getAllFromIndex('annotations','byBook',id)`), `putAnnotation`, `deleteAnnotation`, `deleteBookCascade` |
| Settings | `loadSettings` (`get('settings','reader')`), `saveSettings` (`put('settings', s, 'reader')`) |
| Blob fallback | `putBlobFallback`, `getBlobFallback` (unwraps `.blob`), `deleteBlobFallback` |

**`deleteBookCascade(id)`** atomically removes the book + dependent rows in **one**
`readwrite` transaction over `books`, `progress`, `annotations`. Annotations are deleted by
walking a cursor on the `byBook` index (no single-key delete for one-to-many). The EPUB
blob is **not** deleted here — the source comment says "blob deletion handled by caller";
`removeBook` in `library.ts` calls `deleteBook(id)` afterwards (see §5, §9).

---

## 4. Persistence helpers — `src/services/storage/persist.ts`

Wrappers over the Storage API, all defensively guarded (`navigator.storage?.…`, try/catch)
so the app never throws on engines lacking the API.

| Export | Signature | Behaviour |
| --- | --- | --- |
| `StorageStatus` | interface | `{ persisted: boolean; usage: number; quota: number }`. |
| `requestPersistence` | `() => Promise<boolean>` | Returns `true` early if already `persisted()`; else calls `persist()`. Safe to call repeatedly. |
| `storageStatus` | `() => Promise<StorageStatus>` | Reads `persisted()` + `estimate()` (usage/quota, default `0`). Zeroed on failure. |
| `formatBytes` | `(n) => string` | Base-1024 B/KB/MB/GB; whole number for bytes, one decimal otherwise; `0 → '0 B'`. |

**Call sites:** `src/main.ts` fires `void requestPersistence()` on startup (fire-and-forget,
before mount). `src/lib/library/ShelfSettings.svelte` calls `storageStatus()` in `onMount`
and renders a usage bar (`{usage} used` plus `of {quota}` when quota is known) and a
**"Persistent"** badge when `persisted`; fill width is `min(100, usage/quota*100)%`, guarded
for `quota === 0`.

---

## 5. Library import flow — `src/services/library.ts`

`importEpub(file: File): Promise<BookMeta>`:

1. `id = sha256Hex(await file.arrayBuffer())` (content hash via `crypto.subtle.digest`,
   hex-encoded). The ArrayBuffer isn't held long-term, keeping peak heap near 1× file size.
2. **Dedupe:** if `getBookMeta(id)` exists, bump `lastOpenedAt`, `putBookMeta`, return it.
   If its bytes are gone (`!hasBook(id)` — evicted/cleared), `putBook` rewrites them first;
   that's what the reader's "please re-import the EPUB" message relies on.
3. **Persist bytes ∥ parse:** `Promise.all([putBook(id, file), parseMeta(file)])` — both only
   read the `File` (OPFS → IndexedDB fallback, §2).
4. **Rollback guard:** the whole step 3 + the `putBookMeta` write run in a `try/catch`; on any
   throw it calls `deleteBook(id)` and rethrows. Once bytes are persisted, a throw — most
   plausibly `putBookMeta` hitting quota on a near-full iPad — would otherwise orphan
   multi-MB OPFS bytes with no `books` row, invisible to the shelf and to `removeBook`,
   leaking against quota.
5. **Parse metadata** (best-effort nested try/catch; failures fall back to defaults +
   `console.warn`; `parseMeta` never rejects): `makeBook(file)` from vendored
   `src/vendor/foliate-js/view.js` — **dynamically imported**, so foliate (view.js + epubcfi
   + zip) stays off the shelf's cold-start critical path — then
   `title` ← `flattenLangMap(meta.title)` else filename; `author` ← array joined with `、`
   else single; `language` ← `meta.language[0]` or string or `''`; `dir` ← `'rtl'`/`'ltr'`;
   `cover` ← `thumbnailCover(book.getCover())` (320px-wide WebP `Blob`) or `undefined`.
6. Build `BookMeta` (`addedAt = lastOpenedAt = now`, `fileSize = file.size`), `putBookMeta`.

`flattenLangMap(x)` collapses EPUB language-map values, **preferring Japanese**:
`map.ja ?? map.ja_JP ?? Object.values(map)[0] ?? ''`; plain strings pass through.

| Function | Behaviour |
| --- | --- |
| `importEpub` | The flow above. |
| `listBooks` | `getAllBooks()` sorted by `lastOpenedAt` **descending**. |
| `touchBook` | Loads meta, bumps `lastOpenedAt`, saves. No-op if missing. |
| `removeBook` | `deleteBookCascade(id)` **then** `deleteBook(id)` (blob). Both required. |
| `getBookFile` | Re-export of `blobs.getBookFile`. |

**UI wiring:** `src/stores/library.svelte.ts` holds reactive shelf state and exposes
`importFiles(files)` (filters to `.epub` / `application/epub+zip`, tracks an `importing`
counter, imports sequentially, refreshing the shelf after each file of a batch and once at the
end). `refreshLibrary` reads `listBooks` + `getAllProgress` in parallel and carries a
generation counter, so an older refresh finishing late can't overwrite a newer one. Failures surface via `library.importError`
(a dismissible shelf alert) — a standalone iOS PWA has no visible console, so a silent error
would just read as "the book never appeared." `Shelf.svelte` triggers import from a hidden
`<input>` (§6/§7) and routes long-press delete to `removeBook`.

---

## 6. PWA setup

### `vite.config.ts` — VitePWA

| Option | Value / effect |
| --- | --- |
| `includeManifestIcons` | `false` — the manifest icons are read by the OS at install, not by the page, so they aren't precached. |
| `registerType` | `'prompt'` — SW does **not** auto-activate an update; the app surfaces a refresh prompt. No `skipWaiting`, so a reading user is never reloaded out from under. |
| `manifest` | `name: 'Tsuzuri — Japanese Reader'`, `short_name: 'Tsuzuri'`, `display: 'standalone'`, `orientation: 'any'`, `background_color`/`theme_color: '#f6f3ec'`. `start_url`/`scope` = `base`. Icons: `icon-192`, `icon-512` (`any`), `maskable-512` (`maskable`). |
| `workbox.clientsClaim` | `true` — a freshly-installed SW takes control of the already-loaded page immediately, so the IPADIC dict fetched *in that first session* (right after download → `warmupLookup`) is runtime-cached while still online. |
| `workbox.globPatterns` | `**/*.{js,css,html}`, `favicon.svg`, `icons/apple-touch-icon-180.png` — **app shell only** (no web fonts are bundled; the app uses the system JP stack). Manifest icons and `public/splash/*` are fetched by the OS at install, so they're not precached. |
| `workbox.globIgnores` | `**/kuromoji/**` and dead foliate format loaders `assets/foliate-{mobi,fb2,comic-book,tts,search}-*.js` — keeps the ~19 MB IPADIC dict and ~37 KB of unreachable chunks out of the install-time precache. The `foliate-` prefix comes from `build.rolldownOptions.output.chunkFileNames` (any chunk whose facade — or every module — is under `src/vendor/foliate-js/`), so the pattern can't catch an app chunk. |
| `workbox.maximumFileSizeToCacheInBytes` | `6 * 1024 * 1024`. |
| `workbox.navigateFallback` | `${base}index.html` — SPA works offline for any in-scope route. |
| `workbox.cleanupOutdatedCaches` | `true` — drops stale caches across deploys. |
| `workbox.runtimeCaching` | The ~19 MB IPADIC `*.dat.gz` under `/kuromoji/dict/`: `CacheFirst`, `cacheName: 'kuromoji-ipadic-v2'` (bump with the dict contents; `main.ts` deletes the superseded `kuromoji-ipadic` at startup, since `cleanupOutdatedCaches` only prunes precaches), `cacheableResponse.statuses: [0, 200]`. **No `expiration`** — neither `maxAgeSeconds` *nor* `maxEntries`. The dict is build-versioned immutable data and an all-or-nothing set of ~12 shards; any LRU/age purge could evict one shard and leave a partial dict (a failed trie build, with no way to refetch offline). `cleanupOutdatedCaches` handles cross-deploy staleness instead. |
| `devOptions` | `{ enabled: true, type: 'module' }` — SW runs under `vite dev` (with `server.host: true` exposing the dev server on the LAN) so install/offline can be tested on-device. |

The `base` is `'/epub/'` for `vite build` (GitHub Pages project site) and `'/'` for
`vite dev`; `start_url`/`scope`/`navigateFallback` all derive from it. Precache is the app
shell only — books live in OPFS and the JP dictionary lives in jpdict's own IndexedDB, so
neither is fetched through the SW. The deploy pipeline, base-path handling, and `sharp` CI
gotcha live in [`docs/deployment.md`](./deployment.md); the dictionary download/warm flow in
[`docs/japanese.md`](./japanese.md).

### `index.html` — iOS meta tags

```html
<meta name="viewport"
  content="width=device-width, initial-scale=1.0, maximum-scale=1.0,
           user-scalable=no, viewport-fit=cover" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="Tsuzuri" />
<link rel="apple-touch-icon" href="/icons/apple-touch-icon-180.png" />
<!-- splash:start … 36 apple-touch-startup-image links … splash:end -->
<meta name="theme-color" content="#f6f3ec" />
<script>/* inline: data-theme + theme-color from localStorage 'tsuzuri:settings' */</script>
```

- `viewport-fit=cover` + `maximum-scale=1, user-scalable=no` → edge-to-edge layout under the
  notch/home indicator, no pinch-zoom. Chrome stays clear of indicators via
  `safe-area-inset-*` (e.g. `--safe-bottom` in `UpdateToast.svelte`).
- `black-translucent` status bar → content renders under the status bar in standalone.
- **One** `theme-color` meta (no `media` variants — they'd fight the runtime value). The inline
  script sets it and `<html data-theme>` synchronously before first paint from the
  localStorage settings mirror (`'auto'` → `prefers-color-scheme`); `applyTheme()` in
  `settings.svelte.ts` then keeps it at the resolved theme's `--paper`, including live OS
  appearance flips while on `'auto'`. The inline script's key and paper colours must stay in
  sync with `settings.svelte.ts` / `app.css`. First launch after upgrading from a pre-mirror
  build has no mirror yet, so it paints `'auto'` for a moment until IDB hydrates.
- **iPad launch screens** (`apple-touch-startup-image`): 9 iPad screen sizes × portrait/landscape
  × light/dark (`prefers-color-scheme`) = 36 PNGs in `public/splash/` (~320 KB total), plain
  paper + the centred app mark. iOS only uses an image whose media query (device-width/height,
  DPR 2, orientation) matches exactly, and fetches them at Add to Home Screen — hence not
  precached. Whether iOS honours the `prefers-color-scheme` variant is **unverified on device**.
  An unlisted iPad size just gets the default blank launch.

### SW registration & update UI

- `src/main.ts` — `registerSW` (from `virtual:pwa-register`) wires `onNeedRefresh` →
  `pwa.needRefresh = true` + `pwa.update = () => updateSW(true)` (skip-waiting reload),
  `onOfflineReady` → `pwa.offlineReady = true`, and `onRegisteredSW` → on
  `visibilitychange → visible` (and online) call `registration.update()`, **at most hourly**.
  An installed PWA is resumed far more often than it's navigated, so the browser's own
  navigation-time update check rarely runs.
- **Update reload returns to the book.** `nav.route` is mirrored to sessionStorage
  (`tsuzuri:route`); after the update reload `main.ts` restores it and `validateRestoredRoute`
  drops back to the shelf if the book was removed. A cold launch is a new session → shelf.
- `src/stores/pwa.svelte.ts` — Svelte 5 `$state`:
  `{ needRefresh, offlineReady, update }`, initialised falsy / no-op.
- `src/lib/components/UpdateToast.svelte` — shows "A new version is ready." + **Refresh**
  (`pwa.update()`) when `needRefresh`; otherwise the one-time "Ready to read offline."
  confirmation when `offlineReady`, auto-dismissed after 4 s via a `$effect` whose cleanup
  clears the timer. Positioned above the bottom safe area
  (`bottom: calc(var(--safe-bottom) + 18px)`).

### Icons — `scripts/gen-icons.mjs`

Run manually (`node scripts/gen-icons.mjs`). Uses **sharp** to rasterise two inline SVGs into
`public/icons/`: a **rounded** mark (rust `#b5552e` square, cream book) → `icon-192.png`,
`icon-512.png`, `apple-touch-icon-180.png`; and a **maskable** variant (full-bleed
background, artwork in the inner 80% safe zone) → `maskable-512.png`. All four PNGs are
present in `public/icons/`. It also renders the iPad launch screens into `public/splash/` and
**rewrites the `<link rel="apple-touch-startup-image">` tags in `index.html`** between the
`splash:start` / `splash:end` markers (edit the `IPADS` list / `PAPER` colours there, not the
HTML).

---

## 7. iOS-specific constraints

The app **targets iOS 26+**. iOS 26 specifics below are the project's stated assumption, not
independently confirmed in-source.

| Capability | iOS Safari status | Accommodation |
| --- | --- | --- |
| **OPFS** (`getDirectory`, `createWritable`) | Supported **16.4+** | Primary EPUB-byte store. `opfsSupported()` feature-checks `createWritable`; non-quota write failures and read misses fall back to `bookBlobs`. |
| **Storage eviction** | Installed (Add-to-Home-Screen / standalone) PWAs are **exempt** from WebKit's 7-day script-writable-storage eviction. | Books survive across sessions when installed; storage is eviction-exempt for the whole origin. Also calls `navigator.storage.persist()` (`requestPersistence`) as belt-and-braces. If a *non-installed* tab is evicted, a `books` row can outlive its OPFS bytes; opening it (`getBookFile` → `null` with meta present) surfaces a specific *"this book's file is no longer on this device — please re-import"* message (`Reader.svelte`). |
| **Storage quota** | **GB-scale** (≈10 GB observed) — not the old 50 MB myth. | `storageStatus()` reads the real `estimate()` quota; no artificial cap. |
| **File System Access API** (`showOpenFilePicker`) | **Not available.** | Import uses a hidden `<input type="file" accept=".epub,application/epub+zip" multiple>` in `Shelf.svelte`, programmatically `.click()`ed. |
| **Web Share Target / file-handler registration** | **Not available.** | No share-sheet / "Open with" entry; import is `<input>`-only. No manifest `share_target` or `file_handlers`. |

The eviction-exemption and ≈10 GB quota are **empirical/behavioural facts asserted by the
project** (recorded in `persist.ts`/`blobs.ts` comments), not API guarantees — treat them as
observed behaviour that can shift between WebKit versions.

### iOS viewport — `src/services/viewport.ts`

`initViewport()` (called once from `src/main.ts`) publishes the visual viewport height as
`--app-height` on `:root` to fix two iOS standalone-PWA behaviours:

- **Cold-launch under-report** — a fresh launch lays out before the standalone window metrics
  and `safe-area-inset-*` settle, leaving a `100dvh` fixed shell briefly too short, so a
  bottom-anchored bar shows a gap that otherwise only clears on rotation.
- **Rotation jitter** — iOS fires a burst of `resize`/`visualViewport` events while
  `window.innerWidth/Height` lag the settled visual viewport.

`viewportSize()` prefers `visualViewport` (reliable even at cold launch) but falls back to the
layout viewport while pinch-zoomed (where `visualViewport` reports the shrunken zoomed box).
Writes are rAF-coalesced, gated by a 2px threshold, and re-asserted on `load` + a 300 ms timeout
to cover the settle window. **Only the fixed `.reader` overlay consumes `var(--app-height, 100dvh)`**;
the in-flow shell (`html`/`body`/`#app`) stays on `100dvh`, because feeding the var into in-flow
layout made iOS re-report a different visual viewport height — a resize→rewrite loop that
oscillated the bottom bar. The **consumer side and reader layout are documented in
[`docs/reader-engine.md`](./reader-engine.md)** (§11).

---

## 8. How to extend

**New IndexedDB store (needs a version bump + migration).** Bump `DB_VERSION` in `db.ts` and
branch on `oldVersion` inside `upgrade()`:

```ts
const DB_VERSION = 2 // was 1
openDB<TsuzuriDB>(DB_NAME, DB_VERSION, {
  upgrade(database, oldVersion /*, newVersion, tx */) {
    if (oldVersion < 1) { /* …existing v1 stores… */ }
    if (oldVersion < 2) database.createObjectStore('shelves', { keyPath: 'id' })
  },
})
```

Also add the store to the `TsuzuriDB extends DBSchema` interface so the typed helpers compile,
then add CRUD wrappers.

**Add a `BookMeta` field.** Add to the interface in `types.ts`, populate in `importEpub`, and
handle older rows where it's `undefined` (a default, or a backfill migration). No store change
needed.

**Change the blob backend.** `blobs.ts` is the only module that touches raw bytes; keep the
contract (`putBook` / `getBookFile` / `hasBook` / `deleteBook`) and the `getBookFile → File`
(`type 'application/epub+zip'`) normalisation. `getBookFile` returning `null` is the "missing"
signal.

**Add a settings field.** Extend `ReaderSettings` + `DEFAULT_SETTINGS` in `types.ts`, then wire
through the settings store/UI. The settings store merge backfills missing keys from
`DEFAULT_SETTINGS`, so no DB migration is needed (the row is stored whole under `'reader'`). See
[`docs/ui-and-design.md`](./ui-and-design.md).

---

## 9. Gotchas

- **Import is `<input>`-only on iOS.** No share-target / file-handler / file-picker path; don't
  reach for `showOpenFilePicker`.
- **OPFS detection checks `createWritable`, not just `getDirectory`.** Presence of
  `getDirectory` ≠ main-thread writes. The check is a feature test; the safety net is
  `putBook`'s catch → IDB fallback and `getBookFile`'s fall-through, so keep both.
- **Settings use an out-of-line key.** The `settings` store has no `keyPath`; reads/writes must
  pass the literal key `'reader'`.
- **`storage.estimate()` is approximate** (coarse for privacy) — only a usage indicator, never
  exact free space.
- **Deleting a book is two steps.** `deleteBookCascade` removes metadata/progress/annotations but
  **not** the blob; always pair with `deleteBook(id)` (this is what `removeBook` does). Bypassing
  `removeBook` orphans EPUB bytes.
- **Dedupe is by content hash.** Re-importing identical bytes bumps `lastOpenedAt` (and restores
  the bytes if they were lost);
  identical content under different filenames collapses to one shelf entry.
- **The IDB blob fallback is always cleaned up.** `deleteBook` deletes from both OPFS and
  `bookBlobs`, so an engine that gained/lost OPFS mid-life never leaks.

---

## 10. Cross-references

- [`docs/architecture.md`](./architecture.md) — overall structure; foliate `view.open` /
  `makeBook` pipeline that consumes `getBookFile`.
- [`docs/reader-engine.md`](./reader-engine.md) — the `--app-height` consumer side and reader
  layout (§11 / app-shell viewport).
- [`docs/deployment.md`](./deployment.md) — GitHub Pages deploy, the `/epub/` base path
  (manifest fields derive from it), and the `sharp` CI gotcha.
- [`docs/japanese.md`](./japanese.md) — the `jpdict` IndexedDB the dictionary fills, and the
  dict download/warm flow.
- [`docs/ui-and-design.md`](./ui-and-design.md) — settings UI, theme-color/safe-area handling,
  `ReaderSettings` semantics.
- [`docs/development.md`](./development.md) — dev server, `devOptions` SW in dev, running
  `scripts/gen-icons.mjs`.
</content>
</invoke>
