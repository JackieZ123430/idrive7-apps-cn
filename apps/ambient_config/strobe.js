'use strict';
/**
 * strobe.js - the high beams flashed, and the light show, for use on private property only. Three ways to the lamps,
 * the first the car answers wins (reads only to tell):
 *
 * The body controller's light functions (kind 'fn', BDC / BDC_G11 / BDC_G05 alike): LEUCHTEN_FUNKTION
 *   2E D542 <function, 2 bytes> <time in 10 ms, 2 bytes> switches one of the car's own light functions on (high beam,
 *   cornering light left / right, front fog, indicators, brake, reverse ...) and the body controller switches it off
 *   again by itself after the time. One request is one flash, as bright as the car makes that light, timed by the car:
 *   the flash stays short however slowly the requests come (one about every 200 ms). Read with 22 D542.
 *
 * The headlight units (left 0x43, right 0x44): on LED headlights the high beam is theirs, the body controller's lamp
 * output does nothing. _LEUCHTEN_AUSSENLICHT_KANAL 31 01 3000 <current/10 mA, PWM %> for every LED channel sets the
 * whole headlight at once; the live channels are read first (the low beam stays as it is) and the high beam's
 * channels are added for "on" (lights 'high'), or every fitted LED at full against all dark (lights 'all': the
 * fitted channels and their currents from BMW's lamp test for all LEDs, 31 01 A543 FF, read back once). Both
 * headlights are written at once. Leaving the extended session (10 01) gives the headlight back to the car.
 *   kind 'flm' (FLM01): channels read with 22 D667, 12 channels; high beam on channels 1 and 9 (seen on a car with
 *                       the stalk: 1 at 1000 mA 75 %, 9 at 1000 mA 41 %)
 *   kind 'fle' (FLE):   channels read with 22 D631, 7 channels; which are the high beam is learned (learn())
 *   Learn: the channels that light up while the high beam is switched on with the stalk.
 *
 * The body controller (BDC 0x40), on cars whose high beams hang on its lamp outputs:
 *   kind 'bdc' (BDC, BDC_G11): STATUS_LEUCHTENAUSGANG_DIGITAL  22 4500 -> 62 4500 <a spare byte, then one per output>
 *                              STEUERN_LEUCHTENAUSGANG_DIGITAL 2F 4501 <control> <element> <state>
 *   kind 'g05' (BDC_G05):      LICHT_AUSGANG_DIGITAL           22 E3B9 -> 62 E3B9 <a spare byte, then one per output>
 *                              LICHT_AUSGANG_DIGITAL_STEUERN   2F E3B5 <control> <element> <state>
 *   control 03 shortTermAdjustment (state 01 on, 00 off), 00 returnControlToECU (state 00: without it, NRC 13).
 *   Outputs 07 FL_L, 08 FL_R, the status in that order (AL_L AL_R TFL_L TFL_R SML_L SML_R FL_L FL_R ...).
 *   The first flash is checked against the status: outputs that do not follow (or a refusal) stop it all.
 *
 * Light show: BDC_G11 / BDC_G05 run their own (_LICHT_DISCO_PWM 2E 4530 <pwm 1 %> <pwm 2 %> <cycle> <mode> <ms hi>
 * <ms lo> 00 00, every discrete lamp output); on the headlight units every lit channel at full against all dark,
 * the two sides in turn.
 *
 * The head unit's transport takes one request at a time (~200 ms each), so a flash is as fast as two writes. The
 * session is kept with 3E 00 (with its reply: 3E 80 holds the transport for seconds waiting for one), and the units
 * drop it by themselves a few seconds after the last request, so an app that dies mid-flash leaves the lamps to the car.
 *
 * Nothing else of the app talks to the body controller meanwhile: hold(true) (the ambient lights' writes, Lights.hold)
 * before a strobe, light show or learn starts, hold(false) once it has ended.
 *
 *   const s = new Strobe({ diag, log, allowed, channels, hold });  await s.find();   s.kind -> 'flm' | 'fle' | 'bdc' | 'g05' | null
 *   s.start({ lights: 'all' | 'high', pattern: 'both' | 'alternate', rate: 'fast' | 'normal' | 'slow' })   s.show()   s.learn()   s.stop()
 *   s.running -> 'strobe' | 'show' | 'learn' | null       s.note       s.on('change', fn)   s.on('learned', fn(channels))
 */
const EventEmitter = require('events');

const BDC = 0x40;
const SIDES = [0x43, 0x44];                         // left, right headlight unit
const HEAD = {
    flm: { name: 'FLM01 headlights', read: [0xD6, 0x67], n: 12, high: [{ ch: 1, cur: 0x64, pwm: 0x4B }, { ch: 9, cur: 0x64, pwm: 0x29 }] },
    fle: { name: 'FLE headlights', read: [0xD6, 0x31], n: 7, high: null },
};
const KINDS = {
    bdc: { name: 'BDC', status: [0x45, 0x00], control: [0x45, 0x01], first: 1 },
    g05: { name: 'BDC_G05', status: [0xE3, 0xB9], control: [0xE3, 0xB5], first: 1 },
};
const CHANNELS = [0x30, 0x00];
// the body controller's light functions (TAB_LAMPEN_FUNKTION, the same numbers in BDC, BDC_G11, BDC_G05)
const FN = [0xD5, 0x42];
const F = { high: 0x05, indL: 0x06, indR: 0x07, fog: 0x08, cornL: 0x09, cornR: 0x0A, brake: 0x0C, ess: 0x0D, rearFog: 0x0E,
    reverse: 0x0F, parkL: 0x10, parkR: 0x11 };
