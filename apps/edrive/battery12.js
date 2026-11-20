'use strict';
/**
 * battery12.js - eDrive's 12 V pages on cars without a hybrid system (folded in from the 12V Battery app).
 *
 *   12 V battery  the state of charge the engine unit's energy management keeps (40AD) with the Ah left and the
 *                 five values before it, the registered capacity (40A9, follows a battery registration / coding);
 *                 the voltage with what the battery is doing - CHARGING / REGEN / SUPPLYING while the engine runs,
 *                 with it off the voltage judged as the car awake draws -; current and power from the battery
 *                 sensor, or on engine units that give none (e.g. a G20 320i's) the last two minutes' voltage in
 *                 their place; health, temperature, alternator, outside; this drive's regen and charging time
 *   History       the last hour's voltage and current (or the charge), the charge the car recorded, the time the
 *                 battery spent per charge band (40AD)
 *
 * Regen: BMW's energy management lets the battery feed the car while cruising (alternator resting) and charges it
 * when the driver lifts off or brakes. Charging (current in, or >= CHARGE_V without a current) while the car slows
 * down (its own speed falling) is REGEN. With a low charge the engine unit charges all the time until it recovers.
 *
 * The voltage: the first config.battery.v12 candidate that answers keeps being asked, remembered across restarts
 * (st.v12Pick); a miss or two of a slow unit (the gearbox unit on a G20) doesn't send the search over the others,
 * each of which can cost a timeout, and the ones that refuse are asked last.
 *
 * Read-only (UDS 22 / OBD 01). Every request goes through the car's gateway and keeps the car awake, so these reads
 * run while the car is driven (and IDLE_AFTER_MOVE after) and IDLE_AFTER_USER after the start or the page was opened
 * or a button pressed; parked longer they stop ("Read now" asks again), as live.js's do.
 *
 *   const b12 = require('./battery12')(ctx, { diag, reader, exclusive, live, st, save, usingDemo, kind, skip, page, render })
 *   (skip(candidate): true for a v12 candidate on a unit this car doesn't have, never asked)
 *   b12.PAGES, b12.NAMES; b12.readVolt(force) -> V or null; b12.readValues(force); b12.allowed(force);
 *   b12.fast() (read every FAST_MS now); b12.onSpeed(kmh); b12.touched(); b12.draw(name, cv, t, d)
 */
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { getLanguage } = require('./kit/i18n');

const GO = '#2fd27a';
const FAST_MS = 1000;             // the 12 V pages shown and in use: the voltage this often (regen, trend)
const SHOWN_MS = 3000;            // the screen counts as shown when drawn this recently
const VOLT_TIMEOUT_MS = 1500;     // one voltage candidate's wait (the kit's 4 s is for one-off reads)
const DIAG_OPTS = { retryBaseMs: 150, pendingTimeoutMs: 1500, callTimeoutMs: 2000 };
const MISS_LIMIT = 3;             // misses in a row of the source that worked before the others are tried
const RETRY_VOLT_MS = 15000;      // no source found yet: the search again after this
const FRESH_MS = 10000;           // a voltage / current this old still counts as now (a miss or two)
const KEEP_V_MS = 30000;          // a voltage this old is still shown (dimmed after FRESH_MS) rather than a blank
const MID_MS = 10000;             // temperature, alternator
const SOC_MS = 30000;             // the charge (40AD, else 56F0)
const SLOW_MS = 30 * 60000;       // capacity, health: they change over months
const FAIL_MS = 5 * 60000;        // a value that failed 3 times in a row: only this often
const NEVER_MS = 30 * 60000;      // one that never answered (this engine unit has none): only this often
const TREND_MS = 2 * 60000;       // the voltage in place of the current: last 2 minutes, every reading
const HIST_MS = 60 * 60000, HIST_STEP = 5000;
const DECEL_KMH = 1.5, DECEL_MS = 2000, DECEL_MIN_KMH = 8, REGEN_HOLD_MS = 3000;
const CHARGE_V = 13.2;            // no current reading: charging at or above this voltage
const LOW_SOC = 70;               // below this charge the engine unit charges all the time
const IDLE_AFTER_MOVE = 3 * 60000, IDLE_AFTER_USER = 10 * 60000;
const BANDS = [['b0_40', '0-40'], ['b40_60', '40-60'], ['b60_70', '60-70'], ['b70_80', '70-80'], ['b80_90', '80-90'], ['b90_100', '90-100']];

/** Demo: a car whose engine unit gives no current. A 90 s loop: charging after the start, cruising with lift-offs, standing. */
class Demo {
    constructor() { this.t0 = Date.now(); }
    sample(at) {
        const s = ((at || Date.now()) - this.t0) / 1000, ph = ((s % 90) + 90) % 90;
        const engine = ph < 60, lift = ph >= 30 && ph < 60 && (ph % 10) >= 6 && (ph % 10) < 9;
        const v = ph < 30 ? 14.1 + 0.5 * Math.exp(-ph / 10) : lift ? 14.7 : ph < 60 ? 12.75 + 0.05 * Math.sin(s) : 12.45 + 0.02 * Math.sin(s / 3);
        return { v, engine, regen: lift, soc: 78 + 2 * Math.sin(s / 40), socHist: [77, 79, 80, 77, 75],
            bands: { b0_40: 2, b40_60: 6, b60_70: 14, b70_80: 38, b80_90: 30, b90_100: 10 }, cap: 90, capNew: 90, soh: 92, t: 19, alt: 38 };
    }
}

