'use strict';

// Engine Config's Exhaust Flap tab (apps/live_adjustments) without an SDK, build or car:
//   auto.js     Drive mode, hold, the Close rpm guard and the no-rpm fail-safe against a fake controller;
//   controller  Open / Close / OEM against a fake DME through the real diagnostic link (diaglink.js, kit diag);
//   picture     the silencer layer (GPU ops) and its software pixels; the tab drawn in every state;
//   languages   the status line and the menus from the shared catalogues (kit/runtime/locales), glyphs in the atlas;
//   app.json    the existing settings kept (names, defaults, Disarmed), the new ones after the arm switch.
//   node kit/tools/test_live_adjustments_exhaust.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..');
const APP = path.join(ROOT, 'apps', 'live_adjustments');
const KIT = path.join(ROOT, 'kit', 'runtime');
const load = Module._load;
Module._load = function (req, parent, isMain) {                 // the app's ./kit/* is kit/runtime/* in the repo
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};

const { AutoFlap, flapFor, modeName } = require(path.join(APP, 'auto'));
const { Controller } = require(path.join(APP, 'controller'));
const IMG = require(path.join(APP, 'muffler_img'));
const UI = require(path.join(APP, 'ui'));
const G = require(path.join(KIT, 'gauges'));
const { theme } = require(path.join(KIT, 'themes'));
const { Canvas } = require(path.join(KIT, 'canvas'));
const { Recorder, OP, makeLayer, play } = require(path.join(KIT, 'record'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { info() {}, warn() {}, error() {} };
const results = [];
async function t(name, fn) {
    try { await fn(); results.push('PASS  ' + name); } catch (e) { results.push('FAIL  ' + name + ' :: ' + (e && e.message)); }
}

/* ------------------------------------------------------------------------------------------------ auto.js -- */

function auto(set, armed) {
    const sent = [], s = Object.assign({ driveLink: 'on', hold: 'on', closeLimit: '4000' }, set || {});
    const ctl = { armedSetting: armed !== false, async setMode(m) { sent.push(m); await sleep(5); return {}; } };
    const eng = { rpm: 900 };
    const a = new AutoFlap({ controller: ctl, get: (k) => s[k], set: (k, v) => { s[k] = v; }, rpm: () => eng.rpm, log: quiet, holdMs: 60 });
    return { a, sent, s, eng };
}

async function autoTests() {
    await t('mode map: names and numbers', async () => {
        assert.deepStrictEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0, 61].map(flapFor),
            ['OPEN', 'OPEN', 'OPEN', 'OEM', 'OEM', 'OEM', 'CLOSED', 'CLOSED', 'CLOSED', 'OEM', null, null]);
        assert.deepStrictEqual(['SPORT_DYNAMIC', 'SPORT_EXPERT', 'ECO_PRO_EFFICIENT', 'COMFORT'].map(flapFor), ['OPEN', 'OPEN', 'CLOSED', 'OEM']);
    });
    await t('mode map: the plug-in hybrids\' modes (issue #160)', async () => {
        assert.deepStrictEqual([15, 16, 23, 28, 17, 19, 18, 20, 21, 22].map(flapFor),
            ['OPEN', 'OPEN', 'OPEN', 'OPEN', 'OEM', 'OEM', 'CLOSED', 'CLOSED', 'CLOSED', null]);
        assert.deepStrictEqual(['PHEV_SPORT_STANDARD', 'PHEV_SPORT_PLUS', 'BOOST', 'PHEV_HYBRID_STANDARD', 'PHEV_HYBRID_COMFORT',
            'PHEV_HYBRID_ECO', 'PHEV_ELECTRIC_STANDARD', 'PHEV_ELECTRIC_INDIVIDUAL'].map(flapFor),
            ['OPEN', 'OPEN', 'OPEN', 'OEM', 'OEM', 'CLOSED', 'CLOSED', 'CLOSED']);
        assert.deepStrictEqual(['PHEV_HYBRID_STANDARD', 17, 'PHEV_ELECTRIC_STANDARD'].map(modeName), ['Hybrid', 'Hybrid', 'Electric']);
    });
    await t('PHEV: Sport -> Open, Hybrid -> OEM, Hybrid Eco -> Close (issue #160)', async () => {
        const x = auto({ hold: 'off' }); await x.a.driveMode('PHEV_SPORT_STANDARD'); await x.a.driveMode('PHEV_HYBRID_STANDARD');
        assert.strictEqual(x.a.note().text, 'Hybrid');
        await x.a.driveMode('PHEV_HYBRID_ECO');
        assert.deepStrictEqual(x.sent, ['OPEN', 'OEM', 'CLOSED']);
    });
    await t('Sport -> Open, Comfort -> OEM, Eco Pro -> Close', async () => {
        const x = auto({ hold: 'off' }); await x.a.driveMode(1); await x.a.driveMode(4); await x.a.driveMode(7);
        assert.deepStrictEqual(x.sent, ['OPEN', 'OEM', 'CLOSED']);
    });
    await t('same driving mode again sends nothing', async () => {
        const x = auto({ hold: 'off' }); await x.a.driveMode(1); await x.a.driveMode(1); assert.deepStrictEqual(x.sent, ['OPEN']);
    });
    await t('Drive mode off: the driving mode is ignored', async () => {
        const x = auto({ driveLink: 'off' }); await x.a.driveMode(1); await x.a.driveMode(7); assert.deepStrictEqual(x.sent, []);
    });
    await t('Open / Close / OEM: stop following the driving mode', async () => {
        const x = auto({ hold: 'off' }); await x.a.driveMode(1); await x.a.press('CLOSED');
        assert.strictEqual(x.s.driveLink, 'off'); assert.strictEqual(x.a.selected(), 'CLOSED');
        await x.a.driveMode(4); await x.a.driveMode(1); assert.deepStrictEqual(x.sent, ['OPEN', 'CLOSED']);
    });
    await t('Drive mode: follows the current and every next driving mode', async () => {
        const x = auto({ driveLink: 'off', hold: 'off' }); await x.a.driveMode(7); assert.deepStrictEqual(x.sent, []);
        await x.a.press('DRIVE'); assert.strictEqual(x.s.driveLink, 'on'); assert.strictEqual(x.a.selected(), 'DRIVE');
        await x.a.driveMode(1); await x.a.driveMode(4); assert.deepStrictEqual(x.sent, ['CLOSED', 'OPEN', 'OEM']);
    });
    await t('Drive mode before any driving mode arrived: OEM, then follows', async () => {
        const x = auto({ driveLink: 'off', hold: 'off' }); await x.a.press('DRIVE'); await x.a.driveMode(2);
        assert.deepStrictEqual(x.sent, ['OEM', 'OPEN']); assert.ok(/Sport\+/.test(x.a.note().text));
    });
    await t('the setting set by the button does not send twice', async () => {
        const x = auto({ driveLink: 'off', hold: 'off' }); await x.a.driveMode(1); await x.a.press('DRIVE'); await x.a.settingsChanged('driveLink');
        assert.deepStrictEqual(x.sent, ['OPEN']);
    });
    await t('Eco Pro from Drive mode: the rpm guard pauses Close too', async () => {
        const x = auto({ hold: 'off' }); await x.a.driveMode(8); x.eng.rpm = 4400; await x.a.tick(); assert.deepStrictEqual(x.sent, ['CLOSED', 'OEM']);
    });
    await t('OEM (pressed or Comfort): the rpm guard does nothing', async () => {
        const x = auto({ hold: 'off' }); await x.a.press('OEM'); x.eng.rpm = 6000; await x.a.tick(); assert.deepStrictEqual(x.sent, ['OEM']);
    });
    await t('Drive mode line: the driving mode name only', async () => {
        const x = auto({ driveLink: 'off', hold: 'off' }); await x.a.press('DRIVE'); assert.strictEqual(x.a.note().text, 'Waiting for the driving mode');
        const names = [];
        for (const m of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 'SPORT_DYNAMIC', 'ECO_PRO_EFFICIENT']) { await x.a.driveMode(m); names.push(x.a.note().text); }
        assert.deepStrictEqual(names, ['Sport', 'Sport+', 'Sport Individual', 'Comfort', 'Comfort+', 'Comfort Individual', 'Eco Pro', 'Eco Pro+',
            'Eco Pro Individual', 'Adaptive', 'Sport', 'Eco Pro']);
    });
    await t('"holding": not under Drive mode, shown for a held Open', async () => {
        const x = auto({ driveLink: 'off' }); await x.a.press('DRIVE'); await x.a.driveMode(1); assert.strictEqual(x.a.note().text, 'Sport');
        await x.a.press('OPEN'); assert.strictEqual(x.a.note().text, 'holding'); await x.a.press('OEM');
    });
    await t('hold: Open repeated, OEM stops it', async () => {
        const x = auto(); await x.a.driveMode(1); await sleep(220); const n = x.sent.length; assert.ok(n >= 3, 'repeats ' + n);
        await x.a.driveMode(4); const m = x.sent.length; await sleep(200); assert.strictEqual(x.sent.length, m); assert.strictEqual(x.sent[m - 1], 'OEM');
    });
    await t('Disarmed: no hold repeats', async () => {
        const x = auto({}, false); await x.a.press('OPEN'); await sleep(200); assert.deepStrictEqual(x.sent, ['OPEN']);
    });
    await t('rpm guard: Close paused above 4,000, resumed below 3,500', async () => {
        const x = auto({ hold: 'off' }); await x.a.driveMode(7); x.eng.rpm = 4300; await x.a.tick();
        assert.deepStrictEqual(x.sent, ['CLOSED', 'OEM']); assert.ok(x.a.note().warn);
        x.eng.rpm = 3800; await x.a.tick(); assert.strictEqual(x.sent.length, 2, 'no flapping inside the hysteresis');
        x.eng.rpm = 3400; await x.a.tick(); assert.deepStrictEqual(x.sent, ['CLOSED', 'OEM', 'CLOSED']);
    });
    await t('limit 3,000: paused at 3,200', async () => {
        const x = auto({ hold: 'off', closeLimit: '3000' }); await x.a.press('CLOSED'); x.eng.rpm = 3200; await x.a.tick();
        assert.deepStrictEqual(x.sent, ['CLOSED', 'OEM']);
    });
    await t('Close pressed above the limit: OEM sent, Close resumes when the rpm drops', async () => {
        const x = auto({ hold: 'off' }); x.eng.rpm = 4500; await x.a.press('CLOSED'); assert.deepStrictEqual(x.sent, ['OEM']);
        x.eng.rpm = 2000; await x.a.tick(); assert.deepStrictEqual(x.sent, ['OEM', 'CLOSED']);
    });
    await t('limit Never: no pause', async () => {
        const x = auto({ hold: 'off', closeLimit: 'off' }); await x.a.press('CLOSED'); x.eng.rpm = 6500; await x.a.tick(); assert.deepStrictEqual(x.sent, ['CLOSED']);
    });
    await t('fail-safe, manual: rpm lost -> OEM latched, stays OEM when the rpm returns, Close again resumes', async () => {
        const x = auto({ hold: 'off' }); await x.a.press('CLOSED'); x.eng.rpm = null; await x.a.tick();
        assert.deepStrictEqual(x.sent, ['CLOSED', 'OEM']); assert.strictEqual(x.a.selected(), 'OEM'); assert.ok(/select CLOSE again/.test(x.a.note().text));
        await x.a.tick(); assert.strictEqual(x.sent.length, 2, 'sent once');
        x.eng.rpm = 1200; await x.a.tick(); assert.deepStrictEqual(x.sent, ['CLOSED', 'OEM'], 'latched');
        await x.a.press('CLOSED'); assert.deepStrictEqual(x.sent, ['CLOSED', 'OEM', 'CLOSED']); assert.strictEqual(x.a.note(), null);
    });
    await t('fail-safe, manual: Close pressed with no rpm yet -> OEM latched', async () => {
        const x = auto({ hold: 'off' }); x.eng.rpm = null; await x.a.press('CLOSED'); assert.deepStrictEqual(x.sent, ['OEM']);
        x.eng.rpm = 900; await x.a.tick(); assert.deepStrictEqual(x.sent, ['OEM']);
    });
    await t('fail-safe, manual: hold stops repeating Close after the latch', async () => {
        const x = auto(); await x.a.press('CLOSED'); x.eng.rpm = null; await x.a.tick(); const n = x.sent.length; await sleep(200);
        assert.strictEqual(x.sent.length, n); assert.strictEqual(x.sent[n - 1], 'OEM');
    });
    await t('fail-safe, Drive mode: Eco Pro, rpm lost -> OEM paused, Close back when the rpm returns low', async () => {
        const x = auto({ hold: 'off' }); await x.a.driveMode(7); x.eng.rpm = null; await x.a.tick();
        assert.deepStrictEqual(x.sent, ['CLOSED', 'OEM']); assert.strictEqual(x.a.selected(), 'DRIVE');
        assert.ok(/RPM signal lost · Close paused/.test(x.a.note().text));
        await x.a.tick(); assert.strictEqual(x.sent.length, 2, 'sent once');
        x.eng.rpm = 1200; await x.a.tick(); assert.deepStrictEqual(x.sent, ['CLOSED', 'OEM', 'CLOSED']);
    });
    await t('fail-safe, Drive mode: rpm back but high -> paused until below the limit - 500', async () => {
        const x = auto({ hold: 'off' }); await x.a.driveMode(7); x.eng.rpm = null; await x.a.tick();
        x.eng.rpm = 3800; await x.a.tick(); assert.deepStrictEqual(x.sent, ['CLOSED', 'OEM']); assert.ok(/above 4,000/.test(x.a.note().text));
        x.eng.rpm = 3000; await x.a.tick(); assert.deepStrictEqual(x.sent, ['CLOSED', 'OEM', 'CLOSED']);
    });
    await t('fail-safe, Drive mode: Sport -> Eco Pro with no rpm -> OEM (not Close)', async () => {
        const x = auto({ hold: 'off' }); x.eng.rpm = null; await x.a.driveMode(1); await x.a.driveMode(7); assert.deepStrictEqual(x.sent, ['OPEN', 'OEM']);
        x.eng.rpm = 800; await x.a.tick(); assert.deepStrictEqual(x.sent, ['OPEN', 'OEM', 'CLOSED']);
    });
    await t('fail-safe, Drive mode: hold does not resend Close while paused', async () => {
        const x = auto(); await x.a.driveMode(7); x.eng.rpm = null; await x.a.tick(); const n = x.sent.length; await sleep(200);
        assert.strictEqual(x.sent.length, n);
    });
    await t('fail-safe off when Disarmed (simulated): Close with no rpm', async () => {
        const x = auto({ hold: 'off' }, false); x.eng.rpm = null; await x.a.press('CLOSED'); await x.a.tick(); assert.deepStrictEqual(x.sent, ['CLOSED']);
        const y = auto({ hold: 'off' }, false); y.eng.rpm = null; await y.a.driveMode(7); await y.a.tick(); assert.deepStrictEqual(y.sent, ['CLOSED']);
    });
    await t('fail-safe off with the limit Never', async () => {
        const x = auto({ hold: 'off', closeLimit: 'off' }); x.eng.rpm = null; await x.a.press('CLOSED'); await x.a.tick(); assert.deepStrictEqual(x.sent, ['CLOSED']);
        const y = auto({ hold: 'off', closeLimit: 'off' }); y.eng.rpm = null; await y.a.driveMode(7); await y.a.tick(); assert.deepStrictEqual(y.sent, ['CLOSED']);
    });
    await t('the fail-safe never touches Open or OEM', async () => {
        const x = auto({ hold: 'off' }); x.eng.rpm = null; await x.a.press('OPEN'); await x.a.tick(); await x.a.press('OEM'); await x.a.tick();
        assert.deepStrictEqual(x.sent, ['OPEN', 'OEM']);
    });
    await t('Open is never paused by the rpm', async () => {
        const x = auto({ hold: 'off' }); await x.a.press('OPEN'); x.eng.rpm = 6500; await x.a.tick(); assert.deepStrictEqual(x.sent, ['OPEN']);
    });
    await t('a held Close paused: hold stops, resumes after', async () => {
        const x = auto(); await x.a.press('CLOSED'); x.eng.rpm = 4600; await x.a.tick(); const n = x.sent.length; await sleep(200);
        assert.strictEqual(x.sent.length, n, 'repeating while paused'); x.eng.rpm = 1500; await x.a.tick(); await sleep(150);
        assert.ok(x.sent.filter((m) => m === 'CLOSED').length >= 3); await x.a.press('OEM');
    });
    await t('Drive mode turned on with Sport already selected: Open sent', async () => {
        const x = auto({ driveLink: 'off', hold: 'off' }); await x.a.driveMode(2); x.s.driveLink = 'on'; await x.a.settingsChanged('driveLink');
        assert.deepStrictEqual(x.sent, ['OPEN']);
    });
    await t('ignition on again (link up): the wanted mode is sent again', async () => {
        const x = auto({ hold: 'off' }); await x.a.driveMode(1); await x.a.linkUp(); assert.deepStrictEqual(x.sent, ['OPEN', 'OPEN']);
    });
}

