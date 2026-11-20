'use strict';
/**
 * Part of Redline's experimental features; README.md in this folder has the whole picture.
 *
 * Drawing Redline's own directions on the HUD: the next turn's arrow, its
 * distance, the street and the lanes, as a picture (a 200x76 image layer in the bottom right corner of the glass,
 * clear of BMW's speed and limit sign at the bottom left; hud.js places and sends it). Not the GPU: since 1.16.1 the
 * GPU draws the Arc only (shaders restarted the cluster).
 * The object drawn is nav.js's: { kind, dir, exit, exitAngle, side, dist, unit, road, lanes }.
 *
 *   [arrow] 450 m             [arrow] 700 m
 *           Example Street            ▏↑▏↑▏↱▏    (lanes, when there are some, in the street's place)
 *
 * Everything is right-aligned, so it hugs the corner. Arrows in the HUD colours' text colour (white), thick:
 * drawn right-handed and mirrored for the left. Straight, slight / normal / hard turns, U-turns, keep / fork / exit
 * (the road it leaves dim), motorway entry (the motorway dim), lane change, roundabout (the ring dim, the way round
 * and the exit bright, its number inside), destination flag, and a dot for anything else ("follow the route").
 * Black is see-through on the glass, like the tach.
 */
const { withAlpha, mix } = require('./kit/canvas');
const { PALETTES } = require('./hud-draw');

const NW = 200, NH = 76;
const isNum = (x) => typeof x === 'number' && isFinite(x);

/*
 * Arrow geometry in a box of -40..40 (y down), drawn right-handed; mir -1 mirrors it for the left.
 * A shape: { path: [points] (the way to go, bright, ending at the arrow's tip), dim: [[points]...] (roads not
 * taken), mir, cut: [x, y, w, h] (an underpass: the bright road broken where the dim one crosses over it) }.
 * path null: no arrow (a dot, "follow the route").
 */
const SIDE = (d) => (/LEFT/.test(d) ? -1 : 1);
/** The angle of a turn direction name, degrees right of straight on (left ones: mirrored). */
function turnDeg(d) { return /SLIGHT/.test(d) ? 45 : /HARD|SHARP/.test(d) ? 135 : /LEFT|RIGHT/.test(d) ? 90 : 0; }
function turnPath(deg) {
    const a = deg * Math.PI / 180;
    if (deg === 0) return [[0, 36], [0, -36]];
    // a hard turn: the stem on the other side and bending high, so the way back down stands clear of it
    if (deg >= 135) return [[-15, 36], [-15, -22], [-15 + Math.sin(a) * 48, -22 - Math.cos(a) * 48]];
    // a plain turn: the stem a little to the other side and bending high, so the arm across is long (2026-11-10 drive)
    if (deg === 90) return [[-13, 36], [-13, -4], [35, -4]];
    return [[0, 36], [0, 6], [Math.sin(a) * 38, 6 - Math.cos(a) * 38]];
}
/** A turn by its direction name (TurnDirection: STRAIGHT_ON, LEFT, SLIGHT_RIGHT, HARD_LEFT, UTURN_RIGHT...). NONE: no arrow. */
function turnShape(dir) {
    const d = String(dir || '');
    if (d === 'NONE' || d === '') return { path: null, mir: 1 };
    const mir = SIDE(d);
    if (/UTURN|U_TURN/.test(d)) {
        // up on one side, round over the top, back down on the side it turns to (UTURN_LEFT: ends on the left)
        const p = [[13, 36], [13, -8]];
        for (let i = 1; i <= 10; i++) { const a = i * Math.PI / 10; p.push([13 * Math.cos(a), -8 - 13 * Math.sin(a)]); }
        p.push([-13, 24]);
        return { path: p, mir: -mir };
    }
    // the bends rounded, not a sharp corner (2026-11-10 drive)
    return { path: turnPath(turnDeg(d)), mir: mir, round: 12 };
}

/*
 * Every bright path ends in a straight run at least HEAD_RUN long, so the head sits on a straight piece: with the
 * bend under the head's base, the thick stroke coming into it bulged out on one side and that side of the head
 * looked smaller (2026-11-09 review). The tests check it for every arrow.
 */
const HEAD_RUN = 28;
// the legs of forks and branches, right-handed; the split is at y 10, the bend at y -6. Legs 22 apart, so a
// head (15 each side) never sits on the road beside it; roads not taken end at DIM_END, below the bright head
// (2026-11-09 visual review: heads covered the dim roads)
const DIM_END = -24;
const STEM = [[0, 36], [0, 10]];
const LEG = { left: [[0, 10], [-22, -8], [-22, -38]], right: [[0, 10], [22, -8], [22, -38]], center: [[0, 10], [0, -38]] };
/** A leg cut short (a road not taken): its last point raised to y. */
const short = (leg, y) => leg.slice(0, -1).concat([[leg[leg.length - 1][0], y]]);
/** A fork into legs (names of LEG), the one taken bright. */
function forkOf(legs, take) {
    return { path: STEM.concat(LEG[take].slice(1)), dim: legs.filter((l) => l !== take).map((l) => short(LEG[l], DIM_END)), mir: 1 };
}
/** A motorway exit on side ('left' / 'right'): the main road straight on, the slip road peeling off. take: 'exit' / 'main'. */
const EXIT_LEG = { right: [[0, 18], [8, 10], [22, -6], [22, -38]], left: [[0, 18], [-8, 10], [-22, -6], [-22, -38]] };
function exitOf(side, take) {
    const leg = EXIT_LEG[side];
    return take === 'exit' ? { path: [[0, 36]].concat(leg), dim: [[[0, 18], [0, DIM_END]]], mir: 1 } : { path: [[0, 36], [0, -38]], dim: [short(leg, DIM_END)], mir: 1 };
}
/**
 * An exit on side that forks in two after it; sub: 'left' / 'right' (the branch of the slip road taken). The main
 * road (dim) only starts on, so the slip road and its fork have the room; the fork's legs 22 apart.
 */
