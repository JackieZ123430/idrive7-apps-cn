'use strict';
/**
 * ui.js - the Live Adjustments screen, a PURE draw(cv, G, t, v) so it renders both on the
 * car (main.js) and in the PC preview harness. v.pages = the tabs this car gets, v.page =
 * the one shown: 'Exhaust Flap' always; 'Engine Map', 'Max Cooling', 'Burbles', 'Active Sound'
 * for the tune picked in Settings (tune.js); 'xDrive' with the experimental setting (xdrive.js).
 *
 * House style of the other apps: an "Exhaust Flap" title with the M→white underline up
 * top, the rear silencer in the middle (one silencer, two tailpipes; the flap is in the RIGHT
 * one, as on the car, its butterfly turning in the bore; smoke out of the left tailpipe always
 * and out of the right one as far as the flap is open), the big state word, the status line
 * (auto.js: the driving mode, the Close rpm guard, hold) and the four buttons (Open / Close /
 * OEM / Drive mode) across the bottom — the selected one filled red, like the other apps (drawn
 * with G.button; the HMI bar is hidden in main.js). A fifth arg `act` carries the press callbacks.
 *
 * GPU-safe: the silencer is a cached layer (muffler_img.js), the rest circle / roundRect /
 * strokeRoundRect / line / convex quad / text.
 */

const IMG = require('./muffler_img');
const { Canvas } = require('./kit/canvas');
const { t: translate } = require('./kit/i18n');

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

    if (v.pin && (page === 'Engine Map' || page === 'Burbles')) return drawPin(cv, G, t, v.pin, act || {}, bottom);
    if (page === 'Engine Map') return drawMap(cv, G, t, v.tune || {}, act || {}, bottom);
    if (page === 'Max Cooling') return drawCooling(cv, G, t, v.tune || {}, act || {}, bottom);
    if (page === 'Burbles') return drawBurbles(cv, G, t, v.tune || {}, act || {}, bottom);
    if (page === 'Active Sound') return drawAsd(cv, G, t, v.tune || {}, act || {}, bottom);
    if (page === 'xDrive') return drawXDrive(cv, G, t, v.xdrive || {}, act || {}, bottom);
    if (page === 'xDrive live') return drawXDriveLive(cv, G, t, v.xlive || {}, v.xdrive || {}, bottom);

    // --- the rear silencer, the flap's butterfly in the right tailpipe ---
    drawMuffler(cv, G, t, 100, G.TOP + 12, W - 200, bottom - 142 - G.TOP, v);

    // --- state word (big), centered below the figure (no DME/version clutter) ---
    const word = v.confirmed !== 'UNKNOWN' ? v.confirmed : v.requested;
    const col = word === 'OPEN' ? (t.accent2 || '#81c4ff') : word === 'CLOSED' ? (t.crit || '#ef2b2d') : t.text;
    cv.text(word, W / 2, bottom - 96, 48, col, { align: 'center', font: 'bold', spacing: 2 });

    // only a genuine safety block speaks up; a timeout / no-answer (car asleep) shows
    // NOTHING, and no "sending…" clutter either.
    if (v.error) {
        cv.text('! ' + v.error, W / 2, bottom - 64, 14, t.crit, { align: 'center', font: 'label' });
    } else if (v.note) {
        // Drive mode's driving mode, the Close rpm pause or the no-rpm fail-safe, hold: one line under the word
        cv.text(noteText(v.note.text), W / 2, bottom - 64, 17, v.note.warn ? (t.warn || '#d29922') : t.dim,
            { align: 'center', font: 'label', literal: true });
    }

    // --- the four mode buttons on the canvas, the selected one red — like the other
    // apps (G.button draws when the app owns the screen; the HMI bar is hidden). ---
    drawButtons(cv, G, t, v, act, bottom);
    return cv;
}

/**
 * The status line, from the shared catalogues piece by piece ('Sport · holding'); the rpm guard's line as one
 * sentence with its rpm figure kept. Drawn literal: the pieces are already translated.
 */
