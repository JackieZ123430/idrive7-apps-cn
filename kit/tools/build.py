#!/usr/bin/env python3
"""MGU App Kit build: apps/<id>/app.json + main.js  ->  installable app.

    python3 kit/tools/build.py            # build every app in apps/
    python3 kit/tools/build.py car_vitals # just one

Produces in dist/:
    <id>@<ver>.mgu   install bundle for deploy/mgu-app-install.sh (VM and car)
    <id>@<ver>.tgz   npm-format package (the platform's preinstalled_apps format)
    <id>/            the staged tree (handy for inspection)

The RHMI layout (application.xml + uiDescription.json) is GENERATED from the
"screens" + "settings" in app.json, using only widget templates that BMW's own
apps use on this firmware (see reference/rhmi-widget-cells.md).
"""
import json, os, re, shutil, sys, tarfile, uuid
from xml.sax.saxutils import escape
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pack_data  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
KIT = os.path.join(ROOT, 'kit')
APPS = os.path.join(ROOT, 'apps')
DIST = os.path.join(ROOT, 'dist')
SDK = os.path.join(ROOT, 'oap-sdk')
NS = uuid.UUID('6b1d3a52-8f0e-4c4b-9a77-0d0c4d4e5f10')

LANGS = ['ar_AE', 'cs_CZ', 'da_DK', 'de_DE', 'el_GR', 'en_GB', 'en_US', 'es_ES', 'fi_FI', 'fr_FR', 'he_IL',
         'hu_HU', 'id_ID', 'it_IT', 'ja_JP', 'ko_KR', 'nb_NO', 'nl_NL', 'no_NO', 'pl_PL', 'pt_BR', 'pt_PT',
         'ro_RO', 'ru_RU', 'sk_SK', 'sl_SI', 'sv_SE', 'th_TH', 'tr_TR', 'uk_UA', 'vi_VN', 'zh_CN', 'zh_TW']

NATIVE = ['certmgr', 'codings', 'ecu', 'nare_logging', 'necemapaths', 'personalization',
          'smrf-native-cpp', 'someip', 'wscpp-client']

# Platform proxies every OAP app needs (same set BMW's apps declare).
PLATFORM_PROXIES = {
    "de.bmw.infotainment.hmi.entrypoint.EntryPoint": "*",
    "de.bmw.infotainment.hmi.entrypoint.EntryPointManager": "*",
    "de.bmw.infotainment.hmi.remote.RemoteHmi": "*",
    "de.bmw.infotainment.hmi.remote.RemoteHmiApplication": "*",
    "de.bmw.infotainment.hmi.resourcemanagement.ResourceBundle": "*",
    "de.bmw.infotainment.hmi.resourcemanagement.ResourceManager": "*",
    "de.bmw.infotainment.hmi.resourcemanagement.StringBundle": "*",
    "de.bmw.infotainment.hmi.usecasemanagement.UseCaseInstance": "*",
    "de.bmw.infotainment.hmi.usecasemanagement.UseCaseProvider": "*",
    "de.bmw.infotainment.hmi.usecasemanagement.UseCaseRegistry": {
        "attributes": {"useCaseIds": "r"}, "broadcasts": ["registryUpdate"], "instances": "*", "methods": ["getProvider"]},
    "de.bmw.infotainment.lifecycle.lifecycle.Lifecycle": {"attributes": {"powerStateDetailed": "rs"}, "instances": "Front"},
    "de.bmw.infotainment.personalization.SessionManager": "*",
    "de.bmw.infotainment.personalization.UserAccount": {
        "attributes": {"firstName": "rs", "gcid": "rs", "id": "r", "name": "rs", "type": "r"},
        "broadcasts": ["requestUpdateConnectedDriveCredentials"], "instances": "*"},
    "de.bmw.infotainment.dataprivacy.privacysettings.PrivacySettings": {
        "attributes": {"allSettings": "rs"}, "instances": "1",
        "methods": ["addOrUpdateSetting", "setDynamicAvailable", "setDynamicEnable"]},
    "de.bmw.infotainment.telematic.oap.AppBookmarks": {"instances": ["${userId}"], "methods": ["registerBookmark"]},
    "de.bmw.infotainment.telematic.oap.PrivateEntryPoint": {
        "instances": ["${userId}"], "methods": ["registerEntryPoint", "unregisterEntryPoint", "setSelected", "setAvailability"]},
    "de.bmw.infotainment.telematic.oap.WakeUpOnDemand": {"instances": ["${userId}"], "methods": ["registerParticipant", "unregisterParticipant"]},
    "de.bmw.infotainment.telematic.oap.WodControl": {"instances": "${userId}", "methods": ["offerService", "stopOfferingService"]},
    "de.bmw.infotainment.telematic.oapcontroller.OAPController": "*",
    "de.bmw.infotainment.telematic.provisioning.Provisioning": {
        "broadcasts": ["provisioningDataJSON"], "instances": "1", "methods": ["getValueJSON", "setFilterForProvisioningData"]},
    "de.bmw.infotainment.vehicle.Vehicle": {"attributes": {"statusNewCurrentUnitsStatusExt": "rs"}, "instances": "1"},
    "de.bmw.infrastructure.EnvironmentalInformation": {"attributes": {"UnitBN2020": "rs"}, "instances": "1"},
    "org.genivi.nodestatemanager.Consumer": {
        "broadcasts": ["ShutdownEvents", "SessionStateChanged"], "instances": "NSMConsumer",
        "methods": ["LifecycleRequestComplete", "RegisterShutdownClient", "UnRegisterShutdownClient"]},
}
PLATFORM_SERVICES = {
    "de.bmw.infotainment.telematic.oap.AppStatus": {"instances": ["${userId}"]},
    "de.bmw.infotainment.telematic.oap.TriggersControl": {"instances": ["${userId}"]},
}

