'use strict';
/**
 * Part of Redline's experimental features; README.md in this folder has the whole picture
 * (settings, learning, files, logs, rules for this code).
 *
 * Gearbox oil temperature for Redline's HUD, from whichever source answers:
 *   1. the gearbox unit (EGS, 0x18) over UDS 22, read-only: ZF 8HP _GETRIEBEOELTEMPERATUR (6000,
 *      deg C + 40, read on a G22), then DA12 (deg C + 48, unconfirmed); every 5 s while wanted;
 *   2. SOME/IP BasicDataSet.valueTemperatureTransmissionOil (deg C + 48, 255 = none); some cars
 *      never fill it, so a value that has not changed since start counts only after the EGS failed.
 * The same candidates as Car Vitals (apps/car_vitals/app.json config.dme.egs).
 * Never throws; value() is a number in deg C or null.
 */
const { ReadOnlyDiag } = require('./kit/readonly-diag');
const { DidReader } = require('./kit/dids');

const EGS = [
    { ecu: 0x18, did: '6000', bytes: 1, at: 0, factor: 1, offset: -40, min: -40, max: 160 },
    { ecu: 0x18, did: 'DA12', bytes: 1, at: 0, factor: 1, offset: -48, min: -40, max: 160 },
];
const POLL_MS = 5000, FAIL_RETRY_MS = 60000, STALE_MS = 20000;

class GearboxTemp {
    constructor(ctx) {
        this.ctx = ctx; this.log = ctx.log;
        // egsT: when EGS last gave a temperature (its age); triedT: when it was last asked (the retry pace)
        this.egs = null; this.egsT = 0; this.triedT = 0; this.egsFails = 0;
        this.bds = null; this.bdsFirst = null; this.bdsMoved = false;
        this.link = null; this.rd = null; this.timer = null; this.busy = false; this.source = '';
    }

    /** Signal handlers for Car's extra watches: { 'de.bmw.infrastructure.analytics.BasicDataSet': ... }. */
    handlers() {
        return {
            'de.bmw.infrastructure.analytics.BasicDataSet': {
                basicDataSet: (v) => {
                    try {
                        const raw = v && v.valueTemperatureTransmissionOil;
                        if (typeof raw !== 'number' || raw === 255) return;
                        if (this.bdsFirst === null) this.bdsFirst = raw;
                        else if (raw !== this.bdsFirst) this.bdsMoved = true;
                        this.bds = raw - 48;
                    } catch (e) { /* never throw from a signal */ }
                },
            },
        };
    }

    /** The read-only diagnostics link, made on first use; shared with knock.js (one link to the car). */
    diag() {
        if (!this.link) {
            this.link = new ReadOnlyDiag(this.ctx.signals, this.log);
            Promise.resolve(this.link.init()).catch((e) => this.log.warn('gearbox: diag link: ' + (e && e.message || e)));
            this.rd = new DidReader(this.link, { ecu: 0x18 });
        }
        return this.link;
    }

    /** Poll the EGS while wanted (the HUD is on); stop() when not. */
    start() {
        if (this.timer) return;
        try {
            this.diag();
            this.timer = setInterval(() => this._poll(), POLL_MS);
            this._poll();
        } catch (e) { this.log.warn('gearbox: ' + (e && e.message || e)); }
    }

    stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

    _poll() {
        if (this.busy || !this.rd) return;
        if (this.egsFails >= 3 && Date.now() - this.triedT < FAIL_RETRY_MS) return;    // EGS silent: try again each minute
        this.busy = true;
        if (this.egsFails >= 3 && this.link && this.link.wake) this.link.wake(0x18);   // retried each minute: may have been asleep
        Promise.resolve().then(() => this.rd.value('egs', EGS)).then((v) => {
            this.triedT = Date.now();
            if (v === null) {
                this.egsFails++;
                if (this.egsFails === 3) {
                    const r = this.rd.raws, why = EGS.map((c) => c.did + ': ' + ((r[this.rd.key(c)] || {}).why || '?')).join(', ');
                    this.log.info('gearbox: EGS gives no temperature (' + why + '), using BasicDataSet when it moves');
                }
            } else {
                if (this.egsFails || this.egs === null) this.log.info('gearbox: EGS ' + EGS[this.rd.pick.egs || 0].did + ' = ' + v + ' C');
                this.egs = v; this.egsT = this.triedT; this.egsFails = 0;
            }
        }).catch((e) => { this.triedT = Date.now(); this.egsFails++; this.log.warn('gearbox: ' + (e && e.message || e)); })
            .then(() => { this.busy = false; });
    }

    value() {
        if (this.egs !== null && Date.now() - this.egsT < STALE_MS) { this.source = 'EGS'; return this.egs; }
        if (this.bds !== null && (this.bdsMoved || this.egsFails >= 3)) { this.source = 'BasicDataSet'; return this.bds; }
        this.source = '';
        return null;
    }
}

module.exports = GearboxTemp;
