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
const { MHD, mhdSend } = require('./real_adapters');

const MODES = ['OEM', 'OPEN', 'CLOSED'];
const REFRESH_KEYS = ['arm'];                   // the settings (app.json) refresh() depends on

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
        // the tune's own controls (Map, Max cooling, Burbles, ASD): what was asked and whether the DME
        // took it ('read' = read back from the DME at the unlock check)
        this.tune = { map: null, mapAccepted: null, cooling: null, coolingAccepted: null, burbles: null, burblesAccepted: null,
            asd: null, asdAccepted: null, busy: false, error: null };
        this._oemQueued = false;    // OEM pressed while a command was in flight: sent right after it
        this._flight = null;        // the flap command in flight (with the OEM queued behind it)
    }

    /** The "Car control" setting is the arm switch: Armed = talk to the car DME;
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
            this.link = await new DiagLink(this.ctx.signals, this.log, (this.ctx.spec && this.ctx.spec.config) || {}).init();
            this.state.comm = this.link.available ? 'OK' : 'NONE';
        } catch (e) {
            this.state.comm = 'ERROR';
            this.state.error = String(e && e.message || e);
            this.log.warn('diag init: ' + this.state.error);
        }
        await this.refresh();
    }

    /** Platform setting: 'auto' (the unlock check decides), 'bm3' or 'mhd'. */
    get platform() { return this.ctx.settings.get('platform') || 'auto'; }
    /** MHD controls: the unlock check answered "MHD...", or the platform is set to MHD. */
    get mhd() { return !!(this.ident && this.ident.mhd && this.ident.mhd.flashed) || this.platform === 'mhd'; }
    /** BM3 controls without a ROM layout (flap, ASD): the marker was found, or the platform is set to Bootmod3. */
    get bm3() { return this.bm3Rom || this.platform === 'bm3'; }
    /** The BM3 marker names a ROM with a known layout: map and burbles need it (memory addresses). */
    get bm3Rom() { return !!(this.ident && this.ident.bm3 && this.ident.bm3.flashed); }

    /** Re-detect the DME, re-pick the adapter and read the current state (read-only). Disarmed
     * sends nothing to the car, not even the identity reads. */
    async refresh() {
        // a disarm waits for the flap command in flight and an OEM pressed meanwhile (pressed while armed, the
        // hand-back to the car still goes); from then on nothing goes to the car
        if (!this.armedSetting && this.state.busy && this._flight) await this._flight;
        adapters.armReal(this.armedSetting);        // arm/disarm from the setting before picking
        if (this.link && this.link.available && this.source === 'car') {
            try { this.ident = await this.link.identifyDme(this.platform); } catch (e) { this.ident = { present: false, platform: this.platform }; }
        } else {
            this.ident = { present: false, platform: this.platform };
        }
        if (this.bm3Rom) await this._readBm3();
        const p = adapters.pick(this.source, this.ident);
        this.adapter = p.adapter; this.real = p.real; this.blocked = !!p.blocked; this.pickReason = p.reason;
        await this._readBack();
        return this.state;
    }

    /** BM3's map slot and burbles as the DME has them (memory reads). */
    async _readBm3() {
        try { this.tune.map = (await this.link.bm3.currentMap()) + 1; this.tune.mapAccepted = 'read'; } catch (e) { this.log.warn('BM3 map read: ' + e.message); }
        try {
            const b = await this.link.bm3.readBurbles();
            if (!b.enabled || b.aggression !== null) { this.tune.burbles = b.enabled ? b.aggression : null; this.tune.burblesAccepted = 'read'; }
        } catch (e) { this.log.warn('BM3 burbles read: ' + e.message); }
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
        // one flap command at a time (a second would share its reply); OEM hands the flap back to the
        // car, so it is never dropped: it goes right after the command in flight
        if (this.state.busy) {
            // OEM shows as picked at once (the screen says it was taken) and goes right after; pressed after a
            // disarm it is not queued (the disarm waits for this command only: then nothing goes to the car)
            if (mode === 'OEM' && this.armedSetting) { this._oemQueued = true; this.state.requested = 'OEM'; this.state.error = null; }
            return this.state;
        }
        let landed;
        this._flight = new Promise((r) => { landed = r; });
        try { return await this._send(mode); } finally { landed(); }
    }

    async _send(mode) {
        this.state.requested = mode;
        this.state.accepted = null;
        this.state.error = null;
        this.state.busy = true;
        this.state.confirmed = this.real ? 'UNKNOWN' : this.state.confirmed;  // real: unknown until read back
        try {
            const action = mode === 'OEM' ? 'oem' : (mode === 'CLOSED' ? 'closed' : 'open');
            const fn = this.adapter[action] || this.adapter.oem;
            const r = await fn.call(this.adapter, this.link);
            this.state.accepted = !!(r && r.accepted);
            this.state.confirmed = (r && r.confirmed) || 'UNKNOWN';
            if (!this.state.accepted) this.state.error = (r && r.detail) || null;   // no generic nag on screen
            this.log.info('mode ' + mode + ' -> accepted=' + this.state.accepted + ' confirmed=' + this.state.confirmed + ' (' + ((r && r.detail) || '') + ')');
        } catch (e) {
            this.state.accepted = false;
            // A real safety *block* is worth showing; anything else (timeout / no answer /
            // car asleep / ignition off) stays SILENT — the button may still move, but NO
            // error message on screen. Nothing actuated anyway (the DME never answered).
            this.state.error = e && e.blocked ? 'real control blocked: ' + e.message : null;
            if (!(e && e.blocked)) this.state.comm = 'NONE';
            this.log.warn('setMode ' + mode + ': ' + String(e && e.message || e));
        } finally {
            this.state.busy = false;
        }
        if (this._oemQueued) { this._oemQueued = false; return this.setMode('OEM'); }
        // a real adapter that can read back: confirm a moment later (no assumption)
        if (this.real && this.adapter.read) { try { await this._readBack(); } catch (e) { /* ignore */ } }
        return this.state;
    }

    /**
     * map: slot 1..4 (MHD or BM3), cooling: on/off (MHD), burbles: aggression 0..12 or null = off (BM3),
     * asd: Active Sound Design on/off (BM3). Disarmed: simulated, nothing is sent. Armed: only with
     * the flash it needs detected; MHD's echo or BM3's memory read-back is the acceptance.
     */
    async setTune(kind, value) {
        if (kind === 'map' && !(value >= 1 && value <= 4)) return this.tune;
        this.tune[kind] = value;
        this.tune[kind + 'Accepted'] = null;
        this.tune.error = null;
        if (!this.armedSetting) {
            this.tune[kind + 'Accepted'] = true;
            this.log.info(kind + ' ' + value + ' (simulated)');
            return this.tune;
        }
        // map / burbles on BM3 write memory, so they need the ROM's layout; flap and ASD don't
        const tuner = this.mhd && (kind === 'map' || kind === 'cooling') ? 'mhd'
            : (kind === 'map' || kind === 'burbles') && this.bm3Rom ? 'bm3' : kind === 'asd' && this.bm3 ? 'bm3' : null;
        if (!tuner) {
            this.tune[kind + 'Accepted'] = false;
            this.tune.error = 'not sent: ' + (kind === 'cooling' ? 'no MHD flash' : kind !== 'asd' && this.bm3 ? 'BM3 ROM not identified'
                : kind === 'map' ? 'no MHD or BM3 flash' : 'no BM3 flash');
            return this.tune;
        }
        this.tune.busy = true;
        try {
            const r = tuner === 'mhd' ? await mhdSend(this.link, kind === 'map' ? MHD.MAP : MHD.COOLING, kind === 'map' ? value - 1 : (value ? 1 : 0))
                : await this._bm3(kind, value);
            this.tune[kind + 'Accepted'] = r.accepted;
            if (!r.accepted) this.tune.error = r.detail;
            this.log.info(kind + ' ' + value + ' -> accepted=' + r.accepted + ' (' + r.detail + ')');
        } catch (e) {
            this.tune[kind + 'Accepted'] = false;
            this.log.warn(kind + ' ' + value + ': ' + String(e && e.message || e));
        } finally {
            this.tune.busy = false;
        }
        return this.tune;
    }

    async _bm3(kind, value) {
        try {
            if (kind === 'map') await this.link.bm3.setMap(value - 1);
            else if (kind === 'burbles') await this.link.bm3.setBurbles(value);
            else await this.link.bm3.setAsd(!!value);
            return { accepted: true, detail: kind === 'asd' ? 'DME took it' : 'DME took it (read back)' };
        } catch (e) {
            return { accepted: false, detail: String(e && e.message || e) };
        }
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
            mhd: this.ident && this.ident.mhd ? this.ident.mhd : null,
            bm3: this.ident && this.ident.bm3 ? this.ident.bm3 : null,
            platform: this.platform,
            tune: Object.assign({}, this.tune),
        };
    }
}

module.exports = { Controller, MODES, REFRESH_KEYS };
