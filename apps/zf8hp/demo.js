'use strict';

const C = require('./catalog');
const records = {};
Object.keys(C.records).forEach((did) => {
    const m = C.records[did];
    records[did] = { ok: true, at: Date.now(), cached: false, bytes: m.length || 0, raw: '',
        decoded: m.fields.length > 0, values: m.fields.map((f, i) => f.unit === 'bar' ? Math.round(Math.sin(i / 7) * 12) / 100 : 10 + i * 3) };
});
const set = (d, v) => { records[d].values = v; };
set('413A', [-70, 35, -90, -125, 45]); set('4140', [12, -3, 8, 4, 6]);
set('4130', [22, 17, 34, 25, 29]); set('4131', [21, 16, 33, 24, 28]);
set('418A', [30, 0, 60, 45, 10]);
set('6000', [82]); set('6005', [85]); set('601D', [87]); set('DA2A', [1680, 1280]);
set('DA34', [1690]); set('DA2E', [7, 3]); set('DA22', [3]); set('DB03', [30, 40]);
set('DB04', [0, 2000]); set('6081', [78000]); set('6090', [2]);
set('4440', C.ranges.map((x, i) => Math.round(Math.exp(-Math.pow((i - 8) / 3, 2)) * 530000)));
set('4441', C.ranges.map((x, i) => Math.round(Math.exp(-Math.pow((i - 7) / 3, 2)) * 500000)));
records.F150.raw = '0F25D0';
records['602E'].raw = '55';
module.exports = {
    records,
    history: Array.from({ length: 80 }, (x, i) => ({ t: Date.now() - (79 - i) * 10000,
        oil: 45 + 37 * (1 - Math.exp(-i / 22)), chip1: 48 + 37 * (1 - Math.exp(-i / 22)), chip2: 50 + 37 * (1 - Math.exp(-i / 22)) })),
};
