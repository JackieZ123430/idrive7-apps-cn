'use strict';
// Never apply the instrument/UI word-replacement dictionary to diagnostic prose.
const path = require('path');
const { getLanguage, dict } = require('./kit/i18n');
const language = getLanguage();
const db = language === 'zh-CN' ? require('./kit/pack').open(path.join(__dirname, 'diagnostic_i18n')) : null;
function diagnosticText(value) {
    const source = String(value == null ? '' : value);
    const ambiguous = /^(\d+) possible texts \(depends on unit type\)$/.exec(source);
    if (ambiguous && language === 'zh-CN') return ambiguous[1] + ' 个候选说明（取决于单元型号）';
    return !db ? source : db.get(language + '.json', source) || dict[source] || source;
}
module.exports = { diagnosticText };
