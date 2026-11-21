'use strict';
/* apps/car_vitals/program.js (#193): with programSteady, an S / M signal that flickers (a module such as M-Track)
 * shows S; M shows once it holds 2 s, as after a paddle press; off: exactly what the car sends. */
const assert = require('assert');
const path = require('path');
const { Program, STEADY_MS } = require(path.join(__dirname, '..', '..', 'apps', 'car_vitals', 'program.js'));

let n = 0;
const ok = (c, m) => { assert(c, m); n++; console.log('ok   ' + m); };
let clock = 0, steady = false, timers = [];
const mk = () => new Program({ steady: () => steady, now: () => clock,
    setTimeout: (f, ms) => { const t = { f, at: clock + ms }; timers.push(t); return t; }, clearTimeout: (t) => { timers = timers.filter((x) => x !== t); } });
const run = (ms) => { clock += ms; timers.filter((t) => t.at <= clock).forEach((t) => { timers = timers.filter((x) => x !== t); t.f(); }); };

let p = mk();
p.set('S'); run(100); p.set('M'); run(100); p.set('S');
ok(p.value === 'S', 'setting off: exactly what the car sends');
p.set('M'); ok(p.value === 'M', 'setting off: M at once');

steady = true; p = mk();
p.set('S');
for (let i = 0; i < 20; i++) { run(300); p.set(i % 2 ? 'S' : 'M'); ok(p.value === 'S', 'flickering S / M: S (' + i + ')'); }
p.set('M'); run(STEADY_MS - 100);
ok(p.value === 'S', 'M not yet held 2 s: still S');
run(200);
ok(p.value === 'M', 'M held 2 s (the paddles): M, without a new notification');
p.set('M'); run(5000); ok(p.value === 'M', 'M repeated: stays M');
p.set('S'); ok(p.value === 'S', 'back to S: S at once');
p.set(null); ok(p.value === null, 'no programme: none');
// switched on while the car shows M from a quick change: S until M has held 2 s
steady = false; p = mk(); p.set('S'); run(100); p.set('M'); ok(p.value === 'M', 'off: M');
steady = true; p.recheck(); ok(p.value === 'S', 'switched on: M only 0.1 s old shows S');
run(STEADY_MS + 50); ok(p.value === 'M', '... then M');
console.log('vitals program: ' + n + ' checks pass');
