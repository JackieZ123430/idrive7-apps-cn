'use strict';
/**
 * useful.js - the values worth a look, per control unit address, in groups (Show = Useful).
 *
 * Each value lists candidates, best first: a catalog identifier ('4402', or '4163/1' for the
 * second value of 4163) or a standard one from std.js ('OBD 05', 'F190'). The first candidate the
 * car answers is shown; units that differ are converted (hPa / kPa / MPa -> bar, ml/s -> l/h ...).
 *   { name, c: [candidates], u: unit to show, d: decimals }
 *   { name, minus: [a, b], u, d }  a - b (each converted to u), e.g. boost = charge pressure - ambient
 * optional: bad: [raw values that mean "no data"] (a candidate with one is skipped, e.g. FFFF while
 * the engine is off), map: { raw: text }, lin: [a, b] (shown as a + b * value). Temperatures below
 * -45 °C count as no data (an unset sensor reads -48 or -273).
 * Engine unit identifiers: DME8FF_R (B58 / B48 / B38, G series); one that isn't there is skipped.
 * only: 'twin' = only on an engine with two engine units (the V8s: kit/twin_dme.js), 'single' = only on one with
 * one. Each unit of a twin-unit engine runs its own bank, and its per-cylinder values (ignition angle,
 * injector correction) are its own bank's cylinders 1..n, so on the master only bank 1's are listed; the misfire
 * and rough-running counters are the whole engine's (DME8FF_R lists them up to 12 cylinders; 8 are used here).
 * BANK2(perBank): the second unit's (0x13) list, its cylinders named perBank + 1 .. (as S63TU_L0's texts have it:
 * "Zuendwinkel Zylinder 1 (Slave 5)"). Not checked on a car yet: the S63's master answered 4035 (issue #166).
 */
/* KQE's quality range of a refuelling (Qualitaetsbereich 1 low, 2 medium, 3 high); 0: no refuelling in that place yet */
const QUALITY = { 0: '-', 1: 'Low', 2: 'Medium', 3: 'High' };
const cyl = (name, dids, extra, first) => dids.map((did, i) => Object.assign({ name: name + ', cylinder ' + ((first || 1) + i), c: [did] }, extra));
/** a bank's per-cylinder list: cylinders 1..4 always, 5 and 6 only with one engine unit (on a twin they are bank 2's) */
const bank = (name, dids, extra) => cyl(name, dids.slice(0, 4), extra).concat(cyl(name, dids.slice(4), Object.assign({ only: 'single' }, extra), 5));
const IGN = ['4A49', '4A4A', '4A4C', '4A4D', '4A4E', '4A4F'], INJ = ['55B4', '55B5', '55B6', '55B7', '55B8', '55B9'];

