'use strict';

// Kit runtime (display.js, renderd.js, mgu.js Settings) against a stand-in mgu-render on a Unix socket: the
// unchanged-frame skip and its keepalive, a sheet that throws, X_STATE front flips, a reconnect after a cut
// message, the theme kept on a fresh install; signals.js's queue of native calls against a stand-in someip module.
// No SDK, renderer or car needed:
//   node kit/tools/test_runtime.js

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-rt-'));
process.env.MGU_RENDERD_SOCKET = path.join(dir, 'render.sock');
['MGU_RENDERER', 'MGU_RENDERD_FILE', 'MGU_RENDERD_PROTO', 'MGU_NO_GRAB'].forEach((k) => delete process.env[k]);
const { Display } = require('../runtime/display');
const { RenderClient } = require('../runtime/renderd');
const themes = require('../runtime/themes');

const FRAME = 7, READY = 101, TICK = 102, TOUCH = 105, X_READY = 0x4d520101, X_STATE = 0x4d520102, X_CCU = 0x4d520103;
const uncaught = [];
process.on('uncaughtException', (e) => uncaught.push(e));     // (else node exits, as mgu.js does on the car)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u32 = (...a) => Buffer.from(new Uint32Array(a).buffer);
function msg(type, p) {
    const b = Buffer.alloc(8 + p.length + ((4 - (p.length & 3)) & 3));
    b.writeUInt32LE(type, 0); b.writeUInt32LE(b.length - 8, 4); p.copy(b, 8);
    return b;
}
async function waitFor(fn, ms) {
    for (const t0 = Date.now(); Date.now() - t0 < (ms || 2000); await sleep(10)) if (fn()) return true;
    return false;
}

// the renderer's side: the app's FRAMEs (time of each, a TICK back for each), READY on connect (onConn)
let onConn = null;
const server = net.createServer((s) => {
    const c = { s, frames: [], buf: Buffer.alloc(0), send: (t, p) => s.write(msg(t, p)) };
    s.on('data', (d) => {
        c.buf = Buffer.concat([c.buf, d]);
        while (c.buf.length >= 8) {
            const t = c.buf.readUInt32LE(0), n = c.buf.readUInt32LE(4);
            if (c.buf.length < 8 + n) break;
            c.buf = c.buf.slice(8 + n);
            if (t === FRAME) { c.frames.push(Date.now()); c.send(TICK, u32(c.frames.length, 0)); }
        }
    });
    s.on('error', () => {});
    onConn(c);
});
const ready = (c) => { c.send(X_READY, u32(1, 1, 7)); c.send(READY, u32(4, 1920, 720, 1)); };   // touch, controller, front gate
const ccu = (k, pb, df) => { const b = Buffer.alloc(5); b.writeUInt16BE(k, 1); b[3] = pb; b[4] = df; return b; };
const touch = (phase, x, y) => { const b = Buffer.alloc(12); b.writeUInt32LE(phase, 0); b.writeFloatLE(x, 4); b.writeFloatLE(y, 8); return b; };

