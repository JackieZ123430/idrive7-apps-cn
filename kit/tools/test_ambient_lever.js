'use strict';
/* apps/ambient_config/lever.js: a short flasher pull counts once; the high beam held, a pull too soon after the beam was
 * on, and one in the pause after a start do not. */
const assert = require('assert');
const path = require('path');
const { Lever, beamOf, ARM_MS, PULSE_MS, COOL_MS } = require(path.join(__dirname, '..', '..', 'apps', 'ambient_config', 'lever.js'));

let n = 0;
const ok = (c, m) => { assert(c, m); n++; console.log('ok   ' + m); };
const pull = (lv, t, ms) => { lv.beam(true, t); return lv.beam(false, t + ms); };
const lv = new Lever();
lv.beam(false, 0);
ok(pull(lv, ARM_MS + 100, 300), 'off 1 s, then a 0.3 s pull: counts');
ok(!pull(lv, ARM_MS + 100 + 300 + 200, 300), 'a second pull 0.2 s later (not off for 1 s): does not');
ok(!pull(lv, 10000, PULSE_MS + 500), 'the high beam held 2 s: not a pull');
lv.cool(20000);
ok(!pull(lv, 20000 + ARM_MS, 300), 'within the pause after a start: does not');
ok(pull(lv, 20000 + COOL_MS + ARM_MS, 300), 'after the pause: counts again');
ok(beamOf('EIN') === true && beamOf('AUS') === false && beamOf(1) === true && beamOf(0) === false && beamOf('UNGUELTIG') === null, 'the signal by name or number');
const l2 = new Lever();
l2.beam(false, 0); l2.beam(null, 500); l2.beam(false, 600);
ok(!pull(l2, 1200, 300), 'unknown in between: armed again only after 1 s off');
console.log('ambient lever: ' + n + ' checks pass');
