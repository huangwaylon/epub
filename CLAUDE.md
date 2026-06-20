# CLAUDE.md — Tsuzuri (綴)

A **paginated EPUB reader for Japanese books**, built as an **installable iOS PWA**
(Add to Home Screen, Safari, iOS 26+, iPhone + iPad — primarily **iPad in
landscape**). Reads on-device EPUBs offline, paginated like Apple Books, with
vertical 縦書き support, integrated **10ten-style tap-to-define**, sentence
**translation**, **highlights** and **bookmarks**.

> This file is the orientation map. **Depth lives in [`docs/`](docs/); task
> procedures live in [`.claude/skills/`](.claude/skills/).** Read the relevant
> subsystem doc before changing that subsystem.

## Stack
Svelte 5 (runes) · TypeScript · Vite + `vite-plugin-pwa`. Rendering by
**foliate-js** (vendored, MIT, in `src/vendor/foliate-js`). Japanese dictionary by
the **10ten** ecosystem: `@birchill/jpdict-idb` + `@birchill/normal-jp` (npm) and a
**vendored, GPL-3.0** deinflection engine (`src/services/jp/deinflect.ts`).
Storage: **OPFS** (EPUB bytes) + **IndexedDB** via `idb` (everything structured).
Translation: same-origin `/api/translate` proxy (dev middleware → Google; prod →
DeepL Cloudflare Worker in `proxy/`). Only three runtime deps: jpdict-idb,
normal-jp, idb.

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
| Sentence translation client + proxy | `src/services/translate.ts`, `vite-plugins/dev-translate.ts`, `proxy/` | [translation.md](docs/translation.md) |
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
- **Verify in a browser** with the **chrome-devtools MCP at iPad-landscape (1194×834)**: new page → resize → import the test EPUB (upload to the "Import book" button) → open → download the dictionary in Settings → check vertical RTL pagination, tap-to-define (tap a Japanese word defines; tap blank centre toggles chrome; tap a left/right edge rail or swipe turns the page; any tap dismisses an open popup), drag-select → highlight/translate, bookmark. Console should show only the benign foliate iframe `allow-scripts and allow-same-origin` sandbox warning. Full recipe + on-device (HTTPS tunnel + Add to Home Screen) in [development.md](docs/development.md). The **`/prs`** and **`tsuzuri-verify`** skills also cover this.

## Conventions
- **Svelte 5 runes.** Stores are `*.svelte.ts` modules exporting a module-level `$state` object; mutate via exported functions (e.g. `updateSettings`). Components read `store.x` directly.
- **Services are framework-agnostic** — no Svelte imports in `src/services/**`.
- Components own **scoped styles**; theme is **CSS custom properties** on `<html data-theme>` (see `src/app.css`), and the reader re-injects those same vars into the content iframe.
- Put **`lang="ja"`** on Japanese text; give icon-only buttons an `aria-label`; pad with `env(safe-area-inset-*)`.
- Match the surrounding code style. After changes, run `npm run check`.

## Critical gotchas & constraints (read before editing)
- **GPL-3.0:** the vendored `src/services/jp/deinflect.ts` makes the whole app GPL-3.0-or-later (license: `src/services/jp/LICENSE-10ten`). To relicense, reimplement deinflection.
- **Don't edit `src/vendor/foliate-js/**`** except as a deliberate, documented patch. The only existing patch removed `pdf.js` and the PDF branch in `view.js` (`isPDF` remains as harmless dead code). foliate handles its **own swipe gestures** — don't add page-swipe handling. We do leave foliate's `animated` attribute **off** and animate page turns ourselves as a horizontal **slide** (foliate's own turn slides vertically for 縦書き); see [reader-engine.md §8a](docs/reader-engine.md). Content renders in a **closed-shadow-DOM iframe**; reach it only via foliate's `load` event `doc`.
- **Vertical (縦書き) column-fill quirk:** foliate could under-measure vertical column height on first paint at some viewport sizes (dead space at page bottom). Addressed by deriving the vertical page-box caps from the live viewport in `applyLayout` (`reader.ts`), so the box fills on first paint (verified in desktop Chrome at 1194×834); a single 250ms `#nudgeLayout()` re-render + a resize listener remain as hedges. **Not yet confirmed solved on real iOS** — see [reader-engine.md §11](docs/reader-engine.md).
- **Translation needs a deployed proxy** in production (`proxy/`, DeepL key); the dev middleware only runs under `vite dev`. The dictionary works fully offline regardless.
- **iOS specifics:** EPUB import is `<input type="file">`-only (no Share Target / file handlers); OPFS used for blobs (IndexedDB fallback); installed PWAs are exempt from the 7-day storage eviction. Details in [storage-pwa-ios.md](docs/storage-pwa-ios.md).
- **On-device iOS verification is still pending** for the items above plus `caretRangeFromPoint` in vertical iframes and Add-to-Home-Screen durability. The new **tap-gesture model** ("tap defines; edge + swipe turn") and the **viewport-derived vertical layout fill** are likewise verified in desktop Chrome only, pending on-device confirmation. The app has so far been verified only in desktop Chrome via the chrome-devtools MCP.

## Skills (task procedures, in `.claude/skills/`)
- **tsuzuri-reader** — changing the reader / foliate integration (pagination, vertical text, taps, selection, highlights/CFI, reading margins).
- **tsuzuri-japanese** — the dictionary / deinflection / lookup / word-extraction pipeline.
- **tsuzuri-verify** — run and visually verify the app (test EPUB + chrome-devtools at iPad-landscape; on-device).
