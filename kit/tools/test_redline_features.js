'use strict';

// Redline HUD feature matrix: every option of every setting that changes the HUD's picture, on every
// layout, as the app runs it (optsFrom -> readoutsFor -> drawHud). An option that leaves the picture
// unchanged on a layout is a failure unless that layout is listed below as not having it (its settings
// row is hidden there, or the README says the layout keeps its own look).
//   node kit/tools/test_redline_features.js          (--table: print the whole matrix)

const path = require('path');
const TH = require('./redline_test_harness');
const ROOT = TH.ROOT;
const APP = path.join(ROOT, 'apps', 'redline');
TH.hookKit();
const Hud = require(path.join(APP, 'hud'));
const Draw = require(path.join(APP, 'hud-draw'));
const { Canvas } = require(path.join(ROOT, 'kit', 'runtime', 'canvas'));
const { spec, def } = TH.redlineDefaults();

const LAYOUTS = spec.settings.find((s) => s.key === 'hudStyle').options.map((o) => o[0]);
const SEG7 = ['digital', 'vfd'], M = ['arc', 'ramp', 'dial'];
// what a layout doesn't have, so the option can't change it (with why)
const NOT_ON = {
    hudPalette: { layouts: ['vfd'].concat(M), why: 'own colours (the row is hidden there)' },
    hudGearFont: { layouts: SEG7.concat(['vector']), why: '7-segment gear (the row is hidden there)' },
    hudUnlit: { layouts: ['vfd'], why: 'unlit segments always faintly lit (the row is hidden there)' },
    hudLightStyle: { layouts: ['wings', 'arc', 'ramp', 'dial'], why: 'GT3 / left to right: these fill their own way (Off still works)', only: 'bar' },
    hudShowRpm: { layouts: ['minimal', 'wings'], why: 'no readouts row' },
    hudRpmFormat: { layouts: ['minimal', 'wings'].concat(SEG7), why: 'no readouts row / own 7-segment rpm' },
    hudLabels: { layouts: ['minimal', 'wings'], why: 'no labels drawn' },
    hudBoost: { layouts: ['minimal', 'wings'], why: 'no readouts row' },
    hudBoostUnit: { layouts: ['minimal', 'wings'], why: 'no readouts row' },
    hudShowSpeed: { layouts: ['minimal', 'wings'], why: 'no readouts row' },
    hudShowTorque: { layouts: ['minimal', 'wings'], why: 'no readouts row' },
    hudShowPower: { layouts: ['minimal', 'wings'], why: 'no readouts row' },
    hudShowG: { layouts: ['minimal', 'wings'], why: 'no readouts row' },
    hudPowerUnit: { layouts: ['minimal', 'wings'], why: 'no readouts row' },
    hudTorqueUnit: { layouts: ['minimal', 'wings'], why: 'no readouts row' },
    hudTempUnit: { layouts: ['minimal', 'wings'], why: 'no readouts row' },
    hudShowOil: { layouts: ['minimal', 'wings'], why: 'no readouts row' },
    hudShowWater: { layouts: ['minimal', 'wings'], why: 'no readouts row' },
    hudShowGearbox: { layouts: ['minimal', 'wings'], why: 'no readouts row' },
    hudShowOutside: { layouts: ['minimal', 'wings'], why: 'no readouts row' },
    hudShowKnock: { layouts: ['minimal', 'wings'], why: 'no readouts row' },
    hudShowLimit: { layouts: ['minimal', 'wings'], why: 'no readouts row' },
    hudShowTyres: { layouts: ['minimal', 'wings'], why: 'no readouts row' },
    hudTyreUnit: { layouts: ['minimal', 'wings'], why: 'no readouts row' },
    hudShowBattSoc: { layouts: ['minimal', 'wings'], why: 'no readouts row' },
    hudShowBattVolt: { layouts: ['minimal', 'wings'], why: 'no readouts row' },
    hudShowHvSoc: { layouts: ['minimal', 'wings'], why: 'no readouts row' },
    hudShowHvPower: { layouts: ['minimal', 'wings'], why: 'no readouts row' },
    hudShowHvTemp: { layouts: ['minimal', 'wings'], why: 'no readouts row' },
    hudShowHvVolt: { layouts: ['minimal', 'wings'], why: 'no readouts row' },
    hudShowHvBar: { layouts: ['minimal', 'wings'], why: 'no readouts row' },
    hudShowFuel: { layouts: ['minimal', 'wings'], why: 'no readouts row' },
    hudFuelUnit: { layouts: ['minimal', 'wings'], why: 'no readouts row' },
    hudTempsMode: { layouts: ['minimal', 'wings'], why: 'no readouts row' },
    hudChip: { layouts: ['minimal', 'wings'], why: 'no grade drawn' },
    hudShowBar: { layouts: ['minimal', 'dial'], why: 'no bar (dial: the band is the shift lights too)' },
    hudPeak: { layouts: ['minimal'], why: 'no bar' },
};

