'use strict';
/**
 * gauges.js - render templates for kit dashboards. Every template draws onto a frame surface
 * (ctx.canvas(), a record.js Recorder) with a theme from themes.js; the frame then goes to
 * the GPU renderer (60 fps) or, without it, to the software canvas.
 *
 *   panel      OEM (G20 / MGU7) widget chrome: tricolour stripe, title
 *   radial     270-degree dial with ticks, numbers, value arc, peak marker, digital value
 *   needle     classic analogue dial with a needle
 *   ring       progress ring with a value in the middle
 *   bar        OEM bar gauge: slanted track, fill, peak hold, scale
 *   segBar     segmented tach bar (Redline style) in a panel
 *   stat       stat tile: big value, unit, history trace
 *   readout    label + big value + unit (no panel)
 *   shiftLights  row of shift lights filling towards the shift point, strobing above it
 *   gear       big gear / selector indicator
 *   chart      axes, grid, labels and line series (with optional fill)
 *   table      header row + rows of columns
 *   pill       rounded status label
 *   tyres      top-down tyre map
 *   gmeter     friction circle with a fading trail
 *   frame      the page tabs (G20 style): on the full-screen layout they move up into the
 *              header in the HMI's title strip, otherwise a slim tab bar along the top
 *   header     full-screen header: app name, page tabs, badges (drawn by the display)
 *   menuBar    the button bar: 'slim' (full-screen layout, 48 px) or 'standard' (HMI size)
 *
 * Value objects: { value, min, max, label, unit, decimals, peak, zones }
 *   zones = [{ from, to, color: 'warn'|'crit'|'cold'|'#hex' }] colour the live arc/bar when the
 *   value is inside them; tintOnly: true only marks the zone on the gauge rim. g.color = base
 *   colour (theme key or #hex). value === null/undefined renders as "--" (no data).
 *
 * Smooth motion: dials, bars and the g-meter glide to new values (critically damped spring,
 * evaluated every frame) instead of jumping at the rate the car sends data. Digital numbers
 * show the real value. g.smooth = false turns it off; a number sets the response (default 16:
 * ~0.3 s to settle). Apps can use smooth(key, value) for their own drawings.
 */
const { mix, ramp, withAlpha } = require('./canvas');
const { makeLayer, dropLayer } = require('./record');
const { getLanguage, t: localizeLabel } = require('./i18n');
const upperText = (value) => localizeLabel(String(value)).toUpperCase();

const isNum = (x) => typeof x === 'number' && isFinite(x);
const fmt = (v, d) => (isNum(v) ? v.toFixed(d || 0) : '--');
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/* ---------------- smoothing ---------------- */
const springs = new Map();
/**
 * Value of `key` gliding towards `target` (critically damped spring). w = response (1/s).
 * Returns target itself for null / non-numbers and after a pause of over 0.5 s.
 */
function smooth(key, target, w) {
    if (!isNum(target)) { springs.delete(key); return target; }
    w = w || 16;
    const now = Date.now();
    let s = springs.get(key);
    if (!s || now - s.t > 500) { springs.set(key, { x: target, v: 0, t: now }); return target; }
    let dt = (now - s.t) / 1000;
    s.t = now;
    while (dt > 0) {
        const h = Math.min(dt, 0.008);
        const a = w * w * (target - s.x) - 2 * w * s.v;
        s.v += a * h; s.x += s.v * h;
        dt -= h;
    }
    if (Math.abs(target - s.x) < 1e-6 * (Math.abs(target) + 1) && Math.abs(s.v) < 1e-4) s.x = target;
    return s.x;
}
/**
 * A readout that changes at most every `ms` (default 200 = 5 times a second, like the OEM
 * cluster's speed): the value of `key` sampled then and held in between. At 60 fps a number
 * that follows every sample flickers.
 */
const holds = new Map();
function hold(key, value, ms) {
    const now = Date.now(), h = holds.get(key);
    if (!isNum(value)) { holds.delete(key); return value; }
    if (h && now - h.t < (ms || 200) && now >= h.t) return h.v;
    holds.set(key, { v: value, t: now });
    return value;
}
const sm = (g, key, v) => (g.smooth === false ? v : smooth(key, v, typeof g.smooth === 'number' ? g.smooth : 16));

/* ---------------- layer cache ---------------- */
/*
 * Static parts of a widget (card, dial track / ticks / numbers) are recorded once as a layer;
 * the renderer draws a layer into a texture once and then reuses it every frame. Least
 * recently used layers are dropped beyond 120.
 */
const layers = new Map();
let layerDrop = null;                 // set by the display: tell the renderer a layer is gone
function layer(key, w, h, draw, textScale) {
    key = key + '|' + (textScale || 1) + '|' + getLanguage();
    let L = layers.get(key);
    if (L) { layers.delete(key); layers.set(key, L); return L; }
    L = makeLayer(w, h, draw, textScale || 1);
    layers.set(key, L);
    while (layers.size > 120) {
        const k = layers.keys().next().value, old = layers.get(k);
        layers.delete(k); dropLayer(old);
        if (layerDrop) layerDrop(old.layerId);
    }
    return L;
}
function onLayerDrop(fn) { layerDrop = fn; }

/** Colour of value v: the zone it falls in, else `base` (default accent). */
function zoneColor(t, g, v, base) {
    let c = base || t.accent;
    for (const z of g.zones || []) {
        if (!z.tintOnly && isNum(v) && v >= z.from && v <= z.to) c = t[z.color] || z.color;
    }
    return c;
}
const col = (t, c, dflt) => (c ? t[c] || c : dflt);

/* ---------------- panel ---------------- */
/** Widget chrome in the OEM (G20 / MGU7) style; cached as a layer. Returns the rect drawn: { x, y, w, h }. */
function panel(cv, t, x, y, w, h, title) { return box(cv, t, x, y, w, stretch(cv, y, h), title); }
/**
 * Height of a panel at y: one down to the page's bottom goes on down to the screen's where there is room
 * (cv.extra: display.js). (read only then: a page whose panels all end higher up is centred in the room instead)
 */
function stretch(cv, y, h) { return y + h >= 500 && cv.extra ? h + cv.extra : h; }
function box(cv, t, x, y, w, h, title) {
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    const L = layer(['panel', w, h, title || '', t.name].join('|'), w, h, (c) => drawPanel(c, t, 0, 0, w, h, title), cv.textScale);
    cv.blit(L, x, y);
    return { x, y, w, h };
}
/**
 * The page's content bottom: BOTTOM, plus the room the screen has below the page (cv.extra: where the kit
 * runs the screen with no bar under the page, else 0). Reading it places the page as one that reaches down.
 */
function pageBottom(cv) { return BOTTOM + (cv.extra || 0); }
/** px between a panel's bottom and its last line (the lowest drawn pixel): the same in every panel. */
const MARGIN = 22;
/**
 * How far down to move a panel's bottom part, laid out m px over the bottom of the unstretched panel (y + h),
 * so it ends MARGIN over the panel's real bottom, room px lower (G.panel's stretch: cv.extra, else 0).
 */
function toMargin(room, m) { return room + m - MARGIN; }
function drawPanel(cv, t, x, y, w, h, title) {
    // flat light grey overlay; top: a short bold bar in the theme's stripe colours (M tricolour:
    // light blue, dark blue, red; the last part with an angled end), then a thin white line;
    // large white title in normal case
    cv.fillRect(x, y, w, h, withAlpha('#b4bccc', 0.07));
    const st = t.stripes || [t.accent], BW = 78, gap = 3, sw = (BW - gap * (st.length - 1)) / st.length;
    st.forEach((c, i) => {
        const sx = x + i * (sw + gap), last = i === st.length - 1;
        if (last) cv.quad([[sx, y], [sx + sw, y], [sx + sw - 8, y + 5], [sx, y + 5]], c);
        else cv.fillRect(sx, y, sw, 5, c);
    });
    cv.fillRect(x + BW + 2, y + 2, w - BW - 2, 1.5, withAlpha('#ffffff', 0.9));
    if (title) cv.text(String(title), x + 18, y + 42, 26, t.text, { font: 'bold' });
}

