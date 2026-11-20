'use strict';
/**
 * real_adapters.js - car-touching adapters with the CONFIRMED actuation command.
 *
 * ==========================  SAFETY  ==========================================
 * This adapter ships DISARMED (`armed: false`). Actuation is gated behind the app's
 * own "Car control" setting (Settings → Armed): disarmed = simulated only (touches
 * nothing); armed = the app sets `armed: true` at runtime and sends the real command.
 * Each owner validates on their OWN car before arming. Even when armed it only
 * actuates with a matching DME, and OEM always hands control back (the DME also
 * self-times the override in ~20 s). The command below was confirmed on a real car
 * (Bosch MG1, 2026-10-29); other DME variants are unverified.
 * ==============================================================================
 *
 * CONFIRMED command (BMW's own EDIABAS SGBDs dme8ff_r / dme_bx8 / s55 / n55_alp,
 * i.e. Bosch MG1 / DME8 as used by B48 / B58 / S58 on MGU ID7, cross-checked with
 * the ISO 14229 0x2F service and independent forum reports):
 *
 *   Service 0x2F InputOutputControlByIdentifier, DID 0x60FD ("EL_AGK",
 *   electric exhaust flap):
 *     drive    : 2F 60FD 03 <TV_hi> <TV_lo>     (0x03 = shortTermAdjustment)
 *     hand back: 2F 60FD 00                      (0x00 = returnControlToECU)
 *   TV = duty cycle, raw = percent x 100 (2 bytes). BMW's SGBD warns to use ONLY
 *   these bands, others can set DTCs:
 *     8-12 %  = Auffahren (OPEN)      -> 10 % = 1000 = 0x03E8
 *     28-32 % = component detection
 *     48-52 % = workshop position
 *     88-92 % = Zufahren (CLOSE)      -> 90 % = 9000 = 0x2328
 *   The DME times the override itself (default 20 s, max 510 s). Read-back:
 *   22 62FD (commanded %) and 22 64FD (output position).
 *
 * STILL UNVERIFIED before arming (why it stays disarmed):
 *   - exact controlState trailing timeout byte(s) and TV width on MG1,
 *   - whether an extended session (10 03) / SecurityAccess (27) is needed,
 *   - preconditions (Kl.15 on, engine running, stationary) and what the DME does
 *     under load, and the behaviour when the diagnostic session drops.
 */

// duty-cycle set-points (percent) within BMW's allowed bands
const PCT_OPEN = 10;      // Auffahren
const PCT_CLOSE = 90;     // Zufahren
const DID = [0x60, 0xFD];

function tvBytes(pct) {
    const raw = Math.round(pct * 100) & 0xFFFF;   // percent x 100, 2 bytes
    return [(raw >> 8) & 0xFF, raw & 0xFF];
}

function drive(pct) { return { sid: 0x2F, data: [DID[0], DID[1], 0x03].concat(tvBytes(pct)) }; }
function release() { return { sid: 0x2F, data: [DID[0], DID[1], 0x00] }; }

/*
 * The G-series V8s (DME8FF_R at 0x12 and DME8FF_L at 0x13: N63TU2/3, S63TU4) take the same 2F 60FD (BMW's SGBD: the
 * values 1000 / 3000 / 5000 / 9000 = 10 / 30 / 50 / 90 %), each unit for its bank's flap, so both are sent it
 * (diaglink's flapUnits). They also have the controlled flap, GER_EL_AGK (when the DME runs it, St_Akr == 8):
 *   2F 611E 03 <set point, signed 16 bit, % x 81.92>   hand back: 2F 611E 00
 * used for a unit that refuses 60FD but answers its read (22 631E). 100 % = open (BMW's flap positions: 0 = closed).
 */
