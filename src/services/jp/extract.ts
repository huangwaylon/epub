/**
 * Extracts the text needed to look up the word at a tap point. Two jobs:
 *
 * 1. **Resolve the glyph under the point** (`resolveGlyph`). The caret APIs return the
 *    nearest caret *boundary*, not the character containing the point, so the caret is
 *    only a seed — the tapped character is then decided from measured glyph boxes.
 * 2. **Gather the word's neighbourhood.** So that tapping *any* character of a word
 *    resolves the whole word (not just the run from the tapped character onward), we
 *    collect the contiguous Japanese run on **both** sides of the tap and report the
 *    tap's offset within it; `lookup.ts` then segments that run and returns the word
 *    covering the tap. Furigana (<rt>/<rp>) is excluded from the run, and a tap that
 *    lands *on* furigana is redirected to the base text it annotates.
 */

export interface Extracted {
  /** Contiguous Japanese run around the tap (rt/rp excluded, clause-bounded). */
  text: string
  /** Index within `text` of the tapped character. */
  tapOffset: number
  /**
   * DOM location of each character in `text`: `positions[i]` is where `text[i]`
   * lives. Lets the caller rebuild a `Range` for any sub-span of the run — e.g.
   * to highlight the matched word `[matchStart, matchStart + matchLength)` after
   * a lookup. (The run can straddle multiple text nodes — a kanji compound with
   * ruby splits its base text — so an index→node map is the only safe bridge.)
   */
  positions: CharPosition[]
}

/** The DOM location of a single character in the extracted run. */
export interface CharPosition {
  node: Text
  offset: number
}

/** How many word-chars to gather before / after the tap (also stops at boundaries). */
const MAX_BEFORE = 12
const MAX_AFTER = 16

/** Characters that can be part of a Japanese word: kana, CJK ideographs, the
 *  long-vowel mark (ー) and the iteration mark (々). Anything else — punctuation,
 *  spaces, latin, digits — is a word boundary that bounds the lookup run.
 *  Ranges: hiragana+katakana (U+3040–30FF), CJK Ext-A + Unified (U+3400–9FFF),
 *  and CJK Compatibility Ideographs (U+F900–FAFF). NOTE: the compat-block start
 *  glyph below is U+F900, which is visually identical to the CJK-Unified U+8C48 —
 *  do not retype it. Using U+8C48 here would span U+8C48–FAFF and wrongly include
 *  the UTF-16 surrogate range (U+D800–DFFF), matching lone surrogate halves. (The
 *  run is iterated per UTF-16 unit, so astral CJK — Ext-B+ — is out of scope.) */
const WORD_CHAR = /[぀-ヿ㐀-鿿豈-﫿ー々]/

function caretPosition(doc: Document, x: number, y: number): { node: Node; offset: number } | null {
  const anyDoc = doc as any
  // WebKit implements caretRangeFromPoint; the standard caretPositionFromPoint is
  // the fallback for engines that prefer it. Try the WebKit one first. Both are
  // wrapped defensively — a hostile coordinate or detached doc should fall through
  // to the next strategy (or to "no hit"), never throw out of the tap handler.
  try {
    if (anyDoc.caretRangeFromPoint) {
      const r: Range | null = anyDoc.caretRangeFromPoint(x, y)
      if (r) return { node: r.startContainer, offset: r.startOffset }
    }
  } catch {
    /* fall through to caretPositionFromPoint */
  }
  try {
    if (anyDoc.caretPositionFromPoint) {
      const p = anyDoc.caretPositionFromPoint(x, y)
      if (p) return { node: p.offsetNode, offset: p.offset }
    }
  } catch {
    /* no caret at point */
  }
  return null
}

/**
 * Minimum hit slack (px) on every side. Acts as a floor when there's no leading to
 * borrow (text set solid at line-height ~1), and forgives a small near-miss just past
 * the first / last glyph of a line.
 */
const MIN_HIT_SLACK = 6
/**
 * Reading-axis slack, as a fraction of the font size, added on top of the floor. Along
 * the reading axis glyphs are contiguous (Japanese has no inter-word spaces), so this
 * only needs to forgive a small near-miss past a glyph — not fill a gap. Kept modest so
 * a tap well past the last glyph of a column / line (blank space) still falls through.
 */
const READING_SLACK_EM = 0.15

/** A glyph's tap target: its measured box plus per-axis slack, in px. */
interface GlyphSlack {
  /** Slack along the page's x axis. */
  x: number
  /** Slack along the page's y axis. */
  y: number
}