function exitForkOf(side, sub) {
    const sx = side === 'left' ? -1 : 1, split = [sx * 15, 2];
    const leg = (t) => [split, [split[0] + (t === 'left' ? -11 : 11), -10], [split[0] + (t === 'left' ? -11 : 11), -38]];
    return { path: [[0, 36], [0, 22], [sx * 6, 16], split].concat(leg(sub).slice(1)),
        dim: [[[0, 22], [0, -6]], short(leg(sub === 'left' ? 'right' : 'left'), DIM_END)], mir: 1 };
}
/** Straight on, under (a gap as wide as the road over it) or over a road crossing it. */
function crossingOf(under) {
    return { path: [[0, 36], [0, -36]], dim: [[[-34, 0], [34, 0]]], mir: 1, cut: under ? [-9, -8, 18, 16] : null };
}

/**
 * detailedGeometry (ManeuverGeometry, 31 values in the car's catalog): the junction's exact shape when the car
 * gives one (seen on the drive: UNDEFINED). Over- / underpass variants are drawn as the plain fork. null: no shape.
 */
function geometryShape(g) {
    g = String(g || '');
    let r = /^EXIT_(LEFT|RIGHT)_TAKE_(LEFT|RIGHT)$/.exec(g);
    if (r) return exitOf(r[1].toLowerCase(), r[1] === r[2] ? 'exit' : 'main');
    r = /^EXIT_(LEFT|RIGHT)_TWO_WAY_FORK_TAKE_(?:LEFT|RIGHT)_(LEFT|RIGHT)$/.exec(g);
    if (r) return exitForkOf(r[1].toLowerCase(), r[2].toLowerCase());
    r = /^THREE_WAY_FORK_.*TAKE_(LEFT|CENTER|RIGHT)$/.exec(g);
    if (r) return forkOf(['left', 'center', 'right'], r[1].toLowerCase());
    r = /^TWO_WAY_FORK_.*TAKE_(LEFT|RIGHT)$/.exec(g);
    if (r) return forkOf(['left', 'right'], r[1].toLowerCase());
    return null;
}

/** A road branching off to one side (BRANCH_*, keep left / right along the main road): the way on dim, straight. */
function branchOf(side) { return { path: STEM.concat(LEG[side].slice(1)), dim: [short(LEG.center, DIM_END)], mir: 1 }; }

/** BranchType (15 values in the catalog) as a shape. */
function branchShape(d) {
    const side = /LEFT/.test(d) ? 'left' : 'right';
    if (/^HIGHWAY_IN/.test(d)) {
        // onto the motorway: the motorway dim, the slip road joining it from the other side
        if (/STRAIGHT/.test(d)) return { path: [[0, 36], [0, -36]], dim: [[[-24, 36], [-6, 6]], [[24, 36], [6, 6]]], mir: 1 };
        // the slip road far enough from the motorway that the head stays off it; the motorway ends below the head
        return { path: [[-18, 36], [-18, 16], [2, -4], [2, -38]], dim: [[[22, 36], [22, -22]]], mir: SIDE(d) };
    }
    if (/^HIGHWAY_OUT/.test(d)) {
        // off the motorway; STRAIGHT: the motorway bends away on both sides, the way off goes on
        if (/STRAIGHT/.test(d)) return { path: [[0, 36], [0, -36]], dim: [short(LEG.left, DIM_END), short(LEG.right, DIM_END)], mir: 1 };
        return exitOf(side, 'exit');
    }
    if (/^TRIPLE_FORK/.test(d)) return forkOf(['left', 'center', 'right'], /STRAIGHT/.test(d) ? 'center' : side);
    if (/^FORK/.test(d)) return forkOf(['left', 'right'], side);
    if (d === 'OVERPASS' || d === 'UNDERPASS') return crossingOf(d === 'UNDERPASS');
    if (/^BRANCH_(LEFT|RIGHT)$/.test(d)) return branchOf(side);
    return { path: null, mir: 1 };                      // NONE or anything newer: the dot, not a guessed arrow
}

