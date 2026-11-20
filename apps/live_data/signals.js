'use strict';
/**
 * signals.js - what the car sends the head unit on its own over SOME/IP: the Car signals page and its
 * tiles. Nothing is asked of any control unit for these (no diagnostic request), so they come as fast
 * as the car sends them, whatever else reads the car.
 *
 * Each value: { id, name, i: interface, f: field, m: member of the field's struct, k, o, u, d }
 *   value = raw * k + o, shown in u with d decimals
 *   bad: raw values that mean "no data"; max: raw values from this one up are no data;
 *   lim: [lo, hi] a value outside is no data; s16: the raw value is a signed 16 bit number;
 *   e: { enum name or number: text } (null = no data; other names are shown in words);
 *   fn(struct) -> { n, u } / { text } / { bad }: the value from the whole struct instead of one member;
 *   alt: [{ i, f, m, fn }] other fields that carry the same value (the newest one is shown);
 *   calc(get) -> the value from other values (get(id) = their { n, u } or null);
 *   raw: BMW's scaling isn't known yet: the raw number is shown (x: as hex), the log has it for calibrating;
 *   q: the scaling is a best guess (marked "scale?" on screen) - check it against the engine unit or the
 *   cluster, then drop the mark.
 * Known scalings: BMW's own (M Laptimer's TypeConverters, x_call's converters); M Vitals for the rest.
 */
const CDS = 'de.bmw.infotainment.vehicle.CDS', CDS2 = 'de.bmw.infotainment.vehicle.CDS2', V2 = 'de.bmw.infotainment.vehicle.Vehicle2';
// the car's display units (Vehicle.statusNewCurrentUnitsStatusExt, set by main.js): the sport display's boost and the
// tyre pressures come in the car's pressure unit; shown here in bar
const units = { press: null };
const PRESS_UNITS = { 1: 'BAR', 2: 'KPA', 3: 'PSI' };
const pressUnitOf = (x) => PRESS_UNITS[x] || (['BAR', 'KPA', 'PSI'].indexOf(x) >= 0 ? x : null);
// boost: 0.01 bar or 1 kPa a step, 0.1 psi a step (issue #186); tyres: 0.1 bar / kPa / psi a step
const boostK = () => (units.press === 'PSI' ? 0.1 / 14.5038 : 0.01);
const tyreK = () => (units.press === 'PSI' ? 0.1 / 14.5038 : units.press === 'KPA' ? 0.001 : 0.1);
const KOMBI = 'de.bmw.infotainment.KombiIF', FES = 'de.bmw.infotainment.drivingexcitement.FES', TPMS = 'de.bmw.infotainment.vehicle.TPMS';
const VI = 'de.bmw.infrastructure.VehicleInformation', ENV = 'de.bmw.infrastructure.EnvironmentalInformation';
const PEDAL = 'de.bmw.powertrain.AcceleratorPedal', PT = 'de.bmw.powertrain.Powertrain';
const STEER = 'de.bmw.chassis.SteeringAngle', VM = 'de.bmw.chassis.VehicleModel', DSC = 'de.bmw.chassis.VehicleStabilizationManagement';
const G0 = 9.80665;

// how often to read the fields a car may not notify (BMW's x_call only ever reads TPMS, it never subscribes)
const POLL = { [TPMS]: 10000, [KOMBI]: 10000 };

/** an enum name in words: SPORT_INDIVIDUAL -> Sport individual */
function words(x) {
    const s = String(x).replace(/_+/g, ' ').trim().toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1);
}
const NO_ENUM = /UNGUELTIG|UNBEFUELLT|INITIALISIERUNG|NICHT_VERFUEGBAR|RESERVIERT|FEHLER/;

