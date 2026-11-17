'use strict';
/**
 * screens.js - the Gauges pages: screens of your own, a layout of gauges in the OEM (G20 sport display)
 * style from kit/gauges.js, each showing one value (a car signal, the trip computer's or the engine
 * unit's). Drawn full screen in the app and, the one Settings > Home-screen widget names, on the
 * home-screen widget (a picture of about 384 x 256).
 *
 *   layout   the gauges it holds, one value each: 'dial' (270-degree dial), 'bar' (sport display bar),
 *            'num' (big number, full screen with the last 5 minutes as a trace and their min / max)
 *   scale    a value's dial / bar range: by its car signal or engine value, else by its unit, else from
 *            the values seen so far
 *   DEFAULTS the screens a new install starts with: made of car signals only, so they work on any car
 */
const LAYOUTS = [
    { id: 'dial2', name: 'Dial + 2 numbers', slots: ['dial', 'num', 'num'] },
    { id: 'dial3', name: 'Dial + 3 numbers', slots: ['dial', 'num', 'num', 'num'] },
    { id: 'dials2', name: '2 dials', slots: ['dial', 'dial'] },
    { id: 'dials3', name: '3 dials', slots: ['dial', 'dial', 'dial'] },
    { id: 'bars2', name: '2 bars', slots: ['bar', 'bar'] },
    { id: 'bar3', name: 'Bar + 3 numbers', slots: ['bar', 'num', 'num', 'num'] },
    { id: 'nums4', name: '4 numbers', slots: ['num', 'num', 'num', 'num'] },
];
const MAX_SLOTS = 4, MAX_SCREENS = 6;
const PEAK_MS = 3000;           // the peak mark stays this long after the last new high (OEM "hang")
const KINDS = { dial: 'dial', bar: 'bar', num: 'number' };

// [layout, car signals in its order] (signals.js ids)
const DEFAULTS = [
    ['bar3', ['rpm', 'oil', 'coolant', 'boost']],
    ['dial3', ['flow', 'tcAvg', 'tcKm', 'tcCost']],
];

const layout = (id) => LAYOUTS.find((l) => l.id === id) || LAYOUTS[0];
const nextLayout = (id) => LAYOUTS[(LAYOUTS.indexOf(layout(id)) + 1) % LAYOUTS.length].id;

