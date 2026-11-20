'use strict';
// eDrive's fast power (apps/edrive/fastkw.js): learned from slow, late battery readings against the car's eDRIVE needle,
// it follows the pedal at once, the AC compressor and the rest of the car's draw included.
//   node kit/tools/test_fastkw.js
const path = require('path');
const { FastKw, MIN_FIT } = require(path.join(__dirname, '..', '..', 'apps', 'edrive', 'fastkw'));

let fails = 0, checks = 0;
const ok = (c, msg) => { checks++; if (!c) { fails++; console.log('FAIL ' + msg); } };

// the car: a full needle is 0.9 kW a unit driving, 0.5 recuperating; 1.2 kW of heater and 12 V, the AC 2 kW from 60 s
const A = 0.9, B = 0.5, C = 1.2;
const needleAt = (t) => {
    const s = t / 1000;
    if (s % 20 < 8) return [Math.round(40 + 30 * Math.sin(s)), 0];       // driving, the pedal moving
    if (s % 20 < 12) return [0, Math.round(30 + 20 * Math.sin(s * 2))]; // recuperating
    return [5, 0];                                                       // cruising
};
const acAt = (t) => (t > 60000 ? 2 : 0);
const realAt = (t) => { const [d, r] = needleAt(t); return A * d - B * r + acAt(t) + C; };

const f = new FastKw();
ok(f.now(0) === null, 'nothing before a needle and readings');
let seed = 7;
const noise = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647 - 0.5) * 0.6; };
const errFast = [], errRead = [];
let lastRead = null;
for (let t = 0; t <= 180000; t += 100) {
    const [d, r] = needleAt(t);
    f.needle(d, r, t);
    f.ac(acAt(t));
    // a reading each second, measured 250 ms before it arrives
    if (t % 1000 === 0 && t > 0) { lastRead = realAt(t - 250) + noise(); f.reading(lastRead, t); }
    if (t > 90000) {
        const now = f.now(t);
        if (now !== null) errFast.push(Math.abs(now - realAt(t)));
        if (lastRead !== null) errRead.push(Math.abs(lastRead - realAt(t)));
    }
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
ok(f.fit.n >= MIN_FIT && errFast.length > 800, 'learned (' + f.fit.n + ' readings)');
ok(Math.abs(f.fit.a - A) < 0.05 && Math.abs(f.fit.b - B) < 0.05 && Math.abs(f.fit.c - C) < 0.5,
    'learned the car: ' + f.fit.a.toFixed(2) + ' / ' + f.fit.b.toFixed(2) + ' / ' + f.fit.c.toFixed(2));
ok(mean(errFast) < 0.5 && mean(errFast) < mean(errRead) / 5,
    'fast is real: off by ' + mean(errFast).toFixed(2) + ' kW, the readings by ' + mean(errRead).toFixed(2) + ' kW');

// a step on the pedal shows at once
const g = new FastKw();
for (let t = 0; t <= 30000; t += 100) { const [d, r] = needleAt(t); g.needle(d, r, t); if (t % 1000 === 0 && t) g.reading(realAt(t - 250), t); }
g.needle(90, 0, 30100);
ok(Math.abs(g.now(30100) - (A * 90 + C)) < 2, 'full pedal: ' + g.now(30100).toFixed(1) + ' kW at once');
ok(g.now(30100 + 2000) === null, 'no needle for 2 s: no fast value (the readings shown)');
console.log('fast kW: ' + checks + ' checks, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
