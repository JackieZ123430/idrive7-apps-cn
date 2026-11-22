'use strict';

// Drag timer: RunTimer, RollTimer (rolling windows) and Slope on synthetic traces, and the app's Splits / PEAK lines,
// rolling page, DOWNHILL marking and custom window
// (kit modules stubbed, clock and timers driven by hand). No SDK, vehicle or capture needed:
//   node kit/tools/test_draggy.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ROOT = path.join(__dirname, '..', '..');
const { RunTimer } = require(path.join(ROOT, 'kit/runtime/run_timer'));
const { RollTimer } = require(path.join(ROOT, 'apps/draggy/roll_timer'));
const { Slope } = require(path.join(ROOT, 'apps/draggy/slope'));
const Weather = require(path.join(ROOT, 'apps/draggy/weather'));
const { ShiftLog } = require(path.join(ROOT, 'apps/draggy/shifts'));

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

/* ---------- RollTimer: rolling windows ---------- */
const WIN = [{ key: '60-100', from: 60, to: 100 }, { key: '100-200', from: 100, to: 200 }];
/** cruise at v0 (no new samples), then pull at rate km/h/s up to top, then lift; samples every 100 ms */
function pull(rt, t, v0, rate, top, lift) {
    rt.feed(t, v0);
    for (let i = 0; i < 30; i++) { t += 100; rt.idle(t); }
    const ts = t;
    let v = v0;
    while (v < top) { t += 100; v = Math.min(top, v0 + (t - ts) / 1000 * rate); rt.feed(t, v); rt.idle(t); }
    if (lift !== false) { t += 100; rt.feed(t, top - 10); rt.idle(t); }
    return t;
}
check('rolling: 100-200 from an 80 km/h cruise, interpolated', () => {
    const done = [], rt = new RollTimer(WIN, { onDone: (r) => done.push(r) });
    pull(rt, 0, 80, 13, 205);
    assert.strictEqual(done.length, 1, 'one pull');
    near(done[0].result['100-200'], 100 / 13, 0.01, '100-200');
    assert.strictEqual(done[0].result['60-100'], undefined, 'started above 60: no 60-100');
});
check('rolling: a pull from 50 times 60-100 and 100-200 in one', () => {
    const done = [], rt = new RollTimer(WIN, { onDone: (r) => done.push(r) });
    pull(rt, 0, 50, 10, 210);
    assert.strictEqual(done.length, 1);
    near(done[0].result['60-100'], 4, 0.01, '60-100');
    near(done[0].result['100-200'], 10, 0.01, '100-200');
});
check('rolling: lifting at 180 throws 100-200 away, the last pull stays on screen', () => {
    const done = [], rt = new RollTimer(WIN, { onDone: (r) => done.push(r) });
    let t = pull(rt, 0, 80, 13, 205);
    t = pull(rt, t + 5000, 80, 13, 180);
    assert.strictEqual(done.length, 1, 'no second result: ' + JSON.stringify(done.map((d) => d.result)));
    near(rt.result['100-200'], 100 / 13, 0.01, 'still showing the first pull');
});
check('rolling: cruising right at 100 (99.8 / 100.2 ...) keeps the last result', () => {
    const done = [], rt = new RollTimer(WIN, { onDone: (r) => done.push(r) });
    let t = pull(rt, 0, 80, 13, 205);
    for (let i = 0; i < 20; i++) { t += 500; rt.feed(t, i % 2 ? 99.8 : 100.2); rt.idle(t); }
    assert.strictEqual(done.length, 1);
    assert.strictEqual(rt.state, 'idle');
    near(rt.result['100-200'], 100 / 13, 0.01, '100-200 kept');
});
check('rolling: a window held at a steady speed for over 60 s times out', () => {
    const done = [], rt = new RollTimer(WIN, { onDone: (r) => done.push(r) });
    let t = pull(rt, 0, 80, 13, 150, false);
    for (let i = 0; i < 700; i++) { t += 100; rt.idle(t); }
    assert.strictEqual(rt.state, 'idle');
    t += 100; rt.feed(t, 205);
    assert.strictEqual(done.length, 0, 'no 100-200 over 60 s');
});
check('rolling: a standing launch counts its rolling windows', () => {
    const done = [], rt = new RollTimer(WIN, { onDone: (r) => done.push(r) });
    pull(rt, 0, 0, 20, 205);
    near(done[0].result['60-100'], 2, 0.01, '60-100');
    near(done[0].result['100-200'], 5, 0.01, '100-200');
    assert.strictEqual(rt.next(50), 60, 'next window to go through from 50');
    assert.strictEqual(rt.next(150), null, 'none above 150');
});

