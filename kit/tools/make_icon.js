'use strict';
/**
 * make_icon.js <glyph> <out.png> - 140x140 app tile icon in the HMI's style
 * (white line art on transparent, one accent element). Glyphs: gauge, flag,
 * engine, battery, service, doom, ..., or any 1-3 characters (drawn as text).
 */
const fs = require('fs');
const path = require('path');
const { Canvas } = require(path.join(__dirname, '..', 'runtime', 'canvas'));

const W = '#ffffff', A = '#e1001a', B = '#2a8cff';
const glyph = process.argv[2] || 'gauge';
const out = process.argv[3] || 'icon.png';
const c = new Canvas(140, 140);
const rad = (d) => d * Math.PI / 180;
const pt = (cx, cy, r, a) => [cx + Math.sin(rad(a)) * r, cy - Math.cos(rad(a)) * r];

if (glyph === 'gauge') {
    c.arc(70, 76, 46, 54, -135, 135, W, { round: true });
    c.arc(70, 76, 46, 54, 75, 135, A, { round: true });
    for (let a = -135; a <= 135; a += 45) { const [x0, y0] = pt(70, 76, 34, a), [x1, y1] = pt(70, 76, 40, a); c.line(x0, y0, x1, y1, 4, W); }
    const [nx, ny] = pt(70, 76, 40, 40);
    c.line(70, 76, nx, ny, 6, W);
    c.circle(70, 76, 9, W);
    c.fillRect(44, 112, 52, 6, W);
} else if (glyph === 'flag') {
    // stopwatch + launch flag
    c.arc(62, 78, 38, 46, 0, 360, W);
    c.fillRect(54, 22, 16, 8, W);
    c.line(62, 30, 62, 34, 6, W);
    const [nx, ny] = pt(62, 78, 30, 50);
    c.line(62, 78, nx, ny, 6, A);
    c.circle(62, 78, 6, W);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) if ((i + j) % 2 === 0) c.fillRect(100 + i * 8, 22 + j * 8, 8, 8, W);
    c.line(100, 22, 100, 64, 4, W);
} else if (glyph === 'engine') {
    // engine block + check mark accent
    c.strokeRoundRect(22, 44, 84, 54, 6, 6, W);
    c.fillRect(40, 30, 40, 6, W); c.fillRect(56, 34, 8, 12, W);
    c.fillRect(8, 60, 16, 6, W); c.fillRect(8, 56, 6, 22, W);
    c.fillRect(104, 58, 14, 6, W); c.fillRect(114, 52, 6, 30, W);
    c.circle(104, 102, 20, A);
    c.text('!', 104, 112, 32, W, { font: 'bold', align: 'center' });
} else if (glyph === 'rpm') {
    // tach with shift lights
    c.arc(70, 84, 44, 52, -110, 110, W, { round: true });
    c.arc(70, 84, 44, 52, 60, 110, A, { round: true });
    const [nx, ny] = pt(70, 84, 42, 70);
    c.line(70, 84, nx, ny, 6, W);
    c.circle(70, 84, 8, W);
    for (let i = 0; i < 5; i++) c.roundRect(26 + i * 18, 14, 14, 10, 3, i < 2 ? '#2fd27a' : i < 4 ? '#ffc21a' : A);
    c.text('3', 70, 126, 30, W, { font: 'bold', align: 'center' });
} else if (glyph === 'dyno') {
    // dyno sheet: axes + power curve + torque curve
    c.line(18, 18, 18, 118, 5, W); c.line(18, 118, 124, 118, 5, W);
    const pw = [], tq = [];
    for (let x = 0; x <= 100; x += 4) {
        pw.push([22 + x, 112 - 86 * Math.sin(Math.min(1, x / 100) * Math.PI * 0.62)]);
        tq.push([22 + x, 112 - 70 + 30 * Math.pow(x / 100 - 0.45, 2) * 2]);
    }
    c.polyline(tq, 5, W);
    c.polyline(pw, 6, A);
} else if (glyph === 'brake') {
    // brake disc + caliper
    c.arc(64, 72, 40, 50, 0, 360, W);
    c.circle(64, 72, 16, W);
    for (let a = 0; a < 360; a += 45) { const [x, y] = pt(64, 72, 30, a); c.circle(x, y, 3, W); }
    c.arc(64, 72, 52, 66, 20, 80, A, { round: true });
    c.text('100-0', 70, 134, 20, W, { font: 'bold', align: 'center' });
} else if (glyph === 'temp') {
    // thermometer + oil drop
    c.strokeRoundRect(42, 14, 22, 78, 11, 5, W);
    c.circle(53, 100, 20, W);
    c.circle(53, 100, 12, A);
    c.fillRect(49, 50, 8, 50, A);
    for (let i = 0; i < 4; i++) c.fillRect(70, 24 + i * 16, 12, 4, W);
    c.circle(104, 92, 16, W);
    c.line(104, 58, 92, 84, 5, W); c.line(104, 58, 116, 84, 5, W);
} else if (glyph === 'gforce') {
    // friction circle with dot
    c.arc(70, 70, 50, 56, 0, 360, W);
    c.arc(70, 70, 26, 30, 0, 360, W);
    c.line(14, 70, 126, 70, 3, W); c.line(70, 14, 70, 126, 3, W);
    c.circle(98, 54, 12, A);
    c.circle(98, 54, 5, W);
} else if (glyph === 'battery') {
    // HV battery with charge segments + lightning bolt
    c.strokeRoundRect(10, 40, 108, 60, 10, 6, W);
    c.roundRect(118, 58, 12, 24, 3, W);
    for (let i = 0; i < 3; i++) c.roundRect(22 + i * 22, 52, 16, 36, 3, i < 2 ? '#2fd27a' : W);
    c.polyline([[96, 46], [84, 72], [100, 72], [88, 96]], 6, A);
} else if (glyph === 'wrench') {
    // wrench (service) + oil drop
    c.line(36, 104, 86, 54, 14, W);
    c.arc(96, 44, 14, 26, 70, 340, W);                // open jaw: a ring with a gap at the top right
    c.circle(30, 110, 10, W);
    c.circle(38, 50, 16, A);
    c.line(38, 18, 26, 42, 5, A); c.line(38, 18, 50, 42, 5, A);
} else if (glyph === 'doom') {
    // horned demon skull, red eyes
    c.convex([[30, 52], [14, 14], [46, 38]], W);            // horns
    c.convex([[110, 52], [126, 14], [94, 38]], W);
    c.circle(70, 64, 40, W);                                 // cranium
    c.roundRect(44, 86, 52, 34, 10, W);                      // jaw
    c.convex([[44, 56], [66, 64], [62, 78], [46, 74]], A);   // eyes
    c.convex([[96, 56], [74, 64], [78, 78], [94, 74]], A);
    c.convex([[70, 82], [64, 94], [76, 94]], '#000000');     // nose
    for (let i = 0; i < 4; i++) c.fillRect(52 + i * 11, 104, 3, 16, '#000000');   // teeth
} else {
    c.strokeRoundRect(14, 14, 112, 112, 22, 6, W);
    c.text(glyph, 70, 88, 56, W, { font: 'bold', align: 'center' });
    c.fillRect(40, 104, 60, 6, A);
}
fs.writeFileSync(out, c.png(9));
