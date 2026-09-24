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

# Verifying Tsuzuri

Depth: [`docs/development.md`](../../../docs/development.md) §5–7.

1. **Gates:** `npm run check` and `npm test` must be clean; `npm run build` for build changes.
2. **Serve:** `npm run dev` (restart after editing `vite.config.ts`). If
   `test-books/tsuki-to-neko.epub` is missing: `node scripts/make-test-epub.mjs`.
3. **Browser** (chrome-devtools MCP, load via ToolSearch): `new_page` → `resize_page`
   **1194×834** → dev URL. Dismiss any update toast. `upload_file` on **Import book**, open the
   book, download the dictionary (shelf Settings or the popup's Download).
4. **Check** (`take_screenshot` as you go; snapshots expose iframe text nodes with uids):
   - 縦書き RTL columns fill the page box (no bottom dead band), furigana beside kanji.
   - Horizontal swipe turns the page with a **short horizontal push** (dragging right advances
     an rtl book); a swipe at the first/last page bounces.
   - Tap a glyph → definition card **and** a yellow highlight; conjugations deinflect (美しかった →
     美しい). The first/last glyph of a column (under the nav-bar band) must define too.
   - **With a card open, any tap only dismisses it** — no new lookup, no chrome toggle.
   - Blank tap in the top/bottom band toggles the bars; elsewhere hides visible bars; a
     blank-centre tap with nothing open does nothing. Taps never turn the page.
   - Tap a highlighted word → its definition with **Remove highlight**, word without furigana
     (決けっ心 is the regression).
   - Drag-select → toolbar → Highlight / Copy. Drag the bottom progress bar to scrub (a plain tap
     must not seek). Bookmark → listed in **Highlights & Bookmarks**.
   - Sheets (TOC, Highlights & Bookmarks, Settings) are centred cards; Display (Aa) is a glass
     popover under its button. Shelf content is centred (max 1120px).
5. **Console:** `list_console_messages` — only the foliate iframe `allow-scripts and
   allow-same-origin` sandbox warning is acceptable.
6. **Kill the dev server** when done.

Synthetic gestures inside the book: the content lives in a closed shadow root. In DEV use
`window.__tsuzuri.doc` (or a snapshot uid's `ownerDocument`) and dispatch `PointerEvent`s with
`isPrimary: true` at iframe-local coordinates.

## On a real iPhone/iPad

Service workers and Add to Home Screen need HTTPS: tunnel `npm run dev` (`cloudflared tunnel`,
`ngrok`) or `npm run build && npm run preview` (open `/epub/`), or use the deployed site. Safari →
Share → **Add to Home Screen**, launch the icon, then re-check the items CLAUDE.md marks as
unconfirmed on iOS (landscape column fill, `--app-height`/`--doc-height` cold launch, tap
accuracy in vertical text, storage durability across relaunch).
