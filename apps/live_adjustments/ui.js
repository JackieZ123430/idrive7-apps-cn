'use strict';
/**
 * ui.js - the Engine Menu screens, a PURE draw(cv, G, t, v) so it
 * renders both on the car (main.js) and in the PC preview harness.
 *
 * House style of the other apps: an "Exhaust Flap" title with the M→white underline up
 * top, the twin tailpipes side by side seen end-on with the butterfly valves opening/closing in the
 * middle, the big state word, and the three mode buttons (OEM / Open / Close) across the
 * bottom — the selected one filled red, like the other apps (drawn with G.button; the
 * HMI bar is hidden in main.js). A fifth arg `act` carries the press callbacks.
 *
 * Pages (tabs): Exhaust Flap, Map (map slot 1..4, MHD or BM3), Max cooling (on/off, MHD), Burbles
 * (aggression 0..12, BM3) and Sound (Active Sound Design on/off, BM3). The tune pages work only on
 * a DME with that flash; they say what the read-only unlock check found.
 *
 * GPU-safe: only circle / arc / roundRect / strokeRoundRect / line / text / gradientRect
 * (the car's Recorder has no cv.convex / N-point polygon fill).
 */

const W = 1600, H = 520;
const PAGES = ['Exhaust Flap', 'Map', 'Max cooling', 'Burbles', 'Sound'];

function draw(cv, G, t, v, act) {
    cv.clear(t.bg);
    const page = v.page || 0;

    // --- page tabs in the house style. On the car G.frame pushes the tabs up into the HMI's
    // title strip; in preview it's a slim tab bar. ---
    G.frame(cv, t, PAGES, page, [v.source === 'sim' ? { text: 'SIM', color: t.warn || '#d29922' } : null]);
    if (page === 1) return drawMap(cv, G, t, v, act || {});
    if (page === 2) return drawCooling(cv, G, t, v, act || {});
    if (page === 3) return drawBurbles(cv, G, t, v, act || {});
    if (page === 4) return drawAsd(cv, G, t, v, act || {});

    // --- the house content panel (grey card) over the whole content area, EXACTLY like
    // the other apps (e.g. car_vitals). A panel that reaches the page bottom extends down
    // by cv.extra to fill the screen's bottom, so there is no dark band under it — that's
    // the "faixa" the other apps hide and we weren't drawing. ---
    G.panel(cv, t, 24, G.TOP, W - 48, G.BOTTOM - G.TOP, null);

    // --- valve figure: twin tailpipes side by side seen end-on, butterfly opening/closing ---
    drawExhaust(cv, G, t, W / 2 - 360, G.TOP + 18, 720, 250, v);

    // --- state word (big), centered below the figure (no DME/version clutter) ---
    const word = v.confirmed !== 'UNKNOWN' ? v.confirmed : v.requested;
    const col = word === 'OPEN' ? (t.accent2 || '#81c4ff') : word === 'CLOSED' ? (t.crit || '#ef2b2d') : t.text;
    cv.text(word, W / 2, G.BOTTOM - 96, 48, col, { align: 'center', font: 'bold', spacing: 2 });

    // only a genuine safety block speaks up; a timeout / no-answer (car asleep) shows
    // NOTHING, and no "sending…" clutter either.
    if (v.error) {
        cv.text('! ' + v.error, W / 2, G.BOTTOM - 64, 14, t.crit, { align: 'center', font: 'label' });
    }

    // --- the three mode buttons on the canvas, the selected one red — like the other
    // apps (G.button draws when the app owns the screen; the HMI bar is hidden). ---
    drawButtons(cv, G, t, v, act);
    return cv;
}

/**
 * Whether the page's controls reach the DME. need: 'map' (MHD, or a BM3 ROM with a known layout),
 * 'cooling' (MHD), 'burbles' (a BM3 ROM with a known layout), 'asd' (Bootmod3). The Platform
 * setting stands in for the unlock check, except where BM3 needs the ROM's memory layout.
 */
function unlocked(v, need) {
    const mhd = !!(v.mhd && v.mhd.flashed) || v.platform === 'mhd', rom = !!(v.bm3 && v.bm3.flashed);
    const bm3 = rom || v.platform === 'bm3';
    return need === 'map' ? mhd || rom : need === 'cooling' ? mhd : need === 'burbles' ? rom : bm3;
}

