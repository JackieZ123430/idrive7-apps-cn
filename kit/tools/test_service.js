'use strict';

// Service's item texts against a stubbed instrument cluster: texts the baked fonts cannot draw (a Korean iDrive,
// or texts the car already sends as "?") are shown by the item's English name and the date's numbers, texts the
// fonts can draw as the car sends them. No SDK or vehicle needed:
//   node kit/tools/test_service.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const MAIN = path.join(ROOT, 'apps', 'service', 'main.js');
const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'service', 'app.json'), 'utf8'));
const { Recorder } = require(path.join(KIT, 'record'));
const themes = require(path.join(KIT, 'themes'));

let app = null;
// the diagnostic link: none by default (as on the VM); a test sets `uds` to answer UDS reads like a car
const realDiag = require(path.join(KIT, 'diag'));
let uds = null;
const sent = [];
class FakeDiag {
    constructor() { this.p = null; this.error = 'TASU not available'; }
    async init() { if (uds) this.p = {}; }
    async physical(target, sid, data) { sent.push([target, sid].concat(data)); return uds(target, sid, data); }
}
const stubs = { './kit/mgu': { run(a) { app = a; } }, './kit/diag': Object.assign({}, realDiag, { Diag: FakeDiag }) };
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (stubs[req]) return stubs[req];
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
const realInterval = global.setInterval;
global.setInterval = () => 0;           // the app's 2 s redraw tick: the test draws by hand

/** a CBS list entry as KombiInterface_2 sends it (unions arrive wrapped in their member's name) */
const item = (id, name, way, date, color) => ({ cBSDataServiceListEntry: {
    cBSIdentifier: id, cBSColor: color || 'GREEN', cBSServiceName: name, cBSServiceWay: way || '', cBSServiceDate: date || '' } });
const summary = (text, way, date) => ({ cBSDataSBA: { cBSDataSBAText: text, cBSDataSBADistance: way || '', cBSDataSBADate: date || '', cBSDataSBAColor: 'GREEN' } });

/** A fresh Service (a new process); returns { feed, render, details, logs } */
async function start(hint, set) {
    delete require.cache[MAIN];
    require(MAIN);
    const S = {};
    SPEC.settings.forEach((s) => { S[s.key] = s.default; });
    S.demo = 'off';
    Object.assign(S, set || {});
    let texts = [], frame = null, watch = null, tab = null;
    const clicks = {}, logs = [];
    await app.start({
        ui: { image: async () => {}, onClick: (n, fn) => { clicks[n] = fn; }, onVisible() {}, onFocus() {} },
        settings: { get: (k) => S[k], onChange() {} },
        log: { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)) },
        theme: () => themes.theme('m_tricolour'), loop: (name, fps, fn) => { frame = fn; },
        canvas: (w, h) => {
            const cv = new Recorder(w, h), text = cv.text.bind(cv);
            texts = [];
            cv.text = (str, ...a) => { texts.push(String(str)); return text(str, ...a); };
            return cv;
        },
        signals: {
            watch: async (iface, inst, handlers) => { watch = handlers; return { iface, available: true, proxy: {} }; },
            call: async () => hint,
        },
        display: {}, sheet: () => false, hideButton() {}, onLayout() {}, onTab: (fn) => { tab = fn; },
    });
    await new Promise((r) => setImmediate(r));
    return {
        feed: (field, v) => watch[field](v),
        render: async () => { await frame(); return texts; },
        tab: (i) => tab(i),
        details: async () => { clicks.BTN_DETAILS(); await new Promise((r) => setTimeout(r, 0)); await frame(); return texts; },
        logs,
    };
}
const fonts = require(path.join(KIT, 'fonts'));
const has = (texts, s) => texts.some((x) => x === s || x.indexOf(s) === 0);
/** texts that would be drawn as "?": a character the font has no glyph for, or "??" itself */
const hasQ = (texts) => texts.some((x) => {
    const f = fonts.get('bold', 30, x);
    return /\?\?/.test(x) || !Array.from(x).every((ch) => f.glyphs[ch.codePointAt(0)]);
});

