'use strict';
/**
 * Part of Redline's experimental features; README.md in this folder has the whole picture.
 *
 * Drawing the HUD image (400x130, straight-alpha RGBA on black: black is see-through on the glass).
 * hud.js decides what to show and when; this file only draws it.
 *
 *   Layouts (setting "hudStyle"):
 *     standard  gear on the left (downshift arrows under it), 12 round shift lights over the slanted
 *               rev bar, and under the bar a readouts row (boost, cold limit, temperatures), which
 *               a shift grade replaces for a moment after an upshift
 *     minimal   gear and larger shift lights only
 *     wings     gear in the centre, 6 lights each side filling towards it, the bar underneath
 *     digital   80s digital dash: square lights, an LCD bar graph of 40 segments, 7-segment gear
 *               and rpm digits
 *     vfd       the same as a teal vacuum-fluorescent display, unlit segments always faintly lit
 *     vector    the standard layout in outline only (rings, outlined segments, outlined digits)
 *     arc       after the F80/F82 M3/M4's HUD: 8 curved lights over a curved band, the gear under it
 *     ramp      after the G80/G82 M3/M4's: a band climbing then flat, fields going yellow then red
 *     dial      after the E60 M5's: a 3/4 dial round the gear, green / orange / red
 *               (these three: hud-m.js, in the originals' colours)
 *   Palettes (setting "hudPalette"): colour (green / yellow / red), amber (night), ice (white / blue);
 *   vfd and the M layouts have their own.
 *   Gear font (setting "hudGearFont"): Ubuntu, or Barlow (Auto: Barlow on the M layouts); a font whose
 *   atlas is missing falls back to Ubuntu.
 *   Effects: the shift grade as a "burst" (pops, a ring grows, fades), the redline shake (on the
 *   limiter the whole image jitters a few px).
 *
 * drawHud() draws what stays put (unlit lights, dim track, red zone, readout labels) once per layout
 * into a cached Canvas and copies it in, then draws only what moves on top (layer 'bg' / 'fg').
 * Everything here draws on canvas.js Canvas; drawDown() also on the screen's Recorder (quads only).
 */
const { Canvas, withAlpha } = require('./kit/canvas');
const fonts = require('./kit/fonts');
const M = require('./hud-m');
const Theme = require('./hud-theme');

const IW = 400, IH = 130;
const TEMP_X = 150;          // the readouts start here: BMW draws its assistance graphic under the left of the bar
const isNum = (x) => typeof x === 'number' && isFinite(x);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/** Colours per palette. low/mid/high: the lights' and bar's three steps; flash: the shift flash. */
const PALETTES = {
    colour: { low: '#2fd27a', mid: '#ffc21a', high: '#ff2a2a', flash: '#ff2a2a', limit: '#ff2a2a', text: '#ffffff', cold: '#3d8bff', warm: '#ffc21a', hot: '#ff2a2a', arrow: '#22e0ff', peak: '#ffffff' },
    amber: { low: '#c27400', mid: '#ffa000', high: '#ff5a1a', flash: '#ff5a1a', limit: '#ff3a1a', text: '#ffbe55', cold: '#b07a20', warm: '#ffa000', hot: '#ff3a1a', arrow: '#ffbe55', peak: '#ffbe55' },
    vfd: { low: '#3ef0d0', mid: '#a8fff0', high: '#ff6a3a', flash: '#ff6a3a', limit: '#ff4a2a', text: '#5ff6dc', cold: '#46b4ff', warm: '#ffd34a', hot: '#ff5a3a', arrow: '#5ff6dc', peak: '#d8fff8' },
    ice: { low: '#8fcfff', mid: '#e6f4ff', high: '#ff3a3a', flash: '#ff3a3a', limit: '#ff3a3a', text: '#ffffff', cold: '#5aa8ff', warm: '#e6f4ff', hot: '#ff3a3a', arrow: '#8fcfff', peak: '#ffffff' },
};
const palette = (name) => PALETTES[name] || PALETTES.colour;
const VERDICT_TEXT = { 'SPOT ON': 'PERFECT SHIFT', EARLY: 'EARLY', LATE: 'LATE', LIMITER: 'LIMITER', 'COLD REV': 'COLD REV', KNOCK: 'KNOCK' };

/*
 * 7-segment characters: segments a (top), b (top right), c (bottom right), d (bottom), e (bottom
 * left), f (top left), g (middle). Letters as an 80s dash would show them (r, n, d lower case).
 */
const SEG7 = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg',
    P: 'abefg', R: 'eg', N: 'ceg', D: 'bcdeg', '-': 'g', ' ': '' };
/**
 * One 7-segment character in (x, y, w, h), segments t thick: lit ones in c, unlit in ghost (or not at
 * all); outline: drawn as outlines (vector). layer: 'bg' ghosts only, 'fg' lit only, neither both.
 */
