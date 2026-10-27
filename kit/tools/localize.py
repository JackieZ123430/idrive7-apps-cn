"""English canonical strings plus a Chinese table; no mutation of protocol/configuration data."""
# 汉化维护：Bilibili 小白151 / GitHub JackieZ123430
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
with open(os.path.join(ROOT, 'kit', 'runtime', 'locales', 'zh-CN.json'), encoding='utf-8') as f:
    WORDS = json.load(f)


def text(value):
    s = str(value)
    return WORDS.get(s, s).replace(' (default)', '（默认）')


def unicode_resources(ui, strings):
    """Every nonempty static Text cell gets a stable StringId for runtime language changes."""
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
    # Reserved for HmiText's dynamic per-component/row/cell resources.
    for n in range(256):
        strings['SID_CN_DYNAMIC_%04d' % n] = ''
    if len(strings) > 1024:
        raise ValueError('HMI string bundle exceeds 1024 resources; reduce static strings or dynamic slots')


def resource_tables(strings):
    # Dynamic slots must not be blanked when switching static resources.
    english = {key: value for key, value in strings.items() if not key.startswith('SID_CN_DYNAMIC_')}
    chinese = {key: text(value) for key, value in english.items()}
    for key in chinese:
        if key.endswith('_CN_CREDITS_TITLE'):
            chinese[key] = '汉化：小白科技杂物社 / Bilibili 小白151'
    return {'en': english, 'zh-CN': chinese}
