// Pure EPUB-CFI helpers over foliate's parser (no DOM), unit-tested in Node.
// @ts-ignore — vendored JS module, no type declarations
import { parse, collapse, compare } from '../vendor/foliate-js/epubcfi.js'

/** A CFI parsed once and collapsed to its start (`compare` re-parses strings per call). */
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
 * Order `cfis` nearest-first around `here`: sort in document order, binary-search `here`,
 * then alternate outward (at/after, before). Unparseable CFIs go last, in input order.
 * (`compare` returns only -1/0/1, so it can't serve as a distance.)
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
 * Whether `cfi`'s start lies in the page range `pageCfi` (relocate's CFI): start inclusive,
 * end exclusive; a non-range `pageCfi` means equality. Survives reflow, unlike `===`.
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