/* ---------------- radial dial ---------------- */
/** 270-degree radial gauge centred at (cx, cy). */
function radial(cv, t, cx, cy, r, g) {
    const min = g.min || 0, max = g.max == null ? 100 : g.max;
    const v = g.value, sv = sm(g, 'radial|' + cx + '|' + cy, v);
    const f = isNum(sv) ? clamp((sv - min) / (max - min), 0, 1) : 0;
    const thick = Math.max(8, r * 0.11);
    const S = Math.ceil(r + 16), key = ['radial', r, min, max, g.ticks, g.majorEvery, g.tickLabels, g.tickDiv, g.tickDecimals,
        JSON.stringify(g.zones || []), g.unit || '', g.label || '', t.name].join('|');
    cv.blit(layer(key, 2 * S, 2 * S, (c) => radialStatic(c, t, S, S, r, g, min, max, thick), cv.textScale), Math.round(cx) - S, Math.round(cy) - S);
    radialLive(cv, t, cx, cy, r, g, min, max, thick, v, sv, f);
}
function radialStatic(cv, t, cx, cy, r, g, min, max, thick) {
    const a0 = -135, a1 = 135;
    cv.arc(cx, cy, r - thick, r, a0, a1, t.track, { round: true });
    for (const z of g.zones || []) {
        const za = a0 + (clamp((z.from - min) / (max - min), 0, 1)) * 270;
        const zb = a0 + (clamp((z.to - min) / (max - min), 0, 1)) * 270;
        cv.arc(cx, cy, r + 4, r + 9, za, zb, withAlpha(t[z.color] || z.color, 0.85));
    }
    const n = g.ticks || 10;
    for (let i = 0; i <= n; i++) {
        const a = (a0 + (i / n) * 270) * Math.PI / 180;
        const major = i % (g.majorEvery || 2) === 0;
        const ri = r - thick - (major ? 16 : 9), ro = r - thick - 5;
        cv.line(cx + Math.sin(a) * ri, cy - Math.cos(a) * ri, cx + Math.sin(a) * ro, cy - Math.cos(a) * ro, major ? 3 : 2, major ? t.tick : withAlpha(t.tick, 0.6));
        if (major && g.tickLabels !== false && r > 110) {
            const val = min + (i / n) * (max - min), lr = r - thick - 38;
            cv.text(fmt(val / (g.tickDiv || 1), g.tickDecimals || 0), cx + Math.sin(a) * lr, cy - Math.cos(a) * lr + 9, 24, t.dim, { align: 'center', font: 'label' });
        }
    }
    if (g.unit) cv.text(g.unit, cx, cy + Math.round(r * 0.62) * 0.32 + 36, 28, t.dim, { align: 'center', font: 'label' });
    if (g.label) cv.text(upperText(g.label), cx, cy + r * 0.82, 26, t.text, { align: 'center', font: 'bold', spacing: 1.5 });
}
function radialLive(cv, t, cx, cy, r, g, min, max, thick, v, sv, f) {
    const a0 = -135, a1 = 135;
    // live arc: the hot ramp (theme colour -> red at the limit), or a zone's colour inside one
    let c = zoneColor(t, g, sv, g.color ? t[g.color] || g.color : undefined);
    const hot = g.hot !== false && (t.hotRamp || t.ramp);
    const limA = a0 + clamp(((g.limit == null ? max : g.limit) - min) / (max - min), 0.05, 1) * 270;
    if (isNum(sv) && f > 0.002) {
        const ae = a0 + f * 270, inZone = c !== t.accent;
        if (hot) c = ramp(hot, (ae - a0) / (limA - a0));
        cv.arc(cx, cy, r - thick - 6, r + 6, a0, ae, withAlpha(c, 0.14));
        cv.arc(cx, cy, r - thick, r, a0, ae, c, hot ? { round: true, ramp: hot, rampFrom: a0, rampTo: limA }
            : inZone || !t.ramp ? { round: true } : { round: true, ramp: t.ramp, rampFrom: a0, rampTo: a1 });
        const a = ae * Math.PI / 180, rm = r - thick / 2;
        cv.circle(cx + Math.sin(a) * rm, cy - Math.cos(a) * rm, thick * 0.5 + 4, withAlpha(t.text, 0.25));
        cv.circle(cx + Math.sin(a) * rm, cy - Math.cos(a) * rm, thick * 0.5 + 1, t.text);
    }
    if (isNum(g.peak) && g.peak > min) {
        const pa = (a0 + clamp((g.peak - min) / (max - min), 0, 1) * 270) * Math.PI / 180;
        cv.line(cx + Math.sin(pa) * (r - thick), cy - Math.cos(pa) * (r - thick), cx + Math.sin(pa) * (r + 10), cy - Math.cos(pa) * (r + 10), 3, t.accent2);
    }
    const big = Math.round(r * 0.62);
    cv.text(fmt(v, g.decimals), cx, cy + big * 0.32, big, isNum(v) ? t.text : t.dim, { align: 'center', font: 'num' });
    if (isNum(g.peak) && g.showPeak !== false) cv.text('PEAK ' + fmt(g.peak, g.decimals), cx, cy + r * 0.82 + 32, 22, t.accent2, { align: 'center', font: 'label', spacing: 1 });
}

/* ---------------- needle dial ---------------- */
/**
 * Analogue dial with a needle (240 degrees). g = value object + { redFrom } (red scale from
 * there), { div } for the numbers (1000 for rpm x1000).
 */
function needle(cv, t, cx, cy, r, g) {
    const min = g.min || 0, max = g.max == null ? 100 : g.max, A0 = -120, SPAN = 240;
    const v = g.value, sv = sm(g, 'needle|' + cx + '|' + cy, v);
    const S = Math.ceil(r + 12);
    const key = ['needle', r, min, max, g.ticks, g.redFrom, g.div, g.label || '', g.unit || '', t.name].join('|');
    cv.blit(layer(key, 2 * S, 2 * S, (c) => {
        const x = S, y = S, n = g.ticks || 10;
        c.circle(x, y, r, withAlpha('#b4bccc', 0.06));
        c.arc(x, y, r - 3, r, A0, A0 + SPAN, withAlpha(t.tick, 0.7));
        if (isNum(g.redFrom)) c.arc(x, y, r - 14, r - 4, A0 + clamp((g.redFrom - min) / (max - min), 0, 1) * SPAN, A0 + SPAN, withAlpha(t.crit, 0.85));
        for (let i = 0; i <= n * 2; i++) {
            const a = (A0 + i / (n * 2) * SPAN) * Math.PI / 180, major = i % 2 === 0;
            const ri = r - (major ? 26 : 16), ro = r - 6;
            c.line(x + Math.sin(a) * ri, y - Math.cos(a) * ri, x + Math.sin(a) * ro, y - Math.cos(a) * ro, major ? 4 : 2, major ? t.text : t.tick);
            if (major) {
                const val = min + i / (n * 2) * (max - min), lr = r - 52;
                c.text(fmt(val / (g.div || 1), 0), x + Math.sin(a) * lr, y - Math.cos(a) * lr + 10, Math.max(20, r * 0.13),
                    isNum(g.redFrom) && val >= g.redFrom ? t.crit : t.text, { align: 'center', font: 'bold' });
            }
        }
        if (g.label) c.text(upperText(g.label), x, y + r * 0.42, 20, t.dim, { align: 'center', font: 'bold', spacing: 2 });
    }, cv.textScale), Math.round(cx) - S, Math.round(cy) - S);
    const f = isNum(sv) ? clamp((sv - min) / (max - min), 0, 1.02) : 0;
    const a = (A0 + f * SPAN) * Math.PI / 180, sx = Math.sin(a), cy_ = -Math.cos(a);
    const nc = isNum(g.redFrom) && isNum(sv) && sv >= g.redFrom ? t.crit : (t.needle || t.sel || t.accent);
    cv.line(cx - sx * r * 0.12, cy - cy_ * r * 0.12, cx + sx * (r - 10), cy + cy_ * (r - 10), 9, withAlpha(nc, 0.25));
    cv.line(cx - sx * r * 0.12, cy - cy_ * r * 0.12, cx + sx * (r - 10), cy + cy_ * (r - 10), 5, nc);
    cv.circle(cx, cy, r * 0.09, t.track); cv.circle(cx, cy, r * 0.05, nc);
    cv.text(fmt(v, g.decimals), cx, cy + r * 0.72, Math.round(r * 0.26), isNum(v) ? t.text : t.dim, { align: 'center', font: 'num' });
    if (g.unit) cv.text(g.unit, cx, cy + r * 0.72 + 26, 20, t.dim, { align: 'center' });
}

