'use strict';
/**
 * test_twin_dme.js - engines with two engine units (the V8s: N63 / S63 / S68): the master at 0x12 runs bank 1,
 * the second unit at 0x13 bank 2 (kit/runtime/twin_dme.js). Stand-in links with crafted replies, no car or SDK:
 *   - TwinDme: which SGBD indexes have a second unit, the question asked once, kept, retried, never throwing; the V8's
 *     Auto redline (the index, or the VIN's maker code: N63 or an M car's S63 / S68);
 *   - Redline knock (the larger retard of the two banks) and fuel (both banks' 5656 added, else OBD 5E, never half);
 *   - M Vitals' misfire counter: bank 2's cylinders from the second unit after the master's; bank 2's boost beside bank 1's;
 *   - Live Data's Useful lists (cylinders 7 / 8, bank 2's) and the app itself on a V8 and on a B58: the Engine page,
 *     what is asked of which unit;
 *   - a single-unit engine (B58) never has 0x13 asked anything, everywhere; the N74 V12 is not supported (one unit).
 *   node kit/tools/test_twin_dme.js
 * Node 8 compatible (the head unit's).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const TwinDme = require(path.join(KIT, 'twin_dme'));
const { DidReader } = require(path.join(KIT, 'dids'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (p) => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), p));
const quiet = { info() {}, warn() {}, error() {} };
const rmTree = (p) => { try { fs.readdirSync(p).forEach((f) => { const q = path.join(p, f); if (fs.lstatSync(q).isDirectory()) rmTree(q); else fs.unlinkSync(q); }); fs.rmdirSync(p); } catch (e) { /* gone */ } };

const hex2 = (b) => (b < 16 ? '0' : '') + b.toString(16).toUpperCase();
const u16 = (v) => [(v >> 8) & 0xFF, v & 0xFF];
const B58 = '0F26E8', V8 = '0F242C', N74 = '0F1380';
/** F150 reply with an SGBD index ('0F242C') */
const f150 = (index) => [0x62, 0xF1, 0x50].concat([0, 2, 4].map((i) => parseInt(index.slice(i, i + 2), 16)));

/**
 * A stand-in link (kit/diag.js / readonly-diag.js physical()): units = { 0x12: answer(key, sid, data), 0x13: ... };
 * key = '22 F150', '06 A2', '01 5E'. An address without a function never answers. asked: ['12:22 F150', ...]
 */
function fakeLink(units) {
    const l = { asked: [], woken: [], available: true, ready: true, p: {} };
    l.wake = (t) => l.woken.push(t);
    l.silent = () => false;
    l.physical = (target, sid, data, timeoutMs, accept) => {
        const key = hex2(sid) + ' ' + (sid === 0x22 ? data.map(hex2).join('') : data.map(hex2).join(' '));
        l.asked.push(hex2(target) + ':' + key);
        (l.waits || (l.waits = {}))[hex2(target) + ':' + key] = timeoutMs;
        const f = units[target];
        const r = f ? f(key, sid, data) : null;
        if (r && accept && !accept(r)) throw new Error('reply not accepted: ' + r.map(hex2).join(' ') + ' for ' + key);
        return Promise.resolve(r || null);
    };
    l.read = (target, did) => l.physical(target, 0x22, [did >> 8, did & 0xFF], 1500, null);
    l.readMany = () => Promise.resolve([0x7F, 0x22, 0x13]);     // one identifier a request
    return l;
}
const asked13 = (l) => l.asked.filter((k) => /^13:/.test(k));

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

/* ---------- TwinDme ---------- */
test('TwinDme: the index table is BMW\'s V8 pairs, nothing else (not the N74 V12)', () => {
    const I = require(path.join(ROOT, 'apps', 'live_data', 'builtin', 'sgbd_index.json'));
    const pairs = Object.keys(I).filter((k) => /^13 /.test(k)).map((k) => k.slice(3)).filter((i) => I['12 ' + i] && !/^MSD87/.test(I['12 ' + i])).sort();
    assert.deepStrictEqual(TwinDme.TWIN.slice().sort(), pairs);
    assert.strictEqual(pairs.length, 8);
    assert.strictEqual(TwinDme.isTwinIndex(V8), true);
    assert.strictEqual(TwinDme.isTwinIndex('0f242c'), true, 'any case');
    [B58, '0F1F70', N74, '', null, undefined, 42, 'constructor', '__proto__', 'indexOf'].forEach((x) => assert.strictEqual(TwinDme.isTwinIndex(x), false, String(x)));
});

test('TwinDme: detect() on a V8, kept for the next start', async () => {
    const dir = tmp('twin-'), l = fakeLink({ 0x12: (k) => (k === '22 F150' ? f150(V8) : null) });
    try {
        const t = new TwinDme(l, { dataDir: dir, log: quiet });
        assert.strictEqual(t.twin, null);
        assert.strictEqual(t.perBank, 0);
        assert.strictEqual(await t.detect(), true);
        assert.strictEqual(t.perBank, 4);
        assert.strictEqual(t.index, V8);
        assert.strictEqual(await t.detect(), true);
        assert.deepStrictEqual(l.asked, ['12:22 F150'], 'asked once a start');
        const t2 = new TwinDme(() => null, { dataDir: dir, log: quiet });
        assert.strictEqual(t2.twin, true, 'known at the next start before any reply');
        assert.strictEqual(t2.perBank, 4);
    } finally { rmTree(dir); }
});

/** a 22 F190 reply: the VIN's 17 characters */
const f190 = (vin) => [0x62, 0xF1, 0x90].concat(vin.split('').map((c) => c.charCodeAt(0)));

