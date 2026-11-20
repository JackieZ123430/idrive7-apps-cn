'use strict';
/**
 * Brake Test - stopping distance the way magazines measure it.
 *
 *   Get above the test speed, then brake hard. Timing starts the instant the
 *   speed crosses 100 (or 200) km/h while decelerating harder than the trigger,
 *   distance is integrated from the speed signal until the car stops.
 *   One stop from 200 also gives the 100-0 result.
 *
 * Every stop is saved (data/brake_runs.json). The fade chart compares the
 * last stops: distance growing stop after stop = hot brakes.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const Car = require('./kit/car');

const SPEED_MS = 100;   // speed readout: 10 times a second

const W = 1600, H = 520;
const MPH = 1.609344, FT = 3.28084;
const GO = '#2fd27a';
const TESTS = {
    kmh: [{ key: '200-0', label: '200-0 km/h', v: 200 }, { key: '100-0', label: '100-0 km/h', v: 100 }],
    mph: [{ key: '100-0mph', label: '100-0 mph', v: 100 * MPH }, { key: '60-0mph', label: '60-0 mph', v: 60 * MPH }],
};

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const car = new Car(ctx, ['speed', 'accel']);

        const FILE = path.join(ctx.dataDir, 'brake_runs.json');
        let saved = { best: {}, runs: [] };
        try { saved = Object.assign(saved, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (e) { /* first start */ }
        const demoStore = { best: {}, runs: [] };
        let store = saved;
        const save = () => { if (store === saved) try { fs.writeFileSync(FILE, JSON.stringify(saved)); } catch (e) { log.warn('save: ' + e); } };

        const tests = () => TESTS[settings.get('speedUnit')];
        const mainTest = () => tests()[1];

        /* ---------- measurement ---------- */
        let state = 'arm', prev = null, run = null, last = null, msg = null, msgUntil = 0;
        // the speed lost since the last speed sample (or since the braking began; till then the held speed was
        // still true), by the measured deceleration: [t, km/h]. Speed comes at ~10 Hz, accel at ~50 Hz: this
        // places the 100 km/h crossing between speed samples, also while the brake pressure still builds.
        let curve = [];
        const KMH_PER_G = 9.80665 * 3.6;      // km/h per second at 1 g
        /** When the speed had dropped by need: on the curve scaled to the drop measured by t (lost); without
         * a deceleration on it, straight from its start. */
        function crossAt(need, lost, t) {
            const t1 = curve.length ? curve[0][0] : prev.t, end = curve.length ? curve[curve.length - 1][1] : 0;
            if (!(end > 0)) return t1 + need / lost * (t - t1);
            const k = lost / end;
            for (let i = 1; i < curve.length; i++) {
                const [ta, a] = curve[i - 1], [tb, b] = curve[i];
                if (k * b >= need) return ta + (need - k * a) / (k * (b - a)) * (tb - ta);
            }
            return t;
        }
        // run: { t0, dist, cross: {key: {t, d}}, trace: [[d, v, g]], peakG, released }

        function finish(t) {
            const res = {};
            tests().forEach((x) => {
                const c = run.cross[x.key];
                if (c) res[x.key] = { m: run.dist - c.d, s: (t - c.t) / 1000 };
            });
            const r = { at: Date.now(), unit: settings.get('speedUnit'), result: res, peakG: run.peakG, trace: run.trace.filter((_, i) => i % 2 === 0), vStart: run.vStart };
            const newBest = {};
            Object.keys(res).forEach((k) => {
                const b = store.best[k];
                if (!b || res[k].m < b.m) { store.best[k] = { m: res[k].m, s: res[k].s, at: r.at }; newBest[k] = true; }
            });
            r.newBest = newBest;
            store.runs.unshift(r); store.runs = store.runs.slice(0, 40);
            save();
            last = r; run = null; state = 'done';
            log.info('stop ' + JSON.stringify(res));
        }

        car.onSample((d, t) => {
            const v = d.speed, g = d.gLong;
            if (!G.isNum(v)) return;
            store = d.demo ? demoStore : saved;
            const top = tests()[0], low = mainTest();
            // accel samples come in between with the last speed held (speed is sent on change): prev is the
            // last speed sample, distance and crossings go from speed sample to speed sample only
            const fresh = !prev || v !== prev.v, braking = G.isNum(g) && -g >= 0.1;
            const c = curve[curve.length - 1];
            if (c && t > c[0]) curve.push([t, c[1] + (braking ? -g * KMH_PER_G * (t - c[0]) / 1000 : 0)]);
            if (state === 'braking') {
                const dt = (t - prev.t) / 1000;
                if (dt <= 0) return;
                if (G.isNum(g)) run.peakG = Math.max(run.peakG, -g);
                if (fresh) {
                    run.dist += (prev.v + v) / 2 / 3.6 * dt;
                    // later (lower) test speeds crossed during the same stop
                    tests().forEach((x) => {
                        if (!run.cross[x.key] && prev.v >= x.v && v < x.v) {
                            const f = (prev.v - x.v) / (prev.v - v);
                            run.cross[x.key] = { t: prev.t + f * (t - prev.t), d: run.dist - (1 - f) * (prev.v + v) / 2 / 3.6 * dt };
                        }
                    });
                    run.trace.push([run.dist, v, G.isNum(g) ? -g : null]);
                }
                if (G.isNum(g) && -g < 0.1) { run.released = run.released || t; } else run.released = 0;
                if (v < 0.5) finish(t);
                else if (run.released && t - run.released > 1200) { state = 'arm'; run = null; msg = 'Brake released - stop not counted'; msgUntil = Date.now() + 4000; }
            } else {
                if (v > low.v + 3) state = 'ready';
                else if (state === 'ready' && v < low.v - 3) state = 'arm';
                if (state === 'ready' && prev && G.isNum(g) && -g >= settings.get('trigger')) {
                    const hit = [top, low].find((x) => prev.v >= x.v && v < x.v);
                    if (hit) {
                        // on the deceleration since the speed was last known (a steady cruise sends none: prev.t is old)
                        const t0 = crossAt(prev.v - hit.v, prev.v - v, t), d0 = (hit.v + v) / 2 / 3.6 * (t - t0) / 1000;
                        run = { t0, dist: d0, cross: { [hit.key]: { t: t0, d: 0 } }, trace: [[0, hit.v, -g], [d0, v, -g]], peakG: -g, vStart: hit.v };
                        state = 'braking'; last = null;
                    }
                }
                if (state === 'done' && v > 5) state = v > low.v + 3 ? 'ready' : 'arm';
            }
            if (fresh || !braking) curve = [[t, 0]];
            if (fresh) prev = { t, v };
        }, () => { state = 'arm'; run = null; prev = null; });

        /* ---------- format ---------- */
        const ftU = () => settings.get('distUnit') === 'ft';
        const D = (m) => (G.isNum(m) ? (ftU() ? m * FT : m) : null);
        const dU = () => (ftU() ? 'ft' : 'm');
        const mph = () => settings.get('speedUnit') === 'mph';
        const V = (k) => (mph() ? k / MPH : k);
        const when = (ms) => { const d = new Date(ms), p = (n) => String(n).padStart(2, '0'); return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '. ' + p(d.getHours()) + ':' + p(d.getMinutes()); };

        /* ---------- drawing ---------- */
        let page = 0;
        const STATE = { arm: 'GET ABOVE ', ready: 'BRAKE HARD', braking: 'STOPPING', done: 'STOPPED' };

        function drawLive(cv, t, now) {
            const d = car.data(), low = mainTest();
            // ---- result / live panel
            const pr = G.panel(cv, t, 24, 44, 470, 468, run ? 'Stopping' : last ? 'Last stop' : 'Ready');
            // room below the page (where the kit gives it; all three panels reach it): the status lines move
            // down with the panels' bottom, the charts get taller
            // (each panel's last line then ends G.MARGIN over its bottom: dl status, dc chart, df fade)
            const dy = pr.y + pr.h - G.BOTTOM, dl = G.toMargin(dy, 13), dc = G.toMargin(dy, 63), df = G.toMargin(dy, 30);
            // the panel's own button (where the kit runs the screen; else the bar's Cancel run)
            G.button(cv, t, 494 - 20 - 170, 56, 170, 40, 'Cancel run', act, { key: 'cancel', busy: !run && !last });
            const showKey = last ? (last.result[low.key] ? low.key : Object.keys(last.result)[0]) : low.key;
            const lab = tests().find((x) => x.key === showKey) || low;
            const dist = run ? run.dist : last && last.result[showKey] ? last.result[showKey].m : null;
            cv.text(run ? 'FROM ' + Math.round(V(run.vStart)) : lab.label.toUpperCase(), 48, 121, 24, t.dim, { font: 'bold', spacing: 1.5 });
            const dw = cv.text(G.fmt(D(dist), 1), 48, 242, 120, G.isNum(dist) ? t.text : t.dim, { font: 'num' });
            cv.text(dU(), 56 + dw, 242, 32, t.dim);
            const r = last && last.result[showKey];
            if (r) {
                cv.text(r.s.toFixed(2) + ' s', 48, 295, 36, t.text, { font: 'num' });
                cv.text('PEAK ' + last.peakG.toFixed(2) + ' g', 210, 295, 24, t.accent2, { font: 'bold', spacing: 1 });
                const b = store.best[showKey];
                if (last.newBest[showKey]) cv.text('NEW BEST', 48, 340, 24, GO, { font: 'bold', spacing: 2 });
                else if (b) cv.text('+' + D(r.m - b.m).toFixed(1) + ' ' + dU() + ' vs best ' + D(b.m).toFixed(1), 48, 340, 22, t.dim, { font: 'bold' });
                const other = tests().find((x) => x.key !== showKey && last.result[x.key]);
                if (other) cv.text(other.label + ':  ' + D(last.result[other.key].m).toFixed(1) + ' ' + dU() + '  ·  ' + last.result[other.key].s.toFixed(2) + ' s', 48, 380, 22, t.text);
            } else if (run) {
                cv.text(G.fmt(V(G.hold('speed', d.speed, SPEED_MS)), 0) + (mph() ? ' mph' : ' km/h') + '  ·  ' + G.fmt(-d.gLong, 2) + ' g', 48, 295, 30, t.text, { font: 'bold' });
            }
            const st = state === 'arm' ? STATE.arm + Math.ceil(V(low.v + 3)) + (mph() ? ' MPH' : ' KM/H') : STATE[state];
            const col = state === 'ready' ? GO : state === 'braking' ? t.crit : t.dim;
            cv.roundRect(48, 412 + dl, 422, 44, 8, withAlpha(col, state === 'ready' ? 0.25 + 0.2 * Math.sin(now / 160) : 0.18));
            cv.text(msg && now < msgUntil ? msg.toUpperCase() : st, 259, 445 + dl, msg && now < msgUntil ? 18 : 24, col, { align: 'center', font: 'bold', spacing: 2 });
            cv.text('SPEED ' + G.fmt(V(G.hold('speed', d.speed, SPEED_MS)), 0) + '   ·   ' + G.fmt(d.gLong, 2) + ' g', 48, 495 + dl, 22, t.dim, { font: 'bold', spacing: 0.5 });

            // ---- decel trace (g over distance)
            G.panel(cv, t, 518, 44, 620, 468, 'Deceleration');
            const tr = run ? run.trace : last ? last.trace : [];
            const px = 584, py = 104, pw = 520, ph = 319 + dc;
            const dMax = Math.max(40, Math.ceil(((tr.length ? tr[tr.length - 1][0] : 0) + 5) / 20) * 20);
            const gMax = 1.5;
            const X = (m) => px + (m / dMax) * pw, Y = (g) => py + ph - (G.clamp(g, 0, gMax) / gMax) * ph;
            for (let i = 0; i <= 3; i++) {
                const gg = gMax * (1 - i / 3), yy = Y(gg);
                cv.fillRect(px, yy, pw, 1, withAlpha(t.tick, 0.35));
                cv.text(gg.toFixed(1), px - 10, yy + 7, 20, t.dim, { align: 'right' });
            }
            for (let m = 0; m <= dMax; m += dMax > 100 ? 40 : 20) cv.text(String(Math.round(D(m))), X(m), py + ph + 26, 20, t.dim, { align: 'center' });
            cv.text(dU(), px + pw + 10, py + ph + 26, 20, t.dim);
            const gp = tr.filter((p) => G.isNum(p[2])).map((p) => [X(p[0]), Y(p[2])]);
            if (gp.length > 1) { cv.fillUnder(gp, py + ph, withAlpha(t.accent, 0.16)); cv.polyline(gp, 3, t.accent); }
            const vp = tr.map((p) => [X(p[0]), py + ph - (p[1] / Math.max(1, tr[0] ? tr[0][1] : 1)) * ph]);
            if (vp.length > 1) cv.polyline(vp, 2, withAlpha(t.text, 0.5));
            if (!tr.length) cv.text('Brake hard from above ' + Math.round(V(low.v)) + (mph() ? ' mph' : ' km/h'), px + pw / 2, py + ph / 2, 26, t.dim, { align: 'center' });
            else {
                cv.fillRect(px + pw - 262, 76, 22, 3, t.accent); cv.text('DECEL g', px + pw - 234, 85, 20, t.dim, { font: 'bold', spacing: 0.5 });
                cv.fillRect(px + pw - 110, 76, 22, 2, withAlpha(t.text, 0.5)); cv.text('SPEED', px + pw - 82, 85, 20, t.dim, { font: 'bold', spacing: 0.5 });
            }

            // ---- fade chart + bests
            G.panel(cv, t, 1162, 44, 414, 468, 'Brake fade');
            const runs = store.runs.filter((x) => x.unit === settings.get('speedUnit') && x.result[low.key]).slice(0, 8).reverse();
            cv.text(low.label.toUpperCase() + ', LAST ' + runs.length, 1186, 114, 22, t.dim, { font: 'bold', spacing: 0.5 });
            if (runs.length) {
                const ms = runs.map((x) => x.result[low.key].m), lo = Math.min.apply(null, ms), hi = Math.max.apply(null, ms);
                const bw = 40, gap = 8, base = 327 + df;
                runs.forEach((x, i) => {
                    const m = x.result[low.key].m, f = hi > lo ? (m - lo) / (hi - lo) : 0.5;
                    const h = 60 + f * (120 + df), col = m - lo > lo * 0.08 ? t.crit : m - lo > lo * 0.04 ? t.warn : GO;
                    cv.roundRect(1186 + i * (bw + gap), base - h, bw, h, 5, col);
                    cv.text(D(m).toFixed(0), 1186 + i * (bw + gap) + bw / 2, base + 26, 20, t.dim, { align: 'center' });
                });
                const n = ms.length, fade = n >= 3 ? (ms[n - 1] - Math.min.apply(null, ms.slice(0, n - 1))) / Math.min.apply(null, ms.slice(0, n - 1)) : 0;
                const fc = fade > 0.08 ? t.crit : fade > 0.04 ? t.warn : GO;
                cv.text(n < 3 ? 'need 3 stops' : fade > 0.08 ? 'FADING  +' + (fade * 100).toFixed(0) + '%' : fade > 0.04 ? 'WARM  +' + (fade * 100).toFixed(0) + '%' : 'CONSISTENT', 1186, 393 + df, 26, n < 3 ? t.dim : fc, { font: 'bold', spacing: 1 });
            } else cv.text('no stops yet', 1186, 242, 24, t.dim);
            tests().forEach((x, i) => {
                const b = store.best[x.key];
                cv.text('BEST ' + x.label, 1186, 444 + df + i * 34, 22, t.dim, { font: 'bold' });
                cv.text(b ? D(b.m).toFixed(1) + ' ' + dU() : '--', 1552, 444 + df + i * 34, 24, b ? t.accent2 : t.dim, { align: 'right', font: 'num' });
            });
        }

        function drawHistory(cv, t) {
            const p = G.panel(cv, t, 24, 44, 1552, 468, 'All stops');
            G.button(cv, t, 1576 - 20 - 200, 56, 200, 40, clearArmed ? 'Yes, clear' : 'Clear log', act, { key: 'clear', color: clearArmed ? t.crit : null, busy: !store.runs.length });
            const ts = tests();
            const cols = [48, 330, 640, 950, 1180, 1400];
            ['WHEN', ts[1].label.toUpperCase(), ts[0].label.toUpperCase(), 'PEAK DECEL', 'FROM', ''].forEach((h, i) => cv.text(h, cols[i], 127, 22, t.dim, { font: 'bold', spacing: 1 }));
            // another row where the panel reaches further down (room below the page) and one fits whole
            const runs = store.runs.filter((x) => x.unit === settings.get('speedUnit')).slice(0, 8 + Math.floor((p.y + p.h - G.BOTTOM) / 41));
            if (!runs.length) cv.text('No stops yet.', 48, 210, 26, t.dim);
            runs.forEach((r, i) => {
                const y = 174 + i * 41;
                cv.text(when(r.at), cols[0], y, 24, t.text);
                [ts[1], ts[0]].forEach((x, j) => {
                    const v = r.result[x.key];
                    cv.text(v ? D(v.m).toFixed(1) + ' ' + dU() + '  ·  ' + v.s.toFixed(2) + ' s' : '--', cols[1 + j], y, 24, v ? (r.newBest[x.key] ? GO : t.text) : t.dim, { font: v ? 'bold' : 'label' });
                });
                cv.text(r.peakG.toFixed(2) + ' g', cols[3], y, 24, t.accent2, { font: 'bold' });
                cv.text(Math.round(V(r.vStart)) + (mph() ? ' mph' : ' km/h'), cols[4], y, 24, t.dim);
                if (i < runs.length - 1) cv.fillRect(48, y + 12, 1504, 1, withAlpha(t.tick, 0.25));
            });
        }

        /** G20-style frame: tab bar with the page names along the top. */
        function header(cv, t) {
            G.frame(cv, t, ['Brake test', 'History'], page, [car.data().demo && { text: 'DEMO' }]);
        }

        async function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            if (page === 0) drawLive(cv, t, Date.now()); else drawHistory(cv, t);
            header(cv, t);
            await ui.image('MAIN_GFX', cv);
        }

        /* ---------- buttons ---------- */
        let clearArmed = null;
        const actionLabel = () => ui.text('BTN_ACTION', page === 0 ? 'Cancel run' : clearArmed ? 'Yes, clear' : 'Clear log');
        const flip = () => { page = 1 - page; actionLabel(); return render(); };
        ui.onClick('BTN_PAGE', flip);
        ui.onClick('BTN_PREV', flip);
        ctx.onTab((i) => i !== page && flip());
        // Cancel run (Brake test) / Clear log, pressed twice (History): on the page, or the bar's button
        function act() {
            if (page === 0) { run = null; last = null; state = 'arm'; return render(); }
            if (!clearArmed) { clearArmed = setTimeout(() => { clearArmed = null; actionLabel(); }, 5000); return actionLabel(); }
            clearTimeout(clearArmed); clearArmed = null;
            store.best = {}; store.runs = []; save(); actionLabel();
            return render();
        }
        ui.onClick('BTN_ACTION', act);
        ctx.hideButton('BTN_ACTION');
        // every screen refresh (60 fps) with the GPU renderer; 8 fps in software (PNG frames)
        ctx.loop('MAIN', 8, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
