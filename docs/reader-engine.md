# Reader Engine

The bridge between the vendored **foliate-js** renderer and the reading
experience: page turns, taps, dictionary routing, selection, highlights,
vertical 縦書き layout. Read this before touching `src/vendor/foliate-js/`,
`src/services/reader.ts`, or `src/lib/reader/`.

Audience: engineers/LLM agents extending the reader. Signatures and paths were
verified against source; references are by symbol/file, not line number.

> **On-device caveat (stated once).** Everything here was verified only in
> desktop Chrome via the chrome-devtools MCP (iPad-landscape emulation, mostly
> 1194×834). The swipe-to-turn feel, `caretRangeFromPoint` in vertical-rl
> iframes, and the viewport-derived vertical fill are **not yet confirmed on
> real iOS**. Re-test on a physical device if you change those areas.

| File | Role |
| --- | --- |
| `src/services/reader.ts` | `ReaderController` — the entire app-facing wrapper around `<foliate-view>` |
| `src/lib/reader/Reader.svelte` | The reader screen; wires the controller to the UI |
| `src/services/viewport.ts` | Publishes `--app-height`; exports `viewportSize()` |
| `src/vendor/foliate-js/view.js` | Registers `<foliate-view>` (class `View`) |
| `src/vendor/foliate-js/paginator.js` | CSS-multicolumn renderer (`<foliate-paginator>`) |
| `src/vendor/foliate-js/overlayer.js` | SVG annotation overlays (`Overlayer.highlight`) |
| `src/vendor/foliate-js/epubcfi.js` | CFI parse/serialize/compare |

---

## 1. Why foliate-js, and the local patches

[foliate-js](https://github.com/johnfactotum/foliate-js) (MIT, © 2022 John
Factotum; see `src/vendor/foliate-js/LICENSE`) is pure ESM with no build step,
paginates reflowable EPUB via CSS multi-column, handles vertical writing-mode
(縦書き) and RTL page progression natively, and works in DOM `Range`s + EPUB
CFIs. Upstream is explicitly unstable, so we **vendor a pinned copy**.

> **Policy.** Treat `src/vendor/foliate-js/` as third-party. App-side behaviour
> belongs in `ReaderController` / `Reader.svelte`. If you must patch a vendor
> file, keep the diff minimal, leave a `// TSUZURI PATCH: …` comment at the
> site, and note it here.

Two documented patches:

- **PDF.js removed.** `src/vendor/foliate-js/vendor/` holds only `fflate.js` and
  `zip.js`. `makeBook` (view.js) dispatches zip → CBZ / FBZ / EPUB, else
  MOBI/KF8 → FB2 — there is no PDF branch. (`isPDF` survives as dead code; safe
  to ignore. The vendor `README.md` still lists PDF.js under "Vendored
  libraries" — stale for this fork.)
- **foliate's own touch page-turn disabled** (`paginator.js`, search
  `TSUZURI PATCH`). `#onTouchMove` keeps its `e.preventDefault()` (still blocks
  native scroll and Safari's edge back-swipe) but drops the finger-follow
  `scrollBy`; `#onTouchEnd` drops the velocity `snap()`. So foliate no longer
  turns pages on touch — our own horizontal swipe detector (§8) is the only turn
  input, which lets the turn animate as a horizontal **slide** (§8a) — correct
  for 縦書き, where foliate's own motion is on the vertical axis. (The touch
  listeners still attach; only their page-turn effect is gone. The independent
  selection-drag auto-turn, `checkPointerSelection`, is untouched.)

MOBI/KF8, FB2, FBZ, CBZ branches are **kept** — cheap lazy dynamic `import()`s.

---

## 2. The `<foliate-view>` API we use

`<foliate-view>` is the high-level custom element (class `View`,
`customElements.define('foliate-view', View)`). `ReaderController` declares the
surface it touches as the `FoliateView` interface (reader.ts).

| Member | Signature / behaviour |
| --- | --- |
| `open(book)` | `(File\|Blob\|string) => Promise<void>`. Runs `makeBook`, sets `book`, picks paginator vs fixed-layout renderer, wires renderer→view events. **No paint yet.** |
| `init({lastLocation, showTextStart})` | Navigates: if `lastLocation` (CFI/href/index) resolves, go there; else `showTextStart` jumps to bodymatter (`goToTextStart`). **Triggers the first paint.** |
| `goTo(target)` | `(string\|number) => Promise`. CFI, href, or section index. TOC/annotation nav. Not animated. |
| `goLeft()` / `goRight()` | **Honour `book.dir`**: `goLeft = dir==='rtl' ? next() : prev()`, `goRight` the mirror. Critical for RTL/vertical, where a left turn must advance. We always use these, never raw `prev`/`next`. |
| `goToFraction(frac)` | Seek to an overall-book fraction. Backs the scrubber (§12). |
| `getCFI(index, range)` | Builds a CFI from a spine `index` + `Range`. |
| `resolveCFI(cfi)` | `{index, anchor?}` — resolves a CFI to its spine index synchronously. Used to cache a highlight's section. |
| `addAnnotation({value}, remove?)` | `value` is a CFI. Resolves it, finds the section overlayer; if loaded, fires `draw-annotation` (we paint in the handler). No-op for unloaded sections. Returns `{index, label}`. |
| `deleteAnnotation({value})` | `= addAnnotation(a, true)`. |
| `deselect()` | Clears the selection in every loaded content doc. |
| `close()` | Tears down the renderer; called best-effort in `destroy()`/`reopenForWritingMode`. |
| `book` | `.dir`, `.metadata`, `.toc`, `.sections`, `.rendition`, `.destroy()`. |
| `renderer` | The paginator element (below). |

`renderer` (paginator) members we touch — it has **no JS property API**, only
attributes:

| Member | Notes |
| --- | --- |
| `renderer.setStyles(css)` | Injects/replaces a `<style>` in the content-iframe doc. Used by `applyAppearance`. Accepts a string or `[before, after]`. |
| `renderer.setAttribute(name, value)` | Layout config. Observed: `flow`, `gap`, `margin`, `max-inline-size`, `max-block-size`, `max-column-count`. Used by `applyLayout`. |
| `renderer.render()` | Re-runs `#beforeRender` + relayout for the current section. |

Many other view methods exist (`search`, `select`, `showAnnotation`, TTS, media
overlay) — **we don't use them**; don't assume they're wired.

---

## 3. Events

