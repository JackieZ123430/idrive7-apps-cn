'use strict';
/**
 * auto.js - what the flap should be doing, on top of Engine Config's controller (which sends it).
 *
 *   buttons   OPEN / CLOSE / OEM: that mode, the driving mode is not followed.
 *             DRIVE MODE: the flap follows the driving mode, on every change:
 *               Sport / Sport+ / Sport Individual -> OPEN
 *               Comfort / Comfort+ / Comfort Individual / Adaptive -> OEM (the car's own strategy)
 *               Eco Pro / Eco Pro+ / Eco Pro Individual -> CLOSED
 *               plug-in hybrids: Sport / Sport Individual / Sport+ / Boost -> OPEN, Hybrid / Hybrid Comfort -> OEM,
 *               Hybrid Eco / Electric / Electric Individual -> CLOSED
 *             DRIVE MODE is saved with the settings (key driveLink, not shown in the menu), so it is still on
 *             after the next start.
 *   rpm guard Close is paused (OEM sent, the DME opens the flap as it needs) while the live engine speed
 *             is above the "Close: hand back above" setting, and resumes below that limit - 500 rpm.
 *   no rpm    Armed with a limit set, Close is not held without a live engine speed (none yet, or none for 5 s):
 *               manual CLOSE  -> OEM, LATCHED: it stays OEM even when the signal returns; press CLOSE again;
 *               DRIVE MODE    -> OEM, paused: Close comes back by itself once a live engine speed below the
 *               (Eco Pro)        limit - 500 rpm is back (no CLOSE button to press again in DRIVE MODE).
 *             Disarmed (simulated) or limit "Never": no rpm check at all.
 *   hold      the DME lets a tester's command go after ~20 s, so OPEN / CLOSED is sent again every 15 s.
 *
 * Disarmed: the controller simulates (nothing reaches the car); auto only follows along, no repeats.
 * Nothing here talks to the car itself: every command goes through controller.setMode().
 */

const HYST = 500;
// actualValueModeDrivingExperience's plug-in hybrid numbers (PHEV_SPORT_STANDARD 15 ... BOOST 28, as in Ambient config)
const PHEV_FLAP = { 15: 'OPEN', 16: 'OPEN', 23: 'OPEN', 28: 'OPEN',      // PHEV Sport, Sport Individual, Sport+, Boost
    17: 'OEM', 19: 'OEM',                                                // PHEV Hybrid (Standard), Hybrid Comfort
    18: 'CLOSED', 20: 'CLOSED', 21: 'CLOSED' };                          // PHEV Hybrid Eco, Electric, Electric Individual

/** The driving mode (statusFESVehicleDynamicSwitchHMI.actualValueModeDrivingExperience, name or number) -> flap mode. */
function flapFor(raw) {
    if (raw === undefined || raw === null) return null;
    const n = Number(raw);
    if (!isNaN(n) && String(raw).trim() !== '') {
        if (n >= 1 && n <= 3) return 'OPEN';       // Sport, Sport plus, Sport individual
        if (n >= 4 && n <= 6) return 'OEM';        // Comfort, Comfort plus, Comfort individual
        if (n >= 7 && n <= 9) return 'CLOSED';     // Eco pro, Eco pro plus, Eco pro individual
        if (n === 10) return 'OEM';                // Adaptive
        if (PHEV_FLAP[n]) return PHEV_FLAP[n];     // the plug-in hybrids' own modes (330e, X5 45e ...)
        return null;                               // 0, 61-63: initialising / invalid
    }
    const s = String(raw).toUpperCase();
    if (/SPORT|BOOST/.test(s)) return 'OPEN';
    if (/ECO/.test(s)) return 'CLOSED';            // Eco Pro, PHEV Hybrid Eco
    if (/ELECTRIC|ELEKTR/.test(s)) return 'CLOSED'; // PHEV Electric: the engine only starts when it has to
    if (/COMFORT|ADAPTIVE|TRAFFIC|HYBRID/.test(s)) return 'OEM';  // PHEV Hybrid (Standard) is the hybrids' Comfort
    return null;
}

