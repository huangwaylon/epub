import { describe, it, expect } from 'vitest'
import { buildChapterIndex, chapterAt, chapterOrder } from './chapters'
import type { TocItem } from './reader/types'

const TOC: TocItem[] = [
  { label: 'Cover', href: 'cover.xhtml' },
  {
    label: ' Part One ',
    href: 'p1.xhtml',
    subitems: [
      { label: 'Chapter 1', href: 'p1.xhtml#c1' }, // same section as Part One
      { label: 'Chapter 2', href: 'c2.xhtml' },
    ],
  },
  { label: '', href: 'blank.xhtml' },
  { label: 'Broken', href: 'missing.xhtml' },
  { label: 'Afterword', href: 'after.xhtml' },
]
const SECTIONS = ['cover.xhtml', 'p1.xhtml', 'c2.xhtml', 'blank.xhtml', 'after.xhtml']
const FRACTIONS = [0, 0.1, 0.5, 0.8, 0.9, 1]
const resolve = (href: string) => {
  const i = SECTIONS.indexOf(href.split('#')[0])
  if (href === 'missing.xhtml') throw new Error('no such item')
  return { index: i }
}

describe('buildChapterIndex', () => {
  it('maps labelled entries to section starts, first of a shared start, ascending', () => {
    expect(buildChapterIndex(TOC, FRACTIONS, resolve)).toEqual([
      { start: 0, label: 'Cover' },
      { start: 0.1, label: 'Part One' },
      { start: 0.5, label: 'Chapter 2' },
      { start: 0.9, label: 'Afterword' },
    ])
  })
  it('is empty without fractions or a resolver', () => {
    expect(buildChapterIndex(TOC, [], resolve)).toEqual([])
    expect(buildChapterIndex(TOC, FRACTIONS, undefined)).toEqual([])
  })
})

describe('chapterAt', () => {
  const starts = buildChapterIndex(TOC, FRACTIONS, resolve)
  it('returns the chapter containing the fraction', () => {
    expect(chapterAt(starts, 0.05)).toBe('Cover')
    expect(chapterAt(starts, 0.1)).toBe('Part One')
    expect(chapterAt(starts, 0.0999999)).toBe('Part One') // within 1e-6 of the start
    expect(chapterAt(starts, 0.95)).toBe('Afterword')
    expect(chapterAt([], 0.5)).toBe('')
  })
})

describe('chapterOrder', () => {
  it('lists trimmed labels depth-first in TOC order', () => {
    expect(chapterOrder(TOC)).toEqual(['Cover', 'Part One', 'Chapter 1', 'Chapter 2', 'Broken', 'Afterword'])
  })
})
