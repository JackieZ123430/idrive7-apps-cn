'use strict';
/**
 * Warm-Up - know when the engine is ready to be used, and when it has cooled.
 *
 *   - oil + coolant gauges (oil is what matters: it lags coolant by minutes)
 *   - safe rev limit that climbs from the cold limit to the redline with oil temp
 *   - ETA to "ready" from the current warm-up rate
 *   - 20-minute temperature trend
 *   - turbo cool-down: after hard driving, counts gentle driving / idle time
 *     before it's kind to switch off
 */
const mgu = require('./kit/mgu');
const { Canvas, withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const Car = require('./kit/car');

const W = 1600, H = 520;
const GO = '#2fd27a';
const COOL_NEED = 60;            // s of gentle running after hard use

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const car = new Car(ctx, ['rpm', 'speed', 'temps']);

        /* ---------- tracking ---------- */
        const hist = [];             // [t, oil, coolant] every 5 s, 20 min
        let lastHist = 0, hardMs = 0, lastT = 0, cool = 0, wasHard = 0;
        car.onSample((d, t) => {
            const dt = lastT ? Math.min(250, t - lastT) : 0; lastT = t;
            if (G.isNum(d.rpm)) {
                // "hard" = high revs; decays slowly so one blast doesn't count forever
                if (d.rpm > 4500) { hardMs += dt; wasHard = t; } else hardMs = Math.max(0, hardMs - dt * 0.1);
                if (hardMs > 20000 && d.rpm < 2800) cool += dt / 1000; else if (d.rpm >= 3500) cool = 0;
                if (cool >= COOL_NEED + 30) { hardMs = 0; cool = 0; }
            }
            if (t - lastHist > 5000 && (G.isNum(d.oil) || G.isNum(d.coolant))) {
                lastHist = t; hist.push([t, d.oil, d.coolant]);
                while (hist.length > 240) hist.shift();
            }
        }, () => { hist.length = 0; hardMs = 0; cool = 0; });

        const F = () => settings.get('tempUnit') === 'f';
        const T = (c) => (G.isNum(c) ? (F() ? c * 9 / 5 + 32 : c) : null);
        const tU = () => (F() ? '°F' : '°C');

        function limit(oil) {
            const warm = settings.get('warmOil'), red = settings.get('redline'), cold = Math.min(settings.get('coldLimit'), red);
            if (!G.isNum(oil)) return null;
            if (oil >= warm) return red;
            return Math.round((cold + (red - cold) * G.clamp((oil - 30) / (warm - 30), 0, 1)) / 100) * 100;
        }

        /** °C per minute over the last ~2 min (least squares). */
        function rate(idx) {
            const pts = hist.filter((h) => G.isNum(h[idx]) && hist[hist.length - 1][0] - h[0] < 120000);
            if (pts.length < 4) return null;
            const n = pts.length, mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[idx], 0) / n;
            let num = 0, den = 0;
            pts.forEach((p) => { num += (p[0] - mx) * (p[idx] - my); den += (p[0] - mx) * (p[0] - mx); });
            return den ? num / den * 60000 : null;
        }

        /* ---------- drawing ---------- */
        function gauge(cv, t, cx, cy, r, val, label, warm) {
            const toU = (c) => T(c);
            G.radial(cv, t, cx, cy, r, {
                value: toU(val), min: toU(0), max: toU(150), label, unit: tU(), decimals: 0, ticks: 6, majorEvery: 1,
                zones: [{ from: toU(0), to: toU(warm - 0.01), color: 'cold' }, { from: toU(120), to: toU(135), color: 'warn' }, { from: toU(135), to: toU(150), color: 'crit' }],
                tickLabels: true,
            });
        }

        function render() {
            const t = ctx.theme(), d = car.data(), now = Date.now();
            const cv = new Canvas(W, H).clear(t.bg);
            cv.text('WARM-UP', 24, 34, 24, t.dim, { font: 'bold', spacing: 3 });
            G.stripes(cv, t, 24, 44, 120);
            if (d.demo) {
                cv.roundRect(W - 124, 12, 100, 30, 6, withAlpha(t.warn, 0.2));
                cv.text('DEMO', W - 74, 35, 22, t.warn, { align: 'center', font: 'bold', spacing: 2 });
            }
            const warm = settings.get('warmOil');
            G.panel(cv, t, 24, 64, 880, 440, null);
            gauge(cv, t, 240, 300, 196, d.oil, 'Oil', warm);
            gauge(cv, t, 688, 300, 196, d.coolant, 'Coolant', 75);

            // ---- status panel
            G.panel(cv, t, 928, 64, 648, 440, null);
            const lim = limit(d.oil);
            const ready = G.isNum(d.oil) && d.oil >= warm;
            const hot = G.isNum(d.oil) && d.oil > 125;
            const cooling = settings.get('cooldown') && hardMs > 20000;
            let st, col;
            if (!G.isNum(d.oil)) { st = 'NO OIL TEMP'; col = t.dim; }
            else if (hot) { st = 'OIL HOT - EASE OFF'; col = t.crit; }
            else if (cooling) { st = cool >= COOL_NEED ? 'COOLED - OK TO SWITCH OFF' : 'COOL DOWN'; col = cool >= COOL_NEED ? GO : t.warn; }
            else if (ready) { st = 'READY'; col = GO; }
            else if (d.oil >= warm - 20) { st = 'WARMING UP'; col = t.warn; }
            else { st = 'COLD'; col = t.cold; }
            cv.roundRect(952, 88, 600, 64, 10, withAlpha(col, 0.22));
            if (st === 'READY') cv.roundRect(952, 88, 600, 64, 10, withAlpha(col, 0.15 + 0.1 * Math.sin(now / 400)));
            cv.text(st, 1252, 132, st.length > 14 ? 30 : 40, col, { align: 'center', font: 'bold', spacing: 3 });

            if (cooling) {
                const left = Math.max(0, COOL_NEED - cool);
                cv.text('GENTLE RUNNING / IDLE', 952, 200, 22, t.dim, { font: 'bold', spacing: 2 });
                cv.text(left > 0 ? Math.ceil(left) + ' s' : 'done', 952, 290, 96, left > 0 ? t.text : GO, { font: 'num' });
                cv.text('keep under 2800 rpm to let the turbo and oil cool', 952, 330, 20, t.dim);
            } else {
                cv.text('SAFE REV LIMIT', 952, 200, 22, t.dim, { font: 'bold', spacing: 2 });
                const lw = cv.text(lim ? String(lim) : '----', 952, 290, 96, ready ? t.text : col, { font: 'num' });
                cv.text('rpm', 962 + lw, 290, 28, t.dim);
                const r = rate(1);
                let eta = 'ready';
                if (!ready) eta = G.isNum(r) && r > 0.2 ? '~' + Math.max(1, Math.round((warm - d.oil) / r)) + ' min to ready' : 'warming...';
                cv.text(eta.toUpperCase(), 1552, 290, 24, ready ? GO : t.text, { align: 'right', font: 'bold', spacing: 1 });
                if (G.isNum(r)) cv.text((r >= 0 ? '+' : '') + (F() ? r * 1.8 : r).toFixed(1) + tU() + ' / min', 1552, 254, 20, t.dim, { align: 'right', font: 'bold' });
                // limit bar
                const red = settings.get('redline'), f = lim ? lim / red : 0;
                cv.roundRect(952, 310, 600, 14, 7, t.track);
                if (f > 0) cv.roundRect(952, 310, 600 * f, 14, 7, ready ? GO : col);
            }

            // ---- trend
            const gx = 952, gy = 360, gw = 600, gh = 110;
            const now0 = hist.length ? hist[hist.length - 1][0] : now;
            const span = G.clamp(hist.length ? now0 - hist[0][0] : 0, 300000, 1200000);
            cv.text('LAST ' + Math.round(span / 60000) + ' MIN', gx, gy - 4, 16, t.dim, { font: 'bold', spacing: 2 });
            cv.fillRect(gx + 130, gy - 12, 20, 3, t.accent); cv.text('OIL', gx + 156, gy - 4, 16, t.dim, { font: 'bold' });
            cv.fillRect(gx + 210, gy - 12, 20, 3, t.cold); cv.text('COOLANT', gx + 236, gy - 4, 16, t.dim, { font: 'bold' });
            const lo = 0, hi = 140;
            const X = (ts) => gx + gw - ((now0 - ts) / span) * gw, Y = (c) => gy + 8 + gh - (G.clamp(c, lo, hi) - lo) / (hi - lo) * gh;
            cv.fillRect(gx, Y(warm), gw, 1, withAlpha(GO, 0.5));
            cv.text(String(Math.round(T(warm))), gx + gw + 6, Y(warm) + 6, 16, GO);
            [[1, t.accent], [2, t.cold]].forEach(([i, c]) => {
                const pts = hist.filter((h) => G.isNum(h[i])).map((h) => [X(h[0]), Y(h[i])]);
                if (pts.length > 1) cv.polyline(pts, 3, c);
            });
            cv.fillRect(gx, gy + 8 + gh, gw, 1, withAlpha(t.tick, 0.5));
            return ui.image('MAIN_GFX', cv);
        }

        let loop = ctx.loop('MAIN', settings.get('fps'), render);
        settings.onChange((k) => { if (k === 'fps') { loop.stop(); loop = ctx.loop('MAIN', settings.get('fps'), render); } });
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
