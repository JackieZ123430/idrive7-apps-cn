'use strict';
/**
 * adapters.js - per-DME strategies for commanding the exhaust flap.
 *
 * The flap command is NOT the same byte string on every engine, so the app never
 * hard-codes one. An adapter declares which DME variants it serves (`match(ident)`)
 * and implements three actions, each returning a Result:
 *
 *   open(link)   - request the flap OPEN
 *   closed(link) - request the flap CLOSED
 *   oem(link)    - hand control back to the DME's own strategy
 *   read(link)   - read the flap state back (OPEN / CLOSED / OEM / UNKNOWN), read-only
 *
 * Result = { accepted: bool, confirmed: 'OPEN'|'CLOSED'|'OEM'|'UNKNOWN', detail: string }
 *
 * SAFETY GATE
 * -----------
 * A real adapter must set `armed: true` AND match the car's DME before any byte is
 * sent. Until an actuation command has been CONFIRMED (from the EDIABAS .PRG jobs
 * and/or validated on a bench) and explicitly authorised, there is NO armed real
 * adapter here: the real template below keeps `armed: false` and refuses to send.
 * The Simulated adapter is always available and sends nothing to the car.
 */

/* ---------------------------------------------------------------- simulated -- */
// Safe default: models the valve in memory, talks to no ECU. Used for the bench,
// the preview, and whenever "Control source = Simulated" or no real adapter matches.
const Simulated = {
    id: 'sim',
    name: 'Simulated',
    simulated: true,
    armed: true,                 // "armed" only means it may run - it touches no car
    match() { return true; },    // always available as a fallback
    _state: 'OEM',
    async open() { this._state = 'OPEN'; return { accepted: true, confirmed: 'OPEN', detail: 'simulated' }; },
    async oem() { this._state = 'OEM'; return { accepted: true, confirmed: 'OEM', detail: 'simulated' }; },
    async closed() { this._state = 'CLOSED'; return { accepted: true, confirmed: 'CLOSED', detail: 'simulated' }; },
    async read() { return { accepted: true, confirmed: this._state, detail: 'simulated' }; },
};

/* --------------------------------------------------------------- real (TBD) -- */
/**
 * Template for a validated, car-touching adapter. It is intentionally DISARMED.
 *
 * When the actuation command for a DME family is CONFIRMED (job name + UDS service
 * + identifier + arguments, from C:\EC-APPS\EDIABAS\ecu and/or bench validation),
 * fill `OPEN_REQUEST` / `OEM_REQUEST` with the exact bytes, set `match` to the
 * DME variants it was validated on, and only then set `armed: true`. Nothing is
 * sent while `armed` is false or `match` returns false.
 *
 * Shape of a request, once known (example of the EXPECTED form, NOT a real command):
 *   service 0x2F InputOutputControlByIdentifier to the DME (address 0x12):
 *     OPEN : [0x2F, DID_hi, DID_lo, 0x03 (shortTermAdjustment), <state bytes...>]
 *     OEM  : [0x2F, DID_hi, DID_lo, 0x00 (returnControlToECU)]
 *   or service 0x31 RoutineControl, if the car uses a routine instead.
 * Some DMEs also need an extended session (0x10 0x03) and/or SecurityAccess (0x27)
 * first; the adapter would do that in `prepare(link)` before sending.
 */
