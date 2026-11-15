'use strict';

// Redline's HUD running against a stand-in cluster-render:
//   node kit/tools/test_redline_running.js
// - the HUD is one image layer (a picture) on every layout, never a shader (the cluster runs the HUD's
//   shaders, and a heavy one restarted it on the car: README "HUD drawing");
// - the Sport / Comfort profiles switch the running HUD with the driving mode, Don't show drops its layer;
// - the knock warning and the launch time where the grade shows;
// - the tyre widget in the directions' corner: when a tyre is low (or always, or never), the directions first;
// - "Play on HUD" and the HUD looks preview: the same demo frame (blink and shake);
// - the HUD off stops every UDS reader (the electrical one too).

const fs = require('fs');
const path = require('path');
const TH = require('./redline_test_harness');
const { TMP, SHM } = TH.claimsDir('redline-running-');
const ROOT = TH.ROOT;

// a stand-in cluster-render: ready at once; records layers and pixels
let cr = null;
TH.hookKit({ clusterRender: TH.fakeClusterRender({ set: 'merge', onCreate: (c) => { cr = c; } }) });
const Hud = require(path.join(ROOT, 'apps', 'redline', 'hud'));
const HudNav = require(path.join(ROOT, 'apps', 'redline', 'hud-nav'));
const def = TH.redlineDefaults().def;

const tally = TH.counter(), ok = tally.ok, sleep = TH.sleep;
const log = { info() {}, warn() {}, error() {} };