/* ---------------- ring ---------------- */
/** Progress ring: g = { value, min, max, label, unit, decimals, color, text (instead of the value) }. */
function ring(cv, t, cx, cy, r, g) {
    const min = g.min || 0, max = g.max == null ? 100 : g.max, v = g.value, sv = sm(g, 'ring|' + cx + '|' + cy, v);
    const th = g.thick || Math.max(8, r * 0.14), c = zoneColor(t, g, sv, col(t, g.color, t.sel || t.accent));
    cv.arc(cx, cy, r - th, r, 0, 360, t.track);
    if (isNum(sv)) { const f = clamp((sv - min) / (max - min), 0, 1); if (f > 0.003) cv.arc(cx, cy, r - th, r, 0, f * 360, c, { round: true }); }
    const big = g.size || Math.round(r * 0.55);
    const tw = cv.text(g.text != null ? g.text : fmt(v, g.decimals), cx, cy + big * 0.34, big, isNum(v) || g.text != null ? t.text : t.dim, { align: 'center', font: 'num' });
    if (g.unit) cv.text(g.unit, cx + tw / 2 + 4, cy + big * 0.34, 22, t.dim);
    if (g.label) cv.text(upperText(g.label), cx, cy + r + 30, 18, t.dim, { align: 'center', font: 'bold', spacing: 2 });
}

/* ---------------- bars ---------------- */
/** Nice scale step (1, 2, 2.5, 5 x 10^n) for about n divisions of max. */
function niceStep(max, n) {
    const raw = max / n, e = Math.pow(10, Math.floor(Math.log10(raw)));
    return [1, 2, 2.5, 5, 10].map((m) => m * e).find((v) => v >= raw * 0.999) || raw;
}
/** Slanted slab (OEM bar shape): x0..x1 measured on the bottom edge, top edge shifted right by sl. */
function slab(cv, x0, x1, y, h, sl, c) {
    if (x1 - x0 <= 0) return;
    cv.quad([[x0 + sl, y], [x1 + sl, y], [x1, y + h], [x0, y + h]], c);
}

/** Slanted slab filled with a colour ramp along x (ramp spans spanX..spanX+spanW). */
function rampSlab(cv, x0, x1, y, h, sl, stops, spanX, spanW) {
    if (x1 - x0 <= 0 || h <= 0) return;
    const at = (x) => ramp(stops, clamp((x - spanX) / spanW, 0, 1));
    if (x1 - x0 <= sl) { slab(cv, x0, x1, y, h, sl, at((x0 + x1) / 2 + sl / 2)); return; }
    cv.rampRect(x0 + sl, y, x1 - x0 - sl, h, 0, stops, spanX, spanW);       // the upright middle
    cv.quad([[x0 + sl, y], [x0 + sl, y], [x0 + sl, y + h], [x0, y + h]], at(x0 + sl / 2));   // left end
    cv.quad([[x1, y], [x1 + sl, y], [x1, y + h], [x1, y + h]], at(x1 + sl / 2));             // right end
}

/**
 * Bar gauge in the OEM (G20 sport display) style: label / value header, a slanted grey track,
 * the fill in the theme's bar colour (lighter upper part) ending in a white stripe, a white
 * scale line under it with numbers, and the peak ("hang") along the top edge.
 * g.niceMax: extend the scale to the next round number; g.ramp = 'hot': tach colours along
 * the scale; g.color: fill colour (theme key or #hex).
 * g.origin: the fill runs from this value to the value, both ways (regen / use), with a white mark
 * on it; below it in g.negColor. g.head: false leaves out the label / value row (the bar at y).
 * g.track: the empty track's colour. g.ticks: the values marked on the scale line; g.labels:
 * [{ value, text, color, align }] in place of its numbers. g.text / g.valueColor: the value row's text and colour
 * in place of the formatted value.
 */
