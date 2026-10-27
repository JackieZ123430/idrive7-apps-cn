'use strict';
/**
 * Virtual Dyno - power and torque from a full-throttle pull.
 *
 *   wheel power = m*a*v  +  air drag  +  rolling resistance
 *   crank power = wheel power / (1 - drivetrain loss)
 *   torque      = power / engine angular speed
 *
 * A pull is recorded automatically: accelerate hard (> 0.12 g) in one gear
 * (rpm/speed ratio steady) across at least 1500 rpm. 3rd gear on a flat road
 * gives the best numbers. Runs are saved in data/dyno_runs.json; one can be
 * pinned as the baseline and is drawn behind every new run.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const Car = require('./kit/car');

const W = 1600, H = 520;
const BIN = 100, MIN_SPAN = 1500;
const CDA = { coupe: 0.62, wagon: 0.72, suv: 0.95 }, RHO = 1.2, CRR = 0.013;
const GO = '#2fd27a';

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const car = new Car(ctx, ['rpm', 'speed', 'accel', 'torque']);

        /* ---------- storage ---------- */
        const FILE = path.join(ctx.dataDir, 'dyno_runs.json');
        let saved = { runs: [], baseline: null };
        try { saved = Object.assign(saved, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (e) { /* first start */ }
        const demoStore = { runs: [], baseline: null };
        const store = () => (car.data().demo ? demoStore : saved);
        const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(saved)); } catch (e) { log.warn('save: ' + e); } };

        /* ---------- units ---------- */
        const PU = { hp: [745.7, 'hp'], ps: [735.5, 'PS'], kw: [1000, 'kW'] };
        const pw = (w) => (G.isNum(w) ? w / PU[settings.get('powerUnit')][0] : null);
        const pU = () => PU[settings.get('powerUnit')][1];
        const tq = (nm) => (G.isNum(nm) ? (settings.get('torqueUnit') === 'lbft' ? nm * 0.73756 : nm) : null);
        const tU = () => (settings.get('torqueUnit') === 'lbft' ? 'lb-ft' : 'Nm');

        /* ---------- pull detection ---------- */
        let pull = null;            // { segs: [{k, pts: []}], start }
        let live = { power: null, state: 'idle' };
        let lastRun = null, lastT = 0;

        function finishPull() {
            const p = pull; pull = null;
            if (!p) return;
            const best = p.segs.map((s) => {
                const r = s.pts.map((x) => x.rpm);
                return { s, span: r.length ? Math.max.apply(null, r) - Math.min.apply(null, r) : 0 };
            }).filter((x) => x.span >= MIN_SPAN && x.s.pts.length > 15).sort((a, b) => a.s.k - b.s.k)[0];   // tallest gear: least wheelspin
            if (!best) { live.state = 'short'; live.until = Date.now() + 4000; return; }
            const run = analyse(best.s.pts, p.start);
            const st = store();
            st.runs.unshift(run); st.runs = st.runs.slice(0, 20);
            if (st === saved) save();
            lastRun = run; live.state = 'done'; live.until = Date.now() + 6000;
            log.info('dyno run ' + Math.round(run.peakP / 745.7) + ' hp @' + run.peakPrpm + ', ' + Math.round(run.peakT) + ' Nm @' + run.peakTrpm);
        }

        /** bin samples by rpm, smooth, derive torque. */
        function analyse(pts, start) {
            const bins = {};
            pts.forEach((x) => { const b = Math.round(x.rpm / BIN) * BIN; (bins[b] = bins[b] || []).push(x); });
            const keys = Object.keys(bins).map(Number).sort((a, b) => a - b);
            const raw = keys.map((k) => ({
                rpm: k,
                p: bins[k].reduce((a, x) => a + x.p, 0) / bins[k].length,
                ecu: bins[k].some((x) => G.isNum(x.ecu)) ? bins[k].filter((x) => G.isNum(x.ecu)).reduce((a, x) => a + x.ecu, 0) / bins[k].filter((x) => G.isNum(x.ecu)).length : null,
            }));
            const curve = raw.map((c, i) => {
                const win = raw.slice(Math.max(0, i - 2), i + 3);
                const p = win.reduce((a, x) => a + x.p, 0) / win.length;
                return { rpm: c.rpm, p: Math.max(0, p), t: Math.max(0, p / (c.rpm * Math.PI / 30)), ecu: c.ecu };
            });
            const pk = curve.reduce((a, c) => (c.p > a.p ? c : a), curve[0]);
            const tk = curve.reduce((a, c) => (c.t > a.t ? c : a), curve[0]);
            return {
                at: start, curve, peakP: pk.p, peakPrpm: pk.rpm, peakT: tk.t, peakTrpm: tk.rpm,
                weight: settings.get('weight'), loss: settings.get('loss'),
                v0: pts[0].v, v1: pts[pts.length - 1].v,
            };
        }

        car.onSample((d, t) => {
            if (t - lastT < 40) return;
            lastT = t;
            if (!G.isNum(d.rpm) || !G.isNum(d.speed) || !G.isNum(d.gLong)) return;
            const v = d.speed / 3.6, a = d.gLong * 9.80665;
            const m = settings.get('weight'), cda = CDA[settings.get('body')] || 0.65;
            const wheel = m * a * v + 0.5 * RHO * cda * v * v * v + CRR * m * 9.80665 * v;
            const crank = wheel / (1 - settings.get('loss') / 100);
            const hard = d.gLong > 0.12 && d.speed > 15 && d.rpm > 1200;
            live.power = hard ? crank : null;
            if (hard) {
                if (!pull) { pull = { segs: [], start: Date.now() }; live.state = 'pull'; }
                const k = d.rpm / d.speed;
                let seg = pull.segs[pull.segs.length - 1];
                if (!seg || Math.abs(k - seg.k) / seg.k > 0.04) { seg = { k, pts: [] }; pull.segs.push(seg); }
                seg.k += (k - seg.k) * 0.1;
                seg.pts.push({ rpm: d.rpm, p: crank, v: d.speed, ecu: d.torque });
                pull.lastHard = t;
            } else if (pull && t - pull.lastHard > 500) finishPull();
        }, () => { pull = null; live = { power: null, state: 'idle' }; });

        /* ---------- drawing ---------- */
        let page = 0;
        const nice = (x, step) => Math.max(step, Math.ceil(x / step) * step);

        function plot(cv, t, x, y, w, h, runs) {
            const rMin = 1000, rMax = settings.get('maxRpm');
            const all = runs.filter(Boolean).reduce((a, r) => a.concat(r.curve), []);
            const pMax = nice(Math.max(150, ...all.map((c) => pw(c.p) * 1.12)), 50);
            const tMax = nice(Math.max(150, ...all.map((c) => Math.max(tq(c.t), tq(c.ecu) || 0) * 1.12)), 50);
            const X = (r) => x + (G.clamp(r, rMin, rMax) - rMin) / (rMax - rMin) * w;
            const YP = (v) => y + h - (v / pMax) * h, YT = (v) => y + h - (v / tMax) * h;
            for (let i = 0; i <= 5; i++) {
                const yy = y + (i / 5) * h;
                cv.fillRect(x, yy, w, 1, withAlpha(t.tick, 0.3));
                cv.text(String(Math.round(pMax * (1 - i / 5))), x - 10, yy + 7, 20, t.accent, { align: 'right' });
                cv.text(String(Math.round(tMax * (1 - i / 5))), x + w + 10, yy + 7, 20, t.accent2);
            }
            for (let r = 1000; r <= rMax; r += 1000) {
                cv.fillRect(X(r), y, 1, h, withAlpha(t.tick, 0.2));
                cv.text(String(r / 1000), X(r), y + h + 26, 20, t.dim, { align: 'center' });
            }
            cv.text(pU().toUpperCase(), x - 10, y - 14, 22, t.accent, { align: 'right', font: 'bold', spacing: 1 });
            cv.text(tU().toUpperCase(), x + w + 10, y - 14, 22, t.accent2, { font: 'bold', spacing: 1 });
            cv.text('x1000 RPM', x + w / 2, y + h + 52, 20, t.dim, { align: 'center', font: 'bold', spacing: 1 });
            const line = (run, key, Y, conv, col, width) => {
                const pts = run.curve.filter((c) => G.isNum(c[key])).map((c) => [X(c.rpm), Y(conv(c[key]))]);
                if (pts.length > 1) cv.polyline(pts, width, col);
                return pts;
            };
            const [cur, base] = runs;
            if (base && base !== cur) {
                line(base, 'p', YP, pw, withAlpha(t.dim, 0.7), 2.5);
                line(base, 't', YT, tq, withAlpha(t.dim, 0.5), 2);
            }
            if (cur) {
                const pp = line(cur, 'p', YP, pw, t.accent, 4);
                if (pp.length > 1) cv.fillUnder(pp, y + h, withAlpha(t.accent, 0.12));
                line(cur, 't', YT, tq, t.accent2, 3);
                if (settings.get('ecuTorque')) line(cur, 'ecu', YT, tq, withAlpha(t.text, 0.55), 2);
                const pk = [X(cur.peakPrpm), YP(pw(cur.peakP))], tk = [X(cur.peakTrpm), YT(tq(cur.peakT))];
                cv.circle(pk[0], pk[1], 8, t.text); cv.circle(pk[0], pk[1], 5, t.accent);
                cv.circle(tk[0], tk[1], 8, t.text); cv.circle(tk[0], tk[1], 5, t.accent2);
            } else {
                cv.text('No pull yet', x + w / 2, y + h / 2 - 10, 32, t.dim, { align: 'center', font: 'bold' });
                cv.text('Full throttle in 3rd gear from ~2000 rpm to the limiter, on a flat road', x + w / 2, y + h / 2 + 26, 22, t.dim, { align: 'center' });
            }
        }

        function bigStat(cv, t, x, y, label, val, unit, sub, col, delta) {
            cv.text(label, x, y, 22, t.dim, { font: 'bold', spacing: 2 });
            const vs = G.fmt(val, 0);
            const vw = cv.text(vs, x, y + 82, 96, G.isNum(val) ? col : t.dim, { font: 'num' });
            cv.text(unit, x + vw + 10, y + 82, 26, t.dim);
            if (sub) cv.text(sub, x, y + 114, 22, t.dim, { font: 'bold', spacing: 1 });
            if (G.isNum(delta) && Math.abs(delta) >= 0.5) {
                const s = (delta > 0 ? '+' : '') + delta.toFixed(0);
                cv.text(s, x + 330, y + 82, 32, delta > 0 ? GO : t.crit, { align: 'right', font: 'num' });
            }
        }

        function drawMain(cv, t) {
            const st = store();
            const cur = lastRun && st.runs.indexOf(lastRun) >= 0 ? lastRun : st.runs[0];
            const base = st.baseline;
            G.panel(cv, t, 24, 44, 1120, 468, 'Dyno sheet');
            plot(cv, t, 104, 135, 960, 294, [cur, base]);
            if (base) {
                cv.fillRect(600, 74, 26, 4, withAlpha(t.dim, 0.7));
                cv.text('BASELINE ' + Math.round(pw(base.peakP)) + ' ' + pU(), 634, 84, 22, t.dim, { font: 'bold', spacing: 0.5 });
            }
            if (settings.get('ecuTorque') && cur && cur.curve.some((c) => G.isNum(c.ecu))) {
                cv.fillRect(880, 74, 26, 3, withAlpha(t.text, 0.55));
                cv.text('ECU TORQUE', 914, 84, 22, t.dim, { font: 'bold', spacing: 0.5 });
            }

            G.panel(cv, t, 1168, 44, 408, 468, live.state === 'pull' ? 'Recording' : 'Peak');
            const now = Date.now();
            if (live.state === 'pull') {
                cv.circle(1540, 84, 9, Math.floor(now / 300) % 2 ? t.crit : withAlpha(t.crit, 0.3));
                bigStat(cv, t, 1192, 131, 'POWER NOW', pw(live.power), pU(), null, t.accent);
                const d = car.data();
                cv.text(G.fmt(d.rpm, 0) + ' rpm  ·  ' + G.fmt(d.gLong, 2) + ' g', 1192, 280, 26, t.text, { font: 'bold' });
                cv.text('keep it pinned...', 1192, 327, 22, t.dim);
            } else {
                bigStat(cv, t, 1192, 131, 'POWER', cur ? pw(cur.peakP) : null, pU(), cur ? '@ ' + cur.peakPrpm + ' RPM' : null, t.accent,
                    cur && base && cur !== base ? pw(cur.peakP) - pw(base.peakP) : null);
                bigStat(cv, t, 1192, 299, 'TORQUE', cur ? tq(cur.peakT) : null, tU(), cur ? '@ ' + cur.peakTrpm + ' RPM' : null, t.accent2,
                    cur && base && cur !== base ? tq(cur.peakT) - tq(base.peakT) : null);
                // a dyno sheet shows power at the wheels too: the same pull without the drivetrain loss
                let msg = cur ? 'crank (' + cur.loss + ' % loss)  ·  wheels ' + Math.round(pw(cur.peakP * (1 - cur.loss / 100))) + ' ' + pU() : 'waiting for a pull';
                let col = t.dim;
                if (live.state === 'done' && now < live.until) { msg = 'NEW RUN RECORDED'; col = GO; }
                if (live.state === 'short' && now < live.until) { msg = 'pull too short'; col = t.warn; }
                cv.text(msg, 1192, 486, 22, col, { font: 'bold', spacing: 0.5 });
            }
        }

        function drawRuns(cv, t) {
            const st = store();
            G.panel(cv, t, 24, 44, 1552, 468, 'Saved runs');
            const cols = [48, 320, 560, 800, 1050, 1430];
            ['WHEN', 'PEAK POWER', 'PEAK TORQUE', 'SPEED RANGE', 'SETUP', ''].forEach((h, i) => cv.text(h, cols[i], 127, 22, t.dim, { font: 'bold', spacing: 1 }));
            if (!st.runs.length) cv.text('No runs yet.', 48, 210, 26, t.dim);
            st.runs.slice(0, 8).forEach((r, i) => {
                const y = 174 + i * 41, d = new Date(r.at), p = (n) => String(n).padStart(2, '0');
                const isBase = st.baseline && st.baseline.at === r.at, isSel = i === sel;
                if (isSel) cv.roundRect(36, y - 28, 1528, 38, 6, withAlpha(t.accent, 0.18));
                cv.text(p(d.getDate()) + '.' + p(d.getMonth() + 1) + '. ' + p(d.getHours()) + ':' + p(d.getMinutes()), cols[0], y, 24, t.text);
                cv.text(Math.round(pw(r.peakP)) + ' ' + pU() + ' @ ' + r.peakPrpm, cols[1], y, 24, t.accent, { font: 'bold' });
                cv.text(Math.round(tq(r.peakT)) + ' ' + tU() + ' @ ' + r.peakTrpm, cols[2], y, 24, t.accent2, { font: 'bold' });
                cv.text(Math.round(r.v0) + '-' + Math.round(r.v1) + ' km/h', cols[3], y, 24, t.text);
                cv.text(r.weight + ' kg · ' + r.loss + '%  ·  wheels ' + Math.round(pw(r.peakP * (1 - r.loss / 100))) + ' ' + pU(), cols[4], y, 22, t.dim);
                if (isBase) cv.text('BASELINE', cols[5], y, 22, t.text, { font: 'bold', spacing: 1 });
            });
        }

        /** G20-style frame: tab bar with the page names along the top. */
        function header(cv, t) {
            G.frame(cv, t, ['Virtual dyno', 'Saved runs'], page, [car.data().demo && { text: 'DEMO' }]);
        }

        async function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            (page === 0 ? drawMain : drawRuns)(cv, t);
            header(cv, t);
            await ui.image('MAIN_GFX', cv);
        }

        /* ---------- buttons ---------- */
        let sel = 0;
        const labels = () => ui.text('BTN_ACTION', page ? 'Next run' : 'Baseline');
        const flip = () => { page = 1 - page; sel = 0; labels(); return render(); };
        ui.onClick('BTN_PAGE', flip);
        ui.onClick('BTN_PREV', flip);
        ui.onClick('BTN_ACTION', () => {
            const st = store();
            if (page === 1) { if (st.runs.length) sel = (sel + 1) % Math.min(8, st.runs.length); lastRun = st.runs[sel] || null; return render(); }
            const r = lastRun && st.runs.indexOf(lastRun) >= 0 ? lastRun : st.runs[0];
            if (!r) return null;
            st.baseline = st.baseline && st.baseline.at === r.at ? null : r;
            if (st === saved) save();
            log.info(st.baseline ? 'baseline pinned' : 'baseline cleared');
            return render();
        });
        // every screen refresh (60 fps) with the GPU renderer; 6 fps in software (PNG frames)
        ctx.loop('MAIN', 6, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