// a flash's length (10 ms) and the least time from one flash to the next, by rate; never more than 150 ms lit, so
// nothing stays on if the app goes
const FLASH = { fast: { on: 8, gap: 0 }, normal: { on: 12, gap: 120 }, slow: { on: 15, gap: 350 } };
// police: this many high beam flashes on one side, then on the other (the other headlight held at its own lights)
const POLICE_BURST = 4;
// the order of the bursts, round and round
const POLICE_ORDERS = {
    lrb: ['left', 'right', 'both', 'right', 'left', 'both'],
    lr: ['left', 'right'],
    lbr: ['left', 'both', 'right', 'both'],
};
/** A flash of ms milliseconds in the body controller's 10 ms steps: 30 to 150 ms. */
const flashTicks = (ms) => Math.max(3, Math.min(15, Math.round((+ms || 100) / 10)));
// the patterns, one function a request; police and in turn only ever one side at a time (the high beam is both)
const FN_PATTERNS = {
    // police without headlight units to hold a side: high beam bursts with a pause (cornering lights are side
    // markers on some cars)
    police: { all: ['high', 'high', 'high', 'high', 'pause', 'pause'], high: ['high', 'high', 'high', 'high', 'pause', 'pause'] },
    both: { all: ['high', 'fog'], high: ['high'] },
    alternate: { all: ['cornL', 'cornR'], high: ['cornL', 'cornR'] },
};
const SHOW_ORDER = ['high', 'cornL', 'cornR', 'fog', 'indL', 'indR', 'parkL', 'parkR', 'brake', 'reverse', 'rearFog', 'ess'];
const FL_L = 0x07, FL_R = 0x08;
const STA = 0x03, RCTECU = 0x00;
const DISCO = [0x45, 0x30];
// at least this long for half a flash (on, or off), by rate; the writes take what they take (~200 ms each)
const HALF_MS = { fast: 0, normal: 200, slow: 500 };
const MAX_MS = 30000;            // one press: at most this long
const SHOW_MS = 15000;           // the light show's length
const KEEP_MS = 2000;            // 3E 00 this often when nothing else is sent
const LEARN_MS = 15000;          // how long learn() waits for the high beam
// the LEDs' safety: never more current than the car's own coding gives a channel (its lamp test), never a channel it
// does not have; after a run, rest at least as long (REST_MS at the least); FLM01's calculated LED temperatures
// (22 D630, the last 12 bytes, value - 40 °C) at or above HOT_C stop it, read at the start and every HOT_EVERY_MS
const MAX_CUR = 150;             // 1500 mA, the most the description allows any channel
const REST_MS = 10000;
// and over time: at most BUDGET_MS of flashing in any BUDGET_WINDOW_MS
const BUDGET_MS = 120000;
const BUDGET_WINDOW_MS = 600000;
const HOT_FN_EVERY_MS = 10000;   // the headlights' temperatures while the body controller flashes (police)
const HOT_C = 90;
const HOT_EVERY_MS = 5000;
const statusIndex = (kind, el) => KINDS[kind].first + el - 1;   // the output's byte after 62 <did>

const hex = (b) => (b || []).map((x) => (x < 16 ? '0' : '') + x.toString(16).toUpperCase()).join(' ');

class Strobe extends EventEmitter {
    constructor(o) {
        super();
        this.diag = o.diag; this.log = o.log;
        this.allowed = o.allowed || (() => 'not set up');        // allowed('strobe' | 'show' | 'learn'): null, may run; else why not
        this.now = o.now || Date.now;
        this.sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.learned = Array.isArray(o.channels) && o.channels.length ? o.channels : null;   // [{ ch, cur, pwm }]
        this.kind = null; this.sides = [];
        this.running = null; this.note = null; this.noteType = 'dim'; this._stop = false;
        this.hold = o.hold || null;              // hold(on) -> Promise: the app's other writes to the body controller
        this._starting = false;
    }

    /** fn() run with the app's other writes to the body controller held (hold), let go when it has ended. */
    async _held(fn) {
        if (this.running || this._starting) return null;
        if (!this.hold) return fn();
        this._starting = true;
        try { await this.hold(true); } catch (e) { this.log.warn('strobe: hold: ' + (e && e.message || e)); }
        this._starting = false;
        try { return await fn(); } finally {
            try { await this.hold(false); } catch (e) { this.log.warn('strobe: hold: ' + (e && e.message || e)); }
        }
    }

    _say(note, type) { this.note = note; this.noteType = type || 'dim'; this.emit('change'); }

    async _ask(target, sid, data, timeoutMs) {
        try {
            const did = sid === 0x10 || sid === 0x3E ? null : sid === 0x31 ? data.slice(0, 3) : data.slice(0, 2);
            const ok = (u) => (u[0] === sid + 0x40 && (!did || did.every((b, i) => u[i + 1] === b))) || (u[0] === 0x7F && u[1] === sid);
            this.failed = null;
            return await this.diag.physical(target, sid, data, timeoutMs || 1500, ok, { retryBaseMs: 20, maxRetries: 6 });
        } catch (e) { this.failed = String(e && e.message || e); return null; }
    }

