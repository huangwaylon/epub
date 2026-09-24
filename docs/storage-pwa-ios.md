# Storage, Data Model, PWA & iOS Constraints

How Tsuzuri persists data, ships as an installable PWA, and works around iOS. Deployment
and the `/epub/` base are in [deployment.md](./deployment.md). The JMdict database and the
IPADIC download/warm flow are in [japanese.md](./japanese.md).

- **Structured data** → IndexedDB `tsuzuri` via `idb` (`src/services/storage/db.ts`).
- **EPUB bytes** → OPFS, with an IndexedDB fallback (`src/services/storage/blobs.ts`).
- **JMdict** → jpdict-idb's own IndexedDB. **kuromoji dict** → Cache API (service worker).

Progress and annotations are CFI-anchored ([reader-engine.md §9](./reader-engine.md)).

## 1. Data model — `src/services/types.ts`

| Type | Fields |
|---|---|
| `BookMeta` (`books`) | `id` (SHA-256 hex of the bytes; also the OPFS file stem and dedupe key), `title` (falls back to the file name), `author` (multiple joined with `、`), `language`, `dir: 'ltr' \| 'rtl'` (page progression), `cover?: Blob` (≤320px-wide WebP thumbnail), `fileName`, `fileSize`, `addedAt`, `lastOpenedAt` (shelf sort, descending) |
| `ReadingProgress` (`progress`) | `bookId`, `cfi`, `fraction` (0..1, shelf ring), `label?` (TOC section), `updatedAt` |
| `Annotation` (`annotations`) | `id`, `bookId`, `kind: 'highlight' \| 'bookmark'`, `cfi`, `text` (selection, looked-up word, or bookmark snippet), `note?`, `sectionLabel?`, `createdAt` |
| `ReaderSettings` (`settings['reader']`) | see below |

Also exported: `WritingModePref` (`'auto' | 'horizontal' | 'vertical'`), `ResolvedTheme`
(`'light' | 'sepia' | 'dark'`), `ThemeName` (`'auto' | ResolvedTheme`), and
`HIGHLIGHT_HEX = '#ffd54a'` (the only highlight colour; annotations have no colour field).

`DEFAULT_SETTINGS`:

| Field | Default | |
|---|---|---|
| `theme` | `'auto'` | follows `prefers-color-scheme` (light ↔ dark) |
| `fontScale` | `1` | 1 = 100% |
| `lineHeight` | `1.9` | |
| `marginScale` | `1` | multiplies the base page margin |
| `fontFamily` | `'serif'` | or `'sans'` |
| `writingMode` | `'auto'` | override of the EPUB's mode |
| `highlightLookups` | `true` | tap-to-define also highlights the word; lookup itself is always on |

The settings store keeps only keys present in `DEFAULT_SETTINGS` and backfills missing ones
from it, so adding a field needs no migration. Settings UI:
[ui-and-design.md](./ui-and-design.md).

## 2. IndexedDB — `src/services/storage/db.ts`

`openDB('tsuzuri', 1)`. `upgrade` creates everything in an `if (oldVersion < 1)` step; a
new version adds its own `if (oldVersion < N)` step, and the new store must also be added to
the `TsuzuriDB` schema interface.

| Store | Key | Index | Value |
|---|---|---|---|
| `books` | `id` | — | `BookMeta` |
| `progress` | `bookId` | — | `ReadingProgress` |
| `annotations` | `id` | `byBook` → `bookId` | `Annotation` |
| `settings` | out-of-line, always `'reader'` | — | `ReaderSettings` |
| `bookBlobs` | `id` | — | `{ id, blob }` (OPFS fallback) |

**Connection lifecycle.** `db()` memoises the open promise and drops it on `terminated`
(iOS WebKit severs connections after long backgrounding), on `blocking` (it also closes, so
a newer build's upgrade can proceed), and on a failed open. The next call reopens.

**Helpers:** `putBookMeta`, `getBookMeta`, `getAllBooks`, `getProgress`, `getAllProgress`,
`putProgress`, `getAnnotations` (via `byBook`), `putAnnotation`, `deleteAnnotation`,
`loadSettings`, `saveSettings`, `put/get/deleteBlobFallback`, and `deleteBookCascade(id)`.
`deleteBookCascade` deletes `books` + `progress` + the book's annotations (cursor over
`byBook`) in one transaction. It does **not** delete the bytes; `removeBook` deletes those
afterwards.

## 3. EPUB bytes — `src/services/storage/blobs.ts`

Stored as OPFS `books/<id>.epub`.
- `opfsSupported()` checks `navigator.storage.getDirectory` **and**
  `FileSystemFileHandle.prototype.createWritable` (older WebKit had only worker-side sync
  handles). `getBooksDir()` returns `null` if the directory is refused (for example, a
  private-mode `SecurityError`).
