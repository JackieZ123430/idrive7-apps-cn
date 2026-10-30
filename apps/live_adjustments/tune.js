'use strict';
/**
 * tune.js - the live adjustments a TUNED DME offers: engine map switching (maps 1-4),
 * Max Cooling and burbles. They are not BMW jobs. Everything here runs only while the
 * "Tune functions" setting is Armed (Disarmed, the default, sends nothing at all). The
 * screen never names the tune; the log does.
 *
 *   BM3: bm3_protocol.js / bm3_profiles.js, copied from the vendor's bm3_live app - the
 *     CustomROM is identified by its marker, the map and burbles are written to the DME's
 *     memory and confirmed by reading them back.
 *   MHD (captures by a1-mapping on PR #23; map switch confirmed on the owner's MG1,
 *     2026-10-30 - the engine note changed), DME 0x12:
 *     map switch : 2F 01 <map - 1>   -> 6F 01 <map - 1>   map 1..4 = 00..03
 *     max cooling: 2F 03 01 | 00     -> 6F 03 01 | 00     on | off
 *     MHD's marker sits at a ROM-dependent address (0x807FF750 on a1-mapping's DME_86T0;
 *     the owner's DME answered 7F 23 72 there), so it is NOT detected by a memory read:
 *     when no BM3 ROM is found, the map / cooling tabs are offered and a press counts only
 *     when the DME echoes the request back. An untuned DME refuses it ("Not available").
 *     No read-back of the active map is known.
 *
 * Burbles are BM3 only; Max Cooling is offered when no BM3 ROM is found.
 */
const { Bm3Protocol } = require('./bm3_protocol');
const bm3Profiles = require('./bm3_profiles');

class TuneControl {
    constructor(ctx) {
        this.ctx = ctx;
        this.log = ctx.log;
        this.link = null;
        this.bm3 = null;
        this._reset();
        this.targetAgg = 1.5;        // burble aggression picked with -/+ (sent on Apply)
    }

    _reset() {
        this.kind = null;            // 'bm3' | 'echo' (MHD-style, validated per press) | null
        this.map = null;             // 1..4, the map last confirmed (bm3) or accepted (mhd)
        this.mapConfirmed = false;   // true = read back from the DME
        this.cooling = null;         // 'ON' | 'OFF' | null (accepted by the DME)
        this.burbles = null;         // DME state: 'off' | 'custom' | '4.5' | null (unknown)
        this.busy = false;
        this.note = null;            // the status line under the page
        this.noteType = 'dim';       // dim | go | warn
    }

    get armed() { return this.ctx.settings.get('tune') === 'on'; }

    /** Which pages this car gets (Armed and the diagnostic link up only). */
    features() {
        return { map: !!this.kind, cooling: this.kind === 'echo', burbles: this.kind === 'bm3' };
    }

    async start(link) {
        this.link = link;
        if (link && link.diag) this.bm3 = new Bm3Protocol(link.diag, bm3Profiles, this.ctx.spec.config || {});
        await this.refresh();
    }

    /** Look for a BM3 ROM again (Armed only). Disarmed: nothing is sent, no page offered. */
    async refresh() {
        const target = this.targetAgg;
        this._reset();
        this.targetAgg = target;
        if (!this.armed || !this.link || !this.link.available) return;
        // BM3: its CustomROM marker, matched against the known ROM profiles.
        if (this.bm3) {
            try {
                await this.bm3.identify();
                this.kind = 'bm3';
                this.map = (await this.bm3.currentMap()) + 1;
                this.mapConfirmed = true;
                await this._readBurbles();
            } catch (e) { this.log.info('tune detect (BM3): ' + String(e && e.message || e)); }
        }
        // Otherwise the MHD-style commands, each one validated by the DME's echo.
        if (!this.kind) this.kind = 'echo';
        this.log.info('tune: ' + (this.kind === 'bm3' ? 'bm3 detected (ROM ' + this.bm3.rom + ')'
            : 'no BM3 ROM - map / cooling offered, each press validated by the DME echo'));
        if (this.kind === 'bm3') { this.note = 'Map ' + this.map + ' active'; this.noteType = 'go'; }
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

    /** The one place a command leaves: armed, a tune detected, and nothing else running. */
    async _run(label, fn) {
        if (this.busy) return;
        if (!this.armed || !this.kind) { this.note = 'Not available on this car'; this.noteType = 'warn'; return; }
        this.busy = true;
        this.note = 'Sending ' + label + '…'; this.noteType = 'dim';
        try {
            this.note = await fn();
            this.noteType = 'go';
        } catch (e) {
            this.note = String(e && e.message || e);
            this.noteType = 'warn';
            this.log.warn('tune ' + label + ': ' + this.note);
        } finally {
            this.busy = false;
        }
    }

    /** Map 1..4: one press switches (no confirm step, the user's choice). */
    setMap(n) {
        return this._run('map ' + n, async () => {
            if (this.kind === 'bm3') {
                if (!this.bm3.profile) await this.bm3.identify();
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

    setCooling(on) {
        return this._run('cooling ' + (on ? 'on' : 'off'), async () => {
            if (this.kind !== 'echo') throw new Error('Not available on this car');
            const req = [0x03, on ? 0x01 : 0x00];
            this._expectEcho(await this.link.sendToDme(0x2F, req), req);
            this.cooling = on ? 'ON' : 'OFF';
            return 'Max Cooling ' + this.cooling.toLowerCase() + ' · accepted by the DME';
        });
    }

    /** -/+ only pick the aggression on screen; nothing is sent until Apply (as bm3_live). */
    stepAggression(delta) {
        this.targetAgg = Math.max(0, Math.min(12, this.targetAgg + delta));
        this.note = 'Aggression ' + this.targetAgg.toFixed(1) + ' selected · press Apply to send';
        this.noteType = 'dim';
    }

    /** Apply the picked aggression, or turn the override off (off = true). */
    applyBurbles(off) {
        return this._run(off ? 'burbles off' : 'burbles ' + this.targetAgg.toFixed(1), async () => {
            if (this.kind !== 'bm3') throw new Error('Not available on this car');
            if (!this.bm3.profile) await this.bm3.identify();
            const v = await this.bm3.setBurbles(off ? null : this.targetAgg);
            this.burbles = v === null ? 'off' : v.toFixed(1);
            return 'Burbles ' + (v === null ? 'off' : v.toFixed(1)) + ' · confirmed by the DME';
        });
    }

    /** The MHD-style press counts only when the DME echoes it; an untuned DME refuses it. */
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
            features: this.features(),
            map: this.map,
            mapConfirmed: this.mapConfirmed,
            readback: this.kind === 'bm3',   // MHD-style: no read-back of the active map
            cooling: this.cooling,
            burbles: this.burbles,
            targetAgg: this.targetAgg,
            busy: this.busy,
            note: this.note,
            noteType: this.noteType,
        };
    }
}

module.exports = { TuneControl };