/** A Display on the stand-in renderer, the kit running the screen (full-screen layout, touch), shown. */
async function setup() {
    let conn = null;
    onConn = (c) => { conn = c; ready(c); };
    const log = { errors: [], info() {}, warn() {}, debug() {}, error: (...a) => log.errors.push(a) };
    const vis = new Set(['MAIN']), visH = [];
    const ui = {
        rhmi: null, close() {}, visible() {}, onVisible: (fn) => visH.push(fn), isVisible: (n) => vis.has(n),
        setVisible: (v) => { if (v) vis.add('MAIN'); else vis.delete('MAIN'); visH.forEach((fn) => fn('MAIN', v)); },
    };
    const spec = { id: 'test', title: 'Test', screens: [{ name: 'MAIN', kind: 'canvas', buttons: [['BTN_SETTINGS', 'Settings']] }] };
    const d = new Display(ui, log, spec, { get: () => undefined, onChange() {} }, () => themes.theme());
    assert(await waitFor(() => conn && d.active() && d.own()), 'display on the renderer');
    return { d, ui, log, c: conn, end() { d.closeSheet(); d.gpu.close(); clearInterval(d.keepTimer); } };
}
/** The app draws its page (v: what changes) and hands it over, as ui.image does. */
function page(d, v) {
    const r = d.canvas(1600, 520);
    r.fillRect(100, 100, 400, 200, '#ff0000'); r.fillRect(0, 300, v, 10, '#00ff00');
    d.present('MAIN', r, () => Promise.resolve());
}

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('unchanged frames: not sent again, but one a second (the renderer hides an app quiet for 3 s)', async () => {
    const t = await setup(), c = t.c;
    try {
        const t0 = Date.now();
        while (Date.now() - t0 < 2500) { page(t.d, 10); await sleep(16); }
        const f = c.frames.slice(), gaps = f.slice(1).map((x, i) => x - f[i]).concat(Date.now() - f[f.length - 1]);
        console.log('  a static page at 60 fps for 2.5 s: ' + f.length + ' FRAMEs, longest gap ' + Math.max(...gaps) + ' ms');
        assert(f.length >= 2 && f.length <= 6, 'FRAMEs for a static page: ' + f.length);
        assert(Math.max(...gaps) < 1600, 'the longest time without a FRAME: ' + Math.max(...gaps) + ' ms');
        // a changed page: at once
        let n = c.frames.length;
        page(t.d, 20); await sleep(50);
        assert.strictEqual(c.frames.length, n + 1, 'a changed page');
        // the header changed (the knob turned onto a tab), the page did not: at once, and only once
        n = c.frames.length;
        c.send(X_CCU, ccu(0, 0, 0)); c.send(X_CCU, ccu(1, 0, 0)); await sleep(50);
        assert.strictEqual(t.d.focusTab, 0);
        assert.strictEqual(c.frames.length, n + 1, 'the header changed');
        page(t.d, 20); await sleep(50);
        assert.strictEqual(c.frames.length, n + 1, 'the same page with the same header');
        // shown again: the picture comes back once the HMI's page has opened (display.js SHOW_DELAY_MS, 350 ms),
        // then the same page goes out at once
        t.ui.setVisible(false); t.ui.setVisible(true);
        await sleep(450);
        n = c.frames.length;
        page(t.d, 20); await sleep(50);
        assert.strictEqual(c.frames.length, n + 1, 'shown again');
        // a sheet painted every 33 ms that does not change: its first frame, then the keepalive
        n = c.frames.length;
        assert(t.d.openSheet({ draw: (r) => { r.fillRect(0, 0, 50, 50, '#0000ff'); return []; }, move() {} }));
        await sleep(1500);
        console.log('  a static sheet for 1.5 s: ' + (c.frames.length - n) + ' FRAMEs');
        assert(c.frames.length - n >= 2 && c.frames.length - n <= 4, 'FRAMEs for a static sheet: ' + (c.frames.length - n));
        // closed: the page again, at once
        n = c.frames.length;
        t.d.closeSheet(); await sleep(50);
        assert.strictEqual(c.frames.length, n + 1, 'the sheet closed');
    } finally { t.end(); }
});

test('a sheet\'s press, back and touch target that throw: logged, the app runs on', async () => {
    const t = await setup(), c = t.c;
    try {
        page(t.d, 10);
        const boom = (w) => () => { throw new Error(w); };
        assert(t.d.openSheet({ draw: () => [{ x: 0, y: 0, w: 1600, h: 520, act: boom('act') }], move() {}, press: boom('press'), back: boom('back') }));
        const n = uncaught.length;
        c.send(X_CCU, ccu(0, 0, 0)); c.send(X_CCU, ccu(0, 1, 0));                      // press
        c.send(X_CCU, ccu(0, 0, 0)); c.send(X_CCU, ccu(0, 0, 10));                     // push left
        c.send(TOUCH, touch(1, 800, 300)); c.send(TOUCH, touch(3, 800, 300));          // a tap on the target
        await sleep(100);
        // (an uncaught exception ends the app on the car: mgu.js process.exit(1), and the platform wipes its data)
        assert.deepStrictEqual(uncaught.slice(n).map((e) => e.message), [], 'uncaught in the socket\'s data handler');
        assert.deepStrictEqual(t.log.errors.map((a) => a[0] + ' ' + a[1].message), ['sheet press', 'sheet back', 'sheet act']);
        assert(t.d.sheet, 'the sheet stays open');
    } finally { t.end(); }
});

