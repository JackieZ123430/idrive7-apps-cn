'use strict';
/** Synthetic launch for demo mode: stand, pull to ~205 km/h, brake, repeat (28 s). */
class Demo {
    constructor() { this.t0 = Date.now(); }
    speed(now) {
        const t = ((now - this.t0) / 1000) % 28;
        if (t < 3) return 0;
        if (t < 17) return 262 * (1 - Math.exp(-(t - 3) / 9.4));       // 0-100 ~4.5 s
        const vTop = 262 * (1 - Math.exp(-14 / 9.4));
        if (t < 23) return Math.max(0, vTop * (1 - (t - 17) / 6));
        return 0;
    }
}
module.exports = Demo;