# property ids (RhmiConstants): Enabled=1 Visible=2 Focusable=3 ParentState=9
WIDGETS = {
    'graphic':   ('label', 'LT_Label_1Graphic_Scalable', {2: 1, 3: 0}),
    # Focusable=3: the HMI then reports focus changes (the kit's slim bar shows the focused button)
    'barbutton': ('button', 'LT_Button_1Row_Laptimer', {3: 3}),
    'header':    ('label', 'LT_Label_Header_1Row', {2: 1, 3: 0}),
    'text':      ('label', 'LT_Label_1Row', {2: 1, 3: 0}),
    'text3':     ('label', 'LT_Label_3Row_1TextDyn', {2: 1, 3: 0}),
    # menu rows: Visible=1, Focusable=2 - as in BMW's smartinterior menus
    'button':    ('button', 'LT_Button_1Row', {2: 1, 3: 2}),
    'iconbutton': ('button', 'LT_Button_1Row_1IconLeft', {2: 1, 3: 2}),
    'twocol':    ('button', 'LT_Button_1Row_2Col7030_2Text', {2: 1, 3: 2}),
    # settings: label on the 1st row, value on the 2nd, each the full width (BMW's parking app
    # settings use it in an LT_State_Wide); the 70/30 one-row columns cut both off
    'tworow':    ('button', 'LT_Button_2Row_2Text', {2: 1, 3: 2}),
    'checkbox':  ('checkBox', 'LT_CheckBox_1Row', {2: 1, 3: 2}),
    'scroll':    ('label', 'LT_ScrollLabel_UnlimitedRow_TextDyn', {2: 1, 3: 1}),
    'laptimer':  ('label', 'LT_Label_Laptimer', {3: 0}),
}


def u(app, what):
    return str(uuid.uuid5(NS, app + ':' + what))


class Ids:
    def __init__(self):
        self.n = 0

    def __call__(self):
        self.n += 1
        return self.n


def sid(app, key):
    return 'SID_' + re.sub(r'[^A-Z0-9]+', '_', (app + '_' + key).upper()).strip('_')


def hmi_text(s):
    """Text for the HMI's own components: it shows non-ASCII as mojibake ('deg C' -> 'A-circumflex deg C'),
    so the degree sign is dropped and other non-ASCII characters removed (as mgu.js hmiText)."""
    return re.sub(r'[^\x20-\x7e]', '', str(s).replace('°', ''))


def setting_options(s):
    """(values, labels) of a choice / number setting, in order - the drop-down's rows.
    "markDefault": true adds " (default)" to the default's row."""
    if s['type'] == 'choice':
        values, labels = [o[0] for o in s['options']], [o[1] for o in s['options']]
    else:
        steps = s.get('steps') or []
        unit = (' ' + s['unit']) if s.get('unit') else ''
        values, labels = list(steps), [('%g' % v) + unit for v in steps]
    if s.get('markDefault'):
        labels = [lb + ' (default)' if v == s.get('default') else lb for v, lb in zip(values, labels)]
    return values, labels


