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

There are **two** documented patches to the vendored tree:

- **PDF.js + `vendor/pdfjs` removed.** The app is EPUB-focused, so the heavy
  PDF.js dependency and the PDF branch in `view.js`'s `makeBook()` were deleted.
  Verify: `src/vendor/foliate-js/vendor/` contains only `fflate.js` and
  `zip.js`; there is no `pdf.js`. In `makeBook` (view.js:79-119) the format
  dispatch is **zip → CBZ / FBZ / EPUB**, else **MOBI/KF8 → FB2**; there is no
  `isPDF` branch. (The `isPDF` helper at view.js:13 survives as dead code —
  it is defined but never called. Safe to ignore or remove.)
- **foliate's own touch page-turn disabled** (`paginator.js`, search for
  `TSUZURI PATCH`). `#onTouchMove` (paginator.js:831) **keeps** its
  `e.preventDefault()` — that still blocks native scroll and Safari's edge
  back-swipe — but **drops the `this.scrollBy(dx, dy)`** that made the page
  follow the finger. `#onTouchEnd` (paginator.js:857) **drops the velocity
  `snap()`** that animated to the nearest page. The net effect: foliate no
  longer turns pages on touch at all. Page turns are instead driven by our own
  horizontal **swipe** detector in `reader.ts` (§8), so the turn always animates
  as the horizontal **slide** (§8a) — correct for 縦書き, where foliate's own
  motion is on the vertical axis. **This consciously reverses the old advice
  "don't add page-swipe handling, foliate owns swipe"**: we now do our own swipe
  and patch foliate's out, so there is exactly one turn path.

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
(reader.ts:34-49). Everything we call:

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
| `renderer.setStyles(css)` | Injects/replaces a `<style>` in the **content iframe** doc (paginator.js:1098). Used by `applyAppearance`. Accepts a string, or `[before, after]` pair. |
| `renderer.setAttribute(name, value)` | The paginator has **no JS property API** — layout is configured purely via attributes (`margin`, `gap`, `max-inline-size`, `max-block-size`, `max-column-count`, `animated`). Used by `applyLayout`. |
| `renderer.render()` | Re-runs `#beforeRender` + relayout for the current section (paginator.js:754). Used by `#nudgeLayout`. |

> The view also exposes `close()` (view.js:293) which we call best-effort in
> `destroy()`. Many other view methods exist (`search`, `select`,
> `showAnnotation`, TTS, media overlay) — **we do not use them**; don't assume
> they're wired up.

---

## 3. Events

`ReaderController.open()` subscribes to these `<foliate-view>` CustomEvents
(reader.ts:163-200). All `e.detail` shapes verified in view.js / paginator.js.

