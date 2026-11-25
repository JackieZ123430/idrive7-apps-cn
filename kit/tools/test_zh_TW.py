#!/usr/bin/env python3
"""Traditional Chinese catalog, glyphs and fixed-language layouts; no BMW SDK."""
from collections import Counter
import copy
import json
from pathlib import Path
import re
import sys

from opencc import OpenCC

import build
from localize import credit, credit_name, localize_spec, unicode_resources

ROOT = Path(__file__).resolve().parents[2]
LOCALES = ROOT / 'kit/runtime/locales'
LANGUAGE = 'zh-TW'
S2TW = OpenCC('s2tw')
PLACEHOLDER = re.compile(r'\{[^{}]+\}|%(?:\([^)]+\))?(?:\d+\$)?[-+#0 ]*\d*(?:\.\d+)?[diouxXeEfFgGcrsa]')


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def check_traditional(words):
    for key, value in words.items():
        expected = S2TW.convert(value).replace('錶', '表').replace('臺', '台')
        assert expected == value, f'FAIL: Simplified or nonstandard text in {key!r}: {value!r} -> {expected!r}'


def main():
    if sys.argv[1:] == ['--negative-control']:
        check_traditional({'Software settings': '软件设置'})
        return
    source = read_json(LOCALES / 'zh-CN.json')
    catalog_path = LOCALES / f'{LANGUAGE}.json'
    assert catalog_path.is_file(), f'Missing fixed-language catalog: {catalog_path.name}'
    words = read_json(catalog_path)
    assert words.keys() == source.keys()
    for key, value in words.items():
        assert value.strip(), key
        assert Counter(PLACEHOLDER.findall(value)) == Counter(PLACEHOLDER.findall(source[key])), key
    check_traditional(words)
    print(f'PASS: {len(words)} source keys, nonempty translations, matching placeholders and Traditional Chinese text')

    attribution = credit(LANGUAGE)
    assert '加速度SpeedUP' in attribution['corner'] and 'JackieZ123430' in attribution['corner']
    atlas_data = read_json(ROOT / 'kit/localization/fonts/cjk-zh-TW.json')
    atlas = atlas_data['sizes'][0]
    assert atlas_data['family'] == 'cjk' and atlas_data['source'] == 'Noto Sans TC (OFL-1.1)'
    sc_atlas = read_json(ROOT / 'kit/runtime/fonts/cjk.json')
    assert atlas_data['cacheKey'] and atlas_data['cacheKey'] != sc_atlas['cacheKey']
    chars = set(''.join(words.values()) + json.dumps(attribution, ensure_ascii=False))
    missing = sorted(ch for ch in chars if ord(ch) > 127 and str(ord(ch)) not in atlas['glyphs'])
    assert not missing, f'Missing glyphs: {missing}'
    assert atlas['atlasW'] == 1024 and 512 < atlas['atlasH'] <= 2048
    print(f"PASS: {len(atlas['glyphs'])} glyphs, {atlas['atlasW']} x {atlas['atlasH']}, no missing non-ASCII characters")

    count = 0
    for path in sorted((ROOT / 'apps').glob('*/app.json')):
        original = read_json(path)
        spec = localize_spec(original, LANGUAGE)
        assert spec['version'] == original['version'] + '-zh.tw.1', path
        for key in ('id', 'signals', 'config', 'assets', 'startWidget', 'loggingId'):
            assert spec.get(key) == original.get(key), (path, key)
        for before, after in zip(original['settings'], spec['settings']):
            assert (before['key'], before['default']) == (after['key'], after['default']), path
            assert [o[0] for o in before.get('options', [])] == [o[0] for o in after.get('options', [])], path
        _, ui, strings, _ = build.build_ui(copy.deepcopy(spec), LANGUAGE)
        _, ui8, strings8, _ = build.build_ui(copy.deepcopy(spec), LANGUAGE, 'ID8')
        unicode_resources(ui, strings, LANGUAGE)
        unicode_resources(ui8, strings8, LANGUAGE, 'SID_CN_STATIC8_')
        strings.update(strings8)
        row = credit_name(LANGUAGE)
        assert strings[build.sid(spec['id'], row + '_TITLE')] == attribution['settingsTitle'], path
        assert strings[build.sid(spec['id'], row + '_LINK')] == attribution['settingsLink'], path
        assert len(strings) <= 1024, path
        count += 1
    print(f'PASS: {count} iDrive 7/8 layouts, attribution, stable app settings and -zh.tw.1 versions')


if __name__ == '__main__':
    main()