test('not in front, then in front (not on screen yet) within 1.5 s: the app stays on the renderer', async () => {
    const t = await setup(), c = t.c;
    try {
        page(t.d, 10);
        c.send(X_STATE, u32(1, 0, 0)); await sleep(100);
        c.send(X_STATE, u32(1, 0, 1)); await sleep(1700);
        assert(!t.d.blocked, 'blocked though in front');
        assert(t.d.own());
        // not in front for good: blocked after 1.5 s
        c.send(X_STATE, u32(1, 0, 0)); await sleep(1700);
        assert.strictEqual(t.d.blocked, true, 'not in front for 1.5 s');
    } finally { t.end(); }
});

test('ctx.onTouch: a gesture the app takes gets every move and no tap; one it does not take taps as before', async () => {
    const t = await setup(), d = t.d;
    try {
        const seen = [], taps = [];
        d.onTouch = (phase, x, y) => { seen.push([phase, x, y]); return phase === 1 ? x < 500 : true; };
        d.onTap = (x, y) => { taps.push([x, y]); };
        d._touch(1, 300, 300); d._touch(2, 320, 310); d._touch(2, 360, 330); d._touch(3, 360, 330);
        await sleep(20);
        assert.deepStrictEqual(seen, [[1, 300, 300], [2, 320, 310], [2, 360, 330], [3, 360, 330]], 'taken: every move to the app');
        assert.strictEqual(taps.length, 0, 'taken: no tap');
        seen.length = 0;
        d._touch(1, 900, 300); d._touch(3, 900, 300);
        await sleep(20);
        assert.deepStrictEqual(seen, [[1, 900, 300]], 'not taken: only asked on the down');
        assert.deepStrictEqual(taps, [[900, 300]], 'not taken: a tap as before');
    } finally { t.end(); }
});

test('a connection cut in the middle of a message: the next connection\'s READY is read', async () => {
    let n = 0;
    onConn = (c) => {
        if (n++) { ready(c); return; }
        c.s.write(Buffer.concat([u32(TICK, 8), u32(1)]));                              // 4 of TICK's 8 bytes
        setTimeout(() => c.s.destroy(), 50);
    };
    const g = new RenderClient('test', { info() {}, warn() {}, error() {} }, { native: true });
    try {
        let readyN = 0;
        g.on('ready', () => readyN++);
        g.connect();
        await waitFor(() => readyN, 5000);
        assert.strictEqual(n, 2, 'connected again');
        assert.strictEqual(readyN, 1, 'READY after the reconnect');
        assert(g.native && g.info && g.info.touch, 'X_READY after the reconnect');
    } finally { g.close(); }
});

test('the one-time move to the new default theme: a theme picked on a fresh install stays', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'runtime', 'mgu.js'), 'utf8').replace(/\r\n/g, '\n');
    const cls = src.match(/class Settings[\s\S]*?\n}\n/)[0];      // (as hu-stub.js: the real class without the SDK)
    const make = (sub) => {
        const dd = path.join(dir, sub);
        fs.mkdirSync(dd);
        return new Function('fs', 'path', 'DATA_DIR', 'log', cls + '\nreturn Settings;')(fs, path, dd, { warn() {}, error() {} });
    };
    const file = (sub) => path.join(dir, sub, 'settings.json');
    const schema = [{ key: 'theme', type: 'choice', default: 'm_tricolour', options: [] }, { key: 'units', type: 'choice', default: 'metric', options: [] }];
    // fresh install: no file until something is set; a theme set then stays
    let S = make('fresh');
    assert.strictEqual(new S(schema).get('theme'), 'm_tricolour');
    assert(!fs.existsSync(file('fresh')), 'a fresh start writes no file');
    new S(schema).set('theme', 'amber');
    assert.strictEqual(new S(schema).get('theme'), 'amber', 'theme picked on a fresh install, next start');
    // another setting set first, the theme later: stays too
    S = make('fresh2');
    new S(schema).set('units', 'imperial');
    new S(schema).set('theme', 'amber');
    assert.strictEqual(new S(schema).get('theme'), 'amber', 'theme picked after another setting, next start');
    // saved before the new default (no mark): moved to it once, the next choice stays
    S = make('old');
    fs.writeFileSync(file('old'), JSON.stringify({ theme: 'amber', units: 'imperial' }));
    const o = new S(schema);
    assert.strictEqual(o.get('theme'), 'm_tricolour', 'an old save moves to the new default');
    assert.strictEqual(o.get('units'), 'imperial');
    assert.strictEqual(JSON.parse(fs.readFileSync(file('old'), 'utf8'))._themeV, 2);
    o.set('theme', 'amber');
    assert.strictEqual(new S(schema).get('theme'), 'amber');
});

