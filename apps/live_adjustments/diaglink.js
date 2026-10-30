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
const { Diag, hex, NRC } = require('./kit/diag');

const DME = 0x12;                 // DME engine (BMW diagnostic address)
const DME2 = 0x13;                // second DME on some engines, kept for future use

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
// MHD (the tuning flasher) leaves a tag in DME memory; MHD's own app reads it when it connects
// (ReadMemoryByAddress 0x23, format 0x24 = 2-byte size / 4-byte address, 0x807FF750, 16 bytes) and
// the DME answers "MHD2..." when it runs an MHD flash (capture from a1-mapping, idrive7-apps PR #23).
const MHD_TAG = [0x24, 0x80, 0x7F, 0xF7, 0x50, 0x00, 0x10];

function bytesToHex(b) { return (b || []).map((x) => hex(x)).join(' '); }

class DiagLink {
    constructor(signals, log) {
        this.signals = signals;
        this.log = log;
        this.diag = null;
        this.available = false;
        this.dme = DME;
    }

    async init() {
        this.diag = await new Diag(this.signals, this.log).init();
        this.available = !!this.diag.available;
        return this;
    }

    /** Read a UDS 0x22 DID from the DME. Resolves {ok, data[]} or {ok:false, nrc}. */
    async readDid(did, timeoutMs) {
        if (!this.available) return { ok: false, nrc: null, reason: 'no diagnostic link' };
        try {
            const reply = await this.diag.physical(this.dme, 0x22, did, timeoutMs || 2000);
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
        ident.elAgk = {
            supported: asw.ok || asg.ok,
            commandedPct: asw.ok && asw.data.length >= 2 ? ((asw.data[0] << 8) | asw.data[1]) / 100 : null,
            positionRaw: asg.ok ? bytesToHex(asg.data) : null,
        };
        ident.mhd = await this.readMhd();
        this.log.info('DME ident: ' + JSON.stringify(ident));
        return ident;
    }

    /** The unlock check (read-only): is the DME MHD-flashed? Returns {flashed, tag, reason}. */
    async readMhd() {
        if (!this.available) return { flashed: false, tag: null, reason: 'no diagnostic link' };
        try {
            const reply = await this.diag.physical(this.dme, 0x23, MHD_TAG, 2000);
            if (!reply || !reply.length) return { flashed: false, tag: null, reason: 'timeout' };
            if (reply[0] === 0x7F) return { flashed: false, tag: null, reason: NRC[reply[2]] || ('NRC ' + hex(reply[2])) };
            if (reply[0] !== 0x63) return { flashed: false, tag: null, reason: 'unexpected ' + hex(reply[0]) };
            const text = String.fromCharCode.apply(null, reply.slice(1));
            const tag = (/^[\x20-\x7e]*/.exec(text) || [''])[0];
            return { flashed: /^MHD/.test(tag), tag: tag || null, reason: /^MHD/.test(tag) ? 'MHD flash' : 'no MHD tag' };
        } catch (e) {
            return { flashed: false, tag: null, reason: String(e && e.message || e) };
        }
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
    async sendToDme(sid, data, timeoutMs) {
        if (!this.available) return { ok: false, reason: 'no diagnostic link' };
        this.log.info('UDS -> DME ' + hex(sid) + ' ' + bytesToHex(data));
        const reply = await this.diag.physical(this.dme, sid, data, timeoutMs || 3000);
        if (!reply || !reply.length) return { ok: false, reason: 'timeout' };
        if (reply[0] === 0x7F) return { ok: false, nrc: reply[2], reason: NRC[reply[2]] || ('NRC ' + hex(reply[2])) };
        return { ok: true, sid: reply[0], data: reply.slice(1) };
    }
}

module.exports = { DiagLink, DME, DME2 };
