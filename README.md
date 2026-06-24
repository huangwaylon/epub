# 綴 Tsuzuri — Japanese EPUB reader

**Live:** https://huangwaylon.github.io/epub/

A clean, paginated EPUB reader built as an **installable iOS PWA** (Add to Home
Screen, Safari, iOS 26+, iPhone & iPad), optimised for **Japanese books**. Books
are stored on-device and read fully offline, paginated like Apple Books, with
**vertical-writing (縦書き)** support, honouring each book's writing mode and
page-progression direction.

The defining feature is integrated **10ten-style Japanese parsing**: tap a word →
an instant offline dictionary entry (reading, pitch accent, part of speech,
deinflection). Page turns are by **horizontal swipe** (always horizontal, even
for vertical 縦書き / right-to-left books); a tap defines a word or toggles the
chrome. Plus highlights and bookmarks, all anchored by EPUB CFI so they survive
reflow. The app is fully client-side — no backend.

## Features
- 📖 Paginated reflowable reading via **foliate-js** (CSS multi-column), honouring
  each book's writing mode & page-progression direction, with a manual 縦/横 toggle.
- 👆 **Swipe to turn pages** — a horizontal swipe always turns the page (and always
  in the right direction for LTR, RTL, and vertical 縦書き books); the turn animates
  as a horizontal slide. A tap defines a tapped word or toggles the chrome.
- 🇯🇵 **Tap-to-define** — tap any character of a word and the whole word is looked up.
  **kuromoji** (MeCab-style IPADIC) segments the sentence to find word boundaries, then
  offline JMdict (`@birchill/jpdict-idb`) + 10ten's deinflection engine supply the entry;
  ruby/furigana is skipped from the lookup.
- 🖍 **Highlights & bookmarks** — CFI-anchored so they survive reflow; a notes panel
  lists them. Highlights are a single yellow (tap-to-define auto-highlights the word).
- 🎨 Light / Sepia / Dark themes, adjustable font, size, spacing, margins.
- 📲 Installable PWA with an offline app shell; books in OPFS, data in IndexedDB.

## Stack
Svelte 5 + TypeScript + Vite, `vite-plugin-pwa` (Workbox). Rendering by
[foliate-js](https://github.com/johnfactotum/foliate-js) (MIT, vendored in
`src/vendor/foliate-js`). Dictionary tooling from the
[10ten](https://github.com/birchill/10ten-ja-reader) ecosystem; word segmentation by
[kuromoji](https://github.com/sglkc/kuromoji.js) (MeCab/IPADIC, Apache-2.0). Fully
client-side — no backend.

## Develop
```sh
npm install
npm run dev        # http://localhost:5173  (also exposed on the LAN for device testing)
npm run check      # svelte-check + tsc
npm test           # vitest (deinflection unit tests)
npm run build      # production build -> dist/
```
The dev server is served from `/`; the production build uses the `/epub/` base
(GitHub Pages project site). See [docs/deployment.md](docs/deployment.md).

### Test assets
`node scripts/make-test-epub.mjs` regenerates `test-books/tsuki-to-neko.epub`, a
small vertical-writing Japanese EPUB (ruby + conjugated verbs) for exercising the
reader and dictionary. `node scripts/gen-icons.mjs` regenerates the PWA icons.

## Testing on an iPhone/iPad
1. `npm run dev` and note the LAN URL (e.g. `http://192.168.x.x:5173`). iOS Safari
   needs **HTTPS** for service workers / install — front it with a tunnel
   (`cloudflared tunnel`, `ngrok`) or run `npm run build && npm run preview` behind HTTPS.
2. Open in Safari → Share → **Add to Home Screen** → launch the icon.
3. Import an EPUB, download the dictionary (Settings), and read.

## Deploy
Pushing to `main` builds and publishes to **GitHub Pages** at
https://huangwaylon.github.io/epub/ via `.github/workflows/deploy.yml`. The
production build base is `/epub/` (`vite.config.ts`); the dev server stays at `/`.
Full CI / base-path details in [docs/deployment.md](docs/deployment.md).

## Project layout
```
src/
  lib/            Svelte UI (reader/, library/, components/)
  services/       framework-agnostic logic
    storage/      OPFS blobs + IndexedDB (idb)
    jp/           dictionary db, lookup, deinflect (vendored GPL), ruby-aware extract
    reader.ts     foliate-view controller (pagination, taps, selection, highlights)
    library.ts    import / list / delete
  stores/         Svelte 5 rune stores (settings, library, annotations, dict, nav)
  vendor/foliate-js   pinned MIT rendering engine
```

## Licensing note
`src/services/jp/deinflect.ts` is vendored from the 10ten Japanese Reader and is
**GPL-3.0-or-later** (see `src/services/jp/LICENSE-10ten`). Distributing this app
therefore means distributing it under GPL-3.0. Fine for personal use; to ship
under another licence, reimplement the deinflection rules. JMdict data is CC BY-SA.
