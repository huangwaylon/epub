<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { fly } from 'svelte/transition'
  import { openShelf } from '../../stores/nav.svelte'
  import { settings } from '../../stores/settings.svelte'
  import { getBookFile } from '../../services/library'
  import { getBookMeta, getProgress, putProgress } from '../../services/storage/db'
  import { ReaderController, type RelocateDetail, type TapInfo, type SelectionInfo, type TocItem } from '../../services/reader'
  import { extractTextAt, looksJapanese } from '../../services/jp/extract'
  import { lookup, type LookupResult } from '../../services/jp/lookup'
  import { isDictReady, downloadDictionary } from '../../services/jp/dictdb'
  import {
    annotations,
    loadAnnotations,
    clearAnnotations,
    saveAnnotation,
    removeAnnotation,
    newId,
  } from '../../stores/annotations.svelte'
  import { debounce } from '../util/debounce'
  import { HIGHLIGHT_HEX, type BookMeta, type HighlightColor, type Annotation } from '../../services/types'
  import Icon from '../components/Icon.svelte'
  import Sheet from '../components/Sheet.svelte'
  import ReaderSettings from './ReaderSettings.svelte'
  import TocSheet from './TocSheet.svelte'
  import DictionaryPopup from './DictionaryPopup.svelte'
  import SelectionToolbar from './SelectionToolbar.svelte'
  import AnnotationsPanel from './AnnotationsPanel.svelte'
  import TranslationSheet from './TranslationSheet.svelte'

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

  // Active text selection → highlight/translate toolbar.
  let sel = $state<{ open: boolean; rect: SelectionInfo['rect']; text: string; doc: Document | null; range: Range | null }>(
    { open: false, rect: { left: 0, top: 0, width: 0, height: 0 }, text: '', doc: null, range: null },
  )
  // Tapping an existing highlight → edit toolbar (recolor / delete).
  let hlEdit = $state<{ open: boolean; rect: SelectionInfo['rect']; cfi: string; color?: HighlightColor }>(
    { open: false, rect: { left: 0, top: 0, width: 0, height: 0 }, cfi: '' },
  )

  // Translation sheet (wired fully in the translation milestone).
  let translateText = $state('')
  let translateOpen = $state(false)

  let currentCFI = $state('')
  const isBookmarked = $derived(
    annotations.items.some((a) => a.kind === 'bookmark' && a.cfi === currentCFI),
  )
  const hasHighlights = $derived(annotations.items.some((a) => a.kind === 'highlight'))

  // Dictionary popup state.
  let dictState = $state<{
    open: boolean
    x: number
    y: number
    loading: boolean
    needsDownload: boolean
    result: LookupResult | null
    lastText: string
  }>({ open: false, x: 0, y: 0, loading: false, needsDownload: false, result: null, lastText: '' })

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
    // A real page turn (vs. a startup/programmatic relocation) invalidates any open
    // popup or toolbar anchored to the previous page — close them.
    if (d.reason === 'page' || d.reason === 'snap' || d.reason === 'scroll') {
      userInteracted = true
      closeOverlays()
    }
    if (userInteracted) saveProgress(d)
  }

  /** Close every transient overlay (dict popup, selection + highlight toolbars). */
  function closeOverlays() {
    dictState.open = false
    hlEdit.open = false
    sel.open = false
  }

  // ── Selection → highlight / copy / translate ──────────────────────────────
  function onSelection(info: SelectionInfo) {
    hlEdit.open = false
    sel = { open: true, rect: info.rect, text: info.text, doc: info.doc, range: info.range }
  }
  function onSelectionCleared() {
    sel.open = false
  }

  async function createHighlight(color: HighlightColor) {
    if (!controller || !sel.doc || !sel.range) return
    const cfi = controller.cfiForSelection(sel.doc, sel.range)
    if (!cfi) return
    const anno: Annotation = {
      id: newId(),
      bookId,
      kind: 'highlight',
      cfi,
      text: sel.text.slice(0, 240),
      color,
      sectionLabel,
      createdAt: Date.now(),
    }
    await saveAnnotation(anno)
    await controller.addHighlight(cfi, HIGHLIGHT_HEX[color])
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

  function translateSelection() {
    translateText = sel.text
    translateOpen = true
    controller?.clearSelection()
    sel.open = false
  }

  // ── Tapping an existing highlight → recolor / delete ──────────────────────
  function onShowAnnotation(value: string, range: Range) {
    // This tap was on a highlight — cancel the deferred page-turn/dictionary action.
    if (pendingTap) {
      clearTimeout(pendingTap)
      pendingTap = undefined
    }
    dictState.open = false
    const doc = range.startContainer.ownerDocument
    const frame = doc?.defaultView?.frameElement as HTMLElement | null
    const fr = frame?.getBoundingClientRect()
    const r = range.getBoundingClientRect()
    const existing = annotations.items.find((a) => a.cfi === value)
    sel.open = false
    hlEdit = {
      open: true,
      cfi: value,
      color: existing?.color,
      rect: { left: (fr?.left ?? 0) + r.left, top: (fr?.top ?? 0) + r.top, width: r.width, height: r.height },
    }
  }

  async function recolorHighlight(color: HighlightColor) {
    const existing = annotations.items.find((a) => a.cfi === hlEdit.cfi)
    if (existing) await saveAnnotation({ ...existing, color })
    await controller?.recolorHighlight(hlEdit.cfi, HIGHLIGHT_HEX[color])
    hlEdit.open = false
  }

  async function deleteHighlight() {
    const existing = annotations.items.find((a) => a.cfi === hlEdit.cfi)
    if (existing) await removeAnnotation(existing.id)
    await controller?.removeHighlight(hlEdit.cfi)
    hlEdit.open = false
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
    controller?.goTo(cfi)
  }

  // A tap and foliate's highlight hit-test (click) both fire on the same gesture.
  // When highlights exist, briefly defer the tap action so a highlight tap can
  // cancel it (and open the edit toolbar) instead of also turning the page/defining.
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
    // While a popup or edit toolbar is open, the next tap simply dismisses it and
    // is consumed — predictable, and the user's reported "inconsistent dismiss" fix.
    if (dictState.open || hlEdit.open) {
      dictState.open = false
      hlEdit.open = false
      return
    }

    // Edge rails always turn the page (foliate's goLeft/goRight are direction-aware,
    // so this is correct for both LTR and vertical RTL books).
    if (info.zone === 'left' || info.zone === 'right') {
      userInteracted = true
      chromeVisible = false
      if (info.zone === 'left') controller?.goLeft()
      else controller?.goRight()
      return
    }

    // Centre zone: look up a tapped Japanese word, otherwise toggle the chrome.
    if (settings.tapToDefine && tryDefine(info)) return
    chromeVisible = !chromeVisible
  }

  /** Returns true if the tap landed on Japanese text and a lookup was started. */
  function tryDefine(info: TapInfo): boolean {
    const ex = extractTextAt(info.doc, info.ix, info.iy)
    if (!ex || !looksJapanese(ex.text)) return false
    dictState.open = true
    dictState.x = info.px
    dictState.y = info.py
    dictState.loading = true
    dictState.needsDownload = false
    dictState.result = null
    dictState.lastText = ex.text
    void runLookup(ex.text)
    return true
  }

  async function runLookup(text: string) {
    if (!(await isDictReady())) {
      dictState.loading = false
      dictState.needsDownload = true
      return
    }
    const res = await lookup(text)
    // Ignore if the popup was dismissed or a newer tap superseded this lookup.
    if (!dictState.open || dictState.lastText !== text) return
    dictState.loading = false
    dictState.result = res
  }

  async function downloadDict() {
    try {
      await downloadDictionary('en')
      dictState.needsDownload = false
      dictState.loading = true
      await runLookup(dictState.lastText)
    } catch {
      /* error surfaced via the dict store */
    }
  }

  function navigate(href: string) {
    tocOpen = false
    userInteracted = true
    controller?.goTo(href)
  }

  function onSettingChange(kind: 'appearance' | 'layout' | 'writingmode') {
    if (!controller) return
    if (kind === 'appearance') controller.applyAppearance(settings)
    else if (kind === 'layout') controller.applyLayout(settings)
    else if (kind === 'writingmode' && bookFile) void controller.reopenForWritingMode(bookFile)
  }

  onMount(async () => {
    try {
      const [m, file, progress] = await Promise.all([
        getBookMeta(bookId),
        getBookFile(bookId),
        getProgress(bookId),
      ])
      if (!file) throw new Error('Book file not found in storage.')
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
        onSelection,
        onSelectionCleared,
        onShowAnnotation,
      })
      await controller.open(file, progress?.cfi)
      toc = controller.view.book?.toc ?? []

      // Load annotations and seed the highlight overlays.
      await loadAnnotations(bookId)
      controller.setHighlights(
        annotations.items
          .filter((a) => a.kind === 'highlight')
          .map((a) => ({ cfi: a.cfi, hex: a.color ? HIGHLIGHT_HEX[a.color] : HIGHLIGHT_HEX.yellow })),
      )
      status = 'ready'
    } catch (err) {
      console.error(err)
      errorMsg = err instanceof Error ? err.message : 'Could not open this book.'
      status = 'error'
    }
  })

  onDestroy(() => {
    if (pendingTap) clearTimeout(pendingTap)
    controller?.destroy()
    clearAnnotations()
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
    <header class="bar top" transition:fly={{ y: -20, duration: 200 }}>
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

    <footer class="bar bottom" transition:fly={{ y: 20, duration: 200 }}>
      <button class="cbtn" onclick={() => (tocOpen = true)} aria-label="Contents">
        <Icon name="list" size={22} />
      </button>
      <div class="progress">
        <div class="track"><div class="fill" style="width:{Math.round(fraction * 100)}%"></div></div>
        <div class="ptext">
          {#if sectionLabel}<span class="sec" lang="ja">{sectionLabel}</span>{/if}
          <span class="pct">{Math.round(fraction * 100)}%</span>
        </div>
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

<Sheet bind:open={translateOpen} title="Translation">
  <TranslationSheet bind:open={translateOpen} text={translateText} />
</Sheet>

<DictionaryPopup
  bind:open={dictState.open}
  x={dictState.x}
  y={dictState.y}
  loading={dictState.loading}
  needsDownload={dictState.needsDownload}
  result={dictState.result}
  ondownload={downloadDict}
/>

<!-- Toolbar for a fresh text selection -->
<SelectionToolbar
  open={sel.open}
  rect={sel.rect}
  onColor={createHighlight}
  onCopy={copySelection}
  onTranslate={translateSelection}
/>

<!-- Toolbar for editing an existing highlight -->
<SelectionToolbar
  open={hlEdit.open}
  rect={hlEdit.rect}
  activeColor={hlEdit.color}
  showCopy={false}
  showTranslate={false}
  showDelete={true}
  onColor={recolorHighlight}
  onDelete={deleteHighlight}
/>

<style>
  .reader {
    position: fixed;
    inset: 0;
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
    padding-bottom: calc(var(--safe-bottom) + 8px);
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
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 0 6px;
  }
  .track {
    height: 3px;
    border-radius: 2px;
    background: var(--line-strong);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s var(--ease);
  }
  .ptext {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    font-size: 11px;
    color: var(--ink-faint);
  }
  .sec {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .pct {
    font-variant-numeric: tabular-nums;
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