function bar(cv, t, x, y, w, h, g) {
    const min = g.min || 0, v = g.value;
    let max = g.max == null ? 100 : g.max;
    const step = g.step || niceStep(max - min, 4);
    if (g.niceMax) max = min + Math.ceil((max - min) / step - 1e-9) * step;
    const sv = sm(g, 'bar|' + x + '|' + y, v), head = g.head !== false;
    if (head) {
        cv.text(upperText(g.label || ''), x, y + 26, 22, t.dim, { font: 'bold', spacing: 2 });
        const uw = g.unit ? cv.textWidth(' ' + g.unit, 26) : 0;
        cv.text(g.text != null ? g.text : fmt(v, g.decimals), x + w - uw, y + 30, 44, g.valueColor ? t[g.valueColor] || g.valueColor : isNum(v) ? t.text : t.dim, { align: 'right', font: 'num' });
        if (g.unit) cv.text(' ' + g.unit, x + w, y + 30, 26, t.dim, { align: 'right' });
    }
    const bh = 22, by = y + (head ? 44 : 0), SL = 18, bw = w - SL;
    const X = (val) => x + clamp((val - min) / (max - min), 0, 1) * bw;
    slab(cv, x, x + bw, by, bh, SL, g.track ? t[g.track] || g.track : withAlpha('#d4d8de', 0.34));
    const base = g.color ? t[g.color] || g.color : t.bar || t.accent, c = zoneColor(t, g, sv, base);
    const stops = g.ramp === 'hot' && c === base ? t.hotRamp || t.ramp : null;
    const o = g.origin == null ? min : clamp(g.origin, min, max), xo = X(o);
    const cap = 7, top = Math.round(bh * 0.42), oT = SL * (bh - top) / bh;
    if (isNum(sv) && sv > o && X(sv) > xo) {
        const xe = X(sv), span = x + bw + SL - xo;
        if (stops) {
            // colour of its position on the scale; the upper part lighter
            const lite = stops.map((s) => mix(s, '#ffffff', 0.28));
            rampSlab(cv, xo, xe, by + top, bh - top, oT, stops, xo, span);
            rampSlab(cv, xo + oT, xe + oT, by, top, SL - oT, lite, xo, span);
        } else {
            slab(cv, xo, xe, by, bh, SL, c);
            cv.quad([[xo + SL, by], [xe + SL, by], [xe + oT, by + top], [xo + oT, by + top]], mix(c, '#ffffff', 0.28));
        }
        if (xe - xo > cap + 4) { slab(cv, xe - cap - 3, xe - cap, by, bh, SL, t.bg); slab(cv, xe - cap, xe, by, bh, SL, '#ffffff'); }
    } else if (isNum(sv) && sv < o && X(sv) < xo) {
        // below the origin: the fill runs left, its white stripe at the left end
        const xe = X(sv), nc = g.negColor ? t[g.negColor] || g.negColor : c;
        slab(cv, xe, xo, by, bh, SL, nc);
        cv.quad([[xe + SL, by], [xo + SL, by], [xo + oT, by + top], [xe + oT, by + top]], mix(nc, '#ffffff', 0.28));
        if (xo - xe > cap + 4) { slab(cv, xe + cap, xe + cap + 3, by, bh, SL, t.bg); slab(cv, xe, xe + cap, by, bh, SL, '#ffffff'); }
    }
    if (g.origin != null) cv.line(xo + SL + 5, by - 6, xo - 5, by + bh + 6, 3, t.text);
    if (isNum(g.peak) && (g.peak - min) / (max - min) > 0.02) {
        const px = X(g.peak), hc = t.hang || (stops ? ramp(stops, (px - x) / bw) : c);
        cv.fillRect(x + SL, by - 2, px - x, 5, hc);
        if (!isNum(sv) || g.peak > sv) cv.line(px + SL, by, px, by + bh, 4, hc);
    }
    const dec = g.scaleDecimals != null ? g.scaleDecimals : step % 1 ? 1 : 0;
    let marks = g.ticks;
    if (!marks) {
        marks = [];
        for (let a = min; a <= max + 1e-9; a += step) marks.push(a);
        if (max - marks[marks.length - 1] > step * 0.45) marks.push(max);
    }
    cv.fillRect(x, by + bh + 2, bw, 2, withAlpha('#ffffff', 0.85));
    marks.forEach((a) => { if (a > min + 1e-9 && a < max - 1e-9) cv.fillRect(X(a) - 2, by + bh + 2, 4, 2, t.bg); });
    if (h >= (head ? 80 : 50)) {
        (g.labels || marks.map((a) => ({ value: a, text: fmt(a, dec) }))).forEach((l) =>
            cv.text(l.text, X(l.value), by + bh + 26, 20, l.color ? t[l.color] || l.color : withAlpha(t.text, 0.85), { align: l.align || 'center', font: 'bold' }));
    }
}

/**
 * Tach bar widget (the Redline rev bar as a widget): digital value top right, a slanted bar
 * filling left to right in segments, scale below. g = { label, value, unit, decimals, min, max,
 * step (segment size), scale: { every, div, decimals }, peak, marks: [{ value, color }],
 * ramp: 'hot' (theme hot ramp to red at g.limit, solid red above) or zones / g.color per segment }.
 * g.panel = false: no panel / title (just the bar in x, y, w, h).
 */
function segBar(cv, t, x, y, w, h, g) {
    if (g.panel !== false) { h = stretch(cv, y, h); box(cv, t, x, y, w, h, g.label); }   // (the bar grows with its panel)
    const min = g.min || 0, max = g.max, v = g.value, sv = sm(g, 'seg|' + x + '|' + y, v), step = g.step || (max - min) / 16, SL = 18;
    const hot = g.ramp === 'hot', lim = g.limit == null ? max : g.limit, over = hot && isNum(v) && v >= lim;
    const base = g.color ? t[g.color] || g.color : t.accent;
    const segCol = (mid) => (over ? '#ff2a2a' : hot ? ramp(t.hotRamp || t.ramp, clamp((mid - min) / (lim - min), 0, 1)) : zoneColor(t, g, mid, base));
    const uw = g.unit ? cv.textWidth(' ' + g.unit, 26) : 0;
    if (g.panel !== false) {
        cv.text(fmt(v, g.decimals), x + w - 24 - uw, y + 60, 64, !isNum(v) ? t.dim : over ? '#ff4a4a' : t.text, { align: 'right', font: 'num' });
        if (g.unit) cv.text(' ' + g.unit, x + w - 24, y + 60, 26, t.dim, { align: 'right' });
    }
    const bx = x + (g.panel !== false ? 24 : 0), bw = w - (g.panel !== false ? 48 : 0) - SL;
    // (in a panel: the scale's labels end ~20 px over its bottom, as other panels' last lines do)
    const y0 = g.panel !== false ? y + 80 : y, y1 = g.panel !== false ? y + Math.max(130, h - 64) : y + h;
    const X = (val) => bx + clamp((val - min) / (max - min), 0, 1) * bw;
    const band = (a, b, c, pad) => {
        pad = pad || 0; const xa = X(a), xb = X(b);
        if (xb - xa <= 0) return;
        cv.quad([[xa + SL - pad, y0 - pad], [xb + SL + pad, y0 - pad], [xb + pad, y1 + pad], [xa - pad, y1 + pad]], c);
    };
    const gapAt = (val, c) => { const xx = X(val); cv.quad([[xx + SL - 1.5, y0], [xx + SL + 1.5, y0], [xx + 1.5, y1], [xx - 1.5, y1]], c); };
    band(min, max, t.track);
    if (hot && lim < max) band(lim, max, withAlpha(t.crit, 0.3));
    for (const z of g.zones || []) if (!z.tintOnly && (z.color === 'warn' || z.color === 'crit')) band(Math.max(min, z.from), Math.min(max, z.to), withAlpha(t[z.color], 0.25));
    if (isNum(sv) && sv > min) {
        const vv = Math.min(sv, max);
        band(min, vv, withAlpha(segCol(vv), 0.14), 6);
        for (let a = min; a < vv; a += step) band(a, Math.min(vv, a + step), segCol(a + step / 2));
        const xe = X(vv);
        cv.line(xe, y1 + 4, xe + SL, y0 - 4, 6, '#ffffff');
    }
    for (let a = min + step; a < max - 1e-9; a += step) gapAt(a, t.bg);
    if (isNum(g.peak) && (g.peak - min) / (max - min) > 0.02) {
        const pk = Math.min(g.peak, max), pc = t.hang || (hot && pk >= lim ? '#ff2a2a' : hot ? ramp(t.hotRamp || t.ramp, clamp((pk - min) / (lim - min), 0, 1)) : zoneColor(t, g, pk, base));
        if (g.hangTop !== false) cv.fillRect(bx + SL, y0 - 2, X(pk) - bx, 5, pc);
        if (!isNum(sv) || g.peak > sv) cv.line(X(pk) + SL, y0, X(pk), y1, g.hangTop === false ? 3 : 4, pc);
    }
    for (const m of g.marks || []) { const xx = X(m.value) + SL; cv.fillRect(xx - 2, y0 - 14, 4, 12, t[m.color] || m.color); }
    const sc = g.scale || {};
    for (let a = min; a <= max + 1e-9; a += step) {
        const xx = X(a), lab = sc.every && Math.abs((a - min) / sc.every - Math.round((a - min) / sc.every)) < 1e-6;
        cv.fillRect(xx - (lab ? 1.5 : 1), y1 + 8, lab ? 3 : 2, lab ? (sc.tick || 12) : 7, lab ? (hot && a >= lim ? t.crit : t.text) : t.tick);
        if (lab) cv.text(fmt(a / (sc.div || 1), sc.decimals || 0), xx, y1 + (sc.labelY || 42), sc.size || 24, hot && a >= lim ? t.crit : sc.labelColor ? t[sc.labelColor] || sc.labelColor : t.dim, { align: 'center', font: 'bold' });
    }
}

