/**
 * English translation state for the open book (docs/translation.md, reader-engine.md §4a):
 * detection, show-all bookkeeping, single-unit reveals, and keeping the page across the
 * reflow a show / hide causes. The stylesheet itself is `appearanceCSS`.
 */
import {
  EN_CLASS,
  EN_META_SELECTOR,
  EN_SHOWN_CLASS,
  englishAncestor,
  packageHasEnglish,
  textBeside,
  textFrom,
} from '../translation'
import type { CharAt, FoliateView } from './types'

export class EnglishState {
  #view: FoliateView
  #docIndex: WeakMap<Document, number>
  #onEnglish: () => void
  /** The book carries English: the package meta, or a loaded section's meta. */
  #has = false
  /** `settings.showEnglish` as last applied (the settings object is mutated in place). */
  #showAll: boolean
  /** Individually revealed units (`data-tz`) per spine index, for this session; re-applied
   *  on section load, cleared when show-all changes. */
  #revealed = new Map<number, Set<string>>()

  constructor(view: FoliateView, docIndex: WeakMap<Document, number>, showAll: boolean, onEnglish: () => void) {
    this.#view = view
    this.#docIndex = docIndex
    this.#showAll = showAll
    this.#onEnglish = onEnglish
  }

  get has(): boolean {
    return this.#has
  }

  #mark(): void {
    if (this.#has) return
    this.#has = true
    this.#onEnglish()
  }

  /** At open: the package metadata declares English, so `has` is known even on an
   *  untranslated section (e.g. the cover). */
  detect(): void {
    if (packageHasEnglish(this.#view.book?.resources?.opf)) this.#mark()
  }

  /** A section loaded: its meta also counts (books built without the package meta), and
   *  its revealed units are re-applied. */
  onLoad(doc: Document, index: number): void {
    if (!doc.querySelector(EN_META_SELECTOR)) return
    this.#mark()
    for (const tz of this.#revealed.get(index) ?? [])
      doc.querySelector(`.${EN_CLASS}[data-tz="${tz}"]`)?.classList.add(EN_SHOWN_CLASS)
  }

  /**
   * Before a stylesheet swap: when show-all changes, clear individual reveals and return
   * the character at the page centre to keep (else `null`); pass it to `keepPage` after.
   */
  setShowAll(on: boolean): CharAt | null {
    if (on === this.#showAll) return null
    this.#showAll = on
    const keep = this.#pageCentre()
    this.#revealed.clear()
    for (const { doc } of this.#view.renderer?.getContents?.() ?? [])
      for (const el of Array.from((doc as Document).querySelectorAll(`.${EN_SHOWN_CLASS}`))) el.classList.remove(EN_SHOWN_CLASS)
    return keep
  }

  /** The unit whose English is `en` is individually revealed. */
  isRevealed(en: Element): boolean {
    return en.classList.contains(EN_SHOWN_CLASS)
  }

  /**
   * Reveal / hide one unit's English (while show-all is off); kept for the session. The
   * page stays on `at` (the tapped glyph) when given — nothing before the English moves.
   * Else a reveal keeps the page's first character (the unit may continue onto the next
   * page, so its last character is no anchor) and a hide the unit's last Japanese one.
   */
  setRevealed(en: Element, on: boolean, at?: CharAt | null): void {
    const index = this.#docIndex.get(en.ownerDocument)
    const tz = en.getAttribute('data-tz')
    if (index === undefined || tz === null) return
    let set = this.#revealed.get(index)
    if (on) {
      if (!set) this.#revealed.set(index, (set = new Set()))
      set.add(tz)
    } else set?.delete(tz)
    let keep: CharAt | null = at?.node.isConnected ? at : null
    if (!keep && on) keep = this.#pageStart()
    else if (!keep) {
      const t = textBeside(en, 'prev')
      if (t) keep = { node: t, offset: t.data.length - 1 }
    }
    en.classList.toggle(EN_SHOWN_CLASS, on)
    this.keepPage(keep)
  }

  /**
   * Keep the page across an English show / hide. foliate re-scrolls to its own anchor on
   * the reflow, but that anchor can be stale, start in now-hidden English, or have its
   * first rect on the previous page. So anchor on one character sampled before the change
   * (see `setRevealed` for a single unit; for show-all, the character at the page centre)
   * — moved to the Japanese before it if it is English now hidden.
   */
  keepPage(at: CharAt | null): void {
    if (!at) return
    try {
      let { node, offset } = at
      const en = englishAncestor(node)
      if (en && en.ownerDocument.defaultView?.getComputedStyle(en).display === 'none') {
        const t = textBeside(en, 'prev')
        if (!t?.data.length) return
        node = t
        offset = t.data.length - 1
      }
      const r = node.ownerDocument.createRange()
      r.setStart(node, offset)
      r.setEnd(node, offset + 1)
      this.#view.renderer?.scrollToAnchor?.(r)
    } catch {
      /* detached */
    }
  }

  /** The first character of the visible range (refreshed after every scroll, including our
   *  re-anchors), outside English and furigana. */
  #pageStart(): CharAt | null {
    const r: Range | undefined = this.#view.lastLocation?.range
    try {
      return r ? textFrom(r.startContainer, r.startOffset) : null
    } catch {
      return null
    }
  }

  /** The character under the centre of the view, if it is text. */
  #pageCentre(): CharAt | null {
    const doc: Document | undefined = this.#view.renderer?.getContents?.()[0]?.doc
    const fr = (doc?.defaultView?.frameElement as HTMLElement | null | undefined)?.getBoundingClientRect()
    if (!doc || !fr) return null
    const host = this.#view.getBoundingClientRect()
    const x = host.left + host.width / 2 - fr.left
    const y = host.top + host.height / 2 - fr.top
    const any = doc as any
    let node: Node | null = null
    let offset = 0
    try {
      const r: Range | null = any.caretRangeFromPoint?.(x, y) ?? null
      if (r) ({ startContainer: node, startOffset: offset } = r)
      else {
        const p = any.caretPositionFromPoint?.(x, y)
        node = p?.offsetNode ?? null
        offset = p?.offset ?? 0
      }
    } catch {
      return null
    }
    if (node?.nodeType !== 3 || !(node as Text).data.length) return null
    return { node: node as Text, offset: Math.min(offset, (node as Text).data.length - 1) }
  }
}
