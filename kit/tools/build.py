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
import gzip, json, os, re, shutil, sys, tarfile, tempfile, uuid
from xml.sax.saxutils import escape
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pack_data  # noqa: E402
from localize import unicode_resources, localize_spec, load_locale, languages, credit, credit_name, normalize_language

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
    # iDrive 8's platform interfaces: an oap-sdk from an iDrive 8 unit (MainApp-21) builds its RHMI, resources and
    # entry point on these and stops when their files are missing from the app's someipInterfaces (issue #152).
    # Both units' catalogs have them (as the MGU Store's own app lists them).
    "de.bmw.infotainment.hmi.entrypoint2.EntryPoint2": "*",
    "de.bmw.infotainment.hmi.entrypoint2.EntryPointManager2": "*",
    "de.bmw.infotainment.hmi.remote2.RemoteHmi2": "*",
    "de.bmw.infotainment.hmi.remote2.RemoteHmiApplication2": "*",
    "de.bmw.infotainment.hmi.resourcemanagement2.ResourceManager2": "*",
    "de.bmw.infotainment.hmi.resourcemanagement2.ResourceBundle2": "*",
    "de.bmw.infotainment.hmi.resourcemanagement2.StringBundle2": "*",
    "de.bmw.infotainment.hmi.usecasemanagement.UseCaseContext": "*",
    "de.bmw.infotainment.telematic.oap.PrivateEntryPoint2": {"instances": ["${userId}"], "methods": ["genericMethod"]},
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

# iDrive 8 (Hmi8): only the widgets the MGU Store's own app runs with there - LT_State_Wide_List states,
# LT_Button_MediaEntry_1Row buttons (cells PrimaryText / FrequencyText ...), LT_ScrollLabel labels and a
# label without a widget for a picture. Every button is a list row: a state has no button bar.
STATE8 = 'LT_State_Wide_List'
BUTTON8 = ('button', 'LT_Button_MediaEntry_1Row', {2: 1, 3: 3})
LABEL8 = ('label', 'LT_ScrollLabel', {2: 1, 3: 0})
WIDGETS8 = dict({k: LABEL8 for k in ('header', 'text', 'text3', 'scroll', 'laptimer')},
                **{k: BUTTON8 for k in ('barbutton', 'button', 'iconbutton', 'twocol', 'tworow', 'checkbox')},
                graphic=('label', None, {2: 1, 3: 0}))
# a hidden label in the first state of the iDrive 8 description: the app knows by it which cells to write
HMI8_MARK = 'KIT_HMI_ID8'
HMI8_MARK_ID = 990      # outside the ids build_ui counts up (one space for states, groups and components)
# iDrive 7 cells -> iDrive 8's (kit/runtime/mgu.js maps the app's writes the same way)
CELLS8 = {'Text': 'PrimaryText', 'Text1stRow': 'PrimaryText', 'Text1stCol': 'PrimaryText',
          'Text2ndRow': 'FrequencyText', 'Text2ndCol': 'FrequencyText'}


def row8(row, button):
    """An iDrive 7 row's cells as iDrive 8's: a button's as LT_Button_MediaEntry_1Row's, a label keeps Text."""
    if not button:
        return {k: v for k, v in row.items() if k != 'Graphic'}
    out = {CELLS8.get(k, k): v for k, v in row.items()}
    out.setdefault('PrimaryText', {'value': '', 'type': 'Text'})
    second = 'FrequencyText' in out
    out.setdefault('FrequencyText', {'value': '', 'type': 'Text'})
    out.update({'FrequencyVisible': {'value': second, 'type': 'Bool'}, 'IconVisible': {'value': False, 'type': 'Bool'},
                'ProgressVisible': {'value': False, 'type': 'Bool'}, 'IsPlaying': {'value': False, 'type': 'Bool'}})
    return out


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
    """Keep Unicode: unicode_resources converts these cells to StringId before packaging."""
    return str(s)


def setting_options(s):
    """(values, labels) of a choice / number setting, in order - the drop-down's rows.
    "markDefault": true adds " (default)" to the default's row; "labels": {"0": "Auto"} names
    single number values (shown as is, no unit)."""
    if s['type'] == 'choice':
        values, labels = [o[0] for o in s['options']], [o[1] for o in s['options']]
    else:
        steps = s.get('steps') or []
        unit = (' ' + s['unit']) if s.get('unit') else ''
        named = s.get('labels') or {}
        # "unitBy" + "units" (kit/runtime/sheet.js numberText): the HMI's rows are fixed here, so they name
        # the value in every unit ("215 kW / 288 hp / 292 PS")
        alts = [u for u in (s.get('units') or {}).values()] if s.get('unitBy') else []
        def text(v):
            if alts and isinstance(v, (int, float)):
                return ' / '.join([('%g' % v) + unit] + ['%d %s' % (int(v * u.get('mul', 1) + u.get('add', 0) + 0.5), u['unit']) for u in alts])
            return ('%g' % v) + unit
        values, labels = list(steps), [named.get('%g' % v, text(v)) for v in steps]
    if s.get('markDefault'):
        labels = [lb + ' (default)' if v == s.get('default') else lb for v, lb in zip(values, labels)]
    return values, labels