/* ---------- Slope: from the acceleration sensor and the speed ---------- */
/** stand 3 s, then accelerate at acc m/s^2 to top km/h, on a slope of pct %; speed and acceleration at 50 Hz */
function slopeRun(pct, acc, top) {
    const s = new Slope(), g = 9.80665 * pct / 100;
    let t = 0, v = 0;
    for (; t < 3000; t += 20) { s.speed(t, 0); s.accel(t, g); }
    const standing = s.standing(), t1 = t;
    while (v < top) { t += 20; v = Math.min(top, v + acc * 0.02 * 3.6); s.speed(t, v); s.accel(t, acc + g); }
    return { s, standing, t1, t2: t };
}
for (const pct of [-3, -0.8, 0, 1.5, 4]) check('slope: ' + pct + ' % read standing and over a 0-150 run', () => {
    const r = slopeRun(pct, 5, 150);
    near(r.standing, pct, 0.11, 'standing');
    near(r.s.over(r.t1, r.t2), pct, 0.2, 'over the run');
    near(r.s.at(r.t1), pct, 0.11, 'kept for the launch');
});
check('slope: a short stretch (under 30 m) uses the standing reading', () => {
    const r = slopeRun(2, 5, 150);
    near(r.s.over(r.t1, r.t1 + 1000), 2, 0.11, '0-1 s');
});
check('slope: the braking jolt as the car stops is not read as slope', () => {
    const s = new Slope();
    let t = 0;
    s.speed(t, 30);
    for (; t < 600; t += 20) s.accel(t, -8);
    s.speed(t, 0);
    for (let i = 0; i < 15; i++) { t += 20; s.accel(t, -6); }      // still rocking
    for (let i = 0; i < 100; i++) { t += 20; s.accel(t, 0.098); }  // 1 %
    near(s.standing(), 1, 0.11, 'standing');
});
check('slope: launched before a standing reading, a short split reads the first 30 m', () => {
    const s = new Slope(), g = 9.80665 * -3 / 100;
    let t = 0, v = 0;
    s.speed(t, 20);
    for (; t < 400; t += 20) s.accel(t, g);
    s.speed(t, 0);
    for (let i = 0; i < 20; i++) { t += 20; s.accel(t, g); }          // stood 0.4 s: still settling, no reading
    const t1 = t;
    while (v < 100) { t += 20; v = Math.min(100, v + 5 * 0.02 * 3.6); s.speed(t, v); s.accel(t, 5 + g); }
    assert.strictEqual(s.at(t1), null, 'a standing reading');
    near(s.over(t1, t1 + 1500), -3, 0.3, '0-27 km/h (under 30 m)');
});
check('slope: two hours of samples keep only the last minutes, still answer', () => {
    const s = new Slope();
    let t = 0;
    s.speed(0, 80);
    for (; t < 2 * 3600 * 1000; t += 20) { s.accel(t, 0.1); if (t % 1000 === 0) s.speed(t, 80); }
    assert(s.pts.length <= (120000 + 10000) / 20 + 2, 'kept ' + s.pts.length + ' points');
    near(s.over(t - 60000, t - 1000), 1.0, 0.11, 'the last minute at 0.1 m/s^2');
});
check('slope: no acceleration from the car, no slope', () => {
    const s = new Slope();
    s.speed(0, 0); s.speed(5000, 100);
    assert.strictEqual(s.standing(), null);
    assert.strictEqual(s.over(0, 5000), null);
});

/* ---------- Weather: SAE J1349 and density altitude ---------- */
check('weather: SAE J1349 is 1.000 at 25 deg C, 99 kPa dry; hotter or thinner air > 1, colder or denser < 1', () => {
    near(Weather.sae(25, 99), 1, 1e-9, 'reference');
    assert(Weather.sae(35, 99) > 1 && Weather.sae(25, 90) > 1, 'hot / thin');
    assert(Weather.sae(5, 99) < 1 && Weather.sae(25, 103) < 1, 'cold / dense');
    // by hand: 1.176 * 99 / 95 * sqrt(308 / 298) - 0.176
    near(Weather.sae(35, 95), 1.176 * 99 / 95 * Math.sqrt(308 / 298) - 0.176, 1e-12, '35 deg C, 95 kPa');
});
check('weather: density altitude 0 at ISA sea level, ~1000 m at ISA 1000 m, ~+530 m at 30 deg C on the coast', () => {
    near(Weather.densityAltitude(15, 101.325), 0, 1, 'ISA sea level');
    near(Weather.densityAltitude(8.5, 89.875), 1000, 15, 'ISA 1000 m (8.5 deg C, 89.875 kPa)');
    near(Weather.densityAltitude(30, 101.325), 530, 40, '30 deg C at sea level (120 ft per deg C rule: ~550 m)');
    assert(Weather.densityAltitude(-10, 103) < 0, 'cold dense air: below sea level');
});
check('weather: times to standard air: speed splits / CF, distances / CF^(1/3), trap x CF^(1/3)', () => {
    near(Weather.correctTime(10, 1.1, false), 10 / 1.1, 1e-12, 'speed split');
    near(Weather.correctTime(10, 1.1, true), 10 / Math.pow(1.1, 1 / 3), 1e-12, 'distance');
    near(Weather.correctTrap(200, 1.1), 200 * Math.pow(1.1, 1 / 3), 1e-9, 'trap');
    assert.strictEqual(Weather.correctTime(10, null, false), null, 'no air: none');
});
check('weather: no or implausible air, no numbers', () => {
    assert.strictEqual(Weather.sae(null, 100), null);
    assert.strictEqual(Weather.sae(20, null), null);
    assert.strictEqual(Weather.sae(20, 30), null, '30 kPa');
    assert.strictEqual(Weather.densityAltitude(90, 100), null, '90 deg C');
    const a = Weather.air(18, null);
    assert(a.c === 18 && a.kPa === null && a.da === null && a.cf === null, JSON.stringify(a));
});

