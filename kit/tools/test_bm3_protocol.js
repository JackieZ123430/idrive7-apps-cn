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
    let markerEntries = 4;                              // four accumulated marker ranges
    let inflight = 0;
    const diag = { available: true, maxInflight: 0, physical: async (target, sid, data, timeout, accept) => {
        calls.push({ target, sid, data });
        diag.maxInflight = Math.max(diag.maxInflight, ++inflight);
        await new Promise(setImmediate);                // the DME answers later; others may ask meanwhile
        inflight--;
        let reply;
        if (sid === 0x2C) {
            if (data[0] === 3) {
                assert.deepStrictEqual(data, [3, 0xF3, 1]);
                markerEntries = 0;
            } else {
                assert.strictEqual(data[0], 2);
                markerEntries++;
            }
            reply = [0x6C, data[0], 0xF3, 0x01];
        } else if (sid === 0x22) {
            const payload = Buffer.alloc(255);
            payload.write('BM3_R#' + rom);
            reply = [0x62, 0xF3, 0x01].concat(Array.from(Buffer.concat(Array(markerEntries).fill(payload))));
        } else if (sid === 0x23) {
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

function binaryMarker(token) {
    // Captured binary block with synthetic padding.
    const binary = Buffer.from('1141F2144D88227FC9D6EBF6C0CEE74104BFF6652CF4A3F310CDC33BB4EF1387D7DA9' +
        '11E2F2C0A906D91D631DE69E83FB14CF2A22CEA7161831C7D085133B3CC', 'hex');
    assert.strictEqual(binary.length, 64);
    const payload = Buffer.alloc(255, 0xFF);
    Buffer.concat([Buffer.from('BM3_'), binary, Buffer.from('~|~' + '_'.repeat(30) + '#' + token + '\0')]).copy(payload);
    return [0x62, 0xF3, 1].concat(Array.from(payload));
}

function hashMarker(tag) {
    // the S58 layout (G87, issue #175): BM3_, a binary block (synthetic here), the only '#' at byte 101, the tag
    const payload = Buffer.alloc(255, 0);
    payload.write('BM3_');
    for (let i = 4; i < 101; i++) payload[i] = ((i * 37 + 11) & 0xFF) === 0x23 ? 0x24 : (i * 37 + 11) & 0xFF;
    payload.write('#' + tag + '\0', 101, 'latin1');
    return [0x62, 0xF3, 1].concat(Array.from(payload));
}

// The marker read on a G05 (B58, BM3 ROM R4C9F4P03, 2026-11-16) at 807FFE50: an 80-byte binary block, "~|~" at 84.
const G05_MARKER = Buffer.from(
    '424D335F1E68FB8ECFE9DEB5EF67A7C47F14D8D419555292F52C28D6B460EA1D7D51EECFB0D1AA79D3B3F09335967A41' +
    'FBE9A8910BC28318E9D80E7BACF061B84FE275C3965C08E6A065CB92C65DF2CA38BEB3757E7C7E5F5F5F5F5F5F5F5F5F' +
    '5F5F5F5F5F235234433946345030334B495359300000000000000000000000000000000000000000000000005F5F5F5F' +
    '5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5FFFFFFFFF' +
    'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF' +
    'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 'hex');

async function g05Checks() {
    assert.strictEqual(G05_MARKER.length, 255);
    assert.strictEqual(G05_MARKER.toString('latin1').indexOf('~|~'), 84);
    assert.strictEqual(G05_MARKER.toString('latin1').indexOf('#'), 101);
    assert.strictEqual(markerRom([0x62, 0xF3, 1].concat(Array.from(G05_MARKER)), bundled), 'R4C9F4P03');
    // through identify(): dynamic DID read, then the profile's map read-back
    const p = new Bm3Protocol({ available: true, physical: async (target, sid, data) => {
        if (sid === 0x2C) return [0x6C, data[0], 0xF3, 1];
        if (sid === 0x22) return [0x62, 0xF3, 1].concat(Array.from(G05_MARKER));
        if (sid === 0x23) return [0x63, 2];
        throw new Error('unexpected ' + sid);
    } }, bundled, { bm3MarkerAddress: '807FFE50' });
    assert.deepStrictEqual(await p.identify(), { rom: 'R4C9F4P03' });
    assert.strictEqual(p.profile.mapSwActAddr, '60038006');
    assert.strictEqual(await p.currentMap(), 2);
    // the 80-byte layout still needs its "_"s, "#", a known ROM + 5 build characters and the NUL
    const broken = (fn) => { const b = Buffer.from(G05_MARKER); fn(b); return [0x62, 0xF3, 1].concat(Array.from(b)); };
    assert.throws(() => markerRom(broken((b) => { b[85] = 0x21; }), bundled));             // no "~|~"
    assert.throws(() => markerRom(broken((b) => { b[101] = 0x5F; }), bundled));            // no "#"
    assert.throws(() => markerRom(broken((b) => { b.write('ZZZZ', 102, 'latin1'); }), bundled));   // unknown ROM
    assert.throws(() => markerRom(broken((b) => { b[116] = 0x41; }), bundled));            // no NUL after the token
}

async function markerDetectionChecks() {
    // the S58 marker (G87 M2 with F4C9L8R02, issue #175)
    assert.strictEqual(markerRom(hashMarker('F4C9L8R02GGGJM_G87_RWD_USA_KOR_ULEV246_'), bundled), 'F4C9L8R02');
    assert.throws(() => markerRom(hashMarker('ZZZZZZZZZGGGJM_G87_RWD_USA_'), bundled), /no profile/);
    assert.throws(() => markerRom(hashMarker('F4C9L8R02'), bundled));                       // no build characters
    { const two = hashMarker('F4C9L8R02GGGJM_G87_RWD_USA_'); two[3 + 50] = 0x23; assert.throws(() => markerRom(two, bundled)); }

    const captured = binaryMarker('R4C9H5V02OKLX0');
    assert.strictEqual(markerRom(captured, bundled), 'R4C9H5V02');
    const calls = [];
    let response = captured;
    let clearReply = [0x6C, 3, 0xF3, 1];
    const p = new Bm3Protocol({ available: true, physical: async (target, sid, data) => {
        assert.strictEqual(target, 0x12);
        calls.push([sid].concat(data));
        if (sid === 0x2C) return data[0] === 3 ? clearReply : [0x6C, 2, 0xF3, 1];
        if (sid === 0x23) return [0x63, 0];
        return response;
    } }, bundled, { bm3MarkerAddress: '807FFE50' });
    assert.deepStrictEqual(await p.identify(), { rom: 'R4C9H5V02' });
    assert.strictEqual(p.profile.mapSwActAddr, '60038006');
    assert.strictEqual(p.profile.wmbaCmd, '3e');
    assert.strictEqual(await p.currentMap(), 0);
    assert.deepStrictEqual(calls, [
        [0x2C, 3, 0xF3, 1],
        [0x2C, 2, 0xF3, 1, 0x24, 0x80, 0x7F, 0xFE, 0x50, 0, 255],
        [0x22, 0xF3, 1], [0x23, 0x14, 0x60, 3, 0x80, 6, 1]
    ]);
    // a DME that refuses the dynamic DID: the marker read straight from its address
    {
        const direct = [];
        const pd = new Bm3Protocol({ available: true, physical: async (target, sid, data) => {
            direct.push([sid].concat(data));
            if (sid === 0x2C) return [0x7F, 0x2C, 0x31];
            if (sid === 0x23 && data[5] === 255) return [0x63].concat(hashMarker('F4C9L8R02GGGJM_G87_RWD_USA_').slice(3));
            return null;
        } }, bundled, { bm3MarkerAddress: '807FFE50' });
        assert.deepStrictEqual(await pd.identify(), { rom: 'F4C9L8R02' });
        assert.deepStrictEqual(direct, [[0x2C, 3, 0xF3, 1], [0x23, 0x14, 0x80, 0x7F, 0xFE, 0x50, 255]], 'refused: one direct read');
        // no answer to the dynamic DID: an error, no direct read
        const silent = [];
        const ps = new Bm3Protocol({ available: true, physical: async (target, sid, data) => { silent.push(sid); return null; } }, bundled, { bm3MarkerAddress: '807FFE50' });
        await assert.rejects(() => ps.identify(), /did not answer/);
        assert.deepStrictEqual(silent, [0x2C]);
        // the direct read refused too, or a short marker: no profile
        const pr = new Bm3Protocol({ available: true, physical: async (target, sid) => (sid === 0x23 ? [0x63, 1, 2, 3] : [0x7F, sid, 0x31]) }, bundled, { bm3MarkerAddress: '807FFE50' });
        await assert.rejects(() => pr.identify(), /marker length/);
        assert.strictEqual(pr.profile, null);
    }
    const damagedPrefix = captured.slice(); damagedPrefix[3] = 0;
    const damagedDelimiter = captured.slice(); damagedDelimiter[3 + 68] = 0;
    const noTerminator = captured.slice(); noTerminator[noTerminator.indexOf(0, 3 + 71)] = 0x5F;
    for (const bad of [damagedPrefix, damagedDelimiter, noTerminator,
        binaryMarker('UNKNOWN123OKLX0'), binaryMarker('R4C9H5V02'),
        binaryMarker('R4C9H5V02OKLX0EXTRA'), captured.slice(0, -1),
        [0x62, 0xF3, 1].concat(captured.slice(3), captured.slice(3), captured.slice(3), captured.slice(3)),
        [0x62, 0xF3, 1].concat(Array(255).fill(0))]) {
        response = bad;
        await assert.rejects(() => p.identify());
        assert.strictEqual(p.profile, null);
        assert.strictEqual(p.rom, null);
        const before = calls.length;
        await assert.rejects(() => p.setMap(0), /not verified/);
        assert.strictEqual(calls.length, before, 'invalid marker allowed an actuator request');
    }
    response = captured;
    for (const rejected of [[0x7F, 0x2C, 0x31], null, [0x6C, 3, 0xF3, 2]]) {
        clearReply = rejected;
        const before = calls.length;
        await assert.rejects(() => p.identify());
        // a refusal (NRC) tries the direct read once (this stub's is too short); no answer or a wrong answer stops
        const refused = !!rejected && rejected[0] === 0x7F;
        assert.strictEqual(calls.length, before + (refused ? 2 : 1), 'clear failure must stop before defining/reading');
        assert.deepStrictEqual(calls[before], [0x2C, 3, 0xF3, 1]);
        if (refused) assert.deepStrictEqual(calls[before + 1], [0x23, 0x14, 0x80, 0x7F, 0xFE, 0x50, 255]);
        assert.strictEqual(p.profile, null);
    }
    clearReply = [0x6C, 3, 0xF3, 1];
    await p.identify(); // A rejected request must not stall later attempts.
    assert.strictEqual(p.rom, 'R4C9H5V02');
    assert(calls.every(call => [0x2C, 0x22, 0x23].includes(call[0])));
}

(async () => {
    for (const command of ['3d', '3e']) {
        const f = fixture(command), p = f.protocol;
        await assert.rejects(() => p.setMap(0), /not verified/);
        assert.strictEqual(f.calls.length, 0);
        await p.identify();
        assert.strictEqual(p.rom, 'TEST_ROM');
        assert.deepStrictEqual(f.calls[0].data, [3, 0xF3, 1]);
        assert.deepStrictEqual(f.calls[1].data.slice(0, 4), [2, 0xF3, 1, 0x24]);
        for (let retry = 0; retry < 3; retry++) await p.identify();
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
        // 0x63 replies carry no address: two reads in flight would take each other's answers
        f.diag.maxInflight = 0;
        const [slot, burbles] = await Promise.all([p.currentMap(), p.readBurbles(), p.setAsd(true), p.currentMap()]);
        assert.strictEqual(slot, 2);
        assert.strictEqual(burbles.enabled, false);
        assert.strictEqual(f.diag.maxInflight, 1, 'BM3 requests overlapped');
        f.diag.available = false;
        await assert.rejects(() => p.currentMap(), /unavailable/);
        f.diag.available = true;
        assert.strictEqual(await p.currentMap(), 2);             // a failed request does not stall the next
        f.profile.wmbaCmd = '27';
        await assert.rejects(() => p.setMap(1), /unsupported/);
    }
    const invalid = fixture('3d');
    invalid.protocol.profiles = {};
    await assert.rejects(() => invalid.protocol.identify(), /not uniquely matched/);
    assert.strictEqual(invalid.protocol.profile, null);
    assert.throws(() => addressBytes('not-an-address'), /invalid/);
    assert.throws(() => markerRom([0x62, 0xF3, 1, 0], {}), /marker length/);
    await markerDetectionChecks();
    await g05Checks();
    assert.strictEqual(Object.keys(bundled).length, 150);
    const relocated = ['F4C9G5705', 'F4C9G5905', 'F4C9G5F05', 'F4C9G5H05',
        'F4C9L8A05', 'F4C9L8C05', 'F4C9L8E05', 'F4C9L8G05', 'F4C9L8J05',
        'F4C9L8N05', 'F4C9L8R06', 'F4C9L8R07', 'F4C9L8Y04', 'F4C9L8Y05'];
    for (const rom of relocated) {
        const p = bundled[rom];
        assert.strictEqual(p.mapSwActAddr, '50038006', rom);
        assert.strictEqual(p.burbleActAddr, '50038099', rom);
        assert.deepStrictEqual(p.liveTuneTables.KF_DZWMIN_SPORT_SOT, { address: '50038100', factor: 2 }, rom);
        assert.strictEqual(p.wmbaCmd, '3e', rom);
    }
    assert.strictEqual(bundled.F4C9L8G06.mapSwActAddr, '60038006');
    assert.strictEqual(bundled.F4C9L8G06.burbleActAddr, '60038099');
    assert.deepStrictEqual(bundled.F4C9L8G06.liveTuneTables.KF_DZWMIN_SPORT_SOT, { address: '60038100', factor: 2 });
    assert.strictEqual(bundled.F4C9L8G06.wmbaCmd, '3e');
    for (const [rom, p] of Object.entries(bundled)) {
        assert.strictEqual(p.rom, rom);
        const legacy = Buffer.alloc(255);
        legacy.write('BM3_R#' + rom + '#');
        assert.strictEqual(markerRom([0x62, 0xF3, 1].concat(Array.from(legacy)), bundled), rom);
        assert.strictEqual(markerRom(binaryMarker(rom + 'OKLX0'), bundled), rom);
        addressBytes(p.mapSwActAddr); addressBytes(p.burbleActAddr);
        addressBytes(p.liveTuneTables.KF_DZWMIN_SPORT_SOT.address);
        assert(['3d', '3e'].includes(p.wmbaCmd));
        assert(Number.isFinite(p.liveTuneTables.KF_DZWMIN_SPORT_SOT.factor));
        assert(!('ethOverActAddr' in p) && !('baseAddr' in p));
    }
    console.log('BM3 synthetic protocol/readback checks passed; profile metadata validated.');
})().catch((e) => { console.error(e); process.exit(1); });
