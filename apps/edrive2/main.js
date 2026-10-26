'use strict';
/**
 * eDrive Live - what the high-voltage battery is doing right now. A companion to eDrive
 * (range, health, charge log); this one is about live values. Set up for the X5 xDrive45e
 * (G05 PHEV, 24 kWh gross), and adjustable for other BMW plug-in hybrids in app.json.
 *
 *   Power    power in / out of the pack now (kW = pack voltage x current, read every
 *            "powerPoll" s), against the battery's own discharge / charge limits; the last
 *            two minutes; this drive's energy out, regen, charged and peaks
 *   Battery  cell core temperatures (min / mean / max) and coolant, cell voltages (min / max
 *            and the spread between them), the power the battery allows now
 *   Climate  what climate and comfort draw: the A/C compressor (the car's value), blower,
 *            seat and steering-wheel heating (estimated from their levels); and the measured
 *            draw while standing with the engine off, when nothing but the car's own
 *            consumers takes power from the pack: that minus the on-board baseline (learned
 *            with the climate off) is what the climate really uses
 *
 * The battery values come from the battery unit (SME) with UDS ReadDataByIdentifier over the
 * head unit's diagnostic link (kit/diag.js); identifiers and scalings are in app.json
 * "config.battery" (fast: read every powerPoll s, slow: every slowPoll s while the screen is
 * shown). Speed, engine, climate and comfort states come over SOME/IP.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { Diag, hex } = require('./kit/diag');
const { DidReader } = require('./kit/dids');

const W = 1600, H = 520;
const GO = '#2fd27a';
const IDLE_KW = 0.3;              // below this either way the pack is idle
const SHOWN_MS = 3000;            // the screen counts as shown when drawn this recently
const BG_POWER_S = 2;             // power read in the background (drive totals) at most this often
const TRACE_S = 120;              // power trace on the Power page
const CLIMATE_TRACE_S = 600;      // climate trace on the Climate page
const TEMP_TRACE_S = 1800;        // cell temperature trace on the Battery page
const SEAT_KW = [0, 0.04, 0.07, 0.1];   // seat heating per level 0..3 (estimate)
const WHEEL_KW = 0.06;                  // steering-wheel heating (estimate)
const BLOWER_KW = [0.03, 0.32];         // blower: about [0] + [1] x (level / top)^2 (estimate)
const BASELINE_KW = 0.35;               // on-board electrics while parked, until learned
const STAND_MS = 10000;                 // standing this long before the draw counts as "standing"

/** Demo: 96 cells a few mV apart, two of them a little weak. */
function demoCells(s) {
    const cells = [];
    for (let i = 0; i < 96; i++) cells.push(3.722 + 0.004 * Math.sin(i * 1.7) + 0.003 * Math.cos(i * 0.31 + s / 60) - (i === 37 ? 0.016 : i === 70 ? 0.009 : 0));
    const min = Math.min(...cells), max = Math.max(...cells);
    return { cells, min, max, avg: cells.reduce((a, v) => a + v, 0) / 96, minAt: cells.indexOf(min) + 1, maxAt: cells.indexOf(max) + 1 };
}

/** Demo: a drive with a stop every 40 s; climate on with the A/C. */
class Demo {
    constructor() { this.t0 = Date.now() - 600000; }      // ten minutes in: the traces have a history
    sample() {
        const s = (Date.now() - this.t0) / 1000, ph = ((s % 40) + 40) % 40;
        const standing = ph >= 30;
        const kw = standing ? 1.55 + 0.1 * Math.sin(s)
            : ph < 5 ? 42 + 14 * Math.sin(s * 2) : ph < 20 ? 13 + 4 * Math.sin(s * 0.8) : -11 - 7 * Math.sin(s * 1.3);
        const v = 352 - kw * 0.12;
        return {
            kw, v, a: -kw * 1000 / v, speed: standing ? 0 : 55 + 20 * Math.sin(s / 9), engine: false,
            soc: 64 - (s / 60) % 30, cellV: demoCells(s), cellT: { min: 21.4 + 2.5 * Math.sin(s / 500), max: 23.9 + 2.8 * Math.sin(s / 500), avg: 22.5 + 2.6 * Math.sin(s / 500) },
            coolant: 20.8 + 2 * Math.sin(s / 520),
            limits: { chargeA: 165, dischargeA: 330 }, ambient: 29, climate: 'ac', blower: 4, blowerTop: 8,
            acKw: 1.15 + 0.2 * Math.sin(s / 7), seats: { DR: 1 }, wheel: false,
            unit: { ac: 0.55 + 0.05 * Math.sin(s / 7), heater: 0 },
        };
    }
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const cfg = Object.assign({ ecu: 7, powerSign: -1, fast: {}, slow: {} }, (ctx.spec.config && ctx.spec.config.battery) || {});
        const S = (ctx.spec.config && ctx.spec.config.scaling) || {};
        const sc = (k, raw) => {
            const c = S[k];
            if (!c || raw === undefined || raw === null || raw === c.invalid || typeof raw !== 'number') return null;
            const v = raw * c.factor + (c.offset || 0);
            return c.max != null && v > c.max ? null : v;
        };

        /* ---------- persisted: the learned on-board baseline ---------- */
        const STATE = path.join(ctx.dataDir, 'edrive2.json');
        let st = {};
        try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')) || {}; } catch (e) { /* first run */ }
        let savedAt = 0;
        const save = () => { savedAt = Date.now(); try { fs.writeFileSync(STATE, JSON.stringify(st)); } catch (e) { log.warn('save: ' + e); } };

        /* ---------- live values ---------- */
        const live = {
            v: null, vT: 0, a: null, kw: null, kwT: 0,
            soc: null, cellV: null, cellT: null, coolant: null, limits: null, slowT: {},
            speed: null, rpm: null, rpmT: 0, ambient: null, standSince: 0,
            climate: null, ac: null, blower: null, blowerTop: 8, acRaw: null, acKw: null, seats: {}, wheel: null,
            carT: null, lscV: null, lscVT: 0, pd: null, raw: {},
        };
        const rawSeen = (what, v) => { live.raw[what] = JSON.stringify(v); };
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

        /* ---------- car signals (SOME/IP) ---------- */
        const watch = (iface, handlers, what, opts) => ctx.signals.watch(iface, '1', handlers, log, opts)
            .then((s) => log.info(what + ' ' + (s.error ? 'error: ' + s.error : 'subscribed')));
        watch('de.bmw.infrastructure.EnvironmentalInformation', {
            ExteriorTemperature: (v) => { const a = sc('ambient', v.temperatureExterior); if (a !== null) live.ambient = a; },
        }, 'ambient');
        watch('de.bmw.infotainment.vehicle.Vehicle2', {
            statusCarSpeed2: (v) => {
                const k = v.speedVehicleCentreOfGravity;
                live.speed = k === 65535 || k == null ? null : k * 0.015625;
                if (G.isNum(live.speed) && live.speed > 1) live.standSince = 0;
                else if (G.isNum(live.speed) && !live.standSince) live.standSince = Date.now();
            },
        }, 'speed');
        watch('de.bmw.infotainment.vehicle.CDS', {
            statusEngineSpeed2: (v) => { const r = sc('rpm', v.actualValueRPMEngineCrankshaft); if (r !== null && r >= 0 && r < 12000) { live.rpm = r; live.rpmT = Date.now(); } },
        }, 'rpm');
        // climate on / A/C per zone (on when any zone is on)
        const zones = { climate: {}, ac: {} };
        const onZone = (what, on, zone) => {
            if (typeof on !== 'boolean') return;
            const z = zones[what];
            if (zone === 'ALL_ZONES') zone = 0;
            if (!zone) Object.keys(z).forEach((k) => delete z[k]);
            z[zone || 0] = on;
        };
        const climateNow = () => {
            const sys = Object.keys(zones.climate).length ? Object.keys(zones.climate).some((k) => zones.climate[k]) : null;
            const ac = Object.keys(zones.ac).length ? Object.keys(zones.ac).some((k) => zones.ac[k]) : null;
            live.ac = ac;
            live.climate = ac ? 'ac' : sys;
        };
        const ON = { 1: true, KLIMAANLAGE_EIN: true, 0: false, KLIMAANLAGE_AUS: false };
        watch('de.bmw.infotainment.climate.climatemaster.ClimateMaster', {
            statusClimateSystemOn: (v) => { rawSeen('climate', v); entries(v, 'airConditioningOn').forEach((e) => onZone('climate', e.airConditioningOn, e.operationZone)); climateNow(); },
            statusAirCondAC: (v) => { rawSeen('ac', v); entries(v, 'acButton').forEach((e) => onZone('ac', e.acButton, e.operationZone)); climateNow(); },
        }, 'climate', { pollMs: 10000 });
        watch('de.bmw.infotainment.climate.Climate2', {
            statusACFront: (v) => { rawSeen('A/C', v); const on = ON[one(v, 'statusAircon')]; if (typeof on === 'boolean') { zones.ac = { 0: on }; climateNow(); } },
            statusAirConditionDRStatus: (v) => {
                rawSeen('blower', v);
                const b = one(v, 'statusBlowerSettingDR');
                if (typeof b === 'number' && b < 255) { live.blower = b; live.blowerTop = Math.max(live.blowerTop, b); zones.climate = { 0: b > 0 }; climateNow(); }
            },
            statusActualValuePowerACCompressor: (v) => {
                rawSeen('compressor', v);
                const r = one(v, 'actualValuePowerACCompressor');
                live.acRaw = r; live.acKw = sc('acPower', r);
            },
        }, 'climate2', { pollMs: 5000 });
        const level = (v) => (typeof v === 'number' && v >= 0 && v < 15 ? Math.min(3, v) : null);
        const onSeat = (pos, key) => (v) => { rawSeen('seat ' + pos, v); live.seats[pos] = level(one(v, key)); };
        watch('de.bmw.infotainment.climate.Climate', {
            statusSeatHeatingDR: onSeat('DR', 'statusSeatHeaterDR'),
            statusSeatHeatingPS: onSeat('PS', 'statusSeatHeaterPS'),
            statusSeatHeatingDRR: onSeat('DRR', 'statusSeatHeaterDRR'),
            statusSeatHeatingPSR: onSeat('PSR', 'statusSeatHeaterPSR'),
        }, 'seat heating', { pollMs: 15000 });
        watch('de.bmw.body.steeringwheelcomfort.SteeringWheelClimate', {
            heatingState: (v) => { rawSeen('wheel', v); const h = one(v, 'heating'); if (typeof h === 'boolean') live.wheel = h; },
        }, 'steering wheel', { pollMs: 15000 });
        watch('de.bmw.infotainment.KombiIF', {
            statusDisplayElectricalPowerDistribution: (v) => { rawSeen('distribution', v); live.pd = entries(v, 'displayRepartitionDriveElectricPower')[0] || null; },
        }, 'power distribution', { pollMs: 15000 });
        const battTemp = (raw) => { const v = sc('batteryTemp', raw); return v !== null && v > -30 && v < 70 ? v : null; };
        watch('de.bmw.infotainment.drivingexcitement.Efficiencytainment2', {
            statusBatteryTemperature: (v) => {
                rawSeen('battery temp', v);
                const e = entries(v, 'actualValueTemperatureHighVoltageStorage')[0];
                if (e) live.carT = { avg: battTemp(e.actualValueTemperatureHighVoltageStorage), min: battTemp(e.actualValueTemperatureHighVoltageStorageMinimum), max: battTemp(e.actualValueTemperatureHighVoltageStorageMaximum) };
            },
        }, 'battery temperature', { pollMs: 30000 });
        watch('de.bmw.infotainment.lsc.LSCDataSink', {
            statusHighVoltageStorage: (v) => { rawSeen('HV storage', v); let x = one(v, 'actualValueVoltageHighVoltageStorage'); if (G.isNum(x) && x > 1500) x /= 10;       // 0.1 V on the X5 45e
                if (G.isNum(x) && x > 150 && x < 500) { live.lscV = x; live.lscVT = Date.now(); } },
        }, 'HV storage');