function seg7(cv, ch, x, y, w, h, t, c, ghost, outline, layer) {
    const on = SEG7[ch] !== undefined ? SEG7[ch] : '';
    const hh = h / 2, g = 1;
    const R = {
        a: [x + t, y, w - 2 * t, t], g: [x + t, y + hh - t / 2, w - 2 * t, t], d: [x + t, y + h - t, w - 2 * t, t],
        f: [x, y + t - g, t, hh - t - g], b: [x + w - t, y + t - g, t, hh - t - g],
        e: [x, y + hh + g, t, hh - t - g], c: [x + w - t, y + hh + g, t, hh - t - g],
    };
    'abcdefg'.split('').forEach((k) => {
        const r = R[k], lit = on.indexOf(k) >= 0;
        // bg: every segment's ghost whatever the character (the cached layer must not depend on it);
        // fg: the lit ones over it; neither: both
        const col = layer === 'bg' ? ghost : layer === 'fg' ? (lit ? c : null) : (lit ? c : ghost);
        if (!col) return;
        if (outline) cv.polyline([[r[0], r[1]], [r[0] + r[2], r[1]], [r[0] + r[2], r[1] + r[3]], [r[0], r[1] + r[3]], [r[0], r[1]]], 1.6, col);
        else cv.fillRect(r[0], r[1], r[2], r[3], col);
    });
}
/** A string of 7-segment characters from x, each w wide with gap between. */
function seg7text(cv, str, x, y, w, h, t, gap, c, ghost, outline, layer) {
    for (let i = 0; i < str.length; i++) seg7(cv, str[i], x + i * (w + gap), y, w, h, t, c, ghost, outline, layer);
}

/** Gear / selector text from car.data(): P R N while selected, else the gear, D while none is engaged. */
function gearText(d) {
    const g = d.gear, st = d.stage;
    return st === 'P' || st === 'R' || st === 'N' ? st : g === -1 ? 'R' : isNum(g) && g > 0 ? String(g) : st === 'D' ? 'D' : g === 0 ? 'N' : '-';
}

const RACE_BLUE = '#2a7dff';
/** The gear's font family: the option's, or Ubuntu's ('gear') when that atlas isn't in the app. */
const gearFont = (o) => (o.gearFont && o.gearFont !== 'gear' && fonts.has(o.gearFont) ? o.gearFont : 'gear');
/**
 * A shift light's colour at f (0 first .. 1 last) for the app's "Shift light style" (setting "lights"),
 * as the app's own lights: m green / yellow / red, f1 (Race) green / red / blue, mono one colour.
 */
function lightCol(style, P, f) {
    if (style === 'mono') return P.text;
    if (style === 'f1') return f < 0.42 ? P.low : f < 0.84 ? P.high : RACE_BLUE;
    return f < 0.34 ? P.low : f < 0.67 ? P.mid : P.high;
}
/**
 * Shift lights at the points pts ([[x, y]]), radius rad. pos[i]: the step light i belongs to (0 lights
 * first); steps: how many steps. They count from cue.from to cue.at (the last step lights only with
 * the flash) and all flash while cue.shift or cue.limiter. s = { rpm, cue, blink, dim, style, P, layer }.
 */
function drawLights(cv, pts, pos, steps, rad, s) {
    const bg = s.layer !== 'fg', fg = s.layer !== 'bg', P = s.P, cue = s.cue;
    const flash = cue.shift || cue.limiter;
    const flashCol = cue.limiter ? P.limit : s.style === 'f1' ? RACE_BLUE : P.flash;
    const count = isNum(s.rpm) ? clamp((s.rpm - cue.from) / (cue.at - cue.from), 0, 1) : 0;
    const lit = Math.ceil(count * (steps - 1));
    const col = (k) => lightCol(s.style, P, k / (steps - 1));
    // shape: 'dot' (filled), 'rect' (an LCD block), 'ring' (vector: outline, lit ones with a core)
    const shape = s.shape || 'dot';
    const put = (p, c, lit) => {
        if (shape === 'rect') cv.fillRect(p[0] - rad * 1.2, p[1] - rad * 0.7, rad * 2.4, rad * 1.4, c);
        else if (shape === 'ring') { cv.arc(p[0], p[1], rad - 1.8, rad, 0, 360, c); if (lit) cv.circle(p[0], p[1], rad * 0.45, c); }
        else cv.circle(p[0], p[1], rad, c);
    };
    for (let i = 0; i < pts.length; i++) {
        const k = pos[i];
        if (bg && (s.dim || s.ghost)) put(pts[i], withAlpha(flash ? flashCol : col(k), s.ghost ? 0.14 : 0.16), false);
        const c = flash ? (s.blink ? flashCol : null) : k < lit ? col(k) : null;
        if (fg && c) put(pts[i], c, true);
    }
}

/**
 * The slanted rev bar in (x, y, w, h): yellow mark at the shift point and red at the redline over its
 * top edge, the dim track and the red zone (bg), the lit segments and the peak line (fg).
 * s = { rpm, cue, shift, redline, max, blink, dim, peak, P, layer }.
 */
