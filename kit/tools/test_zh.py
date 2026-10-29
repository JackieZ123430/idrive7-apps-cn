#!/usr/bin/env python3
"""Check fixed English/Chinese packages without loading the BMW SDK."""
import copy
import json
from pathlib import Path
import build
from localize import unicode_resources, localize_spec, languages, load_locale

root = Path(__file__).resolve().parent.parent.parent
# The translation credit ships in Chinese builds only (build.py adds it from kit/localization/credit.zh-CN.json):
# nothing every package carries (an app's folder, the kit runtime) names the translator.
for shipped in sorted(list((root / 'apps').rglob('*')) + list((root / 'kit/runtime').rglob('*'))):
    if shipped.is_file() and shipped.suffix in ('.js', '.json', '.py', '.md', '.txt', '.xml'):
        text = shipped.read_text(encoding='utf-8', errors='ignore')
        assert not any(n in text for n in ('JackieZ123430', '小白', '抖音')), shipped
count = 0
for manifest in sorted((root / 'apps').glob('*/app.json')):
    original = json.loads(manifest.read_text(encoding='utf-8'))
    assert not any(s['key'] == 'language' for s in original['settings'])
    keys = []
    for language in ('en', 'zh-CN'):
        spec = localize_spec(original, language)
        for key in ('id', 'signals', 'config', 'assets'):
            assert original.get(key) == spec.get(key), (manifest, key)
        for a, b in zip(original['settings'], spec['settings']):
            assert a['key'] == b['key'] and a['default'] == b['default']
            assert [o[0] for o in a.get('options', [])] == [o[0] for o in b.get('options', [])]
        _, ui, strings, _ = build.build_ui(copy.deepcopy(spec), language)
        unicode_resources(ui, strings, language)
        assert len([k for k in strings if k.startswith('SID_CN_DYNAMIC_')]) == 256
        assert len(strings) <= 1024
        assert spec['title'] in strings.values()
        # translation credit: Chinese builds only; the project credit: every build
        cn = [k for k in strings if k.endswith('_CN_CREDITS_TITLE') or k.endswith('_CN_CREDITS_LINK')]
        if language == 'zh-CN':
            assert 'Translation by: 抖音 小白科技杂物社 / BiliBili 小白151' in strings.values()
            assert len(cn) == 2
        else:
            assert not cn and not any('JackieZ123430' in v or '小白' in v for v in strings.values())
        assert any('github.com/cauliflowermossgrape/idrive7-apps' in v for v in strings.values())
        def visit(obj):
            if isinstance(obj, dict):
                if obj.get('type') == 'StringId': assert obj['value'] in strings, (manifest, obj)
                if obj.get('type') == 'Text' and isinstance(obj.get('value'), str): assert obj['value'] == ''
                for value in obj.values(): visit(value)
            elif isinstance(obj, list):
                for value in obj: visit(value)
        visit(ui)
        keys.append(set(strings))
        count += 1
    assert keys[1] - keys[0] == {k for k in keys[1] if '_CN_CREDITS_' in k} and keys[0] <= keys[1]
try:
    unicode_resources({}, {'SID_TEST_%d' % n: '' for n in range(769)})
except ValueError:
    pass
else:
    raise AssertionError('build must reject bundles exceeding 1024 strings')
extra = root / 'kit/runtime/locales/xx-test.json'
assert not extra.exists()
try:
    extra.write_text('{"Settings":"Test settings"}', encoding='utf-8')
    assert 'xx-test' in languages() and load_locale('xx-test')['Settings'] == 'Test settings'
finally:
    extra.unlink()
print('PASS: %d fixed-language layouts, no language selector, invariant IDs/settings, HMI budget and new-locale discovery' % count)
