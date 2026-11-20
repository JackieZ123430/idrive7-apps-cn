'use strict';

// Drag timer: RunTimer on synthetic speed traces, and the app's Splits / PEAK lines over two runs
// (kit modules stubbed, clock and timers driven by hand). No SDK, vehicle or capture needed:
//   node kit/tools/test_draggy.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ROOT = path.join(__dirname, '..', '..');
const { RunTimer } = require(path.join(ROOT, 'kit/runtime/run_timer'));

const SPLITS = [{ key: '0-50', from: 0, to: 50 }, { key: '0-100', from: 0, to: 100 }, { key: '100-200', from: 100, to: 200 },
    { key: '0-200', from: 0, to: 200 }, { key: 'qm', dist: 402.336 }];
let failed = 0;
const check = async (name, fn) => {
    try { await fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message.split('\n')[0]); }
};
const near = (a, b, tol, what) => assert(Math.abs(a - b) <= tol, what + ': ' + a + ' (want ' + b + ' +-' + tol + ')');

/** Standstill (idle every 50 ms, as the app), a creep to 1.2 km/h and back to 0, a wait, then 0-130 at 22 km/h/s. */
function creepThenLaunch(rollout, waitMs, creep) {
    const runs = [], tm = new RunTimer(SPLITS, { rollout, onDone: (r) => runs.push(r.result) });
    let t = 0;
    tm.feed(t, 0);
    for (; t < 2000; t += 50) tm.idle(t);
    assert.strictEqual(tm.state, 'ready');
    if (creep) { tm.feed(t, 1.0); t += 100; tm.feed(t, 1.2); t += 200; }
    if (creep !== 'held') tm.feed(t, 0);               // speed comes on change: one 0, then nothing
    const tStop = t;
    for (; t < tStop + waitMs; t += 50) tm.idle(t);
    tm.idle(t);
    const waiting = tm.state;
    const tl = t;
    for (let v = 0; v < 130;) { t += 100; v = Math.min(130, (t - tl) / 1000 * 22); tm.feed(t, v); tm.idle(t); }
    t += 100; tm.feed(t, 120);                          // lift
    return { waiting, runs };
}

// a creep that comes back to a standstill is no run: the launch after it is timed from its own start
for (const rollout of [false, true]) {
    for (const wait of [5000, 20000, 60000]) check('rollout ' + rollout + ': launch ' + wait / 1000 + ' s after a creep', () => {
        const r = creepThenLaunch(rollout, wait, 'stops');
        const what = 'rollout ' + rollout + ', launch ' + wait + ' ms after a creep';
        assert.strictEqual(r.runs.length, 1, what + ': one run saved, got ' + JSON.stringify(r.runs));
        // timed from 0.5 km/h (0.02 s in), or after the first foot (0.32 s in)
        near(r.runs[0]['0-50'], 50 / 22 - (rollout ? 0.32 : 0.02), 0.03, what + ': 0-50');
        near(r.runs[0]['0-100'], 100 / 22 - (rollout ? 0.32 : 0.02), 0.03, what + ': 0-100');
        assert.strictEqual(r.waiting, 'ready', what + ': armed again while standing');
    });
}
// a hill rollback (or a glitch) back to 0 and a launch at once: armed again straight away, the launch counts
for (const rollout of [false, true]) check('rollout ' + rollout + ': launch right after a rollback', () => {
    const r = creepThenLaunch(rollout, 0, 'stops');
    assert.strictEqual(r.runs.length, 1, 'one run saved, got ' + JSON.stringify(r.runs));
    near(r.runs[0]['0-100'], 100 / 22 - (rollout ? 0.32 : 0.02), 0.03, '0-100');
});
// a lone 0 sample at speed (a signal glitch) is no creep: the run ends with no result, nothing new launches from it
for (const rollout of [false, true]) check('rollout ' + rollout + ': a 0 sample at 40 km/h saves no run', () => {
    const runs = [], tm = new RunTimer(SPLITS, { rollout, onDone: (r) => runs.push(r.result) });
    let t = 0;
    tm.feed(t, 0);
    for (; t < 2000; t += 50) tm.idle(t);
    for (let v = 0; v < 40;) { t += 100; v = Math.min(40, (t - 2000) / 1000 * 22); tm.feed(t, v); tm.idle(t); }
    t += 100; tm.feed(t, 0);
    for (let v = 40; v < 130;) { t += 100; v += 2.2; tm.feed(t, v); tm.idle(t); }
    t += 100; tm.feed(t, 120);                          // lift: a run would end and be saved here
    assert.deepStrictEqual(runs, [], 'a false best: ' + JSON.stringify(runs));
});
// a creep that never sends its stop (speed held at 1.2 km/h): the 40 s limit still ends it, also before the rollout foot
for (const rollout of [false, true]) check('rollout ' + rollout + ': a held creep times out', () => {
    const r = creepThenLaunch(rollout, 60000, 'held');
    assert.notStrictEqual(r.waiting, 'run', 'still timing 60 s after the creep');
});
// a plain launch from a standstill
for (const rollout of [false, true]) check('rollout ' + rollout + ': plain launch', () => {
    const r = creepThenLaunch(rollout, 0, false);
    assert.strictEqual(r.runs.length, 1);
    near(r.runs[0]['0-100'], 100 / 22 - (rollout ? 0.32 : 0.02), 0.03, '0-100');
});

