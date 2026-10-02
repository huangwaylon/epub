# Reader Engine

The bridge between vendored **foliate-js** and the reading experience: page turns, taps,
selection, highlights, 縦書き layout, English. Read before touching `src/vendor/foliate-js/`,
`src/services/reader/` or `src/lib/reader/`. References are by symbol, not line number.

| File | Role |
| --- | --- |
| `services/reader/controller.ts` | `ReaderController`: wraps `<foliate-view>`; open / re-open, layout, appearance, event wiring (§2–5) |
| `services/reader/gestures.ts` | `trackGestures` (swipe / tap state machine), `DocumentInput` (per-document gestures, keys, selection) (§7, §10) |
| `services/reader/turns.ts` | `PageTurner`: push animation, end bounce, coalescing (§6) |
| `services/reader/highlights.ts` | `HighlightPainter` (render set, chunked sweeps), `drawHighlight` (§9) |
| `services/reader/english.ts` | `EnglishState`: detection, show-all, `keepPage` (§4a) |
| `services/reader/styles.ts` | `appearanceCSS(settings, tokens)` (pure), `readThemeTokens`, `reducedMotion` (§4) |
| `services/reader/timers.ts` | `Timers`: the controller's one keyed timeout set |
| `services/reader/index.ts`, `types.ts` | Public API (`services/reader`) and shared types |
| `lib/reader/Reader.svelte` | Reader screen; wires the controller to the UI (§8, §11) |
| `lib/reader/defineCard.svelte.ts` | `createDefineCard`: the dictionary card's state machine (§8, §11) |
| `services/chapters.ts`, `services/cfi.ts` | Pure TOC helpers (`buildChapterIndex`, `chapterAt`, `chapterOrder`); CFI helpers (`nearestFirst`, `cfiWithinPage`) |
| `services/translation.ts` | `.tsuzuri-en` DOM helpers (`unitEnglish`, `clampOutOfEnglish`, `selectionText`, `rectsOutsideEnglish`, `packageHasEnglish`, …) (§4a, §10) |
| `lib/util/chromeBand.ts`, `lib/util/anchoredPosition.ts` | Edge-band test (§8); card / toolbar placement (§11) |
| `vendor/foliate-js/` | `view.js` (`<foliate-view>`), `paginator.js`, `overlayer.js` (SVG highlights), `epubcfi.js` |

---

## 1. foliate-js and the local patches

foliate-js (MIT) is pure ESM, paginates reflowable EPUB with CSS multi-column, handles
vertical writing and RTL, and works in DOM `Range`s + CFIs. Upstream is unstable, so a pinned
copy is vendored. Treat it as third-party: app behaviour belongs in `ReaderController` /
`Reader.svelte`. A patch must be minimal, commented `// TSUZURI PATCH (n): …`, and listed here.

| # | File | Patch |
| --- | --- | --- |
| 1 | `view.js` | PDF.js and the PDF branch of `makeBook` removed (`vendor/` holds only `fflate.js`, `zip.js`; `isPDF` is dead code). Not marked in the source. |
| 2 | `paginator.js` `#onTouchMove` / `#onTouchEnd` | foliate's touch turn disabled: `preventDefault()` kept (blocks native scroll and Safari's edge back-swipe), `scrollBy` and the velocity `snap()` dropped. Our swipe (§7) is the only turn input. `checkPointerSelection` (auto-turn while drag-selecting) is untouched. |
| 3 | `paginator.js` `#turnPage` | Resolves immediately instead of `wait(100)` (which ran on every turn with `animated` off); after a section crossing `#locked` is released by a 100 ms timer. A full slide is longer than 100 ms; a TOC/scrubber `goTo` within 100 ms of a crossing is ignored, as upstream. |
| 4 | `paginator.js` `View#render`, `Paginator#render` | Return early while the iframe has no `documentElement`/`body` (a resize during a section swap or teardown threw `el is null` / `createTreeWalker(null)`). |
| 5 | `epubcfi.js` `fromRange` / `toRange` | Default filter `tsuzuriFilter` rejects `.tsuzuri-en`, so CFIs (progress, highlights, bookmarks) equal the untranslated book's and survive translation edits. A boundary inside English moves out: a start (or collapsed point) to the first non-blank text after it, an end to the last text before it; each falls back to the other side, then to the element's position. A range wholly inside one element becomes a point. A document containing `.tsuzuri-ja` (an older build format whose saved CFIs counted the English) is left unfiltered. These are the only content-document CFI calls `view.js`/`epub.js` make. Tested in `translation.test.ts`. |

