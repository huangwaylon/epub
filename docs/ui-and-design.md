# UI & design system

Svelte conventions, design tokens, shared primitives, the component catalogue and the responsive
rules. Target: iPad landscape (Home Screen PWA), iPhone second. Engine-side styling (the EPUB
iframe, reading margins) lives in [reader-engine.md](reader-engine.md).

## 1. Svelte conventions

- **Stores** are `src/stores/*.svelte.ts` modules exporting a module-level `$state` object plus
  mutator functions. Components read `store.x` directly. Never reassign the exported binding;
  mutate in place. Persisted stores (settings, library, annotations) are only changed through
  their mutators, so persistence and side effects run; `pwa` and `dict` are plain flag objects and
  are written directly.

  | Store | State | Mutators |
  | --- | --- | --- |
  | `settings` | `ReaderSettings` (`theme`, `fontScale`, `lineHeight`, `marginScale`, `fontFamily`, `writingMode`, `highlightLookups`); `appearance.resolved` | `initSettings`, `updateSettings` |
  | `library` | `books`, `progress`, `loading`, `importing`, `importError` | `refreshLibrary`, `importFiles`, `deleteBook`, `markOpened` |
  | `annotations` | `items` (read-only getter over an immutable `$state.raw` array; replaced, never mutated) | `loadAnnotations`, `clearAnnotations`, `addHighlightRecord`, `removeHighlightRecord`, `saveAnnotation`, `removeAnnotation`; queries `isHighlighted`, `highlightAt` |
  | `dict` | offline-dictionary status (`state`, `progress`, `error`, …) | written by `services/jp/dictdb.ts` |
  | `pwa` | `needRefresh`, `offlineReady`, `update()` | written by SW registration in `main.ts` |
  | `toast` | `current` (one toast at a time) | `showToast`, `actOnToast`, `dismissToast` |
  | `nav` | `route` (`shelf` \| `reader` + `bookId`) | `openReader`, `openShelf`, `warmReader` |

- **Props** via `$props()`; two-way props via `$bindable()`. Events are callback props
  (`onclose`, `onchange`, …), never `createEventDispatcher`. Content is passed as snippets
  (`children: Snippet`, `{@render children()}`).
- **`$derived`** for computed values, **`$effect`** only for DOM/side effects with cleanup
  (object URLs, listeners, focus).
- **Generics:** `Segmented` is `generics="T extends string | number"`, so options are typed against
  the caller's union (`ThemeName`, `WritingModePref`, …).
- **Scoped styles** in every component; `src/app.css` is the only global stylesheet. Theme
  overrides use `:global([data-theme='dark']) .x`. Style only from tokens (§2).
- `lang="ja"` on every element that renders book/Japanese text; `aria-label` on icon-only
  buttons; `tabular-nums` on changing numbers.
