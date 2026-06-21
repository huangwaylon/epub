# CLAUDE.md — Tsuzuri (綴)

A **paginated EPUB reader for Japanese books**, built as an **installable iOS PWA**
(Add to Home Screen, Safari, iOS 26+, iPhone + iPad — primarily **iPad in
landscape**). Reads on-device EPUBs offline, paginated like Apple Books, with
vertical 縦書き support, integrated **10ten-style tap-to-define**, **highlights**
and **bookmarks**. A horizontal **swipe** turns the page (always horizontal, in
the correct direction for every writing mode); a **tap** defines a tapped
Japanese word or, on blank space, toggles the chrome — there are no tap edge-rails.
Fully client-side; **deployed to GitHub Pages** at https://huangwaylon.github.io/epub/
(see [docs/deployment.md](docs/deployment.md)).

> This file is the orientation map. **Depth lives in [`docs/`](docs/); task
> procedures live in [`.claude/skills/`](.claude/skills/).** Read the relevant
> subsystem doc before changing that subsystem.

## Stack
Svelte 5 (runes) · TypeScript · Vite + `vite-plugin-pwa`. Rendering by
**foliate-js** (vendored, MIT, in `src/vendor/foliate-js`). Japanese dictionary by
the **10ten** ecosystem: `@birchill/jpdict-idb` + `@birchill/normal-jp` (npm) and a
**vendored, GPL-3.0** deinflection engine (`src/services/jp/deinflect.ts`). Word
**segmentation** by **kuromoji** (`@sglkc/kuromoji`, MeCab-style IPADIC; Apache-2.0).
Storage: **OPFS** (EPUB bytes) + **IndexedDB** via `idb` (everything structured).
The app is **backend-free** — the offline dictionary is the only language feature.
Four runtime deps: jpdict-idb, normal-jp, kuromoji, idb.

## Architecture (layers, strict downward deps)
```
UI (src/lib/**, Svelte)  →  stores (src/stores/*.svelte.ts, rune singletons)
                         →  services (src/services/**, framework-agnostic)
                         →  vendored engines (src/vendor/foliate-js)
```
- **Entry:** `src/main.ts` (await `initSettings`, `requestPersistence`, `registerSW`, `mount`) → `src/App.svelte` routes between **Shelf** and **Reader** via the `nav` store.
- **Reader core:** a single `ReaderController` (`src/services/reader.ts`) owns the `<foliate-view>` element; `src/lib/reader/Reader.svelte` wires it to the UI.
- **Full map & data flows:** **[docs/architecture.md](docs/architecture.md)**.

## Where things are
| Area | Code | Doc |
|---|---|---|
| System map, data flows, stores | `src/stores`, `src/main.ts`, `src/App.svelte` | [architecture.md](docs/architecture.md) |
| Reader / foliate / pagination / taps / highlights | `src/services/reader.ts`, `src/lib/reader/*`, `src/vendor/foliate-js` | [reader-engine.md](docs/reader-engine.md) |
| Dictionary, deinflection, lookup, word extraction | `src/services/jp/*` | [japanese.md](docs/japanese.md) |
| Storage, data model, PWA, iOS constraints | `src/services/storage/*`, `src/services/types.ts`, `vite.config.ts`, `index.html` | [storage-pwa-ios.md](docs/storage-pwa-ios.md) |
| Svelte conventions, design tokens, components, responsive/iPad | `src/app.css`, `src/lib/components/*`, `src/stores/settings.svelte.ts` | [ui-and-design.md](docs/ui-and-design.md) |
| Deployment / CI / GitHub Pages / base path | `.github/workflows/deploy.yml`, `vite.config.ts` (`base`) | [deployment.md](docs/deployment.md) |
| Setup, scripts, workflows, verification, worked examples | `package.json`, `scripts/*` | [development.md](docs/development.md) |

## Run & verify
```sh
npm install
npm run dev      # Vite, also exposed on the LAN for on-device testing
npm run check    # svelte-check + tsc   (run after edits)
npm test         # vitest (deinflection unit tests)
npm run build    # production build → dist/
```
- **Test book:** `node scripts/make-test-epub.mjs` → `test-books/tsuki-to-neko.epub` (vertical 縦書き JP EPUB with ruby + conjugated verbs, multi-page).
- **Verify in a browser** with the **chrome-devtools MCP at iPad-landscape (1194×834)**: new page → resize → import the test EPUB (upload to the "Import book" button) → open → download the dictionary in Settings → check vertical RTL pagination, swipe-to-turn (a horizontal swipe turns the page both directions, always animating as a horizontal slide), tap-to-define (tap a Japanese word defines; tap blank centre toggles chrome; any tap dismisses an open popup — no tap edge-rails), drag-select → highlight, bookmark. Console should show only the benign foliate iframe `allow-scripts and allow-same-origin` sandbox warning. Full recipe + on-device (HTTPS tunnel + Add to Home Screen) in [development.md](docs/development.md). The **`/prs`** and **`tsuzuri-verify`** skills also cover this.
- **Base path:** the dev server runs at `/`; the production build uses the `/epub/` base and deploys to GitHub Pages on push to `main` — see [deployment.md](docs/deployment.md).

