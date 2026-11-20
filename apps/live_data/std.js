'use strict';
/**
 * std.js - values every car has, in the catalog format of kit/sgbd.js (see kit/tools/sgbd_catalog.py):
 * public standards, not BMW's tables, so they are in git and work without a catalog.
 *
 *   IDENT  UDS identification (ISO 14229-1, 22 F1xx): asked from every unit that answers
 *   OBD    OBD-II current data (SAE J1979 service 01): from the engine unit, the PIDs it supports
 *   INFO   OBD-II vehicle information (service 09)
 *
 * entry = { sid, id, d: name, f: [field] }; value = raw * k + o.
 */
const f = (t, at, extra) => Object.assign({ n: '', t, at }, extra);
const pct = { k: 100 / 255, u: '%' };
const temp = { o: -40, u: '°C' };
const trim = { k: 100 / 128, o: -100, u: '%' };

const IDENT = {};
[
    ['F150', 'SGBD index (control unit type)', f('hex', 0, { len: 3 })],
    ['F190', 'Vehicle identification number (VIN)', f('str', 0, { len: 17 })],
    ['F186', 'Active diagnostic session', f('u8', 0, { e: 'session' })],
    ['F187', 'Spare part number', f('txt', 0, { len: 32 })],
    ['F18A', 'System supplier', f('txt', 0, { len: 32 })],
    ['F18B', 'Manufacturing date', f('hex', 0, { len: 4 })],
    ['F18C', 'Serial number', f('txt', 0, { len: 32 })],
    ['F191', 'Hardware number', f('txt', 0, { len: 32 })],
    ['F195', 'Supplier software version', f('txt', 0, { len: 32 })],
    ['F197', 'System name', f('txt', 0, { len: 32 })],
].forEach(([id, d, fld]) => { IDENT[id] = { sid: 0x22, id: parseInt(id, 16), d, f: [fld] }; });

const ENUMS = {
    session: { 1: 'Default', 2: 'Programming', 3: 'Extended', 0x41: 'BMW coding', 0x4F: 'BMW development' },
    fuelSystem: { 0: 'Off', 1: 'Open loop (cold)', 2: 'Closed loop', 4: 'Open loop (load)', 8: 'Open loop (fault)', 16: 'Closed loop (sensor fault)' },
    fuelType: { 1: 'Petrol', 2: 'Methanol', 3: 'Ethanol', 4: 'Diesel', 5: 'LPG', 6: 'CNG', 8: 'Electric', 17: 'Hybrid petrol', 19: 'Hybrid diesel' },
};

