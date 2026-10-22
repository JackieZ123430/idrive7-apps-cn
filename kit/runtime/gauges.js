'use strict';
/**
 * gauges.js - drawn widgets for kit dashboards (radial gauge, bar, stat tile
 * with history trace, tyre map, panel chrome). All draw onto a canvas.js
 * Canvas using a theme from themes.js.
 *
 * Value objects: { value, min, max, label, unit, decimals, peak, zones }
 *   zones = [{ from, to, color: 'warn'|'crit'|'cold'|'#hex' }] colour the
 *   live arc/bar when the value is inside them.
 * Radial gauges colour their arc with the theme's hotRamp instead: from the theme
 * colour to red at g.limit (default max). g.hot = false turns that off.
 * value === null/undefined renders as "--" (no data).
 */
const { Canvas, mix, ramp, withAlpha } = require('./canvas');

/*
 * Layer cache: the parts of a widget that don't change between frames (card
 * background, gauge track / ticks / numbers) are drawn once into their own
 * transparent canvas and blitted every frame, which is several times cheaper
 * than drawing them again. Least recently used layers go first, ~16 MB max.
 */
const layers = new Map();
let layerBytes = 0;
const LAYER_MAX = 16 * 1024 * 1024;
function layer(key, w, h, draw) {
    let c = layers.get(key);
    if (c) { layers.delete(key); layers.set(key, c); return c; }        // most recent last
    c = new Canvas(Math.ceil(w), Math.ceil(h));
    draw(c);
    layers.set(key, c); layerBytes += c.d.length;
    while (layerBytes > LAYER_MAX && layers.size > 1) {
        const k = layers.keys().next().value;
        layerBytes -= layers.get(k).d.length; layers.delete(k);
    }
    return c;
}

const isNum = (x) => typeof x === 'number' && isFinite(x);
const fmt = (v, d) => (isNum(v) ? v.toFixed(d || 0) : '--');
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/** Colour of value v: the zone it falls in, else `base` (default accent). */
function zoneColor(t, g, v, base) {
    let c = base || t.accent;
    for (const z of g.zones || []) {
        if (isNum(v) && v >= z.from && v <= z.to) c = t[z.color] || z.color;
    }
    return c;
}

/** Panel card: rounded, soft vertical gradient, hairline edge, accent pill + title. */
function panel(cv, t, x, y, w, h, title) {
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    const key = ['panel', w, h, title || '', t.name].join('|');
    cv.blit(layer(key, w, h, (c) => drawPanel(c, t, 0, 0, w, h, title)), x, y);
}
function drawPanel(cv, t, x, y, w, h, title) {
    const R = 16, E = 1.5, lo = mix(t.panelEdge, t.panelBottom, 0.6);
    cv.card(x, y, w, h, R, [[0, t.panelTop], [1, t.panelBottom]]);
    // hairline edge, fading towards the bottom: straight runs + quarter-circle corners
    cv.fillRect(x + R, y, w - 2 * R, E, t.panelEdge);
    cv.fillRect(x + R, y + h - E, w - 2 * R, E, lo);
    cv.gradientRect(x, y + R, E, h - 2 * R, [[0, t.panelEdge], [1, lo]]);
    cv.gradientRect(x + w - E, y + R, E, h - 2 * R, [[0, t.panelEdge], [1, lo]]);
    cv.arc(x + R, y + R, R - E, R, -90, 0, t.panelEdge);
    cv.arc(x + w - R, y + R, R - E, R, 0, 90, t.panelEdge);
    cv.arc(x + w - R, y + h - R, R - E, R, 90, 180, lo);
    cv.arc(x + R, y + h - R, R - E, R, 180, 270, lo);
    if (title) {
        cv.roundRect(x + 18, y + 21, 4, 24, 2, t.accent);
        cv.text(String(title).toUpperCase(), x + 32, y + 40, 22, t.dim, { font: 'bold', spacing: 2 });
    }
}

