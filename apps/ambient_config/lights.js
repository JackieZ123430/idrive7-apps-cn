'use strict';
/**
 * lights.js - the ambient light modules driven with any colour, through the head unit's diagnostic link to the body
 * controller (lin.js has the bytes, scenes.js what each light shows).
 *
 * find() reads both LIN buses once (the BDC answers after a few seconds) and says 'found' with the lights; the lights
 * found at an earlier start (o.known) are used until then, so a colour goes out at once. show(scene) puts a scene on,
 * frame by frame (_next). Through the head unit's gateway one write takes ~200 ms and only one is taken at a time, so
 * the number of writes is what counts: NAD 0 reaches every light of a bus at once (car-tested, G20 BDC_G05), so a bus
 * gets one write for the colour most of its lights want, then single writes only for the lights that differ - a
 * whole-car colour is 2 writes instead of 19. The 6E answer does not prove a light took it: a still colour's writes
 * are sent once more AGAIN_MS after the last of them (no read-back: two reads would hold the gateway for seconds). A
 * still colour holds 60 s and is written again every 40 s, a moving one holds 5 s. carColour() gives every light back
 * to the car (NAD 0 off, sent once more).
 * flash(rgb, ms) lays a colour over everything for a moment; overlay(key, test, at) lays one over the lights test(light)
 * picks until overlay(key, null) - at(ms, on) with on flipping each frame, so a blink is as fast as the writes go (the turn signal's glow, an open door; the rest keep the scene, or the car's own
 * colour); dim(f) scales the brightness (night). Writes that fail
 * in a row (the car switched off, the BDC asleep) pause the writing for 10 s. hold(key, true) stops the writing while
 * something else talks to the body controller (the strobe: the gateway takes one request at a time, and ours in
 * between got its requests refused); it resolves once no write of ours is under way. hold(key, false) goes on.
 *
 * Blind (#197: G21 / G22 whose body module answers the light read "busy" for a whole drive, or goes silent after
 * it, while BMW's menu still works): the read is a job of its own in the body module and hangs there, the write is
 * another. When the reads fail that way (busy or silent, never a reply without lights), one give-back write per bus
 * (NAD 0, harmless: the car's own colour) shows whether the writes are taken; if so the lights are one light per bus
 * (NAD 0, blind: true) and any colour goes on all of them at once. o.writeFirst (reads failed on earlier tries):
 * that write test comes first and the reads are left out, so a fresh body module isn't hung by them; blind lights
 * are not read again. find({ force: true }) ("Look again") reads anyway.
 *
 *   const l = new Lights({ diag, log }); await l.find();
 *   l.lights -> [{ bus, nad, name, part, x, y, ... }]   l.state -> 'finding' | 'none' | 'car' | 'ours'
 *   l.at(light) -> what the light shows now ({ rgb, bright })     l.rate -> writes a second
 */
const EventEmitter = require('events');
const { BDC, BUSES, BDC_G11, parseStatus, writeFrame, releaseFrame } = require('./lin');
const S = require('./scenes');

const HOLD_S = 60, RENEW_MS = 40000, MOVE_HOLD_S = 5, MOVE_RENEW_MS = 3000;
const PAUSE_MS = 10000, FAILS = 4, RELEASE_TRIES = 3;
const ALL = 0;                 // NAD 0: every light of the bus
const AGAIN_MS = 700;          // a still colour's (or a give-back's) writes once more, this long after the last of them
const HOLD_WAIT_MS = 3000;     // hold(): the longest it waits for a write (or read-back) of ours under way
const BUSY_TRIES = 6, BUSY_MS = 400;   // a read answered "busy": asked again up to 6 times, 0.4 s, 0.8 s, ... apart

const echo = (sid, did) => (u) => (u[0] === sid + 0x40 && u[1] === did[0] && u[2] === did[1]) || (u[0] === 0x7f && u[1] === sid);
const same = (a, b) => !!a && !!b && Math.abs(a.bright - b.bright) < 2 && a.rgb.every((x, i) => Math.abs(x - b.rgb[i]) < 3);

