# CLAUDE.md — Tsuzuri (綴)

A **paginated EPUB reader for Japanese books**, built as an **installable iOS PWA**
(Add to Home Screen, Safari, iOS 26+, iPhone + iPad — primarily **iPad in
landscape**). Reads on-device EPUBs offline, paginated like Apple Books, with
vertical 縦書き support, integrated **10ten-style tap-to-define**, **highlights**
and **bookmarks**. A horizontal **swipe** turns the page (always horizontal, in
the correct direction for every writing mode); a **tap** on a Japanese word
defines it — and highlights it yellow as a vocab record. **A glyph tap always wins:**
it defines even inside the top/bottom nav-bar edge band and even while a definition
popup is open (the card re-targets to the new word, so word-after-word costs one tap
each). A tap that lands on **blank** paper is what drives the chrome: in the edge band
it toggles the bars, otherwise it dismisses an open popup or hides visible bars, and a
blank-**centre** tap with nothing open does nothing (there are no tap edge-rails).
Tapping a highlighted word reopens its definition with a remove option; the bottom
progress bar is a **drag-to-scrub** control. Highlights are always yellow (no colour
picker); the **Highlights & Bookmarks** panel groups them by chapter, and deletions (books,
highlights, bookmarks) are undoable from a toast. On iPad the **Display** settings open as
a glass popover under the Aa button so text changes are judged live. Fully client-side; **deployed to GitHub Pages** at
https://huangwaylon.github.io/epub/ (see [docs/deployment.md](docs/deployment.md)).

> This file is the orientation map. **Depth lives in [`docs/`](docs/); task
> procedures live in [`.claude/skills/`](.claude/skills/).** Read the relevant
> subsystem doc before changing that subsystem.

## Stack
Svelte 5 (runes) · TypeScript · Vite + `vite-plugin-pwa`. Rendering by
**foliate-js** (vendored, MIT, in `src/vendor/foliate-js`). Japanese dictionary by
the **10ten** ecosystem: `@birchill/jpdict-idb` + `@birchill/normal-jp` (npm) and a
**vendored, GPL-3.0** deinflection engine (`src/services/jp/deinflect.ts`). Word
**segmentation** by **kuromoji** (`@sglkc/kuromoji`, MeCab-style IPADIC; Apache-2.0).
Storage: **OPFS** (EPUB bytes) + **IndexedDB** via `idb` (everything structured).
The app is **backend-free** — the offline dictionary is the only language feature.
Four runtime deps: jpdict-idb, normal-jp, kuromoji, idb (the IPADIC dict is gunzipped
with the native `DecompressionStream`; fflate is dev-only, for the test-book script).

## Architecture (layers, strict downward deps)
```
UI (src/lib/**, Svelte)  →  stores (src/stores/*.svelte.ts, rune singletons)
                         →  services (src/services/**, framework-agnostic)
                         →  vendored engines (src/vendor/foliate-js)
```
- **Entry:** `src/main.ts` mounts **without awaiting IndexedDB** — an inline script in `index.html` sets `data-theme` from a localStorage mirror of the settings (`tsuzuri:settings`) before first paint, then `initSettings` hydrates from IDB (the source of truth). `initViewport`, `requestPersistence`, `registerSW` (update check on return to foreground, ≤ hourly) → `src/App.svelte` routes between **Shelf** and **Reader** via the `nav` store; the route is persisted to sessionStorage so an update-reload reopens the book. Theme defaults to **`'auto'`** (follows the system; `appearance.resolved` is the resolved light/sepia/dark).
- **Lazy loading:** the Shelf's critical path has no foliate — `library.ts` imports `view.js` on demand and the Reader chunk is loaded via a retryable `loadReader()` (warmed ~1.5 s after mount and on cover press); the reader prefetches foliate's zip/epub/paginator chunks at mount so book open isn't a serial chunk waterfall.
- **Reader core:** a single `ReaderController` (`src/services/reader.ts`) owns the `<foliate-view>` element; `src/lib/reader/Reader.svelte` wires it to the UI.
- **Full map & data flows:** **[docs/architecture.md](docs/architecture.md)**.

