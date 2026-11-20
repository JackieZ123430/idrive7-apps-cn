'use strict';
/**
 * xdrive.js - EXPERIMENTAL: xDrive off (rear-wheel drive) until the next ignition cycle, over
 * the DSC's own diagnostic job LMV_FUNKTION (issue #28). Ships Off: the "xDrive (experimental)"
 * setting must be switched on, and then the xDrive tab appears. Off sends nothing at all.
 *
 * Research (ezl0l on issue #28, gist f5bd3677df04950ac232a1b50b6051f6, and IterioDev on a 2023
 * 230i xDrive): DSC, diagnostic address 0x29, DID 0xDBE1 = LMV_FUNKTION, "activation of the
 * longitudinal torque distribution for the current terminal-15 cycle", 1 = on, 0 = off.
 *   read  : 22 DB E1      -> 62 DB E1 01 | 00
 *   write : 2E DB E1 00   -> 6E DB E1         (xDrive off)
 * The DSC accepts the write only with the ignition on, the engine OFF, selector in P, parking
 * brake applied and the car stationary; with the engine running it answers an NRC. After the
 * engine is started in the SAME ignition cycle DBE1 stays 0 and the cluster shows an
 * informational all-wheel-drive notice. A full ignition cycle (terminal 15 off and on) brings
 * xDrive back - so the app sends no "on" command at all: DBE1 = 01 has no tested basis on G
 * cars and the known re-enable elsewhere is a DSC reset, which this app will not send.
 * The same job (DBE1, "current terminal-15 cycle") is in BMW's DSC_G20 and DSC_G30N descriptions,
 * so it is tried on every G car whose DSC answers the read. A DSC that answers the write with
 * "not in this session" (NRC 7E / 7F) gets 10 03 (extended session) and the same write once more.
 * The DBE1 path is for the DSC variants the research names: DSC_G20, DSC_G30N, DSC_G11, DSC_I1
 * and IB_G2X (and any unidentified DSC that answers the read, as before). Other units at 0x29 with
 * a G VIP (0x39, VIP_G05 / VIP_G30N) take the VIP path instead: VIP job STEUERN_LMV_FUNKTION_QDM,
 *   write : 2E DB 2F 00   -> 6E DB 2F         (xDrive off, VIP)
 *   read  : 22 DB 44      -> 62 DB 44 01 | 00 (STATUS_LMV_FUNKTION_QDM, logged only)
 * sent with the engine running / the car READY, stationary in P; on an ICE G05 (VIP 0F2520) with the
 * engine OFF and the ignition on instead (VIP_ENGINE_OFF: running, it answers NRC 33; the G05 xDrive45e, also
 * VIP 0F2520, took it that way too in diagnostic mode, issue #52). Issue #52: the G05 xDrive45e has
 * IB_G05 (0F2500) at 0x29 - it took 2E DB E1 00 with the ignition on but nothing changed, and
 * DBE1 read 0 even in stock AWD - so it goes the VIP way. DB44 read 0 in both modes on the G22, so
 * on this path the mode is not derived from it: the front-axle torque shows the effect.
 * Hybrids: VehicleCondition (10 = drive-ready) counts as running for reading the mode and torque,
 * also in electric driving. The DBE1 write needs the ignition on (state 7 or READY; with only the
 * infotainment on, state 5 WOHNEN, the DSC answers NRC 33) and the engine stopped; READY with the
 * engine stopped is allowed (0.7.1 behaviour, the G30 530e took the write that way).
 * With the engine off DBE1 reads 0 anyway, so the state is shown only with the engine running.
 *
 * Front-axle torque, to see the effect while driving (read only, engine running, tab shown):
 * LMV (transfer case), diagnostic address 0x19, DID 0xDB32 LMV_MOMENT:
 *   22 DB 32 -> 62 DB 32 <actual s16> <qualifier u16> <requested s16> <qualifier u16>, Nm = raw / 4
 * (BMW's LMV_G11 description; matches ezl0l's logs: 00 9E .. 00 98 = 39.5 / 38.0 Nm).
 *
 * Transfer case variant (read only, once, on cars whose DSC answered DBE1): LMV 0x19, 22 F1 50
 * (SGBD index). Known G-series LMV units: 0F2180 (991616) LMV-G-Series, ATC13, MPC5643L, and
 * 0F29E0 (993760) LMV-G-Series, ATC13_2, TC233L. Shown on the tab so a report says which unit the
 * car has. Nothing is coded or flashed: a permanent xDrive off would mean rewriting the LMV's
 * signed coding records (0x3000..) or flashing it, which this app will not do.
 *
 * Tested by others on a G22 M440i (DSC_G20, SGBD index 0F2510) and a G42 230i. Front-axle torque
 * dropped to 0 in their logs; ABS / DSC behaviour in motion was not measured. Experimental.
 *
 * Measured on a G01 X3 M40i LCI 2022 (DSC_G30N, SGBD index 0F2850; LMV 0F29E0), two closed-area
 * drives with DB32 logged every 250 ms (issue #28 / #63 follow-up):
 *   - the DSC took 2E DB E1 00 with the ENGINE RUNNING (692 rpm, P, parking brake, stationary)
 *     -> 6E DB E1; front-axle torque -1.75..-2.5 Nm on every launch after it (to 66 km/h, D and
 *     R; 256..433 Nm on the same launches before). So on this variant the engine need not be
 *     stopped: ENGINE_RUNNING_OK lists it and the "Engine off" check is left out there.
 *   - 2E DB E1 01 -> 6E DB E1 brings xDrive back at once, no ignition cycle: the next launch
 *     showed 433 Nm in front. ON_INDEX lists the variants where this was measured; only those get
 *     the "xDrive on" button (the same write with 01, the same checks and double press).
 *   - the transfer case reports the state itself: the requested-torque qualifier in DB32 (bytes
 *     7-8, last byte also in DB31) reads 0x20 / 0x21 while LMV is active and 0xE8 after the OFF
 *     write - the same two values are in ezl0l's G22 samples (.. 00 20 in AWD, .. 00 E8 off).
 *     (qualifier & 0xC0) === 0xC0 -> xDrive off. It answers with the engine off too, so the mode
 *     comes from the LMV whenever DB32 was read, and DBE1 only when it was not.
 *   - DBE1 on 0F2850 reads 01 in AWD with the engine off as well, 00 after the write.
 *   - while off the DSC stores DTC 480724 (LMV function unavailable, sub-function inactive);
 *     after the ON write it stays as a historic entry.
 *   - the DSC also took the OFF write in D during an auto start/stop engine stop (parking brake
 *     off): "P + parking brake" is this app's gate, the DSC does not check it. Kept.
 */

