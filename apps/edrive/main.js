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
 *   - cars without a hybrid system: when the battery unit never answers but the
 *     rest of the car does, only the 12 V battery is shown (setting "Hybrid system")
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
const { RangeModel } = require('./range');
const startLive = require('./live');

const W = 1600, H = 520;
const GO = '#2fd27a';
// the live pages (battery; the battery unit and scan with the diagnostics) are live.js's
const PAGES_HYBRID = ['main', 'energy', 'battery', 'log', 'diag', 'unit', 'scan', 'signals'];
const PAGES_12V = ['main', 'diag', 'signals'];
const DIAG_PAGES = ['diag', 'unit', 'scan', 'signals'];
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
const V12_HIST = 120;            // 12 V samples kept (one per 30 s = 1 h)
const RESERVE = 8;               // engine-start charge (%) until two engine starts have been seen
// Low battery: the car holds the charge at about 5-11 % and drives as a hybrid - electric only up to
// 62 km/h with light throttle (~18 %), the engine above; lifting off / braking recharge it. Engine starts
// there come from speed / throttle, not from an empty battery, and the charge moves with regen: nothing
// in this zone teaches the range, and the range counts down to its top.
const HOLD_TOP = 11;

/**
 * Range of a full battery by outside temperature, for a car doing 50 km at 20 °C:
 * [°C, low km, high km]. Linear in between; warmer than 20 °C counts as 20 °C, colder
 * than -10 °C continues the -10..0 slope (never below 30 % of the 20 °C range).
 * Scaled by the "range at 20 °C" setting.
 */
const RANGE_CURVE = [[-10, 20, 30], [0, 30, 38], [10, 40, 45], [20, 50, 50]];

/** Demo: charge drains, outside temperature swings across the cold threshold. */
class Demo {
    constructor() { this.t0 = Date.now(); }
    sample() {
        const s = (Date.now() - this.t0) / 1000;
        return {
            soc: 100 - (s * 0.8) % 95, soh: 91.5, ambient: 6 + 14 * Math.sin(s / 12), v12: 12.45 + 0.05 * Math.sin(s / 5),
            climate: s % 30 < 10 ? 'ac' : s % 30 < 20, ac: s % 30 < 10,
            pace: 55 + 25 * Math.sin(s / 20), seats: { DR: 2, PS: s % 30 < 15 ? 1 : 0 }, wheel: true, blower: 4,
            batt: { avg: 18, min: 17, max: 20 },
            charge: { from: 28, to: 97, toT: this.t0 - 3 * 3600000, kwh: 7.6 },
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
                this._log.push({ from, to, fromT: t - 4 * 3600000, toT: t, kwh: (to - from) / 100 * 12 * 0.915 });
            }
        }
        return this._log;
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
        let savedAt = 0;
        const save = () => {
            savedAt = Date.now();
            try { fs.writeFileSync(STATE, JSON.stringify(st)); } catch (e) { log.warn('save: ' + e); }
        };
        const live = { soc: null, socT: 0, soh: G.isNum(st.soh) ? st.soh : null, sohT: st.sohT || 0, v12: null, v12T: 0, ambient: null, speed: null, rpm: null, rpmT: 0,
            climate: null, ac: null, seats: {}, wheel: null, blower: null, blowerTop: 8, pd: null, batt: null, hvV: null,
            pace: null, lastMove: 0, raw: {}, standSince: 0, acRaw: null, acKw: null, lscV: null, lscVT: 0 };

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

        /** kWh in 1 % of charge today (size when new x health). */
        const kwhPerPct = () => settings.get('designKwh') * (G.isNum(live.soh) ? live.soh : 100) / 100 / 100;

