'use strict';
/**
 * Part of Redline's experimental features; README.md in this folder has the whole picture.
 *
 * The electrical readouts on the HUD, read from the car itself, the way eDrive reads them
 * (apps/edrive/app.json config.battery, main.js, battery12.js, live.js):
 *
 *   every car
 *     12 V charge    CDS.statusBattery2.conditionBatteryChargingCondition (%), sent by the car
 *     12 V voltage   UDS 22 F442 (OBD "control module voltage") from the engine unit (0x12), OBD 01 42,
 *                    a second engine unit (0x13), the gearbox unit (0x18), the battery sensor (402B, 5853),
 *                    last the body controller (BDC 0x40) and the electric drive unit (EME 0x1A);
 *                    the one that answered keeps being asked, as battery12.js does
 *   plug-in hybrids only
 *     HV charge      UDS 22 DDBC from the battery unit (SME, 0x07), 0.1 % (from 0.5 %: a fully electric car's
 *                    battery unit, e.g. the iX3's, answers zero bytes there, which is no charge and no hybrid)
 *     HV power       pack voltage (DDB4 / DD68 / DD66 / DDEF / E54D) x current (DD69) from the SME, in kW:
 *                    + the battery drives, - it is charged (regen)
 *     HV temperature Efficiencytainment2.statusBatteryTemperature (raw - 50 °C, 255 = none)
 *     pack voltage   LSCDataSink.statusHighVoltageStorage (V, or 0.1 V above 1500)
 *   (not shown: KombiIF's power distribution, whose scale nobody knows yet; eDrive doesn't show it either.
 *   powerlog.js logs it raw, with BMW's own power meter, so a drive can settle it)
 *
 * Petrol and diesel cars: hybrid() stays false, so nothing hybrid shows anywhere (HUD, HUD looks page,
 * Settings). It turns true, and is kept (setting hudHybridSeen), once the car shows a high-voltage battery:
 * a pack voltage (150-500 V) in its signals that moves (two values 10 s apart, no "none" pattern), or the SME answering DDBC. A battery temperature alone is not
 * enough (a 48 V mild hybrid, or a petrol car, may send one for another battery). That one read is asked
 * while the HUD shows, once the link is available, until a reply settles it (a charge: hybrid; a refusal: not);
 * a try with no reply is tried again a minute later, 3 tries an app run. What found it is logged with its raw value.
 * The signal values (12 V charge, HV temperature, the signal's pack voltage) come on change only: kept 30 min.
 *
 * The UDS reads are read-only (UDS 22 / OBD 01) on the gearbox reader's link (one link to the car), only while
 * the HUD shows a readout that needs them, and only once that link is up (a read before then fails at once and
 * would count as the unit not answering). Each waits at most ~1 s for an answer, so a unit that doesn't answer
 * doesn't hold up knock and gearbox reads on the same link; one that doesn't answer three times is asked once
 * a minute. The link stops asking a unit after 5 misses in a row until it is woken: each start and each of those
 * once-a-minute tries wakes the units asked, so a unit that was asleep a while (engine off) is asked again
 * (and knock, which reads the engine unit too, isn't left without it). The charge and the power each keep
 * their own count, and each is read only while its readout shows. Never throws; value() is { soc12, v12, hvSoc, hvKw, hvTemp, hvVolt } (each a number or null).
 */
const { DidReader } = require('./kit/dids');

