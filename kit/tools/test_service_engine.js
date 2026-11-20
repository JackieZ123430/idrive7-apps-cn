'use strict';

// Service's Engine page against a stand-in diagnostic link: the engine unit's oil life, spark plugs, hours and
// particulate filter decoded from its replies (kit/dids.js, as on the car), "--" for one it does not have, read-only
// on that page, and the Service and Diagnostics tabs around it.
//   node kit/tools/test_service_engine.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const MAIN = path.join(ROOT, 'apps', 'service', 'main.js');
const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'service', 'app.json'), 'utf8'));
const { Recorder: Canvas } = require(path.join(KIT, 'record'));
const themes = require(path.join(KIT, 'themes'));
const realDiag = require(path.join(KIT, 'diag'));

global.setInterval = () => 0;
// the engine unit's replies by DID (data after the DID, hex); anything else: no reply
let REPLIES = {
    '411A': '80 00 74 00 00 07 CF 80 00',    // oil life 64 % (hours), 58 % (fuel); 512 000 s = 142.2 h on this oil
    '4404': '03 0F',                         // 7830 km on this oil
    '4163': '00 00 00 00 01 9C 00 00 49 70', // spark plugs: 41 200 km left, 18 800 km driven
    '583D': '36 10',                         // 13 840 x 6 min = 1384 h
    '5444': '02 80',                         // 6.40 g soot
};
let app = null, sent = [];
class FakeDiag extends EventEmitter {
    constructor() { super(); this.available = true; this.p = {}; }
    init() { return Promise.resolve(); }
    async physical(ecu, sid, req) {
        const did = ((req[0] << 8) | req[1]).toString(16).toUpperCase().padStart(4, '0');
        sent.push([ecu, sid].concat(req));
        const r = ecu === 0x12 && sid === 0x22 && REPLIES[did];
        return r ? [0x62, req[0], req[1]].concat(r.split(' ').map((x) => parseInt(x, 16))) : null;
    }
}
const stubs = {
    './kit/mgu': { run(a) { app = a; } },
    './kit/diag': Object.assign({}, realDiag, { Diag: FakeDiag }),
};
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (stubs[req]) return stubs[req];
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
const flush = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)); };

(async () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'service-'));
    try {
        require(MAIN);
        const S = {};
        SPEC.settings.forEach((s) => { S[s.key] = s.default; });
        S.demo = 'off';
        const texts = [];
        let frame = null, tab = null, last = null;
        const ctx = {
            ui: { onClick() {}, text() {}, image: async () => {}, onVisible() {}, onFocus() {} },
            settings: { get: (k) => S[k], onChange() {} },
            log: { info() {}, warn() {}, error() {}, debug() {} }, spec: SPEC, dataDir: dir,
            signals: { watch: () => Promise.resolve({}), call: () => Promise.reject(new Error('no')) },
            onTab(fn) { tab = fn; }, hideButton() {}, onScroll() {}, onTap() {}, onLayout() {}, loop(n, fps, fn) { frame = fn; },
            theme: () => themes.theme('m_tricolour'),
            canvas: (w, h) => {
                const cv = new Canvas(w, h), text = cv.text.bind(cv);
                texts.length = 0;                   // the texts of the last frame drawn (Service draws on changes only)
                cv.text = (str, ...rest) => { texts.push(String(str)); return text(str, ...rest); };
                last = cv;
                return cv;
            },
        };
        await app.start(ctx);
        await flush();
        const draw = async () => { await frame(); await flush(); await frame(); return texts.slice(); };
        // the tabs: Service, Engine (Diagnostics only with its setting)
        let t = await draw();
        assert(t.includes('SERVICE') && t.includes('ENGINE') && !t.includes('DIAGNOSTICS'), 'tabs: ' + t.join(' | '));
        sent = [];
        await tab(1);
        t = await draw();
        ['64 %', '58 %', '142 h', '7 830 km', '41 200 km', '18 800 km', '1384 h', '6.4 g']
            .forEach((x) => assert(t.includes(x), x + ' on the Engine page: ' + t.join(' | ')));
        assert(t.includes('--'), 'a value the engine unit does not have: --');
        assert(sent.length && sent.every((r) => r[0] === 0x12 && r[1] === 0x22), 'only 0x22 reads of the engine unit: ' + JSON.stringify(sent));
        // read again at most once a minute
        const n = sent.length;
        await draw();
        assert.strictEqual(sent.length, n, 'not read again within a minute');
        // with the Diagnostics page on, it comes after Engine
        S.diagPage = true;
        await tab(2);
        t = await draw();
        assert(t.includes('DIAGNOSTICS'), 'Diagnostics after Engine');
        void last;

        // a B47 / B57 diesel (DDE D83BX7C0 by its SGBD index): the particulate filter's values, a regeneration likely
        // running while it is hotter than 500 °C before the filter
        REPLIES = {
            'F150': '0F 1F E8 01',
            '44BE': '04 A8',          // 1192 x 0.01525902 = 18.2 g soot
            '44BD': '0A 96',          // 2710 -> 41.4 g ash
            '4502': '45 06',          // 17670 x 0.03128099 - 50 = 502.7 °C
            '44B8': '00 D6',          // 214 regenerations
            '44BF': '00 04 5D 30',    // 286 000 m -> 286 km
            '44C7': '02 00',          // every 512 km
        };
        delete require.cache[require.resolve(MAIN)];
        require(MAIN);
        S.diagPage = false;
        await app.start(ctx);
        await flush();
        sent = [];
        await tab(1);
        t = await draw();
        ['18.2 g', '41.4 g', '503 °C', '214', '286 km', '512 km', 'LIKELY RUNNING', 'SOOT', 'DISTANCE']
            .forEach((x) => assert(t.includes(x), x + ' on a diesel\'s Engine page: ' + t.join(' | ')));
        assert(!t.includes('SPARK PLUGS: LEFT'), 'no spark plugs on a diesel');
        assert(!sent.some((r) => r[2] === 0x41 && r[3] === 0x1A), 'no petrol identifiers asked of a diesel unit');
        console.log('Service Engine page checks passed (decoded values, -- for a missing one, read-only, once a minute, tabs, a diesel\'s filter).');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