def fetch_assets(adir, assets):
    """Large files an app needs but git doesn't keep (app.json "assets"): downloaded once, checked by SHA-256."""
    import hashlib, io, urllib.request, zipfile
    sha = lambda b: hashlib.sha256(b).hexdigest()
    for a in assets:
        dst = os.path.join(adir, a['file'])
        if os.path.exists(dst) and sha(open(dst, 'rb').read()) == a['sha256']:
            continue
        print('  fetching %s from %s' % (a['file'], a['url']))
        data = urllib.request.urlopen(a['url'], timeout=300).read()
        if a.get('zipSha256') and sha(data) != a['zipSha256']:
            sys.exit('%s: download does not match its SHA-256' % a['url'])
        if a.get('zipMember'):
            data = zipfile.ZipFile(io.BytesIO(data)).read(a['zipMember'])
        if sha(data) != a['sha256']:
            sys.exit('%s: file does not match its SHA-256' % a['file'])
        open(dst, 'wb').write(data)


def build_ui(spec, language='en', hmi='ID7'):
    """screens/settings -> (application.xml, uiDescription.json, strings, screen meta) for hmi 'ID7' or 'ID8'
    (the same ids and names on both)"""
    id8 = hmi == 'ID8'
    app = spec['id']
    nid = Ids()
    strings = {sid(app, 'TITLE'): spec['title']}
    xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<application>']
    ui = {'schemaVersion': '1.3.0', 'containers': {}}
    screens = list(spec.get('screens', []))
    # a "menu" screen with "settings": true shows the settings itself: no separate settings screen
    if spec.get('settings') and not any(sc.get('settings') is True for sc in screens):
        screens.append({'name': 'SETTINGS', 'kind': 'settings', 'title': 'Settings'})
    state_ids = {}
    for scr in screens:
        state_ids[scr['name']] = None
    main_id = None

    def comp(kind, name, rows=None, extra_props=None, cells=None):
        ctype, widget, props = (WIDGETS8 if id8 else WIDGETS)[kind]
        cid = nid()
        p = dict(props)
        p.update(extra_props or {})
        if id8 and rows is not None:
            rows = [row8(r, ctype == 'button') for r in rows]
        x = [f'            <component id="{cid}" type="{ctype}"' + (f' widget="{widget}">' if widget else '>')]
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

    def settings_items(items):
        for s in spec['settings']:
            if s.get('hidden'):
                continue
            name = 'SET_' + s['key'].upper()
            if s['type'] == 'bool':
                row = text_row('SET_' + s['key'], s['label'])
                if id8:     # a row with the label and On / Off (the app writes it)
                    row = {'Text1stRow': row['Text'], 'Text2ndRow': {'value': '', 'type': 'Text'}}
                items.append(comp('checkbox', name, rows=[row]))
            elif s['type'] in ('choice', 'number'):
                # a drop-down with every value, as BMW's parking app settings: rows = options
                # (ItemText), HeaderText = the setting, SelectedItem = the chosen row (mgu.js sets it)
                values, labels = setting_options(s)
                if id8:
                    items.append(comp('tworow', name, rows=[{'Text1stRow': {'value': hmi_text(s['label']), 'type': 'Text'},
                                                            'Text2ndRow': {'value': '', 'type': 'Text'}}]))
                    continue
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
        # Translated builds with a credit file only: credit for the translation (localize.py keeps its title)
        if credit(language):
            name = credit_name(language)
            credit_title, credit_link = sid(app, name + '_TITLE'), sid(app, name + '_LINK')
            strings[credit_title], strings[credit_link] = credit(language)['settingsTitle'], credit(language)['settingsLink']
            items.append(comp('tworow', name, rows=[{
                'Text1stRow': {'value': credit_title, 'type': 'StringId'},
                'Text2ndRow': {'value': credit_link, 'type': 'StringId'},
            }]))
        # the project's own credit, last row
        repo_title, repo_link = sid(app, 'REPO_CREDITS_TITLE'), sid(app, 'REPO_CREDITS_LINK')
        strings[repo_title] = 'iDrive 7 custom apps'
        strings[repo_link] = 'GitHub cauliflowermossgrape · github.com/cauliflowermossgrape/idrive7-apps'
        items.append(comp('tworow', 'REPO_CREDITS', rows=[{
            'Text1stRow': {'value': repo_title, 'type': 'StringId'},
            'Text2ndRow': {'value': repo_link, 'type': 'StringId'},
        }]))

    for scr in screens:
        cid = nid()
        state_ids[scr['name']] = cid
        kind = scr.get('kind', 'list')
        # canvas = M Laptimer's state; menus = the state BMW uses for its
        # clickable lists (LT_State_Wide only renders a single text block)
        # settings: the wide state (full screen width), as BMW's own settings lists
        # menu: an app's own main menu (buttons, then its settings), in the same wide state
        widget = 'LT_State_Laptimer' if kind == 'canvas' else 'LT_State_Wide' if kind in ('settings', 'menu') else 'LT_State_Regular_ContentHidden'
        if id8:
            widget = STATE8
        cont = {'type': 'state', 'name': scr['name'], 'components': {}}
        x = [f'    <container id="{cid}" type="state" widget="{widget}">']
        # iDrive 8: no state has a parent (Hmi8 refuses a description with a parent that has one of its own,
        # and its BACK closes a parent with the state)
        if main_id is not None and scr.get('parent', True) and not id8:
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
            if bar and id8:
                items += bar
                nid()           # the Bar group's id on iDrive 7: every later id the same on both
            elif bar:
                groups.append(('Bar', bar))
        elif kind == 'settings':
            items = []
            settings_items(items)
            groups.append(('List', items))
        else:   # list / menu: components from "items" (a menu adds the settings after them)
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
            if kind == 'menu' and scr.get('settings'):
                settings_items(items)
            groups.append(('List', items))
        if id8 and main_id is None:
            mid = HMI8_MARK_ID
            groups[0][1].append((mid, [f'            <component id="{mid}" type="label" widget="LT_ScrollLabel">',
                                       '                <property id="2" value="0"/>', '                <property id="3" value="0"/>',
                                       '            </component>'],
                                 {'type': 'label', 'name': HMI8_MARK, 'properties': {'Visible': {'value': 0, 'type': 'UInt'},
                                  'Focusable': {'value': 0, 'type': 'UInt'}}, 'rows': [{'Text': {'value': '', 'type': 'Text'}}]}))
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


