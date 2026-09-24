<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte'
  import { fly, fade } from 'svelte/transition'
  import { cubicOut } from 'svelte/easing'
  import { openShelf } from '../../stores/nav.svelte'
  import { settings, appearance } from '../../stores/settings.svelte'
  import { dict } from '../../stores/dict.svelte'
  import { library } from '../../stores/library.svelte'
  import { showToast } from '../../stores/toast.svelte'
  import { DUR, dur } from '../util/motion.svelte'
  import { getBookFile } from '../../services/library'
  import { getBookMeta, getProgress, putProgress } from '../../services/storage/db'
  import {
    ReaderController,
    prefetchEngine,
    type RelocateDetail,
    type TapInfo,
    type SelectionInfo,
    type TocItem,
  } from '../../services/reader'
  import { cfiWithinPage } from '../../services/cfi'
  import { extractTextAt, rangeForSpan, type CharPosition } from '../../services/jp/extract'
  import { lookupAt, warmupLookup, disposeLookup, pingLookup, type LookupResult } from '../../services/jp/lookupClient'
  import { isDictReady, downloadAndWarmDictionary } from '../../services/jp/dictdb'
  import {
    annotations,
    loadAnnotations,
    clearAnnotations,
    saveAnnotation,
    removeAnnotation,
    isHighlighted,
    highlightAt,
    addHighlightRecord,
    removeHighlightRecord,
    newId,
  } from '../../stores/annotations.svelte'
  import { debounce } from '../util/debounce'
  import { inChromeToggleBand } from '../util/chromeBand'
  import type { AnchorRect } from '../util/anchoredPosition'
  import { viewportSize } from '../../services/viewport'
  import type { BookMeta, Annotation, ResolvedTheme } from '../../services/types'
  import Icon from '../components/Icon.svelte'
  import Sheet from '../components/Sheet.svelte'
  import LoadingScreen from '../components/LoadingScreen.svelte'
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
  /** Set on unmount; onMount's async body re-checks it after every await. */
  let destroyed = false

  let status = $state<'loading' | 'ready' | 'error'>('loading')
  let errorMsg = $state('')

  let chromeVisible = $state(true)
  let fraction = $state(0)
  let sectionLabel = $state('')
  let currentTocId = $state<number | undefined>(undefined)
  let toc = $state<TocItem[]>([])

  let tocOpen = $state(false)
  let settingsOpen = $state(false)
  let annotationsOpen = $state(false)
  /** The Aa button — the Display popover hangs from it on iPad. */
  let displayBtn = $state<HTMLButtonElement>()

  /** The shelf knows the title before the meta read lands. */
  const loadingTitle = $derived(meta?.title ?? library.books.find((b) => b.id === bookId)?.title)
  /** The bookmark ribbon sits on the fore-edge corner. */
  let rtlBook = $state(false)

  // Selection toolbar state; `doc`/`range` are live DOM refs, released by clearSel.
  let sel = $state<{ open: boolean; rect: SelectionInfo['rect']; text: string; doc: Document | null; range: Range | null }>(
    { open: false, rect: { left: 0, top: 0, width: 0, height: 0 }, text: '', doc: null, range: null },
  )
  function clearSel() {
    sel.open = false
    sel.text = ''
    sel.doc = null
    sel.range = null
  }

  let currentCFI = $state('')
  // Within the page's range, not an exact CFI match, so it survives a reflow.
  const isBookmarked = $derived(
    !!currentCFI && annotations.items.some((a) => a.kind === 'bookmark' && cfiWithinPage(a.cfi, currentCFI)),
  )

  let dictState = $state<{
    open: boolean
    /** The tapped glyph, then the matched word (top-window coords). */
    anchor: AnchorRect | null
    vertical: boolean
    loading: boolean
    needsDownload: boolean
    result: LookupResult | null
    /** Kept so a post-download retry can re-run the lookup. */
    text: string
    tapOffset: number
    /** Per-lookup key; a stale lookup never lands in a newer card. */
    lastKey: string
    /** The word's CFI once resolved, else ''. */
    cfi: string
    highlighted: boolean
    /** The matched surface word (for re-adding the highlight). */
    word: string
  }>({
    open: false, anchor: null, vertical: false, loading: false, needsDownload: false, result: null,
    text: '', tapOffset: 0, lastKey: '', cfi: '', highlighted: false, word: '',
  })

  // Live DOM for the in-flight define (plain refs, not $state).
  let defineDoc: Document | null = null
  let definePositions: CharPosition[] = []

  // Persist progress only after the user moved: startup relocations can report a bogus
  // fraction, and `relocate` carries no reason to tell them apart.
  let userInteracted = false

  // Flushed on close/background: iOS may kill a hidden PWA before the timer fires.
  const saveProgress = debounce((d: RelocateDetail) => {
    void putProgress({
      bookId,
      cfi: d.cfi,
      fraction: d.fraction,
      label: d.tocItem?.label,
      updatedAt: Date.now(),
    }).catch((err) => console.warn('Could not save reading position', err))
  }, 600)

  function onRelocate(d: RelocateDetail) {
    fraction = d.fraction
    currentCFI = d.cfi
    currentTocId = d.tocItem?.id
    if (d.tocItem?.label) sectionLabel = d.tocItem.label
    if (userInteracted) saveProgress(d)
  }

  function onTurn() {
    userInteracted = true
    chromeVisible = false
    closeOverlays()
  }

  /** The single close path for the card and the selection toolbar. Also releases the
   *  define DOM refs so a navigated-away section can be collected. */
  function closeOverlays() {
    dictState.open = false
    dictState.anchor = null
    clearSel()
    defineDoc = null
    definePositions = []
  }

  // ── Highlights: the one create/remove pair ────────────────────────────────
  /** Paint `cfi` and record it (deduped on CFI); the record persists in the background. */
  function addHighlight(cfi: string, text: string) {
    if (!controller) return
    if (!isHighlighted(cfi)) void controller.addHighlight(cfi).catch(() => {})
    addHighlightRecord({ bookId, cfi, text, sectionLabel })
  }
  /** Unpaint `cfi` and drop every highlight record at it. */
  function removeHighlight(cfi: string) {
    removeHighlightRecord(cfi)
    void controller?.removeHighlight(cfi).catch(() => {})
  }

  /** Panel delete: unpaint once no other record shares the CFI. Undo restores the record. */
  function onRemoveAnnotation(a: Annotation) {
    const done = removeAnnotation(a.id) // in-memory list updates synchronously
    if (a.kind === 'highlight' && !isHighlighted(a.cfi)) {
      void controller?.removeHighlight(a.cfi).catch(() => {})
      if (dictState.cfi === a.cfi) dictState.highlighted = false
    }
    done.catch((err) => console.warn('Could not delete annotation', err))
    showToast({
      message: a.kind === 'highlight' ? 'Highlight deleted' : 'Bookmark deleted',
      action: { label: 'Undo', run: () => restoreAnnotation(a) },
    })
  }
  function restoreAnnotation(a: Annotation) {
    if (destroyed) return
    const repaint = a.kind === 'highlight' && !isHighlighted(a.cfi)
    saveAnnotation(a).catch((err) => console.warn('Could not restore annotation', err))
    if (repaint) void controller?.addHighlight(a.cfi).catch(() => {})
    if (a.kind === 'highlight' && dictState.cfi === a.cfi) dictState.highlighted = true
  }

  // ── Selection → highlight / copy ──────────────────────────────────────────
  function onSelection(info: SelectionInfo) {
    sel = { open: true, rect: info.rect, text: info.text, doc: info.doc, range: info.range }
  }
  function createHighlight() {
    if (!controller || !sel.doc || !sel.range) return
    const cfi = controller.cfiForSelection(sel.doc, sel.range)
    if (cfi) addHighlight(cfi, sel.text)
    controller.clearSelection()
    clearSel()
  }

  async function copySelection() {
    const text = sel.text
    controller?.clearSelection()
    clearSel()
    if (text) {
      try {
        await navigator.clipboard.writeText(text)
        showToast({ message: 'Copied' })
      } catch {
        showToast({ message: 'Couldn’t copy' })
      }
    }
  }

  /** A rect inside a content document → top-window coordinates. */
  function rectInTop(doc: Document, r: DOMRect | DOMRectReadOnly): AnchorRect {
    const fr = (doc.defaultView?.frameElement as HTMLElement | null)?.getBoundingClientRect()
    const ox = fr?.left ?? 0
    const oy = fr?.top ?? 0
    return { left: ox + r.left, top: oy + r.top, right: ox + r.right, bottom: oy + r.bottom }
  }

  // ── Tapping an existing highlight → reopen its definition (with a remove option) ──
  function onShowAnnotation(value: string, range: Range) {
    // This click rides the same gesture as our tap. If the tap defined a word, keep its
    // lookup but adopt this highlight, so Remove clears what was tapped (e.g. an enclosing
    // phrase highlight) rather than a nested word.
    if (Date.now() - tapDismissedAt < 500) return
    if (Date.now() - tapDefinedAt < 500) {
      if (dictState.open && dictState.lastKey === tapDefinedKey && !dictState.cfi) {
        dictState.cfi = value
        dictState.word = highlightAt(value)?.text || dictState.word
        dictState.highlighted = true
      }
      return
    }
    // Prefer the stored word: a range over ruby stringifies with furigana (決けっ心).
    const word = highlightAt(value)?.text || range.toString()
    const doc = range.startContainer.ownerDocument
    let anchor: AnchorRect | null = null
    try {
      if (doc) anchor = rectInTop(doc, range.getBoundingClientRect())
    } catch {
      /* detached range */
    }
    clearSel()
    openDefine({ text: word, tapOffset: 0, anchor: anchor ?? { left: 0, top: 0, right: 0, bottom: 0 }, existingCfi: value, word })
  }

  /** Popup footer toggle; keeps the card open. */
  function toggleWordHighlight() {
    if (!controller || !dictState.cfi) return
    if (dictState.highlighted) removeHighlight(dictState.cfi)
    else addHighlight(dictState.cfi, dictState.word)
    dictState.highlighted = !dictState.highlighted
  }

  // ── Bookmarks ─────────────────────────────────────────────────────────────
  function toggleBookmark() {
    if (!controller) return
    const cfi = currentCFI || controller.lastCFI
    if (!cfi) return
    const here = annotations.items.filter((a) => a.kind === 'bookmark' && cfiWithinPage(a.cfi, cfi))
    const warn = (err: unknown) => console.warn('Could not update bookmark', err)
    if (here.length) {
      for (const b of here) removeAnnotation(b.id).catch(warn)
      return
    }
    saveAnnotation({
      id: newId(),
      bookId,
      kind: 'bookmark',
      cfi,
      text: `${Math.round(fraction * 100)}%${sectionLabel ? ' · ' + sectionLabel : ''}`,
      sectionLabel,
      createdAt: Date.now(),
    }).catch(warn)
  }

  /** A non-turn jump (TOC, a note). */
  function jumpTo(target: string) {
    userInteracted = true
    closeOverlays()
    controller?.goTo(target).catch((err) => console.warn('Could not navigate', err))
  }

  function navAnnotation(cfi: string) {
    annotationsOpen = false
    jumpTo(cfi)
  }

  function navigate(href: string) {
    tocOpen = false
    jumpTo(href)
  }

  // Our tap and foliate's highlight `click` (show-annotation) share a gesture. The tap runs
  // immediately — never delay it — and the click stands down behind these stamps.
  let tapDefinedAt = 0
  let tapDefinedKey = ''
  let tapDismissedAt = 0

  /** Tap routing: open card → dismiss; glyph → define (even in the edge band, which
   *  overlaps each column's end glyphs); blank edge band → toggle chrome; else hide it. */
  function onTap(info: TapInfo) {
    if (dictState.open) {
      tapDismissedAt = Date.now()
      closeOverlays()
      return
    }
    if (tryDefine(info)) {
      tapDefinedAt = Date.now()
      tapDefinedKey = dictState.lastKey
      chromeVisible = false
      return
    }
    if (inChromeToggleBand(info.py, viewportSize().h)) {
      chromeVisible = !chromeVisible
      return
    }
    if (chromeVisible) chromeVisible = false
  }

  /** ←/→ turn that way, Space/Shift-Space go forward/back in reading order, Escape closes
   *  the card, else the chrome. Also receives keys forwarded from content documents. */
  function onKey(e: KeyboardEvent) {
    if (status !== 'ready' || !controller || e.defaultPrevented) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    // A modal sheet owns the keyboard (and handles its own Escape).
    if (tocOpen || settingsOpen || annotationsOpen) return // the sheet owns the keyboard
    const t = e.target as Element | null
    if (t?.closest?.('input, textarea, select, [contenteditable], [role="slider"]')) return
    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault()
        void controller.goLeft()
        break
      case 'ArrowRight':
        e.preventDefault()
        void controller.goRight()
        break
      case ' ':
        if (t?.closest?.('button')) return // Space activates a focused button
        e.preventDefault()
        void (e.shiftKey ? controller.goBackward() : controller.goForward())
        break
      case 'Escape':
        if (dictState.open || sel.open) {
          e.preventDefault()
          controller.clearSelection()
          closeOverlays()
        } else if (chromeVisible) {
          e.preventDefault()
          chromeVisible = false
        }
        break
    }
  }

  /** The visible bars cover the edge bands, so a tap on a bar's empty area hides them. */
  function dismissChromeFromBar(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('button')) return
    chromeVisible = false
  }

  /** The tapped character's box (top-window), else the tap point. */
  function glyphAnchor(doc: Document, positions: CharPosition[], i: number, px: number, py: number): AnchorRect {
    const c = positions[i]
    if (c) {
      try {
        const r = doc.createRange()
        r.setStart(c.node, c.offset)
        r.setEnd(c.node, Math.min(c.offset + 1, c.node.length))
        const b = r.getBoundingClientRect()
        if (b.width || b.height) return rectInTop(doc, b)
      } catch {
        /* fall through */
      }
    }
    return { left: px, top: py, right: px, bottom: py }
  }

  /** Whether the tap hit Japanese text (and a lookup started). */
  function tryDefine(info: TapInfo): boolean {
    if (!info.doc) return false
    const ex = extractTextAt(info.doc, info.ix, info.iy)
    if (!ex) return false
    openDefine({
      text: ex.text,
      tapOffset: ex.tapOffset,
      anchor: glyphAnchor(info.doc, ex.positions, ex.tapOffset, info.px, info.py),
      doc: info.doc,
      positions: ex.positions,
    })
    return true
  }

  /**
   * Open the card for a word. A fresh tap (`doc` + `positions`) highlights the match once
   * the lookup resolves; `existingCfi` reopens a highlight. An already-open card keeps its
   * previous result (dimmed) until the new one lands.
   */
  function openDefine(o: {
    text: string
    tapOffset: number
    anchor: AnchorRect
    doc?: Document | null
    positions?: CharPosition[]
    existingCfi?: string
    word?: string
  }) {
    const key = `${o.existingCfi ?? ''}:${o.tapOffset}:${o.text}`
    const retarget = dictState.open
    defineDoc = o.doc ?? null
    definePositions = o.positions ?? []
    dictState.open = true
    dictState.anchor = o.anchor
    dictState.vertical = controller?.vertical ?? false
    dictState.loading = true
    dictState.needsDownload = false
    if (!retarget) dictState.result = null
    dictState.text = o.text
    dictState.tapOffset = o.tapOffset
    dictState.lastKey = key
    dictState.cfi = o.existingCfi ?? ''
    dictState.word = o.word ?? ''
    dictState.highlighted = !!o.existingCfi
    void runLookup(o.text, o.tapOffset, key)
  }

  async function runLookup(text: string, tapOffset: number, key: string) {
    const stale = () => !dictState.open || dictState.lastKey !== key
    try {
      if (!(await isDictReady())) {
        if (stale()) return
        dictState.loading = false
        dictState.result = null
        dictState.needsDownload = true
        return
      }
      const res = await lookupAt(text, tapOffset)
      if (stale()) return
      dictState.loading = false
      dictState.result = res
      if (res && res.entries.length && !dictState.cfi && defineDoc && definePositions.length) highlightMatch(res, key)
    } catch (err) {
      // e.g. IndexedDB refused to open: never leave the card spinning.
      console.warn('Lookup failed', err)
      if (stale()) return
      dictState.loading = false
      dictState.result = null
    }
  }

  /** Highlight the matched word and re-anchor the card to it. Synchronous, so a newer tap
   *  can't have its card state overwritten by this word's CFI. */
  function highlightMatch(res: LookupResult, key: string) {
    if (!controller || !defineDoc) return
    const start = res.matchStart
    const end = res.matchStart + res.matchLength
    const range = rangeForSpan(defineDoc, definePositions, start, end)
    if (!range) return
    const cfi = controller.cfiForSelection(defineDoc, range)
    if (!cfi || !dictState.open || dictState.lastKey !== key) return
    // Not range.toString(): a range over ruby splices in the furigana (決けっ心).
    const word = definePositions
      .slice(start, end)
      .map((c) => c.node.data.charAt(c.offset))
      .join('')
    try {
      dictState.anchor = rectInTop(defineDoc, range.getBoundingClientRect())
    } catch {
      /* keep the glyph anchor */
    }
    // With "Highlight looked-up words" off the CFI still backs the footer toggle.
    const mark = settings.highlightLookups || isHighlighted(cfi)
    if (mark) addHighlight(cfi, word)
    dictState.cfi = cfi
    dictState.word = word
    dictState.highlighted = mark
  }

  // The card doesn't wait for the IPADIC warm: the effect below re-runs the pending lookup
  // as soon as JMdict is queryable.
  async function downloadDict() {
    try {
      await downloadAndWarmDictionary('en')
    } catch {
      /* error surfaced via the dict store */
    }
  }
  $effect(() => {
    if (dictState.open && dictState.needsDownload && dict.state === 'ok')
      untrack(() => {
        dictState.needsDownload = false
        dictState.loading = true
        void runLookup(dictState.text, dictState.tapOffset, dictState.lastKey)
      })
  })

  // Recolour when an 'auto' theme follows the OS; `appliedTheme` stops an explicit pick
  // (already applied via onSettingChange) from applying twice.
  let appliedTheme: ResolvedTheme | null = null
  function applyAppearance() {
    appliedTheme = appearance.resolved
    controller?.applyAppearance(settings)
  }
  $effect(() => {
    if (appearance.resolved !== appliedTheme) untrack(() => controller && applyAppearance())
  })

  /** Scrubber preview: each TOC entry's section start as a book fraction, built once per open. */
  let chapterStarts: { start: number; label: string }[] = []
  function buildChapterIndex() {
    chapterStarts = []
    const view = controller?.view
    const fr = view?.getSectionFractions() ?? []
    const resolveHref: ((h: string) => { index: number } | null) | undefined = view?.book?.resolveHref?.bind(view.book)
    if (!fr.length || !resolveHref) return
    const out: { start: number; label: string }[] = []
    const walk = (items: TocItem[]) => {
      for (const it of items) {
        const label = it.label?.trim()
        if (it.href && label) {
          try {
            const r = resolveHref(it.href)
            if (r && r.index >= 0 && fr[r.index] !== undefined) out.push({ start: fr[r.index], label })
          } catch {
            /* unresolvable href — skip */
          }
        }
        if (it.subitems?.length) walk(it.subitems)
      }
    }
    walk(toc)
    // Entries sharing a section start: keep the first (stable sort).
    out.sort((a, b) => a.start - b.start)
    chapterStarts = out.filter((c, i) => i === 0 || c.start > out[i - 1].start)
  }
  function chapterAt(f: number): string {
    let label = ''
    for (const c of chapterStarts) {
      if (c.start <= f + 1e-6) label = c.label
      else break
    }
    return label
  }
  /** TOC labels in reading order (the annotations panel groups by these). */
  const chapterOrder = $derived.by(() => {
    const out: string[] = []
    const walk = (items: TocItem[]) => {
      for (const it of items) {
        if (it.label?.trim()) out.push(it.label.trim())
        if (it.subitems?.length) walk(it.subitems)
      }
    }
    walk(toc)
    return out
  })

  function seek(frac: number) {
    if (!controller) return
    userInteracted = true
    closeOverlays()
    void controller.goToFraction(frac).catch((err) => console.warn('Could not seek', err))
  }

  function onSettingChange(kind: 'appearance' | 'layout' | 'writingmode') {
    if (!controller) return
    if (kind === 'appearance') applyAppearance()
    else if (kind === 'layout') controller.applyLayout(settings)
    else if (kind === 'writingmode' && bookFile) {
      closeOverlays() // the re-open replaces every content document
      controller.reopenForWritingMode(bookFile).catch((err) => console.warn('Could not re-open the book', err))
    }
  }

  function warmLookupIfReady() {
    void isDictReady().then((ok) => {
      if (ok && !destroyed) void warmupLookup()
    })
  }

  // Shed the worker's resident trie only after a long backgrounding (iOS kills memory-heavy
  // hidden tabs). Not on every hide: taps during a rebuild fall back to greedy segmentation.
  const LOOKUP_IDLE_DISPOSE_MS = 60_000
  let disposeTimer: number | undefined
  function onVisibility() {
    if (document.hidden) {
      saveProgress.flush()
      if (disposeTimer) clearTimeout(disposeTimer)
      disposeTimer = window.setTimeout(() => {
        disposeTimer = undefined
        if (document.hidden) disposeLookup()
      }, LOOKUP_IDLE_DISPOSE_MS)
    } else {
      if (disposeTimer) {
        clearTimeout(disposeTimer)
        disposeTimer = undefined
      }
      // iOS may have reclaimed the worker without an onerror; re-warm a dead one.
      void pingLookup().then((alive) => {
        if (!alive && !destroyed && !document.hidden) warmLookupIfReady()
      })
    }
  }
  function onPageHide() {
    saveProgress.flush()
  }

  /** DEV only, for `__tsuzuri`. */
  let lastDoc: Document | null = null
  function onLoad(doc: Document) {
    if (import.meta.env.DEV) lastDoc = doc
  }

  /** DEV-only hook: the content document is in a closed shadow DOM, so the tap-accuracy
   *  harness has no other way in. Tree-shaken from production. */
  function installDevHook() {
    if (!import.meta.env.DEV) return
    ;(window as any).__tsuzuri = {
      get doc() {
        return lastDoc
      },
      get controller() {
        return controller
      },
      get dictState() {
        return dictState
      },
      extractTextAt,
      lookupAt,
    }
  }

  onMount(async () => {
    prefetchEngine()
    warmLookupIfReady()
    try {
      const [m, file, progress] = await Promise.all([
        getBookMeta(bookId),
        getBookFile(bookId),
        getProgress(bookId),
        loadAnnotations(bookId),
      ])
      if (destroyed) return
      // Meta without bytes: the blob was evicted (e.g. WebKit's 7-day rule).
      if (!file)
        throw new Error(
          m
            ? 'This book’s file is no longer on this device — its data may have been cleared. Please re-import the EPUB.'
            : 'Book file not found in storage.',
        )
      meta = m ?? null
      bookFile = file
      if (progress) {
        fraction = progress.fraction ?? 0
        currentCFI = progress.cfi ?? ''
        if (progress.label) sectionLabel = progress.label
      }
      controller = new ReaderController(host, settings, {
        onRelocate,
        onLoad,
        onTap,
        onTurn,
        onSelection,
        onSelectionCleared: clearSel,
        onShowAnnotation,
        onKey,
      })
      // Before open: each section then draws its own highlights as it loads.
      controller.setHighlights(annotations.items.filter((a) => a.kind === 'highlight').map((a) => a.cfi))
      appliedTheme = appearance.resolved
      await controller.open(file, progress?.cfi)
      if (destroyed) return
      status = 'ready'
      toc = controller.view.book?.toc ?? []
      rtlBook = controller.bookDir === 'rtl'
      buildChapterIndex()
      installDevHook()
      document.addEventListener('visibilitychange', onVisibility)
      window.addEventListener('pagehide', onPageHide)
    } catch (err) {
      if (destroyed) return
      console.error(err)
      errorMsg = err instanceof Error ? err.message : 'Could not open this book.'
      status = 'error'
    }
  })

  onDestroy(() => {
    destroyed = true
    if (disposeTimer) clearTimeout(disposeTimer)
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', onPageHide)
    saveProgress.flush()
    controller?.destroy()
    controller = null
    disposeLookup()
    clearAnnotations()
    defineDoc = null
    definePositions = []
    clearSel()
    lastDoc = null
    if (import.meta.env.DEV) delete (window as any).__tsuzuri
  })
