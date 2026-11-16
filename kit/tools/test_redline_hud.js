'use strict';

// Redline HUD: the parts that run without a head unit or cluster-render.
//   node kit/tools/test_redline_hud.js
// - every layout, palette and switch combination draws both layers without throwing, and the Rev bar
//   switch really removes the bar;
// - the readouts row: units, the four-item cap (a cold / hot warning keeps its place), missing data;
// - the shift cue: counts in, flashes before the point by the lead, holds, ends on the upshift, a
//   lift or the drop after a shift without a gear signal, and flags the limiter;
// - the scripted demo drive stays in range; settings in the code exist in app.json and vice versa;
// - 2.0.1's tyres: Redline's own reading, the readout and its 2x2 block, the tyre widget with every part, unit and label size;
// - 2.0's electrical readouts: a petrol / diesel car never shows the hybrid ones; electrical.js reads what eDrive reads.

const fs = require('fs');
const path = require('path');
const TH = require('./redline_test_harness');
const ROOT = TH.ROOT;
const APP = path.join(ROOT, 'apps', 'redline');

// the app requires the kit as './kit/...' (where the build puts it)
TH.hookKit();
const Hud = require(path.join(APP, 'hud'));
const Draw = require(path.join(APP, 'hud-draw'));
const { Canvas } = require(path.join(ROOT, 'kit', 'runtime', 'canvas'));

const tally = TH.counter(), ok = tally.ok;

