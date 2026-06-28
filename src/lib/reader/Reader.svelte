<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { fly, fade } from 'svelte/transition'
  import { openShelf } from '../../stores/nav.svelte'
  import { settings } from '../../stores/settings.svelte'
  import { getBookFile } from '../../services/library'
  import { getBookMeta, getProgress, putProgress } from '../../services/storage/db'
  import { ReaderController, type RelocateDetail, type TapInfo, type SelectionInfo, type TocItem } from '../../services/reader'
  import { extractTextAt, rangeForSpan, type CharPosition } from '../../services/jp/extract'
  import { lookupAt, warmupLookup, disposeLookup, type LookupResult } from '../../services/jp/lookupClient'
  import { isDictReady, downloadDictionary } from '../../services/jp/dictdb'
  import { dict } from '../../stores/dict.svelte'
  import {
    annotations,
    loadAnnotations,
    clearAnnotations,
    saveAnnotation,
    removeAnnotation,
    newId,
  } from '../../stores/annotations.svelte'
  import { debounce } from '../util/debounce'
  import type { BookMeta, Annotation } from '../../services/types'
  import Icon from '../components/Icon.svelte'
  import Sheet from '../components/Sheet.svelte'
  import ReaderSettings from './ReaderSettings.svelte'
  import TocSheet from './TocSheet.svelte'
  import DictionaryPopup from './DictionaryPopup.svelte'
  import SelectionToolbar from './SelectionToolbar.svelte'
  import ProgressScrubber from './ProgressScrubber.svelte'
  import AnnotationsPanel from './AnnotationsPanel.svelte'

  let { bookId }: { bookId: string } = $props()

  let host: HTMLDivElement
  let controller: ReaderController | null = null
  let bookFile: File | null = null
  let meta = $state<BookMeta | null>(null)

  let status = $state<'loading' | 'ready' | 'error'>('loading')
  let errorMsg = $state('')

  let chromeVisible = $state(true)
  let fraction = $state(0)
  let sectionLabel = $state('')
  let toc = $state<TocItem[]>([])

  let tocOpen = $state(false)
  let settingsOpen = $state(false)
  let annotationsOpen = $state(false)

  // Active text selection → highlight/copy toolbar.
  let sel = $state<{ open: boolean; rect: SelectionInfo['rect']; text: string; doc: Document | null; range: Range | null }>(
    { open: false, rect: { left: 0, top: 0, width: 0, height: 0 }, text: '', doc: null, range: null },
  )

  let currentCFI = $state('')
  const isBookmarked = $derived(
    annotations.items.some((a) => a.kind === 'bookmark' && a.cfi === currentCFI),
  )
  const hasHighlights = $derived(annotations.items.some((a) => a.kind === 'highlight'))

  // Dictionary popup state. Tapping a word looks it up *and* highlights it yellow
  // (a vocab record); the popup's footer toggles that highlight off/on.
  let dictState = $state<{
    open: boolean
    x: number
    y: number
    loading: boolean
    needsDownload: boolean
    result: LookupResult | null
    /** Pending query text (kept so a post-download retry can re-run the same lookup). */
    text: string
    tapOffset: number
    /** Stable per-lookup key; guards against a stale lookup landing in a newer popup. */
    lastKey: string
    /** CFI of this word's highlight (set once highlighted), '' if not yet highlighted. */
    cfi: string
    /** Whether this word is currently highlighted (drives the footer toggle). */
    highlighted: boolean
    /** The matched surface word, for re-saving when the highlight is toggled back on. */
    word: string
  }>({
    open: false, x: 0, y: 0, loading: false, needsDownload: false, result: null,
    text: '', tapOffset: 0, lastKey: '', cfi: '', highlighted: false, word: '',
  })

  // DOM context for the in-flight define, used to build the word's range after the
  // (async) lookup resolves. Plain refs, not $state — they hold live DOM nodes.
  let defineDoc: Document | null = null
  let definePositions: CharPosition[] = []

  // Only persist reading progress once the user has actually moved (a turn, swipe,
  // or TOC/annotation jump). This keeps the noisy relocations emitted while the
  // first layout settles — which can report a bogus fraction — from being saved and
  // restored on the next open.
  let userInteracted = false

  const saveProgress = debounce((d: RelocateDetail) => {
    void putProgress({
      bookId,
      cfi: d.cfi,
      fraction: d.fraction,
      label: d.tocItem?.label,
      updatedAt: Date.now(),
    })
  }, 600)

  function onRelocate(d: RelocateDetail) {
    fraction = d.fraction
    currentCFI = d.cfi
    if (d.tocItem?.label) sectionLabel = d.tocItem.label
    // Only persist once the reader has actually moved. The foliate-view `relocate`
    // event does not carry a `reason`, so we mark intent from the gesture/navigation
    // side (onTurn, navigate, navAnnotation) rather than sniffing the relocation.
    if (userInteracted) saveProgress(d)
  }

  // A user page-turn (swipe). The new page invalidates any popup/toolbar anchored to
  // the previous page, hides the chrome if it was up (so a swipe clears the bars the
  // same way a reading-area tap does), and means the current position is worth saving.
  function onTurn() {
    userInteracted = true
    chromeVisible = false
    closeOverlays()
  }

  /** Close every transient overlay (dict popup, selection toolbar). */
  function closeOverlays() {
    dictState.open = false
    sel.open = false
    // Release the content Document + Text-node refs held for auto-highlighting the last
    // tapped word. They're consumed synchronously inside runLookup/autoHighlight, so once
    // the popup is closed they're dead — clearing them lets a detached (navigated-away)
    // section's DOM be collected instead of being pinned until the next tap.
    defineDoc = null
    definePositions = []
  }

  // ── Selection → highlight / copy ──────────────────────────────────────────
  function onSelection(info: SelectionInfo) {
    sel = { open: true, rect: info.rect, text: info.text, doc: info.doc, range: info.range }
  }
  function onSelectionCleared() {
    sel.open = false
  }

  async function createHighlight() {
    if (!controller || !sel.doc || !sel.range) return
    const cfi = controller.cfiForSelection(sel.doc, sel.range)
    if (!cfi) return
    const anno: Annotation = {
      id: newId(),
      bookId,
      kind: 'highlight',
      cfi,
      text: sel.text.slice(0, 240),
      sectionLabel,
      createdAt: Date.now(),
    }
    await saveAnnotation(anno)
    await controller.addHighlight(cfi)
    controller.clearSelection()
    sel.open = false
  }

  async function copySelection() {
    if (sel.text) {
      try {
        await navigator.clipboard.writeText(sel.text)
      } catch {
        /* clipboard may be unavailable */
      }
    }
    controller?.clearSelection()
    sel.open = false
  }

  // ── Tapping an existing highlight → reopen its definition (with a remove option) ──
  function onShowAnnotation(value: string, range: Range) {
    // This tap was on a highlight — cancel the deferred tap-define action.
    if (pendingTap) {
      clearTimeout(pendingTap)
      pendingTap = undefined
    }
    const doc = range.startContainer.ownerDocument
    const frame = doc?.defaultView?.frameElement as HTMLElement | null
    const fr = frame?.getBoundingClientRect()
    const r = range.getBoundingClientRect()
    sel.open = false
    openDefine({
      text: range.toString(),
      tapOffset: 0,
      px: (fr?.left ?? 0) + r.left + r.width / 2,
      py: (fr?.top ?? 0) + r.top,
      existingCfi: value,
      word: range.toString(),
    })
  }

  /** Toggle the looked-up word's highlight from the popup footer. Keeps the card open. */
  async function toggleWordHighlight() {
    if (!controller || !dictState.cfi) return
    if (dictState.highlighted) {
      const existing = annotations.items.find((a) => a.kind === 'highlight' && a.cfi === dictState.cfi)
      if (existing) await removeAnnotation(existing.id)
      await controller.removeHighlight(dictState.cfi)
      dictState.highlighted = false
    } else {
      await saveAnnotation({
        id: newId(),
        bookId,
        kind: 'highlight',
        cfi: dictState.cfi,
        text: dictState.word.slice(0, 240),
        sectionLabel,
        createdAt: Date.now(),
      })
      await controller.addHighlight(dictState.cfi)
      dictState.highlighted = true
    }
  }

  // ── Bookmarks ─────────────────────────────────────────────────────────────
  async function toggleBookmark() {
    if (!controller) return
    const cfi = currentCFI || controller.lastCFI
    if (!cfi) return
    const existing = annotations.items.find((a) => a.kind === 'bookmark' && a.cfi === cfi)
    if (existing) {
      await removeAnnotation(existing.id)
    } else {
      await saveAnnotation({
        id: newId(),
        bookId,
        kind: 'bookmark',
        cfi,
        text: `${Math.round(fraction * 100)}%${sectionLabel ? ' · ' + sectionLabel : ''}`,
        sectionLabel,
        createdAt: Date.now(),
      })
    }
  }

  function navAnnotation(cfi: string) {
    annotationsOpen = false
    userInteracted = true
    // A corrupt/stale CFI (e.g. a section that no longer resolves) must not throw or
    // reject unhandled out of a tap — degrade to a logged no-op.
    try {
      const r = controller?.goTo(cfi) as unknown
      if (r && typeof (r as Promise<unknown>).catch === 'function') {
        ;(r as Promise<unknown>).catch((err) => console.warn('Could not navigate to annotation', err))
      }
    } catch (err) {
      console.warn('Could not navigate to annotation', err)
    }
  }

  // A tap and foliate's highlight hit-test (click) both fire on the same gesture.
  // When highlights exist, briefly defer the tap action so a highlight tap can
  // cancel it (and open the edit toolbar) instead of also turning the page/defining.
  // The window must outlast the click→show-annotation hop, which on touch can trail
  // the pointerup by several frames; 60ms is the documented, safer margin (the lookup
  // itself runs in a worker, so this delay is purely for race-resolution, not work).
  let pendingTap: number | undefined
  function onTap(info: TapInfo) {
    if (hasHighlights) {
      if (pendingTap) clearTimeout(pendingTap)
      pendingTap = window.setTimeout(() => {
        pendingTap = undefined
        handleTap(info)
      }, 60)
    } else {
      handleTap(info)
    }
  }

  function handleTap(info: TapInfo) {
    // A tap while the definition popup is open *only* dismisses it — anywhere on
    // screen, including the top/bottom nav-bar band. The popup takes priority over
    // both chrome-toggling and defining a new word, so a tap meant to clear the card
    // never also flashes the bars (and forgiving glyph hit-slack, not re-anchoring,
    // is what keeps tap-to-define reliable, so we don't re-look-up here either).
    if (dictState.open) {
      closeOverlays()
      return
    }
    // A tap in the top or bottom edge band (over the nav bars) toggles the chrome.
    // This is the way a tap *shows* the bars — a tap in the central reading area
    // never reveals them, so reading taps don't flash the chrome.
    if (inChromeToggleBand(info.py)) {
      chromeVisible = !chromeVisible
      return
    }
    // While the chrome is visible, a tap anywhere in the reading area dismisses it
    // (and is consumed — it doesn't also define) so the bars are easy to clear
    // without reaching for them, matching their own tap-to-hide behaviour.
    if (chromeVisible) {
      chromeVisible = false
      return
    }
    // Reading area, chrome hidden, no popup: look the tapped word up. Pagination is by
    // swipe — never by tap; the glyph hit-test in extractTextAt makes tryDefine return
    // false for blank space.
    if (settings.tapToDefine) tryDefine(info)
  }

  /**
   * Whether a tap (in top-window coords) landed in the top/bottom edge band that
   * toggles the chrome — sized to roughly cover the nav bars / their reveal zone.
   */
  function inChromeToggleBand(py: number): boolean {
    const vh = window.innerHeight
    const band = Math.min(160, Math.max(80, vh * 0.12))
    return py <= band || py >= vh - band
  }

  /**
   * Tapping a nav bar's own empty area hides the chrome. When the chrome is visible
   * the bars cover the top/bottom toggle bands, so this is how a top/bottom tap hides
   * them again (taps on the bars never reach the reader's gesture detector behind
   * them). Guarded so it doesn't fire when an actual control was tapped.
   */
  function dismissChromeFromBar(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('button')) return
    chromeVisible = false
  }

  /** Returns true if the tap landed on Japanese text and a lookup was started. */
  function tryDefine(info: TapInfo): boolean {
    if (!info.doc) return false
    const ex = extractTextAt(info.doc, info.ix, info.iy)
    if (!ex) return false
    openDefine({
      text: ex.text,
      tapOffset: ex.tapOffset,
      px: info.px,
      py: info.py,
      doc: info.doc,
      positions: ex.positions,
    })
    return true
  }

  /**
   * Open the dictionary popup for a word. For a fresh tap (`doc` + `positions`)
   * the matched word is auto-highlighted once the lookup resolves; for a tap on an
   * existing highlight (`existingCfi`) the popup just reopens with a remove option.
   */
  function openDefine(o: {
    text: string
    tapOffset: number
    px: number
    py: number
    doc?: Document | null
    positions?: CharPosition[]
    existingCfi?: string
    word?: string
  }) {
    const key = `${o.existingCfi ?? ''}:${o.tapOffset}:${o.text}`
    defineDoc = o.doc ?? null
    definePositions = o.positions ?? []
    dictState.open = true
    dictState.x = o.px
    dictState.y = o.py
    dictState.loading = true
    dictState.needsDownload = false
    dictState.result = null
    dictState.text = o.text
    dictState.tapOffset = o.tapOffset
    dictState.lastKey = key
    dictState.cfi = o.existingCfi ?? ''
    dictState.word = o.word ?? ''
    dictState.highlighted = !!o.existingCfi
    void runLookup(o.text, o.tapOffset, key)
  }

  async function runLookup(text: string, tapOffset: number, key: string) {
    if (!(await isDictReady())) {
      if (!dictState.open || dictState.lastKey !== key) return
      dictState.loading = false
      dictState.needsDownload = true
      return
    }
    const res = await lookupAt(text, tapOffset)
    // Ignore if the popup was dismissed or a newer tap superseded this lookup.
    if (!dictState.open || dictState.lastKey !== key) return
    dictState.loading = false
    dictState.result = res
    // Auto-highlight the matched word — but only a real match, only a fresh tap
    // that isn't already highlighted, and not on a download/no-match miss.
    if (res && res.entries.length && !dictState.cfi && defineDoc && definePositions.length) {
      void autoHighlight(res, key)
    }
  }

  /** Highlight the matched word yellow and persist it as a vocab annotation. */
  async function autoHighlight(res: LookupResult, key: string) {
    if (!controller || !defineDoc) return
    const range = rangeForSpan(defineDoc, definePositions, res.matchStart, res.matchStart + res.matchLength)
    if (!range) return
    const cfi = controller.cfiForSelection(defineDoc, range)
    if (!cfi) return
    // Bail if a newer lookup superseded this one while we built the range/CFI.
    if (!dictState.open || dictState.lastKey !== key) return
    const word = range.toString()
    if (!annotations.items.some((a) => a.kind === 'highlight' && a.cfi === cfi)) {
      await saveAnnotation({
        id: newId(),
        bookId,
        kind: 'highlight',
        cfi,
        text: word.slice(0, 240),
        sectionLabel,
        createdAt: Date.now(),
      })
      await controller.addHighlight(cfi)
    }
    dictState.cfi = cfi
    dictState.word = word
    dictState.highlighted = true
  }

  async function downloadDict() {
    try {
      await downloadDictionary('en')
      // Build kuromoji now (while online) so the service worker runtime-caches the
      // ~19 MB IPADIC dict files; otherwise the first offline tap would fail to fetch
      // them and silently fall back to degraded segmentation. Await it so the dict is
      // actually cached (and the segmenter ready) before we run the pending lookup.
      dict.warming = true
      try {
        await warmupLookup()
      } finally {
        dict.warming = false
      }
      dictState.needsDownload = false
      dictState.loading = true
      await runLookup(dictState.text, dictState.tapOffset, dictState.lastKey)
    } catch {
      /* error surfaced via the dict store */
    }
  }

  function navigate(href: string) {
    tocOpen = false
    userInteracted = true
    controller?.goTo(href)
  }

  /** Fast-scroll via the progress scrubber: jump to an overall-book fraction. */
  function seek(frac: number) {
    if (!controller) return
    userInteracted = true
    closeOverlays()
    void controller.goToFraction(frac)
  }

  function onSettingChange(kind: 'appearance' | 'layout' | 'writingmode') {
    if (!controller) return
    if (kind === 'appearance') controller.applyAppearance(settings)
    else if (kind === 'layout') controller.applyLayout(settings)
    else if (kind === 'writingmode' && bookFile) void controller.reopenForWritingMode(bookFile)
  }

  // While a book is open, shed the lookup worker (and the ~tens-of-MB resident kuromoji
  // trie it holds) whenever the PWA is backgrounded. iOS aggressively reclaims memory
  // from hidden web content; holding that trie resident across a backgrounding raises the
  // odds the whole tab is killed — losing the reading position — rather than just the
  // worker. On return to the foreground re-warm from the SW-cached dict (no network) so
  // the first tap-to-define is still fast. The worker is a lazy singleton, so the
  // dispose→rebuild cycle is cheap and self-contained.
  function onVisibility() {
    if (document.hidden) {
      disposeLookup()
    } else if (settings.tapToDefine) {
      void isDictReady().then((ok) => {
        if (ok) void warmupLookup()
      })
    }
  }

  onMount(async () => {
    try {
      const [m, file, progress] = await Promise.all([
        getBookMeta(bookId),
        getBookFile(bookId),
        getProgress(bookId),
      ])
      // A meta row with no bytes means the OPFS/IDB blob was evicted (e.g. WebKit's
      // 7-day eviction of a non-installed PWA) — tell the user to re-import rather than
      // showing a cryptic "not found".
      if (!file)
        throw new Error(
          m
            ? 'This book’s file is no longer on this device — its data may have been cleared. Please re-import the EPUB.'
            : 'Book file not found in storage.',
        )
      meta = m ?? null
      bookFile = file
      // Seed the displayed progress from the saved position so the bar is correct
      // before the first relocate (and stays correct for a restored book).
      if (progress) {
        fraction = progress.fraction ?? 0
        currentCFI = progress.cfi ?? ''
        if (progress.label) sectionLabel = progress.label
      }
      controller = new ReaderController(host, settings, {
        onRelocate,
        onTap,
        onTurn,
        onSelection,
        onSelectionCleared,
        onShowAnnotation,
      })
      await controller.open(file, progress?.cfi)
      toc = controller.view.book?.toc ?? []

      // Load annotations and seed the highlight overlays.
      await loadAnnotations(bookId)
      controller.setHighlights(annotations.items.filter((a) => a.kind === 'highlight').map((a) => a.cfi))
      status = 'ready'

      // Shed / re-warm the lookup worker as the PWA is backgrounded / foregrounded
      // (see onVisibility) so its resident trie isn't pinned while another app is in use.
      document.addEventListener('visibilitychange', onVisibility)

      // If the dictionary is already downloaded, warm the lookup worker (and its
      // kuromoji build) now so the first tap-to-define is fast rather than paying
      // the ~19 MB trie build on the tap itself.
      if (settings.tapToDefine) {
        void isDictReady().then((ok) => {
          if (ok) void warmupLookup()
        })
      }
    } catch (err) {
      console.error(err)
      errorMsg = err instanceof Error ? err.message : 'Could not open this book.'
      status = 'error'
    }
  })

  onDestroy(() => {
    if (pendingTap) clearTimeout(pendingTap)
    document.removeEventListener('visibilitychange', onVisibility)
    saveProgress.cancel()
    controller?.destroy()
    // Free the worker's resident kuromoji trie while no book is open (re-warmed on
    // the next open from the SW-cached dict — no network).
    disposeLookup()
    clearAnnotations()
    // Drop any retained content Document / Text-node refs so the closed book's last
    // section can't be pinned past unmount.
    defineDoc = null
    definePositions = []
  })
