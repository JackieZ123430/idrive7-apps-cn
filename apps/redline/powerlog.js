'use strict';
/**
 * Part of Redline's experimental features; README.md in this folder has the whole picture.
 *
 * The car's own power and fuel-use displays, logged raw to redline-power.log so their scales can be learned on a
 * drive (none is known yet; nothing in Redline shows them):
 *   Efficiencytainment2 statusPowerRelativHybrid (BMW's hybrid power meter: recovery and electric drive, UInt8
 *   each), statusChargeOfBatteryHybrid, displayPowerDrive / displayPowerDrive2; Efficiencytainment
 *   statusPowerRelativRecuperation; ResetLogic currentConsumption / averageConsumption; KombiIF
 *   statusDisplayElectricalPowerDistribution.
 * Written only while the fuel readout or the recovery / power bar is on (wanted()), for at most MAX_RUN_MS per
 * start of the app, each field at most every GAP_MS (the last value of the gap), and next to it what Redline
 * itself reads at that moment (now(): the hybrid battery's kW, the fuel rate, the speed), so the two can be put
 * side by side. 256 KiB, then renamed to .1 over the older one (two files at most). Never throws.
 */
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 256 * 1024, GAP_MS = 3000, MAX_RUN_MS = 30 * 60 * 1000;
const FIELDS = {
    'de.bmw.infotainment.drivingexcitement.Efficiencytainment2': { statusPowerRelativHybrid: 'relHybrid', statusChargeOfBatteryHybrid: 'chargeHybrid', displayPowerDrive: 'powerDrive', displayPowerDrive2: 'powerDrive2' },
    'de.bmw.infotainment.drivingexcitement.Efficiencytainment': { statusPowerRelativRecuperation: 'relRecup' },
    'de.bmw.infotainment.resetlogic.ResetLogic': { currentConsumption: 'consNow', averageConsumption: 'consAvg' },
    'de.bmw.infotainment.KombiIF': { statusDisplayElectricalPowerDistribution: 'powerDist' },
};

/**
 * opts: { dataDir, wanted: () => bool, now: () => { hvKw, lph, kmh } (Redline's own values, any may be null),
 * clock: () => ms (tests) }. Returns { handlers(), stop() }.
 */
function start(opts) {
    opts = opts || {};
    const clock = opts.clock || Date.now;
    const file = opts.dataDir ? path.join(opts.dataDir, 'redline-power.log') : null;
    const last = {}, pend = {}, at = {}, timers = {};
    let used = 0, runFrom = null, stopped = false;
    const wanted = () => { try { return !!(opts.wanted && opts.wanted()); } catch (e) { return false; } };
    const ours = () => {
        try {
            const n = opts.now ? opts.now() || {} : {};
            const f = (v, d) => (typeof v === 'number' && isFinite(v) ? v.toFixed(d) : '-');
            return ' | redline kW ' + f(n.hvKw, 1) + ' l/h ' + f(n.lph, 2) + ' km/h ' + f(n.kmh, 0);
        } catch (e) { return ''; }
    };
    const write = (line) => {
        if (!file || stopped) return;
        try {
            const t = clock();
            if (runFrom === null) runFrom = t;
            if (t - runFrom > MAX_RUN_MS) return;
            const st = fs.existsSync(file) ? fs.statSync(file) : null;
            if (st && st.size > MAX_BYTES) fs.renameSync(file, file + '.1');
            fs.appendFileSync(file, new Date().toISOString() + ' ' + line + '\n');
            used++;
        } catch (e) { /* a full or read-only disk: no log */ }
    };
    const flush = (k) => {
        try {
            timers[k] = null; at[k] = clock();
            const s = pend[k]; pend[k] = null;
            if (s !== null && s !== undefined && wanted()) write(k + ' = ' + s + ours());
        } catch (e) { /* never */ }
    };
    const handler = (k) => (v) => {
        try {
            if (stopped || !wanted()) return;
            const s = JSON.stringify(v);
            if (s === last[k]) return;
            last[k] = s; pend[k] = s;
            const wait = GAP_MS - (clock() - (at[k] || -Infinity));
            if (wait <= 0) flush(k);
            else if (!timers[k]) timers[k] = setTimeout(() => flush(k), wait);
        } catch (e) { /* never throw from a signal */ }
    };
    return {
        handlers() {
            const out = {};
            Object.keys(FIELDS).forEach((iface) => {
                out[iface] = {};
                Object.keys(FIELDS[iface]).forEach((f) => { out[iface][f] = handler(FIELDS[iface][f]); });
            });
            return out;
        },
        stop() { stopped = true; Object.keys(timers).forEach((k) => { if (timers[k]) clearTimeout(timers[k]); }); },
        lines: () => used,
    };
}

module.exports = { start, FIELDS, MAX_BYTES, GAP_MS, MAX_RUN_MS };