module.exports = function battery12(ctx, sh) {
    const { settings, log } = ctx;
    const { diag, reader, exclusive, st, save } = sh;
    const L = sh.live;
    const cfg = Object.assign({ ecu: 7, v12: [] }, (ctx.spec.config && ctx.spec.config.battery) || {});
    const demo = new Demo();

    /* ---------- in use: the car driven, or the page opened / a button pressed within IDLE_AFTER_USER ---------- */
    let lastUserT = Date.now(), lastActiveT = 0, lastDrawT = 0;
    const engineOn = () => G.isNum(L.rpm) && L.rpm > 400 && Date.now() - L.rpmT < 5000;
    const driving = () => {
        const now = Date.now();
        if ((G.isNum(L.speed) && L.speed > 1) || engineOn()) {
            if (now - lastActiveT >= IDLE_AFTER_MOVE) log.info('12 V: in use again (driving)');
            lastActiveT = now;
        }
        return now - lastActiveT < IDLE_AFTER_MOVE;
    };
    const inUse = () => !L.left && (driving() || Date.now() - lastUserT < IDLE_AFTER_USER);
    const shown = () => Date.now() - lastDrawT < SHOWN_MS;
    let paused = false;
    /** Reads may go now: driven within IDLE_AFTER_MOVE, or the app started / the page used within IDLE_AFTER_USER. */
    const allowed = (force) => {
        const ok = !!force || inUse();
        if (!ok && !paused) log.info('12 V: parked, reads paused, the car can sleep');
        paused = !ok;
        return ok;
    };
    const touched = () => { const was = inUse(); lastUserT = Date.now(); if (!was) log.info('12 V: in use again (user)'); };

    /* ---------- the car slowing down (its own speed falling): with charging, that is REGEN ---------- */
    const speeds = [];
    let decelT = 0;
    const onSpeed = (kmh) => {
        if (!G.isNum(kmh)) return;
        const now = Date.now();
        speeds.push({ t: now, v: kmh });
        while (speeds.length && now - speeds[0].t > DECEL_MS) speeds.shift();
        const top = Math.max.apply(null, speeds.map((x) => x.v));
        if (kmh >= DECEL_MIN_KMH && top - kmh >= DECEL_KMH) decelT = now;
    };
    /** Engine running / off / not known: the car sends the rpm only when it changes, a stopped engine's 0 once. */
    const engineState = () => (!G.isNum(L.rpm) || !L.rpmT ? null : Date.now() - L.rpmT < 5000 ? L.rpm > 400 : L.rpm <= 400 ? false : null);

    /* ---------- UDS: candidates with several fields on one reply (40AD, 40A9) ---------- */
    async function readFields(c) {
        const names = Object.keys(c.fields || {});
        const p = Object.assign({ ecu: c.ecu, did: c.did, timeoutMs: c.timeoutMs || VOLT_TIMEOUT_MS, diagOpts: DIAG_OPTS }, c.fields[names[0]]);
        const v0 = await reader.read(p);
        if (v0 === null) return null;
        const r = reader.raws[reader.key(p)], bytes = r.bytes.split(' ').map((x) => parseInt(x, 16)), out = {};
        names.forEach((k, i) => {
            if (i === 0) { out[k] = v0; return; }
            const f = c.fields[k], at = 3 + (f.at || 0), n = f.bytes || 1;
            if (bytes.length < at + n) { out[k] = null; return; }
            let raw = 0;
            for (let j = 0; j < n; j++) raw = raw * 256 + bytes[at + j];
            if (raw === Math.pow(256, n) - 1) { out[k] = null; return; }          // all FF: no value
            if (f.signed && raw >= Math.pow(2, 8 * n - 1)) raw -= Math.pow(2, 8 * n);
            const v = raw * (f.factor == null ? 1 : f.factor) + (f.offset || 0);
            out[k] = (f.min != null && v < f.min) || (f.max != null && v > f.max) ? null : v;
        });
        return out;
    }
    const group = async (name) => {
        const list = cfg[name] || [];
        for (let i = 0; i < list.length; i++) {
            const v = await exclusive(() => readFields(list[i]), false, name);
            if (v) { reader.pick[name] = i; return v; }
        }
        return null;
    };

    /* ---------- the voltage: the source that answered keeps being asked ---------- */
    // res[i]: what candidate i did last - 'ok', 'nrc' (refused), 'none' (no reply, the unit isn't there), 'bad' (FF)
    const vs = { pick: G.isNum(st.v12Pick) ? st.v12Pick : null, miss: 0, fails: 0, tryT: 0, res: {} };
    const trend = [], hist = [];
    const trip = { regenS: 0, regenN: 0, chargeS: 0, wasRegen: false, minV: null, maxV: null };
    let histT = 0;
    // search order: those that answered before, untried ones, refused / FF, and last the ones that never reply
    // (each of those costs a whole timeout)
    const RANK = { ok: 0, new: 1, nrc: 2, bad: 2, none: 3 };
    async function readVolt(force) {
        const list = (cfg.v12 || []).map((c) => Object.assign({ timeoutMs: VOLT_TIMEOUT_MS, diagOpts: DIAG_OPTS }, c));
        if (!list.length) return null;
        const now = Date.now();
        // none answered 3 times in a row: only every RETRY_VOLT_MS (no hybrid system: it is all there is), else FAIL_MS
        if (!force && vs.fails >= 3 && now - vs.tryT < (sh.kind() === 'none' ? RETRY_VOLT_MS : FAIL_MS)) return null;
        vs.tryT = now;
        const one = async (i) => {
            // urgent: the voltage goes ahead of the other reads waiting for the link
            const v = await exclusive(() => reader.read(list[i]), true, 'v12');
            const r = reader.raws[reader.key(list[i])], why = (r && r.why) || '';
            vs.res[i] = v !== null ? 'ok' : /^NRC/.test(why) ? 'nrc' : /no reply/.test(why) ? 'none' : 'bad';
            return v;
        };
        let v = null;
        // sh.skip: candidates on units this car doesn't have (a fully electric car's engine and gearbox units)
        const skipped = (i) => !!(sh.skip && sh.skip(list[i]));
        const p = vs.pick !== null && list[vs.pick] && !skipped(vs.pick) ? vs.pick : null;
        if (p !== null) {
            v = await one(p);
            if (v !== null) vs.miss = 0;
            else if (++vs.miss < MISS_LIMIT) { return null; }
        }
        if (v === null) {
            const order = list.map((c, i) => i).filter((i) => i !== p && !skipped(i))
                .sort((a, b) => RANK[vs.res[a] || 'new'] - RANK[vs.res[b] || 'new'] || a - b);
            if (p !== null) order.push(p);
            for (const i of order) {
                v = await one(i);
                if (v !== null) {
                    vs.pick = i; vs.miss = 0;
                    if (st.v12Pick !== i) { st.v12Pick = i; save(); log.info('12 V from ' + reader.key(list[i])); }
                    break;
                }
            }
        }
        reader.pick.v12 = vs.pick;
        if (v === null) { vs.fails++; return null; }
        vs.fails = 0;
        onVolt(v, Date.now());
        return v;
    }
    function onVolt(v, now) {
        L.v12 = v; L.v12T = now;
        trend.push({ t: now, v });
        while (trend.length && now - trend[0].t > TREND_MS) trend.shift();
        trip.minV = trip.minV === null ? v : Math.min(trip.minV, v);
        trip.maxV = trip.maxV === null ? v : Math.max(trip.maxV, v);
        if (now - histT >= HIST_STEP) {
            histT = now;
            const i = L.x12T.i12 && now - L.x12T.i12 < FRESH_MS ? L.x12.i12 : null, s = soc();
            hist.push({ t: now, v, i, soc: s.src === 'dme' ? s.v : null });
            while (hist.length && now - hist[0].t > HIST_MS) hist.shift();
        }
    }

    /* ---------- the battery sensor's values, the charge, capacity and health ---------- */
    const last = {}, fails = {};
    const due = (k, every, force) => {
        const f = fails[k] || 0;
        return force || Date.now() - (last[k] || 0) >= (f >= 3 ? Math.max(every, L.x12T[k] ? FAIL_MS : NEVER_MS) : every);
    };
    const counted = (k, v) => { last[k] = Date.now(); fails[k] = v === null ? (fails[k] || 0) + 1 : 0; return v; };
    const one = (k) => exclusive(() => reader.value(k, (cfg[k] || []).map((c) => Object.assign({ timeoutMs: VOLT_TIMEOUT_MS, diagOpts: DIAG_OPTS }, c))), false, k);
    const keep = (k, v) => { if (v !== null) { L.x12[k] = v; L.x12T[k] = Date.now(); } };
    // the charge the engine unit keeps (40AD: now, the five before, time per band), its capacity (40A9): kept across restarts
    const x = { soc: st.soc40 || null, socT: 0, cap: st.cap12 || null };
    /**
     * The values besides the voltage. With the 12 V page up (fast) only the current and one of the others per
     * round, so the voltage comes every FAST_MS; else (or forced: Read now) all that are due.
     */
    async function readValues(force) {
        if (due('i12', 0, force)) keep('i12', counted('i12', await one('i12')));
        const quick = !force && fastNow();
        let n = 0;
        const go = (k, every) => due(k, every, force) && !(quick && n++ > 0);
        for (const k of ['t12', 'alt12']) if (go(k, MID_MS)) keep(k, counted(k, await one(k)));
        if (go('soc40', SOC_MS)) {
            const r = counted('soc40', await group('soc40'));
            if (r) {
                x.soc = { soc: r.soc, hist: ['h1', 'h2', 'h3', 'h4', 'h5'].map((k) => r[k]), bands: BANDS.reduce((o, [k]) => Object.assign(o, { [k]: r[k] }), {}) };
                x.socT = Date.now();
                keep('soc12', r.soc);            // the 48 V page's 12 V line
                if (JSON.stringify(st.soc40) !== JSON.stringify(x.soc)) { st.soc40 = x.soc; save(); }
            }
        }
        // 56F0 only where 40AD doesn't answer
        if ((fails.soc40 || 0) >= 3 && go('soc12', SOC_MS)) keep('soc12', counted('soc12', await one('soc12')));
        if (go('soh12', SLOW_MS)) keep('soh12', counted('soh12', await one('soh12')));
        if (go('cap12', SLOW_MS)) {
            const r = counted('cap12', await group('cap12'));
            if (r && G.isNum(r.cap)) {
                x.cap = { cap: r.cap, capNew: r.capNew };
                if (JSON.stringify(st.cap12) !== JSON.stringify(x.cap)) { st.cap12 = x.cap; save(); }
            }
        }
    }
    /** The charge to show: { v, src: 'dme' (40AD / 56F0) | 'signal' (the car's) | 'saved' | null, age }. */
    function soc() {
        const now = Date.now(), f = (k, ms) => L.x12T[k] && now - L.x12T[k] < ms;
        if (x.soc && x.socT && now - x.socT < 5 * 60000 && G.isNum(x.soc.soc)) return { v: x.soc.soc, src: 'dme', age: now - x.socT };
        if (f('soc12', 5 * 60000)) return { v: L.x12.soc12, src: 'dme', age: now - L.x12T.soc12 };
        if (L.bat12T && now - L.bat12T < 120000) return { v: L.bat12, src: 'signal', age: now - L.bat12T };
        if (x.soc && G.isNum(x.soc.soc)) return { v: x.soc.soc, src: 'saved', age: null };
        return { v: null, src: null, age: null };
    }

    /* ---------- this drive: time charging, time and count of REGEN (while the page is up: read every FAST_MS) ---------- */
    setInterval(() => {
        if (!shown() || sh.usingDemo() || sh.kind() !== 'none') { trip.wasRegen = false; return; }
        const d = values();
        if (!G.isNum(d.v) || d.vAge > FRESH_MS) { trip.wasRegen = false; return; }
        const ch = charging(d);
        if (ch) trip.chargeS += 1;
        const rg = ch && d.regen;
        if (rg) { trip.regenS += 1; if (!trip.wasRegen) trip.regenN += 1; }
        trip.wasRegen = rg;
    }, 1000);
    const resetTrip = () => { Object.assign(trip, { regenS: 0, regenN: 0, chargeS: 0, wasRegen: false, minV: null, maxV: null }); log.info('12 V: this drive reset'); };

    /** What the pages show. */
    function values() {
        const now = Date.now();
        if (sh.usingDemo()) {
            const s = demo.sample();
            return Object.assign(s, { demo: true, i: null, iAge: null, socSrc: 'dme', socAge: 0, vAge: 0, paused: false,
                trip: { regenS: 95, regenN: 23, chargeS: 412, minV: 12.41, maxV: 14.62 } });
        }
        const s = soc(), fresh = (k) => L.x12T[k] && now - L.x12T[k] < FRESH_MS;
        const v = L.v12T && now - L.v12T < KEEP_V_MS ? L.v12 : null, engine = engineState();
        return {
            demo: false, v, vAge: L.v12T ? now - L.v12T : null, lastV: L.v12T ? L.v12 : null,
            i: fresh('i12') ? L.x12.i12 : null, iAge: L.x12T.i12 ? now - L.x12T.i12 : null, iOk: (fails.i12 || 0) < 3 && !!L.x12T.i12,
            soc: s.v, socSrc: s.src, socAge: s.age, socHist: x.soc ? x.soc.hist : [], bands: x.soc ? x.soc.bands : null,
            cap: x.cap ? x.cap.cap : null, capNew: x.cap ? x.cap.capNew : null,
            soh: L.x12T.soh12 ? L.x12.soh12 : null, t: L.x12T.t12 && now - L.x12T.t12 < 120000 ? L.x12.t12 : null,
            alt: L.x12T.alt12 && now - L.x12T.alt12 < 120000 ? L.x12.alt12 : null,
            engine, regen: engine !== false && G.isNum(L.speed) && decelT > 0 && now - decelT < REGEN_HOLD_MS,
            paused: !inUse(), trip,
            // values this engine unit never gave (3 tries, none answered: a G20 320i's has no 5854 / 4604) make room
            gone: { t: none('t12'), alt: none('alt12') }, vFrom: vFrom(),
        };
    }
    const none = (k) => (fails[k] || 0) >= 3 && !L.x12T[k];
    const UNITS = { 7: 'SME', 18: 'DME', 19: 'DME 2', 24: 'EGS' };
    /** Where the voltage comes from: 'DME · OBD 42', 'EGS · F442', ... */
    const vFrom = () => {
        const c = vs.pick !== null ? (cfg.v12 || [])[vs.pick] : null;
        return c ? (UNITS[c.ecu] || 'ECU ' + c.ecu) + '  ·  ' + (c.obd ? 'OBD ' + c.obd : c.did) : null;
    };
    /** The battery is being charged now: current in, or (no current reading) the charging voltage. */
    const charging = (d) => (G.isNum(d.i) ? d.i > 1 : G.isNum(d.v) && d.v >= CHARGE_V);

    /** What the battery is doing: { text, color, note }. */
    function state(t, d) {
        const v = d.v, i = d.i;
        if (!G.isNum(v) && d.paused) return { text: 'PAUSED', color: t.dim, note: 'parked: reads stopped so the car can sleep' };
        if (!G.isNum(v)) return { text: 'NO READING', color: t.dim, note: diag.available ? 'waiting for the engine unit' : 'diagnostic link down' };
        if (charging(d)) {
            if (d.regen) return { text: 'REGEN', color: t.cold || t.accent, note: 'slowing down: braking energy charges the battery' };
            if (G.isNum(d.soc) && d.socSrc === 'dme' && d.soc < LOW_SOC) return { text: 'CHARGING', color: GO, note: 'charge low: charged all the time until it recovers' };
            if (G.isNum(i)) return { text: 'CHARGING', color: GO, note: v >= 14.6 ? 'strong charge after a start or a deep drain' : 'the alternator charges the battery' };
            return { text: 'CHARGING', color: GO, note: 'voltage says: alternator charging' };
        }
        if (G.isNum(i)) {
            if (i < -1) {
                if (d.engine) return { text: 'SUPPLYING', color: t.warn, note: 'alternator resting, battery feeds the car (normal)' };
                return { text: 'DISCHARGING', color: t.warn, note: 'engine off: the battery feeds the car' };
            }
            if (v < 12.2) return { text: 'LOW', color: t.crit, note: 'resting, but low: charge or drive soon' };
            return { text: 'RESTING', color: t.text, note: 'hardly any current' };
        }
        if (d.engine && v >= 12.0) return { text: 'SUPPLYING', color: t.warn, note: 'alternator resting, battery feeds the car (normal)' };
        // engine off: while the page is up the car is awake and draws 10-30 A (head unit, control units, fan, lights),
        // so the voltage reads ~0.2-0.3 V below a rested battery's (12.6 V full, 12.3 V half)
        const awake = 'engine off, car awake: ';
        if (v >= 12.4) return { text: 'GOOD', color: GO, note: awake + 'well charged' };
        if (v >= 12.1) return { text: 'OK', color: t.text, note: awake + 'about half charged or more' };
        if (v >= 11.8) return { text: 'LOW', color: t.warn, note: awake + 'low - drive or charge soon' };
        return { text: 'VERY LOW', color: t.crit, note: awake + 'charge the battery' };
    }

    /* ---------- drawing ---------- */
    const F = () => settings.get('tempUnit') === 'f';
    const T = (c) => (G.isNum(c) ? (F() ? c * 9 / 5 + 32 : c) : null);
    const tU = () => (F() ? '°F' : '°C');
    const ago = (ms) => (ms == null ? 'not read yet' : ms < 60000 ? Math.max(0, Math.round(ms / 1000)) + ' s ago' : ms < 3600000 ? Math.round(ms / 60000) + ' min ago'
        : ms < 172800000 ? Math.round(ms / 3600000) + ' h ago' : Math.round(ms / 86400000) + ' days ago');
    const LANG = (() => { try { return getLanguage(); } catch (e) { return 'en'; } })();
    const times = (n) => (LANG === 'ko' ? n + '회' : LANG === 'zh-CN' ? n + '次' : LANG === 'ru' ? n + ' раз' : n + 'x');
    const mmss = (sec) => Math.floor(sec / 60) + ':' + String(Math.floor(sec % 60)).padStart(2, '0');
    // the panels' contents spread over the room below the page (G.panel reaches down): Y(y) for a 468 px panel's line
    const spread = (cv) => {
        const ex = Math.max(0, G.pageBottom(cv) - G.BOTTOM);
        return { ex, Y: (y) => y + Math.round(ex * (y - 44) / 468) };
    };
    const big = (cv, t, s, x0, y, size, color) => cv.text(s, x0, y, size, color, { font: 'num' });
    const kv = (cv, t, label, value, x0, y, w, color) => {
        cv.text(label, x0, y, 21, t.dim, { font: 'bold', spacing: 1.5 });
        cv.text(value, x0 + w, y, 28, color || (value === '--' ? t.dim : t.text), { font: 'bold', align: 'right' });
    };
    function batteryIcon(cv, t, x0, y, w, h, s) {
        const f = G.isNum(s) ? G.clamp(s / 100, 0, 1) : 0;
        const c = !G.isNum(s) ? t.tick : s < 40 ? t.crit : s < 65 ? t.warn : GO;
        cv.strokeRoundRect(x0, y, w, h, 14, 5, t.tick);
        cv.roundRect(x0 + w + 2, y + h * 0.3, 16, h * 0.4, 4, t.tick);
        const seg = (w - 24) / 10, ih = h - 24;
        for (let k = 0; k < 10; k++) cv.roundRect(x0 + 12 + k * seg, y + 12, seg - 6, ih, 5, f * 10 > k + 0.05 ? c : t.track);
        const k = Math.floor(f * 10), part = f * 10 - k;
        if (k < 10 && part > 0.05) cv.roundRect(x0 + 12 + k * seg, y + 12, (seg - 6) * part, ih, 5, withAlpha(c, 0.55));
    }

    function renderMain(cv, t, d) {
        const { Y } = spread(cv);
        /* ---- state of charge ---- */
        G.panel(cv, t, 24, 44, 500, 468, 'State of charge');
        batteryIcon(cv, t, 48, Y(108), 420, 120, d.soc);
        const has = G.isNum(d.soc);
        const sw = big(cv, t, has ? G.fmt(d.soc, 0) : '--', 48, Y(352), 110, has ? t.text : t.dim);
        cv.text('%', 60 + sw, Y(352), 44, t.dim, { font: 'bold' });
        const src = d.socSrc === 'dme' ? 'engine unit  ·  ' + ago(d.socAge) : d.socSrc === 'signal' ? 'the car\'s signal' : d.socSrc === 'saved' ? 'last reading' : 'not read yet';
        cv.text(src, 500, Y(300), 21, d.socSrc === 'dme' || d.socSrc === 'signal' ? t.dim : t.warn, { align: 'right' });
        // Ah left: the engine unit's charge is a share of the capacity registered in it
        if (has && G.isNum(d.cap)) cv.text('~' + G.fmt(d.cap * d.soc / 100, 0) + ' / ' + G.fmt(d.cap, 0) + ' Ah', 500, Y(348), 28, t.text, { font: 'bold', align: 'right' });
        cv.fillRect(48, Y(380), 452, 1, t.tick);
        // the engine unit keeps the charge below full on purpose (room for braking energy): 65-85 % is normal
        const lvl = !has ? ['-', t.dim] : d.soc >= 85 ? ['well charged', GO] : d.soc >= 65 ? ['normal', t.text]
            : d.soc >= 50 ? ['lowish - a longer drive helps', t.warn] : ['low - use a battery charger', t.crit];
        cv.text('STATUS', 48, Y(418), 21, t.dim, { font: 'bold', spacing: 1.5 });
        cv.text(lvl[0], 500, Y(418), 24, lvl[1], { font: 'bold', align: 'right' });
        const hs = (d.socHist || []).filter(G.isNum);
        cv.text('EARLIER', 48, Y(470), 21, t.dim, { font: 'bold', spacing: 1.5 });
        cv.text(hs.length ? hs.map((v) => Math.round(v)).join('  ') + ' %' : '-', 500, Y(470), 26, hs.length ? t.text : t.dim, { font: 'bold', align: 'right' });

        /* ---- voltage and what the battery is doing; current and power, or the voltage of the last minutes ---- */
        const s = state(t, d), trendMode = !G.isNum(d.i) && (d.demo || ((fails.i12 || 0) > 0 && diag.available));
        G.panel(cv, t, 548, 44, 516, 468, trendMode ? 'Voltage' : 'Voltage & current');
        // a reading older than FRESH_MS (a few missed reads): kept, dimmed
        const old = !d.demo && G.isNum(d.vAge) && d.vAge > FRESH_MS;
        const v = d.v, vcol = !G.isNum(v) || old ? t.dim : v < 11.8 ? t.crit : v < 12.2 || v > 15.0 ? t.warn : t.text;
        // parked, reads stopped: the last voltage read, dimmed
        const vShow = G.isNum(v) ? v.toFixed(2) : d.paused && G.isNum(d.lastV) ? d.lastV.toFixed(2) : '--.--';
        const vw = big(cv, t, vShow, 572, Y(210), 110, vcol);
        cv.text('V', 584 + vw, Y(210), 44, t.dim, { font: 'bold' });
        // parked: a Read now button in place of the state
        if (!(d.paused && !G.isNum(v) && G.button(cv, t, 824, 64, 216, 40, 'Read now', () => { touched(); return sh.poll(true).then(sh.render); }, { key: 'read12', primary: true }))) {
            G.pill(cv, t, 824, 64, 216, 40, s.text, { color: s.color, size: 20 });
        }
        // the voltage on a scale 11-15.5 V: low / resting / charging under the track
        const sx = 572, sy = Y(244), sw2 = 468, sh2 = 24, vmin = 11, vmax = 15.5;
        const SX = (val) => sx + G.clamp((val - vmin) / (vmax - vmin), 0, 1) * sw2;
        cv.roundRect(sx, sy, sw2, sh2, 6, withAlpha(t.track, 0.7));
        const sv = G.smooth('v12bar', v);
        if (G.isNum(sv)) {
            const fc = sv >= CHARGE_V ? GO : sv < 12.2 ? t.crit : sv < 12.4 ? t.warn : t.cold || t.accent;
            cv.roundRect(sx, sy, Math.max(12, SX(sv) - sx), sh2, 6, withAlpha(fc, 0.85));
            cv.fillRect(SX(sv) - 2, sy - 4, 4, sh2 + 8, '#ffffff');
        }
        [[11, 12.2, t.crit], [12.2, 12.4, t.warn], [12.4, CHARGE_V, t.dim], [CHARGE_V, 15.5, GO]].forEach(([a, b, c]) => cv.fillRect(SX(a), sy + sh2 + 5, SX(b) - SX(a) - 2, 5, c));
        [11, 12, 13, 14, 15].forEach((m) => cv.text(String(m), SX(m), sy + sh2 + 34, 18, t.dim, { align: 'center', font: 'bold' }));
        cv.text('low', SX(11.6), sy + sh2 + 56, 16, t.dim, { align: 'center' });
        cv.text('resting', SX(12.8), sy + sh2 + 56, 16, t.dim, { align: 'center' });
        cv.text('charging', SX(14.35), sy + sh2 + 56, 16, t.dim, { align: 'center' });
        cv.fillRect(572, Y(330), 468, 1, t.tick);
        const i = d.i;
        if (G.isNum(i)) {
            cv.text('CURRENT', 572, Y(372), 21, t.dim, { font: 'bold', spacing: 1.5 });
            const txt = (i > 0.05 ? '+' : '') + G.fmt(i, Math.abs(i) < 10 ? 1 : 0) + ' A';
            cv.text(txt, 1040, Y(380), 44, i > 1 ? GO : i < -1 ? t.warn : t.text, { font: 'bold', align: 'right' });
            cv.text(i > 1 ? 'into the battery' : i < -1 ? 'out of the battery' : 'little current', 572, Y(404), 20, t.dim);
            kv(cv, t, 'POWER', G.isNum(v) ? G.fmt(Math.abs(v * i), 0) + ' W' : '--', 572, Y(440), 468);
        } else if (trendMode) {
            // no current from this engine unit: the voltage of the last minutes in its place - the jumps to ~14.7 V are
            // the lift-offs and braking (REGEN), the rest the battery feeding the car
            cv.text('VOLTAGE, LAST 2 MIN', 572, Y(366), 21, t.dim, { font: 'bold', spacing: 1.5 });
            const now = Date.now(), pts = d.demo ? Array.from({ length: 61 }, (z, k) => [-k / 30, demo.sample(now - k * 2000).v]).reverse()
                : trend.map((p) => [(p.t - now) / 60000, p.v]);
            const lo = pts.some((p) => p[1] < 12) ? 11 : 12;      // 12-15 V, or 11-15 V when it went below 12 V
            G.chart(cv, t, 572, Y(376), 468, Y(456) - Y(376), {
                xMin: -2, xMax: 0, xStep: 0.5, xFmt: (z) => (z % 1 ? '' : String(z)), yMin: lo, yMax: 15, yStep: (15 - lo) / 2, yFmt: (y) => y.toFixed(1), xUnit: 'min',
                padBottom: 22, series: [{ pts, color: t.accent, fill: 0.12 }], marks: [{ y: CHARGE_V, color: GO }], empty: 'collecting...',
            });
        } else {
            cv.text('CURRENT', 572, Y(372), 21, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text('--', 1040, Y(380), 30, t.dim, { font: 'bold', align: 'right' });
        }
        const note = s.note.length > 52 ? s.note.slice(0, 51) + '…' : s.note;
        cv.text(note, 572, Y(490), 20, s.color === t.dim ? t.dim : t.text);

        /* ---- the battery's facts, this drive ---- */
        G.panel(cv, t, 1088, 44, 488, 468, '12 V details');
        const x0 = 1112, w = 440;
        const hc = !G.isNum(d.soh) ? null : d.soh < 60 ? t.crit : d.soh < 80 ? t.warn : null;
        kv(cv, t, 'HEALTH (SOH)', G.isNum(d.soh) ? G.fmt(d.soh, 0) + ' %' : '--', x0, Y(130), w, hc);
        // the capacity registered in the engine unit (the original battery's beside it when it differs)
        kv(cv, t, 'CAPACITY', !G.isNum(d.cap) ? '--' : G.fmt(d.cap, 0) + ' Ah' + (G.isNum(d.capNew) && Math.abs(d.cap - d.capNew) >= 1 ? '  (orig. ' + G.fmt(d.capNew, 0) + ')' : ''), x0, Y(168), w);
        // three rows: the battery's temperature and the alternator's current where the engine unit gives them, else
        // (dropped once it did not answer them) the engine and where the voltage comes from in their place
        const gone = d.gone || {}, rows = [];
        if (!gone.t) rows.push(['TEMPERATURE', G.isNum(d.t) ? G.fmt(T(d.t), 0) + ' ' + tU() : '--']);
        if (!gone.alt) rows.push(['ALTERNATOR', G.isNum(d.alt) ? G.fmt(d.alt, 0) + ' A' : '--']);
        rows.push(['OUTSIDE', G.isNum(sh.ambient()) ? G.fmt(T(sh.ambient()), 1) + ' ' + tU() : '--']);
        if (rows.length < 3) rows.push(['ENGINE', d.engine === true ? 'running' : d.engine === false ? 'off' : '--', d.engine === true ? GO : null]);
        if (rows.length < 3) rows.push(['VOLTAGE FROM', d.vFrom || '--']);
        rows.forEach((r, i) => kv(cv, t, r[0], r[1], x0, Y(206 + 38 * i), w, r[2]));
        cv.fillRect(x0, Y(300), w, 1, t.tick);
        cv.text('THIS DRIVE', x0, Y(336), 21, t.dim, { font: 'bold', spacing: 1.5 });
        G.button(cv, t, x0 + w - 110, Y(310), 110, 36, 'Reset', () => { touched(); resetTrip(); return sh.render(); }, { key: 'trip12', confirm: true });
        const tr = d.trip;
        kv(cv, t, 'REGEN', mmss(tr.regenS) + '  ·  ' + times(tr.regenN), x0, Y(374), w, t.cold || t.accent);
        kv(cv, t, 'CHARGING', mmss(tr.chargeS), x0, Y(410), w, GO);
        kv(cv, t, 'VOLTAGE RANGE', G.isNum(tr.minV) ? G.fmt(tr.minV, 2) + ' - ' + G.fmt(tr.maxV, 2) + ' V' : '--', x0, Y(446), w);
        cv.text('Hybrid or electric car? Settings > Drive system', x0, Y(492), 18, t.dim);
    }

    function renderHistory(cv, t, d) {
        const { ex, Y } = spread(cv), half = Math.round(ex / 2);
        G.panel(cv, t, 24, 44, 1040, 468, 'Last hour');
        const now = Date.now();
        let pts = hist;
        if (d.demo) {
            // a made-up hour: charging after the start, then cruising with lift-offs; the charge climbing from 66 %
            pts = [];
            for (let k = 0; k <= 720; k++) {
                const m = k / 12;
                pts.push({ t: now - HIST_MS + m * 60000, v: m < 12 ? 14.6 - 0.4 * m / 12 : k % 19 === 0 ? 14.7 : 12.78 + 0.04 * Math.sin(k / 3), i: null, soc: Math.round(66 + 12 * (1 - Math.exp(-m / 25))) });
            }
        }
        const X = (p) => (p.t - now) / 60000;
        const vs2 = pts.map((p) => p.v).filter(G.isNum), is = pts.map((p) => p.i).filter(G.isNum);
        const vMin = vs2.length ? Math.min(11.5, Math.floor(Math.min.apply(null, vs2) * 2) / 2) : 11.5;
        const vMax = vs2.length ? Math.max(15, Math.ceil(Math.max.apply(null, vs2) * 2) / 2) : 15;
        cv.text('VOLTAGE  (V)', 1040, 86, 20, t.dim, { font: 'bold', spacing: 1.5, align: 'right' });
        G.chart(cv, t, 48, 112, 992, 172 + half, {
            xMin: -60, xMax: 0, xStep: 10, yMin: vMin, yMax: vMax, yStep: 0.5, yFmt: (y) => y.toFixed(1), padBottom: 8,
            xFmt: () => '', series: [{ pts: pts.map((p) => [X(p), p.v]), color: t.accent, fill: 0.12 }],
            marks: [{ y: 12.4, color: 'warn', label: '12.4 V' }], empty: 'no voltage readings yet',
        });
        if (is.length && !d.demo) {
            const iMax = Math.max(10, Math.ceil(Math.max.apply(null, is.map(Math.abs)) / 10) * 10);
            cv.text('CURRENT  (A, + = INTO THE BATTERY)', 1040, 312 + half, 20, t.dim, { font: 'bold', spacing: 1.5, align: 'right' });
            G.chart(cv, t, 48, 322 + half, 992, 182 + ex - half, {
                xMin: -60, xMax: 0, xStep: 10, yMin: -iMax, yMax: iMax, yStep: iMax / 2, xUnit: 'min',
                series: [{ pts: pts.map((p) => [X(p), p.i]), color: GO, fill: 0.1 }], marks: [{ y: 0, color: 'tick' }], empty: 'collecting...',
            });
        } else {
            // no current: the engine unit's charge over the hour in its place
            const ss = pts.map((p) => p.soc).filter(G.isNum);
            const sLo = ss.length ? Math.max(0, Math.min(Math.floor((Math.min.apply(null, ss) - 5) / 10) * 10, 60)) : 0;
            const sHi = ss.length ? Math.min(100, Math.max(Math.ceil((Math.max.apply(null, ss) + 5) / 10) * 10, sLo + 40)) : 100;
            cv.text('STATE OF CHARGE  (%, FROM THE DME)', 1040, 312 + half, 20, t.dim, { font: 'bold', spacing: 1.5, align: 'right' });
            G.chart(cv, t, 48, 322 + half, 992, 182 + ex - half, {
                xMin: -60, xMax: 0, xStep: 10, yMin: sLo, yMax: sHi, yStep: (sHi - sLo) / 4, yFmt: (y) => String(Math.round(y)), xUnit: 'min',
                series: [{ pts: pts.filter((p) => G.isNum(p.soc)).map((p) => [X(p), p.soc]), color: GO, fill: 0.1 }],
                marks: [{ y: LOW_SOC, color: 'warn', label: LOW_SOC + ' %' }], empty: 'collecting...',
            });
        }

        /* ---- the engine unit's own records ---- */
        G.panel(cv, t, 1088, 44, 488, 468, 'Recorded by the car');
        const x0 = 1112, w = 440;
        cv.text('STATE OF CHARGE, LAST 5', x0, Y(124), 20, t.dim, { font: 'bold', spacing: 1.5 });
        const hs = d.socHist || [], bw = w / 6;
        [hs[4], hs[3], hs[2], hs[1], hs[0], d.socSrc === 'dme' ? d.soc : null].forEach((s, k) => {
            const bx = x0 + k * bw + 6, top = Y(140), hh = 108, bh = G.isNum(s) ? Math.max(4, hh * s / 100) : 0;
            cv.roundRect(bx, top, bw - 12, hh, 4, withAlpha(t.track, 0.6));
            if (bh) cv.roundRect(bx, top + hh - bh, bw - 12, bh, 4, k === 5 ? GO : withAlpha(GO, 0.55));
            cv.text(G.isNum(s) ? String(Math.round(s)) : '-', bx + (bw - 12) / 2, top + hh + 26, 20, G.isNum(s) ? t.text : t.dim, { font: 'bold', align: 'center' });
        });
        cv.text('older', x0 + 6, Y(300), 17, t.dim);
        cv.text('now', x0 + w - 6, Y(300), 17, t.dim, { align: 'right' });
        cv.fillRect(x0, Y(316), w, 1, t.tick);
        cv.text('TIME SPENT PER CHARGE BAND', x0, Y(352), 20, t.dim, { font: 'bold', spacing: 1.5 });
        const b = d.bands, tot = b ? BANDS.reduce((a, [k]) => a + (G.isNum(b[k]) ? b[k] : 0), 0) : 0;
        if (tot > 0) {
            const cols = [t.crit, t.crit, t.warn, t.text, GO, GO];
            let bx = x0;
            BANDS.forEach(([k], j) => {
                const ww = (G.isNum(b[k]) ? b[k] : 0) / tot * w;
                if (ww >= 1) cv.fillRect(bx, Y(370), ww - (ww > 3 ? 2 : 0), 34, withAlpha(cols[j], j === 3 ? 0.5 : 0.85));
                bx += ww;
            });
            BANDS.map(([k, name], j) => [name, (G.isNum(b[k]) ? b[k] : 0) / tot, j]).filter(([, f]) => f >= 0.005).slice(0, 6).forEach(([name, f, j0], j) => {
                const cx = x0 + (j % 3) * (w / 3), cy = Y(438) + Math.floor(j / 3) * 30;
                cv.fillRect(cx, cy - 12, 10, 10, withAlpha(cols[j0], j0 === 3 ? 0.5 : 0.85));
                cv.text(name + '%', cx + 16, cy, 18, t.dim);
                cv.text(G.fmt(f * 100, 0) + '%', cx + w / 3 - 14, cy, 20, t.text, { font: 'bold', align: 'right' });
            });
        } else cv.text('not available', x0, Y(400), 22, t.dim);
    }

    const fastNow = () => sh.kind() === 'none' && shown() && inUse();
    return {
        PAGES: ['hist12'],
        NAMES: { hist12: 'History' },
        readVolt, readValues, allowed, touched, onSpeed,
        /** No hybrid system and the 12 V pages up and in use: read every FAST_MS. */
        fast: fastNow, FAST_MS,
        /** Draws 'main' (the 12 V battery) or 'hist12'. */
        draw(name, cv, t) {
            const opened = Date.now() - lastDrawT > 5000;
            lastDrawT = Date.now();
            if (opened) touched();
            const d = values();
            (name === 'hist12' ? renderHistory : renderMain)(cv, t, d);
            return d;
        },
    };
};