class Lights extends EventEmitter {
    constructor(o) {
        super();
        this.diag = o.diag; this.log = o.log; this.now = o.now || Date.now; this.checkMs = o.checkMs;
        this.sleep = o.sleep || ((ms) => new Promise((res) => setTimeout(res, ms)));
        const ok = (l) => l && typeof l === 'object' && (l.bus === 0 || l.bus === 1) && typeof l.nad === 'number' && typeof l.name === 'string';
        this.lights = Array.isArray(o.known) && o.known.every(ok) ? o.known.map((l) => Object.assign({}, l)) : [];
        this.state = this.lights.length ? 'car' : 'finding';
        this.error = null;
        this.scene = null; this.t0 = 0;
        this._flash = null;
        this._dim = 1;
        this._last = new Map();        // light -> { rgb, bright, at }
        this._release = [];            // [{ bus } (every light of it) | { light }] to give back to the car
        this._sentNow = new Set();     // the lights written since the scene came on (sent once more)
        this._gave = [];               // the buses last given back (given back once more)
        this._checkAt = 0; this._checks = 0; this._checkOff = false;
        this._running = false; this._timer = null; this._stopped = false;
        this._fails = 0; this._pauseTill = 0; this._frame = null; this._frames = [];
        this.writes = 0; this._times = [];
        this._holds = new Set(); this._idle = [];
        this._cmds = [];               // one-off writes (command()), sent between the lights' writes
        this._own = new Map();         // carOwn(): key -> test(light), the lights the car drives itself meanwhile
        this.bdc = BDC;                // where the body module's light functions answer (0x40; another address: _findBdc)
        this.writeFirst = !!o.writeFirst;
        this.blind = this.lights.length > 0 && this.lights.every((l) => l.blind);
        this.readFail = false;         // the last find(): reads busy or silent (the kind blind mode is for)
    }

    get rate() { const t = this.now(); this._times = this._times.filter((x) => t - x < 3000); return this._times.length / 3; }
    /** Whole frames a second (every light on the same moment of a moving scene). */
    get fps() { const t = this.now(); this._frames = this._frames.filter((x) => t - x < 5000); return this._frames.length / 5; }

    /**
     * The body module's light functions at another address (once a start, when 0x40 doesn't answer): every unit's
     * index (22 F150 to all), then the light read (bus 1) at the gateway (0x10) and at any other address that names
     * itself a body module. -> true when one answered with lights (this.bdc is then that address).
     */
    async _findBdc() {
        let units = new Map();
        try { units = await this.diag.functional(0x22, [0xf1, 0x50], { idleMs: 3000, maxMs: 15000 }); } catch (e) { this.log.info('lights: units scan: ' + (e && e.message || e)); }
        const idx = (u) => (u && u[0] === 0x62 ? u.slice(3, 6).map((x) => (x < 16 ? '0' : '') + x.toString(16).toUpperCase()).join('') : null);
        const list = Array.from(units.keys()).sort((a, b) => a - b).map((a) => a.toString(16).toUpperCase() + (idx(units.get(a)) ? ':' + idx(units.get(a)) : ''));
        // (in lines of 12: a log line is cut at 300 characters)
        if (!list.length) this.log.info('lights: units answering: none');
        for (let i = 0; i < list.length; i += 12) this.log.info('lights: units answering' + (i ? ' (more)' : '') + ': ' + list.slice(i, i + 12).join(' '));
        const BODY = ['0F2680', '0F2050', '0F19C0'];        // BDC_G05, BDC_G11, BDC
        const tries = [0x10].concat(Array.from(units.keys()).filter((a) => a !== BDC && a !== 0x10 && BODY.indexOf(idx(units.get(a))) >= 0));
        for (const at of tries) {
            const did = BUSES[0].read;
            let r = null, err = null;
            try { r = await this.diag.physical(at, 0x22, did, 15000, echo(0x22, did), { pendingTimeoutMs: 15000 }); } catch (e) { err = String(e && e.message || e); }
            const got = r ? parseStatus(0, r) : null;
            this.log.info('lights: the light read at ' + at.toString(16).toUpperCase() + ': ' + (got ? got.length + ' lights'
                : r ? 'no lights (' + r.map((x) => x.toString(16)).join(' ') + ')' : 'no answer' + (err ? ' (' + err + ')' : '')));
            if (got && got.length) { this.bdc = at; this.log.info('lights: the body module\'s lights answer at ' + at.toString(16).toUpperCase() + ': using it'); return true; }
        }
        return false;
    }

