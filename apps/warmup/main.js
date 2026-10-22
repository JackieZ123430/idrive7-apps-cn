'use strict';
/**
 * Warm-Up - know when the engine is ready to be used, and when it has cooled.
 *
 *   - oil + coolant gauges (oil is what matters: it lags coolant by minutes)
 *   - warm-up calculator: minutes and clock time until oil / coolant are warm,
 *     from the measured warm-up rate (typical rates until enough is measured),
 *     projected on the trend graph; "engine off" when a hybrid drives electric
 *   - safe rev limit that climbs from the cold limit to the redline with oil temp
 *   - 20-minute temperature trend
 *   - turbo cool-down: hard driving (high rpm or high power) builds up a cool-down
 *     time (30 s - 3 min) that counts down while driving gently or idling
 */
const mgu = require('./kit/mgu');
const { Canvas, withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const Car = require('./kit/car');

const W = 1600, H = 520;
const GO = '#2fd27a';
const HARD_RPM = 3800, HARD_KW = 90;       // above either = hard use (heats the turbo)
const GENTLE_RPM = 2800, GENTLE_KW = 40;   // below both = cooling down
const COOL_MIN = 30, COOL_MAX = 180;       // s of cool-down, growing with the hard-use time
// typical warm-up rates (deg C / min) until enough has been measured
const TYPICAL = { oil: { drive: 4, idle: 1.5 }, coolant: { drive: 7, idle: 3 } };

mgu.run({
    async start(ctx) {
        const { ui, settings } = ctx;
        const car = new Car(ctx, ['rpm', 'speed', 'temps', 'torque']);

        /* ---------- tracking ---------- */
        const hist = [];             // [t, oil, coolant] every 5 s, 20 min
        let lastHist = 0, lastT = 0;
        // cool-down: hardS = seconds of hard use; needS = cool-down it asks for; cool = gentle seconds done
        let hardS = 0, needS = 0, cool = 0, doneAt = 0;
        car.onSample((d, t) => {
            const dt = lastT ? Math.min(250, t - lastT) / 1000 : 0; lastT = t;
            if (G.isNum(d.rpm)) {
                const kw = G.isNum(d.torque) ? d.torque * d.rpm / 9549 : 0;
                const hard = d.rpm > HARD_RPM || kw > HARD_KW;
                const gentle = d.rpm < GENTLE_RPM && kw < GENTLE_KW;
                if (hard) {
                    hardS += dt; cool = 0; doneAt = 0;
                    if (hardS > 8) needS = G.clamp(COOL_MIN + hardS * 3, COOL_MIN, COOL_MAX);
                } else if (needS > 0 && gentle) {
                    cool += dt;
                    if (cool >= needS && !doneAt) doneAt = t;
                } else if (!needS) {
                    hardS = Math.max(0, hardS - dt * 0.2);      // short bursts fade away
                }
                // "cooled" message stays for 20 s, then all clear
                if (doneAt && t - doneAt > 20000) { hardS = 0; needS = 0; cool = 0; doneAt = 0; }
            }
            if (t - lastHist > 5000 && (G.isNum(d.oil) || G.isNum(d.coolant))) {
                lastHist = t; hist.push([t, d.oil, d.coolant, d.rpm, d.speed]);
                while (hist.length > 240) hist.shift();
            }
        }, () => { hist.length = 0; hardS = 0; needS = 0; cool = 0; doneAt = 0; });

        const F = () => settings.get('tempUnit') === 'f';
        const T = (c) => (G.isNum(c) ? (F() ? c * 9 / 5 + 32 : c) : null);
        const tU = () => (F() ? '°F' : '°C');
        const pad = (n) => (n < 10 ? '0' : '') + n;
        const clock = (ms) => { const x = new Date(ms); return pad(x.getHours()) + ':' + pad(x.getMinutes()); };

        function limit(oil) {
            const warm = settings.get('warmOil'), red = settings.get('redline'), cold = Math.min(settings.get('coldLimit'), red);
            if (!G.isNum(oil)) return null;
            if (oil >= warm) return red;
            return Math.round((cold + (red - cold) * G.clamp((oil - 30) / (warm - 30), 0, 1)) / 100) * 100;
        }

        /** deg C per minute over the last ~3 min (least squares) and the time it covers (ms). */
        function measured(idx) {
            const last = hist.length ? hist[hist.length - 1][0] : 0;
            const pts = hist.filter((h) => G.isNum(h[idx]) && last - h[0] < 180000);
            if (pts.length < 4) return { rate: null, span: 0 };
            const n = pts.length, mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[idx], 0) / n;
            let num = 0, den = 0;
            pts.forEach((p) => { num += (p[0] - mx) * (p[idx] - my); den += (p[0] - mx) * (p[0] - mx); });
            return { rate: den ? num / den * 60000 : null, span: pts[n - 1][0] - pts[0][0] };
        }

        /**
         * Warm-up estimate for 'oil' / 'coolant': { state, min, rate, est }.
         * state: ready | warming | off (engine not running) | stalled (not getting warmer).
         * The typical rate is blended into the measured one over the first 2 minutes (est = mostly typical).
         */
        function eta(key, temp, target, d) {
            if (!G.isNum(temp)) return { state: 'none' };
            if (temp >= target) return { state: 'ready' };
            if (G.isNum(d.rpm) && d.rpm < 300) return { state: 'off' };
            const m = measured(key === 'oil' ? 1 : 2);
            const typ = TYPICAL[key][G.isNum(d.speed) && d.speed > 10 ? 'drive' : 'idle'];
            const w = G.clamp(m.span / 120000, 0, 1);
            const rate = G.isNum(m.rate) ? w * m.rate + (1 - w) * typ : typ;
            if (w > 0.8 && rate < 0.15) return { state: 'stalled', rate };
            const min = (target - temp) / Math.max(0.15, rate);
            return { state: 'warming', min, rate, est: w < 0.5 };
        }

        /* ---------- drawing ---------- */
        function gauge(cv, t, cx, cy, r, val, label, warm) {
            G.radial(cv, t, cx, cy, r, {
                value: T(val), min: T(0), max: T(150), label, unit: tU(), decimals: 0, ticks: 6, majorEvery: 1,
                zones: [{ from: T(0), to: T(warm - 0.01), color: 'cold' }, { from: T(120), to: T(135), color: 'warn' }, { from: T(135), to: T(150), color: 'crit' }],
                tickLabels: true,
            });
        }

        /** One "ready in" row: label, big minutes, clock time + rate on the right. */
        function etaRow(cv, t, y, label, e, target) {
            cv.text(label, 952, y, 18, t.dim, { font: 'bold', spacing: 2 });
            let big, col = t.text, right = '', unit = '';
            if (e.state === 'ready') { big = 'READY'; col = GO; }
            else if (e.state === 'off') { big = 'ENGINE OFF'; col = t.dim; right = 'not warming (electric driving)'; }
            else if (e.state === 'stalled') { big = 'NOT WARMING'; col = t.warn; right = 'drive to warm up faster'; }
            else if (e.state === 'warming') {
                big = e.min > 60 ? '>60' : '~' + Math.max(1, Math.round(e.min)); unit = 'min';
                right = 'at ' + clock(Date.now() + e.min * 60000) + '  ·  ' + (F() ? e.rate * 1.8 : e.rate).toFixed(1) + tU() + '/min' + (e.est ? ' (est.)' : '');
            } else { big = '--'; col = t.dim; }
            // the large number font has digits and a few letters only: words in bold, minutes in num + 'min'
            const bw = cv.text(big, 952, y + 50, unit ? 52 : 40, col, { font: unit || big === '--' ? 'num' : 'bold', spacing: unit ? 0 : 1 });
            if (unit) cv.text(unit, 960 + bw, y + 50, 24, t.dim);
            if (right) cv.text(right, 1552, y + 46, 20, t.dim, { align: 'right' });
            cv.text('target ' + Math.round(T(target)) + tU(), 1552, y, 18, t.dim, { align: 'right' });
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
            const warm = settings.get('warmOil'), warmC = settings.get('warmCoolant');
            G.panel(cv, t, 24, 64, 880, 440, null);
            gauge(cv, t, 240, 300, 196, d.oil, 'Oil', warm);
            gauge(cv, t, 688, 300, 196, d.coolant, 'Coolant', warmC);

            // ---- status panel
            G.panel(cv, t, 928, 64, 648, 440, null);
            const lim = limit(d.oil);
            const ready = G.isNum(d.oil) && d.oil >= warm;
            const hot = G.isNum(d.oil) && d.oil > 125;
            const cooling = settings.get('cooldown') && needS > 0;
            let st, col;
            if (!G.isNum(d.oil)) { st = 'NO OIL TEMP'; col = t.dim; }
            else if (hot) { st = 'OIL HOT - EASE OFF'; col = t.crit; }
            else if (cooling) { st = doneAt ? 'COOLED - OK TO SWITCH OFF' : 'TURBO COOL-DOWN'; col = doneAt ? GO : t.warn; }
            else if (ready) { st = 'READY'; col = GO; }
            else if (d.oil >= warm - 20) { st = 'WARMING UP'; col = t.warn; }
            else { st = 'COLD'; col = t.cold; }
            cv.roundRect(952, 88, 600, 60, 10, withAlpha(col, 0.22));
            if (st === 'READY') cv.roundRect(952, 88, 600, 60, 10, withAlpha(col, 0.15 + 0.1 * Math.sin(now / 400)));
            cv.text(st, 1252, 130, st.length > 14 ? 30 : 38, col, { align: 'center', font: 'bold', spacing: 3 });

            if (cooling) {
                // big countdown: gentle driving / idling cools the turbo and oil
                const left = Math.max(0, needS - cool);
                const gentleNow = G.isNum(d.rpm) && d.rpm < GENTLE_RPM;
                // the oil warm-up stays visible as one line
                const eo = eta('oil', d.oil, warm, d);
                const line = eo.state === 'ready' ? 'Oil warm' : eo.state === 'warming' ? 'Oil ready in ~' + Math.max(1, Math.round(eo.min)) + ' min (at ' + clock(now + eo.min * 60000) + ')'
                    : eo.state === 'off' ? 'Engine off - oil not warming' : eo.state === 'stalled' ? 'Oil not warming' : '';
                cv.text(line, 952, 182, 20, eo.state === 'ready' ? GO : t.dim, { font: 'bold' });
                cv.text('COOL-DOWN LEFT', 952, 216, 18, t.dim, { font: 'bold', spacing: 2 });
                const lw = cv.text(left > 0 ? String(Math.ceil(left)) : '0', 952, 292, 80, left > 0 ? t.text : GO, { font: 'num' });
                cv.text('s', 962 + lw, 292, 30, t.dim);
                cv.text(left > 0 ? (gentleNow ? 'counting - keep it gentle' : 'paused - under ' + GENTLE_RPM + ' rpm to count') : 'done', 1552, 252, 22, left > 0 && !gentleNow ? t.warn : t.text, { align: 'right', font: 'bold' });
                cv.text('after ' + Math.round(hardS) + ' s of hard driving', 1552, 282, 20, t.dim, { align: 'right' });
                const f = needS ? G.clamp(cool / needS, 0, 1) : 1;
                cv.roundRect(952, 306, 600, 12, 6, t.track);
                if (f > 0) cv.rampRect(952, 306, Math.max(12, 600 * f), 12, 6, [t.warn, GO], 952, 600);
            } else {
                etaRow(cv, t, 182, 'OIL READY IN', eta('oil', d.oil, warm, d), warm);
                etaRow(cv, t, 262, 'COOLANT READY IN', eta('coolant', d.coolant, warmC, d), warmC);
            }

            // ---- safe rev limit (always) + trend
            const red = settings.get('redline'), fl = lim ? lim / red : 0;
            cv.text('SAFE REV LIMIT', 952, 352, 16, t.dim, { font: 'bold', spacing: 2 });
            cv.text(lim ? lim + ' rpm' : '---- rpm', 1552, 354, 22, ready ? GO : t.text, { align: 'right', font: 'bold' });
            cv.roundRect(1130, 344, 280, 8, 4, t.track);
            if (fl > 0) cv.roundRect(1130, 344, 280 * fl, 8, 4, ready ? GO : col);

            const gx = 952, gy = 376, gw = 600, gh = 90;
            const now0 = hist.length ? hist[hist.length - 1][0] : now;
            const span = G.clamp(hist.length ? now0 - hist[0][0] : 0, 300000, 1200000);
            const ahead = 300000;                                  // projection: up to 5 min ahead
            const lo = 0, hi = 140;
            const X = (ts) => gx + (gw - 90) - ((now0 - ts) / span) * (gw - 90), Y = (c) => gy + gh - (G.clamp(c, lo, hi) - lo) / (hi - lo) * gh;
            cv.text('LAST ' + Math.round(span / 60000) + ' MIN + NEXT 5', gx, gy - 6, 14, t.dim, { font: 'bold', spacing: 1.5 });
            cv.fillRect(gx + 240, gy - 14, 18, 3, t.accent); cv.text('OIL', gx + 262, gy - 6, 14, t.dim, { font: 'bold' });
            cv.fillRect(gx + 310, gy - 14, 18, 3, t.cold); cv.text('COOLANT', gx + 332, gy - 6, 14, t.dim, { font: 'bold' });
            cv.fillRect(gx, Y(warm), gw, 1, withAlpha(GO, 0.5));
            cv.text(String(Math.round(T(warm))), gx + gw + 6, Y(warm) + 6, 14, GO);
            cv.fillRect(gx + gw - 90, gy, 1, gh, withAlpha(t.tick, 0.5));       // "now"
            [[1, t.accent, 'oil', warm, d.oil], [2, t.cold, 'coolant', warmC, d.coolant]].forEach(([i, c, key, target, cur]) => {
                const pts = hist.filter((h) => G.isNum(h[i])).map((h) => [X(h[0]), Y(h[i])]);
                if (pts.length > 1) cv.polyline(pts, 3, c);
                // projection to the target, dashed
                const e = eta(key, cur, target, d);
                if (e.state === 'warming' && pts.length) {
                    const x0 = gx + gw - 90, y0 = Y(cur), mins = Math.min(e.min, ahead / 60000);
                    const x1 = x0 + (mins * 60000 / ahead) * 90, y1 = Y(cur + e.rate * mins);
                    for (let k = 0; k < 6; k++) {
                        const a = k / 6, b = (k + 0.5) / 6;
                        cv.line(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a, x0 + (x1 - x0) * b, y0 + (y1 - y0) * b, 2, withAlpha(c, 0.8));
                    }
                }
            });
            cv.fillRect(gx, gy + gh, gw, 1, withAlpha(t.tick, 0.5));
            return ui.image('MAIN_GFX', cv);
        }

        let loop = ctx.loop('MAIN', settings.get('fps'), render);
        settings.onChange((k) => { if (k === 'fps') { loop.stop(); loop = ctx.loop('MAIN', settings.get('fps'), render); } });
        render().then(() => ctx.log.info('first frame done')).catch((e) => ctx.log.warn('first render: ' + e));
    },
});
