'use strict';

const assert = require('assert');
const { Diag, replyTo } = require('../runtime/diag');
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
    // physical: another app's 7F xx 78 (car_vitals' own read waiting) is not this request's response pending
    d.send = async () => {
        setTimeout(() => d.emit('frame', { ecu: 0x12, uds: [0x7F, 0x22, 0x78] }), 2);
        return 'NO_ERROR';
    };
    const waited = Date.now(), mine = (u) => u[0] === 0x6F || (u[0] === 0x7F && u[1] === 0x2F);
    assert.strictEqual(await d.physical(0x12, 0x2F, [0x01, 0x02], 40, mine, { pendingTimeoutMs: 2000 }), null);
    assert(Date.now() - waited < 1000, 'a foreign 7F 22 78 extended the wait');
    d.send = async () => {
        [[0x7F, 0x22, 0x78], [0x7F, 0x2F, 0x78], [0x6F, 0x01, 0x02]].forEach((uds, i) => setTimeout(() => d.emit('frame', { ecu: 0x12, uds }), 2 + i * 30));
        return 'NO_ERROR';
    };
    assert.deepStrictEqual(await d.physical(0x12, 0x2F, [0x01, 0x02], 40, mine), [0x6F, 0x01, 0x02]);   // its own 78 still waits
    // ... and is never taken as the reply, also with a weak or no accept (Service's KOMBI reset)
    d.send = async () => {
        [[0x7F, 0x22, 0x78], [0x6E, 0x10, 0x01]].forEach((uds, i) => setTimeout(() => d.emit('frame', { ecu: 0x60, uds }), 2 + i * 10));
        return 'NO_ERROR';
    };
    assert.deepStrictEqual(await d.physical(0x60, 0x2E, [0x10, 0x01], 100, (u) => u[0] !== 0x6E || u[1] === 0x10), [0x6E, 0x10, 0x01]);
    assert.deepStrictEqual(await d.physical(0x60, 0x2E, [0x10, 0x01], 100), [0x6E, 0x10, 0x01]);
    // functional 0x19: a 59 for another sub-function (zf8hp's physical 19 02) is not this scan's reply
    d.send = async () => {
        [[0x12, [0x59, 0x17, 0xFF]], [0x12, [0x59, 0x02, 0xFF, 0x12, 0x34, 0x56, 0x09]]]
            .forEach(([ecu, uds], i) => setTimeout(() => d.emit('frame', { ecu, uds }), 2 + i * 2));
        return 'NO_ERROR';
    };
    assert.deepStrictEqual([...await d.functional(0x19, [0x17, 0xFF], { idleMs: 40 })], [[0x12, [0x59, 0x17, 0xFF]]]);
    // functional: another app's frame from the same ECU (car_vitals polls the DME) keeps the scan's reply
    d.send = async () => {
        [[0x12, [0x7F, 0x19, 0x78]], [0x12, [0x59, 0x02, 0xFF, 0x12, 0x34, 0x56, 0x09]], [0x12, [0x7F, 0x22, 0x31]],
            [0x12, [0x62, 0xF4, 0x0C, 0x0B]], [0x18, [0x7F, 0x19, 0x31]], [0x40, [0x62, 0xF1, 0x90]]]
            .forEach(([ecu, uds], i) => setTimeout(() => d.emit('frame', { ecu, uds }), 2 + i * 2));
        return 'NO_ERROR';
    };
    const scan = await d.functional(0x19, [0x02, 0x0C], { idleMs: 40 });
    assert.deepStrictEqual([...scan], [[0x12, [0x59, 0x02, 0xFF, 0x12, 0x34, 0x56, 0x09]], [0x18, [0x7F, 0x19, 0x31]]]);
    assert.strictEqual(d.listenerCount('frame'), 0);
    // replyTo: the positive reply with this request's echo, or a refusal of its service
    const oem = replyTo(0x2F, [0x60, 0xFD, 0x00]);
    assert(!oem([0x6F, 0x60, 0xFD, 0x03, 0x03, 0xE8]), "a late OPEN echo (6F 60FD 03) taken as OEM's answer");
    assert(oem([0x6F, 0x60, 0xFD, 0x00]) && oem([0x7F, 0x2F, 0x22]) && !oem([0x7F, 0x22, 0x31]));
    assert(replyTo(0x2F, [0x01, 0x02])([0x6F, 0x01, 0x02]), 'an MHD echo (two bytes)');
    const cbs = replyTo(0x2E, [0x10, 0x01, 0x01, 0x07]);           // Service's reset (WriteDataByIdentifier 1001)
    assert(cbs([0x6E, 0x10, 0x01]) && !cbs([0x6E, 0x10, 0x02]) && !cbs([0x62, 0x10, 0x01]) && !cbs([0x7F, 0x22, 0x31]), 'Service: 6E 1001 only');
    const did = replyTo(0x22, [0x10, 0x02]);
    assert(did([0x62, 0x10, 0x02, 0x05]) && !did([0x62, 0x10, 0x01, 0x05]) && did([0x7F, 0x22, 0x31]), 'Service: 62 1002 only');
    console.log('Diagnostic retry/deadline/functional reply checks passed.');
})().catch((e) => { console.error(e); process.exit(1); });