function drawBar(cv, x, y, w, h, s) {
    const bg = s.layer !== 'fg', fg = s.layer !== 'bg', P = s.P, cue = s.cue, rpm = s.rpm;
    const markH = 6, barY = y + markH + 2, barH = h - markH - 2;
    const slant = Math.round(barH * 0.32), X = (r) => x + clamp(r / s.max, 0, 1) * (w - slant);
    // vector: segments as outlines; a lit one also gets a faint fill
    const seg = (a, b, c, on) => {
        const xa = X(a) + 2, xb = X(b) - 2, t = on || cv;
        if (!(xb > xa)) return;
        const q = [[xa + slant, barY], [xb + slant, barY], [xb, barY + barH], [xa, barY + barH]];
        if (s.outline) { t.polyline(q.concat([q[0]]), 1.6, c); if (c !== s.trackCol) t.quad(q, withAlpha(c, 0.22)); } else t.quad(q, c);
    };
    const mark = (r, c) => cv.fillRect(Math.round(X(r) + slant) - 1, y, 3, markH, c);
    s.trackCol = withAlpha(P.text, s.outline ? 0.3 : 0.12);
    if (fg && isNum(s.shift) && s.shift < s.redline) mark(s.shift, P.mid);
    if (fg) mark(s.redline, P.limit);
    if (bg && (s.dim || s.outline)) for (let r = 0; r < s.redline; r += 500) seg(r, Math.min(s.redline, r + 500), s.trackCol);
    if (bg) for (let r = s.redline; r < s.max; r += 500) seg(r, Math.min(s.max, r + 500), withAlpha(P.limit, 0.4));
    if (fg && isNum(rpm) && rpm > 50) {
        // low below the shift point, mid past it, high into the redline; all flashing on the limiter
        const top = Math.min(rpm, s.max);
        const col = (r) => {
            const mid = r + 250;
            return cue.limiter ? (s.blink ? P.limit : withAlpha(P.limit, 0.35)) : mid >= s.redline ? P.high : mid >= s.shift ? P.mid : P.low;
        };
        // the whole segments copied from the bar drawn lit once over the static layer (drawHud's frames only: the
        // pixels under the bar are then that layer's), only the last part-lit one drawn: same pixels, a fraction of
        // the time (the lit segments were over half of a frame)
        const full = Math.floor(top / 500), base = s.layer === 'fg' && fgBase;
        let r0 = 0;
        if (base && full > 0 && cv.d && cv.w === base.w && cv.h === base.h) {
            const key = [x, y, w, h, s.max, s.redline, s.shift, cue.limiter, cue.limiter && s.blink, s.outline, P === undefined ? '' : Object.keys(PALETTES).filter((k) => PALETTES[k] === P)[0]].join('|');
            // a few kept: on the limiter it flashes between two
            let lit = litBars.filter((e) => e.key === key && e.base === base)[0];
            if (!lit) {
                lit = { key: key, base: base, cv: new Canvas(base.w, base.h) };
                lit.cv.d.set(base.d);
                for (let r = 0; r < s.max; r += 500) seg(r, Math.min(s.max, r + 500), col(r), lit.cv);
                litBars.unshift(lit); litBars.length = Math.min(litBars.length, LIT_KEEP);
            }
            // per row, up to the middle of the gap after the last whole segment (4 px wide, slanted with the bar)
            const xg = X(full * 500), W4 = cv.w * 4, src = lit.cv.d, dst = cv.d, x0 = Math.max(0, Math.floor(x));
            for (let py = Math.max(0, Math.floor(barY) - 1); py <= Math.min(cv.h - 1, Math.ceil(barY + barH)); py++) {
                const cut = Math.min(cv.w, Math.floor(xg + slant * (1 - (py + 0.5 - barY) / barH)) + 1);
                if (cut > x0) dst.set(src.subarray(py * W4 + x0 * 4, py * W4 + cut * 4), py * W4 + x0 * 4);
            }
            r0 = full * 500;
        }
        for (let r = r0; r < top; r += 500) seg(r, Math.min(top, r + 500), col(r));
    }
    // peak: a thin slanted line where the revs peaked, while they are below it
    if (fg && isNum(s.peak) && s.peak > 0 && !(isNum(rpm) && rpm >= s.peak - 50)) {
        const px = X(Math.min(s.peak, s.max));
        cv.line(px + slant, barY, px, barY + barH, 2, P.peak);
    }
}

/**
 * The LCD bar graph in (x, y, w, h): 40 rectangular segments, lit up to the rpm (low below the shift
 * point, mid past it, high into the redline; all flashing on the limiter), unlit ones as faint
 * ghosts (vfd) or dim (setting), the red zone tinted; shift and redline marks over it, the peak as one
 * bright segment outline.
 */
