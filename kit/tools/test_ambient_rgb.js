'use strict';
// Ambient config's any colour (apps/ambient_config: lin.js, scenes.js, lights.js, control.js): the body controller's
// status read and writes, the animations, one write at a time with the lights renewed and given back, the
// driving modes' looks, favourites and the flash file.
//   node kit/tools/test_ambient_rgb.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-rgb-'));
process.env.MGU_AMBIENT_FLASH = path.join(TMP, 'flash.json');
const A = path.join(__dirname, '..', '..', 'apps', 'ambient_config');
const L = require(path.join(A, 'lin'));
const S = require(path.join(A, 'scenes'));
const { Lights } = require(path.join(A, 'lights'));
const { Control, DEFAULT_LOOK } = require(path.join(A, 'control'));

let fails = 0, checks = 0;
const ok = (c, msg) => { checks++; if (!c) { fails++; console.log('FAIL ' + msg); } };
const log = { info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// status reply: 62 DA5F, records of 10 (location, blue, green, red, brightness, white, 4 faults), empty FF
const reply = (did, locs, fault) => {
    const b = [0x62].concat(did);
    for (let i = 0; i < 26; i++) b.push.apply(b, locs[i] ? [locs[i], 254, 60, 120, 100, 0, fault === i ? 1 : 0, 0, 0, 0] : [0xff, 0xff, 0xff, 0xff, 0x7f, 3, 7, 7, 7, 7]);
    return b.concat([2]);
};
// the ring: a tap near red / green / blue gives exactly that colour; the < / > steps land on them (#135)
const same = (a, b) => a.join() === b.join();
ok(same(S.hsv(S.snapHue(3), 1, 1), [255, 0, 0]) && same(S.hsv(S.snapHue(357.5), 1, 1), [255, 0, 0]), 'a tap 3 degrees off red is red');
ok(same(S.hsv(S.snapHue(118), 1, 1), [0, 255, 0]) && same(S.hsv(S.snapHue(244), 1, 1), [0, 0, 255]), 'near green / blue: exactly green / blue');
ok(S.snapHue(20) === 20 && S.snapHue(90) === 90, 'a hue between them stays as tapped');
let h = S.hueOf([120, 60, 255]), seen = [];      // the default violet, 258.5 degrees
for (let i = 0; i < 24; i++) { h = S.stepHue(h, 15); seen.push(h); }
ok(seen.indexOf(0) >= 0 && seen.indexOf(120) >= 0 && seen.indexOf(240) >= 0 && seen.every((x) => x % 15 === 0 && x >= 0 && x < 360), '> from violet comes to 0, 120, 240 exactly');
ok(S.stepHue(0, -15) === 345 && S.stepHue(345, 15) === 0, '< from red wraps to 345, > back to red');
const bus1 = L.parseStatus(0, reply([0xda, 0x5f], [0x0f, 0x0e, 0x0c], 1));
ok(bus1.length === 3 && bus1[2].nad === 3 && bus1[2].name === 'Passenger front door line' && bus1[2].part === 'upper' && bus1[1].part === 'lower', 'status: lights, places, upper / lower');
ok(bus1[0].rgb.join() === '120,60,254' && bus1[0].bright === 100 && bus1[1].fault && !bus1[0].fault, 'status: colour read red, green, blue; a fault');
ok(L.parseStatus(0, [0x7f, 0x22, 0x31]) === null && L.parseStatus(1, reply([0xda, 0x5f], [1])) === null, 'status: a refusal or another bus\'s reply is none');
ok(L.writeFrame(0, 3, [255, 0, 300], 120, 400).join() === [0xda, 0x5e, 3, 1, 100, 0xfe, 0, 0xfe, 254].join(), 'write: colours stop at FE, brightness 100, 254 s');
ok(L.writeFrame(1, 1, [10, 20, 30], 50, 5).slice(0, 2).join() === [0xe3, 0xd1].join() && L.releaseFrame(1, 4).join() === [0xe3, 0xd1, 4, 0, 0, 0, 0, 0, 0].join(), 'bus 2 write; give back');
ok(L.sample().length === 19, 'the picture\'s G20 before the car answers');

// scenes
const look = (kind, extra) => Object.assign({ kind, upper: { rgb: [255, 0, 0], bright: 80 }, lower: { rgb: [0, 0, 255], bright: 40 }, speed: 2 }, extra);
const up = { part: 'upper', y: 0.2 }, low = { part: 'lower', y: 0.8 };
ok(S.lightAt(look('solid'), up, 0).rgb.join() === '255,0,0' && S.lightAt(look('solid'), low, 0).bright === 40, 'solid: upper and lower colours');
const br = [0, 1000, 2000].map((t) => S.lightAt(look('breathing'), up, t).bright);
ok(br[0] < 15 && br[2] === 80 && br[1] > br[0] && br[1] < br[2], 'breathing: dim to bright (' + br + ')');
ok(S.lightAt(look('rainbow'), up, 0).rgb.join() !== S.lightAt(look('rainbow'), up, 4000).rgb.join(), 'rainbow moves on');
ok(S.lightAt(look('fade'), up, 0).rgb.join() === '255,0,0' && S.lightAt(look('fade'), up, 4000).rgb.join() === '0,0,255', 'fade: upper colour to lower');
ok(S.lightAt(look('wave'), { part: 'upper', y: 0 }, 0).rgb.join() !== S.lightAt(look('wave'), { part: 'upper', y: 0.25 }, 0).rgb.join(), 'wave: front and rear differ');
ok(S.lightAt(look('welcome'), { part: 'upper', y: 0.9 }, 100).bright === 0 && S.lightAt(look('welcome'), { part: 'upper', y: 0.9 }, 2600).bright === 80, 'welcome: the rear comes on last');
ok(S.lightAt(look('pulse'), low, 1000).rgb.join() === '255,0,0' && S.lightAt(look('pulse'), low, 1600).rgb.join() === '0,0,255', 'pulse: red for 1.5 s, then the colour');
ok(S.lightAt(look('wave'), { part: 'upper', y: 0, bus: 0 }, 300).rgb.join() === S.lightAt(look('wave'), { part: 'lower', y: 0.8, bus: 0 }, 300).rgb.join()
    && S.lightAt(look('wave'), { part: 'upper', y: 0, bus: 0 }, 300).rgb.join() !== S.lightAt(look('wave'), { part: 'upper', y: 0, bus: 1 }, 300).rgb.join(),
    'wave on the car: one colour a bus, the buses apart');
ok(S.moves(look('wave')) && !S.moves(look('solid')) && S.lasts(look('welcome')) > 0 && S.lasts(look('wave')) === 0, 'moving and once-only scenes');
ok(Math.round(S.hueOf([0, 0, 255])) === 240 && S.hsv(120, 1, 1).join() === '0,255,0', 'hue');

(async () => {
    // a body controller (as the car's, BDC_G05): remembers each light's colour, NAD 0 colours every light of its bus,
    // reads report what the lights show; drop: the next write to that NAD is answered but not taken (as the car does)
    const BUS = [[0x0f, 0x0c], [0x15, 0x01, 0x05, 0x13]];
    const lit = BUS.map((b) => b.map(() => [0, 0, 0]));
    const writes = [];
    let refuse = false, drop = null, asleep = false, reads = 0;
    const diag = {
        physical: async (target, sid, data) => {
            await sleep(2);
            if (target !== L.BDC) return null;
            const bus = data[0] === 0xda ? 0 : 1;
            if (sid === 0x22 && asleep) return null;
            if (sid === 0x22) {
                reads++;
                const b = [0x62].concat(data);
                for (let i = 0; i < 26; i++) b.push.apply(b, BUS[bus][i] ? [BUS[bus][i], lit[bus][i][2], lit[bus][i][1], lit[bus][i][0], 100, 0, 0, 0, 0, 0] : [0xff, 0xff, 0xff, 0xff, 0x7f, 3, 7, 7, 7, 7]);
                return b.concat([2]);
            }
            writes.push(data.slice());
            if (refuse) return [0x7f, 0x2e, 0x22];
            const nad = data[2], rgb = data[3] ? data.slice(5, 8) : [0, 0, 0];
            if (drop !== null && drop.bus === bus && drop.nad === nad) drop = null;
            else if (nad === 0) lit[bus].forEach((x, i) => { lit[bus][i] = rgb; });
            else if (lit[bus][nad - 1]) lit[bus][nad - 1] = rgb;
            return [0x6e, data[0], data[1]];
        },
    };
    // a body module that answers "busy, ask again" (7F 22 21) to the first reads, as a G21's did (#197): asked again
    let busyLeft = 3;
    const busyDiag = { physical: (target, sid, data) => (sid === 0x22 && busyLeft-- > 0 ? Promise.resolve([0x7f, 0x22, 0x21]) : diag.physical(target, sid, data)) };
    const waited = [];
    const patient = new Lights({ diag: busyDiag, log, checkMs: 40, sleep: (ms) => { waited.push(ms); return Promise.resolve(); } });
    ok((await patient.find()).length === 6 && waited.join() === '400,800,1200', 'find: a busy body module asked again, later each time');
    patient.stop();
    const lights = new Lights({ diag, log, checkMs: 40 });
    const found = await lights.find();
    ok(found.length === 6 && lights.state === 'car', 'find: both buses, nothing written yet');
    ok(writes.length === 0, 'nothing written before a colour is picked');

    // the lights known from an earlier start: the colour out before any read, the same lights kept by find()
    const fresh = new Lights({ diag, log, checkMs: 40, known: JSON.parse(JSON.stringify(found)) });
    ok(fresh.lights.length === 6 && fresh.state === 'car', 'known lights: there before a read');
    fresh.show(look('solid', { upper: { rgb: [0, 0, 255], bright: 80 }, lower: { rgb: [0, 0, 255], bright: 80 } }));
    await sleep(20);
    ok(writes.length >= 1 && writes[0][0] === 0xda && writes[0][2] === 0, 'known lights: the first write right away, NAD 0');
    let saved = null;
    fresh.on('found', (l) => { saved = l; });
    const before = fresh.lights[0];
    await fresh.find();
    ok(saved && saved.length === 6 && fresh.lights[0] === before, 'find(): the lights said (to keep), the known ones the same');
    fresh.stop();
    await sleep(100);
    writes.length = 0; lit.forEach((b) => b.forEach((x, i) => { b[i] = [0, 0, 0]; }));
    ok(!new Lights({ diag, log, known: [{ bus: 9 }] }).lights.length, 'known lights that are not lights: none');

    reads = 0;
    lights.show(look('solid', { lower: { rgb: [255, 0, 0], bright: 80 } }));
    await sleep(100);
    ok(writes.length === 4 && writes.every((w) => w[2] === 0) && lights.state === 'ours', 'one colour on every light: one write a bus, NAD 0, sent once more (' + writes.length + ')');
    ok(lit[0].concat(lit[1]).every((c) => c.join() === '254,0,0'), 'every light red');

    writes.length = 0;
    lights.show(look('solid'));
    await sleep(100);
    const fw = writes.find((w) => w[0] === 0xe3 && w[2] === 2);
    ok(writes.length === 4 && writes.every((w) => w[2] !== 0), 'from all red to lower blue: only the two lower lights written (and once more), the red ones left as they are (' + writes.map((w) => w[2]).join() + ')');
    ok(fw && fw[4] === 40 && fw[7] === 0xfe && fw[8] === 60, 'the footwell (lower): blue at 40 %, held 60 s');
    ok(lit[1][1].join() === '0,0,254' && lit[1][0].join() === '254,0,0', 'the footwell blue, the dash red');
    await sleep(300);
    ok(writes.length === 4 && reads === 0, 'a still colour: sent once more, nothing more until the renewal, no read-back');

    // the body controller drops a write (answered 6E, not taken): sent once more, it takes it
    writes.length = 0; drop = { bus: 1, nad: 0 };
    lights.show(look('solid', { upper: { rgb: [0, 255, 0], bright: 80 }, lower: { rgb: [0, 255, 0], bright: 80 } }));
    await sleep(400);
    ok(lit[1].every((c) => c.join() === '0,254,0') && writes.length === 4, 'a dropped write: taken when sent once more (' + writes.length + ')');

    writes.length = 0;
    lights.show(look('breathing', { speed: 3 }));
    await sleep(600);
    ok(writes.length > 10 && writes.every((w) => w[8] === 5) && writes.filter((w) => w[2] === 0).length > 5, 'moving: written over and over, held 5 s, a bus at a time (' + writes.length + ')');
    writes.length = 0;
    lights.show(look('rainbow'));
    await sleep(60);
    ok(writes.length >= 2 && writes.slice(0, 2).every((w) => w[2] === 0 && w.slice(5, 8).join() === writes[0].slice(5, 8).join()), 'rainbow: the whole car one colour, 2 writes a frame');
    writes.length = 0;
    lights.show(look('wave'));
    await sleep(100);
    ok(writes.length >= 2 && writes.every((w) => w[2] === 0) && writes[0].slice(5, 8).join() !== writes[1].slice(5, 8).join(),
        'a colour wave: a colour a bus, one write each (NAD 0), the two buses apart');

    writes.length = 0;
    lights.carColour();
    await sleep(300);
    const offs = writes.filter((w) => w[3] === 0 && w[8] === 0);
    ok(offs.length === 4 && offs.every((w) => w[2] === 0) && lights.state === 'car', 'original colour: every light given back, one write a bus, once more (' + writes.map((w) => w[2] + '/' + w[3]).join() + ')');
    ok(lit[0].concat(lit[1]).every((c) => c.join() === '0,0,0'), 'every light given back');

    writes.length = 0;
    lights.flash([0, 255, 0], 200);
    await sleep(120);
    ok(writes.length >= 2 && writes.slice(0, 2).every((w) => w[2] === 0 && w[5] === 0 && w[6] === 0xfe), 'flash: green on every light, one write a bus');
    await sleep(500);
    ok(lit[0].concat(lit[1]).every((c) => c.join() === '0,0,0'), 'after the flash with the car\'s colour on: given back');

    // an overlay with the car's own colour on: only the lights it picks are written, the rest keep the car's colour
    writes.length = 0;
    lights.overlay('doors', (l) => l.name === 'Driver front door line', () => ({ rgb: [255, 0, 0], bright: 100 }));
    await sleep(150);
    ok(writes.length >= 1 && writes.every((w) => w[0] === 0xe3 && w[2] === 3) && lit[1][2].join() === '254,0,0' && lit[1][0].join() === '0,0,0',
        'an open door: its light red alone, no write to the whole bus (' + writes.map((w) => w[2]).join() + ')');
    writes.length = 0;
    lights.overlay('turn', (l) => /^Passenger/.test(l.name), (t) => ({ rgb: [0, 230, 60], bright: 50 }));
    await sleep(150);
    ok(writes.some((w) => w[0] === 0xda && w[2] === 0) && lit[0].every((c) => c.join() === '0,230,60') && lit[1][2].join() === '254,0,0',
        'a turn signal\'s glow over that side (a bus all of it: one write), the door still red');
    // a blink: on one frame, off the next
    writes.length = 0;
    lights.overlay('turn', (l) => l.name === 'Driver front door line', (t, on) => (on ? { rgb: [0, 230, 60], bright: 100 } : { rgb: [0, 0, 0], bright: 0 }));
    await sleep(200);
    const nad3 = writes.filter((w) => w[0] === 0xe3 && w[2] === 3).map((w) => w[4]);
    ok(nad3.length >= 4 && nad3.every((b, i) => i === 0 || b !== nad3[i - 1]), 'a blink: fully on, then dark, write after write (' + nad3.join() + ')');
    lights.overlay('doors', null); lights.overlay('turn', null);
    await sleep(300);
    ok(lit[0].concat(lit[1]).every((c) => c.join() === '0,0,0'), 'both taken off with the car\'s colour on: given back');

    refuse = true; writes.length = 0;
    lights.show(look('solid', { upper: { rgb: [1, 2, 3], bright: 50 } }));
    await sleep(400);
    ok(writes.length === 4 && /refused/.test(lights.error), 'refused writes: paused after 4 (' + writes.length + ', ' + lights.error + ')');
    // giving back to a body module that no longer answers (the car going to sleep): each bus tried 3 times, then left
    refuse = false; lights._pauseTill = 0;
    lights.show(look('solid', { upper: { rgb: [9, 9, 9], bright: 50 } }));
    await sleep(150);
    refuse = true; asleep = true; writes.length = 0;
    lights.carColour();
    await sleep(12500);
    const gb = writes.filter((w) => w[3] === 0);
    ok(gb.length <= 6 && gb.length >= 2, 'a give-back not taken: at most 3 tries a bus, then nothing more (' + gb.length + ')');
    writes.length = 0; await sleep(300);
    ok(writes.length === 0, 'and nothing after');
    refuse = false; asleep = false;
    lights.stop();

    // control: the driver's look, driving modes, favourites
    const values = { follow: true, keep: true, welcome: false, sportPulse: true, nightDim: true, flashAlerts: true }, fns = [];
    const settings = { get: (k) => values[k], set: (k, v) => { values[k] = v; fns.forEach((f) => f(k, v)); }, onChange: (f) => fns.push(f) };
    const shows = [];
    const fake = { scene: null, overs: {}, show(s) { this.scene = s; shows.push(s); }, carColour() { this.scene = null; shows.push(null); }, dim(f) { this.f = f; }, flash(rgb, ms) { this.flashed = [rgb, ms]; },
        overlay(k, test, at) { if (test) this.overs[k] = { test, at }; else delete this.overs[k]; } };
    const amb = new EventEmitter(); amb._m = 'comfort'; amb.mode = () => amb._m;
    const c = new Control({ settings, lights: fake, ambient: amb, log });
    c.start();
    ok(shows.length === 1 && shows[0] === null, 'start: nothing picked, the car\'s colour');
    c.setLook({ upper: { rgb: [0, 255, 0], bright: 70 } });
    ok(values.on === true && fake.scene.upper.rgb.join() === '0,255,0' && fake.scene.lower.rgb.join() === DEFAULT_LOOK.lower.rgb.join(), 'a colour picked: on, the rest of the look kept');
    c.setModeLook('sport', look('breathing'));
    amb._m = 'sport'; amb.emit('change');
    ok(fake.scene.kind === 'pulse' && fake.scene.then.kind === 'breathing', 'Sport picked: the pulse, then Sport\'s look');
    amb._m = 'comfort'; amb.emit('change');
    ok(fake.scene.kind === 'solid' && fake.scene.upper.rgb.join() === '0,255,0', 'Comfort (Leave as is): the driver\'s look back');
    settings.set('follow', false); c.apply();
    amb._m = 'sport'; amb.emit('change');
    ok(fake.scene.upper.rgb.join() === '0,255,0' && fake.scene.kind !== 'breathing', 'not following: the driver\'s look in Sport too');
    settings.set('follow', true);
    c.carColour();
    amb._m = 'comfort'; amb.emit('change');
    ok(fake.scene === null, 'car colour back, Comfort Leave as is: the car\'s colour');
    c.setLook({ upper: { rgb: [0, 255, 0], bright: 70 } });
    c.setModeLook('comfort', 'original');
    ok(fake.scene === null && c.modeOriginal('comfort'), 'Comfort on Original colour: BMW\'s colour, the Colour tab\'s colour on');
    c.setModeLook('comfort', null);
    ok(fake.scene && fake.scene.upper.rgb.join() === '0,255,0', 'Original colour undone: the Colour tab\'s colour back');
    c.carColour();
    c.night(true); ok(fake.f === 0.5, 'night: dimmer');
    settings.set('nightDim', false); c.night(true); ok(fake.f === 1, 'night dimming off');

    for (let i = 0; i < 7; i++) { c.setLook({ upper: { rgb: [i, 0, 0], bright: 50 } }); c.saveFav(); }
    ok(c.favs().length === 6 && c.favs()[0].upper.rgb[0] === 1, 'favourites: six, the oldest goes');
    c.useFav(2); ok(c.look().upper.rgb[0] === 3 && values.on, 'a favourite put on');
    c.dropFav(0); ok(c.favs().length === 5, 'a favourite deleted');

    fs.writeFileSync(process.env.MGU_AMBIENT_FLASH, JSON.stringify({ rgb: [0, 255, 0], ms: 900 }));
    await sleep(700);
    ok(fake.flashed && fake.flashed[1] === 1000, 'the flash file: a flash, at least 1 s (all the lights)');
    settings.set('flashAlerts', false); fake.flashed = null;
    await sleep(50);
    fs.writeFileSync(process.env.MGU_AMBIENT_FLASH, JSON.stringify({ rgb: [0, 255, 0], ms: 900 }));
    const t = new Date(Date.now() + 2000); fs.utimesSync(process.env.MGU_AMBIENT_FLASH, t, t);
    await sleep(700);
    ok(!fake.flashed, 'flashes off: none');
    c.stop();

    // the car locked and left: the car's own light; someone back in: the look again
    c.setLook({ kind: 'solid', upper: { rgb: [0, 0, 255], bright: 60 } });
    c.away(true);
    ok(fake.scene === null && values.on === true, 'parked, nobody in: the car\'s own light, the look kept for later');
    c.away(false);
    ok(fake.scene && fake.scene.upper.rgb.join() === '0,0,255', 'someone back in: the look again');
    // the turn signals and the doors over the look, each with its setting
    const pl = (code) => L.place(code);
    // both off until switched on (a car on Original colour gets no writes from a turn signal or a door)
    c.turn('left'); c.doors(['driver front']);
    ok(!fake.overs.turn && !fake.overs.doors, 'Turn signal glow and Open door red: off by default');
    c.turn(null); c.doors([]);
    values.turnGlow = true; values.doorRed = true;
    c.turn('left');
    ok(fake.overs.turn && fake.overs.turn.test(pl(0x05)) && fake.overs.turn.test(pl(0x19)) && !fake.overs.turn.test(pl(0x0c)) && !fake.overs.turn.test(pl(0x01)),
        'left turn signal: the driver\'s side lights (left-hand drive), not the footwells nor the other side');
    const g = [true, false].map((on) => fake.overs.turn.at(0, on));
    ok(g[0].rgb.join() === '0,230,60' && g[0].bright === 100 && g[1].bright === 0 && g[1].rgb.join() === '0,0,0', 'its blink: green fully on, then dark');
    values.drive = 'rhd'; c.turn('left');
    ok(fake.overs.turn.test(pl(0x0c)) && !fake.overs.turn.test(pl(0x05)), 'right-hand drive: left is the passenger\'s side');
    values.drive = 'lhd'; c.turn('both');
    ok(fake.overs.turn.test(pl(0x05)) && fake.overs.turn.test(pl(0x0c)), 'hazards: both sides');
    ok(!fake.overs.hazard, 'Hazard red: off by default');
    settings.set('hazardRed', true); c.signals();
    const hz = fake.overs.hazard;
    ok(hz && hz.test(pl(0x05)) && hz.test(pl(0x01)) && hz.test(pl(0x13)) && !fake.overs.turn, 'Hazard red on: every light, in place of the green glow');
    const hp = [true, false].map((on) => hz.at(0, on));
    ok(hp[0].rgb.join() === '255,0,0' && hp[0].bright === 100 && hp[1].rgb.join() === '255,0,0' && hp[1].bright > 0 && hp[1].bright < 50, 'its pulse: red bright, then dim');
    c.turn('left');
    ok(!fake.overs.hazard && fake.overs.turn && fake.overs.turn.test(pl(0x05)), 'a plain turn signal: no red, the green glow');
    c.turn('both'); c.away(true);
    ok(!fake.overs.hazard, 'the car locked and left: no red pulse');
    c.away(false);
    ok(fake.overs.hazard, 'someone back in, hazards still on: the pulse again');
    settings.set('hazardRed', false); c.signals();
    ok(!fake.overs.hazard && fake.overs.turn, 'Hazard red off: the green glow on both sides again');
    c.away(true);
    ok(!fake.overs.turn, 'the car locked and left: no glow');
    c.away(false); c.turn(null);
    ok(!fake.overs.turn, 'turn signal off: the glow off');
    settings.set('turnGlow', false); c.turn('right');
    ok(!fake.overs.turn, 'Turn signal glow off: none');
    c.doors(['passenger rear']);
    ok(fake.overs.doors && fake.overs.doors.test(pl(0x10)) && fake.overs.doors.test(pl(0x22)) && fake.overs.doors.test(pl(0x45)) && !fake.overs.doors.test(pl(0x0c))
        && fake.overs.doors.at(0, true).rgb.join() === '255,0,0' && fake.overs.doors.at(0, false).bright === 0, 'the passenger rear door open: its lights blink red, the front door\'s not');
    c.away(true);
    ok(!fake.overs.doors, 'the car locked and left with a door open: no red, so the body module can sleep');
    c.away(false);
    ok(fake.overs.doors && fake.overs.doors.test(pl(0x10)), 'someone back in, the door still open: red again');
    c.doors([]);
    ok(!fake.overs.doors, 'closed: red off');
    settings.set('doorRed', false); c.doors(['driver front']);
    ok(!fake.overs.doors, 'Open door red off: none');
    // a car with door lines (G20): only those blink, one write each a frame; a door without its own line: all its lights
    fake.lights = [0x05, 0x07, 0x08, 0x09, 0x0b, 0x21, 0x13, 0x01, 0x0c, 0x0e, 0x0f, 0x10, 0x12, 0x22, 0x04].map(pl);
    settings.set('turnGlow', true); settings.set('doorRed', true); c.turn('left');
    ok(fake.overs.turn.test(pl(0x05)) && fake.overs.turn.test(pl(0x09)) && !fake.overs.turn.test(pl(0x07)) && !fake.overs.turn.test(pl(0x0b))
        && !fake.overs.turn.test(pl(0x0c)), 'door lines on the car: the turn glow blinks the driver\'s front and rear door lines only');
    c.doors(['passenger rear']);
    ok(fake.overs.doors.test(pl(0x10)) && !fake.overs.doors.test(pl(0x12)) && !fake.overs.doors.test(pl(0x22)) && !fake.overs.doors.test(pl(0x0c)),
        'door lines on the car: an open door blinks its own line only');
    // a G26: each door line in two strips (0x62-0x65); only the first blinks, so the blink keeps its pace (#169)
    c.doors([]); fake.lights = fake.lights.concat([0x62, 0x63, 0x64, 0x65].map(pl)); c.turn(null); c.turn('left'); c.doors(['passenger front']);
    ok(fake.overs.turn.test(pl(0x05)) && fake.overs.turn.test(pl(0x09)) && !fake.overs.turn.test(pl(0x62)) && !fake.overs.turn.test(pl(0x63))
        && fake.overs.doors.test(pl(0x0c)) && !fake.overs.doors.test(pl(0x64)), 'two-strip door lines: the turn glow and an open door blink the first strip only');
    fake.lights = fake.lights.filter((l) => l.loc < 0x62);
    c.doors([]); c.doors(['driver front']);
    fake.lights = fake.lights.filter((l) => l.loc !== 0x05);
    ok(fake.overs.doors.test(pl(0x07)) && fake.overs.doors.test(pl(0x08)), 'a door without its line: its other lights blink');
    delete fake.lights;
    values.turnGlow = undefined; values.doorRed = undefined; c.doors([]); c.turn(null);
    // a restart with Welcome on: the sweep, then the look
    values.welcome = true; shows.length = 0;
    const c2 = new Control({ settings, lights: fake, ambient: amb, log });
    c.setLook({ kind: 'solid' }); shows.length = 0;
    c2.start();
    ok(shows[0].kind === 'welcome' && shows[0].then.kind === 'solid', 'welcome sweep at start, then the look');
    c2.stop();

    // hold (the strobe talks to the body controller): no write while held, the one under way finished first, then on again
    {
        refuse = false; asleep = false; drop = null;
        const lh = new Lights({ diag, log, checkMs: 40 });
        await lh.find();
        lh.show(look('wave'));
        for (let i = 0; i < 500 && !lh._running; i++) await new Promise((r) => setImmediate(r));   // a write under way
        const busy = lh._running;
        await lh.hold('strobe', true);
        ok(busy && !lh._running && lh.held, 'hold: resolves once the write under way is done');
        writes.length = 0;
        await sleep(200);
        ok(writes.length === 0, 'held: a moving scene writes nothing (' + writes.length + ' writes)');
        lh.hold('other', true); lh.hold('strobe', false);
        await sleep(100);
        ok(writes.length === 0, 'still held by another key: nothing written');
        lh.hold('other', false);
        await sleep(100);
        ok(writes.length > 0 && !lh.held, 'let go: the scene is written again (' + writes.length + ' writes)');
        lh.stop && lh.stop();
        await sleep(50);
    }

    fs.unlinkSync(process.env.MGU_AMBIENT_FLASH); fs.rmdirSync(TMP);
    console.log('ambient rgb: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