// the pack voltage signal: "no value" patterns never count; it must move over this long to count as a hybrid
const VOLT_SENTINELS = [255, 2047, 4094, 4095, 65534, 65535], VOLT_PROOF_MS = 10000;
const VOLT = { bytes: 2, at: 0, factor: 0.001, offset: 0, min: 5, max: 18 };
// the same candidates, in the same order, as eDrive's config.battery.v12 (test_redline_hud.js checks it)
const V12 = [
    Object.assign({ ecu: 0x12, did: 'F442' }, VOLT),
    Object.assign({ ecu: 0x07, did: 'F442' }, VOLT),
    Object.assign({ ecu: 0x12, obd: '42' }, VOLT),
    Object.assign({ ecu: 0x13, did: 'F442' }, VOLT),
    Object.assign({ ecu: 0x13, obd: '42' }, VOLT),
    Object.assign({ ecu: 0x18, did: 'F442' }, VOLT),
    Object.assign({ ecu: 0x18, obd: '42' }, VOLT),
    { ecu: 0x12, did: '402B', bytes: 2, at: 2, factor: 0.00025, offset: 6, min: 5, max: 18 },
    Object.assign({ ecu: 0x12, did: '5853' }, VOLT),
    Object.assign({ ecu: 0x40, did: 'F442' }, VOLT),
    Object.assign({ ecu: 0x1A, did: 'F442' }, VOLT),
];
const SME = 0x07;
const V12_ECUS = V12.map((c) => c.ecu).filter((e, i, a) => a.indexOf(e) === i);
// every read has its own short wait: the link is shared with knock (twice a second) and the gearbox, and the
// default 4 s per unanswered identifier could hold them up for ~12 s a turn on a hybrid whose SME differs
const HV_SOC = [{ ecu: SME, did: 'DDBC', bytes: 2, at: 0, factor: 0.1, offset: 0, min: 0.5, max: 100, timeoutMs: 1000 }];
const HV_V = [
    { ecu: SME, did: 'DDB4', bytes: 2, factor: 0.01, min: 150, max: 500, timeoutMs: 600 },
    { ecu: SME, did: 'DD68', bytes: 2, factor: 0.01, min: 150, max: 500, timeoutMs: 800 },
    { ecu: SME, did: 'DD66', bytes: 2, factor: 0.01, min: 150, max: 500, timeoutMs: 800 },
    { ecu: SME, did: 'DDEF', bytes: 2, factor: 1, min: 150, max: 500, timeoutMs: 800 },
    { ecu: SME, did: 'E54D', bytes: 2, factor: 0.01, min: 150, max: 500, timeoutMs: 600 },
];
const HV_A = [{ ecu: SME, did: 'DD69', bytes: 4, factor: 0.01, signed: true, min: -800, max: 800, timeoutMs: 600 }];
const POWER_SIGN = -1;                // eDrive's powerSign: kW = V x A / 1000 x -1 (+ = the battery gives power)
const VOLT_TIMEOUT_MS = 1500, PROBE_TIMEOUT_MS = 1500;
const POLL_MS = 500;                  // HV power; the charge and the 12 V every SLOW_MS
const SLOW_MS = 5000, V12_MS = 2000, FAIL_RETRY_MS = 60000;
const STALE_MS = 3000, SLOW_STALE_MS = 20000, RANK = { ok: 0, new: 1, nrc: 2, bad: 2, none: 3 };
// the car sends these signals on change only: a steady 12 V charge or pack temperature is sent once and then
// not again for many minutes, so it is kept 30 min (or until the signal says none) (2026-11-10 review)
const SIGNAL_KEEP_MS = 30 * 60000;
// the look for a hybrid battery: a try that got no reply (link busy, unit not awake yet) is tried again a
// minute later, at most this many tries per app run; a reply (a charge, or a refusal) settles it (2026-11-10 review)
const PROBE_TRIES = 3;
// the 12 V search asks at most this many candidates a turn, so the HV power (first each turn) stays fresh
// while a search runs (9 candidates x 1.5 s held it up ~13 s) (2026-11-10 review)
// the power read, once it has worked this drive (2026-11-11: an X5 45e's meter vanished for up to a minute at a time):
// a miss of the voltage that answered is a hiccup, so it alone is asked again until KW_SEARCH_AFTER misses in a row (a
// search on one miss asked the other three, each a miss of its own, and five in a row silenced the battery unit on the
// link); and after misses it is asked again every KW_RETRY_MS (the unit woken), not once a minute
const KW_SEARCH_AFTER = 4, KW_RETRY_MS = 2000;
const SEARCH_PER_TURN = 1;              // one: two that both time out (2 x 1.5 s) outlast STALE_MS

