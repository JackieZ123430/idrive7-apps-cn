'use strict';
/**
 * sim.js - a believable simulated drive for demo mode (VM / bench).
 *
 * 46 s loop: idle -> full-throttle pull through gears 1-4 -> lift -> hard stop
 * from ~140 km/h -> a few corners at ~0.9 g -> idle. Engine temperatures
 * start cold and warm up over ~4 minutes. Units: rpm, km/h, g, deg C.
 */
const RATIOS = [0, 4.7, 3.1, 2.1, 1.67, 1.29, 1.0];   // gearbox
const FINAL = 3.15, WHEEL_M = 0.335 * 2 * Math.PI;     // final drive, tyre circumference
const rpmFor = (kmh, g) => (kmh / 3.6) / WHEEL_M * 60 * RATIOS[g] * FINAL;

class Sim {
    constructor() {
        this.t0 = Date.now(); this.last = null;
        this.v = 0; this.gear = 1; this.oil = 18; this.coolant = 20; this.lat = 0;
    }

    sample(now) {
        now = now || Date.now();
        const dt = this.last ? Math.min(0.2, (now - this.last) / 1000) : 0.05;
        this.last = now;
        const t = ((now - this.t0) / 1000) % 46;
        let accel = 0, lat = 0, throttle = 0;
        if (t < 4) { accel = -this.v / 3.6 * 0.5; }                         // roll to a stop / idle
        else if (t < 17) {                                                  // full-throttle pull
            throttle = 1;
            const shifting = this.shiftUntil && now < this.shiftUntil;
            const pwr = 255000 * (0.3 + 0.7 * Math.sin(Math.min(1, (this.rpm || 3000) / 7000) * Math.PI * 0.6));
            accel = shifting ? 0.2 : Math.min(9.5, pwr * 0.85 / 1750 / Math.max(3, this.v / 3.6)) - 0.39 * Math.pow(this.v / 3.6, 2) / 1750 - 0.13;
        } else if (t < 19) { accel = -0.6; }                                // lift
        else if (t < 25) { accel = this.v > 0.3 ? -10.2 : 0; }              // hard stop
        else if (t < 29) { throttle = 0.5; accel = this.v < 70 ? 4.5 : 0; } // back up to speed
        else if (t < 43) {                                                  // corners
            throttle = 0.4; accel = this.v < 75 ? 1.5 : -0.3;
            lat = 0.92 * Math.sin((t - 29) / 14 * Math.PI * 4) * 9.81;
        } else { accel = -2.5; }
        this.v = Math.max(0, this.v + accel * dt * 3.6);
        if (this.v === 0 && accel < 0) accel = 0;

        // gearbox: upshift around 6450-7000 under throttle, downshift below 1400
        if (this.v < 3) this.gear = 1;
        let rpm = Math.max(850, rpmFor(this.v, this.gear));
        if (!this.shiftRpm) this.shiftRpm = 6750;
        if (throttle > 0.9 && rpm > this.shiftRpm && this.gear < 6) { this.gear++; this.shiftRpm = 6450 + Math.random() * 560; this.shiftUntil = now + 180; rpm = rpmFor(this.v, this.gear); }
        if (throttle <= 0.9 && rpm > 3000 && this.gear < 6) { this.gear++; rpm = rpmFor(this.v, this.gear); }
        if (rpm < 1400 && this.gear > 1) { this.gear--; rpm = rpmFor(this.v, this.gear); }
        if (this.v < 3) rpm = throttle > 0.9 ? 3200 : 850 + Math.random() * 20;
        rpm = Math.min(rpm, 7020 + Math.random() * 30);      // rev limiter
        this.rpm = rpm;

        // warm-up: oil lags coolant
        this.coolant = Math.min(92, this.coolant + dt * (0.35 + throttle * 0.5));
        this.oil = Math.min(104, this.oil + dt * (0.22 + throttle * 0.55) * (this.coolant > 70 ? 1.2 : 1));
        this.lat += (lat - this.lat) * Math.min(1, dt * 8);
        return {
            rpm, speed: this.v, gear: this.v < 0.5 && throttle < 0.9 ? 0 : this.gear,
            gLong: accel / 9.81 + (Math.random() - 0.5) * 0.02, gLat: this.lat / 9.81 + (Math.random() - 0.5) * 0.02,
            coolant: this.coolant, oil: this.oil, torque: throttle > 0.9 ? 380 + 200 * Math.sin(Math.min(1, rpm / 7000) * Math.PI) : 40,
            throttle,
        };
    }
}

module.exports = Sim;
