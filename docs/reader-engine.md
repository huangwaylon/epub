# Reader Engine

The bridge between the vendored **foliate-js** renderer and the reading
experience: page turns, taps, dictionary routing, selection, highlights,
vertical 縦書き layout. Read this before touching `src/vendor/foliate-js/`,
`src/services/reader.ts`, or `src/lib/reader/`.

Audience: engineers/LLM agents extending the reader. Signatures verified against
source; references are by symbol/file, not line number.

> **On-device status (iPad Safari, iOS 26.5, 2026-06-28).** Confirmed on real
> iOS: import, vertical RTL pagination + furigana, horizontal-swipe turns (both
> directions), the edge-band chrome toggle, tap-to-define (`caretRangeFromPoint`
> resolves words in the vertical-rl closed-shadow iframe; a try/catch wraps both
> caret APIs in `src/services/jp/extract.ts`), highlight → Notes panel, bookmarks,
> reading-position persistence. **Unverified on real iOS:** vertical column-fill
> in **landscape** (portrait shows a residual bottom dead band — open issue),
> `--app-height` cold-launch durability, Add-to-Home-Screen storage durability.

| File | Role |
| --- | --- |
| `src/services/reader.ts` | `ReaderController` — the app-facing wrapper around `<foliate-view>` |
| `src/lib/reader/Reader.svelte` | The reader screen; wires the controller to the UI |
| `src/lib/util/chromeBand.ts` | `inChromeToggleBand(py, vh)` — pure edge-band test (§8) |
| `src/services/viewport.ts` | Publishes `--app-height`; exports `viewportSize()` |
| `src/vendor/foliate-js/view.js` | Registers `<foliate-view>` (class `View`) |
| `src/vendor/foliate-js/paginator.js` | CSS-multicolumn renderer (`<foliate-paginator>`) |
| `src/vendor/foliate-js/overlayer.js` | SVG annotation overlays (`Overlayer.highlight`) |
| `src/vendor/foliate-js/epubcfi.js` | CFI parse/serialize/compare |

---

## 1. Why foliate-js, and the local patches

[foliate-js](https://github.com/johnfactotum/foliate-js) (MIT, © 2022 John
Factotum; `src/vendor/foliate-js/LICENSE`) is pure ESM with no build step,
paginates reflowable EPUB via CSS multi-column, handles vertical writing-mode
(縦書き) and RTL page progression natively, and works in DOM `Range`s + EPUB CFIs.
Upstream is explicitly unstable, so we **vendor a pinned copy**.

> **Policy.** Treat `src/vendor/foliate-js/` as third-party; app-side behaviour
> belongs in `ReaderController` / `Reader.svelte`. If you must patch a vendor file,
> keep the diff minimal, leave a `// TSUZURI PATCH: …` comment, and note it here.

Two documented patches:

- **PDF.js removed.** `src/vendor/foliate-js/vendor/` holds only `fflate.js` and
  `zip.js`. `makeBook` (view.js) dispatches zip → CBZ/FBZ/EPUB, else MOBI/KF8 →
  FB2 — no PDF branch. (`isPDF` survives as dead code; vendor `README.md` still
  lists PDF.js — stale for this fork.)