/** 270-degree radial gauge centred at (cx, cy). */
function radial(cv, t, cx, cy, r, g) {
    const a0 = -135, a1 = 135;
    const min = g.min || 0, max = g.max == null ? 100 : g.max;
    const v = g.value, f = isNum(v) ? clamp((v - min) / (max - min), 0, 1) : 0;
    const thick = Math.max(8, r * 0.11);
    // static part (track, zone tints, ticks, numbers, unit, label) from the layer cache
    const S = Math.ceil(r + 16), key = ['radial', r, min, max, g.ticks, g.majorEvery, g.tickLabels, g.tickDiv, g.tickDecimals,
        JSON.stringify(g.zones || []), g.unit || '', g.label || '', t.name].join('|');
    cv.blit(layer(key, 2 * S, 2 * S, (c) => radialStatic(c, t, S, S, r, g, min, max, thick)), Math.round(cx) - S, Math.round(cy) - S);
    radialLive(cv, t, cx, cy, r, g, min, max, thick, v, f);
}
function radialStatic(cv, t, cx, cy, r, g, min, max, thick) {
    const a0 = -135, a1 = 135;
    // track + zone tints
    cv.arc(cx, cy, r - thick, r, a0, a1, t.track, { round: true });
    for (const z of g.zones || []) {
        const za = a0 + (clamp((z.from - min) / (max - min), 0, 1)) * 270;
        const zb = a0 + (clamp((z.to - min) / (max - min), 0, 1)) * 270;
        cv.arc(cx, cy, r + 4, r + 9, za, zb, withAlpha(t[z.color] || z.color, 0.85));
    }
    // ticks
    const n = g.ticks || 10;
    for (let i = 0; i <= n; i++) {
        const a = (a0 + (i / n) * 270) * Math.PI / 180;
        const major = i % (g.majorEvery || 2) === 0;
        const ri = r - thick - (major ? 16 : 9), ro = r - thick - 5;
        cv.line(cx + Math.sin(a) * ri, cy - Math.cos(a) * ri, cx + Math.sin(a) * ro, cy - Math.cos(a) * ro, major ? 3 : 2, major ? t.tick : withAlpha(t.tick, 0.6));
        if (major && g.tickLabels !== false && r > 110) {
            const val = min + (i / n) * (max - min);
            const lr = r - thick - 38;
            cv.text(fmt(val / (g.tickDiv || 1), g.tickDecimals || 0), cx + Math.sin(a) * lr, cy - Math.cos(a) * lr + 9, 24, t.dim, { align: 'center', font: 'label' });
        }
    }
    if (g.unit) cv.text(g.unit, cx, cy + Math.round(r * 0.62) * 0.32 + 36, 28, t.dim, { align: 'center', font: 'label' });
    if (g.label) cv.text(String(g.label).toUpperCase(), cx, cy + r * 0.82, 26, t.text, { align: 'center', font: 'bold', spacing: 1.5 });
}
function radialLive(cv, t, cx, cy, r, g, min, max, thick, v, f) {
    const a0 = -135, a1 = 135;
    // live arc: the theme's colour ramp along the scale (a zone's colour when inside one), soft glow, bright tip
    // (or, by default, the hot ramp: theme colour -> red at the limit)
    let col = zoneColor(t, g, v);
    const hot = g.hot !== false && (t.hotRamp || t.ramp);
    const limA = a0 + clamp(((g.limit == null ? max : g.limit) - min) / (max - min), 0.05, 1) * 270;
    if (isNum(v) && f > 0.002) {
        const ae = a0 + f * 270, inZone = col !== t.accent;
        if (hot) col = ramp(hot, (ae - a0) / (limA - a0));
        cv.arc(cx, cy, r - thick - 6, r + 6, a0, ae, withAlpha(col, 0.14));
        cv.arc(cx, cy, r - thick, r, a0, ae, col, hot ? { round: true, ramp: hot, rampFrom: a0, rampTo: limA }
            : inZone || !t.ramp ? { round: true } : { round: true, ramp: t.ramp, rampFrom: a0, rampTo: a1 });
        const a = ae * Math.PI / 180, rm = r - thick / 2;
        cv.circle(cx + Math.sin(a) * rm, cy - Math.cos(a) * rm, thick * 0.5 + 4, withAlpha(t.text, 0.25));
        cv.circle(cx + Math.sin(a) * rm, cy - Math.cos(a) * rm, thick * 0.5 + 1, t.text);
    }
    // peak marker
    if (isNum(g.peak) && g.peak > min) {
        const pa = (a0 + clamp((g.peak - min) / (max - min), 0, 1) * 270) * Math.PI / 180;
        cv.line(cx + Math.sin(pa) * (r - thick), cy - Math.cos(pa) * (r - thick), cx + Math.sin(pa) * (r + 10), cy - Math.cos(pa) * (r + 10), 3, t.accent2);
    }
    // centre readout
    const big = Math.round(r * 0.62);
    cv.text(fmt(v, g.decimals), cx, cy + big * 0.32, big, isNum(v) ? t.text : t.dim, { align: 'center', font: 'num' });
    if (isNum(g.peak) && g.showPeak !== false) cv.text('PEAK ' + fmt(g.peak, g.decimals), cx, cy + r * 0.82 + 32, 22, t.accent2, { align: 'center', font: 'label', spacing: 1 });
}