/* ---------- scales: [min, max, { warn, red (zones from there), div (dial numbers / div), grow }] ---------- */
const OIL = [40, 150, { warn: 130, red: 140 }], COOLANT = [40, 130, { warn: 112, red: 120 }];
const RPM = [0, 7000, { red: 6500, div: 1000 }];        // B58: limiter at about 7000 rpm
// torque, power and the tank start at a B58's and grow with what the car shows (a V8: 750 Nm, 460 kW, 68-83 l)
const TQ = [0, 600, { grow: true }], KW = [0, 300, { grow: true }], TANK = [0, 59, { grow: true }];
const BY_SIGNAL = {
    rpm: RPM, torque: TQ, power: KW, powerPct: [0, 100], torquePct: [0, 100], pedal: [0, 100],
    boost: [0, 2, { grow: true }], coolant: COOLANT, oil: OIL, oil2: OIL,
    tank: TANK, tankL: [0, 30], tankR: [0, 30], range: [0, 800], flow: [0, 40, { grow: true }], instant: [0, 30, { grow: true }],
    speed: [0, 260], gLong: [-1.2, 1.2], gLat: [-1.5, 1.5], steer: [-540, 540], outside: [-30, 50], battery: [0, 100],
    tcKm: [0, 50, { grow: true }], tcFuel: [0, 5, { grow: true }], tcAvg: [0, 20, { grow: true }],
};
['FL', 'FR', 'RL', 'RR'].forEach((c) => { BY_SIGNAL['p' + c] = [1.5, 3.5]; BY_SIGNAL['pt' + c] = [1.5, 3.5]; BY_SIGNAL['t' + c] = [-20, 100]; });
const BY_USEFUL = {
    'Engine speed': RPM, 'Engine load': [0, 100], 'Accelerator pedal': [0, 100], 'Throttle': [0, 100],
    'Engine torque': TQ, 'Engine power (engine unit)': KW, 'Vehicle speed': [0, 260],
    'Coolant': COOLANT, 'Coolant, radiator outlet': [20, 120], 'Engine oil (after filter)': OIL, 'Engine oil in the sump': OIL,
    'Intake air': [-20, 80], 'Charge air before throttle': [-20, 100], 'Gearbox': [20, 130, { warn: 110, red: 120 }],
    'Oil pressure': [0, 6], 'Boost': [0, 2, { grow: true }], 'Charge pressure (absolute)': [0.8, 3, { grow: true }],
    'High pressure fuel (rail)': [0, 350], 'Low pressure fuel': [0, 8], 'Fuel consumption': [0, 40, { grow: true }],
    'Fuel mass flow': [0, 30, { grow: true }], 'Fuel in the tank': TANK, 'Ignition angle': [-10, 50],
};
const BY_UNIT = {
    '°C': [0, 150], bar: [0, 3, { grow: true }], '%': [0, 100], 'km/h': [0, 260], rpm: RPM, V: [10, 16], l: [0, 60],
    kW: KW, Nm: TQ, 'l/h': [0, 40, { grow: true }], 'l/100 km': [0, 30, { grow: true }], g: [-1.5, 1.5], km: [0, 1000],
};
/** the smallest 1 / 2 / 2.5 / 5 x 10^n at or above v */
function niceCeil(v) {
    if (!(v > 0)) return 1;
    const e = Math.pow(10, Math.floor(Math.log10(v)));
    return [1, 2, 2.5, 5, 10].map((m) => m * e).find((x) => x >= v * 0.9999);
}
/** v rounded up to a whole number of a round step (about a fifth of it): 50.7 -> 60, 1.2 -> 1.25 */
function niceUp(v) {
    if (!(v > 0)) return 1;
    const st = niceCeil(v / 5);
    return Math.ceil(v / st - 1e-9) * st;
}
/**
 * A value's range: { min, max, zones, div, red }. key = its gauge value's key ('sig:rpm', '18:useful:Coolant' ...),
 * useful = its Useful entry's name, seen = { lo, hi } of the values so far (ranges that grow, and values without one).
 */
function scale(key, useful, unit, seen) {
    // in °F: the °C scale, its ends rounded out to tens of °F (the zones where they are)
    if (unit === '°F') {
        const F = (c) => c * 1.8 + 32, C = (f) => (f - 32) / 1.8;
        const c = scale(key, useful, '°C', seen ? { lo: C(seen.lo), hi: C(seen.hi) } : null);
        return {
            min: Math.floor(F(c.min) / 10) * 10, max: Math.ceil(F(c.max) / 10) * 10,
            zones: c.zones.map((z) => ({ from: F(z.from), to: z.to === c.max ? Math.ceil(F(c.max) / 10) * 10 : F(z.to), color: z.color })),
            div: c.div, red: c.red !== undefined ? F(c.red) : undefined,
        };
    }
    const sig = /^sig:/.test(key || '') ? key.slice(4) : null;
    const s = (sig && BY_SIGNAL[sig]) || (useful && BY_USEFUL[useful]) || BY_UNIT[unit] || null;
    let min, max;
    const o = (s && s[2]) || {};
    if (s) {
        min = s[0]; max = s[1];
        if (o.grow && seen && seen.hi > max) max = niceUp(seen.hi * 1.05);
    } else {
        // nothing known: from 0 (or the lowest value, when below 0) to a round number above the highest
        const lo = seen ? seen.lo : 0, hi = seen ? seen.hi : 1;
        min = lo < 0 ? -niceUp(-lo * 1.1) : 0;
        max = niceUp(Math.max(hi * 1.2, min < 0 ? -min : 0, 1e-6));
    }
    const zones = [];
    if (o.warn !== undefined) zones.push({ from: o.warn, to: o.red !== undefined ? o.red : max, color: 'warn' });
    if (o.red !== undefined) zones.push({ from: o.red, to: max, color: 'crit' });
    return { min, max, zones, div: o.div, red: o.red };
}