    /**
     * One give-back write per bus (NAD 0: the car's own colour) -> true when one is taken: the lights are then one
     * per bus that took it (blind), any colour on all of them at once.
     */
    async _tryBlind(why) {
        let took = [];
        // at the body module (0x40), then at the BDC's gateway address (0x10: the unit Live Data and Fault Scanner reach)
        for (const at of [this.bdc].concat(this.bdc !== 0x10 ? [0x10] : [])) {
            for (let bus = 0; bus < BUSES.length; bus++) {
                const f = releaseFrame(bus, ALL);
                let r = null;
                try { r = await this.diag.physical(at, 0x2e, f, 1500, echo(0x2e, f), { retryBaseMs: 20, maxRetries: 10 }); } catch (e) { r = null; }
                this.log.info('lights: write test at ' + at.toString(16).toUpperCase() + ' bus ' + (bus + 1) + ' (' + why + '): ' + (r ? r.map((x) => x.toString(16)).join(' ') : 'no answer'));
                if (r && r[0] === 0x6e) took.push(bus);
            }
            if (took.length) { this.bdc = at; break; }
        }
        if (!took.length) return false;
        this.lights = took.map((bus) => ({ bus, nad: ALL, loc: 0, name: 'All lights, bus ' + (bus + 1), part: 'upper', x: 0.5, y: 0.35 + 0.3 * bus,
            x2: null, y2: null, rgb: [0, 0, 0], bright: 0, fault: false, blind: true }));
        this.blind = true; this.error = null;
        this.state = this.scene ? 'ours' : 'car';
        this.log.info('lights: the body module takes writes but not the light reads: one colour on all lights (bus ' + took.map((b) => b + 1).join(', ') + ')');
        this.emit('found', this.lights.map((l) => Object.assign({}, l)));
        this.emit('change');
        this._kick();
        return true;
    }

    /** The body module's index (22 F150), once, when it first answers with lights: which names its location codes have. */
    async _kind() {
        let r = null;
        try { r = await this.diag.physical(this.bdc, 0x22, [0xf1, 0x50], 5000, echo(0x22, [0xf1, 0x50])); } catch (e) { r = null; }
        this.kind = r && r[0] === 0x62 && r.length >= 6 ? r.slice(3, 6).map((x) => (x < 16 ? '0' : '') + x.toString(16).toUpperCase()).join('') : null;
        this.log.info('lights: body module ' + (this.kind ? this.kind + (this.kind === BDC_G11 ? ' (BDC_G11: its light names)' : '') : 'index not read'));
    }