/** Horizontal bar gauge with label / value header: a slim rounded track filled with the theme ramp. */
function bar(cv, t, x, y, w, h, g) {
    const min = g.min || 0, max = g.max == null ? 100 : g.max, v = g.value;
    const f = isNum(v) ? clamp((v - min) / (max - min), 0, 1) : 0;
    cv.text(String(g.label || '').toUpperCase(), x, y + 26, 22, t.dim, { font: 'bold', spacing: 2 });
    const vs = fmt(v, g.decimals);
    const uw = g.unit ? cv.textWidth(' ' + g.unit, 26) : 0;
    cv.text(vs, x + w - uw, y + 30, 44, isNum(v) ? t.text : t.dim, { align: 'right', font: 'num' });
    if (g.unit) cv.text(' ' + g.unit, x + w, y + 30, 26, t.dim, { align: 'right' });
    const room = h - 44, bh = Math.max(8, Math.min(room, 18)), by = y + 44 + (room - bh) / 2;
    cv.roundRect(x, by, w, bh, bh / 2, t.track);
    if (f > 0) {
        const col = zoneColor(t, g, v);
        const fw = Math.max(bh, w * f);
        if (col !== t.accent || !t.ramp) cv.roundRect(x, by, fw, bh, bh / 2, col);
        else cv.rampRect(x, by, fw, bh, bh / 2, t.ramp, x, w);
        cv.roundRect(x + fw - bh, by - 3, bh, bh + 6, bh / 2, withAlpha(t.text, 0.9));
    }
    if (isNum(g.peak)) {
        const px = x + clamp((g.peak - min) / (max - min), 0, 1) * w;
        cv.roundRect(px - 2, by - 8, 4, bh + 16, 2, t.accent2);
    }
}

/** Stat tile: label, big value + unit, optional history trace. */
function stat(cv, t, x, y, w, h, g) {
    panel(cv, t, x, y, w, h, g.label);
    const v = g.value, col = zoneColor(t, g, v, t.accent), vcol = zoneColor(t, g, v, t.text);
    // history trace first, so the big value stays readable on top of it
    const hist = (g.history || []).filter(isNum);
    if (hist.length > 2 && h > 150) {
        const hx = x + 18, hw = w - 36, hy = y + h - (g.sub ? 44 : 18), hh = Math.min(60, h * 0.25);
        let lo = Math.min.apply(null, hist), hi = Math.max.apply(null, hist);
        if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
        const pts = g.history.map((p, i) => [hx + (i / Math.max(1, g.history.length - 1)) * hw,
            isNum(p) ? hy - ((p - lo) / (hi - lo)) * hh : hy]);
        cv.fillUnder(pts, hy, withAlpha(col, 0.16));
        cv.polyline(pts, 2.5, withAlpha(col, 0.85));
    }
    const size = g.size || Math.min(96, h * 0.42);
    const vs = fmt(v, g.decimals);
    const vw = cv.textWidth(vs, size, { font: 'num' });
    cv.text(vs, x + 18, y + 52 + size * 0.78, size, isNum(v) ? vcol : t.dim, { font: 'num' });
    if (g.unit) cv.text(g.unit, x + 26 + vw, y + 52 + size * 0.78, 28, t.dim);
    if (g.sub) cv.text(g.sub, x + 18, y + h - 16, 22, t.dim, { spacing: 0.5 });
}