/**
 * Per-axis tap slack derived from the line metrics at `el`, so the hit target grows
 * with the line spacing and text size rather than being a flat margin.
 *
 * The line-stacking ("cross") axis carries the leading: with line-height 1.9 at 16px
 * the columns sit ~26px apart but each glyph is only ~16px wide, leaving a ~13px gap
 * on each side. We expand the box by **half the leading** in that axis so the *whole*
 * line/column pitch is tappable and maps to the nearest line — full coverage, and no
 * overlap with the neighbour (each side reaches exactly the midpoint). The reading
 * axis, where glyphs are contiguous, only gets a small font-scaled slack.
 *
 * `leading = lineHeight − fontSize` assumes the glyph spans ~1em across the cross axis,
 * which holds because lookups are gated to CJK/kana (`WORD_CHAR`) — roughly square
 * glyphs. (Widen `WORD_CHAR` to proportional/latin and this estimate would need the
 * glyph's real cross-extent instead.)
 *
 * The slack only ever decides whether a *near-miss* still counts as a tap on that glyph
 * (`hitDistance`); which glyph gets resolved is settled geometrically by `resolveGlyph`.
 * Keep it from ballooning: a page of Japanese is wall-to-wall glyphs, and the blank-space
 * fall-through (chrome toggle / dismiss) depends on some taps missing every glyph.
 *
 * In vertical (縦書き) writing the columns stack horizontally, so the cross axis is x;
 * in horizontal writing the lines stack vertically, so the cross axis is y. We treat
 * every non-`horizontal-*` mode (vertical-rl/-lr, sideways-rl/-lr) as vertical, since
 * all of them stack lines horizontally. A missing view/element falls back to a flat
 * floor on both axes.
 */
function glyphSlack(win: Window | null, el: Element | null): GlyphSlack {
  const cs = win && el ? win.getComputedStyle(el) : null
  const vertical = cs ? !cs.writingMode.startsWith('horizontal') : false
  const fontSize = (cs && parseFloat(cs.fontSize)) || 16
  // `line-height: normal` yields no numeric px; approximate it so the math still holds.
  let lineHeight = cs ? parseFloat(cs.lineHeight) : NaN
  if (!isFinite(lineHeight)) lineHeight = fontSize * 1.5
  const leading = Math.max(0, lineHeight - fontSize)
  const crossSlack = leading / 2 + MIN_HIT_SLACK
  const readingSlack = MIN_HIT_SLACK + fontSize * READING_SLACK_EM
  // Vertical: cross axis is x (columns stack horizontally). Horizontal: cross axis is y.
  return vertical ? { x: crossSlack, y: readingSlack } : { x: readingSlack, y: crossSlack }
}

/** The character actually under the tap point (as opposed to the nearest caret). */
interface GlyphHit {
  node: Text
  offset: number
  /** 0 when the point is inside the glyph's own box; otherwise how far outside (px). */
  distance: number
}

/**
 * The measured box of a single character.
 *
 * Takes the **largest-area** client rect rather than any/all of them. A one-character
 * range normally has exactly one rect, but WebKit also emits a degenerate (zero-extent)
 * rect at the end of the *previous* line for a range sitting at a line start — in
 * 縦書き the previous line is the column to the **right**, so accepting any rect lets a
 * tap in one column validate a glyph in another. Per CSSOM-View the rect is the
 * character's **font box** (ascent+descent × advance), *not* the line box, so it does
 * not include the leading — which is why `glyphSlack` adds that itself.
 */
function charRect(doc: Document, node: Text, offset: number): DOMRect | null {
  if (offset < 0 || offset >= node.data.length) return null
  const range = doc.createRange()
  try {
    range.setStart(node, offset)
    range.setEnd(node, offset + 1)
  } catch {
    return null
  }
  let best: DOMRect | null = null
  for (const r of range.getClientRects()) {
    if (!r.width || !r.height) continue
    if (!best || r.width * r.height > best.width * best.height) best = r
  }
  return best
}

/**
 * How far (x, y) is from a character's tap target: `0` when the point is inside the
 * glyph's own box, the px overflow when it is merely within `slack`, and `null` when it
 * is outside the target altogether (so the tap falls through to chrome / dismiss).
 */
function hitDistance(r: DOMRect, x: number, y: number, slack: GlyphSlack): number | null {
  const dx = Math.max(r.left - x, x - r.right, 0)
  const dy = Math.max(r.top - y, y - r.bottom, 0)
  if (dx > slack.x || dy > slack.y) return null
  return dx + dy
}

function isInRuby(node: Node): boolean {
  let el = node.parentElement
  while (el) {
    // XHTML keeps tag names lowercase, so compare case-insensitively.
    const tag = el.tagName.toUpperCase()
    if (tag === 'RT' || tag === 'RP') return true
    el = el.parentElement
  }
  return false
}