    /** Reads which lights the car has (the ones known so far stay while it reads, and when nothing answers). */
    async find(opts) {
        const force = !!(opts && opts.force);
        if (this.blind && !force) {
            this.log.info('lights: one colour on all lights (the light reads hang on this car), not read again; "Look again" reads');
            this._kick();
            return this.lights;
        }
        if (this.writeFirst && !force && !this.lights.length) {
            if (await this._tryBlind('the light reads failed before')) return this.lights;
            // no write taken either: the body module is asleep or hung, and a read now would only keep it so
            this.readFail = true;
            if (this.state !== 'none') { this.state = 'none'; this.emit('change'); }
            this.log.warn('lights: none found (writes not taken, reads left out)');
            return this.lights;
        }
        const had = this.lights;
        if (!had.length) { this.state = 'finding'; this.emit('change'); }
        const found = [], silent = [];
        let hung = 0;                  // buses whose read was busy or got no answer (what blind mode is for)
        for (let bus = 0; bus < BUSES.length; bus++) {
            const did = BUSES[bus].read;
            let reply = null;
            // "busy, ask again" (7F 22 21: a G21's body module while it drives the lights itself): asked again, a
            // little later each time, rather than taken as a no
            let pending = 0;
            const t0 = this.now();
            for (let tries = 0; ; tries++) {
                reply = null;
                try { reply = await this.diag.physical(this.bdc, 0x22, did, 15000, echo(0x22, did), { pendingTimeoutMs: 15000, onPending: () => { pending++; } }); } catch (e) { this.error = String(e && e.message || e); }
                if (!(reply && reply[0] === 0x7f && reply[2] === 0x21) || tries >= BUSY_TRIES) break;
                await this.sleep(BUSY_MS * (tries + 1));
            }
            if (reply && reply[0] === 0x62 && this.kind === undefined) await this._kind();
            const got = reply ? parseStatus(bus, reply, this.kind) : null;
            if (got) { found.push.apply(found, got); continue; }
            silent.push(bus);
            if (!reply || (reply[0] === 0x7f && (reply[2] === 0x21 || reply[2] === 0x78))) hung++;
            if (reply) this.log.info('lights: bus ' + (bus + 1) + ' refused (' + reply.map((x) => x.toString(16)).join(' ') + ')');
            else {
                // silent, or "still working" (7F 22 78) until the wait ran out: which one says what the body module does
                const how = pending ? pending + ' x "still working" (78), then nothing' : 'nothing at all';
                this.log.info('lights: bus ' + (bus + 1) + ' no answer after ' + Math.round((this.now() - t0) / 1000) + ' s: ' + how + (this.error ? ' (' + this.error + ')' : ''));
            }
        }
        // every bus silent: is the body module there at all? One read every module answers (its session, 22 F186),
        // once a start, says whether the light reads alone go unanswered or nothing reaches it (#197)
        if (!found.length && silent.length === BUSES.length && !this._probed) {
            this._probed = true;
            let r = null, err = null;
            try { r = await this.diag.physical(BDC, 0x22, [0xf1, 0x86], 5000, echo(0x22, [0xf1, 0x86])); } catch (e) { err = String(e && e.message || e); }
            this.log.info('lights: the body module itself: ' + (r ? 'answers (' + r.map((x) => x.toString(16)).join(' ') + ')'
                : 'no answer either' + (err ? ' (' + err + ')' : '')));
            // nothing at 0x40 at all: where does this car's body module answer? (#197: a G05 whose BDC shows only its
            // gateway, 0x10, and the head unit refuses 0x40.) Read-only; the lights move there only if one answers.
            if (!r && await this._findBdc()) return this.find(opts);
        }
        this.readFail = !found.length && hung === BUSES.length;
        if (this.readFail && !had.length && await this._tryBlind('the light reads failed')) return this.lights;
        if (!found.length && had.length) {
            this.log.warn('lights: no answer' + (this.error ? ': ' + this.error : '') + ', the ' + had.length + ' known kept');
            return had;
        }
        // a bus that didn't answer this time (refused, busy, the gateway taken) keeps the lights known on it (#169: a
        // refused bus 1 lost the passenger side's lights until the next start)
        const kept = had.filter((l) => silent.indexOf(l.bus) >= 0 && !found.some((f) => f.bus === l.bus && f.nad === l.nad));
        if (kept.length) {
            this.log.info('lights: bus ' + silent.map((b) => b + 1).join(', ') + ' kept its ' + kept.length + ' known');
            found.push.apply(found, kept.map((l) => Object.assign({}, l)));
        }
        // a light known already stays the same object (what it shows is kept by it)
        this.lights = found.map((f) => { const k = had.find((l) => l.bus === f.bus && l.nad === f.nad); return k ? Object.assign(k, f) : f; });
        if (found.length) this.blind = false;
        this.state = found.length ? (this.scene ? 'ours' : 'car') : 'none';
        if (found.length) {
            this.error = null;
            // (in groups of 8: a log line is cut at 300 characters)
            for (let i = 0; i < found.length; i += 8) {
                this.log.info('lights: ' + (i ? '(more) ' : found.length + ' found: ') + found.slice(i, i + 8).map((l) => l.name + (l.part === 'lower' ? ' (lower)' : '')).join(', '));
            }
            this.emit('found', found.map((l) => Object.assign({}, l)));
        } else this.log.warn('lights: none found' + (this.error ? ': ' + this.error : ''));
        this.emit('change');
        this._kick();
        return this.lights;
    }