test('TwinDme: a V8 Auto redline, from the index or the VIN maker code (asked once, only with vin: true)', async () => {
    const Engine = require(path.join(KIT, 'engine'));
    const unit = (index, vin) => fakeLink({ 0x12: (k) => (k === '22 F150' ? f150(index) : k === '22 F190' ? (vin ? f190(vin) : [0x7F, 0x22, 0x31]) : null) });
    const dir = tmp('twin-'), logs = [];
    const log = { info: (m) => logs.push(m), warn() {}, error() {} };
    try {
        // DME8FF (N63TU2/3 or S63TU4): an M5 (WBS) 7200, a M550i (WBA) 6500
        let l = unit(V8, 'WBSJF0C51JB000000'), t = new TwinDme(l, { dataDir: dir, log, vin: true });
        assert.strictEqual(t.redline, null, 'not known yet');
        await t.detect();
        assert.strictEqual(t.redline, 7200);
        assert.deepStrictEqual(l.asked, ['12:22 F150', '12:22 F190']);
        assert.ok(!logs.join(' ').includes('JF0C51'), 'the VIN never logged: ' + logs.join(' | '));
        const t2 = new TwinDme(() => null, { dataDir: dir, log: quiet, vin: true });
        assert.strictEqual(t2.redline, 7200, 'kept for the next start');
        l = unit(V8, 'WBSJF0C51JB000000'); const t3 = new TwinDme(l, { dataDir: dir, log: quiet, vin: true });
        await t3.detect();
        assert.deepStrictEqual(l.asked, ['12:22 F150'], 'the VIN not asked again');
        rmTree(dir);
        const dir2 = tmp('twin-');
        l = unit(V8, 'WBAJS0C00LB000000'); t = new TwinDme(l, { dataDir: dir2, log: quiet, vin: true });
        await t.detect();
        assert.strictEqual(t.redline, 6500, 'a WBA car: N63');
        rmTree(dir2);
        // a US-built X5 / X6 (5YM: the X5 M, but some others too): not known, the profile's; kept, not asked again
        const dir3 = tmp('twin-');
        l = unit(V8, '5YMJU0C00L9000000'); t = new TwinDme(l, { dataDir: dir3, log: quiet, vin: true }); await t.detect();
        assert.strictEqual(t.redline, null); assert.strictEqual(t.m, null);
        l = unit(V8, '5YMJU0C00L9000000'); t = new TwinDme(l, { dataDir: dir3, log: quiet, vin: true }); await t.detect();
        assert.deepStrictEqual(l.asked, ['12:22 F150'], '5YM kept: the VIN not asked again');
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir3, 'twin_dme.json'), 'utf8')), { twin: true, index: V8, wmi: '5YM' });
        rmTree(dir3);
        t = new TwinDme(unit(V8, null), { log: quiet, vin: true }); await t.detect();
        assert.strictEqual(t.redline, null);
        // the older indexes say it themselves: no VIN asked
        l = unit('0F1A20', 'WBSXXXXXXXXXXXXXX'); t = new TwinDme(l, { log: quiet, vin: true }); await t.detect();
        assert.strictEqual(t.redline, 6500); assert.deepStrictEqual(l.asked, ['12:22 F150']);
        t = new TwinDme(unit('0F1A10'), { log: quiet, vin: true }); await t.detect();
        assert.strictEqual(t.redline, 7200);
        // without vin: true (Live Data) the VIN is never asked; one engine unit: none
        l = unit(V8, 'WBSJF0C51JB000000'); t = new TwinDme(l, { log: quiet }); await t.detect();
        assert.deepStrictEqual(l.asked, ['12:22 F150']); assert.strictEqual(t.redline, null);
        l = unit(B58, 'WBSJF0C51JB000000'); t = new TwinDme(l, { log: quiet, vin: true }); await t.detect();
        assert.deepStrictEqual(l.asked, ['12:22 F150']); assert.strictEqual(t.redline, null);
        // Engine: the Auto redline from setAuto(), the setting first, a diesel never
        const S = { engine: 'auto', redline: 0, rpmScale: 0 };
        const edir = tmp('eng-'), e = new Engine({ settings: { get: (k) => S[k] }, dataDir: edir, log: quiet });
        let calls = 0; e.onChange(() => calls++);
        assert.strictEqual(e.redline(), 7000);
        e.setAuto(6500);
        assert.strictEqual(e.redline(), 6500); assert.strictEqual(e.scaleMax(), 8000); assert.strictEqual(calls, 1);
        e.setAuto(6500); assert.strictEqual(calls, 1, 'the same: no change');
        S.redline = 6800; assert.strictEqual(e.redline(), 6800, 'the setting first');
        S.redline = 0; S.engine = 'diesel'; assert.strictEqual(e.redline(), 5000, 'a diesel: its profile');
        S.engine = 'auto'; e.setAuto(null); assert.strictEqual(e.redline(), 7000);
        rmTree(edir);
    } finally { rmTree(dir); }
});

