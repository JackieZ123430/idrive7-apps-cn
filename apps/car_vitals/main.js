'use strict';
/**
 * M Vitals - live engine / thermal / chassis gauges drawn in the HMI's style.
 *
 * Pages (button "Next page"):
 *   engine  - RPM + boost dials, power/torque bars, speed
 *   thermal - coolant / engine oil / gearbox / ambient with 5-minute traces
 *   fuel    - "Fuel & ignition": intake air temperature, high / low pressure fuel, ignition
 *             timing, misfires per cylinder (read from the DME over UDS / OBD, see
 *             config.dme), intake air above outside temperature
 *   (thermal also: gearbox temperature from the EGS when config.dme.egs has a source)
 *   chassis - friction circle (g-g diagram), tyre pressures + temperatures, xDrive split
 *
 * Signals come straight from the car over SOME/IP (see app.json "signals").
 * With no car attached (the VM, or the unit on the bench) demo data can drive
 * the gauges; a DEMO badge is drawn whenever it does.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const Demo = require('./demo');
const { GearGuess, selectionOf } = require('./kit/car');
const { Diag } = require('./kit/diag');
const { DidReader } = require('./kit/dids');

const W = 1600, H = 520;
const PAGES = ['engine', 'thermal', 'fuel', 'chassis'];
const FUEL = ['iat', 'hpfp', 'lpfp', 'timing'];          // engine unit values read fast on the Fuel & ignition page
const HIST_SEC = 300;
/*
 * Plausible ranges (deg C / bar). A value outside is the car's "no data" marker or a field this
 * car fills differently (a tyre at 255 deg C, a pressure of 0): shown as no data, never drawn.
 */
const TYRE_T = [-40, 150], TYRE_P = [0.5, 6], TYRE_PT = [1, 6];
const RANGE = {
    rpm: [0, 12000], coolant: [-40, 160], oil: [-40, 170], gearbox: [-40, 160], egs: [-40, 160], ambient: [-50, 60], timing: [-64, 64],
    boostFes: [-1, 4], boostDme: [-1, 4], tFL: TYRE_T, tFR: TYRE_T, tRL: TYRE_T, tRR: TYRE_T,
    pFL: TYRE_P, pFR: TYRE_P, pRL: TYRE_P, pRR: TYRE_P, ptFL: TYRE_PT, ptFR: TYRE_PT, ptRL: TYRE_PT, ptRR: TYRE_PT,
};
/*
 * Fields some cars never fill sit at one number (gearbox oil at 0 deg C): they only count once
 * they have changed by this much. Once seen working the car is remembered (seen.json), so the
 * next start shows them straight away.
 */
// (tyre temperatures are not doubtful any more: with the right scaling a car's "no data" is 65535)
const MOVE = { gearbox: 1, egs: 1, boostFes: 0.03, boostDme: 0.03 };
/** Remembered per car: which groups sent real data (the "Auto" setting shows only those). */
const GROUP = { gearbox: 'gearbox', boostFes: 'boost', boostDme: 'boost', tFL: 'tyreTemp', tFR: 'tyreTemp', tRL: 'tyreTemp', tRR: 'tyreTemp',
    pFL: 'tyres', pFR: 'tyres', pRL: 'tyres', pRR: 'tyres', iat: 'iat', hpfp: 'hpfp', lpfp: 'lpfp', timing: 'timing', egs: 'egs' };
/**
 * "Auto / Show / Hide" setting of each group. Auto: shown once the car / engine unit has sent real
 * data for it (remembered), so values a car doesn't have never take space.
 */
const SHOW = { boost: 'showBoost', gearbox: 'showGearbox', tyres: 'showTyres', tyreTemp: 'showTyreTemp',
    iat: 'showIat', hpfp: 'showHpfp', lpfp: 'showLpfp', timing: 'showTiming', misfire: 'showMisfire', egs: 'showEgs' };
const TYRES = ['FL', 'FR', 'RL', 'RR'];
// gearbox enum: names or wire numbers (G1 = 3 ... G10 = 12, R = 1, N_OR_P = 2), as in kit/car.js
const GEARS = { G1: 1, G2: 2, G3: 3, G4: 4, G5: 5, G6: 6, G7: 7, G8: 8, G9: 9, G10: 10, R: -1, N_OR_P: 0 };
const gearOf = (x) => (typeof x === 'number' ? (x >= 3 && x <= 12 ? x - 2 : x === 1 ? -1 : x === 2 ? 0 : undefined) : GEARS[x]);
// selector position (statusActualStageDrive), names or wire numbers (P = 1, R = 2, N = 3, D = 4), as in kit/car.js
const STAGES = { P: 'P', R: 'R', N: 'N', D: 'D', 1: 'P', 2: 'R', 3: 'N', 4: 'D' };
// MDrive.dataDisplayGearbox: the programme the cluster shows next to the gear (names or wire numbers)
const PROGRAMS = { S_MINUS_PROGRAMM: 'S', M_MINUS_PROGRAMM: 'M', 1: 'S', 2: 'M' };

/**
 * Selector programme (D / S / M / P / R / N) from the gearbox status. Field names differ
 * between cars, so look at every selector-like field: enum names or on/off flags.
 */
