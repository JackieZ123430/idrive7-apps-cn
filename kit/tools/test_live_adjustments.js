'use strict';

// Live Adjustments tune functions against in-memory DMEs, per "Tuning software" setting: Off, MHD
// (echo), BM3 (synthetic ROM, memory + read-back), the wrong tune and an untuned DME. No SDK, vehicle or capture needed:
//   node kit/tools/test_live_adjustments.js

const assert = require('assert');
const { TuneControl } = require('../../apps/live_adjustments/tune');
const { XDriveControl } = require('../../apps/live_adjustments/xdrive');

function dme(kind) {
    const calls = [];
    const memory = { D001D006: [1, 1], D001D099: [0], D001D116: Array(24).fill(0) };   // BM3 ROM 011000 layout
    let inflight = 0;
    const physical = async (target, sid, data) => {
        assert.strictEqual(target, 0x12);
        calls.push([sid].concat(data).map((b) => b.toString(16).padStart(2, '0')).join(' '));
        d.maxInflight = Math.max(d.maxInflight, ++inflight);
        await new Promise(setImmediate);                                // the DME answers later
        inflight--;
        const addr = () => Buffer.from(data.slice(1, 5)).toString('hex').toUpperCase();
        if (kind === 'bm3') {
            if (sid === 0x2C) return [0x6C, data[0], 0xF3, 0x01];
            if (sid === 0x22) {
                const marker = Buffer.alloc(255);
                marker.write('BM3_R#011000#');
                return [0x62, 0xF3, 0x01].concat(Array.from(marker));
            }
            if (sid === 0x23) return [0x63].concat(memory[addr()].slice(0, data[5]));
            if (sid === 0x3D) { memory[addr()] = data.slice(6); return [0x7D]; }
            if (sid === 0x2E) return [0x6E].concat(data.slice(0, 2));
        }
        if (sid === 0x2C) return [0x7F, 0x2C, 0x33];                    // no BM3 ROM (as on an MHD car)
        if (kind === 'mhd' && sid === 0x2F) return [0x6F].concat(data);  // MHD-style: echo
        return [0x7F, sid, 0x31];                                       // untuned: requestOutOfRange
    };
    // the app's DiagLink, reduced to what tune.js uses
    const link = {
        available: true,
        onAvailable() {},
        diag: { available: true, physical },
        async sendToDme(sid, data) {
            const r = await physical(0x12, sid, data);
            if (!r || !r.length) return { ok: false, reason: 'timeout' };
            if (r[0] === 0x7F) return { ok: false, nrc: r[2], reason: 'NRC ' + r[2].toString(16) };
            return { ok: true, sid: r[0], data: r.slice(1) };
        },
    };
    const d = { calls, memory, link, maxInflight: 0 };
    return d;
}

async function setup(kind, tuner, available, rpm) {
    const d = dme(kind);
    if (available === false) d.link.available = false;
    const ctx = { settings: { get: (k) => (k === 'tuner' ? tuner : undefined) },
        log: { info() {}, warn() {}, error() {} }, spec: { config: { bm3MarkerAddress: '807FFE50' } } };
    const engine = { value: rpm === undefined ? 800 : rpm, rpm() { return this.value; } };   // engine running by default
    const tune = new TuneControl(ctx, engine);
    await tune.start(d.link);
    return { tune, d, ctx, engine };
}
const NONE = { map: false, cooling: false, burbles: false, asd: false };

// A DSC (0x29) that behaves as on ezl0l's G22: DBE1 reads 0 with the engine off, the write is
// accepted only with the engine off, and the value holds until the ignition is cycled.
function dsc(kind) {
    // front: ezl0l's AWD sample; its requested-torque qualifier (last byte) follows the written value
    // (00 20 active, 00 E8 switched off, as in his logs) unless a test sets st.front itself
    const st = { calls: [], engine: false, lmv: 1, written: false, session: 1, front: null };
    const front = () => st.front || [0x00, 0x9E, 0x00, 0x02, 0x00, 0x98, 0x00, st.lmv ? 0x20 : 0xE8];
    // g01: a G01 X3 M40i (DSC_G30N 0F2850, LMV 0F29E0) as measured: the write is taken with the
    // engine running too, DBE1 reads the value with the engine off as well, 01 brings xDrive back
    const g01 = kind === 'g01';
    const physical = async (target, sid, data, timeoutMs, accept) => {
        const req = [sid].concat(data).map((b) => b.toString(16).padStart(2, '0')).join(' ');
        st.calls.push((target === 0x29 ? 'dsc ' : target === 0x19 ? 'lmv ' : target === 0x39 ? 'vip ' : 'other ') + req);
        let r;
        // G05 xDrive45e (issue #52): IB_G05 at 0x29 answers DBE1 but it does nothing; VIP_G05 at 0x39
        // g05ice: a diesel X5 (IB_G05 0F2500, VIP_G05 0F2520) as measured: the VIP takes the job only with the engine
        // off and the ignition on; the engine running gets NRC 33
        const g05 = kind === 'g05' || kind === 'g05vip33' || kind === 'g05ice';
        if (g05 && target === 0x29 && sid === 0x22 && data[0] === 0xF1) r = [0x62, 0xF1, 0x50, 0x00, 0x0F, 0x25, 0x00];
        else if (g05 && target === 0x39 && sid === 0x22 && data[0] === 0xF1) r = [0x62, 0xF1, 0x50, 0x00, 0x0F, 0x25, kind === 'g05ice' ? 0x20 : 0x30];
        else if (g05 && target === 0x39 && sid === 0x22 && data[0] === 0xDB && data[1] === 0x44) r = [0x62, 0xDB, 0x44, st.vip === undefined ? 1 : st.vip];
        else if (g05 && target === 0x39 && sid === 0x2E && data[0] === 0xDB && data[1] === 0x2F) {
            if (kind === 'g05vip33' || (kind === 'g05ice' && st.engine)) r = [0x7F, 0x2E, 0x33];
            else if (kind === 'g05ice') { st.vip = data[2]; r = [0x6E, 0xDB, 0x2F]; }
            else if (!st.engine) r = [0x7F, 0x2E, 0x22];
            else { st.vip = data[2]; r = [0x6E, 0xDB, 0x2F]; }
        } else if (target === 0x39 && sid === 0x22 && data[0] === 0xF1) r = [0x62, 0xF1, 0x50, 0x00, 0x0F, 0x25, 0x30];  // G22: VIP_G05 too
        else if (target === 0x19 && sid === 0x22 && data[0] === 0xF1 && data[1] === 0x50) r = kind === 'nolmv' ? [0x7F, 0x22, 0x31] : [0x62, 0xF1, 0x50, 0x00, 0x0F, g01 ? 0x29 : 0x21, g01 ? 0xE0 : 0x80];
        else if (target === 0x19 && sid === 0x22 && data[0] === 0xDB && data[1] === 0x32) r = kind === 'nolmv' ? [0x7F, 0x22, 0x31] : [0x62, 0xDB, 0x32].concat(front());
        else if (target !== 0x29) r = [0x7F, sid, 0x11];
        else if (kind === 'none') r = [0x7F, sid, 0x31];
        else if (sid === 0x22 && data[0] === 0xF1 && data[1] === 0x50) r = [0x62, 0xF1, 0x50, 0x00, 0x0F, g01 ? 0x28 : 0x25, g01 ? 0x50 : 0x10];
        else if (sid === 0x22 && data[0] === 0xDB && data[1] === 0xE1) r = [0x62, 0xDB, 0xE1, st.engine || g01 ? st.lmv : 0];
        else if (sid === 0x10) {
            if (kind === 'nosession') r = [0x7F, 0x10, 0x22];
            else { st.session = data[0]; r = [0x50, data[0], 0x00, 0x32, 0x01, 0xF4]; }
        } else if (sid === 0x2E && data[0] === 0xDB && data[1] === 0xE1) {
            if ((kind === 'session' || kind === 'nosession' || kind === 'session7e') && st.session !== 3) r = [0x7F, 0x2E, kind === 'session7e' ? 0x7E : 0x7F];
            else if (kind === 'refuse' || (st.engine && !g01)) r = [0x7F, 0x2E, st.engine ? 0x33 : 0x22];
            else if (kind === 'dsc33') r = [0x7F, 0x2E, 0x33];      // G26 outside diagnostic mode (issue #63)
            else { st.lmv = data[2]; st.written = true; r = [0x6E, 0xDB, 0xE1]; }
        } else r = [0x7F, sid, 0x31];
        if (accept) assert(accept(r), 'reply filter rejects the answer to ' + req);
        return r;
    };
    st.link = { available: true, diag: { available: true, physical } };
    return st;
}

