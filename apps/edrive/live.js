'use strict';
/**
 * eDrive's live pages - what the high-voltage battery is doing right now (from eDrive Live,
 * set up on the X5 xDrive45e, G05 PHEV; adjustable for other BMW plug-in hybrids in app.json).
 *
 *   Battery  power in / out of the pack now (kW = pack voltage x current, read every
 *            "powerPoll" s) on a bar against the battery's own discharge / charge limits, the
 *            last two minutes, cell temperature and coolant; every cell's voltage (the lowest
 *            and highest, the spread between them); this drive's energy used, regen, net, what
 *            it went to (driving vs. climate) and peaks
 *   climate  for eDrive's Energy page (lv.climate()): the climate's power measured while
 *            standing with the engine off, when nothing but the car's own consumers takes power
 *            from the pack (that minus the on-board baseline, learned with the climate off), or
 *            the climate unit's own figures
 *
 *   Home-screen widget (app.json startWidget): power, state, V / A, charge, cells and this drive
 *
 * The battery values come from the battery unit (SME) with UDS ReadDataByIdentifier over eDrive's
 * diagnostic link (sh.diag, sh.reader; one request at a time through sh.exclusive); identifiers
 * and scalings are in app.json "config.battery" (fast: read every powerPoll s, slow: every
 * slowPoll s while a live page or the widget is shown). Speed, engine, climate and comfort states
 * are eDrive's (sh.live, from SOME/IP).
 *
 *   const lv = require('./live')(ctx, { diag, reader, exclusive, live, page })
 *   lv.PAGES, lv.DIAG (page names), lv.NAMES, lv.draw(name, cv, t) -> data, lv.actionLabel(name)
 *   (the first bar button's name on that page, or null), lv.action(name), lv.climate()
 */
