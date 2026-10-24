#!/usr/bin/env python3
"""pack_data.py <folder> [out.pack] - pack an app's data folder into one compressed file.

kit/tools/build.py runs this for every folder in an app (apps/<app>/<folder>/ -> <folder>.pack
next to the app's code); the app reads it with kit/runtime/pack.js. Can also be run by hand to
see the sizes.

Each file is deflated on its own, so the app only inflates what it looks up. A JSON object file
bigger than SPLIT bytes is stored in parts by the first two characters of its keys (upper case):
a lookup then inflates a few KB instead of the whole table. Files listed in the folder's
.packignore (one glob per line, '#' comments) are left out.

Format: b'MGUPACK1', u32 LE index length, the index (raw deflate of JSON
{"files": {name: [offset, length]}, "split": {name: true}}; split parts are "name#XX"), then the
data, offsets counted from the end of the index.
"""
import fnmatch, json, os, struct, sys, zlib

MAGIC = b'MGUPACK1'
SPLIT = 32 * 1024


def deflate(b):
    c = zlib.compressobj(9, zlib.DEFLATED, -15, 9)
    return c.compress(b) + c.flush()


def dump(o):
    return json.dumps(o, ensure_ascii=False, separators=(',', ':'), sort_keys=True).encode('utf-8')


def pack(folder, out):
    ignore = ['.packignore']
    pi = os.path.join(folder, '.packignore')
    if os.path.isfile(pi):
        ignore += [l.strip() for l in open(pi, encoding='utf-8') if l.strip() and not l.startswith('#')]
    entries, split, raw_total = [], {}, 0
    for root, dirs, files in os.walk(folder):
        dirs.sort()
        for f in sorted(files):
            rel = os.path.relpath(os.path.join(root, f), folder).replace(os.sep, '/')
            if any(fnmatch.fnmatch(rel, g) for g in ignore):
                continue
            data = open(os.path.join(root, f), 'rb').read()
            raw_total += len(data)
            obj = None
            if rel.endswith('.json') and len(data) > SPLIT:
                try:
                    obj = json.loads(data.decode('utf-8-sig'))
                except ValueError:
                    obj = None
            if isinstance(obj, dict) and obj and all(isinstance(k, str) and len(k) >= 2 for k in obj):
                parts = {}
                for k, v in obj.items():
                    parts.setdefault(k[:2].upper(), {})[k] = v
                split[rel] = True
                entries += [('%s#%s' % (rel, p), dump(d)) for p, d in sorted(parts.items())]
            else:
                entries.append((rel, data))
    files, blob = {}, []
    off = 0
    for name, data in entries:
        z = deflate(data)
        files[name] = [off, len(z)]
        blob.append(z)
        off += len(z)
    index = deflate(dump({'files': files, 'split': split}))
    tmp = out + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(MAGIC + struct.pack('<I', len(index)) + index)
        for z in blob:
            f.write(z)
    os.replace(tmp, out)
    return raw_total, os.path.getsize(out), len(entries)


if __name__ == '__main__':
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    src = sys.argv[1].rstrip('/\\')
    dst = sys.argv[2] if len(sys.argv) == 3 else src + '.pack'
    raw, size, n = pack(src, dst)
    print('%s: %.1f MB in %d parts -> %s (%.2f MB)' % (src, raw / 1e6, n, dst, size / 1e6))
