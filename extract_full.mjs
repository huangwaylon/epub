import { readFileSync, writeFileSync } from 'node:fs';

const filePath = '/Users/waylonhuang/.gemini/tmp/epub/work_morisaki/OEBPS/Text/part0001.xhtml';
const content = readFileSync(filePath, 'utf8');

// Find all tsuzuri-ja spans
const jaRegex = /<span class="tsuzuri-ja">(.*?)<\/span>/gs;
const spans = [];
let match;
while ((match = jaRegex.exec(content)) !== null) {
  const jaText = match[1];
  const jaEndIndex = jaRegex.lastIndex;
  
  // Look for the next tsuzuri-en span after this ja span, but before the next ja span
  const nextJaMatch = content.indexOf('<span class="tsuzuri-ja">', jaEndIndex);
  const searchSpace = nextJaMatch === -1 ? content.slice(jaEndIndex) : content.slice(jaEndIndex, nextJaMatch);
  
  const enRegex = /<span class="tsuzuri-en">(.*?)<\/span>/s;
  const enMatch = searchSpace.match(enRegex);
  
  spans.push({
    ja: jaText,
    en: enMatch ? enMatch[1] : ''
  });
}

console.log('Total JA spans found:', spans.length);
console.log('Total EN spans found:', spans.filter(s => s.en).length);

writeFileSync('part0001_full_pairs.json', JSON.stringify(spans, null, 2));
