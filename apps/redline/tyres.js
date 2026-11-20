'use strict';
/**
 * Part of Redline's experimental features; README.md in this folder has the whole picture.
 *
 * Tyre pressures, their targets and tyre temperatures for the HUD, from the car's own signals. Redline's own
 * code: nothing from Car Vitals is loaded or read (its files neither). The scaling is the one Car Vitals worked
 * out on cars (apps/car_vitals/app.json config.scaling tyrePress / tyreTemp, main.js tyreP / tyreT):
 *
 *   TPMS.statusTyrePressure        actualValuePressureTyreFLH / FRH / RLH / RRH: 0.1 x raw in the car's pressure
 *                                  unit (bar, kPa or psi), 65532 and up = none (BMW x_call's converter)
 *   TPMS.statusTargetTyrePressure  targetPressureTyreFLH ...: the same
 *   TPMS.statusTyreTemperature     actualValueTemperatureTyreFLH ...: the car's degrees + 40, 65535 = none
 *   Vehicle.statusNewCurrentUnitsStatusExt  the car's display units (pressure 1 bar / 2 kPa / 3 psi,
 *                                  temperature 1 C / 2 F). Until it says, the unit is told from the value:
 *                                  tyre pressures in bar (0.5-6), psi (7-60) and kPa (60-600) don't overlap;
 *                                  psi also means Fahrenheit.
 *
 * value() is { p: { FL, FR, RL, RR } bar, tgt: { ... } bar, t: { ... } °C } (each a number or null) and only
 * holds values under STALE_MS old; none at all is null. Never throws.
 * The first real pressure sets the hidden setting hudTyresSeen: only then does the HUD looks page show its TYRES
 * tab and the Tyres readout switch (a car that sends no tyres never sees them).
 */

const CORNERS = ['FL', 'FR', 'RL', 'RR'];
const FIELD = { FL: 'FLH', FR: 'FRH', RL: 'RLH', RR: 'RRH' };
const PRESS_UNITS = { 1: 'BAR', 2: 'KPA', 3: 'PSI' }, TEMP_UNITS = { 1: 'C', 2: 'F' };
const TO_BAR = { BAR: 1, KPA: 0.01, PSI: 1 / 14.5038 };
const P_OK = [0.5, 6], TGT_OK = [1, 6], T_OK = [-40, 150];
const STALE_MS = 10 * 60 * 1000;      // the car sends tyres every few seconds while driving; parked, rarely

const isNum = (v) => typeof v === 'number' && isFinite(v);
const unitName = (map, v) => (map[v] || (Object.keys(map).some((k) => map[k] === v) ? v : null));

/**
 * The colour of a pressure against its target (the bands Car Vitals' tyre card uses): 'hot' (red) under 85 %
 * of the target, 'warm' (orange) under 93 % or over 115 %, 'low' (green) between; 'text' with no target.
 */
function toneOf(p, tgt) {
    if (!isNum(p)) return null;
    if (!isNum(tgt) || tgt <= 0) return 'text';
    const r = p / tgt;
    return r < 0.85 ? 'hot' : r < 0.93 || r > 1.15 ? 'warm' : 'low';
}

/** Pressure units for the HUD: [factor from bar, decimals, name]. */
const UNITS = { bar: [1, 1, 'bar'], psi: [14.5038, 0, 'psi'], kpa: [100, 0, 'kPa'] };
/** A pressure in bar as the HUD writes it in unit u ('bar' | 'psi' | 'kpa'). */
function fmtP(bar, u) {
    if (!isNum(bar)) return '--';
    const k = UNITS[u] || UNITS.bar;
    return (bar * k[0]).toFixed(k[1]);
}

class Tyres {
    constructor(log, settings) {
        this.log = log || { info() {} };
        this.settings = settings || null;
        this.units = { press: null, temp: null, psiSeen: false };
        this.s = {};                  // 'p:FL' -> { v, t }
        this.logged = {};
    }

    /** A raw pressure (0.1 x in the car's unit) in bar, or null. */
    pressure(raw, range) {
        if (!isNum(raw) || raw >= 65532) return null;
        const v = raw * 0.1, k = TO_BAR[this.units.press];
        let bar;
        if (k) bar = v * k;
        else if (v >= P_OK[0] && v <= P_OK[1]) bar = v;
        else if (v >= 7 && v < 60) { this.units.psiSeen = true; bar = v / 14.5038; }
        else if (v >= 60 && v <= 600) bar = v / 100;
        else return null;
        return bar >= range[0] && bar <= range[1] ? bar : null;
    }

    /** A raw temperature (the car's degrees + 40) in °C, or null. */
    temperature(raw) {
        if (!isNum(raw) || raw === 65535) return null;
        const v = raw - 40, f = this.units.temp ? this.units.temp === 'F' : this.units.psiSeen;
        const c = f ? (v - 32) * 5 / 9 : v;
        return c >= T_OK[0] && c <= T_OK[1] ? c : null;
    }

