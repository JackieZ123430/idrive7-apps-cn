'use strict';
/**
 * diaglink.js - the app's thin view over the project's existing UDS/TASU transport
 * (kit/diag.js). It does NOT implement a new transport; it reuses Diag exactly as
 * dtc_scanner does, and adds only:
 *
 *   - a fixed physical target: the DME engine controller, diagnostic address 0x12
 *     (confirmed from the project's own ECU map in apps/dtc_scanner/main.js),
 *   - identity reads of the DME over UDS 0x22 (ReadDataByIdentifier), read-only,
 *     to tell which DME variant we are talking to so the right adapter is chosen.
 *
 * Nothing here actuates the flap. Actuation lives in adapters.js and is gated there.
 */
const { Diag, hex, NRC, replyTo } = require('./kit/diag');

const DME = 0x12;                 // DME engine (BMW diagnostic address)
const DME2 = 0x13;                // a V8's second engine unit (bank 2): its own exhaust flap
// a V8's master index (22 F1 50) -> it has a second unit at 0x13 (kit/twin_dme.js, BMW's SGBD index)
const TWIN = ['0F1A10', '0F1A20', '0F242C', '0F242E', '0F2460', '0F26B8', '0F26BC', '0F2E00'];

// Read-only identity DIDs (UDS 0x22). These only READ; they never change the car.
const DID_SGBD_INDEX = [0xF1, 0x50];   // SGBD index - what BMW tools identify a unit by
const DID_VIN = [0xF1, 0x90];
const DID_HW = [0xF1, 0x91];
const DID_SW = [0xF1, 0x95];
// Electric-exhaust-flap state DIDs (read-only), from BMW's own DME8/MG1 SGBD
// (dme8ff_r / dme_bx8): ASW_EL_AGK = % commanded by a tester, ASG_EL_AGK = output
// position, ISAGK = flap-with-resonator condition. Reading any of them positively
// means this DME has the electric flap and uses DID 0x60FD for 0x2F control.
const DID_ASW_EL_AGK = [0x62, 0xFD];
const DID_ASG_EL_AGK = [0x64, 0xFD];
const DID_ISAGK = [0x4A, 0x65];
// the controlled electric flap (DME8FF, the G-series N63 / S63: GER_EL_AGK, 2F 611E, when St_Akr == 8):
// ASW_GER_EL_AGK = what a tester commanded
const DID_ASW_GER_EL_AGK = [0x63, 0x1E];

function bytesToHex(b) { return (b || []).map((x) => hex(x)).join(' '); }

class DiagLink {
    constructor(signals, log) {
        this.signals = signals;
        this.log = log;
        this.diag = null;
        this.available = false;
        this.dme = DME;
        this._onAvailable = [];
    }

    /** fn(on) when the diagnostic link comes up or goes away (apps start at boot, often before it). */
    onAvailable(fn) { this._onAvailable.push(fn); }

    async init() {
        this.diag = await new Diag(this.signals, this.log).init();
        this.available = !!this.diag.available;
        this.diag.on('available', (on) => {
            this.available = !!on;
            this._onAvailable.forEach((fn) => { try { fn(this.available); } catch (e) { this.log.error(e); } });
        });
        return this;
    }

    /** Read a UDS 0x22 DID from the DME. Resolves {ok, data[]} or {ok:false, nrc}. */
    async readDid(did, timeoutMs, addr) {
        if (!this.available) return { ok: false, nrc: null, reason: 'no diagnostic link' };
        try {
            const reply = await this.diag.physical(addr || this.dme, 0x22, did, timeoutMs || 2000, replyTo(0x22, did));
            if (!reply || !reply.length) return { ok: false, nrc: null, reason: 'timeout' };
            if (reply[0] === 0x7F) return { ok: false, nrc: reply[2], reason: NRC[reply[2]] || ('NRC ' + hex(reply[2])) };
            // positive: 0x62 <did hi> <did lo> <data...>
            if (reply[0] === 0x62) return { ok: true, data: reply.slice(3) };
            return { ok: false, nrc: null, reason: 'unexpected ' + hex(reply[0]) };
        } catch (e) {
            return { ok: false, nrc: null, reason: String(e && e.message || e) };
        }
    }

