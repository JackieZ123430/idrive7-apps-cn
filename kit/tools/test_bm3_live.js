'use strict';

const assert = require('assert');
const { Bm3Protocol, markerRom, addressBytes } = require('../../apps/live_adjustments/bm3_protocol');
const bundled = require('../../apps/live_adjustments/bm3_profiles');

function fixture(command) {
    const rom = 'TEST_ROM';
    const profile = { rom, mapSwActAddr: '60000000', burbleActAddr: '60000010', wmbaCmd: command,
        liveTuneTables: { KF_DZWMIN_SPORT_SOT: { address: '60000020', factor: 2 } } };
    const memory = { '60000000': [0, 1], '60000010': [0], '60000020': Array(24).fill(0) };
    const calls = [];
    const diag = { available: true, physical: async (target, sid, data, timeout, accept) => {
        calls.push({ target, sid, data });
        let reply;
        if (sid === 0x2C) reply = [0x6C, 0x02, 0xF3, 0x01];
        else if (sid === 0x22) reply = [0x62, 0xF3, 0x01].concat(Array.from(Buffer.from('BM3_R#' + rom)));
        else if (sid === 0x23) {
            const address = Buffer.from(data.slice(1, 5)).toString('hex').toUpperCase();
            reply = [0x63].concat(memory[address].slice(0, data[5]));
        } else if (sid === 0x3D || sid === 0x3E) {
            const address = Buffer.from(data.slice(1, 5)).toString('hex').toUpperCase();
            assert.strictEqual(data[5], data.length - 6);
            memory[address] = data.slice(6);
            reply = sid === 0x3E ? [0x7E, 0x3D] : [0x7D];
        } else if (sid === 0x2F) reply = [0x6F].concat(data.slice(0, 3));
        else if (sid === 0x2E) reply = [0x6E].concat(data.slice(0, 2));
        else throw new Error('Unexpected service ' + sid);
        assert(accept(reply));
        return reply;
    } };
    return { protocol: new Bm3Protocol(diag, { [rom]: profile }, { bm3MarkerAddress: '60000100' }), calls, memory, profile, diag };
}

(async () => {
    for (const command of ['3d', '3e']) {
        const f = fixture(command), p = f.protocol;
        await assert.rejects(() => p.setMap(0), /not verified/);
        assert.strictEqual(f.calls.length, 0);
        await p.identify();
        assert.strictEqual(p.rom, 'TEST_ROM');
        assert.deepStrictEqual(f.calls[0].data.slice(0, 4), [2, 0xF3, 1, 0x24]);
        assert.strictEqual(await p.setMap(3), 3);
        assert.deepStrictEqual(f.memory['60000000'], [3, 1]);
        const before = f.calls.length;
        for (const invalid of [-1, 4, 0.5]) await assert.rejects(() => p.setMap(invalid), /invalid map/);
        assert.strictEqual(f.calls.length, before);
        assert.strictEqual(await p.setBurbles(2.5), 2.5);
        assert.deepStrictEqual(f.memory['60000020'], Array(24).fill(0xFB));
        assert.strictEqual((await p.readBurbles()).aggression, 2.5);
        await p.setBurbles(null);
        assert.deepStrictEqual(f.memory['60000010'], [0]);
        assert.deepStrictEqual(f.memory['60000020'], Array(24).fill(0));
        for (const invalid of [-0.5, 12.5, 1.1, NaN]) await assert.rejects(() => p.setBurbles(invalid), /aggression/);
        for (const mode of ['open', 'close', 'auto']) assert.strictEqual(await p.setFlap(mode), mode);
        assert.strictEqual(await p.setAsd(false), false);
        assert.strictEqual(await p.setAsd(true), true);
        assert(f.calls.every((r) => r.target === 0x12));
        const currentMap = p.currentMap.bind(p);
        p.currentMap = async () => 0;
        await assert.rejects(() => p.setMap(2), /readback differs/);
        p.currentMap = currentMap;
        f.profile.wmbaCmd = '27';
        await assert.rejects(() => p.setMap(1), /unsupported/);
    }
    const invalid = fixture('3d');
    invalid.protocol.profiles = {};
    await assert.rejects(() => invalid.protocol.identify(), /not uniquely matched/);
    assert.strictEqual(invalid.protocol.profile, null);
    assert.throws(() => addressBytes('not-an-address'), /invalid/);
    assert.throws(() => markerRom([0x62, 0xF3, 1, 0], {}), /marker absent/);
    for (const [rom, p] of Object.entries(bundled)) {
        assert.strictEqual(p.rom, rom);
        addressBytes(p.mapSwActAddr); addressBytes(p.burbleActAddr);
        addressBytes(p.liveTuneTables.KF_DZWMIN_SPORT_SOT.address);
        assert(['3d', '3e'].includes(p.wmbaCmd));
        assert(Number.isFinite(p.liveTuneTables.KF_DZWMIN_SPORT_SOT.factor));
        assert(!('ethOverActAddr' in p) && !('baseAddr' in p));
    }
    console.log('BM3 synthetic protocol/readback checks passed; profile metadata validated.');
})().catch((e) => { console.error(e); process.exit(1); });
