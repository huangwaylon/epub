---
name: tsuzuri-reader
description: >-
  Use when working on the Tsuzuri EPUB reader / foliate-js integration — anything
  touching src/services/reader/*, src/lib/reader/*, or src/vendor/foliate-js.
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
- `ReaderController` (`src/services/reader/controller.ts`) owns the `<foliate-view>` and
  delegates to one helper per concern: `gestures.ts` (swipe/tap, per-document input),
  `turns.ts` (push animation), `highlights.ts` (painting), `english.ts` (translations),
  `styles.ts` (the injected CSS, pure), `timers.ts` (one timeout set). Imports go through
  `services/reader` (`index.ts`).
- `src/lib/reader/Reader.svelte` wires it to the UI through `ReaderCallbacks` (doc §3); the
  dictionary card's state machine is `defineCard.svelte.ts`, chapter lookups are
  `src/services/chapters.ts`.
- Content renders in a sandboxed iframe inside a **closed** shadow DOM; the only handle is
  the `load` event's `doc` (DEV: `window.__tsuzuri`).
- The page is styled by paginator **attributes** (`applyLayout`, doc §5) and an **injected
  stylesheet** (`appearanceCSS` via `renderer.setStyles`, doc §4).

## Rules
- **Vendor code** (`src/vendor/foliate-js/**`) is third-party. Five `TSUZURI PATCH`es exist
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
- Content-document listeners go through `DocumentInput` (one AbortController per document);
  host ones use `#ac`. Timeouts go in the controller's `Timers` (cleared on destroy).
- **English** (`.tsuzuri-en`, [translation.md](../../../docs/translation.md)) is invisible to
  CFIs (patch 5) and to extraction; show / hide goes through `applyAppearance` /
  `setRevealed(en, on, at?)`, which re-anchor the page (doc §4a). Detection is the package
  meta at open (no spine scan).
- Services stay framework-free: no Svelte imports under `src/services/reader/` (the one
  existing exception elsewhere is `jp/dictdb.ts` → `stores/dict.svelte`).

## Common tasks
| Task | Where |
| --- | --- |
| Add a reader setting | `types.ts` → `ReaderSettings.svelte` (`updateSettings` + `onchange(kind)`) → `appearanceCSS` / `applyLayout` (doc §12) |
| Margins / measure / spread | `applyLayout`; mind the vertical axis swap (doc §5a) |
| Dead band at the bottom of a vertical page | viewport-derived caps, `#onResize`, `#nudgeLayout` (doc §5a) |
| RTL spread order, calibre `vrtl` books | `#applyPageProgression`, `#applyIntendedWritingMode` (doc §5b–c) |
| Swipe / tap thresholds | constants + `trackGestures` in `gestures.ts` (doc §7) |
| Page-turn animation, end bounce | `PageTurner` in `turns.ts` (doc §6) |
| Highlight or bookmark behaviour | doc §9, §11; `cfi.ts` helpers are unit-tested |
| Popup / toolbar placement | `placeNearWord` / `placeAnchored` in `src/lib/util/anchoredPosition.ts` |
| Keyboard | `onKey` in `Reader.svelte` (doc §8) |
| Dictionary card behaviour | `createDefineCard` in `defineCard.svelte.ts` (doc §8, §11) |

## Verify
1. `npm run check` and `npm test`.
2. Use the **tsuzuri-verify** skill (chrome-devtools, iPad landscape 1194×834): import the
   test EPUB, check vertical RTL pagination, swipe both ways (and the end bounce), tap to
   define (including a column's first/last glyph under the bar band), tap-to-dismiss,
   highlight reopen + Remove, drag-select → Highlight/Copy, scrubber, bookmark ribbon.
   Console: only the foliate sandbox warning.
3. Anything iOS-specific (viewport, column fill, caret seeds) is unverified until tested on
   a device — say so.