        ctx.signals.watch('de.bmw.infrastructure.EnvironmentalInformation', '1', {
            ExteriorTemperature: (v) => { const a = sc('ambient', v.temperatureExterior); if (a !== null) live.ambient = a; },
        }, log).then((s) => log.info('ambient ' + (s.error ? 'error: ' + s.error : 'subscribed')));
        ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusCarSpeed2: (v) => {
                const k = v.speedVehicleCentreOfGravity;
                live.speed = k === 65535 || k == null ? null : k * 0.015625;
                // standing since (live.js: the measured climate draw)
                if (G.isNum(live.speed) && live.speed > 1) live.standSince = 0;
                else if (G.isNum(live.speed) && !live.standSince) live.standSince = Date.now();
                onSpeed(live.speed);
            },
            highVoltageStorageInfoToExternal: (v) => rawSeen('HV energy', v),
        }, log).then((s) => log.info('speed ' + (s.error ? 'error: ' + s.error : 'subscribed')));
        ctx.signals.watch('de.bmw.infotainment.vehicle.CDS', '1', {
            statusEngineSpeed2: (v) => { const r = sc('rpm', v.actualValueRPMEngineCrankshaft); if (r !== null && r >= 0 && r < 12000) onRpm(r); },
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

        // connect in the background: the screen must not wait for the diagnostic link
        const diag = new Diag(ctx.signals, log);
        diag.quiet = true;                     // polled every few seconds: keep the log file small
        diag.init();
        const demo = new Demo();
        const usingDemo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !diag.available && !live.socT);

        /* ---------- UDS reads (candidates per value, see kit/dids.js) ---------- */
        const reader = new DidReader(diag, { ecu: cfg.ecu });
        const raws = reader.raws, pick = reader.pick;      // for the Diagnostics page
        // one request at a time on the diagnostic link: a queue rather than a plain chain, so a live
        // power read (urgent) goes ahead of the reads that wait
        const queue = [];
        let pumping = false;
        async function pump() {
            if (pumping) return;
            pumping = true;
            while (queue.length) {
                const j = queue.shift();
                try { j.res(await j.fn()); } catch (e) { j.rej(e); }
            }
            pumping = false;
        }
        const exclusive = (fn, urgent) => new Promise((res, rej) => {
            const j = { fn, res, rej };
            if (urgent) queue.unshift(j); else queue.push(j);
            pump();
        });
        const readValue = (key) => exclusive(() => reader.value(key, cfg[key]));

        /* ---------- last charge ----------
         * A charge = the charge level rising by >= chargeMinPct while the car stands still
         * (regen while driving doesn't count). The last reading is saved, so a charge done
         * while the head unit slept shows up as a jump at the next start. */
        const chargeKwh = (from, to) => (G.isNum(live.soh) ? (to - from) / 100 * settings.get('designKwh') * live.soh / 100 : null);
        function closeSession() {
            const s = st.session;
            st.session = null;
            if (s && s.to - s.from >= cfg.chargeMinPct) {
                st.lastCharge = { from: s.from, to: s.to, fromT: s.fromT, toT: s.toT, kwh: chargeKwh(s.from, s.to) };
                st.log = (st.log || []).concat([st.lastCharge]).slice(-LOG_MAX);
                log.info('charge ' + s.from.toFixed(1) + ' -> ' + s.to.toFixed(1) + ' %');
            }
            save();
        }
        function onSoc(soc, now) {
            const prev = st.lastSoc, moving = G.isNum(live.speed) && live.speed > 3;
            // since the last reading with the engine off throughout (and the car awake: rpm signal live):
            // standing / creeping teaches the climate + on-board draw per hour, driving the use per km
            const h = (now - (st.lastSocT || 0)) / 3600000;
            const held = G.isNum(prev) && Math.min(prev, soc) <= HOLD_TOP + 1;    // low-battery hybrid zone
            if (held) { /* the car manages the charge here: nothing to learn */ }
            else if (G.isNum(prev) && h < 120000 / 3600000 && !seg.engine && now - live.rpmT < 5000 && !st.session) {
                // seat / steering-wheel heating over the stretch: the mean of its start and end
                model.learn(prev - soc, h, seg.km, live.ambient, kwhPerPct(), stretchClimate(), (seg.comfort + comfortKw()) / 2);
            } else if (G.isNum(prev) && h < 120000 / 3600000 && seg.engine && seg.engineAll && now - live.rpmT < 5000 && !st.session) {
                // the engine ran the whole stretch: what the battery did meanwhile (drained or charged), on its own
                model.learnEngine(prev - soc, h, seg.km);
            }
            seg.km = 0; seg.engine = G.isNum(live.rpm) && live.rpm > 400; seg.engineAll = seg.engine;
            seg.climate = live.climate; seg.climateMixed = false; seg.comfort = comfortKw();
            if (G.isNum(prev)) {
                if (soc > prev + 0.3 && !moving) {
                    if (!st.session) st.session = { from: prev, fromT: st.lastSocT || now };
                    st.session.to = soc; st.session.toT = now;
                    save();
                } else if (st.session && (soc < st.session.to - 2 || moving)) {
                    // ends when driving off or on a real drop; small dips while parked (cabin
                    // pre-conditioning, display wobble) keep the session open
                    closeSession();
                }
            }
            st.lastSoc = soc; st.lastSocT = now;
            if (now - savedAt > 120000) save();
        }
        /** The charge to show: one in progress (big enough to count), else the last finished one. */
        function lastCharge() {
            const s = st.session;
            if (s && s.to - s.from >= cfg.chargeMinPct) return Object.assign({}, s, { kwh: chargeKwh(s.from, s.to), open: true });
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
        const isHybrid = () => (settings.get('hybrid') === 'yes' ? true : settings.get('hybrid') === 'no' ? false : !st.noHybrid);
        // the Diagnostics page (UDS replies per value) only when switched on in Settings: it is for tuning DIDs
        const pages = () => (isHybrid() ? PAGES_HYBRID : PAGES_12V).filter((p) => DIAG_PAGES.indexOf(p) < 0 || settings.get('diagPage'));
        const diagHint = (s) => (settings.get('diagPage') ? s + ' - see Diagnostics page' : s);

        // 12 V history (one sample per 30 s)
        const v12hist = [];
        const sample12 = () => {
            const v = usingDemo() ? demo.sample().v12 : (live.v12T && Date.now() - live.v12T < 120000 ? live.v12 : null);
            v12hist.push(v); if (v12hist.length > V12_HIST) v12hist.shift();
        };
        setTimeout(sample12, 8000);
        setInterval(sample12, 30000);

        let busy = false, pollTimer = null;
        let v12Fail = 0, v12Try = 0, sohFailT = 0;
        async function poll(forceSoh) {
            if (busy) return;
            busy = true;
            try {
                if (diag.available) {
                    // 12 V: every poll; after 3 failures in a row only every 5 minutes
                    let v12 = null;
                    if (v12Fail < 3 || forceSoh || Date.now() - v12Try > 300000) {
                        v12Try = Date.now();
                        v12 = await readValue('v12');
                        if (v12 !== null) { live.v12 = v12; live.v12T = Date.now(); v12Fail = 0; } else v12Fail++;
                    }
                    // without a hybrid system only re-check the battery unit every 5 minutes
                    const noHy = st.noHybrid && settings.get('hybrid') !== 'yes';
                    if (!noHy || forceSoh || Date.now() - lastSocTry > 300000) {
                        lastSocTry = Date.now();
                        const soc = await readValue('soc');
                        if (soc !== null) { live.soc = soc; live.socT = Date.now(); onSoc(soc, live.socT); }
                        detectHybrid(v12 !== null);
                        // health changes over months: read it once every "sohDays" (kept across restarts),
                        // on "Read now", and after a failed read at most once an hour
                        const sohDue = live.soh === null || Date.now() - live.sohT > settings.get('sohDays') * 86400000;
                        if (!st.noHybrid && (forceSoh || (sohDue && Date.now() - sohFailT > 3600000))) {
                            const soh = await readValue('soh');
                            if (soh !== null) { live.soh = soh; live.sohT = Date.now(); st.soh = soh; st.sohT = live.sohT; save(); }
                            else sohFailT = Date.now();
                        }
                    }
                }
            } catch (e) { log.warn('poll: ' + e); }
            busy = false;
        }
        function schedule() {
            clearTimeout(pollTimer);
            pollTimer = setTimeout(() => poll(false).then(schedule), settings.get('poll') * 1000);
        }
        diag.on('available', (a) => { if (a) poll(false); });
        poll(false).then(schedule);

        /* ---------- derived values ---------- */
        function data() {
            if (usingDemo()) return Object.assign(demo.sample(), { demo: true, socAge: 0 });
            const maxAge = Math.max(60, settings.get('poll') * 4) * 1000, now = Date.now();
            return {
                soc: live.soc, soh: live.soh, sohAge: live.sohT ? now - live.sohT : null, ambient: live.ambient, demo: false,
                socAge: live.socT ? now - live.socT : null, stale: !(live.socT && now - live.socT < maxAge),
                v12: live.v12T && now - live.v12T < maxAge ? live.v12 : null, charge: lastCharge(),
                climate: live.climate, ac: live.ac, pace: paceNow(), seats: live.seats, wheel: live.wheel,
                engine: G.isNum(live.rpm) && live.rpm > 400 && now - live.rpmT < 5000, speed: live.speed,
                blower: live.blower, blowerTop: live.blowerTop, batt: live.batt,
            };
        }
        /** Range of a full battery at tC: { lo, hi, mid } in km (no temperature: 10 °C assumed). */
        function rangeAt(tC) {
            const k = settings.get('range20') / 50, c = RANGE_CURVE;
            const t = G.isNum(tC) ? tC : 10;
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
            const res = reserve(), span = Math.max(1, 100 - res), use = G.isNum(soc) ? Math.max(0, soc - res) : null;
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
                const onPerKm = span / r.mid, climPerKm = (model.auxRate(tC, k).rate - aux.rate) / model.evSpeed();
                f = onPerKm / Math.max(onPerKm * 0.5, onPerKm - Math.max(0, climPerKm));
            } else if (climate === 'ac') {
                // the curve holds typical climate use without the compressor: it costs on top
                const onPerKm = span / r.mid, acPerKm = (aux.rate - model.auxRate(tC, k, true).rate) / model.evSpeed();
                f = onPerKm / (onPerKm + Math.max(0, acPerKm));
            }
            const kpp = r.mid / span * f, mid = use === null ? null : use * kpp;
            return Object.assign(base, {
                mid, lo: use === null ? null : use * r.lo / span * f, hi: use === null ? null : use * r.hi / span * f,
                kpp, learned: false, full: kpp * span, auxKm: null, pace: G.isNum(pace) ? pace : model.evSpeed(),
            });
        }
        /** km a charge of +pct % adds (charge log). */
        const kmOf = (pct) => pct * estimate(null, live.ambient, live.climate, paceNow(), comfortKw()).kpp;

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
        const lv = startLive(ctx, { diag, reader, exclusive, live, page: () => pages()[page] });
        const isLive = (p) => lv.PAGES.indexOf(p) >= 0 || lv.DIAG.indexOf(p) >= 0;
        // the first bar button: "Read now", on the live pages their own action (this drive's totals, the scan)
        let actionText = 'Read now';
        const actionLabel = () => {
            const p = pages()[page], txt = (isLive(p) && lv.actionLabel(p)) || 'Read now';
            if (txt !== actionText) { actionText = txt; ui.text('BTN_READ', txt); }
        };
        const turn = (n) => { page = n; actionLabel(); return render(); };
        ui.onClick('BTN_PAGE', () => turn((page + 1) % pages().length));
        ui.onClick('BTN_PREV', () => { const n = pages().length; return turn((page + n - 1) % n); });
        ui.onClick('BTN_READ', () => {
            const p = pages()[page];
            if (isLive(p) && lv.actionLabel(p)) { lv.action(p); return render(); }
            return poll(true).then(render);
        });

        /** G20-style frame: tab bar with the page names along the top. */
        function header(cv, t, d) {
            const names = Object.assign({ main: isHybrid() ? 'Range' : '12 V battery', energy: 'Energy', log: 'Charge log', diag: 'Diagnostics', signals: 'Signals' }, lv.NAMES);
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

        /** Cars without a hybrid system: the 12 V battery only. */
        function render12V(cv, t, d) {
            const v = d.v12;
            let state = diagHint('no reading yet'), col = t.dim;
            if (G.isNum(v)) {
                if (v >= 13.2) { state = 'CHARGING  (engine / DC-DC running)'; col = GO; }
                else if (v >= 12.6) { state = 'FULL'; col = GO; }
                else if (v >= 12.4) { state = 'GOOD  (about 75 %)'; col = t.text; }
                else if (v >= 12.2) { state = 'HALF  (about 50 %) - drive or charge soon'; col = t.warn; }
                else { state = 'LOW - charge the battery'; col = t.crit; }
            }
            G.stat(cv, t, 24, 44, 1040, 468, {
                label: '12 V battery', value: v, unit: 'V', decimals: 2, size: 150, history: v12hist,
                zones: [{ from: 0, to: 12.2, color: 'crit' }, { from: 12.2, to: 12.4, color: 'warn' }],
                sub: 'last hour  ·  healthy at rest: 12.4-12.8 V',
            });
            cv.text(state, 1040, 114, 24, col, { font: 'bold', spacing: 1, align: 'right' });
            G.panel(cv, t, 1088, 44, 488, 225, 'Outside');
            cv.text(G.isNum(d.ambient) ? G.fmt(T(d.ambient), 1) : '--', 1112, 199, 96, G.isNum(d.ambient) ? t.text : t.dim, { font: 'num' });
            cv.text(tU(), 1552, 199, 32, t.dim, { align: 'right' });
            G.panel(cv, t, 1088, 287, 488, 225, 'No hybrid system');
            ['No high-voltage battery answered, so', 'eDrive shows the 12 V battery only.', 'Hybrid car? Settings > Hybrid system > Yes'].forEach((l, i) =>
                cv.text(l, 1112, 376 + i * 34, 22, i === 2 ? t.dim : t.text));
        }

        function renderMain(cv, t, d) {
            const e = estimate(d.soc, d.ambient, d.climate, d.pace, comfortKw(d)), has = G.isNum(d.soc);

            // ---- range: what is left until the engine starts
            G.panel(cv, t, 24, 44, 720, 468, 'Real electric range');
            const hold = has && d.soc <= HOLD_TOP + 0.5;       // low-battery hybrid zone
            if (hold) {
                cv.text('HYBRID', 48, 196, 96, t.warn, { font: 'bold' });
                cv.text('battery held at 5-' + HOLD_TOP + ' %', 720, 196, 26, t.dim, { align: 'right' });
            } else {
                const rw = cv.text(has ? String(Math.round(D(e.mid))) : '--', 48, 206, 130, has ? t.text : t.dim, { font: 'num' });
                cv.text(dU(), 62 + rw, 206, 40, t.dim, { font: 'bold' });
                if (has) cv.text(Math.round(D(e.lo)) + ' - ' + Math.round(D(e.hi)) + ' ' + dU(), 720, 150, 30, t.text, { font: 'bold', align: 'right' });
                cv.text('engine starts at ' + G.fmt(e.res, 0) + ' %', 720, 196, 26, t.dim, { align: 'right' });
            }
            if (!has) cv.text(diagHint('no charge reading yet'), 48, 250, 24, t.dim);
            else if (d.stale) cv.text('charge read ' + ago(d.socAge), 48, 250, 24, t.warn);
            G.bar(cv, t, 48, 268, 672, 92, {
                label: 'Full: ' + Math.round(D(e.full)) + ' ' + dU(), value: has ? D(e.mid) : null, unit: dU(), max: D(e.full), niceMax: true, ramp: 'hot',
            });
            const eu = d.engine ? model.enginePctPerKm(d.speed) : null;
            if (hold) {
                // low battery: the car drives as a hybrid and keeps the charge at 5-11 %
                cv.text('Low battery: electric only up to ' + Math.round(D(62)) + ' ' + (MI() ? 'mph' : 'km/h') + ' with light throttle',
                    48, 386, 23, t.warn, { font: 'bold' });
                cv.text('the engine takes over above  ·  lifting off and braking recharge', 48, 413, 21, t.dim);
            } else if (d.engine) {
                // engine running: what the battery does meanwhile (learned with the engine on), per 10 km / mi
                const per10 = G.isNum(eu) ? (MI() ? eu / KM_MI : eu) * 10 : null, u10 = MI() ? '10 mi' : '10 km';
                const lasts = G.isNum(eu) && eu > 0.02 && has ? '  ·  lasts ~' + Math.round(D(Math.max(0, d.soc - e.res) / eu)) + ' ' + dU() : '';
                cv.text('ENGINE ON  ·  ' + (!G.isNum(per10) ? 'learning what the battery does meanwhile'
                    : per10 < -0.05 ? 'the engine charges the battery: +' + G.fmt(-per10, 1) + ' % per ' + u10
                        : 'the battery still helps: -' + G.fmt(per10, 1) + ' % per ' + u10 + lasts), 48, 404, 24, t.warn, { font: 'bold' });
            } else {
                cv.text(e.learned ? 'at ' + (d.pace !== null && d.pace !== undefined ? 'your pace ' : 'a typical ') + Math.round(D(e.pace)) + ' ' + (MI() ? 'mph' : 'km/h')
                    + '  ·  from your last ' + Math.round(D(st.learn.km)) + ' ' + dU() + ' electric'
                    : 'estimate - learns as you drive electric', 48, 404, 24, t.dim);
            }
            // climate control + on-board electrics: costs range by the hour (off: the on-board draw only)
            const ac = e.climate !== false && e.auxKw >= 1.5 ? t.warn : t.dim;
            const what = e.climate === false ? 'CLIMATE OFF  ·  ON-BOARD  ' : e.climate ? 'CLIMATE ON' + (d.ac ? ' (A/C)' : '') + '  ' : 'CLIMATE & ON-BOARD  ';
            // the range the climate costs (above the on-board draw it would have off); unknown climate: the whole draw
            const costKm = e.climate === null || e.climate === undefined ? e.auxKm : e.climateKm;
            const seats = G.isNum(e.comfortKm) && e.comfortKm >= 0.5 && has ? '  ·  SEATS -' + Math.round(D(e.comfortKm)) + ' ' + dU() : '';
            cv.text(what + G.fmt(e.auxKw, 1) + ' kW' + (e.auxLearned ? '' : ' (typical)')
                + (G.isNum(costKm) && costKm >= 0.5 && has ? '  ·  -' + Math.round(D(costKm)) + ' ' + dU() : '') + seats, 48, 444, 22, ac, { font: 'bold', spacing: 1 });
            const amb = G.isNum(d.ambient) ? G.fmt(T(d.ambient), 1) + ' ' + tU() : '--';
            cv.text('OUTSIDE  ' + amb, 48, 486, 24, t.dim, { font: 'bold', spacing: 1 });
            // 12 V battery: resting ~12.4-12.8 V, 13.5-14.8 V while the DC/DC or alternator charges it
            const v = d.v12, vcol = !G.isNum(v) ? t.dim : v < 11.8 ? t.crit : v < 12.2 || v > 15.2 ? t.warn : t.text;
            const vw = cv.text(G.isNum(v) ? v.toFixed(2) + ' V' : '--', 720, 489, 32, vcol, { font: 'bold', align: 'right' });
            cv.text('12 V', 708 - vw, 486, 24, t.dim, { font: 'bold', spacing: 1, align: 'right' });

            // ---- charge + last charge
            G.panel(cv, t, 768, 44, 380, 468, 'Charge');
            battery(cv, t, 796, 101, 300, 106, d.soc);
            const ss = G.isNum(d.soc) ? G.fmt(d.soc, 0) : '--';
            const sw = cv.text(ss, 940, 320, 100, G.isNum(d.soc) ? t.text : t.dim, { font: 'num', align: 'center' });
            cv.text('%', 950 + sw / 2, 320, 36, t.dim, { font: 'bold' });
            cv.fillRect(792, 357, 332, 1, t.tick);
            const c = d.charge;
            cv.text(c && c.open ? 'CHARGING' : 'LAST CHARGE', 792, 393, 22, c && c.open ? GO : t.dim, { font: 'bold', spacing: 1.5 });
            if (c) {
                const add = c.to - c.from;
                const aw = cv.text('+' + add.toFixed(0) + ' %', 792, 446, 44, GO, { font: 'bold' });
                cv.text('+' + Math.round(D(kmOf(add))) + ' ' + dU(), 806 + aw, 444, 28, t.text, { font: 'bold' });
                cv.text(Math.round(c.from) + ' > ' + Math.round(c.to) + ' %  ·  ' + (c.open ? 'now' : ago(Date.now() - c.toT)), 792, 489, 24, t.dim);
            } else {
                cv.text('none yet', 792, 446, 28, t.dim);
            }

            // ---- battery: health (capacity vs. new) + energy in it now
            const soh = d.soh, kwh = settings.get('designKwh');
            const cap = G.isNum(soh) ? kwh * soh / 100 : null;                     // what a full charge holds today
            const now = G.isNum(cap) && G.isNum(d.soc) ? cap * d.soc / 100 : null;  // energy in the pack right now
            const bx = 1172, bw = 404;
            G.panel(cv, t, bx, 44, bw, 468, 'Battery health');
            const hc = !G.isNum(soh) ? t.dim : soh < 70 ? t.crit : soh < 80 ? t.warn : t.text;
            const hw = cv.text(G.isNum(soh) ? G.fmt(soh, 1) : '--', bx + 24, 180, 100, hc, { font: 'num' });
            cv.text('%', bx + 32 + hw, 180, 34, t.dim, { font: 'bold' });
            if (!G.isNum(soh)) cv.text(diagHint('not read yet'), bx + 24, 214, 22, t.dim);
            G.bar(cv, t, bx + 24, 222, bw - 48, 92, {
                label: 'Holds', value: cap, unit: 'kWh', decimals: 1, max: kwh, step: kwh / 4, scaleDecimals: kwh % 4 ? 1 : 0, ramp: 'hot',
                zones: [{ from: 0, to: kwh * 0.7, color: 'crit' }, { from: kwh * 0.7, to: kwh * 0.8, color: 'warn' }],
            });
            cv.fillRect(bx + 24, 348, bw - 48, 1, t.panelEdge);
            cv.text('IN THE BATTERY NOW', bx + 24, 386, 22, t.dim, { font: 'bold', spacing: 1.5 });
            const ew = cv.text(G.isNum(now) ? G.fmt(now, 1) : '--', bx + 24, 462, 72, G.isNum(now) ? t.text : t.dim, { font: 'num' });
            cv.text('kWh', bx + 34 + ew, 462, 28, t.dim);
            // HV battery temperature (the car's own value): cold packs give less range and charge slower
            const bt = d.batt && d.batt.avg;
            cv.text('TEMP', bx + bw - 24, 386, 22, t.dim, { font: 'bold', spacing: 1.5, align: 'right' });
            const btc = !G.isNum(bt) ? t.dim : bt < 5 || bt > 45 ? t.warn : t.text;
            cv.text(G.isNum(bt) ? Math.round(T(bt)) + (F() ? '°F' : '°C') : '--', bx + bw - 24, 462, 44, btc, { font: 'bold', align: 'right' });
        }

        const pad = (n) => (n < 10 ? '0' : '') + n;
        const dateOf = (ms) => { const x = new Date(ms); return pad(x.getDate()) + '.' + pad(x.getMonth() + 1) + '  ' + pad(x.getHours()) + ':' + pad(x.getMinutes()); };
        const price = () => settings.get('price') || 0;
        const money = (kwh) => (G.isNum(kwh) && price() > 0 ? (kwh * LOSS * price()).toFixed(2) + ' €' : null);

        function renderLog(cv, t, d) {
            const all = d.demo ? demo.log() : (st.log || []);
            const kwhOf = (c) => (G.isNum(c.kwh) ? c.kwh : 0);

            // ---- list, newest first
            G.panel(cv, t, 24, 44, 1040, 468, 'Charges' + (all.length ? '  (' + all.length + ')' : ''));
            const cols = [48, 230, 380, 590, 760, 920];
            ['DATE', 'ADDED', 'FROM - TO', 'ENERGY', 'RANGE', price() > 0 ? 'COST' : ''].forEach((h, i) => cv.text(h, cols[i], 121, 22, t.dim, { font: 'bold', spacing: 1 }));
            cv.fillRect(48, 133, 992, 1, t.panelEdge);
            if (!all.length) {
                cv.text('No charges logged yet.', 544, 284, 32, t.dim, { align: 'center', font: 'bold' });
                cv.text('Every charge of ' + cfg.chargeMinPct + ' % or more shows up here,', 544, 330, 26, t.dim, { align: 'center' });
                cv.text('also overnight charges.', 544, 366, 26, t.dim, { align: 'center' });
            }
            all.slice(-8).reverse().forEach((c, i) => {
                const y = 174 + i * 43;
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
                cv.text(list.length + (list.length === 1 ? ' charge' : ' charges') + '  ·  +' + Math.round(D(kmOf(list.reduce((a, c) => a + (c.to - c.from), 0)))) + ' ' + dU(), 1552, y, 22, t.dim, { align: 'right' });
            };
            block(116, 'THIS MONTH', month);
            block(208, 'ALL TIME', all);
            // kWh per day, last 14 days
            const day = 86400000, today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
            const days = [];
            for (let i = 13; i >= 0; i--) days.push(sum(all.filter((c) => c.toT >= today0 - i * day && c.toT < today0 - (i - 1) * day)));
            const top = Math.max(4, Math.max.apply(null, days));
            const gx = 1112, gy = 470, gh = 132, bw = 440 / 14;
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
            cv.text('UDS 22 ReadDataByIdentifier / OBD 01  ·  ' + link + '  ·  ambient ' + (G.isNum(live.ambient) ? G.fmt(live.ambient, 1) + ' °C' : 'n/a')
                + '  ·  speed ' + (G.isNum(live.speed) ? G.fmt(G.hold('speed', live.speed), 0) + ' km/h' : 'n/a')
                + '  ·  climate ' + (live.climate === null ? 'n/a' : live.climate ? 'on' : 'off') + (live.ac ? ' (A/C)' : ''), 48, 121, 24, t.text, { font: 'label' });
            const cols = [48, 160, 260, 380, 820, 1000, 1290];
            ['VALUE', 'ECU', 'DID', 'REPLY', 'DECODED', 'STATUS', 'READ'].forEach((h, i) => cv.text(h, cols[i], 167, 22, t.dim, { font: 'bold', spacing: 1 }));
            cv.fillRect(48, 178, 1504, 1, t.tick);
            // every candidate gets a row: the rows shrink to fit between the header and the note at the bottom
            const n = VALUES.reduce((a, key) => a + (cfg[key] || []).length, 0);
            const rowH = Math.min(38, Math.floor(232 / Math.max(1, n))), fs = rowH >= 34 ? 24 : Math.max(15, rowH - 3), fsS = Math.max(14, fs - 2);
            let y = 178 + Math.max(24, rowH);
            VALUES.forEach((key) => (cfg[key] || []).forEach((c, i) => {
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
            const seatTxt = Object.keys(live.seats).map((k) => k + ' ' + (live.seats[k] === null ? '?' : live.seats[k])).join(' ') || 'n/a';
            const bt = live.batt;
            cv.text('climate ' + (live.climate === null ? 'n/a' : live.climate === 'ac' ? 'on (A/C)' : live.climate ? 'on' : 'off')
                + '  ·  blower ' + (G.isNum(live.blower) ? live.blower + ' / ' + live.blowerTop : 'n/a') + '  ·  seats ' + seatTxt
                + '  ·  wheel ' + (live.wheel === null ? 'n/a' : live.wheel ? 'on' : 'off') + '  ·  pace ' + (G.isNum(paceNow()) ? Math.round(paceNow()) + ' km/h' : 'n/a')
                + '  ·  battery ' + (bt && G.isNum(bt.avg) ? bt.avg + ' °C (' + bt.min + '..' + bt.max + ')' : 'n/a')
                + '  ·  HV ' + (G.isNum(live.hvV) ? live.hvV : 'n/a'), 48, 112, 21, t.text, { font: 'label' });
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
            const kwh100 = (pctPerKm) => (G.isNum(pctPerKm) ? pctPerKm * k * 100 : null);
            const per = MI() ? 'kWh/100 mi' : 'kWh/100 km', U = (x) => (G.isNum(x) ? (MI() ? x / KM_MI : x) : null);

            // ---- driving per speed band
            G.panel(cv, t, 24, 44, 740, 468, 'Driving by speed');
            const bands = d.demo ? [1.35, 1.5, 1.75, 2.05, 2.5].map((p, i) => ({ from: [0, 35, 60, 85, 110][i], to: [35, 60, 85, 110, null][i], km: 25, pctPerKm: p,
                engineKm: 20, enginePctPerKm: [-0.6, -0.4, -0.1, 0.15, 0.3][i] }))
                : model.bands();
            const paceBand = G.isNum(e.pace) ? bands.findIndex((b) => e.pace >= b.from && (b.to === null || e.pace < b.to)) : -1;
            const top = Math.max(1, Math.max.apply(null, bands.map((b) => kwh100(b.pctPerKm) || 0)));
            ['SPEED', 'ELECTRIC ' + per.toUpperCase(), 'ENGINE ON', 'LEARNED'].forEach((h, i) => cv.text(h, [48, 230, 640, 740][i], 116, 18, t.dim,
                { font: 'bold', spacing: 1, align: i >= 2 ? 'right' : 'left' }));
            bands.forEach((b, i) => {
                const y = 160 + i * 52, v = kwh100(b.pctPerKm), now = i === paceBand;
                const sp = (x) => Math.round(MI() ? x * KM_MI : x);
                cv.text((b.to === null ? 'over ' + sp(b.from) : sp(b.from) + '-' + sp(b.to)) + ' ' + (MI() ? 'mph' : 'km/h'), 48, y, 24, now ? GO : t.text, { font: 'bold' });
                cv.roundRect(230, y - 22, 230, 26, 6, withAlpha(t.track, 0.6));
                if (G.isNum(v)) cv.rampRect(230, y - 22, Math.max(8, 230 * v / top), 26, 6, t.ramp || [t.accent]);
                cv.text(G.isNum(v) ? G.fmt(U(v), 1) : '-', 474, y, 24, G.isNum(v) ? t.text : t.dim, { font: 'bold' });
                // with the engine on: what happens to the battery (kWh per 100 km / mi)
                const ev = kwh100(b.enginePctPerKm);
                cv.text(G.isNum(ev) ? (ev < 0 ? 'charges ' : 'uses ') + G.fmt(Math.abs(U(ev)), 1) : '-', 640, y, 22, !G.isNum(ev) ? t.dim : ev < 0 ? GO : t.text, { font: 'bold', align: 'right' });
                const lk = Math.max(b.km, b.engineKm || 0);
                cv.text(lk >= 0.5 ? Math.round(D(lk)) + ' ' + dU() : 'not yet', 740, y, 20, t.dim, { align: 'right' });
            });
            cv.text(G.isNum(e.pace) ? (d.pace !== null && d.pace !== undefined ? 'your pace now ' : 'typical pace ') + Math.round(D(e.pace)) + ' ' + (MI() ? 'mph' : 'km/h')
                + (G.isNum(e.perKm) ? '  ·  ' + G.fmt(U(kwh100(e.perKm)), 1) + ' ' + per + ' there' : '') : 'learns as you drive electric', 48, 444, 22, t.dim);
            cv.text('ENGINE ON: charges = the engine fills the battery, uses = the battery still helps', 48, 486, 18, t.dim);

            // ---- where the power goes now
            const x0 = 788, w0 = 788;
            G.panel(cv, t, x0, 44, w0, 468, 'Where the power goes now');
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
            const driveKw = !G.isNum(e.pace) ? null : G.isNum(e.perKm) ? e.perKm * k * e.pace
                : G.isNum(e.kpp) && e.kpp > 0 ? Math.max(0, (1 / e.kpp) * k * e.pace - e.auxKw - (comfort || 0)) : null;
            const seatTxt = Object.keys(d.seats || {}).filter((s2) => d.seats[s2]).map((s2) => ({ DR: 'driver', PS: 'pass.', DRR: 'rear L', PSR: 'rear R' }[s2] + ' ' + d.seats[s2])).join(', ');
            const rows = [
                ['Driving', driveKw, null,
                    G.isNum(e.pace) ? 'at ' + Math.round(D(e.pace)) + ' ' + (MI() ? 'mph' : 'km/h') + (e.learned ? '' : ' (typical)') : 'learns as you drive'],
                ['Climate (heating / A/C)', climKw, has && d.climate !== false ? e.climateKm : null,
                    lc ? (lc.how === 'measured' ? 'from the battery' : lc.how === 'climate unit' ? 'climate unit' : 'measured before')
                        + (blow > 0 ? ', blower ~' + G.fmt(blow, 2) + ' kW' : '')
                        : d.climate === false ? 'off' : (e.auxLearned ? 'learned' : 'typical') + (blow > 0 ? ', blower ~' + G.fmt(blow, 2) + ' kW' : '')],
                ['Seat heating', seatKw, has ? share(seatKw) : null, seatTxt ? seatTxt + ' (est.)' : 'off'],
                ['Steering wheel', wheelKw, has ? share(wheelKw) : null, d.wheel === null || d.wheel === undefined ? 'n/a' : d.wheel ? 'on (est.)' : 'off'],
                ['On-board electrics', base, null, 'screens, units, pumps'],
            ];
            ['', 'KW', 'RANGE', ''].forEach((h, i) => cv.text(h, [x0 + 24, x0 + 400, x0 + 500, 0][i], 116, 20, t.dim, { font: 'bold', spacing: 1, align: 'right' }));
            rows.forEach(([name, kw, km, note], i) => {
                const y = 160 + i * 52;
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
            if (sent.length) cv.text('CAR SHOWS  ' + sent.map(([n, v]) => n + ' ' + v).join('  ·  '), x0 + 24, 444, 19, t.dim, { font: 'bold', spacing: 0.5 });
            const bt = d.batt;
            cv.text('HV BATTERY  ' + (bt && G.isNum(bt.avg) ? Math.round(T(bt.avg)) + ' ' + tU() + (G.isNum(bt.min) && G.isNum(bt.max) ? '  (cells ' + Math.round(T(bt.min)) + ' - ' + Math.round(T(bt.max)) + ' ' + tU() + ')' : '') : '--')
                + (bt && G.isNum(bt.avg) && bt.avg < 5 ? '  ·  cold: less range, slower charging' : ''), x0 + 24, 486, 22, bt && G.isNum(bt.avg) && bt.avg < 5 ? t.warn : t.text, { font: 'bold', spacing: 1 });
        }

        function render() {
            const t = ctx.theme();
            let d = data();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const pg = pages();
            if (page >= pg.length) { page = 0; actionLabel(); }
            if (isLive(pg[page])) d = lv.draw(pg[page], cv, t);
            else if (pg[page] === 'diag') renderDiag(cv, t, d);
            else if (pg[page] === 'signals') renderSignals(cv, t, d);
            else if (pg[page] === 'energy') renderEnergy(cv, t, d);
            else if (pg[page] === 'log') renderLog(cv, t, d);
            else if (isHybrid()) renderMain(cv, t, d);
            else render12V(cv, t, d);
            header(cv, t, d);
            return ui.image('MAIN_GFX', cv);
        }

        // every screen refresh (60 fps) with the GPU renderer; 2 fps in software (PNG frames)
        ctx.loop('MAIN', 2, render);
        settings.onChange((k) => {
            if (k === 'poll') schedule();
            if (k === 'diagPage' || k === 'hybrid') actionLabel();
        });
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