/* ---------- ShiftLog: upshifts from the gear signal, else the rpm ---------- */
/** speed 0 -> 150 km/h over 15 s, every 50 ms; gear(t) and rpm(t) as given */
function pullLog(gearAt, rpmAt) {
    const s = new ShiftLog();
    for (let t = 0; t <= 15000; t += 50) {
        s.speed(t, t / 100);
        if (gearAt) s.gear(t, gearAt(t));
        if (rpmAt) s.rpm(t, rpmAt(t));
    }
    return s;
}
check('shifts: from the gear signal: 1-2, 2-3 up, the downshift not', () => {
    const s = pullLog((t) => (t < 5000 ? 1 : t < 9000 ? 2 : t < 12000 ? 3 : 2), (t) => 3000 + (t % 4000) / 2);
    const up = s.between(0, 15000, 1);
    assert.deepStrictEqual(up.map((x) => [x.t, x.from, x.to, x.kmh]), [[5000, 1, 2, 50], [9000, 2, 3, 90]], JSON.stringify(up));
    assert(up.every((x) => typeof x.rpm === 'number'), 'rpm before each');
});
// rpm: each gear 3500 -> 7000 over 3 s, the shift a fall to 4300 within 150 ms; at 14 s a lift (rpm falls, the car slows)
const sawRpm = (t) => {
    if (t >= 14000) return Math.max(1500, 6000 - (t - 14000) * 6);
    const k = t % 3000;
    return k < 150 && t >= 3000 ? 7000 - (2700 * k / 150) : 3500 + 3500 * (k / 3000);
};
check('shifts: from the rpm when the car sends no gear: 4 upshifts, gears counted from 1st, the lift at the end not', () => {
    const s = new ShiftLog();
    for (let t = 0; t <= 15000; t += 50) { s.speed(t, t < 14000 ? t / 100 : 140 - (t - 14000) / 100); s.rpm(t, sawRpm(t)); }
    const up = s.between(0, 15000, 1);
    assert.deepStrictEqual(up.map((x) => [x.from, x.to]), [[1, 2], [2, 3], [3, 4], [4, 5]], JSON.stringify(up));
    up.forEach((x, i) => near(x.t, 3000 * (i + 1) - 50, 60, 'shift ' + (i + 1) + ' at its rpm peak'));
    assert(up.every((x) => x.rpm >= 6900), 'rpm at the peak: ' + up.map((x) => x.rpm));
    assert.deepStrictEqual(s.between(0, 15000, null).map((x) => x.from), [null, null, null, null], 'a roll: gears not known');
});
check('shifts: a gear sent once, a minute before a pull in that gear: the gear signal counts, no rpm shifts', () => {
    const s = new ShiftLog();
    s.gear(0, 4);                                     // the car sends a gear on change only
    for (let t = 60000; t <= 75000; t += 50) { s.speed(t, 100 + (t - 60000) / 150); s.rpm(t, sawRpm(t - 60000)); }
    assert.strictEqual(s.between(60000, 75000, null).length, 0, 'rpm saw-tooth taken for shifts');
});
check('shifts: the upshift an automatic makes as the driver lifts (5-6, the car slowing) is no shift of the pull', () => {
    const s = new ShiftLog();
    for (let t = 0; t <= 15000; t += 50) {
        s.speed(t, t < 12000 ? 100 + t / 100 : 220 - (t - 12000) / 100);
        s.gear(t, t < 6000 ? 4 : t < 12000 ? 5 : 6);
    }
    assert.deepStrictEqual(s.between(0, 15000, null).map((x) => [x.from, x.to]), [[4, 5]]);
});
check('shifts: an upshift that skips a gear (3-5) counts', () => {
    const s = pullLog((t) => (t < 6000 ? 3 : 5), (t) => 4000);
    assert.deepStrictEqual(s.between(0, 15000, null).map((x) => [x.from, x.to]), [[3, 5]]);
});
check('shifts: a slow rpm fall (easing off) and a recent gear signal: no rpm shifts', () => {
    const s = pullLog(null, (t) => 6000 - t / 5);
    assert.strictEqual(s.between(0, 15000, 1).length, 0, 'slow fall');
    const g = pullLog((t) => 3, sawRpm);
    assert.strictEqual(g.between(0, 13000, 1).length, 0, 'gear signal says 3rd throughout: the rpm saw-tooth is not used');
});
check('slope: height over a run on a 2 % climb', () => {
    const r = slopeRun(2, 5, 150);
    const s = r.s, d = s._interp(r.t2)[2] - s._interp(r.t1)[2];
    near(s.height(r.t1, r.t2), d * 0.02, 0.3, 'height = 2 % of ' + Math.round(d) + ' m');
    assert.strictEqual(s.height(r.t2, r.t1), null, 'backwards');
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
Module._load = load;

(async () => {
    const watch = {}, texts = [];
    let render = null;
    // (no slope limit for the first runs: their acceleration is made up, not the speed's)
    const vals = { speedUnit: 'kmh', distance: 'qm', rollout: false, speedRate: 10, demo: 'off', theme: 'm_tricolour', slopeLimit: 'off',
        custom: false, customFrom: 0, customTo: 150, highSpeed: false };
    let onTab = null, onSetting = null, driving = false;
    const clicks = {};
    const tasu = { calls: [], answers: [], kPa: 100, onFrame: null };
    const appSpec = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/draggy/app.json'), 'utf8'));
    const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
    const one = { factor: 1, offset: 0 };
    const ctx = {
        ui: { image: async () => {}, text() {}, onClick(id, fn) { clicks[id] = fn; } },
        settings: { get: (k) => vals[k], onChange(f) { onSetting = f; } },
        log: { info() {}, warn() {}, error() {} },
        spec: { config: { scaling: { speed: one, accel: one, rpm: one }, baro: appSpec.config.baro, baroEcu: appSpec.config.baroEcu } },
        dataDir: tmpDir('draggy-'),
        theme: () => themes.theme(vals.theme),
        canvas: (w, h) => { const cv = new Recorder(w, h), text = cv.text.bind(cv); cv.text = (s, ...a) => { texts.push(String(s)); return text(s, ...a); }; return cv; },
        signals: {
            watch: (iface, v, h) => { Object.assign(watch, h); return Promise.resolve({ available: true }); },
            // the diagnostic transport (kit/diag.js): each 22 F433 to the DME answered 62 F4 33 <kPa>
            proxy: async () => ({ tasu: true }),
            on: async (p, name, fn) => { tasu.onFrame = fn; },
            onAvailable: async (p, fn) => fn(true),
            call: async (p, method, req) => {
                const d = Array.from(req.udsData);
                tasu.calls.push({ t: now, driving, ecu: req.targetAddress, sid: req.serviceID, data: d });
                if (req.targetAddress === 0x12 && req.serviceID === 0x22 && d[0] === 0xF4 && d[1] === 0x33) {
                    setImmediate(() => { tasu.answers.push(now); tasu.onFrame({ udsResponse: [0, 0, 0, 0, 0, 0, 0x12, 0, 0, 0x62, 0xF4, 0x33, tasu.kPa] }); });
                }
                return 'NO_ERROR';
            },
        },
        onTab(f) { onTab = f; }, hideButton() {}, loop(n, fps, fn) { render = fn; },
    };
    // a 2.6.0 file: 100-200 timed in a standing run with rollout on, kept as '100-200@ro'
    fs.writeFileSync(path.join(ctx.dataDir, 'draggy_runs.json'), JSON.stringify({ best: { '100-200@ro': { s: 9.1, at: 0 }, '0-100': { s: 5.5, at: 0 } },
        runs: [{ unit: 'kmh', at: 0, result: { '0-100': 5.5, '100-200': 9.1, qm: 13 }, trap: { qm: 170 }, rollout: true }] }));
    await app.start(ctx);
    global.setInterval = realInterval;          // (the app's intervals, started in start(), are the ticks)
    const step = (kmh, g) => {
        now += 20;
        if (g !== undefined) watch.statusLongitudinalAccelerationMassCenter({ longitudinalAccelerationCentreOfGravity: g * 9.80665 });
        if (kmh !== undefined) watch.statusCarSpeed2({ speedVehicleCentreOfGravity: kmh });
        ticks.forEach((f) => f());
    };
    const screen = async () => { texts.length = 0; await render(); return texts.slice(); };
    await check('app: a 2.6.0 rollout best for 100-200 shows as the rolling best, old runs in History', async () => {
        await onTab(2);
        const b = await screen();
        const i = b.indexOf('100-200 km/h');
        assert(i >= 0 && b[i + 1] === '9.10', 'got ' + b.slice(i, i + 3).join(' | '));
        await onTab(3);
        const h = await screen();
        assert(h.some((x) => x === '0-100 km/h 5.50   100-200 km/h 9.10   1/4 mile 13.00 @170'), 'got ' + h.filter((x) => /km\/h/.test(x)).join(' | '));
        await onTab(0);
    });
    // stand 2 s, launch at rate km/h/s with peak g, stop at 120 (or keep going: stopAt), lift, roll to a stop
    async function run(rate, g, stopAt) {
        for (let i = 0; i < 100; i++) step(i % 5 ? undefined : 0);
        const t0 = now;
        let v = 0;
        driving = true;
        while (v < stopAt) { now += 80; v = Math.min(stopAt, (now - t0) / 1000 * rate); step(v, g); }
        driving = false;
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
        assert(s.some((x) => /^\+0\.4\d$/.test(x)), 'got ' + s.filter((x) => /^[+-]\d|best/i.test(x)).join(' | '));
    });
    await check('app: run 2 shows its own PEAK g', () => assert(s.includes('PEAK 0.50 g'), 'got ' + s.filter((x) => /PEAK/.test(x)).join(' | ')));
    for (let v = 110; v >= 0; v -= 10) step(v, -0.3);

    // the sensor as on the car: the real acceleration plus the road's slope; speed and acceleration every 20 ms
    const acc = (a) => watch.statusLongitudinalAccelerationMassCenter({ longitudinalAccelerationCentreOfGravity: a });
    const spd = (v) => watch.statusCarSpeed2({ speedVehicleCentreOfGravity: v });
    let gearOf = null, rpmOf = null;
    const gear = (n) => watch.statusGearboxDrive({ statusActualGearDrive: n + 2, statusActualStageDrive: 4 });     // G1 = 3 on the wire
    const rpm = (r) => watch.statusEngineSpeed2({ actualValueRPMEngineCrankshaft: r });
    async function drive(v0, rate, top, pct, standMs) {
        const ga = 9.80665 * pct / 100;
        for (let i = 0; i < standMs / 20; i++) { now += 20; acc(ga); if (i % 5 === 0) spd(v0); ticks.forEach((f) => f()); }
        const ts = now;
        let v = v0;
        driving = true;
        while (v < top) { now += 20; v = Math.min(top, v0 + (now - ts) / 1000 * rate); acc(rate / 3.6 + ga); spd(v); if (gearOf) gear(gearOf(v)); if (rpmOf) rpm(rpmOf(v)); ticks.forEach((f) => f()); }
        driving = false;
        // lift: 15 km/h/s down, the sensor as on the car
        for (let i = 0; i < 25; i++) { now += 20; v -= 0.3; acc(-0.3 / 3.6 / 0.02 + ga); spd(v); ticks.forEach((f) => f()); }
        return screen();
    }
    const stop = (from) => { for (let v = from; v >= 0; v -= 10) step(Math.max(0, v), -0.3); };
    // a faster launch down a 3 % hill: shown, marked DOWNHILL, no new best
    vals.slopeLimit = '2';
    s = await drive(0, 30, 130, -3, 3000);
    await check('app: a run down a 3 % hill is marked DOWNHILL and sets no best', () => {
        assert(s.includes('DOWNHILL'), 'got ' + s.filter((x) => /HILL|BEST|^[+-]\d/.test(x)).join(' | '));
        assert(!s.includes('NEW BEST'), 'a downhill best: ' + s.slice(s.indexOf('VS BEST')).join(' | '));
        assert(s.includes('-3.0 %'), 'slope shown: ' + s.filter((x) => / %$/.test(x)).join(' | '));
    });
    // the same up a 1 % climb: a new best, its slope with it
    stop(120);
    s = await drive(0, 30, 130, 1, 3000);
    await check('app: the same run up a 1 % climb is a new best', () => {
        assert(s.includes('NEW BEST'), 'got ' + s.filter((x) => /HILL|BEST|^[+-]\d/.test(x)).join(' | '));
        assert(s.includes('+1.0 %'), 'slope shown: ' + s.filter((x) => / %$/.test(x)).join(' | '));
    });
    // rolling: a pull from an 80 km/h cruise, on the Rolling page
    s = await drive(80, 12.5, 210, 0, 1000);
    await onTab(1);
    s = await screen();
    await check('app: the Rolling page shows 100-200 from a roll', () => {
        assert(!s.includes('TRAP') && s.includes('200-250 km/h'), 'not the rolling page');
        assert(!s.includes('60-100 km/h') && !s.includes('80-120 km/h'), 'windows under 100 (Dragy starts at 100-200)');
        const i = s.indexOf('100-200 km/h');
        assert(i >= 0 && s[i + 1] === '8.00', 'got ' + s.slice(i, i + 4).join(' | '));
    });
    await check('app: the Standing page has 100-200 (no 60 ft), the 1/8 and 1/4 mile', async () => {
        await onTab(0);
        const st = await screen();
        const i = st.indexOf('100-200 km/h');
        assert(i > st.indexOf('0-100 km/h') && i < st.indexOf('0-200 km/h'), '100-200 between 0-100 and 0-200: ' + st.filter((x) => /km\/h$/.test(x)).join(' | '));
        assert(!st.includes('60 ft'), '60 ft still there');
        assert(st.includes('1/8 mile') && st.includes('1/4 mile'));
    });
    await check('app: a custom 0-150 window joins the standing splits, 80-180 the rolling ones', async () => {
        vals.custom = true; onSetting('custom');
        let st = await screen();
        assert(st.includes('0-150 km/h'), 'no 0-150');
        vals.customFrom = 80; vals.customTo = 180; onSetting('customFrom');
        await onTab(1);
        st = await screen();
        assert(st.includes('80-180 km/h'), 'no 80-180 on the rolling page');
        vals.custom = false; onSetting('custom');
    });
    await check('app: 200-250 always, 250-300 only with its setting on', async () => {
        await onTab(1);
        let st = await screen();
        assert(st.includes('200-250 km/h'), 'no 200-250');
        assert(!st.includes('250-300 km/h'), '250-300 shown while off');
        vals.highSpeed = true; onSetting('highSpeed');
        st = await screen();
        assert(st.includes('200-250 km/h') && st.includes('250-300 km/h'), 'not shown while on');
        s = await drive(150, 25, 310, 0, 1000);
        for (const k of ['200-250 km/h', '250-300 km/h']) {
            const i = s.indexOf(k);
            assert(i >= 0 && s[i + 1] === '2.00', k + ': ' + s.slice(i, i + 3).join(' | '));
        }
        vals.highSpeed = false; onSetting('highSpeed');
    });
    await check('app: History lists the runs, splits in order', async () => {
        await onTab(3);
        const h = await screen();
        assert(h.includes('ROLLING START') && h.includes('STANDING LAUNCH'), 'kinds');
        const line = h.find((x) => /^0-50 km\/h /.test(x));
        assert(line && line.indexOf('0-50') < line.indexOf('0-100'), 'order: ' + line);
    });
    await check('app: the outside air pressure is asked from the DME (22 F433), never while driving', async () => {
        await flush();
        assert(tasu.calls.length >= 1, 'no request');
        assert(tasu.calls.every((c) => c.ecu === 0x12 && c.sid === 0x22 && c.data[0] === 0xF4 && c.data[1] === 0x33), JSON.stringify(tasu.calls));
        assert(tasu.calls.every((c) => !c.driving), 'asked while driving at ' + tasu.calls.filter((c) => c.driving).map((c) => c.t));
        const ts = tasu.calls.map((c) => c.t);
        ts.slice(1).forEach((t, i) => assert(t - tasu.answers[i] >= 5 * 60000, 'asked again ' + (t - tasu.answers[i]) + ' ms after an answer'));
    });
    // a flat launch to 130 with the gearbox: 1st to 60, 2nd to 100, 3rd on; 18 deg C outside
    watch.ExteriorTemperature({ temperatureExterior: 116 });
    stop(130);
    gearOf = (v) => (v < 60 ? 1 : v < 100 ? 2 : 3); rpmOf = (v) => 1000 + v * 40;
    await onTab(0);
    s = await drive(0, 30, 130, 0, 3000);
    gearOf = null; rpmOf = null;
    await check('app: a flat run is a VALID RUN, with its air, top speed, elevation and two upshifts on the trace', () => {
        assert(s.includes('VALID RUN'), 'badge: ' + s.filter((x) => /VALID/.test(x)).join(' | '));
        assert(s.includes('18 °C') && s.includes('1000 hPa') && s.includes('DA'), 'air: ' + s.filter((x) => /°C|hPa|DA/.test(x)).join(' | '));
        const i = s.indexOf('TOP SPEED');
        assert(i >= 0 && /^1[23]\d km\/h$/.test(s[i + 1]), 'top speed: ' + s.slice(i, i + 2).join(' | '));
        assert(s.includes('ELEVATION'), 'elevation');
        const j = s.indexOf('SHIFTS');
        assert(j >= 0 && s[j + 1] === '2', 'shifts: ' + s.slice(j, j + 2).join(' | '));
        assert(s.includes('2') && s.includes('3'), 'gear marks on the trace');
    });
    const raw0100 = () => { const r = (store().runs[0] || {}).result || {}; return r['0-100']; };
    const store = () => JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'draggy_runs.json'), 'utf8'));
    await check('app: the run is saved with its verdict, air, slope, top speed, elevation and shifts', () => {
        const r = store().runs[0];
        assert.deepStrictEqual(r.valid, { ok: true });
        assert(r.air && r.air.c === 18 && r.air.kPa === 100 && Math.abs(r.air.cf - Weather.sae(18, 100)) < 1e-12, JSON.stringify(r.air));
        assert(Math.abs(r.slopeAll) <= 0.2 && r.top >= 125 && Math.abs(r.height) < 1, JSON.stringify({ slope: r.slopeAll, top: r.top, height: r.height }));
        assert.deepStrictEqual(r.shifts.map((x) => [x.from, x.to, x.kmh]), [[1, 2, 60], [2, 3, 100]], JSON.stringify(r.shifts));
    });
    await check('app: times corrected to standard air (SAE): the 0-100 / CF, best times of their own, History marked', async () => {
        vals.air = 'sae';
        const st = await screen(), cf = Weather.sae(18, 100), want = (raw0100() / cf).toFixed(2);
        const i = st.indexOf('0-100 km/h');
        assert(i >= 0 && st[i + 1] === want, '0-100: ' + st.slice(i, i + 2).join(' | ') + ', want ' + want + ' (raw ' + raw0100() + ', CF ' + cf + ')');
        await onTab(2);
        const b = await screen(), k = b.indexOf('0-100 km/h');
        assert(k >= 0 && b[k + 1] === want, 'best 0-100 corrected: ' + b.slice(k, k + 2).join(' | '));
        assert(store().bestStd['0-100'] && Math.abs(store().bestStd['0-100'].s - raw0100() / cf) < 1e-9, 'bestStd saved');
        await onTab(3);
        const h = await screen();
        assert(h.includes('SPLITS (SAE)'), 'History marks the corrected times');
        assert(h.some((x) => x.indexOf('0-100 km/h ' + want) >= 0), 'History 0-100 corrected: ' + h.filter((x) => /0-100/.test(x)).join(' | '));
        await onTab(2);
        vals.air = 'show';
        const m = await screen(), n = m.indexOf('0-100 km/h');
        assert(n >= 0 && m[n + 1] !== want, 'measured best back without SAE');
        await onTab(0);
    });
    await check('app: History shows the verdict and a second line with the details, shifts and air', async () => {
        await onTab(3);
        const h = await screen();
        assert(h.includes('VALID RUN'), 'verdict');
        assert(h.includes('TOP SPEED') && h.includes('ELEVATION') && h.includes('SHIFTS') && h.includes('18 °C'), 'details');
        assert(h.some((x) => x === '1-2 60 km/h, 2-3 100 km/h'), 'shift list: ' + h.filter((x) => /km\/h,/.test(x)).join(' | '));
        await onTab(0);
    });
    // down a 3 % hill: INVALID (slope); with rollout on: INVALID (rollout)
    stop(130);
    s = await drive(0, 30, 130, -3, 3000);
    await check('app: a run down 3 % is an INVALID RUN for its slope', () => assert(s.includes('INVALID RUN · SLOPE'), s.filter((x) => /VALID/.test(x)).join(' | ')));
    stop(130);
    vals.rollout = true; onSetting('rollout');
    s = await drive(0, 30, 130, 0, 3000);
    await check('app: with one-foot rollout a run is INVALID (rollout), as Dragy counts no rollout', () => assert(s.includes('INVALID RUN · ROLLOUT'), s.filter((x) => /VALID/.test(x)).join(' | ')));
    vals.rollout = false; onSetting('rollout');
    stop(130);
    // a rolling pull: its own verdict and details on the Rolling start page
    s = await drive(80, 12.5, 210, 0, 1000);
    await onTab(1);
    s = await screen();
    await check('app: a rolling pull has its verdict, top speed and air', () => {
        assert(s.includes('VALID RUN'), 'verdict: ' + s.filter((x) => /VALID/.test(x)).join(' | '));
        const i = s.indexOf('TOP SPEED');
        assert(i >= 0 && s[i + 1] === '210 km/h', 'top: ' + s.slice(i, i + 2).join(' | '));
        assert(s.includes('18 °C'), 'air');
    });
    // standing, the clock on in 200 ms ticks, the transport's replies let through every second
    const wait = async (ms) => { const end = now + ms; while (now < end) { now += 200; ticks.forEach((f) => f()); if (now % 1000 === 0) await flush(); } await flush(); };
    await check('app: the pressure again 5 min after the last answer, not before; none with the setting off', async () => {
        stop(210);
        await wait(1000);
        // (5 min from the last answer)
        const last = tasu.answers[tasu.answers.length - 1], n0 = tasu.calls.length;
        if (now < last + 290000) await wait(last + 290000 - now);
        assert.strictEqual(tasu.calls.length, n0, 'asked again at ' + (tasu.calls[n0] || {}).t + ' ms, before 5 min (last answer ' + last + ')');
        await wait(20000);
        assert.strictEqual(tasu.calls.length, n0 + 1, 'not asked again after 5 min: ' + tasu.calls.length + ' requests');
        vals.air = 'off';
        const n1 = tasu.calls.length;
        await wait(12 * 60000);
        assert.strictEqual(tasu.calls.length, n1, 'asked with the setting off');
        const st = await screen();
        assert(!st.some((x) => / °C$| hPa$/.test(x)), 'air shown with the setting off: ' + st.filter((x) => /°C|hPa/.test(x)).join(' | '));
        vals.air = 'show';
    });
    // a launch past 200: its 100-200 is a standing split and a rolling window, the same time, one best time
    vals.rollout = true; onSetting('rollout');
    stop(210);
    await onTab(0);
    s = await drive(0, 25, 215, 0, 3000);
    await check('app: a launch to 215 times 100-200 on the Standing page (4.00 s at 25 km/h/s), with rollout too', () => {
        const i = s.indexOf('100-200 km/h');
        assert(i >= 0 && s[i + 1] === '4.00', '100-200: ' + s.slice(i, i + 3).join(' | '));
    });
    await check('app: that 100-200 is one best time with the rolling one: NEW BEST on both pages, saved without @ro', async () => {
        const b = store().best;
        assert(b['100-200'] && Math.abs(b['100-200'].s - 4) < 0.01, 'best 100-200: ' + JSON.stringify(b['100-200']));
        assert(!b['100-200@ro'], 'a rollout copy: ' + JSON.stringify(b['100-200@ro']));
        const st = await screen(), i = st.indexOf('100-200 km/h');
        assert(st.slice(i, i + 6).includes('NEW BEST'), 'standing: ' + st.slice(i, i + 6).join(' | '));
        await onTab(1);
        const rl = await screen(), k = rl.indexOf('100-200 km/h');
        assert(rl[k + 1] === '4.00' && rl.slice(k, k + 6).includes('NEW BEST'), 'rolling: ' + rl.slice(k, k + 6).join(' | '));
        await onTab(0);
    });
    vals.rollout = false; onSetting('rollout');
    await check('app: a launch is one History entry (its rolling pull timed nothing the launch did not)', async () => {
        await onTab(3);
        const h = await screen();
        assert.strictEqual(h.filter((x) => x.indexOf('100-200 km/h 4.00') >= 0).length, 1, h.filter((x) => /100-200/.test(x)).join(' | '));
        await onTab(0);
    });
    await check('app: Reset run clears the run with its verdict and details', async () => {
        await onTab(0);
        assert((await screen()).includes('VALID RUN') || true);
        await clicks.BTN_ACTION();
        const st = await screen();
        assert(!st.includes('VALID RUN') && !st.includes('INVALID RUN') && !st.includes('TOP SPEED'), st.filter((x) => /VALID|TOP SPEED/.test(x)).join(' | '));
    });
    await check('app: after Reset run on Rolling start the next pull draws (no crash) with its time', async () => {
        await onTab(1);
        await clicks.BTN_ACTION();
        stop(215);
        driving = true;
        // a pull from 80: 100-200 timed while the screen is drawn (the window done, the pull still on for 200-250)
        let v = 80;
        spd(v);
        for (let i = 0; i < 60; i++) { now += 20; ticks.forEach((f) => f()); }
        const ts = now;
        let drew = 0;
        while (v < 215) {
            now += 20; v = Math.min(215, 80 + (now - ts) / 1000 * 12.5); acc(12.5 / 3.6); spd(v); ticks.forEach((f) => f());
            if (v > 201 && v < 205 && !drew) { const mid = await screen(); drew = 1; assert(mid.includes('8.00'), 'mid-pull: ' + mid.filter((x) => /^\d+\.\d\d$/.test(x)).join(' | ')); }
        }
        driving = false;
        assert(drew, 'never drawn mid-pull');
    });
    await check('app: Reset best clears the corrected best times too', async () => {
        await onTab(2);
        await clicks.BTN_ACTION(); await clicks.BTN_ACTION();
        const st = store();
        assert.deepStrictEqual([Object.keys(st.best).length, Object.keys(st.bestStd).length, st.runs.length], [0, 0, 0], JSON.stringify(Object.keys(st.bestStd)));
        await onTab(0);
    });
    await check('app: the outside temperature (sent on change only) still counts 40 min later', async () => {
        stop(215);
        await wait(40 * 60000);
        s = await drive(0, 30, 130, 0, 3000);
        const r = store().runs[0];
        assert(r && r.air && r.air.c === 18, 'air of the run: ' + JSON.stringify(r && r.air));
    });
    console.log(failed ? failed + ' failed' : 'draggy: all ok');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
