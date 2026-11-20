'use strict';

// Redline HUD: the Recovery / Power meter on the M layouts arc and dial (a readout with .bar = { v, lo, hi }, kW).
//   node kit/tools/test_redline_meter_m.js
// - a ring segment concentric with the layout's own band (arc: inside the rpm band, dial: round the dial), the zero
//   where lo..hi maps 0; recovery anticlockwise from it in the palette's low colour, power clockwise in the layout's
//   fill colour (warm from 85 % of hi); held at the ends beyond lo / hi; 0 fills nothing;
// - outline and zero tick on bg (the same whatever v), the fill on fg;
// - the item is not in the readouts list; a clear gap (2 px or more) to everything else, the shift grade included.

const path = require('path');
const TH = require('./redline_test_harness');
const ROOT = TH.ROOT;
TH.hookKit();
const Draw = require(path.join(ROOT, 'apps', 'redline', 'hud-draw'));
const { Canvas, rgba } = require(path.join(ROOT, 'kit', 'runtime', 'canvas'));

const tally = TH.counter(), ok = tally.ok;
const P = Draw.PALETTES.colour;

const pw = (v) => ({ label: 'POWER', value: '+12', tone: 'text', bar: { v: v, lo: -40, hi: 80 }, wide: true });
const OIL = { label: 'OIL', value: '95°', tone: 'text' }, WAT = { label: 'WATER', value: '90°', tone: 'text' };
const BO = { label: 'BOOST', value: '1.2', tone: 'text' }, GB = { label: 'GEARBOX', value: '80°', tone: 'text' };
const opts = (style, over) => Object.assign({ style: style, palette: 'colour', gear: true, rpm: true, bar: true, lights: true, gt3: true, dim: true,
    lightStyle: 'm', clearLabels: false, gearFont: 'ubuntu' }, over || {});
const frame = (style, readouts, over, fo) => Object.assign({
    d: { rpm: 4200, gear: 3, stage: 'D' }, shift: 5550, redline: 6550, max: 8000, blink: true, down: 0, peak: 0, chip: null,
    cue: { from: 4400, at: 5550, shift: false, limiter: false }, readouts: readouts, mode: 'M', opts: opts(style, over),
}, fo || {});
function layer(f, l) { const cv = new Canvas(Draw.IW, Draw.IH); Draw.drawLayer(cv, f, l); return cv; }
const same = (a, b) => Buffer.from(a.d).equals(Buffer.from(b.d));
const lit = (cv, x, y, th) => cv.d[(y * cv.w + x) * 4 + 3] > (th || 0);
/** The pixels that differ between a and b: list of { x, y, c }. */
function diff(a, b) {
    const r = [];
    for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
        const i = (y * a.w + x) * 4;
        if (a.d[i] !== b.d[i] || a.d[i + 1] !== b.d[i + 1] || a.d[i + 2] !== b.d[i + 2] || a.d[i + 3] !== b.d[i + 3]) r.push({ x: x, y: y, c: [a.d[i], a.d[i + 1], a.d[i + 2], a.d[i + 3]] });
    }
    return r;
}
const isCol = (c, col) => { const v = rgba(col); return c[3] === 255 && Math.abs(c[0] - v[0]) <= 2 && Math.abs(c[1] - v[1]) <= 2 && Math.abs(c[2] - v[2]) <= 2; };
const mostly = (px, col) => px.length > 0 && px.filter((p) => isCol(p.c, col)).length >= px.length * 0.6;

// the layouts' meters: centre, radii, sweep; colours of power / near hi
const G = {
    arc: { cx: 200, cy: 372, r0: 314, r1: 320, a0: -25, a1: 25, fill: '#bcd6e8', warm: '#f2a81d' },
    dial: { cx: 200, cy: 70, r0: 64, r1: 70, a0: -125, a1: 110, fill: '#ff8a2e', warm: '#f0313a' },
};
const angOf = (g, p) => Math.atan2(p.x + 0.5 - g.cx, -(p.y + 0.5 - g.cy)) * 180 / Math.PI;
const radOf = (g, p) => Math.hypot(p.x + 0.5 - g.cx, p.y + 0.5 - g.cy);
const span = (g, px) => { const a = px.map((p) => angOf(g, p)); return [Math.min.apply(null, a), Math.max.apply(null, a)]; };
// the meter alone: nothing else drawn
const alone = (st, v, l) => layer(frame(st, [pw(v)], { gear: false, bar: false, lights: false }, { mode: null }), l || 'both');

