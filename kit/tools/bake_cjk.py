#!/usr/bin/env python3
"""Rebuild the shared Chinese glyph atlas. Pillow is required only to regenerate it.

python kit/tools/bake_cjk.py [path/to/NotoSansSC.ttf]
Without a path, downloads the OFL font from Google Fonts and checks its SHA-256.
The generated atlas is committed; normal app builds need no Pillow/font download.
"""
import hashlib
import argparse
import importlib.util
import json
from pathlib import Path
import sys
import urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
URL = 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf'
SHA256 = 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da'
TC_URL = 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosanstc/NotoSansTC%5Bwght%5D.ttf'
TC_SHA256 = '864727d210d54f2537bbe23b3a839436c3992af72de9322af5270897246bd44f'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('font', nargs='?')
    parser.add_argument('--language', choices=('zh-CN', 'zh-TW'), default='zh-CN')
    args = parser.parse_args()
    traditional = args.language == 'zh-TW'
    filename = 'NotoSansTC.ttf' if traditional else 'NotoSansSC.ttf'
    url, checksum = (TC_URL, TC_SHA256) if traditional else (URL, SHA256)
    font = Path(args.font).resolve() if args.font else HERE / ('.font-cache/' + filename)
    if not font.exists():
        font.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(url, timeout=120) as response:
            font.write_bytes(response.read())
    if hashlib.sha256(font.read_bytes()).hexdigest() != checksum:
        raise SystemExit(filename + ' SHA-256 mismatch; refusing to bake a different font')
    spec = importlib.util.spec_from_file_location('bake_fonts', HERE / 'bake_fonts.py')
    baker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(baker)
    baker.FONTDIR = str(font.parent)
    words = json.loads((ROOT / ('kit/runtime/locales/' + args.language + '.json')).read_text(encoding='utf-8'))
    # Only the app's own translated glyphs, ASCII and its units/symbols: never the full CJK block.
    credit_source = (ROOT / 'kit/runtime/credits.js').read_text(encoding='utf-8')
    chars = ''.join(sorted(set(baker.TEXT + ''.join(words.values()) + credit_source + '漢化')))
    # Keep each installed language's atlas inside the same reserved GPU budget.
    for size in (48, 44, 40):
        atlas = baker.bake(font.name, (500,), size, chars)
        if atlas['atlasH'] <= 2048:
            break
    # Prebuilt renderer packs 1024-wide atlases into two 4096-high columns.
    if atlas['atlasH'] > 2048:
        raise SystemExit('Chinese atlas exceeds its reserved GPU budget; subset it before publishing')
    cache_key = hashlib.sha256(json.dumps(atlas, separators=(',', ':')).encode()).hexdigest()[:16]
    data = {'family': 'cjk', 'source': ('Noto Sans TC' if traditional else 'Noto Sans SC') + ' (OFL-1.1)', 'cacheKey': cache_key, 'sizes': [atlas]}
    out = ROOT / ('kit/localization/fonts/zh-TW.json' if traditional else 'kit/runtime/fonts/cjk.json')
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    print('cjk:', len(chars), 'glyphs,', atlas['atlasW'], 'x', atlas['atlasH'], 'pixels,', out.stat().st_size, 'bytes')


if __name__ == '__main__':
    main()
