'use strict';
/**
 * Run timer: feed it (time ms, speed km/h) samples, it finds the launch and
 * the moments each split was reached. Crossing times are interpolated between
 * samples, so the result does not depend on how often the car sends speed.
 *
 * States: wait  - moving, waiting for the car to stop
 *         ready - stopped >= 1 s (by the clock, see idle()), launch arms automatically
 *         run   - timing
 *         done  - finished (slowed down, all splits done, or 90 s); results kept
 */
const LAUNCH_KMH = 0.5;      // speed that counts as "moving"
const ROLLOUT_M = 0.3048;    // one-foot rollout (drag strip staging beam)
const MAX_RUN_MS = 90000;

/** splits: [{ key, label, from, to } speeds in km/h]  or  { key, label, dist } metres */
class RunTimer {
    constructor(splits, opts) {
        this.splits = splits;
        this.rollout = !!(opts && opts.rollout);
        this.onDone = (opts && opts.onDone) || (() => {});
        this.state = 'wait';
        this.stopSince = null;
        this.prev = null;
        this.clear();
    }

    clear() {
        this.t0 = null; this.dist = 0; this.vmax = 0; this.trace = [];
        this.cross = {};             // km/h or 'd<metres>' -> run time (s)
        this.result = {};            // split key -> seconds
        this.trapSpeed = {};         // distance split key -> km/h at the line
    }

    /** Throw the current run away and wait for the next standstill. */
    reset() { this.clear(); this.state = 'wait'; this.stopSince = null; }

    elapsed(now) {
        if (this.state === 'run' && this.t0 !== null) return (now - this.t0) / 1000;
        if (this.state === 'done' && this.trace.length) return this.trace[this.trace.length - 1][0];
        return 0;
    }

    feed(t, v) {
        const p = this.prev;
        this.prev = { t, v };
        if (v === null || v === undefined || !isFinite(v)) return;
        if (this.state === 'wait' || this.state === 'done' || this.state === 'ready') {
            if (v < LAUNCH_KMH) {
                if (this.stopSince === null) this.stopSince = t;
                if (t - this.stopSince >= 1000 && this.state !== 'ready') this.state = 'ready';
            } else {
                this.stopSince = null;
                if (this.state === 'ready' && p) this._launch(p, { t, v });
            }
            return;
        }
        if (this.state === 'run' && p) this._step(p, { t, v });
    }

    /**
     * Call often (every 50 ms) between samples. A stopped car sends no new speed (the value doesn't
     * change), so the 1 s standstill that arms the timer is counted by the clock here; and the
     * standstill is carried forward to now, so the launch is interpolated from the last moment the
     * car was known to stand, not from a sample seconds old.
     */
    idle(now) {
        const p = this.prev;
        if (this.state === 'run' || !p || typeof p.v !== 'number' || !isFinite(p.v) || p.v >= LAUNCH_KMH || now <= p.t) return;
        if (this.stopSince === null) this.stopSince = p.t;
        if (now - this.stopSince >= 1000) this.state = 'ready';
        this.prev = { t: now, v: p.v };
    }

    _launch(p, c) {
        this.clear();
        this.state = 'run';
        // moment speed crossed the launch threshold
        const f = c.v > p.v ? (LAUNCH_KMH - p.v) / (c.v - p.v) : 0;
        this.tLaunch = p.t + Math.max(0, Math.min(1, f)) * (c.t - p.t);
        this.launchDist = 0;
        if (!this.rollout) this.t0 = this.tLaunch;
        this._step({ t: this.tLaunch, v: LAUNCH_KMH }, c);
    }

    _step(p, c) {
        const dt = (c.t - p.t) / 1000;
        if (dt <= 0) return;
        const d0 = this.dist;
        this.dist += ((p.v + c.v) / 2 / 3.6) * dt;
        // rollout: clock starts after the first foot of travel
        if (this.t0 === null) {
            if (this.dist < ROLLOUT_M) return;
            const f = (ROLLOUT_M - d0) / (this.dist - d0);
            this.t0 = p.t + f * (c.t - p.t);
            this.distOffset = ROLLOUT_M;
        }
        const off = this.distOffset || 0;
        const rt = (x) => (x - this.t0) / 1000;
        this.vmax = Math.max(this.vmax, c.v);
        const last = this.trace[this.trace.length - 1];
        if (!last || rt(c.t) - last[0] >= 0.05) this.trace.push([rt(c.t), c.v]);
        if (this.trace.length > 1800) this.trace = this.trace.filter((_, i) => i % 2 === 0);

        for (const s of this.splits) {
            if (s.dist) {
                const k = 'd' + s.dist;
                const a = d0 - off, b = this.dist - off;
                if (this.cross[k] === undefined && b >= s.dist && b > a) {
                    const f = (s.dist - a) / (b - a);
                    this.cross[k] = rt(p.t + f * (c.t - p.t));
                    this.trapSpeed[s.key] = p.v + f * (c.v - p.v);
                }
            } else {
                for (const target of [s.from, s.to]) {
                    if (!target || this.cross[target] !== undefined) continue;
                    if (c.v >= target && p.v < target) this.cross[target] = rt(p.t + ((target - p.v) / (c.v - p.v)) * (c.t - p.t));
                    else if (c.v >= target && p.v >= target) this.cross[target] = rt(p.t);
                }
            }
            if (this.result[s.key] === undefined) {
                if (s.dist && this.cross['d' + s.dist] !== undefined) this.result[s.key] = this.cross['d' + s.dist];
                if (!s.dist && this.cross[s.to] !== undefined && (!s.from || this.cross[s.from] !== undefined)) {
                    this.result[s.key] = this.cross[s.to] - (s.from ? this.cross[s.from] : 0);
                }
            }
        }
        const allDone = this.splits.every((s) => this.result[s.key] !== undefined);
        if (c.v < this.vmax - 5 || allDone || c.t - this.t0 > MAX_RUN_MS) this._finish(c.t);
    }

    _finish(t) {
        this.state = 'done';
        this.stopSince = null;
        if (Object.keys(this.result).length) this.onDone({ at: Date.now(), result: Object.assign({}, this.result), trap: Object.assign({}, this.trapSpeed), vmax: this.vmax, rollout: this.rollout });
    }
}

module.exports = { RunTimer, LAUNCH_KMH };
