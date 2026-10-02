# Storage, Data Model, PWA & iOS Constraints

How Tsuzuri persists data, ships as an installable PWA, and works around iOS. Deployment and
the `/epub/` base: [deployment.md](./deployment.md). JMdict and the IPADIC cache:
[japanese.md §7](./japanese.md).

- **Structured data** → IndexedDB `tsuzuri` via `idb` (`src/services/storage/db.ts`).
- **EPUB bytes** → OPFS, IndexedDB fallback (`src/services/storage/blobs.ts`). Bundled books
  land in the same store (§4a).
- **JMdict** → jpdict-idb's own IndexedDB. **kuromoji dict** → Cache API (service worker).

## 1. Data model — `src/services/types.ts`

| Type | Fields |
|---|---|
| `BookMeta` (`books`) | `id` (SHA-256 hex of the bytes; OPFS file stem and dedupe key), `title` (falls back to the file name), `author` (multiple joined with `、`), `language`, `dir: 'ltr' \| 'rtl'` (page progression), `cover?: Blob` (≤320px-wide WebP), `slug?` (bundled books: the catalog slug, stable across rebuilds), `fileName`, `fileSize`, `addedAt`, `lastOpenedAt` (shelf sort, descending) |
| `ReadingProgress` (`progress`) | `bookId`, `cfi`, `fraction` (0..1, shelf ring), `label?`, `updatedAt` |
| `Annotation` (`annotations`) | `id`, `bookId`, `kind: 'highlight' \| 'bookmark'`, `cfi`, `text` (selection, looked-up word, or bookmark snippet), `note?`, `sectionLabel?`, `createdAt` |
| `ReaderSettings` (`settings['reader']`) | below |

`HIGHLIGHT_HEX = '#ffd54a'` is the only highlight colour; annotations have no colour field.

| `DEFAULT_SETTINGS` | Default | |
|---|---|---|
| `theme` | `'auto'` | follows `prefers-color-scheme` (light ↔ dark); or `light`/`sepia`/`dark` |
| `fontScale` | `1` | 1 = 100% |
| `lineHeight` | `1.9` | |
| `marginScale` | `1` | multiplies the base page margin |
| `fontFamily` | `'serif'` | or `'sans'` |
| `writingMode` | `'auto'` | override of the EPUB's mode |
| `highlightLookups` | `true` | tap-to-define also highlights the word |
| `showEnglish` | `true` | show-all English in translated books ([translation.md](./translation.md)) |
| `sidewaysHintShown` | `false` | the one-time "English runs sideways" toast was shown |

The settings store keeps only keys present in `DEFAULT_SETTINGS` and backfills missing ones, so
a new field needs no migration. A renamed key goes in its `RENAMED` map (`showTranslations` →
`showEnglish`).

## 2. IndexedDB — `src/services/storage/db.ts`

`openDB('tsuzuri', 1)`. `upgrade` creates everything in an `if (oldVersion < 1)` step; a new
version adds its own `if (oldVersion < N)` step and extends the `TsuzuriDB` schema interface.

| Store | Key | Index | Value |
|---|---|---|---|
| `books` | `id` | — | `BookMeta` |
| `progress` | `bookId` | — | `ReadingProgress` |
| `annotations` | `id` | `byBook` → `bookId` | `Annotation` |
| `settings` | out-of-line, always `'reader'` | — | `ReaderSettings` |
| `bookBlobs` | `id` | — | `{ id, blob }` (OPFS fallback) |

**Connection lifecycle.** `db()` memoises the open promise and drops it on `terminated` (iOS
WebKit severs connections after long backgrounding), on `blocking` (it also closes, so a newer
build's upgrade can proceed), and on a failed open.

`deleteBookCascade(id)` deletes `books` + `progress` + the book's annotations in one
transaction but not the bytes. `moveBookData(from, to)` re-homes progress and annotations to
a new id (bundled-book update, §4a).

## 3. EPUB bytes — `src/services/storage/blobs.ts`

Stored as OPFS `books/<id>.epub`.
- `opfsSupported()` checks `navigator.storage.getDirectory` and
  `FileSystemFileHandle.prototype.createWritable` (older WebKit had only worker-side sync
  handles). `getBooksDir()` returns `null` if the directory is refused (private-mode
  `SecurityError`).
- `putBook` writes to OPFS; on a failed write it removes the partial file and falls back to
  `bookBlobs`, except on `QuotaExceededError`, which is rethrown (IndexedDB shares the quota).
- `getBookFile(id)` reads OPFS, falling through to `bookBlobs` if missing or empty, and
  re-wraps as `File('<id>.epub', 'application/epub+zip')` for foliate's type sniffing. `null`
  means the bytes are missing.
- `deleteBook(id)` removes from OPFS and `bookBlobs`, both best-effort.

## 4. Library import — `src/services/library.ts`

`importEpub(file, { expectedId?, meta? })`:
1. `id = sha256Hex(await file.arrayBuffer())`, the buffer unbound so peak heap stays near 1×
   the file (large EPUBs can OOM an iPad tab). A different hash than `expectedId` throws
   `ChecksumError` before anything is stored.
2. **Dedupe:** an existing meta row gets its bytes restored if missing and `lastOpenedAt`
   bumped. The reader's "please re-import" error relies on this.
3. `Promise.all([putBook(id, file), meta ?? parseMeta(file)])`. With `meta` foliate is not
   loaded. `parseMeta` imports foliate's `makeBook` dynamically and never throws (falls back to
   the file-name title, no cover). `flattenLangMap` prefers `ja`, then `ja_JP`, then the first
   value. The cover is downscaled to a 320px-wide WebP via `OffscreenCanvas`, keeping the
   original if that fails or is larger.
