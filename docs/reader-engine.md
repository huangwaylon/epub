# Reader Engine

The bridge between the vendored **foliate-js** renderer and the reading experience: page
turns, taps, selection, highlights, vertical 縦書き layout. Read this before touching
`src/vendor/foliate-js/`, `src/services/reader.ts` or `src/lib/reader/`. References are by
symbol, not line number.

| File | Role |
| --- | --- |
| `src/services/reader.ts` | `ReaderController` — the app-facing wrapper around `<foliate-view>` |
| `src/lib/reader/Reader.svelte` | The reader screen; wires the controller to the UI |
| `src/services/cfi.ts` | Pure CFI helpers: `nearestFirst` (§9), `cfiWithinPage` (§11) |
| `src/stores/annotations.svelte.ts` | Highlight/bookmark records (§9) |
| `src/lib/util/chromeBand.ts` | `inChromeToggleBand(py, vh)` — the edge-band test (§8) |
| `src/lib/util/anchoredPosition.ts` | `placeAnchored` / `placeNearWord` — popup + toolbar placement (§11) |
| `src/services/viewport.ts` | `viewportSize()`, `--app-height` / `--doc-height` ([storage-pwa-ios.md](storage-pwa-ios.md)) |
| `src/vendor/foliate-js/` | `view.js` (`<foliate-view>`), `paginator.js` (multicolumn renderer), `overlayer.js` (SVG highlights), `epubcfi.js` |

On-device verification status lives in CLAUDE.md.

---

## 1. foliate-js and the local patches

[foliate-js](https://github.com/johnfactotum/foliate-js) (MIT, `src/vendor/foliate-js/LICENSE`)
is pure ESM, paginates reflowable EPUB with CSS multi-column, supports vertical writing
and RTL progression, and works in DOM `Range`s + EPUB CFIs. Upstream is unstable, so a
pinned copy is vendored. **Treat it as third-party**: app behaviour belongs in
`ReaderController` / `Reader.svelte`. A vendor patch must be minimal, commented
`// TSUZURI PATCH (n): …`, and listed here.

| # | File | Patch |
| --- | --- | --- |
| 1 | `view.js` | PDF.js and the PDF branch of `makeBook` removed (`vendor/` holds only `fflate.js`, `zip.js`; `isPDF` is dead code). Not marked in the source. |
| 2 | `paginator.js` `#onTouchMove` / `#onTouchEnd` | foliate's own touch turn disabled: `preventDefault()` kept (blocks native scroll and Safari's edge back-swipe), `scrollBy` and the velocity `snap()` dropped. Our swipe detector (§7) is the only turn input. `checkPointerSelection` (auto-turn while drag-selecting) is untouched. |
| 3 | `paginator.js` `#turnPage` | Upstream awaited `wait(100)` when `shouldGo \|\| !animated`; we never set `animated`, so every turn paid 100 ms. Now it resolves immediately; after a section crossing it releases `#locked` from a 100 ms timer. Our next turn can't arrive sooner (a full slide is `TURN_OUT_MS + TURN_IN_MS`), but a TOC/scrubber `goTo` within 100 ms of a crossing is ignored, as upstream. |
| 4 | `paginator.js` `View#render` | Returns early while the iframe has no `documentElement`/`body` (a resize during a section swap or teardown threw `el is null`). |

---

## 2. The foliate surface we use

`ReaderController` declares what it touches as the `FoliateView` interface.

| `<foliate-view>` member | Behaviour |
| --- | --- |
| `open(book)` | `makeBook`, pick renderer, wire renderer events. **No paint.** |
| `init({lastLocation, showTextStart})` | Go to `lastLocation`, else bodymatter. **First paint.** |
| `goTo(target)` / `goToFraction(frac)` | CFI / href / index, or a whole-book fraction. Not animated. |
| `goLeft()` / `goRight()` | Honour `book.dir` (`goLeft` = `next()` in rtl). We never call raw `prev`/`next`. |
| `getSectionFractions()`, `getCFI(index, range)`, `resolveCFI(cfi)` | Section start fractions; build a CFI; resolve one to `{index, anchor}` synchronously. |
| `addAnnotation({value}, remove?)` / `deleteAnnotation` | Resolve the CFI; if its section is loaded, emit `draw-annotation`. No-op otherwise. |
| `deselect()` / `close()` | Clear selections; destroy + remove the renderer (**not** the Book). |
| `book` | `.dir`, `.metadata`, `.toc`, `.resolveHref`, `.destroy()`. |

