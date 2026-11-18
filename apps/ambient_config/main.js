'use strict';
/**
 * Ambient config - any colour on the car's ambient light, animations, and a look for each driving mode.
 *
 * Tabs:
 *   Colour         the colour ring (and white) for the whole car, the upper lights or the lower ones, the
 *                  brightness, and the car from above lit as the car is; Original colour gives the light back
 *   Animations     Solid, Breathing, Rainbow, Smooth fade, Colour wave, how fast, shown moving on the car picture;
 *                  Turn signal glow (that side's door lines blink green with it), Open door red (its line blinking) and
 *                  Hazard red (every light pulses red while the hazards are on), each off until switched on
 *   Driving modes  for each driving mode the car has: Choose colour (the Colour and Animations tabs change that mode's
 *                  look until Done), the animation button stepping through them, or Original colour (BMW's); with
 *                  nothing chosen, the Colour tab's colour; welcome sweep, Sport pulse, Redline's shift flash
 *   Favourites     six saved looks: tap to put one on
 * Everything goes to the car as it is picked. The lights are driven through the body controller (lights.js); a car
 * whose body controller does not answer keeps BMW's own colours (ambient.js), offered on the Colour tab.
 * It runs from the platform's start (app.json "autostart"): the look and the driving modes work with the app closed.
 * With IterioDev's Comfort tool running (others.js), which writes the same lights, it stands aside (no light writes
 * until Comfort is gone) and the Colour and Animations tabs say so in red and recommend uninstalling it.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { Diag } = require('./kit/diag');
const Car = require('./kit/car');
const { Ambient, SLOTS } = require('./ambient');
const { Lights } = require('./lights');
const { Control } = require('./control');
const { Others } = require('./others');
const { Strobe, gateChecks, gateWhy } = require('./strobe');
const { Lever, beamOf } = require('./lever');
const Parked = require('./kit/parked');
const { t: translate } = require('./kit/i18n');
const { drawCabin } = require('./cabin');
const { sample } = require('./lin');
const S = require('./scenes');

const W = 1600, H = 520;
const TABS = ['Colour', 'Animations', 'Driving modes', 'Favourites'];
const MODE_NAMES = { sport: 'Sport', comfort: 'Comfort', eco: 'Eco Pro', adaptive: 'Adaptive', hybrid: 'Hybrid', electric: 'Electric' };
const QUICK = [['Red', [255, 0, 0]], ['Orange', [255, 100, 0]], ['Amber', [255, 170, 0]], ['Yellow', [255, 235, 0]], ['Green', [0, 255, 60]],
    ['Cyan', [0, 230, 255]], ['Blue', [0, 70, 255]], ['Violet', [120, 60, 255]], ['Pink', [255, 40, 170]], ['White', [255, 255, 255]]];
const RING = { cx: 290, cy: 288, R: 186, r: 136 }, DIAL = { cx: 655, cy: 400, R: 54, r: 43 };

const ON_BY_DEFAULT = ['follow', 'flashAlerts'];
const MOVE_DRAW_MS = 250;            // a moving scene's picture: at most 4 a second
const FIND_LATER_MS = 5000;          // lights known from an earlier start: read again once the first colour is out
const IDLE_MS = 15 * 60000;          // without the car's own state: not driven nor the app used this long = parked and left
/* The car's turn signals (Light.StatusFunctionsIndicators activeFunctionIndicateDirection, by name or number): the
 * driver's (held or tapped), the driving assistant's, and the hazards; the lock and alarm flashes are none. */
const TURN = { DAUERBLINKEN_LINKS: 'left', TIPPBLINKEN_LINKS: 'left', DAUERBLINKEN_RECHTS: 'right', TIPPBLINKEN_RECHTS: 'right',
    WARNBLINKEN_MANUELL: 'both', CRASH_BLINKEN: 'both', AUFFAHRWARNBLINKEN: 'both', WARNBLINKEN_NACH_GEFAHRENBREMSUNG: 'both',
    FAS_WARNBLINKEN_AUSPRAEGUNG_1: 'both', FAS_WARNBLINKEN_AUSPRAEGUNG_2: 'both', FAS_WARNBLINKEN_AUSPRAEGUNG_3: 'both',
    FAS_RICHTUNGSBLINKEN_LOWPRIO_LINKS: 'left', FAS_RICHTUNGSBLINKEN_MIDPRIO_LINKS: 'left', FAS_RICHTUNGSBLINKEN_HIGHPRIO_LINKS: 'left',
    FAS_RICHTUNGSBLINKEN_LOWPRIO_RECHTS: 'right', FAS_RICHTUNGSBLINKEN_MIDPRIO_RECHTS: 'right', FAS_RICHTUNGSBLINKEN_HIGHPRIO_RECHTS: 'right' };
const TURN_NO = { 1: 'both', 6: 'both', 7: 'left', 8: 'right', 9: 'left', 10: 'right', 12: 'both', 13: 'both', 16: 'both', 18: 'left', 19: 'right',
    20: 'left', 21: 'right', 22: 'left', 23: 'right', 24: 'both', 25: 'both' };
const turnOf = (v) => { const x = v && typeof v === 'object' ? v.activeFunctionIndicateDirection : v; return (typeof x === 'number' ? TURN_NO[x] : TURN[x]) || null; };
/* The doors (DoorsWindowsRoofMirrors.CentralLockingSystemAndPanelStatus): each door's switch, open = 1 or ..._OFFEN. */
const DOOR_FIELDS = { statusDoorSwitchDRD: 'driver front', statusDoorSwitchPSD: 'passenger front', statusDoorSwitchDRDR: 'driver rear',
    statusDoorSwitchPSDR: 'passenger rear' };
const doorsOf = (v) => Object.keys(DOOR_FIELDS).filter((k) => v && (v[k] === 1 || /_OFFEN$/.test(String(v[k])))).map((k) => DOOR_FIELDS[k]);
const DAY_NIGHT = { KEINE_AENDERUNG: 0, TAG: 1, NACHT: 2, SIGNAL_UNGUELTIG: 3 };