    /** A read for find(): the transport refusing (busy at the head unit's start) is asked again, no answer is not. */
    async _probe(target, sid, data, timeoutMs) {
        for (let i = 0; i < 12; i++) {
            const r = await this._ask(target, sid, data, timeoutMs);
            if (r || !this.failed) return r;
            await this.sleep(500);
        }
        this.log.info('strobe: ' + hex([target]) + ' not asked (' + this.failed + ')');
        return null;
    }

    get head() { return HEAD[this.kind] || null; }
    /** The high beam's channels on the headlight units: learned, or the kind's own. */
    get high() { return this.head ? this.learned || this.head.high : null; }
    get kindName() { return this.kind === 'fn' ? 'body controller light functions' : this.head ? this.head.name : this.kind ? KINDS[this.kind].name : null; }
    /** Police, all lights / high beam: what this way to the lamps can do. */
    get patterns() { return this.kind === 'fn' || this.head; }

    /** Which way to the lamps (reads only): the headlight units first, then the body controller. */
    async find() {
        // at the head unit's start the transport is not there yet: every read would fail and the body controller,
        // asked last, would win on a car whose headlights do the high beam
        if (this.diag.available === false && typeof this.diag.on === 'function') {
            await new Promise((resolve) => {
                const done = () => { clearTimeout(tm); this.diag.removeListener('available', onA); resolve(); };
                const onA = (a) => { if (a) done(); };
                const tm = setTimeout(done, 20000);
                this.diag.on('available', onA);
            });
        }
        {
            const r = await this._probe(BDC, 0x22, FN, 4000);
            if (r && r[0] === 0x62) {
                this.kind = 'fn'; this.sides = [BDC];
                // the headlight units, to hold one side while the other flashes (police); reads only
                this.mask = null;
                for (const k of ['flm', 'fle']) {
                    const sides = [];
                    for (const a of SIDES) {
                        const h = await this._probe(a, 0x22, HEAD[k].read, 3000);
                        if (h && h[0] === 0x62 && h.length >= 3 + 2 * HEAD[k].n) sides.push(a);
                    }
                    if (sides.length === 2) { this.mask = { head: HEAD[k], sides }; break; }
                }
                this.log.info('strobe: body controller light functions (22 D542 ' + hex(r.slice(3, 9)) + ')'
                    + (this.mask ? ', police with the ' + this.mask.head.name : ''));
                this.emit('change');
                return 'fn';
            }
        }
        for (const kind of ['flm', 'fle']) {
            const sides = [];
            for (const a of SIDES) {
                const r = await this._probe(a, 0x22, HEAD[kind].read, 3000);
                if (r && r[0] === 0x62 && r.length >= 3 + 2 * HEAD[kind].n) sides.push(a);
            }
            if (sides.length) {
                this.kind = kind; this.sides = sides;
                this.log.info('strobe: ' + HEAD[kind].name + ' at ' + sides.map((a) => hex([a])).join(', ')
                    + (this.high ? ', high beam on channels ' + this.high.map((c) => c.ch).join(', ') : ', high beam channels to learn'));
                this.emit('change');
                return kind;
            }
        }
        for (const kind of ['bdc', 'g05']) {
            const r = await this._probe(BDC, 0x22, KINDS[kind].status, 4000);
            if (r && r[0] === 0x62) {
                this.kind = kind; this.sides = [BDC];
                this.log.info('strobe: body controller ' + KINDS[kind].name + ' (high beam ' + this._lamp(r, FL_L) + ' / ' + this._lamp(r, FL_R) + ')');
                this.emit('change');
                return kind;
            }
        }
        this.kind = null; this.sides = [];
        this.log.info('strobe: no headlight or lamp output control found');
        this.emit('change');
        return null;
    }

    // --- headlight units ---

    /** A side's channels now: [{ cur, pwm }] x n, or null. */
    async _channels(a) {
        const r = await this._ask(a, 0x22, this.head.read, 1500);
        if (!r || r[0] !== 0x62 || r.length < 3 + 2 * this.head.n) return null;
        const out = [];
        for (let i = 0; i < this.head.n; i++) out.push({ cur: r[3 + 2 * i], pwm: r[4 + 2 * i] });
        return out;
    }

    async _setChannels(a, chans) {
        const data = CHANNELS.slice();
        chans.forEach((c) => data.push(Math.min(c.cur, MAX_CUR) & 0xFF, Math.min(c.pwm, 100) & 0xFF));
        const r = await this._ask(a, 0x31, [0x01].concat(data));
        return r && r[0] === 0x71 ? true : r ? 'NRC ' + hex([r[2]]) : 'no answer';
    }

