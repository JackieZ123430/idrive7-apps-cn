'use strict';
/**
 * Warm-Up - know when the engine is ready to be used, and when it has cooled.
 *
 *   - oil + coolant gauges (oil is what matters: it lags coolant by minutes)
 *   - warm-up calculator: minutes until oil / coolant are warm,
 *     from the measured warm-up rate (typical rates until enough is measured),
 *     projected on the trend graph; "engine off" when a hybrid drives electric
 *   - safe rev limit that climbs from the cold limit to the redline with oil temp
 *   - 20-minute temperature trend
 *   - turbo cool-down: hard driving (high rpm or high power) builds up a cool-down
 *     time (30 s - 3 min) that counts down while driving gently or idling
 *   - gearbox oil (gearbox.js, issue #164): a third gauge, its own "ready in" and trend line, and READY
 *     waits for it too, on a car that has it (the gearbox unit, else the car's signal)
 *   - Cold starts tab: the engine's starts, how many with cold oil and how many cold runs went past the safe rev
 *     limit (coldstarts.js, counted in the background: app.json autostart)
 */
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const Engine = require('./kit/engine');
const { ColdStarts, COLD_C } = require('./coldstarts');
const { Gearbox } = require('./gearbox');

const W = 1600, H = 520;
const GO = '#2fd27a';
const HARD_RPM = 3800, HARD_KW = 90;       // above either = hard use (heats the turbo)
const GENTLE_RPM = 2800, GENTLE_KW = 40;   // below both = cooling down
const COOL_MIN = 30, COOL_MAX = 180;       // s of cool-down, growing with the hard-use time
// typical warm-up rates (deg C / min) until enough has been measured
const TYPICAL = { oil: { drive: 4, idle: 1.5 }, coolant: { drive: 7, idle: 3 }, gearbox: { drive: 3, idle: 0.8 } };
const HIST = { oil: 1, coolant: 2, gearbox: 5 };   // a value's place in a hist entry
const GEAR_HOT = 125;                      // deg C: ease off
const GEAR_C = '#b98cff';                  // the gearbox's colour in the trend
const TABS = ['Warm-up', 'Cold starts'];
const RPM = { factor: 0.25, invalid: 65535 }, TEMP = { offset: -48, invalid: 255 };

/** The safe rev limit for the oil's temperature: the cold limit up to the redline, climbing from 30 deg C to warm. */
function limitFor(engine, settings, oil) {
    const warm = settings.get('warmOil'), red = engine.redline(), cold = Math.min(engine.value('coldLimit', { diesel: 3000, petrol: 3500 }), red);
    if (!G.isNum(oil)) return null;
    if (oil >= warm) return red;
    return Math.round((cold + (red - cold) * G.clamp((oil - 30) / (warm - 30), 0, 1)) / 100) * 100;
}

/* With or without the screen (autostart): the cold starts counted. */
async function background(bg) {
    const { settings, signals, log } = bg;
    const engine = new Engine({ settings, dataDir: bg.dataDir, log });
    const cs = new ColdStarts({ settings, limit: (oil) => limitFor(engine, settings, oil), warm: () => settings.get('warmOil') });
    const w = (iface, h) => (signals && signals.watch ? Promise.resolve(signals.watch(iface, '1', h, log)).catch((e) => log.warn('cold starts: ' + (e && e.message || e))) : null);
    w('de.bmw.infotainment.vehicle.CDS', {
        statusEngineSpeed2: (v) => { const r = v && v.actualValueRPMEngineCrankshaft; if (G.isNum(r) && r !== RPM.invalid) cs.rpm(r * RPM.factor); },
        statusEngineTemperature: (v) => { const o = v && v.temperatureEngineOilDrive; if (G.isNum(o) && o !== TEMP.invalid) cs.oil(o + TEMP.offset); },
    });
    w(Engine.SIGNAL[0], engine.handlers());
    return { cs };
}