test('settings: aliases, "when" and "group" (the drawn settings sheet), "hidden"', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'runtime', 'mgu.js'), 'utf8').replace(/\r\n/g, '\n');
    const cls = src.match(/class Settings[\s\S]*?\n}\n/)[0];
    const dd = path.join(dir, 'when');
    fs.mkdirSync(dd);
    const S = new Function('fs', 'path', 'DATA_DIR', 'log', cls + '\nreturn Settings;')(fs, path, dd, { warn() {}, error() {} });
    fs.writeFileSync(path.join(dd, 'settings.json'), JSON.stringify({ tempUnit: 'F' }));
    const schema = [
        { key: 'tempUnit', label: 'Temperature unit', type: 'choice', default: 'c', options: [['c', 'Celsius'], ['f', 'Fahrenheit']], aliases: { C: 'c', F: 'f' } },
        { key: 'torqueUnit', label: 'Torque unit', type: 'choice', default: 'nm', options: [['nm', 'Nm'], ['kgm', 'kgm']] },
        { key: 'maxKgm', label: 'Torque gauge max', type: 'number', default: 100, steps: [50, 100], when: { torqueUnit: 'kgm' } },
        { key: 'showA', label: 'Tile A', type: 'choice', default: 'auto', options: [['auto', 'Auto'], ['off', 'Hide']], group: 'Tiles' },
        { key: 'showB', label: 'Tile B', type: 'choice', default: 'auto', options: [['auto', 'Auto'], ['off', 'Hide']], group: 'Tiles' },
        { key: 'names', label: 'Names', type: 'choice', default: 'en', options: [['en', 'English']], hidden: true },
        { key: 'advanced', label: 'Advanced settings', type: 'bool', default: false },
        { key: 'rate', label: 'Display rate', type: 'number', default: 10, steps: [5, 10], when: { advanced: true } },
    ];
    const st = new S(schema);
    assert.strictEqual(st.get('tempUnit'), 'f', 'a value saved as F reads as f');
    const { listSheet } = require(path.join(__dirname, '..', 'runtime', 'sheet.js'));
    const sh = listSheet(st, null, {});
    const labels = () => sh.rows().map((r) => r.label);
    assert.deepStrictEqual(labels(), ['Temperature unit', 'Torque unit', 'Tiles', 'Advanced settings'], 'kgm-only, grouped, hidden and advanced left out');
    st.set('torqueUnit', 'kgm');
    st.set('advanced', true);
    assert.deepStrictEqual(labels(), ['Temperature unit', 'Torque unit', 'Torque gauge max', 'Tiles', 'Advanced settings', 'Display rate'], 'offered once their "when" holds');
    // the group: one row that opens its settings; Back returns to it
    sh.focus = 3; sh.choose();
    assert.deepStrictEqual([sh.group, labels()], ['Tiles', ['Tile A', 'Tile B']]);
    sh.focus = 1; sh.choose();
    assert.strictEqual(sh.open.key, 'showB', 'a grouped setting opens its values');
    sh.sub = 1; sh.choose();
    assert.strictEqual(st.get('showB'), 'off');
    assert.deepStrictEqual([sh.back(), sh.group, sh.focus], [null, null, 3], 'Back: the main list, on the group');
    assert.strictEqual(sh.back(), 'close');
    // a switch that hides the setting the focus was on: the focus stays on the list
    sh.focus = 5; st.set('advanced', false);
    const r = new Proxy({}, { get: (o, k) => (k === 'extra' ? 0 : () => 40) });
    sh.draw(r, { bg: '#000', text: '#fff', dim: '#888', sel: '#00f' });
    assert.strictEqual(sh.focus, labels().length - 1);
    // the app's own rows (ctx.settingsRow) at the very bottom; one opens its sheet in the settings' place, whose
    // Back ('close', from the controller or a tap) returns to the settings, not out of them
    const child = { drawn: 0, moved: 0, draw() { this.drawn++; return [{ x: 0, y: 0, w: 10, h: 10, act: () => 'close' }]; }, move(d) { this.moved += d; }, press: () => null, back: () => 'close' };
    const sx = listSheet(st, null, { extra: () => [{ label: 'Logs', value: () => 'lately', open: () => child }] });
    const rows = sx.rows(), last = rows[rows.length - 1];
    assert.deepStrictEqual([last.label, last.value, last.kind], ['Logs', 'lately', 'more'], 'the extra row last');
    sx.focus = rows.length - 1; sx.choose();
    assert.strictEqual(sx.child, child, 'the row opens its sheet');
    sx.move(2);
    const tg = sx.draw(r, { bg: '#000', text: '#fff', dim: '#888', sel: '#00f' });
    assert.deepStrictEqual([child.drawn, child.moved, sx.focus], [1, 2, rows.length - 1], 'drawn and moved by the child');
    assert.strictEqual(await tg[0].act(), null, "a child tap's 'close': not out of the settings");
    assert.strictEqual(sx.child, null, 'back on the settings');
    sx.choose(); assert.strictEqual(await sx.back(), null); assert.strictEqual(sx.child, null, 'its Back: the settings');
    assert.strictEqual(sx.back(), 'close', 'then out');
    sx.group = 'Tiles'; assert(!sx.rows().some((x) => x.label === 'Logs'), 'not inside a group');
    // a child that throws while drawing: dropped (the error for display.js's log), the settings drawn next
    sx.group = null;
    const broken = { draw() { throw new Error('boom'); }, move() {}, press: () => null, back: () => 'close' };
    const sb = listSheet(st, null, { extra: () => [{ label: 'Logs', open: () => broken }] });
    sb.focus = sb.rows().length - 1; sb.choose();
    assert.throws(() => sb.draw(r, { bg: '#000', text: '#fff', dim: '#888', sel: '#00f' }), /boom/, 'its error goes up to be logged');
    assert.strictEqual(sb.child, null, 'the child dropped');
    sb.draw(r, { bg: '#000', text: '#fff', dim: '#888', sel: '#00f' });
    // an extra row whose list fails: the settings without it
    const sc = listSheet(st, null, { extra: () => { throw new Error('no rows'); } });
    assert(sc.rows().length > 0 && !sc.rows().some((x) => x.label === 'Logs'), 'a failing extra list: the settings still');
});

