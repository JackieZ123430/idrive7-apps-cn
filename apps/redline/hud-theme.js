'use strict';
/**
 * Part of Redline's experimental features; README.md in this folder has the whole picture.
 *
 * What the HUD drawing files share: the grade colours, the shift grade's timing and the label fitting.
 * Requires nothing, so any drawing file can require it.
 */

/** Each shift grade's palette colour. */
const GRADE = { 'SPOT ON': 'low', EARLY: 'mid', LATE: 'high', LIMITER: 'limit', 'COLD REV': 'cold', KNOCK: 'limit' };
/** A chip's colour: its own tone (the launch time), else its grade's. */
const chipCol = (chip, P) => P[chip.tone || GRADE[chip.verdict]] || P.text;
/** A tone's colour ('cold', 'hot'...): base for none or 'text'. */
const toneCol = (tone, P, base) => (tone && tone !== 'text' ? P[tone] || base : base);

/**
 * The grade's 1.5 s, in ms: the word pops in over pop, a ring grows from it over ring, and it fades
 * from hold to hold + fade.
 */
const BURST = { pop: 150, ring: 500, hold: 1200, fade: 300 };
/** The word's alpha at age a. */
const burstAlpha = (a) => (a > BURST.hold ? Math.max(0, Math.min(1, 1 - (a - BURST.hold) / BURST.fade)) : 1);
/** How far the ring has grown at age a (0..1), or -1 once it's gone. */
const burstRing = (a) => (a < BURST.ring ? a / BURST.ring : -1);

/** size made smaller (down to 8 px) when text would be wider than room. */
function fitSize(cv, text, size, room, opts) {
    if (!cv.textWidth) return size;
    const w = cv.textWidth(text, size, opts);
    return w > room ? Math.max(8, size * room / w) : size;
}

module.exports = { GRADE, chipCol, toneCol, BURST, burstAlpha, burstRing, fitSize };
