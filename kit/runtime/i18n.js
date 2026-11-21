'use strict';
// Local display translation only. Never use this on signal names, IDs or stored settings.
const locale = require('./locale.json');
const dict = locale.strings || {};
const language = locale.language || 'en';
const localizedValues = new Set(Object.values(dict));
const cache = new Map();
function getLanguage() { return language; }
// Plural forms live in the locale catalogs: "fault|faults<TAB>ошибка|ошибки|ошибок".
// The key is the English text for 1 and for many, exactly as English shows it (both the same
// when English does not change, e.g. "items|items"). Without a row the English form is returned
// and the drawn line goes through t() as before, so catalogs without plural rows (zh-CN) render unchanged.
// The rule picks the form index; Node 8 on the car has no Intl.PluralRules.
const PLURAL_RULES = {
    en: (n) => (n === 1 ? 0 : 1),
    ru: (n) => { // one | few | many
        const mod100 = Math.abs(n) % 100, mod10 = mod100 % 10;
        if (mod100 >= 11 && mod100 <= 14) return 2;
        if (mod10 === 1) return 0;
        return mod10 >= 2 && mod10 <= 4 ? 1 : 2;
    },
    'zh-CN': () => 0,
    'zh-TW': () => 0,
    ko: () => 0,
    es: (n) => (n === 1 ? 0 : 1),
};
function plural(n, one, other, lang) {
    const key = one + '|' + other, lng = lang || language;
    const translated = lng !== 'en' && Object.prototype.hasOwnProperty.call(dict, key) && (!lang || lang === language);
    if (!translated) return n === 1 ? one : other;
    const forms = dict[key].split('|'), rule = PLURAL_RULES[lng] || PLURAL_RULES.en;
    return forms[Math.min(rule(n), forms.length - 1)];
}
const folded = Object.create(null);
Object.keys(dict).forEach((key) => { folded[key.toLowerCase()] = dict[key]; });
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phrases = Object.keys(dict).filter((s) => s.length >= 4 && s.indexOf('|') < 0).sort((a, b) => b.length - a.length);
// Spanish: a text found only through a key of another case takes the case the English draws it in:
// "HARDEST STOP" by "Hardest stop" stays uppercase, "Dial" by "dial" starts with a capital, "shifts" in
// a sentence by "Shifts" starts small (unless the translation starts with an acronym such as HUD).
// Other catalogs keep their own case.
function caseLike(word, text) {
    if (language !== 'es' || !text) return text;
    if (/[A-Z]/.test(word) && word === word.toUpperCase()) return text.toUpperCase();
    if (/^[A-Z]/.test(word)) return text.charAt(0).toUpperCase() + text.slice(1);
    if (/^[a-z]/.test(word) && /^.\p{Ll}/u.test(text)) return text.charAt(0).toLowerCase() + text.slice(1);
    return text;
}
const pattern = new RegExp('(^|[^A-Za-z0-9_./])(' + phrases.map(escape).join('|') + ')(?=$|[^A-Za-z0-9_./])', 'gi');
function t(value) {
    const s = String(value == null ? '' : value);
    if (language === 'en') return s;
    if (!/[A-Za-z]/.test(s)) return s; // numeric telemetry / already translated labels: hot path
    if (s.trim() === 'rpm') return s; // preserve the physical unit; uppercase RPM headings may translate
    if (cache.has(s)) return cache.get(s);
    const key = s.trim();
    if (localizedValues.has(key)) return s;
    let out;
    if (Object.prototype.hasOwnProperty.call(dict, key)) {
        out = s.slice(0, s.indexOf(key)) + dict[key] + s.slice(s.indexOf(key) + key.length);
    } else if (Object.prototype.hasOwnProperty.call(folded, key.toLowerCase())) {
        out = s.slice(0, s.indexOf(key)) + caseLike(key, folded[key.toLowerCase()]) + s.slice(s.indexOf(key) + key.length);
    } else {
        // Short words need context: "min 70" is a minimum, "12 min" is minutes.
        // Keep numeric battery capacity values/units while removing the English "of".
        out = language === 'ko' ? s.replace(/(\d+(?:\.\d+)?)\s+of\s+(\d+(?:\.\d+)?)\s+Ah\b/gi, '$1 / $2 Ah') :
            (language === 'zh-CN' || language === 'zh-TW') ? s.replace(/\bmin(?=\s+-?\d)/g, '最小').replace(/\bmax(?=\s+-?\d)/g, '最大')
            .replace(/\bAVG(?=\s+[+-]?\d)/g, '平均').replace(/\bACC\b/g, '加速') :
            language === 'ru' ? s.replace(/\bmin(?=\s+-?\d)/g, 'мин.').replace(/\bmax(?=\s+-?\d)/g, 'макс.')
                .replace(/\bAVG(?=\s+[+-]?\d)/g, 'СРЕД.').replace(/\bACC\b/g, 'РАЗГОН') :
            language === 'es' ? s.replace(/\bmin(?=\s+-?\d)/g, 'mín.').replace(/\bmax(?=\s+-?\d)/g, 'máx.')
                .replace(/\bAVG(?=\s+[+-]?\d)/g, 'MED.').replace(/\bACC\b/g, 'ACEL.')
                // "2 of 3" -> "2 de 3"; "5 min ago" (or a number before a translated "min atrás") -> "hace 5 min"
                .replace(/(\d) of (?=[~\d])/g, '$1 de ')
                .replace(/(\d+) ?(s|m|min|h|days|días) (?:ago|atrás)\b/g, (_, n, u) => 'hace ' + n + ' ' + ({ m: 'min', days: 'días' }[u] || u)) : s;
        out = out.replace(pattern, (_, before, word) => before + (dict[word] || caseLike(word, folded[word.toLowerCase()])));
    }
    if (cache.size >= 2048) cache.clear();
    cache.set(s, out);
    return out;
}
module.exports = { t, plural, PLURAL_RULES, dict, getLanguage };