const DSC = 0x29;                       // DSC (BMW diagnostic address)
const LMV = 0x19;                       // transfer case (BMW diagnostic address)
const DID_TORQUE = [0xDB, 0x32];        // LMV_MOMENT: front-axle torque actual / requested
const DID_SGBD_INDEX = [0xF1, 0x50];
const DID_LMV = [0xDB, 0xE1];           // LMV_FUNKTION
const VIP = 0x39;                       // VIP (BMW diagnostic address)
const DID_VIP_LMV = [0xDB, 0x2F];       // VIP STEUERN_LMV_FUNKTION_QDM (write)
const DID_VIP_STATUS = [0xDB, 0x44];    // VIP STATUS_LMV_FUNKTION_QDM (read)
const TESTED_INDEX = ['0F2510', '0F2850'];   // DSC_G20 (ezl0l's G22), DSC_G30N (G01 X3 M40i, see the header)
const ENGINE_RUNNING_OK = ['0F2850'];   // DSC variants measured to take the DBE1 write with the engine running
const ON_INDEX = ['0F2850'];            // DSC variants where 2E DB E1 01 was measured to bring xDrive back at once
const DTC_LMV_OFF = '480724';           // the DSC's "LMV function unavailable" entry, stored while xDrive is off
const LMV_OFF_MASK = 0xC0;              // DB32 requested-torque qualifier: 0x20/0x21 active, 0xE8 switched off
const DBE1_UNITS = {                    // units at 0x29 that take the DBE1 write, by SGBD index
    '0F1970': 'DSC_I1', '0F1C50': 'DSC_I1', '0F1CE0': 'DSC_I1', '0F2100': 'DSC_G11',
    '0F2510': 'DSC_G20', '0F2850': 'DSC_G30N', '0F2CE0': 'IB_G2X',
};
const OTHER_UNITS = { '0F2500': 'IB_G05', '0F29F0': 'IB_I20', '0F2E70': 'IB_G70' };
const VIP_UNITS = { '0F2520': 'VIP_G05', '0F2530': 'VIP_G05', '0F2860': 'VIP_G30N' };
// VIPs that take the job with the engine stopped and the ignition on (as the DSC's DBE1), and answer NRC 33 while
// it runs: 0F2520 on an ICE G05 (diesel X5, IB_G05 0F2500, LMV 0F2180), measured: engine running 7F 2E 33 every
// time; engine off, ignition on (state 7), P, stationary: accepted, xDrive to RWD, front-axle torque ~0, back
// after an ignition cycle. The G05 xDrive45e has the same VIP (0F2520) and took it the same way (issue #52)
const VIP_ENGINE_OFF = ['0F2520'];
const LMV_VARIANTS = {                  // G-series transfer cases by SGBD index
    '0F2180': 'LMV-G ATC13',
    '0F29E0': 'LMV-G ATC13_2',
};
const ENGINE_OFF_RPM = 50;              // below this the engine counts as stopped
const ENGINE_ON_RPM = 400;              // above this it runs (the DSC reports the mode then)
const POLL_MS = 4000;                   // DBE1 read while the tab is shown
const TORQUE_MS = 1000;                 // front-axle torque read while the tab is shown and the engine runs
const MOVING_KMH = 3;                   // the peak counts only while moving
const READY = 10, READY_START = 8;      // VehicleCondition: FAHREN (drive-ready), FAHRBEREITSCHAFT_HERSTELLEN
const IGNITION = 7;                     // VehicleCondition: PRUEFEN_ANALYSE_DIAGNOSE (ignition on, not ready)
const CONFIRM_MS = 6000;                // the second press must come within this
const SESSION_NRC = [0x7E, 0x7F];       // "not in this session": retry once in the extended session
const TRACE_MS = 60000;
const CONDITION_NAMES = {
    1: 'PARKEN_BN_NIO', 2: 'PARKEN_BN_IO', 3: 'STANDFUNKTIONEN_KUNDE_NICHT_IM_FZG',
    5: 'WOHNEN', 7: 'PRUEFEN_ANALYSE_DIAGNOSE', 8: 'FAHRBEREITSCHAFT_HERSTELLEN',
    10: 'FAHREN', 12: 'FAHRBEREITSCHAFT_BEENDEN',
};
const NRC_NAMES = {
    0x10: 'generalReject', 0x11: 'serviceNotSupported', 0x12: 'subFunctionNotSupported',
    0x13: 'incorrectMessageLengthOrInvalidFormat', 0x21: 'busyRepeatRequest',
    0x22: 'conditionsNotCorrect', 0x24: 'requestSequenceError', 0x25: 'noResponseFromSubnetComponent',
    0x26: 'failurePreventsExecutionOfRequestedAction', 0x31: 'requestOutOfRange',
    0x33: 'securityAccessDenied', 0x35: 'invalidKey', 0x36: 'exceedNumberOfAttempts',
    0x37: 'requiredTimeDelayNotExpired', 0x72: 'generalProgrammingFailure',
    0x78: 'requestCorrectlyReceivedResponsePending', 0x7E: 'subFunctionNotSupportedInActiveSession',
    0x7F: 'serviceNotSupportedInActiveSession', 0x81: 'rpmTooHigh', 0x82: 'rpmTooLow',
    0x83: 'engineIsRunning', 0x84: 'engineIsNotRunning', 0x88: 'vehicleSpeedTooHigh',
    0x89: 'vehicleSpeedTooLow', 0x8F: 'brakeSwitchNotClosed', 0x90: 'shifterLeverNotInPark',
    0x92: 'voltageTooHigh', 0x93: 'voltageTooLow',
};

