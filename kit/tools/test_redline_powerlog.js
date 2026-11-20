'use strict';
// Redline's power log (apps/redline/powerlog.js): the car's own power / fuel displays logged raw while the readouts
// that would use them are on, each field at most every GAP_MS, at most MAX_RUN_MS per start. Node 8 compatible.
const fs = require('fs'), os = require('os'), path = require('path');
const TH = require('./redline_test_harness');
const PL = require(path.join(__dirname, '..', '..', 'apps', 'redline', 'powerlog'));
const tally = TH.counter(), ok = tally.ok, sleep = TH.sleep;
const E2 = 'de.bmw.infotainment.drivingexcitement.Efficiencytainment2', RL = 'de.bmw.infotainment.resetlogic.ResetLogic';

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-power-'));
    let on = true, t = 1000000;
    const p = PL.start({ dataDir: dir, wanted: () => on, now: () => ({ hvKw: -12.34, lph: null, kmh: 48 }), clock: () => t });
    const h = p.handlers();
    ok(h[E2] && typeof h[E2].statusPowerRelativHybrid === 'function' && h[RL] && typeof h[RL].currentConsumption === 'function', 'handlers for every logged field');
    const file = path.join(dir, 'redline-power.log'), read = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
    h[E2].statusPowerRelativHybrid({ displayActualValuePowerRelativeRecuperation: 3, displayActualValuePowerRelativeDrivingElectric: 0 });
    ok(/relHybrid = \{"displayActualValuePowerRelativeRecuperation":3,"displayActualValuePowerRelativeDrivingElectric":0\} \| redline kW -12.3 l\/h - km\/h 48/.test(read()), 'a value logged raw, with Redline\'s own kW and speed beside it');
    // the same value again: nothing; a new one within the gap: written once at its end, the last value of the gap
    h[E2].statusPowerRelativHybrid({ displayActualValuePowerRelativeRecuperation: 3, displayActualValuePowerRelativeDrivingElectric: 0 });
    t += 500; h[E2].statusPowerRelativHybrid({ a: 1 });
    t += 500; h[E2].statusPowerRelativHybrid({ a: 2 });
    ok((read().match(/relHybrid/g) || []).length === 1, 'within the gap: held');
    t += PL.GAP_MS; await sleep(PL.GAP_MS + 200);
    ok((read().match(/relHybrid/g) || []).length === 2 && /relHybrid = \{"a":2\}/.test(read()) && !/"a":1/.test(read()), 'at the end of the gap: the last value only');
    // not wanted (the readouts off): nothing
    on = false; h[RL].currentConsumption({ x: 1 });
    ok(!/consNow/.test(read()), 'readouts off: nothing logged');
    // a throwing value never throws out of the handler
    on = true;
    let threw = false; const cyc = {}; cyc.self = cyc;
    try { h[RL].averageConsumption(cyc); } catch (e) { threw = true; }
    ok(!threw, 'a value that can\'t be written never throws');
    // after MAX_RUN_MS: no more writes this start
    t += PL.MAX_RUN_MS + 1; h[RL].currentConsumption({ y: 1 });
    ok(!/consNow/.test(read()), 'after ' + PL.MAX_RUN_MS / 60000 + ' min of logging: stops for this start');
    p.stop();
    // no data folder (the preview): no file, no errors
    const q = PL.start({ wanted: () => true });
    let qt = false; try { q.handlers()[E2].statusChargeOfBatteryHybrid({ v: 1 }); } catch (e) { qt = true; }
    ok(!qt, 'no data folder: quiet');
    q.stop();
    console.log('redline power log: ' + tally.checks + ' checks, ' + tally.fails + ' failed');
    process.exit(tally.fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e.stack || e)); process.exit(1); });