    /**
     * Every fitted LED channel of each side at its own current: BMW's lamp test for all LEDs (31 01 A543 FF) lights
     * each at its coded current, read back, then ended by leaving the session. Asked once, then kept.
     * Leaves the sides in the extended session. { side: [{ cur, pwm }] }, pwm 100 where fitted.
     */
    async _fitted() {
        if (this.fitted) return this.fitted;
        const out = {};
        await Promise.all(this.sides.map((a) => this._ask(a, 0x31, [0x01, 0xA5, 0x43, 0xFF])));
        for (const a of this.sides) {
            const now = await this._channels(a);
            if (!now) return null;
            out[a] = now.map((c) => (c.cur > 0 ? { cur: c.cur, pwm: 100 } : { cur: 0, pwm: 0 }));
        }
        await this._sessions(0x01);
        await this._sessions(0x03);
        // a lamp test that lit nothing: no limits known, so nothing is driven
        if (this.sides.every((a) => out[a].every((c) => !c.cur))) return null;
        this.log.info('strobe: fitted channels ' + this.sides.map((a) => hex([a]) + ': ' + out[a].map((c, i) => (c.cur ? (i + 1) + '@' + c.cur * 10 + 'mA' : null)).filter(Boolean).join(' ')).join(' / '));
        this.fitted = out;
        return out;
    }

    /**
     * lights 'all': on every fitted channel at full, off all dark. 'high': off the channels as they are with the
     * high beam's dark, on the high beam's added at full.
     */
    _states(now, a, lights) {
        const lim = this.fitted[a];          // the car's own current per channel; 0: not fitted, never driven
        if (lights === 'all') return { on: lim, off: now.map(() => ({ cur: 0, pwm: 0 })) };
        const off = now.map((c) => ({ cur: c.cur, pwm: c.pwm })), on = now.map((c) => ({ cur: c.cur, pwm: c.pwm }));
        for (const h of this.high) {
            if (h.ch < 1 || h.ch > now.length || !lim[h.ch - 1].cur) continue;
            off[h.ch - 1] = { cur: 0, pwm: 0 };
            on[h.ch - 1] = { cur: Math.min(h.cur, lim[h.ch - 1].cur), pwm: 100 };
        }
        return { on, off };
    }

    /** FLM01: the hottest calculated LED temperature of the sides (°C), or null where not known. */
    async _hottest() {
        // FLM01 headlight units: their own (strobe on the channels) or held for police
        const sides = this.kind === 'flm' ? this.sides : this.kind === 'fn' && this.mask && this.mask.head === HEAD.flm ? this.mask.sides : null;
        if (!sides) return null;
        let max = null;
        for (const a of sides) {
            const r = await this._ask(a, 0x22, [0xD6, 0x30], 1500);
            if (!r || r[0] !== 0x62 || r.length < 23) continue;
            for (const b of r.slice(11, 23)) if (b > 0 && b < 0xFF) max = Math.max(max === null ? -99 : max, b - 40);
        }
        return max;
    }

    async _sessions(n) {
        let ok = true;
        for (const a of this.sides) {
            const r = await this._ask(a, 0x10, [n]);
            ok = ok && !!(r && r[0] === 0x50);
        }
        return ok;
    }

    async _keep(t) {
        if (this.now() - t.keep < KEEP_MS) return;
        for (const a of this.sides) await this._ask(a, 0x3E, [0x00]);
        t.keep = this.now();
    }

    // --- body controller ---

    _lamp(r, el) { const v = r && r[3 + statusIndex(this.kind, el)]; return v === undefined ? null : v; }

    async _status() { const r = await this._ask(BDC, 0x22, KINDS[this.kind].status, 1500); return r && r[0] === 0x62 ? r : null; }

    async _set(el, on) {
        const r = await this._ask(BDC, 0x2F, KINDS[this.kind].control.concat([STA, el, on ? 1 : 0]));
        return r && r[0] === 0x6F ? true : r ? 'NRC ' + hex([r[2]]) : 'no answer';
    }

    /** Every output back to the car, whatever happened before. */
    async _giveBack(els) {
        for (const el of els) {
            await this._set(el, false);
            await this._ask(BDC, 0x2F, KINDS[this.kind].control.concat([RCTECU, el, 0x00]));
        }
        await this._ask(BDC, 0x10, [0x01]);
    }

    /** One light function on for ticks x 10 ms (0: off). */
    async _fn(name, ticks) {
        const r = await this._ask(BDC, 0x2E, FN.concat([0x00, F[name], (ticks >> 8) & 0xFF, ticks & 0xFF]));
        return r && r[0] === 0x6E ? true : r ? 'NRC ' + hex([r[2]]) : 'no answer';
    }

    /** Flash the functions in seq round and round until stop, ms, a refusal or allowed() saying no. */
    async _runFn(seq, flash, ms, what) {
        const t0 = this.now(), used = {};
        let step = 0, end = null;
        try {
            const r = await this._ask(BDC, 0x10, [0x03]);
            if (!r || r[0] !== 0x50) { end = [what + ': the body controller refused the diagnostic session', 'warn']; return; }
            while (!this._stop) {
                const stopWhy = this.allowed(this.running);
                if (stopWhy) { end = [what + ' stopped: ' + stopWhy, 'warn']; break; }
                if (this.now() - t0 > ms) { end = [what + ' done (' + Math.round(ms / 1000) + ' s)', 'dim']; break; }
                const at = this.now(), name = seq[step % seq.length];
                if (name === 'pause') { step++; await this.sleep(Math.max(200, flash.gap)); continue; }
                const res = await this._fn(name, flash.on);
                used[name] = true;
                if (res !== true) { end = [what + ' stopped: refused (' + res + ')', 'warn']; break; }
                if (step === 0) this._say(what + ' on');
                step++;
                const left = flash.gap - (this.now() - at);
                if (left > 0) await this.sleep(left);
            }
            if (!end) end = [what + ' stopped', 'dim'];
        } finally {
            for (const name of Object.keys(used)) await this._fn(name, 0);
            await this._ask(BDC, 0x10, [0x01]);
            this.running = null;
            if (step > 0) this._rest(t0);
            this.log.info('strobe: ' + (end ? end[0] : 'ended') + ' after ' + step + ' flashes');
            this._say(end ? end[0] : what + ' stopped', end ? end[1] : 'dim');
        }
    }

