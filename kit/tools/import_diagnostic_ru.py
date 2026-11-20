#!/usr/bin/env python3
"""Build diagnostic-full.ru.json from user-supplied EN/RU DiagDocDb files.

Requires a SQLite3 Multiple Ciphers executable; no Python packages are needed.
The source databases are opened read-only and are never copied. Matching uses
label IDs first, then unique (ECU variant, diagnostic address, DTC) contexts for
records whose IDs differ between versions. The same contexts also map translations
onto changed English wording in the bundled dtc_db.pack. English texts with
conflicting Russian translations are left out for manual review.

python kit/tools/import_diagnostic_ru.py --sqlite3mc /path/to/sqlite3mc \
    --en /path/to/EN/SQLiteDBs/DiagDocDb.sqlite \
    --ru /path/to/RU/SQLiteDBs/DiagDocDb.sqlite --report work/diag-ru-report.json
"""
import argparse
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'kit/localization/diagnostic-full.ru.json'
RU_COLUMNS = ('TITLE_RURU', 'TITLE_RU', 'TITLE_RUS')


def sql_string(value):
    return "'" + str(value).replace("'", "''") + "'"


def query(executable, database, password, sql):
    command = [str(executable), '-json', '-readonly',
               '-cmd', "PRAGMA cipher='rc4';", '-cmd', 'PRAGMA key=' + sql_string(password) + ';',
               str(database), sql]
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode:
        raise RuntimeError('sqlite3mc failed for %s:\n%s' % (database, result.stderr.decode('utf-8', 'replace')))
    try:
        text = result.stdout.decode('utf-8-sig')
        decoder = json.JSONDecoder()
        values, offset = [], 0
        while offset < len(text):
            while offset < len(text) and text[offset].isspace():
                offset += 1
            if offset >= len(text):
                break
            value, offset = decoder.raw_decode(text, offset)
            values.append(value)
        return values[-1] if values else []
    except ValueError as error:
        raise RuntimeError('sqlite3mc returned no JSON for %s:\n%s' % (
            database, result.stderr.decode('utf-8', 'replace'))) from error


def text_column(executable, database, password, candidates):
    columns = {row['name'] for row in query(executable, database, password, 'PRAGMA table_info(XEP_FAULTLABELS);')}
    for column in candidates:
        if column in columns:
            return column
    raise RuntimeError('%s has none of %s in XEP_FAULTLABELS' % (database, ', '.join(candidates)))


def fault_rows(executable, database, password, column):
    quoted = '"' + column + '"'
    sql = '''
SELECT l.ID AS label_id, CAST(fc.CODE AS INTEGER) AS code,
       v.NAME AS variant, CAST(g.DIAGNOSTIC_ADDRESS AS INTEGER) AS address,
       l.%s AS text
FROM XEP_FAULTCODES fc
JOIN XEP_ECUVARIANTS v ON v.ID = fc.ECUVARIANTID
JOIN XEP_ECUGROUPS g ON g.ID = v.ECUGROUPID
JOIN XEP_REFFAULTLABELS r ON r.ID = fc.ID
JOIN XEP_FAULTLABELS l ON l.ID = r.LABELID
WHERE l.%s IS NOT NULL AND TRIM(l.%s) <> '';
''' % (quoted, quoted, quoted)
    rows = []
    for row in query(executable, database, password, sql):
        if row.get('label_id') is None or row.get('variant') is None or row.get('address') is None or row.get('code') is None:
            continue
        rows.append({
            'id': str(row['label_id']),
            'context': (str(row['variant']).lower(), int(row['address']), int(row['code'])),
            'text': str(row['text']).strip(),
        })
    return rows


def one_per_key(rows, key):
    grouped = {}
    for row in rows:
        grouped.setdefault(key(row), set()).add(row['text'])
    return {k: next(iter(v)) for k, v in grouped.items() if len(v) == 1}


def pair_rows(english, russian):
    en_ids = one_per_key(english, lambda row: row['id'])
    ru_ids = one_per_key(russian, lambda row: row['id'])
    pairs = []
    matched_en, matched_ru = set(), set()
    for label_id in en_ids.keys() & ru_ids.keys():
        en_contexts = {row['context'] for row in english if row['id'] == label_id}
        ru_contexts = {row['context'] for row in russian if row['id'] == label_id}
        shared = en_contexts & ru_contexts
        if not shared:
            continue
        pairs.append((en_ids[label_id], ru_ids[label_id], 'label_id', sorted(shared)[0]))
        matched_en.add(label_id)
        matched_ru.add(label_id)
    en_left = [row for row in english if row['id'] not in matched_en]
    ru_left = [row for row in russian if row['id'] not in matched_ru]
    en_contexts = one_per_key(en_left, lambda row: row['context'])
    ru_contexts = one_per_key(ru_left, lambda row: row['context'])
    for context in en_contexts.keys() & ru_contexts.keys():
        pairs.append((en_contexts[context], ru_contexts[context], 'variant_address_code', context))
    return [pair for pair in pairs if context_compatible(pair[0], pair[1])]


