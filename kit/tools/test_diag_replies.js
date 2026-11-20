'use strict';

// Live Adjustments against a real Diag with other apps' DME frames on the bus (car_vitals polls the
// DME every 5 s, and every app gets every TASU frame): a request takes only its own reply. No SDK,
// vehicle or build needed:
//   node kit/tools/test_diag_replies.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
// Stage the app with the transport as the build lays it out (./kit/diag), and stubs for the screen kit.
const src = fs.mkdtempSync(path.join(os.tmpdir(), 'live-adjustments-'));
fs.mkdirSync(path.join(src, 'kit'));
for (const f of fs.readdirSync(path.join(root, 'apps/live_adjustments')).filter((f) => f.endsWith('.js'))) {
    fs.copyFileSync(path.join(root, 'apps/live_adjustments', f), path.join(src, f));
}
fs.copyFileSync(path.join(root, 'kit/runtime/diag.js'), path.join(src, 'kit/diag.js'));
const any = 'module.exports = (o) => new Proxy(o, { get: (t, k) => (k in t ? t[k] : () => 0) });\n';
fs.writeFileSync(path.join(src, 'kit/any.js'), any);
fs.writeFileSync(path.join(src, 'kit/mgu.js'), 'module.exports = { run(app) { module.exports.app = app; } };\n');
fs.writeFileSync(path.join(src, 'kit/gauges.js'), 'module.exports = require("./any")({ TOP: 60, BOTTOM: 500, MARGIN: 12, pageBottom: () => 500 });\n');
fs.writeFileSync(path.join(src, 'kit/canvas.js'), 'class Canvas { constructor() { return require("./any")({ own: true }); } }\nmodule.exports = { Canvas };\n');
fs.writeFileSync(path.join(src, 'kit/car.js'), 'module.exports = class { data() { return { demo: true }; } };\n');
fs.writeFileSync(path.join(src, 'kit/record.js'), 'module.exports = { OP: {} };\n');           // the silencer picture (muffler_img.js)
fs.writeFileSync(path.join(src, 'kit/i18n.js'), 'module.exports = { t: (s) => s, getLanguage: () => "en" };\n');
process.on('exit', () => fs.rmSync(src, { recursive: true, force: true }));

const { Diag } = require(path.join(src, 'kit/diag'));
const { DiagLink } = require(path.join(src, 'diaglink'));
const { Mg1ElAgk } = require(path.join(src, 'real_adapters'));
const { Controller } = require(path.join(src, 'controller'));
const { TuneControl } = require(path.join(src, 'tune'));
const UI = require(path.join(src, 'ui'));
const anyOf = require(path.join(src, 'kit/any'));
const log = { info() {}, warn() {}, error() {} };
const later = (ms) => new Promise((r) => setTimeout(r, ms));
const FOREIGN = [0x62, 0xF4, 0x0C, 0x0B, 0xB8];   // car_vitals' coolant read of the DME

// A DME on a real Diag: respond(sid, data) -> the frames that come back, in order (others' first).
function bus(respond) {
    const sent = [];
    const d = new Diag({ call: async (p, m, a) => {
        const data = Array.from(a.udsData);
        sent.push([a.serviceID].concat(data));
        (respond(a.serviceID, data, a.targetAddress) || []).forEach((uds, i) => setTimeout(() => d.emit('frame', { ecu: a.targetAddress, uds }), 2 + i * 2));
        return 'NO_ERROR';
    } }, log);
    d.p = {}; d.available = true;
    const link = new DiagLink({}, log);
    link.diag = d; link.available = true;
    return { d, link, sent };
}
const echo = (sid, data) => [sid + 0x40].concat(data);

