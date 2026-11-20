'use strict';
/**
 * Part of Redline's experimental features; README.md in this folder has the whole picture.
 *
 * The launch score: every standing start timed 0-100 km/h (and 0-60 mph) by the kit's run timer, the same
 * one Drag Timer uses (kit/run_timer.js: launch detection, crossings interpolated between samples), and
 * compared with your best, kept in data/launch.json. For the HUD: last(now, mph) -> the run just finished
 * (for 3 s) as { secs, delta (seconds against the best before it, null for a first run), best (a new best),
 * label, at }, else null. Never throws.
 */
const fs = require('fs');
const path = require('path');
const { writeAtomic } = require('./files');
const { RunTimer } = require('./kit/run_timer');

const SPLITS = [{ key: 'kmh', label: '0-100', from: 0, to: 100 }, { key: 'mph', label: '0-60', from: 0, to: 60 * 1.609344 }];
const SHOW_MS = 3000;
const PLAUSIBLE = { kmh: [1.8, 30], mph: [1.7, 28] };     // seconds: faster than any car, or not a launch

class LaunchScore {
    constructor(opts) {
        this.log = opts.log;
        this.file = path.join(opts.dataDir, 'launch.json');
        this.best = {};                // key -> seconds
        this.done = null;              // { at, result: { key: seconds } , delta: { key: s|null }, pb: { key: bool } }
        try {
            const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            Object.keys(PLAUSIBLE).forEach((k) => { const v = j.best && j.best[k]; if (this._ok(k, v)) this.best[k] = v; });
        } catch (e) { /* none yet */ }
        this.timer = new RunTimer(SPLITS, { onDone: (r) => this._done(r) });
    }

    _ok(k, v) { return typeof v === 'number' && isFinite(v) && v >= PLAUSIBLE[k][0] && v <= PLAUSIBLE[k][1]; }

    /** A speed sample (ms, km/h); live data only. */
    feed(t, kmh) { try { this.timer.feed(t, kmh); } catch (e) { this.log.warn('launch: ' + e); } }
    /** Between samples (the standstill that arms it is counted by the clock). */
    idle(now) { try { this.timer.idle(now); } catch (e) { this.log.warn('launch: ' + e); } }

    _done(r) {
        const res = {}, delta = {}, pb = {};
        Object.keys(PLAUSIBLE).forEach((k) => {
            const v = r.result[k];
            if (!this._ok(k, v)) return;
            res[k] = v;
            delta[k] = this.best[k] === undefined ? null : v - this.best[k];
            pb[k] = this.best[k] === undefined || v < this.best[k];
            if (pb[k]) this.best[k] = v;
        });
        if (!Object.keys(res).length) return;
        this.done = { at: Date.now(), result: res, delta: delta, pb: pb };
        this.log.info('launch: ' + Object.keys(res).map((k) => SPLITS.find((s) => s.key === k).label + ' ' + res[k].toFixed(2) + ' s' +
            (delta[k] === null ? ' (first)' : ' (' + (delta[k] < 0 ? '' : '+') + delta[k].toFixed(2) + ')') + (pb[k] ? ' best' : '')).join(', '));
        if (Object.keys(pb).some((k) => pb[k])) this._save();
    }

    _save() { writeAtomic(this.file, JSON.stringify({ best: this.best, at: Date.now() }), this.log, 'launch save'); }

    /** The run just finished, for the HUD (see the header), in the unit chosen. */
    last(now, mph) {
        const d = this.done, k = mph ? 'mph' : 'kmh';
        if (!d || now - d.at > SHOW_MS || d.result[k] === undefined) return null;
        return { secs: d.result[k], delta: d.delta[k], best: d.pb[k], label: SPLITS.find((s) => s.key === k).label, at: d.at };
    }

    bestOf(mph) { const v = this.best[mph ? 'mph' : 'kmh']; return v === undefined ? null : v; }

    forget() {
        this.best = {}; this.done = null;
        try { fs.unlinkSync(this.file); } catch (e) { /* gone */ }
        this.log.info('launch: best times forgotten');
    }
}

module.exports = LaunchScore;
