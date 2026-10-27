'use strict';
/**
 * Redline - full-screen rev display in the style of the G20 Live Cockpit (Sport):
 * a wide rev bar across the middle that fills left to right in slanted 500 rpm
 * segments (theme colour to red at the shift point), digital rpm above it, a big
 * gear below it, digital speed, angular frame lines. At the shift point the lights,
 * gear and a SHIFT prompt turn red (setting "flash": they blink and the screen flashes).
 *
 *   - shift-light bar that fills over the last 2000 rpm, all red at the shift point
 *   - huge gear number (from the gearbox, or learned from rpm/speed ratios)
 *   - every upshift is scored against your shift point (EARLY / SPOT ON / LATE / LIMITER)
 *   - cold-engine rev guard: until the oil is warm the shift point is pulled down
 *     and climbs with the oil temperature
 *
 * Pages: tach / shift log. The tach's peak marker drops back after "Peak hold" seconds;
 * BTN_RESET clears it and the session stats.
 */
const mgu = require('./kit/mgu');
const { withAlpha, ramp } = require('./kit/canvas');
const G = require('./kit/gauges');
const Car = require('./kit/car');

const W = 1600, H = 520;
// rev bar (G20 style): left to right, slanted segments; top edge shifted right by 'slant'
const BAR = { x0: 400, x1: 1200, y0: 213, y1: 275, slant: 22 };
const GX = 800;                                     // centre column (rpm, bar, gear)
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
        // peakRpm = the tach's peak marker: drops back to the current rpm "peakHold" s after the last
        // new peak (0 = until Reset); the shift log's session peaks stay until Reset
        let peakRpm = 0, peakRpmT = 0, sessionRpm = 0, peakSpeed = 0, limiterHits = 0;
        let shifts = [];                    // { at, from, to, rpm, target, verdict }
        const recent = [];                  // [t, rpm, speed] last ~1 s
        let lastGear = null, onLimiter = false, lastShift = null;
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
            recent.push([t, d.rpm, d.speed]);
            while (recent.length && t - recent[0][0] > 1200) recent.shift();
            const now = Date.now(), hold = settings.get('peakHold') * 1000;
            if (d.rpm >= peakRpm || (hold > 0 && now - peakRpmT > hold)) { peakRpm = d.rpm; peakRpmT = now; }
            sessionRpm = Math.max(sessionRpm, d.rpm);
            if (G.isNum(d.speed)) peakSpeed = Math.max(peakSpeed, d.speed);
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
        }, () => { recent.length = 0; lastGear = null; });

        /* ---------- rev bar geometry + static background (cached) ---------- */
        const BW = BAR.x1 - BAR.x0 - BAR.slant, BH = BAR.y1 - BAR.y0;
        const barX = (rpm) => G.clamp(rpm / maxRpm(), 0, 1) * BW;                          // along the bar
        const off = (y) => BAR.slant * (BAR.y1 - y) / BH;                                   // slant at height y
        /** Fill the slanted band between rpm a and b (one anti-aliased quad). */
        function band(cv, a, b, col, pad) {
            pad = pad || 0;
            const xa = BAR.x0 + barX(a), xb = BAR.x0 + barX(b), y0 = BAR.y0 - pad, y1 = BAR.y1 + pad;
            if (xb - xa <= 0) return;
            cv.quad([[xa + off(BAR.y0) - pad, y0], [xb + off(BAR.y0) + pad, y0], [xb + off(BAR.y1) + pad, y1], [xa + off(BAR.y1) - pad, y1]], col);
        }
        /** Slanted 3 px gap at rpm r (segment separator). */
        function gapAt(cv, r, col) {
            const x = BAR.x0 + barX(r);
            cv.quad([[x + off(BAR.y0) - 1.5, BAR.y0], [x + off(BAR.y0) + 1.5, BAR.y0], [x + off(BAR.y1) + 1.5, BAR.y1], [x + off(BAR.y1) - 1.5, BAR.y1]], col);
        }
        /** Static part of the tach page (cached layer; redrawn when the theme / limits change). */
        function background(cv, t, sp) {
            const key = ['redline-bg', settings.get('theme'), maxRpm(), redline(), sp.rpm].join('|');
            cv.blit(G.layer(key, W, H, (c) => drawBackground(c, t, sp), cv.textScale), 0, 0);
        }
        function drawBackground(cv, t, sp) {
            cv.clear(t.bg);
            // angular frame lines (the G20's outline) around the centre
            const fl = withAlpha(t.tick, 0.55);
            cv.polyline([[24, 92], [330, 92], [370, 122], [1230, 122], [1270, 92], [1576, 92]], 2, fl);
            cv.polyline([[370, 122], [1230, 122]], 3, withAlpha(t.accent, 0.5));
            cv.polyline([[24, 512], [330, 512], [370, 486], [1230, 486], [1270, 512], [1576, 512]], 2, fl);
            // track, redline part tinted, segment gaps
            band(cv, 0, redline(), t.track);
            band(cv, redline(), maxRpm(), withAlpha(t.crit, 0.3));
            for (let r = 500; r < maxRpm(); r += 500) gapAt(cv, r, t.bg);
            // scale under the bar: ticks every 500, numbers every 1000; shift point + redline marks
            for (let rpm = 0; rpm <= maxRpm(); rpm += 500) {
                const x = BAR.x0 + barX(rpm), major = rpm % 1000 === 0, red = rpm >= redline();
                cv.fillRect(x - (major ? 1.5 : 1), BAR.y1 + 8, major ? 3 : 2, major ? 14 : 8, red ? t.crit : major ? t.text : t.tick);
                if (major) cv.text(String(rpm / 1000), x, BAR.y1 + 46, 26, red ? t.crit : t.text, { align: 'center', font: 'bold' });
            }
            [[sp.rpm, t.warn], [redline(), t.crit]].forEach(([r, c]) => {
                const x = BAR.x0 + barX(r);
                cv.fillRect(x + BAR.slant - 2, BAR.y0 - 14, 4, 12, c);
            });
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

        function shiftLights(cv, t, rpm, sp, on) {
            const cols = ledColors(t);
            const x0 = GX - 330, w = 660, gap = 10, lw = (w - gap * (N_LEDS - 1)) / N_LEDS, y = 48, h = 30;
            const start = sp - LED_RANGE;
            const lit = G.isNum(rpm) ? Math.floor(G.clamp((rpm - start) / LED_RANGE, 0, 1) * N_LEDS) : 0;
            const strobe = G.isNum(rpm) && rpm >= sp;
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

        // shift blink (setting "flash"): in software it alternates every frame, so it always
        // shows (a clock-based phase could land on 'off' frame after frame)
        let blink = false;

        function drawTach(cv, t, d, now) {
            const sp = shiftPoint(d.oil);
            background(cv, t, sp);
            const rpm = d.rpm;
            const shiftNow = G.isNum(rpm) && rpm >= sp.rpm;
            // setting "flash" on: lights, gear and SHIFT blink (GPU renderer: 8 Hz clock phase;
            // software, few fps: alternate every frame) and the screen flashes red. Off: they
            // just turn solid red at the shift point, nothing blinks.
            const flash = settings.get('flash');
            blink = shiftNow && flash ? (ctx.display.active() ? Math.floor(now / 62) % 2 === 0 : !blink) : false;
            const redNow = shiftNow && (!flash || blink);
            shiftLights(cv, t, rpm, sp.rpm, redNow);
            if (shiftNow && flash && blink) {
                cv.gradientRect(0, 0, W, H, [[0, withAlpha(t.crit, 0.55)], [0.5, withAlpha(t.crit, 0.22)], [1, withAlpha(t.crit, 0.5)]]);
                const fr = withAlpha('#ff2a2a', 0.9);                                            // red frame
                cv.fillRect(0, 0, W, 8, fr); cv.fillRect(0, H - 8, W, 8, fr); cv.fillRect(0, 8, 8, H - 16, fr); cv.fillRect(W - 8, 8, 8, H - 16, fr);
            }

            // ---- rev bar: left to right; theme colour -> red at the shift point, solid red above.
            // Each 500 rpm segment takes the colour of its position (stepped like the G20).
            const hot = t.hotRamp || t.ramp;
            if (G.isNum(rpm) && rpm > 50) {
                const colOf = (r) => (shiftNow ? '#ff2a2a' : ramp(hot, G.clamp(r / sp.rpm, 0, 1)));
                band(cv, 0, rpm, withAlpha(colOf(rpm), 0.14), 7);                               // glow
                const top = Math.min(rpm, maxRpm());                                           // a garbage rpm stays one bar
                for (let r = 0; r < top; r += 500) band(cv, r, Math.min(top, r + 500), colOf(r + 250));
                for (let r = 500; r < top; r += 500) gapAt(cv, r, t.bg);
                const x = BAR.x0 + barX(rpm);
                cv.line(x, BAR.y1 + 4, x + BAR.slant, BAR.y0 - 4, 6, '#ffffff');               // bright leading edge
            }
            // peak: a slanted line across the bar at the highest rpm (no line along the top on the tach)
            if (peakRpm > 0 && !(G.isNum(rpm) && rpm >= peakRpm)) {
                const pk = Math.min(peakRpm, maxRpm()), px = BAR.x0 + barX(pk);
                const pc = t.hang || (pk >= sp.rpm ? '#ff2a2a' : ramp(hot, G.clamp(pk / sp.rpm, 0, 1)));
                cv.line(px + BAR.slant, BAR.y0, px, BAR.y1, 3, pc);
            }

            // ---- centre: digital rpm above the bar, gear below it
            const rw = cv.text(G.isNum(rpm) ? String(Math.round(rpm / 10) * 10) : '----', GX - 30, 198, 80, G.isNum(rpm) ? (shiftNow ? '#ff4a4a' : t.text) : t.dim, { align: 'center', font: 'num' });
            cv.text('RPM', GX - 30 + rw / 2 + 12, 198, 22, t.dim, { font: 'bold', spacing: 2 });
            // gear number when driving; the selector position (P / R / N, D while no gear is engaged)
            // otherwise - the gear field alone reads "N" in park too
            const g = d.gear, st = d.stage;
            const gs = st === 'P' || st === 'R' || st === 'N' ? st : g === -1 ? 'R' : G.isNum(g) && g > 0 ? String(g) : st === 'D' ? 'D' : g === 0 ? 'N' : '-';
            cv.text(gs, GX, 500, 200, redNow ? '#ff2a2a' : t.text, { align: 'center', font: 'gear' });
            if (d.gearGuessed && G.isNum(g) && g > 0) cv.text('EST.', GX + 90, 352, 22, t.dim, { font: 'bold', spacing: 1 });
            if (shiftNow) cv.text('SHIFT', GX + 150, 436, 30, redNow ? '#ff2a2a' : withAlpha('#ff2a2a', 0.5), { font: 'bold', spacing: 3 });

            // ---- left: digital speed, temperatures, cold oil, stats
            const spd = G.hold('speed', d.speed, 1000 / settings.get('speedRate'));     // setting: 10/s by default, 5 like the cluster .. 60
            const v = G.isNum(spd) ? (mph() ? spd / MPH : spd) : null;
            cv.text('SPEED', 40, 156, 22, t.dim, { font: 'bold', spacing: 1.5 });
            const vw = cv.text(G.fmt(v, 0), 36, 276, 116, G.isNum(v) ? t.text : t.dim, { font: 'num' });
            cv.text(mph() ? 'mph' : 'km/h', 46 + vw, 276, 26, t.dim);
            cv.fillRect(40, 298, 300, 1, withAlpha(t.tick, 0.6));
            const warm = settings.get('warmOil'), coldOil = G.isNum(d.oil) && d.oil < warm;
            const oilCol = !G.isNum(d.oil) ? t.dim : d.oil < 60 ? t.cold : coldOil ? YELLOW : d.oil > 130 ? t.crit : t.text;
            cv.text('OIL', 40, 334, 22, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text(G.fmt(d.oil, 0) + (G.isNum(d.oil) ? '°' : ''), 40, 376, 40, oilCol, { font: 'bold' });
            cv.text('WATER', 190, 334, 22, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text(G.fmt(d.coolant, 0) + (G.isNum(d.coolant) ? '°' : ''), 190, 376, 40, t.text, { font: 'bold' });
            // cold oil is always shown: with the guard on it also lowers the shift point
            if (coldOil) {
                cv.roundRect(40, 392, 300, 36, 8, withAlpha(t.cold, 0.2));
                cv.text(sp.cold ? 'COLD  ·  LIMIT ' + sp.rpm : 'OIL COLD  ·  GO EASY', 190, 418, 22, t.cold, { align: 'center', font: 'bold', spacing: 0.5 });
            }
            cv.text('PEAK ' + (peakRpm ? Math.round(peakRpm) : '--') + '  ·  LIMITER ' + limiterHits + 'x', 40, 476, 22, t.dim, { font: 'bold', spacing: 0.5 });

            // ---- right: shift point + last shift
            const rx = W - 40;
            cv.text('SHIFT AT', rx, 156, 22, t.dim, { align: 'right', font: 'bold', spacing: 1.5 });
            cv.text(String(sp.rpm), rx, 222, 64, sp.cold ? t.cold : t.text, { align: 'right', font: 'num' });
            cv.fillRect(W - 340, 298, 300, 1, withAlpha(t.tick, 0.6));
            cv.text('LAST SHIFT', rx, 334, 22, t.dim, { align: 'right', font: 'bold', spacing: 1.5 });
            if (lastShift) {
                const age = now - lastShift.at, vc = VCOL[lastShift.verdict];
                const lw2 = cv.text(String(lastShift.rpm), rx, 386, 52, t.text, { align: 'right', font: 'num' });
                if (lastShift.from !== '?') cv.text(lastShift.from + ' > ' + lastShift.to, rx - lw2 - 14, 386, 22, t.dim, { align: 'right', font: 'bold' });
                cv.roundRect(rx - 200, 404, 200, 38, 8, withAlpha(vc, age < 2500 ? 0.45 : 0.18));
                cv.text(lastShift.verdict, rx - 100, 431, 22, age < 2500 ? t.text : vc, { align: 'center', font: 'bold', spacing: 1 });
            } else cv.text('--', rx, 386, 52, t.dim, { align: 'right', font: 'num' });
        }

        function drawLog(cv, t) {
            G.panel(cv, t, 24, 44, 760, 468, 'Recent upshifts');
            const up = shifts.slice(0, 9);
            if (!up.length) cv.text('No shifts yet - go and use the rev range.', 48, 189, 26, t.dim);
            up.forEach((s, i) => {
                const y = 135 + i * 41;
                const d = new Date(s.at), p = (n) => String(n).padStart(2, '0');
                cv.text(p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()), 48, y, 22, t.dim);
                cv.text(s.from === '?' ? 'upshift' : s.from + ' > ' + s.to, 200, y, 26, t.text, { font: 'bold' });
                cv.text(String(s.rpm), 470, y, 28, t.text, { align: 'right', font: 'num' });
                cv.text('/ ' + s.target, 480, y, 22, t.dim);
                cv.roundRect(590, y - 26, 170, 34, 7, withAlpha(VCOL[s.verdict], 0.25));
                cv.text(s.verdict, 675, y - 1, 22, VCOL[s.verdict], { align: 'center', font: 'bold', spacing: 0.5 });
            });

            G.panel(cv, t, 808, 44, 768, 468, 'Shift accuracy');
            const n = shifts.length;
            const cnt = (v) => shifts.filter((s) => s.verdict === v).length;
            const spot = cnt('SPOT ON');
            cv.text(n ? Math.round(spot / n * 100) + '%' : '--', 832, 199, 96, n ? GREEN : t.dim, { font: 'num' });
            cv.text('SPOT ON  (' + n + ' shifts)', 836, 235, 22, t.dim, { font: 'bold', spacing: 1 });
            ['EARLY', 'SPOT ON', 'LATE', 'COLD REV', 'LIMITER'].forEach((v, i) => {
                const y = 276 + i * 46, c = cnt(v), f = n ? c / n : 0;
                cv.text(v, 836, y + 22, 22, VCOL[v], { font: 'bold', spacing: 1 });
                cv.roundRect(990, y + 2, 460, 26, 6, t.track);
                if (f > 0) cv.roundRect(990, y + 2, Math.max(12, 460 * f), 26, 6, VCOL[v]);
                cv.text(String(c), 1540, y + 24, 26, t.text, { align: 'right', font: 'num' });
            });
            // scatter: shift rpm vs target
            if (n) {
                const ys = shifts.slice(0, 30).map((s) => s.rpm - s.target);
                const avg = ys.reduce((a, b) => a + b, 0) / ys.length;
                cv.text('AVG ' + (avg >= 0 ? '+' : '') + Math.round(avg) + ' rpm vs shift point', 1240, 199, 24, t.text, { align: 'center', font: 'bold' });
                cv.text('PEAK ' + Math.round(sessionRpm) + ' RPM  ·  ' + G.fmt(mph() ? peakSpeed / MPH : peakSpeed, 0) + (mph() ? ' MPH' : ' KM/H'), 1240, 235, 22, t.dim, { align: 'center', font: 'bold', spacing: 0.5 });
            }
        }

        /** G20-style frame: tab bar with the page names along the top. */
        function header(cv, t, d) {
            G.frame(cv, t, ['Tach', 'Shift log'], page, [d.demo && { text: 'DEMO' }]);
        }

        async function render() {
            const t = ctx.theme(), d = car.data(), now = Date.now();
            let cv;
            cv = ctx.canvas(W, H).clear(t.bg);
            if (page === 0) drawTach(cv, t, d, now); else drawLog(cv, t);
            header(cv, t, d);
            await ui.image('MAIN_GFX', cv);
        }

        /* ---------- buttons ---------- */
        const flip = () => { page = 1 - page; return render(); };
        ui.onClick('BTN_PAGE', flip);
        ui.onClick('BTN_PREV', flip);
        ctx.onTab((i) => i !== page && flip());
        ui.onClick('BTN_RESET', () => {
            peakRpm = 0; peakRpmT = 0; sessionRpm = 0; peakSpeed = 0; limiterHits = 0; shifts = []; lastShift = null;
            log.info('peaks reset'); return render();
        });
        // every screen refresh (60 fps) with the GPU renderer; 15 fps in software (PNG frames)
        ctx.loop('MAIN', 15, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