/* --------------------------------------------------------------------------- controller + fake DME -- */

const hx = (a) => a.map((b) => b.toString(16).padStart(2, '0')).join(' ');
function car(o) {
    o = o || {};
    const dme = { tester: 9000, sent: [] };
    let cb;
    const frame = (u, d) => setTimeout(() => cb && cb({ udsResponse: Buffer.from([0, 0, 0, 0, 0, 0, 0x12, 0, 0].concat(u)) }), d || 5);
    return {
        dme,
        signals: {
            async proxy() { return {}; },
            async on(p, e, f) { cb = f; },
            async onAvailable(p, f) { f(true); },
            async call(p, m, req) {
                const sid = req.serviceID, d = [...req.udsData];
                dme.sent.push(hx([sid].concat(d)));
                // another app (X M Vitals) on the same link: its replies arrive too
                if (o.vitals && !(o.vitalsOnlyAfterStart && !o.started)) { frame([0x62, 0x40, 0x0A, 1, 2], 1); frame([0x7F, 0x22, 0x31], 2); }
                if (sid === 0x22) {
                    const did = (d[0] << 8) | d[1];
                    if (did === 0xF190) frame([0x62, 0xF1, 0x90].concat([...'WBATEST'].map((c) => c.charCodeAt(0))));
                    else if (did === 0x62FD) frame([0x62, 0x62, 0xFD, dme.tester >> 8, dme.tester & 255]);
                    else if (did === 0x64FD) frame([0x62, 0x64, 0xFD, 0]);
                    else frame([0x7F, 0x22, 0x31]);
                } else if (sid === 0x2F) {
                    if (o.needSession) frame([0x7F, 0x2F, 0x7F], o.slow || 5);
                    else {
                        if (d[2] === 3) dme.tester = (d[3] << 8) | d[4];
                        if (d[2] === 0) dme.tester = 9000;
                        frame([0x6F].concat(d), o.slow || 5);
                    }
                }
                return 'NO_ERROR';
            },
        },
    };
}
async function controller(o, arm) {
    const c = car(o), s = { arm: arm || 'on' };
    const ctl = new Controller({ log: quiet, signals: c.signals, settings: { get: (k) => s[k] }, spec: {} });
    await ctl.start();
    return { c, ctl, f2: () => c.dme.sent.filter((x) => x.startsWith('2f')) };
}
const shown = (v) => (v.confirmed !== 'UNKNOWN' ? v.confirmed : v.requested);

