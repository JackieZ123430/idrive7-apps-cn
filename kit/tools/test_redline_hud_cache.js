'use strict';
// Redline HUD: drawHud's shortcuts draw the same pixels as drawing everything (drawLayer 'bg' then 'fg', no caches):
// the static layer copied in, the lit rev bar copied from one drawn lit once, the Arc's band likewise. Every layout,
// every 37 rpm from 0 to past the end, limiter flashing on and off, the shake. Node 8 compatible.
//   node kit/tools/test_redline_hud_cache.js
const path = require('path');
const TH = require('./redline_test_harness');
TH.hookKit();
const Draw = require(path.join(TH.ROOT, 'apps', 'redline', 'hud-draw'));
const { Canvas } = require(path.join(TH.ROOT, 'kit', 'runtime', 'canvas'));
const tally = TH.counter(), ok = tally.ok;

const RO = [{ label: 'BOOST', value: '1.2', tone: 'text' }, { label: 'OIL', value: '95°', tone: 'text' }];
const frame = (style, rpm, o) => ({
    d: { rpm: rpm, gear: 3, stage: 'D', oil: 95, coolant: 90 }, shift: 5550, redline: 6550, max: 8000, blink: o.blink, down: 0, peak: o.peak || 0, chip: null,
    cue: { from: 4400, at: 5550, shift: rpm >= 5550, limiter: rpm >= 6510 }, readouts: RO, mode: null, shake: null,
    opts: { style: style, palette: o.palette || 'colour', gear: true, rpm: true, bar: true, lights: o.lights !== false, gt3: true, dim: !!o.dim,
        lightStyle: o.lightStyle || 'm', clearLabels: false, gearFont: 'ubuntu', chip: 'burst' },
});
const plain = (f) => { const c = new Canvas(Draw.IW, Draw.IH); Draw.drawLayer(c, f, 'bg'); Draw.drawLayer(c, f, 'fg'); return c; };
const same = (a, b) => Buffer.from(a.d).equals(Buffer.from(b.d));

const cv = new Canvas(Draw.IW, Draw.IH);
['standard', 'vector', 'wings', 'minimal', 'digital', 'vfd', 'arc', 'ramp', 'dial', 'pill'].forEach((st) => {
    [{ blink: true }, { blink: false, dim: true, lights: false }, { blink: true, palette: 'amber', lightStyle: 'f1', peak: 7000 }].forEach((o, k) => {
        let bad = [];
        for (let rpm = 0; rpm <= 8100; rpm += 37) {
            const f = frame(st, rpm, o);
            Draw.drawHud(cv, f);
            if (!same(cv, plain(f))) bad.push(rpm);
        }
        ok(bad.length === 0, st + ' #' + k + ': drawHud the same as drawing everything, 0..8100 rpm' + (bad.length ? ' (differs at ' + bad.slice(0, 5).join(', ') + ' rpm)' : ''));
    });
});
// the shake moves the whole frame: the same as the unshaken one moved (the edge it uncovers transparent)
{
    const f = frame('standard', 6600, { blink: true }), a = new Canvas(Draw.IW, Draw.IH), b = new Canvas(Draw.IW, Draw.IH);
    Draw.drawHud(a, f); Draw.drawHud(b, Object.assign({}, f, { shake: [2, -1] }));
    let okAll = true;
    for (let y = 0; y < Draw.IH; y++) for (let x = 0; x < Draw.IW; x++) {
        const sx = x - 2, sy = y + 1, i = (y * Draw.IW + x) * 4;
        const want = sx < 0 || sy >= Draw.IH ? [0, 0, 0, 0] : Array.prototype.slice.call(a.d, (sy * Draw.IW + sx) * 4, (sy * Draw.IW + sx) * 4 + 4);
        if (b.d[i] !== want[0] || b.d[i + 1] !== want[1] || b.d[i + 2] !== want[2] || b.d[i + 3] !== want[3]) okAll = false;
    }
    ok(okAll, 'shake [2, -1]: the frame moved 2 right and 1 up, the uncovered edge transparent');
}
console.log('redline HUD caches: ' + tally.checks + ' checks, ' + tally.fails + ' failed');
process.exit(tally.fails ? 1 : 0);
