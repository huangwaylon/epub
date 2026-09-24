# UI & Design System — Tsuzuri

Tsuzuri is a Japanese EPUB reader PWA built with **Svelte 5 (runes) + TypeScript + Vite**, used
primarily on **iPad in landscape** as a Home-Screen standalone app. This doc owns the Svelte
conventions, design tokens, theming, the component library, and the responsive strategy. For the
rendering engine and storage see the [cross-references](#11-cross-references).

---

## 1. Svelte 5 runes & the store pattern

State lives in **`*.svelte.ts` modules** (the extension lets the compiler process runes outside a
component). Each exports a module-level `$state(...)` object (deep-reactive) plus plain functions
that mutate it. Components `import { store }` and read `store.x` directly — the read is tracked, so
the component re-renders when any reachable property changes. No `get`/`subscribe` API.

Canonical example, `src/stores/settings.svelte.ts`:

```ts
export const settings = $state<ReaderSettings>({ ...DEFAULT_SETTINGS })

export function updateSettings(patch: Partial<ReaderSettings>): void {
  Object.assign(settings, patch)                  // mutate in place — reactive
  if (patch.theme) applyTheme()
  if (hydrated) void saveSettings({ ...settings }) // persist (gated until first load)
}
```

Rules this repo follows:

- **Never reassign the exported binding** (`settings = ...`); mutate via `Object.assign` / property
  set / array methods so the proxy stays the same object. Reassigning breaks every importer's reactivity.
- **Mutate through exported functions** so persistence (`saveSettings`) and side effects
  (`applyTheme`) stay consistent. A `hydrated` flag suppresses the persist write until the initial
  IndexedDB load completes (so defaults don't overwrite saved settings on first run).
- `DEFAULT_SETTINGS` (`src/services/types.ts`) is the single source of truth for shape + defaults.
  Stored copies are filtered through `known()` on load, so a retired key (e.g. the old
  `tapToDefine` switch — lookup is now always on) is dropped instead of re-persisted forever.

The other stores (all in `src/stores/`) follow the same pattern:

| Store | Shape (abridged) | Mutators |
| --- | --- | --- |
| `settings.svelte.ts` | `ReaderSettings`: `theme` (`auto`/light/sepia/dark), `fontScale, lineHeight, marginScale, fontFamily, writingMode, highlightLookups` | `initSettings`, `updateSettings`, `applyTheme` |
| `library.svelte.ts` | `{ books, progress, loading, importing, importError }` | `refreshLibrary`, `importFiles`, `deleteBook`, `markOpened` |
| `annotations.svelte.ts` | `{ items: Annotation[] }` | `loadAnnotations`, `clearAnnotations`, `saveAnnotation`, `removeAnnotation`, `newId` |
| `dict.svelte.ts` | `{ state, updating, progress, warming, error? }` (offline JMdict status) | mutated directly by `services/jp/dictdb.ts` + download handlers (set `warming`) |
| `pwa.svelte.ts` | `{ needRefresh, offlineReady, update() }` | written by SW registration in `main.ts` |
| `toast.svelte.ts` | `{ current: { id, message, action?, duration?, onexpire? } \| null }` | `showToast`, `actOnToast`, `dismissToast` (one toast at a time; a replaced toast's `onexpire` still runs) |
| `nav.svelte.ts` | `{ route: Route }` | `openReader`, `openShelf` (see §7) |

> `pwa.*` and `dict.*` are mutated directly from components/services (e.g. `ToastHost` sets
> `pwa.needRefresh = false`). That's fine for simple, non-persisted flag objects;
> settings/library/annotations always go through their mutators.

### Runes used here

| Rune | Where | Purpose |
| --- | --- | --- |
| `$state(...)` | every store; component locals (`menuFor`, `settingsOpen` in `Shelf`) | reactive, deep-proxied state |
| `$derived(...)` | `BookCover` (`hue`), `TocSheet` (`items`), `AnnotationsPanel` (`highlights`/`bookmarks`/`list`), `ProgressScrubber` (`shown`/`pct`) | computed values |
| `$props()` | every component | destructure incoming props |
| `$bindable(default)` | `Sheet.open`, `Segmented.value`, `DictionaryPopup.open` | two-way-bindable props |
| `$effect(...)` | `BookCover` (objectURL lifecycle), `Sheet` (focus move/restore — capture **edge-gated** on a real closed→open transition so the `bind:this` re-run can't re-capture the sheet as the restore target), `DictionaryPopup`/`SelectionToolbar` (re-position via `placeAnchored`, **cancelling the queued rAF** on cleanup) | side effects + optional cleanup |

**Generics:** `Segmented.svelte` is `<script lang="ts" generics="T extends string | number">`, so
`value`/`options`/`onchange` are typed against the caller's literal union `T` (e.g. `ThemeName`,
`WritingModePref`, `'serif' | 'sans'`).

**Snippets & events:** `Sheet` takes `children: Snippet`, rendered with `{@render children()}`. Event
handlers are plain function props (`onclose`, `onchange`, `onnavigate`, …) — no `createEventDispatcher`.

---

## 2. Design tokens — `src/app.css`

`app.css` is the single global stylesheet (imported once in `main.ts`): base tokens on `:root`,
three palette blocks, base/reset, then a handful of **shared primitives**. Everything else is
scoped component CSS that styles itself *only* from these tokens — no ad-hoc font sizes, radii,
durations or glass recipes.

### Base tokens (`:root`)

| Group | Tokens | Notes |
| --- | --- | --- |
| **Fonts** | `--font-ui`, `--font-serif`, `--font-jp-sans`, `--font-mono` | UI = SF/system sans (the root size stays a fixed 15px — deliberately *not* `-apple-system-body`). Serif = Hiragino Mincho ProN → Noto Serif JP → Yu Mincho → Georgia. No web fonts are downloaded. |
| **Type scale** | `--fs-caption` 12 · `--fs-footnote` 13 · `--fs-body` 15 · `--fs-callout` 17 · `--fs-title` 20 · `--fs-headword` 24 · `--fs-display` clamp(30→36) | px; **nothing in the app is smaller than 12px**. |
| **Spacing** | `--sp-1`…`--sp-10` = 4, 8, 12, 16, 20, 24, 28, 32, 36, 40px | 4pt scale for padding/gaps/margins. |
| **Radii** | `--r-xs` 6 · `--r-sm` 10 · `--r-md` 14 · `--r-lg` 20 · `--r-xl` 28 · `--r-full` 999 | `--r-xl` = sheet corner, `--r-lg` = dictionary card, `--r-full` = capsules/segments/buttons. |
| **Touch** | `--tap` 44px, `--control-h` 44px | every tappable control is ≥44pt (small visual discs use an `::after` hit extension). |
| **Icons** | `--icon-sm` 18 · `--icon-md` 22 · `--icon-lg` 48 | mirrored by `Icon`'s `size="sm"\|"md"\|"lg"`. |
| **Elevation** | `--shadow-1` (raised), `--shadow-2` (floating), `--shadow-3` (sheets/popup) | dark palette deepens `--shadow-2`. |
| **Glass** | `--glass-bg` (paper-raised @ `--glass-mix` 72%, dark 68%), `--glass-bg-strong` (88%, content-bearing glass), `--glass-filter: blur(24px) saturate(1.6)`, `--glass-edge` (per palette hairline inner edge), `--glass-shadow` | the one Liquid-Glass recipe; `.glass` applies it. |
| **z-index** | `--z-ribbon` 12 · `--z-readout` 15 · `--z-bars` 20 · `--z-overlay` 30 · `--z-scrim` 40 · `--z-sheet` 41 · `--z-popup` 50 · `--z-toolbar` 52 · `--z-toast` 60 | floating reader overlays sit above sheets intentionally; toasts above everything. |
| **Motion** | `--dur-instant` 90ms · `--dur-fast` 140 · `--dur-base` 220 · `--dur-slow` 320; `--ease-out`, `--ease-in`, `--ease-spring`; `--press-scale` .97 | all zeroed (and press-scale → 1) under `prefers-reduced-motion`. JS mirror: `DUR` in `lib/util/motion.svelte.ts`. |
| **Safe area** | `--safe-top/bottom/left/right: env(safe-area-inset-*, 0px)` | requires `viewport-fit=cover` (set in `index.html`). |

### Palette tokens — `:root[data-theme=light|sepia|dark]`

The resolved palette is a `data-theme` attribute on `<html>` (`'auto'` resolves to light/dark in
`applyTheme()`); `light` is also the bare-`:root` default. Brand identity is the **vermilion
`--accent`** ("like a hanko seal"). Contrast figures are against `--paper`.

| Token | Role | light | sepia | dark |
| --- | --- | --- | --- | --- |
| `--paper` | app background | `#f6f3ec` | `#f4ecd8` | `#16140f` |
| `--paper-raised` | cards, sheets, bars | `#fffdf8` | `#fbf5e6` | `#211e18` |
| `--ink` | primary text | `#211d17` | `#4a3a29` | `#e7e1d3` |
| `--ink-soft` | secondary text / icons / hints | `#5d564a` | `#6f5c46` | `#aaa394` |
| `--ink-faint` | tertiary (section headers, meta) — **≥4.5:1** | `#746c5e` (4.7) | `#78664a` (4.7) | `#8f887a` (5.2) |
| `--line` / `--line-strong` | hairlines / tracks, grip | ink @ .10/.16 | .12/.20 | .10/.18 |
| `--accent` | vermilion brand | `#ad4f29` (4.8) | `#a8521f` (4.6) | `#e0855c` (6.7) |
| `--accent-soft` | tinted fills (chips, tinted buttons, empty-state art) | accent @ .12 | .14 | .16 |
| `--on-accent` | text/icons on `--accent` | `#fff` | `#fff` | `#1a0f08` (white on this accent is only 2.7:1) |
| `--control-track` | segmented/stepper/close-disc track, pressed rows | ink @ .06 | .08 | ink @ .08 |
| `--control-active` | the selected segment | `#fff` | `#fffaf0` | ink @ .18 (lighter than the track — no longer inverted) |
| `--danger` | errors, destructive rows | `#c0392b` | `#b23a26` | `#f0897a` |
| `--hl-yellow` | theme-aware UI highlight tint | `#ffe79a` | `#f2d98a` | `#6b5a1f` |
| `--scrim` | modal backdrop | ink @ .32 | .34 | black @ .5 |

> **Highlights are a single colour.** `HIGHLIGHT_HEX = '#ffd54a'` (`services/types.ts`) is the one
> saturated yellow the reader overlay, `SelectionToolbar`, `DictionaryPopup` and `AnnotationsPanel`
> paint. There is **no colour picker**.

### Shared primitives (global classes in `app.css`)

| Class | What | Used by |
| --- | --- | --- |
| `.btn` (+ `.btn-primary`, `.btn-tinted`) | 44pt capsule text button; plain = accent text, primary = filled accent + `--on-accent`, tinted = accent-soft fill. Press → `--press-scale`. | every text button (Shelf CTA, dict Download, toasts, error screens, Undo) |
| `.icon-btn` (+ `.on`, `.btn-primary`) | 44pt circular icon button, ink-soft, `.on` = accent | bars, shelf header, Notes delete, steppers, sheet ×, dictionary × |
| `.glass` | the Liquid-Glass material | reader bar capsules, SelectionToolbar, Toast |
| `.spinner` (+ `.delayed`, `--spinner-size`) | the one spinner; `.delayed` fades in after 0.4s | shelf loading, settings lazy-load, ShelfSettings "Preparing", popup re-target |
| `.progress-indeterminate` | thin indeterminate bar | `LoadingScreen`, popup "Preparing the dictionary…" |
| `.skeleton` | pulsing placeholder block | shelf import cards, first slow lookup |
| `.settings-stack` / `.settings-section` / `.settings-h` / `.settings-row` / `.settings-hint` | one section style for both settings sheets: uppercase footnote header in ink-faint, `--sp-6` between sections, rows ≥44px with hairline separators, 12px ink-soft hints | `ShelfSettings`, `ReaderSettings` |

**Glass & performance.** `backdrop-filter` re-samples every frame the content beneath moves, so it's
used only on chrome that is **not on screen during a page slide** (the bars hide on a turn; the
toolbar/popup close on a turn). The always-visible page-% readout and the bookmark ribbon have no
backdrop-filter. The dictionary card is deliberately opaque (legibility).

### `applyTheme()`

In the settings store, `applyTheme()` resolves `'auto'` against `prefers-color-scheme` (live — it
re-applies on OS change), publishes `appearance.resolved`, sets `<html data-theme>`, and writes the
resolved `--paper` into the dynamic `<meta name="theme-color">`. The reader reads the same CSS vars
to style the EPUB iframe (`appearanceCSS()` in `services/reader.ts` —
**[reader-engine.md](reader-engine.md)**).

---

## 3. Base & reset (`app.css`)

- `* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }` — no blue tap flash.
- `html, body`: `margin:0`, `height:100%` then `height:100dvh`; `#app` is the same. These stay
  on `100dvh` (in-flow): only the **fixed** `.reader` overlay uses `var(--app-height, 100dvh)`,
  published from the visual viewport by `services/viewport.ts` to fix the iOS cold-launch gap —
  applying it to in-flow elements fed back into the viewport and oscillated the bar (mechanism:
  **[reader-engine.md](reader-engine.md)**).
  Also `overflow:hidden` + **`overscroll-behavior:none`** (kills rubber-band / pull-to-refresh).
- Default `font-family: var(--font-ui)`, `-webkit-font-smoothing: antialiased`,
  `text-rendering: optimizeLegibility`.
- **Button reset:** inherits font/colour, no border/background, `cursor:pointer`,
  `touch-action: manipulation` (removes the 300ms tap delay).
- **Chrome non-selectable:** `button, .no-select { user-select:none; -webkit-touch-callout:none; }` —
  stops the iOS long-press callout from competing with tap-to-define / page turns. (The book body
  *is* selectable; the reader disables only the native callout via injected CSS.)
- `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }` — keyboard focus only.
- `@media (prefers-reduced-motion: reduce)` zeroes the `--dur-*` tokens and forces CSS
  animation/transition durations to `0.001ms` (loaders become static states). Svelte's JS
  transitions don't see the media query, so **every** `transition:`/`in:`/`out:` takes its duration
  through `dur(ms)` from `lib/util/motion.svelte.ts` (a live `motion.reduced` rune → 0).

---

## 4. Component inventory

Primitives in `src/lib/components/`; feature components in `src/lib/library/` and `src/lib/reader/`.
★ = `$bindable` prop.

| Component | Key props | Purpose |
| --- | --- | --- |
| `components/Sheet.svelte` | `open?`★, `title?`, `onclose?`, `children`, `maxHeight='85dvh'`, `variant='sheet'\|'popover'`, `anchor?` | Modal container. `sheet`: bottom sheet on phones, centred card ≥768px, dimming scrim. `popover` (live-preview panels — Display): on iPad a **glass popover hung under `anchor`**, on phones a bottom sheet; both with a **clear** scrim so the page stays undimmed. Enter `--dur-slow` ease-out, exit `--dur-base` ease-in (`sheetMotion` in `motion.svelte.ts`: rise/sink on phones, scale+fade on iPad); scrim fades `--dur-base`. Grip + 32px × disc (44pt hit). Closes on scrim/grip, ×, Escape. `role="dialog" aria-modal`; focus moves in and is restored to the trigger. |
| `components/Segmented.svelte` | `value`★, `options: {value,label?,icon?,count?,lang?,ariaLabel?}[]`, `onchange?`, `label?` | Generic capsule segmented control (`T extends string\|number`). `--control-track` track, `--control-active` raised segment, 44pt options. Renders the `icon`, a `count` badge (accent when active), and `lang` on the label (明朝/ゴシック/横書き/縦書き get `lang="ja"`). `aria-pressed` per option. |
| `components/Icon.svelte` | `name`, `size='md'` (`'sm'\|'md'\|'lg'` or px), `stroke=2`, `fill=false` | 24×24 stroke icon from `PATHS`: `plus`, `minus`, `gear`, `bookmark`, `list`, `chevron-left`, `chevron-down`, `x`, `trash`, `search`, `book`, `highlighter`, `copy`, `aa`. `fill` solidifies the same path. `aria-hidden`. |
| `components/Toast.svelte` | `message`, `actionLabel?`, `onaction?`, `ondismiss?`, `lift?` | Presentational glass pill (`--z-toast`); `lift` raises it above the reader's bottom capsule. |
| `components/ToastHost.svelte` | (reads `toast` + `pwa` stores) | Always mounted by `App`. App toasts (`showToast`) win; otherwise the PWA "A new version is ready · Refresh" / "Ready to read offline" (auto-dismiss 4s) prompts. |
| `components/LoadingScreen.svelte` | `title?`, `onback?` | Book title in serif over a thin indeterminate bar, fading in after 0.25s. Shared by `App` (reader chunk pending, title from the shelf) and `Reader` (book opening, with a Library button). |
| `library/BookCover.svelte` | `book` | Cover `Blob` via an `objectURL` (revoked in `$effect` cleanup); else a generated placeholder (hue from the id). 2:3. |
| `library/Shelf.svelte` | (screen) | `蔵書 / Library` header (settings `.icon-btn` + primary import). Grid of covers with **press feedback** (`--press-scale`), a thin **progress rule** under each cover and `NN%` / `New` / `Finished` in the meta line. **Skeleton cards** while `library.importing`. Empty state (centred, with a dictionary tip linking to Settings). Long-press/right-click → action sheet; **Remove** hides the book at once and shows *Book removed · Undo*; the real `deleteBook` runs when the toast expires (~5s). Pending removals live in a module-level `SvelteSet`, so they survive the Shelf unmounting. |
| `library/ShelfSettings.svelte` | (in the Settings sheet) | Dictionary status + Download/Retry (`.btn`, 44pt) + progress; "One-time download · works offline". Compact **Appearance** theme picker (Auto/Light/Sepia/Dark). **About**: storage as one text line, version + credits collapsed in a `<details>`. |
| `reader/ReaderSettings.svelte` | `onchange(kind)` | Display panel: Theme (Auto/Light/Sepia/Dark), Text (明朝/ゴシック + size/line-spacing/margin steppers — 44pt ±, disabled at their limits), Writing direction (Auto/横書き/縦書き), Dictionary → **Highlight looked-up words** switch (`settings.highlightLookups`). `marginScale` → `'layout'`, others → `'appearance'`. |
| `reader/TocSheet.svelte` | `toc`, `currentId?`, `currentLabel?`, `onnavigate` | Flattened TOC, 44pt rows, current chapter in accent and scrolled into view. |
| `reader/AnnotationsPanel.svelte` | `onnavigate`, `onremove`, `chapterOrder?` | **Highlights & Bookmarks** (one name, sheet title + button aria-label, `highlighter` icon). `Segmented` tabs with counts; list area has a stable `min-height`. Highlights grouped by chapter in TOC order; single looked-up words render as serif headwords, passages as body text. Delete → the reader removes it and shows *Highlight deleted · Undo* (restores the same record + repaints). |
| `reader/DictionaryPopup.svelte` | `open?`, `anchor`, `vertical`, `loading?`, `needsDownload?`, `result?`, `highlighted?`, `onclose/ondownload/ontogglehighlight` | Floating card (`--z-popup`) placed by `placeNearWord`. Headword serif 24, reading in accent, glosses 15, POS/chips/pitch 12. The first line of every state reserves `--sp-8` for the 44pt ×. A slow first lookup shows a **skeleton**; a re-targeted card dims the old result. Download state: primary button + "One-time download · works offline"; "Preparing the dictionary…" shows an indeterminate bar. Footer highlight toggle is 44pt. |
| `reader/SelectionToolbar.svelte` | `open?`, `rect`, `onHighlight?`, `onCopy?` | Glass capsule above a selection: **Highlight** (44pt) + Copy (44pt). Copy shows a *Copied* toast. |
| `reader/ProgressScrubber.svelte` | `fraction?`, `sectionLabel?`, `labelAt?(frac)`, `onseek?` | Bottom-capsule progress: 4px track + 12px ink-soft section/% line. Drag-to-scrub (8px touch / 4px mouse arm), commit on release; the preview bubble shows the **target chapter title** (`labelAt`, resolved by the Reader from foliate's section fractions + TOC hrefs) over the %. `role="slider"`. |
| `reader/Reader.svelte` chrome | — | Two floating **glass capsules**: top = grid `minmax(92–100px,1fr) auto minmax(…,1fr)` so the title is optically centred; bottom = TOC · scrubber · bookmark, centred ≤680px on iPad. Both stay inside the chrome-toggle band (see §6). Bookmarked page → a small accent **ribbon** on the fore-edge top corner (left for rtl books), `pointer-events:none`, spring scale-in. Page-% readout (no glass) while chrome is hidden. |

---

## 5. Actions & utilities

**`use:longpress`** (`src/lib/actions/longpress.ts`) — iOS-style context menus (the shelf book menu).
Starts a `setTimeout` (default **450ms**) on `pointerdown`; **cancels on movement >10px** (`Math.hypot`)
or on `pointerup`/`pointercancel`/`pointerleave`, so it never fires on a tap or scroll drag. `Shelf`
pairs it with `oncontextmenu` (preventDefault) for right-click / trackpad.

**`debounce`** (`src/lib/util/debounce.ts`) — trailing-edge debounce, generic over the arg tuple. The
returned wrapper carries `.cancel()` to drop a pending call on teardown. Used to coalesce
high-frequency events (e.g. progress saves in `services/reader.ts` /
**[reader-engine.md](reader-engine.md)**).

**`placeAnchored`** (`src/lib/util/anchoredPosition.ts`) —
`placeAnchored(centerX, anchorTop, anchorBottom, w, h, opts?)` → `{ left, top }` for a `w`×`h` layer:
centres on `centerX`, **prefers above** the anchor and **flips below** when cramped, and clamps inside
the viewport honouring the **safe-area insets** (cached from `--safe-*`, re-read on resize/orientation
change). `opts.gap` (default 12) is the anchor offset, `opts.margin` (default 10) the edge inset.
Shared by `DictionaryPopup` (`gap:16`) and `SelectionToolbar` so both respect the iPad's rounded
corners / home indicator.

---

## 6. Responsive / iPad-landscape strategy

iPad-landscape-first. A single breakpoint at **`@media (min-width: 768px)`** switches phone layouts to
a roomier centered tablet form. No JS device detection — pure CSS.

| Surface | < 768px (phone) | ≥ 768px (iPad/wide) |
| --- | --- | --- |
| **Sheets** (`Sheet`) | Full-width bottom sheet, rises from bottom, drag-grip, top-corner radius | **Centered modal card**: `top/left:50%` + `translate(-50%,-50%)`, `width: min(480px, 100vw-96px)`, `max-height: min(82dvh,760px)`, all-corner radius, grip hidden, scale+fade in/out. Applies to every `variant="sheet"` (TOC/Notes/Settings/book menu); Display is the `popover` variant (row below). The iPad `@media` block sits **after** the base rules so it actually overrides them. |
| **Shelf** (`Shelf`) | Grid `minmax(118px,1fr)`, gap `--sp-6 --sp-4`, edge padding `--sp-5` | Content centred at **`max-width: 1120px`**, covers `minmax(168px,1fr)`, gap `--sp-10 --sp-7`, edge padding `--sp-10` |
| **Reader chrome** (`Reader`) | Capsules inset `--sp-2`, 48px tall, top at `safe-top + 4` | Capsules inset `--sp-4`, 52px, top at `safe-top + 12`; bottom capsule centred `min(680px, …)` |
| **Display settings** | Bottom sheet over a *clear* scrim | Glass popover under the Aa button, no scrim dimming |

**Chrome-toggle band budget.** The bars must end inside `inChromeToggleBand` (12% of the
visual-viewport height, clamped 80–160px) so a tap where they appear toggles them. iPad landscape
(834 → 100px band): the top capsule ends ≈ safe-top + 64px, the bottom one starts ≈ 60px +
safe-bottom above the edge. On an iPhone with a 59px top inset the top capsule ends ≈ 111px vs a
102px band — slightly over (the pre-redesign bar ended at ≈121px).

Reading-area margins / measure (column width, gutter, padding) are tuned in `services/reader.ts`
(`marginScale`, writing-mode), not component CSS — see **[reader-engine.md](reader-engine.md)**.

**Safe areas:** every full-bleed surface pads with the `--safe-*` vars, enabled by `viewport-fit=cover`.
iOS standalone meta tags make it behave like a native app from the Home Screen — see
**[storage-pwa-ios.md](storage-pwa-ios.md)**.

---

## 7. Navigation / routing

`src/stores/nav.svelte.ts` is a minimal in-memory router — no URL routing.

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
<ToastHost />
```

`{#key bookId}` forces a full teardown/remount of `Reader` on book switch, so the foliate view and
all reader state reset cleanly. `ToastHost` is always mounted. While the reader chunk loads, `App` shows `LoadingScreen` with the title from the shelf.

---

## 8. UI conventions

- **Scoped styles:** each `.svelte` owns a `<style>`; only `app.css` is global. Theme overrides inside
  a component use `:global([data-theme='dark']) .x { … }` (e.g. `BookCover` placeholder, `Shelf` danger row).
- **`lang="ja"` on Japanese text:** every element holding book-derived Japanese (titles, authors, TOC
  labels, dictionary headwords, highlight text) carries `lang="ja"` for correct fonts / line-breaking.
  Apply it to any new element rendering user/book Japanese.
- **Accessibility:** icon-only buttons get `aria-label` (e.g. "Settings", "Import book", "Close",
  "Highlights & Bookmarks"). Sheets use `role="dialog" aria-modal="true"`; the "Highlight looked-up
  words" switch uses `role="switch" aria-checked`; segmented options use `aria-pressed`; the
  scrubber uses `role="slider"`; toasts are `role="status" aria-live="polite"`.
- **Touch targets:** ≥44pt everywhere (segments, steppers, dict Download, shelf icon buttons, error
  dismiss, popup toggle, toolbar Highlight, Notes tabs). Visually smaller discs (sheet ×, switch)
  extend their hit area with an `::after`.
- **Undo, not confirm:** destructive actions (remove a book, delete a highlight/bookmark) happen
  immediately and offer *Undo* in a toast.
- **`tabular-nums`** on changing numbers — reader progress %, stepper values, dictionary pitch — so
  digits don't jitter.
- **Aesthetic:** calm paper-and-vermilion. Serif for reading + book titles + dictionary headwords;
  system sans for chrome; vermilion `--accent` for active states, primary buttons, links, focus rings;
  a single yellow for highlights.

---

## 9. How to extend

**Add a sheet/dialog:** wrap your body in `Sheet` for free responsive bottom-sheet ↔ centered-card,
scrim, and Escape handling.

```svelte
<Sheet bind:open={myOpen} title="My panel" onclose={() => {/* … */}}>
  <MyPanelBody />
</Sheet>
```

**Show a toast:** `showToast({ message, action?: { label, run }, onexpire? })` from
`stores/toast.svelte`. For an undoable delete, remove from the UI now and commit in `onexpire`.

**Add an icon:** add a 24×24 `currentColor` path to the `PATHS` map in `Icon.svelte` (module script),
then `<Icon name="my-icon" />`. Keep the map to icons in active use. For a solid variant pass `fill`
to fill the **same** path (as the active bookmark does) — no separate `-fill` entry.

**Add a theme:** add a `:root[data-theme='<name>']` block defining **all** palette tokens
(`--paper`, `--paper-raised`, `--ink*`, `--line*`, `--accent*`, `--on-accent`, `--control-track`,
`--control-active`, `--danger`, `--hl-yellow`, `--scrim`, `--glass-edge`, plus `color-scheme`; keep
`--ink-faint` ≥4.5:1 on `--paper`); add the option to the theme `Segmented` arrays in
`ShelfSettings.svelte` / `ReaderSettings.svelte`; add its paper colour to `PAPER` in the settings
store and the inline script in `index.html`; widen `ThemeName` in `services/types.ts`. The in-book rendering picks it up
automatically (the reader reads live CSS vars).

**Add a setting control:** extend `ReaderSettings` + `DEFAULT_SETTINGS` (`services/types.ts`), add a
control that calls `updateSettings({ … })` (persists + applies). If it affects in-book rendering, wire
the `onchange(kind)` callback so the reader re-applies the right aspect — see
**[development.md](development.md)** and **[reader-engine.md](reader-engine.md)**.

---

## 10. Gotchas

- **Sheets are modal but don't trap focus:** `Sheet` renders a `--scrim` (`--z-scrim`) and closes on
  scrim/grip tap, the 44px close button, or **Escape**. To honour `aria-modal` it moves focus into the
  sheet on open and restores to the trigger on close.
- **Popup & toolbar are NOT sheets:** `DictionaryPopup` and `SelectionToolbar` are **floating**
  (`position:fixed`), positioned in a `$effect`/rAF via `placeAnchored`. No scrim, don't close on
  Escape; the **reader** owns their `open` state. While the dictionary popup is open it's the
  highest-priority *blank* tap target: a blank tap only dismisses it; a tap on another glyph
  re-targets it (see [reader-engine.md](reader-engine.md) §8). Also dismissed by a page turn (`onTurn` closes overlays)
  and its own × button. (Tap/turn gesture details: **[reader-engine.md](reader-engine.md)**.)
- **Theme before first paint:** `main.ts` `await`s `initSettings()` before `mount(App, …)`, so
  `applyTheme()` has set `<html data-theme>` before the first frame (no light→dark flash). `index.html`
  ships static `theme-color` media metas as a pre-hydration fallback; `applyTheme()` then writes the
  dynamic non-media one.
- **z-index ladder:** use the `--z-*` tokens (§2), never raw numbers.
- **No `transform` on elements with a `fly`:** Svelte's fly animates `transform`; centre such
  elements with the `translate` property (bottom capsule, toast).
- **Custom properties resolve where declared:** overriding `--glass-mix` on a component does not
  change `--glass-bg` (computed on `:root`) — use `--glass-bg-strong` or the palette block.
- **objectURL leaks:** `BookCover` revokes its cover `objectURL` in the `$effect` cleanup — follow this
  for any `URL.createObjectURL`.
- **Reduced motion:** CSS collapses via the media query; Svelte transitions must pass `dur(…)`.
  Don't rely on animation timing for correctness.
- **Don't reassign store bindings** (§1) — mutate in place or reactivity breaks for all readers.

---

## 11. Cross-references

- **[reader-engine.md](reader-engine.md)** — foliate-js integration, CSS-var → iframe injection
  (`appearanceCSS`), the `--app-height` viewport mechanism, CFI/progress, reading-area margins,
  swipe/tap/selection handling, writing modes.
- **[architecture.md](architecture.md)** — module layout, store ↔ service boundaries, data flow.
- **[storage-pwa-ios.md](storage-pwa-ios.md)** — OPFS/IndexedDB, persistence, service worker, iOS standalone.
- **[development.md](development.md)** — build/dev tooling, adding settings end-to-end, conventions.
- **[deployment.md](deployment.md)** — GitHub Pages deploy, CI, and the `/epub/` base path.