async function controllerTests() {
    await t('controller, Disarmed: nothing sent, not even reads', async () => {
        const x = await controller({}, 'off'); for (const m of ['OPEN', 'CLOSED', 'OEM']) await x.ctl.setMode(m);
        assert.strictEqual(x.c.dme.sent.length, 0);
    });
    await t('controller, Armed start: only reads (no 2F)', async () => {
        const x = await controller(); assert.strictEqual(x.f2().length, 0); assert.ok(x.c.dme.sent.length > 0);
    });
    await t('controller: Open / Close / OEM bytes', async () => {
        const x = await controller(); await x.ctl.setMode('OPEN'); await x.ctl.setMode('CLOSED'); await x.ctl.setMode('OEM');
        assert.deepStrictEqual(x.f2(), ['2f 60 fd 03 03 e8', '2f 60 fd 03 23 28', '2f 60 fd 00']);
    });
    await t('controller: Open accepted and shown OPEN', async () => {
        const x = await controller(); await x.ctl.setMode('OPEN'); const v = x.ctl.view();
        assert.strictEqual(v.accepted, true); assert.strictEqual(shown(v), 'OPEN');
    });
    await t('controller, another app on the link + the DME refuses: refusal shown, not accepted', async () => {
        const o = { vitals: true, vitalsOnlyAfterStart: true, needSession: true }; const x = await controller(o); o.started = true;
        await x.ctl.setMode('OPEN'); const v = x.ctl.view(); assert.strictEqual(v.accepted, false); assert.ok(/session/.test(v.error || ''), v.error);
    });
    await t('controller, another app on the link + the DME takes Open: accepted, shown OPEN', async () => {
        const o = { vitals: true, vitalsOnlyAfterStart: true }; const x = await controller(o); o.started = true;
        await x.ctl.setMode('OPEN'); const v = x.ctl.view(); assert.strictEqual(v.accepted, true); assert.strictEqual(shown(v), 'OPEN');
    });
    await t('controller: OEM pressed during an Open in flight is queued and sent after', async () => {
        const x = await controller({ slow: 150 }); const p = x.ctl.setMode('OPEN'); await sleep(20); await x.ctl.setMode('OEM'); await p; await sleep(400);
        assert.deepStrictEqual(x.f2(), ['2f 60 fd 03 03 e8', '2f 60 fd 00']); assert.strictEqual(x.ctl.view().requested, 'OEM');
    });
}

