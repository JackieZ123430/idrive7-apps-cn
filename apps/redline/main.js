'use strict';
/**
 * Redline - full-screen rev tach drawn like the G20 Live Cockpit in Sport mode:
 * two mirrored open gauges (speed left, revs right) filling from the outer bottom
 * corners towards the centre, a huge gear between them, angular frame lines.
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
// two mirrored pods (G20 style): speed left, revs right; angles in degrees from 12 o'clock
const PY = 300, PR = 226, THICK = 16;
const SPD = { cx: 380, a0: -140, a1: 40 };          // fills clockwise from the lower left
const TAC = { cx: 1220, a0: 140, a1: -40 };         // fills anticlockwise from the lower right
const SPEED_MAX = { kmh: 260, mph: 160 };
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

        /* ---------- static cluster background (cached) ---------- */
        const P = (cx, a, r) => [cx + Math.sin(a * Math.PI / 180) * r, PY - Math.cos(a * Math.PI / 180) * r];
        const tacA = (rpm) => TAC.a0 + G.clamp(rpm / maxRpm(), 0, 1) * (TAC.a1 - TAC.a0);
        const spdMax = () => SPEED_MAX[mph() ? 'mph' : 'kmh'];
        const spdA = (v) => SPD.a0 + G.clamp(v / spdMax(), 0, 1) * (SPD.a1 - SPD.a0);
        let bg = null, bgKey = '';
        function background(t, sp) {
            const key = [settings.get('theme'), maxRpm(), redline(), sp.rpm, settings.get('speedUnit')].join('|');
            if (bg && key === bgKey) return bg;
            const cv = new Canvas(W, H).clear(t.bg);
            // soft glow behind each pod
            [SPD.cx, TAC.cx].forEach((cx) => {
                cv.arc(cx, PY, 0, PR + 30, 0, 360, withAlpha(t.panelTop, 0.55));
                cv.arc(cx, PY, 0, PR - 60, 0, 360, withAlpha(t.bg, 0.35));
            });
            // angular frame lines (the G20's hexagonal outline): over the top and under the centre
            const fl = withAlpha(t.tick, 0.55), fa = withAlpha(t.accent, 0.5);
            cv.polyline([[SPD.cx + 90, 64], [560, 64], [610, 112], [990, 112], [1040, 64], [TAC.cx - 90, 64]], 2, fl);
            cv.polyline([[610, 112], [990, 112]], 3, fa);
            cv.polyline([[560, 498], [620, 452], [980, 452], [1040, 498]], 2, fl);
            cv.polyline([[20, 498], [560, 498]], 1.5, withAlpha(t.tick, 0.35));
            cv.polyline([[1040, 498], [1580, 498]], 1.5, withAlpha(t.tick, 0.35));
            // tracks
            cv.arc(SPD.cx, PY, PR - THICK, PR, SPD.a0, SPD.a1, t.track, { round: true });
            cv.arc(TAC.cx, PY, PR - THICK, PR, TAC.a1, TAC.a0, t.track, { round: true });
            // speed ticks: every 20 (10 mph), numbers every 40 (20 mph)
            const sStep = mph() ? 10 : 20;
            for (let v = 0; v <= spdMax(); v += sStep) {
                const a = spdA(v), major = v % (sStep * 2) === 0;
                const [xa, ya] = P(SPD.cx, a, PR - THICK - (major ? 18 : 10)), [xb, yb] = P(SPD.cx, a, PR - THICK - 4);
                cv.line(xa, ya, xb, yb, major ? 3 : 2, major ? t.tick : withAlpha(t.tick, 0.6));
                if (major) { const [lx, ly] = P(SPD.cx, a, PR - THICK - 42); cv.text(String(v), lx, ly + 8, 22, t.dim, { align: 'center', font: 'label' }); }
            }
            // rev ticks every 500, numbers every 1000; shift zone + redline on the rim
            cv.arc(TAC.cx, PY, PR + 6, PR + 12, tacA(redline()), tacA(sp.rpm), withAlpha(t.warn, 0.9));
            cv.arc(TAC.cx, PY, PR + 6, PR + 16, TAC.a1, tacA(redline()), t.crit);
            for (let rpm = 0; rpm <= maxRpm(); rpm += 500) {
                const a = tacA(rpm), major = rpm % 1000 === 0, red = rpm >= redline();
                const [xa, ya] = P(TAC.cx, a, PR - THICK - (major ? 20 : 10)), [xb, yb] = P(TAC.cx, a, PR - THICK - 4);
                cv.line(xa, ya, xb, yb, major ? 4 : 2, red ? t.crit : major ? t.text : t.tick);
                if (major) { const [lx, ly] = P(TAC.cx, a, PR - THICK - 46); cv.text(String(rpm / 1000), lx, ly + 11, 30, red ? t.crit : t.text, { align: 'center', font: 'bold' }); }
            }
            bg = cv; bgKey = key;
            return cv;
        }

        /** Gauge fill with a soft glow and a bright tip. */
        function fill(cv, cx, a0, a, ramp, from, to, col) {
            cv.arc(cx, PY, PR - THICK - 8, PR + 6, a0, a, withAlpha(col, 0.14));
            cv.arc(cx, PY, PR - THICK, PR, a0, a, col, ramp ? { round: true, ramp, rampFrom: from, rampTo: to } : { round: true });
            const [x, y] = P(cx, a, PR - THICK / 2);
            cv.circle(x, y, THICK / 2 + 7, withAlpha('#ffffff', 0.22));
            cv.circle(x, y, THICK / 2 + 2, '#ffffff');
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

            // ---- speed pod (left)
            const v = G.isNum(d.speed) ? (mph() ? d.speed / MPH : d.speed) : null;
            if (G.isNum(v) && v > 0.5) fill(cv, SPD.cx, SPD.a0, spdA(v), t.ramp, SPD.a0, SPD.a1, t.accent);
            cv.text(G.fmt(v, 0), SPD.cx, PY + 30, 110, G.isNum(v) ? t.text : t.dim, { align: 'center', font: 'num' });
            cv.text(mph() ? 'mph' : 'km/h', SPD.cx, PY + 66, 24, t.dim, { align: 'center' });
            const oilCol = !G.isNum(d.oil) ? t.dim : d.oil < 60 ? t.cold : d.oil < settings.get('warmOil') ? YELLOW : d.oil > 130 ? t.crit : t.text;
            const ow = cv.text('OIL ', SPD.cx - 80, PY + 128, 18, t.dim, { font: 'bold', spacing: 2 });
            cv.text(G.fmt(d.oil, 0) + (G.isNum(d.oil) ? '°' : ''), SPD.cx - 80 + ow, PY + 128, 26, oilCol, { font: 'bold' });
            cv.text('WATER ' + G.fmt(d.coolant, 0) + '°', SPD.cx + 100, PY + 128, 18, t.dim, { align: 'right', font: 'bold', spacing: 1.5 });
            if (sp.cold) {
                cv.roundRect(SPD.cx - 130, PY + 146, 260, 34, 8, withAlpha(t.cold, 0.2));
                cv.text('COLD  ·  LIMIT ' + sp.rpm, SPD.cx, PY + 170, 18, t.cold, { align: 'center', font: 'bold', spacing: 1 });
            }

            // ---- rev pod (right): theme colour -> red at the shift point, solid red above it
            if (G.isNum(rpm) && rpm > 50) {
                const a = tacA(rpm), over = rpm >= sp.rpm;
                fill(cv, TAC.cx, TAC.a0, a, over ? null : (t.hotRamp || t.ramp), TAC.a0, tacA(sp.rpm), over ? '#ff2a2a' : t.accent);
            }
            if (peakRpm > 0) {
                const [xa, ya] = P(TAC.cx, tacA(peakRpm), PR - THICK), [xb, yb] = P(TAC.cx, tacA(peakRpm), PR + 20);
                cv.line(xa, ya, xb, yb, 3, t.accent2);
            }
            cv.text('SHIFT AT', TAC.cx, PY - 52, 16, t.dim, { align: 'center', font: 'bold', spacing: 2 });
            cv.text(String(sp.rpm), TAC.cx, PY - 4, 52, sp.cold ? t.cold : t.text, { align: 'center', font: 'num' });
            cv.text('LAST SHIFT', TAC.cx, PY + 40, 16, t.dim, { align: 'center', font: 'bold', spacing: 2 });
            if (lastShift) {
                const age = now - lastShift.at, vc = VCOL[lastShift.verdict];
                cv.text(String(lastShift.rpm) + (lastShift.from !== '?' ? '   ' + lastShift.from + '>' + lastShift.to : ''), TAC.cx, PY + 78, 30, t.text, { align: 'center', font: 'bold' });
                cv.roundRect(TAC.cx - 95, PY + 92, 190, 36, 8, withAlpha(vc, age < 2500 ? 0.45 : 0.18));
                cv.text(lastShift.verdict, TAC.cx, PY + 117, 20, age < 2500 ? t.text : vc, { align: 'center', font: 'bold', spacing: 2 });
            } else cv.text('--', TAC.cx, PY + 78, 30, t.dim, { align: 'center', font: 'bold' });

            // ---- centre: gear + rpm
            const g = d.gear;
            const gs = g === -1 ? 'R' : g === 0 ? 'N' : G.isNum(g) ? String(g) : '-';
            const gc = strobe ? (Math.floor(now / 90) % 2 ? t.text : '#ff2a2a') : t.text;
            cv.text(gs, 800, 352, 250, gc, { align: 'center', font: 'gear' });
            if (d.gearGuessed && G.isNum(g) && g > 0) cv.text('EST.', 800, 134, 16, t.dim, { align: 'center', font: 'bold', spacing: 1.5 });
            cv.text(G.isNum(rpm) ? String(Math.round(rpm / 10) * 10) : '----', 800, 418, 52, G.isNum(rpm) ? (rpm >= sp.rpm ? '#ff4a4a' : t.text) : t.dim, { align: 'center', font: 'num' });
            cv.text('RPM', 800, 442, 16, t.dim, { align: 'center', font: 'bold', spacing: 3 });
            cv.text('PEAK ' + (peakRpm ? Math.round(peakRpm) : '--') + '  ·  LIMITER ' + limiterHits + 'x  ·  ABOVE SHIFT ' + (overShiftMs / 1000).toFixed(1) + ' s',
                800, 486, 16, t.dim, { align: 'center', font: 'bold', spacing: 1 });
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