/* ---------- drawing ---------- */
const isNum = (x) => typeof x === 'number' && isFinite(x);
const numText = (s) => {
    const v = s.n.toFixed(s.d || 0);
    return /^-0(\.0+)?$/.test(v) ? v.slice(1) : v;
};
/** the slot boxes of a layout in (x, y, w, h); small = the widget's arrangement */
function boxes(L, x, y, w, h, small) {
    const g = small ? 8 : 12, n = L.slots.length;
    const row = (k, yy, hh, x0, ww) => Array.from({ length: k }, (_, i) => {
        const bw = (ww - g * (k - 1)) / k;
        return { x: x0 + i * (bw + g), y: yy, w: bw, h: hh };
    });
    const half = (h - g) / 2;
    switch (L.id) {
        case 'dial2': {
            const dw = small ? Math.min(h, w * 0.5) : Math.min(560, w * 0.38);
            return [{ x, y, w: dw, h }].concat(row(1, y, half, x + dw + g, w - dw - g), row(1, y + half + g, half, x + dw + g, w - dw - g));
        }
        case 'dial3': {
            // the dial on the left, the first number over the other two
            const dw = small ? Math.min(h, w * 0.45) : Math.min(560, w * 0.38), rx = x + dw + g, rw = w - dw - g;
            return [{ x, y, w: dw, h }].concat(row(1, y, half, rx, rw), row(2, y + half + g, half, rx, rw));
        }
        case 'bars2': return [{ x, y, w, h: half }, { x, y: y + half + g, w, h: half }];
        case 'bar3': return [{ x, y, w, h: half }].concat(row(3, y + half + g, half, x, w));
        case 'nums4': return small ? row(2, y, half, x, w).concat(row(2, y + half + g, half, x, w)) : row(4, y, h, x, w);
        default: return row(n, y, h, x, w);          // dials side by side
    }
}

/**
 * Draws a screen. slots: what each gauge shows - { empty } or { name, text, dim, warn, n (number or
 * null), u, d, sc (scale), peak, hist } - in the layout's order; hl = the gauge to mark (browsing) or -1.
 * fit(cv, text, size, width, opt) shortens a text to a width.
 */
function draw(cv, t, G, L, slots, box, small, hl, fit) {
    boxes(L, box.x, box.y, box.w, box.h, small).forEach((b, i) => {
        const s = slots[i] || { empty: true };
        // a text (gear 'D4', 'standing' ...) shows as a number would, whatever the gauge
        const kind = s.empty ? 'empty' : !isNum(s.n) && s.text && !s.dim ? 'num' : L.slots[i];
        (small ? SMALL : FULL)[kind](cv, t, G, s, b, fit, i);
        if (i === hl) cv.strokeRoundRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8, 8, 3, t.sel || t.accent);
    });
}

