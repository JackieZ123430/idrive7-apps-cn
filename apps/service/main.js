'use strict';
/**
 * Service - the car's service requirements (BMW Condition Based Service, CBS), as the iDrive's own
 * "Vehicle status > Service requirements" shows them.
 *
 *   Source : the instrument cluster's KombiInterface_2 over SOME/IP (what the HMI itself reads):
 *            cbsDataServiceList - one entry per item: id, colour, name, distance and date (texts the
 *            car formats in its own language and units); cbsDataSBA - the summary (next service).
 *   Details: requestCBSServiceHint(id) - the item's service hint text, as the iDrive's detail view.
 *
 * Reset (setting "Service reset", off by default): the instrument cluster's own CBS reset over UDS,
 * byte for byte what the workshop tool's CBS_RESET job sends (taken from a reset on a G20 330e):
 *   which items may be reset : 22 10 02 -> 3 bytes per item: id, reason it is blocked (0 = none), reserve
 *   reset one item           : 2E 10 01  01 <id> 64 1F 8000 0F FF 0F 3F FF 00
 *                              (1 item, availability 100 %, service count +1, everything else unchanged:
 *                              the cluster works out the new date / distance itself)
 *   check                    : 22 10 01 -> 12 bytes per item: id, .., [5] availability %, [4]&0x1F count
 * Only brake fluid (0x03) and the vehicle check (0x64) - the items kept in the cluster that were tried -
 * and only when the cluster itself reports no reason against it. Where the renderer draws the cards
 * (mgu-render/1), a tap on an item (or "Details") opens its card: due date, time and distance left,
 * the car's hint, and Reset, then "Confirm reset" within 5 s. Elsewhere: select the item with
 * "Next item", press "Reset service", then "Reset service" again within 5 s to confirm.
 *
 * Extended from upstream aa7517f42bfb00577dc786723525cc2be10bdc94.
 * Read-only enrichment: KOMBI/DME/DSC CBS records, counters, intervals and raw diagnostics.
 * UDS field interpretations are candidates until verified for this car; native HMI values win.
 * Uses the upstream app.json unchanged (including its TASU permission and diagPage setting).
 * Enable "Diagnostics page" in Settings for paginated replies; "Read CBS" refreshes on demand.
 * Otherwise CBS is read at startup and 60 s after the last scan; explicit demo mode disables reads.
 * "CBS details" cycles through the extra card fields without crowding the native three-tile layout.
 * Engine (a page of its own): what the engine unit (DME 0x12, the B58 / B48 / B38 petrol engines) says about its
 * oil, spark plugs, hours and particulate filter, read with 0x22 as Live Data reads them (ENGINE below), on that
 * page at most once a minute; an engine unit that has none of them shows "--". A B47 / B57 diesel's unit (DDE,
 * told by its SGBD index) has its particulate filter's soot, ash, temperature, pressure and regenerations instead
 * (DIESEL below); while the filter is hotter than a drive makes it, a regeneration is likely running.
 * A V8 with two engine units (N63, S63, S68: kit/twin_dme.js, told by the same SGBD index): the oil, plugs
 * and hours are the master's (the whole engine's); each bank has its own particulate filter, so bank 2's soot comes
 * from the second unit (0x13) too.
 * HMI Polish letters use ASCII equivalents because the upstream font atlases lack Polish glyphs.
 * Raw diagnostic JSON preserves Unicode as escaped code units rather than unreadable glyphs.
 */
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { Diag, hex, NRC, replyTo } = require('./kit/diag');
const { DidReader } = require('./kit/dids');
const TwinDme = require('./kit/twin_dme');
const { fitText } = require('./kit/text-layout');
const { cardSheet } = require('./kit/sheet');
const { t: translate, getLanguage, plural } = require('./kit/i18n');
const fonts = require('./kit/fonts');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_RU_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const STATUS = ['', 'Due now', 'Due soon', 'OK', 'Due soon'];
/**
 * The car's due date ("09/2027", "09.2027", "15.09.2027", "2027-09") as { text: "September 2027",
 * left: "in 11 months" / "2 months overdue", months }; null for anything else.
 */
function parseDue(s, now) {
    s = String(s || '').trim();
    let m, d = null, mo, y;
    if ((m = /^(\d{4})\s*년\s*(\d{1,2})\s*월(?:\s*(\d{1,2})\s*일)?$/.exec(s))) { y = +m[1]; mo = +m[2]; d = m[3] ? +m[3] : null; }
    else if ((m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(s))) { d = +m[1]; mo = +m[2]; y = +m[3]; } else if ((m = /^(\d{1,2})[./-](\d{4})$/.exec(s))) { mo = +m[1]; y = +m[2]; } else if ((m = /^(\d{4})[./-](\d{1,2})$/.exec(s))) { y = +m[1]; mo = +m[2]; } else return null;
    if (mo < 1 || mo > 12) return null;
    now = now || new Date();
    const months = (y - now.getFullYear()) * 12 + (mo - 1 - now.getMonth());
    const n = Math.abs(months), unit = ' ' + plural(n, 'month', 'months');
    if (getLanguage() === 'ko') return {
        text: y + '년 ' + mo + '월' + (d ? ' ' + d + '일' : ''),
        left: months > 0 ? n + '개월 후' : months === 0 ? '이번 달' : n + '개월 초과',
        months,
    };
    if (getLanguage() === 'es') {
        const name = translate(MONTHS[mo - 1]).toLowerCase(); // "15 de septiembre de 2027", "septiembre de 2027"
        return {
            text: (d ? d + ' de ' : '') + name + ' de ' + y,
            left: months > 0 ? 'en ' + n + unit : months === 0 ? 'este mes' : n + unit + ' de retraso',
            months,
        };
    }
    const month = d && getLanguage() === 'ru' ? MONTHS_RU_GENITIVE[mo - 1] : translate(MONTHS[mo - 1]);
    return {
        text: (d ? d + ' ' : '') + month + ' ' + y,
        left: months > 0 ? translate('in') + ' ' + n + unit : months === 0 ? translate('this month') : n + unit + ' ' + translate('overdue'),
        months,
    };
}