# The interface catalog BMW's installer checks an app's SOME/IP manifest against (on iDrive 7). The Store builds our
# apps on the head unit itself, where it is; elsewhere (a PC build) there is none and nothing is taken out.
UNIT_CATALOG = os.environ.get('MGU_SOMEIP_CATALOG', '/etc/oap/someip/someip-interfaces.json')


def fit_to_unit(manifest, spec, catalog=None):
    """Takes out of manifest (in place) what this unit's interface catalog lacks, so BMW's installer accepts the app:
    BMW's generator refuses the whole app for one field, method, broadcast or instance its firmware's version of an
    interface doesn't have, or a field asked for with an access it lacks (issue #145: "Requested field
    'statusBattery2' not found in interface CDS", "Requested read for statusBattery2 but no getter available").
    Of any interface: missing fields, methods, broadcasts and instances go, and a field's r / s / w goes without
    its getter / notifier / setter (the field with none left). An interface the unit lacks altogether goes when
    app.json marks it "_optional" (any other is left for the Store, which drops it, or the installer, which says
    so). An interface left with nothing to use, or with no instance, goes too. Returns {what is missing: what the app loses}, for kit/missing-interfaces.json;
    {} without a catalog."""
    path = catalog or UNIT_CATALOG
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding='utf-8') as f:
            db = json.load(f)
        have, instance_ids = db.get('interfaces'), db.get('instanceIDs')
    except (OSError, ValueError, AttributeError):
        return {}
    if not isinstance(have, dict) or not have:
        return {}
    if not isinstance(instance_ids, dict):
        instance_ids = None
    signals = spec.get('signals', {})
    reason = {i: f.get('_optional') for i, f in signals.items() if isinstance(f, dict) and f.get('_optional')}
    proxies = manifest['proxies']
    missing = {}

    def names(x):
        if isinstance(x, dict):
            return set(x)
        return {e.get('name') for e in (x or []) if isinstance(e, dict)}

    for iface in list(signals):
        entry = proxies.get(iface)
        if entry is None:
            continue
        unit = have.get(iface)
        if not isinstance(unit, dict):
            if iface in reason:
                del proxies[iface]
                missing[iface] = reason[iface]
            continue
        if not isinstance(entry, dict):
            continue
        gone = []
        # instances by name ('*' and the app's own '${userId}' are not looked up)
        inst = entry.get('instances')
        if instance_ids is not None and inst not in (None, '*'):
            known_inst = instance_ids.get(iface)
            asked = inst if isinstance(inst, list) else [inst]
            lost = [n for n in asked if '${' not in str(n) and not (isinstance(known_inst, dict) and known_inst.get(str(n)))]
            if lost:
                gone += ['instance ' + str(n) for n in lost]
                keep = [n for n in asked if n not in lost]
                if not keep:
                    del proxies[iface]
                    missing[iface + ': ' + ', '.join(gone)] = reason.get(iface) or 'these signals'
                    continue
                entry['instances'] = keep if isinstance(inst, list) else keep[0]
        # a field's access: r needs its getter, s its notifier, w its setter
        attrs = entry.get('attributes')
        if isinstance(attrs, dict):
            fields = unit.get('fields') if isinstance(unit.get('fields'), dict) else {}
            for n, mode in list(attrs.items()):
                f = fields.get(n)
                if not isinstance(f, dict) or not isinstance(mode, str):
                    continue
                left = ''.join(c for c in mode if {'r': 'getter', 's': 'notifier', 'w': 'setter'}.get(c, '') in f or c not in 'rsw')
                if left != mode:
                    gone.append('%s (%s)' % (n, ''.join(c for c in mode if c not in left)))
                    if left:
                        attrs[n] = left
                    else:
                        del attrs[n]
            if not attrs:
                del entry['attributes']
        for key, part in (('attributes', 'fields'), ('methods', 'methods'), ('broadcasts', 'events')):
            asked = entry.get(key)
            if not asked:
                continue
            known = names(unit.get(part))
            lost = [n for n in asked if n not in known]
            if not lost:
                continue
            gone += lost
            if isinstance(asked, dict):
                entry[key] = {n: v for n, v in asked.items() if n in known}
            else:
                entry[key] = [n for n in asked if n in known]
            if not entry[key]:
                del entry[key]
        if gone:
            missing[iface + ': ' + ', '.join(gone)] = reason.get(iface) or 'these signals'
            if not any(entry.get(k) for k in ('attributes', 'methods', 'broadcasts')):
                del proxies[iface]
    return missing