const isNum = (v) => typeof v === 'number' && isFinite(v);
/** every entry holding key, however the list arrives (plain, wrapped in the field's name, single) - as eDrive */
function entries(v, key, out) {
    out = out || [];
    if (v && typeof v === 'object') {
        if (key in v) out.push(v);
        else Object.keys(v).forEach((k) => entries(v[k], key, out));
    }
    return out;
}
const one = (v, key) => { const e = entries(v, key)[0]; return e ? e[key] : undefined; };

/** Raw decoders, exported for the tests: each returns a value or null. */
const decode = {
    soc12: (v) => { const c = v && v.conditionBatteryChargingCondition; return isNum(c) && c >= 0 && c <= 100 ? c : null; },
    hvTemp: (v) => {
        const raw = one(v, 'actualValueTemperatureHighVoltageStorage');
        if (!isNum(raw) || raw === 255) return null;
        const t = raw - 50;
        return t > -30 && t < 70 ? t : null;
    },
    hvVolt: (v) => {
        const x = one(v, 'actualValueVoltageHighVoltageStorage');
        if (!isNum(x)) return null;
        const volts = x > 1500 ? x / 10 : x;           // 0.1 V on the X5 45e
        return volts > 150 && volts < 500 ? volts : null;
    },
    /** the raw field, for the log line that says what found the battery */
    rawVolt: (v) => one(v, 'actualValueVoltageHighVoltageStorage'),
    hvKw: (volts, amps) => (isNum(volts) && isNum(amps) ? volts * amps / 1000 * POWER_SIGN : null),
};

class Electrical {
    /**
     * linkOf: () => a ReadOnlyDiag (the gearbox reader's, shared); settings (hudHybridSeen is kept there).
     */
    constructor(ctx, linkOf) {
        this.ctx = ctx; this.log = ctx.log; this.linkOf = linkOf; this.settings = ctx.settings;
        this.rd = null; this.timer = null; this.busy = false; this.want = {};
        this.s = {};                  // name -> { v, t } from the signals and the reads
        this.fails = { soc: 0, kw: 0, v12: 0 }; this.tried = { soc: 0, kw: 0, v12: 0 }; this.slowT = 0; this.v12T = 0;
        this.kwWorked = false; this.kwMiss = 0;   // the power read has answered this run; its misses in a row since
        this.vs = { pick: null, miss: 0, res: {}, order: null, at: 0 };
        this.probed = false;          // true once the look for a hybrid battery is settled (or out of tries)
        this.probeN = 0; this.probeT = 0;
        this.gen = 0;                 // stop() counts it up: a turn started before stops asking
        this.voltSeen = null;         // the pack voltage signal's first plausible value this run: { raw, t }
    }

    /** Is the look for a hybrid battery due now? (not known yet, tries left, a minute after a try with no reply) */
    _probeDue(now) { return !this.hybrid() && !this.probed && (this.probeN === 0 || now - this.probeT >= FAIL_RETRY_MS); }

    /** true once this car has shown a high-voltage battery (kept across restarts). */
    hybrid() { return !!(this.settings && this.settings.get('hudHybridSeen')); }

    _seen(why) {
        if (this.hybrid() || !this.settings) return;
        this.settings.set('hudHybridSeen', true);
        this.log.info('electrical: high-voltage battery found (' + why + '): hybrid readouts offered');
    }

    /**
     * The pack voltage signal marks a hybrid only once it has moved: a plausible value, then another one, at least
     * VOLT_PROOF_MS after the first this run, neither a "no value" pattern (4095 = 409.5 V, 2047, 255). A stuck sentinel or a
     * single odd message (a 48 V system in 0.1 V) never sets hudHybridSeen for good (2026-11-10 review).
     */
    _voltProof(raw) {
        if (this.hybrid() || !isNum(raw) || VOLT_SENTINELS.indexOf(raw) >= 0) return;
        const now = Date.now(), f = this.voltSeen;
        if (!f) { this.voltSeen = { raw: raw, t: now, moved: false }; return; }
        if (raw !== f.raw) f.moved = true;
        if (f.moved && now - f.t >= VOLT_PROOF_MS) this._seen('pack voltage signal, raw ' + f.raw + ', now ' + raw);
    }

