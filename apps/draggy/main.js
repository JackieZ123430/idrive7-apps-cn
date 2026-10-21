'use strict';
/**
 * Drag Timer - acceleration timer drawn in the HMI's style.
 *
 *   Stop the car -> READY. Launch -> the clock starts on the first movement
 *   (or after one foot with "one-foot rollout"). Splits are interpolated
 *   between speed samples. The run ends when you lift (speed drops 5 km/h
 *   below the run's top speed) or every split is done.
 *
 * Pages: live run  /  best times + recent runs (saved in data/draggy_runs.json)
 * Speed: Vehicle2.statusCarSpeed2 (centre-of-gravity speed, BMW scaling).
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { Canvas, withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { RunTimer } = require('./timer');
const Demo = require('./demo');

const W = 1600, H = 520;
const MPH = 1.609344;
const GO = '#2fd27a';

const SPLITS = {
    kmh: [
        { key: '0-50', label: '0-50 km/h', from: 0, to: 50 },
        { key: '0-100', label: '0-100 km/h', from: 0, to: 100 },
        { key: '100-200', label: '100-200 km/h', from: 100, to: 200 },
        { key: '0-200', label: '0-200 km/h', from: 0, to: 200 },
    ],
    mph: [
        { key: '0-30mph', label: '0-30 mph', from: 0, to: 30 * MPH },
        { key: '0-60mph', label: '0-60 mph', from: 0, to: 60 * MPH },
        { key: '60-130mph', label: '60-130 mph', from: 60 * MPH, to: 130 * MPH },
        { key: '0-100mph', label: '0-100 mph', from: 0, to: 100 * MPH },
    ],
};
const DIST = {
    qm: { key: 'qm', label: '1/4 mile', dist: 402.336 },
    em: { key: 'em', label: '1/8 mile', dist: 201.168 },
    m1000: { key: 'm1000', label: '1000 m', dist: 1000 },
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

        /* ---------- saved runs ---------- */
        const FILE = path.join(ctx.dataDir, 'draggy_runs.json');
        let saved = { best: {}, runs: [] };
        try { saved = Object.assign(saved, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (e) { /* first start */ }
        const demoStore = { best: {}, runs: [] };          // demo runs are shown but never saved
        let store = saved;
        const save = () => { if (store !== saved) return; try { fs.writeFileSync(FILE, JSON.stringify(saved)); } catch (e) { log.warn('save runs: ' + e); } };
        const bestKey = (k) => k + (settings.get('rollout') ? '@ro' : '');

        /* ---------- timer ---------- */
        const splits = () => SPLITS[settings.get('speedUnit')] .concat([DIST[settings.get('distance')] || DIST.qm]);
        let lastNewBest = {};
        const onDone = (run) => {
            lastNewBest = {};
            Object.keys(run.result).forEach((k) => {
                const b = store.best[bestKey(k)];
                if (!b || run.result[k] < b.s) { store.best[bestKey(k)] = { s: run.result[k], at: run.at, trap: run.trap[k] }; lastNewBest[k] = true; }
            });
            store.runs.unshift(Object.assign({ unit: settings.get('speedUnit') }, run));
            store.runs = store.runs.slice(0, 30);
            save();
            log.info('run done ' + JSON.stringify(run.result));
        };
        let timer;
        const newTimer = () => {
            store = feedDemo ? demoStore : saved;
            timer = new RunTimer(splits(), { rollout: settings.get('rollout'), onDone });
            lastNewBest = {};
        };

        /* ---------- live data ---------- */
        const live = { speed: null, g: null, rpm: null };
        let lastCar = 0, feedDemo = false, peakG = 0;
        const demo = new Demo();
        const usingDemo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && Date.now() - lastCar > 5000);
        newTimer();

        ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusCarSpeed2: (v) => {
                const kmh = sc('speed', v.speedVehicleCentreOfGravity);
                if (kmh === null) return;
                lastCar = Date.now(); live.speed = kmh;
                if (!feedDemo) timer.feed(lastCar, kmh);
            },
        }, log).then((s) => log.info('speed signal ' + (s.error ? 'error ' + s.error : 'subscribed')));
        ctx.signals.watch('de.bmw.infotainment.vehicle.CDS2', '1', {
            statusLongitudinalAccelerationMassCenter: (v) => {
                const a = sc('accel', v.longitudinalAccelerationCentreOfGravity);
                if (a === null) return;
                live.g = a / 9.80665;
                if (timer.state === 'run' && !feedDemo) peakG = Math.max(peakG, live.g);
            },
        }, log);
        ctx.signals.watch('de.bmw.infotainment.vehicle.CDS', '1', {
            statusEngineSpeed2: (v) => { live.rpm = sc('rpm', v.actualValueRPMEngineCrankshaft); },
        }, log);

        // demo feed at 20 Hz; switching source starts a clean run
        let prevV = 0;
        setInterval(() => {
            const d = usingDemo();
            if (d !== feedDemo) { feedDemo = d; newTimer(); log.info(d ? 'demo data on' : 'live speed'); }
            if (!feedDemo) return;
            const now = Date.now(), v = demo.speed(now);
            live.g = (v - prevV) / 3.6 / 0.05 / 9.80665; prevV = v;
            live.speed = v;
            timer.feed(now, v);
            if (timer.state === 'run') peakG = Math.max(peakG, live.g);
        }, 50);

        /* ---------- units / format ---------- */
        const mph = () => settings.get('speedUnit') === 'mph';
        const V = (k) => (k == null ? null : mph() ? k / MPH : k);
        const vU = () => (mph() ? 'mph' : 'km/h');
        const secs = (s) => (G.isNum(s) ? s.toFixed(2) : '--.--');
        const when = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '. ' + p(d.getHours()) + ':' + p(d.getMinutes()); };

        /* ---------- drawing ---------- */
        let page = 0;
        const STATE = {
            wait: ['STOP TO ARM', 'dim'], ready: ['READY - LAUNCH', 'go'], run: ['TIMING', 'accent'], done: ['FINISHED', 'text'],
        };

        function header(cv, t, title) {
            cv.text(title, 24, 34, 24, t.dim, { font: 'bold', spacing: 3 });
            G.stripes(cv, t, 24, 44, 120);
            [0, 1].forEach((i) => cv.circle(W - 68 + i * 22, 26, i === page ? 6 : 4, i === page ? t.accent : t.tick));
            let x = W - 110;
            if (feedDemo) {
                cv.roundRect(x - 100, 12, 100, 30, 6, withAlpha(t.warn, 0.2));
                cv.text('DEMO', x - 50, 35, 22, t.warn, { align: 'center', font: 'bold', spacing: 2 });
                x -= 116;
            }
            if (settings.get('rollout')) {
                cv.roundRect(x - 150, 12, 150, 30, 6, withAlpha(t.dim, 0.2));
                cv.text('ROLLOUT 1 FT', x - 75, 35, 20, t.dim, { align: 'center', font: 'bold', spacing: 1 });
            }
        }

        function drawRun(cv, t) {
            const now = Date.now();
            const [stTxt, stCol] = STATE[timer.state];
            const col = stCol === 'go' ? GO : t[stCol];
            // --- speed + clock ---
            G.panel(cv, t, 24, 64, 520, 440, 'Speed');
            const sp = V(live.speed);
            cv.text(G.fmt(sp, 0), 460, 236, 150, G.isNum(sp) ? t.text : t.dim, { align: 'right', font: 'num' });
            cv.text(vU(), 476, 236, 28, t.dim);
            cv.fillRect(44, 262, 480, 2, t.panelEdge);
            const el = timer.elapsed(now);
            cv.text(secs(el), 400, 384, 96, timer.state === 'run' ? t.text : timer.state === 'done' ? t.accent2 : t.dim, { align: 'right', font: 'num' });
            cv.text('s', 412, 384, 32, t.dim);
            cv.roundRect(44, 410, 480, 44, 8, withAlpha(col, 0.18));
            if (timer.state === 'ready') cv.roundRect(44, 410, 480, 44, 8, withAlpha(GO, 0.35 + 0.25 * Math.sin(now / 160)));
            cv.text(stTxt, 284, 442, 26, col, { align: 'center', font: 'bold', spacing: 3 });
            cv.text('PEAK ' + (peakG > 0 ? peakG.toFixed(2) : '-.--') + ' g', 44, 486, 22, t.dim, { font: 'bold', spacing: 1 });
            if (G.isNum(live.rpm)) cv.text(Math.round(live.rpm) + ' rpm', 524, 486, 22, t.dim, { align: 'right', font: 'bold', spacing: 1 });

            // --- speed trace ---
            G.panel(cv, t, 568, 64, 520, 440, 'Speed trace');
            const px = 640, py = 120, pw = 424, ph = 330;
            const tr = timer.trace;
            const tMax = Math.max(6, Math.ceil(tr.length ? tr[tr.length - 1][0] / 2 + 0.5 : 0) * 2);
            const vMax = Math.max(mph() ? 80 : 120, Math.ceil(((V(timer.vmax) || 0) + 5) / 40) * 40);
            const X = (s) => px + (s / tMax) * pw, Y = (v) => py + ph - (v / vMax) * ph;
            for (let i = 0; i <= 4; i++) {
                const yy = py + (i / 4) * ph;
                cv.fillRect(px, yy, pw, 1, withAlpha(t.tick, 0.35));
                cv.text(String(Math.round(vMax * (1 - i / 4))), px - 10, yy + 8, 18, t.dim, { align: 'right' });
            }
            const step = tMax > 30 ? 10 : tMax > 12 ? 4 : 2;
            for (let s = 0; s <= tMax; s += step) cv.text(s + 's', X(s), py + ph + 26, 18, t.dim, { align: 'center' });
            if (tr.length > 1) {
                const pts = tr.map(([s, v]) => [X(s), Y(V(v))]);
                cv.fillUnder(pts, py + ph, withAlpha(t.accent, 0.16));
                cv.polyline(pts, 3, t.accent);
                splits().forEach((s) => {
                    if (s.dist || timer.cross[s.to] === undefined) return;
                    const x = X(timer.cross[s.to]), y = Y(V(s.to));
                    cv.circle(x, y, 7, t.text);
                    cv.circle(x, y, 4, t.accent);
                });
            } else {
                cv.text(timer.state === 'ready' ? 'Launch when ready' : 'Come to a stop to arm', px + pw / 2, py + ph / 2, 26, t.dim, { align: 'center' });
            }

            // --- splits ---
            G.panel(cv, t, 1112, 64, 464, 440, 'Splits');
            splits().forEach((s, i) => {
                const y = 118 + i * 77;
                const r = timer.result[s.key], b = store.best[bestKey(s.key)];
                cv.text(s.label, 1136, y + 22, 24, t.dim, { font: 'bold', spacing: 0.5 });
                cv.text(secs(r), 1520, y + 46, 44, G.isNum(r) ? t.text : withAlpha(t.dim, 0.6), { align: 'right', font: 'num' });
                cv.text('s', 1528, y + 46, 22, t.dim);
                let sub = b ? 'best ' + secs(b.s) : 'no best yet', subCol = t.dim;
                if (G.isNum(r) && lastNewBest[s.key]) { sub = 'NEW BEST'; subCol = GO; } else if (G.isNum(r) && b) {
                    const d = r - b.s; sub = (d >= 0 ? '+' : '') + d.toFixed(2) + '  vs best ' + secs(b.s); subCol = d <= 0 ? GO : t.dim;
                }
                if (s.dist && G.isNum(timer.trapSpeed[s.key])) sub = '@ ' + Math.round(V(timer.trapSpeed[s.key])) + ' ' + vU() + '   ' + sub;
                cv.text(sub, 1136, y + 50, 20, subCol, { font: 'label' });
                if (i < 4) cv.fillRect(1136, y + 64, 416, 1, withAlpha(t.tick, 0.35));
            });
        }

        function drawBest(cv, t) {
            const sp = splits();
            G.panel(cv, t, 24, 64, 640, 440, 'Best times' + (settings.get('rollout') ? ' (rollout)' : ''));
            sp.forEach((s, i) => {
                const y = 112 + i * 78, b = store.best[bestKey(s.key)];
                cv.text(s.label, 48, y + 34, 28, t.text, { font: 'bold' });
                cv.text(b ? secs(b.s) : '--.--', 560, y + 40, 52, b ? t.accent2 : t.dim, { align: 'right', font: 'num' });
                cv.text('s', 568, y + 40, 24, t.dim);
                if (b) cv.text(when(b.at) + (b.trap ? '  ·  ' + Math.round(V(b.trap)) + ' ' + vU() : ''), 48, y + 62, 20, t.dim);
                if (i < 4) cv.fillRect(48, y + 70, 592, 1, withAlpha(t.tick, 0.35));
            });

            G.panel(cv, t, 688, 64, 888, 440, 'Recent runs');
            const cols = [sp[1], sp[2], sp[4]];
            const cx = [920, 1140, 1360];
            cv.text('WHEN', 712, 142, 20, t.dim, { font: 'bold', spacing: 1 });
            cols.forEach((c, i) => cv.text(c.label.toUpperCase(), cx[i] + 150, 142, 20, t.dim, { align: 'right', font: 'bold', spacing: 1 }));
            const runs = store.runs.filter((r) => (r.unit || 'kmh') === settings.get('speedUnit')).slice(0, 8);
            if (!runs.length) cv.text('No runs yet - stop, launch, and they show up here.', 712, 230, 26, t.dim);
            runs.forEach((r, i) => {
                const y = 188 + i * 39;
                cv.text(when(r.at) + (r.rollout ? '  RO' : ''), 712, y, 24, t.text);
                cols.forEach((c, j) => {
                    const v = r.result[c.key], b = store.best[(c.key) + (r.rollout ? '@ro' : '')];
                    cv.text(secs(v), cx[j] + 150, y, 28, G.isNum(v) ? (b && Math.abs(b.s - v) < 1e-9 ? GO : t.text) : t.dim, { align: 'right', font: 'num' });
                });
                if (i < runs.length - 1) cv.fillRect(712, y + 12, 840, 1, withAlpha(t.tick, 0.25));
            });
        }

        async function render() {
            const t = ctx.theme();
            const cv = new Canvas(W, H).clear(t.bg);
            header(cv, t, page === 0 ? 'DRAG TIMER' : 'BEST TIMES');
            (page === 0 ? drawRun : drawBest)(cv, t);
            await ui.image('MAIN_GFX', cv);
        }

        /* ---------- buttons ---------- */
        let clearArmed = null;
        const actionLabel = () => ui.text('BTN_ACTION', page === 0 ? 'Reset run' : clearArmed ? 'Press again to clear' : 'Clear best times');
        ui.onClick('BTN_PAGE', () => {
            page = (page + 1) % 2;
            ui.text('BTN_PAGE', page === 0 ? 'Best times' : 'Live run');
            actionLabel();
            return render();
        });
        ui.onClick('BTN_ACTION', () => {
            if (page === 0) { timer.reset(); peakG = 0; lastNewBest = {}; return render(); }
            if (!clearArmed) {
                clearArmed = setTimeout(() => { clearArmed = null; actionLabel(); }, 5000);
                return actionLabel();
            }
            clearTimeout(clearArmed); clearArmed = null;
            store.best = {}; store.runs = []; save();
            log.info('best times cleared');
            actionLabel();
            return render();
        });

        let loop = ctx.loop('MAIN', settings.get('fps'), render);
        settings.onChange((k) => {
            if (k === 'fps') { loop.stop(); loop = ctx.loop('MAIN', settings.get('fps'), render); }
            if (k === 'speedUnit' || k === 'distance' || k === 'rollout') { newTimer(); peakG = 0; }
        });
        // the timer state machine needs launch detection even while the screen is hidden;
        // feeding happens in the signal handlers / demo interval, independent of rendering.
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