function drawGraph(cv, x, y, w, h, s, vfd) {
    const bg = s.layer !== 'fg', fg = s.layer !== 'bg', P = s.P, cue = s.cue, rpm = s.rpm;
    const n = 40, gap = 2, sw = (w - gap * (n - 1)) / n, top = y + 6, sh = h - 6;
    const rpmOf = (i) => (i + 0.5) * s.max / n;
    const sx = (i) => x + i * (sw + gap);
    const at = (r) => clamp(Math.floor(r / s.max * n), 0, n - 1);
    if (fg && isNum(s.shift) && s.shift < s.redline) cv.fillRect(sx(at(s.shift)) + sw / 2 - 1, y, 3, 4, P.mid);
    if (fg) cv.fillRect(sx(at(s.redline)) + sw / 2 - 1, y, 3, 4, P.limit);
    for (let i = 0; i < n; i++) {
        const r = rpmOf(i), zone = r >= s.redline;
        if (bg && (vfd || s.dim || zone)) cv.fillRect(sx(i), top, sw, sh, withAlpha(zone ? P.limit : P.text, zone ? 0.3 : vfd ? 0.1 : 0.12));
        if (fg && isNum(rpm) && r <= rpm) {
            const c = cue.limiter ? (s.blink ? P.limit : withAlpha(P.limit, 0.35)) : zone ? P.high : r >= s.shift ? P.mid : P.low;
            cv.fillRect(sx(i), top, sw, sh, c);
        }
    }
    if (fg && isNum(s.peak) && s.peak > 0 && !(isNum(rpm) && rpm >= s.peak - 50)) {
        const i = at(s.peak);
        cv.polyline([[sx(i), top], [sx(i) + sw, top], [sx(i) + sw, top + sh], [sx(i), top + sh], [sx(i), top]], 1.5, P.peak);
    }
}

/*
 * The Recovery / Power meter (a readout with .bar = { v, lo, hi }, kW: + the battery drives, - it recovers) on the
 * standard, vector, digital and vfd layouts: not in the readouts row but a thin row in the layout's own look under
 * its rev bar / bar graph, the same x range, its zero where lo..hi maps 0 (a third for -40..80). Recovery fills from
 * zero leftwards in the palette's low colour, drive rightwards in the text colour (warm from 85 % of hi); v 0 (or not
 * a number) fills nothing, beyond lo / hi fills to the end. Track and zero tick bg (they depend on lo / hi only), the
 * fill fg. Like the ramp's meter (hud-m.js rampMeter) it shows no number.
 */
const meterOf = (f) => (f.readouts || []).filter((it) => it.bar)[0] || null;
const meterRange = (bar) => { const lo = isNum(bar.lo) && bar.lo < 0 ? bar.lo : -1; return [lo, isNum(bar.hi) && bar.hi > 0 ? bar.hi : 1]; };
// recovery green (the VFD's blue: its green is its text colour, so recovery and power would look the same)
const meterCol = (v, hi, P) => (v < 0 ? (P === PALETTES.vfd ? P.cold : P.low) : v >= 0.85 * hi ? P.warm : P.text);
/**
 * Under the slanted rev bar (x, w: drawBar's; barH: its segments' height, for its slant): a strip of the bar's
 * slanted segments, top at y, h tall, from the bar's bottom-left to its bottom-right end; 18 segments split at the
 * zero. outline (vector): outlined segments, the fill outlined with a faint fill as the bar's lit segments.
 */
function drawBarMeter(cv, x, w, barH, y, h, bar, P, layer, outline) {
    const r = meterRange(bar), lo = r[0], hi = r[1], n = 18;
    const nl = clamp(Math.round(n * -lo / (hi - lo)), 1, n - 1), nr = n - nl, sl = 2;
    const run = w - Math.round(barH * 0.32) - sl, X = (v) => x + clamp((v - lo) / (hi - lo), 0, 1) * run;
    const trackCol = withAlpha(P.text, outline ? 0.3 : 0.12);
    const seg = (a, b, c) => {
        const xa = X(a) + 1, xb = X(b) - 1;
        if (!(xb > xa)) return;
        const q = [[xa + sl, y], [xb + sl, y], [xb, y + h], [xa, y + h]];
        if (outline) { cv.polyline(q.concat([q[0]]), 1.4, c); if (c !== trackCol) cv.quad(q, withAlpha(c, 0.3)); } else cv.quad(q, c);
    };
    const stepL = -lo / nl, stepR = hi / nr;
    if (layer !== 'fg') {
        for (let i = 0; i < nl; i++) seg(-stepL * (i + 1), -stepL * i, trackCol);
        for (let i = 0; i < nr; i++) seg(stepR * i, stepR * (i + 1), trackCol);
        // the zero tick: the bar's slant, bold and full bright, 1 px over and under the strip (the gaps to the bar and
        // the labels stay 2 px), so it reads at a glance where recovery ends and power starts (2026-11-10)
        const z = X(0), e = outline ? 0.7 : 1, k = sl / h, tw = 1.4;
        cv.quad([[z + k * e - tw, y - e], [z + k * e + tw, y - e], [z - k * (h + e) + tw, y + h + e], [z - k * (h + e) - tw, y + h + e]], P.text);
    }
    const v = bar.v;
    if (layer === 'bg' || !isNum(v) || v === 0) return;
    const c = meterCol(v, hi, P);
    if (v < 0) { const e = Math.max(v, lo); for (let i = 0; -stepL * i > e; i++) seg(Math.max(e, -stepL * (i + 1)), -stepL * i, c); }
    else { const e = Math.min(v, hi); for (let i = 0; stepR * i < e; i++) seg(stepR * i, Math.min(e, stepR * (i + 1)), c); }
}
/**
 * Under the 40-segment bar graph (x, w: drawGraph's): a row of the same columns, top at y, h tall; the zero at the
 * column boundary nearest where 0 maps (13 columns of recovery, 27 of drive for -40..80). A column lights when the
 * reading passes its middle, as the graph's; the unlit ones as faint ghosts.
 */
