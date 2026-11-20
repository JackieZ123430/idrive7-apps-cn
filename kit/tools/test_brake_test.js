'use strict';

// Brake test: a 1 g stop from 110 km/h with speed at 10 Hz and accel at 50 Hz (as the car sends them),
// through the app with kit/car stubbed, and the arming line on screen. No SDK, vehicle or capture needed:
//   node kit/tools/test_brake_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ROOT = path.join(__dirname, '..', '..');
const kit = path.join(ROOT, 'kit/runtime');
const { Recorder } = require(path.join(kit, 'record'));
const themes = require(path.join(kit, 'themes'));
const tmps = [];      // the app's data dirs, removed on exit
const tmpDir = (pre) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), pre)); tmps.push(d); return d; };
process.on('exit', () => tmps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const MPH = 1.609344;

let failed = 0;
const check = async (name, fn) => {
    try { await fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message.split('\n')[0]); }
};

let app = null, sample = null, reset = null;
const live = { speed: 0, gLong: 0, demo: false };
class FakeCar {
    onSample(fn, r) { sample = fn; reset = r; }
    data() { return Object.assign({}, live); }
}
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req === './kit/mgu') return { run: (a) => { app = a; } };
    if (req === './kit/car') return FakeCar;
    if (req.startsWith('./kit/')) return load.call(this, path.join(kit, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
require(path.join(ROOT, 'apps/brake_test/main'));
Module._load = load;

(async () => {
    const texts = [], dataDir = tmpDir('brake-');
    let render = null;
    const vals = { speedUnit: 'kmh', trigger: 0.4, distUnit: 'm', demo: 'off', theme: 'm_tricolour' };
    await app.start({
        ui: { image: async () => {}, text() {}, onClick() {} },
        settings: { get: (k) => vals[k], onChange() {} },
        log: { info() {}, warn() {}, error() {} },
        spec: {}, dataDir,
        theme: () => themes.theme(vals.theme),
        canvas: (w, h) => { const cv = new Recorder(w, h), text = cv.text.bind(cv); cv.text = (s, ...a) => { texts.push(String(s)); return text(s, ...a); }; return cv; },
        onTab() {}, hideButton() {}, loop(n, fps, fn) { render = fn; },
    });
    const screen = async () => { texts.length = 0; await render(); return texts.slice(); };

    // 1 g from 110 km/h: speed every 100 ms, accel every 20 ms (offset 10 ms); each one fires onSample
    // with the other signal held, as kit/car does
    const A = 9.80665 * 3.6, ev = [];
    for (let t = 0; t <= 4000; t += 100) ev.push([t, 's']);
    for (let t = 10; t <= 4000; t += 20) ev.push([t, 'a']);
    ev.sort((x, y) => x[0] - y[0]);
    const T0 = 1000;
    for (let t = 0; t < 1000; t += 100) { live.speed = 110; live.gLong = 0; sample(Object.assign({}, live), t); }
    for (const [t, k] of ev) {
        if (k === 's') live.speed = Math.max(0, 110 - A * t / 1000);
        else live.gLong = live.speed > 0 ? -1 : 0;
        sample(Object.assign({}, live), T0 + t);
    }
    const runs = JSON.parse(fs.readFileSync(path.join(dataDir, 'brake_runs.json'), 'utf8')).runs;
    const want = (100 / 3.6) ** 2 / (2 * 9.80665);
    await check('100-0 at 1 g: distance from the speed samples only', () => {
        assert.strictEqual(runs.length, 1);
        const m = runs[0].result['100-0'].m;
        assert(Math.abs(m - want) < 0.05, m.toFixed(2) + ' m (want ' + want.toFixed(2) + ' m)');
    });
    // from the 100 km/h crossing (interpolated between speed samples) to the first speed sample under 0.5 km/h (3.2 s)
    await check('100-0 at 1 g: time', () => {
        const s = runs[0].result['100-0'].s, w = 3.2 - 10 / A;
        assert(Math.abs(s - w) < 0.005, s.toFixed(3) + ' s (want ' + w.toFixed(3) + ' s)');
    });

    // a steady cruise just over 100 (speed is sent on change: nothing new for 2 s, accel samples go on), then
    // 1 g (reached in rampMs): the stop starts at the 100 km/h crossing, not back where the speed last changed
    async function cruiseStop(vc, rampMs, base) {
        reset();
        let tc = base;
        live.speed = 105; live.gLong = 0; sample(Object.assign({}, live), tc);         // armed
        tc += 100; live.speed = vc; sample(Object.assign({}, live), tc);
        for (const end = tc + 2000; tc < end;) { tc += 20; sample(Object.assign({}, live), tc); }
        const B = tc, ev2 = [], gAt = (t) => Math.min(1, t / Math.max(1, rampMs));
        const vAt = (t) => Math.max(0, vc - A * (t <= rampMs ? t * t / (2 * Math.max(1, rampMs)) : rampMs / 2 + (t - rampMs)) / 1000);
        for (let t = 100; t <= 4500; t += 100) ev2.push([t, 's']);
        for (let t = 10; t <= 4500; t += 20) ev2.push([t, 'a']);
        ev2.sort((x, y) => x[0] - y[0]);
        for (const [t, k] of ev2) {
            if (k === 's') live.speed = vAt(t);
            else live.gLong = live.speed > 0 ? -gAt(t) : 0;
            sample(Object.assign({}, live), B + t);
        }
        return JSON.parse(fs.readFileSync(path.join(dataDir, 'brake_runs.json'), 'utf8')).runs[0];   // (newest first)
    }
    for (const [vc, rampMs, tol] of [[101.5, 0, 0.3], [100.3, 50, 0.5], [100.6, 100, 0.5]]) {
        const r = (await cruiseStop(vc, rampMs, 30000 + vc * 1000)).result['100-0'];
        await check('100-0 after a steady cruise at ' + vc + ', 1 g in ' + rampMs + ' ms: from the crossing', () => {
            assert(Math.abs(r.m - want) < tol, r.m.toFixed(2) + ' m (want ' + want.toFixed(2) + ' +-' + tol + ')');
            assert(Math.abs(r.s - 100 / A) < 0.15, r.s.toFixed(3) + ' s (want ' + (100 / A).toFixed(3) + ' s)');
        });
    }

    // arming: the screen asks for the speed the code arms at (60-0 mph: 60 mph + 3 km/h = 61.9 mph)
    vals.speedUnit = 'mph';
    reset();
    live.speed = 0; live.gLong = 0;
    sample(Object.assign({}, live), 10000);
    let s = await screen();
    await check('mph: GET ABOVE shows the arming speed', () => assert(s.includes('GET ABOVE 62 MPH'), 'got ' + s.filter((x) => /ABOVE/.test(x)).join(' | ')));
    live.speed = 62 * MPH;
    sample(Object.assign({}, live), 10100);
    s = await screen();
    await check('mph: 62 mph arms', () => assert(s.includes('BRAKE HARD'), 'got ' + s.filter((x) => /ABOVE|BRAKE/.test(x)).join(' | ')));
    vals.speedUnit = 'kmh';
    reset();
    live.speed = 0;
    sample(Object.assign({}, live), 20000);
    s = await screen();
    await check('km/h: GET ABOVE 103 KM/H', () => assert(s.includes('GET ABOVE 103 KM/H'), 'got ' + s.filter((x) => /ABOVE/.test(x)).join(' | ')));
    console.log(failed ? failed + ' failed' : 'brake_test: all ok');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
