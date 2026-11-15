'use strict';
// Live Data: the read-only link really only reads, replies decode as the catalog says, the catalog
// tool keeps only what can be read, the built-in engine values are all there, and a new install's
// defaults (screens, currency, fuel price). Runs without the local catalog (catalog/, not in git).
//   node kit/tools/test_live_data.js
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const kit = path.join(ROOT, 'kit', 'runtime');
const { ReadOnlyDiag, check, READ, MAX_DIDS } = require(path.join(kit, 'readonly-diag'));
const { decode, field, format, split, masked } = require(path.join(kit, 'sgbd'));
const STD = require(path.join(ROOT, 'apps', 'live_data', 'std'));

const quiet = { info() {}, warn() {}, error() {} };

/** a head unit diagnostic transport that records what is sent and answers like a unit would */
function fakeTransport(answer) {
    const sent = [];
    let onResponse = null;
    const signals = {
        proxy: async () => ({}),
        on: async (p, ev, fn) => { onResponse = fn; },
        onAvailable: async (p, fn) => fn(true),
        call: async (p, method, a) => {
            const req = { at: Date.now(), target: a.targetAddress, sid: a.serviceID, data: Array.from(a.udsData) };
            sent.push(req);
            const replies = answer(req) || [];
            replies.forEach(([addr, uds], i) => setTimeout(() => onResponse({ errorCode: 'NO_ERROR', udsResponse: [0, 0, 0, 0, 0, 0, addr, 0, 0].concat(uds) }), 2 + i));
            return 'NO_ERROR';
        },
    };
    return { signals, sent };
}

