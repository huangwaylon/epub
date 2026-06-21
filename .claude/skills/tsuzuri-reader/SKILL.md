---
name: tsuzuri-reader
description: >-
  Use when working on the Tsuzuri EPUB reader / foliate-js integration — anything
  touching src/services/reader.ts, src/lib/reader/*, or src/vendor/foliate-js.
  Triggers: changing pagination or the reading-area margins/measure, vertical
  (縦書き) / RTL layout, taps, swipes, or page-turn gestures, text selection, highlights or
  bookmarks (CFI), the dictionary popup positioning, or reader appearance/theme
  injection. Also for "the page doesn't fill", "text is cut off", "highlight won't
  draw", or "the page won't turn on swipe".
---

# Working on the Tsuzuri reader engine

**Read [`docs/reader-engine.md`](../../../docs/reader-engine.md) first** — it documents the
`<foliate-view>` API, the `ReaderController`, the paginator internals, the vertical
column-fill quirk, and extension recipes. This skill is the quick procedure.

## Mental model
- A single **`ReaderController`** (`src/services/reader.ts`) owns the `<foliate-view>`
  custom element. **`src/lib/reader/Reader.svelte`** wires it to the UI (chrome, sheets,
  popups, toolbars) via callbacks (`onRelocate`, `onLoad`, `onTap`, `onTurn`, `onSelection`,
  `onSelectionCleared`, `onShowAnnotation`).
- foliate-js is **vendored** in `src/vendor/foliate-js` (MIT). Content renders inside a
  **closed-shadow-DOM iframe**; you can only reach it via the `load` event's `doc`.
- The page area is styled two ways: **layout attributes** on `renderer`
  (`margin`/`gap`/`max-inline-size`/`max-block-size`/`max-column-count`) set in
  `applyLayout`, and an **injected stylesheet** built by `appearanceCSS` and applied via
  `renderer.setStyles` (theme colours/fonts/line-height — it reads the app's CSS vars
  from the host document so the iframe matches the active theme).

## Rules
- **Pagination is by horizontal swipe; a tap never turns the page.** foliate's own touch
  page-turn is **patched out** (`paginator.js`, search `TSUZURI PATCH`). The shared
  `#trackGestures` state machine (`reader.ts`) drives both gestures from **two** attach
  points: `#attachTaps(doc)` over the content iframe, and `#attachHostGestures()` on the
  `<foliate-view>` host so the **margins** (outside the iframe — previously dead) also
  respond. On `pointerup` (primary pointer only; `pointercancel` aborts; no action if a
  non-empty selection is active; every listener is removed via one `AbortController` on
  destroy): a horizontal drag of ≥ `SWIPE_MIN_DISTANCE` (45px) with `|dx| > |dy|` turns the
  page — `dx < 0` (drag left) → `view.goRight()`, `dx > 0` (drag right) → `view.goLeft()`;
  these **honor `book.dir` (rtl)**, so the swipe turns the correct way in LTR / RTL / 縦書き
  and always animates as a horizontal slide (fired via the `onTurn` callback). Otherwise a
  clean tap (move < 16px `TAP_MOVE_TOLERANCE`, < 400ms `TAP_MAX_MS`) routes through `onTap` →
  `handleTap` in `Reader.svelte`, in order: (1) if a popup / highlight-edit toolbar is open,
  dismiss it and consume the tap; (2) else if the tap's top-window `py` is in the top/bottom
  edge band (`inChromeToggleBand`, ≈ nav-bar height) toggle chrome — a reliable target that
  doesn't fight define; (3) else if the tap lands on an actual glyph (`pointOnGlyph` in
  `extract.ts`, and `info.doc` non-null) and `tapToDefine`, define the word; (4) else toggle
  chrome. Margin/host taps carry **`doc: null`** (nothing to define). There are **no edge
  rails** and no `TapInfo.zone`.
- **Don't edit `src/vendor/foliate-js/**`** unless it's a deliberate, documented patch. There
  are **two**: (1) `view.js` removed pdf.js + the PDF branch (`isPDF` remains as dead code);
  (2) `paginator.js` disables foliate's own touch page-turn (`TSUZURI PATCH`: `#onTouchMove`
  keeps `preventDefault` but drops `scrollBy`; `#onTouchEnd` drops the velocity `snap`) so our
  swipe detector owns pagination. Keep diffs minimal and note them in `docs/reader-engine.md`.
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
  `vw − 2·margin` (fills the available width; only the margin frames it). `max-column-count`
  gives a 2-page spread when `cols = vw > vh && vw >= 820 ? 2 : 1`.
- **Dark mode / page background** → `appearanceCSS` injects `html { background: --paper
  !important; color-scheme: light|dark }` (NOT `transparent`): the content iframe's
  transparent root would otherwise composite over its default *light* canvas, rendering the
  page light even in dark mode. `body` stays transparent so the `html` paper shows through.
- **Tune swipe / tap behavior** → shared `#trackGestures` (controller; `SWIPE_MIN_DISTANCE`,
  `TAP_MOVE_TOLERANCE`, `TAP_MAX_MS`), wired by `#attachTaps` (content) + `#attachHostGestures`
  (margins) + `onTap`/`handleTap` routing in `Reader.svelte` (note the top/bottom
  `inChromeToggleBand` step, and the 60ms defer when highlights exist, so a highlight hit-test
  can cancel the tap action via `onShowAnnotation`). foliate's native touch turn is patched out
  in `paginator.js` (`TSUZURI PATCH`) — re-enabling it would double-turn against our swipe.

## Verify after changes
Run `npm run check`, then use the **tsuzuri-verify** skill (chrome-devtools at
iPad-landscape 1194×834): import the test EPUB, open it, and confirm pagination, taps,
selection→highlight, and (if relevant) the dictionary still work, with a clean console.