/* ---------------- tiles / readouts ---------------- */
/** Stat tile: label, big value + unit, optional history trace. */
function stat(cv, t, x, y, w, h, g) {
    // the trace and the sub line follow a stretched panel's bottom (hb); sizes keep to the tile's own h
    const hb = stretch(cv, y, h);
    box(cv, t, x, y, w, hb, g.label);
    const v = g.value, c = zoneColor(t, g, v, g.color ? t[g.color] || g.color : t.accent);
    const vcol = zoneColor(t, g, v, g.valueColor ? t[g.valueColor] || g.valueColor : t.text);
    const hist = (g.history || []).filter(isNum), size = g.size || Math.min(96, h * 0.42), vy = y + 52 + size * 0.78;
    if (hist.length > 2 && h > 150) {
        // (the trace stays under the value: at most up to 8 px under its baseline)
        const hx = x + 18, hw = w - 36, hy = y + hb - (g.sub ? MARGIN + 28 : MARGIN), hh = Math.min(60, h * 0.25, hy - vy - 8);
        let lo = Math.min.apply(null, hist), hi = Math.max.apply(null, hist);
        if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
        const pts = g.history.map((p, i) => [hx + (i / Math.max(1, g.history.length - 1)) * hw, isNum(p) ? hy - ((p - lo) / (hi - lo)) * hh : hy]);
        cv.fillUnder(pts, hy, withAlpha(c, 0.16));
        cv.polyline(pts, 2.5, withAlpha(c, 0.85));
    }
    const vs = fmt(v, g.decimals);
    const vw = cv.textWidth(vs, size, { font: 'num' });
    cv.text(vs, x + 18, vy, size, isNum(v) ? vcol : t.dim, { font: 'num' });
    if (g.unit) cv.text(g.unit, x + 26 + vw, vy, 28, t.dim);
    if (g.sub) cv.text(g.sub, x + 18, y + hb - MARGIN, 22, t.dim, { spacing: 0.5 });
}

/**
 * Label + big value + unit, no panel. (x, y) = top left (align 'left'), top right ('right')
 * or top centre ('center'). g = { label, value, text (instead of value), unit, decimals, size,
 * color, zones, labelSize }. Returns the drawn height.
 */
function readout(cv, t, x, y, g) {
    const al = g.align || 'left', size = g.size || 64, ls = g.labelSize || 18;
    let yy = y;
    if (g.label) { cv.text(upperText(g.label), x, y + ls, ls, t.dim, { align: al, font: 'bold', spacing: 2 }); yy += ls + 10; }
    const v = g.value, s = g.text != null ? String(g.text) : fmt(v, g.decimals);
    const has = g.text != null || isNum(v), c = has ? zoneColor(t, g, v, col(t, g.color, t.text)) : t.dim;
    const us = g.unit ? ' ' + g.unit : '', uz = Math.max(18, Math.round(size * 0.36));
    const vw = cv.textWidth(s, size, { font: g.font || 'num' }), uw = us ? cv.textWidth(us, uz) : 0;
    const base = yy + size * 0.78;
    const left = al === 'right' ? x - vw - uw : al === 'center' ? x - (vw + uw) / 2 : x;
    cv.text(s, left, base, size, c, { font: g.font || 'num' });
    if (us) cv.text(us, left + vw, base, uz, t.dim);
    return base - y + 8;
}

/**
 * Shift lights: n lights over w, lit from (shift - range) to shift; all strobe at / above
 * shift. g = { rpm, shift, range (2000), n (12), style: 'gyr' | 'f1' | 'mono', blink (phase) }.
 */
function shiftLights(cv, t, x, y, w, h, g) {
    const n = g.n || 12, range = g.range || 2000, gap = g.gap || 10, lw = (w - gap * (n - 1)) / n;
    const GREEN = '#2fd27a', YELLOW = '#ffc21a', RED = '#ff2a2a', BLUE = '#2a7dff';
    const cols = Array.from({ length: n }, (_, i) => {
        const f = i / (n - 1);
        if (g.style === 'mono') return t.accent;
        if (g.style === 'f1') return f < 0.42 ? GREEN : f < 0.84 ? RED : BLUE;
        return f < 0.42 ? GREEN : f < 0.75 ? YELLOW : RED;
    });
    const rpm = g.rpm, start = g.shift - range;
    const lit = isNum(rpm) ? clamp((rpm - start) / range, 0, 1) * n : 0;
    const strobe = isNum(rpm) && rpm >= g.shift;
    for (let i = 0; i < n; i++) {
        const lx = x + i * (lw + gap);
        let c = withAlpha(cols[i], 0.12);
        const part = clamp(lit - i, 0, 1);                  // a light fades in as rpm crosses it
        if (strobe) c = g.blink ? (g.style === 'f1' ? BLUE : RED) : withAlpha(RED, 0.15);
        if ((strobe && g.blink) || (!strobe && part > 0)) cv.roundRect(lx - 4, y - 4, lw + 8, h + 8, 10, withAlpha(strobe ? c : cols[i], 0.25 * (strobe ? 1 : part)));
        cv.roundRect(lx, y, lw, h, 7, c);
        if (!strobe && part > 0) cv.roundRect(lx, y, lw, h, 7, withAlpha(cols[i], part));
    }
    return strobe;
}

/** Big gear / selector: g = { gear (number, -1 R, 0 N), stage ('P','R','N','D'), size, color, guessed }. */
function gear(cv, t, cx, baseY, g) {
    const gr = g.gear, st = g.stage;
    const s = st === 'P' || st === 'R' || st === 'N' ? st : gr === -1 ? 'R' : isNum(gr) && gr > 0 ? String(gr) : st === 'D' ? 'D' : gr === 0 ? 'N' : '-';
    const size = g.size || 200;
    cv.text(s, cx, baseY, size, col(t, g.color, t.text), { align: 'center', font: 'gear' });
    if (g.guessed && isNum(gr) && gr > 0) cv.text('EST.', cx + size * 0.45, baseY - size * 0.74, 16, t.dim, { font: 'bold', spacing: 1.5 });
    return s;
}

/* ---------------- chart / table / pill ---------------- */
/**
 * Line chart: axes, grid and labels, then series. g = { xMin, xMax, yMin, yMax, xStep, yStep,
 * xFmt(v), yFmt(v), xUnit, yUnit, series: [{ pts: [[x, y], ...], color, width, fill, dash }],
 * marks: [{ y, color, label }], empty (text when there are no points) }.
 */