const RealTemplate = {
    id: 'real-template',
    name: 'DME (unvalidated)',
    simulated: false,
    armed: false,                        // <-- stays false until confirmed + authorised
    OPEN_REQUEST: null,                  // e.g. { sid: 0x2F, data: [0x??, 0x??, 0x03, ...] }
    OEM_REQUEST: null,                   // e.g. { sid: 0x2F, data: [0x??, 0x??, 0x00] }
    READ_DID: null,                      // e.g. [0x??, 0x??] for a 0x22 state read
    match(/* ident */) { return false; },  // no confirmed variant yet

    _guard() {
        if (!this.armed || !this.OPEN_REQUEST || !this.OEM_REQUEST) {
            const err = new Error('real flap control is not validated/authorised on this build');
            err.blocked = true;
            throw err;
        }
    },
    async prepare(/* link */) { /* extended session / security access go here when needed */ },
    async open(link) {
        this._guard();
        await this.prepare(link);
        const r = await link.sendToDme(this.OPEN_REQUEST.sid, this.OPEN_REQUEST.data);
        return { accepted: !!r.ok, confirmed: 'UNKNOWN', detail: r.ok ? 'DME accepted' : (r.reason || 'rejected') };
    },
    async oem(link) {
        this._guard();
        await this.prepare(link);
        const r = await link.sendToDme(this.OEM_REQUEST.sid, this.OEM_REQUEST.data);
        return { accepted: !!r.ok, confirmed: 'UNKNOWN', detail: r.ok ? 'DME accepted' : (r.reason || 'rejected') };
    },
    async read(link) {
        if (!this.READ_DID) return { accepted: false, confirmed: 'UNKNOWN', detail: 'no state read for this DME' };
        const r = await link.readDid(this.READ_DID);
        return { accepted: r.ok, confirmed: 'UNKNOWN', detail: r.ok ? 'raw ' + (r.data || []).join(',') : (r.reason || 'no reply') };
    },
};

/* ------------------------------------------------------------- unavailable -- */
// Used in "car" mode when the DME is not supported or no adapter is armed: it
// reads nothing and refuses every actuation as blocked, so the app shows
// "unavailable" instead of silently pretending (never simulates a car it can't drive).
const Unavailable = {
    id: 'none', name: 'Unavailable', simulated: false, armed: false,
    match() { return true; },
    _blocked() { const e = new Error('exhaust control not available on this car'); e.blocked = true; throw e; },
    async open() { this._blocked(); }, async oem() { this._blocked(); }, async closed() { this._blocked(); },
    async read() { return { accepted: false, confirmed: 'UNKNOWN', detail: 'unavailable' }; },
};

// Registry. Real adapters first (most specific), then the template. All are
// DISARMED until validated + authorised; Simulated is the safe fallback in sim mode.
const { Mg1ElAgk } = require('./real_adapters');
const REAL_ADAPTERS = [Mg1ElAgk, RealTemplate];

/** Arm/disarm the validated real adapters from the app's "Exhaust Flap" setting.
 * Disarmed (default) = the app runs simulated and sends nothing to the car. */
function armReal(on) { Mg1ElAgk.armed = !!on; }

/**
 * Pick the adapter for this car. Returns { adapter, real, blocked, reason }.
 *  - source 'sim' -> Simulated (no car command, never blocked).
 *  - source 'car' -> an armed adapter that matches; else the matching but DISARMED
 *    adapter (so it reports "detected, control blocked" and refuses to actuate);
 *    else Unavailable. "car" mode NEVER silently simulates.
 */
function pick(source, ident) {
    if (source !== 'car') return { adapter: Simulated, real: false, blocked: false, reason: 'simulated (safe) mode' };
    for (let i = 0; i < REAL_ADAPTERS.length; i++) {
        const a = REAL_ADAPTERS[i];
        try { if (a.armed && a.match(ident)) return { adapter: a, real: true, blocked: false, reason: a.name }; } catch (e) { /* ignore */ }
    }
    for (let i = 0; i < REAL_ADAPTERS.length; i++) {
        const a = REAL_ADAPTERS[i];
        try { if (a.match(ident)) return { adapter: a, real: true, blocked: true, reason: a.name + ' - control blocked (not armed)' }; } catch (e) { /* ignore */ }
    }
    return { adapter: Unavailable, real: true, blocked: true, reason: ident && ident.present ? 'DME detected but not supported' : 'no DME detected' };
}

module.exports = { pick, armReal, Simulated, Unavailable, RealTemplate, REAL_ADAPTERS };
