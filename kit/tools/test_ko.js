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
    [path.join(__dirname, 'build.py'), '--language', 'ko', '--preview-only', 'service'], { encoding: 'utf8' });
assert.strictEqual(built.status, 0, built.stderr);
const kit = path.join(stage, 'source/javascript/kit');
const { t, plural } = require(path.join(kit, 'i18n'));
const fonts = require(path.join(kit, 'fonts'));
assert.strictEqual(t('SPEED'), '속도');
assert.strictEqual(t('OIL COLD  ·  GO EASY'), '냉간 · 저부하 주행');
assert.strictEqual(t('rpm'), 'rpm');
assert.strictEqual(t('12 300 km'), '12 300 km');
// Whole battery headings must win over generic words such as charge/range.
for (const [english, korean] of [
    ['State of charge', '충전 상태'], ['STATE OF CHARGE', '충전 상태'],
    ['Voltage', '전압'], ['CAPACITY', '용량'], ['ORIGINAL', '초기 용량'],
    ['EARLIER', '이전 기록'], ['VOLTAGE RANGE', '전압 범위'],
    ['VOLTAGE, LAST 2 MIN', '전압, 최근 2분'], ['low', '낮음'], ['resting', '휴지 상태'],
    ['voltage says: alternator charging', '전압 기준: 발전기 충전 중'],
    ['voltage says: resting', '전압 기준: 휴지 상태'],
    ['~70 of 90 Ah', '~70 / 90 Ah'], ['~70.5 of 90.0 Ah', '~70.5 / 90.0 Ah'],
]) assert.strictEqual(t(english), korean, english);
assert.strictEqual(t('14.60 V'), '14.60 V');
assert.strictEqual(t('90 Ah'), '90 Ah');
assert.strictEqual(t('Range'), '주행거리'); // voltage range must not change driving range
assert.strictEqual(t('CURRENT'), '전류');
assert.strictEqual(t('Current'), '현재');
assert.strictEqual(t('normal'), '정상');
assert.strictEqual(t('Normal'), '보통');
assert.strictEqual(plural(1, 'month', 'months'), '개월');
assert.strictEqual(plural(12, 'month', 'months'), '개월');
assert.strictEqual(fonts.get('bold', 30, '엔진오일').family, 'korean');
assert.strictEqual(fonts.get('num', 96, '1234').family, 'num');
const f = fonts.get('label', 30, '2027년 9월');
assert(Array.from('2027년 9월').every((ch) => f.glyphs[ch.codePointAt(0)]));

const source = fs.readFileSync(path.join(root, 'apps/service/main.js'), 'utf8');
const context = { translate: t, getLanguage: () => 'ko', plural, fonts };
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('const MONTHS ='), source.indexOf('\nconst W =')) + '\nthis.parse = parseDue;', context);
vm.runInContext(source.slice(source.indexOf('const NAMES ='), source.indexOf('const DEMO =')) + '\nthis.nameOf = nameOf; this.value = value; this.usable = usable;', context);
const now = new Date(2026, 10, 4);
assert.strictEqual(context.parse('2027년 9월', now).text, '2027년 9월');
assert.strictEqual(context.parse('2027년 9월 15일', now).text, '2027년 9월 15일');
assert.strictEqual(context.parse('15.09.2027', now).text, '2027년 9월 15일');
assert.strictEqual(context.parse('09/2027', now).left, '10개월 후');
assert.strictEqual(context.parse('10/2026', now).left, '1개월 초과');
assert.strictEqual(context.parse('2026년 11월', now).left, '이번 달');
assert.strictEqual(context.parse('2027년 13월', now), null);
assert.strictEqual(context.nameOf(1, '엔진오일'), '엔진오일');
assert.strictEqual(context.value('2027년 9월'), '2027년 9월');
assert(context.usable('브레이크액 교환이 필요합니다'));
assert(!context.usable('???'));
assert.strictEqual(t(context.nameOf(1, '???')), '엔진오일');
assert.strictEqual(t(context.nameOf(1, '힣')), '엔진오일'); // outside the baked native-text subset

const { Canvas } = require(path.join(kit, 'canvas'));
const { Recorder, play, atlasList } = require(path.join(kit, 'record'));
for (const opt of [{}, { align: 'center', spacing: 1 }, { align: 'right', font: 'bold' }]) {
    const text = '엔진오일 2027년 9월', cv = new Canvas(600, 100), rec = new Recorder(600, 100);
    const w = cv.text(text, 300, 60, 28, '#fff', opt);
    assert(Math.abs(rec.text(text, 300, 60, 28, '#fff', opt) - w) < 0.001);
    assert(Math.abs(rec.textWidth(text, 28, opt) - cv.textWidth(text, 28, opt)) < 0.001);
    const output = new Canvas(600, 100);
    play(rec, output);
    assert(output.png().length > 1000, 'recorded Korean text must rasterise');
}
assert(atlasList.some((a) => a.f.family === 'korean'));
console.log('PASS: Korean service dates/native texts/fallbacks, units, plurals, software and GPU command text');
