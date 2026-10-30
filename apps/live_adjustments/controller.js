'use strict';
/**
 * controller.js - the exhaust-flap state machine. It is the only module that
 * decides to send a command; the UI asks it to switch mode and reads its state.
 *
 * It separates, exactly as the brief requires, three different things:
 *   requested  - the mode the user picked (OEM / OPEN / CLOSED)
 *   accepted   - whether the DME (or the simulator) accepted the request
 *   confirmed  - the flap state read back from the car ('OPEN'/'OEM'/'CLOSED'/'UNKNOWN')
 *
 * It never presents a request as done: if there is no reliable read-back, confirmed
 * stays UNKNOWN rather than assuming the flap moved. Opening the app sends NOTHING;
 * a command leaves only on an explicit setMode() from a button.
 */
const { DiagLink } = require('./diaglink');
const adapters = require('./adapters');

const MODES = ['OEM', 'OPEN', 'CLOSED'];

class Controller {
    constructor(ctx) {
        this.ctx = ctx;
        this.log = ctx.log;
        this.link = null;
        this.ident = { present: false };
        this.adapter = adapters.Simulated;
        this.real = false;
        this.pickReason = 'starting';
        this.state = {
            requested: 'OEM',       // shown at start; NOT sent on open
            accepted: null,         // null = nothing requested yet
            confirmed: 'UNKNOWN',
            comm: 'NONE',           // NONE | OK | ERROR
            busy: false,
            error: null,
        };
        this._busyToken = 0;
    }

    /** The "Exhaust Flap" setting is the arm switch: Armed = talk to the car DME;
     * Disarmed (default) = simulated only, nothing is sent to the car. */
    get armedSetting() { return this.ctx.settings.get('arm') === 'on'; }
    get source() { return this.armedSetting ? 'car' : 'sim'; }
    get simulated() { return !this.real; }

    // Three first-class modes: OEM (hand back to the DME), OPEN and CLOSE.
    availableModes() { return ['OEM', 'OPEN', 'CLOSED']; }

    /** Set up the link and pick the adapter. READ-ONLY: detects the DME and reads
     * the flap state if the adapter can; it never actuates. */
    async start() {
        try {
            this.link = await new DiagLink(this.ctx.signals, this.log).init();
            this.state.comm = this.link.available ? 'OK' : 'NONE';
        } catch (e) {
            this.state.comm = 'ERROR';
            this.state.error = String(e && e.message || e);
            this.log.warn('diag init: ' + this.state.error);
        }
        await this.refresh();
    }

    /** Re-detect the DME, re-pick the adapter and read the current state (read-only). */
    async refresh() {
        adapters.armReal(this.armedSetting);        // arm/disarm from the setting before picking
        if (this.link && this.link.available && this.source === 'car') {
            try { this.ident = await this.link.identifyDme(); } catch (e) { this.ident = { present: false }; }
        } else {
            this.ident = { present: false };
        }
        const p = adapters.pick(this.source, this.ident);
        this.adapter = p.adapter; this.real = p.real; this.blocked = !!p.blocked; this.pickReason = p.reason;
        await this._readBack();
        return this.state;
    }

    async _readBack() {
        try {
            const r = await this.adapter.read(this.link);
            this.state.confirmed = (r && r.confirmed) || 'UNKNOWN';
            if (this.real && this.link) this.state.comm = this.link.available ? 'OK' : 'NONE';
        } catch (e) {
            this.state.confirmed = 'UNKNOWN';
        }
    }

    /**
     * User picked a mode. This is the only path that may send a command. For a real
     * (car) adapter the send is still gated inside the adapter (armed + matched);
     * a blocked real command surfaces as an error, never as a success.
     */
    async setMode(mode) {
        if (MODES.indexOf(mode) < 0) return this.state;
        const token = ++this._busyToken;
        this.state.requested = mode;
        this.state.accepted = null;
        this.state.error = null;
        this.state.busy = true;
        this.state.confirmed = this.real ? 'UNKNOWN' : this.state.confirmed;  // real: unknown until read back
        try {
            const action = mode === 'OEM' ? 'oem' : (mode === 'CLOSED' ? 'closed' : 'open');
            const fn = this.adapter[action] || this.adapter.oem;
            const r = await fn.call(this.adapter, this.link);
            if (token !== this._busyToken) return this.state;   // superseded by a newer press
            this.state.accepted = !!(r && r.accepted);
            this.state.confirmed = (r && r.confirmed) || 'UNKNOWN';
            if (!this.state.accepted) this.state.error = (r && r.detail) || null;   // no generic nag on screen
            this.log.info('mode ' + mode + ' -> accepted=' + this.state.accepted + ' confirmed=' + this.state.confirmed + ' (' + ((r && r.detail) || '') + ')');
        } catch (e) {
            if (token !== this._busyToken) return this.state;
            this.state.accepted = false;
            // A real safety *block* is worth showing; anything else (timeout / no answer /
            // car asleep / ignition off) stays SILENT — the button may still move, but NO
            // error message on screen. Nothing actuated anyway (the DME never answered).
            this.state.error = e && e.blocked ? 'real control blocked: ' + e.message : null;
            if (!(e && e.blocked)) this.state.comm = 'NONE';
            this.log.warn('setMode ' + mode + ': ' + String(e && e.message || e));
        } finally {
            if (token === this._busyToken) this.state.busy = false;
        }
        // a real adapter that can read back: confirm a moment later (no assumption)
        if (this.real && this.adapter.read) { try { await this._readBack(); } catch (e) { /* ignore */ } }
        return this.state;
    }

    view() {
        return {
            requested: this.state.requested,
            accepted: this.state.accepted,
            confirmed: this.state.confirmed,
            comm: this.state.comm,
            busy: this.state.busy,
            error: this.state.error,
            simulated: this.simulated,
            blocked: !!this.blocked,
            source: this.source,
            adapterName: this.adapter.name,
            pickReason: this.pickReason,
            dme: this.ident && this.ident.present ? (this.ident.sgbdIndex || this.ident.vin || 'detected') : null,
            modes: this.availableModes(),
        };
    }
}

module.exports = { Controller, MODES };
