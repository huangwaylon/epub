# Development guide

Contributor / workflow guide for **Tsuzuri** (綴), a Japanese EPUB reader PWA.
Stack: **Svelte 5 (runes) + TypeScript + Vite**, with `vite-plugin-pwa` (Workbox)
and a vendored [foliate-js](https://github.com/johnfactotum/foliate-js) rendering
engine.

This doc covers setup, scripts, tooling, layout, test assets, the run/verify loop,
conventions, and worked examples. For subsystem depth, see [Where to look](#where-to-look).

---

## 1. Prerequisites & setup

- **Node.js** — built and tested with **v25**; works on modern **Node 18+**
  (`@types/node` is pinned to `^24`, ESM `type: "module"` throughout). **CI builds on
  Node 22** (see [§6 → Deployment / CI](#deployment--ci) and
  [`docs/deployment.md`](./deployment.md)).
- **Install:**
  ```sh
  npm install
  ```
- **Dev server binds to the LAN.** `vite.config.ts` sets `server.host: true`, so
  `npm run dev` prints both a `localhost` URL and a LAN URL (e.g.
  `http://192.168.x.x:5173`). The LAN URL is what you point an iPhone/iPad at for
  on-device testing (see [§6](#6-running--verifying)).

Native deps note: `sharp` is used **only by the dev scripts** ([§5](#5-test-assets--generators))
and is a **local-only devDependency** — CI strips it before installing (its native
`@img/*` packages crash npm in CI). See [`docs/deployment.md`](./deployment.md).

---

## 2. Scripts

All scripts live in `package.json`. There is no lint script; type/lint enforcement
happens through `check` (svelte-check + strict `tsc` on the node config).

| Script            | Command                                                              | Purpose |
|-------------------|---------------------------------------------------------------------|---------|
| `npm run dev`     | `vite` (after `predev`)                                            | Dev server with HMR. Enables the PWA service worker in dev (`VitePWA.devOptions.enabled`). Exposed on the LAN. Base is `/` (clean local URL). |
| `npm run build`   | `vite build` (after `prebuild`)                                   | Production build to `dist/`, with base `/epub/` (the GitHub Pages project path — see [§6 → Deployment / CI](#deployment--ci)). Generates the PWA manifest, precaches the app shell via Workbox (`globPatterns`, ignoring `**/pdfjs/**` and `**/kuromoji/**`). |
| `npm run preview` | `vite preview`                                                    | Serves the built `dist/` locally. Use behind an HTTPS tunnel for a production-like on-device test. |
| `npm test`        | `vitest run`                                                       | Runs unit tests once (non-watch) under the Node env. Currently the deinflection tests. |
| `npm run check`   | `svelte-check --tsconfig ./tsconfig.app.json && tsc -p tsconfig.node.json` | Type-checks the app (`.svelte`/`.ts`/`.js`) **and** the build tooling (`vite.config.ts`). Run before committing. |

> **`predev` / `prebuild`** run `node scripts/copy-kuromoji-dict.mjs` first, staging the
> ~19 MB kuromoji IPADIC dictionary from `node_modules/@sglkc/kuromoji/dict` into
> `public/kuromoji/dict/` (gitignored). Vite then serves it in dev and copies it into
> `dist/` on build. CI's `npm run build` triggers `prebuild`, so the dict ships without
> being committed. See [japanese.md §4](./japanese.md) and [deployment.md](./deployment.md).

---

## 3. Tooling & config

### kuromoji dictionary-loader shim

Word segmentation uses **kuromoji** (`@sglkc/kuromoji`). Its stock browser loader fetches
the gzipped dict and `gunzipSync`s it — but **hangs silently** if the server returns the
file already-decompressed (it sets `Content-Encoding: gzip`, which Vite's dev/preview server
does, so the browser auto-inflates). `src/services/jp/kuromojiLoader.cjs` is a defensive
replacement (gunzip only when the bytes are actually gzip), aliased over kuromoji's loader in
`vite.config.ts` in **two** places because Vite 8 (Rolldown) resolves the dev prebundle and
the build separately: `resolve.alias` (build) and `optimizeDeps.rolldownOptions` (dev
prebundle). If you bump Vite or kuromoji, re-verify both paths use the shim (the symptom of
failure is the dictionary popup stuck on its spinner; the console shows repeated
`Uncaught (in promise)`).

### TypeScript: a two-project split

`tsconfig.json` is a thin solution file referencing two project configs:

- **`tsconfig.app.json`** — the application. Extends `@tsconfig/svelte`,
  `target es2023`, `module esnext`, `types: ["svelte", "vite/client"]`,
  `noEmit`. It sets **`allowJs: true` but `checkJs: false`** (JS is allowed but not
  type-checked), and **`exclude: ["src/vendor/**"]`** so the vendored foliate-js
  (untyped JS) is never type-checked. Includes `src/**/*.{ts,js,svelte}`.
  This is the config svelte-check uses.
- **`tsconfig.node.json`** — the build tooling. `module esnext`,
  `moduleResolution: "bundler"`, `verbatimModuleSyntax`, `erasableSyntaxOnly`,
  plus strict lint flags (`noUnusedLocals`, `noUnusedParameters`,
  `noFallthroughCasesInSwitch`). Includes only `vite.config.ts`. This is what the
  second half of `npm run check` runs.

### Ambient types

`src/vite-env.d.ts` references the Vite client and **both** vite-plugin-pwa client
type sets — `vite-plugin-pwa/svelte` and `vite-plugin-pwa/client` — so the
`virtual:pwa-register/*` modules type-check (used by `src/stores/pwa.svelte.ts`).

### Vite / Svelte

- `svelte.config.js` is intentionally empty (`export default {}`) — default Svelte 5
  setup via `@sveltejs/vite-plugin-svelte`.
- `vite.config.ts` wires `svelte()` and `VitePWA(...)`, sets `server.host: true`,
  and `worker.format: 'es'` (ES-module web workers — relevant because
  `@birchill/jpdict-idb` runs dictionary updates in a worker). It also sets a
  **build-only base of `/epub/`** (dev stays at `/`) for the GitHub Pages project
  site, from which the PWA `start_url`/`scope`/`navigateFallback` derive — see
  [§6 → Deployment / CI](#deployment--ci) and [`docs/deployment.md`](./deployment.md).
- PWA: `registerType: 'prompt'` (update via an in-app toast — see
  `src/lib/components/UpdateToast.svelte`); manifest declares standalone display
  and the icons under `public/icons/`.

### esbuild / vendored `enum`

Vite transpiles per-file with esbuild (isolated modules). A `const enum` cannot be
inlined across files in that mode, so **`src/services/jp/deinflect.ts` was changed
from `const enum` to `enum`** for its `Reason`/`Type` enums (documented at the top
of that file). Keep it a plain `enum` — do not revert to `const enum`, and note
that `erasableSyntaxOnly` is set only on the **node** tsconfig, not the app config,
so the runtime `enum` in app code is fine.

---

## 4. Project layout quick-reference

```
epub/
├─ index.html                 App entry; mounts src/main.ts
├─ src/
│  ├─ main.ts                 Bootstraps the Svelte app
│  ├─ App.svelte              Top-level screen switch (shelf ↔ reader)
│  ├─ app.css                 Global tokens (themes, safe-area, fonts)
│  ├─ lib/
│  │  ├─ components/          Reusable UI: Sheet, Segmented, Icon, UpdateToast
│  │  ├─ library/             Shelf, BookCover, ShelfSettings (the bookshelf screen)
│  │  ├─ reader/              Reader + its panels: ReaderSettings, DictionaryPopup,
│  │  │                       SelectionToolbar, TocSheet, AnnotationsPanel
│  │  ├─ actions/             Svelte actions (longpress.ts)
│  │  └─ util/                anchoredPosition.ts, debounce.ts, small helpers
│  ├─ services/               Framework-agnostic logic (NO Svelte imports)
│  │  ├─ types.ts             Core persisted data model (BookMeta, Annotation, ReaderSettings…)
│  │  ├─ reader.ts            ReaderController: <foliate-view> wrapper, taps/swipes, layout, highlights
│  │  ├─ library.ts          Import / list / delete books
│  │  ├─ storage/            blobs.ts (OPFS), db.ts (IndexedDB via idb), persist.ts
│  │  └─ jp/                 deinflect.ts (vendored GPL), lookup.ts, dictdb.ts, extract.ts,
│  │                          segment.ts (kuromoji), kuromojiLoader.cjs (loader shim),
│  │                          deinflect.test.ts, LICENSE-10ten
│  ├─ stores/                 Svelte 5 rune stores (*.svelte.ts): settings, library,
│  │                          annotations, dict, nav, pwa
│  └─ vendor/foliate-js/      Pinned MIT rendering engine — DO NOT EDIT (see §7)
├─ scripts/                   Dev-only: make-test-epub.mjs, gen-icons.mjs, copy-kuromoji-dict.mjs
├─ public/icons/              Generated PWA icons
├─ public/kuromoji/dict/      Staged kuromoji IPADIC dict (gitignored; from predev/prebuild)
├─ test-books/                Generated test EPUB(s)
├─ .github/workflows/         deploy.yml (GitHub Pages CI — see §6 / docs/deployment.md)
└─ docs/                      This guide + subsystem docs (see §11)
```

Subsystem depth is intentionally deferred to the docs in [§11](#11-where-to-look).

---

## 5. Test assets / generators

Both scripts are **dev-only** (not part of `build`); regenerate outputs only when
you change the generators.

### `node scripts/make-test-epub.mjs`

Builds `test-books/tsuki-to-neko.epub` — a small **vertical-writing (縦書き,
`vertical-rl`)** Japanese **EPUB3** with `page-progression-direction="rtl"`. It is
purpose-built to exercise the reader and dictionary:

- **Ruby/furigana** throughout (`<ruby>漢字<rt>かな</rt></ruby>`), so you can verify
  the lookup window skips `<rt>` text.
- **Deliberately conjugated verbs & adjectives** (e.g. 食べていました, 美しかった,
  走った, 読みたい, 行こう, 見られた) to exercise the deinflection engine.
- **Multiple chapters**; **chapter 1 is repeated** (the `ch1Paras` array is flattened
  ×6) to be reliably multi-page for pagination/RTL page-turn testing.
- A **generated cover** (an inline SVG rasterized to PNG) for cover-extraction testing.

Dependencies: `fflate` (`zipSync`) for the EPUB zip and `sharp` for the cover PNG.
The `mimetype` entry is stored uncompressed and first, per EPUB spec. (`sharp` is a
local-only devDependency, stripped in CI — see [`docs/deployment.md`](./deployment.md).)

### `node scripts/gen-icons.mjs`

Regenerates the PWA icons into `public/icons/` from two inline SVGs (a rounded mark
and a maskable full-bleed mark), rasterized with `sharp`. Outputs `icon-192.png`,
`icon-512.png`, `apple-touch-icon-180.png`, `maskable-512.png` — matching the
`manifest.icons` and `includeAssets` in `vite.config.ts`.

---

## 6. Running & verifying

### Standard local loop (desktop, Chrome DevTools MCP)

1. `npm run dev`.
2. Drive the app with the **chrome-devtools MCP**, ideally at **iPad-landscape**
   geometry so the two-page spread and sheet-as-centered-card behaviour engage:
   - `new_page` → `resize_page` to **1194×834** → `navigate_page` to the dev URL.
3. **Import the test EPUB**: use `upload_file` targeting the **"Import book"** button
   (the shelf's file input).
4. **Open the book**; from **Settings**, **download the dictionary** (this populates
   jpdict's IndexedDB; lookups need it).
5. **Verify** the core behaviours:
   - Vertical **縦書き / RTL pagination** — a **horizontal swipe** turns the page
     (drag left → next, drag right → previous; foliate's own touch turn is patched
     out, see [§7](#7-coding-conventions)). Page turns animate as a horizontal slide.
   - **Tap-to-define** — tap a Japanese glyph; the `DictionaryPopup` appears. A tap in
     the top/bottom edge band toggles the reader chrome (a tap on blank centre space does
     nothing); a tap while a popup is open just dismisses it — **anywhere on screen,
     including the nav-bar band, without toggling the chrome**. **Tap never turns the page.**
   - **Drag-select** → the `SelectionToolbar` → **highlight**.
   - **Bookmark** toggle (and that it appears in the annotations panel).
6. Check `list_console_messages`. The only expected message is the **benign foliate
   iframe sandbox warning** about `allow-scripts` together with `allow-same-origin`
   (foliate sets `sandbox="allow-same-origin allow-scripts"` on the content iframe in
   `paginator.js` / `fixed-layout.js`, needed for a WebKit event bug). Anything else
   is a regression.

### On-device (iOS Safari)

iOS requires **HTTPS** for service workers and Add-to-Home-Screen:

1. Serve over HTTPS — either a tunnel (`cloudflared tunnel`, `ngrok`) in front of
   `npm run dev`, or `npm run build && npm run preview` behind an HTTPS tunnel.
2. Open the HTTPS URL in **iOS Safari** → Share → **Add to Home Screen** → launch
   the installed icon (standalone PWA).
3. Import an EPUB, download the dictionary (Settings), and read.

> On-device iOS verification is still **pending** — see [§10](#10-known-constraints--gotchas).

### Deployment / CI

The app is **fully client-side / backend-free** and deploys to **GitHub Pages** at
**<https://huangwaylon.github.io/epub/>**. Pushing to `main` runs
`.github/workflows/deploy.yml` (also `workflow_dispatch`):

- **build** job (Node 22): strip the local-only `sharp` devDependency, `npm install`,
  `npm run build` (base `/epub/`), `actions/configure-pages` with `enablement: true`,
  then `actions/upload-pages-artifact` on `dist`.
- **deploy** job: `actions/deploy-pages`. A `concurrency: pages` group serializes
  deployments.

Full depth (the `sharp` strip rationale, base-path / PWA-scope derivation, Pages
enablement) is in **[`docs/deployment.md`](./deployment.md)** — refer there rather
than duplicating it here.

---

## 7. Coding conventions

- **Match surrounding style.** No formatter/lint is enforced beyond `npm run check`;
  follow the existing code (2-space indent, no semicolons in `.ts`/config, single
  quotes).
- **Svelte 5 runes everywhere** — `$state`, `$derived`, `$props`, `$bindable`,
  `$effect`. Stores are plain modules ending in `.svelte.ts` exporting `$state`
  objects (see `src/stores/settings.svelte.ts`); mutate them through their exported
  helpers (e.g. `updateSettings`), not directly, so persistence side-effects run.
- **Services are framework-agnostic** — nothing under `src/services/` imports
  Svelte. They are plain TS, unit-testable in the Node env. Keep it that way.
- **Components own scoped styles** — styles live in the component's `<style>` block
  and read theme tokens from `app.css` CSS custom properties (`var(--ink)`,
  `var(--accent)`, …). The reader injects matching CSS into content docs via
  `appearanceCSS()` (`src/services/reader.ts`).
- **Japanese text gets `lang="ja"`** (and `xml:lang="ja"`), as in the generated test
  EPUB and content rendering.
- **Icon-only buttons get `aria-label`s**; toggles use `role="switch"`/`aria-checked`
  (see `ReaderSettings.svelte`). Dialogs/sheets are `role="dialog" aria-modal`.
- **Safe-area handling** uses `env(safe-area-inset-*)` via CSS vars (e.g.
  `--safe-bottom` in `Sheet.svelte`) so content clears the iPhone notch/home bar.
- **Never edit `src/vendor/foliate-js`** except as a deliberate, documented patch.
  There are **two** documented patches:
  1. **pdf.js removal** — the `else if (await isPDF(...))` branch (and its
     `import('./pdf.js')`) was deleted from `makeBook` in `view.js`, so PDFs are no
     longer a supported book type (`globIgnores: ['**/pdfjs/**']` in the Workbox
     config keeps any residue out of the precache). The `isPDF` helper remains as
     dead code; leave it.
  2. **foliate touch page-turn disabled** — search `paginator.js` for
     **`TSUZURI PATCH`**: `#onTouchMove` keeps `e.preventDefault()` (blocking native
     scroll and Safari's edge back-swipe) but drops `this.scrollBy(...)`, and
     `#onTouchEnd` drops the velocity-snap turn. We drive page turns ourselves from a
     horizontal swipe detector in `src/services/reader.ts` (`#attachTaps`), so the
     turn animates as a horizontal slide and stays horizontal for 縦書き books.

  If you must patch the engine, keep the diff minimal and document it (see
  [§8 → Patch a vendor file](#patch-a-vendor-file)).

---

## 8. Worked examples

### Add a reader setting

1. **Model** — add the field to `ReaderSettings` and a default to `DEFAULT_SETTINGS`
   in `src/services/types.ts`.
2. **Control** — add a control in `src/lib/reader/ReaderSettings.svelte`. Write the
   value via `updateSettings({ ... })` (imported from
   `src/stores/settings.svelte.ts`), then call the `onchange(kind)` prop with the
   right `kind`:
   - `'appearance'` → theme/font/size/spacing (re-injects styles),
   - `'layout'` → page geometry (margins/columns),
   - `'writingmode'` → 縦/横 (triggers a content re-open).
   The Reader wires `onchange` to call `applyAppearance` / `applyLayout` /
   `reopenForWritingMode` on the `ReaderController` accordingly.
3. **Consume** — read the new field in `src/services/reader.ts`: `appearanceCSS(s)`
   for visual properties, or `applyLayout(s)` for geometry.
4. **Persistence is automatic** — `updateSettings` calls `saveSettings` (IndexedDB)
   once hydrated, and the rune store re-renders consumers. No extra plumbing.

### Add a new sheet/panel

1. Create a component under `src/lib/reader/` (or `library/`) with its own scoped
   styles, taking the data it needs via `$props`.
2. Render it inside `<Sheet bind:open={...} title="…">` in the relevant screen
   (`Reader.svelte` / `Shelf.svelte`). `Sheet` (`src/lib/components/Sheet.svelte`)
   gives you the responsive **bottom-sheet on phones / centered card on ≥768px**
   behaviour, scrim, drag-grip, Escape-to-close, and safe-area padding for free.
   Pass content as the default slot/children snippet.

### Patch a vendor file

If a foliate fix is unavoidable:

1. Make the **smallest possible** change in `src/vendor/foliate-js/…`.
2. Document it **here** (extend the list in [§7](#7-coding-conventions)) **and** in
   `docs/reader-engine.md`.
3. Keep the diff minimal and self-contained so future engine re-vendoring is
   tractable. (Precedent: the pdf.js removal in `view.js` and the touch page-turn
   disable in `paginator.js`, both tagged/described in [§7](#7-coding-conventions).)

---

## 9. Testing

- **Runner:** Vitest. `vitest.config.ts` is intentionally minimal and **plugin-free**
  (no Svelte/PWA plugins) so tests run fast: `environment: 'node'`,
  `include: ['src/**/*.test.ts']`.
- **Scope:** unit tests for **pure logic** in services — no DOM, no Svelte. The only
  current test is `src/services/jp/deinflect.test.ts`, which asserts the vendored
  deinflection engine reduces conjugated surface forms to their dictionary base
  (ichidan te-form, i-adjective past, godan past, -tai, volitional,
  passive/potential), always includes the original surface as a candidate, and tags
  deinflected candidates with `reasonChains`.
- **Adding a test:** drop a `*.test.ts` next to the module under test and import the
  function directly, e.g.:
  ```ts
  import { describe, it, expect } from 'vitest'
  import { someFn } from './lookup'
  describe('lookup helper', () => {
    it('does X', () => { expect(someFn('入力')).toBe('期待') })
  })
  ```
  Good candidates: deinflection edge cases, `jp/extract.ts` ruby-aware text
  extraction, `jp/lookup.ts` candidate ranking, `util/debounce.ts`. Anything needing
  the browser, OPFS, IndexedDB, or `<foliate-view>` is **not** a unit test — verify
  those via the run/verify loop in [§6](#6-running--verifying). (`@vitest/browser` is
  installed but no browser-mode tests exist yet.)

---

## 10. Known constraints & gotchas

- **(a) License: GPL-3.0.** `src/services/jp/deinflect.ts` is vendored from the 10ten
  Japanese Reader and is **GPL-3.0-or-later** (`src/services/jp/LICENSE-10ten`).
  Distributing Tsuzuri therefore means distributing under GPL-3.0. Relicensing
  requires **reimplementing the deinflection rules** from scratch. (JMdict data is
  CC BY-SA.) Details: [`docs/japanese.md`](./japanese.md).
- **(b) Backend-free / offline.** The app is **fully client-side** — there is no
  server component. The Japanese **dictionary** downloads once (into jpdict's own
  IndexedDB) and then works **entirely offline**; book bytes live in OPFS and the app
  shell is precached by the service worker. Details: [`docs/japanese.md`](./japanese.md).
- **(c) On-device iOS verification is still pending.** Open items, all documented in
  the subsystem docs:
  - The vertical (縦書き) **column-height fill quirk** — foliate could under-measure
    the column height on first paint at some sizes, leaving dead space. Primarily
    addressed by `applyLayout` (`src/services/reader.ts`) deriving the vertical page
    box from the live viewport so the column fills on the first paint. As a hedge, a
    single ~250 ms `#nudgeLayout()` re-render (`reader.ts` ~:216–224) plus a
    150 ms-debounced `resize` listener (`#onResize`, ~:282–286) remain.
    See [`docs/reader-engine.md`](./reader-engine.md).
  - **`caretRangeFromPoint` accuracy** in vertical iframes (tap-to-define hit-testing).
    See [`docs/reader-engine.md`](./reader-engine.md) / [`docs/japanese.md`](./japanese.md).
  - **OPFS `createWritable`** behaviour on iOS Safari for book storage.
    See [`docs/storage-pwa-ios.md`](./storage-pwa-ios.md).
  - **Add-to-Home-Screen** install / durability of stored data.
    See [`docs/storage-pwa-ios.md`](./storage-pwa-ios.md).

---

## 11. Where to look

Subsystem docs (in this `docs/` folder) — start here when working on a given area:

| Doc | Covers |
|-----|--------|
| [`docs/architecture.md`](./architecture.md)      | High-level app structure, data flow, stores, screen lifecycle. |
| [`docs/reader-engine.md`](./reader-engine.md)    | foliate-js integration, pagination, layout/measure, taps & swipe page-turns, selection, the vendor patches, the vertical-fill handling. |
| [`docs/japanese.md`](./japanese.md)              | Dictionary (jpdict-idb/JMdict), deinflection, ruby-aware extraction, lookup window, GPL note. |
| [`docs/storage-pwa-ios.md`](./storage-pwa-ios.md)| OPFS book blobs, IndexedDB (idb), persistence, service worker, install, iOS caveats. |
| [`docs/ui-and-design.md`](./ui-and-design.md)    | Theme tokens, `Sheet`/`Segmented`/`Icon`, responsive behaviour, safe-area, a11y. |
| [`docs/deployment.md`](./deployment.md)          | GitHub Pages CI (`deploy.yml`), the `/epub/` base path, PWA scope, the `sharp` CI strip. |

Project **skills** under `.claude/skills/` give task-specific guidance for agents:

- **`tsuzuri-reader`** — working on the reader/rendering engine.
- **`tsuzuri-japanese`** — working on the dictionary / deinflection / lookup.
- **`tsuzuri-verify`** — the run/verify loop (Chrome DevTools MCP, on-device checks).
