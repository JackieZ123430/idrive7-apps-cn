#!/usr/bin/env python3
"""Check fixed English/Chinese packages without loading the BMW SDK."""
import copy
import json
import tempfile
from pathlib import Path
import build
from localize import unicode_resources, localize_spec, languages, load_locale, CHINESE, WIDGET_SLOT_COUNT

root = Path(__file__).resolve().parent.parent.parent
count = 0
for manifest in sorted((root / 'apps').glob('*/app.json')):
    original = json.loads(manifest.read_text(encoding='utf-8'))
    assert not any(s['key'] == 'language' for s in original['settings'])
    keys = []
    for language in ('en', 'zh-CN', 'zh-TW'):
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
        if language in CHINESE:
            assert ('漢化' if language == 'zh-TW' else '汉化') + ' Translation by：抖音 小白科技杂物社 / BiliBili 小白151' in strings.values()
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
        if spec.get('startWidget'):
            with tempfile.TemporaryDirectory() as temporary:
                out = Path(temporary) / 'widget'
                build.build_start_widget(spec, spec['id'], manifest.parent / 'icon.png', str(out), language)
                widget_ui = json.loads((out / 'uiDescription/uiDescription.json').read_text(encoding='utf-8'))
                cells = widget_ui['containers']['500']['components']['501']['cells']
                assert cells['Widget']['type'] == 'Text' and cells['Widget']['value'] == original['startWidget']['layout']
                for path in (out / 'strings').glob('*.json'):
                    resources = json.loads(path.read_text(encoding='utf-8'))
                    assert resources[cells['SelectionName']['value']] == spec['startWidget']['name']
                    assert sum(k.startswith('SID_WIDGET_DYNAMIC_') for k in resources) == WIDGET_SLOT_COUNT
                    assert not any(k.startswith('SID_CN_DYNAMIC_') for k in resources)
                    assert len(resources) <= 1024
        keys.append(set(strings))
        count += 1
    for localized in keys[1:]:
        assert localized - keys[0] == {k for k in localized if '_CN_CREDITS_' in k} and keys[0] <= localized
assert localize_spec(json.loads((root/'apps/edrive/app.json').read_text()), 'zh-CN')['title'] == 'eDrive助手'
assert localize_spec(json.loads((root/'apps/edrive/app.json').read_text()), 'zh-TW')['title'] == 'eDrive助手'
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