const hex2 = (b) => b.toString(16).padStart(2, '0').toUpperCase();
const bytesHex = (data) => data == null ? null : Array.from(data, hex2).join(' ');
const sgbdIndex = (data) => data.map(hex2).join('').replace(/^0+(?=.{6})/, '');
const NRC_TEXT = {
    0x22: 'conditions not met · ignition on, engine off, P, parking brake on, car stationary',
    0x31: 'not supported by this DSC',
    // NRC 33 with the conditions met: on a G26 (DSC_G20 0F2510) and a G20 330e the write went through only in
    // diagnostic mode (Start pressed three times without the brake; issues #63, #52)
    0x33: 'refused (security access) · try diagnostic mode: press Start 3 times without the brake, then again',
    0x7E: 'not allowed even in the extended diagnostic session',
    0x7F: 'not allowed even in the extended diagnostic session',
    0x13: 'not supported by this DSC',
};

class XDriveControl {
    /** car: { data() -> { rpm, speed, stage, demo } } (kit/car.js) */
    constructor(ctx, car, now) {
        this.ctx = ctx;
        this.car = car;
        this.log = ctx.log;
        this.now = now || (() => Date.now());
        this.link = null;
        this._attemptSequence = 0;
        this._exchangeSequence = 0;
        this._attemptId = null;
        this._traceUntil = 0;
        this.requested = false;         // this app had the write accepted (until xDrive reads back 1)
        this._reset();
    }

    _reset() {
        this.index = null;              // DSC SGBD index, hex like '0F2510'
        this.lmvIndex = null;           // transfer case (LMV) SGBD index, hex like '0F2180'
        this.path = 'dsc';              // 'dsc': DBE1 write to the DSC; 'vip': DB2F write to the VIP
        this.vipIndex = null;           // VIP SGBD index on the VIP path
        this.vipStatus = null;          // last VIP DB44 value (logged, not shown as the mode)
        this.supported = null;          // true: DBE1 answered; false: the DSC refused the read
        this.lmv = null;                // last DBE1 value 0 | 1
        this.lmvRunning = false;        // DBE1 was read with the engine running (only then it means anything)
        this.lastRead = 0;
        this.torque = null;             // { actual, requested } Nm, last LMV read
        this.lmvState = null;           // 'on' | 'off' from the DB32 requested-torque qualifier (the LMV itself)
        this.torqueOk = null;           // false: the LMV refused the read (stop asking)
        this.peakRequested = null;      // highest requested front torque seen while moving
        this.lastTorque = 0;
        this.reading = false;
        this.busy = false;
        this.confirmUntil = 0;
        this.confirmWhat = null;        // 'off' | 'on': the button the first press came from
        this.note = null;
        this.noteType = 'dim';
        this._readEvidence = {};
    }

