'use strict';
/**
 * Part of Redline's experimental features; README.md in this folder has the whole picture.
 *
 * The layouts after BMW M's own head-up displays (setting "hudStyle"), drawn by hud-draw.js's drawLayer()
 * for these styles. Their colours are the originals' (they take no palette); the readouts, the shift grade
 * and its burst, the peak, the downshift arrows and the limiter flash work as in the other layouts.
 * Draws on canvas.js Canvas (or hud-draw's scaled()); arc() angles are degrees clockwise from 12 o'clock.
 *   arc   after F80/F82 M3/M4 (2014-20): 8 curved lights (6 amber, 2 red) over a curved band, gear under it
 *   ramp  after G80/G82 M3/M4 (2021+): a thick rail climbs from bottom left then runs flat, the revs a band
 *         under it; 8 slanted lights over the flat part (6 yellow, 2 red); squared digits; gear over a line
 *   dial  after E60 M5 (2005-10): a 3/4 dial round the gear, green / orange advance warning / red,
 *         a readout bottom right in the dial's orange-red
 */
const { withAlpha } = require('./kit/canvas');
const Theme = require('./hud-theme');
const isNum = (x) => typeof x === 'number' && isFinite(x);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const flashing = (cue) => cue.shift || cue.limiter;

/* ---------- shared: readouts, the shift grade, the burst ---------- */
const chipCol = Theme.chipCol;
const toneCol = (it, P, base) => Theme.toneCol(it.tone, P, base);
/**
 * A readout's label size and colour: Normal 13 px nearly full brightness, Clearer 16 px full (10 / 12 px
 * read as specks on the glass, 2026-11-09 drive).
 */
const labelOf = (o, base) => (o.clearLabels ? { s: 16, c: base } : { s: 13, c: withAlpha(base, 0.9) });
/** A label at (x, y), made smaller (down to 8 px) when it would be wider than room. */
function fitLabel(cv, text, x, y, size, col, room, opts) {
    const lo = Object.assign({ font: 'bold', spacing: 1 }, opts || {});
    cv.text(text, x, y, room ? Theme.fitSize(cv, text, size, room, lo) : size, col, lo);
}
/** A small readout: label then value on one line (row) or label over value (stack); align 'left' | 'right' | 'center'. */
function small(cv, x, y, it, P, o, base, mode, align, vsize) {
    const vs = vsize || 19;
    const lab = labelOf(o, base);
    if (mode === 'row') {
        // label at x, value right-aligned at the row's right edge (x + w); a label too long for the room the
        // value leaves (GEARBOX 120°, BOOST in kPa) is drawn smaller, down to 8 px, rather than run into it
        const w = align, lo = { font: 'bold', spacing: 1 };
        const ls = cv.textWidth ? Theme.fitSize(cv, it.label, lab.s, w - cv.textWidth(it.value, vs, { font: 'bold' }) - 4, lo) : lab.s;
        cv.text(it.label, x, y, ls, lab.c, lo);
        cv.text(it.value, x + w, y + 1, vs, toneCol(it, P, base), { align: 'right', font: 'bold' });
        return;
    }
    cv.text(it.label, x, y, lab.s, lab.c, { align: align, font: 'bold', spacing: 1 });
    cv.text(it.value, x, y + 21, 20, toneCol(it, P, base), { align: align, font: 'bold' });
}
/*
 * The Recovery / Power meter as a ring segment (arc and dial; a readout with .bar, hud.js): not in the list but a thin
 * band concentric with the layout's own, from angle a0 to a1 (degrees clockwise from 12 o'clock), radii r0..r1. Zero
 * where lo..hi maps 0; recovery fills anticlockwise from it in c.low, power clockwise in c.fill (c.warm from 85 % of
 * bar.hi). layer 'bg': the outline (c.line) and the zero tick (c.tick, radii t0..t1); 'fg': the fill; neither: both.
 * v beyond lo / hi fills to the end; v 0 (or not a number) fills nothing.
 */
function ringMeter(cv, cx, cy, r0, r1, a0, a1, t0, t1, bar, c, layer) {
    const lo = isNum(bar.lo) && bar.lo < 0 ? bar.lo : -1, hi = isNum(bar.hi) && bar.hi > 0 ? bar.hi : 1;
    const az = a0 + (a1 - a0) * (-lo) / (hi - lo);
    if (layer !== 'fg') {
        cbox(cv, cx, cy, a0, a1, r0, r1, c.line, 1.1);
        // the zero: bold (about 3 px wide), so it reads at a glance where recovery ends and power starts
        cv.arc(cx, cy, t0, t1, az - 1.5 * 60 / r1, az + 1.5 * 60 / r1, c.tick);
    }
    if (layer === 'bg' || !isNum(bar.v)) return;
    if (bar.v < 0) { const k = clamp(bar.v / lo, 0, 1); if (k > 0.01) cv.arc(cx, cy, r0, r1, az - (az - a0) * k, az, c.low); }
    else if (bar.v > 0) { const k = clamp(bar.v / hi, 0, 1); if (k > 0.01) cv.arc(cx, cy, r0, r1, az, az + (a1 - az) * k, bar.v >= 0.85 * hi ? c.warm : c.fill); }
}
/** The shift grade at (x, y): pops in (burst), holds, fades over its last 300 ms. */
function grade(cv, x, y, chip, P, size, align) {
    const a = chip.age || 0, c = chipCol(chip, P);
    const alpha = Theme.burstAlpha(a);
    const s = chip.burst && a < Theme.BURST.pop ? size * (1.3 - 0.3 * a / Theme.BURST.pop) : size;
    if (alpha > 0) cv.text(chip.text || chip.verdict, x, y, s, withAlpha(c, alpha), { align: align || 'center', font: 'bold', spacing: 1 });
}
/** Burst: a ring grows from (cx, cy) radius r0 to r1 over 500 ms and fades. */
function ring(cv, cx, cy, r0, r1, chip, P) {
    const k = Theme.burstRing(chip.age || 0);
    if (!chip.burst || k < 0) return;
    const r = r0 + (r1 - r0) * k;
    cv.arc(cx, cy, r - 2.5, r, 0, 360, withAlpha(chipCol(chip, P), 0.85 * (1 - k)));
}
const burstOn = (chip, ms) => chip && chip.burst && (chip.age || 0) < ms;
/**
 * The band layouts' shift colours follow the app's "Shift light style" as the other layouts' lights do:
 * M (the originals' own colours: own() false), Race (green / red / blue) or one colour. With the HUD's
 * shift lights Off they don't count in or flash for the shift; the limiter still flashes.
 */
const ownColours = (o) => o.lightStyle === 'f1' || o.lightStyle === 'mono';
const flashOn = (o, cue) => cue.limiter || (o.lights && cue.shift);
const flashColour = (o, cue, h, red) => (!cue.limiter && o.lightStyle === 'f1' ? h.RACE_BLUE : red);   // as drawLights: Race blue, else red

/* ---------- arc (F80) ---------- */
const A = { cx: 200, cy: 372, span: 27, l0: 352, l1: 368, b0: 325, b1: 343, rim: 3 };
// the power meter: a 6 px ring inside the rpm band (b0) with a gap, a little shorter than it (clear of the readouts)
const AM = { r0: 314, r1: 320, span: 25, dn: 4 };
const AC = { amber: '#f2a81d', red: '#e3262a', rim: '#f4f4f4', fill: '#bcd6e8', unlit: '#5d6b74', warn: '#f2b81d', zone: '#e3262a' };
const aAng = (f) => -A.span + 2 * A.span * clamp(f, 0, 1);
const aPt = (a, r) => [A.cx + r * Math.sin(a * Math.PI / 180), A.cy - r * Math.cos(a * Math.PI / 180)];
function cbox(cv, cx, cy, a0, a1, r0, r1, c, w) {
    if (!w) { cv.arc(cx, cy, r0, r1, a0, a1, c); return; }
    const da = (w / r1) * 180 / Math.PI;
    cv.arc(cx, cy, r1 - w, r1, a0, a1, c); cv.arc(cx, cy, r0, r0 + w, a0, a1, c);
    cv.arc(cx, cy, r0, r1, a0, a0 + da, c); cv.arc(cx, cy, r0, r1, a1 - da, a1, c);
}
const arcBands = [];
/**
 * Where drawArc may copy the lit band in, per row: spans of the band's own ring (a pixel either side: the lights
 * over it share these rows), 3 px clear of its start and colour joins (a piece's start edge shades a hair
 * differently with where the piece ends) and of the lit end (angle aDeg). null when there's nothing to copy or no
 * static layer to copy over. The ring and joins part is worked out once per scale (kept in bandRows).
 */
