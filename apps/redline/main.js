'use strict';
/**
 * Redline - full-screen rev display in the style of the G20 Live Cockpit (Sport):
 * a wide rev bar across the middle that fills left to right in slanted 500 rpm
 * segments (theme colour to red at the shift point), digital rpm above it, a big
 * gear below it, digital speed, angular frame lines. At the shift point the lights,
 * gear and a SHIFT prompt turn red (setting "flash": they blink and the screen flashes).
 *
 *   - 12 shift lights that count into the shift and strobe for it (the shift cue, below)
 *   - huge gear number (from the gearbox, or learned from rpm/speed ratios)
 *   - every upshift is scored against your shift point (EARLY / SPOT ON / LATE / LIMITER)
 *   - cold-engine rev guard: until the oil is warm the shift point is pulled down
 *     and climbs with the oil temperature
 *
 * Pages: tach / shift log / learned (what it learned from this car, with resets) / HUD looks (a live
 * preview of the HUD as set up, layouts to tap, an editor: look, items on / off, effects, place;
 * Play on HUD). The tach's
 * peak marker drops back after "Peak hold" seconds; BTN_RESET clears it and the session stats.
 *
 * Experimental parts (README.md in this folder has the whole story):
 *   hud.js       the head-up display through cluster-render, and the shift cue the HUD and this
 *                screen's lights share (count-in over ~1 s of climb, flash early by the reaction
 *                time, ended by the upshift or a lift; everything flashes on the limiter)
 *   hud-draw.js  draws the HUD image: layouts (standard, minimal, split wings), palettes, readouts
 *   limiter.js   learns the real rev limit from the rpm plateau on the limiter
 *   shiftmap.js  learns the full-load torque curve and the gear ratios, and from them the best
 *                upshift rpm for each gear
 *   gearbox.js   gearbox oil temperature for the HUD (EGS over read-only UDS, or BasicDataSet)
 *   knock.js     knock retard from the engine unit for the HUD's knock warning and readout (read-only UDS)
 *   fuel.js      fuel use from the engine unit for the HUD's fuel readout (read-only UDS / OBD)
 *   powerlog.js  the car's own power and fuel displays, logged raw while those readouts are on (scale learning)
 *   electrical.js  12 V and hybrid battery readouts for the HUD (car signals and read-only UDS)
 *   tyres.js     tyre pressures, targets and temperatures from the car's signals (Redline's own reading)
 *   hud-tyres.js the tyre widget: the car from above with its four tyres, in the directions' corner
 *   cluster_render_client.js  vendored unchanged from robertnisipeanu/idrive-apps (MPL-2.0)
 *
 * The limits, first that has one:
 *   redline     the "Redline" setting > the learned limiter > the engine profile
 *   shift point the per-gear learned point (held 150 under the redline) > redline - "Shift point
 *               before redline"; then "Minimum shift point" as a floor; then the cold guard,
 *               which can lower it below the floor while the oil is cold
 *
 * Rules for this code (the head unit): Node 8 (no ?. ?? object spread, flat, fromEntries); never
 * let an error escape a timer, signal or render (an app that exits gets its data wiped by MainApp,
 * twice: uninstalled); the tach and Learned pages draw on the kit's Recorder (record.js), whose
 * methods differ from canvas.js (no convex/triangle: use quad), the HUD on a Canvas; nothing is
 * learned from the demo drive.
 */
const mgu = require('./kit/mgu');
const { withAlpha, ramp } = require('./kit/canvas');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const Engine = require('./kit/engine');
const Hud = require('./hud');
const HudDraw = require('./hud-draw');
const GearboxTemp = require('./gearbox');
const KnockWatch = require('./knock');
const FuelWatch = require('./fuel');
const TwinDme = require('./kit/twin_dme');
const PowerLog = require('./powerlog');
const Electrical = require('./electrical');
const Tyres = require('./tyres');
const QuietLog = require('./quietlog');
const HudTyres = require('./hud-tyres');
const LaunchScore = require('./launch');
const Limiter = require('./limiter');
const ShiftMap = require('./shiftmap');
const { ShiftShare } = require('./shareshift');
const LogView = require('./logview');
const Call = require('./call');
const Sheet = require('./kit/sheet');

const W = 1600, H = 520;
// rev bar (G20 style): left to right, slanted segments; top edge shifted right by 'slant'
const BAR = { x0: 400, x1: 1200, y0: 213, y1: 275, slant: 22 };
const GX = 800;                                     // centre column (rpm, bar, gear)
const MPH = 1.609344;
const GREEN = '#2fd27a', YELLOW = '#ffc21a', BLUE = '#2a7dff';
const N_LEDS = 12;
// MDrive.dataDisplayGearbox programmes (names or wire numbers), as in Car Vitals
// the ambient light's flash at the shift point: Ambient config shows it (its setting "Redline shift flash")
const AMBIENT_FLASH = process.env.MGU_AMBIENT_FLASH || '/dev/shm/mgu-ambient-flash.json';
const PROGRAMS = { S_MINUS_PROGRAMM: 'S', M_MINUS_PROGRAMM: 'M', 1: 'S', 2: 'M' };

/**
 * HUD settings renamed or split, carried over once (the old keys are then dropped from settings.json):
 *   1.18: "Gear on HUD" + "Temperatures on HUD" -> "Shows" (hudContent); "Shift lights on HUD" + its
 *         style -> "Shift lights" (hudLightStyle with 'off');
 *   1.23: "Shows" -> a switch each for the gear and every temperature and the cold limit.
 */
function migrateSettings(settings, log) {
    try {
        const v = settings.values || {};
        if ('hudGear' in v || 'hudTemps' in v || 'hudLights' in v) {
            const gear = v.hudGear !== 'off', temps = v.hudTemps !== false;
            v.hudContent = gear && temps ? 'all' : gear ? 'gear' : temps ? 'temps' : 'tach';
            settings.set('hudLightStyle', v.hudLights === false ? 'off' : v.hudLightStyle === 'bar' ? 'bar' : 'gt3');
            delete v.hudGear; delete v.hudTemps; delete v.hudLights;
        }
        if ('hudContent' in v) {
            const c = v.hudContent, gear = c !== 'temps' && c !== 'tach', temps = c !== 'gear' && c !== 'tach';
            delete v.hudContent;
            ['hudShowOil', 'hudShowWater', 'hudShowGearbox', 'hudShowLimit'].forEach((k) => { v[k] = temps; });
            settings.set('hudShowGear', gear);
            log.info('settings: HUD "Shows ' + c + '" carried over to the readout switches');
        }
    } catch (e) { log.warn('settings migration: ' + e); }
}