/** The PIN in front of the Engine Map tab (pin.js): choose, confirm, unlock, wrong tries, off only with the PIN. */
function pinChecks() {
    const { PinLock, WAIT_MS } = require('../../apps/live_adjustments/pin');
    const vals = { mapPin: false, mapPinCode: {} };
    let clock = 1000;
    let pin = null;
    const set = (k, v) => { vals[k] = v; pin.settingChanged(k, v); };
    pin = new PinLock({ get: (k) => vals[k], set, now: () => clock });
    const type = (d) => String(d).split('').forEach((c) => pin.digit(Number(c)));
    assert.strictEqual(pin.locked(), false, 'locked with the setting off');
    set('mapPin', true);
    assert.strictEqual(pin.locked(), true);
    assert.strictEqual(pin.view().mode, 'choose');
    type('1234'); assert.strictEqual(pin.view().mode, 'again');
    type('9999'); assert.strictEqual(pin.view().mode, 'choose', 'two different PINs were taken');
    type('1234'); type('1234');
    assert.strictEqual(pin.locked(), false, 'not open after choosing');
    assert(vals.mapPinCode.hash && !JSON.stringify(vals.mapPinCode).includes('1234'), 'the PIN is saved as it was typed');
    pin.lock();
    assert.strictEqual(pin.locked(), true, 'still open after leaving the screen');
    type('12'); pin.back(); type('235');            // 1235: wrong
    assert.strictEqual(pin.locked(), true, 'Delete did not take the digit back');
    assert(/4 tries left/.test(pin.view().msg));
    assert.strictEqual(pin.view('Burbles').title, 'Burbles is locked');
    type('1234'); assert.strictEqual(pin.locked(), false, 'the right PIN did not open it');
    pin.lock();
    for (let i = 0; i < 5; i++) type('0000');
    assert(pin.view().wait > 0, 'no wait after 5 wrong PINs');
    type('1234'); assert.strictEqual(pin.locked(), true, 'taken during the wait');
    clock += WAIT_MS + 1;
    type('1234'); assert.strictEqual(pin.locked(), false);
    // off while locked: back on until the PIN; off while open: at once
    pin.lock();
    set('mapPin', false);
    assert.strictEqual(vals.mapPin, true, 'turned off without the PIN');
    assert.strictEqual(pin.view().title, 'Enter the PIN to turn the lock off');
    type('1234');
    assert.strictEqual(vals.mapPin, false);
    assert.deepStrictEqual(vals.mapPinCode, {}, 'the PIN outlived the lock');
    set('mapPin', true); type('5555'); type('5555');
    set('mapPin', false);
    assert.strictEqual(vals.mapPin, false, 'open: not off at once');
    assert.deepStrictEqual(vals.mapPinCode, {});
}