/** A readable name for the screen. */
function modeName(raw) {
    const N = { 1: 'Sport', 2: 'Sport+', 3: 'Sport Individual', 4: 'Comfort', 5: 'Comfort+', 6: 'Comfort Individual',
        7: 'Eco Pro', 8: 'Eco Pro+', 9: 'Eco Pro Individual', 10: 'Adaptive', SPORT_DYNAMIC: 'Sport', SPORT_EXPERT: 'Sport+',
        ECO_PRO_EFFICIENT: 'Eco Pro', 15: 'Sport', 16: 'Sport Individual', 17: 'Hybrid', 18: 'Hybrid Eco', 19: 'Hybrid Comfort',
        20: 'Electric', 21: 'Electric Individual', 23: 'Sport+', 28: 'Sport Boost', PHEV_SPORT_STANDARD: 'Sport',
        PHEV_SPORT_INDIVIDUAL: 'Sport Individual', PHEV_SPORT_PLUS: 'Sport+', PHEV_HYBRID_STANDARD: 'Hybrid',
        PHEV_HYBRID_ECO: 'Hybrid Eco', PHEV_HYBRID_COMFORT: 'Hybrid Comfort', PHEV_ELECTRIC_STANDARD: 'Electric',
        PHEV_ELECTRIC_INDIVIDUAL: 'Electric Individual', BOOST: 'Sport Boost' };
    return N[raw] || (raw == null ? null : String(raw).replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()));
}

class AutoFlap {
    /**
     * o.controller  Engine Config's Controller (setMode, armedSetting)
     * o.get(key)    settings; o.rpm() live engine speed or null; o.log; o.holdMs (15000); o.onChange()
     */
    constructor(o) {
        this.c = o.controller;
        this.get = o.get;
        this.set = o.set || (() => {});
        this.rpm = o.rpm || (() => null);
        this.log = o.log;
        this.holdMs = o.holdMs || 15000;
        this.onChange = o.onChange || (() => {});
        this.desired = 'OEM';
        this.source = 'start';        // start | press | drive
        this.drive = null;            // last driving mode (raw)
        this.paused = false;          // Close paused by the rpm guard
        this.why = null;              // why paused: 'rpm' (over the limit) | 'nosignal' (DRIVE MODE, no engine speed)
        this.sent = 'OEM';            // the mode last sent (or simulated)
        this._timer = null;
        this._q = Promise.resolve();
        this._link = this.linkOn ? 'on' : 'off';
        this.rpmLost = false; // latched after manual CLOSE loses its RPM signal
    }

    get linkOn() { return this.get('driveLink') === 'on'; }
    get holdOn() { return this.get('hold') !== 'off'; }
    get limit() { const v = Number(this.get('closeLimit')); return v > 0 ? v : null; }
    get armed() { return !!this.c.armedSetting; }

    /** what goes to the car now */
    effective() { return this.desired === 'CLOSED' && this.paused ? 'OEM' : this.desired; }

    /** the button lit: 'DRIVE' while the driving mode is followed, else the mode asked for */
    selected() { return this.linkOn ? 'DRIVE' : this.desired; }

    /** a button: 'OPEN' | 'CLOSED' | 'OEM' (manual, stops following the driving mode) or 'DRIVE' (follow it) */
    press(mode) {
        if (mode === 'DRIVE') {
            if (!this.linkOn) { this._link = 'on'; this.set('driveLink', 'on'); }
            this.desired = flapFor(this.drive) || 'OEM'; this.source = 'drive';
        } else {
            if (this.linkOn) { this._link = 'off'; this.set('driveLink', 'off'); }
            this.desired = mode; this.source = 'press';
        }
        this.rpmLost = false; // a new user choice clears the previous indication
        if (this.desired === 'CLOSED' && this.source === 'press' && this._blind()) {
            this.desired = 'OEM';
            this.rpmLost = true;
            this.log.warn('manual CLOSE blocked: no valid RPM; requesting OEM');
        }
        this._pauseFor(this.desired);
        return this.apply(true);
    }

    /** the driving mode changed (or arrived): with the link on, the flap follows it */
    driveMode(raw) {
        const prev = this.drive;
        this.drive = raw;
        if (!this.linkOn || String(prev) === String(raw)) return null;
        const m = flapFor(raw);
        if (!m) return null;
        this.desired = m; this.source = 'drive';
        this._pauseFor(m);
        this.log.info('drive mode ' + modeName(raw) + ' -> ' + m);
        return this.apply(false);
    }

    /** Close wanted right now: paused if over the limit, or (DRIVE MODE) with no engine speed */
    _pauseFor(m) {
        this.why = m !== 'CLOSED' ? null : this._over() ? 'rpm' : this.source === 'drive' && this._blind() ? 'nosignal' : null;
        this.paused = !!this.why;
    }

    /** the car came up (ignition on): the DME starts on its own strategy, send what is wanted again */
    linkUp() { this.sent = 'OEM'; if (this.linkOn && this.drive != null) { const m = flapFor(this.drive); if (m) { this.desired = m; this.source = 'drive'; } } return this.apply(false); }