    get enabled() { return this.ctx.settings.get('xdrive') === 'on'; }

    async start(link) {
        this.link = link;
        await this.refresh();
    }

    /** The setting changed or the link came up: identify the DSC and read DBE1 (reads only). */
    async refresh() {
        this._reset();
        if (!this.enabled) return;
        if (!this._linkUp()) { this.note = 'Waiting for the diagnostic link'; this.noteType = 'warn'; return; }
        const sg = await this._read(DID_SGBD_INDEX);
        if (sg.ok) this.index = sgbdIndex(sg.data);
        // an identified unit outside the DBE1 list, with a G VIP: the VIP path
        if (this.index && !DBE1_UNITS[this.index]) {
            const vp = await this._read(DID_SGBD_INDEX, VIP);
            if (vp.ok && VIP_UNITS[sgbdIndex(vp.data)]) { this.path = 'vip'; this.vipIndex = sgbdIndex(vp.data); }
        }
        if (this.path === 'vip') { this.supported = true; await this._readVip(); }
        else await this._readLmv();
        if (this.supported === true) {
            const lv = await this._read(DID_SGBD_INDEX, LMV);
            if (lv.ok) this.lmvIndex = sgbdIndex(lv.data);
        }
        this.log.info('xdrive: DSC ' + (this.index || '?') + (this.unitName() ? ' (' + this.unitName() + ')' : '')
            + (this.path === 'vip' ? ' path VIP ' + this.vipIndex + ' DB44 ' + this.vipStatus
                : ' DBE1 ' + (this.supported === false ? 'refused' : this.lmv))
            + (this.lmvIndex ? ' LMV ' + this.lmvIndex : ''));
        this._diagnostic('identified');
    }

    unitName() { return this.index ? DBE1_UNITS[this.index] || OTHER_UNITS[this.index] || null : null; }

    _snapshot() {
        const d = this._live(), now = this.now();
        const value = (v) => v == null ? null : v;
        const reads = {};
        Object.keys(this._readEvidence).forEach((key) => {
            const r = this._readEvidence[key];
            reads[key] = Object.assign({}, r, { ageMs: Math.max(0, now - r.atMs) });
        });
        return {
            appVersion: this.ctx.spec && this.ctx.spec.version || null,
            enabled: this.enabled, linkAvailable: this._linkUp(),
            path: this.path, target: hex2(this.path === 'vip' ? VIP : DSC),
            dscIndex: this.index, dscUnit: this.unitName(), vipIndex: this.vipIndex, lmvIndex: this.lmvIndex,
            supported: this.supported,
            vehicle: {
                source: d.demo ? 'demo' : 'car',
                rpm: value(d.rpm), speedKmh: value(d.speed),
                selector: ['P', 'R', 'N', 'D'].indexOf(d.stage) >= 0 ? d.stage : null,
                condition: value(d.condition),
                conditionName: CONDITION_NAMES[d.condition] || 'unknown',
                signalFreshness: 'unknown: Car.data() provides no per-signal timestamps',
                parkingBrake: { status: 'unknown', reason: 'not read by this app' },
            },
            checks: this.checks().map((c) => ({
                label: c.label,
                status: c.ok === true ? 'satisfied' : c.ok === false ? 'not_satisfied' : 'unknown',
            })),
            reads,
            acceptedRequestTracked: this.requested,
            physicalClutchState: 'not_measured',
            lmvState: this.lmvState,
        };
    }

    _diagnostic(event, details) {
        this.log.info('xdrive-diagnostic ' + JSON.stringify(Object.assign({
            schema: 1, event, atMs: this.now(), attemptId: this._attemptId,
            snapshot: this._snapshot(),
        }, details)));
    }