const valueOf = (s) => (isNum(s.n) ? s.n : null);
const FULL = {
    empty(cv, t, G, s, b, fit, i) {
        G.panel(cv, t, b.x, b.y, b.w, b.h, 'Gauge ' + (i + 1));
        cv.text(fit(cv, 'Tap or press here to choose its value', 22, b.w - 40), b.x + b.w / 2, b.y + b.h / 2 + 20, 22, t.dim, { align: 'center' });
    },
    dial(cv, t, G, s, b, fit) {
        G.panel(cv, t, b.x, b.y, b.w, b.h, fit(cv, s.name, 26, b.w - 36, { font: 'bold' }));
        const r = Math.max(60, Math.min(b.w / 2 - 40, (b.h - 70) / 2 - 8));
        G.radial(cv, t, b.x + b.w / 2, b.y + 60 + (b.h - 60) / 2, r, {
            value: valueOf(s), min: s.sc.min, max: s.sc.max, zones: s.sc.zones, decimals: s.d, peak: s.peak, showPeak: false,
            unit: s.u, tickDiv: s.sc.div, tickDecimals: s.sc.div ? 0 : s.sc.max - s.sc.min < 5 ? 1 : 0, limit: s.sc.red,
        });
    },
    bar(cv, t, G, s, b, fit) {
        const step = G.niceStep(s.sc.max - s.sc.min, 8);
        G.segBar(cv, t, b.x, b.y, b.w, b.h, {
            label: fit(cv, s.name, 26, b.w - 360, { font: 'bold' }), value: valueOf(s), unit: s.u, decimals: s.d, min: s.sc.min, max: s.sc.max,
            step: step / 2, scale: { every: step, div: s.sc.div, decimals: s.sc.div ? 0 : step % 1 ? 1 : 0 }, peak: s.peak,
            ramp: 'hot', limit: s.sc.red !== undefined ? s.sc.red : s.sc.max,
        });
    },
    num(cv, t, G, s, b, fit) {
        const name = fit(cv, s.name, 26, b.w - 36, { font: 'bold' });
        if (isNum(s.n)) {
            const h = (s.hist || []).filter(isNum), lo = h.length ? Math.min.apply(null, h) : null, hi = h.length ? Math.max.apply(null, h) : null;
            const sub = h.length > 2 && b.h > 150 ? 'last 5 min  ·  min ' + numText({ n: lo, d: s.d }) + '  max ' + numText({ n: hi, d: s.d }) : null;
            G.stat(cv, t, b.x, b.y, b.w, b.h, { label: name, value: s.n, unit: s.u, decimals: s.d, history: s.hist, zones: s.sc && s.sc.zones, sub });
            return;
        }
        G.panel(cv, t, b.x, b.y, b.w, b.h, name);
        // a text the value has (gear 'D4') big; what there is instead ('no data', 'calibrating') smaller
        const size = s.dim || s.warn ? 30 : Math.min(80, b.h * 0.36);
        cv.text(fit(cv, s.text, size, b.w - 36, { font: 'bold' }), b.x + 18, b.y + 52 + Math.min(80, b.h * 0.36) * 0.85, size, s.warn ? t.warn : s.dim ? t.dim : t.text, { font: 'bold' });
    },
};