    /**
     * Police on the high beam: one headlight held at its own lights (31 01 3000 with the channels as read: nothing
     * brighter than the car's own) while the body controller's timed high beam flashes show on the other side only,
     * POLICE_BURST flashes, then the other way round; a held side is let go with 31 02 3000.
     */
    async _runPolice(flash, ms, o) {
        const t0 = this.now(), m = this.mask, H = m.head;
        const phases = POLICE_ORDERS[o && o.order] || POLICE_ORDERS.lbr;
        const burst = Math.max(1, Math.min(4, +(o && o.burst) || POLICE_BURST));
        const base = {};
        let step = 0, end = null, held = null;
        try {
            for (const a of [BDC].concat(m.sides)) {
                const r = await this._ask(a, 0x10, [0x03]);
                if (!r || r[0] !== 0x50) { end = ['Strobe: ' + hex([a]) + ' refused the diagnostic session', 'warn']; return; }
            }
            const hot0 = await this._hottest();
            if (hot0 !== null && hot0 >= HOT_C) { end = ['Strobe not started: the headlights are hot (' + hot0 + ' °C)', 'warn']; return; }
            let hotT = this.now();
            for (const a of m.sides) {
                const r = await this._ask(a, 0x22, H.read, 1500);
                if (!r || r[0] !== 0x62 || r.length < 3 + 2 * H.n) { end = ['Strobe: no channel reading from the headlight ' + hex([a]), 'warn']; return; }
                base[a] = [];
                for (let i = 0; i < H.n; i++) base[a].push({ cur: r[3 + 2 * i], pwm: r[4 + 2 * i] });
            }
            for (let k = 0; !end && !this._stop; k++) {
                if (this.now() - hotT > HOT_FN_EVERY_MS) {
                    const hot = await this._hottest();
                    hotT = this.now();
                    if (hot !== null && hot >= HOT_C) { end = ['Strobe stopped: the headlights got hot (' + hot + ' °C)', 'warn']; break; }
                }
                // flashing the left side holds the right one, and the other way round; both: none held
                const phase = phases[k % phases.length];
                const hold = phase === 'left' ? m.sides[1] : phase === 'right' ? m.sides[0] : null;
                if (held !== hold) {
                    if (held !== null) await this._ask(held, 0x31, [0x02, 0x30, 0x00]);
                    held = null;
                    if (hold !== null) {
                        const r = await this._setChannels(hold, base[hold]);
                        if (r !== true) { end = ['Strobe stopped: refused (' + r + ')', 'warn']; break; }
                        held = hold;
                    }
                }
                for (let i = 0; i < burst; i++) {
                    if (this._stop) break;
                    const stopWhy = this.allowed(this.running);
                    if (stopWhy) { end = ['Strobe stopped: ' + stopWhy, 'warn']; break; }
                    if (this.now() - t0 > ms) { end = ['Strobe done (' + Math.round(ms / 1000) + ' s)', 'dim']; break; }
                    const at = this.now();
                    const r = await this._fn('high', flash.on);
                    if (r !== true) { end = ['Strobe stopped: refused (' + r + ')', 'warn']; break; }
                    if (step === 0) this._say('Strobe on · police');
                    step++;
                    const left = flash.gap - (this.now() - at);
                    if (left > 0) await this.sleep(left);
                }
            }
            if (!end) end = ['Strobe stopped', 'dim'];
        } finally {
            if (held !== null) await this._ask(held, 0x31, [0x02, 0x30, 0x00]);
            await this._fn('high', 0);
            for (const a of m.sides) await this._ask(a, 0x10, [0x01]);
            await this._ask(BDC, 0x10, [0x01]);
            this.running = null;
            if (step > 0) this._rest(t0);
            this.log.info('strobe: ' + (end ? end[0] : 'ended') + ' after ' + step + ' flashes (police)');
            this._say(end ? end[0] : 'Strobe stopped', end ? end[1] : 'dim');
        }
    }

    _why() {
        if (!this.kind) return 'no headlight or lamp output control found';
        if (this.head && !this.high) return 'the high beam\'s channels are not known yet (Learn)';
        return this._resting() || this.allowed('strobe');
    }

    _rest(t0) {
        const t1 = this.now();
        this.restUntil = t1 + Math.max(REST_MS, t1 - t0);
        this.runs = (this.runs || []).filter((r) => r[1] > t1 - BUDGET_WINDOW_MS).concat([[t0, t1]]);
    }

