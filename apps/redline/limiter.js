'use strict';
/**
 * Part of Redline's experimental features; README.md in this folder has the whole picture
 * (settings, learning, files, logs, rules for this code).
 *
 * Learns the engine's real rev limit from the rpm plateau it makes on the limiter, so the
 * redline (and the shift point from it) fits the car, a tuned one with a raised limiter too.
 *
 * A plateau: in gear and moving, rpm at least `floor`, for at least 500 ms the rpm stays within
 * a 200 rpm band and does not trend (the two halves' averages within 60 rpm: a pull in a tall
 * gear rises slowly but steadily, the limiter bounces about one level). Its top, rounded to 50,
 * counts when the rpm leaves the plateau, only while the oil is warm (the DME limits a cold
 * engine lower). The first value needs two plateaus within 100 rpm (a steady hold in gear looks
 * like one); after that the highest seen is kept in data/limiter.json, so a pull that stops
 * short of the cut never lowers it; "Learn redline" off forgets it.
 *
 *   const lim = new Limiter({ dataDir, log });
 *   lim.feed(tMs, { rpm, gear, speed, warm }, floor, ceil);   // every live sample
 *   lim.value()   -> rpm or null;  lim.waiting() -> the first plateau's rpm or null;
 *   lim.onChange(fn);  lim.forget()
 */
const fs = require('fs');
const path = require('path');
const { writeAtomic } = require('./files');

// the plateau is judged on the last HOLD_MS only, so the end of the run up to it doesn't count
const HOLD_MS = 500, BAND = 200, TREND = 60, WINDOW_MS = HOLD_MS + 20;
// a limiter stops a climb dead: the 500 ms before the plateau must have climbed this fast (a driver
// easing off to hold a steady rpm, e.g. up a hill, slows the climb first)
const APPROACH_MS = 500, APPROACH_RATE = 600, HIST_MS = 1200;

class Limiter {
    constructor(opts) {
        this.log = opts.log;
        this.file = path.join(opts.dataDir, 'limiter.json');
        this.saved = null; this.at = 0;
        this.win = []; this.hist = []; this.peak = null; this.listeners = [];
        try {
            const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (typeof j.rpm === 'number' && j.rpm >= 2500 && j.rpm <= 12000) { this.saved = Math.round(j.rpm / 50) * 50; this.at = j.at || 0; }
        } catch (e) { /* none yet */ }
    }

    value() { return this.saved; }
    /** The first plateau, waiting for a second to confirm it (rpm), or null. Kept in memory only. */
    waiting() { return this.saved === null && typeof this.pending === 'number' ? this.pending : null; }
    onChange(fn) { this.listeners.push(fn); }

    forget() {
        this.pending = null; this.peak = null; this.win.length = 0;   // a half-learned plateau goes too
        if (this.saved === null) return;
        this.saved = null;
        try { fs.unlinkSync(this.file); } catch (e) { /* gone */ }
        this.log.info('limiter: learned redline forgotten');
        this._emit();
    }

    /** One live sample; floor / ceil = the rpm range a limiter can be in for this engine. */
    feed(t, s, floor, ceil) {
        try {
            if (typeof s.rpm === 'number') { this.hist.push([t, s.rpm]); while (this.hist.length && t - this.hist[0][0] > HIST_MS) this.hist.shift(); }
            const ok = typeof s.rpm === 'number' && s.rpm >= floor && s.rpm <= ceil + 300 &&
                !(typeof s.gear === 'number' && s.gear <= 0) && !(typeof s.speed === 'number' && s.speed < 15) && s.warm;
            if (!ok) { this._end(); this.win.length = 0; return; }
            this.win.push([t, s.rpm]);
            while (this.win.length && t - this.win[0][0] > WINDOW_MS) this.win.shift();
            if (t - this.win[0][0] < HOLD_MS - 60) return;
            let lo = Infinity, hi = -Infinity;
            this.win.forEach((w) => { lo = Math.min(lo, w[1]); hi = Math.max(hi, w[1]); });
            if (hi - lo > BAND) return;
            const half = this.win.length >> 1;
            const avg = (a) => a.reduce((x, w) => x + w[1], 0) / a.length;
            if (half < 2 || Math.abs(avg(this.win.slice(0, half)) - avg(this.win.slice(half))) > TREND) return;
            if (this.peak === null && !this._cutOff(this.win[0][0])) return;
            this.peak = Math.max(this.peak || 0, hi);
            this.ceil = ceil;
        } catch (e) { this.log.warn('limiter: ' + e); }
    }

    /** Did the revs climb at least APPROACH_RATE in the APPROACH_MS before t0 (the plateau's start)? */
    _cutOff(t0) {
        let a = null, b = null;
        for (const h of this.hist) {
            if (h[0] <= t0 - APPROACH_MS) a = h;
            if (h[0] <= t0) b = h;
        }
        return !!(a && b && b[0] > a[0] && (b[1] - a[1]) * 1000 / (b[0] - a[0]) >= APPROACH_RATE);
    }

    _end() {
        if (this.peak === null) return;
        let rpm = Math.min(Math.round(this.peak / 50) * 50, this.ceil);
        this.peak = null;
        if (this.saved !== null && rpm <= this.saved) { this.log.info('limiter: plateau at ' + rpm + ' (kept ' + this.saved + ')'); return; }
        // the first value takes two plateaus within 100 rpm (a steady hold in gear looks like one);
        // after that one higher is enough: nothing holds steady above the real cut
        if (this.saved === null) {
            const p = this.pending;
            if (!p || Math.abs(p - rpm) > 100) { this.pending = rpm; this.log.info('limiter: plateau at ' + rpm + ', waiting for a second'); return; }
            rpm = Math.max(p, rpm); this.pending = null;
        }
        this.log.info('limiter: learned ' + rpm + ' rpm' + (this.saved !== null ? ' (was ' + this.saved + ')' : ''));
        this.saved = rpm; this.at = Date.now();
        writeAtomic(this.file, JSON.stringify({ rpm: rpm, at: this.at }), this.log, 'limiter save');
        this._emit();
    }

    _emit() { this.listeners.forEach((fn) => { try { fn(this.saved); } catch (e) { this.log.error(e); } }); }
}

module.exports = Limiter;
