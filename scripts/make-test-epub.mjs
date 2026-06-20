// Generates a small vertical-writing (縦書き / rtl) Japanese EPUB3 for testing the
// reader: pagination, RTL page turns, ruby/furigana, cover extraction, and the
// dictionary (text deliberately includes conjugated verbs & adjectives).
// Output: test-books/tsuki-to-neko.epub
import { zipSync, strToU8 } from 'fflate'
import sharp from 'sharp'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'test-books')
mkdirSync(outDir, { recursive: true })

const css = `
html { writing-mode: vertical-rl; -epub-writing-mode: vertical-rl; }
body { font-family: serif; line-height: 1.8; margin: 1em; }
h1 { font-size: 1.4em; margin: 0 0 1em; font-weight: 600; }
p { margin: 0; text-indent: 1em; }
.gap { margin-top: 1.2em; }
rt { font-size: 0.5em; }
`

function chapter(title, paras) {
  const body = paras
    .map((p) => `<p>${p}</p>`)
    .join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="ja" xml:lang="ja">
<head><meta charset="utf-8"/><title>${title}</title><link rel="stylesheet" href="style.css"/></head>
<body><section epub:type="chapter"><h1>${title}</h1>
${body}
</section></body></html>`
}

const r = (k, y) => `<ruby>${k}<rt>${y}</rt></ruby>`

const ch1Paras = [
  `${r('夜', 'よる')}が${r('更', 'ふ')}けると、${r('小', 'ちい')}さな${r('猫', 'ねこ')}は${r('屋根', 'やね')}の${r('上', 'うえ')}に${r('登', 'のぼ')}った。`,
  `${r('空', 'そら')}には${r('大', 'おお')}きな${r('月', 'つき')}が${r('浮', 'う')}かんでいて、まるで${r('銀', 'ぎん')}の${r('皿', 'さら')}のように${r('光', 'ひか')}っていた。`,
  `${r('猫', 'ねこ')}はしばらく${r('月', 'つき')}を${r('見上', 'みあ')}げていたが、やがて${r('静', 'しず')}かに${r('鳴', 'な')}いた。`,
  `「あの${r('光', 'ひかり')}を${r('食', 'た')}べてみたい」と${r('思', 'おも')}ったのかもしれない。`,
  `${r('風', 'かぜ')}が${r('吹', 'ふ')}いて、${r('木', 'き')}の${r('葉', 'は')}が${r('揺', 'ゆ')}れていた。${r('猫', 'ねこ')}はじっと${r('待', 'ま')}っていた。`,
  `${r('遠', 'とお')}くで${r('鐘', 'かね')}が${r('鳴', 'な')}り、${r('夜', 'よる')}はますます${r('深', 'ふか')}くなっていった。`,
  `${r('猫', 'ねこ')}の${r('目', 'め')}は${r('金色', 'きんいろ')}に${r('輝', 'かがや')}き、${r('何', 'なに')}かを${r('決心', 'けっしん')}したように${r('見', 'み')}えた。`,
  `${r('星', 'ほし')}が${r('一', 'ひと')}つ、また${r('一', 'ひと')}つと${r('現', 'あらわ')}れて、${r('夜空', 'よぞら')}を${r('飾', 'かざ')}っていく。`,
]
// Repeat to make a realistic multi-page chapter for layout testing.
const ch1 = chapter('第一章　月の猫', Array.from({ length: 6 }, () => ch1Paras).flat())

const ch2 = chapter('第二章　歩いた道', [
  `${r('朝', 'あさ')}になると、${r('猫', 'ねこ')}は${r('町', 'まち')}へ${r('歩', 'ある')}いて${r('行', 'い')}った。`,
  `${r('道', 'みち')}は${r('長', 'なが')}くて、${r('途中', 'とちゅう')}で${r('何度', 'なんど')}も${r('休', 'やす')}んだ。`,
  `${r('美', 'うつく')}しかった${r('花', 'はな')}が${r('咲', 'さ')}いていて、${r('猫', 'ねこ')}はそれを${r('眺', 'なが')}めた。`,
  `${r('人', 'ひと')}びとは${r('忙', 'いそが')}しそうに${r('働', 'はたら')}いていた。${r('誰', 'だれ')}も${r('猫', 'ねこ')}に${r('気', 'き')}づかなかった。`,
  `それでも${r('猫', 'ねこ')}は${r('前', 'まえ')}へ${r('進', 'すす')}んで${r('行', 'い')}こうとした。${r('月', 'つき')}を${r('探', 'さが')}していたのだ。`,
])

const ch3 = chapter('第三章　見つけたもの', [
  `${r('夕方', 'ゆうがた')}、${r('猫', 'ねこ')}は${r('古', 'ふる')}い${r('寺', 'てら')}の${r('庭', 'にわ')}に${r('着', 'つ')}いた。`,
  `${r('池', 'いけ')}の${r('水', 'みず')}に${r('月', 'つき')}が${r('映', 'うつ')}っていて、まるで${r('本物', 'ほんもの')}のように${r('見', 'み')}えた。`,
  `${r('猫', 'ねこ')}は${r('水', 'みず')}を${r('飲', 'の')}もうとして、${r('月', 'つき')}に${r('手', 'て')}を${r('伸', 'の')}ばした。`,
  `すると${r('波', 'なみ')}が${r('立', 'た')}って、${r('月', 'つき')}は${r('消', 'き')}えてしまった。`,
  `${r('猫', 'ねこ')}は${r('驚', 'おどろ')}いたが、${r('空', 'そら')}を${r('見上', 'みあ')}げると、${r('月', 'つき')}はまだそこに${r('輝', 'かがや')}いていた。`,
  `「${r('月', 'つき')}は${r('一', 'ひと')}つではなかったのだ」と${r('猫', 'ねこ')}は${r('学', 'まな')}んだ。そして${r('満足', 'まんぞく')}して${r('眠', 'ねむ')}った。`,
])

const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="ja">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:tsuzuri-test-0001</dc:identifier>
    <dc:title>月と猫</dc:title>
    <dc:creator>綴 太郎</dc:creator>
    <dc:language>ja</dc:language>
    <meta property="dcterms:modified">2024-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover-img" href="cover.png" media-type="image/png" properties="cover-image"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch3" href="ch3.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine page-progression-direction="rtl">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="ch3"/>
  </spine>
</package>`

const nav = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="ja">
<head><meta charset="utf-8"/><title>目次</title></head>
<body><nav epub:type="toc"><h1>目次</h1><ol>
<li><a href="ch1.xhtml">第一章　月の猫</a></li>
<li><a href="ch2.xhtml">第二章　歩いた道</a></li>
<li><a href="ch3.xhtml">第三章　見つけたもの</a></li>
</ol></nav></body></html>`

const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`

const coverSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900">
  <rect width="600" height="900" fill="#1b2a3a"/>
  <circle cx="430" cy="230" r="120" fill="#f3ead2"/>
  <text x="300" y="560" font-family="serif" font-size="120" fill="#f3ead2" text-anchor="middle">月と猫</text>
  <text x="300" y="700" font-family="serif" font-size="40" fill="#a9bcc9" text-anchor="middle">綴 太郎</text>
</svg>`
const coverPng = await sharp(Buffer.from(coverSvg)).png().toBuffer()

const files = {
  mimetype: [strToU8('application/epub+zip'), { level: 0 }], // must be stored & first
  'META-INF/container.xml': strToU8(container),
  'OEBPS/content.opf': strToU8(opf),
  'OEBPS/nav.xhtml': strToU8(nav),
  'OEBPS/style.css': strToU8(css),
  'OEBPS/cover.png': new Uint8Array(coverPng),
  'OEBPS/ch1.xhtml': strToU8(ch1),
  'OEBPS/ch2.xhtml': strToU8(ch2),
  'OEBPS/ch3.xhtml': strToU8(ch3),
}

const zipped = zipSync(files)
const outPath = join(outDir, 'tsuki-to-neko.epub')
writeFileSync(outPath, zipped)
console.log('wrote', outPath, `(${zipped.length} bytes)`)