    /** Flashing time in the last BUDGET_WINDOW_MS, ms. */
    _flashedLately() {
        const from = this.now() - BUDGET_WINDOW_MS;
        return (this.runs || []).reduce((n, r) => n + Math.max(0, r[1] - Math.max(r[0], from)), 0);
    }

    /** Why the lights must rest, or null. */
    _resting() {
        if (this.restUntil && this.now() < this.restUntil) return 'the lights rest ' + Math.ceil((this.restUntil - this.now()) / 1000) + ' s more';
        if (this._flashedLately() >= BUDGET_MS) {
            // the oldest run leaves the window when enough has gone by
            let need = this._flashedLately() - BUDGET_MS + 1000, wait = 0;
            for (const r of this.runs) { wait = r[1] + BUDGET_WINDOW_MS - this.now(); need -= r[1] - r[0]; if (need <= 0) break; }
            return 'the lights have flashed ' + Math.round(BUDGET_MS / 60000) + ' min in the last ' + Math.round(BUDGET_WINDOW_MS / 60000) + ' min; rest ' + Math.ceil(Math.max(wait, 1000) / 60000) + ' min';
        }
        return null;
    }

    /** The high beams flashing until stop(), MAX_MS, a refusal or allowed() saying no. */
    start(o) { return this._held(() => this._start(o)); }
    async _start(o) {
        if (this.running) return;
        const why = this._why();
        if (why) { this._say('Strobe not started: ' + why, 'warn'); return; }
        if (this.kind === 'fn') {
            const pat = FN_PATTERNS[o && o.pattern] || FN_PATTERNS.police;
            this.running = 'strobe'; this._stop = false; this._say('Strobe starting...');
            const base = FLASH[o && o.rate] || FLASH.fast;
            // every: the time from one flash to the next (ms; 0 or less than a request takes: as fast as it goes)
            const flash = { on: o && o.flashMs ? flashTicks(o.flashMs) : base.on, gap: o && o.every != null ? Math.max(0, Math.min(2000, +o.every || 0)) : base.gap };
            if ((!o || !o.pattern || o.pattern === 'police') && this.mask) return this._runPolice(flash, MAX_MS, o);
            return this._runFn(pat[o && o.lights === 'high' ? 'high' : 'all'], flash, MAX_MS, 'Strobe');
        }
        const head = !!this.head;
        // police: one headlight flashes, then the other, one write each (the fastest there is: ~200 ms a write)
        const pattern = o && (o.pattern === 'alternate' || o.pattern === 'police') ? (o.pattern === 'police' && !head ? 'alternate' : o.pattern) : 'both';
        const lights = o && o.lights === 'high' ? 'high' : 'all';
        const half = o && HALF_MS[o.rate] !== undefined ? HALF_MS[o.rate] : HALF_MS.normal;
        this.running = 'strobe'; this._stop = false; this._say('Strobe starting...');
        const t0 = this.now(), t = { keep: this.now() };
        let step = 0, end = null, states = null;
        try {
            if (head) {
                if (!(await this._sessions(0x03))) { end = ['Strobe: the headlights refused the diagnostic session', 'warn']; return; }
                const before = {};
                for (const a of this.sides) {
                    before[a] = await this._channels(a);
                    if (!before[a]) { end = ['Strobe: no channel reading from the headlight ' + hex([a]), 'warn']; return; }
                }
                if (!(await this._fitted())) { end = ['Strobe: the headlights\' lamp test did not answer', 'warn']; return; }
                if (lights === 'high' && !this.high.some((h) => this.fitted[this.sides[0]][h.ch - 1] && this.fitted[this.sides[0]][h.ch - 1].cur)) {
                    end = ['Strobe not started: the lamp test does not light the high beam\'s channels (Learn again)', 'warn']; return;
                }
                const hot = await this._hottest();
                if (hot !== null && hot >= HOT_C) { end = ['Strobe not started: the headlights are hot (' + hot + ' °C)', 'warn']; return; }
                t.hot = this.now();
                states = {};
                for (const a of this.sides) states[a] = this._states(before[a], a, lights);
                // back to the channels as they were at the end
                for (const a of this.sides) states[a].back = before[a];
                // police starts from dark
                if (pattern === 'police') {
                    const rs = await Promise.all(this.sides.map((a) => this._setChannels(a, states[a].off)));
                    if (rs.some((r) => r !== true)) { end = ['Strobe: refused (' + rs.find((r) => r !== true) + ')', 'warn']; return; }
                }
            } else {
                const r = await this._ask(BDC, 0x10, [0x03]);
                if (!r || r[0] !== 0x50) { end = ['Strobe: the body controller refused the diagnostic session', 'warn']; return; }
            }
            t.keep = this.now();
            const targets = head ? this.sides : [FL_L, FL_R];
            while (!this._stop) {
                const stopWhy = this.allowed(this.running);
                if (stopWhy) { end = ['Strobe stopped: ' + stopWhy, 'warn']; break; }
                if (this.now() - t0 > MAX_MS) { end = ['Strobe done (' + MAX_MS / 1000 + ' s)', 'dim']; break; }
                const on = step % 2 === 0, at = this.now();
                // both: both on, both off; alternate: left on right off, then the other way round
                const want = (i) => (pattern === 'both' ? on : (i === 0) === on);
                if (head && pattern === 'police') {
                    const a = this.sides[Math.floor(step / 2) % this.sides.length];
                    const r = await this._setChannels(a, states[a][on ? 'on' : 'off']);
                    if (r !== true) { end = ['Strobe stopped: refused (' + r + ')', 'warn']; break; }
                } else if (head) {
                    // both headlights at once
                    const rs = await Promise.all(targets.map((a, i) => this._setChannels(a, states[a][want(i) ? 'on' : 'off'])));
                    const bad = rs.find((r) => r !== true);
                    if (bad) { end = ['Strobe stopped: refused (' + bad + ')', 'warn']; break; }
                } else {
                    for (let i = 0; i < targets.length; i++) {
                        const r = await this._set(targets[i], want(i));
                        if (r !== true) { end = ['Strobe stopped: refused (' + r + ')', 'warn']; break; }
                    }
                }
                if (end) break;
                if (step === 0) {
                    // the first flash: the reading must say the high beams followed
                    let ok, seen = '';
                    if (head) {
                        // every channel lit or dark as written (the first side is "on" at the first step either way)
                        const now = await this._channels(this.sides[0]), want0 = states[this.sides[0]].on;
                        ok = !!now && now.every((c, i) => (c.cur > 0) === (want0[i].cur > 0));
                    } else {
                        const st = await this._status();
                        const v = targets.map((el) => this._lamp(st, el));
                        ok = !!st && v.every((x, i) => x === (pattern === 'both' || i === 0 ? 1 : 0));
                        seen = ' (status ' + v.join(' / ') + ')';
                    }
                    if (!ok) { end = ['Strobe stopped: the high beams did not follow' + seen, 'warn']; break; }
                    this._say('Strobe on · ' + (pattern === 'both' ? 'both together' : pattern === 'police' ? 'police' : 'left and right in turn'));
                }
                step++;
                if (head && this.now() - t.hot > HOT_EVERY_MS) {
                    const hot = await this._hottest();
                    t.hot = this.now();
                    if (hot !== null && hot >= HOT_C) { end = ['Strobe stopped: the headlights got hot (' + hot + ' °C)', 'warn']; break; }
                }
                if (half - (this.now() - at) > 0) {
                    await this._keep(t);
                    const left = half - (this.now() - at);
                    if (left > 0) await this.sleep(left);
                }
            }
            if (!end) end = ['Strobe stopped', 'dim'];
        } finally {
            if (head) {
                if (states) await Promise.all(this.sides.map((a) => this._setChannels(a, states[a].back)));
                await this._sessions(0x01);
            } else {
                await this._giveBack([FL_L, FL_R]);
            }
            this.running = null;
            if (step > 0) this._rest(t0);
            this.log.info('strobe: ' + (end ? end[0] : 'ended') + ' after ' + step + ' steps');
            this._say(end ? end[0] : 'Strobe stopped', end ? end[1] : 'dim');
        }
    }