</script>

<div class="reader" class:chrome={chromeVisible}>
  <div class="view-host" bind:this={host}></div>

  {#if status === 'loading'}
    <div class="overlay"><div class="spinner"></div></div>
  {:else if status === 'error'}
    <div class="overlay error">
      <p>{errorMsg}</p>
      <button class="back-cta" onclick={openShelf}>← Back to library</button>
    </div>
  {/if}

  {#if status === 'ready' && chromeVisible}
    <header class="bar top" role="presentation" onclick={dismissChromeFromBar} transition:fly={{ y: -20, duration: 200 }}>
      <button class="cbtn" onclick={openShelf} aria-label="Library">
        <Icon name="arrow-left" size={22} />
      </button>
      <div class="title" lang="ja">{meta?.title ?? ''}</div>
      <button class="cbtn" onclick={() => (annotationsOpen = true)} aria-label="Highlights & bookmarks">
        <Icon name="note" size={21} />
      </button>
      <button class="cbtn" onclick={() => (settingsOpen = true)} aria-label="Display settings">
        <Icon name="aa" size={22} />
      </button>
    </header>

    <footer class="bar bottom" role="presentation" onclick={dismissChromeFromBar} transition:fly={{ y: 20, duration: 200 }}>
      <button class="cbtn" onclick={() => (tocOpen = true)} aria-label="Contents">
        <Icon name="list" size={22} />
      </button>
      <div class="progress">
        <ProgressScrubber {fraction} {sectionLabel} onseek={seek} />
      </div>
      <button
        class="cbtn"
        class:on={isBookmarked}
        onclick={toggleBookmark}
        aria-label={isBookmarked ? 'Remove bookmark' : 'Add bookmark'}
      >
        <Icon name="bookmark" size={22} fill={isBookmarked} />
      </button>
    </footer>
  {/if}

  <!-- Persistent reading-position readout at the bottom centre, shown while the
       chrome is hidden (the bottom bar carries its own progress when visible).
       pointer-events:none so it never intercepts taps/swipes. -->
  {#if status === 'ready' && !chromeVisible}
    <div class="page-pct" aria-hidden="true" transition:fade={{ duration: 150 }}>
      {Math.round(fraction * 100)}%
    </div>
  {/if}
</div>

<Sheet bind:open={tocOpen} title="Contents">
  <TocSheet {toc} currentLabel={sectionLabel} onnavigate={navigate} />
</Sheet>

<Sheet bind:open={settingsOpen} title="Display">
  <ReaderSettings onchange={onSettingChange} />
</Sheet>

<Sheet bind:open={annotationsOpen} title="Notes">
  <AnnotationsPanel onnavigate={navAnnotation} />
</Sheet>

<DictionaryPopup
  bind:open={dictState.open}
  x={dictState.x}
  y={dictState.y}
  loading={dictState.loading}
  needsDownload={dictState.needsDownload}
  result={dictState.result}
  highlighted={dictState.highlighted}
  ondownload={downloadDict}
  ontogglehighlight={toggleWordHighlight}
/>

<!-- Toolbar for a fresh text selection (highlight yellow / copy) -->
<SelectionToolbar
  open={sel.open}
  rect={sel.rect}
  onHighlight={createHighlight}
  onCopy={copySelection}
/>

<style>
  .reader {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    /* Size to the real (visual) viewport, not `inset: 0` — on a cold iOS PWA launch
       the fixed containing block is briefly too short, which left the bottom bar
       sitting above the screen edge until a rotation. --app-height (from the visual
       viewport) tracks the true screen; 100dvh is the pre-JS fallback.
       Only this *fixed* (out-of-flow) overlay consumes --app-height: applying it to
       in-flow elements (html/body/#app) changed the document layout, which made iOS
       re-report a different visualViewport height → a resize→rewrite feedback loop
       that oscillated the bar between the gapped and pinned positions. A fixed element
       can't feed back into the layout viewport. */
    height: var(--app-height, 100dvh);
    background: var(--paper);
    overflow: hidden;
  }
  .view-host {
    position: absolute;
    inset: 0;
    /* keep text clear of the notch / home indicator even when chrome is hidden */
    padding: var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left);
    box-sizing: border-box;
  }

  .bar {
    position: absolute;
    left: 0;
    right: 0;
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 8px;
    background: color-mix(in srgb, var(--paper-raised) 86%, transparent);
    backdrop-filter: blur(18px) saturate(1.2);
    -webkit-backdrop-filter: blur(18px) saturate(1.2);
  }
  .bar.top {
    top: 0;
    padding-top: calc(var(--safe-top) + 8px);
    border-bottom: 1px solid var(--line);
  }
  .bar.bottom {
    bottom: 0;
    /* Just enough bottom padding to clear the home indicator — no extra, so the
       control row hugs the bottom instead of floating with a translucent strip
       (read as a "gap") beneath it. The bar background still fills to the edge. */
    padding-bottom: max(var(--safe-bottom), 10px);
    border-top: 1px solid var(--line);
  }
  .cbtn {
    flex: none;
    width: 44px;
    height: 44px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--ink-soft);
  }
  .cbtn:active {
    background: var(--accent-soft);
  }
  .cbtn:disabled {
    opacity: 0.35;
  }
  .cbtn.on {
    color: var(--accent);
  }
  .title {
    flex: 1;
    text-align: center;
    font-size: 15px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .progress {
    flex: 1;
    min-width: 0;
    display: flex;
  }

  /* Standalone reading-% readout, centred at the very bottom of the screen. */
  .page-pct {
    position: absolute;
    left: 50%;
    bottom: calc(var(--safe-bottom) + 8px);
    transform: translateX(-50%);
    z-index: 15;
    pointer-events: none;
    padding: 2px 9px;
    border-radius: 999px;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.03em;
    color: var(--ink-faint);
    background: color-mix(in srgb, var(--paper-raised) 70%, transparent);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }

  /* iPad / wide screens: don't stretch the bar controls edge-to-edge. */
  @media (min-width: 768px) {
    .bar {
      padding-left: max(var(--safe-left), 26px);
      padding-right: max(var(--safe-right), 26px);
    }
    .bar.top {
      padding-top: calc(var(--safe-top) + 12px);
      padding-bottom: 12px;
    }
    .progress {
      flex: 0 1 580px;
      margin-inline: auto;
    }
    .title {
      font-size: 16px;
    }
  }

  .overlay {
    position: absolute;
    inset: 0;
    z-index: 30;
    display: grid;
    place-items: center;
    gap: 16px;
    background: var(--paper);
    color: var(--ink-soft);
    text-align: center;
    padding: 24px;
  }
  .spinner {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    border: 3px solid var(--line-strong);
    border-top-color: var(--accent);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .back-cta {
    color: var(--accent);
    font-weight: 600;
  }
</style>
