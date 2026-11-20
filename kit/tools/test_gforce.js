'use strict';

// G-Force: a fresh record, then the shutdown as kit mgu.js does it (process.exit(0) 200 ms after MainApp
// asks): the record is in the file (it waits 5 s to be written otherwise). No SDK, vehicle or capture needed:
//   node kit/tools/test_gforce.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..', '..');

if (process.argv[2] !== 'child') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gforce-'));
    process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));   // (process.exit skips finally)
    const r = cp.spawnSync(process.execPath, [__filename, 'child', dir], { encoding: 'utf8' });
    if (r.status !== 0) { console.log('FAIL the app: exit ' + r.status + '\n' + r.stderr); process.exit(1); }
    const f = path.join(dir, 'gforce_records.json');
    const rec = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
    if (!rec || !rec.brk || !(rec.brk.v > 0.8)) { console.log('FAIL a record set just before shutdown was lost: ' + JSON.stringify(rec)); process.exit(1); }
    console.log('G-Force checks passed (a record set just before shutdown is saved).');
    return;
}

// the child: the app with the kit stubbed where it needs the head unit
const kit = path.join(ROOT, 'kit/runtime');
let app = null, sample = null;
class FakeCar { onSample(fn) { sample = fn; } data() { return { demo: false }; } }
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req === './kit/mgu') return { run: (a) => { app = a; } };
    if (req === './kit/car') return FakeCar;
    if (req.startsWith('./kit/')) return load.call(this, path.join(kit, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
require(path.join(ROOT, 'apps/gforce/main'));
const { Recorder } = require(path.join(kit, 'record'));
const themes = require(path.join(kit, 'themes'));
const vals = { scale: 1.5, trail: 4, flipLat: false, speedUnit: 'kmh', theme: 'm_tricolour', gRate: 10, demo: 'off' };
app.start({
    ui: { image: async () => {}, text() {}, onClick() {} }, settings: { get: (k) => vals[k], onChange() {} },
    log: { info() {}, warn() {}, error() {} }, spec: {}, dataDir: process.argv[3],
    theme: () => themes.theme(vals.theme), canvas: (w, h) => new Recorder(w, h),
    onTab() {}, hideButton() {}, loop() {},
}).then(() => {
    sample({ gLong: -0.9, gLat: 0.2, speed: 80, rpm: 3000, demo: false }, Date.now());   // a hard stop: a record
    setTimeout(() => process.exit(0), 200);                                              // MainApp's shutdown
});
