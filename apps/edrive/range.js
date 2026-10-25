'use strict';
/**
 * range.js - what this car uses on electric power, learned from its own driving.
 *
 *   driving:    % of charge per km (engine off, climate draw taken out), last LEARN_KM km
 *   climate:    climate control + on-board electrics, % of charge per HOUR: heating when cold,
 *               A/C when hot. Learned per outside-temperature band (BANDS) from standing /
 *               creeping with the engine off; until there is 15 minutes of it in a band the
 *               typical draw for the temperature (AUX_KW) is used, from an hour on only its own.
 *               With climate control OFF (the car says so) only the on-board electrics draw:
 *               learned the same way, but in one bucket (st.base, no bands), typical BASE_KW.
 *               With the A/C on as well, its own bands (st.acAux), typical AUX_KW + AC_KW.
 *               climate = 'ac' / true / false / null (not known: as on, the way it was before).
 *   speed:      typical speed of electric driving, stops in traffic included (up to STOP_H after
 *               moving; longer is parking): the climate draw costs range by the hour, so per km it
 *               is draw / speed (more of it in slow traffic)
 *
 * Range per % = 1 / (driving % per km + climate % per hour / typical speed).
 * The state is a plain object (persisted by the app): { learn: {km, pct}, aux: {band: {h, pct}},
 * base: {h, pct}, evSpeed: {km, h} }. Older entries fade out (each total is scaled down past its limit).
 */
const LEARN_KM = 60;             // electric driving remembered for the use per km
const AUX_H = 2;                 // hours of climate draw remembered per temperature band
const SPEED_H = 3;               // hours of electric driving remembered for the typical speed
const BANDS = [-5, 5, 15, 25];   // outside-temperature bands (°C)
const STOP_H = 5 / 60;           // standing this long after moving still counts as a stop in traffic
/** Typical climate control + on-board draw (kW) by outside temperature: [°C, kW]. */
const AUX_KW = [[-10, 3.0], [0, 2.2], [10, 1.0], [18, 0.5], [24, 0.5], [30, 1.2], [38, 2.0]];
/** Typical on-board draw (kW) with climate control off: control units, screens, pumps, fans. */
const BASE_KW = 0.3;
/** Typical extra draw (kW) of the A/C compressor by outside temperature: [°C, kW] (cold: dehumidifying). */
const AC_KW = [[0, 0.5], [10, 0.8], [18, 1.0], [25, 1.5], [35, 2.5]];

const isNum = (v) => typeof v === 'number' && isFinite(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const bandOf = (tC) => { let i = 0; while (i < BANDS.length && tC >= BANDS[i]) i++; return 'b' + i; };
const fade = (o, k, max) => { if (o[k] > max) { const f = max / o[k]; Object.keys(o).forEach((x) => { o[x] *= f; }); } };

function curve(c, tC) {
    const t = clamp(isNum(tC) ? tC : 15, c[0][0], c[c.length - 1][0]);
    let i = 0;
    while (i < c.length - 2 && t > c[i + 1][0]) i++;
    const f = (t - c[i][0]) / (c[i + 1][0] - c[i][0]);
    return c[i][1] + (c[i + 1][1] - c[i][1]) * f;
}
const auxKwTypical = (tC) => curve(AUX_KW, tC);
const acKwTypical = (tC) => curve(AC_KW, tC);

class RangeModel {
    constructor(st) { this.st = st; this.stoodH = Infinity; }

    /** % per km for driving alone, once there is enough of it (>= 5 km and 2 %); else null. */
    drivePctPerKm() {
        const L = this.st.learn;
        if (!L || L.km < 5 || L.pct < 2) return null;
        const a = L.pct / L.km;
        return a > 0.2 && a < 10 ? a : null;
    }

    /**
     * Climate + on-board draw at tC: { rate (% per hour), learned, climate }. kwhPerPct: kWh in 1 %
     * today. climate false: the on-board electrics only.
     */
    auxRate(tC, kwhPerPct, climate) {
        if (climate === false) {
            const typ = BASE_KW / kwhPerPct, b = this.st.base;
            if (!b || b.h < 0.25) return { rate: typ, learned: false, climate };
            const w = Math.min(1, b.h), own = Math.max(0, b.pct / b.h);
            return { rate: own * w + typ * (1 - w), learned: true, climate };
        }
        const ac = climate === 'ac', bands = ac ? this.st.acAux : this.st.aux;
        const typ = (auxKwTypical(tC) + (ac ? acKwTypical(tC) : 0)) / kwhPerPct;
        const b = isNum(tC) && bands && bands[bandOf(tC)];
        if (!b || b.h < 0.25) return { rate: typ, learned: false, climate };
        const w = Math.min(1, b.h), own = Math.max(0, b.pct / b.h);
        return { rate: own * w + typ * (1 - w), learned: true, climate };
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
     * climate: on / off throughout (true / false), not known (null), or 'mixed' (switched during
     * the stretch: it counts for the speed, but teaches neither draw nor use per km).
     */
    learn(used, h, km, tC, kwhPerPct, climate) {
        if (!isNum(used) || !(h > 0)) return;
        const st = this.st, mixed = climate === 'mixed';
        if (km < 0.05) {
            if (used <= -0.05 || (!isNum(tC) && climate !== false)) return;  // charge rising: not a draw
            if (!mixed) {
                let b;
                if (climate === false) b = st.base || (st.base = { h: 0, pct: 0 });
                else {
                    const key = climate === 'ac' ? 'acAux' : 'aux', bands = st[key] || (st[key] = {});
                    b = bands[bandOf(tC)] || (bands[bandOf(tC)] = { h: 0, pct: 0 });
                }
                b.h += h; b.pct += used;
                fade(b, 'h', AUX_H);
            }
            // a stop in traffic is part of the trip's time (its climate draw is too); parking is not
            this.stoodH += h;
            if (this.stoodH <= STOP_H && st.evSpeed) { st.evSpeed.h += h; fade(st.evSpeed, 'h', SPEED_H); }
            return;
        }
        this.stoodH = 0;
        if (!mixed) {
            const L = st.learn || (st.learn = { km: 0, pct: 0 });
            L.km += km; L.pct += used - this.auxRate(tC, kwhPerPct, climate).rate * h;
            fade(L, 'km', LEARN_KM);
        }
        const v = st.evSpeed || (st.evSpeed = { km: 0, h: 0 });
        v.km += km; v.h += h;
        fade(v, 'h', SPEED_H);
    }

    /**
     * Range for `use` % of usable charge at tC: { kpp (km per %), mid, noAux (range without the
     * climate draw), aux } - or null before driving is learned. climate: see auxRate().
     */
    range(use, tC, kwhPerPct, climate) {
        const a = this.drivePctPerKm();
        if (!a) return null;
        const aux = this.auxRate(tC, kwhPerPct, climate), kpp = 1 / (a + aux.rate / this.evSpeed());
        return { kpp, mid: isNum(use) ? use * kpp : null, noAux: isNum(use) ? use / a : null, aux };
    }
}

module.exports = { RangeModel, auxKwTypical, acKwTypical, bandOf, LEARN_KM, AUX_KW, BASE_KW, AC_KW };
