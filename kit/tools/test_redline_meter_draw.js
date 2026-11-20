'use strict';

// Redline HUD: the Recovery / Power meter on the standard, vector, digital and vfd layouts (hud-draw.js drawBarMeter,
// drawGraphMeter): a thin row in each layout's own look under its rev bar / bar graph, not in the readouts row.
//   node kit/tools/test_redline_meter_draw.js
// - the fill: recovery left of the zero in the palette's low colour, drive right of it in the text colour (warm from
//   85 % of hi), nothing at 0, held at the ends beyond lo / hi; the zero a third of the way across for -40..80;
// - the layers: track and zero tick on bg (the same whatever v), the fill on fg; the cached static layer follows the
//   meter appearing, going and its range;
// - the readouts row: no POWER column (the others as in a row without it);
// - room: a gap to the bar over it and to the readout labels / rpm digits under it, lights on and off, both label sizes;
// - a shift grade replacing the readouts leaves the meter.

const path = require('path');
const TH = require('./redline_test_harness');
const ROOT = TH.ROOT;
TH.hookKit();
const Draw = require(path.join(ROOT, 'apps', 'redline', 'hud-draw'));
const { Canvas, rgba } = require(path.join(ROOT, 'kit', 'runtime', 'canvas'));

const tally = TH.counter(), ok = tally.ok;

const pw = (v, lo, hi) => ({ label: 'POWER', value: '+12', tone: 'text', bar: { v: v, lo: lo === undefined ? -40 : lo, hi: hi === undefined ? 80 : hi }, wide: true });
const OIL = { label: 'OIL', value: '95°', tone: 'text' }, WAT = { label: 'WATER', value: '90°', tone: 'text' }, BO = { label: 'BOOST', value: '1.2', tone: 'text' };
const opts = (style, over) => Object.assign({ style: style, palette: 'colour', gear: true, rpm: true, bar: true, lights: true, gt3: false, dim: false,
    lightStyle: 'm', clearLabels: false, gearFont: 'ubuntu' }, over || {});
const frame = (style, readouts, over, chip) => ({
    d: { rpm: 4200, gear: 3, stage: 'D' }, shift: 5550, redline: 6550, max: 8000, blink: true, down: 0, peak: 0, chip: chip || null,
    cue: { from: 4400, at: 5550, shift: false, limiter: false }, readouts: readouts, mode: null, opts: opts(style, over),
});
function layer(f, l) { const cv = new Canvas(Draw.IW, Draw.IH); Draw.drawLayer(cv, f, l); return cv; }
function hud(f, before) { const cv = new Canvas(Draw.IW, Draw.IH); if (before) Draw.drawHud(cv, before); Draw.drawHud(cv, f); return cv; }
const same = (a, b) => Buffer.from(a.d).equals(Buffer.from(b.d));
/** The pixels that differ between a and b in rows y0..y1: { n, minX, maxX, minY, maxY, cols (in a) }. */
function diff(a, b, y0, y1) {
    const r = { n: 0, minX: 1e9, maxX: -1, minY: 1e9, maxY: -1, cols: [] };
    for (let y = y0; y <= y1; y++) for (let x = 0; x < a.w; x++) {
        const i = (y * a.w + x) * 4;
        if (a.d[i] !== b.d[i] || a.d[i + 1] !== b.d[i + 1] || a.d[i + 2] !== b.d[i + 2] || a.d[i + 3] !== b.d[i + 3]) {
            r.n++; r.minX = Math.min(r.minX, x); r.maxX = Math.max(r.maxX, x); r.minY = Math.min(r.minY, y); r.maxY = Math.max(r.maxY, y);
            r.cols.push([a.d[i], a.d[i + 1], a.d[i + 2], a.d[i + 3]]);
        }
    }
    return r;
}
const isCol = (c, col) => { const v = rgba(col); return c[3] === 255 && Math.abs(c[0] - v[0]) <= 2 && Math.abs(c[1] - v[1]) <= 2 && Math.abs(c[2] - v[2]) <= 2; };
const mostly = (cols, col) => cols.length > 0 && cols.filter((c) => isCol(c, col)).length >= cols.length * 0.5;
/** Rows y0..y1 with any pixel in x0..x1 (alpha > 0). */
function rowsOf(cv, x0, x1, y0, y1) { const out = []; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (cv.d[(y * cv.w + x) * 4 + 3]) { out.push(y); break; } return out; }

/*
 * Where the meter is: [name, style, over, x0 (left end), x1 (right end), y0, y1 (its rows), zero x for -40..80].
 * standard / vector: under the bar from x 70 (the gear's room) to the bar's bottom-right end; digital / vfd: the graph's
 * 40 columns from 76 to 400, 13 of them recovery.
 */
