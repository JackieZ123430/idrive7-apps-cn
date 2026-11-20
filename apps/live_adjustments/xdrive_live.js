'use strict';
/**
 * xdrive_live.js - read only: how xDrive shares the drive while driving, for the "xDrive live" tab.
 *
 *   - front / rear split: BasicDataSet.valueDistributionLongitudinalTorqueRearAxisFrontAxis (0.01 % per bit for the
 *     rear axle, as M Vitals reads it), taken when its qualifier says valid and it is not 0 or 65535; a split
 *     between 1 and 99 % says the car has xDrive (kept: the tab then shows without the experimental setting)
 *   - wheel slip: Powertrain.ActualValueRPMWheel, each wheel against the four's average and the front axle
 *     against the rear, in % (its scaling is not known, these ratios need none); above SLIP_KMH only
 *   - steering wheel angle (SteeringAngle, 0.04395 ° per bit, signed), yaw rate (CDS2, 0.005 °/s per bit - 163.84),
 *     lateral and longitudinal g (kit/car.js 'accel')
 *
 *   const x = new XDriveLive(ctx, car);  await x.start();  x.view() -> { rear, wheels: { FL, FR, RL, RR }, axle, steer, yaw, gLat, gLong }
 */
const fs = require('fs');
const path = require('path');

const BDS = 'de.bmw.infrastructure.analytics.BasicDataSet';
const PT = 'de.bmw.powertrain.Powertrain';
const STEER = 'de.bmw.chassis.SteeringAngle';
const CDS2 = 'de.bmw.infotainment.vehicle.CDS2';
const STALE_MS = 3000;
const SLIP_KMH = 5;
const SPLIT_OK = (q) => q === undefined || q === null || q === 2 || q === 10 ||
    q === 'SIGNALWERT_IST_GUELTIG' || q === 'SIGNALWERT_IST_GUELTIG__REKALIBRIERUNGSBEDARF';

class XDriveLive {
    constructor(ctx, car) {
        this.ctx = ctx;
        this.car = car;
        this.log = ctx.log;
        this.file = ctx.dataDir ? path.join(ctx.dataDir, 'xdrive-seen.json') : null;
        this.v = {};
        this.at = {};
        this.seen = false;
        try { this.seen = JSON.parse(fs.readFileSync(this.file, 'utf8')).seen === true; } catch (e) { /* not yet */ }
    }

    put(k, v) { this.v[k] = v; this.at[k] = Date.now(); }
    fresh(k) { return this.at[k] && Date.now() - this.at[k] < STALE_MS ? this.v[k] : null; }

    async start() {
        const w = (i, h) => this.ctx.signals.watch(i, '1', h, this.log).then((s) => { if (s && s.error) this.log.warn('xdrive live: ' + i + ': ' + s.error); });
        await w(BDS, { basicDataSet: (v) => this.split(v) });
        await w(PT, { ActualValueRPMWheel: (v) => this.wheels(v) });
        const steer = (v) => {
            const r = v && v.actualValueSteeringAngleDriver;
            if (typeof r === 'number' && r !== 65535) this.put('steer', (r >= 32768 ? r - 65536 : r) * 0.04395);
        };
        await w(STEER, { ActualSteeringAngleDriver: steer, actualSteeringAngleDriverNoCRC: steer });
        await w(CDS2, { statusYawVelocityVehicle: (v) => { const r = v && v.yawVelocityVehicle; if (typeof r === 'number' && r !== 65535) this.put('yaw', r * 0.005 - 163.84); } });
    }

    split(v) {
        const raw = v && v.valueDistributionLongitudinalTorqueRearAxisFrontAxis;
        if (!SPLIT_OK(v && v.qualifierValueDistributionLongitudinalTorqueRearAxisFrontAxis) || typeof raw !== 'number' || raw === 0 || raw === 65535) return;
        const rear = raw * 0.01;
        if (rear < 0 || rear > 100) return;
        this.put('rear', rear);
        if (!this.seen && rear > 1 && rear < 99) {
            this.seen = true;
            this.log.info('xdrive live: torque goes to the front axle: an xDrive car');
            try { fs.writeFileSync(this.file, JSON.stringify({ seen: true }) + '\n'); } catch (e) { /* read-only */ }
        }
    }

    wheels(v) {
        if (!v) return;
        const ok = (x) => typeof x === 'number' && x < 65534;
        const w = { FL: v.actualValueRPMWheelFLH, FR: v.actualValueRPMwheelFRH, RL: v.actualValueRPMWheelRLH, RR: v.actualValueRPMWheelRRH };
        if (!Object.keys(w).every((k) => ok(w[k]))) return;
        this.put('wheels', w);
    }

    view() {
        const d = this.car.data() || {}, live = !d.demo;
        const out = { rear: this.fresh('rear'), steer: this.fresh('steer'), yaw: this.fresh('yaw'), wheels: null, axle: null,
            gLat: live ? d.gLat : null, gLong: live ? d.gLong : null, seen: this.seen };
        const w = this.fresh('wheels');
        if (w && live && d.speed > SLIP_KMH) {
            const avg = (w.FL + w.FR + w.RL + w.RR) / 4;
            if (avg > 0) {
                out.wheels = {};
                Object.keys(w).forEach((k) => { out.wheels[k] = (w[k] / avg - 1) * 100; });
                const front = (w.FL + w.FR) / 2, rear = (w.RL + w.RR) / 2;
                out.axle = rear > 0 ? (front / rear - 1) * 100 : null;
            }
        }
        return out;
    }
}

module.exports = { XDriveLive, SLIP_KMH };
