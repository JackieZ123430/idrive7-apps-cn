'use strict';
// Ambient config's high beam strobe and light show (apps/ambient_config/strobe.js) against a fake car: FLM01 headlight
// units (0x43 / 0x44, as on a car: 22 D667, 31 01 3000), FLE ones (high beam learned), and the body controller of each
// kind (BDC: 22 4500 / 2F 4501, BDC_G05: 22 E3B9 / 2F E3B5). Which one it is (reads only), the exact requests, the first
// flash checked, the session kept with 3E 00, and the lamps handed back however it ends.
//   node kit/tools/test_ambient_strobe.js
const path = require('path');
const { Strobe, MAX_MS, gateChecks, gateWhy } = require(path.join(__dirname, '..', '..', 'apps', 'ambient_config', 'strobe'));

let fails = 0, checks = 0;
const ok = (c, msg) => { checks++; if (!c) { fails++; console.log('FAIL ' + msg); } };
const hex = (b) => b.map((x) => (x < 16 ? '0' : '') + x.toString(16).toUpperCase()).join(' ');

// the low beam as the car's FLM01 showed it: channels 2-4 1000 mA 88 %, 5 30 %, 10 35 %, 12 200 mA 100 %
const LOW = [0, 0, 0x64, 0x58, 0x64, 0x58, 0x64, 0x58, 0x64, 0x1E, 0, 0, 0, 0, 0, 0, 0, 0, 0x64, 0x23, 0, 0, 0x14, 0x64];
// BMW's lamp test for all LEDs (31 01 A543 FF) on that car: channels 1-5, 7, 9, 10 at 1000 mA, 12 at 200 mA (6, 8, 11 not fitted)
const ALL = [0x64, 0x0D, 0x64, 0x0D, 0x64, 0x0D, 0x64, 0x0D, 0x64, 0x0E, 0, 0, 0x64, 0x0D, 0, 0, 0x64, 0x0E, 0x64, 0x0E, 0, 0, 0x14, 0x0E];
const FULL = ALL.map((x, i) => (i % 2 && ALL[i - 1] ? 100 : x));