The paginator (`view.renderer`) is used only via `setStyles(css)`, layout attributes
(§5a; never `flow`), `atStart`/`atEnd` and `getContents()` → `[{index, doc, overlayer}]`.
Search, TTS, media overlays, `select`, `showAnnotation` are unused.

### Events (`#wireView`, attached once in `open()`)

Listeners live on the persistent host element, so they survive a writing-mode re-open;
all use `#ac.signal`.

| Event | `detail` | Handler |
| --- | --- | --- |
| `relocate` | `{cfi, fraction, tocItem, range, …}` | `lastCFI = cfi`; `onRelocate`. **No `reason`** — user intent comes from the gesture side (`onTurn`, jumps). |
| `load` | `{doc, index}` | Record `doc → index`; `#applyIntendedWritingMode` (§5c); read the writing mode off `body` and re-run `applyLayout` if it changed; `#applyPageProgression` (§5b); `#attachTaps(doc)`; `onLoad`. |
| `create-overlay` | `{index}` | Draw that section's highlights (§9). This is also how the opening section paints. |
| `draw-annotation` | `{draw, …}` | `draw(Overlayer.highlight, {color: HIGHLIGHT_HEX})` — the only place a highlight is painted. |
| `show-annotation` | `{value, range}` | A real `click` hit a highlight → `onShowAnnotation` (§8). |

---

## 3. `ReaderController`

```ts
new ReaderController(container: HTMLElement, settings: ReaderSettings, callbacks: ReaderCallbacks)
```