test('settings: a number kept in kW / °C shown in the unit chosen ("unitBy", issue #173)', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'runtime', 'mgu.js'), 'utf8').replace(/\r\n/g, '\n');
    const cls = src.match(/class Settings[\s\S]*?\n}\n/)[0];
    const dd = path.join(dir, 'unitby');
    fs.mkdirSync(dd);
    const S = new Function('fs', 'path', 'DATA_DIR', 'log', cls + '\nreturn Settings;')(fs, path, dd, { warn() {}, error() {} });
    const schema = [
        { key: 'powerUnit', label: 'Power unit', type: 'choice', default: 'kw', options: [['kw', 'kW'], ['hp', 'hp'], ['ps', 'PS']] },
        { key: 'tempUnit', label: 'Temperature unit', type: 'choice', default: 'c', options: [['c', 'Celsius'], ['f', 'Fahrenheit']] },
        { key: 'maxPower', label: 'Max power', type: 'number', unit: 'kW', unitBy: 'powerUnit', units: { hp: { unit: 'hp', mul: 1.34102 }, ps: { unit: 'PS', mul: 1.35962 } }, default: 215, steps: [200, 215] },
        { key: 'oilWarn', label: 'Oil temp warning', type: 'number', unit: '°C', unitBy: 'tempUnit', units: { f: { unit: '°F', mul: 1.8, add: 32 } }, default: 125, steps: [120, 125], labels: { 120: 'Low' } },
    ];
    const st = new S(schema);
    assert.deepStrictEqual([st.display('maxPower'), st.display('oilWarn')], ['215 kW', '125 °C']);
    st.set('powerUnit', 'hp'); st.set('tempUnit', 'f');
    assert.deepStrictEqual([st.display('maxPower'), st.display('oilWarn')], ['288 hp', '257 °F']);
    st.set('powerUnit', 'ps');
    assert.strictEqual(st.display('maxPower'), '292 PS');
    assert.strictEqual(st.get('maxPower'), 215, 'kept in kW');
    const { listSheet } = require(path.join(__dirname, '..', 'runtime', 'sheet.js'));
    const sh = listSheet(st, null, {});
    sh.focus = 2; sh.choose();
    assert.deepStrictEqual(sh.rows().map((r) => r.label), ['272 PS', '292 PS'], 'the value list in the unit chosen');
    sh.back();
    sh.focus = 3; sh.choose();
    assert.deepStrictEqual(sh.rows().map((r) => r.label), ['Low', '257 °F'], 'a value\'s own label stays');
});

