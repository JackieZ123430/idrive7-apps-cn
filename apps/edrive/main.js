'use strict';
/**
 * eDrive - what the high-voltage battery really gives you.
 *
 *   - real electric range: the charge above the one the engine starts at, divided by what
 *     this car uses: per km for driving (learned from electric-only driving, last ~60 km)
 *     plus per hour for climate control and the on-board electrics (heating when cold,
 *     A/C when hot: it costs range by the hour, so more of it in slow traffic). The hourly
 *     draw is learned per outside-temperature band, mostly from standing / creeping with
 *     the engine off; until then a typical draw for the temperature (AUX_KW) is used.
 *     Driving is learned per speed band and the range uses your current pace (motorway
 *     costs more per km than town); the climate's draw is learned while driving too (what it
 *     uses above the same speed with the climate off). Seat and steering-wheel heating are
 *     counted on their own (estimated from their levels), the blower within the climate.
 *   - Energy page: use per speed band, where the power goes now, the car's own power
 *     distribution display, HV battery temperature
 *     Climate control on or off comes from the car (ClimateMaster.statusClimateSystemOn):
 *     off, only the on-board electrics are taken off the range (learned separately), so
 *     the range goes up when you switch the climate off and down when you switch it on.
 *     Before any electric driving is learned: the range a full battery gives at the outside
 *     temperature (RANGE_CURVE, scaled to your "range when full, 20 °C").
 *     The engine-start charge is learned from engine starts while driving at <= 20 %.
 *   - battery health (SOH): usable capacity compared to a new battery
 *   - energy in the battery now: charge x SOH x size when new (kWh)
 *   - last charge: how much the HV battery gained on the last charge (also a
 *     charge done while the head unit was asleep: the charge at switch-off is
 *     kept and compared at the next start)
 *   - 12 V battery voltage
 *   - charge log page: every charge with energy, range and (optional) cost,
 *     monthly / all-time totals and a 14-day chart
 *   - which system the car has (setting "Drive system", else found by itself and remembered):
 *     a plug-in hybrid (the high-voltage battery unit answers): all of the above;
 *     a 48 V mild hybrid (no high-voltage battery, the 48 V battery BATT48 answers): its own page
 *     only - the 48 V battery's charge, voltage, power, health and temperature, the 48 V / 12 V
 *     converter (PCU48) and the 12 V battery it charges;
 *     neither: the 12 V battery with what the engine unit's battery sensor gives (current, charge,
 *     health, temperature) and the alternator's current;
 *     a fully electric car (BEV, e.g. the iX3 G08; setting "Fully electric", or found by itself: the battery
 *     unit holds more than config.battery.bevMinKwh usable): the plug-in hybrid's pages without the engine -
 *     the range counts down to 0 % (or the "range counts down to" setting), the engine-speed signal is not
 *     used (a car without an engine may send none, or its motor's speed), the use per km is learned from
 *     all driving, and the battery's own kWh (stored now and usable, config.battery.energy) give the kWh
 *     per % and the health against "usable battery when new"
 *
 * Charge, SOH and 12 V are read with UDS ReadDataByIdentifier over the head
 * unit's diagnostic link (kit/diag.js); the DIDs and scalings live in app.json
 * "config.battery" so they can be adjusted per model. Outside temperature,
 * speed and climate control on / off come over SOME/IP.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { Diag, hex } = require('./kit/diag');
const { DidReader } = require('./kit/dids');
const { t: translate, plural } = require('./kit/i18n');
const { RangeModel, curve } = require('./range');
const startLive = require('./live');
const startBattery12 = require('./battery12');
const Car = require('./kit/car');

const W = 1600, H = 520;
const GO = '#2fd27a';
// the live pages (battery; the battery unit and scan in the Diagnostic page) are live.js's, the 12 V ones battery12.js's
const PAGES_HYBRID = ['main', 'energy', 'battery', 'log', 'diag'];
const PAGES_12V = ['main', 'hist12', 'diag'];
const PAGES_48V = ['main', 'b48info', 'diag'];
// what the Diagnostic page lists per system (config.battery keys)
const VALUES_12V = ['i12', 'soc40', 'soc12', 'cap12', 'soh12', 't12', 'alt12'];
const VALUES_48V = ['b48', 'dc48'];
// the 48 V / 12 V converter's operating mode (PCU48 STAT_BETRIEBSMODUS)
const DC_MODES = { 3: 'Standby', 5: 'Error', 6: 'Precharge', 8: 'Standby', 9: 'Charging 12 V', 10: 'Charging 48 V',
    12: 'Emergency mode', 13: 'Crash', 14: 'Diagnostic', 15: 'Diagnostic' };
const DIAG_PAGES = ['diag'];
// the Diagnostic page: one scrolling page of these parts (the battery unit and scan: hybrids only)
const DIAG_PARTS_HYBRID = ['diag', 'unit', 'scan', 'signals'];
const DIAG_PARTS_12V = ['diag', 'signals'];
const DIAG_STEP = 492;           // each part is a full page (panel 44..512) plus a gap
/** Comfort consumers, estimated from their levels (kW): seat heating per level 0..3, steering wheel. */
const SEAT_KW = [0, 0.04, 0.07, 0.1];
const WHEEL_KW = 0.06;
/** Blower (part of the climate draw): about BLOWER_KW[0] + BLOWER_KW[1] x (level / top level)^2. */
const BLOWER_KW = [0.03, 0.32];
const PACE_TAU = 300;            // s: the pace follows the last few minutes of driving
const PACE_KEEP = 15 * 60000;    // ms without moving after which there is no "current pace"
const LOG_MAX = 200;             // charges kept in the log
const LOSS = 1.1;                // grid energy per kWh stored (charger + battery losses, estimate)
const KM_MI = 0.621371;
const VALUES = ['soc', 'soh', 'v12'];
const RESERVE = 8;               // engine-start charge (%) until two engine starts have been seen
// Low battery: the car holds the charge at about 5-11 % and drives as a hybrid - electric only up to
// 62 km/h with light throttle (~18 %), the engine above; lifting off / braking recharge it. Engine starts
// there come from speed / throttle, not from an empty battery, and the charge moves with regen: nothing
// in this zone teaches the range, and the range counts down to its top.
const HOLD_TOP = 11;
const ASLEEP_MS = 10 * 60000;     // a gap this long between charge readings: the car was off meanwhile
const JUMP_PCT = 10;              // the charge this much higher than the reading before: charged meanwhile
const REST_RISE = 0.5;            // % above the lowest charge since standing: charging (also in steps under 0.3 %)
const NO_ENGINE = [0x12, 0x13, 0x18];     // engine units (DME, DME 2) and the gearbox unit (EGS): not on a fully electric car

/**
 * Range of a full battery by outside temperature, for a car doing 50 km at 20 °C:
 * [°C, low km, high km]. Linear in between; warmer than 20 °C counts as 20 °C, colder
 * than -10 °C continues the -10..0 slope (never below 30 % of the 20 °C range).
 * Scaled by the "range at 20 °C" setting.
 */
const RANGE_CURVE = [[-10, 20, 30], [0, 30, 38], [10, 40, 45], [20, 50, 50]];
/**
 * Fully electric, before its driving is learned: what a car like the iX3 (heat pump) typically uses per 100 km by
 * outside temperature, climate included: [°C, kWh]. The range of a full battery is its usable kWh over this.
 */
const BEV_USE = [[-10, 27], [0, 23], [10, 19.5], [20, 17.5], [30, 18.5]];
const BEV_LO = 0.88, BEV_HI = 1.08;      // the spread shown around it until learned

/** Demo: charge drains, outside temperature swings across the cold threshold. full(): the battery's kWh. */
class Demo {
    constructor(full) { this.t0 = Date.now(); this.full = full || (() => 12); }
    sample() {
        const s = (Date.now() - this.t0) / 1000, soc = 100 - (s * 0.8) % 95, cap = this.full() * 0.978;
        return {
            soc, soh: 91.5, ambient: 6 + 14 * Math.sin(s / 12), v12: 12.45 + 0.05 * Math.sin(s / 5),
            climate: s % 30 < 10 ? 'ac' : s % 30 < 20, ac: s % 30 < 10,
            pace: 55 + 25 * Math.sin(s / 20), seats: { DR: 2, PS: s % 30 < 15 ? 1 : 0 }, wheel: true, blower: 4,
            batt: { avg: 18, min: 17, max: 20 }, cap, stored: cap * soc / 100,
            charge: { from: 28, to: 97, toT: this.t0 - 3 * 3600000, kwh: 69 / 100 * this.full() * 0.915 },
            b48: { v: 47.4 + Math.sin(s / 6), a: -18 * Math.sin(s / 6), temp: 24, soc: 62 + 6 * Math.sin(s / 30), soh: 96,
                kwh: 412.6, ahIn: 9112.4, ahOut: 9087.9, socQ: 92, pack: 47.38, capNom: 11.0, rNew: 9.25, rNow: 11.5, capMeas: 10.6, capNow: 10.4, sohQ: 88 },
            dc: { mode: 9, v12: 14.1, v48: 47.4, a12: 34 + 4 * Math.sin(s / 4), a48: -10.5, w12: 480, w48: -498 },
            x12: { i12: 2.4 + Math.sin(s / 5), soc12: 84, soh12: 92, t12: 19, alt12: 38 },
        };
    }
    log() {
        if (!this._log) {
            // ~3 weeks of plausible charges, newest last
            this._log = [];
            let t = this.t0 - 21 * 86400000;
            for (let i = 0; i < 16; i++) {
                t += (0.8 + ((i * 37) % 10) / 10) * 86400000;
                const from = 12 + (i * 23) % 40, to = Math.min(100, from + 35 + (i * 17) % 50);
                this._log.push({ from, to, fromT: t - 4 * 3600000, toT: t });
            }
        }
        // the energy as the battery's size now (the drive system can change)
        return this._log.map((c) => Object.assign({ kwh: (c.to - c.from) / 100 * this.full() * 0.915 }, c));
    }
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const cfg = Object.assign({ ecu: 7, soc: [], soh: [], v12: [], chargeMinPct: 3 },
            (ctx.spec.config && ctx.spec.config.battery) || {});
        const S = (ctx.spec.config && ctx.spec.config.scaling) || {};
        const sc = (k, raw) => {
            const c = S[k];
            if (!c || raw === undefined || raw === null || raw === c.invalid) return null;
            const v = raw * c.factor + (c.offset || 0);
            return c.max != null && v > c.max ? null : v;
        };

        /* ---------- persisted state: SOH, the last charge reading and the last charge session ---------- */
        const STATE = path.join(ctx.dataDir, 'battery.json');
        let st = {};
        try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')) || {}; } catch (e) { /* first run */ }
        if (st.lastCharge && !st.log) st.log = [st.lastCharge];      // saved by v1.1 (no log yet)
        // learned before 1.8 the use per km also held the climate draw: keep it, but light, so it relearns soon
        if (st.learn && st.rangeV !== 2) { const f = Math.min(1, 10 / st.learn.km); st.learn.km *= f; st.learn.pct *= f; }
        st.rangeV = 2;
        const model = new RangeModel(st);
        let savedAt = 0, saved = JSON.stringify(st);
        const save = () => {
            savedAt = Date.now(); saved = JSON.stringify(st);
            try { fs.writeFileSync(STATE, saved); } catch (e) { log.warn('save: ' + e); }
        };
        // MainApp's shutdown: what changed since the last save (the last charge reading, learning) goes with it
        process.on('exit', () => { if (JSON.stringify(st) !== saved) save(); });
        const live = { soc: null, socT: 0, soh: G.isNum(st.soh) ? st.soh : null, sohT: st.sohT || 0, v12: null, v12T: 0, ambient: null, speed: null, rpm: null, rpmT: 0,
            climate: null, ac: null, seats: {}, wheel: null, blower: null, blowerTop: 8, pd: null, batt: null, hvV: null,
            pace: null, lastMove: 0, raw: {}, standSince: 0, acRaw: null, acKw: null, lscV: null, lscVT: 0,
            b48: null, b48T: 0, dc: null, dcT: 0, x12: {}, x12T: {}, bat12: null, bat12T: 0,
            // fully electric: the battery's own kWh (stored now, usable), the last speed signal (the car awake), the lowest
            // charge since the car stopped (a charge adding little per reading still counts)
            cap: null, capT: 0, stored: null, storedT: 0, speedT: 0, rest: null };

