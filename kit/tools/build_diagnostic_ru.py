#!/usr/bin/env python3
"""Package/audit Russian diagnostic descriptions independently of UI text.

Normal builds use the committed catalog and need no source database. --report
checks coverage against the bundled English database. Unknown descriptions stay
English. Use import_diagnostic_ru.py to create diagnostic-full.ru.json from EN/RU
DiagDocDb databases.
"""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import re

from build_diagnostic_zh import database_strings, normalize

ROOT = Path(__file__).resolve().parents[2]
LOCALIZATION = ROOT / 'kit/localization'


def catalog():
    full = LOCALIZATION / 'diagnostic-full.ru.json'
    imported = json.loads(full.read_text(encoding='utf-8')) if full.is_file() else {}
    texts = database_strings()
    values = {source: value for source, value in imported.items() if source in texts}
    ui = json.loads((ROOT/'kit/runtime/locales/ru.json').read_text(encoding='utf-8'))
    for source, value in ui.items():
        if source in values or len(source) > 20:
            values[source] = value
    overrides = LOCALIZATION / 'diagnostic-overrides.ru.json'
    if overrides.is_file():
        values.update(json.loads(overrides.read_text(encoding='utf-8')))
    for source in values:
        value = re.sub(r'[\x00-\x1f\x7f]', ' ', values[source])
        values[source] = re.sub(r' +', ' ', value).strip()
    for source, value in list(values.items()):
        values.setdefault(normalize(source), value)
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--require-complete', action='store_true')
    args = parser.parse_args()
    args.report.mkdir(parents=True, exist_ok=True)
    values = catalog()
    texts = database_strings()
    untranslated = sorted(texts - values.keys())
    number = re.compile(r'(?<![A-Za-z0-9_])\d+(?:\.\d+)*(?![A-Za-z0-9_])')
    from collections import Counter
    for source in texts - set(untranslated):
        if re.search(r'<unk>|\u2047|\ufffd', values[source]):
            raise ValueError('Invalid translation placeholder: ' + source)
        translated_numbers = re.sub(r'(?<=\d),(?=\d)', '.', values[source])
        if Counter(number.findall(source)) - Counter(number.findall(translated_numbers)):
            raise ValueError('Numeric literal lost: ' + source)
        if normalize(source) not in values:
            raise ValueError('Normalized display key missing: ' + source)
        from import_diagnostic_ru import hex_values
        if hex_values(source) - hex_values(values[source]):
            raise ValueError('Hex ID lost: ' + source)
    stats = {
        'database_sha256': hashlib.sha256((ROOT/'apps/dtc_scanner/dtc_db.pack').read_bytes()).hexdigest(),
        'database_unique': len(texts),
        'translated': len(texts) - len(untranslated),
        'russian_descriptions': sum(bool(re.search(r'[А-Яа-яЁё]', values[s])) for s in texts if s in values),
        'missing': len(untranslated),
        'catalog_keys': len(values),
        'review_status': 'BMW text matched by label and ECU/code context; not individually human reviewed',
    }
    with (args.report/'translations.csv').open('w', encoding='utf-8-sig', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(['source', 'translation'])
        writer.writerows((s, values[s]) for s in sorted(texts) if s in values)
    (args.report/'missing.txt').write_text('\n'.join(untranslated) + ('\n' if untranslated else ''), encoding='utf-8')
    (args.report/'coverage.json').write_text(json.dumps(stats, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps(stats, ensure_ascii=False))
    if args.require_complete and untranslated:
        raise ValueError('%d missing translation keys' % len(untranslated))


if __name__ == '__main__':
    main()