test('a new scale keeps the uploads (the renderer keeps them), a new size sends them again', async () => {
    const t = await setup(), g = t.d.gpu;
    try {
        const pl = Object.assign({}, g.placement);
        g.sent.atlas.add(1); g.sent.ramp.add(2); g.sent.image.set(3, 1); g.sent.layer.add(4);
        g.place(Object.assign({}, pl, { scale: pl.scale * 0.9 }));
        assert.deepStrictEqual([g.sent.atlas.has(1), g.sent.ramp.has(2), g.sent.image.has(3)], [true, true, true], 'a new scale sends everything again');
        assert(!g.sent.layer.has(4), 'layers drawn at the old scale');
        g.place(Object.assign({}, pl, { w: pl.w - 8 }));
        assert.deepStrictEqual([g.sent.atlas.size, g.sent.ramp.size, g.sent.image.size], [0, 0, 0], 'a new size');
    } finally { t.end(); }
});

test('in front without the controller (another renderer held it at connect): connected again, the controller then', async () => {
    const t = await setup();
    try {
        // the renderer offering no controller on this connection, as when the Store's renderer held it
        let conns = 0, now = null;
        onConn = (c) => { conns++; now = c; c.send(X_READY, u32(1, 1, 7)); c.send(READY, u32(4, 1920, 720, 1)); };
        t.d.gpu.info.controller = false; t.d.ctlTryT = 0;
        t.c.send(X_STATE, u32(1, 0, 1));
        assert(await waitFor(() => conns === 1 && t.d.gpu.ready && t.d.gpu.info && t.d.gpu.info.controller, 3000), 'connected again at once, the controller offered');
        assert(await waitFor(() => t.d.gpu.grabbing, 1000), 'and taken');
        // not again within 30 s, nor with the controller there
        now.send(X_STATE, u32(1, 0, 1)); await sleep(200);
        assert.strictEqual(conns, 1, 'once');
        assert.strictEqual(t.d.ctlTries, 1, 'one try counted');
    } finally { t.end(); }
});

test('iDrive 8 (the Store\'s renderer offers no controller there): never connected again for it', async () => {
    const t = await setup();
    try {
        let conns = 0;
        onConn = () => { conns++; };
        t.d.gpu.screen = { w: 2880, h: 960 }; t.d.gpu.info.controller = false; t.d.ctlTryT = 0; t.d.ctlTries = 0;
        t.d._ctlRetry(t.d.gpu);
        await sleep(300);
        assert.strictEqual(conns, 0, 'no new connection');
        assert.strictEqual(t.d.ctlTries, 0, 'no try counted');
    } finally { t.end(); }
});

/* signals.js: one native call at a time, method calls (urgent: UDS) ahead of the watch() set-ups waiting, and never
 * so many urgent calls in a row that the set-ups are shut out. A copy of signals.js, with its interface configs in
 * someipdefs/ next to it, against a stand-in for the native someip module that logs each native call as the queue
 * lets it through: 'call', 'build <interface>', 'avail <interface>', 'sub <field>'. */