/* The strobe's options as the Strobe page has them (its buttons' settings), for its Start and the flasher lever. */
function strobeOptions(settings, strobe) {
    const cyc = (key, vals, def) => { const v = String(settings.get(key) || def); return vals.indexOf(v) >= 0 ? v : def; };
    const pattern = ['both', 'alternate', 'police'].indexOf(settings.get('strobePattern')) >= 0 ? settings.get('strobePattern') : 'police';
    const o = { lights: strobe && strobe.patterns && settings.get('strobeLights') === 'high' ? 'high' : 'all', pattern,
        rate: settings.get('strobeRate') || 'normal', burst: cyc('policeBurst', ['1', '2', '3', '4'], '4'),
        flashMs: cyc('strobeFlashMs', ['50', '80', '100', '150'], '80'), order: cyc('policeOrder', ['lbr', 'lrb', 'lr'], 'lbr') };
    if (strobe && strobe.kind === 'fn') o.every = +cyc('strobeEvery', ['0', '250', '333', '500', '1000'], '0');
    return o;
}

async function background(bg) {
    const { settings, signals, log } = bg;
    const ambient = new Ambient({ settings, signals, log });
    await ambient.start();
    const diag = await new Diag(signals, log).init();
    diag.quiet = true; diag.busyLog = false;
    // the lights found at an earlier start: the colour goes out at once, and the buses are read again after it
    const lights = new Lights({ diag, log, known: settings.get('lightsKnown') });
    const control = new Control({ settings, lights, ambient, log });
    control.start();
    // with the lights answering, the driving modes' looks replace BMW's colours by mode (ambient.js)
    lights.on('change', () => { ambient.slotsOff = lights.lights.length > 0; });
    lights.on('found', (l) => settings.set('lightsKnown', l));
    // lights that did not answer: asked again every 2 min while the car is in use (parked and left: the car sleeps)
    const again = () => setTimeout(() => { if (control._away) again(); else find(); }, 120000);
    const find = () => lights.find().then((l) => { if (!l.length) again(); }, (e) => { log.warn('lights: ' + e); again(); });
    setTimeout(find, lights.lights.length ? FIND_LATER_MS : 0);
    signals.watch('de.bmw.infotainment.vehicle.Vehicle', '1', {
        statusDayNightChangeOver: (v) => {
            const x = v && typeof v === 'object' ? v.dayNightChangeOver : v, c = typeof x === 'string' ? DAY_NIGHT[x] : x;
            if (c === 1 || c === 2) control.night(c === 2);
        },
    }, log).catch((e) => log.warn('day / night: ' + (e && e.message || e)));
    // the car locked and left (parked, standby: nobody in it) gives the lights back and nothing is written, so the car
    // can sleep; living, ignition, driving: ours again. A car that has not said its state: not driven and the app not
    // used for IDLE_MS counts as left
    let stateSeen = false, activeT = Date.now();
    const active = () => { activeT = Date.now(); if (!stateSeen && control._away) control.away(false); };
    // the state from either of the car's two copies (some cars send only the one without a CRC); without one, the
    // partial networks it keeps awake, numbered the same (KOM_PARKEN... = 1-3, no communication = parked)
    const conditionFrom = (v) => {
        const n = Car.conditionOf(v && v.statusConditionVehicle);
        if (n !== undefined) return n;
        const p = v && v.controlBasePartialNetworks;
        if (p === 0 || p === 'KEINE_KOMMUNIKATION') return 1;
        return Car.conditionOf(typeof p === 'string' ? p.replace(/^KOM_/, '') : p);
    };
    const sources = new Set();
    const onCondition = (field) => (v) => {
        const n = conditionFrom(v);
        if (n === undefined) return;
        if (!sources.has(field)) { sources.add(field); log.info('vehicle state: from ' + field + ' (' + n + ')'); }
        stateSeen = true;
        control.away(n <= 3);
    };
    signals.watch('de.bmw.infrastructure.VehicleCondition', '1', {
        VehicleCondition: onCondition('VehicleCondition'),
        vehicleConditionNoCrc: onCondition('vehicleConditionNoCrc'),
    }, log).catch((e) => log.warn('vehicle state: ' + (e && e.message || e)));
    // the speed
    signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
        statusCarSpeed2: (v) => {
            const k = v && v.speedVehicleCentreOfGravity;
            if (typeof k === 'number' && k !== 65535 && k * 0.015625 > 1 && k * 0.015625 < 400) active();
        },
    }, log).catch((e) => log.warn('speed: ' + (e && e.message || e)));
    setInterval(() => {
        if (stateSeen || control._away || Date.now() - activeT <= IDLE_MS) return;
        log.info('vehicle state: none from the car, not driven or used for ' + IDLE_MS / 60000 + ' min: parked');
        control.away(true);
    }, 30000);
    // the turn signals: that side's door lines blink green; an open door: its line red (settings turnGlow, doorRed, both off
    // until switched on)
    signals.watch('de.bmw.body.Light', '1', { StatusFunctionsIndicators: (v) => control.turn(turnOf(v)) }, log)
        .catch((e) => log.warn('turn signals: ' + (e && e.message || e)));
    signals.watch('de.bmw.body.DoorsWindowsRoofMirrors', '1', { CentralLockingSystemAndPanelStatus: (v) => control.doors(doorsOf(v)) }, log)
        .catch((e) => log.warn('doors: ' + (e && e.message || e)));
    settings.onChange((key) => {
        if (key === 'nightDim') control.night(control._night);
        if (key === 'follow') control.apply();
        if (key === 'turnGlow' || key === 'doorRed' || key === 'hazardRed' || key === 'drive') control.signals();
        if (key === 'doorCar') control.carDoorSetting();
    });
    const others = new Others({ log }).start();
    // IterioDev's Comfort tool writes the same lights: while it runs, ours stand aside (no writes, so the two don't fight
    // and the lights don't jump), and carry on once it is gone
    const besideComfort = () => {
        lights.hold('comfort', others.comfort);
        if (others.comfort) log.warn('lights: IterioDev\'s Comfort tool is running, Ambient config stands aside until it is gone');
    };
    others.on('change', besideComfort);
    besideComfort();
    // the high beam strobe and the light show (strobe.js): only for use on private property, behind its setting,
    // with someone in the car; the light show also with the car standing still (kit/parked.js, checked again on every
    // step: it stops when the car moves off); why not, or null
    const parked = Parked.watch(bg, log);
    const checks = () => gateChecks({ setting: settings.get('strobe') === true, away: control._away, moving: parked.moving() });
    const gate = (what) => gateWhy(checks(), what);
    // the high beam's channels learned on a headlight unit, kept in the data folder
    const fs = require('fs'), path = require('path');
    const chFile = bg.dataDir ? path.join(bg.dataDir, 'strobe_channels.json') : null;
    let channels = null;
    try { channels = chFile ? JSON.parse(fs.readFileSync(chFile, 'utf8')) : null; } catch (e) { channels = null; }
    // while the strobe runs, the ambient lights stop writing (the gateway takes one request at a time: theirs in
    // between got the strobe's refused)
    const strobe = new Strobe({ diag, log, allowed: gate, channels, hold: (on) => lights.hold('strobe', on) });
    strobe.on('learned', (c) => { try { if (chFile) fs.writeFileSync(chFile, JSON.stringify(c)); } catch (e) { log.warn('strobe: ' + e); } });
    const findStrobe = () => { if (settings.get('strobe') === true && !strobe.kind) strobe.find().catch((e) => log.warn('strobe: ' + e)); };
    findStrobe();
    // the flasher lever (lever.js): three quick pulls while parked (also while driving with strobeLeverDriving, for
    // private property) start the strobe as the Strobe page has it, while its Lever start is on (off until switched on),
    // and three more while it flashes stop it; the light status read only from then on, 10 times a second (a quick pull
    // is shorter than a slower read)
    const lever = new Lever();
    let leverWatch = null;
    const watchLever = () => {
        if (leverWatch || settings.get('strobeLever') !== true) return;
        leverWatch = Promise.resolve(signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusLightStatus: (v) => {
                const t = Date.now();
                if (!lever.beam(beamOf(v && v.statusMainBeam_headlightFlasher), t)) return;
                // three pulls while the strobe flashes stop it (however it was started; stopping needs no checks)
                if (strobe.running === 'strobe') {
                    lever.cool(t);
                    log.info('strobe: stopped with the flasher lever');
                    strobe.stop();
                    return;
                }
                // (while driving only with its setting, for private property)
                const parkedOk = parked.moving() === false || settings.get('strobeLeverDriving') === true;
                if (settings.get('strobeLever') !== true || !strobe.kind || strobe.running || gate('strobe') !== null || !parkedOk) return;
                lever.cool(t);
                log.info('strobe: started with the flasher lever');
                strobe.start(strobeOptions(settings, strobe)).catch((e) => log.warn('strobe: ' + e));
            },
        }, log, { pollMs: 100 })).catch((e) => { leverWatch = null; log.warn('flasher lever: ' + (e && e.message || e)); });
    };
    watchLever();
    settings.onChange((key) => {
        if (key === 'strobe') { if (settings.get('strobe') === true) findStrobe(); else strobe.stop(); }
        if (key === 'strobeLever') watchLever();
    });
    // (the car locked and left mid-flash: the gate says no at the next step and the strobe stops)
    return { ambient, lights, control, active, others, strobe, checks };
}