let bandRows = { key: '', rows: null };
function band(cv, base, seams, aDeg) {
    if (!base || !cv.d || cv.w !== base.w || cv.h !== base.h) return null;
    const key = seams.join('|') + '|' + cv.h;
    if (bandRows.key !== key) {
        const sp = A.span * Math.PI / 180, ts = seams.map((a) => Math.tan(a * Math.PI / 180));
        const x0 = Math.max(0, Math.floor(A.cx - (A.b1 + 2) * Math.sin(sp)) - 2);
        const y0 = Math.max(0, Math.floor(A.cy - A.b1 - 2)), y1 = Math.min(cv.h - 1, Math.ceil(A.cy - A.b0 * Math.cos(sp) + 2));
        const rA = A.b0 - 1, rB = A.b1 + 1, rows = [];
        for (let py = y0; py <= y1; py++) {
            const dy = py + 0.5 - A.cy;
            if (Math.abs(dy) > rB) continue;
            const xl = Math.max(x0, Math.floor(A.cx - Math.sqrt(rB * rB - dy * dy)) - 1);
            const xr = Math.abs(dy) < rA ? Math.ceil(A.cx - Math.sqrt(rA * rA - dy * dy)) + 1 : Math.ceil(A.cx + Math.sqrt(rB * rB - dy * dy)) + 1;
            let spans = [[xl, xr]];
            ts.forEach((t) => {
                const xs = A.cx - dy * t, a = Math.floor(xs - 3), b = Math.ceil(xs + 3);
                spans = [].concat.apply([], spans.map((q) => [[q[0], Math.min(q[1], a)], [Math.max(q[0], b), q[1]]]));
            });
            spans = spans.filter((q) => q[1] > q[0]).sort((p, q) => p[0] - q[0]);
            if (spans.length) rows.push({ py: py, dy: dy, spans: spans });
        }
        bandRows = { key: key, rows: rows };
    }
    // this frame: each span up to 3 px short of where the lit end's radial line crosses its row
    const ta = Math.tan(aDeg * Math.PI / 180), copy = [];
    let any = false;
    bandRows.rows.forEach((r) => {
        const cut = Math.min(cv.w, Math.floor(A.cx - r.dy * ta - 3)), out = [];
        for (let i = 0; i < r.spans.length; i++) {
            const q = r.spans[i];
            if (q[0] >= cut) break;
            out.push(q[1] <= cut ? q : [q[0], cut]);
        }
        if (out.length) { any = true; copy[r.py] = out; }
    });
    return any ? { copy: copy } : null;
}
function drawArc(cv, f, layer, h) {
    const o = f.opts, d = f.d, cue = f.cue, bg = layer !== 'fg', fg = layer !== 'bg', R = (r) => aAng(r / f.max);
    if (o.lights) {
        const n = 8, gap = 1.3, step = 2 * A.span / n, fl = flashing(cue);
        // "Shift light style": M is the F80's own amber and red; Race and one colour as the app's lights
        const own = o.lightStyle === 'f1' || o.lightStyle === 'mono';
        const flashCol = cue.limiter ? AC.red : o.lightStyle === 'f1' ? h.RACE_BLUE : AC.red;
        const lit = fl ? n : Math.ceil((isNum(d.rpm) ? clamp((d.rpm - cue.from) / (cue.at - cue.from), 0, 1) : 0) * (n - 1));
        for (let i = 0; i < n; i++) {
            const a0 = -A.span + i * step + gap / 2, a1 = a0 + step - gap, col = own ? h.lightCol(o.lightStyle, h.P, i / (n - 1)) : i >= n - 2 ? AC.red : AC.amber;
            if (bg && o.dim) cbox(cv, A.cx, A.cy, a0, a1, A.l0, A.l1, withAlpha(col, 0.85), 1.6);
            if (fg && i < lit && (!fl || f.blink)) cbox(cv, A.cx, A.cy, a0, a1, A.l0, A.l1, fl ? flashCol : col, 0);
        }
    }
    if (o.bar !== false) {
        const warn = Math.max(0, f.redline - 500);
        if (bg) {
            if (o.dim) cv.arc(A.cx, A.cy, A.b0, A.b1, R(0), R(warn), withAlpha(AC.unlit, 0.9));
            cv.arc(A.cx, A.cy, A.b0, A.b1, R(warn), R(f.redline), withAlpha(AC.warn, 0.55));
            cv.arc(A.cx, A.cy, A.b0, A.b1, R(f.redline), R(f.max), withAlpha(AC.zone, 0.55));
        }
        if (fg && isNum(d.rpm) && d.rpm > 50) {
            const top = Math.min(d.rpm, f.max), lim = cue.limiter, c = lim ? (f.blink ? AC.zone : withAlpha(AC.zone, 0.4)) : AC.fill;
            const fill = (t, on, opts) => {
                on.arc(A.cx, A.cy, A.b0, A.b1, R(0), R(Math.min(t, warn)), c, opts);
                if (t > warn) on.arc(A.cx, A.cy, A.b0, A.b1, R(warn), R(Math.min(t, f.redline)), lim ? c : AC.warn, opts);
                if (t > f.redline) on.arc(A.cx, A.cy, A.b0, A.b1, R(f.redline), R(t), lim ? c : AC.zone, opts);
            };
            // drawHud's frames (h.base: the static layer under them): the band drawn lit to the end once over that
            // layer, its pixels left of the lit end copied in, only the rest drawn (the band was over half a frame)
            const base = layer === 'fg' && h.base, B = band(cv, base, [R(0), R(warn), R(f.redline)], R(top));
            if (!B) fill(top, cv);
            else {
                const key = [lim, lim && f.blink, f.redline, f.max].join('|');
                let lit = arcBands.filter((e) => e.key === key && e.base === base)[0];
                if (!lit) {
                    lit = { key: key, base: base, cv: new base.constructor(base.w, base.h) };
                    lit.cv.d.set(base.d);
                    fill(f.max, lit.cv);
                    arcBands.unshift(lit); arcBands.length = Math.min(arcBands.length, 4);
                }
                const W4 = cv.w * 4;
                B.copy.forEach((spans, py) => { if (spans) spans.forEach((c) => cv.d.set(lit.cv.d.subarray(py * W4 + c[0] * 4, py * W4 + c[1] * 4), py * W4 + c[0] * 4)); });
                // the rest: all but what was copied
                fill(top, cv, { skip: (py) => B.copy[py] || null });
            }
        }
        if (bg) {
            cv.arc(A.cx, A.cy, A.b1, A.b1 + A.rim, R(0) - 0.4, R(f.max) + 0.4, AC.rim);
            for (let r = 1000; r < f.max; r += 1000) { const p = aPt(R(r), A.b1), q = aPt(R(r), A.b0 + 6); cv.line(p[0], p[1], q[0], q[1], 1.6, AC.rim); }
        }
        if (fg && isNum(f.peak) && f.peak > 0 && !(isNum(d.rpm) && d.rpm >= f.peak - 50)) {
            const p = aPt(R(Math.min(f.peak, f.max)), A.b1 + A.rim), q = aPt(R(Math.min(f.peak, f.max)), A.b0);
            cv.line(p[0], p[1], q[0], q[1], 2.4, '#ffffff');
        }
    }
    // the power meter inside the band, along its curve (not in the list)
    const meter = (f.readouts || []).filter((it) => it.bar)[0];
    if (meter) ringMeter(cv, A.cx, A.cy, AM.r0, AM.r1, -AM.span, AM.span, AM.r0 - 3, AM.r1 + 2, meter.bar,
        { line: withAlpha(AC.rim, 0.6), tick: AC.rim, low: h.P.low, fill: AC.fill, warm: AC.amber }, layer);
    if (!fg) return;
    const W = '#f4f4f4', P = h.P, items = (f.readouts || []).filter((it) => !it.bar);
    if (f.chip) ring(cv, A.cx, 102, 28, 70, f.chip, P);
    if (o.gear) cv.text(h.gearText(d), A.cx, 124, 62, cue.limiter && f.blink ? AC.red : W, { align: 'center', font: h.gearFont(o) });
    if (f.mode && o.gear) cv.text(f.mode, A.cx + 30, 86, 16, withAlpha(W, 0.85), { font: 'bold' });
    h.drawDown(cv, A.cx - 40, 112, f.down || 0, 0.8, P.arrow);
    // left, under the band and kept high (BMW's assistance graphic sits bottom left): readout 4
    // (with the meter over it, 4 px lower to keep a gap)
    if (items[3]) small(cv, 132, 82 + (meter ? AM.dn : 0), items[3], P, o, W, 'stack', 'center');
    // right: readout 1 big beside the gear, 2 and 3 stacked at the far right; the grade takes them over
    if (f.chip) grade(cv, 312, 122, f.chip, P, 24);
    else {
        if (items[0]) {
            const lb = labelOf(o, W);
            fitLabel(cv, items[0].label, 288, 100, lb.s, lb.c, 48, { align: 'center' });
            cv.text(items[0].value, 288, 125, 26, toneCol(items[0], P, W), { align: 'center', font: o.valFont || 'bold' });
        }
        // from just right of the first readout (it ends by x 313) to the edge, values a size smaller
        if (items[1]) small(cv, 318, 104, items[1], P, o, W, 'row', 80, 17);
        if (items[2]) small(cv, 318, 126, items[2], P, o, W, 'row', 80, 17);
    }
}