    async _exchange(ecu, sid, data, timeoutMs, accept) {
        const id = ++this._exchangeSequence, started = this.now();
        const attemptId = started <= this._traceUntil ? this._attemptId : null;
        const request = bytesHex([sid].concat(data));
        const identifying = sid === 0x22 && data[0] === 0xF1 && data[1] === 0x50;
        const trace = sid !== 0x22 || identifying || attemptId !== null;
        const details = { exchangeId: id, attemptId, target: hex2(ecu), request, timeoutMs };
        if (sid !== 0x22) this._diagnostic('uds_request', details);
        let response;
        try {
            response = await this.link.diag.physical(ecu, sid, data, timeoutMs, accept);
        } catch (e) {
            if (sid === 0x22) {
                this._readEvidence[hex2(ecu) + ':' + bytesHex(data)] = {
                    atMs: this.now(), status: 'transport_error', response: null,
                };
            }
            this._diagnostic('uds_result', Object.assign({}, details, {
                status: 'transport_error', response: null, elapsedMs: Math.max(0, this.now() - started),
                error: String(e && e.message || e),
            }));
            throw e;
        }
        let status, nrc = null;
        if (!response || !response.length) status = 'no_response';
        else if (response[0] === 0x7F && response.length === 3 && response[1] === sid) {
            nrc = response[2];
            status = nrc === 0x78 ? 'response_pending' : 'negative_response';
        } else if (response[0] === sid + 0x40
            && response[1] === data[0] && (sid === 0x10 ? response.length >= 2
                : response[2] === data[1] && response.length >= (sid === 0x22 ? 4 : 3))) status = 'positive_response';
        else status = 'unexpected_response';
        const result = {
            status, response: bytesHex(response), elapsedMs: Math.max(0, this.now() - started),
            nrc: nrc === null ? null : { hex: hex2(nrc), name: NRC_NAMES[nrc] || 'unknownNrc' },
        };
        if (sid === 0x22) {
            this._readEvidence[hex2(ecu) + ':' + bytesHex(data)] = {
                atMs: this.now(), status, response: result.response,
            };
        }
        if (trace || status !== 'positive_response') {
            this._diagnostic('uds_result', Object.assign({}, details, result));
        }
        return response;
    }

    /** VIP path: DB44 now and then, logged when it changes (it is not the mode, see the header). */
    async _readVip() {
        this.lastRead = this.now();
        const r = await this._read(DID_VIP_STATUS, VIP);
        const v = r.ok && r.data.length ? (r.data[0] ? 1 : 0) : r.nrc != null ? 'NRC ' + hex2(r.nrc) : null;
        if (v !== null && v !== this.vipStatus) {
            const d = this._live();
            this.log.info('xdrive: VIP DB44 ' + v + ' rpm ' + d.rpm + ' condition ' + d.condition);
        }
        if (v !== null) this.vipStatus = v;
    }

    /** Called with each frame while the xDrive tab is shown: reads DBE1 now and then, and the
     * front-axle torque every second while the engine runs. One round of reads at a time. */
    tick() {
        if (!this.enabled || this.busy || this.reading || this.supported === false || !this._linkUp()) return null;
        const jobs = [];
        if (this.now() - this.lastRead >= POLL_MS) jobs.push(this.path === 'vip' ? this._readVip() : this._readLmv());
        if (this.supported === true && this.torqueOk !== false && this.now() - this.lastTorque >= TORQUE_MS) {
            jobs.push(this._readTorque());
        }
        if (!jobs.length) return null;
        this.reading = true;
        const done = () => { this.reading = false; };          // (no Promise.finally on the car's Node 8)
        return Promise.all(jobs).then((v) => { done(); return v; }, (e) => { done(); throw e; });
    }

    _linkUp() { return !!(this.link && this.link.available && this.link.diag); }

    async _read(did, ecu) {
        try {
            const r = await this._exchange(ecu || DSC, 0x22, did, 2500,
                (u) => (u[0] === 0x62 && u[1] === did[0] && u[2] === did[1]) || (u[0] === 0x7F && u[1] === 0x22));
            if (!r || !r.length) return { ok: false, nrc: null };
            if (r[0] === 0x7F) return { ok: false, nrc: r[2] };
            return { ok: true, data: r.slice(3) };
        } catch (e) {
            return { ok: false, nrc: null, error: String(e && e.message || e) };
        }
    }

    async _readLmv() {
        this.lastRead = this.now();
        const running = this.engineRunning();
        const r = await this._read(DID_LMV);
        if (r.ok && r.data.length) {
            this.supported = true;
            const v = r.data[0] ? 1 : 0;
            if (v !== this.lmv || running !== this.lmvRunning) {
                const d = this._live();
                this.log.info('xdrive: DBE1 ' + v + (running ? ' (running/READY)' : ' (engine off)') + ' rpm ' + d.rpm + ' condition ' + d.condition);
            }
            this.lmv = v;
            this.lmvRunning = running;
            if (running && this.lmv === 1) this.requested = false;     // xDrive is back (ignition cycled)
        } else if (r.nrc != null) {
            this.supported = false;
            this.note = 'The DSC does not offer LMV_FUNKTION (' + (NRC_TEXT[r.nrc] || 'NRC ' + hex2(r.nrc)) + ')';
            this.noteType = 'warn';
        }
    }