// the data: revs counting in, a grade just made, temperatures hot / cold, every extra value there
const D = { rpm: 5637, gear: 3, stage: 'D', oil: 95, coolant: 90 };
// (the electrical values too: a plug-in hybrid; test_redline_hud.js checks a petrol car shows none of the hybrid ones)
// the tyres (as the demo has them: one a little under its target, one well under)
const TY = Hud.demoAt(0).tyres;
const X = { tyres: TY, torque: 400, gLat: 0.4, gLong: 0.3, outside: 2, pedal: 60, knock: 3, soc12: 82, v12: 14.2, hvSoc: 64, hvKw: -18, hvTemp: 27, hvVolt: 352, fuelLph: 9.6, kmh: 80 };
function picture(over, style, state) {
    const settings = { get: (k) => (k in over ? over[k] : def[k]) };
    const o = Object.assign({}, Hud.optsFrom(settings), { style: style });
    o.gearFont = Hud.gearFontOf(settings.get('hudGearFont'), style);
    const lim = state === 'limiter', sh = state === 'shift';
    const d = Object.assign({}, D, lim ? { rpm: 6600 } : sh ? { rpm: 6250 } : {});
    const cue = { from: 4400, at: 6200, shift: sh, limiter: lim };
    const f = {
        d: d, shift: 6200, redline: 6550, max: 8000, blink: true, cue: cue, down: 1, peak: o.peak ? 6400 : 0,
        chip: state === 'graded' && o.chip !== 'off' ? { verdict: 'SPOT ON', age: 150, burst: o.chip === 'burst' } : null,
        shake: o.shake && lim ? [2, 1] : null,
        readouts: Hud.readoutsFor(d, 85, 1.1, { rpm: 6200, cold: true }, o, X), mode: o.mode ? 'M' : null, opts: o,
    };
    const cv = new Canvas(Draw.IW, Draw.IH);
    Draw.drawHud(cv, f);
    return Buffer.from(cv.d);
}
const shot = (over, style) => Buffer.concat(['count', 'shift', 'limiter', 'graded'].map((st) => picture(over, style, st)));
// a readout setting is checked with only its readout on (the row holds four), temperatures always shown
const NONE = { hudShowSpeed: false, hudShowRpm: false, hudBoost: false, hudShowOil: false, hudShowWater: false, hudShowGearbox: false, hudShowLimit: false, hudShowOutside: false,
    hudShowTorque: false, hudShowPower: false, hudShowG: false, hudShowKnock: false, hudTempsMode: 'always' };