`#wireView` (called once from `open()`) subscribes to these `<foliate-view>`
CustomEvents. The listeners live on the persistent host (not the renderer), so
they survive a `reopenForWritingMode` re-open; all are registered with `#ac`'s
signal so `destroy()` removes them in one `abort()`.

| Event | `detail` | We do |
| --- | --- | --- |
| `relocate` | `{cfi, fraction, tocItem:{label,href}, range, …}` | Store `lastCFI`; call `onRelocate({cfi, fraction, tocItem, range})`. **No `reason`** — see note below. |
| `load` | `{doc, index}` (once per section load) | Record `doc→index` in `#docIndex`; detect writing mode; `#applyPageProgression`; attach taps + `selectionchange`; call `onLoad`. |
| `create-overlay` | `{index}` (a section's overlay was created) | `reapplyHighlights(index)` — redraw **only that section's** highlights (see §10). |
| `draw-annotation` | `{draw, annotation:{value}, doc, range}` | `draw(Overlayer.highlight, {color: HIGHLIGHT_HEX})`. **This is where a highlight is painted.** |
| `show-annotation` | `{value, index, range}` (a real **click** hit-tests the overlayer) | `onShowAnnotation(value, range)` → reopen the dictionary popup for that word. |

**No `reason` on `relocate`.** foliate's `#onRelocate` destructures a `reason`
off the paginator event but uses it only for its internal `history.replaceState`;
the `lastLocation` object it emits does **not** carry `reason`. So you cannot
tell a user turn from a startup jump off this event — intent is tracked from the
gesture side instead (§8 `onTurn`, §12 `userInteracted`).

Two asymmetries: `addAnnotation` only *requests* a draw (paint happens in our
`draw-annotation` handler); and `show-annotation` is a real **click**, so it
fires on the same gesture as a tap — §8a's 60ms defer de-conflicts them.

---

## 4. ReaderController API & lifecycle

`ReaderController` owns exactly one `<foliate-view>` for one open book. Created
by `Reader.svelte` in `onMount`, torn down in `onDestroy`.

### Constructor

```ts
new ReaderController(container: HTMLElement, settings: ReaderSettings, callbacks: ReaderCallbacks)
```

Creates a `<foliate-view>` (`display:block;width:100%;height:100%`) and appends
it to `container`. Nothing renders until `open()`.

### Public fields

| Field | Type | Meaning |
| --- | --- | --- |
| `view` | `FoliateView` | Raw element. `view.book.toc` feeds the TOC sheet. |
| `lastCFI` | `string` | Last CFI seen on `relocate`. Bookmarks fall back to it. |
| `bookDir` | `'ltr'\|'rtl'` | From `book.dir`; most vertical JP novels are `'rtl'`. |

Notable private state: `#docIndex` (`WeakMap<Document, index>`), `#highlights`
(`Set<cfi>` — the **source of truth** for which ranges are drawn; single colour,
no per-highlight map), `#highlightIndex` (`Map<cfi, index>` — caches each
highlight's spine index, §10), `#vertical`, `#lastLayout` (the idempotency cache,
§6), `#turning`/`#pendingDir` (page-turn coalescing, §8a), `#selTimers`
(`Map<Document, timer>` — per-doc selectionchange debounce, §9), and `#ac` (one
`AbortController` whose signal is on **every** per-doc listener and the in-flight
turn `transitionend`).

### Public methods

| Method | Behaviour |
| --- | --- |
| `open(file, lastCFI?)` | Full open sequence (below). |
| `applyAppearance(s)` | Re-inject the content stylesheet via `renderer.setStyles(appearanceCSS(s))`. Live-safe (§5). |
| `applyLayout(s)` | Set paginator geometry attributes, viewport-derived, branching on `#vertical`. Idempotent (§6). Live-safe. |
| `reopenForWritingMode(file)` | Re-`open()` at `lastCFI` because writing mode must be re-detected from the content doc (§14). |
| `goLeft()` / `goRight()` | Dir-aware turn, animated as a horizontal slide (§8a). Each fires `onTurn` first. |
| `goTo(target)` | TOC / annotation nav. |
| `goToFraction(frac)` | Clamped seek; backs the scrubber (§12). |
| `cfiForSelection(doc, range)` | `#docIndex` lookup → `view.getCFI`. `null` if doc unknown or CFI throws. |
| `addHighlight(cfi)` | Add to `#highlights`, cache its index (`#indexForCFI`), `view.addAnnotation` (paints if loaded). |
| `removeHighlight(cfi)` | Drop the CFI + cached index, `view.deleteAnnotation`. |
| `setHighlights(cfis)` | Replace the whole set (book-open seed), reseed the index cache, `reapplyHighlights()` (full sweep). |
| `reapplyHighlights(index?)` | `addAnnotation` for known CFIs (no-ops for unloaded sections). With `index`, redraw only that section's highlights; without, sweep all. |
| `clearSelection()` | Best-effort `view.deselect()`. |
| `destroy()` | Remove resize listeners (window + `visualViewport`), clear all timers (`#resizeTimer`, `#nudgeTimer`, `#slideTimer`, every `#selTimers` entry), null `#pendingDir`, **`#ac.abort()`** (removes every per-doc tap/selection listener + any in-flight turn `transitionend` at once), best-effort `view.close()` **then `book.destroy()`** (revokes the EPUB's resource blob URLs), remove the element. |

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

`onTurn` fires from `goLeft`/`goRight` at the start of every turn. `Reader.svelte`'s
handler sets `userInteracted` and calls `closeOverlays()` (§8a, §12) — this is
how a swipe persists progress and dismisses anchored popups, now that `relocate`
carries no `reason`.

### Data types

```ts
interface RelocateDetail { cfi: string; fraction: number; tocItem?: { label?: string; href?: string }; range?: Range }
// note: no `reason` field (§3)

interface TocItem { label?: string; href?: string; subitems?: TocItem[] }  // a book.toc entry

interface TapInfo {                          // no `zone` field — pagination is by swipe, not tap rails (§8)
  doc: Document | null   // content doc, or null for a margin tap (host gesture; nothing to define there)
  ix: number; iy: number // coords inside the content iframe (for caretRangeFromPoint)
  px: number; py: number // coords in the top window (popup placement; py also feeds the chrome-toggle band test)
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
6. Add `resize` (window) **and** `visualViewport` resize listeners → `#onResize`
   (§6, §11).
7. `await view.init({ lastLocation: lastCFI || undefined, showTextStart: true })`
   — **first paint**.
8. `#nudgeLayout()` — schedule one re-run of `applyLayout` at 250ms (§11 hedge).

---

## 5. Appearance — `appearanceCSS(settings)`

`appearanceCSS(s)` builds the stylesheet foliate injects into **each content
iframe** via `setStyles`. It reads the live theme tokens from the host document
so the page matches the chrome:

```ts
const cs = getComputedStyle(document.documentElement)  // one read; forces a style flush
```

Tokens: `--ink`, `--paper`, `--accent`, `--accent-soft`, and `--font-jp-sans`
(when `fontFamily === 'sans'`) or `--font-serif`. Defined on the host `:root` —
see [ui-and-design.md](ui-and-design.md).

| Selector | Declarations |
| --- | --- |
| `html` | `color: --ink`; **`background: --paper !important`**; **`color-scheme: light\|dark`** (from `s.theme`); `font-size: round(fontScale*100)%`; `-webkit-text-size-adjust: none`; writing-mode override (below) |
| `body` | `color: --ink`; `background: transparent !important`; `font-family`; `-webkit-touch-callout: none` (suppress the native iOS callout so our SelectionToolbar shows) |
| `p, li, blockquote, dd` | `line-height: {lineHeight}`; `text-align: justify`; `hyphens: auto`; `hanging-punctuation: allow-end last` |
| `[align=left/center/right]` | preserve explicit alignment attrs |
| `a:any-link` | `color: --accent` |
| `::selection` | `background: --accent-soft` |
| `rt` | `user-select: none` (ruby/furigana not selectable — keeps base-text selections clean) |
| `pre` | `white-space: pre-wrap !important` |

**Why `--paper`, not transparent.** The content iframe is its own document with
no theme. A transparent root composites over the iframe's **default canvas**,
which follows `color-scheme` and is **white** unless told otherwise — so a
transparent page reads light even in dark mode. Painting `html` with the resolved
`--paper` (and setting `color-scheme`) makes the page, margins, and chrome match
with no seam, and pulls form controls/scrollbars onto the theme. `body` stays
transparent so the paper shows through; foliate's `getBackground` samples `body`
then `html`, so it picks up the same `--paper`.

**Writing-mode override** (only when the user picks a non-`auto` preference):
`vertical-rl !important` for `'vertical'`, `horizontal-tb !important` for
`'horizontal'`. `'auto'` injects nothing, letting the EPUB decide. `font-size`
lives on `html` (not `body`) as a `%`, so EPUB-relative units cascade. Because
`setStyles` only swaps the `<style>` text, repeated `applyAppearance` is cheap and
reflows in place — no reload.

---

## 6. Layout — `applyLayout`

`applyLayout(s)` maps device size + settings onto paginator attributes. It runs
in `open()`, on every resize/viewport-settle, and on a writing-mode flip. It
**branches on `#vertical`**, because the two axes swap meaning between modes (§7)
and 縦書き needs the page box derived from the viewport (the §11 fix):

```ts
const { w: vw, h: vh } = viewportSize()                     // visual viewport, stable on iOS (§11)
const minDim = Math.min(vw, vh)
const margin = Math.round(Math.max(28, Math.min(80, minDim * 0.075)) * s.marginScale)
const cols   = vw > vh && vw >= 820 ? 2 : 1                 // 2-up only in landscape on a wide screen

let block: number, inline: number
if (this.#vertical) {
  inline = Math.round(Math.max(320, vh - margin * 2))       // → max-inline-size (column HEIGHT)
  block  = Math.round(vw - margin * 2)                      // → max-block-size  (across-page WIDTH)
} else {
  block = 880; inline = 640
}

// Idempotency guard (rotation-flicker fix): bail when {vertical,cols,margin,block,inline}
// equals #lastLayout, so a settling-viewport event burst does no work.
if (sameAsLastLayout) return
this.#lastLayout = { vertical, cols, margin, block, inline }

r.setAttribute('margin', `${margin}px`)
r.setAttribute('gap', '6%')
r.setAttribute('max-column-count', `${cols}`)
r.setAttribute('max-block-size', `${block}px`)
r.setAttribute('max-inline-size', `${inline}px`)            // LAST: its setter forces render()
```

| Attribute | Horizontal | Vertical (縦書き) |
| --- | --- | --- |
| `margin` | `clamp(28, minDim*0.075, 80) * marginScale` px (header/footer band) | same |
| `gap` | `6%` (column gap + outer padding) | same |
| `max-column-count` | `cols` = `vw>vh && vw≥820 ? 2 : 1` (2 = landscape spread) | same |
| `max-inline-size` | `640` px — max **line length** | `max(320, vh − 2·margin)` px — column **HEIGHT** |
| `max-block-size` | `880` px — max **page height** | `vw − 2·margin` px — across-page **WIDTH** (only the margin frames it, so the surface fills the screen) |

**Idempotency (rotation-flicker fix).** Setting an observed attribute re-fires
foliate's `attributeChangedCallback` → `render()` (a full iframe relayout +
repaint) *even when the value is unchanged*. iOS fires a burst of
resize/visualViewport events while the viewport settles after a rotation, so
without the guard each one repainted the page → continuous flicker. The
`#lastLayout` cache bails when geometry is unchanged.
**`reopenForWritingMode` clears `#lastLayout`** before re-applying, because the
fresh paginator starts with foliate's default attributes.

**Attribute order matters:** `max-inline-size` is set last because its
`attributeChangedCallback` explicitly calls `render()` (the others only set a
`--_<name>` custom property), so the rest must already be in place. `margin` must
be `px`; `gap` must be `%`.

**`viewportSize()`** (`src/services/viewport.ts`) returns the **visual** viewport
dimensions (reliable on iOS, including at cold launch), falling back to
`window.inner*` only while pinch-zoomed (`scale > 1.01`), where the visual
viewport reports the zoomed box. The same helper backs the `--app-height` manager
(§11), so the foliate page box and the `.reader` container size from one source.

### `#vertical` detection (in the `load` handler)

```ts
const wm = doc.defaultView.getComputedStyle(doc.documentElement).writingMode || ''
const vertical = wm.startsWith('vertical')
if (vertical !== this.#vertical) { this.#vertical = vertical; this.applyLayout(this.#settings) }
```

The first section load detects vertical-ness and **re-applies layout once** if it
flipped (because `applyLayout` ran with the old `#vertical` before any doc
existed). Note this reads `documentElement`, whereas the paginator's `getDirection`
reads `body` — in practice the EPUB sets writing-mode on `html`, and our injected
override (§5) also targets `html`.

### `#onResize`

A 150ms-debounced listener wired to **both** `window` resize (orientation) and
`visualViewport` resize (iOS signals the post-launch viewport settle via the
latter, not a window resize). It re-runs `applyLayout`, and is **skipped while
pinch-zoomed** (`scale > 1.01`) so a zoom can't fight the page box. Part of the
§11 mitigation.

### 6a. RTL page order with horizontal LTR text — `#applyPageProgression`

Some EPUBs declare `page-progression-direction="rtl"` (so `book.dir === 'rtl'`)
while their content is ordinary horizontal LTR — no vertical mode, no `dir="rtl"`
in the CSS (common for JP novels typeset 横書き but bound right-to-left). foliate's
paginator derives **column order** purely from the content's own CSS direction via
`getDirection(doc)` (reads `body.dir` / computed `direction` / `html.dir`), **not**
from `book.dir` (which only feeds `goLeft`/`goRight`). So such a book paginates its
2-up landscape spread left-to-right — wrong; the earlier page must be on the right.

`#applyPageProgression(doc, vertical)` (from the `load` handler) makes the section
behave like a native RTL book:

- Sets `dir="rtl"` on **both** `documentElement` *and* `body`, so `getDirection`
  reports RTL and foliate's well-tested RTL path lays columns right-to-left with
  the matching negative-scroll math. (`dir="rtl"` on `documentElement` alone does
  **not** flip the columns; `body` must be rtl too.)
- Pins the inline **text** back to ltr via an injected
  `p,div,h1..h6,li,blockquote,dd,dt,figcaption,td,th { direction: ltr }` rule
  (plus `body { text-align: left }`), so horizontal Japanese still reads
  left-to-right — only page/column order reverses.

It runs inside foliate's `afterLoad` (our `load` fires synchronously from it,
**before** `getDirection`), so the first paint is already correct — no re-render
flash. It's a **no-op** unless `book.dir === 'rtl'` and the section is horizontal
(vertical RTL books already stack columns right-to-left from `writing-mode:
vertical-rl`). Entirely app-side — no vendor patch.