    _put(name, v) { if (v !== null && v !== undefined) this.s[name] = { v: v, t: Date.now() }; }

    /**
     * A value from a signal: kept (SIGNAL_KEEP_MS); the field there but invalid (255 = none, 0 V) clears it, as
     * the car then says it has none. Car's watches tell the handlers nothing of availability (2026-11-10 review).
     */
    _sig(name, v, present) {
        if (v !== null && v !== undefined) this._put(name, v);
        else if (present) delete this.s[name];
    }

    /** Signal handlers for Car's extra watches (each field on its interface's one watch). */
    handlers() {
        const guard = (fn) => (v) => { try { fn(v); } catch (e) { /* never throw from a signal */ } };
        const has = (v, key) => entries(v, key).length > 0;
        return {
            'de.bmw.infotainment.vehicle.CDS': {
                statusBattery2: guard((v) => this._sig('soc12', decode.soc12(v), has(v, 'conditionBatteryChargingCondition'))),
            },
            // kept, but shown only once the car is known to be a hybrid (value()): never proof of one by itself
            'de.bmw.infotainment.drivingexcitement.Efficiencytainment2': {
                statusBatteryTemperature: guard((v) => this._sig('hvTemp', decode.hvTemp(v), has(v, 'actualValueTemperatureHighVoltageStorage'))),
            },
            // the signal's pack voltage is kept apart from the SME read's (hvVoltUds): each its own staleness
            'de.bmw.infotainment.lsc.LSCDataSink': {
                statusHighVoltageStorage: guard((v) => {
                    const x = decode.hvVolt(v);
                    this._sig('hvVoltSig', x, has(v, 'actualValueVoltageHighVoltageStorage'));
                    if (x !== null) this._voltProof(decode.rawVolt(v));
                }),
            },
        };
    }

    /**
     * Read what the HUD shows: want = { hvSoc (HV charge), hvKw (HV power), v12 (the 12 V voltage) } (hv: both,
     * for callers that don't tell them apart). Not yet known to be a
     * hybrid: the SME is asked once (DDBC), so the hybrid readouts can be offered; never on a known petrol car again.
     */
    start(want) {
        const w = want || {};
        this.want = { v12: !!w.v12, hvSoc: w.hvSoc !== undefined ? !!w.hvSoc : !!w.hv, hvKw: w.hvKw !== undefined ? !!w.hvKw : !!w.hv };
        this.want.hv = this.want.hvSoc || this.want.hvKw;
        const any = this.want.v12 || (this.want.hv && this.hybrid()) || this._probeDue(Date.now());
        if (!any) return this.stop();
        if (this.timer) return;
        try {
            if (!this.rd) this.rd = new DidReader(this.linkOf(), { ecu: SME });
            // a new start (the HUD back on, the next drive): the units it asks are asked again, even if the link
            // gave up on them while they slept
            this._wake(V12_ECUS.concat([SME]));
            this.timer = setInterval(() => this._poll(), POLL_MS);
            this._poll();
        } catch (e) { this.log.warn('electrical: ' + (e && e.message || e)); }
    }