def build_ui(spec):
    """screens/settings -> (application.xml, uiDescription.json, strings, screen meta)"""
    app = spec['id']
    nid = Ids()
    strings = {sid(app, 'TITLE'): spec['title']}
    xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<application>']
    ui = {'schemaVersion': '1.3.0', 'containers': {}}
    screens = list(spec.get('screens', []))
    if spec.get('settings'):
        screens.append({'name': 'SETTINGS', 'kind': 'settings', 'title': 'Settings'})
    state_ids = {}
    for scr in screens:
        state_ids[scr['name']] = None
    main_id = None

    def comp(kind, name, rows=None, extra_props=None, cells=None):
        ctype, widget, props = WIDGETS[kind]
        cid = nid()
        p = dict(props)
        p.update(extra_props or {})
        x = [f'            <component id="{cid}" type="{ctype}" widget="{widget}">']
        x += [f'                <property id="{k}" value="{v}"/>' for k, v in p.items()]
        x.append('            </component>')
        c = {'type': ctype, 'name': name}
        pj = {}
        if 2 in p: pj['Visible'] = {'value': p[2], 'type': 'UInt'}
        if 3 in p: pj['Focusable'] = {'value': p[3], 'type': 'UInt'}
        if pj: c['properties'] = pj
        if rows is not None: c['rows'] = rows
        if cells is not None: c['cells'] = cells
        return cid, x, c

    def text_row(key, text, cell='Text'):
        s = sid(app, key)
        strings[s] = text
        return {cell: {'value': s, 'type': 'StringId'}}

    for scr in screens:
        cid = nid()
        state_ids[scr['name']] = cid
        kind = scr.get('kind', 'list')
        # canvas = M Laptimer's state; menus = the state BMW uses for its
        # clickable lists (LT_State_Wide only renders a single text block)
        # settings: the wide state (full screen width), as BMW's own settings lists
        widget = 'LT_State_Laptimer' if kind == 'canvas' else 'LT_State_Wide' if kind == 'settings' else 'LT_State_Regular_ContentHidden'
        cont = {'type': 'state', 'name': scr['name'], 'components': {}}
        x = [f'    <container id="{cid}" type="state" widget="{widget}">']
        if main_id is not None and scr.get('parent', True):
            x.append(f'        <property id="9" value="{main_id}"/>')
            cont['properties'] = {'ParentState': {'value': main_id, 'type': 'UInt'}}
        groups = []
        if kind == 'canvas':
            items = []
            gid, gx, gc = comp('graphic', scr.get('graphic', scr['name'] + '_GFX'), rows=[{'Graphic': {'value': '', 'type': 'Text'}}])
            items.append((gid, gx, gc))
            groups.append(('List', items))
            bar = []
            for b in scr.get('buttons', []):
                bid, bx, bc = comp('barbutton', b[0], rows=[text_row(b[0], b[1])])
                bar.append((bid, bx, bc))
            if bar:
                groups.append(('Bar', bar))
        elif kind == 'settings':
            items = []
            for s in spec['settings']:
                name = 'SET_' + s['key'].upper()
                if s['type'] == 'bool':
                    items.append(comp('checkbox', name, rows=[text_row('SET_' + s['key'], s['label'])]))
                elif s['type'] in ('choice', 'number'):
                    # a drop-down with every value, as BMW's parking app settings: rows = options
                    # (ItemText), HeaderText = the setting, SelectedItem = the chosen row (mgu.js sets it)
                    values, labels = setting_options(s)
                    did = nid()
                    items.append((did, [f'            <component id="{did}" type="dropDownMenu"/>'], {
                        'type': 'dropDownMenu', 'name': name,
                        'rows': [{'ItemText': {'value': hmi_text(lb), 'type': 'Text'}} for lb in labels],
                        'cells': {'HeaderText': {'value': hmi_text(s['label']), 'type': 'Text'},
                                  'SelectedItem': {'value': values.index(s['default']) if s['default'] in values else 0, 'type': 'UInt'}},
                    }))
                else:
                    strings[sid(app, 'SET_' + s['key'])] = s['label']
                    items.append(comp('tworow', name, rows=[{'Text1stRow': {'value': s['label'], 'type': 'Text'},
                                                            'Text2ndRow': {'value': '', 'type': 'Text'}}]))
            groups.append(('List', items))
        else:   # list: components from "items"
            items = []
            for it in scr.get('items', []):
                kindi, name = it[0], it[1]
                label = it[2] if len(it) > 2 else ''
                if kindi == 'twocol':
                    rows = [{'Text1stCol': {'value': label, 'type': 'Text'}, 'Text2ndCol': {'value': '', 'type': 'Text'}}]
                elif kindi in ('graphic',):
                    rows = [{'Graphic': {'value': '', 'type': 'Text'}}]
                elif kindi == 'laptimer':
                    rows = [{}]
                else:
                    rows = [text_row(name, label)] if label else [{'Text': {'value': '', 'type': 'Text'}}]
                items.append(comp(kindi, name, rows=rows))
            groups.append(('List', items))
        tid = nid()
        groups.append(('Titlebar', [(tid, [f'            <component id="{tid}" type="title"/>'],
                                     {'type': 'title', 'name': scr['name'] + '_TITLE', 'rows': [text_row(scr['name'] + '_TITLE', scr.get('title', spec['title']))]})]))
        for gname, items in groups:
            gid = nid()
            x.append(f'        <layoutGroup id="{gid}" name="{gname}">')
            if gname != 'Titlebar':
                x.append('            <property id="3" value="1"/>')
            for (ccid, cx, cc) in items:
                x += cx
                cont['components'][str(ccid)] = cc
            x.append('        </layoutGroup>')
        x.append('    </container>')
        xml += x
        ui['containers'][str(cid)] = cont
        if main_id is None:
            main_id = cid
    xml.append('</application>')
    return '\n'.join(xml) + '\n', ui, strings, state_ids


