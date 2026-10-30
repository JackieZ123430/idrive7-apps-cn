'use strict';

// Live Adjustments tune functions against in-memory DMEs, per "Tuning software" setting: Off, MHD
// (echo), BM3 (synthetic ROM, memory + read-back), the wrong tune and an untuned DME. No SDK, vehicle or capture needed:
//   node kit/tools/test_live_adjustments.js

const assert = require('assert');
const { TuneControl } = require('../../apps/live_adjustments/tune');

function dme(kind) {
    const calls = [];
    const memory = { D001D006: [1, 1], D001D099: [0], D001D116: Array(24).fill(0) };   // BM3 ROM 011000 layout
    const physical = async (target, sid, data) => {
        assert.strictEqual(target, 0x12);
        calls.push([sid].concat(data).map((b) => b.toString(16).padStart(2, '0')).join(' '));
        const addr = () => Buffer.from(data.slice(1, 5)).toString('hex').toUpperCase();
        if (kind === 'bm3') {
            if (sid === 0x2C) return [0x6C, 0x02, 0xF3, 0x01];
            if (sid === 0x22) return [0x62, 0xF3, 0x01].concat(Array.from(Buffer.from('BM3_R#011000#')));
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
    return { calls, memory, link };
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

    console.log('Live Adjustments tune checks passed (off / MHD echo / cooling rpm gate / BM3 read-back + ASD / wrong tune / untuned / late link).');
})().catch((e) => { console.error(e); process.exit(1); });
