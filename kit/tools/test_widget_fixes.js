'use strict';

// The picture canvas of the home-screen widgets, the engine speed a stopped engine leaves, and the
// settings eDrive offers per hybrid system.
//   node kit/tools/test_widget_fixes.js

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const { Canvas, ScaledCanvas } = require(path.join(KIT, 'canvas'));
const Car = require(path.join(KIT, 'car'));

/* ---------- ScaledCanvas: the coordinates of w x h on k times the pixels ---------- */
{
    const cv = new ScaledCanvas(384, 256, 2).clear([0, 0, 0, 0]);
    assert.strictEqual(cv.canvas.w, 768);
    assert.strictEqual(cv.canvas.h, 512);
    assert.strictEqual(cv.w, 384);
    cv.fillRect(10, 20, 30, 40, [255, 0, 0, 255]);
    const at = (x, y) => cv.canvas.d[(y * 768 + x) * 4];
    assert.strictEqual(at(20, 40), 255, 'first pixel of the rect, at twice its place');
    assert.strictEqual(at(79, 119), 255, 'last pixel');
    assert.strictEqual(at(80, 120), 0, 'past it');
    const plain = new Canvas(384, 256).text('Hybrid 123', 0, 40, 20, '#fff', { font: 'bold', spacing: 1 });
    const scaled = cv.text('Hybrid 123', 0, 40, 20, '#fff', { font: 'bold', spacing: 1 });
    assert.ok(Math.abs(scaled - plain) < 2, `a text measures the same in w x h: ${scaled} and ${plain}`);
    assert.ok(Math.abs(cv.textWidth('Hybrid 123', 20) - new Canvas(384, 256).textWidth('Hybrid 123', 20)) < 2);
    ['clear', 'fillRect', 'gradientRect', 'roundRect', 'strokeRoundRect', 'card', 'rampRect', 'circle', 'arc', 'line',
        'convex', 'quad', 'triangle', 'polyline', 'fillUnder', 'drawImage', 'blit', 'text', 'textWidth', '_blit'
    ].forEach((m) => {
        assert.strictEqual(typeof Canvas.prototype[m], 'function', 'a canvas method ' + m);
        assert.strictEqual(typeof ScaledCanvas.prototype[m], 'function', 'scaled too: ' + m);
    });
}

/* ---------- engine speed: a stopped hybrid engine's last value reads as 0 ---------- */
{
    let handlers = null;
    const ctx = {
        log: { info() {}, warn() {}, error() {}, debug() {} }, spec: {}, settings: { get: () => 'off', onChange() {} },
        signals: { watch: async (iface, inst, fields) => { handlers = fields; return { error: null }; } }
    };
    const car = new Car(ctx, ['rpm']);
    const feed = (rpm) => { handlers.statusEngineSpeed2({ actualValueRPMEngineCrankshaft: rpm * 4 }); return car.live.rpm; };
    assert.strictEqual(feed(160), 0, '160 rpm with the engine off');
    assert.strictEqual(feed(399), 0);
    assert.strictEqual(feed(400), 400, 'the lowest that counts as running');
    assert.strictEqual(feed(750), 750, 'idle');
    assert.strictEqual(feed(6500), 6500);
    assert.strictEqual(feed(0), 0);
    if (car.stop) car.stop();
}

/* ---------- eDrive's settings per hybrid system ---------- */
{
    const spec = require(path.join(ROOT, 'apps', 'edrive', 'app.json'));
    const PHEV_ONLY = ['range20', 'reserve', 'designKwh', 'price'];
    const offered = (hybrid) => {
        const values = {};
        spec.settings.forEach((s) => { values[s.key] = s.default; });
        values.hybrid = hybrid;
        // the rule of mgu.js Settings.shown
        return spec.settings.filter((s) => !s.hidden && (!s.when || Object.keys(s.when).every((k) => [].concat(s.when[k]).indexOf(values[k]) >= 0))).map((s) => s.key);
    };
    ['yes', 'auto'].forEach((h) => PHEV_ONLY.forEach((k) => assert.ok(offered(h).includes(k), `${k} with hybrid ${h}`)));
    ['48v', 'no'].forEach((h) => {
        PHEV_ONLY.forEach((k) => assert.ok(!offered(h).includes(k), `no ${k} with hybrid ${h}`));
        ['hybrid', 'distUnit', 'tempUnit', 'gaugeKw', 'theme'].forEach((k) => assert.ok(offered(h).includes(k), `${k} stays with hybrid ${h}`));
    });
}

/* ---------- the widgets ask for twice the pixels, the size their layouts are drawn in stays ---------- */
['edrive', 'live_data'].forEach((id) => {
    const sw = require(path.join(ROOT, 'apps', id, 'app.json')).startWidget;
    assert.deepStrictEqual(sw.size, [384, 256], id);
    assert.strictEqual(sw.scale, 2, id);
});

console.log('Widget picture, stopped engine and eDrive settings checks passed.');
process.exit(0);    // the Car's demo timer would keep this running