const NEEDS = { map: 'an MHD flash or an identified BM3 ROM', cooling: 'an MHD flash', burbles: 'an identified BM3 ROM', asd: 'Bootmod3' };

/** What the unlock check found, and whether presses reach the car. */
function unlockLine(v, need) {
    const m = v.mhd, b = v.bm3;
    let found;
    if (!m && !b) found = v.platform === 'mhd' ? 'Platform: MHD' : v.platform === 'bm3' ? 'Platform: Bootmod3' : 'Unlock check: not read (no diagnostic link)';
    else if (m && m.flashed) found = 'MHD flash detected' + (m.tag ? ' (' + m.tag + ')' : '');
    else if (b && b.flashed) found = 'BM3 ROM ' + b.rom + ' detected';
    else if (v.platform === 'mhd') found = 'Platform: MHD (no MHD tag found: ' + (m.reason || 'no answer') + ')';
    else if (v.platform === 'bm3') found = 'Platform: Bootmod3 (ROM not identified: ' + (b.reason || 'no answer') + ')';
    else found = 'No MHD or BM3 flash on this DME (' + ((b && b.reason) || (m && m.reason) || 'no answer') + ')';
    if (!unlocked(v, need)) found += ': needs ' + NEEDS[v.platform === 'bm3' && need === 'map' ? 'burbles' : need];
    return found + (v.source === 'sim' ? '  ·  Disarmed: simulated, nothing is sent' : '');
}

/** A tune page: the panel, the big state word, the unlock line and whether the DME took it. */
function tunePage(cv, G, t, v, word, color, accepted, need) {
    G.panel(cv, t, 24, G.TOP, W - 48, G.BOTTOM - G.TOP, null);
    cv.text(word, W / 2, G.TOP + 150, 80, color, { align: 'center', font: 'bold', spacing: 2 });
    cv.text(unlockLine(v, need), W / 2, G.TOP + 210, 20, unlocked(v, need) ? t.text : (t.warn || '#d29922'), { align: 'center', font: 'label' });
    const err = v.tune && v.tune.error;
    const note = err ? '! ' + err : accepted === 'read' ? 'Read from the DME' : accepted === true ? (v.source === 'sim' ? 'Simulated' : 'DME took it') : accepted === false ? 'Not taken' : '';
    if (note) cv.text(note, W / 2, G.TOP + 246, 18, err || accepted === false ? (t.crit || '#ef2b2d') : t.dim, { align: 'center', font: 'label' });
}

/** Map: the tune's map slot 1..4; a press asks for a second press to confirm. */
function drawMap(cv, G, t, v, act) {
    const tune = v.tune || {};
    const map = tune.mapAccepted === false ? null : tune.map;          // a refused one is not shown as set
    tunePage(cv, G, t, v, map ? 'MAP ' + map : 'MAP –', t.text, tune.mapAccepted, 'map');
    const bw = 236, bh = 56, gap = 30, by = G.BOTTOM - 56;
    let bx = (W - (4 * bw + 3 * gap)) / 2;
    for (let n = 1; n <= 4; n++) {
        const on = map === n;
        G.button(cv, t, bx, by, bw, bh, 'Map ' + n, () => act.map && act.map(n),
            Object.assign({ key: 'la_map' + n, confirm: !on }, on ? { color: t.crit || '#ef2b2d', primary: true } : {}));
        bx += bw + gap;
    }
    return cv;
}

/** Max cooling: on / off. */
function drawCooling(cv, G, t, v, act) {
    const tune = v.tune || {};
    const cooling = tune.coolingAccepted === false ? null : tune.cooling;
    const word = cooling == null ? 'MAX COOLING –' : cooling ? 'MAX COOLING ON' : 'MAX COOLING OFF';
    tunePage(cv, G, t, v, word, cooling ? (t.accent2 || '#81c4ff') : t.text, tune.coolingAccepted, 'cooling');
    const bw = 236, bh = 56, gap = 30, by = G.BOTTOM - 56;
    let bx = (W - (2 * bw + gap)) / 2;
    [[true, 'On'], [false, 'Off']].forEach(([on, label]) => {
        const sel = cooling === on;
        G.button(cv, t, bx, by, bw, bh, label, () => act.cooling && act.cooling(on),
            Object.assign({ key: 'la_cool' + label }, sel ? { color: t.crit || '#ef2b2d', primary: true } : {}));
        bx += bw + gap;
    });
    return cv;
}