4. `putBookMeta`. If step 3 or 4 throws, `deleteBook(id)` rolls back the bytes.

`removeBook` = `deleteBookCascade` + `deleteBook`; always use it (the cascade alone orphans
the bytes). `supersedeBook(old, new)` = `moveBookData` + `removeBook(old)`. The `library`
store surfaces failures in `library.importError`, because a standalone iOS PWA has no
visible console.

## 4a. Bundled books — `src/services/catalog.ts`

`public/books/` (built by `npm run books:build`, [translation.md](./translation.md)) holds
`<slug>.epub`, a 320px `<slug>.webp` cover and `catalog.json`:
`[{slug, id, title, author, language, dir, file, size, cover, translation?: {lang, coverage}}]`.
`id` is the EPUB's SHA-256, i.e. its library id. Malformed entries are dropped.

- **Status** (`deriveStatus`): in the library ⇒ `downloaded`; else the store's job
  (`downloading` 0–1, or `error`); else `update` if the library has an older build of the same
  slug (`bookSlug`: `BookMeta.slug`, else a `<slug>.epub` file name); else `available`.
  Deleting a book returns it to `available`; nothing is auto-imported.
- **Download** (`downloadEntry`): fetch with `cache: 'no-cache'` (Pages serves `max-age=600`,
  and a cached older build fails the checksum), stream progress against Content-Length
  (ignored when content-encoded; falls back to `size`), fetch the cover (best-effort, from the
  precache), then `importEpub(file, { expectedId: id, meta })`.
- **Stale app catalog:** on a `ChecksumError` the store refetches `catalog.json` bypassing the
  precache and HTTP cache (`fetchCatalog({ fresh: true })`) and retries once against the live
  entry for that slug.
- **Update:** after a download, an older build of the same slug is replaced via
  `supersedeBook`, carrying progress and annotations over (CFIs survive: the rebuild keeps the
  Japanese DOM and CFIs skip the English).
- **Errors** (`downloadErrorMessage`): `NetworkError` (fetch / body read failed) or offline →
  "You're offline…", `ChecksumError` → "corrupted", `QuotaExceededError` → "Not enough
  storage", else a generic retry. Shown on the card and in a toast; **Download all** runs
  sequentially (one EPUB in memory, last entry first so the newest-first shelf ends in catalog
  order) with one summary toast.
- The first download calls `requestPersistence()` (also called at startup).

## 5. PWA — `vite.config.ts`, `index.html`, `src/main.ts`

### VitePWA / Workbox
| Option | Value |
|---|---|
| `registerType` | `'prompt'`: an update waits for the user (no `skipWaiting` mid-read) |
| `includeManifestIcons` | `false` (the OS fetches manifest icons at install) |
| `manifest` | "Tsuzuri — Japanese Reader" / "Tsuzuri", `standalone`, `orientation: 'any'`, colours `#f6f3ec`, `start_url`/`scope` = `base`; `icon-192`, `icon-512`, `maskable-512` |
| `clientsClaim` | `true`, so the first-visit page is controlled and the IPADIC fetched in that session is runtime-cached |
| `globPatterns` | `**/*.{js,css,html}`, `favicon.svg`, `icons/apple-touch-icon-180.png`, `books/catalog.json`, `books/*.webp` (the shelf lists bundled books offline; EPUBs and splash screens are not precached) |
| `globIgnores` | `**/kuromoji/**`, `assets/foliate-{mobi,fb2,comic-book,tts,search}-*.js` (prefix set by `chunkFileNames`) |
| `maximumFileSizeToCacheInBytes` | 6 MiB |
| `navigateFallback` | `` `${base}index.html` `` |
| `cleanupOutdatedCaches` | `true` (precaches only) |
| `runtimeCaching` | `/\/books\/[^/]+\.epub$/` → `NetworkOnly` (bytes go to OPFS; a Cache API copy would double storage). `/\/kuromoji\/dict\/.*\.dat\.gz$/` → `CacheFirst`, `kuromoji-ipadic-v2` (= `IPADIC_CACHE`), `statuses: [0, 200]`, **no `expiration`** (a partial shard set builds no trie) |
| `devOptions` | `{ enabled: true, type: 'module' }`: the SW also runs under `vite dev` |