- `putBook(id, data)` writes to OPFS. On a failed write it removes the partial file and
  falls back to `bookBlobs`, **except** on `QuotaExceededError`, which is rethrown
  (IndexedDB shares the origin quota).
- `getBookFile(id)` reads OPFS; if the file is missing or empty it falls through to
  `bookBlobs`. The result is re-wrapped as `File('<id>.epub', 'application/epub+zip')` for
  foliate's type sniffing. `null` means the bytes are missing.
- `hasBook(id)` returns `getBookFile(id) !== null`.
- `deleteBook(id)` removes from OPFS **and** `bookBlobs`, both best-effort.

## 4. Library import — `src/services/library.ts`

`importEpub(file)`:
1. `id = sha256Hex(await file.arrayBuffer())`. The buffer isn't bound, so peak heap stays
   near 1× the file size.
2. **Dedupe:** if the meta row exists, restore the bytes if `!hasBook(id)`, bump
   `lastOpenedAt`, and return it. The reader's "please re-import" error relies on this.
3. `Promise.all([putBook(id, file), parseMeta(file)])`. `parseMeta` dynamically imports
   foliate's `makeBook` and never throws; on failure it keeps the file-name title and no
   cover. `flattenLangMap` prefers `ja`, then `ja_JP`, then the first value. The cover is
   downscaled to a 320px-wide WebP via `OffscreenCanvas`; the original is kept if that
   fails or would be larger.
4. `putBookMeta`. If step 3 or 4 throws, `deleteBook(id)` rolls back the bytes so they
   aren't orphaned against quota.

Also: `listBooks` (sorted by `lastOpenedAt` descending), `touchBook`, and `removeBook`
(`deleteBookCascade` then `deleteBook`; always use it, since calling the cascade alone
orphans the bytes). The `library` store surfaces failures in `library.importError`,
because a standalone iOS PWA has no visible console.

## 5. PWA — `vite.config.ts`, `index.html`, `src/main.ts`

### VitePWA / Workbox
| Option | Value |
|---|---|
| `registerType` | `'prompt'`: an update waits for the user (no `skipWaiting` mid-read) |
| `includeManifestIcons` | `false` |
| `manifest` | `name` "Tsuzuri — Japanese Reader", `short_name` "Tsuzuri", `display: 'standalone'`, `orientation: 'any'`, `background_color`/`theme_color` `#f6f3ec`, `start_url`/`scope` = `base`; icons `icon-192`, `icon-512` (`any`), `maskable-512` (`maskable`) |
| `clientsClaim` | `true`, so the first-visit page is controlled and the IPADIC dict fetched in that session gets runtime-cached |
| `globPatterns` | `**/*.{js,css,html}`, `favicon.svg`, `icons/apple-touch-icon-180.png` (app shell only; manifest icons and splash screens are fetched by the OS at install) |
| `globIgnores` | `**/kuromoji/**`, `assets/foliate-{mobi,fb2,comic-book,tts,search}-*.js` (the `foliate-` prefix is set by `build.rolldownOptions.output.chunkFileNames`) |
| `maximumFileSizeToCacheInBytes` | 6 MiB |
| `navigateFallback` | `` `${base}index.html` `` |
| `cleanupOutdatedCaches` | `true` (precaches only) |
| `runtimeCaching` | `/\/kuromoji\/dict\/.*\.dat\.gz$/`, `CacheFirst`, `cacheName: 'kuromoji-ipadic-v2'` (must equal `IPADIC_CACHE` in `jp/ipadic.ts`), `statuses: [0, 200]`, **no `expiration`** (a partial shard set builds no trie) |
| `devOptions` | `{ enabled: true, type: 'module' }`, so the SW also runs under `vite dev` (`server.host: true`) |

`main.ts` deletes the superseded `kuromoji-ipadic` cache, since `cleanupOutdatedCaches`
doesn't touch runtime caches. 4 s after launch (online, dictionary installed) it calls
`cacheIpadic()` to re-fill any missing shards.

### Registration & updates
`registerSW` → `onNeedRefresh` sets `pwa.needRefresh` and
`pwa.update = () => { rememberRouteForReload(); updateSW(true) }`. `onOfflineReady` sets
`pwa.offlineReady`. `onRegisteredSW` calls `registration.update()` on `visibilitychange →
visible` while online, at most hourly, because an installed PWA is resumed far more often
than it's navigated. `ToastHost` shows "A new version is ready." + **Refresh**, or "Ready
to read offline." (auto-dismissed after 4 s). The update reload restores the route from
sessionStorage `tsuzuri:route`; `validateRestoredRoute` falls back to the shelf if the
book was removed.

