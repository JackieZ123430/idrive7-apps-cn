#!/usr/bin/env python3
"""dtc_tables.py - put the fault text tables into the Fault Scanner, split so the head unit only reads
what it needs.

    python kit/tools/dtc_tables.py <folder or .zip with the dtc_scanner_*.json tables> [out_dir]

out_dir defaults to apps/dtc_scanner/dtc_db/tables (not in git: the texts are BMW's). Input tables:
    dtc_scanner_variant_exact.json  "<sgbd>:<code>"    the text for exactly that control unit type
    dtc_scanner_addr_exact.json     "<address>:<code>" the text every type at that address agrees on
    dtc_scanner_ecu_matches.json    "<address>:<code>" matched by unit name in the text
    dtc_scanner_ecu_hints.json      "<address>:<code>" by unit name hint
    dtc_scanner_texts.json          "<code>"           code-only texts (kit/tools/dtc_csv.py)
    dtc_scanner_ambiguous.json      "<code>": n        codes with n different texts (no single text)
Run dtc_texts.py --db first: unit types its
sgbd_index.json can't identify are left out.
Written:
    variant/<sgbd>.json   { code: text }   from variant_exact
    addr/<address>.json   { code: text }   addr_exact, else ecu_matches, else ecu_hints
    codes.json            { code: text }   dtc_scanner_texts
    ambiguous.json        { code: n }
Missing tables are skipped. Then rebuild the dtc_scanner app (kit/tools/build.py dtc_scanner).
"""
import json, os, re, shutil, sys, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', 'apps', 'dtc_scanner', 'dtc_db', 'tables')
NAMES = ('dtc_scanner_variant_exact.json', 'dtc_scanner_addr_exact.json', 'dtc_scanner_ecu_matches.json', 'dtc_scanner_ecu_hints.json',
         'dtc_scanner_texts.json', 'dtc_scanner_ambiguous.json')


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
        sys.exit('%s: no dtc_scanner_*.json tables found' % sys.argv[1])
    out = sys.argv[2] if len(sys.argv) == 3 else OUT
    variants, addrs = {}, {}
    for k, text in t.get('dtc_scanner_variant_exact.json', {}).items():
        v, _, c = k.rpartition(':')
        if re.fullmatch(r'[a-z0-9_]+', v.lower()) and text:
            variants.setdefault(v.lower(), {}).setdefault(code(c), text)
    # first table wins: exact address texts, then the unit-name matches, then the hints
    for name in ('dtc_scanner_addr_exact.json', 'dtc_scanner_ecu_matches.json', 'dtc_scanner_ecu_hints.json'):
        for k, text in t.get(name, {}).items():
            a, _, c = k.partition(':')
            if re.fullmatch(r'[0-9A-Fa-f]{1,2}', a) and text:
                addrs.setdefault(a.upper().zfill(2), {}).setdefault(code(c), text)
    # a unit type is only found through the SGBD index (dtc_texts.py --db, run that first): tables
    # for types no index entry leads to are never read, so they are left out
    idx = os.path.join(os.path.dirname(os.path.abspath(out)), 'sgbd_index.json')
    if os.path.isfile(idx):
        reach = {v.lower() for v in json.load(open(idx, encoding='utf-8')).values()}
        skipped = [v for v in variants if v not in reach]
        for v in skipped:
            del variants[v]
        print('%d control unit types not in sgbd_index.json left out (never identified)' % len(skipped))
    else:
        print('note: no sgbd_index.json next to %s (dtc_texts.py --db): all unit type tables kept' % out)
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
    dump({code(c): x for c, x in t.get('dtc_scanner_texts.json', {}).items() if x}, 'codes.json')
    dump({code(c): int(n) for c, n in t.get('dtc_scanner_ambiguous.json', {}).items() if str(n).isdigit()}, 'ambiguous.json')
    shutil.rmtree(out, ignore_errors=True)
    os.replace(tmp, out)
    print('fault text tables: %d control unit types, %d addresses, %d code-only texts -> %s' % (
        len(variants), len(addrs), len(t.get('dtc_scanner_texts.json', {})), os.path.normpath(out)))


if __name__ == '__main__':
    main()
