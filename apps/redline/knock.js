'use strict';
/**
 * Part of Redline's experimental features; README.md in this folder has the whole picture.
 *
 * Knock, for the HUD's knock warning and readout: the engine unit (DME, 0x12) over read-only UDS 22, the
 * same values Live Data shows (apps/live_data/useful.js, "Ignition and knock"):
 *   554C  knock control's ignition retard, the mean of the cylinders' (s8 x 0.375 degrees crank angle)
 *   4A36  knock detected (u8, 0 = no)
 * Read twice a second while wanted (the HUD shows and the engine runs), on the gearbox reader's link.
 * An event: the retard reaching WARN_DEG, or the flag set. Never throws; value() is
 *   { retard (degrees or null), at (ms of the last event or 0) }.
 * The thresholds are from the catalogue's scaling, not yet checked on a car.
 * A V8 with two engine units (opts.twin, kit/twin_dme.js): each unit's knock control is its own bank's, so
 * the second unit (0x13) is read too: the larger retard of the two banks, and a knock flag from either.
 */
const { DidReader } = require('./kit/dids');

const RETARD = [{ ecu: 0x12, did: '554C', bytes: 1, at: 0, signed: true, factor: 0.375, offset: 0, min: -48, max: 48 }];
const FLAG = [{ ecu: 0x12, did: '4A36', bytes: 1, at: 0, factor: 1, offset: 0, min: 0, max: 255 }];
// the same from bank 2's engine unit (two-unit engines only), with a short wait: one that doesn't answer mustn't hold
// up bank 1's reading (twice a second, stale after 3 s) or the gearbox reads on the same link
const SLAVE_MS = 600;
const RETARD2 = RETARD.map((c) => Object.assign({}, c, { ecu: 0x13, timeoutMs: SLAVE_MS }));
const FLAG2 = FLAG.map((c) => Object.assign({}, c, { ecu: 0x13, timeoutMs: SLAVE_MS }));
const POLL_MS = 500, STALE_MS = 3000, FAIL_RETRY_MS = 60000;
const WARN_DEG = 2.25;            // 6 steps of 0.375: well past the odd single correction

class KnockWatch {
    /** linkOf: () => a ReadOnlyDiag (the gearbox reader's, shared). opts: { twin: a kit/twin_dme.js TwinDme } */
    constructor(ctx, linkOf, opts) {
        this.ctx = ctx; this.log = ctx.log; this.linkOf = linkOf;
        this.twin = (opts && opts.twin) || null; this.logged2 = false;
        this.rd = null; this.timer = null; this.busy = false;
        this.retard = null; this.t = 0; this.triedT = 0; this.fails = 0; this.at = 0; this.logged = false;
    }

    start() {
        if (this.timer) return;
        try {
            if (!this.rd) this.rd = new DidReader(this.linkOf(), { ecu: 0x12 });
            this._wake();             // a new start (the engine on again): asked even if the link gave up on it
            this.timer = setInterval(() => this._poll(), POLL_MS);
            this._poll();
        } catch (e) { this.log.warn('knock: ' + (e && e.message || e)); }
    }

    stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

    /** The link stops asking a unit after 5 misses in a row (other readers count too) until it is woken. */
    _wake() {
        const l = this.rd && this.rd.diag;
        if (l && typeof l.wake === 'function') { try { l.wake(0x12); if (this._twinOn()) l.wake(0x13); } catch (e) { /* never */ } }
    }

    /** Two engine units (asks once, in the background, while not known)? */
    _twinOn() { return !!this.twin && this.twin.on(); }

    _poll() {
        if (this.busy || !this.rd) return;
        // the shared link not up yet: not a failed read (it would count towards "no knock retard" and the back-off)
        const link = this.rd.diag;
        if (link && (link.ready === false || link.available === false)) return;
        if (this.fails >= 3) {
            if (Date.now() - this.triedT < FAIL_RETRY_MS) return;     // not answering: once a minute,
            this._wake();                                               // and that try really asks it
        }
        // bank 2's unit skipped by the link after misses in a row: asked again once a minute
        if (this._twinOn() && Date.now() - (this.wake2T || 0) > FAIL_RETRY_MS && link && typeof link.wake === 'function') {
            this.wake2T = Date.now();
            try { link.wake(0x13); } catch (e) { /* never */ }
        }
        this.busy = true;
        const now = () => Date.now();
        Promise.resolve().then(() => this.rd.value('knock', RETARD)).then((v) => {
            this.triedT = now();
            if (v === null) {
                if (++this.fails === 3) this.log.info('knock: the engine unit gives no knock retard (554C); no knock warning on this car');
                return null;
            }
            if (!this.logged) { this.logged = true; this.log.info('knock: retard read from the engine unit (554C), ' + v + ' deg'); }
            if (!this._twinOn()) return [v, null];
            // bank 2's unit: the larger retard counts; no answer from it = bank 1's alone this time
            return this.rd.value('knock2', RETARD2).then((v2) => [v, v2]);
        }).then((vs) => {
            if (!vs) return null;
            const v = vs[0], v2 = vs[1];
            if (v2 !== null && !this.logged2) { this.logged2 = true; this.log.info('knock: bank 2 retard read from the second engine unit (0x13 554C), ' + v2 + ' deg'); }
            const r = v2 !== null && v2 > v ? v2 : v;
            this.fails = 0; this.retard = r; this.t = this.triedT;
            if (r >= WARN_DEG) this._event('retard ' + r.toFixed(1) + ' deg' + (r === v2 && v2 !== v ? ' (bank 2)' : ''));
            // bank 2's flag only from a second unit that answered this round
            return this.rd.value('knockflag', FLAG).then((f) => (f || v2 === null ? [f, null] : this.rd.value('knockflag2', FLAG2).then((f2) => [f, f2])));
        }).then((fs) => {
            if (!fs) return;
            if (fs[0]) this._event('knock detected (4A36 = ' + fs[0] + ')');
            else if (fs[1]) this._event('knock detected on bank 2 (0x13 4A36 = ' + fs[1] + ')');
        })
            .catch((e) => { this.triedT = now(); this.fails++; this.log.warn('knock: ' + (e && e.message || e)); })
            .then(() => { this.busy = false; });
    }

    _event(why) {
        const now = Date.now();
        // logged at most every 10 s (a knocking engine reports it on every read)
        if (now - this.at > 10000) this.log.info('knock: ' + why);
        this.at = now;
    }

    value() {
        const fresh = this.retard !== null && Date.now() - this.t < STALE_MS;
        return { retard: fresh ? this.retard : null, at: this.at };
    }
}

module.exports = KnockWatch;