function chart(cv, t, x, y, w, h, g) {
    const x0 = g.xMin || 0, x1 = g.xMax == null ? 1 : g.xMax, y0 = g.yMin || 0, y1 = g.yMax == null ? 1 : g.yMax;
    const pad = { l: g.padLeft == null ? 44 : g.padLeft, b: g.padBottom == null ? 26 : g.padBottom, r: g.padRight || 8, t: g.padTop || 8 };
    const px = x + pad.l, pw = w - pad.l - pad.r, py = y + pad.t, ph = h - pad.t - pad.b;
    const X = (v) => px + (v - x0) / (x1 - x0) * pw, Y = (v) => py + ph - (v - y0) / (y1 - y0) * ph;
    const ys = g.yStep || niceStep(y1 - y0, 4), xs = g.xStep || niceStep(x1 - x0, 5);
    const yf = g.yFmt || ((v) => fmt(v, ys % 1 ? 1 : 0)), xf = g.xFmt || ((v) => fmt(v, xs % 1 ? 1 : 0));
    for (let v = y0; v <= y1 + 1e-9; v += ys) {
        cv.fillRect(px, Math.round(Y(v)), pw, 1, withAlpha(t.tick, v === y0 ? 0.6 : 0.25));
        cv.text(yf(v), px - 8, Y(v) + 6, 16, t.dim, { align: 'right' });
    }
    for (let v = x0; v <= x1 + 1e-9; v += xs) cv.text(xf(v) + (g.xUnit && v + xs > x1 + 1e-9 ? ' ' + g.xUnit : ''), X(v), py + ph + 20, 16, t.dim, { align: 'center' });
    if (g.yUnit) cv.text(g.yUnit, px - 8, py - 2, 14, t.dim, { align: 'right', font: 'bold' });
    for (const m of g.marks || []) {
        cv.fillRect(px, Math.round(Y(m.y)), pw, 1, withAlpha(col(t, m.color, t.warn), 0.6));
        if (m.label) cv.text(m.label, px + pw - 4, Y(m.y) - 5, 14, col(t, m.color, t.warn), { align: 'right' });
    }
    let any = false;
    cv.clip(px, py - 4, pw, ph + 8);
    for (const s of g.series || []) {
        const pts = (s.pts || []).filter((p) => isNum(p[0]) && isNum(p[1])).map((p) => [X(p[0]), Y(clamp(p[1], y0 - (y1 - y0) * 0.02, y1 + (y1 - y0) * 0.02))]);
        if (pts.length < 2) continue;
        any = true;
        const c = col(t, s.color, t.accent);
        if (s.fill) cv.fillUnder(pts, Y(y0), withAlpha(c, typeof s.fill === 'number' ? s.fill : 0.16));
        if (s.dash) {
            for (let i = 1; i < pts.length; i++) {
                const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
                cv.line(ax, ay, ax + (bx - ax) * 0.5, ay + (by - ay) * 0.5, s.width || 2, c);
            }
        } else cv.polyline(pts, s.width || 2.5, c);
    }
    cv.noclip();
    if (!any && g.empty) cv.text(g.empty, px + pw / 2, py + ph / 2, 22, t.dim, { align: 'center' });
    return { X, Y, px, py, pw, ph };
}

/**
 * Table: cols = [{ label, w, align, color, font, size }], rows = [[cell, ...], ...] where a cell
 * is text or { text, color }. g = { rowH (40), headerSize (16), size (24), empty, stripe }.
 */
function table(cv, t, x, y, w, cols, rows, g) {
    g = g || {};
    const rh = g.rowH || 40, hs = g.headerSize || 16, sz = g.size || 24;
    let cx = x;
    const xs = cols.map((c) => { const at = cx; cx += c.w; return at; });
    cols.forEach((c, i) => {
        const al = c.align || 'left', tx = al === 'right' ? xs[i] + c.w - 8 : al === 'center' ? xs[i] + c.w / 2 : xs[i];
        cv.text(upperText(c.label || ''), tx, y + hs, hs, t.dim, { align: al, font: 'bold', spacing: 1.5 });
    });
    const top = y + hs + 14;
    if (!rows.length && g.empty) { cv.text(g.empty, x, top + rh * 0.8, 24, t.dim); return; }
    rows.forEach((r, k) => {
        const ry = top + k * rh;
        if (g.stripe !== false && k % 2 === 1) cv.fillRect(x - 8, ry, w + 16, rh, withAlpha('#ffffff', 0.03));
        cols.forEach((c, i) => {
            const cell = r[i];
            if (cell == null) return;
            const txt = typeof cell === 'object' ? cell.text : cell, cc = typeof cell === 'object' && cell.color ? col(t, cell.color, t.text) : col(t, c.color, t.text);
            const al = c.align || 'left', tx = al === 'right' ? xs[i] + c.w - 8 : al === 'center' ? xs[i] + c.w / 2 : xs[i];
            cv.text(String(txt), tx, ry + rh * 0.68, c.size || sz, cc, { align: al, font: (typeof cell === 'object' && cell.font) || c.font || 'label' });
        });
    });
}

/** Rounded status label: g = { color, filled (alpha), size, spacing }. Returns its width. */
function pill(cv, t, x, y, w, h, text, g) {
    g = g || {};
    const c = col(t, g.color, t.accent);
    cv.roundRect(x, y, w, h, Math.min(10, h / 2), withAlpha(c, g.filled == null ? 0.22 : g.filled));
    cv.text(String(text), x + w / 2, y + h / 2 + (g.size || 20) * 0.36, g.size || 20, g.textColor ? col(t, g.textColor, t.text) : c, { align: 'center', font: 'bold', spacing: g.spacing == null ? 2 : g.spacing });
    return w;
}

/* ---------------- tyres / g-meter ---------------- */
/** Top-down tyre map: four tyres coloured by temperature or pressure. */
function tyres(cv, t, x, y, w, h, g) {
    panel(cv, t, x, y, w, h, g.label || 'Tyres');
    const cx = x + w / 2, top = y + 64, bh = h - 90;
    const bw = Math.min(w * 0.28, bh * 0.45);
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
            const tv = fmt(val, g.decimals) + (isNum(val) && g.unit ? g.unit : '');
            cv.text(tv, lx, ty + th * 0.42, 34, isNum(val) ? t.text : t.dim, { align: al, font: 'num' });
            const pv = g.pressure[k], tgt = g.pressure.target ? g.pressure.target[k] : null;
            let pc = isNum(pv) ? t.text : t.dim;
            if (isNum(pv) && isNum(tgt) && tgt > 0) { const r = pv / tgt; pc = r < 0.85 ? t.crit : r < 0.93 ? t.warn : r > 1.15 ? t.warn : t.ok; }
            cv.text(fmt(pv, g.pressure.decimals == null ? 1 : g.pressure.decimals), lx, ty + th * 0.42 + 40, 34, pc, { align: al, font: 'num' });
            cv.text(g.pressure.unit || 'bar', lx, ty + th * 0.42 + 64, 22, t.dim, { align: al });
        } else {
            cv.text(fmt(val, g.decimals), lx, ty + th / 2 + 6, 40, isNum(val) ? t.text : t.dim, { align: al, font: 'num' });
            if (g.unit) cv.text(g.unit, lx, ty + th / 2 + 34, 22, t.dim, { align: al });
        }
    }
}

/**
 * Friction circle: lateral (x) / longitudinal (y) acceleration in g, with a fading trail.
 * g = { lat, long, trail: [[lat,long],...], max }. The dot glides (smoothing).
 */
