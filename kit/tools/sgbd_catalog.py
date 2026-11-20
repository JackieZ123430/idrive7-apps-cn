#!/usr/bin/env python3
"""sgbd_catalog.py - the values a control unit can be asked for, from its SGBD, for the Live Data app.

    python3 kit/tools/sgbd_catalog.py <sgbd | page.html> [out_dir]   catalog for one unit type
    python3 kit/tools/sgbd_catalog.py --index [out_dir]               SGBD index -> unit type table
    python3 kit/tools/sgbd_catalog.py --todo <SGBD> [n] [out_dir]     next n texts without English
    python3 kit/tools/sgbd_catalog.py --add <SGBD> <file.json> [out_dir]   merge English texts
    python3 kit/tools/sgbd_catalog.py --builtin [catalog_dir]       the app's built-in values

<sgbd> (e.g. dme8ff_r) is read from the public EdiabasX SGBD reference,
https://emdzej.github.io/ediabasx-docs-sgbd/sgbd/<sgbd>/ (a saved copy of that page works too).
out_dir defaults to apps/live_data/catalog (not in git: the tables are BMW's); build.py packs it
into the app (catalog.pack).

Only what can be READ goes in: the rows of SG_FUNKTIONEN whose SERVICE includes 22
(ReadDataByIdentifier) and that need no argument. Their RES_0x..._D tables give the fields of a
reply in byte order, BF_ tables split a byte into bits, and the tables a field's NAME points to
(WERT -> TEXT) name its values. Written:
    <SGBD>.json        { "<DID>": { "a": ARG, "d": text, "f": [field, ...] } }
                       field = { "n": RESULTNAME, "t": u8|s8|u16|s16|u32|s32|f32|hex|str, "at": byte
                       offset after the DID, "len" (hex, str), "m": bit mask, "k": factor (MUL / DIV),
                       "o": ADD, "u": unit, "x": shown in hex, "e": value table, "le": low byte first,
                       "d": text }
    <SGBD>.meta.json   { "sgbd", "ecu", "revision", "comment", "source", "order": [DIDs],
                       "enums": { table: { value: text } } }
    <SGBD>.en.json     { "<German text>": "<English>" } - kept as it is (--add merges into it)
value = raw * k + o; the texts are German, the app shows the English one when there is one.

--index copies sgbd_index.json ("<address> <SGBD index>" -> unit type) from the Fault Scanner's
database (apps/dtc_scanner/dtc_db.pack or dtc_db/), so the app knows which catalog a unit uses.

--builtin writes apps/live_data/builtin/ (in git): from a full catalog, only the identifiers the
app's Useful list (apps/live_data/useful.js) names, their value tables and English texts, and the
SGBD index. The app uses it when it has no full catalog for a unit type.
"""
import html, json, os, re, struct, sys, urllib.request, zlib
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(ROOT, 'apps', 'live_data', 'catalog')
URL = 'https://emdzej.github.io/ediabasx-docs-sgbd/sgbd/%s/'
SIZES = {'u8': 1, 's8': 1, 'u16': 2, 's16': 2, 'u32': 4, 's32': 4, 'f32': 4}
TYPES = {'unsigned char': 'u8', 'signed char': 's8', 'unsigned int': 'u16', 'signed int': 's16',
         'unsigned long': 'u32', 'signed long': 's32', 'motorola float': 'f32', 'intel float': 'f32'}
UNITS = {'° KW': '°CA', '1/min': 'rpm', '1/min/s': 'rpm/s', '% DK': '%'}     # the SGBD's units in English


def fetch(src):
    """the page's HTML and where it came from"""
    if os.path.isfile(src):
        with open(src, encoding='utf-8') as f:
            return f.read(), os.path.basename(src)
    url = URL % src.lower()
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read().decode('utf-8'), url


