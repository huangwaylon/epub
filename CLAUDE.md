# CLAUDE.md — Tsuzuri (綴)

A **paginated EPUB reader for Japanese books**, built as an **installable iOS PWA**
(Safari → Add to Home Screen, iOS 26+, iPhone + iPad, primarily **iPad landscape**).
Offline, paginated like Apple Books, vertical 縦書き support, **10ten-style
tap-to-define**, highlights and bookmarks. Fully client-side; deployed to GitHub Pages at
https://huangwaylon.github.io/epub/ ([docs/deployment.md](docs/deployment.md)).

> This file is the orientation map. Depth lives in [`docs/`](docs/); task procedures live
> in [`.claude/skills/`](.claude/skills/). Read the subsystem doc before changing it.

## Interaction model (the product contract)
- **Swipe** (horizontal) turns the page — always horizontal, direction-correct for every
  writing mode. Animated as a short push: the page drifts ~36px with the finger and
  cross-fades; the next page arrives from the side the finger came from. First/last page
  bounces. ←/→ and Space/Shift-Space also turn; Esc closes the card/chrome.
- **Tap on a Japanese word** defines it and highlights it yellow (a vocab record; toggle
  "Highlight looked-up words" in Display). Works inside the top/bottom nav-bar band.
- **While a definition card is open, any tap only dismisses it** — even on another word.
- **Blank tap** in the top/bottom edge band toggles the bars; elsewhere it hides visible
  bars; a blank-centre tap with nothing open does nothing. A tap never turns the page.
- Tapping a highlight reopens its definition (without furigana) with **Remove highlight**.
- Bottom progress bar is **drag-to-scrub** (previews the target chapter).
- Highlights are always yellow. **Highlights & Bookmarks** panel groups by chapter;
  deleting a book/highlight/bookmark is undoable from a toast. On iPad, **Display**
  settings open as a glass popover under the Aa button.

## Stack
Svelte 5 (runes) · TypeScript · Vite + `vite-plugin-pwa`. Rendering: **foliate-js**
(vendored, MIT, `src/vendor/foliate-js`). Dictionary: **10ten** ecosystem —
`@birchill/jpdict-idb` + `@birchill/normal-jp` + a **vendored GPL-3.0** deinflector
(`src/services/jp/deinflect.ts`). Segmentation: **kuromoji** (`@sglkc/kuromoji`, IPADIC).
Storage: **OPFS** (EPUB bytes, IndexedDB fallback) + **IndexedDB** via `idb`.
Runtime deps: jpdict-idb, normal-jp, kuromoji, idb. Backend-free.

## Architecture (strict downward deps)
```
UI (src/lib/**, Svelte) → stores (src/stores/*.svelte.ts) → services (src/services/**,
framework-agnostic) → vendored engines (src/vendor/foliate-js)
```
- **Entry:** `src/main.ts` mounts immediately (no IndexedDB await). An inline script in
  `index.html` sets `data-theme` from a localStorage mirror (`tsuzuri:settings`) before
  first paint; `initSettings` then hydrates from IDB (source of truth). Theme defaults to
  `'auto'` (`appearance.resolved` = light/sepia/dark). SW update check on foreground (≤ hourly).
- **Routing:** `App.svelte` switches Shelf ↔ Reader via the `nav` store. The route is saved
  to sessionStorage only right before a deliberate reload (SW update, "Try again").
- **Lazy loading:** the Shelf never loads foliate (`library.ts` imports `view.js` on
  demand). The Reader chunk loads via retryable `loadReader()` (warmed after mount and on
  cover press) and prefetches foliate's zip/epub/paginator chunks at mount.
- **Reader core:** one `ReaderController` (`src/services/reader.ts`) owns `<foliate-view>`;
  `src/lib/reader/Reader.svelte` wires it to the UI. Full map: [architecture.md](docs/architecture.md).

