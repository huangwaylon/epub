// Pure EPUB-CFI helpers over foliate's parser (no DOM, no foliate-view), so the reader
// controller and the reader UI can share them and they can be unit-tested in Node.
// @ts-ignore — vendored JS module, no type declarations
import { parse, collapse, compare } from '../vendor/foliate-js/epubcfi.js'

/** A CFI parsed once and collapsed to its start point, so repeated comparisons don't
 *  re-tokenise the string (foliate's `compare` parses string arguments on every call). */
type Point = unknown

function startPoint(cfi: string): Point | null {
  if (!cfi) return null
  try {
    const p = collapse(parse(cfi))
    return Array.isArray(p) && p.length ? p : null
  } catch {
    return null
  }
}

function cmp(a: Point, b: Point): number {
  try {
    return compare(a, b)
  } catch {
    return 0
  }
}

/**
 * Order `cfis` so the ones nearest to `here` come first: parse each CFI once, sort into
 * document order, binary-search where `here` falls, then walk outward from that point
 * (alternating the next one at/after `here` with the next one before it).
 *
 * This is what lets a section with hundreds of vocab highlights paint the page the reader
 * is actually looking at in the first draw chunk. (Sorting by `Math.abs(compare(...))`
 * does not work: `compare` returns only -1/0/1, so every CFI had "distance" 1 and the
 * sort was a no-op.) CFIs that fail to parse keep their relative order at the end.
 */
export function nearestFirst(cfis: readonly string[], here: string): string[] {
  const h = startPoint(here)
  if (!h) return [...cfis]
  const ok: { cfi: string; p: Point }[] = []
  const bad: string[] = []
  for (const cfi of cfis) {
    const p = startPoint(cfi)
    if (p) ok.push({ cfi, p })
    else bad.push(cfi)
  }
  ok.sort((a, b) => cmp(a.p, b.p))
  // First index whose point is at/after `here`.
  let lo = 0
  let hi = ok.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cmp(ok[mid].p, h) < 0) lo = mid + 1
    else hi = mid
  }
  const out: string[] = []
  let after = lo
  let before = lo - 1
  while (after < ok.length || before >= 0) {
    if (after < ok.length) out.push(ok[after++].cfi)
    if (before >= 0) out.push(ok[before--].cfi)
  }
  return out.concat(bad)
}

/**
 * Whether `cfi` (its start point) lies within the page described by `pageCfi` — the range
 * CFI foliate reports on `relocate` for the visible page: start inclusive, end exclusive
 * (the next page begins where this one ends). A non-range `pageCfi` degrades to equality.
 * Used for "is this page bookmarked?", which must survive a reflow (font size, rotation)
 * that moves the page boundaries away from the exact CFI the bookmark was saved at.
 */
export function cfiWithinPage(cfi: string, pageCfi: string): boolean {
  if (!cfi || !pageCfi) return false
  if (cfi === pageCfi) return true
  try {
    const page = parse(pageCfi)
    const p = startPoint(cfi)
    if (!p) return false
    if (!page.parent) return cmp(p, collapse(page)) === 0
    return cmp(p, collapse(page)) >= 0 && cmp(p, collapse(page, true)) < 0
  } catch {
    return false
  }
}
