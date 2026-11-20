#!/usr/bin/env python3
"""Check fixed English/Chinese/Russian packages without loading the BMW SDK."""
import copy
import json
import subprocess
from pathlib import Path
import build
from localize import unicode_resources, localize_spec, languages, load_locale, zh_credit, credit as translation_credit, credit_name

root = Path(__file__).resolve().parent.parent.parent
package_languages = ('en', 'zh-CN', 'ru')
dynamic_ids = {'SID_CN_DYNAMIC_%04d' % n for n in range(256)}
expected_hmi_locales = [
    'ar_AE', 'cs_CZ', 'da_DK', 'de_DE', 'el_GR', 'en_GB', 'en_US', 'es_ES', 'fi_FI', 'fr_FR', 'he_IL',
    'hu_HU', 'id_ID', 'it_IT', 'ja_JP', 'ko_KR', 'nb_NO', 'nl_NL', 'no_NO', 'pl_PL', 'pt_BR', 'pt_PT',
    'ro_RO', 'ru_RU', 'sk_SK', 'sl_SI', 'sv_SE', 'th_TH', 'tr_TR', 'uk_UA', 'vi_VN', 'zh_CN', 'zh_TW',
]
assert build.LANGS == expected_hmi_locales and len(build.LANGS) == 33
credit = zh_credit()
assert credit['corner'] == 'Translation by: 抖音 小白科技杂物社 · BiliBili 小白151 · GitHub JackieZ123430'
assert credit['settingsTitle'] == 'Translation by: 抖音 小白科技杂物社 / BiliBili 小白151'
assert credit['settingsLink'] == 'GitHub JackieZ123430 · github.com/JackieZ123430/idrive7-apps-cn'
assert credit['comment'] == [
    'Translation by: 抖音 小白科技杂物社 / BiliBili 小白151 / GitHub JackieZ123430',
    'https://github.com/JackieZ123430/idrive7-apps-cn',
]
revisions = json.loads((root / 'kit/tools/locale-revisions.json').read_text(encoding='utf-8'))
# The translation credit ships in Chinese builds only (build.py adds it from kit/localization/credit.zh-CN.json):
# nothing every package carries (an app's folder, the kit runtime) names the translator.
for shipped in sorted(list((root / 'apps').rglob('*')) + list((root / 'kit/runtime').rglob('*'))):
    if shipped.is_file() and shipped.suffix in ('.js', '.json', '.py', '.md', '.txt', '.xml'):
        text = shipped.read_text(encoding='utf-8', errors='ignore')
        assert not any(n in text for n in ('JackieZ123430', '小白', '抖音')), shipped
