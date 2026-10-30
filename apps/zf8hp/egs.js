'use strict';

const C = require('./catalog');
const finite = (v) => typeof v === 'number' && isFinite(v);

function payload(did, uds) {
    const b = Buffer.from(uds || []);
    const id = parseInt(did, 16);
    if (b.length < 3 || b[0] !== 0x62 || b[1] !== (id >> 8) || b[2] !== (id & 255)) return null;
    return b.slice(3);
}

function decode(did, uds) {
    did = String(did).toUpperCase();
    const meta = C.records[did], b = payload(did, uds);
    if (!meta || !b) return { ok: false, error: 'No matching positive response', values: [] };
    if (meta.length !== null && b.length !== meta.length) {
        return { ok: false, error: 'Unexpected length: ' + b.length + ', expected ' + meta.length, values: [] };
    }
    const values = meta.fields.map((f) => {
        const raw = f.signed ? (f.little ? b.readIntLE(f.at, f.bytes) : b.readIntBE(f.at, f.bytes))
            : (f.little ? b.readUIntLE(f.at, f.bytes) : b.readUIntBE(f.at, f.bytes));
        return raw * f.factor + f.offset;
    });
    return { ok: true, raw: b.toString('hex').toUpperCase(), values, bytes: b.length, decoded: values.length > 0 };
}

function shiftRecords(family, group) {
    const f = family === '2' || family === 'cold2' ? 2 : 1;
    return C.shifts.filter((s) => s.family === f && (group === 'up' ? s.toGear > s.fromGear
        : group === 'skip' ? s.fromGear - s.toGear > 1 : s.fromGear - s.toGear === 1));
}

function mapValues(records, shift, family) {
    if (!shift) return { values: [], unit: 'mbar', did: '', error: 'This map family has no such shift' };
    const cold = family === 'cold1' || family === 'cold2';
    const did = cold ? (family === 'cold2' ? '41B7' : '41B6') : shift.did;
    const r = records[did];
    if (cold && (shift.toGear - shift.fromGear !== 1)) return { values: [], unit: 'mbar', did, error: 'Cold maps contain single upshifts only' };
    const offset = cold ? (shift.fromGear - 1) * 64 : 0;
    // Normal maps are signed 0.01 bar cells. Show all maps consistently in mbar.
    const scale = cold ? 1 : 1000;
    return { values: r && r.ok ? r.values.slice(offset, cold ? offset + 64 : undefined).map((v) => v * scale) : [],
        unit: 'mbar', did, record: r, error: r && r.error };
}

function summary(values) {
    const v = (values || []).filter(finite);
    return v.length ? { min: Math.min.apply(null, v), max: Math.max.apply(null, v), mean: v.reduce((a, b) => a + b, 0) / v.length, count: v.length } : null;
}

const TCC = { 0: 'OPEN', 1: 'REGULATED LOW', 2: 'REGULATED HIGH', 3: 'LOCKED LOW', 4: 'LOCKED HIGH',
    8: 'OPENING', 9: 'TO REGULATED LOW', 10: 'TO REGULATED HIGH', 11: 'TO LOCKED LOW', 12: 'TO LOCKED HIGH' };

module.exports = { payload, decode, shiftRecords, mapValues, summary, TCC, finite };