/* ---------- ramp (G80) ---------- */
/*
 * 2.0.21, redrawn from a video of the G80's own HUD. The gauge is one thick rail with no bottom edge: it climbs from
 * the 0 at bottom left, bends round a wide knee at the 2 and runs flat to the end, a rounded tab hanging from it every
 * 1,000 rpm (a V cut over the numbered ones, an open cup at each end: rRail). The rpm hangs under the rail as a cream
 * band up to a red sliver, a hairline gap round each tab (rBand); past it only the rail shows. The red zone is a thin red line inside the band, after a dash and a dot. Over the flat part a row
 * of 8 slanted bars counts in to the shift (6 yellow, 1 red, then a red one twice as wide) and flashes all red at it.
 * Digits are squared (sqText, our own), the gear left of centre over a line (its foot level with the 0's, in any gear
 * font), the first readout under it.
 */
// the rail's top edge: from (x0, y0) up to the knee (kx, ky), then flat to x1; rt the rail, ft the band under it,
// kr the knee's radius
// (the climb a little short of 2,000 rpm, so the 2 sits under the flat clear of it, as on the G80)
// rt: where the band starts under the rail's top edge (the rail 2.4 px, then a 0.9 px gap, as on the glass)
const RP = { x0: 38, y0: 72, kx: 90, ky: 22, x1: 372, rt: 4.4, ft: 9, kr: 44 };
const RC = { line: '#f4f1e6', fill: '#f4f1e6', yellow: '#ffd84a', red: '#ff4636', text: '#f4f1e6' };
// the lights over the flat part: 8 bars (the last twice as wide), leaning right by slant
const RL = { x0: 121, x1: 372, y0: 3.5, y1: 18.5, gap: 3, slant: 10, n: 8 };
/** The rail's path (points, their normals pointing under it, the length to each), worked out once. */
const RPATH = (() => {
    const P0 = [RP.x0, RP.y0], K = [RP.kx, RP.ky], E = [RP.x1, RP.ky];
    const cl = Math.hypot(K[0] - P0[0], K[1] - P0[1]), u = [(K[0] - P0[0]) / cl, (K[1] - P0[1]) / cl];
    const turn = Math.acos(u[0]), dk = RP.kr * Math.tan(turn / 2);
    const T1 = [K[0] - u[0] * dk, K[1] - u[1] * dk], C = [K[0] + dk, K[1] + RP.kr];
    const pts = [P0, T1];
    const a0 = Math.atan2(T1[1] - C[1], T1[0] - C[0]), a1 = -Math.PI / 2, N = 16;
    for (let i = 1; i <= N; i++) { const a = a0 + (a1 - a0) * i / N; pts.push([C[0] + RP.kr * Math.cos(a), C[1] + RP.kr * Math.sin(a)]); }
    pts.push(E);
    const len = [0];
    for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    // a segment's normal (-ty, tx) points under the rail; a point's is the mean of its segments'
    const segN = [];
    for (let i = 1; i < pts.length; i++) { const l = len[i] - len[i - 1]; segN.push([-(pts[i][1] - pts[i - 1][1]) / l, (pts[i][0] - pts[i - 1][0]) / l]); }
    const ptN = pts.map((p, i) => {
        const a = segN[Math.max(0, i - 1)], b = segN[Math.min(segN.length - 1, i)], m = Math.hypot(a[0] + b[0], a[1] + b[1]) || 1;
        return [(a[0] + b[0]) / m, (a[1] + b[1]) / m];
    });
    // knee: half way round the bend (the meter's zero)
    return { pts: pts, len: len, segN: segN, ptN: ptN, all: len[len.length - 1], knee: (len[1] + len[N + 1]) / 2 };
})();
const rS = (rpm, max) => clamp(rpm / max, 0, 1) * RPATH.all;
/** The point s px along the rail and the normal there: [x, y, nx, ny]. */
function rAtS(s) {
    const L = RPATH.len;
    let i = 1;
    while (i < L.length - 1 && L[i] < s) i++;
    const a = RPATH.pts[i - 1], b = RPATH.pts[i], k = clamp((s - L[i - 1]) / ((L[i] - L[i - 1]) || 1), 0, 1), n = RPATH.segN[i - 1];
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, n[0], n[1]];
}
const off = (p, d) => [p[0] + p[2] * d, p[1] + p[3] * d];
/** The strip between d0 and d1 px under the rail from s0 to s1 px along it, as quads (bent round the knee). */
function rStrip(cv, s0, s1, d0, d1, c) {
    if (s1 - s0 < 0.3) return;
    const pts = [rAtS(s0)];
    RPATH.len.forEach((l, i) => { if (l > s0 + 0.01 && l < s1 - 0.01) { const p = RPATH.pts[i], n = RPATH.ptN[i]; pts.push([p[0], p[1], n[0], n[1]]); } });
    pts.push(rAtS(s1));
    // (each quad reaches 0.4 px past an inner joint into the next: no hairline seams fanning round the knee)
    const ext = (p, q, k) => { const dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy) || 1; return [p[0] + dx / l * k, p[1] + dy / l * k, p[2], p[3]]; };
    for (let i = 1; i < pts.length; i++) {
        const a = i > 1 ? ext(pts[i - 1], pts[i], -0.4) : pts[i - 1], b = i < pts.length - 1 ? ext(pts[i], pts[i - 1], -0.4) : pts[i];
        cv.quad([off(a, d0), off(b, d0), off(b, d1), off(a, d1)], c);
    }
}
/** A short stroke across the band at s (from d0 to d1 px under the rail). */
function rTick(cv, s, d0, d1, w, c) { const p = rAtS(s), a = off(p, d0), b = off(p, d1); cv.line(a[0], a[1], b[0], b[1], w, c); }
/*
 * The rail and band as on the G80's glass: a solid rail along the top; at every 1,000 rpm (and at each end) a small
 * rounded tab hangs from it (straight sides, a round bottom, soft shoulders); under it a hairline gap, then the band
 * (the revs). The gap runs round each tab and on down to the band's bottom as the split, so the dark line reads as a
 * U with a stem under it. At the numbered marks (0, 2, 4, 6, 8) a small V is cut into the rail's top over the tab (the
 * hollow); the 1,000s between have no V and a slightly narrower tab.
 * RD: the rail's thickness; the tab's half-width (numbered, between), bottom corners' radius, depth under the rail and
 * shoulder radius;
 * the V's half-width and depth; the gap; the split's half-width.
 */