const CASES = [
    ['standard', 'standard', {}, 70, 391, 61, 64],
    ['standard lights off', 'standard', { lights: false }, 70, 385, 61, 64],
    ['standard no gear', 'standard', { gear: false }, 0, 391, 61, 64],
    ['vector', 'vector', {}, 70, 391, 62, 64],
    ['digital', 'digital', {}, 76, 400, 57, 60],
    ['vfd', 'vfd', {}, 76, 400, 57, 60],
];
CASES.forEach((c) => {
    const name = c[0], style = c[1], over = c[2], x0 = c[3], x1 = c[4], y0 = c[5], y1 = c[6];
    const P = style === 'vfd' ? Draw.PALETTES.vfd : Draw.PALETTES.colour, vec = style === 'vector';
    const fg = (v, lo, hi) => layer(frame(style, [pw(v, lo, hi), OIL, WAT], over), 'fg'), none = layer(frame(style, [OIL, WAT], over), 'fg');
    const z = x0 + (x1 - x0) / 3;
    // 0: nothing on fg (the same as without the meter), and no reading either
    ok(same(fg(0), none) && same(fg(NaN), none), name + ': 0 kW (or none) fills nothing');
    // recovery: left of the zero, low, about half way to lo at -20
    const rec = diff(fg(-20), none, 0, 129);
    ok(rec.n > 0 && rec.minY >= y0 - 1 && rec.maxY <= y1 + 1, name + ': -20 kW fills only the meter\'s rows (' + rec.minY + '..' + rec.maxY + ')');
    ok(rec.maxX < z + 3, name + ': -20 kW fills left of the zero (x ' + rec.minX + '..' + rec.maxX + ', zero ~' + z.toFixed(0) + ')');
    ok(vec || mostly(rec.cols, P === Draw.PALETTES.vfd ? P.cold : P.low), name + ': recovery in the palette\'s low colour');
    ok(Math.abs(rec.minX - (z - (z - x0) / 2)) <= 6, name + ': -20 kW reaches about half way to lo (x ' + rec.minX + ', ~' + (z - (z - x0) / 2).toFixed(0) + ')');
    // drive: right of it, text colour, half way to hi at +40
    const drv = diff(fg(40), none, 0, 129);
    ok(drv.n > 0 && drv.minX > z - 4 && drv.minY >= y0 - 1 && drv.maxY <= y1 + 1, name + ': +40 kW fills right of the zero (x ' + drv.minX + '..' + drv.maxX + ')');
    ok(vec || mostly(drv.cols, P.text), name + ': drive in the text colour');
    ok(Math.abs(drv.maxX - (z + (x1 - z) / 2)) <= 6, name + ': +40 kW reaches about half way to hi (x ' + drv.maxX + ', ~' + (z + (x1 - z) / 2).toFixed(0) + ')');
    const warm = diff(fg(70), none, 0, 129), notWarm = diff(fg(67), none, 0, 129);
    ok(vec ? warm.cols.some((p) => isCol(p, P.warm)) : mostly(warm.cols, P.warm) && !notWarm.cols.some((p) => isCol(p, P.warm)), name + ': warm from 85 % of hi (68 kW)');
    if (vec) ok(drv.cols.some((p) => isCol(p, P.text)) && rec.cols.some((p) => isCol(p, P.low)), name + ': outlined fill in low / text');
    // clamping
    ok(same(fg(-100), fg(-40)) && same(fg(500), fg(80)), name + ': beyond lo / hi draws as lo / hi');
    const full = diff(fg(80), none, 0, 129), empty = diff(fg(-40), none, 0, 129);
    ok(empty.minX >= x0 - 1 && Math.abs(empty.minX - x0) <= 3 && full.maxX <= x1 && Math.abs(full.maxX - x1) <= 3, name + ': the ends fill to the track\'s ends (' + empty.minX + '..' + full.maxX + ')');
    // bg / fg
    const bg = (v) => layer(frame(style, [pw(v), OIL, WAT], over), 'bg'), bgNone = layer(frame(style, [OIL, WAT], over), 'bg');
    ok(same(bg(-20), bg(65)) && same(bg(0), bg(-20)), name + ': bg the same whatever v');
    const tr = diff(bg(0), bgNone, 0, 129);
    ok(tr.n > 0 && tr.minY >= y0 - 1 && tr.maxY <= y1 + 1 && tr.minX >= x0 - 1 && tr.maxX <= x1 + 1, name + ': track and zero tick on bg, in the meter\'s place (x ' + tr.minX + '..' + tr.maxX + ', y ' + tr.minY + '..' + tr.maxY + ')');
    ok(tr.minY === y0 - 1 && tr.maxY === y1 + 1, name + ': the zero tick 1 px over and under the track');
    ok(!same(layer(frame(style, [pw(0, -60, 80), OIL, WAT], over), 'bg'), bg(0)), name + ': the range moves the zero (bg)');
    // the row: no POWER column; the other readouts as without it
    const rowY0 = style === 'digital' || style === 'vfd' ? 62 : 66;
    ok(diff(layer(frame(style, [pw(-20), OIL, WAT], over), 'both'), layer(frame(style, [OIL, WAT], over), 'both'), rowY0, 129).n === 0, name + ': no POWER in the readouts row');
    ok(diff(layer(frame(style, [OIL, pw(30), WAT, BO], over), 'both'), layer(frame(style, [OIL, WAT, BO], over), 'both'), rowY0, 129).n === 0, name + ': the power item takes no column');
    // the grade: the meter stays
    const chip = { verdict: 'SPOT ON', age: 100, burst: true };
    const ch = diff(hud(frame(style, [pw(-20), OIL], over, chip)), hud(frame(style, [OIL], over, chip)), 0, 129);
    ok(ch.n > 0 && ch.minY >= y0 - 1 && ch.maxY <= y1 + 1, name + ': with a shift grade the meter still shows (y ' + ch.minY + '..' + ch.maxY + ')');
    // drawHud (bg cached, fg over it): the meter's track and fill, nothing else changed
    const hd = diff(hud(frame(style, [pw(-20), OIL, WAT], over)), hud(frame(style, [OIL, WAT], over)), 0, 129);
    ok(hd.n > rec.n && hd.minY >= y0 - 1 && hd.maxY <= y1 + 1 && hd.cols.some((p) => isCol(p, vec ? Draw.PALETTES.colour.low : (P === Draw.PALETTES.vfd ? P.cold : P.low))), name + ': drawHud: track and fill in the meter rows only');
});

