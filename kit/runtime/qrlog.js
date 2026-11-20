'use strict';
/**
 * qrlog.js - Settings > QR log: the app's recent log as QR codes on screen, for a phone photo. Someone without
 * SSH can send the photos with an issue; kit/tools/qrlog_decode.py turns them back into the log.
 *
 * A code: a text line "MGULOG2 d<dictionary> <app> <version> <page>/<pages>" and a newline, then that page's lines
 * compressed (raw deflate with a preset dictionary of the apps' log words, qrlog-dict-<n>.txt). In a page a line's
 * time is "+<seconds> " after the line before (the first keeps hh:mm:ss). Each page compressed on its own: any photo
 * reads without the others. A phone's QR reader shows the first line, then gibberish.
 *
 *   pages(text, size, head)  the log cut into codes' worth of whole lines, the newest on page 1: [Buffer]
 *   logText(file)            the log made short: times without the date, stack lines left out, a VIN masked
 *   qrLogSheet(opts)         the sheet (sheet.js): { file, app, version } -> a page with the code, page and size buttons
 *
 * Sizes: the same version for every page of one size, so the code stays the same size while paging.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const qr = require('./qr');
const { pill, TOP } = require('./sheet');

const SIZES = {
    // (on the car's 1920 x 720 screen: about 6, 5 and 3 screen pixels a module; version 23 is left out, a common
    // reader library reads it wrong)
    large: { version: 15, label: 'Large' },           // 77 modules: easiest to scan, least text per code
    medium: { version: 20, label: 'Medium' },         // 97
    small: { version: 30, label: 'Small' },           // 137: the most text, needs a steady photo
};
const ORDER = ['large', 'medium', 'small'];
// the compression dictionary (kit/tools/qrlog_dict.js); a published one never changes, a new one gets the next number
const DICT = 1;
let dict = null;
function dictionary() {
    if (dict === null) { try { dict = fs.readFileSync(path.join(__dirname, 'qrlog-dict-' + DICT + '.txt')); } catch (e) { dict = false; } }
    return dict || null;
}
const MAX_PAGES = 8, LINE_MAX = 300, SDK_MAX = 160, TAIL_BYTES = 128 * 1024;

/** The log made short for the codes: the last TAIL_BYTES, times as hh:mm:ss, stack and noise lines left out. */
function logText(file) {
    let raw = '';
    try {
        const fd = fs.openSync(file, 'r'), st = fs.fstatSync(fd), n = Math.min(st.size, TAIL_BYTES), buf = Buffer.alloc(n);
        fs.readSync(fd, buf, 0, n, st.size - n);
        fs.closeSync(fd);
        raw = buf.toString('utf8');
        if (n < st.size) raw = raw.slice(raw.indexOf('\n') + 1);          // a whole first line
    } catch (e) { return ''; }
    let day = '', last = null;
    const out = [];
    raw.split('\n').forEach((l) => {
        const m = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d:\d\d)\.\d+Z (\w+) (.*)$/.exec(l);
        if (!m) return;                                    // stack lines and wrapped SDK dumps
        if (/^(loop MAIN|display: \d)/.test(m[4])) return; // frame-rate lines
        // BMW's SDK: its errors only, cut short (they run to whole stack dumps); its warnings and info left out
        if (/^SDK_/.test(m[3]) && m[3] !== 'SDK_ERROR') return;
        const msg = m[4].slice(0, m[3] === 'SDK_ERROR' ? SDK_MAX : LINE_MAX);
        if (msg === last) return;                          // the same line again
        last = msg;
        if (m[1] !== day) { day = m[1]; out.push('-- ' + day + ' (UTC)'); }
        const lvl = m[3] === 'INFO' ? '' : m[3] + ' ';
        out.push(m[2] + ' ' + lvl + msg);
    });
    // a VIN (17 characters, no I O Q) is not needed to read a log
    return out.join('\n').replace(/\b[A-HJ-NPR-Z0-9]{17}\b/g, '<VIN>');
}

