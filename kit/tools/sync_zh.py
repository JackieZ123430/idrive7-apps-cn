#!/usr/bin/env python3
"""Sync the editable TSV to runtime JSON. Translation by: BiliBili 小白151 / GitHub JackieZ123430."""
import json
from pathlib import Path

directory = Path(__file__).resolve().parent.parent / 'runtime/locales'
words = {}
for n, line in enumerate((directory / 'zh-CN.tsv').read_text(encoding='utf-8').splitlines(), 1):
    if not line or line.startswith('#'):
        continue
    english, chinese = (part.strip() for part in line.split('\t', 1))
    if not english or not chinese:
        raise SystemExit('Empty translation at line %d' % n)
    if english in words and words[english] != chinese:
        raise SystemExit('Conflicting translation at line %d: %s' % (n, english))
    words[english] = chinese
(directory / 'zh-CN.json').write_text(json.dumps(words, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print('Synced %d Chinese translations' % len(words))
