#!/usr/bin/env python3
"""Bake font atlases for kit/runtime/canvas.js (the head unit has no font
rasteriser available to apps, so glyphs are pre-rendered here at build time).

Output: kit/runtime/fonts/<family>.json  =  {"sizes": [{size, ascent, descent,
atlasW, atlasH, alpha: base64(zlib(8-bit alpha)), glyphs: {code: [x,y,w,h,ox,oy,adv]}}]}
ox/oy = glyph bitmap offset from (pen x, baseline y).

Needs Pillow (custom-apps/.venv). Free fonts only (Ubuntu font family).
"""
import base64, json, os, sys, zlib
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'runtime', 'fonts')
FONTDIR = '/usr/share/fonts/truetype/ubuntu'

TEXT = ''.join(chr(c) for c in range(32, 127)) + '°μ│·–—…×±²³€↑↓→←✓✕'
DIGITS = '0123456789.,:-+%°/ ' + 'kmhKMHrpmbarpsiVNCFgsxµRPDSWLOT'
GEAR = '0123456789NRPDSM-'

FAMILIES = {
    # family: (file, variation(wdth,wght) or None, [(size, charset)])
    'label': ('Ubuntu[wdth,wght].ttf', (85, 400), [(18, TEXT), (24, TEXT), (32, TEXT), (44, TEXT)]),
    'bold':  ('Ubuntu[wdth,wght].ttf', (85, 700), [(24, TEXT), (32, TEXT), (44, TEXT), (64, TEXT)]),
    'num':   ('Ubuntu[wdth,wght].ttf', (75, 500), [(40, TEXT), (64, DIGITS), (96, DIGITS), (150, DIGITS)]),
    'light': ('Ubuntu[wdth,wght].ttf', (85, 300), [(32, TEXT), (64, TEXT), (110, DIGITS)]),
    'gear':  ('Ubuntu[wdth,wght].ttf', (75, 700), [(200, GEAR), (300, GEAR)]),
}


def load(fname, var, size):
    f = ImageFont.truetype(os.path.join(FONTDIR, fname), size)
    if var:
        try:
            f.set_variation_by_axes(list(var))
        except Exception as e:  # static font
            print('  (no variations:', e, ')')
    return f


def bake(fname, var, size, charset):
    font = load(fname, var, size)
    ascent, descent = font.getmetrics()
    glyphs, imgs = {}, []
    for ch in dict.fromkeys(charset):
        try:
            bbox = font.getbbox(ch, anchor='ls')       # relative to baseline
        except Exception:
            continue
        adv = font.getlength(ch)
        w, h = max(0, bbox[2] - bbox[0]), max(0, bbox[3] - bbox[1])
        if w and h:
            im = Image.new('L', (w, h), 0)
            ImageDraw.Draw(im).text((-bbox[0], -bbox[1]), ch, font=font, fill=255, anchor='ls')
        else:
            im = None
        imgs.append((ch, im, bbox, adv))
    # shelf-pack
    W = 1024
    x = y = rowh = 0
    place = {}
    for ch, im, bbox, adv in imgs:
        if im is None:
            place[ch] = (0, 0, 0, 0)
            continue
        if x + im.width > W:
            x, y, rowh = 0, y + rowh + 1, 0
        place[ch] = (x, y, im.width, im.height)
        x += im.width + 1
        rowh = max(rowh, im.height)
    H = y + rowh + 1
    atlas = Image.new('L', (W, H), 0)
    for ch, im, bbox, adv in imgs:
        px, py, pw, ph = place[ch]
        if im is not None:
            atlas.paste(im, (px, py))
        glyphs[ord(ch)] = [px, py, pw, ph, bbox[0], bbox[1], round(adv, 2)]
    return {'size': size, 'ascent': ascent, 'descent': descent, 'atlasW': W, 'atlasH': H,
            'alpha': base64.b64encode(zlib.compress(atlas.tobytes(), 9)).decode(), 'glyphs': glyphs}


def main():
    os.makedirs(OUT, exist_ok=True)
    for fam, (fname, var, sizes) in FAMILIES.items():
        data = {'family': fam, 'source': fname, 'sizes': [bake(fname, var, s, cs) for s, cs in sizes]}
        p = os.path.join(OUT, fam + '.json')
        json.dump(data, open(p, 'w', encoding='utf-8', newline='\n'), separators=(',', ':'))
        print(f'{fam}: {[s for s, _ in sizes]} -> {os.path.getsize(p) // 1024} KiB')


if __name__ == '__main__':
    main()
