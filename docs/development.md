# Development

Setup, scripts, tests, and verification in a browser and on a device. CI and GitHub Pages:
[deployment.md](deployment.md).

## 1. Setup

- Node `^20.19 || >=22.12` (Vite 8's floor; CI uses Node 24), ESM throughout. `npm install`.
- `sharp` is a local-only devDependency for the generator scripts; CI deletes it before
  installing ([deployment.md §3](deployment.md#3-sharp-is-local-only)).

## 2. Scripts (`package.json`)

| Script | Runs | Notes |
| --- | --- | --- |
| `npm run dev` | `predev` → `vite` | Base `/`, service worker enabled (`devOptions`), `server.host: true` (prints a LAN URL). |
| `npm run build` | `prebuild` → `vite build` | `dist/`, base `/epub/`, Workbox precache + manifest. |
| `npm run preview` | `vite preview` | Serves `dist/` under `/epub/`. |
| `npm test` | `vitest run` | Unit tests (§4). |
| `npm run check` | `svelte-check --tsconfig ./tsconfig.app.json && tsc -p tsconfig.node.json` | App + build-tooling types. Run after every change. No separate lint script. |
| `npm run books:extract -- <slug>` / `books:build` | `scripts/books/*` | Bundled books ([translation.md](translation.md)). |

`predev`/`prebuild` run `scripts/copy-kuromoji-dict.mjs`, staging the trimmed IPADIC (11
`*.dat.gz`) into `public/kuromoji/dict/` (gitignored; [japanese.md §5](japanese.md)).

Generators (dev-only, `sharp`):

- `node scripts/make-test-epub.mjs` → `test-books/tsuki-to-neko.epub`: vertical-rl, rtl-spine
  EPUB3 with ruby, conjugated verbs/adjectives (食べていました, 美しかった, 走った, 読みたい,
  行こう, 見られた), a repeated chapter so it spans several pages, and a generated cover.
- `node scripts/gen-icons.mjs` → `public/icons/` and the light/dark launch images in
  `public/splash/`, rewriting their `<link>` tags in `index.html` between the
  `splash:start`/`splash:end` markers.

## 3. Tooling notes

- **Two tsconfigs:** `tsconfig.app.json` (app; svelte-check; excludes `src/vendor/**`) and
  `tsconfig.node.json` (only `vite.config.ts`). `src/vite-env.d.ts` declares the PWA virtual
  modules and `__APP_VERSION__` (commit date + short SHA, injected by `define`).
- **kuromoji loader shim:** `kuromojiLoader.cjs` is aliased in `vite.config.ts` twice:
  `resolve.alias` (build) and an `optimizeDeps.rolldownOptions` plugin (the dev prebundle
  ignores `resolve.alias` for a dep's internals). Re-check both after bumping Vite or
  kuromoji; a miss shows as a dictionary card stuck loading.
- **Workers** are ES modules (`worker.format: 'es'`).
- `src/vendor/foliate-js/**` is edited only as documented `TSUZURI PATCH`es
  ([reader-engine.md §1](reader-engine.md)).

## 4. Tests

Vitest (`vitest.config.ts`): `environment: 'node'`, `include: ['src/**/*.test.ts']`, only the
Svelte plugin (so `*.svelte.ts` stores compile). No jsdom or browser mode: IndexedDB tests use
`fake-indexeddb`, and `extract.test.ts` uses a hand-built fake `Document` with per-character
rects. Tests sit next to their module as `*.test.ts`; the Japanese pipeline's are listed in
[japanese.md §9](japanese.md#9-tests-npm-test). Anything that needs a real browser, OPFS or
`<foliate-view>` is verified in the browser (§5).

## 5. Browser verification

Checklist: the **tsuzuri-verify** skill (`.claude/skills/tsuzuri-verify/SKILL.md`), with the
chrome-devtools MCP at iPad landscape 1194×834. The only expected console message is
foliate's iframe `allow-scripts and allow-same-origin` sandbox warning.

### DEV hook `window.__tsuzuri`

foliate renders into a closed shadow root, so `Reader.svelte` installs, in DEV builds only:

```ts
window.__tsuzuri = { doc, controller, dictState, dict, extractTextAt, lookupAt }
```

`doc` is the most recently loaded content document, `dictState` the card's `card.state`,
`dict` the dictionary store. Removed on reader destroy; tree-shaken from production.

**Tap-accuracy sweeps:** drive an isolated Chrome (`puppeteer-core`, own `--user-data-dir`),
poll until `__tsuzuri.doc` is set, and dispatch `PointerEvent`s (`isPrimary: true`) on the
content document at iframe-local coordinates (screen minus
`frameElement.getBoundingClientRect()`); host-margin gestures go on the `<foliate-view>`
element. Compare `ex.text[ex.tapOffset]` with the glyph under the point; a probe on furigana
should resolve to the ruby base, and `null` is a dead tap.

### Scripted checks (`scripts/e2e/`)

`lib.mjs` starts `vite` / `vite preview` (`serve('dev')`) and launches system Chrome with a
fresh profile per launch (`launch(device, url)`).

| Script | Checks |
| --- | --- |
| `shelf.mjs` (after `npm run build`) | First-visit load metrics and shelf screenshots per device (`/tmp/shelf-*.png`); on iPad: download a bundled book (throttled), open, delete (back to available), a failed download with the server stopped (offline message), **Download all** timing. |
| `english.mjs [ipad\|iphone\|desktop]` | Show-all, the card's Translation, the dictionary download from a card, both writing modes; `/tmp/en-<device>-<mode>-<step>.png`. |
| `perf.mjs [device]` | A long chapter at 4× CPU throttle (load, turns, show-all long tasks, heap); fails on an unhandled rejection. |

## 6. Adding a reader setting

1. Add the field and default to `ReaderSettings` / `DEFAULT_SETTINGS` in `src/services/types.ts`
   (persistence and backfill are automatic).
2. Add a control in `src/lib/reader/ReaderSettings.svelte` that calls `updateSettings({...})`,
   then `onchange('appearance' | 'layout' | 'writingmode' | 'english')`; `Reader.svelte` maps
   these to `applyAppearance`, `applyLayout`, a writing-mode re-open, and (English) closing
   the card before `applyAppearance`.
3. Read it in `services/reader/` (`appearanceCSS` in `styles.ts`, or `applyLayout`).

## 7. On-device (iPhone / iPad)

- **LAN:** plain HTTP from `npm run dev` is enough for layout and gesture checks in Safari, but
  iOS registers service workers and installs PWAs only over HTTPS.
- **HTTPS:** a tunnel (`cloudflared tunnel`, `ngrok`) in front of `npm run dev`, or
  `npm run build && npm run preview` behind one (open `/epub/`), or the deployed site.
- Safari → Share → **Add to Home Screen**, launch from the icon, import an EPUB, download the
  dictionary, read. Re-check the items CLAUDE.md lists as not yet verified on iOS.
