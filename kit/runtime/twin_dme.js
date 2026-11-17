'use strict';
/**
 * twin_dme.js - engines with two engine units: the V8s (N63, S63, S68). The master at 0x12 runs bank 1, the
 * second unit at 0x13 bank 2; BMW's SGBDs for them come in pairs (DME8FF_R / DME8FF_L, S63TU_R0 / S63TU_L0,
 * N63TU_R0 / N63TU_L0, DME98_R / DME98_L). A value one unit
 * keeps for its own bank (ignition angle, knock retard, fuel flow 5656 "LOKAL") is then only half the engine.
 *
 * Which engines: the master's SGBD index (UDS 22 F1 50, 3 bytes) is one of TWIN_INDEXES, the 0x12 indexes
 * for which BMW's index (apps/live_data/builtin/sgbd_index.json) also lists a unit at 0x13 ("13 <index>").
 * Any other index (B38 / B48 / B58 / S58, the diesels) = one engine unit, and 0x13 is never asked. The N74 V12
 * (MSD87_R0 / MSD87_L0, 6 cylinders a bank) is not supported: it counts as one engine unit, as before.
 *
 *   const twin = new TwinDme(link, { dataDir, log });   // link: kit/diag.js or kit/readonly-diag.js (physical())
 *   await twin.detect()  -> true (two units) / false (one) / null (no answer yet; asked again after RETRY_MS)
 *   twin.twin            -> the last answer (kept in data/twin_dme.json, so a start already knows it)
 *   twin.perBank         -> cylinders per bank (4 on a V8), 0 with one engine unit
 *   twin.index           -> the master's SGBD index ('0F242C'), or null
 *   twin.on()            -> twin === true, asking in the background while not known (for pollers)
 *   twin.known()         -> whether one or two is known (asked this start, or kept from an earlier one)
 *   twin.redline         -> the V8's rev limit for an Auto redline (6500 an N63, 7200 an M car's S63 / S68), or null
 *   TwinDme.isTwinIndex('0F242C') -> true
 *
 * Which V8: N63TU (0F1A20) and S63TU (0F1A10) have indexes of their own, but the G-series ones share them (DME8FF_R:
 * the N63TU2/3 and the S63TU4; DME98_R: the S68 of the M5 / XM and of the M60i / 760i). For those, with { vin: true },
 * the master's VIN (22 F1 90) is read once after the index, and only its maker code kept: WBS (BMW M GmbH) = an M car;
 * 5YM (BMW's US plant: its X5 M / X6 M, but some other X5 / X6 too) says nothing either way, so no V8 redline; any
 * other code = not an M car. The VIN itself is neither kept nor logged.
 *
 * detect() asks the master once per app start (a stored answer is used meanwhile); never throws. A link not up yet
 * (ready / available false: just made, or the transport down) is not asked and doesn't use up the retry wait.
 */
const fs = require('fs');
const path = require('path');

const MASTER = 0x12, SLAVE = 0x13;
// the V8s' 0x12 SGBD indexes, each with a second unit at 0x13 (sgbd_index.json, 2026-11)
const TWIN = [
    '0F1A10',               // S63TU_R0 / S63TU_L0
    '0F1A20',               // N63TU_R0 / N63TU_L0
    '0F242C', '0F242E', '0F2460', '0F26B8', '0F26BC',     // DME8FF_R / DME8FF_L: N63TU2/3, S63TU4
    '0F2E00',               // DME98_R / DME98_L: S68
];
const PER_BANK = 4;
// the V8s' rev limits for an Auto redline (where the shift lights end until Redline has learned the limiter)
const N63_RPM = 6500, M_RPM = 7200;
// indexes of one engine family: the M engine (S63TU) or not (N63TU); every other V8 index: the VIN's maker code says
const M_INDEX = { '0F1A10': true, '0F1A20': false };
const M_WMI = ['WBS'], UNSURE_WMI = ['5YM'];
const RETRY_MS = 30000;
const hex2 = (b) => (b < 16 ? '0' : '') + b.toString(16).toUpperCase();

function writeWhole(file, text) {
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
}

class TwinDme {
    /** link: () => link or a link (anything with physical()); opts: { dataDir, log } */
    constructor(link, opts) {
        this.linkOf = typeof link === 'function' ? link : () => link;
        this.log = (opts && opts.log) || null;
        this.wantVin = !!(opts && opts.vin);
        this.wmi = null;         // the VIN's maker code ('WBS'), null = not read yet
        this.file = opts && opts.dataDir ? path.join(opts.dataDir, 'twin_dme.json') : null;
        this.twin = null; this.index = null;
        this.confirmed = false; this.triedT = 0; this.pending = null;
        if (this.file) {
            try {
                const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
                if (s && typeof s.twin === 'boolean') {
                    this.twin = s.twin; this.index = typeof s.index === 'string' ? s.index : null;
                    this.wmi = typeof s.wmi === 'string' && /^[0-9A-Z]{3}$/.test(s.wmi) ? s.wmi : null;
                }
            } catch (e) { /* not yet */ }
        }
    }