| Event | `detail` | Emitted from | We do |
| --- | --- | --- | --- |
| `relocate` | `{ cfi, fraction, tocItem:{label,href}, range, size, ... }` | view.js:333 (`#onRelocate`, forwarding paginator's `relocate`) | Store `lastCFI`; call `onRelocate({cfi,fraction,tocItem,range})`. **Note: the emitted detail carries no `reason`.** `#onRelocate` (view.js:325-333) *destructures* a `reason` off the paginator's event and uses it only for its internal `history.replaceState`, but `lastLocation` — the object it `#emit`s — does **not** include `reason`. So you cannot tell a user turn from a startup jump off this event; intent is tracked from the gesture side instead (§4 `onTurn`, §12 `userInteracted`). |
| `load` | `{ doc: Document, index: number }` | view.js:344 (`#onLoad`) — fires once per section load | Record `doc→index` in `#docIndex`; detect writing-mode; attach taps/selection; call `onLoad`. |
| `create-overlay` | `{ index }` | view.js:414 (`#createOverlayer`, when a section's SVG overlay is created) | `reapplyHighlights(e.detail.index)` so **only this freshly-loaded section's** stored highlights redraw. The index scoping (backed by a cached `cfi→index` map) keeps a page-turn into a new section O(highlights-in-that-section), not O(all-highlights-in-the-book) — important because tap-to-define auto-highlights every defined word, so the set grows large. |
| `draw-annotation` | `{ draw, annotation:{value}, doc, range }` | view.js:389 (inside `addAnnotation`, when the section is loaded) | `draw(Overlayer.highlight, { color: HIGHLIGHT_HEX })` — highlights are a single yellow (`HIGHLIGHT_HEX` in `types.ts`); there is no per-highlight colour. **This is where a highlight is actually painted.** |
| `show-annotation` | `{ value, index, range }` | view.js:407 (a **click** hit-tests the overlayer) | Call `onShowAnnotation(value, range)` → **reopens the dictionary popup** for that word (definition + a remove-highlight footer toggle). |

Note the asymmetry: `addAnnotation` only *requests* a draw — the actual paint
happens in our `draw-annotation` handler. And `show-annotation` is a real
**click** (not our synthetic tap), so it fires on the same gesture as a tap;
§8 explains how we de-conflict them.

---

## 4. ReaderController API & lifecycle

`ReaderController` (reader.ts:133) owns exactly one `<foliate-view>` for one open
book. It is created by `Reader.svelte` in `onMount` and torn down in
`onDestroy`.

### Constructor

```ts
new ReaderController(container: HTMLElement, settings: ReaderSettings, callbacks: ReaderCallbacks)
```

Creates a `<foliate-view>` styled `display:block;width:100%;height:100%` and
appends it to `container` (reader.ts:151-156). Nothing is rendered until
`open()`.

### Public fields

| Field | Type | Meaning |
| --- | --- | --- |
| `view` | `FoliateView` | The raw element. `view.book.toc` is read by `Reader.svelte` for the TOC sheet. |
| `lastCFI` | `string` | Last CFI seen on `relocate`. Bookmarks fall back to it. |
| `bookDir` | `'ltr'\|'rtl'` | Page-progression direction from `book.dir`; most vertical JP novels are `'rtl'`. |

Private state: `#cb`, `#settings`, `#docIndex` (`WeakMap<Document, index>` for
CFI creation), `#highlights` (`Set<cfi>` — the **source of truth** for which
ranges are highlighted; highlights are a single yellow, so there is no
per-highlight colour map), `#vertical` (boolean, current writing mode), `#turning` +
`#pendingDir` (the page-turn-slide coalescing flags, §8a), `#resizeTimer`,
and `#ac` (a single `AbortController` (reader.ts:146) whose `signal` is passed to
**every** per-document listener — taps and `selectionchange`; `destroy()` aborts
it to remove them all at once, so re-loaded sections don't leak listeners).

### Public methods

| Method | Signature | Behaviour |
| --- | --- | --- |
| `open` | `open(file: File, lastCFI?: string): Promise<void>` | Full open sequence (below). |
| `applyAppearance` | `(s: ReaderSettings) => void` | Re-injects the content stylesheet via `renderer.setStyles(appearanceCSS(s))`. Live-safe (§5). |
| `applyLayout` | `(s: ReaderSettings) => void` | Sets paginator geometry attributes, device-scaled (§6). Live-safe. |
| `reopenForWritingMode` | `(file: File) => Promise<void>` | Re-`open()`s the book at `lastCFI` because writing-mode must be re-detected from the content doc. Used only when the user flips horizontal/vertical (§14). |
| `goLeft` / `goRight` | `() => Promise<void>` | Dir-aware page turn, animated as a horizontal **slide** (§8a) — not a direct foliate call. Each fires the `onTurn` callback (reader.ts:320/324) before sliding. |
| `goTo` | `(target: string\|number) => Promise<any>` | TOC / annotation nav. |
| `goToFraction` | `(frac: number) => Promise<void>` | Seek to an overall-book fraction (0..1), clamped. Backs the progress **scrubber** (§12). Not animated. |
| `cfiForSelection` | `(doc, range) => string \| null` | Looks up `doc`'s index in `#docIndex`, then `view.getCFI(index, range)`. Returns `null` if doc unknown or CFI throws. |
| `addHighlight` | `(cfi) => Promise<void>` | Adds the CFI to `#highlights`, caches its spine index (`#indexForCFI` via `view.resolveCFI`), then `view.addAnnotation({value:cfi})` (paints yellow if loaded). |
| `removeHighlight` | `(cfi) => Promise<void>` | Drops the CFI (and its cached index), `view.deleteAnnotation`. |
| `setHighlights` | `(cfis: string[]) => void` | Replaces the whole highlight set (book-open seeding) and re-seeds the `cfi→index` cache, then `reapplyHighlights()` (full sweep). |
| `reapplyHighlights` | `(index?: number) => void` | `addAnnotation` for known CFIs (no-ops for unloaded sections). With an `index` (the `create-overlay` path) only redraws that section's highlights; with no index (the `setHighlights` seed) sweeps all. |
| `clearSelection` | `() => void` | Best-effort `view.deselect()`. |
| `destroy` | `() => void` | Removes the resize listener, clears the nudge/resize timers, the page-turn slide fallback timer (`#slideTimer`), and **every** per-document selection-debounce timer (`#selTimers` map), nulls `#pendingDir`, then **`#ac.abort()`** (removes every per-document tap/selection listener *and* any in-flight page-turn `transitionend` listener in one shot), best-effort `view.close()` **then `book.destroy()`** (revokes the EPUB's resource blob URLs), removes the element. |

### `ReaderCallbacks` (reader.ts:60-70)

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

`onTurn` (reader.ts:65) is fired by `goLeft`/`goRight` at the start of every turn
(reader.ts:320/324). `Reader.svelte`'s `onTurn` handler sets the `userInteracted`
flag and calls `closeOverlays()` (§8, §12) — this is what makes a swipe persist
progress and dismiss any popup/toolbar anchored to the page being left, now that
`relocate` no longer carries a `reason`.

### Data types

```ts
interface RelocateDetail {  // reader.ts:8 — note: no `reason` field (foliate's relocate doesn't carry one; §3)
  cfi: string
  fraction: number
  tocItem?: { label?: string; href?: string }
  range?: Range
}

interface TocItem { label?: string; href?: string; subitems?: TocItem[] }  // a book.toc entry; exported for Reader.svelte's TOC sheet

interface TapInfo {  // reader.ts:23 — no `zone` field; pagination is by swipe, not tap rails (§8)
  doc: Document | null    // the content doc, or null for a tap in the margins (host gesture; nothing to define there)
  ix: number; iy: number  // coords *inside* the content iframe (for caretRangeFromPoint)
  px: number; py: number  // coords in the *top* window (for positioning popups; py also feeds the chrome-toggle band test)
}

interface SelectionInfo {
  doc: Document
  range: Range
  text: string
  rect: { left: number; top: number; width: number; height: number }  // in top-window coords
}
```

### `open()` sequence (reader.ts:159-207)

1. `await view.open(file)` — parse + pick renderer (no paint yet).
2. `bookDir = view.book?.dir === 'rtl' ? 'rtl' : 'ltr'`.
3. Register the five event listeners (§3) — the `relocate` handler forwards
   `{cfi,fraction,tocItem,range}` (no `reason`; §3).
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

`appearanceCSS(s: ReaderSettings)` (reader.ts:83-127) builds the stylesheet that
foliate injects into **each content iframe document** via
`renderer.setStyles(...)`. It reads the live theme tokens from the **host**
document so the page exactly matches the app chrome:

```ts
const cs = getComputedStyle(document.documentElement)  // one read; forces a style flush
const tok = (name: string) => cs.getPropertyValue(name).trim()
```

Tokens read: `--ink`, `--paper`, `--accent`, `--accent-soft`, and either
`--font-jp-sans` (when `fontFamily === 'sans'`) or `--font-serif`. These are
defined on the host `:root` by the theme system — see `docs/ui-and-design.md`.

Exactly what the injected sheet sets:

| Selector | Declarations |
| --- | --- |
| `html` | `color: --ink`; **`background: --paper !important`**; **`color-scheme: light\|dark`** (from `s.theme`); `font-size: {round(fontScale*100)}%`; `-webkit-text-size-adjust: none`; **writing-mode override** (see below) |
| `body` | `color: --ink`; `background: transparent !important` (the opaque `--paper` on `html` shows through); `font-family: {serif\|jp-sans}`; `-webkit-touch-callout: none` (suppress the native iOS callout so our own SelectionToolbar shows) |
| `p, li, blockquote, dd` | `line-height: {lineHeight}`; `text-align: justify`; `-webkit-hyphens/hyphens: auto`; `hanging-punctuation: allow-end last` |
| `[align=left/center/right]` | preserve explicit alignment attrs |
| `a:any-link` | `color: --accent` |
| `::selection` | `background: --accent-soft` |
| `rt` | `-webkit-user-select/user-select: none` (ruby/furigana not selectable — keeps base-text selections clean) |
| `pre` | `white-space: pre-wrap !important` |

**Page background / dark mode (why `--paper`, not `transparent`).** The content
iframe is its own document with no theme. A *transparent* root composites over the
iframe's **default canvas**, which follows `color-scheme` and is **white** unless
told otherwise — so a transparent page renders **light even in dark mode** (the
`.reader` dark paper behind the iframe is *not* what shows; the iframe's own canvas
is). The fix paints `html` with the resolved **`--paper`** colour (so the page
matches the chrome and the margins exactly — no seam) and sets **`color-scheme`** so
the canvas, form controls and scrollbars follow the theme too. `body` stays
transparent so the `html` paper shows through. Foliate's `#background` div
(`getBackground`, paginator.js:189) samples `body` then `html`, so with `body`
transparent it picks up the `--paper` from `html` and paints the same colour.

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

`applyLayout(s)` (reader.ts:247-279) maps device size + settings onto the
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
  const bandWidth = vw - margin * 2                       // → max-block-size  (across-page WIDTH)
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
| `max-block-size` | `880` px — max **page height** | `vw − 2·margin` px — the across-page **WIDTH** (fills the available width; only the margin frames it, so the reading surface uses the whole screen rather than floating in dead space) |

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

### `#vertical` detection (reader.ts:178-184)

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

### `#onResize` (reader.ts:282-286)

A 150ms-debounced `resize` listener re-runs `applyLayout` (e.g. iPad rotation:
`max-column-count` may switch between 1 and 2). Also part of the §11 mitigation.

### 6a. Page-progression direction — RTL page order with horizontal LTR text

Some EPUBs declare `page-progression-direction="rtl"` in the spine (so `book.dir
=== 'rtl'`) while their content is **ordinary horizontal LTR** — no vertical
writing mode, no `dir="rtl"` in the content CSS (a common shape for JP novels
typeset 横書き but bound right-to-left; e.g. a `class="vrtl"` on `<html>` with no
rule actually setting `writing-mode`). foliate's paginator derives the **column
order** purely from the *content's own* CSS direction via `getDirection(doc)`
(paginator.js:178 — reads `body.dir` / computed `direction` / `documentElement.dir`),
**not** from `book.dir`. `book.dir` only feeds the direction-aware `goLeft`/`goRight`
(view.js:515/518). So such a book paginates its 2-up landscape spread **left-to-right**
(earlier page on the left) — wrong for an RTL book, where the earlier page must be on
the **right**.

`#applyPageProgression(doc, vertical)` (reader.ts, called from the `load` handler)
fixes this by making the section behave like a **native RTL book**:

- It sets `dir="rtl"` on **both** `documentElement` *and* `body`. `getDirection` then
  reports RTL, so foliate's well-tested RTL path lays the columns right-to-left and
  uses the matching negative-scroll math. **`dir="rtl"` on the multicolumn container
  (`documentElement`) alone does _not_ flip the columns in this layout — the `body`
  must be rtl too** (verified in Chrome: with `body` ltr the document-first content
  stays in the left column; with `body` rtl it moves to the right column).
- It then pins the inline **text** back to ltr with an injected
  `p,div,h1..h6,li,blockquote,dd,dt,figcaption,td,th { direction: ltr }` rule (plus
  `body { text-align: left }`), so the horizontal Japanese text still reads
  left-to-right — only the page/column order is reversed.

It runs **inside foliate's `afterLoad`** — our `load` listener fires synchronously
from `afterLoad` (paginator.js:983 → view.js `#onLoad` → `#emit('load')`) **before**
`getDirection` (paginator.js:262) — so the very first paint is already correct, no
re-render flash. It's a **no-op** unless `book.dir === 'rtl'` and the section is
horizontal (skipped when the writing mode is vertical, detected or forced via
settings): vertical (縦書き) RTL books already stack their columns right-to-left from
`writing-mode: vertical-rl`. This is entirely app-side — no vendor patch.

> The progress *bar* fill (`width: fraction%`, Reader.svelte) still grows
> left-to-right regardless of book direction; only the page/column order is reversed.

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

- **Touch page-turn is patched OUT.** Upstream, the paginator binds
  `touchstart`/`touchmove`/`touchend` on both itself and each loaded content doc
  (paginator.js:568-574), tracks velocity, and on `touchend` snaps to the nearest
  page. **We disable that** (the `TSUZURI PATCH` in `#onTouchMove`/`#onTouchEnd`,
  §1): `#onTouchMove` keeps `e.preventDefault()` (so native scroll and Safari's
  edge back-swipe stay blocked) but drops the finger-follow `scrollBy`, and
  `#onTouchEnd` drops the velocity `snap()`. So foliate no longer turns pages on
  touch — **our** swipe detector in `reader.ts` (§8) is the only turn input, and
  it animates the horizontal slide (§8a). The bindings still exist (the touch
  listeners are attached) but their page-turn effect is removed.
  Independently, the paginator still auto-turns when a *selection* is dragged
  past the visible range (`checkPointerSelection`, paginator.js:586) — that path
  is untouched.

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

The gesture model is **"swipe turns the page; tap defines or toggles chrome"**.
Pagination is by horizontal **swipe only** — there are no tap edge-rails (the old
`EDGE_RAIL_FRACTION` constant and `TapInfo.zone` field are gone), and foliate's
own touch turn is patched out (§1/§7). The shared state machine is `#trackGestures`
(reader.ts) — one swipe-vs-tap decision used by **two** attach points:

- **`#attachTaps(doc)`** — runs per loaded content doc (on the `load` event). Handles
  swipes/taps over the **text column** (the iframe), can ignore a selection tail, and
  emits a `TapInfo` with the `doc` + iframe-local + top-window coords. Also installs
  the `selectionchange` listener (§9).
- **`#attachHostGestures()`** — runs once in `open()`, attached to the **host**
  (`<foliate-view>`). The content iframe only covers the text column, so swipes/taps
  in the surrounding **margins** never reach the per-doc listeners (those areas were
  dead). The margins bubble out of foliate's shadow DOM to the host; events *inside*
  the iframe don't cross the browsing-context boundary, so there's no double-handling.
  A margin tap emits a `TapInfo` with **`doc: null`** (no word to define) and the
  top-window coords, routing straight to the chrome toggle.

Every listener both attach points install is registered with the controller's single
`#ac` `AbortController` signal, so `destroy()`'s one `#ac.abort()` removes them all.

### Swipe → page turn

The `pointerup` handler (reader.ts:493-530) decides swipe-vs-tap. First it bails
if the pointer is non-primary, was cancelled, a non-empty Range selection is
active (`sel.type === 'Range' && sel.toString().length > 0` — that's the tail of
a selection, left for the toolbar), **or the page is pinch-zoomed**
(`visualViewport.scale > 1.01` — a second finger was/is down, so the coordinates
are unreliable and a stray primary `pointerup` shouldn't turn the page or define;
this mirrors the paginator's own pinch guard, §13). Then, from the down→up delta
`dx`/`dy`:

```ts
if (Math.abs(dx) >= SWIPE_MIN_DISTANCE && Math.abs(dx) > Math.abs(dy)) {
  if (dx < 0) void this.goRight()   // dragged left  → reveal the page on the right
  else        void this.goLeft()    // dragged right → reveal the page on the left
  return
}
```

So a drag of at least `SWIPE_MIN_DISTANCE` (**45px**) that is **more horizontal
than vertical** turns the page, and **"the page follows the finger"**: dragging
left reveals the page on the right (`goRight`), dragging right reveals the page on
the left (`goLeft`). Which of those is *next* vs *previous* is foliate's call —
`goLeft`/`goRight` are **direction-aware** and honour the book's page-progression —
so the swipe turns the correct way in LTR, RTL, and vertical (縦書き) books (e.g. in
an RTL 縦書き book, dragging **right** advances), and the turn **always** animates as
the horizontal slide (§8a). A swipe never reaches the tap branch (it `return`s).

### Tap → define or chrome

If the gesture wasn't a swipe, it only counts as a **tap** when movement was
`< TAP_MOVE_TOLERANCE` (**16px**, tracked on `pointermove`) and duration was
`< TAP_MAX_MS` (**400ms**). A `pointercancel` (scroll handoff, palm rejection,
gesture recognizer) marks the interaction moved/inactive so a stray follow-up
`pointerup` can't fire a tap. On a real tap it emits
`onTap({ doc, ix:e.clientX, iy:e.clientY, px, py })` — `ix/iy` (iframe-local) feed
`caretRangeFromPoint`/`extractTextAt`; `px/py` (top-window, via the iframe's
`frameElement.getBoundingClientRect()`) position the popup. There is no `zone` —
a tap carries no notion of edge rails anymore.

### Tap routing in Reader.svelte

`onTap` (Reader.svelte:223) and `handleTap` (Reader.svelte:235) do the routing.
`handleTap` runs in a fixed order:

1. **Top/bottom band → toggle chrome.** If the tap's top-window `py` lands in the
   top or bottom edge band (`inChromeToggleBand`, sized `clamp(80, vh*0.12, 160)` ≈
   the nav-bar height), toggle `chromeVisible`, `closeOverlays()` (so the popup and
   chrome don't overlap), and `return`. This is how a tap **shows** the bars — a tap
   in the central reading area never *reveals* them, so reading taps don't flash the
   chrome. It fires even on a glyph, and it's how a margin/host tap in the band
   reveals the chrome.
2. **Chrome visible → dismiss.** Otherwise, if `chromeVisible`, set it `false` and
   `return` — while the bars are up, a tap **anywhere** in the reading area hides
   them (and is *consumed*, so it doesn't also define). This makes the chrome easy
   to clear without reaching for the bars.
3. **Define + highlight a glyph.** Otherwise (a tap in the central reading area with
   the chrome already hidden), if `settings.tapToDefine` call `tryDefine(info)`. This
   fires **even when a dictionary popup is already open** — so looking up word after
   word is **one tap each** (the popup simply re-anchors to the new word), rather than
   the old behaviour where the first tap was consumed to *dismiss* the open popup and
   you had to tap a second time to define. `tryDefine` first bails when `info.doc` is
   null (a margin/host tap), then requires the tap to land on an actual Japanese
   **glyph** per `extractTextAt`'s glyph + word-char gate (the `pointOnGlyph` hit-test
   in extract.ts:42 rejects taps in margins / inter-column gaps; §10,
   `docs/japanese.md`), returning `true` only if it started a lookup. On a real match
   the looked-up word is also **auto-highlighted yellow** (a vocab record) — see §10.
4. **Blank tap → dismiss popup.** If `tryDefine` returned `false` (blank space, a
   margin/host tap, or `tapToDefine` off) **and** a popup is open, set `dictState.open
   = false`. So a tap on empty space dismisses the popup; a tap on a word redefines it.
   (The popup's own × button and a page-turn also close it.)

There is **no pagination on tap** — turning the page is exclusively the swipe
path above — and the central area only toggles the chrome to *dismiss* it (never to
reveal it on a blank tap).

**Hiding the chrome again.** Two paths hide visible bars: (a) a tap in the reading
area (step 3 above), and (b) tapping a bar's own empty area. For (b), once the bars
are visible they cover the top/bottom toggle bands, so a band tap can't reach the
reader's gesture detector behind them. Instead the bars hide themselves: the
`<header>`/`<footer>` carry `role="presentation"` + `onclick={dismissChromeFromBar}`
(Reader.svelte), which sets `chromeVisible = false` unless the tap landed on an
actual control (`e.target.closest('button')`). So tapping a bar's empty area (title,
progress) hides the chrome too. (Bar taps are native `click`s and never reach the
foliate-view gesture detector — the bars are sibling overlays — so there's no
double-handling.)

**Standalone reading-% readout.** While the chrome is **hidden**, a small
`pointer-events:none` percentage pill (`.page-pct`, `{Math.round(fraction*100)}%`)
is shown centred at the bottom of the screen, so the reading position is always
visible without the bars; it's hidden when the chrome is up (the bottom bar carries
its own progress).

### 8a. Page-turn animation — horizontal slide (`#turn` / `#slide`)

`controller.goLeft()` / `goRight()` (reader.ts:319/323) each fire the `onTurn`
callback, then animate a **horizontal slide** (like Books on iPad) via
`#turn(dir)` (reader.ts:328) → `#slide(dir)` (reader.ts:344). Only the **trigger**
changed (a swipe, not a tap rail); the slide mechanism is unchanged. Why a custom
slide: foliate stacks 縦書き pages on the **vertical** axis (§7), so its own
`animated` turn slides up/down — which reads as wrong for a Japanese book. So we
leave foliate's `animated` attribute **off** (§6), patch its own touch turn out
(§1/§7), and drive the visual ourselves:

1. Slide the whole `<foliate-view>` out to one edge (`transform: translateX(±100%)`,
   `TURN_PHASE_MS` = 150ms). No box-shadow: a full-screen `0 0 28px` shadow used to be
   applied here as a depth cue, but on the full-viewport element it painted blurred
   dark bands on the **top and bottom** edges that swept across as the view slid —
   visibly flashing twice (once per phase), most pronounced on the light theme — so it
   was removed. The page now slides cleanly over the paper.
2. Jump to the target page while off-screen — `await view.goLeft()/goRight()`,
   instant because `animated` is off (direction-aware, correct for LTR + RTL).
3. Slide the new page in from the opposite edge back to `translateX(0)`.

The new page enters from the side the reader moved toward; the old page leaves the
opposite edge, so it reads as one continuous horizontal push. Both phases are
**`transitionend`-driven** (`#transition`, reader.ts:369, with a `TURN_PHASE_MS +
120`ms fallback if `transitionend` never fires) so timer drift can't leave a
blank-paper gap between them. The fallback `setTimeout` handle is held on the
instance (`#slideTimer`) so a `destroy()` mid-turn clears it — `#ac.abort()` removes
the `transitionend` listener but can't cancel a bare timer, which would otherwise
fire ~270ms after teardown still holding the view element. A
`#turning` flag plus a single `#pendingDir` **coalesce rapid swipes** (the latest
queued turn runs when the current finishes); `destroy()` clears `#pendingDir`.

| Constant (reader.ts) | Value | Role |
| --- | --- | --- |
| `TAP_MOVE_TOLERANCE` (:72) | 16px | max down→up travel for a gesture to still be a tap |
| `TAP_MAX_MS` (:73) | 400ms | max duration for a tap |
| `SWIPE_MIN_DISTANCE` (:75) | 45px | min horizontal travel for a drag to count as a page-turn swipe |
| `TURN_PHASE_MS` (:77) | 150ms | one phase (out / in) of the horizontal slide |

Constraints worth knowing: a literal page-**curl** isn't possible — the content is a
sandboxed, closed-shadow-DOM iframe that can't be rasterised — and only one page is
rendered at a time, so the vacated strip shows the **paper background** during the
slide (the intended look). `goTo()` (TOC / annotation nav) is **not** animated; only
`goLeft`/`goRight` slide.

> **Verified in desktop Chrome only** (iPad-landscape emulation). The swipe model
> (the 45px / horizontal-dominant threshold and "page follows the finger") and the
> horizontal slide are **not yet confirmed on real iOS** — open questions are swipe
> velocity/feel under a real finger and `caretRangeFromPoint` in vertical-rl
> iframes. Re-test on a physical device if you touch these. (The production build
> serves under the `/epub/` base on GitHub Pages — see `docs/deployment.md`.)

### Highlight de-conflict (the 60ms defer)

A real `click` fires on the same gesture as our tap, and may hit-test a highlight
→ `show-annotation`. So `onTap` defers `handleTap` by **~60ms via `pendingTap =
setTimeout(...)` *only when `hasHighlights` is true*** (Reader.svelte:223-233). If
`onShowAnnotation` fires first it clears `pendingTap` (Reader.svelte:159-162) and
**reopens the dictionary popup** for that highlight (definition + remove toggle)
instead of defining-and-re-highlighting. With no highlights, the tap runs
immediately. `pendingTap` is also cleared in `onDestroy`.

### Overlays auto-close on a turn

Because `relocate` no longer carries a `reason` (§3), overlay-close on a page turn
is driven from the **gesture** side: `goLeft`/`goRight` fire `onTurn`, and
`Reader.svelte`'s `onTurn` (Reader.svelte:103-106) sets `userInteracted = true` and
calls `closeOverlays()` (closes `dictState` and `sel`) — a turn
invalidates any popup/toolbar anchored to the page being left. TOC/annotation
navigation and a scrubber **seek** (§12) set `userInteracted` the same way.

---

## 9. Selection

`#attachTaps` also installs a **250ms-debounced** `selectionchange` listener on
the content doc (reader.ts:534-562; registered with the same `#ac` signal as the
tap listeners). The debounce timer is held **per document** in `#selTimers`
(a `Map<Document, number>`), not in one shared field, so a landscape **2-up spread
that has two sections loaded** (two content docs, each with its own listener) can't
have one doc's `selectionchange` clear and reschedule the other doc's pending
callback. `destroy()` clears every timer in the map. When the debounce fires and
there is a non-empty Range:

```ts
const range = sel.getRangeAt(0)
const r  = range.getBoundingClientRect()
const fr = frame?.getBoundingClientRect()   // iframe → top-window offset
onSelection({ doc, range, text: sel.toString(),
  rect: { left: fr.left + r.left, top: fr.top + r.top, width: r.width, height: r.height } })
```

Otherwise it calls `onSelectionCleared()`. The top-window `rect` is what
positions the `SelectionToolbar` (which places itself via
`placeAnchored(centerX, rect.top, rect.top+rect.height, …)` — §12). In
`Reader.svelte`, `onSelection` opens the toolbar with two actions:

- **Highlight** (`createHighlight()`): `cfiForSelection` → persist an
  `Annotation` via `saveAnnotation` → `controller.addHighlight(cfi)` →
  `clearSelection()`. Always yellow — there is no colour choice.
- **Copy** (`copySelection`): `navigator.clipboard.writeText(sel.text)`.

A user page turn closes the selection toolbar along with the other overlays via
`closeOverlays()`, driven by `onTurn` (not a relocation reason — §8, §12).

(The paginator independently watches `selectionchange` to auto-turn pages while
dragging a selection past the page edge — paginator.js:586-616 — but that is its
own concern and doesn't interfere with ours.)

---

## 10. Highlights & CFI

Highlights are a **single colour** (yellow, `HIGHLIGHT_HEX` in `types.ts`). The set
`#highlights: Set<cfi>` (reader.ts) is the **source of truth** for which ranges are
drawn; there is no per-highlight colour. Persistence is separate — the `annotations`
store (`docs/storage-pwa-ios.md`, `docs/japanese.md`) holds the durable records (a
highlight `Annotation` has **no `color` field**); `#highlights` is the in-memory
render state.

**Two ways a highlight is created:**

1. **Tap-to-define (primary).** Tapping a Japanese word looks it up *and* highlights
   the matched word — a lightweight vocab record of what you've looked up. The flow
   (Reader.svelte): `extractTextAt` now returns a **`positions` map** (text index →
   `{node, offset}`), and `lookupAt` returns **`matchStart`** alongside `matchLength`.
   On a real result, `rangeForSpan(doc, positions, matchStart, matchStart+matchLength)`
   (extract.ts) rebuilds a `Range` for exactly the matched word (it can straddle text
   nodes — a kanji compound with ruby splits its base text — which is why an index→node
   map, not a string offset, is the bridge), `cfiForSelection` → CFI, then
   `saveAnnotation` + `controller.addHighlight(cfi)`. The dictionary popup carries a
   **footer toggle** (`Remove highlight` / `Highlight`) that removes/re-adds it without
   closing the card. Auto-highlighting happens only on a real match — not on a
   no-match, a download prompt, or a tap already on an existing highlight.
2. **Drag-select (§9).** A selection → the `SelectionToolbar`'s **Highlight** action
   (yellow) / **Copy**.

Draw/paint flow:

1. `addHighlight(cfi)` / `setHighlights(cfis)` records the CFI, then asks the view to
   annotate. `setHighlights` (called on book open with the loaded highlight
   `Annotation`s' CFIs) clears + reseeds the whole set.
2. `view.addAnnotation({value:cfi})` resolves the CFI to a section + range.
   - If that section is **loaded**, view emits `draw-annotation`; our handler calls
     `draw(Overlayer.highlight, { color: HIGHLIGHT_HEX })`. `Overlayer.highlight`
     (overlayer.js:126) draws filled `<rect>`s at the range's client rects, at
     `opacity: var(--overlayer-highlight-opacity, .3)`.
   - If **not loaded**, it's a no-op. Later, when that section paints, view emits
     `create-overlay` with its `{ index }` → we call `reapplyHighlights(index)` →
     `addAnnotation` for **only this section's** known CFIs (matched against the
     cached `cfi→index` map) → the now-loaded ones draw. This is why highlights
     survive page turns and section loads, while staying cheap as the highlight set
     grows.
3. `removeHighlight(cfi)` drops the CFI from the set and `deleteAnnotation`s.

CFI creation: `cfiForSelection(doc, range)` looks up the doc's spine index in the
`#docIndex` `WeakMap` (populated on every `load`), then `view.getCFI(index, range)`.
Returns `null` if the doc is unknown or CFI throwing. CFIs are stable across
reflow/font changes, which is exactly why annotations and reading progress are
anchored by CFI rather than offsets (see `epubcfi.js`: `fromRange`, `toRange`,
`compare`, `parse`).

Tapping an existing highlight → `show-annotation` → `onShowAnnotation(value, range)`
**reopens the dictionary popup** for that word: it looks up `range.toString()` and
shows the definition with the `Remove highlight` footer toggle. There is no separate
recolor/delete toolbar.

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
`max-block-size = vw − 2·margin` (the across-page **width**, so the band fills the
available width). Because the landscape vertical spread is 1, deriving
`max-inline-size` from `vh` makes `--_max-height` clamp deterministically to the
available height, so the box fits the screen instead of guessing.

**Remaining hedges** (best-effort, idempotent):

- `#nudgeLayout()` (reader.ts:216-224) schedules **a single** `renderer.render()`
  at **250ms** after `init`, as a lightweight hedge in case a real device still
  under-measures after fonts/layout settle. (Earlier iterations leaned on a heavier
  multi-stage re-render; the viewport-derived layout above made that unnecessary in Chrome.)
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

**Mount** (`onMount`, Reader.svelte:302): `Promise.all([getBookMeta, getBookFile,
getProgress])` → throw if no file → **seed displayed progress from the saved
`progress`** (`fraction`/`currentCFI`/`sectionLabel`) so the bar is correct before
the first relocate → `new ReaderController(host, settings, callbacks)` →
`controller.open(file, progress?.cfi)` → read `controller.view.book?.toc` for the
TOC sheet → `loadAnnotations(bookId)` → `controller.setHighlights(highlight CFIs)`
→ `status='ready'`. Errors set `status='error'` and show a back-to-library CTA.

**Reactive UI state** (`$state`/`$derived`): `chromeVisible`, `fraction`,
`sectionLabel`, `currentCFI`, `isBookmarked` (derived: a bookmark annotation at
`currentCFI`), `hasHighlights` (derived; gates the 60ms tap-defer in §8). A
plain (non-reactive) module-scope `userInteracted` flag (Reader.svelte:79) gates
progress persistence — see below.

**Callbacks → UI:**

- `onRelocate` (Reader.svelte:91-99) → updates `fraction`/`currentCFI`/
  `sectionLabel`, then runs the **600ms-debounced `putProgress`** *only when*
  `userInteracted` is already true — so the noisy startup relocations (which can
  report a bogus fraction, the cause of "a fresh book reopens mid-way") don't
  persist a misleading position. Because the `relocate` event carries **no
  `reason`** (§3), it cannot itself tell a user turn from a startup jump;
  `userInteracted` is set entirely from the **gesture/navigation** side —
  `onTurn` (a swipe), `navigate` (TOC), and `navAnnotation`.
  > **Honest caveat on the fraction.** foliate's `relocate.fraction` is an
  > *overall-book* fraction (view.js's `SectionProgress.getProgress`, progress.js)
  > that includes the page's trailing-edge term. On the tiny 2-page test EPUB,
  > page 1 reports ~39%; on a real multi-hundred-page book page 1 ≈ 0–1%. That is
  > foliate's progress model, not a bug — the persistence gating is what prevents a
  > bogus *restore*.
- `onTurn` (Reader.svelte:103-106) → sets `userInteracted = true` and
  `closeOverlays()`. This is the page-turn signal that `relocate` can't give us:
  a swipe (or any `goLeft`/`goRight`) fires it.
- `onTap` → §8 routing (top/bottom band toggles chrome → chrome-visible dismiss →
  else define the tapped glyph, **even over an open popup**, so each word is one tap;
  a central blank tap dismisses an open popup, else does **nothing**), with the 60ms
  defer when `hasHighlights`. (No pagination on tap; the central area never toggles
  chrome — the bars hide via their own `dismissChromeFromBar` click.)
- `onSelection`/`onSelectionCleared` → drive the `SelectionToolbar`.
- `onShowAnnotation` → clears `pendingTap`, then **reopens the `DictionaryPopup`**
  for the tapped highlight (definition + remove toggle) via `openDefine(existingCfi)`.

**Sheets & popups** (all `<Sheet>` overlays): `TocSheet` (`onnavigate` →
`controller.goTo(href)`), `ReaderSettings` (its `onchange(kind)` →
`controller.applyAppearance` / `applyLayout` / `reopenForWritingMode` per
`'appearance'|'layout'|'writingmode'`), `AnnotationsPanel` (`onnavigate` →
`goTo(cfi)`), `DictionaryPopup`.

**One `SelectionToolbar` instance** — fresh selections only (Highlight yellow /
Copy). Props (SelectionToolbar.svelte): `open, rect, onHighlight, onCopy`. It
positions itself through the shared `placeAnchored(...)` helper
(`src/lib/util/anchoredPosition.ts`, §12-anchoring). (Editing an existing highlight
no longer uses a toolbar — it routes through the dictionary popup, §10.)

**Define + highlight in one popup.** `tryDefine` → `openDefine({text, tapOffset,
px, py, doc, positions})`; `runLookup` resolves and, on a real match, calls
`autoHighlight` (build the word `Range` from `positions` + `matchStart/matchLength`,
CFI it, save + `addHighlight`). `dictState` carries `cfi`/`highlighted`/`word` so the
popup's footer toggle (`ontogglehighlight` → `toggleWordHighlight`) can remove/re-add
without closing the card; `DictionaryPopup` shows the toggle only when a real result
is present.

**Progress scrubber.** The bottom bar's progress is a `ProgressScrubber` component
(`src/lib/reader/ProgressScrubber.svelte`) — `{fraction, sectionLabel, onseek}`. It's
a hairline track + section-label/% readout at rest; **press-and-drag** turns it into
a fast-scroll scrubber. Tuning (to avoid accidental skips without being stiff): the
press must cross an **8px (touch) / 4px (mouse) dead-zone** before it *arms*, then
maps pointer-x positionally across the track to a preview fraction shown in a floating
**bubble**; the seek (`onseek` → `seek` → `controller.goToFraction`) commits only on
**release** (so foliate re-paginates once, not per move). A clean **tap is a no-op**
(it only flashes the thumb) — tapping a hairline must never jump your place. The
thumb is hidden at rest, 12px while dragging (9px on hover for mouse). The component
`stopPropagation`s its own click so it doesn't trip the bar's `dismissChromeFromBar`,
and exposes `role="slider"` + arrow/Home/End keys for a11y. `seek` also sets
`userInteracted` and `closeOverlays()`.

The `DictionaryPopup` positions via `placeAnchored` from its tap anchor (`x/y`); its
effect re-runs on `x`/`y` *or content* change so a re-tap on another word — or a
result loading in — re-places the card rather than leaving it at the first spot, and
it carries a focusable close (×) button. It's a flex column: a scrolling `.body` and
a non-scrolling sticky `.actions` footer (the highlight toggle).

**Chrome**: top bar (library / notes / display) + bottom bar (TOC / progress /
bookmark toggle). `toggleBookmark` adds/removes a `bookmark` annotation at
`currentCFI || controller.lastCFI`.

**Destroy** (`onDestroy`, Reader.svelte:345-349): clears `pendingTap`, then
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
stylesheet, extend `appearanceCSS` (reader.ts:83) and route via `'appearance'`.
If it changes geometry, extend `applyLayout` and route via `'layout'`. Anything
that depends on re-detecting writing-mode must route via `'writingmode'` →
`reopenForWritingMode`.

**Add a new gesture.** Extend the shared `#trackGestures` state machine
(reader.ts) — it backs both `#attachTaps` (content doc) and `#attachHostGestures`
(host/margins). Reuse the existing pointer bookkeeping (`active`/`moved`/`downT`,
the `e.isPrimary` guard, the `pointercancel` abort, and the swipe-vs-tap split in
`pointerup`). **Register the listener with the shared `{ signal }` from `#ac`** so `destroy()`'s single
abort cleans it up — don't add a bespoke `removeEventListener`. Note that the
horizontal swipe is **ours** now (foliate's own touch turn is patched out, §1/§7);
keep any new gesture from colliding with the `SWIPE_MIN_DISTANCE`/horizontal-
dominant swipe rule. For e.g. long-press, gate on `e.timeStamp - downT >
TAP_MAX_MS` plus the no-movement check, add a callback to `ReaderCallbacks`, emit
it, and handle it in `Reader.svelte`. Remember to translate coords to top-window
space via `frameElement.getBoundingClientRect()` if you need to position UI (or
reuse `placeAnchored`).

**Change the reading measure.** Tune `applyLayout` (reader.ts:247) — note it
**branches on `#vertical`**. Common knobs: the margin clamp
`max(28, min(80, minDim*0.075))`, `gap` `'6%'`, the `cols` breakpoint
(`vw > vh && vw >= 820`), and the per-mode caps — **horizontal** `max-inline-size`
`640` / `max-block-size` `880`; **vertical** `max-inline-size` = column height
`max(320, vh − 2·margin)` / `max-block-size` = band width `vw − 2·margin` (fills the
width). Keep `margin` in `px` and `gap` in `%`, and keep `max-inline-size` set
**last** (its setter forces a foliate `render()`). Remember the inline/block axes
swap for vertical (§6/§7) and the orientation container-query gates the 2-up
spread to landscape.

**Add a new annotation type.** Today only `Overlayer.highlight` is used. To add
e.g. underline: in the `draw-annotation` handler (reader.ts:196) branch on the
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

- **Swipe AND the page-turn animation are both ours.** Foliate's own touch
  page-turn is **patched out** (the `TSUZURI PATCH` in `#onTouchMove`/`#onTouchEnd`,
  §1/§7): `#onTouchMove` keeps `e.preventDefault()` but drops the finger-follow
  `scrollBy`, and `#onTouchEnd` drops the velocity `snap`. Our `pointerup` swipe
  detector (§8) is the **only** thing that turns pages, and we **leave foliate's
  `animated` attribute off** (§6) and animate `goLeft`/`goRight` ourselves as a
  horizontal slide (§8a) — foliate's own turn animation slides on the *vertical*
  axis for 縦書き. Don't re-add `animated` (you'd get a vertical slide fighting the
  horizontal one), and don't un-patch foliate's touch turn (you'd double-handle the
  swipe). **This is the reverse of the old "don't add page-swipe handling" advice**
  — we now own swipe, tap, selection, and the turn animation; foliate is left to
  jump instantly.
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
- **Define and page-turn don't collide.** Pagination is by **swipe** and define
  is by **tap**, so they're already distinct gestures (a swipe `return`s before the
  tap branch — §8). On top of that, define fires *only when the tap lands on an
  actual glyph* — `extractTextAt` returns `null` in margins / inter-column gaps
  because `pointOnGlyph` (extract.ts:42) bounds `caretRangeFromPoint`'s snapping
  (§10, `docs/japanese.md`), so a tap on blank space does nothing (or dismisses an
  open popup). A tap on a glyph defines it **even while a popup is already open** (the
  popup re-anchors — one tap per word). If you change `SWIPE_MIN_DISTANCE` /
  `GLYPH_HIT_SLACK`, preserve that separation.

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
- `docs/deployment.md` — GitHub Pages deploy, the `/epub/` production base path
  (which the reader's assets and the PWA scope derive from), and CI.
