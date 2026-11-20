'use strict';
/**
 * Part of Redline's experimental features; README.md in this folder has the whole picture
 * (settings, learning, files, logs, rules for this code).
 *
 * Learns the best upshift rpm per gear from the engine's own torque curve and the gearbox
 * ratios, so the shift light fits this car (a tune that moves the torque curve moves it too).
 *
 * Torque envelope: rpm in 250 rpm bins (1000..9000). Each bin keeps its highest few samples
 * (in gear, moving, torque > 0); the bin's value is the highest sample that has at least 3
 * samples within 5% of it at or below, so a part-throttle sample (lower) never counts and a
 * single spike (alone at the top) is skipped. The point sits at that sample's rpm, not the bin
 * centre, so a falling curve isn't read high.
 *
 * Ratios: k_g = rpm per km/h in gear g, from samples above 20 km/h with the gear steady for 1 s,
 * the ratio steady since the last sample (2%) and within 3% of the gear's median (clutch slip
 * and shifts look like neither). The median of the last 50 is used once 20 are in; 30 rejected
 * in a row means the median was wrong (learned in slip), so the gear starts over.
 *
 * Shift g -> g+1: for r from redline - 2500 to the redline in 50 rpm steps, wheel torque in gear
 * is T(r) * k_g, after the shift (rpm r * k_g+1 / k_g) T(r2) * k_g+1, T linear between the bin
 * points. The shift point is the first r where after >= 0.99 * now (a tie: same wheel torque); none means shift on the limiter
 * (the redline). Unknown (null) until both gears are known and every bin from the lowest r2 to
 * the redline is. Recomputed at most every 2 s; bins and ratios kept in data/shiftmap.json
 * (saved at most every 5 min while something new was learned, and when a shift point changes).
 *
 *   const sm = new ShiftMap({ dataDir, log });
 *   sm.feed(tMs, { rpm, speed, gear, torque });   // every live sample
 *   sm.setRedline(rpm);  sm.shiftFor(gear) -> rpm or null;  sm.table() -> { gear: rpm }
 *   sm.onChange(fn);     sm.forget()
 */
const fs = require('fs');
const path = require('path');
const { writeAtomic } = require('./files');

// TIE: within 1 % counts as equal, so a flat-power engine settles on the earliest equally good point
const TIE = 0.99;
const BIN = 250, LO = 1000, HI = 9000, NBINS = (HI - LO) / BIN + 1;
const TOPK = 8, CONFIRM = 3, NEAR = 0.05;
const RATIO_N = 50, RATIO_KNOWN = 20, RATIO_TOL = 0.03, RATIO_STEP = 0.02, RATIO_RESET = 30;
const STEADY_MS = 1000, CALC_MS = 2000, SAVE_MS = 300000, SPAN = 2500, STEP = 50, MAX_GEAR = 10;

const num = (x) => typeof x === 'number' && isFinite(x);
const binOf = (rpm) => Math.round((rpm - LO) / BIN);

class ShiftMap {
    constructor(opts) {
        this.log = opts.log;
        this.file = path.join(opts.dataDir, 'shiftmap.json');
        this.redline = num(opts.redline) ? opts.redline : null;
        this.listeners = [];
        this._reset();
        try {
            const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (Array.isArray(j.bins)) j.bins.forEach((b, i) => {
                if (i < NBINS && Array.isArray(b)) this.bins[i] = b.filter((p) => Array.isArray(p) && num(p[0]) && num(p[1]) && p[1] > 0 && p[1] < 2000)
                    .sort((x, y) => y[1] - x[1]).slice(0, TOPK);
            });
            if (j.ratios && typeof j.ratios === 'object') Object.keys(j.ratios).forEach((g) => {
                const a = j.ratios[g];
                if (Array.isArray(a) && +g >= 1 && +g <= MAX_GEAR) { const r = this._ratio(+g); r.buf = a.filter((k) => num(k) && k > 0 && k < 1000).slice(-RATIO_N); this._median(r); }
            });
            this._compute(true);
        } catch (e) { /* none yet */ }
    }

    _reset() {
        this.bins = []; for (let i = 0; i < NBINS; i++) this.bins.push([]);
        this.ratios = {};               // gear -> { buf, med, rej }
        this.shift = {};                // gear -> rpm (known ones only)
        this.prev = null; this.gear = null; this.gearAt = 0;
        this.lastCalc = -Infinity; this.lastSave = -Infinity; this.dirty = false;
    }