/** A page's lines with each time after the first as "+<seconds>" since the line before (a step back: the time again). */
function relTimes(lines) {
    let last = null;
    return lines.map((l) => {
        const m = /^(\d\d):(\d\d):(\d\d) (.*)$/.exec(l);
        if (!m) return l;
        const t = +m[1] * 3600 + +m[2] * 60 + +m[3], out = last === null || t < last ? l : '+' + (t - last) + ' ' + m[4];
        last = t;
        return out;
    });
}
const pack = (lines) => {
    const d = dictionary(), o = d ? { level: 9, dictionary: d } : { level: 9 };
    return zlib.deflateRawSync(Buffer.from(relTimes(lines).join('\n'), 'utf8'), o);
};
// (no dictionary file: "d0", plain deflate, still read by the decoder)
const magic = () => 'MGULOG2 d' + (dictionary() ? DICT : 0);

/**
 * The log cut into pages, each the most whole lines whose compressed size fits the size's code, from the newest back:
 * page 1 has the newest lines (oldest first within a page), and the oldest are left out when they don't all fit in
 * MAX_PAGES. -> [Buffer] (header line + deflate)
 */
function pages(text, size, head) {
    const cap = qr.capacity(SIZES[size].version, 'L');
    const top = (n, of) => magic() + ' ' + String(head || 'app').replace(/\s+/g, ' ').trim() + ' ' + n + '/' + of + '\n';
    const room = cap - Buffer.byteLength(top(MAX_PAGES, MAX_PAGES));
    const lines = String(text || '').split('\n').filter((l) => l.length);
    // each page starts with its day (the "-- date" line before its first line), so every page reads alone
    const days = [];
    lines.forEach((l, i) => { days[i] = /^-- /.test(l) ? null : (i && (/^-- /.test(lines[i - 1]) ? lines[i - 1] : days[i - 1])) || null; });
    const part = (a, b) => (days[a] ? [days[a]] : []).concat(lines.slice(a, b));
    const rev = [];
    let end = lines.length;
    while (end > 0 && rev.length < MAX_PAGES) {
        // the most lines ending at `end` that fit (binary search: compressed size grows with the lines)
        let lo = 1, hi = end;
        if (pack(part(end - 1, end)).length > room) { end--; continue; }   // one line too long alone: left out
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (pack(part(end - mid, end)).length <= room) lo = mid; else hi = mid - 1;
        }
        rev.push(pack(part(end - lo, end)));
        end -= lo;
    }
    if (!rev.length) rev.push(pack(['(the log is empty)']));
    const list = rev;
    return list.map((z, i) => Buffer.concat([Buffer.from(top(i + 1, list.length), 'utf8'), z]));
}

