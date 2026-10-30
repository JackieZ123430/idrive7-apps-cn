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
            coolant: 70 + 22 * warm + 2 * Math.sin(t / 40), oil: 60 + 50 * warm + 6 * pull, gearbox: 45 + 40 * warm + 3 * pull, egs: 47 + 38 * warm + 4 * pull,
            ambient: 17.5 + 0.5 * Math.sin(t / 90),
            iat: 24 + 14 * warm + 12 * pull, hpfp: 45 + 290 * pull + 10 * Math.sin(t), lpfp: 5.4 - 0.9 * pull + 0.05 * Math.sin(t * 2),
            timing: 14 + 18 * (1 - pull) - 6 * pull + Math.sin(t * 2),
            boostTarget: Math.max(0, pull * 1.75 - 0.1), boostActual: Math.max(0, pull * 1.7 - 0.15 + 0.05 * Math.sin(t * 3)),
            loadTarget: 18 + pull * 150, loadActual: 17 + pull * 146 + 3 * Math.sin(t * 2), misfire: [0, 0, t > 30 ? 1 : 0, 0, 0, 0],
            gLat: corner * (cyc > 12 ? 1.05 : 0.25), gLong: cyc < 9 ? 0.45 * pull : cyc < 12 ? -0.95 : 0.05 * Math.sin(t),
            splitRear: 62 + 25 * pull, gear: gear + 1, gearMode: pull > 0.9 ? 'S' : 'D',
            tFL: 55 + 30 * warm + 6 * Math.abs(corner), tFR: 57 + 30 * warm + 4 * Math.abs(corner),
            tRL: 60 + 35 * warm + 8 * pull, tRR: 61 + 36 * warm + 8 * pull,
            pFL: 2.3 + 0.25 * warm, pFR: 2.3 + 0.24 * warm, pRL: 2.45 + 0.3 * warm, pRR: 2.1 + 0.28 * warm,
            ptFL: 2.5, ptFR: 2.5, ptRL: 2.7, ptRR: 2.7,
            zf: { gear: String(gear + 2), sel: 'D', tcc: pull > 0.3 ? 'Locked' : 'Slipping', turbine: rpm, output: rpm / [3.2, 2.143, 1.72, 1.313][gear] },
            awd: pull > 0.9 ? '_4WD_ALTERNATIV' : '_4WD_STANDARD', awdQual: 'FUNKTION_VERFUEGBAR_AKTIV',
        };
    }
}
module.exports = Demo;
