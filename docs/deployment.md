# Deployment & CI — GitHub Pages

Tsuzuri ships as a **static** PWA to **GitHub Pages**. There is no backend: EPUB bytes
live in OPFS, structured data and the JMdict dictionary live in IndexedDB, and the
service worker precaches the app shell. Pages only serves the static `dist/` artifact,
so the app has no server-dependent features.

| Fact | Value | Source |
| --- | --- | --- |
| URL | `https://huangwaylon.github.io/epub/` | GitHub Pages project site |
| Trigger | push to `main`, or manual `workflow_dispatch` | `deploy.yml` (`on:`) |
| Host | static (no server code) | GitHub Pages |
| Build base | `/epub/` (prod) · `/` (dev) | `vite.config.ts` (`base`) |
| Node (CI) | 22 | `deploy.yml` (`setup-node`) |
| Node (local) | see [`development.md`](./development.md) | — |

---

## 1. The Actions workflow (`.github/workflows/deploy.yml`)

Two jobs. Permissions: `pages: write`, `id-token: write`. Concurrency group `pages`
with `cancel-in-progress: false`, so an in-progress deploy finishes before the next.

### `build`
1. `actions/checkout` + `actions/setup-node@v4` (`node-version: 22`, `cache: npm`).
2. Install, with the `sharp` workaround (§3) and `env NODE_ENV: development`:
   ```sh
   npm pkg delete devDependencies.sharp   # strip the local-only native dep
   rm -f package-lock.json                # resolve fresh so its optional deps aren't processed
   npm install --include=dev --no-audit --no-fund   # --include=dev forces vite/svelte under NODE_ENV=production
   ```
3. **Verify `vite` installed** — guard step that fails loudly instead of an opaque
   `vite: not found` later.
4. `npm run build` → `dist/`.
5. `actions/configure-pages@v5` with `enablement: true` — flips the repo's Pages
   source to "GitHub Actions" automatically, so a fresh repo deploys without manual
   settings changes.
6. `actions/upload-pages-artifact@v3` (`path: dist`).

### `deploy`
`needs: build`; runs `actions/deploy-pages@v4` in the `github-pages` environment.

---

## 2. The `/epub/` base path

`vite.config.ts` sets the base per command:

```ts
const base = command === 'build' ? '/epub/' : '/'
```

The Pages project site is served from `https://<user>.github.io/epub/`, so the
production build must be rooted at `/epub/`; dev stays at `/`. The base threads
through the PWA config:

| Derived from `base` | Effect |
| --- | --- |
| `manifest.start_url` / `manifest.scope` | installed PWA opens and is scoped under `/epub/` |
| Workbox `navigateFallback` (`` `${base}index.html` ``) | SPA offline fallback resolves under `/epub/` |
| Asset URLs (`/assets/*`, icons) | rewritten under `/epub/` by Vite |

**Gotcha:** never hard-code a **root-relative** path (`/foo`) for an asset or fetch
that must work in production — at the Pages origin a leading `/` escapes the `/epub/`
scope and resolves at the origin root, outside the app. Use Vite-`import`ed assets,
`public/` references, or `import.meta.env.BASE_URL`.

`index.html` is the one place that writes root-relative hrefs (`/favicon.svg`,
`/icons/apple-touch-icon-180.png`) — fine, because Vite rewrites HTML asset URLs under
`base` at build time. Manifest icon `src` values are written relative
(`icons/icon-192.png`), so they also resolve under `/epub/`.

---

## 3. The `sharp` CI gotcha

`sharp` is a **local-only** `devDependency`, used only by the generator scripts
(`scripts/gen-icons.mjs`, `scripts/make-test-epub.mjs`); `vite build` never uses it.
Installing it in CI crashes npm (`Exit handler never called!`) on its ~27 native
`@img/*` platform packages — under both `npm ci` and `npm install`. So `deploy.yml`
strips it and resolves fresh (see §1 step 2).

Implications:
- **Don't rely on `sharp` at build time.** Regenerate icons / the test EPUB locally
  and commit the outputs.
- **Don't assume `package-lock.json` drives the CI install** — CI removes it. The
  lockfile is still committed for reproducible *local* installs.
- A new dependency with heavy native/optional deps may hit the same failure; handle
  it the same way.

---

## 4. What ships

The `dist/` artifact contains the app shell (JS/CSS/HTML), the PWA manifest, the
service worker, the icons, **and the kuromoji IPADIC dictionary**
(`kuromoji/dict/*.dat.gz`, ~19 MB).

Workbox precaches `**/*.{js,css,html,svg,png,woff2}`, capped at 6 MB/file, with
`globIgnores` excluding PDF.js (`**/pdfjs/**`), kuromoji (`**/kuromoji/**`), and
unreachable foliate format loaders (`mobi-*`, `fb2-*`, `comic-book-*`, `tts-*`,
`search-*`). So the dict is **not** in the install precache; it is **runtime-cached**
(CacheFirst, `maxEntries: 16`, no age expiry — immutable build-versioned data) on
first dictionary download / tap-to-define, so segmentation works offline thereafter.
Details: [`storage-pwa-ios.md`](./storage-pwa-ios.md) §6.

The dict is staged into `public/kuromoji/dict/` from `node_modules` by
`scripts/copy-kuromoji-dict.mjs`, run automatically via the `predev` / `prebuild` npm
scripts (so CI's `npm run build` produces it). `public/kuromoji/` is gitignored, not
committed. See [`japanese.md`](./japanese.md) §4.

**Not shipped:** the test EPUB (`test-books/`), the JMdict gloss data, or any user
content. Books are imported at runtime (OPFS); JMdict is downloaded on demand into
IndexedDB. See [`japanese.md`](./japanese.md) and [`storage-pwa-ios.md`](./storage-pwa-ios.md).

---

## 5. Why no server

The app is backend-free by design — its only language feature is the on-device
offline dictionary. A static Pages host cannot serve a same-origin backend, which
keeps the deployment trivially correct and the app fully usable offline. If you ever
add a network feature, remember §2: Pages can't host a same-origin server, so you'd
point at a separate origin and handle CORS there.

---

## 6. Local build & preview

```sh
npm run build      # production build → dist/ (base '/epub/')
npm run preview    # serve dist/ locally
```

`npm run preview` serves the `/epub/`-based build; open the printed URL (it includes
the `/epub/` path). An iOS install test needs HTTPS — front `preview` (or `dev`) with
a tunnel (`cloudflared`, `ngrok`); see [`development.md`](./development.md) §6 and
[`storage-pwa-ios.md`](./storage-pwa-ios.md) §7.

---

## 7. Cross-references

- [`development.md`](./development.md) — scripts, build, the `sharp` generators, run/verify loop.
- [`storage-pwa-ios.md`](./storage-pwa-ios.md) — VitePWA/Workbox setup, `/epub/`-scoped manifest, SW, iOS install/eviction.
- [`architecture.md`](./architecture.md) — where build/deploy sits in the system.
- `.github/workflows/deploy.yml` · `vite.config.ts` — source of truth for the pipeline and base path.
