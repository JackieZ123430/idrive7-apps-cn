'use strict';
/** Scan result for demo mode (shown with a DEMO badge): real fault codes, so their texts show. */
const f = (code, status, mem) => ({ code, status, mem: mem || 'fault' });
module.exports = {
    ecus: [
        { addr: 0x12, dtcs: [f('102A5A', 0x09), f('102A63', 0x08)] },
        { addr: 0x40, dtcs: [f('801CE5', 0x08)] },
        { addr: 0x63, dtcs: [f('B7F81A', 0x0C)] },
        { addr: 0x5D, dtcs: [f('800A05', 0x28, 'info')] },
        { addr: 0x01, dtcs: [] }, { addr: 0x10, dtcs: [] }, { addr: 0x18, dtcs: [] }, { addr: 0x29, dtcs: [] },
        { addr: 0x30, dtcs: [] }, { addr: 0x56, dtcs: [] }, { addr: 0x60, dtcs: [] }, { addr: 0x64, dtcs: [] },
        { addr: 0x67, dtcs: [] }, { addr: 0x78, dtcs: [] },
    ],
    cc: [
        { id: 186, name: 'Check engine oil level', color: 'YELLOW', ecu: 0x12, reason: 'CC_MESSAGE' },
        { id: 229, name: 'Drive system', color: 'YELLOW', ecu: 0x12, reason: 'DTC_MESSAGE' },
    ],
};
