import { readFileSync, writeFileSync } from 'node:fs';

const filePath = process.argv[2];
const refinedPath = process.argv[3];

let content = readFileSync(filePath, 'utf8');
const refined = JSON.parse(readFileSync(refinedPath, 'utf8'));

// Regex to find the pairs
let index = 0;
const regex = /<span class="tsuzuri-ja">(.*?)<\/span><span class="tsuzuri-en">(.*?)<\/span>/gs;

const newContent = content.replace(regex, (match, ja, en) => {
  const newEn = refined[index] || en;
  index++;
  return `<span class="tsuzuri-ja">${ja}</span><span class="tsuzuri-en">${newEn}</span>`;
});

writeFileSync(filePath, newContent);
console.log(`Updated ${index} refined translations in ${filePath}`);
