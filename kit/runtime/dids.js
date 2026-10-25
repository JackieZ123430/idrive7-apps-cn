'use strict';
/**
 * dids.js - read numbers with UDS ReadDataByIdentifier (0x22) over kit/diag.js.
 *
 * DIDs differ between models, so each value has a list of candidates; the first
 * one that answers with a plausible number wins and is tried first next time.
 *
 *   candidate = { ecu, did: 'F40F', bytes: 1, at: 0, factor: 1, offset: -40, min, max }
 *     raw = 'bytes' big-endian bytes from 'at' (0 = first data byte after the DID),
 *     value = raw * factor + offset, outside min..max = not plausible; signed: true = raw is
 *     two's complement (e.g. a torque that can be negative)
 *   or { ecu, obd: '0F', ... }: the same PID with OBD service 01 instead of 0x22 F4xx
 *     (for engine units that refuse the F4xx identifiers with NRC 31); 'at' counts from the
 *     first data byte after the PID
 *   const rd = new DidReader(diag, { ecu: 0x12 });
 *   const v = await rd.value('iat', cfg.iat);      // number or null
 *   rd.raws['18:F40F'] -> { t, ok, value, bytes, why }   (for a diagnostics view)
 *   rd.pick.iat        -> index of the candidate that answered last
 *   await rd.monitor(0x12, 0xA2) -> OBD service 06 test results (misfire counts of cylinder 1)
 *   await rd.supported(0x12, 0xA0) -> the monitor ids A1..C0 the unit has, e.g. [0xA1, 0xA2, ...]
 */
const { hex, NRC } = require('./diag');

class DidReader {
    constructor(diag, defaults) {
        this.diag = diag;
        this.ecu = defaults && defaults.ecu;
        this.raws = {};
        this.pick = {};
    }

    key(c) { return (c.ecu == null ? this.ecu : c.ecu) + ':' + DidReader.label(c); }

    /** What a candidate reads, for keys and the diagnostics views: 'F40F' or 'OBD 0F'. */
    static label(c) { return c.obd ? 'OBD ' + String(c.obd).toUpperCase() : c.did; }

    /** Read one candidate; returns the value or null (reason in raws). */
    async read(c) {
        const ecu = c.ecu == null ? this.ecu : c.ecu, obd = c.obd ? parseInt(c.obd, 16) : null, did = obd === null ? parseInt(c.did, 16) : null;
        const r = { t: Date.now(), ok: false, value: null, bytes: '', why: '' };
        this.raws[this.key(c)] = r;
        // ours: the positive reply for this DID / PID, or a refusal of the same service
        const sid = obd === null ? 0x22 : 0x01;
        const accept = (u) => (obd === null ? u[0] === 0x62 && ((u[1] << 8) | u[2]) === did : u[0] === 0x41 && u[1] === obd) || (u[0] === 0x7F && u[1] === sid);
        let uds;
        try { uds = await this.diag.physical(ecu, sid, obd === null ? [did >> 8, did & 0xFF] : [obd], c.timeoutMs || 4000, accept); } catch (e) { r.why = String(e.message || e); return null; }
        if (!uds) { r.why = 'no reply'; return null; }
        r.bytes = uds.map((x) => hex(x)).join(' ');
        if (uds[0] === 0x7F) { r.why = 'NRC ' + hex(uds[2]) + (NRC[uds[2]] ? ' ' + NRC[uds[2]] : ''); return null; }
        const at = (obd === null ? 3 : 2) + (c.at || 0), n = c.bytes || 1;
        if (uds.length < at + n) { r.why = 'reply too short'; return null; }
        let raw = 0;
        for (let i = 0; i < n; i++) raw = raw * 256 + uds[at + i];
        if (c.signed && raw >= Math.pow(2, 8 * n - 1)) raw -= Math.pow(2, 8 * n);      // two's complement
        const v = raw * (c.factor == null ? 1 : c.factor) + (c.offset || 0);
        r.value = v;
        if ((c.min != null && v < c.min) || (c.max != null && v > c.max)) { r.why = 'out of range'; return null; }
        r.ok = true;
        return v;
    }