## Where things are
| Area | Code | Doc |
|---|---|---|
| System map, data flows, stores | `src/stores`, `src/main.ts`, `src/App.svelte` | [architecture.md](docs/architecture.md) |
| Reader / foliate / pagination / taps / highlights | `src/services/reader.ts`, `src/lib/reader/*`, `src/vendor/foliate-js` | [reader-engine.md](docs/reader-engine.md) |
| Dictionary, deinflection, lookup, word extraction | `src/services/jp/*` | [japanese.md](docs/japanese.md) |
| Storage, data model, PWA, iOS constraints | `src/services/storage/*`, `src/services/types.ts`, `vite.config.ts`, `index.html` | [storage-pwa-ios.md](docs/storage-pwa-ios.md) |
| Svelte conventions, design tokens (spacing/type/radii/glass/motion — §2), components, responsive/iPad | `src/app.css`, `src/lib/components/*`, `src/stores/settings.svelte.ts` | [ui-and-design.md](docs/ui-and-design.md) |
| Deployment / CI / GitHub Pages / base path | `.github/workflows/deploy.yml`, `vite.config.ts` (`base`) | [deployment.md](docs/deployment.md) |
| Setup, scripts, workflows, verification, worked examples | `package.json`, `scripts/*` | [development.md](docs/development.md) |

## Run & verify
```sh
npm install
npm run dev      # Vite, also exposed on the LAN for on-device testing
npm run check    # svelte-check + tsc   (run after edits)
npm test         # vitest (deinflection, glyph resolution/extraction, lookup pipeline, worker client)
npm run build    # production build → dist/
```
- **Test book:** `node scripts/make-test-epub.mjs` → `test-books/tsuki-to-neko.epub` (vertical 縦書き JP EPUB with ruby + conjugated verbs, multi-page).
- **Verify in a browser** with the **chrome-devtools MCP at iPad-landscape (1194×834)**: new page → resize → import the test EPUB (upload to the "Import book" button) → open → download the dictionary in Settings → check vertical RTL pagination, swipe-to-turn (a horizontal swipe turns the page both directions, always animating as a horizontal slide), tap-to-define (tap a Japanese word defines **and highlights it yellow** — including on the first/last glyph of a column, which the nav-bar band overlaps, and including while a card is open, which just re-targets to the new word; tapping a highlight reopens its definition with a **Remove highlight** option and must show the word **without** furigana; a tap on **blank** paper in the top/bottom band toggles chrome, elsewhere it dismisses the card or hides the bars, and a blank-centre tap with nothing open does nothing — no tap edge-rails), drag-select → highlight (yellow) / copy, the **drag-to-scrub** bottom progress bar, bookmark. Console should show only the benign foliate iframe `allow-scripts and allow-same-origin` sandbox warning. Full recipe, plus the DEV `window.__tsuzuri` tap-accuracy harness and on-device (HTTPS tunnel + Add to Home Screen), in [development.md](docs/development.md). The **`/prs`** and **`tsuzuri-verify`** skills also cover this.
- **Base path:** the dev server runs at `/`; the production build uses the `/epub/` base and deploys to GitHub Pages on push to `main` — see [deployment.md](docs/deployment.md).

## Conventions
- **Svelte 5 runes.** Stores are `*.svelte.ts` modules exporting a module-level `$state` object; mutate via exported functions (e.g. `updateSettings`). Components read `store.x` directly.
- **Services are framework-agnostic** — no Svelte imports in `src/services/**`.
- Components own **scoped styles**; theme is **CSS custom properties** on `<html data-theme>` (see `src/app.css`), and the reader re-injects those same vars into the content iframe.
- Put **`lang="ja"`** on Japanese text; give icon-only buttons an `aria-label`; pad with `env(safe-area-inset-*)`.
- Match the surrounding code style. After changes, run `npm run check`.