const URGENT_RUN = 4;
function signalsWithFakeNative() {
    const app = path.join(dir, 'signals-' + cases.length + '-' + Date.now()), kit = path.join(app, 'javascript', 'kit');
    fs.mkdirSync(kit, { recursive: true });
    fs.mkdirSync(path.join(app, 'someipdefs'));                      // signals.js DIRS: kit/../../someipdefs
    ['test.Uds', 'test.Cds', 'test.Gear'].forEach((n) =>
        fs.writeFileSync(path.join(app, 'someipdefs', n.replace(/\./g, '_') + '.json'), JSON.stringify({ name: n, fields: {} })));
    const file = path.join(kit, 'signals.js');
    fs.copyFileSync(path.join(__dirname, '..', 'runtime', 'signals.js'), file);
    const log = [];
    const native = (what, v) => { log.push(what); return new Promise((r) => setImmediate(() => r(v))); };
    const fake = {
        buildProxy: (cfg) => native('build ' + cfg.name, {
            init: () => Promise.resolve(),
            callMethod: () => native('call', {}),
            subscribeToAvailability: () => { log.push('avail ' + cfg.name); return null; },
            subscribe: (o) => native('sub ' + o.name),
            isAvailable: () => true,
            getValue: () => Promise.resolve({}),
        }),
    };
    const Module = require('module'), load = Module._load;
    Module._load = function (request) { return request === 'someip' ? fake : load.apply(this, arguments); };
    try { return { sig: require(file), log }; } finally { Module._load = load; }
}

test('signals: a method call goes ahead of the watch() set-ups waiting', async () => {
    const { sig, log } = signalsWithFakeNative();
    const uds = await sig.proxy('test.Uds', '1');
    log.length = 0;
    const watches = ['test.Cds', 'test.Gear'].map((n) => sig.watch(n, '1', { a: () => {}, b: () => {} }));
    await sig.call(uds, 'read');
    // (the first set-up was already running when the call came)
    assert(log.indexOf('call') === 1, 'the call ran as native call ' + (log.indexOf('call') + 1) + ': ' + log.join(', '));
    const w = await Promise.all(watches);
    assert(w.every((x) => !x.error && x.available), JSON.stringify(w.map((x) => x.error)));
});

test('signals: watch() set-ups still go while method calls keep the urgent lane full', async () => {
    const { sig, log } = signalsWithFakeNative();
    const uds = await sig.proxy('test.Uds', '1');
    log.length = 0;
    // three UDS readers, each asking again as soon as its answer comes: the urgent lane is never empty
    let stop = false, calls = 0;
    const reader = async () => { while (!stop && calls < 400) { calls++; await sig.call(uds, 'read'); } };
    const readers = [reader(), reader(), reader()];
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    const from = log.length;
    const w = await sig.watch('test.Cds', '1', { rpm: () => {}, gear: () => {} });
    stop = true;
    await Promise.all(readers);
    assert(!w.error && w.available, 'watch: ' + w.error);
    // its set-ups in order (the proxy, its availability, a subscribe per field), each after at most URGENT_RUN calls
    const after = log.slice(from), runs = [];
    let run = 0;
    after.forEach((x) => { if (x === 'call') run++; else { runs.push(run); run = 0; } });
    assert.deepStrictEqual(after.filter((x) => x !== 'call'), ['build test.Cds', 'avail test.Cds', 'sub rpm', 'sub gear']);
    assert(runs.every((n) => n <= URGENT_RUN), 'calls in a row before each set-up: ' + runs.join(', ') + ' (at most ' + URGENT_RUN + ')');
    assert(calls < 40, 'the watch done within ' + calls + ' calls');
});

(async () => {
    await new Promise((r) => server.listen(process.env.MGU_RENDERD_SOCKET, r));
    let failed = 0;
    for (const [name, fn] of cases) {
        try { await fn(); console.log('ok    ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message.split('\n')[0]); }
    }
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(failed ? failed + ' of ' + cases.length + ' failed' : 'runtime: all ok');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
