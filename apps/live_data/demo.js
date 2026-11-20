'use strict';
/**
 * Demo car (shown with a DEMO badge): the control units a G20 answers 22 F1 50 with, and made-up
 * replies, so the pages can be tried without a car. An engine unit value in a unit it knows (°C,
 * bar, rpm ...) answers with a believable number that moves slowly; one without a unit (a count, a
 * state) is refused as missing (NRC 31), and of the rest about two in three answer with made-up bytes.
 */
const STD = require('./std');

// address, SGBD index (kit/tools/sgbd_catalog.py --index names their unit types)
const UNITS = [[0x01, '0F16E0'], [0x10, '0F25F0'], [0x12, '0F26E8'], [0x18, '0F14B8'], [0x29, '0F2510'],
    [0x30, '0F2400'], [0x40, '0F2680'], [0x60, '0F2540'], [0x63, '0F25B0']];

function hash(n) {
    let h = (n * 2654435761) >>> 0;
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0; h ^= h >>> 12;
    return h >>> 0;
}
const wave = (period, lo, hi) => lo + (hi - lo) * (0.5 + 0.5 * Math.sin(Date.now() / 1000 * 2 * Math.PI / period));
const be = (v, n) => { const out = []; v = Math.round(v); for (let i = n - 1; i >= 0; i--) out.push(Math.floor(v / Math.pow(256, i)) & 0xFF); return out; };
const ascii = (s) => s.split('').map((c) => c.charCodeAt(0));

// engine unit identifiers with moving values: DID -> data bytes
const LIVE = {
    0x586F: () => be(wave(9, 2200, 4300) & 0xFFFF, 2),           // oil pressure, hPa
    0x4402: () => be((wave(60, 88, 96) + 48) / 0.75, 2),          // oil temperature after the filter
    0x4A36: () => [Date.now() % 7000 < 600 ? 1 : 0],             // knock detected
    0x4436: () => be(wave(9, 3300, 5200), 2),                     // oil pressure, absolute hPa
    0x411A: () => be(71 * 512, 2).concat(be(64 * 512, 2), be(412 * 3600, 4)),     // oil life left (%, %), engine hours on this oil (s)
};
// OBD service 01 PID -> data bytes
const OBD = {
    0x04: () => [Math.round(wave(7, 18, 45) * 2.55)], 0x05: () => [92 + 40], 0x06: () => [Math.round(wave(5, 124, 133))],
    0x07: () => [131], 0x0B: () => [Math.round(wave(7, 35, 140))], 0x0C: () => be(wave(7, 780, 3200) * 4, 2),
    0x0D: () => [0], 0x0E: () => [Math.round((wave(4, 4, 22) + 64) * 2)], 0x0F: () => [24 + 40],
    0x10: () => be(wave(7, 4, 38) * 100, 2), 0x11: () => [Math.round(wave(7, 3, 30) * 2.55)], 0x1F: () => be(Date.now() / 1000 % 4000, 2),
    0x23: () => be(wave(7, 120, 350) * 10, 2), 0x2F: () => [150], 0x33: () => [99], 0x3C: () => be((wave(30, 560, 640) + 40) * 10, 2),
    0x42: () => be(14250, 2), 0x44: () => be(32768, 2), 0x46: () => [17 + 40], 0x5C: () => [94 + 40],
};

// what an engine unit value in this unit reads, from - to (it moves between them)
const TYPICAL = {
    '°C': [72, 96], '°': [6, 24], '°CA': [6, 24], bar: [0.4, 1.6], hPa: [995, 1012], kPa: [99, 150], MPa: [5, 20],
    '%': [18, 46], rpm: [820, 3100], V: [14.1, 14.4], A: [4, 28], l: [29, 33], km: [21000, 21200], h: [905, 906],
    g: [2, 6], mg: [380, 420], mm: [43, 45], 'kg/h': [22, 85], 'l/h': [1.6, 8.5], Nm: [70, 310], 'km/h': [0, 85],
    'ml/s': [0.4, 2.4], 'g/s': [6, 24], s: [100, 3000], min: [2, 180],
};
const BYTES = { u8: 1, s8: 1, u16: 2, s16: 2, u32: 4, s32: 4, f32: 4 };
/** a catalog field's bytes for the value v (raw = (v - o) / k) */
function encode(f, v) {
    if (f.t === 'f32') { const b = Buffer.alloc(4); b.writeFloatBE(v, 0); return Array.from(b); }
    const n = BYTES[f.t] || 1, raw = Math.round((v - (f.o || 0)) / (f.k || 1));
    return be(raw < 0 ? raw + Math.pow(256, n) : raw, n);
}
/** a believable reply's data for a catalog entry (null: none of its values has a unit known here) */
function believable(id, e) {
    if (!e || !e.f || !e.f.some((f) => TYPICAL[f.u] && BYTES[f.t] && !f.m && !f.e)) return null;
    const len = e.f.reduce((m, f) => Math.max(m, f.at + (f.len || BYTES[f.t] || 1)), 0), out = new Array(len).fill(0);
    e.f.forEach((f, i) => {
        const r = TYPICAL[f.u];
        if (!r || !BYTES[f.t] || f.m || f.e) return;
        const v = wave(20 + hash(id * 7 + i) % 40, r[0], r[1]);
        encode(f, v).forEach((b, j) => { out[f.at + j] = b; });
    });
    return out;
}

