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

The other stores (all in `src/stores/`) follow the same pattern:

| Store | Shape (abridged) | Mutators |
| --- | --- | --- |
| `settings.svelte.ts` | `ReaderSettings`: `theme, fontScale, lineHeight, marginScale, fontFamily, writingMode, tapToDefine` | `initSettings`, `updateSettings`, `applyTheme` |
| `library.svelte.ts` | `{ books, progress, loading, importing, importError }` | `refreshLibrary`, `importFiles`, `deleteBook`, `markOpened` |
| `annotations.svelte.ts` | `{ items: Annotation[] }` | `loadAnnotations`, `clearAnnotations`, `saveAnnotation`, `removeAnnotation`, `newId` |
| `dict.svelte.ts` | `{ state, updating, progress, warming, error? }` (offline JMdict status) | mutated directly by `services/jp/dictdb.ts` + download handlers (set `warming`) |
| `pwa.svelte.ts` | `{ needRefresh, offlineReady, update() }` | written by SW registration in `main.ts` |
| `nav.svelte.ts` | `{ route: Route }` | `openReader`, `openShelf` (see §7) |

> `pwa.*` and `dict.*` are mutated directly from components/services (e.g. `UpdateToast` sets
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

`app.css` is the single global stylesheet (imported once in `main.ts`): token layers on `:root`,
three theme blocks, then base/reset. Everything else is scoped component CSS.

### Base tokens (`:root`)

| Group | Tokens | Notes |
| --- | --- | --- |
| **Type** | `--font-ui`, `--font-serif`, `--font-jp-sans` | UI = SF/system sans. Serif = Hiragino Mincho ProN → Noto Serif JP → Yu Mincho → Georgia (long-form reading). JP-sans = Hiragino Sans → Noto Sans JP (ゴシック). |
| **Radii** | `--r-sm: 8px`, `--r-md: 12px`, `--r-lg: 18px`, `--r-xl: 26px` | `--r-xl` is the sheet corner. |
| **Touch** | `--tap: 44px` | minimum comfortable touch target. |
| **Shadow** | `--shadow-1` (raised surfaces), `--shadow-2` (sheets/toasts/popups) | |
| **Motion** | `--ease: cubic-bezier(0.22,0.61,0.36,1)`, `--dur: 0.22s` | shared easing/duration. |
| **Safe area** | `--safe-top/bottom/left/right: env(safe-area-inset-*, 0px)` | surfaced as vars for layout math (e.g. `calc(var(--safe-bottom) + 8px)`). Requires `viewport-fit=cover` (set in `index.html`). |

### Theme tokens — `:root[data-theme=light|sepia|dark]`

The active theme is a `data-theme` attribute on `<html>` (set by `applyTheme()`); `light` is also
applied to bare `:root` as the default. Each block sets `color-scheme` plus the semantic tokens
below. Brand identity is the **vermilion `--accent`** ("like a hanko seal").

| Token | Role | light | sepia | dark |
| --- | --- | --- | --- | --- |
| `--paper` | app background | `#f6f3ec` | `#f4ecd8` | `#16140f` |
| `--paper-raised` | cards, sheets, bars | `#fffdf8` | `#fbf5e6` | `#211e18` |
| `--ink` | primary text | `#211d17` | `#4a3a29` | `#e7e1d3` |
| `--ink-soft` | secondary text / icons | `#5d564a` | `#6f5c46` | `#aaa394` |
| `--ink-faint` | tertiary / hints | `#938b7b` | `#9c876c` | `#756f62` |
| `--line` | hairline dividers | `rgba(ink,0.10)` | `rgba(ink,0.12)` | `rgba(ink,0.10)` |
| `--line-strong` | borders, grip, tracks | `rgba(ink,0.16)` | `rgba(ink,0.20)` | `rgba(ink,0.18)` |
| `--accent` | **vermilion** brand | `#b5552e` | `#a8521f` | `#e0855c` |
| `--accent-soft` | tinted fills (segmented bg, chips, active states) | `rgba(accent,0.12)` | `0.14` | `0.16` |
| `--hl-yellow` | theme-aware UI highlight tint | `#ffe79a` | `#f2d98a` | `#6b5a1f` |
| `--scrim` | modal backdrop | `rgba(ink,0.32)` | `rgba(.,0.34)` | `rgba(0,0,0,0.5)` |

> **Highlights are a single colour.** `--hl-yellow` is the only highlight token (no green/blue/pink).
> Separately, `HIGHLIGHT_HEX = '#ffd54a'` (`services/types.ts`) is the one saturated yellow the
> **reader overlay, `SelectionToolbar`, `DictionaryPopup` footer, and `AnnotationsPanel`** paint,
> chosen to read well behind text at ~0.3 opacity. There is **no colour picker** — a single tap
> highlights yellow as a vocab marker.

### `applyTheme()`

In the settings store, `applyTheme()`:

1. sets `document.documentElement.dataset.theme = settings.theme` (drives the `[data-theme]` blocks), then
2. reads back the resolved `--paper` via `getComputedStyle(...)` and writes it into a dynamic
   non-`media` `<meta name="theme-color">` (created if absent) so the iOS status/address bar matches.

The reader engine reads these *same* CSS vars to style content inside the EPUB iframe: `appearanceCSS()`
in `services/reader.ts` pulls `--ink`, `--accent`, `--accent-soft`, `--font-serif`/`--font-jp-sans`
off `document.documentElement` and injects a stylesheet into each content document, so the rendered
book always matches the chrome. That injection pipeline lives in
**[reader-engine.md](reader-engine.md)** — not duplicated here.

---

## 3. Base & reset (`app.css`)

- `* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }` — no blue tap flash.
- `html, body`: `margin:0`, `height:100%` then **`height: var(--app-height, 100dvh)`**; `#app` is the
  same. `--app-height` is published from the visual viewport by `services/viewport.ts` to fix the iOS
  cold-launch / rotation gap; `100dvh` is the pre-JS fallback (mechanism: **[reader-engine.md](reader-engine.md)**).
  Also `overflow:hidden` + **`overscroll-behavior:none`** (kills rubber-band / pull-to-refresh).
- Default `font-family: var(--font-ui)`, `-webkit-font-smoothing: antialiased`,
  `text-rendering: optimizeLegibility`.
- **Button reset:** inherits font/colour, no border/background, `cursor:pointer`,
  `touch-action: manipulation` (removes the 300ms tap delay).
- **Chrome non-selectable:** `button, .no-select { user-select:none; -webkit-touch-callout:none; }` —
  stops the iOS long-press callout from competing with tap-to-define / page turns. (The book body
  *is* selectable; the reader disables only the native callout via injected CSS.)
- `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }` — keyboard focus only.
- `@media (prefers-reduced-motion: reduce)` forces all animation/transition durations to `0.001ms`.

---

## 4. Component inventory

Primitives in `src/lib/components/`; feature components in `src/lib/library/` and `src/lib/reader/`.
★ = `$bindable` prop.

| Component | Key props | Purpose |
| --- | --- | --- |
| `components/Sheet.svelte` | `open?`★, `title?`, `onclose?`, `children: Snippet`, `maxHeight='85dvh'` | Modal container. **Bottom sheet on phones; centered modal card ≥768px** (§6). Scrim + drag-grip + optional header with a 44px close button. Closes on scrim/grip tap, close button, or **Escape**. `role="dialog" aria-modal`; on open moves focus into the sheet (`tabindex="-1"`), restores to the trigger on close. |
| `components/Segmented.svelte` | `value`★, `options: {value,label?,icon?}[]`, `onchange?` | Generic segmented control (`T extends string\|number`). `--accent-soft` track; active segment raised on `--paper-raised`. `aria-pressed` per option. (Renders `label ?? value`; no icon rendering despite the `icon?` field.) Used for theme/font/writing-mode pickers. |
| `components/Icon.svelte` | `name`, `size=24`, `stroke=2`, `fill=false` | Inline 24×24 stroke icon from a module-level `PATHS` map. Only the icons in use: `plus`, `gear`, `bookmark`, `list`, `arrow-left`, `x`, `trash`, `search`, `book`, `note`, `copy`, `aa`. One `<path>` with `currentColor`; `fill` toggles solid vs. outline on the **same** path (e.g. active bookmark — no `-fill` entry). `aria-hidden`. |
| `components/UpdateToast.svelte` | (reads `pwa` store) | Floating pill, `z-index:60`. `pwa.needRefresh` → "Refresh" (`pwa.update()`) or dismiss (`needRefresh=false`); `pwa.offlineReady` → "Ready to read offline" (auto-dismisses after 4s). |
| `library/BookCover.svelte` | `book: BookMeta` | Renders the cover `Blob` via an `objectURL` (created/revoked in a `$effect`). No cover → generated placeholder whose gradient + spine hue derives from the book id (`$derived hue = Σ charCodes(id[0..5]) % 360`). 2:3 aspect. |
| `library/Shelf.svelte` | (top-level screen) | Library grid: header (`蔵書 / Library`), import `<input type=file>`, settings gear, per-book progress ring. Long-press / right-click opens a per-book action `Sheet` (Read / Remove). Empty + loading states. Lazy-imports `ShelfSettings` on first Settings open. |
| `library/ShelfSettings.svelte` | (inside the settings `Sheet`) | App settings: theme `Segmented`, JMdict download (+ progress / "caching for offline" state), storage quota bar, About + version. |
| `reader/ReaderSettings.svelte` | `onchange: (kind:'appearance'\|'layout'\|'writingmode')=>void` | Display sheet body: theme + font-family (明朝/ゴシック) `Segmented`s, text-size/line-spacing/margin steppers, writing-direction `Segmented` (Auto/横書き/縦書き), and a custom switch for tap-to-look-up. `marginScale` → `'layout'`, the others → `'appearance'`, so the reader re-applies only what changed. |
| `reader/TocSheet.svelte` | `toc: TocItem[]`, `currentLabel?`, `onnavigate: (href)=>void` | Flattens nested TOC (`$derived`), indents by depth, marks `currentLabel`, disables items with no `href`. |
| `reader/AnnotationsPanel.svelte` | `onnavigate: (cfi)=>void` | Tabbed Highlights / Bookmarks from the `annotations` store (`$derived` filtered + sorted newest-first). Yellow bar (`HIGHLIGHT_HEX`) or bookmark icon; row → navigate; trash → `removeAnnotation`. |
| `reader/DictionaryPopup.svelte` | `open?`★, `x`, `y`, `loading?`, `needsDownload?`, `result?: LookupResult\|null`, `highlighted?`, `ondownload?`, `ontogglehighlight?` | **Floating** (`position:fixed`) word-lookup card near the tap, via `placeAnchored` (prefers above, flips below, clamped to viewport + safe area; `gap:16`). Re-positions on `x`/`y` **and** content change. Flex column: scrolling `.body` + sticky `.actions` footer. States: spinner / download-prompt / entries / no-match. Footer shows a single yellow **highlight toggle** (`Highlight` / `Remove highlight`) only when a real result is present. Focusable × close. Not a sheet. |
| `reader/SelectionToolbar.svelte` | `open?`, `rect`, `onHighlight?`, `onCopy?` | **Floating** pill above a text selection (same `placeAnchored`). One yellow **Highlight** action (18px swatch) + **Copy** (44px hit). No colour picker. Replaces the native iOS callout. |
| `reader/ProgressScrubber.svelte` | `fraction?`, `sectionLabel?`, `onseek?: (frac)=>void` | Bottom-bar progress control: hairline track + section-label/% readout that becomes a **drag-to-fast-scroll scrubber**. 8px (touch)/4px (mouse) dead-zone before arming, live preview bubble, commit-on-release (`onseek`→`goToFraction`), clean tap = no-op (flashes the thumb). `role="slider"` + arrow/Home/End keys. |

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
| **Sheets** (`Sheet`) | Full-width bottom sheet, rises from bottom, drag-grip, top-corner radius | **Centered modal card**: `top/left:50%` + `translate(-50%,-50%)`, `width: min(480px, 100vw-96px)`, `max-height: min(82dvh,760px)`, all-corner radius, grip hidden, `pop-center` animation. Applies to **every** sheet (Display/TOC/Notes/Settings) since they all wrap `Sheet`. |
| **Shelf** (`Shelf`) | Grid `minmax(118px,1fr)`, gap `22px 16px`, `h1` 30px, edge padding 18px | Content centered at **`max-width: 1120px`** (`.bar/.grid/.importing/.import-error/.state`), covers `minmax(168px,1fr)` gap `38px 28px`, `h1` 36px, edge padding 40px |
| **Reader chrome** (`Reader`) | Bars span full width; progress `flex:1` | Bars padded `max(--safe-*, 26px)`; progress block capped & centered: **`flex: 0 1 580px; margin-inline:auto`**; title 16px |

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
<UpdateToast />
```

`{#key bookId}` forces a full teardown/remount of `Reader` on book switch, so the foliate view and
all reader state reset cleanly. `UpdateToast` is always mounted.

---

## 8. UI conventions

- **Scoped styles:** each `.svelte` owns a `<style>`; only `app.css` is global. Theme overrides inside
  a component use `:global([data-theme='dark']) .x { … }` (e.g. `BookCover` placeholder, `Shelf` danger row).
- **`lang="ja"` on Japanese text:** every element holding book-derived Japanese (titles, authors, TOC
  labels, dictionary headwords, highlight text) carries `lang="ja"` for correct fonts / line-breaking.
  Apply it to any new element rendering user/book Japanese.
- **Accessibility:** icon-only buttons get `aria-label` (e.g. "Settings", "Import book", "Close").
  Sheets use `role="dialog" aria-modal="true"`; the tap-to-look-up toggle uses `role="switch"
  aria-checked`; segmented options use `aria-pressed`; the scrubber uses `role="slider"`.
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

**Add an icon:** add a 24×24 `currentColor` path to the `PATHS` map in `Icon.svelte` (module script),
then `<Icon name="my-icon" />`. Keep the map to icons in active use. For a solid variant pass `fill`
to fill the **same** path (as the active bookmark does) — no separate `-fill` entry.

**Add a theme:** add a `:root[data-theme='<name>']` block defining **all** semantic tokens
(`--paper`, `--paper-raised`, `--ink*`, `--line*`, `--accent*`, `--hl-yellow`, `--scrim`, plus
`color-scheme`); add the option to the theme `Segmented` arrays in `ShelfSettings.svelte` /
`ReaderSettings.svelte`; widen `ThemeName` in `services/types.ts`. The in-book rendering picks it up
automatically (the reader reads live CSS vars).

**Add a setting control:** extend `ReaderSettings` + `DEFAULT_SETTINGS` (`services/types.ts`), add a
control that calls `updateSettings({ … })` (persists + applies). If it affects in-book rendering, wire
the `onchange(kind)` callback so the reader re-applies the right aspect — see
**[development.md](development.md)** and **[reader-engine.md](reader-engine.md)**.

---

## 10. Gotchas

- **Sheets are modal but don't trap focus:** `Sheet` renders a `--scrim` (`z-index:40`) and closes on
  scrim/grip tap, the 44px close button, or **Escape**. To honour `aria-modal` it moves focus into the
  sheet on open and restores to the trigger on close.
- **Popup & toolbar are NOT sheets:** `DictionaryPopup` and `SelectionToolbar` are **floating**
  (`position:fixed`), positioned in a `$effect`/rAF via `placeAnchored`. No scrim, don't close on
  Escape; the **reader** owns their `open` state. While the dictionary popup is open it's the
  highest-priority tap target: the next tap anywhere (incl. the nav-bar band) **only dismisses it** —
  it does not re-define or toggle the chrome. Also dismissed by a page turn (`onTurn` closes overlays)
  and its own × button. (Tap/turn gesture details: **[reader-engine.md](reader-engine.md)**.)
- **Theme before first paint:** `main.ts` `await`s `initSettings()` before `mount(App, …)`, so
  `applyTheme()` has set `<html data-theme>` before the first frame (no light→dark flash). `index.html`
  ships static `theme-color` media metas as a pre-hydration fallback; `applyTheme()` then writes the
  dynamic non-media one.
- **z-index ladder:** reader bars 20 / page-% readout 15 / scrim 40 / sheet 41 / dictionary popup 50 /
  selection toolbar 52 / update toast 60. Floating reader overlays sit above sheets intentionally.
- **objectURL leaks:** `BookCover` revokes its cover `objectURL` in the `$effect` cleanup — follow this
  for any `URL.createObjectURL`.
- **Reduced motion:** all animations collapse under `prefers-reduced-motion`; don't rely on animation
  timing for correctness.
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