function drawGraphMeter(cv, x, w, y, h, bar, P, layer) {
    const r = meterRange(bar), lo = r[0], hi = r[1], n = 40, gap = 2, sw = (w - gap * (n - 1)) / n;
    const nl = clamp(Math.round(n * -lo / (hi - lo)), 1, n - 1), nr = n - nl, sx = (i) => x + i * (sw + gap);
    if (layer !== 'fg') {
        for (let i = 0; i < n; i++) cv.fillRect(sx(i), y, sw, h, withAlpha(P.text, 0.12));
        // the zero: bold and full bright, 1 px over and under the row (the gaps stay 2 px) (2026-11-10)
        cv.fillRect(sx(nl) - gap - 0.5, y - 1, gap + 1, h + 2, P.text);
    }
    const v = bar.v;
    if (layer === 'bg' || !isNum(v) || v === 0) return;
    const c = meterCol(v, hi, P);
    // j: the columns from the zero outwards
    if (v < 0) { for (let j = 0; j < nl && -v >= (j + 0.5) * -lo / nl; j++) cv.fillRect(sx(nl - 1 - j), y, sw, h, c); }
    else { for (let j = 0; j < nr && v >= (j + 0.5) * hi / nr; j++) cv.fillRect(sx(nl + j), y, sw, h, c); }
}

/**
 * Downshift cue: n chevrons (1..3) centred at cx from y down; k scales them. Quads with two corners at
 * the tip: the screen's Recorder has quad() but no convex(). col: the colour (default cyan).
 */
function drawDown(cv, cx, y, n, k, col) {
    if (!(n > 0)) return;
    const w = 14 * k, h = 9 * k, gap = 4 * k, x0 = cx - (n * w + (n - 1) * gap) / 2;
    for (let i = 0; i < n; i++) {
        const x = x0 + i * (w + gap);
        cv.quad([[x, y], [x + w, y], [x + w / 2, y + h], [x + w / 2, y + h]], col || '#22e0ff');
    }
}

/**
 * The readouts row from x0 to x1 at y: items [{ label, value, tone }] (tone: 'text' | 'cold' | 'warm' |
 * 'hot'), as many columns as items (4 at most: hud.js keeps it there), slightly smaller beyond 3. Labels
 * are bg, values fg. The Recovery / Power meter (an item with .bar) is not in the row: drawBarMeter / drawGraphMeter.
 */
function drawReadouts(cv, x0, x1, y, items, P, layer, clear) {
    items = items.filter((it) => !it.bar);
    if (!items.length) return;
    const n = items.length, colw = (x1 - x0) / Math.max(3, n), k = Math.min(1, colw / 70);
    items.forEach((it, i) => {
        const cx = x0 + colw * (i + 0.5);
        // labels: Normal 14 px nearly full brightness, Clearer 18 px full (12 px at 75 % read as specks on the
        // glass); either made smaller to fit its column, so four readouts never run into each other
        // the Tyres readout: TYRES over its four pressures in a 2x2 block (front over rear) when the column holds
        // them (56 px and up: four readouts in the row's 250 px leave 62); else the worst tyre as label and value
        const block = it.tyres && it.tyres.length === 4 && colw >= 56;
        const label = block ? it.block : it.label;
        if (layer !== 'fg') {
            const lo = { align: 'center', font: 'bold', spacing: (clear ? 1.5 : 1.2) * k };
            const s = Theme.fitSize(cv, label, (clear ? 18 : 14) * k, colw - 14, lo);
            cv.text(label, cx, y + (clear ? 15 : 13), s, clear ? P.text : withAlpha(P.text, 0.9), lo);
        }
        if (layer === 'bg') return;
        if (block) {
            const dx = Math.min(colw / 4, 22), vs = 17, top = y + (clear ? 34 : 32);
            it.tyres.forEach((c, j) => cv.text(c[0], cx + (j % 2 ? dx : -dx), top + Math.floor(j / 2) * 19, vs, Theme.toneCol(c[1], P, P.text), { align: 'center', font: 'bold' }));
            return;
        }
        cv.text(it.value, cx, y + 40, 26 * Math.max(0.8, k), Theme.toneCol(it.tone, P, P.text), { align: 'center', font: 'bold' });
    });
}
/**
 * After an upshift: its grade across the readouts row. chip = { verdict, age (ms), burst }. Burst: the
 * word (PERFECT SHIFT for spot on) pops in big and settles in 150 ms, a ring grows from it over 500 ms
 * and fades, and the word fades over the last 300 ms of its 1.5 s.
 */
