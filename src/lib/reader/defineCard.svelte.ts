/**
 * The dictionary card's state machine (reader-engine.md §8, §11): open on a tapped word or
 * a tapped highlight, run the lookup (stale results dropped by key), highlight the match,
 * the footer highlight toggle, the card's Translation (the tapped unit's English), and the
 * retry once the dictionary is downloaded. `Reader.svelte` routes taps here and renders `state`.
 */
import { untrack } from 'svelte'
import { settings } from '../../stores/settings.svelte'
import { dict } from '../../stores/dict.svelte'
import { isHighlighted, highlightAt } from '../../stores/annotations.svelte'
import type { ReaderController, TapInfo } from '../../services/reader'
import { extractTextAt, rangeForSpan, type CharPosition } from '../../services/jp/extract'
import { lookupAt, type LookupResult } from '../../services/jp/lookupClient'
import { isDictReady, downloadAndWarmDictionary } from '../../services/jp/dictdb'
import type { AnchorRect } from '../util/anchoredPosition'

export interface DefineCardState {
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
  /** The tapped unit's English ('' = none: untranslated, or show-all on — it is on the page). */
  translation: string
  /** The Translation section is expanded. */
  translationOpen: boolean
}

export interface DefineCardDeps {
  controller: () => ReaderController | null
  /** Reader's single highlight create / remove pair (paint + record). */
  addHighlight: (cfi: string, text: string) => void
  removeHighlight: (cfi: string) => void
  /** The unit's English for the card's Translation, or `null` (none, or show-all on). */
  englishFor: (node: Node | null | undefined) => Element | null
}