(async () => {
    // 1. A foreign frame or a foreign NRC is no answer to the flap command; the DME's own echo is.
    Mg1ElAgk.armed = true;
    let b = bus((sid) => (sid === 0x2F ? [FOREIGN, [0x7F, 0x22, 0x31], [0x7F, 0x2F, 0x22]] : null));
    let r = await Mg1ElAgk.oem(b.link);
    assert.strictEqual(r.accepted, false, 'a foreign 62 F40C counted as the DME accepting the flap');
    b = bus((sid, data) => (sid === 0x2F ? [FOREIGN, echo(sid, data)] : null));
    r = await Mg1ElAgk.open(b.link);
    assert.strictEqual(r.accepted, true);
    assert.deepStrictEqual(b.sent, [[0x2F, 0x60, 0xFD, 0x03, 0x03, 0xE8]]);
    b = bus((sid) => (sid === 0x2F ? [[0x6F, 0x01, 0x02], [0x6F, 0x60, 0xFD, 0x00]] : null));   // an MHD echo is not 60FD's
    assert.strictEqual((await Mg1ElAgk.oem(b.link)).accepted, true);

    // 1. Flap buttons: OPEN / CLOSE while a command is in flight are not sent (they would share its
    // reply), but OEM hands the flap back to the car: it is never lost and goes right after.
    const OPEN = [0x2F, 0x60, 0xFD, 0x03, 0x03, 0xE8], OEM = [0x2F, 0x60, 0xFD, 0x00];
    b = bus((sid, data) => (sid === 0x22 ? [[0x7F, 0x22, 0x31]] : sid === 0x2F && data[2] === 0x00 ? [echo(sid, data)] : null));
    let arm = 'on';
    const c = new Controller({ log, settings: { get: () => arm }, signals: {} });
    c.link = b.link; c.adapter = Mg1ElAgk; c.real = true;
    const first = c.setMode('OPEN');
    await c.setMode('OEM');
    assert.strictEqual(c.view().requested, 'OEM', 'OEM pressed during OPEN shows nothing on screen');
    await c.setMode('CLOSED'); await c.setMode('OEM');
    assert.strictEqual(c.view().requested, 'OEM');
    const buttons = [];
    UI.draw(anyOf({ own: true }), anyOf({ TOP: 60, BOTTOM: 500, MARGIN: 12, pageBottom: () => 500,
        button: (cv, t, x, y, w, h, label, run, o) => buttons.push([label, !!o.busy]) }), anyOf({}), c.view(), {});
    assert.deepStrictEqual(buttons, [['Open', true], ['Close', true], ['OEM', false], ['Drive mode', true]], 'only OEM stays pressable while a command is in flight');
    await later(10);
    assert.deepStrictEqual(b.sent.filter((s) => s[0] === 0x2F), [OPEN], 'a second flap command went out while one was in flight');
    b.d.emit('frame', { ecu: 0x12, uds: [0x6F, 0x60, 0xFD, 0x03, 0x03, 0xE8] });
    await first;
    assert.deepStrictEqual(b.sent.filter((s) => s[0] === 0x2F), [OPEN, OEM], 'OEM pressed during OPEN was lost');
    assert.strictEqual(c.state.requested, 'OEM');
    assert.strictEqual(c.state.accepted, true);
    assert.strictEqual(c.state.busy, false);
    // disarmed while OEM waits: the OEM pressed while armed still goes (it hands the flap back), then nothing
    b.sent.length = 0; c.adapter = Mg1ElAgk; c.real = true; c.link = b.link;
    const second = c.setMode('OPEN');
    await c.setMode('OEM');
    arm = 'off';
    const disarm = c.refresh();
    await later(10);
    assert.strictEqual(Mg1ElAgk.armed, true, 'disarmed before the queued OEM went');
    b.d.emit('frame', { ecu: 0x12, uds: [0x6F, 0x60, 0xFD, 0x03, 0x03, 0xE8] });
    await second; await disarm;
    assert.deepStrictEqual(b.sent.filter((s) => s[0] === 0x2F), [OPEN, OEM], 'the OEM pressed before the disarm was lost');
    assert.strictEqual(c.state.requested, 'OEM');
    assert.strictEqual(c.real, false, 'still the car adapter after the disarm');
    b.sent.length = 0;
    await c.setMode('OPEN');
    assert.deepStrictEqual(b.sent.filter((s) => s[0] === 0x2F), [], 'sent to the car while disarmed');
    // OEM pressed after the disarm, while it still waits for OPEN: nothing more goes to the car
    arm = 'on'; Mg1ElAgk.armed = true;
    b.sent.length = 0; c.adapter = Mg1ElAgk; c.real = true; c.link = b.link;
    const third = c.setMode('OPEN');
    arm = 'off';
    const disarm2 = c.refresh();
    await c.setMode('OEM');
    b.d.emit('frame', { ecu: 0x12, uds: [0x6F, 0x60, 0xFD, 0x03, 0x03, 0xE8] });
    await third; await disarm2;
    assert.deepStrictEqual(b.sent.filter((s) => s[0] === 0x2F), [OPEN], 'an OEM pressed after the disarm went to the car');
    assert.strictEqual(c.real, false);
    arm = 'on'; Mg1ElAgk.armed = true;

    // 2. A stray 62 F40C is no answer to the flap probe: the matched-DME gate holds.
    b = bus((sid, data) => (sid === 0x22 ? [FOREIGN, [0x7F, 0x22, 0x31]] : null));
    const ident = await b.link.identifyDme();
    assert.strictEqual(ident.elAgk.supported, false, 'a foreign read made the flap probe pass');
    assert.strictEqual(Mg1ElAgk.match(ident), false);
    assert.strictEqual(ident.present, false);
    // readElAgk decodes only its own DID, not one that crossed (64FD's bytes for 62FD).
    b = bus((sid, data) => (data[0] === 0x62 ? [[0x62, 0x64, 0xFD, 0x27, 0x10], [0x62, 0x62, 0xFD, 0x03, 0xE8]]
        : [[0x62, 0x62, 0xFD, 0x27, 0x10], [0x62, 0x64, 0xFD, 0x00, 0x05]]));
    assert.deepStrictEqual(await b.link.readElAgk(), { supported: true, commandedPct: 10, positionRaw: '00 05' });

    // 3. MHD map / Max Cooling: a foreign 7F 22 31 is not the DME refusing; its 6F echo counts.
    const ctx = { log, settings: { get: (k) => (k === 'tuner' ? 'mhd' : undefined) }, spec: { config: {} } };
    b = bus((sid, data) => (sid === 0x2F ? [[0x7F, 0x22, 0x31], FOREIGN, echo(sid, data)] : null));
    const tune = new TuneControl(ctx, { rpm: () => 800 });
    await tune.start(b.link);
    await tune.setMap(3);
    assert.strictEqual(tune.note, 'Map 3 · accepted by the DME');
    assert.strictEqual(tune.map, 3);
    await tune.setCooling(true);
    assert.strictEqual(tune.cooling, 'ON');
    b = bus((sid, data) => (sid === 0x2F ? [FOREIGN, [0x7F, 0x2F, 0x31]] : null));   // an untuned DME still refuses
    await tune.start(b.link);
    await tune.setMap(2);
    assert.strictEqual(tune.note, 'Not available on this car');

    // 6. Settings: with the DME found, a theme change sends nothing; Car control re-detects it; while none
    // was found (asleep at start-up), any change looks again.
    const keys = require(path.join(root, 'apps/live_adjustments/app.json')).settings.map((x) => x.key);
    const { REFRESH_KEYS } = require(path.join(src, 'controller'));
    assert(REFRESH_KEYS.every((k) => keys.includes(k)), 'REFRESH_KEYS names a key that is not a setting: ' + REFRESH_KEYS);
    const sent = [];
    let onResp, awake = true;
    const signals = { watch: async () => ({}), proxy: async () => ({}), on: async (p, n, fn) => { onResp = fn; }, onAvailable: async (p, fn) => fn(true),
        call: async (p, m, a) => {
            sent.push(a.serviceID);
            const did = [...a.udsData].slice(0, 2);
            const uds = awake && a.serviceID === 0x22 && did[0] === 0xF1 ? [0x62].concat(did, [0x41]) : [0x7F, a.serviceID, 0x31];
            setImmediate(() => onResp({ errorCode: 'NO_ERROR', udsResponse: [0, 0, 0, 0, 0, 0, a.targetAddress, 0, 0].concat(uds) }));
            return 'NO_ERROR';
        } };
    const values = { arm: 'on', tuner: 'off', theme: 'm_red' }, changed = [];
    require(path.join(src, 'main'));
    const app = require(path.join(src, 'kit/mgu')).app;
    await app.start({ log, signals, spec: { config: {} }, theme: () => anyOf({}), canvas: () => null,
        settings: { get: (k) => values[k], onChange: (fn) => changed.push(fn) }, ui: { onClick() {}, image: async () => {} },
        loop: () => ({ kick() {} }), hideButton() {}, onTab() {} });
    const n0 = sent.length;
    assert(n0 > 0, 'start reads the DME identity');
    const set = async (k, v) => { values[k] = v; changed.forEach((fn) => fn(k, v)); await later(30); };
    for (const [k, v] of [['theme', 'ice'], ['renderer', 'software'], ['demo', 'on'], ['tuner', 'mhd']]) {
        await set(k, v);
        assert.strictEqual(sent.length, n0, 'a ' + k + ' change sent ' + (sent.length - n0) + ' DME requests');
    }
    await set('arm', 'off');
    assert.strictEqual(sent.length, n0);                          // disarmed: nothing at all
    await set('arm', 'on');
    assert(sent.length > n0, 'arming re-detects the DME');
    awake = false;                                              // the DME asleep: not found at the next look
    await set('arm', 'off'); await set('arm', 'on');
    let n = sent.length;
    awake = true;
    await set('theme', 'm_red');
    assert(sent.length > n, 'a setting change while no DME was found did not look again');
    n = sent.length;
    await set('theme', 'ice');
    assert.strictEqual(sent.length, n, 'found again: a theme change sends nothing');
    // 4. A G-series V8 (DME8FF_R at 0x12, DME8FF_L at 0x13, #214): each unit drives its bank's flap, both are sent it.
    //    A unit that refuses 60FD but has the controlled flap (22 631E) gets 2F 611E; OEM hands back what took it.
    Mg1ElAgk.armed = true;
    let refuse60 = 0;                           // the unit that refuses 2F 60FD 03 (the controlled flap running)
    const v8 = (sid, data, to) => {
        if (sid === 0x22) {
            const did = (data[0] << 8) | data[1];
            if (did === 0xF150) return to === 0x12 ? [[0x62, 0xF1, 0x50, 0x0F, 0x24, 0x2C]] : [[0x62, 0xF1, 0x50, 0x0F, 0x24, 0x2E]];
            if (did === 0x62FD || did === 0x64FD || did === 0x631E) return [[0x62, data[0], data[1], 0x00, 0x00]];
            return [[0x7F, 0x22, 0x31]];
        }
        if (sid === 0x2F && data[0] === 0x60 && data[2] === 0x03 && to === refuse60) return [[0x7F, 0x2F, 0x22]];
        if (sid === 0x2F) return [echo(sid, data)];
        return null;
    };
    b = bus(v8);
    const id8 = await b.link.identifyDme();
    assert.strictEqual(id8.twin, true);
    assert.deepStrictEqual(id8.elAgk.units, ['12 el ger', '13 el ger']);
    assert.strictEqual(Mg1ElAgk.match(id8), true);
    b.sent.length = 0;
    r = await Mg1ElAgk.open(b.link);
    assert.strictEqual(r.accepted, true);
    assert.strictEqual(r.detail, '12: accepted, 13: accepted');
    assert.deepStrictEqual(b.sent, [[0x2F, 0x60, 0xFD, 0x03, 0x03, 0xE8], [0x2F, 0x60, 0xFD, 0x03, 0x03, 0xE8]]);
    refuse60 = 0x13; b.sent.length = 0;
    r = await Mg1ElAgk.open(b.link);
    assert.strictEqual(r.detail, '12: accepted, 13: accepted (controlled flap)');
    assert.deepStrictEqual(b.sent.slice(1), [[0x2F, 0x60, 0xFD, 0x03, 0x03, 0xE8], [0x2F, 0x61, 0x1E, 0x03, 0x20, 0x00]], '100 % = 8192');
    b.sent.length = 0;
    r = await Mg1ElAgk.closed(b.link);
    assert.deepStrictEqual(b.sent.slice(-1), [[0x2F, 0x61, 0x1E, 0x03, 0x00, 0x00]], 'closed = 0 %');
    b.sent.length = 0;
    r = await Mg1ElAgk.oem(b.link);
    assert.strictEqual(r.accepted, true);
    assert.deepStrictEqual(b.sent, [[0x2F, 0x60, 0xFD, 0x00], [0x2F, 0x60, 0xFD, 0x00], [0x2F, 0x61, 0x1E, 0x00]], 'OEM hands back the controlled flap it took');
    b.sent.length = 0;
    await Mg1ElAgk.oem(b.link);
    assert.deepStrictEqual(b.sent, [[0x2F, 0x60, 0xFD, 0x00], [0x2F, 0x60, 0xFD, 0x00]], 'then only 60FD');
    // a six-cylinder (one unit): 0x13 is never asked, the command goes to 0x12 only as before
    b = bus((sid, data, to) => (to === 0x13 ? assert.fail('0x13 asked on a six') : sid === 0x22
        ? (data[0] === 0xF1 && data[1] === 0x50 ? [[0x62, 0xF1, 0x50, 0x0F, 0x23, 0x00]] : data[0] === 0x62 || data[0] === 0x64 ? [[0x62, data[0], data[1], 0, 0]] : [[0x7F, 0x22, 0x31]])
        : [echo(sid, data)]));
    const id6 = await b.link.identifyDme();
    assert.deepStrictEqual(id6.elAgk.units, ['12 el']);
    b.sent.length = 0;
    r = await Mg1ElAgk.open(b.link);
    assert.strictEqual(r.detail, 'DME accepted');
    assert.deepStrictEqual(b.sent, [[0x2F, 0x60, 0xFD, 0x03, 0x03, 0xE8]]);

    console.log('Diag reply checks passed (flap echo + busy gate / DID echo + flap probe / MHD echo / settings refresh / V8 both units + controlled flap).');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