/** P / R / N and the gear from DataPowerTrain2 (names or wire numbers: N = 1, R = 2, P = 3, NP = 4, _1 = 5 ... _9 = 13) */
function selection(v) {
    const x = v.statusGearSelectionDrive;
    const n = typeof x === 'number' ? x : { N: 1, R: 2, P: 3, NP: 4 }[x] || (/^_\d$/.test(String(x)) ? 4 + Number(String(x).slice(1)) : 0);
    if (n === 1) return { text: 'N' };
    if (n === 2) return { text: 'R' };
    if (n === 3) return { text: 'P' };
    if (n === 4) return { text: 'N or P' };
    if (n >= 5 && n <= 13) return { text: 'D' + (n - 4) };
    return { bad: true };
}
/** the selector and the gear from statusGearboxDrive (stage P = 1 ... D = 4, gear G1 = 3 ... G10 = 12, R = 1, N_OR_P = 2) */
function gearbox(v) {
    const st = v.statusActualStageDrive, g = v.statusActualGearDrive;
    const stage = { P: 'P', R: 'R', N: 'N', D: 'D', 1: 'P', 2: 'R', 3: 'N', 4: 'D' }[st];
    const gear = typeof g === 'number' ? (g >= 3 && g <= 12 ? g - 2 : null) : /^G\d+$/.test(String(g)) ? Number(String(g).slice(1)) : null;
    if (!stage) return { bad: true };
    return { text: stage + (stage === 'D' && gear ? gear : '') };
}
const unitOf = (x, map) => map[x] || '';
const CONS = { VERBRAUCH_IN_L_S_100KM: 'l/100km', VERBRAUCH_IN_MPG_UK: 'mpg', VERBRAUCH_IN_MPG_US: 'mpg US', VERBRAUCH_IN_KM_S_L: 'km/l', 1: 'l/100km', 2: 'mpg', 3: 'mpg US', 4: 'km/l' };
const SPEEDS = { KM_S_H__KM: 'km/h', MPH__MLS: 'mph', 1: 'km/h', 2: 'mph' };
const corner = (name, list, extra) => ['front left', 'front right', 'rear left', 'rear right'].map((w, n) => Object.assign({ id: list[n][0], name: name + ', ' + w, m: list[n][1] }, extra));

