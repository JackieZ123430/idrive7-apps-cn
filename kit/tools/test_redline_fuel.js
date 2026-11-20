'use strict';
// Redline's fuel reader (apps/redline/fuel.js): each source's scaling, the fallback order, staleness, the
// retry after failures, and the HUD item for every unit. A stand-in link with crafted replies. Node 8 compatible.
const path = require('path');
const TH = require('./redline_test_harness');
TH.hookKit();
const FuelWatch = require(path.join(TH.ROOT, 'apps', 'redline', 'fuel'));
const smooth = FuelWatch.smooth, fuelItem = FuelWatch.fuelItem;
const tally = TH.counter(), ok = tally.ok, sleep = TH.sleep;
const near = (a, b, eps) => typeof a === 'number' && Math.abs(a - b) < (eps || 1e-6);

/** A fake ReadOnlyDiag: answers(key) -> reply bytes or null, key '5656' / 'OBD 5E' / '4521'. */
function fakeLink(answers) {
    const l = { asked: [], woken: 0, bad: 0 };
    l.wake = (t) => { if (t === 0x12) l.woken++; };
    l.physical = (target, sid, data, timeoutMs, accept) => {
        const key = sid === 0x01 ? 'OBD ' + data[0].toString(16).toUpperCase() : data.map((b) => (b < 16 ? '0' : '') + b.toString(16).toUpperCase()).join('');
        l.asked.push(key);
        const r = target === 0x12 ? answers(key) : null;
        if (r && !accept(r)) l.bad++;
        return Promise.resolve(r || null);
    };
    return l;
}
const REFUSE = (sid) => [0x7F, sid, 0x31];
const u16 = (v) => [v >> 8, v & 0xFF];

/** A watch on a link, polled once (start), then stopped so the test drives _poll itself. */
async function make(answers, opts) {
    const logs = [], link = fakeLink(answers);
    const w = new FuelWatch({ log: { info: (m) => logs.push('I ' + m), warn: (m) => logs.push('W ' + m) } }, () => link, opts);
    w.start(); w.stop();
    await sleep(15);
    return { w: w, link: link, logs: logs };
}
async function poll(w) { w.busy = false; w._poll(); await sleep(15); }