    /** What a light shows now. */
    at(light, scene, t) {
        const now = this.now();
        if (this.carOwns(light)) return null;
        if (this._flash && now < this._flash.until) return { rgb: this._flash.rgb, bright: 100 };
        // the overlay set last wins
        const ov = this._overs ? Array.from(this._overs.values()).reverse().find((o) => o.test(light)) : null;
        if (ov) { const v = ov.at(now - ov.t0, !!this._phase); return { rgb: v.rgb, bright: Math.round(v.bright * this._dim) }; }
        const sc = scene || this.scene;
        if (!sc) return null;
        const v = S.lightAt(sc, light, t == null ? now - this.t0 : t);
        return { rgb: v.rgb, bright: Math.round(v.bright * this._dim) };
    }

    show(scene) {
        const once = S.lasts(scene);
        this.scene = scene; this.t0 = this.now(); this._frame = null;
        clearTimeout(this._onceTimer);
        // a once-only scene (welcome, pulse) runs, then its "then" (null: the car's colour), else its still colour
        if (once) {
            this._onceTimer = setTimeout(() => {
                if (this.scene !== scene) return;
                if (scene.then === null) this.carColour();
                else this.show(scene.then || Object.assign({}, scene, { kind: 'solid' }));
            }, once);
        }
        this._release = this._ownRelease();
        this._sentNow.clear();
        this._checks = S.moves(scene) ? 0 : 1; this._checkAt = 0; this._checkOff = false;
        if (this.lights.length) this.state = 'ours';
        this.emit('change');
        this._kick();
    }

    carColour() {
        clearTimeout(this._onceTimer);
        this.scene = null;
        this._frame = null;
        this._giveBack();
        if (this.lights.length) this.state = 'car';
        this.emit('change');
        this._kick();
    }

    flash(rgb, ms) {
        this._flash = { rgb, until: this.now() + (ms || 600) };
        this._frame = null;
        this._kick();
        setTimeout(() => {
            // with no colour of ours on, the lights go back to the car's
            if (!this.scene) this._giveBack();
            this._kick();
        }, (ms || 600) + 20);
    }

    /** A colour over the lights test(light) picks: at(ms since it began) -> { rgb, bright }; test null: taken off. */
    overlay(key, test, at) {
        if (!this._overs) this._overs = new Map();
        if (!test) {
            if (!this._overs.delete(key)) return;
            // with no colour of ours on, those lights go back to the car's
            if (!this.scene && !this._overs.size) this._giveBack();
        } else {
            this._overs.delete(key);
            this._overs.set(key, { test, at, t0: this.now() });
        }
        this._frame = null;
        this._kick();
    }

    /**
     * carOwn(key, test): the lights test(light) picks are the car's meanwhile (the body module's own open-door warning
     * runs on them): no colour of ours, and given back now, so the car's shows at once. test null: ours again.
     */
    carOwn(key, test) {
        if (!test) { if (!this._own.delete(key)) return; }
        else this._own.set(key, test);
        this._release = this._release.filter((r) => !r.light).concat(this._ownRelease());
        this._frame = null;
        this._kick();
    }
    carOwns(light) { for (const t of this._own.values()) if (t(light)) return true; return false; }
    // a give-back for each car-owned light that still has a colour of ours
    _ownRelease() { return this._own.size ? this.lights.filter((l) => this._last.has(l) && this.carOwns(l)).map((l) => ({ light: l })) : []; }

    dim(f) { if (f !== this._dim) { this._dim = f; this._frame = null; this._kick(); } }
    /** The lights' colours worked out again (a light changed zone: setting decorWith). */
    redraw() { this._frame = null; this._kick(); }
    /**
     * A one-off write to the body module (2E <data>), sent in turn with the lights' writes (the gateway takes one at a
     * time) -> its reply, or null (no answer, or the lights not writing: none found, held, stopped).
     */
    command(data) {
        if (this._stopped || this._holds.size || !this.lights.length) return Promise.resolve(null);
        return new Promise((res) => { this._cmds.push({ data, res }); this._kick(); });
    }

    stop() { this._stopped = true; clearTimeout(this._timer); clearTimeout(this._onceTimer); this._cmds.splice(0).forEach((c) => c.res(null)); }

    /** Every bus with a light of ours on it given back (one write each), then once more. */
    _giveBack() {
        const buses = [];
        this.lights.forEach((l) => { if (this._last.has(l) && buses.indexOf(l.bus) < 0) buses.push(l.bus); });
        this._release = buses.map((bus) => ({ bus }));
        this._gave = [];
        this._checks = buses.length ? 1 : 0; this._checkAt = 0; this._checkOff = true;
    }

