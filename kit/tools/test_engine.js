'use strict';
/**
 * test_engine.js - checks kit/runtime/engine.js (engine profile) on the PC.
 *
 *   node kit/tools/test_engine.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Engine = require('../runtime/engine');

const log = { info() {}, warn() {}, error() {} };
const fakeSettings = (v) => ({ v: Object.assign({ engine: 'auto', redline: 0 }, v), get(k) { return this.v[k]; }, onChange(fn) { this.fn = fn; } });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'eng-'));
const make = (v, dir) => new Engine({ settings: fakeSettings(v), dataDir: dir || tmp(), log });

const cases = {
    typeOf() {
        [6, 7, 'DIESEL_DIREKTEINSPRITZUNG', 'DIESEL_KONVENTIONELL'].forEach((x) => assert.strictEqual(Engine.typeOf(x), 'diesel', String(x)));
        [4, 5, 8, 9, 'BENZIN_KONVENTIONELL', 'HYBRIDMOTOR'].forEach((x) => assert.strictEqual(Engine.typeOf(x), 'petrol', String(x)));
        [0, 15, 'SIGNAL_UNGUELTIG', undefined, 'x'].forEach((x) => assert.strictEqual(Engine.typeOf(x), null, String(x)));
    },
    'default petrol'() {
        const e = make();
        assert.strictEqual(e.profile(), 'petrol');
        assert.strictEqual(e.scaleMax(), 8000);
        assert.strictEqual(e.redline(), 7000);
    },
    'diesel detected'() {
        const dir = tmp(), e = make({}, dir);
        e.feed({ typeEngine: 6 });
        assert.strictEqual(e.profile(), 'diesel');
        assert.strictEqual(e.scaleMax(), 6000);
        assert.strictEqual(e.redline(), 5000);
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'engine.json'), 'utf8')), { type: 'diesel' });
    },
    'invalid then diesel'() {
        const e = make();
        e.feed({ typeEngine: 15 });
        e.feed({ typeEngine: 6 });
        assert.strictEqual(e.profile(), 'diesel');
    },
    'invalid keeps stored'() {
        const dir = tmp();
        make({}, dir).feed({ typeEngine: 7 });
        const e = make({}, dir);
        assert.strictEqual(e.profile(), 'diesel');
        e.feed({ typeEngine: 15 });
        assert.strictEqual(e.profile(), 'diesel');
    },
    'corrupt file'() {
        const dir = tmp();
        fs.writeFileSync(path.join(dir, 'engine.json'), '{nope');
        assert.strictEqual(make({}, dir).profile(), 'petrol');
    },
    'manual override'() {
        const dir = tmp();
        make({}, dir).feed({ typeEngine: 6 });
        assert.strictEqual(make({ engine: 'petrol' }, dir).profile(), 'petrol');
        assert.strictEqual(make({ engine: 'diesel' }).profile(), 'diesel');
    },
    'redline manual'() {
        assert.strictEqual(make({ engine: 'diesel', redline: 5500 }).redline(), 5500);
    },
    'auto scale follows the redline'() {
        Object.keys(Engine.PROFILES).forEach((k) => assert.strictEqual(make({ engine: k }).scaleMax(), Engine.PROFILES[k].scaleMax, k));
        assert.strictEqual(make({ engine: 'petrol', redline: 6000 }).scaleMax(), 7000);
        assert.strictEqual(make({ engine: 'petrol', redline: 6500 }).scaleMax(), 8000);
        assert.strictEqual(make({ engine: 'petrol', redline: 7000 }).scaleMax(), 8000);
        const d = make({ engine: 'diesel', redline: 9000 });
        assert.strictEqual(d.scaleMax(), 10000);
        assert.strictEqual(d.redline(), 9000);
        assert.strictEqual(make({ engine: 'diesel', redline: 5500 }).scaleMax(), 7000);
        assert.strictEqual(make({ engine: 'petrol', redline: 7500 }).scaleMax(), 9000);
        assert.strictEqual(make({ engine: 'petrol', redline: 7800 }).scaleMax(), 9000);
        assert.strictEqual(make({ engine: 'petrol', redline: 8500 }).scaleMax(), 10000);
    },
    'scale manual'() {
        assert.strictEqual(make({ engine: 'petrol', rpmScale: 7000, redline: 6200 }).redline(), 6200);
        assert.strictEqual(make({ engine: 'diesel', rpmScale: 7000 }).scaleMax(), 7000);
        assert.strictEqual(make({ engine: 'petrol', rpmScale: 9000, redline: 8500 }).redline(), 8500);
        assert.strictEqual(make({ engine: 'petrol', rpmScale: 0 }).scaleMax(), 8000);
    },
    'redline clamps to a manual scale'() {
        assert.strictEqual(make({ engine: 'diesel', rpmScale: 6000, redline: 9000 }).redline(), 6000);
    },
    'scale setting change fires'() {
        const st = fakeSettings({}), e = new Engine({ settings: st, dataDir: tmp(), log });
        let n = 0;
        e.onChange(() => { n++; });
        st.v.rpmScale = 9000; st.fn('rpmScale');
        assert.strictEqual(n, 1);
        assert.strictEqual(e.scaleMax(), 9000);
    },
    'value auto'() {
        assert.strictEqual(make({ engine: 'diesel', coldLimit: 0 }).value('coldLimit', { diesel: 3000, petrol: 4500 }), 3000);
        assert.strictEqual(make({ engine: 'diesel', coldLimit: 4000 }).value('coldLimit', { diesel: 3000, petrol: 4500 }), 4000);
    },
    'onChange fires'() {
        const e = make();
        let n = 0;
        e.onChange(() => { n++; });
        e.feed({ typeEngine: 6 });
        e.feed({ typeEngine: 6 });
        assert.strictEqual(n, 1);
    },
};

let ok = 0;
Object.keys(cases).forEach((name) => {
    try { cases[name](); ok++; } catch (e) { console.error('FAIL ' + name + ': ' + e.message); process.exitCode = 1; }
});
console.log('engine: ' + ok + ' ok' + (process.exitCode ? ', ' + (Object.keys(cases).length - ok) + ' failed' : ''));
