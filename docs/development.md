# Development

Setup, scripts, tests, and how to verify changes in a browser and on a device. Architecture:
[architecture.md](architecture.md); CI and GitHub Pages: [deployment.md](deployment.md).

## 1. Setup

- Node 18+ (CI builds on Node 22), ESM throughout. `npm install`.
- `sharp` is a local-only devDependency for the two generator scripts; CI deletes it before
  installing (see [deployment.md](deployment.md)).

## 2. Scripts (`package.json`)

| Script | Runs | Notes |
| --- | --- | --- |
| `npm run dev` | `predev` → `vite` | Base `/`, service worker enabled (`devOptions`), `server.host: true` (prints a LAN URL). |
| `npm run build` | `prebuild` → `vite build` | Output `dist/`, base `/epub/`, Workbox precache + manifest. |
| `npm run preview` | `vite preview` | Serves `dist/`. |
| `npm test` | `vitest run` | Unit tests (§4). |
| `npm run check` | `svelte-check --tsconfig ./tsconfig.app.json && tsc -p tsconfig.node.json` | App types + build tooling types. Run after every change. There is no separate lint script. |

`predev`/`prebuild` run `scripts/copy-kuromoji-dict.mjs`, which stages the trimmed IPADIC dict
(11 `*.dat.gz`) from `node_modules/@sglkc/kuromoji/dict` into `public/kuromoji/dict/`
(gitignored). Details: [japanese.md](japanese.md).

Generators (dev-only, both use `sharp`):

- `node scripts/make-test-epub.mjs` → `test-books/tsuki-to-neko.epub`: vertical-rl, rtl-spine
  Japanese EPUB3 with ruby, deliberately conjugated verbs/adjectives (食べていました, 美しかった,
  走った, 読みたい, 行こう, 見られた), a repeated chapter so it paginates over several pages, and a
  generated cover.
- `node scripts/gen-icons.mjs` → `public/icons/` (192, 512, maskable-512, apple-touch-180) and the
  light/dark launch images in `public/splash/`, rewriting their `<link>` tags in `index.html`
  between the `splash:start`/`splash:end` markers.

## 3. Tooling notes

- **Two tsconfigs:** `tsconfig.app.json` (app; used by svelte-check; excludes `src/vendor/**`)
  and `tsconfig.node.json` (only `vite.config.ts`; strict unused/fallthrough flags).
  `src/vite-env.d.ts` declares the PWA virtual modules and `__APP_VERSION__` (commit date + short
  SHA, injected by `define`).
- **kuromoji loader shim:** `src/services/jp/kuromojiLoader.cjs` replaces kuromoji's loader and is
  aliased in `vite.config.ts` twice — `resolve.alias` (build) and an `optimizeDeps.rolldownOptions`
  plugin (dev prebundle). Re-check both after bumping Vite or kuromoji; a miss shows as a
  dictionary popup stuck loading.
- **Workers** are ES modules (`worker.format: 'es'`); the lookup pipeline runs in
  `lookup.worker.ts`.
- `src/services/jp/deinflect.ts` uses plain `enum` (not `const enum`) so it survives per-file
  transpilation. Keep it that way.
- `svelte.config.js` is empty (defaults).
- `src/vendor/foliate-js/**` is not edited except for the documented `TSUZURI PATCH`es (list in
  [reader-engine.md](reader-engine.md) §1). A new patch must be minimal, marked, and documented
  there.

## 4. Tests

Vitest with a plugin-free `vitest.config.ts`: `environment: 'node'`,
`include: ['src/**/*.test.ts']`. No jsdom and no browser mode; IndexedDB tests use
`fake-indexeddb`, and `extract.test.ts` runs against a hand-built fake `Document` that injects
per-character rects.

