'use strict';
/**
 * Part of Redline's experimental features; README.md in this folder has the whole picture.
 *
 * Fuel consumption, for the HUD's fuel readout: the engine unit (DME, 0x12), read once a second while wanted,
 * on the gearbox reader's link. The first source that answers wins (DidReader remembers it), all in l/h:
 *   UDS 22 5656  VOLUM_STROM_KRAFTST_MLS_LOKAL, u16 x 0.00119209 ml/s
 *   OBD 01 5E    engine fuel rate, u16 x 0.05 l/h
 *   UDS 22 4521  fuel mass flow, u16 x 0.1 kg/h, over the fuel's density (petrol 0.745 kg/l, diesel 0.835)
 * Plausible: 0..150 l/h. Smoothed (about 2 s) so the readout doesn't flicker. Never throws; value() is
 *   { lph (litres per hour, or null when not read in the last 3 s) }.
 * fuelItem() turns it and the speed into the HUD's item. Scalings are from the catalogue, not yet checked on a car.
 * A V8 with two engine units (opts.twin, kit/twin_dme.js): 5656 is each unit's own bank (the SGBD's "LOKAL"),
 * so it counts only with the second unit's (0x13) added; else the engine's total rate (OBD 5E). 4521 is not used
 * there (not known to be the whole engine's), so such a car shows no fuel rather than half of it.
 */
const { DidReader } = require('./kit/dids');

const POLL_MS = 1000, STALE_MS = 3000, FAIL_RETRY_MS = 60000;
const TAU_MS = 2000, RESET_MS = 5000;     // smoothing time constant; a longer gap starts again
const DENSITY = { petrol: 0.745, diesel: 0.835 };
const SLOW_KMH = 5;                       // below this (or speed unknown): per hour, not per distance
const GAL_UK = 4.54609, GAL_US = 3.785411784;

/** The candidates, in order; diesel changes only the mass-flow one's density. */
function candidates(diesel) {
    const rho = diesel ? DENSITY.diesel : DENSITY.petrol;
    return [
        { ecu: 0x12, did: '5656', bytes: 2, at: 0, factor: 0.00119209 * 3.6, offset: 0, min: 0, max: 150 },
        { ecu: 0x12, obd: '5E', bytes: 2, at: 0, factor: 0.05, offset: 0, min: 0, max: 150 },
        { ecu: 0x12, did: '4521', bytes: 2, at: 0, factor: 0.1 / rho, offset: 0, min: 0, max: 150 },
    ];
}

/** Bank 2's 5656, from the second engine unit of a two-unit engine. */
const SLAVE_5656 = { ecu: 0x13, did: '5656', bytes: 2, at: 0, factor: 0.00119209 * 3.6, offset: 0, min: 0, max: 150 };

/** Exponential average: prev moved towards x over dtMs (time constant TAU_MS); x itself when there is no prev or the gap is long. */
function smooth(prev, x, dtMs) {
    if (typeof x !== 'number' || !isFinite(x)) return null;
    if (typeof prev !== 'number' || !isFinite(prev) || !(dtMs > 0) || dtMs > RESET_MS) return x;
    return prev + (x - prev) * (1 - Math.exp(-dtMs / TAU_MS));
}

const one = (v, cap) => Math.min(cap, v).toFixed(1);

/**
 * The HUD's readout item, or null when lph is not a number. unit: 'l100' (default), 'mpguk', 'mpgus', 'kml'.
 * Under 5 km/h (or speed unknown) it shows the hourly rate: 'L/H', or 'GAL/H' in that unit's gallons (UK for
 * mpguk, US for mpgus). 0 l/h while moving (fuel cut coasting) shows the best value: '0.0' L/100KM, '999' MPG,
 * '99.9' KM/L.
 */
function fuelItem(lph, kmh, unit) {
    if (typeof lph !== 'number' || !isFinite(lph) || lph < 0) return null;
    unit = unit || 'l100';
    const item = (label, value) => ({ label: label, value: value, tone: 'text' });
    if (typeof kmh !== 'number' || !isFinite(kmh) || kmh < SLOW_KMH) {
        if (unit === 'mpguk') return item('GAL/H', one(lph / GAL_UK, 99.9));
        if (unit === 'mpgus') return item('GAL/H', one(lph / GAL_US, 99.9));
        return item('L/H', one(lph, 999.9));
    }
    if (unit === 'kml') return item('KM/L', lph > 0 ? one(kmh / lph, 99.9) : '99.9');
    const l100 = lph / kmh * 100;
    if (unit === 'mpguk' || unit === 'mpgus') {
        const mpg = l100 > 0 ? (unit === 'mpguk' ? 282.481 : 235.215) / l100 : 999;
        return item(unit === 'mpguk' ? 'MPG' : 'MPG US', String(Math.min(999, Math.round(mpg))));
    }
    return item('L/100KM', one(l100, 99.9));
}