const W = 1600, H = 520, PER_PAGE = 5;
const GO = '#2fd27a';
const KOMBI = 'de.bmw.infotainment.KombiInterface_2';
const COLORS = { DEFAULT: 0, RED: 1, YELLOW: 2, GREEN: 3, ORANGE: 4 };
const KOMBI_ECU = 0x60;
const RESETTABLE = { 0x03: 'Brake fluid', 0x64: 'Vehicle check' };
const CONFIRM_MS = 5000;
const CBS_NAMES = {
    0x01: 'Engine oil', 0x02: 'Front brake pads', 0x03: 'Brake fluid',
    0x05: 'Service Inclusive', 0x06: 'Rear brake pads', 0x07: 'Particulate filter (OPF/DPF)',
    0x08: 'State of Health', 0x0A: 'Spark / glow plugs', 0x0D: 'NOx additive',
    0x11: 'Visual inspection / vehicle check', 0x14: 'Delivery inspection', 0x15: 'Running-in check',
    0x17: 'Water filter', 0x20: 'Statutory vehicle inspection (HU)', 0x21: 'Emissions inspection (AU)',
    0x23: 'Transmission oil', 0x31: 'Tyres', 0x32: 'Clutch',
    0x33: 'Pedestrian-protection bonnet struts', 0x34: 'First-aid kit', 0x35: 'Tyre repair kit',
    0x36: 'Catalytic converter', 0x37: 'Shock absorbers', 0x64: 'Vehicle check',
};
const CBS_SOURCES = [
    { address: KOMBI_ECU, name: 'KOMBI', dids: [0x1001, 0x1002] },
    { address: 0x12, name: 'DME', dids: [0x1001, 0x1002, 0x1003] },
    { address: 0x29, name: 'DSC', dids: [0x1001] },
];
const CBS_REFRESH_MS = 60000;
// the engine unit's wear values (DME8FF_R: B58 / B48 / B38), as Live Data reads them (apps/live_data/useful.js
// "Oil", "Wear and service"; layouts from its builtin DME8FF_R catalog); kit/dids.js candidates, first that answers
const ENGINE_REFRESH_MS = 60000;
// (the identifiers of both units of a twin-unit engine are the master's, its SGBD pair's)
const ENGINE = {
    oilHours: [{ did: '411A', bytes: 2, at: 0, factor: 1 / 512, min: 0, max: 120 }],          // oil life left by engine hours, %
    oilFuel: [{ did: '411A', bytes: 2, at: 2, factor: 1 / 512, min: 0, max: 120 }],           // by fuel used, %
    oilEngineH: [{ did: '411A', bytes: 4, at: 4, factor: 1 / 3600, min: 0, max: 100000 }],    // engine hours on this oil (s)
    oilKm: [{ did: '4404', bytes: 2, factor: 10, min: 0, max: 655350 }],                       // distance on this oil
    plugsLeft: [{ did: '4163', bytes: 2, at: 4, factor: 100, signed: true, min: 1, max: 300000 },
        { did: '5489', bytes: 2, factor: 100, signed: true, min: 1, max: 300000 }],           // spark plugs: distance left (0 = none)
    plugsDriven: [{ did: '4163', bytes: 4, at: 6, min: 0, max: 2000000 }],                     // spark plugs: distance driven
    engineHours: [{ did: '583D', bytes: 2, factor: 0.1, min: 0, max: 7000 }],                  // engine operating hours (6 min steps)
    soot: [{ did: '5444', bytes: 2, factor: 0.01, signed: true, min: 0, max: 200 },
        { did: '5774', bytes: 2, factor: 0.001, signed: true, min: 0, max: 30 }],             // particulate filter soot, g
    opfLoad: [{ did: '558C', bytes: 2, factor: 0.001, signed: true, min: 0, max: 30 }],        // its adapted total load
    opfAsh: [{ did: '558B', bytes: 2, factor: 0.001, signed: true, min: 0, max: 30 }],         // its adapted ash
};
// a B47 / B57 diesel's engine unit (DDE D70BX7A0 / D75BX7A0 / D83BX7C0, their SGBD indexes in DDE_INDEXES): its
// particulate filter, from those SGBDs' identifiers
const DDE_INDEXES = ['0F1F70', '0F1F80', '0F1F90', '0F1FA0', '0F1FE8', '0F1FF0', '0F1FF4', '0F1FF8', '0F2670', '0F2674', '0F2678', '0F267C'];
const DIESEL = {
    soot: [{ did: '44BE', bytes: 2, factor: 0.01525902, min: 0, max: 200 }],                  // soot in the filter, g
    ash: [{ did: '44BD', bytes: 2, factor: 0.01525902, min: 0, max: 1000 }],                  // oil ash in it, g
    dpfTemp: [{ did: '4502', bytes: 2, factor: 0.03128099, offset: -50, min: -40, max: 1000 }], // before the filter, °C
    dpfDp: [{ did: '44ED', bytes: 2, factor: 0.04577707, offset: -1000, min: -200, max: 1000 }], // pressure across it, hPa
    regens: [{ did: '44B8', bytes: 2, min: 0, max: 65000 }],                                  // successful regenerations
    sinceKm: [{ did: '44BF', bytes: 4, factor: 0.001, min: 0, max: 100000 }],                 // distance since the last
    sinceH: [{ did: '44B7', bytes: 4, factor: 1 / 3600, min: 0, max: 10000 }],                // engine time since it
    sinceL: [{ did: '44BC', bytes: 2, factor: 0.01, min: 0, max: 600 }],                      // fuel since it, l
    avgKm: [{ did: '44C7', bytes: 2, min: 0, max: 65000 }],                                   // average distance between
};
const REGEN_TEMP = 500;       // °C before the filter: above what driving alone makes, a regeneration is likely running
const ENGINE_DEMO = { oilHours: 64, oilFuel: 58, oilEngineH: 142, oilKm: 7830, plugsLeft: 41200, plugsDriven: 18800,
    engineHours: 1384, soot: 6.4, opfLoad: 0.312, opfAsh: 0.041 };
const CBS_RECORD_SIZE = 12;
const CBS_TECHNICAL_IDS = [0xE0, 0xE1, 0xFF];
const bytesText = (a) => Array.from(a, (b) => hex(b)).join(' ');
const recordKey = (r) => hex(r.address) + ':' + hex(r.id);
const readKey = (address, did) => hex(address) + ':' + hex(did, 4);
const cbsName = (id) => CBS_NAMES[id] || 'CBS 0x' + hex(id);
const CBS_STATUS = ['OK', 'Substitute value', 'OK (modular)', 'Substitute value (modular)', 'Manipulated data'];
const valueText = (v, suffix) => v === null || v === undefined ? '--' : String(v) + (suffix || '');

function decodeCbs(data, source) {
    if (data.length % CBS_RECORD_SIZE) throw new Error('CBS 1001: invalid payload length ' + data.length);
    const records = [];
    for (let i = 0; i < data.length; i += CBS_RECORD_SIZE) {
        const b = data.slice(i, i + CBS_RECORD_SIZE);
        const rawRemaining = (b[1] << 8) | b[2], unitCode = b[3] & 15;
        const unit = ['%', 'km', 'days'][unitCode] || null;
        let remaining = rawRemaining === 0x8000 || rawRemaining === 0x7FFF || !unit
            ? null : rawRemaining >= 0x8000 ? rawRemaining - 0x10000 : rawRemaining;
        if (remaining !== null && unit === 'km') remaining *= 10;
        const month = b[7] & 15, statusCode = b[3] >> 4;
        records.push({
            id: b[0], address: source.address, source: source.name, raw: bytesText(b),
            remaining, unit, status: CBS_STATUS[statusCode] || 'Unknown 0x' + hex(statusCode),
            count: b[4] & 31, avail: b[5] <= 150 ? b[5] : null,
            intervalKm: b[6] > 0 && b[6] < 255 ? b[6] * 1000 : null,
            date: month >= 1 && month <= 12 ? String(month).padStart(2, '0') + '/' + (2000 + (b[8] & 31)) : '',
            intervalMonths: b[9] > 0 && b[9] < 255 ? b[9] : null,
        });
    }
    return records;
}