        /* ---------- UDS: candidates with several fields on one reply ---------- */
        const diag = new Diag(ctx.signals, log);
        diag.quiet = true;
        diag.init();
        const reader = new DidReader(diag, { ecu: cfg.ecu });
        const pick = {};
        const fieldsOf = (c) => (c.array ? ['min', 'max', 'avg'] : Object.keys(c.fields || {}));
        const primary = (c) => Object.assign({ ecu: c.ecu, did: c.did }, c.array || c.fields[fieldsOf(c)[0]]);
        /** One candidate: { field: value } (a field outside its min..max is null), or null when it doesn't answer. */
        async function readFields(c) {
            const p = primary(c), v0 = await reader.read(p);
            if (v0 === null) return null;
            const r = reader.raws[reader.key(p)], bytes = r.bytes.split(' ').map((x) => parseInt(x, 16));
            const out = {};
            if (c.array) {
                // every value in the reply (one per cell): the ones outside min..max count as missing
                const f = c.array, n = f.bytes || 1, cells = [];
                for (let at = 3; at + n <= bytes.length; at += n) {
                    let raw = 0;
                    for (let j = 0; j < n; j++) raw = raw * 256 + bytes[at + j];
                    const v = raw * (f.factor == null ? 1 : f.factor) + (f.offset || 0);
                    cells.push((f.min != null && v < f.min) || (f.max != null && v > f.max) ? null : v);
                }
                const ok = cells.filter(G.isNum);
                if (ok.length < cells.length / 2) return null;
                out.cells = cells;
                out.min = Math.min(...ok); out.max = Math.max(...ok); out.avg = ok.reduce((a, v) => a + v, 0) / ok.length;
                out.minAt = cells.indexOf(out.min) + 1; out.maxAt = cells.indexOf(out.max) + 1;
                r.fields = { cells: ok.length, min: out.min, max: out.max };
                return out;
            }
            fieldsOf(c).forEach((k, i) => {
                if (i === 0) { out[k] = v0; return; }
                const f = c.fields[k], at = 3 + (f.at || 0), n = f.bytes || 1;
                if (bytes.length < at + n) { out[k] = null; return; }
                let raw = 0;
                for (let j = 0; j < n; j++) raw = raw * 256 + bytes[at + j];
                if (f.signed && raw >= Math.pow(2, 8 * n - 1)) raw -= Math.pow(2, 8 * n);
                const v = raw * (f.factor == null ? 1 : f.factor) + (f.offset || 0);
                out[k] = (f.min != null && v < f.min) || (f.max != null && v > f.max) ? null : v;
            });
            r.fields = out;
            return out;
        }
        /** A value's candidates, starting with the one that answered last. */
        async function readGroup(name, list) {
            list = list || [];
            const start = pick[name] || 0;
            for (let k = 0; k < list.length; k++) {
                const i = (start + k) % list.length, v = await readFields(list[i]);
                if (v) { pick[name] = i; return v; }
            }
            return null;
        }