class Page:
    """the page's tables by heading: table(name) -> [ {column: cell} ]"""
    def __init__(self, text):
        self.text = text
        self.heads = [(m.start(), self.clean(m.group(1))) for m in re.finditer(r'<h[23][^>]*>(.*?)</h[23]>', text, re.S)]
        self.at = {}
        for k, (_, h) in enumerate(self.heads):
            self.at.setdefault(h.upper(), k)
        self.cache = {}

    @staticmethod
    def clean(s):
        return ' '.join(html.unescape(re.sub(r'<[^>]+>', '', s)).split())

    def has(self, name):
        return name.upper() in self.at

    def table(self, name):
        name = name.upper()
        if name in self.cache:
            return self.cache[name]
        k = self.at.get(name)
        rows = []
        if k is not None:
            start, end = self.heads[k][0], self.heads[k + 1][0] if k + 1 < len(self.heads) else len(self.text)
            cells = [[self.clean(c) for c in re.findall(r'<t[hd][^>]*>(.*?)</t[hd]>', r, re.S)]
                     for r in re.findall(r'<tr[^>]*>(.*?)</tr>', self.text[start:end], re.S)]
            if cells:
                rows = [dict(zip(cells[0], r)) for r in cells[1:]]
        self.cache[name] = rows
        return rows


def num(s, default):
    try:
        return float(s)
    except (TypeError, ValueError):
        return default


def given(s):
    return s not in (None, '', '-')


class Builder:
    def __init__(self, page):
        self.page = page
        self.enums = {}
        self.skipped = {}           # why -> count

    def skip(self, why):
        self.skipped[why] = self.skipped.get(why, 0) + 1

    def enum(self, name):
        if name in self.enums:
            return True
        rows = self.page.table(name)
        if not rows or 'WERT' not in rows[0]:
            return False
        vals = {}
        for r in rows:
            try:
                vals[str(int(r['WERT'], 0))] = r.get('TEXT', '')
            except ValueError:
                pass
        self.enums[name] = vals
        return True

    def field(self, row, at, desc):
        """[field, ...] for one row (a BITFIELD row gives one per bit group) and its size, or (None, why)"""
        typ = row.get('DATENTYP', '-')
        name = row.get('NAME', '-')
        if typ == 'BITFIELD':
            bits = self.page.table(name) if given(name) else []
            if not bits or 'MASKE' not in bits[0]:
                return None, 'bitfield without its table'
            out, size = [], 0
            for b in bits:
                fs, n = self.field(b, at, desc)
                if fs is None:
                    return None, n
                out += fs
                size = max(size, n)
            return out, size
        m = re.match(r'(data|string)\[(\d+)\]$', typ)
        if m:
            f = {'n': row.get('RESULTNAME', '-'), 't': 'hex' if m.group(1) == 'data' else 'str', 'at': at, 'len': int(m.group(2))}
            size = f['len']
        elif typ in TYPES:
            f = {'n': row.get('RESULTNAME', '-'), 't': TYPES[typ], 'at': at}
            size = SIZES[f['t']]
            mul, div, add = num(row.get('MUL'), 1.0), num(row.get('DIV'), 1.0), num(row.get('ADD'), 0.0)
            if div and (mul != 1.0 or div != 1.0):
                f['k'] = round(mul / div, 12)
            if add:
                f['o'] = add
            if given(row.get('MASKE')):
                f['m'] = int(row['MASKE'], 0)
            if given(name) and self.enum(name):
                f['e'] = name
            if typ == 'intel float' or (row.get('L/H') or '').lower() == 'low':
                f['le'] = 1
        else:
            return None, 'type ' + typ
        unit = row.get('EINHEIT')
        if unit == 'HEX' and f['t'] not in ('hex', 'str'):
            f['x'] = 1                  # shown as a hex number
        elif given(unit) and unit not in ('0-n', 'Bit', '0/1', 'HEX', 'DATA', 'TEXT'):
            f['u'] = UNITS.get(unit, unit)
        text = row.get('INFO', '')
        if given(text) and text != desc:
            f['d'] = text
        return [f], size

    def build(self):
        dids, order = {}, []
        for r in self.page.table('SG_FUNKTIONEN'):
            if '22' not in (r.get('SERVICE') or '').split(';'):
                self.skip('not readable (service ' + (r.get('SERVICE') or '-') + ')')
                continue
            if given(r.get('ARG_TABELLE')):
                self.skip('needs an argument')
                continue
            did = r['ID'].upper().replace('0X', '').zfill(4)
            if did in dids:
                self.skip('identifier listed twice')
                continue
            desc = r.get('INFO', '')
            fields = []
            if given(r.get('RES_TABELLE')):
                at = 0
                for row in self.page.table(r['RES_TABELLE']):
                    fs, n = self.field(row, at, desc)
                    if fs is None:
                        self.skip('field ' + n + ' (rest of the reply left out)')
                        break
                    fields += fs
                    at += n
            elif r.get('DATENTYP') not in (None, '', '-'):
                fs, n = self.field(r, 0, desc)
                if fs is None:
                    self.skip(n)
                    continue
                fields = fs
            if not fields:
                self.skip('no values')
                continue
            e = {'a': r.get('ARG', ''), 'd': desc, 'f': fields}
            if given(r.get('SG_ADR')):
                e['ecu'] = r['SG_ADR']
            dids[did] = e
            order.append(did)
        return dids, order

    def info(self):
        rows = self.page.table('INFO')
        return {r.get('Field', ''): r.get('Value', '') for r in rows}