test('TwinDme: a B58, a refusal, no reply, a link that throws', async () => {
    const dir = tmp('twin-');
    try {
        let t = new TwinDme(fakeLink({ 0x12: () => f150(B58) }), { dataDir: dir, log: quiet });
        assert.strictEqual(await t.detect(), false);
        assert.strictEqual(t.perBank, 0);
        t = new TwinDme(fakeLink({ 0x12: () => f150(N74) }), { log: quiet });
        assert.strictEqual(await t.detect(), false, 'the N74 V12: not supported, one unit');
        t = new TwinDme(fakeLink({ 0x12: () => [0x7F, 0x22, 0x31] }), { log: quiet });
        assert.strictEqual(await t.detect(), false, 'refused: one unit (not a twin)');
        assert.strictEqual(t.confirmed, true);
        const silent = fakeLink({});
        t = new TwinDme(silent, { log: quiet });
        assert.strictEqual(await t.detect(), null);
        assert.strictEqual(await t.detect(), null);
        assert.strictEqual(silent.asked.length, 1, 'no reply: not asked again within ' + TwinDme.RETRY_MS + ' ms');
        t.triedT -= TwinDme.RETRY_MS + 1;
        await t.detect();
        assert.strictEqual(silent.asked.length, 2, 'asked again after it');
        // a link not up yet: not asked, and the retry wait not used up (asked as soon as it is)
        const early = fakeLink({ 0x12: () => f150(V8) });
        early.ready = false;
        t = new TwinDme(early, { log: quiet });
        assert.strictEqual(await t.detect(), null);
        assert.strictEqual(t.known(), false);
        assert.strictEqual(early.asked.length, 0, 'not asked before the link is up');
        early.ready = true;
        assert.strictEqual(await t.detect(), true, 'asked at once when it is');
        assert.strictEqual(t.known() && t.on(), true);
        t = new TwinDme(() => { throw new Error('no link'); }, { log: quiet });
        assert.strictEqual(await t.detect(), null);
        t = new TwinDme({ physical: () => Promise.reject(new Error('transport')) }, { log: quiet });
        assert.strictEqual(await t.detect(), null);
        t = new TwinDme({ physical: () => { throw new Error('sync throw'); } }, { log: quiet });
        assert.strictEqual(await t.detect(), null);
        const both = new TwinDme(fakeLink({ 0x12: () => f150(V8) }), { log: quiet });
        const [a, b] = await Promise.all([both.detect(), both.detect()]);
        assert.ok(a === true && b === true, 'two at once share the question');
        fs.writeFileSync(path.join(dir, 'twin_dme.json'), '{not json');
        assert.strictEqual(new TwinDme(null, { dataDir: dir }).twin, null, 'a broken file: not known');
        fs.writeFileSync(path.join(dir, 'twin_dme.json'), JSON.stringify({ twin: 'yes' }));
        assert.strictEqual(new TwinDme(null, { dataDir: dir }).twin, null, 'a wrong value: not known');
    } finally { rmTree(dir); }
});

/* ---------- Redline: knock and fuel ---------- */
function redlineHook() {
    const load = Module._load;
    Module._load = function (req, parent, isMain) {
        if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
        return load.call(this, req, parent, isMain);
    };
    return () => { Module._load = load; };
}
const s8 = (v) => (v < 0 ? 256 + v : v);
/** a twin flag the way the watches use it */
const twinOf = (v) => ({ twin: v, detect: () => Promise.resolve(v), known: () => typeof v === 'boolean', on: () => v === true });

test('Redline knock: the larger retard of the two banks; one unit: 0x13 never asked', async () => {
    const unhook = redlineHook();
    try {
        const KnockWatch = require(path.join(ROOT, 'apps', 'redline', 'knock'));
        const unit = (retard, flag) => (k) => (k === '22 554C' ? [0x62, 0x55, 0x4C, s8(retard)] : k === '22 4A36' ? [0x62, 0x4A, 0x36, flag] : null);
        const run = async (l, twin) => {
            const logs = [], w = new KnockWatch({ log: { info: (m) => logs.push(m), warn: (m) => logs.push('W ' + m) } }, () => l, twin === undefined ? undefined : { twin: twinOf(twin) });
            w.start(); w.stop(); await sleep(20);
            return { w, logs };
        };
        let l = fakeLink({ 0x12: unit(2, 0), 0x13: unit(8, 0) });
        let r = await run(l, true);
        assert.strictEqual(r.w.value().retard, 8 * 0.375, 'bank 2 retards more: its value');
        assert.ok(r.logs.some((m) => /retard 3\.0 deg \(bank 2\)/.test(m)), r.logs.join(' | '));
        l = fakeLink({ 0x12: unit(8, 0), 0x13: unit(2, 0) });
        r = await run(l, true);
        assert.strictEqual(r.w.value().retard, 3, 'bank 1 retards more');
        l = fakeLink({ 0x12: unit(1, 0), 0x13: unit(1, 1) });
        r = await run(l, true);
        assert.ok(r.logs.some((m) => /knock detected on bank 2/.test(m)), 'bank 2 flag: ' + r.logs.join(' | '));
        assert.ok(l.waits['13:22 554C'] <= 600 && l.waits['13:22 4A36'] <= 600, 'bank 2 asked with a short wait: ' + JSON.stringify(l.waits));
        l = fakeLink({ 0x12: unit(4, 0) });
        r = await run(l, true);
        assert.strictEqual(r.w.value().retard, 1.5, 'the second unit silent: bank 1\'s value, no failure');
        assert.strictEqual(r.w.fails, 0);
        assert.ok(asked13(l).indexOf('13:22 4A36') < 0, 'no flag asked of a second unit that gave no retard');
        l = fakeLink({ 0x12: unit(4, 0), 0x13: unit(9, 1) });
        r = await run(l, false);
        assert.strictEqual(r.w.value().retard, 1.5);
        assert.deepStrictEqual(asked13(l), [], 'one engine unit: 0x13 not asked');
        l = fakeLink({ 0x12: unit(4, 0), 0x13: unit(9, 1) });
        r = await run(l);
        assert.deepStrictEqual(asked13(l), [], 'no twin given (as before): 0x13 not asked');
        assert.ok(l.woken.indexOf(0x13) < 0, 'and not woken');
    } finally { unhook(); }
});