        // one request at a time on the diagnostic link: the fast and the slow reads take turns
        let chain = Promise.resolve();
        const exclusive = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };
        let lastDrawT = 0;
        const shown = () => Date.now() - lastDrawT < SHOWN_MS;
        const engineOn = () => G.isNum(live.rpm) && live.rpm > 400 && Date.now() - live.rpmT < 5000;

        /* ---------- power: fast reads, drive totals, traces ---------- */
        const trip = { out: 0, regen: 0, charged: 0, climate: 0, peakOut: 0, peakIn: 0, since: Date.now() };
        const trace = [], climTrace = [], tempTrace = [];
        const push = (arr, keep, v) => { const now = Date.now(); arr.push([now, v]); while (arr.length && now - arr[0][0] > keep * 1000) arr.shift(); };
        let iFail = 0, iTry = 0, vTick = 0;
        function onPower(kw, now) {
            if (live.kwT && G.isNum(live.kw)) {
                const h = Math.min(now - live.kwT, 3 * Math.max(BG_POWER_S, settings.get('powerPoll')) * 1000) / 3600000;
                const moving = G.isNum(live.speed) && live.speed > 1;
                if (kw > 0) {
                    trip.out += kw * h;
                    // the part of it the climate took (compressor, heater, blower, seats, pumps): never more than the battery gave
                    const cl = climatePower(data(), now).kw;
                    if (G.isNum(cl) && cl > 0) trip.climate += Math.min(cl, kw) * h;
                }
                else if (moving) trip.regen -= kw * h;
                else trip.charged -= kw * h;
            }
            trip.peakOut = Math.max(trip.peakOut, kw);
            if (G.isNum(live.speed) && live.speed > 1) trip.peakIn = Math.max(trip.peakIn, -kw);
            live.kw = kw; live.kwT = now;
            push(trace, TRACE_S, kw);
            learnBaseline(kw, now);
        }
        async function readPower() {
            if (!diag.available || (iFail >= 3 && Date.now() - iTry < 30000)) return;
            await exclusive(async () => {
                try {
                    if (vTick++ % 5 === 0 || !G.isNum(live.v)) {
                        const r = await readGroup('hvV', cfg.fast.hvV);
                        if (r) { live.v = r[fieldsOf(cfg.fast.hvV[pick.hvV])[0]]; live.vT = Date.now(); }
                    }
                    iTry = Date.now();
                    const r = await readGroup('hvI', cfg.fast.hvI);
                    if (!r) { iFail++; return; }
                    iFail = 0;
                    const a = r[fieldsOf(cfg.fast.hvI[pick.hvI])[0]], now = Date.now();
                    live.a = a;
                    const volts = live.vT && now - live.vT < 60000 ? live.v : live.lscVT && now - live.lscVT < 60000 ? live.lscV : null;
                    if (G.isNum(volts) && G.isNum(a)) onPower(volts * a / 1000 * (cfg.powerSign < 0 ? -1 : 1), now);
                } catch (e) { log.warn('power: ' + e); }
            });
        }
        let powerTimer = null;
        function schedulePower() {
            clearTimeout(powerTimer);
            const s = shown() ? settings.get('powerPoll') : Math.max(BG_POWER_S, settings.get('powerPoll'));
            powerTimer = setTimeout(() => readPower().then(schedulePower, schedulePower), Math.max(250, s * 1000));
        }
        schedulePower();

        /* ---------- slow reads (only while the screen is shown) ---------- */
        const SLOW = ['soc', 'cellV', 'cellT', 'coolant', 'limits'];
        async function readSlow() {
            if (!diag.available || !shown()) return;
            for (const name of SLOW) {
                if (!(cfg.slow[name] || []).length) continue;
                await exclusive(async () => {
                    try {
                        const r = await readGroup(name, cfg.slow[name]);
                        if (!r) return;
                        const f = fieldsOf(cfg.slow[name][pick[name]]);
                        live[name] = f.length === 1 ? r[f[0]] : r;
                        live.slowT[name] = Date.now();
                    } catch (e) { log.warn(name + ': ' + e); }
                });
            }
            await readProbes();
        }

        /* ---------- climate unit values being identified (config.probes) ----------
         * Raw numbers from the IHKA that follow the A/C compressor (D8D2) and the heater (D8D3). Their unit isn't
         * known yet, so they are shown raw on the Climate page, and every reading taken while the climate draw is
         * measured (standing, engine off, not plugged in) is kept with it in probes.json: enough of those pairs
         * give the scale, after which "factor" in app.json turns them into kW. */
        const PROBES = (ctx.spec.config && ctx.spec.config.probes) || [];
        const probe = {};                                   // name -> { raw, t }
        const PROBE_FILE = path.join(ctx.dataDir, 'probes.json');
        let samples = [];
        try { samples = JSON.parse(fs.readFileSync(PROBE_FILE, 'utf8')) || []; } catch (e) { /* none yet */ }
        async function readProbes() {
            if (!PROBES.length) return;
            for (const pr of PROBES) {
                await exclusive(async () => {
                    try {
                        const v = await reader.read({ ecu: pr.ecu, did: pr.did, at: pr.at || 0, bytes: pr.bytes || 1 });
                        if (v !== null) probe[pr.name] = { raw: v, t: Date.now() };
                    } catch (e) { /* not this time */ }
                });
            }
            const d = data(), cp = climatePower(d, Date.now());
            if (!d.demo && cp.how === 'measured' && PROBES.some((pr) => probe[pr.name] && Date.now() - probe[pr.name].t < 15000)) {
                const c = comfortKw(d);
                const row = { t: Date.now(), kw: +cp.kw.toFixed(3), blower: +blowerKw(d).toFixed(3), comfort: +(c.seats + c.wheel).toFixed(3), climate: d.climate, amb: d.ambient };
                PROBES.forEach((pr) => { row[pr.name] = probe[pr.name] ? probe[pr.name].raw : null; });
                samples.push(row);
                if (samples.length > 600) samples = samples.slice(-600);
                if (samples.length % 6 === 0) { try { fs.writeFileSync(PROBE_FILE, JSON.stringify(samples)); } catch (e) { /* ok */ } }
            }
        }
        /** A probe's value now: { raw, kw (with a known factor) } or null. */
        const probeNow = (name) => {
            const pr = PROBES.find((x) => x.name === name), p = probe[name];
            if (!pr || !p || Date.now() - p.t > 30000) return null;
            return { raw: p.raw, kw: G.isNum(pr.factor) ? p.raw * pr.factor : null };
        };
        let slowTimer = null;
        function scheduleSlow() {
            clearTimeout(slowTimer);
            slowTimer = setTimeout(() => readSlow().then(scheduleSlow, scheduleSlow), settings.get('slowPoll') * 1000);
        }
        diag.on('available', (a) => { if (a) readSlow(); });
        scheduleSlow();
        settings.onChange((k) => { if (k === 'powerPoll') schedulePower(); if (k === 'slowPoll') scheduleSlow(); });

        /* ---------- identifier scan (Scan page) ----------
         * Asks one control unit ("scanUnit": the battery unit, or the IHKA climate unit that runs the HV
         * heater and the electric A/C compressor) for every identifier in its ranges, one at a time between
         * the other reads, and keeps the ones that answer. Each unit keeps its last two scans
         * (scan_<unit>.json, scan_<unit>_prev.json): what changed between them is listed, so a value can be
         * found by scanning with something off, then on (heater, A/C). Battery replies holding a 2-byte value
         * that reads as a cell voltage (3.0-4.3 V at 1 mV) or a pack voltage (200-460 V at 0.01 V) are flagged. */
        const SCAN_UNITS = {
            7: { name: 'battery unit (SME)', ranges: [[0xDD00, 0xDDFF], [0xDF00, 0xDFFF], [0xD600, 0xD6FF], [0x6300, 0x63FF]] },
            120: { name: 'climate unit (IHKA)', ranges: [[0xD000, 0xDFFF], [0x4000, 0x41FF]] },
        };
        const scanUnit = () => (SCAN_UNITS[+settings.get('scanUnit')] ? +settings.get('scanUnit') : 7);
        const scanFile = (u, prev) => path.join(ctx.dataDir, 'scan_' + hex(u) + (prev ? '_prev' : '') + '.json');
        const readScan = (f) => { try { const o = JSON.parse(fs.readFileSync(f, 'utf8')); return o && o.hits ? o : null; } catch (e) { return null; } };
        const scan = { unit: 0, running: false, done: 0, total: 0, hits: [], noReply: 0, t: 0, prev: null };
        function loadScan() {
            const u = scanUnit();
            if (scan.running && scan.unit === u) return;
            scan.running = false;
            // the scan from before 1.1.2 (battery only) was scan.json
            const cur = readScan(scanFile(u)) || (u === 7 ? readScan(path.join(ctx.dataDir, 'scan.json')) : null);
            // no saved scan: the identifiers known to answer on this car (config.scanKnown), so the live
            // comparison can start without the long scan
            const known = !cur && ctx.spec.config && ctx.spec.config.scanKnown && ctx.spec.config.scanKnown[String(u)];
            const kn = known ? { hits: known.map((did) => ({ did, bytes: [] })), t: Date.now(), done: 0, known: true } : null;
            Object.assign(scan, { unit: u, total: SCAN_UNITS[u].ranges.reduce((a, r) => a + r[1] - r[0] + 1, 0), hits: [], done: 0, t: 0, noReply: 0, known: false }, cur || kn || {});
            scan.prev = readScan(scanFile(u, true));
        }
        loadScan();
        settings.onChange((k) => { if (k === 'scanUnit') loadScan(); });
        async function runScan() {
            if (scan.running || !diag.available) return;
            const u = scanUnit(), unit = SCAN_UNITS[u];
            loadScan();
            if (scan.t) { try { fs.writeFileSync(scanFile(u, true), JSON.stringify({ hits: scan.hits, done: scan.done, t: scan.t, noReply: scan.noReply })); } catch (e) { /* ok */ } }
            scan.prev = scan.t ? { hits: scan.hits, t: scan.t } : scan.prev;
            Object.assign(scan, { unit: u, running: true, done: 0, hits: [], noReply: 0, t: Date.now() });
            log.info('scan: ' + unit.name + ' 0x' + hex(u) + ', ' + scan.total + ' identifiers');
            for (const [a, b] of unit.ranges) {
                for (let did = a; did <= b; did++) {
                    if (!scan.running || scan.unit !== u) return;
                    await exclusive(async () => {
                        const accept = (r) => (r[0] === 0x62 && ((r[1] << 8) | r[2]) === did) || (r[0] === 0x7F && r[1] === 0x22);
                        let r = null;
                        try { r = await diag.physical(u, 0x22, [did >> 8, did & 255], 1500, accept); } catch (e) { /* link error: counts as no reply */ }
                        if (!r) scan.noReply++;
                        else if (r[0] === 0x62) {
                            const hit = { did: hex(did >> 8) + hex(did & 255), bytes: r.slice(3) };
                            scan.hits.push(hit);
                            log.info('scan ' + hex(u) + ': ' + hit.did + ' = ' + hit.bytes.map((x) => hex(x)).join(' '));
                        }
                    });
                    scan.done++;
                    // a unit that doesn't answer (not fitted, asleep, link lost): stop rather than wait 1.5 s x thousands
                    if (scan.noReply >= 25 && scan.noReply === scan.done) { log.warn('scan: no replies, stopped'); scan.running = false; break; }
                }
            }
            scan.running = false;
            try { fs.writeFileSync(scanFile(u), JSON.stringify({ hits: scan.hits, done: scan.done, t: scan.t, noReply: scan.noReply })); } catch (e) { log.warn('scan save: ' + e); }
            log.info('scan done: ' + scan.hits.length + ' identifiers answer');
        }
        /* ---------- live comparison after a scan ----------
         * Once a unit has been scanned, only the identifiers that answered are read again, every few seconds
         * while the Scan page is shown (seconds, not minutes). The first of these reads (or the one after
         * Reset) is the baseline; the bytes that differ from it now are listed, with how often they changed,
         * so switching the heater or the A/C on shows which values follow it. Saved to scan_<unit>_live.json. */
        const cmpState = { unit: 0, base: null, now: {}, flips: {}, t: 0, busy: false, cycles: 0 };
        function rebase() { Object.assign(cmpState, { unit: scan.unit, base: null, now: {}, flips: {}, t: Date.now(), cycles: 0 }); }
        async function watchCycle() {
            if (cmpState.busy || scan.running || !scan.t || !scan.hits.length || !diag.available || pages()[page] !== 'scan') return;
            if (cmpState.unit !== scan.unit) rebase();
            cmpState.busy = true;
            const now = {};
            for (const h of scan.hits) {
                if (scan.running || pages()[page] !== 'scan') break;
                const did = parseInt(h.did, 16);
                await exclusive(async () => {
                    const accept = (r) => (r[0] === 0x62 && ((r[1] << 8) | r[2]) === did) || (r[0] === 0x7F && r[1] === 0x22);
                    let r = null;
                    try { r = await diag.physical(scan.unit, 0x22, [did >> 8, did & 255], 1500, accept); } catch (e) { /* skip */ }
                    if (r && r[0] === 0x62) now[h.did] = r.slice(3);
                });
            }
            if (!cmpState.base) cmpState.base = now;
            else {
                Object.keys(now).forEach((k) => {
                    const a = cmpState.now[k], b = now[k];
                    if (a) b.forEach((x, i) => { if (a[i] !== x) cmpState.flips[k + '@' + i] = (cmpState.flips[k + '@' + i] || 0) + 1; });
                });
            }
            cmpState.now = now; cmpState.cycles++;
            try { fs.writeFileSync(scanFile(scan.unit).replace('.json', '_live.json'), JSON.stringify({ t: cmpState.t, base: cmpState.base, now: cmpState.now, flips: cmpState.flips })); } catch (e) { /* ok */ }
            cmpState.busy = false;
        }
        setInterval(() => { watchCycle().catch((e) => { cmpState.busy = false; log.warn('watch: ' + e); }); }, 3000);
        /** Bytes that differ from the baseline now: ["D1A2@3 00>5A x2", ...] (x = how many reads it changed in). */
        function changes() {
            if (!cmpState.base || cmpState.unit !== scan.unit) return null;
            const out = [];
            Object.keys(cmpState.now).forEach((k) => {
                const o = cmpState.base[k], n = cmpState.now[k];
                if (!o) return;
                for (let i = 0; i < Math.max(o.length, n.length); i++) {
                    if (o[i] !== n[i]) out.push({ k: k + '@' + i, txt: k + '@' + i + ' ' + (o[i] == null ? '--' : hex(o[i])) + '>' + (n[i] == null ? '--' : hex(n[i])), f: cmpState.flips[k + '@' + i] || 0 });
                }
            });
            // steady changes first: values that flip at every read (timers, counters) are noise and go last
            out.sort((a, b) => a.f - b.f);
            return out.map((c) => c.txt);
        }
        /** What a reply might hold: [{ at, kind, value }] for 2-byte words that read as a cell or a pack voltage. */
        function guesses(bytes) {
            const out = [];
            for (let i = 0; i + 1 < bytes.length; i++) {
                const w = bytes[i] * 256 + bytes[i + 1];
                if (w >= 3000 && w <= 4300) out.push({ at: i, kind: 'cell', value: w / 1000 });
                if (w >= 20000 && w <= 46000) out.push({ at: i, kind: 'pack', value: w / 100 });
            }
            return out;
        }

        /* ---------- climate: estimates and the measured standing draw ---------- */
        const comfortKw = (d) => {
            const seats = Object.keys(d.seats || {}).reduce((a, k) => a + (d.seats[k] ? SEAT_KW[d.seats[k]] : 0), 0);
            return { seats, wheel: d.wheel ? WHEEL_KW : 0 };
        };
        const blowerKw = (d) => {
            if (!G.isNum(d.blower) || d.blower <= 0) return 0;
            const f = G.clamp(d.blower / Math.max(8, d.blowerTop || 8), 0, 1);
            return BLOWER_KW[0] + BLOWER_KW[1] * f * f;
        };
        /** Standing with the engine off and not plugged in: the pack only feeds the car's own consumers. */
        const standingDraw = (d, now) => {
            if (!G.isNum(d.kw) || d.engine || !G.isNum(d.speed) || d.speed > 1) return null;
            if (!d.demo && (!live.standSince || now - live.standSince < STAND_MS)) return null;
            return d.kw > 0.02 ? d.kw : null;          // negative = charging (plugged in)
        };
        const baseline = () => (G.isNum(st.baseKw) ? st.baseKw : BASELINE_KW);
        /** The on-board draw: learned while standing with climate, seats and wheel all off. */
        function learnBaseline(kw, now) {
            const d = { kw, engine: engineOn(), speed: live.speed };
            const draw = standingDraw(d, now), c = comfortKw(live);
            if (draw === null || live.climate !== false || c.seats || c.wheel || draw > 3) return;
            st.baseKw = G.isNum(st.baseKw) ? st.baseKw + (draw - st.baseKw) * 0.05 : draw;
            st.baseN = (st.baseN || 0) + 1;
            if (now - savedAt > 60000) save();
        }
        /** Climate power now: { kw, how } - measured while standing, else the sum of what the car reports / estimates. */
        // the last measured climate draw, used while driving as long as the climate setting stays the same
        let lastMeasured = null;
        /** The car's compressor power, when it really reports it (the X5 45e sends 0 with the A/C running). */
        const acReported = (d) => G.isNum(d.acKw) && (d.acKw > 0.05 || d.climate !== 'ac');
        /** What the climate unit itself reports for its compressor and heater (kW), or null. */
        function unitKw(d) {
            if (d.demo) return d.unit || null;
            const a = probeNow('ac'), h = probeNow('heater');
            if ((!a || !G.isNum(a.kw)) && (!h || !G.isNum(h.kw))) return null;
            return { ac: a && G.isNum(a.kw) ? a.kw : 0, heater: h && G.isNum(h.kw) ? h.kw : 0 };
        }
        /** The rest of the climate draw with the climate on (pumps, fans, the unit itself): learned while measuring. */
        const otherKw = () => (G.isNum(st.otherKw) ? st.otherKw : 0.3);
        function climatePower(d, now) {
            const c = comfortKw(d), u = unitKw(d), on = d.climate !== false;
            const est = u ? u.ac + u.heater + (on ? blowerKw(d) + otherKw() : 0) + c.seats + c.wheel
                : (acReported(d) ? d.acKw : 0) + blowerKw(d) + c.seats + c.wheel;
            const draw = standingDraw(d, now);
            if (draw !== null) {
                const kw = Math.max(0, draw - baseline());
                if (!d.demo) {
                    lastMeasured = { kw, t: now, climate: d.climate, comfort: c.seats + c.wheel };
                    // pumps / fans: what the measurement holds beyond the compressor, heater, blower and seats
                    if (u && on) {
                        const o = G.clamp(kw - u.ac - u.heater - blowerKw(d) - c.seats - c.wheel, 0, 1.5);
                        st.otherKw = G.isNum(st.otherKw) ? st.otherKw + (o - st.otherKw) * 0.1 : o;
                    }
                }
                return { kw, how: 'measured', draw, est, u };
            }
            // driving: the climate unit's own figures when it has them
            if (u) return { kw: est, how: 'climate unit', draw: null, est, u };
            if (d.climate === false && !c.seats && !c.wheel) return { kw: 0, how: 'estimated', draw: null, est };
            const lm = lastMeasured;
            if (lm && lm.climate === d.climate && now - lm.t < 30 * 60000) {
                // the last measurement, with the seat / wheel heating switched on or off since then
                return { kw: Math.max(0, lm.kw - lm.comfort + c.seats + c.wheel), how: 'last measured', draw: null, est, ago: now - lm.t };
            }
            return { kw: est, how: 'estimated', draw: null, est };
        }
        setInterval(() => {
            const d = data(), now = Date.now();
            push(climTrace, CLIMATE_TRACE_S, climatePower(d, now).kw);
            const t = cellTemps(d);
            if (t && G.isNum(t.avg)) push(tempTrace, TEMP_TRACE_S, t.avg);
        }, 5000);

        /* ---------- what the pages show ---------- */
        const demo = new Demo();
        const usingDemo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !diag.available && !live.kwT);
        function data() {
            if (usingDemo()) return Object.assign(demo.sample(), { demo: true });
            const now = Date.now(), fresh = (t, s) => t && now - t < s * 1000;
            const slowOk = (k) => fresh(live.slowT[k], Math.max(30, settings.get('slowPoll') * 4));
            return {
                demo: false, kw: fresh(live.kwT, Math.max(6, BG_POWER_S * 4)) ? live.kw : null,
                v: fresh(live.vT, 60) ? live.v : fresh(live.lscVT, 60) ? live.lscV : null, a: fresh(live.kwT, 10) ? live.a : null,
                speed: live.speed, engine: engineOn(), soc: slowOk('soc') ? live.soc : null,
                cellV: slowOk('cellV') ? live.cellV : null, cellT: slowOk('cellT') ? live.cellT : null, carT: live.carT,
                coolant: slowOk('coolant') ? live.coolant : null, limits: slowOk('limits') ? live.limits : null,
                ambient: live.ambient, climate: live.climate, blower: live.blower, blowerTop: live.blowerTop,
                acKw: live.acKw, seats: live.seats, wheel: live.wheel,
            };
        }
        /** Cell temperatures: the battery unit's (cell core), else the car's own. */
        const cellTemps = (d) => (d.cellT && G.isNum(d.cellT.avg) ? Object.assign({ src: 'cell core (battery unit)' }, d.cellT)
            : d.carT && G.isNum(d.carT.avg) ? Object.assign({ src: 'the car\'s battery temperature' }, d.carT) : null);
        /** Power the battery allows now (kW): { out, in } from the current limits x pack voltage. */
        const limitsKw = (d) => (d.limits && G.isNum(d.v) ? {
            out: G.isNum(d.limits.dischargeA) ? d.limits.dischargeA * d.v / 1000 : null,
            in: G.isNum(d.limits.chargeA) ? d.limits.chargeA * d.v / 1000 : null,
        } : null);

        /* ---------- units ---------- */
        const F = () => settings.get('tempUnit') === 'f';
        const T = (c) => (G.isNum(c) ? (F() ? c * 9 / 5 + 32 : c) : null);
        const dT = (c) => (G.isNum(c) ? (F() ? c * 9 / 5 : c) : null);          // a temperature difference
        const tU = () => (F() ? '°F' : '°C');
        const fmtT = (c, dec) => (G.isNum(c) ? G.fmt(T(c), dec || 0) + ' ' + tU() : '--');

        /** Power for display: { text, col, what }; held 0.25 s so it doesn't flicker at 60 fps. */
        function power(d, t) {
            if (!G.isNum(d.kw)) {
                const why = d.demo ? 'DEMO' : !diag.available ? 'NO DIAGNOSTIC LINK' : iFail >= 3 ? (settings.get('diagPage') ? 'NO REPLY - SEE DIAGNOSTICS' : 'NO REPLY') : 'READING';
                return { kw: null, text: '--', col: t.dim, what: why };
            }
            const v = G.hold('edrive2.kw', d.kw, 250), a = Math.abs(v);
            const moving = G.isNum(d.speed) && d.speed > 1;
            const what = v > IDLE_KW ? (moving ? 'DRIVING' : 'DRAWING') : v < -IDLE_KW ? (moving ? 'REGEN' : 'CHARGING') : 'IDLE';
            return { kw: v, text: (v < -IDLE_KW ? '-' : '') + G.fmt(a, a < 10 ? 1 : 0), col: v < -IDLE_KW ? GO : a >= 60 ? t.warn : t.text, what };
        }

        /* ---------- pages ---------- */
        const pages = () => ['power', 'battery', 'cells', 'climate'].concat(settings.get('diagPage') ? ['diag', 'scan', 'signals'] : []);
        const NAMES = { power: 'Power', battery: 'Battery', cells: 'Cells', climate: 'Climate', diag: 'Diagnostics', scan: 'Scan', signals: 'Signals' };
        let page = 0;
        ui.onClick('BTN_PAGE', () => { page = (page + 1) % pages().length; return render(); });
        ui.onClick('BTN_PREV', () => { const n = pages().length; page = (page + n - 1) % n; return render(); });
        ui.onClick('BTN_RESET', () => {
            if (pages()[page] === 'scan') {
                // a scan from the last week: Reset = new baseline for the live comparison; else scan again
                if (scan.t && !scan.running && Date.now() - scan.t < 7 * 86400000 && scan.hits.length) rebase();
                else { scan.running = false; setTimeout(runScan, 2000); }
                return render();
            }
            Object.assign(trip, { out: 0, regen: 0, charged: 0, climate: 0, peakOut: 0, peakIn: 0, since: Date.now() }); return render();
        });

        /** Centre-zero power bar: regen / charge to the left, drive to the right, scaled to the limits. */
        function powerBar(cv, t, x, y, w, kw, lim) {
            const outMax = Math.max(20, lim && G.isNum(lim.out) ? lim.out : settings.get('gaugeKw'));
            const inMax = Math.max(10, lim && G.isNum(lim.in) && lim.in >= 15 ? lim.in : settings.get('gaugeKw') * 0.5);
            const span = outMax + inMax, x0 = x + w * inMax / span, h = 30;
            const X = (v) => x0 + G.clamp(v, -inMax, outMax) / span * w;
            cv.roundRect(x, y, w, h, 6, withAlpha(t.track, 0.9));
            const sv = G.smooth('edrive2.bar', kw, 14);
            if (G.isNum(sv) && Math.abs(sv) > 0.05) {
                if (sv > 0) cv.rampRect(x0, y, X(sv) - x0, h, 4, t.hotRamp || t.ramp, x0, x + w - x0);
                else cv.roundRect(X(sv), y, x0 - X(sv), h, 4, GO);
            }
            cv.fillRect(Math.round(x0) - 1, y - 8, 3, h + 16, t.text);
            // scale: every 20 kW (ticks), labels at the ends and zero
            for (let v = -Math.floor(inMax / 20) * 20; v <= outMax; v += 20) if (v) cv.fillRect(Math.round(X(v)), y + h + 2, 2, 8, t.tick);
            cv.text('0', x0, y + h + 30, 18, t.dim, { align: 'center', font: 'bold' });
            const lbl = (v) => G.fmt(v, 0) + ' kW';
            const inLim = lim && G.isNum(lim.in) && lim.in >= 15;
            cv.text((inLim ? 'REGEN MAX ' : '') + '-' + lbl(inMax), x, y + h + 30, 18, inLim ? GO : t.dim, { font: 'bold' });
            cv.text((lim && G.isNum(lim.out) ? 'BATTERY MAX ' : '') + lbl(outMax), x + w, y + h + 30, 18, t.dim, { font: 'bold', align: 'right' });
        }

        /**
         * kW over the last `secs` around a zero line, each reading drawn at its own time until the next one
         * (a step), so the trace scrolls smoothly at any read rate. A gap of over 4 s (no reading) stays empty.
         */
        function powerTrace(cv, t, x, y, w, h, pts, secs, top, bottom) {
            const now = Date.now(), y0 = Math.round(y + h * top / (top + bottom));
            const X = (ts) => x + w - (now - ts) / (secs * 1000) * w;
            cv.fillRect(x, y0, w, 1, withAlpha(t.tick, 0.8));
            cv.clip(x, y, w, h);
            for (let i = 0; i < pts.length; i++) {
                const [ts, v] = pts[i], next = i + 1 < pts.length ? pts[i + 1][0] : now;
                if (!G.isNum(v) || Math.abs(v) < 0.05 || next - ts > 4000) continue;
                const xa = Math.max(x, X(ts)), xb = Math.min(x + w, X(next));
                if (xb <= x || xb - xa < 0.5) continue;
                const hh = G.clamp(v / (v > 0 ? top : bottom), -1, 1) * (v > 0 ? y0 - y : y + h - y0);
                cv.fillRect(xa, v > 0 ? y0 - hh : y0, xb - xa, Math.abs(hh), v > 0 ? withAlpha(t.text, 0.75) : withAlpha(GO, 0.85));
            }
            cv.noclip();
            cv.text(secs >= 120 ? Math.round(secs / 60) + ' min ago' : secs + ' s ago', x, y + h + 22, 16, t.dim);
            cv.text('now', x + w, y + h + 22, 16, t.dim, { align: 'right' });
        }

        function renderPower(cv, t, d) {
            const pw = power(d, t), lim = limitsKw(d);
            G.panel(cv, t, 24, 44, 1000, 468, 'Battery power now');
            const vw = cv.text(pw.text, 48, 214, 150, pw.col, { font: 'num' });
            cv.text('kW', 62 + vw, 214, 44, t.dim, { font: 'bold' });
            const pcol = pw.what === 'REGEN' || pw.what === 'CHARGING' ? GO : pw.kw === null ? t.dim : t.text;
            cv.text(pw.what, 1000, 120, 30, pcol, { font: 'bold', spacing: 2, align: 'right' });
            cv.text(G.isNum(d.v) ? G.fmt(d.v, 0) + ' V' + (G.isNum(d.a) ? '  ·  ' + G.fmt(-d.a * (cfg.powerSign < 0 ? 1 : -1), 0) + ' A' : '') : 'pack --', 1000, 162, 26, t.dim, { align: 'right' });
            if (d.engine) cv.text('ENGINE RUNNING', 1000, 200, 22, t.warn, { font: 'bold', spacing: 1.5, align: 'right' });
            powerBar(cv, t, 48, 248, 952, pw.kw, lim);
            const top = Math.max(20, ...trace.map((p) => p[1]), 0) * 1.1, bottom = Math.max(10, ...trace.map((p) => -p[1]), 0) * 1.1;
            const tr = d.demo ? demoHistory(TRACE_S, 1, (x) => x.kw) : trace;
            powerTrace(cv, t, 48, 340, 952, 132, tr, TRACE_S, d.demo ? 60 : top, d.demo ? 25 : bottom);

            // ---- this drive
            const x = 1048, w = 528;
            G.panel(cv, t, x, 44, w, 270, 'This drive');
            const tp = d.demo ? { out: 2.84, regen: 0.61, charged: 0, climate: 0.48, peakOut: 61, peakIn: 24, since: Date.now() - 23 * 60000 } : trip;
            const col = (cx, label, v, c) => {
                cv.text(label, cx, 116, 20, t.dim, { font: 'bold', spacing: 1.2 });
                const ww = cv.text(G.fmt(v, v >= 10 ? 1 : 2), cx, 170, 46, c, { font: 'num' });
                cv.text('kWh', cx + 6 + ww, 170, 22, t.dim);
            };
            col(x + 24, 'USED', tp.out, t.text);
            col(x + 200, 'REGEN', tp.regen, GO);
            col(x + 370, 'NET', tp.out - tp.regen, t.text);
            cv.fillRect(x + 24, 196, w - 48, 1, t.panelEdge);
            // what the energy used went to: driving (motor and on-board electrics) vs. climate
            const clim = Math.min(tp.climate || 0, tp.out), drive = Math.max(0, tp.out - clim);
            const cp2 = tp.out > 0.005 ? clim / tp.out : 0, dp = tp.out > 0.005 ? 1 - cp2 : 0;
            const pct = (f) => (tp.out > 0.005 ? Math.round(f * 100) + ' %' : '--');
            cv.text('DRIVING  ' + G.fmt(drive, 2) + ' kWh  ' + pct(dp), x + 24, 228, 20, t.text, { font: 'bold', spacing: 1 });
            cv.text('CLIMATE  ' + G.fmt(clim, 2) + ' kWh  ' + pct(cp2), x + w - 24, 228, 20, t.warn, { font: 'bold', spacing: 1, align: 'right' });
            const bx = x + 24, bw = w - 48;
            cv.roundRect(bx, 240, bw, 14, 5, withAlpha(t.track, 0.9));
            if (tp.out > 0.005) {
                if (dp > 0.005) cv.roundRect(bx, 240, Math.max(4, bw * dp), 14, 5, withAlpha(t.text, 0.8));
                if (cp2 > 0.005) cv.roundRect(bx + bw * dp, 240, Math.max(4, bw * cp2), 14, 5, t.warn);
            }
            const mins = Math.round((Date.now() - tp.since) / 60000);
            cv.text('peak ' + G.fmt(tp.peakOut, 0) + ' kW out · ' + G.fmt(tp.peakIn, 0) + ' kW regen  ·  ' + (tp.charged > 0.05 ? 'charged ' + G.fmt(tp.charged, 2) + ' kWh  ·  ' : '')
                + 'since ' + (mins < 1 ? 'just now' : mins + ' min ago'), x + 24, 288, 18, t.dim);

            // ---- battery at a glance
            G.panel(cv, t, x, 330, w, 182, 'Battery');
            const sw = cv.text(G.isNum(d.soc) ? G.fmt(d.soc, 0) : '--', x + 24, 452, 72, G.isNum(d.soc) ? t.text : t.dim, { font: 'num' });
            cv.text('%', x + 32 + sw, 452, 28, t.dim, { font: 'bold' });
            if (G.isNum(d.soc)) cv.text('~' + G.fmt(d.soc / 100 * settings.get('designKwh'), 1) + ' kWh', x + 24, 490, 20, t.dim);
            const ct = cellTemps(d);
            cv.text('CELLS', x + w - 24, 392, 20, t.dim, { font: 'bold', spacing: 1.2, align: 'right' });
            cv.text(ct ? fmtT(ct.avg) : '--', x + w - 24, 446, 40, ct ? tempColor(t, ct.avg) : t.dim, { font: 'bold', align: 'right' });
            if (ct && G.isNum(ct.min) && G.isNum(ct.max)) cv.text(G.fmt(T(ct.min), 0) + ' - ' + G.fmt(T(ct.max), 0) + ' ' + tU(), x + w - 24, 490, 20, t.dim, { align: 'right' });
        }
        /** Demo history: f(demo sample) over the last `secs`, every `step` s. */
        function demoHistory(secs, step, f) {
            const out = [], now = Date.now(), t0 = demo.t0;
            for (let i = secs; i >= 0; i -= step) {
                demo.t0 = t0 + i * 1000;
                out.push([now - i * 1000, f(Object.assign(demo.sample(), { demo: true }))]);
            }
            demo.t0 = t0;
            return out;
        }
        /** Cell temperature colours: cold packs give less power and regen, hot ones get limited. */
        const tempColor = (t, c) => (!G.isNum(c) ? t.dim : c < 5 ? t.cold : c > 45 ? t.crit : c > 38 ? t.warn : t.text);

        /** Every cell's voltage: the lowest and highest marked, scaled to the spread. */
        function renderCells(cv, t, d) {
            const cv0 = d.cellV, cells = cv0 && cv0.cells;
            G.panel(cv, t, 24, 44, 1552, 468, 'Cell voltages' + (cells ? '  (' + cells.length + ' cells)' : ''));
            if (!cells) {
                cv.text(settings.get('diagPage') ? 'no reading - see Diagnostics' : 'no reading yet', 800, 290, 26, t.dim, { align: 'center' });
                return;
            }
            const spread = (cv0.max - cv0.min) * 1000, scol = spread > 100 ? t.crit : spread > 50 ? t.warn : GO;
            const head = (x, label, v, c, sub) => {
                cv.text(label, x, 104, 18, t.dim, { font: 'bold', spacing: 1.2 });
                cv.text(v, x, 146, 36, c, { font: 'bold' });
                if (sub) cv.text(sub, x, 172, 18, t.dim);
            };
            head(48, 'LOWEST', G.fmt(cv0.min, 3) + ' V', t.warn, 'cell ' + cv0.minAt);
            head(330, 'HIGHEST', G.fmt(cv0.max, 3) + ' V', t.accent2 || t.text, 'cell ' + cv0.maxAt);
            head(612, 'AVERAGE', G.fmt(cv0.avg, 3) + ' V', t.text, G.isNum(d.v) ? 'pack ' + G.fmt(d.v, 1) + ' V' : '');
            head(894, 'SPREAD', G.fmt(spread, 0) + ' mV', scol, spread > 100 ? 'out of balance' : spread > 50 ? 'a bit high (normal under load)' : 'well balanced');
            cv.text(G.isNum(d.soc) ? G.fmt(d.soc, 1) + ' %' : '', 1552, 146, 36, t.text, { font: 'bold', align: 'right' });
            cv.text('CHARGE', 1552, 104, 18, t.dim, { font: 'bold', spacing: 1.2, align: 'right' });
            // bars: from a floor below the lowest cell, so the differences show
            const x0 = 96, w = 1456, top = 200, base = 456, n = cells.length, bw = w / n;
            const pad = Math.max(0.005, (cv0.max - cv0.min) * 0.6), lo = cv0.min - pad, hi = cv0.max + pad * 0.4;
            const Y = (v) => base - (v - lo) / (hi - lo) * (base - top);
            [lo, (lo + hi) / 2, hi].forEach((v) => {
                cv.fillRect(x0, Math.round(Y(v)), w, 1, withAlpha(t.tick, 0.35));
                cv.text(G.fmt(v, 3), x0 - 8, Y(v) + 6, 16, t.dim, { align: 'right' });
            });
            cv.fillRect(x0, Math.round(Y(cv0.avg)), w, 1, withAlpha(t.text, 0.5));
            cells.forEach((v, i) => {
                if (!G.isNum(v)) return;
                const c = i + 1 === cv0.minAt ? t.warn : i + 1 === cv0.maxAt ? (t.accent2 || t.text) : withAlpha(t.text, 0.7);
                cv.fillRect(x0 + i * bw + 1, Y(v), Math.max(1, bw - 2), base - Y(v), c);
            });
            for (let i = 0; i < n; i += 12) cv.text(String(i + 1), x0 + i * bw + bw / 2, base + 24, 16, t.dim, { align: 'center' });
            cv.text(String(n), x0 + (n - 1) * bw + bw / 2, base + 24, 16, t.dim, { align: 'center' });
            cv.text('cell', x0 - 8, base + 24, 16, t.dim, { align: 'right' });
        }

        function renderBattery(cv, t, d) {
            const ct = cellTemps(d);
            // ---- cell temperatures
            G.panel(cv, t, 24, 44, 760, 468, 'Cell temperature');
            const aw = cv.text(ct ? G.fmt(T(ct.avg), 0) : '--', 48, 196, 120, ct ? tempColor(t, ct.avg) : t.dim, { font: 'num' });
            cv.text(tU() + '  mean', 60 + aw, 196, 30, t.dim, { font: 'bold' });
            cv.text('MIN', 600, 116, 20, t.dim, { font: 'bold', spacing: 1.2, align: 'right' });
            cv.text('MAX', 760, 116, 20, t.dim, { font: 'bold', spacing: 1.2, align: 'right' });
            cv.text(ct && G.isNum(ct.min) ? G.fmt(T(ct.min), 1) : '--', 600, 166, 40, ct ? tempColor(t, ct.min) : t.dim, { font: 'bold', align: 'right' });
            cv.text(ct && G.isNum(ct.max) ? G.fmt(T(ct.max), 1) : '--', 760, 166, 40, ct ? tempColor(t, ct.max) : t.dim, { font: 'bold', align: 'right' });
            if (ct && G.isNum(ct.min) && G.isNum(ct.max)) cv.text('spread ' + G.fmt(dT(ct.max - ct.min), 1) + ' ' + tU(), 760, 200, 20, ct.max - ct.min > 8 ? t.warn : t.dim, { align: 'right' });
            // temperature scale -20..60 °C, the comfortable band marked, min..max as a band, mean as a marker
            const sx = 48, sw = 712, sy = 236, lo = -20, hi = 60, X = (c) => sx + G.clamp((c - lo) / (hi - lo), 0, 1) * sw;
            cv.roundRect(sx, sy, sw, 26, 6, withAlpha(t.track, 0.9));
            cv.roundRect(X(15), sy, X(35) - X(15), 26, 0, withAlpha(GO, 0.18));
            if (ct && G.isNum(ct.min) && G.isNum(ct.max)) cv.roundRect(X(ct.min), sy + 4, Math.max(6, X(ct.max) - X(ct.min)), 18, 4, withAlpha(tempColor(t, ct.avg) === t.text ? t.accent2 || t.text : tempColor(t, ct.avg), 0.85));
            if (ct && G.isNum(ct.avg)) cv.fillRect(Math.round(X(ct.avg)) - 2, sy - 6, 4, 38, t.text);
            (F() ? [0, 40, 80, 120] : [-20, 0, 20, 40, 60]).forEach((u) => { const c = F() ? (u - 32) * 5 / 9 : u; cv.text(String(u), X(c), sy + 50, 18, t.dim, { align: 'center', font: 'bold' }); });
            cv.text('best ' + G.fmt(T(15), 0) + '-' + G.fmt(T(35), 0) + ' ' + tU(), (X(15) + X(35)) / 2, sy - 12, 16, GO, { align: 'center', font: 'bold' });
            // trace of the mean, last 30 minutes
            const tr = d.demo ? demoHistory(TEMP_TRACE_S, 30, (x) => x.cellT.avg) : tempTrace;
            if (tr.length > 2) {
                const vs = tr.map((p) => p[1]), tlo = Math.min(...vs) - 1, thi = Math.max(...vs) + 1;
                G.chart(cv, t, 48, 318, 712, 130, {
                    xMin: -TEMP_TRACE_S / 60, xMax: 0, yMin: T(tlo), yMax: T(thi), xUnit: 'min', padLeft: 40,
                    series: [{ pts: tr.map(([ts, v]) => [-(Date.now() - ts) / 60000, T(v)]), color: 'accent2' }],
                });
            } else cv.text('mean temperature over 30 min shows here', 404, 384, 20, t.dim, { align: 'center' });
            cv.text('COOLANT  ' + fmtT(d.coolant, 1) + '   ·   OUTSIDE  ' + fmtT(d.ambient, 0), 48, 480, 22, t.dim, { font: 'bold', spacing: 1 });
            cv.text(ct ? ct.src : settings.get('diagPage') ? 'no reading - see Diagnostics' : 'no reading yet', 760, 480, 18, t.dim, { align: 'right' });

            // ---- cell voltages
            const x = 808, w = 768;
            G.panel(cv, t, x, 44, w, 226, 'Cell voltage');
            const cvv = d.cellV;
            const cell = (cx, label, v) => {
                cv.text(label, cx, 120, 20, t.dim, { font: 'bold', spacing: 1.2 });
                const ww = cv.text(G.isNum(v) ? G.fmt(v, 3) : '--', cx, 178, 52, G.isNum(v) ? t.text : t.dim, { font: 'num' });
                cv.text('V', cx + 6 + ww, 178, 24, t.dim);
            };
            cell(x + 24, 'LOWEST CELL' + (cvv && cvv.minAt ? '  #' + cvv.minAt : ''), cvv && cvv.min);
            cell(x + 280, 'HIGHEST CELL' + (cvv && cvv.maxAt ? '  #' + cvv.maxAt : ''), cvv && cvv.max);
            const spread = cvv && G.isNum(cvv.min) && G.isNum(cvv.max) ? (cvv.max - cvv.min) * 1000 : null;
            const scol = !G.isNum(spread) ? t.dim : spread > 100 ? t.crit : spread > 50 ? t.warn : GO;
            cv.text('SPREAD', x + w - 24, 120, 20, t.dim, { font: 'bold', spacing: 1.2, align: 'right' });
            const mw = cv.text('mV', x + w - 24, 178, 24, t.dim, { align: 'right' });
            cv.text(G.isNum(spread) ? G.fmt(spread, 0) : '--', x + w - 30 - mw, 178, 52, scol, { font: 'num', align: 'right' });
            cv.text('PACK  ' + (G.isNum(d.v) ? G.fmt(d.v, 1) + ' V' : '--') + '   ·   CHARGE  ' + (G.isNum(d.soc) ? G.fmt(d.soc, 1) + ' %' : '--'), x + 24, 228, 22, t.text, { font: 'bold', spacing: 1 });
            cv.text(G.isNum(spread) ? (spread > 100 ? 'large spread: cells out of balance' : spread > 50 ? 'spread a bit high (normal under heavy load)' : 'cells well balanced') : '', x + 24, 256, 18, t.dim);

            // ---- power limits
            G.panel(cv, t, x, 286, w, 226, 'Power the battery allows now');
            const lim = limitsKw(d), pw = power(d, t);
            const lrow = (y, label, max, now, c) => {
                cv.text(label, x + 24, y, 22, t.dim, { font: 'bold', spacing: 1.2 });
                cv.text(G.isNum(max) ? G.fmt(max, 0) + ' kW' : '--', x + 330, y, 30, G.isNum(max) ? t.text : t.dim, { font: 'bold', align: 'right' });
                const bx = x + 360, bw = w - 384;
                cv.roundRect(bx, y - 20, bw, 22, 5, withAlpha(t.track, 0.9));
                if (G.isNum(max) && max > 0 && G.isNum(now) && now > 0) cv.roundRect(bx, y - 20, Math.max(6, bw * G.clamp(now / max, 0, 1)), 22, 5, c);
                if (G.isNum(max) && max > 0 && G.isNum(now) && now > 0) cv.text(G.fmt(G.clamp(now / max * 100, 0, 999), 0) + ' %', x + w - 24, y + 26, 16, t.dim, { align: 'right' });
            };
            lrow(370, 'DISCHARGE', lim && lim.out, G.isNum(pw.kw) && pw.kw > 0 ? pw.kw : 0, t.text);
            lrow(438, 'CHARGE / REGEN', lim && lim.in, G.isNum(pw.kw) && pw.kw < 0 ? -pw.kw : 0, GO);
            cv.text(lim ? 'lower when the cells are cold, hot, nearly empty or nearly full' : settings.get('diagPage') ? 'no reading - see Diagnostics' : 'no reading yet', x + 24, 494, 18, t.dim);
        }

        function renderClimate(cv, t, d) {
            const now = Date.now(), cp = climatePower(d, now), c = comfortKw(d);
            // ---- consumers
            G.panel(cv, t, 24, 44, 900, 468, 'Climate & comfort');
            const state = d.climate === null || d.climate === undefined ? 'climate n/a' : d.climate === 'ac' ? 'CLIMATE ON  ·  A/C ON' : d.climate ? 'CLIMATE ON  ·  A/C OFF' : 'CLIMATE OFF';
            cv.text(state, 900, 80, 22, d.climate ? t.text : t.dim, { font: 'bold', spacing: 1.2, align: 'right' });
            ['', 'NOW', 'KW'].forEach((h, i) => cv.text(h, [48, 560, 900][i], 120, 18, t.dim, { font: 'bold', spacing: 1.2, align: i === 2 ? 'right' : 'left' }));
            const seatTxt = Object.keys(d.seats || {}).filter((k) => d.seats[k]).map((k) => ({ DR: 'driver', PS: 'passenger', DRR: 'rear left', PSR: 'rear right' }[k] + ' ' + d.seats[k])).join(', ');
            const u = cp.u || unitKw(d), on = d.climate !== false;
            const rows = u ? [
                ['A/C compressor', u.ac > 0.02 ? 'climate unit' : 'off', u.ac],
                ['Heater', u.heater > 0.02 ? 'climate unit' : 'off', u.heater],
                ['Blower', G.isNum(d.blower) ? (d.blower > 0 ? 'level ' + d.blower + ' (est.)' : 'off') : 'n/a', on ? blowerKw(d) : 0],
                ['Seat & wheel heating', [seatTxt, d.wheel ? 'wheel' : ''].filter(Boolean).join(', ') || 'off', c.seats + c.wheel],
                ['Pumps & fans', on ? (cp.how === 'measured' ? 'measured' : G.isNum(st.otherKw) ? 'learned' : 'typical') : 'off',
                    on ? (cp.how === 'measured' ? Math.max(0, cp.kw - u.ac - u.heater - blowerKw(d) - c.seats - c.wheel) : otherKw()) : 0],
            ] : [
                acReported(d)
                    ? ['A/C compressor', d.acKw > 0.05 ? 'running (car\'s value)' : 'off', d.acKw]
                    : ['A/C & heater', cp.how === 'estimated' ? 'measured when standing' : cp.how === 'measured' ? 'measured' : 'last measured ' + Math.max(1, Math.round(cp.ago / 60000)) + ' min ago',
                        cp.how === 'estimated' ? null : Math.max(0, cp.kw - (d.climate === false ? 0 : blowerKw(d)) - c.seats - c.wheel)],
                ['Blower', G.isNum(d.blower) ? (d.blower > 0 ? 'level ' + d.blower + ' (est.)' : 'off') : 'n/a', d.climate === false ? 0 : blowerKw(d)],
                ['Seat heating', seatTxt ? seatTxt + ' (est.)' : 'off', c.seats],
                ['Steering wheel', d.wheel === null || d.wheel === undefined ? 'n/a' : d.wheel ? 'on (est.)' : 'off', c.wheel],
            ];
            const step = rows.length > 4 ? 38 : 48;
            rows.forEach(([name, note, kw], i) => {
                const y = 160 + i * step;
                if (i % 2 === 0) cv.roundRect(40, y - step + 14, 868, step - 4, 8, withAlpha(t.track, 0.5));
                cv.text(name, 48, y, 26, t.text, { font: 'bold' });
                cv.text(note, 560, y, 20, t.dim);
                cv.text(G.isNum(kw) ? G.fmt(kw, kw < 1 ? 2 : 1) : '-', 900, y, 26, G.isNum(kw) && kw >= 1.5 ? t.warn : t.text, { font: 'bold', align: 'right' });
            });
            cv.fillRect(48, 352, 852, 1, t.panelEdge);
            cv.text(cp.how === 'estimated' ? 'ESTIMATED TOTAL' : cp.how === 'measured' ? 'TOTAL (MEASURED)' : 'TOTAL', 48, 392, 22, t.dim, { font: 'bold', spacing: 1.2 });
            cv.text(G.fmt(cp.how === 'estimated' ? cp.est : cp.kw, 2) + ' kW', 900, 392, 30, t.text, { font: 'bold', align: 'right' });
            const pd = live.pd && live.pd.displayRepartitionDriveElectricPower !== 255 && typeof live.pd.displayRepartitionElectricSeatHeater !== 'string' ? live.pd : null;
            cv.text(pd ? 'CAR\'S POWER DISPLAY  drive ' + pd.displayRepartitionDriveElectricPower + '  ·  climate ' + pd.displayRepartitionAirConditioningElectricPower
                + '  ·  seats ' + pd.displayRepartitionElectricSeatHeater : 'OUTSIDE  ' + fmtT(d.ambient, 0), 48, 484, 20, t.dim, { font: 'bold', spacing: 0.5 });

            // ---- measured
            const x = 948, w = 628;
            G.panel(cv, t, x, 44, w, 468, 'Climate power');
            const kw = cp.kw, kcol = cp.how !== 'estimated' ? (kw >= 2 ? t.warn : t.text) : t.dim;
            const vw = cv.text(G.fmt(kw, kw < 10 ? 1 : 0), x + 24, 196, 104, cp.how === 'measured' ? kcol : t.text, { font: 'num' });
            cv.text('kW', x + 34 + vw, 196, 34, t.dim, { font: 'bold' });
            cv.text(cp.how.toUpperCase(), x + w - 24, 116, 20, cp.how !== 'estimated' ? GO : t.dim, { font: 'bold', spacing: 1.5, align: 'right' });
            const lines = cp.how === 'measured'
                ? ['battery gives ' + G.fmt(cp.draw, 2) + ' kW standing still', '- on-board electrics ' + G.fmt(baseline(), 2) + ' kW' + (G.isNum(st.baseKw) ? ' (learned)' : ' (typical)')]
                : cp.how === 'climate unit' ? ['compressor + heater as the climate unit reports,', 'with blower, seats and pumps / fans (learned)']
                : cp.how === 'last measured' ? ['measured ' + Math.max(1, Math.round(cp.ago / 60000)) + ' min ago, standing still', 'the same climate setting since then']
                : ['measured while standing with the engine off', 'and not plugged in; then kept while driving'];
            lines.forEach((l, i) => cv.text(l, x + w - 24, 152 + i * 28, 20, t.dim, { align: 'right' }));
            // last 10 minutes
            const tr = d.demo ? demoHistory(CLIMATE_TRACE_S, 5, (x) => climatePower(x, now).kw) : climTrace, top = Math.max(1, ...tr.map((p) => p[1])) * 1.15;
            G.chart(cv, t, x + 16, 236, w - 40, 196, {
                xMin: -CLIMATE_TRACE_S / 60, xMax: 0, yMin: 0, yMax: Math.ceil(top), xUnit: 'min', padTop: 14, yFmt: (v) => G.fmt(v, 1) + ' kW', padLeft: 64,
                series: [{ pts: tr.map(([ts, v]) => [-(now - ts) / 60000, v]), color: 'warn', fill: 0.18 }],
                empty: 'last 10 minutes: collecting...',
            });
            const hrs = 1;      // what an hour of this costs of the battery
            cv.text(G.isNum(kw) && kw > 0.05 ? 'an hour of this: ' + G.fmt(kw * hrs, 1) + ' kWh, ~' + G.fmt(kw * hrs / settings.get('designKwh') * 100, 0) + ' % of the battery' : '',
                x + 24, 484, 20, t.dim);
        }

        function renderDiag(cv, t, d) {
            G.panel(cv, t, 24, 44, 1552, 468, 'Battery unit (UDS)');
            const link = diag.p ? (diag.available ? 'link up' : 'link down') : 'no link (' + (diag.error || 'not started') + ')';
            cv.text('UDS 22 ReadDataByIdentifier  ·  ' + link + '  ·  power sign ' + cfg.powerSign + '  ·  baseline ' + G.fmt(baseline(), 2) + ' kW (' + (st.baseN || 0) + ' samples)', 48, 112, 22, t.text, { font: 'label' });
            const cols = [48, 200, 290, 380, 900, 1290];
            ['VALUE', 'ECU', 'DID', 'REPLY', 'DECODED', 'STATUS'].forEach((h, i) => cv.text(h, cols[i], 156, 20, t.dim, { font: 'bold', spacing: 1 }));
            cv.fillRect(48, 168, 1504, 1, t.tick);
            const nRows = Object.keys(Object.assign({}, cfg.fast, cfg.slow)).reduce((a, k) => a + ((cfg.fast[k] || cfg.slow[k]) || []).length, 0);
            const rowH = Math.min(36, Math.floor(270 / Math.max(1, nRows))), fz = rowH >= 30 ? 20 : 16;
            let y = 168 + Math.max(26, rowH);
            const groups = Object.assign({}, cfg.fast, cfg.slow);
            Object.keys(groups).forEach((name) => (groups[name] || []).forEach((c, i) => {
                const p = primary(c), r = reader.raws[reader.key(p)], ecu = c.ecu == null ? cfg.ecu : c.ecu;
                const used = pick[name] === i && r && r.ok;
                cv.text(name + (used ? ' *' : ''), cols[0], y, fz + 2, used ? GO : t.text, { font: 'bold' });
                cv.text('0x' + hex(ecu), cols[1], y, fz, t.text, { font: 'label' });
                cv.text(c.did, cols[2], y, fz, t.text, { font: 'label' });
                const b = r ? r.bytes || '-' : '-';
                cv.text(b.length > 46 ? b.slice(0, 45) + '…' : b, cols[3], y, fz - 2, t.dim, { font: 'label' });
                const dec = r && r.fields ? Object.keys(r.fields).map((k) => k + ' ' + (G.isNum(r.fields[k]) ? +r.fields[k].toFixed(3) : 'n/a')).join('  ')
                    : r && G.isNum(r.value) ? String(+r.value.toFixed(3)) : '-';
                cv.text(dec.length > 34 ? dec.slice(0, 33) + '…' : dec, cols[4], y, fz - 2, t.text, { font: 'label' });
                const why = r ? (r.ok ? 'OK' : r.why) : 'not read';
                cv.text(why.length > 22 ? why.slice(0, 21) + '…' : why, cols[5], y, fz - 2, r && r.ok ? GO : r ? t.warn : t.dim, { font: 'label' });
                y += rowH;
            }));
            cv.text('A value n/a or wrong? Adjust config.battery in apps/edrive2/app.json and rebuild. Regen shown while accelerating: powerSign 1.', 48, 492, 18, t.dim);
        }

        function renderScan(cv, t, d) {
            if (!scan.running && !scan.t && diag.available) runScan();
            G.panel(cv, t, 24, 44, 1552, 468, 'Scan: ' + SCAN_UNITS[scan.unit].name + ' 0x' + hex(scan.unit));
            const pct = Math.round(scan.done / scan.total * 100);
            const ago = (ms) => (ms < 90000 ? 'just now' : ms < 5400000 ? Math.round(ms / 60000) + ' min ago' : Math.round(ms / 3600000) + ' h ago');
            cv.text(scan.running ? 'SCANNING  ' + pct + ' %  (' + scan.done + ' / ' + scan.total + ')  -  stay on this page, car in READY'
                : scan.known ? scan.hits.length + ' identifiers known for this car  ·  Reset drive totals = new baseline'
                : scan.t ? 'DONE ' + ago(Date.now() - scan.t) + '  ·  ' + scan.hits.length + ' answer' + (scan.noReply >= 25 && !scan.hits.length ? ' (unit not answering)' : '') + '  ·  Reset drive totals = new baseline'
                : diag.available ? 'starting...' : 'no diagnostic link yet', 1552, 80, 20, scan.running ? t.warn : t.dim, { font: 'bold', align: 'right' });
            const cells = [], packs = [], ch = changes();
            if (scan.unit === 7) scan.hits.forEach((h) => guesses(h.bytes).forEach((g) => (g.kind === 'cell' ? cells : packs).push(h.did + '@' + g.at + ' ' + (g.kind === 'cell' ? g.value.toFixed(3) : g.value.toFixed(1)))));
            const block = (y, label, list) => {
                cv.text(label + ' (' + list.length + ')', 48, y, 20, t.dim, { font: 'bold', spacing: 1 });
                const txt = list.join('   ') || '-';
                for (let i = 0, line = 0; i < txt.length && line < 3; line++) {
                    let j = Math.min(txt.length, i + 150);
                    if (j < txt.length) { const k = txt.lastIndexOf('   ', j); if (k > i) j = k; }
                    cv.text(txt.slice(i, j).trim(), 48, y + 30 + line * 26, 18, t.text, { font: 'label' });
                    i = j;
                }
            };
            if (scan.unit === 7) {
                block(126, 'LOOK LIKE CELL VOLTAGES (V)', cells);
                block(236, 'LOOK LIKE PACK VOLTAGE (V)', packs);
            } else {
                block(126, ch ? 'CHANGED SINCE RESET ' + ago(Date.now() - cmpState.t).toUpperCase() + ' (identifier@byte before>now)  ·  live, read ' + cmpState.cycles + 'x' : 'LIVE COMPARISON: starts when the scan is done', ch || []);
                cv.text('Climate OFF, press Reset drive totals, then set HI (heater) or LO with A/C: the values that follow it show up here.', 48, 300, 18, t.dim);
            }
            cv.fillRect(48, 330, 1504, 1, t.tick);
            cv.text('ALL THAT ANSWER (identifier: bytes)', 48, 358, 20, t.dim, { font: 'bold', spacing: 1 });
            const all = scan.hits.map((h) => h.did + ':' + (h.bytes.length || (cmpState.now[h.did] || []).length)).join('  ');
            for (let i = 0, line = 0; i < all.length && line < 4; line++) {
                cv.text(all.slice(i, i + 170), 48, 388 + line * 24, 17, t.text, { font: 'label' });
                i += 170;
            }
            cv.text('Take a photo when it says DONE. Settings > Scan unit picks the unit. Replies are saved in the app\'s data folder (scan_' + hex(scan.unit) + '.json).', 48, 498, 18, t.dim);
        }

        function renderSignals(cv, t, d) {
            G.panel(cv, t, 24, 44, 1552, 468, 'Car signals');
            cv.text('speed ' + (G.isNum(live.speed) ? G.fmt(live.speed, 0) + ' km/h' : 'n/a') + '  ·  rpm ' + (G.isNum(live.rpm) ? G.fmt(live.rpm, 0) : 'n/a')
                + '  ·  climate ' + (live.climate === null ? 'n/a' : live.climate === 'ac' ? 'on (A/C)' : live.climate ? 'on' : 'off')
                + '  ·  compressor raw ' + (live.acRaw === null ? 'n/a' : live.acRaw) + ' -> ' + (G.isNum(live.acKw) ? G.fmt(live.acKw, 2) + ' kW' : 'n/a')
                + '  ·  LSC pack ' + (G.isNum(live.lscV) ? live.lscV + ' V' : 'n/a'), 48, 112, 20, t.text, { font: 'label' });
            cv.fillRect(48, 128, 1504, 1, t.tick);
            const rows = Object.keys(live.raw).sort().map((k) => [k, live.raw[k]]);
            const step = Math.min(28, Math.floor(320 / Math.max(1, rows.length)));
            let y = 158;
            rows.forEach(([k, v]) => {
                if (y > 470) return;
                cv.text(k, 48, y, 18, t.dim, { font: 'bold' });
                cv.text(v.length > 160 ? v.slice(0, 159) + '…' : v, 230, y, 17, t.text, { font: 'label' });
                y += step;
            });
            if (!rows.length) cv.text('nothing received yet', 800, 300, 24, t.dim, { align: 'center' });
            cv.text('Raw values as the car sends them - for checking the scalings (config.scaling in app.json).', 48, 498, 18, t.dim);
        }

        function render() {
            lastDrawT = Date.now();
            const t = ctx.theme(), d = data();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const pg = pages();
            if (page >= pg.length) page = 0;
            ({ power: renderPower, battery: renderBattery, cells: renderCells, climate: renderClimate, diag: renderDiag, scan: renderScan, signals: renderSignals })[pg[page]](cv, t, d);
            G.frame(cv, t, pg.map((p) => NAMES[p]), page, [d.demo && { text: 'DEMO' }]);
            return ui.image('MAIN_GFX', cv);
        }

        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