(async () => {
    // a claim from this boot, so the HUD stays on at start
    fs.mkdirSync(SHM);
    fs.writeFileSync(path.join(SHM, 'redline'), JSON.stringify({ held: false, at: Date.now() }) + '\n');
    // an old setting from 1.16.0-1.16.6 asking for the GPU: ignored
    // (In Comfort / Eco Pro: Same as Sport, the OG default; this fork's own is Don't show, checked in test_redline_hud.js)
    const v = Object.assign({}, def, { hud: 'on', hudStyle: 'arc', hudRenderer: 'gpu', hudFps: 30, hudComfortMode: 'same' }), fns = [];
    const settings = { get: (k) => v[k], set: (k, x) => { v[k] = x; fns.forEach((f) => f(k, x)); }, onChange: (f) => fns.push(f) };
    let rpm = 3000, drive = 'sport', speed = 80, cond, known;
    const src = { data: () => ({ rpm: rpm, gear: 3, stage: 'D', speed: speed, oil: 95, coolant: 92, condition: cond, conditionKnown: known }), shiftPoint: () => ({ rpm: 6200, cold: false }), redline: () => 6550,
        maxRpm: () => 8000, driveMode: () => drive,
        // a stand-in knock reader: started / stopped by the HUD, its last event's time set by the test
        knock: { on: false, at: 0, start() { this.on = true; }, stop() { this.on = false; }, value() { return { retard: null, at: this.at }; } },
        // stand-ins for the electrical reader (started / stopped by the HUD) and the tyres (values set by the test)
        electrical: { on: false, want: null, start(w) { this.on = true; this.want = w; }, stop() { this.on = false; }, value() { return {}; } },
        tyres: { val: null, value() { return this.val; } },
        // a stand-in for the directions: m is the turn shown (null: none)
        nav: { m: null, view() { return { show: this.m, giveWay: false }; } },
        // a stand-in launch score: a run that finished `at`
        launch: (now, mph) => (launchRun && now - launchRun.at < 3000 ? Object.assign({ label: mph ? '0-60' : '0-100' }, launchRun) : null) };
    let launchRun = null;
    const h = Hud.start({ settings: settings, log: log, dataDir: TMP, backWaitMs: 600, callBackMs: 400 }, src);
    await sleep(250);

    // every layout: one image layer, no shader
    const img = cr.of('image');
    ok(img.length === 1 && cr.of('effect').length === 0, 'Arc (an old GPU setting set): one image layer, no shader');
    const I = cr.layers[img[0]] || {};
    ok(I.target === 'hud' && I.klass === 'overlay' && I.z === 0, 'the image: on the HUD, overlay');
    for (const st of ['standard', 'minimal', 'wings', 'digital', 'vfd', 'vector', 'tyres', 'ramp', 'dial', 'pill', 'arc']) {
        settings.set('hudStyle', st); rpm = 6400; await sleep(120);
        ok(cr.of('image').length === 1 && cr.of('effect').length === 0, st + ': the picture, no shader');
    }
    // the revs move the picture
    const before = cr.frames.length;
    for (let r = 4000; r <= 6000; r += 400) { rpm = r; await sleep(60); }
    ok(cr.frames.length > before, 'moving revs redraw the picture (' + (cr.frames.length - before) + ' frames)');

    // the Sport / Comfort profiles in the running HUD: Comfort follows Sport, then its own, then Don't show
    // (the layer dropped while in Comfort)
    ok(h.frame().opts.style === 'arc', 'Sport: the Arc');
    drive = 'comfort'; await sleep(200);
    ok(h.frame().opts.style === 'arc' && cr.of('image').length === 1, 'Comfort, same as Sport: the Arc too');
    Hud.profileView(settings, 'comfort').set('hudStyle', 'standard'); await sleep(200);
    ok(h.frame().opts.style === 'standard' && cr.of('image').length === 1, 'Comfort, its own: Standard');
    drive = 'sport'; await sleep(200);
    ok(h.frame().opts.style === 'arc' && cr.of('image').length === 1, 'back in Sport: the Arc');
    Hud.setComfortMode(settings, 'hide'); drive = 'comfort'; await sleep(200);
    ok(cr.of('image').length === 0, "Comfort, Don't show: Redline's layer gone");
    // hidden, the car isn't read, but the one look for a hybrid battery may still run (a PHEV's Hybrid mode counts as
    // Comfort): the electrical reader asked for nothing else (2026-11-10 review)
    ok(!src.knock.on && src.electrical.on && JSON.stringify(src.electrical.want) === '{}', "Comfort, Don't show: no reads, the electrical reader only for its hybrid look (" + JSON.stringify(src.electrical.want) + ')');
    // switching off in Comfort on Don't show (issue #141): an unknown mode (null, shown as Sport) while the car's state
    // is ending (12) or off (5) makes no new layer, so cluster-render never maps the HUD as the cluster goes off
    cond = 12; drive = null; await sleep(200);
    ok(cr.of('image').length === 0 && /switched on/.test(h.status()), 'switching off, the mode unknown: no new layer (' + h.status() + ')');
    cond = 5; await sleep(150);
    ok(cr.of('image').length === 0, 'switched off: still no layer');
    cond = 8; drive = 'sport'; await sleep(150);
    ok(cr.of('image').length === 0, 'drive readiness starting: no layer yet');
    cond = 10; await sleep(200);
    ok(cr.of('image').length === 1, 'drive-ready in Sport: the layer');
    cond = 12; await sleep(150);
    ok(cr.of('image').length === 0 && /switched on/.test(h.status()), 'switching off with the tach shown: the layer dropped (' + h.status() + ')');
    cond = 10; await sleep(200);
    ok(cr.of('image').length === 1, 'drive-ready again: the layer back');
    // a state the car sends that isn't known ("no value" 15): the last known one may be stale, no new layer;
    // a layer already up stays (a car that sent it while driving keeps its HUD)
    known = false; await sleep(150);
    ok(cr.of('image').length === 1, 'an unknown state with the tach shown: it stays');
    Hud.setComfortMode(settings, 'hide'); drive = 'comfort'; await sleep(150);
    drive = 'sport'; await sleep(200);
    ok(cr.of('image').length === 0, 'an unknown state: no new layer for Sport');
    known = undefined; await sleep(200);
    ok(cr.of('image').length === 1, 'the state known again: the layer');
    // the directions giving way ends (a route ending, as at switch-off): the tach back only after a wait
    let gw = true;
    src.nav.view = function () { return { show: null, giveWay: gw }; };
    await sleep(150);
    ok(cr.of('image').length === 0, 'giving way to BMW\'s directions: no layer');
    gw = false; await sleep(300);
    ok(cr.of('image').length === 0, 'give-way just over: the tach not back yet');
    gw = true; await sleep(100); cond = 12; gw = false; await sleep(200);
    ok(cr.of('image').length === 0, 'give-way over as the car switches off: still no layer');
    cond = 10; await sleep(800);
    ok(cr.of('image').length === 1, 'give-way over while driving: the tach back after the wait');
    src.nav.view = function () { return { show: this.m, giveWay: false }; };
    cond = undefined;
    drive = 'sport'; Hud.setComfortMode(settings, 'same'); await sleep(250);
    ok(cr.of('image').length === 1, 'back in Sport: shown again');
    // a call ringing (issue #181): the tach out of the way of BMW's call card the whole time, back a moment after
    let ring = true; src.ringing = () => ring;
    await sleep(150);
    ok(cr.of('image').length === 0 && h.status() === 'HUD: giving way to the call', 'a call ringing: no layer (' + h.status() + ')');
    await sleep(600);
    ok(cr.of('image').length === 0, 'still ringing after longer than a BMW pop-up: still no layer');
    ring = false; await sleep(150);
    ok(cr.of('image').length === 0 && h.status() === 'HUD: giving way to the call', 'the call answered: the tach not back at once (' + h.status() + ')');
    await sleep(500);
    ok(cr.of('image').length === 1, 'the call answered: the tach back after the wait');
    delete src.ringing;
    // Comfort's own size and place: the tach moves there when the mode is Comfort, back when it's Sport
    Hud.setComfortMode(settings, 'own');
    const cv = Hud.profileView(settings, 'comfort');
    cv.set('hudSize', 70); cv.set('hudX', 120); cv.set('hudY', 40);
    drive = 'comfort'; await sleep(250);
    const small = Object.assign({}, cr.layers[cr.of('image')[0]] || {}), want = Hud.placeOf(cv);
    ok(small.w === 280 && small.x === want.x && small.y === want.y, 'Comfort, its own place: the tach small in the corner (' + [small.x, small.y, small.w, small.h] + ')');
    drive = 'sport'; await sleep(250);
    const big = cr.layers[cr.of('image')[0]] || {};
    ok(big.w === 400 && big.x !== small.x, 'back in Sport: Sport\'s own size and place (' + [big.x, big.y, big.w, big.h] + ')');
    Hud.setComfortMode(settings, 'same'); await sleep(150);
    ok(cr.effects === 0, 'no shader made in the whole run (' + cr.effects + ')');

    // the knock warning: the reader runs while the HUD shows (warning on by default); an event shows KNOCK
    // where the grade goes, for 1.5 s; switched off, the reader stops and nothing shows
    ok(src.knock.on, 'knock: the engine unit is read while the HUD shows');
    src.knock.at = Date.now();
    const kf = h.frame();
    ok(kf.chip && kf.chip.verdict === 'KNOCK', 'knock: KNOCK shows after an event (' + JSON.stringify(kf.chip) + ')');
    src.knock.at = Date.now() - 2000;
    ok(!h.frame().chip, 'knock: gone 1.5 s after the last event');
    settings.set('hudKnockWarn', false); src.knock.at = Date.now(); await sleep(150);
    ok(!h.frame().chip && !src.knock.on, 'knock warning off: no KNOCK, the reader stopped');
    settings.set('hudShowKnock', true); await sleep(150);
    ok(src.knock.on, 'knock readout on: the reader runs again');
    rpm = 0; await sleep(150);
    ok(!src.knock.on, 'engine off: the reader stops');

    // the launch time where the grade shows: the time and its difference, green for a best; knock goes first
    settings.set('hudKnockWarn', true); src.knock.at = 0; await sleep(100);
    launchRun = { secs: 4.92, delta: -0.08, best: true, at: Date.now() };
    const lf = h.frame();
    ok(lf.chip && lf.chip.verdict === 'LAUNCH' && lf.chip.text === '4.92  -0.08' && lf.chip.tone === 'low', 'launch: 4.92  -0.08 in green (' + JSON.stringify(lf.chip) + ')');
    launchRun = { secs: 5.31, delta: 0.31, best: false, at: Date.now() };
    ok(h.frame().chip.tone === 'high' && h.frame().chip.text === '5.31  +0.31', 'launch: slower in red');
    rpm = 3000; await sleep(150); src.knock.at = Date.now();
    ok(h.frame().chip.verdict === 'KNOCK', 'knock goes before the launch time');
    src.knock.at = 0;
    settings.set('hudLaunch', false);
    ok(!h.frame().chip, 'launch time off: nothing');

    // the tyre widget: the directions' corner (their layer and place) when they have nothing; the directions first
    settings.set('hudStyle', 'standard'); src.knock.at = 0;
    const T = (rr) => ({ p: { FL: 2.5, FR: 2.5, RL: 2.7, RR: rr }, tgt: { FL: 2.5, FR: 2.5, RL: 2.7, RR: 2.7 }, t: { FL: 40, FR: 40, RL: 40, RR: 40 } });
    const corners = () => cr.of('image').filter((r) => cr.layers[r].iw === 200 && cr.layers[r].ih === 76);
    src.tyres.val = T(2.6); await sleep(200);
    ok(h.corner() === '' && corners().length === 0, 'tyres fine ("when a tyre is low"): no widget (' + h.corner() + ')');
    src.tyres.val = T(2.0); await sleep(200);
    ok(h.corner() === 'tyres' && corners().length === 1 && cr.of('image').length === 2, 'a tyre low: the widget in the corner, beside the tach (' + h.corner() + ')');
    src.nav.m = HudNav.SAMPLE; await sleep(250);
    ok(h.corner() === 'nav' && corners().length === 1, 'a turn to show: the directions take the corner (' + h.corner() + ')');
    src.nav.m = null; await sleep(250);
    ok(h.corner() === 'tyres', 'the turn done: the tyres again');
    src.tyres.val = T(2.6); await sleep(200);
    ok(h.corner() === '' && corners().length === 0, 'the tyre pumped up: the widget goes');
    settings.set('hudTyreWidget', 'always'); await sleep(200);
    ok(h.corner() === 'tyres', 'widget "Always": shown with fine tyres');
    src.tyres.val = null; await sleep(200);
    ok(h.corner() === '' && corners().length === 0, 'no tyre data: no widget');
    settings.set('hudTyreWidget', 'off'); src.tyres.val = T(1.8); await sleep(200);
    ok(h.corner() === '' && corners().length === 0, 'widget off: never, a low tyre neither');
    settings.set('hudTyreWidget', 'low'); await sleep(200);
    ok(h.corner() === 'tyres', 'back on "when a tyre is low"');
    ok(cr.effects === 0, 'no shader made with the tyres either (' + cr.effects + ')');

    // "Play on HUD" and the HUD looks preview draw one demo frame (hud.js demoFrame): the same blink and shake.
    // The clock is held still and stepped by hand, so the HUD's timer can't step in between.
    {
        const main = fs.readFileSync(path.join(ROOT, 'apps', 'redline', 'main.js'), 'utf8');
        const pv = main.slice(main.indexOf('const studioFrame'), main.indexOf('function lookLayer('));
        ok(/Hud\.demoFrame\(now - studio\.t0, Hud\.optsFrom\(studioP\(\)\), studio\.cue, hud \? hud\.lead\(\) : 200, now\)/.test(pv) && !/blink|shake|SHAKE/.test(pv),
            'the preview takes its frame from Hud.demoFrame, no blink or shake of its own');
        settings.set('hudShake', true); speed = 0;
        const realNow = Date.now;
        let clock = realNow.call(Date), diff = null;
        const shakes = {}, blinks = {}, phase = {};
        Date.now = () => clock;
        try {
            h.play(30000, 'sport');
            const t0 = clock, cue = {};
            for (let t = 0; t < Hud.DEMO_MS && !diff; t += 10) {
                clock = t0 + t;
                const f = h.frame(), g = Hud.demoFrame(t, f.opts, cue, h.lead(), clock);
                if (JSON.stringify(f) !== JSON.stringify(g)) diff = t + ' ms: ' + JSON.stringify(f).slice(0, 300) + ' / ' + JSON.stringify(g).slice(0, 300);
                if (f.shake) shakes[f.shake.join()] = true;
                if (f.cue.shift || f.cue.limiter) { blinks[f.blink] = true; phase[Math.floor(clock / 100) % 2 === 0] = f.blink; }
            }
        } finally { Date.now = realNow; }
        h.stopPlay(); settings.set('hudShake', false); speed = 80;
        ok(!diff, 'Play on HUD: its frame is Hud.demoFrame, frame by frame' + (diff ? ' (' + diff + ')' : ''));
        ok(Object.keys(shakes).length === 6, 'demo frame: the shake steps through all 6 offsets (' + Object.keys(shakes).join(' ') + ')');
        ok(blinks.true && blinks.false && phase.true === true && phase.false === false, 'demo frame: the flash blinks on the HUD rhythm (100 ms on, 100 ms off)');
    }

    // the HUD off: every reader stops, the electrical one too (it kept polling before 2.0's review)
    ok(src.electrical.on, 'electrical reader started while the HUD shows');
    settings.set('hud', 'off'); await sleep(200);
    ok(!src.electrical.on && !src.knock.on, 'HUD off: the electrical and knock readers stopped');
    ok(corners().length === 0 && h.corner() === '', 'HUD off: the tyre widget gone too');

    h.stop();
    TH.rmTree(TMP);
    console.log('redline running: ' + tally.checks + ' checks, ' + tally.fails + ' failed');
    process.exit(tally.fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