/* ---------- the app: Splits line and PEAK g per run ---------- */
const kit = path.join(ROOT, 'kit/runtime');
const { Recorder } = require(path.join(kit, 'record'));
const themes = require(path.join(kit, 'themes'));
const tmps = [];      // the app's data dirs, removed on exit
const tmpDir = (pre) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), pre)); tmps.push(d); return d; };
process.on('exit', () => tmps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
let app = null, now = 0, ticks = [];
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req === './kit/mgu') return { run: (a) => { app = a; } };
    if (req.startsWith('./kit/')) return load.call(this, path.join(kit, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
Date.now = () => now;
const realInterval = global.setInterval;
global.setInterval = (fn) => { ticks.push(fn); return 0; };
require(path.join(ROOT, 'apps/draggy/main'));
global.setInterval = realInterval;
Module._load = load;

(async () => {
    const watch = {}, texts = [];
    let render = null;
    const vals = { speedUnit: 'kmh', distance: 'qm', rollout: false, speedRate: 10, demo: 'off', theme: 'm_tricolour' };
    const one = { factor: 1, offset: 0 };
    const ctx = {
        ui: { image: async () => {}, text() {}, onClick() {} },
        settings: { get: (k) => vals[k], onChange() {} },
        log: { info() {}, warn() {}, error() {} },
        spec: { config: { scaling: { speed: one, accel: one, rpm: one } } },
        dataDir: tmpDir('draggy-'),
        theme: () => themes.theme(vals.theme),
        canvas: (w, h) => { const cv = new Recorder(w, h), text = cv.text.bind(cv); cv.text = (s, ...a) => { texts.push(String(s)); return text(s, ...a); }; return cv; },
        signals: { watch: (iface, v, h) => { Object.assign(watch, h); return Promise.resolve({ available: true }); } },
        onTab() {}, hideButton() {}, loop(n, fps, fn) { render = fn; },
    };
    await app.start(ctx);
    const step = (kmh, g) => {
        now += 20;
        if (g !== undefined) watch.statusLongitudinalAccelerationMassCenter({ longitudinalAccelerationCentreOfGravity: g * 9.80665 });
        if (kmh !== undefined) watch.statusCarSpeed2({ speedVehicleCentreOfGravity: kmh });
        ticks.forEach((f) => f());
    };
    const screen = async () => { texts.length = 0; await render(); return texts.slice(); };
    // stand 2 s, launch at rate km/h/s with peak g, stop at 120 (or keep going: stopAt), lift, roll to a stop
    async function run(rate, g, stopAt) {
        for (let i = 0; i < 100; i++) step(i % 5 ? undefined : 0);
        const t0 = now;
        let v = 0;
        while (v < stopAt) { now += 80; v = Math.min(stopAt, (now - t0) / 1000 * rate); step(v, g); }
        return screen();
    }
    let s = await run(22, 0.95, 120);
    for (let v = 110; v >= 0; v -= 10) step(v, -0.3);
    s = await screen();
    await check('app: run 1 sets the best times and its peak', () => {
        assert(s.includes('NEW BEST'));
        assert(s.includes('PEAK 0.95 g'));
    });
    // run 2, slower: during it, its splits are compared with run 1's, its peak is its own
    s = await run(20, 0.5, 115);
    await check('app: run 2 (slower) shows "+0.45 vs best", not NEW BEST', () => {
        assert(!s.includes('NEW BEST'), 'got ' + s.filter((x) => /best/i.test(x)).join(' | '));
        assert(s.some((x) => /^\+0\.4\d {2}vs best 4\.5\d$/.test(x)), 'got ' + s.filter((x) => /best/i.test(x)).join(' | '));
    });
    await check('app: run 2 shows its own PEAK g', () => assert(s.includes('PEAK 0.50 g'), 'got ' + s.filter((x) => /PEAK/.test(x)).join(' | ')));
    console.log(failed ? failed + ' failed' : 'draggy: all ok');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
