'use strict';
// 汉化署名：抖音 小白科技杂物社 / BiliBili 小白151 / GitHub JackieZ123430
// https://github.com/JackieZ123430/idrive7-apps-cn
const { getLanguage } = require('./i18n');
const CREDIT = (getLanguage() === 'zh-TW' ? '漢化' : '汉化') + '：抖音 小白科技杂物社 · BiliBili 小白151 · GitHub JackieZ123430';
function drawCredit(canvas, x, baseline) {
    if (!/^zh-(CN|TW)$/.test(getLanguage())) return;
    canvas.text(CREDIT, x, baseline, 12, '#ffffff40', { align: 'right', font: 'label' });
}
module.exports = { CREDIT, drawCredit };