const GER_DID = [0x61, 0x1E];
function gerDrive(pct) { const raw = Math.round(pct * 81.92) & 0xFFFF; return { sid: 0x2F, data: [GER_DID[0], GER_DID[1], 0x03, raw >> 8, raw & 0xFF] }; }
const GER = { open: gerDrive(100), closed: gerDrive(0), oem: { sid: 0x2F, data: [GER_DID[0], GER_DID[1], 0x00] } };
const hex2 = (n) => (n < 16 ? '0' : '') + n.toString(16).toUpperCase();

// Bosch MG1 / DME8 electric-flap adapter (B48 / B58 / S58, MGU ID7).
const Mg1ElAgk = {
    id: 'mg1-el-agk',
    name: 'Electric flap (MG1 / V8)',
    simulated: false,
    armed: false,                            // DISARMED by default; the controller sets this true at
                                             // runtime when the "Car control" setting is Armed. Even
                                             // then it needs a matching DME; OEM always hands back.
    OPEN_REQUEST: drive(PCT_OPEN),
    CLOSE_REQUEST: drive(PCT_CLOSE),
    OEM_REQUEST: release(),
    // matched by a read-only capability probe (DME answered 22 62FD / 22 64FD),
    // not by a hard-coded variant list, so it covers every MG1 that has the flap.
    match(ident) { return !!(ident && ident.elAgk && ident.elAgk.supported); },

    _guard() {
        if (!this.armed) {
            const err = new Error('MG1 flap control is confirmed but not armed (needs bench validation + authorisation)');
            err.blocked = true;
            throw err;
        }
    },
    // Some DMEs want an extended diagnostic session before 0x2F. Kept here so arming
    // is the only remaining change; it is a no-op on DMEs that accept 0x2F directly.
    async prepare(link) {
        this._guard();
        // await link.sendToDme(0x10, [0x03]);   // DIAGNOSE_MODE ECUEXTDIAG - enable only if validated
    },
    // each engine unit with a flap (a V8: both); ok only on its own 6F echo (sendTo takes no other reply, replyTo)
    async _send(kind, link) {
        this._guard();
        await this.prepare(link);
        const req = { open: this.OPEN_REQUEST, closed: this.CLOSE_REQUEST, oem: this.OEM_REQUEST }[kind];
        const units = link.flapUnits && link.flapUnits.length ? link.flapUnits : [{ addr: null, el: true, ger: false }];
        const out = [];
        let any = false;
        for (const u of units) {
            const to = (q) => (u.addr === null || u.addr === link.dme || !link.sendTo ? link.sendToDme(q.sid, q.data) : link.sendTo(u.addr, q.sid, q.data));
            let r = null, how = '';
            if (kind === 'oem') {
                // hand back what took the flap (the controlled flap's own hand-back after a 611E)
                if (u.el) r = await to(req);
                if (u.ger && (u.viaGer || !(r && r.ok))) { const g = await to(GER.oem); if (!(r && r.ok)) r = g; }
                u.viaGer = false;
            } else {
                if (u.el) r = await to(req);
                if (!(r && r.ok) && u.ger) { r = await to(GER[kind]); how = ' (controlled flap)'; u.viaGer = !!(r && r.ok); }
            }
            any = any || !!(r && r.ok);
            out.push((units.length > 1 ? hex2(u.addr) + ': ' : '') + (r && r.ok ? 'accepted' + how : (r && r.reason) || 'rejected'));
        }
        const detail = units.length === 1 && any && units[0].el && !units[0].viaGer ? 'DME accepted' : out.join(', ');
        return { accepted: any, confirmed: 'UNKNOWN', detail: detail };
    },
    async open(link) { return this._send('open', link); },
    async closed(link) { return this._send('closed', link); },
    async oem(link) { return this._send('oem', link); },
    async read(link) {
        const s = await link.readElAgk();
        // commanded % tells us what the flap is driven to; map to OPEN/CLOSED/OEM
        let confirmed = 'UNKNOWN';
        if (s && s.commandedPct != null) {
            confirmed = s.commandedPct <= 20 ? 'OPEN' : s.commandedPct >= 80 ? 'CLOSED' : 'UNKNOWN';
        }
        return { accepted: !!(s && s.supported), confirmed: confirmed, detail: s && s.commandedPct != null ? s.commandedPct + ' %' : 'no read' };
    },
};