    onChange(fn) { this.listeners.push(fn); }
    shiftFor(gear) { return this.shift[gear] === undefined ? null : this.shift[gear]; }
    table() { return Object.assign({}, this.shift); }
    /** Gear g's rpm per km/h once known, else null (for the downshift cue and the Learned page). */
    ratio(g) { return this._k(g); }
    /** Learning progress of gear g's ratio: samples so far and how many make it known. */
    ratioProgress(g) { const r = this.ratios[g]; return { n: r ? Math.min(r.buf.length, RATIO_KNOWN) : 0, of: RATIO_KNOWN }; }
    /** The confirmed full-load torque curve: [[rpm, Nm], ...] by rpm (the Learned page's chart). */
    curve() {
        const pts = [];
        for (let i = 0; i < NBINS; i++) { const p = this._point(i); if (p) pts.push([p[0], p[1]]); }
        return pts;
    }

    /**
     * Where the power band starts: the lowest rpm at which the engine makes `share` (0.9) of its peak power
     * (torque x rpm) on the learned curve; null until the curve spans at least 2000 rpm in 5 points.
     */
    bandStart(share) {
        const pts = this.curve();
        if (pts.length < 5 || pts[pts.length - 1][0] - pts[0][0] < 2000) return null;
        const pow = pts.map((p) => p[0] * p[1]), peak = Math.max.apply(null, pow), want = peak * (share || 0.9);
        for (let i = 0; i < pts.length; i++) if (pow[i] >= want) return pts[i][0];
        return null;
    }

    setRedline(rpm) {
        try {
            const r = num(rpm) && rpm > 0 ? Math.round(rpm) : null;
            if (r === this.redline) return;
            this.redline = r;
            this._compute(false);
        } catch (e) { this.log.warn('shiftmap: ' + e); }
    }

    forget() {
        const had = Object.keys(this.shift).length > 0;
        this._reset();
        try { fs.unlinkSync(this.file); } catch (e) { /* gone */ }
        this.log.info('shiftmap: learned torque curve and ratios forgotten');
        if (had) this._emit();
    }

    /** One live sample: rpm, speed (km/h), gear (1..8, 0 N/P, -1 R), torque (crankshaft Nm). */
    feed(t, s) {
        try {
            const rpm = s.rpm, speed = s.speed, gear = s.gear;
            if (gear !== this.gear) { this.gear = gear; this.gearAt = t; this.prev = null; }
            const moving = num(gear) && gear >= 1 && num(rpm) && rpm > 0 && num(speed) && speed > 5;
            if (moving && num(s.torque) && s.torque > 0) this._torque(rpm, s.torque);
            if (moving && speed > 20 && t - this.gearAt >= STEADY_MS) this._sample(t, gear, rpm / speed);
            else this.prev = null;
            if (t - this.lastCalc >= CALC_MS) { this.lastCalc = t; this._compute(false); }
            if (this.dirty && t - this.lastSave >= SAVE_MS) { this.lastSave = t; this._save(); }
        } catch (e) { this.log.warn('shiftmap: ' + e); }
    }

    _torque(rpm, tq) {
        const i = binOf(rpm);
        if (i < 0 || i >= NBINS) return;
        const b = this.bins[i];
        if (b.length >= TOPK && tq <= b[b.length - 1][1]) return;
        let j = b.length; while (j > 0 && b[j - 1][1] < tq) j--;
        b.splice(j, 0, [Math.round(rpm), Math.round(tq * 10) / 10]);
        if (b.length > TOPK) b.pop();
        this.dirty = true;
    }

    /** The bin's confirmed point [rpm, Nm] or null. */
    _point(i) {
        const b = this.bins[i];
        for (let a = 0; a + CONFIRM <= b.length; a++) {
            let n = 0;
            for (let c = a; c < b.length && b[c][1] >= b[a][1] * (1 - NEAR); c++) n++;
            if (n >= CONFIRM) return b[a];
        }
        return null;
    }

    _ratio(g) { if (!this.ratios[g]) this.ratios[g] = { buf: [], med: null, rej: 0 }; return this.ratios[g]; }

    _median(r) {
        if (!r.buf.length) { r.med = null; return; }
        const a = r.buf.slice().sort((x, y) => x - y), m = a.length >> 1;
        r.med = a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
    }

