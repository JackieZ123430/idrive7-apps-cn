#!/usr/bin/env python3
"""qrlog_decode.py - turn photos of an app's QR log (Settings > QR log, kit/runtime/qrlog.js) back into the log.

    pip install zxing-cpp pillow
    python3 kit/tools/qrlog_decode.py photo1.jpg photo2.jpg ...   (or a folder of photos)

Prints the log in time order (page 1 holds the newest lines, so it comes last) (a photo with several codes, or the same page twice, is fine). A page that
didn't read is named, so you can ask for that photo again.

A code is a text line "MGULOG2 d<n> <app> <version> <page>/<pages>" and a newline, then the page's log lines
compressed with raw deflate and the preset dictionary kit/runtime/qrlog-dict-<n>.txt (d0: none). In a page, a time
after the first is "+<seconds>" since the line before; the decoder writes hh:mm:ss again.
"""
import os
import sys
import zlib

try:
    import zxingcpp
    from PIL import Image, ImageFilter, ImageOps
except ImportError:
    sys.exit('needs: pip install zxing-cpp pillow')

MAGIC = b'MGULOG2 '
DICTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'runtime')


def dictionary(n):
    if n == 0:
        return None
    with open(os.path.join(DICTS, 'qrlog-dict-%d.txt' % n), 'rb') as f:
        return f.read()


def abs_times(text):
    """'+<seconds> ' after the line before -> hh:mm:ss again."""
    out, last = [], None
    for line in text.split('\n'):
        head, _, rest = line.partition(' ')
        if len(head) == 8 and head[2] == ':' and head[5] == ':' and head.replace(':', '').isdigit():
            h, m, s = (int(x) for x in head.split(':'))
            last = h * 3600 + m * 60 + s
        elif head[:1] == '+' and head[1:].isdigit() and last is not None:
            last += int(head[1:])
            line = '%02d:%02d:%02d %s' % (last // 3600 % 24, last // 60 % 60, last % 60, rest)
        out.append(line)
    return '\n'.join(out)


def codes(path):
    """The QR codes' bytes in one photo (as is, then cleaned up: grey with more contrast, sharpened, bigger)."""
    img = ImageOps.exif_transpose(Image.open(path)).convert('RGB')
    grey = ImageOps.autocontrast(img.convert('L'), cutoff=1)
    sharp = grey.filter(ImageFilter.UnsharpMask(radius=3, percent=200, threshold=0))
    big = sharp.resize((sharp.width * 2, sharp.height * 2), Image.LANCZOS)
    found = []
    for im in (img, grey, sharp, big):
        for r in zxingcpp.read_barcodes(im, formats=zxingcpp.BarcodeFormat.QRCode):
            if r.valid and r.bytes not in found:
                found.append(bytes(r.bytes))
        if found:
            break
    return found


def page(data):
    """A code's bytes -> (app version, page, pages, text) or None if it isn't a QR log code."""
    if not data.startswith(MAGIC) or b'\n' not in data:
        return None
    head, body = data.split(b'\n', 1)
    words = head.decode('utf8', 'replace').split(' ')
    try:
        n, of = (int(x) for x in words[-1].split('/'))
        d = dictionary(int(words[1][1:]))
        z = zlib.decompressobj(-15, zdict=d) if d else zlib.decompressobj(-15)
        text = abs_times((z.decompress(body) + z.flush()).decode('utf8', 'replace'))
    except (ValueError, IndexError, OSError, zlib.error):
        return None
    return ' '.join(words[2:-1]), n, of, text


def main(args):
    files = []
    for a in args:
        if os.path.isdir(a):
            files += sorted(os.path.join(a, f) for f in os.listdir(a) if not f.startswith('.'))
        else:
            files.append(a)
    if not files:
        sys.exit(__doc__)
    logs = {}                                  # (app version, pages, page 1's text) -> {page: text}
    for f in files:
        try:
            got = [p for p in (page(c) for c in codes(f)) if p]
        except Exception as e:                 # not an image, unreadable file
            print('# %s: %s' % (f, e), file=sys.stderr)
            continue
        if not got:
            print('# %s: no QR log code found' % f, file=sys.stderr)
        for app, n, of, text in got:
            # photos of the QR log at different times are different logs (their page 1s differ): kept apart.
            # A page other than 1 joins the log it was photographed with (the same app, version and page count).
            key = (app, of, text if n == 1 else None)
            if n != 1:
                key = next((k for k in logs if k[:2] == (app, of) and n not in logs[k]), key)
            logs.setdefault(key, {})[n] = text
    for (app, of, _), pages in logs.items():
        missing = [str(i) for i in range(1, of + 1) if i not in pages]
        print('# %s, %d of %d pages%s' % (app, len(pages), of, ', missing: ' + ', '.join(missing) if missing else ''))
        for i in sorted(pages, reverse=True):      # page 1 is the newest: printed last, so the log reads in time order
            print(pages[i])
    return 0 if logs else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