def texts(cat, meta):
    """every German text in the catalog, the ones on the most screens first: the identifiers' own
    texts, then the fields of small replies, value names, the fields of big replies"""
    seen, out = set(), []
    def add(t):
        if t and t not in seen and re.search(r'[A-Za-z]', t):
            seen.add(t)
            out.append(t)
    for d in meta['order']:
        add(cat[d]['d'])
    for limit in (8, 40, 10 ** 9):
        for d in meta['order']:
            if len(cat[d]['f']) <= limit:
                for f in cat[d]['f']:
                    add(f.get('d'))
        if limit == 8:
            for vals in meta['enums'].values():
                for t in vals.values():
                    add(t)
    return out


def load(path, default):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save(path, obj):
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))


def read_pack(file, rel):
    """one JSON file from a data pack (format: kit/tools/pack_data.py)"""
    with open(file, 'rb') as f:
        b = f.read()
    if b[:8] != b'MGUPACK1':
        raise ValueError(file + ': not a data pack')
    ilen = struct.unpack('<I', b[8:12])[0]
    index = json.loads(zlib.decompress(b[12:12 + ilen], -15))
    base, out = 12 + ilen, {}
    names = [n for n in index['files'] if n.startswith(rel + '#')] if index.get('split', {}).get(rel) else [rel]
    for n in names:
        off, length = index['files'][n]
        out.update(json.loads(zlib.decompress(b[base + off:base + off + length], -15)))
    return out


def cmd_index(out):
    db = os.path.join(ROOT, 'apps', 'dtc_scanner', 'dtc_db')
    idx = load(os.path.join(db, 'sgbd_index.json'), None)
    if idx is None:
        idx = read_pack(db + '.pack', 'sgbd_index.json')
    save(os.path.join(out, 'sgbd_index.json'), idx)
    print('sgbd_index.json: %d unit types -> %s' % (len(idx), out))


def cmd_build(src, out):
    text, source = fetch(src)
    page = Page(text)
    if not page.has('SG_FUNKTIONEN'):
        sys.exit('%s: no SG_FUNKTIONEN table (not an SGBD page?)' % src)
    b = Builder(page)
    cat, order = b.build()
    info = b.info()
    name = os.path.splitext(os.path.basename(src))[0] if os.path.isfile(src) else src
    sgbd = name.upper()
    meta = {'sgbd': sgbd, 'ecu': info.get('ECU', ''), 'revision': info.get('REVISION', ''),
            'comment': info.get('COMMENT', ''), 'source': source, 'made': date.today().isoformat(),
            'order': order, 'enums': b.enums}
    save(os.path.join(out, sgbd + '.json'), cat)
    save(os.path.join(out, sgbd + '.meta.json'), meta)
    en_file = os.path.join(out, sgbd + '.en.json')
    en = load(en_file, {})
    if not os.path.exists(en_file):
        save(en_file, en)
    all_texts = texts(cat, meta)
    nf = sum(len(e['f']) for e in cat.values())
    print('%s: %d identifiers, %d values, %d value tables; %d of %d texts in English -> %s'
          % (sgbd, len(cat), nf, len(b.enums), sum(1 for t in all_texts if en.get(t)), len(all_texts), out))
    for why, n in sorted(b.skipped.items(), key=lambda x: -x[1]):
        print('  left out: %d x %s' % (n, why))


