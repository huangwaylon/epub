// Rasterizes the app icons from inline SVG into public/icons/, and the iPad launch
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

// ── iPad launch screens ────────────────────────────────────────────────────
// iOS shows an `apple-touch-startup-image` only when its media query matches the
// device exactly (CSS device size, DPR, orientation), so each iPad screen size needs
// its own image per orientation — plus a dark variant for `prefers-color-scheme`.
// Plain paper with the app mark centred: it matches the first frame of the app, so
// the launch reads as one continuous surface. Paper colours mirror app.css.
const PAPER = { light: '#f6f3ec', dark: '#16140f' }
const IPADS = [
  // [CSS portrait width, height] — all 2× DPR
  [744, 1133], // iPad mini (6th gen+)
  [768, 1024], // iPad 9.7" / mini 5
  [810, 1080], // iPad 10.2"
  [820, 1180], // iPad 10th gen / Air 11" (M2)
  [834, 1112], // iPad Air 10.5"
  [834, 1194], // iPad Pro 11"
  [834, 1210], // iPad Pro 11" (M4)
  [1024, 1366], // iPad Pro 12.9" / Air 13"
  [1032, 1376], // iPad Pro 13" (M4)
]
const MARK_CSS_PX = 128
const splashDir = join(root, 'public', 'splash')
mkdirSync(splashDir, { recursive: true })
const mark = await sharp(Buffer.from(rounded)).resize(MARK_CSS_PX * 2, MARK_CSS_PX * 2).png().toBuffer()

const links = []
for (const [cw, ch] of IPADS) {
  for (const orientation of ['portrait', 'landscape']) {
    const [w, h] = orientation === 'portrait' ? [cw * 2, ch * 2] : [ch * 2, cw * 2]
    for (const scheme of ['light', 'dark']) {
      const name = `ipad-${w}x${h}-${scheme}.png`
      await sharp({ create: { width: w, height: h, channels: 3, background: PAPER[scheme] } })
        .composite([{ input: mark, gravity: 'center' }])
        .png({ compressionLevel: 9, palette: true })
        .toFile(join(splashDir, name))
      const media =
        `screen and (device-width: ${cw}px) and (device-height: ${ch}px) and ` +
        `(-webkit-device-pixel-ratio: 2) and (orientation: ${orientation}) and (prefers-color-scheme: ${scheme})`
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
