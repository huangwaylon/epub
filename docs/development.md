# Development guide

Contributor / agent workflow guide for **Tsuzuri** (綴). Stack and feature overview
live in [`README.md`](../README.md) and [`CLAUDE.md`](../CLAUDE.md); this doc covers
setup, scripts, tooling config, layout, the run/verify loop, and conventions.
For subsystem depth, see [Where to look](#where-to-look).

---

## 1. Prerequisites & setup

- **Node 18+** (built/tested on v25; `@types/node` pinned `^24`; ESM throughout).
  **CI builds on Node 22** — see [`deployment.md`](./deployment.md).
- **Install:** `npm install`
- **Dev server binds the LAN.** `vite.config.ts` sets `server.host: true`, so
  `npm run dev` prints a `localhost` and a LAN URL (e.g. `http://192.168.x.x:5173`).
  Point an iPhone/iPad at the LAN URL for on-device testing ([§6](#6-running--verifying)).

> `sharp` is a **local-only devDependency** used only by the dev scripts ([§5](#5-test-assets--generators)).
> CI strips it before installing (its native `@img/*` packages crash npm in CI) —
> see [`deployment.md`](./deployment.md).

---

## 2. Scripts

All scripts are in `package.json`. There is **no lint script**; type/lint enforcement
is `npm run check` (svelte-check + strict `tsc` on the node config).

| Script            | Command                                                                       | Purpose |
|-------------------|-------------------------------------------------------------------------------|---------|
| `npm run dev`     | `vite` (after `predev`)                                                        | HMR dev server, SW enabled (`devOptions.enabled`), exposed on LAN, base `/`. |
| `npm run build`   | `vite build` (after `prebuild`)                                               | Production build → `dist/`, base `/epub/`. Generates PWA manifest, Workbox precaches the app shell. |
| `npm run preview` | `vite preview`                                                                 | Serves built `dist/` locally; front with HTTPS tunnel for production-like device tests. |
| `npm test`        | `vitest run`                                                                   | Unit tests once (Node env). Currently the deinflection tests ([§9](#9-testing)). |
| `npm run check`   | `svelte-check --tsconfig ./tsconfig.app.json && tsc -p tsconfig.node.json`     | Type-checks the app **and** the build tooling (`vite.config.ts`). Run before committing. |

> **`predev` / `prebuild`** run `node scripts/copy-kuromoji-dict.mjs`, staging the
> ~19 MB kuromoji IPADIC dict from `node_modules/@sglkc/kuromoji/dict` into
> `public/kuromoji/dict/` (gitignored — regenerated, never committed). Vite serves it
> in dev and copies it into `dist/` on build, so CI ships the dict without committing
> it. See [`japanese.md`](./japanese.md) §4 and [`deployment.md`](./deployment.md).

---

## 3. Tooling & config

### kuromoji dictionary-loader shim

kuromoji's stock browser loader fetches the gzipped dict and `gunzipSync`s it, but
**hangs silently** if the server returns it already-decompressed (Vite's dev/preview
server sets `Content-Encoding: gzip`, so the browser auto-inflates).
`src/services/jp/kuromojiLoader.cjs` is a defensive replacement (gunzip only when the
bytes are actually gzip). It is aliased over kuromoji's loader in `vite.config.ts` in
**two** places, because Vite 8 (Rolldown) resolves the dev prebundle and the build
separately:

- `resolve.alias` — production build
- `optimizeDeps.rolldownOptions` plugin — dev prebundle

If you bump Vite or kuromoji, re-verify both paths use the shim. Symptom of failure:
the dictionary popup stuck on its spinner, console showing repeated `Uncaught (in promise)`.

### TypeScript: a two-project split

`tsconfig.json` is a thin solution file referencing two configs:

- **`tsconfig.app.json`** (svelte-check uses this) — the app. Extends `@tsconfig/svelte`;
  `target es2023`, `module esnext`, `noEmit`, `types: ["svelte", "vite/client"]`.
  Sets `allowJs: true` / `checkJs: false`, and `exclude: ["src/vendor/**"]` so the
  untyped vendored foliate-js is never type-checked.
- **`tsconfig.node.json`** (the `tsc` half of `check`) — the build tooling, `include`
  is only `vite.config.ts`. `moduleResolution: "bundler"`, `verbatimModuleSyntax`,
  `erasableSyntaxOnly`, plus lint flags (`noUnusedLocals`, `noUnusedParameters`,
  `noFallthroughCasesInSwitch`).

`src/vite-env.d.ts` references the Vite client and **both** vite-plugin-pwa type sets
(`vite-plugin-pwa/svelte` and `vite-plugin-pwa/client`) so `virtual:pwa-register/*`
type-checks, and declares the `__APP_VERSION__` global (commit date + short SHA,
injected via `define` in `vite.config.ts`).

### Vite / Svelte

- `svelte.config.js` is intentionally empty (`export default {}`) — default Svelte 5 setup.
- `vite.config.ts` wires `svelte()` + `VitePWA(...)`, sets `server.host: true` and
  `worker.format: 'es'` (ES-module workers — the lookup pipeline runs in a worker).
- **Build-only base `/epub/`** (dev stays `/`) for the GitHub Pages project site; the
  PWA `start_url`/`scope`/`navigateFallback` derive from it. See [`deployment.md`](./deployment.md).
- PWA `registerType: 'prompt'` (update via the in-app `UpdateToast.svelte`); standalone
  manifest, icons under `public/icons/`.

### Vendored `enum` (esbuild isolated modules)

A `const enum` can't be inlined across files under esbuild's per-file transpile, so the
`Reason`/`Type` enums in `src/services/jp/deinflect.ts` were changed from `const enum`
to plain `enum` (noted in that file's header). **Keep them plain `enum`** — do not revert.
`erasableSyntaxOnly` is set only on the **node** tsconfig, not the app config, so the
runtime `enum` in app code is fine.

---

## 4. Project layout

The layered map (UI → stores → services → vendor) and per-area code↔doc table live in
[`CLAUDE.md`](../CLAUDE.md). Directory cheat-sheet:

| Path | Contents |
|------|----------|
| `src/main.ts`, `App.svelte`, `app.css` | Bootstrap, shelf↔reader switch, global theme/safe-area tokens. |
| `src/lib/components/` | Reusable UI: Sheet, Segmented, Icon, UpdateToast. |
| `src/lib/library/` | Shelf, BookCover, ShelfSettings. |
| `src/lib/reader/` | Reader + panels: ReaderSettings, DictionaryPopup, SelectionToolbar, TocSheet, AnnotationsPanel. |
| `src/lib/{actions,util}/` | longpress action; anchoredPosition, debounce helpers. |
| `src/services/` | Framework-agnostic (NO Svelte). `types.ts`, `reader.ts` (ReaderController), `library.ts`. |
| `src/services/storage/` | `blobs.ts` (OPFS), `db.ts` (IndexedDB via idb), `persist.ts`. |
| `src/services/jp/` | `deinflect.ts` (vendored GPL), `lookup.ts` + worker, `dictdb.ts`, `extract.ts`, `segment.ts` (kuromoji), `kuromojiLoader.cjs`, LICENSE-10ten. |
| `src/stores/` | Rune stores (`*.svelte.ts`): settings, library, annotations, dict, nav, pwa. |
| `src/vendor/foliate-js/` | Pinned MIT engine — **DO NOT EDIT** (see §7). |
| `scripts/` | Dev-only: make-test-epub, gen-icons, copy-kuromoji-dict (§5). |
| `public/icons/`, `public/kuromoji/dict/` | Generated icons; staged IPADIC dict (gitignored). |
| `test-books/` | Generated test EPUB(s). |

---

## 5. Test assets / generators

Both scripts are **dev-only** (not part of `build`); regenerate outputs only when you
change the generators. Both depend on `sharp` (CI-stripped, [§1](#1-prerequisites--setup)).

- **`node scripts/make-test-epub.mjs`** → `test-books/tsuki-to-neko.epub`: a small
  **vertical-writing (`vertical-rl`)** Japanese **EPUB3** with
  `page-progression-direction="rtl"`, purpose-built to exercise reader + dictionary.
  It has **ruby/furigana** throughout (verify the lookup window skips `<rt>`),
  **deliberately conjugated** verbs/adjectives (食べていました, 美しかった, 走った,
  読みたい, 行こう, 見られた) for the deinflection engine, **chapter 1 flattened ×6**
  so it is reliably multi-page for pagination/RTL testing, and a **generated SVG→PNG
  cover** for cover-extraction. Uses `fflate` (`zipSync`); the `mimetype` entry is
  stored uncompressed and first per EPUB spec.
- **`node scripts/gen-icons.mjs`** → `public/icons/`: rasterizes two inline SVGs (a
  rounded mark and a maskable full-bleed mark) to `icon-192.png`, `icon-512.png`,
  `apple-touch-icon-180.png`, `maskable-512.png` — matching `manifest.icons` /
  `includeAssets` in `vite.config.ts`.

---

## 6. Running & verifying

### Standard local loop (desktop, chrome-devtools MCP)

1. `npm run dev`.
2. Drive with the **chrome-devtools MCP at iPad-landscape** so the two-page spread and
   sheet-as-centered-card engage: `new_page` → `resize_page` to **1194×834** →
   `navigate_page` to the dev URL.
3. **Import** the test EPUB: `upload_file` targeting the **"Import book"** button.
4. **Open** the book; from **Settings**, **download the dictionary** (populates jpdict's
   IndexedDB; lookups need it).
5. **Verify** the core behaviours:
   - **縦書き / RTL pagination** — a horizontal **swipe** turns the page (drag left →
     next, drag right → previous; animates as a horizontal slide). foliate's own touch
     turn is patched out ([§7](#7-coding-conventions)).
   - **Tap-to-define** — tap a Japanese glyph → `DictionaryPopup` (and the word
     highlights yellow as a vocab record). A tap in the top/bottom edge band toggles
     chrome; a blank-centre tap does nothing; while a popup is open any tap (including
     the nav-bar band) just dismisses it **without** toggling chrome. **Tap never turns
     the page.** Tapping a highlighted word reopens its definition with a remove option.
   - **Drag-select** → `SelectionToolbar` → **highlight** (yellow) / copy.
   - **Drag-to-scrub** bottom progress bar; **bookmark** toggle (appears in the
     annotations panel).
6. `list_console_messages` — the **only** expected message is the benign foliate iframe
   sandbox warning (`allow-scripts` + `allow-same-origin`, set in `paginator.js` /
   `fixed-layout.js` for a WebKit event bug). Anything else is a regression.

The `tsuzuri-verify` skill covers this loop in detail.

### On-device (iOS Safari)

iOS requires **HTTPS** for service workers and Add-to-Home-Screen:

1. Serve over HTTPS — a tunnel (`cloudflared tunnel`, `ngrok`) in front of `npm run dev`,
   or `npm run build && npm run preview` behind a tunnel.
2. iOS Safari → Share → **Add to Home Screen** → launch the installed icon (standalone PWA).
3. Import an EPUB, download the dictionary (Settings), read.

> On-device iOS verification is still **pending** — see [§10](#10-known-constraints--gotchas).

> **CI / deployment** (GitHub Pages, the `/epub/` base, the `sharp` strip) is owned by
> [`deployment.md`](./deployment.md) — refer there rather than duplicating it.

---

## 7. Coding conventions

- **Match surrounding style** (2-space indent, no semicolons in `.ts`/config, single
  quotes). No formatter is enforced beyond `npm run check`.
- **Svelte 5 runes everywhere** (`$state`, `$derived`, `$props`, `$bindable`, `$effect`).
  Stores are `*.svelte.ts` modules exporting a module-level `$state` object; mutate
  **through their exported helpers** (e.g. `updateSettings`), not directly, so
  persistence side-effects run. Components read `store.x` directly.
- **Services are framework-agnostic** — nothing under `src/services/` imports Svelte.
  Plain TS, unit-testable in the Node env. Keep it that way.
- **Components own scoped styles** reading theme tokens from `app.css` CSS custom
  properties (`var(--ink)`, `var(--accent)`, …). The reader re-injects matching CSS into
  content docs via `appearanceCSS()` in `reader.ts`. Tokens/components owned by
  [`ui-and-design.md`](./ui-and-design.md).
- **Japanese text gets `lang="ja"`** (and `xml:lang="ja"`).
- **Icon-only buttons get `aria-label`s**; toggles use `role="switch"`/`aria-checked`;
  dialogs/sheets are `role="dialog" aria-modal`.
- **Safe areas** via `env(safe-area-inset-*)` CSS vars (e.g. `--safe-bottom` in `Sheet.svelte`).

### Never edit `src/vendor/foliate-js`

…except as a deliberate, documented patch. There are **two** (full rationale in
[`reader-engine.md`](./reader-engine.md)):

1. **pdf.js removal** — the `else if (await isPDF(...))` branch (and its
   `import('./pdf.js')`) was deleted from `makeBook` in `view.js`; PDFs are no longer
   supported. `globIgnores: ['**/pdfjs/**']` keeps residue out of the precache. The
   `isPDF` helper remains as harmless dead code — leave it.
2. **foliate touch page-turn disabled** — search `paginator.js` for **`TSUZURI PATCH`**:
   `#onTouchMove` keeps `e.preventDefault()` (blocking native scroll / Safari edge
   back-swipe) but drops `scrollBy`, and `#onTouchEnd` drops the velocity-snap turn. We
   drive turns from a horizontal swipe detector in `reader.ts` (`#attachTaps`) so the
   turn stays horizontal for 縦書き books.

If a patch is unavoidable: make the **smallest possible** change, document it both here
(extend this list) and in [`reader-engine.md`](./reader-engine.md), and keep the diff
self-contained so future re-vendoring stays tractable.

---

## 8. Worked example: add a reader setting

1. **Model** — add the field to `ReaderSettings` and a default to `DEFAULT_SETTINGS` in
   `src/services/types.ts`.
2. **Control** — add a control in `src/lib/reader/ReaderSettings.svelte`. Write via
   `updateSettings({ ... })` (from `src/stores/settings.svelte.ts`), then call the
   `onchange(kind)` prop with the right kind:
   - `'appearance'` → theme/font/size/spacing (re-injects styles)
   - `'layout'` → page geometry (margins/columns)
   - `'writingmode'` → 縦/横 (triggers a content re-open)

   The Reader wires `onchange` to `applyAppearance` / `applyLayout` /
   `reopenForWritingMode` on the `ReaderController`.
3. **Consume** — read the field in `reader.ts`: `appearanceCSS(s)` for visuals,
   `applyLayout(s)` for geometry.
4. **Persistence is automatic** — `updateSettings` calls `saveSettings` (IndexedDB) once
   hydrated; the rune store re-renders consumers. No extra plumbing.

To **add a sheet/panel**: create a component under `src/lib/reader/` (or `library/`)
with scoped styles taking data via `$props`, then render it inside
`<Sheet bind:open={...} title="…">` in the relevant screen. `Sheet`
(`src/lib/components/Sheet.svelte`) gives the responsive bottom-sheet-on-phones /
centered-card-on-≥768px behaviour, scrim, drag-grip, Escape-to-close, and safe-area
padding for free.

---

## 9. Testing

- **Runner:** Vitest. `vitest.config.ts` is intentionally **plugin-free** (no Svelte/PWA
  plugins) so tests run fast: `environment: 'node'`, `include: ['src/**/*.test.ts']`.
- **Scope:** unit tests for **pure service logic** — no DOM, no Svelte. The only current
  test is `src/services/jp/deinflect.test.ts`, asserting the vendored deinflection engine
  reduces conjugated surface forms to their dictionary base (ichidan te-form, i-adjective
  past, godan past, -tai, volitional, passive/potential), always includes the original
  surface as a candidate, and tags deinflected candidates with non-empty `reasonChains`.
- **Adding a test:** drop a `*.test.ts` next to the module and import the function
  directly:
  ```ts
  import { describe, it, expect } from 'vitest'
  import { someFn } from './lookup'
  describe('lookup helper', () => {
    it('does X', () => { expect(someFn('入力')).toBe('期待') })
  })
  ```
  Good candidates: deinflection edge cases, `jp/extract.ts` ruby-aware extraction,
  `jp/lookup.ts` candidate ranking, `util/debounce.ts`. Anything needing the browser,
  OPFS, IndexedDB, or `<foliate-view>` is **not** a unit test — verify via the loop in
  [§6](#6-running--verifying). (`@vitest/browser` is installed but no browser-mode tests
  exist yet.)

---

## 10. Known constraints & gotchas

- **License: GPL-3.0.** `src/services/jp/deinflect.ts` is vendored from 10ten and is
  **GPL-3.0-or-later** (`src/services/jp/LICENSE-10ten`), so distributing Tsuzuri means
  distributing under GPL-3.0. Relicensing requires reimplementing the deinflection rules.
  (JMdict data is CC BY-SA.) See [`japanese.md`](./japanese.md).
- **Backend-free / offline.** Fully client-side. The dictionary downloads once into
  jpdict's IndexedDB then works entirely offline; book bytes live in OPFS; the app shell
  is precached by the SW. See [`storage-pwa-ios.md`](./storage-pwa-ios.md).
- **On-device iOS verification still pending** — all verified in desktop Chrome only:
  - **縦書き column-height fill quirk** — foliate could under-measure column height on
    first paint. Primarily addressed by `applyLayout` (`reader.ts`) deriving the vertical
    page box from the live viewport; a ~250 ms `#nudgeLayout()` re-render and a debounced
    `#onResize` listener remain as hedges. See [`reader-engine.md`](./reader-engine.md).
  - **`caretRangeFromPoint` accuracy** in vertical iframes (tap hit-testing) —
    [`reader-engine.md`](./reader-engine.md) / [`japanese.md`](./japanese.md).
  - **OPFS `createWritable`** behaviour and **Add-to-Home-Screen** install / data
    durability on iOS Safari — [`storage-pwa-ios.md`](./storage-pwa-ios.md).

---

## 11. Where to look

| Doc | Covers |
|-----|--------|
| [`architecture.md`](./architecture.md)      | App structure, data flow, stores, screen lifecycle. |
| [`reader-engine.md`](./reader-engine.md)    | foliate-js integration, pagination, layout/measure, taps & swipes, selection, vendor patches, vertical-fill. |
| [`japanese.md`](./japanese.md)              | Dictionary (jpdict-idb/JMdict), deinflection, ruby-aware extraction, lookup pipeline, GPL note. |
| [`storage-pwa-ios.md`](./storage-pwa-ios.md)| OPFS blobs, IndexedDB (idb), persistence, service worker, install, iOS caveats. |
| [`ui-and-design.md`](./ui-and-design.md)    | Theme tokens, `Sheet`/`Segmented`/`Icon`, responsive behaviour, safe-area, a11y. |
| [`deployment.md`](./deployment.md)          | GitHub Pages CI (`deploy.yml`), the `/epub/` base, PWA scope, the `sharp` strip. |

Project **skills** under `.claude/skills/`: **`tsuzuri-reader`** (reader/engine),
**`tsuzuri-japanese`** (dictionary/deinflection/lookup), **`tsuzuri-verify`** (run/verify loop).
