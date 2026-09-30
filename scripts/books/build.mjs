// Build the bundled library: books/<slug>/source.epub + en/*.json → public/books/.
//
//   node scripts/books/build.mjs [slug…]
//
// Per book: Kobo markup stripped, English inserted after each unit as
// <span class="tsuzuri-en" lang="en" data-tz="N">, a `tsuzuri-translated` meta added to
// translated chapters and a `tsuzuri:translation` meta to the package, oversized JPEGs
// re-encoded. Writes <slug>.epub, a <slug>.webp
// cover thumbnail, and catalog.json (the shelf's list of downloadable books).
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import sharp from 'sharp'
import {
  XHTML_NS, chapterName, findUnits, parseXml, readEpub, readPackage, serialize, strFromU8, strToU8, stripKobo,
} from './lib.mjs'

const OUT = 'public/books'
const OPF_NS = 'http://www.idpf.org/2007/opf'
/** The `tsuzuri:` metadata prefix (EPUB 3 requires undeclared prefixes to be declared). */
const TSUZURI_PREFIX = 'tsuzuri: https://huangwaylon.github.io/epub/vocab#'
/** JPEGs above this are re-encoded (publisher art is often 300 dpi, near-lossless). */
const JPEG_MAX_BYTES = 400_000
/** Fixed zip timestamps so an unchanged book keeps its SHA-256 (= its library id). Local
 *  time on purpose: zip stores local fields, so a UTC instant would vary by timezone. */
const MTIME = new Date(2026, 0, 1)

const order = JSON.parse(readFileSync('books/catalog.json', 'utf8'))
const only = process.argv.slice(2)

async function buildBook(slug) {
  const dir = join('books', slug)
  const files = readEpub(join(dir, 'source.epub'))
  const pkg = readPackage(files)
  let units = 0
  let translated = 0
  let jaChars = 0
  let jaTranslated = 0

  const spine = new Set(pkg.spine)
  for (const path of Object.keys(files)) {
    if (!/\.x?html?$/i.test(path)) continue
    const doc = parseXml(strFromU8(files[path]), path)
    stripKobo(doc)
    const ch = { path, doc, units: spine.has(path) ? findUnits(doc) : [] }
    const enPath = join(dir, 'en', `${chapterName(path)}.json`)
    const en = existsSync(enPath) ? JSON.parse(readFileSync(enPath, 'utf8')) : []
    if (en.length && en.length !== ch.units.length) {
      throw new Error(`${enPath}: ${en.length} units, source has ${ch.units.length} — re-run extract.mjs ${slug}`)
    }
    let inserted = 0
    ch.units.forEach((u, id) => {
      units++
      jaChars += u.ja.length
      const entry = en[id]
      if (entry && entry.ja !== u.ja) {
        throw new Error(`${enPath} #${id}: source text changed — re-run extract.mjs ${slug}`)
      }
      if (!entry?.en) return
      translated++
      jaTranslated += u.ja.length
      inserted++
      const span = ch.doc.createElementNS(XHTML_NS, 'span')
      span.setAttribute('class', 'tsuzuri-en')
      span.setAttribute('lang', 'en')
      span.setAttribute('xml:lang', 'en')
      span.setAttribute('data-tz', String(id))
      span.appendChild(ch.doc.createTextNode(entry.en))
      const last = u.nodes[u.nodes.length - 1]
      if (last) u.block.insertBefore(span, last.nextSibling)
      else u.block.appendChild(span)
    })
    if (inserted) {
      const head = ch.doc.getElementsByTagName('head')[0]
      const meta = ch.doc.createElementNS(XHTML_NS, 'meta')
      meta.setAttribute('name', 'tsuzuri-translated')
      meta.setAttribute('content', 'en')
      head?.appendChild(meta)
    }
    files[ch.path] = strToU8(serialize(ch.doc))
  }
  // Kobo's sync script: the <script> tags are gone; drop the file and its manifest item.
  for (const path of Object.keys(files)) if (/(^|\/)js\/kobo\.js$/.test(path)) delete files[path]
  for (const item of Array.from(pkg.opf.getElementsByTagName('item'))) {
    if (/kobo\.js$/.test(item.getAttribute('href'))) item.parentNode.removeChild(item)
  }
  // Declare the English in the package, so the reader knows at open without scanning the
  // spine (EPUB 3 `property` with a declared prefix; EPUB 2 `name`/`content`).
  if (translated) {
    const root = pkg.opf.documentElement
    const metadata = pkg.opf.getElementsByTagNameNS(OPF_NS, 'metadata')[0]
    const meta = pkg.opf.createElementNS(OPF_NS, 'meta')
    if (/^3/.test(root.getAttribute('version') ?? '')) {
      const prefix = root.getAttribute('prefix')?.trim()
      root.setAttribute('prefix', `${prefix ? `${prefix} ` : ''}${TSUZURI_PREFIX}`)
      meta.setAttribute('property', 'tsuzuri:translation')
      meta.appendChild(pkg.opf.createTextNode('en'))
    } else {
      meta.setAttribute('name', 'tsuzuri:translation')
      meta.setAttribute('content', 'en')
    }
    metadata.appendChild(meta)
  }
  files[pkg.opfPath] = strToU8(serialize(pkg.opf))

  for (const [path, data] of Object.entries(files)) {
    if (!/\.jpe?g$/i.test(path) || data.length <= JPEG_MAX_BYTES) continue
    const out = await sharp(data).jpeg({ quality: 80, mozjpeg: true }).toBuffer()
    if (out.length < data.length) files[path] = new Uint8Array(out)
  }

  // mimetype first and stored, per OCF.
  const { mimetype, ...rest } = files
  const zip = zipSync(
    {
      mimetype: [mimetype ?? strToU8('application/epub+zip'), { level: 0, mtime: MTIME }],
      ...Object.fromEntries(Object.entries(rest).map(([p, d]) => [p, [d, { level: 9, mtime: MTIME }]])),
    },
  )
  writeFileSync(join(OUT, `${slug}.epub`), zip)

  let cover
  if (pkg.cover && files[pkg.cover]) {
    cover = `${slug}.webp`
    await sharp(files[pkg.cover]).resize({ width: 320 }).webp({ quality: 80 }).toFile(join(OUT, cover))
  }

  const entry = {
    slug,
    id: createHash('sha256').update(zip).digest('hex'),
    title: pkg.title,
    author: pkg.author,
    language: pkg.language,
    dir: pkg.dir,
    file: `${slug}.epub`,
    size: zip.length,
    cover,
    translation: translated ? { lang: 'en', coverage: Math.round((jaTranslated / jaChars) * 1000) / 1000 } : undefined,
  }
  console.log(
    `${slug}: ${(zip.length / 1e6).toFixed(2)} MB, ${translated}/${units} units translated ` +
      `(${Math.round((jaTranslated / jaChars) * 100)}% of text)`,
  )
  return entry
}

mkdirSync(OUT, { recursive: true })
const catalogPath = join(OUT, 'catalog.json')
const previous = existsSync(catalogPath) && statSync(catalogPath).size
  ? JSON.parse(readFileSync(catalogPath, 'utf8'))
  : []
const catalog = []
for (const slug of order) {
  if (only.length && !only.includes(slug)) {
    const prev = previous.find((b) => b.slug === slug)
    if (prev) catalog.push(prev)
    continue
  }
  catalog.push(await buildBook(slug))
}
writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n')