function preferredRecord(records, id) {
    const owner = [0x01, 0x07, 0x0A, 0x0D, 0x23].includes(id) ? 0x12
        : [0x02, 0x06].includes(id) ? 0x29 : KOMBI_ECU;
    const matches = records.filter((r) => r.id === id);
    return matches.find((r) => r.address === owner) || (matches.length === 1 ? matches[0] : null);
}

const SHOW_UDS_ONLY = false;

function mergeCbs(native, records) {
    const result = native.map((it) => Object.assign({}, it, {
        key: 'hmi:' + it.id, record: preferredRecord(records, it.id), native: true,
    }));
    // UDS-only records (not a service requirement the HMI lists, e.g. the particulate filter) stay off the
    // list: their fields aren't verified for the car. They are still on the Diagnostics page.
    if (!SHOW_UDS_ONLY) return result;
    records.forEach((r) => {
        if (CBS_TECHNICAL_IDS.includes(r.id) || native.some((it) => it.id === r.id)
            || result.some((it) => it.id === r.id && it.record === preferredRecord(records, r.id))) return;
        const chosen = preferredRecord(records, r.id);
        if (chosen && chosen !== r) return;
        result.push({
            key: recordKey(r), id: r.id, name: cbsName(r.id) + ' [UDS]', colour: 0,
            way: r.unit === 'km' ? valueText(r.remaining, ' km') : '',
            date: r.date, record: r, native: false,
        });
    });
    return result;
}

/**
 * the object holding `key` somewhere inside v (unions arrive wrapped in their member's name). With
 * str: only where that key is a text - the hint answer nests { cBSServiceHint: { cBSServiceHint: "..." } }
 */