## Where things are
| Area | Code | Doc |
|---|---|---|
| System map, data flows, stores | `src/stores`, `src/main.ts`, `src/App.svelte` | [architecture.md](docs/architecture.md) |
| Reader / foliate / pagination / taps / highlights | `src/services/reader.ts`, `src/lib/reader/*`, `src/vendor/foliate-js` | [reader-engine.md](docs/reader-engine.md) |
| Dictionary, deinflection, lookup, word extraction | `src/services/jp/*` | [japanese.md](docs/japanese.md) |
| Storage, data model, PWA, iOS viewport | `src/services/storage/*`, `src/services/viewport.ts`, `vite.config.ts`, `index.html` | [storage-pwa-ios.md](docs/storage-pwa-ios.md) |
| Design tokens, components, responsive/iPad | `src/app.css`, `src/lib/components/*` | [ui-and-design.md](docs/ui-and-design.md) |
| Deployment / CI / base path | `.github/workflows/deploy.yml`, `vite.config.ts` | [deployment.md](docs/deployment.md) |
| Setup, scripts, verification recipes | `package.json`, `scripts/*` | [development.md](docs/development.md) |

## Run & verify
```sh
npm install
npm run dev      # Vite, exposed on the LAN for on-device testing
npm run check    # svelte-check + tsc (run after edits)
npm test         # vitest
npm run build    # production build → dist/ (base /epub/)
```
- **Test book:** `node scripts/make-test-epub.mjs` → `test-books/tsuki-to-neko.epub`
  (vertical JP, ruby, conjugated verbs, multi-page).
- **Browser check:** chrome-devtools MCP at iPad landscape 1194×834 with touch: import the
  test EPUB → open → download the dictionary (Settings) → verify the interaction model
  above (swipe both ways, tap-define incl. first/last glyph of a column, tap-to-dismiss,
  highlight reopen/remove, drag-select → highlight/copy, scrubber, bookmark). Console should
  show only foliate's benign iframe `allow-scripts and allow-same-origin` warning. The DEV
  `window.__tsuzuri` hook exposes the content doc/controller for scripted taps. Recipes:
  [development.md](docs/development.md), the **tsuzuri-verify** skill.

## Conventions
- Svelte 5 runes. Stores are `*.svelte.ts` modules exporting module-level `$state`; mutate
  via exported functions (e.g. `updateSettings`). No Svelte imports in `src/services/**`.
- Scoped component styles on the tokens in `src/app.css` (spacing, type, radii, glass,
  motion); theme is CSS custom properties on `<html data-theme>`, re-injected into the
  content iframe.
- `lang="ja"` on Japanese text; `aria-label` on icon-only buttons; ≥44pt touch targets;
  pad with `env(safe-area-inset-*)`.
- Match surrounding style; run `npm run check` and `npm test` after changes.

## Critical constraints (read before editing)
- **GPL-3.0:** vendored `deinflect.ts` makes the app GPL-3.0-or-later
  (`src/services/jp/LICENSE-10ten`).
- **Lookup runs in a Web Worker** (`lookup.worker.ts` ↔ `lookupClient.ts`); only DOM work
  (`extractTextAt`/`rangeForSpan`) is on the main thread. Worker: warmed at reader mount,
  re-created on resume if `pingLookup()` fails, shed after 60 s backgrounded, disposed on
  reader exit. A tap waits ≤1.2 s for an in-flight kuromoji build rather than answering
  greedily; `lookupClient` caches only ready-derived results (cleared after a download).
- **kuromoji dict:** 11 trimmed `*.dat.gz` (~11 MB, ≈33 MB resident) staged to
  `public/kuromoji/dict/` by `scripts/copy-kuromoji-dict.mjs` (gitignored; `tid_pos` is
  dropped — boundaries come from the lattice, pinned by `segment.golden.test.ts`).
  `kuromojiLoader.cjs` (aliased in `vite.config.ts`) inflates with `DecompressionStream`
  and uses flat target maps. SW cache `kuromoji-ipadic-v2`, **no expiration** (a partial
  shard set builds no trie); `cacheIpadic()` pre-fills it. Depth: [japanese.md](docs/japanese.md).
