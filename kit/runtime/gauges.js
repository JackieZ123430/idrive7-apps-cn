'use strict';
/**
 * gauges.js - drawn widgets for kit dashboards (radial gauge, bar, stat tile
 * with history trace, tyre map, panel chrome). All draw onto a canvas.js
 * Canvas using a theme from themes.js.
 *
 * Value objects: { value, min, max, label, unit, decimals, peak, zones }
 *   zones = [{ from, to, color: 'warn'|'crit'|'cold'|'#hex' }] colour the
 *   live arc/bar when the value is inside them; tintOnly: true only marks the
 *   zone on the gauge rim. g.color = base colour (theme key or #hex) instead of accent.
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
        if (!z.tintOnly && isNum(v) && v >= z.from && v <= z.to) c = t[z.color] || z.color;
    }
    return c;
}

/** Widget in the OEM (G20 / MGU7) style; cached as a layer (see layer()). */
function panel(cv, t, x, y, w, h, title) {
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    const key = ['panel', w, h, title || '', t.name].join('|');
    const L = layer(key, w, h, (c) => drawPanel(c, t, 0, 0, w, h, title));
    // the panel is a translucent overlay, blended pixel by pixel - a large part of every frame. Where
    // its area is still plain background (panels are drawn first on a cleared page), copy whole rows
    // of a cached copy blended onto that background instead: the same bytes, at memcpy speed.
    if (isBackground(cv, x, y, w, h, t.bg)) {
        cv.copyRows(layer(key + '|on|' + t.bg, w, h, (c) => c.clear(t.bg).blit(L, 0, 0)), x, y);
    } else cv.blit(L, x, y);
}
/** Is the w x h area at (x, y) entirely the opaque colour bg? (row compares, native speed) */
const bgRows = new Map();
function isBackground(cv, x, y, w, h, bg) {
    if (x < 0 || y < 0 || x + w > cv.w || y + h > cv.h) return false;
    const k = bg + '|' + w;
    let row = bgRows.get(k);
    if (!row) { row = Buffer.from(new Canvas(w, 1).clear(bg).d.buffer); bgRows.set(k, row); }
    if (row[3] !== 255) return false;
    const buf = Buffer.from(cv.d.buffer, cv.d.byteOffset, cv.d.length);
    for (let r = 0; r < h; r++) {
        const o = ((y + r) * cv.w + x) * 4;
        if (buf.compare(row, 0, row.length, o, o + row.length) !== 0) return false;
    }
    return true;
}
function drawPanel(cv, t, x, y, w, h, title) {
    // flat light grey overlay; top: a short bold bar in the theme's stripe colours (M tricolour:
    // light blue, dark blue, red; the last part with an angled end), then a thin white line;
    // large white title in normal case
    cv.fillRect(x, y, w, h, withAlpha('#b4bccc', 0.07));
    const st = t.stripes || [t.accent], BW = 78, gap = 3, sw = (BW - gap * (st.length - 1)) / st.length;
    st.forEach((c, i) => {
        const sx = x + i * (sw + gap), last = i === st.length - 1;
        for (let r = 0; r < 5; r++) cv.fillRect(sx, y + r, last ? sw - r * 1.6 : sw, 1, c);
    });
    cv.fillRect(x + BW + 2, y + 2, w - BW - 2, 1.5, withAlpha('#ffffff', 0.9));
    if (title) cv.text(String(title), x + 18, y + 42, 26, t.text, { font: 'bold' });
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
    let col = zoneColor(t, g, v, g.color ? t[g.color] || g.color : undefined);
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

/** Nice scale step (1, 2, 2.5, 5 x 10^n) for about n divisions of max. */
function niceStep(max, n) {
    const raw = max / n, e = Math.pow(10, Math.floor(Math.log10(raw)));
    return [1, 2, 2.5, 5, 10].map((m) => m * e).find((v) => v >= raw * 0.999) || raw;
}

/** Slanted slab (OEM bar shape): x0..x1 measured on the bottom edge, top edge shifted right by sl. */
function slab(cv, x0, x1, y, h, sl, c) {
    if (x1 - x0 <= 0) return;
    for (let r = 0; r < h; r++) cv.fillRect(x0 + sl * (h - r - 0.5) / h, y + r, x1 - x0, 1, c);
}

/**
 * Bar gauge in the OEM (G20 sport display) style: label / value header, a slanted grey track,
 * the fill in the theme's bar colour (lighter upper half) ending in a white stripe, a white
 * scale line under it with numbers, and the peak ("hang") as an outline along the top edge.
 * g.niceMax: extend the scale to the next round number (0-400 rather than 0-285).
 * g.ramp = 'hot': fill in the tach colours along the scale (the theme's hotRamp) instead of one colour;
 * g.color: fill colour (theme key or #hex) instead of the theme's bar colour.
 */
function bar(cv, t, x, y, w, h, g) {
    const min = g.min || 0, v = g.value;
    let max = g.max == null ? 100 : g.max;
    const step = g.step || niceStep(max - min, 4);
    if (g.niceMax) max = min + Math.ceil((max - min) / step - 1e-9) * step;       // scale ends on a round number (OEM)
    const f = isNum(v) ? clamp((v - min) / (max - min), 0, 1) : 0;
    cv.text(String(g.label || '').toUpperCase(), x, y + 26, 22, t.dim, { font: 'bold', spacing: 2 });
    const vs = fmt(v, g.decimals);
    const uw = g.unit ? cv.textWidth(' ' + g.unit, 26) : 0;
    cv.text(vs, x + w - uw, y + 30, 44, isNum(v) ? t.text : t.dim, { align: 'right', font: 'num' });
    if (g.unit) cv.text(' ' + g.unit, x + w, y + 30, 26, t.dim, { align: 'right' });
    const bh = 22, by = y + 44, SL = 18, bw = w - SL;
    const X = (val) => x + clamp((val - min) / (max - min), 0, 1) * bw;
    slab(cv, x, x + bw, by, bh, SL, withAlpha('#d4d8de', 0.34));               // track
    const base = g.color ? t[g.color] || g.color : t.bar || t.accent, col = zoneColor(t, g, v, base);
    const stops = g.ramp === 'hot' && col === base ? t.hotRamp || t.ramp : null;
    // fill: lighter upper part, white stripe at the leading edge (gap in the background colour)
    if (f > 0) {
        const xe = X(v), cap = 7, hi = mix(col, '#ffffff', 0.28), top = Math.round(bh * 0.42);
        if (stops) {                                 // colour of its position on the scale, lighter upper part
            const lite = stops.map((c) => mix(c, '#ffffff', 0.28));
            for (let r = 0; r < bh; r++) { const o = SL * (bh - r - 0.5) / bh; cv.rampRect(x + o, by + r, xe - x, 1, 0.5, r < top ? lite : stops, x + o, bw); }   // r 0.5: full cover on a 1 px row
        } else {
            slab(cv, x, xe, by, bh, SL, col);
            for (let r = 0; r < top; r++) cv.fillRect(x + SL * (bh - r - 0.5) / bh, by + r, xe - x, 1, hi);
        }
        if (xe - x > cap + 4) { slab(cv, xe - cap - 3, xe - cap, by, bh, SL, t.bg); slab(cv, xe - cap, xe, by, bh, SL, '#ffffff'); }
    }
    // peak hold ("hang"): line along the top edge (over the fill) to the peak, then down its slanted end
    if (isNum(g.peak) && (g.peak - min) / (max - min) > 0.02) {          // (not for a peak at the very start)
        const px = X(g.peak), hc = t.hang || (stops ? ramp(stops, (px - x) / bw) : col);
        cv.fillRect(x + SL, by - 2, px - x, 5, hc);
        if (!isNum(v) || g.peak > v) cv.line(px + SL, by, px, by + bh, 4, hc);
    }
    // scale: white line under the bar, broken at each step, numbers below (when there is room)
    const dec = g.scaleDecimals != null ? g.scaleDecimals : step % 1 ? 1 : 0;
    const marks = [];
    for (let a = min; a <= max + 1e-9; a += step) marks.push(a);
    if (max - marks[marks.length - 1] > step * 0.45) marks.push(max);           // label the end too
    cv.fillRect(x, by + bh + 2, bw, 2, withAlpha('#ffffff', 0.85));
    marks.slice(1).forEach((a) => { if (a < max - 1e-9) cv.fillRect(X(a) - 2, by + bh + 2, 4, 2, t.bg); });
    if (h >= 80) marks.forEach((a) => cv.text(fmt(a, dec), X(a), by + bh + 26, 20, withAlpha(t.text, 0.85), { align: 'center', font: 'bold' }));
}

/**
 * Tach bar widget (the Redline rev bar as a widget): digital value top right, a slanted bar
 * filling left to right in segments, scale below. g = { label, value, unit, decimals, min, max,
 * step (segment size), scale: { every, div, decimals }, peak, marks: [{ value, color }],
 * ramp: 'hot' (theme hot ramp to red at g.limit, solid red above) or zones / g.color per segment }.
 */
function segBar(cv, t, x, y, w, h, g) {
    panel(cv, t, x, y, w, h, g.label);
    const min = g.min || 0, max = g.max, v = g.value, step = g.step || (max - min) / 16, SL = 18;
    const hot = g.ramp === 'hot', lim = g.limit == null ? max : g.limit, over = hot && isNum(v) && v >= lim;
    const base = g.color ? t[g.color] || g.color : t.accent;
    const segCol = (mid) => (over ? '#ff2a2a' : hot ? ramp(t.hotRamp || t.ramp, clamp((mid - min) / (lim - min), 0, 1)) : zoneColor(t, g, mid, base));
    // digital value (top right)
    const uw = g.unit ? cv.textWidth(' ' + g.unit, 26) : 0;
    cv.text(fmt(v, g.decimals), x + w - 24 - uw, y + 60, 64, !isNum(v) ? t.dim : over ? '#ff4a4a' : t.text, { align: 'right', font: 'num' });
    if (g.unit) cv.text(' ' + g.unit, x + w - 24, y + 60, 26, t.dim, { align: 'right' });
    // bar geometry: top edge shifted right by SL (slant)
    const bx = x + 24, bw = w - 48 - SL, y0 = y + 80, y1 = y + Math.max(130, h - 82);
    const X = (val) => bx + clamp((val - min) / (max - min), 0, 1) * bw;
    const off = (yy) => SL * (y1 - yy) / (y1 - y0);
    const band = (a, b, c, pad) => {
        pad = pad || 0; const xa = X(a), xb = X(b);
        if (xb - xa <= 0) return;
        for (let yy = y0 - pad; yy < y1 + pad; yy++) cv.fillRect(off(Math.min(y1, Math.max(y0, yy + 0.5))) + xa - pad, yy, xb - xa + 2 * pad, 1, c);
    };
    const gapAt = (val, c) => { const xx = X(val); for (let yy = y0; yy < y1; yy++) cv.fillRect(off(yy + 0.5) + xx - 1.5, yy, 3, 1, c); };
    // track (tinted where the red / warning zones are)
    band(min, max, t.track);
    if (hot && lim < max) band(lim, max, withAlpha(t.crit, 0.3));
    for (const z of g.zones || []) if (!z.tintOnly && (z.color === 'warn' || z.color === 'crit')) band(Math.max(min, z.from), Math.min(max, z.to), withAlpha(t[z.color], 0.25));
    // fill: each segment in the colour of its position
    if (isNum(v) && v > min) {
        const vv = Math.min(v, max);
        band(min, vv, withAlpha(segCol(vv), 0.14), 6);
        for (let a = min; a < vv; a += step) band(a, Math.min(vv, a + step), segCol(a + step / 2));
        const xe = X(vv);
        cv.line(xe, y1 + 4, xe + SL, y0 - 4, 6, '#ffffff');                  // bright leading edge
    }
    for (let a = min + step; a < max - 1e-9; a += step) gapAt(a, t.bg);
    // peak hold ("hang", OEM style): line along the top edge (over the fill) to the peak, then down its slanted end
    if (isNum(g.peak) && (g.peak - min) / (max - min) > 0.02) {          // (not for a peak at the very start)
        const pk = Math.min(g.peak, max), pc = t.hang || (hot && pk >= lim ? '#ff2a2a' : hot ? ramp(t.hotRamp || t.ramp, clamp((pk - min) / (lim - min), 0, 1)) : zoneColor(t, g, pk, base));
        cv.fillRect(bx + SL, y0 - 2, X(pk) - bx, 5, pc);
        if (!isNum(v) || g.peak > v) cv.line(X(pk) + SL, y0, X(pk), y1, 4, pc);
    }
    // marks above the bar (shift point, warm, ...)
    for (const m of g.marks || []) { const xx = X(m.value) + SL; cv.fillRect(xx - 2, y0 - 14, 4, 12, t[m.color] || m.color); }
    // scale
    const sc = g.scale || {};
    for (let a = min; a <= max + 1e-9; a += step) {
        const xx = X(a), lab = sc.every && Math.abs((a - min) / sc.every - Math.round((a - min) / sc.every)) < 1e-6;
        cv.fillRect(xx - (lab ? 1.5 : 1), y1 + 8, lab ? 3 : 2, lab ? 12 : 7, lab ? t.text : t.tick);
        if (lab) cv.text(fmt(a / (sc.div || 1), sc.decimals || 0), xx, y1 + 42, 24, hot && a >= lim ? t.crit : t.dim, { align: 'center', font: 'bold' });
    }
}

/** Stat tile: label, big value + unit, optional history trace. */
function stat(cv, t, x, y, w, h, g) {
    panel(cv, t, x, y, w, h, g.label);
    const v = g.value, col = zoneColor(t, g, v, g.color ? t[g.color] || g.color : t.accent);
    const vcol = zoneColor(t, g, v, g.valueColor ? t[g.valueColor] || g.valueColor : t.text);
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
            cv.text(g.pressure.unit || 'bar', lx, ty + th * 0.42 + 64, 22, t.dim, { align: al });
        } else {
            cv.text(fmt(val, g.decimals), lx, ty + th / 2 + 6, 40, isNum(val) ? t.text : t.dim, { align: al, font: 'num' });
            if (g.unit) cv.text(g.unit, lx, ty + th / 2 + 34, 22, t.dim, { align: al });
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
        cv.text(ring.toFixed(1), cx + rr * 0.7071 + 6, cy - rr * 0.7071 - 4, 22, t.dim);
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
    cv.text('BRAKE', cx, cy + r - 14, 22, t.dim, { align: 'center', font: 'bold', spacing: 1.5 });
    cv.text('ACCEL', cx, cy - r + 32, 22, t.dim, { align: 'center', font: 'bold', spacing: 1.5 });
}

/*
 * G20 / MGU7-style frame: a slim tab bar along the top (BAR_H px) with the page names; pages
 * draw their content from TOP to BOTTOM below it. Grey bar, thin line on its bottom edge, the
 * selected tab with a thick bar on that line + glow in the theme's selection colour and its name
 * in selText (white in M Tricolour), the others grey. badges = [{ text, color }] on the right.
 */
const BAR_H = 36, TOP = 44, BOTTOM = 512;
function frame(cv, t, tabs, sel, badges) {
    const W = cv.w, S = t.sel || t.accent;
    cv.fillRect(0, 0, W, BAR_H, t.bg);
    cv.fillRect(0, 0, W, BAR_H, withAlpha('#ffffff', 0.07));
    cv.fillRect(0, BAR_H - 1, W, 1, withAlpha('#ffffff', 0.18));
    const opt = { align: 'center', font: 'bold', spacing: 1.5 };
    let x = 16;
    (tabs || []).forEach((name, i) => {
        const label = String(name).toUpperCase(), tw = Math.max(150, cv.textWidth(label, 20, opt) + 48), on = i === sel;
        if (on) {
            cv.gradientRect(x, 0, tw, BAR_H, [[0, withAlpha(S, 0)], [1, withAlpha(S, 0.22)]]);
            cv.fillRect(x, BAR_H - 4, tw, 4, S);
        }
        cv.text(label, x + tw / 2, 25, 20, on ? t.selText || S : t.dim, opt);
        if (i < tabs.length - 1) cv.fillRect(x + tw, 9, 1, BAR_H - 18, withAlpha('#ffffff', 0.12));
        x += tw;
    });
    let bx = W - 16;
    (badges || []).filter(Boolean).forEach((b) => {
        const bw = Math.max(84, cv.textWidth(b.text, 18, opt) + 24), c = t[b.color] || b.color || t.warn;
        cv.roundRect(bx - bw, 6, bw, 24, 5, withAlpha(c, 0.2));
        cv.text(b.text, bx - bw / 2, 25, 18, c, opt);
        bx -= bw + 10;
    });
}

/** Accent stripes (M-style) under a header. */
function stripes(cv, t, x, y, w) {
    const s = t.stripes || [t.accent];
    const sw = w / s.length;
    s.forEach((c, i) => cv.roundRect(x + i * sw, y, sw - (i < s.length - 1 ? 4 : 0), 4, 2, c));
}

module.exports = { BAR_H, TOP, BOTTOM, frame, layer, panel, segBar, radial, bar, stat, tyres, gmeter, stripes, fmt, isNum, clamp, mix, zoneColor };
