'use strict';
/**
 * shifts.js - Drag Timer: the upshifts in a run, when and at what speed and rpm.
 *
 * From the gearbox's gear signal once the car has sent one (each step up = one upshift, also one that skips a gear, at
 * the moment the new gear shows; the signal comes on change only, so a long time in one gear sends nothing), while the
 * car still gets faster after it (an automatic shifts up as the driver lifts at the end of a pull: no shift of the
 * pull); else from the rpm: a fall of at least DROP_RPM (or DROP_SHARE of the rpm) within DROP_MS while the car
 * keeps getting faster afterwards (a lift ends a run with a fall too, but the speed then drops). Gears from the
 * rpm alone are counted from 1st for a launch, and not known for a pull from a roll.
 *
 *   const s = new ShiftLog();
 *   s.gear(t, n); s.rpm(t, rpm); s.speed(t, km/h)     every sample (t: ms)
 *   s.between(t1, t2, fromGear) -> [{ t (ms), from, to (gear numbers or null), rpm, kmh }]
 */
const DROP_RPM = 350, DROP_SHARE = 0.1, DROP_MS = 700, GAP_MS = 600, AFTER_MS = 1000, KEEP_MS = 120000;

class ShiftLog {
    constructor() { this.g = []; this.r = []; this.v = []; this.lastGear = null; this.gearSeen = false; }

    _keep(a, t) { if (a.length > 50 && t - a[0][0] > KEEP_MS + 10000) a.splice(0, a.findIndex((x) => t - x[0] <= KEEP_MS)); }

    gear(t, n) {
        if (typeof n !== 'number' || !isFinite(n)) return;
        this.gearSeen = true;
        if (n === this.lastGear) return;
        this.g.push([t, this.lastGear, n]);
        this.lastGear = n;
        this._keep(this.g, t);
    }

    rpm(t, r) { if (typeof r === 'number' && isFinite(r)) { this.r.push([t, r]); this._keep(this.r, t); } }

    speed(t, kmh) { if (typeof kmh === 'number' && isFinite(kmh)) { this.v.push([t, kmh]); this._keep(this.v, t); } }

    /** The value of a [t, x] series at t (between samples: linear; before the first / after the last: null / last). */
    static at(a, t) {
        if (!a.length || t < a[0][0]) return null;
        let lo = 0, hi = a.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (a[m][0] < t) lo = m + 1; else hi = m; }
        if (lo >= a.length) return a[a.length - 1][1];
        if (a[lo][0] === t || lo === 0) return a[lo][1];
        const p = a[lo - 1], q = a[lo];
        return p[1] + (q[1] - p[1]) * (t - p[0]) / (q[0] - p[0]);
    }

    /** The highest rpm in t1..t2 (null without a sample there). */
    _rpmMax(t1, t2) { let m = null; for (const x of this.r) if (x[0] >= t1 && x[0] <= t2 && (m === null || x[1] > m)) m = x[1]; return m; }

    /** The gearbox has sent a gear (from then on its signal, not the rpm, tells the shifts). */
    hasGear() { return this.gearSeen; }

    between(t1, t2, fromGear) {
        if (!(t2 > t1)) return [];
        const kmh = (t) => { const v = ShiftLog.at(this.v, t); return v === null ? null : Math.round(v); };
        const rising = (t) => { const a = ShiftLog.at(this.v, t), b = ShiftLog.at(this.v, t + AFTER_MS); return a !== null && b !== null && b > a + 0.5; };
        if (this.hasGear()) {
            return this.g.filter((x) => x[0] > t1 && x[0] <= t2 && x[1] >= 1 && x[2] > x[1] && rising(x[0]))
                .map((x) => ({ t: x[0], from: x[1], to: x[2], rpm: roundRpm(this._rpmMax(x[0] - 800, x[0])), kmh: kmh(x[0]) }));
        }
        const out = [];
        let peak = null, gear = typeof fromGear === 'number' ? fromGear : null;
        for (const s of this.r) {
            if (s[0] < t1 || s[0] > t2) continue;
            if (!peak || s[1] >= peak[1]) { peak = s; continue; }
            if (s[0] - peak[0] > DROP_MS) { peak = s; continue; }
            if (peak[1] - s[1] < Math.max(DROP_RPM, peak[1] * DROP_SHARE)) continue;
            // a shift: the car still gets faster after it (a lift doesn't), and some time after the last one
            const v0 = ShiftLog.at(this.v, peak[0]), v1 = ShiftLog.at(this.v, s[0] + AFTER_MS);
            const last = out[out.length - 1];
            if (s[0] + AFTER_MS <= t2 && v0 !== null && v1 !== null && v1 > v0 + 0.5 && (!last || peak[0] - last.t >= GAP_MS)) {      // (rising, from the bottom of the fall)
                out.push({ t: peak[0], from: gear, to: gear === null ? null : gear + 1, rpm: roundRpm(peak[1]), kmh: kmh(peak[0]) });
                if (gear !== null) gear++;
            }
            peak = s;
        }
        return out;
    }
}

const roundRpm = (r) => (r === null ? null : Math.round(r / 10) * 10);

module.exports = { ShiftLog, DROP_RPM, DROP_MS };
