'use strict';
/** Synthetic drive for demo mode: a loop of pulls, braking and cornering. */
class Demo {
    constructor() { this.t0 = Date.now(); }
    sample() {
        const t = (Date.now() - this.t0) / 1000;
        const cyc = t % 24;                                   // 24 s lap
        const pull = cyc < 9 ? cyc / 9 : cyc < 12 ? 1 - (cyc - 9) / 3 : 0.25 + 0.15 * Math.sin(cyc);
        const gear = Math.floor((cyc < 9 ? cyc : 9) / 2.2) % 4;
        const rpm = 1500 + ((pull * 4 + gear * 0.7) % 1) * 5600 * Math.max(0.4, pull);
        const corner = Math.sin(t / 3.1);
        const warm = Math.min(1, t / 240);
        const torque = Math.round(120 + pull * 640);
        return {
            rpm, powerCalc: torque * rpm / 9549, speed: 40 + pull * 160 + 10 * Math.sin(t / 5), boost: Math.max(0, pull * 1.7 - 0.15 + 0.05 * Math.sin(t * 3)),
            powerPct: Math.round(pull * 100), torquePct: Math.round(pull * 92), torque,
            coolant: 70 + 22 * warm + 2 * Math.sin(t / 40), oil: 60 + 50 * warm + 6 * pull, gearbox: 45 + 40 * warm + 3 * pull,
            ambient: 17.5 + 0.5 * Math.sin(t / 90),
            gLat: corner * (cyc > 12 ? 1.05 : 0.25), gLong: cyc < 9 ? 0.45 * pull : cyc < 12 ? -0.95 : 0.05 * Math.sin(t),
            splitRear: 62 + 25 * pull, gear: gear + 1, gearMode: pull > 0.9 ? 'S' : 'D',
            tFL: 55 + 30 * warm + 6 * Math.abs(corner), tFR: 57 + 30 * warm + 4 * Math.abs(corner),
            tRL: 60 + 35 * warm + 8 * pull, tRR: 61 + 36 * warm + 8 * pull,
            pFL: 2.3 + 0.25 * warm, pFR: 2.3 + 0.24 * warm, pRL: 2.45 + 0.3 * warm, pRR: 2.1 + 0.28 * warm,
            ptFL: 2.5, ptFR: 2.5, ptRL: 2.7, ptRR: 2.7,
            awd: pull > 0.9 ? '_4WD_ALTERNATIV' : '_4WD_STANDARD', awdQual: 'FUNKTION_VERFUEGBAR_AKTIV',
        };
    }
}
module.exports = Demo;
