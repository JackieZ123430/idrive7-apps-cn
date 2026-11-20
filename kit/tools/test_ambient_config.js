'use strict';
// Ambient config (apps/ambient_config/ambient.js): the colour by driving mode, the driver's own colour back on
// "Leave as is", a colour chosen in BMW's menu kept as the driver's own, one write at a time with a gap, nothing
// written for a colour the car shows already, and the set struct naming only the slot.
//   node kit/tools/test_ambient_config.js
const path = require('path');
const { Ambient, modeOf, slotOf, request } = require(path.join(__dirname, '..', '..', 'apps', 'ambient_config', 'ambient'));

let fails = 0, checks = 0;
const ok = (c, msg) => { checks++; if (!c) { fails++; console.log('FAIL ' + msg); } };
const log = { info() {}, warn() {}, error() {} };

const mo = (x) => { const r = modeOf(x); return r && r.mode; };
ok(mo('SPORT_DYNAMIC') === 'sport' && mo(2) === 'sport' && mo('ECO_PRO_PLUS') === 'eco' && mo(5) === 'comfort' &&
    mo('ADAPTIVE') === 'adaptive' && mo(10) === 'adaptive' && mo('OFFROAD_ICE') === null && modeOf(undefined) === null, 'driving modes');
ok(mo('PHEV_SPORT_STANDARD') === 'sport' && mo('PHEV_HYBRID_STANDARD') === 'hybrid' && mo('PHEV_HYBRID_ECO') === 'hybrid' && mo('BOOST') === 'sport' && mo('PHEV_SPORT_PLUS') === 'sport' &&
    mo(20) === 'electric' && modeOf('PHEV_ELECTRIC_INDIVIDUAL').phev && !modeOf('SPORT_DYNAMIC').phev, 'a plug-in hybrid\'s modes');
ok(slotOf('FARBAUSWAHL_7') === 7 && slotOf(12) === 12 && slotOf('FARBAUSWAHL_13') === null && slotOf('SIGNAL_UNGUELTIG') === null, 'colour slots');
const r = request(4);
ok(r.controlMenuAmbientePanoramicRoofInteriorLighting === 'FARBAUSWAHL_4' && r.controlModeAmbientePanoramicRoofInteriorLighting === 'SIGNAL_UNBEFUELLT', 'the set names the slot only');

let t = 0;
const writes = [];
const subs = {};
const signals = {
    watch: async (iface, inst, h) => { subs[iface] = h; return { proxy: {}, error: null }; },
    set: async (p, field, v) => { writes.push(slotOf(v.controlMenuAmbientePanoramicRoofInteriorLighting)); },
};
const values = { carKind: 'ice', follow: true, sport: 3, comfort: 0, eco: 5, adaptive: 0, hybrid: 0, electric: 9, restore: true };
const settings = { get: (k) => values[k], set: (k, v) => { values[k] = v; } };
const a = new Ambient({ settings, signals, log, now: () => t });
const colour = (n) => subs['de.bmw.infotainment.misc.ComfortFunctionIuK'].statusAmbientLightInteriorColour({ statusMenuAmbientePanoramicRoofInteriorLighting: 'FARBAUSWAHL_' + n });
const mode = (m) => subs['de.bmw.infotainment.drivingexcitement.FES'].statusFESVehicleDynamicSwitchHMI({ actualValueModeDrivingExperience: m });
const tick = () => new Promise((res) => setImmediate(res));

(async () => {
    await a.start();
    colour(8);
    ok(a.own() === 8, 'the colour at the start is the driver\'s own');
    mode('COMFORT'); await tick();
    ok(writes.length === 0, 'Comfort on Leave as is, the own colour on: nothing');
    mode('SPORT_DYNAMIC'); await tick();
    ok(writes.join() === '3', 'Sport: its colour');
    colour(3);
    ok(a.own() === 8, 'the colour set by the mode is not the driver\'s own');
    mode('COMFORT'); await tick();
    ok(writes.join() === '3', 'within 1.5 s: waits');
    t += 1600; await new Promise((res) => setTimeout(res, 1700)); await tick();
    ok(writes.join() === '3,8', 'Comfort on Leave as is: the driver\'s own back, after the gap');
    colour(8);
    t += 2000;
    mode('ECO_PRO_EFFICIENT'); await tick();
    ok(writes.join() === '3,8,5', 'Eco Pro: its colour');
    colour(5);
    colour(10);       // the driver picks 10 in BMW's menu
    ok(a.own() === 10, 'a colour from BMW\'s menu is the driver\'s own');
    t += 2000;
    mode('COMFORT'); await tick();
    ok(writes.join() === '3,8,5', 'own colour showing: nothing to give back');
    values.restore = false;
    t += 2000;
    mode('SPORT_DYNAMIC'); await tick(); colour(3);
    t += 2000;
    mode('COMFORT'); await tick();
    ok(writes.join() === '3,8,5,3', 'restore off: Leave as is leaves the mode\'s colour');
    t += 2000;
    a.setSlot(6); await tick();
    ok(writes.join() === '3,8,5,3,6' && a.own() === 6, 'by hand: set, and the driver\'s own');
    values.follow = false;
    t += 2000;
    mode('ECO_PRO_EFFICIENT'); await tick();
    ok(writes.length === 5, 'not following: the mode changes nothing');
    ok(a.modes().join() === 'sport,comfort,eco,adaptive', 'a petrol or diesel car\'s modes');
    values.follow = true;
    t += 2000;
    mode('PHEV_ELECTRIC_STANDARD'); await tick();
    ok(values.carKind === 'hybrid' && a.modes().join() === 'sport,hybrid,electric,adaptive', 'a PHEV mode: the hybrid\'s modes (no Comfort, Eco Pro in Hybrid)');
    ok(writes[writes.length - 1] === 9, 'Electric: its colour');
    t += 2000;
    mode('ADAPTIVE'); await tick();
    ok(a.mode() === 'adaptive', 'Adaptive');
    ok(mo('PHEV_ADAPTIVE_NEW') === 'adaptive' && mo('SOMETHING_ELSE') === null, 'an unknown name by its words');
    a.stop();
    console.log('ambient config: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})();
