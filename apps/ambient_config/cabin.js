'use strict';
/**
 * cabin.js - the car from above with its ambient lights glowing in the colours they show (or will show).
 *
 *   drawCabin(cv, t, box, lights, colourOf, opts)
 *     box       { x, y, w, h }: the car fills its height, centred
 *     lights    [{ part, x, y, x2, y2, fault }] (lin.js), x 0..1 across from the driver's side, y 0..1 from the dash
 *     colourOf  (light) -> { rgb, bright } | null (null: the car's own colour, drawn dim grey)
 *     opts.rhd  the driver on the right (the picture mirrored)
 */
const { withAlpha } = require('./kit/canvas');

const BODY = '#2a2f37', GLASS = '#11151b', SEAT = '#3a404a', TRIM = '#4a515c';

function glow(cv, rgb, bright, a) { const f = 0.25 + 0.75 * Math.max(0, Math.min(100, bright)) / 100; return [rgb[0], rgb[1], rgb[2], Math.round(255 * a * f)]; }

function drawCabin(cv, t, box, lights, colourOf, opts) {
    const o = opts || {};
    const H = box.h, W = Math.round(H * 0.5);
    const x0 = box.x + Math.round((box.w - W) / 2), y0 = box.y;
    const X = (fx) => x0 + (o.rhd ? 1 - fx : fx) * W, Y = (fy) => y0 + fy * H;

    // the body: a rounded shell with the bonnet and boot cut off (an interior plan), windscreen and rear window
    cv.roundRect(x0 - 6, y0 - 6, W + 12, H + 12, W * 0.28, withAlpha('#000000', 0.35));
    cv.roundRect(x0, y0, W, H, W * 0.26, BODY);
    cv.roundRect(x0 + W * 0.04, y0 + H * 0.03, W * 0.92, H * 0.94, W * 0.22, GLASS);
    cv.roundRect(x0 + W * 0.10, y0 + H * 0.03, W * 0.80, H * 0.07, 10, withAlpha('#9fb4c8', 0.10));     // windscreen
    cv.roundRect(x0 + W * 0.14, y0 + H * 0.90, W * 0.72, H * 0.06, 10, withAlpha('#9fb4c8', 0.08));     // rear window
    // the dash, the console, the seats
    cv.roundRect(x0 + W * 0.08, Y(0.11), W * 0.84, H * 0.08, 12, TRIM);
    cv.roundRect(x0 + W * 0.42, Y(0.21), W * 0.16, H * 0.33, 10, TRIM);
    [[0.17, 0.25], [0.59, 0.25]].forEach(([fx, fy]) => {
        cv.roundRect(x0 + fx * W, Y(fy), W * 0.24, H * 0.20, 14, SEAT);
        cv.roundRect(x0 + fx * W + 4, Y(fy + 0.19), W * 0.24 - 8, H * 0.05, 10, withAlpha(SEAT, 0.9));
    });
    cv.roundRect(x0 + W * 0.15, Y(0.58), W * 0.70, H * 0.22, 18, SEAT);
    cv.roundRect(x0 + W * 0.17, Y(0.79), W * 0.66, H * 0.05, 12, withAlpha(SEAT, 0.9));
    // the steering wheel on the driver's side
    const sx = X(0.29), sy = Y(0.21);
    cv.arc(sx, sy, W * 0.07, W * 0.07 + 5, 0, 360, '#555c66');

    // the lights: lines as glowing strokes, the rest as small glowing pills
    lights.forEach((l) => {
        const c = colourOf(l);
        const rgb = c ? c.rgb : [90, 96, 104], br = c ? c.bright : 30;
        if (c && br <= 0) return;
        if (l.x2 != null) {
            const xa = X(l.x), ya = Y(l.y), xb = X(l.x2), yb = Y(l.y2);
            if (c) [[44, 0.10], [28, 0.20], [15, 0.42]].forEach(([w, a]) => cv.line(xa, ya, xb, yb, w, glow(cv, rgb, br, a)));
            cv.line(xa, ya, xb, yb, 6, glow(cv, rgb, br, c ? 1 : 0.6));
            if (c) cv.line(xa, ya, xb, yb, 2, glow(cv, rgb.map((v) => Math.round(v + (255 - v) * 0.6)), br, 0.9));
        } else {
            const px = X(l.x), py = Y(l.y);
            if (c) [[56, 34, 0.12], [42, 24, 0.24], [32, 15, 0.45]].forEach(([w, h, a]) => cv.roundRect(px - w / 2, py - h / 2, w, h, h / 2, glow(cv, rgb, br, a)));
            cv.roundRect(px - 13, py - 4, 26, 8, 4, glow(cv, rgb, br, c ? 1 : 0.6));
        }
        if (l.fault) cv.roundRect(X(l.x) - 5, Y(l.y) - 5, 10, 10, 5, t.warn || '#ffb000');
    });
    return { x: x0, y: y0, w: W, h: H };
}

module.exports = { drawCabin };
