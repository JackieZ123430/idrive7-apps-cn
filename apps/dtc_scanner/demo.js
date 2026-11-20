'use strict';
/**
 * Scan result for demo mode (shown with a DEMO badge): real fault codes, so their texts show.
 * More than fit the full-screen layout (7 faults, 7 Check Control messages, 25 control units), so
 * each list scrolls there.
 */
const f = (code, status, mem) => ({ code, status, mem: mem || 'fault' });
module.exports = {
    ecus: [
        { addr: 0x12, dtcs: [f('102A5A', 0x09), f('102A63', 0x08)] },
        { addr: 0x40, dtcs: [f('801CE5', 0x08)] },
        { addr: 0x63, dtcs: [f('B7F81A', 0x0C)] },
        { addr: 0x07, dtcs: [f('23F86A', 0x09)] },
        { addr: 0x3A, dtcs: [f('222F8D', 0x08)] },
        { addr: 0x14, dtcs: [f('805506', 0x09)] },
        { addr: 0x29, dtcs: [f('48069A', 0x08)] },
        { addr: 0x30, dtcs: [f('4823E8', 0x0C)] },
        { addr: 0x78, dtcs: [f('8012C0', 0x08)] },
        { addr: 0x18, dtcs: [f('231802', 0x20)] },
        { addr: 0x5D, dtcs: [f('800A05', 0x28, 'info')] },
        { addr: 0x01, dtcs: [] }, { addr: 0x06, dtcs: [] }, { addr: 0x08, dtcs: [] }, { addr: 0x0D, dtcs: [] },
        { addr: 0x10, dtcs: [] }, { addr: 0x1D, dtcs: [] }, { addr: 0x20, dtcs: [] }, { addr: 0x21, dtcs: [] },
        { addr: 0x23, dtcs: [] }, { addr: 0x28, dtcs: [] }, { addr: 0x2A, dtcs: [] }, { addr: 0x2C, dtcs: [] },
        { addr: 0x37, dtcs: [] }, { addr: 0x39, dtcs: [] }, { addr: 0x43, dtcs: [] }, { addr: 0x44, dtcs: [] },
        { addr: 0x56, dtcs: [] }, { addr: 0x5E, dtcs: [] }, { addr: 0x60, dtcs: [] }, { addr: 0x61, dtcs: [] },
        { addr: 0x64, dtcs: [] }, { addr: 0x67, dtcs: [] }, { addr: 0x6D, dtcs: [] }, { addr: 0x76, dtcs: [] },
    ],
    cc: [
        { id: 186, name: 'Check engine oil level', color: 'YELLOW', ecu: 0x12, reason: 'CC_MESSAGE' },
        { id: 229, name: 'Drive system', color: 'YELLOW', ecu: 0x12, reason: 'DTC_MESSAGE' },
        { id: 801, name: 'High-voltage system', color: 'YELLOW', ecu: 0x07, reason: 'DTC_MESSAGE' },
        { id: 802, name: 'Charging not possible', color: 'YELLOW', ecu: 0x14, reason: 'DTC_MESSAGE' },
        { id: 36, name: 'Brake system', color: 'YELLOW', ecu: 0x29, reason: 'DTC_MESSAGE' },
        { id: 312, name: 'Steering malfunction', color: 'YELLOW', ecu: 0x30, reason: 'DTC_MESSAGE' },
        { id: 593, name: 'Air conditioning restricted', color: 'WHITE', ecu: 0x78, reason: 'DTC_MESSAGE' },
        { id: 220, name: 'Transmission', color: 'YELLOW', ecu: 0x18, reason: 'DTC_MESSAGE' },
        { id: 357, name: 'Low washer fluid', color: 'WHITE', ecu: 0x40, reason: 'CC_MESSAGE' },
    ],
};
