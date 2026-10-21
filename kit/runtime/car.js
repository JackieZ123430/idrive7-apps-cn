'use strict';
/**
 * car.js - the common driving signals, scaled, with demo fallback.
 *
 *   const car = new Car(ctx, ['rpm', 'speed', 'accel', 'temps', 'gear', 'torque']);
 *   car.data()      -> { rpm, speed, gLong, gLat, coolant, oil, gear, torque, demo }
 *   car.onSample(fn)-> fn(data, tMs) on every new speed/rpm/accel sample (also in demo, 20 Hz)
 *
 * Scalings are BMW's own (M Laptimer TypeConverters); an app's app.json
 * "config.scaling" entries override them. The app's app.json "signals" must
 * list the interfaces (see SIGNALS below for the exact entries).
 * Demo: setting "demo" = auto (no car data for 5 s) / on / off.
 */
const Sim = require('./sim');

const SCALE = {
    rpm: { factor: 0.25, offset: 0, invalid: 65535 },
    speed: { factor: 0.015625, offset: 0, invalid: 65535 },
    accel: { factor: 0.002, offset: -65, invalid: 65535 },
    temp: { factor: 1, offset: -48, invalid: 255 },
    torque: { factor: 1, offset: 0, invalid: 65535, invalidFrom: 4095 },   // 4095 = 12-bit 'no value'
};
const GEARS = { G1: 1, G2: 2, G3: 3, G4: 4, G5: 5, G6: 6, G7: 7, G8: 8, G9: 9, G10: 10, R: -1, N_OR_P: 0 };
// the binding may hand enums over as names or as wire numbers (G1 = 3 ... G10 = 12, R = 1, N_OR_P = 2)
const gearOf = (x) => (typeof x === 'number' ? (x >= 3 && x <= 12 ? x - 2 : x === 1 ? -1 : x === 2 ? 0 : undefined) : GEARS[x]);

// app.json "signals" entries per group (copy into the app)
const SIGNALS = {
    rpm: ['de.bmw.infotainment.vehicle.CDS', 'statusEngineSpeed2'],
    temps: ['de.bmw.infotainment.vehicle.CDS', 'statusEngineTemperature'],
    speed: ['de.bmw.infotainment.vehicle.Vehicle2', 'statusCarSpeed2'],
    accel: ['de.bmw.infotainment.vehicle.CDS2', 'statusLongitudinalAccelerationMassCenter', 'statusLateralAccelerationMassCenter'],
    gear: ['de.bmw.infrastructure.VehicleInformation', 'statusGearboxDrive'],
    torque: ['de.bmw.infotainment.drivingexcitement.FES', 'statusActualValueTorque2'],
};

/**
 * Learns the gearbox from rpm/speed ratios (one cluster per gear) so a gear
 * can be shown even when the car doesn't publish statusGearboxDrive.
 */
class GearGuess {
    constructor() { this.cl = []; }
    feed(rpm, kmh) {
        if (!(rpm > 1100 && kmh > 8)) return null;
        const k = rpm / kmh;
        let c = this.cl.find((x) => Math.abs(x.k - k) / x.k < 0.05);
        if (!c) { if (this.cl.length > 24) this.cl.sort((a, b) => b.n - a.n).pop(); c = { k, n: 0 }; this.cl.push(c); }
        c.n++; c.k += (k - c.k) / Math.min(c.n, 50);
        const gears = this.cl.filter((x) => x.n > 30).sort((a, b) => b.k - a.k);
        const i = gears.findIndex((x) => Math.abs(x.k - k) / x.k < 0.05);
        return i < 0 ? null : i + 1;
    }
}

