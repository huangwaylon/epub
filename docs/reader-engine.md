# Reader Engine

The deepest subsystem in Tsuzuri: the bridge between the vendored **foliate-js**
rendering library and the app's reading experience (page turns, taps,
dictionary, selection, highlights, vertical 縦書き layout). Read this before
touching anything under `src/vendor/foliate-js/`, `src/services/reader.ts`, or
`src/lib/reader/Reader.svelte`.

Audience: engineers/LLM agents extending the reader. Every signature and path
below was verified against source. Where on-device behaviour is unverified it is
flagged explicitly.

Key files:

| File | Role |
| --- | --- |
| `src/services/reader.ts` | `ReaderController` — the entire app-facing wrapper around `<foliate-view>` |
| `src/lib/reader/Reader.svelte` | The reader screen; wires the controller to UI (chrome, sheets, popups, toolbars) |
| `src/vendor/foliate-js/view.js` | Registers `<foliate-view>`; class `View extends HTMLElement` |
| `src/vendor/foliate-js/paginator.js` | The CSS-multicolumn renderer; registers `<foliate-paginator>` |
| `src/vendor/foliate-js/overlayer.js` | SVG annotation overlays (`Overlayer`, `Overlayer.highlight`) |
| `src/vendor/foliate-js/epubcfi.js` | CFI parse/serialize/compare |

---

## 1. Why foliate-js, vendoring & local modifications