/** Burbles: the aggression picked with - / + (v.burble, nothing sent), Apply sends it, Off turns them off. */
function drawBurbles(cv, G, t, v, act) {
    const tune = v.tune || {};
    const set = tune.burblesAccepted === false ? undefined : tune.burbles;      // undefined = not known
    const pick = v.burble == null ? 4 : v.burble;
    tunePage(cv, G, t, v, 'AGGRESSION ' + pick, t.text, tune.burblesAccepted, 'burbles');
    const now = set === undefined ? 'Set: –' : set === null ? 'Set: off' : 'Set: ' + set;
    cv.text(now, W / 2, G.TOP + 290, 26, t.dim, { align: 'center', font: 'bold' });
    const bw = 236, bh = 56, gap = 30, by = G.BOTTOM - 56;
    let bx = (W - (4 * bw + 3 * gap)) / 2;
    [['–', () => act.burbleStep && act.burbleStep(-0.5), {}],
        ['+', () => act.burbleStep && act.burbleStep(0.5), {}],
        ['Apply', () => act.burbles && act.burbles(pick), Object.assign({ confirm: true }, set === pick ? { color: t.crit || '#ef2b2d', primary: true } : {})],
        ['Off', () => act.burbles && act.burbles(null), Object.assign({ confirm: set !== null }, set === null ? { color: t.crit || '#ef2b2d', primary: true } : {})],
    ].forEach(([label, run, opts], i) => {
        G.button(cv, t, bx, by, bw, bh, label, run, Object.assign({ key: 'la_burble' + i }, opts));
        bx += bw + gap;
    });
    return cv;
}

/** Sound: Active Sound Design on / off. */
function drawAsd(cv, G, t, v, act) {
    const tune = v.tune || {};
    const asd = tune.asdAccepted === false ? null : tune.asd;
    const word = asd == null ? 'SOUND DESIGN –' : asd ? 'SOUND DESIGN ON' : 'SOUND DESIGN OFF';
    tunePage(cv, G, t, v, word, t.text, tune.asdAccepted, 'asd');
    const bw = 236, bh = 56, gap = 30, by = G.BOTTOM - 56;
    let bx = (W - (2 * bw + gap)) / 2;
    [[true, 'On'], [false, 'Off']].forEach(([on, label]) => {
        const sel = asd === on;
        G.button(cv, t, bx, by, bw, bh, label, () => act.asd && act.asd(on),
            Object.assign({ key: 'la_asd' + label }, sel ? { color: t.crit || '#ef2b2d', primary: true } : {}));
        bx += bw + gap;
    });
    return cv;
}

/** OPEN · CLOSE · OEM across the bottom; the selected (requested) mode is filled red. */
function drawButtons(cv, G, t, v, act) {
    act = act || {};
    const modes = [
        { k: 'OPEN', label: 'Open', run: act.open },
        { k: 'CLOSED', label: 'Close', run: act.close },
        { k: 'OEM', label: 'OEM', run: act.oem },
    ];
    const bw = 236, bh = 56, gap = 30, by = G.BOTTOM - 56;
    let bx = (W - (modes.length * bw + (modes.length - 1) * gap)) / 2;
    for (const m of modes) {
        const on = m.k === v.requested;
        const opts = on
            ? { color: t.crit || '#ef2b2d', primary: true, key: 'la_' + m.k }   // selected = red
            : { key: 'la_' + m.k };                                             // others = outline
        G.button(cv, t, bx, by, bw, bh, m.label, m.run || (() => {}), opts);
        bx += bw + gap;
    }
}

/**
 * One tailpipe tip seen end-on: a rolled chrome rim (lit from the top left), the inner pipe with
 * depth, and the butterfly valve inside it. open 0 = shut (the plate fills the pipe), 1 = open
 * (the plate edge-on).
 */