class Car {
    constructor(ctx, groups) {
        this.ctx = ctx; this.log = ctx.log;
        const over = (ctx.spec.config && ctx.spec.config.scaling) || {};
        this.S = Object.assign({}, SCALE, over);
        this.live = {}; this.lastCar = 0; this.listeners = [];
        this.sim = new Sim(); this.simData = this.sim.sample();
        this.demoActive = false; this.guess = new GearGuess();
        const sc = (k, raw) => {
            const c = this.S[k];
            if (!c || raw === undefined || raw === null || raw === c.invalid || (c.invalidFrom !== undefined && raw >= c.invalidFrom)) return null;
            return raw * c.factor + (c.offset || 0);
        };
        const put = (k, v, tick) => {
            if (v === null || v === undefined || (typeof v === 'number' && !isFinite(v))) return;
            this.live[k] = v; this.lastCar = Date.now();
            if (k === 'rpm' || k === 'speed') { const g = this.guess.feed(this.live.rpm, this.live.speed); if (g !== null || this.live.speed < 3) this.guessed = this.live.speed < 3 ? 0 : g; }
            if (tick && !this.demoActive) this._emit(this.live, this.lastCar);
        };
        const watches = {};
        const add = (iface, field, fn) => { (watches[iface] = watches[iface] || {})[field] = fn; };
        if (groups.includes('rpm')) add('de.bmw.infotainment.vehicle.CDS', 'statusEngineSpeed2', (v) => put('rpm', sc('rpm', v.actualValueRPMEngineCrankshaft), true));
        if (groups.includes('temps')) add('de.bmw.infotainment.vehicle.CDS', 'statusEngineTemperature', (v) => { put('coolant', sc('temp', v.temperatureEngineDrive)); put('oil', sc('temp', v.temperatureEngineOilDrive)); });
        if (groups.includes('speed')) add('de.bmw.infotainment.vehicle.Vehicle2', 'statusCarSpeed2', (v) => put('speed', sc('speed', v.speedVehicleCentreOfGravity), true));
        if (groups.includes('accel')) {
            add('de.bmw.infotainment.vehicle.CDS2', 'statusLongitudinalAccelerationMassCenter', (v) => { const a = sc('accel', v.longitudinalAccelerationCentreOfGravity); put('gLong', a === null ? null : a / 9.80665, true); });
            add('de.bmw.infotainment.vehicle.CDS2', 'statusLateralAccelerationMassCenter', (v) => { const a = sc('accel', v.lateralAccelerationCentreOfGravity); put('gLat', a === null ? null : a / 9.80665); });
        }
        if (groups.includes('gear')) add('de.bmw.infrastructure.VehicleInformation', 'statusGearboxDrive', (v) => { const g = gearOf(v.statusActualGearDrive); if (g !== undefined) put('gear', g); });
        if (groups.includes('torque')) add('de.bmw.infotainment.drivingexcitement.FES', 'statusActualValueTorque2', (v) => put('torque', sc('torque', v.actualValueTorqueCrankshaft)));
        Object.keys(watches).forEach((iface) => ctx.signals.watch(iface, '1', watches[iface], this.log)
            .then((s) => this.log.info('signal ' + iface.split('.').pop() + (s.error ? ' error: ' + s.error : ' subscribed'))));

        // demo feed (20 Hz) - also keeps the sim warm so switching is seamless. On a busy or
        // slow CPU the timer fires late; replay every missed 50 ms step (up to 3 s) with its own
        // timestamp, so timers, dyno and brake maths see the same data on any machine.
        let simT = Date.now();
        setInterval(() => {
            const now = Date.now();
            if (now - simT > 3000) simT = now - 3000;
            const d = this._wantDemo();
            if (d !== this.demoActive) { this.demoActive = d; this.log.info(d ? 'demo data on' : 'live car data'); this.listeners.forEach((l) => l.reset && l.reset()); }
            while (simT + 50 <= now) {
                simT += 50;
                this.simData = this.sim.sample(simT);
                if (d) this._emit(this.simData, simT);
            }
        }, 50);
    }

    _wantDemo() {
        const m = this.ctx.settings.get('demo');
        return m === 'on' || (m !== 'off' && Date.now() - this.lastCar > 5000);
    }

    data() {
        const src = this.demoActive ? this.simData : this.live;
        const d = Object.assign({}, src, { demo: this.demoActive });
        if (d.gear === undefined && !this.demoActive) { d.gear = this.guessed; d.gearGuessed = true; }
        return d;
    }

    /** fn(data, tMs) per sample; fn.reset() (optional) when the source switches live<->demo. */
    onSample(fn, reset) { this.listeners.push({ fn, reset }); }

    _emit(d, t) {
        const data = Object.assign({}, d, { demo: this.demoActive });
        this.listeners.forEach((l) => { try { l.fn(data, t); } catch (e) { this.log.warn('sample: ' + e); } });
    }
}

Car.SIGNALS = SIGNALS;
Car.GearGuess = GearGuess;
module.exports = Car;
