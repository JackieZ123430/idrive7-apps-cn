#!/usr/bin/env python3
"""Bilibili 小白151 / GitHub JackieZ123430: sync the editable TSV to runtime JSON."""
import json
import argparse
from pathlib import Path

directory = Path(__file__).resolve().parent.parent / 'runtime/locales'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--language', choices=('zh-CN', 'zh-TW'), default='zh-CN')
language = parser.parse_args().language
words = {}
for n, line in enumerate((directory / (language + '.tsv')).read_text(encoding='utf-8').splitlines(), 1):
    if not line or line.startswith('#'):
        continue
    english, chinese = (part.strip() for part in line.split('\t', 1))
    if not english or not chinese:
        raise SystemExit('Empty translation at line %d' % n)
    if english in words and words[english] != chinese:
        raise SystemExit('Conflicting translation at line %d: %s' % (n, english))
    words[english] = chinese
(directory / (language + '.json')).write_text(json.dumps(words, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print('Synced %d %s translations' % (len(words), language))