    _sample(t, g, k) {
        const prev = this.prev; this.prev = { t: t, k: k };
        // rpm moving faster than the speed explains (slip, a shift being made): skip
        if (!prev || t - prev.t > 500 || Math.abs(k - prev.k) / prev.k > RATIO_STEP) return;
        const r = this._ratio(g);
        if (r.med !== null && r.buf.length >= 5 && Math.abs(k - r.med) / r.med > RATIO_TOL) {
            if (++r.rej >= RATIO_RESET) { r.buf.length = 0; r.med = null; r.rej = 0; this.log.info('shiftmap: gear ' + g + ' ratio relearning'); }
            return;
        }
        r.rej = 0;
        const was = r.buf.length, old = r.med;
        r.buf.push(k); if (r.buf.length > RATIO_N) r.buf.shift();
        this._median(r);
        // worth saving only while the gear is being learned or when its ratio really moves (0.2 %):
        // a steady cruise must not rewrite the file (flash wear)
        if (was < RATIO_KNOWN || old === null || Math.abs(r.med - old) / old > 0.002) this.dirty = true;
        if (was === RATIO_KNOWN - 1) this.log.info('shiftmap: gear ' + g + ' at ' + r.med.toFixed(2) + ' rpm per km/h');
    }

    _k(g) { const r = this.ratios[g]; return r && r.buf.length >= RATIO_KNOWN ? r.med : null; }

    /**
     * T at rpm, linear between the points; pts sorted by rpm. Past the ends (less than a bin: a
     * point sits within its bin) the end segment's line goes on, so a falling curve isn't held flat.
     */
    _interp(pts, rpm) {
        const n = pts.length;
        if (n === 1) return pts[0][1];
        let i = 1;
        while (i < n - 1 && rpm > pts[i][0]) i++;
        const a = pts[i - 1], b = pts[i];
        if (b[0] === a[0]) return b[1];
        return Math.max(0, a[1] + (b[1] - a[1]) * (rpm - a[0]) / (b[0] - a[0]));
    }

    _shiftPoint(g, pts) {
        const red = this.redline, k1 = this._k(g), k2 = this._k(g + 1);
        if (red === null || k1 === null || k2 === null || !(k2 < k1)) return null;
        const lo = red - SPAN, q = k2 / k1;
        // every bin from the lowest rpm after the shift up to the redline must be known
        const b0 = Math.max(0, binOf(lo * q)), b1 = Math.min(NBINS - 1, binOf(red));
        const use = [];
        for (let i = b0; i <= b1; i++) { const p = pts[i]; if (!p) return null; use.push(p); }
        if (!use.length) return null;
        for (let r = lo; r <= red; r += STEP) {
            const now = this._interp(use, r) * k1, after = this._interp(use, r * q) * k2;
            if (after >= TIE * now) return Math.round(r / 50) * 50;
        }
        return Math.round(red / 50) * 50;
    }

    _compute(quiet) {
        const pts = []; for (let i = 0; i < NBINS; i++) pts.push(this._point(i));
        let changed = false;
        for (let g = 1; g < MAX_GEAR; g++) {
            const v = this._shiftPoint(g, pts), old = this.shiftFor(g);
            if (v === old || (v !== null && old !== null && Math.abs(v - old) < 50)) continue;
            if (v === null) delete this.shift[g]; else this.shift[g] = v;
            changed = true;
            if (!quiet) this.log.info('shiftmap: ' + g + '>' + (g + 1) + ' at ' + (v === null ? 'unknown' : v) + (old !== null ? ' (was ' + old + ')' : ''));
        }
        // a moved point is saved at most once a minute while learning (flash wear); the 5-minute
        // dirty save and the next change catch up
        if (changed && !quiet) { this.dirty = true; if (!(this.lastCalc - this.lastSave < 60000)) { this.lastSave = this.lastCalc; this._save(); } this._emit(); }
    }

    _save() {
        this.dirty = false;
        const ratios = {};
        Object.keys(this.ratios).forEach((g) => { if (this.ratios[g].buf.length) ratios[g] = this.ratios[g].buf.map((k) => Math.round(k * 1000) / 1000); });
        writeAtomic(this.file, JSON.stringify({ bins: this.bins, ratios: ratios, at: Date.now() }), this.log, 'shiftmap save');
    }

    _emit() { const t = this.table(); this.listeners.forEach((fn) => { try { fn(t); } catch (e) { this.log.error(e); } }); }
}

/**
 * The downshift cue's "Best gear": how many gears to drop to land in the power band. allowed: how many
 * the cue allows (each under its shift point), rpmIn(g): the rpm in gear g at this speed, band: bandStart().
 * Already in the band: 0; the fewest drops that reach it; none does: all allowed; no band known: all allowed.
 */
ShiftMap.bestDrop = function (gear, allowed, rpmIn, band) {
    if (!(allowed > 0) || !(band > 0)) return allowed > 0 ? allowed : 0;
    if (rpmIn(gear) >= band) return 0;
    for (let k = 1; k <= allowed; k++) if (rpmIn(gear - k) >= band) return k;
    return allowed;
};

module.exports = ShiftMap;