/* ------------------------------------------------------------------------------- picture + screen -- */

async function pictureTests() {
    await t('picture: one layer of shaded triangles and flat cells, within the renderer limits', async () => {
        const L = makeLayer(IMG.LW, IMG.LH, (c) => IMG.draw(c), 1.164);
        const u = L.words;
        assert.strictEqual(u[0], OP.TRIS, 'starts with one TRIS op');
        assert.ok(u[1] > 0 && u[1] <= 100000, 'triangles ' + u[1]);
        assert.ok(u.length * 4 < 1024 * 1024, 'upload ' + (u.length * 4) + ' bytes');
    });
    await t('picture: software pixels opaque on the silencer, clear around it', async () => {
        const c = IMG.soft(new Canvas(IMG.LW, IMG.LH));
        const a = (x, y) => c.d[(y * c.w + x) * 4 + 3];
        assert.ok(a(500, 140) >= 240, 'silencer body ' + a(500, 140));
        assert.strictEqual(a(2, 2), 0, 'top-left corner');
        assert.strictEqual(a(500, IMG.LH - 3), 0, 'under the silencer');
        assert.ok(c.d[(140 * c.w + 500) * 4] > 60, 'the body is not black');
    });
    await t('picture: the tailpipe openings inside the picture, the right one carries the flap', async () => {
        for (const b of [IMG.BORES.left, IMG.BORES.right]) {
            assert.ok(b.c[0] - b.a > 0 && b.c[0] + b.a < IMG.LW && b.c[1] - b.b > 0 && b.c[1] + b.b < IMG.LH);
        }
        assert.ok(IMG.BORES.right.c[0] > IMG.BORES.left.c[0]);
    });
    await t('Exhaust Flap tab: drawn in every state on a recorder and a software canvas', async () => {
        const th = theme('m_tricolour');
        const H2 = 200;                                    // a row through the silencer
        const states = [
            { confirmed: 'OPEN', requested: 'OPEN', angle: 1 },
            { confirmed: 'CLOSED', requested: 'CLOSED', angle: 0, selected: 'DRIVE', note: { text: 'Eco Pro', warn: false } },
            { confirmed: 'UNKNOWN', requested: 'OEM', simulated: true, note: { text: 'Close paused above 4,000 rpm · the car has the flap', warn: true } },
            { confirmed: 'UNKNOWN', requested: 'OEM', error: 'DME refused' },
        ];
        for (const v of states) {
            const r = new Recorder(UI.W, UI.H, { textScale: 1.2 });
            UI.draw(r, G, th, Object.assign({ pages: ['Exhaust Flap'], page: 'Exhaust Flap' }, v), {});
            assert.ok(r.n > 0);
            const c = new Canvas(UI.W, UI.H);              // the software renderer plays the recording
            play(r.words(), c);
            const mid = (Math.round(H2) * UI.W + UI.W / 2) * 4;
            assert.ok(c.d[mid + 3] === 255, 'software frame drawn');
        }
    });
}

