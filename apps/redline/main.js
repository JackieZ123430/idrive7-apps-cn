'use strict';
/**
 * Redline - full-screen rev display in the style of the G20 Live Cockpit (Sport):
 * a tall slanted rev bar that rises with the revs (segmented, theme colour to red
 * at the shift point), a huge gear in the middle, digital speed, angular lines.
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
const { Canvas, withAlpha, ramp } = require('./kit/canvas');
const G = require('./kit/gauges');
const Car = require('./kit/car');

const W = 1600, H = 520;
// rising rev bar (G20 style): a slanted parallelogram, bottom-left corner at (x, y0),
// leaning right by 'slant' over its height
const BAR = { x: 1150, w: 104, y0: 486, y1: 70, slant: 64 };
const GX = 790;                                     // centre column (gear + rpm)
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

        /* ---------- rev bar geometry + static background (cached) ---------- */
        const barY = (rpm) => BAR.y0 - G.clamp(rpm / maxRpm(), 0, 1) * (BAR.y0 - BAR.y1);
        const barX = (y) => BAR.x + BAR.slant * (BAR.y0 - y) / (BAR.y0 - BAR.y1);     // left edge at height y
        /** Fill the bar between two heights (row by row, so the slant stays anti-aliased). */
        function barRows(cv, yTop, yBot, colAt, pad) {
            pad = pad || 0;
            for (let y = Math.floor(yTop); y < Math.ceil(yBot); y++) {
                const h = Math.min(y + 1, yBot) - Math.max(y, yTop);
                if (h > 0) cv.fillRect(barX(y + 0.5) - pad, Math.max(y, yTop), BAR.w + 2 * pad, h, colAt(y));
            }
        }
        let bg = null, bgKey = '';
        function background(t, sp) {
            const key = [settings.get('theme'), maxRpm(), redline(), sp.rpm].join('|');
            if (bg && key === bgKey) return bg;
            const cv = new Canvas(W, H).clear(t.bg);
            // angular frame lines (the G20's outline)
            const fl = withAlpha(t.tick, 0.55);
            cv.polyline([[24, 64], [470, 64], [510, 96], [1060, 96], [1100, 64], [BAR.x - 20, 64]], 2, fl);
            cv.polyline([[510, 96], [1060, 96]], 3, withAlpha(t.accent, 0.5));
            cv.polyline([[24, 498], [470, 498], [510, 470], [1060, 470], [1100, 498], [BAR.x - 30, 498]], 2, fl);
            // bar track, with the redline part tinted
            barRows(cv, BAR.y1, BAR.y0, (y) => (y < barY(redline()) ? withAlpha(t.crit, 0.28) : t.track));
            // segment gaps every 500 rpm + scale on the right: ticks, numbers every 1000, shift / redline marks
            for (let rpm = 500; rpm < maxRpm(); rpm += 500) cv.fillRect(barX(barY(rpm)) - 1, barY(rpm) - 1.5, BAR.w + 2, 3, t.bg);
            for (let rpm = 0; rpm <= maxRpm(); rpm += 500) {
                const y = barY(rpm), x = barX(y) + BAR.w + 10, major = rpm % 1000 === 0, red = rpm >= redline();
                cv.fillRect(x, y - (major ? 1.5 : 1), major ? 18 : 10, major ? 3 : 2, red ? t.crit : major ? t.text : t.tick);
                if (major) cv.text(String(rpm / 1000), x + 26, y + 11, 30, red ? t.crit : t.text, { font: 'bold' });
            }
            const ys = barY(sp.rpm), yr = barY(redline());
            cv.fillRect(barX(ys) - 12, ys - 2, BAR.w + 24, 4, t.warn);                      // shift point
            cv.fillRect(barX(yr) - 12, yr - 2, BAR.w + 24, 4, t.crit);                      // redline
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
            const x0 = GX - 330, w = 660, gap = 10, lw = (w - gap * (N_LEDS - 1)) / N_LEDS, y = 14, h = 30;
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

            // ---- rev bar: rises with the revs; theme colour -> red at the shift point, solid red above
            if (G.isNum(rpm) && rpm > 50) {
                const top = barY(rpm), over = rpm >= sp.rpm, hot = t.hotRamp || t.ramp, ys = barY(sp.rpm);
                const colAt = (y) => (over ? '#ff2a2a' : ramp(hot, G.clamp((BAR.y0 - y) / (BAR.y0 - ys), 0, 1)));
                barRows(cv, top, BAR.y0, (y) => withAlpha(colAt(y), 0.16), 8);                // glow
                barRows(cv, top, BAR.y0, colAt);
                for (let r = 500; r < rpm; r += 500) { const y = barY(r); cv.fillRect(barX(y) - 1, y - 1.5, BAR.w + 2, 3, t.bg); }
                cv.fillRect(barX(top) - 6, top - 3, BAR.w + 12, 6, '#ffffff');               // bright top edge
            }
            if (peakRpm > 0) { const y = barY(peakRpm); cv.fillRect(barX(y) - 16, y - 1.5, 12, 3, t.accent2); }

            // ---- centre: huge gear + rpm
            const g = d.gear;
            const gs = g === -1 ? 'R' : g === 0 ? 'N' : G.isNum(g) ? String(g) : '-';
            const gc = strobe ? (Math.floor(now / 90) % 2 ? t.text : '#ff2a2a') : t.text;
            cv.text(gs, GX, 352, 300, gc, { align: 'center', font: 'gear' });
            if (d.gearGuessed && G.isNum(g) && g > 0) cv.text('EST.', GX, 124, 16, t.dim, { align: 'center', font: 'bold', spacing: 1.5 });
            const rw = cv.text(G.isNum(rpm) ? String(Math.round(rpm / 10) * 10) : '----', GX - 24, 452, 96, G.isNum(rpm) ? (rpm >= sp.rpm ? '#ff4a4a' : t.text) : t.dim, { align: 'center', font: 'num' });
            cv.text('RPM', GX - 24 + rw / 2 + 12, 452, 22, t.dim, { font: 'bold', spacing: 2 });

            // ---- left: digital speed, temperatures, cold guard, stats
            const v = G.isNum(d.speed) ? (mph() ? d.speed / MPH : d.speed) : null;
            cv.text('SPEED', 40, 112, 18, t.dim, { font: 'bold', spacing: 2 });
            const vw = cv.text(G.fmt(v, 0), 36, 258, 150, G.isNum(v) ? t.text : t.dim, { font: 'num' });
            cv.text(mph() ? 'mph' : 'km/h', 48 + vw, 258, 28, t.dim);
            cv.fillRect(40, 288, 400, 1, withAlpha(t.tick, 0.6));
            const oilCol = !G.isNum(d.oil) ? t.dim : d.oil < 60 ? t.cold : d.oil < settings.get('warmOil') ? YELLOW : d.oil > 130 ? t.crit : t.text;
            cv.text('OIL', 40, 330, 18, t.dim, { font: 'bold', spacing: 2 });
            cv.text(G.fmt(d.oil, 0) + (G.isNum(d.oil) ? '°' : ''), 40, 378, 44, oilCol, { font: 'bold' });
            cv.text('WATER', 220, 330, 18, t.dim, { font: 'bold', spacing: 2 });
            cv.text(G.fmt(d.coolant, 0) + (G.isNum(d.coolant) ? '°' : ''), 220, 378, 44, t.text, { font: 'bold' });
            if (sp.cold) {
                cv.roundRect(40, 400, 300, 36, 8, withAlpha(t.cold, 0.2));
                cv.text('COLD  ·  LIMIT ' + sp.rpm, 190, 425, 18, t.cold, { align: 'center', font: 'bold', spacing: 1 });
            }
            cv.text('PEAK ' + (peakRpm ? Math.round(peakRpm) : '--') + '  ·  LIMITER ' + limiterHits + 'x  ·  ABOVE SHIFT ' + (overShiftMs / 1000).toFixed(1) + ' s',
                40, 476, 16, t.dim, { font: 'bold', spacing: 1 });

            // ---- right of the bar: shift point + last shift
            const rx = W - 24;
            cv.text('SHIFT AT', rx, 112, 16, t.dim, { align: 'right', font: 'bold', spacing: 2 });
            cv.text(String(sp.rpm), rx, 164, 48, sp.cold ? t.cold : t.text, { align: 'right', font: 'num' });
            cv.text('LAST SHIFT', rx, 300, 16, t.dim, { align: 'right', font: 'bold', spacing: 2 });
            if (lastShift) {
                const age = now - lastShift.at, vc = VCOL[lastShift.verdict];
                cv.text(String(lastShift.rpm), rx, 350, 44, t.text, { align: 'right', font: 'num' });
                if (lastShift.from !== '?') cv.text(lastShift.from + ' > ' + lastShift.to, rx, 380, 20, t.dim, { align: 'right', font: 'bold' });
                cv.roundRect(rx - 150, 394, 150, 34, 8, withAlpha(vc, age < 2500 ? 0.45 : 0.18));
                cv.text(lastShift.verdict, rx - 75, 418, 18, age < 2500 ? t.text : vc, { align: 'center', font: 'bold', spacing: 1.5 });
            } else cv.text('--', rx, 350, 44, t.dim, { align: 'right', font: 'num' });
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
