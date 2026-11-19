'use strict';
// Tall glyph atlases (Korean 1024 x 2976) go to the GPU renderer in pieces of at most fonts.PIECE_H
// rows, so they fit in what the other apps' atlases left of the renderer's shared texture.
// Before, a Korean app opened after the HUD / cluster apps had every Hangul glyph blank.
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '../..');
const built = spawnSync(process.env.MGU_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    [path.join(__dirname, 'build.py'), '--language', 'ko', '--preview-only', 'service'], { encoding: 'utf8' });
assert.strictEqual(built.status, 0, built.stderr);
const kit = path.join(root, 'dist/service/source/javascript/kit');
const fonts = require(path.join(kit, 'fonts'));
const { Canvas } = require(path.join(kit, 'canvas'));
const rec = require(path.join(kit, 'record'));
const OP_GLYPHS = rec.OP.GLYPHS;

// --- the pieces cover the atlas: every drawn glyph in exactly one piece, the same pixels ---
const ko = fonts.get('label', 36, '한글');
assert.strictEqual(ko.family, 'korean');
assert(ko.atlasH > fonts.PIECE_H, 'the Korean atlas is the tall case (' + ko.atlasH + ')');
const seen = new Set();
let glyphs = 0;
for (const k of Object.keys(ko.glyphs)) {
    const g = ko.glyphs[k];
    if (!g[2] || !g[3]) continue;
    glyphs++;
    const p = fonts.piece(ko, Number(k));
    assert.notStrictEqual(p, ko, 'glyph ' + k + ' has a piece');
    assert(p.atlasH <= fonts.PIECE_H && p.atlasW === ko.atlasW);
    assert.strictEqual(p.alpha.length, p.atlasW * p.atlasH);
    assert(g[1] >= p.y0 && g[1] + g[3] <= p.y0 + p.atlasH, 'glyph ' + k + ' inside its piece');
    for (let y = 0; y < g[3]; y++) {
        const a = (g[1] + y) * ko.atlasW + g[0], b = (g[1] - p.y0 + y) * p.atlasW + g[0];
        assert(Buffer.compare(ko.alpha.subarray(a, a + g[2]), p.alpha.subarray(b, b + g[2])) === 0);
    }
    seen.add(p);
}
assert(seen.size >= Math.ceil(ko.atlasH / fonts.PIECE_H));
const ids = [...seen].map((p) => rec.atlasId(p, 'korean')).concat(rec.atlasId(ko, 'korean'));
assert.strictEqual(new Set(ids).size, ids.length, 'every piece has its own GPU atlas id');
const short = fonts.get('num', 64, '1234');
assert.strictEqual(fonts.piece(short, 49), short, 'short atlases stay whole');

// --- recorded text: one GLYPHS op per piece run; the same picture as the software path ---
const sample = '엔진 오일 Oil 교환 1234 km 서비스 정보';
const r = new rec.Recorder(900, 80);
r.text(sample, 10, 50, 32, [255, 255, 255, 255], { literal: true });
r.text('ABC 123', 10, 75, 20, [255, 255, 255, 255], { literal: true });
const w = r.words();
const ops = [];
for (let i = 0; i < w.length;) {
    assert.strictEqual(w[i], OP_GLYPHS, 'only text was recorded');
    const f = rec.atlasById(w[i + 1]);
    assert(f && f.atlasH <= Math.max(fonts.PIECE_H, 1024), 'every recorded atlas is short');
    ops.push(f);
    i += 4 + w[i + 3] * 8;
}
assert(ops.filter((f) => f.family === 'korean').length >= 2, 'the Korean sample uses several pieces');
assert(new Set(r.atlases).size === r.atlases.size && [...r.atlases].every((id) => rec.atlasById(id)));
// the same picture as the same text recorded from the whole atlas (as before the pieces)
const piece = fonts.piece;
fonts.piece = (f) => f;
const whole = new rec.Recorder(900, 80);
whole.text(sample, 10, 50, 32, [255, 255, 255, 255], { literal: true });
whole.text('ABC 123', 10, 75, 20, [255, 255, 255, 255], { literal: true });
fonts.piece = piece;
const gpu = new Canvas(900, 80), before = new Canvas(900, 80);
rec.play(w, gpu);
rec.play(whole.words(), before);
assert(Buffer.compare(Buffer.from(gpu.d), Buffer.from(before.d)) === 0, 'pieces draw exactly what the whole atlas drew');
assert(gpu.d.some((v) => v), 'the text is drawn');

// every pair of Hangul glyphs from different pieces draws as from the whole atlas, in either order
const one = [...new Map([...seen].map((p) => [p, Object.keys(ko.glyphs).find((k) => fonts.piece(ko, +k) === p)])).values()]
    .map((k) => String.fromCodePoint(+k));
for (const a of one) for (const b of one) {
    const draw = (whole) => {
        const keep = fonts.piece; if (whole) fonts.piece = (f) => f;
        const x = new rec.Recorder(120, 60); x.text(a + b, 4, 44, 32, [255, 255, 255, 255], { literal: true });
        fonts.piece = keep;
        const cv = new Canvas(120, 60); rec.play(x.words(), cv); return Buffer.from(cv.d);
    };
    assert(Buffer.compare(draw(false), draw(true)) === 0, a + b + ' draws as from the whole atlas');
}

// ids are stable (shared between apps by the renderer) and differ from the whole atlas
const again = [...r.atlases].sort().join();
const r2 = new rec.Recorder(900, 80);
r2.text(sample, 10, 50, 32, [255, 255, 255, 255], { literal: true });
r2.text('ABC 123', 10, 75, 20, [255, 255, 255, 255], { literal: true });
assert.strictEqual([...r2.atlases].sort().join(), again);
assert(![...r.atlases].includes(rec.atlasId(ko, 'korean')));

// --- the renderer's shared texture (src/gfx.c gfx_atlas): two 1024 x 4096 columns, first come ---
function texture() {
    const shelf = [0, 0], have = new Map();
    return (id, h) => {
        if (have.has(id)) return true;
        const col = shelf[0] <= shelf[1] ? 0 : 1;
        if (shelf[col] + h > 4096 || have.size >= 128) return false;
        shelf[col] += h + 1; have.set(id, h);
        return true;
    };
}
// what HUD / cluster / number apps upload before a Korean app opens: 1400 rows of each column
const busy = () => { const up = texture(); for (let i = 0; i < 4; i++) assert(up(1000 + i, 699)); return up; };
let up = busy();
assert.strictEqual(up(1, ko.atlasH), false, 'the whole Korean atlas does not fit (the blank Hangul)');
up = busy();
for (const f of ops) assert(up(rec.atlasId(f, f.family), f.atlasH), 'piece of ' + f.atlasH + ' rows fits');
up = busy();
for (const p of seen) assert(up(rec.atlasId(p, 'korean'), p.atlasH), 'all of Hangul fits in pieces');

console.log('PASS: Korean atlas in ' + seen.size + ' GPU pieces of <= ' + fonts.PIECE_H + ' rows (' + glyphs +
    ' glyphs, same pixels); recorded text draws as from the whole atlas; pieces fit where the whole atlas did not');
