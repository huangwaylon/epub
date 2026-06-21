// Stages kuromoji's IPADIC dictionary (~19 MB of *.dat.gz) into public/ so Vite
// serves it (dev) / copies it into dist/ (build). Run automatically via the
// `predev` / `prebuild` npm scripts; public/kuromoji/ is gitignored, so the dict is
// regenerated from node_modules rather than committed. The reader fetches it from
// `${BASE_URL}kuromoji/dict/` at runtime (src/services/jp/segment.ts) and the
// service worker runtime-caches it for offline use.
import { mkdirSync, readdirSync, copyFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'node_modules/@sglkc/kuromoji/dict')
const dest = join(root, 'public/kuromoji/dict')

if (!existsSync(src)) {
  // Don't hard-fail: without the dict the reader falls back to greedy segmentation.
  console.warn(`[kuromoji] dict not found at ${src} — run \`npm install\`. Skipping.`)
  process.exit(0)
}

mkdirSync(dest, { recursive: true })
let copied = 0
for (const file of readdirSync(src)) {
  if (!file.endsWith('.dat.gz')) continue
  const from = join(src, file)
  const to = join(dest, file)
  if (existsSync(to) && statSync(to).size === statSync(from).size) continue // already current
  copyFileSync(from, to)
  copied++
}
console.log(`[kuromoji] IPADIC dict ready in public/kuromoji/dict (${copied} file(s) copied)`)
