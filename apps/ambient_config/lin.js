'use strict';
/**
 * lin.js - the ambient light modules on the body controller's two LIN buses (BDC 0x40), as the public
 * BDC_G05 description has them (INNENLICHT_FI_LIN_1_LAYERING / _2_LAYERING). Pure: replies in, request bytes out.
 *
 *   read   22 DA5F (bus 1) / 22 E3D1 (bus 2): the BDC asks its LIN modules first (7F 22 78, the reply seconds
 *          later): 26 records of 10 bytes - location, blue, green, red, brightness, white, short circuit,
 *          over-temperature, open load, internal fault; an empty record has location FF.
 *   write  2E DA5E (bus 1) / 2E E3D1 (bus 2): NAD (the record's place, 1-based), on 1 / off 0, brightness
 *          0-100, red, green, blue, seconds 0-254. The module shows the colour for that long, then the car's own
 *          colour again; off (all 0) gives the car's colour at once. A colour byte FF means "no change", so
 *          colours stop at FE.
 */
const BDC = 0x40;
const BUSES = [
    { name: 'lin1', read: [0xda, 0x5f], write: [0xda, 0x5e] },
    { name: 'lin2', read: [0xe3, 0xd1], write: [0xe3, 0xd1] },
];
const RECORD = 10, RECORDS = 26;

// A light's place: its name, upper (lines and decor) or lower (footwells, handles, pockets, trays), and where it
// sits on the cabin picture (x across from the driver's side 0 to the passenger's side 1, y from the dash 0 to
// the boot 1; a line from x,y to x2,y2). Left-hand drive; the picture mirrors for right-hand drive.
const D = 'driver', P = 'passenger';
const PLACES = {
    0x01: ['Footwell driver front', 'lower', 0.29, 0.215], 0x02: ['Footwell driver rear', 'lower', 0.29, 0.54],
    0x03: ['Footwell passenger front', 'lower', 0.71, 0.215], 0x04: ['Footwell passenger rear', 'lower', 0.71, 0.54],
    0x05: ['Driver front door line', 'upper', 0.06, 0.24, 0.06, 0.46], 0x06: ['Driver front door decor', 'upper', 0.08, 0.26, 0.08, 0.44],
    0x07: ['Driver front door handle', 'lower', 0.09, 0.36], 0x08: ['Driver front door pocket', 'lower', 0.09, 0.44],
    0x09: ['Driver rear door line', 'upper', 0.06, 0.54, 0.06, 0.74], 0x0a: ['Driver rear door decor', 'upper', 0.08, 0.56, 0.08, 0.72],
    0x0b: ['Driver rear door pocket', 'lower', 0.09, 0.72],
    0x0c: ['Passenger front door line', 'upper', 0.94, 0.24, 0.94, 0.46], 0x0d: ['Passenger front door decor', 'upper', 0.92, 0.26, 0.92, 0.44],
    0x0e: ['Passenger front door handle', 'lower', 0.91, 0.36], 0x0f: ['Passenger front door pocket', 'lower', 0.91, 0.44],
    0x10: ['Passenger rear door line', 'upper', 0.94, 0.54, 0.94, 0.74], 0x11: ['Passenger rear door decor', 'upper', 0.92, 0.56, 0.92, 0.72],
    0x12: ['Passenger rear door pocket', 'lower', 0.91, 0.72],
    0x13: ['Dash line driver', 'upper', 0.10, 0.15, 0.37, 0.15], 0x14: ['Dash decor driver', 'upper', 0.10, 0.17, 0.37, 0.17],
    0x15: ['Dash line centre', 'upper', 0.39, 0.15, 0.61, 0.15], 0x16: ['Dash decor centre', 'upper', 0.39, 0.17, 0.61, 0.17],
    0x17: ['Dash line passenger', 'upper', 0.63, 0.15, 0.90, 0.15], 0x18: ['Dash decor passenger', 'upper', 0.63, 0.17, 0.90, 0.17],
    0x19: ['B-pillar driver', 'upper', 0.05, 0.50], 0x1a: ['B-pillar passenger', 'upper', 0.95, 0.50],
    0x1b: ['Driver seat back', 'lower', 0.30, 0.47], 0x1c: ['Passenger seat back', 'lower', 0.70, 0.47],
    0x1d: ['Centre stack tray', 'lower', 0.50, 0.22], 0x1e: ['Console tray', 'lower', 0.50, 0.42],
    0x1f: ['Gear selector left', 'lower', 0.46, 0.33], 0x20: ['Gear selector right', 'lower', 0.54, 0.33],
    0x21: ['Driver rear door handle', 'lower', 0.09, 0.64], 0x22: ['Passenger rear door handle', 'lower', 0.91, 0.64],
    0x2b: ['Console line driver front', 'upper', 0.44, 0.24, 0.44, 0.40], 0x2c: ['Console line driver rear', 'upper', 0.44, 0.42, 0.44, 0.52],
    0x2d: ['Console line passenger front', 'upper', 0.56, 0.24, 0.56, 0.40], 0x2e: ['Console line passenger rear', 'upper', 0.56, 0.42, 0.56, 0.52],
    0x2f: ['Console decor driver front', 'upper', 0.45, 0.26, 0.45, 0.38], 0x30: ['Console decor driver rear', 'upper', 0.45, 0.44, 0.45, 0.50],
    0x31: ['Console decor passenger front', 'upper', 0.55, 0.26, 0.55, 0.38], 0x32: ['Console decor passenger rear', 'upper', 0.55, 0.44, 0.55, 0.50],
    0x33: ['Driver seat back, 2nd row', 'lower', 0.30, 0.78], 0x34: ['Passenger seat back, 2nd row', 'lower', 0.70, 0.78],
    0x35: ['Sunroof front left', 'upper', 0.30, 0.34], 0x36: ['Sunroof front left rear', 'upper', 0.30, 0.42],
    0x37: ['Sunroof front right', 'upper', 0.70, 0.34], 0x38: ['Sunroof front right rear', 'upper', 0.70, 0.42],
    0x39: ['Sunroof rear left', 'upper', 0.30, 0.58], 0x3a: ['Sunroof rear left rear', 'upper', 0.30, 0.66],
    0x3b: ['Sunroof rear right', 'upper', 0.70, 0.58], 0x3c: ['Sunroof rear right rear', 'upper', 0.70, 0.66],
    0x3d: ['Light blade left', 'upper', 0.12, 0.80, 0.30, 0.86], 0x3e: ['Light blade right', 'upper', 0.70, 0.86, 0.88, 0.80],
    0x4b: ['Cupholder front', 'lower', 0.50, 0.38], 0x4c: ['Cupholder rear', 'lower', 0.50, 0.70],
    // the door lines' second strip (G26: each door line in two parts, its own module), next to each line
    0x62: ['Driver front door line 2', 'upper', 0.07, 0.25, 0.07, 0.45], 0x63: ['Driver rear door line 2', 'upper', 0.07, 0.55, 0.07, 0.73],
    0x64: ['Passenger front door line 2', 'upper', 0.93, 0.25, 0.93, 0.45], 0x65: ['Passenger rear door line 2', 'upper', 0.93, 0.55, 0.93, 0.73],
};
// the doors' backlit decor (0x3F-0x46) and the console's (0x47-0x4A)
[[0x3f, D, 0.28], [0x40, D, 0.40], [0x41, D, 0.58], [0x42, D, 0.70], [0x43, P, 0.28], [0x44, P, 0.40], [0x45, P, 0.58], [0x46, P, 0.70]]
    .forEach(([c, side, y]) => { PLACES[c] = [(side === D ? 'Driver' : 'Passenger') + ' door backlit decor', 'upper', side === D ? 0.07 : 0.93, y]; });
