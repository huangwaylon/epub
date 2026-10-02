# 綴 Tsuzuri — Japanese EPUB reader

**Live:** https://huangwaylon.github.io/epub/

A paginated EPUB reader for **Japanese books**, built as an installable iOS PWA (Safari →
Add to Home Screen, iOS 26+, iPhone and iPad). Books are stored on-device and read offline.
Fully client-side; no backend.

## Features
- 📖 Paginated reading via **foliate-js**, honouring each book's writing mode (縦書き /
  横書き) and page-progression direction, with a manual 縦/横 toggle.
- 👆 A horizontal swipe turns the page in every writing mode; a tap defines a word or
  toggles the chrome.
- 🇯🇵 **Tap-to-define**, 10ten-style: tap any character of a word and the whole word is
  looked up offline. **kuromoji** (IPADIC) finds word boundaries; JMdict
  (`@birchill/jpdict-idb`) and 10ten's deinflection supply the entry (reading, pitch accent,
  part of speech, conjugation). Furigana never enters the lookup.
- 🖍 **Highlights & bookmarks**, CFI-anchored so they survive reflow; looked-up words are
  highlighted yellow automatically.
- 🇬🇧 **English alongside the Japanese**: bundled books carry a paragraph-aligned
  translation. Show all of it on the page, or hide it and read one passage at a time in the
  definition card (Show translation).
- 📚 **Included books**: six Japanese novels as optional downloads
  ([docs/translation.md](docs/translation.md)).
- 🎨 Light / Sepia / Dark themes, typeface, size, spacing and margins.

## Develop
```sh
npm install
npm run dev        # http://localhost:5173 (also on the LAN for device testing)
npm run check      # svelte-check + tsc
npm test           # vitest
npm run build      # production build -> dist/ (base /epub/)
```
`node scripts/make-test-epub.mjs` regenerates `test-books/tsuki-to-neko.epub` (vertical
Japanese, ruby, conjugated verbs). Bundled books: `npm run books:build`
([docs/translation.md](docs/translation.md)). Testing on an iPhone/iPad needs HTTPS for
install and offline: [docs/development.md](docs/development.md).

Pushing to `main` deploys to GitHub Pages ([docs/deployment.md](docs/deployment.md)).
Architecture and subsystem docs: [docs/architecture.md](docs/architecture.md).

## Project layout
```
books/            bundled books: original EPUB, English units, glossary per book
scripts/          books/ (build pipeline), e2e/ (browser checks), generators
public/books/     built bundled books + catalog.json (downloaded on request)
src/
  lib/            Svelte UI (reader/, library/, components/)
  stores/         Svelte 5 rune stores
  services/       framework-agnostic logic: reader/, jp/, storage/, library, catalog, translation
  vendor/foliate-js   pinned MIT rendering engine
```

## Stack and licensing
Svelte 5 + TypeScript + Vite, `vite-plugin-pwa` (Workbox). Rendering by
[foliate-js](https://github.com/johnfactotum/foliate-js) (MIT, vendored). Dictionary tooling
from the [10ten](https://github.com/birchill/10ten-ja-reader) ecosystem; segmentation by
[kuromoji](https://github.com/sglkc/kuromoji.js) (Apache-2.0).

`src/services/jp/deinflect.ts` is vendored from the 10ten Japanese Reader and is
**GPL-3.0-or-later** (`src/services/jp/LICENSE-10ten`), so distributing this app means
distributing it under GPL-3.0; shipping under another licence means reimplementing the
deinflection rules. JMdict data is CC BY-SA.
