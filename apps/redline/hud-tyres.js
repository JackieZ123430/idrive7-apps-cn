'use strict';
/**
 * Part of Redline's experimental features; README.md in this folder has the whole picture.
 *
 * The tyre widget: a 200 x 76 picture in the directions' corner of the glass (the same image layer and place,
 * hud.js; the directions come first while they have a turn to show). The car from above in the middle with the
 * unit inside it, a tyre at each corner, and beside each its pressure (big, coloured against its target:
 * tyres.js toneOf) with "/2.5" (the target) small after it, then the tyre's temperature under it.
 *
 *        2.4 ▮┌──┐▮ 2.4          (with Target on: 2.4/2.5)
 *        59°  │bar│  61°
 *        2.5 ▮└──┘▮ 2.1
 *        69°         70°
 *
 * Each tyre in the car is blue while cold and turns green as it warms up (warmCol); "Show: Warming up" keeps the
 * widget up until all four are warm.
 * The target is off by default (the colour already says how each tyre is against it); the car and the
 * temperatures can be switched off too, and without temperatures the pressures are drawn bigger. Text is fitted to its room, so kPa and Clearer labels never run into the car. A picture, never a
 * shader. Black is see-through on the glass.
 */
const { withAlpha, ramp } = require('./kit/canvas');
const { PALETTES } = require('./hud-draw');
const Theme = require('./hud-theme');
const Tyres = require('./tyres');

const TW = 200, TH = 76;
const CX = TW / 2, BODY_W = 26, BODY_H = 72, BODY_Y = 2, TYRE_W = 6, TYRE_H = 17;
const isNum = (v) => typeof v === 'number' && isFinite(v);

/** A temperature's colour: blue when cold (under 20 °C), orange over 90, red over 105 (as Car Vitals' card). */
function tempTone(c) { return !isNum(c) ? null : c < 20 ? 'cold' : c > 105 ? 'hot' : c > 90 ? 'warm' : 'text'; }

/**
 * Warm-up: a tyre is cold (blue) at COLD_C and under, warm (green) at WARM_C and over, blended between. The
 * sensors measure the air in the tyre, which runs cooler than the tread: 40 °C there is a tyre that has
 * done some hard laps, not a tyre at its best.
 */
const COLD_C = 20, WARM_C = 40;
/** How far a tyre is warmed up, 0 (cold) to 1 (warm); null without a temperature. */
function warmth(c) { return !isNum(c) ? null : Math.max(0, Math.min(1, (c - COLD_C) / (WARM_C - COLD_C))); }
/** A tyre's colour: blue to green as it warms up, then orange or red when it runs hot (tempTone); null without one. */
function warmCol(c, P) {
    if (!isNum(c)) return null;
    if (c > 90) return Theme.toneCol(tempTone(c), P, P.text);
    return ramp([P.cold, P.low], warmth(c));
}
/** The corners still warming up (a temperature under WARM_C), e.g. ['FL', 'FR']. */
function coldCorners(ty) {
    return ty ? Tyres.CORNERS.filter((c) => isNum(ty.t[c]) && ty.t[c] < WARM_C) : [];
}

/**
 * The widget's options from the settings: { show ('low' | 'warm' | 'always' | 'off'), car, target, temp, unit,
 * fahrenheit }. show 'low': only while a tyre is well under its target (red); 'warm': that, and while a tyre
 * is still warming up (for a track day: it goes once all four are warm).
 */
function widgetOf(settings) {
    const s = settings.get('hudTyreWidget');
    return {
        show: s === 'always' || s === 'off' || s === 'warm' ? s : 'low',
        car: settings.get('hudTyreCar') !== false, target: settings.get('hudTyreTarget') === true, temp: settings.get('hudTyreTemp') !== false,
        unit: ['psi', 'kpa'].indexOf(settings.get('hudTyreUnit')) >= 0 ? settings.get('hudTyreUnit') : 'bar',
        fahrenheit: settings.get('hudTempUnit') === 'f', clear: settings.get('hudLabels') === 'clear',
    };
}

/** Whether the widget shows for these tyres (null: no data, never). */
function widgetShows(w, ty) {
    if (!ty || w.show === 'off') return false;
    return w.show === 'always' || Tyres.lowCorners(ty).length > 0 || (w.show === 'warm' && coldCorners(ty).length > 0);
}

/** Everything the picture depends on (the numbers as drawn). */
function widgetKey(ty, w, palette) {
    // the temperature as drawn (in °F when chosen: 36.6 and 37.4 °C are both 37 °C but 98 and 99 °F)
    const T = Tyres.CORNERS.map((c) => [Tyres.fmtP(ty.p[c], w.unit), Tyres.fmtP(ty.tgt[c], w.unit), isNum(ty.t[c]) ? Math.round(w.fahrenheit ? ty.t[c] * 9 / 5 + 32 : ty.t[c]) : '-'].join('/'));
    return ['tyres', T.join(','), w.car, w.target, w.temp, w.unit, w.fahrenheit, w.clear, palette].join('|');
}

// the widget's right edge (its widest right-hand value) this far in from the box's right: where the directions'
// distance and lanes end, so in the corner it lines up with them (2026-11-10)
const RIGHT_IN = 26;

/**
 * Where the widget's parts go for ty, w, measured on cv: { cx (the car's middle), gap, cells (each corner's numbers
 * and their sizes), rows, sub, two }.
 */