[[0x47, 0.45, 0.30], [0x48, 0.45, 0.46], [0x49, 0.55, 0.30], [0x4a, 0.55, 0.46]]
    .forEach(([c, x, y]) => { PLACES[c] = ['Console backlit decor', 'upper', x, y]; });

/** A location code -> { loc, name, part, x, y, x2, y2 } (an unknown code: a lower light in the middle). */
function place(loc) {
    const p = PLACES[loc] || ['Light ' + loc.toString(16).toUpperCase(), 'lower', 0.5, 0.5];
    return { loc, name: p[0], part: p[1], x: p[2], y: p[3], x2: p[4] == null ? null : p[4], y2: p[5] == null ? null : p[5] };
}

/** The modules in a status reply (62 <DID> records...): [{ bus, nad, loc, name, part, x, y, rgb, bright, fault }]. */
function parseStatus(bus, uds) {
    const b = Array.prototype.slice.call(uds || []);
    const ok = b[0] === 0x62 && b[1] === BUSES[bus].read[0] && b[2] === BUSES[bus].read[1];
    if (!ok) return null;
    const out = [];
    for (let i = 0; i < RECORDS; i++) {
        const r = b.slice(3 + i * RECORD, 3 + (i + 1) * RECORD);
        if (r.length < RECORD || r[0] === 0xff) continue;
        out.push(Object.assign(place(r[0]), { bus, nad: i + 1, rgb: [r[3], r[2], r[1]], bright: r[4], fault: !!(r[6] || r[7] || r[8] || r[9]) }));
    }
    return out;
}

const byte = (v) => Math.max(0, Math.min(0xfe, Math.round(v)));

/** The write that shows rgb [r, g, b] (0-255) at brightness 0-100 on one module for secs seconds (after it, the car's colour). */
function writeFrame(bus, nad, rgb, bright, secs) {
    return BUSES[bus].write.concat([nad, 1, Math.max(0, Math.min(100, Math.round(bright))), byte(rgb[0]), byte(rgb[1]), byte(rgb[2]), Math.max(1, Math.min(254, Math.round(secs)))]);
}

/** The write that gives one module back to the car's own colour at once. */
function releaseFrame(bus, nad) { return BUSES[bus].write.concat([nad, 0, 0, 0, 0, 0, 0]); }

// A G20's 19 lights, for the picture before the car has answered (and the preview on the PC)
const G20 = [[0, 0x0f], [0, 0x0e], [0, 0x0c], [0, 0x12], [0, 0x22], [0, 0x10], [0, 0x04],
    [1, 0x15], [1, 0x17], [1, 0x13], [1, 0x01], [1, 0x03], [1, 0x08], [1, 0x07], [1, 0x05], [1, 0x0b], [1, 0x21], [1, 0x09], [1, 0x02]];
const sample = () => {
    const n = [0, 0];
    return G20.map(([bus, loc]) => Object.assign(place(loc), { bus, nad: ++n[bus], rgb: [120, 60, 254], bright: 100, fault: false }));
};

module.exports = { BDC, BUSES, PLACES, place, parseStatus, writeFrame, releaseFrame, sample };