async function xdriveChecks() {
    let clock = 100000;
    const mk = async (setting, kind, live, decorate) => {
        const d = dsc(kind);
        if (decorate) d.link.diag.physical = decorate(d.link.diag.physical);
        const events = [];
        const ctx = { spec: { version: 'test-version' },
            settings: { get: (k) => (k === 'xdrive' ? setting : undefined) },
            log: { info(line) {
                const prefix = 'xdrive-diagnostic ';
                if (line.indexOf(prefix) === 0) events.push(JSON.parse(line.slice(prefix.length)));
            }, warn() {}, error() {} } };
        const car = { v: Object.assign({ rpm: 0, speed: 0, stage: 'P', demo: false }, live), data() { return Object.assign({}, this.v); } };
        const x = new XDriveControl(ctx, car, () => clock);
        await x.start(d.link);
        return { x, d, car, events };
    };
    const writes = (d) => d.calls.filter((c) => c.startsWith('dsc 2e'));

    // Off (default) and unknown values: nothing at all is sent, no tab, a press does nothing
    for (const v of [undefined, 'off', 'yes']) {
        const s = await mk(v, 'g22');
        await s.x.requestOff(); await s.x.requestOff(); s.x.tick();
        assert.deepStrictEqual(s.d.calls, [], 'xdrive ' + v + ' sent something');
        assert.strictEqual(s.x.view().enabled, false);
    }

    // On: identification and DBE1 are reads only; the variant is the tested DSC_G20
    let s = await mk('on', 'g22');
    assert.deepStrictEqual(s.d.calls, ['dsc 22 f1 50', 'dsc 22 db e1', 'lmv 22 f1 50']);
    assert.strictEqual(s.x.view().index, '0F2510');
    assert.strictEqual(s.x.view().tested, true);
    assert.strictEqual(s.x.view().lmvIndex, '0F2180');              // transfer case identified (read only)
    assert.strictEqual(s.x.view().lmvName, 'LMV-G ATC13');
    assert.strictEqual(s.x.view().mode, 'UNKNOWN');                 // engine off: DBE1 = 0 means nothing

    // two presses: the first only asks, the second sends the one write
    await s.x.requestOff();
    assert.deepStrictEqual(writes(s.d), []);
    assert.strictEqual(s.x.view().confirming, true);
    await s.x.requestOff();
    assert.deepStrictEqual(writes(s.d), ['dsc 2e db e1 00']);
    assert.strictEqual(s.x.noteType, 'go');
    // the transfer case is read at once after the accepted write: its qualifier (.. 00 E8) says off
    assert.strictEqual(s.x.view().mode, 'RWD');
    assert.strictEqual(s.x.view().modeFrom, 'lmv');
    assert.strictEqual(s.events.filter((e) => e.event === 'command_accepted').pop().physicalEffect, 'verified_by_lmv');
    // engine started in the same ignition cycle: DBE1 read 0, the LMV still says off -> RWD
    s.car.v.rpm = 700; s.d.engine = true; clock += 5000;
    await s.x.tick();
    assert.strictEqual(s.x.view().mode, 'RWD');
    // ignition cycled (the DSC is back to 1, the LMV qualifier back to 20): AWD, the request is forgotten
    s.d.lmv = 1; clock += 5000;
    await s.x.tick();
    assert.strictEqual(s.x.view().mode, 'AWD');
    assert.strictEqual(s.x.requested, false);
    // no "xDrive on" on a DSC_G20: not measured there, the button is not offered and a press sends nothing
    assert.strictEqual(s.x.view().onAvailable, false);
    await s.x.requestOn(); await s.x.requestOn();
    assert(!s.d.calls.some((c) => /^dsc (11|2e db e1 01|31|2f)/.test(c)), 'xDrive sent something besides the one write: ' + s.d.calls);
    // polling: DBE1 not more often than every 4 s
    const dbe1 = () => s.d.calls.filter((c) => c === 'dsc 22 db e1').length;
    const n = dbe1();
    await s.x.tick(); clock += 1000; await s.x.tick();
    assert.strictEqual(dbe1(), n);

    // front-axle torque from the LMV: every second with the engine running, decoded as BMW's LMV_MOMENT
    // (ezl0l's AWD sample 00 9E 00 02 00 98 00 20 = 39.5 Nm actual / 38.0 Nm requested)
    s.car.v.speed = 9; clock += 1000;
    await s.x.tick();
    assert.deepStrictEqual(s.x.view().torque, { actual: 39.5, requested: 38 });
    assert.strictEqual(s.x.view().peakRequested, 38);
    s.d.front = [0xFF, 0xFE, 0x00, 0x02, 0x00, 0x00, 0x00, 0xE8]; clock += 1000;   // xDrive off: -0.5 / 0.0
    await s.x.tick();
    assert.deepStrictEqual(s.x.view().torque, { actual: -0.5, requested: 0 });
    assert.strictEqual(s.x.view().peakRequested, 38);                // the peak stays
    const lmvReads = s.d.calls.filter((c) => c.startsWith('lmv ')).length;
    await s.x.tick();                                                // within the second: no read
    assert.strictEqual(s.d.calls.filter((c) => c.startsWith('lmv ')).length, lmvReads);
    assert(s.d.calls.filter((c) => c.startsWith('lmv ')).every((c) => c === 'lmv 22 db 32' || c === 'lmv 22 f1 50'),
        'the LMV only gets reads (variant, torque)');
    // engine off: the transfer case is still read (its qualifier gives the mode), the Nm are not shown
    s.car.v.rpm = 0; s.car.v.speed = 0; clock += 5000;
    const before = s.d.calls.filter((c) => c.startsWith('lmv ')).length;
    await s.x.tick();
    assert.strictEqual(s.d.calls.filter((c) => c.startsWith('lmv ')).length, before + 1);
    assert.strictEqual(s.x.view().torque, null);
    assert.strictEqual(s.x.view().mode, 'RWD');                     // .. 00 E8 from st.front

    // an LMV that refuses the torque read (engine running): asked once, then left alone
    s = await mk('on', 'nolmv', { rpm: 800 });
    clock += 5000; await s.x.tick(); clock += 5000; await s.x.tick();
    assert.strictEqual(s.d.calls.filter((c) => c === 'lmv 22 db 32').length, 1);
    assert.strictEqual(s.x.view().torqueOk, false);
    // torque is read only on an xDrive car (the DSC answered DBE1)
    s = await mk('on', 'none', { rpm: 800 });
    clock += 5000; s.x.tick();
    assert(!s.d.calls.some((c) => c.startsWith('lmv ')));

    // a DSC that takes the write only in the extended session: 10 03, then the same write once more
    for (const kind of ['session', 'session7e']) {
        s = await mk('on', kind);
        await s.x.requestOff(); await s.x.requestOff();
        assert.deepStrictEqual(s.d.calls.filter((c) => /^dsc (2e|10)/.test(c)), ['dsc 2e db e1 00', 'dsc 10 03', 'dsc 2e db e1 00'], kind);
        assert.strictEqual(s.x.view().mode, 'RWD', kind);
        assert.strictEqual(s.x.noteType, 'go');
    }
    // the session is refused: no second write, the note says why
    s = await mk('on', 'nosession');
    await s.x.requestOff(); await s.x.requestOff();
    assert.deepStrictEqual(s.d.calls.filter((c) => /^dsc (2e|10)/.test(c)), ['dsc 2e db e1 00', 'dsc 10 03']);
    assert.strictEqual(s.x.view().mode, 'UNKNOWN');
    assert(/refused the extended diagnostic session \(NRC 22\)/.test(s.x.note), s.x.note);
    // a plain refusal (conditions) does not open a session
    s = await mk('on', 'refuse');
    await s.x.requestOff(); await s.x.requestOff();
    assert(!s.d.calls.some((c) => c.startsWith('dsc 10')), 'opened a session for NRC 22');

    // BMW's vehicle state arrives as a name or a wire number
    const Car = require('../../kit/runtime/car');
    assert.strictEqual(Car.conditionOf('FAHREN'), 10);
    assert.strictEqual(Car.conditionOf(7), 7);
    assert.strictEqual(Car.conditionOf('SIGNAL_UNBEFUELLT'), undefined);
    assert.strictEqual(Car.conditionOf(15), undefined);
    // a hybrid on the DBE1 path (G30 530e): READY with the engine stopped may send, as in 0.7.1
    s = await mk('on', 'g22', { rpm: 0, condition: 10 });
    await s.x.requestOff(); await s.x.requestOff();
    assert.deepStrictEqual(writes(s.d), ['dsc 2e db e1 00'], 'READY with the engine stopped must send');
    assert(/drive without switching/.test(s.x.note), s.x.note);
    assert.strictEqual(s.x.view().checks.length, 6);
    assert(!s.d.calls.some((c) => c.startsWith('vip ')), 'a DSC_G20 car never talks to the VIP');

    // G05 xDrive45e (issue #52): IB_G05 at 0x29 -> the VIP path, never the DBE1 write
    s = await mk('on', 'g05', { rpm: 0, condition: 7 });
    assert.deepStrictEqual(s.d.calls, ['dsc 22 f1 50', 'vip 22 f1 50', 'vip 22 db 44', 'lmv 22 f1 50']);
    assert.strictEqual(s.x.view().path, 'vip');
    assert.strictEqual(s.x.view().unit, 'IB_G05');
    assert.strictEqual(s.x.view().vipIndex, '0F2530');
    // ignition on only: the VIP job wants the car running / READY - nothing is sent
    await s.x.requestOff(); await s.x.requestOff();
    assert.deepStrictEqual(s.d.calls.filter((c) => / 2e /.test(c)), []);
    assert(/engine running or READY/.test(s.x.note), s.x.note);
    // READY, stationary in P: the one VIP write, nothing to the DSC
    s.car.v.condition = 10; s.d.engine = true;
    await s.x.requestOff(); await s.x.requestOff();
    assert.deepStrictEqual(s.d.calls.filter((c) => / 2e /.test(c)), ['vip 2e db 2f 00']);
    assert.strictEqual(s.x.view().mode, 'REQUESTED');              // VIP path: the LMV is not read after the write
    assert.strictEqual(s.x.noteType, 'go');
    // the mode is not read from DB44 (it read 0 in AWD on the G22): the LMV qualifier (still .. 00 20
    // in the stub: the VIP write changed nothing there) shows AWD, torque is shown
    s.car.v.speed = 10; clock += 5000;
    await s.x.tick();
    assert.strictEqual(s.x.view().mode, 'AWD');
    assert.strictEqual(s.x.view().modeFrom, 'lmv');
    assert.deepStrictEqual(s.x.view().torque, { actual: 39.5, requested: 38 });
    assert(!s.d.calls.some((c) => /^dsc (2e|10|11)/.test(c)), 'sent something to the IB: ' + s.d.calls);
    assert(s.d.calls.filter((c) => c.startsWith('vip ')).every((c) => /^vip (22 f1 50|22 db 44|2e db 2f 00)$/.test(c)));
    // moving: no write
    s = await mk('on', 'g05', { rpm: 0, condition: 10, speed: 12 });
    s.d.engine = true;
    await s.x.requestOff(); await s.x.requestOff();
    assert.deepStrictEqual(s.d.calls.filter((c) => / 2e /.test(c)), [], 'sent while moving');
    // infotainment only (WOHNEN, 5): the DSC answers NRC 33 there (issue #52) - nothing is sent
    s = await mk('on', 'g22', { rpm: 0, condition: 5 });
    await s.x.requestOff(); await s.x.requestOff();
    assert.deepStrictEqual(writes(s.d), [], 'sent with the ignition off');
    assert(/ignition on/.test(s.x.note), s.x.note);
    // ignition on only (PRUEFEN_ANALYSE_DIAGNOSE): sent; then READY in electric mode (rpm 0) reads the mode
    s = await mk('on', 'g22', { rpm: 0, condition: 7 });
    await s.x.requestOff(); await s.x.requestOff();
    assert.deepStrictEqual(writes(s.d), ['dsc 2e db e1 00']);
    assert.strictEqual(s.x.view().mode, 'RWD');                    // the LMV qualifier, read right after
    s.car.v.condition = 10; s.d.engine = true; clock += 5000;
    await s.x.tick();
    assert.strictEqual(s.x.view().mode, 'RWD', 'READY with rpm 0 must read the mode');
    s.car.v.speed = 20; clock += 1000;
    await s.x.tick();
    assert.deepStrictEqual(s.x.view().torque, { actual: 39.5, requested: 38 }, 'front torque is read while READY');
    // the DSC dropped the request on the way to READY: shown as AWD, not as "requested"
    s.d.lmv = 1; clock += 5000;
    await s.x.tick();
    assert.strictEqual(s.x.view().mode, 'AWD');

    // G01 X3 M40i (DSC_G30N 0F2850, measured): the write goes with the engine running, stationary in P
    s = await mk('on', 'g01', { rpm: 700, condition: 10 });
    s.d.engine = true;
    assert.strictEqual(s.x.view().unit, 'DSC_G30N');
    assert.strictEqual(s.x.view().tested, true);
    assert.strictEqual(s.x.view().lmvName, 'LMV-G ATC13_2');
    assert.strictEqual(s.x.view().onAvailable, true);
    assert(!s.x.view().checks.some((c) => c.label === 'Engine off'), 'no "Engine off" check on 0F2850');
    await s.x.requestOff(); await s.x.requestOff();
    assert.deepStrictEqual(writes(s.d), ['dsc 2e db e1 00'], 'engine running must send on 0F2850');
    assert.strictEqual(s.x.view().mode, 'RWD');
    assert.strictEqual(s.x.view().modeFrom, 'lmv');
    assert(/transfer case reports it/.test(s.x.note), s.x.note);
    // ...but not moving, not in D, not with the ignition off
    for (const live of [{ speed: 4 }, { stage: 'D' }, { condition: 5, rpm: 0 }]) {
        const t = await mk('on', 'g01', Object.assign({ rpm: 700, condition: 10 }, live));
        t.d.engine = true;
        await t.x.requestOff(); await t.x.requestOff();
        assert.deepStrictEqual(writes(t.d), [], 'g01 sent with ' + JSON.stringify(live));
    }
    // "xDrive on": its own double press (a confirm from the other button does not count), 2E DB E1 01,
    // the LMV qualifier back to 20 -> AWD, the note names the stored DTC
    await s.x.requestOn();
    assert.strictEqual(s.x.view().confirmWhat, 'on');
    assert.deepStrictEqual(writes(s.d), ['dsc 2e db e1 00']);
    await s.x.requestOff();                                          // asks again for "off" instead
    assert.strictEqual(s.x.view().confirmWhat, 'off');
    assert.deepStrictEqual(writes(s.d), ['dsc 2e db e1 00']);
    await s.x.requestOn(); await s.x.requestOn();
    assert.deepStrictEqual(writes(s.d), ['dsc 2e db e1 00', 'dsc 2e db e1 01']);
    assert.strictEqual(s.x.view().mode, 'AWD');
    assert.strictEqual(s.x.requested, false);
    assert(/480724/.test(s.x.note), s.x.note);
    assert.strictEqual(s.events.filter((e) => e.event === 'command_accepted').pop().physicalEffect, 'verified_by_lmv');
    // the engine off on the G01: DBE1 reads the value there too; the write is taken as before
    s = await mk('on', 'g01', { rpm: 0, condition: 7 });
    clock += 5000; await s.x.tick();
    assert.strictEqual(s.x.view().mode, 'AWD');
    await s.x.requestOff(); await s.x.requestOff();
    assert.deepStrictEqual(writes(s.d), ['dsc 2e db e1 00']);
    assert.strictEqual(s.x.view().mode, 'RWD');

    // issue #28: rpm still above 50 just after switching off, but the car says ignition on (7): sent
    for (const rpm of [80, 600, null]) {
        s = await mk('on', 'g22', { rpm, condition: 7 });
        await s.x.requestOff(); await s.x.requestOff();
        assert.deepStrictEqual(writes(s.d), ['dsc 2e db e1 00'], 'stale rpm ' + rpm + ' with ignition on must send');
    }
    // ...but with the engine running (READY, rpm up) it is still blocked
    s = await mk('on', 'g22', { rpm: 750, condition: 10 });
    await s.x.requestOff(); await s.x.requestOff();
    assert.deepStrictEqual(writes(s.d), [], 'sent with the engine running');

    // the ICE G05 (VIP 0F2520): the job with the engine off and the ignition on, never while it runs
    s = await mk('on', 'g05ice', { rpm: 800, condition: 10 });
    s.d.engine = true;
    assert.strictEqual(s.x.view().vipIndex, '0F2520');
    await s.x.requestOff(); await s.x.requestOff();
    assert.deepStrictEqual(s.d.calls.filter((c) => / 2e /.test(c)), [], 'sent with the engine running');
    assert(/engine off/.test(s.x.note), s.x.note);
    s.car.v.condition = 7; s.car.v.rpm = 0; s.d.engine = false;
    await s.x.requestOff(); await s.x.requestOff();
    assert.deepStrictEqual(s.d.calls.filter((c) => / 2e /.test(c)), ['vip 2e db 2f 00']);
    assert.strictEqual(s.x.noteType, 'go');
    assert(/start the engine without switching the ignition off/.test(s.x.note), s.x.note);
    assert(!s.d.calls.some((c) => /^dsc (2e|10|11)/.test(c)), 'sent something to the IB: ' + s.d.calls);
    // its NRC 33 says the engine runs (an rpm the car still reports while it stops), not an unlock
    s = await mk('on', 'g05ice', { rpm: 0, condition: 7 });
    s.d.engine = true;
    await s.x.requestOff(); await s.x.requestOff();
    assert(/engine is running/.test(s.x.note) && !/unlock/.test(s.x.note), s.x.note);

    // a VIP that wants security access (G05, issue #52): said plainly, nothing recorded as done
    s = await mk('on', 'g05vip33', { rpm: 0, condition: 10 });
    s.d.engine = true;
    await s.x.requestOff(); await s.x.requestOff();
    assert.deepStrictEqual(s.d.calls.filter((c) => / 2e /.test(c)), ['vip 2e db 2f 00']);
    assert(/VIP refused: security access/.test(s.x.note), s.x.note);
    assert.strictEqual(s.x.requested, false);

    // a confirm press that comes too late only asks again
    s = await mk('on', 'g22');
    await s.x.requestOff(); clock += 7000; await s.x.requestOff();
    assert.deepStrictEqual(writes(s.d), []);

    // the head unit sees a condition not met: nothing is sent, the note says which
    for (const [live, why] of [[{ rpm: 800 }, /engine off/], [{ rpm: null }, /engine off/], [{ speed: 3 }, /stationary/],
        [{ speed: null }, /stationary/], [{ stage: 'D' }, /selector/], [{ stage: 'R' }, /selector/], [{ demo: true }, /live car data/i]]) {
        s = await mk('on', 'g22', live);
        await s.x.requestOff(); await s.x.requestOff();
        assert.deepStrictEqual(writes(s.d), [], 'sent with ' + JSON.stringify(live));
        assert(why.test(s.x.note), JSON.stringify(live) + ': ' + s.x.note);
    }
    // the selector unknown (some cars send no P): allowed, the DSC checks it itself
    s = await mk('on', 'g22', { stage: undefined });
    await s.x.requestOff(); await s.x.requestOff();
    assert.deepStrictEqual(writes(s.d), ['dsc 2e db e1 00']);

    // NRC 33 with the engine off and every check green (G26 outside diagnostic mode, issue #63): the tab says
    // to try diagnostic mode, nothing recorded as done
    s = await mk('on', 'dsc33');
    await s.x.requestOff(); await s.x.requestOff();
    assert(/DSC refused: .*diagnostic mode: press Start 3 times without the brake/.test(s.x.note), s.x.note);
    assert.strictEqual(s.x.requested, false);
    // the DSC refuses the write (e.g. parking brake off): shown, nothing recorded as done
    s = await mk('on', 'refuse');
    await s.x.requestOff(); await s.x.requestOff();
    assert.strictEqual(s.x.requested, false);
    assert(/DSC refused: conditions not met/.test(s.x.note), s.x.note);

    // a DSC without LMV_FUNKTION (rear-wheel-drive car): the read is refused and no write is ever sent
    s = await mk('on', 'none');
    assert.strictEqual(s.x.view().supported, false);
    await s.x.requestOff(); await s.x.requestOff(); clock += 10000; s.x.tick();
    assert.deepStrictEqual(writes(s.d), []);
    assert.strictEqual(s.d.calls.length, 2);                         // no polling after the refusal

    // no diagnostic link: nothing sent until it comes up
    s = await mk('on', 'g22');
    s.d.link.available = false; s.d.calls.length = 0;
    await s.x.refresh(); await s.x.requestOff(); await s.x.requestOff(); s.x.tick();
    assert.deepStrictEqual(s.d.calls, []);

    // Diagnostics observe existing traffic; raw NRCs do not imply an engine-state diagnosis.
    for (const kind of ['g22', 'g05']) {
        for (const nrc of [0x13, 0x22, 0x31, 0x33, 0x42, 0x83, 0x90]) {
            const live = { rpm: kind === 'g05' ? 800 : 0, condition: kind === 'g05' ? 10 : 7 };
            s = await mk('on', kind, live, (physical) => async (target, sid, data, timeout, accept) =>
                sid === 0x2E ? [0x7F, sid, nrc] : physical(target, sid, data, timeout, accept));
            await s.x.requestOff(); await s.x.requestOff();
            const tx = s.events.find((e) => e.event === 'uds_request' && e.request.startsWith('2E'));
            const rx = s.events.find((e) => e.event === 'uds_result' && e.exchangeId === tx.exchangeId);
            assert.strictEqual(rx.status, 'negative_response');
            assert.strictEqual(rx.response, '7F 2E ' + nrc.toString(16).padStart(2, '0').toUpperCase());
            assert.strictEqual(rx.nrc.hex, nrc.toString(16).padStart(2, '0').toUpperCase());
            assert.strictEqual(typeof rx.nrc.name, 'string');
            if (nrc === 0x42) assert.strictEqual(rx.nrc.name, 'unknownNrc');
            if (nrc === 0x33) assert.strictEqual(rx.nrc.name, 'securityAccessDenied');
            assert.strictEqual(rx.target, kind === 'g05' ? '39' : '29');
            assert.strictEqual(tx.request, kind === 'g05' ? '2E DB 2F 00' : '2E DB E1 00');
            assert.strictEqual(rx.attemptId, tx.attemptId);
            assert.strictEqual(rx.snapshot.vehicle.rpm, live.rpm);
            assert.strictEqual(rx.snapshot.vehicle.condition, live.condition);
            assert.strictEqual(rx.snapshot.vehicle.parkingBrake.status, 'unknown');
            assert.strictEqual(rx.snapshot.appVersion, 'test-version');
            assert.strictEqual(rx.snapshot.physicalClutchState, 'not_measured');
            assert.strictEqual(s.x.requested, false);
        }
    }

    for (const kind of ['session', 'session7e', 'nosession']) {
        s = await mk('on', kind, { condition: 7 });
        await s.x.requestOff(); await s.x.requestOff();
        const requests = s.events.filter((e) => e.event === 'uds_request');
        assert.deepStrictEqual(requests.map((e) => e.request),
            kind === 'nosession' ? ['2E DB E1 00', '10 03'] : ['2E DB E1 00', '10 03', '2E DB E1 00']);
        assert.strictEqual(new Set(requests.map((e) => e.exchangeId)).size, requests.length);
        assert.strictEqual(new Set(requests.map((e) => e.attemptId)).size, 1);
        assert.strictEqual(s.events.some((e) => e.event === 'command_accepted'), kind !== 'nosession');
    }

    for (const [response, expected] of [[null, 'no_response'], [[], 'no_response'],
        [[0x6E, 0xDB], 'unexpected_response'], [[0x7F, 0x22, 0x33], 'unexpected_response'],
        [[0x7F, 0x2E, 0x78], 'response_pending']]) {
        s = await mk('on', 'g22', { condition: 7 });
        s.d.link.diag.physical = async () => response;
        assert.strictEqual(await s.x._exchange(0x29, 0x2E, [0xDB, 0xE1, 0], 3000, () => true), response);
        assert.strictEqual(s.events[s.events.length - 1].status, expected);
    }

    s = await mk('on', 'g22', { condition: 7 });
    const err = new Error('test transport unavailable');
    s.d.link.diag.physical = async () => { throw err; };
    await assert.rejects(s.x._exchange(0x29, 0x22, [0xDB, 0xE1], 2500, () => true),
        (e) => e === err);
    let event = s.events[s.events.length - 1];
    assert.strictEqual(event.status, 'transport_error');
    assert.strictEqual(event.error, err.message);
    assert.strictEqual(event.snapshot.reads['29:DB E1'].status, 'transport_error');
    assert.strictEqual(event.snapshot.reads['29:DB E1'].response, null);

    // Unknown identities and missing telemetry remain explicit; arbitrary fields are not dumped.
    s = await mk('on', 'g22', { rpm: null, speed: null, stage: undefined, condition: 6,
        vin: 'DO-NOT-LOG', serialNumber: 'DO-NOT-LOG', other: { private: 'DO-NOT-LOG' } },
    (physical) => async (target, sid, data, timeout, accept) =>
        sid === 0x22 && data[0] === 0xF1 ? [0x62, 0xF1, 0x50, 0xAA, 0xBB, 0xCC]
            : physical(target, sid, data, timeout, accept));
    await s.x.requestOff();
    event = s.events[s.events.length - 1];
    assert.strictEqual(event.event, 'blocked');
    assert.strictEqual(event.snapshot.dscIndex, 'AABBCC');
    assert.strictEqual(event.snapshot.dscUnit, null);
    assert.strictEqual(event.snapshot.vehicle.rpm, null);
    assert.strictEqual(event.snapshot.vehicle.selector, null);
    assert.strictEqual(event.snapshot.vehicle.conditionName, 'unknown');
    assert(event.snapshot.checks.some((c) => c.label === 'Parking brake on' && c.status === 'unknown'));
    assert(!JSON.stringify(s.events).includes('DO-NOT-LOG'));

    s = await mk('on', 'g22', { demo: true });
    await s.x.requestOff();
    event = s.events[s.events.length - 1];
    assert.strictEqual(event.snapshot.vehicle.source, 'demo');
    assert.strictEqual(event.snapshot.vehicle.rpm, null);
    assert.strictEqual(event.snapshot.vehicle.condition, null);
    assert.strictEqual(event.event, 'blocked');
    assert.deepStrictEqual(writes(s.d), []);

    s = await mk('on', 'g22');
    s.x.busy = true;
    await s.x.requestOff();
    event = s.events[s.events.length - 1];
    assert.strictEqual(event.reason, 'Busy');
    assert.deepStrictEqual(writes(s.d), []);

    // Successful reads are bounded to the trace window; failed reads are still recorded afterwards.
    s = await mk('on', 'g22', { condition: 7 });
    await s.x.requestOff(); await s.x.requestOff();
    const accepted = s.events.find((e) => e.event === 'command_accepted');
    assert.strictEqual(accepted.physicalEffect, 'verified_by_lmv');   // the DB32 qualifier read right after
    // an LMV that does not answer at the moment of the write: nothing is claimed
    s = await mk('on', 'g22', { condition: 7 }, (physical) => async (target, sid, data, timeout, accept) =>
        target === 0x19 && data[0] === 0xDB ? [0x7F, 0x22, 0x22] : physical(target, sid, data, timeout, accept));
    await s.x.requestOff(); await s.x.requestOff();
    assert.strictEqual(s.events.find((e) => e.event === 'command_accepted').physicalEffect, 'not_verified');
    assert.strictEqual(s.x.view().mode, 'REQUESTED');
    s = await mk('on', 'g22', { condition: 7 });
    await s.x.requestOff(); await s.x.requestOff();
    s.car.v.rpm = 800; s.car.v.condition = 10; clock += 5000;
    await s.x.tick();
    const poll = s.events.find((e) => e.event === 'uds_result' && e.request === '22 DB 32');
    assert(poll && poll.attemptId === accepted.attemptId);
    assert.strictEqual(poll.response, '62 DB 32 00 9E 00 02 00 98 00 E8');   // the stub's qualifier follows the write
    let count = s.events.length;
    clock += 61000;
    await s.x.tick();
    assert.strictEqual(s.events.length, count);
    const snapshot = s.x._snapshot();
    assert.strictEqual(snapshot.reads['19:F1 50'].ageMs, 66000);
    assert.strictEqual(snapshot.reads['29:DB E1'].ageMs, 0);
    s.d.link.diag.physical = async () => [0x7F, 0x22, 0x31];
    clock += 5000;
    await s.x.tick();
    assert(s.events.length > count);
    assert(s.events.slice(count).every((e) => e.attemptId === null));
}