function drawTip(cv, G, t, cx, cy, r, open, accent) {
    const wa = G.withAlpha;
    cv.circle(cx, cy, r * 1.13, '#040506');                                   // cut-out in the valance
    cv.arc(cx, cy, r * 1.13, r * 1.16, 230, 490, wa('#ffffff', 0.10));       // its lit edge
    cv.circle(cx, cy + r * 0.06, r * 1.02, wa('#000000', 0.55));              // shadow under the tip
    // chrome rim: colour by angle, bright top left, dark bottom right
    cv.arc(cx, cy, r * 0.78, r, 0, 360, null, { ramp: ['#c9ced5', '#8b939d', '#4a5059', '#2f343b', '#3d434b', '#7d858f', '#e9edf1', '#fbfcfd', '#c9ced5'] });
    cv.arc(cx, cy, r * 0.97, r, 0, 360, wa('#000000', 0.35));                 // outer edge
    cv.arc(cx, cy, r * 0.86, r * 0.92, 285, 355, wa('#ffffff', 0.55), { round: true });   // specular on the roll
    cv.arc(cx, cy, r * 0.86, r * 0.9, 105, 165, wa('#ffffff', 0.12), { round: true });    // bounce light
    cv.arc(cx, cy, r * 0.76, r * 0.8, 0, 360, '#15181c');                     // lip into the pipe
    // the pipe going in: darker toward the back
    const rb = r * 0.74;
    cv.circle(cx, cy, rb, '#0e1013');
    cv.arc(cx, cy, rb * 0.86, rb, 0, 360, null, { ramp: ['#23272d', '#16191d', '#0b0d10', '#16191d', '#23272d'] });
    cv.circle(cx, cy, rb * 0.62, '#07080a');
    if (open > 0.4) {                                                         // light through the open valve
        const g = (open - 0.4) / 0.6;
        cv.circle(cx, cy, rb * 0.62, wa(accent, 0.10 * g));
        cv.circle(cx, cy, rb * 0.34, wa(accent, 0.18 * g));
    }
    // butterfly plate on a vertical shaft: narrower as it opens
    const pr = rb * 0.84, ws = Math.max(0.08, Math.cos(open * Math.PI / 2 * 0.95));
    const pw = 2 * pr * ws;
    cv.roundRect(cx - pw / 2, cy - pr, pw, 2 * pr, Math.min(pw / 2, pr), '#4f565f');
    if (pw > 14) cv.roundRect(cx - pw / 2 + pw * 0.08, cy - pr * 0.94, pw * 0.34, pr * 1.88, Math.min(pw * 0.17, pr), wa('#ffffff', 0.16));
    cv.line(cx, cy - rb, cx, cy + rb, 3, '#1c2026');                          // shaft
    cv.circle(cx, cy, 6, '#2a2f36'); cv.circle(cx, cy, 2.5, '#6a727c');       // hub
}

/** The rear valance with twin tips side by side (oo), the valves opening and closing. */
function drawExhaust(cv, G, t, x, y, w, h, v) {
    const wa = G.withAlpha;
    const a = (v.angle == null ? (v.confirmed === 'OPEN' ? 1 : v.confirmed === 'UNKNOWN' ? 0.5 : 0) : v.angle);
    const accent = (v.confirmed === 'OPEN' || v.requested === 'OPEN') ? (t.accent2 || '#81c4ff') : (t.crit || '#ef2b2d');
    const cx = x + w / 2, cy = y + h / 2;
    const r = Math.min(h * 0.38, w * 0.14);
    // valance: dark body colour, lit along its top edge
    cv.card(x, y + h * 0.1, w, h * 0.8, 36, [[0, '#2b3038'], [0.35, '#181b20'], [1, '#0b0d10']]);
    cv.strokeRoundRect(x, y + h * 0.1, w, h * 0.8, 36, 2, wa('#ffffff', 0.08));
    cv.line(x + 40, y + h * 0.1 + 10, x + w - 40, y + h * 0.1 + 10, 2, wa('#ffffff', 0.06));
    for (const side of [-1, 1]) drawTip(cv, G, t, cx + side * r * 1.32, cy, r, a, accent);
}

module.exports = { draw, W, H, PAGES };