    async _readTorque() {
        this.lastTorque = this.now();
        const r = await this._read(DID_TORQUE, LMV);
        if (r.ok && r.data.length >= 8) {
            const s16 = (i) => ((r.data[i] << 8 | r.data[i + 1]) << 16 >> 16) / 4;
            this.torqueOk = true;
            this.torque = { actual: s16(0), requested: s16(4) };
            const d = this._live();
            if (!d.demo && d.speed !== null && d.speed >= MOVING_KMH) {
                this.peakRequested = Math.max(this.peakRequested === null ? -Infinity : this.peakRequested, this.torque.requested);
            }
            // the requested-torque qualifier is the transfer case's own word on the mode
            const q = r.data[6] << 8 | r.data[7];
            const state = (q & LMV_OFF_MASK) === LMV_OFF_MASK ? 'off' : 'on';
            if (state !== this.lmvState) {
                this.log.info('xdrive: LMV DB32 qualifier ' + hex2(r.data[6]) + hex2(r.data[7]) + ' -> xDrive ' + state
                    + ' rpm ' + d.rpm + ' condition ' + d.condition);
            }
            this.lmvState = state;
            if (state === 'on') this.requested = false;         // xDrive is back (ON write or ignition cycle)
        } else if (r.nrc != null && this.engineRunning()) {
            this.torqueOk = false;                             // asked with the engine running and refused: left alone
            this.torque = null;
            this.lmvState = null;
        }
    }

    /** Live vehicle values; demo data never counts. */
    _live() {
        const d = (this.car && this.car.data()) || {};
        if (d.demo) return { demo: true };
        const num = (x) => (typeof x === 'number' && isFinite(x) ? x : null);
        return { demo: false, rpm: num(d.rpm), speed: num(d.speed), stage: d.stage, condition: num(d.condition) };
    }
    /** Drive-ready (READY): a hybrid can be ready with the engine stopped. Unknown without the signal. */
    driveReady() { const d = this._live(); return !d.demo && d.condition !== null ? d.condition === READY || d.condition === READY_START : null; }
    /** The engine runs, or the car is drive-ready (the DSC reports the mode then). */
    engineRunning() { const d = this._live(); return !d.demo && ((d.rpm !== null && d.rpm > ENGINE_ON_RPM) || this.driveReady() === true); }

    /** The conditions the DSC wants, as far as the head unit can see them. ok: true / false / null (cannot tell). */
    checks() {
        const d = this._live();
        if (this.vipEngineOff()) {
            // VIP 0F2520 (ICE G05): the job is taken with the engine off, the ignition on, in P, stationary;
            // the engine running gets NRC 33. The DSC path's engine-off checks.
            return [
                { label: 'Live car data', ok: !d.demo },
                { label: 'Ignition on', ok: d.demo ? false : d.condition === IGNITION || this.driveReady() === true },
                { label: 'Engine off', ok: d.demo ? false : d.condition === IGNITION ? true : d.rpm === null ? false : d.rpm < ENGINE_OFF_RPM },
                { label: 'Stationary', ok: d.demo ? false : d.speed === null ? false : d.speed < 0.5 },
                { label: 'Selector in P', ok: d.demo ? false : d.stage === 'P' ? true : d.stage ? false : null },
                { label: 'Parking brake on', ok: null },
            ];
        }
        if (this.path === 'vip') {
            // the VIP job is sent with the engine running / the car READY, stationary in P
            return [
                { label: 'Live car data', ok: !d.demo },
                { label: 'Engine running or READY', ok: d.demo ? false : this.engineRunning() },
                { label: 'Stationary', ok: d.demo ? false : d.speed === null ? false : d.speed < 0.5 },
                { label: 'Selector in P', ok: d.demo ? false : d.stage === 'P' ? true : d.stage ? false : null },
                { label: 'Parking brake on', ok: null },
            ];
        }
        return [
            { label: 'Live car data', ok: !d.demo },
        ].concat(this.engineMayRun() ? [] : [
            // ignition on and not READY (state 7): the engine cannot run, whatever the rpm signal
            // still says - it stays above 50 for minutes after switching off on some cars (issue #28)
            { label: 'Engine off', ok: d.demo ? false : d.condition === IGNITION ? true : d.rpm === null ? false : d.rpm < ENGINE_OFF_RPM },
        ]).concat([
            // the DSC wants terminal 15: with the infotainment alone on (WOHNEN) it answers NRC 33;
            // the engine running (READY) counts as the ignition on
            { label: 'Ignition on', ok: d.demo ? false : d.condition === null ? (this.engineMayRun() && this.engineRunning() ? true : null)
                : d.condition === IGNITION || this.driveReady() === true },
            { label: 'Stationary', ok: d.demo ? false : d.speed === null ? false : d.speed < 0.5 },
            { label: 'Selector in P', ok: d.demo ? false : d.stage === 'P' ? true : d.stage ? false : null },
            { label: 'Parking brake on', ok: null },
        ]);
    }

