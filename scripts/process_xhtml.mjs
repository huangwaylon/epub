
import { readFileSync, writeFileSync } from 'node:fs';

const filePath = process.argv[2];
const mode = process.argv[3]; // 'extract' or 'inject'
const translationsPath = process.argv[4];

if (!filePath || !mode) {
  console.error('Usage: node scripts/process_xhtml.mjs <xhtml-path> <extract|inject> [translations-json]');
  process.exit(1);
}

const content = readFileSync(filePath, 'utf8');

function cleanHtml(html) {
  // Strip koboSpan tags but keep their content
  // Example: <span ... class="koboSpan" ...>...</span>
  // We use a simple regex for this as they are usually simple
  let cleaned = html.replace(/<span[^>]*class="koboSpan"[^>]*>(.*?)<\/span>/gs, '$1');
  // Sometimes they are nested or multiple, so repeat once
  cleaned = cleaned.replace(/<span[^>]*class="koboSpan"[^>]*>(.*?)<\/span>/gs, '$1');
  return cleaned;
}

function splitSentences(html) {
  const sentences = [];
  let current = '';
  let inTag = 0;
  
  for (let i = 0; i < html.length; i++) {
    const char = html[i];
    if (char === '<') inTag++;
    if (char === '>') inTag--;
    
    current += char;
    
    if (inTag === 0 && /[。！？]/.test(char)) {
      if (i + 1 < html.length && /[」』]/.test(html[i+1])) {
        current += html[i+1];
        i++;
      }
      sentences.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) {
    sentences.push(current.trim());
  }
  return sentences;
}

if (mode === 'extract') {
  // Match content inside any tag that might contain text
  const tags = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'dd', 'dt', 'div'];
  const allSentences = new Set();
  
  for (const tag of tags) {
    const regex = new RegExp(`<${tag}[^>]*>(.*?)<\/${tag}>`, 'gs');
    const matches = [...content.matchAll(regex)];
    for (const match of matches) {
      const inner = match[1].trim();
      if (!inner || inner === '<br/>') continue;
      const sentences = splitSentences(inner);
      for (const s of sentences) {
        allSentences.add(s);
      }
    }
  }
  
  writeFileSync(filePath + '.sentences.json', JSON.stringify([...allSentences], null, 2));
  console.log(`Extracted ${allSentences.size} unique sentences to ${filePath}.sentences.json`);

} else if (mode === 'inject') {
  const translations = JSON.parse(readFileSync(translationsPath, 'utf8'));
  const tags = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'dd', 'dt', 'div'];
  let newContent = content;

  for (const tag of tags) {
    const regex = new RegExp(`<${tag}([^>]*)>(.*?)<\/${tag}>`, 'gs');
    newContent = newContent.replace(regex, (match, attrs, innerHTML) => {
      const innerTrim = innerHTML.trim();
      if (!innerTrim || innerTrim === '<br/>' || innerTrim.startsWith('<img')) return match;
      
      const sentences = splitSentences(innerHTML);
      const processedSentences = sentences.map(s => {
        const en = translations[s] || '';
        if (!en) return `<span class="tsuzuri-ja">${s}</span>`;
        return `<span class="tsuzuri-ja">${s}</span><span class="tsuzuri-en">${en}</span>`;
      });
      
      return `<${tag}${attrs}>${processedSentences.join('')}</${tag}>`;
    });
  }
  
  writeFileSync(filePath, newContent);
  console.log(`Injected translations into ${filePath}`);
}
