// Rasterizes the app icons from inline SVG into public/icons/, and the iPad + iPhone launch
// (splash) screens into public/splash/ — rewriting their <link> tags in index.html
// between the `splash:start` / `splash:end` markers.
// Run with: node scripts/gen-icons.mjs
import sharp from 'sharp'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'public', 'icons')
mkdirSync(outDir, { recursive: true })

// Standard (rounded) mark — used for the 192/512 "any" icons and Apple touch icon.
const rounded = `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" rx="112" fill="#b5552e"/>
  <rect x="132" y="104" width="248" height="304" rx="18" fill="#f7f2e8"/>
  <g fill="#211d17">
    <rect x="338" y="140" width="9" height="150" rx="4.5"/>
    <rect x="306" y="140" width="9" height="196" rx="4.5"/>
    <rect x="274" y="140" width="9" height="120" rx="4.5"/>
    <rect x="242" y="140" width="9" height="176" rx="4.5"/>
  </g>
  <circle cx="196" cy="346" r="34" fill="#b5552e"/>
  <circle cx="196" cy="346" r="34" fill="none" stroke="#f7f2e8" stroke-width="5"/>
</svg>`

// Maskable — full-bleed background, artwork kept within the inner 80% safe zone.
const maskable = `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" fill="#b5552e"/>
  <g transform="translate(51.2 51.2) scale(0.8)">
    <rect x="132" y="104" width="248" height="304" rx="18" fill="#f7f2e8"/>
    <g fill="#211d17">
      <rect x="338" y="140" width="9" height="150" rx="4.5"/>
      <rect x="306" y="140" width="9" height="196" rx="4.5"/>
      <rect x="274" y="140" width="9" height="120" rx="4.5"/>
      <rect x="242" y="140" width="9" height="176" rx="4.5"/>
    </g>
    <circle cx="196" cy="346" r="34" fill="#b5552e"/>
    <circle cx="196" cy="346" r="34" fill="none" stroke="#f7f2e8" stroke-width="5"/>
  </g>
</svg>`

const jobs = [
  { svg: rounded, size: 192, name: 'icon-192.png' },
  { svg: rounded, size: 512, name: 'icon-512.png' },
  { svg: rounded, size: 180, name: 'apple-touch-icon-180.png' },
  { svg: maskable, size: 512, name: 'maskable-512.png' },
]

for (const { svg, size, name } of jobs) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(join(outDir, name))
  console.log('wrote', name)
}

// ── Launch screens (iPad + iPhone) ─────────────────────────────────────────
// iOS uses a startup image only on an exact media-query match (device size, DPR,
// orientation), so each size needs one per orientation and colour scheme. Colours mirror app.css.
const PAPER = { light: '#f6f3ec', dark: '#16140f' }
const DEVICES = [
  // [prefix, CSS portrait width, height, DPR]
  ['ipad', 744, 1133, 2], // iPad mini (6th gen+)
  ['ipad', 768, 1024, 2], // iPad 9.7" / mini 5
  ['ipad', 810, 1080, 2], // iPad 10.2"
  ['ipad', 820, 1180, 2], // iPad 10th gen / Air 11" (M2)
  ['ipad', 834, 1112, 2], // iPad Air 10.5"
  ['ipad', 834, 1194, 2], // iPad Pro 11"
  ['ipad', 834, 1210, 2], // iPad Pro 11" (M4)
  ['ipad', 1024, 1366, 2], // iPad Pro 12.9" / Air 13"
  ['ipad', 1032, 1376, 2], // iPad Pro 13" (M4)
  // iPhones that run iOS 26 (11 and later, SE 2nd gen and later)
  ['iphone', 440, 956, 3], // 16 Pro Max, 17 Pro Max
  ['iphone', 430, 932, 3], // 14 Pro Max, 15 Plus / Pro Max, 16 Plus
  ['iphone', 428, 926, 3], // 12 / 13 Pro Max, 14 Plus
  ['iphone', 420, 912, 3], // Air
  ['iphone', 414, 896, 2], // 11, XR
  ['iphone', 414, 896, 3], // 11 Pro Max
  ['iphone', 402, 874, 3], // 16 Pro, 17, 17 Pro
  ['iphone', 393, 852, 3], // 14 Pro, 15, 15 Pro, 16
  ['iphone', 390, 844, 3], // 12, 13, 14, 16e
  ['iphone', 375, 812, 3], // 11 Pro, 12 / 13 mini
  ['iphone', 375, 667, 2], // SE (2nd / 3rd gen)
]
const MARK_CSS_PX = 128
const splashDir = join(root, 'public', 'splash')
mkdirSync(splashDir, { recursive: true })
const marks = {}
for (const [, , , dpr] of DEVICES) {
  marks[dpr] ??= await sharp(Buffer.from(rounded)).resize(MARK_CSS_PX * dpr, MARK_CSS_PX * dpr).png().toBuffer()
}

const links = []
for (const [prefix, cw, ch, dpr] of DEVICES) {
  for (const orientation of ['portrait', 'landscape']) {
    const [w, h] = orientation === 'portrait' ? [cw * dpr, ch * dpr] : [ch * dpr, cw * dpr]
    for (const scheme of ['light', 'dark']) {
      const name = `${prefix}-${w}x${h}-${scheme}.png`
      await sharp({ create: { width: w, height: h, channels: 3, background: PAPER[scheme] } })
        .composite([{ input: marks[dpr], gravity: 'center' }])
        .png({ compressionLevel: 9, palette: true })
        .toFile(join(splashDir, name))
      const media =
        `screen and (device-width: ${cw}px) and (device-height: ${ch}px) and ` +
        `(-webkit-device-pixel-ratio: ${dpr}) and (orientation: ${orientation}) and (prefers-color-scheme: ${scheme})`
      links.push(`    <link rel="apple-touch-startup-image" media="${media}" href="/splash/${name}" />`)
    }
  }
}
console.log('wrote', links.length, 'splash screens')

const indexPath = join(root, 'index.html')
const html = readFileSync(indexPath, 'utf8')
const re = /( *<!-- splash:start[^\n]*\n)[\s\S]*?( *<!-- splash:end -->)/
if (!re.test(html)) throw new Error('index.html is missing the splash:start / splash:end markers')
writeFileSync(indexPath, html.replace(re, (_, a, b) => `${a}${links.join('\n')}\n${b}`))
console.log('updated index.html splash links')
