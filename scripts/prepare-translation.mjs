import * as fflate from '../src/vendor/foliate-js/vendor/fflate.js'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const filePath = process.argv[2]
if (!filePath) {
  console.error('Usage: node scripts/prepare-translation.mjs <epub-path>')
  process.exit(1)
}

const buffer = readFileSync(filePath)
const files = unzipSync(new Uint8Array(buffer))

console.log('EPUB Structure:')
for (const name of Object.keys(files)) {
  console.log(`  ${name} (${files[name].length} bytes)`)
}
