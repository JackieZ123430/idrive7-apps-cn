'use strict';

// Warm-Up's turbo cool-down against a stubbed car (kit/car) and the head unit's clock jumping after start-up: the
// countdown counts a step back of the clock as no time, and "cooled" times its 20 s on the steady clock. No SDK or vehicle needed:
//   node kit/tools/test_warmup.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const MAIN = path.join(ROOT, 'apps', 'warmup', 'main.js');
const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'warmup', 'app.json'), 'utf8'));
const { Recorder } = require(path.join(KIT, 'record'));        // what the kit draws into (display.js)
const themes = require(path.join(KIT, 'themes'));

// the steady clock (process.hrtime) and the head unit's wall clock, moved by hand
let mono = 5000, wall = Date.UTC(2026, 9, 1, 8);
process.hrtime = () => [Math.floor(mono / 1000), (mono % 1000) * 1e6];
Date.now = () => wall;

let app = null, car = null;
class FakeCar {
    constructor() { car = this; this.d = {}; }
    onSample(fn) { this.fn = fn; }
    data() { return this.d; }
    setRedline() {}   // the demo drive's rpm (engine.js profile)
}
// the gearbox oil (gearbox.js): set by hand here (gearC = null: the car has none); gearbox.js is tested on its own below
let gearC = null;
class FakeGearbox { start() { return this; } temp() { return gearC; } source() { return gearC === null ? null : 'EGS'; } }
const stubs = { './kit/mgu': { run(a) { app = a; } }, './kit/car': FakeCar, './gearbox': { Gearbox: FakeGearbox } };
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (stubs[req]) return stubs[req];
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};