function layoutOf(cv, ty, w) {
    const tw = (s, size) => (cv.textWidth ? cv.textWidth(s, size, { font: 'bold' }) : s.length * size * 0.55);
    const gap = w.car ? BODY_W / 2 + 2 + TYRE_W + 5 : 20;
    const sub = w.clear ? 15 : 13, two = w.temp;
    const big = two ? 24 : 30;
    const rows = two ? { F: [24, 37], R: [62, 75] } : { F: [30, 0], R: [68, 0] };
    // each corner's numbers, sized to fit the room either side of the car (made smaller together when pressure and
    // target don't fit: kPa at Clearer)
    const room = CX - gap - 2;
    const cells = Tyres.CORNERS.map((c) => {
        const p = ty.p[c], tgt = ty.tgt[c];
        const ps = Tyres.fmtP(p, w.unit), ts = w.target && isNum(tgt) ? '/' + Tyres.fmtP(tgt, w.unit) : '';
        const need = tw(ps, big) + (ts ? tw(ts, sub) + 1 : 0), k = need > room ? room / need : 1;
        const bs = big * k, ss = sub * k, pw = tw(ps, bs), tsw = ts ? tw(ts, ss) + 1 : 0;
        return { c: c, p: p, tgt: tgt, ps: ps, ts: ts, bs: bs, ss: ss, pw: pw, tsw: tsw };
    });
    // moved right so the widest right-hand value ends RIGHT_IN from the edge (the left side only gains room); never
    // left of the middle
    const tempW = (c) => (two && isNum(ty.t[c]) ? tw(Math.round(w.fahrenheit ? ty.t[c] * 9 / 5 + 32 : ty.t[c]) + '°', sub) : 0);
    const rightW = Math.max.apply(null, cells.filter((e) => e.c[1] === 'R').map((e) => Math.max(e.pw + e.tsw, tempW(e.c))));
    const cx = Math.round(Math.max(CX, TW - RIGHT_IN - gap - rightW));
    return { cx: cx, gap: gap, cells: cells, rows: rows, sub: sub, two: two };
}

/** Draws the widget into cv (TW x TH) for ty (tyres.js value()), w (widgetOf), palette name. */
function drawWidget(cv, ty, w, palette) {
    if (cv.clear) cv.clear();
    if (!ty) return;
    const P = PALETTES[palette] || PALETTES.colour;
    const uName = (Tyres.UNITS[w.unit] || Tyres.UNITS.bar)[2];
    const L = layoutOf(cv, ty, w), cx = L.cx, gap = L.gap, rows = L.rows, sub = L.sub, two = L.two;
    const x0 = cx - BODY_W / 2, x1 = cx + BODY_W / 2;
    // the car: a rounded body, windscreen and rear window, a tyre at each corner; the unit inside
    if (w.car) {
        cv.roundRect(x0, BODY_Y, BODY_W, BODY_H, 10, withAlpha(P.text, 0.08));
        cv.strokeRoundRect(x0, BODY_Y, BODY_W, BODY_H, 10, 1.5, withAlpha(P.text, 0.5));
        cv.roundRect(x0 + 4, BODY_Y + 14, BODY_W - 8, 7, 3, withAlpha(P.text, 0.3));
        cv.roundRect(x0 + 5, BODY_Y + BODY_H - 18, BODY_W - 10, 5, 2, withAlpha(P.text, 0.22));
        // each tyre coloured by its warm-up (blue cold, green warm), white without a temperature
        [[6, -1, 'FL'], [6, 1, 'FR'], [TH - 6 - TYRE_H, -1, 'RL'], [TH - 6 - TYRE_H, 1, 'RR']].forEach((t) => {
            const tx = t[1] < 0 ? x0 - 2 - TYRE_W : x1 + 2;
            cv.roundRect(tx, t[0], TYRE_W, TYRE_H, 2, warmCol(ty.t[t[2]], P) || withAlpha(P.text, 0.85));
        });
    }
    const us = w.clear ? 13 : 11;
    cv.text(uName, cx, TH / 2 + us / 2 - 1, us, w.clear ? P.text : withAlpha(P.text, 0.8), { align: 'center', font: 'bold' });
    // the numbers: right-aligned against the car on the left, left-aligned on the right
    L.cells.forEach((e) => {
        const left = e.c[1] === 'L', r = rows[e.c[0]], edge = left ? cx - gap : cx + gap, temp = ty.t[e.c];
        const pc = P[Tyres.toneOf(e.p, e.tgt)] || withAlpha(P.text, isNum(e.p) ? 1 : 0.5);
        const px = left ? edge - e.tsw - e.pw : edge;
        cv.text(e.ps, px, r[0], e.bs, pc, { align: 'left', font: 'bold' });
        if (e.ts) cv.text(e.ts, px + e.pw + 1, r[0], e.ss, w.clear ? P.text : withAlpha(P.text, 0.75), { align: 'left', font: 'bold' });
        if (two && isNum(temp)) {
            const s = Math.round(w.fahrenheit ? temp * 9 / 5 + 32 : temp) + '°';
            // white once warm, like any value; blue to green while warming up, orange or red when hot
            const col = temp >= WARM_C && temp <= 90 ? P.text : warmCol(temp, P);
            cv.text(s, edge, r[1], sub, col, { align: left ? 'right' : 'left', font: 'bold' });
        }
    });
}

/** Sample tyres for the previews (one a little under its target, one well under). */
const SAMPLE = { p: { FL: 2.4, FR: 2.4, RL: 2.5, RR: 2.1 }, tgt: { FL: 2.5, FR: 2.5, RL: 2.7, RR: 2.7 }, t: { FL: 59, FR: 61, RL: 69, RR: 70 } };

module.exports = { drawWidget, layoutOf, RIGHT_IN, widgetKey, widgetOf, widgetShows, tempTone, warmth, coldCorners, COLD_C, WARM_C, SAMPLE, TW, TH };
