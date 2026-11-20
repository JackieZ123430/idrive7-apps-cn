#!/usr/bin/env python3
"""Bake the Korean UI and KS X 1001 Hangul into a shared, GPU-budgeted atlas.

python3 kit/tools/bake_korean.py /path/to/NotoSansCJK-Regular.ttc
Requires Pillow only when regenerating. Debian/Ubuntu: fonts-noto-cjk.
The Korean face in NotoSansCJK-Regular.ttc is collection index 1.
The generated atlas and OFL licence ship in Korean packages only.
"""
import argparse
import hashlib
import json
from pathlib import Path
import unicodedata

import bake_fonts as baker

ROOT = Path(__file__).resolve().parent.parent.parent


def charset(words):
    chars = set(baker.TEXT + ''.join(words.values()) + '년월일개월후이번달초과')
    # The 2,350 KS X 1001 syllables cover common vehicle-provided Korean text.
    # Other translated syllables are included explicitly, never silently omitted.
    for lead in range(0xB0, 0xC9):
        for trail in range(0xA1, 0xFF):
            chars.update(bytes((lead, trail)).decode('euc_kr'))
    chars.update(chr(c) for c in range(0x3131, 0x318F))
    return ''.join(sorted(chars - set('\n\r\t')))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('font', nargs='?', default='/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc')
    parser.add_argument('--index', type=int, default=1, help='Korean face index in the Noto CJK TTC')
    args = parser.parse_args()
    font = Path(args.font).resolve()
    if not font.is_file():
        raise SystemExit('Noto Sans CJK font missing; pass its path (see README.ko.md).')
    from PIL import ImageFont
    baker.load = lambda _name, _var, size: ImageFont.truetype(str(font), size, index=args.index)
    words = json.loads((ROOT / 'kit/runtime/locales/ko.json').read_text(encoding='utf-8'))
    chars = charset(words).replace('✕', '')
    for size in (36, 34, 32, 30, 28):
        atlas = baker.bake(font.name, None, size, chars)
        if atlas['atlasH'] <= 3072:
            break
    if atlas['atlasH'] > 3072:
        raise SystemExit('Korean atlas exceeds the GPU budget')
    # Noto CJK has the multiplication sign, but not the stylistic U+2715 cross.
    atlas['glyphs'][ord('✕')] = list(atlas['glyphs'][ord('×')])
    # Noto has every glyph requested. A glyph identical to the missing-glyph box
    # must never be accepted as a successful Korean bake.
    probe = ImageFont.truetype(str(font), atlas['size'], index=args.index)
    missing = bytes(probe.getmask('\uffff'))
    for ch in chars:
        if unicodedata.category(ch).startswith('C'):
            continue
        if bytes(probe.getmask(ch)) == missing:
            raise SystemExit('Font has no glyph for U+%04X' % ord(ch))
    cache_key = hashlib.sha256(json.dumps(atlas, separators=(',', ':')).encode()).hexdigest()[:16]
    data = {'family': 'korean', 'source': 'Noto Sans CJK KR (OFL-1.1)',
            'fontSha256': hashlib.sha256(font.read_bytes()).hexdigest(),
            'cacheKey': cache_key, 'sizes': [atlas]}
    out = ROOT / 'kit/localization/fonts/korean.json'
    out.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    print('Korean: %d glyphs, size %d, %d x %d, %d bytes' %
          (len(chars), atlas['size'], atlas['atlasW'], atlas['atlasH'], out.stat().st_size))


if __name__ == '__main__':
    main()