</script>

<svelte:window onkeydown={onKey} />

<div class="reader" class:chrome={chromeVisible}>
  <div class="view-host" bind:this={host}></div>

  {#if status === 'loading'}
    <LoadingScreen title={loadingTitle} onback={openShelf} />
  {:else if status === 'error'}
    <div class="overlay error" role="alert">
      <p>{errorMsg}</p>
      <button class="btn btn-tinted" onclick={openShelf}>Back to library</button>
    </div>
  {/if}

  <!-- No backdrop-filter: it stays on screen through page slides. -->
  {#if status === 'ready' && isBookmarked}
    <div class="ribbon" class:rtl={rtlBook} aria-hidden="true"></div>
  {/if}

  {#if status === 'ready' && chromeVisible}
    <!-- The capsules stay inside the chrome-toggle band (inChromeToggleBand). -->
    <header
      class="bar top glass"
      role="presentation"
      onclick={dismissChromeFromBar}
      in:fly={{ y: -16, duration: dur(DUR.base), easing: cubicOut }}
      out:fly={{ y: -12, duration: dur(DUR.fast) }}
    >
      <div class="group start">
        <button class="icon-btn" onclick={openShelf} aria-label="Library">
          <Icon name="chevron-left" />
        </button>
      </div>
      <div class="title" lang="ja">{meta?.title ?? ''}</div>
      <div class="group end">
        <button class="icon-btn" onclick={() => (annotationsOpen = true)} aria-label="Highlights & Bookmarks">
          <Icon name="highlighter" />
        </button>
        <button bind:this={displayBtn} class="icon-btn" onclick={() => (settingsOpen = true)} aria-label="Display settings">
          <Icon name="aa" />
        </button>
      </div>
    </header>

    <footer
      class="bar bottom glass"
      role="presentation"
      onclick={dismissChromeFromBar}
      in:fly={{ y: 16, duration: dur(DUR.base), easing: cubicOut }}
      out:fly={{ y: 12, duration: dur(DUR.fast) }}
    >
      <button class="icon-btn" onclick={() => (tocOpen = true)} aria-label="Contents">
        <Icon name="list" />
      </button>
      <div class="progress">
        <ProgressScrubber {fraction} {sectionLabel} labelAt={chapterAt} onseek={seek} />
      </div>
      <button
        class="icon-btn"
        class:on={isBookmarked}
        onclick={toggleBookmark}
        aria-label={isBookmarked ? 'Remove bookmark' : 'Add bookmark'}
      >
        <Icon name="bookmark" fill={isBookmarked} />
      </button>
    </footer>
  {/if}

  <!-- Reading % while the chrome is hidden; no backdrop-filter (stays up through slides). -->
  {#if status === 'ready' && !chromeVisible}
    <div class="page-pct" aria-hidden="true" transition:fade={{ duration: dur(DUR.fast) }}>
      {Math.round(fraction * 100)}%
    </div>
  {/if}
</div>

<Sheet bind:open={tocOpen} title="Contents">
  <TocSheet {toc} currentId={currentTocId} currentLabel={sectionLabel} onnavigate={navigate} />
</Sheet>

<!-- Undimmed, so text changes are judged against the page. -->
<Sheet bind:open={settingsOpen} title="Display" variant="popover" anchor={displayBtn}>
  <ReaderSettings onchange={onSettingChange} />
</Sheet>

<Sheet bind:open={annotationsOpen} title="Highlights & Bookmarks">
  <AnnotationsPanel {chapterOrder} onnavigate={navAnnotation} onremove={onRemoveAnnotation} />
</Sheet>

<DictionaryPopup
  open={dictState.open}
  anchor={dictState.anchor}
  vertical={dictState.vertical}
  loading={dictState.loading}
  needsDownload={dictState.needsDownload}
  result={dictState.result}
  highlighted={dictState.highlighted}
  onclose={closeOverlays}
  ondownload={downloadDict}
  ontogglehighlight={toggleWordHighlight}
/>

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
    /* Not `inset: 0`: a cold iOS standalone launch under-reports the viewport height
       (see services/viewport.ts). 100dvh is the pre-JS fallback. */
    height: var(--app-height, 100dvh);
    background: var(--paper);
    overflow: hidden;
    /* No double-tap zoom: taps and swipes bail while the viewport is scaled. */
    touch-action: manipulation;
  }
  .view-host {
    position: absolute;
    inset: 0;
    /* keep text clear of the notch / home indicator even when chrome is hidden */
    padding: var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left);
    box-sizing: border-box;
  }

  /* Both capsules must fit inside the chrome-toggle band (12% of vh, 80–160px). */
  .bar {
    position: absolute;
    z-index: var(--z-bars);
    left: calc(var(--safe-left) + var(--sp-2));
    right: calc(var(--safe-right) + var(--sp-2));
    min-height: 48px;
    padding: 2px var(--sp-1);
    border-radius: var(--r-full);
  }
  .bar.top {
    top: calc(var(--safe-top) + var(--sp-1));
    display: grid;
    /* Symmetric side tracks keep the title optically centred however long it is. */
    grid-template-columns: minmax(92px, 1fr) minmax(0, auto) minmax(92px, 1fr);
    align-items: center;
  }
  .group {
    display: flex;
    align-items: center;
  }
  .group.end {
    justify-content: flex-end;
  }
  .title {
    min-width: 0;
    padding: 0 var(--sp-2);
    text-align: center;
    font-size: var(--fs-body);
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .bar.bottom {
    bottom: calc(var(--safe-bottom) + var(--sp-1));
    display: flex;
    align-items: center;
    gap: var(--sp-1);
  }
  .progress {
    flex: 1;
    min-width: 0;
    display: flex;
  }

  .page-pct {
    position: absolute;
    left: 50%;
    bottom: calc(var(--safe-bottom) + var(--sp-2));
    transform: translateX(-50%);
    z-index: var(--z-readout);
    pointer-events: none;
    padding: 2px var(--sp-2);
    font-size: var(--fs-caption);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.03em;
    color: var(--ink-faint);
  }

  .ribbon {
    position: absolute;
    top: 0;
    right: calc(var(--safe-right) + var(--sp-7));
    z-index: var(--z-ribbon);
    width: 14px;
    height: calc(var(--safe-top) + 30px);
    pointer-events: none;
    background: var(--accent);
    clip-path: polygon(0 0, 100% 0, 100% 100%, 50% calc(100% - 6px), 0 100%);
    transform-origin: top center;
    animation: ribbon-in var(--dur-slow) var(--ease-spring);
  }
  .ribbon.rtl {
    right: auto;
    left: calc(var(--safe-left) + var(--sp-7));
  }
  @keyframes ribbon-in {
    from {
      transform: scaleY(0);
    }
  }

  /* iPad / wide screens: a roomier top capsule, a centred bottom capsule. */
  @media (min-width: 768px) {
    .bar {
      left: calc(var(--safe-left) + var(--sp-4));
      right: calc(var(--safe-right) + var(--sp-4));
      min-height: 52px;
      padding: var(--sp-1);
    }
    .bar.top {
      top: calc(var(--safe-top) + var(--sp-3));
      grid-template-columns: minmax(100px, 1fr) minmax(0, auto) minmax(100px, 1fr);
    }
    .bar.bottom {
      bottom: calc(var(--safe-bottom) + var(--sp-3));
      left: 50%;
      right: auto;
      width: min(680px, calc(100vw - 2 * var(--sp-4) - var(--safe-left) - var(--safe-right)));
      /* `translate`, not `transform`: the fly transition animates `transform`. */
      translate: -50% 0;
    }
    .title {
      max-width: 52vw;
      font-size: var(--fs-callout);
    }
  }

  .overlay {
    position: absolute;
    inset: 0;
    z-index: var(--z-overlay);
    display: grid;
    place-content: center;
    justify-items: center;
    gap: var(--sp-4);
    background: var(--paper);
    color: var(--ink-soft);
    text-align: center;
    padding: var(--sp-6);
  }
  .overlay p {
    margin: 0;
    max-width: 34ch;
    line-height: 1.5;
  }
</style>
