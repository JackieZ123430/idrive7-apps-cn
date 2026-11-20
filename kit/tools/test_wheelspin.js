'use strict';
/* apps/draggy/wheelspin.js: no spin when the wheels follow the body, spin when they run ahead, the slope's offset off. */
const assert = require('assert');
const path = require('path');
const { Wheelspin } = require(path.join(__dirname, '..', '..', 'apps', 'draggy', 'wheelspin.js'));

let n = 0;
const ok = (c, m) => { assert(c, m); n++; console.log('ok   ' + m); };
/* a launch at a m/s^2 on a slope reading `off`; the wheels at `extra` km/h over the body from 0.3 s to 1.3 s */
function run(a, off, extra) {
    const w = new Wheelspin();
    for (let t = 0; t < 2000; t += 20) { w.speed(t, 0); w.accel(t, off); }
    w.launch(2000);
    let vb = 0;
    for (let t = 2000; t <= 5000; t += 20) {
        w.accel(t, a + off);
        w.speed(t, vb + (t >= 2300 && t < 3300 ? extra : 0));
        vb += a * 0.02 * 3.6;
    }
    return w.result();
}
const grip = run(9, 0, 0);
ok(grip.peak <= 2 && grip.secs === 0, 'wheels with the body: no spin (' + grip.peak + ' %)');
const slope = run(9, 0.6, 0);
ok(slope.peak <= 2, 'on a slope (the sensor\'s offset taken off): no spin (' + slope.peak + ' %)');
const spun = run(9, 0, 6);
ok(spun.peak > 30 && spun.secs > 0.3, 'wheels 6 km/h ahead: spin (' + spun.peak + ' %, ' + spun.secs + ' s)');
ok(new Wheelspin().result() === null, 'no acceleration from the car: no estimate');
console.log('wheelspin: ' + n + ' checks pass');