const DME = [
    { group: 'Engine', items: [
        { name: 'Engine speed', c: ['4807', 'OBD 0C'], u: 'rpm', d: 0 },      // the engine unit's own: shares a request
        { name: 'Engine load', c: ['OBD 04'], u: '%', d: 0 },
        { name: 'Accelerator pedal', c: ['5814', '480B', 'OBD 49'], u: '%', d: 0 },
        { name: 'Throttle', c: ['4600', '5858', 'OBD 11'], u: '%', d: 0 },
        { name: 'Engine torque', c: ['5891', '5717'], u: 'Nm', d: 0 },
        { name: 'Engine power (engine unit)', c: ['4520'], d: 0 },
        { name: 'Vehicle speed', c: ['4AB1', 'OBD 0D'], u: 'km/h', d: 0 },
        { name: 'Gear', c: ['5881', '564F'], d: 0 },
        { name: 'Time since engine start', c: ['OBD 1F'], u: 's', d: 0 },
    ] },
    { group: 'Temperatures', items: [
        { name: 'Coolant', c: ['4300', '5805', 'OBD 05'], u: '°C', d: 0 },
        { name: 'Coolant, radiator outlet', c: ['5890'], u: '°C', d: 0 },
        { name: 'Engine oil (after filter)', c: ['4402', '5822', 'OBD 5C'], u: '°C', d: 0 },
        { name: 'Engine oil in the sump', c: ['4425', '4408'], u: '°C', d: 0 },
        { name: 'Intake air', c: ['580F', 'OBD 0F'], u: '°C', d: 0 },
        { name: 'Charge air before throttle', c: ['59D4'], u: '°C', d: 0 },
        { name: 'Outside', c: ['5817', '5512', 'OBD 46'], u: '°C', d: 1 },
        { name: 'Gearbox', c: ['4650'], u: '°C', d: 0 },
        { name: 'Fuel', c: ['4AD5'], u: '°C', d: 0 },
        { name: 'Engine unit', c: ['5821'], u: '°C', d: 0 },
        { name: 'Exhaust after catalyst (model)', c: ['5896', '582F'], u: '°C', d: 0 },
        { name: 'Particulate filter', c: ['579B'], u: '°C', d: 0 },
        { name: 'Catalyst, bank 1 sensor 1', c: ['OBD 3C'], u: '°C', d: 0 },
    ] },
    { group: 'Oil', items: [
        // both oil pressure identifiers read absolute (1.02 bar with the engine off): above ambient = what the pump makes
        { name: 'Oil pressure', minus: ['4436', '4201'], u: 'bar', d: 2 },
        { name: 'Oil pressure (absolute)', c: ['586F', '4436'], u: 'bar', d: 2 },
        { name: 'Oil level above minimum', c: ['5811', '442F'], u: 'l', d: 2, bad: [255] },
        { name: 'Oil level', c: ['4409'], u: 'mm', d: 1 },
        { name: 'Oil life left (by engine hours)', c: ['411A/0'], u: '%', d: 0 },
        { name: 'Oil life left (by fuel used)', c: ['411A/1'], u: '%', d: 0 },
        { name: 'Engine hours on this oil', c: ['411A/2'], u: 'h', d: 0 },
        { name: 'Distance on this oil', c: ['4404'], u: 'km', d: 0 },
        { name: 'Fuel in the oil', c: ['593A'], u: 'g', d: 0 },
        { name: 'Oil pump duty cycle', c: ['4AAA'], u: '%', d: 0 },
    ] },
    { group: 'Fuel', items: [
        { name: 'Fuel in the tank', c: ['583B'], u: 'l', d: 0 },
        { name: 'Fuel tank, left half', c: ['5949'], u: 'l', d: 1 },
        { name: 'Fuel tank, right half', c: ['594A'], u: 'l', d: 1 },
        { name: 'Fuel tank level', c: ['OBD 2F'], u: '%', d: 0 },
        { name: 'High pressure fuel (rail)', c: ['58EF', '5658', 'OBD 23'], u: 'bar', d: 0 },
        { name: 'High pressure fuel target', c: ['5837', '56C1'], u: 'bar', d: 0 },
        { name: 'Low pressure fuel', c: ['58F3', '5463'], u: 'bar', d: 2 },
        { name: 'Fuel consumption', c: ['5656', 'OBD 5E'], u: 'l/h', d: 1 },
        { name: 'Fuel mass flow', c: ['4521'], u: 'kg/h', d: 1 },
        { name: 'Ethanol in the fuel', c: ['550D', 'OBD 52'], u: '%', d: 0 },
    ] },
    // the engine unit's fuel quality detection (KQE, 4035, issue #166): refuellings counted by quality range and the
    // last five with their mileage; also on the S63's master unit (0x12, DME8FF_R; its second unit 0x13 has no list)
    { group: 'Fuel quality', items: [
        { name: 'Fuel quality (adapted)', c: ['5776'], u: 'RON', lin: [98, -7], d: 1 },
        { name: 'Time since refuelling', c: ['57E3'], u: 'h', d: 1 },
        { name: 'Refuellings, low quality', c: ['4035/0'], d: 0 },
        { name: 'Refuellings, medium quality', c: ['4035/1'], d: 0 },
        { name: 'Refuellings, high quality', c: ['4035/2'], d: 0 },
    ].concat([1, 2, 3, 4, 5].reduce((a, n) => a.concat([
        { name: 'Refuelling ' + n + ', mileage', c: ['4035/' + (n * 2 + 1)], u: 'km', d: 0 },
        { name: 'Refuelling ' + n + ', fuel quality', c: ['4035/' + (n * 2 + 2)], d: 0, map: QUALITY },
    ]), [])) },
    { group: 'Boost and air', items: [
        { name: 'Boost', minus: ['4205', '4201'], u: 'bar', d: 2 },
        { name: 'Charge pressure (absolute)', c: ['4205', '57C1'], u: 'bar', d: 2 },
        { name: 'Boost target (absolute)', c: ['4AB0'], u: 'bar', d: 2 },
        { name: 'Boost control deviation', c: ['4536'], u: 'hPa', d: 0 },
        { name: 'Intake manifold pressure', c: ['4A2D', 'OBD 0B'], u: 'bar', d: 2 },
        { name: 'Ambient pressure', c: ['4201', 'OBD 33'], u: 'hPa', d: 0 },
        // no air mass meter on this engine (coding: HFM 0, its identifiers read 0): the engine unit's own figure
        { name: 'Air mass flow', c: ['5511', '4ABC', '56BA', '4206', '5812', 'OBD 10'], u: 'kg/h', d: 0, bad: [0] },
        { name: 'Air charge (relative)', c: ['5813', 'OBD 43'], u: '%', d: 0 },
        { name: 'Wastegate position (0 = closed)', c: ['5927'], u: '%', d: 0 },
        { name: 'Wastegate actuator duty cycle', c: ['4AAB'], u: '%', d: 0 },
    ] },
    { group: 'Ignition and knock', items: [
        { name: 'Ignition angle', c: ['59FA', 'OBD 0E'], u: '°', d: 1 },
    ].concat(bank('Ignition angle', IGN, { u: '°', d: 1 }), [
        { name: 'Knock detected', c: ['4A36'], map: { 0: 'no', 1: 'YES' } },
        { name: 'Knock control retard (mean)', c: ['554C'], u: '°', d: 1 },
        { name: 'Knock control adaptation', c: ['554A'], u: '°', d: 1 },
    ], cyl('Misfires', ['4B23', '4B24', '4B25', '4B30', '4B31', '4B32'], { d: 0 }),
    cyl('Misfires', ['4B33', '4B34'], { d: 0, only: 'twin' }, 7),
    cyl('Rough running', ['4A30', '4A31', '4A32', '4A33', '4A34', '4A35'], { d: 1 }),
    cyl('Rough running', ['4A43', '4A44'], { d: 1, only: 'twin' }, 7)) },
    { group: 'VANOS and Valvetronic', items: [
        { name: 'Intake camshaft (VANOS)', c: ['452E'], u: '°', d: 1 },
        { name: 'Intake camshaft target', c: ['452B'], u: '°', d: 1 },
        { name: 'Exhaust camshaft (VANOS)', c: ['452C'], u: '°', d: 1 },
        { name: 'Exhaust camshaft target', c: ['452A'], u: '°', d: 1 },
        { name: 'Intake valve lift (Valvetronic)', c: ['4602'], u: 'mm', d: 2 },
        { name: 'Intake valve lift target', c: ['4603'], u: 'mm', d: 2 },
    ] },
    { group: 'Mixture and injectors', items: [
        { name: 'Lambda', c: ['5889', '5640', 'OBD 34'], d: 3, bad: [65535] },
        { name: 'Lambda target', c: ['5816', 'OBD 44'], d: 3, bad: [65535] },
        { name: 'Short term fuel trim', c: ['OBD 06'], u: '%', d: 1 },
        { name: 'Long term fuel trim', c: ['OBD 07'], u: '%', d: 1 },
        { name: 'Mixture adaptation (factor)', c: ['4A9D'], d: 3 },
        { name: 'Injector flow adaptation (mean)', c: ['546E'], d: 3 },
    ].concat(bank('Injector correction', INJ, { d: 3 })) },
    { group: '12 V', items: [
        { name: 'Battery voltage', c: ['5853', 'OBD 42'], u: 'V', d: 2 },
        { name: 'Battery current', c: ['5852'], u: 'A', d: 1 },
        { name: 'Battery temperature', c: ['5854'], u: '°C', d: 0 },
        { name: 'Battery charge', c: ['56F0'], u: '%', d: 0, bad: [0] },
        { name: 'Battery health', c: ['59AA'], u: '%', d: 0 },
        { name: 'Alternator current', c: ['4604'], u: 'A', d: 0 },
    ] },
    { group: 'Wear and service', items: [
        { name: 'Spark plugs: remaining distance', c: ['4163/1', '5489'], u: 'km', d: 0, bad: [0] },
        { name: 'Spark plugs: distance driven', c: ['4163/2'], u: 'km', d: 0 },
        { name: 'Spark plug wear (normalised)', c: ['4163/0'], d: 3, bad: [0] },
        { name: 'Particulate filter: soot', c: ['5444', '5774'], u: 'g', d: 1 },
        { name: 'Particulate filter: load (adapted)', c: ['558C'], d: 3 },
        { name: 'Particulate filter: ash (adapted)', c: ['558B'], d: 3 },
        { name: 'Catalyst oxygen storage', c: ['5433'], u: 'mg', d: 0, bad: [0] },
        { name: 'Engine operating hours', c: ['583D'], u: 'h', d: 0 },
        { name: 'Check engine lamp (MIL) on', c: ['OBD 01'] },
        { name: 'Stored emission faults', c: ['OBD 01/1'] },
    ] },
];