/** Whether a shape goes the way a direction name says: its end left / right / straight of its start. */
function agrees(sh, d) {
    const side = /LEFT/.test(d) ? -1 : /RIGHT/.test(d) ? 1 : 0;
    if (!side) return true;                 // STRAIGHT_ON, NONE, OVERPASS...: any shape will do
    const dx = (sh.path[sh.path.length - 1][0] - sh.path[0][0]) * sh.mir;
    return dx * side > 3;
}
/** The shape for nav.js's object (roundabouts, flags and transport are drawn by their own functions). */
function shapeOf(m) {
    if (!m) return { path: null, mir: 1 };
    const d = String(m.dir || '');
    // the exact shape first, when the car gives one and it goes the direction's way (the direction wins otherwise)
    const g = (m.kind === 'turn' || m.kind === 'branch') && m.geom ? geometryShape(m.geom) : null;
    if (g && agrees(g, d)) return g;
    switch (m.kind) {
    case 'turn': return turnShape(d);
    case 'keep': return d === 'LEFT' || d === 'RIGHT' ? branchOf(d === 'LEFT' ? 'left' : 'right') : { path: null, mir: 1 };
    case 'lanechange': return d === 'LEFT' || d === 'RIGHT' ? { path: [[-12, 36], [-12, 14], [12, -8], [12, -36]], dim: [[[-12, 14], [-12, -32]]], mir: SIDE(d) } : { path: null, mir: 1 };
    case 'branch': return branchShape(d);
    default: return { path: null, mir: 1 };
    }
}

/**
 * The exit's direction for drawing: degrees ANTICLOCKWISE from straight on (90: left).
 * The car's exitAngle is read as degrees CLOCKWISE from straight on: the drive (left-hand traffic, Australia)
 * had exit 1 at 307, i.e. 53 degrees left, where a first exit is in clockwise roundabouts; it's also how a
 * CarPlay angle of -53 wraps into 0..359. Not yet seen: a roundabout in right-hand traffic.
 * No angle: from the exit's number, a four-way roundabout (left traffic: left first; right traffic: right first).
 */
function exitAngleOf(m) {
    if (isNum(m.exitAngle)) return ((360 - m.exitAngle) % 360 + 360) % 360;
    const n = isNum(m.exit) && m.exit > 0 ? m.exit : 2;
    if (n > 4) return 0;                     // a bigger roundabout than four ways: straight on, the number says which
    return m.side === 'left' ? ((90 - 90 * (n - 1)) % 360 + 360) % 360 : (270 + 90 * (n - 1)) % 360;
}

/**
 * A polyline with round joins and ends, drawn in one pass (cv.stroke) so a bend's edge isn't blended twice: drawn
 * piece by piece, the overlap at a bend showed as a bump on the HUD (2026-11-10 drive).
 */
function stroke(cv, pts, X, Y, w, c) {
    if (cv.stroke) { cv.stroke(pts.map((p) => [X(p), Y(p)]), w, c); return; }
    for (let i = 1; i < pts.length; i++) cv.line(X(pts[i - 1]), Y(pts[i - 1]), X(pts[i]), Y(pts[i]), w, c);
}
/**
 * The path with its bends rounded off, radius r (each bend a short curve). The last piece keeps at least HEAD_RUN
 * straight for the head.
 */
function rounded(path, r) {
    if (!r || path.length < 3) return path;
    const len = (a, b) => Math.sqrt((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]));
    const out = [path[0]];
    for (let i = 1; i < path.length - 1; i++) {
        const A = path[i - 1], B = path[i], C = path[i + 1], la = len(A, B), lc = len(B, C);
        const rr = Math.max(0, Math.min(r, la / 2, i === path.length - 2 ? lc - HEAD_RUN : lc / 2));
        if (rr < 1) { out.push(B); continue; }
        const P = [B[0] + (A[0] - B[0]) * rr / la, B[1] + (A[1] - B[1]) * rr / la], Q = [B[0] + (C[0] - B[0]) * rr / lc, B[1] + (C[1] - B[1]) * rr / lc];
        for (let k = 0; k <= 8; k++) {
            const t = k / 8, u = 1 - t;
            out.push([u * u * P[0] + 2 * u * t * B[0] + t * t * Q[0], u * u * P[1] + 2 * u * t * B[1] + t * t * Q[1]]);
        }
    }
    out.push(path[path.length - 1]);
    return out;
}
/** The bright path and its head: the head's tip at the path's end, along the last segment; the shaft runs into its base. */
function arrowPath(cv, path, X, Y, s, W, col) {
    const p = path.slice(), a = p[p.length - 2], b = p[p.length - 1];
    const ax = X(a), ay = Y(a), bx = X(b), by = Y(b);
    const l = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay)) || 1, ux = (bx - ax) / l, uy = (by - ay) / l;
    const L = 20 * s, HW = 15 * s;
    const back = Math.min(L * 0.7, l * 0.9) / l;
    p[p.length - 1] = [b[0] + (a[0] - b[0]) * back, b[1] + (a[1] - b[1]) * back];
    stroke(cv, p, X, Y, W, col);
    const qx = bx - ux * L, qy = by - uy * L;
    cv.triangle([[bx, by], [qx - uy * HW, qy + ux * HW], [qx + uy * HW, qy - ux * HW]], col);
}

/**
 * The arrow for m, centred at cx, cy, s: scale (1 = an 80 px box). col: bright, dim: the roads not taken.
 * Draws nothing for null.
 */