(async () => {
    // Off (the default) - and an unknown value counts as Off: nothing is sent, no tune tab.
    for (const v of ['off', undefined, 'on', 'mgflasher']) {
        const s = await setup('mhd', v);
        assert.deepStrictEqual(s.tune.features(), NONE);
        await s.tune.setMap(2); await s.tune.setCooling(true); await s.tune.applyBurbles(false); await s.tune.setAsd(true);
        assert.deepStrictEqual(s.d.calls, [], 'tuner ' + v + ' sent something');
    }

    // MHD: map + cooling; nothing sent on start (nothing to identify); a press counts on the DME's echo.
    let s = await setup('mhd', 'mhd');
    assert.deepStrictEqual(s.d.calls, []);
    assert.deepStrictEqual(s.tune.features(), { map: true, cooling: true, burbles: false, asd: false });
    await s.tune.setMap(2);
    assert.strictEqual(s.d.calls.at(-1), '2f 01 01');               // map N = N - 1
    assert.strictEqual(s.tune.map, 2);
    assert.strictEqual(s.tune.mapConfirmed, false);                 // no read-back of the map
    await s.tune.setCooling(true);
    assert.strictEqual(s.d.calls.at(-1), '2f 03 01');
    assert.strictEqual(s.tune.cooling, 'ON');
    let sent = s.d.calls.length;
    await s.tune.applyBurbles(false); await s.tune.setAsd(true);   // not MHD features
    assert.strictEqual(s.d.calls.length, sent);
    assert.strictEqual(s.tune.noteType, 'warn');
    assert(!s.d.calls.some((c) => /^(2c|3d|3e|2e)/.test(c)), 'MHD never gets a BM3 request');

    // A second press while a command is in flight is not sent (it would share the first one's echo).
    s = await setup('mhd', 'mhd');
    await Promise.all([s.tune.setMap(2), s.tune.setMap(3), s.tune.setCooling(true)]);
    assert.deepStrictEqual(s.d.calls, ['2f 01 01'], 'a second MHD press went out during a command');
    assert.strictEqual(s.tune.map, 2);
    assert.strictEqual(s.tune.cooling, null);

    // Max Cooling ON needs the engine running (live rpm over 500); OFF is always allowed.
    for (const r of [null, 0, 450, 500]) {
        s = await setup('mhd', 'mhd', true, r);
        await s.tune.setCooling(true);
        assert.deepStrictEqual(s.d.calls, [], 'cooling on sent at rpm ' + r);
        assert.strictEqual(s.tune.cooling, null);
        assert.strictEqual(s.tune.noteType, 'warn');
        assert(/Start the engine/.test(s.tune.note));
        await s.tune.setCooling(false);
        assert.strictEqual(s.d.calls.at(-1), '2f 03 00', 'cooling off must always be sendable');
    }
    s = await setup('mhd', 'mhd', true, 501);
    await s.tune.setCooling(true);
    assert.strictEqual(s.d.calls.at(-1), '2f 03 01');
    s.engine.value = 300; s.d.calls.length = 0;                    // engine stopped since
    await s.tune.setCooling(true);
    assert.deepStrictEqual(s.d.calls, []);
    await s.tune.setMap(3);                                         // the map is not rpm-gated
    assert.strictEqual(s.d.calls.at(-1), '2f 01 02');

    // BM3: map and burbles written to memory and confirmed by read-back; ASD; no cooling.
    s = await setup('bm3', 'bm3');
    assert.deepStrictEqual(s.tune.features(), { map: true, cooling: false, burbles: true, asd: true });
    assert.strictEqual(s.tune.map, 2);
    assert.strictEqual(s.tune.mapConfirmed, true);
    await s.tune.setMap(4);
    assert.deepStrictEqual(s.d.memory.D001D006, [3, 1]);
    assert.strictEqual(s.tune.map, 4);
    s.tune.stepAggression(0.5); s.tune.stepAggression(0.5);         // -/+ send nothing
    await s.tune.applyBurbles(false);
    assert.deepStrictEqual(s.d.memory.D001D116, Array(24).fill(0xFB));
    assert.strictEqual(s.tune.burbles, '2.5');
    await s.tune.applyBurbles(true);
    assert.strictEqual(s.tune.burbles, 'off');
    await s.tune.setAsd(false);
    assert.strictEqual(s.d.calls.at(-1), '2e 5f fd 01');
    assert.strictEqual(s.tune.asd, false);
    sent = s.d.calls.length;
    await s.tune.setCooling(true);                                  // not a BM3 feature
    assert.strictEqual(s.d.calls.length, sent);
    assert(!s.d.calls.some((c) => c.startsWith('2f 01') || c.startsWith('2f 03')), 'a BM3 DME never gets an MHD command');

    // BM3 picked, but the DME has no BM3 ROM: identification fails, no memory is written.
    s = await setup('mhd', 'bm3');
    assert.strictEqual(s.tune.noteType, 'warn');
    await s.tune.setMap(3); await s.tune.applyBurbles(false);
    assert(!s.d.calls.some((c) => /^(3d|3e)/.test(c)), 'no memory write without a verified BM3 ROM');
    assert.strictEqual(s.tune.map, null);

    // MHD picked on an untuned DME: it refuses, nothing is recorded as done.
    s = await setup('stock', 'mhd');
    await s.tune.setMap(1);
    assert.strictEqual(s.tune.note, 'Not available on this car');
    assert.strictEqual(s.tune.map, null);
    await s.tune.setCooling(true);
    assert.strictEqual(s.tune.cooling, null);

    // The diagnostic link comes up after the app started: nothing before, BM3 identified after.
    s = await setup('bm3', 'bm3', false);
    assert.deepStrictEqual(s.d.calls, []);
    assert.strictEqual(s.tune.note, 'Waiting for the diagnostic link');
    s.d.link.available = true;
    await s.tune.refresh();
    assert.strictEqual(s.tune.map, 2);

    // One DME conversation at a time (BM3's 0x63 replies carry no address): a refresh waits for the
    // command in flight, two refreshes run as one, and a press during a refresh is not sent.
    s = await setup('bm3', 'bm3');
    s.d.maxInflight = 0;
    const press = s.tune.setMap(4), again = s.tune.refresh();
    await s.tune.setMap(1);
    await Promise.all([press, again]);
    assert.strictEqual(s.d.maxInflight, 1, 'a refresh ran alongside a command');
    assert.deepStrictEqual(s.d.memory.D001D006, [3, 1]);
    assert.strictEqual(s.tune.map, 4);
    assert.strictEqual(s.tune.busy, false);
    s.d.calls.length = 0; s.d.maxInflight = 0;
    await Promise.all([s.tune.refresh(), s.tune.refresh()]);
    assert.strictEqual(s.d.maxInflight, 1, 'two refreshes overlapped');
    assert.strictEqual(s.d.calls.filter((c) => c === '2c 03 f3 01').length, 1);
    assert.strictEqual(s.d.calls.filter((c) => c.startsWith('2c 02')).length, 1);
    const pending = s.tune.refresh();
    assert.strictEqual(s.tune.view().busy, true);
    await s.tune.applyBurbles(false);
    assert.strictEqual(s.tune.view().note, 'Reading the DME - press again in a moment', 'a press during a refresh did nothing on screen');
    await pending;
    assert.notStrictEqual(s.tune.view().note, 'Reading the DME - press again in a moment', 'the busy note outlived the refresh');
    assert(!s.d.calls.some((c) => c.startsWith('3d')), 'a press was sent during a refresh');
    assert.strictEqual(s.tune.verified, true);

    await xdriveChecks();
    pinChecks();
    console.log('Live Adjustments tune checks passed (off / MHD echo / cooling rpm gate / BM3 read-back + ASD / wrong tune / untuned / late link / one request at a time / xDrive / Engine Map PIN).');
})().catch((e) => { console.error(e); process.exit(1); });
