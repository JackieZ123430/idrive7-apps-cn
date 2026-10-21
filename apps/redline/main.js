'use strict';
/**
 * Redline - full-screen rev tach drawn like an M cluster.
 *
 *   - shift-light bar that fills over the last 2000 rpm and strobes at the shift point
 *   - huge gear number (from the gearbox, or learned from rpm/speed ratios)
 *   - every upshift is scored against your shift point (EARLY / SPOT ON / LATE / LIMITER)
 *   - cold-engine rev guard: until the oil is warm the shift point is pulled down
 *     and climbs with the oil temperature
 *
 * Pages: tach / shift log. Peaks reset with BTN_RESET.
 */
const mgu = require('./kit/mgu');
const { Canvas, withAlpha, mix } = require('./kit/canvas');
const G = require('./kit/gauges');
const Car = require('./kit/car');

const W = 1600, H = 520;
const CX = 800, CY = 462, R = 392, THICK = 34;      // tach geometry
const A0 = -95, A1 = 95;                            // sweep, degrees from 12 o'clock
const MPH = 1.609344;
const GREEN = '#2fd27a', YELLOW = '#ffc21a', BLUE = '#2a7dff';
const N_LEDS = 12, LED_RANGE = 2000;

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const car = new Car(ctx, ['rpm', 'speed', 'temps', 'gear']);

        /* ---------- derived limits ---------- */
        const redline = () => settings.get('redline');
        const maxRpm = () => Math.ceil((redline() + 800) / 1000) * 1000;
        const normalShift = () => redline() - settings.get('shiftBefore');
        /** shift point right now (lowered while the oil is cold). */
        function shiftPoint(oil) {
            const n = normalShift();
            if (!settings.get('coldGuard') || !G.isNum(oil)) return { rpm: n, cold: false };
            const warm = settings.get('warmOil'), cold = Math.min(settings.get('coldLimit'), n);
            if (oil >= warm) return { rpm: n, cold: false };
            const f = G.clamp((oil - 30) / (warm - 30), 0, 1);
            return { rpm: Math.round((cold + (n - cold) * f) / 50) * 50, cold: true };
        }

        /* ---------- session state ---------- */
        let peakRpm = 0, peakSpeed = 0, overShiftMs = 0, limiterHits = 0;
        let shifts = [];                    // { at, from, to, rpm, target, verdict }
        const recent = [];                  // [t, rpm, speed] last ~1 s
        let lastGear = null, lastT = 0, onLimiter = false, lastShift = null;
        const verdict = (rpm, target, cold) => (rpm >= redline() - 60 ? 'LIMITER' : rpm < target - 250 ? 'EARLY' : rpm > target + 200 ? (cold ? 'COLD REV' : 'LATE') : 'SPOT ON');
        const VCOL = { 'SPOT ON': GREEN, EARLY: YELLOW, LATE: '#ff8a1a', LIMITER: '#ff2a2a', 'COLD REV': '#3d8bff' };

        function recordShift(t, from, to) {
            const win = recent.filter((r) => t - r[0] < 600);
            const rpm = Math.max.apply(null, win.map((r) => r[1]));
            if (!(rpm > 2500)) return;
            const sp = shiftPoint(car.data().oil);
            lastShift = { at: Date.now(), from, to, rpm: Math.round(rpm), target: sp.rpm, verdict: verdict(rpm, sp.rpm, sp.cold) };
            shifts.unshift(lastShift);
            shifts = shifts.slice(0, 60);
            log.info('shift ' + from + '->' + to + ' @' + lastShift.rpm + ' ' + lastShift.verdict);
        }

        car.onSample((d, t) => {
            if (!G.isNum(d.rpm)) return;
            const dt = lastT ? Math.min(250, t - lastT) : 0;
            lastT = t;
            recent.push([t, d.rpm, d.speed]);
            while (recent.length && t - recent[0][0] > 1200) recent.shift();
            peakRpm = Math.max(peakRpm, d.rpm);
            if (G.isNum(d.speed)) peakSpeed = Math.max(peakSpeed, d.speed);
            const sp = shiftPoint(d.oil).rpm;
            if (d.rpm >= sp) overShiftMs += dt;
            const lim = d.rpm >= redline() - 60;
            if (lim && !onLimiter) limiterHits++;
            onLimiter = lim;

            // upshift: gear number goes up, or (no gear signal) rpm falls >18 % within 0.4 s while still moving
            const g = d.gear;
            if (G.isNum(g) && g > 0 && G.isNum(lastGear) && lastGear > 0 && g === lastGear + 1) recordShift(t, lastGear, g);
            else if (!G.isNum(g) && recent.length > 4 && d.speed > 10) {
                const back = recent.filter((r) => t - r[0] < 400);
                const hi = Math.max.apply(null, back.map((r) => r[1]));
                if (hi > 3000 && d.rpm < hi * 0.82 && (!lastShift || Date.now() - lastShift.at > 800)) recordShift(t, '?', '?');
            }
            if (G.isNum(g)) lastGear = g;
        }, () => { recent.length = 0; lastGear = null; lastT = 0; });

        /* ---------- static tach background (cached) ---------- */
        const ang = (rpm) => A0 + G.clamp(rpm / maxRpm(), 0, 1) * (A1 - A0);
        const P = (a, r) => [CX + Math.sin(a * Math.PI / 180) * r, CY - Math.cos(a * Math.PI / 180) * r];
        let bg = null, bgKey = '';
        function background(t, sp) {
            const key = [settings.get('theme'), maxRpm(), redline(), sp.rpm].join('|');
            if (bg && key === bgKey) return bg;
            const cv = new Canvas(W, H).clear(t.bg);
            // soft vignette behind the dial
            cv.arc(CX, CY, 0, R + 40, 0, 360, withAlpha(t.panelTop, 0.9));
            cv.arc(CX, CY, R - THICK, R, A0, A1, t.track);
            // redline + shift zones on the outer rim
            cv.arc(CX, CY, R + 6, R + 16, ang(sp.rpm), ang(redline()), withAlpha(t.warn, 0.9));
            cv.arc(CX, CY, R + 6, R + 22, ang(redline()), A1, t.crit);
            // ticks every 500 rpm, numbers every 1000
            for (let rpm = 0; rpm <= maxRpm(); rpm += 500) {
                const a = ang(rpm), major = rpm % 1000 === 0, red = rpm >= redline();
                const [xa, ya] = P(a, R - THICK - (major ? 30 : 16)), [xb, yb] = P(a, R - THICK - 6);
                cv.line(xa, ya, xb, yb, major ? 5 : 3, red ? t.crit : major ? t.text : t.tick);
                if (major) {
                    const [lx, ly] = P(a, R - THICK - 62);
                    cv.text(String(rpm / 1000), lx, ly + 14, 40, red ? t.crit : t.text, { align: 'center', font: 'bold' });
                }
            }
            bg = cv; bgKey = key;
            return cv;
        }

        /* ---------- drawing ---------- */
        const mph = () => settings.get('speedUnit') === 'mph';
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

        function shiftLights(cv, t, rpm, sp, now) {
            const cols = ledColors(t);
            const x0 = 470, w = 660, gap = 10, lw = (w - gap * (N_LEDS - 1)) / N_LEDS, y = 14, h = 30;
            const start = sp - LED_RANGE;
            const lit = G.isNum(rpm) ? Math.floor(G.clamp((rpm - start) / LED_RANGE, 0, 1) * N_LEDS) : 0;
            const strobe = G.isNum(rpm) && rpm >= sp;
            const on = Math.floor(now / 90) % 2 === 0;
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

        function drawTach(cv, t, d, now) {
            const sp = shiftPoint(d.oil);
            cv.d.set(background(t, sp).d);
            const rpm = d.rpm;
            const strobe = shiftLights(cv, t, rpm, sp.rpm, now);
            if (strobe && settings.get('flash') && Math.floor(now / 90) % 2 === 0) {
                cv.gradientRect(0, 0, W, H, [[0, withAlpha(t.crit, 0.30)], [0.5, withAlpha(t.crit, 0.06)], [1, withAlpha(t.crit, 0.22)]]);
            }

            // live sweep
            if (G.isNum(rpm)) {
                const a = ang(rpm);
                const f = G.clamp((rpm - (sp.rpm - LED_RANGE)) / LED_RANGE, 0, 1);
                const col = rpm >= redline() - 60 ? t.crit : rpm >= sp.rpm ? '#ff2a2a' : f > 0 ? mix(t.accent, YELLOW, f * 0.8) : t.accent;
                cv.arc(CX, CY, R - THICK - 10, R + 4, A0, a, withAlpha(col, 0.16));
                cv.arc(CX, CY, R - THICK, R, A0, a, col);
                const [xa, ya] = P(a, R - THICK - 40), [xb, yb] = P(a, R + 8);
                cv.line(xa, ya, xb, yb, 7, t.text);
            }
            // peak hold
            if (peakRpm > 0) {
                const [xa, ya] = P(ang(peakRpm), R - THICK), [xb, yb] = P(ang(peakRpm), R + 26);
                cv.line(xa, ya, xb, yb, 4, t.accent2);
            }

            // gear
            const g = d.gear;
            const gs = g === -1 ? 'R' : g === 0 ? 'N' : G.isNum(g) ? String(g) : '-';
            const gc = strobe ? (Math.floor(now / 90) % 2 ? t.text : '#ff2a2a') : t.text;
            cv.text(gs, CX, CY - 92, 220, gc, { align: 'center', font: 'gear' });
            if (d.gearGuessed && G.isNum(g) && g > 0) cv.text('EST.', CX + 92, CY - 260, 18, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text(G.isNum(rpm) ? String(Math.round(rpm / 10) * 10) : '----', CX, CY - 26, 64, G.isNum(rpm) ? t.text : t.dim, { align: 'center', font: 'num' });
            cv.text('x1000 R/MIN', CX, CY + 4, 18, t.dim, { align: 'center', font: 'bold', spacing: 3 });

            // left column: speed + oil
            const v = G.isNum(d.speed) ? (mph() ? d.speed / MPH : d.speed) : null;
            cv.text('SPEED', 40, 120, 22, t.dim, { font: 'bold', spacing: 2 });
            cv.text(G.fmt(v, 0), 40, 228, 96, G.isNum(v) ? t.text : t.dim, { font: 'num' });
            cv.text(mph() ? 'mph' : 'km/h', 44, 260, 24, t.dim);
            cv.fillRect(40, 288, 250, 2, t.panelEdge);
            cv.text('OIL', 40, 330, 22, t.dim, { font: 'bold', spacing: 2 });
            const oilCol = !G.isNum(d.oil) ? t.dim : d.oil < 60 ? t.cold : d.oil < settings.get('warmOil') ? YELLOW : d.oil > 130 ? t.crit : t.text;
            cv.text(G.fmt(d.oil, 0) + (G.isNum(d.oil) ? '°' : ''), 40, 396, 64, oilCol, { font: 'num' });
            cv.text('COOLANT ' + G.fmt(d.coolant, 0) + '°', 40, 432, 22, t.dim, { font: 'bold', spacing: 1 });
            if (sp.cold) {
                cv.roundRect(40, 452, 300, 44, 8, withAlpha(t.cold, 0.2));
                cv.text('COLD  ·  LIMIT ' + sp.rpm, 190, 482, 22, t.cold, { align: 'center', font: 'bold', spacing: 1 });
            }

            // right column: shift info
            const rx = W - 40;
            cv.text('SHIFT AT', rx, 120, 22, t.dim, { align: 'right', font: 'bold', spacing: 2 });
            cv.text(String(sp.rpm), rx, 192, 64, sp.cold ? t.cold : t.text, { align: 'right', font: 'num' });
            cv.fillRect(W - 290, 220, 250, 2, t.panelEdge);
            cv.text('LAST SHIFT', rx, 262, 22, t.dim, { align: 'right', font: 'bold', spacing: 2 });
            if (lastShift) {
                const age = now - lastShift.at;
                cv.text(String(lastShift.rpm), rx, 330, 64, t.text, { align: 'right', font: 'num' });
                const vc = VCOL[lastShift.verdict];
                cv.roundRect(W - 250, 348, 210, 40, 8, withAlpha(vc, age < 2500 ? 0.45 : 0.18));
                cv.text(lastShift.verdict, W - 145, 376, 24, age < 2500 ? t.text : vc, { align: 'center', font: 'bold', spacing: 2 });
                if (lastShift.from !== '?') cv.text(lastShift.from + ' > ' + lastShift.to, W - 262, 376, 22, t.dim, { align: 'right', font: 'bold' });
            } else cv.text('--', rx, 330, 64, t.dim, { align: 'right', font: 'num' });
            cv.text('PEAK ' + (peakRpm ? Math.round(peakRpm) : '--') + '  ·  LIMITER ' + limiterHits + 'x', rx, 432, 22, t.accent2, { align: 'right', font: 'bold', spacing: 1 });
            cv.text('ABOVE SHIFT PT ' + (overShiftMs / 1000).toFixed(1) + ' s', rx, 466, 20, t.dim, { align: 'right', font: 'bold', spacing: 1 });
        }

        function drawLog(cv, t) {
            G.panel(cv, t, 24, 64, 760, 440, 'Recent upshifts');
            const up = shifts.slice(0, 9);
            if (!up.length) cv.text('No shifts yet - go and use the rev range.', 48, 200, 26, t.dim);
            up.forEach((s, i) => {
                const y = 150 + i * 39;
                const d = new Date(s.at), p = (n) => String(n).padStart(2, '0');
                cv.text(p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()), 48, y, 22, t.dim);
                cv.text(s.from === '?' ? 'upshift' : s.from + ' > ' + s.to, 200, y, 26, t.text, { font: 'bold' });
                cv.text(String(s.rpm), 470, y, 28, t.text, { align: 'right', font: 'num' });
                cv.text('/ ' + s.target, 480, y, 20, t.dim);
                cv.roundRect(590, y - 26, 170, 34, 7, withAlpha(VCOL[s.verdict], 0.25));
                cv.text(s.verdict, 675, y - 2, 20, VCOL[s.verdict], { align: 'center', font: 'bold', spacing: 1.5 });
            });

            G.panel(cv, t, 808, 64, 768, 440, 'Shift accuracy');
            const n = shifts.length;
            const cnt = (v) => shifts.filter((s) => s.verdict === v).length;
            const spot = cnt('SPOT ON');
            cv.text(n ? Math.round(spot / n * 100) + '%' : '--', 832, 210, 96, n ? GREEN : t.dim, { font: 'num' });
            cv.text('SPOT ON  (' + n + ' shifts)', 836, 244, 22, t.dim, { font: 'bold', spacing: 1 });
            ['EARLY', 'SPOT ON', 'LATE', 'COLD REV', 'LIMITER'].forEach((v, i) => {
                const y = 282 + i * 43, c = cnt(v), f = n ? c / n : 0;
                cv.text(v, 836, y + 22, 22, VCOL[v], { font: 'bold', spacing: 1 });
                cv.roundRect(990, y + 2, 460, 26, 6, t.track);
                if (f > 0) cv.roundRect(990, y + 2, Math.max(12, 460 * f), 26, 6, VCOL[v]);
                cv.text(String(c), 1540, y + 24, 26, t.text, { align: 'right', font: 'num' });
            });
            // scatter: shift rpm vs target
            if (n) {
                const ys = shifts.slice(0, 30).map((s) => s.rpm - s.target);
                const avg = ys.reduce((a, b) => a + b, 0) / ys.length;
                cv.text('AVG ' + (avg >= 0 ? '+' : '') + Math.round(avg) + ' rpm vs shift point', 1240, 210, 24, t.text, { align: 'center', font: 'bold' });
                cv.text('PEAK ' + Math.round(peakRpm) + ' RPM  ·  ' + G.fmt(mph() ? peakSpeed / MPH : peakSpeed, 0) + (mph() ? ' MPH' : ' KM/H'), 1240, 244, 20, t.dim, { align: 'center', font: 'bold', spacing: 1 });
            }
        }

        function header(cv, t, d) {
            cv.text(page === 0 ? 'REDLINE' : 'SHIFT LOG', 24, 34, 24, t.dim, { font: 'bold', spacing: 3 });
            G.stripes(cv, t, 24, 44, 120);
            if (d.demo) {
                cv.roundRect(W - 124, 12, 100, 30, 6, withAlpha(t.warn, 0.2));
                cv.text('DEMO', W - 74, 35, 22, t.warn, { align: 'center', font: 'bold', spacing: 2 });
            }
        }

        async function render() {
            const t = ctx.theme(), d = car.data(), now = Date.now();
            let cv;
            if (page === 0) { cv = new Canvas(W, H); drawTach(cv, t, d, now); } else { cv = new Canvas(W, H).clear(t.bg); drawLog(cv, t); }
            header(cv, t, d);
            await ui.image('MAIN_GFX', cv);
        }

        /* ---------- buttons ---------- */
        ui.onClick('BTN_PAGE', () => { page = 1 - page; ui.text('BTN_PAGE', page ? 'Tach' : 'Shift log'); return render(); });
        ui.onClick('BTN_RESET', () => {
            peakRpm = 0; peakSpeed = 0; overShiftMs = 0; limiterHits = 0; shifts = []; lastShift = null;
            log.info('peaks reset'); return render();
        });
        let loop = ctx.loop('MAIN', settings.get('fps'), render);
        settings.onChange((k) => {
            if (k === 'fps') { loop.stop(); loop = ctx.loop('MAIN', settings.get('fps'), render); }
            bg = null;
        });
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