function drawChip(cv, x0, x1, y, chip, P) {
    // a chip may carry its own text and colour (the launch time: { text, tone }); the grades go by the verdict
    const c = Theme.chipCol(chip, P), cx = (x0 + x1) / 2;
    if (!chip.burst) { cv.text(chip.text || chip.verdict, cx, y + 36, 28, c, { align: 'center', font: 'bold', spacing: 2 }); return; }
    const a = chip.age || 0, k = Theme.burstRing(a);
    const size = a < Theme.BURST.pop ? 34 - 8 * (a / Theme.BURST.pop) : 26, alpha = Theme.burstAlpha(a);
    if (k >= 0) {
        // round the word, inside the image (the screen's 2x preview doesn't clip)
        const rr = Math.min(30 + 36 * k, IH - (y + 26) - 2);
        cv.arc(cx, y + 26, rr - 2, rr, 0, 360, withAlpha(c, 0.8 * (1 - k)));
    }
    if (alpha > 0) cv.text(chip.text || VERDICT_TEXT[chip.verdict] || chip.verdict, cx, y + 36, size, withAlpha(c, alpha), { align: 'center', font: 'bold', spacing: 1.5 });
}

/** The parts every layout draws the same way. */
function lightsRow(x, y, w, d) {
    const n = 12, pitch = w / n, pts = [];
    for (let i = 0; i < n; i++) pts.push([x + pitch * (i + 0.5), y + d / 2]);
    return { pts: pts, rad: Math.min(d / 2, pitch * 0.36) };
}

/**
 * Draws one layer ('bg' or 'fg') of the HUD image for f = { d, shift, redline, max, blink, cue, down,
 * peak, readouts: [items], chip (verdict or null), opts: { style, palette, lights, gt3, dim, gear,
 * lightStyle } }.
 */
