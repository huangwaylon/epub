/**
 * English translation state for the open book (docs/translation.md, reader-engine.md §4a):
 * detection, show-all bookkeeping, and keeping the page across the reflow show / hide all
 * causes. The stylesheet itself is `appearanceCSS`; a single unit's English is read into
 * the dictionary card (`unitEnglish`), never revealed in the page.
 */
import { EN_META_SELECTOR, englishAncestor, packageHasEnglish, textBeside } from '../translation'
import type { CharAt, FoliateView } from './types'

export class EnglishState {
  #view: FoliateView
  #onEnglish: () => void
  /** The book carries English: the package meta, or a loaded section's meta. */
  #has = false
  /** `settings.showEnglish` as last applied (the settings object is mutated in place). */
  #showAll: boolean

  constructor(view: FoliateView, showAll: boolean, onEnglish: () => void) {
    this.#view = view
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

  /** A section loaded: its meta also counts (books built without the package meta). */
  onLoad(doc: Document): void {
    if (doc.querySelector(EN_META_SELECTOR)) this.#mark()
  }

  /**
   * Before a stylesheet swap: when show-all changes, return the character at the page
   * centre to keep (else `null`); pass it to `keepPage` after.
   */
  setShowAll(on: boolean): CharAt | null {
    if (on === this.#showAll) return null
    this.#showAll = on
    return this.#pageCentre()
  }

  /**
   * Keep the page across show / hide all. foliate re-scrolls to its own anchor on the
   * reflow, but that anchor can be stale, start in now-hidden English, or have its first
   * rect on the previous page. So anchor on the character sampled at the page centre
   * before the change — moved to the Japanese before it if it is English now hidden.
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