> The progress *bar* fill (`width: fraction%`) always grows left-to-right; only
> the page/column order is reversed.

---

## 7. Pagination internals (paginator.js)

The renderer is `<foliate-paginator>` (class `Paginator`). What to know:

- **CSS multi-column.** Content lives in a sandboxed `<iframe>`; the iframe doc's
  `<html>` is columnized (`column-width` / `column-gap` / `column-fill:auto`),
  sized to one page, expanded to N pages, and scrolled.
- **`observedAttributes`:** `flow`, `gap`, `margin`, `max-inline-size`,
  `max-block-size`, `max-column-count`. Nothing else does anything.
- **`attributeChangedCallback`:** `flow` → `render()`;
  `gap`/`margin`/`max-block-size`/`max-column-count` → just set the matching
  `--_<name>` custom property (a `ResizeObserver` relays out if geometry actually
  changed); **`max-inline-size` is special — it sets the prop *and* explicitly
  calls `render()`** because it may not change the measured size. This is why §6
  sets `max-inline-size` last.
- **`getDirection(doc)`:** reads `getComputedStyle(body)` for
  `vertical = writingMode === 'vertical-rl'|'vertical-lr'`, and `rtl` from
  `body.dir` / computed `direction` / `html.dir`. Decides axis mapping per section.