    /** The VIP takes the job with the engine off and the ignition on (VIP_ENGINE_OFF: the ICE G05's 0F2520). */
    vipEngineOff() { return this.path === 'vip' && VIP_ENGINE_OFF.indexOf(this.vipIndex) >= 0; }
    /** The DSC variant was measured to take the DBE1 write with the engine running (G01, 0F2850). */
    engineMayRun() { return this.path === 'dsc' && !!this.index && ENGINE_RUNNING_OK.indexOf(this.index) >= 0; }
    /** The DSC variant was measured to bring xDrive back on 2E DB E1 01: the "xDrive on" button is offered. */
    onAvailable() { return this.path === 'dsc' && !!this.index && ON_INDEX.indexOf(this.index) >= 0; }

    /** Why a press would not send, or null when it may. */
    blocker() {
        if (!this.enabled) return 'Switch on xDrive (experimental) in Settings';
        if (this.busy) return 'Busy';
        if (!this._linkUp()) return 'Waiting for the diagnostic link';
        if (this.supported !== true) return this.supported === false ? 'Not available on this car' : 'DSC not answering yet';
        const bad = this.checks().find((c) => c.ok === false);
        return bad ? (bad.label === 'Live car data' ? 'No live car data' : 'Needs: ' + bad.label.toLowerCase().replace('ready', 'READY')) : null;
    }

    /** "xDrive off": the first press asks, the second (within CONFIRM_MS) sends the one write. */
    requestOff() { return this._request('off'); }

    /** "xDrive on" (2E DB E1 01): only on the variants where it was measured to work (ON_INDEX);
     * the same checks and the same double press. Nowhere else: an "on" that does nothing would
     * only mislead, and a DSC reset is not something this app sends. */
    requestOn() {
        if (!this.onAvailable()) {
            this.note = 'xDrive on is not offered on this DSC · it returns after an ignition cycle'; this.noteType = 'warn';
            this._diagnostic('blocked', { reason: 'xDrive on not offered on this variant' });
            return Promise.resolve();
        }
        return this._request('on');
    }

    async _request(what) {
        const on = what === 'on';
        if (this.busy) { this._diagnostic('blocked', { reason: 'Busy' }); return; }
        const why = this.blocker();
        if (why) {
            this.confirmUntil = 0; this.note = why; this.noteType = 'warn';
            this._diagnostic('blocked', { reason: why });
            return;
        }
        if (this.now() > this.confirmUntil || this.confirmWhat !== what) {
            this._attemptId = this.now() + '-' + (++this._attemptSequence);
            this._traceUntil = this.now() + TRACE_MS;
            this.confirmUntil = this.now() + CONFIRM_MS;
            this.confirmWhat = what;
            this.note = on ? 'Press again to switch xDrive back on'
                : 'Press again to switch xDrive off' + (this.onAvailable() ? '' : ' until the ignition is switched off');
            this.noteType = 'warn';
            this._diagnostic('confirmation_required', { command: what });
            return;
        }
        this.confirmUntil = 0;
        this.confirmWhat = null;
        this.busy = true;
        const vip = this.path === 'vip';
        const name = vip ? 'VIP' : 'DSC', ecu = vip ? VIP : DSC;
        this.note = 'Sending to the ' + name + '…'; this.noteType = 'dim';
        try {
            let r = await this._write(on);
            // Some software versions take the write only in the extended diagnostic session:
            // open it (10 03) and send the same write once more. Nothing else is sent.
            if (r && r[0] === 0x7F && SESSION_NRC.indexOf(r[2]) >= 0) {
                this.log.info('UDS -> ' + name + ' 10 03 (extended session, the ' + name + ' asked for it)');
                const ses = await this._exchange(ecu, 0x10, [0x03], 3000,
                    (u) => (u[0] === 0x50 && u[1] === 0x03) || (u[0] === 0x7F && u[1] === 0x10));
                this.log.info('UDS <- ' + name + ' ' + (ses ? ses.map(hex2).join(' ') : 'no answer'));
                if (ses && ses[0] === 0x50) r = await this._write(on);
                else r = ses && ses[0] === 0x7F ? ['session', ses[2]] : ['session', null];
            }
            if (r && r[0] === 0x6E) {
                this.requested = !on;
                // the transfer case says at once whether it took effect (DB32 qualifier), engine on or off
                if (!vip && this.torqueOk !== false) { try { await this._readTorque(); } catch (e) { /* the read is retried by tick() */ } }
                const verified = this.lmvState !== null && this.lmvState === (on ? 'on' : 'off');
                this._diagnostic('command_accepted', { command: what, physicalEffect: verified ? 'verified_by_lmv' : 'not_verified' });
                this.note = on ? (verified ? 'xDrive is back · the transfer case reports it on' : 'Accepted by the DSC')
                        + ' · DTC ' + DTC_LMV_OFF + ' stays stored in the DSC as a historic entry'
                    : vip && this.vipEngineOff() ? 'Accepted by the VIP · start the engine without switching the ignition off'
                    : vip ? 'Accepted by the VIP · drive without switching off and watch the front-axle torque'
                    : verified ? 'xDrive off · the transfer case reports it · drive without switching the ignition off'
                    : this.engineRunning() ? 'Accepted by the DSC · drive without switching the ignition off'
                        : 'Accepted by the DSC · start the engine without switching the ignition off';
                this.noteType = 'go';
            } else if (r && r[0] === 'session') {
                this._diagnostic('command_not_accepted', { command: what, reason: 'extended_session_not_accepted' });
                this.note = name + ' refused the extended diagnostic session' + (r[1] != null ? ' (NRC ' + hex2(r[1]) + ')' : ' (no answer)');
                this.noteType = 'warn';
            } else if (r && r[0] === 0x7F) {
                this._diagnostic('command_not_accepted', { command: what, reason: 'ecu_negative_response' });
                // a VIP that wants a security unlock (G05 xDrive45e, issue #52): this app does no security access
                // VIP 0F2520 (ICE G05): NRC 33 means the engine runs - it takes the job with the engine off
                this.note = name + ' refused: ' + (vip && r[2] === 0x33 && this.vipEngineOff() ? 'the engine is running · switch it off, keep the ignition on, then try again'
                    : vip && r[2] === 0x33 ? 'security access · try diagnostic mode (Start 3 times, no brake); else this VIP needs an unlock'
                    : NRC_TEXT[r[2]] || 'NRC ' + hex2(r[2]));
                this.noteType = 'warn';
            } else {
                this._diagnostic('command_not_accepted', { command: what, reason: 'no_matching_positive_response' });
                this.note = 'No answer from the ' + name;
                this.noteType = 'warn';
            }
        } catch (e) {
            this.note = String(e && e.message || e);
            this.noteType = 'warn';
            this.log.warn('xdrive: ' + this.note);
        } finally {
            this.busy = false;
            this.lastRead = 0;              // read DBE1 again on the next frame
            this.lastTorque = 0;            // and the transfer case
        }
    }

