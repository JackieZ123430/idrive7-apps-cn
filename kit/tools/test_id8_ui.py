#!/usr/bin/env python3
"""build.py's iDrive 8 screen description (uiDescriptions/ID8), for every app: the same state ids and component
names as the iDrive 7 one, only the widgets the MGU Store's own app runs with on Hmi8, no ParentState (Hmi8
refuses a parent with a parent), the hidden KIT_HMI_ID8 label in the first state, every string id in the text
files, buttons with iDrive 8's cells; the iDrive 7 description as it was.
    python3 kit/tools/test_id8_ui.py
"""
import glob, json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build  # noqa: E402
from localize import unicode_resources  # noqa: E402

checks = fails = 0


def ok(cond, msg):
    global checks, fails
    checks += 1
    if not cond:
        fails += 1
        print('FAIL ' + msg)


ALLOWED = {'LT_State_Wide_List', 'LT_Button_MediaEntry_1Row', 'LT_ScrollLabel'}
for path in sorted(glob.glob(os.path.join(build.APPS, '*', 'app.json'))):
    spec = json.load(open(path, encoding='utf-8'))
    spec.setdefault('id', os.path.basename(os.path.dirname(path)))
    app = spec['id']
    xml7, ui7, s7, ids7 = build.build_ui(json.loads(json.dumps(spec)))
    xml8, ui8, s8, ids8 = build.build_ui(json.loads(json.dumps(spec)), 'en', 'ID8')
    ok(ids8 == ids7, app + ': same state ids')
    names7 = {c['name'] for cont in ui7['containers'].values() for c in cont['components'].values()}
    names8 = {c['name'] for cont in ui8['containers'].values() for c in cont['components'].values()}
    ok(names8 == names7 | {build.HMI8_MARK}, app + ': same component names (and the iDrive 8 mark): %s' % (names7 ^ names8))
    widgets = set(re.findall(r'widget="([^"]+)"', xml8))
    ok(widgets <= ALLOWED, app + ': only known Hmi8 widgets: %s' % (widgets - ALLOWED))
    ok('<property id="9"' not in xml8 and not any('properties' in c and 'ParentState' in c['properties'] for c in ui8['containers'].values()),
       app + ': no ParentState on iDrive 8')
    first = ui8['containers'][str(min(ids8.values()))]['components']
    mark = [c for c in first.values() if c['name'] == build.HMI8_MARK]
    ok(len(mark) == 1 and mark[0]['properties']['Visible']['value'] == 0, app + ': hidden mark in the first state')
    for cont in ui8['containers'].values():
        for c in cont['components'].values():
            if c['type'] == 'button':
                r = c['rows'][0]
                ok('PrimaryText' in r and 'FrequencyVisible' in r and not ({'Text', 'Text1stRow', 'Text2ndRow'} & set(r)),
                   app + ': ' + c['name'] + ' has iDrive 8 button cells: %s' % sorted(r))
    # every StringId resolves, after the Unicode pass (as build() does it: each description its own slot names)
    unicode_resources(ui7, s7)
    unicode_resources(ui8, s8, prefix='SID_CN_STATIC8_')
    strings = dict(s7, **s8)
    sids = re.findall(r'"value": "(SID_[A-Z0-9_]+)", "type": "StringId"', json.dumps(ui8))
    ok(sids and all(s in strings for s in sids), app + ': every iDrive 8 string id has a text')
    ok(len(strings) <= 1024, app + ': string bundle within budget')

print('id8 ui: %d checks, %d failed' % (checks, fails))
sys.exit(1 if fails else 0)
