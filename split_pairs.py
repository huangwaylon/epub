import json
import os

def split_json(file_path, chunk_size=100):
    with open(file_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    base_name = file_path.replace('.pairs.json', '')
    chunks_dir = base_name + '_chunks'
    os.makedirs(chunks_dir, exist_ok=True)
    
    for i in range(0, len(data), chunk_size):
        chunk = data[i:i + chunk_size]
        chunk_path = os.path.join(chunks_dir, f'chunk_{i//chunk_size:03d}.json')
        with open(chunk_path, 'w', encoding='utf-8') as f:
            json.dump(chunk, f, ensure_ascii=False, indent=2)
    print(f"Split {file_path} into {(len(data) + chunk_size - 1) // chunk_size} chunks in {chunks_dir}")

split_json('/Users/waylonhuang/.gemini/tmp/epub/work_morisaki/OEBPS/Text/part0001.xhtml.pairs.json')
split_json('/Users/waylonhuang/.gemini/tmp/epub/work_morisaki/OEBPS/Text/part0003.xhtml.pairs.json')
