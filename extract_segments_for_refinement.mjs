import { readFileSync } from 'node:fs';

const filePath = process.argv[2];
const content = readFileSync(filePath, 'utf8');
const regex = /<span class="tsuzuri-ja">(.*?)<\/span><span class="tsuzuri-en">(.*?)<\/span>/gs;

const segments = [];
let match;
while ((match = regex.exec(content)) !== null) {
  segments.push({ ja: match[1], en: match[2] });
}

console.log(JSON.stringify(segments, null, 2));
