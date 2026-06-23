# Storage, Data Model, PWA & iOS Constraints

How **Tsuzuri** persists data, what the data model looks like, how it is packaged as
an installable PWA, and the iOS-specific constraints that shaped those choices.

Two-tier persistence:

- **Structured data** (book metadata, reading progress, annotations, settings)
  lives in **IndexedDB** via the [`idb`](https://github.com/jakearchibald/idb)
  wrapper — see `src/services/storage/db.ts`.
- **Raw EPUB bytes** (multi-MB binaries) live in the **Origin Private File System
  (OPFS)**, with a transparent IndexedDB fallback — see `src/services/storage/blobs.ts`.

All source paths below are relative to the repo root.

---

## 1. Data model — `src/services/types.ts`

This is the single source of truth for every persisted shape. CFI (EPUB Canonical
Fragment Identifier) strings anchor both **progress** and **annotations** so they
survive reflow, font-size changes, and writing-mode changes.

| Export | Kind | Fields / value | Purpose |
| --- | --- | --- | --- |
| `WritingModePref` | type | `'auto' \| 'horizontal' \| 'vertical'` | Reader override on top of what the EPUB declares. |
| `ThemeName` | type | `'light' \| 'sepia' \| 'dark'` | Appearance theme. |
| `BookMeta` | interface | see below | Shelf entry; one per imported book. Persisted in `books` store. |
| `ReadingProgress` | interface | see below | Last-read position per book. Persisted in `progress` store. |
| `AnnotationKind` | type | `'highlight' \| 'bookmark'` | Discriminates an `Annotation`. |
| `HIGHLIGHT_HEX` | const | `string` | The single highlight colour — yellow `#ffd54a`, chosen to read well behind text at the overlay's ~0.3 opacity. Highlights are no longer multi-colour (the colour picker was dropped); there is no `HighlightColor` type or per-highlight `color` field. |
| `Annotation` | interface | see below | A highlight or bookmark, CFI-anchored. Persisted in `annotations` store. |
| `ReaderSettings` | interface | see below | Global (not per-book) appearance + behaviour prefs. Persisted in `settings` store under key `'reader'`. |
| `DEFAULT_SETTINGS` | const | `ReaderSettings` | Seed values used before/absent any saved settings. |

### `BookMeta`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | **SHA-256 of the raw file bytes** (lowercase hex). Doubles as the OPFS filename stem and the dedupe key. |
| `title` | `string` | From EPUB metadata; falls back to filename without `.epub`. |
| `author` | `string` | From EPUB metadata; multiple authors joined with `、` (U+3001). |
| `language` | `string` | BCP-47 tag from the EPUB, e.g. `"ja"`. |
| `dir` | `'ltr' \| 'rtl'` | Page-progression direction declared by the EPUB (`'rtl'` for most vertical JP novels). |
| `cover?` | `Blob` | Cover image extracted via foliate `book.getCover()`. Stored inline in IndexedDB. |
| `fileName` | `string` | Original imported filename. |
| `fileSize` | `number` | Byte length of the EPUB (`buf.byteLength`). |
| `addedAt` | `number` | Epoch ms of import. |
| `lastOpenedAt` | `number` | Epoch ms; drives shelf sort order (desc) and is bumped on open/re-import. |

### `ReadingProgress`

| Field | Type | Notes |
| --- | --- | --- |
| `bookId` | `string` | Key (`keyPath: 'bookId'`); equals `BookMeta.id`. |
| `cfi` | `string` | EPUB CFI from foliate's `relocate` event — the anchor that survives reflow. |
| `fraction` | `number` | `0..1` overall progress; drives the shelf progress ring. |
| `label?` | `string` | Current TOC section label. |
| `updatedAt` | `number` | Epoch ms. |

### `Annotation`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Primary key. |
| `bookId` | `string` | Indexed by `byBook` for per-book queries and cascade delete. |
| `kind` | `AnnotationKind` | `'highlight'` or `'bookmark'`. |
| `cfi` | `string` | CFI anchor (range for highlights, point for bookmarks). |
| `text` | `string` | Selected text (highlights) or a short context snippet (bookmarks). For tap-to-define highlights this is the looked-up word. |
| `note?` | `string` | Optional user note. |
| `sectionLabel?` | `string` | TOC label of the containing section, for grouping in the annotations panel. |
| `createdAt` | `number` | Epoch ms. |

### `ReaderSettings` and `DEFAULT_SETTINGS`

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `theme` | `ThemeName` | `'light'` | |
| `fontScale` | `number` | `1` | `1` = 100%. |
| `lineHeight` | `number` | `1.9` | |
| `marginScale` | `number` | `1` | Multiplies the base page margin. |
| `fontFamily` | `'serif' \| 'sans'` | `'serif'` | |
| `writingMode` | `WritingModePref` | `'auto'` | |
| `tapToDefine` | `boolean` | `true` | A tap on a Japanese word looks it up (vs. only toggling chrome). |

> Settings semantics, the settings store, and UI wiring are detailed in
> [`docs/ui-and-design.md`](./ui-and-design.md).

---

## 2. Blob storage (OPFS) — `src/services/storage/blobs.ts`

Raw EPUB bytes are stored in the **Origin Private File System**. The directory layout is
`navigator.storage.getDirectory()` (OPFS root) → `books/` directory → one file
`${id}.epub` per book, where `id` is the SHA-256 content hash. The IndexedDB-backed
helpers (`putBlobFallback` / `getBlobFallback` / `deleteBlobFallback` from `db.ts`) are the
fallback path.

### Feature detection — `canUseOpfs()`

Memoised in module-scope flags (`opfsChecked`, `opfsUsable`); the probe runs at most once
per page load. It does **not** trust mere presence of `getDirectory` — it actually
*exercises a write*, because some engines expose OPFS handles without a working
`createWritable`:

```ts
async function canUseOpfs(): Promise<boolean> {
  if (opfsChecked) return opfsUsable
  opfsChecked = true
  const dir = await getBooksDir()
  if (!dir) return (opfsUsable = false)
  try {
    const probe = await dir.getFileHandle('.probe', { create: true })
    if (typeof (probe as any).createWritable !== 'function') {
      await dir.removeEntry('.probe').catch(() => {})
      return (opfsUsable = false)
    }
    const w = await probe.createWritable()
    await w.write(new Blob([new Uint8Array([1])]))
    await w.close()
    await dir.removeEntry('.probe').catch(() => {})
    return (opfsUsable = true)
  } catch {
    return (opfsUsable = false)
  }
}
```

`getBooksDir()` returns `null` (rather than throwing) when `navigator.storage.getDirectory`
is missing or the directory handle can't be obtained, forcing the fallback path.

### Public API

| Function | Signature | Behaviour |
| --- | --- | --- |
| `putBook` | `(id: string, data: Blob \| ArrayBuffer) => Promise<void>` | Normalises `data` to a `Blob`; if `canUseOpfs()` writes `books/${id}.epub` via `getFileHandle({create:true})` → `createWritable()` → `write` → `close`; otherwise calls `putBlobFallback(id, blob)`. |
| `getBookFile` | `(id: string) => Promise<File \| null>` | If OPFS: reads the handle via `getFile()`, then **re-wraps** it as `new File([file], '${id}.epub', { type: 'application/epub+zip' })`. Otherwise reads `getBlobFallback(id)` and wraps the same way. Returns `null` if absent. |
| `deleteBook` | `(id: string) => Promise<void>` | Removes the OPFS entry (best-effort, swallows errors) **and** always calls `deleteBlobFallback(id)` — covering blobs written before OPFS became usable. |

The `File` returned by `getBookFile` is normalised to name `${id}.epub` and MIME
`application/epub+zip` so it can be passed straight to foliate's `view.open` /
`makeBook` type-sniffing without further massaging. (See foliate integration in
[`docs/architecture.md`](./architecture.md).)

---

## 3. IndexedDB schema — `src/services/storage/db.ts`

Opened lazily via a memoised `db()` promise: `openDB<TsuzuriDB>('tsuzuri', 1, { upgrade })`.
DB name `tsuzuri`, **version 1**. The `upgrade` callback creates every store (no migrations
yet — see §8).

### Object stores

| Store | keyPath / key | Indexes | Value type | Purpose |
| --- | --- | --- | --- | --- |
| `books` | `id` | — | `BookMeta` | Shelf metadata. |
| `progress` | `bookId` | — | `ReadingProgress` | Last-read position, one row per book. |
| `annotations` | `id` | `byBook` → `bookId` | `Annotation` | Highlights & bookmarks; `byBook` enables per-book listing and cascade delete. |
| `settings` | *(out-of-line)* | — | `ReaderSettings` | Single row stored under the explicit key `'reader'`. |
| `bookBlobs` | `id` | — | `{ id: string; blob: Blob }` (`StoredBlob`) | OPFS fallback for EPUB bytes. |

`upgrade()`:

```ts
upgrade(database) {
  database.createObjectStore('books', { keyPath: 'id' })
  database.createObjectStore('progress', { keyPath: 'bookId' })
  const ann = database.createObjectStore('annotations', { keyPath: 'id' })
  ann.createIndex('byBook', 'bookId')
  database.createObjectStore('settings')               // out-of-line keys
  database.createObjectStore('bookBlobs', { keyPath: 'id' })
}
```

> **Note:** `DB_VERSION` was never bumped when an earlier `translations` store was
> removed, so a device that ran an older build keeps that empty, unused
> `translations` object store. It is harmless (nothing reads or writes it) and
> would only be dropped by a future migration that bumps the version.

### CRUD helpers

All helpers `await db()` first, so they are usable before the DB has opened.

| Group | Function | Signature |
| --- | --- | --- |
| Books | `putBookMeta` | `(meta: BookMeta) => Promise<void>` |
| | `getBookMeta` | `(id: string) => Promise<BookMeta \| undefined>` |
| | `getAllBooks` | `() => Promise<BookMeta[]>` |
| | `deleteBookMeta` | `(id: string) => Promise<void>` |
| Progress | `getProgress` | `(bookId: string) => Promise<ReadingProgress \| undefined>` |
| | `putProgress` | `(p: ReadingProgress) => Promise<void>` |
| Annotations | `getAnnotations` | `(bookId: string) => Promise<Annotation[]>` (via `getAllFromIndex('annotations','byBook',bookId)`) |
| | `putAnnotation` | `(a: Annotation) => Promise<void>` |
| | `deleteAnnotation` | `(id: string) => Promise<void>` |
| | `deleteBookCascade` | `(id: string) => Promise<void>` — see below |
| Settings | `loadSettings` | `() => Promise<ReaderSettings \| undefined>` (`get('settings','reader')`) |
| | `saveSettings` | `(s: ReaderSettings) => Promise<void>` (`put('settings', s, 'reader')`) |
| Blob fallback | `putBlobFallback` | `(id: string, blob: Blob) => Promise<void>` |
| | `getBlobFallback` | `(id: string) => Promise<Blob \| undefined>` (unwraps `.blob`) |
| | `deleteBlobFallback` | `(id: string) => Promise<void>` |

### `deleteBookCascade`

Atomic removal of a book and all its dependent rows in **one** `readwrite` transaction over
`books`, `progress`, and `annotations`. Annotations are deleted by walking a cursor on the
`byBook` index (there is no single-key delete for a one-to-many relation):

```ts
const tx = database.transaction(['books', 'progress', 'annotations'], 'readwrite')
await tx.objectStore('books').delete(id)
await tx.objectStore('progress').delete(id)
const annStore = tx.objectStore('annotations')
let cursor = await annStore.index('byBook').openCursor(id)
while (cursor) {
  await cursor.delete()
  cursor = await cursor.continue()
}
await tx.done
```

> **Note:** the EPUB blob is *not* deleted here — the source comment says "blob deletion
> handled by caller." `removeBook` in `library.ts` is responsible for calling
> `deleteBook(id)` afterwards (see §5 and the gotcha in §9).

---

## 4. Persistence helpers — `src/services/storage/persist.ts`

Wrappers over the Storage API that request durability and report usage. All calls are
defensively wrapped (`navigator.storage?.…`, try/catch) so the app never throws on engines
lacking the API.

| Export | Signature | Behaviour |
| --- | --- | --- |
| `StorageStatus` | interface | `{ persisted: boolean; usage: number; quota: number }`. |
| `requestPersistence` | `() => Promise<boolean>` | Returns `true` early if `navigator.storage.persisted()` is already `true`; else calls `navigator.storage.persist()` and returns its result. Safe to call repeatedly. |
| `storageStatus` | `() => Promise<StorageStatus>` | Reads `persisted()` and `estimate()` (`usage`/`quota`, default `0`). Returns zeroed status on any failure. |
| `formatBytes` | `(n: number) => string` | Human-readable B/KB/MB/GB (base-1024); whole number for bytes, one decimal otherwise. `0` → `'0 B'`. |

**Call sites:**

- `src/main.ts` fires `void requestPersistence()` on startup (fire-and-forget; result
  ignored). Runs before the app is mounted.
- `src/lib/library/ShelfSettings.svelte` calls `storageStatus()` in `onMount` and renders a
  usage bar: `{formatBytes(status.usage)} used of {formatBytes(status.quota)}`, plus a
  **"Persistent"** badge when `status.persisted` is true. The fill width is
  `min(100, usage / quota * 100)%`, guarded for `quota === 0`.

---

## 5. Library import flow — `src/services/library.ts`

`importEpub(file: File): Promise<BookMeta>` is the entry point. Sequence:

1. `await file.arrayBuffer()` → `id = sha256Hex(buf)` (content hash via
   `crypto.subtle.digest('SHA-256', buf)`, hex-encoded).
2. **Dedupe:** `getBookMeta(id)`. If a book with that hash already exists, only bump
   `lastOpenedAt = Date.now()`, `putBookMeta`, and return it — the bytes are *not* re-stored.
3. **Persist bytes:** `await putBook(id, file)` (OPFS, fallback to IndexedDB — §2).
4. **From here, any failure rolls the bytes back.** Steps 4–5 run inside a `try/catch`; on
   any throw it calls `deleteBook(id)` and rethrows. The bytes are already in OPFS at this
   point, so a throw — most plausibly `putBookMeta` hitting quota on a near-full iPad — would
   otherwise orphan multi-MB OPFS bytes with no `books` row pointing at them: invisible to the
   shelf and to `removeBook` (which deletes by *known* id), leaking against quota forever.
5. **Parse metadata** (best-effort, in a nested try/catch — failures fall back to defaults and
   only `console.warn`): `await makeBook(file)` from the vendored
   `src/vendor/foliate-js/view.js`, then:
   - `title` ← `flattenLangMap(meta.title)` else filename minus `.epub`.
   - `author` ← array → `flattenLangMap(a.name ?? a)` per entry joined with `、`; else
     `flattenLangMap(meta.author)`.
   - `language` ← `meta.language[0]` if array, else `meta.language`, else `''`.
   - `dir` ← `book.dir === 'rtl' ? 'rtl' : 'ltr'`.
   - `cover` ← `thumbnailCover(await book.getCover())` (downscaled WebP `Blob`) or `undefined`.
6. Build `BookMeta` (with `addedAt = lastOpenedAt = Date.now()`, `fileSize = file.size`)
   and `putBookMeta`.

`flattenLangMap(x)` collapses EPUB language-map values, **preferring Japanese**:
`map.ja ?? map.ja_JP ?? Object.values(map)[0] ?? ''`. Plain strings pass through; non-objects
yield `''`.

| Function | Signature | Behaviour |
| --- | --- | --- |
| `importEpub` | `(file: File) => Promise<BookMeta>` | The flow above. |
| `listBooks` | `() => Promise<BookMeta[]>` | `getAllBooks()` sorted by `lastOpenedAt` **descending**. |
| `touchBook` | `(id: string) => Promise<void>` | Loads meta, bumps `lastOpenedAt`, saves. No-op if missing. |
| `removeBook` | `(id: string) => Promise<void>` | `deleteBookCascade(id)` **then** `deleteBook(id)` (blob). Both steps required. |
| `getBookFile` | re-export of `blobs.getBookFile` | Convenience re-export. |

**UI wiring:** `src/stores/library.svelte.ts` holds the reactive shelf state and exposes
`importFiles(files)` (filters to `.epub` / `application/epub+zip`, tracks an `importing`
counter, imports sequentially, then `refreshLibrary()`). A per-file failure is counted and,
when any fail, surfaced via `library.importError` — a dismissible alert on the shelf — because
a standalone iOS PWA has no visible console, so a silent `console.error` would just read as
"the book never appeared." `src/lib/library/Shelf.svelte` triggers import from a hidden
`<input>` (see §6/§7) and on long-press exposes a delete action that routes to `removeBook`.

---

## 6. PWA setup

### `vite.config.ts` — VitePWA

```ts
// base is '/epub/' for `vite build` (GitHub Pages project site), '/' for `vite dev`.
const base = command === 'build' ? '/epub/' : '/'

VitePWA({
  registerType: 'prompt',                                  // user-confirmed updates
  includeAssets: ['favicon.svg', 'icons/apple-touch-icon-180.png'],
  manifest: {
    name: 'Tsuzuri — Japanese Reader',
    short_name: 'Tsuzuri',
    description: '…paginated EPUB reader for Japanese books, with built-in offline dictionary lookup.',
    lang: 'en',
    display: 'standalone',
    orientation: 'any',
    background_color: '#f6f3ec',
    theme_color: '#f6f3ec',
    start_url: base, scope: base,                          // derived from base ('/epub/' in build)
    icons: [
      { src: 'icons/icon-192.png',    sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icons/icon-512.png',    sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  },
  workbox: {
    clientsClaim: true,                                   // control the page on first activation
    globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],   // app shell only
    globIgnores: ['**/pdfjs/**', '**/kuromoji/**', /* dead format loaders */],
    maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
    navigateFallback: `${base}index.html`,                // base-derived
    cleanupOutdatedCaches: true,
    runtimeCaching: [{                                    // ~19 MB IPADIC dict, fetched on first use
      urlPattern: /\/kuromoji\/dict\/.*\.dat\.gz$/,
      handler: 'CacheFirst',
      options: { cacheName: 'kuromoji-ipadic', expiration: { maxEntries: 16 },  // NO maxAgeSeconds — immutable, build-versioned
                 cacheableResponse: { statuses: [0, 200] } },
    }],
  },
  devOptions: { enabled: true, type: 'module' },           // SW runs in `vite dev`
})
```

Key points:

- The manifest `start_url`/`scope` and the Workbox `navigateFallback` are **derived
  from `base`**, which is `'/epub/'` for the production build (the app is served from
  the GitHub Pages project site `https://huangwaylon.github.io/epub/`) and `'/'` under
  `vite dev`. So the installed PWA opens and scopes correctly under `/epub/` in
  production while local development stays at the root. See
  [`docs/deployment.md`](./deployment.md) for the deploy pipeline, the base-path
  handling, and the `sharp` CI gotcha — not duplicated here.
- **`registerType: 'prompt'`** → the SW does not auto-activate an *update*; the app surfaces a
  refresh prompt (below). It does **not** skipWaiting, so a reading user is never reloaded out
  from under themselves.
- **`clientsClaim: true`** → on first install the freshly-activated SW takes control of the
  already-loaded page immediately. This is what lets the IPADIC dict the lookup worker fetches
  *in that first session* (right after the dictionary download → `await warmupLookup()`) be
  runtime-cached while still online; without it the SW wouldn't control the page until a reload,
  and the first offline tap would fail to fetch the dict and silently degrade to greedy
  segmentation. The download handlers **await** the warm (it resolves once the ~19 MB fetch
  completes) and show a *"Caching dictionary for offline use…"* state until then, so the app never
  reports offline-readiness before the dict is genuinely cached.
- **The dict cache has no `maxAgeSeconds`.** The IPADIC `*.dat.gz` are build-versioned immutable
  data, so an age-based purge would silently evict them from a long-lived offline install and
  degrade tap-to-define with no way to refetch. `cleanupOutdatedCaches` already drops stale caches
  across deploys, so a `CacheFirst` with `maxEntries` only is the correct policy.
- The **apple-touch icon (180)** is in `includeAssets` (it is not part of the web manifest
  `icons` array, which iOS largely ignores — iOS uses the `<link rel="apple-touch-icon">`).
- **Precache is the app shell only.** Books live in OPFS and the JP dictionary lives in
  jpdict's own IndexedDB — neither is fetched through the SW, so neither is precached.
- `globIgnores` keeps the large PDF.js bundle and the ~19 MB kuromoji IPADIC dict out of the
  install-time precache; the dict is instead **runtime-cached** (`CacheFirst`) on first use, so
  word segmentation works offline thereafter.
- `navigateFallback: '${base}index.html'` makes the SPA work offline for any route under the scope.
- `devOptions.enabled: true` runs the SW under `vite dev` so install/offline can be tested
  on-device (the `server.host: true` setting exposes the dev server on the LAN for that).

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
<meta name="theme-color" content="#f6f3ec" media="(prefers-color-scheme: light)" />
<meta name="theme-color" content="#16140f" media="(prefers-color-scheme: dark)" />
```

- `viewport-fit=cover` + `maximum-scale=1, user-scalable=no` → edge-to-edge layout under the
  notch/home indicator, no pinch-zoom. The app uses the `safe-area-inset-*` env vars (e.g.
  `--safe-bottom` in `UpdateToast.svelte`) to keep chrome clear of the indicators.
- `apple-mobile-web-app-status-bar-style: black-translucent` lets content render under the
  status bar in standalone mode.
- The two media-scoped `theme-color` tags give light/dark status-bar tinting; the comment
  notes it is also updated at runtime per the active reader theme (see
  [`docs/ui-and-design.md`](./ui-and-design.md)).

### `src/main.ts` — SW registration

```ts
const updateSW = registerSW({
  onNeedRefresh()  { pwa.needRefresh = true; pwa.update = () => updateSW(true) },
  onOfflineReady() { pwa.offlineReady = true },
})
```

`registerSW` comes from `virtual:pwa-register` (vite-plugin-pwa). On a waiting update it sets
`pwa.needRefresh` and wires `pwa.update` to `updateSW(true)` (which skips waiting and reloads).
`onOfflineReady` (fired once when the SW first precaches the shell) sets `pwa.offlineReady`.

### `src/stores/pwa.svelte.ts` — update store

A Svelte 5 `$state` object: `{ needRefresh: boolean; offlineReady: boolean; update: () => void }`,
all initialised falsy / no-op.

### `src/lib/components/UpdateToast.svelte`

Renders the **update** prompt when `pwa.needRefresh` — "A new version is ready." with a
**Refresh** button (`pwa.update()`) and a dismiss button — and otherwise the one-time
**"Ready to read offline."** confirmation when `pwa.offlineReady`. The offline confirmation
auto-dismisses after 4 s via a `$effect` whose cleanup clears the timer (so no stray timer
survives a manual dismiss or unmount). Positioned above the bottom safe area
(`bottom: calc(var(--safe-bottom) + 18px)`).

### Icons — `scripts/gen-icons.mjs`

Run manually: `node scripts/gen-icons.mjs`. Uses **sharp** to rasterise two inline SVGs into
`public/icons/`:

- a **rounded** mark (rust square `#b5552e`, cream book, vertical-text strokes) → `icon-192.png`,
  `icon-512.png`, `apple-touch-icon-180.png`;
- a **maskable** variant (full-bleed background, artwork scaled to the inner 80% safe zone) →
  `maskable-512.png`.

(Verified present: all four PNGs exist in `public/icons/`.)

---

## 7. iOS-specific constraints

The app **targets iOS 26+** (current is iOS 18 at time of writing; **iOS 26 specifics below
are the app's stated assumption, not independently confirmed in-source** — flagged inline).

| Capability | Status on iOS Safari | How the app accommodates |
| --- | --- | --- |
| **OPFS** (`navigator.storage.getDirectory`, `createWritable`) | Supported **iOS Safari 16.4+** | Primary store for EPUB bytes (`blobs.ts`). `canUseOpfs()` write-probes before trusting it; falls back to the `bookBlobs` IndexedDB store otherwise. |
| **Storage eviction** | **Installed (Add-to-Home-Screen / standalone) PWAs are EXEMPT** from WebKit's 7-day script-writable-storage eviction → durable. | Books survive across sessions when installed. The app installs under the production scope `https://huangwaylon.github.io/epub/`; storage is keyed to that origin (eviction-exempt for the whole origin once installed). App *also* calls `navigator.storage.persist()` (`requestPersistence` in `main.ts`) as belt-and-braces. If a *non-installed* Safari tab is evicted, a `books` meta row can outlive its OPFS bytes; opening such a book (`getBookFile` → `null` with meta present) now surfaces a specific *"this book's file is no longer on this device — please re-import"* message rather than a generic "not found". |
| **Storage quota** | **GB-scale** (≈10 GB observed in testing) — **not** the old 50 MB myth. | `storageStatus()` reads the real `estimate()` quota and surfaces it in ShelfSettings; no artificial cap in app code. |
| **File System Access API** (`showOpenFilePicker`) | **Not available on iOS.** | Import uses a plain `<input type="file" accept=".epub,application/epub+zip" multiple hidden>` in `Shelf.svelte`, programmatically `.click()`ed. Works in standalone. |
| **Web Share Target / file-handler registration** | **Not available on iOS.** | No "Open in Tsuzuri" share-sheet / Files "Open with" entry. Import is `<input>`-only; users pick the EPUB from inside the app (Files, iCloud Drive, etc.). Documented limitation — there is no manifest `share_target` or `file_handlers`. |

Eviction-exemption and the ≈10 GB quota figure are **empirical/behavioural facts asserted by
the project** (recorded in the `persist.ts`/`blobs.ts` comments and this doc), not API
guarantees — treat them as observed behaviour that can change between WebKit versions.

---

## 8. How to extend

**Add a new IndexedDB store (requires a version bump + migration).** Bump `DB_VERSION` in
`db.ts` and branch on `oldVersion` inside `upgrade()` so existing users migrate without losing
data:

```ts
const DB_VERSION = 2 // was 1

openDB<TsuzuriDB>(DB_NAME, DB_VERSION, {
  upgrade(database, oldVersion /*, newVersion, tx */) {
    if (oldVersion < 1) {
      /* …existing v1 stores… */
    }
    if (oldVersion < 2) {
      database.createObjectStore('shelves', { keyPath: 'id' })
    }
  },
})
```

Also add the store to the `TsuzuriDB extends DBSchema` interface (key/value/indexes) so the
typed helpers compile, then add CRUD wrappers alongside the existing ones.

**Add a field to `BookMeta`.** Add it to the interface in `types.ts`, populate it in
`importEpub` (`library.ts`), and handle older rows where it is `undefined` (a migration in
`upgrade()` can backfill if a default isn't enough). No store change is needed since `books`
already exists.

**Change the blob backend.** `blobs.ts` is the only module that touches raw bytes; keep the
three-function contract (`putBook` / `getBookFile` / `deleteBook`) and the
`getBookFile → File(type 'application/epub+zip')` normalisation so foliate keeps working.
`getBookFile` returning `null` is the "missing" signal callers rely on.

**Add a settings field.** Extend `ReaderSettings` and `DEFAULT_SETTINGS` in `types.ts`, then
wire it through the settings store and UI. The merge in the settings store backfills missing
keys from `DEFAULT_SETTINGS`, so no DB migration is required (the row is stored whole under
key `'reader'`). See [`docs/ui-and-design.md`](./ui-and-design.md).

---

## 9. Gotchas

- **Import is `<input>`-only on iOS.** There is no share-target / file-handler / file-picker
  path; everything routes through the hidden `<input type="file">` in `Shelf.svelte`. Don't
  reach for `showOpenFilePicker`.
- **OPFS feature detection must actually write.** Presence of `getDirectory` ≠ a working
  `createWritable`. `canUseOpfs()` writes & deletes a `.probe` file; preserve that behaviour
  rather than checking only for API presence.
- **Settings use an out-of-line key.** The `settings` store has no `keyPath`; reads/writes
  must pass the literal key `'reader'` (`get('settings','reader')` /
  `put('settings', s, 'reader')`). Easy to forget.
- **`storage.estimate()` is approximate** and intentionally coarse for privacy; never derive
  exact free space from it, only a usage indicator.
- **Deleting a book is two steps.** `deleteBookCascade` removes metadata/progress/annotations
  but **not** the blob. Always pair it with `deleteBook(id)` (this is what `removeBook` does).
  Bypassing `removeBook` will orphan EPUB bytes in OPFS/`bookBlobs`.
- **Dedupe is by content hash.** Re-importing identical bytes only bumps `lastOpenedAt`;
  different filenames with identical content collapse to one shelf entry.
- **The IDB blob fallback is always cleaned up.** `deleteBook` deletes from both OPFS and
  `bookBlobs` so an engine that gained/lost OPFS mid-life never leaks.

---

## 10. Cross-references

- [`docs/architecture.md`](./architecture.md) — overall structure; foliate `view.open` /
  `makeBook` rendering pipeline that consumes `getBookFile`.
- [`docs/deployment.md`](./deployment.md) — GitHub Pages deploy pipeline, the `/epub/`
  production base path (manifest `start_url`/`scope`/`navigateFallback` derive from it),
  and the `sharp` CI gotcha.
- [`docs/ui-and-design.md`](./ui-and-design.md) — settings UI, theme-color/safe-area handling,
  `ReaderSettings` semantics.
- [`docs/development.md`](./development.md) — dev server (`server.host`), `devOptions` SW in
  dev, running `scripts/gen-icons.mjs`.
