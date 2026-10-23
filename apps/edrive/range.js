'use strict';
/**
 * range.js - what this car uses on electric power, learned from its own driving.
 *
 *   driving:    % of charge per km (engine off, climate draw taken out), last LEARN_KM km
 *   climate:    climate control + on-board electrics, % of charge per HOUR: heating when cold,
 *               A/C when hot. Learned per outside-temperature band (BANDS) from standing /
 *               creeping with the engine off; until there is 15 minutes of it in a band the
 *               typical draw for the temperature (AUX_KW) is used, from an hour on only its own.
 *   speed:      typical speed of electric driving, stops in traffic included (up to STOP_H after
 *               moving; longer is parking): the climate draw costs range by the hour, so per km it
 *               is draw / speed (more of it in slow traffic)
 *
 * Range per % = 1 / (driving % per km + climate % per hour / typical speed).
 * The state is a plain object (persisted by the app): { learn: {km, pct}, aux: {band: {h, pct}},
 * evSpeed: {km, h} }. Older entries fade out (each total is scaled down past its limit).
 */
const LEARN_KM = 60;             // electric driving remembered for the use per km
const AUX_H = 2;                 // hours of climate draw remembered per temperature band
const SPEED_H = 3;               // hours of electric driving remembered for the typical speed
const BANDS = [-5, 5, 15, 25];   // outside-temperature bands (°C)
const STOP_H = 5 / 60;           // standing this long after moving still counts as a stop in traffic
/** Typical climate control + on-board draw (kW) by outside temperature: [°C, kW]. */
const AUX_KW = [[-10, 3.0], [0, 2.2], [10, 1.0], [18, 0.5], [24, 0.5], [30, 1.2], [38, 2.0]];

const isNum = (v) => typeof v === 'number' && isFinite(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const bandOf = (tC) => { let i = 0; while (i < BANDS.length && tC >= BANDS[i]) i++; return 'b' + i; };
const fade = (o, k, max) => { if (o[k] > max) { const f = max / o[k]; Object.keys(o).forEach((x) => { o[x] *= f; }); } };

function auxKwTypical(tC) {
    const c = AUX_KW, t = clamp(isNum(tC) ? tC : 15, c[0][0], c[c.length - 1][0]);
    let i = 0;
    while (i < c.length - 2 && t > c[i + 1][0]) i++;
    const f = (t - c[i][0]) / (c[i + 1][0] - c[i][0]);
    return c[i][1] + (c[i + 1][1] - c[i][1]) * f;
}

class RangeModel {
    constructor(st) { this.st = st; this.stoodH = Infinity; }

    /** % per km for driving alone, once there is enough of it (>= 5 km and 2 %); else null. */
    drivePctPerKm() {
        const L = this.st.learn;
        if (!L || L.km < 5 || L.pct < 2) return null;
        const a = L.pct / L.km;
        return a > 0.2 && a < 10 ? a : null;
    }

    /** Climate + on-board draw at tC: { rate (% per hour), learned }. kwhPerPct: kWh in 1 % today. */
    auxRate(tC, kwhPerPct) {
        const typ = auxKwTypical(tC) / kwhPerPct;
        const b = isNum(tC) && this.st.aux && this.st.aux[bandOf(tC)];
        if (!b || b.h < 0.25) return { rate: typ, learned: false };
        const w = Math.min(1, b.h), own = Math.max(0, b.pct / b.h);
        return { rate: own * w + typ * (1 - w), learned: true };
    }

    /** Typical speed of electric driving in km/h (35 until there is 6 minutes of it). */
    evSpeed() {
        const v = this.st.evSpeed;
        return v && v.h >= 0.1 ? clamp(v.km / v.h, 12, 110) : 35;
    }

    /**
     * One stretch between two charge readings with the engine off throughout: used % of charge
     * (regen makes it smaller), over h hours and km, at tC outside. Standing / creeping teaches the
     * climate draw, driving the use per km (the climate draw meanwhile taken out) and the speed.
     */
    learn(used, h, km, tC, kwhPerPct) {
        if (!isNum(used) || !(h > 0)) return;
        const st = this.st;
        if (km < 0.05) {
            if (used <= -0.05 || !isNum(tC)) return;                // charge rising: not a draw
            st.aux = st.aux || {};
            const b = st.aux[bandOf(tC)] || (st.aux[bandOf(tC)] = { h: 0, pct: 0 });
            b.h += h; b.pct += used;
            fade(b, 'h', AUX_H);
            // a stop in traffic is part of the trip's time (its climate draw is too); parking is not
            this.stoodH += h;
            if (this.stoodH <= STOP_H && st.evSpeed) { st.evSpeed.h += h; fade(st.evSpeed, 'h', SPEED_H); }
            return;
        }
        this.stoodH = 0;
        const L = st.learn || (st.learn = { km: 0, pct: 0 });
        L.km += km; L.pct += used - this.auxRate(tC, kwhPerPct).rate * h;
        fade(L, 'km', LEARN_KM);
        const v = st.evSpeed || (st.evSpeed = { km: 0, h: 0 });
        v.km += km; v.h += h;
        fade(v, 'h', SPEED_H);
    }

    /**
     * Range for `use` % of usable charge at tC: { kpp (km per %), mid, noAux (range without the
     * climate draw), aux } - or null before driving is learned.
     */
    range(use, tC, kwhPerPct) {
        const a = this.drivePctPerKm();
        if (!a) return null;
        const aux = this.auxRate(tC, kwhPerPct), kpp = 1 / (a + aux.rate / this.evSpeed());
        return { kpp, mid: isNum(use) ? use * kpp : null, noAux: isNum(use) ? use / a : null, aux };
    }
}

module.exports = { RangeModel, auxKwTypical, bandOf, LEARN_KM, AUX_KW };