- **Touch page-turn patched OUT** (§1). The independent selection-drag auto-turn
  (`checkPointerSelection`) is untouched.
- **Grid + custom props.** `#top` is a CSS grid (`container-type: size`).
  Defaults: `--_gap:7%`, `--_margin:48px`, `--_max-inline-size:720px`,
  `--_max-block-size:1440px`, `--_max-column-count:2`,
  `--_max-column-count-portrait:1`. The grid is 5 columns
  (`half-gap | half-gap | content | half-gap | half-gap`) × 3 rows
  (`margin | content | margin`) so margins/heads/feet auto-frame the text.
- **Orientation container-query.** In `@container (orientation: portrait)`,
  `--_max-column-count-spread` collapses to the portrait count (1) for horizontal
  text, so a portrait iPad shows a single column even with `max-column-count=2`.
  For `.vertical` it inverts (portrait vertical text *gets* the full spread). So
  our `max-column-count=2` yields a true 2-page spread only in **landscape**.
- **Vertical axis mapping** (`.vertical` + `#beforeRender`): when vertical,
  `size = container height`; `--_max-width = --_max-block-size`;
  `--_max-height = --_max-inline-size × spread`. The inline/block axes swap —
  the source of §6's dual meanings.

---

## 8. Taps & gestures

Model: **swipe turns the page; tap defines or toggles chrome.** Pagination is by
horizontal swipe only — there are no tap edge-rails (the old `EDGE_RAIL_FRACTION`
constant and `TapInfo.zone` are gone), and foliate's own touch turn is patched out
(§1/§7).