const nearest = (rgb) => {
    const sat = (Math.max.apply(null, rgb) - Math.min.apply(null, rgb)) / Math.max(1, Math.max.apply(null, rgb));
    if (sat < 0.25) return 'White';
    const h = S.hueOf(rgb);
    let best = QUICK[0], d = 999;
    QUICK.forEach((q) => { if (q[0] === 'White') return; const e = Math.abs(((S.hueOf(q[1]) - h + 540) % 360) - 180); if (e < d) { d = e; best = q; } });
    return best[0];
};
const textOn = (rgb) => (rgb[0] * 0.3 + rgb[1] * 0.59 + rgb[2] * 0.11 > 150 ? '#101010' : '#ffffff');

mgu.run({
    background,
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const { ambient, lights, control, active, others, strobe, checks } = ctx.background || await background(ctx);
        // the Strobe tab only with its experimental setting on
        const tabs = () => TABS.concat(settings.get('strobe') === true ? ['Strobe'] : []);
        // editing: null (the driver's own look) or a driving mode whose look the Colour and Animations tabs change
        let page = 0, part = 'all', dirty = true, editing = null;
        const T0 = Date.now();

        const look = () => (editing ? control.modeLook(editing) || control.look() : control.look());
        const setLook = (patch) => (editing ? control.setModeLook(editing, Object.assign(look(), patch)) : control.setLook(patch));
        const isOn = () => (editing ? !!control.modeLook(editing) : control.on());
        const done = () => { editing = null; page = 2; return redraw(); };
        // what the picture shows: a driving mode being changed as it will look, else the lights as the car shows them
        const pictureOf = (l, lk) => (editing ? (x) => S.lightAt(lk, x, Date.now() - T0) : l);
        const partColour = (l) => (part === 'lower' ? l.lower : l.upper);
        const shown = () => (lights.lights.length ? lights.lights : sample());
        const rhd = () => settings.get('drive') === 'rhd';
        // (a tap: the app in use - the car is not left, also for a car that does not say so)
        const redraw = () => { dirty = true; if (active) active(); return render(); };

        const setRgb = (rgb) => {
            const l = look(), b = partColour(l).bright;
            const c = { rgb: rgb.slice(), bright: b || 80 };
            if (part !== 'lower') l.upper = c;
            if (part !== 'upper') l.lower = Object.assign({}, c, part === 'all' ? {} : { bright: l.lower.bright });
            setLook({ upper: l.upper, lower: l.lower });
            return redraw();
        };
        const setBright = (b) => {
            const l = look(), v = Math.max(5, Math.min(100, Math.round(b)));
            if (part !== 'lower') l.upper.bright = v;
            if (part !== 'upper') l.lower.bright = v;
            setLook({ upper: l.upper, lower: l.lower });
            return redraw();
        };
        const stepHue = (d) => { const c = partColour(look()); return setRgb(S.hsv(S.stepHue(S.hueOf(c.rgb), d), 1, 1)); };

        // another ambient app's service writing the same lights: says so in place of the status, wrapped to width w
        const COMFORT_WARNING = 'IterioDev\'s Comfort tool is running and changes the same lights, so Ambient config has stopped ' +
            'changing them. Uninstall Comfort in the Store (Installed, Head-unit tools, Comfort) to use Ambient config.';
        // in red, so it is seen: nothing on these tabs reaches the lights while Comfort runs
        function warnOthers(cv, t, x, y, w) {
            const head = cv.textWidth(translate('Another ambient app is running'), 22, { font: 'bold', literal: true }) <= w
                ? 'Another ambient app is running' : 'Another ambient app';
            cv.text(head, x, y, 22, t.crit, { font: 'bold' });
            const lines = [];
            // translated whole before wrapping, so a localized build wraps its own sentence
            translate(COMFORT_WARNING).split(' ').forEach((word) => {
                const last = lines.length - 1, joined = last >= 0 ? lines[last] + ' ' + word : word;
                if (last >= 0 && cv.textWidth(joined, 18, { literal: true }) <= w) lines[last] = joined; else lines.push(word);
            });
            lines.forEach((line, i) => cv.text(line, x, y + 30 + i * 24, 18, t.crit, { literal: true }));
        }
        function status(cv, t, x, y) {
            if (others.comfort) return warnOthers(cv, t, x, y, 1560 - x);
            const n = lights.lights.length;
            const s = lights.state === 'finding' ? 'Looking for the car\'s lights...'
                : lights.state === 'none' ? 'The car\'s lights did not answer'
                    : lights.state === 'car' ? 'Original colour (as set in BMW\'s menu)' : 'On in the car: ' + n + ' lights';
            cv.text(s, x, y, 20, lights.state === 'none' ? t.warn : t.dim);
            if (lights.error && lights.state !== 'none') cv.text(lights.error, x, y + 26, 18, t.warn);
        }
        // the car picture: the lights as the car shows them (the car's own colour: grey)
        const carNow = (l) => (lights.scene ? lights.at(l) : null);

        function drawColour(cv, t) {
            const l = look(), c = partColour(l), sel = nearest(c.rgb);
            G.panel(cv, t, 24, 44, 736, 468, editing ? 'Colour for ' + MODE_NAMES[editing] : 'Colour');
            cv.arc(RING.cx, RING.cy, RING.r, RING.R, 0, 360, '#ff0000', { ramp: ['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ff0000'], rampFrom: 0, rampTo: 360 });
            const h = S.hueOf(c.rgb), a = (90 - h) * Math.PI / 180, rm = (RING.R + RING.r) / 2;
            const kx = RING.cx + Math.cos(a) * rm, ky = RING.cy - Math.sin(a) * rm;
            cv.arc(kx, ky, 0, 22, 0, 360, '#ffffff'); cv.arc(kx, ky, 0, 16, 0, 360, S.hsv(h, 1, 1));
            const shownRgb = c.rgb.map((x) => Math.round(x * (0.35 + 0.65 * c.bright / 100)));
            cv.arc(RING.cx, RING.cy, 0, RING.r - 18, 0, 360, shownRgb);
            cv.text(nearest(c.rgb), RING.cx, RING.cy + 4, 38, textOn(shownRgb), { align: 'center', font: 'bold' });
            cv.text(part === 'all' ? 'Whole car' : part === 'upper' ? 'Upper lights' : 'Lower lights', RING.cx, RING.cy + 40, 20, textOn(shownRgb), { align: 'center' });
            G.button(cv, t, 44, 446, 56, 48, '<', () => stepHue(-15), { key: 'h-' });
            G.button(cv, t, 480, 446, 56, 48, '>', () => stepHue(15), { key: 'h+' });

            cv.text('Colouring', 566, 92, 20, t.dim);
            [['all', 'Whole car'], ['upper', 'Upper lights'], ['lower', 'Lower lights']].forEach(([k, n], i) => {
                G.button(cv, t, 566, 104 + i * 56, 176, 46, n, () => { part = k; return redraw(); }, { primary: part === k, key: 'part-' + k });
            });
            // the ring has every colour at its fullest: white is its own button
            G.button(cv, t, 566, 272, 176, 46, 'White', () => setRgb([255, 255, 255]), { primary: isOn() && sel === 'White', key: 'white' });
            cv.arc(DIAL.cx, DIAL.cy, DIAL.r, DIAL.R, -135, 135, withAlpha('#ffffff', 0.12), { round: true });
            cv.arc(DIAL.cx, DIAL.cy, DIAL.r, DIAL.R, -135, -135 + 270 * c.bright / 100, S.hsv(h, 1, 1), { round: true });
            cv.text(c.bright + '%', DIAL.cx, DIAL.cy + 6, 28, t.text, { align: 'center', font: 'bold' });
            cv.text('Brightness', DIAL.cx, DIAL.cy + 32, 15, t.dim, { align: 'center' });
            G.button(cv, t, 580, 464, 64, 44, '-', () => setBright(c.bright - 10), { key: 'b-' });
            G.button(cv, t, 666, 464, 64, 44, '+', () => setBright(c.bright + 10), { key: 'b+' });

            G.panel(cv, t, 776, 44, 800, 468, editing ? MODE_NAMES[editing] + ' will look' : 'In the car');
            if (lights.state === 'none' && !editing) return drawBmwColours(cv, t);
            drawCabin(cv, t, { x: 790, y: 92, w: 330, h: 404 }, shown(), pictureOf(carNow, l), { rhd: rhd() });
            const x = 1150;
            [['Upper', l.upper], ['Lower', l.lower]].forEach(([n, v], i) => {
                cv.roundRect(x, 104 + i * 40, 26, 26, 7, v.rgb);
                cv.text(n + ': ' + nearest(v.rgb) + ', ' + v.bright + '%', x + 38, 124 + i * 40, 20, t.text);
            });
            if (editing) return editBar(cv, t, x);
            G.button(cv, t, x, 210, 268, 48, 'Original colour', () => { control.carColour(); return redraw(); }, { primary: !control.on(), key: 'car' });
            G.button(cv, t, x, 270, 268, 48, 'Save favourite', () => { control.saveFav(); return redraw(); }, { key: 'save' });
            status(cv, t, x, 352);
        }

        // changing a driving mode's look: which mode, and Done back to the Driving modes tab
        function editBar(cv, t, x) {
            cv.text('Changing ' + MODE_NAMES[editing] + '\'s look', x, 222, 22, t.text, { font: 'bold' });
            cv.text('It shows whenever ' + MODE_NAMES[editing] + ' is on.', x, 250, 18, t.dim);
            G.button(cv, t, x, 280, 268, 48, 'Done', done, { primary: true, key: 'done' });
        }

        // the body controller did not answer: BMW's own colours, as BMW's menu has them
        function drawBmwColours(cv, t) {
            cv.text('Any colour needs the body module, which did not answer.', 796, 136, 20, t.warn);
            cv.text('BMW\'s own colours meanwhile:', 796, 164, 20, t.dim);
            const now = ambient.slot();
            for (let i = 0; i < SLOTS; i++) {
                const n = i + 1;
                G.button(cv, t, 796 + (i % 4) * 132, 186 + Math.floor(i / 4) * 62, 120, 50, String(n), () => { ambient.setSlot(n); return redraw(); },
                    { primary: n === now, busy: !ambient.available, key: 'slot-' + n });
            }
            G.button(cv, t, 796, 386, 0, 48, 'Look again', () => { lights.find(); return redraw(); }, { key: 'again' });
            if (others.comfort) warnOthers(cv, t, 1346, 136, 214);
        }

        function drawAnimations(cv, t) {
            const l = look();
            G.panel(cv, t, 24, 44, 640, 468, editing ? 'Animation for ' + MODE_NAMES[editing] : 'Animation');
            const kinds = [['solid', 'No animation, a steady colour'], ['breathing', 'Slowly brighter and dimmer'], ['rainbow', 'Every colour in turn'],
                ['fade', 'Upper colour to lower colour and back'], ['wave', 'Colour rolling from side to side']];
            kinds.forEach(([k, d], i) => {
                const y = 92 + i * 66, on = isOn() && l.kind === k;
                G.button(cv, t, 44, y, 220, 50, S.NAMES[k], () => { setLook({ kind: k }); return redraw(); }, { primary: on, key: 'k-' + k });
                cv.text(d, 284, y + 32, 20, on ? t.text : t.dim);
            });
            cv.text('Speed', 44, 470, 20, t.dim);
            [[1, 'Slow'], [2, 'Normal'], [3, 'Fast']].forEach(([v, n], i) => {
                G.button(cv, t, 120 + i * 150, 440, 136, 48, n, () => { setLook({ speed: v }); return redraw(); }, { primary: (l.speed || 2) === v, key: 'sp-' + v });
            });

            G.panel(cv, t, 678, 44, 898, 468, editing ? MODE_NAMES[editing] + ' will look' : 'In the car');
            // the picture shows the animation picked even before the car has answered
            const preview = (x) => (lights.scene ? lights.at(x) : control.on() ? S.lightAt(l, x, Date.now() - T0) : null);
            drawCabin(cv, t, { x: 700, y: 92, w: 420, h: 404 }, shown(), pictureOf(preview, l), { rhd: rhd() });
            const x = 1150;
            [['Upper', l.upper], ['Lower', l.lower]].forEach(([n, v], i) => {
                cv.roundRect(x, 104 + i * 40, 26, 26, 7, v.rgb);
                cv.text(n + ': ' + nearest(v.rgb), x + 38, 124 + i * 40, 20, t.text);
            });
            cv.text('Colours: on the Colour tab', x, 214, 18, t.dim);
            if (editing) return editBar(cv, t, x);
            G.button(cv, t, x, 240, 0, 48, 'Original colour', () => { control.carColour(); return redraw(); }, { primary: !control.on(), key: 'car2' });
            status(cv, t, x, 330);
            // over every look, off until switched on: the turn signal's green glow, an open door's red, the hazards' red
            // pulse. Under the other ambient app's warning (4 lines, to y 440) all three side by side, a little lower
            const togs = others.comfort ? [[x, 460, 128, 40, 'Turn glow'], [x + 136, 460, 128, 40, 'Door red'], [x + 272, 460, 128, 40, 'Hazard red']]
                : [[x, 400, 400, 48], [x, 456, 194, 48], [x + 206, 456, 194, 48]];
            [['turnGlow', 'Turn signal glow'], ['doorRed', 'Open door red'], ['hazardRed', 'Hazard red']].forEach(([k, n], i) => {
                const [bx, by, bw, bh, short] = togs[i];
                n = short || n;
                G.button(cv, t, bx, by, bw, bh, n, () => { settings.set(k, settings.get(k) !== true); return redraw(); }, { primary: settings.get(k) === true, key: 'tog-' + k });
            });
            if (!others.comfort && lights.state === 'ours' && S.moves(lights.scene)) cv.text(lights.rate.toFixed(0) + ' writes a second, ' + lights.fps.toFixed(1) + ' frames a second', x, 390, 18, t.dim);
        }

        function drawModes(cv, t) {
            G.panel(cv, t, 24, 44, 1552, 468, 'By driving mode');
            const mine = control.look(), cur = ambient.mode();
            ambient.modes().forEach((m, i) => {
                const y = 92 + i * 72, ml = control.modeLook(m);
                if (m === cur) cv.roundRect(40, y - 6, 1520, 62, 10, withAlpha(t.accent, 0.14));
                cv.text(MODE_NAMES[m], 60, y + 34, 28, t.text, { font: 'bold' });
                const orig = control.modeOriginal(m);
                if (ml) { cv.roundRect(250, y + 6, 38, 38, 9, ml.upper.rgb); cv.text(nearest(ml.upper.rgb) + (ml.kind !== 'solid' ? ', ' + S.NAMES[ml.kind] : ''), 304, y + 33, 22, t.text); }
                else cv.text(orig ? 'BMW\'s original colour' : 'The Colour tab\'s colour', 250, y + 33, 22, t.dim);
                // any colour: the Colour and Animations tabs change this mode's look
                G.button(cv, t, 760, y + 1, 250, 48, 'Choose colour', () => { editing = m; page = 0; return redraw(); }, { primary: !!ml, key: m + '-any' });
                // the animation, one tap each: Solid, Breathing, Rainbow, Smooth fade, Colour wave
                const kind = ml ? ml.kind : 'solid', next = S.KINDS[(S.KINDS.indexOf(kind) + 1) % S.KINDS.length];
                G.button(cv, t, 1026, y + 1, 250, 48, S.NAMES[kind], () => { control.setModeLook(m, Object.assign(ml || mine, { kind: next })); return redraw(); },
                    { primary: !!ml && kind !== 'solid', key: m + '-anim' });
                // Original colour: BMW's colour in this mode; tapped again, the Colour tab's colour back
                G.button(cv, t, 1292, y + 1, 250, 48, 'Original colour', () => { control.setModeLook(m, orig ? null : 'original'); return redraw(); },
                    { primary: orig, key: m + '-orig' });
            });
            cv.text('Nothing chosen: the Colour tab\'s colour. Tap Original colour again to undo it.', 60, 412, 18, t.dim);
            const tog = (key, label, x) => x + 16 + G.button(cv, t, x, 440, 0, 48, label, () => { settings.set(key, !settings.get(key)); return redraw(); },
                { primary: ON_BY_DEFAULT.indexOf(key) >= 0 ? settings.get(key) !== false : !!settings.get(key), key: 'tog-' + key });
            let x = 60;
            x = tog('follow', settings.get('follow') !== false ? 'Following driving mode' : 'Not following', x);
            x = tog('welcome', 'Welcome sweep at start', x);
            x = tog('sportPulse', 'Sport pulse', x);
            tog('flashAlerts', 'Redline shift flash', x);
        }

        function drawFavs(cv, t) {
            G.panel(cv, t, 24, 44, 1552, 468, 'Favourites');
            const favs = control.favs(), mine = JSON.stringify(look());
            for (let i = 0; i < 6; i++) {
                const x = 44 + (i % 3) * 512, y = 92 + Math.floor(i / 3) * 206, f = favs[i];
                const on = f && control.on() && JSON.stringify(f) === mine;
                cv.roundRect(x, y, 492, 190, 16, on ? withAlpha(t.accent, 0.22) : withAlpha('#ffffff', 0.06));
                if (!f) {
                    cv.text('Empty', x + 246, y + 86, 26, t.dim, { align: 'center', font: 'bold' });
                    cv.text('Tap to save the look on now', x + 246, y + 118, 20, t.dim, { align: 'center' });
                    if (cv.target) cv.target(x, y, 492, 190, () => { control.saveFav(); return redraw(); }, 'fav-' + i);
                    continue;
                }
                cv.roundRect(x + 24, y + 24, 120, 66, 14, f.upper.rgb);
                cv.roundRect(x + 24, y + 98, 120, 66, 14, f.lower.rgb);
                cv.text(nearest(f.upper.rgb) + (nearest(f.lower.rgb) !== nearest(f.upper.rgb) ? ' / ' + nearest(f.lower.rgb) : ''), x + 166, y + 60, 26, t.text, { font: 'bold' });
                cv.text(S.NAMES[f.kind] + ', ' + f.upper.bright + '%', x + 166, y + 94, 20, t.dim);
                if (cv.target) cv.target(x, y, 340, 190, () => { control.useFav(i); return redraw(); }, 'fav-' + i);
                G.button(cv, t, x + 360, y + 130, 116, 44, 'Delete', () => { control.dropFav(i); return redraw(); }, { key: 'del-' + i, confirm: true });
            }
        }

        /*
         * Strobe (only for use on private property): the high beams flashed through the headlight units or the body
         * controller (strobe.js), both together or left and right in turn, fast / normal / slow, at most 30 s a press;
         * Learn high beam finds a headlight's high beam channels; and the light show, 15 s. Only with the setting on and someone in the car;
         * a press arms, a second starts; Stop, the setting off or the car locked and left stops it and gives the lamps back.
         */
        function drawStrobe(cv, t) {
            G.panel(cv, t, 24, 44, 736, 468, 'Strobe');
            const kindText = !strobe ? 'Not available' : strobe.kind ? 'Lamps: ' + strobe.kindName
                + (strobe.head ? (strobe.high ? ' · high beam channel ' + strobe.high.map((c) => c.ch).join(', ') : ' · high beam not learned yet') : '')
                : 'Looking for the headlights\' lamp control...';
            cv.text(kindText, 44, 112, 18, t.dim);
            // (three checks in the room two had: 26 px apart, the warning and the note under them)
            checks().forEach(([label, ok, why], i) => {
                const y = 140 + i * 26;
                cv.arc(52, y - 6, 0, 7, 0, 360, ok ? '#2fd27a' : t.crit);
                cv.text(label + (!ok && why ? ' · ' + why : ''), 70, y, 20, ok ? t.text : t.dim);
            });
            cv.text('Only for use on private property.', 44, 222, 20, t.warn, { font: 'bold' });
            // three quick pulls of the flasher lever while parked start it, three more stop it (lever.js), only while this is on
            const lever = settings.get('strobeLever') === true;
            G.button(cv, t, 520, 190, 220, 42, lever ? 'Lever start: On' : 'Lever start: Off', () => { settings.set('strobeLever', !lever); return redraw(); },
                { primary: lever, key: 'strobe-lever', busy: !strobe });
            if (strobe && strobe.note) cv.text(strobe.note, 44, 248, 18, strobe.noteType === 'warn' ? t.warn : t.dim);
            const pat = ['both', 'alternate', 'police'].indexOf(settings.get('strobePattern')) >= 0 ? settings.get('strobePattern') : 'police';
            const rate = settings.get('strobeRate') || 'normal';
            // the headlight units can flash every front light; the body controller only the high beams
            const lights = strobe && strobe.patterns && settings.get('strobeLights') === 'high' ? 'high' : 'all';
            // police on the high beam (light functions with the headlight units): its tuning in place of Lights
            const policeTune = strobe && strobe.kind === 'fn' && strobe.mask && pat === 'police';
            const cyc = (key, vals, def) => { const v = String(settings.get(key) || def); return vals.indexOf(v) >= 0 ? v : def; };
            const burst = cyc('policeBurst', ['1', '2', '3', '4'], '4'), flashMs = cyc('strobeFlashMs', ['50', '80', '100', '150'], '80');
            const order = cyc('policeOrder', ['lbr', 'lrb', 'lr'], 'lbr');
            const next = (vals, v) => vals[(vals.indexOf(v) + 1) % vals.length];
            if (policeTune) {
                cv.text('Police: flashes a burst · flash · order (tap to change)', 44, 274, 18, t.dim);
                const ORDER_NAMES = { lrb: 'L R Both', lr: 'L R', lbr: 'L Both R' };
                [['policeBurst', burst + (burst === '1' ? ' flash' : ' flashes'), ['1', '2', '3', '4'], burst],
                    ['strobeFlashMs', flashMs + ' ms', ['50', '80', '100', '150'], flashMs],
                    ['policeOrder', ORDER_NAMES[order], ['lbr', 'lrb', 'lr'], order]].forEach(([key, label, vals, v], i) => {
                    G.button(cv, t, 44 + i * 150, 284, 140, 42, label, () => { settings.set(key, next(vals, v)); return redraw(); }, { key: 'tune-' + key });
                });
            } else if (strobe && strobe.patterns) {
                cv.text('Lights', 44, 274, 18, t.dim);
                [['all', 'All lights'], ['high', 'High beam']].forEach(([k, n], i) => {
                    G.button(cv, t, 44 + i * 236, 284, 224, 42, n, () => { settings.set('strobeLights', k); return redraw(); }, { primary: lights === k, key: 'lights-' + k });
                });
                // the body controller's flashes take their length for every pattern, not only police (issue #157)
                if (strobe.kind === 'fn') {
                    cv.text('Flash length (tap to change)', 520, 274, 18, t.dim);
                    G.button(cv, t, 520, 284, 220, 42, flashMs + ' ms', () => { settings.set('strobeFlashMs', next(['50', '80', '100', '150'], flashMs)); return redraw(); }, { key: 'tune-strobeFlashMs' });
                }
            }
            if (strobe && strobe.head) {
                // which channels are the high beam, seen while it is switched on with the stalk
                const learning = strobe.running === 'learn';
                G.button(cv, t, 520, 284, 220, 42, learning ? 'Stop' : 'Learn high beam', () => {
                    if (learning) strobe.stop(); else strobe.learn().catch((e) => log.warn('strobe: ' + e));
                    return redraw();
                }, { primary: learning, key: 'strobe-learn', busy: !learning && !!strobe.running });
            }
            cv.text('Pattern', 44, 346, 18, t.dim);
            // police: one headlight, then the other, the fastest there is (headlight units only)
            const pats = [['police', 'Police'], ['both', 'Strobe'], ['alternate', 'In turn']].filter(([k]) => k !== 'police' || (strobe && strobe.patterns));
            pats.forEach(([k, n], i) => {
                G.button(cv, t, 44 + i * 150, 356, 140, 42, n, () => { settings.set('strobePattern', k); return redraw(); }, { primary: pat === k, key: 'pat-' + k });
            });
            // the body controller's timed flashes: how often, as flashes a second (Max: as fast as the head unit passes them)
            const timed = strobe && strobe.kind === 'fn';
            const every = cyc('strobeEvery', ['0', '250', '333', '500', '1000'], '0');
            if (timed) {
                cv.text('Flashes a second', 44, 418, 18, t.dim);
                [['0', 'Max'], ['250', '4'], ['333', '3'], ['500', '2'], ['1000', '1']].forEach(([k, n], i) => {
                    G.button(cv, t, 44 + i * 94, 428, 86, 48, n, () => { settings.set('strobeEvery', k); return redraw(); }, { primary: every === k, key: 'every-' + k });
                });
            } else {
                cv.text('Speed', 44, 418, 18, t.dim);
                [['fast', 'Fast'], ['normal', 'Normal'], ['slow', 'Slow']].forEach(([k, n], i) => {
                    G.button(cv, t, 44 + i * 150, 428, 140, 48, n, () => { settings.set('strobeRate', k); return redraw(); }, { primary: rate === k, key: 'rate-' + k });
                });
            }
            const on = strobe && strobe.running === 'strobe';
            G.button(cv, t, 520, 428, 220, 48, on ? 'Stop' : 'Start strobe', () => {
                if (on) strobe.stop(); else strobe.start(strobeOptions(settings, strobe)).catch((e) => log.warn('strobe: ' + e));
                return redraw();
            }, { primary: on, key: 'strobe-go', confirm: !on, busy: !strobe || !strobe.kind || strobe.running === 'show' || strobe.running === 'learn' });

            G.panel(cv, t, 776, 44, 800, 468, 'Light show');
            (strobe && strobe.kind === 'fn' ? ['Every outside light flashes in turn for 15 s: high beam,', 'cornering, fog, indicators, brake, reverse and more.']
                : strobe && strobe.head ? ['The headlights flash fully on and dark, left and right in', 'turn, for 15 s.']
                : ['Every lamp output flashes for 15 s, run by the body controller', 'itself (BDC_G11 and BDC_G05).']).forEach((l, i) => cv.text(l, 796, 112 + i * 26, 18, t.dim));
            cv.text('Only for use on private property.', 796, 190, 20, t.warn, { font: 'bold' });
            ['Flashing headlights on public roads is illegal and dangerous', 'to other drivers.'].forEach((l, i) => cv.text(l, 796, 220 + i * 26, 18, t.text));
            if (paused) {
                cv.text(paused.moving ? 'Ambient animation paused while this tab is open.' : 'Ambient light updates paused while this tab is open.', 796, 300, 20, t.warn, { font: 'bold' });
                cv.text('They carry on when you leave the Strobe tab.', 796, 326, 18, t.dim);
            }
            const srate = settings.get('showRate') === 'fast' ? 'fast' : 'normal';
            cv.text('Speed', 796, 414, 18, t.dim);
            [['fast', 'Fast'], ['normal', 'Normal']].forEach(([k, n], i) => {
                G.button(cv, t, 796 + i * 150, 426, 140, 48, n, () => { settings.set('showRate', k); return redraw(); }, { primary: srate === k, key: 'srate-' + k });
            });
            const showing = strobe && strobe.running === 'show';
            G.button(cv, t, 1336, 426, 220, 48, showing ? 'Stop' : 'Start show', () => {
                if (showing) strobe.stop(); else strobe.show({ rate: srate }).catch((e) => log.warn('light show: ' + e));
                return redraw();
            }, { primary: showing, key: 'show-go', confirm: !showing, busy: !strobe || !strobe.kind || strobe.running === 'strobe' || strobe.running === 'learn' });
        }

        async function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            if (page >= tabs().length) page = 0;
            [drawColour, drawAnimations, drawModes, drawFavs, drawStrobe][page](cv, t);
            G.frame(cv, t, tabs(), page, []);
            dirty = false;
            await ui.image('MAIN_GFX', cv);
        }
        /*
         * The Strobe tab on screen: the ambient lights stop writing (their animation's requests to the body controller
         * in between got the strobe's diagnostic session refused, issue #157), and carry on once the tab is left: another
         * tab, the screen gone (the loop stops ticking) or the Strobe setting off. paused: { moving } while held.
         */
        let paused = null, strobeSeen = 0;
        const PAUSE_KEY = 'strobe-tab', SEEN_MS = 1500;
        const animating = () => !!((lights.scene && S.moves(lights.scene)) || (lights._overs && lights._overs.size));
        const pauseCheck = () => {
            const want = page === 4 && tabs().length > 4 && Date.now() - strobeSeen < SEEN_MS;
            if (want && !paused) {
                paused = { moving: animating() };
                log.info('ambient: ' + (paused.moving ? 'animation' : 'light updates') + ' paused for the Strobe tab');
                lights.hold(PAUSE_KEY, true).catch((e) => log.warn('ambient: hold: ' + e));
                dirty = true;
            } else if (!want && paused) {
                paused = null;
                log.info('ambient: the Strobe tab left, the lights carry on');
                lights.hold(PAUSE_KEY, false);
                dirty = true;
            }
        };
        setInterval(pauseCheck, 250);
        // moving lights redraw MOVE_DRAW_MS apart (the lights' writes share the app's one thread), the rest when something
        // changes
        let movedAt = 0;
        const tick = () => {
            if (page === 4) { strobeSeen = Date.now(); pauseCheck(); }
            const moving = (lights.scene && S.moves(lights.scene)) || (page === 1 && control.on() && S.moves(look()));
            const due = moving && page <= 1 && Date.now() - movedAt >= MOVE_DRAW_MS;
            if (due) movedAt = Date.now();
            // (the Strobe tab: its checks follow the car, so it draws on each tick)
            return dirty || due || page === 4 ? render() : null;
        };

        if (ctx.onTap) {
            ctx.onTap((x, y) => {
                if (page !== 0) return null;
                const dx = x - RING.cx, dy = y - RING.cy, d = Math.sqrt(dx * dx + dy * dy);
                if (d >= RING.r - 12 && d <= RING.R + 12) return setRgb(S.hsv(S.snapHue((Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360), 1, 1));
                const ex = x - DIAL.cx, ey = y - DIAL.cy, e = Math.sqrt(ex * ex + ey * ey);
                if (e >= DIAL.r - 14 && e <= DIAL.R + 14) {
                    const a = Math.atan2(ex, -ey) * 180 / Math.PI;
                    if (a >= -140 && a <= 140) return setBright((Math.max(-135, Math.min(135, a)) + 135) / 270 * 100);
                }
                return null;
            });
        }
        ctx.onTab((i) => { page = i; if (i >= 2) editing = null; if (i === 4) strobeSeen = Date.now(); pauseCheck(); return redraw(); });
        lights.on('change', () => { dirty = true; });
        ambient.on('change', () => { dirty = true; });
        others.on('change', () => { dirty = true; });
        if (strobe) strobe.on('change', () => { dirty = true; });
        settings.onChange(() => { dirty = true; });
        ctx.loop('MAIN', 8, tick);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
