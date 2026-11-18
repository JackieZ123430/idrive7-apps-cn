'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '../..');
const stage = path.join(root, 'dist/service');
// The offline stage contains real app/runtime code and font data, never a fake SDK.
const built = spawnSync(process.env.MGU_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    [path.join(__dirname, 'build.py'), '--language', 'es', '--preview-only', 'service'], { encoding: 'utf8' });
assert.strictEqual(built.status, 0, built.stderr);
const kit = path.join(stage, 'source/javascript/kit');
const { t, plural, getLanguage } = require(path.join(kit, 'i18n'));
const fonts = require(path.join(kit, 'fonts'));
assert.strictEqual(getLanguage(), 'es');
assert.strictEqual(t('SPEED'), 'VELOCIDAD');
assert.strictEqual(t('OIL COLD  ·  GO EASY'), 'ACEITE FRÍO  ·  SUAVE');
assert.strictEqual(t('rpm'), 'rpm');
assert.strictEqual(t('12 300 km'), '12 300 km');
assert.strictEqual(t('14.60 V'), '14.60 V');
// the same word with different meanings keeps them apart
assert.strictEqual(t('Range'), 'Autonomía');
assert.strictEqual(t('CURRENT'), 'CORRIENTE');
assert.strictEqual(t('Current'), 'Actual');
// a text found through a key of another case is drawn in the case the English uses
assert.strictEqual(t('HARDEST STOP'), 'FRENADA MÁS FUERTE');
assert.strictEqual(t('Dial (E60 M5)'), 'Esfera (E60 M5)');
assert.strictEqual(t('learned from 0 shifts'), 'aprendido en 0 cambios');
// short words that need the number next to them
assert.strictEqual(t('min 70'), 'mín. 70');
assert.strictEqual(t('max 7200'), 'máx. 7200');
assert.strictEqual(t('12 min'), '12 min');
assert.strictEqual(t('~70 of 90 Ah'), '~70 de 90 Ah');
assert.strictEqual(t('5 min ago'), 'hace 5 min');
assert.strictEqual(t('3 days ago'), 'hace 3 días');
assert.strictEqual(t('40s atrás'), 'hace 40 s'); // a number before an already translated fragment (zf8hp)
assert.strictEqual(plural(1, 'month', 'months'), 'mes');
assert.strictEqual(plural(12, 'month', 'months'), 'meses');
assert.strictEqual(plural(0, 'fault', 'faults'), 'averías');
assert.strictEqual(plural(1, 'fault', 'faults'), 'avería');

// the Spanish atlases: every English glyph as it was, the Spanish letters added, a texture id of their own
for (const family of ['label', 'bold', 'light', 'num']) {
    const english = JSON.parse(fs.readFileSync(path.join(root, 'kit/runtime/fonts', family + '.json'), 'utf8'));
    const f = fonts.get(family, english.sizes[0].size, 'PRESIÓN');
    assert.strictEqual(f.family, family);
    assert(f.cacheKey, family + ' needs its own cacheKey');
    for (const ch of 'ÁÉÍÓÚÜÑáéíóúüñ¿¡') assert(f.glyphs[ch.codePointAt(0)], family + ' has no ' + ch);
    for (const [code, glyph] of Object.entries(english.sizes[0].glyphs)) assert.deepStrictEqual(f.glyphs[code], glyph, family + ' ' + code);
}
assert.strictEqual(fonts.get('num', 96, '1234').family, 'num');

const source = fs.readFileSync(path.join(root, 'apps/service/main.js'), 'utf8');
const context = { translate: t, getLanguage: () => 'es', plural, fonts };
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('const MONTHS ='), source.indexOf('\nconst W =')) + '\nthis.parse = parseDue;', context);
vm.runInContext(source.slice(source.indexOf('const NAMES ='), source.indexOf('const DEMO =')) + '\nthis.nameOf = nameOf; this.value = value; this.usable = usable;', context);
const now = new Date(2026, 10, 4);
assert.strictEqual(context.parse('15.09.2027', now).text, '15 de septiembre de 2027');
assert.strictEqual(context.parse('09/2027', now).text, 'septiembre de 2027');
assert.strictEqual(context.parse('2027-01', now).text, 'enero de 2027');
assert.strictEqual(context.parse('09/2027', now).left, 'en 10 meses');
assert.strictEqual(context.parse('12/2026', now).left, 'en 1 mes');
assert.strictEqual(context.parse('10/2026', now).left, '1 mes de retraso');
assert.strictEqual(context.parse('11/2026', now).left, 'este mes');
assert.strictEqual(context.parse('13/2027', now), null);
// a Spanish iDrive's own item names and hints are drawn as the car gives them
assert(context.usable('Líquido de frenos'));
assert(context.usable('Inspección del vehículo según ley'));
assert.strictEqual(context.nameOf(1, 'Aceite de motor'), 'Aceite de motor');
assert(!context.usable('???'));

const { Canvas } = require(path.join(kit, 'canvas'));
const { Recorder, play, atlasList } = require(path.join(kit, 'record'));
for (const opt of [{}, { align: 'center', spacing: 1 }, { align: 'right', font: 'bold' }]) {
    const text = 'Líquido de frenos: ¿cambio en 2027?', cv = new Canvas(700, 100), rec = new Recorder(700, 100);
    const w = cv.text(text, 350, 60, 28, '#fff', opt);
    assert(Math.abs(rec.text(text, 350, 60, 28, '#fff', opt) - w) < 0.001);
    assert(Math.abs(rec.textWidth(text, 28, opt) - cv.textWidth(text, 28, opt)) < 0.001);
    const output = new Canvas(700, 100);
    play(rec, output);
    assert(output.png().length > 1000, 'recorded Spanish text must rasterise');
}
assert(atlasList.every((a) => a.f.cacheKey), 'the Spanish atlases go to the renderer under their own key');
console.log('PASS: Spanish service dates/native texts, units, plurals, short words, atlases and GPU command text');
