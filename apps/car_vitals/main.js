'use strict';
/**
 * M Vitals - live engine / thermal / chassis gauges drawn in the HMI's style.
 *
 * Pages (button "Next page"):
 *   engine  - RPM + boost dials, power/torque bars, speed
 *   thermal - coolant / engine oil / gearbox / ambient with 5-minute traces
 *   chassis - friction circle (g-g diagram), steering, tyre temps, xDrive split
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

const W = 1600, H = 520;
const PAGES = ['engine', 'thermal', 'chassis'];
const HIST_SEC = 300;

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
        const put = (k, v) => {
            if (v === null || v === undefined || !isFinite(v)) return;
            live[k] = v; lastCar = Date.now();
            if (peak[k] === undefined || v > peak[k]) peak[k] = v;
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
            ['de.bmw.infotainment.drivingexcitement.XView', { statusSteeringAngleDriver: (v) => put('steer', sc('steering', v.actualValueSteeringAngleDriver)) }],
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

        function header(cv, t, title, d) {
            cv.text(title.toUpperCase(), 24, 34, 24, t.dim, { font: 'bold', spacing: 3 });
            G.stripes(cv, t, 24, 44, 120);
            PAGES.forEach((p, i) => cv.circle(W - 90 + i * 22, 26, i === page ? 6 : 4, i === page ? t.accent : t.tick));
            if (usingDemo()) {
                cv.roundRect(W - 230, 12, 100, 30, 6, withAlpha(t.warn, 0.2));
                cv.text('DEMO', W - 180, 35, 22, t.warn, { align: 'center', font: 'bold', spacing: 2 });
            }
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
            cv.text(G.fmt(sp, 0), x + 22, 212, 96, sp == null ? t.dim : t.text, { font: 'num' });
            cv.text(settings.get('speedUnit') === 'mph' ? 'mph' : 'km/h', x + w - 24, 212, 30, t.dim, { align: 'right' });
            G.bar(cv, t, x, 262, w, 92, { label: 'Power', value: d.powerPct, unit: '%', zones: [{ from: 90, to: 100, color: 'crit' }], peak: showPk ? peak.powerPct : null });
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
            G.panel(cv, t, 24, 64, 520, 440, 'G-force');
            G.gmeter(cv, t, 284, 260, 160, { lat: d.gLat, long: d.gLong, trail, max: 1.5 });
            // steering + xDrive (steering takes the full height when the xDrive card is hidden)
            const xd = settings.get('xdrive');
            const showAwd = xd === 'on' || (xd !== 'off' && (awdSeen || d.demo));
            const st = d.steer;
            if (showAwd) {
                G.panel(cv, t, 568, 64, 460, 200, 'Steering');
                cv.arc(798, 230, 110, 122, -90, 90, t.track);
                if (G.isNum(st)) {
                    const a = G.clamp(st / 540, -1, 1) * 90;
                    cv.arc(798, 230, 108, 124, Math.min(0, a), Math.max(0, a), t.accent);
                }
                cv.text(G.fmt(st, 0) + '°', 798, 220, 64, G.isNum(st) ? t.text : t.dim, { align: 'center', font: 'num' });
                G.panel(cv, t, 568, 288, 460, 216, 'xDrive');
                const AWD = { _4WD_STANDARD: '4WD', _4WD_ALTERNATIV: '4WD Sport', _2WD: '2WD', AWDSAND: 'Sand' };
                const mode = AWD[d.awd] || '--';
                const hot = d.awdQual === 'FUNKTION_NICHT_VERFUEGBAR_FEHLER';
                cv.text(mode, 592, 392, 56, hot ? t.crit : t.text, { font: 'bold' });
                if (hot) cv.text('DERATED / OFF', 800, 392, 22, t.crit, { font: 'bold', spacing: 1.5 });
                G.bar(cv, t, 592, 424, 412, 64, { label: 'Rear torque', value: d.splitRear, unit: '%' });
            } else {
                G.panel(cv, t, 568, 64, 460, 440, 'Steering');
                cv.arc(798, 360, 170, 186, -90, 90, t.track, { round: true });
                if (G.isNum(st)) {
                    const a = G.clamp(st / 540, -1, 1) * 90;
                    cv.arc(798, 360, 168, 188, Math.min(0, a), Math.max(0, a), t.accent, { round: true });
                }
                cv.line(798, 166, 798, 182, 3, t.tick);
                cv.text(G.fmt(st, 0) + '°', 798, 350, 96, G.isNum(st) ? t.text : t.dim, { align: 'center', font: 'num' });
                cv.text('LEFT', 628, 400, 18, t.dim, { font: 'bold', spacing: 1.5, align: 'center' });
                cv.text('RIGHT', 968, 400, 18, t.dim, { font: 'bold', spacing: 1.5, align: 'center' });
                cv.text('steering wheel angle', 798, 470, 20, t.dim, { align: 'center' });
            }
            G.tyres(cv, t, 1052, 64, 524, 440, {
                label: 'Tyres', fl: T(d.tFL), fr: T(d.tFR), rl: T(d.tRL), rr: T(d.tRR), unit: tU(),
                coldBelow: T(20), warnAbove: T(90), hotAbove: T(105),
                pressure: {
                    fl: Pt(d.pFL), fr: Pt(d.pFR), rl: Pt(d.pRL), rr: Pt(d.pRR),
                    target: { fl: Pt(d.ptFL), fr: Pt(d.ptFR), rl: Pt(d.ptRL), rr: Pt(d.ptRR) },
                    unit: settings.get('pressUnit'), decimals: settings.get('pressUnit') === 'psi' ? 0 : 1,
                },
            });
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
