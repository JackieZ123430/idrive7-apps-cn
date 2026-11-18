#!/usr/bin/env python3
"""Rebuild the Spanish glyph atlases from the Ubuntu font (Pillow with raqm required).

python3 kit/tools/bake_spanish.py [path/to/Ubuntu[wdth,wght].ttf]

Spanish is written in the Latin script the kit already draws, with a few more letters (á é í ó ú ü ñ,
¿ ¡ ...). The Spanish package therefore carries its own label, bold, light and num atlases: the same
families and sizes as kit/runtime/fonts, with those letters added after the existing ones. Every glyph
the English atlases have stays exactly as it is (same pixels, same place, same advance), so text that
has no accent looks and measures the same in both languages. Their own cacheKey keeps them apart from
the English atlases in the renderer, which shares atlases between apps by family, size and key.

The English atlases were baked with raqm (HarfBuzz advances); without it Pillow rounds every advance
to whole pixels and the check below fails. The generated atlases are committed; normal builds need no
Pillow or font download.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
FAMILIES = ('label', 'bold', 'light', 'num')
# The letters a Spanish iDrive's own texts use (the Service app draws the car's item names and hints)
SPANISH = 'ÁÉÍÓÚÜÑáéíóúüñ¿¡ºª«»'
OUT = ROOT / 'kit/localization/fonts/es'


def main():
    font = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path('/usr/share/fonts/truetype/ubuntu/Ubuntu[wdth,wght].ttf')
    if not font.is_file():
        raise SystemExit('Ubuntu font not found; pass the path to Ubuntu[wdth,wght].ttf')
    from PIL import features
    if not features.check('raqm'):
        raise SystemExit('Pillow has no raqm layout here (libraqm, libfribidi, libharfbuzz): the advances would not match the English atlases')
    spec = importlib.util.spec_from_file_location('bake_fonts', HERE / 'bake_fonts.py')
    baker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(baker)
    baker.FONTDIR = str(font.parent)
    words = json.loads((ROOT / 'kit/runtime/locales/es.json').read_text(encoding='utf-8'))
    credit = ROOT / 'kit/localization/credit.es.json'
    credit_source = credit.read_text(encoding='utf-8') if credit.exists() else ''
    used = set(SPANISH + ''.join(words.values()) + credit_source) - set('\n\r\t')
    extra = ''.join(sorted(ch for ch in used if ch not in baker.TEXT))
    OUT.mkdir(parents=True, exist_ok=True)
    for family in FAMILIES:
        fname, var, sizes = baker.FAMILIES[family]
        english = json.loads((ROOT / 'kit/runtime/fonts' / (family + '.json')).read_text(encoding='utf-8'))
        baked = []
        for (size, charset), before in zip(sizes, english['sizes']):
            atlas = baker.bake(fname, var, size, charset + extra if charset == baker.TEXT else charset)
            for code, glyph in before['glyphs'].items():
                if atlas['glyphs'][int(code)] != glyph:
                    raise SystemExit('%s %d: glyph %r differs from the English atlas' % (family, size, chr(int(code))))
            if atlas['atlasH'] > 1024:
                raise SystemExit('%s %d: atlas exceeds 1024 rows' % (family, size))
            baked.append(atlas)
        cache_key = hashlib.sha256(json.dumps(baked, separators=(',', ':')).encode()).hexdigest()[:16]
        data = {'family': family, 'source': fname, 'cacheKey': cache_key, 'sizes': baked}
        out = OUT / (family + '.json')
        out.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
        print('%s: %d extra glyphs, sizes %s, %d bytes' % (family, len(extra), [a['size'] for a in baked], out.stat().st_size))


if __name__ == '__main__':
    main()