test('Redline fuel: both banks\' 5656 added, else OBD 5E, never one bank alone', async () => {
    const unhook = redlineHook();
    try {
        const FuelWatch = require(path.join(ROOT, 'apps', 'redline', 'fuel'));
        const K = 0.00119209 * 3.6;
        const unit = (raw5656, raw5e, raw4521) => (k) => (k === '22 5656' && raw5656 != null ? [0x62, 0x56, 0x56].concat(u16(raw5656))
            : k === '01 5E' && raw5e != null ? [0x41, 0x5E].concat(u16(raw5e)) : k === '22 4521' && raw4521 != null ? [0x62, 0x45, 0x21].concat(u16(raw4521))
                : k.slice(0, 2) === '22' ? [0x7F, 0x22, 0x31] : [0x7F, 0x01, 0x31]);
        const run = async (l, twin) => {
            const logs = [], w = new FuelWatch({ log: { info: (m) => logs.push(m), warn: (m) => logs.push('W ' + m) } }, () => l, twin === undefined ? {} : { twin: twinOf(twin) });
            w.start(); w.stop(); await sleep(20);
            return { w, logs };
        };
        const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-6;
        let l = fakeLink({ 0x12: unit(1000, 400, 50), 0x13: unit(1100, null, 50) });
        let r = await run(l, true);
        assert.ok(near(r.w.value().lph, 2100 * K), 'the sum: ' + r.w.value().lph);
        assert.ok(r.logs.some((m) => /5656 of both engine units/.test(m)), r.logs.join(' | '));
        l = fakeLink({ 0x12: unit(1000, 400, 50) });
        r = await run(l, true);
        assert.ok(near(r.w.value().lph, 20), 'bank 2 silent: the engine total (OBD 5E), not half: ' + r.w.value().lph);
        l = fakeLink({ 0x12: unit(1000, null, 50) });
        r = await run(l, true);
        assert.strictEqual(r.w.value().lph, null, 'neither: no figure (4521 is not used on a twin)');
        assert.ok(l.asked.indexOf('12:22 4521') < 0, l.asked.join());
        // not known yet whether one unit or two (the first start): no reading at all, not bank 1's as the engine's
        l = fakeLink({ 0x12: unit(1000, 400, 50), 0x13: unit(1100) });
        r = await run(l, null);
        assert.strictEqual(r.w.value().lph, null, 'unknown: nothing shown');
        assert.ok(!l.asked.some((k) => /22 5656|01 5E|22 4521/.test(k)), 'and nothing asked: ' + l.asked.join());
        assert.strictEqual(r.w.fails, 0, 'not counted as a failure');
        l = fakeLink({ 0x12: unit(1000, 400, 50), 0x13: unit(1100) });
        r = await run(l, false);
        assert.ok(near(r.w.value().lph, 1000 * K), 'one engine unit: 5656 as before');
        assert.deepStrictEqual(asked13(l), []);
    } finally { unhook(); }
});

/* ---------- M Vitals: misfires ---------- */
/**
 * M Vitals started with a stand-in diagnostic link (the real DidReader and TwinDme on it), not on demo data, timers
 * real. Returns the logged misfire counts after the first slow poll.
 */
