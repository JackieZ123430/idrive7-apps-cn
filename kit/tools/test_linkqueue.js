'use strict';
/* apps/edrive/linkqueue.js: the power reads first, but a read waiting gets a turn after URGENT_RUN of them. */
const assert = require('assert');
const path = require('path');
const { linkQueue, URGENT_RUN } = require(path.join(__dirname, '..', '..', 'apps', 'edrive', 'linkqueue.js'));

(async () => {
    const order = [];
    const ex = linkQueue({ warn() {} });
    const turn = (name) => () => new Promise((r) => setImmediate(() => { order.push(name); r(name); }));
    // a power read always waiting (each queues the next before it ends), as the live page at ~3 a second
    let powers = 0, stop = false;
    const power = () => ex(async () => { powers++; if (!stop) power(); await turn('p')(); }, true, 'power');
    power();
    const soc = await ex(turn('soc'), false, 'soc');
    stop = true;
    assert.strictEqual(soc, 'soc');
    const at = order.indexOf('soc');
    assert(at >= 0 && at <= URGENT_RUN, 'the charge read after ' + at + ' power reads (at most ' + URGENT_RUN + ')');
    console.log('ok   the charge is read while the power reads never stop (after ' + at + ' of them)');
    // urgent ones keep their order, ahead of the reads waiting
    const o2 = [], ex2 = linkQueue({ warn() {} });
    const t2 = (n) => () => new Promise((r) => setImmediate(() => { o2.push(n); r(); }));
    await Promise.all([ex2(t2('a'), false), ex2(t2('b'), false), ex2(t2('u1'), true), ex2(t2('u2'), true)]);
    assert.deepStrictEqual(o2, ['a', 'u1', 'u2', 'b']);
    console.log('ok   urgent ones in order, ahead of the reads waiting');
    console.log('linkqueue: 2 checks pass');
})().catch((e) => { console.error(e); process.exit(1); });