const GROUPS = [
    { group: 'Engine', items: [
        { id: 'rpm', name: 'Engine speed', i: CDS, f: 'statusEngineSpeed2', m: 'actualValueRPMEngineCrankshaft', k: 0.25, u: 'rpm', d: 0, bad: [65535] },
        // 12 bit, 0.5 Nm a step, 0 Nm at 2047 (negative = engine braking), 4095 = no value
        { id: 'torque', name: 'Engine torque', i: FES, f: 'statusActualValueTorque2', m: 'actualValueTorqueCrankshaft', k: 0.5, o: -1023.5, u: 'Nm', d: 0, max: 4095 },
        { id: 'power', name: 'Engine power (torque x speed)', calc: (get) => { const t = get('torque'), r = get('rpm'); return t && r ? { n: Math.max(0, t.n) * r.n / 9549, u: 'kW' } : null; }, d: 0 },
        { id: 'powerPct', name: 'Power, % of maximum (sport display)', i: FES, f: 'statusVehicleDynamicEngine', m: 'displaySportEnginePower', u: '%', d: 0, bad: [255] },
        { id: 'torquePct', name: 'Torque, % of maximum (sport display)', i: FES, f: 'statusVehicleDynamicEngine', m: 'displaySportEngineTorque', u: '%', d: 0, bad: [255] },
        { id: 'powerMax', name: 'Maximum power (sport display)', i: FES, f: 'statusVehicleDynamicEngineMaxValue', m: 'displayMaximumValuePower', raw: true, bad: [65535] },
        { id: 'torqueMax', name: 'Maximum torque (sport display)', i: FES, f: 'statusVehicleDynamicEngineMaxValue', m: 'displayMaximumValueTorque', raw: true, bad: [65535] },
        { id: 'boost', name: 'Boost (sport display)', i: FES, f: 'statusSwitchDriveDynamicSport2', m: 'displayBoostPressure', k: boostK, u: 'bar', d: 2, bad: [255], q: true },
        { id: 'boostMax', name: 'Boost peak (sport display)', i: FES, f: 'statusSwitchDriveDynamicSport2', m: 'displayMaximumValueBoostPressure', k: boostK, u: 'bar', d: 2, bad: [255], q: true },
        { id: 'pedal', name: 'Accelerator pedal', i: PEDAL, f: 'AngleAcceleratorPedal', m: 'actualValueAngleAcceleratorPedal', k: 0.025, u: '%', d: 0, lim: [-2, 102], q: true },
        { id: 'coolant', name: 'Coolant', i: CDS, f: 'statusEngineTemperature', m: 'temperatureEngineDrive', o: -48, u: '°C', d: 0, bad: [255] },
        { id: 'oil', name: 'Engine oil', i: CDS, f: 'statusEngineTemperature', m: 'temperatureEngineOilDrive', o: -48, u: '°C', d: 0, bad: [255] },
        { id: 'oil2', name: 'Engine oil (fuel signal)', i: CDS2, f: 'statusInjectionVolume', m: 'oilTemperature', o: -48, u: '°C', d: 0, bad: [255], q: true },
        { id: 'running', name: 'Engine', i: CDS, f: 'statusEngineStatus', m: 'statusEngineRunDrive', e: { MOTOR_AUS: 'off', MOTOR_STARTET: 'starting', MOTOR_LAEUFT: 'running', 0: 'off', 1: 'starting', 2: 'running', 3: null } },
        { id: 'msa', name: 'Auto start-stop', i: CDS2, f: 'statusPushButtonMSA2', m: 'statusFunctionMSA', e: { MSA_AKTIVIERT: 'on', MSA_DEAKTIVIERT: 'off', 0: 'off', 1: 'on', 3: null } },
    ] },
    { group: 'Fuel and trip', items: [
        { id: 'tank', name: 'Fuel in the tank', i: KOMBI, f: 'statusRangeTankStatus', m: 'fluidLevelFuelTank', u: 'l', d: 0, max: 255 },
        { id: 'tankL', name: 'Fuel tank, left half', i: KOMBI, f: 'statusRangeTankStatus', m: 'fluidLevelFuelTankLeftHand', u: 'l', d: 0, max: 255, q: true },
        { id: 'tankR', name: 'Fuel tank, right half', i: KOMBI, f: 'statusRangeTankStatus', m: 'fluidLevelFuelTankRightHand', u: 'l', d: 0, max: 255, q: true },
        { id: 'range', name: 'Range', i: KOMBI, f: 'statusRangeTankStatus', m: 'range', u: 'km', d: 0, max: 4095 },
        { id: 'odo', name: 'Odometer', i: KOMBI, f: 'statusRangeTankStatus', m: 'mileageKilometre', u: 'km', d: 0, max: 16777215, alt: [{ i: VI, f: 'Range' }] },
        // the fuel injection signal: taken as a counter of injected fuel; l/h = its rate x a factor learned
        // from the engine unit's own fuel consumption (main.js) - the raw value is next to it to check
        { id: 'flow', name: 'Fuel consumption (car signal)', flow: true, u: 'l/h', d: 1 },
        { id: 'instant', name: 'Fuel consumption per 100 km', calc: (get) => { const f = get('flow'), s = get('speed'); return f && f.calib ? f : !f || !s ? null : s.n < 5 ? { text: 'standing', dim: true } : { n: f.n / s.n * 100, u: 'l/100km' }; }, d: 1 },
        { id: 'fuelRaw', name: 'Fuel injection signal (raw)', i: CDS2, f: 'statusInjectionVolume', m: 'injectionVolumeFuelEngine', raw: true },
        { id: 'avgCons1', name: 'Average consumption, trip 1', i: KOMBI, f: 'statusBordcomputerAverage', m: 'consumptionAverage1BC1', k: 0.1, d: 1, bad: [65535], q: true, u: (v) => unitOf(v.statusUnitOfMeasurementConsumptionBC, CONS) },
        { id: 'avgSpeed1', name: 'Average speed, trip 1', i: KOMBI, f: 'statusBordcomputerAverage', m: 'speedAverage1BC1', k: 0.1, d: 1, bad: [65535], q: true, u: (v) => unitOf(v.statusUnitOfMeasurementSpeedBC, SPEEDS) },
        { id: 'avgCons2', name: 'Average consumption, trip 2', i: KOMBI, f: 'statusBordcomputerAverage', m: 'consumptionAverage2BC2', k: 0.1, d: 1, bad: [65535], q: true, u: (v) => unitOf(v.statusUnitOfMeasurementConsumptionBC, CONS) },
        { id: 'avgSpeed2', name: 'Average speed, trip 2', i: KOMBI, f: 'statusBordcomputerAverage', m: 'speedAverage2BC2', k: 0.1, d: 1, bad: [65535], q: true, u: (v) => unitOf(v.statusUnitOfMeasurementSpeedBC, SPEEDS) },
        { id: 'tripTime', name: 'Driving time', i: KOMBI, f: 'statusBordcomputerTravelData', fn: (v) => (typeof v.rideDurationHours === 'number' && typeof v.rideDurationMinutes === 'number' && v.rideDurationHours < 65535 && v.rideDurationMinutes < 60
            ? { text: v.rideDurationHours + ':' + String(v.rideDurationMinutes).padStart(2, '0') + ' h' } : { bad: true }) },
        { id: 'tripDist', name: 'Distance driven', i: KOMBI, f: 'statusBordcomputerTravelData', m: 'wayPassed', u: 'km', d: 0, bad: [65535], q: true },
    ] },
    // Live Data's own trip computer (trips.js) from the values above: for screens and the widget
    { group: 'Trip computer', items: [
        { id: 'tcKm', name: 'Distance, this trip', tc: 'km', u: 'km', d: 1 },
        { id: 'tcFuel', name: 'Fuel used, this trip', tc: 'fuel', u: 'l', d: 2 },
        { id: 'tcAvg', name: 'Consumption, this trip', tc: 'avg', u: 'l/100 km', d: 1 },
        { id: 'tcCost', name: 'Cost of this trip', tc: 'cost', d: 2 },
        { id: 'tcTime', name: 'Time, this trip', tc: 'time' },
    ] },
    { group: 'Driving', items: [
        { id: 'speed', name: 'Speed', i: V2, f: 'statusCarSpeed2', m: 'speedVehicleCentreOfGravity', k: 0.015625, u: 'km/h', d: 0, bad: [65535] },
        { id: 'gear', name: 'Gear', i: VI, f: 'DataPowerTrain2', fn: selection, alt: [{ i: VI, f: 'statusGearboxDrive', fn: gearbox }] },
        { id: 'mode', name: 'Driving mode', i: FES, f: 'statusFESVehicleDynamicSwitchHMI', m: 'actualValueModeDrivingExperience', e: { SPORT_DYNAMIC: 'Sport', SPORT_EXPERT: 'Sport plus', ECO_PRO_EFFICIENT: 'Eco pro', 1: 'Sport', 2: 'Sport plus', 3: 'Sport individual', 4: 'Comfort', 5: 'Comfort plus', 6: 'Comfort individual', 7: 'Eco pro', 8: 'Eco pro plus', 9: 'Eco pro individual', 10: 'Adaptive', 0: null, 61: null, 62: null, 63: null } },
        { id: 'gLong', name: 'Acceleration, forward', i: CDS2, f: 'statusLongitudinalAccelerationMassCenter', m: 'longitudinalAccelerationCentreOfGravity', k: 0.002 / G0, o: -65 / G0, u: 'g', d: 2, bad: [65535] },
        { id: 'gLat', name: 'Acceleration, sideways', i: CDS2, f: 'statusLateralAccelerationMassCenter', m: 'lateralAccelerationCentreOfGravity', k: 0.002 / G0, o: -65 / G0, u: 'g', d: 2, bad: [65535] },
        { id: 'yaw', name: 'Yaw rate', i: CDS2, f: 'statusYawVelocityVehicle', m: 'yawVelocityVehicle', k: 0.005, o: -163.84, u: '°/s', d: 1, bad: [65535], q: true },
        { id: 'roll', name: 'Roll rate', i: CDS, f: 'datenFahrdynamiksensorErweitert', m: 'wankgeschwindigkeitSchwerpunkt', k: 0.005, o: -163.84, u: '°/s', d: 1, bad: [65535], q: true },
        { id: 'pitch', name: 'Pitch rate', i: CDS, f: 'datenFahrdynamiksensorErweitert', m: 'nickgeschwindigkeitSchwerpunkt', k: 0.005, o: -163.84, u: '°/s', d: 1, bad: [65535], q: true },
        { id: 'steer', name: 'Steering wheel angle', i: STEER, f: 'ActualSteeringAngleDriver', m: 'actualValueSteeringAngleDriver', s16: true, k: 0.04395, u: '°', d: 0, lim: [-900, 900], q: true,
            alt: [{ i: STEER, f: 'actualSteeringAngleDriverNoCRC' }] },
        { id: 'handbrake', name: 'Parking brake', i: CDS, f: 'statusHandBrake', m: 'statusContactHandBrake', e: { HANDBREMSE_ANGEZOGEN: 'applied', HANDBREMSE_GELOEST: 'released', NICHT_CODIERT: null, 1: 'released', 2: 'applied', 0: null, 3: null } },
        { id: 'outside', name: 'Outside temperature', i: ENV, f: 'ExteriorTemperature', m: 'temperatureExterior', k: 0.5, o: -40, u: '°C', d: 1, bad: [255] },
        { id: 'battery', name: '12 V battery charge', i: CDS, f: 'statusBattery2', m: 'conditionBatteryChargingCondition', u: '%', d: 0, max: 151 },
        { id: 'oilLevel', name: 'Engine oil level', i: V2, f: 'statusOilDipstick2', m: 'fluidLevelEngineOilRelative', e: { MOTOROELSTAND_UNTER_MINIMUM: 'below minimum', MOTOROELSTAND_AM_MINIMUM: 'at minimum', MOTOROELSTAND_1_4: '1/4',
            MOTOROELSTAND_2_4: '2/4', MOTOROELSTAND_3_4: '3/4', MOTOROELSTAND_4_4: 'full', MOTOROELSTAND_5_4: 'above full', MOTOROELSTAND_UEBERFUELLT: 'overfilled', MOTOROELSTAND_OK: 'OK', SERVICEFUNKTION_AKTIV: 'measuring',
            0: 'below minimum', 1: 'at minimum', 2: '1/4', 3: '2/4', 4: '3/4', 5: 'full', 6: 'above full', 7: 'overfilled', 13: 'OK', 14: 'measuring', 15: null } },
    ] },
    { group: 'Tyres', items: [].concat(
        // 0.1 a step in the car's pressure unit (shown in bar), 65532 and up = no value (x_call); temperatures in °C + 40 (M Vitals, seen on a car)
        corner('Tyre pressure', [['pFL', 'actualValuePressureTyreFLH'], ['pFR', 'actualValuePressureTyreFRH'], ['pRL', 'actualValuePressureTyreRLH'], ['pRR', 'actualValuePressureTyreRRH']],
            { i: TPMS, f: 'statusTyrePressure', k: tyreK, u: 'bar', d: 1, max: 65532 }),
        corner('Tyre temperature', [['tFL', 'actualValueTemperatureTyreFLH'], ['tFR', 'actualValueTemperatureTyreFRH'], ['tRL', 'actualValueTemperatureTyreRLH'], ['tRR', 'actualValueTemperatureTyreRRH']],
            { i: TPMS, f: 'statusTyreTemperature', o: -40, u: '°C', d: 0, bad: [65535], lim: [-40, 150] }),
        corner('Tyre pressure target', [['ptFL', 'targetPressureTyreFLH'], ['ptFR', 'targetPressureTyreFRH'], ['ptRL', 'targetPressureTyreRLH'], ['ptRR', 'targetPressureTyreRRH']],
            { i: TPMS, f: 'statusTargetTyrePressure', k: tyreK, u: 'bar', d: 1, max: 65532 })) },
    // sent on the car's own networks; whether the head unit gets them, and their scaling, is still to be seen
    { group: 'Chassis (raw numbers)', items: [].concat(
        corner('Wheel speed', [['wFL', 'actualValueRPMWheelFLH'], ['wFR', 'actualValueRPMwheelFRH'], ['wRL', 'actualValueRPMWheelRLH'], ['wRR', 'actualValueRPMWheelRRH']],
            { i: PT, f: 'ActualValueRPMWheel', raw: true }), [
        { id: 'slope', name: 'Road gradient, along', i: VM, f: 'LaneSlope', m: 'actualValueLongitudinalGradientRoadway', raw: true },
        { id: 'slopeSide', name: 'Road gradient, across', i: VM, f: 'LaneSlope', m: 'actualValueTransverseGradientRoadway', raw: true },
        { id: 'mass', name: 'Vehicle mass', i: V2, f: 'statusVehicleMass', m: 'massVehicle', raw: true, alt: [{ i: VM, f: 'MassVehicle' }] },
        { id: 'abs', name: 'ABS status', i: DSC, f: 'StabilizationManagement', m: 'qualifierFunctionABS', raw: true, x: true },
        { id: 'asc', name: 'Traction control (ASC) status', i: DSC, f: 'StabilizationManagement', m: 'qualifierFunctionASC', raw: true, x: true },
        { id: 'dsc', name: 'Stability control (DSC) status', i: DSC, f: 'StabilizationManagement', m: 'qualifierFunctionFDR', raw: true, x: true },
        { id: 'braking', name: 'Driver braking', i: DSC, f: 'StabilizationManagement', m: 'statusBrakingDriver', raw: true },
    ]) },
];

