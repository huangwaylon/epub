import { readFileSync, writeFileSync } from 'node:fs';

const filePath = process.argv[2];
const chunksPath = filePath + '.chunks.json';
const translationsPath = filePath + '.translations.json';

const content = readFileSync(filePath, 'utf8');
const batches = JSON.parse(readFileSync(chunksPath, 'utf8'));
const translations = JSON.parse(readFileSync(translationsPath, 'utf8'));

// Create a map of innerHtml -> English translation
const translationMap = new Map();
let tIndex = 0;
for (const batch of batches) {
  for (const chunk of batch) {
    if (tIndex < translations.length) {
      translationMap.set(chunk.innerHtml, translations[tIndex]);
    }
    tIndex++;
  }
}

const tags = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div'];
let newContent = content;

for (const tag of tags) {
  const regex = new RegExp(`<${tag}([^>]*)>(.*?)<\/${tag}>`, 'gs');
  newContent = newContent.replace(regex, (match, attrs, innerHTML) => {
    const innerTrim = innerHTML.trim();
    if (!innerTrim || innerTrim === '<br/>' || innerTrim.startsWith('<img')) return match;
    
    const en = translationMap.get(innerHTML);
    if (!en) return match;
    
    // Wrap original in tsuzuri-ja and translated in tsuzuri-en
    // For paragraphs, it's straightforward.
    return `<${tag}${attrs}><span class="tsuzuri-ja">${innerHTML}</span><span class="tsuzuri-en">${en}</span></${tag}>`;
  });
}

writeFileSync(filePath, newContent);
console.log(`Injected translations into ${filePath}`);