/* --------------------------------------------------------------------------------------- languages -- */

const ATLAS = {
    ko: 'kit/localization/fonts/korean.json',
    'zh-CN': 'kit/runtime/fonts/cjk.json',
    ru: 'kit/localization/fonts/cyrillic-ru.json',
};
const glyphs = (f) => new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')).sizes[0].glyphs).map(Number));
/** ui.js as a fixed-language build loads it (build.py --language: kit/locale.json is that language's catalogue). */
function uiIn(lang) {
    const loc = path.join(KIT, 'locale.json'), strings = lang === 'en' ? {} : JSON.parse(fs.readFileSync(path.join(KIT, 'locales', lang + '.json'), 'utf8'));
    [loc, path.join(KIT, 'i18n.js'), path.join(APP, 'ui.js')].forEach((f) => { delete require.cache[f]; });
    require.cache[loc] = { id: loc, filename: loc, loaded: true, exports: { language: lang, strings } };
    const ui = require(path.join(APP, 'ui'));
    const { t: tr } = require(path.join(KIT, 'i18n'));
    delete require.cache[loc]; delete require.cache[path.join(KIT, 'i18n.js')]; delete require.cache[path.join(APP, 'ui.js')];
    return { ui, tr, strings };
}

async function languageTests() {
    // every line auto.js can put under the state word, and its pieces
    const lines = ['RPM signal lost · OEM requested · select CLOSE again', 'RPM signal lost · Close paused · the car has the flap',
        'Waiting for the driving mode', 'holding', 'Sport', 'Sport+', 'Sport Individual', 'Comfort', 'Comfort+',
        'Comfort Individual', 'Eco Pro', 'Eco Pro+', 'Eco Pro Individual', 'Adaptive', 'Sport · holding',
        'Hybrid', 'Hybrid Eco', 'Hybrid Comfort', 'Electric', 'Electric Individual', 'Sport Boost'];
    const label = glyphs('kit/runtime/fonts/label.json');
    for (const lang of Object.keys(ATLAS)) {
        await t('status line ' + lang + ': every line from the shared catalogue, the rpm figure kept, all glyphs in the atlas', async () => {
            const { ui, tr } = uiIn(lang), out = [];
            for (const s of lines) { const o = ui.noteText(s); assert.ok(o && o !== s && !/[A-Za-z]{3}/.test(o.replace(/RPM|rpm/g, '')), lang + ' ' + s + ' -> ' + o); out.push(o); }
            const paused = ui.noteText('Close paused above 4,500 rpm · the car has the flap');
            assert.ok(paused.indexOf('4,500') >= 0 && !/paused/.test(paused), paused);
            out.push(paused);
            const button = tr('DRIVE MODE');                     // a button upper-cases its label
            assert.notStrictEqual(button, 'DRIVE MODE');
            out.push(button);
            const atlas = glyphs(ATLAS[lang]);
            const missing = [...new Set(out.join(''))].filter((c) => c.charCodeAt(0) > 127 && !atlas.has(c.charCodeAt(0)) && !label.has(c.charCodeAt(0)));
            assert.deepStrictEqual(missing, []);
        });
        await t('menus ' + lang + ': every label of app.json in the shared catalogue', async () => {
            const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
            const words = JSON.parse(fs.readFileSync(path.join(KIT, 'locales', lang + '.json'), 'utf8'));
            const labels = [];
            spec.screens.forEach((s) => (s.buttons || []).forEach((b) => labels.push(b[1])));
            spec.settings.filter((s) => s.key === 'hold' || s.key === 'closeLimit')
                .forEach((s) => { labels.push(s.label); (s.options || []).forEach((o) => labels.push(o[1])); });
            const need = labels.filter((l) => l && /[A-Za-z]{2}/.test(l) && !/^\d/.test(l));
            assert.deepStrictEqual(need.filter((l) => !Object.prototype.hasOwnProperty.call(words, l)), []);
        });
    }
    await t('status line: English builds unchanged', async () => {
        const { ui } = uiIn('en');
        assert.strictEqual(ui.noteText('Sport · holding'), 'Sport · holding');
        assert.strictEqual(ui.noteText('Close paused above 4,000 rpm · the car has the flap'), 'Close paused above 4,000 rpm · the car has the flap');
    });
}