const ITEMS = {};
GROUPS.forEach((g) => g.items.forEach((it) => { ITEMS[it.id] = it; }));
/** where a value comes from: [{ i, f, m, fn }] (the first, then the alternatives) */
const sourcesOf = (it) => (it.i ? [{ i: it.i, f: it.f, m: it.m, fn: it.fn }].concat((it.alt || []).map((a) => ({ i: a.i, f: a.f, m: a.m || it.m, fn: a.fn || (a.m ? null : it.fn) }))) : []);
/** every interface and field these values need: { iface: [field] } (what app.json "signals" must list) */
function fields() {
    const out = {};
    Object.keys(ITEMS).forEach((id) => sourcesOf(ITEMS[id]).forEach((s) => {
        const l = out[s.i] || (out[s.i] = []);
        if (l.indexOf(s.f) < 0) l.push(s.f);
    }));
    return out;
}
// the interface's last name, the long ones shortened (the source column on screen)
const SHORT = { VehicleStabilizationManagement: 'DSC', VehicleInformation: 'VehicleInfo', EnvironmentalInformation: 'Environment' };
const short = (iface) => { const n = iface.split('.').pop(); return SHORT[n] || n; };

/** one value from the struct of a field: { n, u } / { n, raw, x } / { text } / { bad: true } */
function value(it, src, v) {
    if (!v || typeof v !== 'object') return { bad: true };
    if (src.fn) return src.fn(v);
    let raw = v[src.m];
    if (typeof raw === 'string' && /^\d+$/.test(raw)) raw = Number(raw);
    if (raw === undefined || raw === null) return { bad: true };
    if (it.e) {
        const t = it.e[raw];
        if (t === null || (t === undefined && NO_ENUM.test(String(raw)))) return { bad: true };
        return { text: t !== undefined ? t : typeof raw === 'string' ? words(raw) : String(raw) };
    }
    if (typeof raw !== 'number') return { text: typeof raw === 'string' ? words(raw) : JSON.stringify(raw) };
    if ((it.bad && it.bad.indexOf(raw) >= 0) || (it.max !== undefined && raw >= it.max)) return { bad: true };
    if (it.raw) return { n: raw, raw: true, x: !!it.x };
    if (it.s16 && raw >= 32768) raw -= 65536;
    const n = raw * (it.k === undefined ? 1 : typeof it.k === 'function' ? it.k() : it.k) + (it.o || 0);
    if (it.lim && (n < it.lim[0] || n > it.lim[1])) return { bad: true };
    return { n, u: typeof it.u === 'function' ? it.u(v) : it.u };
}