    /**
     * The next write: something to give back, else the next of the frame. Every scene goes frame by frame: every light
     * the colour of the same moment (the frame's), front to back; then the next frame from the time it is then. Lights
     * that show that colour already (and are not due for their renewal) are skipped.
     */
    _next() {
        if (this._release.length) {
            const r = this._release.shift();
            return r.light ? { r, lights: [r.light], frame: releaseFrame(r.light.bus, r.light.nad), off: true }
                : { r, lights: this.lights.filter((l) => l.bus === r.bus), frame: releaseFrame(r.bus, ALL), off: true };
        }
        const now = this.now(), flashing = !!(this._flash && now < this._flash.until + 50), over = !!(this._overs && this._overs.size);
        if (!this.scene && !flashing && !over) return null;
        const moving = S.moves(this.scene) || flashing || over, renew = moving ? MOVE_RENEW_MS : RENEW_MS, hold = moving ? MOVE_HOLD_S : HOLD_S;
        for (let tries = 0; tries < 2; tries++) {
            if (!this._frame || !this._frame.todo.length) {
                if (this._frame && this._frame.wrote) this._frames.push(now);
                this._phase = !this._phase;             // (overlays that blink: on one frame, off the next)
                this._frame = { t: now - this.t0, todo: this._plan(now - this.t0), wrote: false };
            }
            while (this._frame.todo.length) {
                const it = this._frame.todo.shift();
                // renewed in time for its hold, which may be a shorter one than now's (#197: a blink's writes hold 5 s,
                // and the still colour after it was renewed only after 40 s: the car's own colour in between)
                const due = it.need.some((l) => { const had = this._last.get(l); return !same(it.want, had) || now - had.at > Math.min(renew, had.hold * 1000 - 2000); });
                if (!due) continue;
                this._frame.wrote = true;
                return { lights: it.lights, want: it.want, hold, frame: writeFrame(it.lights[0].bus, it.nad, it.want.rgb, it.want.bright, hold) };
            }
        }
        return null;
    }

    /**
     * One frame's writes: for each bus the colour most of its lights want, as one write to all of them (NAD 0), then
     * a write for each light that wants another. [{ lights (written), need (the lights it is for), want, nad }]
     */
    _plan(t) {
        const items = [];
        for (let bus = 0; bus < BUSES.length; bus++) {
            // (no scene: only the lights an overlay or a flash colours; the others keep the car's own colour)
            const all = this.lights.filter((l) => l.bus === bus).sort((a, b) => a.y - b.y);
            const at = all.map((l) => this.at(l, null, t)), on = all.filter((l, i) => at[i]), wants = at.filter((w) => w);
            if (!on.length) continue;
            const key = (w) => w.rgb.join() + '/' + w.bright, count = {};
            wants.forEach((w) => { count[key(w)] = (count[key(w)] || 0) + 1; });
            const top = Object.keys(count).sort((a, b) => count[b] - count[a])[0];
            // (NAD 0 reaches every light of the bus: only when all of them take a colour of ours)
            const most = on.length === all.length && count[top] > 1 ? wants.find((w) => key(w) === top) : null;
            if (most) items.push({ lights: on, need: on.filter((l, i) => key(wants[i]) === top), want: most, nad: ALL });
            on.forEach((l, i) => { if (!most || key(wants[i]) !== top) items.push({ lights: [l], need: [l], want: wants[i], nad: l.nad }); });
        }
        return items;
    }

    /** A still colour's writes once more (a light that missed one takes it now), or the give-back once more. */
    _again() {
        if (this._checkOff) { this._gave.forEach((bus) => this._release.push({ bus, again: true })); this._gave = []; }
        else this._sentNow.forEach((l) => this._last.delete(l));
        this._sentNow.clear();
        this._frame = null;
    }

