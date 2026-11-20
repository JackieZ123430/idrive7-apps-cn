#!/usr/bin/env python3
"""Rebuild the Russian glyph atlas from the Ubuntu font (Pillow required).

python3 kit/tools/bake_cyrillic.py [path/to/Ubuntu.ttf]
The generated atlas is committed; normal builds need no Pillow or font download.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent


def main():
    font = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path('/usr/share/fonts/truetype/ubuntu/Ubuntu[wdth,wght].ttf')
    if not font.is_file():
        raise SystemExit('Ubuntu font not found; pass the path to Ubuntu.ttf')
    spec = importlib.util.spec_from_file_location('bake_fonts', HERE / 'bake_fonts.py')
    baker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(baker)
    baker.FONTDIR = str(font.parent)
    words = json.loads((ROOT / 'kit/runtime/locales/ru.json').read_text(encoding='utf-8'))
    from build_diagnostic_ru import catalog
    words.update(catalog())
    credit = ROOT / 'kit/localization/credit.ru.json'
    credit_source = credit.read_text(encoding='utf-8') if credit.exists() else ''
    chars = ''.join(sorted(set(baker.TEXT + ''.join(words.values()) + credit_source)))
    atlas = baker.bake(font.name, (85, 500) if font.name == 'Ubuntu[wdth,wght].ttf' else None, 48, chars)
    if atlas['atlasH'] > 2048:
        raise SystemExit('Cyrillic atlas exceeds its reserved GPU budget')
    cache_key = hashlib.sha256(json.dumps(atlas, separators=(',', ':')).encode()).hexdigest()[:16]
    data = {'family': 'cyrillic', 'source': 'Ubuntu (Ubuntu Font Licence 1.0)', 'cacheKey': cache_key, 'sizes': [atlas]}
    out = ROOT / 'kit/localization/fonts/cyrillic-ru.json'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    print('cyrillic:', len(chars), 'glyphs,', atlas['atlasW'], 'x', atlas['atlasH'], 'pixels,', out.stat().st_size, 'bytes')


if __name__ == '__main__':
    main()
