'use strict';
/**
 * pages.js - Live Data's lists (Signals, Engine, a unit's values) in the style of the other apps' pages:
 * a panel with its title, the page's buttons after it and a note on the right, then rows of name and
 * value in groups. Where the kit runs the screen (cv.own) a list is one page that a finger or the knob
 * scrolls (cv.scroll, ctx.onScroll); elsewhere it is paged, ROWS rows a page.
 *
 *   listPanel(cv, t, G, fit, o) -> true while the list still glides to where it was scrolled
 *     o.title, o.note (right of the title; o.noteColor), o.progress (0..1, -1 moving, null none)
 *     o.buttons  [{ label, run, key, busy, color }] after the title (cv.own only: elsewhere the bar has them)
 *     o.rows     [{ header } | { name, source, text, dim, warn, run, key }]: the whole list where it
 *                scrolls, else this page's; source shows with o.details
 *     o.scroll   { y, max } where it scrolls (o.key names its glide), null where it is paged
 *     o.cursor   the row the knob is on (paged, browsing), else -1
 *     o.empty    the text when there are no rows
 */
const { withAlpha } = require('./kit/canvas');

const ROWS = 12, ROW_H = 33, TOP = 108;

function listPanel(cv, t, G, fit, o) {
    const p = G.panel(cv, t, 24, 52, 1552, 460, o.title);
    let bx = 42 + cv.textWidth(String(o.title), 26, { font: 'bold' }) + 28;
    (o.buttons || []).forEach((b) => { if (b) bx += G.button(cv, t, bx, 62, 0, 38, b.label, b.run, b) + 12; });
    if (o.progress !== null && o.progress !== undefined) {
        const w = 300, x = 1552 - w;
        cv.roundRect(x, 71, w, 8, 4, t.track);
        if (o.progress < 0) { const f = (Date.now() / 1200) % 1; cv.roundRect(x + f * (w - 80), 71, 80, 8, 4, t.accent); } else cv.roundRect(x, 71, Math.max(8, w * o.progress), 8, 4, t.accent);
        if (o.note) cv.text(fit(cv, o.note, 22, Math.max(200, x - 20 - bx)), x - 20, 88, 22, t.text, { align: 'right' });
    } else if (o.note) cv.text(fit(cv, o.note, 22, Math.max(200, 1552 - bx - 24)), 1552, 88, 22, o.noteColor || t.dim, { align: 'right' });
    const rows = o.rows || [];
    if (!rows.length) {
        cv.text(o.empty || 'Nothing to show', 800, Math.round((TOP + p.y + p.h) / 2) + 10, 28, t.dim, { align: 'center' });
        return false;
    }
    const bottom = p.y + p.h - 12, clipTop = TOP - 6;
    let sy = 0, gliding = false;
    if (o.scroll) {
        const s = o.scroll;
        s.max = Math.max(0, rows.length * ROW_H - 3 - (bottom - TOP));
        s.y = G.clamp(s.y, 0, s.max);
        sy = G.smooth('liveData:' + o.key, s.y, 22);
        gliding = sy !== s.y;
        cv.clip(p.x, clipTop, p.w, p.y + p.h - 4 - clipTop);
    }
    rows.forEach((row, i) => {
        const y = TOP + i * ROW_H - sy;
        if (y + ROW_H < clipTop || y > p.y + p.h) return;
        if (row.header) {
            cv.text(String(row.header).toUpperCase(), 74, y + 24, 18, t.sel || t.accent, { font: 'bold', spacing: 1.5 });
            cv.fillRect(74, y + ROW_H - 4, 1478, 1, withAlpha(t.sel || t.accent, 0.4));
            return;
        }
        if (i === o.cursor) cv.roundRect(40, y, 1520, ROW_H - 3, 5, withAlpha(t.sel || t.accent, 0.22));
        if (cv.own && row.run) cv.target(40, Math.max(y, clipTop), 1520, ROW_H - 3, row.run, row.key);
        const nameW = o.details && row.source ? 820 : 1060;
        cv.text(fit(cv, row.name, 22, nameW), 74, y + 23, 22, row.dimName ? t.dim : t.text);
        if (o.details && row.source) cv.text(fit(cv, row.source, 18, 300), 910, y + 22, 18, row.sourceWarn ? t.warn : t.dim);
        cv.text(fit(cv, row.text, 24, 400, { font: 'bold' }), 1544, y + 23, 24, row.warn ? t.warn : row.dim ? t.dim : t.text, { align: 'right', font: 'bold' });
        if (i < rows.length - 1 && !rows[i + 1].header) cv.fillRect(48, y + ROW_H - 2, 1504, 1, withAlpha(t.tick, 0.18));
    });
    if (o.scroll) {
        cv.noclip();
        const s = o.scroll;
        if (s.max) {
            // where the list is: a bar at the panel's right edge; the controller goes to the list after the title's buttons
            const vis = bottom - clipTop, bh = Math.max(40, vis * vis / (vis + s.max));
            const bar = { x: p.x + p.w - 11, y: clipTop + (vis - bh) * sy / s.max, w: 6, h: bh };
            cv.roundRect(bar.x, bar.y, bar.w, bar.h, 3, withAlpha(t.text, 0.3));
            cv.scroll = { y: clipTop, bar };
        }
    }
    return gliding;
}

module.exports = { listPanel, ROWS, ROW_H };