function drawArrow(cv, m, cx, cy, s, col, dim) {
    if (!m) return;
    const W = 12 * s;
    if (m.kind === 'roundabout') { drawRoundabout(cv, m, cx, cy, s, col, dim); return; }
    if (m.kind === 'destination') { if (m.flag === false) drawStop(cv, m, cx, cy, s, col); else drawFlag(cv, m, cx, cy, s, col, dim); return; }
    if (m.kind === 'transport') { drawTransport(cv, m, cx, cy, s, col, dim); return; }
    const sh = shapeOf(m);
    // follow the route: a dot in a ring
    if (!sh.path) { cv.circle(cx, cy, 10 * s, col); cv.arc(cx, cy, 17 * s, 21 * s, 0, 360, dim); return; }
    const X = (p) => cx + p[0] * sh.mir * s, Y = (p) => cy + p[1] * s;
    const dims = () => (sh.dim || []).forEach((p) => stroke(cv, p, X, Y, W * 0.8, dim));
    // an underpass: the bright road first, broken where the dim road passes over it
    if (!sh.cut) dims();
    arrowPath(cv, rounded(sh.path, sh.round), X, Y, s, W, col);
    if (sh.cut) { cv.fillRect(cx + sh.cut[0] * s, cy + sh.cut[1] * s, sh.cut[2] * s, sh.cut[3] * s, [0, 0, 0, 255]); dims(); }
}

/**
 * The roundabout: the ring dim; one bright path in from below, round the island's way and out at the exit's
 * angle, with the head; the exit's number in the middle. side: the traffic side (the car's driveDirection):
 * 'left' (left-hand traffic, the drive): clockwise; 'right': anticlockwise.
 * Back the way it came (a U-turn, exit at about 180): the way in comes up on the drive side of the bottom and the
 * way out goes straight down beside it, two strokes apart, not one on the other (2026-11-09 review).
 */
const RB_IN = 42;            // the way in: degrees round from the bottom, on the drive side
const RB_SHARP = 67;         // exits closer than this round the island (a sharp first exit): in from the other side
const RB_MIN = 30;           // the shortest way round drawn, degrees
const RB_BACK = 30;           // exits within this of the bottom again (a U-turn): out straight down beside the way in
const RB_R = 17;             // the ring's middle; the ring is 8 wide (RB_R - 4 .. RB_R + 4)
const RB_SEEN = 10;          // how far the way in and the way out's shaft stick out past the ring (2026-11-10 drive)
const RB_HEAD_S = 0.6;       // the head's scale at a roundabout (its length: 20 x this)
const RB_FIT = 38;           // the furthest the tip may reach from the box's middle; the ring moves back to keep it
/**
 * How the roundabout is drawn for m: { tIn, tOut, back } in degrees travelled round the island from the bottom
 * (the true way in), and back: a U-turn drawn as two strokes side by side. Exported for the tests.
 */
function roundaboutPlan(m) {
    const dir = m.side === 'left' ? -1 : 1, a = exitAngleOf(m);
    // how far round the island the exit is, in the travel direction, from the bottom (0..360)
    const d = ((dir > 0 ? a - 180 : 180 - a) % 360 + 360) % 360;
    if (d >= 360 - RB_BACK || d <= 10) return { dir: dir, tIn: RB_IN, tOut: 360 - RB_IN, back: true };
    // a sharp first exit (back to the drive side): in just before the bottom, a short way round
    if (d < RB_SHARP) return { dir: dir, tIn: -15, tOut: Math.max(d, RB_MIN - 15), back: false };
    return { dir: dir, tIn: RB_IN, tOut: Math.max(d, RB_IN + RB_MIN), back: false };
}
// the ring big and low in the box, so the way in is short and the exit's number big (2026-11-10 drive)
/**
 * Where the roundabout's parts go, in the arrow box's units (box -40..40, y down): { c: the ring's middle, R, path
 * (the bright way in, round and out), tip }. The way in sticks out RB_SEEN past the ring, round end included; the
 * way out's shaft as far, then its head. The ring sits a little low, and moves back from a long exit so the tip
 * stays inside the box. Exported for the tests.
 */
function roundaboutGeom(m) {
    const R = RB_R, OUT = R + 4, CAP = 4.5, HEAD = 20 * RB_HEAD_S;
    const P = roundaboutPlan(m), ang = (t) => 180 + P.dir * t;      // drawing angle (anticlockwise from straight on)
    const dirOf = (deg) => { const t = deg * Math.PI / 180; return [-Math.sin(t), -Math.cos(t)]; };
    const reach = OUT + RB_SEEN + HEAD;
    let c = [0, 3];
    if (!P.back) {
        const d = dirOf(ang(P.tOut)), over = Math.max(0, (c[0] * d[0] + c[1] * d[1]) + reach - RB_FIT);
        c = [c[0] - d[0] * over, c[1] - d[1] * over];
    }
    const pt = (deg, r) => { const d = dirOf(deg); return [c[0] + d[0] * r, c[1] + d[1] * r]; };
    const IN = pt(ang(P.tIn), R);
    // the way in ends RB_SEEN (with its round end) below the ring's outside edge where it meets it
    const dx = IN[0] - c[0], edgeY = c[1] + Math.sqrt(Math.max(0, OUT * OUT - dx * dx)), inEnd = edgeY + RB_SEEN - CAP;
    const path = [[IN[0], inEnd], IN];
    const n = Math.max(2, Math.ceil((P.tOut - P.tIn) / 12));
    for (let i = 1; i <= n; i++) path.push(pt(ang(P.tIn + (P.tOut - P.tIn) * i / n), R));
    // out: the shaft as long as the way in, then the head; a U-turn: straight down beside the way in, as far
    const end = pt(ang(P.tOut), R);
    if (P.back) path.push([end[0], end[1] + 4], [end[0], inEnd]);
    else path.push(pt(ang(P.tOut), R + 5), pt(ang(P.tOut), reach));
    return { c: c, R: R, path: path, tip: path[path.length - 1], back: P.back };
}
function drawRoundabout(cv, m, cx, cy, s, col, dim) {
    const G = roundaboutGeom(m), W = 9 * s;
    const X = (p) => cx + p[0] * s, Y = (p) => cy + p[1] * s;
    cv.arc(X(G.c), Y(G.c), (G.R - 4) * s, (G.R + 4) * s, 0, 360, dim);
    arrowPath(cv, G.path, X, Y, s * RB_HEAD_S, W, col);
    if (isNum(m.exit) && s >= 0.5) cv.text(String(m.exit), X(G.c), Y(G.c) + 6.5 * s, 18 * s, col, { align: 'center', font: 'bold', literal: true });
}