function drawLayer(cv, f, layer) {
    const o = f.opts, d = f.d, P = palette(o.style === 'vfd' ? 'vfd' : o.palette), cue = f.cue;
    if (o.style === 'arc' || o.style === 'ramp' || o.style === 'dial' || o.style === 'pill') {
        M.drawM(cv, f, layer, { P: P, gearText: gearText, drawDown: drawDown, lightCol: lightCol, RACE_BLUE: RACE_BLUE, gearFont: gearFont, base: layer === 'fg' ? fgBase : null,
            drawLights: drawLights, seg7: seg7 });
        return;
    }
    // the gearbox mode (D / S / M) as a small letter by the gear
    if (layer !== 'bg' && f.mode && o.gear) {
        const at = o.style === 'wings' ? [IW / 2 + 34, 24] : o.style === 'digital' || o.style === 'vfd' ? [58, 22] : [56, 24];
        cv.text(f.mode, at[0], at[1], 18, withAlpha(P.text, 0.85), { font: 'bold' });
    }
    const s = { rpm: d.rpm, cue: cue, shift: f.shift, redline: f.redline, max: f.max, blink: f.blink, dim: o.dim, style: o.lightStyle, P: P, layer: layer, peak: f.peak };
    // knock on the layouts with no place for the warning (Minimal, Split wings): the gear goes red as well
    const knock = f.chip && f.chip.verdict === 'KNOCK';
    const gearCol = (cue.limiter && f.blink) || (knock && (o.style === 'minimal' || o.style === 'wings')) ? P.limit : P.text;
    const fg = layer !== 'bg';

    if (o.style === 'digital' || o.style === 'vfd') {
        // 80s digital dash / VFD: 7-segment gear on the left, square lights, a 40-segment bar graph,
        // 7-segment rpm under it, then the readouts (or the grade)
        const ghost = o.style === 'vfd' || o.dim ? withAlpha(P.text, 0.1) : null;
        if (o.lights) {
            const pts = [], n = 12, x0 = 76, w0 = IW - x0, pitch = w0 / n;
            for (let i = 0; i < n; i++) pts.push([x0 + pitch * (i + 0.5), 8]);
            drawLights(cv, pts, pts.map((p, i) => (o.gt3 ? Math.min(i, 11 - i) : i)), o.gt3 ? 6 : 12, 6, Object.assign({}, s, { shape: 'rect', ghost: o.style === 'vfd' }));
        }
        if (o.bar !== false) drawGraph(cv, 76, 18, IW - 76, 36, s, o.style === 'vfd');
        // the power meter: between the graph (to y 53) and the rpm digits / readout labels (from 64)
        const meter = meterOf(f);
        if (meter) drawGraphMeter(cv, 76, IW - 76, 57, 4, meter.bar, P, layer);
        if (o.gear) seg7(cv, gearText(d).slice(0, 1), 4, 10, 50, 86, 9, gearCol, ghost, false, layer);
        if (fg) drawDown(cv, 29, 106, f.down || 0, 1, P.arrow);
        const rpmTxt = isNum(d.rpm) && d.rpm < 9995 ? String(Math.max(0, Math.round(d.rpm / 10) * 10)).padStart(4, ' ') : '----';
        if (o.rpm !== false) seg7text(cv, rpmTxt, 76, 64, 16, 30, 4, 5, P.text, ghost, false, layer);
        if (f.chip) { if (fg) drawChip(cv, 166, IW, 62, f.chip, P); } else drawReadouts(cv, 166, IW, 62, f.readouts || [], P, layer, o.clearLabels);
        return;
    }

    if (o.style === 'wings') {
        // gear centred, 6 lights each side filling towards it (outermost first), the bar underneath
        if (o.lights) {
            const pts = [], pos = [], d0 = 16;
            for (let i = 0; i < 6; i++) { pts.push([14 + i * 26, 30]); pos.push(i); }
            for (let i = 0; i < 6; i++) { pts.push([IW - 14 - i * 26, 30]); pos.push(i); }
            drawLights(cv, pts, pos, 6, d0 / 2, s);
        }
        if (o.bar !== false) drawBar(cv, 0, 84, IW, 40, s);
        if (fg) {
            if (o.gear) cv.text(gearText(d), IW / 2, 70, 72, gearCol, { align: 'center', font: gearFont(o) });
            drawDown(cv, IW / 2 + 52, 34, f.down || 0, 1, P.arrow);
        }
        return;
    }

    const tx = o.gear ? 70 : 0, tw = IW - tx;
    if (o.style === 'vector') {
        // the standard layout in outline: rings, outlined segments, an outlined 7-segment gear
        s.outline = true; s.shape = 'ring';
        if (o.gear) seg7(cv, gearText(d).slice(0, 1), 8, 12, 44, 72, 8, gearCol, withAlpha(P.text, 0.12), true, layer);
        if (fg) drawDown(cv, 30, 92, f.down || 0, 1, P.arrow);
    } else if (fg && o.gear) {
        cv.text(gearText(d), 30, 78, 72, gearCol, { align: 'center', font: gearFont(o) });
        drawDown(cv, 30, 90, f.down || 0, 1, P.arrow);
    }
    if (o.style === 'minimal') {
        // bigger lights only, centred on the gear's height
        if (o.lights) {
            const r = lightsRow(tx, 26, tw, 22);
            drawLights(cv, r.pts, r.pts.map((p, i) => (o.gt3 ? Math.min(i, 11 - i) : i)), o.gt3 ? 6 : 12, r.rad, s);
        }
        // the knock warning in the room under the lights (Minimal shows no grades)
        if (fg && knock) cv.text('KNOCK', tx + tw / 2, 100, 26, P.limit, { align: 'center', font: 'bold', spacing: 2 });
        return;
    }

    // standard (and vector): lights, bar, readouts or a shift grade
    if (o.lights) {
        const r = lightsRow(tx, 2, tw, 14);
        drawLights(cv, r.pts, r.pts.map((p, i) => (o.gt3 ? Math.min(i, 11 - i) : i)), o.gt3 ? 6 : 12, r.rad, s);
    }
    if (o.bar !== false) drawBar(cv, tx, o.lights ? 20 : 2, tw, o.lights ? 38 : 56, s);
    // the power meter: between the bar (to y 57, lights on or off; vector's outline to 58) and the readout labels
    // (from 68 with the clearer labels), 2 px clear of both: rows 60..65 (vector's outlines 61..65)
    const meter = meterOf(f), vec = o.style === 'vector';
    if (meter) drawBarMeter(cv, tx, tw, o.lights ? 28 : 46, vec ? 61.7 : 61, vec ? 3.6 : 4, meter.bar, P, layer, vec);
    if (f.chip) { if (fg) drawChip(cv, TEMP_X, IW, 66, f.chip, P); } else drawReadouts(cv, TEMP_X, IW, 66, f.readouts || [], P, layer, o.clearLabels);
}

/** The key of the static ('bg') layer: what it depends on. */
function bgKey(f) {
    const o = f.opts, c = f.cue;
    return [o.style, o.style === 'vfd' ? 'vfd' : o.palette, o.gear, o.rpm, o.bar, o.lights, o.gt3, o.dim, o.lightStyle, o.clearLabels, f.redline, f.max, c.shift || c.limiter, c.limiter,
        // the power meter's bar: its wideness and range (where the zero tick is) are static too
        f.chip ? 'chip' : (f.readouts || []).map((r) => r.label + (r.bar ? '~' + (r.wide ? 'w' : '') + r.bar.lo + '~' + r.bar.hi : '')).join(','),
        // the meter under the bar shows with a grade too
        (f.readouts || []).filter((r) => r.bar).slice(0, 1).map((r) => 'm' + r.bar.lo + '~' + r.bar.hi).join('')].join('|');
}

