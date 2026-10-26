'use strict';
/**
 * range.js - what this car uses on electric power, learned from its own driving.
 *
 *   driving:    % of charge per km (engine off, climate draw taken out), last LEARN_KM km - overall
 *               and per speed band (SPEED_BANDS: faster = more per km); a band with little driving
 *               leans on the overall value. The range uses the band of your current pace.
 *   climate:    climate control + on-board electrics, % of charge per HOUR: heating when cold,
 *               A/C when hot. Learned per outside-temperature band (BANDS) from standing /
 *               creeping with the engine off; until there is 15 minutes of it in a band the
 *               typical draw for the temperature (AUX_KW) is used, from an hour on only its own.
 *               With climate control OFF (the car says so) only the on-board electrics draw:
 *               learned the same way, but in one bucket (st.base, no bands), typical BASE_KW.
 *               With the A/C on as well, its own bands (st.acAux), typical AUX_KW + AC_KW.
 *               climate = 'ac' / true / false / null (not known: as on, the way it was before).
 *               Climate on while DRIVING teaches its draw too: what the stretch used above the same
 *               speed band with the climate off (st.driveOff) - so the heating's draw is learned
 *               from normal driving, not only from standing.
 *   comfort:    seat and steering-wheel heating (kW, estimated in main.js from their levels): on
 *               with or without the climate, so taken out of every stretch before it teaches
 *               anything, and added back for the range.
 *   speed:      typical speed of electric driving, stops in traffic included (up to STOP_H after
 *               moving; longer is parking): the climate draw costs range by the hour, so per km it
 *               is draw / speed (more of it in slow traffic)
 *
 * Range per % = 1 / (driving % per km at the pace + (climate + comfort % per hour) / pace).
 * The state is a plain object (persisted by the app): { learn: {km, pct}, drive: {band: {km, pct}},
 * driveOff: {band: {km, pct}}, aux / acAux: {band: {h, pct}}, base: {h, pct}, evSpeed: {km, h} }. Older entries fade out (each total is scaled down past its limit).
 */
const LEARN_KM = 60;             // electric driving remembered for the use per km
const AUX_H = 2;                 // hours of climate draw remembered per temperature band
const SPEED_H = 3;               // hours of electric driving remembered for the typical speed
const BANDS = [-5, 5, 15, 25];   // outside-temperature bands (°C)
const STOP_H = 5 / 60;           // standing this long after moving still counts as a stop in traffic
const SPEED_BANDS = [35, 60, 85, 110];   // km/h: city / town / country / fast / motorway
const BAND_KM = 30;              // km remembered per speed band
const BAND_PRIOR_KM = 5;         // a band's own value counts fully from about this much driving in it
/** Typical climate control + on-board draw (kW) by outside temperature: [°C, kW]. */
const AUX_KW = [[-10, 3.0], [0, 2.2], [10, 1.0], [18, 0.5], [24, 0.5], [30, 1.2], [38, 2.0]];
/** Typical on-board draw (kW) with climate control off: control units, screens, pumps, fans. */
const BASE_KW = 0.3;
/** Typical extra draw (kW) of the A/C compressor by outside temperature: [°C, kW] (cold: dehumidifying). */
const AC_KW = [[0, 0.5], [10, 0.8], [18, 1.0], [25, 1.5], [35, 2.5]];