    /**
     * hold(key, true): no more writes or read-backs until every key has let go; resolves once the one under way (if
     * any) is done, or after HOLD_WAIT_MS. hold(key, false): the writing goes on (a moving scene's colours are
     * renewed, as their hold ran out meanwhile).
     */
    hold(key, on) {
        if (!on) {
            if (this._holds.delete(key) && !this._holds.size) { this.log.info('lights: writing again (' + key + ' done)'); this._kick(); }
            return Promise.resolve();
        }
        if (!this._holds.size) this.log.info('lights: holding the writes (' + key + ')');
        this._holds.add(key);
        clearTimeout(this._timer); this._timer = null;
        if (!this._running) return Promise.resolve();
        return new Promise((res) => {
            const t = setTimeout(res, HOLD_WAIT_MS);
            this._idle.push(() => { clearTimeout(t); res(); });
        });
    }

    get held() { return this._holds.size > 0; }

    _kick() {
        if (this._running || this._stopped || this._holds.size || !this.lights.length) return;
        clearTimeout(this._timer); this._timer = null;
        this._run().catch((e) => this.log.warn('lights: ' + e));
    }

    async _run() {
        this._running = true;
        try {
            for (;;) {
                if (this._stopped || this._holds.size) return;
                const wait = this._pauseTill - this.now();
                if (wait > 0) { this._timer = setTimeout(() => this._kick(), wait); return; }
                if (this._cmds.length) {
                    const c = this._cmds.shift();
                    let r = null;
                    try { r = await this.diag.physical(this.bdc, 0x2e, c.data, 1500, echo(0x2e, c.data), { retryBaseMs: 20, maxRetries: 10 }); } catch (e) { r = null; }
                    c.res(r);
                    continue;
                }
                if (this._checkAt && this.now() >= this._checkAt && !this._release.length) { this._checkAt = 0; this._again(); continue; }
                const w = this._next();
                if (!w) {
                    // all written: a still colour (or giving back) sent once more a little later
                    if (this._checks > 0 && !this._checkAt) { this._checks--; this._checkAt = this.now() + (this.checkMs || AGAIN_MS); }
                    // nothing due: a moving scene looks again soon, a still one when its next renewal is due
                    const moving = S.moves(this.scene) || !!(this._flash && this.now() < this._flash.until);
                    const next = this._checkAt ? Math.max(20, this._checkAt - this.now()) : moving ? 40 : 1000;
                    if (this.scene || moving || this._checkAt) this._timer = setTimeout(() => this._kick(), next);
                    return;
                }
                let reply = null;
                // one write at a time (the gateway takes no second); a busy gateway is asked again soon, not after 1 s
                try { reply = await this.diag.physical(this.bdc, 0x2e, w.frame, 1500, echo(0x2e, w.frame), { retryBaseMs: 20, maxRetries: 10 }); } catch (e) { this.error = String(e && e.message || e); }
                if (reply && reply[0] === 0x6e) {
                    this._fails = 0; this.writes++; this._times.push(this.now());
                    // (a bus given back: once more later; one not taken is not)
                    if (w.off && w.r.bus !== undefined && !w.r.again && this._gave.indexOf(w.r.bus) < 0) this._gave.push(w.r.bus);
                    w.lights.forEach((l) => {
                        if (w.off) { this._last.delete(l); return; }
                        this._last.set(l, { rgb: w.want.rgb, bright: w.want.bright, at: this.now(), hold: w.hold });
                        this._sentNow.add(l);
                    });
                    if (this.error) { this.error = null; this.emit('change'); }
                } else {
                    // a give-back not taken: tried RELEASE_TRIES times, then left (the light's colour runs out by itself
                    // within its hold), so a body module that has gone to sleep is not asked again and again
                    if (w.off && (w.r.tries || 0) + 1 < RELEASE_TRIES) this._release.push(Object.assign({}, w.r, { tries: (w.r.tries || 0) + 1 }));
                    this.error = reply ? 'the body module refused (' + (reply[2] || 0).toString(16) + ')' : this.error || 'no answer from the body module';
                    if (++this._fails >= FAILS) {
                        this.log.warn('lights: ' + this.error + ', pausing');
                        this._fails = 0; this._pauseTill = this.now() + PAUSE_MS;
                        this._last.clear();
                        this.emit('change');
                    }
                }
            }
        } finally {
            this._running = false;
            const idle = this._idle; this._idle = [];
            idle.forEach((f) => f());
        }
    }
}

module.exports = { Lights, HOLD_S, RENEW_MS, MOVE_HOLD_S };