mgu.run({
    background,
    async start(ctx) {
        const { ui, settings } = ctx;
        const cs = (ctx.background || await background(ctx)).cs;
        let page = 0;
        // engine profile (diesel / petrol): the Auto redline and cold limit
        const engine = new Engine({ settings, dataDir: ctx.dataDir, log: ctx.log });
        const car = new Car(ctx, ['rpm', 'speed', 'temps', 'torque'], { [Engine.SIGNAL[0]]: engine.handlers() });
        car.setRedline(engine.redline());
        engine.onChange(() => car.setRedline(engine.redline()));
        const gearbox = new Gearbox(ctx, ctx.log, () => ctx.ui.isVisible('MAIN')).start();
        // the gearbox oil: the unit's / the signal's, or in the demo one that follows the oil a little behind
        const gearT = (d) => (d.demo ? (G.isNum(d.oil) ? d.oil - 12 : null) : gearbox.temp());

        /* ---------- tracking ---------- */
        const hist = [];             // [t, oil, coolant, rpm, speed, gearbox] every 5 s, 20 min; t = steady clock (mono)
        // the head unit sets its clock after start-up: wall-clock times can jump by hours, which
        // threw the trend lines across the screen. A steady clock only ever moves forward.
        const mono = () => { const h = process.hrtime(); return h[0] * 1000 + h[1] / 1e6; };
        let lastHist = 0, lastT = 0;
        // cool-down: hardS = seconds of hard use; needS = cool-down it asks for; cool = gentle seconds done
        let hardS = 0, needS = 0, cool = 0, doneAt = 0;
        car.onSample((d, t) => {
            // sample times (the demo replays late steps with theirs) are wall-clock: a step back counts as no time,
            // and "cooled" times its 20 s on the steady clock
            const dt = lastT ? G.clamp(t - lastT, 0, 250) / 1000 : 0, m = mono(); lastT = t;
            if (G.isNum(d.rpm)) {
                const kw = G.isNum(d.torque) ? d.torque * d.rpm / 9549 : 0;
                const hard = d.rpm > HARD_RPM || kw > HARD_KW;
                const gentle = d.rpm < GENTLE_RPM && kw < GENTLE_KW;
                if (hard) {
                    hardS += dt; cool = 0; doneAt = 0;
                    if (hardS > 8) needS = G.clamp(COOL_MIN + hardS * 3, COOL_MIN, COOL_MAX);
                } else if (needS > 0 && gentle) {
                    cool += dt;
                    if (cool >= needS && !doneAt) doneAt = m;
                } else if (!needS) {
                    hardS = Math.max(0, hardS - dt * 0.2);      // short bursts fade away
                }
                // "cooled" message stays for 20 s, then all clear
                if (doneAt && m - doneAt > 20000) { hardS = 0; needS = 0; cool = 0; doneAt = 0; }
            }
            if (m - lastHist > 5000 && (G.isNum(d.oil) || G.isNum(d.coolant))) {
                lastHist = m; hist.push([m, d.oil, d.coolant, d.rpm, d.speed, gearT(d)]);
                while (hist.length > 240) hist.shift();
            }
        }, () => { hist.length = 0; hardS = 0; needS = 0; cool = 0; doneAt = 0; });

        const F = () => settings.get('tempUnit') === 'f';
        const T = (c) => (G.isNum(c) ? (F() ? c * 9 / 5 + 32 : c) : null);
        const tU = () => (F() ? '°F' : '°C');

        const limit = (oil) => limitFor(engine, settings, oil);

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
            const m = measured(HIST[key]);
            const typ = TYPICAL[key][G.isNum(d.speed) && d.speed > 10 ? 'drive' : 'idle'];
            const w = G.clamp(m.span / 120000, 0, 1);
            const rate = G.isNum(m.rate) ? w * m.rate + (1 - w) * typ : typ;
            if (w > 0.8 && rate < 0.15) return { state: 'stalled', rate };
            const min = (target - temp) / Math.max(0.15, rate);
            return { state: 'warming', min, rate, est: w < 0.5 };
        }

        /* ---------- drawing ---------- */
        /**
         * Temperature as a tach bar (Redline style), 0-150 deg C in 10 deg segments in the tach colours
         * (blue -> purple -> red at 120 deg C, solid red above); cold / warn / crit zones tint the
         * track, green mark where it counts as warm.
         */
        function gauge(cv, t, y, h, val, label, warm) {
            const st = F() ? 18 : 10;
            G.segBar(cv, t, 24, y, 880, h, {
                label, value: T(val), unit: tU(), decimals: 0, min: T(0), max: T(150), step: st, scale: { every: st * 2.5 },
                zones: [{ from: T(120), to: T(135), color: 'warn' }, { from: T(135), to: T(160), color: 'crit' }],
                ramp: 'hot', limit: T(120), marks: [{ value: T(warm), color: GO }],
            });
        }

        /** The same in a lower panel (three of them with the gearbox): a thinner bar, smaller scale and number. */
        function gaugeSmall(cv, t, y, h, val, label, warm) {
            const p = G.panel(cv, t, 24, y, 880, h, label), st = F() ? 18 : 10, v = T(val);
            const uw = cv.textWidth(' ' + tU(), 22);
            cv.text(G.isNum(v) ? String(Math.round(v)) : '--', 880 - uw, y + 48, 48, G.isNum(v) ? t.text : t.dim, { align: 'right', font: 'num' });
            cv.text(' ' + tU(), 880, y + 48, 22, t.dim, { align: 'right' });
            G.segBar(cv, t, 48, y + 66, 832, p.h - 66 - 44, {
                panel: false, value: v, min: T(0), max: T(150), step: st, scale: { every: st * 2.5, size: 20, labelY: 40, tick: 8 },
                zones: [{ from: T(120), to: T(135), color: 'warn' }, { from: T(135), to: T(160), color: 'crit' }],
                ramp: 'hot', limit: T(120), marks: [{ value: T(warm), color: GO }],
            });
        }

        /** One "ready in" row: label + target, big minutes (or the state), a reason on the right. */
        function etaRow(cv, t, y, label, e, target) {
            cv.text(label, 952, y, 22, t.dim, { font: 'bold', spacing: 1.5 });
            let big, col = t.text, right = '', unit = '';
            if (e.state === 'ready') { big = 'READY'; col = GO; }
            else if (e.state === 'off') { big = 'ENGINE OFF'; col = t.dim; right = 'electric driving'; }
            else if (e.state === 'stalled') { big = 'NOT WARMING'; col = t.warn; right = 'drive to warm up'; }
            else if (e.state === 'warming') { big = e.min > 60 ? '>60' : '~' + Math.max(1, Math.round(e.min)); unit = 'min'; }
            else { big = '--'; col = t.dim; }
            // the large number font has digits and a few letters only: words in bold, minutes in num + 'min'
            const bw = cv.text(big, 952, y + 50, unit ? 52 : 40, col, { font: unit || big === '--' ? 'num' : 'bold', spacing: unit ? 0 : 1 });
            if (unit) cv.text(unit, 960 + bw, y + 50, 26, t.dim);
            if (right) cv.text(right, 1552, y + 48, 24, t.dim, { align: 'right' });
            cv.text('target ' + Math.round(T(target)) + tU(), 1552, y, 22, t.dim, { align: 'right' });
        }

        /* The Cold starts tab: the three counts, the latest starts, Reset. */
        function renderCold(cv, t) {
            const st = cs.stats(), pct = (n) => (st.starts ? Math.round(n * 100 / st.starts) + ' %' : '');
            const since = new Date(st.since), two = (n) => (n < 10 ? '0' : '') + n;
            [['ENGINE STARTS', st.starts, '', t.text], ['WITH COLD OIL', st.cold, 'under ' + Math.round(T(COLD_C)) + tU() + '  ' + pct(st.cold), t.cold],
                ['COLD AND REVVED', st.revved, 'past the safe rev limit  ' + pct(st.revved), t.warn]].forEach(([label, n, note, col], i) => {
                const x = 24 + i * 523;
                G.panel(cv, t, x, 44, 506, 180, null);
                cv.text(label, x + 24, 86, 22, t.dim, { font: 'bold', spacing: 1.5 });
                cv.text(String(n), x + 24, 172, 72, n ? col : t.dim, { font: 'num' });
                cv.text(note, x + 24, 206, 20, t.dim);
            });
            const lp = G.panel(cv, t, 24, 240, 1552, 272, 'Latest starts');
            const rows = st.last || [];
            if (!rows.length) cv.text('Counted from the next engine start', 48, 330, 24, t.dim);
            rows.slice(0, 4).forEach((r, i) => {
                const at = new Date(r.at), y = 316 + i * 44;
                cv.text(at.getDate() + '.' + two(at.getMonth() + 1) + '.  ' + at.getHours() + ':' + two(at.getMinutes()), 48, y, 24, t.text);
                cv.text('oil ' + Math.round(T(r.oil)) + tU(), 360, y, 24, r.cold ? t.cold : t.text, { font: 'bold' });
                cv.text(r.revved ? 'revved cold' : r.cold ? 'cold start' : '', 560, y, 24, r.revved ? t.warn : t.dim);
            });
            cv.text('since ' + since.getDate() + '.' + two(since.getMonth() + 1) + '.' + since.getFullYear(), 1552, 300, 22, t.dim, { align: 'right' });
            G.button(cv, t, 1336, 240 + lp.h - 70, 216, 50, 'Reset', () => { cs.reset(); return render(); }, { key: 'reset', confirm: true });
        }

        /** The same, on one line (three of them with the gearbox): label and target left, minutes / state right. */
        function etaLine(cv, t, y, label, e, target) {
            cv.text(label, 952, y, 22, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text('target ' + Math.round(T(target)) + tU(), 952, y + 26, 20, t.dim);
            let big, col = t.text, unit = '';
            if (e.state === 'ready') { big = 'READY'; col = GO; }
            else if (e.state === 'off') { big = 'ENGINE OFF'; col = t.dim; }
            else if (e.state === 'stalled') { big = 'NOT WARMING'; col = t.warn; }
            else if (e.state === 'warming') { big = e.min > 60 ? '>60' : '~' + Math.max(1, Math.round(e.min)); unit = 'min'; }
            else { big = '--'; col = t.dim; }
            const ux = unit ? 1552 - cv.textWidth(unit, 24) : 1552;
            cv.text(big, unit ? ux - 8 : 1552, y + 22, unit ? 44 : 32, col, { align: 'right', font: unit || big === '--' ? 'num' : 'bold', spacing: unit ? 0 : 1 });
            if (unit) cv.text(unit, 1552, y + 22, 24, t.dim, { align: 'right' });
        }

        function render() {
            const t = ctx.theme(), d = car.data(), now = Date.now();
            const cv = ctx.canvas(W, H).clear(t.bg);
            if (cs && page === 1) {
                renderCold(cv, t);
                G.frame(cv, t, TABS, 1, [d.demo && { text: 'DEMO' }]);
                return ui.image('MAIN_GFX', cv);
            }
            const warm = settings.get('warmOil'), warmC = settings.get('warmCoolant');
            // the room below the page (on the car, with no bar under it): half to each gauge; the coolant
            // panel ends at the page's bottom, and G.panel adds the room back to it
            const room = G.pageBottom(cv) - G.BOTTOM, half = Math.round(room / 2);
            const gb = gearT(d), warmG = settings.get('warmGearbox'), hasGb = G.isNum(gb);
            if (hasGb) {
                // three gauges in the room of two: the oil (what matters most) gets the extra room below the page
                gaugeSmall(cv, t, G.TOP, 144 + half, d.oil, 'Oil', warm);
                gaugeSmall(cv, t, G.TOP + 161 + half, 144, d.coolant, 'Coolant', warmC);
                gaugeSmall(cv, t, G.TOP + 322 + half, 145 - half, gb, 'Gearbox oil', warmG);
            } else {
                gauge(cv, t, G.TOP, 225 + half, d.oil, 'Oil', warm);
                gauge(cv, t, G.TOP + 242 + half, 225 - half, d.coolant, 'Coolant', warmC);
            }

            // ---- status panel
            const sp = G.panel(cv, t, 928, 44, 648, 468, null);
            const lim = limit(d.oil);
            // ready: the oil warm, and the gearbox oil too where the car tells it
            const gbCold = hasGb && gb < warmG, gbHot = hasGb && gb > GEAR_HOT;
            const ready = G.isNum(d.oil) && d.oil >= warm && !gbCold;
            const hot = G.isNum(d.oil) && d.oil > 125;
            const cooling = settings.get('cooldown') && needS > 0;
            let st, col;
            if (!G.isNum(d.oil)) { st = 'NO OIL TEMP'; col = t.dim; }
            else if (hot) { st = 'OIL HOT - EASE OFF'; col = t.crit; }
            else if (gbHot) { st = 'GEARBOX HOT - EASE OFF'; col = t.crit; }
            else if (cooling) { st = doneAt ? 'COOLED - OK TO SWITCH OFF' : 'TURBO COOL-DOWN'; col = doneAt ? GO : t.warn; }
            else if (ready) { st = 'READY'; col = GO; }
            else if (d.oil >= warm && gbCold) { st = 'GEARBOX WARMING UP'; col = t.warn; }
            else if (d.oil >= warm - 20) { st = 'WARMING UP'; col = t.warn; }
            else { st = 'COLD'; col = t.cold; }
            cv.roundRect(952, 70, 600, 60, 10, withAlpha(col, 0.22));
            if (st === 'READY') cv.roundRect(952, 70, 600, 60, 10, withAlpha(col, 0.15 + 0.1 * Math.sin(now / 400)));
            cv.text(st, 1252, 114, st.length > 14 ? 30 : 38, col, { align: 'center', font: 'bold', spacing: 3 });

            if (cooling) {
                // big countdown: gentle driving / idling cools the turbo and oil
                const left = Math.max(0, needS - cool);
                const gentleNow = G.isNum(d.rpm) && d.rpm < GENTLE_RPM;
                // the oil warm-up stays visible as one line
                const eo = eta('oil', d.oil, warm, d);
                const line = eo.state === 'ready' ? 'Oil warm' : eo.state === 'warming' ? 'Oil ready in ~' + Math.max(1, Math.round(eo.min)) + ' min'
                    : eo.state === 'off' ? 'Engine off - oil not warming' : eo.state === 'stalled' ? 'Oil not warming' : '';
                cv.text(line, 952, 170, 24, eo.state === 'ready' ? GO : t.dim, { font: 'bold' });
                cv.text('COOL-DOWN LEFT', 952, 210, 22, t.dim, { font: 'bold', spacing: 1.5 });
                const lw = cv.text(left > 0 ? String(Math.ceil(left)) : '0', 952, 289, 80, left > 0 ? t.text : GO, { font: 'num' });
                cv.text('s', 962 + lw, 289, 30, t.dim);
                cv.text(left > 0 ? (gentleNow ? 'keep it gentle' : 'paused - stay under ' + GENTLE_RPM + ' rpm') : 'done', 1552, 262, 24, left > 0 && !gentleNow ? t.warn : t.text, { align: 'right', font: 'bold' });
                const f = needS ? G.clamp(cool / needS, 0, 1) : 1;
                cv.roundRect(952, 303, 600, 12, 6, t.track);
                if (f > 0) cv.rampRect(952, 303, Math.max(12, 600 * f), 12, 6, [t.warn, GO], 952, 600);
            } else if (hasGb) {
                etaLine(cv, t, 166, 'OIL READY IN', eta('oil', d.oil, warm, d), warm);
                etaLine(cv, t, 226, 'COOLANT READY IN', eta('coolant', d.coolant, warmC, d), warmC);
                etaLine(cv, t, 286, 'GEARBOX READY IN', eta('gearbox', gb, warmG, d), warmG);
            } else {
                etaRow(cv, t, 170, 'OIL READY IN', eta('oil', d.oil, warm, d), warm);
                etaRow(cv, t, 255, 'COOLANT READY IN', eta('coolant', d.coolant, warmC, d), warmC);
            }

            // ---- safe rev limit (always) + trend
            const red = engine.redline(), fl = lim ? lim / red : 0;
            cv.text('SAFE REV LIMIT', 952, 350, 22, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text(lim ? lim + ' rpm' : '---- rpm', 1552, 352, 26, ready ? GO : t.text, { align: 'right', font: 'bold' });
            cv.roundRect(1160, 340, 230, 8, 4, t.track);
            if (fl > 0) cv.roundRect(1160, 340, 230 * fl, 8, 4, ready ? GO : col);

            // trend: last minutes (steady clock, see mono) + up to 5 min projected; nothing is drawn outside the graph
            // (it grows with the status panel where that goes on down to the screen's bottom)
            const gx = 952, gy = 398, gw = 600, gh = 90 + sp.h - 468, nowX = gx + gw - 90;
            const now0 = hist.length ? hist[hist.length - 1][0] : mono();
            const span = G.clamp(hist.length ? now0 - hist[0][0] : 0, 300000, 1200000);
            const ahead = 300000;                                  // projection: up to 5 min ahead
            const lo = 0, hi = 140;
            const X = (ts) => nowX - ((now0 - ts) / span) * (gw - 90), Y = (c) => gy + gh - (G.clamp(c, lo, hi) - lo) / (hi - lo) * gh;
            cv.fillRect(gx, gy - 20, 22, 4, t.oil || t.accent); cv.text('OIL', gx + 30, gy - 11, 20, t.dim, { font: 'bold' });
            cv.fillRect(gx + 100, gy - 20, 22, 4, t.cold); cv.text('COOLANT', gx + 130, gy - 11, 20, t.dim, { font: 'bold' });
            if (hasGb) { cv.fillRect(gx + 250, gy - 20, 22, 4, GEAR_C); cv.text('GEARBOX', gx + 280, gy - 11, 20, t.dim, { font: 'bold' }); }
            cv.fillRect(gx, Y(warm), gw, 1, withAlpha(GO, 0.5));
            cv.text(String(Math.round(T(warm))), gx + gw + 4, Y(warm) + 7, 20, GO);
            cv.fillRect(nowX, gy, 1, gh, withAlpha(t.tick, 0.5));       // "now"
            [[1, t.oil || t.accent, 'oil', warm, d.oil], [2, t.cold, 'coolant', warmC, d.coolant]].concat(hasGb ? [[5, GEAR_C, 'gearbox', warmG, gb]] : []).forEach(([i, c, key, target, cur]) => {
                const pts = hist.filter((h) => G.isNum(h[i])).map((h) => [X(h[0]), Y(h[i])]).filter((p) => p[0] >= gx && p[0] <= nowX + 0.5);
                if (pts.length > 1) cv.polyline(pts, 3, c);
                // projection to the target, dashed
                const e = eta(key, cur, target, d);
                if (e.state === 'warming' && pts.length) {
                    const x0 = nowX, y0 = Y(cur), mins = Math.min(e.min, ahead / 60000);
                    const x1 = x0 + (mins * 60000 / ahead) * 90, y1 = Y(cur + e.rate * mins);
                    for (let k = 0; k < 6; k++) {
                        const a = k / 6, b = (k + 0.5) / 6;
                        cv.line(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a, x0 + (x1 - x0) * b, y0 + (y1 - y0) * b, 2, withAlpha(c, 0.8));
                    }
                }
            });
            cv.fillRect(gx, gy + gh, gw, 1, withAlpha(t.tick, 0.5));
            G.frame(cv, t, cs ? TABS : ['Warm-up'], 0, [d.demo && { text: 'DEMO' }]);     // G20-style frame
            return ui.image('MAIN_GFX', cv);
        }

        if (cs && ctx.onTab) ctx.onTab((i) => { page = i; return render(); });
        // every screen refresh (60 fps) with the GPU renderer; 4 fps in software (PNG frames)
        ctx.loop('MAIN', 4, render);
        render().then(() => ctx.log.info('first frame done')).catch((e) => ctx.log.warn('first render: ' + e));
    },
});