async function vitalsMisfires(units, files, opts) {
    opts = opts || {};
    const MAIN = path.join(ROOT, 'apps', 'car_vitals', 'main.js');
    const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'car_vitals', 'app.json'), 'utf8'));
    const l = fakeLink(units);
    const EventEmitter = require('events');
    class FakeDiag extends EventEmitter {
        constructor() { super(); this.available = true; this.p = {}; }
        init() { return Promise.resolve(this); }
        physical(a, b, c, d, e) { return l.physical(a, b, c, d, e); }
    }
    let app = null;
    const stubs = { './kit/mgu': { run(a) { app = a; } }, './kit/diag': { Diag: FakeDiag, hex: require(path.join(KIT, 'diag')).hex } };
    const load = Module._load;
    const timers = [];
    const realTimeout = global.setTimeout, realInterval = global.setInterval;
    Module._load = function (req, parent, isMain) {
        if (stubs[req]) return stubs[req];
        if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
        return load.call(this, req, parent, isMain);
    };
    // timers of the app: kept to clear at the end; its intervals not run (not needed here)
    global.setInterval = () => 0;
    global.setTimeout = (fn, ms) => { const h = realTimeout(fn, ms); timers.push(h); return h; };
    const dir = tmp('vitals-twin-'), logs = [], texts = [];
    let render = null;
    try {
        Object.keys(files || {}).forEach((f) => fs.writeFileSync(path.join(dir, f), JSON.stringify(files[f])));
        delete require.cache[MAIN];
        require(MAIN);
        const S = {};
        SPEC.settings.forEach((s) => { S[s.key] = s.default; });
        S.demo = 'off';
        Object.assign(S, opts.settings || {});
        const themes = require(path.join(KIT, 'themes'));
        const { Recorder } = require(path.join(KIT, 'record'));
        await app.start({
            ui: { onClick() {}, text() {}, image: async () => {} },
            settings: { get: (k) => S[k], onChange() {} },
            log: { info: (m) => logs.push(m), warn: (m) => logs.push('W ' + m), error: (m) => logs.push('E ' + m) }, spec: SPEC, dataDir: dir,
            signals: { watch: (iface) => Promise.resolve({ iface }) },
            onTab() {}, hideButton() {}, onScroll() {}, onTap() {}, loop(n, fps, fn) { render = fn; },
            theme: () => themes.theme('m_tricolour'),
            canvas: (w, h) => {
                const cv = new Recorder(w, h), text = cv.text.bind(cv);
                cv.own = true;
                cv.text = (str, x, y, size, c, o) => { texts.push({ str: String(str), c }); return text(str, x, y, size, c, o); };
                return cv;
            },
        });
        // the first engine unit poll comes 1 s after the start; misfires on that slow round
        const until = opts.until || /^raw misfires: /;
        if (opts.render) await render();          // the Engine page on screen: its boost read fast
        for (let i = 0; i < 80 && !logs.some((m) => until.test(m)); i++) await sleep(50);
        if (opts.render) { for (let i = 0; i < 6; i++) { await render(); await sleep(450); } texts.length = 0; await render(); }
        const line = logs.filter((m) => /^raw misfires: /.test(m))[0];
        return { counts: line ? JSON.parse(line.slice('raw misfires: '.length)) : null, logs, link: l, texts };
    } finally {
        timers.forEach((h) => clearTimeout(h));
        global.setTimeout = realTimeout; global.setInterval = realInterval;
        Module._load = load;
        rmTree(dir);
    }
}
/** an engine unit answering misfire monitors (service 06): mids [0xA2, ..] with counts, its MID A0 list, and its index */
function misUnit(index, mids, counts) {
    return (k, sid, data) => {
        if (k === '22 F150') return index ? f150(index) : [0x7F, 0x22, 0x31];
        if (sid !== 0x06) return sid === 0x22 ? [0x7F, 0x22, 0x31] : null;
        const mid = data[0];
        if (mid === 0xA0) {
            const bits = [0, 0, 0, 0];
            mids.concat([0xA1]).forEach((m) => { const i = m - 0xA1; bits[i >> 3] |= 0x80 >> (i & 7); });
            return [0x46, 0xA0].concat(bits);
        }
        const i = mids.indexOf(mid);
        if (i < 0) return [0x7F, 0x06, 0x31];
        // MID TID UaSID value min max: TID 0B (10 cycles), 0C (this cycle)
        return [0x46, mid, 0x0B, 0x24].concat(u16(99), u16(0), u16(0xFFFF), [mid, 0x0C, 0x24], u16(counts[i]), u16(0), u16(0xFFFF));
    };
}
const A = (n, from) => Array.from({ length: n }, (x, i) => (from || 0xA2) + i);

test('M Vitals: a V8\'s misfires, bank 2\'s from the second unit (its own ids or the engine\'s)', async () => {
    let r = await vitalsMisfires({ 0x12: misUnit(V8, A(4), [1, 2, 3, 4]), 0x13: misUnit(V8, A(4), [5, 6, 7, 8]) });
    assert.deepStrictEqual(r.counts, [1, 2, 3, 4, 5, 6, 7, 8], 'bank 2 numbered A2..A5 on its unit: ' + r.logs.join(' | '));
    r = await vitalsMisfires({ 0x12: misUnit(V8, A(4), [1, 2, 3, 4]), 0x13: misUnit(V8, A(4, 0xA6), [5, 6, 7, 8]) });
    assert.deepStrictEqual(r.counts, [1, 2, 3, 4, 5, 6, 7, 8], 'bank 2 numbered A6..A9: ' + r.logs.join(' | '));
    r = await vitalsMisfires({ 0x12: misUnit(V8, A(8), [1, 2, 3, 4, 5, 6, 7, 8]), 0x13: misUnit(V8, A(4), [9, 9, 9, 9]) });
    assert.deepStrictEqual(r.counts, [1, 2, 3, 4, 5, 6, 7, 8], 'the master lists all 8: those');
    assert.ok(!r.link.asked.some((k) => /^13:06/.test(k)), 'and the second unit is not asked: ' + r.link.asked.join());
    r = await vitalsMisfires({ 0x12: misUnit(V8, A(4), [1, 2, 3, 4]) });
    assert.deepStrictEqual(r.counts, [1, 2, 3, 4], 'the second unit silent: bank 1\'s, no failure');
});

/** an engine unit answering boost (22 F470, sensor A actual absolute: the kPa of each read in turn) and baro (22 F433) */
function boostUnit(index, kpa) {
    let n = 0;
    return (k) => {
        if (k === '22 F150') return index ? f150(index) : [0x7F, 0x22, 0x31];
        if (k === '22 F433') return [0x62, 0xF4, 0x33, 100];
        if (k === '22 F470') { const v = kpa[Math.min(n++, kpa.length - 1)] * 32; return [0x62, 0xF4, 0x70, 0x0F].concat(u16(v), u16(v), u16(0), u16(0)); }
        return k.slice(0, 2) === '22' ? [0x7F, 0x22, 0x31] : k.slice(0, 2) === '06' ? [0x7F, 0x06, 0x31] : null;
    };
}

