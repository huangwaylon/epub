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
(reader.ts:147-184). All `e.detail` shapes verified in view.js / paginator.js.

| Event | `detail` | Emitted from | We do |
| --- | --- | --- | --- |
| `relocate` | `{ cfi, fraction, tocItem:{label,href}, range, size, ... }` | view.js:333 (`#onRelocate`, forwarding paginator's `relocate`) | Store `lastCFI`; call `onRelocate({cfi,fraction,tocItem,range})`. |
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

`ReaderController` (reader.ts:122) owns exactly one `<foliate-view>` for one open
book. It is created by `Reader.svelte` in `onMount` and torn down in
`onDestroy`.

### Constructor

```ts
new ReaderController(container: HTMLElement, settings: ReaderSettings, callbacks: ReaderCallbacks)
```

Creates a `<foliate-view>` styled `display:block;width:100%;height:100%` and
appends it to `container` (reader.ts:135-141). Nothing is rendered until
`open()`.

### Public fields

| Field | Type | Meaning |
| --- | --- | --- |
| `view` | `FoliateView` | The raw element. `view.book.toc` is read by `Reader.svelte` for the TOC sheet. |
| `lastCFI` | `string` | Last CFI seen on `relocate`. Bookmarks fall back to it. |
| `bookDir` | `'ltr'\|'rtl'` | Page-progression direction from `book.dir`; most vertical JP novels are `'rtl'`. |

Private state: `#cb`, `#settings`, `#docIndex` (`WeakMap<Document, index>` for
CFI creation), `#highlightColors` (`Map<cfi, hex>` — the **source of truth** for
highlight colours), `#vertical` (boolean, current writing mode), `#resizeTimer`.

### Public methods

| Method | Signature | Behaviour |
| --- | --- | --- |
| `open` | `open(file: File, lastCFI?: string): Promise<void>` | Full open sequence (below). |
| `applyAppearance` | `(s: ReaderSettings) => void` | Re-injects the content stylesheet via `renderer.setStyles(appearanceCSS(s))`. Live-safe (§5). |
| `applyLayout` | `(s: ReaderSettings) => void` | Sets paginator geometry attributes, device-scaled (§6). Live-safe. |
| `reopenForWritingMode` | `(file: File) => Promise<void>` | Re-`open()`s the book at `lastCFI` because writing-mode must be re-detected from the content doc. Used only when the user flips horizontal/vertical (§14). |
| `goLeft` / `goRight` | `() => Promise<void>` | Delegate to view (dir-aware page turn). |
| `goTo` | `(target: string\|number) => Promise<any>` | TOC / annotation nav. |
| `cfiForSelection` | `(doc, range) => string \| null` | Looks up `doc`'s index in `#docIndex`, then `view.getCFI(index, range)`. Returns `null` if doc unknown or CFI throws. |
| `addHighlight` | `(cfi, hex) => Promise<void>` | Records colour, then `view.addAnnotation({value:cfi})` (paints if loaded). |
| `removeHighlight` | `(cfi) => Promise<void>` | Drops colour, `view.deleteAnnotation`. |
| `recolorHighlight` | `(cfi, hex) => Promise<void>` | Updates colour, then delete+add to force a redraw at the new colour. |
| `setHighlights` | `(items: {cfi,hex}[]) => void` | Replaces the whole colour map (book-open seeding), then `reapplyHighlights()`. |
| `reapplyHighlights` | `() => void` | `addAnnotation` for every known CFI (no-ops for unloaded sections). Called on `create-overlay`. |
| `clearSelection` | `() => void` | Best-effort `view.deselect()`. |
| `destroy` | `() => void` | Removes the resize listener, clears the timer, best-effort `view.close()`, removes the element. |

### `ReaderCallbacks` (reader.ts:54-62)

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
interface RelocateDetail { cfi: string; fraction: number; tocItem?: { label?: string; href?: string }; range?: Range }

interface TapInfo {
  doc: Document
  ix: number; iy: number  // coords *inside* the content iframe (for caretRangeFromPoint)
  px: number; py: number  // coords in the *top* window (for positioning popups)
  zone: 'left' | 'center' | 'right'
}

interface SelectionInfo {
  doc: Document
  range: Range
  text: string
  rect: { left: number; top: number; width: number; height: number }  // in top-window coords
}
```

### `open()` sequence (reader.ts:143-191)

1. `await view.open(file)` — parse + pick renderer (no paint yet).
2. `bookDir = view.book?.dir === 'rtl' ? 'rtl' : 'ltr'`.
3. Register the five event listeners (§3).
4. `applyAppearance(settings)` — inject the stylesheet.
5. `applyLayout(settings)` — set paginator geometry attributes.
6. `window.addEventListener('resize', #onResize)` — re-tune on rotation.
7. `await view.init({ lastLocation: lastCFI || undefined, showTextStart: true })`
   — **first paint** (restores last position, else jumps to text start).
8. `#nudgeLayout()` — schedule `renderer.render()` at 120/350/700/1200ms to fix
   the vertical under-measure quirk (§11).

Order matters: appearance + layout are applied **before** `init()` so the first
paint already has the right styles and geometry.

---

## 5. Appearance injection — `appearanceCSS(settings)`

`appearanceCSS(s: ReaderSettings)` (reader.ts:75-116) builds the stylesheet that
foliate injects into **each content iframe document** via
`renderer.setStyles(...)`. It reads the live theme tokens from the **host**
document so the page exactly matches the app chrome:

```ts
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() }
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

Writing-mode override (reader.ts:81-83): only when the user picks a non-`auto`
preference — `writing-mode: vertical-rl !important` for `'vertical'`,
`horizontal-tb !important` for `'horizontal'`. `'auto'` injects nothing, letting
the EPUB's own CSS decide. Font-size is `%` so it scales the EPUB's relative
units rather than overriding absolute ones.

`font-size` lives on `html`, not `body`, so EPUB-relative units cascade. Because
`setStyles` only swaps the `<style>` text content, calling `applyAppearance`
repeatedly is cheap and reflows in place — no reload.

---

## 6. Layout & measure tuning — `applyLayout`

`applyLayout(s)` (reader.ts:223-240) maps device size + settings onto the
paginator's attributes. It runs once during `open()` and again on every resize /
writing-mode flip.

```ts
const vw = window.innerWidth, vh = window.innerHeight
const minDim = Math.min(vw, vh)
const margin   = Math.round(Math.max(28, Math.min(80, minDim * 0.075)) * s.marginScale)
const maxInline = this.#vertical ? 1100 : 640
r.setAttribute('margin', `${margin}px`)
r.setAttribute('gap', '6%')
r.setAttribute('max-inline-size', `${maxInline}px`)
r.setAttribute('max-block-size', '880px')
r.setAttribute('max-column-count', vw >= 820 ? '2' : '1')
r.setAttribute('animated', '')
```

| Attribute | Value | Horizontal meaning | Vertical (縦書き) meaning |
| --- | --- | --- | --- |
| `margin` | `clamp(28, minDim*0.075, 80) * marginScale` px | Header/footer band height; framing top/bottom | Same (the "marginal" band height) |
| `gap` | `6%` | Column gap + outer padding (% of page size) | Same |
| `max-inline-size` | 640 / **1100** px | Max **line length** (column width) | Max **column height** — vertical text wants *tall* columns, hence 1100 |
| `max-block-size` | `880` px | Max **page height** | Centres the text band: caps the across-page width so wide iPad screens get framed margins instead of edge-to-edge text |
| `max-column-count` | `vw≥820 ? 2 : 1` | 2 → **two-page spread** on iPad-width screens | Same (subject to the orientation container-query, §7) |
| `animated` | present | Sliding page-turn transition | Same |

The inline/block axes **swap** between modes (see paginator's `#beforeRender`,
§7); that's why `max-inline-size` reads as "line length" horizontally but
"column height" vertically. `margin` *must* be `px` (paginator requires it);
`gap` *must* be a `%`.

### `#vertical` detection (reader.ts:160-171)

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

### `#onResize` (reader.ts:243-247)

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

We implement a **tap** detector (not swipe) because the paginator already owns
swipe. `#attachTaps(doc)` (reader.ts:335-374) runs per loaded content doc, on the
`load` event.

A pointer interaction counts as a **tap** iff all hold:

- movement `< TAP_MOVE_TOLERANCE` (10px), measured by `Math.hypot` from
  `pointerdown` to `pointerup`,
- duration `< TAP_MAX_MS` (350ms),
- and there is **no non-empty Range selection** (`sel.type === 'Range' &&
  sel.toString().length > 0` → ignore; it's the tail of a selection).

On a tap it computes the **zone** by horizontal thirds of
`doc.documentElement.clientWidth`: `< third` = `left`, `> 2*third` = `right`,
else `center`. It translates iframe-local coords to top-window coords via the
iframe's frame element:

```ts
const frame = doc.defaultView?.frameElement
const rect  = frame?.getBoundingClientRect()
const px = (rect?.left ?? 0) + e.clientX   // top-window X for popups
const py = (rect?.top  ?? 0) + e.clientY
```

Then emits `onTap({ doc, ix:e.clientX, iy:e.clientY, px, py, zone })`. `ix/iy`
(iframe-local) feed `caretRangeFromPoint` for dictionary lookup; `px/py`
(top-window) position the popup.

### Tap routing in Reader.svelte

`onTap` (Reader.svelte:211) and `handleTap` (Reader.svelte:223) do the routing:

- **Deferral when highlights exist.** Because a real `click` also fires (and may
  hit-test a highlight → `show-annotation`), when `hasHighlights` is true the tap
  action is deferred `~60ms` via `pendingTap = setTimeout(...)`. If
  `onShowAnnotation` fires first it **cancels `pendingTap`** (Reader.svelte:148)
  so tapping a highlight opens the edit toolbar instead of turning the page /
  defining. With no highlights, the tap runs immediately.
- **Dictionary first** (`handleTap`): if `settings.tapToDefine` and
  `tryDefine(info)` returns true (the tap landed on Japanese text per
  `extractTextAt` + `looksJapanese`), the lookup runs and routing stops. See
  `docs/japanese.md`.
- **Dismiss popup**: a stray tap while the dict popup is open just closes it.
- **Zones**: `center` toggles `chromeVisible` (the top/bottom bars). `left` →
  `controller.goLeft()`, `right` → `controller.goRight()` (dir-aware; also hides
  chrome). Page turns themselves are the paginator's animation.

---

## 9. Selection

`#attachTaps` also installs a **250ms-debounced** `selectionchange` listener on
the content doc (reader.ts:378-402). When the debounce fires and there is a
non-empty Range:

```ts
const range = sel.getRangeAt(0)
const r  = range.getBoundingClientRect()
const fr = frame?.getBoundingClientRect()   // iframe → top-window offset
onSelection({ doc, range, text: sel.toString(),
  rect: { left: fr.left + r.left, top: fr.top + r.top, width: r.width, height: r.height } })
```

Otherwise it calls `onSelectionCleared()`. The top-window `rect` is what
positions the `SelectionToolbar`. In `Reader.svelte`, `onSelection` opens the
toolbar with three actions:

- **Highlight** (`createHighlight(color)`): `cfiForSelection` → persist an
  `Annotation` via `saveAnnotation` → `controller.addHighlight(cfi, hex)` →
  `clearSelection()`.
- **Copy** (`copySelection`): `navigator.clipboard.writeText(sel.text)`.
- **Translate** (`translateSelection`): stash text, open `TranslationSheet`.

(The paginator independently watches `selectionchange` to auto-turn pages while
dragging a selection past the page edge — paginator.js:602-616 — but that is its
own concern and doesn't interfere with ours.)

---

## 10. Highlights & CFI

The colour map `#highlightColors: Map<cfi, hex>` (reader.ts:131) is the **single
source of truth** for how a highlight is drawn. Persistence is separate — the
`annotations` store (`docs/storage-pwa-ios.md`, `docs/japanese.md`) holds the
durable records; `#highlightColors` is the in-memory render state.

Draw/paint flow:

1. `addHighlight(cfi, hex)` / `setHighlights(...)` records the colour, then asks
   the view to annotate. `setHighlights` (called on book open with the loaded
   `Annotation`s) clears + reseeds the whole map.
2. `view.addAnnotation({value:cfi})` resolves the CFI to a section + range.
   - If that section is **loaded**, view emits `draw-annotation`; our handler
     (reader.ts:180) calls `draw(Overlayer.highlight, { color })` — color =
     `#highlightColors.get(value) ?? '#ffd54a'`. `Overlayer.highlight`
     (overlayer.js:126) draws filled `<rect>`s at the range's client rects, at
     `opacity: var(--overlayer-highlight-opacity, .3)`.
   - If **not loaded**, it's a no-op. Later, when that section paints, view emits
     `create-overlay` → we call `reapplyHighlights()` → `addAnnotation` for every
     known CFI → the now-loaded ones draw. This is why highlights survive page
     turns and section loads.
3. `recolorHighlight` = delete + add (forces a redraw at the new colour).
   `removeHighlight` drops the colour and `deleteAnnotation`s.

CFI creation: `cfiForSelection(doc, range)` (reader.ts:273) looks up the doc's
spine index in the `#docIndex` `WeakMap` (populated on every `load`), then
`view.getCFI(index, range)`. Returns `null` if the doc is unknown or CFI
throwing. CFIs are stable across reflow/font changes, which is exactly why
annotations and reading progress are anchored by CFI rather than offsets (see
`epubcfi.js`: `fromRange`, `toRange`, `compare`, `parse`).

Editing a highlight: tapping it → `show-annotation` → `onShowAnnotation(value,
range)` opens the second `SelectionToolbar` instance (recolor / delete only,
`showCopy={false} showTranslate={false} showDelete={true}`).

---

## 11. The vertical column-height fill QUIRK (honest writeup)

**Symptom (verified in desktop Chrome devtools):** at certain exact viewport
sizes (e.g. **1194×834**, iPad-Pro-11 landscape) foliate **under-measures the
vertical (縦書き) column height on first paint**, leaving roughly the bottom
~20% of the page as dead space. The *side* margins and the text *measure* are
correct in all cases — it is purely the block-axis fill that comes up short.

**What does NOT fix it:** `renderer.render()`, resizing the foliate element,
toggling its `display`. Only a **true viewport resize** (devtools dimension
change, real window resize) reliably re-measures and fills the column.

**Mitigations in code** (best-effort, idempotent):

- `#nudgeLayout()` (reader.ts:199-208) schedules `renderer.render()` at
  **120 / 350 / 700 / 1200ms** after `init`, so at least one lands after fonts /
  layout settle. Called at the end of `open()` and `reopenForWritingMode()`.
- The `#onResize` listener (§6) re-applies layout on any real viewport change,
  which is the only thing observed to deterministically fix it.

> **NEEDS on-device iOS Safari verification.** The quirk was reproduced in
> desktop Chrome devicetoolbar emulation; whether real iOS Safari/PWA exhibits
> it (and whether the timed nudges suffice there) is **unconfirmed**. Treat the
> nudge delays as a heuristic, not a proven fix. If you change them, re-test on a
> physical device at the affected sizes.

---

## 12. Reader.svelte wiring

`Reader.svelte` is the screen; it owns no rendering itself, only orchestration.

**Mount** (`onMount`, Reader.svelte:293): `Promise.all([getBookMeta, getBookFile,
getProgress])` → throw if no file → `new ReaderController(host, settings,
callbacks)` → `controller.open(file, progress?.cfi)` → read
`controller.view.book?.toc` for the TOC sheet → `loadAnnotations(bookId)` →
`controller.setHighlights(highlights mapped to {cfi,hex})` → `status='ready'`.
Errors set `status='error'` and show a back-to-library CTA.

**Reactive UI state** (`$state`/`$derived`): `chromeVisible`, `fraction`,
`sectionLabel`, `currentCFI`, `isBookmarked` (derived: a bookmark annotation at
`currentCFI`), `hasHighlights` (derived; gates the tap-deferral in §8).

**Callbacks → UI:**

- `onRelocate` → updates `fraction`/`currentCFI`/`sectionLabel` and a
  **600ms-debounced `putProgress`** (saves CFI+fraction+label to IndexedDB).
- `onTap` → §8 routing (dictionary / zone chrome / page turn).
- `onSelection`/`onSelectionCleared` → drive the first `SelectionToolbar`.
- `onShowAnnotation` → cancels `pendingTap`, opens the highlight-edit toolbar.

**Sheets & popups** (all `<Sheet>` overlays): `TocSheet` (`onnavigate` →
`controller.goTo(href)`), `ReaderSettings` (its `onchange(kind)` →
`controller.applyAppearance` / `applyLayout` / `reopenForWritingMode` per
`'appearance'|'layout'|'writingmode'`), `AnnotationsPanel` (`onnavigate` →
`goTo(cfi)`), `TranslationSheet`, `DictionaryPopup`.

**Two `SelectionToolbar` instances**: one for fresh selections
(color/copy/translate), one for editing an existing highlight
(recolor/delete). Component props verified: `open, rect, activeColor, showCopy,
showTranslate, showDelete, onColor, onCopy, onTranslate, onDelete`.

**Chrome**: top bar (library / notes / display) + bottom bar (TOC / progress /
bookmark toggle). `toggleBookmark` adds/removes a `bookmark` annotation at
`currentCFI || controller.lastCFI`.

**Destroy** (`onDestroy`): `controller.destroy()` + `clearAnnotations()`.

---

## 13. How to extend

**Add a reader control / setting.** Add the field to `ReaderSettings` +
`DEFAULT_SETTINGS` in `src/services/types.ts`; add a control to
`ReaderSettings.svelte` that calls `updateSettings({...})` and then
`onchange('appearance'|'layout'|'writingmode')`. If it changes the injected
stylesheet, extend `appearanceCSS` (reader.ts:75) and route via `'appearance'`.
If it changes geometry, extend `applyLayout` and route via `'layout'`. Anything
that depends on re-detecting writing-mode must route via `'writingmode'` →
`reopenForWritingMode`.

**Add a new gesture.** Add it to `#attachTaps` (reader.ts:335). Reuse the
existing pointer bookkeeping. **Do not add swipe** — the paginator owns it
(§14). For e.g. long-press, gate on `e.timeStamp - downT > TAP_MAX_MS` plus the
no-movement check, add a callback to `ReaderCallbacks`, emit it, and handle it in
`Reader.svelte`. Remember to translate coords to top-window space via
`frameElement.getBoundingClientRect()` if you need to position UI.

**Change the reading measure.** Tune `applyLayout` (reader.ts:223): the margin
clamp `max(28, min(80, minDim*0.075))`, `gap` `'6%'`, `maxInline`
(`#vertical ? 1100 : 640`), `max-block-size` `880`, and the
`max-column-count` breakpoint (`vw >= 820`). Keep `margin` in `px` and `gap` in
`%` (paginator requirements). Remember inline/block axes swap for vertical (§6/§7)
and the orientation container-query gates the 2-up spread to landscape.

**Add a new annotation type.** Today only `Overlayer.highlight` is used. To add
e.g. underline: in the `draw-annotation` handler (reader.ts:180) branch on the
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

- **Swipe is foliate's.** The paginator binds `touch*` on itself *and* every
  content doc and runs its own velocity-based `snap` (§7). Implementing swipe in
  the app would double-handle the gesture (double page-turns / fighting
  animations). Only **taps** and **selection** are ours.
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
