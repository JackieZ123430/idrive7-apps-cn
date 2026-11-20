#!/usr/bin/env python3
"""Sync editable runtime/locales/*.tsv catalogs to their runtime JSON files."""
import json
import sys
from pathlib import Path

DIRECTORY = Path(__file__).resolve().parent.parent / 'runtime/locales'
# Forms per plural row ("one|other<TAB>forms"); must match PLURAL_RULES in runtime/i18n.js.
PLURAL_FORMS = {'ru': 3, 'zh-CN': 1, 'zh-TW': 1, 'ko': 1, 'es': 2}

sources = sorted(DIRECTORY.glob('*.tsv'))
if sys.argv[1:]:
    requested = set(sys.argv[1:])
    if requested - {p.stem for p in sources}:
        raise SystemExit('Unknown locale: ' + ', '.join(sorted(requested - {p.stem for p in sources})))
    sources = [p for p in sources if p.stem in requested]
for source in sources:
    words = {}
    for n, line in enumerate(source.read_text(encoding='utf-8').splitlines(), 1):
        if not line or line.startswith('#'):
            continue
        try:
            english, translated = (part.strip() for part in line.split('\t', 1))
        except ValueError:
            raise SystemExit('%s:%d: expected English<TAB>translation' % (source.name, n))
        if not english or not translated:
            raise SystemExit('%s:%d: empty source or translation' % (source.name, n))
        if english in words and words[english] != translated:
            raise SystemExit('%s:%d: conflicting translation for %s' % (source.name, n, english))
        if '|' in english:
            want = PLURAL_FORMS.get(source.stem)
            if english.count('|') != 1 or want is None or translated.count('|') + 1 != want:
                raise SystemExit('%s:%d: plural row needs one|other and %s form(s)' % (source.name, n, want))
        words[english] = translated
    target = source.with_suffix('.json')
    target.write_text(json.dumps(words, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('%s: %d translations' % (source.stem, len(words)))