- **foliate's own touch page-turn disabled** (`paginator.js`, search
  `TSUZURI PATCH`). `#onTouchMove` keeps `e.preventDefault()` (still blocks native
  scroll and Safari's edge back-swipe) but drops the finger-follow `scrollBy`;
  `#onTouchEnd` drops the velocity `snap()`. So our swipe detector (§8) is the only
  turn input, which lets the turn animate as a horizontal slide ([§8a](#slide)).
  Touch listeners still attach; only their page-turn effect is gone. The
  selection-drag auto-turn (`checkPointerSelection`) is untouched.

MOBI/KF8, FB2, FBZ, CBZ branches are **kept** — cheap lazy dynamic `import()`s.

---

## 2. The `<foliate-view>` API we use

High-level custom element (class `View`). `ReaderController` declares the surface
it touches as the `FoliateView` interface (reader.ts).

| Member | Signature / behaviour |
| --- | --- |
| `open(book)` | `(File\|Blob\|string) => Promise<void>`. Runs `makeBook`, sets `book`, picks renderer, wires renderer→view events. **No paint yet.** |
| `init({lastLocation, showTextStart})` | If `lastLocation` (CFI/href/index) resolves, go there; else `showTextStart` jumps to bodymatter. **Triggers the first paint.** |
| `goTo(target)` | `(string\|number) => Promise`. CFI/href/section index. TOC/annotation nav. Not animated. |
| `goLeft()` / `goRight()` | **Honour `book.dir`**: `goLeft = dir==='rtl' ? next() : prev()`, `goRight` the mirror. We always use these, never raw `prev`/`next`. |
| `goToFraction(frac)` | Seek to an overall-book fraction. Backs the scrubber (§12). |
| `getCFI(index, range)` | Builds a CFI from a spine `index` + `Range`. |
| `resolveCFI(cfi)` | `{index, anchor?}` — resolves a CFI to its spine index synchronously. Caches a highlight's section. |
| `addAnnotation({value}, remove?)` | `value` is a CFI. Resolves it; if the section is loaded, fires `draw-annotation` (we paint in the handler). No-op for unloaded sections. |
| `deleteAnnotation({value})` | `= addAnnotation(a, true)`. |
| `deselect()` | Clears the selection in every loaded content doc. |
| `close()` | Tears down the renderer; called best-effort in `destroy()`/`reopenForWritingMode`. |
| `book` | `.dir`, `.metadata`, `.toc`, `.sections`, `.rendition`, `.destroy()`. |
| `renderer` | The paginator element (below). |

`renderer` (paginator) — **no JS property API**, only attributes:

| Member | Notes |
| --- | --- |
| `renderer.setStyles(css)` | Injects/replaces a `<style>` in the content-iframe doc (`applyAppearance`). String or `[before, after]`. |
| `renderer.setAttribute(name, value)` | We set only `margin`, `gap`, `max-column-count`, `max-block-size`, `max-inline-size` (`applyLayout`). foliate **also observes `flow`, but we never set it.** |
| `renderer.render()` | Re-runs `#beforeRender` + relayout for the current section. |

Other view methods (`search`, `select`, `showAnnotation`, TTS, media overlay) —
**we don't use them**; don't assume they're wired.

---

## 3. Events

`#wireView` (called once from `open()`) subscribes to these `<foliate-view>`
CustomEvents. Listeners live on the persistent host (not the renderer), so they
survive a `reopenForWritingMode`; all use `#ac`'s signal so `destroy()` removes
them in one `abort()`.

| Event | `detail` | We do |
| --- | --- | --- |
| `relocate` | `{cfi, fraction, tocItem:{label,href}, range, …}` | Store `lastCFI`; call `onRelocate`. **No `reason`** — see below. |
| `load` | `{doc, index}` (per section load) | Record `doc→index`; detect writing mode; `#applyPageProgression`; attach taps + `selectionchange`; `onLoad`. |
| `create-overlay` | `{index}` | `reapplyHighlights(index)` — redraw **only that section's** highlights (§10). |
| `draw-annotation` | `{draw, annotation:{value}, doc, range}` | `draw(Overlayer.highlight, {color: HIGHLIGHT_HEX})`. **Where a highlight is painted.** |
| `show-annotation` | `{value, index, range}` (a real **click** hit-tests the overlayer) | `onShowAnnotation(value, range)` → reopen the dictionary popup. |

**No `reason` on `relocate`.** foliate uses `reason` only for its internal
`history.replaceState`; the emitted `lastLocation` doesn't carry it. So you cannot
tell a user turn from a startup jump off this event — intent is tracked from the
gesture side (§8 `onTurn`, §12 `userInteracted`). Also: `addAnnotation` only
*requests* a draw (paint happens in `draw-annotation`); and `show-annotation` is a
real **click** on the same gesture as a tap — [§8a](#defer)'s 60ms defer
de-conflicts them.

---

## 4. ReaderController API & lifecycle

Owns exactly one `<foliate-view>` for one open book. Created by `Reader.svelte` in
`onMount`, torn down in `onDestroy`.

```ts
new ReaderController(container: HTMLElement, settings: ReaderSettings, callbacks: ReaderCallbacks)
```

Creates a `<foliate-view>` (`display:block;width:100%;height:100%`), appends it to
`container`. Nothing renders until `open()`.

**Public fields:** `view` (raw element; `view.book.toc` feeds the TOC), `lastCFI`
(last CFI from `relocate`; bookmarks fall back to it), `bookDir` (`'ltr'|'rtl'`
from `book.dir`).

**Notable private state:** `#docIndex` (`WeakMap<Document, index>`), `#highlights`
(`Set<cfi>` — source of truth for drawn ranges, single colour), `#highlightIndex`
(`Map<cfi, index>` — cached spine index per highlight, §10), `#vertical`,
`#lastLayout` (idempotency cache, [§6](#idempotency)), `#turning`/`#pendingDir`
(turn coalescing, [§8a](#slide)), `#selTimers` (per-doc selectionchange debounce,
§9), `#ac` (one `AbortController` covering every per-doc listener + the in-flight
turn `transitionend`).

### Public methods

| Method | Behaviour |
| --- | --- |
| `open(file, lastCFI?)` | Full open sequence (below). |
| `applyAppearance(s)` | Re-inject the content stylesheet via `setStyles(appearanceCSS(s))`. Live-safe (§5). |
| `applyLayout(s)` | Set paginator geometry, viewport-derived, branching on `#vertical`. Idempotent (§6). Live-safe. |
| `reopenForWritingMode(file)` | Re-`open()` at `lastCFI` — writing mode must be re-detected from the content doc (§14). |
| `goLeft()` / `goRight()` | Dir-aware turn, animated as a horizontal slide ([§8a](#slide)). Each fires `onTurn` first. |
| `goTo(target)` / `goToFraction(frac)` | TOC/annotation nav; clamped seek (backs the scrubber, §12). |
| `cfiForSelection(doc, range)` | `#docIndex` lookup → `view.getCFI`. `null` if doc unknown or CFI throws. |
| `addHighlight(cfi)` / `removeHighlight(cfi)` | Add/drop in `#highlights` + cached index, then `view.addAnnotation`/`deleteAnnotation`. |
| `setHighlights(cfis)` | Replace the whole set (book-open seed), reseed index cache, `reapplyHighlights()` (full sweep). |
| `reapplyHighlights(index?)` | `addAnnotation` for known CFIs (no-ops for unloaded). With `index`, redraw only that section's; without, sweep all. |
| `clearSelection()` | Best-effort `view.deselect()`. |
| `destroy()` | Remove resize listeners (window + `visualViewport`), clear all timers, null `#pendingDir`, **`#ac.abort()`** (every per-doc listener + in-flight turn `transitionend`), best-effort `view.close()` **then `book.destroy()`** (revokes EPUB blob URLs), remove the element. |

### `ReaderCallbacks`

```ts
interface ReaderCallbacks {
  onRelocate?:        (d: RelocateDetail) => void
  onLoad?:            (doc: Document, index: number) => void
  onTap?:             (info: TapInfo) => void
  onTurn?:            () => void                              // a user page-turn (swipe) began
  onSelection?:       (info: SelectionInfo) => void
  onSelectionCleared?:() => void
  onShowAnnotation?:  (value: string, range: Range) => void  // tap landed on a highlight
}
```

`onTurn` fires from `goLeft`/`goRight` at the start of every turn; the handler
sets `userInteracted` + `closeOverlays()` ([§8a](#slide), §12) — how a swipe
persists progress and dismisses popups, now that `relocate` carries no `reason`.

### Data types

```ts
interface RelocateDetail { cfi: string; fraction: number; tocItem?: { label?: string; href?: string }; range?: Range }
// note: no `reason` field (§3)
interface TocItem { label?: string; href?: string; subitems?: TocItem[] }
interface TapInfo {                          // no `zone` field — pagination is by swipe, not tap rails (§8)
  doc: Document | null   // content doc, or null for a margin tap
  ix: number; iy: number // coords inside the content iframe (for caretRangeFromPoint)
  px: number; py: number // top-window coords (popup placement; py feeds the chrome-toggle band test)
}
interface SelectionInfo {
  doc: Document; range: Range; text: string
  rect: { left: number; top: number; width: number; height: number }  // top-window coords
}
```

### `open()` sequence

1. `await view.open(file)` — parse + pick renderer (no paint).
2. `bookDir = view.book?.dir === 'rtl' ? 'rtl' : 'ltr'`.
3. `#wireView()` — register the five event listeners (§3).
4. `applyAppearance(settings)` then `applyLayout(settings)` — **before** `init()`,
   so the first paint already has the right styles + geometry.
5. `#attachHostGestures()` (margin taps/swipes, §8).
6. Add `resize` (window) **and** `visualViewport` resize listeners → `#onResize`.
7. `await view.init({ lastLocation: lastCFI || undefined, showTextStart: true })`
   — **first paint**.
8. `#nudgeLayout()` — schedule one re-run of `applyLayout` at 250ms (§11 hedge).

---

## 5. Appearance — `appearanceCSS(settings)`

Builds the stylesheet foliate injects into **each content iframe** via
`setStyles`. Reads live theme tokens from the host so the page matches the chrome
(one `getComputedStyle(document.documentElement)` read). Tokens: `--ink`,
`--paper`, `--accent`, `--accent-soft`, `--font-jp-sans`/`--font-serif` (per
`fontFamily`). Defined on the host `:root` — see [ui-and-design.md](ui-and-design.md).

| Selector | Declarations |
| --- | --- |
| `html` | `color: --ink`; **`background: --paper !important`**; **`color-scheme: light\|dark`** (from `s.theme`); `font-size: round(fontScale*100)%`; `-webkit-text-size-adjust: none`; writing-mode override (below) |
| `body` | `color: --ink`; `background: transparent !important`; `font-family`; `-webkit-touch-callout: none` (suppress the native iOS callout so our SelectionToolbar shows) |
| `p, li, blockquote, dd` | `line-height: {lineHeight}`; `text-align: justify`; `hyphens: auto`; `hanging-punctuation: allow-end last` |
| `[align=left/center/right]` | preserve explicit alignment attrs |
| `a:any-link` | `color: --accent` |
| `::selection` | `background: --accent-soft` |
| `rt` | `user-select: none` (ruby/furigana not selectable) |
| `pre` | `white-space: pre-wrap !important` |

<a id="paper"></a>
**Why `--paper`, not transparent.** *(Authoritative; other sections reference
this.)* The content iframe is its own document with no theme. A transparent root
composites over the iframe's default canvas — which follows `color-scheme` and is
**white** unless told otherwise — so a transparent page reads light even in dark
mode. Painting `html` with the resolved `--paper` (and setting `color-scheme`)
makes page, margins, and chrome match with no seam, and pulls form
controls/scrollbars onto the theme. `body` stays transparent so the paper shows
through; foliate's `getBackground` samples `body` then `html`, picking up the same
`--paper`.

**Writing-mode override** (only when the user picks a non-`auto` preference):
`vertical-rl !important` for `'vertical'`, `horizontal-tb !important` for
`'horizontal'`; `'auto'` injects nothing. `font-size` lives on `html` as `%` so
EPUB-relative units cascade. `setStyles` only swaps the `<style>` text, so repeated
`applyAppearance` reflows in place — no reload.

---

## 6. Layout — `applyLayout`

Maps device size + settings onto paginator attributes. Runs in `open()`, on every
resize/viewport-settle, and on a writing-mode flip. **Branches on `#vertical`**,
because the two axes swap meaning between modes (§7) and 縦書き needs the page box
derived from the viewport (the §11 fix):

```ts
const { w: vw, h: vh } = viewportSize()                     // visual viewport, stable on iOS
const minDim = Math.min(vw, vh)
const margin = Math.round(Math.max(28, Math.min(80, minDim * 0.075)) * s.marginScale)
const cols   = vw > vh && vw >= 820 ? 2 : 1                 // 2-up only in landscape on a wide screen

let block: number, inline: number
if (this.#vertical) {
  inline = Math.round(Math.max(320, vh - margin * 2))       // → max-inline-size (column HEIGHT)
  block  = Math.round(vw - margin * 2)                      // → max-block-size  (across-page WIDTH)
} else { block = 880; inline = 640 }

if (sameAsLastLayout) return                                // idempotency guard (below)
this.#lastLayout = { vertical, cols, margin, block, inline }

r.setAttribute('margin', `${margin}px`)
r.setAttribute('gap', '6%')
r.setAttribute('max-column-count', `${cols}`)
r.setAttribute('max-block-size', `${block}px`)
r.setAttribute('max-inline-size', `${inline}px`)            // LAST: its setter forces render()
```

| Attribute | Horizontal | Vertical (縦書き) |
| --- | --- | --- |
| `margin` | `clamp(28, minDim*0.075, 80) * marginScale` px | same |
| `gap` | `6%` (column gap + outer padding) | same |
| `max-column-count` | `cols` = `vw>vh && vw≥820 ? 2 : 1` (2 = landscape spread) | same |
| `max-inline-size` | `640` px — max **line length** | `max(320, vh − 2·margin)` px — column **HEIGHT** |
| `max-block-size` | `880` px — max **page height** | `vw − 2·margin` px — across-page **WIDTH** (margin frames it; the surface fills the screen) |

<a id="idempotency"></a>
**Idempotency (rotation-flicker fix).** *(Authoritative; §11, §14 reference this.)*
Setting an observed attribute re-fires foliate's `attributeChangedCallback` →
`render()` (full relayout + repaint) *even when the value is unchanged*. iOS fires
a burst of resize/visualViewport events as the viewport settles after a rotation,
so without a guard each one repainted → continuous flicker. The `#lastLayout`
cache bails when the derived geometry is unchanged. **`reopenForWritingMode` clears
`#lastLayout`** first, because the fresh paginator starts with foliate's default
attributes (so the stale cache would suppress the re-apply).

**Order:** `max-inline-size` is set last — its `attributeChangedCallback`
explicitly calls `render()` (the others only set a `--_<name>` prop), so the rest
must be in place. `margin` must be `px`; `gap` must be `%`.

**`viewportSize()`** (`src/services/viewport.ts`) returns the **visual** viewport
dimensions (reliable on iOS, incl. cold launch), falling back to `window.inner*`
only while pinch-zoomed (`scale > 1.01`). The same helper backs `--app-height`
(§11), so the foliate page box and the `.reader` container size from one source.

### `#vertical` detection (in `load`)

```ts
const wm = doc.defaultView.getComputedStyle(doc.documentElement).writingMode || ''
const vertical = wm.startsWith('vertical')
if (vertical !== this.#vertical) { this.#vertical = vertical; this.applyLayout(this.#settings) }
```

First section load detects vertical-ness and re-applies layout once if it flipped
(`applyLayout` ran with the old `#vertical` before any doc existed). Reads
`documentElement`, whereas the paginator's `getDirection` reads `body` — but the
EPUB sets writing-mode on `html` and our override (§5) also targets `html`.

### `#onResize`

150ms-debounced, wired to **both** `window` resize and `visualViewport` resize
(iOS signals the post-launch settle via the latter). Re-runs `applyLayout`,
**skipped while pinch-zoomed** (`scale > 1.01`). Relies on the
[idempotency guard](#idempotency) so the resize burst no longer repaints per event.

### 6a. RTL page order with horizontal LTR text — `#applyPageProgression`

Some EPUBs declare `page-progression-direction="rtl"` (so `book.dir === 'rtl'`)
while their content is ordinary horizontal LTR (common for JP novels typeset 横書き
but bound right-to-left). foliate derives **column order** purely from the
content's CSS direction via `getDirection(doc)`, **not** from `book.dir` (which
only feeds `goLeft`/`goRight`). So such a book paginates its 2-up landscape spread
left-to-right — wrong; the earlier page must be on the right.

`#applyPageProgression(doc, vertical)` (from `load`) makes the section behave like
a native RTL book:

- Sets `dir="rtl"` on **both** `documentElement` *and* `body`, so `getDirection`
  reports RTL and foliate's RTL path lays columns right-to-left with the matching
  negative-scroll math. (`dir="rtl"` on `documentElement` alone does **not** flip
  the columns; `body` must be rtl too.)
- Pins inline **text** back to ltr via an injected `direction: ltr` rule on block
  elements (plus `body { text-align: left }`), so horizontal Japanese still reads
  left-to-right — only page/column order reverses.

Runs inside foliate's `afterLoad` (`load` fires synchronously from it, before
`getDirection`), so the first paint is already correct. **No-op** unless `book.dir
=== 'rtl'`, the section is horizontal, and `writingMode !== 'vertical'`. Entirely
app-side — no vendor patch.

> The progress *bar* fill always grows left-to-right; only page/column order reverses.

---

## 7. Pagination internals (paginator.js)

`<foliate-paginator>` (class `Paginator`):

- **CSS multi-column.** Content lives in a sandboxed `<iframe>`; the doc's `<html>`
  is columnized (`column-width`/`column-gap`/`column-fill:auto`), sized to one
  page, expanded to N pages, and scrolled.
- **`observedAttributes`:** `flow`, `gap`, `margin`, `max-inline-size`,
  `max-block-size`, `max-column-count`. We set all but **`flow`**, which foliate
  observes but we leave at its default.
- **`attributeChangedCallback`:** `flow` → `render()`;
  `gap`/`margin`/`max-block-size`/`max-column-count` → just set `--_<name>` (a
  `ResizeObserver` relays out if geometry changed); **`max-inline-size` sets the
  prop *and* explicitly calls `render()`** (it may not change the measured size) —
  why §6 sets it last.
- **`getDirection(doc)`:** `getComputedStyle(body)` for `vertical = writingMode ===
  'vertical-rl'|'vertical-lr'`, and `rtl` from `body.dir` / computed `direction` /
  `html.dir`. Decides axis mapping per section.
- **Touch page-turn patched OUT** (§1). `checkPointerSelection` auto-turn untouched.
- **Grid + custom props.** `#top` is a CSS grid (`container-type: size`).
  Defaults: `--_gap:7%`, `--_margin:48px`, `--_max-inline-size:720px`,
  `--_max-block-size:1440px`, `--_max-column-count:2`,
  `--_max-column-count-portrait:1`. 5 columns × 3 rows so margins/heads/feet
  auto-frame the text.
- **Orientation container-query.** In `@container (orientation: portrait)`,
  `--_max-column-count-spread` collapses to the portrait count (1) for horizontal
  text; for `.vertical` it inverts (portrait vertical *gets* the spread). So
  `max-column-count=2` yields a true 2-page spread only in **landscape**.
- **Vertical axis mapping** (`.vertical` + `#beforeRender`): `size = container
  height`; `--_max-width = --_max-block-size`; `--_max-height = --_max-inline-size
  × spread`. The inline/block axes swap — the source of §6's dual meanings.

---

## 8. Taps & gestures

Gesture rationale: see [architecture.md](architecture.md). **Swipe turns the page;
tap defines or toggles chrome.** Pagination is by horizontal swipe only — no tap
edge-rails (the old `EDGE_RAIL_FRACTION` / `TapInfo.zone` are gone), and foliate's
touch turn is patched out (§1/§7).

The shared `#trackGestures` state machine drives **two** attach points (both
register every listener with `#ac`'s signal):

- **`#attachTaps(doc)`** — per loaded content doc; the **text column** (iframe),
  emits `TapInfo` with `doc` + coords. Also installs `selectionchange` (§9).
- **`#attachHostGestures()`** — once in `open()`, on the **host**. The iframe
  covers only the text column, so margin taps bubble out of foliate's shadow DOM to
  the host (iframe-internal events don't cross the browsing-context boundary → no
  double-handling). A margin tap emits `doc: null` → routes to chrome.

### Constants

| Constant | Value | Role |
| --- | --- | --- |
| `TAP_MOVE_TOLERANCE` | 16px | max down→up travel to still be a tap |
| `TAP_MAX_MS` | 400ms | max tap duration |
| `SWIPE_MIN_DISTANCE` | 45px | min horizontal travel for a page-turn swipe |
| `TURN_PHASE_MS` | 150ms | one phase (out / in) of the slide ([§8a](#slide)) |

### `pointerup` swipe-vs-tap decision

Bails if the pointer is non-primary, was cancelled, a non-empty Range selection is
active, **or the page is pinch-zoomed** (`visualViewport.scale > 1.01`, mirrors the
paginator's pinch guard). Then, from the down→up delta `dx`/`dy`:

```ts
if (Math.abs(dx) >= SWIPE_MIN_DISTANCE && Math.abs(dx) > Math.abs(dy)) {
  if (dx < 0) void this.goRight()   // dragged left  → reveal the page on the right
  else        void this.goLeft()    // dragged right → reveal the page on the left
  return
}
if (moved || e.timeStamp - downT > TAP_MAX_MS) return       // else, only a clean quick tap counts
opts.onTap(e)
```

A horizontal-dominant drag ≥ `SWIPE_MIN_DISTANCE` turns the page; `goLeft`/`goRight`
are direction-aware, so it turns correctly in LTR, RTL, and vertical books (in an
RTL 縦書き book, dragging **right** advances). A swipe `return`s before the tap
branch. On a real tap it emits `onTap({doc, ix, iy, px, py})` — `ix/iy`
(iframe-local) feed `caretRangeFromPoint`; `px/py` (top-window, via
`frameElement.getBoundingClientRect()`) place the popup.

### Tap routing in Reader.svelte

`onTap` → `handleTap` runs in a fixed order (the 60ms defer is applied in `onTap`,
[§8a](#defer)):

1. **Popup open → dismiss.** If `dictState.open`, `closeOverlays()` and `return` —
   fires for a tap **anywhere** incl. the nav-bar band. The popup is highest
   priority: a tap that clears the card never also toggles chrome or defines.
2. **Top/bottom band → toggle chrome.** `inChromeToggleBand(info.py,
   viewportSize().h)` → toggle `chromeVisible`, `return`. The band is `clamp(80,
   vh*0.12, 160)` of the **visual viewport** height (`viewportSize().h`, *not*
   `window.innerHeight`), via the pure `inChromeToggleBand(py, vh)` in
   `src/lib/util/chromeBand.ts`. The **only** way a tap *shows* the bars.
3. **Chrome visible → dismiss.** Else if `chromeVisible`, set `false` and `return`.
4. **Define a glyph.** Else, if `settings.tapToDefine`, `tryDefine(info)` — bails on
   a null `doc` (margin tap), then requires the tap to land on an actual Japanese
   glyph (`extractTextAt`'s `pointOnGlyph` rejects margins / inter-column gaps; §10,
   [japanese.md](japanese.md)). On a real match the word is auto-highlighted yellow
   (§10). A blank-**centre** tap does nothing.

**Hiding the chrome again.** Once visible the bars cover the edge bands, so they
hide themselves: `<header>`/`<footer>` carry `role="presentation"` +
`onclick={dismissChromeFromBar}`, which sets `chromeVisible = false` unless a
control was hit (`e.target.closest('button')`). Bar taps are native `click`s on
sibling overlays and never reach the foliate-view detector. While the chrome is
hidden a `pointer-events:none` `.page-pct` pill shows the reading %.

<a id="slide"></a>
### 8a. Page-turn animation — horizontal slide (`#turn` / `#slide`)

*(Authoritative; §1, §7, §14 reference this.)* foliate stacks 縦書き pages on the
**vertical** axis, so its own `animated` turn slides up/down — wrong for a Japanese
book. So we leave `animated` **off**, patch its touch turn out (§1/§7), and drive
the visual ourselves like Books on iPad. `goLeft`/`goRight` fire `onTurn`, then
`#turn(dir)` → `#slide(dir)`:

1. Slide the whole `<foliate-view>` out to one edge
   (`transform: translateX(±100%)`, `TURN_PHASE_MS`).
2. Jump to the target page while off-screen — `await view.goLeft()/goRight()`,
   instant because `animated` is off (direction-aware, correct for LTR + RTL).
3. Slide the new page in from the opposite edge to `translateX(0)`.

One continuous horizontal push. Both phases are **`transitionend`-driven**
(`#transition`, with a `TURN_PHASE_MS + 120`ms fallback) so timer drift can't leave
a blank-paper gap; the fallback `setTimeout` is held on `#slideTimer` so a
`destroy()` mid-turn clears it (`#ac.abort()` removes the listener but can't cancel
a bare timer). A `#turning` flag + a single `#pendingDir` **coalesce rapid swipes**
(the latest queued turn runs when the current finishes). A literal page-**curl**
isn't possible (closed-shadow-DOM iframe can't be rasterised), and only one page
renders at a time, so the vacated strip shows the paper background (intended).
`goTo()` is **not** animated.

<a id="defer"></a>
**60ms highlight de-conflict.** A real `click` fires on the same gesture as our tap
and may hit-test a highlight → `show-annotation`. So `onTap` defers `handleTap` by
~60ms via `pendingTap` *only when `hasHighlights`* (the click→show-annotation hop
can trail `pointerup` by several frames on touch). If `onShowAnnotation` fires first
it clears `pendingTap` and **reopens the dictionary popup** for that highlight
instead of defining-and-re-highlighting. With no highlights the tap runs
immediately. `pendingTap` is cleared in `onDestroy` and on `closeOverlays()`.

**Overlays close on a turn.** Because `relocate` carries no `reason` (§3),
overlay-close is gesture-driven: `goLeft`/`goRight` fire `onTurn`; TOC/annotation
nav and a scrubber seek do the equivalent (§12).

---

## 9. Selection

`#attachTaps` installs a **250ms-debounced** `selectionchange` listener on the
content doc (same `#ac` signal). The timer is held **per document** in `#selTimers`
so a landscape 2-up spread (two docs) can't clobber the other's pending callback.
`destroy()` clears every timer. When the debounce fires with a non-empty Range:

```ts
const range = sel.getRangeAt(0)
const r  = range.getBoundingClientRect()
const fr = frame?.getBoundingClientRect()   // iframe → top-window offset
onSelection({ doc, range, text: sel.toString(),
  rect: { left: fr.left + r.left, top: fr.top + r.top, width: r.width, height: r.height } })
```

Otherwise `onSelectionCleared()`. The top-window `rect` positions the
`SelectionToolbar` (via `placeAnchored`, §12). `onSelection` opens the toolbar with
**Highlight** (`cfiForSelection` → `saveAnnotation` → `addHighlight` →
`clearSelection`; always yellow) and **Copy** (`navigator.clipboard.writeText`). A
page turn closes the toolbar via `closeOverlays()`. The paginator independently
watches `selectionchange` to auto-turn while dragging a selection past the page
edge — its own concern, doesn't interfere.

---

## 10. Highlights & CFI

Single colour (yellow, `HIGHLIGHT_HEX` in `types.ts`). `#highlights: Set<cfi>` is
the **source of truth**; no per-highlight colour. Persistence is separate — the
`annotations` store (see [storage-pwa-ios.md](storage-pwa-ios.md),
[japanese.md](japanese.md)) holds durable records (a highlight `Annotation` has
**no `color` field**); `#highlights` is the in-memory render state.

**Two ways a highlight is created:**

1. **Tap-to-define (primary).** Tapping a Japanese word looks it up *and* highlights
   the matched word. `extractTextAt` returns a `positions` array (`CharPosition[]`,
   index → `{node, offset}`); `lookupAt` returns `matchStart` + `matchLength`. On a
   real match, `rangeForSpan(doc, positions, matchStart, matchStart + matchLength)`
   rebuilds a `Range` for exactly the matched word (it can straddle text nodes — a
   kanji compound with ruby splits its base text, hence an index→node map, not a
   string offset), `cfiForSelection` → CFI, then `saveAnnotation` + `addHighlight`.
   The popup's footer toggle removes/re-adds without closing the card.
2. **Drag-select (§9).** Selection → the toolbar's **Highlight** action.

**Draw/paint flow:** `addHighlight`/`setHighlights` records the CFI (caches its
spine index via `#indexForCFI` → `view.resolveCFI`), then `view.addAnnotation`:

- Section **loaded** → view emits `draw-annotation`; the handler calls
  `draw(Overlayer.highlight, {color: HIGHLIGHT_HEX})` — filled `<rect>`s at the
  range's client rects, at `opacity: var(--overlayer-highlight-opacity, .3)`.
- **Not loaded** → no-op. When that section later paints, `create-overlay`
  `{index}` → `reapplyHighlights(index)` → `addAnnotation` for **only that
  section's** known CFIs (against the cached `cfi→index` map). Keeps a page-turn
  O(highlights-in-that-section), not O(all-highlights) — important because
  tap-to-define grows the set.

> `setHighlights` deliberately does **not** pre-resolve every CFI's spine index on
> the book-open critical path (that would parse each CFI twice — once here, once in
> `addAnnotation`). `#highlightIndex` is filled lazily by `reapplyHighlights(index)`
> as each section loads.

**CFI creation:** `cfiForSelection(doc, range)` → `#docIndex` spine index →
`view.getCFI(index, range)`; `null` if the doc is unknown or CFI throws. CFIs are
stable across reflow/font changes, which is why annotations + progress anchor by
CFI (`epubcfi.js`: `fromRange`, `toRange`, `compare`).

**Tapping an existing highlight** → `show-annotation` → `onShowAnnotation` reopens
the dictionary popup for that word (looks up `range.toString()`, shows the
definition + `Remove highlight` toggle). No separate recolor/delete toolbar.

---

## 11. Vertical column-fill quirk & viewport (iOS)

<a id="column-fill"></a>
*(Authoritative; CLAUDE.md and §6 point here.)*

**Status.** With viewport-derived `applyLayout` (§6) the vertical page box **fills
on the first paint** — verified in desktop Chrome at 1194×834 landscape (`#container`
≈ 1068×708) and 834×1194 portrait (≈ 560×1068), no nudge needed.

**Old root cause.** In landscape vertical, foliate's `.vertical` container-query
sets the across-page spread to the *portrait* count (1), so `--_max-height =
max-inline-size × 1`. The old code hard-coded `max-inline-size: 1100`, letting
`#container` settle ~1.7× too tall on an 834px viewport, overflowing it and leaving
a dead band. Side margins + text *measure* were always correct — only the block-axis
size was wrong.

**The fix.** Derive the caps from the live viewport (§6): vertical `max-inline-size
= max(320, vh − 2·margin)` and `max-block-size = vw − 2·margin`. Because the
landscape vertical spread is 1, deriving `max-inline-size` from `vh` clamps
`--_max-height` deterministically.

**Hedges** (both rely on the [idempotency guard](#idempotency) so a redundant call
costs nothing): **`#nudgeLayout()`** re-runs `applyLayout` once at 250ms after
`init` (a cold PWA launch settles the viewport/insets slightly after first paint, so
the first `applyLayout` can derive a too-short column — re-deriving clears it
without a rotation; it re-runs `applyLayout`, **not** a bare `render()`, which would
reuse the stale `max-inline-size`); **`#onResize`** (§6) on both `window` and
`visualViewport` is the reliable backstop, skipped while pinch-zoomed.

**`--app-height` (consumer contract).** The fixed `.reader` overlay sizes off
`var(--app-height, 100dvh)`, because a fresh standalone launch lays out `inset:0` /
`100dvh` against an under-reported layout viewport, leaving a gap below a
bottom-anchored bar that otherwise only clears on rotation. `viewportSize()` (§6)
reads the same source that publishes `--app-height`. The **publisher** mechanics
(`initViewport`, the rAF/2px/load+300ms write gating, why only this fixed
out-of-flow element may consume the var) live in
[storage-pwa-ios.md](storage-pwa-ios.md) §7.

---

## 12. Reader.svelte wiring

The screen; owns no rendering, only orchestration.

**Mount** (`onMount`): `Promise.all([getBookMeta, getBookFile, getProgress])` →
throw if no file (re-import message) → **seed displayed progress** from saved
`progress` so the bar is correct before the first relocate → `new
ReaderController(host, settings, callbacks)` → `controller.open(file,
progress?.cfi)` → read `view.book?.toc` → `loadAnnotations(bookId)` →
`setHighlights(highlight CFIs)` → `status='ready'`; register `visibilitychange`;
warm the lookup worker if the dict is ready. Errors → `status='error'` + a
back-to-library CTA.

**Reactive state** (`$state`/`$derived`): `chromeVisible`, `fraction`,
`sectionLabel`, `currentCFI`, `isBookmarked` (bookmark at `currentCFI`),
`hasHighlights` (gates the 60ms tap-defer, [§8a](#defer)). A module-scope
`userInteracted` flag gates progress persistence.

**Callbacks → UI:**

- `onRelocate` → update `fraction`/`currentCFI`/`sectionLabel`, then the
  **600ms-debounced `saveProgress`** *only when* `userInteracted` — so noisy startup
  relocations (bogus fraction) don't persist a misleading position. `userInteracted`
  is set entirely from the gesture/nav side (`onTurn`, `navigate`, `navAnnotation`,
  `seek`), since `relocate` has no `reason` (§3).
  > **Fraction caveat.** foliate's `relocate.fraction` is an *overall-book* fraction
  > incl. the page's trailing-edge term; the tiny test EPUB reports a large % on
  > page 1, a real book ≈ 0–1%. foliate's progress model, not a bug — the
  > persistence gating prevents a bogus *restore*.
- `onTurn` → `userInteracted = true`, `chromeVisible = false`, `closeOverlays()`.
- `onTap` → §8 routing (with the 60ms defer when `hasHighlights`).
- `onSelection`/`onSelectionCleared` → drive the `SelectionToolbar`.
- `onShowAnnotation` → clears `pendingTap`, reopens the `DictionaryPopup` via
  `openDefine({existingCfi, …})`.

**Visibility (memory).** A `visibilitychange` handler `disposeLookup()`s on hide
(shed the resident kuromoji trie so iOS is less likely to kill the backgrounded
tab) and re-warms on return (`warmupLookup`, if `tapToDefine` + dict ready) — no
network (re-warms from the SW cache; see [japanese.md](japanese.md)).

**Sheets & popups:** `TocSheet` (`onnavigate` → `goTo(href)`), `ReaderSettings`
(`onchange(kind)` → `applyAppearance`/`applyLayout`/`reopenForWritingMode` per
`'appearance'|'layout'|'writingmode'`), `AnnotationsPanel` (`onnavigate` →
`goTo(cfi)`), `DictionaryPopup`.

**One `SelectionToolbar`** — fresh selections only (`open, rect, onHighlight,
onCopy`). Editing an existing highlight routes through the dictionary popup (§10).

**Define + highlight in one popup.** `tryDefine` → `openDefine({text, tapOffset,
px, py, doc, positions})`; `runLookup` resolves and, on a real match, calls
`autoHighlight` (build the word `Range` from `positions` + `matchStart`/`matchLength`,
CFI it, save + `addHighlight`). `dictState` carries `cfi`/`highlighted`/`word` so the
footer toggle (`ontogglehighlight` → `toggleWordHighlight`) removes/re-adds without
closing the card. A stale-lookup guard (`lastKey`) drops a superseded lookup. If the
dict isn't installed, the popup shows a download prompt; `downloadDict` calls
**`downloadAndWarmDictionary('en')`** (downloads JMdict then warms kuromoji while
online) before retrying (see [japanese.md](japanese.md)).

**Progress scrubber** (`ProgressScrubber.svelte`, `{fraction, sectionLabel,
onseek}`). Press-and-drag fast-scroll; the press must cross an **8px (touch) / 4px
(mouse)** dead-zone before it arms, the seek (`onseek` → `seek` → `goToFraction`)
commits only on **release**, and a clean tap is a no-op. It `stopPropagation`s its
own click so it doesn't trip `dismissChromeFromBar`. **DictionaryPopup** positions
via `placeAnchored`, re-placing on `x`/`y` *or content* change. **Chrome:** top bar
(library / notes / display) + bottom bar (TOC / scrubber / bookmark);
`toggleBookmark` toggles a `bookmark` annotation at `currentCFI || lastCFI`.

**Destroy** (`onDestroy`): clear `pendingTap`, remove `visibilitychange`,
`saveProgress.cancel()`, `controller.destroy()`, `disposeLookup()`,
`clearAnnotations()`, drop retained `defineDoc`/`definePositions`.

### Anchored positioning

`placeAnchored(centerX, anchorTop, anchorBottom, w, h, opts)`
(`src/lib/util/anchoredPosition.ts`) is shared by the dictionary popup and the
selection toolbar: centres on `centerX`, **prefers above** the anchor and flips
below on a top-margin collision, and clamps inside the viewport honouring `--safe-*`
insets. All coords top-window. The popup passes `gap: 16`; the toolbar uses the
default.

---

## 13. How to extend

**Add a reader setting.** Add the field to `ReaderSettings` + `DEFAULT_SETTINGS`
(`src/services/types.ts`); add a control in `ReaderSettings.svelte` that calls
`updateSettings({...})` then `onchange(kind)`. Route: stylesheet → `appearanceCSS`
+ `'appearance'`; geometry → `applyLayout` + `'layout'`; writing-mode →
`'writingmode'` → `reopenForWritingMode`.

**Add a gesture.** Extend `#trackGestures`. Reuse the pointer bookkeeping
(`active`/`moved`/`downT`, the `isPrimary` guard, the `pointercancel` abort, the
swipe-vs-tap split). **Register with `#ac`'s `{ signal }`** so `destroy()` cleans it
up. Keep it from colliding with the `SWIPE_MIN_DISTANCE`/horizontal-dominant rule.
For e.g. long-press, gate on `e.timeStamp - downT > TAP_MAX_MS` + no movement, add a
`ReaderCallbacks` entry, handle it in `Reader.svelte`. Translate coords to
top-window via `frameElement.getBoundingClientRect()` (or reuse `placeAnchored`).

**Change the reading measure.** Tune `applyLayout` — it **branches on `#vertical`**.
Knobs: the margin clamp, `gap` `'6%'`, the `cols` breakpoint (`vw > vh && vw >=
820`), per-mode caps (horizontal `640`/`880`; vertical `max(320, vh − 2·margin)` /
`vw − 2·margin`). Keep `margin` in `px`, `gap` in `%`, `max-inline-size` set
**last**, and remember the axis swap (§6/§7) and landscape-only 2-up gate.

**Add a new annotation type.** Today only `Overlayer.highlight` is used. For e.g.
underline: in `draw-annotation`, branch on the kind and call
`draw(Overlayer.underline, {...})` / `squiggly` / `strikethrough` (overlayer.js).
Extend the `Annotation` model + `annotations` store, and seed via `setHighlights`-
style logic so they redraw on `create-overlay`.

**Patch a vendor file.** Follow §1: minimal diff, `// TSUZURI PATCH:` comment, a
note here. The paginator has no JS property API (attributes only) and a closed
shadow DOM.

---

## 14. Gotchas

- **Swipe AND the turn animation are both ours.** Foliate's touch turn is patched
  out (§1/§7) and `animated` is left **off** ([§8a](#slide)); our `pointerup`
  detector (§8) is the only thing that turns pages, and `#slide` is the only
  animation. Don't re-add `animated` (its vertical slide would fight the horizontal
  one) and don't un-patch the touch turn (you'd double-handle the swipe).
- **The iframe is `sandbox="allow-same-origin allow-scripts"`.** Both are required
  for events to fire (WebKit bug 218086) and produce a benign "…can escape its
  sandboxing" console warning. Expected — don't drop a flag. EPUB scripts are *not*
  executed by foliate.
- **Content lives in a CLOSED shadow DOM.** Both `View` and the paginator use
  `attachShadow({ mode:'closed' })`. You **cannot** reach content via
  `querySelector`/`shadowRoot`. The only handle to a content `Document` is the
  `load` event's `doc` (in `#docIndex`, passed to `onLoad`/`onTap`/`onSelection`).
- **Writing-mode toggle requires `reopenForWritingMode`.** `applyAppearance`'s
  injected `writing-mode` override changes the CSS, but the paginator's vertical/RTL
  axis decisions were made from `getDirection(doc)` at load and are **not** re-derived
  on a style swap. So flipping horizontal⇄vertical must go through
  `reopenForWritingMode(file)`. A bare re-open would orphan the old renderer (iframe
  doc, two ResizeObservers, touch listeners, the Book's blob URLs leak), so it calls
  `view.close()` **then** `oldBook.destroy()` first, and clears `#lastLayout`
  ([§6](#idempotency)).
- **`addAnnotation` is async + lossy for unloaded sections.** It silently no-ops if
  the section isn't loaded; rely on `create-overlay` → `reapplyHighlights` to
  backfill. Don't assume a highlight painted just because `addHighlight` resolved.
- **Define and page-turn don't collide.** Pagination is by swipe, define by tap (a
  swipe `return`s before the tap branch, §8); define fires *only on an actual glyph*
  (`extractTextAt` returns `null` in margins/gaps; §10) and only when no popup is
  open. If you change `SWIPE_MIN_DISTANCE` or the glyph hit-slack, preserve that.

---

## 15. Cross-references

- [architecture.md](architecture.md) — app shell, routing, stores, services.
- [japanese.md](japanese.md) — `extractTextAt`/`looksJapanese`, dictionary lookup,
  segmentation/deinflection, the `glyphSlack` hit-test math, the `annotations` store.
- [ui-and-design.md](ui-and-design.md) — theme tokens, `Sheet`/`SelectionToolbar`,
  chrome styling.
- [storage-pwa-ios.md](storage-pwa-ios.md) — OPFS book bytes, IndexedDB
  (`getProgress`/`putProgress`, annotations), PWA + iOS specifics.
- [deployment.md](deployment.md) — GitHub Pages deploy, the `/epub/` base path, CI.
