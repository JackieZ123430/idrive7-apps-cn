'use strict';

// kit/car's gear on a manual (issue #209): the car sends the gear selection "R" with reverse in and "no value"
// (INITIALISIERUNG) otherwise, and no gear number; the gear is then learned from the rpm and speed and kept for
// the next drive. No SDK, vehicle or capture needed:
//   node kit/tools/test_car_gear.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const Car = require(path.join(__dirname, '..', 'runtime', 'car.js'));

let failed = 0;
const check = (name, fn) => {
    try { fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message); }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'car-gear-'));
const quiet = { info() {}, warn() {}, error() {} };
function newCar() {
    const h = {};
    const ctx = {
        log: quiet, spec: {}, dataDir: dir,
        settings: { get: (k) => (k === 'demo' ? 'off' : undefined) },
        signals: { watch: (iface, v, fields) => { Object.assign(h, fields); return Promise.resolve({ available: true }); } },
    };
    return { car: new Car(ctx, ['rpm', 'speed', 'gear'], {}), h };
}
const sel = (h, x) => h.DataPowerTrain2({ statusGearSelectionDrive: x });
const drive = (h, rpm, kmh) => {
    h.statusEngineSpeed2({ actualValueRPMEngineCrankshaft: rpm / 0.25 });
    h.statusCarSpeed2({ speedVehicleCentreOfGravity: kmh / 0.015625 });
};
// rpm per km/h in each gear of a six-speed manual
const K = [4.11, 2.32, 1.54, 1.18, 1.0, 0.85].map((x) => x * 30);
const inGear = (h, n, times) => { for (let i = 0; i < (times || 40); i++) drive(h, 3000, 3000 / K[n - 1]); };

const a = newCar();
check('manual: "R" shows R while reverse is in', () => {
    sel(a.h, 'INITIALISIERUNG');
    sel(a.h, 'R');
    const d = a.car.data();
    assert(d.stage === 'R' && d.gear === -1, JSON.stringify(d));
});
check('manual: back to "no value" when out of reverse: no longer R, the gear from the rpm and speed', () => {
    sel(a.h, 'INITIALISIERUNG');
    for (let n = 1; n <= 6; n++) inGear(a.h, n);
    inGear(a.h, 3, 5);
    const d = a.car.data();
    assert(d.stage === undefined, 'stage ' + d.stage);
    assert(d.gear === 3 && d.gearGuessed, JSON.stringify(d));
});
check('automatic: a gear from the gearbox stays through a "no value" selection', () => {
    const b = newCar();
    b.h.statusGearboxDrive({ statusActualGearDrive: 'G4', statusActualStageDrive: 'D' });
    sel(b.h, 'INITIALISIERUNG');
    const d = b.car.data();
    assert(d.gear === 4 && d.stage === 'D' && !d.gearGuessed, JSON.stringify(d));
});
check('the learned gears are kept: next drive, 3rd reads 3 before 1st and 2nd were used', () => {
    fs.writeFileSync(path.join(dir, 'gear_ratios.json'), JSON.stringify({ gears: a.car.guess.save() }));
    const c = newCar();
    inGear(c.h, 3, 1);
    assert(c.car.data().gear === 3, 'got ' + c.car.data().gear);
});
check('without them, 3rd driven first reads 1 (the ratios are numbered as seen)', () => {
    fs.unlinkSync(path.join(dir, 'gear_ratios.json'));
    const c = newCar();
    inGear(c.h, 3);
    assert(c.car.data().gear === 1, 'got ' + c.car.data().gear);
});
check('a gear not used for 5 drives is dropped (a slipping clutch, a changed final drive)', () => {
    const g = new Car.GearGuess();
    g.load([{ k: 50, age: 0 }, { k: 90, age: 5 }]);
    const s = g.save();
    assert(s.length === 1 && s[0].k === 50 && s[0].age === 1, JSON.stringify(s));
    g.load([{ k: 'x' }, null, { k: -3 }]);
});

fs.rmdirSync(dir, { recursive: true });
console.log(failed ? 'car gear: ' + failed + ' FAILED' : 'car gear: all ok');
process.exit(failed ? 1 : 0);
