'use strict';
// 汉化署名：抖音 小白科技杂物社 / BiliBili 小白151 / GitHub JackieZ123430
// https://github.com/JackieZ123430/idrive7-apps-cn
const CREDIT = '抖音：小白科技杂物社 · BiliBili：小白151 · GitHub：JackieZ123430';
const { getLanguage } = require('./i18n');
function drawCredit(canvas, x, baseline) {
    if (getLanguage() !== 'zh-CN') return;
    canvas.text(CREDIT, x, baseline, 12, '#ffffff40', { align: 'right', font: 'label' });
}
module.exports = { CREDIT, drawCredit };