/**
 * Fuel flow from the fuel injection signal, taken as a counter of injected fuel (16 bit, it wraps):
 * its rate in counts a second, over at least one second; l/h = rate x k. k is learned from the engine
 * unit's own consumption: learn(l/h) while both are known, the middle of the last ratios once they agree.
 */
class Flow {
    constructor(k) { this.k = k || null; this.last = null; this.acc = 0; this.accT = 0; this.rate = null; this.ratios = []; this.spread = null; }
    feed(raw, t) {
        if (typeof raw !== 'number' || !isFinite(raw)) return;
        if (this.last && t > this.last.t) {
            const d = (raw - this.last.raw + 65536) % 65536, dt = t - this.last.t;
            if (dt > 5000 || d > 40000) { this.acc = 0; this.accT = 0; }               // a gap or a reset: start again
            else {
                this.acc += d; this.accT += dt;
                if (this.accT >= 1000) { this.rate = this.acc / this.accT * 1000; this.rateT = t; this.acc = 0; this.accT = 0; }
            }
        }
        this.last = { raw, t };
    }
    /** counts a second now (0 once the signal stopped changing for 3 s: engine off) */
    rateAt(now) {
        if (!this.last) return null;
        if (now - this.last.t > 3000) return 0;
        return this.rate;
    }
    lph(now) { const r = this.rateAt(now); return r === null || !this.k ? null : r * this.k; }
    /** the engine unit's l/h at about the same time: true when k changed by more than 2 % */
    learn(lph, now) {
        const r = this.rateAt(now);
        if (!(r > 0) || !(lph > 0.5) || now - (this.rateT || 0) > 1500) return false;
        this.ratios.push(lph / r);
        if (this.ratios.length > 30) this.ratios.shift();
        if (this.ratios.length < 10) return false;
        const s = this.ratios.slice().sort((a, b) => a - b), q1 = s[Math.floor(s.length / 4)], q3 = s[Math.floor(s.length * 3 / 4)];
        this.spread = q3 / q1;
        if (this.spread > 1.3) return false;                                                // they don't agree (yet): not a counter?
        const k = s[Math.floor(s.length / 2)], old = this.k;
        this.k = k;
        return !old || Math.abs(k - old) / old > 0.02;
    }
}