/** A rect inside a content document → top-window coordinates. */
function rectInTop(doc: Document, r: DOMRect | DOMRectReadOnly): AnchorRect {
  const fr = (doc.defaultView?.frameElement as HTMLElement | null)?.getBoundingClientRect()
  const ox = fr?.left ?? 0
  const oy = fr?.top ?? 0
  return { left: ox + r.left, top: oy + r.top, right: ox + r.right, bottom: oy + r.bottom }
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

/** Create during component init (it registers an `$effect`). */
export function createDefineCard(deps: DefineCardDeps) {
  const state = $state<DefineCardState>({
    open: false, anchor: null, vertical: false, loading: false, needsDownload: false, result: null,
    text: '', tapOffset: 0, lastKey: '', cfi: '', highlighted: false, word: '', translation: '',
    translationOpen: false,
  })

  // Live DOM for the in-flight define (plain refs, not $state).
  let defineDoc: Document | null = null
  let definePositions: CharPosition[] = []
  /** The tapped unit's `.tsuzuri-en`. A card on the unit whose Translation was left open
   *  opens expanded (mining one sentence's words); any other unit opens collapsed. Weak,
   *  so it never pins a navigated-away section. */
  let defineEnglish: Element | null = null
  let expandedEnglish: WeakRef<Element> | null = null

  // Our tap and foliate's highlight `click` (show-annotation) share a gesture. The tap runs
  // immediately — never delay it — and the click stands down behind these stamps.
  let tapDefinedAt = 0
  let tapDefinedKey = ''
  let tapDismissedAt = 0

  /** Close the card and release the define DOM refs, so a navigated-away section can be
   *  collected. (Reader's `closeOverlays` also closes the selection toolbar.) */
  function close() {
    state.open = false
    state.anchor = null
    defineDoc = null
    definePositions = []
    defineEnglish = null
  }

  /** A tap while the card is open only dismisses it; the caller then closes the overlays. */
  function noteDismissTap() {
    tapDismissedAt = Date.now()
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
      english: deps.englishFor(ex.positions[ex.tapOffset]?.node),
    })
    tapDefinedAt = Date.now()
    tapDefinedKey = state.lastKey
    return true
  }

  /**
   * A `click` hit an existing highlight. Returns whether the card was (re)opened for it —
   * the caller then closes the selection toolbar. This click rides the same gesture as our
   * tap: after a dismissing tap it stands down; after a defining tap it keeps the tap's
   * lookup but adopts this highlight, so Remove clears what was tapped (e.g. an enclosing
   * phrase highlight) rather than a nested word.
   */
  function showAnnotation(value: string, range: Range): boolean {
    if (Date.now() - tapDismissedAt < 500) return false
    if (Date.now() - tapDefinedAt < 500) {
      if (state.open && state.lastKey === tapDefinedKey && !state.cfi) {
        state.cfi = value
        state.word = highlightAt(value)?.text || state.word
        state.highlighted = true
      }
      return false
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
    openDefine({
      text: word,
      tapOffset: 0,
      anchor: anchor ?? { left: 0, top: 0, right: 0, bottom: 0 },
      existingCfi: value,
      word,
      english: deps.englishFor(range.startContainer),
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
    /** The unit's English, for the card's Translation. */
    english?: Element | null
  }) {
    const controller = deps.controller()
    const key = `${o.existingCfi ?? ''}:${o.tapOffset}:${o.text}`
    const retarget = state.open
    defineDoc = o.doc ?? null
    definePositions = o.positions ?? []
    defineEnglish = o.english ?? null
    // Plain text (build.mjs writes no markup inside); readable while display:none.
    state.translation = defineEnglish?.textContent?.trim() ?? ''
    state.translationOpen = !!state.translation && defineEnglish === expandedEnglish?.deref()
    state.open = true
    state.anchor = o.anchor
    state.vertical = controller?.vertical ?? false
    state.loading = true
    state.needsDownload = false
    if (!retarget) state.result = null
    state.text = o.text
    state.tapOffset = o.tapOffset
    state.lastKey = key
    state.cfi = o.existingCfi ?? ''
    state.word = o.word ?? ''
    state.highlighted = !!o.existingCfi
    void runLookup(o.text, o.tapOffset, key)
  }

  async function runLookup(text: string, tapOffset: number, key: string) {
    const stale = () => !state.open || state.lastKey !== key
    try {
      if (!(await isDictReady())) {
        if (stale()) return
        state.loading = false
        state.result = null
        state.needsDownload = true
        // No word lookup yet: the translation is what this tap can give.
        if (state.translation) state.translationOpen = true
        return
      }
      const res = await lookupAt(text, tapOffset)
      if (stale()) return
      state.loading = false
      state.result = res
      if (res && res.entries.length && !state.cfi && defineDoc && definePositions.length) highlightMatch(res, key)
    } catch (err) {
      // e.g. IndexedDB refused to open: never leave the card spinning.
      console.warn('Lookup failed', err)
      if (stale()) return
      state.loading = false
      state.result = null
    }
  }

  /** Highlight the matched word and re-anchor the card to it. Synchronous, so a newer tap
   *  can't have its card state overwritten by this word's CFI. */
  function highlightMatch(res: LookupResult, key: string) {
    const controller = deps.controller()
    if (!controller || !defineDoc) return
    const start = res.matchStart
    const end = res.matchStart + res.matchLength
    const range = rangeForSpan(defineDoc, definePositions, start, end)
    if (!range) return
    const cfi = controller.cfiForSelection(defineDoc, range)
    if (!cfi || !state.open || state.lastKey !== key) return
    // Not range.toString(): a range over ruby splices in the furigana (決けっ心).
    const word = definePositions
      .slice(start, end)
      .map((c) => c.node.data.charAt(c.offset))
      .join('')
    try {
      state.anchor = rectInTop(defineDoc, range.getBoundingClientRect())
    } catch {
      /* keep the glyph anchor */
    }
    // With "Highlight looked-up words" off the CFI still backs the footer toggle.
    const mark = settings.highlightLookups || isHighlighted(cfi)
    if (mark) deps.addHighlight(cfi, word)
    state.cfi = cfi
    state.word = word
    state.highlighted = mark
  }

  /** Popup footer toggle; keeps the card open. */
  function toggleWordHighlight() {
    if (!deps.controller() || !state.cfi) return
    if (state.highlighted) deps.removeHighlight(state.cfi)
    else deps.addHighlight(state.cfi, state.word)
    state.highlighted = !state.highlighted
  }

  /** Card action: expand / collapse the Translation. The page never changes. */
  function toggleTranslation() {
    if (!state.translation) return
    state.translationOpen = !state.translationOpen
    expandedEnglish = state.translationOpen && defineEnglish ? new WeakRef(defineEnglish) : null
  }

  /** A highlight record at `cfi` was deleted / restored elsewhere (the panel, its Undo). */
  function highlightChanged(cfi: string, highlighted: boolean) {
    if (state.cfi === cfi) state.highlighted = highlighted
  }

  // The card doesn't wait for the IPADIC warm: the effect below re-runs the pending lookup
  // as soon as JMdict is queryable. jpdict-idb reports the words series 'ok' early in the
  // download (~17%), so a card still empty once the download and warm finish looks again.
  async function downloadDict() {
    try {
      await downloadAndWarmDictionary('en')
    } catch {
      /* error surfaced via the dict store */
    }
    if (state.open && !state.loading && !state.needsDownload && !state.result?.entries.length) {
      state.loading = true
      void runLookup(state.text, state.tapOffset, state.lastKey)
    }
  }
  $effect(() => {
    if (state.open && state.needsDownload && dict.state === 'ok')
      untrack(() => {
        state.needsDownload = false
        state.loading = true
        void runLookup(state.text, state.tapOffset, state.lastKey)
      })
  })

  return {
    state,
    close,
    noteDismissTap,
    tryDefine,
    showAnnotation,
    toggleWordHighlight,
    toggleTranslation,
    highlightChanged,
    downloadDict,
  }
}