/* ---------- settings: every key the HUD code reads is declared, with the default it expects ---------- */
const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
const declared = {};
spec.settings.forEach((s) => { if (s.key) declared[s.key] = s; });
const src = ['hud.js', 'hud-draw.js', 'main.js', 'hud-tyres.js', 'tyres.js'].map((f) => fs.readFileSync(path.join(APP, f), 'utf8')).join('\n');
const used = {};
src.replace(/settings\.(?:get|set)\('(hud[A-Za-z]*)'/g, (m, k) => { used[k] = true; return m; });
src.replace(/on\('(hud[A-Za-z]*)'\)/g, (m, k) => { used[k] = true; return m; });
Object.keys(used).forEach((k) => ok(declared[k], 'setting ' + k + ' is used but not in app.json'));
Object.keys(declared).filter((k) => /^hud/.test(k)).forEach((k) => ok(used[k] || k === 'hudAll' || /hudLead|hudFps|hudSize|hudX|hudY|hudUnlit|hudStyle|hudPalette|hudChip|hudPeak|hudShake|hudLightStyle|hudTempsMode|hudTempUnit|hudBoostUnit|hudTorqueUnit|hudPowerUnit|hudHybridMode|hudHybridSetup/.test(k) && src.indexOf("'" + k + "'") >= 0,
    'setting ' + k + ' is in app.json but never read'));

const settingsOf = (over) => ({
    get: (k) => (over && k in over ? over[k] : declared[k] ? declared[k].default : undefined),
});
const optsDefault = Hud.optsFrom(settingsOf());
ok(optsDefault.bar === true && optsDefault.rpm === true && optsDefault.lights === true, 'defaults: rev bar, rpm readout and lights on');
ok(optsDefault.torque === false && optsDefault.power === false && optsDefault.g === false && optsDefault.throttle === false && optsDefault.outside === false, 'defaults: the extra readouts are off');

/* ---------- drawing: every layout, palette and switch, both layers ---------- */
const LAYOUTS = ['standard', 'minimal', 'wings', 'digital', 'vfd', 'vector', 'arc', 'ramp', 'dial', 'pill'];
const lit = (cv) => { let n = 0; for (let i = 3; i < cv.d.length; i += 4) if (cv.d[i]) n++; return n; };
function frame(o, extra) {
    return Object.assign({
        d: { rpm: 5200, gear: 3, stage: 'D' }, shift: 5550, redline: 6550, max: 8000, blink: true, down: 2, peak: 6100,
        chip: { verdict: 'LATE', age: 300, burst: true }, cue: { from: 4050, at: 5550, shift: false, limiter: false },
        readouts: [{ label: 'BOOST', value: '1.2', tone: 'text' }, { label: 'OIL', value: '41°', tone: 'cold' }], mode: 'M', opts: o,
    }, extra || {});
}
LAYOUTS.forEach((style) => ['colour', 'amber', 'ice'].forEach((palette) => [true, false].forEach((on) => {
    const o = Object.assign({}, optsDefault, { style: style, palette: palette, bar: on, lights: on, gt3: on, rpm: on, gear: on, mode: on, peak: on });
    ['bg', 'fg', 'both'].forEach((layer) => {
        const cv = new Canvas(Draw.IW, Draw.IH);
        try { Draw.drawLayer(cv, frame(o, { cue: { from: 4050, at: 5550, shift: on, limiter: !on } }), layer); }
        catch (e) { ok(false, style + '/' + palette + '/' + layer + ' threw: ' + e.message); }
    });
})));
// the Rev bar switch removes the bar (minimal has none to remove; on dial the band is the shift lights too, so it
// stays while they are on; ramp's lights are their own row since 2.0.21, so its gauge goes)
// (pill: its panel is most of the picture, so only its ring goes: fewer lit pixels, the panel kept)
LAYOUTS.filter((s) => ['minimal', 'dial'].indexOf(s) < 0).forEach((style) => {
    const px = (bar) => { const cv = new Canvas(Draw.IW, Draw.IH); Draw.drawLayer(cv, frame(Object.assign({}, optsDefault, { style: style, bar: bar }), { readouts: [], chip: null }), 'both'); return lit(cv); };
    if (style === 'pill') {
        const pic = (bar) => { const cv = new Canvas(Draw.IW, Draw.IH); Draw.drawLayer(cv, frame(Object.assign({}, optsDefault, { style: style, bar: bar }), { readouts: [], chip: null }), 'both'); return cv; };
        const a = pic(true), b = pic(false), i = (Math.round(70 - 37) * Draw.IW + 54) * 4;   // the ring's top
        ok(px(false) === px(true) && (a.d[i] !== b.d[i] || a.d[i + 1] !== b.d[i + 1]), 'pill: Rev bar off removes the ring round the gear, the panel stays');
    } else ok(px(false) < px(true) * 0.6, style + ': Rev bar off still draws most of the bar');
});
// pill: the panel reddens through the count-in; from the shift point and on the limiter it flashes (solid red, then
// grey), grey below the count-in and with the shift lights off
{
    const panel = (rpm, cue, extra) => { const cv = new Canvas(Draw.IW, Draw.IH);
        Draw.drawLayer(cv, frame(Object.assign({}, optsDefault, { style: 'pill', lights: !(extra && extra.off) }),
            { d: { rpm: rpm, gear: 3, stage: 'D' }, readouts: [], chip: null, peak: 0, blink: !(extra && extra.dark), cue: Object.assign({ from: 4400, at: 5550, shift: false, limiter: false }, cue) }), 'both');
        const i = (112 * Draw.IW + 250) * 4; return cv.d[i] - cv.d[i + 1]; };
    const low = panel(3000), half = panel(4975), at = panel(5600, { shift: true }), dark = panel(5600, { shift: true }, { dark: true });
    ok(low < 20 && half > low + 40 && at > half + 40 && dark < 20 && panel(6560, { limiter: true }) > half + 40 && panel(5600, { shift: true }, { off: true }) < 20,
        'pill: grey (' + low + '), redder through the count-in (' + half + '), flashing solid red (' + at + ') and grey (' + dark + ') from the shift point; grey with the shift lights off');
}
// only the shift lights (everything else off) still draws something
{
    const o = Object.assign({}, optsDefault, { style: 'vfd', bar: false, rpm: false, gear: false, mode: false });
    const cv = new Canvas(Draw.IW, Draw.IH);
    Draw.drawLayer(cv, frame(o, { readouts: [], chip: null, down: 0 }), 'both');
    ok(lit(cv) > 200, 'VFD with only the shift lights draws them');
}

/* ---------- readouts ---------- */
const o = Object.assign({}, optsDefault, { rpm: true, boost: true, torque: true, power: true, throttle: true, g: true, outside: true,
    boostUnit: 'psi', torqueUnit: 'lbft', powerUnit: 'hp', smartTemps: true });
const x = { torque: 420, pedal: 97, gLat: 0.6, gLong: -0.8, outside: 2 };
let r = Hud.readoutsFor({ rpm: 5500, oil: 40, coolant: 90 }, 70, 1.2, { rpm: 4500, cold: true }, o, x);
ok(r.length === Hud.MAX_READOUTS, 'at most ' + Hud.MAX_READOUTS + ' readouts: ' + r.length);
ok(r.some((it) => it.label === 'OIL' && it.tone === 'cold'), 'a cold oil temperature keeps its place');
ok(r.some((it) => it.label === 'LIMIT'), 'the cold limit keeps its place');
ok(!r.some((it) => it.label === 'WATER'), 'water at operating temperature is hidden (smart temps)');
r = Hud.readoutsFor({ rpm: 5500 }, null, null, null, Object.assign({}, o, { rpm: false, boost: false, oil: false, coolant: false, gearbox: false, outside: false, throttle: false, g: false, powerUnit: 'kw', torqueUnit: 'nm' }), { torque: 400 });
ok(JSON.stringify(r) === JSON.stringify([{ label: 'TORQUE', value: '400', tone: 'text' }, { label: 'KW', value: '230', tone: 'text' }]), 'torque Nm and power kW: ' + JSON.stringify(r));
// kgm: 420 Nm = 42.8 kgm, rounded to 1 (not to 5 as Nm and lb-ft); lb-ft: 420 Nm = 309.8, to 5
const tqOnly = Object.assign({}, o, { rpm: false, boost: false, power: false, throttle: false, g: false, oil: false, coolant: false, gearbox: false, outside: false });
r = Hud.readoutsFor({ rpm: 5500 }, null, null, null, Object.assign({}, tqOnly, { torqueUnit: 'kgm' }), { torque: 420 });
ok(JSON.stringify(r) === JSON.stringify([{ label: 'KGM', value: '43', tone: 'text' }]), 'torque in kgm: ' + JSON.stringify(r));
r = Hud.readoutsFor({ rpm: 5500 }, null, null, null, Object.assign({}, tqOnly, { torqueUnit: 'lbft' }), { torque: 420 });
ok(JSON.stringify(r) === JSON.stringify([{ label: 'LB-FT', value: '310', tone: 'text' }]), 'torque in lb-ft: ' + JSON.stringify(r));
ok(Hud.optsFrom(settingsOf({ hudTorqueUnit: 'kgm' })).torqueUnit === 'kgm' && Hud.optsFrom(settingsOf({ hudTorqueUnit: 'x' })).torqueUnit === 'nm',
    'the Torque unit setting reaches the HUD (kgm kept, an unknown value is Nm)');
r = Hud.readoutsFor({ rpm: 3000 }, null, null, null, Object.assign({}, o, { rpm: false, boost: false, torque: false, power: false, oil: false, coolant: false, gearbox: false, outside: false }), { pedal: 101.7, gLat: 0.31, gLong: 0.4 });
ok(r[0] && r[0].value === '100%' && r[1] && r[1].label === 'G' && r[1].value === '0.50', 'throttle clamps to 100 %, g combined: ' + JSON.stringify(r));
r = Hud.readoutsFor({ rpm: 5500, oil: 100, coolant: 90 }, 80, 1.0, { rpm: 5500, cold: false }, o, null);
ok(r.every((it) => typeof it.value === 'string'), 'no extras (null): no crash, no NaN');
ok(!r.some((it) => /NaN|undefined/.test(it.value)), 'no NaN or undefined in a value');
r = Hud.readoutsFor({ rpm: 5500 }, null, null, null, Object.assign({}, o, { rpm: false, boost: false, torque: false, power: false, throttle: false, g: false, oil: false, coolant: false, gearbox: false, fahrenheit: true }), { outside: -5 });
ok(r[0] && r[0].value === '23°' && r[0].tone === 'cold', 'outside in °F, blue near freezing: ' + JSON.stringify(r));
r = Hud.readoutsFor({ rpm: 5500, oil: 96, coolant: 97 }, null, null, null, Object.assign({}, o, { rpm: false, boost: false, torque: false, power: false, throttle: false, g: false, outside: false, gearbox: false, smartTemps: false, fahrenheit: true }), null);
ok(r.some((it) => it.label === 'OIL' && it.value === '205°') && r.some((it) => it.label === 'WATER' && it.value === '207°'), 'oil and water in °F: ' + JSON.stringify(r));
ok(/o\.fahrenheit \? c \* 9 \/ 5 \+ 32/.test(fs.readFileSync(path.join(APP, 'hud.js'), 'utf8')) && !/value: '96°'/.test(fs.readFileSync(path.join(APP, 'hud.js'), 'utf8')), 'test pattern sample: temps follow hudTempUnit');
r = Hud.readoutsFor({ rpm: 5500 }, null, null, null, Object.assign({}, o, { style: 'vfd', boost: false, torque: false, power: false, throttle: false, g: false, outside: false }), {});
ok(!r.some((it) => it.label === 'RPM'), 'the VFD layout has its own rpm digits, no RPM readout');

/* ---------- shift cue ---------- */
function drive(samples, shift, lead) {
    const st = {}, out = [];
    samples.forEach((s) => out.push(Hud.shiftCue(st, s[1], s[0], shift, 6550, lead, s[2])));
    return out;
}
// a steady 1000 rpm/s climb in 3rd from 3800, 20 samples a second
const climb = [];
for (let t = 0; t <= 2500; t += 50) climb.push([t, 3800 + t, 3]);
let c = drive(climb, 5550, 200);
const first = c.findIndex((q) => q.shift);
ok(first > 0 && climb[first][1] >= 5550 - 260 && climb[first][1] <= 5550, 'flashes before the point by about the lead: at ' + (first >= 0 ? climb[first][1] : 'never'));
ok(c.slice(first).every((q) => q.shift), 'the flash holds while the revs keep climbing');
// the upshift ends it
const up = climb.slice(0, first + 5).concat([[climb[first + 5][0] + 50, 4300, 4], [climb[first + 5][0] + 100, 4350, 4]]);
c = drive(up, 5550, 200);
ok(!c[c.length - 1].shift, 'the gear change ends the flash');
// a lift ends it after 300 ms of falling
const lift = climb.slice(0, first + 3), t0 = lift[lift.length - 1][0], r0 = lift[lift.length - 1][1];
for (let i = 1; i <= 10; i++) lift.push([t0 + i * 50, r0 - i * 40, 3]);
c = drive(lift, 5550, 200);
ok(c[first + 4].shift && !c[c.length - 1].shift, 'a short dip keeps it, a lift ends it');
// an upshift with no gear signal: the drop ends it
const nogear = climb.slice(0, first + 3).map((s) => [s[0], s[1], undefined]);
nogear.push([nogear[nogear.length - 1][0] + 50, 4200, undefined]);
c = drive(nogear, 5550, 200);
ok(!c[c.length - 1].shift, 'a 12 % drop ends it without a gear signal');
// the limiter, and no data
c = drive([[0, 6000, 3], [50, 6200, 3], [100, 6400, 3], [150, 6515, 3]], 5550, 200);
ok(c[c.length - 1].limiter && !c[1].limiter, 'limiter within 40 of the redline only');
// the drawn rpm runs ahead of the samples on a climb: it must not light the limiter on its own
{ const st = {}; let q; [[0, 6000], [50, 6200], [100, 6400], [150, 6400]].forEach((s) => { q = Hud.shiftCue(st, s[1], s[0], 6400, 6550, 0, 3, s[1] + 250); });
    ok(!q.limiter, 'a drawn rpm ahead of the real one does not flash the limiter'); }
c = drive([[0, null, 3], [50, undefined, 3]], 5550, 200);
ok(c.every((q) => !q.shift && !q.limiter), 'no rpm: nothing lit');

/* ---------- shift lights as a plain rev bar (setting lightMode "rev", issue #133) ---------- */
{
    // redline 7000, from 4000: an even count, the same whatever the climb rate, the flash only at the redline
    const st = {}, q = [[0, 4000], [50, 5500], [100, 6900], [150, 7000]].map((s) => Hud.shiftCue(st, s[1], s[0], 6000, 7000, 200, 3, s[1], 4000));
    ok(q.every((x) => x.from === 4000 && x.at === 7000), 'rev bar: counts from the start rpm to the redline');
    ok(!q[1].shift && !q[2].shift && q[3].shift, 'rev bar: the flash only at the redline, not at the shift point or early by the lead');
    ok((5500 - q[1].from) / (q[1].at - q[1].from) === 0.5, 'rev bar: half way at 5500 of 4000-7000');
    const slow = Hud.shiftCue({}, 5500, 0, 6000, 7000, 200, 3, 5500, 4000);
    ok(slow.from === q[1].from && slow.at === q[1].at, 'rev bar: no climb rate or lead in the count');
    ok(Hud.shiftCue({}, 5000, 0, 6000, 6000, 0, 3, 5000, 6000).from === 5500, 'rev bar: a start above the redline is kept 500 under it');
    ok(Hud.shiftCue({}, null, 0, 6000, 7000, 0, 3, null, 4000).shift === false, 'rev bar: no rpm, nothing lit');
    const S = (v) => ({ get: (k) => v[k] });
    ok(Hud.revOf(S({ lightMode: 'rev', lightStart: 4500 })) === 4500 && Hud.revOf(S({ lightMode: 'rev' })) === 4000, 'rev bar: the start from lightStart (4000 by default)');
    ok(Hud.revOf(S({})) === null && Hud.revOf(S({ lightMode: 'shift', lightStart: 4500 })) === null, 'shift mode (the default): the count into the shift point as before');
    const defs = {}; spec.settings.forEach((x) => { defs[x.key] = x.default; });
    ok(Hud.optsFrom(S(Object.assign({}, defs, { lightMode: 'rev', lightStart: 3500 }))).rev === 3500 && Hud.optsFrom(S(defs)).rev === null, 'rev bar: the setting reaches the HUD');
}

/* ---------- driving mode (Comfort / Eco Pro) ---------- */
[[1, 'sport'], [2, 'sport'], [3, 'sport'], [4, 'comfort'], [5, 'comfort'], [6, 'comfort'], [7, 'eco'], [9, 'eco'], [10, 'comfort'], [0, null], [63, null],
    [15, 'sport'], [23, 'sport'], [28, 'sport'], [17, 'hybrid'], [18, 'hybrid'], [20, 'hybrid'], [21, 'hybrid'], [22, 'hybrid'],
    ['SPORT_DYNAMIC', 'sport'], ['SPORT_EXPERT', 'sport'], ['ECO_PRO_EFFICIENT', 'eco'], ['COMFORT', 'comfort'], ['ADAPTIVE', 'comfort'],
    ['PHEV_SPORT_STANDARD', 'sport'], ['BOOST', 'sport'], ['PHEV_HYBRID_STANDARD', 'hybrid'], ['PHEV_HYBRID_ECO', 'hybrid'],
    ['PHEV_ELECTRIC_STANDARD', 'hybrid'], [null, null], [undefined, null], ['', null]]
    .forEach((c) => ok(Hud.driveModeOf(c[0]) === c[1], 'driving mode ' + JSON.stringify(c[0]) + ' -> ' + Hud.driveModeOf(c[0]) + ', not ' + c[1]));

/* ---------- a plug-in hybrid's Hybrid / Electric modes: their own setup, once the car is known to be a hybrid ---------- */
{
    const mk = (over) => { const v = Object.assign({ hudComfortMode: 'hide', hudHybridMode: 'same', hudStyle: 'arc', hudComfortSetup: {}, hudHybridSetup: {} }, over || {});
        return { v: v, get: (k) => v[k], set: (k, x) => { v[k] = x; } }; };
    const pet = mk(), phev = mk({ hudHybridSeen: true });
    ok(Hud.profileOf('hybrid', pet) === 'comfort' && Hud.profileOf('hybrid', phev) === 'hybrid' && Hud.profileOf('hybrid') === 'comfort',
        'hybrid modes: Comfort\'s setup until the car is known to be a hybrid, then their own');
    ok(Hud.profileOf('comfort', phev) === 'comfort' && Hud.profileOf('sport', phev) === 'sport' && Hud.profileOf('eco', phev) === 'comfort', 'the other modes keep their setups on a hybrid');
    // defaults: Comfort hidden (main), Hybrid follows Sport
    ok(Hud.calmFor('hybrid', Hud.setupMode(phev, Hud.profileOf('hybrid', phev))) === 'all' && Hud.calmFor('hybrid', Hud.setupMode(pet, Hud.profileOf('hybrid', pet))) === 'hide',
        'by default a hybrid shows Redline in its Hybrid mode (Same as Sport); before it is known, hidden as Comfort');
    ok(Hud.optsFrom(phev, 'hybrid').style === 'arc', 'Hybrid, same as Sport: Sport\'s layout');
    // its own setup: starts as Sport's, changed apart from Sport and Comfort
    Hud.profileView(phev, 'hybrid').set('hudStyle', 'ramp');
    ok(phev.v.hudHybridMode === 'own' && phev.v.hudHybridSetup.hudStyle === 'ramp' && phev.v.hudStyle === 'arc' && Object.keys(phev.v.hudComfortSetup).length === 0,
        'a change on the Hybrid tab gives Hybrid its own setup, Sport and Comfort untouched');
    ok(Hud.optsFrom(phev, 'hybrid').style === 'ramp' && Hud.optsFrom(phev, 'sport').style === 'arc' && Hud.optsFrom(phev, 'comfort').style === 'arc', 'each mode draws its own setup');
    Hud.setSetupMode(phev, 'hybrid', 'hide');
    ok(Hud.calmFor('hybrid', Hud.setupMode(phev, 'hybrid')) === 'hide' && Hud.profileView(phev, 'hybrid').get('hudStyle') === 'ramp', "Hybrid on Don't show: hidden, its setup kept");
    const fresh = mk({ hudHybridSeen: true });
    Hud.setSetupMode(fresh, 'hybrid', 'own');
    ok(fresh.v.hudHybridSetup.hudStyle === 'arc', 'Hybrid made its own: starts as a copy of Sport');
}
ok(Hud.calmFor('sport', 'hide') === 'all' && Hud.calmFor(null, 'hide') === 'all', 'Sport and an unknown mode show everything');
ok(Hud.calmFor('comfort', 'hide') === 'hide' && Hud.calmFor('eco', 'hide') === 'hide' && Hud.calmFor('comfort', 'own') === 'all' && Hud.calmFor('comfort', undefined) === 'all', 'Comfort / Eco Pro: hidden only when set so');

/* ---------- the Sport / Comfort profiles ---------- */
{
    // this fork's In Comfort / Eco Pro is Don't show by default (Cluster functions' HUD outside Sport): the profile
    // checks below start from Same as Sport, the OG default
    ok(declared.hudComfortMode.default === 'hide' && declared.hudHandBack.default === true, 'this fork: Redline only in Sport, hand-back on');
    const store = (over) => { const v = Object.assign({}, over); return { values: v, get: (k) => (k in v ? v[k] : k === 'hudComfortMode' ? 'same' : declared[k] ? declared[k].default : undefined), set: (k, x) => { v[k] = x; } }; };
    // Sport is the settings themselves; Comfort follows it until it is changed
    let st = store({ hudStyle: 'arc', hudShowTorque: true });
    let sp = Hud.profileView(st, 'sport'), cf = Hud.profileView(st, 'comfort');
    ok(Hud.optsFrom(cf).style === 'arc' && Hud.optsFrom(st, 'comfort').style === 'arc' && Hud.comfortMode(st) === 'same', 'profiles: Comfort follows Sport by default');
    // a Comfort edit gives it its own copy (Sport's values), and changes only Comfort
    cf.set('hudStyle', 'dial');
    ok(Hud.comfortMode(st) === 'own' && Hud.optsFrom(cf).style === 'dial' && Hud.optsFrom(sp).style === 'arc', 'profiles: a Comfort edit makes it its own; Sport keeps its layout');
    ok(Hud.optsFrom(cf).torque === true, 'profiles: Comfort own starts as a copy of Sport (torque readout kept)');
    sp.set('hudShowTorque', false);
    ok(Hud.optsFrom(cf).torque === true && Hud.optsFrom(sp).torque === false, 'profiles: after that, Sport changes stay in Sport');
    // shared keys (units, light colours) are one for both, whichever profile changes them
    cf.set('hudTempUnit', 'f');
    ok(st.get('hudTempUnit') === 'f' && !('hudTempUnit' in st.get('hudComfortSetup')), 'profiles: units are shared');
    // size and place are each setup's own (2026-11-10: a small HUD in a corner for Comfort)
    cf.set('hudSize', 70); cf.set('hudX', 120); cf.set('hudY', 40);
    const pc = Hud.placeOf(cf), ps = Hud.placeOf(sp);
    ok(st.get('hudComfortSetup').hudSize === 70 && pc.w === 280 && pc.x > ps.x && pc.y > ps.y && ps.w === 400, 'profiles: Comfort\'s own size and place (' + JSON.stringify(pc) + '), Sport\'s kept (' + JSON.stringify(ps) + ')');
    // the driving mode picks the profile; Sport+ and an unknown mode use Sport
    ok(Hud.optsFrom(st, 'comfort').style === 'dial' && Hud.optsFrom(st, 'eco').style === 'dial' && Hud.optsFrom(st, 'sport').style === 'arc' && Hud.profileOf(null) === 'sport', 'profiles: the mode picks one');
    // Same as Sport again: Comfort's setup is kept (back with Its own), Sport shows
    Hud.setComfortMode(st, 'same');
    ok(Hud.optsFrom(st, 'comfort').style === 'arc', 'profiles: Same as Sport');
    Hud.setComfortMode(st, 'own');
    ok(Hud.optsFrom(st, 'comfort').style === 'dial', 'profiles: Its own again: its setup kept');
    // Its own from Settings with no setup yet: a copy of Sport's
    st = store({ hudStyle: 'ramp' }); Hud.setComfortMode(st, 'own');
    ok(Hud.optsFrom(st, 'comfort').style === 'ramp' && st.get('hudComfortSetup').hudStyle === 'ramp', 'profiles: Its own starts as Sport');
    // 1.14 / 1.15's "In Comfort": hide stays hidden; lights + gear becomes its own setup with no readouts; once
    st = store({ hudComfort: 'hide' });
    ok(Hud.migrateProfiles(st) === 'hide' && Hud.comfortMode(st) === 'hide' && Hud.migrateProfiles(st) === null, 'migration: hide, once');
    st = store({ hudComfort: 'lights', hudStyle: 'wings', hudShowOil: true, hudChip: 'burst' });
    const m = Hud.migrateProfiles(st), co = Hud.optsFrom(st, 'comfort');
    ok(m === 'lights' && Hud.comfortMode(st) === 'own' && co.style === 'wings' && !co.oil && !co.rpm && co.chip === 'off' && co.lights && co.gear, 'migration: lights + gear becomes Comfort without readouts');
    ok(Hud.optsFrom(st, 'sport').oil === true, 'migration: Sport untouched');
    st = store({});
    ok(Hud.migrateProfiles(st) === 'none' && Hud.comfortMode(st) === 'same', 'migration: nothing set, nothing changes');
}
{
    const c = Hud.calmOpts(Object.assign({}, optsDefault, { torque: true, g: true }));
    ok(c.lights && c.bar && c.gear && !c.rpm && !c.oil && !c.torque && !c.g && c.chip === 'off' && !c.peak, 'lights + gear only: readouts, grade and peak off');
    ok(Hud.readoutsFor({ rpm: 5000, oil: 30, coolant: 30 }, 30, 1.2, { rpm: 4000, cold: true }, c, { torque: 300 }).length === 0, 'lights + gear only: no readouts, not even cold temps');
}

/* ---------- RPM readout format, refresh, clearer labels ---------- */
ok(Hud.rpmItem(4537, '10').value === '4540' && Hud.rpmItem(4537, '50').value === '4550' && Hud.rpmItem(4537, 'k').value === '4.5', 'rpm to 10, to 50, in thousands');
ok(Hud.rpmItem(-20, 'k').value === '0.0' && Hud.rpmItem(6960, 'k').value === '7.0', 'thousands: clamped, rounded');
ok(optsDefault.rpmFormat === '10' && optsDefault.readoutMs === 250 && !optsDefault.clearLabels, 'defaults: to 10, 4 a second, normal labels');
{ const o = Hud.optsFrom(settingsOf({ hudRpmFormat: 'k', hudReadoutRate: 10, hudLabels: 'clear' }));
    ok(o.rpmFormat === 'k' && o.readoutMs === 100 && o.clearLabels, 'thousands, 10 a second, clearer labels');
    ok(Hud.readoutsFor({ rpm: 3260 }, null, null, null, Object.assign({}, optsDefault, o, { boost: false, oil: false, coolant: false, gearbox: false }), {})[0].value === '3.3', 'readouts row uses the format'); }

/* ---------- shift light colours follow the app's "Shift light style" ---------- */
{
    const P = Draw.PALETTES.colour, at = (st, n) => Array.from({ length: n }, (_, i) => Draw.lightCol(st, P, i / (n - 1)));
    const m = at('m', 12), f1 = at('f1', 12);
    ok(m[0] === P.low && m.indexOf(P.mid) > 0 && m[11] === P.high, 'M: green, yellow, red');
    ok(f1[0] === P.low && f1.indexOf(P.mid) < 0 && f1[6] === P.high && f1[11] !== P.high && f1[11] !== P.low, 'Race: green, red, blue (no yellow)');
    ok(at('f1', 6).slice(0, 5).indexOf(P.high) > 0, 'Race on 6 GT3 steps: red before the flash');
    ok(at('mono', 12).every((c) => c === P.text), 'Theme colour: one colour');
}

/* ---------- the demo drive ---------- */
for (let t = 0; t < Hud.DEMO_MS * 3; t += 37) {
    const d = Hud.demoAt(t);
    if (!(d.rpm >= 0 && d.rpm <= 8000 && d.gear >= 1 && d.gear <= 8 && d.pedal >= 0 && d.pedal <= 100)) { ok(false, 'demo out of range at ' + t + ': ' + JSON.stringify(d)); break; }
}

/* ---------- one helper writes the learned files whole (files.js writeAtomic), no copies of it ---------- */
{
    const { writeAtomic } = require(path.join(APP, 'files'));
    const os = require('os'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-files-')), f = path.join(dir, 'x.json');
    writeAtomic(f, '{"a":1}');
    ok(fs.readFileSync(f, 'utf8') === '{"a":1}' && !fs.existsSync(f + '.tmp'), 'writeAtomic: the file written, no temp file left');
    const said = [];
    writeAtomic(path.join(dir, 'no', 'y.json'), 'x', { warn: (m) => said.push(m) }, 'limiter save');
    ok(said.length === 1 && /^limiter save: /.test(said[0]), 'writeAtomic: a failure logged, not thrown (' + said[0] + ')');
    fs.unlinkSync(f); fs.rmdirSync(dir);
    fs.readdirSync(APP).filter((n) => /\.js$/.test(n) && n !== 'files.js').forEach((n) => {
        const s = fs.readFileSync(path.join(APP, n), 'utf8');
        ok(!/writeFileSync\([^;]*\.tmp/.test(s) && !/function writeAtomic/.test(s), n + ': its own temp-file write (use files.js writeAtomic)');
    });
}

/* ---------- the HUD looks page has every HUD setting (Settings shows them only with "All HUD options here") ---------- */
{
    const main = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');
    const page = main.slice(main.indexOf('function drawLooks('), main.indexOf('function cycleRow('));
    const onPage = {};
    page.replace(/'([a-zA-Z]+)'/g, (m, k) => { onPage[k] = true; return m; });
    spec.settings.filter((s) => /^HUD: /.test(s.group || '') || s.key === 'hudStyle').forEach((s) => ok(onPage[s.key], 'setting ' + s.key + ' (' + s.group + ') is not on the HUD looks page'));
    // and Settings' top level is short: the HUD's details are behind "All HUD options here"
    // (a row only some cars get, as In Hybrid / Electric on a plug-in hybrid, isn't counted)
    const top = spec.settings.filter((s) => !s.group && !s.hidden && !(s.when && (s.when.hudHybridSeen || s.when.hudTyresSeen)));
    ok(top.length <= 6, 'Settings top level has ' + top.length + ' rows besides the groups: ' + top.map((s) => s.key).join(', '));
    spec.settings.filter((s) => /^HUD: /.test(s.group || '')).forEach((s) => ok(s.when && s.when.hudAll && s.when.hudAll[0] === true, s.key + ' shows in Settings without "All HUD options here"'));
}

/* ---------- 1.16: M layouts, gear font, placement, the reaction time, the test pattern ---------- */
{
    // the M layouts: every chip moment, the flash and the limiter, 0 to 4 readouts, clearer labels, both layers
    const items = [{ label: 'BOOST', value: '1.4', tone: 'text' }, { label: 'OIL', value: '104°', tone: 'hot' }, { label: 'WATER', value: '62°', tone: 'cold' }, { label: 'HP', value: '312', tone: 'text' }];
    Hud.M_STYLES.forEach((style) => [0, 150, 400, 1000, 1400].forEach((age) => [0, 1, 4].forEach((n) => [false, true].forEach((cl) => ['m', 'f1', 'mono'].forEach((ls) => {
        const o = Object.assign({}, optsDefault, { style: style, clearLabels: cl, lightStyle: ls, gearFont: 'gear_barlow' });
        ['bg', 'fg', 'both'].forEach((layer) => {
            const cv = new Canvas(Draw.IW, Draw.IH);
            try { Draw.drawLayer(cv, frame(o, { readouts: items.slice(0, n), chip: age ? { verdict: 'SPOT ON', age: age, burst: true } : null, cue: { from: 4050, at: 5550, shift: age === 400, limiter: age === 1000 } }), layer); }
            catch (e) { ok(false, style + ' age ' + age + ' readouts ' + n + ' ' + layer + ' threw: ' + e.message); }
        });
    })))));
    // the static layer of an M layout doesn't change with the rpm (it is cached by bgKey, which has no rpm)
    Hud.M_STYLES.forEach((style) => {
        const o = Object.assign({}, optsDefault, { style: style }), a = new Canvas(Draw.IW, Draw.IH), b = new Canvas(Draw.IW, Draw.IH);
        Draw.drawLayer(a, frame(o, { d: { rpm: 2000, gear: 2 }, cue: { from: 3000, at: 4000, shift: false, limiter: false } }), 'bg');
        Draw.drawLayer(b, frame(o, { d: { rpm: 6000, gear: 4 }, cue: { from: 5000, at: 6000, shift: false, limiter: false } }), 'bg');
        ok(Buffer.compare(Buffer.from(a.d), Buffer.from(b.d)) === 0, style + ': the static layer depends on something bgKey lacks');
    });
    // the Arc's right column: no label runs into its value, at either label size (the longest ones). The row is
    // drawn whole and with the value alone: the label is what the whole has and the value alone hasn't, and its
    // last column must be left of the value's first
    {
        const pairs = [['GEARBOX', '120°'], ['THROTTLE', '100%'], ['OUTSIDE', '-10°']];
        const draw = (cl, it) => {
            const o = Object.assign({}, optsDefault, { style: 'arc', clearLabels: cl }), cv = new Canvas(Draw.IW, Draw.IH);
            Draw.drawLayer(cv, frame(o, { chip: null, down: 0, mode: null, readouts: [{ label: '', value: '', tone: 'text' }, it] }), 'fg');
            return (x, y) => cv.d[(y * Draw.IW + x) * 4 + 3] > 40;
        };
        [false, true].forEach((cl) => pairs.forEach((p) => {
            const whole = draw(cl, { label: p[0], value: p[1], tone: 'text' }), alone = draw(cl, { label: '', value: p[1], tone: 'text' });
            let labEnd = -1, valStart = -1;
            for (let x = 300; x < Draw.IW; x++) for (let y = 88; y <= 107; y++) {
                if (alone(x, y) && valStart < 0) valStart = x;
                if (whole(x, y) && !alone(x, y)) labEnd = x;
            }
            ok(labEnd >= 0 && valStart >= 0 && labEnd < valStart, 'arc: ' + p[0] + ' ' + p[1] + (cl ? ' (clearer)' : '') + ' label reaches x ' + labEnd + ', value starts at ' + valStart);
        }));
    }
    // downshift arrows, "Best gear": the fewest drops into the power band (90 % of peak power on the curve)
    {
        const SM = require(path.join(APP, 'shiftmap'));
        const curve = [[2000, 300], [3000, 400], [4000, 400], [5000, 380], [6000, 330], [6500, 300]];   // power peaks ~6000
        const band = SM.prototype.bandStart.call({ curve: () => curve }, 0.9);
        ok(band === 5000, 'power band starts at 5000 on a curve peaking near 6000 (' + band + ')');
        ok(SM.prototype.bandStart.call({ curve: () => curve.slice(0, 3) }, 0.9) === null, 'no band from a short curve');
        const k = { 3: 35, 4: 27, 5: 22, 6: 18.5 }, rin = (g) => 150 * (k[g] || 0);      // 150 km/h: 6th 2775, 5th 3300, 4th 4050, 3rd 5250
        ok(SM.bestDrop(6, 3, rin, band) === 3 && SM.bestDrop(6, 2, rin, band) === 2, 'best: down to 3rd (5250, in the band); never past what is allowed');
        ok(SM.bestDrop(6, 3, rin, 2500) === 0 && SM.bestDrop(6, 3, rin, null) === 3 && SM.bestDrop(6, 0, rin, band) === 0, 'best: none when already in the band; all allowed without a band; none allowed');
    }
    // the knock warning shows on every layout (Minimal and Split wings, which show no grades: the gear goes red)
    LAYOUTS.forEach((style) => {
        const o = Object.assign({}, optsDefault, { style: style }), pic = (chip) => { const cv = new Canvas(Draw.IW, Draw.IH); Draw.drawLayer(cv, frame(o, { chip: chip, readouts: [] }), 'fg'); return Buffer.from(cv.d); };
        ok(Buffer.compare(pic(null), pic({ verdict: 'KNOCK', age: 800, burst: true })) !== 0, style + ': KNOCK changes nothing');
    });
    // the launch score: standing starts timed by the kit's run timer, against the best (kept in a file)
    {
        const LaunchScore = require(path.join(APP, 'launch'));
        const os = require('os'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-launch-'));
        const quiet = { info() {}, warn() {} };
        let clock = 1e6;
        const realNow = Date.now; Date.now = () => clock;
        // stand 2 s, then a constant pull reaching 100 km/h in `secs`, on to 130, then slow down
        const run = (ls, secs) => {
            for (let t = 0; t <= 2000; t += 100) { clock += 100; ls.feed(clock, 0); ls.idle(clock); }
            const a = 100 / secs;
            for (let t = 50; t <= (130 / a) * 1000; t += 50) { clock += 50; ls.feed(clock, a * t / 1000); }
            for (let v = 130; v >= 90; v -= 5) { clock += 100; ls.feed(clock, v); }
        };
        let ls = new LaunchScore({ dataDir: dir, log: quiet });
        run(ls, 5.0);
        let l = ls.last(clock, false);
        ok(l && Math.abs(l.secs - 5.0) < 0.06 && l.delta === null && l.best && l.label === '0-100', 'launch: first run 0-100 in ~5.0 s, a best (' + JSON.stringify(l) + ')');
        run(ls, 4.8);
        l = ls.last(clock, false);
        ok(l && l.best && l.delta < -0.1 && l.delta > -0.3, 'launch: quicker run, a new best, its difference negative (' + (l && l.delta) + ')');
        run(ls, 5.4);
        l = ls.last(clock, false);
        ok(l && !l.best && l.delta > 0.4, 'launch: slower run, not a best (' + (l && l.delta) + ')');
        const m = ls.last(clock, true);
        ok(m && m.label === '0-60' && m.secs < l.secs, 'launch: the 0-60 mph time too');
        clock += 3100;
        ok(ls.last(clock, false) === null, 'launch: shown for 3 s');
        // the best is kept across a restart, and forgotten on reset
        ls = new LaunchScore({ dataDir: dir, log: quiet });
        ok(Math.abs(ls.bestOf(false) - 4.8) < 0.06, 'launch: best kept in the file (' + ls.bestOf(false) + ')');
        ls.forget();
        ok(ls.bestOf(false) === null && new LaunchScore({ dataDir: dir, log: quiet }).bestOf(false) === null, 'launch: Reset forgets it');
        Date.now = realNow;
    }
    // gear font: Auto is Barlow on Arc and Dial, the squared digits on Ramp (2.0.21); a missing atlas falls back to Ubuntu
    ok(Hud.gearFontOf('auto', 'arc') === 'gear_barlow' && Hud.gearFontOf('auto', 'standard') === 'gear' && Hud.gearFontOf(undefined, 'dial') === 'gear_barlow' && Hud.gearFontOf('auto', 'ramp') === 'square', 'gear font: Auto');
    ok(Hud.gearFontOf('ubuntu', 'ramp') === 'gear' && Hud.gearFontOf('barlow', 'wings') === 'gear_barlow', 'gear font: chosen');
    ok(Hud.optsFrom(settingsOf({ hudStyle: 'ramp' })).gearFont === 'square' && Hud.optsFrom(settingsOf({ hudStyle: 'arc' })).gearFont === 'gear_barlow' && Hud.optsFrom(settingsOf({ hudStyle: 'bogus' })).style === 'standard', 'optsFrom: M styles kept, unknown ones standard');
    ok(Draw.gearFont({ gearFont: 'gear_barlow' }) === 'gear_barlow' && Draw.gearFont({ gearFont: 'no_such_font' }) === 'gear' && Draw.gearFont({}) === 'gear', 'gear font falls back to Ubuntu');
    // Ramp (2.0.21, after a video of the G80's HUD): 8 slanted bars over the flat part, hidden below the count-in,
    // lit left to right (6 yellow, then red), all red at the shift
    {
        const ro = Hud.optsFrom(settingsOf({ hudStyle: 'ramp' }));
        const bar = (rpm, shift, blink) => {
            const cv = new Canvas(Draw.IW, Draw.IH);
            Draw.drawLayer(cv, { d: { rpm: rpm, gear: 3, stage: 'M' }, shift: 6400, redline: 6800, max: 8000, blink: blink !== false,
                cue: { from: 4800, at: 6400, shift: !!shift, limiter: false }, down: 0, peak: 0, chip: null, readouts: [], mode: null, opts: ro }, 'fg');
            // each bar's middle: x from 121 to 372, the last twice as wide; y 11
            const unit = (372 - 121 - 10 - 7 * 3) / 9, out = [];
            for (let i = 0, x = 121; i < 8; i++) { const w = i === 7 ? 2 * unit : unit; const px = Math.round(x + w / 2 + 5), o = (11 * cv.w + px) * 4;
                out.push(cv.d[o + 3] < 128 ? '.' : cv.d[o] > 200 && cv.d[o + 1] < 120 ? 'R' : cv.d[o] > 200 && cv.d[o + 1] > 180 && cv.d[o + 2] < 140 ? 'Y' : '?'); x += w + 3; }
            return out.join('');
        };
        ok(bar(3000) === '........', 'ramp: no bars below the count-in (' + bar(3000) + ')');
        const steps = [4900, 5300, 5700, 6000, 6200, 6400].map((r) => bar(r));
        ok(steps.every((b, i) => i === 0 || b.replace(/./g, '').length >= steps[i - 1].replace(/./g, '').length) && /^Y+.+$/.test(steps[0]),
            'ramp: the bars count in left to right (' + steps.join(' ') + ')');
        ok(bar(6400) === 'YYYYYYRR', 'ramp: 6 yellow then 2 red at the shift point (' + bar(6400) + ')');
        ok(bar(6500, true, true) === 'RRRRRRRR' && bar(6500, true, false) === '........', 'ramp: all red at the shift, flashing (' + bar(6500, true, true) + ' / ' + bar(6500, true, false) + ')');
        const noLights = Object.assign({}, ro, { lights: false }), cv = new Canvas(Draw.IW, Draw.IH);
        Draw.drawLayer(cv, { d: { rpm: 6400, gear: 3, stage: 'M' }, shift: 6400, redline: 6800, max: 8000, blink: true, cue: { from: 4800, at: 6400, shift: false, limiter: false }, down: 0, peak: 0, chip: null, readouts: [], mode: null, opts: noLights }, 'fg');
        let any = 0; for (let y = 2; y < 20; y++) for (let x = 121; x < 372; x++) if (cv.d[(y * cv.w + x) * 4 + 3] > 128) any++;
        ok(any === 0, 'ramp: HUD lights Off hides the bars');
    }
    // Ramp's needle (2.0.35): the band's curve at every rpm, always one piece and visible (2x, round each mark)
    {
        const ro = Object.assign({}, Hud.optsFrom(settingsOf({ hudStyle: 'ramp' })), { lights: false });
        const K = 2, W = Draw.IW * K, H = Draw.IH * K, bad = [];
        const isRed = (d, i) => d[i + 3] > 200 && d[i] > 200 && d[i + 1] < 110 && d[i + 2] < 110;
        for (let mark = 1000; mark <= 6000; mark += 1000) for (let rpm = mark - 120; rpm <= mark + 120; rpm += 8) {
            const cv = new Canvas(W, H);
            // (the redline at the scale's end: no red zone line in the live layer to count)
            Draw.drawLayer(Draw.scaled(cv, K, 0, 0), { d: { rpm: rpm, gear: 3, stage: 'M' }, shift: 6400, redline: 8000, max: 8000, blink: true,
                cue: { from: 9000, at: 9500, shift: false, limiter: false }, down: 0, peak: 0, chip: null, readouts: [], mode: null, opts: ro }, 'fg');
            const red = new Uint8Array(W * H); let first = -1, count = 0;
            for (let i = 0; i < W * H; i++) if (isRed(cv.d, i * 4)) { red[i] = 1; count++; if (first < 0) first = i; }
            if (!count) { bad.push(rpm + ' none'); continue; }
            // pieces: 8-connected, a speck under 2 px (an anti-aliased corner pixel) not counted
            const seen = new Uint8Array(W * H); let blobs = 0;
            for (let i = 0; i < W * H; i++) if (red[i] && !seen[i]) {
                const st = [i]; seen[i] = 1; let got = 0;
                while (st.length) {
                    const p = st.pop(), x = p % W, y = (p / W) | 0; got++;
                    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy, k = ny * W + nx; if (nx >= 0 && nx < W && ny >= 0 && ny < H && red[k] && !seen[k]) { seen[k] = 1; st.push(k); } }
                }
                if (got >= 2) blobs++;
            }
            if (blobs !== 1) bad.push(rpm + (blobs ? ' ' + blobs + ' pieces' : ' none'));
        }
        ok(bad.length === 0, 'ramp: the needle is one visible piece either side of every mark (wrong at: ' + bad.slice(0, 8).join(', ') + ')');
    }
    // 2.0.39 (issue #91 feedback): the HUD looks page's preview is drawn on the screen's recorder, which had no fill(),
    // so Ramp's rail and band came out black. Recorded and played back (the PNG fallback) it matches the glass, and
    // the gear's foot is level with the 0's in every gear font, the line and the readout under it
    {
        const R = require(path.join(ROOT, 'kit', 'runtime', 'record'));
        const K = 2, W = Draw.IW * K, H = Draw.IH * K;
        const frame = (font) => ({ d: { rpm: 5200, gear: 1, stage: 'M' }, shift: 6400, redline: 6800, max: 8000, blink: true,
            cue: { from: 4800, at: 6400, shift: false, limiter: false }, down: 0, peak: 0, chip: null, readouts: [{ label: 'km/h', value: '42', tone: 'text' }], mode: 'M',
            opts: Hud.optsFrom(settingsOf({ hudStyle: 'ramp', hudGearFont: font })) });
        const rec = new R.Recorder(W, H), a = new Canvas(W, H), b = new Canvas(W, H);
        Draw.drawLayer(Draw.scaled(rec, K, 0, 0), frame('auto')); R.play(rec.words(), a);
        Draw.drawLayer(Draw.scaled(b, K, 0, 0), frame('auto'));
        let diff = 0, lit = 0;
        for (let i = 0; i < a.d.length; i++) diff = Math.max(diff, Math.abs(a.d[i] - b.d[i]));
        for (let y = 45 * K; y < 60 * K; y++) for (let x = 250 * K; x < 300 * K; x++) if (a.d[(y * W + x) * 4 + 3] > 128) lit++;
        ok(diff <= 2 && lit > 100, 'ramp preview: the recorder draws the rail and band as the glass does (max diff ' + diff + ', rail px ' + lit + ')');
        ok(R.stripTris && R.triangulate([[0, 0], [10, 0], [10, 10], [5, 3], [0, 10]]).length === 3, 'recorder: a concave polygon cut into 3 triangles');
        // the lowest lit row in a column range of one layer drawn at 1x
        const foot = (font, x0, x1, y0, y1) => {
            const cv = new Canvas(Draw.IW, Draw.IH); Draw.drawLayer(cv, frame(font));
            let low = -1; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (cv.d[(y * cv.w + x) * 4 + 3] > 128) low = y;
            return low;
        };
        // the line only parts the gear from a readout: Gear off, or nothing under the gear, leaves no line
        const lineAt = (gear, ro) => {
            const fr = frame('auto'); fr.opts = Object.assign({}, fr.opts, { gear: gear }); fr.readouts = ro;
            const cv = new Canvas(Draw.IW, Draw.IH); Draw.drawLayer(cv, fr);
            let n = 0; for (let x = 66; x < 92; x++) if (cv.d[(95 * cv.w + x) * 4 + 3] > 128) n++;
            return n;
        };
        const kmh = [{ label: 'km/h', value: '42', tone: 'text' }];
        ok(lineAt(true, kmh) > 20 && lineAt(false, kmh) === 0 && lineAt(true, []) === 0,
            'ramp: the line under the gear only with a gear and a readout (' + [lineAt(true, kmh), lineAt(false, kmh), lineAt(true, [])].join(' / ') + ')');
        const zero = foot('auto', 30, 46, 70, 100);
        ['auto', 'ubuntu', 'barlow'].forEach((font) => {
            const g = foot(font, 100, 126, 50, 94), line = foot(font, 70, 90, 91, 100);
            ok(Math.abs(g - zero) <= 1 && line - g >= 3, 'ramp: gear in ' + font + ' ends level with the 0 (' + g + ' / ' + zero + '), clear of the line (' + line + ')');
        });
    }
    // placement and the windshield's window
    const at = (o) => Hud.placeOf(settingsOf(o));
    ok(JSON.stringify(at({})) === JSON.stringify({ x: 200, y: 140, w: 400, h: 130 }) && Object.keys(Hud.outsideGlass(at({}))).length === 0, 'place: default fully on the glass');
    ok(Hud.outsideGlass(at({ hudSize: 140 })).right === 75 && Hud.outsideGlass(at({ hudY: -60 })).top === 20, 'place: off the glass, per side');
    // 2.0.27: smaller, further right and further down (a small tach in the glass's bottom right corner)
    ok(JSON.stringify(at({ hudSize: 40, hudX: 280, hudY: 220 })) === JSON.stringify({ x: 600, y: 360, w: 160, h: 52 }) && at({ hudSize: 30, hudX: 400, hudY: 400 }).w === 160 && at({ hudSize: 30, hudX: 400, hudY: 400 }).x === 600,
        'place: down to 40 %, right to +280, down to +220 (and no further)');
    // Minimal's dots can go up over BMW's own ramp (2026-11-10, an X3 M40i): Up reaches -120, and the empty top of its
    // picture isn't counted as off the glass
    ok(at({ hudY: -120 }).y === 20 && Hud.outsideGlass(at({ hudY: -60 }), 'minimal').top === 11 && Hud.outsideGlass(at({ hudY: -40 }), 'minimal').top === undefined, 'place: Minimal up to -120, only its empty top (above the D / S / M letter) not counted off the glass');
    // reaction time: a slow climb takes the lead as asked; a fast one only the 800 rpm it really had
    ok(Hud.reactionMs({ rate: 1000, target: 6000, lead: 300 }, 6000) === 300, 'reaction: on time at 1000 rpm/s');
    ok(Hud.reactionMs({ rate: 4000, target: 6000, lead: 300 }, 6000) === 200 && Hud.reactionMs({ rate: 4000, target: 6000, lead: 300 }, 6200) === 250, 'reaction: capped lead on a fast climb');
    ok(Hud.reactionMs({ rate: 4000, target: 6000, lead: 300 }, 5000) === 0 && Hud.reactionMs({ rate: 500, target: 6000, lead: 300 }, 6500) === 600, 'reaction: clamped 0..600');
    // the test pattern at another size: the tach is blended over it (dim parts stay dim, empty stays empty)
    const cv = new Canvas(600, 300), bgc = [40, 40, 40, 255];
    cv.clear(bgc);
    Draw.drawLayer(Draw.scaled(cv, 1.2, 10, 10), frame(Object.assign({}, optsDefault, { dim: true }), { d: { rpm: 3000, gear: 3 }, chip: null, readouts: [], peak: 0, down: 0, cue: { from: 4400, at: 6200, shift: false, limiter: false } }));
    const px = (x, y) => Array.from(cv.d.slice((y * 600 + x) * 4, (y * 600 + x) * 4 + 4));
    const dim = px(10 + Math.round(390 * 1.2), 10 + Math.round(9 * 1.2)), empty = px(10 + Math.round(120 * 1.2), 10 + Math.round(110 * 1.2));
    ok(JSON.stringify(empty) === JSON.stringify(bgc) && dim[0] < 120 && dim[1] < 120 && dim[3] === 255 && (dim[0] !== 40 || dim[1] !== 40), 'test pattern: scaled tach blends (dim ' + dim + ', empty ' + empty + ')');
    // the gearbox: a temperature the gearbox stopped giving is not served as fresh
    const GearboxTemp = require(path.join(APP, 'gearbox'));
    const g = new GearboxTemp({ log: { info() {}, warn() {} } }), replies = [70, null, null];
    g.rd = { value: () => Promise.resolve(replies.length ? replies.shift() : null), raws: {}, key: () => '', pick: {} };
    const realNow = Date.now; let now = 1e6; Date.now = () => now;
    const poll = () => { g.busy = false; g._poll(); return new Promise((res) => setImmediate(res)); };
    poll().then(() => { ok(g.value() === 70, 'gearbox: a fresh reading is served');
        now += 15000; return poll(); }).then(() => { now += 6000; return poll(); }).then(() => {
        ok(g.value() !== 70, 'gearbox: 21 s after its last reading (two failed polls since) the old 70 is not served');
        Date.now = realNow;
        return electricalChecks();
    }).then(() => {
        console.log(tally.fails ? tally.fails + ' of ' + tally.checks + ' Redline HUD checks failed' : 'Redline HUD checks passed (' + tally.checks + ').');
        process.exit(tally.fails ? 1 : 0);
    }).catch((e) => { console.log('FAIL electrical checks threw: ' + (e && e.stack || e)); process.exit(1); });
}

/* ---------- 2.0: the electrical readouts (12 V on every car, the hybrid battery only on a hybrid) ---------- */
// x as electrical.js gives it on a plug-in hybrid
const EX = { soc12: 82, v12: 14.23, hvSoc: 64.4, hvKw: -18.4, hvTemp: 27, hvVolt: 352.4 };
const ALL_ON = { hudShowRpm: false, hudBoost: false, hudShowOil: false, hudShowWater: false, hudShowGearbox: false, hudShowLimit: false,
    hudShowBattSoc: true, hudShowBattVolt: true, hudShowHvSoc: true, hudShowHvPower: true, hudShowHvTemp: true, hudShowHvVolt: true };
const labels = (items) => items.map((r) => r.label).join(',');
{
    // off by default, on every car
    ['soc12', 'volt12', 'hvSoc', 'hvPower', 'hvTemp', 'hvVolt'].forEach((k) => ok(optsDefault[k] === false, 'defaults: ' + k + ' readout is off'));
    // a petrol / diesel car: every switch on, hybrid values even arriving - only the 12 V shows
    const petrol = Hud.optsFrom(settingsOf(ALL_ON));
    ok(!petrol.hvSoc && !petrol.hvPower && !petrol.hvTemp && !petrol.hvVolt && petrol.soc12 && petrol.volt12, 'petrol car: hybrid switches stay off without hudHybridSeen');
    const it = Hud.electricalItems(petrol, EX);
    ok(labels(it) === '12V CHARGE,12V', 'petrol car: only the 12 V readouts (' + labels(it) + ')');
    ok(labels(Hud.readoutsFor({ rpm: 3000 }, null, null, { rpm: 6000, cold: false }, petrol, EX)) === '12V CHARGE,12V', 'petrol car: readouts row has no hybrid item');
    ok(Hud.electricalWants(petrol).hv === false && Hud.electricalWants(petrol).v12 === true, 'petrol car: no hybrid battery reads asked for');
    // a hybrid: every one, in order, formatted
    const hy = Hud.optsFrom(settingsOf(Object.assign({ hudHybridSeen: true }, ALL_ON)));
    const all = Hud.electricalItems(hy, EX);
    ok(labels(all) === '12V CHARGE,12V,HV CHARGE,HV KW,HV TEMP,HV VOLTS', 'hybrid: every electrical readout in order (' + labels(all) + ')');
    ok(all.map((r) => r.value).join(' ') === '82% 14.2 64% -18 27° 352', 'hybrid: values (' + all.map((r) => r.value).join(' ') + ')');
    ok(Hud.electricalItems(hy, Object.assign({}, EX, { hvKw: 41.6 }))[3].value === '+42', 'hybrid: power while driving shows +');
    ok(Hud.electricalItems(Object.assign({}, hy, { fahrenheit: true }), EX)[4].value === '81°', 'hybrid: battery temperature in °F');
    ok(Hud.readoutsFor({ rpm: 3000 }, null, null, { rpm: 6000, cold: false }, hy, EX).length === Hud.MAX_READOUTS, 'hybrid: the row still holds four');
    ok(Hud.electricalWants(hy).hv === true, 'hybrid: power / charge readouts ask for the battery unit');
    // no data, no readout (a hybrid that doesn't send them, or a stale value)
    ok(Hud.electricalItems(hy, {}).length === 0, 'no data: no electrical readout');
    // tones: a weak 12 V battery is yellow, then red; overcharging red; a cold pack blue
    const tone = (x, i) => Hud.electricalItems(hy, Object.assign({}, EX, x))[i].tone;
    ok(tone({ soc12: 55 }, 0) === 'warm' && tone({ soc12: 30 }, 0) === 'hot' && tone({}, 0) === 'text', '12 V charge tones');
    ok(tone({ v12: 11.9 }, 1) === 'warm' && tone({ v12: 11.2 }, 1) === 'hot' && tone({ v12: 15.4 }, 1) === 'hot' && tone({ v12: 12.5 }, 1) === 'text', '12 V voltage tones');
    ok(tone({ hvTemp: 2 }, 4) === 'cold' && tone({ hvTemp: 50 }, 4) === 'hot', 'HV temperature tones');
    // Comfort's "lights only" clears them; they are profile keys like the other readouts
    ok(Hud.electricalItems(Hud.calmOpts(hy), EX).length === 0, 'calmOpts: no electrical readouts');
    ['hudShowBattSoc', 'hudShowBattVolt', 'hudShowHvSoc', 'hudShowHvPower', 'hudShowHvTemp', 'hudShowHvVolt'].forEach((k) => ok(Hud.PROFILE_KEYS.indexOf(k) >= 0, k + ' is a profile key'));
    // Settings: the hybrid rows only once the car has a hybrid battery; hudHybridSeen itself never shows
    spec.settings.filter((s) => /^hudShowHv/.test(s.key)).forEach((s) => ok(s.when && s.when.hudHybridSeen && s.when.hudHybridSeen[0] === true && s.default === false, s.key + ' shows only on a hybrid, off by default'));
    ok(declared.hudHybridSeen && declared.hudHybridSeen.hidden === true && declared.hudHybridSeen.default === false, 'hudHybridSeen is hidden and false by default');
    // every new signal interface is optional (a unit without it still installs Redline)
    ['de.bmw.infotainment.drivingexcitement.Efficiencytainment2', 'de.bmw.infotainment.lsc.LSCDataSink'].forEach((i) => ok(spec.signals[i] && spec.signals[i]._optional, i + ' is _optional'));
    // the electric share isn't shown until its scale is known (eDrive doesn't show it either): only logged raw
    // (powerlog.js) so a drive can settle it, on an optional interface
    const kombi = spec.signals['de.bmw.infotainment.KombiIF'];
    ok(kombi && kombi._optional && Object.keys(kombi).filter((k) => k[0] !== '_').join() === 'statusDisplayElectricalPowerDistribution', 'KombiIF: the power distribution only, optional');
    ok(!declared.hudShowEShare && !/eShare|ELECTRIC'|PowerDistribution/.test(fs.readFileSync(path.join(APP, 'hud.js'), 'utf8')), 'no electric-share readout');
    // the recovery / power bar: hybrids only; fuel use on any car (2026-11-10)
    {
        const st = (o) => settingsOf(o);
        const pet = Hud.optsFrom(st({ hudShowHvBar: true })), hyb = Hud.optsFrom(st({ hudShowHvBar: true, hudHybridSeen: true }));
        ok(!pet.hvBar && hyb.hvBar, 'power bar: never on a petrol / diesel car, on a hybrid when switched on');
        ok(Hud.electricalWants(hyb).hvKw && Hud.electricalWants(hyb).hv && !Hud.electricalWants(pet).hvKw, 'power bar: the HV kW read only when it shows');
        const bar = Hud.electricalItems(hyb, { hvKw: -18.4 }).filter((i) => i.bar)[0];
        ok(bar && bar.label === 'POWER' && bar.value === '-18' && bar.bar.v === -18.4 && bar.bar.lo < 0 && bar.bar.hi > 0 && bar.wide, 'power bar item: signed kW, regen below zero');
        ok(Hud.electricalItems(Hud.calmOpts(hyb), { hvKw: 10 }).length === 0, 'calmOpts: no power bar');
        const fo = Object.assign({}, Hud.optsFrom(st({ hudShowFuel: true, hudFuelUnit: 'mpguk' })));
        const fr = Hud.readoutsFor({}, null, null, null, fo, { fuelLph: 9.6, kmh: 80 }).filter((i) => i.label === 'MPG')[0];
        ok(fr && fr.value === String(Math.round(282.481 / 12)), 'fuel readout: 9.6 l/h at 80 km/h = 12 l/100 km = 24 mpg (' + (fr && fr.value) + ')');
        ok(Hud.readoutsFor({}, null, null, null, fo, { fuelLph: null, kmh: 80 }).every((i) => !/MPG|L\//.test(i.label)), 'fuel readout: none without a fuel rate');
        ok(!Hud.calmOpts(fo).fuel, 'calmOpts: no fuel readout');
        // the ramp draws the power bar under its band: it takes no place in the list of four
        const four = Object.assign({}, Hud.optsFrom(st({ hudShowHvBar: true, hudHybridSeen: true, hudShowTorque: true, hudTempsMode: 'always' })));
        const row = (style) => Hud.readoutsFor({ rpm: 3000, oil: 95, coolant: 90 }, 80, 1.1, null, Object.assign({}, four, { style: style }), { torque: 200, hvKw: -9 });
        ok(['ramp', 'arc', 'dial', 'standard', 'vector', 'digital', 'vfd'].every((st) => row(st).length === 5 && row(st).some((i) => i.bar)) && row('wings').length === 4, 'the power bar along the gauge, on top of four readouts (Split wings: no meter, it counts as one)');
        ['hudShowFuel', 'hudShowHvBar'].forEach((k) => ok(Hud.PROFILE_KEYS.indexOf(k) >= 0, k + ' is a profile key'));
    }
    ok(spec.signals['de.bmw.infotainment.vehicle.CDS'].statusBattery2 === 'rs', 'CDS.statusBattery2 subscribed');
    // the HUD looks page: hybrid switches only behind electrical.hybrid()
    const main = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');
    const el = main.slice(main.indexOf("studio.readouts === 'electric'"), main.indexOf("} else if (studio.panel === 'readouts') {"));
    ok(/if \(electrical\.hybrid\(\)\)/.test(el) && el.indexOf('hudShowHvSoc') > el.indexOf('electrical.hybrid()'), 'HUD looks: hybrid switches only on a hybrid');
}

/* ---------- 2.0.1: tyres (Redline's own reading; the readout; the tyre widget in the directions' corner) ---------- */
{
    const Tyres = require(path.join(APP, 'tyres'));
    const HudTyres = require(path.join(APP, 'hud-tyres'));
    // our own code: nothing of Car Vitals is required or read
    ['tyres.js', 'hud-tyres.js', 'hud.js', 'hud-draw.js', 'main.js'].forEach((f) => {
        const src = fs.readFileSync(path.join(APP, f), 'utf8');
        ok(!/require\([^)]*car_vitals|readFileSync\([^)]*car_vitals|car_vitals\/data|\.\.\/car_vitals/.test(src), f + ': nothing loaded or read from Car Vitals');
    });
    ok(spec.signals['de.bmw.infotainment.vehicle.TPMS'] && spec.signals['de.bmw.infotainment.vehicle.TPMS']._optional && spec.signals['de.bmw.infotainment.vehicle.Vehicle']._optional, 'TPMS and Vehicle signals are _optional');
    ['statusTyrePressure', 'statusTargetTyrePressure', 'statusTyreTemperature'].forEach((k) => ok(spec.signals['de.bmw.infotainment.vehicle.TPMS'][k] === 'rs', 'TPMS.' + k + ' subscribed'));

    // decoding: 0.1 x raw in the car's unit; the unit told from the value until the car says
    const t = new Tyres();
    ok(Math.abs(t.pressure(23, [0.5, 6]) - 2.3) < 1e-9, 'pressure: raw 23 = 2.3 bar');
    ok(Math.abs(t.pressure(2500, [0.5, 6]) - 2.5) < 1e-9, 'pressure: raw 2500 = 250 kPa = 2.5 bar');
    ok(t.pressure(65532, [0.5, 6]) === null && t.pressure(65535, [0.5, 6]) === null && t.pressure(undefined, [0.5, 6]) === null, 'pressure: 65532 and up = none');
    ok(t.temperature(99) === 59 && t.temperature(65535) === null, 'temperature: degrees + 40, 65535 = none');
    const p = new Tyres();
    ok(Math.abs(p.pressure(360, [0.5, 6]) - 36 / 14.5038) < 1e-9 && p.units.psiSeen, 'pressure: raw 360 = 36 psi (and so Fahrenheit)');
    ok(Math.abs(p.temperature(140) - (100 - 32) * 5 / 9) < 1e-9, 'temperature: a psi car sends °F (100 °F = 37.8 °C)');
    const u = new Tyres();
    u.handlers()['de.bmw.infotainment.vehicle.Vehicle'].statusNewCurrentUnitsStatusExt({ unitOfMeasurementAirPressure: 2, unitOfMeasurementTemperature: 1 });
    ok(u.units.press === 'KPA' && u.units.temp === 'C', 'the car\'s units read (kPa, °C)');
    ok(u.pressure(25, [0.5, 6]) === null && Math.abs(u.pressure(2500, [0.5, 6]) - 2.5) < 1e-9, 'the car\'s unit wins over the guess: on a kPa car raw 25 (2.5 kPa) is no tyre pressure, 2500 is 2.5 bar');
    // the handlers fill value(); nothing sent: null; never throw
    const h = new Tyres(), H = h.handlers()['de.bmw.infotainment.vehicle.TPMS'];
    ok(h.value() === null, 'nothing sent: no tyres');
    H.statusTyrePressure({ actualValuePressureTyreFLH: 24, actualValuePressureTyreFRH: 24, actualValuePressureTyreRLH: 25, actualValuePressureTyreRRH: 21 });
    H.statusTargetTyrePressure({ targetPressureTyreFLH: 25, targetPressureTyreFRH: 25, targetPressureTyreRLH: 27, targetPressureTyreRRH: 27 });
    H.statusTyreTemperature({ actualValueTemperatureTyreFLH: 99, actualValueTemperatureTyreFRH: 101, actualValueTemperatureTyreRLH: 109, actualValueTemperatureTyreRRH: 65535 });
    const v = h.value();
    ok(v && Math.abs(v.p.RR - 2.1) < 1e-9 && Math.abs(v.tgt.RL - 2.7) < 1e-9 && v.t.FL === 59 && v.t.RR === null, 'handlers: pressures, targets, temperatures per corner (' + JSON.stringify(v) + ')');
    let threw = false;
    try { H.statusTyrePressure(null); H.statusTyrePressure({}); H.statusTyreTemperature('x'); h.handlers()['de.bmw.infotainment.vehicle.Vehicle'].statusNewCurrentUnitsStatusExt(undefined); } catch (e) { threw = true; }
    ok(!threw, 'tyres: handlers never throw');

    // colours against the target (Car Vitals' bands): red under 85 %, orange under 93 % or over 115 %, else green
    ok(Tyres.toneOf(2.1, 2.7) === 'hot' && Tyres.toneOf(2.5, 2.7) === 'warm' && Tyres.toneOf(2.4, 2.5) === 'low' && Tyres.toneOf(3.0, 2.5) === 'warm' && Tyres.toneOf(2.4, null) === 'text' && Tyres.toneOf(null, 2.5) === null, 'tyre colours');
    ok(Tyres.fmtP(2.48, 'bar') === '2.5' && Tyres.fmtP(2.48, 'psi') === '36' && Tyres.fmtP(2.48, 'kpa') === '248' && Tyres.fmtP(null, 'bar') === '--', 'pressure units: bar, psi, kPa');

    // the readout: the worst tyre for label-and-value layouts, the four for the 2x2 block
    const r = Tyres.readout(v, 'bar');
    ok(r.label === 'TYRE RR' && r.value === '2.1' && r.tone === 'hot' && r.block === 'TYRES', 'readout: the worst tyre, red (' + JSON.stringify(r) + ')');
    ok(r.tyres.map((c) => c.join(' ')).join(',') === '2.4 low,2.4 low,2.5 warm,2.1 hot', 'readout: four cells FL FR RL RR with their colours');
    const fine = Tyres.readout({ p: { FL: 2.5, FR: 2.5, RL: 2.7, RR: 2.7 }, tgt: { FL: 2.5, FR: 2.5, RL: 2.7, RR: 2.7 }, t: {} }, 'psi');
    ok(fine.tone === 'text' && fine.value === '36', 'readout: all fine is a plain readout (gives way like one), in psi');
    ok(Tyres.readout(null, 'bar') === null, 'readout: none without tyres');
    ok(Tyres.lowCorners(v).join() === 'RR' && Tyres.lowCorners(null).length === 0, 'low corners: the red ones');
    const oT = Hud.optsFrom(settingsOf({ hudShowTyres: true, hudShowRpm: false, hudBoost: false }));
    ok(oT.tyres === true && oT.tyreUnit === 'bar' && optsDefault.tyres === false, 'options: Tyres readout off by default, in bar');
    ok(Hud.readoutsFor({ rpm: 3000, oil: 95, coolant: 90 }, null, null, { rpm: 6000, cold: false }, oT, { tyres: v }).some((x) => x.block === 'TYRES'), 'readouts row: the Tyres readout');
    ok(!Hud.readoutsFor({ rpm: 3000 }, null, null, { rpm: 6000, cold: false }, Hud.calmOpts(oT), { tyres: v }).some((x) => x.block), 'calmOpts: no Tyres readout');
    ok(Hud.PROFILE_KEYS.indexOf('hudShowTyres') >= 0 && Hud.PROFILE_KEYS.indexOf('hudTyreWidget') < 0, 'the Tyres readout is per profile; the widget, like the directions, is not');
    ok(!spec.settings.find((s) => s.key === 'hudStyle').options.some((o2) => o2[0] === 'tyres'), 'tyres are no HUD layout (the widget is in the directions corner)');
    // a car that sends no tyres never sees them: every tyre setting listed only once tyres came, the flag hidden
    ['hudShowTyres', 'hudTyreWidget', 'hudTyreCar', 'hudTyreTarget', 'hudTyreTemp', 'hudTyreUnit'].forEach((k) => ok(declared[k] && declared[k].when && declared[k].when.hudTyresSeen && declared[k].when.hudTyresSeen[0] === true, k + ' listed only once the car has sent tyres'));
    ok(declared.hudTyresSeen && declared.hudTyresSeen.hidden === true && declared.hudTyresSeen.default === false && !declared.hudTyreAlert, 'hudTyresSeen hidden, false by default; no separate tyre alert');
    const sv = {}, st = new Tyres(null, { get: (k) => sv[k], set: (k, x) => { sv[k] = x; } });
    st.handlers()['de.bmw.infotainment.vehicle.TPMS'].statusTyreTemperature({ actualValueTemperatureTyreFLH: 99 });
    ok(!st.seen(), 'a temperature alone: tyres not taken as sent');
    st.handlers()['de.bmw.infotainment.vehicle.TPMS'].statusTyrePressure({ actualValuePressureTyreFLH: 65535, actualValuePressureTyreFRH: 24 });
    ok(st.seen() && sv.hudTyresSeen === true, 'the first real pressure: hudTyresSeen set');
    // the HUD looks page: the TYRES tab and the Tyres readout switch only with tyres
    const mainSrc = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');
    ok(/tyres\.seen\(\) \? \[\['tyres', 'TYRES'\]\]/.test(mainSrc) && /tyres\.seen\(\) \? \[\['Tyres', o\.tyres/.test(mainSrc), 'HUD looks: TYRES tab and Tyres switch only once tyres came');
    ok(/tyres\.seen\(\) \? 'Tyre sensors' : 'No tyre sensors'/.test(mainSrc) && /electrical\.hybrid\(\) \? ' hybrid' : ' car'/.test(mainSrc), 'Learned page: the car (Petrol car, Diesel hybrid ...) and whether it has tyre sensors');

    // the widget (200 x 76, the directions' size): every part on and off, every unit, Normal and Clearer, °C and °F
    const W0 = HudTyres.widgetOf(settingsOf({})), WW = HudTyres.TW, WH = HudTyres.TH;
    ok(WW === 200 && WH === 76, 'the widget is the size of the directions');
    ok(W0.show === 'low' && W0.car && !W0.target && W0.temp && W0.unit === 'bar', 'widget defaults: when a tyre is low, the car and temperatures, no target, bar');
    const widget = (w, ty, pal) => { const cv = new Canvas(WW, WH); HudTyres.drawWidget(cv, ty, w, pal || 'colour'); return cv; };
    const litW = (cv, x0, y0, x1, y1) => { let n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (cv.d[(y * WW + x) * 4 + 3]) n++; return n; };
    [false, true].forEach((car) => [false, true].forEach((tg) => [false, true].forEach((tp) => ['bar', 'psi', 'kpa'].forEach((un) => [false, true].forEach((cl) => {
        const w = Object.assign({}, W0, { car: car, target: tg, temp: tp, unit: un, clear: cl, fahrenheit: un === 'psi' });
        const tag = 'widget ' + [car ? 'car' : '', tg ? 'target' : '', tp ? 'temp' : '', un, cl ? 'clearer' : 'normal'].filter(Boolean).join('/');
        let cv;
        try { cv = widget(w, v); } catch (e) { ok(false, tag + ' threw: ' + e.message); return; }
        const m = HudTyres.layoutOf(cv, v, w).cx;
        ok(litW(cv, 0, 0, m - 10, 38) > 60 && litW(cv, m + 10, 0, 200, 38) > 60 && litW(cv, 0, 38, m - 10, 76) > 60 && litW(cv, m + 10, 38, 200, 76) > 60, tag + ': a pressure at each corner');
        // in the corner: right of the middle, lined up with the directions (their right edge RIGHT_IN in), never past it
        let lastX = -1; for (let x = WW - 1; x >= 0 && lastX < 0; x--) if (litW(cv, x, 0, x + 1, 76) > 0) lastX = x;
        // (too wide to move, as with targets or kPa: it stays in the middle and fills the box)
        ok(m >= 100 && lastX < WW && (m === 100 || lastX <= WW - HudTyres.RIGHT_IN + 1), tag + ': in the right part of the box (middle ' + m + ', right edge ' + lastX + ')');
        ok(litW(cv, 0, 0, 1, 76) === 0 && litW(cv, 199, 0, 200, 76) === 0, tag + ': nothing runs off the sides');
    })))));
    // each part shows: switching it off changes the picture
    const wb = (o) => Buffer.from(widget(Object.assign({}, W0, o), v).d), base0 = wb({});
    [['car', false], ['target', true], ['temp', false], ['unit', 'psi'], ['clear', true], ['fahrenheit', true]].forEach((c) => ok(Buffer.compare(wb({ [c[0]]: c[1] }), base0) !== 0, 'widget: ' + c[0] + ' changes it'));
    ok(Buffer.compare(Buffer.from(widget(W0, v, 'amber').d), base0) !== 0, 'widget: the HUD colours apply');
    ok(litW(widget(W0, null), 0, 0, WW, WH) === 0, 'widget: nothing drawn without tyres');
    // when it shows: low (default) only while a tyre is red, always, off never; never without data
    const fineT = { p: { FL: 2.5, FR: 2.5, RL: 2.7, RR: 2.7 }, tgt: { FL: 2.5, FR: 2.5, RL: 2.7, RR: 2.7 }, t: {} };
    ok(!HudTyres.widgetShows(W0, fineT) && HudTyres.widgetShows(W0, v), 'widget "when low": not with fine tyres, yes with a red one');
    ok(HudTyres.widgetShows(Object.assign({}, W0, { show: 'always' }), fineT) && !HudTyres.widgetShows(Object.assign({}, W0, { show: 'off' }), v) && !HudTyres.widgetShows(Object.assign({}, W0, { show: 'always' }), null), 'widget always / off / no data');
    ok(HudTyres.widgetKey(v, W0, 'colour') !== HudTyres.widgetKey(v, Object.assign({}, W0, { temp: false }), 'colour') && HudTyres.widgetKey(v, W0, 'colour') !== HudTyres.widgetKey(fineT, W0, 'colour'), 'widget key: follows the numbers and the parts');
    // the HUD looks preview draws it through the scaled surface
    let scaledOk = true;
    try { const big = new Canvas(700, 260); HudTyres.drawWidget(Draw.scaled(big, 3, 20, 10), v, W0, 'colour'); } catch (e) { scaledOk = false; }
    ok(scaledOk, 'widget: drawn three times its size for the HUD looks page');
    // the 2x2 block: four readouts across the row, its numbers inside their column (Normal and Clearer)
    const item = Tyres.readout(v, 'kpa'), row = [{ label: 'RPM', value: '3000', tone: 'text' }, { label: 'BOOST', value: '1.2', tone: 'text' }, item, { label: 'OIL', value: '95°', tone: 'text' }];
    [false, true].forEach((cl) => ['standard', 'digital', 'vector', 'arc', 'ramp', 'dial'].forEach((st) => {
        const o = Object.assign({}, optsDefault, { style: st, clearLabels: cl });
        try { const cv = new Canvas(Draw.IW, Draw.IH); Draw.drawLayer(cv, frame(o, { readouts: row, chip: null }), 'both'); } catch (e) { ok(false, st + ' with the Tyres readout threw: ' + e.message); }
    }));
    const colw = (Draw.IW - Draw.TEMP_X) / 4, cv0 = new Canvas(10, 10);
    ok(Tyres.CORNERS.every((c, j) => cv0.textWidth(item.tyres[j][0], 17, { font: 'bold' }) <= colw / 2 - 2), '2x2 block: kPa values fit half a column (' + Math.round(colw / 2) + ' px)');
    // a rear tyre's change redraws the block (standard)
    const pic = (cells) => { const cv = new Canvas(Draw.IW, Draw.IH); Draw.drawLayer(cv, frame(Object.assign({}, optsDefault, { style: 'standard' }), { readouts: [Object.assign({}, item, { tyres: cells })], chip: null }), 'fg'); return Buffer.from(cv.d); };
    ok(Buffer.compare(pic(item.tyres), pic(item.tyres.slice(0, 3).concat([['199', 'hot']]))) !== 0, '2x2 block: each tyre\'s number is drawn');
    ok(HudTyres.tempTone(10) === 'cold' && HudTyres.tempTone(95) === 'warm' && HudTyres.tempTone(110) === 'hot' && HudTyres.tempTone(60) === 'text', 'tyre temperature colours');
    // warm-up: blue cold, green warm; the widget's "Warming up" keeps it up until all four are warm
    ok(HudTyres.warmth(HudTyres.COLD_C - 5) === 0 && HudTyres.warmth(HudTyres.WARM_C + 5) === 1 && HudTyres.warmth(30) > 0 && HudTyres.warmth(30) < 1 && HudTyres.warmth(null) === null, 'warm-up: 0 cold, 1 warm, between in between');
    const warmT = (c) => ({ p: fineT.p, tgt: fineT.tgt, t: { FL: c, FR: 60, RL: 60, RR: 60 } }), WW0 = Object.assign({}, W0, { show: 'warm' });
    ok(HudTyres.widgetShows(WW0, warmT(25)) && !HudTyres.widgetShows(WW0, warmT(50)) && HudTyres.widgetShows(WW0, v) === HudTyres.widgetShows(W0, v), 'widget "warming up": while a tyre is cold, gone once all are warm, and still when one is low');
    ok(!HudTyres.widgetShows(W0, warmT(25)) && !HudTyres.widgetShows(WW0, fineT), 'widget "when low" ignores cold tyres; no temperatures: not warming up');
    ok(HudTyres.widgetOf(settingsOf({ hudTyreWidget: 'warm' })).show === 'warm', 'the "warm" setting is read');
    // a cold front-left tyre is drawn blue, a warm one green (the tyre in the car, left of the body)
    const tyreCol = (c) => { const ty = warmT(c), cv = widget(W0, ty), m = HudTyres.layoutOf(cv, ty, W0).cx, i = ((6 + 8) * WW + (m - 13 - 2 - 3)) * 4; return [cv.d[i], cv.d[i + 1], cv.d[i + 2]]; };
    const cold = tyreCol(10), warm = tyreCol(50);
    ok(cold[2] > cold[1] && warm[1] > warm[2] && warm[1] > warm[0], 'warm-up: the cold tyre blue (' + cold + '), the warm one green (' + warm + ')');
    // the tyre widget redraws when a temperature as drawn changes, also in °F
    { const ty = (t) => ({ p: { FL: 2.5, FR: 2.5, RL: 2.5, RR: 2.5 }, tgt: { FL: 2.5, FR: 2.5, RL: 2.5, RR: 2.5 }, t: { FL: t, FR: 40, RL: 40, RR: 40 } }), wF = Object.assign({}, HudTyres.widgetOf(settingsOf({})), { fahrenheit: true });
      ok(HudTyres.widgetKey(ty(36.6), wF, 'colour') !== HudTyres.widgetKey(ty(37.4), wF, 'colour'), 'tyre widget key: 98 and 99 °F differ (both 37 °C)'); }
    // the demo drive has tyres for the previews
    ok(Hud.demoAt(0).tyres && Tyres.lowCorners(Hud.demoAt(0).tyres).join() === 'RR', 'demo: tyres, the rear right low');
}

function electricalChecks() {
    const Electrical = require(path.join(APP, 'electrical'));
    const { DidReader } = require(path.join(ROOT, 'kit', 'runtime', 'dids'));
    const edrive = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'edrive', 'app.json'), 'utf8')).config.battery;
    // the same reads as eDrive (its config.battery): 12 V candidates in order, the HV charge, voltage and current
    const same = (a, b, keys) => keys.every((k) => (a[k] == null ? null : a[k]) === (b[k] == null ? null : b[k]));
    const ecuOf = (c) => (c.ecu == null ? edrive.ecu : c.ecu);
    ok(Electrical.V12.length === edrive.v12.length && Electrical.V12.every((c, i) => c.ecu === ecuOf(edrive.v12[i]) && same(c, edrive.v12[i], ['did', 'obd', 'bytes', 'factor', 'offset', 'min', 'max']) && (c.at || 0) === (edrive.v12[i].at || 0)),
        'electrical: 12 V candidates are eDrive\'s config.battery.v12');
    ok(same(Electrical.HV_SOC[0], edrive.soc[0], ['did', 'bytes', 'factor', 'min', 'max']) && Electrical.HV_SOC[0].ecu === edrive.ecu, 'electrical: HV charge is eDrive\'s DDBC');
    ok(Electrical.HV_V.map((c) => c.did).join() === edrive.fast.hvV.map((c) => c.did).join() && Electrical.HV_V.every((c, i) => c.factor === edrive.fast.hvV[i].fields.v.factor), 'electrical: pack voltage DIDs are eDrive\'s');
    ok(Electrical.HV_A[0].did === edrive.fast.hvI[0].did && Electrical.HV_A[0].bytes === edrive.fast.hvI[0].fields.a.bytes && Electrical.HV_A[0].signed === true, 'electrical: pack current is eDrive\'s DD69');
    // never another app's files: no /tmp, no file reads
    const src = fs.readFileSync(path.join(APP, 'electrical.js'), 'utf8');
    ok(!/\/tmp|require\('fs'\)|readFile/.test(src), 'electrical: reads the car, never another app\'s files');

    // decoders
    const D = Electrical.decode;
    ok(D.soc12({ conditionBatteryChargingCondition: 87 }) === 87 && D.soc12({ conditionBatteryChargingCondition: 255 }) === null, 'decode: 12 V charge');
    ok(D.hvTemp({ x: [{ actualValueTemperatureHighVoltageStorage: 76 }] }) === 26 && D.hvTemp({ actualValueTemperatureHighVoltageStorage: 255 }) === null, 'decode: HV temperature (-50, 255 none)');
    ok(D.hvVolt({ actualValueVoltageHighVoltageStorage: 3524 }) === 352.4 && D.hvVolt({ actualValueVoltageHighVoltageStorage: 352 }) === 352 && D.hvVolt({ actualValueVoltageHighVoltageStorage: 0 }) === null, 'decode: pack voltage (V or 0.1 V)');
    ok(Math.abs(D.hvKw(352, -100) - 35.2) < 1e-9 && Math.abs(D.hvKw(352, 50) + 17.6) < 1e-9, 'decode: power + drive / - regen (eDrive powerSign -1)');

    // a fake car: replies per 'ecu:DID' or 'ecu:obdPID' (bytes after the DID / PID), 'nrc', or nothing
    const settingsFake = (v) => { const vals = Object.assign({ hudHybridSeen: false }, v); return { get: (k) => vals[k], set: (k, x) => { vals[k] = x; }, vals: vals }; };
    const log = { info() {}, warn() {} };
    const linkFor = (replies) => ({ asked: [], physical(ecu, sid, data) {
        const key = ecu.toString(16) + ':' + (sid === 1 ? 'obd' : '') + data.map((b) => (b < 16 ? '0' : '') + b.toString(16)).join('').toUpperCase();
        this.asked.push(key);
        const r = replies[key];
        if (r === undefined) return Promise.resolve(null);
        if (r === 'nrc') return Promise.resolve([0x7F, sid, 0x31]);
        if (r === 'nrc22') return Promise.resolve([0x7F, sid, 0x22]);      // conditions not correct: not now
        return Promise.resolve((sid === 1 ? [0x41] : [0x62]).concat(data, r));
    } });
    const handle = (e, iface, f, v) => e.handlers()[iface][f](v);

    // petrol car (no battery unit): one look for it, then nothing hybrid, ever - even with odd signals
    const sP = settingsFake(), linkP = linkFor({ '12:F442': 'nrc', '12:obd42': [0x37, 0x6E] });
    const p = new Electrical({ log: log, settings: sP }, () => linkP);
    p.rd = new DidReader(linkP, { ecu: 7 });
    p.want = { v12: true, hv: true };
    handle(p, 'de.bmw.infotainment.drivingexcitement.Efficiencytainment2', 'statusBatteryTemperature', { actualValueTemperatureHighVoltageStorage: 255 });
    handle(p, 'de.bmw.infotainment.lsc.LSCDataSink', 'statusHighVoltageStorage', { actualValueVoltageHighVoltageStorage: 0 });
    // a temperature that looks plausible is not proof of a hybrid battery (a 48 V mild hybrid may send one)
    handle(p, 'de.bmw.infotainment.drivingexcitement.Efficiencytainment2', 'statusBatteryTemperature', { actualValueTemperatureHighVoltageStorage: 72 });
    handle(p, 'de.bmw.infotainment.vehicle.CDS', 'statusBattery2', { conditionBatteryChargingCondition: 81 });
    return p._turn().then(() => {
        ok(linkP.asked.join() === '7:DDBC', 'petrol: one look for a battery unit (' + linkP.asked.join() + ')');
        ok(p.hybrid() === false && sP.vals.hudHybridSeen === false, 'petrol: not taken for a hybrid');
        // the 12 V search asks 1 candidate a turn: F442 (refused), the SME's, then OBD 42 answers
        return p._turn().then(() => {
            ok(linkP.asked.slice(1).join() === '12:F442' && p.v12T > 0 && p.fails.v12 === 0, 'petrol: the 12 V search asks 1 a turn, no failure part-way (' + linkP.asked.slice(1).join() + ')');
            return p._turn();
        }).then(() => p._turn());
    }).then(() => {
        const v = p.value();
        ok(v.hvSoc === null && v.hvKw === null && v.hvTemp === null && v.hvVolt === null, 'petrol: no hybrid values (' + JSON.stringify(v) + ')');
        ok(linkP.asked.filter((k) => /^7:DD/.test(k)).length === 1, 'petrol: the battery unit is not asked again');
        ok(v.soc12 === 81 && Math.abs(v.v12 - 14.19) < 1e-9, 'petrol: 12 V charge and voltage (F442 refused, OBD 42 answers): ' + v.soc12 + ' ' + v.v12);
        ok(p.vs.pick === 2, 'petrol: the 12 V source that answered is kept');
        const n = linkP.asked.length;
        p.v12T = 0;
        return p._turn().then(() => ok(linkP.asked.slice(n).join() === '12:obd42', 'petrol: next time only the 12 V source that answered (' + linkP.asked.slice(n).join() + ')'));
    }).then(() => {
        // a plug-in hybrid: the battery unit answers; then power each turn, charge every 5 s
        const sH = settingsFake(), linkH = linkFor({ '7:DDBC': [0x02, 0x84], '7:DDB4': [0x89, 0xA8], '7:DD69': [0xFF, 0xFF, 0xD8, 0xF0], '12:F442': [0x36, 0xB0] });
        const h = new Electrical({ log: log, settings: sH }, () => linkH);
        h.rd = new DidReader(linkH, { ecu: 7 });
        h.want = { v12: false, hv: true };
        return h._turn().then(() => {
            ok(h.hybrid() === true && sH.vals.hudHybridSeen === true, 'hybrid: found from the battery unit and kept');
            return h._turn();
        }).then(() => {
            const v = h.value();
            ok(Math.abs(v.hvSoc - 64.4) < 1e-9, 'hybrid: charge 64.4 % (' + v.hvSoc + ')');
            ok(Math.abs(v.hvVolt - 352.4) < 1e-9 && Math.abs(v.hvKw - 35.24) < 1e-9, 'hybrid: 352.4 V x -100 A = +35.2 kW drive (' + v.hvKw + ')');
            ok(v.v12 === null, 'hybrid: 12 V not read while its readout is off');
            // a hybrid found from its signals alone
            const s2 = settingsFake(), e2 = new Electrical({ log: log, settings: s2 }, () => linkH);
            handle(e2, 'de.bmw.infotainment.drivingexcitement.Efficiencytainment2', 'statusBatteryTemperature', { actualValueTemperatureHighVoltageStorage: 76 });
            ok(e2.hybrid() === false && e2.value().hvTemp === null, 'a battery temperature alone: not taken for a hybrid, not shown');
            // the pack voltage signal counts once it moves: two different plausible values 10 s apart (2026-11-10 review)
            const realNow2 = Date.now, t2 = realNow2.call(Date);
            const volt = (e, raw, at) => { Date.now = () => t2 + at; try { handle(e, 'de.bmw.infotainment.lsc.LSCDataSink', 'statusHighVoltageStorage', { actualValueVoltageHighVoltageStorage: raw }); } finally { Date.now = realNow2; } };
            volt(e2, 3524, 0);
            ok(e2.hybrid() === false, 'one pack voltage message: not proof yet');
            volt(e2, 3530, 5000);
            ok(e2.hybrid() === false, 'a second value within 10 s: not yet');
            volt(e2, 3524, 10000);
            ok(e2.hybrid() === true && e2.value().hvVolt === 352.4 && e2.value().hvTemp === 26, 'hybrid: found from the pack voltage signal moving over 10 s, then its temperature shows');
            // a "no value" pattern (4095 = 409.5 V) or one that never moves: never a hybrid
            const s3 = settingsFake(), e3 = new Electrical({ log: log, settings: s3 }, () => linkH);
            volt(e3, 4095, 0); volt(e3, 4095, 20000); volt(e3, 2047, 40000); volt(e3, 4095, 60000);
            const s4 = settingsFake(), e4 = new Electrical({ log: log, settings: s4 }, () => linkH);
            volt(e4, 480, 0); volt(e4, 480, 30000);
            ok(e3.hybrid() === false && s3.vals.hudHybridSeen !== true && e4.hybrid() === false, 'pack voltage: sentinels and a value that never moves never mark a hybrid');
            // a signal handler never throws
            let threw = false;
            try { handle(e2, 'de.bmw.infotainment.lsc.LSCDataSink', 'statusHighVoltageStorage', undefined); handle(e2, 'de.bmw.infotainment.vehicle.CDS', 'statusBattery2', null); } catch (e) { threw = true; }
            ok(!threw, 'electrical: handlers never throw');
        });
    }).then(() => {
        // the link not up yet (the HUD's first ticks): nothing is asked, the one look for a hybrid is kept for later
        const sL = settingsFake(), linkL = linkFor({ '7:DDBC': [0x02, 0x84] });
        linkL.ready = false;
        const l = new Electrical({ log: log, settings: sL }, () => linkL);
        l.rd = new DidReader(linkL, { ecu: 7 });
        l.want = { v12: true, hv: true };
        return l._turn().then(() => l._turn()).then(() => {
            ok(linkL.asked.length === 0 && l.probed === false && l.fails.v12 === 0, 'link not up: nothing asked, nothing counted as failed');
            linkL.ready = true;
            return l._turn();
        }).then(() => ok(linkL.asked.join() === '7:DDBC' && l.hybrid() === true, 'link up: the look for a hybrid battery happens then'));
    }).then(() => {
        // every battery read waits at most about a second (the link is shared with knock and the gearbox)
        const all = Electrical.HV_SOC.concat(Electrical.HV_V, Electrical.HV_A);
        ok(all.every((c) => c.timeoutMs > 0 && c.timeoutMs <= 1000), 'every battery read waits at most 1 s (' + all.map((c) => c.did + ' ' + c.timeoutMs).join(', ') + ')');
    }).then(() => {
        // the link stops asking a unit after 5 misses until woken: a start wakes every unit electrical asks,
        // and each once-a-minute try wakes its units first (else that try never reaches the car)
        const sW = settingsFake({ hudHybridSeen: true }), linkW = linkFor({ '7:DDBC': [0x02, 0x84] });
        linkW.woke = []; linkW.wake = function (e) { this.woke.push(e); };
        const w = new Electrical({ log: log, settings: sW }, () => linkW);
        w.start({ v12: true, hvSoc: true, hvKw: false }); w.stop();
        ok([0x12, 0x13, 0x18, 0x07].every((e) => linkW.woke.indexOf(e) >= 0), 'electrical: a start wakes the units it asks (' + linkW.woke.join() + ')');
        // charge only, on a battery unit that gives the charge but not the power: the power isn't asked, the
        // charge never counts as failed between its reads
        w.want = { v12: false, hvSoc: true, hvKw: false };
        return w._turn().then(() => w._turn()).then(() => w._turn()).then(() => {
            ok(!linkW.asked.some((k) => /7:DD(B4|68|66|EF|69)/.test(k)), 'HV charge only: the power is not asked (' + linkW.asked.join() + ')');
            ok(w.fails.soc === 0 && Math.abs(w.value().hvSoc - 64.4) < 1e-9, 'HV charge only: kept, no failures between its reads');
            // a minute after 3 failures: the try wakes the battery unit, then asks it
            w.fails.soc = 3; w.tried.soc = Date.now() - 61000; w.slowT = 0; linkW.woke = []; linkW.asked = [];
            return w._turn();
        }).then(() => ok(linkW.woke.indexOf(0x07) >= 0 && linkW.asked.join() === '7:DDBC' && w.fails.soc === 0, 'the once-a-minute try wakes the unit and asks it (' + linkW.woke.join() + ' / ' + linkW.asked.join() + ')'));
    }).then(() => {
        // (2026-11-10 review) a clock the checks move: electrical.js and the reads stamp with Date.now; put back after
        const realNow = Date.now;
        let clock = realNow.call(Date);
        Date.now = () => clock;
        const lines = [], logL = { info: (m) => lines.push(m), warn: (m) => lines.push('W ' + m) };
        const wait = () => new Promise((res) => setTimeout(res, 20));
        const mk = (s, link) => { const e = new Electrical({ log: logL, settings: s }, () => link); e.rd = new DidReader(link, { ecu: 7 }); return e; };
        // the look for a hybrid battery: a transport error is no answer, asked again a minute later
        const linkR = linkFor({ '7:DDBC': [0x02, 0x84] }), physR = linkR.physical;
        let refuse = true;
        linkR.physical = function () { if (refuse) { this.asked.push('refused'); return Promise.reject(new Error('transport refused')); } return physR.apply(this, arguments); };
        linkR.available = true;
        const r = mk(settingsFake(), linkR);
        r.want = { v12: false, hv: true };
        return r._turn().then(() => {
            ok(r.probed === false && r.probeN === 1 && r.hybrid() === false && lines.length === 0, 'probe: a transport error is no answer, nothing logged (' + lines.join('|') + ')');
            ok(r._probeDue(clock + 1000) === false && r._probeDue(clock + 60000) === true, 'probe: due again a minute later');
            refuse = false; clock += 30000;
            return r._turn();
        }).then(() => {
            ok(linkR.asked.join() === 'refused', 'probe: not asked again within the minute (' + linkR.asked.join() + ')');
            clock += 31000;
            return r._turn();
        }).then(() => {
            ok(linkR.asked.join() === 'refused,7:DDBC' && r.hybrid() === true && r.probed === true, 'probe: the retry finds the battery unit (' + linkR.asked.join() + ')');
            // a refusal settles it: no unit, one line, never asked again (nor started for it)
            const linkN = linkFor({ '7:DDBC': 'nrc' }), e = mk(settingsFake(), linkN);
            e.want = { v12: false, hv: true }; lines.length = 0;
            return e._turn().then(() => { clock += 61000; return e._turn(); }).then(() => { clock += 61000; return e._turn(); }).then(() => {
                ok(linkN.asked.join() === '7:DDBC' && e.probed === true && e.hybrid() === false, 'probe: a refusal settles it, not asked again (' + linkN.asked.join() + ')');
                ok(lines.length === 1 && /no high-voltage battery unit \(NRC 31/.test(lines[0]), 'probe: one line for no unit (' + lines.join('|') + ')');
                e.start({ hv: true });
                ok(e.timer === null && e.rd !== null && linkN.asked.length === 1, 'probe: settled, start() asks nothing');
            });
        }).then(() => {
            // "not now" (NRC 22, the unit not ready): tried again a minute later, not taken as no unit
            const link22 = linkFor({ '7:DDBC': 'nrc22' }), n22 = mk(settingsFake(), link22);
            n22.want = { v12: false, hv: true };
            return n22._turn().then(() => {
                ok(n22.probed === false && n22.hybrid() === false, 'probe: NRC 22 is no answer yet');
                link22.physical = linkFor({ '7:DDBC': [0x02, 0x6C] }).physical.bind(link22);
                clock += 61000;
                return n22._turn();
            }).then(() => ok(n22.hybrid() === true, 'probe: after NRC 22 the retry finds the battery unit'));
        }).then(() => {
            // no reply: 3 tries a minute apart, then one line, then no more
            const linkQ = linkFor({}), q = mk(settingsFake(), linkQ);
            q.want = { v12: false, hv: true }; lines.length = 0;
            let c = Promise.resolve();
            for (let i = 0; i < 5; i++) c = c.then(() => q._turn()).then(() => { clock += 61000; });
            return c.then(() => ok(linkQ.asked.join() === '7:DDBC,7:DDBC,7:DDBC' && q.probed === true && lines.length === 1 && /no reply, 3 tries/.test(lines[0]),
                'probe: no reply, 3 tries then no unit (' + linkQ.asked.join() + ' / ' + lines.join('|') + ')'));
        }).then(() => {
            // the link there but not available yet: nothing asked, no try used
            const linkA = linkFor({ '7:DDBC': [0x02, 0x84] }), a = mk(settingsFake(), linkA);
            linkA.available = false; a.want = { v12: true, hv: true };
            return a._turn().then(() => ok(linkA.asked.length === 0 && a.probeN === 0, 'probe: link not available, nothing asked, no try used'));
        }).then(() => {
            // steady signals (sent on change only) stay shown; a read's value goes stale; the signal saying none clears it
            const t = mk(settingsFake({ hudHybridSeen: true }), linkFor({}));
            handle(t, 'de.bmw.infotainment.drivingexcitement.Efficiencytainment2', 'statusBatteryTemperature', { actualValueTemperatureHighVoltageStorage: 76 });
            handle(t, 'de.bmw.infotainment.vehicle.CDS', 'statusBattery2', { conditionBatteryChargingCondition: 81 });
            handle(t, 'de.bmw.infotainment.lsc.LSCDataSink', 'statusHighVoltageStorage', { actualValueVoltageHighVoltageStorage: 3524 });
            t._put('hvVoltUds', 360);
            ok(t.value().hvVolt === 360, 'pack voltage: the fresh SME read first');
            clock += 5 * 60000;
            let v = t.value();
            ok(v.hvTemp === 26 && v.soc12 === 81 && v.hvVolt === 352.4, 'steady signals still shown after 5 min, the SME read gone (' + JSON.stringify(v) + ')');
            clock += 26 * 60000;
            v = t.value();
            ok(v.hvTemp === null && v.soc12 === null && v.hvVolt === null, 'signals: gone after 31 min');
            handle(t, 'de.bmw.infotainment.drivingexcitement.Efficiencytainment2', 'statusBatteryTemperature', { actualValueTemperatureHighVoltageStorage: 76 });
            handle(t, 'de.bmw.infotainment.drivingexcitement.Efficiencytainment2', 'statusBatteryTemperature', { actualValueTemperatureHighVoltageStorage: 255 });
            handle(t, 'de.bmw.infotainment.drivingexcitement.Efficiencytainment2', 'statusBatteryTemperature', { other: 1 });
            ok(t.value().hvTemp === null, 'signals: 255 (none) clears the temperature');
            handle(t, 'de.bmw.infotainment.drivingexcitement.Efficiencytainment2', 'statusBatteryTemperature', { actualValueTemperatureHighVoltageStorage: 76 });
            handle(t, 'de.bmw.infotainment.drivingexcitement.Efficiencytainment2', 'statusBatteryTemperature', { other: 1 });
            ok(t.value().hvTemp === 26, 'signals: a message without the field keeps it');
        }).then(() => {
            // stop() during a 12 V search: no further reads; the next start goes on where it stopped
            const linkS = linkFor({}), physS = linkS.physical, st = mk(settingsFake({ hudHybridSeen: true }), linkS);
            st.rd = null;
            linkS.physical = function () { const x = physS.apply(this, arguments); if (this.asked.length === 1) st.stop(); return x; };
            st.start({ v12: true });
            return wait().then(() => {
                ok(linkS.asked.join() === '12:F442' && st.timer === null && st.busy === false, 'stop() during the 12 V search: no further reads (' + linkS.asked.join() + ')');
                st.start({ v12: true });
                return wait();
            }).then(() => {
                st.stop();
                ok(/^12:F442,7:F442/.test(linkS.asked.join()) && st.fails.v12 === 0, 'the next start goes on with the search, 1 a turn (' + linkS.asked.join() + ')');
            });
        }).then(() => {
            // a hybrid whose 12 V isn't found: the power is read every turn of the search, and stays fresh
            const linkP2 = linkFor({ '7:DDB4': [0x89, 0xA8], '7:DD69': [0xFF, 0xFF, 0xD8, 0xF0] }), physP = linkP2.physical;
            linkP2.physical = function () { const x = physP.apply(this, arguments); if (!/DD/.test(this.asked[this.asked.length - 1])) clock += 1000; return x; };
            const k = mk(settingsFake({ hudHybridSeen: true }), linkP2);
            k.want = { v12: true, hvKw: true, hvSoc: false };
            const turns = [], fresh = [], NV = Electrical.V12.length;     // the search: one turn per 12 V candidate
            let c = Promise.resolve();
            for (let i = 0; i < NV + 1; i++) {
                c = c.then(() => { const n = linkP2.asked.length; return k._turn().then(() => { turns.push(linkP2.asked.slice(n)); fresh.push(k.value().hvKw !== null); clock += 100; }); });
            }
            return c.then(() => {
                const v12n = turns.map((x) => x.filter((key) => !/DD/.test(key)).length);
                ok(turns.slice(0, NV).every((x) => x[0] === '7:DDB4' && x[1] === '7:DD69'), 'search: the power read first every turn (' + turns.map((x) => x.join(' ')).join(' | ') + ')');
                ok(v12n.slice(0, NV).every((n) => n === 1) && fresh.every(Boolean), 'search: 1 candidate a turn, the power fresh after each (' + v12n.join() + ' / ' + fresh.join() + ')');
                ok(k.fails.v12 === 1, 'search: one failure for the whole search, not one a turn (' + k.fails.v12 + ')');
            });
        }).then(() => {
            // 2026-11-11 (an X5 45e: the recovery / power meter vanished after a while): the battery unit goes quiet for
            // a few seconds mid-drive, behind a link that, like the real one, skips a unit after 5 misses in a row
            // until woken. The power is back within seconds, not a minute, and the other voltages are never searched
            const base = linkFor({ '7:DDB4': [0x89, 0xA8], '7:DD69': [0xFF, 0xFF, 0xD8, 0xF0] }), phys = base.physical;
            let quiet = false;
            const link = { asked: base.asked, misses: 0, woke: 0, ready: true, available: true,
                wake() { this.misses = 0; this.woke++; },
                physical(ecu, sid, data) {
                    if (this.misses >= 5) { base.asked.push('skipped'); return Promise.resolve(null); }
                    if (quiet) { this.misses++; base.asked.push('quiet'); return Promise.resolve(null); }
                    this.misses = 0; return phys.apply(base, arguments);
                } };
            const k = mk(settingsFake({ hudHybridSeen: true }), link);
            k.want = { v12: false, hvSoc: false, hvKw: true };
            const turnAt = (dt) => { clock += dt; return k._turn(); };
            let c = turnAt(0).then(() => turnAt(500));
            const shown = [];
            return c.then(() => {
                ok(k.kwWorked && Math.abs(k.value().hvKw - 35.24) < 1e-9, 'quiet unit: the power read first (' + k.value().hvKw + ')');
                quiet = true; link.asked.length = 0;
                // 4 s quiet (8 turns), then answering again; a turn every 500 ms for 8 s more
                let q = Promise.resolve();
                for (let i = 0; i < 24; i++) q = q.then(() => { if (i === 8) quiet = false; return turnAt(500); }).then(() => { shown.push(k.value().hvKw !== null); });
                return q;
            }).then(() => {
                const back = shown.indexOf(true, 8);
                ok(back >= 8 && back <= 14, 'quiet unit: the meter back within 3 s of the unit answering again (turn ' + back + ' of ' + shown.length + ', ' + shown.map((x) => (x ? 1 : 0)).join('') + ')');
                ok(link.asked.indexOf('7:DD68') < 0 && link.asked.indexOf('7:DD66') < 0 && link.asked.indexOf('7:DDEF') < 0, 'quiet unit: the other voltages not searched on a hiccup (' + link.asked.slice(0, 12).join(' ') + ')');
                ok(link.woke >= 1 && lines.some((l) => /stopped giving the power; asked again every 2 s/.test(l)), 'quiet unit: woken for the retries, one line (' + lines.filter((l) => /power/.test(l)).join('|') + ')');
                // a unit that never gave the power keeps the once-a-minute back-off
                const never = mk(settingsFake({ hudHybridSeen: true }), linkFor({}));
                never.want = { v12: false, hvSoc: false, hvKw: true };
                return never._turn().then(() => never._turn()).then(() => never._turn()).then(() => {
                    ok(never.fails.kw === 3 && !never._may('kw', clock + 5000, [], never.kwWorked ? Electrical.KW_RETRY_MS : 60000) && never._may('kw', clock + 61000, []), 'never answered: asked once a minute, as before');
                });
            });
        }).then(() => { Date.now = realNow; }, (e) => { Date.now = realNow; throw e; });
    }).then(() => {
        // knock: its start and its once-a-minute try wake the engine unit (electrical's 12 V reads ask it too)
        const KnockWatch = require(path.join(APP, 'knock'));
        const linkK = linkFor({}); linkK.woke = []; linkK.wake = function (e) { this.woke.push(e); };
        const k = new KnockWatch({ log: log }, () => linkK);
        k.start(); k.stop();
        ok(linkK.woke.indexOf(0x12) >= 0, 'knock: a start wakes the engine unit');
        linkK.woke = []; k.busy = false; k.fails = 3; k.triedT = Date.now() - 61000; k._poll();
        ok(linkK.woke.indexOf(0x12) >= 0, 'knock: the once-a-minute try wakes the engine unit');
        ok(typeof Hud.writeAtomic === 'function', 'Hud.writeAtomic still there (code from before 2.0 calls it)');
        // Play on HUD: the tyre sample only on a car that sends tyres
        const hudSrc = fs.readFileSync(path.join(APP, 'hud.js'), 'utf8');
        ok(/if \(playing\) return w\.show !== 'off' && settings\.get\('hudTyresSeen'\) === true/.test(hudSrc), 'Play on HUD: no tyre widget on a car without tyre sensors');
        // the quiet log: the same kind of line once per 10 minutes, then with the count held back
        const QuietLog = require(path.join(APP, 'quietlog'));
        const lines = [], base = { info: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push('W ' + a.join(' ')), error: (...a) => lines.push('E ' + a.join(' ')), debug() {} };
        let t = 0;
        const q = QuietLog.wrap(base, () => t);
        q.info('knock: retard 2.6 deg'); q.info('knock: retard 3.0 deg'); q.info('knock: retard 4.1 deg'); q.info('hud: on'); q.error('boom'); q.error('boom');
        ok(lines.join('|') === 'knock: retard 2.6 deg|hud: on|E boom|E boom', 'quiet log: the same kind of line once, errors always (' + lines.join('|') + ')');
        t = QuietLog.REPEAT_MS + 1; q.info('knock: retard 2.3 deg');
        ok(lines[lines.length - 1] === 'knock: retard 2.3 deg (+2 like it)', 'quiet log: after 10 minutes again, with the count held back (' + lines[lines.length - 1] + ')');
        ok(QuietLog.wrap(q) === q, 'quiet log: wrapping twice is the same');
    });
}