        /* ---------- electric driving: what the car really does per % ----------
         * seg = distance since the last charge reading, and whether the engine ran meanwhile.
         * At the next reading, a stretch driven with the engine off adds its km and % used to
         * st.learn (km per %); an engine start while driving at a low charge is where this car
         * stops driving electric (st.engineStarts). */
        const seg = { km: 0, engine: false, engineAll: false, climate: null, climateMixed: false, comfort: 0 };
        let lastSpeedT = 0;
        const STOP_MS = 5 * 60000;       // standing longer than this is parking, not traffic: the pace stops
        const onSpeed = (kmh) => {
            const now = Date.now();
            if (lastSpeedT && G.isNum(kmh)) {
                const dt = G.clamp(now - lastSpeedT, 0, 2000);
                seg.km += kmh * dt / 3600000;
                // the pace: the last few minutes of ELECTRIC driving, stops in traffic included (they cost
                // the climate draw too). Driving on the engine doesn't count (it says nothing about how
                // you drive electric): after PACE_KEEP without electric driving the typical speed is used
                const engineOn = G.isNum(live.rpm) && live.rpm > 400 && now - live.rpmT < 5000;
                if (kmh > 3 && !engineOn) live.lastMove = now;
                if (!engineOn && now - live.lastMove < STOP_MS) {
                    live.pace = live.pace === null ? kmh : live.pace + (kmh - live.pace) * (dt / 1000) / (dt / 1000 + PACE_TAU);
                }
            }
            lastSpeedT = now;
        };
        const paceNow = () => (live.pace !== null && live.lastMove && Date.now() - live.lastMove < PACE_KEEP ? live.pace : null);
        const onRpm = (rpm) => {
            // fully electric: no engine. The signal may be missing or carry the motor's speed: never an engine
            if (isBev()) { live.rpm = null; return; }
            const was = live.rpm;
            live.rpm = rpm; live.rpmT = Date.now();
            if (rpm > 400) seg.engine = true;
            else if (rpm < 300) seg.engineAll = false;      // the engine stopped at some point in the stretch
            if (G.isNum(was) && was < 300 && rpm > 600 && G.isNum(live.speed) && live.speed > 3
                && G.isNum(live.soc) && Date.now() - live.socT < 60000 && live.soc <= 20 && live.soc > HOLD_TOP) {
                st.engineStarts = (st.engineStarts || []).concat([Math.round(live.soc * 10) / 10]).slice(-5);
                log.info('engine started while driving at ' + live.soc.toFixed(1) + ' %');
                save();
            }
        };
        /** Charge at which the engine starts: the setting, or the median of the engine starts seen. */
        function reserve() {
            if (isBev()) {
                const b = +settings.get('bevReserve');
                return isFinite(b) && b > 0 ? Math.min(50, b) : 0;
            }
            const s = settings.get('reserve');
            if (s != null && s !== 'auto' && isFinite(+s)) return +s;
            const e = (st.engineStarts || []).filter((x) => x > HOLD_TOP).sort((a, b) => a - b);
            return Math.max(HOLD_TOP, e.length >= 2 ? e[Math.floor(e.length / 2)] : RESERVE);
        }
        /* ---------- climate control on / off (per zone: on when any zone is on) ----------
         * Off, only the on-board electrics draw (model.auxRate). A reading stretch during which it was
         * switched on or off teaches nothing ('mixed'), so neither draw learns the other's. */
        const zones = { climate: {}, ac: {} };
        const rawClimate = {};                           // last values as received (Diagnostics page)
        const onZone = (what, on, zone) => {
            if (typeof on !== 'boolean') return;
            const z = zones[what];
            if (zone === 'ALL_ZONES') zone = 0;                          // enums may come as names
            if (!zone) Object.keys(z).forEach((k) => delete z[k]);      // ALL_ZONES (0) sets every zone
            z[zone || 0] = on;
        };
        /** every entry holding `key`, however the list arrives (plain, wrapped in the field's name, single) */
        const entries = (v, key, out) => {
            out = out || [];
            if (v && typeof v === 'object') {
                if (key in v) out.push(v);
                else Object.keys(v).forEach((k) => entries(v[k], key, out));
            }
            return out;
        };
        const one = (v, key) => { const e = entries(v, key)[0]; return e ? e[key] : undefined; };
        /* Climate: false (off: on-board draw only), true (on: fan, heating), 'ac' (on with the A/C
         * compressor as well) - each costs its own draw. null: not known. */
        const climateNow = () => {
            const sys = Object.keys(zones.climate).length ? Object.keys(zones.climate).some((k) => zones.climate[k]) : null;
            const ac = Object.keys(zones.ac).length ? Object.keys(zones.ac).some((k) => zones.ac[k]) : null;
            live.ac = ac;
            if (ac) return 'ac';
            return sys;
        };
        const seen = (what, v) => {
            const raw = JSON.stringify(v);
            if (raw !== rawClimate[what]) { rawClimate[what] = raw; log.info('climate ' + what + ': ' + raw); }
        };
        const climateChanged = () => {
            const now = climateNow();
            if (now === null) return;
            if (live.climate !== null && now !== live.climate) { seg.climateMixed = true; log.info('climate control ' + (now === 'ac' ? 'on (A/C)' : now ? 'on' : 'off')); }
            live.climate = now;
        };
        // ClimateMaster: lists, one entry per zone (not offered on every car)
        const onClimate = (what, key, v) => {
            seen(what, v);
            entries(v, key).forEach((e) => onZone(what, e[key], e.operationZone));
            climateChanged();
        };
        // Climate2 - from the vehicle gateway, what the HMI itself reads: A/C on / off, blower, compressor
        const ON = { 1: true, KLIMAANLAGE_EIN: true, 0: false, KLIMAANLAGE_AUS: false };
        const onAircon = (v) => {
            seen('A/C', v);
            const on = ON[one(v, 'statusAircon')];
            if (typeof on === 'boolean') { zones.ac = { 0: on }; climateChanged(); }
        };
        const onBlower = (v) => {
            seen('blower', v);
            const b = one(v, 'statusBlowerSettingDR');
            if (typeof b === 'number' && b < 255) {
                live.blower = b; live.blowerTop = Math.max(live.blowerTop, b);
                zones.climate = { 0: b > 0 }; climateChanged();
            }
        };
        const onCompressor = (v) => {
            seen('compressor', v);
            const r = one(v, 'actualValuePowerACCompressor');
            live.acPower = r; live.acRaw = r; live.acKw = typeof r === 'number' ? sc('acPower', r) : null;
        };
        /** Climate during the stretch since the last charge reading: true / false / null / 'mixed'. */
        const stretchClimate = () => (seg.climateMixed ? 'mixed' : seg.climate);

        /* ---------- comfort consumers and the car's own power figures ---------- */
        const rawSeen = (what, v) => { live.raw[what] = JSON.stringify(v); };
        const level = (v) => (typeof v === 'number' && v >= 0 && v < 15 ? Math.min(3, v) : null);
        const onSeat = (pos, key) => (v) => { rawSeen('seat ' + pos, v); live.seats[pos] = level(one(v, key)); };
        /** Seat + steering-wheel heating now (kW, estimated from their levels). */
        const comfortKw = (d) => {
            const x = d || live;
            const seats = Object.keys(x.seats || {}).reduce((a, k) => a + (x.seats[k] ? SEAT_KW[x.seats[k]] : 0), 0);
            return seats + (x.wheel ? WHEEL_KW : 0);
        };
        /** Blower now (kW, estimated; part of the climate draw). */
        const blowerKw = (d) => {
            const x = d || live;
            if (!G.isNum(x.blower) || x.blower <= 0) return 0;
            const f = G.clamp(x.blower / Math.max(8, x.blowerTop || 8), 0, 1);
            return BLOWER_KW[0] + BLOWER_KW[1] * f * f;
        };
        const battTemp = (raw) => {
            const v = sc('batteryTemp', raw);
            return v !== null && v > -30 && v < 70 ? v : null;
        };

        /** Fully electric: the usable kWh the battery unit reports (the last one read, also from an earlier start), or null. */
        const capNow = () => (G.isNum(live.cap) ? live.cap : G.isNum(st.cap) ? st.cap : null);
        /** The battery when new: a plug-in hybrid's gross size, a fully electric car's usable size (kWh). */
        const newKwh = () => (isBev() ? settings.get('designKwhBev') : settings.get('designKwh'));
        /** kWh in 1 % of charge today: a fully electric car's usable kWh as its battery unit reports it, else size when new x health. */
        const kwhPerPct = () => {
            const c = isBev() ? capNow() : null;
            if (G.isNum(c)) return c / 100;
            return newKwh() * (G.isNum(live.soh) ? live.soh : 100) / 100 / 100;
        };
        /** Fully electric: health = usable kWh now against usable when new (null if that doesn't look like this battery). */
        const bevSoh = () => {
            const c = capNow(), n = settings.get('designKwhBev');
            if (!G.isNum(c) || !(n > 0)) return null;
            const h = c / n * 100;
            return h >= 50 && h <= 115 ? h : null;
        };
        /** What a full charge holds today (kWh). d: data() (its health, in demo the demo's). */
        const holdsKwh = (d) => {
            if (isBev()) {
                const c = d.demo ? d.cap : capNow();
                if (G.isNum(c)) return c;
            }
            return G.isNum(d.soh) ? newKwh() * d.soh / 100 : newKwh();
        };
        /** Energy in the battery now (kWh): a fully electric car's battery unit's own figure, else charge x what it holds. */
        const inBatteryKwh = (d) => {
            if (isBev() && G.isNum(d.stored)) return Math.max(0, d.stored);
            return G.isNum(d.soc) ? holdsKwh(d) * d.soc / 100 : null;
        };

        // connect in the background: the screen must not wait for the diagnostic link. Set up before the signals below,
        // so the link's own set-up doesn't wait behind theirs (kit/signals.js runs one native call at a time)
        const diag = new Diag(ctx.signals, log);
        diag.quiet = true;                     // polled every few seconds: keep the log file small
        diag.init();