const fs = require('fs');
const path = require('path');
const { Canvas, withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { hex } = require('./kit/diag');

const W = 1600, H = 520;
const GO = '#2fd27a';
const IDLE_KW = 0.3;              // below this either way the pack is idle
const SHOWN_MS = 3000;            // the screen counts as shown when drawn this recently
const BG_POWER_S = 2;             // power read in the background (drive totals) at most this often
const TRACE_S = 120;              // power trace on the Battery page
const SEAT_KW = [0, 0.04, 0.07, 0.1];   // seat heating per level 0..3 (estimate)
const WHEEL_KW = 0.06;                  // steering-wheel heating (estimate)
const BLOWER_KW = [0.03, 0.32];         // blower: about [0] + [1] x (level / top)^2 (estimate)
const BASELINE_KW = 0.35;               // on-board electrics while parked, until learned
const STAND_MS = 10000;                 // standing this long before the draw counts as "standing"

/** Demo: 96 cells a few mV apart, two of them a little weak. */
function demoCells(s) {
    const cells = [];
    for (let i = 0; i < 96; i++) cells.push(3.722 + 0.004 * Math.sin(i * 1.7) + 0.003 * Math.cos(i * 0.31 + s / 60) - (i === 37 ? 0.016 : i === 70 ? 0.009 : 0));
    const min = Math.min(...cells), max = Math.max(...cells);
    return { cells, min, max, avg: cells.reduce((a, v) => a + v, 0) / 96, minAt: cells.indexOf(min) + 1, maxAt: cells.indexOf(max) + 1 };
}

/** Demo: a drive with a stop every 40 s; climate on with the A/C. */
class Demo {
    constructor() { this.t0 = Date.now() - 600000; }      // ten minutes in: the traces have a history
    sample() {
        const s = (Date.now() - this.t0) / 1000, ph = ((s % 40) + 40) % 40;
        const standing = ph >= 30;
        const kw = standing ? 1.55 + 0.1 * Math.sin(s)
            : ph < 5 ? 42 + 14 * Math.sin(s * 2) : ph < 20 ? 13 + 4 * Math.sin(s * 0.8) : -11 - 7 * Math.sin(s * 1.3);
        const v = 352 - kw * 0.12;
        return {
            kw, v, a: -kw * 1000 / v, speed: standing ? 0 : 55 + 20 * Math.sin(s / 9), engine: false,
            soc: 64 - (s / 60) % 30, cellV: demoCells(s), cellT: { min: 21.4 + 2.5 * Math.sin(s / 500), max: 23.9 + 2.8 * Math.sin(s / 500), avg: 22.5 + 2.6 * Math.sin(s / 500) },
            coolant: 20.8 + 2 * Math.sin(s / 520),
            limits: { chargeA: 165, dischargeA: 330 }, ambient: 29, climate: 'ac', blower: 4, blowerTop: 8,
            acKw: 1.15 + 0.2 * Math.sin(s / 7), seats: { DR: 1 }, wheel: false,
            unit: { ac: 0.55 + 0.05 * Math.sin(s / 7), heater: 0 },
        };
    }
}

module.exports = function live(ctx, sh) {
    const { settings, log } = ctx;
    const { diag, reader, exclusive } = sh;
    const L = sh.live;
    const cfg = Object.assign({ ecu: 7, powerSign: -1, fast: {}, slow: {} }, (ctx.spec.config && ctx.spec.config.battery) || {});

    /* ---------- persisted: the learned on-board baseline and climate extras ---------- */
    const STATE = path.join(ctx.dataDir, 'live.json');
    let st = {};
    try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')) || {}; } catch (e) { /* first run */ }
    let savedAt = 0;
    const save = () => { savedAt = Date.now(); try { fs.writeFileSync(STATE, JSON.stringify(st)); } catch (e) { log.warn('save: ' + e); } };

    /* ---------- this part's own values (the battery unit's); the car's are eDrive's (L) ---------- */
    const live = { v: null, vT: 0, a: null, kw: null, kwT: 0, soc: null, cellV: null, cellT: null, coolant: null, limits: null, slowT: {} };

    /* ---------- UDS: candidates with several fields on one reply ---------- */
    const pick = {};
    const fieldsOf = (c) => (c.array ? ['min', 'max', 'avg'] : Object.keys(c.fields || {}));
    const primary = (c) => Object.assign({ ecu: c.ecu, did: c.did, timeoutMs: c.timeoutMs }, c.array || c.fields[fieldsOf(c)[0]]);
    /** One candidate: { field: value } (a field outside its min..max is null), or null when it doesn't answer. */
    async function readFields(c) {
        const p = primary(c), v0 = await reader.read(p);
        if (v0 === null) return null;
        const r = reader.raws[reader.key(p)], bytes = r.bytes.split(' ').map((x) => parseInt(x, 16));
        const out = {};
        if (c.array) {
            // every value in the reply (one per cell): the ones outside min..max count as missing
            const f = c.array, n = f.bytes || 1, cells = [];
            for (let at = 3; at + n <= bytes.length; at += n) {
                let raw = 0;
                for (let j = 0; j < n; j++) raw = raw * 256 + bytes[at + j];
                const v = raw * (f.factor == null ? 1 : f.factor) + (f.offset || 0);
                cells.push((f.min != null && v < f.min) || (f.max != null && v > f.max) ? null : v);
            }
            const ok = cells.filter(G.isNum);
            if (ok.length < cells.length / 2) return null;
            out.cells = cells;
            out.min = Math.min(...ok); out.max = Math.max(...ok); out.avg = ok.reduce((a, v) => a + v, 0) / ok.length;
            out.minAt = cells.indexOf(out.min) + 1; out.maxAt = cells.indexOf(out.max) + 1;
            r.fields = { cells: ok.length, min: out.min, max: out.max };
            return out;
        }
        fieldsOf(c).forEach((k, i) => {
            if (i === 0) { out[k] = v0; return; }
            const f = c.fields[k], at = 3 + (f.at || 0), n = f.bytes || 1;
            if (bytes.length < at + n) { out[k] = null; return; }
            let raw = 0;
            for (let j = 0; j < n; j++) raw = raw * 256 + bytes[at + j];
            if (f.signed && raw >= Math.pow(2, 8 * n - 1)) raw -= Math.pow(2, 8 * n);
            const v = raw * (f.factor == null ? 1 : f.factor) + (f.offset || 0);
            out[k] = (f.min != null && v < f.min) || (f.max != null && v > f.max) ? null : v;
        });
        r.fields = out;
        return out;
    }
    /** A value's candidates, starting with the one that answered last. */
    async function readGroup(name, list) {
        list = list || [];
        const start = pick[name] || 0;
        for (let k = 0; k < list.length; k++) {
            const i = (start + k) % list.length, v = await readFields(list[i]);
            if (v) { pick[name] = i; return v; }
        }
        return null;
    }

    let lastDrawT = 0;
    // the app's screen, or its home-screen widget: either one gets the fast power reads
    const shown = () => Date.now() - lastDrawT < SHOWN_MS || !!(ctx.widget && ctx.widget.active());
    const engineOn = () => G.isNum(L.rpm) && L.rpm > 400 && Date.now() - L.rpmT < 5000;

    /* ---------- power: fast reads, drive totals, traces ---------- */
    const trip = { out: 0, regen: 0, charged: 0, climate: 0, peakOut: 0, peakIn: 0, since: Date.now() };
    const trace = [];
    const push = (arr, keep, v) => { const now = Date.now(); arr.push([now, v]); while (arr.length && now - arr[0][0] > keep * 1000) arr.shift(); };
    let iFail = 0, iTry = 0, vTick = 0, iOk = false, pMiss = 0, pLogT = 0;
    /* measured consumption: the battery's own energy (out - regen) per km driven with the engine off,
     * standing in traffic included - over the last USE_KM km (st.use, kept across restarts) and the
     * last minute (useNow). This is what "range at this rate" on the Energy page divides by. */
    const USE_KM = 10, NOW_S = 60, useNow = [];
    const KW_KEEP = 15000;           // a missed power read: the last value stays (dimmed) this long
    function onPower(kw, now) {
        if (live.kwT && G.isNum(live.kw)) {
            const h = Math.min(now - live.kwT, 3 * Math.max(BG_POWER_S, settings.get('powerPoll')) * 1000) / 3600000;
            const moving = G.isNum(L.speed) && L.speed > 1;
            if (kw > 0) {
                trip.out += kw * h;
                // the part of it the climate took (compressor, heater, blower, seats, pumps): never more than the battery gave
                const cl = climatePower(data(), now).kw;
                if (G.isNum(cl) && cl > 0) trip.climate += Math.min(cl, kw) * h;
            }
            else if (moving) trip.regen -= kw * h;
            else trip.charged -= kw * h;
            if (!engineOn() && G.isNum(L.speed) && !(kw < 0 && !moving)) {     // not while plugged in
                const km = moving ? L.speed * h : 0, u = st.use || (st.use = { km: 0, kwh: 0 });
                u.km += km; u.kwh += kw * h;
                if (u.km > USE_KM) { u.kwh *= USE_KM / u.km; u.km = USE_KM; }
                useNow.push([now, km, kw * h]);
                while (useNow.length && now - useNow[0][0] > NOW_S * 1000) useNow.shift();
            }
        }
        trip.peakOut = Math.max(trip.peakOut, kw);
        if (G.isNum(L.speed) && L.speed > 1) trip.peakIn = Math.max(trip.peakIn, -kw);
        live.kw = kw; live.kwT = now;
        push(trace, TRACE_S, kw);
        learnBaseline(kw, now);
    }
    // how fast power is really read while shown (logged every 30 s): reads, time per read, time queued
    const perf = { n: 0, ms: 0, wait: 0, maxWait: 0, t: Date.now() };
    function logPerf() {
        const now = Date.now();
        if (now - perf.t < 30000) return;
        if (perf.n && shown()) {
            log.info('power reads: ' + (perf.n / ((now - perf.t) / 1000)).toFixed(1) + '/s, ' + Math.round(perf.ms / perf.n) + ' ms each, queued '
                + Math.round(perf.wait / perf.n) + ' ms avg / ' + perf.maxWait + ' ms max, poll ' + settings.get('powerPoll') + ' s');
        }
        Object.assign(perf, { n: 0, ms: 0, wait: 0, maxWait: 0, t: now });
    }
    async function readPower() {
        // a car without the current identifier: only every 30 s. One that has answered keeps being asked
        if (!diag.available || (!iOk && iFail >= 3 && Date.now() - iTry < 30000)) return;
        const queued = Date.now();
        await exclusive(async () => {
            const w = Date.now() - queued;
            perf.wait += w; perf.maxWait = Math.max(perf.maxWait, w);
            try {
                // the pack voltage moves little: every 5 s is enough, so the current gets nearly every read
                if (!G.isNum(live.v) || Date.now() - live.vT > 5000) {
                    const r = await readGroup('hvV', cfg.fast.hvV);
                    if (r) { live.v = r[fieldsOf(cfg.fast.hvV[pick.hvV])[0]]; live.vT = Date.now(); }
                }
                iTry = Date.now();
                const r = await readGroup('hvI', cfg.fast.hvI);
                rate.push([iTry, Date.now() - iTry]);
                perf.n++; perf.ms += Date.now() - iTry; logPerf();
                while (rate.length && iTry - rate[0][0] > 10000) rate.shift();
                if (!r) {
                    iFail++; pMiss++;
                    const c = cfg.fast.hvI[pick.hvI || 0], raw = reader.raws[reader.key(primary(c))];
                    if (Date.now() - pLogT > 30000) { pLogT = Date.now(); log.warn('power (' + c.did + ') missed ' + pMiss + 'x: ' + (raw ? raw.why : 'not read') + (G.isNum(L.speed) ? ' at ' + Math.round(L.speed) + ' km/h' : '')); }
                    return;
                }
                iFail = 0; iOk = true;
                const a = r[fieldsOf(cfg.fast.hvI[pick.hvI])[0]], now = Date.now();
                live.a = a;
                const volts = live.vT && now - live.vT < 60000 ? live.v : L.lscVT && now - L.lscVT < 60000 ? L.lscV : null;
                if (G.isNum(volts) && G.isNum(a)) onPower(volts * a / 1000 * (cfg.powerSign < 0 ? -1 : 1), now);
            } catch (e) { log.warn('power: ' + e); }
        }, true);
    }
    /** Power reads in the last 10 s: [time, ms it took]. */
    const rate = [];
    const readRate = () => (rate.length > 1 ? { hz: (rate.length - 1) / ((rate[rate.length - 1][0] - rate[0][0]) / 1000), ms: rate.reduce((a, r) => a + r[1], 0) / rate.length } : null);
    let powerTimer = null;
    function schedulePower() {
        clearTimeout(powerTimer);
        const s = shown() ? settings.get('powerPoll') : Math.max(BG_POWER_S, settings.get('powerPoll'));
        // 0.1 s: as fast as the battery unit answers (one read waits for the last)
        powerTimer = setTimeout(() => readPower().then(schedulePower, schedulePower), Math.max(20, s * 1000 - (s <= 0.1 ? 1000 : 0)));
    }
    schedulePower();

    /* ---------- slow reads (only while the screen is shown) ---------- */
    const SLOW = ['soc', 'cellV', 'cellT', 'coolant', 'limits'];
    const slowFail = {}, slowLogT = {};
    const SLOW_KEEP = 10 * 60000;      // a value that stops answering is kept (dimmed) this long, then blank
    async function readSlow() {
        if (!diag.available || !shown()) return;
        for (const name of SLOW) {
            if (!(cfg.slow[name] || []).length) continue;
            await exclusive(async () => {
                try {
                    let r = await readGroup(name, cfg.slow[name]);
                    if (!r) {
                        // busy or no reply (the battery unit is asked something ~10 times a second): once more
                        await new Promise((res) => setTimeout(res, 150));
                        r = await readGroup(name, cfg.slow[name]);
                    }
                    if (!r) {
                        const c = cfg.slow[name][pick[name] || 0], raw = reader.raws[reader.key(primary(c))];
                        slowFail[name] = (slowFail[name] || 0) + 1;
                        if (Date.now() - (slowLogT[name] || 0) > 60000) {
                            slowLogT[name] = Date.now();
                            log.warn(name + ' (' + c.did + ') failed ' + slowFail[name] + 'x: ' + (raw ? raw.why + (raw.bytes ? ' [' + raw.bytes + ']' : '') : 'not read'));
                        }
                        return;
                    }
                    const f = fieldsOf(cfg.slow[name][pick[name]]);
                    live[name] = f.length === 1 ? r[f[0]] : r;
                    live.slowT[name] = Date.now();
                } catch (e) { log.warn(name + ': ' + e); }
            });
        }
        await readProbes();
    }

    /* ---------- climate unit values being identified (config.probes) ----------
     * Raw numbers from the IHKA that follow the A/C compressor (D8D2) and the heater (D8D3). Their unit isn't
     * known yet, so every reading taken while the climate draw is measured (standing, engine off, not plugged in) is kept with it in probes.json: enough of those pairs
     * give the scale, after which "factor" in app.json turns them into kW. */
    const PROBES = (ctx.spec.config && ctx.spec.config.probes) || [];
    const probe = {};                                   // name -> { raw, t }
    const PROBE_FILE = path.join(ctx.dataDir, 'probes.json');
    let samples = [];
    try { samples = JSON.parse(fs.readFileSync(PROBE_FILE, 'utf8')) || []; } catch (e) { /* none yet */ }
    async function readProbes() {
        if (!PROBES.length) return;
        for (const pr of PROBES) {
            await exclusive(async () => {
                try {
                    const v = await reader.read({ ecu: pr.ecu, did: pr.did, at: pr.at || 0, bytes: pr.bytes || 1 });
                    if (v !== null) probe[pr.name] = { raw: v, t: Date.now() };
                } catch (e) { /* not this time */ }
            });
        }
        const d = data(), cp = climatePower(d, Date.now());
        if (!d.demo && cp.how === 'measured' && PROBES.some((pr) => probe[pr.name] && Date.now() - probe[pr.name].t < 15000)) {
            const c = comfortKw(d);
            const row = { t: Date.now(), kw: +cp.kw.toFixed(3), blower: +blowerKw(d).toFixed(3), comfort: +(c.seats + c.wheel).toFixed(3), climate: d.climate, amb: d.ambient };
            PROBES.forEach((pr) => { row[pr.name] = probe[pr.name] ? probe[pr.name].raw : null; });
            samples.push(row);
            if (samples.length > 600) samples = samples.slice(-600);
            if (samples.length % 6 === 0) { try { fs.writeFileSync(PROBE_FILE, JSON.stringify(samples)); } catch (e) { /* ok */ } }
        }
    }
    /** A probe's value now: { raw, kw (with a known factor) } or null. */
    const probeNow = (name) => {
        const pr = PROBES.find((x) => x.name === name), p = probe[name];
        if (!pr || !p || Date.now() - p.t > 30000) return null;
        return { raw: p.raw, kw: G.isNum(pr.factor) ? p.raw * pr.factor : null };
    };
    let slowTimer = null;
    function scheduleSlow() {
        clearTimeout(slowTimer);
        slowTimer = setTimeout(() => readSlow().then(scheduleSlow, scheduleSlow), settings.get('slowPoll') * 1000);
    }
    diag.on('available', (a) => { if (a) readSlow(); });
    scheduleSlow();
    settings.onChange((k) => { if (k === 'powerPoll') schedulePower(); if (k === 'slowPoll') scheduleSlow(); });

    /* ---------- identifier scan (Scan page) ----------
     * Asks one control unit ("scanUnit": the battery unit, or the IHKA climate unit that runs the HV
     * heater and the electric A/C compressor) for every identifier in its ranges, one at a time between
     * the other reads, and keeps the ones that answer. Each unit keeps its last two scans
     * (scan_<unit>.json, scan_<unit>_prev.json): what changed between them is listed, so a value can be
     * found by scanning with something off, then on (heater, A/C). Battery replies holding a 2-byte value
     * that reads as a cell voltage (3.0-4.3 V at 1 mV) or a pack voltage (200-460 V at 0.01 V) are flagged. */
    const SCAN_UNITS = {
        7: { name: 'battery unit (SME)', ranges: [[0xDD00, 0xDDFF], [0xDF00, 0xDFFF], [0xD600, 0xD6FF], [0x6300, 0x63FF]] },
        120: { name: 'climate unit (IHKA)', ranges: [[0xD000, 0xDFFF], [0x4000, 0x41FF]] },
    };
    const scanUnit = () => (SCAN_UNITS[+settings.get('scanUnit')] ? +settings.get('scanUnit') : 7);
    const scanFile = (u, prev) => path.join(ctx.dataDir, 'scan_' + hex(u) + (prev ? '_prev' : '') + '.json');
    const readScan = (f) => { try { const o = JSON.parse(fs.readFileSync(f, 'utf8')); return o && o.hits ? o : null; } catch (e) { return null; } };
    const scan = { unit: 0, running: false, done: 0, total: 0, hits: [], noReply: 0, t: 0, prev: null };
    function loadScan() {
        const u = scanUnit();
        if (scan.running && scan.unit === u) return;
        scan.running = false;
        // the scan from before 1.1.2 (battery only) was scan.json
        const cur = readScan(scanFile(u)) || (u === 7 ? readScan(path.join(ctx.dataDir, 'scan.json')) : null);
        // no saved scan: the identifiers known to answer on this car (config.scanKnown), so the live
        // comparison can start without the long scan
        const known = !cur && ctx.spec.config && ctx.spec.config.scanKnown && ctx.spec.config.scanKnown[String(u)];
        const kn = known ? { hits: known.map((did) => ({ did, bytes: [] })), t: Date.now(), done: 0, known: true } : null;
        Object.assign(scan, { unit: u, total: SCAN_UNITS[u].ranges.reduce((a, r) => a + r[1] - r[0] + 1, 0), hits: [], done: 0, t: 0, noReply: 0, known: false }, cur || kn || {});
        scan.prev = readScan(scanFile(u, true));
    }
    loadScan();
    settings.onChange((k) => { if (k === 'scanUnit') loadScan(); });
    async function runScan() {
        if (scan.running || !diag.available) return;
        const u = scanUnit(), unit = SCAN_UNITS[u];
        loadScan();
        if (scan.t) { try { fs.writeFileSync(scanFile(u, true), JSON.stringify({ hits: scan.hits, done: scan.done, t: scan.t, noReply: scan.noReply })); } catch (e) { /* ok */ } }
        scan.prev = scan.t ? { hits: scan.hits, t: scan.t } : scan.prev;
        Object.assign(scan, { unit: u, running: true, done: 0, hits: [], noReply: 0, t: Date.now() });
        log.info('scan: ' + unit.name + ' 0x' + hex(u) + ', ' + scan.total + ' identifiers');
        for (const [a, b] of unit.ranges) {
            for (let did = a; did <= b; did++) {
                if (!scan.running || scan.unit !== u) return;
                await exclusive(async () => {
                    const accept = (r) => (r[0] === 0x62 && ((r[1] << 8) | r[2]) === did) || (r[0] === 0x7F && r[1] === 0x22);
                    let r = null;
                    try { r = await diag.physical(u, 0x22, [did >> 8, did & 255], 1500, accept); } catch (e) { /* link error: counts as no reply */ }
                    if (!r) scan.noReply++;
                    else if (r[0] === 0x62) {
                        const hit = { did: hex(did >> 8) + hex(did & 255), bytes: r.slice(3) };
                        scan.hits.push(hit);
                        log.info('scan ' + hex(u) + ': ' + hit.did + ' = ' + hit.bytes.map((x) => hex(x)).join(' '));
                    }
                });
                scan.done++;
                // a unit that doesn't answer (not fitted, asleep, link lost): stop rather than wait 1.5 s x thousands
                if (scan.noReply >= 25 && scan.noReply === scan.done) { log.warn('scan: no replies, stopped'); scan.running = false; break; }
            }
        }
        scan.running = false;
        try { fs.writeFileSync(scanFile(u), JSON.stringify({ hits: scan.hits, done: scan.done, t: scan.t, noReply: scan.noReply })); } catch (e) { log.warn('scan save: ' + e); }
        log.info('scan done: ' + scan.hits.length + ' identifiers answer');
    }
    /* ---------- live comparison after a scan ----------
     * Once a unit has been scanned, only the identifiers that answered are read again, every few seconds
     * while the Scan page is shown (seconds, not minutes). The first of these reads (or the one after
     * Reset) is the baseline; the bytes that differ from it now are listed, with how often they changed,
     * so switching the heater or the A/C on shows which values follow it. Saved to scan_<unit>_live.json. */
    const cmpState = { unit: 0, base: null, now: {}, flips: {}, t: 0, busy: false, cycles: 0 };
    function rebase() { Object.assign(cmpState, { unit: scan.unit, base: null, now: {}, flips: {}, t: Date.now(), cycles: 0 }); }
    async function watchCycle() {
        if (cmpState.busy || scan.running || !scan.t || !scan.hits.length || !diag.available || sh.page() !== 'scan') return;
        if (cmpState.unit !== scan.unit) rebase();
        cmpState.busy = true;
        const now = {};
        for (const h of scan.hits) {
            if (scan.running || sh.page() !== 'scan') break;
            const did = parseInt(h.did, 16);
            await exclusive(async () => {
                const accept = (r) => (r[0] === 0x62 && ((r[1] << 8) | r[2]) === did) || (r[0] === 0x7F && r[1] === 0x22);
                let r = null;
                try { r = await diag.physical(scan.unit, 0x22, [did >> 8, did & 255], 1500, accept); } catch (e) { /* skip */ }
                if (r && r[0] === 0x62) now[h.did] = r.slice(3);
            });
        }
        if (!cmpState.base) cmpState.base = now;
        else {
            Object.keys(now).forEach((k) => {
                const a = cmpState.now[k], b = now[k];
                if (a) b.forEach((x, i) => { if (a[i] !== x) cmpState.flips[k + '@' + i] = (cmpState.flips[k + '@' + i] || 0) + 1; });
            });
        }
        cmpState.now = now; cmpState.cycles++;
        try { fs.writeFileSync(scanFile(scan.unit).replace('.json', '_live.json'), JSON.stringify({ t: cmpState.t, base: cmpState.base, now: cmpState.now, flips: cmpState.flips })); } catch (e) { /* ok */ }
        cmpState.busy = false;
    }
    setInterval(() => { watchCycle().catch((e) => { cmpState.busy = false; log.warn('watch: ' + e); }); }, 3000);
    /** Bytes that differ from the baseline now: ["D1A2@3 00>5A x2", ...] (x = how many reads it changed in). */
    function changes() {
        if (!cmpState.base || cmpState.unit !== scan.unit) return null;
        const out = [];
        Object.keys(cmpState.now).forEach((k) => {
            const o = cmpState.base[k], n = cmpState.now[k];
            if (!o) return;
            for (let i = 0; i < Math.max(o.length, n.length); i++) {
                if (o[i] !== n[i]) out.push({ k: k + '@' + i, txt: k + '@' + i + ' ' + (o[i] == null ? '--' : hex(o[i])) + '>' + (n[i] == null ? '--' : hex(n[i])), f: cmpState.flips[k + '@' + i] || 0 });
            }
        });
        // steady changes first: values that flip at every read (timers, counters) are noise and go last
        out.sort((a, b) => a.f - b.f);
        return out.map((c) => c.txt);
    }
    /** What a reply might hold: [{ at, kind, value }] for 2-byte words that read as a cell or a pack voltage. */
    function guesses(bytes) {
        const out = [];
        for (let i = 0; i + 1 < bytes.length; i++) {
            const w = bytes[i] * 256 + bytes[i + 1];
            if (w >= 3000 && w <= 4300) out.push({ at: i, kind: 'cell', value: w / 1000 });
            if (w >= 20000 && w <= 46000) out.push({ at: i, kind: 'pack', value: w / 100 });
        }
        return out;
    }

    /* ---------- climate: estimates and the measured standing draw ---------- */
    const comfortKw = (d) => {
        const seats = Object.keys(d.seats || {}).reduce((a, k) => a + (d.seats[k] ? SEAT_KW[d.seats[k]] : 0), 0);
        return { seats, wheel: d.wheel ? WHEEL_KW : 0 };
    };
    const blowerKw = (d) => {
        if (!G.isNum(d.blower) || d.blower <= 0) return 0;
        const f = G.clamp(d.blower / Math.max(8, d.blowerTop || 8), 0, 1);
        return BLOWER_KW[0] + BLOWER_KW[1] * f * f;
    };
    /** Standing with the engine off and not plugged in: the pack only feeds the car's own consumers. */
    const standingDraw = (d, now) => {
        if (!G.isNum(d.kw) || d.engine || !G.isNum(d.speed) || d.speed > 1) return null;
        if (!d.demo && (!L.standSince || now - L.standSince < STAND_MS)) return null;
        return d.kw > 0.02 ? d.kw : null;          // negative = charging (plugged in)
    };
    const baseline = () => (G.isNum(st.baseKw) ? st.baseKw : BASELINE_KW);
    /** The on-board draw: learned while standing with climate, seats and wheel all off. */
    function learnBaseline(kw, now) {
        const d = { kw, engine: engineOn(), speed: L.speed };
        const draw = standingDraw(d, now), c = comfortKw(live);
        if (draw === null || L.climate !== false || c.seats || c.wheel || draw > 3) return;
        st.baseKw = G.isNum(st.baseKw) ? st.baseKw + (draw - st.baseKw) * 0.05 : draw;
        st.baseN = (st.baseN || 0) + 1;
        if (now - savedAt > 60000) save();
    }
    /** Climate power now: { kw, how } - measured while standing, else the sum of what the car reports / estimates. */
    // the last measured climate draw, used while driving as long as the climate setting stays the same
    let lastMeasured = null;
    /** The car's compressor power, when it really reports it (the X5 45e sends 0 with the A/C running). */
    const acReported = (d) => G.isNum(d.acKw) && (d.acKw > 0.05 || d.climate !== 'ac');
    /** What the climate unit itself reports for its compressor and heater (kW), or null. */
    function unitKw(d) {
        if (d.demo) return d.unit || null;
        const a = probeNow('ac'), h = probeNow('heater');
        if ((!a || !G.isNum(a.kw)) && (!h || !G.isNum(h.kw))) return null;
        return { ac: a && G.isNum(a.kw) ? a.kw : 0, heater: h && G.isNum(h.kw) ? h.kw : 0 };
    }
    /** The rest of the climate draw with the climate on (pumps, fans, the unit itself): learned while measuring. */
    const otherKw = () => (G.isNum(st.otherKw) ? st.otherKw : 0.3);
    function climatePower(d, now) {
        const c = comfortKw(d), u = unitKw(d), on = d.climate !== false;
        const est = u ? u.ac + u.heater + (on ? blowerKw(d) + otherKw() : 0) + c.seats + c.wheel
            : (acReported(d) ? d.acKw : 0) + blowerKw(d) + c.seats + c.wheel;
        const draw = standingDraw(d, now);
        if (draw !== null) {
            const kw = Math.max(0, draw - baseline());
            if (!d.demo) {
                lastMeasured = { kw, t: now, climate: d.climate, comfort: c.seats + c.wheel };
                // pumps / fans: what the measurement holds beyond the compressor, heater, blower and seats
                if (u && on) {
                    const o = G.clamp(kw - u.ac - u.heater - blowerKw(d) - c.seats - c.wheel, 0, 1.5);
                    st.otherKw = G.isNum(st.otherKw) ? st.otherKw + (o - st.otherKw) * 0.1 : o;
                }
            }
            return { kw, how: 'measured', draw, est, u };
        }
        // driving: the climate unit's own figures when it has them
        if (u) return { kw: est, how: 'climate unit', draw: null, est, u };
        if (d.climate === false && !c.seats && !c.wheel) return { kw: 0, how: 'estimated', draw: null, est };
        const lm = lastMeasured;
        if (lm && lm.climate === d.climate && now - lm.t < 30 * 60000) {
            // the last measurement, with the seat / wheel heating switched on or off since then
            return { kw: Math.max(0, lm.kw - lm.comfort + c.seats + c.wheel), how: 'last measured', draw: null, est, ago: now - lm.t };
        }
        return { kw: est, how: 'estimated', draw: null, est };
    }
    /* ---------- what the pages show ---------- */
    const demo = new Demo();
    const usingDemo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !diag.available && !live.kwT);
    function data() {
        if (usingDemo()) return Object.assign(demo.sample(), { demo: true });
        const now = Date.now(), fresh = (t, s) => t && now - t < s * 1000;
        const slowOk = (k) => live.slowT[k] && now - live.slowT[k] < SLOW_KEEP;
        const staleAfter = Math.max(30, settings.get('slowPoll') * 4) * 1000;
        const stale = {}; SLOW.forEach((k) => { stale[k] = !!live.slowT[k] && now - live.slowT[k] > staleAfter ? now - live.slowT[k] : 0; });
        return {
            demo: false, kw: live.kwT && now - live.kwT < KW_KEEP ? live.kw : null, kwAge: live.kwT ? now - live.kwT : null, stale,
            v: fresh(live.vT, 60) ? live.v : fresh(L.lscVT, 60) ? L.lscV : null, a: fresh(live.kwT, 10) ? live.a : null,
            speed: L.speed, engine: engineOn(), soc: slowOk('soc') ? live.soc : null,
            cellV: slowOk('cellV') ? live.cellV : null, cellT: slowOk('cellT') ? live.cellT : null, carT: L.batt,
            coolant: slowOk('coolant') ? live.coolant : null, limits: slowOk('limits') ? live.limits : null,
            ambient: L.ambient, climate: L.climate, blower: L.blower, blowerTop: L.blowerTop,
            acKw: L.acKw, seats: L.seats, wheel: L.wheel,
        };
    }
    /** Cell temperatures: the battery unit's (cell core), else the car's own. */
    const cellTemps = (d) => (d.cellT && G.isNum(d.cellT.avg) ? Object.assign({ src: 'cell core (battery unit)' }, d.cellT)
        : d.carT && G.isNum(d.carT.avg) ? Object.assign({ src: 'the car\'s battery temperature' }, d.carT) : null);
    /** Power the battery allows now (kW): { out, in } from the current limits x pack voltage. */
    const limitsKw = (d) => (d.limits && G.isNum(d.v) ? {
        out: G.isNum(d.limits.dischargeA) ? d.limits.dischargeA * d.v / 1000 : null,
        in: G.isNum(d.limits.chargeA) ? d.limits.chargeA * d.v / 1000 : null,
    } : null);

    /* ---------- units ---------- */
    const F = () => settings.get('tempUnit') === 'f';
    const T = (c) => (G.isNum(c) ? (F() ? c * 9 / 5 + 32 : c) : null);
    const dT = (c) => (G.isNum(c) ? (F() ? c * 9 / 5 : c) : null);          // a temperature difference
    const tU = () => (F() ? '°F' : '°C');
    const fmtT = (c, dec) => (G.isNum(c) ? G.fmt(T(c), dec || 0) + ' ' + tU() : '--');

    /** Power for display: { text, col, what }; held 0.25 s so it doesn't flicker at 60 fps. */
    function power(d, t) {
        if (!G.isNum(d.kw)) {
            const why = d.demo ? 'DEMO' : !diag.available ? 'NO DIAGNOSTIC LINK' : iFail >= 3 ? (settings.get('diagPage') ? 'NO REPLY - SEE DIAGNOSTICS' : 'NO REPLY') : 'READING';
            return { kw: null, text: '--', col: t.dim, what: why };
        }
        const v = G.hold('live.kw', d.kw, 150), a = Math.abs(v);
        const moving = G.isNum(d.speed) && d.speed > 1;
        const what = v > IDLE_KW ? (moving ? 'DRIVING' : 'DRAWING') : v < -IDLE_KW ? (moving ? 'REGEN' : 'CHARGING') : 'IDLE';
        // older than a couple of reads: the last value, dimmed, until a new one arrives
        const old = !d.demo && G.isNum(d.kwAge) && d.kwAge > 1500;
        return { kw: v, text: (v < -IDLE_KW ? '-' : '') + G.fmt(a, a < 10 ? 1 : 0), col: old ? t.dim : v < -IDLE_KW ? GO : a >= 60 ? t.warn : t.text, what, old };
    }

    /** Centre-zero power bar: regen / charge to the left, drive to the right, scaled to the limits. */
    function powerBar(cv, t, x, y, w, kw, lim) {
        const outMax = Math.max(20, lim && G.isNum(lim.out) ? lim.out : settings.get('gaugeKw'));
        const inMax = Math.max(10, lim && G.isNum(lim.in) && lim.in >= 15 ? lim.in : settings.get('gaugeKw') * 0.5);
        const span = outMax + inMax, x0 = x + w * inMax / span, h = 30;
        const X = (v) => x0 + G.clamp(v, -inMax, outMax) / span * w;
        cv.roundRect(x, y, w, h, 6, withAlpha(t.track, 0.9));
        const sv = G.smooth('live.bar', kw, 22);
        if (G.isNum(sv) && Math.abs(sv) > 0.05) {
            if (sv > 0) cv.rampRect(x0, y, X(sv) - x0, h, 4, t.hotRamp || t.ramp, x0, x + w - x0);
            else cv.roundRect(X(sv), y, x0 - X(sv), h, 4, GO);
        }
        cv.fillRect(Math.round(x0) - 1, y - 8, 3, h + 16, t.text);
        // scale: every 20 kW (ticks), labels at the ends and zero
        for (let v = -Math.floor(inMax / 20) * 20; v <= outMax; v += 20) if (v) cv.fillRect(Math.round(X(v)), y + h + 2, 2, 8, t.tick);
        cv.text('0', x0, y + h + 30, 18, t.dim, { align: 'center', font: 'bold' });
        const lbl = (v) => G.fmt(v, 0) + ' kW';
        const inLim = lim && G.isNum(lim.in) && lim.in >= 15;
        cv.text((inLim ? 'REGEN MAX ' : '') + '-' + lbl(inMax), x, y + h + 30, 18, inLim ? GO : t.dim, { font: 'bold' });
        cv.text((lim && G.isNum(lim.out) ? 'BATTERY MAX ' : '') + lbl(outMax), x + w, y + h + 30, 18, t.dim, { font: 'bold', align: 'right' });
    }

    /**
     * kW over the last `secs` around a zero line, each reading drawn at its own time until the next one
     * (a step), so the trace scrolls smoothly at any read rate. A gap of over 4 s (no reading) stays empty.
     */
    function powerTrace(cv, t, x, y, w, h, pts, secs, top, bottom) {
        const now = Date.now(), y0 = Math.round(y + h * top / (top + bottom));
        const X = (ts) => x + w - (now - ts) / (secs * 1000) * w;
        cv.fillRect(x, y0, w, 1, withAlpha(t.tick, 0.8));
        cv.clip(x, y, w, h);
        for (let i = 0; i < pts.length; i++) {
            const [ts, v] = pts[i], next = i + 1 < pts.length ? pts[i + 1][0] : now;
            if (!G.isNum(v) || Math.abs(v) < 0.05 || next - ts > 4000) continue;
            const xa = Math.max(x, X(ts)), xb = Math.min(x + w, X(next));
            if (xb <= x || xb - xa < 0.5) continue;
            const hh = G.clamp(v / (v > 0 ? top : bottom), -1, 1) * (v > 0 ? y0 - y : y + h - y0);
            cv.fillRect(xa, v > 0 ? y0 - hh : y0, xb - xa, Math.abs(hh), v > 0 ? withAlpha(t.text, 0.75) : withAlpha(GO, 0.85));
        }
        cv.noclip();
        cv.text(secs >= 120 ? Math.round(secs / 60) + ' min ago' : secs + ' s ago', x, y + h + 22, 16, t.dim);
        cv.text('now', x + w, y + h + 22, 16, t.dim, { align: 'right' });
    }

    /** Demo history: f(demo sample) over the last `secs`, every `step` s. */
    function demoHistory(secs, step, f) {
        const out = [], now = Date.now(), t0 = demo.t0;
        for (let i = secs; i >= 0; i -= step) {
            demo.t0 = t0 + i * 1000;
            out.push([now - i * 1000, f(Object.assign(demo.sample(), { demo: true }))]);
        }
        demo.t0 = t0;
        return out;
    }
    /** Cell temperature colours: cold packs give less power and regen, hot ones get limited. */
    const tempColor = (t, c) => (!G.isNum(c) ? t.dim : c < 5 ? t.cold : c > 45 ? t.crit : c > 38 ? t.warn : t.text);

    /** Battery power now: kW, what the pack does, V / A, a bar against the battery's limits and (room permitting) the last two minutes. */
    function renderPowerPanel(cv, t, d, x, y, w, h) {
        const pw = power(d, t), lim = limitsKw(d), r = x + w - 24, big = h >= 400;
        G.panel(cv, t, x, y, w, h, 'Live battery usage');
        const ky = y + (big ? 152 : 118);
        const vw = cv.text(pw.text, x + 24, ky, big ? 120 : 84, pw.col, { font: 'num' });
        cv.text('kW', x + 34 + vw, ky, big ? 38 : 30, t.dim, { font: 'bold' });
        const pcol = pw.what === 'REGEN' || pw.what === 'CHARGING' ? GO : pw.kw === null ? t.dim : t.text;
        cv.text(pw.what, r, y + 72, 26, pcol, { font: 'bold', spacing: 2, align: 'right' });
        cv.text(G.isNum(d.v) ? G.fmt(d.v, 0) + ' V' + (G.isNum(d.a) ? '  ·  ' + G.fmt(-d.a * (cfg.powerSign < 0 ? 1 : -1), 0) + ' A' : '') : 'pack --', r, y + 106, 22, t.dim, { align: 'right' });
        if (d.engine) cv.text('ENGINE RUNNING', r, y + 138, 20, t.warn, { font: 'bold', spacing: 1.5, align: 'right' });
        const by = ky + 30;
        powerBar(cv, t, x + 24, by, w - 48, pw.kw, lim);
        const ty = by + 70, th = y + h - 34 - ty;
        if (th >= 40) {
            const top = Math.max(20, ...trace.map((p) => p[1]), 0) * 1.1, bottom = Math.max(10, ...trace.map((p) => -p[1]), 0) * 1.1;
            const tr = d.demo ? demoHistory(TRACE_S, 1, (q) => q.kw) : trace;
            powerTrace(cv, t, x + 24, ty, w - 48, th, tr, TRACE_S, d.demo ? 60 : top, d.demo ? 25 : bottom);
        }
    }

    /** Battery: its power now (left; Battery health under it is eDrive's, main.js: 24, 360, 560, 152) and every cell. */
    function renderBattery(cv, t, d) {

        // ---- every cell's voltage: the lowest and highest marked, scaled to the spread; the cells' temperature
        const x = 608, w = 968, r = x + w - 24;
        const cvv = d.cellV, cells = cvv && cvv.cells;
        G.panel(cv, t, x, 44, w, 468, 'Cells' + (cells ? '  (' + cells.length + ')' : ''));
        const spread = cvv && G.isNum(cvv.min) && G.isNum(cvv.max) ? (cvv.max - cvv.min) * 1000 : null;
        const scol = !G.isNum(spread) ? t.dim : spread > 100 ? t.crit : spread > 50 ? t.warn : GO;
        const head = (hx, label, v, c, sub) => {
            cv.text(label, hx, 112, 18, t.dim, { font: 'bold', spacing: 1.2 });
            cv.text(v, hx, 148, 32, c, { font: 'bold' });
            if (sub) cv.text(sub, hx, 172, 16, t.dim);
        };
        head(x + 24, 'LOWEST', cvv && G.isNum(cvv.min) ? G.fmt(cvv.min, 3) + ' V' : '--', t.warn, cvv && cvv.minAt ? 'cell ' + cvv.minAt : '');
        head(x + 234, 'HIGHEST', cvv && G.isNum(cvv.max) ? G.fmt(cvv.max, 3) + ' V' : '--', t.accent2 || t.text, cvv && cvv.maxAt ? 'cell ' + cvv.maxAt : '');
        head(x + 444, 'SPREAD', G.isNum(spread) ? G.fmt(spread, 0) + ' mV' : '--', scol,
            G.isNum(spread) ? (spread > 100 ? 'out of balance' : spread > 50 ? 'high (normal under load)' : 'well balanced') : '');
        const ct = cellTemps(d);
        head(x + 654, 'TEMPERATURE', ct ? fmtT(ct.avg) : '--', ct ? tempColor(t, ct.avg) : t.dim,
            ct && G.isNum(ct.min) && G.isNum(ct.max) ? G.fmt(T(ct.min), 0) + ' - ' + G.fmt(T(ct.max), 0) + ' ' + tU() : '');
        cv.text('CHARGE', r, 112, 18, t.dim, { font: 'bold', spacing: 1.2, align: 'right' });
        const pc = cv.text('%', r, 148, 20, t.dim, { font: 'bold', align: 'right' });
        cv.text(G.isNum(d.soc) ? G.fmt(d.soc, 1) : '--', r - pc - 6, 148, 32, d.stale && d.stale.soc ? t.dim : t.text, { font: 'bold', align: 'right' });
        if (G.isNum(d.soc)) cv.text('~' + G.fmt(d.soc / 100 * settings.get('designKwh'), 1) + ' kWh', r, 172, 16, t.dim, { align: 'right' });
        if (cells) {
            // bars: from a floor below the lowest cell, so the differences show
            const x0 = x + 80, bw0 = r - x0, btop = 210, base = 420, n = cells.length, bw = bw0 / n;
            const pad = Math.max(0.005, (cvv.max - cvv.min) * 0.6), vlo = cvv.min - pad, vhi = cvv.max + pad * 0.4;
            const Y = (v) => base - (v - vlo) / (vhi - vlo) * (base - btop);
            [vlo, vhi].forEach((v) => {
                cv.fillRect(x0, Math.round(Y(v)), bw0, 1, withAlpha(t.tick, 0.35));
                cv.text(G.fmt(v, 3), x0 - 8, Y(v) + 6, 15, t.dim, { align: 'right' });
            });
            cv.fillRect(x0, Math.round(Y(cvv.avg)), bw0, 1, withAlpha(t.text, 0.5));
            cells.forEach((v, i) => {
                if (!G.isNum(v)) return;
                const c = i + 1 === cvv.minAt ? t.warn : i + 1 === cvv.maxAt ? (t.accent2 || t.text) : withAlpha(t.text, 0.7);
                cv.fillRect(x0 + i * bw + 1, Y(v), Math.max(1, bw - 2), base - Y(v), c);
            });
            for (let i = 0; i < n; i += 12) cv.text(String(i + 1), x0 + i * bw + bw / 2, base + 22, 14, t.dim, { align: 'center' });
            cv.text(String(n), x0 + (n - 1) * bw + bw / 2, base + 22, 14, t.dim, { align: 'center' });
        } else cv.text(settings.get('diagPage') ? 'no reading - see Diagnostics' : 'no reading yet', x + w / 2, 300, 24, t.dim, { align: 'center' });
    }

    /** This drive: energy used, regen, net; what it went to (driving vs. climate); peaks. Wide (w >= 700) or tall. */
    function renderTrip(cv, t, d, x, y0, w, h, foot, inBattery) {
        const r = x + w - 24;
        G.panel(cv, t, x, y0, w, h, 'This drive');
        if (w < 700) return renderTripTall(cv, t, d, x, y0, w, h, foot, inBattery);
        const tp = tripNow(d);
        const col = (cx, label, v, c) => {
            cv.text(label, cx, y0 + 72, 18, t.dim, { font: 'bold', spacing: 1.2 });
            const ww = cv.text(G.fmt(v, v >= 10 ? 1 : 2), cx, y0 + 120, 42, c, { font: 'num' });
            cv.text('kWh', cx + 6 + ww, y0 + 120, 20, t.dim);
        };
        col(x + 24, 'USED', tp.out, t.text);
        col(x + 200, 'REGEN', tp.regen, GO);
        col(x + 376, 'NET', tp.out - tp.regen, t.text);
        const clim = Math.min(tp.climate || 0, tp.out), drive = Math.max(0, tp.out - clim);
        const cp2 = tp.out > 0.005 ? clim / tp.out : 0, dp = tp.out > 0.005 ? 1 - cp2 : 0;
        const pct = (f) => (tp.out > 0.005 ? Math.round(f * 100) + ' %' : '--');
        const sx = x + 580, sw = r - sx;
        cv.text('DRIVING  ' + G.fmt(drive, 2) + ' kWh  ' + pct(dp), sx, y0 + 72, 18, t.text, { font: 'bold', spacing: 1 });
        cv.text('CLIMATE  ' + G.fmt(clim, 2) + ' kWh  ' + pct(cp2), r, y0 + 98, 18, t.warn, { font: 'bold', spacing: 1, align: 'right' });
        cv.roundRect(sx, y0 + 110, sw, 14, 5, withAlpha(t.track, 0.9));
        if (tp.out > 0.005) {
            if (dp > 0.005) cv.roundRect(sx, y0 + 110, Math.max(4, sw * dp), 14, 5, withAlpha(t.text, 0.8));
            if (cp2 > 0.005) cv.roundRect(sx + sw * dp, y0 + 110, Math.max(4, sw * cp2), 14, 5, t.warn);
        }
        const mins = Math.round((Date.now() - tp.since) / 60000);
        cv.text('peak ' + G.fmt(tp.peakOut, 0) + ' kW out  ·  ' + G.fmt(tp.peakIn, 0) + ' kW regen  ·  ' + (tp.charged > 0.05 ? 'charged ' + G.fmt(tp.charged, 2) + ' kWh  ·  ' : '')
            + 'since ' + (mins < 1 ? 'just now' : mins + ' min ago') , x + 24, y0 + 168, 18, t.dim);
    }
    const tripNow = (d) => (d.demo ? { out: 2.84, regen: 0.61, charged: 0, climate: 0.48, peakOut: 61, peakIn: 24, since: Date.now() - 23 * 60000 } : trip);
    function renderTripTall(cv, t, d, x, y0, w, h, foot, inBattery) {
        const tp = tripNow(d), r = x + w - 24;
        const row = (y, label, v, c) => {
            cv.text(label, x + 24, y, 20, t.dim, { font: 'bold', spacing: 1.5 });
            const kw = cv.text('kWh', r, y + 44, 22, t.dim, { align: 'right' });
            cv.text(G.fmt(v, v >= 10 ? 1 : 2), r - kw - 8, y + 44, 48, c, { font: 'num', align: 'right' });
        };
        // used - regen = total, side by side (kWh)
        const cols = [[x + 24, 'USED', tp.out, t.text, 'left'], [x + w / 2, 'REGEN', tp.regen, GO, 'center'],
            [r, 'TOTAL', tp.out - tp.regen, t.text, 'right']];
        cols.forEach(([cx, label, v, c, align]) => {
            cv.text(label, cx, y0 + 84, 20, t.dim, { font: 'bold', spacing: 1.5, align });
            cv.text(G.fmt(v, v >= 10 ? 1 : 2), cx, y0 + 136, 44, c, { font: 'num', align });
            cv.text('kWh', cx, y0 + 166, 18, t.dim, { align });
        });
        if (inBattery) {
            cv.text('IN BATTERY', x + 24, y0 + 222, 20, t.dim, { font: 'bold', spacing: 1.5 });
            const kw2 = cv.text('kWh', r, y0 + 278, 22, t.dim, { align: 'right' });
            const tw = cv.text(' / ' + inBattery[1], r - kw2 - 8, y0 + 278, 30, t.dim, { font: 'bold', align: 'right' });
            cv.text(inBattery[0], r - kw2 - 8 - tw, y0 + 278, 48, t.text, { font: 'num', align: 'right' });
        }
        const clim = Math.min(tp.climate || 0, tp.out), drive = Math.max(0, tp.out - clim);
        const cp2 = tp.out > 0.005 ? clim / tp.out : 0, dp = tp.out > 0.005 ? 1 - cp2 : 0;
        const pct = (f) => (tp.out > 0.005 ? Math.round(f * 100) + ' %' : '--'), yb = y0 + 340, sw = w - 48;
        cv.text('DRIVING ' + pct(dp), x + 24, yb, 18, t.text, { font: 'bold', spacing: 1 });
        cv.text('CLIMATE ' + pct(cp2), r, yb, 18, t.warn, { font: 'bold', spacing: 1, align: 'right' });
        cv.roundRect(x + 24, yb + 12, sw, 14, 5, withAlpha(t.track, 0.9));
        if (tp.out > 0.005) {
            if (dp > 0.005) cv.roundRect(x + 24, yb + 12, Math.max(4, sw * dp), 14, 5, withAlpha(t.text, 0.8));
            if (cp2 > 0.005) cv.roundRect(x + 24 + sw * dp, yb + 12, Math.max(4, sw * cp2), 14, 5, t.warn);
        }
        (foot || []).forEach(([txt, col], i) => cv.text(txt, x + 24, y0 + 412 + i * 30, 20, col || t.dim, { font: 'bold', spacing: 1 }));
    }

    function renderUnit(cv, t, d) {
        G.panel(cv, t, 24, 44, 1552, 468, 'Battery unit (UDS)');
        const link = diag.p ? (diag.available ? 'link up' : 'link down') : 'no link (' + (diag.error || 'not started') + ')';
        const rr = readRate();
        cv.text('UDS 22  ·  ' + link + '  ·  power read ' + (rr ? G.fmt(rr.hz, 1) + 'x/s, ' + G.fmt(rr.ms, 0) + ' ms each' : 'n/a') + (pMiss ? '  ·  power missed ' + pMiss : '') + (Object.keys(slowFail).length ? '  ·  missed ' + Object.keys(slowFail).map((k) => k + ' ' + slowFail[k]).join(' ') : '') + '  ·  power sign ' + cfg.powerSign + '  ·  baseline ' + G.fmt(baseline(), 2) + ' kW (' + (st.baseN || 0) + ' samples)', 48, 112, 22, t.text, { font: 'label' });
        const cols = [48, 200, 290, 380, 900, 1290];
        ['VALUE', 'ECU', 'DID', 'REPLY', 'DECODED', 'STATUS'].forEach((h, i) => cv.text(h, cols[i], 156, 20, t.dim, { font: 'bold', spacing: 1 }));
        cv.fillRect(48, 168, 1504, 1, t.tick);
        const nRows = Object.keys(Object.assign({}, cfg.fast, cfg.slow)).reduce((a, k) => a + ((cfg.fast[k] || cfg.slow[k]) || []).length, 0);
        const rowH = Math.min(36, Math.floor(270 / Math.max(1, nRows))), fz = rowH >= 30 ? 20 : 16;
        let y = 168 + Math.max(26, rowH);
        const groups = Object.assign({}, cfg.fast, cfg.slow);
        Object.keys(groups).forEach((name) => (groups[name] || []).forEach((c, i) => {
            const p = primary(c), r = reader.raws[reader.key(p)], ecu = c.ecu == null ? cfg.ecu : c.ecu;
            const used = pick[name] === i && r && r.ok;
            cv.text(name + (used ? ' *' : ''), cols[0], y, fz + 2, used ? GO : t.text, { font: 'bold' });
            cv.text('0x' + hex(ecu), cols[1], y, fz, t.text, { font: 'label' });
            cv.text(c.did, cols[2], y, fz, t.text, { font: 'label' });
            const b = r ? r.bytes || '-' : '-';
            cv.text(b.length > 46 ? b.slice(0, 45) + '…' : b, cols[3], y, fz - 2, t.dim, { font: 'label' });
            const dec = r && r.fields ? Object.keys(r.fields).map((k) => k + ' ' + (G.isNum(r.fields[k]) ? +r.fields[k].toFixed(3) : 'n/a')).join('  ')
                : r && G.isNum(r.value) ? String(+r.value.toFixed(3)) : '-';
            cv.text(dec.length > 34 ? dec.slice(0, 33) + '…' : dec, cols[4], y, fz - 2, t.text, { font: 'label' });
            const why = r ? (r.ok ? 'OK' : r.why) : 'not read';
            cv.text(why.length > 22 ? why.slice(0, 21) + '…' : why, cols[5], y, fz - 2, r && r.ok ? GO : r ? t.warn : t.dim, { font: 'label' });
            y += rowH;
        }));
        cv.text('A value n/a or wrong? Adjust config.battery in apps/edrive/app.json and rebuild. Regen shown while accelerating: powerSign 1.', 48, 492, 18, t.dim);
    }

    function renderScan(cv, t, d) {
        if (!scan.running && !scan.t && diag.available) runScan();
        G.panel(cv, t, 24, 44, 1552, 468, 'Scan: ' + SCAN_UNITS[scan.unit].name + ' 0x' + hex(scan.unit));
        const pct = Math.round(scan.done / scan.total * 100);
        const ago = (ms) => (ms < 90000 ? 'just now' : ms < 5400000 ? Math.round(ms / 60000) + ' min ago' : Math.round(ms / 3600000) + ' h ago');
        cv.text(scan.running ? 'SCANNING  ' + pct + ' %  (' + scan.done + ' / ' + scan.total + ')  -  stay on this page, car in READY'
            : scan.known ? scan.hits.length + ' identifiers known for this car  ·  Reset = new baseline'
            : scan.t ? 'DONE ' + ago(Date.now() - scan.t) + '  ·  ' + scan.hits.length + ' answer' + (scan.noReply >= 25 && !scan.hits.length ? ' (unit not answering)' : '') + '  ·  Reset = new baseline'
            : diag.available ? 'starting...' : 'no diagnostic link yet', 1552, 80, 20, scan.running ? t.warn : t.dim, { font: 'bold', align: 'right' });
        const cells = [], packs = [], ch = changes();
        if (scan.unit === 7) scan.hits.forEach((h) => guesses(h.bytes).forEach((g) => (g.kind === 'cell' ? cells : packs).push(h.did + '@' + g.at + ' ' + (g.kind === 'cell' ? g.value.toFixed(3) : g.value.toFixed(1)))));
        const block = (y, label, list) => {
            cv.text(label + ' (' + list.length + ')', 48, y, 20, t.dim, { font: 'bold', spacing: 1 });
            const txt = list.join('   ') || '-';
            for (let i = 0, line = 0; i < txt.length && line < 3; line++) {
                let j = Math.min(txt.length, i + 150);
                if (j < txt.length) { const k = txt.lastIndexOf('   ', j); if (k > i) j = k; }
                cv.text(txt.slice(i, j).trim(), 48, y + 30 + line * 26, 18, t.text, { font: 'label' });
                i = j;
            }
        };
        if (scan.unit === 7) {
            block(126, 'LOOK LIKE CELL VOLTAGES (V)', cells);
            block(236, 'LOOK LIKE PACK VOLTAGE (V)', packs);
        } else {
            block(126, ch ? 'CHANGED SINCE RESET ' + ago(Date.now() - cmpState.t).toUpperCase() + ' (identifier@byte before>now)  ·  live, read ' + cmpState.cycles + 'x' : 'LIVE COMPARISON: starts when the scan is done', ch || []);
            cv.text('Climate OFF, press Reset drive totals, then set HI (heater) or LO with A/C: the values that follow it show up here.', 48, 300, 18, t.dim);
        }
        cv.fillRect(48, 330, 1504, 1, t.tick);
        cv.text('ALL THAT ANSWER (identifier: bytes)', 48, 358, 20, t.dim, { font: 'bold', spacing: 1 });
        const all = scan.hits.map((h) => h.did + ':' + (h.bytes.length || (cmpState.now[h.did] || []).length)).join('  ');
        for (let i = 0, line = 0; i < all.length && line < 4; line++) {
            cv.text(all.slice(i, i + 170), 48, 388 + line * 24, 17, t.text, { font: 'label' });
            i += 170;
        }
        cv.text('Take a photo when it says DONE. Settings > Scan unit picks the unit. Replies are saved in the app\'s data folder (scan_' + hex(scan.unit) + '.json).', 48, 498, 18, t.dim);
    }

    /* ---------- home-screen widget ----------
     * Drawn into the layout's image cell (app.json startWidget). Big widget: power, state, bar,
     * V / A, charge, cell temperature and this drive; small one: power, state, charge and the bar.
     * The layout draws its own title ("eDrive") above the image, so the image leaves room for it. */
    const wcan = {};
    function widgetBar(cv, t, x, y, w, h, kw, lim) {
        const outMax = Math.max(20, lim && G.isNum(lim.out) ? lim.out : settings.get('gaugeKw'));
        const inMax = Math.max(10, lim && G.isNum(lim.in) && lim.in >= 15 ? lim.in : settings.get('gaugeKw') * 0.5);
        const span = outMax + inMax, x0 = x + w * inMax / span;
        const X = (v) => x0 + G.clamp(v, -inMax, outMax) / span * w;
        cv.roundRect(x, y, w, h, h / 2, withAlpha(t.track, 0.9));
        const sv = G.smooth('live.wbar', kw, 22);
        if (G.isNum(sv) && Math.abs(sv) > 0.05) {
            if (sv > 0) cv.rampRect(x0, y, X(sv) - x0, h, h / 2, t.hotRamp || t.ramp, x0, x + w - x0);
            else cv.roundRect(X(sv), y, x0 - X(sv), h, h / 2, GO);
        }
        cv.fillRect(Math.round(x0) - 1, y - 4, 3, h + 8, t.text);
    }
    /* Small widget: the layout doesn't show the picture at that size (log: images pushed, nothing on
     * screen), so its own text lines and progress bar carry the numbers there; cleared on the big one. */
    const wtext = {};
    function widgetCells(inst) {
        const t = ctx.theme(), d = data(), pw = power(d, t), lim = limitsKw(d);
        const max = pw.kw > 0 ? Math.max(20, lim && G.isNum(lim.out) ? lim.out : settings.get('gaugeKw'))
            : Math.max(10, lim && G.isNum(lim.in) && lim.in >= 15 ? lim.in : settings.get('gaugeKw') * 0.5);
        const on = !inst.big;
        const ct = cellTemps(d), tp = d.demo ? { out: 2.84, regen: 0.61 } : trip;
        const amps = G.isNum(d.a) ? G.fmt(-d.a * (cfg.powerSign < 0 ? 1 : -1), 0) + ' A' : '';
        const cells = {
            Title: [on ? 'eDrive' : '', 'Text'],
            // one short line per text cell of the layout (each shows ~20 characters)
            TextRecordings: [on ? pw.text + ' kW   ' + (G.isNum(d.soc) ? G.fmt(d.soc, 0) + ' %' : '-- %') : '', 'Text'],
            TextCam: [on ? pw.what + (G.isNum(d.v) ? '  ' + G.fmt(d.v, 0) + ' V  ' + amps : '') : '', 'Text'],
            ProgressbarVisible: [on, 'Bool'],
            Progress: [on && G.isNum(pw.kw) ? Math.round(G.clamp(Math.abs(pw.kw) / max, 0, 1) * 100) : 0, 'Float'],
            TimeElapsed: [on ? 'Cells ' + (ct ? fmtT(ct.avg) : '--') : '', 'Text'],
            TimeRemaining: [on ? 'Drive ' + G.fmt(tp.out - tp.regen, 2) + ' kWh' : '', 'Text'],
        };
        const prev = wtext[inst.spawnId] || (wtext[inst.spawnId] = {});
        Object.keys(cells).forEach((k) => {
            const v = JSON.stringify(cells[k][0]);
            if (prev[k] === v) return;
            prev[k] = v;
            ctx.widget.set(inst.spawnId, k, cells[k][0], cells[k][1]);
        });
    }
    /* Big widget picture. The HMI fills the widget with it and crops a fixed share of every edge
     * (about 5 % on the car, whatever the picture's size), so everything stays inside app.json
     * startWidget.safe (share of width / height kept clear on each side). The layout's title is
     * set empty (startWidget.cells), so the picture has the whole widget. */
    function renderWidget(inst) {
        if (inst) widgetCells(inst);
        const sw0 = ctx.spec.startWidget || {};
        const [w, h] = sw0.size || [384, 256], [sx, sy] = sw0.safe || [0.09, 0.1];
        const key = w + 'x' + h;
        const cv = (wcan[key] = wcan[key] || new Canvas(w, h)).clear([0, 0, 0, 0]);
        const t = ctx.theme(), d = data(), pw = power(d, t), lim = limitsKw(d);
        const scol = pw.what === 'REGEN' || pw.what === 'CHARGING' ? GO : pw.kw === null ? t.dim : t.text;
        const x0 = Math.round(w * sx), x1 = w - x0, y0 = Math.round(h * sy), y1 = h - y0, iw = x1 - x0;
        // top row: state left, V / A right
        cv.text(pw.what, x0, y0 + 18, 18, scol, { font: 'bold', spacing: 1.5 });
        cv.text((G.isNum(d.v) ? G.fmt(d.v, 0) + ' V' : '-- V') + (G.isNum(d.a) ? '   ' + G.fmt(-d.a * (cfg.powerSign < 0 ? 1 : -1), 0) + ' A' : ''),
            x1, y0 + 18, 16, t.dim, { align: 'right' });
        if (d.engine || d.demo) cv.text(d.engine ? 'ENGINE ON' : 'DEMO', (x0 + x1) / 2, y0 + 18, 13, t.warn, { font: 'bold', spacing: 1, align: 'center' });
        // power and charge
        const ky = y0 + 92;
        const vw = cv.text(pw.text, x0, ky, 70, pw.col, { font: 'num' });
        cv.text('kW', x0 + 8 + vw, ky, 22, t.dim, { font: 'bold' });
        const pc = cv.text('%', x1, ky, 20, t.dim, { font: 'bold', align: 'right' });
        cv.text(G.isNum(d.soc) ? G.fmt(d.soc, 0) : '--', x1 - pc - 4, ky, 46, G.isNum(d.soc) ? t.text : t.dim, { font: 'num', align: 'right' });
        widgetBar(cv, t, x0, ky + 16, iw, 12, pw.kw, lim);
        // bottom row
        const ct = cellTemps(d), tp = d.demo ? { out: 2.84, regen: 0.61 } : trip, yb = y1 - 26;
        const colm = (x, label, v, c, align) => {
            cv.text(label, x, yb, 13, t.dim, { font: 'bold', spacing: 1, align });
            cv.text(v, x, yb + 24, 21, c, { font: 'bold', align });
        };
        colm(x0, 'CELLS', ct ? fmtT(ct.avg) : '--', ct ? tempColor(t, ct.avg) : t.dim);
        colm((x0 + x1) / 2, 'THIS DRIVE', G.fmt(tp.out - tp.regen, 2) + ' kWh', t.text, 'center');
        colm(x1, 'REGEN', G.fmt(tp.regen, 2) + ' kWh', GO, 'right');
        return cv;
    }
    if (ctx.widget) {
        ctx.widget.loop(() => settings.get('widgetFps') || 8, renderWidget);
        // a widget just placed or shown: read the slow values now instead of waiting
        ctx.widget.onChange((why) => {
            if (why === 'resized' || why === 'placed') Object.keys(wtext).forEach((k) => delete wtext[k]);
            schedulePower(); if (ctx.widget.active()) readSlow();
        });
    }

    return {
        PAGES: ['battery'],
        DIAG: ['unit', 'scan'],
        NAMES: { battery: 'Battery', unit: 'Battery unit', scan: 'Scan' },
        /** This drive (energy used, regen, net, split, peaks) into a panel at x, y, w, h. */
        drawTrip(cv, t, x, y, w, h, foot, inBattery) { lastDrawT = Date.now(); renderTrip(cv, t, data(), x, y, w, h, foot, inBattery); },
        /** The Battery page's power panel (kW, bar, the last two minutes) at x, y, w, h. */
        drawPower(cv, t, x, y, w, h) { lastDrawT = Date.now(); renderPowerPanel(cv, t, data(), x, y, w, h); },
        /** A one-line "battery power now": label, kW and the bar (regen left, use right), no history. */
        drawPowerBar(cv, t, x, y, w) {
            lastDrawT = Date.now();
            const d = data(), pw = power(d, t);
            const lim = limitsKw(d);
            cv.text('LIVE BATTERY USAGE', x, y - 34, 20, t.dim, { font: 'bold', spacing: 1.5 });
            // the kW above the bar, over the end of its fill (kept inside the bar's width)
            const outMax = Math.max(20, lim && G.isNum(lim.out) ? lim.out : settings.get('gaugeKw'));
            const inMax = Math.max(10, lim && G.isNum(lim.in) && lim.in >= 15 ? lim.in : settings.get('gaugeKw') * 0.5);
            const kx = x + w * (inMax + G.clamp(G.isNum(pw.kw) ? pw.kw : 0, -inMax, outMax)) / (outMax + inMax);
            cv.text(pw.text + ' kW', G.clamp(kx, x + 50, x + w - 50), y + 4, 28, pw.col, { font: 'bold', align: 'center' });
            powerBar(cv, t, x, y + 18, w, pw.kw, lim);
        },
        /** The battery's power now as the pages show it: { kw, text, col, what } (kw null: no reading). */
        powerNow(t) { return power(data(), t); },
        /**
         * Measured consumption: kWh per km over the last km driven electric (perKm, over km; null before
         * 1 km) and over the last minute (nowPerKm, null while standing), from the battery's own power.
         */
        consumption() {
            if (usingDemo()) return { perKm: 0.168, km: USE_KM, nowPerKm: 0.21, demo: true };
            const u = st.use, nk = useNow.reduce((a, s) => a + s[1], 0), ne = useNow.reduce((a, s) => a + s[2], 0);
            return { perKm: u && u.km >= 1 ? Math.max(0.02, u.kwh / u.km) : null, km: u ? u.km : 0, nowPerKm: nk >= 0.1 ? ne / nk : null };
        },
        /** Draws page `name`; returns the data it showed. */
        draw(name, cv, t) {
            lastDrawT = Date.now();
            const d = data();
            ({ battery: renderBattery, unit: renderUnit, scan: renderScan })[name](cv, t, d);
            return d;
        },
        /**
         * The climate's power now when it is known better than eDrive's estimate: measured from the battery
         * (standing, engine off, not plugged in), the climate unit's own figures, or the last measurement with
         * the same setting - { kw, how }; else null.
         */
        climate() {
            const d = data();
            if (d.demo) return null;
            const cp = climatePower(d, Date.now());
            return cp.how === 'estimated' ? null : { kw: cp.kw, how: cp.how };
        },
        /** The first bar button on page `name`: this drive's totals, or the scan (a new baseline, or scan again). */
        action(name) {
            if (name === 'scan') {
                // a scan from the last week: a new baseline for the live comparison; else scan again
                if (scan.t && !scan.running && Date.now() - scan.t < 7 * 86400000 && scan.hits.length) rebase();
                else { scan.running = false; setTimeout(runScan, 2000); }
                return;
            }
            Object.assign(trip, { out: 0, regen: 0, charged: 0, climate: 0, peakOut: 0, peakIn: 0, since: Date.now() });
        },
        /** The first bar button's name on page `name` when it has an action there (action()), else null. */
        actionLabel: (name) => (name === 'scan' ? 'Reset' : name === 'battery' ? 'Reset drive totals' : null),
    };
};