['arc', 'dial'].forEach((st) => {
    const g = G[st], az = g.a0 + (g.a1 - g.a0) / 3, zero = alone(st, 0);
    // 0: nothing filled (as no reading); the fg layer then empty
    ok(same(zero, alone(st, NaN)), st + ': 0 kW fills nothing (the same as no reading)');
    ok(diff(alone(st, 0, 'fg'), new Canvas(Draw.IW, Draw.IH)).length === 0, st + ': 0 kW: nothing on the fg layer');
    // recovery: anticlockwise from the zero, green, half way to lo at -20
    const rec = diff(alone(st, -20), zero), ra = span(g, rec);
    ok(rec.length > 0 && ra[1] <= az + 0.5 && mostly(rec, P.low), st + ': -20 kW fills anticlockwise of the zero in low (' + ra[0].toFixed(1) + '..' + ra[1].toFixed(1) + '°, zero ' + az.toFixed(1) + '°)');
    ok(Math.abs(ra[0] - (az + g.a0) / 2) <= 1, st + ': -20 kW reaches half way to lo (' + ra[0].toFixed(1) + '°, expected ' + ((az + g.a0) / 2).toFixed(1) + '°)');
    // power: clockwise, the fill colour, half way to hi at +40
    const drv = diff(alone(st, 40), zero), da = span(g, drv);
    ok(drv.length > 0 && da[0] >= az - 0.5 && mostly(drv, g.fill), st + ': +40 kW fills clockwise of the zero in ' + g.fill + ' (' + da[0].toFixed(1) + '..' + da[1].toFixed(1) + '°)');
    ok(Math.abs(da[1] - (az + g.a1) / 2) <= 1, st + ': +40 kW reaches half way to hi (' + da[1].toFixed(1) + '°, expected ' + ((az + g.a1) / 2).toFixed(1) + '°)');
    ok(mostly(diff(alone(st, 76), zero), g.warm) && mostly(diff(alone(st, 60), zero), g.fill), st + ': warm from 85 % of hi (76 kW), not at 60');
    // the fill follows the curve: within the ring's radii
    const rr = rec.concat(drv).map((p) => radOf(g, p));
    ok(Math.min.apply(null, rr) >= g.r0 - 1 && Math.max.apply(null, rr) <= g.r1 + 1, st + ': the fill stays on the ring (r ' + Math.min.apply(null, rr).toFixed(1) + '..' + Math.max.apply(null, rr).toFixed(1) + ')');
    // clamping
    ok(same(alone(st, -100), alone(st, -40)) && same(alone(st, 500), alone(st, 80)), st + ': beyond lo / hi draws as lo / hi');
    const ends = span(g, diff(alone(st, -40), zero).concat(diff(alone(st, 80), zero)));
    ok(ends[0] >= g.a0 - 0.5 && ends[1] <= g.a1 + 0.5 && ends[0] < g.a0 + 1.5 && ends[1] > g.a1 - 1.5, st + ': lo / hi fill to the ends of the sweep (' + ends[0].toFixed(1) + '..' + ends[1].toFixed(1) + '°)');
    // layers
    const bg = alone(st, -20, 'bg');
    ok(same(bg, alone(st, 65, 'bg')) && same(bg, alone(st, 0, 'bg')), st + ': the bg layer is the same whatever v');
    const tick = (cv) => { for (let r = g.r1 + 0.5; r <= g.r1 + 2; r += 0.5) { const x = Math.round(g.cx + r * Math.sin(az * Math.PI / 180) - 0.5), y = Math.round(g.cy - r * Math.cos(az * Math.PI / 180) - 0.5); if (lit(cv, x, y, 100)) return true; } return false; };
    ok(tick(bg) && !tick(alone(st, -20, 'fg')), st + ': the zero tick (past the ring) is on bg, not fg');
    ok(diff(bg, new Canvas(Draw.IW, Draw.IH)).filter((p) => Math.abs(angOf(g, p) - g.a1) < 3).length > 0, st + ': the track outline on bg, to the sweep\'s end');
    ok(same(layer(frame(st, [OIL, pw(-20)]), 'bg'), layer(frame(st, [OIL, pw(50)]), 'bg')), st + ': in the HUD, the bg layer the same whatever v');
    // not in the list: the other readouts draw where they would without it (the meter's ring aside)
    [[OIL, WAT], [BO, OIL, WAT]].forEach((ro) => {
        const withM = layer(frame(st, ro.concat([pw(-20)])), 'both'), without = layer(frame(st, ro), 'both');
        const off = diff(withM, without).filter((p) => { const r = radOf(g, p); return r < g.r0 - 4 || r > g.r1 + 4; });
        ok(off.length === 0, st + ': ' + ro.length + ' readouts + meter: the readouts as without it (' + off.length + ' px off the ring differ)');
        const first = layer(frame(st, [pw(-20)].concat(ro)), 'both');
        ok(same(first, withM), st + ': the meter first in the list takes no slot');
    });
    // gaps: the meter's pixels against everything else, with 4 readouts, a peak and the shift grade
    [['4 readouts', [BO, OIL, WAT, GB], {}], ['peak', [BO, OIL, WAT, GB], { peak: 6000 }],
        ['shift grade', [BO, OIL, WAT, GB], { chip: { text: 'GOOD', verdict: 'GOOD', age: 600 } }],
        ['grade LATE, low rpm', [BO, OIL, WAT, GB], { chip: { text: 'LATE', verdict: 'LATE', age: 600 }, d: { rpm: 900, gear: 1 } }],
        ['limiter', [BO, OIL, WAT, GB], { d: { rpm: 6700, gear: 'N' }, cue: { from: 4400, at: 5550, shift: true, limiter: true }, down: 2 }]].forEach((c) => {
        [-40, 80].forEach((v) => {
            const ro = c[1].concat([pw(v)]), full = layer(frame(st, ro, {}, c[2]), 'both'), m = alone(st, v);
            const mp = [], rest = [];
            for (let y = 0; y < full.h; y++) for (let x = 0; x < full.w; x++) {
                const i = (y * full.w + x) * 4, inM = m.d[i + 3] > 40;
                if (inM) mp.push([x, y]);
                else if (full.d[i + 3] > 40) rest.push([x, y]);
            }
            let best = 1e9, near = null;
            rest.forEach((q) => mp.forEach((p) => { const dd = Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1])); if (dd < best) { best = dd; near = [p, q]; } }));
            ok(best >= 3, st + ' ' + c[0] + ' ' + v + ' kW: a gap of 2 px or more round the meter (nearest ' + (best - 1) + ' px clear, ' + JSON.stringify(near) + ')');
        });
    });
});

