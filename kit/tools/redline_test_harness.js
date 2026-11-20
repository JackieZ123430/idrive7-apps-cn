'use strict';
// What Redline's tests share (not a test itself: the workflows run kit/tools/test_*.js). Node 8 compatible: the
// node8-runtime CI job runs the tests on the head unit's Node 8.16.2.
// - counter(): ok(cond, msg) counting checks and failures, printing FAIL lines;
// - sleep(ms);
// - hookKit(opts): the app requires the kit as './kit/...' (where the build puts it), mapped to kit/runtime, and
//   './cluster_render_client' to opts.clusterRender when given;
// - fakeClusterRender(opts): a stand-in cluster-render, ready at once, recording layers, pixels, effects and status asks;
// - claimsDir(prefix): a temp folder with the HUD claims folder in it (MGU_HUD_CLAIMS), rmTree(p) to remove a folder;
// - redlineDefaults(): Redline's app.json and its settings' defaults.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ROOT = path.join(__dirname, '..', '..');

function counter() {
    const c = { checks: 0, fails: 0 };
    c.ok = (cond, msg) => { c.checks++; if (!cond) { c.fails++; console.log('FAIL ' + msg); } };
    return c;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function hookKit(opts) {
    const fake = opts && opts.clusterRender;
    const load = Module._load;
    Module._load = function (req, parent, isMain) {
        if (req.startsWith('./kit/')) return load.call(this, path.join(ROOT, 'kit', 'runtime', req.slice(6)), parent, isMain);
        if (fake && req === './cluster_render_client') return { ClusterRender: fake };
        return load.call(this, req, parent, isMain);
    };
}

/**
 * A stand-in cluster-render class. Options (each test's old fake differed here):
 * - onCreate(cr): called with each new instance;
 * - set: 'ignore' (default) or 'merge' (set(ref, o) merged into the layer's options);
 * - pixels: what pixels() answers, true (default: accepted) or undefined (the HUD then keeps sending whole pictures);
 * - status: false for no status() at all (the HUD then never asks for the slot report).
 * An instance has layers {ref: {kind, ...options}}, frames [{ref, rects, px}], h {event: handler}, effects (count),
 * asked (status() calls), of(kind) / images() (the refs of the layers of a kind).
 */
function fakeClusterRender(opts) {
    opts = opts || {};
    const pixelsAnswer = 'pixels' in opts ? opts.pixels : true;
    class FakeCr {
        constructor() {
            this.ready = true; this.backend = 'test'; this.targets = 'hud'; this.n = 0; this.layers = {}; this.frames = []; this.h = {};
            this.effects = 0; this.asked = 0;
            if (opts.status === false) this.status = undefined;
            if (opts.onCreate) opts.onCreate(this);
        }
        on(ev, fn) { this.h[ev] = fn; }
        connect() {} close() {} removeAllListeners() {} send() {}
        set(ref, o) { if (opts.set === 'merge' && this.layers[ref]) Object.assign(this.layers[ref], o); }
        _add(kind, o) { this.n++; this.layers[this.n] = Object.assign({ kind: kind }, o); return this.n; }
        image(o) { return this._add('image', o); }
        effect(o) { this.effects++; return this._add('effect', o); }
        uniform() {}
        pixels(ref, rects, px) { this.frames.push({ ref: ref, rects: rects, px: Buffer.from(px) }); return pixelsAnswer; }
        drop(r) { delete this.layers[r]; }
        status() { this.asked++; }
        of(kind) { return Object.keys(this.layers).map(Number).filter((r) => this.layers[r].kind === kind); }
        images() { return this.of('image'); }
    }
    return FakeCr;
}

/** A temp folder (prefix) and the HUD claims folder in it, set as MGU_HUD_CLAIMS (made by the test). */
function claimsDir(prefix) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const shm = process.env.MGU_HUD_CLAIMS = path.join(tmp, 'shm');
    return { TMP: tmp, SHM: shm };
}

/** Removes a file or folder and what's in it; nothing there is fine. (fs.rmSync is Node 14.14+.) */
function rmTree(p) {
    let st;
    try { st = fs.lstatSync(p); } catch (e) { return; }
    if (!st.isDirectory()) return fs.unlinkSync(p);
    fs.readdirSync(p).forEach((f) => rmTree(path.join(p, f)));
    fs.rmdirSync(p);
}

function redlineDefaults() {
    const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'redline', 'app.json'), 'utf8'));
    const def = {};
    spec.settings.forEach((s) => { if (s.key) def[s.key] = s.default; });
    return { spec: spec, def: def };
}

module.exports = { ROOT, counter, sleep, hookKit, fakeClusterRender, claimsDir, rmTree, redlineDefaults };
