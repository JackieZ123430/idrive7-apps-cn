"""Fixed-language packages. Add a locales/<tag>.json catalog to build another language."""
# Chinese contribution: 小白科技杂物社 / Bilibili 小白151 / GitHub JackieZ123430
import copy
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
LOCALES = ROOT / 'kit/runtime/locales'
CHINESE = ('zh-CN', 'zh-TW')
WIDGET_SLOT_COUNT = 64


def languages():
    return ['en'] + sorted(p.stem for p in LOCALES.glob('*.json') if p.stem != 'en')


def load_locale(language):
    if language not in languages():
        raise ValueError('Unknown language: ' + language)
    return {} if language == 'en' else json.loads((LOCALES / (language + '.json')).read_text(encoding='utf-8'))


def text(value, words):
    s = str(value)
    return words.get(s, s).replace(' (default)', ' ' + words.get('(default)', '(default)'))


def package_version(version, language):
    revisions = json.loads((Path(__file__).parent / 'locale-revisions.json').read_text(encoding='utf-8'))
    return version if language == 'en' else version + '-' + language.lower().replace('-', '.') + '.' + str(revisions.get(language, 1))


def localize_spec(spec, language):
    words = load_locale(language)
    s = copy.deepcopy(spec)
    s['version'] = package_version(s['version'], language)
    s['title'] = text(s['title'], words)
    if 'startWidget' in s:
        widget = s['startWidget']
        if 'name' in widget:
            widget['name'] = text(widget['name'], words)
        for cell in widget.get('cells', {}).values():
            if len(cell) > 1 and cell[1] == 'Text':
                cell[0] = text(cell[0], words)
    for screen in s.get('screens', []):
        if 'title' in screen:
            screen['title'] = text(screen['title'], words)
        for button in screen.get('buttons', []):
            button[1] = text(button[1], words)
        for item in screen.get('items', []):
            if len(item) > 2 and isinstance(item[2], str):
                item[2] = text(item[2], words)
    for setting in s.get('settings', []):
        setting['label'] = text(setting['label'], words)
        for option in setting.get('options', []):
            option[1] = text(option[1], words)
    return s


def unicode_resources(ui, strings, language='en'):
    """Localize static resources; give initial Text cells stable Unicode StringIds."""
    words = load_locale(language)
    counter = [0]

    def visit(obj):
        if isinstance(obj, dict):
            value = obj.get('value')
            if obj.get('type') == 'Text' and isinstance(value, str) and value:
                sid = 'SID_CN_STATIC_%04d' % counter[0]
                counter[0] += 1
                strings[sid] = value
                obj.update(value=sid, type='StringId')
            else:
                for item in obj.values():
                    visit(item)
        elif isinstance(obj, list):
            for item in obj:
                visit(item)

    visit(ui)
    for key in strings:
        strings[key] = text(strings[key], words)
        if language in CHINESE and key.endswith('_CN_CREDITS_TITLE'):
            strings[key] = ('漢化' if language == 'zh-TW' else '汉化') + ' Translation by：抖音 小白科技杂物社 / BiliBili 小白151'
    for n in range(256):
        strings['SID_CN_DYNAMIC_%04d' % n] = ''
    if len(strings) > 1024:
        raise ValueError('HMI string bundle exceeds the verified 1024-resource budget')


def widget_resources(name, value, language='en'):
    # Do not run unicode_resources over widget metadata: Widget/UUID are protocol
    # Text cells, not display labels, and must retain their literal values/types.
    strings = {name: text(value, load_locale(language))}
    for n in range(WIDGET_SLOT_COUNT):
        strings['SID_WIDGET_DYNAMIC_%04d' % n] = ''
    if len(strings) > 1024:
        raise ValueError('Widget string bundle exceeds 1024 resources')
    return strings