test('M Vitals: a V8 bank 2 boost from the second unit, next to bank 1 on the Engine page', async () => {
    const twinFile = { 'twin_dme.json': { twin: true, index: V8 } }, on = { showBoost: 'on', page: 'engine' };
    const until = /^raw boost bank 2 F470: /, strs = (r) => r.texts.map((x) => x.str);
    // bank 1 at 1.0 then 1.2 bar (so it counts as real), bank 2 at 0.8: 0.4 apart, in the warning colour
    let r = await vitalsMisfires({ 0x12: boostUnit(V8, [200, 220]), 0x13: boostUnit(V8, [180]) }, twinFile, { settings: on, until, render: true });
    assert.ok(r.link.asked.indexOf('13:22 F470') >= 0, 'bank 2 asked: ' + asked13(r.link).join());
    assert.ok(!asked13(r.link).some((k) => k !== '13:22 F470'), 'and nothing else of it: ' + asked13(r.link).join());
    const i = strs(r).indexOf('Bank 2');
    assert.ok(i > 0, 'Bank 2 drawn: ' + strs(r).join(' | '));
    assert.strictEqual(r.texts[i - 1].str, '0.80', 'its boost before the label (drawn right to left)');
    const warn = require(path.join(KIT, 'themes')).theme('m_tricolour').warn;
    assert.strictEqual(r.texts[i - 1].c, warn, '0.4 bar apart: the warning colour');
    // the banks alike: the normal colour
    r = await vitalsMisfires({ 0x12: boostUnit(V8, [200, 220]), 0x13: boostUnit(V8, [215]) }, twinFile, { settings: on, until, render: true });
    const j = strs(r).indexOf('Bank 2');
    assert.ok(j > 0 && r.texts[j - 1].str === '1.15' && r.texts[j - 1].c !== warn, 'alike: ' + JSON.stringify(r.texts[j - 1]));
    // the second unit refusing boost: no Bank 2 readout
    r = await vitalsMisfires({ 0x12: boostUnit(V8, [200, 220]), 0x13: misUnit(V8, A(4), [0, 0, 0, 0]) }, twinFile, { settings: on, until, render: true });
    assert.ok(strs(r).indexOf('Bank 2') < 0, 'never answered: no readout');
    // Boost set to Hide: bank 2 not asked either
    r = await vitalsMisfires({ 0x12: boostUnit(V8, [200, 220]), 0x13: boostUnit(V8, [180]) }, twinFile,
        { settings: { showBoost: 'off', page: 'engine' }, until, render: true });
    assert.ok(!asked13(r.link).some((k) => /F470/.test(k)), 'hidden: ' + asked13(r.link).join());
});

test('M Vitals: a B58 (one unit) never asks 0x13', async () => {
    const r = await vitalsMisfires({ 0x12: misUnit(B58, A(6), [0, 1, 0, 0, 2, 0]), 0x13: misUnit(V8, A(4), [9, 9, 9, 9]) });
    assert.deepStrictEqual(r.counts, [0, 1, 0, 0, 2, 0]);
    assert.deepStrictEqual(asked13(r.link), []);
    // nor for boost with the Engine page on screen, even with a two-unit answer kept from another car
    const b = await vitalsMisfires({ 0x12: boostUnit(B58, [200, 220]), 0x13: boostUnit(V8, [180]) }, { 'twin_dme.json': { twin: true, index: V8 } },
        { settings: { showBoost: 'on', page: 'engine' }, until: /^engine units: /, render: true });
    assert.deepStrictEqual(asked13(b.link), []);
    assert.ok(b.texts.map((x) => x.str).indexOf('Bank 2') < 0, 'no Bank 2 on a B58');
});

/* ---------- Live Data: Useful lists ---------- */
test('Live Data Useful: V8-only and single-unit-only entries, bank 2\'s names, all in the built-in catalog', () => {
    const U = require(path.join(ROOT, 'apps', 'live_data', 'useful'));
    const cat = require(path.join(ROOT, 'apps', 'live_data', 'builtin', 'DME8FF_R.json'));
    const all = (groups) => [].concat.apply([], groups.map((g) => g.items));
    const names = (only) => all(U[0x12]).filter((i) => i.only === only).map((i) => i.name);
    assert.deepStrictEqual(names('twin'), ['Misfires, cylinder 7', 'Misfires, cylinder 8', 'Rough running, cylinder 7', 'Rough running, cylinder 8']);
    assert.deepStrictEqual(names('single'), ['Ignition angle, cylinder 5', 'Ignition angle, cylinder 6', 'Injector correction, cylinder 5', 'Injector correction, cylinder 6']);
    assert.deepStrictEqual(names('v12'), [], 'no V12 entries');
    assert.ok(!all(U[0x12]).some((i) => /cylinder (9|1[0-2])$/.test(i.name)), 'no cylinders 9..12');
    const b4 = all(U.BANK2(4)).map((i) => i.name);
    ['Ignition angle, cylinder 5', 'Ignition angle, cylinder 8', 'Injector correction, cylinder 8', 'Knock control retard (mean)', 'Fuel consumption']
        .forEach((n) => assert.ok(b4.indexOf(n) >= 0, n));
    assert.ok(b4.indexOf('Ignition angle, cylinder 9') < 0 && b4.indexOf('Ignition angle, cylinder 4') < 0);
    assert.deepStrictEqual(all(U.BANK2(6)).map((i) => i.name), b4, '4 a bank, whatever is asked');
    assert.deepStrictEqual(all(U.BANK2(0)).map((i) => i.name), b4, 'cylinders per bank not known: 4');
    // every identifier named is in the built-in catalog (the car is asked only those it lists)
    const ids = (items) => [].concat.apply([], items.map((i) => (i.c || []).concat(i.minus || []))).filter((c) => /^[0-9A-F]{4}(\/\d+)?$/.test(c)).map((c) => c.slice(0, 4));
    const missing = ids(all(U[0x12]).concat(all(U.BANK2(4)))).filter((d) => !cat[d]);
    assert.deepStrictEqual(missing, [], 'identifiers not in builtin/DME8FF_R.json');
    // a gauge's name for each is unique within a list (the Useful entry is found by it)
    [all(U[0x12]), all(U.BANK2(4))].forEach((l) => { const n = l.map((i) => i.name); assert.strictEqual(new Set(n).size, n.length); });
});

