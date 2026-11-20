'use strict';
/**
 * gearbox.js - the gearbox oil temperature for Warm-Up (issue #164), from the first source that has it:
 *
 *   1. the gearbox unit (EGS, 0x18), read only (kit/readonly-diag): 22 6000 (ZF 8HP, deg C + 40, read on a G22),
 *      else 22 DA12 (deg C + 48, not confirmed on a car: only once it has moved)
 *   2. the car's BasicDataSet signal, valueTemperatureTransmissionOil (deg C + 48, 255 = none): only once it has
 *      moved, as some cars leave it at one number
 *
 *   const gb = new Gearbox(ctx, log, () => visible).start();
 *   gb.temp()     deg C, or null (no source has it)
 *   gb.source()   'EGS' | 'signal' | null
 *
 * The unit is asked every POLL_MS while the screen shows (visible()), and not at all once it said it has neither
 * identifier; a unit that doesn't answer is asked every SLOW_MS.
 */
const { ReadOnlyDiag } = require('./kit/readonly-diag');

const EGS = 0x18, POLL_MS = 5000, SLOW_MS = 30000, FRESH_MS = 20000;
const DIDS = [{ did: 0x6000, offset: -40, sure: true }, { did: 0xDA12, offset: -48, sure: false }];
const ABSENT = [0x11, 0x12, 0x31];         // NRCs that mean "this unit has no such identifier"
const MIN = -40, MAX = 160, MOVE = 1;

/** A value that counts only once it has moved by MOVE from the first one seen. */
class Moving {
    constructor(sure) { this.sure = !!sure; this.first = null; this.moved = this.sure; this.v = null; this.at = 0; }
    put(v, now) {
        if (typeof v !== 'number' || !isFinite(v) || v < MIN || v > MAX) return;
        if (this.first === null) this.first = v;
        if (Math.abs(v - this.first) >= MOVE) this.moved = true;
        this.v = v; this.at = now;
    }
    get(now) { return this.moved && this.v !== null && now - this.at < FRESH_MS ? this.v : null; }
}

class Gearbox {
    constructor(ctx, log, visible) {
        this.ctx = ctx; this.log = log; this.visible = visible || (() => true);
        this.egs = DIDS.map((d) => Object.assign({ gone: false, val: new Moving(d.sure) }, d));
        this.sig = new Moving(false);
        this.silent = 0; this.timer = null; this.link = null; this.logged = {};
    }

    start() {
        const signals = this.ctx.signals;
        if (signals && signals.watch) {
            signals.watch('de.bmw.infrastructure.analytics.BasicDataSet', '1', {
                basicDataSet: (v) => {
                    const raw = v && v.valueTemperatureTransmissionOil;
                    if (typeof raw === 'number' && raw !== 255) this.sig.put(raw - 48, Date.now());
                    this._once('signal', 'gearbox: BasicDataSet oil ' + raw);
                },
            }, this.log).then((s) => this.log.info('gearbox: signal ' + (s && s.error ? 'error: ' + s.error : 'subscribed')))
                .catch((e) => this.log.warn('gearbox: signal: ' + (e && e.message || e)));
        }
        this.link = new ReadOnlyDiag(signals, this.log);
        this.link.init().then(() => { if (this.link.ready) this._next(1000); else this.log.info('gearbox: no diagnostic link'); })
            .catch((e) => this.log.warn('gearbox: diagnostic link: ' + (e && e.message || e)));
        return this;
    }

    stop() { this.stopped = true; clearTimeout(this.timer); this.timer = null; }

    temp() { const s = this._pick(); return s ? s.v : null; }
    source() { const s = this._pick(); return s ? s.name : null; }

    _pick() {
        const now = Date.now();
        for (const e of this.egs) { const v = e.val.get(now); if (v !== null) return { v, name: 'EGS' }; }
        const v = this.sig.get(now);
        return v !== null ? { v, name: 'signal' } : null;
    }

    _next(ms) { clearTimeout(this.timer); this.timer = this.stopped ? null : setTimeout(() => this._poll(), ms); }

    async _poll() {
        clearTimeout(this.timer); this.timer = null;
        if (this.stopped) return;
        const ask = this.egs.filter((e) => !e.gone);
        if (!ask.length) { this.log.info('gearbox: the gearbox unit has no oil temperature identifier: the signal only'); return; }
        if (!this.visible()) { this._next(POLL_MS); return; }
        // this module paces itself (SLOW_MS): the link's own "skip a silent unit" must not lock the unit out
        if (this.link.wake) this.link.wake(EGS);
        // the identifier that answered before (or the first still possible)
        const e = ask.find((x) => x.val.v !== null) || ask[0];
        let r = null;
        try { r = await this.link.read(EGS, e.did); } catch (err) {
            // the head unit's transport comes up a few seconds after the app (its availability flag may never say so):
            // until then a request throws; try again soon
            // (a head unit without it: every SLOW_MS after 30 s)
            this._once('err', 'gearbox: ' + (err && err.message || err) + ' (trying again)');
            this.failed = (this.failed || 0) + 1;
            this._next(this.failed >= 15 ? SLOW_MS : 2000);
            return;
        }
        const now = Date.now();
        this.failed = 0;
        if (r && r[0] === 0x62 && r.length >= 4 && ((r[1] << 8) | r[2]) === e.did) {
            this.silent = 0;
            e.val.put(r[3] + e.offset, now);
            this._once('egs' + e.did, 'gearbox: EGS ' + e.did.toString(16).toUpperCase() + ' -> ' + (r[3] + e.offset) + ' deg C');
            this._next(POLL_MS);
        } else if (r && r[0] === 0x7F) {
            this.silent = 0;
            if (ABSENT.indexOf(r[2]) >= 0) { e.gone = true; this.log.info('gearbox: EGS has no ' + e.did.toString(16).toUpperCase()); }
            else this._once('nrc' + r[2], 'gearbox: EGS refused ' + e.did.toString(16).toUpperCase() + ' (NRC ' + r[2].toString(16) + ')');
            this._next(e.gone ? 100 : POLL_MS);
        } else {
            this._once('none', 'gearbox: no answer from the gearbox unit (' + e.did.toString(16).toUpperCase() + ')');
            this.silent++;
            this._next(this.silent >= 3 ? SLOW_MS : POLL_MS);
        }
    }

    _once(key, msg) { if (!this.logged[key]) { this.logged[key] = true; this.log.info(msg); } }
}

module.exports = { Gearbox, Moving, DIDS, EGS };