const RD = { rt: 3.4, uw: 2.7, uwOdd: 2.1, rb: 1.5, td: 4.8, rf: 0.3, vw: 1.5, vd: 3.0, endVw: 2.2, endVd: 5.0, endIn: 3.6, gap: 1.0, split: 0.55 };
const RW = RD.uw + RD.rf;     // a numbered tab's half-width with its shoulders (the widest)
/** The marks along the rail: { s (px), big (numbered: a V and the wider tab) }, one every 1,000 rpm and one at each end. */
function rMarks(max) {
    // (the ends' marks far enough in that the cup's outer arm keeps some weight)
    const lab = max <= 9000 ? 2000 : 3000, m = [{ s: RD.endIn, big: true, end: true }];
    for (let r = 1000; r < max; r += 1000) m.push({ s: rS(r, max), big: r % lab === 0 });
    m.push({ s: RPATH.all - RD.endIn, big: true, end: true });
    return m;
}
/** A mark's tab half-width (to its walls): the ends' reach flush to the rail's end, the numbered ones wider than the rest. */
const uwOf = (m) => (m.end ? RD.endIn : m.big ? RD.uw : RD.uwOdd);
const reachOf = (m) => uwOf(m) + RD.rf;
/** How far mark m's tab reaches under the rail at t px from its middle: the round bottom, the straight sides, the shoulders. */
function rTab(t, m) {
    const a = Math.abs(t), uw = uwOf(m), w = uw + RD.rf;
    if (a <= uw - RD.rb) return RD.td;
    if (a <= uw) { const k = a - (uw - RD.rb); return RD.td - RD.rb + Math.sqrt(RD.rb * RD.rb - k * k); }
    if (a < w) return RD.rf - Math.sqrt(Math.max(0, RD.rf * RD.rf - (w - a) * (w - a)));
    return 0;
}
/** The V cut into the rail's top at t px from a numbered mark's middle (0 beyond it). */
// (soft: a cosine dip; at the ends a deep cup cut down through the tab, so the line ends in an open V / U)
const rVee = (t, m) => { const w = m.end ? RD.endVw : RD.vw, d = m.end ? RD.endVd : RD.vd; return Math.abs(t) < w ? d * (1 + Math.cos(Math.PI * t / w)) / 2 : 0; };
/** The tabs grown by the gap: where the band's top must stay (px under the rail's bottom) at s. */
function rTabGap(ms, s) {
    let best = 0;
    ms.forEach((m) => {
        if (Math.abs(s - m.s) > reachOf(m) + RD.gap) return;
        for (let k = -4; k <= 4; k++) { const du = RD.gap * k / 4; best = Math.max(best, rTab(s - m.s + du, m) + Math.sqrt(RD.gap * RD.gap - du * du) - RD.gap); }
    });
    return best;
}
/** The points s0..s1 along the rail to draw through: its bends, and every 0.2 px across a tab. */
function rSamples(ms, s0, s1) {
    const ss = [s0, s1];
    RPATH.len.forEach((l) => { if (l > s0 && l < s1) ss.push(l); });
    ms.forEach((m) => {
        for (let v = Math.max(s0, m.s - reachOf(m) - RD.gap); v <= Math.min(s1, m.s + reachOf(m) + RD.gap); v += 0.2) ss.push(v);
        const uw = uwOf(m);
        [-uw - 0.02, -uw + 0.02, uw - 0.02, uw + 0.02].forEach((d) => { if (m.s + d > s0 && m.s + d < s1) ss.push(m.s + d); });
    });
    return ss.sort((p, q) => p - q).filter((v, i, a) => i === 0 || v - a[i - 1] > 0.05);
}
/** The point d px under the rail at s, with the path's own normal at its bends (a smooth offset round the knee). */
function rPt(v, d) {
    const i = RPATH.len.findIndex((l) => Math.abs(l - v) < 1e-6);
    if (i < 0) return off(rAtS(v), d);
    const p = RPATH.pts[i], n = RPATH.ptN[i];
    return [p[0] + n[0] * d, p[1] + n[1] * d];
}
/**
 * The shape between d0(s) and d1(s) for the samples ss, as ONE polygon (canvas fill): pieces drawn side by side
 * left hairline seams, and where they met a gap, a faint line across it. Quads where a canvas has no fill.
 */
function rShape(cv, ss, d0, d1, c) {
    // (rNPt: the normal turns smoothly round the knee, so the rail, tabs and band end step nowhere as it bends)
    const top = ss.map((v) => rNPt(v, Math.min(d0(v), d1(v) - 0.05))), bot = ss.map((v) => rNPt(v, d1(v)));
    if (cv.fill) { cv.fill(top.concat(bot.reverse()), c, true); return; }
    for (let k = 1; k < ss.length; k++) cv.quad([top[k - 1], top[k], bot[ss.length - k - 1], bot[ss.length - k]], c);
}
const veeAt = (ms) => { const big = ms.filter((m) => m.big); return (v) => big.reduce((a, m) => Math.max(a, rVee(v - m.s, m)), 0); };
function rRail(cv, max, c) {
    const ms = rMarks(max), vee = veeAt(ms);
    // the rail with its tabs, one shape: its top cut into a V at the numbered marks (a cup at the ends), its bottom
    // hanging into a tab at every mark
    const tab = (v) => ms.reduce((a, m) => Math.max(a, rTab(v - m.s, m)), 0);
    rShape(cv, rSamples(ms, 0, RPATH.all), vee, (v) => RD.rt + tab(v), c);
}
/*
 * The needle from s0 to s1 (2.0.35): the band's own shape (one piece: not split at a mark's middle, see rNeedle), down
 * to the band's bottom, its top the band's top (rTabGap: the tab grown by the gap, the same rounded corner, the same depth under the
 * tab, full height right up to where the band's corner rounds off; no early dip). One guard so it never leaves a sliver:
 * a morphological opening by a NEEDLE_OPEN px wide flat bar (or the piece's own width, if narrower) along the rail
 * (erode, then dilate): a full-height part narrower than that, a hair beside a tab's wall, is trimmed down to the band's
 * curve under it. The curve is fixed to the rail (a grid at whole multiples
 * of NEEDLE_H), so as the revs move the needle slides along it and only its ends change. Its outline is offset along a
 * normal that turns smoothly round the knee (rNPt), so it doesn't fold where the knee's polygon bends.
 */