    get perBank() { return this.twin ? PER_BANK : 0; }

    /** An M car's engine (S63 / S68)? true / false, or null when not known (not read yet, or a 5YM car). */
    get m() {
        if (this.index && M_INDEX.hasOwnProperty(this.index)) return M_INDEX[this.index];
        if (!this.wmi || UNSURE_WMI.indexOf(this.wmi) >= 0) return null;
        return M_WMI.indexOf(this.wmi) >= 0;
    }

    get redline() {
        if (this.twin !== true) return null;
        const m = this.m;
        return m === true ? M_RPM : m === false ? N63_RPM : null;
    }

    known() { return typeof this.twin === 'boolean'; }

    on() {
        try { this.detect(); } catch (e) { /* never */ }
        return this.twin === true;
    }

    /** Two engine units? Asks the master's SGBD index once per start (again after RETRY_MS while it doesn't answer). */
    detect() {
        if (this.confirmed) return Promise.resolve(this.twin);
        if (this.pending) return this.pending;
        if (Date.now() - this.triedT < RETRY_MS) return Promise.resolve(this.twin);
        let link = null;
        try { link = this.linkOf(); } catch (e) { /* none yet */ }
        if (!link || typeof link.physical !== 'function' || link.ready === false || link.available === false) return Promise.resolve(this.twin);
        this.triedT = Date.now();
        this.pending = this._ask(link).then((index) => {
            if (index === null) return this.twin;
            this.confirmed = true;
            const twin = TwinDme.isTwinIndex(index);
            let changed = false;
            if (twin !== this.twin || index !== this.index) {
                if (this.log) this.log.info('engine units: SGBD index ' + (index || 'none') + ' -> ' + (twin ? 'two (master 0x12, bank 2 at 0x13)' : 'one'));
                if (index !== this.index) this.wmi = null;        // another engine: its VIN asked again
                this.twin = twin; this.index = index || null; changed = true;
            }
            const vin = twin && this.wantVin && this.wmi === null && !M_INDEX.hasOwnProperty(index) ? this._askVin(link) : Promise.resolve(null);
            return vin.then((wmi) => {
                if (wmi) {
                    this.wmi = wmi; changed = true;
                    const m = this.m;
                    if (this.log) this.log.info('engine units: maker code ' + wmi + ' -> ' + (m === true ? 'an M car (S63 / S68)' : m === false ? 'not an M car (N63, or an M60i / 760i S68)' : 'not known (a US-built X5 / X6)') + ', Auto redline ' + (this.redline || 'from the profile'));
                }
                if (changed) this._save();
                return this.twin;
            });
        }).then((v) => { this.pending = null; return v; }, () => { this.pending = null; return this.twin; });
        return this.pending;
    }

    _save() {
        if (!this.file) return;
        try { writeWhole(this.file, JSON.stringify({ twin: this.twin, index: this.index, wmi: this.wmi })); } catch (e) { if (this.log) this.log.warn('twin_dme save: ' + e); }
    }

    /** The maker code of the master's VIN (22 F1 90: 17 characters), 'WBS', or null (no answer, refused, not a VIN). */
    async _askVin(link) {
        const ok = (u) => (u[0] === 0x62 && u[1] === 0xF1 && u[2] === 0x90) || (u[0] === 0x7F && u[1] === 0x22);
        let u;
        try { u = await link.physical(MASTER, 0x22, [0xF1, 0x90], 4000, ok); } catch (e) { return null; }
        if (!u || u[0] !== 0x62 || u.length < 3 + 17) return null;
        const wmi = String.fromCharCode(u[3], u[4], u[5]);
        return /^[0-9A-HJ-NPR-Z]{3}$/.test(wmi) ? wmi : null;
    }

    /** The master's SGBD index ('0F242C'), '' when it refused, null without an answer. */
    async _ask(link) {
        const ok = (u) => (u[0] === 0x62 && u[1] === 0xF1 && u[2] === 0x50) || (u[0] === 0x7F && u[1] === 0x22);
        let u;
        try { u = await link.physical(MASTER, 0x22, [0xF1, 0x50], 4000, ok); } catch (e) { return null; }
        if (!u || !u.length) return null;
        if (u[0] !== 0x62 || u.length < 6) return '';
        return [u[3], u[4], u[5]].map(hex2).join('');
    }

    static isTwinIndex(index) { return typeof index === 'string' && TWIN.indexOf(index.toUpperCase()) >= 0; }
}
TwinDme.MASTER = MASTER;
TwinDme.SLAVE = SLAVE;
TwinDme.TWIN = TWIN;
TwinDme.RETRY_MS = RETRY_MS;
TwinDme.N63_RPM = N63_RPM;
TwinDme.M_RPM = M_RPM;

module.exports = TwinDme;
