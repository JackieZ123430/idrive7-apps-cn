'use strict';
/**
 * G-Force - friction circle for the driver who wants to know how much grip
 * they actually used.
 *
 *   - live dot with fading trail
 *   - grip envelope: the furthest g reached in every direction this session
 *     (the classic g-g diagram shape - fill it out and you're using the car)
 *   - peak accel / brake / left / right, combined peak, top speed, max rpm
 *   - all-time records saved in data/gforce_records.json
 *
 * Small spikes (kerbs, potholes) are filtered with a 150 ms moving average.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const Car = require('./kit/car');

const W = 1600, H = 520;
const MPH = 1.609344;
const SECT = 48;
const GO = '#2fd27a';

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const car = new Car(ctx, ['accel', 'speed', 'rpm']);

        const FILE = path.join(ctx.dataDir, 'gforce_records.json');
        let rec = {};
        try { rec = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { /* first start */ }
        const demoRec = {};
        let saveTimer = null;
        const saveSoon = () => { if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; try { fs.writeFileSync(FILE, JSON.stringify(rec)); } catch (e) { log.warn('save: ' + e); } }, 5000); };

        /* ---------- session ---------- */
        let S;
        const newSession = () => {
            S = { start: Date.now(), env: new Array(SECT).fill(0), peak: { acc: 0, brk: 0, left: 0, right: 0, comb: 0 }, vmax: 0, rpmMax: 0, over05: 0, trail: [], lastT: 0 };
        };
        newSession();
        const smooth = [];
        let cur = { lat: null, long: null };

        car.onSample((d, t) => {
            if (!G.isNum(d.gLong)) return;
            // a road car can't exceed ~3 g: anything above is a bad sample, not a record
            if (Math.abs(d.gLong) > 3 || (G.isNum(d.gLat) && Math.abs(d.gLat) > 3)) return;
            const lat0 = G.isNum(d.gLat) ? (settings.get('flipLat') ? -d.gLat : d.gLat) : 0;
            smooth.push([t, lat0, d.gLong]);
            while (smooth.length && t - smooth[0][0] > 150) smooth.shift();
            const lat = smooth.reduce((a, s) => a + s[1], 0) / smooth.length, long = smooth.reduce((a, s) => a + s[2], 0) / smooth.length;
            cur = { lat, long };
            const dt = S.lastT ? Math.min(250, t - S.lastT) : 0; S.lastT = t;
            const comb = Math.sqrt(lat * lat + long * long);
            const p = S.peak;
            p.acc = Math.max(p.acc, long); p.brk = Math.max(p.brk, -long);
            p.left = Math.max(p.left, lat); p.right = Math.max(p.right, -lat); p.comb = Math.max(p.comb, comb);
            if (comb > 0.5) S.over05 += dt / 1000;
            // envelope sector: angle of (lat, long), 0 = accel (up), clockwise
            const a = (Math.atan2(lat, long) * 180 / Math.PI + 360) % 360;
            const si = Math.floor(a / (360 / SECT)) % SECT;
            S.env[si] = Math.max(S.env[si], comb);
            if (G.isNum(d.speed)) S.vmax = Math.max(S.vmax, d.speed);
            if (G.isNum(d.rpm)) S.rpmMax = Math.max(S.rpmMax, d.rpm);
            S.trail.push([t, lat, long]);
            const keep = settings.get('trail') * 1000;
            while (S.trail.length && t - S.trail[0][0] > keep) S.trail.shift();
            // all-time records
            const R = d.demo ? demoRec : rec;
            let changed = false;
            [['acc', p.acc], ['brk', p.brk], ['left', p.left], ['right', p.right], ['comb', comb], ['vmax', S.vmax]].forEach(([k, v]) => {
                if (v > ((R[k] && R[k].v) || 0) + 1e-3) { R[k] = { v, at: Date.now() }; changed = true; }
            });
            if (changed && R === rec) saveSoon();
        }, () => { newSession(); smooth.length = 0; });

        /* ---------- drawing ---------- */
        let page = 0;
        const mph = () => settings.get('speedUnit') === 'mph';
        const V = (k) => (mph() ? k / MPH : k);

        function circle(cv, t, cx, cy, r) {
            const max = settings.get('scale');
            cv.circle(cx, cy, r + 14, withAlpha(t.panelTop, 0.9));
            for (let ring = 0.25; ring <= max + 1e-6; ring += 0.25) {
                const rr = (ring / max) * r, major = Math.abs(ring % 0.5) < 1e-6;
                cv.arc(cx, cy, rr - (major ? 1.5 : 0.75), rr + (major ? 1.5 : 0.75), 0, 360, major ? t.tick : withAlpha(t.tick, 0.35));
                if (major) cv.text(ring.toFixed(1), cx + rr * 0.7071 + 6, cy - rr * 0.7071 - 4, 20, t.dim);
            }
            cv.line(cx - r, cy, cx + r, cy, 2, withAlpha(t.tick, 0.5));
            cv.line(cx, cy - r, cx, cy + r, 2, withAlpha(t.tick, 0.5));
            const P = (lat, lon) => [cx - G.clamp(lat / max, -1.08, 1.08) * r, cy - G.clamp(lon / max, -1.08, 1.08) * r];
            // grip envelope (left = positive lat drawn to the left)
            const pts = S.env.map((g, i) => {
                const a = (i + 0.5) * (360 / SECT) * Math.PI / 180;
                return P(Math.sin(a) * g, Math.cos(a) * g);
            });
            if (S.env.some((g) => g > 0.05)) {
                pts.forEach((p, i) => { const q = pts[(i + 1) % pts.length]; cv.line(p[0], p[1], q[0], q[1], 3, withAlpha(t.accent2, 0.8)); });
            }
            // trail
            const tr = S.trail, n = tr.length;
            tr.forEach((s, i) => { if (i % 2) return; const [x, y] = P(s[1], s[2]); cv.circle(x, y, 4, withAlpha(t.accent, 0.08 + 0.55 * (i / n))); });
            if (G.isNum(cur.long)) {
                const [x, y] = P(cur.lat, cur.long);
                cv.circle(x, y, 20, withAlpha(t.accent, 0.25));
                cv.circle(x, y, 12, t.accent);
                cv.circle(x, y, 5, t.text);
            }
            cv.text('ACCEL', cx, cy - r - 20, 22, t.dim, { align: 'center', font: 'bold', spacing: 1.5 });
            cv.text('BRAKE', cx, cy + r + 38, 22, t.dim, { align: 'center', font: 'bold', spacing: 1.5 });
            cv.text('L', cx - r - 30, cy + 8, 22, t.dim, { align: 'center', font: 'bold' });
            cv.text('R', cx + r + 30, cy + 8, 22, t.dim, { align: 'center', font: 'bold' });
        }

        function peakBox(cv, t, x, y, label, v, rec) {
            cv.text(label, x, y, 22, t.dim, { font: 'bold', spacing: 1.5 });
            const w = cv.text(v > 0.005 ? v.toFixed(2) : '-.--', x, y + 58, 64, v > 0.005 ? t.text : t.dim, { font: 'num' });
            cv.text('g', x + w + 6, y + 58, 24, t.dim);
            if (rec && rec.v > 0) cv.text('record ' + rec.v.toFixed(2), x, y + 88, 22, Math.abs(rec.v - v) < 1e-3 && v > 0.05 ? GO : t.dim, { font: 'bold' });
        }

        function drawLive(cv, t) {
            const R = car.data().demo ? demoRec : rec;
            G.panel(cv, t, 24, 44, 600, 468, null);
            circle(cv, t, 324, 282, 182);
            // live readout
            G.panel(cv, t, 648, 44, 420, 468, 'Now');
            // numbers at the G-force display rate (default 10 a second); the dot and trail stay at full rate
            const gms = 1000 / (settings.get('gRate') || 10);
            const hl = G.hold('glat', cur.lat, gms), hg = G.hold('glong', cur.long, gms);
            const comb = G.isNum(hg) ? Math.sqrt(hl * hl + hg * hg) : null;
            const cw = cv.text(G.fmt(comb, 2), 672, 199, 120, G.isNum(comb) ? (comb > 0.9 ? t.accent2 : t.text) : t.dim, { font: 'num' });
            cv.text('g', 680 + cw, 199, 36, t.dim);
            const bars = [['LATERAL', G.isNum(hl) ? Math.abs(hl) : null, G.isNum(hl) ? (hl >= 0 ? 'L' : 'R') : ''],
                ['LONGITUDINAL', G.isNum(hg) ? Math.abs(hg) : null, G.isNum(hg) ? (hg >= 0 ? 'ACC' : 'BRK') : '']];
            // OEM-style bars; the hang is this session's peak on the side it is pulling to now
            const pk = [hl >= 0 ? S.peak.left : S.peak.right, hg >= 0 ? S.peak.acc : S.peak.brk];
            bars.forEach(([l, v, side], i) => {
                G.bar(cv, t, 672, 233 + i * 108, 372, 92, { label: l + '  ' + side, value: v, decimals: 2, max: settings.get('scale'), ramp: 'hot', peak: pk[i] });
            });
            const d = car.data();
            cv.text(G.fmt(V(G.hold('speed', d.speed, gms)), 0) + (mph() ? ' mph' : ' km/h') + '   ·   ' + G.fmt(d.rpm, 0) + ' rpm', 672, 491, 22, t.dim, { font: 'bold', spacing: 1 });

            // session peaks
            G.panel(cv, t, 1092, 44, 484, 468, 'Session peaks');
            G.button(cv, t, 1576 - 20 - 180, 56, 180, 40, 'Reset max', act, { key: 'reset' });
            peakBox(cv, t, 1116, 116, 'ACCEL', S.peak.acc, R.acc);
            peakBox(cv, t, 1346, 116, 'BRAKE', S.peak.brk, R.brk);
            peakBox(cv, t, 1116, 255, 'LEFT', S.peak.left, R.left);
            peakBox(cv, t, 1346, 255, 'RIGHT', S.peak.right, R.right);
            cv.fillRect(1116, 382, 436, 1, withAlpha(t.tick, 0.4));
            cv.text('COMBINED  ' + (S.peak.comb ? S.peak.comb.toFixed(2) + ' g' : '--'), 1116, 421, 22, t.accent2, { font: 'bold', spacing: 1 });
            cv.text('> 0.5 g  ' + S.over05.toFixed(0) + ' s', 1552, 421, 22, t.text, { align: 'right', font: 'bold' });
            const mins = Math.floor((Date.now() - S.start) / 60000);
            cv.text('TOP ' + Math.round(V(S.vmax)) + (mph() ? ' MPH' : ' KM/H') + '  ·  ' + Math.round(S.rpmMax) + ' RPM  ·  ' + mins + ' MIN', 1116, 474, 22, t.dim, { font: 'bold', spacing: 0.5 });
        }

        function drawRecords(cv, t) {
            const R = car.data().demo ? demoRec : rec;
            G.panel(cv, t, 24, 44, 1552, 468, 'All-time records');
            G.button(cv, t, 1576 - 20 - 200, 56, 200, 40, clearArmed ? 'Yes, clear' : 'Delete all', act, { key: 'clear', color: clearArmed ? t.crit : null });
            const rows = [['acc', 'Hardest launch', 'g'], ['brk', 'Hardest stop', 'g'], ['left', 'Left-hander', 'g'], ['right', 'Right-hander', 'g'], ['comb', 'Combined', 'g'], ['vmax', 'Top speed', mph() ? 'mph' : 'km/h']];
            rows.forEach(([k, label, u], i) => {
                const col = i % 2, row = Math.floor(i / 2), x = 48 + col * 760, y = 135 + row * 123;
                const r = R[k], v = r ? (k === 'vmax' ? V(r.v) : r.v) : null;
                cv.text(label.toUpperCase(), x, y, 22, t.dim, { font: 'bold', spacing: 2 });
                const w = cv.text(v === null ? '--' : v.toFixed(k === 'vmax' ? 0 : 2), x, y + 66, 64, v === null ? t.dim : t.text, { font: 'num' });
                cv.text(u, x + w + 8, y + 66, 26, t.dim);
                if (r) { const d = new Date(r.at), p = (n) => String(n).padStart(2, '0'); cv.text(p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear(), x + 300, y + 66, 22, t.dim); }
            });
        }

        /** G20-style frame: tab bar with the page names along the top. */
        function header(cv, t) {
            G.frame(cv, t, ['G-force', 'Records'], page, [car.data().demo && { text: 'DEMO' }]);
        }

        async function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            (page === 0 ? drawLive : drawRecords)(cv, t);
            header(cv, t);
            await ui.image('MAIN_GFX', cv);
        }

        let clearArmed = null;
        const actionLabel = () => ui.text('BTN_ACTION', page === 0 ? 'Reset max' : clearArmed ? 'Yes, clear' : 'Delete all');
        const flip = () => { page = 1 - page; actionLabel(); return render(); };
        ui.onClick('BTN_PAGE', flip);
        ui.onClick('BTN_PREV', flip);
        ctx.onTab((i) => i !== page && flip());
        // Reset max (G-force) / Delete all, pressed twice (Records): on the page, or the bar's button
        function act() {
            if (page === 0) { newSession(); return render(); }
            if (!clearArmed) { clearArmed = setTimeout(() => { clearArmed = null; actionLabel(); }, 5000); return actionLabel(); }
            clearTimeout(clearArmed); clearArmed = null;
            const R = car.data().demo ? demoRec : rec;
            Object.keys(R).forEach((k) => delete R[k]);
            if (R === rec) saveSoon();
            actionLabel(); return render();
        }
        ui.onClick('BTN_ACTION', act);
        ctx.hideButton('BTN_ACTION');
        // every screen refresh (60 fps) with the GPU renderer; 10 fps in software (PNG frames)
        ctx.loop('MAIN', 10, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