const pidKey = (pid) => 'OBD ' + (pid < 16 ? '0' : '') + pid.toString(16).toUpperCase();

/** the supported-PID bit map OBD service 01 answers for PID base (00, 20, 40 ...) */
function support(base) {
    const out = [0, 0, 0, 0];
    for (let i = 1; i <= 32; i++) {
        const pid = base + i;
        if ((pid % 32 === 0 && base < 0xA0) || STD.OBD[pidKey(pid)]) out[(i - 1) >> 3] |= 0x80 >> ((i - 1) & 7);
    }
    return out;
}

/**
 * The reply a unit of the demo car gives: bytes (positive reply or 7F refusal), or null (silent).
 * e = the identifier's catalog entry (its fields: what the reply holds), need = how many data bytes it has.
 */
function reply(addr, sid, id, need, e) {
    const unit = UNITS.find((u) => u[0] === addr);
    if (!unit) return null;
    if (sid === 0x22) {
        const head = [0x62, id >> 8, id & 0xFF];
        if (id === 0xF150) return head.concat(be(parseInt(unit[1], 16), 3));
        if (id === 0xF190) return head.concat(ascii('WBA5U000000DEMO00'));
        if (id === 0xF186) return head.concat([1]);
        if (id === 0xF18A) return head.concat(ascii(addr === 0x12 ? 'BOSCH' : 'BMW'));
        if (id >= 0xF180 && id <= 0xF19F) return head.concat(ascii('DEMO-' + addr.toString(16).toUpperCase() + '-' + id.toString(16).toUpperCase()));
        if (addr === 0x12 && LIVE[id]) return head.concat(LIVE[id]());
        const good = addr === 0x12 ? believable(id, e) : null;
        if (good) return head.concat(good);
        if (addr !== 0x12 || !e || hash(id) % 3 === 0 || e.f.some((f) => f.u === undefined && f.t !== 'hex' && f.t !== 'str')) return [0x7F, 0x22, 0x31];
        const out = [], h = hash(id + 7);
        for (let i = 0; i < Math.max(1, need); i++) out.push(hash(h + i * 31) & (i === 0 ? 0x3F : 0xFF));
        return head.concat(out);
    }
    if (addr !== 0x12) return null;
    if (sid === 0x01) {
        if (id % 32 === 0) return [0x41, id].concat(support(id));
        if (OBD[id]) return [0x41, id].concat(OBD[id]());
        return STD.OBD[pidKey(id)] ? [0x41, id].concat(be(hash(id) & 0x7FFF, Math.max(1, need))) : null;
    }
    if (sid === 0x09) {
        if (id === 0x02) return [0x49, 0x02, 0x01].concat(ascii('WBA5U000000DEMO00'));
        if (id === 0x0A) return [0x49, 0x0A, 0x01].concat(ascii('ECM-EngineControl'));
        return [0x7F, 0x09, 0x12];
    }
    return null;
}

/** several identifiers in one request (22 <DID> <DID> ...): the answered ones in turn, or NRC 31 */
function replyMany(addr, ids, needs, entries) {
    const out = [0x62];
    ids.forEach((id, i) => {
        const r = reply(addr, 0x22, id, needs[i], entries && entries[i]);
        if (r && r[0] === 0x62) Array.prototype.push.apply(out, r.slice(1));
    });
    return out.length > 1 ? out : [0x7F, 0x22, 0x31];
}

module.exports = { UNITS, reply, replyMany };
