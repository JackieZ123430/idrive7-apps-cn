'use strict';
/**
 * roll_timer.js - Drag Timer's rolling windows (100-200 km/h, 60-130 mph ...): timed whenever the car accelerates
 * through one, from a roll or within a standing launch, no stop needed.
 *
 * A window starts when the speed rises through its `from` (the moment interpolated between samples) and is done
 * when it reaches `to`. Lifting (LIFT_KMH under the window's top speed), dropping back under `from`, or taking
 * longer than MAX_MS throws that window away. A pull is the stretch from the first window started until none is
 * still timing; it ends with onDone({ at, t0, result: { key: s }, start: { key: ms }, end: { key: ms }, vmax })
 * when at least one window was done in it.
 *
 * States: idle (no window timing) / run (at least one timing).
 * On screen: result / start / end hold every window's latest time (kept until that window is timed again), pull the
 * keys done in the current (or last) pull; trace, t0, vmax and endAt are the pull's, or the last one that timed
 * something while a pull comes to nothing (cruising right at a window's start).
 */
const LIFT_KMH = 5;            // the same lift as the standing timer's (run_timer.js: vmax - 5)
const MAX_MS = 60000;

class RollTimer {
    /** windows: [{ key, from, to }] km/h, from > 0 */
    constructor(windows, opts) {
        this.windows = windows.filter((w) => w.from > 0 && w.to > w.from);
        this.onDone = (opts && opts.onDone) || (() => {});
        this.onStart = (opts && opts.onStart) || (() => {});
        this.prev = null;
        this.reset();
    }

    reset() {
        this.state = 'idle';
        this.result = {}; this.start = {}; this.end = {};   // key -> s / ms / ms, each window's latest
        this._pullClear();
        this.kept = null;
    }

    _pullClear() {
        this.t0 = null; this.trace = []; this.vmax = 0; this.endAt = undefined;
        this.live = {};          // key -> { start (ms), top (km/h) } windows timing now
        this.pull = {};          // key -> true: done in this pull
    }

    elapsed(now) {
        if (this.state === 'run' && this.t0 !== null) return (now - this.t0) / 1000;
        return this.endAt !== undefined ? this.endAt : 0;
    }

    /** The smallest window start above v (what to accelerate through next), or null. */
    next(v) {
        const up = this.windows.map((w) => w.from).filter((f) => typeof v !== 'number' || !isFinite(v) || f > v);
        return up.length ? Math.min.apply(null, up) : null;
    }

    feed(t, v) {
        const p = this.prev;
        if (typeof v !== 'number' || !isFinite(v)) return;
        this.prev = { t, v };
        if (!p || t <= p.t) return;
        const at = (x) => p.t + (x - p.v) / (v - p.v) * (t - p.t);       // when the speed passed x (p.v != v)
        const done = (w, ts, te) => { this.result[w.key] = (te - ts) / 1000; this.start[w.key] = ts; this.end[w.key] = te; this.pull[w.key] = true; };
        for (const w of this.windows) {
            const lw = this.live[w.key];
            if (lw) {
                lw.top = Math.max(lw.top, v);
                if (v >= w.to) {
                    done(w, lw.start, p.v < w.to ? at(w.to) : p.t);
                    delete this.live[w.key];
                } else if (v < w.from || v < lw.top - LIFT_KMH || t - lw.start > MAX_MS) {
                    delete this.live[w.key];
                }
            } else if (p.v < w.from && v >= w.from) {
                const ts = at(w.from);
                if (this.state !== 'run') this._begin(ts, w.from);
                if (v >= w.to) done(w, ts, at(w.to));            // a sample that jumps past `to` as well
                else this.live[w.key] = { start: ts, top: v };
            }
        }
        if (this.state !== 'run') return;
        this.vmax = Math.max(this.vmax, v);
        const rt = (t - this.t0) / 1000, last = this.trace[this.trace.length - 1];
        if (!last || rt - last[0] >= 0.05) this.trace.push([rt, v]);
        if (this.trace.length > 1800) this.trace = this.trace.filter((_, i) => i % 2 === 0);
        if (!Object.keys(this.live).length) this._finish(t);
    }

    /** Between samples: a window held at a steady speed (no new samples) still times out. */
    idle(now) {
        if (this.state !== 'run') return;
        Object.keys(this.live).forEach((k) => { if (now - this.live[k].start > MAX_MS) delete this.live[k]; });
        if (!Object.keys(this.live).length) this._finish(now);
    }

    _begin(ts, v) {
        // the last pull's trace stays on screen if this one comes to nothing
        if (Object.keys(this.pull).length) this.kept = { t0: this.t0, trace: this.trace, vmax: this.vmax, endAt: this.endAt, pull: this.pull };
        this._pullClear();
        this.state = 'run';
        this.t0 = ts;
        this.trace.push([0, v]);
        this.onStart(ts);
    }

    _finish(t) {
        this.state = 'idle';
        this.live = {};
        this.endAt = (t - this.t0) / 1000;
        const keys = Object.keys(this.pull);
        if (!keys.length) { if (this.kept) Object.assign(this, this.kept); return; }
        const pick = (o) => { const r = {}; keys.forEach((k) => { r[k] = o[k]; }); return r; };
        this.onDone({ at: Date.now(), t0: this.t0, result: pick(this.result), start: pick(this.start), end: pick(this.end), vmax: this.vmax });
    }
}

module.exports = { RollTimer, LIFT_KMH, MAX_MS };