    /**
     * Identify the DME (read-only). Returns an ident object the adapters match on:
     *   { present, sgbdIndex(hex string), vin, hw, sw }.
     * `present` is true only when the DME answered at least one identity read.
     */
    async identifyDme() {
        const ident = { present: false, address: this.dme, sgbdIndex: null, vin: null, hw: null, sw: null };
        if (!this.available) return ident;
        const sg = await this.readDid(DID_SGBD_INDEX);
        if (sg.ok) { ident.present = true; ident.sgbdIndex = bytesToHex(sg.data); }
        const vin = await this.readDid(DID_VIN);
        if (vin.ok) { ident.present = true; ident.vin = vin.data.map((c) => String.fromCharCode(c)).join('').replace(/[^\x20-\x7e]/g, ''); }
        const hw = await this.readDid(DID_HW);
        if (hw.ok) ident.hw = bytesToHex(hw.data);
        const sw = await this.readDid(DID_SW);
        if (sw.ok) ident.sw = bytesToHex(sw.data);
        // read-only capability probe: does this DME expose the electric flap (0x60FD)?
        const asw = await this.readDid(DID_ASW_EL_AGK);
        const asg = await this.readDid(DID_ASG_EL_AGK);
        // the units with a flap: the master, and a V8's second unit (each drives its bank's flap)
        const units = [];
        const probe = async (addr, el) => {
            const ger = (await this.readDid(DID_ASW_GER_EL_AGK, 1500, addr)).ok;
            if (addr !== this.dme && !el) el = (await this.readDid(DID_ASW_EL_AGK, 1500, addr)).ok || (await this.readDid(DID_ASG_EL_AGK, 1500, addr)).ok;
            if (el || ger) units.push({ addr: addr, el: !!el, ger: ger });
        };
        await probe(this.dme, asw.ok || asg.ok);
        ident.twin = TWIN.indexOf(String(ident.sgbdIndex || '').replace(/\s+/g, '').toUpperCase()) >= 0;
        if (ident.twin) await probe(DME2, false);
        this.flapUnits = units;
        ident.elAgk = {
            supported: units.length > 0,
            commandedPct: asw.ok && asw.data.length >= 2 ? ((asw.data[0] << 8) | asw.data[1]) / 100 : null,
            positionRaw: asg.ok ? bytesToHex(asg.data) : null,
            units: units.map((u) => hex(u.addr) + (u.el ? ' el' : '') + (u.ger ? ' ger' : '')),
        };
        this.log.info('DME ident: ' + JSON.stringify(ident));
        return ident;
    }

    /** Read the electric-flap state back (read-only). Returns {supported, commandedPct, positionRaw}. */
    async readElAgk() {
        const asw = await this.readDid(DID_ASW_EL_AGK);
        const asg = await this.readDid(DID_ASG_EL_AGK);
        return {
            supported: asw.ok || asg.ok,
            commandedPct: asw.ok && asw.data.length >= 2 ? ((asw.data[0] << 8) | asw.data[1]) / 100 : null,
            positionRaw: asg.ok ? bytesToHex(asg.data) : null,
        };
    }

    /**
     * Send one physical UDS request to the DME and return the parsed reply. This is
     * the ONE place a real actuation byte string would leave the app. It is only
     * called by an adapter that is BOTH matched and armed (see adapters.js); on its
     * own it just forwards bytes and reads the answer — it does not decide to send.
     */
    async sendToDme(sid, data, timeoutMs) { return this.sendTo(this.dme, sid, data, timeoutMs); }

    /** sendToDme to a given engine unit (a V8's second unit, 0x13, drives its own flap). */
    async sendTo(addr, sid, data, timeoutMs) {
        if (!this.available) return { ok: false, reason: 'no diagnostic link' };
        this.log.info('UDS -> ' + (addr === this.dme ? 'DME ' : 'DME ' + hex(addr) + ' ') + hex(sid) + ' ' + bytesToHex(data));
        const reply = await this.diag.physical(addr, sid, data, timeoutMs || 3000, replyTo(sid, data));
        if (!reply || !reply.length) return { ok: false, reason: 'timeout' };
        if (reply[0] === 0x7F) return { ok: false, nrc: reply[2], reason: NRC[reply[2]] || ('NRC ' + hex(reply[2])) };
        return { ok: true, sid: reply[0], data: reply.slice(1) };
    }
}

module.exports = { DiagLink, DME, DME2 };
