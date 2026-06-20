---
name: tsuzuri-reader
description: >-
  Use when working on the Tsuzuri EPUB reader / foliate-js integration — anything
  touching src/services/reader.ts, src/lib/reader/*, or src/vendor/foliate-js.
  Triggers: changing pagination or the reading-area margins/measure, vertical
  (縦書き) / RTL layout, tap zones or gestures, text selection, highlights or
  bookmarks (CFI), the dictionary popup positioning, or reader appearance/theme
  injection. Also for "the page doesn't fill", "text is cut off", "highlight won't
  draw", or "tap turns the page when it shouldn't".
---

# Working on the Tsuzuri reader engine

**Read [`docs/reader-engine.md`](../../../docs/reader-engine.md) first** — it documents the
`<foliate-view>` API, the `ReaderController`, the paginator internals, the vertical
column-fill quirk, and extension recipes. This skill is the quick procedure.

## Mental model
- A single **`ReaderController`** (`src/services/reader.ts`) owns the `<foliate-view>`
  custom element. **`src/lib/reader/Reader.svelte`** wires it to the UI (chrome, sheets,
  popups, toolbars) via callbacks (`onRelocate`, `onLoad`, `onTap`, `onSelection`,
  `onSelectionCleared`, `onShowAnnotation`).
- foliate-js is **vendored** in `src/vendor/foliate-js` (MIT). Content renders inside a
  **closed-shadow-DOM iframe**; you can only reach it via the `load` event's `doc`.
- The page area is styled two ways: **layout attributes** on `renderer`
  (`margin`/`gap`/`max-inline-size`/`max-block-size`/`max-column-count`) set in
  `applyLayout`, and an **injected stylesheet** built by `appearanceCSS` and applied via
  `renderer.setStyles` (theme colours/fonts/line-height — it reads the app's CSS vars
  from the host document so the iframe matches the active theme).

## Rules
- **Do not add page-swipe handling** — the paginator (`paginator.js`) owns touch swipe +
  snap. Taps are detected by `#attachTaps` (move tolerance 16px, max 400ms, primary pointer
  only, no active selection; `pointercancel` aborts the tap, and every per-doc listener is
  removed via one `AbortController` on destroy). The tap is routed by **zone**: a left/right
  **edge rail** (`EDGE_RAIL_FRACTION` 0.14 of the page width, clamped 56px–22%) turns the
  page via `view.goLeft()/goRight()`, which **honor `book.dir` (rtl)**; the wide centre
  defines a word or toggles chrome. The `onTap` → `handleTap` order in `Reader.svelte` is:
  (1) if a popup/highlight-edit toolbar is open, dismiss it and consume the tap; (2) edge
  rail → page turn; (3) centre → `tryDefine` (only when the tap lands on an actual glyph —
  see `pointOnGlyph` in `extract.ts`), else toggle chrome.
- **Don't edit `src/vendor/foliate-js/**`** unless it's a deliberate, documented patch
  (the only existing one removed pdf.js + the PDF branch in `view.js`). Keep diffs minimal
  and note them in `docs/reader-engine.md`.
- Highlights are CFI-anchored: `cfiForSelection(doc, range)` (uses the `#docIndex`
  WeakMap + `view.getCFI`) → persist via the `annotations` store → draw via
  `addHighlight(cfi, hex)`. `#highlightColors` is the source of truth; `create-overlay`
  re-applies them when a section loads. Colours come from `HIGHLIGHT_HEX` in
  `src/services/types.ts` (NOT the `--hl-*` CSS vars).
- If the reader shows dead space at the bottom of a vertical page, that's the old
  **column-fill quirk** — `applyLayout` now derives the vertical page-box caps from the
  viewport so the box fills on first paint (verified desktop Chrome); see
  `#nudgeLayout()` and docs/reader-engine.md §11. On desktop Chrome a dead band would now
  be a regression; on real iOS the fill is still unverified, so check there before assuming.

## Common tasks
- **Add a reader setting** → field in `ReaderSettings`/`DEFAULT_SETTINGS`
  (`src/services/types.ts`) → control in `src/lib/reader/ReaderSettings.svelte` (call
  `updateSettings` + `onchange('appearance'|'layout'|'writingmode')`) → consume in
  `appearanceCSS`/`applyLayout` (`reader.ts`). Persists automatically via the settings store.
- **Change reading margins/measure** → `applyLayout` in `reader.ts`. Horizontal uses fixed
  caps (`max-inline-size: 640px` line length, `max-block-size: 880px` page height). Vertical
  derives both from the live viewport so the column fills: `max-inline-size` (the column
  *height*) = `max(320, vh − 2·margin)` and `max-block-size` (the across-page *width*) =
  `min(vw − 2·margin, 560·cols)`. `max-column-count` gives a 2-page spread when
  `cols = vw > vh && vw >= 820 ? 2 : 1`.
- **Add a gesture / change tap zones** → tap detection + zone classification in `#attachTaps`
  (controller; `EDGE_RAIL_FRACTION` sets the rail width) + `onTap`/`handleTap` routing in
  `Reader.svelte` (note the 60ms defer when highlights exist, so a highlight hit-test can
  cancel the tap action via `onShowAnnotation`).

## Verify after changes
Run `npm run check`, then use the **tsuzuri-verify** skill (chrome-devtools at
iPad-landscape 1194×834): import the test EPUB, open it, and confirm pagination, taps,
selection→highlight, and (if relevant) the dictionary still work, with a clean console.
