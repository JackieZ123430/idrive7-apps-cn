'use strict';
/**
 * tune.js - the live adjustments a TUNED DME offers. The "Tuning software" setting says which
 * tune the car runs, and the tabs follow it:
 *
 *   Off (default)  nothing is sent at all and no tune tab is offered
 *   BM3            Engine Map, Burbles, Active Sound (ASD)
 *   MHD            Engine Map, Max Cooling
 *
 * Other tuning software: add a choice to "tuner" in app.json, its features in FEATURES and
 * its commands below (the community is welcome to: see the README).
 *
 *   BM3 (bm3_protocol.js / bm3_profiles.js, formerly the separate BM3 Live app): the
 *     CustomROM is identified by its marker and must match a known ROM; the map and burbles
 *     are written to the DME's memory and confirmed by reading them back. Unknown ROMs are
 *     rejected. ASD: 2E 5FFD 00 (on) | 01 (off), no read-back.
 *   MHD (captures by a1-mapping on PR #23; map switch confirmed on the owner's MG1,
 *     2026-10-30 - the engine note changed), DME 0x12:
 *     map switch : 2F 01 <map - 1>   -> 6F 01 <map - 1>   map 1..4 = 00..03
 *     max cooling: 2F 03 01 | 00     -> 6F 03 01 | 00     on | off
 *       ON is sent only with the engine running: live engine speed over MIN_COOLING_RPM
 *       (CDS statusEngineSpeed2; demo data never counts). OFF is always allowed.
 *     MHD's marker sits at a ROM-dependent address, so it is not read: a press counts only
 *     when the DME echoes the request back. No read-back of the active map is known.
 */
const { Bm3Protocol } = require('./bm3_protocol');
const bm3Profiles = require('./bm3_profiles');

const TUNERS = ['off', 'bm3', 'mhd'];
const MIN_COOLING_RPM = 500;     // Max Cooling: the engine must be running
const FEATURES = {
    off: { map: false, cooling: false, burbles: false, asd: false },
    bm3: { map: true, cooling: false, burbles: true, asd: true },
    mhd: { map: true, cooling: true, burbles: false, asd: false },
};

class TuneControl {
    /** engine (optional): { rpm() -> live engine speed, or null when unknown / not live } */
    constructor(ctx, engine) {
        this.ctx = ctx;
        this.engine = engine || { rpm: () => null };
        this.log = ctx.log;
        this.link = null;
        this.bm3 = null;
        this._ops = 0;               // commands and refreshes queued or running (busy while any)
        this._queue = Promise.resolve();
        this._refreshing = null;     // a refresh queued but not started yet
        this._refreshRuns = false;   // a refresh running
        this._waitNote = false;      // pressed during a refresh: the page says why nothing happened, until it ends
        this._reset();
        this.targetAgg = 1.5;        // burble aggression picked with -/+ (sent on Apply)
    }

    _reset() {
        this.verified = false;       // BM3: the ROM marker matched a known profile
        this.map = null;             // 1..4, the map last confirmed (bm3) or accepted (mhd)
        this.mapConfirmed = false;   // true = read back from the DME
        this.cooling = null;         // 'ON' | 'OFF' | null (accepted by the DME)
        this.burbles = null;         // DME state: 'off' | 'custom' | '4.5' | null (unknown)
        this.asd = null;             // true | false | null (last accepted)
        this.note = null;            // the status line under the page
        this.noteType = 'dim';       // dim | go | warn
    }

    /** The tune the owner picked in Settings; anything unknown counts as Off. */
    get tuner() {
        const v = this.ctx.settings.get('tuner');
        return TUNERS.indexOf(v) >= 0 ? v : 'off';
    }
    get armed() { return this.tuner !== 'off'; }
    get busy() { return this._ops > 0; }

    /** Which pages this car gets: the picked tune's. */
    features() { return Object.assign({}, FEATURES[this.tuner]); }