/* ---------- Live Data: the app on a V8 and on a B58 ---------- */
/**
 * Live Data started with a stand-in read-only link; returns { texts of each Engine page, link, logs, stop }.
 * units: { 0x12: answer, 0x13: answer } as fakeLink's; files: data/ files to start with.
 */
async function liveData(units, files) {
    const MAIN = path.join(ROOT, 'apps', 'live_data', 'main.js');
    const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'live_data', 'app.json'), 'utf8'));
    const l = fakeLink(units);
    l.stats = { sent: 0, ms: 0, timed: 0, missed: 0 };
    l.busy = 0;
    l.init = () => Promise.resolve(l);
    l.cancel = () => {};
    l.discover = () => Promise.resolve(new Map());
    class FakeRO { constructor() { return l; } }
    let app = null;
    const ro = require(path.join(KIT, 'readonly-diag'));
    const stubs = { './kit/mgu': { run(a) { app = a; } }, './kit/readonly-diag': { ReadOnlyDiag: FakeRO, MAX_DIDS: ro.MAX_DIDS, check: ro.check } };
    const load = Module._load;
    Module._load = function (req, parent, isMain) {
        if (stubs[req]) return stubs[req];
        if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
        return load.call(this, req, parent, isMain);
    };
    const realTimeout = global.setTimeout, realInterval = global.setInterval, handles = [];
    global.setInterval = (fn, ms) => { const h = realInterval(fn, ms); handles.push(['i', h]); return h; };
    global.setTimeout = (fn, ms) => { const h = realTimeout(fn, ms); handles.push(['t', h]); return h; };
    const dir = tmp('live-twin-'), logs = [];
    let visible = true, tab = null, stopped = false;
    const stop = () => {
        if (stopped) return;
        stopped = true; visible = false;
        handles.forEach((x) => (x[0] === 'i' ? clearInterval(x[1]) : clearTimeout(x[1])));
        global.setTimeout = realTimeout; global.setInterval = realInterval;
        Module._load = load;
    };
    try {
        Object.keys(files || {}).forEach((f) => fs.writeFileSync(path.join(dir, f), JSON.stringify(files[f])));
        delete require.cache[MAIN];
        require(MAIN);
        const S = {};
        SPEC.settings.forEach((s) => { S[s.key] = s.default; });
        S.demo = 'off';
        const themes = require(path.join(KIT, 'themes'));
        const { Recorder } = require(path.join(KIT, 'record'));
        let texts = [], frame = null;
        await app.start({
            ui: { onClick() {}, text() {}, image: async () => {}, isVisible: (n) => visible && n === 'MAIN', onVisible() {}, onFocus() {} },
            settings: { get: (k) => S[k], set: (k, v) => { S[k] = v; }, onChange() {} },
            log: { info: (m) => logs.push(m), warn: (m) => logs.push('W ' + m), error: (m) => logs.push('E ' + m) }, spec: SPEC, dataDir: dir,
            signals: { watch: (iface) => Promise.resolve({ iface, stop() {} }), hasNative: () => false },
            onTab(fn) { tab = fn; }, hideButton() {}, onScroll() {}, onLayout() {},
            loop(n, fps, fn) { frame = fn; return { kick() {} }; },
            theme: () => themes.theme('m_tricolour'),
            canvas: (w, h) => {
                const cv = new Recorder(w, h), text = cv.text.bind(cv);
                cv.text = (str, ...rest) => { texts.push(String(str)); return text(str, ...rest); };
                return cv;
            },
        });
        const draw = async () => { texts = []; await frame(); return texts.slice(); };
        /** every page of the Engine tab, each given a while to read what is in sight: their texts, one string */
        const engineTab = async () => {
            await draw();
            for (const ti of [3, 4]) {           // Gauges, (Trips), Signals, Energy, Engine, Units
                const pages = [];
                for (let i = 0; i < 16; i++) {
                    tab(ti);
                    await sleep(300);
                    const t = (await draw()).join('\n');
                    if (pages.indexOf(t) >= 0) break;
                    pages.push(t);
                }
                const all = pages.join('\n');
                if (/Ignition angle, cylinder 1/.test(all)) return all;      // (values the stand-in has no answer for are left out)
            }
            return '';
        };
        return { draw, engineTab, tab: (i) => tab(i), link: l, logs, stop, dir };
    } catch (e) { stop(); rmTree(dir); throw e; }
}
/** an engine unit for Live Data: identifiers -> data bytes (u16 raw unless given as an array); refused otherwise */
function ldUnit(index, values) {
    return (k, sid, data) => {
        if (k === '22 F150') return f150(index);
        if (sid === 0x22) {
            const did = k.slice(3), v = values[did];
            if (v === undefined) return [0x7F, 0x22, 0x31];
            return [0x62, data[0], data[1]].concat(Array.isArray(v) ? v : u16(v));
        }
        return [0x7F, sid, 0x12];
    };
}
// ignition angles: s8? the catalog decides; plain bytes that decode to something
const masterVals = { '4A49': [0x20], '4A4A': [0x21], '4A4C': [0x22], '4A4D': [0x23], '4A4E': [0x24], '4A4F': [0x25], '4B23': 1, '4B33': 7, '4B34': 8, '4A43': 3, '4A44': 4, '554C': [4], '5656': 1000 };
const slaveVals = { '4A49': [0x30], '4A4A': [0x31], '4A4C': [0x32], '4A4D': [0x33], '554C': [12], '5656': 1100 };

