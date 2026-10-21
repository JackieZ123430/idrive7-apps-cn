'use strict';
/**
 * preview.js - run a built app on the PC with a stubbed head unit and save
 * what it draws as PNGs (no VM needed for visual work).
 *
 *   node kit/tools/preview.js dist/car_vitals [outDir] [clicks...] [--set key=value ...]
 *
 * clicks = component names to "press" between frames, e.g. BTN_PAGE BTN_PAGE;
 * also wait=<seconds> and render (draw a frame now).
 * Demo data is forced on. Each image the app pushes is written as
 * <outDir>/<component>-<n>.png.
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const stage = path.resolve(process.argv[2] || 'dist/car_vitals');
const args = process.argv.slice(3);
const out = path.resolve(args[0] && !args[0].startsWith('BTN') && !args[0].startsWith('--') && !/^(wait=|render$)/.test(args[0]) ? args.shift() : 'preview');
const sets = {};
const clicks = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--set') { const [k, v] = args[++i].split('='); sets[k] = isNaN(Number(v)) ? (v === 'true' ? true : v === 'false' ? false : v) : Number(v); }
    else clicks.push(args[i]);
}
fs.mkdirSync(out, { recursive: true });

const kitDir = path.join(stage, 'source', 'javascript', 'kit');
const spec = JSON.parse(fs.readFileSync(path.join(kitDir, 'app-spec.json'), 'utf8'));
const { Settings } = (() => {
    // reuse the real Settings class without loading the SDK
    const src = fs.readFileSync(path.join(kitDir, 'mgu.js'), 'utf8');
    const m = src.match(/class Settings[\s\S]*?\n}\n/);
    const fn = new Function('fs', 'path', 'DATA_DIR', 'log', m[0] + '\nreturn { Settings };');
    return fn(fs, path, out, console);
})();

const handlers = {};
let loopFn = null;
let frame = 0;
const settings = new Settings(spec.settings);
try { fs.unlinkSync(settings.file); } catch (e) {}
settings.values = {};
for (const s of spec.settings || []) settings.values[s.key] = s.default;
Object.assign(settings.values, { demo: 'on' }, sets);

const ui = {
    image: async (name, cv) => {
        const f = path.join(out, `${name.toLowerCase()}-${frame++}.png`);
        fs.writeFileSync(f, Buffer.isBuffer(cv) ? cv : cv.png());
        console.log('frame', f);
    },
    text: async (n, t) => console.log('text', n, JSON.stringify(t)),
    cells: async (n, r, o) => console.log('cells', n, r, JSON.stringify(o)),
    rows: async (n, c) => console.log('rows', n, c),
    visible: async () => {}, enabled: async () => {}, checked: async () => {},
    onClick: (n, fn) => { handlers[n] = fn; },
    open: async (n) => console.log('open', n), close: async () => {},
    isVisible: () => false, onVisible: () => {}, comp: () => ({}),
};
const ctx = {
    ui, settings, spec, dataDir: out,
    log: { info: console.log, warn: console.warn, error: console.error, debug: () => {} },
    signals: { watch: async (iface) => ({ iface, error: 'preview' }), proxy: async () => { throw new Error('preview'); } },
    theme: () => require(path.join(kitDir, 'themes')).theme(settings.get('theme')),
    loop: (n, fps, fn) => { loopFn = fn; return { stop() {}, kick() {} }; },
};

const realLoad = Module._load;
Module._load = function (req, parent) {
    if (/kit[\\/]mgu$/.test(req) || req === './kit/mgu') {
        return { run: async (impl) => impl.start(ctx), log: ctx.log, SPEC: spec };
    }
    return realLoad.apply(this, arguments);
};
require(path.join(stage, 'source', 'javascript', 'app.js'));

setTimeout(async () => {
    for (const c of clicks) {
        // wait=<seconds> pauses (demo data keeps running); render forces a frame
        if (/^wait=/.test(c)) { await new Promise((r) => setTimeout(r, Number(c.slice(5)) * 1000)); continue; }
        if (c === 'render') { if (loopFn) await loopFn(); continue; }
        if (!handlers[c]) { console.warn('no handler', c); continue; }
        await handlers[c]({ row: 0 });
        await new Promise((r) => setTimeout(r, 300));
    }
    setTimeout(() => process.exit(0), 500);
}, 1500);