async function main() {
    /* ---------- check(): only reading gets through ---------- */
    assert.deepStrictEqual(Object.keys(READ).map(Number).sort((a, b) => a - b), [0x01, 0x09, 0x22]);
    for (let sid = 0; sid < 256; sid++) {
        const data = sid === 0x22 ? [0xF1, 0x90] : [0x0C];
        if (READ[sid]) assert.doesNotThrow(() => check(0x12, sid, data, false), 'service ' + sid);
        else assert.throws(() => check(0x12, sid, data, false), /not allowed/, 'service ' + sid.toString(16) + ' must be refused');
    }
    assert.throws(() => check(0xDF, 0x22, [0xF1, 0x90], false), /functional/, 'a physical request to all units');
    assert.throws(() => check(0xDF, 0x22, [0xF1, 0x90], true), /22 F1 50/, 'any functional request but 22 F1 50');
    assert.throws(() => check(0xDF, 0x01, [0x00], true), /22 F1 50/);
    assert.doesNotThrow(() => check(0xDF, 0x22, [0xF1, 0x50], true));
    assert.throws(() => check(0x12, 0x22, [0xF1], false), /1 to 8 identifiers/);
    assert.throws(() => check(0x12, 0x22, [], false), /1 to 8 identifiers/);
    assert.throws(() => check(0x12, 0x22, [0xF1, 0x90, 0xF1], false), /1 to 8 identifiers/);
    assert.strictEqual(MAX_DIDS, 8);
    assert.doesNotThrow(() => check(0x12, 0x22, [0xF1, 0x90, 0xF1, 0x50], false), 'two identifiers in one read');
    assert.doesNotThrow(() => check(0x12, 0x22, new Array(16).fill(0x40), false), 'eight identifiers in one read');
    assert.throws(() => check(0x12, 0x22, new Array(18).fill(0x40), false), /1 to 8 identifiers/);
    assert.throws(() => check(0x12, 0x01, [0x0C, 0x0D], false), /exactly one PID/);
    assert.throws(() => check(0x12, 0x22, [0x1F0, 0x00], false), /bad request bytes/);
    assert.throws(() => check(0x12, 0x22, 'F190', false), /bad request bytes/);
    assert.throws(() => check(0x100, 0x22, [0xF1, 0x90], false), /bad address/);

    /* ---------- the link: what reaches the transport ---------- */
    const t = fakeTransport((r) => {
        if (r.target === 0xDF) return [[0x12, [0x62, 0xF1, 0x50, 0x0F, 0x26, 0xE8]], [0x40, [0x7F, 0x22, 0x31]]];
        if (r.target === 0x12 && r.sid === 0x22) {
            const out = [0x62];
            for (let i = 0; i < r.data.length; i += 2) out.push(r.data[i], r.data[i + 1], 0x01);     // every identifier: one byte
            return [[0x12, out]];
        }
        if (r.target === 0x12 && r.sid === 0x01) return [[0x12, [0x41].concat(r.data, [0x20])]];
        return null;                                // 0x55: never answers
    });
    const link = await new ReadOnlyDiag(t.signals, quiet, { gapMs: 40, silentAfter: 3 }).init();
    assert.ok(link.ready && link.available);
    assert.strictEqual(link.diag, undefined, 'the full link is not reachable from outside');
    assert.deepStrictEqual(await link.read(0x12, 0x4A36), [0x62, 0x4A, 0x36, 0x01]);
    assert.deepStrictEqual(await link.readMany(0x12, [0x4402, 0x586F]), [0x62, 0x44, 0x02, 0x01, 0x58, 0x6F, 0x01]);
    assert.deepStrictEqual(t.sent[t.sent.length - 1].data, [0x44, 0x02, 0x58, 0x6F], 'both identifiers in one request');
    await assert.rejects(link.readMany(0x12, [1, 2, 3, 4, 5, 6, 7, 8, 9]), /1 to 8 identifiers/);
    assert.deepStrictEqual(await link.physical(0x12, 0x01, [0x0C], 500, (u) => u[0] === 0x41), [0x41, 0x0C, 0x20]);
    const units = await link.discover();
    assert.deepStrictEqual(Array.from(units.entries()), [[0x12, '0F26E8'], [0x40, '']]);
    // every service but reading is refused before it is sent
    const before = t.sent.length;
    for (const sid of [0x10, 0x11, 0x14, 0x19, 0x27, 0x28, 0x2C, 0x2E, 0x2F, 0x31, 0x34, 0x36, 0x37, 0x3D, 0x3E, 0x85]) {
        await assert.rejects(link.physical(0x12, sid, [0x01, 0x02], 100), /not allowed/);
    }
    await assert.rejects(link.physical(0xDF, 0x22, [0xF1, 0x90], 100), /functional/);
    assert.strictEqual(t.sent.length, before, 'nothing refused reached the transport');
    assert.strictEqual(link.stats.blocked, 18);
    // the bytes checked are the bytes sent, even if the caller changes its array afterwards
    const req = [0x4A, 0x36];
    const p = link.physical(0x12, 0x22, req, 500);
    req[0] = 0x2E;
    await p;
    assert.deepStrictEqual(t.sent[t.sent.length - 1].data, [0x4A, 0x36]);
    // pacing: one at a time, at least gapMs apart
    const n0 = t.sent.length;
    await Promise.all([link.read(0x12, 0x1000), link.read(0x12, 0x1001), link.read(0x12, 0x1002)]);
    const gaps = t.sent.slice(n0).map((r, i, a) => (i ? r.at - a[i - 1].at : null)).slice(1);
    gaps.forEach((g) => assert.ok(g >= 38, 'requests ' + g + ' ms apart'));
    assert.ok(t.sent.every((r) => READ[r.sid]), 'only reading services were sent');
    // a unit that doesn't answer: skipped after silentAfter misses, until wake()
    for (let i = 0; i < 3; i++) assert.strictEqual(await link.read(0x55, 0xF190, 30), null);
    assert.ok(link.silent(0x55));
    const n1 = t.sent.length;
    assert.strictEqual(await link.read(0x55, 0xF190, 30), null);
    assert.strictEqual(t.sent.length, n1, 'a silent unit is not asked');
    link.wake(0x55);
    assert.ok(!link.silent(0x55));
    // cancel(): what is still waiting is dropped (undefined), not counted as no answer
    const q = [link.read(0x12, 0x2000), link.read(0x12, 0x2001), link.read(0x12, 0x2002)];
    link.cancel();
    const got = await Promise.all(q);
    assert.ok(got.filter((g) => g === undefined).length >= 2, 'cancelled requests resolve undefined');

    // a busy transport: tried again within a fraction of a second, counted, not logged one by one
    let refuse = 2;
    const tb = fakeTransport((r) => [[0x12, [0x62].concat(r.data, [0x05])]]);
    const call = tb.signals.call;
    tb.signals.call = async (p, m, a) => (refuse-- > 0 ? 'APP_REQUEST_TEMPORARILY_NOT_ACCEPTED' : call(p, m, a));
    const lines = [];
    const busyLink = await new ReadOnlyDiag(tb.signals, { info: (s) => lines.push(s), warn() {}, error() {} }).init();
    const t0 = Date.now();
    assert.deepStrictEqual(await busyLink.read(0x12, 0x4402), [0x62, 0x44, 0x02, 0x05]);
    assert.ok(Date.now() - t0 < 900, 'busy retries within a second (took ' + (Date.now() - t0) + ' ms)');
    assert.strictEqual(busyLink.busy, 2);
    assert.ok(!lines.some((l) => /transport busy/.test(l)), 'busy verdicts counted, not logged');

    /* ---------- decoding ---------- */
    assert.strictEqual(field([0x00, 0xA0], { t: 'u16', at: 0, k: 0.75, o: -48 }).value, 72);
    assert.strictEqual(field([0xFF, 0xFE], { t: 's16', at: 0 }).value, -2);
    assert.strictEqual(field([0x80], { t: 's8', at: 0 }).value, -128);
    assert.strictEqual(field([0x12, 0x34, 0x56, 0x78], { t: 'u32', at: 0 }).value, 0x12345678);
    assert.strictEqual(field([0xFF, 0xFF, 0xFF, 0xFF], { t: 's32', at: 0 }).value, -1);
    assert.strictEqual(field([0xA5], { t: 'u8', at: 0, m: 0xF0 }).value, 0x0A);
    assert.strictEqual(field([0xA5], { t: 'u8', at: 0, m: 0x80 }).value, 1);
    assert.strictEqual(field([0x5A], { t: 'u8', at: 0, m: 0x30 }).value, 1);
    assert.strictEqual(masked(0x80000005, 0x80000000), 1);
    assert.strictEqual(masked(0xFFFFFFFF, 0x0000FF00), 0xFF);
    assert.strictEqual(field([0x34, 0x12], { t: 'u16', at: 0, le: 1 }).value, 0x1234);
    assert.strictEqual(field([0x3F, 0x80, 0, 0], { t: 'f32', at: 0 }).value, 1);
    assert.strictEqual(field([1, 2], { t: 'u16', at: 1 }).why, 'reply too short');
    assert.strictEqual(field([0x41, 0x42, 0x00, 0xFF], { t: 'txt', at: 0, len: 4 }).value, 'AB');
    assert.strictEqual(field([0x01, 0x42], { t: 'txt', at: 0, len: 4 }).value, '01 42');
    assert.strictEqual(field([0x0F, 0x26, 0xE8], { t: 'hex', at: 0, len: 3 }).value, '0F 26 E8');
    const e = { f: [{ n: 'A', t: 'u8', at: 0, e: 'onoff' }, { n: 'B', t: 's16', at: 1, k: 0.1, u: 'bar' }] };
    const v = decode(e, [0x62, 0x12, 0x34, 0x01, 0x00, 0x19], { onoff: { 0: 'OFF', 1: 'ON' } });
    assert.strictEqual(format(v[0], e.f[0]), 'ON');
    assert.strictEqual(format(v[1], e.f[1]), '2.50 bar');
    assert.strictEqual(decode(e, [0x7F, 0x22, 0x31]), null, 'a refusal is no values');
    // several identifiers in one reply, taken apart by the lengths single replies showed
    assert.deepStrictEqual(split([0x62, 0x44, 0x02, 0x00, 0xA0, 0x58, 0x6F, 0x08], { 0x4402: 2, 0x586F: 1 }),
        { 0x4402: [0x62, 0x44, 0x02, 0x00, 0xA0], 0x586F: [0x62, 0x58, 0x6F, 0x08] });
    assert.deepStrictEqual(split([0x62, 0x58, 0x6F, 0x08], { 0x4402: 2, 0x586F: 1 }), { 0x586F: [0x62, 0x58, 0x6F, 0x08] }, 'one left out');
    assert.strictEqual(split([0x62, 0x44, 0x02, 0x00, 0xA0, 0x58, 0x6F], { 0x4402: 2, 0x586F: 1 }), null, 'too short');
    assert.strictEqual(split([0x62, 0x44, 0x02, 0x00, 0x58, 0x6F, 0x08], { 0x4402: 2, 0x586F: 1 }), null, 'a length that does not match');
    assert.strictEqual(split([0x62, 0x12, 0x34, 0x00], { 0x4402: 2 }), null, 'an identifier not asked for');
    assert.strictEqual(split([0x7F, 0x22, 0x13], { 0x4402: 2 }), null, 'refused');
    assert.strictEqual(format(field([0xCB, 0x50], { t: 's16', at: 0, x: 1 }), { t: 's16', x: 1 }), '0xCB50');
    assert.strictEqual(format(field([0x0A], { t: 'u8', at: 0, x: 1 }), { t: 'u8', x: 1 }), '0x0A');
    assert.strictEqual(format(decode(STD.OBD['OBD 0C'], [0x41, 0x0C, 0x0B, 0xB8])[0], STD.OBD['OBD 0C'].f[0]), '750 rpm');
    assert.strictEqual(decode(STD.INFO['OBD 09 02'], [0x49, 0x02, 0x01].concat('WBA5U000000000000'.split('').map((c) => c.charCodeAt(0))))[0].value, 'WBA5U000000000000');

    /* ---------- standard catalog: shapes, read-only services ---------- */
    [STD.IDENT, STD.OBD, STD.INFO].forEach((tab) => Object.keys(tab).forEach((k) => {
        const x = tab[k];
        assert.ok(READ[x.sid], k + ': service');
        assert.ok(x.d && x.f.length, k + ': name, fields');
        x.f.forEach((f) => assert.ok(f.t && f.at >= 0, k + ': field'));
    }));

    /* ---------- Useful list: every candidate is in the built-in catalog, units convert ---------- */
    const USEFUL = require(path.join(ROOT, 'apps', 'live_data', 'useful'));
    const BUILTIN = path.join(ROOT, 'apps', 'live_data', 'builtin');
    const dme = JSON.parse(fs.readFileSync(path.join(BUILTIN, 'DME8FF_R.json'), 'utf8'));
    const dmeMeta = JSON.parse(fs.readFileSync(path.join(BUILTIN, 'DME8FF_R.meta.json'), 'utf8'));
    assert.ok(dmeMeta.builtin && dmeMeta.order.length === Object.keys(dme).length && dmeMeta.order.every((d) => dme[d]), 'built-in catalog: its order lists every identifier');
    const sgbdIndex = JSON.parse(fs.readFileSync(path.join(BUILTIN, 'sgbd_index.json'), 'utf8'));
    assert.ok(Object.keys(sgbdIndex).some((k) => /^12 /.test(k) && sgbdIndex[k] === 'DME8FF_R'), 'built-in SGBD index names the B58 engine unit');
    const catFile = path.join(ROOT, 'apps', 'live_data', 'catalog', 'DME8FF_R.json');
    const full = fs.existsSync(catFile) ? JSON.parse(fs.readFileSync(catFile, 'utf8')) : null;
    if (full) Object.keys(dme).forEach((d) => assert.deepStrictEqual(dme[d], full[d], 'built-in ' + d + ' as the full catalog has it (sgbd_catalog.py --builtin)'));
    const names = new Set();
    USEFUL[0x12].forEach((g) => g.items.forEach((it) => {
        assert.ok(!names.has(it.name), 'Useful: ' + it.name + ' listed twice');
        names.add(it.name);
        const cands = it.minus || it.c;
        assert.ok(cands && cands.length, it.name + ': candidates');
        cands.forEach((c) => {
            const [key, fi] = c.split('/');
            const std = STD.IDENT[key] || STD.OBD[key] || STD.INFO[key];
            const e = std || dme[key];
            assert.ok(e, it.name + ': ' + c + ' is not in the built-in catalog');
            const f = e.f[Number(fi || 0)];
            assert.ok(f, it.name + ': ' + c + ' has no such value');
            if (it.u && f.u && f.u !== it.u) assert.ok(USEFUL.CONVERT[f.u] && USEFUL.CONVERT[f.u][it.u], it.name + ': no conversion ' + f.u + ' -> ' + it.u);
        });
    }));

    // fuel quality (KQE 4035, issue #166): 3 counts, then 5 refuellings of mileage (x 8 km) and quality range
    {
        const reply = [0x62, 0x40, 0x35, 0x00, 0x02, 0x00, 0x05, 0x00, 0x1B, 0x07, 0xD0, 0x03, 0x07, 0x9E, 0x02];
        while (reply.length < 3 + 21) reply.push(0);
        const v = decode(dme['4035'], reply);
        assert.deepStrictEqual([v[0].value, v[1].value, v[2].value], [2, 5, 27], 'fuel quality: refuellings by range');
        assert.deepStrictEqual([v[3].value, v[4].value, v[5].value, v[6].value], [16000, 3, 15600, 2], 'fuel quality: the last refuellings, km x 8 and range');
        const items = USEFUL[0x12].find((g) => g.group === 'Fuel quality').items;
        assert.strictEqual(items.length, 15, 'fuel quality: adapted, time, 3 counts, 5 x (mileage, range)');
        assert.strictEqual(items.find((it) => it.name === 'Refuelling 1, fuel quality').map[v[4].raw], 'High');
    }

    /* ---------- Energy: mapped units, field offsets, scaling and converter directions ---------- */
    const energyCatalogs = {};
    for (const sgbd of ['BATT48', 'PCU48']) {
        const cat = JSON.parse(fs.readFileSync(path.join(BUILTIN, sgbd + '.json'), 'utf8'));
        const meta = JSON.parse(fs.readFileSync(path.join(BUILTIN, sgbd + '.meta.json'), 'utf8'));
        energyCatalogs[sgbd] = cat;
        assert.ok(meta.builtin && meta.sgbd === sgbd);
        assert.deepStrictEqual(meta.order.slice().sort(), Object.keys(cat).sort());
        assert.ok(Object.values(sgbdIndex).includes(sgbd), sgbd + ': discoverable');
        const names = new Set();
        USEFUL.bySgbd[sgbd].forEach((g) => g.items.forEach((it) => {
            assert.ok(!names.has(it.name), sgbd + ': duplicate ' + it.name);
            names.add(it.name);
            it.c.forEach((c) => {
                const [did, fi] = c.split('/'), e = cat[did];
                assert.ok(e && (e.sid === undefined || e.sid === 0x22), c + ': read-only identifier');
                const f = e.f[Number(fi || 0)];
                assert.ok(f, c + ': field exists');
                if (it.u && f.u && f.u !== it.u) assert.ok(USEFUL.CONVERT[f.u] && USEFUL.CONVERT[f.u][it.u]);
            });
        }));
    }
    assert.strictEqual(USEFUL.bySgbd.PCU48_2, undefined, 'do not reuse PCU48 offsets for PCU48_2');
    assert.strictEqual(fs.existsSync(path.join(BUILTIN, 'PCU48_2.json')), false);
    const battData = Buffer.alloc(28);
    battData.writeUInt16BE(4850, 0);
    battData.writeInt16BE(-125, 2);
    battData.writeInt16BE(50, 4);
    battData[14] = 76; battData[15] = 95;
    battData.writeUInt16BE(4860, 16);
    battData[18] = 100; battData[23] = 90; battData[26] = 92;
    const batt = decode(energyCatalogs.BATT48.AA56, [0x62, 0xAA, 0x56].concat(Array.from(battData)));
    assert.deepStrictEqual([batt[0].value, batt[1].value, batt[2].value], [48.5, -12.5, 25]);
    assert.deepStrictEqual([batt[7].value, batt[8].value, batt[9].value, batt[10].value, batt[15].value, batt[18].value],
        [76, 95, 48.6, 10, 9, 92]);
    assert.strictEqual(decode(energyCatalogs.BATT48['50AC'], [0x62, 0x50, 0xAC, 88])[0].value, 88);
    const pcuData = Buffer.alloc(13);
    pcuData.writeUInt16BE(14200, 0); pcuData.writeUInt16BE(48500, 2);
    pcuData.writeInt16BE(-123, 4); pcuData.writeInt16BE(45, 6);
    pcuData.writeInt16BE(-175, 8); pcuData.writeInt16BE(218, 10);
    const flowItem = USEFUL.bySgbd.PCU48[0].items.find((it) => it.c.includes('DA90/6'));
    for (const [mode, text] of [[9, '48 V -> 12 V (buck)'], [10, '12 V -> 48 V (boost)'],
        [3, 'Passive standby'], [5, 'Error'], [255, 'Invalid']]) {
        pcuData[12] = mode;
        const pcu = decode(energyCatalogs.PCU48.DA90, [0x62, 0xDA, 0x90].concat(Array.from(pcuData)));
        assert.deepStrictEqual(pcu.map((v) => v.value), [14200, 48500, -12.3, 4.5, -175, 218, mode]);
        assert.strictEqual(flowItem.map[pcu[6].raw], text);
        assert.strictEqual((pcu[0].value * USEFUL.CONVERT.mV.V).toFixed(2), '14.20');
    }
    assert.strictEqual(flowItem.map[99], undefined, 'unknown modes are not assigned a direction');
    assert.strictEqual(decode(energyCatalogs.PCU48.DA90, [0x62, 0xDA, 0x90, 0])[6].why, 'reply too short');

    /* ---------- the catalog tool keeps only readable rows ---------- */
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-data-'));
    try {
        const row = (arg, id, svc, extra) => Object.assign({ ARG: arg, ID: id, RESULTNAME: 'STAT_' + arg, INFO: 'Text ' + arg, EINHEIT: 'bar', LABEL: '-', 'L/H': '-',
            DATENTYP: 'unsigned int', NAME: '-', MUL: '0.1', DIV: '1.0', ADD: '0.0', SG_ADR: '-', SERVICE: svc, ARG_TABELLE: '-', RES_TABELLE: '-' }, extra || {});
        const rows = [row('READ', '0x1000', '22'), row('READ_DYN', '0x1001', '22;2C'), row('WRITE_READ', '0x1002', '2E;22'),
            row('ROUTINE', '0x1003', '31'), row('IO', '0x1004', '2F'), row('WRITE', '0x1005', '2E'),
            row('WITH_ARG', '0x1006', '22', { ARG_TABELLE: 'ARG_0x1006_D' }), row('MULTI', '0x1007', '22', { DATENTYP: '-', RES_TABELLE: 'RES_0x1007_D' })];
        const cols = Object.keys(rows[0]);
        const tableHtml = (name, cs, rs) => '<h3>' + name + '</h3><table><thead><tr>' + cs.map((c) => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>'
            + rs.map((r) => '<tr>' + cs.map((c) => '<td>' + r[c] + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
        const resCols = ['RESULTNAME', 'EINHEIT', 'L/H', 'DATENTYP', 'MASKE', 'NAME', 'MUL', 'DIV', 'ADD', 'INFO'];
        const res = [{ RESULTNAME: 'STAT_A', EINHEIT: '-', 'L/H': '-', DATENTYP: 'unsigned char', MASKE: '-', NAME: '-', MUL: '-', DIV: '-', ADD: '-', INFO: 'a' },
            { RESULTNAME: 'STAT_B', EINHEIT: 'V', 'L/H': '-', DATENTYP: 'signed int', MASKE: '-', NAME: '-', MUL: '0.01', DIV: '1.0', ADD: '0.0', INFO: 'b' }];
        const page = '<h2>INFO</h2><table><thead><tr><th>Field</th><th>Value</th></tr></thead><tbody><tr><td>ECU</td><td>Test unit</td></tr></tbody></table>'
            + tableHtml('SG_FUNKTIONEN', cols, rows) + tableHtml('RES_0x1007_D', resCols, res) + '<h3>END</h3>';
        fs.writeFileSync(path.join(tmp, 'test_sgbd.html'), page);
        execFileSync('python3', [path.join(ROOT, 'kit', 'tools', 'sgbd_catalog.py'), path.join(tmp, 'test_sgbd.html'), tmp], { stdio: 'pipe' });
        const cat = JSON.parse(fs.readFileSync(path.join(tmp, 'TEST_SGBD.json'), 'utf8'));
        assert.deepStrictEqual(Object.keys(cat).sort(), ['1000', '1001', '1002', '1007'], 'only service 22 rows without an argument');
        assert.deepStrictEqual(cat['1000'].f, [{ n: 'STAT_READ', t: 'u16', at: 0, k: 0.1, u: 'bar' }]);
        assert.deepStrictEqual(cat['1007'].f.map((f) => [f.n, f.t, f.at, f.k]), [['STAT_A', 'u8', 0, undefined], ['STAT_B', 's16', 1, 0.01]]);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    /* ---------- car signals: what they need, how they read, the fuel signal's scaling ---------- */
    const SIG = require(path.join(ROOT, 'apps', 'live_data', 'signals'));
    const ids = new Set();
    SIG.GROUPS.forEach((g) => g.items.forEach((it) => {
        assert.ok(!ids.has(it.id), 'signal ' + it.id + ' listed twice'); ids.add(it.id);
        assert.ok(it.name && (it.i || it.calc || it.flow || it.tc), it.id + ': name and source');
        SIG.sourcesOf(it).forEach((s) => assert.ok(s.f && (s.m || s.fn), it.id + ': field and member'));
    }));
    const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'live_data', 'app.json'), 'utf8'));
    const need = SIG.fields();
    Object.keys(need).forEach((i) => need[i].forEach((f) => assert.ok(spec.signals[i] && spec.signals[i][f], 'app.json lists ' + i + '.' + f)));
    Object.keys(spec.signals).forEach((i) => Object.keys(spec.signals[i]).forEach((f) => {
        if (f.charAt(0) !== '_') assert.ok(/^r?s?$/.test(spec.signals[i][f]), i + '.' + f + ': only reading (r) and notifications (s)');
    }));
    const refFile = path.join(ROOT, 'reference', 'someip-interfaces.json');
    if (fs.existsSync(refFile)) {
        // against the head unit's own catalog: the fields, their flags, every member a value reads
        const db = JSON.parse(fs.readFileSync(refFile, 'utf8'));
        const members = (ref) => { let d = db.datatypes[ref], out = []; while (d) { out = (d.members || []).concat(out); d = d.extends ? db.datatypes[d.extends] : null; } return out.map((m) => m.name); };
        Object.keys(need).forEach((i) => need[i].forEach((f) => {
            const fd = db.interfaces[i] && db.interfaces[i].fields[f];
            assert.ok(fd, i + '.' + f + ' is in the catalog');
            assert.strictEqual(spec.signals[i][f], ((fd.getter && fd.getter.id) ? 'r' : '') + (fd.notifier ? 's' : ''), i + '.' + f + ': flags as the catalog has them');
        }));
        Object.keys(SIG.ITEMS).forEach((id) => SIG.sourcesOf(SIG.ITEMS[id]).forEach((s) => {
            if (s.m) assert.ok(members(db.interfaces[s.i].fields[s.f].dataRef).indexOf(s.m) >= 0, id + ': ' + s.f + ' has no member ' + s.m);
        }));
    } else console.log('(no reference/someip-interfaces.json: signals not checked against the catalog)');
    const val = (id, struct, alt) => { const it = SIG.ITEMS[id]; return SIG.value(it, SIG.sourcesOf(it)[alt || 0], struct); };
    assert.strictEqual(val('rpm', { actualValueRPMEngineCrankshaft: 3200 }).n, 800);
    assert.ok(val('rpm', { actualValueRPMEngineCrankshaft: 65535 }).bad, 'rpm 65535 = no data');
    assert.strictEqual(val('torque', { actualValueTorqueCrankshaft: 2247 }).n, 100);
    assert.ok(val('torque', { actualValueTorqueCrankshaft: 4095 }).bad, 'torque 4095 = no data');
    assert.strictEqual(val('coolant', { temperatureEngineDrive: 138 }).n, 90);
    assert.strictEqual(val('outside', { temperatureExterior: 103 }).n, 11.5);
    assert.ok(val('tank', { fluidLevelFuelTank: 255 }).bad, 'tank 255 = no data');
    assert.strictEqual(val('tank', { fluidLevelFuelTank: '41' }).n, 41, 'numbers as strings');
    assert.ok(Math.abs(val('gLong', { longitudinalAccelerationCentreOfGravity: 32500 + 4903 }).n - 1) < 0.001, '1 g forward');
    assert.ok(Math.abs(val('steer', { actualValueSteeringAngleDriver: 65536 - 1000 }).n + 43.95) < 0.001, 'steering: signed');
    assert.strictEqual(val('running', { statusEngineRunDrive: 'MOTOR_LAEUFT' }).text, 'running');
    assert.strictEqual(val('running', { statusEngineRunDrive: 2 }).text, 'running', 'enums as numbers');
    assert.ok(val('handbrake', { statusContactHandBrake: 'SIGNAL_UNGUELTIG' }).bad, 'invalid enum = no data');
    assert.strictEqual(val('mode', { actualValueModeDrivingExperience: 'COMFORT_PLUS' }).text, 'Comfort plus', 'other enum names in words');
    assert.ok(val('mode', { actualValueModeDrivingExperience: 'SIGNAL_UNBEFUELLT' }).bad);
    assert.strictEqual(val('gear', { statusGearSelectionDrive: '_3' }).text, 'D3');
    assert.strictEqual(val('gear', { statusGearSelectionDrive: 7 }).text, 'D3');
    assert.strictEqual(val('gear', { statusGearSelectionDrive: 'P' }).text, 'P');
    assert.strictEqual(val('gear', { statusActualStageDrive: 'D', statusActualGearDrive: 'G4' }, 1).text, 'D4', 'gear from the gearbox status');
    assert.strictEqual(val('avgCons1', { consumptionAverage1BC1: 98, statusUnitOfMeasurementConsumptionBC: 'VERBRAUCH_IN_L_S_100KM' }).u, 'l/100km');
    assert.strictEqual(val('tripTime', { rideDurationHours: 1, rideDurationMinutes: 5 }).text, '1:05 h');
    assert.ok(val('abs', { qualifierFunctionABS: 0x1234 }).raw, 'unknown scaling: raw');
    assert.ok(val('rpm', undefined).bad && val('rpm', {}).bad, 'nothing = no data');
    // fuel: a 16 bit counter, 500 counts every 100 ms (5000 a second), wrapping
    const fl = new SIG.Flow(null);
    let cnt = 65000, tt = 1000;
    for (let n = 0; n < 40; n++) { fl.feed(cnt, tt); cnt = (cnt + 500) % 65536; tt += 100; }
    assert.ok(Math.abs(fl.rateAt(tt) - 5000) < 1, 'counter rate across the wrap: ' + fl.rateAt(tt));
    assert.strictEqual(fl.lph(tt), null, 'no l/h before the scaling is learned');
    let learned = false;
    for (let n = 0; n < 12; n++) { fl.feed(cnt, tt); cnt = (cnt + 500) % 65536; learned = fl.learn(18 * (1 + (n % 3 - 1) * 0.02), tt) || learned; tt += 100; }
    assert.ok(learned && Math.abs(fl.k - 0.0036) < 0.0001, 'k learned from the engine unit: ' + fl.k);
    assert.ok(Math.abs(fl.lph(tt) - 18) < 0.5, 'l/h from the counter');
    assert.strictEqual(fl.rateAt(tt + 4000), 0, 'nothing for 3 s: 0 (engine off)');
    const fl2 = new SIG.Flow(null);
    for (let n = 0; n < 30; n++) { fl2.feed(n * 300, n * 100); fl2.learn(n % 2 ? 4 : 30, n * 100); }
    assert.strictEqual(fl2.k, null, 'ratios that disagree teach nothing');
    // the demo sends only what the app subscribes to, with the members it reads
    const st = {};
    SIG.demo({ rpm: 3000, speed: 80, gear: 4, gLong: 0.2, gLat: 0.1, coolant: 90, oil: 100, torque: 300, throttle: 0.5 }, 5000, st).forEach(([i, f]) => {
        assert.ok(need[i] && need[i].indexOf(f) >= 0, 'demo ' + i + '.' + f + ' is subscribed');
    });

    /* ---------- screens of your own (screens.js) and the home-screen widget ---------- */
    const SCR = require(path.join(ROOT, 'apps', 'live_data', 'screens'));
    const lids = SCR.LAYOUTS.map((l) => l.id);
    assert.strictEqual(new Set(lids).size, lids.length, 'layout ids unique');
    SCR.LAYOUTS.forEach((l) => {
        assert.ok(l.slots.length >= 1 && l.slots.length <= SCR.MAX_SLOTS, l.id + ': 1..' + SCR.MAX_SLOTS + ' gauges');
        l.slots.forEach((k) => assert.ok(SCR.KINDS[k], l.id + ': known gauge ' + k));
        // a box per gauge, inside the area: full screen and the widget's
        [[24, 52, 1552, 460, false], [35, 26, 314, 204, true]].forEach(([x, y, w, h, small]) => {
            const bs = SCR.boxes(l, x, y, w, h, small);
            assert.strictEqual(bs.length, l.slots.length, l.id + ': a box per gauge');
            bs.forEach((b) => assert.ok(b.x >= x - 0.01 && b.y >= y - 0.01 && b.x + b.w <= x + w + 0.01 && b.y + b.h <= y + h + 0.01 && b.w > 40 && b.h > 40,
                l.id + (small ? ' widget' : '') + ': box inside ' + JSON.stringify(b)));
        });
    });
    assert.strictEqual(SCR.layout('nope').id, SCR.LAYOUTS[0].id, 'an unknown layout: the first');
    assert.strictEqual(SCR.nextLayout(SCR.LAYOUTS[SCR.LAYOUTS.length - 1].id), SCR.LAYOUTS[0].id, 'Layout goes round');
    let sc = SCR.scale('sig:rpm', null, 'rpm', null);
    assert.ok(sc.min === 0 && sc.max === 7000 && sc.red === 6500 && sc.zones.some((z) => z.color === 'crit' && z.from === 6500), 'rpm: 0-7000, red from 6500');
    sc = SCR.scale('18:useful:Engine oil (after filter)', 'Engine oil (after filter)', '°C', null);
    assert.ok(sc.min === 40 && sc.max === 150 && sc.zones.length === 2, 'oil: 40-150, warning and red');
    sc = SCR.scale('18:useful:Engine oil (after filter)', 'Engine oil (after filter)', '°F', null);
    assert.ok(sc.min === 100 && sc.max === 310 && sc.zones.length === 2 && sc.zones[1].from === 284 && sc.zones[1].to === 310, 'oil in °F: the °C scale converted, ends in tens ' + JSON.stringify(sc));
    sc = SCR.scale('sig:coolant', null, '°F', { lo: 190, hi: 200 });
    assert.ok(sc.min === 100 && sc.max === 270 && sc.red === 248, 'coolant in °F: red from 120 °C = 248 °F');
    assert.strictEqual(SCR.scale('sig:flow', null, 'l/h', { lo: 0, hi: 12 }).max, 40, 'l/h: 40 while below');
    assert.strictEqual(SCR.scale('sig:flow', null, 'l/h', { lo: 0, hi: 50.7 }).max, 60, 'l/h: grows to the next round number');
    assert.strictEqual(SCR.scale('x', null, 'bar', null).max, 3, 'by unit');
    sc = SCR.scale('x', null, 'mg', { lo: -3, hi: 41 });
    assert.ok(sc.min < -3 && sc.max >= 41 * 1.2 - 1e-9, 'nothing known: from the values seen ' + JSON.stringify(sc));
    assert.deepStrictEqual([50.7, 1.2, 7300, 13].map(SCR.niceUp), [60, 1.25, 8000, 15], 'round steps');
    assert.strictEqual(SCR.short('Fuel consumption (car signal)'), 'Fuel consumption', 'widget labels without brackets');
    // every layout draws, full screen and as the widget, with a number, a text, no data and an empty gauge
    const { Recorder } = require(path.join(kit, 'record'));
    const G = require(path.join(kit, 'gauges')), { theme } = require(path.join(kit, 'themes')), { fitText } = require(path.join(kit, 'text-layout'));
    const sample = [
        { name: 'Engine speed', text: '3000 rpm', n: 3000, u: 'rpm', d: 0, peak: 3500, hist: [1, 2, 3], sc: SCR.scale('sig:rpm', null, 'rpm', null) },
        { name: 'Gear', text: 'D4', n: null, sc: SCR.scale('sig:gear', null, '', null) },
        { name: 'Boost', text: 'no data', dim: true, n: null, u: 'bar', sc: SCR.scale('x', 'Boost', 'bar', null) },
        { empty: true },
    ];
    SCR.LAYOUTS.forEach((l) => [false, true].forEach((small) => {
        const rec = new Recorder(small ? 384 : 1600, small ? 256 : 520);
        SCR.draw(rec, theme('m_tricolour'), G, l, sample, small ? { x: 35, y: 26, w: 314, h: 204 } : { x: 24, y: 52, w: 1552, h: 460 }, small, 0, fitText);
        assert.ok(rec.words().length > 0, l.id + (small ? ' widget' : '') + ' draws');
    }));
    // the widget's picture: each size inside the picture, the smaller ones further in (the HMI fades the edges)
    const inside = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
    const wb = {}; ['small', 'medium', 'large'].forEach((f) => { wb[f] = SCR.widgetBox(384, 256, [0.09, 0.1], f); });
    assert.ok(inside(wb.large, { x: 0, y: 0, w: 384, h: 256 }) && inside(wb.medium, wb.large) && inside(wb.small, wb.medium), 'widget sizes nest ' + JSON.stringify(wb));
    assert.deepStrictEqual(SCR.widgetBox(384, 256, [0.1, 0.1, 0.1, 0.1], 'nope'), SCR.widgetBox(384, 256, [0.1, 0.1], 'medium'), 'safe: 2 or 4 shares, medium by default');
    const aspec = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'live_data', 'app.json'), 'utf8'));
    assert.ok(aspec.startWidget && aspec.startWidget.image && aspec.startWidget.size, 'a home-screen widget');
    const wset = aspec.settings.find((s) => s.key === 'widget');
    assert.ok(wset && wset.options.length === SCR.MAX_SCREENS, 'the widget can show each screen');
    assert.ok(aspec.settings.some((s) => s.key === 'widgetFps'), 'widget: redraws a second');
    const wfit = aspec.settings.find((s) => s.key === 'widgetFit');
    assert.ok(wfit && wfit.options.every((o) => SCR.FIT[o[0]]) && SCR.FIT[wfit.default], 'widget: picture size setting');

    /* ---------- a new install: its screens and settings ---------- */
    // (SIG: signals.js, from the car signals' checks above)
    assert.ok(SCR.DEFAULTS.length >= 1 && SCR.DEFAULTS.length <= SCR.MAX_SCREENS, 'default screens');
    SCR.DEFAULTS.forEach(([lid, ids]) => {
        assert.strictEqual(SCR.layout(lid).id, lid, 'default screen: layout ' + lid);
        assert.strictEqual(ids.length, SCR.layout(lid).slots.length, lid + ': a value for each gauge');
        ids.forEach((id) => assert.ok(SIG.ITEMS[id] && !SIG.ITEMS[id].raw, lid + ': ' + id + ' is a car signal with a known scale'));
    });
    const setting = (k) => aspec.settings.find((x) => x.key === k);
    assert.ok(setting('currency').default === 'EUR' && setting('currency').options.some((o) => o[0] === 'EUR'), 'currency: EUR');
    assert.strictEqual(setting('details').default, false, 'sources and unverified values: off');
    assert.ok(setting('tempUnit').default === 'c' && setting('tempUnit').options.map((o) => o[0]).join() === 'c,f', 'temperature unit: Celsius by default, or Fahrenheit');
    assert.ok(setting('show').options.some((o) => o[0] === setting('show').default) && setting('show').reset >= 2, 'unit pages: a known default, reset from the old one');
    assert.ok(/^1\.\d+\.\d+$/.test(aspec.version), 'version 1.x');
    assert.ok(!aspec.settings.some((x) => /UAH/.test(String(x.default))), 'no local currency as a default');

    /* ---------- the value picker (picker.js) ---------- */
    // (it uses the kit as the built app has it: ./kit = kit/runtime)
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'live-data-app-'));
    fs.symlinkSync(kit, path.join(stage, 'kit'), 'dir');
    fs.copyFileSync(path.join(ROOT, 'apps', 'live_data', 'picker.js'), path.join(stage, 'picker.js'));
    process.on('exit', () => fs.rmSync(stage, { recursive: true, force: true }));
    const PICK = require(path.join(stage, 'picker'));
    const picked = [];
    let lay = 'dial2', removed = 0;
    const groups = () => [
        { name: 'Car signals: Engine', items: [{ key: 'sig:rpm', fav: { sig: 'rpm', name: 'Engine speed' }, name: 'Engine speed', text: () => ({ text: '800 rpm' }) },
            { key: 'sig:oil', fav: { sig: 'oil', name: 'Engine oil' }, name: 'Engine oil', text: () => ({ text: '90 °C' }) }] },
        { name: 'Engine unit: Oil', items: [{ key: '18:useful:Oil pressure', fav: { addr: 18, useful: 'Oil pressure' }, name: 'Oil pressure', text: () => ({ text: '...', dim: true }) }] },
    ];
    const pick = (cur, opts) => PICK.valueSheet(Object.assign({ title: 'Gauge 1', groups, current: cur, choose: (c) => picked.push(c),
        layouts: SCR.LAYOUTS, layout: lay, setLayout: (id) => { lay = id; }, remove: () => { removed++; } }, opts || {}));
    let ps = pick('sig:oil');
    assert.strictEqual(ps.focus, 1, 'opens on the group the gauge has');
    assert.strictEqual(ps.press(), null, 'press: the group opens');
    assert.ok(ps.open && ps.sub === 1 && ps.listed().length === 2, 'on the value the gauge has, the values listed (to be read)');
    ps.move(-1);
    assert.strictEqual(ps.press(), 'close', 'press: taken');
    assert.deepStrictEqual(picked.pop(), ['sig:rpm', { sig: 'rpm', name: 'Engine speed' }], 'the key and what is kept with it');
    ps = pick(null);
    assert.ok(ps.focus === 0 && ps.press() === 'close' && picked.pop() === null, 'None: an empty gauge');
    ps = pick('sig:rpm');
    ps.press(); assert.strictEqual(ps.back(), null, 'back: from the values to the groups');
    assert.ok(ps.open === null && ps.back() === 'close', 'back again: closed');
    ps = pick('sig:rpm'); ps.move(2); ps.press();
    ps.move(1); ps.press();
    assert.strictEqual(lay, SCR.LAYOUTS[1].id, 'the layout: chosen from its list');
    ps = pick('sig:rpm'); ps.move(3);
    assert.ok(ps.press() === null && !removed, 'remove: once marks it');
    assert.ok(ps.press() === 'close' && removed === 1, 'again: removed');
    assert.strictEqual(pick('sig:rpm', { remove: null }).rows().length, 1 + 2 + 1, 'a new screen: no removal');
    const price = { p: 1.8 }, prs = PICK.priceSheet({ price: () => price.p, nudge: (d) => { price.p = Math.round((price.p + d) * 100) / 100; }, keep() {}, currency: () => 'EUR' });
    prs.move(2);
    assert.ok(Math.abs(price.p - 2.0) < 1e-9 && prs.press() === 'close', 'fuel price: the knob 0.10 a step, press keeps it');

    /* ---------- the demo engine unit answers with values that make sense ---------- */
    const DEMO = require(path.join(ROOT, 'apps', 'live_data', 'demo'));
    let answered = 0;
    Object.keys(dme).forEach((d) => {
        const e = dme[d], r = DEMO.reply(0x12, 0x22, parseInt(d, 16), 1, e);
        if (!r || r[0] !== 0x62) return;
        answered++;
        const v = decode(e, r);
        e.f.forEach((f, i) => { if (f.u === '°C' && !f.m) assert.ok(v[i].value > -40 && v[i].value < 150, d + ': a believable temperature ' + v[i].value); });
    });
    assert.ok(answered > Object.keys(dme).length / 2, 'demo: most built-in engine values answer (' + answered + ')');

    /* ---------- the trip computer (trips.js) ---------- */
    const TR = require(path.join(ROOT, 'apps', 'live_data', 'trips'));
    let tq = new TR.Trips({ price: 0 }), tt0 = new Date(2026, 9, 28, 8, 0, 0).getTime(), tnow = tt0;
    const drive = (secs, o) => { let r = { started: false, ended: null }; for (let k = 0; k < secs * 2; k++) { tnow += 500; const x = tq.feed(tnow, o); if (x.started) r.started = true; if (x.ended) r.ended = x.ended; } return r; };
    assert.ok(!drive(60, { running: 'off', speed: 0 }).started, 'no trip with the engine off');
    assert.ok(drive(1, { running: 'running', speed: 0 }).started, 'a trip starts with the engine');
    drive(60, { running: 'running', speed: 0, lph: 1.2, src: 'signal', odo: 1000, tank: 40 });
    drive(1800, { running: 'running', speed: 60, lph: 6, src: 'signal', odo: 1030, tank: 37 });
    drive(120, { running: 'off', speed: 0 });                                 // start-stop at the lights: the same trip
    drive(1800, { running: 'running', speed: 60, lph: 6, src: 'engine unit', odo: 1060, tank: 35 });
    assert.ok(tq.cur && Math.abs(tq.cur.km - 60) < 0.1 && Math.abs(tq.cur.l - 6.02) < 0.01, 'one trip over a short stop: ' + tq.cur.km + ' km ' + tq.cur.l + ' l');
    // the head unit sleeps 5 min (the app restarted from its file): the same trip, nothing counted over the gap
    tq = new TR.Trips(JSON.parse(JSON.stringify(tq))); tnow += 5 * 60000;
    drive(60, { running: 'running', speed: 60, lph: 6, odo: 1061 });
    assert.ok(Math.abs(tq.cur.km - 61) < 0.1, 'after 5 min asleep: the same trip goes on ' + tq.cur.km);
    let ended = drive(TR.END_MS / 1000 + 2, { running: 'off', speed: 0 }).ended;
    assert.ok(ended && !tq.cur && Math.abs(ended.km - 61) < 0.1 && ended.src === 'signal+engine unit' && ended.odo0 === 1000 && ended.odo1 === 1061 && ended.tank0 === 40,
        'engine off 10 min: the trip is kept ' + JSON.stringify(ended));
    assert.ok(Math.abs(TR.per100(ended.km, ended.l) - ended.l / ended.km * 100) < 1e-9 && TR.per100(0.5, 1) === null, 'l/100 km from 1 km');
    // the head unit asleep longer: the next start ends the old trip at its last sign of life
    drive(1, { running: 'running', speed: 0 }); drive(600, { running: 'running', speed: 30, lph: 3 });
    const saved = JSON.parse(JSON.stringify(tq)); tq = new TR.Trips(saved); tnow += 3 * 3600000;
    const r2 = drive(1, { running: 'off', speed: 0 });
    assert.ok(r2.ended && Math.abs(r2.ended.km - 5) < 0.05 && r2.ended.end < tnow - 3 * 3600000 + 1000 && !tq.cur, 'asleep 3 h: the trip ended when the car stopped');
    assert.strictEqual(drive(30, { running: 'running', speed: 0, lph: 0.5 }).ended, null);
    tq.finish();
    assert.strictEqual(tq.trips.length, 2, 'started, warmed up, stopped: not a trip');
    // the fuel price: a new install starts with the default, a saved one is kept (also none)
    assert.ok(TR.PRICE === 1.8 && new TR.Trips(null).price === TR.PRICE, 'a new install: 1.80 a litre');
    assert.ok(new TR.Trips({ price: 2.05 }).price === 2.05 && new TR.Trips({ price: 0 }).price === 0, 'a saved price is kept');
    // costs (no price from the start): a trip without a price takes the one set; one with a price keeps it
    assert.strictEqual(tq.total('today', tnow).cost, null, 'no price: no cost');
    tq.setPrice(60);
    assert.ok(Math.abs(tq.cost(tq.trips[0]) - tq.trips[0].l * 60) < 1e-9, 'priced when the price is set');
    drive(1, { running: 'running', speed: 0 }); drive(600, { running: 'running', speed: 60, lph: 6 }); drive(TR.END_MS / 1000 + 2, { running: 'off', speed: 0 });
    tq.setPrice(70);
    const lastTrip = tq.trips[tq.trips.length - 1];
    assert.ok(lastTrip.price === 60 && Math.abs(tq.cost(lastTrip) - lastTrip.l * 60) < 1e-9, 'a finished trip keeps its price');
    const tday = tq.total('today', tnow), tall = tq.total('all', tnow);
    assert.ok(tday.n === 3 && Math.abs(tday.km - tall.km) < 1e-9 && Math.abs(tday.cost - (tq.trips[0].l + tq.trips[1].l) * 70 - lastTrip.l * 60) < 1e-6, 'today: every trip, each at its price');
    // kept: the last 5 trips, 31 days; the file stays small
    for (let k = 0; k < 120; k++) { tnow += 86400000 / 3; drive(1, { running: 'running', speed: 0 }); drive(120, { running: 'running', speed: 50, lph: 5 }); tnow += TR.END_MS + 1000; drive(1, { running: 'off', speed: 0 }); }
    assert.strictEqual(tq.trips.length, TR.KEEP, 'the last ' + TR.KEEP + ' trips');
    assert.ok(Object.keys(tq.days).length <= TR.DAYS, 'a total a day for ' + TR.DAYS + ' days');
    assert.ok(tq.total('all', tnow).n === 123 && tq.total('week', tnow).n <= 22 && tq.total('last', tnow).n === 5, 'totals');
    assert.ok(JSON.stringify(tq).length < 8000, 'data/trips.json stays small: ' + JSON.stringify(tq).length + ' bytes');
    assert.strictEqual(new TR.Trips({ trips: [{ start: 'x' }], days: { bad: 1 }, price: -3 }).trips.length, 0, 'a damaged file is ignored');

    /* ---------- the app talks to the car only through the read-only link ---------- */
    const appSrc = fs.readFileSync(path.join(ROOT, 'apps', 'live_data', 'main.js'), 'utf8');
    assert.ok(!/signals\.(set|call|proxy)\(|setValue\(/.test(appSrc + fs.readFileSync(path.join(ROOT, 'apps', 'live_data', 'signals.js'), 'utf8')),
        'car signals: only watched, never set or called');
    assert.ok(!/new\s+Diag\s*\(/.test(appSrc), 'no full Diag in the app');
    assert.ok(!/\{[^}]*\bDiag\b[^}]*\}\s*=\s*require\('\.\/kit\/diag'\)/.test(appSrc), 'the app does not import Diag');
    assert.ok(!/require\('\.\/kit\/dids'\)/.test(appSrc), 'nor the DID reader on a full link');
    assert.ok(/new ReadOnlyDiag\(/.test(appSrc), 'the app uses the read-only link');

    console.log('live data tests passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