function gmeter(cv, t, cx, cy, r, g) {
    const max = g.max || 1.5;
    const key = ['gmeter', r, max, t.name].join('|'), S = Math.ceil(r + 4);
    cv.blit(layer(key, 2 * S + 80, 2 * S, (c) => {
        const x = S, y = S;
        for (let ring_ = 0.5; ring_ <= max + 1e-6; ring_ += 0.5) {
            const rr = (ring_ / max) * r;
            c.arc(x, y, rr - 1.5, rr + 1.5, 0, 360, ring_ % 1 === 0 ? t.tick : withAlpha(t.tick, 0.5));
            c.text(ring_.toFixed(1), x + rr * 0.7071 + 6, y - rr * 0.7071 - 4, 22, t.dim);
        }
        c.line(x - r, y, x + r, y, 2, withAlpha(t.tick, 0.6));
        c.line(x, y - r, x, y + r, 2, withAlpha(t.tick, 0.6));
        c.text('BRAKE', x, y + r - 14, 22, t.dim, { align: 'center', font: 'bold', spacing: 1.5 });
        c.text('ACCEL', x, y - r + 32, 22, t.dim, { align: 'center', font: 'bold', spacing: 1.5 });
    }, cv.textScale), Math.round(cx) - S, Math.round(cy) - S);
    const P = (lat, lon) => [cx + clamp(lat / max, -1.1, 1.1) * r, cy - clamp(lon / max, -1.1, 1.1) * r];
    const tr = g.trail || [];
    tr.forEach((p, i) => {
        if (!isNum(p[0]) || !isNum(p[1])) return;
        const [x, y] = P(p[0], p[1]);
        cv.circle(x, y, 4, withAlpha(t.accent, 0.08 + 0.5 * (i / tr.length)));
    });
    const lat = sm(g, 'gm-lat|' + cx + '|' + cy, g.lat), lon = sm(g, 'gm-lon|' + cx + '|' + cy, g.long);
    if (isNum(lat) && isNum(lon)) {
        const [x, y] = P(lat, lon);
        cv.circle(x, y, 16, withAlpha(t.accent, 0.25));
        cv.circle(x, y, 10, t.accent);
        cv.circle(x, y, 4, t.text);
        const tot = Math.sqrt(g.lat * g.lat + g.long * g.long);
        cv.text(tot.toFixed(2) + ' g', cx, cy + r + 44, 40, t.text, { align: 'center', font: 'num' });
    } else {
        cv.text('-- g', cx, cy + r + 44, 40, t.dim, { align: 'center', font: 'num' });
    }
}

/* ---------------- frame / header / menu bar ---------------- */
/*
 * Page tabs. Pages draw their content from G.TOP to G.BOTTOM; badges = [{ text, color }].
 * On the full-screen layout (GPU renderer) the frame surface carries a `chrome` object: the
 * tabs go there and the display draws them in the header up in the HMI's title strip, so the
 * page content gets the whole screen below it. Otherwise a slim tab bar (BAR_H) along the top.
 * Each drawn tab is left in cv.tabRects ({ i, x, y, w, h }), so a touch on it can open that page.
 */
const BAR_H = 36, TOP = 44, BOTTOM = 512;
/**
 * Tab widths: each name's width plus `pad`, at least `min`; when that doesn't fit in `room` the
 * padding shrinks (down to `pad0`) and the minimum goes, so many tabs still show side by side.
 */
function tabWidths(cv, names, size, opt, min, pad, room, pad0) {
    const tw = names.map((n) => cv.textWidth(n, size, opt));
    const wide = tw.map((w) => Math.max(min, w + pad));
    if (wide.reduce((a, b) => a + b, 0) <= room) return wide;
    const p = Math.max(pad0, Math.min(pad, (room - tw.reduce((a, b) => a + b, 0)) / Math.max(1, names.length)));
    return tw.map((w) => w + p);
}
function frame(cv, t, tabs, sel, badges) {
    if (cv.chrome) { cv.chrome.tabs = { tabs: tabs || [], sel, badges: (badges || []).filter(Boolean) }; return; }
    const W = cv.w, S = t.sel || t.accent;
    cv.fillRect(0, 0, W, BAR_H, t.bg);
    cv.fillRect(0, 0, W, BAR_H, withAlpha('#ffffff', 0.07));
    cv.fillRect(0, BAR_H - 1, W, 1, withAlpha('#ffffff', 0.18));
    const opt = { align: 'center', font: 'bold', spacing: 1.5 };
    const live = (badges || []).filter(Boolean);
    const labels = (tabs || []).map((n) => upperText(n));
    const badgesW = live.reduce((a, b) => a + Math.max(24 * 3.5, cv.textWidth(b.text, 18, opt) + 24) + 24 * 0.4, 0);
    const widths = tabWidths(cv, labels, 20, opt, 150, 48, W - 32 - badgesW, 20);
    let x = 16;
    cv.tabRects = [];
    labels.forEach((label, i) => {
        const tw = widths[i], on = i === sel;
        cv.tabRects.push({ i, x, y: 0, w: tw, h: BAR_H });
        if (on) {
            cv.gradientRect(x, 0, tw, BAR_H, [[0, withAlpha(S, 0)], [1, withAlpha(S, 0.22)]]);
            cv.fillRect(x, BAR_H - 4, tw, 4, S);
        }
        cv.text(label, x + tw / 2, 25, 20, on ? t.selText || S : t.dim, opt);
        if (i < tabs.length - 1) cv.fillRect(x + tw, 9, 1, BAR_H - 18, withAlpha('#ffffff', 0.12));
        x += tw;
    });
    badgeRow(cv, t, W - 16, 6, 24, 18, (badges || []).filter(Boolean));
}

/** Badges right-aligned at xr (right edge), top y, height h, text size. Returns the left edge. */
function badgeRow(cv, t, xr, y, h, size, badges) {
    const opt = { align: 'center', font: 'bold', spacing: 1.5 };
    let bx = xr;
    badges.forEach((b) => {
        const bw = Math.max(h * 3.5, cv.textWidth(b.text, size, opt) + h), c = t[b.color] || b.color || t.warn;
        cv.roundRect(bx - bw, y, bw, h, h * 0.2, withAlpha(c, 0.2));
        cv.text(b.text, bx - bw / 2, y + h / 2 + size * 0.36, size, c, opt);
        bx -= bw + h * 0.4;
    });
    return bx;
}

/**
 * Full-screen header in screen pixels (x, y, w, h): the app's name, its page tabs (selected
 * one lit, with an underline) and badges on the right. Tabs that don't fit drop the name.
 * flat: no sheen (plain t.bg).
 * compact: smaller text, badges right after the tabs and only as wide as that content, so the
 * HMI's own status strip (radio station, phone signal, icons) can show to the right of it.
 * Returns the x where the header's content ends.
 */
function header(cv, t, x, y, w, h, title, tabs, sel, badges, flat, compact) {
    if (compact) return headerCompact(cv, t, x, y, w, h, title, tabs, sel, badges);
    const S = t.sel || t.accent, opt = { align: 'center', font: 'bold', spacing: 2 };
    cv.fillRect(x, y, w, h, t.bg);
    // flat: plain, to match the HMI's own black strip next to it
    if (!flat) cv.gradientRect(x, y, w, h, [[0, withAlpha('#ffffff', 0.02)], [1, withAlpha('#ffffff', 0.08)]]);
    cv.fillRect(x, y + h - 2, w, 2, withAlpha('#ffffff', 0.22));
    const right = badgeRow(cv, t, x + w - 16, y + (h - 30) / 2, 30, 18, badges || []);
    const names = (tabs || []).map((n) => upperText(n));
    const tw = tabWidths(cv, names, 20, opt, 170, 64, right - x - 20, 24);
    const tabsW = tw.reduce((a, b) => a + b, 0);
    let tx = x + 20;
    const tsize = 38, titleW = title ? cv.textWidth(title, tsize) : 0;
    if (title && tx + titleW + 40 + tabsW <= right) {
        cv.text(title, tx, y + h / 2 + tsize * 0.36, tsize, t.text);
        tx += titleW + 40;
    }
    cv.tabRects = [];
    names.forEach((n, i) => {
        const on = i === sel, bw = tw[i];
        if (tx + bw > right) return;
        cv.tabRects.push({ i, x: tx, y, w: bw, h });
        if (on) {
            cv.gradientRect(tx, y, bw, h, [[0, withAlpha(S, 0)], [1, withAlpha(S, 0.25)]]);
            cv.fillRect(tx, y + h - 5, bw, 5, S);
        }
        cv.text(n, tx + bw / 2, y + h / 2 + 7, 20, on ? t.selText || '#ffffff' : t.dim, opt);
        if (i < names.length - 1) cv.fillRect(tx + bw, y + h * 0.28, 1, h * 0.44, withAlpha('#ffffff', 0.14));
        tx += bw;
    });
}

