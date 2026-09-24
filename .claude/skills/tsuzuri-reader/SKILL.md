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

Read [`docs/reader-engine.md`](../../../docs/reader-engine.md) first — the section for the
area you're changing. This is the procedure.

## Mental model
- `ReaderController` (`src/services/reader.ts`) owns the `<foliate-view>`;
  `src/lib/reader/Reader.svelte` wires it to the UI through `ReaderCallbacks` (doc §3).
- Content renders in a sandboxed iframe inside a **closed** shadow DOM; the only handle is
  the `load` event's `doc` (DEV: `window.__tsuzuri`).
- The page is styled by paginator **attributes** (`applyLayout`, doc §5) and an **injected
  stylesheet** (`appearanceCSS` via `renderer.setStyles`, doc §4).

## Rules
- **Vendor code** (`src/vendor/foliate-js/**`) is third-party. Four `TSUZURI PATCH`es exist
  (doc §1); a new one must be minimal, marked, and added to that table. Never set
  `animated` or restore foliate's touch turn — swipes and the horizontal push are ours.
- **Taps are the hot path.** Never add latency or a guard that can swallow a tap. Keep the
  `isPrimary` guards, `shouldIgnoreUp`'s inside-the-selection rule and swipe-on-move
  (doc §7). Keep the `onTap` order: open card → dismiss; glyph → define (even in the edge
  band); blank band → toggle chrome; else hide chrome (doc §8).
- **Tap geometry** (`extractTextAt`/`resolveGlyph`) belongs to the tsuzuri-japanese skill;
  don't trust caret offsets and never `range.toString()` a word (ruby splices in).
- **Highlights**: every create/remove goes through `addHighlight` / `removeHighlight` in
  `Reader.svelte` (paint first, record deduped on CFI, persisted in the background).
  Seed with `setHighlights` **before** `open()`; sections draw on `create-overlay`,
  chunked and nearest-first (doc §9). Colour is `HIGHLIGHT_HEX` only.
- **Layout** must stay idempotent (`#lastLayout`), write `max-inline-size` last, and use
  `viewportSize()` (doc §5a). A writing-mode change goes through `reopenForWritingMode`.
- Content-document listeners use that document's `#docACs` signal; host ones use `#ac`.
- Services stay framework-free; no Svelte imports in `reader.ts` or `cfi.ts`.

## Common tasks
| Task | Where |
| --- | --- |
| Add a reader setting | `types.ts` → `ReaderSettings.svelte` (`updateSettings` + `onchange(kind)`) → `appearanceCSS` / `applyLayout` (doc §12) |
| Margins / measure / spread | `applyLayout`; mind the vertical axis swap (doc §5a) |
| Dead band at the bottom of a vertical page | viewport-derived caps, `#onResize`, `#nudgeLayout` (doc §5a) |
| RTL spread order, calibre `vrtl` books | `#applyPageProgression`, `#applyIntendedWritingMode` (doc §5b–c) |
| Swipe / tap thresholds | constants + `#trackGestures` (doc §7) |
| Page-turn animation, end bounce | `#turn` / `#slide` / `#bounce` (doc §6) |
| Highlight or bookmark behaviour | doc §9, §11; `cfi.ts` helpers are unit-tested |
| Popup / toolbar placement | `placeNearWord` / `placeAnchored` in `src/lib/util/anchoredPosition.ts` |
| Keyboard | `onKey` in `Reader.svelte` (doc §8) |

## Verify
1. `npm run check` and `npm test`.
2. Use the **tsuzuri-verify** skill (chrome-devtools, iPad landscape 1194×834): import the
   test EPUB, check vertical RTL pagination, swipe both ways (and the end bounce), tap to
   define (including a column's first/last glyph under the bar band), tap-to-dismiss,
   highlight reopen + Remove, drag-select → Highlight/Copy, scrubber, bookmark ribbon.
   Console: only the foliate sandbox warning.
3. Anything iOS-specific (viewport, column fill, caret seeds) is unverified until tested on
   a device — say so.