/** Arrival: a chequered flag; LEFT / RIGHT: a small arrow on the ground towards that side (CENTER, NOT_DIGITIZED: none). */
function drawFlag(cv, m, cx, cy, s, col, dim) {
    const d = String(m.dir || ''), mir = /LEFT/.test(d) ? -1 : /RIGHT/.test(d) ? 1 : 0;
    const px = cx - (mir || 1) * 10 * s;
    cv.line(px, cy + 26 * s, px, cy - 32 * s, 6 * s, col);
    const fw = 32 * s, fh = 24 * s, cw = fw / 4, ch = fh / 2, x0 = mir < 0 ? px - fw : px, y0 = cy - 32 * s;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) cv.fillRect(x0 + i * cw, y0 + j * ch, cw, ch, (i + j) % 2 ? dim : col);
    if (mir) cv.triangle([[cx + mir * 32 * s, cy + 30 * s], [cx + mir * 16 * s, cy + 20 * s], [cx + mir * 16 * s, cy + 40 * s]], col);
}

/** A stopover on the way (isCheckeredFlag false): a pin with its number. */
function drawStop(cv, m, cx, cy, s, col) {
    const r = 18 * s, py = cy - 10 * s;
    cv.circle(cx, py, r, col);
    cv.triangle([[cx - r * 0.75, py + r * 0.65], [cx + r * 0.75, py + r * 0.65], [cx, cy + 34 * s]], col);
    cv.circle(cx, py, r - 5 * s, [0, 0, 0, 255]);
    if (isNum(m.stop) && m.stop > 0) cv.text(String(m.stop), cx, py + 7 * s, 20 * s, col, { align: 'center', font: 'bold', literal: true });
}

/** Onto a ferry or a car train (vehicleTransportation). */
function drawTransport(cv, m, cx, cy, s, col, dim) {
    const X = (x) => cx + x * s, Y = (y) => cy + y * s;
    if (/TRAIN/.test(String(m.dir))) {
        cv.roundRect(X(-24), Y(-30), 48 * s, 48 * s, 9 * s, col);
        cv.fillRect(X(-17), Y(-22), 34 * s, 14 * s, [0, 0, 0, 255]);
        cv.circle(X(-12), Y(6), 5 * s, [0, 0, 0, 255]); cv.circle(X(12), Y(6), 5 * s, [0, 0, 0, 255]);
        cv.line(X(-14), Y(20), X(-24), Y(34), 5 * s, col); cv.line(X(14), Y(20), X(24), Y(34), 5 * s, col);
        cv.line(X(-30), Y(30), X(30), Y(30), 3 * s, dim);
        return;
    }
    // ferry: a cabin, the hull, two waves
    cv.fillRect(X(-10), Y(-30), 20 * s, 14 * s, col);
    cv.convex([[X(-32), Y(-12)], [X(32), Y(-12)], [X(22), Y(10)], [X(-22), Y(10)]], col);
    [20, 32].forEach((y, i) => {
        const pts = [];
        for (let x = -34; x <= 34; x += 4) pts.push([X(x), Y(y + Math.sin(x / 6) * 3)]);
        cv.polyline(pts, 4 * s, i ? dim : col);
    });
}

/*
 * The lanes: one cell per lane, the lines between them (SOLID / DASHED, from the car). Each lane's arrows are
 * lane glyphs, not the big turn arrows: one stem from the bottom shared by all of a lane's arrows, a turn's arm
 * leaving low, straight on running to the top, so a straight-and-right lane shows both heads well apart (with the
 * big arrows the straight head sat just over the turn's arm: 2026-11-09 review). The arrows to take (in a lane to
 * be in) bright, the others dim. BLOCKED: a dim cross; ELLIPSIS (more lanes than shown): three dots.
 */