// the hybrid readouts are checked on a car that has shown a hybrid battery
const HY = { hudHybridSeen: true };
const ALONE = {
    hudShowRpm: { hudShowRpm: true }, hudRpmFormat: { hudShowRpm: true }, hudBoost: { hudBoost: true }, hudBoostUnit: { hudBoost: true }, hudLabels: { hudBoost: true },
    hudShowSpeed: {}, hudShowTorque: {}, hudShowPower: {}, hudShowG: {}, hudTorqueUnit: { hudShowTorque: true }, hudPowerUnit: { hudShowPower: true },
    hudShowOil: { hudShowOil: true }, hudShowWater: { hudShowWater: true }, hudShowGearbox: { hudShowGearbox: true }, hudTempUnit: { hudShowOil: true },
    hudShowOutside: {}, hudShowLimit: { hudShowLimit: true }, hudTempsMode: { hudShowOil: true, hudTempsMode: 'smart' }, hudShowKnock: {},
    hudShowTyres: {}, hudTyreUnit: { hudShowTyres: true },
    hudShowBattSoc: {}, hudShowBattVolt: {}, hudShowHvSoc: HY, hudShowHvPower: HY, hudShowHvTemp: HY, hudShowHvVolt: HY,
    hudShowHvBar: HY, hudShowFuel: {}, hudFuelUnit: { hudShowFuel: true },
};
const ctxOf = (key) => (ALONE[key] ? Object.assign({}, NONE, ALONE[key]) : {});

// every option that isn't the default, of the settings that change the picture
// hudHybridSeen: found by the app, not a choice (it only lets the hybrid switches work: test_redline_hud.js)
// the tyre widget's settings: its own picture in the directions' corner, not the tach's (test_redline_hud.js,
// test_redline_running.js); hudTyresSeen: found by the app
const SKIP = ['hudHybridSeen', 'hudTyresSeen', 'hudTyreWidget', 'hudTyreCar', 'hudTyreTarget', 'hudTyreTemp', 'hudAll', 'hudKnockWarn', 'hudLaunch', 'hudComfortMode', 'hudHybridMode', 'hud', 'hudSize', 'hudX', 'hudY', 'hudFps', 'hudReadoutRate', 'hudLead', 'hudHandBack', 'hudComfort', 'hudStyle',
    // the directions: their own layer (test_redline_hud_nav.js), not the tach's picture
    'hudNav', 'hudNavX', 'hudNavY'];
const variants = [];
spec.settings.filter((s) => s.key && (/^hud/.test(s.key) || s.key === 'lights') && SKIP.indexOf(s.key) < 0).forEach((s) => {
    if (s.type === 'bool') variants.push([s.key, !s.default]);
    else if (s.options) s.options.forEach((op) => { if (String(op[0]) !== String(s.default)) variants.push([s.key, op[0]]); });
});

const tally = TH.counter();
const table = [];
const base = {};
LAYOUTS.forEach((st) => { base[st] = shot({}, st); });
variants.forEach(([key, value]) => {
    const row = { setting: key + '=' + value };
    LAYOUTS.forEach((st) => {
        const ctx = ctxOf(key), over = Object.assign({}, ctx); over[key] = value;
        const same = Buffer.compare(shot(over, st), Object.keys(ctx).length ? shot(ctx, st) : base[st]) === 0;
        const n = NOT_ON[key];
        // Auto already is that font there
        const autoIs = key === 'hudGearFont' && Hud.gearFontOf('auto', st) === Hud.gearFontOf(value, st);
        const excused = autoIs || (n && n.layouts.indexOf(st) >= 0 && (!n.only || n.only === String(value)));
        row[st] = same ? (excused ? '-' : 'NO CHANGE') : 'ok';
        tally.ok(!same || excused, key + '=' + value + ' changes nothing on ' + st);
    });
    table.push(row);
});
// the app-wide shift light style must change every layout's lights (the old Race-colours bug)
if (process.argv.indexOf('--table') >= 0) console.table(table);
console.log('Redline HUD features: ' + tally.checks + ' setting x layout checks, ' + tally.fails + ' with no change where there should be one');
process.exit(tally.fails ? 1 : 0);