mgu.run({
    async start(ctx) {
        // redline.log kept small: the same kind of line at most every 10 minutes (quietlog.js); every part
        // below logs through this
        ctx.log = QuietLog.wrap(ctx.log);
        const { ui, settings, log } = ctx;
        migrateSettings(settings, log);
        // engine profile (diesel / petrol): rev scale top and the Auto redline / cold limit
        const engine = new Engine({ settings, dataDir: ctx.dataDir, log });
        // gearbox oil temperature for the HUD (EGS over UDS, or BasicDataSet); polled only while the HUD is on
        const gearbox = new GearboxTemp(ctx);
        // knock from the engine unit, on the gearbox reader's diagnostics link; polled only while the HUD wants it
        // (a V8 with a second engine unit at 0x13: bank 2's read too, kit/twin_dme.js)
        // (its VIN's maker code too, once: N63 or an M car's S63 / S68, for the Auto redline below)
        const twin = new TwinDme(() => gearbox.diag(), { dataDir: ctx.dataDir, log, vin: true });
        engine.setAuto(twin.redline);
        const knock = new KnockWatch(ctx, () => gearbox.diag(), { twin });
        // fuel use from the engine unit, the same link; polled only while the fuel readout is on and the engine runs
        const fuel = new FuelWatch(ctx, () => gearbox.diag(), { diesel: () => engine.profile() === 'diesel', twin });
        // 12 V and hybrid battery from the car (signals, and read-only UDS on the same link); hybrid ones only on a hybrid
        const electrical = new Electrical(ctx, () => gearbox.diag());
        // tyre pressures, targets and temperatures from the car's own signals (no requests to any unit)
        const tyres = new Tyres(log, settings);
        // engine torque for the shift map, with its time: put() keeps the last value when the signal
        // goes invalid, so a stale torque would be paired with new rpm and inflate the curve
        const torque = { v: null, t: 0 };
        // boost from the iDrive sport display (bar, raw x 0.01, 255 = none), for the HUD; shown only once
        // it has moved (some cars send a constant), as Car Vitals does
        const boost = { v: null, t: 0, first: null, moved: false };
        const gearMode = { v: null, seen: [] };
        const driveMode = { v: null, seen: [] };
        /** 'M' (shifting by hand), 'S', 'D', or null when the car hasn't said (then nothing is held back). */
        const modeNow = () => (gearMode.v && !car.data().demo ? gearMode.v : null);
        // the HUD's extra readouts, as Live Data scales them: g sideways and forward, outside
        // temperature (°C); each { v, t }, used while under 2 s old (outside: 10 min). (The accelerator
        // pedal is left out until its scaling is checked: Live Data's guess read 60-96 % at a light touch.)
        const extra = { gLat: { v: null, t: 0 }, gLong: { v: null, t: 0 }, outside: { v: null, t: 0 } };
        const keep = (e, v) => { e.v = v; e.t = Date.now(); };
        const fresh = (e, ms) => (e.v !== null && Date.now() - e.t < ms ? e.v : null);
        const G0 = 9.80665;
        const torqueWatch = { 'de.bmw.infotainment.drivingexcitement.FES': {
            statusActualValueTorque2: (v) => {
                const raw = v && v.actualValueTorqueCrankshaft;
                if (typeof raw === 'number' && raw < 4095) { torque.v = Math.max(0, raw * 0.5 - 1023.5); torque.t = Date.now(); }
            },
            // the driving mode (Sport / Comfort / Eco Pro), for "In Comfort / Eco Pro" on the HUD
            statusFESVehicleDynamicSwitchHMI: (v) => {
                const raw = v && v.actualValueModeDrivingExperience, m = Hud.driveModeOf(raw);
                // a value that isn't a mode (as the car switches off) keeps the last one: read as Sport, it put the
                // tach back on the HUD in Comfort just as the cluster went off (issue #141)
                if (m) driveMode.v = m;
                if (driveMode.seen.indexOf(String(raw)) < 0 && driveMode.seen.length < 16) { driveMode.seen.push(String(raw)); log.info('driving mode: ' + JSON.stringify(raw) + ' -> ' + (m || 'not a mode, ' + (driveMode.v || 'none') + ' kept')); }
            },
            statusSwitchDriveDynamicSport2: (v) => {
                const raw = v && v.displayBoostPressure;
                if (typeof raw !== 'number' || raw === 255 || raw < 0) return;
                if (boost.first === null) boost.first = raw; else if (raw !== boost.first) boost.moved = true;
                // in the car's pressure unit, as BMW's sport display shows it: 0.01 bar (or 1 kPa) a step, 0.1 psi a step on
                // a car set to psi (issue #186: 20 psi sent as raw 200 read as 2.0 bar, 29 psi)
                boost.v = tyres.units.press === 'PSI' ? raw * 0.1 / 14.5038 : raw * 0.01; boost.t = Date.now();
            },
        },
        'de.bmw.infotainment.vehicle.CDS2': {
            statusLateralAccelerationMassCenter: (v) => { const raw = v && v.lateralAccelerationCentreOfGravity; if (typeof raw === 'number' && raw !== 65535) keep(extra.gLat, (raw * 0.002 - 65) / G0); },
            statusLongitudinalAccelerationMassCenter: (v) => { const raw = v && v.longitudinalAccelerationCentreOfGravity; if (typeof raw === 'number' && raw !== 65535) keep(extra.gLong, (raw * 0.002 - 65) / G0); },
        },
        'de.bmw.infrastructure.EnvironmentalInformation': {
            ExteriorTemperature: (v) => { const raw = v && v.temperatureExterior; if (typeof raw === 'number' && raw !== 255) keep(extra.outside, raw * 0.5 - 40); },
        },
        // the gearbox programme the cluster shows by the gear (S / M, else D), as Car Vitals reads it
        'de.bmw.infotainment.misc.MDrive': {
            dataDisplayGearbox: (v) => {
                const raw = v && v.displayProgramGearbox;
                // S / M as Car Vitals reads them; D only from a value that says so (0 or a D... name);
                // anything else is unknown, which holds nothing back
                gearMode.v = PROGRAMS[raw] || (raw === 0 || /^D/i.test(String(raw)) ? 'D' : null);
                if (gearMode.seen.indexOf(String(raw)) < 0 && gearMode.seen.length < 12) { gearMode.seen.push(String(raw)); log.info('gearbox programme: ' + JSON.stringify(raw) + ' -> ' + gearMode.v); }
            },
        } };
        let car = null;
        // the car's own power / fuel displays, logged raw for a drive while the readouts that would use them are on
        const powerLog = PowerLog.start({
            dataDir: ctx.dataDir,
            // only while the HUD is on and the setup in use (Sport or Comfort's own) shows the fuel readout or the
            // power bar (2026-11-10 review: it logged with the HUD off, and went by Sport's switches only)
            wanted: () => { if (settings.get('hud') !== 'on') return false; const o = Hud.optsFrom(settings, driveMode.v || 'sport'); return !!(o.fuel || o.hvBar); },
            now: () => ({ hvKw: electrical.value().hvKw, lph: fuel.value().lph, kmh: car ? car.data().speed : null }),
        });
        // one watch per interface: handler sets that share an interface are merged field by field (a plain
        // Object.assign would drop one: electrical.js and the power log both listen to Efficiencytainment2)
        // the phone ringing: the HUD tach steps aside for BMW's call card (issue #181)
        const call = Call.start({ log });
        const merged = {};
        [{ [Engine.SIGNAL[0]]: engine.handlers() }, gearbox.handlers(), electrical.handlers(), tyres.handlers(), torqueWatch, powerLog.handlers(), call.handlers()].forEach((set) => {
            Object.keys(set).forEach((iface) => { merged[iface] = Object.assign(merged[iface] || {}, set[iface]); });
        });
        car = new Car(ctx, ['rpm', 'speed', 'temps', 'gear', 'condition'], merged);

        /* ---------- derived limits ----------
         * Redline, first that has one: the "Redline" setting, the limit learned from the limiter
         * (limiter.js, setting "learnRedline"), the engine's own (a V8's, kit/twin_dme.js), the engine profile.
         * The scale's top follows it. */
        const limiter = new Limiter({ dataDir: ctx.dataDir, log });
        // setting "learn": off freezes all learning (redline, torque curve and ratios, reaction time);
        // what was learned is kept and still used
        const learning = () => settings.get('learn') !== false;
        const manualRedline = () => { const v = settings.get('redline'); return typeof v === 'number' && v > 0 ? v : 0; };
        const learned = () => (settings.get('learnRedline') !== false ? limiter.value() : null);
        const profileRedline = () => Engine.PROFILES[engine.profile()].redline;
        const redlineSource = () => (manualRedline() ? 'manual' : learned() ? 'learned' : engine.auto && engine.profile() === 'petrol' ? 'V8' : 'profile');
        const baseRedline = () => manualRedline() || learned() || engine.redline();
        const maxRpm = () => {
            const s = settings.get('rpmScale');
            return typeof s === 'number' && s > 0 ? s : Math.ceil((baseRedline() + 800) / 1000) * 1000;
        };
        const redline = () => Math.min(baseRedline(), maxRpm());
        settings.onChange((key, v) => { if (key === 'learnRedline' && v === false) limiter.forget(); });
        log.info('redline ' + redline() + ' (' + redlineSource() + ')');
        /* Shift point: per gear from the engine's own torque curve and the gear ratios (shiftmap.js,
         * setting "shiftMode" = learned) once it knows that gear, held 150 under the redline so the
         * shift never meets the limiter; else (and with "fixed") the redline minus "shiftBefore".
         * Never below 2500: shifts under that are not scored. */
        const shiftMap = new ShiftMap({ dataDir: ctx.dataDir, log });
        // the launch score: standing starts timed 0-100 km/h / 0-60 mph by the kit's run timer, best kept
        const launch = new LaunchScore({ dataDir: ctx.dataDir, log });
        const launchIdle = setInterval(() => { if (!car.data().demo) launch.idle(Date.now()); }, 100);
        if (launchIdle.unref) launchIdle.unref();
        shiftMap.setRedline(redline());
        const learnedShift = (gear) => {
            if (settings.get('shiftMode') === 'fixed' || !G.isNum(gear) || gear < 1) return null;
            const r = shiftMap.shiftFor(gear);
            return G.isNum(r) ? Math.min(r, redline() - 150) : null;     // clear of the limiter flash (redline - 40)
        };
        const minShift = () => { const v = settings.get('minShift'); return typeof v === 'number' && v > 0 ? Math.min(v, redline() - 150) : 0; };
        const normalShift = (gear) => Math.max(2500, minShift(), learnedShift(gear) || redline() - settings.get('shiftBefore'));
        const limitsChanged = () => { car.setRedline(redline()); shiftMap.setRedline(redline()); };
        limitsChanged();
        engine.onChange(limitsChanged);
        limiter.onChange(limitsChanged);
        // a V8's own Auto redline once known (asked over the diagnostics link only while it is open anyway)
        const twinRed = setInterval(() => { if (gearbox.link) twin.on(); engine.setAuto(twin.redline); }, 5000);
        if (twinRed.unref) twinRed.unref();
        /** shift point right now for that gear (lowered while the oil is cold). */
        function shiftPoint(oil, gear) {
            const n = normalShift(gear);
            if (!settings.get('coldGuard') || !G.isNum(oil)) return { rpm: n, cold: false };
            const warm = settings.get('warmOil'), cold = Math.min(engine.value('coldLimit', { diesel: 3000, petrol: 4500 }), n);
            if (oil >= warm) return { rpm: n, cold: false };
            const f = G.clamp((oil - 30) / (warm - 30), 0, 1);
            return { rpm: Math.round((cold + (n - cold) * f) / 50) * 50, cold: true };
        }

        /* ---------- session state ---------- */
        // peakRpm = the tach's peak marker: drops back to the current rpm "peakHold" s after the last
        // new peak (0 = until Reset); the shift log's session peaks stay until Reset
        let peakRpm = 0, peakRpmT = 0, sessionRpm = 0, peakSpeed = 0, limiterHits = 0;
        let shifts = [];                    // { at, from, to, rpm, target, verdict }
        const recent = [];                  // [t, rpm, speed] last ~1 s
        let lastGear = null, onLimiter = false, lastShift = null, hud = null;
        const cueState = {};
        let screenCue = null, cueShift = false, slowingUntil = 0, lastRpmVal = null, lastRpmChange = 0;

        /*
         * Downshift cue: how many gears (0..3) you can drop now without the revs passing that gear's
         * shift point (300 rpm margin): the rpm after a downshift is the speed times that gear's
         * learned rpm per km/h. Setting "downCue": while slowing (default), always, off.
         */
        function downshift() {
            const mode = settings.get('downCue') || 'slowing', d = car.data();
            if (mode === 'off' || d.demo || !G.isNum(d.gear) || d.gear < 2 || !(d.speed > 10)) return 0;
            if (mode === 'slowing' && Date.now() > slowingUntil) return 0;
            const gm = modeNow();
            if (mode === 'slowing' && (gm === 'D' || gm === 'S')) return 0;
            if (!shiftMap.ratio(d.gear)) return 0;
            let n = 0;
            for (let g = d.gear - 1; g >= 1 && n < 3; g--) {
                const k = shiftMap.ratio(g);
                if (!k || d.speed * k > shiftPoint(d.oil, g).rpm - 300) break;
                n++;
            }
            // "Best gear": only as far as the power band (setting "downTarget"); "Every gear": all that fit
            if (settings.get('downTarget') !== 'best') return n;
            return ShiftMap.bestDrop(d.gear, n, (g) => d.speed * (shiftMap.ratio(g) || 0), shiftMap.bandStart(0.9));
        }
        // LIMITER: on the cut itself (25 rpm): shift points sit 150 under the redline, so the old 60 caught
        // shifts on the point
        const verdict = (rpm, target, cold) => (rpm >= redline() - 25 ? 'LIMITER' : rpm < target - 250 ? 'EARLY' : rpm > target + 200 ? (cold ? 'COLD REV' : 'LATE') : 'SPOT ON');
        // only shifts aimed at the shift point are graded: the revs within GRADE_FROM of it (where the
        // shift lights count in) and shifted by hand; the rest are logged as CRUISE (an everyday shift
        // well below the point) or AUTO (the gearbox shifted, in D or S) and left out of the accuracy
        const GRADE_FROM = 1500;
        const gradeOf = (rpm, sp, mode) => (mode === 'D' || mode === 'S' ? 'AUTO' : rpm < sp.rpm - GRADE_FROM ? 'CRUISE' : verdict(rpm, sp.rpm, sp.cold));
        const graded = (s) => s.verdict !== 'CRUISE' && s.verdict !== 'AUTO';
        const VCOL = { 'SPOT ON': GREEN, EARLY: YELLOW, LATE: '#ff8a1a', LIMITER: '#ff2a2a', 'COLD REV': '#3d8bff', CRUISE: '#8a8f98', AUTO: '#8a8f98' };

        /*
         * The live shift values for other apps (shareshift.js, /dev/shm/redline/shift.json; bimmer-lab/apps#4): about
         * once a second, and at each shift (force). Never from the demo drive. Every gear 1-8 has a point (learned, or
         * the redline less "Shift point before redline" until it is).
         */
        const shiftShare = new ShiftShare({ log });
        function shareShift(force) {
            const d = car.data();
            if (d.demo) return;
            const pts = {};
            [1, 2, 3, 4, 5, 6, 7, 8].forEach((g) => { pts[g] = normalShift(g); });
            const sp = G.isNum(d.gear) && d.gear > 0 ? shiftPoint(d.oil, d.gear) : null;
            shiftShare.write({
                redline: redline(), shiftPoints: pts, gear: G.isNum(d.gear) ? d.gear : null,
                shiftNow: sp ? sp.rpm : null, cold: sp ? sp.cold : false, leadMs: hud ? hud.lead() : null, mode: modeNow(),
                lastShift: lastShift ? { at: lastShift.at, from: lastShift.from, to: lastShift.to, rpm: lastShift.rpm, target: lastShift.target, verdict: lastShift.verdict } : null,
            }, force);
        }

        function recordShift(t, from, to) {
            const win = recent.filter((r) => t - r[0] < 600);
            const rpm = Math.max.apply(null, win.map((r) => r[1]));
            if (!(rpm > 2500)) return;
            const sp = shiftPoint(car.data().oil, from);
            const gm = modeNow();
            lastShift = { at: Date.now(), from, to, rpm: Math.round(rpm), target: sp.rpm, verdict: gradeOf(rpm, sp, gm), mode: gm };
            if (hud && learning() && !car.data().demo) hud.upshift(rpm);         // never learn from the demo drive
            shifts.unshift(lastShift);
            shifts = shifts.slice(0, 60);
            log.debug('shift ' + from + '->' + to + ' @' + lastShift.rpm + ' ' + lastShift.verdict);
            shareShift(true);
        }

        car.onSample((d, t) => {
            if (!G.isNum(d.rpm)) { screenCue = null; Hud.shiftCue(cueState, null, t, 0, 0, 0); return; }
            recent.push([t, d.rpm, d.speed]);
            while (recent.length && t - recent[0][0] > 1200) recent.shift();
            // the screen's shift cue, the same as the HUD's (count-in by climb rate, early flash,
            // lift handling), updated on each sample so a fast screen doesn't see repeated readings
            screenCue = Hud.shiftCue(cueState, d.rpm, t, shiftPoint(d.oil, d.gear).rpm, redline(), hud ? hud.lead() : 200, d.gear, undefined, Hud.revOf(settings));
            // the moment the cue flashes: the ambient light flashes red too (real drives only)
            if (screenCue.shift && !cueShift && !car.data().demo) Hud.writeAtomic(AMBIENT_FLASH, JSON.stringify({ rgb: [255, 0, 0], ms: 1200 }) + '\n');
            cueShift = !!screenCue.shift;
            // slowing (for the downshift cue): braking, down at least 6 km/h per second (~0.17 g) over
            // the last 0.5 s; coasting off the throttle stays under it
            const back = recent.find((r) => t - r[0] <= 500);
            if (back && G.isNum(back[2]) && G.isNum(d.speed) && t - back[0] >= 300 && (back[2] - d.speed) * 1000 / (t - back[0]) >= 6) slowingUntil = Date.now() + 800;
            const now = Date.now(), hold = settings.get('peakHold') * 1000;
            if (d.rpm >= peakRpm || (hold > 0 && now - peakRpmT > hold)) { peakRpm = d.rpm; peakRpmT = now; }
            sessionRpm = Math.max(sessionRpm, d.rpm);
            if (G.isNum(d.speed)) peakSpeed = Math.max(peakSpeed, d.speed);
            const lim = d.rpm >= redline() - 60;
            if (lim && !onLimiter) limiterHits++;
            onLimiter = lim;
            // learn the real limit (live data only, warm oil): plateaus from 1000 below the profile's redline
            if (!car.data().demo) {
                if (G.isNum(d.speed)) launch.feed(t, d.speed);
                const tq = Date.now() - torque.t < 300 ? torque.v : null;
                if (learning()) shiftMap.feed(t, { rpm: d.rpm, speed: d.speed, gear: d.gear, torque: tq });
                const pr = profileRedline();
                if (d.rpm !== lastRpmVal) { lastRpmVal = d.rpm; lastRpmChange = Date.now(); }
                const rpmFresh = Date.now() - lastRpmChange < 300;
                if (rpmFresh && learning() && settings.get('learnRedline') !== false) limiter.feed(t, { rpm: d.rpm, gear: d.gear, speed: d.speed, warm: G.isNum(d.oil) && d.oil >= settings.get('warmOil') }, pr - 1000, pr + 1500);
            }

            // upshift: gear number goes up, or (no gear signal) rpm falls >18 % within 0.4 s while still moving
            const g = d.gear;
            if (G.isNum(g) && g > 0 && G.isNum(lastGear) && lastGear > 0 && g === lastGear + 1) recordShift(t, lastGear, g);
            else if (!G.isNum(g) && recent.length > 4 && d.speed > 10) {
                const back = recent.filter((r) => t - r[0] < 400);
                const hi = Math.max.apply(null, back.map((r) => r[1]));
                if (hi > 3000 && d.rpm < hi * 0.82 && (!lastShift || Date.now() - lastShift.at > 800)) recordShift(t, '?', '?');
            }
            if (G.isNum(g)) lastGear = g;
            shareShift(false);
        }, () => { recent.length = 0; lastGear = null; screenCue = null; Object.keys(cueState).forEach((k) => { delete cueState[k]; }); });

        /* ---------- rev bar geometry + static background (cached) ---------- */
        const BW = BAR.x1 - BAR.x0 - BAR.slant, BH = BAR.y1 - BAR.y0;
        const barX = (rpm) => G.clamp(rpm / maxRpm(), 0, 1) * BW;                          // along the bar
        const off = (y) => BAR.slant * (BAR.y1 - y) / BH;                                   // slant at height y
        /** Fill the slanted band between rpm a and b (one anti-aliased quad). */
        function band(cv, a, b, col, pad) {
            pad = pad || 0;
            const xa = BAR.x0 + barX(a), xb = BAR.x0 + barX(b), y0 = BAR.y0 - pad, y1 = BAR.y1 + pad;
            if (xb - xa <= 0) return;
            cv.quad([[xa + off(BAR.y0) - pad, y0], [xb + off(BAR.y0) + pad, y0], [xb + off(BAR.y1) + pad, y1], [xa + off(BAR.y1) - pad, y1]], col);
        }
        /** Slanted 3 px gap at rpm r (segment separator). */
        function gapAt(cv, r, col) {
            const x = BAR.x0 + barX(r);
            cv.quad([[x + off(BAR.y0) - 1.5, BAR.y0], [x + off(BAR.y0) + 1.5, BAR.y0], [x + off(BAR.y1) + 1.5, BAR.y1], [x + off(BAR.y1) - 1.5, BAR.y1]], col);
        }
        /** Static part of the tach page (cached layer; redrawn when the theme / limits change). */
        function background(cv, t) {
            // the shift mark is drawn over it (per gear and cold-oil step: a key each would fill the cache)
            const key = ['redline-bg', settings.get('theme'), maxRpm(), redline()].join('|');
            cv.blit(G.layer(key, W, H, (c) => drawBackground(c, t), cv.textScale), 0, 0);
        }
        function drawBackground(cv, t) {
            cv.clear(t.bg);
            // angular frame lines (the G20's outline) around the centre
            const fl = withAlpha(t.tick, 0.55);
            cv.polyline([[24, 92], [330, 92], [370, 122], [1230, 122], [1270, 92], [1576, 92]], 2, fl);
            cv.polyline([[370, 122], [1230, 122]], 3, withAlpha(t.accent, 0.5));
            cv.polyline([[24, 512], [330, 512], [370, 486], [1230, 486], [1270, 512], [1576, 512]], 2, fl);
            // track, redline part tinted, segment gaps
            band(cv, 0, redline(), t.track);
            band(cv, redline(), maxRpm(), withAlpha(t.crit, 0.3));
            for (let r = 500; r < maxRpm(); r += 500) gapAt(cv, r, t.bg);
            // scale under the bar: ticks every 500, numbers every 1000; shift point + redline marks
            for (let rpm = 0; rpm <= maxRpm(); rpm += 500) {
                const x = BAR.x0 + barX(rpm), major = rpm % 1000 === 0, red = rpm >= redline();
                cv.fillRect(x - (major ? 1.5 : 1), BAR.y1 + 8, major ? 3 : 2, major ? 14 : 8, red ? t.crit : major ? t.text : t.tick);
                if (major) cv.text(String(rpm / 1000), x, BAR.y1 + 46, 26, red ? t.crit : t.text, { align: 'center', font: 'bold' });
            }
            const rx = BAR.x0 + barX(redline());
            cv.fillRect(rx + BAR.slant - 2, BAR.y0 - 14, 4, 12, t.crit);
        }

        /* ---------- drawing ---------- */
        const mph = () => settings.get('speedUnit') === 'mph';
        // temperatures and torque in the units chosen in Settings (the HUD uses the same settings)
        const temp = (c) => (G.isNum(c) && settings.get('hudTempUnit') === 'f' ? c * 9 / 5 + 32 : c);
        // torque: [factor from Nm, unit, curve top rounded to, grid step (none: the chart picks)] (1 Nm = 0.737562 lb-ft = 1 / 9.80665 kgm)
        const TQ_UNITS = { nm: [1, 'Nm', 100], lbft: [0.737562, 'lb-ft', 100], kgm: [1 / 9.80665, 'kgm', 10, 10] };
        const tqUnit = () => TQ_UNITS[settings.get('hudTorqueUnit')] || TQ_UNITS.nm;
        let page = 0;

        function ledColors(t) {
            const st = settings.get('lights');
            return Array.from({ length: N_LEDS }, (_, i) => {
                const f = i / (N_LEDS - 1);
                if (st === 'mono') return t.accent;
                if (st === 'f1') return f < 0.42 ? GREEN : f < 0.84 ? '#ff2a2a' : BLUE;
                return f < 0.42 ? GREEN : f < 0.75 ? YELLOW : '#ff2a2a';
            });
        }

        /** The 12 lights: they count from cue.from to cue.at and strobe while cue.shift (the HUD's cue). */
        function shiftLights(cv, t, rpm, cue, on) {
            const cols = ledColors(t);
            const x0 = GX - 330, w = 660, gap = 10, lw = (w - gap * (N_LEDS - 1)) / N_LEDS, y = 48, h = 30;
            const lit = G.isNum(rpm) && !cue.shift ? Math.ceil(G.clamp((rpm - cue.from) / (cue.at - cue.from), 0, 1) * (N_LEDS - 1)) : 0;
            const strobe = cue.shift;
            for (let i = 0; i < N_LEDS; i++) {
                const x = x0 + i * (lw + gap);
                let c = withAlpha(cols[i], 0.12);
                if (strobe) c = on ? (settings.get('lights') === 'f1' ? BLUE : '#ff2a2a') : withAlpha('#ff2a2a', 0.15);
                else if (i < lit) c = cols[i];
                if ((strobe && on) || (!strobe && i < lit)) cv.roundRect(x - 4, y - 4, lw + 8, h + 8, 10, withAlpha(c, 0.25));
                cv.roundRect(x, y, lw, h, 7, c);
            }
            return strobe;
        }

        // shift blink (setting "flash"): in software it alternates every frame, so it always
        // shows (a clock-based phase could land on 'off' frame after frame)
        let blink = false;

        function drawTach(cv, t, d, now) {
            const sp = shiftPoint(d.oil, d.gear);
            background(cv, t);
            const sx = BAR.x0 + barX(sp.rpm);                                                   // shift point mark
            cv.fillRect(sx + BAR.slant - 2, BAR.y0 - 14, 4, 12, t.warn);
            const rpm = d.rpm;
            // the cue from the last sample; before any sample, the plain shift point
            const cue = screenCue || Hud.shiftCue({}, rpm, now, sp.rpm, redline(), 0, undefined, undefined, Hud.revOf(settings));
            const shiftNow = G.isNum(rpm) && cue.shift;
            // setting "flash" on: lights, gear and SHIFT blink (GPU renderer: 8 Hz clock phase;
            // software, few fps: alternate every frame) and the screen flashes red. Off: they
            // just turn solid red at the shift point, nothing blinks.
            const flash = settings.get('flash');
            blink = shiftNow && flash ? (ctx.display.active() ? Math.floor(now / 62) % 2 === 0 : !blink) : false;
            const redNow = shiftNow && (!flash || blink);
            shiftLights(cv, t, rpm, cue, redNow);
            if (shiftNow && flash && blink) {
                cv.gradientRect(0, 0, W, H, [[0, withAlpha(t.crit, 0.55)], [0.5, withAlpha(t.crit, 0.22)], [1, withAlpha(t.crit, 0.5)]]);
                const fr = withAlpha('#ff2a2a', 0.9);                                            // red frame
                cv.fillRect(0, 0, W, 8, fr); cv.fillRect(0, H - 8, W, 8, fr); cv.fillRect(0, 8, 8, H - 16, fr); cv.fillRect(W - 8, 8, 8, H - 16, fr);
            }

            // ---- rev bar: left to right; theme colour -> red at the shift point, solid red above.
            // Each 500 rpm segment takes the colour of its position (stepped like the G20).
            const hot = t.hotRamp || t.ramp;
            if (G.isNum(rpm) && rpm > 50) {
                const colOf = (r) => (shiftNow ? '#ff2a2a' : ramp(hot, G.clamp(r / sp.rpm, 0, 1)));
                band(cv, 0, rpm, withAlpha(colOf(rpm), 0.14), 7);                               // glow
                const top = Math.min(rpm, maxRpm());                                           // a garbage rpm stays one bar
                for (let r = 0; r < top; r += 500) band(cv, r, Math.min(top, r + 500), colOf(r + 250));
                for (let r = 500; r < top; r += 500) gapAt(cv, r, t.bg);
                const x = BAR.x0 + barX(rpm);
                cv.line(x, BAR.y1 + 4, x + BAR.slant, BAR.y0 - 4, 6, '#ffffff');               // bright leading edge
            }
            // peak: a slanted line across the bar at the highest rpm (no line along the top on the tach)
            if (peakRpm > 0 && !(G.isNum(rpm) && rpm >= peakRpm)) {
                const pk = Math.min(peakRpm, maxRpm()), px = BAR.x0 + barX(pk);
                const pc = t.hang || (pk >= sp.rpm ? '#ff2a2a' : ramp(hot, G.clamp(pk / sp.rpm, 0, 1)));
                cv.line(px + BAR.slant, BAR.y0, px, BAR.y1, 3, pc);
            }

            // ---- centre: digital rpm above the bar, gear below it
            const rw = cv.text(G.isNum(rpm) ? String(Math.round(rpm / 10) * 10) : '----', GX - 30, 198, 80, G.isNum(rpm) ? (shiftNow ? '#ff4a4a' : t.text) : t.dim, { align: 'center', font: 'num' });
            cv.text('RPM', GX - 30 + rw / 2 + 12, 198, 22, t.dim, { font: 'bold', spacing: 2 });
            // gear number when driving; the selector position (P / R / N, D while no gear is engaged)
            // otherwise - the gear field alone reads "N" in park too
            const g = d.gear, st = d.stage;
            const gs = st === 'P' || st === 'R' || st === 'N' ? st : g === -1 ? 'R' : G.isNum(g) && g > 0 ? String(g) : st === 'D' ? 'D' : g === 0 ? 'N' : '-';
            cv.text(gs, GX, 500, 200, redNow ? '#ff2a2a' : t.text, { align: 'center', font: 'gear' });
            Hud.drawDown(cv, GX + 120, 470, downshift(), 2);                                // downshift cue
            if (d.gearGuessed && G.isNum(g) && g > 0) cv.text('EST.', GX + 90, 352, 22, t.dim, { font: 'bold', spacing: 1 });
            if (shiftNow) cv.text('SHIFT', GX + 150, 436, 30, redNow ? '#ff2a2a' : withAlpha('#ff2a2a', 0.5), { font: 'bold', spacing: 3 });

            // ---- left: digital speed, temperatures, cold oil, stats
            const spd = G.hold('speed', d.speed, 1000 / settings.get('speedRate'));     // setting: 10/s by default, 5 like the cluster .. 60
            const v = G.isNum(spd) ? (mph() ? spd / MPH : spd) : null;
            cv.text('SPEED', 40, 156, 22, t.dim, { font: 'bold', spacing: 1.5 });
            const vw = cv.text(G.fmt(v, 0), 36, 276, 116, G.isNum(v) ? t.text : t.dim, { font: 'num' });
            cv.text(mph() ? 'mph' : 'km/h', 46 + vw, 276, 26, t.dim);
            cv.fillRect(40, 298, 300, 1, withAlpha(t.tick, 0.6));
            const warm = settings.get('warmOil'), coldOil = G.isNum(d.oil) && d.oil < warm;
            const oilCol = !G.isNum(d.oil) ? t.dim : d.oil < 60 ? t.cold : coldOil ? YELLOW : d.oil > 130 ? t.crit : t.text;
            cv.text('OIL', 40, 334, 22, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text(G.fmt(temp(d.oil), 0) + (G.isNum(d.oil) ? '°' : ''), 40, 376, 40, oilCol, { font: 'bold' });
            cv.text('WATER', 190, 334, 22, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text(G.fmt(temp(d.coolant), 0) + (G.isNum(d.coolant) ? '°' : ''), 190, 376, 40, t.text, { font: 'bold' });
            // cold oil is always shown: with the guard on it also lowers the shift point
            if (coldOil) {
                cv.roundRect(40, 392, 300, 36, 8, withAlpha(t.cold, 0.2));
                cv.text(sp.cold ? 'COLD  ·  LIMIT ' + sp.rpm : 'OIL COLD  ·  GO EASY', 190, 418, 22, t.cold, { align: 'center', font: 'bold', spacing: 0.5 });
            }
            cv.text('PEAK ' + (peakRpm ? Math.round(peakRpm) : '--') + '  ·  LIMITER ' + limiterHits + 'x', 40, 476, 22, t.dim, { font: 'bold', spacing: 0.5 });

            // ---- right: shift point + last shift
            const rx = W - 40;
            cv.text('SHIFT AT', rx, 156, 22, t.dim, { align: 'right', font: 'bold', spacing: 1.5 });
            cv.text(String(sp.rpm), rx, 222, 64, sp.cold ? t.cold : t.text, { align: 'right', font: 'num' });
            cv.fillRect(W - 340, 298, 300, 1, withAlpha(t.tick, 0.6));
            cv.text('LAST SHIFT', rx, 334, 22, t.dim, { align: 'right', font: 'bold', spacing: 1.5 });
            if (lastShift) {
                const age = now - lastShift.at, vc = VCOL[lastShift.verdict];
                const lw2 = cv.text(String(lastShift.rpm), rx, 386, 52, t.text, { align: 'right', font: 'num' });
                if (lastShift.from !== '?') cv.text(lastShift.from + ' > ' + lastShift.to, rx - lw2 - 14, 386, 22, t.dim, { align: 'right', font: 'bold' });
                cv.roundRect(rx - 200, 404, 200, 38, 8, withAlpha(vc, age < 2500 ? 0.45 : 0.18));
                cv.text(lastShift.verdict, rx - 100, 431, 22, age < 2500 ? t.text : vc, { align: 'center', font: 'bold', spacing: 1 });
            } else cv.text('--', rx, 386, 52, t.dim, { align: 'right', font: 'num' });
        }

        function drawLog(cv, t) {
            const lp = G.panel(cv, t, 24, 44, 760, 468, 'Recent upshifts');
            G.button(cv, t, 784 - 20 - 180, 56, 180, 40, 'Reset max', resetMax, { key: 'reset', confirm: true });
            // room below the page (where the kit gives it): another row where one fits whole
            const up = shifts.slice(0, 9 + Math.floor((lp.y + lp.h - G.BOTTOM) / 41));
            if (!up.length) cv.text('No shifts yet - go and use the rev range.', 48, 189, 26, t.dim);
            up.forEach((s, i) => {
                const y = 135 + i * 41;
                const d = new Date(s.at), p = (n) => String(n).padStart(2, '0');
                cv.text(p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()), 48, y, 22, t.dim);
                cv.text(s.from === '?' ? 'upshift' : s.from + ' > ' + s.to, 200, y, 26, t.text, { font: 'bold' });
                cv.text(String(s.rpm), 470, y, 28, t.text, { align: 'right', font: 'num' });
                cv.text('/ ' + s.target, 480, y, 22, t.dim);
                cv.roundRect(590, y - 26, 170, 34, 7, withAlpha(VCOL[s.verdict], 0.25));
                cv.text(s.verdict, 675, y - 1, 22, VCOL[s.verdict], { align: 'center', font: 'bold', spacing: 0.5 });
            });

            const ap = G.panel(cv, t, 808, 44, 768, 468, 'Shift accuracy');
            const pitch = 46 + (ap.y + ap.h - G.BOTTOM) / 4;          // the bars spread over a taller panel
            // accuracy from the graded shifts only (CRUISE / AUTO are in the log, not in the score)
            const aimed = shifts.filter(graded), n = aimed.length;
            const cnt = (v) => aimed.filter((s) => s.verdict === v).length;
            const spot = cnt('SPOT ON');
            cv.text(n ? Math.round(spot / n * 100) + '%' : '--', 832, 199, 96, n ? GREEN : t.dim, { font: 'num' });
            cv.text('SPOT ON  (' + n + ' graded)', 836, 235, 22, t.dim, { font: 'bold', spacing: 1 });
            ['EARLY', 'SPOT ON', 'LATE', 'COLD REV', 'LIMITER'].forEach((v, i) => {
                const y = 276 + Math.round(i * pitch), c = cnt(v), f = n ? c / n : 0;
                cv.text(v, 836, y + 22, 22, VCOL[v], { font: 'bold', spacing: 1 });
                cv.roundRect(990, y + 2, 460, 26, 6, t.track);
                if (f > 0) cv.roundRect(990, y + 2, Math.max(12, 460 * f), 26, 6, VCOL[v]);
                cv.text(String(c), 1540, y + 24, 26, t.text, { align: 'right', font: 'num' });
            });
            // scatter: shift rpm vs target
            if (n) {
                const ys = aimed.slice(0, 30).map((s) => s.rpm - s.target);
                const avg = ys.reduce((a, b) => a + b, 0) / ys.length;
                cv.text('AVG ' + (avg >= 0 ? '+' : '') + Math.round(avg) + ' rpm vs shift point', 1240, 199, 24, t.text, { align: 'center', font: 'bold' });
                cv.text('PEAK ' + Math.round(sessionRpm) + ' RPM  ·  ' + G.fmt(mph() ? peakSpeed / MPH : peakSpeed, 0) + (mph() ? ' MPH' : ' KM/H'), 1240, 235, 22, t.dim, { align: 'center', font: 'bold', spacing: 0.5 });
            }
        }

        /* ---------- Learned page: what Redline has learned from this car, each with a reset ---------- */
        /* ---------- HUD looks page: a live preview of the HUD as set up, and every look to pick by picture ----------
         * Left: the HUD at twice its size playing the scripted drive (hud.js demoAt: count-in, flash, a
         * shift graded in turn spot on / early / late, the limiter, braking with the downshift cue),
         * drawn by the HUD's own code with the current settings, so a change shows in it at once.
         * Right: the layouts, small, three rows scrolling sideways; tap one to use it. Under them: colours, shift lights, the grade,
         * peak and shake, each a row of buttons. "Play on HUD" runs the same drive on the glass. */
        const LOOKS = [['standard', 'Standard'], ['minimal', 'Minimal'], ['wings', 'Split wings'],
            ['digital', '80s digital dash'], ['vfd', 'VFD glow'], ['vector', 'Vector arcade'],
            ['arc', 'Arc (F80 M3/M4)'], ['ramp', 'Ramp (G80 M3/M4)'], ['dial', 'Dial (E60 M5)'], ['pill', 'Pill']];
        const TILE_K = 0.45;            // the tiles' thumbnails: the HUD at 45 %
        // profile: the setup being edited, 'sport', 'comfort' or (a plug-in hybrid) 'hybrid' (on opening the page:
        // the driving mode's own);
        // P: that profile as settings (Hud.profileView), so every control on the page reads and changes it
        const studio = { cue: {}, t0: Date.now(), panel: 'look', profile: 'sport', drawnAt: 0, readouts: 'engine' };
        const studioP = () => Hud.profileView(settings, studio.profile);
        /** The preview's frame at now: the HUD's own demo frame (hud.js demoFrame), the same as on the glass. */
        const studioFrame = (now) => Hud.demoFrame(now - studio.t0, Hud.optsFrom(studioP()), studio.cue, hud ? hud.lead() : 200, now);
        /** A small still of a layout for its tile (cached per look and the settings that change it). */
        function lookLayer(style) {
            const P = studioP(), o = Hud.optsFrom(P);
            const tw = Math.round(HudDraw.IW * TILE_K), th = Math.round(HudDraw.IH * TILE_K);
            const font = Hud.gearFontOf(P.get('hudGearFont'), style);
            const key = ['hudlook3', style, o.palette, o.lights, o.gt3, o.dim, o.lightStyle, o.gear, o.peak, o.bar, o.rpm, font].join('|');
            return G.layer(key, tw, th, (r) => {
                r.fillRect(0, 0, tw, th, '#000000');
                HudDraw.drawLayer(HudDraw.scaled(r, TILE_K, 0, 0), {
                    d: { rpm: 5000, gear: 3, stage: 'D' }, shift: 5550, redline: 6550, max: 8000, blink: true, down: 0, peak: o.peak ? 6100 : 0, chip: null,
                    cue: { from: 4050, at: 5550, shift: false, limiter: false }, readouts: [{ label: 'BOOST', value: '1.2', tone: 'text' }],
                    opts: Object.assign({}, o, { style: style, gearFont: font }),
                });
            });
        }
        /** One row of choices: label, then [value, text] options in one bar to its column's end (the left one's: RX - 40,
         *  the right one's: the page's), the current one filled. */
        function choiceRow(cv, t, y, label, key, cur, options, disabled, x0, lw) {
            cv.text(label, x0 ? x0 : 40, y + 27, 18, t.dim, { font: 'bold', spacing: 1 });
            const x = (x0 || 40) + (lw || (x0 ? 120 : 160)), end = x0 ? 1576 : 800;
            G.segment(cv, t, x, y, end - x, 40, options.map((op) => ({ label: op[1], run: () => { (studio.P || settings).set(key, op[0]); return render(); },
                on: op[0] === cur, busy: disabled, key: 'studio_' + key + '_' + op[0] })));
        }
        function drawLooks(cv, t) {
            const now = Date.now();
            // back on the page after a while: edit the profile of the mode the car is in
            if (now - studio.drawnAt > 3000) studio.profile = Hud.profileOf(driveMode.v, settings);
            studio.drawnAt = now;
            // the Hybrid / Electric tab only on a car known to be a plug-in hybrid
            const hybrid = settings.get('hudHybridSeen') === true;
            if (studio.profile === 'hybrid' && !hybrid) studio.profile = 'comfort';
            const P = studioP(), o = Hud.optsFrom(P), comfort = studio.profile !== 'sport', cmode = Hud.setupMode(settings, studio.profile);
            const modeName = studio.profile === 'hybrid' ? 'Hybrid / Electric' : 'Comfort / Eco Pro';
            studio.P = P;
            const on = settings.get('hud') === 'on' || settings.get('hud') === 'test';
            // the live preview, twice the HUD's size, on black like the glass
            const px = 32, py = 56, f = studioFrame(now), sh = f.shake ? f.shake : [0, 0];
            cv.roundRect(24, 48, 816, 276, 12, '#000000');
            // the TYRES tab: the tyre widget three times its size (the car's tyres, or a sample), not the tach
            if (studio.panel === 'tyres' && !tyres.seen()) studio.panel = 'look';
            if (studio.panel === 'tyres') {
                const w = HudTyres.widgetOf(settings), live = tyres.value();
                HudTyres.drawWidget(HudDraw.scaled(cv, 3, 432 - HudTyres.TW * 1.5, 172 - HudTyres.TH * 1.5), live || HudTyres.SAMPLE, w, o.style === 'vfd' ? 'vfd' : o.palette);
                const note = w.show === 'off' ? 'Off: not shown on the HUD' : (live ? 'Your tyres now' : 'A sample') + (w.show === 'low' ? '; on the HUD only while a tyre is low' : '');
                cv.text(note, 432, 314, 15, t.dim, { align: 'center', font: 'bold' });
            } else HudDraw.drawLayer(HudDraw.scaled(cv, 2, px + sh[0] * 2, py + sh[1] * 2), f);
            // Comfort / Eco Pro on Don't show: say so over the preview (the setup under it stays)
            if (comfort && cmode === 'hide') {
                cv.roundRect(24, 48, 816, 276, 12, withAlpha('#000000', 0.9));
                cv.text("Redline's HUD is off in " + modeName, 432, 176, 26, t.text, { align: 'center', font: 'bold' });
                cv.text("BMW's own HUD shows instead. Pick Same as Sport or Its own to bring it back", 432, 212, 18, t.dim, { align: 'center' });
            }
            // the strip above the preview: which HUD this page edits (and, for Comfort, what it shows), in a quiet
            // switch so it reads as "where am I", not as a setting; Play on HUD is the strip's one red button
            const HY = 6;
            const tabs = hybrid ? [['sport', 'Sport'], ['comfort', 'Comfort / Eco'], ['hybrid', 'Hybrid / Electric']] : [['sport', 'Sport'], ['comfort', 'Comfort / Eco Pro']];
            let hx = 40 + segmented(cv, t, 40, HY, tabs, studio.profile, (v) => { studio.profile = v; }, 'studio_profile_');
            if (comfort) {
                cv.text('SHOWS', hx + 28, HY + 23, 14, t.dim, { font: 'bold', spacing: 1 });
                segmented(cv, t, hx + 92, HY, [['same', 'Same as Sport'], ['own', 'Its own'], ['hide', "Don't show"]], cmode, (v) => Hud.setSetupMode(settings, studio.profile, v), 'studio_cmode_');
            }
            const playing = hud && hud.playing();
            // switched on but cluster-render isn't there: say where to get it
            const missing = on && hud && /not running/.test(hud.status());
            const still = !(car.data().speed > 3);
            const canPlay = hud && (playing || (hud.status() === 'HUD: on' && still));
            if (canPlay) G.button(cv, t, 1396, HY, 180, 34, playing ? 'Stop' : 'Play on HUD', () => { if (playing) hud.stopPlay(); else if (!(car.data().speed > 3)) hud.play(0, studio.profile); return render(); }, { key: 'studio_play', primary: !playing });
            // under the preview: what's wrong, or what the Comfort HUD is doing
            const status = missing ? 'The HUD needs cluster-render: install Cluster renderer from the MGU Store'
                : !on ? 'Show on HUD is off (Settings)' : playing ? 'Playing on the HUD...' : hud && hud.status() === 'HUD: on' && !still ? 'Stop the car to play it on the HUD'
                    : comfort && cmode === 'same' ? modeName + ' uses the Sport HUD. Change anything here to give it its own.'
                        : comfort && cmode === 'own' ? 'Changes here only affect ' + modeName + ', its size and place too.' : '';
            cv.text(status, 40, 348, 15, missing || !on ? t.warn : t.dim, { font: 'bold' });
            // the layouts, small, to tap, the name under each: three rows, a column of three at a time; with more than
            // three columns' worth they scroll sideways (the arrows either side, by touch or the controller) at the
            // same size rather than shrink; the chosen one is brought into view whenever it changes
            const TCOLS = 3, ncol = Math.ceil(LOOKS.length / 3), maxOff = Math.max(0, ncol - TCOLS);
            const selCol = Math.floor(LOOKS.map((l) => l[0]).indexOf(o.style) / 3);
            if (studio.tileSel !== o.style) {
                studio.tileSel = o.style;
                if (selCol >= 0) studio.tileOff = selCol < (studio.tileOff || 0) ? selCol : selCol >= (studio.tileOff || 0) + TCOLS ? selCol - TCOLS + 1 : studio.tileOff || 0;
            }
            studio.tileOff = Math.max(0, Math.min(maxOff, studio.tileOff || 0));
            const tx0 = maxOff ? 880 : 864, tw = maxOff ? 216 : 228, tp = tw + 14;
            LOOKS.forEach((l, i) => {
                const col = Math.floor(i / 3) - studio.tileOff;
                if (col < 0 || col >= TCOLS) return;
                const x = tx0 + col * tp, y = 48 + (i % 3) * 94, w = tw, h = 88, sel = l[0] === o.style;
                cv.roundRect(x, y, w, h, 10, withAlpha('#ffffff', 0.05));
                if (sel) cv.strokeRoundRect(x, y, w, h, 10, 3, t.accent);
                cv.blit(lookLayer(l[0]), x + Math.round((w - HudDraw.IW * TILE_K) / 2), y + 4);
                cv.text(l[1], x + w / 2, y + 80, 15, sel ? t.accent : t.dim, { align: 'center', font: 'bold' });
                cv.target(x, y, w, h, () => { P.set('hudStyle', l[0]); return render(); }, 'look_' + l[0]);
            });
            if (maxOff) {
                // the arrows: a tall strip either side, dim at the end; a column per press
                const arrow = (x, dir, can, key) => {
                    cv.roundRect(x, 48, 28, 276, 8, withAlpha('#ffffff', can ? 0.08 : 0.03));
                    const cx = x + 14, c = can ? t.text : withAlpha(t.dim, 0.5);
                    cv.polyline([[cx + 5 * dir * -1, 168], [cx + 5 * dir, 186], [cx + 5 * dir * -1, 204]], 3, c);
                    cv.target(x, 48, 28, 276, () => { if (can) studio.tileOff += dir; return render(); }, key);
                };
                arrow(846, -1, studio.tileOff > 0, 'looks_left');
                arrow(tx0 + TCOLS * tp - 8, 1, studio.tileOff < maxOff, 'looks_right');
                // where the view is: a dot per column page
                for (let k = 0; k <= maxOff; k++) cv.circle(tx0 + (TCOLS * tp - 14) / 2 + (k - maxOff / 2) * 14, 336, 3.5, k === studio.tileOff ? t.accent : withAlpha(t.dim, 0.5));
            }
            // the editor under the preview: tabs, then that panel's buttons
            // category tabs: text with an underline on a divider (like the page tabs), not pills, so they
            // read as categories and the pills below as the things you change
            // TYRES only once the car has sent tyre pressures
            const panels = [['look', 'LOOK'], ['gauge', 'GAUGE'], ['readouts', 'READOUTS'], ['alerts', 'ALERTS']].concat(tyres.seen() ? [['tyres', 'TYRES']] : [], [['place', 'PLACE']]);
            cv.fillRect(24, 398, 1552, 1, withAlpha(t.tick, 0.6));
            let tx = 40;
            panels.forEach((pn) => {
                const sel = studio.panel === pn[0], w = cv.textWidth(pn[1], 20, { font: 'bold', spacing: 2 });
                cv.text(pn[1], tx, 388, 20, sel ? t.text : t.dim, { font: 'bold', spacing: 2 });
                if (sel) cv.roundRect(tx + w / 2 - 16, 394, 32, 3, 1.5, t.sel || t.accent);
                cv.target(tx - 16, 362, w + 32, 40, () => { studio.panel = pn[0]; return render(); }, 'studio_tab_' + pn[0]);
                tx += w + 48;
            });
            const nOn = [o.speed, o.rpm && o.style !== 'digital' && o.style !== 'vfd', o.boost, o.torque, o.power, o.g, o.knock, o.fuel, o.oil, o.coolant, o.gearbox, o.outside, o.tyres,
                o.soc12, o.volt12, o.hvSoc, o.hvPower, o.hvBar, o.hvTemp, o.hvVolt].filter(Boolean).length;
            // the power bar takes no place in the row on the layouts that draw it along their gauge (2026-11-10 review)
            const over = studio.panel === 'readouts' && nOn - (o.hvBar && Hud.METER_STYLES.indexOf(o.style) >= 0 ? 1 : 0) > Hud.MAX_READOUTS;
            // PLACE: say when the size or position puts part of the tach off the windshield's window
            const off = studio.panel === 'place' ? Hud.outsideGlass(Hud.placeOf(P), o.style) : {};
            const offText = Object.keys(off).map((k) => k + ' ' + off[k] + ' px').join(', ');
            const hint = over ? nOn + ' on: the first ' + Hud.MAX_READOUTS + ' that have a value show'
                : offText ? 'Partly outside the windshield (' + offText + '), as measured on one car' : STUDIO_HINT[studio.panel];
            cv.text(hint, 1576, 388, 16, over || offText ? t.warn : t.dim, { align: 'right' });
            // two columns of controls: the left one's label at 40, the right one's at RX
            const RX = 840, R1 = 414, R2 = 462;
            const isM = Hud.M_STYLES.indexOf(o.style) >= 0, seg7 = o.style === 'digital' || o.style === 'vfd' || o.style === 'vector';
            if (studio.panel === 'look') {
                // the HUD's colours (the M layouts and VFD have their own) and the gear's font (not on the 7-segment gears)
                choiceRow(cv, t, R1, 'HUD COLOURS', 'hudPalette', o.palette, [['colour', 'Colour'], ['amber', 'Night amber'], ['ice', 'Ice white']], o.style === 'vfd' || isM);
                choiceRow(cv, t, R1, 'GEAR FONT', 'hudGearFont', P.get('hudGearFont') || 'auto', [['auto', 'Auto'], ['ubuntu', 'Ubuntu'], ['barlow', 'Barlow']], seg7, RX, 150);
                choiceRow(cv, t, R2, 'LABELS', 'hudLabels', o.clearLabels ? 'clear' : 'normal', [['normal', 'Normal'], ['clear', 'Clearer']]);
                choiceRow(cv, t, R2, 'RPM AS', 'hudRpmFormat', o.rpmFormat, [['10', 'Exact'], ['50', 'Steady'], ['k', 'Thousands']], !o.rpm, RX, 150);
            } else if (studio.panel === 'gauge') {
                // the shift lights: how they fill, their colours (the app's: the screen's too); then the gauge's parts
                choiceRow(cv, t, R1, 'LIGHTS', 'hudLightStyle', o.lights ? (o.gt3 ? 'gt3' : 'bar') : 'off', [['gt3', 'GT3'], ['bar', 'Left to right'], ['off', 'Off']]);
                choiceRow(cv, t, R1, 'COLOURS', 'lights', P.get('lights') || 'm', [['m', 'M'], ['f1', 'Race'], ['mono', 'One colour']], !o.lights, RX, 150);
                switches(cv, t, R2, 'SHOW', [
                    ['Rev bar', o.bar, () => P.set('hudShowBar', !o.bar)],
                    ['Gear', o.gear, () => P.set('hudShowGear', !o.gear)],
                    ['Gear mode', o.mode, () => P.set('hudShowMode', !o.mode)],
                ]);
                choiceRow(cv, t, R2, 'UNLIT', 'hudUnlit', o.dim ? 'dim' : 'hidden', [['dim', 'Dim'], ['hidden', 'Hidden']], o.style === 'vfd', RX, 150);
            } else if (studio.panel === 'readouts' && studio.readouts === 'electric') {
                // the 12 V on every car; the hybrid battery only once the car has shown one (never on petrol / diesel)
                switches(cv, t, R1, '12 V', [
                    ['Charge', o.soc12, () => P.set('hudShowBattSoc', !o.soc12)],
                    ['Voltage', o.volt12, () => P.set('hudShowBattVolt', !o.volt12)],
                ]);
                if (electrical.hybrid()) {
                    const on = (k) => P.get(k) === true;
                    switches(cv, t, R2, 'HYBRID', [
                        ['Charge', o.hvSoc, () => P.set('hudShowHvSoc', !on('hudShowHvSoc'))],
                        ['Power', o.hvPower, () => P.set('hudShowHvPower', !on('hudShowHvPower'))],
                        ['Power bar', o.hvBar, () => P.set('hudShowHvBar', !on('hudShowHvBar'))],
                        ['Temp', o.hvTemp, () => P.set('hudShowHvTemp', !on('hudShowHvTemp'))],
                        ['Voltage', o.hvVolt, () => P.set('hudShowHvVolt', !on('hudShowHvVolt'))],
                    ]);
                }
                readoutsPick(cv, t);
            } else if (studio.panel === 'readouts') {
                // the numbers under the bar, in this order; up to four show
                readoutsPick(cv, t);
                switches(cv, t, R1, 'ENGINE', [
                    ['Speed', o.speed, () => P.set('hudShowSpeed', !o.speed)],
                    ['RPM', o.rpm, () => P.set('hudShowRpm', !o.rpm)],
                    ['Boost', o.boost, () => P.set('hudBoost', !o.boost)],
                    ['Torque', o.torque, () => P.set('hudShowTorque', !o.torque)],
                    ['Power', o.power, () => P.set('hudShowPower', !o.power)],
                    ['G-force', o.g, () => P.set('hudShowG', !o.g)],
                    ['Knock', o.knock, () => P.set('hudShowKnock', !o.knock)],
                    ['Fuel', o.fuel, () => P.set('hudShowFuel', !o.fuel)],
                ].concat(tyres.seen() ? [['Tyres', o.tyres, () => P.set('hudShowTyres', !o.tyres)]] : []));
                switches(cv, t, R2, 'TEMPS', [
                    ['Oil', o.oil, () => P.set('hudShowOil', !o.oil)],
                    ['Water', o.coolant, () => P.set('hudShowWater', !o.coolant)],
                    ['Gearbox', o.gearbox, () => P.set('hudShowGearbox', !o.gearbox)],
                    ['Outside', o.outside, () => P.set('hudShowOutside', !o.outside)],
                    ['Cold limit', o.limit, () => P.set('hudShowLimit', !o.limit)],
                    ['Only when cold or hot', o.smartTemps, () => P.set('hudTempsMode', o.smartTemps ? 'always' : 'smart')],
                ]);
            } else if (studio.panel === 'alerts') {
                // what the HUD tells you: the shift grade, knock, the launch time, the downshift arrows
                choiceRow(cv, t, R1, 'GRADE', 'hudChip', o.chip, [['burst', 'Burst'], ['simple', 'Simple'], ['off', 'Off']]);
                choiceRow(cv, t, R1, 'ARROWS', 'downCue', P.get('downCue') || 'slowing', [['slowing', 'When braking'], ['always', 'Always'], ['off', 'Off']], false, RX, 150);
                switches(cv, t, R2, 'ALSO', [
                    ['Knock warning', o.knockWarn, () => P.set('hudKnockWarn', !o.knockWarn)],
                    ['Launch time', o.launch, () => P.set('hudLaunch', !o.launch)],
                    ['Peak', o.peak, () => P.set('hudPeak', !o.peak)],
                    ['Shake', o.shake, () => P.set('hudShake', !o.shake)],
                ]);
                choiceRow(cv, t, R2, 'ARROWS TO', 'downTarget', P.get('downTarget') || 'all', [['all', 'Every gear'], ['best', 'Best gear']], (P.get('downCue') || 'slowing') === 'off', RX, 150);
            } else if (studio.panel === 'tyres') {
                // the tyre widget: when it shows, its unit, its parts, and its corner (the directions' too)
                const w = HudTyres.widgetOf(settings);
                choiceRow(cv, t, R1, 'SHOW', 'hudTyreWidget', w.show, [['low', 'When low'], ['warm', 'Warming up'], ['always', 'Always'], ['off', 'Off']]);
                choiceRow(cv, t, R1, 'UNIT', 'hudTyreUnit', w.unit, [['bar', 'bar'], ['psi', 'psi'], ['kpa', 'kPa']], w.show === 'off', RX, 120);
                switches(cv, t, R2, 'PARTS', [
                    ['Car', w.car, () => settings.set('hudTyreCar', !w.car)],
                    ['Target', w.target, () => settings.set('hudTyreTarget', !w.target)],
                    ['Temperature', w.temp, () => settings.set('hudTyreTemp', !w.temp)],
                ]);
                // (two step groups need ~380 px each: from just after the parts, not from the right column)
                cv.text('MOVE', 615, R2 + 27, 18, t.dim, { font: 'bold', spacing: 1 });
                const corner = (v) => (v === 0 ? 'corner' : (v > 0 ? '+' : '') + v);
                stepButtons(cv, t, 700, R2, 'hudNavX', [['Left', -1], ['Right', 1]], corner);
                stepButtons(cv, t, 1090, R2, 'hudNavY', [['Up', -1], ['Down', 1]], corner);
            } else {
                // size and position, a step at a time through each setting's own steps (live on the glass)
                cv.text('SIZE', 40, R1 + 27, 18, t.dim, { font: 'bold', spacing: 1 });
                stepButtons(cv, t, 200, R1, 'hudSize', [['Smaller', -1], ['Bigger', 1]], (v) => v + ' %');
                cv.text('MOVE', 40, R2 + 27, 18, t.dim, { font: 'bold', spacing: 1 });
                stepButtons(cv, t, 200, R2, 'hudX', [['Left', -1], ['Right', 1]], (v) => (v === 0 ? 'centre' : (v > 0 ? '+' : '') + v + ' px'));
                stepButtons(cv, t, 700, R2, 'hudY', [['Up', -1], ['Down', 1]], (v) => (v === 0 ? 'default' : (v > 0 ? '+' : '') + v + ' px'));
                G.button(cv, t, 1200, R2, 160, 40, 'Reset', () => { P.set('hudSize', 100); P.set('hudX', 0); P.set('hudY', 0); return render(); }, { key: 'studio_place_reset' });
            }
        }
        /** READOUTS has two sets of switches: engine and temperatures, or electrical (12 V, hybrid battery). */
        function readoutsPick(cv, t) {
            segmented(cv, t, 1390, 416, [['engine', 'Engine'], ['electric', 'Electric']], studio.readouts === 'electric' ? 'electric' : 'engine',
                (v) => { studio.readouts = v; }, 'studio_ro_');
        }
        const STUDIO_HINT = {
            look: 'Colours, gear font, labels and how the rpm reads',
            gauge: 'The shift lights and their colours (the screen uses them too); tap a part to show or hide it',
            readouts: 'Up to four show, in this order; a cold or hot one keeps its place. Units: Settings',
            alerts: 'After an upshift, on knock, after a standing start; Shake: on the limiter. And the downshift arrows',
            tyres: 'Where the directions go, when they have no turn; it moves with them. Shown big here',
            place: 'Where the HUD of this setup sits on the glass',
        };
        /**
         * A segmented switch: [value, text] options in one quiet pill, the current one white (not red like the choice
         * rows: it picks what the page edits, not a setting of the HUD). Returns its width.
         */
        function segmented(cv, t, x, y, options, cur, pick, key) {
            const h = 36, fs = 14, f = { font: 'bold', spacing: 1 };
            const ws = options.map((op) => Math.round(cv.textWidth(op[1].toUpperCase(), fs, f)) + 40), total = ws.reduce((a, b) => a + b, 0);
            const S = t.sel || t.accent;
            cv.roundRect(x, y, total, h, 10, withAlpha('#000000', 0.45));
            cv.strokeRoundRect(x, y, total, h, 10, 1, withAlpha('#ffffff', 0.1));
            options.forEach((op, i) => {
                const sel = op[0] === cur;
                if (sel) cv.roundRect(x + 3, y + 3, ws[i] - 6, h - 6, 8, S);
                cv.text(op[1].toUpperCase(), x + ws[i] / 2, y + h / 2 + 5, fs, sel ? G.onColour(S) : t.dim, Object.assign({ align: 'center' }, f));
                cv.target(x, y, ws[i], h, () => { pick(op[0]); return render(); }, key + op[0]);
                x += ws[i];
            });
            return total;
        }
        /**
         * On / off switches at y, after a section label: [label, on, flip]. Drawn as switches, not like
         * the choice bars: a green LED dot lit when on (an empty ring when off), the chip tinted in the
         * theme's colour with a faint glow when on, dim when off, so on / off reads at a glance.
         */
        const SWITCH_ON = '#2ee66b';
        function switches(cv, t, y, label, list, x0) {
            if (label) cv.text(label, x0 || 40, y + 27, 18, t.dim, { font: 'bold', spacing: 1 });
            let x = x0 ? x0 + (label ? 150 : 0) : 200;
            list.forEach((c, i) => {
                const on = !!c[1], txt = c[0], w = cv.textWidth(txt, 18, { font: 'bold' }) + 64, h = 40;
                const S = t.sel || t.accent;
                if (on) cv.roundRect(x - 3, y - 3, w + 6, h + 6, 13, withAlpha(S, 0.14));
                cv.roundRect(x, y, w, h, 10, withAlpha('#ffffff', 0.09));
                if (on) cv.roundRect(x, y, w, h, 10, withAlpha(S, 0.22));
                cv.strokeRoundRect(x, y, w, h, 10, 1.5, on ? withAlpha(S, 0.75) : withAlpha('#ffffff', 0.2));
                // the dot is a little LED: lit green when on, an empty ring when off
                if (on) { cv.circle(x + 22, y + h / 2, 11, withAlpha(SWITCH_ON, 0.25)); cv.circle(x + 22, y + h / 2, 7, SWITCH_ON); } else cv.arc(x + 22, y + h / 2, 5.5, 7.5, 0, 360, withAlpha('#ffffff', 0.45));
                cv.text(txt, x + 40, y + 27, 18, on ? t.text : t.dim, { font: 'bold' });
                cv.target(x, y, w, h, () => { c[2](); return render(); }, 'studio_sw_' + y + '_' + i);
                x += w + 12;
            });
            return x;
        }
        /** Buttons that step a number setting through its "steps" (−1 / +1), with the value between. */
        function stepButtons(cv, t, x, y, key, buttons, fmt) {
            // the setup being edited (size and place are each setup's own)
            const S = studio.P || settings, it = settings.item(key), steps = (it && it.steps) || [], cur = S.get(key);
            const i = Math.max(0, steps.indexOf(cur));
            const go = (d) => { const j = Math.max(0, Math.min(steps.length - 1, i + d)); S.set(key, steps[j]); return render(); };
            const w0 = G.button(cv, t, x, y, 0, 40, buttons[0][0], () => go(buttons[0][1]), { key: 'studio_step_' + key + '_a', busy: i <= 0 });
            cv.text(fmt(steps.length ? steps[i] : cur), x + (w0 || 120) + 70, y + 27, 18, t.text, { align: 'center', font: 'bold' });
            G.button(cv, t, x + (w0 || 120) + 140, y, 0, 40, buttons[1][0], () => go(buttons[1][1]), { key: 'studio_step_' + key + '_b', busy: i >= steps.length - 1 });
        }

        let learnedView = null;
        /** 'Petrol car', 'Diesel hybrid' ...: the engine profile (the car's or the setting's), hybrid once seen. */
        const carKind = () => {
            const fuel = engine.profile() === 'diesel' ? 'Diesel' : 'Petrol', hand = ['diesel', 'petrol'].indexOf(settings.get('engine')) >= 0;
            return fuel + (electrical.hybrid() ? ' hybrid' : ' car') + (hand ? '  ·  set by hand' : '');
        };
        function drawLearned(cv, t) {
            // torque curve (full load), from the car's torque signal
            const cp = G.panel(cv, t, 24, 44, 760, 468, 'Torque curve (full load)');
            G.button(cv, t, 784 - 20 - 150, 56, 150, 40, 'Reset', () => { shiftMap.forget(); learnedView = null; return render(); }, { key: 'resetMap', confirm: true, color: t.warn });
            // the learned data changes every few seconds at most: read it once a second, not per frame
            if (!learnedView || Date.now() - learnedView.t > 1000) learnedView = { t: Date.now(), pts: shiftMap.curve(), table: shiftMap.table() };
            const tu = tqUnit(), tk = tu[0], ts = tu[2];
            const pts = learnedView.pts.filter((p) => p[0] >= 1000 && p[0] <= maxRpm()).map((p) => [p[0], p[1] * tk]), top = pts.reduce((m, p) => Math.max(m, p[1]), 0);
            G.chart(cv, t, 44, 116, 720, Math.max(200, cp.y + cp.h - 136), {
                xMin: 1000, xMax: maxRpm(), xStep: 1000, xFmt: (v) => String(v / 1000), xUnit: 'x1000 rpm',
                yMin: 0, yMax: Math.max(ts, Math.ceil(top / ts) * ts + ts / 2), yStep: tu[3], yUnit: tu[1], padTop: 22,
                series: pts.length ? [{ pts: pts, color: t.accent, width: 3 }] : [],
                empty: 'Nothing yet: full-throttle pulls, a few from low rpm, fill it in',
            });

            // shift points and gear ratios, the redline and the reaction time
            G.panel(cv, t, 808, 44, 768, 468, 'Shift points');
            G.button(cv, t, 1576 - 20 - 170, 56, 170, 40, 'Reset all', () => { shiftMap.forget(); limiter.forget(); launch.forget(); if (hud) hud.resetLead(); learnedView = null; return render(); }, { key: 'resetAll', confirm: true, color: t.warn });
            const table = learnedView.table;
            let y = 130;
            cv.text('GEAR', 836, y, 18, t.dim, { font: 'bold', spacing: 1 });
            cv.text('SHIFT AT', 1080, y, 18, t.dim, { align: 'right', font: 'bold', spacing: 1 });
            cv.text('RPM PER KM/H', 1300, y, 18, t.dim, { align: 'right', font: 'bold', spacing: 1 });
            for (let g = 1; g <= 7; g++) {
                y += 28;
                const k = shiftMap.ratio(g), pr = shiftMap.ratioProgress(g), at = table[g];
                cv.text(g + ' > ' + (g + 1), 836, y, 22, t.text, { font: 'bold' });
                // the point in use: learned, held under the redline and over the minimum (warm oil)
                cv.text(G.isNum(at) ? String(normalShift(g)) : '--', 1080, y, 24, G.isNum(at) ? t.text : t.dim, { align: 'right', font: 'num' });
                cv.text(k ? k.toFixed(1) : pr.n ? 'learning ' + pr.n + '/' + pr.of : '--', 1300, y, k ? 22 : 18, k ? t.text : t.dim, { align: 'right', font: k ? 'num' : 'bold' });
            }
            // no shift point yet though ratios are known: the curve has to reach the redline
            if (!Object.keys(table).length && shiftMap.ratio(1)) { cv.text('Shift points need full-throttle pulls up to the redline (' + redline() + ')', 836, y + 26, 15, t.dim); y += 18; }
            const lim = limiter.value(), lead = hud ? hud.learned() : null;
            y += 42;
            cv.fillRect(836, y - 30, 712, 1, withAlpha(t.tick, 0.6));
            cv.text('REDLINE', 836, y, 20, t.dim, { font: 'bold', spacing: 1 });
            cv.text(redline() + ' rpm  ·  ' + redlineSource(), 990, y, 20, t.text, { font: 'bold' });
            if (!lim && !manualRedline() && settings.get('learnRedline') !== false) {
                const p = limiter.waiting();
                cv.text(p ? '1 of 2 limiter hits seen (' + p + ' rpm): one more, held half a second, oil warm'
                    : 'learns after two hits of the limiter, each held half a second, oil warm', 990, y + 20, 15, p ? t.text : t.dim);
            }
            G.button(cv, t, 1576 - 20 - 120, y - 28, 120, 36, 'Reset', () => { limiter.forget(); return render(); }, { key: 'resetRedline', confirm: true, color: t.warn });
            y += 42;
            cv.text('REACTION', 836, y, 20, t.dim, { font: 'bold', spacing: 1 });
            cv.text(lead ? lead.ms + ' ms early  ·  ' + (lead.auto ? 'learned from ' + lead.shifts + ' shifts' : 'set by hand') : '--', 990, y, 20, t.text, { font: 'bold' });

            G.button(cv, t, 1576 - 20 - 120, y - 28, 120, 36, 'Reset', () => { if (hud) hud.resetLead(); return render(); }, { key: 'resetLead', confirm: true, color: t.warn });
            // what Redline has found this car to be: its engine (hybrid once it has shown a high-voltage
            // battery) and whether it sends tyre pressures (the HUD's tyre options only appear then)
            y += 42;
            cv.text('CAR', 836, y, 20, t.dim, { font: 'bold', spacing: 1 });
            cv.text(carKind(), 990, y, 20, t.text, { font: 'bold' });
            cv.text(tyres.seen() ? 'Tyre sensors' : 'No tyre sensors', 990, y + 20, 15, tyres.seen() ? t.text : t.dim);
            // what the head-up display is doing (while it is switched on), and frozen learning
            const hs = hud ? hud.status() : '';
            // one line under the rows: a pressed bar reset, the HUD, frozen learning
            const notes = [resetArmed() ? 'Press Reset learned again to forget it all' : '', hs, learning() ? '' : 'Learning off: values kept'].filter(Boolean);
            if (notes.length) cv.text(notes.join('   ·   '), 836, Math.min(506, y + 40), 16, notes.some((n) => /off|not|again/i.test(n)) ? t.warn : t.dim, { font: 'bold' });
        }

        /* ---------- Logs (Settings, its last row): the important lines of Redline's logs and cluster-render's ----------
         * For a user with no SSH (issue #141: a remote install, the HUD off after display errors). Read only when the
         * sheet opens, a source is picked or Refresh is tapped, never per frame (logview.js). The HUD's line and
         * cluster-render's mapping guard on top. Touch: the sources, Refresh, Back, a finger scrolls the lines. The
         * controller: turning scrolls, pressing picks the next source. */
        const LOG_SOURCES = [['redline', 'Redline'], ['nav', 'Directions'], ['cluster', 'Cluster renderer']];
        const LOG_PITCH = 28, LOG_LINE = 24, LOG_LINES = 3;
        const logs = { src: 'redline', res: null, t: 0, top: 0, px: 0, per: 12, fits: new Map() };
        function loadLogs() {
            logs.res = LogView.load(logs.src, ctx.dataDir); logs.t = Date.now(); logs.top = 0; logs.px = 0; logs.fits.clear();
            if (hud) hud.askStatus();
        }
        /** s cut with ... to w px (kept per line: the sheet is drawn 30 times a second). */
        function fitText(r, s, size, w, opts) {
            const k = size + '|' + w + '|' + s;
            if (logs.fits.has(k)) return logs.fits.get(k);
            let out = s;
            if (r.textWidth(s, size, opts) > w) {
                let lo = 0, hi = s.length;
                while (lo < hi) { const m = (lo + hi + 1) >> 1; if (r.textWidth(s.slice(0, m) + '...', size, opts) <= w) lo = m; else hi = m - 1; }
                out = s.slice(0, lo) + '...';
            }
            if (logs.fits.size > 400) logs.fits.clear();
            logs.fits.set(k, out);
            return out;
        }
        // (rows wrap, so the last one may be scrolled up to near the top)
        const logsMax = () => Math.max(0, logs.res.rows.length - 3);
        /** s wrapped at spaces to lines of w px, at most LOG_LINES (the last cut with ...); kept per text like fitText. */
        function wrapText(r, s, size, w) {
            const k = 'w|' + size + '|' + w + '|' + s;
            if (logs.fits.has(k)) return logs.fits.get(k);
            const out = [];
            let rest = s;
            while (rest && out.length < LOG_LINES) {
                if (out.length === LOG_LINES - 1 || r.textWidth(rest, size, {}) <= w) { out.push(fitText(r, rest, size, w, {})); break; }
                // the most that fits, back to the last space (a word longer than the line is cut where it must)
                let lo = 1, hi = rest.length;
                while (lo < hi) { const m = (lo + hi + 1) >> 1; if (r.textWidth(rest.slice(0, m), size, {}) <= w) lo = m; else hi = m - 1; }
                const sp = rest.lastIndexOf(' ', lo);
                const cut = sp > lo * 0.5 ? sp : lo;
                out.push(rest.slice(0, cut));
                rest = rest.slice(cut).replace(/^ +/, '');
            }
            if (logs.fits.size > 400) logs.fits.clear();
            logs.fits.set(k, out);
            return out;
        }
        function logsSheet() {
            loadLogs();
            return {
                title: 'Logs',
                draw(r, t) {
                    r.clear(t.bg);
                    const T = Sheet.TOP, targets = [], bold = { font: 'bold' };
                    // the sources, top left
                    let x = 44;
                    LOG_SOURCES.forEach((op) => {
                        const w = Math.max(150, r.textWidth(op[1], 24, bold) + 60);
                        Sheet.pill(r, t, x, T + 8, w, 46, op[1], op[0] === logs.src);
                        targets.push({ x: x, y: T + 2, w: w, h: 58, act: () => { if (logs.src !== op[0]) { logs.src = op[0]; loadLogs(); } return null; } });
                        x += w + 14;
                    });
                    // Back (to the settings), Refresh before it
                    const bw = 150, bx = 1600 - 40 - bw, rw = 170, rx = bx - 16 - rw;
                    Sheet.pill(r, t, rx, T + 8, rw, 46, 'Refresh', false);
                    targets.push({ x: rx, y: T + 2, w: rw, h: 58, act: () => { loadLogs(); return null; } });
                    Sheet.pill(r, t, bx, T + 8, bw, 46, 'Back', false);
                    targets.push({ x: bx - 10, y: T + 2, w: bw + 20, h: 58, act: () => 'close' });
                    // the HUD now, and cluster-render's mapping guard (its strikes against the HUD) once it has answered
                    const st = hud ? hud.crStatus() : null, guard = st ? LogView.guardLines(st.text) : [];
                    const hs = (hud ? hud.status() : '') || 'HUD: off in the settings';
                    const head = [hs].concat(guard.length ? guard : st ? ['guard: no strikes'] : []).join('   ·   ');
                    const warn = /off after|disabled|strike/.test(head) && !/no strikes/.test(head);
                    const rows = logs.res.rows;
                    const y0 = T + 146, bottom = G.BOTTOM + (r.extra || 0) - 10;
                    logs.top = Math.min(logs.top, logsMax());
                    // the rows that fit from the top one down, each wrapped to at most LOG_LINES lines (the guard's
                    // line ends with how to clear it: never cut to one line)
                    const lay = [];
                    for (let i = logs.top, y = y0; i < rows.length && y <= bottom; i++) {
                        const lines = wrapText(r, rows[i].msg, 19, 1556 - 270);
                        lay.push({ row: rows[i], y: y, lines: lines });
                        y += LOG_PITCH + (lines.length - 1) * LOG_LINE;
                    }
                    logs.per = Math.max(1, lay.length);
                    // (the times as the head unit keeps them: UTC on the cars seen so far, said so)
                    const count = rows.length ? (logs.top + 1) + '-' + (logs.top + lay.length) + ' of ' + rows.length + ', newest first' + (LogView.isUtc() ? ', times UTC' : '') : '';
                    const cw = count ? r.textWidth(count, 18, {}) + 24 : 0;
                    r.text(fitText(r, head, 20, 1512 - cw, bold), 44, T + 98, 20, warn ? t.warn : t.text, bold);
                    if (count) r.text(count, 1556, T + 98, 18, t.dim, { align: 'right' });
                    r.fillRect(44, T + 114, 1512, 1, withAlpha(t.tick || '#ffffff', 0.5));
                    if (!rows.length) { r.text(logs.res.note || 'Nothing to show', 44, y0, 22, t.text); return targets; }
                    lay.forEach((it) => {
                        // the mapping guard's lines, and the cluster's display going away, read as warnings whatever their level
                        const row = it.row, y = it.y, lv = row.level, bad = /ERROR|FATAL/.test(lv);
                        const wn = /WARN/.test(lv) || /guard|strike|Dcsm2 not available|heartbeat/i.test(row.msg);
                        const start = /^starting |^cluster-render started/.test(row.msg);
                        r.text(LogView.stamp(row.at), 44, y, 18, t.dim, { font: 'num' });
                        if (lv && lv !== 'INFO') r.text(lv.replace('SDK_', ''), 196, y, 16, bad ? t.crit : wn ? t.warn : t.dim, bold);
                        it.lines.forEach((ln, k) => r.text(ln, 270, y + k * LOG_LINE, 19, bad ? t.crit : wn ? t.warn : start ? t.accent : t.text, start ? bold : {}));
                    });
                    return targets;
                },
                // the controller: turning scrolls the lines, pressing picks the next source, left goes back
                move(d) { logs.top = Math.max(0, Math.min(logsMax(), logs.top + d * 3)); logs.px = logs.top * LOG_PITCH; },
                press() { const i = LOG_SOURCES.findIndex((op) => op[0] === logs.src); logs.src = LOG_SOURCES[(i + 1) % LOG_SOURCES.length][0]; loadLogs(); return null; },
                back() { return 'close'; },
                top() { return logs.top === 0; },
                // a finger: px down the list
                scroll(dy) { logs.px = Math.max(0, Math.min(logsMax() * LOG_PITCH, logs.px + dy)); logs.top = Math.round(logs.px / LOG_PITCH); },
                release() {},
            };
        }
        if (ctx.settingsRow) ctx.settingsRow({ label: 'Logs', value: 'What Redline and the HUD did lately', open: logsSheet });

        /** G20-style frame: tab bar with the page names along the top. */
        function header(cv, t, d) {
            G.frame(cv, t, ['Tach', 'Shift log', 'Learned', 'HUD looks'], page, [d.demo && { text: 'DEMO' }]);
        }

        async function render() {
            const t = ctx.theme(), d = car.data(), now = Date.now();
            let cv;
            cv = ctx.canvas(W, H).clear(t.bg);
            if (page === 0) drawTach(cv, t, d, now); else if (page === 1) drawLog(cv, t); else if (page === 2) drawLearned(cv, t); else drawLooks(cv, t);
            header(cv, t, d);
            await ui.image('MAIN_GFX', cv);
        }

        /* ---------- buttons ---------- */
        const PAGES = 4;
        const flip = () => { page = (page + 1) % PAGES; return render(); };
        const flipBack = () => { page = (page + PAGES - 1) % PAGES; return render(); };
        ui.onClick('BTN_PAGE', flip);
        ui.onClick('BTN_PREV', flipBack);
        ctx.onTab((i) => { if (i !== page && i >= 0 && i < PAGES) { page = i; return render(); } return null; });
        // Reset max: on the Shift log page, or the bar's button
        function resetMax() {
            peakRpm = 0; peakRpmT = 0; sessionRpm = 0; peakSpeed = 0; limiterHits = 0; shifts = []; lastShift = null;
            log.info('peaks reset'); return render();
        }
        ui.onClick('BTN_RESET', resetMax);
        // where the HMI draws the bar (software renderer) the Learned page has no buttons: this bar
        // button forgets everything learned, on a second press within 5 s
        let resetLearnAt = 0;
        const resetArmed = () => Date.now() - resetLearnAt < 5000;
        ui.onClick('BTN_RESET_LEARNED', () => {
            if (!resetArmed()) { resetLearnAt = Date.now(); page = 2; return render(); }
            resetLearnAt = 0; shiftMap.forget(); limiter.forget(); launch.forget(); if (hud) hud.resetLead(); learnedView = null;
            log.info('learned data reset from the bar button');
            return render();
        });
        ctx.hideButton('BTN_RESET_LEARNED');
        ctx.hideButton('BTN_RESET');
        // every screen refresh (60 fps) with the GPU renderer; 15 fps in software (PNG frames)
        ctx.loop('MAIN', 15, render);
        // 1.14 / 1.15's "In Comfort / Eco Pro" carried into the Sport / Comfort profiles, once
        const moved = Hud.migrateProfiles(settings);
        if (moved && moved !== 'none') log.info('hud: In Comfort (' + moved + ') carried into the Comfort profile');
        // the navigation probe (redline-nav.log, read-only) feeding Redline's own HUD directions (nav.js); never stops the app
        let nav = null;
        try {
            const Nav = require('./nav');
            let tracker = null;
            // the event list is asked only while the HUD and its directions are on (the probe's other lines are passive)
            const probe = require('./navlog').start(ctx, log, (s, f, v, at) => { if (tracker) tracker.tap(s, f, v, at); },
                { wanted: () => settings.get('hud') !== 'off' && settings.get('hudNav') !== 'off', routing: () => !!tracker && tracker.routing(),
                    // written to flash only while the HUD shows directions (not giving way, hidden, paused or off)
                    onGlass: () => !!hud && hud.directionsShown() });
            tracker = Nav.start(ctx, log, probe);
            nav = tracker;
        } catch (e) { log.warn('nav: directions not started: ' + e); }
        // head-up display through cluster-render (setting "hud"); the centre screen is unchanged
        hud = Hud.start(ctx, {
            // the next turn and lanes while a route runs (null: none here)
            nav: nav,
            data: () => car.data(), shiftPoint, redline, maxRpm, gearbox, knock, fuel, electrical, tyres, downshift,
            // a call ringing: BMW's call card on the HUD, the tach out of its way
            ringing: () => call.ringing(),
            // the tach's peak marker (drops back after "Peak hold"), the last upshift's grade for 1.5 s,
            // boost once it has moved and is under 2 s old (none from the demo drive)
            peak: () => peakRpm,
            chip: () => (lastShift && graded(lastShift) && Date.now() - lastShift.at < 1500 ? { verdict: lastShift.verdict, at: lastShift.at } : null),
            mode: modeNow,
            launch: (now, mph) => launch.last(now, mph),
            // 'sport', 'comfort', 'eco', 'hybrid' or null (unknown, the demo data): the HUD shows as set up
            driveMode: () => (car.data().demo ? null : driveMode.v),
            boost: () => (boost.moved && Date.now() - boost.t < 2000 && !car.data().demo ? boost.v : null),
            // torque, pedal, g, outside for the extra readouts (none from the demo data)
            extras: () => (car.data().demo ? null : Object.assign(electrical.value(), { tyres: tyres.value() }, {
                torque: Date.now() - torque.t < 2000 ? torque.v : null,
                gLat: fresh(extra.gLat, 2000), gLong: fresh(extra.gLong, 2000),
                outside: fresh(extra.outside, 600000),
                knock: knock.value().retard,
                // the engine off (electric driving, auto start-stop) uses no fuel: 0, once the engine unit has given
                // a rate this run, rather than the readout dropping out (2026-11-10 review)
                fuelLph: G.isNum(car.data().rpm) && car.data().rpm <= 400 && fuel.worked() ? 0 : fuel.value().lph, kmh: car.data().speed,
            })),
        });
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