const LANE_W = 22, LANE_H = 32, LANES_MAX = 6, LANE_S = 0.4;
/** The lanes' cell width for n lanes in at most maxW px. */
const laneW = (n, maxW) => Math.min(LANE_W, maxW / Math.max(1, n));
/** A lane glyph's path (box -40..40, right-handed; LEFT ones mirrored): the stem from the bottom, then the arm. */
function lanePath(dir) {
    const d = String(dir || ''), mir = SIDE(d);
    if (/UTURN|U_TURN/.test(d)) {
        // up the stem, over the top towards the side, back down beside it (UTURN_LEFT: on the left)
        // ends above where a turn's arm leaves (y 22), so a turn-and-U-turn lane keeps them apart
        const p = [[0, 36], [0, -12]];
        for (let i = 1; i <= 8; i++) { const a = Math.PI - i * Math.PI / 8; p.push([8 + 8 * Math.cos(a), -12 - 8 * Math.sin(a)]); }
        p.push([16, 6]);
        return { path: p, mir: mir, head: 0.7 };
    }
    const deg = turnDeg(d);
    if (deg === 0) return { path: [[0, 36], [0, -38]], mir: 1 };
    if (deg === 45) return { path: [[0, 36], [0, 14], [22, -10]], mir: mir };
    if (deg === 90) return { path: [[0, 36], [0, 22], [22, 22]], mir: mir };
    return { path: [[0, 36], [0, 4], [20, 24]], mir: mir };            // hard: a short way up, then back down to the side
}
/** One lane's arrows at cx, cy: dim ones first, the ones to take over them. */
function drawLaneArrows(cv, lane, cx, cy, k, col, dim) {
    // thinner than the big arrows (9 against 12): in a 22 px cell the big stroke looked heavy (2026-11-09 review)
    const s = LANE_S * k, W = 9 * s;
    const one = (d, c) => {
        if (!d || d === 'NONE' || TURN_DIRECTIONS.indexOf(d) < 0) return;      // not a direction: no glyph, never a guess
        const g = lanePath(d), X = (p) => cx + p[0] * g.mir * s, Y = (p) => cy + p[1] * s;
        // a smaller head than the big arrows' (in a 22 px cell), on the same stroke
        arrowPath(cv, g.path, X, Y, s * 0.8 * (g.head || 1), W, c);
    };
    if (lane.info === 'ELLIPSIS') { [-7, 0, 7].forEach((dx) => cv.circle(cx + dx * k, cy, 1.8 * k, dim)); return; }
    const follows = lane.follows || (lane.follow && lane.follow !== 'NONE' ? [lane.follow] : []);
    const blocked = lane.info === 'BLOCKED';
    lane.others.forEach((d) => one(d, dim));
    follows.forEach((d) => one(d, lane.hi && !blocked ? col : dim));
    // dim: a closed lane mustn't be the brightest thing in the row
    if (blocked) { const r = 7 * k; cv.line(cx - r, cy - r, cx + r, cy + r, 2.5 * k, dim); cv.line(cx - r, cy + r, cx + r, cy - r, 2.5 * k, dim); }
}
/** At most LANES_MAX lanes: the window round the highlighted ones (and the lines between them). */
function laneWindow(L) {
    const n = L.lanes.length;
    if (n <= LANES_MAX) return L;
    const hi = [];
    L.lanes.forEach((l, i) => { if (l.hi) hi.push(i); });
    // the highlighted lanes if they fit; else round the recommended one (or the nearest highlighted one to it)
    let mid;
    if (hi.length && hi[hi.length - 1] - hi[0] < LANES_MAX) mid = (hi[0] + hi[hi.length - 1]) / 2;
    else if (isNum(L.rec)) mid = hi.length ? hi.reduce((b, i) => (Math.abs(i - L.rec) < Math.abs(b - L.rec) ? i : b), hi[0]) : L.rec;
    else mid = hi.length ? hi[0] : (n - 1) / 2;
    const from = Math.max(0, Math.min(n - LANES_MAX, Math.round(mid - (LANES_MAX - 1) / 2)));
    return { lanes: L.lanes.slice(from, from + LANES_MAX), rec: L.rec, markers: (L.markers || []).slice(from, from + LANES_MAX + 1),
        cutL: from > 0, cutR: from + LANES_MAX < n };
}
function drawLanes(cv, L, x, cy, w, col, dim) {
    if (!L || !L.lanes || !L.lanes.length) return 0;
    L = laneWindow(L);
    const n = Math.min(L.lanes.length, LANES_MAX), k = w / LANE_W, h = LANE_H, y0 = cy - h / 2;
    for (let i = 0; i <= n; i++) {
        const mk = L.markers && L.markers[i], lx = x + i * w;
        if (mk === 'SOLID') cv.line(lx, y0, lx, y0 + h, 1.5, dim);
        else for (let j = 0; j < 3; j++) cv.line(lx, y0 + j * h / 3 + 2, lx, y0 + j * h / 3 + h / 6 + 2, 1.5, dim);
    }
    for (let i = 0; i < n; i++) drawLaneArrows(cv, L.lanes[i], x + (i + 0.5) * w, cy, Math.min(1, k), col, dim);
    // more lanes than shown on a side: two dots outside its edge line (counting "the 2nd from the left" stays honest)
    [[L.cutL, x - 4], [L.cutR, x + n * w + 4]].forEach((c) => { if (c[0]) { cv.circle(c[1], cy - 4, 1.6, dim); cv.circle(c[1], cy + 4, 1.6, dim); } });
    return n * w;
}

