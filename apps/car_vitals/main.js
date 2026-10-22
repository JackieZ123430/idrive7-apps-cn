'use strict';
/**
 * M Vitals - live engine / thermal / chassis gauges drawn in the HMI's style.
 *
 * Pages (button "Next page"):
 *   engine  - RPM + boost dials, power/torque bars, speed
 *   thermal - coolant / engine oil / gearbox / ambient with 5-minute traces
 *   chassis - friction circle (g-g diagram), tyre pressures + temperatures, xDrive split
 *
 * Signals come straight from the car over SOME/IP (see app.json "signals").
 * With no car attached (the VM, or the unit on the bench) demo data can drive
 * the gauges; a DEMO badge is drawn whenever it does.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { Canvas, withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const Demo = require('./demo');
const { GearGuess } = require('./kit/car');

const W = 1600, H = 520;
const PAGES = ['engine', 'thermal', 'chassis'];
const HIST_SEC = 300;
// gearbox enum: names or wire numbers (G1 = 3 ... G10 = 12, R = 1, N_OR_P = 2), as in kit/car.js
const GEARS = { G1: 1, G2: 2, G3: 3, G4: 4, G5: 5, G6: 6, G7: 7, G8: 8, G9: 9, G10: 10, R: -1, N_OR_P: 0 };
const gearOf = (x) => (typeof x === 'number' ? (x >= 3 && x <= 12 ? x - 2 : x === 1 ? -1 : x === 2 ? 0 : undefined) : GEARS[x]);

/**
 * Selector programme (D / S / M / P / R / N) from the gearbox status. Field names differ
 * between cars, so look at every selector-like field: enum names or on/off flags.
 */