def make_icon(spec, out):
    src = os.path.join(APPS, spec['id'], 'icon.png')
    if os.path.exists(src):
        shutil.copy(src, out)
        return
    # rendered by the kit's own canvas (node) so no extra tooling is needed
    os.system(f'node "{os.path.join(HERE, "make_icon.js")}" "{spec.get("iconGlyph", spec["title"][:2])}" "{out}"')


WIDGET_COMPONENT_ID = 501


def build_start_widget(spec, app_id, icon_src, out, pkg_out=None):
    """app.json "startWidget" -> rhmiDataStartWidget/ (installed format), the home-screen widget.

    With pkg_out, also the package format inside source/ (application.json with uiDescriptions
    and variantGroups, like the package's rhmiData). MainApp's AppManagement installs it the way
    it installs rhmiData (its config "rhmiDataStartWidget": source -> installed, then
    mergeVariants), so an app installed through MainApp from the .tgz alone, as the MGU Store
    does, gets its widget too. VERIFIED on a G05 (2026-11-03): after a Store install the widget
    is in the home screen's widget list. deploy/mgu-app-install.sh still copies the installed
    format beside source/ from the .mgu, as before.

    Same shape as BMW's own widgets on this firmware (Drive Recorder, Weather, News): a logical
    container with one startWidget component whose "Widget" cell names an HMI layout template.
    MainApp finds the folder by itself and offers the widget in the home screen's widget list;
    the app fills each placed widget (one "spawn" per widget) at runtime (kit/runtime/mgu.js)."""
    sw = spec['startWidget']
    name = sw.get('name', spec['title'])
    comp = app_id.upper() + '_WIDGET'
    sid_name = sid(app_id, 'WIDGET_NAME')
    icon = app_id + '_widget_icon.png'
    wuuid = u(app_id, 'start-widget')
    shutil.rmtree(out, ignore_errors=True)
    for d in ('uiDescription', 'strings', 'resources'):
        os.makedirs(os.path.join(out, d))
    app_json = {'schemaVersion': '1.3.0', 'application': {
        'uuid': wuuid, 'type': 'StartWidget', 'name': app_id + '_widget', 'vendor': spec.get('vendor', 'custom'),
        'version': '1.0', 'defaultLanguage': 'en_GB',
        'stringBundleUuid': u(app_id, 'sw-strings'), 'resourceBundleUuid': u(app_id, 'sw-resources'), 'entryPoints': [],
        'entryPointsStringBundleUuid': u(app_id, 'sw-ep-strings'), 'entryPointsResourceBundleUuid': u(app_id, 'sw-ep-resources'),
        'externalDialogStringBundleUuid': u(app_id, 'sw-ed-strings'),
        'bookmarkUuidPool': [u(app_id, 'sw-bookmarks'), 1, 2, 3, 4, 5, 6, 7]}}
    json.dump(app_json, open(os.path.join(out, 'application.json'), 'w', encoding='utf-8', newline='\n'), separators=(',', ':'))
    xml = ('<?xml version="1.0" encoding="UTF-8"?>\n<application>\n'
           '    <container id="500" type="logical">\n        <layoutGroup id="502">\n'
           f'            <component id="{WIDGET_COMPONENT_ID}" type="startWidget">\n'
           f'                <property id="7" value="{wuuid}"/>\n'
           '            </component>\n        </layoutGroup>\n    </container>\n</application>\n')
    open(os.path.join(out, 'uiDescription', 'application.xml'), 'w', encoding='utf-8', newline='\n').write(xml)
    ui = {'schemaVersion': '1.3.0', 'containers': {'500': {'type': 'logical', 'name': 'startWidgetLogical', 'components': {
        str(WIDGET_COMPONENT_ID): {'type': 'startWidget', 'name': comp,
                                   'properties': {'UUID': {'value': wuuid, 'type': 'Text'}},
                                   'cells': {'Widget': {'value': sw.get('layout', 'LT_Table_OnlineApps_DriveRecorderWidget'), 'type': 'Text'},
                                             'SelectionName': {'value': sid_name, 'type': 'StringId'},
                                             'SelectionIcon': {'value': icon, 'type': 'ResourceId'}}}}}}}
    json.dump(ui, open(os.path.join(out, 'uiDescription', 'uiDescription.json'), 'w', encoding='utf-8', newline='\n'), indent=1)
    for lang in LANGS:
        json.dump({sid_name: name}, open(os.path.join(out, 'strings', lang + '.json'), 'w', encoding='utf-8', newline='\n'), ensure_ascii=False)
    shutil.copy(icon_src, os.path.join(out, 'resources', icon))
    if pkg_out:
        shutil.rmtree(pkg_out, ignore_errors=True)
        os.makedirs(os.path.join(pkg_out, 'uiDescriptions', 'ID7'))
        os.makedirs(os.path.join(pkg_out, 'variantGroups', 'Common', 'texts'))
        os.makedirs(os.path.join(pkg_out, 'variantGroups', 'Common', 'images'))
        a = app_json['application']
        pj = {'schemaVersion': app_json['schemaVersion'], 'application': {k: a[k] for k in (
            'uuid', 'type', 'name', 'vendor', 'version', 'defaultLanguage', 'stringBundleUuid', 'resourceBundleUuid', 'entryPoints')}}
        pj['application']['uiDescriptions'] = [{'applicationFilePath': './uiDescriptions/ID7/application.xml',
                                                'uiDescriptionFilePath': './uiDescriptions/ID7/uiDescription.json', 'hmi': ['ID7']}]
        pj['application']['variantGroups'] = [{'stringsPath': './variantGroups/Common/texts',
                                               'resourcesPath': './variantGroups/Common/images', 'hmi': ['ID7'], 'brands': ['BMW']}]
        json.dump(pj, open(os.path.join(pkg_out, 'application.json'), 'w', encoding='utf-8', newline='\n'), indent=2)
        open(os.path.join(pkg_out, 'uiDescriptions', 'ID7', 'application.xml'), 'w', encoding='utf-8', newline='\n').write(xml)
        json.dump(ui, open(os.path.join(pkg_out, 'uiDescriptions', 'ID7', 'uiDescription.json'), 'w', encoding='utf-8', newline='\n'), indent=1)
        for lang in LANGS:
            json.dump({sid_name: name}, open(os.path.join(pkg_out, 'variantGroups', 'Common', 'texts', lang + '.json'), 'w', encoding='utf-8', newline='\n'), ensure_ascii=False)
        shutil.copy(icon_src, os.path.join(pkg_out, 'variantGroups', 'Common', 'images', icon))
    return {'component': comp, 'layout': ui['containers']['500']['components'][str(WIDGET_COMPONENT_ID)]['cells']['Widget']['value']}