/**
 * The second engine unit (0x13) of a twin-unit engine: its own bank's values, in the master's identifiers (the
 * pair's SGBDs are the same, as S63TU_R0 / S63TU_L0 are), shown on the Engine page under "Bank 2". perBank:
 * cylinders per bank (4 on a V8): its cylinders are named perBank + 1 ..
 */
function BANK2(perBank) {
    const n = Math.max(1, Math.min(4, perBank || 4));
    return [
        { group: 'Ignition and knock', items: cyl('Ignition angle', IGN.slice(0, n), { u: '°', d: 1 }, n + 1).concat([
            { name: 'Knock detected', c: ['4A36'], map: { 0: 'no', 1: 'YES' } },
            { name: 'Knock control retard (mean)', c: ['554C'], u: '°', d: 1 },
            { name: 'Knock control adaptation', c: ['554A'], u: '°', d: 1 },
        ]) },
        { group: 'Boost and air', items: [
            { name: 'Charge pressure (absolute)', c: ['4205', '57C1'], u: 'bar', d: 2 },
            { name: 'Boost target (absolute)', c: ['4AB0'], u: 'bar', d: 2 },
            { name: 'Boost control deviation', c: ['4536'], u: 'hPa', d: 0 },
            { name: 'Wastegate position (0 = closed)', c: ['5927'], u: '%', d: 0 },
            { name: 'Wastegate actuator duty cycle', c: ['4AAB'], u: '%', d: 0 },
        ] },
        { group: 'VANOS and Valvetronic', items: [
            { name: 'Intake camshaft (VANOS)', c: ['452E'], u: '°', d: 1 },
            { name: 'Intake camshaft target', c: ['452B'], u: '°', d: 1 },
            { name: 'Exhaust camshaft (VANOS)', c: ['452C'], u: '°', d: 1 },
            { name: 'Exhaust camshaft target', c: ['452A'], u: '°', d: 1 },
        ] },
        { group: 'Mixture and injectors', items: [
            { name: 'Lambda', c: ['5889', '5640'], d: 3, bad: [65535] },
            { name: 'Lambda target', c: ['5816'], d: 3, bad: [65535] },
            { name: 'Mixture adaptation (factor)', c: ['4A9D'], d: 3 },
            { name: 'Injector flow adaptation (mean)', c: ['546E'], d: 3 },
        ].concat(cyl('Injector correction', INJ.slice(0, n), { d: 3 }, n + 1)) },
        { group: 'Fuel and exhaust', items: [
            { name: 'Fuel consumption', c: ['5656'], u: 'l/h', d: 1 },
            { name: 'Exhaust after catalyst (model)', c: ['5896', '582F'], u: '°C', d: 0 },
            { name: 'Particulate filter', c: ['579B'], u: '°C', d: 0 },
            { name: 'Particulate filter: soot', c: ['5444', '5774'], u: 'g', d: 1 },
            { name: 'Catalyst oxygen storage', c: ['5433'], u: 'mg', d: 0, bad: [0] },
            { name: 'Engine unit', c: ['5821'], u: '°C', d: 0 },
        ] },
    ];
}

