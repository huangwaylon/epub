
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node scripts/prepare_translation_data.mjs <xhtml-path>');
  process.exit(1);
}

const content = readFileSync(filePath, 'utf8');

// A very simple sentence splitter that handles some common Japanese punctuation
// but tries to be aware of tags.
function splitIntoSentences(html) {
  // This is a naive implementation. For a more robust one, we'd use a real parser.
  // But for this specific EPUB, we can try to find sentence endings not inside tags.
  
  const sentences = [];
  let current = '';
  let inTag = 0;
  
  for (let i = 0; i < html.length; i++) {
    const char = html[i];
    if (char === '<') inTag++;
    if (char === '>') inTag--;
    
    current += char;
    
    if (inTag === 0 && /[。！？]/.test(char)) {
      // Peak ahead to see if next is closing quote or something
      if (i + 1 < html.length && /[」』]/.test(html[i+1])) {
        current += html[i+1];
        i++;
      }
      sentences.push(current);
      current = '';
    }
  }
  if (current.trim()) {
    sentences.push(current);
  }
  return sentences;
}

const pRegex = /<p>(.*?)<\/p>/gs;
const matches = [...content.matchAll(pRegex)];
const data = [];

for (const match of matches) {
  const innerHTML = match[1];
  if (innerHTML.includes('<br/>') && innerHTML.trim() === '<br/>') continue;
  
  const sentences = splitIntoSentences(innerHTML);
  data.push({
    original: match[0],
    sentences: sentences.map(s => ({
      ja: s,
      en: "" // To be filled
    }))
  });
}

writeFileSync(filePath + '.json', JSON.stringify(data, null, 2));
console.log(`Extracted ${data.length} paragraphs to ${filePath}.json`);
