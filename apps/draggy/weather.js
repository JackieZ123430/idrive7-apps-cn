'use strict';
/**
 * weather.js - Drag Timer: the outside air of a run, its density altitude, and times corrected to standard air.
 *
 * Power correction (SAE J1349, 2004): CF = 1.176 * (99 / p) * sqrt((T + 273) / 298) - 0.176, with p the dry air
 * pressure in kPa and T in deg C (25 deg C, 99 kPa = 1.000). The car tells no humidity, so the air counts as dry.
 * CF > 1: thin or hot air, the engine made less than it would in standard air.
 * A run limited by power: reaching a speed takes energy (time ~ 1 / P), covering a distance goes as P^-1/3 (Hale's
 * ET = k * (W / P)^1/3), the speed at the end as P^1/3. So, corrected to standard air:
 *     speed splits (0-100, 100-200) t / CF      distances (60 ft .. 1/2 mile) t / CF^(1/3)      trap v * CF^(1/3)
 * (A turbocharged engine makes up some of the thin air itself, so the correction overstates its loss up high.)
 * Density altitude: the height in the standard atmosphere with the same air density (ISA: 15 deg C, 101.325 kPa).
 */
const R_DRY = 287.05, RHO0 = 1.225;
const ok = (tempC, kPa) => typeof tempC === 'number' && isFinite(tempC) && tempC > -45 && tempC < 65
    && typeof kPa === 'number' && isFinite(kPa) && kPa >= 50 && kPa <= 115;

/** SAE J1349 correction factor, or null without plausible temperature and pressure. */
function sae(tempC, kPa) {
    if (!ok(tempC, kPa)) return null;
    return 1.176 * (99 / kPa) * Math.sqrt((tempC + 273) / 298) - 0.176;
}

/** Density altitude in metres (negative: denser than the standard sea-level air), or null. */
function densityAltitude(tempC, kPa) {
    if (!ok(tempC, kPa)) return null;
    const rho = kPa * 1000 / (R_DRY * (tempC + 273.15));
    return 44330.8 * (1 - Math.pow(rho / RHO0, 0.234969));
}

/** A time to standard air: a speed split (dist false) or a distance (dist true). null cf: no correction. */
function correctTime(s, cf, dist) {
    if (typeof s !== 'number' || !isFinite(s) || typeof cf !== 'number' || !(cf > 0)) return null;
    return dist ? s / Math.cbrt(cf) : s / cf;
}

/** A trap speed to standard air. */
function correctTrap(v, cf) {
    if (typeof v !== 'number' || !isFinite(v) || typeof cf !== 'number' || !(cf > 0)) return null;
    return v * Math.cbrt(cf);
}

/** { c, kPa, da, cf } of the air now: either part may be missing (null). */
function air(tempC, kPa) {
    const c = typeof tempC === 'number' && isFinite(tempC) ? tempC : null, p = typeof kPa === 'number' && isFinite(kPa) ? kPa : null;
    return { c, kPa: p, da: densityAltitude(c, p), cf: sae(c, p) };
}

module.exports = { sae, densityAltitude, correctTime, correctTrap, air };
