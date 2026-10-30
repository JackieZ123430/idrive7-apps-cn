'use strict';

// Live Adjustments tune functions against in-memory DMEs: Disarmed, MHD-style (echo), BM3
// (synthetic ROM, memory + read-back) and an untuned DME. No SDK, vehicle or capture needed:
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
        }
        if (sid === 0x2C) return [0x7F, 0x2C, 0x33];                    // no BM3 ROM (as on an MHD car)
        if (kind === 'mhd' && sid === 0x2F) return [0x6F].concat(data);  // MHD-style: echo
        return [0x7F, sid, 0x31];                                       // untuned: requestOutOfRange
    };
    // the app's DiagLink, reduced to what tune.js uses
    const link = {
        available: true,
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

async function setup(kind, armed) {
    const d = dme(kind);
    const ctx = { settings: { get: (k) => (k === 'tune' ? (armed ? 'on' : 'off') : undefined) },
        log: { info() {}, warn() {}, error() {} }, spec: { config: { bm3MarkerAddress: '807FFE50' } } };
    const tune = new TuneControl(ctx);
    await tune.start(d.link);
    return { tune, d };
}

(async () => {
    // Disarmed (the default): nothing at all is sent and no tune tab is offered.
    let s = await setup('mhd', false);
    assert.deepStrictEqual(s.d.calls, []);
    assert.deepStrictEqual(s.tune.features(), { map: false, cooling: false, burbles: false });
    await s.tune.setMap(2);
    await s.tune.setCooling(true);
    assert.deepStrictEqual(s.d.calls, []);

    // MHD-style (no BM3 ROM): map + cooling offered, a press counts only on the DME's echo.
    s = await setup('mhd', true);
    assert.deepStrictEqual(s.tune.features(), { map: true, cooling: true, burbles: false });
    await s.tune.setMap(2);
    assert.strictEqual(s.d.calls.at(-1), '2f 01 01');               // map N = N - 1
    assert.strictEqual(s.tune.map, 2);
    assert.strictEqual(s.tune.mapConfirmed, false);                 // no read-back of the map
    await s.tune.setCooling(true);
    assert.strictEqual(s.d.calls.at(-1), '2f 03 01');
    assert.strictEqual(s.tune.cooling, 'ON');
    const sent = s.d.calls.length;
    await s.tune.applyBurbles(false);                               // burbles are BM3 only
    assert.strictEqual(s.d.calls.length, sent);
    assert.strictEqual(s.tune.noteType, 'warn');

    // BM3: map and burbles written to memory and confirmed by read-back; no cooling.
    s = await setup('bm3', true);
    assert.deepStrictEqual(s.tune.features(), { map: true, cooling: false, burbles: true });
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
    assert(!s.d.calls.some((c) => c.startsWith('2f 01')), 'a BM3 DME never gets the MHD-style command');

    // Untuned DME, Armed: the tabs are offered, the DME refuses, nothing is recorded as done.
    s = await setup('stock', true);
    await s.tune.setMap(1);
    assert.strictEqual(s.tune.note, 'Not available on this car');
    assert.strictEqual(s.tune.map, null);
    await s.tune.setCooling(true);
    assert.strictEqual(s.tune.cooling, null);

    console.log('Live Adjustments tune checks passed (disarmed / MHD-style echo / BM3 read-back / untuned).');
})().catch((e) => { console.error(e); process.exit(1); });