`main.ts` deletes the superseded `kuromoji-ipadic` cache (`cleanupOutdatedCaches` doesn't touch
runtime caches) and, 4 s after launch when online with the dictionary installed, calls
`cacheIpadic()` to re-fill missing shards.

### Registration & updates
`onNeedRefresh` sets `pwa.needRefresh` and `pwa.update = () => { rememberRouteForReload();
updateSW(true) }`; `onOfflineReady` sets `pwa.offlineReady`. `onRegisteredSW` calls
`registration.update()` on `visibilitychange → visible` while online, at most hourly: an
installed PWA is resumed far more often than navigated. `ToastHost` shows "A new version is
ready." + **Refresh**, or "Ready to read offline." (4 s). The reload restores the route from
sessionStorage `tsuzuri:route`.

### `index.html`
- `viewport`: `width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no,
  viewport-fit=cover`.
- `apple-mobile-web-app-capable`, `mobile-web-app-capable`,
  `apple-mobile-web-app-status-bar-style: black-translucent` (content runs under the status
  bar; `viewport.ts` depends on it), `apple-mobile-web-app-title`, `apple-touch-icon` (180px).
- **Splash screens:** 80 `apple-touch-startup-image` links (9 iPad sizes @2× and 11 iPhone
  sizes @2×/@3×, iPhone 11 / SE 2 and later, × 2 orientations × light/dark) between
  `splash:start` / `splash:end`, generated with the PNGs in `public/splash/` by
  `scripts/gen-icons.mjs`. Edit its `DEVICES` / `PAPER` lists, not the HTML. iOS uses an
  image only on an exact media match.
- **One `theme-color` meta** (no `media` variants), set before first paint by the inline
  script and kept at the live `--paper` by `applyTheme()`. Keep the inline script's key and
  colours in sync with `settings.svelte.ts` / `app.css`.

`node scripts/gen-icons.mjs` (sharp, local only) also writes `public/icons/`: `icon-192`,
`icon-512`, `apple-touch-icon-180`, and `maskable-512` (artwork within the 80% safe zone).

## 6. iOS viewport — `src/services/viewport.ts`

**Problem.** On a cold Home Screen launch, iPhone lays out as if the window were shorter by the
status-bar inset (852 → 793 px on a 393×852 phone). `100dvh`, `innerHeight` and
`visualViewport.height` all report the short value until a rotation, and WebKit paints nothing
below the document's box, so a screen-tall fixed overlay is still clipped.

**Fix.** `fullScreenHeight(width)` returns the screen height when standalone
(`navigator.standalone` or `display-mode: standalone`) and the window width equals a screen
side ±2px (excludes Split View, Slide Over, Stage Manager). iOS doesn't swap
`screen.width/height` on rotation, so orientation comes from the width. Relies on
`black-translucent` + `viewport-fit=cover`. `initViewport()` publishes:

- `--doc-height` → `html`, `body`, `#app` (fallback `100dvh`); unset when not full-screen
  standalone.
- `--app-height` → `viewportSize().h` (visual viewport, lifted to the screen height) → the
  fixed `.reader`, `LoadingScreen` and the reader-chunk error screen.

Both depend only on screen size and window width, so they can't feed back into layout. Writes
are rAF-coalesced, gated at 2px, and re-asserted at `load` and 300 ms later. A `scroll`
listener pins the overflow-hidden root at 0 (focus and anchors can still scroll it).
`viewportSize()` falls back to the layout viewport while pinch-zoomed; the reader geometry
([reader-engine.md §5a](./reader-engine.md)) and `anchoredPosition.ts` use it.

## 7. iOS constraints

| Capability | iOS | Handling |
|---|---|---|
| OPFS with `createWritable` | available | Primary byte store; IndexedDB fallback (§3). |
| 7-day script-storage eviction | installed PWAs exempt | `requestPersistence()` as a backstop. If a Safari-tab origin is evicted, a `books` row can outlive its bytes; opening shows "please re-import", and re-importing restores them. |
| `showOpenFilePicker` | unavailable | Hidden `<input type="file" accept=".epub,application/epub+zip" multiple>` in `Shelf.svelte`; bundled books download in-app. |
| Web Share Target / file handlers | unavailable | None in the manifest. |
| Storage quota | `estimate()` is coarse | `storageStatus()` + `formatBytes` (`persist.ts`) → "Storage: X used of Y · persistent" in ShelfSettings → About. |

## 8. Gotchas

- The `settings` store has no keyPath; always pass the key `'reader'`.
- Dedupe is by content: identical bytes under another file name collapse to one entry.
- Keep both OPFS safety nets (`putBook`'s fallback and `getBookFile`'s fall-through).
- Never hard-code a root-relative URL in app code
  ([deployment.md §2](./deployment.md#2-the-epub-base-path)).