/** car: 'flm' | 'fle' | 'bdc' | 'g05' | 'none'; o: deaf (lamps do not follow), noSession, refuseAfter, highOn (stalk) */
function fakeCar(car, o, clock) {
    const opt = o || {};
    const sent = [], out = {}, head = { 0x43: LOW.slice(), 0x44: LOW.slice() };
    const session = {};
    const n = car === 'fle' ? 7 : 12;
    if (car === 'fle') { head[0x43] = LOW.slice(0, 14); head[0x44] = LOW.slice(0, 14); }
    const status = () => { const b = new Array(31).fill(0); b[0] = 0xFF; [7, 8].forEach((el) => { b[el] = opt.deaf ? 0 : out[el] || 0; }); return b; };
    return {
        sent, out, head, session,
        stalk(on) { [0x43, 0x44].forEach((a) => { head[a][0] = on ? 0x64 : 0; head[a][1] = on ? 0x4B : 0; }); },
        async send(target, sid, data) { sent.push(hex([target, sid].concat(data))); return { ok: true }; },
        async physical(target, sid, data) {
            sent.push(hex([target, sid].concat(data)));
            clock.t += 200; await new Promise((r) => setImmediate(r));       // a request takes ~200 ms on the car
            const isHead = (car === 'flm' || car === 'fle' || car === 'fnflm') && (target === 0x43 || target === 0x44);
            if (target !== 0x40 && !isHead) return null;
            if (sid === 0x10) {
                if (opt.noSession) return [0x7F, 0x10, 0x22];
                session[target] = data[0];
                if (data[0] === 0x01 && isHead) head[target] = (car === 'fle' ? LOW.slice(0, 14) : LOW.slice());
                return [0x50, data[0], 0, 0x32, 0x01, 0xF4];
            }
            if (sid === 0x3E) return data[0] === 0x80 ? null : [0x7E, 0x00];
            if (isHead) {
                const did = car === 'fle' ? [0xD6, 0x31] : [0xD6, 0x67];
                if (sid === 0x22 && data[0] === 0xD6 && data[1] === 0x30) return car === 'flm' || car === 'fnflm' ? [0x62, 0xD6, 0x30].concat(new Array(8).fill(60), new Array(12).fill((opt.hotC || 50) + 40)) : [0x7F, 0x22, 0x31];
                if (sid === 0x22) return data[0] === did[0] && data[1] === did[1] ? [0x62].concat(did, opt.deaf ? LOW.slice(0, 2 * n) : head[target]) : [0x7F, 0x22, 0x31];
                if (sid === 0x31 && data[0] === 0x02 && data[1] === 0x30 && data[2] === 0x00) return session[target] === 0x03 ? [0x71, 0x02, 0x30, 0x00] : [0x7F, 0x31, 0x7F];
                if (sid === 0x31 && data[0] === 0x01 && data[1] === 0xA5 && data[2] === 0x43) {
                    if (session[target] !== 0x03) return [0x7F, 0x31, 0x31];
                    head[target] = ALL.slice(0, 2 * n);
                    return [0x71, 0x01, 0xA5, 0x43];
                }
                if (sid === 0x31 && data[0] === 0x01 && data[1] === 0x30 && data[2] === 0x00) {
                    if (session[target] !== 0x03) return [0x7F, 0x31, 0x31];
                    if (opt.refuseAfter != null && sent.filter((x) => / 31 01 30 00/.test(x)).length > opt.refuseAfter) return [0x7F, 0x31, 0x22];
                    if (data.length !== 3 + 2 * n) return [0x7F, 0x31, 0x13];
                    head[target] = data.slice(3);
                    return [0x71, 0x01, 0x30, 0x00];
                }
                return [0x7F, sid, 0x31];
            }
            if ((car === 'fn' || car === 'fnflm') && sid === 0x22) return data[0] === 0xD5 && data[1] === 0x42 ? [0x62, 0xD5, 0x42].concat(new Array(20).fill(0)) : [0x7F, 0x22, 0x31];
            if ((car === 'fn' || car === 'fnflm') && sid === 0x2E) {
                if (data[0] !== 0xD5 || data[1] !== 0x42 || data.length !== 6) return [0x7F, 0x2E, 0x13];
                if (session[0x40] !== 0x03) return [0x7F, 0x2E, 0x7F];
                if (opt.refuseAfter != null && sent.filter((x) => / 2E D5 42/.test(x)).length > opt.refuseAfter) return [0x7F, 0x2E, 0x22];
                return [0x6E, 0xD5, 0x42];
            }
            if (sid === 0x22) {
                if (car === 'bdc' && data[0] === 0x45 && data[1] === 0x00) return [0x62, 0x45, 0x00].concat(status());
                if (car === 'g05' && data[0] === 0xE3 && data[1] === 0xB9) return [0x62, 0xE3, 0xB9].concat(status());
                return [0x7F, 0x22, 0x31];
            }
            if (sid === 0x2F) {
                const did = car === 'bdc' ? [0x45, 0x01] : [0xE3, 0xB5];
                if (data[0] !== did[0] || data[1] !== did[1]) return [0x7F, 0x2F, 0x31];
                if (data.length !== 5) return [0x7F, 0x2F, 0x13];
                if (opt.refuseAfter != null && sent.filter((x) => / 2F /.test(x)).length > opt.refuseAfter && data[2] === 0x03 && data[4] === 1) return [0x7F, 0x2F, 0x22];
                if (data[2] === 0x03) out[data[3]] = data[4]; else if (data[2] === 0x00) delete out[data[3]];
                return [0x6F].concat(data.slice(0, 3));
            }
            if (sid === 0x2E) return car === 'g05' && data[0] === 0x45 && data[1] === 0x30 ? [0x6E, 0x45, 0x30] : [0x7F, 0x2E, 0x31];
            return null;
        },
    };
}
const log = { info() {}, warn() {} };
function make(car, o) {
    const clock = { t: 0 };
    const diag = fakeCar(car, o, clock);
    const s = new Strobe({ diag, log, channels: o && o.channels, allowed: (o && o.allowed) || (() => null), now: () => clock.t,
        sleep: (ms) => new Promise((r) => { clock.t += Math.max(ms, 1); setImmediate(r); }) });
    s._clock = clock;
    return { s, diag };
}
const backOf = (did) => ['40 2F ' + did + ' 03 07 00', '40 2F ' + did + ' 00 07 00', '40 2F ' + did + ' 03 08 00', '40 2F ' + did + ' 00 08 00', '40 10 01'];
const endsWithBack = (sent, did) => JSON.stringify(sent.slice(-5)) === JSON.stringify(backOf(did));
const headBack = (diag) => diag.sent.slice(-2).join() === '43 10 01,44 10 01' && diag.head[0x43][0] === 0 && diag.head[0x44][0] === 0;
/** stop() once the car has had n requests */
const stopAfter = (s, diag, n) => { const tick = () => (diag.sent.length >= n ? s.stop() : setImmediate(tick)); setImmediate(tick); };
const writes = (diag, a) => diag.sent.filter((x) => x.indexOf(hex([a]) + ' 31 01 30 00') === 0).map((x) => x.split(' ').slice(5).map((b) => parseInt(b, 16)));

