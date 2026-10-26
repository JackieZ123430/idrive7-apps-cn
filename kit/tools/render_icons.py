#!/usr/bin/env python3
"""
render_icons.py [app ...] - the app tile icons (apps/<id>/icon.png, 140 x 140) from kit/icons/<id>.svg

Each kit/icons/<id>.svg is the drawing for one app on a 140 x 140 canvas (its own <defs> + shapes),
with an accent colour on its first line:  <!-- accent: #rrggbb -->
This script renders it on a transparent background with a soft shadow (--tile: on a dark glass
tile with the accent's glow, rim light and gloss instead), at 4x with headless Chromium, and scales
it down, so the edges and gradients come out smooth. build.py packs apps/<id>/icon.png when it exists, so the
rendered PNGs are committed and a normal build needs none of this.

Needs: Pillow, and Chromium / Chrome (headless). Set CHROME=/path/to/chrome if it isn't found.
    python3 kit/tools/render_icons.py            # every icon
    python3 kit/tools/render_icons.py doom       # one
    python3 kit/tools/render_icons.py --sheet out.png   # also a preview sheet on black
    python3 kit/tools/render_icons.py --tile --out DIR  # on the glass tile instead
"""
import glob
import os
import re
import shutil
import subprocess
import sys
import tempfile

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
ICONS = os.path.join(ROOT, 'kit', 'icons')
APPS = os.path.join(ROOT, 'apps')
SIZE, SCALE = 140, 4

BARE = '''
<defs>
  <filter id="tile-shadow" x="-20%" y="-20%" width="140%" height="140%">
    <feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#000" flood-opacity="0.75"/>
  </filter>
</defs>
<g filter="url(#tile-shadow)">{art}</g>
'''

TILE = '''
<defs>
  <linearGradient id="tile-bg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#363a42"/><stop offset="0.55" stop-color="#16181c"/><stop offset="1" stop-color="#08090b"/>
  </linearGradient>
  <radialGradient id="tile-glow" cx="0.5" cy="0.6" r="0.62">
    <stop offset="0" stop-color="{accent}" stop-opacity="0.55"/>
    <stop offset="0.55" stop-color="{accent}" stop-opacity="0.16"/>
    <stop offset="1" stop-color="{accent}" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="tile-rim" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#ffffff" stop-opacity="0.6"/><stop offset="0.35" stop-color="#ffffff" stop-opacity="0.1"/>
    <stop offset="0.8" stop-color="#ffffff" stop-opacity="0.04"/><stop offset="1" stop-color="{accent}" stop-opacity="0.7"/>
  </linearGradient>
  <linearGradient id="tile-gloss" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#ffffff" stop-opacity="0.16"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
  </linearGradient>
  <clipPath id="tile-clip"><rect x="4" y="4" width="132" height="132" rx="27"/></clipPath>
  <filter id="tile-shadow" x="-20%" y="-20%" width="140%" height="140%">
    <feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#000" flood-opacity="0.75"/>
  </filter>
</defs>
<rect x="4" y="4" width="132" height="132" rx="27" fill="url(#tile-bg)"/>
<rect x="4" y="4" width="132" height="132" rx="27" fill="url(#tile-glow)"/>
<g clip-path="url(#tile-clip)"><g filter="url(#tile-shadow)">{art}</g></g>
<path d="M4 31 Q4 4 31 4 H109 Q136 4 136 31 V58 Q70 44 4 66 Z" fill="url(#tile-gloss)" clip-path="url(#tile-clip)"/>
<rect x="4.75" y="4.75" width="130.5" height="130.5" rx="26.25" fill="none" stroke="url(#tile-rim)" stroke-width="1.5"/>
'''


def chrome():
    c = os.environ.get('CHROME')
    if c:
        return c
    for name in ('chrome-headless-shell', 'chromium', 'chromium-browser', 'google-chrome', 'chrome'):
        p = shutil.which(name)
        if p:
            return p
    found = sorted(glob.glob(os.path.expanduser('~/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')))
    if found:
        return found[-1]
    sys.exit('no Chromium / Chrome found - set CHROME=/path/to/it')


def page(app, bare=False):
    src = open(os.path.join(ICONS, app + '.svg'), encoding='utf-8').read()
    m = re.match(r'\s*<!--\s*accent:\s*(#[0-9a-fA-F]{6})\s*-->', src)
    accent = m.group(1) if m else '#2a8cff'
    art = src[m.end():] if m else src
    px = SIZE * SCALE
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{px}" height="{px}" viewBox="0 0 {SIZE} {SIZE}">'
           + (BARE if bare else TILE).replace('{accent}', accent).replace('{art}', art) + '</svg>')
    return f'<html><body style="margin:0;background:transparent;overflow:hidden">{svg}</body></html>'


def render(app, tmp, exe, bare=False, outdir=None):
    html = os.path.join(tmp, app + '.html')
    big = os.path.join(tmp, app + '.png')
    open(html, 'w', encoding='utf-8').write(page(app, bare))
    px = SIZE * SCALE
    subprocess.run([exe, '--no-sandbox', '--hide-scrollbars', '--default-background-color=00000000',
                    f'--window-size={px},{px}', f'--screenshot={big}', 'file://' + html],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
    im = Image.open(big).convert('RGBA').resize((SIZE, SIZE), Image.LANCZOS)
    out = os.path.join(outdir, app + '.png') if outdir else os.path.join(APPS, app, 'icon.png')
    im.save(out, optimize=True)
    return out


def main():
    args = sys.argv[1:]
    sheet = None
    bare = '--tile' not in args
    if not bare: args.remove('--tile')
    outdir = None
    if '--out' in args:
        i = args.index('--out'); outdir = args[i + 1]; del args[i:i + 2]; os.makedirs(outdir, exist_ok=True)
    if '--sheet' in args:
        i = args.index('--sheet'); sheet = args[i + 1]; del args[i:i + 2]
    apps = args or sorted(os.path.splitext(f)[0] for f in os.listdir(ICONS) if f.endswith('.svg'))
    exe = chrome()
    outs = []
    with tempfile.TemporaryDirectory() as tmp:
        for a in apps:
            outs.append(render(a, tmp, exe, bare, outdir))
            print('icon', a, '->', os.path.relpath(outs[-1], ROOT))
    if sheet:
        # on black, as on the head unit: 1:1 and at 2x
        cols = min(4, len(outs)); rows = (len(outs) + cols - 1) // cols
        im = Image.new('RGBA', (cols * 460, rows * 300), (0, 0, 0, 255))
        for i, f in enumerate(outs):
            ic = Image.open(f)
            x, y = (i % cols) * 460, (i // cols) * 300
            im.alpha_composite(ic, (x + 10, y + 80))
            im.alpha_composite(ic.resize((280, 280), Image.LANCZOS), (x + 165, y + 10))
        im.save(sheet)
        print('sheet', sheet)


if __name__ == '__main__':
    main()