def load_pack_tables():
    import struct
    import zlib
    data = (ROOT/'apps/dtc_scanner/dtc_db.pack').read_bytes()
    length = struct.unpack('<I', data[8:12])[0]
    index = json.loads(zlib.decompress(data[12:12+length], -15))
    base = 12 + length
    tables = {}
    for name, (offset, size) in index['files'].items():
        logical = name.split('#')[0]
        if logical == 'tables/codes.json' or logical.startswith(('tables/variant/', 'tables/addr/')):
            values = json.loads(zlib.decompress(data[base+offset:base+offset+size], -15))
            tables.setdefault(logical, {}).update(values)
    return tables


def hex_values(text):
    import re
    from collections import Counter
    translated = str(text).translate(str.maketrans({'х':'x', 'А':'A', 'а':'a', 'В':'B', 'в':'b',
                                                    'С':'C', 'с':'c', 'Е':'E', 'е':'e'}))
    return Counter(int(token[2:], 16) for token in re.findall(r'0[xX][0-9A-Fa-f]+', translated))


def context_compatible(source, target):
    import re
    from collections import Counter
    number = re.compile(r'(?<![A-Za-z0-9_])\d+(?:\.\d+)*(?![A-Za-z0-9_])')
    translated_numbers = re.sub(r'(?<=\d),(?=\d)', '.', target)
    numbers_lost = Counter(number.findall(source)) - Counter(number.findall(translated_numbers))
    return not numbers_lost and not (hex_values(source) - hex_values(target))


def pack_pairs(pairs, tables=None):
    tables = load_pack_tables() if tables is None else tables
    variants, addresses, codes = {}, {}, {}
    for source, target, method, context in pairs:
        variant, address, code = context
        code = '%06X' % code
        variants.setdefault((variant, code), set()).add(target)
        addresses.setdefault((address, code), set()).add(target)
        codes.setdefault(code, set()).add(target)
    out = []
    for name, entries in tables.items():
        if name.startswith('tables/variant/'):
            variant = name.rsplit('/', 1)[1][:-5].lower()
            candidates, method = variants, 'pack_variant'
            key = lambda code: (variant, code)
        elif name.startswith('tables/addr/'):
            address = int(name.rsplit('/', 1)[1][:-5], 16)
            candidates, method = addresses, 'pack_address'
            key = lambda code: (address, code)
        else:
            candidates, method = codes, 'pack_code'
            key = lambda code: code
        for code, source in entries.items():
            if not isinstance(source, str):
                continue
            for target in candidates.get(key(code), ()):
                if context_compatible(source, target):
                    out.append((source, target, method, None))
    return out


def translations_from_pairs(pairs):
    candidates = {}
    for source, target, method, context in pairs:
        candidates.setdefault(source, set()).add(target)
    translations = {source: next(iter(values)) for source, values in candidates.items() if len(values) == 1}
    conflicts = {source: sorted(values) for source, values in candidates.items() if len(values) > 1}
    return translations, conflicts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sqlite3mc', required=True, type=Path)
    parser.add_argument('--en', required=True, type=Path)
    parser.add_argument('--ru', required=True, type=Path)
    parser.add_argument('--password', default='6505EFBDC3E5F324')
    parser.add_argument('--out', type=Path, default=OUT)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    for path in (args.sqlite3mc, args.en, args.ru):
        if not path.is_file():
            parser.error('%s is not a file' % path)
    en_column = text_column(args.sqlite3mc, args.en, args.password, ('TITLE_ENGB',))
    ru_column = text_column(args.sqlite3mc, args.ru, args.password, RU_COLUMNS)
    english = fault_rows(args.sqlite3mc, args.en, args.password, en_column)
    russian = fault_rows(args.sqlite3mc, args.ru, args.password, ru_column)
    pairs = pair_rows(english, russian)
    contextual = pack_pairs(pairs)
    translations, conflicts = translations_from_pairs(pairs + contextual)
    from build_diagnostic_zh import database_strings
    corpus = database_strings()
    bundled = {source: value for source, value in translations.items() if source in corpus}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(bundled, ensure_ascii=False, separators=(',', ':'), sort_keys=True) + '\n',
                        encoding='utf-8')
    stats = {
        'english_rows': len(english),
        'russian_rows': len(russian),
        'matched_pairs': len(pairs),
        'id_matches': sum(pair[2] == 'label_id' for pair in pairs),
        'context_matches': sum(pair[2] == 'variant_address_code' for pair in pairs),
        'pack_context_pairs': len(contextual),
        'unique_english_texts': len(translations),
        'bundled_database_texts': len(bundled),
        'conflicting_english_texts': len(conflicts),
        'output': str(args.out),
    }
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps({'stats': stats, 'conflicts': conflicts}, ensure_ascii=False, indent=2) + '\n',
                               encoding='utf-8')
    print(json.dumps(stats, ensure_ascii=False))
    print('Run build_diagnostic_ru.py --report <folder> to audit coverage of the bundled database.')


if __name__ == '__main__':
    main()