The shared `#trackGestures` state machine drives **two** attach points (both
register every listener with `#ac`'s signal):

- **`#attachTaps(doc)`** — per loaded content doc (on `load`); handles the **text
  column** (the iframe), emits `TapInfo` with `doc` + coords. Also installs the
  `selectionchange` listener (§9).
- **`#attachHostGestures()`** — once in `open()`, on the **host**
  (`<foliate-view>`). The iframe only covers the text column, so margin taps never
  reach the per-doc listeners; the margins bubble out of foliate's shadow DOM to the
  host (iframe-internal events don't cross the browsing-context boundary, so no
  double-handling). A margin tap emits `doc: null` → routes straight to chrome.

### `pointerup` swipe-vs-tap decision

The handler bails if the pointer is non-primary, was cancelled, a non-empty Range
selection is active (the toolbar's tail), **or the page is pinch-zoomed**
(`visualViewport.scale > 1.01` — coords unreliable, mirrors the paginator's pinch
guard). Then, from the down→up delta `dx`/`dy`:

```ts
if (Math.abs(dx) >= SWIPE_MIN_DISTANCE && Math.abs(dx) > Math.abs(dy)) {
  if (dx < 0) void this.goRight()   // dragged left  → reveal the page on the right
  else        void this.goLeft()    // dragged right → reveal the page on the left
  return
}
// else, only a clean quick tap counts:
if (moved || e.timeStamp - downT > TAP_MAX_MS) return
opts.onTap(e)
```

A drag of at least `SWIPE_MIN_DISTANCE` that is **more horizontal than vertical**
turns the page — "the page follows the finger". `goLeft`/`goRight` are
**direction-aware**, so the swipe turns the correct way in LTR, RTL, and vertical
books (e.g. in an RTL 縦書き book, dragging **right** advances), always animating as
the horizontal slide (§8a). A swipe `return`s before the tap branch. A tap is a
gesture with movement `< TAP_MOVE_TOLERANCE` (tracked on `pointermove`) and duration
`< TAP_MAX_MS`; a `pointercancel` marks the interaction moved/inactive so a stray
follow-up `pointerup` can't fire a tap. On a real tap it emits
`onTap({doc, ix, iy, px, py})` — `ix/iy` (iframe-local) feed `caretRangeFromPoint`;
`px/py` (top-window, via `frameElement.getBoundingClientRect()`) place the popup.

| Constant | Value | Role |
| --- | --- | --- |
| `TAP_MOVE_TOLERANCE` | 16px | max down→up travel for a gesture to still be a tap |
| `TAP_MAX_MS` | 400ms | max tap duration |
| `SWIPE_MIN_DISTANCE` | 45px | min horizontal travel for a page-turn swipe |
| `TURN_PHASE_MS` | 150ms | one phase (out / in) of the slide (§8a) |

### Tap routing in Reader.svelte

`onTap` → `handleTap`, which runs in a fixed order (the 60ms defer is applied in
`onTap`, §8a):

1. **Popup open → dismiss.** If a dictionary popup is open (`dictState.open`),
   `closeOverlays()` and `return`. Fires for a tap **anywhere** incl. the nav-bar
   band — the popup is the highest-priority target: a tap that clears the card
   never also toggles chrome or looks up a new word. (Tap-to-define stays reliable
   through forgiving glyph hit-slack — `extractTextAt`'s `glyphSlack`, §10 — not
   re-anchoring on every tap.)
2. **Top/bottom band → toggle chrome.** If `py` lands in the edge band
   (`inChromeToggleBand`, `clamp(80, vh*0.12, 160)` of `window.innerHeight`),
   toggle `chromeVisible` and `return`. This is the **only** way a tap *shows* the
   bars; a central tap never reveals them.
3. **Chrome visible → dismiss.** Else if `chromeVisible`, set it `false` and
   `return` — a reading-area tap hides the bars (consumed; doesn't also define).
4. **Define a glyph.** Else, if `settings.tapToDefine`, call `tryDefine(info)`. It
   bails when `info.doc` is null (margin tap), then requires the tap to land on an
   actual Japanese glyph per `extractTextAt` (the `pointOnGlyph` hit-test rejects
   margins / inter-column gaps; §10, [japanese.md](japanese.md)). On a real match
   the word is also auto-highlighted yellow (§10). A blank-**centre** tap does
   nothing.

There is **no pagination on tap**, and the central area only toggles chrome to
*dismiss* it.

**Hiding the chrome again.** Once the bars are visible they cover the edge bands,
so a band tap can't reach the reader's gesture detector behind them. The bars hide
themselves: `<header>`/`<footer>` carry `role="presentation"` +
`onclick={dismissChromeFromBar}`, which sets `chromeVisible = false` unless the tap
hit an actual control (`e.target.closest('button')`). Bar taps are native `click`s
on sibling overlays and never reach the foliate-view detector — no double-handling.

**Reading-% pill.** While the chrome is hidden, a `pointer-events:none`
`.page-pct` (`{Math.round(fraction*100)}%`) sits centred at the bottom, so the
position is always visible without the bars; hidden when chrome is up (the bottom
bar carries its own progress).

### 8a. Page-turn animation — horizontal slide (`#turn` / `#slide`)

`goLeft`/`goRight` each fire `onTurn`, then `#turn(dir)` → `#slide(dir)`. Why a
custom slide: foliate stacks 縦書き pages on the **vertical** axis, so its own
`animated` turn slides up/down — wrong for a Japanese book. We leave foliate's
`animated` attribute **off** (§6), patch its touch turn out (§1/§7), and drive the
visual ourselves like Books on iPad:

1. Slide the whole `<foliate-view>` out to one edge (`transform: translateX(±100%)`,
   `TURN_PHASE_MS`). No box-shadow (a full-viewport `0 0 28px` shadow painted blurred
   bands on the top/bottom edges that swept across each phase — removed).
2. Jump to the target page while off-screen — `await view.goLeft()/goRight()`,
   instant because `animated` is off (direction-aware, correct for LTR + RTL).
3. Slide the new page in from the opposite edge to `translateX(0)`.

The new page enters from the side the reader moved toward; the old page leaves the
opposite edge — one continuous horizontal push. Both phases are
**`transitionend`-driven** (`#transition`, with a `TURN_PHASE_MS + 120`ms fallback)
so timer drift can't leave a blank-paper gap; the fallback `setTimeout` is held on
`#slideTimer` so a `destroy()` mid-turn clears it (`#ac.abort()` removes the
`transitionend` listener but can't cancel a bare timer). A `#turning` flag + a
single `#pendingDir` **coalesce rapid swipes** (the latest queued turn runs when the
current finishes).

A literal page-**curl** isn't possible (the content is a closed-shadow-DOM iframe
that can't be rasterised), and only one page renders at a time, so the vacated strip
shows the paper background (intended). `goTo()` is **not** animated.

### 60ms highlight de-conflict

A real `click` fires on the same gesture as our tap and may hit-test a highlight →
`show-annotation`. So `onTap` defers `handleTap` by **~60ms via `pendingTap`
*only when `hasHighlights`*** (the click→show-annotation hop can trail `pointerup`
by several frames on touch). If `onShowAnnotation` fires first it clears
`pendingTap` and **reopens the dictionary popup** for that highlight instead of
defining-and-re-highlighting. With no highlights, the tap runs immediately.
`pendingTap` is cleared in `onDestroy`.

### Overlays close on a turn

Because `relocate` carries no `reason` (§3), overlay-close on a turn is driven from
the **gesture** side: `goLeft`/`goRight` fire `onTurn` → `Reader.svelte` sets
`userInteracted = true`, `chromeVisible = false`, and `closeOverlays()` (closes the
dict popup and selection toolbar). TOC/annotation nav and a scrubber **seek** (§12)
set `userInteracted` the same way.

---

## 9. Selection

`#attachTaps` also installs a **250ms-debounced** `selectionchange` listener on the
content doc (same `#ac` signal). The debounce timer is held **per document** in
`#selTimers` so a landscape 2-up spread with two loaded sections (two docs, each
with its own listener) can't clobber the other's pending callback. `destroy()`
clears every timer. When the debounce fires with a non-empty Range:

```ts
const range = sel.getRangeAt(0)
const r  = range.getBoundingClientRect()
const fr = frame?.getBoundingClientRect()   // iframe → top-window offset
onSelection({ doc, range, text: sel.toString(),
  rect: { left: fr.left + r.left, top: fr.top + r.top, width: r.width, height: r.height } })
```

Otherwise `onSelectionCleared()`. The top-window `rect` positions the
`SelectionToolbar` (via `placeAnchored`, §12). In `Reader.svelte`, `onSelection`
opens the toolbar with two actions:

- **Highlight** (`createHighlight`): `cfiForSelection` → `saveAnnotation` →
  `controller.addHighlight(cfi)` → `clearSelection()`. Always yellow.
- **Copy** (`copySelection`): `navigator.clipboard.writeText(sel.text)`.

A page turn closes the toolbar via `closeOverlays()` (driven by `onTurn`, §8a). The
paginator independently watches `selectionchange` to auto-turn while dragging a
selection past the page edge — its own concern, doesn't interfere.

---

## 10. Highlights & CFI

Highlights are a **single colour** (yellow, `HIGHLIGHT_HEX` in `types.ts`).
`#highlights: Set<cfi>` is the **source of truth**; there is no per-highlight
colour. Persistence is separate — the `annotations` store (see
[storage-pwa-ios.md](storage-pwa-ios.md), [japanese.md](japanese.md)) holds the
durable records (a highlight `Annotation` has **no `color` field**); `#highlights`
is the in-memory render state.

**Two ways a highlight is created:**

1. **Tap-to-define (primary).** Tapping a Japanese word looks it up *and*
   highlights the matched word (a vocab record). Flow: `extractTextAt` returns a
   **`positions` array** (`CharPosition[]`, index → `{node, offset}`); `lookupAt`
   returns **`matchStart`** + `matchLength`. On a real match,
   `rangeForSpan(doc, positions, matchStart, matchStart + matchLength)` rebuilds a
   `Range` for exactly the matched word (it can straddle text nodes — a kanji
   compound with ruby splits its base text — which is why an index→node map, not a
   string offset, is the bridge), `cfiForSelection` → CFI, then `saveAnnotation` +
   `addHighlight`. The popup's footer toggle (`Remove highlight` / `Highlight`)
   removes/re-adds without closing the card. Auto-highlight happens only on a real
   match — not a no-match, a download prompt, or a tap on an existing highlight.
2. **Drag-select (§9).** Selection → the toolbar's **Highlight** action.

**Draw/paint flow:**

1. `addHighlight(cfi)` / `setHighlights(cfis)` records the CFI (and caches its
   spine index via `#indexForCFI` → `view.resolveCFI`), then asks the view to
   annotate.
2. `view.addAnnotation({value:cfi})` resolves the CFI to a section + range.
   - Section **loaded** → view emits `draw-annotation`; our handler calls
     `draw(Overlayer.highlight, {color: HIGHLIGHT_HEX})`, which draws filled
     `<rect>`s at the range's client rects, at
     `opacity: var(--overlayer-highlight-opacity, .3)`.
   - **Not loaded** → no-op. When that section later paints, view emits
     `create-overlay` with `{index}` → `reapplyHighlights(index)` →
     `addAnnotation` for **only that section's** known CFIs (matched against the
     cached `cfi→index` map) → the now-loaded ones draw. This keeps a page-turn
     into a new section O(highlights-in-that-section), not O(all-highlights) —
     important because tap-to-define grows the set.
3. `removeHighlight(cfi)` drops the CFI (and cached index), `deleteAnnotation`.

**CFI creation:** `cfiForSelection(doc, range)` looks up the doc's spine index in
`#docIndex` (populated on every `load`), then `view.getCFI(index, range)`; `null`
if the doc is unknown or CFI throws. CFIs are stable across reflow/font changes,
which is why annotations and progress are anchored by CFI (see `epubcfi.js`:
`fromRange`, `toRange`, `compare`).

**Tapping an existing highlight** → `show-annotation` → `onShowAnnotation(value,
range)` reopens the dictionary popup for that word (looks up `range.toString()`,
shows the definition + the `Remove highlight` footer toggle). No separate
recolor/delete toolbar.

---

## 11. Vertical column-fill quirk & viewport (iOS)

**Status.** With the viewport-derived `applyLayout` (§6) the vertical page box
**fills on the first paint** — verified in desktop Chrome at 1194×834 landscape
(`#container` ≈ 1068×708) and 834×1194 portrait (`#container` ≈ 560×1068), no nudge
needed. The mechanism and residual iOS risk are below.

**Old root cause.** In landscape vertical, foliate's `.vertical` container-query
sets the across-page spread to the *portrait* count (1), so
`--_max-height = max-inline-size × 1`. The old code hard-coded
`max-inline-size: 1100`, letting `#container` settle ~1.7× too tall on an 834px
viewport, overflowing it and leaving a dead band at the page bottom. Side margins
and text *measure* were always correct — only the block-axis size was wrong.

**The fix.** Derive the caps from the live viewport (§6): vertical
`max-inline-size = max(320, vh − 2·margin)` (column height) and
`max-block-size = vw − 2·margin` (across-page width). Because the landscape
vertical spread is 1, deriving `max-inline-size` from `vh` clamps `--_max-height`
deterministically to the available height.

**Hedges** (best-effort, idempotent):

- **`#nudgeLayout()`** schedules one **re-run of `applyLayout`** at 250ms after
  `init`. On a **cold PWA launch** the viewport / safe-area insets settle slightly
  after first paint, so the first `applyLayout` can derive a too-short vertical
  column and leave a dead band under the nav bar; re-deriving from the settled
  viewport clears it without a rotation. (It re-runs `applyLayout`, **not** a bare
  `render()` — a render alone would reuse the stale `max-inline-size`. Since
  `applyLayout` is idempotent, the re-run does nothing if the first measure was
  already right.)
- **`#onResize`** (§6) on both `window` and `visualViewport` resize is the reliable
  backstop (iOS signals the post-launch settle via `visualViewport`), skipped while
  pinch-zoomed. Idempotency means the resize burst during a rotation no longer
  repaints once per event.

**`--app-height`** (`src/services/viewport.ts`). A fresh standalone launch lays out
`position:fixed; inset:0` / `100dvh` against an under-reported layout viewport, so a
bottom-anchored bar showed a gap that only cleared on rotation. `initViewport()`
(called from `main.ts`) publishes the reliable **visual** viewport height as
`--app-height` on `:root` — rAF-coalesced, gated by a 2px threshold, and re-asserted
after the cold-launch settle (on `load`, or immediately if already loaded, plus a 300ms
backstop). **Only the fixed `.reader` overlay sizes off `var(--app-height, 100dvh)`** —
the in-flow shell (`html`/`body`/`#app`) stays on `100dvh`, because applying the var to
in-flow elements changed the document layout, which made iOS re-report a different visual
viewport height: a resize→rewrite feedback loop that oscillated the bottom bar between
the gapped and pinned positions. A fixed, out-of-flow element can't feed back into the
layout viewport. `viewportSize()` (§6) reads the same source, keeping page box and
container consistent.

---

## 12. Reader.svelte wiring

`Reader.svelte` is the screen; it owns no rendering, only orchestration.

**Mount** (`onMount`): `Promise.all([getBookMeta, getBookFile, getProgress])` →
throw if no file (with a re-import message) → **seed displayed progress** from the
saved `progress` (`fraction`/`cfi`/`label`) so the bar is correct before the first
relocate → `new ReaderController(host, settings, callbacks)` →
`controller.open(file, progress?.cfi)` → read `controller.view.book?.toc` for the
TOC → `loadAnnotations(bookId)` → `controller.setHighlights(highlight CFIs)` →
`status='ready'`; then warm the lookup worker if the dict is ready. Errors set
`status='error'` and show a back-to-library CTA.

**Reactive state** (`$state`/`$derived`): `chromeVisible`, `fraction`,
`sectionLabel`, `currentCFI`, `isBookmarked` (derived: a bookmark annotation at
`currentCFI`), `hasHighlights` (derived; gates the 60ms tap-defer, §8a). A plain
module-scope `userInteracted` flag gates progress persistence.

**Callbacks → UI:**

- `onRelocate` → update `fraction`/`currentCFI`/`sectionLabel`, then run the
  **600ms-debounced `saveProgress`** *only when* `userInteracted` is already true —
  so noisy startup relocations (which can report a bogus fraction) don't persist a
  misleading position. Because `relocate` has **no `reason`** (§3), it can't tell a
  user turn from a startup jump; `userInteracted` is set entirely from the
  gesture/nav side (`onTurn`, `navigate`, `navAnnotation`, `seek`).
  > **Fraction caveat.** foliate's `relocate.fraction` is an *overall-book*
  > fraction (`SectionProgress.getProgress`) that includes the page's
  > trailing-edge term. On the tiny test EPUB, page 1 reports a large %; on a real
  > book ≈ 0–1%. That's foliate's progress model, not a bug — the persistence
  > gating is what prevents a bogus *restore*.
- `onTurn` → `userInteracted = true`, `chromeVisible = false`, `closeOverlays()`
  (§8a).
- `onTap` → §8 routing, with the 60ms defer when `hasHighlights`.
- `onSelection`/`onSelectionCleared` → drive the `SelectionToolbar`.
- `onShowAnnotation` → clears `pendingTap`, then reopens the `DictionaryPopup` for
  the tapped highlight via `openDefine({existingCfi, …})`.

**Sheets & popups** (`<Sheet>` overlays): `TocSheet` (`onnavigate` →
`controller.goTo(href)`), `ReaderSettings` (`onchange(kind)` →
`applyAppearance` / `applyLayout` / `reopenForWritingMode` per
`'appearance'|'layout'|'writingmode'`), `AnnotationsPanel` (`onnavigate` →
`goTo(cfi)`), `DictionaryPopup`.

**One `SelectionToolbar`** — fresh selections only. Props: `open, rect,
onHighlight, onCopy`. Editing an existing highlight routes through the dictionary
popup instead (§10).

**Define + highlight in one popup.** `tryDefine` → `openDefine({text, tapOffset,
px, py, doc, positions})`; `runLookup` resolves and, on a real match, calls
`autoHighlight` (build the word `Range` from `positions` + `matchStart`/`matchLength`,
CFI it, save + `addHighlight`). `dictState` carries `cfi`/`highlighted`/`word` so
the footer toggle (`ontogglehighlight` → `toggleWordHighlight`) removes/re-adds
without closing the card; `DictionaryPopup` shows the toggle (`showActions`) only
when a real result is present. A stale-lookup guard (`lastKey`) drops a lookup that
a newer tap superseded. If the dict isn't installed, the popup shows a download
prompt; `downloadDict` downloads then **awaits `warmupLookup()`** before retrying
(see [japanese.md](japanese.md)).

**Progress scrubber** (`ProgressScrubber.svelte`) — props `{fraction,
sectionLabel, onseek}`. A hairline track + section-label/% at rest;
**press-and-drag** turns it into a fast-scroll scrubber. The press must cross an
**8px (touch) / 4px (mouse)** dead-zone before it *arms*, then maps pointer-x to a
preview fraction shown in a floating **bubble**; the seek (`onseek` → `seek` →
`goToFraction`) commits only on **release** (so foliate re-paginates once). A clean
**tap is a no-op** (only flashes the thumb). The component `stopPropagation`s its own
click so it doesn't trip `dismissChromeFromBar`, and exposes `role="slider"` +
arrow/Home/End keys (±1% / ±5% with shift).

**DictionaryPopup** positions via `placeAnchored` from its `x/y` anchor; its
`$effect` re-runs on `x`/`y` *or content* change so a re-tap — or a result loading
in — re-places the card. Flex column: a scrolling `.body` + a sticky `.actions`
footer (the highlight toggle), with a focusable close (×).

**Chrome:** top bar (library / notes / display) + bottom bar (TOC / scrubber /
bookmark). `toggleBookmark` adds/removes a `bookmark` annotation at
`currentCFI || controller.lastCFI`.

**Destroy** (`onDestroy`): clear `pendingTap`, `saveProgress.cancel()`,
`controller.destroy()`, `disposeLookup()`, `clearAnnotations()`, drop retained
`defineDoc`/`definePositions` refs.

### Anchored positioning

`placeAnchored(centerX, anchorTop, anchorBottom, w, h, opts)`
(`src/lib/util/anchoredPosition.ts`) is shared by the dictionary popup and the
selection toolbar: it centres on `centerX`, **prefers above** the anchor and flips
below on a top-margin collision, and clamps inside the viewport honouring `--safe-*`
insets. All coords are top-window. The popup passes `gap: 16`; the toolbar uses the
default.

---

## 13. How to extend

**Add a reader setting.** Add the field to `ReaderSettings` + `DEFAULT_SETTINGS`
(`src/services/types.ts`); add a control in `ReaderSettings.svelte` that calls
`updateSettings({...})` then `onchange(kind)`. Route: stylesheet change →
`appearanceCSS` + `'appearance'`; geometry → `applyLayout` + `'layout'`;
writing-mode re-detection → `'writingmode'` → `reopenForWritingMode`.

**Add a gesture.** Extend `#trackGestures` (backs both `#attachTaps` and
`#attachHostGestures`). Reuse the pointer bookkeeping (`active`/`moved`/`downT`, the
`isPrimary` guard, the `pointercancel` abort, the swipe-vs-tap split). **Register
with `#ac`'s `{ signal }`** so `destroy()` cleans it up — don't add a bespoke
`removeEventListener`. Keep any new gesture from colliding with the
`SWIPE_MIN_DISTANCE`/horizontal-dominant rule. For e.g. long-press, gate on
`e.timeStamp - downT > TAP_MAX_MS` + the no-movement check, add a `ReaderCallbacks`
entry, and handle it in `Reader.svelte`. Translate coords to top-window space via
`frameElement.getBoundingClientRect()` if you position UI (or reuse `placeAnchored`).

**Change the reading measure.** Tune `applyLayout` — it **branches on `#vertical`**.
Knobs: the margin clamp `max(28, min(80, minDim*0.075))`, `gap` `'6%'`, the `cols`
breakpoint (`vw > vh && vw >= 820`), and per-mode caps (horizontal `640`/`880`;
vertical column-height `max(320, vh − 2·margin)` / band-width `vw − 2·margin`). Keep
`margin` in `px`, `gap` in `%`, `max-inline-size` set **last**, and remember the
axis swap (§6/§7) and the landscape-only 2-up gate.

**Add a new annotation type.** Today only `Overlayer.highlight` is used. For e.g.
underline: in the `draw-annotation` handler, branch on the annotation kind and call
`draw(Overlayer.underline, {...})` / `squiggly` / `strikethrough` (all in
overlayer.js). Extend the `Annotation` model + `annotations` store, and seed via
`setHighlights`-style logic so they redraw on `create-overlay`.

**Patch a vendor file.** Follow §1: minimal diff, `// TSUZURI PATCH:` comment, a
note here. Prefer solving in `ReaderController`/`Reader.svelte`. The paginator has
no JS property API (attributes only) and a closed shadow DOM.

---

## 14. Gotchas

- **Swipe AND the turn animation are both ours.** Foliate's touch turn is patched
  out (§1/§7) and its `animated` attribute is left **off** (§6); our `pointerup`
  detector (§8) is the only thing that turns pages, and `#slide` (§8a) is the only
  animation. Don't re-add `animated` (a vertical slide would fight the horizontal
  one) and don't un-patch foliate's touch turn (you'd double-handle the swipe).
- **The iframe is `sandbox="allow-same-origin allow-scripts"`.** Both are required
  for events to fire (WebKit bug 218086) and produce a benign "an iframe which has
  both allow-scripts and allow-same-origin … can escape its sandboxing" console
  warning. Expected — don't drop a flag. EPUB scripts are *not* executed by foliate;
  rely on CSP (vendor README §Security).
- **Content lives in a CLOSED shadow DOM.** Both `View` and the paginator use
  `attachShadow({ mode:'closed' })`. You **cannot** reach rendered content via
  `querySelector`/`shadowRoot`. The only handle to a content `Document` is the
  `load` event's `doc` (captured in `#docIndex`, passed to
  `onLoad`/`onTap`/`onSelection`). All content-doc work flows through that `doc`.
- **Writing-mode toggle requires `reopenForWritingMode`.** `applyAppearance`'s
  injected `writing-mode` override changes the CSS, but the paginator's
  vertical/RTL axis decisions were made from `getDirection(doc)` at load time and
  are **not** re-derived on a style swap. So flipping horizontal⇄vertical must go
  through `reopenForWritingMode(file)` (re-`open()` at `lastCFI`) — which is why
  `ReaderSettings.svelte` routes that segment via `onchange('writingmode')`. A bare
  re-open would also orphan the old renderer (iframe doc, two ResizeObservers,
  touch listeners, and the Book's resource blob URLs leak), so `reopenForWritingMode`
  calls `view.close()` **then** `oldBook.destroy()` first.
- **`addAnnotation` is async + lossy for unloaded sections.** It silently no-ops if
  the target section isn't loaded; rely on `create-overlay` → `reapplyHighlights` to
  backfill. Don't assume a highlight painted just because `addHighlight` resolved.
- **Define and page-turn don't collide.** Pagination is by swipe, define by tap, so
  they're distinct (a swipe `return`s before the tap branch, §8). Define also fires
  *only when the tap lands on an actual glyph* — `extractTextAt` returns `null` in
  margins / inter-column gaps because `pointOnGlyph` bounds `caretRangeFromPoint`'s
  snapping with a line-aware, per-axis `glyphSlack` (§10, [japanese.md](japanese.md)).
  And define fires only when no popup is open. If you change `SWIPE_MIN_DISTANCE` or
  the glyph hit-slack, preserve that separation.

---

## 15. Cross-references

- [architecture.md](architecture.md) — app shell, routing, stores, services.
- [japanese.md](japanese.md) — `extractTextAt`/`looksJapanese`, dictionary lookup,
  segmentation/deinflection, the `glyphSlack` hit-test math, the `annotations` store.
- [ui-and-design.md](ui-and-design.md) — theme tokens, `Sheet`/`SelectionToolbar`
  components, chrome styling.
- [storage-pwa-ios.md](storage-pwa-ios.md) — OPFS book bytes, IndexedDB
  (`getProgress`/`putProgress`, annotations persistence), PWA + iOS specifics.
- [deployment.md](deployment.md) — GitHub Pages deploy, the `/epub/` base path, CI.
