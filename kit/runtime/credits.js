'use strict';
// The translation credit in the corner: translated packages with a credit only. Its text is in their
// locale.json (build.py, from kit/localization/credit.<language>.json); other packages carry none.
const locale = require('./locale.json');
const CREDIT = typeof locale.credit === 'string' ? locale.credit : '';
function drawCredit(canvas, x, baseline) {
    if (!CREDIT) return;
    canvas.text(CREDIT, x, baseline, 12, '#ffffff40', { align: 'right', font: 'label' });
}
module.exports = { CREDIT, drawCredit };
