'use strict';
// Simplified Chinese localization by 小白科技杂物社 / Bilibili 小白151 / GitHub JackieZ123430.
// https://github.com/JackieZ123430/idrive7-apps-cn — retain attribution when redistributing.
// Local display translation only. Never use this on signal names, IDs or stored settings.
const dict = require('./locales/zh-CN.json');
const cache = new Map();
const folded = Object.create(null);
Object.keys(dict).forEach((key) => { folded[key.toLowerCase()] = dict[key]; });
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phrases = Object.keys(dict).filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
const pattern = new RegExp('(^|[^A-Za-z0-9_./])(' + phrases.map(escape).join('|') + ')(?=$|[^A-Za-z0-9_./])', 'gi');
function t(value) {
    const s = String(value == null ? '' : value);
    if (!/[A-Za-z]/.test(s)) return s; // numeric telemetry / already translated labels: hot path
    if (s.trim() === 'rpm') return s; // preserve the physical unit; uppercase RPM headings may translate
    if (cache.has(s)) return cache.get(s);
    const key = s.trim();
    let out;
    if (Object.prototype.hasOwnProperty.call(dict, key)) {
        out = s.slice(0, s.indexOf(key)) + dict[key] + s.slice(s.indexOf(key) + key.length);
    } else if (Object.prototype.hasOwnProperty.call(folded, key.toLowerCase())) {
        out = s.slice(0, s.indexOf(key)) + folded[key.toLowerCase()] + s.slice(s.indexOf(key) + key.length);
    } else {
        // Short words need context: "min 70" is a minimum, "12 min" is minutes.
        out = s.replace(/\bmin(?=\s+-?\d)/g, '最小').replace(/\bmax(?=\s+-?\d)/g, '最大')
            .replace(/\bAVG(?=\s+[+-]?\d)/g, '平均').replace(/\bACC\b/g, '加速');
        out = out.replace(pattern, (_, before, word) => before + (dict[word] || folded[word.toLowerCase()]));
    }
    if (cache.size >= 2048) cache.clear();
    cache.set(s, out);
    return out;
}
module.exports = { t, dict };