    settingsChanged(key) {
        if (key === 'driveLink') {
            const v = this.linkOn ? 'on' : 'off';
            if (v === this._link) return Promise.resolve();     // set by a button press: already applied
            this._link = v;
        }
        if (key === 'driveLink' && this.linkOn && this.drive != null) {
            const m = flapFor(this.drive);
            if (m) { this.desired = m; this.source = 'drive'; return this.apply(false); }
        }
        if (key === 'driveLink' && !this.linkOn && this.source === 'drive') { this.desired = 'OEM'; this.source = 'press'; return this.apply(false); }
        if (key === 'hold' || key === 'arm') { this._stop(); if (this.armed && this.holdOn && this.sent !== 'OEM') this._schedule(); }
        if (key === 'closeLimit') return this.tick();
        return Promise.resolve();
    }

    _over() { const r = this.rpm(), l = this.limit; return !!(l && r !== null && r > l); }
    /** armed, a limit set, and no live engine speed: the guard can't see, so Close is not held */
    _blind() { return !!(this.armed && this.limit && this.rpm() === null); }

    /** a few times a second: the Close rpm guard and the no-rpm fail-safe */
    tick() {
        // manual CLOSE without a live engine speed (armed, a limit set): OEM, latched until CLOSE is pressed again,
        // even if the engine speed returns
        if (this.source === 'press' && this.desired === 'CLOSED' && this._blind()) {
            this.rpmLost = true;
            this.desired = 'OEM';
            this.paused = false; this.why = null;
            this._stop(); // prevent any queued HOLD from resending CLOSE
            this.log.warn('manual CLOSE lost RPM: requesting OEM; manual reselect required');
            return this.apply(true);
        }
        if (this.desired !== 'CLOSED') { this.paused = false; this.why = null; return Promise.resolve(); }
        const r = this.rpm(), l = this.limit;
        if (!l) { if (this.paused) { this.paused = false; this.why = null; return this.apply(false); } return Promise.resolve(); }
        if (r === null) {
            // DRIVE MODE (Eco Pro) without a live engine speed: paused, not latched; comes back below
            if (this.armed && this.why !== 'nosignal') {
                this.paused = true; this.why = 'nosignal';
                this.log.warn('drive mode CLOSE paused: no valid RPM; requesting OEM');
                return this.apply(false);
            }
            return Promise.resolve();
        }
        if (this.paused && this.why === 'nosignal' && r >= l - HYST) { this.why = 'rpm'; return Promise.resolve(); }  // signal back, still high
        if (!this.paused && r > l) { this.paused = true; this.why = 'rpm'; this.log.info('close paused at ' + Math.round(r) + ' rpm'); return this.apply(false); }
        if (this.paused && r < l - HYST) { this.paused = false; this.why = null; this.log.info('close resumed at ' + Math.round(r) + ' rpm'); return this.apply(false); }
        return Promise.resolve();
    }

    /** send the effective mode if it changed (force: a press always sends) */
    apply(force) {
        this._q = this._q.then(async () => {
            const eff = this.effective();
            if (!force && eff === this.sent) return;
            this._stop();
            await this.c.setMode(eff);
            this.sent = eff;
            if (eff !== 'OEM' && this.armed && this.holdOn) this._schedule();
        }).catch((e) => this.log.error('auto', e)).then(() => this.onChange());
        return this._q;
    }

    _schedule() {
        this._stop();
        this.nextAt = Date.now() + this.holdMs;
        this._timer = setTimeout(() => {
            this._q = this._q.then(async () => {
                const eff = this.effective();
                if (eff === 'OEM' || eff !== this.sent || !this.armed || !this.holdOn) return;
                await this.c.setMode(eff);
                this._schedule();
            }).catch((e) => this.log.error('hold', e)).then(() => this.onChange());
        }, this.holdMs);
    }

    _stop() { clearTimeout(this._timer); this._timer = null; this.nextAt = 0; }

    /** a line for the screen under the state word */
    note() {
        const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        if (this.rpmLost) return { text: 'RPM signal lost · OEM requested · select CLOSE again', warn: true };
        if (this.desired === 'CLOSED' && this.paused && this.why === 'nosignal') return { text: 'RPM signal lost · Close paused · the car has the flap', warn: true };
        if (this.desired === 'CLOSED' && this.paused) return { text: 'Close paused above ' + fmt(this.limit) + ' rpm · the car has the flap', warn: true };
        const parts = [];
        if (this.linkOn) parts.push(this.drive != null && flapFor(this.drive) ? modeName(this.drive) : 'Waiting for the driving mode');
        if (!this.linkOn && this.sent !== 'OEM' && this.armed && this.holdOn && this.nextAt) parts.push('holding');   // not in DRIVE MODE
        return parts.length ? { text: parts.join(' · '), warn: false } : null;
    }
}

module.exports = { AutoFlap, flapFor, modeName, HYST };
