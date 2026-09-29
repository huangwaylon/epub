import { readFileSync, writeFileSync } from 'node:fs';

const filePath = process.argv[2];
const outPath = filePath + '.chunks.json';

const content = readFileSync(filePath, 'utf8');

// Match <p>, <div>, <h1-6> that contain text
const tags = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div'];
const chunks = [];

let currentContent = content;

for (const tag of tags) {
  const regex = new RegExp(`<${tag}([^>]*)>(.*?)<\/${tag}>`, 'gs');
  const matches = [...currentContent.matchAll(regex)];
  
  for (const match of matches) {
    const inner = match[2].trim();
    if (!inner || inner === '<br/>' || inner.startsWith('<img')) continue;
    
    // Clean ruby for translation context, but keep it in the original
    const textForTranslation = inner.replace(/<rt>.*?<\/rt>/g, '').replace(/<[^>]*>?/gm, '');
    
    if (textForTranslation.trim().length > 0) {
      chunks.push({
        tag: match[0],
        innerHtml: inner,
        textForTranslation: textForTranslation.trim()
      });
    }
  }
}

// Group chunks into manageable blocks (e.g. 50 paragraphs per batch) for the LLM
const BATCH_SIZE = 50;
const batches = [];
for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
  batches.push(chunks.slice(i, i + BATCH_SIZE));
}

writeFileSync(outPath, JSON.stringify(batches, null, 2));
console.log(`Extracted ${chunks.length} chunks into ${batches.length} batches: ${outPath}`);