| File | Covers |
| --- | --- |
| `src/lib/util/anchoredPosition.test.ts` | `placeAnchored`, `placeNearWord` |
| `src/lib/util/chromeBand.test.ts` | `inChromeToggleBand` |
| `src/lib/util/debounce.test.ts` | `debounce` |
| `src/services/cfi.test.ts` | `nearestFirst`, `cfiWithinPage` |
| `src/services/library.test.ts` | `flattenLangMap`, `importEpub` |
| `src/services/viewport.test.ts` | `viewportSize` cold-launch lift, `initViewport` height publishing |
| `src/services/storage/{blobs,db,persist}.test.ts` | OPFS + IndexedDB fallback, schema/indexes, `formatBytes`/`requestPersistence`/`storageStatus` |
| `src/services/jp/deinflect.test.ts` | vendored deinflection |
| `src/services/jp/dictdb.test.ts` | dictionary download, `cacheIpadic`, download + prepare flows |
| `src/services/jp/extract.test.ts` | glyph resolution, ruby → base, `rangeForSpan` |
| `src/services/jp/lookup.test.ts` | lookup pipeline, segmenter readiness, fan-out bounds |
| `src/services/jp/lookup.worker.test.ts` | worker message protocol |
| `src/services/jp/lookupClient.test.ts` | worker client, main-thread cache, `pingLookup` |
| `src/services/jp/segment.test.ts` | segmenter gating, `tokenSpanAt` |
| `src/services/jp/segment.golden.test.ts` | lean kuromoji boundaries vs stock `tokenize()` |

Put new tests next to the module as `*.test.ts`. Anything that needs the real browser, OPFS or
`<foliate-view>` is verified in the browser (§5) instead.

## 5. Browser verification (chrome-devtools MCP)

1. `npm run dev`; generate the test book if `test-books/` is empty.
2. `new_page` → `resize_page` **1194×834** (iPad landscape) → navigate to the dev URL.
3. `upload_file` on the **Import book** button; open the book. Download the dictionary from
   Settings (shelf) or from the popup.
4. Check:
   - Vertical RTL pagination; a horizontal swipe turns the page (in rtl books dragging right
     advances) with a short horizontal push; a swipe at the first/last page bounces.
   - Tap a glyph → definition card, and the word is highlighted yellow; this includes the
     first/last glyph of a column (under the nav-bar band). With the card open, any tap (even on
     another word) only dismisses it. A blank tap in the top/bottom band toggles the bars;
     elsewhere it hides visible bars; a blank-centre tap with nothing open does nothing.
   - Tap a highlighted word → its definition with **Remove highlight**, shown without furigana.
   - Drag-select → toolbar → Highlight / Copy. Drag the bottom progress bar to scrub. Toggle a
     bookmark; it appears in Highlights & Bookmarks.
5. `list_console_messages`: only the foliate iframe `allow-scripts and allow-same-origin`
   sandbox warning is expected.

### DEV hook `window.__tsuzuri`

foliate renders into a closed shadow root, so `Reader.svelte` installs, in DEV builds only:

```ts
window.__tsuzuri = { doc, controller, dictState, extractTextAt, lookupAt }
```

`doc` is the most recently loaded content document, `controller` the `ReaderController`,
`dictState` the popup state, `extractTextAt(doc, x, y)` the DOM extractor and `lookupAt(text, tapOffset)`
the worker lookup. It is removed on reader destroy and tree-shaken from production.

Tap-accuracy sweeps: drive an isolated Chrome (`puppeteer-core`, own `--user-data-dir`), poll
until `__tsuzuri.doc` is set, and dispatch `PointerEvent`s (`isPrimary: true`) on the content
document at iframe-local coordinates (screen minus `frameElement.getBoundingClientRect()`);
host-margin gestures go on the `<foliate-view>` element. Compare `ex.text[ex.tapOffset]` against
the glyph under the point; a probe on furigana is expected to resolve the ruby base, and `null`
means a dead tap.

## 6. Adding a reader setting

1. Add the field and default to `ReaderSettings` / `DEFAULT_SETTINGS` in `src/services/types.ts`.
2. Add a control in `src/lib/reader/ReaderSettings.svelte` that calls `updateSettings({...})`, then
   `onchange('appearance' | 'layout' | 'writingmode')`; the reader maps these to
   `applyAppearance`, `applyLayout` and a writing-mode re-open.
3. Read it in `services/reader.ts` (`appearanceCSS` or `applyLayout`). Persistence is automatic.

## 7. On-device (iPhone / iPad)

- **LAN:** `npm run dev` prints a LAN URL. Plain HTTP is enough for layout and gesture checks in
  Safari, but iOS only registers service workers and installs PWAs over HTTPS.
- **HTTPS:** put a tunnel (`cloudflared tunnel`, `ngrok`) in front of `npm run dev`, or
  `npm run build && npm run preview` behind one (the build uses the `/epub/` base, so open
  `/epub/`). Or test the deployed site.
- Safari → Share → **Add to Home Screen**, launch from the icon, import an EPUB, download the
  dictionary, read. Re-check the items CLAUDE.md lists as unconfirmed on iOS.