const OBD = {};
[
    [0x01, 'Check engine lamp (MIL) on', f('u8', 0, { m: 0x80 })],
    [0x01, 'Stored emission faults', f('u8', 0, { m: 0x7F })],
    [0x03, 'Fuel system', f('u8', 0, { e: 'fuelSystem' })],
    [0x04, 'Engine load (calculated)', f('u8', 0, pct)],
    [0x05, 'Coolant temperature', f('u8', 0, temp)],
    [0x06, 'Short term fuel trim, bank 1', f('u8', 0, trim)],
    [0x07, 'Long term fuel trim, bank 1', f('u8', 0, trim)],
    [0x08, 'Short term fuel trim, bank 2', f('u8', 0, trim)],
    [0x09, 'Long term fuel trim, bank 2', f('u8', 0, trim)],
    [0x0B, 'Intake manifold pressure', f('u8', 0, { u: 'kPa' })],
    [0x0C, 'Engine speed', f('u16', 0, { k: 0.25, u: 'rpm' })],
    [0x0D, 'Vehicle speed', f('u8', 0, { u: 'km/h' })],
    [0x0E, 'Ignition timing advance', f('u8', 0, { k: 0.5, o: -64, u: '°' })],
    [0x0F, 'Intake air temperature', f('u8', 0, temp)],
    [0x10, 'Air mass flow', f('u16', 0, { k: 0.01, u: 'g/s' })],
    [0x11, 'Throttle position', f('u8', 0, pct)],
    [0x1F, 'Time since engine start', f('u16', 0, { u: 's' })],
    [0x21, 'Distance with check engine lamp on', f('u16', 0, { u: 'km' })],
    [0x22, 'Fuel rail pressure (to manifold)', f('u16', 0, { k: 0.079, u: 'kPa' })],
    [0x23, 'Fuel rail pressure', f('u16', 0, { k: 0.1, u: 'bar' })],
    [0x2E, 'Evaporative purge (commanded)', f('u8', 0, pct)],
    [0x2F, 'Fuel tank level', f('u8', 0, pct)],
    [0x30, 'Warm-ups since faults cleared', f('u8', 0)],
    [0x31, 'Distance since faults cleared', f('u16', 0, { u: 'km' })],
    [0x33, 'Barometric pressure', f('u8', 0, { u: 'kPa' })],
    [0x34, 'Lambda, bank 1 sensor 1', f('u16', 0, { k: 2 / 65536 })],
    [0x34, 'Lambda sensor current, bank 1 sensor 1', f('u16', 2, { k: 1 / 256, o: -128, u: 'mA' })],
    [0x38, 'Lambda, bank 2 sensor 1', f('u16', 0, { k: 2 / 65536 })],
    [0x3C, 'Catalyst temperature, bank 1 sensor 1', f('u16', 0, { k: 0.1, o: -40, u: '°C' })],
    [0x3D, 'Catalyst temperature, bank 2 sensor 1', f('u16', 0, { k: 0.1, o: -40, u: '°C' })],
    [0x3E, 'Catalyst temperature, bank 1 sensor 2', f('u16', 0, { k: 0.1, o: -40, u: '°C' })],
    [0x3F, 'Catalyst temperature, bank 2 sensor 2', f('u16', 0, { k: 0.1, o: -40, u: '°C' })],
    [0x42, 'Control module voltage', f('u16', 0, { k: 0.001, u: 'V' })],
    [0x43, 'Engine load (absolute)', f('u16', 0, pct)],
    [0x44, 'Lambda (commanded)', f('u16', 0, { k: 2 / 65536 })],
    [0x45, 'Throttle position (relative)', f('u8', 0, pct)],
    [0x46, 'Outside air temperature', f('u8', 0, temp)],
    [0x47, 'Throttle position B', f('u8', 0, pct)],
    [0x49, 'Accelerator pedal position D', f('u8', 0, pct)],
    [0x4A, 'Accelerator pedal position E', f('u8', 0, pct)],
    [0x4C, 'Throttle actuator (commanded)', f('u8', 0, pct)],
    [0x4D, 'Time with check engine lamp on', f('u16', 0, { u: 'min' })],
    [0x4E, 'Time since faults cleared', f('u16', 0, { u: 'min' })],
    [0x51, 'Fuel type', f('u8', 0, { e: 'fuelType' })],
    [0x52, 'Ethanol in the fuel', f('u8', 0, pct)],
    [0x5A, 'Accelerator pedal (relative)', f('u8', 0, pct)],
    [0x5C, 'Engine oil temperature', f('u8', 0, temp)],
    [0x5E, 'Fuel rate', f('u16', 0, { k: 0.05, u: 'l/h' })],
    [0x61, 'Torque demanded by the driver', f('u8', 0, { o: -125, u: '%' })],
    [0x62, 'Torque (actual)', f('u8', 0, { o: -125, u: '%' })],
    [0x63, 'Reference torque', f('u16', 0, { u: 'Nm' })],
    [0x8E, 'Engine friction torque', f('u8', 0, { o: -125, u: '%' })],
    [0xA6, 'Odometer', f('u32', 0, { k: 0.1, u: 'km' })],
].forEach(([pid, d, fld]) => {
    const key = 'OBD ' + (pid < 16 ? '0' : '') + pid.toString(16).toUpperCase();
    const e = OBD[key] || (OBD[key] = { sid: 0x01, id: pid, d, f: [] });
    if (e.f.length) fld.d = d;          // a second value of the same PID: its own name
    e.f.push(fld);
});

const INFO = {
    'OBD 09 02': { sid: 0x09, id: 0x02, d: 'VIN (OBD)', f: [f('str', 1, { len: 17 })] },
    'OBD 09 04': { sid: 0x09, id: 0x04, d: 'Calibration ID', f: [f('str', 1, { len: 16 })] },
    'OBD 09 06': { sid: 0x09, id: 0x06, d: 'Calibration verification number', f: [f('hex', 1, { len: 4 })] },
    'OBD 09 0A': { sid: 0x09, id: 0x0A, d: 'Engine unit name', f: [f('str', 1, { len: 20 })] },
};

module.exports = { IDENT, OBD, INFO, ENUMS };