    // a turn still running (a 12 V search) stops asking too: the link is shared, and the HUD is off (2026-11-10 review)
    stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.gen++; }

    /** Let the link ask these units again (it stops after 5 misses in a row, until woken). */
    _wake(ecus) {
        const link = this.rd && this.rd.diag;
        if (link && typeof link.wake === 'function') ecus.forEach((e) => { try { link.wake(e); } catch (err) { /* never */ } });
    }

    _poll() {
        if (this.busy || !this.rd) return;
        this.busy = true;
        const gen = this.gen;
        Promise.resolve().then(() => this._turn(gen)).catch((e) => this.log.warn('electrical: ' + (e && e.message || e)))
            .then(() => { this.busy = false; });
    }

    /**
     * One turn: the probe (until settled), HV power (each turn), HV charge (every SLOW_MS), 12 V (every V12_MS,
     * each turn while a search runs). gen: the start it belongs to; after a stop() it asks nothing more.
     */
    async _turn(gen) {
        const now = Date.now(), g = gen === undefined ? this.gen : gen, live = () => this.gen === g;
        if (!live()) return;
        // the link is made on the HUD's first tick and comes up a moment later: until then every read fails at
        // once, which would use up a look for a hybrid battery and start the minute-long back-off. ready is true
        // as soon as the proxy is there, before the transport is available, so both (2026-11-10 review)
        const link = this.rd.diag;
        if (link && (link.ready === false || link.available === false)) return;
        if (this._probeDue(now)) {
            this.probeN++; this.probeT = now;
            this._wake([SME]);
            const v = await this.rd.read(Object.assign({}, HV_SOC[0], { timeoutMs: PROBE_TIMEOUT_MS }));
            const raw = this.rd.raws[this.rd.key(HV_SOC[0])] || {};
            // settled only by a reply (bytes): a charge in range is a hybrid, a refusal or odd reply is not.
            // No reply or a transport error (busy, not up, unit asleep) is tried again a minute later
            if (v !== null) { this.probed = true; this._put('hvSoc', v); this._seen('battery unit DDBC, ' + (raw.bytes || '')); }
            // a refusal that means "not now" (21 busy, 22 conditions not correct, 78 pending) is no answer either
            else if ((raw.bytes && !/^NRC (21|22|78)\b/.test(raw.why || '')) || this.probeN >= PROBE_TRIES) {
                this.probed = true;
                this.log.info('electrical: no high-voltage battery unit (' + (raw.why || '?') + (raw.bytes ? '' : ', ' + this.probeN + ' tries') + ')');
            }
            if (live() && !this.want.v12 && !(this.want.hv && this.hybrid())) this.stop();
            return;
        }
        // the power and the charge each counted on their own: a unit that gives the charge but not the power
        // keeps its charge read every SLOW_MS
        const w = this.want, wantKw = w.hvKw !== undefined ? w.hvKw : w.hv, wantSoc = w.hvSoc !== undefined ? w.hvSoc : w.hv;
        if (wantKw && this.hybrid() && this._may('kw', now, [SME], this.kwWorked ? KW_RETRY_MS : FAIL_RETRY_MS)) {
            // the voltage that answered, alone, through a few misses; the others only after KW_SEARCH_AFTER in a row
            const pick = this.rd.pick.hvV;
            const volts = this.kwWorked && pick !== undefined && this.kwMiss < KW_SEARCH_AFTER ? await this.rd.read(HV_V[pick]) : await this.rd.value('hvV', HV_V);
            const amps = volts === null || !live() ? null : await this.rd.value('hvA', HV_A);
            const kw = decode.hvKw(volts, amps);
            if (kw !== null) { this._put('hvKw', kw); this._put('hvVoltUds', volts); this.kwWorked = true; this.kwMiss = 0; }
            else this.kwMiss++;
            if (live()) this._result('kw', kw !== null, this.kwWorked ? 'the battery unit (SME 0x07) stopped giving the power; asked again every ' + KW_RETRY_MS / 1000 + ' s'
                : 'the battery unit (SME 0x07) gives no power');
        }
        if (!live()) return;
        if (wantSoc && this.hybrid() && now - this.slowT >= SLOW_MS && this._may('soc', now, [SME])) {
            this.slowT = now;
            const soc = await this.rd.value('hvSoc', HV_SOC);
            this._put('hvSoc', soc);
            if (live()) this._result('soc', soc !== null, 'the battery unit (SME 0x07) gives no charge');
        }
        if (!live()) return;
        if (this.want.v12 && (this.vs.order !== null || now - this.v12T >= V12_MS) && this._may('v12', now, V12_ECUS)) {
            this.v12T = now;
            const v = await this._volt(live);
            this._put('v12', v);
            // a search part-way through (or cut short by a stop) is no failure yet: only one that ended without an answer
            if (live() && (v !== null || this.vs.order === null)) this._result('v12', v !== null, 'no unit gives the 12 V voltage (F442 / OBD 42)');
        }
    }

    /** May path k ask now: yes until it failed 3 times, then every retryMs (a minute by default; waking its units for that try). */
    _may(k, now, ecus, retryMs) {
        if (this.fails[k] < 3) return true;
        if (now - this.tried[k] < (retryMs || FAIL_RETRY_MS)) return false;
        this._wake(ecus || []);
        return true;
    }
    _result(k, ok, why) {
        this.tried[k] = Date.now();
        if (ok) { this.fails[k] = 0; return; }
        if (++this.fails[k] === 3) this.log.info('electrical: ' + why + (/every \d/.test(why) ? '' : '; asked once a minute'));
    }

    /**
     * The 12 V voltage: the candidate that answered keeps being asked (two misses before a search), as battery12.js.
     * A search asks SEARCH_PER_TURN candidates a turn and goes on from there the next turn (vs.order / vs.at);
     * live() false (stopped): it asks no more.
     */
    async _volt(live) {
        const list = V12.map((c) => Object.assign({ timeoutMs: VOLT_TIMEOUT_MS }, c)), vs = this.vs, rd = this.rd;
        const alive = live || (() => true);
        const ask = async (i) => {
            const v = await rd.read(list[i]);
            const why = (rd.raws[rd.key(list[i])] || {}).why || '';
            vs.res[i] = v !== null ? 'ok' : /^NRC/.test(why) ? 'nrc' : /no reply/.test(why) ? 'none' : 'bad';
            return v;
        };
        const p = vs.pick;
        if (vs.order === null) {
            if (p !== null) {
                const v = await ask(p);
                if (v !== null) { vs.miss = 0; return v; }
                if (++vs.miss < 2) return null;
            }
            if (!alive()) return null;
            vs.order = list.map((c, i) => i).filter((i) => i !== p).sort((a, b) => RANK[vs.res[a] || 'new'] - RANK[vs.res[b] || 'new'] || a - b);
            if (p !== null) vs.order.push(p);
            vs.at = 0;
        }
        for (let n = 0; n < SEARCH_PER_TURN && vs.at < vs.order.length && alive(); n++) {
            const i = vs.order[vs.at++];
            const v = await ask(i);
            if (v !== null) {
                if (vs.pick !== i) this.log.info('electrical: 12 V from ' + rd.key(list[i]));
                vs.pick = i; vs.miss = 0; vs.order = null;
                return v;
            }
        }
        if (vs.at >= vs.order.length) vs.order = null;           // all asked, none answered: the next search starts over
        return null;
    }

    /** What the HUD shows; the hybrid values only on a hybrid. Signal values kept longer than read ones. */
    value() {
        const now = Date.now(), hy = this.hybrid();
        const get = (k, ms) => (this.s[k] && now - this.s[k].t < ms ? this.s[k].v : null);
        // the pack voltage: the SME read while fresh, else the signal's
        const uds = get('hvVoltUds', SLOW_STALE_MS), volt = uds !== null ? uds : get('hvVoltSig', SIGNAL_KEEP_MS);
        return {
            soc12: get('soc12', SIGNAL_KEEP_MS), v12: get('v12', V12_MS * 4),
            hvSoc: hy ? get('hvSoc', SLOW_STALE_MS) : null, hvKw: hy ? get('hvKw', STALE_MS) : null,
            hvTemp: hy ? get('hvTemp', SIGNAL_KEEP_MS) : null, hvVolt: hy ? volt : null,
        };
    }
}

Electrical.V12 = V12; Electrical.HV_SOC = HV_SOC; Electrical.HV_V = HV_V; Electrical.HV_A = HV_A;
Electrical.KW_SEARCH_AFTER = KW_SEARCH_AFTER; Electrical.KW_RETRY_MS = KW_RETRY_MS;
Electrical.decode = decode;
module.exports = Electrical;
