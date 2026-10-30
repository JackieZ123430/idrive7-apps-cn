'use strict';
/**
 * preview.js - run a built app on the PC with a stubbed head unit and save
 * what it draws as PNGs (no VM needed for visual work).
 *
 *   node kit/tools/preview.js dist/car_vitals [outDir] [clicks...] [--set key=value ...] [--gpu FILE]
 *
 * clicks = component names to "press" between frames, e.g. BTN_PAGE BTN_PAGE;
 * also wait=<seconds>, render (draw a frame now) and frames=<n> (n frames at 60 a second, in
 * real time, so demo data and animations move as on the car: with --gpu and mgu-renderd --raw
 * that is a 60 fps video).
 * Demo data is forced on. Each image the app pushes is written as
 * <outDir>/<component>-<n>.png.
 * --gpu FILE: also write what the GPU renderer would get (full-screen layout: header, slim bar) to FILE;
 * render it with  mgu-renderd --replay FILE --out frame.pam  (last frame).
 */
const fs = require('fs');
const path = require('path');
const { headUnit } = require('./hu-stub');

const stage = path.resolve(process.argv[2] || 'dist/car_vitals');
const args = process.argv.slice(3);
const out = path.resolve(args[0] && !args[0].startsWith('BTN') && !args[0].startsWith('--') && !/^(wait=|render$)/.test(args[0]) ? args.shift() : 'preview');
const sets = {};
const clicks = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--gpu') process.env.MGU_RENDERD_FILE = path.resolve(args[++i]);
    else if (args[i] === '--set') { const [k, v] = args[++i].split('='); sets[k] = isNaN(Number(v)) ? (v === 'true' ? true : v === 'false' ? false : v) : Number(v); }
    else clicks.push(args[i]);
}
fs.mkdirSync(out, { recursive: true });

let frame = 0;
const hu = headUnit(stage, {
    dataDir: out, fresh: true, sets,
    image: async (name, cv) => {
        const f = path.join(out, `${name.toLowerCase()}-${frame++}.png`);
        fs.writeFileSync(f, Buffer.isBuffer(cv) ? cv : cv.png());
        console.log('frame', f);
    },
});
const { handlers, loopFn, WIDGETS } = hu;
const renderWidgets = async () => {
    if (!hu.widgetFn) return;
    for (const i of WIDGETS) {
        const cv = await hu.widgetFn(i);
        if (cv) { const f = path.join(out, `widget_${i.big ? 'big' : 'small'}-${frame++}.png`); fs.writeFileSync(f, cv.png()); console.log('frame', f); }
    }
};
hu.start();

setTimeout(async () => {
    for (const c of clicks) {
        // wait=<seconds> pauses (demo data keeps running); render forces a frame
        if (/^wait=/.test(c)) { await new Promise((r) => setTimeout(r, Number(c.slice(5)) * 1000)); continue; }
        if (c === 'render') { await loopFn(); await renderWidgets(); continue; }
        if (/^frames=/.test(c)) {
            const n = Number(c.slice(7)), t0 = Date.now();
            for (let i = 0; i < n; i++) {
                await loopFn();
                await new Promise((r) => setTimeout(r, Math.max(0, t0 + (i + 1) * 1000 / 60 - Date.now())));
            }
            continue;
        }
        if (!handlers[c]) { console.warn('no handler', c); continue; }
        await handlers[c]({ row: 0 });
        await new Promise((r) => setTimeout(r, 300));
    }
    setTimeout(() => process.exit(0), 500);
}, 1500);