## Critical gotchas & constraints (read before editing)
- **GPL-3.0:** the vendored `src/services/jp/deinflect.ts` makes the whole app GPL-3.0-or-later (license: `src/services/jp/LICENSE-10ten`). To relicense, reimplement deinflection.
- **kuromoji segmentation:** tap-to-define segments with **kuromoji** (`@sglkc/kuromoji`, MeCab/IPADIC), then looks up JMdict. The whole pipeline runs in a **Web Worker** (`lookup.worker.ts` ↔ `lookupClient.ts`) so it never janks a page-turn — only the DOM parts (`extractTextAt`/`rangeForSpan`) stay on the main thread. The worker is a lazy singleton: warmed at reader mount (and re-created on resume if `pingLookup()` gets no answer), shed only after the app has stayed backgrounded **60 s** (`LOOKUP_IDLE_DISPOSE_MS`; disposing on every hide meant taps during the rebuild silently fell back to greedy segmentation, i.e. the wrong word), disposed on reader exit, non-latching on transient errors. A tap gives an in-flight build a bounded **1.2 s** wait (`settleSegmenter`) rather than answering greedily, and `lookupClient` keeps a small main-thread cache of **ready-derived** results so it survives the worker. Its IPADIC dict — **11 `*.dat.gz`, ~11.3 MB compressed / ~27 MB inflated / ≈33 MB resident** (was 12 files, 19 MB / ~175 MB resident) — is staged to `public/kuromoji/dict/` by `scripts/copy-kuromoji-dict.mjs` (`predev`/`prebuild`; gitignored), which **trims the zero padding** of `tid`/`unk*` to their structural length and **drops `tid_pos`** entirely: segmentation reads token boundaries straight off the lattice/Viterbi path (`segment.ts`), never `tokenize()`'s POS features — a golden test (`segment.golden.test.ts`) pins boundaries to stock kuromoji. The defensive loader (`kuromojiLoader.cjs`, aliased in `vite.config.ts`) inflates with `DecompressionStream`, tolerates servers that auto-decompress, answers `tid_pos` with an empty buffer and replaces kuromoji's 325k-key target map with flat `Int32Array`s. The dict is SW-runtime-cached in **`kuromoji-ipadic-v2`** with **no `expiration` at all** (not even `maxEntries` — a partial shard set builds no trie); the shelf download calls **`cacheIpadic()`** (Cache API pre-fill, no trie build) and the reader download also warms. `main.ts` deletes the obsolete `kuromoji-ipadic` cache. The popup's download state comes from `dictPhase()`. Depth: [japanese.md](docs/japanese.md).
- **Tap accuracy is geometry, not the caret.** `caretRangeFromPoint`/`caretPositionFromPoint` return the nearest caret *boundary* and advance to the **next** character past each glyph's mid-advance, so trusting their offset mis-resolved the far ~40% of every glyph (~35% wrong word, plus dead taps at a text-node end). `extract.ts` uses the caret only as a **seed** and then picks the character whose measured box actually contains the point (`resolveGlyph`/`charRect`/`hitDistance`; `pointOnGlyph` is gone), and a tap on furigana is redirected to the ruby **base** (`rubyBaseHit`). Don't reintroduce caret-offset trust, and don't `range.toString()` a word that may carry ruby (the `<rt>` gets spliced in: 決けっ心). Depth: [japanese.md](docs/japanese.md) §6.
- **Don't edit `src/vendor/foliate-js/**`** except as a deliberate, documented patch. Four exist: (1) `view.js` removed `pdf.js` and the PDF branch (`isPDF` remains as harmless dead code); (2) `paginator.js` disables foliate's **own touch page-turn** so our horizontal swipe detector (`#trackGestures` in `reader.ts`) drives pagination — `#onTouchMove` keeps `e.preventDefault()` but drops `scrollBy`, `#onTouchEnd` drops the velocity `snap()`; (3) `paginator.js` `#turnPage` now waits its trailing `100 ms` **only when the turn crossed into a new section** — upstream also waited whenever `animated` is absent, which is our permanent state, so every turn paid 100 ms of blank paper (`view.next()` 106 ms → 5 ms measured; rapid turns are coalesced app-side). (3′) since amended: `#turnPage` resolves **immediately** and, after a section crossing, releases its lock on a 100 ms timer instead of awaiting it; (4) `paginator.js` `View#render` skips while the iframe is between documents (a resize during a section swap or teardown threw `el is null`). All are marked `TSUZURI PATCH`. We leave `animated` **off** and slide page turns horizontally ourselves (foliate's own turn slides vertically for 縦書き); see [reader-engine.md](docs/reader-engine.md) §1/§8a. Content renders in a **closed-shadow-DOM iframe**; reach it only via foliate's `load` event `doc` (or, in DEV, the `window.__tsuzuri` hook used by the tap-accuracy harness).
- **Vertical (縦書き) column-fill quirk:** foliate can under-measure vertical column height on first paint (dead space at the bottom). Fixed by deriving the vertical caps from the live viewport in `applyLayout`, which is also **idempotent** — it skips redundant renders, killing a rotation-flicker loop; `#nudgeLayout` + the resize listeners are hedges. `#expectVertical()` also pre-sets the writing mode before `view.init` (the `load` handler corrects a wrong guess, reading `body` like foliate), saving a wasted first render. See [reader-engine.md](docs/reader-engine.md) §11.
- **縦書き books that declare it only in metadata:** calibre-converted novels ship `<meta name="primary-writing-mode" content="vertical-rl">` + `class="vrtl"` on each section root but **no `writing-mode` CSS**, and foliate reads only `rendition:*` metadata — so on `writingMode: 'auto'` they rendered 横書き. `#applyIntendedWritingMode` prepends `html{writing-mode:vertical-rl}` when it sees that explicit `vrtl` marker, before the first paint. Only that marker counts (guessing from `lang` or an rtl spine would break genuinely-horizontal RTL-bound books). See [reader-engine.md](docs/reader-engine.md) §6b.
- **iOS viewport / `--app-height`:** a cold standalone launch under-reports `100dvh` / `inset:0`, leaving a gap below the bottom bar until rotation. `src/services/viewport.ts` (`initViewport`) publishes the reliable visual-viewport height as `--app-height`, which **only the fixed `.reader` overlay** consumes — applying it to in-flow `html`/`body` fed back into the viewport and oscillated the bar. See [storage-pwa-ios.md](docs/storage-pwa-ios.md).
- **iOS specifics:** EPUB import is `<input type="file">`-only (no Share Target / file handlers); OPFS for blobs (IndexedDB fallback); installed PWAs are exempt from the 7-day storage eviction. Details in [storage-pwa-ios.md](docs/storage-pwa-ios.md).
- **Highlight volume is a perf constraint** (tap-to-define highlights *every* looked-up word, and each draw parses a CFI, re-anchors a Range and measures client rects): `reapplyHighlights` paints **24 per task** in `nearestFirst` order (`src/services/cfi.ts`: parse each CFI once, sort in document order, binary-search `lastCFI`, draw outward — the old `Math.abs(compare())` "sort" was a no-op), highlights are seeded **before** `open()` so only the opening section draws at open, with a generation counter that abandons a superseded sweep; the `annotations` store is an immutable `$state.raw` array with rebuilt lookup maps (`isHighlighted(cfi)`), all create/remove paths go through one `addHighlight`/`removeHighlight` pair in `Reader.svelte` (paint first, persist in the background, dedupe on CFI), and a bookmark counts as "on this page" when it falls within the visible page's CFI range. Each content document's listeners also live on their own `AbortController` (`#docACs`), since the paginator swaps in a fresh document per section. See [reader-engine.md](docs/reader-engine.md) §8/§10.
- **Taps are a hot path — never add latency or a guard that can swallow one.** `TAP_MAX_MS` is **700 ms** (an aimed tap at a 16px glyph, and the careful retry after a miss, routinely exceeded 400 ms), `pointermove`/`pointerup`/`pointercancel` all ignore **non-primary** pointers (a second contact on the glass used to be measured against the first finger's down point and killed the tap), `shouldIgnoreUp` bails only when the press landed *inside* the live selection's rects (WebKit collapses a selection only *after* our `pointerup`), and `touch-action: manipulation` is set on `.reader` and the injected content `body` (a stray double-tap zoom disables every tap **and** swipe until pinched back out). The old 60 ms `pendingTap` defer is gone — `show-annotation` simply stands down behind a just-completed tap (`tapDefinedAt`). A quick one-finger **touch** swipe turns the page as soon as it crosses the threshold (its lift is then ignored); mouse drag-select and selection handles are unaffected. ←/→, Space/Shift-Space turn pages and Esc closes the card/chrome; a swipe at the first/last page bounces. See [reader-engine.md](docs/reader-engine.md) §8.
- **On-device iOS status — partially verified.**
  **Measured on real iOS** (iPad Safari, iOS 26.5, 2026-06-28): EPUB import (the `<input
  type=file>` picker), pagination + vertical 縦書き RTL + furigana, the horizontal-swipe page
  turn (both directions), the nav-bar edge-band chrome toggle, **tap-to-define** (the caret
  APIs *do* resolve in the vertical-rl closed-shadow iframe — the earlier doubt was
  unfounded; a defensive `try/catch` wraps both in `extract.ts`), tap-a-word → yellow
  highlight → **Notes** panel (now "Highlights & Bookmarks"), bookmarks, and reading-position persistence across relaunch.
  **Measured in desktop Chrome only (2026-08-08):** the glyph-resolution fix and the
  page-turn latency patch above. Both are engine-independent in principle, but **inferred,
  not verified, on iOS** — WebKit has open bugs in vertical-writing caret hit-testing
  (webkit.org/b/283620, /287007, /263988; iOS layout-test baselines even expect *no* caret
  for a tap inside a fragmented inline box in `vertical-rl`), and the geometry still takes
  its *seed* from those APIs. **Still unconfirmed on real iOS:** the 2026-09 perf pass (lean kuromoji memory, swipe-on-move, `DecompressionStream` in the worker, dark-variant splash screens), that fix, the vertical
  column-fill in **landscape** (portrait shows a residual bottom dead band — a known open
  issue, deferred pending in-iframe measurement), `--app-height` cold-launch durability, and
  Add-to-Home-Screen storage durability.

## Skills (task procedures, in `.claude/skills/`)
- **tsuzuri-reader** — changing the reader / foliate integration (pagination, vertical text, taps, selection, highlights/CFI, reading margins).
- **tsuzuri-japanese** — the dictionary / deinflection / lookup / word-extraction pipeline.
- **tsuzuri-verify** — run and visually verify the app (test EPUB + chrome-devtools at iPad-landscape; on-device).
