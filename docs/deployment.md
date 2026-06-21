# Deployment & CI — GitHub Pages

Tsuzuri ships as a **static** Progressive Web App to **GitHub Pages**.

- **Live site:** <https://huangwaylon.github.io/epub/>
- **Pipeline:** `.github/workflows/deploy.yml` (GitHub Actions), on every push to `main`.
- **Build base:** `/epub/` (project-site subpath) in production; `/` in dev.

There is **no backend**. The app is fully client-side: EPUB bytes live in OPFS, all
structured data and the JMdict dictionary live in IndexedDB on the device, and the
service worker precaches the app shell for offline use. Pages only ever serves the
static `dist/` artifact — which is exactly why the app has no server-dependent
features (the former online-translation proxy was removed; see [§6](#6-history--why-no-server)).

---

## 1. The live deployment

| Fact | Value | Source |
| --- | --- | --- |
| URL | `https://huangwaylon.github.io/epub/` | GitHub Pages project site for this repo |
| Trigger | push to `main`, or manual `workflow_dispatch` | `.github/workflows/deploy.yml` (`on:`) |
| Host type | **static** (no server code, no functions) | GitHub Pages |
| Build base | `/epub/` (prod) · `/` (dev) | `vite.config.ts` (`base`) |
| Node (CI) | **22** | `deploy.yml` (`setup-node`) |
| Node (local) | 18+ (developed on 25) | `docs/development.md` |

---

## 2. The Actions workflow (`.github/workflows/deploy.yml`)

Two jobs, run by `actions/*` Pages actions. Permissions: `pages: write`,
`id-token: write`. Concurrency group `pages` with `cancel-in-progress: false` (a
running deploy finishes before the next starts).

### `build`
1. `actions/checkout` + `actions/setup-node@v4` with `node-version: 22`, `cache: npm`.
2. **Install (with the `sharp` workaround — see [§4](#4-the-sharp-ci-gotcha)):**
   ```sh
   npm pkg delete devDependencies.sharp   # strip the local-only native dep
   rm -f package-lock.json                # resolve fresh so its optional deps aren't processed
   npm install --include=dev --no-audit --no-fund   # --include=dev forces vite/svelte even if NODE_ENV=production
   ```
   (`env: NODE_ENV: development`.)
3. **Verify `vite` installed** — a guard step that fails loudly if the toolchain
   didn't land, instead of an opaque `vite: not found` later.
4. `npm run build` → `dist/`.
5. `actions/configure-pages@v5` with **`enablement: true`** — flips the repo's Pages
   source to "GitHub Actions" automatically, so a fresh repo deploys without changing
   settings by hand.
6. `actions/upload-pages-artifact@v3` with `path: dist`.

### `deploy`
`needs: build`; runs `actions/deploy-pages@v4` in the `github-pages` environment and
surfaces the deployed `page_url`.

---

## 3. The `/epub/` base path (and why it matters)

`vite.config.ts` sets the base **per command**:

```ts
const base = command === 'build' ? '/epub/' : '/'
```

Because the Pages **project** site is served from `https://<user>.github.io/epub/`
(not the origin root), the production build must be rooted at `/epub/`. Dev stays at
`/` for a clean `localhost` URL. The base then threads through the PWA config:

| Derived from `base` | Where | Effect |
| --- | --- | --- |
| `manifest.start_url` | `vite.config.ts` | installed PWA opens at `/epub/` |
| `manifest.scope` | `vite.config.ts` | install scope is `/epub/` (Add-to-Home-Screen) |
| Workbox `navigateFallback` | `vite.config.ts` (`` `${base}index.html` ``) | SPA offline fallback resolves under `/epub/` |
| Asset URLs (`/assets/*`, icons) | Vite build | rewritten under `/epub/` automatically |

**Gotcha for editors:** never hard-code a **root-relative** path (`/foo`, `/api/...`)
for an asset or fetch that must work in production — at the Pages origin a leading `/`
escapes the `/epub/` scope and resolves at `huangwaylon.github.io/...`, outside the
app. Use base-relative URLs (Vite rewrites `import`ed assets and `public/` references
for you) or `import.meta.env.BASE_URL`. (This subpath escape is the trap that broke
the old `/api/translate` endpoint before that feature was removed.)

`index.html` is the one place that still writes root-relative hrefs
(`/favicon.svg`, `/icons/apple-touch-icon-180.png`): that's fine because Vite
**rewrites HTML asset URLs under `base` at build time**. Manifest icon `src` values
are written relative (`icons/icon-192.png`), so they also resolve under `/epub/`.

---

## 4. The `sharp` CI gotcha

`sharp` is a **local-only** `devDependency`, used solely by the generator scripts
(`scripts/gen-icons.mjs`, `scripts/make-test-epub.mjs`). It is **not** used by
`vite build`.

Installing it in CI crashes npm (`Exit handler never called!`) on its ~27 native
`@img/*` platform packages — under both `npm ci` and `npm install`. So `deploy.yml`:

```sh
npm pkg delete devDependencies.sharp   # remove it from THIS checkout's package.json
rm -f package-lock.json                # drop the lockfile so the optional deps are never resolved
npm install --include=dev              # reinstall the rest of devDependencies
```

Implications when editing the build:
- **Don't rely on `sharp` at build time.** Regenerate icons / the test EPUB locally
  and commit the outputs (`public/icons/*`, `test-books/*`).
- **Don't assume `package-lock.json` drives the CI install** — CI removes it and
  resolves fresh. (The lockfile is still committed for reproducible *local* installs.)
- If you add a dependency with heavy native/optional deps, expect the same class of
  CI failure and handle it the same way.

---

## 5. What ships (and what doesn't)

The artifact is `dist/`: the app shell (JS/CSS/HTML), the PWA manifest, the service
worker, the icons, **and the kuromoji IPADIC dictionary** (`dist/kuromoji/dict/*.dat.gz`,
~19 MB). Workbox precaches `**/*.{js,css,html,svg,png,woff2}` (ignoring `**/pdfjs/**`
and `**/kuromoji/**`), capped at 6 MB/file — so the dict is **not** in the install
precache; it is **runtime-cached** (CacheFirst) on first tap-to-define so word
segmentation works offline thereafter.

The kuromoji dict is staged into `public/kuromoji/dict/` from `node_modules` by
`scripts/copy-kuromoji-dict.mjs`, which runs automatically via the `predev` / `prebuild`
npm scripts (so a `npm run build` in CI produces it; `public/kuromoji/` is gitignored,
not committed). See [`docs/japanese.md`](./japanese.md) §4 and the gzip loader-shim note
in [`docs/development.md`](./development.md).

**Not shipped:** the test EPUB (`test-books/`), the JMdict gloss data, or any user
content. Books are imported by the user at runtime (OPFS), and the JMdict dictionary is
downloaded on demand from the 10ten CDN into IndexedDB (see
[`docs/japanese.md`](./japanese.md) and [`docs/storage-pwa-ios.md`](./storage-pwa-ios.md)).

---

## 6. History — why no server

An earlier build had an optional **online sentence-translation** feature that needed
a same-origin `/api/translate` endpoint (a dev Vite middleware locally, a Cloudflare
Worker in production). That feature was **removed** — a static Pages host can't serve
it, and the app's purpose is offline Japanese reading + the on-device dictionary. The
app is now backend-free by design, which keeps the Pages deployment trivially correct
and the whole app usable offline. If you ever reintroduce a network feature, remember
§3: Pages cannot host a same-origin server, so you'd point at a separate origin and
handle CORS there.

---

## 7. Local build & preview

```sh
npm run build      # production build → dist/ (base '/epub/')
npm run preview    # serve dist/ locally
```

`npm run preview` serves the `/epub/`-based build; open the printed URL (it includes
the `/epub/` path). For an iOS install test you still need HTTPS — front `preview`
(or `dev`) with a tunnel (`cloudflared`, `ngrok`); see
[`docs/development.md`](./development.md) §6 and [`docs/storage-pwa-ios.md`](./storage-pwa-ios.md) §7.

---

## 8. Cross-references

- [`docs/development.md`](./development.md) — scripts, the build, the generator
  scripts that use `sharp`, the run/verify loop.
- [`docs/storage-pwa-ios.md`](./storage-pwa-ios.md) — the VitePWA/Workbox setup, the
  `/epub/`-scoped manifest, service worker, and iOS install/eviction notes.
- [`docs/architecture.md`](./architecture.md) — where the build/deploy pieces sit in
  the overall system.
- `.github/workflows/deploy.yml` · `vite.config.ts` — the source of truth for the
  pipeline and the base path.
