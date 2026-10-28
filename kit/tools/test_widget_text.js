'use strict';
// Offline widget translation/lifecycle tests: no SDK or vehicle connection.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const EventEmitter = require('events');
const runtime = path.resolve(__dirname, '../runtime');
async function check(language) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-widget-'));
    try {
        for (const file of ['widget-text.js', 'i18n.js']) fs.copyFileSync(path.join(runtime, file), path.join(temp, file));
        const dict = language === 'en' ? {} : JSON.parse(fs.readFileSync(path.join(runtime, 'locales', language + '.json'), 'utf8'));
        fs.writeFileSync(path.join(temp, 'locale.json'), JSON.stringify({ language, strings: dict }));
        const { WidgetText, SLOT_COUNT, slotId } = require(path.join(temp, 'widget-text'));
        const updates = [], writes = [];
        const component = new EventEmitter();
        component.spawnedInstances = { 1: { widgetSize: 1 } };
        component.getStringBundle = () => ({ setStrings: async (s) => updates.push(s) });
        component.setValue = async (...args) => writes.push(args);
        const pool = new WidgetText();
        await pool.set(component, 1, 'Title', 'eDrive');
        if (language === 'en') assert.deepStrictEqual(writes[0], [1, 'Title', 'eDrive', 'Text']);
        else {
            assert.deepStrictEqual(updates[0], { [slotId(0)]: 'eDrive助手' });
            assert.deepStrictEqual(writes[0], [1, 'Title', slotId(0), 'StringId']);
        }
        const count = writes.length;
        await pool.set(component, 1, 'Title', 'eDrive');
        assert.strictEqual(writes.length, count, 'unchanged values do not flood the HMI');
        await pool.set(component, 2, 'Title', '中文測試');
        if (language !== 'en') assert.notStrictEqual(writes[0][2], writes[writes.length - 1][2], 'instances need independent slots');
        pool.release(2);
        // Repeatedly add/delete widgets without exhausting the fixed bundle.
        for (let i = 0; i < SLOT_COUNT * 2; i++) {
            await pool.set(component, 100 + i, 'Title', '中文測試');
            pool.release(100 + i);
        }
        pool.invalidate(1);
        await pool.set(component, 1, 'Title', 'eDrive');
        assert(writes.length > count);

        // An old async bundle write must finish before its slot can be reused.
        const queued = new WidgetText(), order = [], queuedWrites = [];
        let resolveFirst, entered;
        const enteredPromise = new Promise((resolve) => { entered = resolve; });
        let first = true;
        const slow = {
            getStringBundle: () => ({ setStrings: (s) => {
                order.push(Object.values(s)[0]);
                if (!first) return Promise.resolve();
                first = false; entered();
                return new Promise((resolve) => { resolveFirst = resolve; });
            } }),
            setValue: async (...args) => queuedWrites.push(args),
        };
        const old = queued.set(slow, 1, 'Title', '舊值');
        await enteredPromise;
        queued.release(1);
        const replacement = queued.set(slow, 2, 'Title', '新值');
        resolveFirst();
        await Promise.all([old, replacement]);
        assert.deepStrictEqual(order, ['舊值', '新值']);
        assert.strictEqual(queuedWrites.length, 1);
        assert.strictEqual(queuedWrites[0][0], 2);
        await Promise.all([queued.set(slow, 2, 'Title', '中文'), queued.set(slow, 2, 'Title', '12 V')]);
        assert.deepStrictEqual(queuedWrites[queuedWrites.length - 1], [2, 'Title', '12 V', 'Text']);
        queued.dispose();
        const before = queuedWrites.length;
        await queued.set(slow, 3, 'Title', '中文');
        assert.strictEqual(queuedWrites.length, before);

        const full = new WidgetText();
        for (let i = 0; i < SLOT_COUNT; i++) await full.set(component, i, 'Title', '中文');
        await assert.rejects(full.set(component, 999, 'Title', '中文'), /pool exhausted/);
        full.release(0);
        await full.set(component, 999, 'Title', '中文');
        const retry = new WidgetText();
        let fail = true;
        const faulty = { getStringBundle: () => ({ setStrings: async () => { if (fail) throw Error('temporary'); } }), setValue: async () => {} };
        await assert.rejects(retry.set(faulty, 1, 'Title', '中文'));
        fail = false;
        await retry.set(faulty, 1, 'Title', '中文');

        // Exercise the real Widget adapter with mocked RHMI components/events.
        const source = fs.readFileSync(path.join(runtime, 'mgu.js'), 'utf8');
        const start = source.indexOf('class Widget {'), end = source.indexOf('/* ---------------- run', start);
        const context = { WidgetText, SPEC: { id: 'edrive' }, log: { info() {}, warn() {}, error() {} }, Promise, Object, Number };
        vm.runInNewContext(source.slice(start, end) + '\nthis.Widget = Widget;', context);
        const widget = new context.Widget({ cells: { Title: ['eDrive', 'Text'], ProgressbarVisible: [true, 'Bool'] } });
        widget.attach({ getByName: () => component });
        await widget.text.tail;
        assert(writes.some((v) => v[1] === 'ProgressbarVisible' && v[2] === true && v[3] === 'Bool'));
        await widget.set(1, 'Progress', 40, 'Float');
        assert.deepStrictEqual(writes[writes.length - 1], [1, 'Progress', 40, 'Float']);
        component.emit('resize', { spawnId: 1 });
        await widget.text.tail;
        component.emit('visible', { spawnId: 1, visible: true });
        await widget.text.tail;
        component.emit('destroyed', { spawnId: 1 });
        assert.strictEqual(widget.text.entries.size, 0);
        console.log('PASS: ' + language + ' widget Unicode, instance isolation, lifecycle, slot reuse/budget, ordering and error recovery');
    } finally {
        for (const file of fs.readdirSync(temp)) fs.unlinkSync(path.join(temp, file));
        fs.rmdirSync(temp);
    }
}
(async () => { for (const language of ['en', 'zh-CN', 'zh-TW']) await check(language); })().catch((e) => { console.error(e); process.exit(1); });