const BY_SGBD = {
    BATT48: [
        { group: '48 V battery', items: [
            { name: 'Battery voltage', c: ['AA56/0'], u: 'V', d: 2 },
            { name: 'Battery current (negative = charging)', c: ['AA56/1'], u: 'A', d: 1 },
            { name: 'Highest cell temperature', c: ['AA56/2'], u: '°C', d: 0 },
            { name: 'State of charge (SOC)', c: ['AA56/7'], u: '%', d: 0 },
            { name: 'SOC estimate quality', c: ['AA56/8'], u: '%', d: 0 },
            { name: 'Pack voltage', c: ['AA56/9'], u: 'V', d: 2 },
            { name: 'Nominal capacity', c: ['AA56/10'], u: 'Ah', d: 1 },
            { name: 'Current capacity', c: ['AA56/15'], u: 'Ah', d: 1 },
            { name: 'State of health (SOH)', c: ['AA56/18'], u: '%', d: 0 },
            { name: 'Capacity SOH (separate estimate)', c: ['50AC'], u: '%', d: 0 },
        ] },
    ],
    PCU48: [
        { group: '48 V / 12 V converter', items: [
            { name: 'Energy flow (converter mode)', c: ['DA90/6'], map: {
                3: 'Passive standby', 5: 'Error', 6: 'Precharge', 8: 'Active standby',
                9: '48 V -> 12 V (buck)', 10: '12 V -> 48 V (boost)', 12: 'Emergency mode', 13: 'Crash',
                14: 'Diagnostic boost', 15: 'Diagnostic buck', 255: 'Invalid',
            } },
            { name: '12 V side voltage', c: ['DA90/0'], u: 'V', d: 2 },
            { name: '48 V side voltage', c: ['DA90/1'], u: 'V', d: 2 },
            { name: '12 V current', c: ['DA90/2'], u: 'A', d: 1 },
            { name: '48 V current', c: ['DA90/3'], u: 'A', d: 1 },
            { name: '12 V power', c: ['DA90/4'], u: 'W', d: 0 },
            { name: '48 V power', c: ['DA90/5'], u: 'W', d: 0 },
        ] },
    ],
};

// unit conversions: from -> to -> factor
const CONVERT = {
    hPa: { bar: 0.001 }, kPa: { bar: 0.01, hPa: 10 }, MPa: { bar: 10 }, 'ml/s': { 'l/h': 3.6 }, 'g/s': { 'kg/h': 3.6 },
    mV: { V: 0.001 }, cl: { l: 0.01 }, min: { h: 1 / 60 }, s: { h: 1 / 3600 }, '°CA': { '°': 1 }, '°C': { '°': 1 },
};

module.exports = { 0x12: DME, bySgbd: BY_SGBD, CONVERT, BANK2 };
