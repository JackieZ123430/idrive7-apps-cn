#!/usr/bin/env python3
"""ista_tables.py - put ISTA fault texts into the Fault Scanner, split so the head unit only reads
what it needs.

    python kit/tools/ista_tables.py <folder or .zip with the ista_*.json tables> [out_dir]

out_dir defaults to apps/dtc_scanner/dtc_db/ista (not in git: the texts are BMW's). Input tables:
    ista_variant_exact.json  "<sgbd>:<code>"    the text for exactly that control unit type
    ista_addr_exact.json     "<address>:<code>" the text every type at that address agrees on
    ista_ecu_matches.json    "<address>:<code>" matched by unit name in the text
    ista_ecu_hints.json      "<address>:<code>" by unit name hint
    ista_texts.json          "<code>"           code-only texts (kit/tools/import_ista_csv.py)
    ista_ambiguous.json      "<code>": n        codes with n different texts (no single text)
Written:
    variant/<sgbd>.json   { code: text }   from variant_exact
    addr/<address>.json   { code: text }   addr_exact, else ecu_matches, else ecu_hints
    codes.json            { code: text }   ista_texts
    ambiguous.json        { code: n }
Missing tables are skipped. Then rebuild the dtc_scanner app (kit/tools/build.py dtc_scanner).
"""
import json, os, re, shutil, sys, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', 'apps', 'dtc_scanner', 'dtc_db', 'ista')
NAMES = ('ista_variant_exact.json', 'ista_addr_exact.json', 'ista_ecu_matches.json', 'ista_ecu_hints.json',
         'ista_texts.json', 'ista_ambiguous.json')


def load(src):
    """{table name: dict} from a folder (any depth) or a zip."""
    found = {}
    if zipfile.is_zipfile(src):
        with zipfile.ZipFile(src) as z:
            for n in z.namelist():
                base = n.replace('\\', '/').split('/')[-1]
                if base in NAMES and base not in found:
                    found[base] = json.loads(z.read(n).decode('utf-8-sig'))
    else:
        for root, _, files in os.walk(src):
            for base in files:
                if base in NAMES and base not in found:
                    with open(os.path.join(root, base), encoding='utf-8-sig') as f:
                        found[base] = json.load(f)
    return found


def code(c):
    """'0x21f026' / '21F026' -> '21F026' (as the scanner shows codes)."""
    s = str(c).strip().upper()
    return (s[2:] if s.startswith('0X') else s).zfill(6)


def main():
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    t = load(sys.argv[1])
    if not t:
        sys.exit('%s: no ista_*.json tables found' % sys.argv[1])
    out = sys.argv[2] if len(sys.argv) == 3 else OUT
    variants, addrs = {}, {}
    for k, text in t.get('ista_variant_exact.json', {}).items():
        v, _, c = k.rpartition(':')
        if re.fullmatch(r'[a-z0-9_]+', v.lower()) and text:
            variants.setdefault(v.lower(), {}).setdefault(code(c), text)
    # first table wins: exact address texts, then the unit-name matches, then the hints
    for name in ('ista_addr_exact.json', 'ista_ecu_matches.json', 'ista_ecu_hints.json'):
        for k, text in t.get(name, {}).items():
            a, _, c = k.partition(':')
            if re.fullmatch(r'[0-9A-Fa-f]{1,2}', a) and text:
                addrs.setdefault(a.upper().zfill(2), {}).setdefault(code(c), text)
    tmp = out.rstrip('/\\') + '.new'
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(os.path.join(tmp, 'variant'))
    os.makedirs(os.path.join(tmp, 'addr'))

    def dump(d, *p):
        with open(os.path.join(tmp, *p), 'w', encoding='utf-8', newline='\n') as f:
            json.dump(d, f, ensure_ascii=False, separators=(',', ':'), sort_keys=True)
    for v, d in variants.items():
        dump(d, 'variant', v + '.json')
    for a, d in addrs.items():
        dump(d, 'addr', a + '.json')
    dump({code(c): x for c, x in t.get('ista_texts.json', {}).items() if x}, 'codes.json')
    dump({code(c): int(n) for c, n in t.get('ista_ambiguous.json', {}).items() if str(n).isdigit()}, 'ambiguous.json')
    shutil.rmtree(out, ignore_errors=True)
    os.replace(tmp, out)
    print('ISTA texts: %d control unit types, %d addresses, %d code-only texts -> %s' % (
        len(variants), len(addrs), len(t.get('ista_texts.json', {})), os.path.normpath(out)))


if __name__ == '__main__':
    main()
