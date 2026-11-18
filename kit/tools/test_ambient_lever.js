'use strict';
/* apps/ambient_config/lever.js: three quick flasher pulls count once; one or two do not, nor the high beam held, a set
 * that starts too soon after the beam was on, pulls too far apart, or a set in the pause after one. */
const assert = require('assert');
const path = require('path');
const { Lever, beamOf, ARM_MS, PULSE_MS, GAP_MS, COOL_MS } = require(path.join(__dirname, '..', '..', 'apps', 'ambient_config', 'lever.js'));

let n = 0;
const ok = (c, m) => { assert(c, m); n++; console.log('ok   ' + m); };
const pull = (lv, t, ms) => { lv.beam(true, t); return lv.beam(false, t + ms); };
/* three pulls of 0.3 s, 0.4 s apart, from t: whether the last one made the set */
const three = (lv, t) => [pull(lv, t, 300), pull(lv, t + 700, 300), pull(lv, t + 1400, 300)];
const lv = new Lever();
lv.beam(false, 0);
ok(three(lv, ARM_MS + 100).join() === 'false,false,true', 'off 1 s, then three quick pulls: the third makes the set, the first two not');
lv.beam(false, 5000);
ok(!pull(lv, 6200, 300) && !pull(lv, 6900, 300), 'one or two pulls: nothing');
ok(!pull(lv, 6900 + 300 + GAP_MS + 200, 300), 'a third pull too long after the second: no set (a new one starts)');
lv.beam(false, 30000);
ok(!pull(lv, 31100, PULSE_MS + 500), 'the high beam held 2 s: not a pull');
ok(!three(lv, 31100 + PULSE_MS + 500 + 200)[2], 'a set starting 0.2 s after the high beam: not off for 1 s, does not count');
lv.beam(false, 40000);
lv.cool(41000);
ok(!three(lv, 41100)[2], 'within the pause after a set: does not count');
lv.beam(false, 45000);
ok(three(lv, 46100)[2], 'after the pause: counts again');
ok(beamOf('EIN') === true && beamOf('AUS') === false && beamOf(1) === true && beamOf(0) === false && beamOf('UNGUELTIG') === null, 'the signal by name or number');
const l2 = new Lever();
l2.beam(false, 0); l2.beam(null, 500); l2.beam(false, 600);
ok(!three(l2, 1200)[2], 'unknown in between: armed again only after 1 s off');
console.log('ambient lever: ' + n + ' checks pass');