function headerCompact(cv, t, x, y, w, h, title, tabs, sel, badges) {
    const S = t.sel || t.accent, opt = { align: 'center', font: 'bold', spacing: 1.6 };
    const bopt = { align: 'center', font: 'bold', spacing: 1.5 };
    const names = (tabs || []).map((n) => upperText(n));
    const bh = 30, bsize = 17;
    const bws = (badges || []).map((b) => Math.max(bh * 3.5, cv.textWidth(b.text, bsize, bopt) + bh));
    const badgesW = bws.reduce((a, b) => a + b + bh * 0.4, 0);
    const tsize = 32, titleW = title ? cv.textWidth(title, tsize) : 0;
    const room = w - 20 - (badgesW ? badgesW + 12 : 0);
    const tw = tabWidths(cv, names, 18, opt, 132, 44, room - 20, 20);
    const tabsW = tw.reduce((a, b) => a + b, 0);
    const showTitle = title && titleW + 32 + tabsW <= room;
    // only as wide as the content: the rest of the strip stays the HMI's
    let end = x + 20 + (showTitle ? titleW + 32 : 0);
    names.forEach((n, i) => { if (end + tw[i] <= x + room) end += tw[i]; });
    end = Math.min(x + w, end + (badgesW ? 12 + badgesW : 0) + 16);
    cv.fillRect(x, y, end - x, h, t.bg);
    cv.fillRect(x, y + h - 2, end - x, 2, withAlpha('#ffffff', 0.22));
    let tx = x + 20;
    if (showTitle) {
        cv.text(title, tx, y + h / 2 + tsize * 0.36, tsize, t.text);
        tx += titleW + 32;
    }
    cv.tabRects = [];
    names.forEach((n, i) => {
        const on = i === sel, bw = tw[i];
        if (tx + bw > x + room) return;
        cv.tabRects.push({ i, x: tx, y, w: bw, h });
        if (on) {
            cv.gradientRect(tx, y, bw, h, [[0, withAlpha(S, 0)], [1, withAlpha(S, 0.25)]]);
            cv.fillRect(tx, y + h - 4, bw, 4, S);
        }
        cv.text(n, tx + bw / 2, y + h / 2 + 6, 18, on ? t.selText || '#ffffff' : t.dim, opt);
        if (i < names.length - 1) cv.fillRect(tx + bw, y + h * 0.3, 1, h * 0.4, withAlpha('#ffffff', 0.14));
        tx += bw;
    });
    if (badgesW) badgeRow(cv, t, tx + 12 + badgesW, y + (h - bh) / 2, bh, bsize, badges);
    return end;
}

/**
 * Button bar: buttons = [{ label, x, w }] (x, w of each button), focus = index of the button
 * the iDrive controller is on (-1: none), flash = index of a just-pressed one.
 * variant: 'slim' (the full-screen layout's bar, any height, e.g. 48) or 'standard' (120).
 */
function menuBar(cv, t, x, y, w, h, buttons, focus, variant, flash) {
    const std = variant === 'standard', u = h / (std ? 120 : 48);
    const sel = t.sel || t.accent;
    cv.fillRect(x, y, w, h, t.bg);
    cv.gradientRect(x, y, w, h, [[0, withAlpha('#ffffff', 0.09)], [1, withAlpha('#ffffff', 0.03)]]);
    cv.fillRect(x, y, w, Math.max(1, 2 * u), withAlpha('#ffffff', 0.2));
    const size = (std ? 30 : 19) * u;
    buttons.forEach((b, i) => {
        const on = i === focus, hit = i === flash;
        if (on || hit) {
            cv.gradientRect(b.x, y, b.w, h, [[0, withAlpha(sel, hit ? 0.5 : 0.08)], [1, withAlpha(sel, hit ? 0.7 : 0.4)]]);
            cv.fillRect(b.x, y + h - 4 * u, b.w, 4 * u, sel);
        }
        const label = std ? String(b.label) : upperText(b.label);
        cv.text(label, b.x + b.w / 2, y + h / 2 + size * 0.36, size, on || hit ? t.selText || '#ffffff' : std ? t.text : t.dim,
            { align: 'center', font: std ? 'label' : 'bold', spacing: std ? 0 : 2 * u });
        if (i < buttons.length - 1) cv.fillRect(b.x + b.w, y + h * 0.25, Math.max(1, u), h * 0.5, withAlpha('#ffffff', 0.13));
    });
}

/**
 * A button on the page: a pill with its label, pressed by a tap or the controller (cv.target). Drawn
 * only where the kit runs the screen (display.js: the app's bar button then leaves the bar, hideButton).
 * opts: { key (default: the label), color (a warning colour, for resets), primary (filled), busy (drawn
 * dimmed, nothing to press), confirm (a reset: the first press asks, Confirm pressed within 5 s runs it) }.
 * Returns the button's width.
 */
const armed = new Map();                // confirm buttons pressed once: key -> when
let onArmed = null;
/** fn() when a confirm button is armed or runs out (display.js: the app draws its next frame). */
function onConfirm(fn) { onArmed = fn; }
function button(cv, t, x, y, w, h, label, run, opts) {
    let o = opts || {};
    if (!cv.own) return 0;              // elsewhere the HMI's bar has the button
    if (o.confirm && run) {
        const key = o.key || label, act = run, live = () => armed.has(key) && Date.now() - armed.get(key) < 5000;
        if (live()) { label = 'Confirm'; o = Object.assign({}, o, { color: t.crit, primary: true }); }
        run = () => {
            if (live()) { armed.delete(key); if (onArmed) onArmed(); return act(); }
            armed.set(key, Date.now());
            if (onArmed) { onArmed(); setTimeout(onArmed, 5050); }
            return null;
        };
    }
    const S = t.sel || t.accent, c = o.color || S;
    if (!w) w = Math.max(h * 3, cv.textWidth(String(label).toUpperCase(), h * 0.4, { font: 'bold', spacing: 1.5 }) + h * 1.2);
    cv.roundRect(x, y, w, h, h / 2, o.primary ? withAlpha(c, o.busy ? 0.35 : 0.85) : withAlpha('#ffffff', 0.07));
    if (!o.primary) cv.strokeRoundRect(x, y, w, h, h / 2, 1.5, withAlpha(o.color || '#ffffff', o.busy ? 0.25 : o.color ? 0.75 : 0.3));
    cv.text(String(label).toUpperCase(), x + w / 2, y + h / 2 + h * 0.15, h * 0.4, o.primary ? '#ffffff' : o.busy ? t.dim : o.color || t.text,
        { align: 'center', font: 'bold', spacing: 1.5 });
    if (!o.busy && run) cv.target(x, y, w, h, run, o.key || label);
    return w;
}

/** Accent stripes (M-style) under a header. */
function stripes(cv, t, x, y, w) {
    const s = t.stripes || [t.accent];
    const sw = w / s.length;
    s.forEach((c, i) => cv.roundRect(x + i * sw, y, sw - (i < s.length - 1 ? 4 : 0), 4, 2, c));
}

module.exports = {
    BAR_H, TOP, BOTTOM, pageBottom, MARGIN, toMargin, frame, header, layer, onLayerDrop, panel, segBar, radial, needle, ring, bar, stat, readout,
    shiftLights, gear, chart, table, pill, tyres, gmeter, menuBar, stripes, button, onConfirm, smooth, hold, niceStep,
    fmt, isNum, clamp, mix, zoneColor, withAlpha, ramp,
};