[foliate-js](https://github.com/johnfactotum/foliate-js) (MIT, © 2022 John
Factotum — see `src/vendor/foliate-js/LICENSE`) is the rendering engine behind
the GTK [Foliate](https://github.com/johnfactotum/foliate) reader. We use it
because it is pure ESM with **no build step and no hard dependencies**, paginates
reflowable EPUB via CSS multi-column, handles **vertical writing-mode** (縦書き)
and RTL page progression natively, and operates on DOM `Range`s + EPUB CFIs —
exactly what a Japanese reader needs. Upstream is explicitly *unstable* ("expect
it to break and the API to change"), so we **vendor a pinned copy** rather than
depend on a package.

### Local modifications vs upstream

- **PDF.js + `vendor/pdfjs` removed.** The app is EPUB-focused, so the heavy
  PDF.js dependency and the PDF branch in `view.js`'s `makeBook()` were deleted.
  Verify: `src/vendor/foliate-js/vendor/` contains only `fflate.js` and
  `zip.js`; there is no `pdf.js`. In `makeBook` (view.js:79-119) the format
  dispatch is **zip → CBZ / FBZ / EPUB**, else **MOBI/KF8 → FB2**; there is no
  `isPDF` branch. (The `isPDF` helper at view.js:13-18 survives as dead code —
  it is defined but never called. Safe to ignore or remove.)
- MOBI/KF8, FB2, FBZ, and CBZ branches are **kept** (they are cheap, lazy
  dynamic `import()`s and cost nothing until such a file is opened).
- `README.md` still lists PDF.js under "Vendored libraries" — that line is stale
  relative to our tree; do not treat it as authoritative for this fork.

### Policy

> **Do not edit vendor files except as a deliberate, documented patch.** Treat
> `src/vendor/foliate-js/` as third-party code. App-side behaviour belongs in
> `ReaderController` / `Reader.svelte`. If you must patch a vendor file, keep the
> diff minimal, leave a `// PATCH(tsuzuri): …` comment at the change site, and
> note it in this section so the next person re-applying an upstream sync knows.

---

## 2. The `<foliate-view>` API we use

`<foliate-view>` is the high-level custom element (class `View`, view.js:209,
`customElements.define('foliate-view', View)` at view.js:593). `ReaderController`
declares the minimal surface it touches as the `FoliateView` interface
(reader.ts:29-43). Everything we call:

| Member | Signature (as used) | Notes (verified in view.js) |
| --- | --- | --- |
| `open(book)` | `open(file: File\|Blob\|string): Promise<void>` | view.js:229. Runs `makeBook`, sets `this.book`, picks paginator vs fixed-layout renderer, wires renderer→view events. Does **not** render content yet. |
| `init({lastLocation, showTextStart})` | view.js:310 | Navigates: if `lastLocation` (a CFI/href/index) resolves, goes there; else `showTextStart` jumps to bodymatter via `goToTextStart()`. This is what triggers the first paint. |
| `goTo(target)` | `goTo(target: string\|number): Promise<resolved>` | view.js:456. `target` = CFI, href, or section index. Used for TOC nav, annotation nav. |
| `prev(d?)` / `next(d?)` | view.js:509/512 | Delegate to `renderer.prev/next`. We don't call these directly. |
| `goLeft()` / `goRight()` | view.js:515/518 | **Honour `book.dir`**: `goLeft = dir==='rtl' ? next() : prev()`, `goRight` is the mirror. Critical for vertical JP (rtl) where left-tap must advance. We always use these, never raw prev/next. |
| `getCFI(index, range)` | view.js:427 | Builds a CFI from a spine `index` + a `Range`. Base CFI from `book.sections[index].cfi` (or a fake one), joined with `CFI.fromRange(range)`. |
| `addAnnotation({value}, remove?)` | view.js:364 | `value` is a CFI. Resolves it, finds the section's overlayer; if loaded, fires a `draw-annotation` event (we draw in the handler). Returns `{index, label}`. No-op for unloaded sections. |
| `deleteAnnotation({value})` | view.js:395 | `= addAnnotation(a, true)`; removes the overlay. |
| `deselect()` | view.js:482 | Clears the selection in every loaded content doc. |
| `book` | property | `.dir` ('ltr'|'rtl'), `.metadata`, `.toc`, `.sections`, `.rendition`. Set during `open()`. |
| `renderer` | property | The paginator element (`<foliate-paginator>`). See below. |

`renderer` (paginator) members we touch:

| Member | Notes |
| --- | --- |
| `renderer.setStyles(css)` | Injects/replaces a `<style>` in the **content iframe** doc (paginator.js:1100). Used by `applyAppearance`. Accepts a string, or `[before, after]` pair. |
| `renderer.setAttribute(name, value)` | The paginator has **no JS property API** — layout is configured purely via attributes (`margin`, `gap`, `max-inline-size`, `max-block-size`, `max-column-count`, `animated`). Used by `applyLayout`. |
| `renderer.render()` | Re-runs `#beforeRender` + relayout for the current section (paginator.js:754). Used by `#nudgeLayout`. |

> The view also exposes `close()` (view.js:293) which we call best-effort in
> `destroy()`. Many other view methods exist (`search`, `select`,
> `showAnnotation`, TTS, media overlay) — **we do not use them**; don't assume
> they're wired up.

---

## 3. Events

`ReaderController.open()` subscribes to these `<foliate-view>` CustomEvents
(reader.ts:161-199). All `e.detail` shapes verified in view.js / paginator.js.

| Event | `detail` | Emitted from | We do |
| --- | --- | --- | --- |
| `relocate` | `{ cfi, fraction, tocItem:{label,href}, range, reason, size, ... }` | view.js:333 (`#onRelocate`, forwarding paginator's `relocate`) | Store `lastCFI`; call `onRelocate({cfi,fraction,tocItem,range,reason})`. `reason` is foliate's own relocation reason — `'page'`/`'snap'`/`'scroll'` for a user-driven turn, `'anchor'`/`'navigation'`/`'selection'` for startup/programmatic jumps; §12 uses it to gate progress persistence and close overlays. |
| `load` | `{ doc: Document, index: number }` | view.js:344 (`#onLoad`) — fires once per section load | Record `doc→index` in `#docIndex`; detect writing-mode; attach taps/selection; call `onLoad`. |
| `create-overlay` | `{ index }` | view.js:414 (`#createOverlayer`, when a section's SVG overlay is created) | `reapplyHighlights()` so stored highlights redraw on this freshly-loaded section. |
| `draw-annotation` | `{ draw, annotation:{value}, doc, range }` | view.js:389 (inside `addAnnotation`, when the section is loaded) | `draw(Overlayer.highlight, { color })` where color comes from `#highlightColors`. **This is where a highlight is actually painted.** |
| `show-annotation` | `{ value, index, range }` | view.js:407 (a **click** hit-tests the overlayer) | Call `onShowAnnotation(value, range)` → opens the recolor/delete toolbar. |

Note the asymmetry: `addAnnotation` only *requests* a draw — the actual paint
happens in our `draw-annotation` handler. And `show-annotation` is a real
**click** (not our synthetic tap), so it fires on the same gesture as a tap;
§8 explains how we de-conflict them.

---

## 4. ReaderController API & lifecycle

`ReaderController` (reader.ts:134) owns exactly one `<foliate-view>` for one open
book. It is created by `Reader.svelte` in `onMount` and torn down in
`onDestroy`.

### Constructor

```ts
new ReaderController(container: HTMLElement, settings: ReaderSettings, callbacks: ReaderCallbacks)
```

Creates a `<foliate-view>` styled `display:block;width:100%;height:100%` and
appends it to `container` (reader.ts:149-155). Nothing is rendered until
`open()`.

### Public fields

| Field | Type | Meaning |
| --- | --- | --- |
| `view` | `FoliateView` | The raw element. `view.book.toc` is read by `Reader.svelte` for the TOC sheet. |
| `lastCFI` | `string` | Last CFI seen on `relocate`. Bookmarks fall back to it. |
| `bookDir` | `'ltr'\|'rtl'` | Page-progression direction from `book.dir`; most vertical JP novels are `'rtl'`. |

Private state: `#cb`, `#settings`, `#docIndex` (`WeakMap<Document, index>` for
CFI creation), `#highlightColors` (`Map<cfi, hex>` — the **source of truth** for
highlight colours), `#vertical` (boolean, current writing mode), `#resizeTimer`,
and `#ac` (a single `AbortController` (reader.ts:147) whose `signal` is passed to
**every** per-document listener — taps and `selectionchange`; `destroy()` aborts
it to remove them all at once, so re-loaded sections don't leak listeners).

### Public methods

| Method | Signature | Behaviour |
| --- | --- | --- |
| `open` | `open(file: File, lastCFI?: string): Promise<void>` | Full open sequence (below). |
| `applyAppearance` | `(s: ReaderSettings) => void` | Re-injects the content stylesheet via `renderer.setStyles(appearanceCSS(s))`. Live-safe (§5). |
| `applyLayout` | `(s: ReaderSettings) => void` | Sets paginator geometry attributes, device-scaled (§6). Live-safe. |
| `reopenForWritingMode` | `(file: File) => Promise<void>` | Re-`open()`s the book at `lastCFI` because writing-mode must be re-detected from the content doc. Used only when the user flips horizontal/vertical (§14). |
| `goLeft` / `goRight` | `() => Promise<void>` | Dir-aware page turn, animated as a horizontal **slide** (§8a) — not a direct foliate call. |
| `goTo` | `(target: string\|number) => Promise<any>` | TOC / annotation nav. |
| `cfiForSelection` | `(doc, range) => string \| null` | Looks up `doc`'s index in `#docIndex`, then `view.getCFI(index, range)`. Returns `null` if doc unknown or CFI throws. |
| `addHighlight` | `(cfi, hex) => Promise<void>` | Records colour, then `view.addAnnotation({value:cfi})` (paints if loaded). |
| `removeHighlight` | `(cfi) => Promise<void>` | Drops colour, `view.deleteAnnotation`. |
| `recolorHighlight` | `(cfi, hex) => Promise<void>` | Updates colour, then delete+add to force a redraw at the new colour. |
| `setHighlights` | `(items: {cfi,hex}[]) => void` | Replaces the whole colour map (book-open seeding), then `reapplyHighlights()`. |
| `reapplyHighlights` | `() => void` | `addAnnotation` for every known CFI (no-ops for unloaded sections). Called on `create-overlay`. |
| `clearSelection` | `() => void` | Best-effort `view.deselect()`. |
| `destroy` | `() => void` | Removes the resize listener, clears the timer, **`#ac.abort()`** (removes every per-document tap/selection listener in one shot), best-effort `view.close()`, removes the element. |

### `ReaderCallbacks` (reader.ts:65-73)

```ts
interface ReaderCallbacks {
  onRelocate?:        (d: RelocateDetail) => void
  onLoad?:            (doc: Document, index: number) => void
  onTap?:             (info: TapInfo) => void
  onSelection?:       (info: SelectionInfo) => void
  onSelectionCleared?:() => void
  onShowAnnotation?:  (value: string, range: Range) => void  // tap landed on a highlight
}
```

### Data types

```ts
interface RelocateDetail {
  cfi: string
  fraction: number
  tocItem?: { label?: string; href?: string }
  range?: Range
  reason?: string  // foliate's relocation reason: 'page'|'snap'|'scroll' = user turn; 'anchor'|'navigation'|'selection' = startup/programmatic
}

interface TocItem { label?: string; href?: string; subitems?: TocItem[] }  // a book.toc entry; exported for Reader.svelte's TOC sheet

interface TapInfo {
  doc: Document
  ix: number; iy: number  // coords *inside* the content iframe (for caretRangeFromPoint)
  px: number; py: number  // coords in the *top* window (for positioning popups)
  zone: 'left' | 'center' | 'right'  // edge rails ('left'/'right') vs the wide centre (§8)
}

interface SelectionInfo {
  doc: Document
  range: Range
  text: string
  rect: { left: number; top: number; width: number; height: number }  // in top-window coords
}
```

### `open()` sequence (reader.ts:157-206)

1. `await view.open(file)` — parse + pick renderer (no paint yet).
2. `bookDir = view.book?.dir === 'rtl' ? 'rtl' : 'ltr'`.
3. Register the five event listeners (§3) — `relocate` forwards `detail.reason`.
4. `applyAppearance(settings)` — inject the stylesheet.
5. `applyLayout(settings)` — set paginator geometry attributes.
6. `window.addEventListener('resize', #onResize)` — re-tune on rotation.
7. `await view.init({ lastLocation: lastCFI || undefined, showTextStart: true })`
   — **first paint** (restores last position, else jumps to text start).
8. `#nudgeLayout()` — schedule a single `renderer.render()` at 250ms as a hedge
   for the unverified-on-iOS vertical quirk (§11).

Order matters: appearance + layout are applied **before** `init()` so the first
paint already has the right styles and geometry.

---

## 5. Appearance injection — `appearanceCSS(settings)`

`appearanceCSS(s: ReaderSettings)` (reader.ts:84-128) builds the stylesheet that
foliate injects into **each content iframe document** via
`renderer.setStyles(...)`. It reads the live theme tokens from the **host**
document so the page exactly matches the app chrome:

```ts
const cs = getComputedStyle(document.documentElement)  // one read; forces a style flush
const tok = (name: string) => cs.getPropertyValue(name).trim()
```

Tokens read: `--ink`, `--accent`, `--accent-soft`, and either `--font-jp-sans`
(when `fontFamily === 'sans'`) or `--font-serif`. These are defined on the host
`:root` by the theme system — see `docs/ui-and-design.md`.

Exactly what the injected sheet sets:

| Selector | Declarations |
| --- | --- |
| `html` | `color: --ink`; `background: transparent !important`; `font-size: {round(fontScale*100)}%`; `-webkit-text-size-adjust: none`; **writing-mode override** (see below) |
| `body` | `color: --ink`; `background: transparent !important`; `font-family: {serif\|jp-sans}`; `-webkit-touch-callout: none` (suppress the native iOS callout so our own SelectionToolbar shows) |
| `p, li, blockquote, dd` | `line-height: {lineHeight}`; `text-align: justify`; `-webkit-hyphens/hyphens: auto`; `hanging-punctuation: allow-end last` |
| `[align=left/center/right]` | preserve explicit alignment attrs |
| `a:any-link` | `color: --accent` |
| `::selection` | `background: --accent-soft` |
| `rt` | `-webkit-user-select/user-select: none` (ruby/furigana not selectable — keeps base-text selections clean) |
| `pre` | `white-space: pre-wrap !important` |

Writing-mode override (reader.ts:93-95): only when the user picks a non-`auto`
preference — `writing-mode: vertical-rl !important` for `'vertical'`,
`horizontal-tb !important` for `'horizontal'`. `'auto'` injects nothing, letting
the EPUB's own CSS decide. Font-size is `%` so it scales the EPUB's relative
units rather than overriding absolute ones.

`font-size` lives on `html`, not `body`, so EPUB-relative units cascade. Because
`setStyles` only swaps the `<style>` text content, calling `applyAppearance`
repeatedly is cheap and reflows in place — no reload.

---

## 6. Layout & measure tuning — `applyLayout`

`applyLayout(s)` (reader.ts:246-279) maps device size + settings onto the
paginator's attributes. It runs once during `open()` and again on every resize /
writing-mode flip. It **branches on `this.#vertical`**, because the two axes swap
meaning between writing modes (§7) and vertical 縦書き needs the page box derived
from the viewport (the fix for the §11 quirk):

```ts
const vw = window.innerWidth, vh = window.innerHeight
const minDim = Math.min(vw, vh)
const margin = Math.round(Math.max(28, Math.min(80, minDim * 0.075)) * s.marginScale)
// Two-page spread only in true landscape on a wide screen (mirrors foliate's
// orientation container-query, §7).
const cols = vw > vh && vw >= 820 ? 2 : 1

// NB: we deliberately do NOT set the `animated` attribute — foliate's own page-turn
// animation slides on the *vertical* axis for 縦書き (it stacks pages vertically).
// `ReaderController` animates page turns itself as a horizontal slide (§8a), so
// foliate is left to jump instantly.
r.setAttribute('margin', `${margin}px`)
r.setAttribute('gap', '6%')
r.setAttribute('max-column-count', `${cols}`)
if (this.#vertical) {
  const colHeight = Math.max(320, vh - margin * 2)        // → max-inline-size (column HEIGHT)
  const bandWidth = Math.min(vw - margin * 2, 560 * cols) // → max-block-size  (across-page WIDTH)
  r.setAttribute('max-block-size',  `${Math.round(bandWidth)}px`)
  r.setAttribute('max-inline-size', `${Math.round(colHeight)}px`)  // set LAST: its setter forces render()
} else {
  r.setAttribute('max-block-size', '880px')
  r.setAttribute('max-inline-size', '640px')              // set LAST: its setter forces render()
}
```

| Attribute | Horizontal value / meaning | Vertical (縦書き) value / meaning |
| --- | --- | --- |
| `margin` | `clamp(28, minDim*0.075, 80) * marginScale` px — header/footer band height | Same px; the "marginal" band height |
| `gap` | `6%` — column gap + outer padding | Same |
| `max-column-count` | `cols` = `vw>vh && vw≥820 ? 2 : 1` → 2 = two-page spread on a landscape wide screen | Same |
| `max-inline-size` | `640` px — max **line length** (column width) | `max(320, vh − 2·margin)` px — the column **HEIGHT** (derived from viewport) |
| `max-block-size` | `880` px — max **page height** | `min(vw − 2·margin, 560·cols)` px — the across-page **WIDTH** (caps the text band so wide screens get framed margins) |

The inline/block axes **swap** between modes (see paginator's `#beforeRender`,
§7); that's why `max-inline-size` reads as "line length" horizontally but
"column height" vertically. **Attribute order matters in both branches:**
`max-inline-size` is set *last* because its `attributeChangedCallback` forces a
foliate `render()` (paginator.js:628), so `margin`/`gap`/`max-column-count`/
`max-block-size` must already be in place when it fires. `margin` *must* be `px`
(paginator requires it); `gap` *must* be a `%`.

> **Verified in desktop Chrome at 1194×834** (iPad-Pro-11 landscape): `#container`
> measures 1068×708 (fills the viewport, ~63px margins), with paragraph columns
> filling ~663/708 of the height. **Portrait (834×1194)** also verified:
> `#container` 560×1068, columns ~1000px. See §11 for why deriving these from the
> viewport is what makes the vertical column fill on first paint.

### `#vertical` detection (reader.ts:177-186)

In the `load` handler we read the rendered document's computed writing mode:

```ts
const wm = doc.defaultView.getComputedStyle(doc.documentElement).writingMode || ''
const vertical = wm.startsWith('vertical')
if (vertical !== this.#vertical) { this.#vertical = vertical; this.applyLayout(this.#settings) }
```

So the *first* section load detects vertical-ness and **re-applies layout once**
if it flipped (because `applyLayout` ran with the old `#vertical` before any doc
existed). Note this reads `documentElement` here, whereas the paginator's own
`getDirection` reads `body` (paginator.js:178-187) — in practice the EPUB sets
writing-mode on `html`, and our injected override (§5) also targets `html`.

### `#onResize` (reader.ts:282-285)

A 150ms-debounced `resize` listener re-runs `applyLayout` (e.g. iPad rotation:
`max-column-count` may switch between 1 and 2). Also part of the §11 mitigation.

---

## 7. Pagination internals (paginator.js)

The renderer is `<foliate-paginator>` (class `Paginator extends HTMLElement`,
paginator.js:424). What a developer must know:

- **CSS multi-column** strategy (same as Epub.js). The content lives in a
  sandboxed `<iframe>` (inner `class View`, paginator.js:210); the iframe doc's
  `<html>` is columnized via `column-width` / `column-gap` / `column-fill:auto`
  and sized to one page; the element is expanded to N pages and scrolled.

- **`observedAttributes`** (paginator.js:425): `flow`, `gap`, `margin`,
  `max-inline-size`, `max-block-size`, `max-column-count`. These are the only
  attributes that do anything.

- **`attributeChangedCallback`** (paginator.js:628): `flow` → `render()`;
  `gap`/`margin`/`max-block-size`/`max-column-count` → just set the matching
  `--_<name>` custom property on `#top` (a `ResizeObserver` triggers relayout if
  geometry actually changed); **`max-inline-size` is special — it sets the prop
  *and* explicitly calls `render()`** because it may not change the element's
  measured size. This is why our `#nudgeLayout` re-uses `render()`.

- **`getDirection(doc)`** (paginator.js:178-187): reads `getComputedStyle(body)`
  → `vertical = writingMode === 'vertical-rl' || 'vertical-lr'`; `rtl` from
  `body.dir`/`computed direction`/`html.dir`. This is how the paginator decides
  axis mapping per section.

- **Touch swipe is the paginator's own job.** It binds `touchstart`/`touchmove`/
  `touchend` on both itself and each loaded content doc (paginator.js:567-575),
  tracks velocity, and on `touchend` calls `snap(vx, vy)` to animate to the
  nearest page (and cross section boundaries). **We must NOT implement swipe** —
  doing so double-handles the gesture (§14). It also auto-turns when a selection
  is dragged past the visible range (`checkPointerSelection`, paginator.js:586).

- **Grid layout + custom properties** (paginator.js:454-543). `#top` is a CSS
  grid `container-type: size`. Tunable props (defaults shown):
  `--_gap:7%`, `--_margin:48px`, `--_max-inline-size:720px`,
  `--_max-block-size:1440px`, `--_max-column-count:2`,
  `--_max-column-count-portrait:1`, `--_max-column-count-spread:var(--_max-column-count)`.
  Derived: `--_max-width: calc(--_max-inline-size * --_max-column-count-spread)`,
  `--_max-height: --_max-block-size`. The grid is 5 columns
  (`half-gap | half-gap | content | half-gap | half-gap`) × 3 rows
  (`margin | content | margin`) so margins/heads/feet auto-frame the text.

- **Orientation container-query** (paginator.js:493-500): in
  `@container (orientation: portrait)`, `--_max-column-count-spread` collapses to
  the portrait count (1) for horizontal text — so a portrait iPad shows a single
  column even with `max-column-count=2`. For `.vertical` it inverts (portrait
  vertical text *gets* the full spread). This means our `max-column-count=2` only
  yields a true 2-page spread in **landscape**.

- **Vertical axis mapping** (`.vertical` class + `#beforeRender`,
  paginator.js:488-492, 678-753): when vertical, `size = container height`;
  `--_max-width = --_max-block-size`; `--_max-height = --_max-inline-size * spread`.
  i.e. the inline/block axes swap, which is the source of the §6 dual meanings.
  `columnWidth = size/divisor - gap`, `divisor = min(maxColumnCount, ceil(size/maxInlineSize))`.

---

## 8. Taps & gestures

The gesture model is **"tap defines; edge + swipe turn"**. We implement a **tap**
detector (not swipe — the paginator owns swipe). `#attachTaps(doc)`
(reader.ts:374-466) runs per loaded content doc, on the `load` event. Every
listener it installs (pointerdown/move/up/cancel + selectionchange) is registered
with `{ signal }` from the controller's single `#ac` `AbortController`
(reader.ts:147), so `destroy()`'s one `#ac.abort()` removes them all — no per-doc
listener leak when sections re-load.

A pointer interaction counts as a **tap** iff all hold:

- the pointer is **primary** (`e.isPrimary` on both down and up — ignores
  secondary touches of a multi-touch gesture),
- it was **not cancelled** — a `pointercancel` (scroll handoff, palm rejection,
  gesture recognizer) sets `moved = true` and clears the `active` flag so a stray
  follow-up `pointerup` can't fire a tap,
- movement `< TAP_MOVE_TOLERANCE` (**16px**), measured by `Math.hypot` from
  `pointerdown` to `pointerup`,
- duration `< TAP_MAX_MS` (**400ms**),
- and there is **no non-empty Range selection** (`sel.type === 'Range' &&
  sel.toString().length > 0` → ignore; it's the tail of a selection).

On a tap it computes the **zone** as edge **rails**, not thirds. The rail width is
`EDGE_RAIL_FRACTION` (**0.14**) of the page (iframe) width, clamped to
`[56px, 22%]`:

```ts
const w = doc.documentElement.clientWidth || window.innerWidth
const rail = Math.min(Math.max(w * EDGE_RAIL_FRACTION, 56), w * 0.22)
const zone = e.clientX < rail ? 'left' : e.clientX > w - rail ? 'right' : 'center'
```

So `left`/`right` are narrow edge rails and `center` is the **wide everything
in-between**. Coords are iframe-local (`e.clientX/Y`). It also translates them to
top-window coords via the iframe's frame element for popups:

```ts
const frame = doc.defaultView?.frameElement
const rect  = frame?.getBoundingClientRect()
const px = (rect?.left ?? 0) + e.clientX   // top-window X for popups
const py = (rect?.top  ?? 0) + e.clientY
```

Then emits `onTap({ doc, ix:e.clientX, iy:e.clientY, px, py, zone })`. `ix/iy`
(iframe-local) feed `caretRangeFromPoint`/`extractTextAt`; `px/py` (top-window)
position the popup.

### Tap routing in Reader.svelte

`onTap` (Reader.svelte:231) and `handleTap` (Reader.svelte:243) do the routing.

`handleTap` runs in a fixed order:

1. **Dismiss-first.** If `dictState.open || hlEdit.open`, set both `false` and
   `return` — **any** tap dismisses an open dictionary popup / highlight-edit
   toolbar and is *consumed* (the fix for the reported "popup won't dismiss /
   inconsistent" behaviour).
2. **Edge rail → turn.** If `zone` is `'left'`/`'right'`: set `userInteracted =
   true`, hide chrome, and call `controller.goLeft()` / `goRight()`. These are
   foliate's **direction-aware** turns, so a left-rail tap advances correctly in
   both LTR and vertical RTL books. `return`.
3. **Centre → define or chrome.** If `settings.tapToDefine && tryDefine(info)`
   (the tap landed on a Japanese **glyph** per `extractTextAt` + `looksJapanese`;
   §10 / `docs/japanese.md`), the lookup runs and routing stops. Otherwise toggle
   `chromeVisible` (the top/bottom bars).

### 8a. Page-turn animation — horizontal slide (`#turn` / `#slide`)

`controller.goLeft()` / `goRight()` no longer call foliate directly; they animate a
**horizontal slide** (like Books on iPad) via `#turn(dir)` → `#slide(dir)`
(reader.ts). Why: foliate stacks 縦書き pages on the **vertical** axis (§7), so its
own `animated` turn slides up/down — which read as wrong for a Japanese book. So we
leave foliate's `animated` attribute **off** (§6) and drive the visual ourselves:

1. Slide the whole `<foliate-view>` out to one edge (`transform: translateX(±100%)`,
   `TURN_PHASE_MS` = 150ms) with a soft `box-shadow` as a depth cue.
2. Jump to the target page while off-screen — `await view.goLeft()/goRight()`,
   instant because `animated` is off (direction-aware, correct for LTR + RTL).
3. Slide the new page in from the opposite edge back to `translateX(0)`.

The new page enters from the side the reader moved toward; the old page leaves the
opposite edge, so it reads as one continuous horizontal push. Both phases are
**`transitionend`-driven** (`#transition`, with a `TURN_PHASE_MS + 120` fallback) so
timer drift can't leave a blank-paper gap between them. A `#turning` flag plus a
single `#pendingDir` **coalesce rapid taps** (the latest queued turn runs when the
current finishes); `destroy()` clears `#pendingDir`.

Constraints worth knowing: a literal page-**curl** isn't possible — the content is a
sandboxed, closed-shadow-DOM iframe that can't be rasterised — and only one page is
rendered at a time, so the vacated strip shows the **paper background** during the
slide (the intended look). `goTo()` (TOC / annotation nav) is **not** animated; only
`goLeft`/`goRight` slide. Foliate still owns **swipe** (§7); with `animated` off a
swipe **snaps instantly** (its drag-follow remains on foliate's vertical axis).

### Highlight de-conflict (the 60ms defer)

A real `click` fires on the same gesture as our tap, and may hit-test a highlight
→ `show-annotation`. So `onTap` defers `handleTap` by **~60ms via `pendingTap =
setTimeout(...)` *only when `hasHighlights` is true*** (Reader.svelte:232-237). If
`onShowAnnotation` fires first it clears `pendingTap` (Reader.svelte:167-170) and
opens the edit toolbar instead of turning/defining. With no highlights, the tap
runs immediately. `pendingTap` is also cleared in `onDestroy`.

### Overlays auto-close on a real turn

`onRelocate` calls `closeOverlays()` (closes `dictState`, `hlEdit`, and `sel`)
when `detail.reason` is `'page'`/`'snap'`/`'scroll'` — i.e. a real user-driven
page turn invalidates any popup/toolbar anchored to the previous page
(Reader.svelte:102-105).

---

## 9. Selection

`#attachTaps` also installs a **250ms-debounced** `selectionchange` listener on
the content doc (reader.ts:437-465; registered with the same `#ac` signal as the
tap listeners). When the debounce fires and there is a non-empty Range:

```ts
const range = sel.getRangeAt(0)
const r  = range.getBoundingClientRect()
const fr = frame?.getBoundingClientRect()   // iframe → top-window offset
onSelection({ doc, range, text: sel.toString(),
  rect: { left: fr.left + r.left, top: fr.top + r.top, width: r.width, height: r.height } })
```

Otherwise it calls `onSelectionCleared()`. The top-window `rect` is what
positions the `SelectionToolbar` (which now places itself via
`placeAnchored(centerX, rect.top, rect.top+rect.height, …)` — §12). In
`Reader.svelte`, `onSelection` opens the toolbar with three actions:

- **Highlight** (`createHighlight(color)`): `cfiForSelection` → persist an
  `Annotation` via `saveAnnotation` → `controller.addHighlight(cfi, hex)` →
  `clearSelection()`.
- **Copy** (`copySelection`): `navigator.clipboard.writeText(sel.text)`.
- **Translate** (`translateSelection`): stash text, open `TranslationSheet`.

A real page-turn relocate (`reason` `'page'`/`'snap'`/`'scroll'`) closes the
selection toolbar along with the other overlays via `closeOverlays()` (§8, §12).

(The paginator independently watches `selectionchange` to auto-turn pages while
dragging a selection past the page edge — paginator.js:602-616 — but that is its
own concern and doesn't interfere with ours.)

---

## 10. Highlights & CFI

The colour map `#highlightColors: Map<cfi, hex>` (reader.ts:143) is the **single
source of truth** for how a highlight is drawn. Persistence is separate — the
`annotations` store (`docs/storage-pwa-ios.md`, `docs/japanese.md`) holds the
durable records; `#highlightColors` is the in-memory render state.

Draw/paint flow:

1. `addHighlight(cfi, hex)` / `setHighlights(...)` records the colour, then asks
   the view to annotate. `setHighlights` (called on book open with the loaded
   `Annotation`s) clears + reseeds the whole map.
2. `view.addAnnotation({value:cfi})` resolves the CFI to a section + range.
   - If that section is **loaded**, view emits `draw-annotation`; our handler
     (reader.ts:195-199) calls `draw(Overlayer.highlight, { color })` — color =
     `#highlightColors.get(value) ?? '#ffd54a'`. `Overlayer.highlight`
     (overlayer.js:126) draws filled `<rect>`s at the range's client rects, at
     `opacity: var(--overlayer-highlight-opacity, .3)`.
   - If **not loaded**, it's a no-op. Later, when that section paints, view emits
     `create-overlay` → we call `reapplyHighlights()` → `addAnnotation` for every
     known CFI → the now-loaded ones draw. This is why highlights survive page
     turns and section loads.
3. `recolorHighlight` = delete + add (forces a redraw at the new colour).
   `removeHighlight` drops the colour and `deleteAnnotation`s.

CFI creation: `cfiForSelection(doc, range)` (reader.ts:312) looks up the doc's
spine index in the `#docIndex` `WeakMap` (populated on every `load`), then
`view.getCFI(index, range)`. Returns `null` if the doc is unknown or CFI
throwing. CFIs are stable across reflow/font changes, which is exactly why
annotations and reading progress are anchored by CFI rather than offsets (see
`epubcfi.js`: `fromRange`, `toRange`, `compare`, `parse`).

Editing a highlight: tapping it → `show-annotation` → `onShowAnnotation(value,
range)` opens the second `SelectionToolbar` instance (recolor / delete only,
`showCopy={false} showTranslate={false} showDelete={true}`).

---

## 11. The vertical column-height fill quirk (honest writeup)

**Status:** with the viewport-derived `applyLayout` (§6) the vertical page box now
**fills on the first paint** — verified in desktop Chrome at 1194×834 landscape
(`#container` = 1068×708, columns ~663/708) and 834×1194 portrait (`#container` =
560×1068, columns ~1000px), no nudge needed. The section below records the
mechanism and the residual unverified-on-iOS risk.

**Root cause of the old "dead band".** In landscape vertical, foliate's `.vertical`
container-query rule sets the across-page spread to the *portrait* count (1), so
`--_max-height = max-inline-size × 1`. The old code hard-coded
`max-inline-size: 1100`, which let the page box (`#container`) settle ~1416px tall
on an 834px-high viewport — roughly **1.7× too tall**, overflowing the viewport
and leaving a dead band at the bottom of the visible page. The side margins and
the text *measure* were always correct; it was purely the block-axis size that
came out wrong.

**The fix.** Derive the caps from the live viewport (§6): vertical
`max-inline-size = max(320, vh − 2·margin)` (the column **height**) and
`max-block-size = min(vw − 2·margin, 560·cols)` (the across-page **width**).
Because the landscape vertical spread is 1, deriving `max-inline-size` from `vh`
makes `--_max-height` clamp deterministically to the available height, so the box
fits the screen instead of guessing.

**Remaining hedges** (best-effort, idempotent):

- `#nudgeLayout()` (reader.ts:215-223) schedules **a single** `renderer.render()`
  at **250ms** after `init`, as a lightweight hedge in case a real device still
  under-measures after fonts/layout settle. (Down from the old 4-render cascade at
  120/350/700/1200ms — the viewport-derived layout no longer needs it in Chrome.)
- The `#onResize` listener (§6) re-applies layout on any real viewport change and
  is the reliable backstop.

> **NEEDS on-device iOS Safari verification.** The fill was verified only in
> desktop Chrome devicetoolbar emulation. Whether real iOS Safari/PWA measures the
> viewport-derived box identically (and whether the single 250ms nudge suffices if
> it does not) is **unconfirmed**. If you change the layout caps or the nudge,
> re-test on a physical device at the affected sizes.

---

## 12. Reader.svelte wiring

`Reader.svelte` is the screen; it owns no rendering itself, only orchestration.

**Mount** (`onMount`, Reader.svelte:319): `Promise.all([getBookMeta, getBookFile,
getProgress])` → throw if no file → **seed displayed progress from the saved
`progress`** (`fraction`/`currentCFI`/`sectionLabel`) so the bar is correct before
the first relocate → `new ReaderController(host, settings, callbacks)` →
`controller.open(file, progress?.cfi)` → read `controller.view.book?.toc` for the
TOC sheet → `loadAnnotations(bookId)` → `controller.setHighlights(highlights
mapped to {cfi,hex})` → `status='ready'`. Errors set `status='error'` and show a
back-to-library CTA.

**Reactive UI state** (`$state`/`$derived`): `chromeVisible`, `fraction`,
`sectionLabel`, `currentCFI`, `isBookmarked` (derived: a bookmark annotation at
`currentCFI`), `hasHighlights` (derived; gates the 60ms tap-defer in §8). A
plain (non-reactive) module-scope `userInteracted` flag (Reader.svelte:84) gates
progress persistence — see below.

**Callbacks → UI:**

- `onRelocate` (Reader.svelte:96-107) → updates `fraction`/`currentCFI`/
  `sectionLabel`. On a **real** turn (`detail.reason` `'page'`/`'snap'`/`'scroll'`)
  it sets `userInteracted = true` and calls `closeOverlays()` (dict popup +
  both toolbars). It runs the **600ms-debounced `putProgress`** *only after*
  `userInteracted` is true — so the noisy startup relocations (which can report a
  bogus fraction, the cause of "a fresh book reopens mid-way") don't persist a
  misleading position. `userInteracted` is also set by edge-rail taps and by
  TOC/annotation navigation.
  > **Honest caveat on the fraction.** foliate's `relocate.fraction` is an
  > *overall-book* fraction (view.js's `SectionProgress.getProgress`, progress.js)
  > that includes the page's trailing-edge term. On the tiny 2-page test EPUB,
  > page 1 reports ~39%; on a real multi-hundred-page book page 1 ≈ 0–1%. That is
  > foliate's progress model, not a bug — the persistence gating is what prevents a
  > bogus *restore*.
- `onTap` → §8 routing (dismiss-first → edge-rail turn → centre define/chrome),
  with the 60ms defer when `hasHighlights`.
- `onSelection`/`onSelectionCleared` → drive the first `SelectionToolbar`.
- `onShowAnnotation` → clears `pendingTap`, closes the dict popup, opens the
  highlight-edit toolbar.

**Sheets & popups** (all `<Sheet>` overlays): `TocSheet` (`onnavigate` →
`controller.goTo(href)`), `ReaderSettings` (its `onchange(kind)` →
`controller.applyAppearance` / `applyLayout` / `reopenForWritingMode` per
`'appearance'|'layout'|'writingmode'`), `AnnotationsPanel` (`onnavigate` →
`goTo(cfi)`), `TranslationSheet`, `DictionaryPopup`.

**Two `SelectionToolbar` instances**: one for fresh selections
(color/copy/translate), one for editing an existing highlight
(recolor/delete). Both position themselves through the shared
`placeAnchored(...)` helper (`src/lib/util/anchoredPosition.ts`, §12-anchoring).
Component props verified: `open, rect, activeColor, showCopy, showTranslate,
showDelete, onColor, onCopy, onTranslate, onDelete`.

The `DictionaryPopup` likewise positions via `placeAnchored` from its tap
anchor (`x/y`); its effect re-runs on `x`/`y` *or content* change so a re-tap on
another word — or a result loading in — re-places the card rather than leaving it
at the first spot, and it carries a focusable close (×) button.

**Chrome**: top bar (library / notes / display) + bottom bar (TOC / progress /
bookmark toggle). `toggleBookmark` adds/removes a `bookmark` annotation at
`currentCFI || controller.lastCFI`.

**Destroy** (`onDestroy`, Reader.svelte:361-365): clears `pendingTap`, then
`controller.destroy()` + `clearAnnotations()`.

### Anchored positioning (§12-anchoring)

`placeAnchored(centerX, anchorTop, anchorBottom, w, h, opts)`
(`src/lib/util/anchoredPosition.ts`) is the shared placement routine for the
dictionary popup and both selection toolbars: it centres horizontally on
`centerX`, **prefers above** the anchor and **flips below** when it would collide
with the top margin, and clamps the result inside the viewport honouring the
`--safe-*` insets (iPad rounded corners / home indicator). All coordinates are
top-window. The popup passes a larger `gap: 16`; toolbars use the default.

---

## 13. How to extend

**Add a reader control / setting.** Add the field to `ReaderSettings` +
`DEFAULT_SETTINGS` in `src/services/types.ts`; add a control to
`ReaderSettings.svelte` that calls `updateSettings({...})` and then
`onchange('appearance'|'layout'|'writingmode')`. If it changes the injected
stylesheet, extend `appearanceCSS` (reader.ts:84) and route via `'appearance'`.
If it changes geometry, extend `applyLayout` and route via `'layout'`. Anything
that depends on re-detecting writing-mode must route via `'writingmode'` →
`reopenForWritingMode`.

**Add a new gesture.** Add it to `#attachTaps` (reader.ts:374). Reuse the
existing pointer bookkeeping (`active`/`moved`/`downT`, the `e.isPrimary` guard,
and the `pointercancel` abort). **Register the listener with the shared
`{ signal }` from `#ac`** so `destroy()`'s single abort cleans it up — don't add
a bespoke `removeEventListener`. **Do not add swipe** — the paginator owns it
(§14). For e.g. long-press, gate on `e.timeStamp - downT > TAP_MAX_MS` plus the
no-movement check, add a callback to `ReaderCallbacks`, emit it, and handle it in
`Reader.svelte`. Remember to translate coords to top-window space via
`frameElement.getBoundingClientRect()` if you need to position UI (or reuse
`placeAnchored`).

**Change the reading measure.** Tune `applyLayout` (reader.ts:246) — note it
**branches on `#vertical`**. Common knobs: the margin clamp
`max(28, min(80, minDim*0.075))`, `gap` `'6%'`, the `cols` breakpoint
(`vw > vh && vw >= 820`), and the per-mode caps — **horizontal** `max-inline-size`
`640` / `max-block-size` `880`; **vertical** `max-inline-size` = column height
`max(320, vh − 2·margin)` / `max-block-size` = band width `min(vw − 2·margin,
560·cols)` (and `EDGE_RAIL_FRACTION` `0.14` for the tap rails, §8). Keep `margin`
in `px` and `gap` in `%`, and keep `max-inline-size` set **last** (its setter
forces a foliate `render()`). Remember the inline/block axes swap for vertical
(§6/§7) and the orientation container-query gates the 2-up spread to landscape.

**Add a new annotation type.** Today only `Overlayer.highlight` is used. To add
e.g. underline: in the `draw-annotation` handler (reader.ts:195) branch on the
annotation's kind/colour and call `draw(Overlayer.underline, {...})` /
`Overlayer.squiggly` / `Overlayer.strikethrough` (all in overlayer.js). Extend
the `Annotation` model + the `annotations` store accordingly, and seed via
`setHighlights`-style logic so they redraw on `create-overlay`.

**Patch a vendor file safely.** Follow the §1 policy: minimal diff, a
`// PATCH(tsuzuri): …` comment at the site, and a note in §1 of this doc. Prefer
solving in `ReaderController`/`Reader.svelte` first. If patching the paginator,
beware: it has no JS property API (attributes only) and a closed shadow DOM.

---

## 14. Gotchas

- **Swipe is foliate's; the page-turn *animation* is ours.** The paginator binds
  `touch*` on itself *and* every content doc and runs its own velocity-based `snap`
  (§7) — don't implement swipe in the app (it would double-handle the gesture). But
  we **leave foliate's `animated` attribute off** (§6) and animate `goLeft`/`goRight`
  ourselves as a horizontal slide (§8a), because foliate's own turn animation slides
  on the vertical axis for 縦書き. Don't re-add `animated` (you'd get a vertical
  slide fighting the horizontal one). A swipe therefore *snaps instantly*. Only
  **taps**, **selection**, and the **turn animation** are ours.
- **The iframe is `sandbox="allow-same-origin allow-scripts"`** (paginator.js:244).
  Having both is required for events to fire (WebKit bug 218086) and produces a
  benign browser console warning ("an iframe which has both allow-scripts and
  allow-same-origin … can escape its sandboxing"). It is expected; do not "fix"
  it by dropping a flag. EPUB scripts are *not* executed by foliate (no script
  support); rely on CSP to block scripts (see vendor README §Security).
- **Content lives in a CLOSED shadow DOM.** `View` uses
  `attachShadow({ mode:'closed' })` (view.js:210) and so does the paginator
  (paginator.js:429). You **cannot** reach the rendered content from the top page
  via `querySelector`/`shadowRoot`. The *only* handle to a content `Document` is
  the `load` event's `e.detail.doc` (captured in `#docIndex` and passed to
  `onLoad`/`onTap`/`onSelection`). All content-doc work (taps, selection, JP
  text extraction, CFI) must flow through that `doc`.
- **Writing-mode toggle requires `reopenForWritingMode`.** `applyAppearance`'s
  injected `writing-mode` override changes the CSS, but the paginator's
  vertical/RTL axis decisions were made from `getDirection(doc)` at load time and
  are **not** re-derived on a style swap. So flipping horizontal⇄vertical must go
  through `reopenForWritingMode(file)`, which re-`open()`s at `lastCFI`. This is
  why `ReaderSettings.svelte` routes the writing-mode segment via
  `onchange('writingmode')`.
- **`addAnnotation` is async + lossy for unloaded sections.** It silently no-ops
  if the target section isn't loaded; rely on `create-overlay` →
  `reapplyHighlights` to backfill. Don't assume a highlight painted just because
  `addHighlight` resolved.
- **Define and page-turn no longer collide.** With the rail model (§8), define
  fires *only* from the wide centre zone *and only when the tap lands on an actual
  glyph* — `extractTextAt` returns `null` in margins / inter-column gaps because
  `pointOnGlyph` (extract.ts:42) bounds `caretRangeFromPoint`'s snapping (§10,
  `docs/japanese.md`). The edge rails always navigate, and any tap while a popup /
  edit toolbar is open just dismisses it. So a tap can't both define and turn the
  page; if you widen the rails or change `EDGE_RAIL_FRACTION`/`GLYPH_HIT_SLACK`,
  preserve that separation.

---

## 15. Cross-references

- `docs/architecture.md` — app shell, routing, stores, services overview.
- `docs/japanese.md` — `extractTextAt`/`looksJapanese`, dictionary lookup
  (`jp/lookup`, `jp/dictdb`), furigana, the `annotations` store contents.
- `docs/ui-and-design.md` — theme tokens (`--ink`, `--accent`, `--accent-soft`,
  `--font-serif`, `--font-jp-sans`), `Sheet`/`SelectionToolbar`/`Segmented`
  components, chrome styling.
- `docs/storage-pwa-ios.md` — OPFS book bytes, IndexedDB (`getBookMeta`,
  `getProgress`/`putProgress`, annotations persistence), PWA + iOS specifics.
