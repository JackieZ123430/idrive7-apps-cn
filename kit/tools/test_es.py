#!/usr/bin/env python3
"""Spanish layout/telemetry invariants, atlas coverage and display-path checks; no BMW SDK."""
import copy
import json
import os
import subprocess
import sys
from pathlib import Path

import build
from localize import localize_spec, unicode_resources, normalize_language, credit, credit_name

ROOT = Path(__file__).resolve().parent.parent.parent
FONTS = ROOT / 'kit/localization/fonts/es'
CREDIT = credit('es')
assert CREDIT['corner'] == 'Traducción: Rubén Ríos · GitHub rubenrios'
assert credit_name('es') == 'ES_CREDITS' and credit('en') is None
for tag in ('es', 'es-es', 'es-ES', 'es_ES', 'ES-ES'):
    assert normalize_language(tag) == 'es'
for tag in ('en', 'ru', 'zh-CN', 'ko'):
    assert normalize_language(tag) == tag
# Exercise argparse and the generated runtime, so a rejected regional tag cannot
# silently leave an older English stage being previewed.
for tag in ('es-ES', 'es_ES'):
    result = subprocess.run([sys.executable, str(ROOT / 'kit/tools/build.py'),
                             '--language', tag, '--preview-only', 'redline'],
                            cwd=ROOT, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    staged = ROOT / 'dist/redline/source/javascript/kit'
    locale = json.loads((staged / 'locale.json').read_text(encoding='utf-8'))
    spec = json.loads((staged / 'app-spec.json').read_text(encoding='utf-8'))
    assert locale['language'] == 'es' and locale['strings']['SPEED'] == 'VELOCIDAD'
    assert spec['version'].endswith('-es.1')
    # the translation credit: in the corner and the entry file of Spanish packages only
    assert locale['credit'] == CREDIT['corner']
    assert (staged.parent / 'app.js').read_text(encoding='utf-8').startswith('// ' + CREDIT['comment'][0] + '\n')
    for family in ('label', 'bold', 'light', 'num'):
        assert (staged / 'fonts' / (family + '.json')).read_bytes() == (FONTS / (family + '.json')).read_bytes()
print('PASS: es-ES / es_ES CLI aliases produce Spanish stages, fonts and canonical package versions')

words = json.loads((ROOT / 'kit/runtime/locales/es.json').read_text(encoding='utf-8'))
for english, spanish in words.items():
    assert spanish.strip() and '\t' not in spanish, english
    assert english.count('|') == spanish.count('|'), english
text_chars = set(''.join(words.values()) + 'ÁÉÍÓÚÜÑáéíóúüñ¿¡' + json.dumps(CREDIT, ensure_ascii=False)) - set('\n\r\t')
for family in ('label', 'bold', 'light', 'num'):
    spanish = json.loads((FONTS / (family + '.json')).read_text(encoding='utf-8'))
    english = json.loads((ROOT / 'kit/runtime/fonts' / (family + '.json')).read_text(encoding='utf-8'))
    # its own GPU texture id: an English app's atlas of the same family and size is not reused
    assert spanish['cacheKey'] and spanish['cacheKey'] != english.get('cacheKey', '')
    assert [s['size'] for s in spanish['sizes']] == [s['size'] for s in english['sizes']]
    for es_size, en_size in zip(spanish['sizes'], english['sizes']):
        # every English glyph unchanged: text without accents measures and looks the same
        assert all(es_size['glyphs'][code] == glyph for code, glyph in en_size['glyphs'].items()), (family, es_size['size'])
        if len(en_size['glyphs']) > 60:   # the text sizes (the others are digits and units only)
            missing = [ch for ch in text_chars if str(ord(ch)) not in es_size['glyphs']]
            assert not missing, (family, es_size['size'], ''.join(missing))

count = 0
for path in sorted((ROOT / 'apps').glob('*/app.json')):
    original = json.loads(path.read_text(encoding='utf-8'))
    spec = localize_spec(original, 'es')
    for key in ('id', 'signals', 'config', 'assets', 'startWidget', 'loggingId'):
        assert spec.get(key) == original.get(key), (path, key)
    assert spec['version'] == original['version'] + '-es.1'
    for a, b in zip(original['settings'], spec['settings']):
        assert a['key'] == b['key'] and a['default'] == b['default']
        assert [o[0] for o in a.get('options', [])] == [o[0] for o in b.get('options', [])]
    _, ui, strings, _ = build.build_ui(copy.deepcopy(spec), 'es')
    unicode_resources(ui, strings, 'es')
    title, link = build.sid(spec['id'], 'ES_CREDITS_TITLE'), build.sid(spec['id'], 'ES_CREDITS_LINK')
    assert strings[title] == CREDIT['settingsTitle'] and strings[link] == CREDIT['settingsLink'], path
    assert len(strings) <= 1024
    assert len([s for s in strings if s.startswith('SID_CN_DYNAMIC_')]) == 256
    assert 'es_ES' in build.LANGS
    count += 1

subprocess.run(['node', str(ROOT / 'kit/tools/test_es.js')], cwd=ROOT, check=True,
               env=dict(os.environ, MGU_TEST_PYTHON=sys.executable))
print('PASS: %d Spanish app layouts; %d translations; catalog glyph coverage; unchanged telemetry and settings' % (count, len(words)))
