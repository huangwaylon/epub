/**
 * Chapter lookups over the book's TOC: section-start fractions for the scrubber preview,
 * and the TOC labels in reading order for the annotations panel. Pure.
 */
import type { TocItem } from './reader/types'

export interface ChapterStart {
  /** The chapter's section start as a whole-book fraction (0..1). */
  start: number
  label: string
}

/**
 * Each labelled TOC entry's section start (`fractions[index]` of the section its href
 * resolves to), ascending; entries sharing a start keep the first in TOC order.
 */
export function buildChapterIndex(
  toc: TocItem[],
  fractions: number[],
  resolveHref: ((href: string) => { index: number } | null | undefined) | undefined,
): ChapterStart[] {
  if (!fractions.length || !resolveHref) return []
  const out: ChapterStart[] = []
  const walk = (items: TocItem[]) => {
    for (const it of items) {
      const label = it.label?.trim()
      if (it.href && label) {
        try {
          const r = resolveHref(it.href)
          if (r && r.index >= 0 && fractions[r.index] !== undefined) out.push({ start: fractions[r.index], label })
        } catch {
          /* unresolvable href — skip */
        }
      }
      if (it.subitems?.length) walk(it.subitems)
    }
  }
  walk(toc)
  out.sort((a, b) => a.start - b.start) // stable: the first of a shared start stays first
  return out.filter((c, i) => i === 0 || c.start > out[i - 1].start)
}

/** The label of the chapter containing book fraction `f`, else ''. */
export function chapterAt(starts: ChapterStart[], f: number): string {
  let label = ''
  for (const c of starts) {
    if (c.start <= f + 1e-6) label = c.label
    else break
  }
  return label
}

/** TOC labels in reading order (the annotations panel groups by these). */
export function chapterOrder(toc: TocItem[]): string[] {
  const out: string[] = []
  const walk = (items: TocItem[]) => {
    for (const it of items) {
      if (it.label?.trim()) out.push(it.label.trim())
      if (it.subitems?.length) walk(it.subitems)
    }
  }
  walk(toc)
  return out
}