function find(v, key, str) {
    if (!v || typeof v !== 'object') return null;
    if (key in v && (!str || typeof v[key] === 'string')) return v;
    for (const k of Object.keys(v)) { const r = find(v[k], key, str); if (r) return r; }
    return null;
}
/** JSON without icons, with lossless Unicode escapes for the ASCII-only diagnostic font. */
const brief = (v) => JSON.stringify(v, (k, x) => (k === 'symbolData' ? '[icon]' : x))
    .replace(/[^\x20-\x7e]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
const colour = (c) => (typeof c === 'number' ? c : COLORS[String(c)] !== undefined ? COLORS[String(c)] : 0);
const HMI_ASCII = {
    'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue', 'ß': 'ss',
    '\u0105': 'a', '\u0107': 'c', '\u0119': 'e', '\u0142': 'l', '\u0144': 'n',
    '\u00f3': 'o', '\u015b': 's', '\u017a': 'z', '\u017c': 'z',
    '\u0104': 'A', '\u0106': 'C', '\u0118': 'E', '\u0141': 'L', '\u0143': 'N',
    '\u00d3': 'O', '\u015a': 'S', '\u0179': 'Z', '\u017b': 'Z',
    '\u00a0': ' ', '\u202f': ' ',
};
const txt = (s) => String(s === undefined || s === null ? '' : s).normalize('NFC')
    .replace(/[^\x20-\x7e]/g, (ch) => HMI_ASCII[ch] || ch)
    .replace(/[\x00-\x1f\x7f]/g, '').trim();

/*
 * Texts the fonts cannot draw. The car words the items in the iDrive's language; for a language the baked fonts
 * have no glyphs for (Korean, ...) every character would be drawn as "?", and some cars send such texts as "?"
 * already. Those texts are not shown: an item's name becomes its English name by CBS id (translated as the
 * app's own texts are), a distance or date keeps its numbers, a hint is left out. Texts the fonts can draw
 * (English, German, the Chinese and Russian builds' own glyphs) are shown as the car sends them.
 */
const NAMES = {
    0x01: 'Engine oil', 0x02: 'Front brakes', 0x03: 'Brake fluid', 0x06: 'Rear brakes', 0x11: 'Vehicle check',
    0x20: 'Statutory vehicle inspection', 0x21: 'Exhaust emissions test', 0x64: 'Vehicle check',
};
/** every character of s is in the font that would draw it */
const drawable = (s) => {
    const f = fonts.get('bold', 30, s);
    return !!f && Array.from(s).every((ch) => f.glyphs[ch.codePointAt(0)]);
};
/** a car text that can be shown: drawable and not already broken ("?" / U+FFFD for a lost character) */
const usable = (s) => !!s && drawable(s) && !/[?\ufffd]/.test(s);
const nameOf = (id, s) => (usable(s) ? s : NAMES[id] || 'Service item ' + id);
/** a distance or date the fonts cannot draw: its numbers ("2027년 9월" -> "09/2027", which parseDue reads) */
const value = (s) => {
    if (!s || drawable(s)) return s;
    const ym = s.match(/(\d{4})\D+(\d{1,2})(?!\d)/), my = s.match(/(?:^|\D)(\d{1,2})\D+(\d{4})/);
    if (ym) return ym[2].padStart(2, '0') + '/' + ym[1];
    if (my) return my[1].padStart(2, '0') + '/' + my[2];
    return Array.from(s).filter((ch) => drawable(ch)).join('').replace(/\s+/g, ' ').trim();
};
/** the code points of a text the fonts cannot draw, for the log (what the car really sent) */
const codes = (s) => String(s).replace(/[^\x20-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

const DEMO = {
    list: [
        { id: 1, colour: 3, name: 'Engine oil', way: '12 300 km', date: '09/2027' },
        { id: 2, colour: 3, name: 'Front brakes', way: '21 800 km', date: '' },
        { id: 6, colour: 3, name: 'Rear brakes', way: '38 500 km', date: '' },
        { id: 3, colour: 2, name: 'Brake fluid', way: '', date: '11/2026' },
        { id: 17, colour: 3, name: 'Vehicle check', way: '9 800 km', date: '11/2027' },
        { id: 32, colour: 3, name: 'Statutory vehicle inspection', way: '', date: '05/2028' },
    ],
    sba: { text: 'Engine oil', way: '12 300 km', date: '09/2027', colour: 3 },
};

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const sig = ctx.signals;
        let list = null, sba = null, rawList = '', rawSba = '';
        let kombi = null, sel = 0, page = 0, msg = '', hint = null, version = 0;
        let diagInit = null, scanBusy = false, scanAt = null, scanMessage = 'Not read yet', diagPage = 0, diagPageCount = 1;
        const cbsReads = new Map();
        const liveRecords = () => Array.from(cbsReads.values())
            .filter((r) => r.did === 0x1001 && r.state === 'ok').reduce((a, r) => a.concat(r.records), []);
        const changed = () => { version++; };
        /** the summary's name: that of the list item the car words the same way (one item, or items of one name) */
        const sbaName = (text) => {
            const names = Array.from(new Set((text ? list || [] : []).filter((i) => i.carName === text).map((i) => i.name)));
            return names.length === 1 ? names[0] : usable(text) ? text : '';
        };
        const useDemo = () => settings.get('demo') === 'on'
            || (settings.get('demo') === 'auto' && !list && !sba && !liveRecords().length);

        /* ---------- reading ---------- */
        sig.watch(KOMBI, '1', {
            cbsDataServiceList: (v) => {
                rawList = brief(v);
                const arr = Array.isArray(v) ? v : (v && (v.cbsDataServiceList || v.value)) || [];
                list = arr.map((e) => {
                    const s = find(e, 'cBSIdentifier') || {};
                    const name = txt(s.cBSServcieName || s.cBSServiceName);
                    return { id: s.cBSIdentifier, colour: colour(s.cBSColor), name: nameOf(s.cBSIdentifier, name), carName: name,
                        way: value(txt(s.cBSServiceWay)), date: value(txt(s.cBSServiceDate)) };
                }).filter((e) => e.id !== undefined && e.carName);
                const unusable = list.filter((i) => !usable(i.carName));
                log.info('service list: ' + list.length + ' item(s)' + (unusable.length ? ', shown by id: '
                    + unusable.map((i) => i.id + ' ' + codes(i.carName)).join(' | ') : ''));
                if (sba) sba.text = sbaName(sba.carText);       // the summary came before the list
                changed();
            },
            cbsDataSBA: (v) => {
                rawSba = brief(v);
                const s = find(v, 'cBSDataSBAText') || {};
                const text = txt(s.cBSDataSBAText);
                sba = { carText: text, text: sbaName(text), way: value(txt(s.cBSDataSBADistance)),
                    date: value(txt(s.cBSDataSBADate)), colour: colour(s.cBSDataSBAColor) };
                changed();
            },
        }, log, { pollMs: 60000 }).then((r) => {
            kombi = r;
            if (r.error) log.warn('KombiInterface_2: ' + r.error);
        });

        const items = () => mergeCbs(useDemo() ? DEMO.list : list || [], useDemo() ? [] : liveRecords());
        const summary = () => (useDemo() ? DEMO.sba : sba);

        /* ---------- details (the iDrive's detail view) ---------- */
        async function details() {
            const it = items()[sel];
            if (!it) return;
            hint = { name: it.name, text: 'Asking the car...' };
            changed();
            try {
                if (useDemo()) {
                    hint.text = 'Service due ' + [it.way && translate('in') + ' ' + it.way, it.date && translate('by') + ' ' + it.date].filter(Boolean).join(' ' + translate('or') + ' ') + ' (demo)';
                    changed();
                    return;
                }
                if (!it.native) {
                    hint.text = 'Read-only UDS record; fields need validation for this car. No native service hint.';
                    changed();
                    return;
                }
                if (!kombi || !kombi.proxy) throw new Error('instrument cluster not reachable');
                const r = await sig.call(kombi.proxy, 'requestCBSServiceHint', { id: it.id }, 6000);
                const h = find(r, 'cBSServiceHint', true) || {};
                const ht = txt(h.cBSServiceHint);
                hint.text = [usable(ht) ? ht : '', value(txt(h.cBSServiceWay)), value(txt(h.cBSServiceDate))]
                    .filter(Boolean).join('   ') || 'No details for this item';
                log.info('hint ' + it.id + ': ' + brief(r));
            } catch (e) {
                log.warn('requestCBSServiceHint ' + it.id + ': ' + e);
                hint.text = 'Details not available (' + (e.message || e) + ')';
            }
            changed();
        }

        /* ---------- reset (the cluster's own CBS reset, see the top of this file) ---------- */
        let diag = null, reset = null;          // reset: { items: [{id, name}], i, at, busy }
        const showMsg = (s) => { hint = null; msg = s; log.info("msg: " + s); changed(); };
        const nrc = (r) => (r && r[0] === 0x7F ? 'refused: ' + (NRC[r[2]] || '0x' + hex(r[2])) : 'no answer from the instrument cluster');
        async function link() {
            if (!diagInit) {
                diag = new Diag(sig, log);
                diagInit = diag.init().then(() => {
                    if (!diag.p) throw new Error(diag.error || 'TASU not available');
                }).catch((e) => { diagInit = null; throw e; });
            }
            await diagInit;
            if (!diag.p) throw new Error('no diagnostic link (' + (diag.error || 'not available') + ')');
            return diag;
        }
        async function refreshCbs() {
            if (scanBusy || reset || settings.get('demo') === 'on') return;
            scanBusy = true; scanMessage = 'Reading CBS (read-only)...'; changed();
            try {
                const d = await link();
                for (const source of CBS_SOURCES) {
                    for (const did of source.dids) {
                        if (settings.get('demo') === 'on') { scanMessage = 'CBS read stopped (demo enabled)'; return; }
                        const entry = { address: source.address, source: source.name, did, records: [], raw: '', state: 'reading', at: null };
                        cbsReads.set(readKey(source.address, did), entry);
                        scanMessage = 'Reading ' + source.name + ' 22 ' + hex(did, 4); changed();
                        try {
                            const data = [did >> 8, did & 255];
                            const r = await d.physical(source.address, 0x22, data, 5000, replyTo(0x22, data));
                            entry.at = Date.now();
                            entry.raw = r ? bytesText(r) : '';
                            if (!r) throw new Error('No reply / timeout');
                            if (r[0] === 0x7F) throw new Error('NRC 0x' + hex(r[2]) + ': ' + (NRC[r[2]] || 'unknown refusal'));
                            if (r.length < 3 || r[0] !== 0x62 || r[1] !== data[0] || r[2] !== data[1]) {
                                throw new Error('Unexpected UDS reply');
                            }
                            const payload = Array.from(r.slice(3));
                            if (did === 0x1001) entry.records = decodeCbs(payload, source);
                            if (did === 0x1002 && payload.length % 3) throw new Error('CBS 1002: invalid payload length');
                            entry.state = 'ok';
                        } catch (e) {
                            entry.state = 'error'; entry.error = e.message || String(e);
                            log.warn(source.name + ' ' + hex(did, 4) + ': ' + entry.error);
                        }
                        changed();
                    }
                }
                const failed = Array.from(cbsReads.values()).filter((r) => r.state === 'error').length;
                scanMessage = 'CBS read complete' + (failed ? ' - ' + failed + ' read(s) failed; see below' : '');
            } catch (e) {
                scanMessage = 'CBS read failed: ' + (e.message || e);
                cbsReads.forEach((r) => { r.state = 'error'; r.error = scanMessage; });
                log.warn(scanMessage);
            } finally {
                scanAt = Date.now(); scanBusy = false; changed();
            }
        }
        /** the cluster's CBS record: { id: {avail, count} } */
        async function readCbs(d) {
            const r = await d.physical(KOMBI_ECU, 0x22, [0x10, 0x01], 5000, replyTo(0x22, [0x10, 0x01]));
            if (!r || r[0] !== 0x62) throw new Error(nrc(r));
            const out = {};
            for (let i = 3; i + 12 <= r.length; i += 12) out[r[i]] = { avail: r[i + 5], count: r[i + 4] & 0x1F };
            return out;
        }
        /** "Reset service": the first press asks the cluster and arms the reset of the selected item; a
         *  second press within 5 s confirms it. Anything else (Next item, Details) disarms it. */
        async function resetPress() {
            if (settings.get('resetOn') !== true) return showMsg('Reset is off - turn on "Service reset" in Settings');
            if (useDemo()) return showMsg('No reset in demo mode');
            if (scanBusy) return showMsg('CBS read in progress - wait before resetting');
            if (reset && reset.busy) return;
            if (reset && reset.item && Date.now() - reset.at < CONFIRM_MS) return doReset();
            const its = items(), cur = its[sel];
            if (!cur || !cur.native || !RESETTABLE[cur.id]) return showMsg('Reset is limited to native brake fluid and vehicle check items');
            reset = { busy: true };
            showMsg('Asking the instrument cluster what can be reset...');
            try {
                const d = await link();
                const r = await d.physical(KOMBI_ECU, 0x22, [0x10, 0x02], 5000, replyTo(0x22, [0x10, 0x02]));
                if (!r || r[0] !== 0x62) throw new Error(nrc(r));
                const ok = [];
                for (let i = 3; i + 3 <= r.length; i += 3) {
                    if (RESETTABLE[r[i]] && r[i + 1] === 0) ok.push(r[i]);
                }
                log.info('resettable: ' + ok.map((x) => hex(x)).join(',') + ' (reply ' + r.map((x) => hex(x)).join(' ') + ')');
                if (!ok.length) { reset = null; return showMsg('The instrument cluster allows no reset right now'); }
                const id = ok.includes(cur.id) ? cur.id : null;
                if (id === null) {
                    reset = null;
                    return showMsg('Select ' + ok.map((x) => RESETTABLE[x]).join(' or ') + ' with "Next item", then "Reset service"');
                }
                const name = (cur && cur.id === id && cur.name) || RESETTABLE[id];
                reset = { item: { id, name }, at: Date.now(), busy: false };
                showMsg('Reset ' + name + '?  Press ' + (ctx.display.sheet ? '"Confirm reset"' : '"Reset service" again') + ' to confirm (5 s)');
            } catch (e) {
                reset = null;
                log.warn('reset list: ' + e);
                showMsg('Reset not available: ' + (e.message || e));
            }
        }
        async function doReset() {
            const it = reset.item;
            reset.busy = true;
            showMsg('Resetting ' + it.name + '...');
            try {
                const d = await link();
                const before = (await readCbs(d).catch(() => ({})))[it.id];
                const r = await d.physical(KOMBI_ECU, 0x2E,
                    [0x10, 0x01, 0x01, it.id, 0x64, 0x1F, 0x80, 0x00, 0x0F, 0xFF, 0x0F, 0x3F, 0xFF, 0x00], 6000,
                    replyTo(0x2E, [0x10, 0x01]));
                log.info('reset ' + it.name + ': ' + (r ? r.map((x) => hex(x)).join(' ') : 'no reply'));
                if (!r || r[0] !== 0x6E) throw new Error(nrc(r));
                const after = (await readCbs(d).catch(() => ({})))[it.id];
                showMsg(it.name + ' reset' + (after ? ': ' + after.avail + ' %' + (before ? ', service ' + before.count + ' -> ' + after.count : '') : '')
                    + ' - the list updates within a minute');
            } catch (e) {
                log.warn('reset ' + it.name + ': ' + e);
                showMsg(it.name + ' NOT reset: ' + (e.message || e));
            } finally {
                reset = null;
                scanAt = null;
            }
        }

        /* ---------- an item's card (drawn by the renderer over the page, kit sheet) ---------- */
        function openCard(i) {
            const it = items()[i];
            if (!it) return false;
            sel = i;
            hint = null; msg = '';
            reset = reset && reset.busy ? reset : null;
            let cardPage = 0;
            const current = () => items().find((item) => item.key === it.key)
                || Object.assign({}, it, { record: null, way: '', date: '' });
            const card = cardSheet({
                title: it.name,
                heading: it.name,
                subtitle: () => cardPage ? 'UDS candidate fields - validate for this car'
                    : it.native ? STATUS[it.colour] || '' : 'UDS only - not a native service requirement',
                color: () => [null, '#ef2b2d', '#ffb020', GO, '#ffb020'][it.colour] || null,
                rows: () => {
                    const item = current(), r = item.record, due = parseDue(item.date);
                    if (cardPage === 1) return [
                        ['Service counter*', r ? String(r.count) : '--'],
                        ['Availability*', r ? valueText(r.avail, ' %') : '--'],
                        ['Source', r ? r.source + ' 0x' + hex(r.address) : 'Not read / unavailable'],
                    ];
                    if (cardPage === 2) return [
                        ['Distance interval*', r ? valueText(r.intervalKm, ' km') : '--'],
                        ['Time interval*', r ? valueText(r.intervalMonths, ' months') : '--'],
                        ['Remaining*', r ? valueText(r.remaining, r.unit ? ' ' + r.unit : '') : '--'],
                    ];
                    if (cardPage === 3) return [
                        ['Record status*', r ? r.status : '--'],
                        ['UDS due date*', r ? r.date || '--' : '--'],
                        ['CBS identifier', '0x' + hex(item.id)],
                    ];
                    return [
                        ['Due by', due ? due.text : item.date || '--', due && due.months < 0 ? '#ef2b2d' : null],
                        due ? ['Time left', due.left] : null,
                        ['Distance left', item.way || '--'],
                    ];
                },
                note: () => msg || (cardPage ? '* Candidate decoding; see Diagnostics for all ECU records and raw bytes.'
                    : (hint && hint.text) || ''),
                actions: () => [{
                    label: 'CBS details ' + (cardPage + 1) + '/4',
                    run: () => { cardPage = (cardPage + 1) % 4; changed(); return null; },
                }, {
                    label: scanBusy ? 'Reading...' : 'Read CBS',
                    run: () => { refreshCbs(); return null; },
                }].concat(it.native && RESETTABLE[it.id] ? [{
                    label: reset && reset.item && reset.item.id === it.id && !reset.busy ? 'Confirm reset' : 'Reset',
                    color: reset && reset.item && reset.item.id === it.id ? '#ef2b2d' : null,
                    run: () => { resetPress(); return null; },
                }] : []),
            });
            card.onClose = () => { hint = null; msg = ''; reset = reset && reset.busy ? reset : null; changed(); };
            if (!ctx.sheet(card)) return false;
            details();
            return true;
        }

        /* ---------- the engine unit's wear values (Engine page) ---------- */
        const engine = { values: {}, at: null, busy: false, error: '', kind: null, twin: false };
        let engineReader = null;
        /* 'diesel' for a B47 / B57 DDE (its SGBD index, 22 F150), 'petrol' for another unit, null without a reply */
        async function engineKind(d) {
            // only its answer: a refusal names no identifier, and every app gets every frame (another app's refusal
            // would end the wait and leave a V8 without its bank 2; a unit that refuses gives null either way)
            const ok = (u) => u[0] === 0x62 && u[1] === 0xF1 && u[2] === 0x50;
            const u = await d.physical(0x12, 0x22, [0xF1, 0x50], 4000, ok).catch(() => null);
            if (!u || u[0] !== 0x62 || u.length < 6) return null;
            const index = [u[3], u[4], u[5]].map((x) => hex(x)).join('').toUpperCase();
            engine.twin = TwinDme.isTwinIndex(index);
            log.info('engine unit: SGBD index ' + index + (engine.twin ? ' (two engine units: bank 2 at 0x13)' : ''));
            return DDE_INDEXES.indexOf(index) >= 0 ? 'diesel' : 'petrol';
        }
        async function readEngine(force) {
            if (engine.busy || useDemo() || (!force && engine.at && Date.now() - engine.at < ENGINE_REFRESH_MS)) return;
            engine.busy = true; changed();
            try {
                const d = await link();
                engineReader = engineReader || new DidReader(d, { ecu: 0x12 });
                if (!engine.kind) engine.kind = await engineKind(d);
                const set = engine.kind === 'diesel' ? DIESEL : ENGINE;
                engine.values = {};
                for (const k of Object.keys(set)) engine.values[k] = await engineReader.value(k, set[k]);
                // bank 2's particulate filter on a twin-unit engine: the second unit's soot
                if (engine.twin && set === ENGINE) engine.values.soot2 = await engineReader.value('soot2', ENGINE.soot.map((c) => Object.assign({}, c, { ecu: TwinDme.SLAVE })));
                engine.error = Object.keys(set).some((k) => engine.values[k] !== null) ? '' : 'the engine unit has none of these values';
            } catch (e) {
                engine.error = String(e.message || e);
            }
            engine.at = Date.now(); engine.busy = false; changed();
        }

        /* ---------- drawing ---------- */
        const pages = () => ['Service', 'Engine'].concat(settings.get('diagPage') ? ['Diagnostics'] : []);
        const pageName = () => pages()[page];
        const COL = (t, c) => [t.dim, t.crit, t.warn, GO, t.warn][c] || t.dim;
        const LBL = ['', 'DUE NOW', 'DUE SOON', 'OK', 'DUE SOON'];

        function tile(cv, t, x, w, label, value, sub, col) {
            G.panel(cv, t, x, 44, w, 115, label);
            cv.text(value, x + 18, 142, 44, col, { font: 'num' });
            if (sub) cv.text(sub, x + w - 18, 142, 22, t.dim, { align: 'right' });
        }

        function fit(cv, s, size, max, opt) {
            return fitText(cv, s, size, max, opt);
        }

        function drawMain(cv, t, its) {
            const s = summary();
            const red = its.filter((i) => i.colour === 1).length, soon = its.filter((i) => i.colour === 2 || i.colour === 4).length;
            tile(cv, t, 24, 760, 'Next service', s ? s.way || s.date || '--' : '--', s ? fit(cv, s.text, 22, 380) : 'waiting for the car', s ? COL(t, s.colour) : t.dim);
            tile(cv, t, 804, 374, 'Due soon', String(soon), plural(soon, 'items', 'items'), soon ? t.warn : GO);
            tile(cv, t, 1198, 378, 'Due now', String(red), plural(red, 'items', 'items'), red ? t.crit : GO);
            // room below the page (where the kit gives it): another row where one fits whole (the rows stay
            // compact, as Fault Scanner's); the bottom line moves down with the panel's bottom
            const ex = G.pageBottom(cv) - G.BOTTOM;
            const rows = PER_PAGE + Math.floor(ex / 55);
            // the bottom line: an item's details, or what the last button did (reset)
            // (where the kit runs the screen the item's card shows its hint and the reset's progress)
            const selectedRecord = its[sel] && its[sel].record;
            const extra = selectedRecord ? 'UDS candidate: ' + selectedRecord.source + ', counter ' + selectedRecord.count
                + ', availability ' + valueText(selectedRecord.avail, '%')
                + ', interval ' + valueText(selectedRecord.intervalKm, ' km')
                + ' / ' + valueText(selectedRecord.intervalMonths, ' months') : '';
            const line = cv.own ? '' : msg || (hint ? hint.name + ':  ' + hint.text : extra);
            const per = line ? rows - 1 : rows;                  // the bottom line takes the last row
            G.panel(cv, t, 24, 176, 1552, 336, 'Service requirements' + (its.length > per ? '  ' + (Math.floor(sel / per) + 1) + '/' + Math.ceil(its.length / per) : ''));
            if (line) {
                cv.roundRect(40, 470 + ex, 1520, 38, 8, withAlpha(t.accent, 0.12));
                cv.text(fit(cv, line, 22, 1490), 56, 496 + ex, 22, t.text);
            }
            if (!its.length) {
                cv.text('Waiting for the service data from the instrument cluster (ignition on)...', 800, 369 + Math.round(ex / 2), 28, t.dim, { align: 'center' });
                return;
            }
            const first = Math.floor(sel / per) * per;
            its.slice(first, first + per).forEach((it, i) => {
                const y = 232 + i * 55, col = COL(t, it.colour);
                // a row tapped, or pressed with the controller: its card
                if (cv.own) cv.target(40, y - 4, 1520, 50, () => openCard(first + i),
                    'item' + (it.native ? it.id : it.key), 8);
                if (!cv.own && first + i === sel) cv.roundRect(40, y - 4, 1520, 50, 8, withAlpha(t.accent, 0.18));   // (the kit rings the row the controller is on)
                cv.roundRect(48, y + 4, 8, 34, 4, col);
                cv.text(fit(cv, it.name, 30, 720, { font: 'bold' }), 76, y + 32, 30, t.text, { font: 'bold' });
                cv.text(it.way || '--', 1040, y + 32, 30, it.way ? t.text : t.dim, { align: 'right', font: 'bold' });
                cv.text(it.date || '--', 1250, y + 32, 28, it.date ? t.text : t.dim, { align: 'right' });
                if (LBL[it.colour] || !it.native) {
                    cv.roundRect(1310, y + 6, 230, 34, 6, withAlpha(col, 0.22));
                    cv.text(it.native ? LBL[it.colour] : 'UDS / UNVERIFIED', 1425, y + 31, 20, col, { align: 'center', font: 'bold', spacing: 0.5 });
                }
            });
        }

        /** The engine unit's oil, spark plugs, hours and particulate filter. */
        function drawEngine(cv, t) {
            if (engine.kind === 'diesel' && !useDemo()) return drawDiesel(cv, t);
            const v = useDemo() ? ENGINE_DEMO : engine.values;
            const num = (x, dec, unit) => (G.isNum(x) ? G.fmt(x, dec) + (unit ? ' ' + unit : '') : '--');
            const km = (x) => (G.isNum(x) ? Math.round(x).toLocaleString('en-US').replace(/,/g, ' ') + ' km' : '--');
            const row = (x, w, y, label, value, col) => {
                cv.text(label, x, y, 22, t.dim, { font: 'bold', spacing: 1.2 });
                cv.text(value, x + w, y, 28, col || (value === '--' ? t.dim : t.text), { font: 'bold', align: 'right' });
            };
            const life = (p) => (!G.isNum(p) ? null : p < 10 ? t.crit : p < 25 ? t.warn : null);
            const ex = G.pageBottom(cv) - G.BOTTOM, step = 70 + Math.round(ex / 4);
            G.panel(cv, t, 24, 44, 500, 468, 'Oil');
            [['LIFE BY ENGINE HOURS', num(v.oilHours, 0, '%'), life(v.oilHours)], ['LIFE BY FUEL USED', num(v.oilFuel, 0, '%'), life(v.oilFuel)],
                ['ENGINE HOURS ON IT', num(v.oilEngineH, 0, 'h')], ['DISTANCE ON IT', km(v.oilKm)]]
                .forEach((r, i) => row(48, 452, 136 + i * step, r[0], r[1], r[2]));
            G.panel(cv, t, 544, 44, 500, 468, 'Spark plugs and engine');
            [['SPARK PLUGS: LEFT', km(v.plugsLeft), G.isNum(v.plugsLeft) && v.plugsLeft < 5000 ? t.warn : null],
                ['SPARK PLUGS: DRIVEN', km(v.plugsDriven)], ['ENGINE HOURS', num(v.engineHours, 0, 'h')]]
                .forEach((r, i) => row(568, 452, 136 + i * step, r[0], r[1], r[2]));
            G.panel(cv, t, 1064, 44, 512, 468, 'Particulate filter');
            const two = engine.twin && !useDemo();
            [[two ? 'SOOT, BANK 1' : 'SOOT', num(v.soot, 1, 'g')]].concat(two ? [['SOOT, BANK 2', num(v.soot2, 1, 'g')]] : [],
                [['LOAD (ADAPTED)', num(v.opfLoad, 3)], ['ASH (ADAPTED)', num(v.opfAsh, 3)]])
                .forEach((r, i) => row(1088, 464, 136 + i * (two ? Math.round(step * 0.78) : step), r[0], r[1]));
            const at = engine.at ? new Date(engine.at).toTimeString().slice(0, 5) : '';
            const note = useDemo() ? '' : engine.busy ? 'Reading the engine unit...' : engine.error ? 'Engine unit: ' + engine.error
                : engine.at ? (two ? 'From the engine unit' + '  ·  ' + at : 'From the engine unit (B58 / B48 / B38), read ' + at) : 'Not read yet';
            cv.text(fit(cv, note, 20, 1500), 48, 496 + ex, 20, engine.error ? t.warn : t.dim);
        }

        /** A B47 / B57 diesel: its particulate filter, its regenerations and what came since the last one. */
        function drawDiesel(cv, t) {
            const v = engine.values;
            const num = (x, dec, unit) => (G.isNum(x) ? G.fmt(x, dec) + (unit ? ' ' + unit : '') : '--');
            const km = (x) => (G.isNum(x) ? Math.round(x).toLocaleString('en-US').replace(/,/g, ' ') + ' km' : '--');
            const row = (x, w, y, label, value, col) => {
                cv.text(label, x, y, 22, t.dim, { font: 'bold', spacing: 1.2 });
                cv.text(value, x + w, y, 28, col || (value === '--' ? t.dim : t.text), { font: 'bold', align: 'right' });
            };
            const ex = G.pageBottom(cv) - G.BOTTOM, step = 70 + Math.round(ex / 4);
            const hot = G.isNum(v.dpfTemp) && v.dpfTemp >= REGEN_TEMP;
            G.panel(cv, t, 24, 44, 500, 468, 'Particulate filter');
            [['SOOT', num(v.soot, 1, 'g')], ['OIL ASH', num(v.ash, 1, 'g')], ['TEMPERATURE BEFORE', num(v.dpfTemp, 0, '°C'), hot ? t.warn : null],
                ['PRESSURE ACROSS', num(v.dpfDp, 1, 'hPa')]]
                .forEach((r, i) => row(48, 452, 136 + i * step, r[0], r[1], r[2]));
            G.panel(cv, t, 544, 44, 500, 468, 'Regeneration');
            const state = !G.isNum(v.dpfTemp) ? '--' : hot ? 'LIKELY RUNNING' : 'NOT RUNNING';
            cv.text(state, 568, 150, 34, hot ? t.warn : state === '--' ? t.dim : t.text, { font: 'bold', spacing: 1.5 });
            cv.text(hot ? 'Hotter than ' + REGEN_TEMP + ' °C before the filter: keep driving' : 'From the temperature before the filter', 568, 186, 20, t.dim);
            [['REGENERATIONS', num(v.regens, 0)], ['AVERAGE EVERY', km(v.avgKm)]]
                .forEach((r, i) => row(568, 452, 136 + (i + 1.5) * step, r[0], r[1]));
            G.panel(cv, t, 1064, 44, 512, 468, 'Since the last one');
            [['DISTANCE', km(v.sinceKm)], ['ENGINE TIME', num(v.sinceH, 1, 'h')], ['FUEL', num(v.sinceL, 1, 'l')]]
                .forEach((r, i) => row(1088, 464, 136 + i * step, r[0], r[1]));
            const note = engine.busy ? 'Reading the engine unit...' : engine.error ? 'Engine unit: ' + engine.error
                : engine.at ? 'From the engine unit (B47 / B57 diesel), read ' + new Date(engine.at).toTimeString().slice(0, 5) : 'Not read yet';
            cv.text(fit(cv, note, 20, 1500), 48, 496 + ex, 20, engine.error ? t.warn : t.dim);
        }

        function drawDiag(cv, t) {
            const p = G.panel(cv, t, 24, 44, 1552, 468, 'Diagnostics - read-only CBS');
            const lines = [
                'KombiInterface_2: ' + (kombi ? (kombi.error ? 'error ' + kombi.error : kombi.available ? 'available' : 'not available yet') : 'connecting...'),
                settings.get('demo') === 'on' ? 'DEMO: diagnostic requests disabled' : scanMessage,
                'Last scan: ' + (scanAt === null ? '--' : new Date(scanAt).toISOString()),
                'UDS candidate decoding: not certified for this car. Native HMI date/distance take precedence.',
            ];
            CBS_SOURCES.forEach((source) => source.dids.forEach((did) => {
                const read = cbsReads.get(readKey(source.address, did));
                const prefix = source.name + ' [0x' + hex(source.address) + '] 22 ' + hex(did, 4);
                lines.push(prefix + ': ' + (read ? read.state + (read.error ? ' - ' + read.error : '') : 'not read'));
                if (!read) return;
                lines.push('Read at: ' + (read.at ? new Date(read.at).toISOString() : '--'));
                if (read.state === 'ok' && did === 0x1001) {
                    if (!read.records.length) lines.push('No CBS records');
                    read.records.forEach((r) => {
                        lines.push('0x' + hex(r.id) + ' ' + cbsName(r.id)
                            + (CBS_TECHNICAL_IDS.includes(r.id) ? ' (technical; not in service list)' : ''));
                        lines.push('remaining=' + valueText(r.remaining, r.unit ? ' ' + r.unit : '')
                            + '; due=' + (r.date || '--') + '; status=' + r.status);
                        lines.push('counter=' + r.count + '; availability=' + valueText(r.avail, '%')
                            + '; interval=' + valueText(r.intervalKm, ' km') + '/' + valueText(r.intervalMonths, ' months'));
                        lines.push('Record raw: ' + r.raw);
                    });
                }
                if (read.state === 'ok' && did === 0x1002) {
                    const payload = read.raw.split(' ').slice(3);
                    for (let i = 0; i < payload.length; i += 3) {
                        lines.push('Reset eligibility (candidate): id=0x' + payload[i]
                            + ' reason=0x' + payload[i + 1] + ' reserve=0x' + payload[i + 2]);
                    }
                }
                if (did === 0x1003) lines.push('1003: raw only; layout not verified');
                lines.push('Reply raw: ' + (read.raw || '--'));
            }));
            lines.push('cbsDataSBA: ' + (rawSba || 'nothing received'));
            lines.push('cbsDataServiceList: ' + (rawList || 'nothing received'));
            const wrapped = [];
            lines.forEach((line) => {
                for (let i = 0; i < line.length; i += 116) wrapped.push(line.slice(i, i + 116));
            });
            const per = Math.max(1, Math.floor((p.y + p.h - 72 - 96) / 26));
            const count = Math.max(1, Math.ceil(wrapped.length / per));
            diagPageCount = count;
            diagPage = Math.max(0, Math.min(diagPage, count - 1));
            let y = 96;
            wrapped.slice(diagPage * per, (diagPage + 1) * per).forEach((line) => {
                cv.text(fit(cv, line, 18, 1500), 48, y, 18, t.text); y += 26;
            });
            const by = p.y + p.h - 54;
            const controls = [
                { x: 48, label: 'Previous', run: () => { diagPage = Math.max(0, diagPage - 1); changed(); } },
                { x: 350, label: 'Next (' + (diagPage + 1) + '/' + count + ')', run: () => { diagPage = (diagPage + 1) % count; changed(); } },
                { x: 652, label: scanBusy ? 'Reading...' : 'Read CBS', run: () => { refreshCbs(); } },
            ];
            controls.forEach((button, i) => {
                cv.roundRect(button.x, by, 280, 40, 6, withAlpha(t.accent, 0.18));
                cv.text(button.label, button.x + 140, by + 28, 22, t.text, { align: 'center' });
                if (cv.own) cv.target(button.x, by, 280, 40, button.run, 'cbs-diag-' + i, 6);
            });
        }

        let drawn = -1;
        async function render(force) {
            if (reset && !reset.busy && Date.now() - reset.at >= CONFIRM_MS) {
                reset = null; changed();
            }
            if (settings.get('demo') !== 'on' && !scanBusy && !reset
                && (scanAt === null || Date.now() - scanAt >= CBS_REFRESH_MS)) refreshCbs();
            if (!force && drawn === version) return;
            drawn = version;
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const its = items();
            sel = Math.min(sel, Math.max(0, its.length - 1));
            page = Math.min(page, pages().length - 1);
            if (pageName() === 'Engine') readEngine(false);
            if (pageName() === 'Service') drawMain(cv, t, its); else if (pageName() === 'Engine') drawEngine(cv, t); else drawDiag(cv, t);
            G.frame(cv, t, pages(), page, [useDemo() && { text: 'DEMO' }]);
            await ui.image('MAIN_GFX', cv);
        }

        // Next item: through the list; after the last item the diagnostics page (when it is on), then back
        ui.onClick('BTN_SELECT', () => {
            const n = items().length;
            reset = reset && reset.busy ? reset : null;         // any other button disarms a reset
            hint = null; msg = '';
            if (pageName() === 'Diagnostics') {
                if (diagPage + 1 < diagPageCount) diagPage++;
                else { page = 0; sel = 0; diagPage = 0; }
            } else if (pageName() === 'Engine') page = (page + 1) % pages().length;
            else if (n && sel + 1 < n) sel++;
            else page = 1;
            changed();
        });
        ui.onClick('BTN_DETAILS', () => {
            if (pageName() === 'Diagnostics') { refreshCbs(); return; }
            if (pageName() === 'Engine') { readEngine(true); return; }
            if (openCard(sel)) return;
            reset = reset && reset.busy ? reset : null; msg = ''; details();
        });
        ui.onClick('BTN_RESET', () => {
            if (pageName() !== 'Service') { showMsg(pageName() + ' is read-only'); return; }
            resetPress();
        });
        // where the kit runs the screen the rows open their cards (with Reset): none of these in its bar
        ['BTN_SELECT', 'BTN_DETAILS', 'BTN_RESET'].forEach((b) => ctx.hideButton(b));
        ctx.onLayout(changed);           // (it draws only on changes: a new layout is one)
        ctx.onTab((i) => {
            if (i !== page) {
                page = i; sel = 0; msg = ''; diagPage = 0;
                reset = reset && reset.busy ? reset : null;
                changed();
            }
        });

        ctx.loop('MAIN', 2, () => render(false));
        // back from Settings or a popup: draw again (this app only draws when something changed)
        const redraw = () => { changed(); setTimeout(changed, 600); };
        ui.onVisible((name, on) => { if (name === 'MAIN' && on) redraw(); });
        if (ui.onFocus) ui.onFocus((name, on) => { if (name === 'MAIN' && on) redraw(); });
        settings.onChange(() => changed());
        setInterval(changed, 2000);         // the diagnostics page shows live status
        render(true).then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
