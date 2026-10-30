'use strict';
/**
 * ui.js - the Live Adjustments screen, a PURE draw(cv, G, t, v) so it renders both on the
 * car (main.js) and in the PC preview harness. v.pages = the tabs this car gets, v.page =
 * the one shown: 'Exhaust Flap' always; 'Engine Map', 'Max Cooling', 'Burbles' only on a
 * tuned DME (tune.js). The tune is never named on screen.
 *
 * House style of the other apps: an "Exhaust Flap" title with the M→white underline up
 * top, the twin tailpipes seen end-on with the butterfly valves opening/closing in the
 * middle, the big state word, and the three mode buttons (OEM / Open / Close) across the
 * bottom — the selected one filled red, like the other apps (drawn with G.button; the
 * HMI bar is hidden in main.js). A fifth arg `act` carries the press callbacks.
 *
 * GPU-safe: only circle / arc / roundRect / strokeRoundRect / line / text / gradientRect
 * (the car's Recorder has no cv.convex / N-point polygon fill).
 */

const W = 1600, H = 520;

function draw(cv, G, t, v, act) {
    cv.clear(t.bg);

    // --- page tabs in the house style, one per adjustment. On the car G.frame pushes the
    // tabs up into the HMI's title strip; in preview it's a slim tab bar. ---
    const pages = v.pages || ['Exhaust Flap'];
    const page = pages.indexOf(v.page) >= 0 ? v.page : pages[0];
    G.frame(cv, t, pages, pages.indexOf(page), [v.simulated ? { text: 'SIM', color: t.warn || '#d29922' } : null]);

    // --- the house content panel (grey card) over the whole content area, EXACTLY like
    // the other apps (e.g. car_vitals). A panel that reaches the page bottom extends down
    // by cv.extra to fill the screen's bottom, so there is no dark band under it — that's
    // the "faixa" the other apps hide and we weren't drawing. ---
    G.panel(cv, t, 24, G.TOP, W - 48, G.BOTTOM - G.TOP, null);
    // the panel's real bottom: the word and buttons sit on it, the figure grows into the room above them;
    // the buttons (where the kit runs the screen) end G.MARGIN over it, as the other apps' last lines
    const bottom = G.pageBottom(cv) - (cv.own ? G.MARGIN : 0);

    if (page === 'Engine Map') return drawMap(cv, G, t, v.tune || {}, act || {}, bottom);
    if (page === 'Max Cooling') return drawCooling(cv, G, t, v.tune || {}, act || {}, bottom);
    if (page === 'Burbles') return drawBurbles(cv, G, t, v.tune || {}, act || {}, bottom);

    // --- valve figure: twin tailpipes seen end-on, butterfly opening/closing ---
    drawExhaust(cv, G, t, W / 2 - 310, G.TOP + 18, 620, 250 + bottom - G.BOTTOM, v);

    // --- state word (big), centered below the figure (no DME/version clutter) ---
    const word = v.confirmed !== 'UNKNOWN' ? v.confirmed : v.requested;
    const col = word === 'OPEN' ? (t.accent2 || '#81c4ff') : word === 'CLOSED' ? (t.crit || '#ef2b2d') : t.text;
    cv.text(word, W / 2, bottom - 96, 48, col, { align: 'center', font: 'bold', spacing: 2 });

    // only a genuine safety block speaks up; a timeout / no-answer (car asleep) shows
    // NOTHING, and no "sending…" clutter either.
    if (v.error) {
        cv.text('! ' + v.error, W / 2, bottom - 64, 14, t.crit, { align: 'center', font: 'label' });
    }

    // --- the three mode buttons on the canvas, the selected one red — like the other
    // apps (G.button draws when the app owns the screen; the HMI bar is hidden). ---
    drawButtons(cv, G, t, v, act, bottom);
    return cv;
}

