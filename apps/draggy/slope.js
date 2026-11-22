'use strict';
/**
 * slope.js - Drag Timer: the road's slope under a run, in % (rise over distance; + uphill, - downhill).
 *
 * The body's acceleration sensor reads the car's real acceleration plus the share of gravity along the road
 * (g * sin(slope)); the speed signal gives the real acceleration alone. Over a stretch, per kg:
 *     work the sensor saw  = integral of a * v dt          (kinetic energy + climbing)
 *     kinetic energy       = (v2^2 - v1^2) / 2
 *     climbing             = g * height
 * so height = (integral a v dt - (v2^2 - v1^2) / 2) / g, and the slope is height / distance. That is what a GPS meter
 * gets from its altitude, here from the car's own sensors. Standing, the sensor's reading is the slope where the car
 * stands (averaged over about STAND_MS, from SETTLE_MS after it stopped: the car rocks on its springs first; for the
 * launch the reading from LEAD_MS before the speed showed it moving, as the sensor feels the launch first); stretches
 * shorter than MIN_M (where wheelspin weighs too much) use that one, or the first MIN_M from their start where the car
 * stood too briefly for a reading (wheelspin then shows a little uphill, but a downhill still shows).
 *
 *   const s = new Slope();
 *   s.speed(t, km/h); s.accel(t, m/s^2)       every sample (t: ms)
 *   s.standing()       -> % where the car stands now (null: moving, or no acceleration from the car)
 *   s.at(t)            -> the standing reading kept for a launch at t (the last one before it)
 *   s.over(t1, t2)     -> % over the stretch t1..t2 (ms), null when the car sent no acceleration then
 */
const G0 = 9.80665, STAND_KMH = 0.1, STAND_MS = 1500, SETTLE_MS = 700, LEAD_MS = 500, MIN_M = 30, KEEP_MS = 120000, KEPT_MS = 3000;

class Slope {
    constructor() {
        this.pts = [];          // [t, work (m^2/s^2), distance (m), v (m/s)] at every acceleration sample
        this.v = null; this.vt = null; this.dist = 0; this.work = 0; this.lastA = null;
        this.stand = null;      // { pct, n } the average while standing
        this.kept = null;       // { t, pct } the last standing reading (kept after the launch)
        this.stopT = null;      // when the car came to a stop
        this.hist = [];         // [t, pct] the standing average over the last seconds
    }

    speed(t, kmh) {
        if (typeof kmh !== 'number' || !isFinite(kmh)) return;
        const v = kmh / 3.6;
        if (this.v !== null && t > this.vt) this.dist += (this.v + v) / 2 * (t - this.vt) / 1000;
        if (kmh >= STAND_KMH) {
            if (this.stand) {
                let h = null;
                for (const x of this.hist) if (x[0] <= t - LEAD_MS) h = x;
                this.kept = h ? { t, pct: h[1] } : null;
            }
            this.stand = null; this.stopT = null; this.hist = [];
        } else if (this.stopT === null) this.stopT = t;
        this.v = v; this.vt = t;
    }

    accel(t, a) {
        if (typeof a !== 'number' || !isFinite(a) || this.v === null) return;
        const v = this.v * 3.6 < STAND_KMH ? 0 : this.v;
        if (this.lastA && t > this.lastA.t) {
            const dt = (t - this.lastA.t) / 1000;
            this.work += (this.lastA.a * this.lastA.v + a * v) / 2 * dt;
        }
        this.lastA = { t, a, v };
        if (v === 0 && this.stopT !== null && t - this.stopT >= SETTLE_MS) {
            const pct = Math.max(-30, Math.min(30, a / G0 * 100)), k = Math.min(1, 50 / STAND_MS);
            this.stand = this.stand ? { pct: this.stand.pct + (pct - this.stand.pct) * Math.max(k, 1 / (this.stand.n + 1)), n: this.stand.n + 1 } : { pct, n: 1 };
            this.hist.push([t, this.stand.pct]);
            if (this.hist.length > 10 && t - this.hist[0][0] > 3000) this.hist = this.hist.filter((x) => t - x[0] <= 3000);
        }
        // distance up to this sample: from the last speed sample on at its speed
        const d = this.dist + (this.vt !== null && t > this.vt ? this.v * (t - this.vt) / 1000 : 0);
        this.pts.push([t, this.work, d, v]);
        // the old part dropped now and then (10 s of it at once), not with every sample
        if (t - this.pts[0][0] > KEEP_MS + 10000) this.pts.splice(0, this._index(t - KEEP_MS));
    }

    standing() { return this.stand && this.stand.n >= 5 ? round1(this.stand.pct) : null; }

    at(t) { return this.kept && Math.abs(t - this.kept.t) <= KEPT_MS ? round1(this.kept.pct) : null; }

    /** The first point at or after t (binary search; pts.length when none). col 0: time, 2: distance */
    _index(x, col) {
        const p = this.pts, c = col || 0;
        let lo = 0, hi = p.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (p[m][c] < x) lo = m + 1; else hi = m; }
        return lo;
    }

    _interp(t) {
        const p = this.pts;
        if (!p.length || t < p[0][0] || t > p[p.length - 1][0] + 500) return null;
        const i = this._index(t);
        if (i >= p.length) return p[p.length - 1];
        if (i === 0 || p[i][0] === t) return p[i];
        const a = p[i - 1], b = p[i], f = (t - a[0]) / (b[0] - a[0]);
        return a.map((x, j) => x + (b[j] - x) * f);
    }

    _grade(a, b) {
        const h = ((b[1] - a[1]) - (b[3] * b[3] - a[3] * a[3]) / 2) / G0;
        return round1(Math.max(-30, Math.min(30, h / (b[2] - a[2]) * 100)));
    }

    /** Metres climbed (+) or dropped (-) from t1 to t2, null when the car sent no acceleration then. */
    height(t1, t2) {
        const a = this._interp(t1), b = this._interp(t2);
        if (!a || !b || t2 <= t1) return null;
        return Math.round(((b[1] - a[1]) - (b[3] * b[3] - a[3] * a[3]) / 2) / G0 * 10) / 10;
    }

    over(t1, t2) {
        const a = this._interp(t1), b = this._interp(t2);
        if (!a || !b || t2 <= t1) return this.at(t1);
        if (b[2] - a[2] >= MIN_M) return this._grade(a, b);
        const st = this.at(t1);
        if (st !== null) return st;
        // no standing reading: the first MIN_M from the stretch's start (if the car has gone that far yet)
        const j = this._index(a[2] + MIN_M, 2);
        return j < this.pts.length ? this._grade(a, this.pts[j]) : null;
    }
}

const round1 = (x) => Math.round(x * 10) / 10;

module.exports = { Slope, MIN_M };