Appends a full-size `<foliate-view>` to `container`; nothing renders until `open()`.
Public fields: `view`, `lastCFI` (last relocate CFI, seeded from `open()`'s hint),
`bookDir` (`'ltr'|'rtl'`), getter `vertical`.

| Method | Behaviour |
| --- | --- |
| `applyAppearance(s)` | `renderer.setStyles(appearanceCSS(s))` — live-safe (§4). |
| `applyLayout(s)` | Paginator geometry from the viewport; idempotent (§5). |
| `reopenForWritingMode(file)` | Re-open at `lastCFI` (§5d). Serialized; rejects on failure. |
| `goLeft()` / `goRight()` | Fire `onTurn`, then an animated turn or an end bounce (§6). `goForward`/`goBackward` map reading order onto them. |
| `goTo` / `goToFraction` / `clearSelection` | Thin wrappers (fraction clamped to 0..1). |
| `cfiForSelection(doc, range)` | `#docIndex` → `view.getCFI`; `null` if unknown or it throws. |
| `addHighlight` / `removeHighlight` / `setHighlights` | Render state only (§9); seed with `setHighlights` **before `open()`**. |
| `destroy()` | Remove resize listeners, clear every timer, bump `#reopenGen`/`#redrawGen`, abort all `#docACs` and `#ac`, `view.close()` + `book.destroy()` (revokes the Book's blob URLs), remove the element. |

`ReaderCallbacks`: `onRelocate`, `onLoad`, `onTap(TapInfo)`, `onTurn`, `onSelection`,
`onSelectionCleared`, `onShowAnnotation(value, range)`, `onKey` (content-doc keydown).
`TapInfo = {doc | null, ix, iy, px, py}`: iframe-local coords for the caret APIs, top-window
coords for popup/band; `doc` is `null` for a margin tap.

**`open()`:** store the `lastCFI` hint → `view.open` → `bookDir`, `#expectVertical()` →
`#wireView()` → `applyAppearance` + `applyLayout` (before `init`, so the first paint is
right) → `#attachHostGestures()` → `resize` on `window` and `visualViewport` → `view.init`
→ `#nudgeLayout()`. `#destroyed` is re-checked after every await; an `open()` resolving
after `destroy()` closes the Book it made.

---

## 4. Appearance — `appearanceCSS(settings)`

One `getComputedStyle(document.documentElement)` read supplies `--ink`, `--paper`,
`--accent`, `--accent-soft` and `--font-jp-sans` / `--font-serif` (tokens:
[ui-and-design.md](ui-and-design.md)).

- `html`: `--ink`, **`background: --paper !important`** (a transparent iframe root
  composites over a white default canvas — light in dark mode), `color-scheme` from
  `<html data-theme>` (the resolved palette; the setting may be `'auto'`),
  `font-size: fontScale%`, and `writing-mode … !important` for an explicit
  `'vertical'`/`'horizontal'` (nothing on `'auto'`).
- `body`: transparent, `font-family`, `-webkit-touch-callout: none` (our toolbar),
  **`touch-action: manipulation`** — also on `.reader`. iOS ignores `user-scalable`, and our
  detector and foliate both bail while `visualViewport.scale > 1.01`, so a stray double-tap
  zoom would kill every tap and swipe. Pinch-zoom stays.
- Text blocks get `line-height`, justify, hyphens; `rt` is unselectable; `::selection` uses
  `--accent-soft`. `setStyles` swaps the `<style>` text, so it reflows in place.

---

## 5. Layout

### 5a. `applyLayout`

```ts
const { w: vw, h: vh } = viewportSize()
margin              = round(clamp(28, min(vw, vh) * 0.075, 80) * s.marginScale)  // px
gap                 = '6%'
max-column-count    = vw > vh && vw >= 820 ? 2 : 1       // spread only in wide landscape
// horizontal: max-inline-size = 640 (line length), max-block-size = 880 (page height)
// vertical:   max-inline-size = max(320, vh - 2*margin) (column HEIGHT)
//             max-block-size  = vw - 2*margin           (page WIDTH)
```

- **Idempotent.** Every observed-attribute write re-renders the paginator even when the
  value is unchanged, and iOS fires resize bursts on rotation, so `#lastLayout` bails when
  the derived geometry is unchanged (no rotation flicker).
- **Only changed attributes are written**; `max-inline-size` is written on every real
  change and **last**, because its `attributeChangedCallback` is the one that calls
  `render()` — one relayout per change.
- `margin` must be `px`, `gap` `%`. The other observed attributes only set `--_<name>`
  (a `ResizeObserver` relays out).
- `viewportSize()` prefers the visual viewport (lifted to the screen height when a cold
  standalone launch under-reports it), falling back to `window.inner*` while pinch-zoomed.
  The chrome band (§8) and popup placement use it too.

**Resize.** `#onResize` (150 ms debounce) re-runs `applyLayout` on `window` and
`visualViewport` resize — iOS reports the post-launch viewport settle only on the latter —
and is skipped while pinch-zoomed. **`#nudgeLayout`** re-runs `applyLayout` (not a bare
`render()`, which would keep stale caps) 250 ms after `init`, as a hedge for a cold-launch
viewport that settles after first paint.

**Vertical column fill.** In landscape foliate's `.vertical` container query makes
`--_max-height = max-inline-size`, so deriving that cap from `vh` is what fills the column
on first paint (a fixed cap left a dead band). Portrait has a residual band on iOS (open).

**`#expectVertical()`** pre-sets `#vertical` before `init`, so the pre-init `applyLayout`
doesn't force a render with the wrong axis. An explicit `writingMode` is authoritative;
on `'auto'`, `book.dir === 'rtl'` plus a `ja*` `metadata.language` guesses vertical. The
`load` handler corrects a wrong guess by reading `getComputedStyle(body ?? html).writingMode`
— the element foliate's `getDirection` reads, so our measure and its axis agree.

### 5b. RTL page order with horizontal text — `#applyPageProgression`

A spine with `page-progression-direction="rtl"` and ordinary 横書き content: foliate takes
column order from the content's CSS direction, not `book.dir` (which only feeds
`goLeft`/`goRight`), so the spread would run left-to-right. From `load` (before foliate's
`getDirection`), it sets `dir="rtl"` on **both** `html` and `body` (html alone doesn't flip
the columns) and injects `<style data-tsuzuri="ltr-text">` pinning block text back to
`direction: ltr`. No-op unless `bookDir === 'rtl'`, the section is horizontal and
`writingMode !== 'vertical'`.

### 5c. 縦書き declared only in metadata — `#applyIntendedWritingMode`

calibre-converted novels carry `<meta name="primary-writing-mode" content="vertical-rl">`
and `class="vrtl"` on each section's `<html>`, but no `writing-mode` CSS; foliate reads only
`rendition:*` metadata, so they would render 横書き. On `writingMode: 'auto'`, a `vrtl`
root gets a **prepended** `<style data-tsuzuri="intended-wm">html{writing-mode:vertical-rl}`
(the book's own CSS and our `!important` override still win), before the writing mode is
read in `load`. Only that explicit marker counts — guessing from `lang` or an rtl spine
would flip genuinely horizontal RTL-bound books (§5b). Idempotent.

### 5d. Writing-mode changes — `reopenForWritingMode`

The paginator decides axis and direction per section at load and doesn't re-derive them on
a style swap, so a writing-mode change re-opens the book at `lastCFI`. `#reopen`: clear
timers and `#pendingDir`, bump `#redrawGen`, abort every `#docACs`, `#closeBook()`
(`view.close()` + `book.destroy()` — foliate's `open()` appends a new paginator without
removing the old one, and the Book holds a blob URL per resource), `view.open`, recompute
`bookDir`/`#vertical`, **clear `#lastLayout`** (the new paginator has default attributes),
apply appearance + layout, `init`, nudge. Calls are chained on `#reopenChain`; a call
superseded (`#reopenGen`) before it starts is skipped. Don't call `view.open` elsewhere.

### 5e. Paginator internals worth knowing

- Content lives in an iframe with `sandbox="allow-same-origin allow-scripts"` (both needed
  for events in WebKit) inside a **closed** shadow root. The console's "can escape its
  sandboxing" warning is expected. The only handle to a content document is the `load`
  event's `doc` (in DEV, also `window.__tsuzuri` — see [development.md](development.md)).
- An orientation container query collapses the spread in portrait for horizontal text and
  inverts it for `.vertical`, where the axes swap (`--_max-height = --_max-inline-size × spread`).

---

## 6. Page turns — `#turn`, `#slide`, `#bounce`

foliate's own `animated` turn slides vertically for 縦書き, so `animated` stays **off**
(the jump is instant) and the whole `<foliate-view>` is animated horizontally by us.
`goLeft`/`goRight` fire `onTurn`, then `#turn(dir)`:

1. **Coalescing:** while `#turning`, a request only overwrites `#pendingDir`; the latest
   runs when the current turn finishes.
2. **End of book:** `#atEdge(dir)` (`renderer.atEnd` for a forward turn, `atStart` for a
   backward one; forward is `goLeft` in an rtl book) → `#bounce`: `BOUNCE_PX` toward the
   finger over `BOUNCE_MS`, back over 1.4×.
3. **`#slide` (push):** drift `TURN_SHIFT_PX` the way the content moves while fading out
   (`TURN_OUT_MS`); `transition: none`, `await view.goLeft()/goRight()`; place the new page
   `TURN_SHIFT_PX` on the opposite side and **flush with transitions off**
   (`void el.offsetWidth` — otherwise it animates in from the exit side); drift to rest
   while fading in (`TURN_IN_MS`). Reduced motion: shift 0, cross-fade only.

`#transition` resolves on `transitionend` (of `opacity` when it animates — a zero-shift
turn has no transform change) or an `ms + 120` fallback in `#slideTimer`, cleared by
`destroy()`. Jumps (`goTo`, `goToFraction`) are not animated.

---

## 7. Gestures — `#trackGestures`

One pointer state machine, attached at two points:

- **`#attachTaps(doc)`** per content document (the text column). Its listeners — gestures,
  `keydown` → `onKey`, `selectionchange` (§10) — use a **per-document** `AbortController` in
  `#docACs`: an abort signal keeps its target alive, so book-long registration would pin
  every section's DOM. Before attaching it aborts the controller for the same `doc` and any
  whose `defaultView` is `null`, clearing their `#selTimers`.
- **`#attachHostGestures()`** once, on the `<foliate-view>` host, on `#ac`: margin events
  bubble out of the shadow DOM (iframe events don't, so nothing is handled twice). Margin
  taps carry `doc: null`. A synthetic host gesture must be dispatched on the host element.

Constants (`reader.ts`): `TAP_MOVE_TOLERANCE` 16 px; **`TAP_MAX_MS` 700 ms** (an aimed tap
at a 16px glyph is slow; a long-press becomes a selection anyway); `SWIPE_MIN_DISTANCE`
45 px; `SWIPE_DECIDE_MS` 500 ms; `TURN_OUT_MS`/`TURN_IN_MS`/`TURN_SHIFT_PX` 90 ms/170 ms/36 px;
`BOUNCE_PX`/`BOUNCE_MS` 28 px/110 ms; `HIGHLIGHT_DRAW_CHUNK` 24.

**Pointer rules.** A non-primary `pointerdown` sets `multi`; otherwise:

- `pointermove`: **non-primary pointers are ignored** (they'd be measured against the first
  finger's down point). Travel over `TAP_MOVE_TOLERANCE` sets `moved`. **Early swipe:** a
  `touch` pointer, no `multi`, `|dx| ≥ SWIPE_MIN_DISTANCE`, `|dx| > |dy|`, within
  `SWIPE_DECIDE_MS`, not zoomed, and `canSwipeEarly()` (content docs: no live `Range`
  selection — the finger may be on a handle) → turn now and consume the gesture
  (`active = false`, so the lift does nothing). Mouse/pen never decide early (a mouse drag
  is a drag-select).
- `pointercancel` (primary only) ends the gesture without a tap.
- `pointerup`: return if non-primary (checked **before** consuming `active`, so a second
  finger lifting doesn't end the gesture) or inactive; `shouldIgnoreUp(e)`; zoomed
  (`scale > 1.01`). Then a horizontal-dominant `|dx| ≥ SWIPE_MIN_DISTANCE` swipes (drag
  left → `goRight`, drag right → `goLeft`; direction-aware, so correct in LTR/RTL/縦書き),
  else if `!moved` and within `TAP_MAX_MS` → `onTap`.
- `shouldIgnoreUp` (content docs) returns true only when the press is **inside** the live
  selection's client rects; otherwise it clears the selection and lets the tap through
  (WebKit collapses a selection only after our `pointerup`, so bailing on any selection
  would swallow the dismissing tap).

A content tap's `px/py` are offset by `frameElement.getBoundingClientRect()`.

---

## 8. Tap routing & keyboard (`Reader.svelte`)

`onTap(info)`, in order:

1. **Card open → dismiss** (`closeOverlays()`), wherever the tap lands, even on another
   word. Stamps `tapDismissedAt`.
2. **Glyph → define.** `tryDefine(info)`: `extractTextAt` returns `null` unless the point
   resolves to a word character (geometry, not caret offsets —
   [japanese.md](japanese.md) §3). On a hit: `openDefine`, stamp `tapDefinedAt` /
   `tapDefinedKey`, hide the chrome. This wins **inside the edge band**, which overlaps
   the first/last glyphs of every column (at 1194×834: a 100px band vs a 63px margin).
3. **Blank tap in the edge band → toggle chrome** — `inChromeToggleBand(py,
   viewportSize().h)`, band = `clamp(80, 0.12·vh, 160)`. The only way a tap shows the bars.
4. **Blank tap elsewhere → hide the chrome** if visible; otherwise nothing.

Visible bars cover the bands, so a tap on a bar's empty area hides them
(`dismissChromeFromBar`, ignoring buttons). While hidden, `.page-pct` shows the reading %.

**`show-annotation` de-conflict.** foliate's overlay hit-test is a real `click` on the same
gesture as our tap, which runs first and is never delayed. `onShowAnnotation`:

- within 500 ms of `tapDismissedAt` → return (the dismissing tap must not reopen a card);
- within 500 ms of `tapDefinedAt` → keep the tap's lookup, but if the card is still that
  tap's (`lastKey === tapDefinedKey`) and has no CFI yet, adopt the clicked highlight
  (`cfi`, stored word, `highlighted = true`), so **Remove highlight** removes what was
  tapped (e.g. an enclosing phrase) rather than a nested word;
- otherwise reopen the card for the highlight: word = the stored record's `text`, else
  `range.toString()`; anchor = the range's rect; `existingCfi` set.

**Keyboard** (`onKey`, window + forwarded from content docs): ←/→ `goLeft`/`goRight`,
Space/Shift-Space `goForward`/`goBackward`, Escape closes the card/toolbar, else the
chrome. Ignored before ready, with a modifier, while a sheet is open, in a field or
`[role="slider"]`, and Space on a focused button.

Overlays close on every turn, jump (`jumpTo`), scrubber seek and writing-mode re-open.

---

## 9. Highlights & CFI

Single colour, `HIGHLIGHT_HEX` (`types.ts`). CFIs are stable across reflow, so progress,
highlights and bookmarks all anchor by CFI. Render state is the controller's
`#highlights: Set<cfi>` + `#highlightIndex` (lazy `resolveCFI` cache); records are the
`annotations` store's `items`, an immutable `$state.raw` array replaced on every change,
with `byId` / `highlightsByCFI` maps rebuilt alongside for `isHighlighted` / `highlightAt`.

**One create/remove pair** in `Reader.svelte`:

`addHighlight(cfi, text)` paints (skipped if already highlighted), then
`addHighlightRecord` (deduped on CFI, synchronous in memory, IndexedDB in the background);
`removeHighlight(cfi)` = `removeHighlightRecord` (every record at the CFI) + unpaint. Used by
`highlightMatch`, the footer toggle and drag-select → Highlight. A panel delete
(`onRemoveAnnotation`) removes the record and unpaints only when no other record shares
the CFI; the toast's Undo re-saves the same record and repaints. `loadAnnotations` is
generation-guarded against a late load for a book already left.

**Tap-to-define** (`highlightMatch`, synchronous so a newer tap's card can't be
overwritten; only a real match on a fresh tap): `rangeForSpan(doc, positions, matchStart,
matchStart + matchLength)` → CFI → re-anchor the card to the word → `addHighlight` if
`settings.highlightLookups` (or already highlighted); the CFI backs the footer toggle.

> **Never stringify a word `Range`.** A range over ruby includes the `<rt>`, so
> `range.toString()` gives 決けっ心. `highlightMatch` builds the word from
> `positions.slice(start, end)`; `onShowAnnotation` prefers the stored record `text`.

**Drawing.** `view.addAnnotation` paints only in a loaded section (via `draw-annotation`);
unloaded ones draw when their `create-overlay` fires. `setHighlights` is called **before
`open()`** with the stored CFIs, so the opening section draws its own share during `init`
and there is no whole-book sweep; called after open it redraws the loaded sections.

**`#drawSections(indices)`** collects the highlights cached to those sections; with more
than `HIGHLIGHT_DRAW_CHUNK` it orders them `nearestFirst(cfis, lastCFI)` (parse once, sort
in document order, binary-search, alternate outward; unparseable last) so the visible page
paints first, then draws 24 per task via `setTimeout(0)` so a swipe never waits on the tail.
`#redrawGen` makes a newer sweep abandon the old one. So a highlight may not be painted yet
when `addHighlight` resolves.

---

## 10. Selection

A **250 ms-debounced** `selectionchange` per content document (`#selTimers`, one per doc)
reports a non-empty `Range` as `onSelection({doc, range, text, rect})` (top-window rect),
else `onSelectionCleared`. The `SelectionToolbar` (`placeAnchored`) offers **Highlight**
(`cfiForSelection` → `addHighlight` → `clearSelection`) and **Copy**; `clearSel` drops the
held `doc`/`range`. The paginator's drag-select auto-turn is independent.

---

## 11. `Reader.svelte` wiring

**Mount.** `prefetchEngine()` (foliate's `zip.js`/`epub.js`/`paginator.js`, else imported
serially inside `view.open`) and `warmLookupIfReady()` → `Promise.all([getBookMeta,
getBookFile, getProgress, loadAnnotations])` (no file → re-import error) → seed progress
state → `new ReaderController` → `setHighlights` → `open(file, progress?.cfi)` → ready,
TOC, `buildChapterIndex()`, DEV `installDevHook()`, `visibilitychange`/`pagehide`
listeners. `destroyed` is re-checked after every await.

**Progress.** `onRelocate` updates `fraction`, `currentCFI`, `currentTocId`, `sectionLabel`,
and calls the 600 ms-debounced `saveProgress` only once `userInteracted` (set by `onTurn`,
`jumpTo`, `seek`) — startup relocations can report a bogus fraction. The debounce is
**flushed** on `visibilitychange → hidden`, `pagehide` and destroy (iOS may kill a hidden
PWA before it fires).

**Bookmarks.** `isBookmarked` = some bookmark with `cfiWithinPage(bookmark, currentCFI)`
(start-inclusive, end-exclusive, so it survives reflow). `toggleBookmark` removes every
bookmark on the page, else saves one at `currentCFI || lastCFI`. The ribbon sits on the
fore-edge corner (`rtlBook` flips it).

**Dictionary card** (`dictState`, [japanese.md](japanese.md) for the pipeline).
`openDefine` sets the anchor (the tapped glyph from `glyphAnchor`, or a highlight's rect),
`vertical`, `lastKey`, `cfi`/`word`/`highlighted`, keeps the previous `result` if the card
was already open, and runs `runLookup`: no dictionary → `needsDownload`; a stale key
(`lastKey`) is dropped; any error clears `loading` (never a stuck spinner). The popup's
download button calls `downloadAndWarmDictionary('en')`; an `$effect` re-runs the pending
lookup as soon as `dict.state === 'ok'`, without waiting for the IPADIC warm. The popup's
X and Escape go through `closeOverlays()`, which also releases `defineDoc` /
`definePositions`. Placement: `placeNearWord(anchor, w, h, vertical, {gap: 16})` —
horizontal text above/below the word; 縦書き beside the column (left, else right, else
above/below). `placeAnchored` centres, prefers above, flips below, clamps inside the
`--safe-*` insets (cached; re-read on resize/orientation change).

**Settings & theme.** `onSettingChange(kind)`: `'appearance'` → `applyAppearance`;
`'layout'` → `applyLayout`; `'writingmode'` → `closeOverlays()` + `reopenForWritingMode`.
An `$effect` also re-applies appearance when `appearance.resolved` changes under `'auto'`
(`appliedTheme` prevents a double apply).

**Lookup worker.** On hide, `LOOKUP_IDLE_DISPOSE_MS` (60 s) later the worker is disposed if
still hidden (not on every hide: taps during a rebuild fall back to greedy segmentation).
On show, the timer is cleared and `pingLookup()` re-warms a dead worker.

**Sheets & scrubber.** `TocSheet` and `AnnotationsPanel` (`chapterOrder` = TOC labels in
reading order; `onremove` → §9) navigate via `jumpTo`; Display is a popover under Aa on
iPad. `ProgressScrubber` gets `labelAt = chapterAt` (TOC section starts via
`getSectionFractions` + `book.resolveHref`) and `onseek` → `goToFraction`; it stops its own
click so it doesn't trip `dismissChromeFromBar`.

**Destroy:** flush progress, `controller.destroy()`, `disposeLookup()`,
`clearAnnotations()`, drop DOM refs and `window.__tsuzuri`. **`.reader` CSS:** Fixed, `height: var(--app-height, 100dvh)` (not `inset: 0` — see
[storage-pwa-ios.md](storage-pwa-ios.md)), `touch-action: manipulation`. The bar capsules
must fit inside the chrome-toggle band.

---

## 12. How to extend

- **Reader setting:** `ReaderSettings` + `DEFAULT_SETTINGS` (`types.ts`) → control in
  `ReaderSettings.svelte` (`updateSettings` + `onchange(kind)`) → `appearanceCSS` or
  `applyLayout` (worked example: [development.md](development.md)).
- **Gesture:** extend `#trackGestures`, keeping the `isPrimary` guards, the cancel handling
  and the swipe-vs-tap split (§7). Content-document listeners go on that document's
  `#docACs` signal, host ones on `#ac`. Add a `ReaderCallbacks` entry and handle it in
  `Reader.svelte`. Never add latency or a guard that can swallow a tap.
- **Reading measure:** `applyLayout` knobs — margin clamp, `gap`, the `cols` breakpoint, the
  per-mode caps. Keep units and the `max-inline-size`-last order, and remember the axis swap.
- **Annotation style:** branch in `draw-annotation` (`Overlayer.underline`/`squiggly`/
  `strikethrough` exist), extend `Annotation` + store, redraw on `create-overlay`.

## 13. Gotchas

- **Swipe and animation are both ours.** Don't set `animated` (vertical slide) or un-patch
  foliate's touch turn (double turns).
- **Define vs chrome:** widening the glyph hit slack (`glyphSlack`,
  [japanese.md](japanese.md) §3) shrinks the blank space the band toggle needs; narrowing
  it makes text under the band un-lookupable.
- Also: no `reason` on `relocate`; `addAnnotation` no-ops for unloaded sections; a
  writing-mode change needs `reopenForWritingMode`; content is only reachable via `load`.

See also [architecture.md](architecture.md) (app shell, data flows),
[japanese.md](japanese.md) (extraction, lookup, worker), [ui-and-design.md](ui-and-design.md)
(tokens, `Sheet`, chrome styling), [storage-pwa-ios.md](storage-pwa-ios.md) (storage,
viewport, PWA), [development.md](development.md) (verification, the `__tsuzuri` harness).