    async _write(on) {
        const vip = this.path === 'vip';
        const name = vip ? 'VIP' : 'DSC', did = vip ? DID_VIP_LMV : DID_LMV, value = on ? 0x01 : 0x00;
        this.log.info('UDS -> ' + name + ' 2E ' + did.map(hex2).join(' ') + ' ' + hex2(value) + ' (xDrive ' + (on ? 'on' : 'off') + ', experimental)');
        const r = await this._exchange(vip ? VIP : DSC, 0x2E, did.concat([value]), 3000,
            (u) => (u[0] === 0x6E && u[1] === did[0] && u[2] === did[1]) || (u[0] === 0x7F && u[1] === 0x2E));
        this.log.info('UDS <- ' + name + ' ' + (r ? r.map(hex2).join(' ') : 'no answer'));
        return r;
    }

    /** What the screen shows: mode 'AWD' | 'RWD' | 'REQUESTED' | 'UNKNOWN'. */
    view() {
        const running = this.engineRunning();
        let mode = 'UNKNOWN', modeFrom = null;
        if (this.lmvState !== null) { mode = this.lmvState === 'off' ? 'RWD' : 'AWD'; modeFrom = 'lmv'; }
        else if (this.path === 'dsc' && running && this.lmvRunning && this.lmv !== null) { mode = this.lmv ? 'AWD' : 'RWD'; modeFrom = 'dsc'; }
        else if (this.requested) mode = 'REQUESTED';
        return {
            enabled: this.enabled,
            mode,
            modeFrom,
            onAvailable: this.onAvailable(),
            engineMayRun: this.engineMayRun(),
            confirmWhat: this.now() <= this.confirmUntil ? this.confirmWhat : null,
            running,
            path: this.path,
            index: this.index,
            unit: this.unitName(),
            vipIndex: this.vipIndex,
            tested: !!this.index && TESTED_INDEX.indexOf(this.index) >= 0,
            lmvIndex: this.lmvIndex,
            lmvName: this.lmvIndex ? LMV_VARIANTS[this.lmvIndex] || null : null,
            supported: this.supported,
            torque: running ? this.torque : null,
            torqueOk: this.torqueOk,
            peakRequested: this.peakRequested,
            checks: this.checks(),
            blocker: this.blocker(),
            confirming: this.now() <= this.confirmUntil,
            busy: this.busy,
            note: this.note,
            noteType: this.noteType,
        };
    }
}

module.exports = { XDriveControl, DSC, LMV, VIP, TESTED_INDEX, DBE1_UNITS, VIP_UNITS, LMV_VARIANTS, ENGINE_OFF_RPM, ENGINE_ON_RPM, ENGINE_RUNNING_OK, ON_INDEX };