### `index.html`
- `viewport`: `width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no,
  viewport-fit=cover`. Edge-to-edge; chrome pads with `env(safe-area-inset-*)`.
- `apple-mobile-web-app-capable`, `mobile-web-app-capable`,
  `apple-mobile-web-app-status-bar-style: black-translucent` (content runs under the
  status bar; `viewport.ts` depends on this), `apple-mobile-web-app-title`,
  `apple-touch-icon` (180px).
- **Splash screens:** 36 `apple-touch-startup-image` links (9 iPad sizes × 2 orientations ×
  light/dark), between `splash:start` / `splash:end`, generated with the PNGs in
  `public/splash/` (~320 KB) by `scripts/gen-icons.mjs`. Edit the `IPADS` / `PAPER` lists
  there, not the HTML. iOS uses an image only on an exact media match. Whether iOS honours
  the dark variant is unverified on device.
- **One `theme-color` meta** (no `media` variants). The inline script sets it and
  `data-theme` from the localStorage mirror before first paint, and `applyTheme()` in
  `settings.svelte.ts` keeps it at the live `--paper`. Keep the inline script's key and
  colours in sync with `settings.svelte.ts` / `app.css`.

### Icons
`node scripts/gen-icons.mjs` (sharp, local only) rasterises the inline SVG mark into
`public/icons/`: `icon-192.png`, `icon-512.png`, `apple-touch-icon-180.png`, and
`maskable-512.png` (artwork within the 80% safe zone).

## 6. iOS viewport — `src/services/viewport.ts`

**Problem.** On a cold Home Screen launch, iPhone lays out as if the window were shorter
by the status-bar inset (852 → 793 px on a 393×852 phone). `100dvh`, `innerHeight` and
`visualViewport.height` all report the short value until a rotation, and WebKit paints
nothing below the document's box, so a screen-tall fixed overlay is still clipped.

**Fix.** `fullScreenHeight(width)` returns the screen height when running standalone
(`navigator.standalone` or `display-mode: standalone`) **and** the window width equals a
screen side ±2px, which excludes Split View, Slide Over and Stage Manager. iOS doesn't
swap `screen.width/height` on rotation, so orientation comes from the width. This relies
on `black-translucent` + `viewport-fit=cover`. `initViewport()` publishes:

- `--doc-height` → `html`, `body`, `#app` in `app.css` (fallback `100dvh`); unset when not
  full-screen standalone.
- `--app-height` → `viewportSize().h` (the visual viewport, lifted to the screen height) →
  the fixed `.reader` overlay, `LoadingScreen` and the reader-chunk error screen.

Both depend only on the screen size and the window width, so they can't feed back into
layout. Writes are rAF-coalesced, gated at 2px, and re-asserted at `load` and again 300 ms
later. A `scroll` listener pins the overflow-hidden root at 0.
`viewportSize()` falls back to the layout viewport while pinch-zoomed, and is also used by
the reader geometry and `anchoredPosition.ts`. Tests: `viewport.test.ts`. The reader side
is in [reader-engine.md §5a](./reader-engine.md).

## 7. iOS constraints

| Capability | iOS | What we do |
|---|---|---|
| OPFS with `createWritable` | available | Primary byte store; IndexedDB fallback (§3). |
| 7-day script-storage eviction | installed PWAs are exempt | `requestPersistence()` at startup as a backstop. If a Safari-tab origin is evicted, a `books` row can outlive its bytes; opening it shows "please re-import", and re-importing restores the bytes. |
| `showOpenFilePicker` | unavailable | Hidden `<input type="file" accept=".epub,application/epub+zip" multiple>` in `Shelf.svelte`. |
| Web Share Target / file handlers | unavailable | None in the manifest; import is `<input>`-only. |
| Storage quota | `estimate()` is coarse | `storageStatus()` + `formatBytes` (`persist.ts`) feed a text line in ShelfSettings → About: "Storage: X used of Y · persistent". |

## 8. Gotchas

- The `settings` store has no keyPath; always pass the key `'reader'`.
- Deleting a book takes two steps; use `removeBook`.
- Dedupe is by content: identical bytes under another file name collapse to one entry.
- Keep both OPFS safety nets (`putBook`'s fallback and `getBookFile`'s fall-through).
- The kuromoji runtime cache must never get an `expiration`. Rename it (and update
  `IPADIC_CACHE`) when the dict contents change, and delete the old name in `main.ts`.
- Never hard-code a root-relative URL in app code; see
  [deployment.md §2](./deployment.md#2-the-epub-base-path).
