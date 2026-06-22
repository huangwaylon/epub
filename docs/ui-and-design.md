# UI & Design System — Tsuzuri

Tsuzuri is a Japanese EPUB reader PWA built with **Svelte 5 (runes), TypeScript, Vite**. It is
primarily used on **iPad in landscape**, installed to the Home Screen as a standalone app. This
document covers the Svelte 5 conventions, the design-token system, the component library, and the
responsive strategy. For the rendering engine, storage, and build tooling see the
[cross-references](#11-cross-references).

---

## 1. Svelte 5 runes & the store pattern

State lives in **`*.svelte.ts` modules** (the `.svelte.ts` extension is required so the compiler
processes runes outside a component). Each module exports a single module-level `$state(...)`
object — which is **deep-reactive** — and a set of plain functions that mutate it. Components
`import { store }` and read `store.x` directly; the read is tracked, so the component re-renders
when any reachable property changes. There is no separate `get`/`subscribe` API.

### Canonical example — the settings store

`src/stores/settings.svelte.ts`:

```ts
export const settings = $state<ReaderSettings>({ ...DEFAULT_SETTINGS })

export async function initSettings(): Promise<void> {
  const saved = await loadSettings()                 // IndexedDB
  if (saved) Object.assign(settings, { ...DEFAULT_SETTINGS, ...saved })
  hydrated = true
  applyTheme()
}

export function updateSettings(patch: Partial<ReaderSettings>): void {
  Object.assign(settings, patch)                     // mutate in place — reactive
  if (patch.theme) applyTheme()
  if (hydrated) void saveSettings({ ...settings })   // persist
}
```

Key rules this repo follows:

- **Never reassign the exported binding** (`settings = ...`); always mutate via `Object.assign` /
  property set / array methods so the proxy stays the same object. Re-assigning would break every
  importing component's reactivity.
- **Mutate only through exported functions** so persistence (`saveSettings`) and side effects
  (`applyTheme`) run consistently. A `hydrated` flag suppresses the persist write until the initial
  load completes (avoids overwriting saved settings with defaults on first run).
- `DEFAULT_SETTINGS` (in `src/services/types.ts`) is the single source of truth for shape + defaults.

The other stores follow the identical pattern (all in `src/stores/`):

| Store | Shape (abridged) | Mutators |
| --- | --- | --- |
| `settings.svelte.ts` | `ReaderSettings` (theme, fontScale, lineHeight, marginScale, fontFamily, writingMode, tapToDefine) | `initSettings`, `updateSettings`, `applyTheme` |
| `library.svelte.ts` | `{ books, progress, loading, importing, importError }` | `refreshLibrary`, `importFiles`, `deleteBook`, `markOpened` |
| `annotations.svelte.ts` | `{ items: Annotation[] }` | `loadAnnotations`, `clearAnnotations`, `saveAnnotation`, `removeAnnotation`, `newId` |
| `dict.svelte.ts` | `{ state, updating, progress, error? }` (offline JMdict download status) | mutated directly by `services/jp/dictdb.ts` |
| `pwa.svelte.ts` | `{ needRefresh, offlineReady, update() }` | written by the SW registration in `main.ts` |
| `nav.svelte.ts` | `{ route: Route }` | `openReader`, `openShelf` (see §7) |

> Note: `pwa.needRefresh` and `dict.*` are mutated directly from components/services (e.g.
> `UpdateToast.svelte` sets `pwa.needRefresh = false`). That is allowed because these are simple flag
> objects, not persisted state; settings/library/annotations always go through their mutators.

### Runes used in this codebase

| Rune | Where | Purpose |
| --- | --- | --- |
| `$state(...)` | every store; component locals (e.g. `menuFor`, `settingsOpen` in `Shelf.svelte`) | reactive, deep-proxied state |
| `$derived(...)` | `BookCover` (`hue`), `TocSheet` (`items`), `AnnotationsPanel` (`highlights`/`bookmarks`/`list`) | computed values |
| `$props()` | every component | destructure incoming props (replaces `export let`) |
| `$bindable(default)` | `Sheet.open`, `Segmented.value`, `DictionaryPopup.open` | two-way-bindable props |
| `$effect(...)` | `BookCover` (objectURL lifecycle), `Sheet` (move/restore focus on open/close — capture is **edge-gated** on a real closed→open transition so the `bind:this` re-run can't re-capture the sheet itself as the restore target), `DictionaryPopup`/`SelectionToolbar` (re-position via `placeAnchored` on open + anchor/content change, **cancelling the queued rAF** on cleanup so rapid re-taps don't pile up layout reads) | side effects with optional cleanup return |

**Generics on components:** `Segmented.svelte` declares
`<script lang="ts" generics="T extends string | number">`, so `value`/`options`/`onchange` are
typed against the caller's literal-union `T` (e.g. `ThemeName`, `WritingModePref`, or `'serif' | 'sans'`).

**Snippets & events:** `Sheet` takes a `children: Snippet` and renders it with `{@render children()}`.
Event handlers are passed as plain function props (`onclose`, `onchange`, `onnavigate`, …) — there
are no `createEventDispatcher` calls in this codebase.

---

## 2. Design system — `src/app.css`

`app.css` is the single global stylesheet (imported once in `main.ts`). It defines token layers on
`:root`, then three theme blocks, then base/reset rules. Component styles are otherwise scoped.

### Token layers (on `:root`)

| Group | Tokens | Notes |
| --- | --- | --- |
| **Type** | `--font-ui`, `--font-serif`, `--font-jp-sans` | UI = SF/system sans. Serif = Hiragino Mincho ProN → Noto Serif JP → Yu Mincho → Georgia (long-form reading). JP-sans = Hiragino Sans → Noto Sans JP (ゴシック). |
| **Radii** | `--r-sm: 8px`, `--r-md: 12px`, `--r-lg: 18px`, `--r-xl: 26px` | `--r-xl` is the sheet corner. |
| **Touch** | `--tap: 44px` | minimum comfortable touch target (iOS HIG). |
| **Shadow** | `--shadow-1` (subtle, raised surfaces), `--shadow-2` (sheets/toasts/popups) | |
| **Motion** | `--ease: cubic-bezier(0.22,0.61,0.36,1)`, `--dur: 0.22s` | shared easing/duration for all transitions. |
| **Safe area** | `--safe-top/bottom/left/right: env(safe-area-inset-*, 0px)` | surfaced as vars so layouts can do math (e.g. `calc(var(--safe-bottom) + 8px)`). Requires `viewport-fit=cover` (set in `index.html`). |

### Themes — `:root[data-theme=light|sepia|dark]`

The active theme is selected by a `data-theme` attribute on `<html>` (set by `applyTheme()`).
`light` is also applied to bare `:root` as the default. Each block sets `color-scheme` plus the
semantic color tokens below. The brand identity is a **vermilion `--accent`** ("like a hanko seal").

| Token | Role | light | sepia | dark |
| --- | --- | --- | --- | --- |
| `--paper` | app background | `#f6f3ec` | `#f4ecd8` | `#16140f` |
| `--paper-raised` | cards, sheets, bars | `#fffdf8` | `#fbf5e6` | `#211e18` |
| `--ink` | primary text | `#211d17` | `#4a3a29` | `#e7e1d3` |
| `--ink-soft` | secondary text / icons | `#5d564a` | `#6f5c46` | `#aaa394` |
| `--ink-faint` | tertiary / hints | `#938b7b` | `#9c876c` | `#756f62` |
| `--line` | hairline dividers | `rgba(ink,0.10)` | `rgba(ink,0.12)` | `rgba(ink,0.10)` |
| `--line-strong` | stronger borders, grip, tracks | `rgba(ink,0.16)` | `rgba(ink,0.20)` | `rgba(ink,0.18)` |
| `--accent` | **vermilion** brand color | `#b5552e` | `#a8521f` | `#e0855c` |
| `--accent-soft` | tinted fills (segmented bg, chips, active states) | `rgba(accent,0.12)` | `0.14` | `0.16` |
| `--hl-yellow/green/blue/pink` | UI-side highlight previews | warm | warmer | muted dark |
| `--scrim` | modal backdrop | `rgba(ink,0.32)` | `rgba(.,0.34)` | `rgba(0,0,0,0.5)` |

> Distinguish two highlight palettes: the CSS `--hl-*` tokens (used for theme-aware UI accents) vs.
> `HIGHLIGHT_HEX` in `services/types.ts` (`yellow #ffd54a`, `green #7ed47e`, `blue #6fb4f5`,
> `pink #f48fb1`) — the saturated swatches the **reader overlay and selection toolbar** use, chosen
> to read well behind text at ~0.3 opacity. `SelectionToolbar` and `AnnotationsPanel` use
> `HIGHLIGHT_HEX`.

### `applyTheme()` — and why the reader mirrors these vars

`applyTheme()` (settings store) does two things:

1. Sets `document.documentElement.dataset.theme = settings.theme` (drives the `[data-theme]`
   selectors above), and
2. Reads back the resolved `--paper` via `getComputedStyle(...).getPropertyValue('--paper')` and
   writes it into a dynamic `<meta name="theme-color">` (the non-`media` one, created if absent), so
   the iOS status bar / address bar matches the page.

**Crucially**, the reader engine reads these *same* CSS vars to style content *inside* the EPUB
iframe. `appearanceCSS()` in `src/services/reader.ts` does a single
`getComputedStyle(document.documentElement)` read and pulls `--ink`, `--accent`, `--accent-soft`,
and `--font-serif`/`--font-jp-sans` off it (via a local `tok(name)` closure), building a stylesheet
that foliate-js injects into each content document. This is why the rendered book always matches the
app chrome exactly. See **docs/reader-engine.md** for that injection pipeline — do not duplicate it
here.

---

## 3. Base & reset styles (`app.css`)

- `* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }` — no blue tap flash.
- `html, body`: `margin:0`, `height:100%` then `height:100dvh` (dynamic viewport, ignores iOS URL
  bar), `overflow:hidden` + **`overscroll-behavior:none`** (kills rubber-band / pull-to-refresh —
  essential for a paginated reader). `#app` also `height:100dvh`.
- Default fonts: `font-family: var(--font-ui)`, `-webkit-font-smoothing: antialiased`,
  `text-rendering: optimizeLegibility`.
- **Button reset:** `font/color: inherit`, no border/background, `cursor:pointer`,
  `touch-action: manipulation` (removes the 300ms tap delay / double-tap zoom).
- **Chrome non-selectable:** `button, .no-select { user-select:none; -webkit-touch-callout:none; }` —
  prevents the iOS long-press callout from competing with tap-to-define and page turns. (The book
  body itself *is* selectable; the reader disables only the native callout via injected CSS.)
- `input, textarea { font/color: inherit; }`
- `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }` — keyboard focus only.
- `@media (prefers-reduced-motion: reduce)` forces all animation/transition durations to `0.001ms`.

---

## 4. Component inventory

Reusable primitives live in `src/lib/components/`; feature components in `src/lib/library/` and
`src/lib/reader/`. `$bindable` props are flagged.

| Component | Key props (★ = `$bindable`) | Purpose |
| --- | --- | --- |
| `lib/components/Sheet.svelte` | `open?` ★, `title?`, `onclose?`, `children: Snippet`, `maxHeight='85dvh'` | Modal container. **Bottom sheet on phones; centered modal card ≥768px** (see §6). Scrim + drag-grip + optional header with a 44px close button. Closes on scrim/grip tap, close button, or **Escape**. `role="dialog" aria-modal`; on open it moves focus into the sheet (which carries `tabindex="-1"`) and restores focus to the trigger on close. |
| `lib/components/Segmented.svelte` | `value` ★, `options: {value,label?,icon?}[]`, `onchange?` | Generic segmented control (`generics="T extends string\|number"`). Pill track in `--accent-soft`; active segment raised on `--paper-raised`. `aria-pressed` per option. Used for theme/font/writing-mode pickers. |
| `lib/components/Icon.svelte` | `name`, `size=24`, `stroke=2`, `fill=false` | Inline 24×24 stroke icons from a module-level `PATHS: Record<string,string>` map (only the icons actually used: `plus`, `gear`, `bookmark`, `list`, `arrow-left`, `x`, `trash`, `search`, `book`, `note`, `copy`, `aa`). Renders one `<path>` with `currentColor`; `fill` toggles solid vs. outline on the **same** path (e.g. the active bookmark passes `fill` to the single `bookmark` path — there is no `-fill` entry). `aria-hidden`. |
| `lib/components/UpdateToast.svelte` | (none — reads `pwa` store) | Floating pill toast when `pwa.needRefresh`. "Refresh" → `pwa.update()`; dismiss sets `needRefresh=false`. `z-index:60`, above sheets. |
| `lib/library/BookCover.svelte` | `book: BookMeta` | Renders the cover `Blob` via an `objectURL` (created/revoked in a `$effect`). If no cover, draws a **generated placeholder** whose gradient + spine hue derives from the book id (`$derived hue = Σ charCodes(id[0..5]) % 360`). 2:3 aspect. |
| `lib/library/Shelf.svelte` | (none — top-level shelf screen) | Library grid: header (`蔵書 / Library`), import (`<input type=file>`), settings gear, progress ring per book. Long-press / right-click opens a per-book action `Sheet` (Read / Remove). Empty + loading states. |
| `lib/library/ShelfSettings.svelte` | (none — rendered inside the settings `Sheet`) | App-wide settings: theme `Segmented`, JMdict download + progress, storage quota bar, About. |
| `lib/reader/ReaderSettings.svelte` | `onchange: (kind:'appearance'\|'layout'\|'writingmode')=>void` | Display sheet body: theme, font family (明朝/ゴシック), text-size/line-spacing/margin steppers, writing-direction `Segmented` (Auto/横書き/縦書き), and a custom switch toggle for tap-to-define. Reports which aspect changed so the reader re-applies efficiently. |
| `lib/reader/TocSheet.svelte` | `toc: TocItem[]`, `currentLabel?`, `onnavigate: (href)=>void` | Flattens nested TOC (`$derived`), indents by depth, marks `currentLabel`, disables items with no `href`. |
| `lib/reader/AnnotationsPanel.svelte` | `onnavigate: (cfi)=>void` | Tabbed Highlights / Bookmarks list from the `annotations` store (`$derived` filtered + sorted). Yellow bar (`HIGHLIGHT_HEX`) or bookmark icon; row → navigate; trash → `removeAnnotation`. |
| `lib/reader/DictionaryPopup.svelte` | `open?` ★, `x`, `y`, `loading?`, `needsDownload?`, `result?: LookupResult\|null`, `highlighted?`, `ondownload?`, `ontogglehighlight?` | **Floating** (`position:fixed`) word-lookup card near the tap, positioned via the shared `placeAnchored` util (prefers above, flips below, clamped to viewport + safe area). Re-runs positioning on `x`/`y` **and content** changes, so a re-tap or a loaded result repositions. Flex column: scrolling `.body` + sticky `.actions` footer. States: spinner / download-prompt / entries / no-match. The footer shows a single **highlight toggle** (`Remove highlight` / `Highlight`, yellow swatch) only when a real result is present. Has a focusable close (×) button. Not a sheet. |
| `lib/reader/SelectionToolbar.svelte` | `open?`, `rect`, `onHighlight?`, `onCopy?` | **Floating** pill toolbar above a text selection (positioned via the same `placeAnchored` util). One yellow **Highlight** action (18px swatch) + **Copy** (44px hit areas). No colour picker — highlights are always yellow. Replaces the native iOS callout. |
| `lib/reader/ProgressScrubber.svelte` | `fraction?`, `sectionLabel?`, `onseek?: (frac)=>void` | The bottom-bar reading-progress control: a hairline track + section-label/% readout that becomes a **drag-to-fast-scroll scrubber**. 8px (touch)/4px (mouse) dead-zone before arming, a live preview bubble, commit-on-release (`onseek`→`goToFraction`), clean tap = no-op. `role="slider"` + arrow/Home/End keys. |

---

## 5. Actions & utilities

### `use:longpress` — `src/lib/actions/longpress.ts`

Svelte action for iOS-style context menus (the shelf book menu).

```svelte
<button use:longpress={{ onlongpress: () => (menuFor = book), duration: 450 }}>
```

Starts a `setTimeout` (default **450ms**) on `pointerdown`; **cancels on movement >10px** (`Math.hypot`),
on `pointerup`/`pointercancel`/`pointerleave`. So it never fires on a tap or a scroll drag. Returns
`update`/`destroy` per the action contract. `Shelf.svelte` pairs it with `oncontextmenu` (preventDefault)
so right-click / trackpad also works.

### `debounce` — `src/lib/util/debounce.ts`

Trailing-edge debounce: `debounce(fn, ms)` returns a wrapper that clears and resets a timer each
call, firing `fn` only after `ms` of quiet. Generic over the arg tuple `A`. Used to coalesce
high-frequency events (e.g. progress saves) — see usage in `services/reader.ts` /
**docs/reader-engine.md**.

### `placeAnchored` — `src/lib/util/anchoredPosition.ts`

Shared positioning for the floating reader overlays.
`placeAnchored(centerX, anchorTop, anchorBottom, w, h, opts?)` returns `{ left, top }` for a layer
of size `w`×`h`: it horizontally centres on `centerX`, **prefers placing above** the anchor and
**flips below** when there isn't room, and clamps the result inside the viewport while honouring the
**safe-area insets** (it reads `--safe-top/bottom/left/right` off `:root`). `opts.gap` (default 12)
is the anchor offset, `opts.margin` (default 10) the base edge inset. `DictionaryPopup` (with
`gap: 16`) and `SelectionToolbar` both call it from their `requestAnimationFrame` positioning
effect, so the two stay in sync and both respect the iPad's rounded corners / home indicator.

---

## 6. Responsive / iPad-landscape strategy

The app targets **iPad in landscape** first. The convention is a single breakpoint at
**`@media (min-width: 768px)`** that switches phone-oriented layouts to a roomier centered desktop/
tablet form. There is no JS device detection — it is pure CSS.

| Surface | < 768px (phone) | ≥ 768px (iPad/wide) |
| --- | --- | --- |
| **Sheets** (`Sheet.svelte`) | Full-width bottom sheet, rises from bottom, drag-grip, `border-radius` top only | **Centered modal card**: `top/left:50%`, `translate(-50%,-50%)`, `width: min(480px, 100vw-96px)`, `max-height: min(82dvh,760px)`, all-corner radius, grip hidden, `pop-center` animation. This is the key iPad pattern and applies to **every** sheet — Display/TOC/Notes/Settings — because they all wrap `Sheet`. |
| **Shelf** (`Shelf.svelte`) | Grid `minmax(118px,1fr)`, gap `22px 16px`, `h1` 30px, edge padding 18px | Content centered at **`max-width: 1120px`** (`.bar/.grid/.importing/.state`), larger covers `minmax(168px,1fr)` gap `38px 28px`, `h1` 36px, edge padding 40px, taller header |
| **Reader chrome** (`Reader.svelte`) | Top/bottom bars span full width; progress bar `flex:1` | Bars padded `max(--safe-*, 26px)`; **progress block capped & centered: `flex: 0 1 580px; margin-inline:auto`**; title 16px |

The actual **reading-area margins / measure** (column width, gutter, page padding) are tuned inside
`services/reader.ts` (`marginScale`, writing-mode), not in component CSS — see
**docs/reader-engine.md**.

**Safe areas:** every full-bleed surface pads with `env(safe-area-inset-*)` (via the `--safe-*`
vars), enabled by `viewport-fit=cover` in `index.html`. iOS standalone meta tags
(`apple-mobile-web-app-capable`, `status-bar-style: black-translucent`, apple-touch-icon) make it
behave like a native app from the Home Screen — see **docs/storage-pwa-ios.md**.

---

## 7. Navigation / routing

`src/stores/nav.svelte.ts` is a minimal in-memory router — there is no URL routing.

```ts
export type Route = { name: 'shelf' } | { name: 'reader'; bookId: string }
export const nav = $state<{ route: Route }>({ route: { name: 'shelf' } })
export function openReader(bookId: string): void { nav.route = { name: 'reader', bookId } }
export function openShelf(): void { nav.route = { name: 'shelf' } }
```

`src/App.svelte` switches on it and remounts the reader per book via `{#key}`:

```svelte
{#if nav.route.name === 'reader'}
  {#key nav.route.bookId}
    <Reader bookId={nav.route.bookId} />
  {/key}
{:else}
  <Shelf />
{/if}
<UpdateToast />
```

The `{#key bookId}` block forces a full teardown/remount of `Reader` when switching books, so the
foliate view and all reader state reset cleanly. `UpdateToast` is always mounted (overlay).

---

## 8. UI conventions

- **Scoped styles:** each `.svelte` file owns a `<style>` block; only `app.css` is global. Theme
  overrides inside a component use `:global([data-theme='dark']) .x { … }` (e.g. `BookCover`
  placeholder, `Shelf` danger row).
- **`lang="ja"` on Japanese text:** every span/div holding book-derived Japanese
  (titles, authors, TOC labels, dictionary headwords, highlight text) carries
  `lang="ja"` so the browser picks correct fonts and line-breaking rules. Apply this to any new
  element that renders user/book Japanese content.
- **Accessibility:** icon-only buttons always have `aria-label` (e.g. "Settings", "Import book",
  "Close", "Smaller text", "Highlight yellow"). Sheets use `role="dialog" aria-modal="true"`;
  toggles use `role="switch" aria-checked`; segmented options use `aria-pressed`.
- **`tabular-nums`** (`font-variant-numeric: tabular-nums`) on changing numbers — the percent in the
  reader progress bar, stepper values, dictionary pitch — so digits don't jitter.
- **Safe-area padding** on all edge surfaces (see §6).
- **Aesthetic:** calm paper-and-vermilion. Serif for reading + book titles + dictionary headwords;
  system sans for chrome; vermilion `--accent` for the single highlight color, active states,
  primary buttons, links, focus rings.

---

## 9. How to extend

**Add a sheet/dialog:** wrap your body component in `Sheet` and let it provide the responsive
bottom-sheet ↔ centered-card behavior, scrim, and Escape handling for free.

```svelte
<Sheet bind:open={myOpen} title="My panel" onclose={() => {/* … */}}>
  <MyPanelBody />
</Sheet>
```

**Add an icon:** add a 24×24 `currentColor` path to the `PATHS` map in `Icon.svelte` (module
script), then `<Icon name="my-icon" />`. The map holds only the icons in active use — keep it that
way. For a solid variant, pass `fill` to render the **same** path filled (as the active bookmark
does); there is no separate `-fill` entry.

**Add a theme:** add a `:root[data-theme='<name>']` block in `app.css` defining **all** semantic
tokens (`--paper`, `--paper-raised`, `--ink*`, `--line*`, `--accent*`, `--hl-*`, `--scrim`, plus
`color-scheme`); add the option to the theme `Segmented` arrays in `ShelfSettings.svelte` /
`ReaderSettings.svelte` (and widen `ThemeName` in `services/types.ts`). Because `reader.ts` reads
the live CSS vars, the in-book rendering picks it up automatically — no reader change needed.

**Add a setting control:** extend `ReaderSettings` + `DEFAULT_SETTINGS` (`services/types.ts`), add a
control in `ReaderSettings.svelte` or `ShelfSettings.svelte` that calls `updateSettings({ … })`
(which persists + applies). If it affects in-book rendering, wire the `onchange(kind)` callback so
the reader re-applies the right aspect — see **docs/development.md** and **docs/reader-engine.md**.

---

## 10. Gotchas

- **Sheets are modal:** `Sheet` renders a `--scrim` backdrop (`z-index:40`) and closes on
  scrim/grip tap, the 44px close button, or **Escape** (`<svelte:window onkeydown>`). It doesn't
  *trap* focus, but to honour `aria-modal` it moves focus into the sheet on open (the sheet has
  `tabindex="-1"`) and restores focus to the trigger on close.
- **Popup vs. toolbar are NOT sheets:** `DictionaryPopup` and `SelectionToolbar` are **floating**
  (`position:fixed`), positioned in a `$effect` via `requestAnimationFrame` using the shared
  `placeAnchored` util (prefer above the target, flip below if cramped, clamp to viewport + safe
  area). They have no scrim and don't close on Escape; the **reader** owns their `open` state. While
  the dictionary popup is open it is the highest-priority tap target: the **next tap anywhere on
  screen dismisses it** (the reader consumes that tap rather than re-defining or toggling the chrome)
  — including a tap on the top/bottom nav-bar edge band, which then only clears the popup and does
  **not** toggle the chrome. It is also dismissed by a page turn (the reader's `onTurn` closes the
  overlays) and by its own × button.
- **Theme before first paint:** `main.ts` `await`s `initSettings()` (top-level await) before
  `mount(App, …)`, so `applyTheme()` has set `<html data-theme>` before the first frame — avoids a
  light→dark flash. `index.html` also ships static `theme-color` media metas as a pre-hydration
  fallback; `applyTheme()` then writes the dynamic non-media `theme-color`.
- **z-index ladder:** scrim 40 / sheet 41 / dictionary popup 50 / selection toolbar 52 / update
  toast 60. Floating reader UI sits above sheets intentionally.
- **objectURL leaks:** `BookCover` revokes its cover `objectURL` in the `$effect` cleanup — follow
  this pattern for any `URL.createObjectURL`.
- **Reduced motion:** all animations collapse under `prefers-reduced-motion`; don't rely on
  animation timing for correctness.
- **Don't reassign store bindings** (see §1) — mutate in place or reactivity breaks for all readers.

---

## 11. Cross-references

- **docs/reader-engine.md** — foliate-js integration, CSS-var → iframe injection (`appearanceCSS`),
  CFI/progress, reading-area margins, swipe/tap/selection handling, writing modes.
- **docs/architecture.md** — module layout, store ↔ service boundaries, data flow.
- **docs/storage-pwa-ios.md** — OPFS/IndexedDB, persistence, service worker, iOS standalone behavior.
- **docs/development.md** — build/dev tooling, adding settings end-to-end, conventions.
- **docs/deployment.md** — GitHub Pages deploy, CI, and the production `/epub/` base path (which
  prefixes built asset URLs, the PWA `start_url`/`scope`, and the SW navigate fallback).
