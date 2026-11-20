'use strict';
// Engine Config's xDrive live (apps/live_adjustments/xdrive_live.js): the split taken only when valid, an xDrive
// car remembered, wheel slip against the four's average and front against rear above 5 km/h, steering and yaw.
//   node kit/tools/test_xdrive_live.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { XDriveLive } = require(path.join(__dirname, '..', '..', 'apps', 'live_adjustments', 'xdrive_live'));

let fails = 0, checks = 0;
const ok = (c, msg) => { checks++; if (!c) { fails++; console.log('FAIL ' + msg); } };
const near = (a, b) => Math.abs(a - b) < 0.01;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdl-'));
const h = {};
const ctx = { log: { info() {}, warn() {} }, dataDir: dir, signals: { watch: async (i, inst, fns) => { Object.assign(h, fns); return {}; } } };
let d = { speed: 0, gLat: 0.31, gLong: -0.12 };
const car = { data: () => d };

(async () => {
    const x = new XDriveLive(ctx, car);
    await x.start();
    h.basicDataSet({ valueDistributionLongitudinalTorqueRearAxisFrontAxis: 6000, qualifierValueDistributionLongitudinalTorqueRearAxisFrontAxis: 'SIGNALWERT_IST_UNGUELTIG' });
    ok(x.view().rear === null && !x.seen, 'an invalid split: none');
    h.basicDataSet({ valueDistributionLongitudinalTorqueRearAxisFrontAxis: 6000, qualifierValueDistributionLongitudinalTorqueRearAxisFrontAxis: 'SIGNALWERT_IST_GUELTIG' });
    ok(near(x.view().rear, 60) && x.seen, '60 % to the rear: an xDrive car');
    ok(new XDriveLive(ctx, car).seen, 'remembered for the next start');
    h.ActualValueRPMWheel({ actualValueRPMWheelFLH: 1000, actualValueRPMwheelFRH: 1000, actualValueRPMWheelRLH: 1100, actualValueRPMWheelRRH: 900 });
    ok(x.view().wheels === null, 'standing: no slip');
    d = Object.assign({}, d, { speed: 40 });
    const v = x.view();
    ok(near(v.wheels.RL, 10) && near(v.wheels.RR, -10) && near(v.wheels.FL, 0) && near(v.axle, 0), 'slip against the average, front against rear');
    h.ActualSteeringAngleDriver({ actualValueSteeringAngleDriver: 65536 - 1000 });
    h.statusYawVelocityVehicle({ yawVelocityVehicle: 32768 + 1000 });
    ok(near(x.view().steer, -43.95) && near(x.view().yaw, 5), 'steering and yaw scaled');
    ok(near(x.view().gLat, 0.31), 'g from the car');
    d = Object.assign({}, d, { demo: true });
    ok(x.view().gLat === null, 'never the demo drive');
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('xdrive live: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})();