- Every Svelte `transition:`/`in:`/`out:` takes its duration through `dur(ms)` from
  `lib/util/motion.svelte.ts` (JS transitions don't see the reduced-motion media query).
- Destructive actions (remove book, delete highlight/bookmark) act immediately and offer
  **Undo** in a toast; no confirm dialogs.

## 2. Tokens (`src/app.css`)

Base tokens on `:root`:

| Group | Tokens |
| --- | --- |
| Fonts | `--font-ui` (system sans), `--font-serif` (Hiragino Mincho → Noto Serif JP → Yu Mincho → Georgia), `--font-jp-sans` (read by `reader.ts` for ゴシック), `--font-mono`. No web fonts. |
| Type | `--fs-caption` 12 · `--fs-footnote` 13 · `--fs-body` 15 · `--fs-callout` 17 · `--fs-title` 20 · `--fs-headword` 24 · `--fs-display` clamp(30–36px). Nothing below 12px. |
| Spacing | `--sp-1`…`--sp-8` = 4…32px (4pt steps), `--sp-10` = 40px |
| Radii | `--r-xs` 6 · `--r-sm` 10 · `--r-md` 14 · `--r-lg` 20 · `--r-xl` 28 · `--r-full` 999 |
| Touch | `--tap` 44px, `--control-h` 44px, `--icon-sm` 18px |
| Elevation | `--shadow-1` (raised), `--shadow-2` (floating; deeper in dark), `--shadow-3` (sheets, popup) |
| Glass | `--glass-mix` (72%, dark 68%), `--glass-bg`, `--glass-bg-strong` (88%, for glass carrying text), `--glass-filter` (blur 24px saturate 1.6), `--glass-shadow` (= `--glass-edge` + `--shadow-2`) |
| z-index | `--z-ribbon` 12 · `--z-readout` 15 · `--z-bars` 20 · `--z-overlay` 30 · `--z-scrim` 40 · `--z-sheet` 41 · `--z-popup` 50 · `--z-toolbar` 52 · `--z-toast` 60 |
| Motion | `--dur-instant` 90ms · `--dur-fast` 140 · `--dur-base` 220 · `--dur-slow` 320; `--ease-out`, `--ease-spring`; `--press-scale` .97. Zeroed (press-scale 1) under `prefers-reduced-motion`. JS mirror: `DUR`. |
| Safe area | `--safe-top/-bottom/-left/-right` = `env(safe-area-inset-*, 0px)` (needs `viewport-fit=cover`) |

Palette tokens, per `:root[data-theme='light'|'sepia'|'dark']` (light is also the bare `:root`
default): `--paper`, `--paper-raised`, `--ink`, `--ink-soft`, `--ink-faint` (≥4.5:1 on paper),
`--line`, `--line-strong`, `--accent` (vermilion), `--accent-soft`, `--on-accent` (dark theme uses
near-black: white on its accent is 2.7:1), `--control-track`, `--control-active`, `--danger`,
`--scrim`, `--glass-edge`, plus `color-scheme`.

**Highlights are one colour:** `HIGHLIGHT_HEX` in `services/types.ts`, used by the reader overlay,
`SelectionToolbar`, `DictionaryPopup` and `AnnotationsPanel`. No colour picker.

**Theme resolution:** `applyTheme()` (internal to the settings store, run by `initSettings`/`updateSettings`) resolves `'auto'` against
`prefers-color-scheme` (live), sets `<html data-theme>`, publishes `appearance.resolved`, and
writes `--paper` into `<meta name="theme-color">`. An inline script in `index.html` sets
`data-theme` from the `tsuzuri:settings` localStorage mirror before first paint. The reader
re-injects the same vars into the book iframe (`appearanceCSS()` in `services/reader.ts`).

## 3. Base styles & primitives (`src/app.css`)

Base: `box-sizing: border-box`, no tap highlight; `html, body, #app` are
`height: var(--doc-height, 100dvh)` (`--doc-height` is published by `services/viewport.ts` for the
iOS cold-launch under-report; the fixed `.reader` overlay and `LoadingScreen` use `--app-height`),
`overflow: hidden`, `overscroll-behavior: none`. Buttons are reset, non-selectable (no iOS
long-press callout) and `touch-action: manipulation`. `:focus-visible` draws an accent outline.
Under reduced motion all CSS animation/transition durations collapse and loaders become static.

| Class | What |
| --- | --- |
| `.btn` | 44pt capsule text button, accent text. `.btn-primary` = filled accent; `.btn-tinted` = `--accent-soft` fill. Press scales by `--press-scale`; `:disabled` fades. |
| `.icon-btn` | 44pt circular icon button, `--ink-soft`; `.on` = accent; composes with `.btn-primary` and `.glass`. |
| `.glass` | The glass material (`--glass-bg` + backdrop blur + `--glass-shadow`). Override `background` with `--glass-bg-strong` for text-bearing glass. Never on anything visible during a page slide. |
| `.spinner` | The spinner; size via `--spinner-size` (24px). `.delayed` fades in after 0.4s. |
| `.progress-indeterminate` | Thin indeterminate bar (`LoadingScreen`, popup "Preparing"). |
| `.skeleton` | Pulsing placeholder block. |
| `.settings-stack` / `-section` / `-h` / `-row` / `-hint` | Shared section layout of both settings sheets. |

Global keyframes: `t-spin`, `t-fade-in`, `t-indeterminate`, `t-pulse`, `t-pop` (small rise + scale-in,
used by `SelectionToolbar` and the scrubber bubble).

## 4. Components

★ = `$bindable`.

| Component | Props | Notes |
| --- | --- | --- |
| `components/Sheet` | `open`★ (false), `title?`, `onclose?`, `children`, `maxHeight` ('85dvh'), `variant` ('sheet' \| 'popover'), `anchor?` | `sheet`: bottom sheet on phones, centred card ≥768px, dimming scrim. `popover`: clear scrim; on iPad a `--glass-bg-strong` popover hung under `anchor` (re-placed on resize), bottom sheet on phones. Closes on scrim, grip, × (32px disc, 44pt hit) and Escape. `role="dialog" aria-modal`; focus moves in and returns to the trigger. Motion: `sheetMotion`. |
| `components/Segmented` | `value`★, `options: {value, label?, icon?, count?, lang?, ariaLabel?}[]`, `onchange?`, `label?` | Capsule segmented control, 44pt options, `aria-pressed`, optional count badge. |
| `components/Icon` | `name`, `size` ('sm' 18 \| 'md' 22 \| 'lg' 48 \| px), `stroke` (2), `fill` (false) | 24×24 stroke paths: `plus minus gear bookmark list chevron-left chevron-down x trash search book highlighter copy aa`. `fill` solidifies the same path. `aria-hidden`. |
| `components/Toast` | `message`, `actionLabel?`, `onaction?`, `ondismiss?`, `lift` (false) | Glass pill, `role="status"`; `lift` clears the reader's bottom bar. |
| `components/ToastHost` | — | Mounted by `App`. App toasts win over the PWA "new version · Refresh" prompt and "Ready to read offline" (auto-dismiss 4s). |
| `components/LoadingScreen` | `title?`, `onback?` | Serif title over an indeterminate bar, fading in after 0.25s; used by `App` (reader chunk loading) and `Reader` (book opening). |
| `library/Shelf` | — | Header (Settings + Import `icon-btn`s), cover grid with progress rule and `NN%`/New/Finished, skeleton cards while importing, empty state. Long-press / right-click → book sheet (Read / Remove with Undo). Settings sheet lazy-loads `ShelfSettings`. |
| `library/BookCover` | `book` | Cover blob via object URL (revoked on cleanup) or a hue-from-id placeholder; 2:3. |
| `library/ShelfSettings` | — | Dictionary status/Download/Retry + progress, theme picker, About (storage, version, credits). |
| `reader/ReaderSettings` | `onchange(kind: 'appearance' \| 'layout' \| 'writingmode')` | Display panel: theme, typeface, size/line-spacing/margin steppers, writing direction, "Highlight looked-up words" switch (`role="switch"`). |
| `reader/TocSheet` | `toc`, `currentId?`, `currentLabel?`, `onnavigate(href)` | Flattened TOC; current chapter in accent, scrolled into view. |
| `reader/AnnotationsPanel` | `onnavigate(cfi)`, `onremove(a)`, `chapterOrder` ([]) | Highlights & Bookmarks tabs with counts; highlights grouped by chapter in TOC order; single words as serif headwords. |
| `reader/SelectionToolbar` | `open` (false), `rect`, `onHighlight?`, `onCopy?` | Glass capsule above a selection (`placeAnchored`). |
| `reader/ProgressScrubber` | `fraction` (0), `sectionLabel` (''), `labelAt?(frac)`, `onseek?(frac)` | Bottom-bar progress. Drag arms past 8px touch / 4px mouse and seeks on release; bubble shows the target chapter + %; a tap only flashes the thumb. `role="slider"`, arrow/Home/End keys. |
| `reader/DictionaryPopup` | `open`, `anchor`, `vertical`, `loading`, `needsDownload`, `result`, `highlighted`, `onclose`, `ondownload`, `ontogglehighlight` | Floating card (`--z-popup`) placed by `placeNearWord`; not a sheet. Owned by the reader. |

Utilities: `use:longpress` (`lib/actions/longpress.ts`; 450ms, cancels on >10px movement),
`debounce` (`lib/util/debounce.ts`, with `.cancel()`), `placeAnchored` / `placeNearWord`
(`lib/util/anchoredPosition.ts`; prefer above, flip below, clamp inside the safe area),
`inChromeToggleBand` (`lib/util/chromeBand.ts`; 12% of viewport height, clamped 80–160px),
`DUR` / `dur` / `sheetMotion` (`lib/util/motion.svelte.ts`).

## 5. Responsive rules

One breakpoint, `@media (min-width: 768px)`, CSS only (`sheetMotion` checks the same query).

| Surface | < 768px | ≥ 768px |
| --- | --- | --- |
| `Sheet` (`sheet`) | full-width bottom sheet with grip, rises from bottom | centred card `min(480px, 100vw − 96px)`, max-height `min(82dvh, 760px)`, no grip, scale + fade |
| `Sheet` (`popover`, Display) | bottom sheet, clear scrim | 360px glass popover under the Aa button |
| Shelf | covers `minmax(118px, 1fr)`, edge padding `--sp-5` | content max-width 1120px, covers `minmax(168px, 1fr)`, edge padding `--sp-10` |
| Reader bars | floating glass capsules, 48px | 52px; bottom capsule `min(680px, …)` wide, centred |

The reader bars must sit inside the chrome-toggle band so a blank tap there toggles them. Safe
areas: every full-bleed surface pads with `--safe-*`. Reading-area margins are computed in
`services/reader.ts`, not in component CSS.

## 6. Extending

- **Sheet:** `<Sheet bind:open={x} title="…">…</Sheet>`.
- **Toast:** `showToast({ message, action?: { label, run }, onexpire? })`; for undoable deletes hide
  now and commit in `onexpire`.
- **Icon:** add a 24×24 path to `PATHS` in `Icon.svelte`.
- **Theme:** add a `:root[data-theme='x']` block with every palette token; add it to the theme
  options in `ShelfSettings`/`ReaderSettings`, `PAPER` in the settings store, the inline script in
  `index.html`, and `ThemeName` in `services/types.ts`.
- **Setting:** see [development.md](development.md) §6.

Gotchas: centre elements that use Svelte `fly` with the `translate` property, not `transform`;
overriding `--glass-mix` in a component does not change `--glass-bg` (resolved on `:root`); revoke
every `URL.createObjectURL`.
