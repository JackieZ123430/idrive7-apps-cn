'use strict';
/**
 * Synthetic runs for demo mode, 48 s round: a standing launch to ~205 km/h on a slight climb (+0.4 %), braking to a
 * 40 km/h cruise, a rolling pull from it past 200 km/h on a slight descent (-0.6 %), braking to a stop. Under full
 * throttle the gearbox holds each gear to SHIFT_RPM (1-2 at 66 km/h ... 4-5 at 190); cruising and braking, the
 * highest gear above 1400 rpm. The air: 18 deg C, 100.4 kPa.
 */
const PULL = (v0, s) => v0 + (262 - v0) * (1 - Math.exp(-s / 9.4));      // 0-100 ~4.5 s
const KMH_PER_1000 = [null, 9.5, 15, 21, 27.5, 34, 41, 48, 55];        // km/h at 1000 rpm in gears 1..8
const SHIFT_RPM = 6900, IDLE = 850;

class Demo {
    constructor() { this.t0 = Date.now(); }
    _t(now) { return ((now - this.t0) / 1000) % 48; }
    speed(now) {
        const t = this._t(now);
        if (t < 3) return 0;
        if (t < 17) return PULL(0, t - 3);
        if (t < 22) return PULL(0, 14) + (40 - PULL(0, 14)) * (t - 17) / 5;
        if (t < 25) return 40;
        if (t < 38) return PULL(40, t - 25);
        if (t < 44) return Math.max(0, PULL(40, 13) * (1 - (t - 38) / 6));
        return 0;
    }
    /** the road's slope, % */
    slope(now) { return this._t(now) < 22 ? 0.4 : -0.6; }
    /** the engaged gear (1..8) */
    gear(now) {
        const t = this._t(now), v = this.speed(now), full = (t >= 3 && t < 17) || (t >= 25 && t < 38);
        if (full) { for (let g = 1; g < 8; g++) if (v / KMH_PER_1000[g] * 1000 <= SHIFT_RPM) return g; return 8; }
        for (let g = 8; g > 1; g--) if (v / KMH_PER_1000[g] * 1000 >= 1400) return g;
        return 1;
    }
    rpm(now) { const v = this.speed(now); return v < 0.5 ? IDLE : Math.max(IDLE, v / KMH_PER_1000[this.gear(now)] * 1000); }
    temp() { return 18; }
    kPa() { return 100.4; }
}
module.exports = Demo;