/** OPEN · CLOSE · OEM across the bottom; the selected (requested) mode is filled red. */
function drawButtons(cv, G, t, v, act, bottom) {
    act = act || {};
    const modes = [
        { k: 'OPEN', label: 'Open', run: act.open },
        { k: 'CLOSED', label: 'Close', run: act.close },
        { k: 'OEM', label: 'OEM', run: act.oem },
    ];
    const bw = 236, bh = 56, gap = 30, by = bottom - 56;
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

/* ------------------------------------------------------- tune pages (tune.js) -- */

const RED = (t) => t.crit || '#ef2b2d';

/** The status line just above the buttons: what the DME said, or why nothing was sent. */
function noteLine(cv, G, t, m, bottom) {
    if (!m.note) return;
    const c = m.noteType === 'warn' ? (t.warn || '#d29922') : m.noteType === 'go' ? (t.go || '#2fd27a') : t.dim;
    cv.text(m.note, W / 2, bottom - 80, 18, c, { align: 'center', font: 'label' });
}

/** A row of equal buttons centred across the page bottom; spec = [label, run, selected]. */
function buttonRow(cv, G, t, specs, bottom, bw, busy, keyPrefix) {
    const bh = 56, gap = 26, by = bottom - 56;
    let bx = (W - (specs.length * bw + (specs.length - 1) * gap)) / 2;
    specs.forEach(([label, run, on], i) => {
        const opts = { key: keyPrefix + i, busy: !!busy };
        if (on) Object.assign(opts, { color: RED(t), primary: true });
        G.button(cv, t, bx, by, bw, bh, label, run || (() => {}), opts);
        bx += bw + gap;
    });
}

/** Engine Map: the active map big, four slot bars, MAP 1-4 (one press switches). */
function drawMap(cv, G, t, m, act, bottom) {
    const cy = G.TOP + (bottom - G.TOP - 96) / 2 - 20;
    cv.text(m.map ? 'MAP ' + m.map : 'MAP –', W / 2, cy + 30, 112, m.map ? t.text : t.dim,
        { align: 'center', font: 'bold', spacing: 4 });
    cv.text(m.map ? (m.mapConfirmed ? 'Active map · read from the DME' : 'Selected map · accepted by the DME')
        : 'Pick a map', W / 2, cy + 74, 18, t.dim, { align: 'center', font: 'label', spacing: 1 });
    const pw = 120, pg = 18, px0 = (W - (4 * pw + 3 * pg)) / 2;
    for (let i = 0; i < 4; i++) {
        cv.roundRect(px0 + i * (pw + pg), cy + 96, pw, 8, 4, m.map === i + 1 ? RED(t) : G.withAlpha('#ffffff', 0.12));
    }
    // seen on the owner's MG1 (MHD): the DME flashes the engine light while it changes maps
    if (m.features && m.features.map && !m.readback) {
        cv.text('The engine light may flash while the map changes — that is normal', W / 2, cy + 134, 16,
            t.dim, { align: 'center', font: 'label' });
    }
    noteLine(cv, G, t, m, bottom);
    buttonRow(cv, G, t, [1, 2, 3, 4].map((n) => ['Map ' + n, act.map && act.map(n), m.map === n]),
        bottom, 200, m.busy, 'la_map');
    return cv;
}

/** Max Cooling: a fan that lights up when on, ON / OFF. */
function drawCooling(cv, G, t, m, act, bottom) {
    const on = m.cooling === 'ON';
    const ice = t.accent2 || '#81c4ff';
    const r = Math.min(104, (bottom - G.TOP - 200) / 2);
    drawFan(cv, G, t, W / 2, G.TOP + 24 + r + 10, r, on ? ice : G.withAlpha('#ffffff', 0.35));
    cv.text(m.cooling || 'OFF', W / 2, bottom - 112, 48, on ? ice : t.text, { align: 'center', font: 'bold', spacing: 2 });
    noteLine(cv, G, t, m, bottom);
    buttonRow(cv, G, t, [['On', act.cooling && act.cooling(true), on],
        ['Off', act.cooling && act.cooling(false), m.cooling === 'OFF']], bottom, 236, m.busy, 'la_cool');
    return cv;
}

/** Burbles: the DME's state and the picked aggression; -/+ pick, Apply sends, Off disables. */
function drawBurbles(cv, G, t, m, act, bottom) {
    const cy = G.TOP + (bottom - G.TOP - 96) / 2 - 20;
    const agg = typeof m.targetAgg === 'number' ? m.targetAgg : 0;
    cv.text(agg.toFixed(1), W / 2, cy + 30, 112, t.text, { align: 'center', font: 'bold', spacing: 4 });
    cv.text('Aggression 0.0 – 12.0', W / 2, cy + 74, 18, t.dim, { align: 'center', font: 'label', spacing: 1 });
    const state = m.burbles === null || m.burbles === undefined ? 'unknown'
        : m.burbles === 'off' ? 'off' : m.burbles === 'custom' ? 'custom value' : m.burbles;
    cv.text('Now on the DME: ' + state, W / 2, cy + 104, 18, t.dim, { align: 'center', font: 'label' });
    noteLine(cv, G, t, m, bottom);
    buttonRow(cv, G, t, [['–', act.aggDown, false], ['+', act.aggUp, false],
        ['Apply', act.burblesApply, false], ['Off', act.burblesOff, m.burbles === 'off']],
        bottom, 200, m.busy, 'la_burb');
    return cv;
}

/** A radiator fan seen face-on: shroud ring, six swept blades, hub (circles + lines only). */
function drawFan(cv, G, t, cx, cy, r, col) {
    cv.circle(cx, cy, r + 10, G.withAlpha('#ffffff', 0.10));
    cv.circle(cx, cy, r + 4, t.bg);
    cv.circle(cx, cy, r, G.withAlpha(col, 0.08));
    for (let i = 0; i < 6; i++) {
        const a = i * Math.PI / 3 + 0.3, a2 = a + 0.35;
        const mx = cx + Math.cos(a) * r * 0.55, my = cy + Math.sin(a) * r * 0.55;
        cv.line(cx + Math.cos(a) * r * 0.2, cy + Math.sin(a) * r * 0.2, mx, my, 16, col);
        cv.line(mx, my, cx + Math.cos(a2) * r * 0.88, cy + Math.sin(a2) * r * 0.88, 12, col);
    }
    cv.circle(cx, cy, r * 0.2, '#1a1e24');
    cv.circle(cx, cy, r * 0.1, col);
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

module.exports = { draw, W, H };
