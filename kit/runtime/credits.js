'use strict';
// 汉化：小白科技杂物社 / Bilibili 小白151 / GitHub JackieZ123430
// https://github.com/JackieZ123430/idrive7-apps-cn
const CREDIT = '汉化：小白科技杂物社 · GitHub：JackieZ123430';
function drawCredit(canvas, x, baseline) {
    canvas.text(CREDIT, x, baseline, 12, '#ffffff40', { align: 'right', font: 'label' });
}
module.exports = { CREDIT, drawCredit };