/** A fresh Warm-Up (a new process); render() draws a frame and returns its texts in order. */
let render = null;
async function start() {
    delete require.cache[MAIN];
    require(MAIN);
    const S = {};
    SPEC.settings.forEach((s) => { S[s.key] = s.default; });
    let texts = [], frame = null;
    await app.start({
        ui: { image: async () => {}, isVisible: () => true }, settings: { get: (k) => S[k], onChange() {} }, log: { info() {}, warn() {} },
        dataDir: fs.mkdtempSync(path.join(require('os').tmpdir(), 'warmup-')),   // engine.js keeps its profile here
        theme: () => themes.theme('m_tricolour'), loop: (name, fps, fn) => { frame = fn; },
        canvas: (w, h) => {
            const cv = new Recorder(w, h), text = cv.text.bind(cv);
            texts = [];
            cv.text = (str, ...a) => { texts.push(String(str)); return text(str, ...a); };
            return cv;
        },
    });
    render = async () => { await frame(); return texts; };
}
/** s seconds of samples 100 ms apart, both clocks running */
function drive(d, s) {
    for (let i = 0; i < s * 10; i++) { mono += 100; wall += 100; car.d = d; car.fn(d, wall); }
}
const HARD = { rpm: 5000, torque: 300, oil: 95, coolant: 90, speed: 120 };
const GENTLE = { rpm: 1500, torque: 50, oil: 95, coolant: 90, speed: 50 };
const checks = [
    ['countdown after the clock jumps back', async () => {
        await start();
        drive(HARD, 20);                          // 20 s hard: 90 s of cool-down
        drive(GENTLE, 10);
        wall -= 3 * 3600000;                      // the head unit sets its clock
        drive(GENTLE, 1);
        const t = await render();
        const i = t.indexOf('COOL-DOWN LEFT');
        assert(i >= 0 && t.indexOf('TURBO COOL-DOWN') >= 0, 'cooling down: ' + t.join(' | '));
        assert.strictEqual(t[i + 1], '79', 'cool-down left after 11 s gentle of 90 s');
    }],
    ['"cooled" clears 20 s on after the clock jumps back', async () => {
        await start();
        drive(HARD, 20);
        drive(GENTLE, 91);                        // cooled
        assert((await render()).indexOf('COOLED - OK TO SWITCH OFF') >= 0);
        wall -= 3 * 3600000;
        drive(GENTLE, 25);
        const t = await render();
        assert(t.indexOf('COOLED - OK TO SWITCH OFF') < 0 && t.indexOf('READY') >= 0, 'all clear: ' + t.join(' | '));
    }],
    ['"cooled" stays its 20 s after the clock jumps ahead', async () => {
        await start();
        drive(HARD, 20);
        drive(GENTLE, 91);                        // cooled
        wall += 3 * 3600000;
        drive(GENTLE, 5);
        assert((await render()).indexOf('COOLED - OK TO SWITCH OFF') >= 0, 'still cooled 5 s on');
        drive(GENTLE, 20);
        const t = await render();
        assert(t.indexOf('COOLED - OK TO SWITCH OFF') < 0 && t.indexOf('READY') >= 0, 'all clear: ' + t.join(' | '));
    }],
    ['gearbox oil: a third gauge, its own "ready in", and READY waits for it', async () => {
        gearC = 35;
        await start();
        drive(GENTLE, 5);                         // oil 95: warm
        // the status line: the text just before the first "ready in" row
        const status = (t) => t[t.findIndex((x) => / READY IN$/.test(x)) - 1];
        let t = await render();
        assert(t.indexOf('GEARBOX READY IN') >= 0 && t.indexOf('GEARBOX') >= 0, 'gearbox row and trend: ' + t.join(' | '));
        assert.strictEqual(status(t), 'GEARBOX WARMING UP', 'oil warm, gearbox cold');
        gearC = 65;
        drive(GENTLE, 5);
        t = await render();
        assert.strictEqual(status(t), 'READY', 'both warm');
        gearC = 130;
        t = await render();
        assert.strictEqual(status(t), 'GEARBOX HOT - EASE OFF', 'gearbox hot');
        gearC = null;
        t = await render();
        assert(t.indexOf('GEARBOX READY IN') < 0 && t.indexOf('COOLANT READY IN') >= 0 && status(t) === 'READY', 'no gearbox: as before: ' + t.join(' | '));
    }],
    ['gearbox.js: the unit\'s 6000, else DA12 or the signal once they moved', async () => {
        const { Gearbox, Moving } = require(path.join(__dirname, '..', '..', 'apps', 'warmup', 'gearbox'));
        const m = new Moving(false);
        m.put(20, wall); m.put(20, wall); assert.strictEqual(m.get(wall), null, 'a value that never moved counts as none');
        m.put(-60, wall); assert.strictEqual(m.get(wall), null, 'out of range is ignored');
        m.put(22, wall); assert.strictEqual(m.get(wall), 22, 'once it moved it counts');
        assert.strictEqual(m.get(wall + 30000), null, 'an old value counts as none');
        const quiet = { info() {}, warn() {} };
        // the gearbox unit: 22 6000 answered (deg C + 40)
        let asked = [];
        const g = new Gearbox({}, quiet, () => true);
        g.link = { read: async (a, did) => { asked.push([a, did]); return did === 0x6000 ? [0x62, 0x60, 0x00, 40 + 72] : [0x7F, 0x22, 0x31]; } };
        await g._poll(); g.stop();
        assert.deepStrictEqual(asked, [[0x18, 0x6000]], 'asks the gearbox unit for 6000');
        assert.strictEqual(g.temp(), 72); assert.strictEqual(g.source(), 'EGS');
        // no 6000: DA12, counted once it moved; the signal meanwhile
        asked = [];
        const h = new Gearbox({}, quiet, () => true);
        let raw = 48 + 50;
        h.link = { read: async (a, did) => { asked.push(did); return did === 0xDA12 ? [0x62, 0xDA, 0x12, raw] : [0x7F, 0x22, 0x31]; } };
        await h._poll(); await h._poll();
        assert.deepStrictEqual(asked, [0x6000, 0xDA12], '6000 refused as missing: DA12 next');
        assert.strictEqual(h.temp(), null, 'DA12 not moved yet');
        h.sig.put(40, wall); h.sig.put(42, wall);
        assert.strictEqual(h.temp(), 42); assert.strictEqual(h.source(), 'signal');
        raw += 3; await h._poll(); h.stop();
        await h._poll();
        assert.strictEqual(h.timer, null, 'stopped: no more polls');
        assert.strictEqual(h.temp(), 53, 'DA12 moved: the unit before the signal');
    }],
];

(async () => {
    const failed = [];
    for (const [name, fn] of checks) {
        try { await fn(); } catch (e) { failed.push(name); console.error('FAIL ' + name + ': ' + e.message); }
    }
    if (failed.length) process.exit(1);
    console.log('Warm-Up checks passed (cool-down countdown and "cooled" across wall-clock jumps back and ahead; gearbox oil).');
})().catch((e) => { console.error(e); process.exit(1); });
