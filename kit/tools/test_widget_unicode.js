'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const runtime = path.join(__dirname, '../runtime');

function load(name, requireModule) {
    const context = { module: { exports: {} }, require: requireModule };
    const file = path.join(runtime, name);
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    return context.module.exports;
}

async function check(language) {
    const i18n = load('i18n.js', () => ({ language, strings: { Settings: '设置' } }));
    const { HmiText } = load('hmi-text.js', () => i18n);
    const source = fs.readFileSync(path.join(runtime, 'mgu.js'), 'utf8');
    const widgetSource = source.match(/class Widget \{[\s\S]*?^\}/m)[0];
    const asciiSource = source.match(/^function widgetText\(s\) \{[\s\S]*?^\}/m)[0];
    const context = { getLanguage: i18n.getLanguage, HmiText, log: { warn: assert.fail } };
    const Widget = vm.runInNewContext(asciiSource + '\n' + widgetSource + '\nWidget;', context);
    const widget = new Widget({});
    const calls = [];
    const strings = {};
    widget.comp = {
        setValue: (...args) => { calls.push(args); return Promise.resolve(); },
        getStringBundle: () => ({ setStrings: values => Promise.resolve(Object.assign(strings, values)) }),
    };

    await widget.set(1, 'Title', 'Settings', 'Text');
    const title = calls.pop();
    if (language === 'zh-CN') {
        assert.strictEqual(title[3], 'StringId');
        assert.strictEqual(strings[title[2]], '设置');
        await widget.set(2, 'Title', '中文', 'Text');
        const second = calls.pop();
        assert.notStrictEqual(title[2], second[2]);
        assert.strictEqual(strings[second[2]], '中文');
    } else {
        assert.deepStrictEqual(title, [1, 'Title', 'Settings', 'Text']);
        await widget.set(1, 'Temp', '90 °C', 'Text');
        assert.deepStrictEqual(calls.pop(), [1, 'Temp', '90 C', 'Text']);
        assert.deepStrictEqual(strings, {});
    }
    await widget.set(2, 'Progress', 0.7, 'Float');
    assert.deepStrictEqual(calls.pop(), [2, 'Progress', 0.7, 'Float']);
}

Promise.resolve().then(() => check('en')).then(() => check('ko')).then(() => check('zh-CN')).then(() => {
    console.log('Widget text keeps the existing English and Korean paths and uses independent Chinese slots');
}).catch(error => { console.error(error); process.exitCode = 1; });
