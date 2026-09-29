import re
import json
import sys

def extract_segments(file_path):
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Extract pairs
    # Matches <span class="tsuzuri-ja">...</span> and <span class="tsuzuri-en">...</span>
    # They usually come in pairs.
    ja_spans = re.findall(r'<span class="tsuzuri-ja">(.*?)</span>', content, re.DOTALL)
    en_spans = re.findall(r'<span class="tsuzuri-en">(.*?)</span>', content, re.DOTALL)
    
    # Strip HTML tags
    ja_clean = [re.sub(r'<[^>]+>', '', span).strip() for span in ja_spans]
    en_clean = [re.sub(r'<[^>]+>', '', span).strip() for span in en_spans]
    
    return list(zip(ja_clean, en_clean))

for path in sys.argv[1:]:
    pairs = extract_segments(path)
    print(f"File: {path}, Count: {len(pairs)}")
    with open(path + ".pairs.json", "w", encoding="utf-8") as f:
        json.dump(pairs, f, ensure_ascii=False, indent=2)