/** Top-down tyre map: four tyres coloured by temperature or pressure. */
function tyres(cv, t, x, y, w, h, g) {
    panel(cv, t, x, y, w, h, g.label || 'Tyres');
    const cx = x + w / 2, top = y + 64, bh = h - 90;
    const bw = Math.min(w * 0.28, bh * 0.45);
    // car body outline
    cv.strokeRoundRect(cx - bw / 2, top + 6, bw, bh - 12, bw * 0.35, 3, t.tick);
    cv.fillRect(cx - bw / 2 + 10, top + bh * 0.3, bw - 20, 3, withAlpha(t.tick, 0.6));
    const tw = bw * 0.28, th = bh * 0.26;
    const spots = [['fl', -1, 0.12], ['fr', 1, 0.12], ['rl', -1, 0.62], ['rr', 1, 0.62]];
    for (const [k, side, fy] of spots) {
        const val = g[k];
        let c = t.track;
        if (isNum(val)) {
            c = g.coldBelow != null && val < g.coldBelow ? t.cold
                : g.hotAbove != null && val > g.hotAbove ? t.crit
                : g.warnAbove != null && val > g.warnAbove ? t.warn : t.accent;
        }
        const tx = side < 0 ? cx - bw / 2 - tw - 6 : cx + bw / 2 + 6, ty = top + bh * fy;
        cv.roundRect(tx, ty, tw, th, 6, c);
        const lx = side < 0 ? tx - 14 : tx + tw + 14, al = side < 0 ? 'right' : 'left';
        if (g.pressure) {
            // temperature on top, pressure (coloured against its target) below
            const tv = fmt(val, g.decimals) + (isNum(val) && g.unit ? g.unit : '');
            cv.text(tv, lx, ty + th * 0.42, 34, isNum(val) ? t.text : t.dim, { align: al, font: 'num' });
            const pv = g.pressure[k], tgt = g.pressure.target ? g.pressure.target[k] : null;
            let pc = isNum(pv) ? t.text : t.dim;
            if (isNum(pv) && isNum(tgt) && tgt > 0) {
                const r = pv / tgt;
                pc = r < 0.85 ? t.crit : r < 0.93 ? t.warn : r > 1.15 ? t.warn : t.ok;
            }
            cv.text(fmt(pv, g.pressure.decimals == null ? 1 : g.pressure.decimals), lx, ty + th * 0.42 + 40, 34, pc, { align: al, font: 'num' });
            cv.text(g.pressure.unit || 'bar', lx, ty + th * 0.42 + 64, 18, t.dim, { align: al });
        } else {
            cv.text(fmt(val, g.decimals), lx, ty + th / 2 + 6, 40, isNum(val) ? t.text : t.dim, { align: al, font: 'num' });
            if (g.unit) cv.text(g.unit, lx, ty + th / 2 + 34, 20, t.dim, { align: al });
        }
    }
}

/**
 * Friction circle: lateral (x) / longitudinal (y) acceleration in g, with a
 * fading trail and peak readouts. g = { lat, long, trail: [[lat,long],...], max, peakLat, peakLong }
 */
function gmeter(cv, t, cx, cy, r, g) {
    const max = g.max || 1.5;
    for (let ring = 0.5; ring <= max + 1e-6; ring += 0.5) {
        const rr = (ring / max) * r;
        cv.arc(cx, cy, rr - 1.5, rr + 1.5, 0, 360, ring % 1 === 0 ? t.tick : withAlpha(t.tick, 0.5));
        cv.text(ring.toFixed(1), cx + rr * 0.7071 + 6, cy - rr * 0.7071 - 4, 20, t.dim);
    }
    cv.line(cx - r, cy, cx + r, cy, 2, withAlpha(t.tick, 0.6));
    cv.line(cx, cy - r, cx, cy + r, 2, withAlpha(t.tick, 0.6));
    const P = (lat, lon) => [cx + clamp(lat / max, -1.1, 1.1) * r, cy - clamp(lon / max, -1.1, 1.1) * r];
    const tr = g.trail || [];
    tr.forEach((p, i) => {
        if (!isNum(p[0]) || !isNum(p[1])) return;
        const [x, y] = P(p[0], p[1]);
        cv.circle(x, y, 4, withAlpha(t.accent, 0.08 + 0.5 * (i / tr.length)));
    });
    if (isNum(g.lat) && isNum(g.long)) {
        const [x, y] = P(g.lat, g.long);
        cv.circle(x, y, 16, withAlpha(t.accent, 0.25));
        cv.circle(x, y, 10, t.accent);
        cv.circle(x, y, 4, t.text);
        const tot = Math.sqrt(g.lat * g.lat + g.long * g.long);
        cv.text(tot.toFixed(2) + ' g', cx, cy + r + 44, 40, t.text, { align: 'center', font: 'num' });
    } else {
        cv.text('-- g', cx, cy + r + 44, 40, t.dim, { align: 'center', font: 'num' });
    }
    cv.text('BRAKE', cx, cy + r - 14, 18, t.dim, { align: 'center', font: 'bold', spacing: 1.5 });
    cv.text('ACCEL', cx, cy - r + 30, 18, t.dim, { align: 'center', font: 'bold', spacing: 1.5 });
}

/** Accent stripes (M-style) under a header. */
function stripes(cv, t, x, y, w) {
    const s = t.stripes || [t.accent];
    const sw = w / s.length;
    s.forEach((c, i) => cv.roundRect(x + i * sw, y, sw - (i < s.length - 1 ? 4 : 0), 4, 2, c));
}

module.exports = { layer, panel, radial, bar, stat, tyres, gmeter, stripes, fmt, isNum, clamp, mix, zoneColor };