count = 0
table_count = 0
for manifest in sorted((root / 'apps').glob('*/app.json')):
    original = json.loads(manifest.read_text(encoding='utf-8'))
    assert not any(s['key'] == 'language' for s in original['settings'])
    keys = {}
    for language in package_languages:
        spec = localize_spec(original, language)
        assert not any(s['key'] == 'language' for s in spec['settings']), (manifest, language)
        if language == 'en':
            assert spec == original, 'English must remain the unmodified default package'
        for key in ('id', 'signals', 'config', 'assets'):
            assert original.get(key) == spec.get(key), (manifest, key)
        assert len(original['settings']) == len(spec['settings'])
        for a, b in zip(original['settings'], spec['settings']):
            assert a['key'] == b['key'] and a['default'] == b['default']
            assert [o[0] for o in a.get('options', [])] == [o[0] for o in b.get('options', [])]
        suffix = '' if language == 'en' else '-' + language.lower().replace('-', '.') + '.' + str(revisions[language])
        assert spec['version'] == original['version'] + suffix, (manifest, language, spec['version'])
        _, ui, strings, _ = build.build_ui(copy.deepcopy(spec), language)
        unicode_resources(ui, strings, language)
        assert dynamic_ids <= set(strings), (manifest, language, 'missing dynamic IDs')
        assert len([k for k in strings if k.startswith('SID_CN_DYNAMIC_')]) == 256
        assert len(strings) <= 1024
        assert spec['title'] in strings.values()
        credit_title = build.sid(spec['id'], 'CN_CREDITS_TITLE')
        credit_link = build.sid(spec['id'], 'CN_CREDITS_LINK')
        cn = {k for k in strings if k.endswith('_CN_CREDITS_TITLE') or k.endswith('_CN_CREDITS_LINK')}
        if language == 'zh-CN':
            assert cn == {credit_title, credit_link}
            assert strings[credit_title] == credit['settingsTitle']
            assert strings[credit_link] == credit['settingsLink']
        else:
            assert not cn
        other = translation_credit(language) if language != 'zh-CN' else None
        if other:
            title, link = build.sid(spec['id'], credit_name(language) + '_TITLE'), build.sid(spec['id'], credit_name(language) + '_LINK')
            assert strings[title] == other['settingsTitle'] and strings[link] == other['settingsLink'], (manifest, language)
            assert all('JackieZ123430' not in v and '小白' not in v and '抖音' not in v for v in strings.values())
        assert any('github.com/cauliflowermossgrape/idrive7-apps' in v for v in strings.values())
        # build.py writes this fixed bundle to each of the 33 HMI locale files.
        tables = {hmi_locale: dict(strings) for hmi_locale in build.LANGS}
        assert len(tables) == 33
        for hmi_locale, table in tables.items():
            missing = dynamic_ids - set(table)
            assert not missing, (manifest, language, hmi_locale, sorted(missing))
            assert len(dynamic_ids & set(table)) == 256
            assert set(table) == set(strings)
        table_count += len(tables)
        def visit(obj):
            if isinstance(obj, dict):
                assert obj.get('name') != 'SET_LANGUAGE', (manifest, language, 'language selector')
                if obj.get('type') == 'StringId': assert obj['value'] in strings, (manifest, obj)
                if obj.get('type') == 'Text' and isinstance(obj.get('value'), str): assert obj['value'] == ''
                for value in obj.values(): visit(value)
            elif isinstance(obj, list):
                for value in obj: visit(value)
        visit(ui)
        keys[language] = set(strings)
        count += 1
    ru_credit = {build.sid(original['id'], credit_name('ru') + '_TITLE'), build.sid(original['id'], credit_name('ru') + '_LINK')}
    assert keys['ru'] - keys['en'] == (ru_credit if translation_credit('ru') else set()), (manifest, 'Russian adds only its credit rows')
    assert keys['en'] <= keys['ru']
    assert keys['zh-CN'] - keys['en'] == {build.sid(original['id'], 'CN_CREDITS_TITLE'),
                                           build.sid(original['id'], 'CN_CREDITS_LINK')}
    assert keys['en'] <= keys['zh-CN']
try:
    unicode_resources({}, {'SID_TEST_%d' % n: '' for n in range(769)}, 'en')
except ValueError:
    pass
else:
    raise AssertionError('build must reject bundles exceeding 1024 strings')
service_date_test = r'''
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync(process.argv[1], 'utf8');
const russian = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const start = source.indexOf('const MONTHS =');
const end = source.indexOf('\nconst W =', start);
assert(start >= 0 && end > start);
function fixedParser(language, words) {
    const context = {
        translate: (s) => words[s] || s,
        getLanguage: () => language,
        plural: (n, one, other) => (n === 1 ? one : other),
    };
    vm.runInNewContext(source.slice(start, end) + '\nthis.parseDue = parseDue;', context);
    return context.parseDue;
}
const parseRu = fixedParser('ru', russian);
const months = [
    ['01', 'январь', 'января'], ['02', 'февраль', 'февраля'],
    ['03', 'март', 'марта'], ['04', 'апрель', 'апреля'],
    ['05', 'май', 'мая'], ['06', 'июнь', 'июня'],
    ['07', 'июль', 'июля'], ['08', 'август', 'августа'],
    ['09', 'сентябрь', 'сентября'], ['10', 'октябрь', 'октября'],
    ['11', 'ноябрь', 'ноября'], ['12', 'декабрь', 'декабря'],
];
const now = new Date(2026, 0, 1);
for (const [number, nominative, genitive] of months) {
    assert.strictEqual(parseRu(`15.${number}.2027`, now).text, `15 ${genitive} 2027`);
    assert.strictEqual(parseRu(`${number}.2027`, now).text, `${nominative} 2027`);
}
for (const language of ['en', 'zh-CN']) {
    const parse = fixedParser(language, {});
    assert.strictEqual(parse('15.09.2027', now).text, '15 September 2027');
    assert.strictEqual(parse('09.2027', now).text, 'September 2027');
}
'''
subprocess.run(['node', '-e', service_date_test, str(root / 'apps/service/main.js'),
                str(root / 'kit/runtime/locales/ru.json')], check=True)
extra = root / 'kit/runtime/locales/xx-test.json'
assert not extra.exists()
try:
    extra.write_text('{"Settings":"Test settings"}', encoding='utf-8')
    assert 'xx-test' in languages() and load_locale('xx-test')['Settings'] == 'Test settings'
finally:
    extra.unlink()
print('PASS: %d fixed-language layouts, %d HMI tables with all 256 dynamic IDs, no selector/switch, version suffixes and credits' %
      (count, table_count))