    _put(kind, c, v) {
        if (v === null) return;
        this.s[kind + ':' + c] = { v: v, t: Date.now() };
        if (kind === 'p' && this.settings && this.settings.get('hudTyresSeen') !== true) {
            this.settings.set('hudTyresSeen', true);
            this.log.info('tyres: the car sends tyre pressures: the TYRES tab and readout offered');
        }
    }

    /** true once this car has sent a tyre pressure (kept across restarts). */
    seen() { return !!(this.settings && this.settings.get('hudTyresSeen') === true); }

    _raw(what, v, prefix) {
        // the first raw values of each kind go to the log (to check the scaling on a new car), then no more
        if (this.logged[what]) return;
        this.logged[what] = true;
        this.log.info('tyres: raw ' + what + ' ' + JSON.stringify(CORNERS.map((c) => v && v[prefix + FIELD[c]])));
    }

    /** Signal handlers for Car's extra watches. */
    handlers() {
        const guard = (fn) => (v) => { try { if (v) fn(v); } catch (e) { /* never throw from a signal */ } };
        return {
            'de.bmw.infotainment.vehicle.TPMS': {
                statusTyrePressure: guard((v) => { this._raw('pressure', v, 'actualValuePressureTyre'); CORNERS.forEach((c) => this._put('p', c, this.pressure(v['actualValuePressureTyre' + FIELD[c]], P_OK))); }),
                statusTargetTyrePressure: guard((v) => { this._raw('target', v, 'targetPressureTyre'); CORNERS.forEach((c) => this._put('tgt', c, this.pressure(v['targetPressureTyre' + FIELD[c]], TGT_OK))); }),
                statusTyreTemperature: guard((v) => { this._raw('temperature', v, 'actualValueTemperatureTyre'); CORNERS.forEach((c) => this._put('t', c, this.temperature(v['actualValueTemperatureTyre' + FIELD[c]]))); }),
            },
            'de.bmw.infotainment.vehicle.Vehicle': {
                statusNewCurrentUnitsStatusExt: guard((v) => {
                    const press = unitName(PRESS_UNITS, v.unitOfMeasurementAirPressure), temp = unitName(TEMP_UNITS, v.unitOfMeasurementTemperature);
                    if (press === this.units.press && temp === this.units.temp) return;
                    this.units.press = press; this.units.temp = temp;
                    this.log.info('tyres: car units: pressure ' + (press || '?') + ', temperature ' + (temp || '?'));
                }),
            },
        };
    }

    /** { p, tgt, t } per corner, or null when the car has sent no pressure lately. */
    value() {
        const now = Date.now(), out = { p: {}, tgt: {}, t: {} };
        let any = false;
        ['p', 'tgt', 't'].forEach((k) => CORNERS.forEach((c) => {
            const e = this.s[k + ':' + c], v = e && now - e.t < STALE_MS ? e.v : null;
            out[k][c] = v;
            if (k === 'p' && v !== null) any = true;
        }));
        return any ? out : null;
    }
}

/**
 * The condensed Tyres readout for the readouts row: { label, value, tone } of the worst tyre (for the layouts
 * whose readouts are a label and a value: 'TYRE RR', '2.1'), plus tyres: [[text, tone] FL, FR, RL, RR] and
 * block: 'TYRES' for the layouts that draw the four in a 2x2 block. Worst: the lowest against its target (the
 * lowest pressure without targets). Its tone is 'text' while every tyre is green, so a fine readout gives way
 * like any plain one. null without pressures.
 */
function readout(ty, unit) {
    if (!ty) return null;
    let worst = null, wr = Infinity;
    const cells = CORNERS.map((c) => {
        const p = ty.p[c], tgt = ty.tgt[c];
        if (isNum(p)) {
            const r = isNum(tgt) && tgt > 0 ? p / tgt : p / 100;
            if (r < wr) { wr = r; worst = c; }
        }
        return [fmtP(p, unit), toneOf(p, tgt) || 'text'];
    });
    if (!worst) return null;
    const t = toneOf(ty.p[worst], ty.tgt[worst]);
    return { label: 'TYRE ' + worst, value: fmtP(ty.p[worst], unit), tone: t === 'low' ? 'text' : t, tyres: cells, block: 'TYRES' };
}

/** The corners well under their target (red), e.g. ['RR'], for the low-tyre alert. */
function lowCorners(ty) {
    return ty ? CORNERS.filter((c) => toneOf(ty.p[c], ty.tgt[c]) === 'hot') : [];
}

Tyres.CORNERS = CORNERS; Tyres.UNITS = UNITS;
Tyres.toneOf = toneOf; Tyres.fmtP = fmtP; Tyres.readout = readout; Tyres.lowCorners = lowCorners;
module.exports = Tyres;
