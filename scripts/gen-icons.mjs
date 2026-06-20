// Rasterizes the app icons from inline SVG into public/icons/.
// Run with: node scripts/gen-icons.mjs
import sharp from 'sharp'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')
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