// arc: with the meter over it, the stacked 4th readout sits 4 px lower; without the meter where it was
{
    const top = (cv) => { for (let y = 60; y < cv.h; y++) for (let x = 100; x < 165; x++) if (lit(cv, x, y, 128)) return y; return -1; };
    const ro = [BO, OIL, WAT, GB];
    const a = layer(frame('arc', ro.concat([pw(0)]), { bar: false, lights: false }), 'fg'), b = layer(frame('arc', ro, { bar: false, lights: false }), 'fg');
    const t = top(layer(frame('arc', ro, { bar: false, lights: false, gear: false }), 'fg'));
    ok(t > 0 && top(layer(frame('arc', ro.concat([pw(0)]), { bar: false, lights: false, gear: false }), 'fg')) - t >= 4, 'arc: the stacked readout 4 px lower with the meter');
    ok(!same(a, b), 'arc: the meter shows with the band off');
}
// dial: the peak stops short of the meter's ring with it on, reaches past the band without
{
    const pk = (ro) => layer(frame('dial', ro, { lights: false }, { peak: 7000, d: { rpm: 3000, gear: 3 } }), 'fg');
    const a = 0 - 125 + 235 * 7000 / 8000, at = (r) => [Math.round(200 + r * Math.sin(a * Math.PI / 180) - 0.5), Math.round(70 - r * Math.cos(a * Math.PI / 180) - 0.5)];
    const p62 = at(62);
    ok(lit(pk([OIL]), p62[0], p62[1], 100) && !lit(pk([OIL, pw(0)]), p62[0], p62[1], 100), 'dial: the peak mark ends short of the meter');
}

console.log(tally.checks + ' checks, ' + tally.fails + ' failed');
process.exit(tally.fails ? 1 : 0);
