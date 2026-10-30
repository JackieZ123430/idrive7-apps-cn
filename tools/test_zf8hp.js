'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.resolve(__dirname, '..');
const E = require(path.join(root, 'apps/zf8hp/egs'));
const C = require(path.join(root, 'apps/zf8hp/catalog'));
// Stage only the three reader sources and the transport helper. No SDK or build is needed.
const testSource = fs.mkdtempSync(path.join(os.tmpdir(), 'zf8hp-source-'));
fs.mkdirSync(path.join(testSource, 'kit'));
for (const name of ['reader', 'catalog', 'egs']) {
    fs.copyFileSync(path.join(root, 'apps/zf8hp', name + '.js'), path.join(testSource, name + '.js'));
}
fs.copyFileSync(path.join(root, 'kit/runtime/diag.js'), path.join(testSource, 'kit/diag.js'));
process.on('exit', () => fs.rmSync(testSource, { recursive: true, force: true }));
const Reader = require(path.join(testSource, 'reader'));
const fixture = process.argv[2];
const readings = fixture ? JSON.parse(fs.readFileSync(fixture, 'utf8')) : [];
const decode = (d, hex) => E.decode(d, Buffer.from(hex, 'hex'));

function words(did, values) {
    const b = Buffer.alloc(3 + values.length * 2);
    b[0] = 0x62; b.writeUInt16BE(parseInt(did, 16), 1);
    values.forEach((v, i) => b.writeInt16LE(v, 3 + i * 2));
    return b.toString('hex');
}
// Synthetic values: do not include an owner's measured adaptation values in fixtures.
assert.deepStrictEqual(decode('413A', words('413A', [-120, 15, 0, -260, 48])).values, [-120, 15, 0, -260, 48]);
assert.deepStrictEqual(decode('4140', words('4140', [10, -3, 6, 0, 2])).values, [10, -3, 6, 0, 2]);
assert.strictEqual(decode('413A', '62413a0100').ok, false);
assert.strictEqual(decode('413A', words('4140', [10, -3, 6, 0, 2])).ok, false);
assert.strictEqual(decode('413A', '7f2231').ok, false);
assert.strictEqual(decode('6000', '62600064').values[0], 60);
assert.deepStrictEqual(decode('DA2A', '62da2a032004b0').values, [800, 1200]);
assert.strictEqual(C.gearNames[0x10], '8');
assert.strictEqual(C.gearNames[10], undefined);
const rmap = { '4110': { ok: true, values: [0.01, -0.02, 0] } };
assert.deepStrictEqual(E.mapValues(rmap, { did: '4110', fromGear: 1, toGear: 2 }, '1').values, [10, -20, 0]);
const cold = { '41B6': { ok: true, values: Array.from({ length: 448 }, (x, i) => i) } };
assert.deepStrictEqual(E.mapValues(cold, { fromGear: 2, toGear: 3 }, 'cold1').values, Array.from({ length: 64 }, (x, i) => i + 64));
assert.strictEqual(E.mapValues(cold, { fromGear: 3, toGear: 2 }, 'cold1').values.length, 0);
assert.strictEqual(C.ranges.length, 23);

let checked = 0;
for (const r of readings) {
    if (!C.records[r.did] || !r.response || !r.response.startsWith('62')) continue;
    const got = decode(r.did, r.response);
    assert(got.ok, r.did + ': ' + got.error);
    checked++;
    if (C.records[r.did].fields.length) assert.strictEqual(got.values.length, C.records[r.did].fields.length);
    else assert.strictEqual(got.raw, r.response.slice(6).toUpperCase());
}

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zf8hp-test-'));
    const ctx = { dataDir: dir, settings: { get: () => 2 }, log: { info() {}, warn() {} } };
    const reader = new Reader(ctx), calls = [];
    reader.diag = { available: true, p: {}, physical: async (target, sid, args) => {
        calls.push({ target, sid, args });
        if (sid === 0x19) return [0x59, 0x02, 0xFF];
        if (args[0] === 0xF1) return [0x62, 0xF1, 0x50, 0x0F, 0x25, 0xD0];
        return [0x62, 0x60, 0x00, 100];
    } };
    await reader.read('6000');
    assert.strictEqual(calls.length, 0, 'Data reads must wait for EGS identity');
    await reader.read('F150');
    assert(reader.checked && reader.supported);
    await reader.read('6000');
    assert.strictEqual(reader.records['6000'].values[0], 60);
    await reader.readFaults();
    assert.deepStrictEqual(reader.faults, []);
    assert(calls.every((r) => r.target === 0x18 && (r.sid === 0x22 || r.sid === 0x19)));
    await assert.rejects(() => reader.read('FFFF'), /allowed read/);
    reader.save();
    const loaded = new Reader(ctx);
    assert.strictEqual(loaded.records['6000'].cached, true);
    loaded.diag = { available: true }; loaded.supported = true; loaded.checked = true;
    assert.strictEqual(loaded.status(), 'LINK STALE', 'A saved snapshot must not be presented as live');
    const hiddenReader = new Reader(ctx);
    hiddenReader.diag = reader.diag; hiddenReader.setWanted(['6000']); hiddenReader.running = true;
    let running = hiddenReader.pump(), count = calls.length;
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(calls.length, count, 'A hidden app must not poll');
    hiddenReader.setVisible(true);
    const deadline = Date.now() + 2500;
    while (!hiddenReader.supported && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    assert(calls.length > count && hiddenReader.supported, 'The visible app must identify EGS');
    hiddenReader.setVisible(false);
    await new Promise((r) => setTimeout(r, 250)); count = calls.length;
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(calls.length, count, 'Polling must stop when the screen is hidden');
    hiddenReader.running = false; await running;
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('ZF 8HP synthetic decoder/read-only checks passed' + (checked ? '; ' + checked + ' optional local records validated.' : '.'));
})().catch((e) => { console.error(e); process.exit(1); });