def manifest_for(spec):
    proxies = dict(PLATFORM_PROXIES)
    for iface, fields in spec.get('signals', {}).items():
        inst = fields.pop('_instances', '1') if isinstance(fields, dict) else '1'
        entry = {'instances': inst}
        if isinstance(fields, dict):
            attrs = {k: v for k, v in fields.items() if not k.startswith('_')}
            meths = fields.get('_methods')
            evts = fields.get('_broadcasts')
            if attrs: entry['attributes'] = attrs
            if meths: entry['methods'] = meths
            if evts: entry['broadcasts'] = evts
        else:
            entry = '*'
        proxies[iface] = entry
    return {'proxies': proxies, 'services': PLATFORM_SERVICES}


def make_icon(spec, out):
    src = os.path.join(APPS, spec['id'], 'icon.png')
    if os.path.exists(src):
        shutil.copy(src, out)
        return
    # rendered by the kit's own canvas (node) so no extra tooling is needed
    os.system(f'node "{os.path.join(HERE, "make_icon.js")}" "{spec.get("iconGlyph", spec["title"][:2])}" "{out}"')


def build(app_id):
    spec = json.load(open(os.path.join(APPS, app_id, 'app.json'), encoding='utf-8'))
    spec.setdefault('id', app_id)
    ver = spec['version']
    stage = os.path.join(DIST, app_id)
    shutil.rmtree(stage, ignore_errors=True)
    src = os.path.join(stage, 'source')
    os.makedirs(os.path.join(src, 'javascript', 'kit'))
    os.makedirs(os.path.join(src, 'config'))
    os.makedirs(os.path.join(src, 'node_modules', 'oap-sdk'))

    manifest = manifest_for(json.loads(json.dumps(spec)))
    xml, uidesc, strings, state_ids = build_ui(spec)
    for lang, tbl in spec.get('strings', {}).items():
        strings.update(tbl)

    # --- source/ (the npm package) ---
    pkg = {
        'name': app_id, 'version': ver, 'description': spec.get('description', spec['title']),
        'main': 'javascript/app.js', 'private': False, 'author': spec.get('vendor', 'custom'), 'license': 'UNLICENSED',
        'engines': {'node': '>=8.7.0'},
        'oapAppSettings': {
            'maxDiskUsage': spec.get('maxDiskUsage', 20971520), 'cpuLimit': spec.get('cpuLimit', 60),
            'memoryThresholdKB': spec.get('memoryKB', 196608), 'priority': 'PRIO_LOW',
            'visibility': 'FOREGROUND', 'latencyClass': 'FOREGROUND', 'loggingId': spec['loggingId'],
            'userLoginRequired': False, 'backgroundPriority': 200, 'someipManifest': 'manifest.json',
        },
    }
    json.dump(pkg, open(os.path.join(src, 'package.json'), 'w', encoding='utf-8', newline='\n'), indent=2)
    json.dump(manifest, open(os.path.join(src, 'manifest.json'), 'w', encoding='utf-8', newline='\n'), indent=2)
    shutil.copy(os.path.join(KIT, 'platform', 'permissions.json'), os.path.join(src, 'permissions.json'))
    json.dump({'name': app_id, 'version': ver, 'lockfileVersion': 1}, open(os.path.join(src, 'npm-shrinkwrap.json'), 'w', encoding='utf-8', newline='\n'))
    json.dump({'settings': {app_id: spec.get('config', {})}}, open(os.path.join(src, 'config', 'base.json'), 'w', encoding='utf-8', newline='\n'), indent=2)
    # app code
    adir = os.path.join(APPS, app_id)
    for f in os.listdir(adir):
        if f.endswith('.js'):
            shutil.copy(os.path.join(adir, f), os.path.join(src, 'javascript', 'app.js' if f == 'main.js' else f))
        elif os.path.isdir(os.path.join(adir, f)):
            # data folders go along as one compressed file, read with kit/runtime/pack.js
            # (e.g. dtc_scanner/dtc_db, the fault text database -> dtc_db.pack)
            raw, size, _ = pack_data.pack(os.path.join(adir, f), os.path.join(src, 'javascript', f + '.pack'))
            print('  %s/: %.1f MB packed to %.2f MB' % (f, raw / 1e6, size / 1e6))
    # kit runtime
    kr = os.path.join(KIT, 'runtime')
    for f in os.listdir(kr):
        p = os.path.join(kr, f)
        if os.path.isdir(p):
            shutil.copytree(p, os.path.join(src, 'javascript', 'kit', f))
        else:
            shutil.copy(p, os.path.join(src, 'javascript', 'kit', f))
    rt_spec = {k: spec.get(k) for k in ('id', 'title', 'version', 'screens', 'settings', 'config')}
    rt_spec['stateIds'] = state_ids
    json.dump(rt_spec, open(os.path.join(src, 'javascript', 'kit', 'app-spec.json'), 'w', encoding='utf-8', newline='\n'), indent=1)
    shutil.copy(os.path.join(SDK, 'index.js'), os.path.join(src, 'node_modules', 'oap-sdk', 'index.js'))
    shutil.copy(os.path.join(SDK, 'package.json'), os.path.join(src, 'node_modules', 'oap-sdk', 'package.json'))

    # --- rhmiData: package format (inside source/) and installed format ---
    icon = spec['id'] + '_icon.png'
    app_json = {
        'schemaVersion': '1.3.0',
        'application': {
            'uuid': u(app_id, 'app'), 'type': 'OnlineApp', 'name': app_id, 'vendor': spec.get('vendor', 'custom'),
            'version': ver, 'defaultLanguage': 'en_GB',
            'stringBundleUuid': u(app_id, 'strings'), 'resourceBundleUuid': u(app_id, 'resources'),
            'entryPoints': [{
                'name': app_id.upper() + '_ENTRY', 'uuid': u(app_id, 'entry'), 'textId': sid(app_id, 'TITLE'),
                'icon': icon, 'insertionStateId': 20974, 'insertionFocusId': 2, 'insertionMode': 'INSERT_BELOW',
                'insertionOrder': 0, 'insertionPriority': 0, 'previewType': 'NONE', 'bookmarkable': True,
                'private': False, 'appearance': 'DEFAULT', 'isGroupHeader': False, 'insertionGroup': 0,
            }],
        },
    }
    pr = os.path.join(src, 'rhmiData')
    os.makedirs(os.path.join(pr, 'uiDescriptions', 'ID7'))
    os.makedirs(os.path.join(pr, 'variantGroups', 'Common', 'texts'))
    os.makedirs(os.path.join(pr, 'variantGroups', 'Common', 'images'))
    pj = json.loads(json.dumps(app_json))
    pj['application']['uiDescriptions'] = [{'applicationFilePath': './uiDescriptions/ID7/application.xml',
                                            'uiDescriptionFilePath': './uiDescriptions/ID7/uiDescription.json', 'hmi': ['ID7']}]
    pj['application']['variantGroups'] = [{'stringsPath': './variantGroups/Common/texts',
                                           'resourcesPath': './variantGroups/Common/images', 'hmi': ['ID7'], 'brands': ['BMW']}]
    json.dump(pj, open(os.path.join(pr, 'application.json'), 'w', encoding='utf-8', newline='\n'), indent=2)
    open(os.path.join(pr, 'uiDescriptions', 'ID7', 'application.xml'), 'w', encoding='utf-8', newline='\n').write(xml)
    json.dump(uidesc, open(os.path.join(pr, 'uiDescriptions', 'ID7', 'uiDescription.json'), 'w', encoding='utf-8', newline='\n'), indent=1)
    for lang in ('en_GB', 'en_US', 'de_DE'):
        json.dump(strings, open(os.path.join(pr, 'variantGroups', 'Common', 'texts', lang + '.json'), 'w', encoding='utf-8', newline='\n'), ensure_ascii=False)
    make_icon(spec, os.path.join(pr, 'variantGroups', 'Common', 'images', icon))

    ir = os.path.join(stage, 'rhmiData')
    os.makedirs(os.path.join(ir, 'uiDescription'))
    os.makedirs(os.path.join(ir, 'strings'))
    os.makedirs(os.path.join(ir, 'resources'))
    ij = json.loads(json.dumps(app_json))
    ij['application'].update({
        'entryPointsStringBundleUuid': u(app_id, 'ep-strings'), 'entryPointsResourceBundleUuid': u(app_id, 'ep-resources'),
        'externalDialogStringBundleUuid': u(app_id, 'ed-strings'),
        'bookmarkUuidPool': [u(app_id, 'bookmarks'), 1, 2, 3, 4, 5, 6, 7],
    })
    json.dump(ij, open(os.path.join(ir, 'application.json'), 'w', encoding='utf-8', newline='\n'), separators=(',', ':'))
    open(os.path.join(ir, 'uiDescription', 'application.xml'), 'w', encoding='utf-8', newline='\n').write(xml)
    json.dump(uidesc, open(os.path.join(ir, 'uiDescription', 'uiDescription.json'), 'w', encoding='utf-8', newline='\n'), indent=1)
    for lang in LANGS:
        json.dump(strings, open(os.path.join(ir, 'strings', lang + '.json'), 'w', encoding='utf-8', newline='\n'), ensure_ascii=False)
    shutil.copy(os.path.join(pr, 'variantGroups', 'Common', 'images', icon), os.path.join(ir, 'resources', icon))

    # --- installer helpers + metadata ---
    shutil.copytree(os.path.join(KIT, 'tools', 'oapgen'), os.path.join(stage, 'oapgen'))
    meta = {'id': app_id, 'version': ver, 'title': spec['title'], 'native': NATIVE, 'kit': 1}
    json.dump(meta, open(os.path.join(stage, 'meta.json'), 'w', encoding='utf-8', newline='\n'), indent=1)

    # --- archives ---
    os.makedirs(DIST, exist_ok=True)
    bundle = os.path.join(DIST, f'{app_id}@{ver}.mgu')
    with tarfile.open(bundle, 'w:gz') as tf:
        for n in ('meta.json', 'source', 'rhmiData', 'oapgen'):
            tf.add(os.path.join(stage, n), arcname=n)
    npm = os.path.join(DIST, f'{app_id}@{ver}.tgz')
    with tarfile.open(npm, 'w:gz') as tf:
        tf.add(src, arcname='package')
    print(f'{app_id} {ver}: {os.path.relpath(bundle, ROOT)} ({os.path.getsize(bundle) // 1024} KiB), '
          f'{len(uidesc["containers"])} screens, states {state_ids}')


def main():
    ids = sys.argv[1:] or sorted(d for d in os.listdir(APPS) if os.path.exists(os.path.join(APPS, d, 'app.json')))
    for i in ids:
        build(i)


if __name__ == '__main__':
    main()
