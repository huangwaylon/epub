# Reader Engine

The bridge between the vendored **foliate-js** renderer and the reading
experience: page turns, taps, dictionary routing, selection, highlights,
vertical 縦書き layout. Read this before touching `src/vendor/foliate-js/`,
`src/services/reader.ts`, or `src/lib/reader/`.

Audience: engineers/LLM agents extending the reader. Signatures verified against
source; references are by symbol/file, not line number.

> **On-device status.** Measured and inferred are kept separate on purpose.
>
> **Measured on real iOS** (iPad Safari, iOS 26.5, 2026-06-28): import, vertical RTL
> pagination + furigana, horizontal-swipe turns (both directions), the edge-band chrome
> toggle, tap-to-define (both caret APIs *do* resolve inside the vertical-rl
> closed-shadow iframe; a try/catch wraps them in `src/services/jp/extract.ts`),
> highlight → Notes panel, bookmarks, reading-position persistence.
>
> **Measured in desktop Chrome only** (1194×834, 2026-08-08): glyph resolution
> ([japanese.md](japanese.md) §6 — the caret APIs resolve the *next* character over the
> far ~40% of each glyph, so ~35% of taps looked up the wrong word until the tapped
> character was decided from measured glyph boxes instead), and the page-turn latency
> patch (§1, `view.next()` 106 ms → 5 ms). Both fixes are engine-independent — geometry
> and a removed `wait()`, not caret trust — but **inferred, not verified, on real iOS**.
> WebKit has open bugs in vertical-writing caret hit-testing (webkit.org/b/283620,
> /287007, /263988; iOS layout-test baselines even expect *no* caret to resolve for a
> tap inside a fragmented inline box in `vertical-rl`), and `resolveGlyph` still takes
> its *seed* from those APIs — so on iOS a seed may be missing or line-snapped where
> Chrome's is not. The geometric candidate set (seed, seed − 1, adjacent node) is what
> absorbs a snapped seed; a missing one still means no lookup.
>
> **Unverified on real iOS:** vertical column-fill in **landscape** (portrait shows a
> residual bottom dead band — open issue), `--app-height` cold-launch durability,
> Add-to-Home-Screen storage durability.

| File | Role |
| --- | --- |
| `src/services/reader.ts` | `ReaderController` — the app-facing wrapper around `<foliate-view>` |
| `src/lib/reader/Reader.svelte` | The reader screen; wires the controller to the UI |
| `src/lib/util/chromeBand.ts` | `inChromeToggleBand(py, vh)` — pure edge-band test (§8) |
| `src/services/cfi.ts` | Pure CFI helpers: `nearestFirst` (highlight draw order, §10), `cfiWithinPage` (bookmarks, §12) |
| `src/lib/util/anchoredPosition.ts` | `placeAnchored` / `placeNearWord` — popup + toolbar placement (§12) |
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