        // the car locked and left (its own state: parked or standby, nobody in it): nothing is read, so it can sleep
        ctx.signals.watch('de.bmw.infrastructure.VehicleCondition', '1', {
            VehicleCondition: (v) => {
                const n = Car.conditionOf(v && v.statusConditionVehicle);
                if (n === undefined || live.left === (n <= 3)) return;
                live.left = n <= 3;
                log.info(live.left ? 'the car is locked and left: no reads, so it can sleep' : 'the car is in use again');
            },
        }, log).catch((e) => log.warn('vehicle state: ' + (e && e.message || e)));
        ctx.signals.watch('de.bmw.infrastructure.EnvironmentalInformation', '1', {
            ExteriorTemperature: (v) => { const a = sc('ambient', v.temperatureExterior); if (a !== null) live.ambient = a; },
        }, log).then((s) => log.info('ambient ' + (s.error ? 'error: ' + s.error : 'subscribed')));
        ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusCarSpeed2: (v) => {
                const k = v.speedVehicleCentreOfGravity;
                // (65535: no value; over 400 km/h: not a real one, as sent while the car wakes)
                live.speed = k == null || k * 0.015625 > 400 ? null : k * 0.015625;
                if (G.isNum(live.speed)) live.speedT = Date.now();
                // standing since (live.js: the measured climate draw)
                if (G.isNum(live.speed) && live.speed > 1) live.standSince = 0;
                else if (G.isNum(live.speed) && !live.standSince) live.standSince = Date.now();
                onSpeed(live.speed);
                b12.onSpeed(live.speed);
            },
            highVoltageStorageInfoToExternal: (v) => rawSeen('HV energy', v),
        }, log).then((s) => log.info('speed ' + (s.error ? 'error: ' + s.error : 'subscribed')));
        ctx.signals.watch('de.bmw.infotainment.vehicle.CDS', '1', {
            statusEngineSpeed2: (v) => {
                // (fully electric: kept for the Signals page only, to see what such a car sends here)
                if (isBev()) { rawSeen('engine speed', v); live.rpm = null; return; }
                const r = sc('rpm', v.actualValueRPMEngineCrankshaft); if (r !== null && r >= 0 && r < 12000) onRpm(r);
            },
            // the 12 V battery's charge as the car sends it (no request to any unit): the one shown when the engine unit's
            // battery sensor does not answer
            statusBattery2: (v) => {
                const c = v && v.conditionBatteryChargingCondition;
                if (G.isNum(c) && c >= 0 && c <= 100) { live.bat12 = c; live.bat12T = Date.now(); }
            },
        }, log).then((s) => log.info('rpm ' + (s.error ? 'error: ' + s.error : 'subscribed')));
        ctx.signals.watch('de.bmw.infotainment.climate.climatemaster.ClimateMaster', '1', {
            // both are lists, one entry per zone
            statusClimateSystemOn: (v) => onClimate('climate', 'airConditioningOn', v),
            statusAirCondAC: (v) => onClimate('ac', 'acButton', v),
        }, log, { pollMs: 10000 }).then((s) => log.info('climate ' + (s.error ? 'error: ' + s.error : 'subscribed')));
        ctx.signals.watch('de.bmw.infotainment.climate.Climate2', '1', {
            statusACFront: onAircon,
            statusAirConditionDRStatus: onBlower,
            statusActualValuePowerACCompressor: onCompressor,
        }, log, { pollMs: 10000 }).then((s) => log.info('climate2 ' + (s.error ? 'error: ' + s.error : 'subscribed')));

        ctx.signals.watch('de.bmw.infotainment.climate.Climate', '1', {
            statusSeatHeatingDR: onSeat('DR', 'statusSeatHeaterDR'),
            statusSeatHeatingPS: onSeat('PS', 'statusSeatHeaterPS'),
            statusSeatHeatingDRR: onSeat('DRR', 'statusSeatHeaterDRR'),
            statusSeatHeatingPSR: onSeat('PSR', 'statusSeatHeaterPSR'),
        }, log, { pollMs: 15000 }).then((s) => log.info('seat heating ' + (s.error ? 'error: ' + s.error : 'subscribed')));
        ctx.signals.watch('de.bmw.body.steeringwheelcomfort.SteeringWheelClimate', '1', {
            heatingState: (v) => { rawSeen('wheel', v); const h = one(v, 'heating'); if (typeof h === 'boolean') live.wheel = h; },
        }, log, { pollMs: 15000 }).then((s) => log.info('steering wheel ' + (s.error ? 'error: ' + s.error : 'subscribed')));
        ctx.signals.watch('de.bmw.infotainment.KombiIF', '1', {
            // the car's own "power distribution" display: drive / climate share, seat heating bars, range they cost
            statusDisplayElectricalPowerDistribution: (v) => { rawSeen('distribution', v); live.pd = entries(v, 'displayRepartitionDriveElectricPower')[0] || null; },
        }, log, { pollMs: 15000 }).then((s) => log.info('power distribution ' + (s.error ? 'error: ' + s.error : 'subscribed')));
        ctx.signals.watch('de.bmw.infotainment.drivingexcitement.Efficiencytainment2', '1', {
            // the cluster's eDRIVE needle: electric drive and recuperation as shares of their most (live.js: the fast power)
            statusPowerRelativHybrid: (v) => {
                const e = entries(v, 'displayActualValuePowerRelativeDrivingElectric')[0];
                if (!e) return;
                const d = e.displayActualValuePowerRelativeDrivingElectric, r = e.displayActualValuePowerRelativeRecuperation;
                if (!live.needleSeen) { live.needleSeen = true; log.info('eDRIVE needle: drive ' + d + ', regen ' + r); }
                if (live.needleFn && typeof d === 'number' && typeof r === 'number' && d <= 254 && r <= 254) live.needleFn(d, r);
            },
            statusBatteryTemperature: (v) => {
                rawSeen('battery temp', v);
                const e = entries(v, 'actualValueTemperatureHighVoltageStorage')[0];
                if (e) live.batt = { avg: battTemp(e.actualValueTemperatureHighVoltageStorage), min: battTemp(e.actualValueTemperatureHighVoltageStorageMinimum), max: battTemp(e.actualValueTemperatureHighVoltageStorageMaximum) };
            },
        }, log, { pollMs: 30000 }).then((s) => log.info('battery temperature ' + (s.error ? 'error: ' + s.error : 'subscribed')));
        ctx.signals.watch('de.bmw.infotainment.lsc.LSCDataSink', '1', {
            statusHighVoltageStorage: (v) => {
                rawSeen('HV voltage', v);
                const x = one(v, 'actualValueVoltageHighVoltageStorage');
                if (!G.isNum(x)) return;
                live.hvV = x;
                const volts = x > 1500 ? x / 10 : x;            // 0.1 V on the X5 45e
                if (volts > 150 && volts < 500) { live.lscV = volts; live.lscVT = Date.now(); }
            },
        }, log).then((s) => log.info('HV voltage ' + (s.error ? 'error: ' + s.error : 'subscribed')));

        const demo = new Demo(() => kwhPerPct() * 100);
        const usingDemo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !diag.available && !live.socT);

        /* ---------- UDS reads (candidates per value, see kit/dids.js) ---------- */
        const reader = new DidReader(diag, { ecu: cfg.ecu });
        const raws = reader.raws, pick = reader.pick;      // for the Diagnostics page
        // the candidate that answered each value, kept across starts (battery.json): the next start asks that one first,
        // not the ones before it this car doesn't answer (each can wait out its timeout)
        // (in battery.json once one has answered: a start that reads nothing writes nothing)
        Object.assign(pick, st.pick || {});
        Object.defineProperty(st, 'pick', { enumerable: true, configurable: true, get: () => (Object.keys(pick).length ? pick : undefined) });
        // one request at a time on the diagnostic link: a queue rather than a plain chain, so a live
        // power read (urgent) goes ahead of the reads that wait
        const queue = [];
        let pumping = false;
        async function pump() {
            if (pumping) return;
            pumping = true;
            while (queue.length) {
                const j = queue.shift(), t0 = Date.now();
                try { j.res(await j.fn()); } catch (e) { j.rej(e); }
                // one turn that holds the link this long delays every read behind it (the live power too): say which
                const ms = Date.now() - t0;
                if (ms > 1500) { exclusive.stalls = (exclusive.stalls || 0) + 1; log.warn('link held ' + ms + ' ms by ' + j.label + (queue.length ? ' (' + queue.length + ' waiting)' : '')); }
            }
            pumping = false;
        }
        const exclusive = (fn, urgent, label) => new Promise((res, rej) => {
            const j = { fn, res, rej, label: label || (urgent ? 'urgent' : 'read') };
            if (urgent) queue.unshift(j); else queue.push(j);
            pump();
        });
        /* A value's candidates, starting with the one that answered last (kit/dids.js value()), each in a turn of its own
         * on the link: candidates that don't answer each wait out their timeout, and all of them in one turn kept the live
         * power reads behind them so long that the power went blank. A fully electric car has no engine or gearbox unit
         * (NO_ENGINE): those candidates are not asked there (noEngineUnit; battery12.js too, for the 12 V). */
        const noEngineUnit = (c) => isBev() && NO_ENGINE.indexOf(c.ecu == null ? cfg.ecu : c.ecu) >= 0;
        async function readValue(key) {
            const list = cfg[key] || [], start = pick[key] || 0;
            for (let k = 0; k < list.length; k++) {
                const i = (start + k) % list.length, c = list[i];
                if (noEngineUnit(c)) continue;
                const v = await exclusive(() => reader.value(key, [c]), false, key + ' ' + DidReader.label(c) + ' at 0x' + hex(c.ecu == null ? cfg.ecu : c.ecu));
                if (v !== null) { pick[key] = i; return v; }
            }
            return null;
        }
        // without a hybrid system: the 12 V battery's pages, its reads (the voltage for every car) - battery12.js
        const b12 = startBattery12(ctx, { diag, reader, exclusive, live, st, save, usingDemo, kind: () => kind(),
            skip: noEngineUnit, ambient: () => live.ambient, poll: (f) => poll(f), render: () => render() });

        /* ---------- last charge ----------
         * A charge = the charge level rising by >= chargeMinPct while the car stands still
         * (regen while driving doesn't count), from the level before it to the last level read before the
         * car drives off or the level really drops. The last reading is saved, so a charge done
         * while the head unit slept shows up as a jump at the next start: that jump counts even when
         * the car is already moving by the first reading (the diagnostic link takes a while to come up),
         * as readings come every few seconds while the car is on and regen never adds that much between them. */
        // (no health read yet: 100 %, as the range)
        const chargeKwh = (from, to) => (to - from) * kwhPerPct();
        function closeSession() {
            const s = st.session;
            st.session = null;
            if (s && s.to - s.from >= cfg.chargeMinPct) {
                st.lastCharge = { from: s.from, to: s.to, fromT: s.fromT, toT: s.toT, kwh: chargeKwh(s.from, s.to) };
                st.log = (st.log || []).concat([st.lastCharge]).slice(-LOG_MAX);
                log.info('charge ' + s.from.toFixed(1) + ' -> ' + s.to.toFixed(1) + ' %');
            }
        }
        function onSoc(soc, now) {
            const prev = st.lastSoc, open = st.session, logged = st.lastCharge, moving = G.isNum(live.speed) && live.speed > 3;
            const engineRunning = G.isNum(live.rpm) && live.rpm > 400 && now - live.rpmT < 5000;
            // since the last reading with the engine off throughout (and the car awake: rpm signal live):
            // standing / creeping teaches the climate + on-board draw per hour, driving the use per km
            const h = (now - (st.lastSocT || 0)) / 3600000, bev = isBev();
            const held = !bev && G.isNum(prev) && Math.min(prev, soc) <= HOLD_TOP + 1;    // low-battery hybrid zone
            // the car awake and its signals coming: the engine's speed on a hybrid, the car's speed on a fully electric car
            // (its distance in seg.km comes from that signal: a stretch without it would teach a drive as standing)
            const awake = bev ? now - live.speedT < 5000 : now - live.rpmT < 5000;
            syncModel();
            if (held) { /* the car manages the charge here: nothing to learn */ }
            else if (G.isNum(prev) && h < 120000 / 3600000 && !seg.engine && awake && !st.session) {
                // seat / steering-wheel heating over the stretch: the mean of its start and end
                model.learn(prev - soc, h, seg.km, live.ambient, kwhPerPct(), stretchClimate(), (seg.comfort + comfortKw()) / 2);
            } else if (!bev && G.isNum(prev) && h < 120000 / 3600000 && seg.engine && seg.engineAll && awake && !st.session) {
                // the engine ran the whole stretch: what the battery did meanwhile (drained or charged), on its own
                model.learnEngine(prev - soc, h, seg.km);
            }
            seg.km = 0; seg.engine = G.isNum(live.rpm) && live.rpm > 400; seg.engineAll = seg.engine;
            seg.climate = live.climate; seg.climateMixed = false; seg.comfort = comfortKw();
            if (G.isNum(prev)) {
                // (a jump of JUMP_PCT or more is a charge whatever the head unit's clock says - it can be off just after
                // the head unit wakes - and whatever the speed: regen never adds that much between two readings)
                if (soc > prev + 0.3 && (now - (st.lastSocT || now) > ASLEEP_MS || soc >= prev + JUMP_PCT)
                    && soc >= (st.session ? st.session.from : prev) + cfg.chargeMinPct) {
                    // charged while the car was off (also one that began while the head unit was still awake):
                    // the charge runs up to this reading. The car wakes now and then during a long charge, so the
                    // session stays open until the car drives off: one charge from the first level to the last
                    if (!st.session) st.session = { from: prev, fromT: st.lastSocT };
                    st.session.to = soc; st.session.toT = now;
                    if (moving) closeSession();
                } else if (soc > prev + 0.3 && !moving) {
                    if (!st.session) st.session = { from: prev, fromT: st.lastSocT || now };
                    st.session.to = soc; st.session.toT = now;
                } else if (!moving && st.session && soc > st.session.to) {
                    // a charge going on in small steps (less than 0.3 % per reading)
                    st.session.to = soc; st.session.toT = now;
                } else if (!moving && !st.session && !engineRunning && live.rest && soc > live.rest.soc + REST_RISE) {
                    // charging awake, too slowly for 0.3 % per reading (AC, or a 50 kW charger on a big battery):
                    // the charge rose this much since the lowest reading standing
                    st.session = { from: live.rest.soc, fromT: live.rest.t, to: soc, toT: now };
                } else if (st.session && (soc < st.session.to - 2 || moving)) {
                    // ends when driving off or on a real drop; small dips while parked (cabin
                    // pre-conditioning, display wobble) keep the session open
                    closeSession();
                }
            }
            // the lowest charge since the car stopped (not while the engine runs: it may charge the battery standing)
            if (moving || engineRunning) live.rest = null;
            else if (!live.rest || soc < live.rest.soc) live.rest = { soc, t: now };
            st.lastSoc = soc; st.lastSocT = now;
            // a charge logged, a session opened, grown or closed: saved with this reading, so battery.json never holds
            // a logged charge with the reading before it (the next start would log the same charge again)
            if (st.lastCharge !== logged || st.session !== open || (open && open.toT === now) || now - savedAt > 120000) save();
        }
        /** The charge to show: the open session (big enough to count), else the last finished one.
         *  open: the level rose within ASLEEP_MS (charging now); the session itself stays open until the car drives off. */
        function lastCharge() {
            const s = st.session;
            if (s && s.to - s.from >= cfg.chargeMinPct) {
                return Object.assign({}, s, { kwh: chargeKwh(s.from, s.to), open: Date.now() - s.toT < ASLEEP_MS });
            }
            return st.lastCharge || null;
        }

        /* ---------- hybrid system or not ----------
         * Any reply from the battery unit (even a refusal) = there is a hybrid system, for good
         * (st.hybrid is remembered, so a real hybrid is never switched off later).
         * No reply 3 times in a row while another unit answers (the 12 V read) = no hybrid system.
         * Cars where the 12 V can't be read either (seen on a G06 N63): 6 times in a row with the
         * diagnostic link up is enough. Remembered, so the next start shows the 12 V page straight away. */
        let smeMiss = 0, lastSocTry = 0;
        function detectHybrid(otherUnitAnswered) {
            const rs = (cfg.soc || []).map((c) => raws[reader.key(c)]);
            if (rs.some((r) => r && r.bytes)) {
                smeMiss = 0;
                if (st.noHybrid || !st.hybrid) { st.noHybrid = false; st.hybrid = true; save(); log.info('hybrid battery unit answers'); }
            } else if (rs.some((r) => r && r.why === 'no reply') && !st.hybrid) {
                if (++smeMiss >= (otherUnitAnswered ? 3 : 6) && !st.noHybrid) {
                    st.noHybrid = true; save(); log.info('no hybrid battery unit: 12 V only');
                }
            }
        }
        /* The car's system: 'phev' (plug-in hybrid), 'mhev' (48 V mild hybrid) or 'none'; the setting, else what
         * answered: the high-voltage battery unit, else the 48 V battery once the high-voltage one is known to be
         * missing (st.mild48 / st.no48 remembered as st.hybrid / st.noHybrid are); a plug-in hybrid until known. */
        function kind() {
            const set = settings.get('hybrid');
            if (set === 'bev') return 'bev';
            if (set === 'yes') return 'phev';
            if (set === '48v') return 'mhev';
            if (set === 'no') return 'none';
            // a fully electric car is known by its battery's size (readEnergy: st.bev, remembered)
            return st.hybrid || !st.noHybrid ? (st.bev ? 'bev' : 'phev') : st.mild48 ? 'mhev' : 'none';
        }
        // (function declarations: the signal handlers above may ask before this part of start() has run)
        function isBev() { return kind() === 'bev'; }
        /** A high-voltage battery to show: a plug-in hybrid's or a fully electric car's. */
        function hasHv() { const k = kind(); return k === 'phev' || k === 'bev'; }
        /** The range model's % per km limits for this battery's size (range.js: scale). */
        function syncModel() { model.scale = isBev() ? G.clamp(0.12 / Math.max(0.01, kwhPerPct()), 0.05, 1) : 1; }
        // the Diagnostics page (UDS replies per value) only when switched on in Settings: it is for tuning DIDs
        const pages = () => ({ phev: PAGES_HYBRID, bev: PAGES_HYBRID, mhev: PAGES_48V, none: PAGES_12V })[kind()]
            .filter((p) => DIAG_PAGES.indexOf(p) < 0 || settings.get('diagPage'));

        /* ---------- 48 V mild hybrid and the 12 V battery's own values ---------- */
        /** One candidate with several fields on one reply ({ did, fields: { name: { at, bytes, ... } } }, the first
         *  field read as a plain value): { field: value } (one outside its min..max: null), or null. */
        async function readFields(c) {
            const names = Object.keys(c.fields || {});
            const p = Object.assign({ ecu: c.ecu, did: c.did, timeoutMs: c.timeoutMs }, c.fields[names[0]]);
            const v0 = await reader.read(p);
            if (v0 === null) return null;
            const r = raws[reader.key(p)], bytes = r.bytes.split(' ').map((x) => parseInt(x, 16)), out = {};
            names.forEach((k, i) => {
                if (i === 0) { out[k] = v0; return; }
                const f = c.fields[k], at = 3 + (f.at || 0), n = f.bytes || 1;
                if (bytes.length < at + n) { out[k] = null; return; }
                let raw = 0;
                for (let j = 0; j < n; j++) raw = raw * 256 + bytes[at + j];
                if (f.signed && raw >= Math.pow(2, 8 * n - 1)) raw -= Math.pow(2, 8 * n);
                const v = raw * (f.factor == null ? 1 : f.factor) + (f.offset || 0);
                out[k] = (f.min != null && v < f.min) || (f.max != null && v > f.max) ? null : v;
            });
            return out;
        }
        /** A value's candidates with fields, starting with the one that answered last. */
        async function readGroup(name) {
            const list = cfg[name] || [], start = pick[name] || 0;
            for (let k = 0; k < list.length; k++) {
                const i = (start + k) % list.length, v = await readFields(list[i]);
                if (v) { pick[name] = i; return v; }
            }
            return null;
        }
        // a value that fails 3 times in a row is read again only every 5 minutes (a unit that is not there
        // would hold the link for its timeout on every poll)
        const fails = {};
        const due = (name) => !fails[name] || fails[name].n < 3 || Date.now() - fails[name].t > 300000;
        const counted = (name, v) => {
            if (v === null) fails[name] = { n: (fails[name] ? fails[name].n : 0) + 1, t: Date.now() };
            else delete fails[name];
            return v;
        };
        let miss48 = 0;
        /** The 48 V battery and converter; on a car not known yet, whether it has them. */
        async function read48(otherUnitAnswered) {
            if (!due('b48')) return;
            const b = counted('b48', await exclusive(() => readGroup('b48'), false, 'b48'));
            if (b) {
                live.b48 = b; live.b48T = Date.now(); miss48 = 0;
                if (!st.mild48) { st.mild48 = true; st.no48 = false; save(); log.info('48 V battery answers: mild hybrid'); }
                if (due('dc48')) {
                    const dc = counted('dc48', await exclusive(() => readGroup('dc48'), false, 'dc48'));
                    if (dc) { live.dc = dc; live.dcT = Date.now(); }
                }
            } else if (!st.mild48 && !st.no48 && ++miss48 >= (otherUnitAnswered ? 3 : 6)) {
                st.no48 = true; save(); log.info('no 48 V battery: 12 V only');
            }
        }
        /* ---------- fully electric: the battery unit's own kWh ----------
         * config.battery.energy: what the battery holds now and can hold (usable). On Auto this also tells the system: a
         * battery that holds more than bevMinKwh is a fully electric car's (remembered for good, as st.hybrid is); one that
         * holds less, or a battery unit that refuses the value 3 times, a plug-in hybrid's (remembered too). */
        // (what it learns is saved by poll() after that poll's charge reading: energySave)
        let energyNo = 0, energySave = false;
        async function readEnergy() {
            if (!due('energy')) return;
            const e = counted('energy', await exclusive(() => readGroup('energy'), false, 'energy'));
            if (e && G.isNum(e.cap)) {
                const now = Date.now();
                live.cap = e.cap; live.capT = now; energyNo = 0;
                if (G.isNum(e.stored)) { live.stored = e.stored; live.storedT = now; }
                st.cap = Math.round(e.cap * 10) / 10;           // (else saved with the next reading's save)
                if (e.cap >= (cfg.bevMinKwh || 45)) {
                    if (st.bev !== true) { st.bev = true; energySave = true; log.info('battery holds ' + e.cap.toFixed(1) + ' kWh: fully electric'); }
                } else if (st.bev === undefined) { st.bev = false; energySave = true; log.info('battery holds ' + e.cap.toFixed(1) + ' kWh: plug-in hybrid'); }
                return;
            }
            // refused (not "no reply": the unit may be busy or asleep): this battery unit doesn't have the value
            const c = (cfg.energy || [])[0], r = c && raws[reader.key(c)];
            if (st.bev === undefined && r && /^NRC/.test(r.why || '') && ++energyNo >= 3) {
                st.bev = false; energySave = true; log.info('no battery energy reading (' + r.why + '): plug-in hybrid');
            }
        }
        const diagHint = (s) => (settings.get('diagPage') ? s + ' - see Diagnostics page' : s);

        let busy = false, pollTimer = null;
        let sohFailT = 0, last48Try = 0;
        let pollMs = 0;
        async function poll(forceSoh) {
            if (busy) return;
            busy = true;
            const t0 = Date.now();
            try {
                // no hybrid system: parked (not driven, the page not used lately) nothing is read, so the car can sleep
                if (diag.available && (forceSoh || !live.left) && (kind() !== 'none' || b12.allowed(forceSoh))) {
                    // the high-voltage battery's charge first, the 12 V after it: the pages wait for the charge, and 12 V
                    // candidates that don't answer each wait out their timeout (on a fully electric car, before the first
                    // charge). Without a hybrid system only re-check the battery unit every 5 minutes (and not while the
                    // 12 V page is up: those units' timeouts would hold up the voltage)
                    const noHy = st.noHybrid && settings.get('hybrid') !== 'yes' && settings.get('hybrid') !== 'bev';
                    const hvDue = !noHy || forceSoh || (Date.now() - lastSocTry > 300000 && !b12.fast());
                    if (hvDue) {
                        lastSocTry = Date.now();
                        const soc = await readValue('soc'), socT = Date.now();
                        // shown at once (the kWh below can wait behind the live pages' reads)
                        if (soc !== null) { live.soc = soc; live.socT = socT; }
                        // fully electric (or not known yet on Auto, with a battery unit there): the battery's kWh, before the
                        // charge reading is used (its kWh per % and the range model's limits)
                        const onAuto = settings.get('hybrid') === 'auto';
                        if ((cfg.energy || []).length && (isBev() || (onAuto && st.bev === undefined && (st.hybrid || soc !== null)))) await readEnergy();
                        if (soc !== null) onSoc(soc, socT);
                        // (saved after the reading: every save holds the last charge read, see onSoc)
                        if (energySave) { energySave = false; save(); }
                    }
                    // 12 V: every poll, from the source that answered last (after 3 failures in a row only every 5 minutes)
                    const v12 = await b12.readVolt(forceSoh);
                    if (hvDue) {
                        detectHybrid(v12 !== null);
                        // health changes over months: read it once every "sohDays" (kept across restarts),
                        // on "Read now", and after a failed read at most once an hour. A fully electric car whose battery
                        // reports its usable kWh: that against "usable battery when new" instead (bevSoh)
                        const sohDue = live.soh === null || Date.now() - live.sohT > settings.get('sohDays') * 86400000;
                        const fromKwh = isBev() && G.isNum(bevSoh());
                        if (!st.noHybrid && !fromKwh && (forceSoh || (sohDue && Date.now() - sohFailT > 3600000))) {
                            const soh = await readValue('soh');
                            if (soh !== null) { live.soh = soh; live.sohT = Date.now(); st.soh = soh; st.sohT = live.sohT; save(); }
                            else sohFailT = Date.now();
                        }
                    }
                    // no high-voltage battery: a 48 V one (looked for while not known, then every 5 minutes while
                    // there is none), and the 12 V battery's own values
                    const k = kind(), auto = settings.get('hybrid') === 'auto';
                    if (k === 'mhev' || (auto && k === 'none' && (!st.no48 || forceSoh || (Date.now() - last48Try > 300000 && !b12.fast())))) {
                        last48Try = Date.now();
                        await read48(v12 !== null);
                    }
                    if (!hasHv()) await b12.readValues(forceSoh);
                }
            } catch (e) { log.warn('poll: ' + e); }
            pollMs = Date.now() - t0;
            busy = false;
        }
        function schedule() {
            clearTimeout(pollTimer);
            // the 12 V pages up and in use: the voltage every second (what the battery does, the last minutes)
            pollTimer = setTimeout(() => poll(false).then(schedule), b12.fast() ? Math.max(250, b12.FAST_MS - pollMs) : settings.get('poll') * 1000);
        }
        diag.on('available', (a) => { if (a) poll(false); });
        poll(false).then(schedule);

        /* ---------- derived values ---------- */
        function data() {
            if (usingDemo()) return Object.assign(demo.sample(), { demo: true, socAge: 0 });
            const maxAge = Math.max(60, settings.get('poll') * 4) * 1000, now = Date.now();
            const hk = isBev() ? bevSoh() : null;      // fully electric: health from the battery's usable kWh
            return {
                soc: live.soc, soh: G.isNum(hk) ? hk : live.soh, sohAge: G.isNum(hk) ? (live.capT ? now - live.capT : null) : live.sohT ? now - live.sohT : null,
                cap: capNow(), stored: live.storedT && now - live.storedT < maxAge ? live.stored : null, ambient: live.ambient, demo: false,
                socAge: live.socT ? now - live.socT : null, stale: !(live.socT && now - live.socT < maxAge),
                v12: live.v12T && now - live.v12T < maxAge ? live.v12 : null, charge: lastCharge(),
                climate: live.climate, ac: live.ac, pace: paceNow(), seats: live.seats, wheel: live.wheel,
                engine: G.isNum(live.rpm) && live.rpm > 400 && now - live.rpmT < 5000, speed: live.speed,
                blower: live.blower, blowerTop: live.blowerTop, batt: live.batt,
                b48: live.b48T && now - live.b48T < maxAge ? live.b48 : null, dc: live.dcT && now - live.dcT < maxAge ? live.dc : null,
                x12: Object.keys(live.x12).reduce((o, k) => Object.assign(o, now - live.x12T[k] < maxAge ? { [k]: live.x12[k] } : {}),
                    live.bat12T && now - live.bat12T < 120000 ? { signal: live.bat12 } : {}),
            };
        }
        /** Range of a full battery at tC: { lo, hi, mid } in km (no temperature: 10 °C assumed). */
        function rangeAt(tC) {
            const t = G.isNum(tC) ? tC : 10;
            if (isBev()) {
                // fully electric: the usable kWh over what such a car typically uses at this temperature
                const mid = kwhPerPct() * 100 / (curve(BEV_USE, t) / 100);
                return { lo: mid * BEV_LO, hi: mid * BEV_HI, mid };
            }
            const k = settings.get('range20') / 50, c = RANGE_CURVE;
            let lo, hi;
            if (t >= c[c.length - 1][0]) { lo = c[c.length - 1][1]; hi = c[c.length - 1][2]; }
            else if (t <= c[0][0]) {
                const d = c[0][0] - t, sl = (c[1][1] - c[0][1]) / (c[1][0] - c[0][0]), sh = (c[1][2] - c[0][2]) / (c[1][0] - c[0][0]);
                lo = Math.max(15, c[0][1] - sl * d); hi = Math.max(18, c[0][2] - sh * d);
            } else {
                let i = 0;
                while (t > c[i + 1][0]) i++;
                const f = (t - c[i][0]) / (c[i + 1][0] - c[i][0]);
                lo = c[i][1] + (c[i + 1][1] - c[i][1]) * f; hi = c[i][2] + (c[i + 1][2] - c[i][2]) * f;
            }
            return { lo: lo * k, hi: hi * k, mid: (lo + hi) / 2 * k };
        }
        /**
         * Electric range at charge soc: { mid, lo, hi, kpp (km per %), learned, res (engine-start %), full,
         * auxKw (climate + on-board draw), auxLearned, auxKm (range it costs), climate }. Only the charge
         * above the engine-start point counts. Learned: % per km driving + (% per hour climate / typical
         * speed). climate: 'ac' / true / false / null (not known: as on); off, only the on-board draw counts.
         * pace: km/h now (null: the typical speed); comfort: seat / steering-wheel heating (kW). Also
         * climateKm / comfortKm (range they cost), pace, perKm (% per km driving at the pace).
         */
        function estimate(soc, tC, climate, pace, comfort) {
            syncModel();
            const res = reserve(), span = Math.max(1, 100 - res), use = G.isNum(soc) ? Math.max(0, soc - res) : null;
            // the temperature curve's range: a plug-in hybrid's ends where the engine starts, a fully electric car's at 0 %
            // (its "range counts down to" only takes the part below that off)
            const cspan = isBev() ? 100 : span;
            const k = kwhPerPct(), m = model.range(use, tC, k, climate, pace, comfort), aux = m ? m.aux : model.auxRate(tC, k, climate);
            const base = { res, auxKw: aux.rate * k, auxLearned: aux.learned, climate, comfortKw: comfort || 0 };
            if (m) {
                return Object.assign(base, {
                    mid: m.mid, lo: use === null ? null : m.mid * 0.9, hi: use === null ? null : m.mid * 1.1,
                    kpp: m.kpp, learned: true, full: m.kpp * span, auxKm: use === null ? null : m.noAux - m.mid,
                    climateKm: m.climateKm, comfortKm: m.comfortKm, pace: m.pace, perKm: m.perKm,
                });
            }
            // before driving is learned: the temperature curve (it already holds typical climate use);
            // climate off gives back what typical climate use costs per km, above the on-board draw
            const r = rangeAt(tC);
            let f = 1;
            if (climate === false) {
                const onPerKm = cspan / r.mid, climPerKm = (model.auxRate(tC, k).rate - aux.rate) / model.evSpeed();
                f = onPerKm / Math.max(onPerKm * 0.5, onPerKm - Math.max(0, climPerKm));
            } else if (climate === 'ac') {
                // the curve holds typical climate use without the compressor: it costs on top
                const onPerKm = cspan / r.mid, acPerKm = (aux.rate - model.auxRate(tC, k, true).rate) / model.evSpeed();
                f = onPerKm / (onPerKm + Math.max(0, acPerKm));
            }
            const kpp = r.mid / cspan * f, mid = use === null ? null : use * kpp;
            return Object.assign(base, {
                mid, lo: use === null ? null : use * r.lo / cspan * f, hi: use === null ? null : use * r.hi / cspan * f,
                kpp, learned: false, full: kpp * span, auxKm: null, pace: G.isNum(pace) ? pace : model.evSpeed(),
            });
        }
        /** km a charge of +pct % adds (charge log). */
        const kmOf = (pct) => pct * estimate(null, live.ambient, null, paceNow(), comfortKw()).kpp;

        /* ---------- units ---------- */
        const MI = () => settings.get('distUnit') === 'mi';
        const D = (km) => (G.isNum(km) ? (MI() ? km * KM_MI : km) : null);
        const dU = () => (MI() ? 'mi' : 'km');
        const F = () => settings.get('tempUnit') === 'f';
        const T = (c) => (G.isNum(c) ? (F() ? c * 9 / 5 + 32 : c) : null);
        const tU = () => (F() ? '°F' : '°C');
        const ago = (ms) => (ms == null ? 'not read yet' : ms < 60000 ? Math.max(0, Math.round(ms / 1000)) + ' s ago' : ms < 3600000 ? Math.round(ms / 60000) + ' min ago'
            : ms < 172800000 ? Math.round(ms / 3600000) + ' h ago' : Math.round(ms / 86400000) + ' days ago');

        /* ---------- drawing ---------- */
        let page = 0;
        // the climate's typical draw for this drive's totals while nothing better is known (the Energy page's estimate)
        const climateKw = () => {
            if (live.climate === false || live.climate == null) return 0;
            const k = kwhPerPct();
            return Math.max(0, (model.auxRate(live.ambient, k, live.climate).rate - model.auxRate(live.ambient, k, false).rate) * k);
        };
        // (the scan runs while the Diagnostic page, which shows it, is up)
        // the home-screen widget's range, as the Range page's figure; a plug-in hybrid's only
        const rangeText = (soc) => {
            if (!hasHv()) return '';
            const km = G.isNum(soc) ? estimate(soc, live.ambient, null, paceNow(), comfortKw()).mid : null;
            return (G.isNum(km) ? Math.round(D(km)) : '--') + ' ' + dU();
        };
        let share = () => {};          // (below) the power, charge and range for other apps
        const lv = startLive(ctx, { diag, reader, exclusive, live, climateKw, rangeText, kind: () => kind(), isBev, fullKwh: () => kwhPerPct() * 100,
            page: () => (pages()[page] === 'diag' ? 'scan' : pages()[page]), onPower: () => share() });
        const isLive = (p) => lv.PAGES.indexOf(p) >= 0;

        /* ---------- for other apps (Cluster functions' HUD and cluster): the power now, the charge and the range ----------
         * SHARED, a file anyone may read (an app cannot read another's data folder): { t, kw (+ the battery gives power,
         * - it takes it; null while not read; as fast as the car's eDRIVE needle with setting kwFast), kwRead (the battery's
         * last reading), fast (kw is the fast one), limitOut, limitIn (the kW the battery allows now), soc, rangeKm (the
         * range at this charge, as the Range page has it) }.
         * Written at each new power reading (at most every SHARE_MIN_MS) and four times a second; nothing while the
         * demo runs. live.js reads the power fast while another app asks for it (its WANTED). */
        const SHARED = '/tmp/mgu-edrive.json', SHARE_MIN_MS = 80, CI_FILE = '/dev/shm/cluster-info/edrive.json';
        let sharedAt = 0;
        share = () => {
            if (Date.now() - sharedAt < SHARE_MIN_MS) return;
            sharedAt = Date.now();
            try {
                const d = data();
                if (d.demo) return;
                const p = lv.powerNow({});
                const e = G.isNum(d.soc) && !d.stale ? estimate(d.soc, d.ambient, d.climate, d.pace, comfortKw(d)) : null;
                const ps = lv.powerShare();
                const out = { t: Date.now(), kw: p && G.isNum(p.kw) ? +p.kw.toFixed(1) : null, soc: G.isNum(d.soc) && !d.stale ? d.soc : null,
                    rangeKm: e && G.isNum(e.mid) ? Math.round(e.mid) : null,
                    kwRead: G.isNum(ps.kwRead) ? +ps.kwRead.toFixed(1) : null, fast: ps.fast,
                    limitOut: G.isNum(ps.out) ? Math.round(ps.out) : null, limitIn: G.isNum(ps.in) ? Math.round(ps.in) : null };
                fs.writeFileSync(SHARED + '.tmp', JSON.stringify(out), { mode: 0o644 });
                fs.chmodSync(SHARED + '.tmp', 0o644);
                fs.renameSync(SHARED + '.tmp', SHARED);
                // Cluster Info and its family (eroobeeroo/idrive7-cluster-info) read providers' files in their folder, in
                // their format, while they ask for the power (wanted*.json there): ours as edrive.json
                if (lv.clusterInfoWants()) {
                    const ci = { v: 1, t: out.t, app: 'eDrive', values: {} };
                    if (G.isNum(out.kw)) ci.power = { kw: out.kw, outMax: out.limitOut || 100, inMax: out.limitIn || 60, old: false };
                    if (G.isNum(out.soc)) ci.values.soc = { pct: out.soc };
                    const bt = d.batt && G.isNum(d.batt.avg) ? d.batt.avg : null;
                    if (G.isNum(bt)) ci.values.battery = { c: bt };
                    fs.writeFileSync(CI_FILE + '.tmp', JSON.stringify(ci), { mode: 0o644 });
                    fs.renameSync(CI_FILE + '.tmp', CI_FILE);
                }
            } catch (e) { /* the next write tries again */ }
        };
        setInterval(share, 250);
        // the first bar button: "Read now", on the live pages their own action (this drive's totals, the scan)
        let actionText = 'Read now';
        const actionLabel = () => {
            const p = pages()[page], txt = (isLive(p) && lv.actionLabel(p)) || 'Read now';
            if (txt !== actionText) { actionText = txt; ui.text('BTN_READ', txt); }
        };
        const turn = (n) => { page = n; b12.touched(); actionLabel(); return render(); };
        ui.onClick('BTN_PAGE', () => turn((page + 1) % pages().length));
        ui.onClick('BTN_PREV', () => { const n = pages().length; return turn((page + n - 1) % n); });
        ctx.onTab((i) => turn(i));
        ui.onClick('BTN_READ', () => {
            const p = pages()[page];
            if (isLive(p) && lv.actionLabel(p)) { lv.action(p); return render(); }
            return poll(true).then(render);
        });
        // where the kit runs the screen the values are read on their own (poll) and the resets are on the page
        ctx.hideButton('BTN_READ');
        const diagScroll = { y: 0, max: 0 };
        ctx.onScroll((dy) => {
            if (pages()[page] !== 'diag') return false;
            const y = G.clamp(diagScroll.y + dy, 0, diagScroll.max), moved = y !== diagScroll.y;
            diagScroll.y = y;
            return moved;
        });

        /** G20-style frame: tab bar with the page names along the top. */
        function header(cv, t, d) {
            const names = Object.assign({ main: ({ phev: 'Range', bev: 'Range', mhev: '48 V system', none: '12 V battery' })[kind()], b48info: 'Details', energy: 'Energy', log: 'Charge log', diag: 'Diagnostic', signals: 'Signals' }, lv.NAMES, b12.NAMES);
            G.frame(cv, t, pages().map((p) => names[p]), page, [d.demo && { text: 'DEMO' }]);
        }

        function battery(cv, t, x, y, w, h, soc) {
            const f = G.isNum(soc) ? G.clamp(soc / 100, 0, 1) : 0;
            const col = !G.isNum(soc) ? t.tick : soc < 10 ? t.crit : soc < 25 ? t.warn : GO;
            cv.strokeRoundRect(x, y, w, h, 14, 5, t.tick);
            cv.roundRect(x + w + 2, y + h * 0.3, 16, h * 0.4, 4, t.tick);
            const iw = w - 24, ih = h - 24, seg = iw / 10;
            for (let i = 0; i < 10; i++) cv.roundRect(x + 12 + i * seg, y + 12, seg - 6, ih, 5, f * 10 > i + 0.05 ? col : t.track);
            const i = Math.floor(f * 10), part = f * 10 - i;
            if (i < 10 && part > 0.05) cv.roundRect(x + 12 + i * seg, y + 12, (seg - 6) * part, ih, 5, withAlpha(col, 0.55));
        }

        /** The 12 V battery's state from its voltage: [text, colour]. */
        function v12State(t, v) {
            if (!G.isNum(v)) return [diagHint('no reading yet'), t.dim];
            if (v >= 13.2) return ['CHARGING  (engine / DC-DC running)', GO];
            if (v >= 12.6) return ['FULL', GO];
            if (v >= 12.4) return ['GOOD  (about 75 %)', t.text];
            if (v >= 12.2) return ['HALF  (about 50 %) - drive or charge soon', t.warn];
            return ['LOW - charge the battery', t.crit];
        }
        /** Label left, value right, on one line of a panel. */
        function row(cv, t, x, w, y, label, value, col) {
            cv.text(label, x, y, 22, t.dim, { font: 'bold', spacing: 1.2 });
            cv.text(value, x + w, y, 26, col || (value === '--' ? t.dim : t.text), { font: 'bold', align: 'right' });
        }
        const num = (v, dec, unit) => (G.isNum(v) ? G.fmt(v, dec) + (unit ? ' ' + unit : '') : '--');
        const signed = (v, dec, unit) => (G.isNum(v) ? (v > 0 ? '+' : '') + G.fmt(v, dec) + (unit ? ' ' + unit : '') : '--');

        /** 48 V mild hybrids, Details: what the 48 V battery reports about itself over its life. */
        function render48Info(cv, t, d) {
            const b = d.b48 || {};
            const ex = G.panel(cv, t, 24, 44, 760, 468, 'Over its life').h - 468, ey = Math.round(ex / 6);
            [['ENERGY THROUGHPUT', num(b.kwh, 1, 'kWh')], ['CHARGED IN TOTAL', num(b.ahIn, 1, 'Ah')],
                ['DISCHARGED IN TOTAL', num(b.ahOut, 1, 'Ah')], ['PACK VOLTAGE', num(b.pack, 2, 'V')]]
                .forEach((r, i) => row(cv, t, 48, 712, 136 + i * (80 + ey), r[0], r[1]));
            G.panel(cv, t, 808, 44, 768, 468, 'Capacity and resistance');
            const worn = G.isNum(b.rNow) && G.isNum(b.rNew) && b.rNow > b.rNew * 1.5 ? t.warn : null;
            [['NOMINAL CAPACITY', num(b.capNom, 1, 'Ah')], ['MEASURED CAPACITY', num(b.capMeas, 1, 'Ah')],
                ['CURRENT CAPACITY', num(b.capNow, 1, 'Ah')], ['RESISTANCE NOW', num(b.rNow, 2, 'mOhm'), worn],
                ['RESISTANCE WHEN NEW', num(b.rNew, 2, 'mOhm')], ['CHARGE · HEALTH ESTIMATE QUALITY', (G.isNum(b.socQ) ? G.fmt(b.socQ, 0) + ' %' : '--') + ' · ' + (G.isNum(b.sohQ) ? G.fmt(b.sohQ, 0) + ' %' : '--')]]
                .forEach((r, i) => row(cv, t, 832, 720, 136 + i * (62 + ey), r[0], r[1], r[2]));
        }

        /** 48 V mild hybrids: the 48 V battery, the converter between it and the 12 V side, the 12 V battery. */
        function render48(cv, t, d) {
            const b = d.b48 || {}, dc = d.dc || {}, has = G.isNum(b.soc);
            // the 48 V battery: charge, what it does now, voltage, power, health, temperature
            const ex = G.panel(cv, t, 24, 44, 720, 468, '48 V battery').h - 468, ey = Math.round(ex / 2);
            const sw = cv.text(has ? G.fmt(b.soc, 0) : '--', 48, 196, 120, has ? t.text : t.dim, { font: 'num' });
            cv.text('%', 58 + sw, 196, 38, t.dim, { font: 'bold' });
            const a = b.a, kw = G.isNum(a) && G.isNum(b.v) ? a * b.v / 1000 : null;
            const what = !G.isNum(a) ? [diagHint(d.b48 ? 'no current reading' : 'no reading yet'), t.dim]
                : a < -1 ? ['CHARGING', GO] : a > 1 ? ['SUPPLYING', t.text] : ['IDLE', t.dim];
            cv.text(what[0], 720, 150, 28, what[1], { font: 'bold', spacing: 1, align: 'right' });
            battery(cv, t, 48, 232 + ey, 630, 84, b.soc);
            const hc = !G.isNum(b.soh) ? null : b.soh < 70 ? t.crit : b.soh < 80 ? t.warn : null;
            [['VOLTAGE', num(b.v, 1, 'V')], ['POWER', signed(kw, 2, 'kW'), G.isNum(kw) && kw < 0 ? GO : null],
                ['HEALTH', num(b.soh, 0, '%'), hc], ['TEMPERATURE', G.isNum(b.temp) ? G.fmt(T(b.temp), 0) + ' ' + tU() : '--']]
                .forEach((r, i) => row(cv, t, 48 + (i % 2) * 348, 300, 380 + ey + Math.floor(i / 2) * 56, r[0], r[1], r[2]));

            // the converter: which way it works, each side's voltage, current and power
            G.panel(cv, t, 768, 44, 808, 225, 'DC/DC converter');
            const mode = G.isNum(dc.mode) ? DC_MODES[dc.mode] || 'Mode ' + dc.mode : null;
            cv.text(mode || diagHint('no reading yet'), 792, 146, mode ? 34 : 22, !mode ? t.dim : dc.mode === 5 || dc.mode >= 12 ? t.warn : t.text, { font: 'bold' });
            const side = (v, i, w) => num(v, 1, 'V') + '   ' + signed(i, 1, 'A') + '   ' + signed(w, 0, 'W');
            row(cv, t, 792, 760, 196, '12 V SIDE', side(dc.v12, dc.a12, dc.w12));
            row(cv, t, 792, 760, 240, '48 V SIDE', side(dc.v48, dc.a48, dc.w48));

            // the 12 V battery the converter keeps charged
            const ex2 = G.panel(cv, t, 768, 287, 808, 225, '12 V battery').h - 225;
            const vw = cv.text(G.isNum(d.v12) ? G.fmt(d.v12, 2) : '--', 792, 395, 72, G.isNum(d.v12) ? t.text : t.dim, { font: 'num' });
            cv.text('V', 802 + vw, 395, 28, t.dim);
            const [state, col] = v12State(t, d.v12);
            cv.text(state, 1552, 360, 22, col, { font: 'bold', align: 'right' });
            const x = d.x12 || {};
            row(cv, t, 792, 760, 470 + ex2, 'CURRENT · CHARGE', signed(x.i12, 1, 'A') + '   ' + num(G.isNum(x.soc12) ? x.soc12 : x.signal, 0, '%'));
        }

        function renderMain(cv, t, d) {
            const e = estimate(d.soc, d.ambient, null, d.pace, comfortKw(d)), has = G.isNum(d.soc);
            const ec = estimate(d.soc, d.ambient, d.climate, d.pace, comfortKw(d));      // the climate line's figures

            // ---- range: what is left until the engine starts
            // the room under the page (if any): the bars and the last charge go down with the panels' bottom
            const bev = isBev();
            const ex = G.panel(cv, t, 24, 44, 720, 468, bev ? 'Real range' : 'Real electric range').h - 468, ey = Math.round(ex / 2);
            const hold = !bev && has && d.soc <= HOLD_TOP + 0.5;       // low-battery hybrid zone (none without an engine)
            if (hold) {
                cv.text('HYBRID', 48, 196, 96, t.warn, { font: 'bold' });
                cv.text(translate('battery held at') + ' 5-' + HOLD_TOP + ' %', 720, 196, 26, t.dim, { align: 'right' });
            } else {
                // (the tabs' big value alike: 120 on y 196, the unit 38 beside it, as Energy and Battery)
                const rw = cv.text(has ? String(Math.round(D(e.mid))) : '--', 48, 196, 120, has ? t.text : t.dim, { font: 'num' });
                cv.text(dU(), 58 + rw, 196, 38, t.dim, { font: 'bold' });
                if (has) cv.text(Math.round(D(e.lo)) + ' - ' + Math.round(D(e.hi)) + ' ' + dU(), 720, 150, 30, t.text, { font: 'bold', align: 'right' });
                cv.text(bev ? 'down to ' + G.fmt(e.res, 0) + ' %' : 'engine starts at ' + G.fmt(e.res, 0) + ' %', 720, 196, 26, t.dim, { align: 'right' });
                cv.text(e.learned ? 'learned from ' + Math.round(D(st.learn.km)) + ' ' + dU() : 'Learns while driving', 720, 236, 22, t.dim, { align: 'right' });
            }
            // one status line under the number: low battery / engine on, else a missing or old charge reading
            const eu = d.engine ? model.enginePctPerKm(d.speed) : null;
            if (hold) {
                // low battery: the car drives as a hybrid and keeps the charge at 5-11 %
                cv.text('Low battery: electric up to ' + Math.round(D(62)) + ' ' + (MI() ? 'mph' : 'km/h') + ', light throttle', 48, 250, 22, t.warn, { font: 'bold' });
            } else if (d.engine) {
                // engine running: what the battery does meanwhile (learned with the engine on), per 10 km / mi
                const per10 = G.isNum(eu) ? (MI() ? eu / KM_MI : eu) * 10 : null, u10 = MI() ? '10 mi' : '10 km';
                cv.text('ENGINE ON  ·  ' + (!G.isNum(per10) ? 'learning' : per10 < -0.05 ? 'charging +' + G.fmt(-per10, 1) + ' % per ' + u10
                    : 'battery helps -' + G.fmt(per10, 1) + ' % per ' + u10), 48, 250, 22, t.warn, { font: 'bold' });
            } else if (!has) cv.text(diagHint('no charge reading yet'), 48, 250, 24, t.dim);
            else if (d.stale) cv.text('charge read ' + ago(d.socAge), 48, 250, 24, t.warn);
            // the range on a bar (full charge at the end)
            G.bar(cv, t, 48, 262 + ey, 672, 92, {
                label: 'Full: ' + Math.round(D(e.full)) + ' ' + dU(), value: has ? D(e.mid) : null, unit: dU(), max: D(e.full), niceMax: true, ramp: 'hot',
            });
            // the battery's power now: regen to the left, use to the right (live.js), as the Full bar above it
            // (its scale ends G.MARGIN over the panel's bottom)
            lv.drawPowerBar(cv, t, 48, G.BOTTOM - G.MARGIN - 92 + ex, 672);
            // climate control + on-board electrics: costs range by the hour (off: the on-board draw only)
            const ac = ec.climate !== false && ec.auxKw >= 1.5 ? t.warn : t.dim;
            const what = ec.climate === false ? 'CLIMATE OFF  ·  ON-BOARD  ' : ec.climate ? 'CLIMATE ON' + (d.ac ? ' (A/C)' : '') + '  ' : 'CLIMATE & ON-BOARD  ';
            // the range the climate costs (above the on-board draw it would have off); unknown climate: the whole draw
            const costKm = ec.climate === null || ec.climate === undefined ? ec.auxKm : ec.climateKm;
            const seats = G.isNum(ec.comfortKm) && ec.comfortKm >= 0.5 && has ? '  ·  SEATS -' + Math.round(D(ec.comfortKm)) + ' ' + dU() : '';
            // (shown at the foot of This drive)
            const climFoot = [[what.trim(), ac], [G.fmt(ec.auxKw, 1) + ' kW' + (ec.auxLearned ? '' : ' (typical)')
                + (G.isNum(costKm) && costKm >= 0.5 && has ? '  ·  -' + Math.round(D(costKm)) + ' ' + dU() : '') + seats, ac]];

            // ---- charge + last charge
            G.panel(cv, t, 768, 44, 380, 468, 'Charge');
            battery(cv, t, 796, 101, 300, 106, d.soc);
            const ss = G.isNum(d.soc) ? G.fmt(d.soc, 0) : '--';
            const sw = cv.text(ss, 940, 296, 92, G.isNum(d.soc) ? t.text : t.dim, { font: 'num', align: 'center' });
            cv.text('%', 950 + sw / 2, 296, 34, t.dim, { font: 'bold' });
            // 12 V battery: resting ~12.4-12.8 V, 13.5-14.8 V while the DC/DC or alternator charges it
            const v = d.v12, vcol = !G.isNum(v) ? t.dim : v < 11.8 ? t.crit : v < 12.2 || v > 15.2 ? t.warn : t.text;
            const vw = cv.text(G.isNum(v) ? v.toFixed(2) + ' V' : '--', 1124, 340 + ey, 28, vcol, { font: 'bold', align: 'right' });
            cv.text('12 V', 792, 340 + ey, 22, t.dim, { font: 'bold', spacing: 1.5 });
            void vw;
            cv.fillRect(792, 357 + ey, 332, 1, t.tick);
            // (the last charge's lines end G.MARGIN over the panel's bottom)
            const c = d.charge, lc = G.toMargin(ex, 18);
            cv.text(c && c.open ? 'CHARGING' : 'LAST CHARGE', 792, 393 + lc, 22, c && c.open ? GO : t.dim, { font: 'bold', spacing: 1.5 });
            if (c) {
                const add = c.to - c.from;
                const aw = cv.text('+' + add.toFixed(0) + ' %', 792, 446 + lc, 44, GO, { font: 'bold' });
                cv.text('+' + Math.round(D(kmOf(add))) + ' ' + dU(), 806 + aw, 444 + lc, 28, t.text, { font: 'bold' });
                // from -> to: the arrow drawn ('→' isn't in the baked fonts), as the text's colour and weight
                const ly = 489 + lc, fw = cv.text(String(Math.round(c.from)), 792, ly, 24, t.dim), ax = 792 + fw + 9, ay = ly - 8;
                cv.line(ax, ay, ax + 18, ay, 2, t.dim);
                cv.polyline([[ax + 12, ay - 5], [ax + 18, ay], [ax + 12, ay + 5]], 2, t.dim);
                cv.text(Math.round(c.to) + ' %  ·  ' + (c.open ? 'now' : ago(Date.now() - c.toT)), ax + 27, ly, 24, t.dim);
            } else {
                cv.text('none yet', 792, 446 + lc, 28, t.dim);
            }

            // ---- this drive (from the battery's own power readings, live.js)
            const holds = holdsKwh(d), inNow = inBatteryKwh(d);
            const inBat = G.isNum(inNow) ? [G.fmt(inNow, 1), G.fmt(holds, 1)] : ['--', G.fmt(holds, 1)];
            lv.drawTrip(cv, t, 1172, 44, 404, 468, climFoot, inBat);
            G.button(cv, t, 1576 - 20 - 120, 56, 120, 40, 'Reset', () => { lv.action('battery'); return render(); }, { key: 'trip', confirm: true });
        }

        /**
         * The Diagnostic page: the battery diagnostics, the battery unit, the scan and the car's signals, one
         * under the other, scrolled by a finger or the controller (ctx.onScroll). In software (no renderer to
         * move the parts) only the first part.
         */
        function renderDiagAll(cv, t, d) {
            const parts = (hasHv() ? DIAG_PARTS_HYBRID : DIAG_PARTS_12V).map((p) => ({
                diag: () => renderDiag(cv, t, d), signals: () => renderSignals(cv, t, d),
                unit: () => lv.draw('unit', cv, t),
                scan: () => { lv.draw('scan', cv, t); G.button(cv, t, 1576 - 20 - 120, 56, 120, 40, 'Reset', () => { lv.action('scan'); return render(); }, { key: 'scan', confirm: true }); },
            })[p]);
            const pl = cv.place;
            if (!pl) { parts[0](); return; }
            cv.scroll = true;
            diagScroll.max = Math.max(0, parts.length * DIAG_STEP - (H + (cv.extra || 0) - 44));
            diagScroll.y = G.clamp(diagScroll.y, 0, diagScroll.max);
            const sy = G.smooth('diagScroll', diagScroll.y, 22);
            const extra = cv.extra;
            cv.extra = 0;                // (each part is a page of its own height)
            cv.clip(0, 38, W, H + extra - 38);
            parts.forEach((draw, i) => {
                const oy = i * DIAG_STEP - sy;
                if (oy > H || oy + DIAG_STEP < 0) return;
                const n0 = cv.targets.length;
                cv.xf(pl.scale, pl.ox, pl.oy + oy * pl.scale);
                draw();
                cv.xf();
                for (let k = n0; k < cv.targets.length; k++) cv.targets[k].y += oy;
            });
            cv.noclip();
            cv.extra = extra;
            const vis = H + extra - 44, bh = Math.max(40, vis * vis / (vis + diagScroll.max));
            cv.roundRect(W - 9, 44 + (vis - bh) * (diagScroll.max ? sy / diagScroll.max : 0), 6, bh, 3, withAlpha('#ffffff', 0.3));
        }

        /** Battery health (capacity vs. new), energy in the pack now and its temperature - on the Battery page, under the cells. */
        function renderHealth(cv, t, d, x, y, w, h) {
            const soh = d.soh, kwh = newKwh();
            // what a full charge holds today: a fully electric car's battery unit says so itself (no health needed)
            const capKwh = isBev() ? d.cap : null;
            const cap = G.isNum(capKwh) ? capKwh : G.isNum(soh) ? kwh * soh / 100 : null;
            // energy in the pack right now
            const now = isBev() && G.isNum(d.stored) ? Math.max(0, d.stored) : G.isNum(cap) && G.isNum(d.soc) ? cap * d.soc / 100 : null;
            // room below the page (ex): the energy now goes down until it ends G.MARGIN over the panel's bottom, as the
            // Cells panel's chart; the Holds bar half as far
            const ex = G.panel(cv, t, x, y, w, h, 'Battery health').h - h, dy = G.toMargin(ex, 49), dh = Math.round(dy / 2);
            const hc = !G.isNum(soh) ? t.dim : soh < 70 ? t.crit : soh < 80 ? t.warn : t.text;
            // HV battery temperature (the car's own value): cold packs give less range and charge slower
            const bt = d.batt && d.batt.avg, btc = !G.isNum(bt) ? t.dim : bt < 5 || bt > 45 ? t.warn : t.text;
            if (h >= 300) {
                // the full layout: health, how much a full charge holds (bar against new), in it now, temperature
                // (the tabs' big value alike: 120 on y + 152, the unit 38 beside it, as Range and Energy)
                const hw = cv.text(G.isNum(soh) ? G.fmt(soh, 0) : '--', x + 24, y + 152, 120, hc, { font: 'num' });
                cv.text('%', x + 34 + hw, y + 152, 38, t.dim, { font: 'bold' });
                if (!G.isNum(soh)) cv.text(diagHint('not read yet'), x + 24, y + 170, 22, t.dim);
                G.bar(cv, t, x + 24, y + 178 + dh, w - 48, 92, {
                    label: 'Holds', value: cap, unit: 'kWh', decimals: 1, max: kwh, step: kwh / 4, scaleDecimals: kwh % 4 ? 1 : 0, ramp: 'hot',
                    zones: [{ from: 0, to: kwh * 0.7, color: 'crit' }, { from: kwh * 0.7, to: kwh * 0.8, color: 'warn' }],
                });
                cv.fillRect(x + 24, y + 304 + dy, w - 48, 1, t.panelEdge);
                cv.text('IN THE BATTERY NOW', x + 24, y + 342 + dy, 22, t.dim, { font: 'bold', spacing: 1.5 });
                const ew = cv.text(G.isNum(now) ? G.fmt(now, 1) : '--', x + 24, y + 418 + dy, 72, G.isNum(now) ? t.text : t.dim, { font: 'num' });
                cv.text('kWh', x + 34 + ew, y + 418 + dy, 28, t.dim);
                // (the temperature: the Cells panel's, from the battery unit)
                return;
            }
            const tall = false, hy = y + 118;
            const hw = cv.text(G.isNum(soh) ? G.fmt(soh, 0) : '--', x + 24, hy, 64, hc, { font: 'num' });
            cv.text(G.isNum(soh) ? '%' : diagHint('not read yet'), x + 32 + hw, hy, G.isNum(soh) ? 26 : 18, t.dim, { font: 'bold' });
            const r = x + w - 24, line = (yy, label, val, c) => {
                const vw2 = cv.text(val, r, yy, 22, c || t.text, { font: 'bold', align: 'right' });
                cv.text(label, r - vw2 - 14, yy, 18, t.dim, { font: 'bold', spacing: 1.2, align: 'right' });
            };
            const ly = tall ? [y + 340, y + 382, y + 424] : [y + 78, y + 108, y + 138];
            line(ly[0], 'HOLDS', G.isNum(cap) ? G.fmt(cap, 1) + ' kWh' : '--');
            line(ly[1], 'IN IT NOW', G.isNum(now) ? G.fmt(now, 1) + ' kWh' : '--');
            line(ly[2], 'TEMP', G.isNum(bt) ? Math.round(T(bt)) + (F() ? '°F' : '°C') : '--', btc);
        }

        const pad = (n) => (n < 10 ? '0' : '') + n;
        const dateOf = (ms) => { const x = new Date(ms); return pad(x.getDate()) + '.' + pad(x.getMonth() + 1) + '  ' + pad(x.getHours()) + ':' + pad(x.getMinutes()); };
        const price = () => settings.get('price') || 0;
        const money = (kwh) => (G.isNum(kwh) && price() > 0 ? (kwh * LOSS * price()).toFixed(2) + ' €' : null);

        function renderLog(cv, t, d) {
            const all = d.demo ? demo.log() : (st.log || []);
            const kwhOf = (c) => (G.isNum(c.kwh) ? c.kwh : 0);

            // ---- list, newest first
            const ex = G.panel(cv, t, 24, 44, 1040, 468, 'Charges' + (all.length ? '  (' + all.length + ')' : '')).h - 468;
            // room below the page: another row where a whole one fits, the rest spread over the rows
            const nRows = 8 + Math.floor(ex / 43), rowP = 43 + (ex - (nRows - 8) * 43) / nRows;
            const cols = [48, 230, 380, 590, 760, 920];
            ['DATE', 'ADDED', 'FROM - TO', 'ENERGY', 'RANGE', price() > 0 ? 'COST' : ''].forEach((h, i) => cv.text(h, cols[i], 121, 22, t.dim, { font: 'bold', spacing: 1 }));
            cv.fillRect(48, 133, 992, 1, t.panelEdge);
            if (!all.length) {
                const ny = Math.round(ex / 2);
                cv.text('No charges logged yet.', 544, 284 + ny, 32, t.dim, { align: 'center', font: 'bold' });
                cv.text('Every charge of ' + cfg.chargeMinPct + ' % or more shows up here,', 544, 330 + ny, 26, t.dim, { align: 'center' });
                cv.text('also overnight charges.', 544, 366 + ny, 26, t.dim, { align: 'center' });
            }
            all.slice(-nRows).reverse().forEach((c, i) => {
                const y = Math.round(174 + i * rowP);
                if (i % 2 === 0) cv.roundRect(40, y - 28, 1008, 38, 8, withAlpha(t.track, 0.55));
                const add = c.to - c.from;
                cv.text(dateOf(c.toT), cols[0], y, 24, t.text, { font: 'label' });
                cv.text('+' + add.toFixed(0) + ' %', cols[1], y, 26, GO, { font: 'bold' });
                cv.text(Math.round(c.from) + ' - ' + Math.round(c.to) + ' %', cols[2], y, 24, t.dim, { font: 'label' });
                cv.text(G.isNum(c.kwh) ? c.kwh.toFixed(1) + ' kWh' : '-', cols[3], y, 24, t.text, { font: 'label' });
                cv.text('+' + Math.round(D(kmOf(add))) + ' ' + dU(), cols[4], y, 24, t.text, { font: 'label' });
                const m = money(c.kwh);
                if (m) cv.text(m, cols[5], y, 24, t.text, { font: 'label' });
            });

            // ---- totals + 14-day chart
            G.panel(cv, t, 1088, 44, 488, 468, 'Totals');
            const now = new Date(), monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
            const month = all.filter((c) => c.toT >= monthStart);
            const sum = (list) => list.reduce((a, c) => a + kwhOf(c), 0);
            const block = (y, label, list) => {
                cv.text(label, 1112, y, 22, t.dim, { font: 'bold', spacing: 1 });
                const kw = cv.text(sum(list).toFixed(1), 1112, y + 52, 48, t.text, { font: 'num' });
                cv.text('kWh', 1120 + kw, y + 52, 24, t.dim);
                const m = money(sum(list));
                if (m) cv.text(m, 1552, y + 52, 30, t.text, { align: 'right', font: 'bold' });
                cv.text(list.length + ' ' + plural(list.length, 'charge', 'charges') + '  ·  +' + Math.round(D(kmOf(list.reduce((a, c) => a + (c.to - c.from), 0)))) + ' ' + dU(), 1552, y, 22, t.dim, { align: 'right' });
            };
            block(116, 'THIS MONTH', month);
            block(208, 'ALL TIME', all);
            // kWh per day, last 14 days
            const day = 86400000, today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
            const days = [];
            for (let i = 13; i >= 0; i--) days.push(sum(all.filter((c) => c.toT >= today0 - i * day && c.toT < today0 - (i - 1) * day)));
            const top = Math.max(4, Math.max.apply(null, days));
            // (taller into the room below the page; its label then ends G.MARGIN over the panel's bottom, as the list's rows)
            const dg = G.toMargin(ex, 9), gx = 1112, gy = 470 + dg, gh = 132 + dg, bw = 440 / 14;
            cv.text('KWH PER DAY, 14 DAYS', gx, 318, 22, t.dim, { font: 'bold', spacing: 1 });
            days.forEach((v, i) => {
                const h = v > 0 ? Math.max(6, v / top * gh) : 0;
                cv.roundRect(gx + i * bw + 3, gy - gh, bw - 6, gh, 4, withAlpha(t.track, 0.6));
                if (h) cv.rampRect(gx + i * bw + 3, gy - h, bw - 6, h, 4, t.ramp || [t.accent]);
            });
            cv.text('today', gx + 440, gy + 28, 22, t.dim, { align: 'right' });
        }

        function renderDiag(cv, t, d) {
            G.panel(cv, t, 24, 44, 1552, 468, 'Battery diagnostics');
            const link = diag.p ? (diag.available ? 'link up' : 'link down') : 'no link (' + (diag.error || 'not started') + ')';
            cv.text('UDS 22 ReadDataByIdentifier / OBD 01  ·  ' + link + '  ·  ' + translate('ambient') + ' ' + (G.isNum(live.ambient) ? G.fmt(live.ambient, 1) + ' °C' : translate('n/a'))
                + '  ·  ' + translate('speed') + ' ' + (G.isNum(live.speed) ? G.fmt(G.hold('speed', live.speed), 0) + ' km/h' : translate('n/a'))
                + '  ·  ' + translate('climate') + ' ' + (live.climate === null ? translate('n/a') : translate(live.climate ? 'on' : 'off')) + (live.ac ? ' (A/C)' : ''), 48, 121, 24, t.text, { font: 'label' });
            const cols = [48, 160, 260, 380, 820, 1000, 1290];
            ['VALUE', 'ECU', 'DID', 'REPLY', 'DECODED', 'STATUS', 'READ'].forEach((h, i) => cv.text(h, cols[i], 167, 22, t.dim, { font: 'bold', spacing: 1 }));
            cv.fillRect(48, 178, 1504, 1, t.tick);
            // every candidate gets a row: the rows shrink to fit between the header and the note at the bottom
            const keys = VALUES.concat(kind() === 'mhev' ? VALUES_48V.concat(VALUES_12V) : kind() === 'none' ? VALUES_12V : kind() === 'bev' ? ['energy'] : []);
            const n = keys.reduce((a, key) => a + (cfg[key] || []).length, 0);
            const rowH = Math.min(38, Math.floor(232 / Math.max(1, n))), fs = rowH >= 34 ? 24 : Math.max(15, rowH - 3), fsS = Math.max(14, fs - 2);
            let y = 178 + Math.max(24, rowH);
            keys.forEach((key) => (cfg[key] || []).forEach((c, i) => {
                const ecu = c.ecu == null ? cfg.ecu : c.ecu, r = raws[reader.key(c)];
                const used = pick[key] === i && r && r.ok;
                cv.text(key.toUpperCase() + (used ? ' *' : ''), cols[0], y, fs, used ? GO : t.text, { font: 'bold' });
                cv.text('0x' + hex(ecu), cols[1], y, fs, t.text, { font: 'label' });
                cv.text(DidReader.label(c), cols[2], y, fs, t.text, { font: 'label' });
                const bytes = r ? r.bytes || '-' : '-';
                cv.text(bytes.length > 36 ? bytes.slice(0, 35) + '…' : bytes, cols[3], y, fsS, t.dim, { font: 'label' });
                cv.text(r && G.isNum(r.value) ? G.fmt(r.value, key === 'v12' ? 2 : 1) : '-', cols[4], y, fs, t.text, { font: 'label' });
                const why = r ? (r.ok ? 'OK' : r.why) : 'not read';
                cv.text(why.length > 24 ? why.slice(0, 23) + '…' : why, cols[5], y, fsS, r && r.ok ? GO : r ? t.warn : t.dim, { font: 'label' });
                cv.text(r ? ago(Date.now() - r.t) : '-', cols[6], y, fsS, t.dim, { font: 'label' });
                y += rowH;
            }));
            cv.text('A value n/a or wrong? Adjust config.battery in apps/edrive/app.json and rebuild.', 48, 488, 20, t.dim);
            if (d.demo) cv.text('Main page: demo data until the link answers', 1552, 488, 20, t.warn, { align: 'right' });
        }

        /** The car's signals as received (climate, comfort, power figures), one per line - for checking scalings. */
        function renderSignals(cv, t, d) {
            G.panel(cv, t, 24, 44, 1552, 468, 'Car signals');
            const seatTxt = Object.keys(live.seats).map((k) => k + ' ' + (live.seats[k] === null ? '?' : live.seats[k])).join(' ') || translate('n/a');
            const bt = live.batt;
            cv.text('climate ' + (live.climate === null ? translate('n/a') : live.climate === 'ac' ? translate('on') + ' (A/C)' : translate(live.climate ? 'on' : 'off'))
                + '  ·  blower ' + (G.isNum(live.blower) ? live.blower + ' / ' + live.blowerTop : translate('n/a')) + '  ·  seats ' + seatTxt
                + '  ·  wheel ' + (live.wheel === null ? translate('n/a') : translate(live.wheel ? 'on' : 'off')) + '  ·  pace ' + (G.isNum(paceNow()) ? Math.round(paceNow()) + ' km/h' : translate('n/a'))
                + '  ·  battery ' + (bt && G.isNum(bt.avg) ? bt.avg + ' °C (' + bt.min + '..' + bt.max + ')' : translate('n/a'))
                + '  ·  HV ' + (G.isNum(live.hvV) ? live.hvV : translate('n/a')), 48, 112, 21, t.text, { font: 'label' });
            cv.fillRect(48, 128, 1504, 1, t.tick);
            const rows = [['A/C', rawClimate['A/C']], ['blower', rawClimate.blower], ['compressor', rawClimate.compressor],
                ['climate', rawClimate.climate], ['ac', rawClimate.ac]].concat(Object.keys(live.raw).sort().map((k) => [k, live.raw[k]]));
            // up to 14 rows between the summary and the note: the spacing shrinks to fit them all
            const step = Math.min(26, Math.floor(310 / Math.max(1, rows.length))), fz = step >= 24 ? 18 : 16;
            let y = 154;
            rows.forEach(([k, v]) => {
                if (y > 470) return;
                cv.text(k, 48, y, fz + 1, t.dim, { font: 'bold' });
                const txt = v || '-';
                cv.text(txt.length > 160 ? txt.slice(0, 159) + '…' : txt, 230, y, fz, v ? t.text : t.dim, { font: 'label' });
                y += step;
            });
            cv.text('Raw values as the car sends them - for checking the scalings (config.scaling in app.json).', 48, 498, 18, t.dim);
        }

        /** Energy: use per speed band, where the power goes now, the car's own figures, battery temperature. */
        function renderEnergy(cv, t, d) {
            const k = kwhPerPct(), comfort = comfortKw(d);
            const e = estimate(d.soc, d.ambient, d.climate, d.pace, comfort), has = G.isNum(d.soc);

            // ---- the battery's power now: kW, bar, the last two minutes (live.js)
            lv.drawPower(cv, t, 24, 44, 740, 468);
            // the range at the rate the battery itself measured: energy above the engine-start point / kWh per km lately
            const use = lv.consumption(), usable = has ? k * Math.max(0, d.soc - e.res) : null;
            const measured = G.isNum(usable) && G.isNum(use.perKm);
            const rr = measured ? usable / use.perKm : e.mid;          // not measured yet: the learned range

            // ---- where the power goes now
            const x0 = 788, w0 = 788;
            const ex = G.panel(cv, t, x0, 44, w0, 468, 'Where the power goes now').h - 468;   // (room below the page: rows spread, range at the bottom)
            const base = model.auxRate(d.ambient, k, false).rate * k;
            // the climate: measured from the battery or the climate unit's figures (live.js) when there are, else the estimate
            // (the measurement holds the seat and wheel heating too: they have rows of their own)
            const lc = d.demo ? null : lv.climate();
            const climKw = d.climate === false && !lc ? 0 : lc ? Math.max(0, lc.kw - comfort) : Math.max(0, e.auxKw - base);
            const blow = d.climate === false ? 0 : Math.min(climKw, blowerKw(d));
            const seatKw = comfort - (d.wheel ? WHEEL_KW : 0), wheelKw = d.wheel ? WHEEL_KW : 0;
            const share = (kw) => (G.isNum(e.comfortKm) && comfort > 0 ? e.comfortKm * kw / comfort : null);
            // driving: learned % per km at the pace; before that the typical range (all use per km) less
            // what the climate, on-board electrics and seat heating draw
            // moving with the engine off: live - the battery's power now less what the rest draws; else the learned figure
            const pwNow = d.demo ? null : lv.powerNow(t).kw;
            const liveDrive = G.isNum(pwNow) && !d.engine && G.isNum(d.speed) && d.speed > 2
                ? Math.max(0, pwNow - climKw - (comfort || 0) - base) : null;
            const driveKw = G.isNum(liveDrive) ? liveDrive : !G.isNum(e.pace) ? null : G.isNum(e.perKm) ? e.perKm * k * e.pace
                : G.isNum(e.kpp) && e.kpp > 0 ? Math.max(0, (1 / e.kpp) * k * e.pace - e.auxKw - (comfort || 0)) : null;
            const seatTxt = Object.keys(d.seats || {}).filter((s2) => d.seats[s2]).map((s2) => ({ DR: 'driver', PS: 'pass.', DRR: 'rear L', PSR: 'rear R' }[s2] + ' ' + d.seats[s2])).join(', ');
            const rows = [
                ['Driving', driveKw, null,
                    G.isNum(liveDrive) ? 'live, at ' + Math.round(D(d.speed)) + ' ' + (MI() ? 'mph' : 'km/h')
                        : G.isNum(e.pace) ? translate('at') + ' ' + Math.round(D(e.pace)) + ' ' + (MI() ? 'mph' : 'km/h') + (e.learned ? '' : ' (typical)') : 'learns as you drive'],
                ['Climate (heating / A/C)', climKw, has && d.climate !== false ? e.climateKm : null,
                    lc ? (lc.how === 'measured' ? 'from the battery' : lc.how === 'climate unit' ? 'climate unit' : 'measured before')
                        + (blow > 0 ? ', blower ~' + G.fmt(blow, 2) + ' kW' : '')
                        : d.climate === false ? 'off' : (e.auxLearned ? 'learned' : 'typical') + (blow > 0 ? ', blower ~' + G.fmt(blow, 2) + ' kW' : '')],
                ['Seat heating', seatKw, has ? share(seatKw) : null, seatTxt ? seatTxt + ' (est.)' : 'off'],
                ['Steering wheel', wheelKw, has ? share(wheelKw) : null, d.wheel === null || d.wheel === undefined ? translate('n/a') : d.wheel ? 'on (est.)' : 'off'],
                ['On-board electrics', base, null, 'screens, units, pumps'],
            ];
            ['', 'KW', 'RANGE', ''].forEach((h, i) => cv.text(h, [x0 + 24, x0 + 400, x0 + 500, 0][i], 116, 20, t.dim, { font: 'bold', spacing: 1, align: 'right' }));
            rows.forEach(([name, kw, km, note], i) => {
                const y = Math.round(160 + i * (52 + ex / 5));
                cv.text(name, x0 + 24, y, 24, t.text, { font: 'bold' });
                cv.text(G.isNum(kw) ? G.fmt(kw, kw < 1 ? 2 : 1) : '-', x0 + 400, y, 24, G.isNum(kw) && kw >= 1.5 ? t.warn : t.text, { font: 'bold', align: 'right' });
                cv.text(G.isNum(km) && km >= 0.5 ? '-' + Math.round(D(km)) + ' ' + dU() : '', x0 + 500, y, 22, t.text, { align: 'right' });
                cv.text(note.length > 30 ? note.slice(0, 29) + '…' : note, x0 + 520, y, 19, t.dim);
            });
            // the car's own "power distribution" display (scaling not known yet: shown as sent)
            // (255 = the car doesn't send that value: left out; nothing at all: the line is left out)
            const pd = live.pd || {};
            const sent = [['drive', pd.displayRepartitionDriveElectricPower], ['climate', pd.displayRepartitionAirConditioningElectricPower],
                ['seat bars', pd.displayRepartitionElectricSeatHeater], ['climate boost', pd.displayRepartitionElectricRangeAirConditioningBoost]]
                .filter(([, v]) => G.isNum(v) && v !== 255);
            void sent;
            // learned range vs. the range at the rate measured lately
            const kmTxt = (km) => (G.isNum(km) && has ? Math.round(D(km)) + ' ' + dU() : '--');
            cv.text('RANGE AT THIS RATE', x0 + 24, 486 + ex, 22, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text(kmTxt(rr), x0 + w0 - 24, 490 + ex, 40, measured ? t.text : t.dim, { font: 'bold', align: 'right' });
        }

        function render() {
            const t = ctx.theme();
            let d = data();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const pg = pages();
            if (page >= pg.length) { page = 0; actionLabel(); }
            if (isLive(pg[page])) {
                const own = d;
                d = lv.draw(pg[page], cv, t);
                if (pg[page] === 'battery') renderHealth(cv, t, own, 24, 44, 560, 468);
            }
            else if (pg[page] === 'diag') renderDiagAll(cv, t, d);
            else if (pg[page] === 'energy') renderEnergy(cv, t, d);
            else if (pg[page] === 'log') renderLog(cv, t, d);
            else if (hasHv()) renderMain(cv, t, d);
            else if (pg[page] === 'b48info') render48Info(cv, t, d);
            else if (kind() === 'mhev') render48(cv, t, d);
            else d = Object.assign({}, d, b12.draw(pg[page] === 'hist12' ? 'hist12' : 'main', cv, t));
            header(cv, t, d);
            return ui.image('MAIN_GFX', cv);
        }

        // every screen refresh (60 fps) with the GPU renderer; 2 fps in software (PNG frames)
        ctx.loop('MAIN', 2, render);
        settings.onChange((k) => {
            if (k === 'poll') schedule();
            if (k === 'diagPage' || k === 'hybrid') actionLabel();
            // switched to or from fully electric: an engine speed seen before says nothing now
            if (k === 'hybrid') { live.rpm = null; seg.engine = false; seg.engineAll = false; live.rest = null; }
        });
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
