'use strict';
/* apps/warmup/coldstarts.js: starts counted, with cold oil, revved cold; a short stop is the same start; kept. */
const assert = require('assert');
const path = require('path');
const { ColdStarts, OFF_MS } = require(path.join(__dirname, '..', '..', 'apps', 'warmup', 'coldstarts.js'));

let n = 0;
const ok = (c, m) => { assert(c, m); n++; console.log('ok   ' + m); };
const store = {};
const settings = { get: (k) => store[k], set: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
let t = 1000;
const cs = new ColdStarts({ settings, limit: (oil) => (oil < 40 ? 3500 : 4500), warm: () => 90, now: () => t });

cs.oil(12); cs.rpm(0); cs.rpm(800);
ok(cs.stats().starts === 1 && cs.stats().cold === 1, 'a start with 12 deg C oil: a cold start');
t += 1000; cs.rpm(3000);
ok(cs.stats().revved === 0, 'under the cold limit: not revved');
t += 1000; cs.rpm(3900); cs.rpm(4200);
ok(cs.stats().revved === 1, 'past the cold limit: revved cold, once a run');
t += 1000; cs.rpm(0); t += 5000; cs.rpm(900);
ok(cs.stats().starts === 1, 'stopped for 5 s (start-stop): the same start');
t += 1000; cs.rpm(0); t += OFF_MS + 1; cs.oil(95); cs.rpm(900);
ok(cs.stats().starts === 2 && cs.stats().cold === 1, 'a start with warm oil: counted, not cold');
t += 1000; cs.rpm(6000);
ok(cs.stats().revved === 1, 'warm: revving is fine');
ok(store.coldStarts.starts === 2 && store.coldStarts.last.length === 2 && store.coldStarts.last[1].revved, 'kept in the settings, the latest first');
const again = new ColdStarts({ settings, now: () => t });
ok(again.stats().starts === 2, 'the counts go on after a restart');
again.reset();
ok(again.stats().starts === 0 && store.coldStarts.starts === 0, 'reset');
console.log('cold starts: ' + n + ' checks pass');
