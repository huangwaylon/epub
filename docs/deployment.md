# Deployment & CI — GitHub Pages

Tsuzuri is a static, backend-free PWA served by GitHub Pages at
**https://huangwaylon.github.io/epub/**. Every push to `main` (or a manual
`workflow_dispatch`) builds and deploys it through `.github/workflows/deploy.yml`.

## 1. Workflow (`deploy.yml`)

Permissions `contents: read`, `pages: write`, `id-token: write`. Concurrency group `pages`
with `cancel-in-progress: false`.

**`build`** (ubuntu-latest):
1. `actions/checkout@v4`, `actions/setup-node@v4` (Node 22, `cache: npm`).
2. Install without `sharp` (§3), with `NODE_ENV: development`:
   ```sh
   npm pkg delete devDependencies.sharp
   rm -f package-lock.json
   npm install --include=dev --no-audit --no-fund
   ```
3. Verify `node_modules/.bin/vite` exists (fails with a clear error instead of
   `vite: not found`).
4. `npm run build`. `prebuild` runs `scripts/copy-kuromoji-dict.mjs` first to stage the
   IPADIC dict.
5. `actions/configure-pages@v5` with `enablement: true` (sets the Pages source to GitHub
   Actions if it isn't already).
6. `actions/upload-pages-artifact@v3` (`path: dist`).

**`deploy`**: `needs: build`; `actions/deploy-pages@v4` in the `github-pages` environment.

## 2. The `/epub/` base path

```ts
const base = command === 'build' ? '/epub/' : '/'   // vite.config.ts
```

`manifest.start_url`, `manifest.scope` and Workbox `navigateFallback`
(`${base}index.html`) derive from `base`. Vite rewrites the root-relative hrefs in
`index.html` (`/favicon.svg`, the touch icon, the splash links). Manifest icons are
relative (`icons/…`). In app code, never hard-code a root-relative URL: it escapes
`/epub/` in production. Use imported assets or `import.meta.env.BASE_URL` (as
`jp/ipadic.ts` does for the dict).

## 3. `sharp` is local-only

`sharp` is used only by `scripts/gen-icons.mjs` and `scripts/make-test-epub.mjs`, never by
`vite build`. Installing it in CI crashes npm ("Exit handler never called!") on its native
`@img/*` packages, so CI deletes it and resolves fresh without the lockfile. As a result:
- Regenerate icons, splash screens and the test EPUB locally and commit the outputs
  (`public/icons/`, `public/splash/`, `index.html`).
- CI doesn't install from `package-lock.json`; the lockfile only serves local installs.
- A new dependency with heavy native optional deps may need the same treatment.

## 4. What ships (`dist/`)

- App shell (JS/CSS/HTML), `manifest.webmanifest`, `sw.js` + Workbox runtime,
  `favicon.svg`, `icons/`, `splash/` (36 PNGs, ~320 KB).
- `kuromoji/dict/*.dat.gz` (11 files, ~11.3 MB). It is **not** precached; it is
  runtime-cached in `kuromoji-ipadic-v2` on first use.
- The precache is about 22 entries / ~420 KiB. Precache and runtime cache rules are in
  [storage-pwa-ios.md §5](./storage-pwa-ios.md#5-pwa--viteconfigts-indexhtml-srcmaints).

Not shipped: `test-books/`, JMdict (downloaded on demand into IndexedDB), and user books
(OPFS).

## 5. Local build & preview

```sh
npm run build     # → dist/, base /epub/
npm run preview   # serve dist/; open the printed /epub/ URL
```

Installing on iOS needs HTTPS: front `dev` or `preview` with a tunnel (see
[development.md](./development.md)). A static Pages host can't serve a same-origin backend,
so any future network feature would need a separate origin with CORS.