- **Lookup ranking:** deinflections must match the entry's word type (10ten
  `entryMatchesType`); common deinflections lead; an uncommon conjugation parse that
  overruns the kuromoji token yields to a shorter common match (したように → する).
- **Tap accuracy is geometry, not the caret.** Caret APIs return a *boundary*; `extract.ts`
  uses them only as a seed and picks the glyph whose measured box contains the point
  (`resolveGlyph`); furigana taps redirect to the ruby base. Never trust the caret offset,
  and never `range.toString()` a word that may carry ruby (決けっ心).
- **Taps are a hot path** — never add latency or a guard that can swallow one.
  `TAP_MAX_MS` 700; non-primary pointers ignored; `shouldIgnoreUp` bails only inside the
  live selection; `touch-action: manipulation` on `.reader` and the content body (a stray
  double-tap zoom kills taps and swipes). A touch swipe is decided on move once it crosses
  45px. A highlight `click` on the same gesture stands down (`tapDefinedAt`/`tapDismissedAt`).
- **Vendored foliate-js:** edit only as a documented `TSUZURI PATCH`. Current patches:
  (1) `view.js` PDF branch removed (unmarked); (2) `paginator.js` own touch page-turn disabled (our
  swipe drives turns); (3) `#turnPage` resolves immediately, holding its lock 100 ms on a
  timer only after a section crossing; (4) `View#render` skips a document-less iframe.
  `animated` stays **off**; we animate turns ourselves. Content is in a **closed-shadow
  iframe** — reach it only via foliate's `load` event `doc` (or DEV `window.__tsuzuri`).
- **Vertical layout:** `applyLayout` derives vertical caps from the live viewport and is
  idempotent; `#expectVertical()` pre-sets writing mode before `view.init`. Books that
  mark 縦書き only via calibre's `class="vrtl"` get `html{writing-mode:vertical-rl}`
  prepended (`#applyIntendedWritingMode`) — only that explicit marker counts.
- **iOS viewport:** a cold Home Screen launch reports a layout viewport short by the
  status-bar inset (852 → 793 on iPhone) until a rotation, and WebKit paints nothing below
  the document box. `viewport.ts` publishes the **screen** height when standalone at full
  screen width as `--doc-height` (html/body/#app) and `--app-height` (fixed `.reader` + loading screens);
  both depend only on screen size + window width, so they can't feed back into layout.
  Relies on `black-translucent` + `viewport-fit=cover` in `index.html`.
- **Highlight volume is a perf constraint:** `#drawSections` paints 24 per task in
  `nearestFirst` order (`src/services/cfi.ts`), seeded before `open()`, generation-guarded.
  The `annotations` store is an immutable `$state.raw` array with lookup maps; all
  create/remove goes through `addHighlight`/`removeHighlight` in `Reader.svelte` (paint
  first, persist in background, dedupe on CFI). Per-document listeners use `#docACs`.
- **iOS storage/import:** EPUB import is `<input type="file">` only; OPFS with IndexedDB
  fallback; installed PWAs are exempt from 7-day eviction.

## On-device status
Verified on real iPad (iOS 26.5): import, pagination + 縦書き + furigana, swipe turns,
edge-band chrome, tap-to-define, highlights, bookmarks, position persistence.
**Not yet verified on iOS** (Chrome-only): geometric glyph resolution, the lean kuromoji
worker (`DecompressionStream`, memory), swipe-on-move, the push animation, the cold-launch
viewport fix, dark splash screens, glass/backdrop-filter cost, landscape vertical
column-fill, and Home Screen storage durability.

## Skills (`.claude/skills/`)
- **tsuzuri-reader** — reader / foliate integration (pagination, vertical text, taps,
  selection, highlights/CFI, margins).
- **tsuzuri-japanese** — dictionary / deinflection / lookup / word extraction.
- **tsuzuri-verify** — run and visually verify the app (chrome-devtools; on-device).
