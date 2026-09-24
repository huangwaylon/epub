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
  /** Set on unmount. onMount's async body re-checks it after every await, so leaving the
   *  reader mid-open can't go on to register listeners, warm the worker, or set state. */
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

  /** Title for the opening screen: the shelf already knows it before the meta read lands. */
  const loadingTitle = $derived(meta?.title ?? library.books.find((b) => b.id === bookId)?.title)
  /** Page-progression side: the bookmark ribbon sits on the page's outer (fore-edge) corner. */
  let rtlBook = $state(false)

  // Active text selection → highlight/copy toolbar. `doc`/`range` are live DOM refs,
  // released (clearSel) as soon as the toolbar is done with them.
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
  // "This page is bookmarked" = a bookmark lies within the visible page's range — not an
  // exact CFI match, which broke as soon as a reflow (font size, rotation) moved the page
  // boundaries off the CFI the bookmark was saved at.
  const isBookmarked = $derived(
    !!currentCFI && annotations.items.some((a) => a.kind === 'bookmark' && cfiWithinPage(a.cfi, currentCFI)),
  )

  // Dictionary popup state. Tapping a word looks it up *and* highlights it yellow
  // (a vocab record); the popup's footer toggles that highlight off/on.
  let dictState = $state<{
    open: boolean
    /** What the card is placed against: the tapped glyph, then the matched word (top-window coords). */
    anchor: AnchorRect | null
    /** Vertical (縦書き) text: the card goes beside the column, not above it. */
    vertical: boolean
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
    open: false, anchor: null, vertical: false, loading: false, needsDownload: false, result: null,
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

  // Flushed (not cancelled) when the reader closes or the app is backgrounded: the last
  // turn before either is exactly the position the reader expects to come back to, and
  // iOS may kill a backgrounded PWA before a 600ms timer ever fires.
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

  /** Close every transient overlay (dict popup, selection toolbar). The single close
   *  path — the popup's X and Escape come through here too. */
  function closeOverlays() {
    dictState.open = false
    dictState.anchor = null
    clearSel()
    // Release the content Document + Text-node refs held for auto-highlighting the last
    // tapped word. They're consumed synchronously inside runLookup/highlightMatch, so once
    // the popup is closed they're dead — clearing them lets a detached (navigated-away)
    // section's DOM be collected instead of being pinned until the next tap.
    defineDoc = null
    definePositions = []
  }

  // ── Highlights: the one create/remove pair ────────────────────────────────
  /** Highlight `cfi` yellow and record it (deduped on CFI). Paints first — the overlay is
   *  what the reader is waiting to see — and persists in the background. */
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

  /** Delete from the Notes panel. A highlight must be unpainted too — but only once no
   *  other record still highlights the same CFI. Undo restores the very same record. */
  function onRemoveAnnotation(a: Annotation) {
    const done = removeAnnotation(a.id) // updates the in-memory list synchronously
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
  function onSelectionCleared() {
    clearSel()
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
    // This `click` rides the same gesture as our tap. If that tap already defined a word,
    // the tap's lookup owns the card's *content* — but the card must still own *this*
    // highlight, so its "Remove highlight" removes what the user tapped. Otherwise a tap
    // inside a longer highlight (a drag-selected phrase, or a vocab span from an older
    // segmentation) would add a nested word highlight that Remove clears while the outer
    // yellow stays. Guarded by the tap's key, so it can never land on a newer card.
    if (Date.now() - tapDefinedAt < 500) {
      if (dictState.open && dictState.lastKey === tapDefinedKey && !dictState.cfi) {
        dictState.cfi = value
        dictState.word = highlightAt(value)?.text || dictState.word
        dictState.highlighted = true
      }
      return
    }
    // Prefer the word we stored when the highlight was made: a range that spans ruby
    // stringifies with the furigana spliced in (決けっ心), which looks up as nothing.
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

  /** Toggle the looked-up word's highlight from the popup footer. Keeps the card open. */
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

  /** Jump somewhere that isn't a page turn (TOC, a note). A corrupt/stale target (e.g. a
   *  section that no longer resolves) must not throw or reject unhandled out of a tap. */
  function jumpTo(target: string) {
    userInteracted = true
    closeOverlays()
    try {
      const r = controller?.goTo(target) as unknown
      if (r && typeof (r as Promise<unknown>).catch === 'function') {
        ;(r as Promise<unknown>).catch((err) => console.warn('Could not navigate', err))
      }
    } catch (err) {
      console.warn('Could not navigate', err)
    }
  }

  function navAnnotation(cfi: string) {
    annotationsOpen = false
    jumpTo(cfi)
  }

  function navigate(href: string) {
    tocOpen = false
    jumpTo(href)
  }

  // A tap and foliate's highlight hit-test (a real `click`) fire on the same gesture, so
  // both can want to open the card for the tapped word. Rather than delay every tap
  // waiting to see which wins (that cost 60ms on the hot path and made taps droppable),
  // we let the tap run immediately and have the later `show-annotation` stand down if the
  // tap already opened the same word — the two paths agree on the outcome anyway, since a
  // looked-up word is highlighted.
  let tapDefinedAt = 0
  let tapDefinedKey = ''

  /**
   * Tap routing. A tap that lands on a Japanese glyph **always** defines it — the reading
   * gesture wins over every piece of chrome, because the alternative (checking the nav-bar
   * band and the open card first) made the first and last characters of every line
   * un-lookupable and cost a wasted tap for each new word. Everything else — blank paper,
   * the margins, the edge band — keeps its old meaning.
   */
  function onTap(info: TapInfo) {
    // 1. On a word → look it up. Works with the card already open (it re-targets to the
    //    new word) and inside the top/bottom band, where live text overlaps the band.
    if (info.doc && tryDefine(info)) {
      tapDefinedAt = Date.now()
      tapDefinedKey = dictState.lastKey
      chromeVisible = false // don't leave the bars covering the card
      return
    }
    // 2. Blank tap while the definition popup is open → dismiss it, and nothing else, so
    //    clearing the card never also flashes the chrome.
    if (dictState.open) {
      closeOverlays()
      return
    }
    // 3. Blank tap in the top or bottom edge band (over the nav bars) → toggle the chrome.
    //    This is the only way a tap *shows* the bars, so reading taps don't flash them.
    if (inChromeToggleBand(info.py, viewportSize().h)) {
      chromeVisible = !chromeVisible
      return
    }
    // 4. Otherwise a blank tap dismisses the chrome if it's up, so the bars are easy to
    //    clear without reaching for them.
    if (chromeVisible) chromeVisible = false
  }

  /**
   * Keyboard (a hardware keyboard on iPad, or desktop): ←/→ turn toward that side (the
   * controller's goLeft/goRight already honour an rtl book), Space / Shift-Space go
   * forward / back in reading order, Escape closes the card, else the chrome. Wired on the
   * window *and* forwarded from each content document (iframe keys never bubble out).
   */
  function onKey(e: KeyboardEvent) {
    if (status !== 'ready' || !controller || e.defaultPrevented) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    // A modal sheet owns the keyboard (and handles its own Escape).
    if (tocOpen || settingsOpen || annotationsOpen) return
    const t = e.target as Element | null
    // Leave keys to focused controls: fields, and the scrubber slider (arrows seek).
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

  /** The tapped character's box, in top-window coords — the card's first anchor (the
   *  matched word replaces it once the lookup resolves). Falls back to the tap point. */
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

  /** Returns true if the tap landed on Japanese text and a lookup was started. */
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
   * Open the dictionary popup for a word. For a fresh tap (`doc` + `positions`)
   * the matched word is auto-highlighted once the lookup resolves; for a tap on an
   * existing highlight (`existingCfi`) the popup just reopens with a remove option.
   *
   * Re-targeting an open card keeps the previous result on screen (dimmed by the popup
   * while `loading`) instead of blanking it to a spinner, so word-to-word reading doesn't
   * flash; the popup shows a spinner only if the lookup is still running after ~150ms.
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
      // Ignore if the popup was dismissed or a newer tap superseded this lookup.
      if (stale()) return
      dictState.loading = false
      dictState.result = res
      // Auto-highlight the matched word — but only a real match, only a fresh tap
      // (not a reopened highlight), and not on a download/no-match miss.
      if (res && res.entries.length && !dictState.cfi && defineDoc && definePositions.length) highlightMatch(res, key)
    } catch (err) {
      // Never leave the card spinning: a failed IndexedDB open (iOS storage pressure, a
      // version change from another tab) used to reject here and latch the spinner on for
      // the rest of the session.
      console.warn('Lookup failed', err)
      if (stale()) return
      dictState.loading = false
      dictState.result = null
    }
  }

  /**
   * Highlight the matched word yellow, record it as vocab, and re-anchor the card to the
   * word. Entirely synchronous: the old version awaited the IndexedDB write and the paint
   * before setting `dictState.cfi`, so a tap on another word in between had its card's
   * highlight state overwritten with this (older) word's CFI.
   */
  function highlightMatch(res: LookupResult, key: string) {
    if (!controller || !defineDoc) return
    const start = res.matchStart
    const end = res.matchStart + res.matchLength
    const range = rangeForSpan(defineDoc, definePositions, start, end)
    if (!range) return
    const cfi = controller.cfiForSelection(defineDoc, range)
    if (!cfi || !dictState.open || dictState.lastKey !== key) return
    // Read the word off the extracted positions, not `range.toString()`: a range over a
    // ruby-annotated compound spans the intervening <rt>, so stringifying it splices the
    // furigana into the word (決けっ心) — which then shows wrong in Notes and fails to
    // look up when the highlight is tapped again.
    const word = definePositions
      .slice(start, end)
      .map((c) => c.node.data.charAt(c.offset))
      .join('')
    try {
      dictState.anchor = rectInTop(defineDoc, range.getBoundingClientRect())
    } catch {
      /* keep the glyph anchor */
    }
    // "Highlight looked-up words" off: still resolve the CFI so the footer's Highlight
    // toggle can mark this word on demand — just don't paint or record it unasked.
    const mark = settings.highlightLookups || isHighlighted(cfi)
    if (mark) addHighlight(cfi, word)
    dictState.cfi = cfi
    dictState.word = word
    dictState.highlighted = mark
  }

  // Download the dictionary from the popup. `downloadAndWarmDictionary` keeps the
  // online-warm invariant (JMdict, then the kuromoji IPADIC fetched + SW-cached while still
  // online) in one place — but the card must not wait for that second step (11.3 MB of IPADIC
  // to cache, ~30 MB resident once the segmenter builds): the
  // effect below re-runs the pending lookup the moment JMdict is queryable.
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

  // Recolour the page when the resolved palette changes underneath us — the 'auto' theme
  // following the OS into dark mode mid-read. (An explicit theme pick already re-applies
  // via onSettingChange; `appliedTheme` keeps the two paths from applying twice.)
  let appliedTheme: ResolvedTheme | null = null
  function applyAppearance() {
    appliedTheme = appearance.resolved
    controller?.applyAppearance(settings)
  }
  $effect(() => {
    if (appearance.resolved !== appliedTheme) untrack(() => controller && applyAppearance())
  })

  /**
   * Chapter lookup for the scrubber preview: each TOC entry's start as an overall-book
   * fraction (its section's start, from foliate's section fractions). Built once per open —
   * the preview then resolves a drag position to a title with a short scan, no layout.
   */
  let chapterStarts: { start: number; label: string }[] = []
  function buildChapterIndex() {
    chapterStarts = []
    const v = controller?.view as unknown as {
      book?: { resolveHref?: (h: string) => { index: number } | null }
      getSectionFractions?: () => number[]
    }
    const fr = v?.getSectionFractions?.() ?? []
    if (!fr.length || !v?.book?.resolveHref) return
    const out: { start: number; label: string }[] = []
    const walk = (items: TocItem[]) => {
      for (const it of items) {
        const label = it.label?.trim()
        if (it.href && label) {
          try {
            const r = v.book!.resolveHref!(it.href)
            if (r && r.index >= 0 && fr[r.index] !== undefined) out.push({ start: fr[r.index], label })
          } catch {
            /* unresolvable href — skip */
          }
        }
        if (it.subitems?.length) walk(it.subitems)
      }
    }
    walk(toc)
    // Stable sort; several entries in one section share its start — keep the first.
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
  /** Flattened TOC labels in reading order — the Notes panel groups highlights by these. */
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

  /** Fast-scroll via the progress scrubber: jump to an overall-book fraction. */
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
      // The re-open replaces every content document: anything anchored to the old ones goes.
      closeOverlays()
      controller.reopenForWritingMode(bookFile).catch((err) => console.warn('Could not re-open the book', err))
    }
  }

  /** Warm the lookup worker (kuromoji trie) if the dictionary is installed. */
  function warmLookupIfReady() {
    void isDictReady().then((ok) => {
      if (ok && !destroyed) void warmupLookup()
    })
  }

  // While a book is open, shed the lookup worker (and the resident kuromoji trie it holds)
  // when the PWA stays backgrounded. iOS aggressively reclaims memory from hidden web
  // content; holding that trie resident across a long backgrounding raises the odds the
  // whole tab is killed — losing the reading position — rather than just the worker.
  //
  // But only after a grace period. Dispose-on-hide punished the common case (a glance at
  // another app, a notification, Slide Over): coming back, the worker had to rebuild the
  // trie, and taps issued during the rebuild silently fell back to greedy segmentation —
  // i.e. a wrong word, with no way for the reader to tell. Rebuilding also costs more
  // transient memory than staying resident does.
  const LOOKUP_IDLE_DISPOSE_MS = 60_000
  let disposeTimer: number | undefined
  function onVisibility() {
    if (document.hidden) {
      // Backgrounding may be the last thing this page ever does (iOS kills hidden PWAs).
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
      // Whether or not we disposed it, iOS may have reclaimed the worker while hidden
      // without an `onerror`. A cheap ping tells; a dead (or disposed) one is dropped and
      // re-warmed from the cached dict (no network) before the next tap needs it.
      void pingLookup().then((alive) => {
        if (!alive && !destroyed && !document.hidden) warmLookupIfReady()
      })
    }
  }
  function onPageHide() {
    saveProgress.flush()
  }

  /** Most recently loaded content document — DEV diagnostics only (see `__tsuzuri`). */
  let lastDoc: Document | null = null
  function onLoad(doc: Document) {
    if (import.meta.env.DEV) lastDoc = doc
  }

  /**
   * Dev-only diagnostics hook. foliate renders into a **closed** shadow DOM, so an
   * automated harness has no other way to reach the content document and measure how
   * accurately a tap point resolves to a glyph. Guarded by `import.meta.env.DEV`, so it
   * is dead code (tree-shaken) in the production build. Removed again on destroy.
   */
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
    // Both are off the critical path's own work, so start them before the first await:
    // foliate's lazily imported chunks (else fetched serially inside view.open), and the
    // lookup worker's kuromoji build (in a worker, so it doesn't contend with the open).
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
        onLoad,
        onTap,
        onTurn,
        onSelection,
        onSelectionCleared,
        onShowAnnotation,
        onKey,
      })
      // Seed the highlight set *before* opening: the opening section's `create-overlay`
      // then draws its own highlights on the normal per-section path during init, and
      // every other section draws when it loads — no whole-book sweep at open.
      controller.setHighlights(annotations.items.filter((a) => a.kind === 'highlight').map((a) => a.cfi))
      appliedTheme = appearance.resolved
      await controller.open(file, progress?.cfi)
      if (destroyed) return
      status = 'ready'
      toc = controller.view.book?.toc ?? []
      rtlBook = controller.bookDir === 'rtl'
      buildChapterIndex()
      installDevHook()

      // Flush the position on background/close; shed / re-warm the lookup worker as the
      // PWA is backgrounded / foregrounded (see onVisibility).
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
    // Free the worker's resident kuromoji trie while no book is open (re-warmed on
    // the next open from the SW-cached dict — no network).
    disposeLookup()
    clearAnnotations()
    // Drop any retained content Document / Range / Text-node refs so the closed book's
    // last section can't be pinned past unmount.
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
    <!-- A slow open (a large book, a cold iOS launch) must never trap the reader here. -->
    <LoadingScreen title={loadingTitle} onback={openShelf} />
  {:else if status === 'error'}
    <div class="overlay error" role="alert">
      <p>{errorMsg}</p>
      <button class="btn btn-tinted" onclick={openShelf}>Back to library</button>
    </div>
  {/if}

  <!-- The page is bookmarked: a small accent ribbon on the fore-edge corner. Purely
       decorative (pointer-events:none, no backdrop-filter — it stays put during a slide). -->
  {#if status === 'ready' && isBookmarked}
    <div class="ribbon" class:rtl={rtlBook} aria-hidden="true"></div>
  {/if}

  {#if status === 'ready' && chromeVisible}
    <!-- Floating glass capsules. They stay inside the top/bottom chrome-toggle band
         (inChromeToggleBand), so a tap where they appear always toggles them. -->
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

  <!-- Persistent reading-position readout at the bottom centre, shown while the
       chrome is hidden (the bottom bar carries its own progress when visible).
       pointer-events:none so it never intercepts taps/swipes; no backdrop-filter, since
       it stays on screen through every page slide. -->
  {#if status === 'ready' && !chromeVisible}
    <div class="page-pct" aria-hidden="true" transition:fade={{ duration: dur(DUR.fast) }}>
      {Math.round(fraction * 100)}%
    </div>
  {/if}
</div>

<Sheet bind:open={tocOpen} title="Contents">
  <TocSheet {toc} currentId={currentTocId} currentLabel={sectionLabel} onnavigate={navigate} />
</Sheet>

<!-- Live-preview panel: an undimmed popover under Aa on iPad, a bottom sheet with a clear
     scrim on phones — so text changes are judged against the page itself. -->
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
    /* Same reason as the injected content stylesheet: no double-tap zoom over the reading
       surface, because a scaled visual viewport disables tap-to-define and page turns. */
    touch-action: manipulation;
  }
  .view-host {
    position: absolute;
    inset: 0;
    /* keep text clear of the notch / home indicator even when chrome is hidden */
    padding: var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left);
    box-sizing: border-box;
  }

  /* ── Floating glass capsules ──
     Height budget: both must end inside the chrome-toggle band (12% of the viewport,
     clamped 80–160px). iPad landscape (834px → 100px band): top ends at
     safe-top + 12 + 52 ≈ 88px, bottom starts ≈ 88px above the edge. */
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

  /* Standalone reading-% readout, centred at the very bottom of the screen. */
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

  /* Bookmark ribbon: hangs from the top fore-edge corner of the page. */
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