/** Trailing run of word-chars in `cells` (its suffix), capped at `max` cells. */
function trailingRun(cells: CharPosition[], max: number): CharPosition[] {
  let i = cells.length
  let n = 0
  while (i > 0 && n < max && WORD_CHAR.test((cells[i - 1].node as Text).data.charAt(cells[i - 1].offset))) {
    i--
    n++
  }
  return cells.slice(i)
}

/** Leading run of word-chars in `cells` (its prefix), capped at `max` cells. */
function leadingRun(cells: CharPosition[], max: number): CharPosition[] {
  let i = 0
  const cap = Math.min(cells.length, max)
  while (i < cap && WORD_CHAR.test(cells[i].node.data.charAt(cells[i].offset))) i++
  return cells.slice(0, i)
}

/** A TreeWalker over the document's text nodes, skipping furigana. */
function textWalker(doc: Document): TreeWalker {
  return doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (isInRuby(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
}

/** The text node before / after `node` in document order (furigana skipped). */
function siblingText(doc: Document, node: Text, dir: 'prev' | 'next'): Text | null {
  const w = textWalker(doc)
  try {
    w.currentNode = node
  } catch {
    return null
  }
  return (dir === 'prev' ? w.previousNode() : w.nextNode()) as Text | null
}

/**
 * A tap that landed in furigana resolves to the character of the **base** text it
 * annotates. In 縦書き the annotation column sits immediately beside the base within the
 * same line box, so a tap aimed at the base easily lands in the reading (and in 横書き
 * the same happens above it) — looking up the reading instead of the word is both wrong
 * and, because the user compensates by aiming away from the annotation, the thing that
 * makes tapping feel misaligned. Ruby bases are one to a few characters, so scanning
 * every base character of the enclosing `<ruby>` and taking the nearest is trivial.
 */
function rubyBaseHit(doc: Document, node: Text, x: number, y: number): GlyphHit | null {
  let el: Element | null = node.parentElement
  while (el && el.tagName.toUpperCase() !== 'RUBY') el = el.parentElement
  if (!el) return null
  const w = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (isInRuby(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  let best: GlyphHit | null = null
  let t: Text | null
  while ((t = w.nextNode() as Text | null)) {
    for (let k = 0; k < t.data.length; k++) {
      const r = charRect(doc, t, k)
      if (!r) continue
      const dx = Math.max(r.left - x, x - r.right, 0)
      const dy = Math.max(r.top - y, y - r.bottom, 0)
      const d = dx + dy
      if (!best || d < best.distance) best = { node: t, offset: k, distance: d }
    }
  }
  return best
}

/**
 * Resolves the glyph under (x, y) — the heart of tap accuracy.
 *
 * `caretRangeFromPoint` / `caretPositionFromPoint` return the nearest **caret boundary**,
 * not the character containing the point: both WebKit and Blink pick the next character
 * once the point passes the current glyph's mid-advance (WebKit's
 * `offsetForPosition(…, includePartialGlyphs: true)`). Taking that offset as "the tapped
 * character" therefore mis-resolves the whole far half of every glyph — measured in this
 * app against a real novel, taps in the far ~40% of each glyph resolved the *next*
 * character (≈35% of the glyph area looked up the following word, and another ≈5–13%
 * resolved punctuation or ran off the end of the text node and defined nothing at all).
 * Along the reading axis that is "one character late": rightwards in 横書き, downwards in
 * 縦書き — which is why aiming further back (left / up) appeared to work better.
 *
 * So we use the caret only as a *seed* and then decide geometrically: measure the seed
 * character and its predecessor (plus the adjacent text node when the seed sits on a node
 * boundary) and keep whichever box the point actually falls in. This is engine-independent
 * — it corrects the mid-glyph rule, WebKit's line-snapping in vertical writing modes, and
 * the end-of-node case in one place — and costs a handful of `getClientRects` calls.
 */
function resolveGlyph(doc: Document, x: number, y: number): GlyphHit | null {
  const pos = caretPosition(doc, x, y)
  if (!pos) return null
  if (pos.node.nodeType !== Node.TEXT_NODE) return null
  const seed = pos.node as Text

  // A caret inside <rt>/<rp> means the tap landed on furigana — redirect to the base.
  if (isInRuby(seed)) return rubyBaseHit(doc, seed, x, y)

  const slack = glyphSlack(doc.defaultView, seed.parentElement)
  const candidates: { node: Text; offset: number }[] = []
  const push = (node: Text | null, offset: number) => {
    if (node && offset >= 0 && offset < node.data.length) candidates.push({ node, offset })
  }
  // The seed offset, then the character *before* it — the mid-glyph correction. When the
  // caret snapped past the last character of the node, `offset - 1` is that character, so
  // the same two candidates also cover the end-of-node case.
  push(seed, pos.offset)
  push(seed, pos.offset - 1)
  // At a node boundary the neighbouring character lives in another text node (a kanji
  // compound with ruby splits its base text, so this is common in Japanese EPUBs).
  if (pos.offset <= 0) {
    const prev = siblingText(doc, seed, 'prev')
    if (prev) push(prev, prev.data.length - 1)
  }
  if (pos.offset >= seed.data.length) {
    const next = siblingText(doc, seed, 'next')
    if (next) push(next, 0)
  }

  let best: GlyphHit | null = null
  for (const c of candidates) {
    const r = charRect(doc, c.node, c.offset)
    if (!r) continue
    const d = hitDistance(r, x, y, slack)
    if (d === null) continue
    if (d === 0) return { ...c, distance: 0 } // inside the glyph box — done
    if (!best || d < best.distance) best = { ...c, distance: d }
  }
  return best
}

export function extractTextAt(doc: Document, x: number, y: number): Extracted | null {
  // Resolve the glyph the tap actually landed on. `null` means blank space (margin,
  // inter-column gap, past the end of a line) and the caller should treat the tap as a
  // chrome toggle / dismiss instead of a lookup.
  const hit = resolveGlyph(doc, x, y)
  if (!hit) return null
  const tapNode = hit.node
  const tapOffset = hit.offset
  // Bail if the tapped glyph isn't a word char (latin, punctuation, …) so the tap falls
  // through to the chrome toggle.
  if (!WORD_CHAR.test(tapNode.data.charAt(tapOffset))) return null

  const walker = textWalker(doc)

  // Forward run, starting at (and including) the tapped char. Track each char's
  // DOM location so the caller can map a matched span back to a Range. Every loop is
  // capped at MAX_AFTER: leadingRun keeps at most that many anyway, so scanning a whole
  // long paragraph's Text node would just allocate thousands of cells to discard them.
  let afterCells: CharPosition[] = []
  for (let k = tapOffset; k < tapNode.data.length && afterCells.length < MAX_AFTER; k++)
    afterCells.push({ node: tapNode, offset: k })
  walker.currentNode = tapNode
  while (afterCells.length < MAX_AFTER) {
    const n = walker.nextNode() as Text | null
    if (!n) break
    for (let k = 0; k < n.data.length && afterCells.length < MAX_AFTER; k++) afterCells.push({ node: n, offset: k })
  }
  afterCells = leadingRun(afterCells, MAX_AFTER)

  // Backward run, the word-chars immediately before the tap — at most MAX_BEFORE of them,
  // so only ever keep the last MAX_BEFORE chars of each preceding node (trailingRun keeps
  // just the suffix run regardless).
  let beforeCells: CharPosition[] = []
  for (let k = Math.max(0, tapOffset - MAX_BEFORE); k < tapOffset; k++) beforeCells.push({ node: tapNode, offset: k })
  walker.currentNode = tapNode
  while (beforeCells.length < MAX_BEFORE) {
    const n = walker.previousNode() as Text | null
    if (!n) break
    const need = MAX_BEFORE - beforeCells.length
    const pre: CharPosition[] = []
    for (let k = Math.max(0, n.data.length - need); k < n.data.length; k++) pre.push({ node: n, offset: k })
    beforeCells = pre.concat(beforeCells)
  }
  beforeCells = trailingRun(beforeCells, MAX_BEFORE)

  const positions = beforeCells.concat(afterCells)
  if (!positions.length) return null
  const text = positions.map((c) => c.node.data.charAt(c.offset)).join('')
  return { text, tapOffset: beforeCells.length, positions }
}

/**
 * Builds a DOM `Range` spanning `text[start, end)` from a `positions` map (see
 * `extractTextAt`). Used to highlight the exact word a tap looked up. Returns
 * null if the span is empty or out of range.
 */
export function rangeForSpan(doc: Document, positions: CharPosition[], start: number, end: number): Range | null {
  if (start < 0 || end > positions.length || start >= end) return null
  const first = positions[start]
  const last = positions[end - 1]
  try {
    const range = doc.createRange()
    range.setStart(first.node, first.offset)
    range.setEnd(last.node, last.offset + 1)
    return range
  } catch {
    return null
  }
}

/** Quick test for whether a string starts with a character worth looking up. */
export function looksJapanese(s: string): boolean {
  return WORD_CHAR.test(s.charAt(0))
}
