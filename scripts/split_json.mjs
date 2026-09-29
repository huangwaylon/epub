
import { readFileSync, writeFileSync } from 'node:fs';

const filePath = process.argv[2];
const chunkSize = parseInt(process.argv[3]) || 200;

if (!filePath) {
  console.error('Usage: node scripts/split_json.mjs <json-path> [chunk-size]');
  process.exit(1);
}

const data = JSON.parse(readFileSync(filePath, 'utf8'));
for (let i = 0; i < data.length; i += chunkSize) {
  const chunk = data.slice(i, i + chunkSize);
  writeFileSync(`${filePath}.${i/chunkSize}.json`, JSON.stringify(chunk, null, 2));
}
console.log(`Split into ${Math.ceil(data.length / chunkSize)} chunks`);
