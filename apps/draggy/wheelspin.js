'use strict';
/**
 * wheelspin.js - Drag Timer: how much the driven wheels spun right after the launch, an estimate.
 *
 * The car's speed signal comes from its wheels, the acceleration from a sensor in the body. Adding the acceleration
 * up from the launch gives the speed the car really has; where the wheels' speed runs ahead of it, they spin. What the
 * sensor reads while the car stands (the road's slope, its offset) is taken off first. The sum drifts, so only the
 * first WINDOW_MS after the launch count, and speeds under MIN_KMH (where a small difference is a large share) not.
 *
 *   const w = new Wheelspin();
 *   w.accel(t, m/s^2); w.speed(t, km/h)      every sample (t: ms)
 *   w.launch(t)                              the run started
 *   w.result() -> { peak: %, secs: s over SPIN_PCT } | null (no acceleration from the car)
 */
const WINDOW_MS = 3000, MIN_KMH = 8, SPIN_PCT = 10, BIAS_MS = 2000, STAND_KMH = 0.5;

class Wheelspin {
    constructor() { this.reset(); this.bias = 0; this.biasN = 0; }

    reset() { this.t0 = null; this.vb = 0; this.lastA = null; this.peak = 0; this.over = 0; this.lastS = null; this.seen = false; }

    launch(t) { this.reset(); this.t0 = t; }

    accel(t, a) {
        if (typeof a !== 'number' || !isFinite(a)) return;
        if (this.t0 === null) {
            // standing: the sensor's reading then is its offset (slope), averaged over about BIAS_MS
            if (this.standing) { const k = Math.min(1, 50 / BIAS_MS); this.bias = this.biasN ? this.bias + (a - this.bias) * k : a; this.biasN++; }
            return;
        }
        if (t - this.t0 > WINDOW_MS) return;
        if (this.lastA) this.vb += ((this.lastA.a + a) / 2 - this.bias) * Math.max(0, t - this.lastA.t) / 1000 * 3.6;
        this.lastA = { t, a };
        this.seen = true;
    }

    speed(t, kmh) {
        if (typeof kmh !== 'number' || !isFinite(kmh)) return;
        this.standing = kmh < STAND_KMH;
        if (this.t0 === null || t - this.t0 > WINDOW_MS || !this.seen) return;
        const dt = this.lastS === null ? 0 : Math.max(0, t - this.lastS) / 1000;
        this.lastS = t;
        if (kmh < MIN_KMH || this.vb <= 0) return;
        const pct = (kmh - this.vb) / this.vb * 100;
        if (pct > this.peak) this.peak = pct;
        if (pct > SPIN_PCT) this.over += dt;
    }

    result() { return this.seen ? { peak: Math.round(Math.max(0, this.peak)), secs: Math.round(this.over * 10) / 10 } : null; }
}

module.exports = { Wheelspin, WINDOW_MS, MIN_KMH, SPIN_PCT };