const errorsOf = (app) => app.logs.filter((m) => /^E |^W (read|tab|engine units|car signals)/.test(m));

test('Live Data: a V8 (kept from an earlier start): bank 2 on the Engine page, from 0x13', async () => {
    const app = await liveData({ 0x12: ldUnit(V8, masterVals), 0x13: ldUnit(V8, slaveVals) }, { 'twin_dme.json': { twin: true, index: V8 } });
    try {
        const all = await app.engineTab();
        assert.ok(all, 'the Engine tab');
        assert.deepStrictEqual(errorsOf(app), [], 'no errors');
        assert.ok(/BANK 2: IGNITION AND KNOCK/i.test(all), 'bank 2 header: ' + all.slice(0, 1500));
        ['Ignition angle, cylinder 5', 'Ignition angle, cylinder 8', 'Misfires, cylinder 8', 'Rough running, cylinder 7', 'Bank 1: Knock control retard (mean)']
            .forEach((n) => assert.ok(all.indexOf(n) >= 0, n));
        assert.ok(!/cylinder 9/.test(all), 'a V8: no cylinders 9 to 12');
        const ask13 = asked13(app.link);
        assert.ok(ask13.some((k) => /22 4A49/.test(k)), 'bank 2 ignition angle asked of 0x13: ' + ask13.slice(0, 20).join());
        assert.ok(!ask13.some((k) => /22 4B3[34]|22 4A4[34]/.test(k)), 'the whole engine counters not asked of 0x13');
        assert.ok(!app.link.asked.some((k) => /^12:22 (4A4E|4A4F|55B8|55B9)/.test(k)), 'the master cylinders 5 / 6 (bank 2) not asked');
    } finally { app.stop(); rmTree(app.dir); }
});

test('Live Data: a V8 found at run time (the master SGBD index), and remembered', async () => {
    const app = await liveData({ 0x12: ldUnit(V8, masterVals), 0x13: ldUnit(V8, slaveVals) });
    try {
        assert.ok(!fs.existsSync(path.join(app.dir, 'twin_dme.json')), 'nothing known at the start');
        await sleep(5300);                      // the question goes out every 5 s until answered
        const all = await app.engineTab();
        assert.ok(/BANK 2: IGNITION AND KNOCK/i.test(all), 'bank 2 after the answer');
        assert.ok(app.logs.some((m) => /engine units: SGBD index 0F242C -> two/.test(m)), app.logs.join(' | '));
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(app.dir, 'twin_dme.json'), 'utf8')), { twin: true, index: V8, wmi: null });
        assert.deepStrictEqual(errorsOf(app), [], 'no errors');
    } finally { app.stop(); rmTree(app.dir); }
});

test('Live Data: a B58: the Engine page as before, 0x13 never asked', async () => {
    // (no unit at 0x13 on a B58: a scan of the Units tab asks every address its type, nothing else)
    const app = await liveData({ 0x12: ldUnit(B58, masterVals) });
    try {
        await sleep(5300);                      // the twin question answered meanwhile
        const all = await app.engineTab();
        assert.ok(/Ignition angle, cylinder 6/.test(all), 'cylinder 6 on a B58');
        assert.ok(!/cylinder 7|BANK [12]/i.test(all), 'no V8 entries on a B58: ' + (all.match(/.*(cylinder 7|BANK 2).*/ig) || []).join(' / '));
        assert.deepStrictEqual(asked13(app.link).filter((k) => k !== '13:22 F150'), [], 'nothing asked of 0x13 but its type (a scan)');
        assert.ok(app.link.asked.indexOf('12:22 F150') >= 0, 'the engine unit asked which it is');
        assert.ok(app.logs.some((m) => /engine units: SGBD index 0F26E8 -> one/.test(m)));
        assert.deepStrictEqual(errorsOf(app), [], 'no errors');
    } finally { app.stop(); rmTree(app.dir); }
});

test('Live Data: an N74 V12 (not supported): as before the V8 work, its second unit found by a scan or not', async () => {
    const app = await liveData({ 0x12: ldUnit(N74, masterVals), 0x13: ldUnit(N74, slaveVals) });
    try {
        await sleep(5300);
        const all = await app.engineTab();
        assert.ok(/Ignition angle, cylinder 6/.test(all), 'cylinder 6 as on main');
        assert.ok(!/cylinder 7|BANK [12]/i.test(all), 'no V8 entries: ' + (all.match(/.*(cylinder 7|BANK 2).*/ig) || []).join(' / '));
        assert.deepStrictEqual(asked13(app.link).filter((k) => k !== '13:22 F150'), [], 'nothing asked of 0x13 but its type (a scan)');
        assert.ok(app.logs.some((m) => /engine units: SGBD index 0F1380 -> one/.test(m)));
        assert.ok(app.logs.some((m) => /unit 13: SGBD index 0F1380 -> MSD87_L0/.test(m)), 'the scan found the second unit: ' + app.logs.filter((m) => /unit 1[23]:/.test(m)).join(' | '));
        assert.deepStrictEqual(errorsOf(app), [], 'no errors');
    } finally { app.stop(); rmTree(app.dir); }
});

(async () => {
    let failed = 0;
    for (const [name, fn] of cases) {
        try { await fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); }
    }
    console.log('twin engine units: ' + cases.length + ' checks, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
})();
