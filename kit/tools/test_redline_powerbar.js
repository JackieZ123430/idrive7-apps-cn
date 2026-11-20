'use strict';

// Redline HUD: the Recovery / Power meter (a readout with .bar = { v, lo, hi }, kW: + the battery drives, - it recovers).
//   node kit/tools/test_redline_powerbar.js
// - standard, vector, digital and vfd draw it as a row in their own look under the rev bar / bar graph, not in the
//   readouts row: test_redline_meter_draw.js; here only that the static layer follows it and wide means nothing else;
// - standard and digital (arc, dial and ramp draw it as a band following their own: test_redline_meter_m.js and below);
// - the other readouts draw as before.

const path = require('path');
const TH = require('./redline_test_harness');
const ROOT = TH.ROOT;
TH.hookKit();
const Draw = require(path.join(ROOT, 'apps', 'redline', 'hud-draw'));
const { Canvas, rgba } = require(path.join(ROOT, 'kit', 'runtime', 'canvas'));

const tally = TH.counter(), ok = tally.ok;
const P = Draw.PALETTES.colour;

const pw = (v, wide, value) => ({ label: 'POWER', value: value || '+12', tone: 'text', bar: { v: v, lo: -40, hi: 80 }, wide: wide !== false });
const OIL = { label: 'OIL', value: '95°', tone: 'text' }, WAT = { label: 'WATER', value: '90°', tone: 'text' }, BO = { label: 'BOOST', value: '1.2', tone: 'text' };
const opts = (style, over) => Object.assign({ style: style, palette: 'colour', gear: true, rpm: true, bar: true, lights: true, gt3: true, dim: false,
    lightStyle: 'm', clearLabels: false, gearFont: 'ubuntu' }, over || {});
const frame = (style, readouts, over) => ({
    d: { rpm: 4200, gear: 3, stage: 'D' }, shift: 5550, redline: 6550, max: 8000, blink: true, down: 0, peak: 0, chip: null,
    cue: { from: 4400, at: 5550, shift: false, limiter: false }, readouts: readouts, mode: null, opts: opts(style, over),
});
function layer(f, l) { const cv = new Canvas(Draw.IW, Draw.IH); Draw.drawLayer(cv, f, l); return cv; }
function hud(f, before) { const cv = new Canvas(Draw.IW, Draw.IH); if (before) Draw.drawHud(cv, before); Draw.drawHud(cv, f); return cv; }
const same = (a, b) => Buffer.from(a.d).equals(Buffer.from(b.d));
const px = (cv, x, y) => { const i = (Math.round(y) * cv.w + Math.round(x)) * 4; return [cv.d[i], cv.d[i + 1], cv.d[i + 2], cv.d[i + 3]]; };
/** The pixels that differ between a and b (in rows y0..y1): { n, minX, maxX, cols: colours at those pixels in a }. */
function diff(a, b, y0, y1) {
    const r = { n: 0, minX: 1e9, maxX: -1, cols: [] };
    for (let y = y0; y <= y1; y++) for (let x = 0; x < a.w; x++) {
        const i = (y * a.w + x) * 4;
        if (a.d[i] !== b.d[i] || a.d[i + 1] !== b.d[i + 1] || a.d[i + 2] !== b.d[i + 2] || a.d[i + 3] !== b.d[i + 3]) {
            r.n++; r.minX = Math.min(r.minX, x); r.maxX = Math.max(r.maxX, x); r.cols.push([a.d[i], a.d[i + 1], a.d[i + 2], a.d[i + 3]]);
        }
    }
    return r;
}
/** Is colour c (a full pixel) the colour col? */
const isCol = (c, col) => { const v = rgba(col); return c[3] === 255 && Math.abs(c[0] - v[0]) <= 2 && Math.abs(c[1] - v[1]) <= 2 && Math.abs(c[2] - v[2]) <= 2; };
const mostly = (cols, col) => cols.length > 0 && cols.filter((c) => isCol(c, col)).length >= cols.length * 0.6;

/* ---------- the cached static layer follows the bar ---------- */
{
    const plain = frame('standard', [{ label: 'POWER', value: '+12', tone: 'text' }, OIL, WAT]);
    const withBar = frame('standard', [pw(-20), OIL, WAT]), narrow = frame('standard', [pw(-20, false), OIL, WAT]);
    const lo50 = frame('standard', [{ label: 'POWER', value: '+12', tone: 'text', bar: { v: -20, lo: -50, hi: 80 }, wide: true }, OIL, WAT]);
    const other = frame('standard', [BO]);
    ok(same(hud(withBar, plain), hud(withBar, other)), 'drawHud: the bar appearing redraws the static layer');
    ok(same(hud(plain, withBar), hud(plain, other)), 'drawHud: the bar going redraws the static layer');
    ok(same(hud(narrow, withBar), hud(narrow, other)) && same(hud(withBar, narrow), hud(withBar, other)), 'drawHud: wide changing redraws the static layer');
    ok(same(hud(lo50, withBar), hud(lo50, other)), 'drawHud: the range changing (the zero moves) redraws the static layer');
}