def cmd_todo(sgbd, n, out):
    sgbd = sgbd.upper()
    cat, meta = load(os.path.join(out, sgbd + '.json'), None), load(os.path.join(out, sgbd + '.meta.json'), None)
    if cat is None or meta is None:
        sys.exit('no catalog for %s in %s: run sgbd_catalog.py %s first' % (sgbd, out, sgbd.lower()))
    en = load(os.path.join(out, sgbd + '.en.json'), {})
    todo = [t for t in texts(cat, meta) if not en.get(t)][:n]
    json.dump(todo, sys.stdout, ensure_ascii=False, indent=0)
    print()


def cmd_add(sgbd, file, out):
    en_file = os.path.join(out, sgbd.upper() + '.en.json')
    en, new = load(en_file, {}), load(file, None)
    if not isinstance(new, dict):
        sys.exit('%s: expected {"German text": "English"}' % file)
    n = sum(1 for k, v in new.items() if isinstance(v, str) and v.strip() and en.get(k) != v.strip())
    en.update({k: v.strip() for k, v in new.items() if isinstance(v, str) and v.strip()})
    save(en_file, en)
    print('%s: %d texts added or changed, %d in all' % (os.path.basename(en_file), n, len(en)))


BUILTIN = os.path.join(ROOT, 'apps', 'live_data', 'builtin')
USEFUL = os.path.join(ROOT, 'apps', 'live_data', 'useful.js')


def cmd_builtin(src):
    """the identifiers useful.js names, per unit type it has a list for"""
    with open(USEFUL, encoding='utf-8') as f:
        code = re.sub(r'/\*.*?\*/|//[^\n]*', '', f.read(), flags=re.S)
    dids = set(re.findall(r"'([0-9A-F]{4})(?:/\d+)?'", code))
    os.makedirs(BUILTIN, exist_ok=True)
    for sgbd in ('DME8FF_R',):
        cat, meta = load(os.path.join(src, sgbd + '.json'), None), load(os.path.join(src, sgbd + '.meta.json'), None)
        if cat is None or meta is None:
            sys.exit('no catalog for %s in %s: run sgbd_catalog.py %s first' % (sgbd, src, sgbd.lower()))
        en = load(os.path.join(src, sgbd + '.en.json'), {})
        missing = sorted(d for d in dids if d not in cat)
        if missing:
            sys.exit('%s has no %s (useful.js)' % (sgbd, ', '.join(missing)))
        order = [d for d in meta['order'] if d in dids]
        sub = {d: cat[d] for d in order}
        tables = {f['e'] for e in sub.values() for f in e['f'] if f.get('e')}
        enums = {k: v for k, v in meta['enums'].items() if k in tables}
        used = {t for e in sub.values() for t in [e.get('d')] + [f.get('d') for f in e['f']] if t}
        used |= {t for v in enums.values() for t in v.values()}
        save(os.path.join(BUILTIN, sgbd + '.json'), sub)
        save(os.path.join(BUILTIN, sgbd + '.meta.json'), dict(meta, order=order, enums=enums, builtin=True))
        save(os.path.join(BUILTIN, sgbd + '.en.json'), {t: en[t] for t in sorted(used) if en.get(t)})
        print('%s: %d identifiers, %d values, %d value tables -> %s'
              % (sgbd, len(sub), sum(len(e['f']) for e in sub.values()), len(enums), BUILTIN))
    cmd_index(BUILTIN)


def main():
    a = sys.argv[1:]
    if not a or a[0] in ('-h', '--help'):
        sys.exit(__doc__)
    if a[0] == '--index':
        out = a[1] if len(a) > 1 else OUT
        os.makedirs(out, exist_ok=True)
        return cmd_index(out)
    if a[0] == '--todo' and len(a) >= 2:
        return cmd_todo(a[1], int(a[2]) if len(a) > 2 else 200, a[3] if len(a) > 3 else OUT)
    if a[0] == '--add' and len(a) >= 3:
        return cmd_add(a[1], a[2], a[3] if len(a) > 3 else OUT)
    if a[0] == '--builtin':
        return cmd_builtin(a[1] if len(a) > 1 else OUT)
    if a[0].startswith('-'):
        sys.exit(__doc__)
    out = a[1] if len(a) > 1 else OUT
    os.makedirs(out, exist_ok=True)
    cmd_build(a[0], out)


if __name__ == '__main__':
    main()
