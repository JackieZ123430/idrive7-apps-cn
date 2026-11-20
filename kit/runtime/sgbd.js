'use strict';
/**
 * sgbd.js - turn a control unit's reply into values, with the catalog kit/tools/sgbd_catalog.py
 * made from its SGBD (one UDS 22 request answers every field of its identifier).
 *
 *   entry = catalog['4A36'] = { a: 'ISKLO', d: '<German text>', f: [field, ...] }
 *   field = { n: RESULTNAME, t: 'u8'|'s8'|'u16'|'s16'|'u32'|'s32'|'f32'|'hex'|'str'|'txt', at, len, m, k, o, u, x, e, le, d }
 *           (txt: text when the bytes are printable, else hex; x: the number shown in hex)
 *           at = byte offset after the identifier, m = bit mask (the bits are shifted down),
 *           value = raw * k + o (k defaults to 1, o to 0), e = value table in enums, le = low byte first
 *
 *   const vals = decode(entry, reply, enums);   // reply = the unit's answer: 62 4A 36 <data...>
 *                                               // (or OBD 41 <PID> <data> / 49 <PID> <data>)
 *   vals[i] = { value, text, raw } or { why: 'reply too short' }
 *   format(vals[i], field) -> '2.31 bar', 'TRUE', '0A 3F ...'
 */
const SIZE = { u8: 1, s8: 1, u16: 2, s16: 2, u32: 4, s32: 4, f32: 4 };

/** the lowest bit a mask covers, as a power of two (0x30 -> 16) */
function low(m) {
    let p = 1;
    while (m >= p && Math.floor(m / p) % 2 === 0) p *= 2;
    return p;
}

/** (raw & m) moved down to bit 0; arithmetic instead of & so 32-bit values stay unsigned */
function masked(raw, m) {
    let out = 0;
    for (let bit = 1; bit <= m; bit *= 2) {
        if (Math.floor(m / bit) % 2 === 1 && Math.floor(raw / bit) % 2 === 1) out += bit;
    }
    return out / low(m);
}

const hexByte = (c) => (c < 16 ? '0' : '') + c.toString(16).toUpperCase();

/** one field from the data bytes after the identifier */
function field(data, f, enums) {
    const n = f.len || SIZE[f.t];
    if (!n) return { why: 'unknown type ' + f.t };
    if (f.t === 'hex' || f.t === 'str' || f.t === 'txt') {
        if (data.length <= f.at) return { why: 'reply too short' };
        const b = data.slice(f.at, f.at + n);       // variable length: what the unit sent, up to len
        // txt: text when it is printable (padding 00 / FF / spaces aside), else the bytes
        let end = b.length;
        while (end > 0 && (b[end - 1] === 0 || b[end - 1] === 0xFF || b[end - 1] === 0x20)) end--;
        const printable = end > 0 && b.slice(0, end).every((c) => c >= 0x20 && c < 0x7F);
        if (f.t === 'str' || (f.t === 'txt' && printable)) return { value: String.fromCharCode.apply(null, b.filter((c) => c >= 0x20 && c < 0x7F)).trim(), raw: b };
        return { value: b.map(hexByte).join(' '), raw: b };
    }
    if (data.length < f.at + n) return { why: 'reply too short' };
    const b = data.slice(f.at, f.at + n);
    if (f.le) b.reverse();
    if (f.t === 'f32') {
        const v = Buffer.from(b).readFloatBE(0);
        return isFinite(v) ? { value: v * (f.k == null ? 1 : f.k) + (f.o || 0), raw: v } : { why: 'not a number' };
    }
    let raw = 0;
    for (let i = 0; i < n; i++) raw = raw * 256 + b[i];
    if (f.m) raw = masked(raw, f.m);
    else if (f.t[0] === 's' && raw >= Math.pow(2, 8 * n - 1)) raw -= Math.pow(2, 8 * n);       // two's complement
    const out = { value: raw * (f.k == null ? 1 : f.k) + (f.o || 0), raw };
    const table = f.e && enums && enums[f.e];
    if (table && table[String(raw)] !== undefined) out.text = table[String(raw)];
    return out;
}

// the reply's header before the data: 62 <DID hi> <DID lo>, OBD 41 <PID> / 49 <PID>
const HEAD = { 0x62: 3, 0x41: 2, 0x49: 2 };

/** every field of an identifier from the unit's positive reply; null when it isn't one */
function decode(entry, reply, enums) {
    const h = reply && HEAD[reply[0]];
    if (!h || reply.length < h) return null;
    const data = Array.prototype.slice.call(reply, h);
    return entry.f.map((f) => field(data, f, enums));
}

/**
 * A reply to several identifiers (62 <DID> <data> <DID> <data> ...) taken apart with the data length
 * of each, lens = { did: bytes } (as one-identifier replies showed them): { did: [62, hi, lo, data...] }
 * for each answered one, or null when the reply doesn't add up (a length that doesn't match).
 */
function split(reply, lens) {
    if (!reply || reply[0] !== 0x62) return null;
    const out = {};
    let i = 1;
    while (i < reply.length) {
        if (i + 2 > reply.length) return null;
        const did = (reply[i] << 8) | reply[i + 1], n = lens[did];
        if (n == null || out[did] || i + 2 + n > reply.length) return null;
        out[did] = [0x62, reply[i], reply[i + 1]].concat(Array.prototype.slice.call(reply, i + 2, i + 2 + n));
        i += 2 + n;
    }
    return out;
}

/** a value for the screen: its name from the value table, or the number with its unit (x: in hex) */
function format(v, f) {
    if (!v || v.why) return v ? v.why : '';
    if (v.text !== undefined && v.text !== '') return String(v.text);
    if (typeof v.value === 'string') return v.value;
    if (f && f.x && typeof v.raw === 'number') {
        const n = v.raw < 0 ? v.raw + Math.pow(2, 8 * (SIZE[f.t] || 4)) : v.raw;
        return '0x' + n.toString(16).toUpperCase().padStart(2 * (SIZE[f.t] || 1), '0');
    }
    const x = v.value, a = Math.abs(x);
    const s = Number.isInteger(x) ? String(x) : a >= 1000 ? x.toFixed(0) : a >= 100 ? x.toFixed(1) : a >= 1 ? x.toFixed(2) : x.toPrecision(3);
    return f && f.u ? s + ' ' + f.u : s;
}

module.exports = { decode, field, format, split, masked, SIZE };