function modeOf(o) {
    for (const k of Object.keys(o || {})) {
        if (k === 'statusActualGearDrive' || /StageDrive/.test(k) || !/select|lever|position|program|mode|range|manual|sport|tip/i.test(k)) continue;
        const v = o[k];
        if (v === true || v === 1) { if (/manual|tip/i.test(k)) return 'M'; if (/sport/i.test(k)) return 'S'; continue; }
        const x = String(v).toUpperCase();
        if (/NOT|INACTIVE|INVALID|SIGNAL|UNKNOWN|OFF|NO_/.test(x)) continue;
        if (/MANU|TIPP|^M$|^M_|_M$|^M\d/.test(x)) return 'M';
        if (/SPORT|^S$|_S$|^DS$/.test(x)) return 'S';
        if (/PARK|^P$/.test(x)) return 'P';
        if (/REVERSE|^R$/.test(x)) return 'R';
        if (/NEUTRAL|^N$/.test(x)) return 'N';
        if (/DRIVE|^D$|^D_|_D$/.test(x)) return 'D';
    }
    return null;
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const S = (ctx.spec.config && ctx.spec.config.scaling) || {};
        const sc = (k, raw) => {
            const c = S[k];
            if (!c || raw === undefined || raw === null || raw === c.invalid || (c.invalidFrom != null && raw >= c.invalidFrom)) return null;
            return raw * c.factor + (c.offset || 0);
        };

        /* ---------- live data ---------- */
        const live = {}, peak = {}, demoPeak = {}, hist = { coolant: [], oil: [], gearbox: [], egs: [], ambient: [], iat: [], hpfp: [], lpfp: [], iatRise: [], timing: [] };
        /*
         * Peak hold: a peak follows new highs, and "peakHold" s after it was last raised it drops back
         * to the current value (0 = until "Reset peaks"). Called per sample and per frame, so it also
         * drops while the car sends nothing new.
         */
        const peakAt = new Map();
        const raise = (o, k, v) => {
            if (!G.isNum(v)) return;
            const at = peakAt.get(o) || peakAt.set(o, {}).get(o), now = Date.now(), hold = settings.get('peakHold') * 1000;
            if (o[k] === undefined || v >= o[k] || (hold > 0 && now - (at[k] || 0) > hold)) { o[k] = v; at[k] = now; }
        };

        // xDrive card: 'auto' shows it once the car has reported all-wheel drive (remembered),
        // so rear-wheel-drive cars never see an empty card
        const AWD_FILE = path.join(ctx.dataDir, 'awd.json');
        let awdSeen = false;
        try { awdSeen = !!JSON.parse(fs.readFileSync(AWD_FILE, 'utf8')).seen; } catch (e) { /* not yet */ }
        const markAwd = () => {
            if (awdSeen) return;
            awdSeen = true; log.info('all-wheel drive detected');
            try { fs.writeFileSync(AWD_FILE, JSON.stringify({ seen: true })); } catch (e) { log.warn('awd save: ' + e); }
        };
        // which groups / sources this car has sent real data for (see MOVE, GROUP)
        const SEEN_FILE = path.join(ctx.dataDir, 'seen.json');
        let seen = {};
        try { seen = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')) || {}; } catch (e) { /* not yet */ }
        const remember = (keys) => {
            const add = keys.filter((x, i) => x && !seen[x] && keys.indexOf(x) === i);
            if (!add.length) return;
            add.forEach((x) => { seen[x] = true; });
            log.info('real data from the car: ' + add.join(', '));
            try { fs.writeFileSync(SEEN_FILE, JSON.stringify(seen)); } catch (e) { log.warn('seen save: ' + e); }
        };
        const bad = {}, first = {}, moved = {};
        /** A MOVE value counts once it changed this session or the car is known to send it. */
        const trusted = (k) => MOVE[k] == null || !!moved[k] || !!seen[k] || (/^t(FL|FR|RL|RR)$/.test(k) && !!seen.tyreTemp);
        /** The first raw values of the doubtful fields go to the log, to calibrate app.json from. */
        const rawLogged = {};
        const logRaw = (name, raw) => {
            const key = JSON.stringify(raw), l = rawLogged[name] || (rawLogged[name] = []);
            if (l.length >= 12 || l.indexOf(key) >= 0) return;
            l.push(key); log.info('raw ' + name + ': ' + key);
        };
        let lastCar = 0, oilCarT = 0;          // oilCarT: last valid oil temperature from the car's own signal
        // xDrive split sources, first one with data wins (see xdriveSplit):
        //   1. BasicDataSet torque split, fresh (< SPLIT_STALE ms), valid qualifier, not 0
        //   2. the drive mode: in 2WD the front axle gets nothing, so 100 % rear
        //   3. none: the bars show no data rather than a made-up number
        const SPLIT_STALE = 10000;
        const SPLIT_OK = (q) => q === undefined || q === null || q === 2 || q === 10 ||
            q === 'SIGNALWERT_IST_GUELTIG' || q === 'SIGNALWERT_IST_GUELTIG__REKALIBRIERUNGSBEDARF';
        let splitAt = 0;
        const xdriveSplit = (d) => {
            if (usingDemo()) return { rear: d.splitRear, from: null };
            const now = Date.now();
            if (G.isNum(live.splitRear) && now - splitAt < SPLIT_STALE) return { rear: live.splitRear, from: null };
            // transfer case: front axle torque against what the gearbox puts out (engine torque x gear ratio)
            if (G.isNum(live.lmvFront) && now - lmvAt < 3000) {
                const nm = live.lmvFront, ratio = xcfg.gearRatios[(live.gear || 0) - 1];
                const input = G.isNum(live.torque) && ratio ? live.torque * ratio : null;
                if (nm <= 5) return { rear: 100, from: 'transfer case: clutch open', nm };
                if (input > 50) return { rear: 100 - Math.max(0, Math.min(100, nm / input * 100)), from: 'transfer case, estimated', nm };
                return { rear: null, from: 'transfer case', nm };
            }
            if (d.awd === '_2WD') return { rear: 100, from: '2WD mode' };
            return { rear: null, from: null };
        };
        const guess = new GearGuess();
        let gearLogs = 0, lastModeKey = '';
        const put = (k, v) => {
            if (v === null || v === undefined || !isFinite(v)) return;
            lastCar = Date.now();
            const r = RANGE[k];
            if (r && (v < r[0] || v > r[1])) { bad[k] = v; return; }
            delete bad[k];
            if (MOVE[k] != null) {
                if (first[k] === undefined) first[k] = v;
                else if (!moved[k] && Math.abs(v - first[k]) >= MOVE[k]) { moved[k] = true; remember([GROUP[k], k]); }
            } else if (GROUP[k]) remember([GROUP[k]]);
            live[k] = v;
            if (k === 'boostFes' || k === 'boostDme') { updBoost(); return; }
            raise(peak, k, v);
            if (k === 'rpm' || k === 'torque') {
                // fallback when the car sends no sport-display power: crankshaft torque x speed (engine only)
                if (G.isNum(live.torque) && G.isNum(live.rpm)) live.powerCalc = Math.max(0, live.torque * live.rpm / 9549);
            }
            if ((k === 'rpm' || k === 'speed') && G.isNum(live.rpm) && G.isNum(live.speed)) {
                const g = guess.feed(live.rpm, live.speed);
                // nothing at a standstill: the guess can't tell P, N or D there (it showed "N" in park / in D)
                live.gearGuess = live.speed < 3 ? null : g;
            }
        };
        const watches = [
            ['de.bmw.infotainment.vehicle.CDS', {
                statusEngineSpeed2: (v) => put('rpm', sc('rpm', v.actualValueRPMEngineCrankshaft)),
                statusEngineTemperature: (v) => {
                    logRaw('engine temperatures', [v.temperatureEngineDrive, v.temperatureEngineOilDrive]);
                    put('coolant', sc('engineTemp', v.temperatureEngineDrive));
                    const oil = sc('engineTemp', v.temperatureEngineOilDrive);
                    if (oil !== null) { oilCarT = Date.now(); put('oil', oil); }
                },
            }],
            ['de.bmw.infotainment.vehicle.CDS2', {
                statusLongitudinalAccelerationMassCenter: (v) => put('gLong', sc('accel', v.longitudinalAccelerationCentreOfGravity) / 9.80665),
                statusLateralAccelerationMassCenter: (v) => put('gLat', sc('accel', v.lateralAccelerationCentreOfGravity) / 9.80665),
            }],
            ['de.bmw.infotainment.vehicle.Vehicle2', { statusCarSpeed2: (v) => put('speed', sc('speed', v.speedVehicleCentreOfGravity)) }],
            ['de.bmw.infotainment.drivingexcitement.FES', {
                statusSwitchDriveDynamicSport2: (v) => { logRaw('FES boost', v.displayBoostPressure); put('boostFes', sc('boost', v.displayBoostPressure)); },
                // the HMI's sport display: power / torque in % of the car's maximum
                statusVehicleDynamicEngine: (v) => { put('powerPct', sc('sportPct', v.displaySportEnginePower)); put('torquePct', sc('sportPct', v.displaySportEngineTorque)); },
                // negative = engine braking (falling rpm): shown as 0
                statusActualValueTorque2: (v) => { const tq = sc('torque', v.actualValueTorqueCrankshaft); put('torque', tq === null ? null : Math.max(0, tq)); },
            }],
            ['de.bmw.infrastructure.VehicleInformation', {
                statusGearboxDrive: (v) => {
                    const g = gearOf(v && v.statusActualGearDrive);
                    if (g !== undefined) { live.gear = g; lastCar = Date.now(); }
                    live.stage = STAGES[v && v.statusActualStageDrive];
                    live.gearMode = modeOf(v);
                    // field names / values differ per car: log them so the D/S/M detection can be checked
                    const key = JSON.stringify(Object.keys(v || {}).filter((x) => x !== 'statusActualGearDrive').map((x) => [x, v[x]]));
                    if (key !== lastModeKey && gearLogs < 40) { gearLogs++; lastModeKey = key; log.info('gearbox: ' + JSON.stringify(v) + ' -> ' + (live.gearMode || '?')); }
                },
                // this car never sent statusGearboxDrive (2.8.0 logs): P / R / N / gear from here too
                DataPowerTrain2: (v) => {
                    logRaw('gear selection', v && v.statusGearSelectionDrive);
                    const sel = selectionOf(v && v.statusGearSelectionDrive);
                    if (!sel) return;
                    if (sel.stage !== undefined) live.stage = sel.stage;
                    live.gear = sel.gear; lastCar = Date.now();
                },
            }],
            ['de.bmw.infrastructure.analytics.BasicDataSet', {
                basicDataSet: (v) => {
                    logRaw('gearbox oil', v.valueTemperatureTransmissionOil);
                    put('gearbox', sc('gearboxTemp', v.valueTemperatureTransmissionOil));
                    // xDrive split: the only signal the car has for it. Taken only when its qualifier
                    // says valid (or the car leaves the qualifier out) and it isn't 0 - a car that
                    // doesn't fill the field sends 0 or 65535; xdriveSplit() then falls back.
                    const rawSplit = v.valueDistributionLongitudinalTorqueRearAxisFrontAxis;
                    const q = v.qualifierValueDistributionLongitudinalTorqueRearAxisFrontAxis;
                    logRaw('torque split [value, qualifier]', [rawSplit, q]);
                    const split = SPLIT_OK(q) ? sc('torqueSplitRear', rawSplit) : null;
                    if (G.isNum(split) && split > 0) { put('splitRear', split); splitAt = Date.now(); }
                    if (G.isNum(split) && split > 1 && split < 97) markAwd();     // torque going to the front axle
                },
            }],
            ['de.bmw.infrastructure.EnvironmentalInformation', { ExteriorTemperature: (v) => put('ambient', sc('ambient', v.temperatureExterior)) }],
            ['de.bmw.infotainment.vehicle.TPMS', {
                statusTyreTemperature: (v) => {
                    logRaw('tyre temperature', [v.actualValueTemperatureTyreFLH, v.actualValueTemperatureTyreFRH, v.actualValueTemperatureTyreRLH, v.actualValueTemperatureTyreRRH]);
                    put('tFL', sc('tyreTemp', v.actualValueTemperatureTyreFLH)); put('tFR', sc('tyreTemp', v.actualValueTemperatureTyreFRH));
                    put('tRL', sc('tyreTemp', v.actualValueTemperatureTyreRLH)); put('tRR', sc('tyreTemp', v.actualValueTemperatureTyreRRH));
                },
                // bar = 0.1 x raw, >= 65532 invalid (BMW x_call's converter)
                statusTyrePressure: (v) => {
                    logRaw('tyre pressure', [v.actualValuePressureTyreFLH, v.actualValuePressureTyreFRH, v.actualValuePressureTyreRLH, v.actualValuePressureTyreRRH]);
                    put('pFL', sc('tyrePress', v.actualValuePressureTyreFLH)); put('pFR', sc('tyrePress', v.actualValuePressureTyreFRH));
                    put('pRL', sc('tyrePress', v.actualValuePressureTyreRLH)); put('pRR', sc('tyrePress', v.actualValuePressureTyreRRH));
                },
                statusTargetTyrePressure: (v) => {
                    put('ptFL', sc('tyrePress', v.targetPressureTyreFLH)); put('ptFR', sc('tyrePress', v.targetPressureTyreFRH));
                    put('ptRL', sc('tyrePress', v.targetPressureTyreRLH)); put('ptRR', sc('tyrePress', v.targetPressureTyreRRH));
                },
            }],
            ['de.bmw.infotainment.misc.MDrive', {
                statusMSystem: (v) => {
                    live.awd = v.statusAllWheelSetup; live.awdQual = v.qualifierFunctionAllWheel;
                    if (/^_4WD|SAND/.test(String(live.awd))) markAwd();
                },
                // S / M next to the gear: this car sends no selector programme with the gearbox status
                dataDisplayGearbox: (v) => {
                    logRaw('gear programme', v && v.displayProgramGearbox);
                    live.program = PROGRAMS[v && v.displayProgramGearbox] || null;
                },
            }],
        ];
        log.info('subscribing signals');
        // tyre values: also read every 10 s - BMW's own x_call only ever reads them, so a car may not notify them
        const subs = [], startT = Date.now();
        Promise.all(watches.map(([iface, h]) => ctx.signals.watch(iface, '1', h, log, /\.TPMS$/.test(iface) ? { pollMs: 10000 } : undefined)
            .then((s) => { subs.push(s); return s; })))
            .then((all) => log.info('signals: ' + all.map((s) => s.iface.split('.').pop() + (s.error ? '(err)' : '')).join(' ')));

        const demo = new Demo();
        // Auto: demo only until the car answers - a parked car sends nothing new for minutes, which is not "no car"
        const carPresent = () => lastCar > 0 || subs.some((s) => s.available);
        const usingDemo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !carPresent() && Date.now() - startT > 5000);
        /**
         * What the screen shows: the car's values, with doubtful ones (MOVE) left out until they
         * have proven real; demo data as it is.
         */
        const data = () => {
            if (usingDemo()) return demo.sample();
            const v = Object.assign({}, live);
            Object.keys(MOVE).forEach((k) => { if (!trusted(k)) v[k] = null; });
            return v;
        };
        /** Boost from the source the setting asks for; Auto: the sport display if it works, else the engine unit. */
        function updBoost() {
            const src = settings.get('boostSource');
            const fes = G.isNum(live.boostFes) ? live.boostFes : null, dmeB = G.isNum(live.boostDme) ? live.boostDme : null;
            const v = src === 'fes' ? fes : src === 'dme' ? dmeB
                : fes !== null && trusted('boostFes') ? fes : dmeB !== null && trusted('boostDme') ? dmeB : null;
            live.boost = v;
            if (v !== null) raise(peak, 'boost', v);
        }
        /** Boost still needed from the engine unit (UDS)? */
        const boostFromDme = () => (dme.boost || []).length > 0 && (settings.get('boostSource') === 'dme'
            || (settings.get('boostSource') !== 'fes' && !(G.isNum(live.boostFes) && trusted('boostFes'))));
        /** Auto / Show / Hide: Auto shows a group once the car has sent real data for it (demo: always). */
        const shown = (g) => { const s = settings.get(SHOW[g]); return s === 'on' || (s !== 'off' && (usingDemo() || !!seen[g])); };
        /** Why a temperature is missing, for its tile. */
        function why(k) {
            if (bad[k] !== undefined) return 'car sends ' + G.fmt(T(bad[k]), 0) + tU() + ' - not a real value';
            if (G.isNum(live[k]) && !trusted(k)) return 'stuck at ' + G.fmt(T(live[k]), 0) + tU() + ' - waiting for it to change';
            return 'no data from the car';
        }

        /* ---------- intake + fuel from the DME (UDS 0x22; candidates in app.json config.dme) ----------
         * Fast (~2/s) while the Fuel & ignition page is on screen, every 5 s otherwise so the history
         * keeps filling. A value the DME refuses is only re-tried every 30 s. */
        const dme = Object.assign({ ecu: 18 }, (ctx.spec.config && ctx.spec.config.dme) || {});
        // connect in the background: the screen must not wait for the diagnostic link
        const link = new Diag(ctx.signals, log);
        link.quiet = true;
        link.init();
        const rd = new DidReader(link, { ecu: dme.ecu });
        // xDrive front axle torque from the transfer case unit (config.xdrive), read while the Chassis page is on screen
        const xcfg = Object.assign({ front: [], gearRatios: [] }, (ctx.spec.config && ctx.spec.config.xdrive) || {});
        let chassisSeen = 0, lmvAt = 0;
        const fuelT = {}, fuelFail = {}, fuelTry = {};
        let fuelSeen = 0, engineSeen = 0, fuelTimer = null, fuelBusy = false, fuelLast = 0;
        let baro = 101.3, baroT = 0;                                       // outside air pressure, kPa
        /*
         * Misfires per cylinder (OBD service 06 monitor results, MIDs A2.. = cylinder 1..; test
         * config.dme.misfire.tid, default 0C = this driving cycle). misMode: which request this engine
         * answers (false = service 06, true = UDS F6xx, null = not found yet); misCyl: cylinders found.
         */
        let misMode = null, misCyl = 0;
        async function readMisfire() {
            const m = dme.misfire || {}, ecu = m.ecu == null ? dme.ecu : m.ecu, tid = parseInt(m.tid || '0C', 16);
            if (misMode === null) {
                if (await rd.monitor(ecu, 0xA2, false)) misMode = false;
                else if (await rd.monitor(ecu, 0xA2, true)) misMode = true;
                else return null;
            }
            if (!misCyl) {
                // the engine unit's own list of its misfire monitors (MID A0) gives the cylinder count
                const sup = await rd.supported(ecu, 0xA0, misMode);
                let n = 0;
                while (sup && n < 12 && sup.indexOf(0xA2 + n) >= 0) n++;
                if (n) { misCyl = n; log.info('misfire counter: ' + n + ' cylinders (engine unit list)'); }
            }
            const counts = [];
            for (let c = 0; c < (misCyl || 12); c++) {
                const res = await rd.monitor(ecu, 0xA2 + c, misMode);
                if (!res) {
                    // counting without the list: a refusal past cylinder 1 ends the engine; no reply is
                    // a missed round, not the end (it would cut a 6-cylinder short)
                    if (misCyl || !c || !/^NRC/.test(rd.raws[rd.monitorKey(ecu, 0xA2 + c, misMode)].why)) return null;
                    break;
                }
                const tr = res.find((x) => x.tid === tid) || res[0];
                counts.push(tr.value >= 65535 ? null : tr.value);
            }
            if (!misCyl) { misCyl = counts.length; log.info('misfire counter: ' + misCyl + ' cylinders (counted)'); }
            return counts.length === misCyl ? counts : null;
        }
        /** Boost from the engine unit: charge / manifold pressure (absolute, kPa) minus outside air pressure. */
        async function readBoost() {
            if (Date.now() - baroT > 60000) { baroT = Date.now(); const b = await rd.value('baro', dme.baro); if (b !== null) baro = b; }
            const m = await rd.value('boost', dme.boost);
            return m === null ? null : (m - baro) / 100;
        }
        /** Front axle torque from the transfer case (Nm); the raw reply goes to the log once per new value shape. */
        async function readLmv() {
            const v = await rd.value('lmvFront', xcfg.front);
            const c = xcfg.front[rd.pick.lmvFront || 0], r = c && rd.raws[rd.key(c)];
            if (r) logRaw('xDrive transfer case 22 DB32', r.bytes ? r.bytes.split(' ').slice(3, 11).join(' ') : r.why);
            if (v === null) { fuelFail.lmv = (fuelFail.lmv || 0) + 1; return; }
            fuelFail.lmv = 0;
            live.lmvFront = v; lmvAt = Date.now(); lastCar = lmvAt;
            if (v > 20) markAwd();                    // torque going to the front axle
        }
        /*
         * Fast (~2/s) for the values of the page on screen (Fuel & ignition, or boost on Engine when it
         * comes from the engine unit), all of them every 5 s otherwise so the history keeps filling.
         */
        async function pollFuel() {
            fuelBusy = true; fuelLast = Date.now();
            const now = Date.now(), needBoost = boostFromDme();
            // oil temperature from the engine unit while the car's own signal has none (a 330e sends none)
            const needOil = (dme.oil || []).length > 0 && now - oilCarT > 15000;
            // a value set to Hide is not asked for at all
            const want = (k) => settings.get(SHOW[k]) !== 'off' && (k === 'misfire' ? !!dme.misfire : (dme[k] || []).length > 0);
            const onFuelPage = now - fuelSeen < 1500;
            // transfer case: only on the Chassis page with the xDrive card shown, and only while the car's own split is missing
            const onChassis = now - chassisSeen < 1500 && xcfg.front.length > 0 && settings.get('xdrive') !== 'off'
                && !(G.isNum(live.splitRear) && now - splitAt < SPLIT_STALE);
            const fast = onFuelPage ? FUEL.filter(want) : now - engineSeen < 1500 && needBoost ? ['boost'] : onChassis ? ['lmv'] : null;
            // misfire counts change slowly: every 4th fast round on its page (~2 s), every slow round otherwise
            pollFuel.n = (pollFuel.n || 0) + 1;
            const misNow = want('misfire') && (!fast || (onFuelPage && pollFuel.n % 4 === 0));
            try {
                if (link.available) {
                    const keys = (fast || FUEL.filter(want).concat(needBoost ? ['boost'] : [], needOil ? ['oil'] : [], want('egs') ? ['egs'] : [])).concat(misNow ? ['misfire'] : []);
                    for (const k of keys) {
                        if ((fuelFail[k] || 0) >= 3 && Date.now() - (fuelTry[k] || 0) < 30000) continue;
                        fuelTry[k] = Date.now();
                        if (k === 'lmv') { await readLmv(); continue; }
                        const v = k === 'boost' ? await readBoost() : k === 'misfire' ? await readMisfire() : await rd.value(k, dme[k]);
                        if (k === 'egs' || k === 'timing') { const c = dme[k][rd.pick[k] || 0], r = c && rd.raws[rd.key(c)]; if (r) logRaw(k === 'egs' ? 'EGS' : 'timing', r.bytes || r.why); }
                        if (k === 'oil' && v !== null && Date.now() - oilCarT < 15000) continue;      // the car's own value came meanwhile
                        if (v === null) { fuelFail[k] = (fuelFail[k] || 0) + 1; continue; }
                        fuelT[k] = Date.now(); fuelFail[k] = 0;
                        if (k === 'misfire') { logRaw('misfires', v); live.misfire = v; lastCar = Date.now(); remember(['misfire']); } else put(k === 'boost' ? 'boostDme' : k, v);
                    }
                }
            } catch (e) { log.warn('engine unit poll: ' + e); }
            fuelBusy = false;
            fuelTimer = setTimeout(pollFuel, fast ? 400 : 5000);
        }
        fuelTimer = setTimeout(pollFuel, 1000);
        /** Page opened: don't wait for the slow timer. */
        const kickFuel = () => { if (!fuelBusy && Date.now() - fuelLast > 600) { clearTimeout(fuelTimer); fuelTimer = setTimeout(pollFuel, 0); } };
        /** Why a fuel value is missing, for its tile. */
        function fuelWhy(k) {
            if (!link.p) return 'no diagnostic link';
            if (!link.available) return 'diagnostic link down';
            const r = k === 'misfire' ? Object.keys(rd.raws).filter((x) => /MID A2|F6A2/.test(x)).map((x) => rd.raws[x])
                : (dme[k] || []).map((c) => rd.raws[rd.key(c)]).filter(Boolean);
            if (!r.length) return 'reading...';
            // plain words on the tile; the reply codes are in the log
            if (r.every((x) => /NRC 31|NRC 11|NRC 12/.test(x.why))) return 'not available on this car';
            if (k === 'misfire' && misMode === null) return 'not available on this car';
            return /NRC|refused|reply/.test(r[0].why) ? 'no reading from the engine unit' : r[0].why || 'no data';
        }

        // 1 Hz history sampler for the thermal traces
        setInterval(() => {
            const d = data();
            const fuelOk = (k) => usingDemo() || (fuelT[k] && Date.now() - fuelT[k] < 15000);
            Object.keys(hist).forEach((k) => {
                let v = d[k] == null ? null : d[k];
                if (FUEL.indexOf(k) >= 0 && !fuelOk(k)) v = null;
                if (k === 'iatRise') v = fuelOk('iat') && G.isNum(d.iat) && G.isNum(d.ambient) ? d.iat - d.ambient : null;
                hist[k].push(v); if (hist[k].length > HIST_SEC) hist[k].shift();
            });
        }, 1000);

        /* ---------- units ---------- */
        const T = (c) => (c == null ? null : settings.get('tempUnit') === 'F' ? c * 9 / 5 + 32 : c);
        const tU = () => (settings.get('tempUnit') === 'F' ? '°F' : '°C');
        const Pt = (b) => (b == null ? null : settings.get('pressUnit') === 'psi' ? b * 14.5038 : b);
        const P = (b) => (b == null ? null : settings.get('pressUnit') === 'psi' ? b * 14.5038 : b);
        const V = (k) => (k == null ? null : settings.get('speedUnit') === 'mph' ? k * 0.621371 : k);

        /* ---------- drawing ---------- */
        let page = PAGES.indexOf(settings.get('page'));
        if (page < 0) page = 0;
        const trail = [];

        const GO = '#2fd27a';

        /** G20-style frame: tab bar with the page names along the top. */
        function header(cv, t) {
            G.frame(cv, t, ['Engine', 'Thermals', 'Fuel & ignition', 'Chassis'], page, [usingDemo() && { text: 'DEMO' }]);
        }

        /** Power in kW: { kw, calc } (calc = estimated from torque x rpm, no sport-display data). */
        function power(d) {
            const useSport = settings.get('powerSource') !== 'calc' && G.isNum(d.powerPct);
            if (useSport) return { kw: d.powerPct / 100 * settings.get('maxPower'), calc: false };
            return { kw: G.isNum(d.powerCalc) ? d.powerCalc : null, calc: true };
        }
        const PW = (kw) => (G.isNum(kw) ? kw * ({ kw: 1, hp: 1.34102, ps: 1.35962 }[settings.get('powerUnit')] || 1) : null);
        const pwU = () => ({ kw: 'kW', hp: 'hp', ps: 'PS' }[settings.get('powerUnit')] || 'kW');

        /**
         * { letter, num, est } for the gear readout, or null without any gear information.
         * P / R / N come from the selector position: the gear field says N_OR_P for both P and N,
         * and while stopped in D (no gear engaged yet) it says N_OR_P too - that shows as D.
         */
        function gearText(d) {
            const st = d.stage, m = d.gearMode || d.program;
            if (st === 'P' || st === 'R' || st === 'N') return { letter: st, num: '', est: false };
            let g = d.gear, est = false;
            if (!G.isNum(g)) { g = d.gearGuess; est = true; }
            const letter = m === 'S' || m === 'M' ? m : 'D';
            if (!G.isNum(g)) return st === 'D' ? { letter, num: '', est: false } : null;
            if (g < 0) return { letter: 'R', num: '', est };
            if (g === 0) return st === 'D' ? { letter, num: '', est } : { letter: m === 'P' ? 'P' : 'N', num: '', est };
            return { letter, num: String(g), est };
        }

        /** Speed + gear card; tall = the full-height card of the Engine page without boost. */
        function speedCard(cv, t, d, x, y, w, h) {
            const tall = h > 300, sz = tall ? 150 : 96, gz = tall ? 230 : 120;
            G.panel(cv, t, x, y, w, h, 'Speed');
            const sp = V(G.hold('speed', d.speed, 1000 / settings.get('speedRate'))), sy = tall ? y + 220 : y + 160;
            const sw = cv.text(G.fmt(sp, 0), x + 22, sy, sz, sp == null ? t.dim : t.text, { font: 'num' });
            cv.text(settings.get('speedUnit') === 'mph' ? 'mph' : 'km/h', x + 30 + sw, sy, tall ? 34 : 26, t.dim);
            // gear: D / S / M + number (R, N, P alone)
            const gr = gearText(d), gy = tall ? y + h - 30 : y + 162;
            if (gr) {
                const nw = gr.num ? cv.text(gr.num, x + w - 24, gy, gz, t.text, { align: 'right', font: 'gear' }) : 0;
                cv.text(gr.letter, x + w - 28 - nw, gy, gz, gr.letter === 'M' ? t.crit : gr.letter === 'S' ? t.accent : t.dim, { align: 'right', font: 'gear' });
                if (gr.est) cv.text('EST.', x + w - 24, y + 36, 22, t.dim, { align: 'right', font: 'bold', spacing: 1 });
            }
        }

        function drawEngine(cv, t, d) {
            engineSeen = Date.now();
            if (boostFromDme()) kickFuel();
            const red = settings.get('redline');
            const max = Math.ceil((red + 1000) / 1000) * 1000;
            const showPk = settings.get('peaks');
            // demo data keeps its own peaks, so they never mix with the car's; raising them every frame
            // also lets a held peak drop back while the car sends nothing new
            const pk = usingDemo() ? demoPeak : peak;
            const pw = power(d), powMax = PW(settings.get('maxPower'));
            ['rpm', 'boost', 'torque'].forEach((k) => raise(pk, k, d[k]));
            raise(pk, 'power', pw.kw);
            // rpm + boost as tach bars (Redline style): theme colour -> red at the redline / warning zone
            G.segBar(cv, t, 24, G.TOP, 1062, 226, {
                label: 'Engine speed', value: d.rpm, unit: 'rpm', decimals: 0, min: 0, max, step: 500,
                scale: { every: 1000, div: 1000 }, ramp: 'hot', limit: red, marks: [{ value: red, color: 'crit' }],
                peak: showPk ? pk.rpm : null,
            });
            // power: the sport display's % x your car's max power (tuned cars: set the tuned max);
            // without sport-display data, torque x rpm. Shown in kW, hp or PS.
            const bars = (x, y, w, gap) => {
                G.bar(cv, t, x, y, w, 92, {
                    label: pw.calc ? 'Power (torque x rpm)' : 'Power', value: PW(pw.kw), unit: pwU(), max: powMax, niceMax: true, ramp: 'hot',
                    peak: showPk && G.isNum(pk.power) ? PW(pk.power) : null,
                });
                G.bar(cv, t, x, y + gap, w, 92, { label: 'Torque', value: d.torque, unit: 'Nm', max: 900, niceMax: true, ramp: 'hot', peak: showPk ? pk.torque : null });
            };
            if (shown('boost')) {
                const psi = settings.get('pressUnit') === 'psi', pmax = psi ? 36 : 2.5;
                G.segBar(cv, t, 24, G.TOP + 242, 1062, 226, {
                    label: 'Boost', value: P(d.boost), unit: settings.get('pressUnit'), decimals: psi ? 1 : 2, min: 0, max: pmax,
                    step: psi ? 2 : 0.125, scale: { every: psi ? 6 : 0.5, decimals: psi ? 0 : 1 }, ramp: 'hot', limit: pmax * 0.85,
                    marks: [{ value: pmax * 0.85, color: 'warn' }], peak: showPk ? P(pk.boost) : null,
                });
                if (!G.isNum(d.boost) && !usingDemo()) cv.text(boostWhy(), 48, G.TOP + 242 + 212, 22, t.dim);
                speedCard(cv, t, d, 1110, G.TOP, 466, 190);
                bars(1110, 272, 466, 132);
            } else {
                // no boost: power + torque take its place, speed + gear the whole right column
                G.panel(cv, t, 24, G.TOP + 242, 1062, 226, null);
                bars(48, G.TOP + 256, 1014, 108);
                speedCard(cv, t, d, 1110, G.TOP, 466, G.BOTTOM - G.TOP);
            }
        }
        /** Why boost is missing (Auto: tells which sources were tried). */
        function boostWhy() {
            const src = settings.get('boostSource');
            const dmeMsg = !link.p ? 'no diagnostic link' : !link.available ? 'diagnostic link down' : fuelFail.boost ? 'engine unit: no boost DID answers' : 'engine unit: reading...';
            if (src === 'fes') return bad.boostFes !== undefined ? 'sport display sends ' + G.fmt(bad.boostFes, 2) + ' - not a real value' : 'no boost from the sport display';
            if (src === 'dme') return dmeMsg;
            return 'sport display: ' + (G.isNum(live.boostFes) ? 'not changing' : 'nothing') + '  ·  ' + dmeMsg;
        }

        /**
         * Boxes for n tiles: 2 per row up to 4 tiles, 3 per row from 5; the last row's tiles share its
         * width. From 7 tiles there are three rows - too low for a graph, so stat() leaves it out.
         */
        function grid(n) {
            const per = n <= 2 ? Math.max(1, n) : n <= 4 ? 2 : 3, rows = Math.ceil(n / per), gap = 16;
            const h = (G.BOTTOM - G.TOP - gap * (rows - 1)) / rows, out = [];
            for (let r = 0; r < rows; r++) {
                const k = Math.min(per, n - r * per), w = (1552 - 24 * (k - 1)) / k;
                for (let c = 0; c < k; c++) out.push({ x: 24 + c * (w + 24), y: G.TOP + r * (h + gap), w, h });
            }
            return out;
        }
        /** min / max of a history for a tile's last line. */
        const mm = (h, f, dec, what) => {
            const v = h.filter(G.isNum);
            return v.length ? (what || 'last 5 min') + '  ·  min ' + G.fmt(f(Math.min.apply(null, v)), dec) + '  max ' + G.fmt(f(Math.max.apply(null, v)), dec) : (what || 'last 5 min');
        };
        /** Draw the tiles of a page; a page with nothing to show says so. */
        function drawTiles(cv, t, tiles) {
            if (!tiles.length) {
                G.panel(cv, t, 24, G.TOP, 1552, G.BOTTOM - G.TOP, null);
                cv.text('No data from the engine unit yet', 800, 260, 32, t.dim, { align: 'center', font: 'bold' });
                cv.text('Values show up here once the car answers. Settings: set one to Show to keep it on screen.', 800, 304, 24, t.dim, { align: 'center' });
                return;
            }
            grid(tiles.length).forEach((b, i) => {
                const g = tiles[i];
                if (g.draw) g.draw(cv, t, b.x, b.y, b.w, b.h);
                else G.stat(cv, t, b.x, b.y, b.w, b.h, Object.assign({ size: b.h > 200 ? 100 : 64 }, g));
            });
        }

        function drawThermal(cv, t, d) {
            const oilWarn = settings.get('oilWarn'), unit = tU();
            const tile = (k, label, zones, color, valueColor) => ({
                label, value: T(d[k]), unit, zones, color, valueColor, history: hist[k].map(T),
                sub: d[k] == null ? (usingDemo() ? 'no data' : k === 'egs' && !G.isNum(live.egs) ? fuelWhy('egs') : why(k)) : mm(hist[k], T, 0),
            });
            drawTiles(cv, t, [
                tile('coolant', 'Coolant', [{ from: T(112), to: 999, color: 'crit' }, { from: -99, to: T(60), color: 'cold' }]),
                tile('oil', 'Engine oil', [{ from: T(oilWarn), to: 999, color: 'crit' }, { from: -99, to: T(70), color: 'cold', tintOnly: true }], 'oil'),
                shown('gearbox') && tile('gearbox', 'Gearbox oil', [{ from: T(120), to: 999, color: 'warn' }, { from: -99, to: T(50), color: 'cold' }]),
                shown('egs') && tile('egs', 'Gearbox (EGS)', [{ from: T(120), to: 999, color: 'warn' }, { from: -99, to: T(50), color: 'cold' }]),
                tile('ambient', 'Ambient', [{ from: -99, to: T(3), color: 'cold' }], '#2fd27a', '#2fd27a'),
            ].filter(Boolean));
        }

        /** Misfires this driving cycle: the total big, each cylinder below (from OBD service 06). */
        function misfireTile(cv, t, x, y, w, h, counts) {
            G.panel(cv, t, x, y, w, h, 'Misfires');
            const ok = Array.isArray(counts) && counts.length, big = h > 200 ? 100 : 64;
            const total = ok ? counts.reduce((a, c) => a + (c || 0), 0) : null;
            const col = !ok ? t.dim : total === 0 ? GO : total < 20 ? t.warn : t.crit;
            const tw = cv.text(ok ? String(total) : '--', x + 18, y + 52 + big * 0.78, big, col, { font: 'num' });
            cv.text(ok ? 'this drive' : '', x + 28 + tw, y + 52 + big * 0.78, 24, t.dim);
            if (!ok) { cv.text(usingDemo() ? 'no data' : fuelWhy('misfire'), x + 18, y + h - 16, 22, t.dim); return; }
            // per cylinder: a cell each along the bottom, "Cyl n" over its count
            const n = counts.length, gap = 8, cw = (w - 36 - gap * (n - 1)) / n, ch = 74, cy = y + h - 12 - ch;
            counts.forEach((c, i) => {
                const cx = x + 18 + i * (cw + gap), hit = G.isNum(c) && c > 0;
                cv.roundRect(cx, cy, cw, ch, 8, withAlpha(hit ? t.warn : t.track, hit ? 0.18 : 0.9));
                cv.text((cw > 84 ? 'Cyl ' : '') + (i + 1), cx + cw / 2, cy + 26, 22, t.dim, { align: 'center', font: 'bold' });
                cv.text(G.isNum(c) ? String(c) : '-', cx + cw / 2, cy + ch - 10, 34, !G.isNum(c) ? t.dim : hit ? t.warn : t.text, { align: 'center', font: 'num' });
            });
        }

        function drawFuel(cv, t, d) {
            fuelSeen = Date.now();
            kickFuel();
            const pu = settings.get('pressUnit'), running = G.isNum(d.rpm) && d.rpm > 500;
            const val = (k) => (usingDemo() || (fuelT[k] && Date.now() - fuelT[k] < 15000) ? d[k] : null);
            const dT = (x) => (G.isNum(x) ? (settings.get('tempUnit') === 'F' ? x * 1.8 : x) : null);
            const iatRise = G.isNum(val('iat')) && G.isNum(d.ambient) ? d.iat - d.ambient : null;
            const off = running ? '' : '  ·  engine off';
            drawTiles(cv, t, [
                shown('iat') && { label: 'Intake air (IAT)', value: T(val('iat')), unit: tU(), decimals: 0, history: hist.iat.map(T),
                    zones: [{ from: T(50), to: T(65), color: 'warn' }, { from: T(65), to: 999, color: 'crit' }],
                    sub: G.isNum(val('iat')) ? mm(hist.iat, T, 0) : fuelWhy('iat') },
                shown('hpfp') && { label: 'High pressure fuel', value: P(val('hpfp')), unit: pu, decimals: 0, history: hist.hpfp.map(P),
                    zones: running ? [{ from: -99, to: P(20), color: 'crit' }] : [],
                    sub: G.isNum(val('hpfp')) ? mm(hist.hpfp, P, 0) + off : fuelWhy('hpfp') },
                shown('lpfp') && { label: 'Low pressure fuel', value: P(val('lpfp')), unit: pu, decimals: pu === 'psi' ? 0 : 1, history: hist.lpfp.map(P),
                    zones: running ? [{ from: -99, to: P(3), color: 'crit' }, { from: P(3), to: P(4), color: 'warn' }] : [],
                    sub: G.isNum(val('lpfp')) ? mm(hist.lpfp, P, 1) + off : fuelWhy('lpfp') },
                shown('iat') && { label: 'Intake air above outside', value: dT(iatRise), unit: tU(), decimals: 0, history: hist.iatRise.map(dT),
                    zones: [{ from: dT(25), to: dT(40), color: 'warn' }, { from: dT(40), to: 999, color: 'crit' }],
                    sub: G.isNum(iatRise) ? mm(hist.iatRise, dT, 0, 'heat soak') : 'needs IAT + outside temperature' },
                shown('timing') && { label: 'Ignition timing (before TDC)', value: val('timing'), unit: '°', decimals: 1, history: hist.timing,
                    sub: G.isNum(val('timing')) ? mm(hist.timing, (x) => x, 1) : fuelWhy('timing') },
                shown('misfire') && { draw: (c, th, x, y, w, h) => misfireTile(c, th, x, y, w, h, usingDemo() ? d.misfire : fuelT.misfire && Date.now() - fuelT.misfire < 30000 ? live.misfire : null) },
            ].filter(Boolean));
        }

        function drawChassis(cv, t, d) {
            chassisSeen = Date.now();
            kickFuel();
            if (G.isNum(d.gLat) && G.isNum(d.gLong)) { trail.push([d.gLat, d.gLong]); if (trail.length > 60) trail.shift(); }
            // xDrive column and tyre card when shown; the g-force card takes the space of hidden ones
            const xd = settings.get('xdrive');
            const showAwd = xd === 'on' || (xd !== 'off' && (awdSeen || usingDemo()));
            const showTyres = shown('tyres'), right = showAwd ? 1196 : 1576;
            const gw = showTyres ? 480 : right - 24;
            G.panel(cv, t, 24, G.TOP, gw, G.BOTTOM - G.TOP, 'G-force');
            G.gmeter(cv, t, 24 + gw / 2, 258, 164, { lat: d.gLat, long: d.gLong, trail, max: 1.5 });
            if (showTyres) drawTyres(cv, t, 528, G.TOP, right - 528, G.BOTTOM - G.TOP, d);
            if (showAwd) {
                const ax = 1220, aw = 356;
                G.panel(cv, t, ax, G.TOP, aw, G.BOTTOM - G.TOP, 'xDrive');
                const AWD = { _4WD_STANDARD: '4WD', _4WD_ALTERNATIV: '4WD Sport', _2WD: '2WD', AWDSAND: 'Sand' };
                const mode = AWD[d.awd] || '--';
                const hot = d.awdQual === 'FUNKTION_NICHT_VERFUEGBAR_FEHLER';
                cv.text(mode, ax + 24, 160, 52, hot ? t.crit : t.text, { font: 'bold' });
                if (hot) cv.text('DERATED / OFF', ax + 24, 196, 22, t.crit, { font: 'bold', spacing: 1.5 });
                const sp = xdriveSplit(d), rear = sp.rear;
                G.bar(cv, t, ax + 24, 262, aw - 48, 80, { label: 'Rear', value: rear, unit: '%', ramp: 'hot' });
                G.bar(cv, t, ax + 24, 392, aw - 48, 80, { label: 'Front', value: G.isNum(rear) ? 100 - rear : null, unit: '%', ramp: 'hot' });
                // where the split came from when it isn't the car's own torque split
                // under the mode: front axle torque and where the split came from, when it isn't the car's own
                const note = G.isNum(sp.nm) ? 'front ' + G.fmt(sp.nm, 0) + ' Nm (transfer case)'
                    : sp.from ? 'from ' + sp.from : !G.isNum(rear) ? 'car sends no torque split' : '';
                if (note) cv.text(note, ax + 24, 232, 20, t.dim);
            }
        }

        /** Top-down car with each tyre's pressure (against the car's target) and temperature (when shown). */
        function drawTyres(cv, t, x, y, w, h, d) {
            const temps = shown('tyreTemp');
            G.panel(cv, t, x, y, w, h, 'Tyres');
            const unitP = settings.get('pressUnit'), dec = unitP === 'psi' ? 0 : 1;
            const cx = x + w / 2, top = y + 70, bh = h - 100, bw = 150;
            // body: rounded shell, windscreen + rear window, FRONT marker
            cv.roundRect(cx - bw / 2, top, bw, bh, 52, withAlpha(t.track, 0.9));
            cv.strokeRoundRect(cx - bw / 2, top, bw, bh, 52, 3, t.tick);
            cv.roundRect(cx - bw / 2 + 18, top + bh * 0.24, bw - 36, 34, 12, withAlpha(t.tick, 0.45));
            cv.roundRect(cx - bw / 2 + 22, top + bh * 0.70, bw - 44, 26, 10, withAlpha(t.tick, 0.35));
            cv.text('FRONT', cx, top + 36, 20, t.dim, { align: 'center', font: 'bold', spacing: 1 });
            const tyw = 34, tyh = 84, big = w > 900;
            const corners = [['FL', -1, top + 30], ['FR', 1, top + 30], ['RL', -1, top + bh - 30 - tyh], ['RR', 1, top + bh - 30 - tyh]];
            for (const [k, side, ty] of corners) {
                const temp = d['t' + k], pr = Pt(d['p' + k]), tgt = Pt(d['pt' + k]);
                // pressure: big, coloured against the target
                let pc = G.isNum(pr) ? t.text : t.dim;
                if (G.isNum(pr) && G.isNum(tgt) && tgt > 0) { const r = pr / tgt; pc = r < 0.85 ? t.crit : r < 0.93 || r > 1.15 ? t.warn : GO; }
                // tyre colour: temperature, or the pressure state when temperatures are hidden
                const tc = !temps ? (G.isNum(pr) ? pc : t.tick) : !G.isNum(temp) ? t.tick : temp < 20 ? t.cold : temp > 105 ? t.crit : temp > 90 ? t.warn : t.accent;
                const tx0 = side < 0 ? cx - bw / 2 - tyw - 8 : cx + bw / 2 + 8;
                cv.roundRect(tx0, ty, tyw, tyh, 10, tc);
                for (let i = 1; i < 4; i++) cv.fillRect(tx0 + 6, ty + i * tyh / 4, tyw - 12, 2, withAlpha(t.bg, 0.35));
                const al = side < 0 ? 'right' : 'left', lx = side < 0 ? tx0 - 26 : tx0 + tyw + 26;
                const ps = G.fmt(pr, dec), size = (big ? 72 : 56) + (temps ? 0 : 16), py = ty + (temps ? 52 : 62);
                const pw = cv.text(ps, lx + (side < 0 ? -cv.textWidth(' ' + unitP, 24) : 0), py, size, pc, { align: al, font: 'num' });
                cv.text(' ' + unitP, side < 0 ? lx : lx + pw, py, 24, t.dim, { align: al });
                cv.text(G.isNum(tgt) ? 'target ' + G.fmt(tgt, dec) : 'no target', lx, py + 30, 22, t.dim, { align: al });
                if (temps) cv.text(G.isNum(temp) ? G.fmt(T(temp), 0) + tU() : '--' + tU(), lx, ty + 118, 30, G.isNum(temp) ? tc : t.dim, { align: al, font: 'bold' });
            }
        }

        async function render() {
            const t = ctx.theme(), d = data();
            const cv = ctx.canvas(W, H).clear(t.bg);
            [drawEngine, drawThermal, drawFuel, drawChassis][page](cv, t, d);
            header(cv, t);
            if (!render.n) { render.n = 1; log.info('first frame drawn'); }
            await ui.image('MAIN_GFX', cv);
        }

        ui.onClick('BTN_PAGE', () => { page = (page + 1) % PAGES.length; return render(); });
        ui.onClick('BTN_PREV', () => { page = (page + PAGES.length - 1) % PAGES.length; return render(); });
        // every screen refresh (60 fps) with the GPU renderer; 10 fps in software (PNG frames)
        ctx.loop('MAIN', 10, render);
        settings.onChange((k) => {
            if (k === 'maxPower' || k === 'powerSource') { delete peak.power; delete demoPeak.power; }
            if (k === 'boostSource') { delete peak.boost; updBoost(); }
            if (k === 'page') page = Math.max(0, PAGES.indexOf(settings.get('page')));
        });
        log.info('first render');
        const t0 = Date.now();
        render().then(() => log.info('first frame done ' + (Date.now() - t0) + ' ms')).catch((e) => log.warn('first render: ' + e));
    },
});