Four documented patches:

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
- **Page-turn debounce never blocks the turn** (`paginator.js` `#turnPage`).
  Upstream ends a turn with `if (shouldGo || !this.hasAttribute('animated')) await
  wait(100)`; the second clause exists to pace *its own* animation, but Tsuzuri
  deliberately leaves `animated` **off** ([§8a](#slide)), so every single page turn paid
  a flat 100 ms — spent with our view already translated off-screen, i.e. showing blank
  paper. The first version of the patch waited only on section crossings (`shouldGo`;
  measured `view.next()` **106 ms → 5 ms** within a section), but a chapter boundary still
  held our slide on blank paper for 100 ms. Now `#turnPage` **resolves immediately** in
  every case; after a section crossing it keeps `#locked` for the same 100 ms but releases
  it from a `setTimeout` instead of awaiting it. Measured (desktop Chrome, test book): a
  full slide turn is ~284 ms within a section and ~317 ms across one (the difference is
  the section load). The held lock can't drop one of *our* turns — the next can't reach
  `#turnPage` sooner than one slide phase (150 ms) later — though a TOC/scrubber `goTo`
  issued within 100 ms of a chapter crossing is ignored, as upstream. Rapid-turn
  coalescing is app-side (`#turning`/`#pendingDir`, [§8a](#slide)).
- **`View#render` skips a document-less iframe** (`paginator.js`, `TSUZURI PATCH (4)`).
  A `ResizeObserver`/resize can reach `render()` while the iframe is between documents
  (section swap, rotation, reader teardown); `documentElement`/`body` is then null and
  `columnize` threw `el is null` from `setStylesImportant`. It now returns early — the
  new section's `load` path renders once its document exists.

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
| `renderer.atStart` / `atEnd` | Getters: first/last page of the book. `#turn` bounces instead of sliding there (§8a). |
| `renderer.getContents()` | `[{index, doc, overlayer}]` for the loaded section — `setHighlights` draws only these (§10). |
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
| `load` | `{doc, index}` (per section load) | Record `doc→index`; `#applyIntendedWritingMode` ([§6b](#intended-wm)); detect writing mode; `#applyPageProgression`; attach taps + `selectionchange` on a **per-document** `AbortController` (§8); `onLoad`. |
| `create-overlay` | `{index}` | `reapplyHighlights(index)` — draw **only that section's** highlights, chunked and nearest-first (§10). This is also how the *opening* section's highlights paint (they're seeded before `open()`). |
| `draw-annotation` | `{draw, annotation:{value}, doc, range}` | `draw(Overlayer.highlight, {color: HIGHLIGHT_HEX})`. **Where a highlight is painted.** |
| `show-annotation` | `{value, index, range}` (a real **click** hit-tests the overlayer) | `onShowAnnotation(value, range)` → reopen the dictionary popup, unless our own tap just defined a word ([§8a](#defer)). |

**No `reason` on `relocate`.** foliate uses `reason` only for its internal
`history.replaceState`; the emitted `lastLocation` doesn't carry it. So you cannot
tell a user turn from a startup jump off this event — intent is tracked from the
gesture side (§8 `onTurn`, §12 `userInteracted`). Also: `addAnnotation` only
*requests* a draw (paint happens in `draw-annotation`); and `show-annotation` is a
real **click** on the same gesture as a tap — the tap runs first and
`show-annotation` stands down behind it ([§8a](#defer)).

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
(last CFI from `relocate` — seeded from the `open()` position hint until the first one;
bookmarks fall back to it), `bookDir` (`'ltr'|'rtl'` from `book.dir`), getter `vertical`
(the popup places itself beside the column when true).

**Notable private state:** `#docIndex` (`WeakMap<Document, index>`), `#highlights`
(`Set<cfi>` — source of truth for drawn ranges, single colour), `#highlightIndex`
(`Map<cfi, index>` — cached spine index per highlight, §10), `#vertical`,
`#lastLayout` (idempotency cache, [§6](#idempotency)), `#turning`/`#pendingDir`
(turn coalescing, [§8a](#slide)), `#selTimers` (per-doc selectionchange debounce,
§9), `#redrawGen`/`#redrawTimer` (chunked highlight sweep, §10), `#reopenGen`/`#reopenChain`
(serialized writing-mode re-opens, §14), `#destroyed` (every async path re-checks it
after each await; an `open()` that resolves after `destroy()` closes what it made), `#ac` (one
`AbortController` for the host gestures + the `<foliate-view>` event listeners + the
in-flight turn `transitionend`), `#docACs` (`Map<Document, AbortController>` — one per
**content document**, so a section's listeners die with the document, §8).

### Public methods

| Method | Behaviour |
| --- | --- |
| `open(file, lastCFI?)` | Full open sequence (below). |
| `applyAppearance(s)` | Re-inject the content stylesheet via `setStyles(appearanceCSS(s))`. Live-safe (§5). |
| `applyLayout(s)` | Set paginator geometry, viewport-derived, branching on `#vertical`. Idempotent (§6). Live-safe. |
| `reopenForWritingMode(file)` | Re-`open()` at `lastCFI` — writing mode must be re-detected from the content doc (§14). **Serialized**: queues behind an in-flight re-open; a call superseded before it starts is skipped (5 synchronous toggles → 1 re-open, measured). Rejects on failure — callers `.catch`. |
| `goLeft()` / `goRight()` | Dir-aware turn, animated as a horizontal slide — or a bounce at the first/last page ([§8a](#slide)). Each fires `onTurn` first. |
| `goForward()` / `goBackward()` | Reading-order turn (Space / Shift-Space): `goLeft` in an rtl book, else `goRight`. |
| `goTo(target)` / `goToFraction(frac)` | TOC/annotation nav; clamped seek (backs the scrubber, §12). |
| `cfiForSelection(doc, range)` | `#docIndex` lookup → `view.getCFI`. `null` if doc unknown or CFI throws. |
| `addHighlight(cfi)` / `removeHighlight(cfi)` | Add/drop in `#highlights` + cached index, then `view.addAnnotation`/`deleteAnnotation`. Paint only — persistence is the `annotations` store's (§10). |
| `setHighlights(cfis)` | Replace the whole set. Call **before `open()`** (book-open seed): draws nothing, the opening section's `create-overlay` paints its share. After open it draws only the loaded section(s) — never a whole-book sweep. |
| `reapplyHighlights(index?)` | Draw that section's known CFIs (default: the loaded section(s)). **Chunked + nearest-first** (§10). |
| `clearSelection()` | Best-effort `view.deselect()`. |
| `destroy()` | Remove resize listeners (window + `visualViewport`), clear all timers (incl. `#redrawTimer`) and bump `#redrawGen`, null `#pendingDir`, abort **every `#docACs` controller** then **`#ac.abort()`**, best-effort `view.close()` **then `book.destroy()`** (revokes EPUB blob URLs), remove the element. |

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
  onKey?:             (e: KeyboardEvent) => void              // keydown inside a content doc
}
```

`onTurn` fires from `goLeft`/`goRight` at the start of every turn; the handler
sets `userInteracted` + `closeOverlays()` ([§8a](#slide), §12) — how a swipe
persists progress and dismisses popups, now that `relocate` carries no `reason`.

### Data types

```ts
interface RelocateDetail { cfi: string; fraction: number; tocItem?: { id?: number; label?: string; href?: string }; range?: Range }
// note: no `reason` field (§3). tocItem.id is foliate's unique per-item TOC id (progress.js assignIDs)
interface TocItem { id?: number; label?: string; href?: string; subitems?: TocItem[] }
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

0. `lastCFI = lastCFI` (position hint for the first nearest-first highlight draw).
1. `await view.open(file)` — parse + pick renderer (no paint). If `destroy()` ran
   meanwhile, close the Book and return.
2. `bookDir = view.book?.dir === 'rtl' ? 'rtl' : 'ltr'`; `#vertical = #expectVertical()`
   ([§6](#expect-vertical)).
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
| `body` | `color: --ink`; `background: transparent !important`; `font-family`; `-webkit-touch-callout: none` (suppress the native iOS callout so our SelectionToolbar shows); **`touch-action: manipulation`** (see below) |
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
`'horizontal'`; `'auto'` injects nothing (but see [§6b](#intended-wm) for the separate,
prepended `vrtl` rule). `font-size` lives on `html` as `%` so EPUB-relative units
cascade. `setStyles` only swaps the `<style>` text, so repeated `applyAppearance`
reflows in place — no reload.

<a id="no-double-tap-zoom"></a>
**No double-tap zoom** (`touch-action: manipulation` on the content `body`, and on
`.reader` in `Reader.svelte` for the margins). iOS ignores `maximum-scale` /
`user-scalable`, so a stray double tap while aiming at a 16px glyph could leave the page
scaled — and **both** our tap detector (§8) and foliate's own pinch guard bail while
`visualViewport.scale > 1.01`, so every tap *and* swipe would silently stop working until
the reader pinched back out. `manipulation` keeps pinch-zoom (accessibility) and drops
only the double-tap gesture, which the reader has no use for.

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

**Only changed attributes are written.** Each `setAttribute` restyles the paginator
grid, so `applyLayout` writes `margin`/`gap`/`max-column-count`/`max-block-size` only
when they differ from `#lastLayout` (all of them on the first call / after a re-open),
and writes `max-inline-size` — the one whose callback calls `render()` — whenever
*anything* changed, last, so each real change is still exactly one relayout.

<a id="expect-vertical"></a>
### `#vertical`: expected before open, confirmed in `load`

`applyLayout` runs before `view.init`, i.e. before any section document exists. With a
`false` default, every 縦書き book's first `load` flipped the flag and re-ran
`applyLayout`, whose `max-inline-size` write forces a paginator `render()` — a full
columnize of the section *with the stale horizontal axis*, inside foliate's `afterLoad`,
thrown away by foliate's own render a moment later. So `open()` (and `#reopen`) pre-set
it with `#expectVertical()`: `writingMode` `'vertical'`/`'horizontal'` is authoritative;
on `'auto'`, `book.dir === 'rtl'` **and** a Japanese `metadata.language` (`ja`, `ja-JP`)
guesses vertical. Measured on the test book (desktop Chrome, paginator `render()` calls
per open, 3 runs each): **2–3 renders / 1.9–2.9 ms with the guess vs 3–4 / 4.2–7.4 ms
without** — one wasted render per open, proportionally larger on a real section. A wrong
guess (an rtl-bound *horizontal* Japanese book, §6a)
costs exactly what every vertical book used to: the `load` handler still corrects it.

```ts
const el = doc.body ?? doc.documentElement      // the element foliate's getDirection reads
const vertical = (doc.defaultView.getComputedStyle(el).writingMode || '').startsWith('vertical')
if (vertical !== this.#vertical) { this.#vertical = vertical; this.applyLayout(this.#settings) }
```

Reads `body` (falling back to `documentElement`) so our measure and the paginator's axis
can never disagree about a book that sets writing-mode on `body` only. The read happens
**after** `#applyIntendedWritingMode` ([§6b](#intended-wm)), so a metadata-only-vertical
book is already computing as `vertical-rl` by this point.

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

<a id="intended-wm"></a>
### 6b. Intended 縦書き with no `writing-mode` CSS — `#applyIntendedWritingMode`

A large class of Japanese EPUBs — anything converted by **calibre** — declares its
vertical intent only in metadata: `<meta name="primary-writing-mode"
content="vertical-rl">` in the OPF plus `class="vrtl"` on each section's `<html>`, with
**no `writing-mode` rule in any stylesheet** (calibre's own viewer applies the mode from
that metadata). foliate reads only the standard `rendition:*` metadata, so on the default
`writingMode: 'auto'` such a book paginates 横書き and the reader has to flip the Writing
direction setting by hand for every book. Verified against
`また、同じ夢を見ていた`: the OPF carries the `primary-writing-mode` meta, every section
root carries `vrtl`, and neither `stylesheet.css` nor `page_styles.css` mentions
`writing-mode` at all.

So when the setting is `'auto'` and `doc.documentElement` carries `vrtl`,
`#applyIntendedWritingMode(doc)` **prepends** a `<style data-tsuzuri="intended-wm">` rule
(`html{writing-mode:vertical-rl}`) to `<head>`:

- Called from the `load` handler **before** the writing mode is read (§6 `#vertical`
  detection) and before foliate's `getDirection` (§7) — so the first paint is already
  vertical, no re-layout flash. Same trick, same place, as `#applyPageProgression`.
- **Prepended**, so the book's own stylesheets and our appearance sheet still win.
- **Only the explicit `vrtl` marker counts.** No guessing from `lang="ja"` or from an rtl
  spine: that would wrongly flip the genuinely-horizontal RTL-bound books
  `#applyPageProgression` (§6a) exists to support.
- An explicit 横書き/縦書き setting always wins — `appearanceCSS` injects those with
  `!important` (§5), and the guard bails when `writingMode !== 'auto'` anyway.
- Idempotent: bails if the marker `<style>` is already present.

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
- **`#turnPage` never awaits its trailing debounce** (§1). Upstream waited 100 ms whenever
  `animated` is absent (our permanent state) or the turn crossed a section. Now it
  resolves at once; only after a section crossing is `#locked` held for 100 ms, released
  from a timer. Rapid taps/swipes are coalesced app-side ([§8a](#slide)).
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

The shared `#trackGestures(target, opts, signal = #ac.signal)` state machine drives
**two** attach points:

- **`#attachTaps(doc)`** — per loaded content doc; the **text column** (iframe),
  emits `TapInfo` with `doc` + coords. Also installs `selectionchange` (§9). Both
  register on a **per-document** `AbortController` held in `#docACs`, not on `#ac`.
- **`#attachHostGestures()`** — once in `open()`, on the **host** `<foliate-view>`
  element itself (so a synthetic host-level gesture must be dispatched there, not on
  the surrounding `.view-host` div). The iframe covers only the text column, so margin
  taps bubble out of foliate's shadow DOM to the host (iframe-internal events don't
  cross the browsing-context boundary → no double-handling). A margin tap emits
  `doc: null` → routes to chrome. Registered on `#ac` (book-long).

<a id="docacs"></a>
**Per-document listener teardown (`#docACs`).** The paginator swaps in a *fresh*
document per section, and `addEventListener`'s `{signal}` registers an abort algorithm
that holds a strong reference to its target — so registering every section's listeners
on the book-long `#ac` kept every document the reader had ever visited reachable. Each
`#attachTaps` therefore creates its own controller and, before installing, aborts (a) any
controller already registered for this same `doc` and (b) any whose document's
`defaultView` is now `null` (its browsing context is gone), also clearing that doc's
`#selTimers` entry. `destroy()` aborts all remaining `#docACs` plus `#ac`.

### Constants

| Constant | Value | Role |
| --- | --- | --- |
| `TAP_MOVE_TOLERANCE` | 16px | max down→up travel to still be a tap |
| `TAP_MAX_MS` | **700ms** | max tap duration — see below |
| `SWIPE_MIN_DISTANCE` | 45px | min horizontal travel for a page-turn swipe |
| `SWIPE_DECIDE_MS` | 500ms | a touch swipe may be decided mid-move only this soon after the press (below) |
| `TURN_OUT_MS` / `TURN_IN_MS` / `TURN_SHIFT_PX` | 90ms / 170ms / 36px | the page-turn push: out-fade, in-fade, drift distance ([§8a](#slide)) |
| `BOUNCE_PX` / `BOUNCE_MS` | 28px / 110ms | the first/last-page nudge ([§8a](#slide)) |

(`HIGHLIGHT_DRAW_CHUNK = 24`, the other `reader.ts` module constant, belongs to the
highlight sweep — [§10](#chunked-redraw).)

**Why `TAP_MAX_MS` is generous.** Tap-to-define invites a *deliberate, aimed* press at a
single ~16px glyph — and a reader who just missed aims more carefully, i.e. slower — so a
tight window silently drops exactly the taps that matter most. Nothing competes for a
stationary press: a page turn needs `SWIPE_MIN_DISTANCE` of travel, and a real long-press
hands off to WebKit's selection, which `shouldIgnoreUp` catches. Raising it 400 → 700 ms
has no other consumer.

### `pointerup` swipe-vs-tap decision

Bails if the pointer is non-primary, was cancelled, the press landed **inside a live
selection**, **or the page is pinch-zoomed** (`visualViewport.scale > 1.01`, mirrors the
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
(iframe-local) feed the caret APIs; `px/py` (top-window, via
`frameElement.getBoundingClientRect()`) place the popup.

<a id="early-swipe"></a>
**Touch swipes turn on the move.** In `pointermove`, once a **touch** pointer's drag
crosses `SWIPE_MIN_DISTANCE` (horizontal-dominant), the turn fires right there and the
gesture is consumed (`active = false`), so its `pointerup` is ignored — the page starts
moving while the finger is still travelling, like Books. All of these must hold, else the
`pointerup` decision above applies unchanged:

- `pointerType === 'touch'` — a **mouse** drag across text is a drag-*select*;
- within `SWIPE_DECIDE_MS` of the press — a lingering press may be an iOS long-press
  turning into a selection;
- no second contact joined the gesture (`multi`, set by a non-primary `pointerdown`);
- not pinch-zoomed;
- `canSwipeEarly()` — for a content doc, **no live `Range` selection** (the finger may be
  dragging a selection handle). The host (margins) has no selection to protect.

Verified in desktop Chrome touch emulation: the turn lands before the lift, the later
`pointerup` doesn't turn again. On real iOS a selection-handle drag is expected to
`pointercancel` anyway; the guards above are the belt-and-braces.

<a id="keyboard"></a>
**Keyboard.** `Reader.svelte`'s `onKey` runs from `<svelte:window onkeydown>` **and**
from each content document (`#attachTaps` forwards `keydown` via `onKey` — iframe key
events never reach the top window): **←/→** `goLeft`/`goRight` (already rtl-aware),
**Space / Shift-Space** `goForward`/`goBackward` (reading order), **Escape** closes the
card/toolbar (clearing any selection), else hides the chrome. Ignored while a sheet is
open (the Sheet owns Escape), with a modifier held, or when focus is in a field, the
scrubber slider (its arrows seek), or — for Space — a button.

<a id="pointer-hygiene"></a>
### Multi-touch & selection hygiene (why taps used to vanish)

A tap on glass is easy to lose to a *second* contact or to a stale selection. Four
rules, all in `#trackGestures`:

- **`pointermove` ignores non-primary pointers.** A second contact anywhere on the glass
  (a thumb on the bezel, a palm graze) was measured against the *first* finger's down
  point, so its distant coordinates instantly set `moved` and the real tap was discarded.
- **`pointerup` tests `isPrimary` *before* consuming `active`.** Otherwise the second
  finger lifting cleared `active`, and the real finger's own `pointerup` was then dropped
  by `!active`.
- **`pointercancel` is likewise gated on `isPrimary`**, so a cancelled secondary pointer
  can't abort the primary gesture.
- **`shouldIgnoreUp(e)` takes the event** and bails **only when the press landed inside
  the selection's own client rects** (iterating `sel.rangeCount` × `getClientRects()`);
  otherwise it clears the selection (`removeAllRanges`) and lets the tap through. WebKit
  collapses a selection only *after* our `pointerup`, so the old "a selection exists ⇒
  bail" rule swallowed the very tap that dismisses it — and the word lookup with it.

Pinch-zoom is the fourth hazard, handled in CSS rather than JS: see
[§5 `touch-action: manipulation`](#no-double-tap-zoom).

<a id="tap-routing"></a>
### Tap routing in Reader.svelte

`onTap`, in this order:

1. **Card open → dismiss it** (`closeOverlays()`), wherever the tap landed — **even on
   another word** — and nothing else: no lookup, no highlight, no chrome flash. It records
   `tapDismissedAt`, so a highlight `click` (`show-annotation`) riding the same gesture
   stands down instead of reopening a card. (It used to re-target the card to the tapped
   word, which made "tap away to close" impossible: it defined and highlighted whatever
   text the tap landed on.)
2. **On a Japanese glyph → define it.** If `info.doc && tryDefine(info)`: record
   `tapDefinedAt = Date.now()` ([§8a](#defer)), set `chromeVisible = false` (never leave
   the bars covering the card), `return`. This wins **even inside the nav-bar band**,
   which overlaps the first/last glyphs of every column. `tryDefine` bails on a null `doc`
   (margin tap) and on blank space, because `extractTextAt` returns `null` unless the point
   resolves to a word character ([japanese.md](japanese.md) §6).
3. **Blank tap in the top/bottom band → toggle chrome.** `inChromeToggleBand(info.py,
   viewportSize().h)`: the band is `clamp(80, vh*0.12, 160)` of the **visual viewport**
   height (`viewportSize().h`, *not* `window.innerHeight`), via the pure
   `inChromeToggleBand(py, vh)` in `src/lib/util/chromeBand.ts`. The **only** way a tap
   *shows* the bars.
4. **Blank tap, chrome visible → hide it**, so the bars are easy to clear without
   reaching for them.

Otherwise the tap does nothing (a blank-**centre** tap).

**Why glyph-first, not band-first.** The chrome band is `clamp(80, vh*0.12, 160)` while
the reading margin is `clamp(28, minDim*0.075, 80)` (§6) — at iPad landscape 1194×834
that is a **100px band against a 63px margin**, so ~37px of *live text* at each end of
every column (≈2 glyphs, ~10% of the page; ~18% on an iPhone) sat under the band and
could never be looked up: it toggled the nav bars instead. The band still owns that strip
whenever the tap misses every glyph, which is what keeps the reveal gesture available.
The old "card open ⇒ dismiss only" rule had the matching cost on the other axis: every
word-to-word transition spent a wasted tap.

**Hiding the chrome again.** Once visible the bars cover the edge bands, so they
hide themselves: `<header>`/`<footer>` carry `role="presentation"` +
`onclick={dismissChromeFromBar}`, which sets `chromeVisible = false` unless a
control was hit (`e.target.closest('button')`). Bar taps are native `click`s on
sibling overlays and never reach the foliate-view detector. While the chrome is
hidden a `pointer-events:none` `.page-pct` pill shows the reading %.

<a id="slide"></a>
### 8a. Page-turn animation — horizontal push (`#turn` / `#slide`)

*(Authoritative; §1, §7, §14 reference this.)* foliate stacks 縦書き pages on the
**vertical** axis, so its own `animated` turn slides up/down — wrong for a Japanese
book. So we leave `animated` **off**, patch its touch turn out (§1/§7), and drive
the visual ourselves like Books on iPad. `goLeft`/`goRight` fire `onTurn`, then
`#turn(dir)` → `#slide(dir)`:

1. The whole `<foliate-view>` drifts `TURN_SHIFT_PX` (36px) the way the finger moved and
   fades to 0 (`TURN_OUT_MS`, 90 ms).
2. Jump to the target page while invisible — `await view.goLeft()/goRight()`, instant
   because `animated` is off (direction-aware, correct for LTR + RTL).
3. Place the new page 36px on the **opposite** side, **flush that start position with
   transitions off** (`void el.offsetWidth`), then drift it to rest while fading up
   (`TURN_IN_MS`, 170 ms). Reduced motion: no drift, cross-fade only.

Both pages travel the same way the content moves — a short push. It replaced a
full-width `translateX(±100%)` fly-out/fly-in over blank paper, which users found
confusing, and which also had a bug: the new page's off-screen start was only flushed
*inside* the entry transition, so it animated from the exit side — i.e. the next page
flew in from the side it had just left toward. Each phase finishes on `opacity`'s
`transitionend` (it always changes; a zero-drift turn has no transform change). Both phases are **`transitionend`-driven**
(`#transition(ms, easing, transform)`, with an `ms + 120` fallback) so timer drift can't
leave a blank-paper gap; the fallback `setTimeout` is held on `#slideTimer` so a
`destroy()` mid-turn clears it (`#ac.abort()` removes the listener but can't cancel
a bare timer). Each phase commits its start state with a **forced style flush**
(`void el.offsetWidth`) before writing the new transform — the old code spent a
`requestAnimationFrame` per phase for the same effect (up to ~16 ms of dead time, twice
per turn). A `#turning` flag + a single `#pendingDir` **coalesce rapid swipes**
(the latest queued turn runs when the current finishes).

**Bounce at the ends.** When the turn has nowhere to go (`#atEdge`: `renderer.atEnd`
for a forward turn, `atStart` for a backward one — forward is `goLeft` in an rtl book),
`#turn` runs `#bounce` instead: a `BOUNCE_PX` nudge toward the finger and back
(`BOUNCE_MS` out, 1.4× back), rather than sliding the page out and the *same* page back
in. A literal page-**curl**
isn't possible (closed-shadow-DOM iframe can't be rasterised), and only one page
renders at a time — hence a fade rather than two pages sliding side by side.
`goTo()` is **not** animated.

<a id="defer"></a>
**Highlight de-conflict (`tapDefinedAt`).** A real `click` fires on the same gesture as
our tap and may hit-test a highlight → `show-annotation`, so both paths can want to open
the card for the same word. The tap runs **immediately** and the later `show-annotation`
stands down: `onShowAnnotation` simply **returns** if `Date.now() - tapDefinedAt < 500`.
The tap's own lookup owns the card, including its highlight state (`highlightMatch` sets
`cfi`/`highlighted` for the matched word, finding the existing record via the CFI dedupe).
It used to adopt the clicked annotation's CFI instead, which raced the lookup and could
leave the footer toggling a different highlight than the one on the card.

There is deliberately **no timer on the tap path**. The previous design deferred
`handleTap` by 60ms whenever any highlight existed (`pendingTap` + a `hasHighlights`
derived), which taxed every tap once the reader had looked up a single word and let
`closeOverlays()` silently drop a deferred tap. Both are gone.

**Overlays close on a turn.** Because `relocate` carries no `reason` (§3),
overlay-close is gesture-driven: `goLeft`/`goRight` fire `onTurn`; TOC/annotation
nav and a scrubber seek do the equivalent (§12).

---

## 9. Selection

`#attachTaps` installs a **250ms-debounced** `selectionchange` listener on the
content doc (on that doc's own `#docACs` signal, [§8](#docacs)). The timer is held **per
document** in `#selTimers` so a landscape 2-up spread (two docs) can't clobber the other's
pending callback. `destroy()` — and the teardown of a swapped-out document — clears every
timer. When the debounce fires with a non-empty Range:

```ts
const range = sel.getRangeAt(0)
const r  = range.getBoundingClientRect()
const fr = frame?.getBoundingClientRect()   // iframe → top-window offset
onSelection({ doc, range, text: sel.toString(),
  rect: { left: fr.left + r.left, top: fr.top + r.top, width: r.width, height: r.height } })
```

Otherwise `onSelectionCleared()`. The top-window `rect` positions the
`SelectionToolbar` (via `placeAnchored`, §12). `onSelection` opens the toolbar with
**Highlight** (`cfiForSelection` → the reader's `addHighlight(cfi, text)`, §10 →
`clearSelection`; always yellow) and **Copy** (`navigator.clipboard.writeText`). Every
exit path (`clearSel`) also drops the held `sel.doc`/`sel.range`, so a used selection
can't pin a navigated-away section's DOM. A
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

<a id="one-path"></a>
**One create/remove pair.** Every highlight change goes through two functions in
`Reader.svelte`: `addHighlight(cfi, text)` — **paint first** (`controller.addHighlight`,
skipped if already highlighted), then `addHighlightRecord` — and `removeHighlight(cfi)`
(`removeHighlightRecord` + `controller.removeHighlight`). The `annotations` store's
`addHighlightRecord` **dedupes on CFI** (an existing record is returned, nothing written),
updates the in-memory list synchronously, and persists to IndexedDB in the background; so
tap-to-define, the popup's Highlight toggle and drag-select → Highlight can't diverge.
**Deleting from the Notes panel** (`AnnotationsPanel`'s `onremove`) removes the record and
then unpaints the CFI **when no other highlight record still shares it** — before, the
record vanished but its yellow overlay stayed until the next reload.

**The `annotations` store** (`src/stores/annotations.svelte.ts`): `items` is a
`$state.raw` **immutable** array (every change replaces it — nothing deep-proxied, one
signal per change), read via `annotations.items`; plain `Map` indexes rebuilt on each
replacement back `isHighlighted(cfi)` / `highlightAt(cfi)` (O(1)). `loadAnnotations` is
generation-guarded so a slow load for a book already closed can't land in the next one.

**Two ways a highlight is created:**

1. **Tap-to-define (primary).** Tapping a Japanese word looks it up *and* highlights
   the matched word. `extractTextAt` returns a `positions` array (`CharPosition[]`,
   index → `{node, offset}`); `lookupAt` returns `matchStart` + `matchLength`. On a
   real match, `rangeForSpan(doc, positions, matchStart, matchStart + matchLength)`
   rebuilds a `Range` for exactly the matched word (it can straddle text nodes — a
   kanji compound with ruby splits its base text, hence an index→node map, not a
   string offset), `cfiForSelection` → CFI, then the reader's `addHighlight` (above).
   `highlightMatch` does all of this **synchronously** and after re-checking the lookup
   key: the old `autoHighlight` awaited the IndexedDB write and the paint before setting
   `dictState.cfi`, so a tap on another word in between got this older word's CFI
   written into its card. The stored `text` is read **from `definePositions`, not
   `range.toString()`** — see the ruby gotcha below.
   The popup's footer toggle removes/re-adds without closing the card.
2. **Drag-select (§9).** Selection → the toolbar's **Highlight** action.

> **Never stringify a highlight `Range` for the word.** A range over a ruby-annotated
> compound spans the intervening `<rt>`, so `range.toString()` splices the furigana in
> (決**けっ**心) — wrong in the Notes panel and unlookupable when the highlight is
> re-tapped. `highlightMatch` builds the word by mapping `definePositions.slice(start,
> end)` back to characters (furigana is already excluded from that run), and
> `onShowAnnotation` correspondingly prefers the stored annotation `text` over the
> range's string, falling back to `range.toString()` only for a highlight with no record.

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

> **Book open seeds before `open()`.** `Reader.svelte` loads annotations in the same
> `Promise.all` as the book file and calls `setHighlights` *before* `controller.open`, so
> the opening section's `create-overlay` (fired during `view.init`) paints its own share on
> the normal per-section path — no second pass after open, and no whole-book sweep that
> called (and no-op'd) `addAnnotation` for every highlight in the book.
> `#highlightIndex` fills lazily as sections load.

<a id="chunked-redraw"></a>
**Chunked, nearest-first redraw.** Because tap-to-define highlights *every* looked-up
word, a section's set grows without bound over a book, and each draw is real work: parse
the CFI, re-anchor it to a `Range` over the live document, measure its client rects, build
an SVG node. Painting them in one loop blocks the main thread on every section change —
estimated ~160 ms per section entry at 500 highlights and ~630 ms at 2000. So
`reapplyHighlights`:

1. Collects the CFIs of the requested section(s).
2. If there are more than `HIGHLIGHT_DRAW_CHUNK` (24) and `lastCFI` is known, orders them
   **nearest-first** with `nearestFirst(cfis, lastCFI)` (`src/services/cfi.ts`): parse
   each CFI **once** (collapsed to its start point), sort into document order,
   binary-search where `lastCFI` falls, then walk outward alternating after/before.
   Unparseable CFIs go last. The page the reader is looking at therefore paints in the
   first chunk; the rest of the section trickles in. (The previous
   `sort by Math.abs(compare(cfi, lastCFI))` was a **no-op**: `compare` returns only
   -1/0/1, so every CFI had "distance" 1.)
3. Draws 24 per task, re-scheduling with `setTimeout(…, 0)` on `#redrawTimer`, so a swipe
   is never blocked behind the tail.
4. Guards with `#redrawGen`: a newer sweep increments it and the in-flight one abandons at
   its next chunk. `destroy()` clears `#redrawTimer` and bumps `#redrawGen`.

**CFI creation:** `cfiForSelection(doc, range)` → `#docIndex` spine index →
`view.getCFI(index, range)`; `null` if the doc is unknown or CFI throws. CFIs are
stable across reflow/font changes, which is why annotations + progress anchor by
CFI (`epubcfi.js`: `fromRange`, `toRange`, `compare`).

**Tapping an existing highlight** → `show-annotation` → `onShowAnnotation` reopens
the dictionary popup for that word (the **stored annotation `text`**, falling back to
`range.toString()`; shows the definition + `Remove highlight` toggle). No separate
recolor/delete toolbar. It stands down entirely if our own tap just defined a word
([§8a](#defer)).

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

**Mount** (`onMount`), before the first await: **`prefetchEngine()`** (dynamic-imports
foliate's `vendor/zip.js`, `epub.js` and `paginator.js` — the chunks `view.open` otherwise
fetches one after another, each import nested inside the previous step; same specifiers,
so Vite resolves the same chunks and the module map dedupes; no vendor edit) and
**`warmLookupIfReady()`** (kuromoji builds in the worker in parallel with the open). Then
`Promise.all([getBookMeta, getBookFile, getProgress, loadAnnotations])` → throw if no
file (re-import message) → **seed displayed progress** from saved `progress` → `new
ReaderController(host, settings, callbacks)` → **`setHighlights(highlight CFIs)`** (before
open, §10) → `controller.open(file, progress?.cfi)` → **`status='ready'`** → read
`view.book?.toc` → `installDevHook()` (DEV-only `window.__tsuzuri`, see
[development.md](development.md) §6) → register `visibilitychange` + `pagehide`. **A
`destroyed` flag is re-checked after every await**, so leaving mid-open (the loading
screen has a **← Back to library** button) doesn't go on to set state, register
listeners or warm the worker; the controller likewise closes a Book that finished
opening after `destroy()` (verified: exit during loading leaves no `<foliate-view>`, no
hook, no errors). Errors → `status='error'` + a back-to-library CTA.

**Reactive state** (`$state`/`$derived`): `chromeVisible`, `fraction`,
`sectionLabel`, `currentTocId`, `currentCFI`, `isBookmarked` (**a bookmark lies within
the visible page's range** — `cfiWithinPage(bookmark, currentCFI)`, start-inclusive /
end-exclusive — not an exact CFI match, which broke as soon as a reflow moved the page
boundaries; `toggleBookmark` removes every bookmark on the page, else adds one). Plain
(non-reactive) refs: `defineDoc`/`definePositions` (live DOM for the in-flight define),
`tapDefinedAt` ([§8a](#defer)), `lastDoc` (dev hook; only tracked in DEV), `disposeTimer`,
`destroyed`, `appliedTheme`. A module-scope `userInteracted` flag gates progress
persistence.

**Callbacks → UI:**

- `onRelocate` → update `fraction`/`currentCFI`/`currentTocId`/`sectionLabel`, then the
  **600ms-debounced `saveProgress`** *only when* `userInteracted` — so noisy startup
  relocations (bogus fraction) don't persist a misleading position. `userInteracted`
  is set entirely from the gesture/nav side (`onTurn`, `navigate`, `navAnnotation`,
  `seek`), since `relocate` has no `reason` (§3). The debounce is **flushed** (`flush()`
  in `src/lib/util/debounce.ts` runs a pending call now) on `visibilitychange → hidden`,
  `pagehide` and `onDestroy` — a turn then an immediate background/exit used to lose the
  position when iOS killed the page before the 600 ms timer fired.
  > **Fraction caveat.** foliate's `relocate.fraction` is an *overall-book* fraction
  > incl. the page's trailing-edge term; the tiny test EPUB reports a large % on
  > page 1, a real book ≈ 0–1%. foliate's progress model, not a bug — the
  > persistence gating prevents a bogus *restore*.
- `onTurn` → `userInteracted = true`, `chromeVisible = false`, `closeOverlays()`.
- `onTap` → [§8 routing](#tap-routing), synchronously (no defer).
- `onLoad` → remember the content `Document` for the dev hook; nothing user-visible.
- `onSelection`/`onSelectionCleared` → drive the `SelectionToolbar`.
- `onShowAnnotation` → stands down behind a just-completed tap ([§8a](#defer)),
  otherwise reopens the `DictionaryPopup` via `openDefine({existingCfi, …})`.

**Theme.** An `$effect` on `appearance.resolved` (settings store) re-runs
`applyAppearance` when the *resolved* palette changes under an `'auto'` theme (the OS
switching to dark mid-read); `appliedTheme` stops it double-applying after an explicit
pick, which already re-applies via `onSettingChange`. `appearanceCSS` keys `color-scheme`
off `<html data-theme>` (the resolved palette), not `settings.theme` (may be `'auto'`).

**Visibility (memory).** A `visibilitychange` handler sheds the lookup worker — and the
resident kuromoji trie — so iOS is less likely to kill the backgrounded tab, but only
after a **`LOOKUP_IDLE_DISPOSE_MS = 60_000` grace period** (`disposeTimer`, re-checking
`document.hidden` when it fires). Returning before it fires just cancels the timer and
returns: the worker was never disposed, so there is nothing to re-warm. Disposing on hide
punished the common case (a glance at another app, a notification, Slide Over) — coming
back, the trie had to rebuild, and taps during the rebuild fell back to greedy
segmentation, i.e. silently returned the wrong word. On return it always **pings**
(`pingLookup()`): iOS can reclaim a hidden worker without an `onerror`, so a worker that
doesn't answer (or was disposed) is dropped and re-warmed (`warmupLookup`, if
dict ready) with no network (see [japanese.md](japanese.md)).

**Sheets & popups:** `TocSheet` (`onnavigate` → `goTo(href)`; rows keyed on foliate's
unique TOC `id`, the current row matched by `currentTocId` — label as fallback — marked
`aria-current="location"` and scrolled into view when the sheet opens), `ReaderSettings`
(`onchange(kind)` → `applyAppearance`/`applyLayout`/`reopenForWritingMode` per
`'appearance'|'layout'|'writingmode'`; a writing-mode re-open first `closeOverlays()`),
`AnnotationsPanel` (`onnavigate` → `goTo(cfi)`, `onremove` → §10), `DictionaryPopup`.
TOC/note jumps and scrubber seeks also `closeOverlays()`.

**One `SelectionToolbar`** — fresh selections only (`open, rect, onHighlight,
onCopy`). Editing an existing highlight routes through the dictionary popup (§10).

**Define + highlight in one popup.** `tryDefine` → `openDefine({text, tapOffset,
anchor, doc, positions})` and returns whether a lookup started (that boolean is what
[§8's](#tap-routing) glyph-first rule keys off). `anchor` is the tapped character's box
(`glyphAnchor`: one Range over `positions[tapOffset]`, top-window coords). `runLookup`
resolves and, on a real match, calls `highlightMatch` (build the word `Range` from
`positions` + `matchStart`/`matchLength`, CFI it, **re-anchor the card to the word's
rect**, `addHighlight`). The whole of `runLookup` is
wrapped in **try/catch**: a rejected `isDictReady()` (a `versionchange` from another tab, or
IndexedDB refusing to open under iOS storage pressure) used to latch the popup spinner on
for the rest of the session; now it logs, clears `loading`, and shows the empty state.
`dictState` carries `cfi`/`highlighted`/`word` so the footer toggle (`ontogglehighlight` →
`toggleWordHighlight`) removes/re-adds without closing the card. A stale-lookup guard
(`lastKey`) drops a superseded lookup. **Re-targeting an open card keeps the previous
result on screen, dimmed** (`.body.stale`), and the popup shows a spinner only once a
lookup has run ~150 ms (most resolve sooner). If the dict isn't installed, the popup
shows a download prompt whose copy follows `dictPhase()` (downloading / retrying /
**"Preparing…"** — it never re-offers Download while a download runs or the segmenter
is being prepared); `downloadDict` calls **`downloadAndWarmDictionary('en')`** (keeps the
online-warm invariant in dictdb), but the card doesn't wait for the warm: an `$effect`
re-runs the pending lookup **as soon as `dict.state === 'ok'`** (JMdict queryable), see
[japanese.md](japanese.md). The popup's **X and Escape go through `closeOverlays()`** (the
popup's `onclose`), so `defineDoc`/`definePositions` are always released.

**Progress scrubber** (`ProgressScrubber.svelte`, `{fraction, sectionLabel,
onseek}`). Press-and-drag fast-scroll; the press must cross an **8px (touch) / 4px
(mouse)** dead-zone before it arms, the seek (`onseek` → `seek` → `goToFraction`)
commits only on **release**, and a clean tap is a no-op. It `stopPropagation`s its
own click so it doesn't trip `dismissChromeFromBar`. **DictionaryPopup** positions via
`placeNearWord(anchor, w, h, vertical)`, re-placing on anchor *or content* change, and
**synchronously** — measured and placed in the effect that runs in the mounting flush,
before paint (`visibility:hidden` until placed), so there is no first frame at 0,0 (the
old `requestAnimationFrame` placement painted one). `SelectionToolbar` does the same. **Chrome:** top bar
(library / notes / display) + bottom bar (TOC / scrubber / bookmark);
`toggleBookmark` toggles a `bookmark` annotation at `currentCFI || lastCFI`.

**Destroy** (`onDestroy`): `destroyed = true`, clear `disposeTimer`, remove
`visibilitychange` + `pagehide`, **`saveProgress.flush()`**, `controller.destroy()`,
`disposeLookup()`, `clearAnnotations()`, drop retained `defineDoc`/`definePositions`,
`sel.doc`/`sel.range` and `lastDoc`, and `delete window.__tsuzuri` (DEV).

### Anchored positioning

`placeAnchored(centerX, anchorTop, anchorBottom, w, h, opts)`
(`src/lib/util/anchoredPosition.ts`) — used by the selection toolbar, and by the popup for
horizontal text: centres on `centerX`, **prefers above** the anchor and flips below on a
top-margin collision, and clamps inside the viewport honouring `--safe-*` insets.

`placeNearWord(rect, w, h, vertical, opts)` — the popup's placement. Horizontal: 
`placeAnchored` on the **word's rect** (above/below its line — not the tap point).
**Vertical (縦書き): beside the column** — left of the word if the card fits there, else
right, else the roomier side clamped — vertically centred on the word; above/below would
cover the rest of the very column being read. All coords top-window; the popup passes
`gap: 16`. Unit-tested in `anchoredPosition.test.ts`.

---

## 13. How to extend

**Add a reader setting.** Add the field to `ReaderSettings` + `DEFAULT_SETTINGS`
(`src/services/types.ts`); add a control in `ReaderSettings.svelte` that calls
`updateSettings({...})` then `onchange(kind)`. Route: stylesheet → `appearanceCSS`
+ `'appearance'`; geometry → `applyLayout` + `'layout'`; writing-mode →
`'writingmode'` → `reopenForWritingMode`.

**Add a gesture.** Extend `#trackGestures`. Reuse the pointer bookkeeping
(`active`/`moved`/`downT`, the `isPrimary` guards on move/up/cancel, the
`pointercancel` abort, the swipe-vs-tap split) — see
[multi-touch hygiene](#pointer-hygiene) before loosening any of it. **Pass the right
`signal`**: content-document listeners belong on that document's `#docACs` controller
(the third `#trackGestures` argument), host listeners default to `#ac`, so `destroy()`
cleans up either way. Keep it from colliding with the
`SWIPE_MIN_DISTANCE`/horizontal-dominant rule. For e.g. long-press, gate on
`e.timeStamp - downT > TAP_MAX_MS` + no movement, add a `ReaderCallbacks` entry, handle it
in `Reader.svelte`. Translate coords to top-window via
`frameElement.getBoundingClientRect()` (or reuse `placeAnchored`).

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
  `load` event's `doc` (in `#docIndex`, passed to `onLoad`/`onTap`/`onSelection`) — which
  is why an automated tap-accuracy harness needs the DEV-only `window.__tsuzuri` hook
  ([development.md](development.md) §6).
- **Writing-mode re-opens are serialized** (`#reopenChain` + `#reopenGen`). Unserialized,
  rapid 横書き/縦書き/Auto taps interleaved their `close()`/`open()` awaits and the loser's
  paginator was never closed. Don't call `view.open` outside `open()`/`#reopen`.
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
  backfill. Don't assume a highlight painted just because `addHighlight` resolved —
  and with the [chunked sweep](#chunked-redraw) it may not have painted *yet*.
- **Define beats chrome; swipe beats define.** Pagination is by swipe, define by tap: a
  swipe `return`s before the tap branch (§8), so those never collide. But within a tap,
  **a glyph hit wins over the nav-bar band and over an open card**
  ([§8 routing](#tap-routing)) — the band and dismiss behaviours only run when the point
  resolved to no word character. If you widen the glyph hit slack (`glyphSlack`,
  [japanese.md](japanese.md) §6) you shrink the blank space the chrome toggle lives in;
  if you narrow it you resurrect un-lookupable text under the band. Keep both in mind.
- **Never re-add a delay to the tap path.** Taps carry the product's primary interaction;
  the removed 60 ms `pendingTap` defer both slowed every tap and could drop one
  ([§8a](#defer)). De-conflict *after* the fact (`tapDefinedAt`), not before.

---

## 15. Cross-references

- [architecture.md](architecture.md) — app shell, routing, stores, services.
- [japanese.md](japanese.md) — `extractTextAt`/`resolveGlyph`, dictionary
  lookup, segmentation/deinflection, the `glyphSlack` hit-test math, the `annotations`
  store.
- [ui-and-design.md](ui-and-design.md) — theme tokens, `Sheet`/`SelectionToolbar`,
  chrome styling.
- [storage-pwa-ios.md](storage-pwa-ios.md) — OPFS book bytes, IndexedDB
  (`getProgress`/`putProgress`, annotations), PWA + iOS specifics.
- [deployment.md](deployment.md) — GitHub Pages deploy, the `/epub/` base path, CI.
