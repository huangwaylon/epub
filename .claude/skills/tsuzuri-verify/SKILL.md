---
name: tsuzuri-verify
description: >-
  Use to run and visually verify the Tsuzuri reader app, especially at iPad
  landscape. Triggers: "run the app", "test/verify this change", "screenshot the
  reader", "does the reader still work", confirming a fix in the real app, or
  preparing to test on a real iPhone/iPad. Covers generating the test EPUB and
  driving the app with the chrome-devtools MCP, plus the on-device (HTTPS + Add to
  Home Screen) path.
---

# Running & verifying Tsuzuri

The app is primarily used on **iPad in landscape**, so verify there (1194×834).
Depth: [`docs/development.md`](../../../docs/development.md).

## 1. Start the dev server
```sh
npm run dev    # prints a Local + LAN URL; the LAN URL is for on-device testing
```
If you changed `vite.config.ts` or `vite-plugins/*`, restart the server (Vite won't
hot-reload config reliably here).

## 2. Make sure there's a test book
```sh
node scripts/make-test-epub.mjs   # → test-books/tsuki-to-neko.epub
```
A vertical 縦書き (rtl) Japanese EPUB with ruby + deliberately conjugated verbs and a
multi-page chapter — ideal for exercising pagination and the dictionary.

## 3. Drive it with the chrome-devtools MCP (iPad landscape)
1. `new_page` → the dev URL; `resize_page` to **1194×834** (iPad 11" landscape). Reload.
2. Dismiss the "new version ready" toast if present.
3. **Import:** `upload_file` targeting the **"Import book"** button (the file input is
   hidden; the tool drives the chooser). Wait for the cover to appear on the shelf.
4. **Open** the book (click its card).
5. **Tap gestures + dictionary:** open **Settings → Download** (JMdict, ~seconds) once.
   Then in the reader:
   - Tap a **Japanese word** (it must land on an actual glyph) → the dictionary popup
     defines it. Test a conjugated word, e.g. tap the start of 美しかった → expect
     **美しい / past / い-adjective**.
   - Tap **blank space in the centre** → toggles the top/bottom chrome bars.
   - Tap the **left or right edge** (outer ~14% rail) **or swipe** → turns the page
     (vertical RTL: correct direction via foliate goLeft/goRight).
   - With the popup open, **any tap dismisses it** (and is consumed); a real page turn also
     auto-closes it.
6. **Selection features:** `drag` from one character to another to select text → the
   toolbar appears → tap a colour (highlight draws + persists) or **Translate**
   (opens the translation sheet; dev proxy returns `google (dev)`).
7. **Bookmark:** toggle the bottom-bar bookmark; check it lists under the Notes panel.
8. **Console:** `list_console_messages` should be clean except the benign foliate iframe
   **"allow-scripts and allow-same-origin" sandbox** warning.

`take_screenshot` after each step. Snapshots return iframe text nodes with uids you can
`click`/`drag`.

## What "good" looks like at iPad landscape
- Vertical text in **balanced** left/right margins (not jammed to one edge), RTL page
  turns (for a vertical RTL book, tapping the **left** edge rail advances / next;
  tapping the **right** goes back / prev — or swipe), furigana above kanji.
- Page turns animate as a **horizontal slide** (left/right, like Books on iPad), not a
  vertical up/down slide. The moving page casts a soft shadow over the paper. foliate's
  `animated` attribute is intentionally **off**; `ReaderController` does the slide
  (reader-engine.md §8a).
- Sheets (Display/TOC/Notes/Translation) render as **centered modal cards**, not
  full-width bottom sheets.
- Shelf content is centered (max ~1120px) with larger covers.
- The vertical column should **fill the page box on first paint** — `applyLayout` derives the
  box from the viewport (verified desktop Chrome at 1194×834: #container ≈1068×708). Bottom
  whitespace / a dead band here is now a **regression to flag** (the old column-fill quirk —
  see docs/reader-engine.md §11), not an accepted caveat.
- Progress at the very start of a freshly opened book reflects the true position (a brand-new
  open should not jump to a mid-book %). On the tiny 2-page test EPUB, page 1 reads ~39%
  because foliate's fraction is an overall-book trailing-edge value; a real long book shows
  ~0–1% there — not a bug.

## 4. Gates
```sh
npm run check    # svelte-check + tsc — must be clean
npm test         # vitest (deinflection)
npm run build    # production build sanity
```

## 5. On a real iPhone/iPad
Service workers + install need **HTTPS**: front the dev/preview server with a tunnel
(`cloudflared tunnel`/`ngrok`) or `npm run build && npm run preview` behind HTTPS, open in
iOS Safari, **Share → Add to Home Screen**, launch the icon. Re-check the items flagged
"unverified on iOS" in docs/reader-engine.md and docs/storage-pwa-ios.md
(vertical column fill, the tap-gesture model — word-define vs. edge-rail turn vs.
chrome-toggle, `caretRangeFromPoint` in vertical iframes, OPFS write, storage
durability across relaunch).