const isNum = (v) => typeof v === 'number' && isFinite(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const speedBandOf = (kmh) => { let i = 0; while (i < SPEED_BANDS.length && kmh >= SPEED_BANDS[i]) i++; return 'v' + i; };
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

    /**
     * % per km for driving alone, once there is enough of it (>= 5 km and 2 %); else null. With a
     * speed (km/h): that speed band's own value, leaning on the overall one while it has little driving.
     */
    drivePctPerKm(kmh) {
        const L = this.st.learn;
        if (!L || L.km < 5 || L.pct < 2) return null;
        const a = L.pct / L.km;
        if (!(a > 0.2 && a < 10)) return null;
        const b = isNum(kmh) && kmh > 3 && this.st.drive && this.st.drive[speedBandOf(kmh)];
        if (!b || !(b.km > 0.5)) return a;
        const own = b.pct / b.km;
        if (!(own > 0.1 && own < 15)) return a;
        const w = b.km / (b.km + BAND_PRIOR_KM);
        return own * w + a * (1 - w);
    }

    /** The same, from driving with the climate OFF only (for learning the climate draw while driving). */
    driveOffPctPerKm(kmh) {
        const b = this.st.driveOff && this.st.driveOff[speedBandOf(kmh)];
        if (!b || b.km < 3) return null;
        const a = b.pct / b.km;
        return a > 0.1 && a < 15 ? a : null;
    }

    /** What is learned per speed band: [{ band: 'v0', from, to, km, pctPerKm }] (Energy page). */
    bands() {
        const edges = [0].concat(SPEED_BANDS, [null]);
        return edges.slice(0, -1).map((from, i) => {
            const b = this.st.drive && this.st.drive['v' + i];
            return { band: 'v' + i, from, to: edges[i + 1], km: b ? b.km : 0, pctPerKm: b && b.km > 0.5 ? b.pct / b.km : null };
        });
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
    learn(used, h, km, tC, kwhPerPct, climate, comfortKw) {
        if (!isNum(used) || !(h > 0)) return;
        const st = this.st, mixed = climate === 'mixed';
        // seat / steering-wheel heating: on with or without the climate - not part of what is learned
        if (isNum(comfortKw) && comfortKw > 0 && kwhPerPct > 0) used -= comfortKw * h / kwhPerPct;
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
            const net = used - this.auxRate(tC, kwhPerPct, climate).rate * h, band = speedBandOf(km / h);
            const L = st.learn || (st.learn = { km: 0, pct: 0 });
            L.km += km; L.pct += net;
            fade(L, 'km', LEARN_KM);
            const D = st.drive || (st.drive = {}), b = D[band] || (D[band] = { km: 0, pct: 0 });
            b.km += km; b.pct += net;
            fade(b, 'km', BAND_KM);
            if (climate === false) {
                // the same speed with the climate off: the yardstick for the climate's draw while driving
                const O = st.driveOff || (st.driveOff = {}), o = O[band] || (O[band] = { km: 0, pct: 0 });
                o.km += km; o.pct += net;
                fade(o, 'km', BAND_KM);
            } else if ((climate === true || climate === 'ac') && isNum(tC)) {
                // climate on while driving: what it used above that yardstick is the climate (+ on-board) draw
                const off = this.driveOffPctPerKm(km / h);
                if (off !== null) {
                    const key = climate === 'ac' ? 'acAux' : 'aux', bands = st[key] || (st[key] = {});
                    const c = bands[bandOf(tC)] || (bands[bandOf(tC)] = { h: 0, pct: 0 });
                    c.h += h; c.pct += Math.max(0, used - off * km);
                    fade(c, 'h', AUX_H);
                }
            }
        }
        const v = st.evSpeed || (st.evSpeed = { km: 0, h: 0 });
        v.km += km; v.h += h;
        fade(v, 'h', SPEED_H);
    }

    /**
     * Range for `use` % of usable charge at tC: { kpp (km per %), mid, noAux (range without the
     * climate draw), climateKm (range the climate costs above the on-board draw), comfortKm (range seat /
     * steering-wheel heating cost), aux, pace, perKm (driving % per km at the pace) } - or null before
     * driving is learned. climate: see auxRate(). pace: km/h now (null: the typical speed). comfortKw:
     * seat / steering-wheel heating now.
     */
    range(use, tC, kwhPerPct, climate, pace, comfortKw) {
        const v = isNum(pace) && pace > 3 ? clamp(pace, 8, 150) : this.evSpeed();
        const a = this.drivePctPerKm(v);
        if (!a) return null;
        const aux = this.auxRate(tC, kwhPerPct, climate), off = this.auxRate(tC, kwhPerPct, false);
        const comfort = isNum(comfortKw) && comfortKw > 0 ? comfortKw / kwhPerPct : 0;
        const kppAt = (auxRate, c) => 1 / (a + (auxRate + c) / v);
        const kpp = kppAt(aux.rate, comfort);
        const r = (k) => (isNum(use) ? use * k : null);
        return {
            kpp, mid: r(kpp), noAux: isNum(use) ? use / a : null, aux, pace: v, perKm: a,
            climateKm: climate === false || !isNum(use) ? 0 : Math.max(0, r(kppAt(off.rate, comfort)) - r(kpp)),
            comfortKm: isNum(use) ? r(kppAt(aux.rate, 0)) - r(kpp) : null,
        };
    }
}

module.exports = { RangeModel, auxKwTypical, acKwTypical, bandOf, speedBandOf, LEARN_KM, AUX_KW, BASE_KW, AC_KW, SPEED_BANDS };
