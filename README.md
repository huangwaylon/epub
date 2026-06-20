# 綴 Tsuzuri — Japanese EPUB reader

A clean, paginated EPUB reader built as an **installable iOS PWA** (Add to Home
Screen, Safari, iOS 26+, iPhone & iPad), optimised for **Japanese books**. Books
are stored on-device and read fully offline, paginated like Apple Books, with
**vertical-writing (縦書き)** support and right-to-left page turns.

The defining feature is integrated **10ten-style Japanese parsing**: tap a word →
an instant offline dictionary entry (reading, pitch accent, part of speech,
deinflection). Select a sentence → cloud machine translation. Plus highlights and
bookmarks, all anchored by EPUB CFI so they survive reflow.

## Features
- 📖 Paginated reflowable reading via **foliate-js** (CSS multi-column), honouring
  each book's writing mode & page-progression direction, with a manual 縦/横 toggle.
- 🇯🇵 **Tap-to-define** — offline JMdict lookup (`@birchill/jpdict-idb`) with
  10ten's deinflection engine; ruby/furigana is skipped from the lookup window.
- 🌐 **Sentence translation** via a tiny proxy (DeepL in prod, Google in dev),
  cached in IndexedDB for offline reuse.
- 🖍 **Highlights & bookmarks** (CFI-anchored, four colours, notes panel).
- 🎨 Light / Sepia / Dark themes, adjustable font, size, spacing, margins.
- 📲 Installable PWA with an offline app shell; books in OPFS, data in IndexedDB.

## Stack
Svelte 5 + TypeScript + Vite, `vite-plugin-pwa` (Workbox). Rendering by
[foliate-js](https://github.com/johnfactotum/foliate-js) (MIT, vendored in
`src/vendor/foliate-js`). Dictionary tooling from the
[10ten](https://github.com/birchill/10ten-ja-reader) ecosystem.

## Develop
```sh
npm install
npm run dev        # http://localhost:5173  (also exposed on the LAN for device testing)
npm run check      # svelte-check + tsc
npm test           # vitest (deinflection unit tests)
npm run build      # production build -> dist/
```
A dev-only `/api/translate` middleware (`vite-plugins/dev-translate.ts`) lets the
translate flow work locally without deploying the proxy.

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

## Translation proxy (production)
Browsers can't call DeepL/Google directly (CORS + key exposure). Deploy the
Cloudflare Worker in [`proxy/`](./proxy/README.md) and serve it at
`/api/translate` (or change `TRANSLATE_ENDPOINT` in `src/services/translate.ts`).

## Project layout
```
src/
  lib/            Svelte UI (reader/, library/, components/)
  services/       framework-agnostic logic
    storage/      OPFS blobs + IndexedDB (idb)
    jp/           dictionary db, lookup, deinflect (vendored GPL), ruby-aware extract
    reader.ts     foliate-view controller (pagination, taps, selection, highlights)
    library.ts    import / list / delete
    translate.ts  sentence translation client + cache
  stores/         Svelte 5 rune stores (settings, library, annotations, dict, nav)
  vendor/foliate-js   pinned MIT rendering engine
proxy/            Cloudflare Worker translation proxy (DeepL)
```

## Licensing note
`src/services/jp/deinflect.ts` is vendored from the 10ten Japanese Reader and is
**GPL-3.0-or-later** (see `src/services/jp/LICENSE-10ten`). Distributing this app
therefore means distributing it under GPL-3.0. Fine for personal use; to ship
under another licence, reimplement the deinflection rules. JMdict data is CC BY-SA.