    /** Try a value's candidates, starting with the one that worked last. */
    async value(name, list) {
        list = list || [];
        const start = this.pick[name] || 0;
        for (let k = 0; k < list.length; k++) {
            const i = (start + k) % list.length;
            const v = await this.read(list[i]);
            if (v !== null) { this.pick[name] = i; return v; }
        }
        return null;
    }

    /**
     * On-board monitor results (OBD service 06, e.g. misfire counts): the test results of one
     * monitor id (mid, e.g. 0xA2 = cylinder 1 misfire) as [{ tid, unit, value, min, max }], or
     * null (reason in raws[key]). Each record in the 0x46 reply is MID TID UaSID value(2) min(2) max(2).
     * With did: true it asks UDS 0x22 F6<mid> instead (engines that only speak UDS); its records
     * have no MID byte.
     */
    async monitor(ecu, mid, did) {
        const uds = await this.ask06(ecu, mid, did), r = this.raws[this.monitorKey(ecu, mid, did)];
        if (!uds) return null;
        const out = [], size = did ? 8 : 9;
        for (let i = did ? 3 : 1; i + size <= uds.length; i += size) {
            const o = did ? i : i + 1;                      // skip the repeated MID in service 06 records
            if (!did && uds[i] !== mid) break;
            out.push({ tid: uds[o], unit: uds[o + 1], value: (uds[o + 2] << 8) | uds[o + 3], min: (uds[o + 4] << 8) | uds[o + 5], max: (uds[o + 6] << 8) | uds[o + 7] });
        }
        if (!out.length) { r.why = 'no test results'; return null; }
        r.ok = true;
        return out;
    }

    /**
     * Which monitor ids the unit supports: mid 0xA0 answers with a bit map of A1..C0 (first byte,
     * top bit = A1). Returns the ids, or null.
     */
    async supported(ecu, mid, did) {
        const uds = await this.ask06(ecu, mid, did), r = this.raws[this.monitorKey(ecu, mid, did)];
        const at = did ? 3 : 2;
        if (!uds) return null;
        if (uds.length < at + 4) { r.why = 'reply too short'; return null; }
        const out = [];
        for (let i = 0; i < 32; i++) if (uds[at + (i >> 3)] & (0x80 >> (i & 7))) out.push(mid + 1 + i);
        r.ok = true;
        return out;
    }

    /** raws key of a monitor id: '18:MID A2', or '18:F6A2' for the UDS form. */
    monitorKey(ecu, mid, did) { return (ecu == null ? this.ecu : ecu) + ':' + (did ? 'F6' : 'MID ') + hex(mid); }

    /** Ask for one monitor id (service 06, or UDS 22 F6xx): the positive reply, or null (reason in raws). */
    async ask06(ecu, mid, did) {
        ecu = ecu == null ? this.ecu : ecu;
        const r = { t: Date.now(), ok: false, value: null, bytes: '', why: '' };
        this.raws[this.monitorKey(ecu, mid, did)] = r;
        const sid = did ? 0x22 : 0x06;
        const accept = (u) => (did ? u[0] === 0x62 && u[1] === 0xF6 && u[2] === mid : u[0] === 0x46 && u[1] === mid) || (u[0] === 0x7F && u[1] === sid);
        let uds;
        try { uds = await this.diag.physical(ecu, sid, did ? [0xF6, mid] : [mid], 4000, accept); } catch (e) { r.why = String(e.message || e); return null; }
        if (!uds) { r.why = 'no reply'; return null; }
        r.bytes = uds.map((x) => hex(x)).join(' ');
        if (uds[0] === 0x7F) { r.why = 'NRC ' + hex(uds[2]) + (NRC[uds[2]] ? ' ' + NRC[uds[2]] : ''); return null; }
        return uds;
    }
}

module.exports = { DidReader };