---

## 2. The foliate surface used

`ReaderController` declares it as the `FoliateView` interface.

| `<foliate-view>` member | Behaviour |
| --- | --- |
| `open(book)` | `makeBook`, pick renderer, wire renderer events. No paint. |
| `init({lastLocation, showTextStart})` | Go to `lastLocation`, else bodymatter. First paint. |
| `goTo(target)` / `goToFraction(frac)` | CFI / href / index, or a whole-book fraction. Not animated. |
| `goLeft()` / `goRight()` | Honour `book.dir` (`goLeft` = `next()` in rtl). Raw `prev`/`next` are never called. |
| `getSectionFractions()`, `getCFI(index, range)`, `resolveCFI(cfi)` | Section start fractions; build a CFI; resolve to `{index, anchor}` synchronously. |
| `addAnnotation({value}, remove?)` / `deleteAnnotation` | Emit `draw-annotation` if the CFI's section is loaded; no-op otherwise. |
| `deselect()` / `close()` | Clear selections; destroy the renderer (not the Book). |

The paginator (`view.renderer`) is used only via `setStyles(css)`, layout attributes (§5a;
never `flow`), `atStart`/`atEnd`, `scrollToAnchor` and `getContents()` →
`[{index, doc, overlayer}]`. Search, TTS, media overlays, `select`, `showAnnotation` are unused.

### Events (`#wireView`, once in `open()`)

Listeners sit on the persistent host element (they survive a writing-mode re-open) on `#ac`.

| Event | Handler |
| --- | --- |
| `relocate` | `lastCFI = cfi`; `onRelocate`. There is no `reason`: user intent comes from the gesture side (`onTurn`, jumps). |
| `load` `{doc, index}` | Record `doc → index`; `#applyIntendedWritingMode` (§5c); re-run `applyLayout` if the body's writing mode differs; `#applyPageProgression` (§5b); `DocumentInput.attach(doc)`; `EnglishState.onLoad`; `onLoad`. |
| `create-overlay` `{index}` | `HighlightPainter.drawSections` (§9). The opening section paints this way too. |
| `draw-annotation` | `drawHighlight`: `Overlayer.highlight` in `HIGHLIGHT_HEX` over the rects outside visible English (§4a). The only place a highlight is painted. |
| `show-annotation` | A real `click` hit a highlight → `onShowAnnotation` (§8). |

---

## 3. `ReaderController`

`new ReaderController(container, settings, callbacks)` appends a full-size `<foliate-view>`;
nothing renders until `open()`. Public: `view`, `lastCFI`, `bookDir`, `vertical`, `hasEnglish`.

