'use strict';
/**
 * dids.js - read numbers with UDS ReadDataByIdentifier (0x22) over kit/diag.js.
 *
 * DIDs differ between models, so each value has a list of candidates; the first
 * one that answers with a plausible number wins and is tried first next time.
 *
 *   candidate = { ecu, did: 'F40F', bytes: 1, at: 0, factor: 1, offset: -40, min, max }
 *     raw = 'bytes' big-endian bytes from 'at' (0 = first data byte after the DID),
 *     value = raw * factor + offset, outside min..max = not plausible
 *   const rd = new DidReader(diag, { ecu: 0x12 });
 *   const v = await rd.value('iat', cfg.iat);      // number or null
 *   rd.raws['18:F40F'] -> { t, ok, value, bytes, why }   (for a diagnostics view)
 *   rd.pick.iat        -> index of the candidate that answered last
 */
const { hex, NRC } = require('./diag');

class DidReader {
    constructor(diag, defaults) {
        this.diag = diag;
        this.ecu = defaults && defaults.ecu;
        this.raws = {};
        this.pick = {};
    }

    key(c) { return (c.ecu == null ? this.ecu : c.ecu) + ':' + c.did; }

    /** Read one candidate; returns the value or null (reason in raws). */
    async read(c) {
        const ecu = c.ecu == null ? this.ecu : c.ecu, did = parseInt(c.did, 16);
        const r = { t: Date.now(), ok: false, value: null, bytes: '', why: '' };
        this.raws[this.key(c)] = r;
        // ours: the positive reply for this DID, or a refusal of a 0x22 request
        const accept = (u) => (u[0] === 0x62 && ((u[1] << 8) | u[2]) === did) || (u[0] === 0x7F && u[1] === 0x22);
        let uds;
        try { uds = await this.diag.physical(ecu, 0x22, [did >> 8, did & 0xFF], c.timeoutMs || 4000, accept); } catch (e) { r.why = String(e.message || e); return null; }
        if (!uds) { r.why = 'no reply'; return null; }
        r.bytes = uds.map((x) => hex(x)).join(' ');
        if (uds[0] === 0x7F) { r.why = 'NRC ' + hex(uds[2]) + (NRC[uds[2]] ? ' ' + NRC[uds[2]] : ''); return null; }
        const at = 3 + (c.at || 0), n = c.bytes || 1;
        if (uds.length < at + n) { r.why = 'reply too short'; return null; }
        let raw = 0;
        for (let i = 0; i < n; i++) raw = raw * 256 + uds[at + i];
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
}

module.exports = { DidReader };