const NEEDLE_OPEN = 1, NEEDLE_STEPS = 8, NEEDLE_H = 0.05;
// the knee's normals at its vertices: radial inside the arc, the climb's and the flat's at its two ends
const RVN = RPATH.pts.map((p, i) => (i === 1 ? RPATH.segN[0] : i === RPATH.pts.length - 2 ? RPATH.segN[RPATH.segN.length - 1] : RPATH.ptN[i]));
/** The point d px under the rail at s, its normal blended along each of the knee's segments (no seam at its bends). */
function rNPt(s, d) {
    const L = RPATH.len, last = L.length - 1;
    let i = 1;
    while (i < last && L[i] < s) i++;
    const a = RPATH.pts[i - 1], b = RPATH.pts[i], k = clamp((s - L[i - 1]) / ((L[i] - L[i - 1]) || 1), 0, 1);
    let n = RPATH.segN[i - 1];
    if (i > 1 && i < last) { const p = RVN[i - 1], q = RVN[i], x = p[0] + (q[0] - p[0]) * k, y = p[1] + (q[1] - p[1]) * k, m = Math.hypot(x, y); n = [x / m, y / m]; }
    return [a[0] + (b[0] - a[0]) * k + n[0] * d, a[1] + (b[1] - a[1]) * k + n[1] * d];
}
function rNeedle(cv, s0, s1, max, c) {
    // one piece, over a mark's middle too: split there as the band is, the two halves (~0.6 px each) all but vanished
    // at 1x as the revs crossed it. Clear of the end marks' tabs as the band is
    const all = rMarks(max), pcs = [];
    const a = Math.max(s0, all[0].s + reachOf(all[0]) + RD.gap), b = Math.min(s1, all[all.length - 1].s - reachOf(all[all.length - 1]) - RD.gap);
    if (b - a > 0.01) pcs.push([a, b]);
    // (the trim's width never more than the widest piece: with the split in the middle, two thin halves both stay)
    const open = Math.min(NEEDLE_OPEN, pcs.reduce((w, p) => Math.max(w, p[1] - p[0]), 0));
    pcs.forEach((p) => rNeedlePiece(cv, all, p[0], p[1], open, c));
}
function rNeedlePiece(cv, all, s0, s1, open, c) {
    const ms = all.filter((m) => Math.abs(m.s - (s0 + s1) / 2) < reachOf(m) + RD.gap + 4);
    const D1 = RP.rt + RP.ft, base = RD.rt + RD.gap, h = NEEDLE_H;
    // the band's clearance at u (on the grid, linear between)
    const i0 = Math.floor(s0 / h), n = Math.ceil(s1 / h) - i0 + 1, g = new Float64Array(n);
    if (ms.length) for (let i = 0; i < n; i++) g[i] = rTabGap(ms, (i0 + i) * h);
    const P = (u) => { const x = u / h - i0, i = clamp(Math.floor(x), 0, n - 2), k = x - i; return g[i] + (g[i + 1] - g[i]) * k; };
    // the grid points strictly inside (a, b)
    const inside = (a, b) => { const o = []; for (let i = Math.floor(a / h) + 1; i * h < b - 1e-9; i++) o.push(i * h); return o; };
    if (s1 - s0 < open / NEEDLE_STEPS) return;
    const ss = [s0].concat(inside(s0, s1), [s1]), d = ss.map(() => 0);
    // the opening by a bar L wide: erode (the deepest top under the bar, wherever it sits inside the piece), then
    // dilate (at each point the shallowest of the bars covering it). Averaged over NEEDLE_STEPS widths up to
    // NEEDLE_OPEN, so a hair is trimmed in step with its width (a w px wide part keeps w / NEEDLE_OPEN of its extra
    // height) rather than all at once: no jump as it narrows.
    for (let st = 1; st <= NEEDLE_STEPS; st++) {
        // (a bar wider than the piece fits nowhere: the opening leaves none of it, so a piece narrower than
        // NEEDLE_OPEN, a hair beside a mark's split, is only w / NEEDLE_OPEN of its height and grows as it widens)
        const L = open * st / NEEDLE_STEPS;
        if (L > s1 - s0 + 1e-9) { ss.forEach((v, j) => { d[j] += (D1 - base) / NEEDLE_STEPS; }); continue; }
        const bars = [s0].concat(inside(s0, s1 - L), [s1 - L]).map((a) => {
            let e = Math.max(P(a), P(a + L));
            inside(a, a + L).forEach((u) => { e = Math.max(e, P(u)); });
            return [a, e];
        });
        ss.forEach((v, j) => {
            let t = Infinity;
            bars.forEach((b) => { if (b[0] <= v + 1e-9 && v <= b[0] + L + 1e-9) t = Math.min(t, b[1]); });
            d[j] += (t === Infinity ? P(v) : t) / NEEDLE_STEPS;
        });
    }
    const tp = ss.map((v, j) => rNPt(v, Math.min(D1, base + d[j]))), bt = ss.map((v) => rNPt(v, D1));
    if (cv.fill) { cv.fill(tp.concat(bt.reverse()), c, true); return; }
    for (let k = 1; k < ss.length; k++) cv.quad([tp[k - 1], tp[k], bt[ss.length - k - 1], bt[ss.length - k]], c);
}
/**
 * The band from s0 to s1 (the revs), split at each mark; its top keeps the gap to the rail
 * and round each tab, so nothing drawn with it touches the rail or a tab.
 */
function rBand(cv, s0, s1, max, c) {
    const ms = rMarks(max), D1 = RP.rt + RP.ft, top = (v) => Math.min(D1, RD.rt + RD.gap + rTabGap(ms, v));
    for (let i = 0; i < ms.length - 1; i++) {
        // (the ends' tabs: the band starts and stops clear of them)
        const a = Math.max(s0, i === 0 ? ms[0].s + reachOf(ms[0]) + RD.gap : ms[i].s + RD.split);
        const b = Math.min(s1, i === ms.length - 2 ? ms[i + 1].s - reachOf(ms[i + 1]) - RD.gap : ms[i + 1].s - RD.split);
        // (b is clear of the end cup's tab as it was of its old place)
        if (b > a) rShape(cv, rSamples(ms, a, b), top, () => D1, c);
    }
}

/*
 * Squared digits (our own drawing, after the G80's look): 7-segment strokes joined at the corners, solid, plus
 * N P R D M S. h tall, a width of 0.6 h, the stroke t. Returns false (drawing nothing) for a character it has no
 * shape for.
 */