    /** The light show for SHOW_MS: the body controller's own (BDC_G11, BDC_G05), or the headlights in turn. */
    show(o) { return this._held(() => this._show(o)); }
    async _show(o) {
        if (this.running) return;
        const why = !this.kind ? 'no headlight or lamp output control found' : this._resting() || this.allowed('show');
        if (why) { this._say('Light show not started: ' + why, 'warn'); return; }
        const s0 = this.now();
        if (this.kind === 'fn') {
            this.running = 'show'; this._stop = false; this._say('Light show starting...');
            const flash = o && o.rate === 'fast' ? { on: 10, gap: 0 } : { on: 15, gap: 150 };
            return this._runFn(SHOW_ORDER, flash, Math.min(SHOW_MS, o && o.ms || SHOW_MS), 'Light show');
        }
        const ms = Math.min(SHOW_MS, o && o.ms || SHOW_MS);
        const head = !!this.head;
        const cycle = o && o.rate === 'fast' ? 0x03 : 0x04;            // BDC: 50 or 100 ms between the two PWM values
        this.running = 'show'; this._stop = false; this._say('Light show starting...');
        let end = null, base = null;
        try {
            if (head) {
                if (!(await this._sessions(0x03))) { end = ['Light show: the headlights refused the diagnostic session', 'warn']; return; }
                base = {};
                for (const a of this.sides) {
                    const now = await this._channels(a);
                    if (!now) { base = null; end = ['Light show: no channel reading from the headlight ' + hex([a]), 'warn']; return; }
                    base[a] = { now, dark: now.map(() => ({ cur: 0, pwm: 0 })) };
                }
                if (!(await this._fitted())) { end = ['Light show: the headlights\' lamp test did not answer', 'warn']; return; }
                const hot = await this._hottest();
                if (hot !== null && hot >= HOT_C) { end = ['Light show not started: the headlights are hot (' + hot + ' °C)', 'warn']; return; }
                for (const a of this.sides) base[a].lit = this.fitted[a];
                this._say('Light show on');
                const t0 = this.now(), half = o && o.rate === 'fast' ? 0 : 200;
                let step = 0;
                while (!this._stop && this.now() - t0 < ms) {
                    const stopWhy = this.allowed(this.running);
                    if (stopWhy) { end = ['Light show stopped: ' + stopWhy, 'warn']; break; }
                    const at = this.now();
                    const rs = await Promise.all(this.sides.map((a, i) => this._setChannels(a, base[a][(step + i) % 2 === 0 ? 'lit' : 'dark'])));
                    const bad = rs.find((r) => r !== true);
                    if (bad) { end = ['Light show stopped: refused (' + bad + ')', 'warn']; break; }
                    step++;
                    const left = half - (this.now() - at);
                    if (left > 0) await this.sleep(left);
                }
            } else {
                const s = await this._ask(BDC, 0x10, [0x03]);
                if (!s || s[0] !== 0x50) { end = ['Light show: the body controller refused the diagnostic session', 'warn']; return; }
                const r = await this._ask(BDC, 0x2E, DISCO.concat([100, 0, cycle, 0, (ms >> 8) & 0xFF, ms & 0xFF, 0, 0]));
                if (!r || r[0] !== 0x6E) { end = ['Light show: the body controller refused (' + (r ? 'NRC ' + hex([r[2]]) : 'no answer') + ')', 'warn']; return; }
                this._say('Light show on');
                const t0 = this.now(), t = { keep: this.now() };
                while (!this._stop && this.now() - t0 < ms) {
                    const stopWhy = this.allowed(this.running);
                    if (stopWhy) { end = ['Light show stopped: ' + stopWhy, 'warn']; break; }
                    await this._keep(t);
                    await this.sleep(200);
                }
            }
            if (!end) end = [this._stop ? 'Light show stopped' : 'Light show done', 'dim'];
        } finally {
            if (head) {
                if (base) await Promise.all(this.sides.map((a) => this._setChannels(a, base[a].now)));
                await this._sessions(0x01);
            } else {
                // stopped early: a zero-length show ends it, and the default session drops it anyway
                if (end && !/done/.test(end[0])) await this._ask(BDC, 0x2E, DISCO.concat([0, 0, cycle, 0, 0, 0, 0, 0]));
                await this._ask(BDC, 0x10, [0x01]);
            }
            this.running = null;
            this._rest(s0);
            this.log.info('strobe: ' + (end ? end[0] : 'light show ended'));
            this._say(end ? end[0] : 'Light show stopped', end ? end[1] : 'dim');
        }
    }