/* ---------------------------------------------------------------------------------------- app.json -- */

async function specTests() {
    const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    const S = {};
    spec.settings.forEach((s) => { S[s.key] = s; });
    await t('app.json: Engine Config\'s settings kept (names, defaults, Disarmed), Hold and the Close limit after the arm switch', async () => {
        assert.deepStrictEqual(spec.settings.map((s) => s.key), ['arm', 'hold', 'closeLimit', 'tuner', 'mapPin', 'mapPinCode', 'xdrive', 'theme', 'layout', 'renderer', 'demo']);
        assert.deepStrictEqual([S.arm.label, S.arm.default, S.tuner.default, S.xdrive.default], ['Exhaust Flap', 'off', 'off', 'off']);
        assert.deepStrictEqual([S.hold.default, S.closeLimit.default], ['on', '4000']);
        assert.ok(!S.driveLink, 'Drive mode is saved with the settings but not shown in the menu');
    });
    await t('app.json: the driving mode signal and the Drive mode button', async () => {
        assert.strictEqual(spec.signals['de.bmw.infotainment.drivingexcitement.FES'].statusFESVehicleDynamicSwitchHMI, 'rs');
        assert.ok(spec.screens[0].buttons.some((b) => b[0] === 'BTN_DRIVE'));
    });
}

(async () => {
    await autoTests();
    await controllerTests();
    await pictureTests();
    await languageTests();
    await specTests();
    results.forEach((l) => console.log(l));
    const failed = results.filter((l) => l.startsWith('FAIL')).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'Engine Config Exhaust Flap checks: all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
