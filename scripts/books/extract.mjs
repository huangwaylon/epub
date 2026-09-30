// Extract a bundled book's translation units into books/<slug>/en/<chapter>.json.
//
//   node scripts/books/extract.mjs <slug> [--drafts legacy-bilingual.epub]
//
// Re-running keeps every existing `en` whose `ja` still matches (by id, else by text), so
// it is safe after a source change. `--drafts` seeds empty units from an older bilingual
// EPUB (tsuzuri-ja/tsuzuri-en span pairs), matched by Japanese text.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chapters, readEpub, readPackage, parseXml, strFromU8, unitText } from './lib.mjs'

const [slug, flag, draftPath] = process.argv.slice(2)
if (!slug) {
  console.error('usage: node scripts/books/extract.mjs <slug> [--drafts file.epub]')
  process.exit(1)
}
const dir = join('books', slug)
const files = readEpub(join(dir, 'source.epub'))
const pkg = readPackage(files)

const norm = (s) => s.replace(/《[^》]*》/g, '').replace(/[\s　]/g, '')

function draftPairs(path) {
  if (flag !== '--drafts' || !draftPath) return []
  const legacy = readEpub(draftPath)
  const file = legacy[path]
  if (!file) return []
  const doc = parseXml(strFromU8(file).replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/gi, '&amp;'), path)
  const pairs = []
  for (const span of Array.from(doc.getElementsByTagName('span'))) {
    if (span.getAttribute('class') !== 'tsuzuri-ja') continue
    const next = span.nextSibling
    const en = next?.nodeType === 1 && next.getAttribute('class') === 'tsuzuri-en' ? unitText([next]) : ''
    const ja = norm(unitText([span]))
    if (ja && en) pairs.push({ ja, en: en.replace(/《[^》]*》/g, '') })
  }
  return pairs
}

mkdirSync(join(dir, 'en'), { recursive: true })
let total = 0
let translated = 0
for (const ch of chapters(files, pkg)) {
  const out = join(dir, 'en', `${ch.name}.json`)
  const prev = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : []
  const byText = new Map(prev.filter((u) => u.en).map((u) => [u.ja, u.en]))
  const pairs = draftPairs(ch.path)
  let p = 0

  const units = ch.units.map(({ ja }, id) => {
    let en = prev[id]?.ja === ja ? prev[id].en : (byText.get(ja) ?? '')
    if (!en && pairs.length) {
      // Consume draft sentences, in order, that lie inside this unit.
      const key = norm(ja)
      const parts = []
      for (let look = p; look < Math.min(pairs.length, p + 8); look++) {
        if (!key.includes(pairs[look].ja)) continue
        parts.push(pairs[look].en)
        p = look + 1
        while (p < pairs.length && key.includes(pairs[p].ja)) parts.push(pairs[p++].en)
        break
      }
      en = parts.join(' ').replace(/\s+/g, ' ').trim()
    }
    return { id, ja, en }
  })
  total += units.length
  translated += units.filter((u) => u.en).length
  writeFileSync(out, JSON.stringify(units, null, 1) + '\n')
}
console.log(`${slug}: ${translated}/${total} units translated`)