const bgCache = { key: '', cv: null };
// drawHud's static layer while it draws the moving one over it (drawBar copies its lit segments from litBars, the bar
// drawn lit over that layer); null otherwise (drawLayer called on its own draws everything)
let fgBase = null;
const litBars = [], LIT_KEEP = 4;
/** The whole HUD image into cv (IW x IH): the cached static part, then what moves. */
function drawHud(cv, f) {
    const key = bgKey(f);
    if (bgCache.key !== key || !bgCache.cv) {
        const b = new Canvas(IW, IH);
        drawLayer(b, f, 'bg');
        bgCache.key = key; bgCache.cv = b;
    }
    if (cv.d && cv.d.length === bgCache.cv.d.length) cv.d.set(bgCache.cv.d); else { cv.clear(); cv.blit(bgCache.cv, 0, 0); }
    fgBase = bgCache.cv;
    try { drawLayer(cv, f, 'fg'); } finally { fgBase = null; }
    // redline shake: f.shake = [dx, dy] moves the whole picture a few px (on the limiter)
    if (f.shake && (f.shake[0] || f.shake[1]) && cv.d) shift(cv, Math.round(f.shake[0]), Math.round(f.shake[1]));
}

/**
 * Move the whole picture by (dx, dy) whole px in place, the uncovered edge left transparent: a row copy each
 * (copyWithin), rows taken in the order that never reads one already overwritten. Was a copy, a clear and a
 * blend per pixel: about a quarter of a frame, right on the limiter.
 */
function shift(cv, dx, dy) {
    const W = cv.w, H = cv.h, d = cv.d, row = W * 4;
    const x0 = Math.max(0, dx), x1 = Math.min(W, W + dx), n = (x1 - x0) * 4;
    if (n <= 0 || Math.abs(dy) >= H) { d.fill(0); return; }
    const one = (py) => {
        const o = py * row, sy = py - dy;
        if (sy < 0 || sy >= H) { d.fill(0, o, o + row); return; }
        const so = sy * row + (x0 - dx) * 4;
        d.copyWithin(o + x0 * 4, so, so + n);
        if (x0 > 0) d.fill(0, o, o + x0 * 4);
        if (x1 < W) d.fill(0, o + x1 * 4, o + row);
    };
    if (dy > 0) for (let py = H - 1; py >= 0; py--) one(py); else for (let py = 0; py < H; py++) one(py);
}

/**
 * A drawing surface that scales by k and moves by (ox, oy) on the way to r: the HUD's drawing at
 * another size on the screen (the software renderer doesn't do the Recorder's xf transform).
 */
function scaled(r, k, ox, oy) {
    const X = (x) => ox + x * k, Y = (y) => oy + y * k, P = (pts) => pts.map((p) => [X(p[0]), Y(p[1])]);
    return {
        circle: (cx, cy, rad, c) => r.circle(X(cx), Y(cy), rad * k, c),
        arc: (cx, cy, r0, r1, a0, a1, c) => r.arc(X(cx), Y(cy), r0 * k, r1 * k, a0, a1, c),
        fillRect: (x, y, w, h, c) => r.fillRect(X(x), Y(y), w * k, h * k, c),
        quad: (pts, c) => r.quad(P(pts), c),
        // any polygon in one piece (Ramp's rail and band: no seams); a canvas without it gets nothing drawn.
        // strip: pts is a top edge then its bottom edge reversed, point for point (the screen's recorder cuts it so)
        fill: (pts, c, strip) => (r.fill ? r.fill(P(pts), c, strip) : null),
        polyline: (pts, w, c) => r.polyline(P(pts), w * k, c),
        // a path with round joins (Ramp's rail); a plain polyline where the canvas has no stroke
        stroke: (pts, w, c) => (r.stroke ? r.stroke(P(pts), w * k, c) : r.polyline(P(pts), w * k, c)),
        line: (xa, ya, xb, yb, w, c) => r.line(X(xa), Y(ya), X(xb), Y(yb), w * k, c),
        text: (s, x, y, size, c, o) => r.text(s, X(x), Y(y), size * k, c, o && o.spacing ? Object.assign({}, o, { spacing: o.spacing * k }) : o),
        roundRect: (x, y, w, h, rad, c) => r.roundRect(X(x), Y(y), w * k, h * k, rad * k, c),
        strokeRoundRect: (x, y, w, h, rad, width, c) => r.strokeRoundRect(X(x), Y(y), w * k, h * k, rad * k, width * k, c),
        textWidth: (s, size, o) => r.textWidth(s, size * k, o && o.spacing ? Object.assign({}, o, { spacing: o.spacing * k }) : o) / k,
    };
}

module.exports = { scaled, lightCol, gearFont, drawHud, drawLayer, drawDown, gearText, PALETTES, IW, IH, TEMP_X };