    async start(link) {
        this.link = link;
        if (link && link.diag) this.bm3 = new Bm3Protocol(link.diag, bm3Profiles, this.ctx.spec.config || {});
        await this.refresh();
    }

    /** One DME conversation at a time: a refresh waits for the command in flight and the other way
     * round (BM3's 0x63 replies carry no address, so two reads in flight could swap answers). */
    _serial(fn) {
        this._ops++;
        const done = () => { this._ops--; };
        const p = this._queue.then(fn).then((v) => { done(); return v; }, (e) => { done(); throw e; });   // (no Promise.finally on the car's Node 8)
        this._queue = p.catch(() => {});
        return p;
    }

    /** The tune changed or the diagnostic link came up: start over. BM3 is identified (memory
     * reads only); MHD has nothing to identify; Off sends nothing. A refresh already waiting
     * reads the settings when it starts, so a second one joins it. */
    refresh() {
        if (!this._refreshing) {
            this._refreshing = this._serial(() => {
                this._refreshing = null; this._refreshRuns = true;
                const end = () => { this._refreshRuns = this._waitNote = false; };
                return this._refresh().then((v) => { end(); return v; }, (e) => { end(); throw e; });
            });
        }
        return this._refreshing;
    }

    async _refresh() {
        const target = this.targetAgg;
        this._reset();
        this.targetAgg = target;
        if (!this.armed) return;
        if (!this.link || !this.link.available) { this.note = 'Waiting for the diagnostic link'; this.noteType = 'warn'; return; }
        if (this.tuner === 'bm3') {
            try {
                await this._identifyBm3();
                this.map = (await this.bm3.currentMap()) + 1;
                this.mapConfirmed = true;
                await this._readBurbles();
                this.note = 'BM3 ROM ' + this.bm3.rom + ' · map ' + this.map + ' active';
                this.noteType = 'go';
            } catch (e) {
                this.note = 'BM3: ' + String(e && e.message || e);
                this.noteType = 'warn';
                this.log.info('tune detect (BM3): ' + this.note);
            }
        }
        this.log.info('tune: ' + this.tuner + (this.verified ? ' (ROM ' + this.bm3.rom + ')' : ''));
    }

    async _identifyBm3() {
        if (!this.bm3) throw new Error('no diagnostic link');
        if (!this.verified) { await this.bm3.identify(); this.verified = true; }
    }

    async _readBurbles() {
        try {
            const s = await this.bm3.readBurbles();
            this.burbles = !s.enabled ? 'off' : s.aggression === null ? 'custom' : s.aggression.toFixed(1);
            if (s.enabled && s.aggression !== null && s.aggression <= 12) this.targetAgg = s.aggression;
        } catch (e) {
            this.burbles = null;
            this.log.warn('burble readback: ' + String(e && e.message || e));
        }
    }

    /** The one place a command leaves: a tune picked, the feature is that tune's, the link is up
     * and nothing else is running. */
    async _run(feature, label, fn) {
        // one at a time: a press while a command runs is not sent (its note says so); during a refresh, say why
        if (this.busy) { if (this._refreshing || this._refreshRuns) this._waitNote = true; return; }
        if (!this.armed || !FEATURES[this.tuner][feature]) { this.note = 'Not available for this tune'; this.noteType = 'warn'; return; }
        if (!this.link || !this.link.available) { this.note = 'Waiting for the diagnostic link'; this.noteType = 'warn'; return; }
        this.note = 'Sending ' + label + '…'; this.noteType = 'dim';
        return this._serial(async () => {
            try {
                this.note = await fn();
                this.noteType = 'go';
            } catch (e) {
                this.note = String(e && e.message || e);
                this.noteType = 'warn';
                this.log.warn('tune ' + label + ': ' + this.note);
            }
        });
    }

