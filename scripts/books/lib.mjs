// Shared EPUB helpers for the bundled-book pipeline (extract.mjs, build.mjs).
//
// A "unit" is one translatable line of a chapter: a leaf block element (<p>, <h2>, …), or
// one <br/>-separated line of it. Units are numbered in document order after Kobo
// markup is stripped; `ja` (text with ruby as 漢字《かんじ》) guards the numbering.
import { unzipSync, strFromU8, strToU8 } from 'fflate'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'

export const XHTML_NS = 'http://www.w3.org/1999/xhtml'

const BLOCKS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'dt', 'dd', 'blockquote', 'div',
  'td', 'th', 'caption', 'figcaption', 'section', 'article', 'header', 'footer',
])
const HAS_TEXT = /[\p{L}\p{N}]/u

export function readEpub(path) {
  return unzipSync(new Uint8Array(readFileSync(path)))
}

export function parseXml(text, path) {
  const errors = []
  const doc = new DOMParser({
    onError: (level, msg) => { if (level !== 'warning') errors.push(msg) },
  }).parseFromString(text, 'application/xhtml+xml')
  if (errors.length) throw new Error(`${path}: ${errors[0]}`)
  return doc
}

export const serialize = (doc) => new XMLSerializer().serializeToString(doc)

function* elements(node) {
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1) {
      yield c
      yield* elements(c)
    }
  }
}

/** Package document, spine hrefs (zip paths), cover path, metadata. */
export function readPackage(files) {
  const container = parseXml(strFromU8(files['META-INF/container.xml']), 'container.xml')
  const opfPath = container.getElementsByTagName('rootfile')[0].getAttribute('full-path')
  const opf = parseXml(strFromU8(files[opfPath]), opfPath)
  const base = posix.dirname(opfPath)
  const resolve = (href) => posix.normalize(posix.join(base, decodeURIComponent(href)))

  const items = new Map()
  for (const it of Array.from(opf.getElementsByTagName('item'))) {
    items.set(it.getAttribute('id'), {
      path: resolve(it.getAttribute('href')),
      type: it.getAttribute('media-type'),
      props: it.getAttribute('properties') ?? '',
    })
  }
  const spine = Array.from(opf.getElementsByTagName('itemref'))
    .map((r) => items.get(r.getAttribute('idref')))
    .filter((it) => it && /html/.test(it.type))
    .map((it) => it.path)

  const text = (tag) => opf.getElementsByTagName(tag)[0]?.textContent.trim() ?? ''
  const coverMeta = Array.from(opf.getElementsByTagName('meta')).find(
    (m) => m.getAttribute('name') === 'cover',
  )
  const cover =
    [...items.values()].find((it) => it.props.split(/\s+/).includes('cover-image'))?.path ??
    items.get(coverMeta?.getAttribute('content'))?.path

  return {
    opfPath,
    opf,
    spine,
    cover,
    title: text('dc:title'),
    language: text('dc:language'),
    dir: opf.getElementsByTagName('spine')[0]?.getAttribute('page-progression-direction') === 'rtl' ? 'rtl' : 'ltr',
    author: Array.from(opf.getElementsByTagName('dc:creator'))
      .map((c) => c.textContent.trim())
      .join('、'),
  }
}

/** Kobo sync markup: sentence spans, a script and a style per chapter. Unwrapped so the
 *  reader's DOM (and every CFI) is the publisher's own. */
export function stripKobo(doc) {
  for (const el of Array.from(doc.getElementsByTagName('span'))) {
    if (!/\bkobospan\b/i.test(el.getAttribute('class') ?? '')) continue
    while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el)
    el.parentNode.removeChild(el)
  }
  for (const tag of ['script', 'style']) {
    for (const el of Array.from(doc.getElementsByTagName(tag))) {
      if (tag === 'script' || el.getAttribute('id') === 'koboSpanStyle') el.parentNode.removeChild(el)
    }
  }
  removeComments(doc.documentElement, /kobo-style/)
  doc.documentElement.normalize()
}

function removeComments(node, pattern) {
  for (let c = node.firstChild; c; ) {
    const next = c.nextSibling
    if (c.nodeType === 8 && pattern.test(c.data)) node.removeChild(c)
    else if (c.nodeType === 1) removeComments(c, pattern)
    c = next
  }
}

/** Text of nodes with ruby as base《reading》; <rp> dropped, whitespace collapsed. */
export function unitText(nodes) {
  let out = ''
  const visit = (n) => {
    if (n.nodeType === 3) out += n.data
    else if (n.nodeType === 1) {
      const name = n.localName
      if (name === 'rp' || name === 'rt') return
      if (name === 'ruby') {
        let base = ''
        let reading = ''
        const inner = (m) => {
          for (let c = m.firstChild; c; c = c.nextSibling) {
            if (c.nodeType === 3) base += c.data
            else if (c.nodeType === 1 && c.localName === 'rt') reading += c.textContent
            else if (c.nodeType === 1 && c.localName !== 'rp') inner(c)
          }
        }
        inner(n)
        out += reading ? `${base}《${reading}》` : base
        return
      }
      for (let c = n.firstChild; c; c = c.nextSibling) visit(c)
    }
  }
  nodes.forEach(visit)
  return out.replace(/\s+/g, ' ').replace(/^[\s　]+|[\s　]+$/g, '')
}

/** Units of a chapter: `{ block, nodes, ja }`; `nodes` are the block's children forming
 *  the line (the English is inserted after the last one). */
export function findUnits(doc) {
  const body = doc.getElementsByTagName('body')[0]
  if (!body) return []
  const units = []
  for (const el of elements(body)) {
    if (!BLOCKS.has(el.localName)) continue
    if ([...elements(el)].some((d) => BLOCKS.has(d.localName))) continue
    let line = []
    const flush = () => {
      const ja = unitText(line)
      if (HAS_TEXT.test(ja)) units.push({ block: el, nodes: line, ja })
      line = []
    }
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1 && c.localName === 'br') flush()
      else line.push(c)
    }
    flush()
  }
  return units
}

/** Chapter documents with at least one unit, as `{ path, name, doc, units }`. */
export function chapters(files, pkg) {
  const out = []
  for (const path of pkg.spine) {
    const doc = parseXml(strFromU8(files[path]), path)
    stripKobo(doc)
    const units = findUnits(doc)
    if (units.length) out.push({ path, name: chapterName(path), doc, units })
  }
  return out
}

export const chapterName = (path) => posix.basename(path).replace(/\.x?html?$/, '')

export { strFromU8, strToU8 }