(async () => {
    // which way to the lamps (reads only)
    for (const [car, want] of [['fn', 'fn'], ['flm', 'flm'], ['fle', 'fle'], ['bdc', 'bdc'], ['g05', 'g05'], ['none', null]]) {
        const { s, diag } = make(car);
        ok(await s.find() === want && diag.sent.every((x) => / 22 /.test(x)), car + ': found as ' + want + ' with reads only');
    }

    // the body controller's light functions: one request one flash, timed by the car
    const fns = (diag) => diag.sent.filter((x) => /^40 2E D5 42/.test(x)).map((x) => x.split(' ').slice(4).map((b) => parseInt(b, 16)));
    {
        const { s, diag } = make('fn');
        await s.find(); diag.sent.length = 0;
        const run = s.start({ pattern: 'police', lights: 'all', rate: 'fast' });
        stopAfter(s, diag, 16);
        await run;
        const f = fns(diag);
        ok(diag.sent[0] === '40 10 03', 'light functions: the extended session first');
        ok(f.slice(0, 8).map((x) => x[1]).join() === '5,5,5,5,5,5,5,5' && f.slice(0, 8).every((x) => x[0] === 0 && x[2] === 0 && x[3] === 8),
            'police without headlight units: high beam bursts, 80 ms each (' + f.slice(0, 6).map((x) => hex(x)).join(' / ') + ')');
        const offs = f.filter((x) => x[3] === 0).map((x) => x[1]).sort((a, b) => a - b).join();
        ok(offs === '5' && diag.sent[diag.sent.length - 1] === '40 10 01', 'stopped: each used light switched off (time 0), the default session');
        ok(f.every((x) => x[2] * 256 + x[3] <= 15), 'never more than 150 ms lit a request');
    }
    {
        const { s, diag } = make('fn');
        await s.find(); diag.sent.length = 0;
        const run = s.start({ pattern: 'both', lights: 'high', rate: 'slow' });
        stopAfter(s, diag, 6);
        await run;
        const f = fns(diag).filter((x) => x[3]);
        ok(f.length && f.every((x) => x[1] === 5 && x[3] === 15), 'strobe, high beam, slow: the high beam 150 ms a flash');
    }
    {
        const { s, diag } = make('fn', { refuseAfter: 3 });
        await s.find(); diag.sent.length = 0;
        await s.start({});
        ok(/refused \(NRC 22\)/.test(s.note) && diag.sent[diag.sent.length - 1] === '40 10 01', 'light functions refused: stopped, the session dropped');
    }
    {
        const { s, diag } = make('fn');
        await s.find(); diag.sent.length = 0;
        await s.start({ rate: 'fast' });
        ok(/done \(30 s\)/.test(s.note), 'light functions: 30 s a press at most (' + s.note + ')');
        const n = diag.sent.length;
        await s.start({});
        ok(diag.sent.length === n && /rest/.test(s.note), 'then the lights rest');
        s._clock.t += 60000;
        const run = s.show({ rate: 'fast' });
        stopAfter(s, diag, n + 14);
        await run;
        const f = fns({ sent: diag.sent.slice(n) }).slice(0, 12).map((x) => x[1]);
        ok(f.join() === '5,9,10,8,6,7,16,17,12,15,14,13', 'light show: every outside light in turn (' + f.join() + ')');
    }

    // police with the headlight units: one side held at its own lights, the high beam bursts show on the other
    {
        const { s, diag } = make('fnflm');
        ok(await s.find() === 'fn' && s.mask && s.mask.sides.join() === '67,68' && diag.sent.every((x) => / 22 /.test(x)), 'light functions and FLM01 headlights found, reads only');
        diag.sent.length = 0;
        const run = s.start({ pattern: 'police', rate: 'fast', burst: 3, order: 'lrb', flashMs: 100 });
        stopAfter(s, diag, 40);
        await run;
        const seq = diag.sent.filter((x) => / 31 0[12] 30 00|2E D5 42/.test(x)).map((x) => /2E D5 42 00 05 00 0A/.test(x) ? 'H' : /2E D5 42/.test(x) ? 'h0' : x.slice(0, 2) + (/ 31 01/.test(x) ? 'hold' : 'free'));
        ok(seq.slice(0, 23).join() === '44hold,H,H,H,44free,43hold,H,H,H,43free,H,H,H,43hold,H,H,H,43free,44hold,H,H,H,44free',
            'police: left (right held), right (left held), both, right, left, then both (' + seq.join() + ')');
        ok(JSON.stringify(writes(diag, 0x44)[0]) === JSON.stringify(LOW), 'the held side: exactly its own lights as read, nothing brighter');
        ok(/ 31 02 30 00,40 2E D5 42 00 05 00 00,43 10 01,44 10 01,40 10 01$/.test(diag.sent.join()), 'stopped: let go, high beam off, every session back to default (' + diag.sent.slice(-5).join(', ') + ')');
    }

    // police as it comes: 4 flashes of 80 ms, left, both, right, both
    {
        const { s, diag } = make('fnflm');
        await s.find(); diag.sent.length = 0;
        const run = s.start({});
        stopAfter(s, diag, 40);
        await run;
        const seq = diag.sent.filter((x) => / 31 0[12] 30 00|2E D5 42 00 05 00 08/.test(x)).map((x) => /2E D5 42/.test(x) ? 'H' : x.slice(0, 2) + (/ 31 01/.test(x) ? 'hold' : 'free'));
        ok(seq.slice(0, 17).join() === '44hold,H,H,H,H,44free,H,H,H,H,43hold,H,H,H,H,43free,H', 'police by default: 4 flashes of 80 ms, left, both, right, both (' + seq.join() + ')');
    }
    // hot headlights stop police too
    {
        const { s, diag } = make('fnflm', { hotC: 95 });
        await s.find(); diag.sent.length = 0;
        await s.start({});
        ok(/hot \(95 °C\)/.test(s.note) && !diag.sent.some((x) => /2E D5 42 00 05 00 [^0]/.test(x)), 'police: hot headlights, no flash (' + s.note + ')');
    }
    // at most 2 minutes of flashing in 10
    {
        const { s, diag } = make('fn');
        await s.find();
        for (let i = 0; i < 4; i++) { await s.start({ pattern: 'both' }); s._clock.t += 31000; }
        diag.sent.length = 0;
        await s.start({ pattern: 'both' });
        ok(diag.sent.length === 0 && /2 min in the last 10 min/.test(s.note), 'after 2 minutes of flashing: rest (' + s.note + ')');
        s._clock.t += 600000;
        await s.start({ pattern: 'both' });
        ok(/done/.test(s.note), 'and after the rest it flashes again');
    }

    // police tuned: 2 flashes a burst, 50 ms, left / right only, 2 flashes a second
    {
        const { s, diag } = make('fnflm');
        await s.find(); diag.sent.length = 0;
        const at = [];
        const orig = diag.physical;
        diag.physical = async (t, sid, data) => { if (sid === 0x2E && data[3] === 0x05 && data[5]) at.push(s._clock.t); return orig(t, sid, data); };
        const run = s.start({ pattern: 'police', burst: 2, flashMs: 50, order: 'lr', every: 500 });
        stopAfter(s, diag, 24);
        await run;
        const seq = diag.sent.filter((x) => / 31 0[12] 30 00|2E D5 42 00 05 00 05/.test(x)).map((x) => /2E D5 42 00 05 00 05/.test(x) ? 'H' : /2E D5 42/.test(x) ? '?' : x.slice(0, 2) + (/ 31 01/.test(x) ? 'hold' : 'free'));
        ok(seq.slice(0, 10).join() === '44hold,H,H,44free,43hold,H,H,43free,44hold,H', 'tuned police: 2 flashes of 50 ms a side, left and right only (' + seq.join() + ')');
        ok(at.length >= 2 && at[1] - at[0] >= 500, 'tuned police: 2 flashes a second (' + (at[1] - at[0]) + ' ms apart)');
    }
    {
        const { s, diag } = make('fn');
        await s.find(); diag.sent.length = 0;
        const run = s.start({ pattern: 'both', lights: 'high', flashMs: 999, every: 0 });
        stopAfter(s, diag, 6);
        await run;
        ok(fns(diag).filter((x) => x[3]).every((x) => x[3] === 15), 'a flash never longer than 150 ms, whatever is asked');
    }

    // FLM01, all lights: the lamp test read once for the fitted channels, then every one at full against dark
    {
        const { s, diag } = make('flm');
        await s.find(); diag.sent.length = 0;
        const run = s.start({ pattern: 'both', rate: 'fast' });
        stopAfter(s, diag, 20);
        await run;
        ok(diag.sent.slice(0, 4).join() === '43 10 03,44 10 03,43 22 D6 67,44 22 D6 67', 'all lights: session, the channels as they are');
        ok(diag.sent.indexOf('43 31 01 A5 43 FF') > 0 && diag.sent.indexOf('44 31 01 A5 43 FF') > 0, 'all lights: the lamp test for all LEDs on both sides');
        const w = writes(diag, 0x43);
        ok(JSON.stringify(w[0]) === JSON.stringify(FULL), 'all lights on: every fitted channel at its own current, 100 % (' + hex(w[0] || []) + ')');
        ok(w[1] && w[1].every((x) => x === 0), 'all lights off: all dark');
        ok(JSON.stringify(w[w.length - 1]) === JSON.stringify(LOW) && headBack(diag), 'all lights stopped: the channels as they were, the default session');
        const n = diag.sent.length;
        await s.start({ rate: 'fast' });
        ok(diag.sent.length === n && /rest/.test(s.note), 'right after a run: the LEDs rest first (' + s.note + ')');
        s._clock.t += 60000;
        const run2 = s.start({ rate: 'fast' });
        stopAfter(s, diag, n + 14);
        await run2;
        ok(diag.sent.slice(n).every((x) => x.indexOf('A5 43') < 0), 'the lamp test only once');
    }

    // FLM01, police: one side's flash at a time, one write each, from dark
    {
        const { s, diag } = make('flm');
        await s.find(); diag.sent.length = 0;
        const run = s.start({ pattern: 'police', rate: 'fast' });
        stopAfter(s, diag, 26);
        await run;
        const seq = diag.sent.filter((x) => / 31 01 30 00/.test(x)).map((x) => x.slice(0, 2) + (/ 31 01 30 00 64/.test(x) ? '+' : '-'));
        ok(seq.slice(0, 7).join() === '43-,44-,43+,43-,44+,44-,43+', 'police: both dark, then left on, left off, right on, right off (' + seq.join() + ')');
    }
    // the car's own current is the most: a learned value above it is cut down; a channel not fitted is never driven
    {
        const { s, diag } = make('flm', { channels: [{ ch: 1, cur: 0x96, pwm: 0x64 }, { ch: 6, cur: 0x64, pwm: 0x64 }] });
        await s.find(); diag.sent.length = 0;
        const run = s.start({ lights: 'high', rate: 'fast' });
        stopAfter(s, diag, 20);
        await run;
        const w = writes(diag, 0x43)[0] || [];
        ok(w[0] === 0x64 && w[10] === 0 && w[11] === 0, 'high beam: channel 1 cut to the car\'s 1000 mA, channel 6 (not fitted) dark (' + hex(w) + ')');
    }
    // hot headlights: not started
    {
        const { s, diag } = make('flm', { hotC: 95 });
        await s.find(); diag.sent.length = 0;
        await s.start({});
        ok(/hot \(95 °C\)/.test(s.note) && !diag.sent.some((x) => / 31 01 30 00 64/.test(x)) && headBack(diag), 'hot headlights: no flash (' + s.note + ')');
    }

    // FLM01, high beam: the low beam kept, channels 1 and 9 added at full
    {
        const { s, diag } = make('flm');
        await s.find(); diag.sent.length = 0;
        const run = s.start({ lights: 'high', pattern: 'both', rate: 'fast' });
        stopAfter(s, diag, 20);
        await run;
        ok(diag.sent[0] === '43 10 03' && diag.sent[1] === '44 10 03', 'FLM: the extended session on both sides first');
        const w = writes(diag, 0x43);
        const on = LOW.slice(); on[0] = 0x64; on[1] = 100; on[16] = 0x64; on[17] = 100;
        ok(JSON.stringify(w[0]) === JSON.stringify(on), 'FLM high beam on: the low beam as it was, channels 1 and 9 1000 mA 100 % (' + hex(w[0] || []) + ')');
        ok(w.length >= 2 && JSON.stringify(w[1]) === JSON.stringify(LOW), 'FLM off: the low beam alone');
        ok(diag.sent.indexOf('43 22 D6 67', 2) > 0, 'FLM: the first flash read back');
        ok(headBack(diag) && /stopped/.test(s.note), 'FLM stopped: high beam off, the default session on both sides');
    }
    // FLM01: in turn
    {
        const { s, diag } = make('flm');
        await s.find(); diag.sent.length = 0;
        const run = s.start({ lights: 'high', pattern: 'alternate', rate: 'fast' });
        stopAfter(s, diag, 20);
        await run;
        const l = writes(diag, 0x43)[0], r = writes(diag, 0x44)[0];
        ok(l && r && l[0] === 0x64 && r[0] === 0, 'FLM in turn: left on, right off');
    }
    // FLM01: the high beam already on with the stalk: "off" still darkens only the high beam
    {
        const { s, diag } = make('flm');
        await s.find(); diag.stalk(true); diag.sent.length = 0;
        const run = s.start({ lights: 'high' });
        stopAfter(s, diag, 20);
        await run;
        ok(JSON.stringify(writes(diag, 0x43)[1]) === JSON.stringify(LOW), 'FLM with the stalk on: off is the low beam alone');
    }
    // FLM01: the headlight does not follow
    {
        const { s, diag } = make('flm', { deaf: true });
        await s.find(); diag.sent.length = 0;
        await s.start({ lights: 'high' });
        ok(/did not follow|does not light/.test(s.note) && headBack(diag), 'FLM deaf: one flash, then handed back (' + s.note + ')');
    }
    // FLM01: refusals, no session, moving, the time limit and the keep-alive
    {
        const { s, diag } = make('flm', { refuseAfter: 5 });
        await s.find(); diag.sent.length = 0;
        await s.start({});
        ok(/refused \(NRC 22\)/.test(s.note) && headBack(diag), 'FLM refused mid-run: stopped and handed back');
    }
    {
        const { s, diag } = make('flm', { noSession: true });
        await s.find(); diag.sent.length = 0;
        await s.start({});
        ok(!diag.sent.some((x) => / 31 01 30 00/.test(x)) && /refused the diagnostic session/.test(s.note), 'FLM no session: nothing written');
    }
    {
        let moving = false;
        const { s, diag } = make('flm', { allowed: () => (moving ? 'the setting is off' : null) });
        await s.find(); diag.sent.length = 0;
        const run = s.start({});
        setImmediate(() => { moving = true; });
        await run;
        ok(/the setting is off/.test(s.note) && headBack(diag), 'FLM not allowed any more: stopped and handed back');
    }
    {
        const { s, diag } = make('flm');
        await s.find(); diag.sent.length = 0;
        await s.start({ rate: 'slow' });
        ok(/done/.test(s.note) && headBack(diag), 'FLM: stops by itself after ' + MAX_MS / 1000 + ' s');
        ok(diag.sent.some((x) => x === '43 3E 00') && !diag.sent.some((x) => / 3E 80/.test(x)), 'the session kept with 3E 00, never 3E 80');
    }
    // FLM01 light show: lit at full against dark, sides in turn, then the channels as they were
    {
        const { s, diag } = make('flm');
        await s.find(); diag.sent.length = 0;
        const run = s.show({ rate: 'fast' });
        stopAfter(s, diag, 20);
        await run;
        const l = writes(diag, 0x43), r = writes(diag, 0x44);
        ok(JSON.stringify(l[0]) === JSON.stringify(FULL) && r[0] && r[0].every((x) => x === 0), 'FLM show: left every fitted channel at full, right dark');
        ok(JSON.stringify(l[l.length - 1]) === JSON.stringify(LOW) && headBack(diag), 'FLM show stopped: the channels as they were, the default session');
    }

    // FLE: the high beam to learn first
    {
        const { s, diag } = make('fle');
        await s.find(); diag.sent.length = 0;
        await s.start({});
        ok(diag.sent.length === 0 && /Learn/.test(s.note), 'FLE: not started before the high beam is learned');
        let learned = null;
        s.on('learned', (c) => { learned = c; });
        const run = s.learn();
        setImmediate(() => setImmediate(() => diag.stalk(true)));
        await run;
        ok(learned && learned.length === 1 && learned[0].ch === 1 && learned[0].cur === 0x64 && learned[0].pwm === 0x4B, 'FLE: learned channel 1 at 1000 mA 75 % (' + JSON.stringify(learned) + ')');
        ok(diag.sent.every((x) => / 22 D6 31/.test(x)), 'learning reads only');
        diag.stalk(false); diag.sent.length = 0;
        const run2 = s.start({});
        stopAfter(s, diag, 20);
        await run2;
        ok(writes(diag, 0x43)[0] && writes(diag, 0x43)[0].length === 14 && writes(diag, 0x43)[0][0] === 0x64, 'FLE: then it flashes, 7 channels');
    }
    {
        const { s } = make('fle', { channels: [{ ch: 1, cur: 0x64, pwm: 0x4B }] });
        await s.find();
        ok(s.high && s.high[0].ch === 1, 'FLE: learned channels kept from before');
    }

    // the body controller: not allowed / nothing to drive
    {
        const { s, diag } = make('bdc', { allowed: () => 'the car is moving' });
        await s.find(); diag.sent.length = 0;
        await s.start({});
        ok(diag.sent.length === 0 && /the car is moving/.test(s.note), 'not allowed: nothing sent, and why said');
    }
    {
        const { s, diag } = make('none');
        await s.find(); diag.sent.length = 0;
        await s.start({}); await s.show({});
        ok(diag.sent.length === 0, 'nothing to drive: nothing sent');
    }
    // BDC: both together, the status after a spare byte, handed back with 2F 4501 00 <el> 00
    {
        const { s, diag } = make('bdc');
        await s.find(); diag.sent.length = 0;
        const run = s.start({ pattern: 'both', rate: 'normal' });
        stopAfter(s, diag, 20);
        await run;
        ok(diag.sent[0] === '40 10 03' && diag.sent[1] === '40 2F 45 01 03 07 01' && diag.sent[2] === '40 2F 45 01 03 08 01' && diag.sent[3] === '40 22 45 00',
            'BDC: session, both on, the status (' + diag.sent.slice(0, 4).join(', ') + ')');
        ok(/Strobe stopped$/.test(s.note) && endsWithBack(diag.sent, '45 01'), 'BDC: the status followed; handed back (' + s.note + ' / ' + diag.sent.slice(-5).join(', ') + ')');
    }
    {
        const { s, diag } = make('g05');
        await s.find(); diag.sent.length = 0;
        const run = s.start({ pattern: 'alternate', rate: 'fast' });
        stopAfter(s, diag, 20);
        await run;
        ok(diag.sent[1] === '40 2F E3 B5 03 07 01' && diag.sent[2] === '40 2F E3 B5 03 08 00' && endsWithBack(diag.sent, 'E3 B5'), 'BDC_G05 in turn, handed back');
    }
    {
        const { s, diag } = make('bdc', { deaf: true });
        await s.find(); diag.sent.length = 0;
        await s.start({});
        ok(/did not follow \(status 0 \/ 0\)/.test(s.note) && endsWithBack(diag.sent, '45 01'), 'BDC deaf: one flash, handed back');
    }
    {
        const { s, diag } = make('g05');
        await s.find(); diag.sent.length = 0;
        const run = s.show({ rate: 'normal' });
        stopAfter(s, diag, 3);
        await run;
        ok(diag.sent[1] === '40 2E 45 30 64 00 04 00 3A 98 00 00' && diag.sent.slice(-2).join() === '40 2E 45 30 00 00 04 00 00 00 00 00,40 10 01',
            'BDC_G05 light show, ended early with a zero-length show');
    }
    {
        const { s, diag } = make('bdc');
        await s.find(); diag.sent.length = 0;
        await s.show({});
        ok(/refused \(NRC 31\)/.test(s.note) && diag.sent[diag.sent.length - 1] === '40 10 01', 'BDC without the light show: refused, the session dropped');
    }

    // the app's other writes to the body controller (the ambient lights) held before the first request, let go after the last
    {
        const clock = { t: 0 }, diag = fakeCar('fn', {}, clock), ev = [];
        const physical = diag.physical;
        diag.physical = (...a) => { ev.push('req'); return physical.apply(diag, a); };
        const s = new Strobe({ diag, log, allowed: () => null, now: () => clock.t, hold: async (on) => { ev.push(on ? 'hold' : 'go'); await new Promise((r) => setImmediate(r)); },
            sleep: (ms) => new Promise((r) => { clock.t += Math.max(ms, 1); setImmediate(r); }) });
        await s.find(); ev.length = 0;
        const run = s.start({ pattern: 'both' });
        const second = s.start({ pattern: 'both' });
        stopAfter(s, diag, diag.sent.length + 6);
        await Promise.all([run, second]);
        ok(ev[0] === 'hold' && ev[ev.length - 1] === 'go' && ev.filter((e) => e === 'hold').length === 1 && ev.filter((e) => e === 'go').length === 1 && ev.indexOf('req') > 0,
            'strobe: the ambient lights held once, before its first request, and let go after its last (' + ev.filter((e) => e !== 'req').join() + ', ' + ev.filter((e) => e === 'req').length + ' requests)');
        ev.length = 0;
        await s.show({ ms: 600 });
        ok(ev[0] === 'hold' && ev[ev.length - 1] === 'go', 'light show: held and let go the same way');
    }

    // the light show only with the car standing still; the high beam strobe may run while driving
    {
        const g = (o, what) => gateWhy(gateChecks(Object.assign({ setting: true, away: false, moving: false }, o)), what);
        ok(g({}, 'show') === null && g({}, 'strobe') === null, 'standing: both may run');
        ok(g({ moving: true }, 'show') === 'the car standing still (light show): no', 'moving: no light show (' + g({ moving: true }, 'show') + ')');
        ok(g({ moving: true }, 'strobe') === null, 'moving: the strobe may run');
        ok(g({ moving: true }, 'learn') === null, 'moving: learning may run');
        ok(g({ setting: false }, 'strobe') === 'switched on in the settings: no', 'off in the settings');
        ok(g({ away: true }, 'strobe') === 'someone in the car: no', 'nobody in the car');
        ok(gateChecks({ setting: true, away: false, moving: true }).length === 3, 'the Strobe tab lists three checks');
    }
    // the speed the light show goes by (kit/parked.js): re-read every 2 s, quiet after driving = moving
    {
        const Parked = require(path.join(__dirname, '..', 'runtime', 'parked'));
        let fields = null, opts = null;
        const ctx = { signals: { watch: (svc, v, f, l, o) => { fields = f; opts = o; return Promise.resolve({}); } } };
        const p = Parked.watch(ctx, null);
        const send = (kmh) => fields.statusCarSpeed2({ speedVehicleCentreOfGravity: Math.round(kmh / 0.015625) });
        ok(opts && opts.pollMs === 2000, 'the speed re-read every 2 s');
        ok(p.moving() === false, 'no speed yet (a VM, a bench): standing');
        send(50);
        ok(p.moving() === true, 'driving at 50 km/h: moving');
        ok(p.moving() === true, 'quiet after driving: still moving until a speed is read again');
        send(0);
        ok(p.moving() === false, 'stopped: standing');
    }
    // the gate is asked which: the strobe's flashes ask for 'strobe', the light show's for 'show'
    {
        const asked = new Set();
        const { s } = make('bdc', { allowed: (what) => { asked.add(what); return what === 'show' ? 'the car standing still (light show): no' : null; } });
        await s.find();
        await s.show({});
        ok(asked.has('show') && /Light show not started: the car standing still/.test(s.note), 'the light show asks for show and is stopped (' + s.note + ')');
        const b = make('bdc', { allowed: (what) => { asked.add(what); return 'held for the test'; } });
        await b.s.find();
        await b.s.start({});
        ok(asked.has('strobe') && /held for the test/.test(b.s.note), 'the strobe asks for strobe');
    }
    console.log('ambient strobe: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