(async () => {
    // 1. 5656: raw 0x0400 = 1024 x 0.00119209 ml/s
    let s = await make((k) => (k === '5656' ? [0x62, 0x56, 0x56].concat(u16(0x0400)) : null));
    ok(near(s.w.value().lph, 1024 * 0.00119209 * 3.6), '5656 scaling (' + s.w.value().lph + ')');
    ok(s.link.bad === 0 && s.link.asked.join() === '5656', 'only 5656 asked, reply accepted (' + s.link.asked + ')');
    ok(s.link.woken === 1, 'woken on start (' + s.link.woken + ')');
    ok(s.logs.filter((m) => /fuel: rate read from the engine unit \(5656\)/.test(m)).length === 1, 'source logged (' + s.logs + ')');
    await poll(s.w);
    ok(s.logs.filter((m) => /rate read/.test(m)).length === 1, 'source logged once');

    // 2. 5656 refused (NRC 31): OBD 5E, raw 200 x 0.05 = 10 l/h
    s = await make((k) => (k === '5656' ? REFUSE(0x22) : k === 'OBD 5E' ? [0x41, 0x5E].concat(u16(200)) : null));
    ok(near(s.w.value().lph, 10), 'OBD 5E fallback scaling (' + s.w.value().lph + ')');
    ok(s.link.asked.join() === '5656,OBD 5E' && s.link.bad === 0, 'order 5656 then OBD 5E (' + s.link.asked + ')');
    ok(s.logs.some((m) => /\(OBD 5E\)/.test(m)), 'OBD 5E logged as the source');
    s.link.asked.length = 0;
    await poll(s.w);
    ok(s.link.asked[0] === 'OBD 5E', 'the one that answered is asked first next time (' + s.link.asked + ')');

    // 3. both refused: 4521, 0x0064 = 10 kg/h over the density
    const both = (k) => (k === '5656' ? REFUSE(0x22) : k === 'OBD 5E' ? REFUSE(0x01) : k === '4521' ? [0x62, 0x45, 0x21].concat(u16(100)) : null);
    s = await make(both);
    ok(near(s.w.value().lph, 10 / 0.745), '4521 petrol density (' + s.w.value().lph + ')');
    ok(s.link.asked.join() === '5656,OBD 5E,4521', 'order 5656, OBD 5E, 4521 (' + s.link.asked + ')');
    s = await make(both, { diesel: true });
    ok(near(s.w.value().lph, 10 / 0.835), '4521 diesel density (' + s.w.value().lph + ')');

    // 4. out of range ignored: 5656 at 0xFFFF (281 l/h) falls through to OBD 5E
    s = await make((k) => (k === '5656' ? [0x62, 0x56, 0x56, 0xFF, 0xFF] : k === 'OBD 5E' ? [0x41, 0x5E].concat(u16(40)) : null));
    ok(near(s.w.value().lph, 2), 'out of range 5656 skipped, 5E used (' + s.w.value().lph + ')');
    s = await make((k) => (k === 'OBD 5E' ? [0x41, 0x5E].concat(u16(3001)) : null));
    ok(s.w.value().lph === null, '150.05 l/h is out of range: nothing');

    // 5. stale after 3 s
    let raw = 0x0400;
    s = await make((k) => (k === '5656' ? [0x62, 0x56, 0x56].concat(u16(raw)) : null));
    const realNow = Date.now;
    const t0 = realNow();
    s.w.t = t0;                                      // the read's time, exactly
    Date.now = () => t0 + 2900;
    ok(s.w.value().lph !== null, 'fresh at 2.9 s');
    Date.now = () => t0 + 3200;
    ok(s.w.value().lph === null, 'stale at 3.2 s');
    // smoothing in the watch: 1 s later a jump moves part of the way
    Date.now = () => t0 + 1000;
    raw = 0x0800;
    await poll(s.w);
    const v2 = s.w.value().lph, a = 1024 * 0.00119209 * 3.6, b = 2 * a;
    ok(v2 > a && v2 < b && near(v2, a + (b - a) * (1 - Math.exp(-0.5)), 1e-3), 'smoothed towards the new value (' + v2 + ')');
    Date.now = () => t0 + 10000;
    await poll(s.w);
    ok(near(s.w.value().lph, b), 'after a long gap the new value at once (' + s.w.value().lph + ')');
    Date.now = realNow;

    // 6. nothing answers: logged once after 3, then retried once a minute with a wake
    s = await make(() => null);
    await poll(s.w); await poll(s.w);
    ok(s.w.fails === 3 && s.logs.filter((m) => /no fuel readout on this car/.test(m)).length === 1, 'none: logged once after 3 tries (' + s.logs + ')');
    const n = s.link.asked.length, wk = s.link.woken;
    await poll(s.w);
    ok(s.link.asked.length === n, 'not asked again within a minute');
    const t1 = realNow();
    Date.now = () => t1 + 61000;
    await poll(s.w);
    Date.now = realNow;
    ok(s.link.asked.length === n + 3 && s.link.woken === wk + 1, 'retried after a minute, woken first (' + (s.link.asked.length - n) + ', ' + (s.link.woken - wk) + ')');
    ok(s.logs.filter((m) => /no fuel readout/.test(m)).length === 1, 'the none message not repeated');
    ok(s.w.value().lph === null, 'never read: null');

    // 7. errors: warned, not thrown
    const logs = [], lk = { physical: () => { throw new Error('boom'); } };
    const w = new FuelWatch({ log: { info: (m) => logs.push(m), warn: (m) => logs.push('W ' + m) } }, () => lk);
    w.start(); w.stop(); await sleep(15);
    ok(w.value().lph === null, 'a throwing link: no value, no crash (' + logs + ')');
    const w2 = new FuelWatch({ log: { info() {}, warn: (m) => logs.push('W2 ' + m) } }, () => { throw new Error('no link'); });
    w2.start();
    ok(!w2.timer && logs.some((m) => /W2 fuel: no link/.test(m)), 'start without a link warns');
    // polling: start() keeps polling every second, never overlapping
    s = await make((k) => (k === '5656' ? [0x62, 0x56, 0x56].concat(u16(0x0400)) : null));
    s.link.asked.length = 0;
    s.w.busy = true;                                 // a read still out: the timer's polls skip
    s.w.start();
    await sleep(1150);
    s.w.stop();
    ok(s.link.asked.length === 0, 'busy: no overlapping poll (' + s.link.asked.length + ')');
    s.w.busy = false; s.w.start(); await sleep(1100); s.w.stop();
    ok(s.link.asked.length === 2, 'start polls at once and every second (' + s.link.asked.length + ')');

    // 8. smooth()
    ok(smooth(null, 5, 1000) === 5, 'smooth: no previous value -> the value');
    ok(near(smooth(0, 10, 2000), 10 * (1 - Math.exp(-1))), 'smooth: one time constant -> 63%');
    ok(smooth(0, 10, 6000) === 10, 'smooth: gap over 5 s resets');
    ok(smooth(3, 10, 0) === 10, 'smooth: no dt -> the value');
    ok(smooth(3, null, 1000) === null && smooth(3, NaN, 1000) === null, 'smooth: not a number -> null');

    // 9. fuelItem()
    const it = (lph, kmh, unit) => { const r = fuelItem(lph, kmh, unit); return r ? r.label + ' ' + r.value + ' ' + r.tone : 'null'; };
    ok(it(null, 50) === 'null' && it(NaN, 50) === 'null' && it('5', 50) === 'null' && it(undefined, 50) === 'null', 'not a number -> null');
    ok(it(6, 100) === 'L/100KM 6.0 text', 'l100 default (' + it(6, 100) + ')');
    ok(it(6, 100, 'l100') === 'L/100KM 6.0 text', 'l100 named');
    ok(it(7.3, 60) === 'L/100KM 12.2 text', 'l100 one decimal (' + it(7.3, 60) + ')');
    ok(it(60, 10) === 'L/100KM 99.9 text', 'l100 capped at 99.9 (' + it(60, 10) + ')');
    ok(it(0, 80) === 'L/100KM 0.0 text', 'l100 fuel cut 0.0');
    ok(it(6, 100, 'mpguk') === 'MPG 47 text', 'mpg uk 282.481/6 (' + it(6, 100, 'mpguk') + ')');
    ok(it(6, 100, 'mpgus') === 'MPG US 39 text', 'mpg us 235.215/6 (' + it(6, 100, 'mpgus') + ')');
    ok(it(0, 80, 'mpguk') === 'MPG 999 text' && it(0, 80, 'mpgus') === 'MPG US 999 text', 'mpg fuel cut 999');
    ok(it(0.1, 120, 'mpguk') === 'MPG 999 text', 'mpg capped at 999 (' + it(0.1, 120, 'mpguk') + ')');
    ok(it(6, 90, 'kml') === 'KM/L 15.0 text', 'km/l (' + it(6, 90, 'kml') + ')');
    ok(it(0.5, 100, 'kml') === 'KM/L 99.9 text' && it(0, 100, 'kml') === 'KM/L 99.9 text', 'km/l capped at 99.9, fuel cut 99.9');
    ok(it(1.23, 3) === 'L/H 1.2 text' && it(1.23, null) === 'L/H 1.2 text' && it(1.23, undefined, 'kml') === 'L/H 1.2 text', 'slow or unknown speed: l/h');
    ok(it(2, 4.9) === 'L/H 2.0 text', 'just under 5 km/h: l/h');
    ok(it(2, 5) === 'L/100KM 40.0 text', '5 km/h: per distance (' + it(2, 5) + ')');
    ok(it(4.54609, 0, 'mpguk') === 'GAL/H 1.0 text', 'slow mpguk: UK gal/h (' + it(4.54609, 0, 'mpguk') + ')');
    ok(it(3.785411784 * 2, 0, 'mpgus') === 'GAL/H 2.0 text', 'slow mpgus: US gal/h (' + it(3.785411784 * 2, 0, 'mpgus') + ')');
    ok(it(-1, 50) === 'null', 'negative -> null');

    // 2026-11-10 review: the density asked on every read (a diesel found after the start); the link not up yet is not a
    // failed read; worked() once a rate came
    {
        let diesel = false;
        const d = await make(both, { diesel: () => diesel });
        ok(near(d.w.value().lph, 10 / 0.745) && d.w.worked(), 'diesel getter: petrol until found, worked() after a rate');
        diesel = true; d.w.t = 0; d.w.lph = null;
        await poll(d.w);
        ok(near(d.w.value().lph, 10 / 0.835), 'diesel found later: its density from the next read (' + d.w.value().lph + ')');
        const n = await make(() => null);
        ok(!n.w.worked(), 'worked(): false while nothing has answered');
        const down = fakeLink(both); down.ready = false;
        const logs = [], w = new FuelWatch({ log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) } }, () => down);
        w.start(); w.stop();
        for (let i = 0; i < 5; i++) await poll(w);
        ok(down.asked.length === 0 && w.fails === 0 && !logs.some((m) => /no fuel rate/.test(m)), 'link not up: nothing asked, no fails counted, no "no fuel rate" (' + down.asked.length + ', ' + w.fails + ')');
        down.ready = true; down.available = false;
        await poll(w);
        ok(down.asked.length === 0, 'link not available: nothing asked');
        down.available = true;
        await poll(w);
        ok(near(w.value().lph, 10 / 0.745), 'link up: read');
    }
    console.log('redline fuel: ' + tally.checks + ' checks, ' + tally.fails + ' failed');
    process.exit(tally.fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e.stack || e)); process.exit(1); });
