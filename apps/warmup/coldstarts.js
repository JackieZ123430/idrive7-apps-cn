'use strict';
/**
 * coldstarts.js - Warm-Up's engine starts, counted while the app runs in the background: how many came with cold oil
 * (under COLD_C when the first oil reading after the start comes), and how many cold runs were revved past the safe
 * rev limit for the oil's temperature (Warm-Up's rev limit, limit(oil)). A plug-in hybrid's engine starting while it
 * drives counts as a start too; one stopped for less than OFF_MS (auto start-stop) does not. Kept in the settings
 * ('coldStarts') so the counts go on over drives.
 *
 *   const c = new ColdStarts({ settings, limit: (oil) => rpm | null, warm: () => deg C, now });
 *   c.rpm(r); c.oil(deg C);  c.stats() -> { starts, cold, revved, since, last: [{ at, oil, cold, revved }] }   c.reset()
 */
const EventEmitter = require('events');

const RUN_RPM = 400, STOP_RPM = 300;
const OFF_MS = 30000;          // stopped this long: the next run is a new start
const OIL_WAIT_MS = 30000;     // the first oil reading after a start, at most this late
const COLD_C = 40;
const LAST = 8;

const isNum = (v) => typeof v === 'number' && isFinite(v);

class ColdStarts extends EventEmitter {
    constructor(o) {
        super();
        this.settings = o.settings;
        this.limit = o.limit || (() => null);
        this.warm = o.warm || (() => 90);
        this.now = o.now || Date.now;
        this.oilC = null;
        this.running = false;
        this.stoppedAt = -Infinity;
        this.run = null;        // the run now: { at, oil, cold, revved, counted }
        const s = this.settings.get('coldStarts');
        this.s = s && isNum(s.starts) ? s : this._empty();
    }

    _empty() { return { starts: 0, cold: 0, revved: 0, since: this.now(), last: [] }; }

    stats() { return this.s; }

    reset() { this.s = this._empty(); this._save(); }

    oil(c) {
        if (!isNum(c)) return;
        this.oilC = c;
        const r = this.run;
        if (r && !r.counted && this.now() - r.at <= OIL_WAIT_MS) this._count(c);
    }

    rpm(r) {
        if (!isNum(r)) return;
        const t = this.now();
        if (!this.running && r > RUN_RPM) {
            this.running = true;
            if (t - this.stoppedAt >= OFF_MS || !this.run) {
                this.run = { at: t, oil: null, cold: false, revved: false, counted: false };
                // an oil reading from before the start, if fresh: the oil does not change in that moment
                if (isNum(this.oilC)) this._count(this.oilC);
            }
        } else if (this.running && r < STOP_RPM) {
            this.running = false;
            this.stoppedAt = t;
        }
        const run = this.run;
        if (this.running && run && run.counted && !run.revved && isNum(this.oilC) && this.oilC < this.warm()) {
            const lim = this.limit(this.oilC);
            if (isNum(lim) && r > lim) {
                run.revved = true;
                this.s.revved += 1;
                this._save();
            }
        }
    }

    _count(c) {
        const r = this.run;
        r.counted = true;
        r.oil = Math.round(c);
        r.cold = c < COLD_C;
        this.s.starts += 1;
        if (r.cold) this.s.cold += 1;
        this.s.last = [r].concat(this.s.last.filter((x) => x !== r)).slice(0, LAST);
        this._save();
    }

    _save() {
        this.settings.set('coldStarts', this.s);
        this.emit('change');
    }
}

module.exports = { ColdStarts, COLD_C, OFF_MS, RUN_RPM };
