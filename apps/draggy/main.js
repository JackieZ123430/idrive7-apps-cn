'use strict';
/**
 * Drag Timer - a performance meter drawn in the HMI's style.
 *
 *   Standing:  stop the car -> READY. Launch -> the clock starts on the first movement (or after one foot with
 *              "one-foot rollout"). 0-50 / 0-100 / 100-200 / 0-200 km/h (0-30 / 0-60 / 60-130 / 0-100 mph), 1/8 and 1/4 mile
 *              (and 1000 m or 1/2 mile), trap speeds at the distances. The run ends when you lift (speed drops
 *              5 km/h below the run's top speed) or every split is done.
 *   Rolling:   100-200, 200-250 km/h (60-130, 130-160 mph), and with its setting 250-300 km/h (160-190 mph), as
 *              Dragy times 100-200 / 60-130: whenever the car accelerates through the window, from a roll or within a
 *              standing launch (roll_timer.js).
 *   Custom:    one more window of your own (settings): standing from 0, else rolling.
 *   Slope:     every result carries the road's slope under it (slope.js, from the car's acceleration sensor and
 *              speed); one that went downhill steeper than the limit (2 % by default) is marked DOWNHILL and sets
 *              no best time.
 *   Valid:     as Dragy's: a run whose slope stays within the limit either way, without rollout, is VALID (tab bar,
 *              History); else INVALID with the reason (SLOPE, NO SLOPE, ROLLOUT). No limit set: not judged.
 *   Air:       the outside temperature (EnvironmentalInformation) and pressure (OBD PID 0x33 from the engine unit, at
 *              most every 5 min and never during a run) with each run, its density altitude, and with the setting
 *              "corrected" every time corrected to standard air, SAE J1349 (weather.js), with best times of its own.
 *   Details:   each run's top speed, the height it climbed or dropped, and its upshifts (shifts.js: the gear signal,
 *              else the rpm), marked on the trace and listed in History.
 *
 * Pages: standing  /  rolling  /  best times  /  history (saved in data/draggy_runs.json)
 * Speed: Vehicle2.statusCarSpeed2 (centre-of-gravity speed, BMW scaling). Splits are interpolated between samples.
 * Wheelspin: an estimate for the first seconds after the launch (wheelspin.js), from the speed and CDS2's acceleration.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { RunTimer } = require('./kit/run_timer');
const Demo = require('./demo');
const { Wheelspin } = require('./wheelspin');
const { RollTimer } = require('./roll_timer');
const { Slope } = require('./slope');
const Weather = require('./weather');
const { ShiftLog } = require('./shifts');
const Car = require('./kit/car');
const { Diag } = require('./kit/diag');
const { DidReader } = require('./kit/dids');
const { t: tr } = require('./kit/i18n');

const W = 1600, H = 520;
const MPH = 1.609344, G0 = 9.80665;
const GO = '#2fd27a';

const sp = (from, to, unit) => ({ key: from + '-' + to + (unit === 'mph' ? 'mph' : ''), label: from + '-' + to + ' ' + (unit === 'mph' ? 'mph' : 'km/h'),
    from: unit === 'mph' ? from * MPH : from, to: unit === 'mph' ? to * MPH : to });
const STAND = {
    kmh: [sp(0, 50), sp(0, 100), sp(100, 200), sp(0, 200)],
    mph: [sp(0, 30, 'mph'), sp(0, 60, 'mph'), sp(60, 130, 'mph'), sp(0, 100, 'mph')],
};
const ROLL = {
    kmh: [sp(100, 200), sp(200, 250)],
    mph: [sp(60, 130, 'mph'), sp(130, 160, 'mph')],
};
// the top window, only with its setting on (off by default)
const ROLL_HIGH = { kmh: [sp(250, 300)], mph: [sp(160, 190, 'mph')] };
const D = {
    ft60: { key: 'ft60', label: '60 ft', dist: 18.288 },        // (no split any more: names it in older runs)
    em: { key: 'em', label: '1/8 mile', dist: 201.168 },
    qm: { key: 'qm', label: '1/4 mile', dist: 402.336 },
    m1000: { key: 'm1000', label: '1000 m', dist: 1000 },
    hm: { key: 'hm', label: '1/2 mile', dist: 804.672 },
};

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const S = (ctx.spec.config && ctx.spec.config.scaling) || {};
        const sc = (k, raw) => {
            const c = S[k];
            if (!c || raw === undefined || raw === null || raw === c.invalid) return null;
            return raw * c.factor + (c.offset || 0);
        };

        /* ---------- what is timed ---------- */
        const unit = () => (settings.get('speedUnit') === 'mph' ? 'mph' : 'kmh');
        const custom = () => {
            const f = Number(settings.get('customFrom')), to = Number(settings.get('customTo'));
            if (!settings.get('custom') || !isFinite(f) || !isFinite(to) || f < 0 || to <= f) return null;
            return Object.assign(sp(f, to, unit()), { custom: true });
        };
        // the custom window joins the standing splits (from 0) or the rolling ones, unless it is one of them already
        const withCustom = (list, standing) => { const c = custom(); return c && !c.from === standing && !list.some((x) => x.key === c.key) ? list.concat([c]) : list; };
        const standSplits = () => {
            const far = D[settings.get('distance')];
            return withCustom(STAND[unit()], true).concat([D.em, D.qm], far && far.dist > D.qm.dist ? [far] : []);
        };
        const rollWindows = () => withCustom(ROLL[unit()].concat(settings.get('highSpeed') ? ROLL_HIGH[unit()] : []), false);
        const limit = () => { const l = Number(settings.get('slopeLimit')); return l > 0 ? l : null; };
        // a run that went downhill steeper than the limit: shown, marked, no best
        const downhill = (pct) => limit() !== null && typeof pct === 'number' && pct < -limit();
        /** Dragy's verdict on a run: { ok, why } (why: 'ROLLOUT', 'NO SLOPE', 'SLOPE'), null with no limit set. */
        const verdict = (pct, rollout) => {
            if (rollout) return { ok: false, why: 'ROLLOUT' };
            if (limit() === null) return null;
            if (typeof pct !== 'number' || !isFinite(pct)) return { ok: false, why: 'NO SLOPE' };
            return Math.abs(pct) > limit() ? { ok: false, why: 'SLOPE' } : { ok: true };
        };
        // air: 'show' (with each run), 'sae' (and every time corrected to standard air), 'off'
        const airMode = () => (['show', 'sae', 'off'].indexOf(settings.get('air')) >= 0 ? settings.get('air') : 'show');
        const saeOn = () => airMode() === 'sae';
        const isDist = (k) => !!(D[k] || (standSplits().find((x) => x.key === k) || {}).dist);

        /* ---------- saved runs ---------- */
        const FILE = path.join(ctx.dataDir, 'draggy_runs.json');
        let saved = { best: {}, bestStd: {}, runs: [] };
        try { saved = Object.assign(saved, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (e) { /* first start */ }
        if (!saved.bestStd || typeof saved.bestStd !== 'object') saved.bestStd = {};
        // A split from speed (100-200, 60-130 mph, a custom one from above 0) times the same with or without rollout (its
        // clock starts at its own start speed), standing or rolling: one best time, '<key>'. 2.6.0 kept a standing one
        // with rollout on as '<key>@ro': moved to '<key>' (where it is the faster one).
        const fromSpeed = (k) => /^[1-9]\d*-\d+(mph)?$/.test(k);
        [saved.best, saved.bestStd].forEach((bs) => Object.keys(bs).forEach((k) => {
            const base = k.replace(/@ro$/, '');
            if (base === k || !fromSpeed(base)) return;
            if (!bs[base] || bs[k].s < bs[base].s) bs[base] = bs[k];
            delete bs[k];
        }));
        const demoStore = { best: {}, bestStd: {}, runs: [] };          // demo runs are shown but never saved
        let store = saved;
        const save = () => { if (store !== saved) return; try { fs.writeFileSync(FILE, JSON.stringify(saved)); } catch (e) { log.warn('save runs: ' + e); } };
        // rollout counts only for splits from a standstill (0-x, distances); rolling windows start at speed anyway
        const bestKey = (k, roll, ro) => k + (!roll && !fromSpeed(k) && (ro === undefined ? settings.get('rollout') : ro) ? '@ro' : '');

        /**
         * A finished run's results into the best times: as measured (best) and, where the run has its air, corrected to
         * standard air (bestStd). Returns { raw: { key: true }, std: { key: true } } for the new ones.
         */
        function keepBest(run, roll) {
            const nb = { raw: {}, std: {} }, cf = run.air && run.air.cf;
            Object.keys(run.result).forEach((k) => {
                if (downhill(run.slope[k])) return;
                const bk = bestKey(k, roll, run.rollout), b = store.best[bk], trap = run.trap && run.trap[k];
                // (the same pull timed twice: a launch's 100-200 is a standing split and a rolling window. The one
                // counted second, the same time a moment later, is that new best too)
                const same = (x, v) => x && Math.abs(v - x.s) < 1e-6 && Math.abs(run.at - x.at) < 60000;
                if (!b || run.result[k] < b.s) {
                    store.best[bk] = { s: run.result[k], at: run.at, trap, slope: run.slope[k] };
                    nb.raw[k] = true;
                } else if (same(b, run.result[k])) nb.raw[k] = true;
                const st = Weather.correctTime(run.result[k], cf, isDist(k)), bs = store.bestStd[bk];
                if (st !== null && (!bs || st < bs.s)) {
                    store.bestStd[bk] = { s: st, at: run.at, trap: Weather.correctTrap(trap, cf), slope: run.slope[k], cf };
                    nb.std[k] = true;
                } else if (st !== null && same(bs, st)) nb.std[k] = true;
            });
            return nb;
        }
        const bests = () => (saeOn() ? store.bestStd : store.best);
        function keepRun(run) {
            store.runs.unshift(Object.assign({ unit: unit() }, run));
            store.runs = store.runs.slice(0, 40);
            save();
        }

        /* ---------- timers ---------- */
        const slope = new Slope();
        const spin = new Wheelspin();
        const shifts = new ShiftLog();
        let lastNewBest = { raw: {}, std: {} }, rollNewBest = { raw: {}, std: {} }, standSlope = {}, rollSlope = {};
        // the last finished run of each kind (its verdict, air, details), and the air of each rolling window's time
        let standRec = null, rollRec = null, rollAir = {}, rollInLaunch = false;
        const shiftsOut = (list, t0) => list.map((x) => ({ t: Math.round((x.t - t0) / 10) / 100, from: x.from, to: x.to, rpm: x.rpm, kmh: x.kmh }));
        /** The slope under a standing split just timed: from the launch (speed splits from 0, distances) or its start speed. */
        const standSlopeOf = (s) => {
            if (timer.result[s.key] === undefined || timer.t0 === null) return undefined;
            const t0 = timer.t0, tl = timer.tLaunch !== undefined ? timer.tLaunch : t0;
            return slope.over(s.from ? t0 + timer.cross[s.from] * 1000 : tl, standEnd(s));
        };
        /** when a standing split was done (ms) */
        const standEnd = (s) => timer.t0 + (s.dist ? timer.cross['d' + s.dist] : timer.cross[s.to]) * 1000;
        const rollSlopeOf = (k) => (roll.start[k] !== undefined ? slope.over(roll.start[k], roll.end[k]) : undefined);
        const onDone = (r) => {
            const sl = {}, tl = timer.tLaunch !== undefined ? timer.tLaunch : timer.t0, tEnd = timer.t0 + (timer.endAt || 0) * 1000;
            const done = standSplits().filter((s) => r.result[s.key] !== undefined);
            done.forEach((s) => { sl[s.key] = standSlopeOf(s); });
            // the run's own slope and height: from the launch to its last split (not the lift after it)
            const tLast = Math.max.apply(null, done.map(standEnd)), all = slope.over(tl, tLast);
            const run = Object.assign({ kind: 'stand', slope: sl, slopeAll: all, valid: verdict(all, r.rollout), air: airNow(),
                top: r.vmax, height: slope.height(tl, tLast), shifts: shiftsOut(shifts.between(tl, tEnd, null), timer.t0) }, r);
            if (!feedDemo) run.spin = spin.result();
            standSlope = sl; standRec = run;
            lastNewBest = keepBest(run, false);
            keepRun(run);
            log.info('run done ' + JSON.stringify(run.result) + ' slope ' + JSON.stringify(sl) + ' (standing reading ' + slope.at(tl) + ' %, run ' + all
                + ' %) ' + JSON.stringify({ valid: run.valid, air: run.air, top: run.top, height: run.height, shifts: run.shifts }));
        };
        const onRoll = (r) => {
            const sl = {}, keys = Object.keys(r.result), tEnd = r.t0 + (roll.endAt || 0) * 1000;
            keys.forEach((k) => { sl[k] = rollSlopeOf(k); });
            const t1 = Math.min.apply(null, keys.map((k) => r.start[k])), t2 = Math.max.apply(null, keys.map((k) => r.end[k]));
            const all = slope.over(t1, t2), a = airNow();
            const run = { kind: 'roll', at: r.at, result: r.result, slope: sl, vmax: r.vmax, slopeAll: all, valid: verdict(all, false), air: a,
                top: r.vmax, height: slope.height(t1, t2), shifts: shiftsOut(shifts.between(r.t0, tEnd, null), r.t0) };
            rollSlope = Object.assign({}, rollSlope, sl); rollRec = run;
            keys.forEach((k) => { rollAir[k] = a; });
            rollNewBest = keepBest(run, true);
            // a pull within a standing launch (its 100-200 is a standing split too): History lists only the windows the
            // launch doesn't time (200-250 ...), and nothing when there are none
            if (rollInLaunch) {
                const own = keys.filter((k) => !standSplits().some((x) => x.key === k));
                if (own.length) {
                    const pick = (o) => { const x = {}; own.forEach((k) => { x[k] = o[k]; }); return x; };
                    keepRun(Object.assign({}, run, { result: pick(run.result), slope: pick(run.slope), launch: true }));
                }
            } else keepRun(run);
            log.info('rolling done ' + JSON.stringify(run.result) + ' slope ' + JSON.stringify(sl) + ' (pull ' + all + ' %) '
                + JSON.stringify({ valid: run.valid, air: run.air, top: run.top, height: run.height, shifts: run.shifts }));
        };
        let timer, roll;
        const newTimer = () => {
            store = feedDemo ? demoStore : saved;
            // a new launch: its own peak, and its splits compared with the best (not run 1's NEW BEST)
            timer = new RunTimer(standSplits(), { rollout: settings.get('rollout'), onDone,
                onLaunch: () => { peakG = 0; lastNewBest = { raw: {}, std: {} }; standSlope = {}; standRec = null; spin.launch(Date.now()); } });
            roll = new RollTimer(rollWindows(), { onDone: onRoll, onStart: () => { rollPeak = 0; rollInLaunch = timer.state === 'run'; } });
            lastNewBest = { raw: {}, std: {} }; rollNewBest = { raw: {}, std: {} }; standSlope = {}; rollSlope = {};
            standRec = null; rollRec = null; rollAir = {};
        };

        /* ---------- live data ---------- */
        const live = { speed: null, g: null, rpm: null };
        let lastCar = 0, feedDemo = false, peakG = 0, rollPeak = 0, speedSub = null;
        const demo = new Demo(), t0 = Date.now();
        // Auto: demo only until the car answers. A parked car sends no new speed for minutes; going by
        // "no speed for 5 s" switched to demo runs while standing (and back on the first real sample).
        const carPresent = () => lastCar > 0 || !!(speedSub && speedSub.available);
        const usingDemo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !carPresent() && Date.now() - t0 > 5000);
        newTimer();
        const feedSpeed = (t, kmh) => { slope.speed(t, kmh); shifts.speed(t, kmh); timer.feed(t, kmh); roll.feed(t, kmh); };
        const peaks = (g) => {
            if (timer.state === 'run') peakG = Math.max(peakG, g);
            if (roll.state === 'run') rollPeak = Math.max(rollPeak, g);
        };

        ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusCarSpeed2: (v) => {
                const kmh = sc('speed', v.speedVehicleCentreOfGravity);
                if (kmh === null) return;
                lastCar = Date.now(); live.speed = kmh;
                spin.speed(lastCar, kmh);
                if (!feedDemo) feedSpeed(lastCar, kmh);
            },
        }, log).then((s) => { speedSub = s; log.info('speed signal ' + (s.error ? 'error ' + s.error : 'subscribed')); return s; });
        ctx.signals.watch('de.bmw.infotainment.vehicle.CDS2', '1', {
            statusLongitudinalAccelerationMassCenter: (v) => {
                const a = sc('accel', v.longitudinalAccelerationCentreOfGravity);
                if (a === null) return;
                live.g = a / G0;
                spin.accel(Date.now(), a);
                if (!feedDemo) { slope.accel(Date.now(), a); peaks(live.g); }
            },
        }, log);
        ctx.signals.watch('de.bmw.infotainment.vehicle.CDS', '1', {
            statusEngineSpeed2: (v) => {
                live.rpm = sc('rpm', v.actualValueRPMEngineCrankshaft);
                if (!feedDemo && live.rpm !== null) shifts.rpm(Date.now(), live.rpm);
            },
        }, log);
        // the engaged gear (as kit/car.js reads it): the upshifts of a run
        ctx.signals.watch('de.bmw.infrastructure.VehicleInformation', '1', {
            statusGearboxDrive: (v) => { const g = Car.gearOf(v && v.statusActualGearDrive); if (g !== undefined && !feedDemo) shifts.gear(Date.now(), g); },
            DataPowerTrain2: (v) => { const sel = Car.selectionOf(v && v.statusGearSelectionDrive); if (sel && !feedDemo) shifts.gear(Date.now(), sel.gear); },
        }, log);

        /* ---------- the outside air ---------- */
        const air = { c: null, cT: 0, kPa: null, pT: 0 };
        ctx.signals.watch('de.bmw.infrastructure.EnvironmentalInformation', '1', {
            // 0.5 deg C per bit from -40, 255 = no value (as Car Vitals, Live Data, Redline)
            ExteriorTemperature: (v) => { const raw = v && v.temperatureExterior; if (typeof raw === 'number' && raw !== 255) { air.c = raw * 0.5 - 40; air.cT = Date.now(); } },
        }, log);
        /** The air now ({ c, kPa, da, cf }, parts null when not known lately), null with the setting off. */
        const airNow = () => {
            if (airMode() === 'off') return null;
            if (feedDemo) return Weather.air(demo.temp(), demo.kPa());
            // (the temperature is sent on change only: steady weather sends nothing for hours, the last one holds; the
            // pressure is asked every 5 min, an answer older than an hour no longer counts)
            const fresh = (t, ms) => t > 0 && Date.now() - t < ms;
            const a = Weather.air(air.cT > 0 ? air.c : null, fresh(air.pT, 60 * 60000) ? air.kPa : null);
            return a.c === null && a.kPa === null ? null : a;
        };
        // the pressure from the engine unit (OBD PID 0x33, as Car Vitals): a while after the start, then every 5 min (15 after
        // 3 failures in a row); never during a run or while the car speeds up (a pull may be about to start a run), and not at
        // all with the setting off. The link opens on the first read.
        const baroCfg = (ctx.spec.config && ctx.spec.config.baro) || [];
        const baroEcu = (ctx.spec.config && ctx.spec.config.baroEcu) || 18;
        let link = null, rd = null, baroBusy = false, baroFails = 0, baroNext = Date.now() + 15000;
        async function readBaro() {
            if (airMode() === 'off' || feedDemo || baroBusy || Date.now() < baroNext || !baroCfg.length) return;
            if (timer.state === 'run' || roll.state === 'run' || (G.isNum(live.g) && live.g > 0.15)) return;
            baroBusy = true;
            try {
                if (!link) { link = new Diag(ctx.signals, log); link.quiet = true; link.busyLog = false; await link.init(); rd = new DidReader(link, { ecu: baroEcu }); }
                const b = await rd.value('baro', baroCfg);
                if (b !== null) {
                    if (air.kPa === null || Math.abs(b - air.kPa) >= 0.5) log.info('outside air pressure ' + b + ' kPa');
                    air.kPa = b; air.pT = Date.now(); baroFails = 0; baroNext = Date.now() + 5 * 60000;
                } else {
                    baroFails++; baroNext = Date.now() + (baroFails >= 3 ? 15 : 1) * 60000;
                    if (baroFails === 3) log.info('outside air pressure: no answer from the engine unit (' + JSON.stringify(rd.raws) + ')');
                }
            } catch (e) {
                baroFails++; baroNext = Date.now() + 15 * 60000; log.warn('outside air pressure: ' + e);
            } finally { baroBusy = false; }
        }
        setInterval(() => { readBaro(); }, 5000);

        // demo feed at 20 Hz; switching source starts a clean run

        setInterval(() => {
            const d = usingDemo();
            if (d !== feedDemo) { feedDemo = d; newTimer(); log.info(d ? 'demo data on' : 'live speed'); }
            const now = Date.now();
            if (!feedDemo) { timer.idle(now); roll.idle(now); return; }
            // (by the clock: the interval runs late when the machine is busy)
            // (the acceleration at this moment, as a sensor reads it: the speed's slope around now, not over the last tick)
            const v = demo.speed(now), a = (demo.speed(now + 25) - demo.speed(now - 25)) / 3.6 / 0.05;
            live.g = a / G0;
            live.speed = v; live.rpm = demo.rpm(now);
            shifts.gear(now, demo.gear(now)); shifts.rpm(now, live.rpm);
            feedSpeed(now, v);
            slope.accel(now, a + G0 * demo.slope(now) / 100);      // the sensor also reads the demo road's slope
            peaks(live.g);
            timer.idle(now); roll.idle(now);
        }, 50);

        /* ---------- units / format ---------- */
        const mph = () => unit() === 'mph';
        const V = (k) => (k == null ? null : mph() ? k / MPH : k);
        const vU = () => (mph() ? 'mph' : 'km/h');
        const secs = (s) => (G.isNum(s) ? s.toFixed(2) : '--.--');
        const pctS = (p) => (G.isNum(p) ? (p > 0 ? '+' : '') + p.toFixed(1) + ' %' : '--');
        const when = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '. ' + p(d.getHours()) + ':' + p(d.getMinutes()); };
        /** text sized down (from size) to fit w px */
        const fit = (cv, s, w, size, opt) => { const tw = cv.textWidth(s, size, opt); return tw > w ? Math.max(12, Math.floor(size * w / tw)) : size; };
        // heights in m (ft with mph), the air: deg C, hPa, density altitude
        const FT = 0.3048;
        const hU = (m) => (G.isNum(m) ? (m > 0 ? '+' : m < 0 ? '-' : '') + (mph() ? Math.round(Math.abs(m) / FT) + ' ft' : Math.abs(m).toFixed(1) + ' m') : null);
        const daU = (m) => (G.isNum(m) ? (mph() ? Math.round(m / FT / 10) * 10 + ' ft' : Math.round(m / 10) * 10 + ' m') : null);
        /** the air of a run as [label, value] pieces (none when unknown) */
        const airPieces = (a) => (!a ? [] : [].concat(G.isNum(a.c) ? [[null, Math.round(a.c) + ' °C']] : [], G.isNum(a.kPa) ? [[null, Math.round(a.kPa * 10) + ' hPa']] : [],
            G.isNum(a.da) ? [['DA', daU(a.da)]] : []));
        /** a run's details as [label, value] pieces: top speed, height, shifts (count) */
        const detailPieces = (top, height, nShifts) => [].concat(G.isNum(top) && top > 0 ? [['TOP SPEED', Math.round(V(top)) + ' ' + vU()]] : [],
            G.isNum(height) ? [['ELEVATION', hU(height)]] : [], G.isNum(nShifts) ? [['SHIFTS', String(nShifts)]] : []);
        /**
         * One line of [label, value] pieces from x (align 'left') or to x ('right'), sized down to fit w: labels dim,
         * values in the text colour. Each label and value is drawn (and translated) on its own.
         */
        function pieces(cv, t, list, x, y, w, size, align) {
            if (!list.length) return;
            // labels in capitals in every language (a catalog's "Top speed" keeps its own case otherwise); drawn as they are
            list = list.map(([l, v]) => [l ? tr(l).toUpperCase() : l, v]);
            const lo = { font: 'bold', spacing: 1, literal: true }, vo = { font: 'label' }, gap = 8, sep = 22;
            const width = (k) => list.reduce((a, [l, v]) => a + (l ? cv.textWidth(l, k, lo) + gap : 0) + cv.textWidth(v, k, vo) + sep, -sep);
            let k = size;
            while (k > 12 && width(k) > w) k--;
            let px = align === 'right' ? x - width(k) : x;
            list.forEach(([l, v]) => {
                if (l) { cv.text(l, px, y, k, t.dim, lo); px += cv.textWidth(l, k, lo) + gap; }
                cv.text(v, px, y, k, t.text, vo); px += cv.textWidth(v, k, vo) + sep;
            });
        }
        /** a verdict's text and colour */
        const verdictOf = (vd, t) => (!vd ? null : vd.ok ? ['VALID RUN', GO] : ['INVALID RUN · ' + vd.why, t.warn]);
        /**
         * A badge as the tab bar's (gauges.js badgeRow), right-aligned at xr, height h from y; returns its left edge.
         * (Not in the tab bar itself: in the standard layout its right end holds the translation credit.)
         */
        function pill(cv, xr, y, h, size, text, color) {
            const o = { align: 'center', font: 'bold', spacing: 1.5 }, w = Math.max(h * 3.5, cv.textWidth(text, size, o) + h);
            cv.roundRect(xr - w, y, w, h, h * 0.2, withAlpha(color, 0.2));
            cv.text(text, xr - w / 2, y + h / 2 + size * 0.36, size, color, o);
            return xr - w;
        }

        /* ---------- drawing ---------- */
        // (names that are no part of other apps' texts: the catalogs translate phrases inside longer texts too)
        const PAGES = ['Standing launch', 'Rolling start', 'Best times', 'History'];
        let page = 0, liveShifts = null;
        const STATE = {
            wait: ['STOP TO ARM', 'dim'], ready: ['READY - LAUNCH', 'go'], run: ['TIMING', 'accent'], done: ['FINISHED', 'text'],
        };

        /** G20-style frame: tab bar with the page names along the top. */
        function header(cv, t) {
            G.frame(cv, t, PAGES, page, [feedDemo && { text: 'DEMO' }, page !== 1 && settings.get('rollout') && { text: 'ROLLOUT 1 FT', color: 'dim' }]);
        }

        /** The slope to show now: where the car stands, or over the run so far. */
        function slopeNow(rolling, now) {
            const st = slope.standing();
            if (st !== null) return st;
            if (rolling) return roll.state === 'run' ? slope.over(roll.t0, now) : null;
            return timer.state === 'run' && timer.tLaunch !== undefined ? slope.over(timer.tLaunch, now) : null;
        }

        /** Standing (page 0) or rolling (page 1): speed and clock, the trace, the results table. */
        function drawRun(cv, t, rolling) {
            const now = Date.now();
            let stTxt, col, el, endAt, running;
            if (rolling) {
                running = roll.state === 'run';
                const nx = roll.next(live.speed);
                stTxt = running ? 'TIMING' : nx !== null ? 'ACCELERATE PAST ' + Math.round(V(nx)) : 'SLOW DOWN TO ARM';
                col = running ? t.accent : nx !== null ? GO : t.dim;
                el = roll.elapsed(now); endAt = roll.endAt;
            } else {
                const [s, c] = STATE[timer.state];
                stTxt = s; col = c === 'go' ? GO : t[c];
                running = timer.state === 'run';
                el = timer.elapsed(now); endAt = timer.endAt;
            }
            // --- speed + clock ---
            // ex: how much lower the panels reach where the screen has room below the page (else 0)
            const sh = G.panel(cv, t, 24, 44, 400, 468, 'Speed'), ex = sh.y + sh.h - G.BOTTOM, mid = Math.round(ex / 2);
            if (G.isNum(live.rpm)) cv.text(Math.round(live.rpm) + ' rpm', 404, 80, 20, t.dim, { align: 'right', font: 'bold', spacing: 1 });
            // the air of the run shown (or now): clear of the speed's digits below it
            const rec = rolling ? rollRec : standRec, recShown = rec && !running ? rec : null;
            if (airMode() !== 'off') pieces(cv, t, airPieces(recShown ? recShown.air : airNow()), 404, 108, 340, 18, 'right');
            const v = V(G.hold('speed', live.speed, 1000 / settings.get('speedRate')));   // setting: 10/s by default, 5 like the cluster .. 60
            cv.text(G.fmt(v, 0), 336, 227, 150, G.isNum(v) ? t.text : t.dim, { align: 'right', font: 'num' });
            cv.text(vU(), 348, 227, 28, t.dim);
            cv.fillRect(44, 255, 360, 2, t.panelEdge);
            // the bottom line ends G.MARGIN over the panel's bottom, as the other panels' last lines (eb); the clock
            // and state go halfway down the room and up as far as the bottom line (es)
            const eb = G.toMargin(ex, 8), es = mid + eb - ex;
            cv.text(secs(el), 316, 384 + es, 96, running ? t.text : endAt !== undefined ? t.accent2 : t.dim, { align: 'right', font: 'num' });
            cv.text('s', 328, 384 + es, 32, t.dim);
            cv.roundRect(44, 412 + es, 360, 44, 8, withAlpha(col, 0.18));
            if (!rolling && timer.state === 'ready') cv.roundRect(44, 412 + es, 360, 44, 8, withAlpha(GO, 0.35 + 0.25 * Math.sin(now / 160)));
            const so = { align: 'center', font: 'bold', spacing: 3 };
            cv.text(stTxt, 224, 446 + es, fit(cv, stTxt, 340, 26, so), col, so);
            const pk = rolling ? rollPeak : peakG;
            cv.text('PEAK ' + (pk > 0 ? pk.toFixed(2) : '-.--') + ' g', 44, 493 + eb, 22, t.dim, { font: 'bold', spacing: 1 });
            G.button(cv, t, 264, 466 + eb, 140, 38, 'Reset run', act, { key: 'reset', confirm: true });

            // --- speed trace ---
            G.panel(cv, t, 448, 44, 512, 468, 'Speed trace');
            // slope (where the car stands, or under the run), and the launch's wheelspin (an estimate)
            const ws = !rolling && (timer.state === 'run' || endAt !== undefined) ? (feedDemo ? null : spin.result()) : null;
            const sn = slopeNow(rolling, now), tags = [];
            if (G.isNum(sn)) tags.push(['SLOPE ' + pctS(sn), downhill(sn) ? t.warn : t.dim]);
            const to = { align: 'right', font: 'bold', spacing: 1 }, wide = () => tags.reduce((a, x) => a + cv.textWidth(x[0], 20, to) + 24, -24);
            // clear of the panel's title (it ends near x 605): shorter words where both don't fit
            for (const word of ['WHEELSPIN', 'SPIN', 'SPIN ']) {
                if (!ws) break;
                tags[G.isNum(sn) ? 1 : 0] = [word.trim() + ' ~' + ws.peak + ' %' + (ws.secs && word !== 'SPIN ' ? ', ' + ws.secs.toFixed(1) + ' s' : ''), ws.peak >= 10 ? t.warn : t.dim];
                if (936 - wide() >= 620) break;
            }
            let tx = 936;
            for (let i = tags.length - 1; i >= 0; i--) {
                cv.text(tags[i][0], tx, 80, 20, tags[i][1], to);
                tx -= cv.textWidth(tags[i][0], 20, to) + 24;
            }
            // the run's details: the finished one's, or so far (shifts worked out at most every 250 ms)
            const src = rolling ? roll : timer, tr = src.trace;
            const tStart = rolling ? roll.t0 : timer.tLaunch !== undefined ? timer.tLaunch : timer.t0;
            let det = null;
            if (recShown) det = { top: recShown.top, height: recShown.height, shifts: recShown.shifts || [] };
            else if (running && tStart !== null && tStart !== undefined) {
                const key = (rolling ? 'r' : 's') + tStart + ':' + Math.floor(now / 250);
                if (!liveShifts || liveShifts.key !== key) liveShifts = { key, list: shiftsOut(shifts.between(tStart, now, null), rolling ? roll.t0 : timer.t0) };
                det = { top: src.vmax, height: slope.height(tStart, now), shifts: liveShifts.list };
            }
            if (det) pieces(cv, t, detailPieces(det.top, det.height, det.shifts.length), 468, 108, 468, 18, 'left');
            const px = 520, py = 128, pw = 416, ph = 327 + G.toMargin(ex, 31);      // the trace takes the room (its labels G.MARGIN over the bottom)
            const tMax = Math.max(6, Math.ceil(tr.length ? tr[tr.length - 1][0] / 2 + 0.5 : 0) * 2);
            const vMax = Math.max(mph() ? 80 : 120, Math.ceil(((V(src.vmax) || 0) + 5) / 40) * 40);
            const X = (s) => px + (s / tMax) * pw, Y = (vv) => py + ph - (vv / vMax) * ph;
            for (let i = 0; i <= 4; i++) {
                const yy = py + (i / 4) * ph;
                cv.fillRect(px, yy, pw, 1, withAlpha(t.tick, 0.35));
                cv.text(String(Math.round(vMax * (1 - i / 4))), px - 10, yy + 8, 20, t.dim, { align: 'right' });
            }
            const step = tMax > 30 ? 10 : tMax > 12 ? 4 : 2;
            for (let s = 0; s <= tMax; s += step) cv.text(s + 's', X(s), py + ph + 26, 20, t.dim, { align: 'center' });
            const dot = (x, y) => { cv.circle(x, y, 7, t.text); cv.circle(x, y, 4, t.accent); };
            if (tr.length > 1) {
                const pts = tr.map(([s, vv]) => [X(s), Y(V(vv))]);
                cv.fillUnder(pts, py + ph, withAlpha(t.accent, 0.16));
                cv.polyline(pts, 3, t.accent);
                // the upshifts: a tick over the trace, the new gear above it
                (det ? det.shifts : []).forEach((x) => {
                    if (!G.isNum(x.t) || !G.isNum(x.kmh) || x.t < 0 || x.t > tMax) return;
                    const sx = X(x.t), sy = Y(V(x.kmh));
                    cv.fillRect(sx - 1, sy - 22, 2, 14, t.dim);
                    if (G.isNum(x.to)) cv.text(String(x.to), sx, sy - 28, 18, t.dim, { align: 'center', font: 'bold' });
                });
                if (rolling) {
                    Object.keys(roll.pull).forEach((k) => {
                        const w = rollWindows().find((x) => x.key === k);
                        if (w) dot(X((roll.end[k] - roll.t0) / 1000), Y(V(w.to)));
                    });
                } else {
                    standSplits().forEach((s) => {
                        if (s.dist || timer.cross[s.to] === undefined) return;
                        dot(X(timer.cross[s.to]), Y(V(s.to)));
                    });
                }
            } else {
                const msg = rolling ? 'Accelerate through a window' : timer.state === 'ready' ? 'Launch when ready' : 'Come to a stop to arm';
                cv.text(msg, px + pw / 2, py + ph / 2, 26, t.dim, { align: 'center' });
            }

            // --- results ---
            const rows = rolling ? rollWindows() : standSplits();
            const res = rolling ? roll.result : timer.result, nb = (rolling ? rollNewBest : lastNewBest)[saeOn() ? 'std' : 'raw'];
            // corrected to standard air: each result with the air of its time (a rolling window: when it was timed)
            const sae = saeOn(), cfOf = (k) => {
                const a = rolling ? (roll.state === 'run' && roll.pull[k] ? airNow() : rollAir[k]) : standRec ? standRec.air : airNow();
                return a && G.isNum(a.cf) ? a.cf : null;
            };
            // the slopes kept with the finished results, or worked out for the ones just timed
            const sl = {};
            rows.forEach((s) => {
                // (a window timed again in the pull under way: its new slope, not the one kept from the last pull)
                const kept = rolling && roll.state === 'run' && roll.pull[s.key] ? undefined : (rolling ? rollSlope : standSlope)[s.key];
                sl[s.key] = kept !== undefined ? kept : rolling ? rollSlopeOf(s.key) : standSlopeOf(s);
            });
            G.panel(cv, t, 984, 44, 592, 468, (rolling ? 'Rolling windows' : 'Splits') + (sae ? ' (SAE)' : ''));
            // the shown run's verdict (Dragy's VALID), right on the title line; a custom window set the wrong way round
            // is left out: said left of it
            let titleR = 1556;
            const vt = recShown && verdictOf(recShown.valid, t);
            if (vt) titleR = pill(cv, 1556, 64, 28, 17, vt[0], vt[1]) - 12;
            if (settings.get('custom') && !custom()) {
                const msg = 'CUSTOM: "TO" MUST BE ABOVE "FROM"', mo = { align: 'right', font: 'bold', spacing: 1 };
                cv.text(msg, titleR, 80, fit(cv, msg, titleR - 1226, 18, mo), t.warn, mo);
            }
            const cols = rolling ? [['TIME', 1250], ['SLOPE', 1380], ['VS BEST', 1556]] : [['TIME', 1215], ['TRAP', 1315], ['SLOPE', 1405], ['VS BEST', 1556]];
            // each column's room: from the one before it (12 px apart); headers and cells sized down to it (translations)
            const room = cols.map((c, i) => c[1] - (i ? cols[i - 1][1] : 1140) - 12);
            const ho = { align: 'right', font: 'bold', spacing: 1 }, lo = { align: 'right', font: 'label' };
            cols.forEach(([h, x], i) => cv.text(h, x, 112, fit(cv, h, room[i], 18, ho), t.dim, ho));
            const top = 124, rh = Math.min(62, (G.toMargin(ex, 0) + 512 - 14 - top) / rows.length);
            rows.forEach((s, i) => {
                const y = Math.round(top + i * rh), base = Math.round(y + rh / 2 + 11);
                const raw = res[s.key], cf = sae ? cfOf(s.key) : null, noAir = sae && G.isNum(raw) && cf === null;
                const r = sae ? (noAir ? raw : Weather.correctTime(raw, cf, !!s.dist)) : raw;
                const b = bests()[bestKey(s.key, rolling)], dh = G.isNum(r) && downhill(sl[s.key]);
                const outside = G.isNum(r) && limit() !== null && G.isNum(sl[s.key]) && Math.abs(sl[s.key]) > limit();
                cv.text(s.label, 1004, base, 24, s.custom ? t.accent2 : t.dim, { font: 'bold', spacing: 0.5 });
                const ti = cols[0][1];
                cv.text(secs(r), ti, base + 3, 34, G.isNum(r) ? (dh ? t.warn : noAir ? t.dim : t.text) : withAlpha(t.dim, 0.6), { align: 'right', font: 'num' });
                cv.text('s', ti + 6, base + 3, 18, t.dim);
                if (!rolling) {
                    const tv = sae && !noAir ? Weather.correctTrap(timer.trapSpeed[s.key], cf) : timer.trapSpeed[s.key];
                    const ts = Math.round(V(tv)) + ' ' + vU();
                    if (s.dist && G.isNum(tv) && s.key !== 'ft60') cv.text(ts, cols[1][1], base, fit(cv, ts, room[1], 20, lo), t.dim, lo);
                }
                const n = cols.length, ps = pctS(sl[s.key]);
                // (a slope outside the limit either way: the run isn't VALID; downhill: no best either)
                if (G.isNum(r)) cv.text(ps, cols[n - 2][1], base, fit(cv, ps, room[n - 2], 20, lo), dh || outside ? t.warn : t.dim, lo);
                let sub = b ? 'best ' + secs(b.s) : '--', subCol = t.dim;
                if (dh) { sub = 'DOWNHILL'; subCol = t.warn; } else if (noAir) { sub = 'NO AIR DATA'; subCol = t.dim; } else if (G.isNum(r) && nb[s.key]) { sub = 'NEW BEST'; subCol = GO; } else if (G.isNum(r) && b) {
                    const d = r - b.s;
                    if (Math.abs(d) < 0.005) { sub = 'BEST'; subCol = GO; } else { sub = (d > 0 ? '+' : '') + d.toFixed(2); subCol = d < 0 ? GO : t.dim; }
                }
                const so = { align: 'right', font: G.isNum(r) ? 'bold' : 'label', spacing: G.isNum(r) ? 1 : 0 };
                cv.text(sub, 1556, base, fit(cv, sub, room[n - 1], 20, so), subCol, so);
                if (i < rows.length - 1) cv.fillRect(1004, Math.round(y + rh), 552, 1, withAlpha(t.tick, 0.3));
            });
        }

        function bestList(cv, t, x, w, title, rows, rolling, ex) {
            G.panel(cv, t, x, 44, w, 468, title);
            const top = 104, rh = Math.min(70, (G.toMargin(ex, 0) + 512 - 14 - top) / rows.length), r = x + w - 24;
            rows.forEach((s, i) => {
                const y = Math.round(top + i * rh), base = Math.round(y + rh / 2 + 10), b = bests()[bestKey(s.key, rolling)];
                cv.text(s.label, x + 24, base, 26, s.custom ? t.accent2 : t.text, { font: 'bold' });
                cv.text(b ? secs(b.s) : '--.--', r - 18, base + 4, 40, b ? t.accent2 : t.dim, { align: 'right', font: 'num' });
                cv.text('s', r - 12, base + 4, 20, t.dim);
                if (b) {
                    const det = [when(b.at)].concat(G.isNum(b.trap) && s.dist && s.key !== 'ft60' ? [Math.round(V(b.trap)) + ' ' + vU()] : [], G.isNum(b.slope) ? [pctS(b.slope)] : []);
                    cv.text(det.join('  ·  '), r - 150, base, 20, t.dim, { align: 'right', font: 'label' });
                }
                if (i < rows.length - 1) cv.fillRect(x + 24, Math.round(y + rh), w - 48, 1, withAlpha(t.tick, 0.35));
            });
        }

        function drawBest(cv, t) {
            const ex = Math.max(0, (cv.extra || 0));
            const sae = saeOn() ? ' (SAE)' : '';
            bestList(cv, t, 24, 764, (settings.get('rollout') ? 'Standing launch (rollout)' : 'Standing launch') + sae, standSplits(), false, ex);
            bestList(cv, t, 812, 764, 'Rolling start' + sae, rollWindows(), true, ex);
            G.button(cv, t, 1576 - 20 - 200, 54, 200, 40, clearArmed ? 'Yes, clear' : 'Reset best', act, { key: 'clear', color: clearArmed ? t.crit : null });
        }

        function drawHistory(cv, t) {
            const sh = G.panel(cv, t, 24, 44, 1552, 468, 'Recent runs'), ex = sh.y + sh.h - G.BOTTOM;
            const ho = { font: 'bold', spacing: 1 };
            cv.text('WHEN', 48, 112, 18, t.dim, ho);
            cv.text('RUN', 230, 112, 18, t.dim, ho);
            cv.text('SLOPE', 470, 112, 18, t.dim, Object.assign({ align: 'right' }, ho));
            const sae = saeOn();
            cv.text(sae ? 'SPLITS (SAE)' : 'SPLITS', 640, 112, 18, t.dim, ho);
            const names = {}, order = [];
            standSplits().concat(Object.keys(D).map((k) => D[k]), rollWindows()).forEach((s) => { if (!names[s.key]) { names[s.key] = s.label; order.push(s.key); } });
            // two lines a run: the splits, then its details and air (older runs have none of these)
            const RH = 60, runs = store.runs.filter((r) => (r.unit || 'kmh') === unit()).slice(0, Math.max(1, Math.floor((512 + ex - 130) / RH)));
            if (!runs.length) cv.text('No runs yet - launch from a stop or accelerate through a rolling window.', 48, 180, 26, t.dim);
            runs.forEach((r, i) => {
                const y = 150 + i * RH, roll2 = r.kind === 'roll', sl = r.slope || {}, cf = r.air && G.isNum(r.air.cf) ? r.air.cf : null;
                // (a window no longer set, e.g. an earlier custom one: named from its key, '80-180' / '50-120mph')
                const keys = order.filter((k) => r.result && r.result[k] !== undefined)
                    .concat(Object.keys(r.result || {}).filter((k) => !names[k] && /^\d+-\d+(mph)?$/.test(k)));
                keys.forEach((k) => { if (!names[k]) names[k] = k.replace(/mph$/, '') + ' ' + (/mph$/.test(k) ? 'mph' : 'km/h'); });
                const pcts = keys.map((k) => sl[k]).filter(G.isNum);
                // the run's own slope (newer runs), else its steepest descent
                const worst = G.isNum(r.slopeAll) ? r.slopeAll : pcts.length ? Math.min.apply(null, pcts) : null;
                cv.text(when(r.at), 48, y, 22, t.text);
                const kind = roll2 ? 'ROLLING START' : r.rollout ? 'STANDING LAUNCH (rollout)' : 'STANDING LAUNCH';
                cv.text(kind, 230, y, fit(cv, kind, 165, 18, ho), roll2 ? t.accent2 : t.dim, ho);
                const vd = r.valid === undefined ? null : r.valid;
                cv.text(pctS(worst), 470, y, 20, downhill(worst) || (vd && vd.why === 'SLOPE') ? t.warn : t.dim, { align: 'right', font: 'label' });
                // (the reason why not opens the second line: too long for this column in some languages)
                if (vd) { const vt = vd.ok ? 'VALID RUN' : 'INVALID RUN'; cv.text(vt, 490, y, fit(cv, vt, 136, 18, ho), vd.ok ? GO : t.warn, ho); }
                // corrected to standard air (that mode): a run with its air; one without shows as measured, marked *
                const tm = (k) => (sae && cf !== null ? Weather.correctTime(r.result[k], cf, isDist(k)) : r.result[k]);
                const tp = (k) => (sae && cf !== null ? Weather.correctTrap(r.trap[k], cf) : r.trap[k]);
                const txt = keys.map((k) => names[k] + ' ' + secs(tm(k)) + (r.trap && G.isNum(r.trap[k]) && k !== 'ft60' ? ' @' + Math.round(V(tp(k))) : '')).join('   ') + (sae && cf === null ? '  *' : '');
                cv.text(txt, 640, y, fit(cv, txt, 912, 22, {}), sae && cf === null ? t.dim : t.text);
                const shiftTxt = (r.shifts || []).map((x) => (G.isNum(x.from) && G.isNum(x.to) ? x.from + '-' + x.to + ' ' : '') + (G.isNum(x.kmh) ? Math.round(V(x.kmh)) + ' ' + vU() : '')).filter(Boolean).join(', ');
                const d2 = (vd && !vd.ok ? [[vd.why, '']] : []).concat(detailPieces(r.top, r.height, null), shiftTxt ? [['SHIFTS', shiftTxt]] : [], airPieces(r.air));
                pieces(cv, t, d2, 230, y + 26, 1322, 17, 'left');
                if (i < runs.length - 1) cv.fillRect(48, y + 38, 1504, 1, withAlpha(t.tick, 0.25));
            });
        }

        async function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            if (page < 2) drawRun(cv, t, page === 1); else if (page === 2) drawBest(cv, t); else drawHistory(cv, t);
            header(cv, t);
            await ui.image('MAIN_GFX', cv);
        }

        /* ---------- buttons ---------- */
        let clearArmed = null;
        const actionLabel = () => ui.text('BTN_ACTION', page < 2 ? 'Reset run' : clearArmed ? 'Yes, clear' : 'Reset best');
        const go = (p) => { page = (p + PAGES.length) % PAGES.length; actionLabel(); return render(); };
        ui.onClick('BTN_PAGE', () => go(page + 1));
        ui.onClick('BTN_PREV', () => go(page - 1));
        ctx.onTab((i) => i !== page && go(i));
        // Reset run (Standing / Rolling) / Reset best, pressed twice (Best times, History): on the page, or the bar's button
        function act() {
            // Reset run: the timers, and with them the last runs' verdict, air and details (and new-best marks: { raw, std })
            if (page < 2) {
                timer.reset(); roll.reset(); peakG = 0; rollPeak = 0;
                lastNewBest = { raw: {}, std: {} }; rollNewBest = { raw: {}, std: {} }; standSlope = {}; rollSlope = {};
                standRec = null; rollRec = null; rollAir = {}; liveShifts = null;
                return render();
            }
            if (!clearArmed) {
                clearArmed = setTimeout(() => { clearArmed = null; actionLabel(); }, 5000);
                return actionLabel();
            }
            clearTimeout(clearArmed); clearArmed = null;
            store.best = {}; store.bestStd = {}; store.runs = []; save();
            log.info('best times cleared');
            actionLabel();
            return render();
        }
        ui.onClick('BTN_ACTION', act);
        ctx.hideButton('BTN_ACTION');

        // every screen refresh (60 fps) with the GPU renderer; 8 fps in software (PNG frames)
        ctx.loop('MAIN', 8, render);
        settings.onChange((k) => {
            if (['speedUnit', 'distance', 'rollout', 'highSpeed', 'custom', 'customFrom', 'customTo'].indexOf(k) >= 0) { newTimer(); peakG = 0; rollPeak = 0; }
        });
        // the timer state machine needs launch detection even while the screen is hidden;
        // feeding happens in the signal handlers / demo interval, independent of rendering.
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