function modeOf(o) {
    for (const k of Object.keys(o || {})) {
        if (k === 'statusActualGearDrive' || !/select|lever|position|program|mode|range|manual|sport|tip/i.test(k)) continue;
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
        const live = {}, peak = {}, hist = { coolant: [], oil: [], gearbox: [], ambient: [] };

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
        let lastCar = 0;
        const guess = new GearGuess();
        let gearLogs = 0, lastModeKey = '';
        const put = (k, v) => {
            if (v === null || v === undefined || !isFinite(v)) return;
            live[k] = v; lastCar = Date.now();
            if (peak[k] === undefined || v > peak[k]) peak[k] = v;
            if (k === 'rpm' || k === 'torque') {
                // crankshaft power from torque x speed (engine only; electric motor not included)
                if (G.isNum(live.torque) && G.isNum(live.rpm)) put('powerKw', Math.max(0, live.torque * live.rpm / 9549));
            }
            if ((k === 'rpm' || k === 'speed') && G.isNum(live.rpm) && G.isNum(live.speed)) {
                const g = guess.feed(live.rpm, live.speed);
                live.gearGuess = live.speed < 3 ? 0 : g;
            }
        };
        const watches = [
            ['de.bmw.infotainment.vehicle.CDS', {
                statusEngineSpeed2: (v) => put('rpm', sc('rpm', v.actualValueRPMEngineCrankshaft)),
                statusEngineTemperature: (v) => { put('coolant', sc('engineTemp', v.temperatureEngineDrive)); put('oil', sc('engineTemp', v.temperatureEngineOilDrive)); },
            }],
            ['de.bmw.infotainment.vehicle.CDS2', {
                statusLongitudinalAccelerationMassCenter: (v) => put('gLong', sc('accel', v.longitudinalAccelerationCentreOfGravity) / 9.80665),
                statusLateralAccelerationMassCenter: (v) => put('gLat', sc('accel', v.lateralAccelerationCentreOfGravity) / 9.80665),
            }],
            ['de.bmw.infotainment.vehicle.Vehicle2', { statusCarSpeed2: (v) => put('speed', sc('speed', v.speedVehicleCentreOfGravity)) }],
            ['de.bmw.infotainment.drivingexcitement.FES', {
                statusSwitchDriveDynamicSport2: (v) => put('boost', sc('boost', v.displayBoostPressure)),
                statusVehicleDynamicEngine: (v) => { put('powerPct', v.displaySportEnginePower); put('torquePct', v.displaySportEngineTorque); },
                statusActualValueTorque2: (v) => put('torque', sc('torque', v.actualValueTorqueCrankshaft)),
            }],
            ['de.bmw.infrastructure.VehicleInformation', {
                statusGearboxDrive: (v) => {
                    const g = gearOf(v && v.statusActualGearDrive);
                    if (g !== undefined) { live.gear = g; lastCar = Date.now(); }
                    live.gearMode = modeOf(v);
                    // field names / values differ per car: log them so the D/S/M detection can be checked
                    const key = JSON.stringify(Object.keys(v || {}).filter((x) => x !== 'statusActualGearDrive').map((x) => [x, v[x]]));
                    if (key !== lastModeKey && gearLogs < 40) { gearLogs++; lastModeKey = key; log.info('gearbox: ' + JSON.stringify(v) + ' -> ' + (live.gearMode || '?')); }
                },
            }],
            ['de.bmw.infrastructure.analytics.BasicDataSet', {
                basicDataSet: (v) => {
                    put('gearbox', sc('gearboxTemp', v.valueTemperatureTransmissionOil));
                    const split = sc('torqueSplitRear', v.valueDistributionLongitudinalTorqueRearAxisFrontAxis);
                    put('splitRear', split);
                    if (G.isNum(split) && split > 1 && split < 97) markAwd();     // torque going to the front axle
                },
            }],
            ['de.bmw.infrastructure.EnvironmentalInformation', { ExteriorTemperature: (v) => put('ambient', sc('ambient', v.temperatureExterior)) }],
            ['de.bmw.infotainment.vehicle.TPMS', {
                statusTyreTemperature: (v) => {
                    put('tFL', sc('tyreTemp', v.actualValueTemperatureTyreFLH)); put('tFR', sc('tyreTemp', v.actualValueTemperatureTyreFRH));
                    put('tRL', sc('tyreTemp', v.actualValueTemperatureTyreRLH)); put('tRR', sc('tyreTemp', v.actualValueTemperatureTyreRRH));
                },
                // kPa = 0.1 x raw, >= 65532 invalid (BMW x_call's converter); stored in bar
                statusTyrePressure: (v) => {
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
            }],
        ];
        log.info('subscribing signals');
        Promise.all(watches.map(([iface, h]) => ctx.signals.watch(iface, '1', h, log)))
            .then((subs) => log.info('signals: ' + subs.map((s) => s.iface.split('.').pop() + (s.error ? '(err)' : '')).join(' ')));

        const demo = new Demo();
        const usingDemo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && Date.now() - lastCar > 5000);
        const data = () => (usingDemo() ? demo.sample() : live);

        // 1 Hz history sampler for the thermal traces
        setInterval(() => {
            const d = data();
            Object.keys(hist).forEach((k) => { hist[k].push(d[k] == null ? null : d[k]); if (hist[k].length > HIST_SEC) hist[k].shift(); });
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

        function header(cv, t, title, d) {
            cv.text(title.toUpperCase(), 24, 34, 24, t.dim, { font: 'bold', spacing: 3 });
            G.stripes(cv, t, 24, 44, 120);
            PAGES.forEach((p, i) => cv.circle(W - 90 + i * 22, 26, i === page ? 6 : 4, i === page ? t.accent : t.tick));
            if (usingDemo()) {
                cv.roundRect(W - 230, 12, 100, 30, 6, withAlpha(t.warn, 0.2));
                cv.text('DEMO', W - 180, 35, 22, t.warn, { align: 'center', font: 'bold', spacing: 2 });
            }
        }

        /** { letter, num, est } for the gear readout, or null without any gear information. */
        function gearText(d) {
            let g = d.gear, est = false;
            if (!G.isNum(g)) { g = d.gearGuess; est = true; }
            if (!G.isNum(g)) return null;
            if (g < 0) return { letter: 'R', num: '', est };
            const m = d.gearMode;
            if (g === 0) return { letter: m === 'P' ? 'P' : 'N', num: '', est };
            return { letter: m === 'S' || m === 'M' ? m : 'D', num: String(g), est };
        }

        function drawEngine(cv, t, d) {
            const red = settings.get('redline');
            const max = Math.ceil((red + 1000) / 1000) * 1000;
            const showPk = settings.get('peaks');
            G.radial(cv, t, 300, 290, 225, {
                value: d.rpm, min: 0, max, label: 'Engine', unit: 'rpm', ticks: max / 500, majorEvery: 2, tickDiv: 1000,
                zones: [{ from: red, to: max, color: 'crit' }], limit: red, peak: showPk ? peak.rpm : null, showPeak: showPk,
            });
            const pmax = settings.get('pressUnit') === 'psi' ? 36 : 2.5;
            G.radial(cv, t, 820, 290, 225, {
                value: P(d.boost), min: 0, max: pmax, decimals: settings.get('pressUnit') === 'psi' ? 1 : 2,
                label: 'Boost', unit: settings.get('pressUnit'), ticks: 10, majorEvery: 2, tickDecimals: pmax < 5 ? 1 : 0,
                peak: showPk ? P(peak.boost) : null, showPeak: showPk, zones: [{ from: pmax * 0.85, to: pmax, color: 'warn' }], limit: pmax * 0.85,
            });
            const x = 1110, w = 466;
            G.panel(cv, t, x, 70, w, 160, 'Speed');
            const sp = V(d.speed);
            const sw = cv.text(G.fmt(sp, 0), x + 22, 212, 96, sp == null ? t.dim : t.text, { font: 'num' });
            cv.text(settings.get('speedUnit') === 'mph' ? 'mph' : 'km/h', x + 30 + sw, 212, 26, t.dim);
            // gear: D / S / M + number (R, N, P alone)
            const gr = gearText(d);
            if (gr) {
                const nw = gr.num ? cv.text(gr.num, x + w - 24, 214, 120, t.text, { align: 'right', font: 'gear' }) : 0;
                cv.text(gr.letter, x + w - 28 - nw, 214, 120, gr.letter === 'M' ? t.crit : gr.letter === 'S' ? t.accent : t.dim, { align: 'right', font: 'gear' });
                if (gr.est) cv.text('EST.', x + w - 24, 104, 16, t.dim, { align: 'right', font: 'bold', spacing: 1.5 });
            }
            const pmaxKw = settings.get('maxPower');
            G.bar(cv, t, x, 262, w, 92, { label: 'Engine power', value: d.powerKw, unit: 'kW', max: pmaxKw, zones: [{ from: pmaxKw * 0.9, to: pmaxKw * 2, color: 'crit' }], peak: showPk ? peak.powerKw : null });
            G.bar(cv, t, x, 380, w, 92, { label: 'Torque', value: d.torque, unit: 'Nm', max: 900, peak: showPk ? peak.torque : null });
        }

        function drawThermal(cv, t, d) {
            const oilWarn = settings.get('oilWarn');
            const unit = tU();
            const tiles = [
                ['Coolant', d.coolant, hist.coolant, [{ from: T(112), to: 999, color: 'crit' }, { from: -99, to: T(60), color: 'cold' }]],
                ['Engine oil', d.oil, hist.oil, [{ from: T(oilWarn), to: 999, color: 'crit' }, { from: -99, to: T(70), color: 'cold' }]],
                ['Gearbox oil', d.gearbox, hist.gearbox, [{ from: T(120), to: 999, color: 'warn' }, { from: -99, to: T(50), color: 'cold' }]],
                ['Ambient', d.ambient, hist.ambient, [{ from: -99, to: T(3), color: 'cold' }]],
            ];
            tiles.forEach(([label, v, h, zones], i) => {
                const x = 24 + (i % 2) * 784, y = 64 + Math.floor(i / 2) * 226;
                G.stat(cv, t, x, y, 760, 210, {
                    label, value: T(v), unit, zones, size: 100, history: h.map(T),
                    sub: v == null ? 'no data' : 'last 5 min  ·  min ' + G.fmt(T(Math.min.apply(null, h.filter(G.isNum))), 0) + '  max ' + G.fmt(T(Math.max.apply(null, h.filter(G.isNum))), 0),
                });
            });
        }

        function drawChassis(cv, t, d) {
            if (G.isNum(d.gLat) && G.isNum(d.gLong)) { trail.push([d.gLat, d.gLong]); if (trail.length > 60) trail.shift(); }
            G.panel(cv, t, 24, 64, 480, 440, 'G-force');
            G.gmeter(cv, t, 264, 262, 156, { lat: d.gLat, long: d.gLong, trail, max: 1.5 });
            // xDrive column (when shown), tyres take the rest
            const xd = settings.get('xdrive');
            const showAwd = xd === 'on' || (xd !== 'off' && (awdSeen || usingDemo()));
            const tx = 528, tw = showAwd ? 668 : 1048;
            drawTyres(cv, t, tx, 64, tw, 440, d);
            if (showAwd) {
                const ax = 1220, aw = 356;
                G.panel(cv, t, ax, 64, aw, 440, 'xDrive');
                const AWD = { _4WD_STANDARD: '4WD', _4WD_ALTERNATIV: '4WD Sport', _2WD: '2WD', AWDSAND: 'Sand' };
                const mode = AWD[d.awd] || '--';
                const hot = d.awdQual === 'FUNKTION_NICHT_VERFUEGBAR_FEHLER';
                cv.text(mode, ax + 24, 170, 52, hot ? t.crit : t.text, { font: 'bold' });
                if (hot) cv.text('DERATED / OFF', ax + 24, 206, 22, t.crit, { font: 'bold', spacing: 1.5 });
                const rear = d.splitRear;
                G.bar(cv, t, ax + 24, 250, aw - 48, 80, { label: 'Rear', value: rear, unit: '%' });
                G.bar(cv, t, ax + 24, 360, aw - 48, 80, { label: 'Front', value: G.isNum(rear) ? 100 - rear : null, unit: '%' });
            }
        }

        /** Top-down car with each tyre's pressure (against the car's target) and temperature. */
        function drawTyres(cv, t, x, y, w, h, d) {
            G.panel(cv, t, x, y, w, h, 'Tyres');
            const unitP = settings.get('pressUnit'), dec = unitP === 'psi' ? 0 : 1;
            const cx = x + w / 2, top = y + 70, bh = h - 100, bw = 150;
            // body: rounded shell, windscreen + rear window, FRONT marker
            cv.roundRect(cx - bw / 2, top, bw, bh, 52, withAlpha(t.track, 0.9));
            cv.strokeRoundRect(cx - bw / 2, top, bw, bh, 52, 3, t.tick);
            cv.roundRect(cx - bw / 2 + 18, top + bh * 0.24, bw - 36, 34, 12, withAlpha(t.tick, 0.45));
            cv.roundRect(cx - bw / 2 + 22, top + bh * 0.70, bw - 44, 26, 10, withAlpha(t.tick, 0.35));
            cv.text('FRONT', cx, top + 34, 16, t.dim, { align: 'center', font: 'bold', spacing: 2 });
            const tyw = 34, tyh = 84, big = w > 900;
            const corners = [['FL', -1, top + 30], ['FR', 1, top + 30], ['RL', -1, top + bh - 30 - tyh], ['RR', 1, top + bh - 30 - tyh]];
            for (const [k, side, ty] of corners) {
                const temp = d['t' + k], pr = Pt(d['p' + k]), tgt = Pt(d['pt' + k]);
                // tyre colour: temperature
                const tc = !G.isNum(temp) ? t.tick : temp < 20 ? t.cold : temp > 105 ? t.crit : temp > 90 ? t.warn : t.accent;
                const tx0 = side < 0 ? cx - bw / 2 - tyw - 8 : cx + bw / 2 + 8;
                cv.roundRect(tx0, ty, tyw, tyh, 10, tc);
                for (let i = 1; i < 4; i++) cv.fillRect(tx0 + 6, ty + i * tyh / 4, tyw - 12, 2, withAlpha(t.bg, 0.35));
                // pressure: big, coloured against the target
                let pc = G.isNum(pr) ? t.text : t.dim;
                if (G.isNum(pr) && G.isNum(tgt) && tgt > 0) { const r = pr / tgt; pc = r < 0.85 ? t.crit : r < 0.93 || r > 1.15 ? t.warn : GO; }
                const al = side < 0 ? 'right' : 'left', lx = side < 0 ? tx0 - 26 : tx0 + tyw + 26;
                const ps = G.fmt(pr, dec), size = big ? 72 : 56;
                const pw = cv.text(ps, lx + (side < 0 ? -cv.textWidth(' ' + unitP, 24) : 0), ty + 52, size, pc, { align: al, font: 'num' });
                cv.text(' ' + unitP, side < 0 ? lx : lx + pw, ty + 52, 24, t.dim, { align: al });
                cv.text(G.isNum(tgt) ? 'target ' + G.fmt(tgt, dec) : 'no target', lx, ty + 80, 18, t.dim, { align: al });
                cv.text(G.isNum(temp) ? G.fmt(T(temp), 0) + tU() : '--' + tU(), lx, ty + 118, 30, G.isNum(temp) ? tc : t.dim, { align: al, font: 'bold' });
            }
        }

        async function render() {
            const t = ctx.theme(), d = data();
            const cv = new Canvas(W, H).clear(t.bg);
            header(cv, t, ['Engine', 'Thermals', 'Chassis'][page], d);
            [drawEngine, drawThermal, drawChassis][page](cv, t, d);
            if (!render.n) { render.n = 1; log.info('first frame drawn'); }
            await ui.image('MAIN_GFX', cv);
        }

        ui.onClick('BTN_PAGE', () => { page = (page + 1) % PAGES.length; return render(); });
        ui.onClick('BTN_PEAKS', () => { Object.keys(peak).forEach((k) => delete peak[k]); trail.length = 0; return render(); });
        let loop = ctx.loop('MAIN', settings.get('fps'), render);
        settings.onChange((k) => {
            if (k === 'fps') { loop.stop(); loop = ctx.loop('MAIN', settings.get('fps'), render); }
            if (k === 'page') page = Math.max(0, PAGES.indexOf(settings.get('page')));
        });
        log.info('first render');
        const t0 = Date.now();
        render().then(() => log.info('first frame done ' + (Date.now() - t0) + ' ms')).catch((e) => log.warn('first render: ' + e));
    },
});