(async () => {
    // a Korean iDrive: Hangul names and dates, the summary before the list
    let s = await start({ cBSServiceHint: { cBSServiceHint: '엔진 오일 교환', cBSServiceWay: '12,300 km', cBSServiceDate: '2027년 9월' } });
    s.feed('cbsDataSBA', summary('엔진 오일', '12,300 km', '2027년 9월'));
    s.feed('cbsDataServiceList', [item(1, '엔진 오일', '12,300 km', '2027년 9월'), item(3, '브레이크 액', '', '2026년 11월', 'YELLOW'),
        item(0x21, '배기가스 검사', '', '2028년 5월'), item(0x40, '미세먼지 필터', '', '2027년 3월')]);
    let t = await s.render();
    assert(!hasQ(t), 'nothing drawn as "?": ' + t.join(' | '));
    for (const want of ['Engine oil', 'Brake fluid', 'Exhaust emissions test', 'Service item 64']) assert(has(t, want), want + ' in ' + t.join(' | '));
    for (const want of ['09/2027', '11/2026', '05/2028', '03/2027']) assert(t.includes(want), want);
    assert(t.filter((x) => x === 'Engine oil').length >= 2, 'the summary names the item too (it came before the list)');
    assert(s.logs.some((l) => /shown by id: 1 \\uc5d4\\uc9c4/.test(l)), 'the log keeps what the car sent');
    t = await s.details();
    const line = t.find((x) => x.indexOf('Engine oil:') === 0) || '';
    assert(/12,300 km\s+09\/2027$/.test(line) && !/\?/.test(line), 'details: no Hangul hint, the numbers stay: ' + line);

    // a car that sends the lost characters as "?" already, and an empty slot
    s = await start({ cBSServiceHint: { cBSServiceHint: '???? ??', cBSServiceWay: '', cBSServiceDate: '09/2027' } });
    s.feed('cbsDataServiceList', [item(1, '?? ??', '12,300 km', '09/2027'), item(0x64, '?? ??', '9,800 km', '11/2027'), item(0, '')]);
    s.feed('cbsDataSBA', summary('?? ??', '12,300 km', '09/2027'));
    t = await s.render();
    assert(!hasQ(t), 'no "??": ' + t.join(' | '));
    assert(has(t, 'Engine oil') && has(t, 'Vehicle check') && !has(t, 'Service item 0'), 'names by id, empty slot left out');
    t = await s.details();
    assert(!(t.find((x) => x.indexOf('Engine oil:') === 0) || '').includes('?'), 'details: a "?" hint is left out');

    // texts the fonts can draw are shown as the car sends them (English, German with its umlauts spelt out)
    s = await start({ cBSServiceHint: { cBSServiceHint: 'Change engine oil', cBSServiceWay: '12,300 km', cBSServiceDate: '09/2027' } });
    s.feed('cbsDataServiceList', [item(1, 'Motoröl', '12.300 km', '09.2027'), item(4, 'Microfilter', '', '03/2027'), item(7, 'Spark plugs', '40,000 km')]);
    s.feed('cbsDataSBA', summary('Motoröl', '12.300 km', '09.2027'));
    t = await s.render();
    for (const want of ['Motoroel', 'Microfilter', 'Spark plugs', '12.300 km', '09.2027']) assert(has(t, want), want + ' in ' + t.join(' | '));
    assert(!has(t, 'Engine oil') && !has(t, 'Service item'), 'no English name where the car\'s own can be drawn');
    t = await s.details();
    assert(t.some((x) => x.indexOf('Change engine oil') >= 0), 'details: the car\'s hint');

    // the cluster's, DME's and DSC's own CBS records (UDS 22 1001), read-only, next to what the HMI lists
    const rec = (h) => Array.from(Buffer.from(h, 'hex'));
    const answers = { 0x60: rec('010ABF01035321361C180000' + '03800001E23A003BDB18FFFF' + '6417A301E25B4236DE30FFFF'),
        0x12: rec('0754B00101FDBD0000000000') };
    uds = (target, sid, data) => (sid === 0x22 && data[0] === 0x10 && data[1] === 0x01 && answers[target]
        ? [0x62, 0x10, 0x01].concat(answers[target]) : [0x7F, sid, 0x31]);
    s = await start(null, { diagPage: true });
    s.feed('cbsDataServiceList', [item(1, 'Engine oil', '12,300 km', '09/2027'), item(3, 'Brake fluid', '', '11/2026', 'YELLOW')]);
    await s.render();
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    t = await s.render();
    assert(has(t, 'Engine oil') && has(t, 'Brake fluid'), 'the HMI items stay: ' + t.join(' | '));
    // UDS-only records (unverified for the car) stay off the list since Service 1.4.21; still on Diagnostics
    assert(!has(t, 'Particulate filter (OPF/DPF) [UDS]') && !t.includes('UDS / UNVERIFIED'), 'a DME-only record is not listed: ' + t.join(' | '));
    s.tab(2);    // Diagnostics: after Service and Engine
    t = await s.render();
    for (const want of ['KOMBI [0x60] 22 1001: ok', '0x01 Engine oil', 'remaining=27510 km; due=06/2028; status=OK',
        'counter=3; availability=83%; interval=33000 km/24 months', 'CBS read complete - 4 read(s) failed', 'Next (1/']) assert(has(t, want), want + ' in ' + t.join(' | '));
    assert(sent.length && sent.every((r) => r[1] === 0x22), 'reads only (UDS 22), no writes: ' + JSON.stringify(sent));
    uds = null;

    global.setInterval = realInterval;
    console.log('service: OK');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