const PAUSED = /^Close paused above (.+) rpm · the car has the flap$/;
function noteText(s) {
    const m = PAUSED.exec(s);
    if (m) return translate('Close paused above {rpm} rpm · the car has the flap').replace('{rpm}', m[1]);
    const whole = translate(s);
    return whole !== s ? whole : s.split(' · ').map((p) => translate(p)).join(' · ');
}

/** OPEN · CLOSE · OEM · DRIVE MODE across the bottom; the selected one (v.selected, else v.requested) filled red. */
function drawButtons(cv, G, t, v, act, bottom) {
    act = act || {};
    const modes = [
        { k: 'OPEN', label: 'Open', run: act.open },
        { k: 'CLOSED', label: 'Close', run: act.close },
        { k: 'OEM', label: 'OEM', run: act.oem },
        { k: 'DRIVE', label: 'Drive mode', run: act.drive },      // follow the driving mode (auto.js)
    ];
    const bw = 236, bh = 56, gap = 30, by = bottom - 56;
    let bx = (W - (modes.length * bw + (modes.length - 1) * gap)) / 2;
    for (const m of modes) {
        const on = m.k === (v.selected || v.requested);
        const busy = !!v.busy && m.k !== 'OEM';     // OEM stays pressable: it is queued, never dropped
        const opts = on
            ? { color: t.crit || '#ef2b2d', primary: true, key: 'la_' + m.k, busy }   // selected = red
            : { key: 'la_' + m.k, busy };                                             // others = outline
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

/**
 * Engine Map / Burbles behind the PIN (pin.js): what to do, a dot for each digit, the message, and the keypad
 * (1-5 over 6-0 and Delete) where the kit runs the screen; elsewhere only the words (the tabs' buttons
 * aren't there either).
 */
function drawPin(cv, G, t, p, act, bottom) {
    const rowH = 56, rowGap = 18, padTop = bottom - 2 * rowH - rowGap;
    const cy = G.TOP + (padTop - G.TOP) / 2 - 40;
    cv.text(p.title, W / 2, cy, 30, t.text, { align: 'center', font: 'bold', spacing: 1 });
    const r = 11, gap = 40, x0 = W / 2 - ((p.len - 1) * gap) / 2;
    for (let i = 0; i < p.len; i++) {
        if (i < p.digits) cv.circle(x0 + i * gap, cy + 46, r, t.text);
        else cv.strokeRoundRect(x0 + i * gap - r, cy + 46 - r, 2 * r, 2 * r, r, 2, G.withAlpha('#ffffff', 0.4));
    }
    if (p.msg) cv.text(p.msg, W / 2, cy + 96, 18, p.warn ? (t.warn || '#d29922') : t.dim, { align: 'center', font: 'label' });
    if (!cv.own) {
        cv.text('Enter the PIN on the touchscreen', W / 2, cy + 130, 16, t.dim, { align: 'center', font: 'label' });
        return cv;
    }
    const bw = 150, bg = 20, busy = p.wait > 0;
    const row = (keys, y) => {
        let bx = (W - (keys.length * bw + (keys.length - 1) * bg)) / 2;
        keys.forEach((k) => {
            const del = k === 'del';
            G.button(cv, t, bx, y, bw, rowH, del ? 'Delete' : String(k), del ? act.pinBack : act.pinDigit && act.pinDigit(k),
                { key: 'la_pin_' + k, busy: busy && !del });
            bx += bw + bg;
        });
    };
    row([1, 2, 3, 4, 5], padTop);
    row([6, 7, 8, 9, 0, 'del'], padTop + rowH + rowGap);
    return cv;
}

/** Max Cooling: a fan that lights up when on, ON / OFF. */
function drawCooling(cv, G, t, m, act, bottom) {
    const on = m.cooling === 'ON';
    const ice = t.accent2 || '#81c4ff';
    const r = Math.min(104, (bottom - G.TOP - 200) / 2);
    drawFan(cv, G, t, W / 2, G.TOP + 24 + r + 10, r, on ? ice : G.withAlpha('#ffffff', 0.35));
    cv.text(m.cooling || 'OFF', W / 2, bottom - 112, 48, on ? ice : t.text, { align: 'center', font: 'bold', spacing: 2 });
    // ON needs the engine running (tune.js MIN_COOLING_RPM); shown under the fan
    const rpmText = m.rpm == null ? 'Engine speed unknown' : m.rpm > (m.minCoolingRpm || 500)
        ? 'Engine running · ' + Math.round(m.rpm) + ' rpm' : 'Engine off · needs over ' + (m.minCoolingRpm || 500) + ' rpm';
    cv.text(rpmText, W / 2, bottom - 152, 16, t.dim, { align: 'center', font: 'label' });
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

/** Active Sound (ASD): the interior engine sound on / off; the DME does not report its state. */
function drawAsd(cv, G, t, m, act, bottom) {
    const cy = G.TOP + (bottom - G.TOP - 96) / 2 - 20;
    const word = m.asd === true ? 'ON' : m.asd === false ? 'OFF' : '–';
    cv.text(word, W / 2, cy + 30, 112, m.asd == null ? t.dim : t.text, { align: 'center', font: 'bold', spacing: 4 });
    cv.text('Active Sound Design · the last setting the DME accepted', W / 2, cy + 74, 18, t.dim,
        { align: 'center', font: 'label', spacing: 1 });
    noteLine(cv, G, t, m, bottom);
    buttonRow(cv, G, t, [['On', act.asd && act.asd(true), m.asd === true],
        ['Off', act.asd && act.asd(false), m.asd === false]], bottom, 236, m.busy, 'la_asd');
    return cv;
}

/** xDrive (experimental, xdrive.js): the mode the transfer case / DSC reports, the conditions it wants, the button(s). */
function drawXDrive(cv, G, t, x, act, bottom) {
    const cy = G.TOP + 30;
    const word = x.mode === 'AWD' ? 'AWD' : x.mode === 'RWD' ? 'RWD' : x.mode === 'REQUESTED' ? 'RWD REQUESTED' : '–';
    const col = x.mode === 'RWD' ? RED(t) : x.mode === 'AWD' ? t.text : x.mode === 'REQUESTED' ? (t.warn || '#d29922') : t.dim;
    cv.text(word, W / 2, cy + 64, x.mode === 'REQUESTED' ? 64 : 96, col, { align: 'center', font: 'bold', spacing: 4 });
    const from = x.modeFrom === 'lmv' ? 'read from the transfer case' : 'read from the DSC';
    const back = x.onAvailable ? 'xDrive on brings it back' : 'back after an ignition cycle';
    const sub = x.mode === 'AWD' ? 'xDrive active · ' + from
        : x.mode === 'RWD' ? 'xDrive off · ' + from + ' · ' + back
        : x.mode === 'REQUESTED' ? (x.path === 'vip' ? 'Accepted by the VIP · the front-axle torque shows the effect'
            : 'Start the engine without switching the ignition off')
        : x.supported === false ? 'This DSC does not offer LMV_FUNKTION'
        : x.path === 'vip' ? 'Sent through the VIP · the front-axle torque shows the effect'
        : 'The transfer case reports the mode once read';
    cv.text(sub, W / 2, cy + 100, 18, t.dim, { align: 'center', font: 'label', spacing: 1 });

    // the conditions the DSC wants: green = seen, red = not met, grey = the head unit cannot tell
    const checks = x.checks || [];
    const cw = 230, cx0 = (W - checks.length * cw) / 2, ry = cy + 150;
    checks.forEach((c, i) => {
        const dot = c.ok === true ? (t.go || '#2fd27a') : c.ok === false ? RED(t) : G.withAlpha('#ffffff', 0.35);
        const x0 = cx0 + i * cw + 20;
        cv.circle(x0 + 7, ry - 6, 7, dot);
        cv.text(c.label, x0 + 22, ry, 17, c.ok === false ? t.text : t.dim, { font: 'label' });
    });
    const dsc = (x.index ? (x.unit || 'DSC') + ' ' + x.index + (x.tested ? ' · tested variant' : ' · untested variant') : 'DSC variant unknown')
        + (x.path === 'vip' ? ' · via VIP ' + x.vipIndex : '');
    const lmv = x.lmvIndex ? ' · transfer case ' + (x.lmvName ? x.lmvName + ' (' + x.lmvIndex + ')' : x.lmvIndex) : '';
    cv.text('Experimental · ' + dsc + lmv + (x.onAvailable ? ' · xDrive on restores it, or an ignition cycle' : ' · xDrive returns when the ignition is switched off'), W / 2, ry + 40, 16,
        x.index && !x.tested ? (t.warn || '#d29922') : t.dim, { align: 'center', font: 'label' });
    // front-axle torque from the transfer case (LMV): 0 Nm while driving = xDrive is off
    const nm = (v) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + ' Nm';
    const tq = x.torqueOk === false ? 'Front axle torque · the transfer case does not report it'
        : x.torque ? 'Front axle · requested ' + nm(x.torque.requested) + ' · actual ' + nm(x.torque.actual)
            + (x.peakRequested != null ? ' · peak requested while moving ' + nm(x.peakRequested) : '')
        : x.supported === true ? 'Front axle torque shows with the engine running' : null;
    if (tq) cv.text(tq, W / 2, ry + 76, 18, x.torque ? t.text : t.dim, { align: 'center', font: 'label' });
    noteLine(cv, G, t, x, bottom);
    const offBtn = [x.confirmWhat === 'off' ? 'Confirm xDrive off' : 'xDrive off', act.xdriveOff, x.confirmWhat === 'off'];
    // "xDrive on" only on the DSC variants where 2E DB E1 01 was measured to work (xdrive.js ON_INDEX)
    if (x.onAvailable) {
        buttonRow(cv, G, t, [offBtn, [x.confirmWhat === 'on' ? 'Confirm xDrive on' : 'xDrive on', act.xdriveOn, x.confirmWhat === 'on']],
            bottom, 300, x.busy, 'la_xd');
    } else buttonRow(cv, G, t, [offBtn], bottom, 360, x.busy, 'la_xd');
    return cv;
}

/**
 * xDrive live (read only, xdrive_live.js): the car from above with the split between its axles and each wheel's slip,
 * and the readings beside it. Slip within 3 % is shown plain, up to 8 % amber, above that red.
 */
function drawXDriveLive(cv, G, t, x, xd, bottom) {
    const pct = (v, d) => (G.isNum(v) ? (v > 0 && d ? '+' : '') + v.toFixed(d || 0) + ' %' : '--');
    const slipCol = (v) => (!G.isNum(v) ? t.dim : Math.abs(v) > 8 ? RED(t) : Math.abs(v) > 3 ? (t.warn || '#d29922') : t.text);
    // the car from above, front up
    const top = G.TOP + 30, h = Math.max(300, bottom - top - 40), cx = 420, bw = 170;
    cv.strokeRoundRect(cx - bw / 2, top, bw, h, 60, 3, G.withAlpha('#ffffff', 0.35));
    const wy = [top + h * 0.2, top + h * 0.8], ww = 34, wh = 74;
    [['FL', -1, 0], ['FR', 1, 0], ['RL', -1, 1], ['RR', 1, 1]].forEach(([k, side, axle]) => {
        const slip = x.wheels ? x.wheels[k] : null, col = slipCol(slip);
        const wx = cx + side * (bw / 2 + 8) - (side < 0 ? ww : 0);
        cv.roundRect(wx, wy[axle] - wh / 2, ww, wh, 8, G.withAlpha(col, 0.55));
        cv.text(pct(slip, 1), side < 0 ? wx - 14 : wx + ww + 14, wy[axle] + 8, 24, col, { align: side < 0 ? 'right' : 'left', font: 'bold' });
    });
    // the split: a bar along the car, front share lit from the top
    const rear = G.isNum(x.rear) ? x.rear : null, front = rear === null ? null : 100 - rear;
    const by = wy[0] + 10, bh = wy[1] - wy[0] - 20;
    cv.roundRect(cx - 14, by, 28, bh, 10, t.track || G.withAlpha('#ffffff', 0.1));
    if (front !== null) {
        cv.roundRect(cx - 14, by, 28, Math.max(10, bh * front / 100), 10, t.accent2 || '#81c4ff');
        cv.roundRect(cx - 14, by + bh * front / 100, 28, Math.max(10, bh * rear / 100), 10, RED(t));
    }
    cv.text(front === null ? '--' : Math.round(front) + ' %', cx, top - 4, 22, front === null ? t.dim : t.text, { align: 'center', font: 'bold' });
    cv.text(rear === null ? '--' : Math.round(rear) + ' %', cx, top + h + 28, 22, rear === null ? t.dim : t.text, { align: 'center', font: 'bold' });

    // the readings
    const nm = xd && xd.torque ? xd.torque.actual.toFixed(0) + ' Nm' : '--';
    const rows = [
        ['FRONT / REAR', front === null ? '--' : Math.round(front) + ' / ' + Math.round(rear) + ' %'],
        ['FRONT AXLE TORQUE', nm],
        ['FRONT AXLE AGAINST REAR', pct(x.axle, 1)],
        ['STEERING WHEEL', G.isNum(x.steer) ? Math.round(x.steer) + '°' : '--'],
        ['YAW RATE', G.isNum(x.yaw) ? x.yaw.toFixed(1) + ' °/s' : '--'],
        ['LATERAL', G.isNum(x.gLat) ? x.gLat.toFixed(2) + ' g' : '--'],
        ['LONGITUDINAL', G.isNum(x.gLong) ? x.gLong.toFixed(2) + ' g' : '--'],
    ];
    const step = Math.max(44, Math.min(60, (bottom - G.TOP - 80) / rows.length));
    rows.forEach(([label, value], i) => {
        const y = G.TOP + 56 + i * step;
        cv.text(label, 820, y, 20, t.dim, { font: 'bold', spacing: 1.2 });
        cv.text(value, 1520, y, 28, value === '--' ? t.dim : t.text, { font: 'bold', align: 'right' });
    });
    cv.text('Read only · wheel slip compared between the wheels, above 5 km/h' + (xd && xd.torque ? '' : ' · front axle torque with the xDrive tab\'s setting'),
        820, bottom - 16, 16, t.dim, { font: 'label' });
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
 * The silencer, cut out (the panel shows through), centred in x, y, w, h; the flap's butterfly in the RIGHT tailpipe,
 * smoke out of the left one always and out of the right one as far as the flap is open.
 * v.angle: 0 = shut .. 1 = open (eased in main.js).
 */
function drawMuffler(cv, G, t, x, y, w, h, v) {
    const open = v.angle == null ? (v.confirmed === 'OPEN' ? 1 : 0) : Math.max(0, Math.min(1, v.angle));
    // the picture: a cached layer (drawn once into a texture, one blit a frame), at its own size
    const ix = Math.round(x + (w - IMG.LW) / 2), iy = Math.round(y + Math.max(0, (h - IMG.LH) / 2));
    const pic = G.layer('live_adjustments_muffler', IMG.LW, IMG.LH, (c) => IMG.draw(c), cv.textScale);
    // the software renderer would play the layer's shaded triangles in flat colours: it gets the picture as pixels
    // instead (made the first time it asks; the GPU never reads pic.soft)
    if (pic && !pic.mufflerSoft) {
        let px = null;
        Object.defineProperty(pic, 'soft', {
            configurable: true, enumerable: true,
            get() { if (!px) px = IMG.soft(new Canvas(pic.w, pic.h)); return px; },
            set(s) { px = s; },
        });
        pic.mufflerSoft = true;
    }
    cv.blit(pic, ix, iy);
    const L = IMG.BORES.left, R = IMG.BORES.right;
    const rx = ix + R.c[0], ry = iy + R.c[1], lx = ix + L.c[0], ly = iy + L.c[1];
    flapPlate(cv, G, rx, ry, R.a, R.b, R.rot, open);
    const ts = Date.now() / 1000;
    smoke(cv, G, lx, ly, -1, 1, ts, 0.0);
    smoke(cv, G, rx, ry, 1, open, ts, 0.37);
}

/** The butterfly in an elliptic bore (centre cx, cy; semi-axes a along, b across; tilt rot deg): shut it fills the
 * bore, opening it turns about the shaft across the bore and narrows to a sliver. Convex quads only (GPU-safe). */
function flapPlate(cv, G, cx, cy, a, b, rot, open) {
    const ws = Math.max(0.07, Math.cos(open * Math.PI / 2));
    const cr = Math.cos(rot * Math.PI / 180), sr = Math.sin(rot * Math.PI / 180);
    const P = (u, w) => [cx + u * cr - w * sr, cy + u * sr + w * cr];
    const N = 24, ea = a * 0.94 * ws, eb = b * 0.94;
    // the wedges overlap by half a step: no seam where two meet (software draws each edge soft)
    const ell = (sa, sb, ox, oy, col) => {
        for (let i = 0; i < N; i++) {
            const t0 = i * 2 * Math.PI / N, t1 = t0 + 1.5 * Math.PI / N, t2 = t0 + 3 * Math.PI / N;
            cv.quad([P(ox, oy), P(ox + Math.cos(t0) * sa, oy + Math.sin(t0) * sb), P(ox + Math.cos(t1) * sa, oy + Math.sin(t1) * sb),
                P(ox + Math.cos(t2) * sa, oy + Math.sin(t2) * sb)], col);
        }
    };
    ell(ea, eb, 0, 0, '#8e959e');                                         // the plate
    ell(ea * 0.55, eb * 0.45, -ea * 0.18, -eb * 0.32, '#a7acb3');            // sheen (the plate + 22 % white, opaque)
    const s0 = P(0, -b * 0.97), s1 = P(0, b * 0.97);
    cv.line(s0[0], s0[1], s1[0], s1[1], 2.5, G.withAlpha('#20242b', 0.9));           // the shaft
    const c0 = P(0, 0);
    cv.circle(c0[0], c0[1], 3.2, '#1a1e24');
}

/** Exhaust smoke out of a tailpipe at ox, oy: puffs that drift outward (dir -1 left / 1 right), rise, grow and fade.
 * amt 0..1 = how much; a function of the time only, so every frame of the loop moves it on. */
function smoke(cv, G, ox, oy, dir, amt, ts, seed) {
    if (amt < 0.04) return;
    const N = 10, period = 2.4;
    for (let i = 0; i < N; i++) {
        const p = ((ts / period + i / N + seed) % 1 + 1) % 1;
        const x = ox + dir * (24 + p * 150) + Math.sin(ts * 1.7 + i * 1.3) * 7 * p;
        const y = oy + (p * 18 - p * p * 95);
        const r = 7 + p * 40;
        const al = amt * 0.42 * (1 - p) * Math.min(1, p * 5);
        if (al < 0.004) continue;
        cv.circle(x, y, r, G.withAlpha('#d8dce2', al * 0.45));
        cv.circle(x - r * 0.12, y - r * 0.1, r * 0.66, G.withAlpha('#e6e9ee', al * 0.55));
        cv.circle(x - r * 0.18, y - r * 0.16, r * 0.36, G.withAlpha('#f2f4f7', al * 0.6));
    }
}

module.exports = { draw, noteText, W, H };