class FuelWatch {
    /**
     * linkOf: () => a ReadOnlyDiag (the gearbox reader's, shared). opts: { diesel: bool or () => bool } (density of
     * 4521): a function is asked on every read, so a diesel found after the start (engine type on Auto, the first
     * run) or set by hand gets its density at once (2026-11-10 review). opts.twin: a kit/twin_dme.js TwinDme.
     */
    constructor(ctx, linkOf, opts) {
        this.ctx = ctx; this.log = ctx.log; this.linkOf = linkOf;
        this.twin = (opts && opts.twin) || null; this.src = '';
        this.dieselOf = typeof (opts && opts.diesel) === 'function' ? opts.diesel : () => !!(opts && opts.diesel);
        this.diesel = !!this.dieselOf();
        this.cands = candidates(this.diesel);
        this.rd = null; this.timer = null; this.busy = false;
        this.lph = null; this.t = 0; this.triedT = 0; this.fails = 0; this.logged = false;
    }

    start() {
        if (this.timer) return;
        try {
            if (!this.rd) this.rd = new DidReader(this.linkOf(), { ecu: 0x12 });
            this._wake();             // a new start (the engine on again): asked even if the link gave up on it
            this.timer = setInterval(() => this._poll(), POLL_MS);
            this._poll();
        } catch (e) { this.log.warn('fuel: ' + (e && e.message || e)); }
    }

    stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

    /** The link stops asking a unit after 5 misses in a row (other readers count too) until it is woken. */
    _wake() {
        const l = this.rd && this.rd.diag;
        if (l && typeof l.wake === 'function') { try { l.wake(0x12); if (this._twinOn()) l.wake(0x13); } catch (e) { /* never */ } }
    }

    /** Two engine units (asks once, in the background, while not known)? */
    _twinOn() { return !!this.twin && this.twin.on(); }

    /**
     * One reading: { v (l/h or null), src }. One engine unit: the first candidate that answers. Two: both units'
     * 5656 added (bank 1 + bank 2), else the engine's total (OBD 5E); never one bank's alone.
     */
    async _read() {
        if (!this._twinOn()) {
            const v = await this.rd.value('fuel', this.cands);
            return { v, src: v === null ? '' : DidReader.label(this.cands[this.rd.pick.fuel || 0]) };
        }
        const a = await this.rd.value('fuel1', [this.cands[0]]);
        if (a !== null) {
            const b = await this.rd.value('fuel2', [SLAVE_5656]);
            if (b !== null) return { v: a + b, src: '5656 of both engine units' };
        }
        const t = await this.rd.value('fuelTotal', [this.cands[1]]);
        return { v: t, src: t === null ? '' : 'OBD 5E' };
    }

    _poll() {
        if (this.busy || !this.rd) return;
        // the shared link not up yet (it comes up a moment after the first reader makes it): not a failed read, which
        // would count towards "no fuel rate on this car" and the minute-long back-off (2026-11-10 review)
        const link = this.rd.diag;
        if (link && (link.ready === false || link.available === false)) return;
        // one engine unit or two not known yet (the first start): no reading, rather than one bank's as the engine's
        // (the answer read at once when it comes, not at the next poll a second later)
        if (this.twin && !this.twin.known()) {
            if (!this.asking) {
                this.asking = true;
                Promise.resolve(this.twin.detect()).then(() => { this.asking = false; if (this.timer && this.twin.known()) this._poll(); }, () => { this.asking = false; });
            }
            return;
        }
        let diesel = this.diesel;
        try { diesel = !!this.dieselOf(); } catch (e) { /* keep the last */ }
        if (diesel !== this.diesel) { this.diesel = diesel; this.cands = candidates(diesel); }
        if (this.fails >= 3) {
            if (Date.now() - this.triedT < FAIL_RETRY_MS) return;     // not answering: once a minute,
            this._wake();                                               // and that try really asks it
        }
        this.busy = true;
        Promise.resolve().then(() => this._read()).then((got) => {
            const now = Date.now(), v = got.v;
            this.triedT = now;
            if (v === null) {
                if (++this.fails === 3) this.log.info('fuel: the engine unit gives no fuel rate (' + (this._twinOn() ? '5656 of both engine units, OBD 5E' : '5656, OBD 5E, 4521') + '); no fuel readout on this car');
                return;
            }
            if (!this.logged || got.src !== this.src) {
                this.logged = true; this.src = got.src;
                this.log.info('fuel: rate read from the engine unit (' + got.src + '), ' + v.toFixed(2) + ' l/h');
            }
            this.fails = 0;
            this.lph = smooth(this.lph, v, this.t ? now - this.t : 0);
            this.t = now;
        }).catch((e) => { this.triedT = Date.now(); this.fails++; this.log.warn('fuel: ' + (e && e.message || e)); })
            .then(() => { this.busy = false; });
    }

    /** Whether the engine unit has given a fuel rate this run (so with the engine off, 0 l/h is the right reading). */
    worked() { return this.logged; }

    /** { lph }: smoothed litres per hour, null when stale or never read. */
    value() {
        const fresh = this.lph !== null && this.t > 0 && Date.now() - this.t <= STALE_MS;
        return { lph: fresh ? this.lph : null };
    }
}

module.exports = FuelWatch;
module.exports.FuelWatch = FuelWatch;
module.exports.smooth = smooth;
module.exports.fuelItem = fuelItem;
module.exports.candidates = candidates;
