'use strict';
/**
 * ui.js - the Live Adjustments / Exhaust Flap screen, a PURE draw(cv, G, t, v) so it
 * renders both on the car (main.js) and in the PC preview harness.
 *
 * House style of the other apps: an "Exhaust Flap" title with the M→white underline up
 * top, the twin tailpipes seen end-on with the butterfly valves opening/closing in the
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

    // --- valve figure: twin tailpipes seen end-on, butterfly opening/closing ---
    drawExhaust(cv, G, t, W / 2 - 310, G.TOP + 18, 620, 250, v);

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
 * One tailpipe tip seen end-on: a chromed round bezel with a dark bore and the butterfly
 * valve inside. open 0 = shut (plate covers the bore), 1 = open (plate edge-on, bore
 * reveals). Built from concentric discs for a metallic look.
 */
function drawTip(cv, G, t, cx, cy, r, open, accent) {
    const wa = G.withAlpha;
    cv.circle(cx, cy + 4, r + 6, wa('#000000', 0.32));      // soft drop shadow
    cv.circle(cx, cy, r + 2, '#0b0e12');                     // outer edge
    cv.circle(cx, cy, r, '#9aa1ac');                         // chrome base
    cv.circle(cx, cy, r * 0.93, '#565d68');                  // shade ring
    cv.circle(cx, cy, r * 0.87, '#cdd2da');                  // bright lip
    cv.circle(cx, cy, r * 0.79, '#272c34');                  // groove
    cv.circle(cx, cy, r * 0.71, '#9ea5af');                  // inner lip
    const rb = r * 0.65;
    cv.circle(cx, cy, rb, '#0a0c10');                        // dark bore
    cv.circle(cx, cy - rb * 0.1, rb * 0.9, '#050608');       // bore depth
    if (open > 0.4) {                                        // flow glow when open
        const g = (open - 0.4) / 0.6;
        cv.circle(cx, cy, rb * 0.72, wa(accent, 0.13 * g));
        cv.circle(cx, cy, rb * 0.4, wa(accent, 0.20 * g));
    }
    // butterfly plate: a vertical pill whose width shrinks as it opens
    const ws = Math.max(0.10, Math.cos(open * Math.PI / 2 * 0.95));
    const pw = 2 * rb * ws;
    cv.roundRect(cx - pw / 2, cy - rb, pw, 2 * rb, Math.min(pw / 2, rb), '#c7cdd5');
    if (pw > 12) cv.roundRect(cx - pw * 0.28, cy - rb * 0.92, pw * 0.3, rb * 1.84, Math.min(pw * 0.15, rb), wa('#ffffff', 0.28));
    cv.line(cx, cy - rb, cx, cy + rb, 2, wa('#20242b', 0.8));
    cv.circle(cx, cy, 5.5, '#1a1e24'); cv.circle(cx, cy, 2.5, '#434a53');   // hub
    cv.circle(cx - r * 0.4, cy - r * 0.48, r * 0.1, wa('#ffffff', 0.5));    // specular dot
}

/** Twin tailpipes seen end-on, with the butterfly valves opening/closing. */
function drawExhaust(cv, G, t, x, y, w, h, v) {
    const a = (v.angle == null ? (v.confirmed === 'OPEN' ? 1 : v.confirmed === 'UNKNOWN' ? 0.5 : 0) : v.angle);
    const accent = (v.confirmed === 'OPEN' || v.requested === 'OPEN') ? (t.accent2 || '#81c4ff') : (t.crit || '#ef2b2d');
    const cx = x + w * 0.5, cy = y + h * 0.5;
    const r = Math.min(h * 0.40, w * 0.19);
    const ox = r * 0.8, oy = r * 0.32;        // diagonal offset between the twin tips
    drawTip(cv, G, t, cx - ox, cy + oy, r, a, accent);   // left/lower
    drawTip(cv, G, t, cx + ox, cy - oy, r, a, accent);   // right/upper
}

module.exports = { draw, W, H, PAGES };
