'use strict';
/* apps/live_adjustments/rescan.js (#147): the engine unit or the DSC asleep at start-up are looked for again once the
 * ignition is on, not only when a setting changes; nothing while the ignition is off, in demo, or once found. */
const assert = require('assert');
const path = require('path');
const { rescan, SLOW_MS, TRIES } = require(path.join(__dirname, '..', '..', 'apps', 'live_adjustments', 'rescan.js'));

let n = 0;
const ok = (c, m) => { assert(c, m); n++; console.log('ok   ' + m); };
(async () => {
    let clock = 0;
    const said = [];
    const car = { v: { condition: 5, rpm: 0, demo: false }, data() { return Object.assign({}, this.v); } };
    // the DSC answers only once the ignition is on (as a sleeping car's)
    const xdrive = { enabled: true, index: null, busy: false, reading: false, refreshes: 0,
        refresh() { this.refreshes++; if (car.v.condition >= 7) this.index = '0F2850'; return Promise.resolve(); } };
    let dmePresent = false, dmeRefreshes = 0;
    const controller = { link: { available: true }, refresh() { dmeRefreshes++; if (car.v.condition >= 7) dmePresent = true; return Promise.resolve(); } };
    const tick = rescan({ car, dmeLost: () => !dmePresent, xdrive, controller, log: { info: (m) => said.push(m), error() {} }, now: () => clock });

    await tick(); await tick();
    ok(xdrive.refreshes === 0 && dmeRefreshes === 0, 'ignition off: nothing is asked');
    car.v.demo = true; car.v.condition = 10;
    await tick();
    ok(xdrive.refreshes === 0, 'demo data: nothing is asked');
    car.v.demo = false;
    await tick();
    ok(xdrive.refreshes === 1 && dmeRefreshes === 1 && xdrive.index === '0F2850' && dmePresent, 'ignition on: the engine unit and the DSC found');
    ok(said.length === 1 && /the engine unit and the DSC not found yet/.test(said[0]), 'logged once, what it looks for');
    await tick(); await tick();
    ok(xdrive.refreshes === 1 && dmeRefreshes === 1, 'found: not asked again');

    // a DSC that never answers (xDrive on, a car without it): every tick for TRIES tries, then once a minute, logged only TRIES times
    xdrive.index = null; xdrive.refresh = function () { this.refreshes++; return Promise.resolve(); }; xdrive.refreshes = 0; said.length = 0;
    for (let i = 0; i < TRIES + 3; i++) { clock += 15000; await tick(); }
    ok(xdrive.refreshes === TRIES, 'never answers: ' + TRIES + ' quick tries (' + xdrive.refreshes + ')');
    clock += SLOW_MS; await tick();
    ok(xdrive.refreshes === TRIES + 1 && said.length === TRIES, 'then once a minute, without more log lines');
    car.v.condition = 5; car.v.rpm = 800; clock += SLOW_MS; await tick();
    ok(xdrive.refreshes === TRIES + 2, 'engine running counts as ignition on (a car without the state)');
    xdrive.busy = true; clock += SLOW_MS; await tick();
    ok(xdrive.refreshes === TRIES + 2, 'not while an xDrive command is under way');
    console.log('engine config rescan: ' + n + ' checks pass');
})().catch((e) => { console.error(e); process.exit(1); });