const SQ = { 0: 'abcdef', 2: 'abged', 3: 'abgcd', 4: 'g', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abfgcd', '-': 'g', S: 'afgcd', P: 'abfge', N: 'efbc', R: 'abfge', M: 'efabc', D: 'abcdef' };
/** A character's width at h: wide (the G80's digits are about 1.2 times as wide as tall); a 1 and a dot narrow. */
const sqAdv = (ch, h) => (ch === '.' ? sqT(h) : ch === '1' ? h * 0.55 : h * 1.15);
const sqT = (h) => Math.max(1.9, h * 0.25);
function sqGlyph(cv, ch, x, y, h, c) {
    const w = sqAdv(ch, h), t = sqT(h), hh = h / 2;
    if (ch === '1') { cv.fillRect(x + w - t, y, t, h, c); cv.fillRect(x + w * 0.15, y, w * 0.85, t, c); return true; }
    const on = SQ[ch];
    if (on === undefined) return false;
    const R = {
        a: [x, y, w, t], g: [x, y + hh - t / 2, w, t], d: [x, y + h - t, w, t],
        f: [x, y, t, hh + t / 2], b: [x + w - t, y, t, hh + t / 2], e: [x, y + hh - t / 2, t, hh + t / 2], c: [x + w - t, y + hh - t / 2, t, hh + t / 2],
    };
    // D: the right-hand corners cut, so it isn't a 0
    if (ch === 'D') { R.a = [x, y, w - t, t]; R.d = [x, y + h - t, w - t, t]; R.b = [x + w - t, y + t, t, hh]; R.c = [x + w - t, y + hh - t / 2, t, hh - t / 2]; }
    for (const k of on) { const r = R[k]; cv.fillRect(r[0], r[1], r[2], r[3], c); }
    if (ch === 'D') {
        cv.quad([[x + w - t, y], [x + w, y + t], [x + w - t, y + t]], c); cv.quad([[x + w - t, y + h - t], [x + w, y + h - t], [x + w - t, y + h]], c);
    }
    // N, R: a diagonal; M: a stem down the middle
    const diag = (x0, y0, x1, y1) => cv.quad([[x0, y0], [x0 + t * 1.1, y0], [x1, y1], [x1 - t * 1.1, y1]], c);
    if (ch === 'N') diag(x + t * 0.4, y, x + w - t * 0.4, y + h);
    if (ch === 'R') diag(x + w * 0.35, y + hh, x + w + t * 0.45, y + h);
    if (ch === 'M') cv.fillRect(x + w / 2 - t / 2, y, t, hh, c);
    // 4: a slant from the right stem's top down to the bar's left end (the G80's closed 4)
    if (ch === '4') {
        const sx = x + w * 0.8 - t;     // the stem, with the bar running past it
        cv.fillRect(sx, y, t, h, c);
        cv.quad([[sx - t * 0.9, y], [sx + t * 0.6, y], [x + t * 1.6, y + hh - t / 2], [x, y + hh - t / 2]], c);
    }
    return true;
}
const SQ_GAP = 0.22;
/** The width sqText takes for str at h. */
const sqWidth = (str, h) => { str = String(str); let w = 0; for (const ch of str) w += sqAdv(ch, h); return str.length ? w + (str.length - 1) * h * SQ_GAP : 0; };
/**
 * str in squared digits, top at y, h tall, from x (align 'left' | 'center' | 'right'). Characters it has no shape
 * for end it: the rest is drawn in the bold font (a unit such as °).
 */
function sqText(cv, str, x, y, h, c, align) {
    str = String(str);
    let n = 0;
    while (n < str.length && (str[n] === '.' || str[n] === '1' || SQ[str[n]] !== undefined)) n++;
    const head = str.slice(0, n), tail = str.slice(n).trim();
    const tailW = tail && cv.textWidth ? cv.textWidth(tail, h * 0.6, { font: 'bold' }) + 2 : 0;
    const wAll = sqWidth(head, h) + tailW;
    let px = align === 'center' ? x - wAll / 2 : align === 'right' ? x - wAll : x;
    for (const ch of head) {
        if (ch === '.') cv.fillRect(px, y + h - sqT(h), sqT(h), sqT(h), c); else sqGlyph(cv, ch, px, y, h, c);
        px += sqAdv(ch, h) + h * SQ_GAP;
    }
    if (tail) cv.text(tail, px - h * SQ_GAP + 2, y + h * 0.6, h * 0.6, c, { font: 'bold' });
}

/*
 * The ramp's Recovery / Power meter (a readout with .bar, hud.js): not in the list but a thin strip under the band,
 * the rail's shape (2026-11-10, a 330e owner's sketch: like BMW's hybrid power meter). Zero at the knee; recovery
 * fills down the climb towards 0, power along the flat towards the end (yellow from 85 % of bar.hi). Track bg, fill fg.
 */
// 3 px, a 3 px gap under the band (closer it read as a second rev band)
const RM = { d0: RP.rt + RP.ft + 3, d1: RP.rt + RP.ft + 6, start: 0.14 };
function rampMeter(cv, bar, P, layer, max) {
    const zero = RPATH.knee, s0 = zero * RM.start, end = RPATH.all;
    if (layer !== 'fg') {
        rStrip(cv, s0, end, RM.d0, RM.d1, withAlpha(RC.line, 0.25));
        // the zero: a short mark across the strip at the knee
        rTick(cv, zero, RM.d0 - 1.5, RM.d1 + 1.5, 1.6, RC.line);
    }
    if (layer === 'bg' || !isNum(bar.v)) return;
    const lo = isNum(bar.lo) && bar.lo < 0 ? bar.lo : -1, hi = isNum(bar.hi) && bar.hi > 0 ? bar.hi : 1;
    if (bar.v < 0) { const k = clamp(bar.v / lo, 0, 1); if (k > 0.01) rStrip(cv, zero - (zero - s0) * k, zero, RM.d0, RM.d1, P.low); }
    else if (bar.v > 0) { const k = clamp(bar.v / hi, 0, 1); if (k > 0.01) rStrip(cv, zero, zero + (end - zero) * k, RM.d0, RM.d1, bar.v >= 0.85 * hi ? RC.yellow : RC.fill); }
}
/** The 8 bars' corners (bottom left first); the last twice as wide. */
const rBars = (() => {
    const unit = (RL.x1 - RL.x0 - RL.slant - (RL.n - 1) * RL.gap) / (RL.n + 1), out = [];
    let x = RL.x0;
    for (let i = 0; i < RL.n; i++) {
        const w = i === RL.n - 1 ? 2 * unit : unit;
        out.push([[x, RL.y1], [x + w, RL.y1], [x + w + RL.slant, RL.y0], [x + RL.slant, RL.y0]]);
        x += w + RL.gap;
    }
    return out;
})();
function drawRamp(cv, f, layer, h) {
    const o = f.opts, d = f.d, cue = f.cue, BG = layer !== 'fg', fg = layer !== 'bg', max = f.max;
    const fl = flashOn(o, cue), flashCol = flashColour(o, cue, h, RC.red);
    const meter = (f.readouts || []).filter((it) => it.bar)[0];
    // with the meter under the band, the scale and everything under it 5 px lower
    const dn = meter ? 5 : 0, sq = o.gearFont === 'square';
    const D0 = RP.rt, D1 = RP.rt + RP.ft;
    // the gauge: Rev bar off leaves the lights and the gear (the lights are their own row since 2.0.21)
    if (o.bar !== false) {
        if (BG) {
            // the rail with its tabs, V's and end cups; under it nothing until the revs reach it (clear, as on the G80)
            rRail(cv, max, RC.line);
            // the scale under the band; the 0 under the climb's start
            const lab = max <= 9000 ? 2000 : 3000;
            for (let r = 0; r <= max; r += lab) {
                const p = rAtS(rS(r, max)), x = r === 0 ? p[0] : p[0], y = r === 0 ? p[1] + 8 + dn : RP.ky + D1 + 4 + dn;
                sqText(cv, String(r / 1000), x, y, 10, RC.text, 'center');
            }
        }
        if (fg && isNum(d.rpm) && d.rpm > 50) {
            // the rpm: the band under the rail, split at the notches, a red sliver at its end
            const top = Math.min(d.rpm, max), st = rS(top, max);
            const pop = burstOn(f.chip, 300) ? chipCol(f.chip, h.P) : null, c = pop || RC.fill;
            // the needle: a red bar the band's own height, a dark hair's gap after the band's end (as on the G80)
            const NW = 2.4, NG = 1.0;
            rBand(cv, 0, st - NW - NG, max, c);
            if (st > NW) rNeedle(cv, st - NW, st, max, RC.red);
        }
        if (fg) {
            // the red zone: a yellow dash and dot (the warning), then a thin red line from the redline on into the 8's cup.
            // Drawn only ahead of the needle (the live layer: what the revs have passed is the band's, and nothing peeks
            // through the gap between band and needle), and clear of each tab as the band is, so it reads as running under
            // the marks
            const zs = rS(f.redline, max), zm = D0 + 2, from = isNum(d.rpm) && d.rpm > 50 ? rS(Math.min(d.rpm, max), max) + 0.8 : -Infinity;
            // (the 8's end cup: the line runs right up to its wall, touching it, never over the white)
            const tabs = rMarks(max);
            const seg = (a, b, col) => {
                let v = Math.max(a, from);
                const zOf = (m) => (m.end ? uwOf(m) : reachOf(m) + RD.gap);
                tabs.filter((m) => m.s + zOf(m) > v && m.s - zOf(m) < b).forEach((m) => {
                    const z = zOf(m);
                    if (m.s - z > v) rStrip(cv, v, m.s - z, zm - 0.8, zm + 0.8, col);
                    v = Math.max(v, m.s + z);
                });
                if (b > v) rStrip(cv, v, b, zm - 0.8, zm + 0.8, col);
            };
            if (zs < RPATH.all - 6) {
                seg(zs + 3, RPATH.all, RC.red);
                seg(zs - 12, zs - 6, RC.yellow);
                seg(zs - 3.5, zs - 1.5, RC.yellow);
            }
        }
        if (fg && isNum(f.peak) && f.peak > 0 && !(isNum(d.rpm) && d.rpm >= f.peak - 50)) rTick(cv, rS(Math.min(f.peak, max), max), D0, D1, 2.2, '#ffffff');
    }
    // the shift lights: hidden until the count-in, then lit left to right; unlit ones as outlines (Unlit: Dim)
    if (fg && ((o.lights && isNum(d.rpm) && (d.rpm >= cue.from || cue.shift)) || cue.limiter)) {
        const k = isNum(d.rpm) ? clamp((d.rpm - cue.from) / Math.max(1, cue.at - cue.from), 0, 1) : 0;
        const lit = fl ? (f.blink ? RL.n : 0) : Math.max(1, Math.ceil(k * RL.n));
        rBars.forEach((q, i) => {
            const red = i >= RL.n - 2;
            if (i < lit) {
                const c = fl ? flashCol : !ownColours(o) ? (red ? RC.red : RC.yellow) : h.lightCol(o.lightStyle, h.P, i / (RL.n - 1));
                cv.quad(q, c);
            } else if (o.dim) cv.polyline(q.concat([q[0]]), 1, red ? withAlpha(RC.red, 0.6) : withAlpha(RC.line, 0.5));
        });
    }
    if (meter) rampMeter(cv, meter.bar, h.P, layer, max);
    if (!fg) return;
    // the gear's foot level with the 0's (the 0 is 8 px under the climb's start, 10 tall), the line under it, then the
    // first readout under the line. Any gear font sits on that foot (a text font on its baseline), so none touches the line
    const gx = 113, foot = RP.y0 + 18 + dn, gy = foot - 27, ln = foot + 5, items = (f.readouts || []).filter((it) => !it.bar);
    if (f.chip) ring(cv, gx, gy + 16, 20, 50, f.chip, h.P);
    // readouts 2-4: a list on the right, label left and value right
    [1, 2, 3].forEach((i, k) => { if (items[i]) small(cv, 262, 68 + dn + k * 21, items[i], h.P, o, RC.text, 'row', 132); });
    const gearC = cue.limiter && f.blink ? RC.red : RC.text;
    if (o.gear) {
        if (sq) sqText(cv, h.gearText(d), gx, gy, 27, gearC, 'center');
        else cv.text(h.gearText(d), gx, foot, 42, gearC, { align: 'center', font: h.gearFont(o) });
    }
    if (f.mode && o.gear) cv.text(f.mode, gx + 22, gy + 11, 14, withAlpha(RC.text, 0.85), { font: 'bold' });
    // the line parts the gear from what's under it: only with both (Gear off, or nothing under it: no line)
    if (o.gear && (f.chip || items[0])) cv.fillRect(gx - 50, ln, 84, 1.6, RC.text);
    h.drawDown(cv, gx + 58, gy + 6, f.down || 0, 1, h.P.arrow);
    if (f.chip) grade(cv, gx, ln + 25, f.chip, h.P, 22);
    else {
        const it = items[0];
        if (it) {
            const vc = toneCol(it, h.P, RC.text);
            if (sq) sqText(cv, it.value, gx - 8, ln + 6, 19, vc, 'center');
            else cv.text(it.value, gx - 8, ln + 25, 22, vc, { align: 'center', font: o.valFont || 'bold' });
            fitLabel(cv, it.label.toLowerCase(), gx + 37, ln + 4, labelOf(o, RC.text).s, RC.text, 262 - gx - 40, { spacing: 0 });
        }
    }
}

/* ---------- dial (E60) ---------- */
const D = { cx: 200, cy: 70, r0: 50, r1: 60, a0: -125, a1: 110 };
// the power meter: a 6 px ring round the dial (r1) with a gap, up to the image's top edge
const DM = { r0: 64, r1: 70 };
const DC = { green: '#a6d64a', orange: '#ff8a2e', red: '#f0313a', text: '#ff8a2e', speed: '#ff5a2e' };
function drawDial(cv, f, layer, h) {
    const o = f.opts, d = f.d, cue = f.cue, BG = layer !== 'fg', fg = layer !== 'bg', max = f.max, fl = flashOn(o, cue);
    const flashCol = flashColour(o, cue, h, DC.red);
    const ang = (r) => D.a0 + (D.a1 - D.a0) * clamp(r / max, 0, 1);
    // the E60's advance warning field: the last 1000 rpm before the redline (fixed, so the cached static
    // layer stays right; the count-in itself is the shift cue's flash)
    const warn = Math.max(0, f.redline - 1000);
    // the zones in the E60's colours, or the app's light style's: Race green / red / blue, one colour throughout
    const Z = o.lightStyle === 'f1' ? [h.P.low, h.P.high, h.RACE_BLUE] : o.lightStyle === 'mono' ? [h.P.text, h.P.text, h.P.text] : [DC.green, DC.orange, DC.red];
    const zone = (r) => (r >= f.redline ? Z[2] : r >= warn ? Z[1] : Z[0]);
    const step = 250, meter = (f.readouts || []).filter((it) => it.bar)[0];
    if (o.bar !== false || o.lights) {
        if (BG) for (let r = 0; r < max; r += step) {
            // the zones always faintly there; a hairline gap every 1000 rpm
            const g = (r + step) % 1000 === 0 ? 0.9 : 0;
            cv.arc(D.cx, D.cy, D.r0, D.r1, ang(r), ang(r + step) - g, withAlpha(zone(r), o.dim ? 0.22 : r >= warn ? 0.22 : 0));
        }
        if (fg && isNum(d.rpm) && d.rpm > 50) {
            const top = Math.min(d.rpm, max);
            // burst: the lit dial flashes the grade's colour for 300 ms
            const pop = burstOn(f.chip, 300) ? chipCol(f.chip, h.P) : null;
            for (let r = 0; r < top; r += step) {
                const c = fl ? (f.blink ? flashCol : null) : pop || zone(r);
                const g = (r + step) % 1000 === 0 ? 0.9 : 0;
                if (c) cv.arc(D.cx, D.cy, D.r0, D.r1, ang(r), ang(Math.min(top, r + step)) - (r + step <= top ? g : 0), c);
            }
        }
        // (with the meter round the dial, the peak stops short of it)
        if (fg && isNum(f.peak) && f.peak > 0 && !(isNum(d.rpm) && d.rpm >= f.peak - 50)) cv.arc(D.cx, D.cy, D.r0 - 3, meter ? D.r1 : D.r1 + 3, ang(f.peak) - 0.8, ang(f.peak) + 0.8, '#ffffff');
    }
    // the power meter: a ring round the dial over its sweep (not in the list)
    if (meter) ringMeter(cv, D.cx, D.cy, DM.r0, DM.r1, D.a0, D.a1, DM.r0, DM.r1 + 3, meter.bar,
        { line: withAlpha(DC.text, 0.6), tick: DC.text, low: h.P.low, fill: DC.orange, warm: DC.red }, layer);
    if (!fg) return;
    const items = (f.readouts || []).filter((it) => !it.bar);
    if (f.chip) ring(cv, D.cx, D.cy, D.r1 + 2, D.r1 + 34, f.chip, h.P);
    // readouts 2 and 3: a list on the right; 4: top left (kept high, clear of BMW's assistance graphic)
    [1, 2].forEach((i, k) => { if (items[i]) small(cv, 284, 30 + k * 28, items[i], h.P, o, DC.speed, 'row', 112); });
    if (items[3]) small(cv, 70, 30, items[3], h.P, o, DC.speed, 'stack', 'center');
    if (o.gear) cv.text(h.gearText(d), D.cx, D.cy + 20, 56, cue.limiter && f.blink ? DC.red : DC.text, { align: 'center', font: h.gearFont(o) });
    if (f.mode && o.gear) cv.text(f.mode, D.cx + 24, D.cy - 14, 14, withAlpha(DC.text, 0.85), { font: 'bold' });
    h.drawDown(cv, D.cx, D.cy + 30, f.down || 0, 0.9, h.P.arrow);
    // bottom right, where the E60 shows the speed: the first readout, or the shift grade
    if (f.chip) grade(cv, 330, 122, f.chip, h.P, 22);
    else {
        const it = items[0];
        if (it) {
            cv.text(it.value, 300, 122, 26, toneCol(it, h.P, DC.speed), { align: 'right', font: o.valFont || 'bold' });
            fitLabel(cv, it.label.toLowerCase(), 304, 122, labelOf(o, DC.speed).s, DC.speed, 94, { spacing: 0 });
        }
    }
}

/* ---------- pill (a sim-racing telemetry overlay's look) ---------- */
/*
 * One rounded panel across the picture: at its left the gear in a ring that fills round with the revs (the low
 * colour, the mid colour through the count-in, red at the shift point), shift lights as a row of small dots
 * along its top, and up to three readouts as a small label over big 7-segment digits. Through the count-in the panel
 * reddens; from the shift point and on the limiter it flashes (bright red alone, then grey with the ring and dots
 * red), back to grey after the upshift (2026-11-10, from the user's video). The power meter runs along the panel's bottom (not in the list).
 */
// (the dots and the readouts stop where the panel's rounded right end starts closing in)
const PL = { x: 4, y: 20, w: 392, h: 100, gx: 54, gy: 70, r0: 33, r1: 41, dx0: 112, dx1: 352, dy: 34, rad: 4.2,
    vx: 112, slots: [0, 96, 180], room: [90, 78, 78], ly: 58, vy: 64, vh: 28, cw: 14, ct: 3.6, cg: 4, mx0: 112, mx1: 352, my: 106, mh: 5 };
const PC = { panel: '#2e3238', red: '#d42a26', ring: '#ffffff' };
/** Colour a..b at k (0..1), both '#rrggbb'. */
function mixHex(a, b, k) {
    const c = (x, i) => parseInt(x.slice(1 + 2 * i, 3 + 2 * i), 16), t = clamp(k, 0, 1);
    return '#' + [0, 1, 2].map((i) => ('0' + Math.round(c(a, i) + (c(b, i) - c(a, i)) * t).toString(16)).slice(-2)).join('');
}
/** A readout's value as 7-segment digits (with a decimal point) from x, a suffix such as ° or % after it as text. */
function segValue(cv, str, x, y, c, h) {
    const m = /^(-?[0-9][0-9.]*)(.*)$/.exec(String(str));
    if (!m) { cv.text(String(str), x, y + PL.vh, 26, c, { font: 'bold' }); return; }
    let px = x;
    for (const ch of m[1]) {
        if (ch === '.') { cv.fillRect(px - 1, y + PL.vh - PL.ct, PL.ct, PL.ct, c); px += PL.ct + PL.cg - 1; continue; }
        h.seg7(cv, ch, px, y, PL.cw, PL.vh, PL.ct, c, null, false, 'fg');
        px += PL.cw + PL.cg;
    }
    if (m[2]) cv.text(m[2].trim(), px, y + 13, 14, c, { font: 'bold' });
}
/** The power meter along the panel's bottom: a centre-zero track, recovery left in the low colour, drive right. */
function pillMeter(cv, bar, P, layer) {
    const lo = isNum(bar.lo) && bar.lo < 0 ? bar.lo : -1, hi = isNum(bar.hi) && bar.hi > 0 ? bar.hi : 1;
    const X = (v) => PL.mx0 + (PL.mx1 - PL.mx0) * clamp((v - lo) / (hi - lo), 0, 1), z = X(0);
    if (layer !== 'fg') {
        cv.roundRect(PL.mx0, PL.my, PL.mx1 - PL.mx0, PL.mh, PL.mh / 2, withAlpha(P.text, 0.16));
        cv.fillRect(z - 1, PL.my - 2, 2, PL.mh + 4, P.text);
    }
    if (layer === 'bg' || !isNum(bar.v)) return;
    const vx = X(bar.v);
    if (vx < z - 1.5) cv.roundRect(vx, PL.my, z - 1 - vx, PL.mh, PL.mh / 2, P.low);
    else if (vx > z + 1.5) cv.roundRect(z + 1, PL.my, vx - z - 1, PL.mh, PL.mh / 2, bar.v >= 0.85 * hi ? P.warm || P.mid : P.text);
}
function drawPill(cv, f, layer, h) {
    // all of it on the moving layer: the panel's colour follows the revs (the static layer would cover nothing)
    if (layer === 'bg') return;
    const o = f.opts, d = f.d, cue = f.cue, P = h.P, fl = flashOn(o, cue);
    const flashCol = cue.limiter ? P.limit : o.lightStyle === 'f1' ? h.RACE_BLUE : P.limit;
    const meter = (f.readouts || []).filter((it) => it.bar)[0];
    // the count-in (shift lights on): the panel reddens from grey as the shift point nears. From the shift point and on
    // the limiter it flashes: solid bright red with no ring or dots, then grey with the ring and the dots in red
    const count = o.lights && isNum(d.rpm) ? clamp((d.rpm - cue.from) / Math.max(1, cue.at - cue.from), 0, 1) : 0;
    const solid = fl && f.blink;
    const panel = solid ? withAlpha(PC.red, 0.92) : fl ? withAlpha(PC.panel, 0.7) : withAlpha(mixHex(PC.panel, PC.red, count), 0.7 + 0.15 * count);
    cv.roundRect(PL.x, PL.y, PL.w, PL.h, PL.h / 2, panel);
    // the ring round the gear: a faint track, filled round from the top with the revs to the redline
    // (the light style's first colour, its middle one through the count-in, the flash's at the shift point)
    const ringCol = fl ? flashCol : isNum(d.rpm) && d.rpm >= cue.from ? h.lightCol(o.lightStyle, P, 0.5) : h.lightCol(o.lightStyle, P, 0);
    if (o.bar !== false && !solid) {
        cv.arc(PL.gx, PL.gy, PL.r0, PL.r1, 0, 360, withAlpha(PC.ring, o.dim ? 0.18 : 0.1));
        if (isNum(d.rpm) && d.rpm > 50) {
            const a = 360 * clamp(d.rpm / Math.max(1, f.redline), 0, 1);
            const pop = burstOn(f.chip, 300) ? chipCol(f.chip, P) : null;
            if (a > 0.5) cv.arc(PL.gx, PL.gy, PL.r0, PL.r1, 0, a, fl ? flashCol : pop || ringCol, { round: true });
        }
        if (isNum(f.peak) && f.peak > 0 && !(isNum(d.rpm) && d.rpm >= f.peak - 50)) {
            const pa = 360 * clamp(f.peak / Math.max(1, f.redline), 0, 1);
            cv.arc(PL.gx, PL.gy, PL.r0 - 2, PL.r1 + 2, pa - 1.5, pa + 1.5, '#ffffff');
        }
    }
    // the shift lights: small dots along the top, in the app's light fill (GT3 or left to right) and colours; in the
    // flash's grey half all in the flash colour, in its red half none
    if (o.lights && !solid) {
        const n = 14, pts = [], pitch = (PL.dx1 - PL.dx0) / (n - 1);
        for (let i = 0; i < n; i++) pts.push([PL.dx0 + i * pitch, PL.dy]);
        h.drawLights(cv, pts, pts.map((p, i) => (o.gt3 ? Math.min(i, n - 1 - i) : i)), o.gt3 ? n / 2 : n, PL.rad,
            { rpm: d.rpm, cue: cue, blink: true, dim: o.dim, style: o.lightStyle, P: P, layer: 'both' });
    }
    if (meter) pillMeter(cv, meter.bar, P, 'both');
    if (f.chip) ring(cv, PL.gx, PL.gy, PL.r1 + 2, PL.r1 + 30, f.chip, P);
    // (white throughout: the panel itself flashes red)
    if (o.gear) cv.text(h.gearText(d), PL.gx, PL.gy + 15, 52, P.text, { align: 'center', font: h.gearFont(o) });
    // the gearbox mode under the ring's right side, clear of the dots
    if (f.mode && o.gear) cv.text(f.mode, PL.gx + 38, PL.gy + 44, 14, withAlpha(P.text, 0.85), { font: 'bold' });
    // the downshift arrows inside the ring, under the gear (clear of the ring and of the panel's edge)
    h.drawDown(cv, PL.gx, PL.gy + 21, f.down || 0, 0.6, P.arrow);
    // the readouts: a small label over big digits, three slots; the shift grade takes them over
    if (f.chip) { grade(cv, (PL.vx + PL.dx1) / 2, PL.vy + PL.vh, f.chip, P, 28); return; }
    const items = (f.readouts || []).filter((it) => !it.bar);
    items.slice(0, 3).forEach((it, k) => {
        const x = PL.vx + PL.slots[k], lab = labelOf(o, P.text);
        fitLabel(cv, it.label, x, PL.ly, lab.s, lab.c, PL.room[k], { font: 'bold', spacing: 1 });
        segValue(cv, it.value, x, PL.vy, toneCol(it, P, P.text), h);
    });
}
function drawM(cv, f, layer, h) {
    const st = f.opts.style;
    if (st === 'arc') drawArc(cv, f, layer, h); else if (st === 'ramp') drawRamp(cv, f, layer, h); else if (st === 'pill') drawPill(cv, f, layer, h); else drawDial(cv, f, layer, h);
}
module.exports = { drawM };
