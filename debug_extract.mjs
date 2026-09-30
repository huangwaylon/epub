import { readFileSync, writeFileSync } from 'node:fs';

const filePath = '/Users/waylonhuang/.gemini/tmp/epub/work_morisaki/OEBPS/Text/part0001.xhtml';
const content = readFileSync(filePath, 'utf8');

const jaRegex = /<span class="tsuzuri-ja">(.*?)<\/span>/gs;
const enRegex = /<span class="tsuzuri-en">(.*?)<\/span>/gs;

const jaSpans = [];
let match;
while ((match = jaRegex.exec(content)) !== null) {
  jaSpans.push(match[1]);
}

const enSpans = [];
while ((match = enRegex.exec(content)) !== null) {
  enSpans.push(match[1]);
}

console.log('JA spans:', jaSpans.length);
console.log('EN spans:', enSpans.length);

const pairs = [];
for (let i = 0; i < Math.max(jaSpans.length, enSpans.length); i++) {
  pairs.push([jaSpans[i] || '', enSpans[i] || '']);
}

writeFileSync('temp_pairs.json', JSON.stringify(pairs, null, 2));