/* ---------- arc and dial: the meter is a ring (test_redline_meter_m.js), not in the readouts list ---------- */
['arc', 'dial'].forEach((st) => {
    const a = layer(frame(st, [OIL, pw(-20), WAT]), 'both'), b = layer(frame(st, [OIL, WAT, pw(-20)]), 'both'), c = layer(frame(st, [OIL, WAT]), 'both');
    ok(same(a, b) && !same(a, c), st + ': the power item takes no slot in the list (drawn as the ring)');
});

/* ---------- the other readouts: as before ---------- */
['standard', 'digital', 'vector', 'vfd'].forEach((st) => ['bg', 'fg'].forEach((l) => {
    // wide on an item without a bar means nothing
    ok(same(layer(frame(st, [Object.assign({ wide: true }, BO), OIL]), l), layer(frame(st, [BO, OIL]), l)), st + ' ' + l + ': wide without a bar changes nothing');
}));

/* ---------- ramp: the meter a strip under the band, the rail's shape (2026-11-10 sketch; 2.0.21 redraw) ---------- */
{
    // the list draws as if the power item weren't there (it takes no place in it)
    {
        const a = layer(frame('ramp', [BO, pw(-20), OIL]), 'bg'), b = layer(frame('ramp', [BO, OIL]), 'bg');
        const d = diff(a, b, 0, 129);
        ok(d.n > 0 && d.maxX <= 380, 'ramp bg: only the meter track differs (x ' + d.minX + '..' + d.maxX + ')');
        // fg: the gear and the list move 5 px down with the meter, clear of it
        const top = (cv, x0, x1) => { for (let y = 0; y < cv.h; y++) for (let x = x0; x < x1; x++) if (y > 36 && cv.d[(y * cv.w + x) * 4 + 3] > 128) return y; return -1; };
        const fa = layer(frame('ramp', [BO, pw(0), OIL]), 'fg'), fb = layer(frame('ramp', [BO, OIL]), 'fg');
        ok(top(fa, 262, 396) - top(fb, 262, 396) === 5 && top(fa, 118, 134) - top(fb, 118, 134) === 5, 'ramp fg: with the meter the list and the gear sit 5 px lower (list ' + top(fb, 262, 396) + ' -> ' + top(fa, 262, 396) + ', gear ' + top(fb, 118, 134) + ' -> ' + top(fa, 118, 134) + ')');
        ok(top(fa, 262, 372) >= 47, 'ramp fg: a gap under the meter (first row ' + top(fa, 262, 372) + ', meter ends at 43)');
    }
    const fill = (v) => diff(layer(frame('ramp', [BO, pw(v), OIL]), 'both'), layer(frame('ramp', [BO, pw(0), OIL]), 'both'), 0, 129);
    const rec = fill(-20), pwr = fill(40), full = fill(80), none = fill(0);
    ok(none.n === 0, 'ramp: 0 kW fills nothing');
    ok(rec.n > 0 && rec.maxX <= 116 && rec.minX >= 60 && rec.cols.filter((c) => isCol(c, P.low)).length >= 20, 'ramp: -20 kW fills half way down the climb, green (x ' + rec.minX + '..' + rec.maxX + ')');
    ok(pwr.n > 0 && pwr.minX >= 90 && pwr.maxX > 220 && pwr.maxX < 250 && mostly(pwr.cols.filter((c) => c[3] > 200), '#f4f1e6'), 'ramp: +40 kW fills half way along the flat (x ' + pwr.minX + '..' + pwr.maxX + ')');
    // (a 4 px strip: judged on its solid pixels, the edges are half blended)
    ok(full.maxX >= 370 && mostly(full.cols.filter((c) => c[3] > 200), '#ffd84a'), 'ramp: +80 kW fills the flat to the end, yellow');
    ok(fill(-100).minX >= 40 && fill(200).maxX <= 375, 'ramp: beyond lo / hi stays inside the track');
    ok(diff(layer(frame('ramp', [BO, pw(0), OIL]), 'bg'), layer(frame('ramp', [BO, OIL]), 'bg'), 0, 129).n > 0, 'ramp: the track and zero tick on the static layer');
}

console.log(tally.checks + ' checks, ' + tally.fails + ' failed');
process.exit(tally.fails ? 1 : 0);
