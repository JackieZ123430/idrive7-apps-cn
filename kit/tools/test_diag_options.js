'use strict';

const assert = require('assert');
const { Diag } = require('../runtime/diag');
const log = { info() {}, warn() {} };

(async () => {
    const calls = [];
    const retry = new Diag({ call: async (p, method, args, timeout) => {
        calls.push({ method, timeout });
        return { TasuErrorEnum: calls.length < 3 ? 'APP_REQUEST_TEMPORARILY_NOT_ACCEPTED' : 'NO_ERROR' };
    } }, log);
    retry.p = {};
    assert.strictEqual(await retry.send(0x18, 0x22, [0x60, 0], { maxRetries: 2, retryBaseMs: 1, callTimeoutMs: 90 }), 'NO_ERROR');
    assert.strictEqual(calls.length, 3);
    assert(calls.every((c) => c.timeout === 90));
    const d = new Diag(null, log);
    d.send = async () => {
        d.emit('frame', { ecu: 0x18, uds: [0x62, 0x60, 0, 100] });
        return 'NO_ERROR';
    };
    assert.deepStrictEqual(await d.physical(0x18, 0x22, [0x60, 0], 100), [0x62, 0x60, 0, 100]);
    assert.strictEqual(d.listenerCount('frame'), 0);
    d.send = async () => {
        setImmediate(() => d.emit('frame', { ecu: 0x18, uds: [0x7F, 0x22, 0x78] }));
        return 'REQUEST_PENDING';
    };
    const began = Date.now();
    assert.strictEqual(await d.physical(0x18, 0x22, [0x60, 0], 150, null, { hardTimeoutMs: 40, pendingTimeoutMs: 120 }), null);
    assert(Date.now() - began < 500);
    assert.strictEqual(d.listenerCount('frame'), 0);
    console.log('Diagnostic retry/deadline checks passed.');
})().catch((e) => { console.error(e); process.exit(1); });
