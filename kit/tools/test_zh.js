'use strict';
// Run with Node >=14 on the PC. Does not load BMW's SDK or connect to a car.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { t, dict, setLanguage, getLanguage } = require('../runtime/i18n');
const { HmiText, slotId } = require('../runtime/hmi-text');
const fonts = require('../runtime/fonts');
const { Canvas } = require('../runtime/canvas');
const { Recorder } = require('../runtime/record');
const { CREDIT, drawCredit } = require('../runtime/credits');
const { LocaleUi } = require('../runtime/locale-ui');
const os = require('os');

async function main() {
    assert.strictEqual(getLanguage(), 'en');
    assert.strictEqual(t('Settings'), 'Settings');
    const settingsSource = fs.readFileSync(path.join(__dirname, '../runtime/mgu.js'), 'utf8').match(/class Settings[\s\S]*?\n}\n/)[0];
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-locale-test-'));
    try {
        const Settings = new Function('fs', 'path', 'DATA_DIR', 'log', settingsSource + '\nreturn Settings;')(fs, path, temporary, console);
        const schema = [{ key: 'language', type: 'choice', default: 'en', options: [['en', 'English'], ['zh-CN', '中文']] }];
        let saved = new Settings(schema); assert.strictEqual(saved.get('language'), 'en');
        saved.set('language', 'zh-CN'); saved = new Settings(schema);
        assert.strictEqual(saved.get('language'), 'zh-CN', 'Chinese survives an app restart');
        saved.set('language', 'en'); assert.strictEqual(new Settings(schema).get('language'), 'en');
    } finally {
        const file = path.join(temporary, 'settings.json'); if (fs.existsSync(file)) fs.unlinkSync(file);
        fs.rmdirSync(temporary);
    }
    const englishCredit = new Canvas(500, 40);
    drawCredit(englishCredit, 480, 25);
    assert(!englishCredit.d.some((v) => v), 'no corner attribution in English');
    setLanguage('zh-CN');
    assert.strictEqual(t('Settings'), '设置');
    assert.strictEqual(t('WARM-UP'), '暖机助手');
    assert.strictEqual(t('  PEAK  3.2 g'), '  峰值  3.2 g');
    assert.strictEqual(t('statusEngineSpeed2'), 'statusEngineSpeed2');
    assert.strictEqual(t('22 F1 50'), '22 F1 50');
    assert.strictEqual(t('rpm'), 'rpm');
    assert.strictEqual(t('config.battery'), 'config.battery');
    assert.strictEqual(t(' min 70  max 90'), ' 最小 70  最大 90');
    for (const value of Object.values(dict)) assert.strictEqual(t(value), value, 'translation must be idempotent: ' + value);

    const updates = [], writes = [];
    const component = {
        getStringBundle: () => ({ setStrings: async (table) => updates.push(table) }),
        setValue: async (...args) => writes.push(args),
    };
    const hmi = new HmiText();
    await hmi.set(component, 'BTN_SCAN', 0, 'Text', 'Scan now');
    assert.deepStrictEqual(updates[0], { [slotId(0)]: '立即扫描' });
    assert.deepStrictEqual(writes[0], [0, 'Text', slotId(0), 'StringId']);
    await hmi.set(component, 'BTN_SCAN', 0, 'Text', 'Scan again');
    assert.strictEqual(hmi.slots.size, 1, 'repeated cell must reuse its resource');
    await hmi.set(component, 'LIST', 1, 'Text', 'Engine');
    assert.strictEqual(hmi.slots.size, 2, 'another row needs another resource');
    await hmi.set(component, 'CODE', 0, 'Text', 'D1C604');
    assert.deepStrictEqual(writes[3], [0, 'Text', 'D1C604', 'Text']);
    let selected = 'en';
    const tables = { en: { SID_TITLE: 'Settings' }, 'zh-CN': { SID_TITLE: '设置' } };
    const staticUpdates = [];
    const locale = new LocaleUi({ get: () => selected }, tables, { setStrings: async (table) => staticUpdates.push(table) }, hmi);
    await locale.refresh();
    assert.strictEqual(getLanguage(), 'en');
    assert.deepStrictEqual(staticUpdates[0], tables.en);
    assert(writes.some((a) => a[2] === 'Scan again' && a[3] === 'Text'), 'existing dynamic rows revert to English');
    selected = 'zh-CN'; await locale.refresh();
    assert.strictEqual(getLanguage(), 'zh-CN');
    assert.deepStrictEqual(staticUpdates[1], tables['zh-CN']);
    assert(updates.some((a) => Object.values(a).includes('重新扫描')), 'existing dynamic rows retranslate');
    selected = 'en'; const first = locale.refresh(); selected = 'zh-CN'; const second = locale.refresh();
    await Promise.all([first, second]);
    assert.strictEqual(getLanguage(), 'zh-CN', 'rapid switches must settle on the latest choice');

    const cjk = fonts.get('bold', 32, '中文');
    assert.strictEqual(cjk.family, 'cjk');
    for (const ch of CREDIT) assert(cjk.glyphs[ch.codePointAt(0)], 'missing attribution glyph: ' + ch);
    for (const value of Object.values(dict)) {
        for (const ch of value) assert(cjk.glyphs[ch.codePointAt(0)], 'missing glyph: ' + ch);
    }
    const cv = new Canvas(800, 120), rec = new Recorder(800, 120);
    const opts = { font: 'num', spacing: 1 };
    const cw = cv.text('SAFE REV LIMIT', 10, 60, 32, '#ffffff', opts);
    const rw = rec.text('SAFE REV LIMIT', 10, 60, 32, '#ffffff', opts);
    assert.strictEqual(cw, cv.textWidth('SAFE REV LIMIT', 32, opts));
    assert.strictEqual(rw, rec.textWidth('SAFE REV LIMIT', 32, opts));
    assert.strictEqual(cw, rw, 'GPU/software must use the same translated widths');
    rec.text('Oil', 10, 100, 24, '#ffffff', { font: 'bold' });
    assert.strictEqual(rec.atlases.size, 1, 'CJK atlas shared across requested families and sizes');
    assert(cv.d.some((v) => v), 'Chinese raster must contain visible pixels');
    const creditCanvas = new Canvas(500, 40);
    drawCredit(creditCanvas, 480, 25);
    let maxAlpha = 0;
    for (let i = 3; i < creditCanvas.d.length; i += 4) maxAlpha = Math.max(maxAlpha, creditCanvas.d[i]);
    assert(maxAlpha > 0 && maxAlpha <= 64, 'corner credit must remain subtle (25% opacity)');
    const G = require('../runtime/gauges'), theme = require('../runtime/themes').theme('m_tricolour');
    const gauge = { label: 'Oil', value: null, max: 150, smooth: false };
    const layerIds = (lang) => {
        setLanguage(lang); const r = new Recorder(300, 300); G.radial(r, theme, 150, 150, 100, gauge);
        return Array.from(r.layersUsed);
    };
    const enLayers = layerIds('en'), zhLayers = layerIds('zh-CN');
    assert.notDeepStrictEqual(enLayers, zhLayers, 'cached gauge labels must follow language');
    assert.deepStrictEqual(layerIds('en'), enLayers, 'returning to English must reuse the English layer');

    let height = 0;
    for (const file of fs.readdirSync(path.join(__dirname, '../runtime/fonts')).filter((s) => s.endsWith('.json'))) {
        const f = JSON.parse(fs.readFileSync(path.join(__dirname, '../runtime/fonts', file), 'utf8'));
        for (const s of f.sizes) { assert(s.atlasW <= 1024 && s.atlasH <= 4096); height += s.atlasH + 1; }
    }
    assert(height < 2 * 4096, 'all atlases must fit the unmodified GPU renderer');
    setLanguage('invalid'); assert.strictEqual(getLanguage(), 'en');
    console.log('PASS: default English, two-way language changes, dynamic rows, corner credit visibility, glyphs and GPU budget');
}
main().catch((e) => { console.error(e); process.exit(1); });
