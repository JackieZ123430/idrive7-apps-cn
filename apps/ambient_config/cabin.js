'use strict';
/**
 * cabin.js - the key to the car's picture (carview.js draws the car):
 *
 *   legendMark(cv, part, x, y, rgb)   an upper light's line, a lower light's pill
 */

function glow(cv, rgb, bright, a) { const f = 0.25 + 0.75 * Math.max(0, Math.min(100, bright)) / 100; return [rgb[0], rgb[1], rgb[2], Math.round(255 * a * f)]; }

/** The key to the picture: an upper light's line or a lower light's dot, at x, y (its middle), in rgb. */
function legendMark(cv, part, x, y, rgb) {
    if (part === 'upper') {
        cv.line(x, y, x + 26, y, 10, glow(cv, rgb, 100, 0.3));
        cv.line(x, y, x + 26, y, 5, rgb);
    } else {
        cv.roundRect(x, y - 9, 26, 18, 9, glow(cv, rgb, 100, 0.3));
        cv.roundRect(x + 3, y - 4, 20, 8, 4, rgb);
    }
}

module.exports = { legendMark };
