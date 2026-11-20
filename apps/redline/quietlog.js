'use strict';
/**
 * Part of Redline's experimental features; README.md in this folder has the whole picture.
 *
 * Keeps redline.log small: the same kind of line (its text with the numbers taken out) is written at most once
 * every REPEAT_MS; the next one after that says how many were held back ("(+12 like it)"). Errors always go
 * through. The file itself is the kit's: 256 KiB, then renamed to redline.log.1 over the older one (two files at
 * most). Debug lines are not written to the file at all.
 */
const REPEAT_MS = 10 * 60 * 1000, MAX_KINDS = 400;

const mono = () => { const t = process.hrtime(); return t[0] * 1000 + t[1] / 1e6; };
const textOf = (a) => a.map((x) => (x && x.stack ? x.stack : typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');

/** log: { error, warn, info, debug }; returns the same shape, quieter. now: the clock (for the tests). */
function wrap(log, now) {
    if (!log || log.quiet) return log;
    const clock = now || mono;
    let kinds = {}, n = 0;
    const quiet = (lvl) => function () {
        const a = Array.prototype.slice.call(arguments);
        try {
            const key = lvl + ' ' + textOf(a).replace(/[-+]?\d[\d.:,]*/g, '#').slice(0, 300);
            const t = clock(), k = kinds[key];
            if (k && t - k.t < REPEAT_MS) { k.held++; return; }
            if (!k && ++n > MAX_KINDS) { kinds = {}; n = 1; }
            const held = k && k.held ? '(+' + k.held + ' like it)' : '';
            kinds[key] = { t: t, held: 0 };
            return log[lvl].apply(log, held ? a.concat([held]) : a);
        } catch (e) { try { return log[lvl].apply(log, a); } catch (e2) { /* never */ } }
    };
    return { error: log.error.bind(log), warn: quiet('warn'), info: quiet('info'), debug: log.debug ? log.debug.bind(log) : () => {}, quiet: true };
}

module.exports = { wrap, REPEAT_MS };
