#!/usr/bin/env python3
"""Rebuild the shared Chinese glyph atlas. Pillow is required only to regenerate it.

python kit/tools/bake_cjk.py [path/to/NotoSansSC.ttf]
python kit/tools/bake_cjk.py --diagnostic [path/to/NotoSansSC.ttf]
python kit/tools/bake_cjk.py --language zh-TW [path/to/NotoSansTC.ttf]
Use --diagnostic for the separate Fault Scanner atlas; default is the UI atlas.
--language zh-TW bakes the Traditional Chinese UI atlas from Noto Sans TC into
kit/localization/fonts/cjk-zh-TW.json (build.py ships it in zh-TW packages).
Without a path, downloads the OFL font from Google Fonts and checks its SHA-256.
The generated atlas is committed; normal app builds need no Pillow/font download.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent

# language: (font file, download URL, SHA-256, source credit, UI atlas, diagnostic atlas)
FONTS = {
    'zh-CN': ('NotoSansSC.ttf',
              'https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf',
              'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da',
              'Noto Sans SC (OFL-1.1)',
              'kit/runtime/fonts/cjk.json', 'kit/localization/fonts/diagnostic-zh-CN.json'),
    'zh-TW': ('NotoSansTC.ttf',
              'https://raw.githubusercontent.com/google/fonts/main/ofl/notosanstc/NotoSansTC%5Bwght%5D.ttf',
              '864727d210d54f2537bbe23b3a839436c3992af72de9322af5270897246bd44f',
              'Noto Sans TC (OFL-1.1)',
              'kit/localization/fonts/cjk-zh-TW.json', None),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--language', choices=FONTS, default='zh-CN')
    parser.add_argument('--diagnostic', action='store_true')
    parser.add_argument('font', nargs='?', type=Path)
    args = parser.parse_args()
    language = args.language
    diagnostic = args.diagnostic
    font_name, url, sha256, source, ui_out, diagnostic_out = FONTS[language]
    if diagnostic and not diagnostic_out:
        parser.error('No diagnostic catalog for %s' % language)
    font = args.font.resolve() if args.font else HERE / '.font-cache' / font_name
    if not font.exists():
        font.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(url, timeout=120) as response:
            font.write_bytes(response.read())
    if hashlib.sha256(font.read_bytes()).hexdigest() != sha256:
        raise SystemExit('%s SHA-256 mismatch; refusing to bake a different font' % font_name)
    spec = importlib.util.spec_from_file_location('bake_fonts', HERE / 'bake_fonts.py')
    baker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(baker)
    baker.FONTDIR = str(font.parent)
    words = json.loads((ROOT / 'kit/runtime/locales' / (language + '.json')).read_text(encoding='utf-8'))
    if diagnostic:
        from build_diagnostic_zh import catalog
        words.update(catalog())
    # Only the app's own translated glyphs, ASCII and its units/symbols: never the full CJK block.
    credit_file = ROOT / 'kit/localization' / ('credit.%s.json' % language)
    credit_source = credit_file.read_text(encoding='utf-8') if credit_file.exists() else ''
    chars = ''.join(sorted(set(baker.TEXT + ''.join(words.values()) + credit_source)))
    for size in (48, 44, 40, 36, 32):
        atlas = baker.bake(font.name, (500,), size, chars)
        if atlas['atlasH'] <= 2048:
            break
    # Keep a small total footprint; the runtime sends tall atlases to the GPU in pieces.
    if atlas['atlasH'] > 2048:
        raise SystemExit('Chinese atlas exceeds its reserved GPU budget; subset it before publishing')
    cache_key = hashlib.sha256(json.dumps(atlas, separators=(',', ':')).encode()).hexdigest()[:16]
    data = {'family': 'cjk', 'source': source, 'cacheKey': cache_key, 'sizes': [atlas]}
    out = ROOT / (diagnostic_out if diagnostic else ui_out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    print('cjk:', len(atlas['glyphs']), 'glyphs,', atlas['atlasW'], 'x', atlas['atlasH'], 'pixels,', out.stat().st_size, 'bytes')


if __name__ == '__main__':
    main()