/*
 * MHD-flashed DME: the tune itself answers short 0x2F controls. Captured from MHD's own app on an
 * MHD+ S58 (a1-mapping, idrive7-apps PR #23):
 *   2F 01 nn  map slot      (00 = map 1 .. 03 = map 4)
 *   2F 02 nn  exhaust flap  (00 = OEM, 01 = open, 02 = closed)
 *   2F 03 nn  max cooling   (00 = off, 01 = on; the "on" capture was damaged, 01 by analogy)
 * The DME takes one by echoing 6F <fn> <nn>. A DME without the MHD flash rejects them.
 */
const MHD = { MAP: 0x01, FLAP: 0x02, COOLING: 0x03 };

async function mhdSend(link, fn, value) {
    const r = await link.sendToDme(0x2F, [fn, value]);
    const ok = !!r.ok && r.sid === 0x6F && r.data[0] === fn && r.data[1] === value;
    return { accepted: ok, detail: ok ? 'DME took it' : (r.reason || 'unexpected reply') };
}

const MhdFlap = {
    id: 'mhd-flap',
    name: 'MHD · exhaust flap',
    simulated: false,
    armed: false,                            // armed at runtime from the app's arm setting
    // the unlock check found the MHD tag, or the Platform setting says MHD
    match(ident) { return !!(ident && ((ident.mhd && ident.mhd.flashed) || ident.platform === 'mhd')); },
    _guard() {
        if (!this.armed) {
            const err = new Error('MHD flap control is not armed');
            err.blocked = true;
            throw err;
        }
    },
    async _set(link, value) {
        this._guard();
        const r = await mhdSend(link, MHD.FLAP, value);
        return { accepted: r.accepted, confirmed: 'UNKNOWN', detail: r.detail };
    },
    async open(link) { return this._set(link, 0x01); },
    async closed(link) { return this._set(link, 0x02); },
    async oem(link) { return this._set(link, 0x00); },
    // the tune has no read-back of the flap that we know of: the state stays as requested
    async read() { return { accepted: true, confirmed: 'UNKNOWN', detail: 'no read-back on MHD' }; },
};

/*
 * BM3 CustomROM: the flap through the same DID 0x60FD with BM3's own values (BM3 Live, idrive7-apps
 * PR #29): open 2F 60FD 03 14FE, close 2F 60FD 03 2328, auto 2F 60FD 00 (hands it back to the DME).
 */
const Bm3Flap = {
    id: 'bm3-flap',
    name: 'BM3 · exhaust flap',
    simulated: false,
    armed: false,                            // armed at runtime from the app's arm setting
    // the flap needs no ROM layout: the marker was found, or the Platform setting says Bootmod3
    match(ident) { return !!(ident && ((ident.bm3 && ident.bm3.flashed) || ident.platform === 'bm3')); },
    _guard() {
        if (!this.armed) {
            const err = new Error('BM3 flap control is not armed');
            err.blocked = true;
            throw err;
        }
    },
    async _set(link, mode) {
        this._guard();
        try {
            await link.bm3.setFlap(mode);
            return { accepted: true, confirmed: 'UNKNOWN', detail: 'DME took it' };
        } catch (e) {
            return { accepted: false, confirmed: 'UNKNOWN', detail: String(e && e.message || e) };
        }
    },
    async open(link) { return this._set(link, 'open'); },
    async closed(link) { return this._set(link, 'close'); },
    async oem(link) { return this._set(link, 'auto'); },
    // the replies don't measure the valve: the state stays as requested
    async read() { return { accepted: true, confirmed: 'UNKNOWN', detail: 'no read-back on BM3' }; },
};

module.exports = { GER, gerDrive, Mg1ElAgk, MhdFlap, Bm3Flap, MHD, mhdSend, PCT_OPEN, PCT_CLOSE, tvBytes, drive, release };