def build(app_id, language='en', preview_only=False):
    language = normalize_language(language)
    if not preview_only and not all(os.path.isfile(os.path.join(SDK, name)) for name in ('index.js', 'package.json')):
        raise SystemExit('BMW oap-sdk is missing. Extract it from your own head unit with kit/tools/extract_sdk.js, '
                         'or use --preview-only for an offline preview (no installable package).')
    adir = os.path.join(APPS, app_id)
    spec = json.load(open(os.path.join(adir, 'app.json'), encoding='utf-8'))
    spec = localize_spec(spec, language)
    spec.setdefault('id', app_id)
    ver = spec['version']
    stage = os.path.join(DIST, app_id)
    # The source folder may use display casing; keep the installed identity stable.
    app_id = spec['id']
    shutil.rmtree(stage, ignore_errors=True)
    src = os.path.join(stage, 'source')
    os.makedirs(os.path.join(src, 'javascript', 'kit'))
    os.makedirs(os.path.join(src, 'config'))
    os.makedirs(os.path.join(src, 'node_modules', 'oap-sdk'))

    manifest = manifest_for(json.loads(json.dumps(spec)))
    missing = fit_to_unit(manifest, spec)
    for what, loses in missing.items():
        print('  this unit has no %s - built without it: %s' % (what, loses))
    xml, uidesc, strings, state_ids = build_ui(spec, language)
    unicode_resources(uidesc, strings, language)
    xml8, uidesc8, strings8, state_ids8 = build_ui(spec, language, 'ID8')
    # its own slot names: the iDrive 7 description numbers more cells (the drop-downs' rows)
    unicode_resources(uidesc8, strings8, language, 'SID_CN_STATIC8_')
    assert state_ids8 == state_ids, 'iDrive 8 description must keep the iDrive 7 state ids'
    strings.update(strings8)
    if len(strings) > 1024:
        raise ValueError('HMI string bundle exceeds the verified 1024-resource budget (iDrive 7 + 8)')
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
    # app.json "autostart": the platform starts the app by itself (the Store's deploy tool lists it so); its
    # impl.background runs then, without screens
    if spec.get('autostart'):
        pkg['mguAppStartType'] = 'autostart'
    json.dump(pkg, open(os.path.join(src, 'package.json'), 'w', encoding='utf-8', newline='\n'), indent=2)
    json.dump(manifest, open(os.path.join(src, 'manifest.json'), 'w', encoding='utf-8', newline='\n'), indent=2)
    shutil.copy(os.path.join(KIT, 'platform', 'permissions.json'), os.path.join(src, 'permissions.json'))
    json.dump({'name': app_id, 'version': ver, 'lockfileVersion': 1}, open(os.path.join(src, 'npm-shrinkwrap.json'), 'w', encoding='utf-8', newline='\n'))
    # the SDK merges this over its own config. Newer SDKs (27.x, extracted from a newer donor app) build the app's
    # screens and entry point only with these on, and some donors ship them off: the app then has no screens and
    # crashed (issue #39). Older SDKs (24.x) ignore them.
    json.dump({'rhmiLoadingEnabled': True, 'entryPointLoadingEnabled': True, 'settings': {app_id: spec.get('config', {})}},
              open(os.path.join(src, 'config', 'base.json'), 'w', encoding='utf-8', newline='\n'), indent=2)
    # app code
    fetch_assets(adir, spec.get('assets', []))
    for f in os.listdir(adir):
        if f.endswith('.js'):
            shutil.copy(os.path.join(adir, f), os.path.join(src, 'javascript', 'app.js' if f == 'main.js' else f))
        elif f.endswith(('.wasm', '.wad')) or f in ('LICENSE', 'NOTICE'):
            # files the app reads as they are (doom: the game as WebAssembly, its data, its licences)
            shutil.copy(os.path.join(adir, f), os.path.join(src, 'javascript', f))
        elif os.path.isdir(os.path.join(adir, f)):
            # data folders go along as one compressed file, read with kit/runtime/pack.js
            # (e.g. dtc_scanner/dtc_db, the fault text database -> dtc_db.pack)
            raw, size, _ = pack_data.pack(os.path.join(adir, f), os.path.join(src, 'javascript', f + '.pack'))
            print('  %s/: %.1f MB packed to %.2f MB' % (f, raw / 1e6, size / 1e6))
        elif f.endswith('.pack') and not os.path.isdir(os.path.join(adir, f[:-5])):
            # a committed pack (e.g. dtc_scanner/dtc_db.pack); a local folder of the same name replaces it
            shutil.copy(os.path.join(adir, f), os.path.join(src, 'javascript', f))
            print('  %s (committed)' % f)
    # kit runtime
    if app_id == 'dtc_scanner' and language in ('zh-CN', 'ru'):
        module = 'build_diagnostic_zh' if language == 'zh-CN' else 'build_diagnostic_ru'
        catalog = __import__(module).catalog
        with tempfile.TemporaryDirectory(prefix='mgu-diagnostic-') as temporary:
            data = os.path.join(temporary, language + '.json')
            with open(data, 'w', encoding='utf-8', newline='\n') as file:
                json.dump(catalog(), file, ensure_ascii=False, separators=(',', ':'))
            pack_data.pack(temporary, os.path.join(src, 'javascript', 'diagnostic_i18n.pack'))
    kr = os.path.join(KIT, 'runtime')
    for f in os.listdir(kr):
        p = os.path.join(kr, f)
        if os.path.isdir(p):
            shutil.copytree(p, os.path.join(src, 'javascript', 'kit', f))
        else:
            shutil.copy(p, os.path.join(src, 'javascript', 'kit', f))
    if missing:
        # what fit_to_unit took out: the app logs it at each start (kit/runtime/mgu.js)
        json.dump(missing, open(os.path.join(src, 'javascript', 'kit', 'missing-interfaces.json'), 'w', encoding='utf-8', newline='\n'), indent=1)
    if app_id != 'redline':
        # Barlow is only the gear on Redline's HUD layouts: other apps don't carry its atlas
        for name in ('gear_barlow.json', 'OFL-Barlow.txt'):
            p = os.path.join(src, 'javascript', 'kit', 'fonts', name)
            if os.path.exists(p):
                os.remove(p)
    if language != 'ru':
        for name in ('ru.json', 'ru.tsv'):
            p = os.path.join(src, 'javascript', 'kit', 'locales', name)
            if os.path.exists(p):
                os.remove(p)
    if language != 'es':
        # the Spanish catalog only in Spanish packages: the others keep main's file set
        for name in ('es.json', 'es.tsv'):
            p = os.path.join(src, 'javascript', 'kit', 'locales', name)
            if os.path.exists(p):
                os.remove(p)
    if language == 'ru':
        shutil.copy(os.path.join(KIT, 'localization', 'fonts', 'cyrillic-ru.json'),
                    os.path.join(src, 'javascript', 'kit', 'fonts', 'cyrillic.json'))
    if language == 'es':
        # The Latin atlases with the Spanish letters added (kit/tools/bake_spanish.py); their own cacheKey
        # keeps them apart from an English app's atlases in the shared renderer.
        for name in ('label.json', 'bold.json', 'light.json', 'num.json'):
            shutil.copy(os.path.join(KIT, 'localization', 'fonts', 'es', name),
                        os.path.join(src, 'javascript', 'kit', 'fonts', name))
    if language == 'ko':
        # Korean and Chinese are separate fixed-language packages. Loading both large
        # atlases could fragment the renderer's two 1024x4096 glyph shelves.
        os.remove(os.path.join(src, 'javascript', 'kit', 'fonts', 'cjk.json'))
        for name in ('korean.json', 'OFL-NotoSansKR.txt'):
            shutil.copy(os.path.join(KIT, 'localization', 'fonts', name),
                        os.path.join(src, 'javascript', 'kit', 'fonts', name))
    if language == 'zh-CN':
        # Diagnostic glyphs are Chinese-only; keep the English runtime atlas intact.
        if app_id == 'dtc_scanner':
            shutil.copy(os.path.join(KIT, 'localization', 'fonts', 'diagnostic-zh-CN.json'),
                        os.path.join(src, 'javascript', 'kit', 'fonts', 'cjk.json'))
    if credit(language):
        # The translation credit in the installed entry code, as plain comments.
        entry = os.path.join(src, 'javascript', 'app.js')
        comment = ''.join('// %s\n' % line for line in credit(language)['comment'])
        with open(entry, 'rb') as file:
            body = file.read()
        with open(entry, 'wb') as file:
            file.write(comment.encode('utf-8') + body)
    rt_spec = {k: spec.get(k) for k in ('id', 'title', 'version', 'screens', 'settings', 'config', 'startWidget')}
    rt_spec['stateIds'] = state_ids
    json.dump(rt_spec, open(os.path.join(src, 'javascript', 'kit', 'app-spec.json'), 'w', encoding='utf-8', newline='\n'), indent=1)
    locale = {'language': language, 'strings': load_locale(language)}
    if credit(language):
        locale['credit'] = credit(language)['corner']
    json.dump(locale, open(os.path.join(src, 'javascript', 'kit', 'locale.json'), 'w', encoding='utf-8', newline='\n'), ensure_ascii=False)
    if preview_only:
        print('%s %s: offline preview in %s (NO SDK, NOT INSTALLABLE)' % (app_id, ver, stage))
        return
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
    os.makedirs(os.path.join(pr, 'variantGroups', 'Common', 'texts'))
    os.makedirs(os.path.join(pr, 'variantGroups', 'Common', 'images'))
    pj = json.loads(json.dumps(app_json))
    # MainApp installs the uiDescription and variantGroups for the HMI the car reports (ID7 / ID8)
    pj['application']['uiDescriptions'] = [{'applicationFilePath': './uiDescriptions/%s/application.xml' % h,
                                            'uiDescriptionFilePath': './uiDescriptions/%s/uiDescription.json' % h, 'hmi': [h]}
                                           for h in ('ID7', 'ID8')]
    pj['application']['variantGroups'] = [{'stringsPath': './variantGroups/Common/texts',
                                           'resourcesPath': './variantGroups/Common/images', 'hmi': ['ID7', 'ID8'], 'brands': ['BMW']}]
    json.dump(pj, open(os.path.join(pr, 'application.json'), 'w', encoding='utf-8', newline='\n'), indent=2)
    for h, x, d in (('ID7', xml, uidesc), ('ID8', xml8, uidesc8)):
        os.makedirs(os.path.join(pr, 'uiDescriptions', h))
        open(os.path.join(pr, 'uiDescriptions', h, 'application.xml'), 'w', encoding='utf-8', newline='\n').write(x)
        json.dump(d, open(os.path.join(pr, 'uiDescriptions', h, 'uiDescription.json'), 'w', encoding='utf-8', newline='\n'), indent=1)
    for lang in LANGS:
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
    if spec.get('startWidget'):
        info = build_start_widget(spec, app_id, os.path.join(ir, 'resources', icon), os.path.join(stage, 'rhmiDataStartWidget'),
                                  os.path.join(src, 'rhmiDataStartWidget'))
        print('  home-screen widget: %s (%s)' % (info['component'], info['layout']))

    # --- installer helpers + metadata ---
    shutil.copytree(os.path.join(KIT, 'tools', 'oapgen'), os.path.join(stage, 'oapgen'))
    meta = {'id': app_id, 'version': ver, 'title': spec['title'], 'native': NATIVE, 'kit': 1}
    # app.json signals with "_optional": "<what the app loses>": a unit without that interface
    # still installs the app, without it (deploy/mgu-app-install.sh says what is missing)
    optional = {i: f['_optional'] for i, f in spec.get('signals', {}).items() if isinstance(f, dict) and f.get('_optional')}
    if optional:
        meta['optional'] = optional
    json.dump(meta, open(os.path.join(stage, 'meta.json'), 'w', encoding='utf-8', newline='\n'), indent=1)

    # --- archives ---
    os.makedirs(DIST, exist_ok=True)
    bundle = os.path.join(DIST, f'{app_id}@{ver}.mgu')
    with gz_header_free(bundle) as gz, tarfile.open(fileobj=gz, mode='w') as tf:
        for n in ('meta.json', 'source', 'rhmiData', 'rhmiDataStartWidget', 'oapgen'):
            if os.path.exists(os.path.join(stage, n)):
                tf.add(os.path.join(stage, n), arcname=n)
    npm = os.path.join(DIST, f'{app_id}@{ver}.tgz')
    with gz_header_free(npm) as gz, tarfile.open(fileobj=gz, mode='w') as tf:
        tf.add(src, arcname='package')
    print(f'{app_id} {ver}: {os.path.relpath(bundle, ROOT)} ({os.path.getsize(bundle) // 1024} KiB), '
          f'{len(uidesc["containers"])} screens, states {state_ids}')


def gz_header_free(path):
    """A gzip stream whose header carries no clock time (mtime 0). The header holds 32 bits, so on a
    head unit whose clock is past 2106 (a car once showed 2179) every build failed.
    Use: with gz_header_free(p) as gz, tarfile.open(fileobj=gz, mode='w') as tf"""
    return gzip.GzipFile(path, 'wb', mtime=0)


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--language', type=normalize_language, choices=languages(), default='en',
                        help='UI language; Korean also accepts ko-KR, ko-kr and ko_KR, Spanish es-ES and es_ES')
    parser.add_argument('--preview-only', action='store_true', help='stage an offline preview without BMW SDK or installable archives')
    parser.add_argument('apps', nargs='*')
    args = parser.parse_args()
    ids = args.apps or sorted(d for d in os.listdir(APPS) if os.path.exists(os.path.join(APPS, d, 'app.json')))
    for i in ids:
        build(i, args.language, preview_only=args.preview_only)


if __name__ == '__main__':
    main()