/** Street names in the HUD's fonts (ASCII and a few signs): accents taken off, others left out. */
const FOLD = { 'ß': 'ss', 'ẞ': 'SS', 'æ': 'ae', 'Æ': 'AE', 'ø': 'o', 'Ø': 'O', 'œ': 'oe', 'Œ': 'OE', 'ł': 'l', 'Ł': 'L', 'đ': 'd', 'Đ': 'D', 'ı': 'i' };
function foldText(s) {
    let t = String(s || '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, '').replace(/[\s\u00a0\u2000-\u200a\u202f\u205f\u3000]+/g, ' ');
    try { t = t.normalize('NFD'); } catch (e) { /* no ICU: left as it is */ }
    // letters of another script (Cyrillic, Greek, CJK, Hebrew, Arabic...): no fragments, no name
    if (/[\u0370-\u03ff\u0400-\u052f\u0590-\u06ff\u0e00-\u0e7f\u1100-\u11ff\u3040-\u30ff\u3130-\u318f\u3400-\u9fff\uac00-\ud7af]/.test(t)) return '';
    t = t.replace(/[̀-ͯ]/g, '').replace(/[^\u0000-~]/g, (ch) => FOLD[ch] || (ch === '…' || ch === '–' || ch === '·' ? ch : ''));
    return t.replace(/\s+/g, ' ').trim();
}
/** s cut with … to fit w px at size. */
function fit(cv, s, size, w, opts) {
    if (cv.textWidth(s, size, opts) <= w) return s;
    let n = s.length;
    while (n > 1 && cv.textWidth(s.slice(0, n) + '…', size, opts) > w) n--;
    return n > 1 ? s.slice(0, n).trim() + '…' : '';
}

/**
 * s on up to `lines` lines of w px at size, broken between words (a word too long for a line broken where it must);
 * what still doesn't fit ends the last line with …. Returns the lines ([] for nothing).
 */
function wrap(cv, s, size, w, opts, lines) {
    const words = String(s || '').split(/\s+/).filter(Boolean), out = [];
    let cur = '';
    const width = (t) => cv.textWidth(t, size, opts);
    while (words.length && out.length < lines) {
        const word = words[0], next = cur ? cur + ' ' + word : word;
        if (width(next) <= w) { cur = next; words.shift(); continue; }
        if (cur) { out.push(cur); cur = ''; continue; }
        // one word wider than a line: as much of it as fits, the rest on the next line
        let n = word.length;
        while (n > 1 && width(word.slice(0, n)) > w) n--;
        out.push(word.slice(0, n)); words[0] = word.slice(n);
    }
    if (cur && out.length < lines) out.push(cur);
    else if (cur) words.unshift(cur);
    if (words.length && out.length) out[out.length - 1] = fit(cv, out[out.length - 1] + ' ' + words.join(' ') + ' ', size, w, opts);
    return out;
}

/** Text sizes: the distance (its unit smaller), the street (one line; two a little smaller when it's long). */
const DIST = 34, UNIT = 20, ROAD = 18, ROAD2 = 15;
const DOPTS = { font: 'bold', literal: true }, UOPTS = { font: 'bold', literal: true }, ROPTS = { font: 'label', literal: true };
const AW = 68, GAP = 6, TEXT_MIN = 92;
// "then": its words, its small arrow (box, scale)
const THEN_T = 16, THEN_A = 26, THEN_S = 0.3;
/** How far after the next turn, as the next turn's distance reads (metric: to 10 m; else feet, to 50 ft); '' unknown. */
function gapText(gap, unit, uk) {
    if (gap === null || gap === undefined || !isFinite(gap)) return '';
    if (uk || unit === 'yd') return Math.max(10, Math.round(gap / 0.9144 / 10) * 10) + ' yd';
    return unit === 'mi' || unit === 'ft' ? Math.max(50, Math.round(gap / 0.3048 / 50) * 50) + ' ft' : Math.max(10, Math.round(gap / 10) * 10) + ' m';
}

/**
 * The directions picture: cv a NW x NH Canvas (cleared here). m: nav.js's object (null: left empty).
 * opts: { palette } (hud-draw's names; arrows and text in its text colour, roads not taken dim).
 * Right-aligned: [arrow] then the distance over the street, or over the lanes when there are some.
 * Returns where it drew: { x (the arrow's box), lanes: { x, w (a cell) } | null }, or null.
 */
function drawNav(cv, m, opts) {
    cv.clear();
    if (!m) return null;
    const P = PALETTES[(opts && opts.palette) || 'colour'] || PALETTES.colour;
    // dim: a solid dark shade, not a see-through one (overlapping strokes of a see-through colour add up at every bend)
    const col = P.text, dim = mix('#000000', P.text, 0.42);
    const textMax = NW - AW - GAP - 2;
    const unit = m.unit || '', dist = m.dist ? fit(cv, String(m.dist), DIST, textMax - 4 - cv.textWidth(unit, UNIT, UOPTS), DOPTS) : '';
    const distW = dist ? cv.textWidth(dist, DIST, DOPTS) + 4 + cv.textWidth(unit, UNIT, UOPTS) : 0;
    const nL = m.lanes ? laneWindow(m.lanes).lanes.length : 0, lw = nL ? laneW(nL, textMax) : 0;
    // the street only without lanes or "then" (they don't all fit)
    // "then" (the turn close behind): the second line, in the street's place; with lanes there, a small arrow after
    // the distance instead
    const th = m.then || null, thLine = th && !nL, thGap = th ? gapText(th.gap, unit, m.uk) : '';
    const thW = thLine ? cv.textWidth('then', THEN_T, ROPTS) + 4 + THEN_A + (thGap ? 4 + cv.textWidth(thGap, THEN_T, ROPTS) : 0) : 0;
    // the street: one line when it fits, else two a size smaller (2026-11-11: "On your left: 32..." was cut short)
    const roadS = !nL && !th && m.road ? foldText(m.road) : '';
    const big = !!roadS && cv.textWidth(roadS, ROAD, ROPTS) <= textMax;
    const roadLines = !roadS ? [] : big ? [roadS] : wrap(cv, roadS, ROAD2, textMax, ROPTS, 2);
    const roadSize = big ? ROAD : ROAD2, road = roadLines.join(' ');
    const roadW = roadLines.reduce((a, l) => Math.max(a, cv.textWidth(l, roadSize, ROPTS)), 0);
    // at least TEXT_MIN wide, so the arrow stays put while the distance counts down (800 m, 50 m, 1.2 km)
    const tw = Math.min(textMax, Math.max(distW + (th && nL ? 4 + THEN_A : 0), roadW, nL * lw, thW, dist ? TEXT_MIN : 0));
    let x = Math.round(NW - 2 - tw - (tw ? GAP : 0) - AW);
    const out = { x: x, lanes: null };
    drawArrow(cv, m, x + AW / 2, NH / 2, 0.85, col, dim);
    x += AW + GAP;
    // the distance on top, the street, "then" or the lanes under it; alone: in the middle
    const under = !!(road || nL || thLine);
    let dEnd = x;
    // (with two street lines the distance sits a little higher)
    const two = roadLines.length > 1, dy = under ? (two ? 29 : 32) : 50;
    if (dist) {
        const dw = cv.text(dist, x, dy, DIST, col, DOPTS);
        dEnd = x + dw + 4 + cv.text(unit, x + dw + 4, dy, UNIT, col, UOPTS);
    }
    if (two) roadLines.forEach((l, i) => cv.text(l, x, (dist ? 50 : 36) + i * 17, ROAD2, withAlpha(col, 0.85), ROPTS));
    else if (road) cv.text(road, x, dist ? 60 : 46, roadSize, withAlpha(col, 0.85), ROPTS);
    if (thLine) {
        const y = dist ? 60 : 46, tx = x + cv.text('then', x, y, THEN_T, withAlpha(col, 0.85), ROPTS) + 4;
        drawArrow(cv, th, tx + THEN_A / 2, y - 7, THEN_S, col, dim);
        if (thGap) cv.text(thGap, tx + THEN_A + 4, y, THEN_T, withAlpha(col, 0.85), ROPTS);
        out.then = { x: tx, w: THEN_A };
    } else if (th && nL) {
        drawArrow(cv, th, dEnd + 4 + THEN_A / 2, 20, THEN_S, col, dim);
        out.then = { x: dEnd + 4, w: THEN_A };
    }
    if (nL) { drawLanes(cv, m.lanes, x, dist ? 57 : NH / 2, lw, col, dim); out.lanes = { x: x, w: lw }; }
    return out;
}

/** Everything the picture depends on (the same key: the same picture). */
function navKey(m, opts) {
    if (!m) return '';
    const L = m.lanes ? m.lanes.lanes.map((l) => (l.hi ? '*' : '') + (l.follows || [l.follow]).join('+') + '/' + l.others.join('+') + '/' + l.info).join(',') + '|' + (m.lanes.markers || []).join(',') + '|' + m.lanes.rec : '';
    const T = m.then ? [m.then.kind, m.then.dir, m.then.geom, m.then.exit, m.then.exitAngle, m.then.side, m.then.flag, m.then.stop, gapText(m.then.gap, m.unit, m.uk)].join('/') : '';
    return [m.kind, m.dir, m.geom, m.exit, m.exitAngle, m.side, m.flag, m.stop, m.dist, m.unit, m.road, L, T, opts && opts.palette].join('|');
}

/** TurnDirection's names (the car's catalog, navigation.GuidingTypes): a lane glyph is drawn only for these. */
const TURN_DIRECTIONS = ['STRAIGHT_ON', 'SLIGHT_LEFT', 'LEFT', 'HARD_LEFT', 'UTURN_LEFT', 'SLIGHT_RIGHT', 'RIGHT', 'HARD_RIGHT', 'UTURN_RIGHT', 'NONE'];
/** The test pattern's sample: straight on with three lanes. (Every arrow the car can ask for: kit/tools/redline_nav_cases.js.) */
const SAMPLE = { kind: 'turn', dir: 'STRAIGHT_ON', dist: '700', unit: 'm', road: 'Example Road',
        lanes: { lanes: [{ follow: 'STRAIGHT_ON', others: [], hi: true, info: 'NONE' }, { follow: 'STRAIGHT_ON', others: [], hi: true, info: 'NONE' }, { follow: 'NONE', others: ['RIGHT'], hi: false, info: 'NONE' }], rec: 1, markers: ['SOLID', 'DASHED', 'DASHED', 'SOLID'] } };

module.exports = { wrap, gapText, roundaboutPlan, roundaboutGeom, laneWindow, HEAD_RUN, drawLaneArrows, drawNav, drawArrow, navKey, foldText, shapeOf, exitAngleOf, SAMPLE, NW, NH, TURN_DIRECTIONS };