/** The settings' QR log sheet. opts: { file (the app's log), app (its id), version, settings (for the size) } */
function qrLogSheet(opts) {
    const o = opts || {};
    const st = { size: 'medium', page: 0, list: null, codes: {} };      // Medium each time it opens
    const load = () => {
        st.list = pages(logText(o.file), st.size, (o.app || 'app') + ' ' + (o.version || ''));
        st.page = Math.min(st.page, st.list.length - 1);
        st.codes = {};
    };
    // the buttons, in the controller's order: turning moves along them, pressing uses one (Next first)
    const BUTTONS = [
        { id: 'prev', label: () => 'Previous', run: () => { turn(-1); return null; } },
        { id: 'next', label: () => 'Next', run: () => { turn(1); return null; } },
        { id: 'size', label: () => 'Size: ' + SIZES[st.size].label, run: () => { nextSize(); return null; } },
        { id: 'refresh', label: () => 'Refresh', run: () => { load(); return null; } },
        { id: 'back', label: () => 'Back', run: () => 'close' },
    ];
    st.focus = 1;
    const code = (i) => st.codes[i] || (st.codes[i] = qr.encode(st.list[i], { version: SIZES[st.size].version, ecl: 'L' }));
    const setSize = (s) => {
        st.size = s; st.page = 0; load();
    };
    const nextSize = () => setSize(ORDER[(ORDER.indexOf(st.size) + 1) % ORDER.length]);
    const turn = (d) => { st.page = Math.max(0, Math.min(st.list.length - 1, st.page + d)); };
    load();
    return {
        title: 'QR log',
        draw(r, t) {
            r.clear(t.bg);
            const targets = [], bottom = 512 + (r.extra || 0) - 6;
            // the code: as big as the page allows, black on white with its quiet zone (4 modules). Each module a whole
            // number of screen pixels (sc: screen pixels a page pixel), so no seams between the rows to trip a reader.
            const q = code(st.page), box = bottom - (TOP + 4), sc = r.textScale || 1, n = q.size + 8;
            const dev = Math.max(1, Math.floor(box * sc / n)), side = dev * n / sc;
            const ox = Math.round((40 + (box - side) / 2) * sc), oy = Math.round((TOP + 4 + (box - side) / 2) * sc);
            const at = (o, k) => (o + k * dev) / sc;       // module edge k (with the quiet zone) in page pixels
            const x0 = 40;
            r.fillRect(at(ox, 0), at(oy, 0), side, side, '#ffffff');
            for (let y = 0; y < q.size; y++) {
                for (let x = 0; x < q.size;) {
                    if (!q.get(x, y)) { x++; continue; }
                    let e = x;
                    while (e < q.size && q.get(e, y)) e++;
                    r.fillRect(at(ox, x + 4), at(oy, y + 4), (e - x) * dev / sc, dev / sc, '#000000');
                    x = e;
                }
            }
            // the text and the buttons on the right
            const tx = x0 + box + 50, tw = 1600 - 40 - tx;
            r.text('QR log', tx, TOP + 46, 34, t.text, { font: 'bold' });
            r.text('Page ' + (st.page + 1) + ' of ' + st.list.length, tx, TOP + 92, 26, t.text);
            const help = ['Take a photo of every page and add', 'the photos to your issue on GitHub.', 'The newest lines are on page 1.'];
            // (a phone's QR reader shows gibberish after the first line: the log is compressed, we decode the photos)
            help.forEach((h, i) => r.text(h, tx, TOP + 138 + i * 32, 22, t.dim));
            // the buttons: the controller's one lit (Next until the controller moves it)
            const by = TOP + 250, bw = Math.floor((tw - 16) / 2), sy = by + 68, ky = sy + 68;
            const place = { prev: [tx, by, bw], next: [tx + bw + 16, by, bw], size: [tx, sy, bw], refresh: [tx + bw + 16, sy, bw], back: [tx, ky, tw] };
            BUTTONS.forEach((b, i) => {
                const [x, y, w] = place[b.id];
                pill(r, t, x, y, w, 50, b.label(), i === st.focus);
                targets.push({ x: x, y: y - 6, w: w, h: 62, act: () => { st.focus = i; return b.run(); } });
            });
            r.text(st.size === 'small' ? 'Small: more text per code, hold the phone steady.' : st.size === 'large' ? 'Large: easiest to scan, more pages.' : 'Too hard to scan? Try Size: Large.',
                tx, Math.min(bottom - 8, ky + 92), 20, t.dim);
            return targets;
        },
        // the controller: turning (or pushing up / down) moves along the buttons, pressing uses the lit one, left goes
        // back; pushed up from the first button: the header's tabs
        move(d) { st.focus = Math.max(0, Math.min(BUTTONS.length - 1, st.focus + (d > 0 ? 1 : -1))); },
        press() { return BUTTONS[st.focus].run(); },
        back() { return 'close'; },
        top() { return st.focus === 0; },
    };
}

module.exports = { qrLogSheet, pages, logText, SIZES };
