'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '../..');
const stage = path.join(root, 'dist/live_adjustments/source');
const python = process.env.MGU_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const built = spawnSync(python, [path.join(__dirname, 'build.py'), '--language', 'zh-TW',
    '--preview-only', 'live_adjustments'], { cwd: root, encoding: 'utf8', timeout: 120000, windowsHide: true });
assert.strictEqual(built.status, 0, built.stderr || String(built.error));
const kit = path.join(stage, 'javascript/kit');
const locale = require(path.join(kit, 'locale.json'));
const { t, plural, PLURAL_RULES, getLanguage } = require(path.join(kit, 'i18n'));
const credit = require('../localization/credit.zh-TW.json');
assert.strictEqual(getLanguage(), 'zh-TW');
assert.strictEqual(locale.credit, credit.corner);
assert(fs.readFileSync(path.join(stage, 'javascript/app.js'), 'utf8').startsWith('// ' + credit.comment[0] + '\n'));
assert(require(path.join(stage, 'package.json')).version.endsWith('-zh.tw.1'));
assert.strictEqual(t('Apply'), '套用');
assert.strictEqual(t('Engine Map'), '引擎程式');
assert.strictEqual(t('min 70'), '最小 70');
assert.strictEqual(t('max 7200'), '最大 7200');
assert.strictEqual(t('12 min'), '12 min');
assert.strictEqual(t('14.60 V'), '14.60 V');
assert.strictEqual(t('rpm'), 'rpm');
assert.strictEqual(PLURAL_RULES['zh-TW'](12), 0);
const row = Object.keys(locale.strings).find((key) => key.includes('|'));
if (row) {
    const [one, many] = row.split('|');
    assert.strictEqual(plural(12, one, many), locale.strings[row]);
}
const stagedAtlas = fs.readFileSync(path.join(kit, 'fonts/cjk.json'));
assert(stagedAtlas.equals(fs.readFileSync(path.join(root, 'kit/localization/fonts/cjk-zh-TW.json'))));

const fonts = require(path.join(kit, 'fonts'));
const atlas = fonts.get('label', 32, '繁體中文');
assert.strictEqual(atlas.family, 'cjk');
const samples = new Map();
for (const [cp, glyph] of Object.entries(atlas.glyphs)) {
    if (!glyph[2] || !glyph[3]) continue;
    const piece = fonts.piece(atlas, Number(cp));
    assert(piece.atlasH <= fonts.PIECE_H && piece.atlasW === atlas.atlasW);
    assert(glyph[1] >= piece.y0 && glyph[1] + glyph[3] <= piece.y0 + piece.atlasH);
    if (Number(cp) > 127 && !samples.has(piece)) samples.set(piece, String.fromCodePoint(Number(cp)));
}
assert(samples.size > 1, 'Traditional Chinese glyphs must exercise multiple renderer pieces');
const sample = [...samples.values()].join('');
const { Canvas } = require(path.join(kit, 'canvas'));
const { Recorder, atlasById, play } = require(path.join(kit, 'record'));
const record = () => {
    const recorder = new Recorder(700, 100);
    recorder.text(sample, 10, 50, 32, '#fff', { literal: true });
    return recorder;
};
const split = record();
assert.strictEqual(split.atlases.size, samples.size);
assert([...split.atlases].every((id) => samples.has(atlasById(id))));

// Compare identical draw commands with and without the runtime's atlas splitting.
const pieceFor = fonts.piece;
let whole;
try {
    fonts.piece = (font) => font;
    whole = record();
} finally {
    fonts.piece = pieceFor;
}
assert.strictEqual(whole.atlases.size, 1);
const replay = play(split.words(), new Canvas(700, 100));
const unsplit = play(whole.words(), new Canvas(700, 100));
assert(replay.d.some((channel) => channel !== 0), 'sample must draw visible pixels');
assert(Buffer.from(replay.d).equals(Buffer.from(unsplit.d)), 'piece replay must match whole-atlas replay');
console.log('PASS: zh-TW preview package, attribution, runtime, and pixel-identical replay across ' + samples.size + ' atlas pieces');
