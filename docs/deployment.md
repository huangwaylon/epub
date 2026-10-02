# Deployment & CI — GitHub Pages

Tsuzuri is a static, backend-free PWA served by GitHub Pages at
**https://huangwaylon.github.io/epub/**. Every push to `main` (or a manual
`workflow_dispatch`) builds and deploys it through `.github/workflows/deploy.yml`.

## 1. Workflow (`deploy.yml`)

Permissions `contents: read`, `pages: write`, `id-token: write`. Concurrency group `pages`
with `cancel-in-progress: false`.

**`build`** (ubuntu-latest):
1. `actions/checkout@v4`, `actions/setup-node@v4` (Node 24, `cache: npm`). Node 24 ships npm 11;
   npm 10's fresh resolve crashes on this tree (`Cannot read properties of null (reading 'edgesOut')`).
2. Install without `sharp` (§3), with `NODE_ENV: development`:
   ```sh
   npm pkg delete devDependencies.sharp
   rm -f package-lock.json
   npm install --include=dev --no-audit --no-fund
   ```
3. Verify `node_modules/.bin/vite` exists (a clear error instead of `vite: not found`).
4. `npm run build` (`prebuild` stages the IPADIC dict).
5. `actions/configure-pages@v5` with `enablement: true` (sets the Pages source to GitHub
   Actions if needed).
6. `actions/upload-pages-artifact@v3` (`path: dist`).

**`deploy`**: `needs: build`; `actions/deploy-pages@v4` in the `github-pages` environment.

## 2. The `/epub/` base path

```ts
const base = command === 'build' || isPreview ? '/epub/' : '/'   // vite.config.ts
```

(`vite preview` runs as command `serve`, hence `isPreview`.)

`manifest.start_url`, `manifest.scope` and Workbox `navigateFallback`
(`${base}index.html`) derive from `base`. Vite rewrites the root-relative hrefs in
`index.html` (`/favicon.svg`, the touch icon, the splash links). Manifest icons are
relative (`icons/…`). In app code, never hard-code a root-relative URL: it escapes
`/epub/` in production. Use imported assets or `import.meta.env.BASE_URL` (as
`jp/ipadic.ts` does for the dict).

## 3. `sharp` is local-only

`sharp` is used only by `scripts/gen-icons.mjs`, `scripts/make-test-epub.mjs` and
`scripts/books/build.mjs`, never by `vite build`. Installing it in CI crashes npm ("Exit handler never called!") on its native
`@img/*` packages, so CI deletes it and resolves fresh without the lockfile. As a result:
- Regenerate icons, splash screens, the bundled books and the test EPUB locally and commit the outputs
  (`public/icons/`, `public/splash/`, `public/books/`, `test-books/`, `index.html`).
- CI doesn't install from `package-lock.json`; the lockfile only serves local installs. Keep
  its `resolved` URLs on `registry.npmjs.org` (npm substitutes the configured registry at
  install time).
- A new dependency with heavy native optional deps may need the same treatment.

## 4. What ships (`dist/`)

- App shell (JS/CSS/HTML), `manifest.webmanifest`, `sw.js` + Workbox runtime,
  `favicon.svg`, `icons/`, `splash/` (80 PNGs, ~660 KB).
- `books/`: `catalog.json` + 6 cover `.webp`s (precached, ~170 KB) and the bundled
  `.epub`s (~4 MB; **not** precached, fetched `NetworkOnly` when the user downloads one).
- `kuromoji/dict/*.dat.gz` (11 files, ~11.3 MB). It is **not** precached; it is
  runtime-cached in `kuromoji-ipadic-v2` on first use.
- The precache is 29 entries / ~610 KiB. Precache and runtime cache rules are in
  [storage-pwa-ios.md §5](./storage-pwa-ios.md#5-pwa--viteconfigts-indexhtml-srcmaints).

Not shipped: `test-books/`, JMdict (downloaded on demand into IndexedDB), and user books
(OPFS).

## 5. Local build & preview

`npm run build && npm run preview`, then open the printed `/epub/` URL. Installing on iOS
needs HTTPS ([development.md §7](./development.md#7-on-device-iphone--ipad)). A static Pages
host can't serve a same-origin backend, so a future network feature needs a separate origin
with CORS.
