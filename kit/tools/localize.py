"""Chinese display metadata; identifiers, defaults, signals and diagnostics stay untouched."""
# 汉化维护：Bilibili 小白151 / GitHub JackieZ123430
import copy
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
with open(os.path.join(ROOT, 'kit', 'runtime', 'locales', 'zh-CN.json'), encoding='utf-8') as f:
    WORDS = json.load(f)


def text(value):
    s = str(value)
    return WORDS.get(s, s).replace(' (default)', '（默认）')


def spec_zh(spec):
    s = copy.deepcopy(spec)
    s['title'] = text(s['title'])
    for screen in s.get('screens', []):
        if 'title' in screen:
            screen['title'] = text(screen['title'])
        for button in screen.get('buttons', []):
            button[1] = text(button[1])
        for item in screen.get('items', []):
            if len(item) > 2 and isinstance(item[2], str):
                item[2] = text(item[2])
    for setting in s.get('settings', []):
        setting['label'] = text(setting['label'])
        for option in setting.get('options', []):
            option[1] = text(option[1])
    return s


def unicode_resources(ui, strings):
    """Initial RHMI Text cells use StringIds too: avoid the legacy Text encoding path."""
    counter = [0]

    def visit(obj):
        if isinstance(obj, dict):
            value = obj.get('value')
            if obj.get('type') == 'Text' and isinstance(value, str) and any(ord(ch) > 127 for ch in value):
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
    for key in list(strings):
        strings[key] = text(strings[key])
    # Reserved for HmiText's dynamic per-component/row/cell resources.
    for n in range(1024):
        strings['SID_CN_DYNAMIC_%04d' % n] = ''
