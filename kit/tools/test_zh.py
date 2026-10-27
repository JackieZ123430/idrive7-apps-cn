#!/usr/bin/env python3
"""Check all RHMI layouts without the BMW SDK or a connection to a car."""
import copy
import json
from pathlib import Path
import build
from localize import spec_zh, unicode_resources

root = Path(__file__).resolve().parent.parent.parent
count = 0
for manifest in sorted((root / 'apps').glob('*/app.json')):
    original = json.loads(manifest.read_text(encoding='utf-8'))
    spec = spec_zh(original)
    for key in ('id', 'signals', 'config', 'assets'):
        assert original.get(key) == spec.get(key), (manifest, key)
    for a, b in zip(original.get('settings', []), spec.get('settings', [])):
        assert a['key'] == b['key'] and a['default'] == b['default']
        assert [o[0] for o in a.get('options', [])] == [o[0] for o in b.get('options', [])]
    _, ui, strings, _ = build.build_ui(copy.deepcopy(spec))
    unicode_resources(ui, strings)
    assert len([k for k in strings if k.startswith('SID_CN_DYNAMIC_')]) == 1024
    assert '汉化：小白科技杂物社 / Bilibili 小白151' in strings.values()
    assert any('GitHub JackieZ123430' in v for v in strings.values())

    def visit(obj):
        if isinstance(obj, dict):
            if obj.get('type') == 'StringId':
                assert obj['value'] in strings, (manifest, obj)
            if obj.get('type') == 'Text' and isinstance(obj.get('value'), str):
                assert all(ord(c) < 128 for c in obj['value']), (manifest, obj)
            for value in obj.values():
                visit(value)
        elif isinstance(obj, list):
            for value in obj:
                visit(value)
    visit(ui)
    count += 1
print('PASS: %d layouts, Unicode resource handles, reserved dynamic IDs, attribution and metadata invariants' % count)