## Conventions
- **Svelte 5 runes.** Stores are `*.svelte.ts` modules exporting a module-level `$state` object; mutate via exported functions (e.g. `updateSettings`). Components read `store.x` directly.
- **Services are framework-agnostic** — no Svelte imports in `src/services/**`.
- Components own **scoped styles**; theme is **CSS custom properties** on `<html data-theme>` (see `src/app.css`), and the reader re-injects those same vars into the content iframe.
- Put **`lang="ja"`** on Japanese text; give icon-only buttons an `aria-label`; pad with `env(safe-area-inset-*)`.
- Match the surrounding code style. After changes, run `npm run check`.

## Critical gotchas & constraints (read before editing)
- **GPL-3.0:** the vendored `src/services/jp/deinflect.ts` makes the whole app GPL-3.0-or-later (license: `src/services/jp/LICENSE-10ten`). To relicense, reimplement deinflection.
- **kuromoji segmentation (word boundaries):** tap-to-define uses **kuromoji** (`@sglkc/kuromoji`, MeCab/IPADIC) for segmentation, then JMdict for glosses (`src/services/jp/segment.ts` + `lookup.ts`). Its ~19 MB IPADIC dict is **staged into `public/kuromoji/dict/` by `scripts/copy-kuromoji-dict.mjs`** (run via the `predev`/`prebuild` npm scripts; `public/kuromoji/` is gitignored), loaded on first tap, and SW-runtime-cached for offline. kuromoji's stock loader hangs when a server auto-gzips the dict, so a **defensive loader** (`src/services/jp/kuromojiLoader.cjs`) is aliased in (`vite.config.ts` — both `resolve.alias` for build and `optimizeDeps.rolldownOptions` for the dev prebundle). Details: [japanese.md](docs/japanese.md) §4, [deployment.md](docs/deployment.md), [development.md](docs/development.md).
- **Don't edit `src/vendor/foliate-js/**`** except as a deliberate, documented patch. There are **two** documented patches: (1) `view.js` removed `pdf.js` and the PDF branch (`isPDF` remains as harmless dead code); (2) `paginator.js` disables foliate's **own touch page-turn** so we can drive pagination with our own horizontal swipe detector (`#attachTaps` in `reader.ts`) — `#onTouchMove` keeps `e.preventDefault()` (blocks native scroll / Safari edge back-swipe) but drops `scrollBy`, and `#onTouchEnd` drops the velocity `snap()` (search paginator.js for `TSUZURI PATCH`). We leave foliate's `animated` attribute **off** and animate page turns ourselves as a horizontal **slide** (foliate's own turn slides vertically for 縦書き); see [reader-engine.md §8a](docs/reader-engine.md). Content renders in a **closed-shadow-DOM iframe**; reach it only via foliate's `load` event `doc`.
- **Vertical (縦書き) column-fill quirk:** foliate could under-measure vertical column height on first paint at some viewport sizes (dead space at page bottom). Addressed by deriving the vertical page-box caps from the live viewport in `applyLayout` (`reader.ts`), so the box fills on first paint (verified in desktop Chrome at 1194×834); a single 250ms `#nudgeLayout()` re-render + a resize listener remain as hedges. **Not yet confirmed solved on real iOS** — see [reader-engine.md §11](docs/reader-engine.md).
- **iOS specifics:** EPUB import is `<input type="file">`-only (no Share Target / file handlers); OPFS used for blobs (IndexedDB fallback); installed PWAs are exempt from the 7-day storage eviction. Details in [storage-pwa-ios.md](docs/storage-pwa-ios.md).
- **On-device iOS verification is still pending** for the items above plus `caretRangeFromPoint` in vertical iframes and Add-to-Home-Screen durability. The **swipe-to-turn gesture model** (horizontal swipe turns the page in both directions for every writing mode; tap defines or toggles chrome; no edge-rails) — including swipe responsiveness/velocity on iOS touch — and the **viewport-derived vertical layout fill** are likewise verified in desktop Chrome only, pending on-device confirmation. The app has so far been verified only in desktop Chrome via the chrome-devtools MCP.

## Skills (task procedures, in `.claude/skills/`)
- **tsuzuri-reader** — changing the reader / foliate integration (pagination, vertical text, taps, selection, highlights/CFI, reading margins).
- **tsuzuri-japanese** — the dictionary / deinflection / lookup / word-extraction pipeline.
- **tsuzuri-verify** — run and visually verify the app (test EPUB + chrome-devtools at iPad-landscape; on-device).