    /** The high beam's channels: what lights up on the first headlight while the high beam is switched on (reads only). */
    learn() { return this.head ? this._held(() => this._learn()) : Promise.resolve(null); }
    async _learn() {
        if (this.running || !this.head) return null;
        this.running = 'learn'; this._stop = false;
        this._say('Learning: switch the high beam on with the stalk now (' + LEARN_MS / 1000 + ' s)', 'warn');
        const a = this.sides[0], t0 = this.now();
        let found = null, before = null;
        try {
            before = await this._channels(a);
            while (before && !this._stop && this.now() - t0 < LEARN_MS) {
                await this.sleep(300);
                const now = await this._channels(a);
                if (!now) continue;
                const lit = [];
                now.forEach((c, i) => { if (c.cur > 0 && c.pwm > 0 && before[i].cur === 0) lit.push(i); });
                if (lit.length) {
                    // a moment more for the channels to settle, then the brighter reading
                    await this.sleep(600);
                    const again = await this._channels(a) || now;
                    found = lit.map((i) => ({ ch: i + 1, cur: Math.max(now[i].cur, again[i].cur), pwm: Math.max(now[i].pwm, again[i].pwm) }));
                    break;
                }
            }
        } finally {
            this.running = null;
        }
        if (found) {
            this.learned = found;
            this.log.info('strobe: high beam learned on channels ' + found.map((c) => c.ch + ' (' + c.cur * 10 + ' mA ' + c.pwm + ' %)').join(', '));
            this.emit('learned', found);
            this._say('High beam learned: channel ' + found.map((c) => c.ch).join(', ') + '. Switch it off again.');
        } else {
            this._say(!before ? 'Learn: no channel reading from the headlight' : this._stop ? 'Learn stopped' : 'Learn: no high beam seen (was it on already?)', 'warn');
        }
        return found;
    }

    stop() { this._stop = true; }
}

/*
 * Whether the strobe and the light show may run now: switched on in the settings and someone in the car; the light show
 * (every headlight LED against all dark) also only with the car standing still. The high beam strobe may run while driving.
 *   gateChecks({ setting, away, moving }) -> [[label, ok, why, only], ...]   (only: the check is for that one alone)
 *   gateWhy(checks, what) -> null (what - 'strobe', 'show', 'learn' - may run) | why not
 * moving: kit/parked.js's moving() - a speed over 3 km/h, and quiet after driving counts as moving until a speed is read again.
 */
function gateChecks(o) {
    return [
        ['Switched on in the settings', o.setting === true],
        ['Someone in the car', !o.away],
        ['The car standing still (light show)', !o.moving, null, 'show'],
    ];
}
const gateWhy = (checks, what) => { const c = checks.find((x) => !x[1] && (!x[3] || x[3] === what)); return c ? c[0].toLowerCase() + ': no' : null; };

module.exports = { gateChecks, gateWhy, Strobe, KINDS, HEAD, F, FN_PATTERNS, FLASH, POLICE_ORDERS, flashTicks, SIDES, FL_L, FL_R, HALF_MS, MAX_MS, SHOW_MS, statusIndex };
