'use strict';
// Chinese localization: 抖音 小白科技杂物社 / BiliBili 小白151 / GitHub JackieZ123430.
const { t } = require('./i18n');

/** Translate complete sentences before measuring or truncating them. */
function fitText(canvas, value, size, width, options) {
    const text = t(String(value));
    if (canvas.textWidth(text, size, options) <= width) return text;
    const chars = Array.from(text);
    while (chars.length > 4 && canvas.textWidth(chars.join('') + '...', size, options) > width) chars.pop();
    return chars.join('').trim() + '...';
}
module.exports = { fitText };