    /** Map 1..4: one press switches (no confirm step, the user's choice). */
    setMap(n) {
        return this._run('map', 'map ' + n, async () => {
            if (this.tuner === 'bm3') {
                await this._identifyBm3();
                this.map = (await this.bm3.setMap(n - 1)) + 1;
                this.mapConfirmed = true;
                return 'Map ' + this.map + ' · confirmed by the DME';
            }
            const req = [0x01, n - 1];
            this._expectEcho(await this.link.sendToDme(0x2F, req), req);
            this.map = n;
            this.mapConfirmed = false;
            return 'Map ' + n + ' · accepted by the DME';
        });
    }

    /** Live engine speed, or null (no live value: unknown, or demo data). */
    rpm() {
        const r = this.engine.rpm();
        return typeof r === 'number' && isFinite(r) ? r : null;
    }
    engineRunning() { const r = this.rpm(); return r !== null && r > MIN_COOLING_RPM; }

    setCooling(on) {
        if (on && this.armed && FEATURES[this.tuner].cooling && !this.busy && !this.engineRunning()) {
            this.note = 'Start the engine first · Max Cooling needs over ' + MIN_COOLING_RPM + ' rpm';
            this.noteType = 'warn';
            return Promise.resolve();
        }
        return this._run('cooling', 'cooling ' + (on ? 'on' : 'off'), async () => {
            const req = [0x03, on ? 0x01 : 0x00];
            this._expectEcho(await this.link.sendToDme(0x2F, req), req);
            this.cooling = on ? 'ON' : 'OFF';
            return 'Max Cooling ' + this.cooling.toLowerCase() + ' · accepted by the DME';
        });
    }

    /** -/+ only pick the aggression on screen; nothing is sent until Apply. */
    stepAggression(delta) {
        this.targetAgg = Math.max(0, Math.min(12, this.targetAgg + delta));
        this.note = 'Aggression ' + this.targetAgg.toFixed(1) + ' selected · press Apply to send';
        this.noteType = 'dim';
    }

    /** Apply the picked aggression, or turn the override off (off = true). */
    applyBurbles(off) {
        return this._run('burbles', off ? 'burbles off' : 'burbles ' + this.targetAgg.toFixed(1), async () => {
            await this._identifyBm3();
            const v = await this.bm3.setBurbles(off ? null : this.targetAgg);
            this.burbles = v === null ? 'off' : v.toFixed(1);
            return 'Burbles ' + (v === null ? 'off' : v.toFixed(1)) + ' · confirmed by the DME';
        });
    }

    /** Active Sound Design on / off (the DME accepts it; its state is not reported back). */
    setAsd(on) {
        return this._run('asd', 'ASD ' + (on ? 'on' : 'off'), async () => {
            this.asd = await this.bm3.setAsd(on);
            return 'ASD ' + (this.asd ? 'on' : 'off') + ' · accepted by the DME';
        });
    }

    /** The MHD press counts only when the DME echoes it; an untuned DME refuses it. */
    _expectEcho(r, req) {
        const echoed = !!(r && r.ok && r.sid === 0x6F && r.data && r.data.length >= req.length
            && req.every((b, i) => r.data[i] === b));
        if (echoed) return;
        if (r && r.nrc != null) {
            this.log.info('tune: DME refused 2F ' + req.map((b) => b.toString(16).padStart(2, '0')).join(' ') + ' (' + r.reason + ')');
            throw new Error('Not available on this car');
        }
        throw new Error('No answer from the DME');
    }

    view() {
        return {
            armed: this.armed,
            tuner: this.tuner,
            features: this.features(),
            map: this.map,
            mapConfirmed: this.mapConfirmed,
            readback: this.tuner === 'bm3',   // MHD: no read-back of the active map
            cooling: this.cooling,
            burbles: this.burbles,
            asd: this.asd,
            rpm: this.rpm(),
            minCoolingRpm: MIN_COOLING_RPM,
            targetAgg: this.targetAgg,
            busy: this.busy,
            note: this._waitNote ? 'Reading the DME - press again in a moment' : this.note,
            noteType: this._waitNote ? 'warn' : this.noteType,
        };
    }
}

module.exports = { TuneControl, TUNERS, FEATURES, MIN_COOLING_RPM };
