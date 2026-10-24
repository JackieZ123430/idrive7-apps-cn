#!/usr/bin/env python3
"""dtc_csv.py - code-only fault texts from a CSV export (Code + Description columns).

    python kit/tools/dtc_csv.py BMW_Fault_Codes.csv [out_dir]

Writes dtc_scanner_texts.json (codes with exactly one text) and dtc_scanner_ambiguous.json (codes with several
different texts: how many - the scanner shows "n possible texts" for those instead of guessing)
into out_dir, default dtc_tables/ (not in git: the texts are BMW's). Then:

    python kit/tools/dtc_tables.py dtc_tables
    python kit/tools/build.py dtc_scanner

Headings Code + Description in any case (also FaultCode/DTC/Fehlercode, Text/Fehlertext); a BOM and
; or tab separators are fine. Only 3-byte BMW codes (6 hex digits) are taken.
"""
import csv, json, os, re, sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', 'dtc_tables')


def load_csv(source):
    with open(source, 'r', encoding='utf-8-sig', errors='replace', newline='') as f:
        sample = f.read(65536)
        f.seek(0)
        try:
            delimiter = csv.Sniffer().sniff(sample, delimiters=',;\t').delimiter
        except csv.Error:
            first = sample.splitlines()[0]
            delimiter = ';' if first.count(';') > first.count(',') else ','
        reader = csv.DictReader(f, delimiter=delimiter)
        fields = {n.strip().lower().replace(' ', '').replace('_', ''): n for n in (reader.fieldnames or []) if n}
        codekey = next((fields[k] for k in ('code', 'faultcode', 'dtc', 'fehlercode') if k in fields), None)
        desckey = next((fields[k] for k in ('description', 'faultdescription', 'text', 'faulttext', 'fehlertext')
                        if k in fields), None)
        if not codekey or not desckey:
            sys.exit('Need Code and Description columns; found: %r' % reader.fieldnames)
        values = defaultdict(set)
        for row in reader:
            code = str(row.get(codekey) or '').strip().upper()
            code = code[2:] if code.startswith('0X') else code
            desc = re.sub(r'\s+', ' ', str(row.get(desckey) or '')).strip()
            if not re.fullmatch(r'[0-9A-F]{6}', code) or not desc or desc.lower() in ('no description', 'unknown'):
                continue
            values[code].add(desc)
    return values


def main():
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    values = load_csv(sys.argv[1])
    out = sys.argv[2] if len(sys.argv) == 3 else OUT
    os.makedirs(out, exist_ok=True)
    unique = {c: next(iter(v)) for c, v in values.items() if len(v) == 1}
    ambiguous = {c: len(v) for c, v in values.items() if len(v) > 1}
    for name, d in (('dtc_scanner_texts.json', unique), ('dtc_scanner_ambiguous.json', ambiguous)):
        with open(os.path.join(out, name), 'w', encoding='utf-8', newline='\n') as f:
            json.dump(d, f, ensure_ascii=False, separators=(',', ':'), sort_keys=True)
    print('%d codes with one text, %d with several (not guessed) -> %s' % (len(unique), len(ambiguous), os.path.normpath(out)))


if __name__ == '__main__':
    main()