/** the widget's: no panels (the home screen draws the widget's background), small labels */
// (letter spacing isn't in the measured width: 15 % kept for it)
// (bright: over the home screen's background the theme's dim grey is hard to read)
const label = (cv, t, G, s, x, y, w, fit, align) => cv.text(fit(cv, short(s).toUpperCase(), 13, w * 0.85, { font: 'bold' }), x, y, 13, G.withAlpha(t.text, 0.78), { align: align || 'left', font: 'bold', spacing: 1 });
/** a name without its explanation in brackets, for the widget's small labels */
const short = (name) => String(name).replace(/\s*\([^)]*\)\s*$/, '') || String(name);
/** a number and its unit as big as fits in w (at most `size`); returns nothing */
function bigNumber(cv, t, s, x, y, w, size, fit, align) {
    if (!isNum(s.n)) {
        const sz = Math.min(size, s.dim || s.warn ? 18 : 30);
        cv.text(fit(cv, s.text, sz, w, { font: 'bold' }), x, y, sz, s.warn ? t.warn : s.dim ? t.dim : t.text, { align: align || 'left', font: 'bold' });
        return;
    }
    const v = numText(s), us = s.u ? ' ' + s.u : '';
    let sz = size;
    const width = (z) => cv.textWidth(v, z, { font: 'num' }) + (us ? cv.textWidth(us, Math.max(12, Math.round(z * 0.4))) : 0);
    while (sz > 18 && width(sz) > w) sz -= 2;
    const uz = Math.max(12, Math.round(sz * 0.4)), vw = cv.textWidth(v, sz, { font: 'num' }), all = width(sz);
    const x0 = align === 'center' ? x - all / 2 : align === 'right' ? x - all : x;
    let c = t.text;
    for (const z of (s.sc && s.sc.zones) || []) if (s.n >= z.from && s.n <= z.to) c = t[z.color] || c;
    cv.text(v, x0, y, sz, c, { font: 'num' });
    if (us) cv.text(us, x0 + vw, y, uz, t.dim);
}
const SMALL = {
    empty() {},
    dial(cv, t, G, s, b, fit) {
        const r = Math.min(b.w / 2 - 4, b.h / 2 - 6), cx = b.x + b.w / 2, cy = b.y + b.h / 2 - 2;
        G.radial(cv, t, cx, cy, r, {
            value: valueOf(s), min: s.sc.min, max: s.sc.max, zones: s.sc.zones, decimals: s.d, peak: s.peak, showPeak: false,
            tickLabels: false, ticks: r < 60 ? 6 : 10, limit: s.sc.red,
        });
        if (s.u) cv.text(s.u, cx, cy + Math.round(r * 0.62) * 0.32 + Math.max(14, r * 0.2), Math.max(12, Math.round(r * 0.17)), t.dim, { align: 'center' });
        label(cv, t, G, s.name, cx, cy + r * 0.92, b.w - 4, fit, 'center');
    },
    bar(cv, t, G, s, b, fit) {
        // the sport display bar, its label shortened to leave room for the value
        const vw = cv.textWidth(isNum(s.n) ? numText(s) : '--', 44, { font: 'num' }) + (s.u ? cv.textWidth(' ' + s.u, 26) : 0);
        G.bar(cv, t, b.x, b.y + Math.max(0, (b.h - 92) / 2), b.w, 92, {
            label: fit(cv, short(s.name).toUpperCase(), 22, (b.w - vw - 24) * 0.88, { font: 'bold' }), value: valueOf(s), unit: s.u, decimals: s.d,
            min: s.sc.min, max: s.sc.max, niceMax: true, ramp: 'hot', peak: s.peak, zones: s.sc.zones,
        });
    },
    num(cv, t, G, s, b, fit) {
        if (b.h > 130) {
            // a whole column (a text in a dial's place): label and value in its middle
            const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
            label(cv, t, G, s.name, cx, cy - 26, b.w, fit, 'center');
            bigNumber(cv, t, s, cx, cy + 30, b.w, 56, fit, 'center');
            return;
        }
        label(cv, t, G, s.name, b.x, b.y + 16, b.w, fit);
        bigNumber(cv, t, s, b.x, b.y + Math.min(b.h - 8, 16 + Math.min(56, b.h - 30)), b.w, Math.min(56, b.h - 34), fit);
    },
};

/*
 * The widget's picture: the HMI scales it up (about 2x on the G20) and crops a share of each edge
 * (app.json startWidget.safe: [x, y] or [left, top, right, bottom]); next to the edges it fades the
 * picture, at the top most. fit (Settings) keeps the gauges that much further in: [left, top, right, bottom].
 */
const FIT = { large: [0, 0.03, 0, 0], medium: [0.06, 0.1, 0.06, 0.03], small: [0.11, 0.16, 0.11, 0.07] };
function widgetBox(w, h, safe, fit) {
    const sf = Array.isArray(safe) && safe.length === 4 ? safe : Array.isArray(safe) && safe.length === 2 ? [safe[0], safe[1], safe[0], safe[1]] : [0.09, 0.1, 0.09, 0.1];
    const f = FIT[fit] || FIT.medium;
    const l = Math.round(w * (sf[0] + f[0])), tp = Math.round(h * (sf[1] + f[1])), r = Math.round(w * (sf[2] + f[2])), b = Math.round(h * (sf[3] + f[3]));
    return { x: l, y: tp, w: w - l - r, h: h - tp - b };
}

module.exports = { LAYOUTS, DEFAULTS, MAX_SLOTS, MAX_SCREENS, PEAK_MS, KINDS, layout, nextLayout, scale, niceCeil, niceUp, boxes, draw, numText, short, FIT, widgetBox };