/* ---------- room: a gap to the bar over the meter and to what's under it ---------- */
['standard', 'vector', 'digital', 'vfd'].forEach((style) => [true, false].forEach((lights) => [false, true].forEach((clear) => {
    const over = { lights: lights, clearLabels: clear, dim: true }, dig = style === 'digital' || style === 'vfd';
    const name = style + (lights ? '' : ' lights off') + (clear ? ' clearer labels' : '');
    const all = layer(frame(style, [pw(-40), OIL, WAT, BO], over), 'both'), noM = layer(frame(style, [OIL, WAT, BO], over), 'both');
    const m = diff(all, noM, 0, 129);
    // the bar / graph: the rows over the meter that have anything (from x0 to 400), labels: the row's first
    const x0 = dig ? 76 : 70, above = rowsOf(noM, x0, 399, 0, m.minY).pop(), below = rowsOf(noM, x0, 399, m.maxY, 129)[0];
    ok(m.minY - above >= 2, name + ': a gap of 2 px or more to the bar over it (bar to ' + above + ', meter from ' + m.minY + ')');
    ok(below - m.maxY >= 2, name + ': a gap of 2 px or more to the labels / digits under it (meter to ' + m.maxY + ', next from ' + below + ')');
})));

/* ---------- the cached static layer ---------- */
{
    const base = frame('standard', [OIL, WAT]), withM = frame('standard', [pw(-20), OIL, WAT]), lo60 = frame('standard', [pw(-20, -60, 80), OIL, WAT]);
    const other = frame('standard', [BO]);
    ok(same(hud(withM, base), hud(withM, other)), 'drawHud: the meter appearing redraws the static layer');
    ok(same(hud(base, withM), hud(base, other)), 'drawHud: the meter going redraws the static layer');
    ok(same(hud(lo60, withM), hud(lo60, other)), 'drawHud: the range changing redraws the static layer');
    const chip = { verdict: 'EARLY' };
    const cm = frame('digital', [pw(-20), OIL], {}, chip), cn = frame('digital', [OIL], {}, chip), co = frame('digital', [BO], {}, { verdict: 'LATE' });
    ok(same(hud(cm, cn), hud(cm, co)) && same(hud(cn, cm), hud(cn, co)), 'drawHud: with a grade showing, the meter appearing / going redraws the static layer');
}

/* ---------- no meter elsewhere: minimal and wings have no room ---------- */
['minimal', 'wings'].forEach((st) => ok(same(layer(frame(st, [pw(-20), OIL]), 'both'), layer(frame(st, [OIL]), 'both')), st + ': no meter'));

console.log(tally.checks + ' checks, ' + tally.fails + ' failed');
process.exit(tally.fails ? 1 : 0);