| Method | Behaviour |
| --- | --- |
| `applyAppearance(s)` | `renderer.setStyles(appearanceCSS(s, readThemeTokens()))`, live-safe (§4); a show-all change re-anchors (§4a). |
| `applyLayout(s)` | Paginator geometry from the viewport; idempotent (§5a). |
| `reopenForWritingMode(file)` | Re-open at `lastCFI` (§5d). |
| `goLeft()` / `goRight()` | `onTurn`, then an animated turn or end bounce (§6). `goForward`/`goBackward` map reading order onto them. |
| `cfiForSelection(doc, range)` | CFI clamped out of English; `null` if unknown, empty or it throws. |
| `addHighlight` / `removeHighlight` / `setHighlights` | Render state only (§9). Seed with `setHighlights` before `open()`. |
| `destroy()` | Cancels sweep, coalesced turn and re-opens, aborts all listeners, clears `Timers`, `view.close()` + `book.destroy()` (revokes the Book's blob URLs). |

`ReaderCallbacks`: `onRelocate`, `onLoad`, `onTap(TapInfo)`, `onTurn`, `onSelection`,
`onSelectionCleared`, `onShowAnnotation(value, range)`, `onKey`, `onEnglish`.
`TapInfo = {doc | null, ix, iy, px, py}`: iframe-local coords for the caret APIs, top-window
coords for the card and band; `doc` is `null` for a margin tap.

**`open()`:** `view.open` → `bookDir`, `#expectVertical()`, `EnglishState.detect()` →
`#wireView()` → `applyAppearance` + `applyLayout` (before `init`, so the first paint is right)
→ host gestures → `resize` on `window` and `visualViewport` → `view.init` → `#nudgeLayout()`.
`#destroyed` is re-checked after every await; an `open()` resolving after `destroy()` closes
the Book it made.

Every timeout (resize debounce, nudge, turn fallback, highlight chunks, per-document selection
debounce) lives in the one keyed `Timers` set: setting a key replaces it, `destroy()` clears all.

---

## 4. Appearance — `appearanceCSS(settings, tokens)`

Pure and unit-tested. `readThemeTokens()` does one `getComputedStyle(document.documentElement)`
read (palette, fonts, `data-theme`; tokens in [ui-and-design.md](ui-and-design.md)).

- `html`: `background: --paper !important` (a transparent iframe root composites over a white
  canvas, light in dark mode); `color-scheme` from the resolved `data-theme` (the setting may
  be `'auto'`); `font-size: fontScale%`; `writing-mode … !important` only for an explicit
  `'vertical'`/`'horizontal'`.
- `body`: `-webkit-touch-callout: none` (our toolbar replaces it) and `touch-action:
  manipulation` (also on `.reader`). iOS ignores `user-scalable`, and both our detector and
  foliate bail while `visualViewport.scale > 1.01`, so a stray double-tap zoom kills every tap
  and swipe. Pinch-zoom stays.
- `rt` unselectable; `::selection` uses `--accent-soft`. `setStyles` swaps the `<style>` text,
  so it reflows in place.
- `.tsuzuri-en` is `display: none` unless `showEnglish`. Shown, it is a block set apart by
  face (`--font-latin-serif`, or `--font-ui` for ゴシック), 0.85em, `--ink` mixed 70% with
  `--paper` and logical margins. No border: `border-inline-start` draws a stray dash atop
  each column in 縦書き, where the English runs sideways.

### 4a. English translations

Bundled books carry English after each unit ([translation.md](translation.md)).

- **Detection** (`hasEnglish`, `onEnglish` once): the package's `tsuzuri:translation` meta
  (`packageHasEnglish` on `book.resources.opf`) at open; fallback for books built without it,
  a loaded section's `meta[name="tsuzuri-translated"]`. No spine scan.
- **Show all** (`settings.showEnglish`, CSS only) is the only way English enters the page.
  `applyAppearance` calls `EnglishState.setShowAll(on)`, which on a change samples the
  character at the view centre; after the swap `keepPage` scrolls to it
  (`renderer.scrollToAnchor`), moved to the Japanese before it if it is now-hidden English.
  foliate's own anchor can be stale or start in hidden English.
- **The card's Translation** is the unit's `.tsuzuri-en` `textContent`, readable while
  `display: none`, so the page never reflows and the English is horizontal in 縦書き (§11).
  Only offered while show-all is off.
- **Unit lookup** (`unitEnglish(node)`): climb to the leaf block's child holding the node,
  scan next siblings to a `.tsuzuri-en` (the unit's English) or `<br>` (none). A node inside
  English returns that English.
- **Extraction** never reads English ([japanese.md](japanese.md) §3). **CFIs** ignore it
  (patch 5); `cfiForSelection` also clamps ends inside English to the Japanese
  (`clampOutOfEnglish`), so a highlight never spans into it.
- **Highlights across units** draw `rectsOutsideEnglish(range, rects)` (rects inside a
  displayed `.tsuzuri-en` the range crosses are dropped), re-evaluated on every redraw.
  foliate's hit-test uses the full rects, so a click on that English reopens the highlight.

---

## 5. Layout

### 5a. `applyLayout`

```ts
const { w: vw, h: vh } = viewportSize()
margin           = round(clamp(28, min(vw, vh) * 0.075, 80) * s.marginScale)  // px
gap              = '6%'
max-column-count = vw > vh && vw >= 820 ? 2 : 1       // spread only in wide landscape
// horizontal: max-inline-size = 640 (line length), max-block-size = 880 (page height)
// vertical:   max-inline-size = max(320, vh - 2*margin) (column height)
//             max-block-size  = vw - 2*margin           (page width)
```

- **Idempotent.** Every observed-attribute write re-renders the paginator even when unchanged,
  and iOS fires resize bursts on rotation, so `#lastLayout` bails when the geometry is
  unchanged.
- Only changed attributes are written; `max-inline-size` is written on every real change and
  **last**, because its `attributeChangedCallback` calls `render()` (one relayout per change).
- `margin` must be `px`, `gap` `%`.
- `viewportSize()` prefers the visual viewport (lifted to the screen height on a cold
  standalone launch), falling back to `window.inner*` while pinch-zoomed.

**Resize.** `#onResize` (150 ms debounce) runs on `window` and `visualViewport` resize (iOS
reports the post-launch settle only on the latter); skipped while zoomed. `#nudgeLayout`
re-runs `applyLayout` (a bare `render()` keeps stale caps) 250 ms after `init`, for a
cold-launch viewport that settles after first paint.

**Vertical column fill.** In landscape foliate's `.vertical` container query makes
`--_max-height = max-inline-size`, so deriving that cap from `vh` fills the column on first
paint (a fixed cap left a dead band). Portrait has a residual band on iOS (open).

**`#expectVertical()`** pre-sets `#vertical` before `init` so the pre-init `applyLayout`
uses the right axis. An explicit `writingMode` wins; on `'auto'`, `book.dir === 'rtl'` plus a
`ja*` language guesses vertical. `load` corrects a wrong guess from
`getComputedStyle(body ?? html).writingMode`, the element foliate's `getDirection` reads.

### 5b. RTL page order with horizontal text — `#applyPageProgression`

foliate takes column order from the content's CSS direction, not `book.dir` (which only feeds
`goLeft`/`goRight`), so an rtl spine with 横書き content would spread left-to-right. In `load`
(before foliate's `getDirection`), set `dir="rtl"` on both `html` and `body` (html alone
doesn't flip the columns) and inject `<style data-tsuzuri="ltr-text">` pinning block text to
`direction: ltr`. Only when `bookDir === 'rtl'`, the section is horizontal and
`writingMode !== 'vertical'`.

### 5c. 縦書き declared only in metadata — `#applyIntendedWritingMode`

calibre-converted novels carry `primary-writing-mode` meta and `class="vrtl"` on `<html>` but
no `writing-mode` CSS, and foliate reads only `rendition:*` metadata. On `'auto'`, a `vrtl`
root gets a prepended `<style data-tsuzuri="intended-wm">html{writing-mode:vertical-rl}` (the
book's CSS and our `!important` override still win). Only that marker counts: guessing from
`lang` or an rtl spine would flip horizontal RTL-bound books (§5b). Idempotent.

### 5d. Writing-mode changes — `reopenForWritingMode`

The paginator fixes axis and direction per section at load and doesn't re-derive them on a
style swap, so a writing-mode change re-opens at `lastCFI`. `#reopen` cancels the nudge,
sweep, coalesced turn and every document's listeners, then `#closeBook()` (`view.close()` +
`book.destroy()`: foliate's `open()` appends a new paginator without removing the old, and
the Book holds a blob URL per resource), `view.open`, recompute `bookDir`/`#vertical`,
**clear `#lastLayout`** (the new paginator has default attributes), appearance + layout,
`init`, nudge. Calls chain on `#reopenChain`; one superseded (`#reopenGen`) before it starts is
skipped. Don't call `view.open` elsewhere.

### 5e. Paginator internals

- Content is in an iframe with `sandbox="allow-same-origin allow-scripts"` (both needed for
  events in WebKit) inside a **closed** shadow root; the console's sandbox-escape warning is
  expected. The only handle to a content document is the `load` event's `doc` (DEV:
  `window.__tsuzuri`, [development.md](development.md)).
- An orientation container query collapses the spread in portrait for horizontal text and
  inverts it for `.vertical` (`--_max-height = --_max-inline-size × spread`).

---

## 6. Page turns — `PageTurner` (`turns.ts`)

foliate's `animated` turn slides vertically for 縦書き, so `animated` stays off and the whole
`<foliate-view>` is animated horizontally by us.

1. **Coalescing:** while `#turning`, a request only overwrites `#pendingDir`; the latest runs
   when the current turn ends (`cancelPending()` on re-open / destroy).
2. **End of book:** `#atEdge(dir)` (`renderer.atEnd` forward, `atStart` backward; forward is
   `goLeft` in rtl) → bounce `BOUNCE_PX` toward the finger, back over 1.4× `BOUNCE_MS`.
3. **Push:** drift `TURN_SHIFT_PX` the way the content moves while fading out; jump; place the
   new page on the opposite side and flush with transitions off (`void el.offsetWidth`, or it
   animates in from the exit side); drift to rest while fading in. Reduced motion: cross-fade
   only.

`#transition` resolves on `transitionend` of `opacity` (a zero-shift turn has no transform
change) or an `ms + 120` fallback. Jumps (`goTo`, `goToFraction`) are not animated.

---

## 7. Gestures — `trackGestures` (`gestures.ts`)

One pointer state machine, `trackGestures(target, {onTap, onSwipe, shouldIgnoreUp?,
canSwipeEarly?}, signal)`, attached twice:

- **`DocumentInput.attach(doc)`** per content document (gestures, `keydown` → `onKey`,
  `selectionchange`). A per-document `AbortController`, because an abort signal keeps its
  target alive and book-long registration would pin every section's DOM. Attaching aborts the
  controller for the same `doc` and any whose `defaultView` is `null`.
- **Host** (`<foliate-view>`, on `#ac`): margin events bubble out of the shadow DOM (iframe
  events don't, so nothing is handled twice). Margin taps carry `doc: null`; a synthetic host
  gesture must be dispatched on the host element.

| Constant | Value |
| --- | --- |
| `TAP_MOVE_TOLERANCE` | 16 px |
| `TAP_MAX_MS` | 700 ms (an aimed tap at a 16px glyph is slow; a long-press becomes a selection anyway) |
| `SWIPE_MIN_DISTANCE` / `SWIPE_DECIDE_MS` | 45 px / 500 ms |
| `SELECTION_DEBOUNCE_MS` | 250 ms |
| `TURN_OUT_MS` / `TURN_IN_MS` / `TURN_SHIFT_PX` | 90 ms / 170 ms / 36 px |
| `BOUNCE_PX` / `BOUNCE_MS` | 28 px / 110 ms |
| `HIGHLIGHT_DRAW_CHUNK` | 24 |

**Pointer rules.** A non-primary `pointerdown` sets `multi`.

- `pointermove`: non-primary pointers are ignored (they'd be measured against the first
  finger). Travel over the tolerance sets `moved`. **Early swipe:** touch only, no `multi`,
  `|dx| ≥ 45`, `|dx| > |dy|`, within `SWIPE_DECIDE_MS`, not zoomed, and `canSwipeEarly()`
  (content docs: no live selection, the finger may be on a handle) → turn now and consume the
  gesture. Mouse/pen never decide early (a mouse drag is a drag-select).
- `pointercancel` (primary only) ends the gesture without a tap.
- `pointerup`: return if non-primary (checked before consuming `active`, so a second finger
  lifting doesn't end the gesture), inactive, `shouldIgnoreUp(e)`, or zoomed. Then a
  horizontal `|dx| ≥ 45` swipes (drag left → `goRight`, right → `goLeft`; correct in every
  direction), else `!moved` within `TAP_MAX_MS` → `onTap`.
- `shouldIgnoreUp` (content docs) is true only for a press inside the live selection's rects;
  otherwise it clears the selection and lets the tap through (WebKit collapses a selection
  only after our `pointerup`, so bailing on any selection would swallow the dismissing tap).

---

## 8. Tap routing & keyboard (`Reader.svelte`, `defineCard.svelte.ts`)

`onTap(info)`, in order:

1. **Card open → dismiss** (`closeOverlays()`) wherever the tap lands; stamps `tapDismissedAt`.
2. **Glyph → define.** `card.tryDefine(info)`: `extractTextAt` returns `null` unless the point
   resolves to a word character ([japanese.md](japanese.md) §3). On a hit: open the card,
   stamp `tapDefinedAt`/`tapDefinedKey`, hide the chrome. Wins inside the edge band, which
   overlaps the first/last glyphs of every column (at 1194×834: a 100px band vs a 63px
   margin). English is never a glyph, so a tap on it falls through as blank.
3. **Blank tap in the edge band → toggle chrome**: `inChromeToggleBand(py, viewportSize().h)`,
   band = `clamp(80, 0.12·vh, 160)`. The only way a tap shows the bars.
4. **Blank tap elsewhere → hide the chrome** if visible.

Visible bars cover the bands, so a tap on a bar's empty area hides them
(`dismissChromeFromBar`, ignoring buttons). While hidden, `.page-pct` shows the reading %.

**`show-annotation` de-conflict.** foliate's hit-test is a real `click` on the same gesture
as our tap, which runs first and is never delayed. `card.showAnnotation`:

- within 500 ms of `tapDismissedAt` → stand down;
- within 500 ms of `tapDefinedAt` → keep the tap's lookup, but if the card is still that
  tap's and has no CFI yet, adopt the clicked highlight (CFI, stored word,
  `highlighted`), so **Remove highlight** removes what was tapped (e.g. an enclosing phrase);
- otherwise reopen the card for the highlight: word = the stored record's `text`, else
  `range.toString()`; anchor = the range's rect.

**Keyboard** (`onKey`, window + forwarded from content docs): ←/→ turn, Space/Shift-Space
forward/back, `e` show-all English (book has English), `t` the open card's Translation,
Escape closes the card/toolbar, else the chrome. Ignored before ready, with a modifier, while
a sheet is open, in a field or `[role="slider"]`, and Space on a focused button.

Overlays close on every turn, jump, scrubber seek, show-all change and writing-mode re-open.

---

## 9. Highlights & CFI

Progress, highlights and bookmarks all anchor by CFI (stable across reflow). Render state is
`HighlightPainter`'s `Set<cfi>` + a lazy `resolveCFI` index cache. Records are the
`annotations` store's `items`, an immutable `$state.raw` array replaced on every change, with
`byId` / `highlightsByCFI` maps rebuilt alongside.

**One create/remove pair** in `Reader.svelte`: `addHighlight(cfi, text)` paints (unless
already highlighted), then `addHighlightRecord` (deduped on CFI, in memory now, IndexedDB in
the background); `removeHighlight(cfi)` removes every record at the CFI and unpaints. A panel
delete unpaints only when no other record shares the CFI; the toast's Undo re-saves and
repaints. `loadAnnotations` is generation-guarded.

**Tap-to-define** (`highlightMatch`, synchronous so a newer tap's card can't be overwritten;
only on a fresh tap with a match): `rangeForSpan` over the match → CFI → re-anchor the card to
the word → `addHighlight` if `highlightLookups` (or already highlighted). The word is spelled
from `positions`, never `range.toString()` ([japanese.md](japanese.md) §3).

**Drawing.** `setHighlights` is called before `open()`, so the opening section draws its own
share during `init` (no whole-book sweep); called later it redraws loaded sections. Unloaded
sections draw on `create-overlay`. `drawSections(indices)` orders more than 24 highlights
`nearestFirst(cfis, lastCFI)` (document order, binary search, alternate outward) so the
visible page paints first, then draws 24 per `setTimeout(0)` task so a swipe never waits. A
generation counter abandons an older sweep; a highlight may not be painted yet when
`addHighlight` resolves.

---

## 10. Selection

A 250 ms-debounced `selectionchange` per content document reports a non-empty `Range` as
`onSelection({doc, range, text, rect})`, else `onSelectionCleared`. `SelectionToolbar` offers
**Highlight** (`cfiForSelection` → `addHighlight`) and **Copy**. `selectionText` serializes
the same way whatever the selection touches: furigana and English (shown or hidden) dropped,
a line break at each `<br>` and block boundary, ASCII whitespace collapsed (and dropped
between CJK characters, so a hard-wrapped source line adds no space). A selection wholly inside English copies it and hides
Highlight.

---

## 11. `Reader.svelte` wiring

**Mount.** `prefetchEngine()` (foliate's `zip.js`/`epub.js`/`paginator.js`, else imported
serially inside `view.open`) and a lookup warm-up → `Promise.all([getBookMeta, getBookFile,
getProgress, loadAnnotations])` (no bytes → "please re-import") → `new ReaderController` →
`setHighlights` → `open(file, progress?.cfi)` → TOC, `buildChapterIndex`, DEV hook.
`destroyed` is re-checked after every await.

**Progress.** `onRelocate` updates fraction, CFI, TOC id and label, and calls the 600 ms
debounced `saveProgress` only once `userInteracted` (set by turns, jumps, seeks): startup
relocations can report a bogus fraction. Flushed on `visibilitychange → hidden`, `pagehide`
and destroy (iOS may kill a hidden PWA before the debounce fires).

**Bookmarks.** `isBookmarked` = some bookmark with `cfiWithinPage(bookmark, currentCFI)`
(start-inclusive, end-exclusive). `toggleBookmark` removes every bookmark on the page, else
saves one. The ribbon sits on the fore-edge corner (flipped for rtl).

**Dictionary card** (`createDefineCard`; `card.state` drives `DictionaryPopup`). `openDefine`
sets the anchor (tapped glyph, or the highlight's rect), keeps the previous `result` (dimmed)
if already open, and runs the lookup: no dictionary → `needsDownload`; a stale `lastKey` is
dropped; any error clears `loading`. After a download an `$effect` re-runs the pending lookup
once `dict.state === 'ok'` (without waiting for the IPADIC warm); jpdict-idb reports 'ok' at
~17% of the download, so `downloadDict` looks up once more when it ends.

**Translation section** (`state.translation` / `translationOpen`, from `englishFor` = the
unit's English while show-all is off): collapsed by default; expanded if the previous card
left the same unit's English open (a `WeakRef`, so no section is pinned) or when there is no
dictionary yet (the translation leads, the download prompt shrinks). `t` toggles it. While
open, the unit's Japanese (`unitStart(en)` → before `en`) is tinted with the CSS Custom
Highlight `tz-unit` (`::highlight` in `appearanceCSS`): paint only, cleared on close or
collapse, skipped where `CSS.highlights` is missing.

**Card placement.** `placeNearWord(anchor, w, h, vertical, {gap: 16, margin: 12, prefer})`:
horizontal text above/below the word; 縦書き beside the column (left, else right, else
above/below). The card never covers the word, keeps the side it opened on, and its
max-height is capped to the room on that side (definition and Translation each scroll).
Width 340px; ≤480px full width minus 12px gaps; ≥1024px 360px. `placeAnchored` (toolbar) centres,
prefers above, flips below, clamps inside the cached `--safe-*` insets.

**English controls** (only when `hasEnglish`): a top-bar toggle (`languages` icon), `e`, and
Display → Translation, all via `onSettingChange('english')` (close overlays,
`applyAppearance`, then a once-per-install toast offering 横書き when show-all English runs
sideways in an `'auto'` vertical book; `sidewaysHintShown`).

**Settings & theme.** `onSettingChange(kind)`: `'appearance'` → `applyAppearance`; `'layout'`
→ `applyLayout`; `'writingmode'` → close overlays + `reopenForWritingMode`. An `$effect`
re-applies appearance when `appearance.resolved` changes under `'auto'` (`appliedTheme`
prevents a double apply).

**Lookup worker** lifecycle (dispose after 60 s hidden, ping on show): [japanese.md](japanese.md) §6.

**Sheets & scrubber.** `TocSheet` and `AnnotationsPanel` navigate via `jumpTo`.
`ProgressScrubber` gets `labelAt = chapterAt(chapterStarts, f)` and `onseek` →
`goToFraction`; it stops its own click so it doesn't trip `dismissChromeFromBar`.

**Destroy:** flush progress, `controller.destroy()`, `disposeLookup()`, `clearAnnotations()`,
drop DOM refs and `window.__tsuzuri`. `.reader` is fixed with `height: var(--app-height,
100dvh)` (not `inset: 0`; [storage-pwa-ios.md §6](storage-pwa-ios.md#6-ios-viewport--srcservicesviewportts))
and `touch-action: manipulation`. The bar capsules must fit inside the chrome-toggle band.

---

## 12. How to extend

- **Reader setting:** [development.md §6](development.md#6-adding-a-reader-setting).
- **Gesture:** extend `trackGestures`, keeping the `isPrimary` guards, cancel handling and the
  swipe-vs-tap split (§7). Content-document listeners on that document's `DocumentInput`
  signal, host ones on `#ac`. Add a `ReaderCallbacks` entry.
- **Reading measure:** the `applyLayout` knobs (§5a). Keep units, the `max-inline-size`-last
  order and the axis swap.
- **Annotation style:** branch in `drawHighlight` (`Overlayer.underline`/`squiggly`/
  `strikethrough` exist), extend `Annotation` + store.

## 13. Gotchas

- Swipe and animation are both ours: setting `animated` gives a vertical slide; un-patching
  foliate's touch turn gives double turns.
- Widening the glyph hit slack (`glyphSlack`, [japanese.md](japanese.md) §3) shrinks the blank
  space the band toggle needs; narrowing it makes text under the band un-lookupable.