/**
 * What a car would send, from the simulator's sample (Settings: Demo data, the preview): [[iface, field, struct]].
 * st keeps the fuel counter between calls.
 */
function demo(s, t, st) {
    const r = (x, k, o) => Math.max(0, Math.round((x - (o || 0)) / k));
    const kw = Math.max(0, s.torque) * s.rpm / 9549, lph = 0.8 + kw * 0.27;
    st.fuel = ((st.fuel || 0) + lph / 0.0036 * Math.min(0.2, (t - (st.t || t)) / 1000)) % 65536;
    st.t = t;
    const sec = t / 1000, wheel = r(s.speed / 3.6 / (Math.PI * 0.68) * 60, 0.1);
    return [
        [CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: r(s.rpm, 0.25) }],
        [CDS, 'statusEngineTemperature', { temperatureEngineDrive: r(s.coolant, 1, -48), temperatureEngineOilDrive: r(s.oil, 1, -48) }],
        [CDS, 'statusEngineStatus', { statusEngineRunDrive: 'MOTOR_LAEUFT' }],
        [CDS, 'statusHandBrake', { statusContactHandBrake: 'HANDBREMSE_GELOEST' }],
        [CDS, 'statusBattery2', { conditionBatteryChargingCondition: 84 }],
        [CDS, 'datenFahrdynamiksensorErweitert', { wankgeschwindigkeitSchwerpunkt: r(s.gLat * 4, 0.005, -163.84), nickgeschwindigkeitSchwerpunkt: r(s.gLong * -2, 0.005, -163.84) }],
        [CDS2, 'statusInjectionVolume', { injectionVolumeFuelEngine: Math.floor(st.fuel), oilTemperature: r(s.oil, 1, -48) }],
        [CDS2, 'statusLongitudinalAccelerationMassCenter', { longitudinalAccelerationCentreOfGravity: r(s.gLong * G0, 0.002, -65) }],
        [CDS2, 'statusLateralAccelerationMassCenter', { lateralAccelerationCentreOfGravity: r(s.gLat * G0, 0.002, -65) }],
        [CDS2, 'statusYawVelocityVehicle', { yawVelocityVehicle: r(s.speed > 1 ? s.gLat * G0 / (s.speed / 3.6) * 57.3 : 0, 0.005, -163.84) }],
        [CDS2, 'statusPushButtonMSA2', { statusFunctionMSA: 'MSA_DEAKTIVIERT' }],
        [V2, 'statusCarSpeed2', { speedVehicleCentreOfGravity: r(s.speed, 0.015625) }],
        [V2, 'statusOilDipstick2', { fluidLevelEngineOilRelative: 'MOTOROELSTAND_OK' }],
        [V2, 'statusVehicleMass', { massVehicle: 1810 }],
        [KOMBI, 'statusRangeTankStatus', { fluidLevelFuelTank: 41, fluidLevelFuelTankLeftHand: 20, fluidLevelFuelTankRightHand: 21, range: 452, mileageKilometre: 23817 }],
        [KOMBI, 'statusBordcomputerAverage', { consumptionAverage1BC1: 98, speedAverage1BC1: 463, consumptionAverage2BC2: 91, speedAverage2BC2: 512,
            statusUnitOfMeasurementConsumptionBC: 'VERBRAUCH_IN_L_S_100KM', statusUnitOfMeasurementSpeedBC: 'KM_S_H__KM' }],
        [KOMBI, 'statusBordcomputerTravelData', { rideDurationHours: 1, rideDurationMinutes: 12, wayPassed: 63 }],
        [FES, 'statusActualValueTorque2', { actualValueTorqueCrankshaft: r(s.torque, 0.5, -1023.5) }],
        [FES, 'statusVehicleDynamicEngine', { displaySportEnginePower: Math.round(Math.min(100, kw / 2.75)), displaySportEngineTorque: Math.round(Math.min(100, s.torque / 5)) }],
        [FES, 'statusVehicleDynamicEngineMaxValue', { displayMaximumValuePower: 275, displayMaximumValueTorque: 500 }],
        [FES, 'statusSwitchDriveDynamicSport2', { displayBoostPressure: r(Math.max(0, s.throttle * 1.1 + 0.05 * Math.sin(sec)), 0.01), displayMaximumValueBoostPressure: 116 }],
        [FES, 'statusFESVehicleDynamicSwitchHMI', { actualValueModeDrivingExperience: 'SPORT_DYNAMIC' }],
        [VI, 'DataPowerTrain2', { statusGearSelectionDrive: s.gear ? '_' + s.gear : 'P' }],
        [ENV, 'ExteriorTemperature', { temperatureExterior: r(11.5, 0.5, -40) }],
        [TPMS, 'statusTyrePressure', { actualValuePressureTyreFLH: 25, actualValuePressureTyreFRH: 25, actualValuePressureTyreRLH: 27, actualValuePressureTyreRRH: 26 }],
        [TPMS, 'statusTyreTemperature', { actualValueTemperatureTyreFLH: 62, actualValueTemperatureTyreFRH: 63, actualValueTemperatureTyreRLH: 60, actualValueTemperatureTyreRRH: 61 }],
        [TPMS, 'statusTargetTyrePressure', { targetPressureTyreFLH: 25, targetPressureTyreFRH: 25, targetPressureTyreRLH: 27, targetPressureTyreRRH: 27 }],
        [PEDAL, 'AngleAcceleratorPedal', { actualValueAngleAcceleratorPedal: r(s.throttle * 100, 0.025) }],
        [STEER, 'ActualSteeringAngleDriver', { actualValueSteeringAngleDriver: (Math.round(s.gLat * 120 / 0.04395) + 65536) % 65536 }],
        [PT, 'ActualValueRPMWheel', { actualValueRPMWheelFLH: wheel, actualValueRPMwheelFRH: wheel, actualValueRPMWheelRLH: wheel + 3, actualValueRPMWheelRRH: wheel + 3 }],
        [VM, 'LaneSlope', { actualValueLongitudinalGradientRoadway: 32768, actualValueTransverseGradientRoadway: 32768 }],
        [DSC, 'StabilizationManagement', { qualifierFunctionABS: 0, qualifierFunctionASC: 0, qualifierFunctionFDR: 0, statusBrakingDriver: s.gLong < -0.3 ? 1 : 0 }],
    ];
}

module.exports = { GROUPS, ITEMS, POLL, sourcesOf, fields, short, value, words, Flow, demo, units, pressUnitOf };
