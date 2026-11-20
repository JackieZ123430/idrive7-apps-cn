'use strict';
// Redline's own directions on the HUD, the drawing side: hud-nav.js's picture (arrows, distance, street, lanes) and
// hud.js's directions layer against a stand-in cluster-render and a stand-in nav.js. Node 8 compatible.
//   node kit/tools/test_redline_hud_nav.js
const fs = require('fs');
const path = require('path');
const TH = require('./redline_test_harness');
const { TMP, SHM } = TH.claimsDir('redline-hudnav-');
const ROOT = TH.ROOT;

let cr = null;
TH.hookKit({ clusterRender: TH.fakeClusterRender({ set: 'merge', onCreate: (c) => { cr = c; } }) });
const Hud = require(path.join(ROOT, 'apps', 'redline', 'hud'));
const N = require(path.join(ROOT, 'apps', 'redline', 'hud-nav'));
// every arrow the car can ask for, and sample turns (test-only, not in the app)
const C = require(path.join(__dirname, 'redline_nav_cases'));
const { Canvas } = require(path.join(ROOT, 'kit', 'runtime', 'canvas'));
const def = TH.redlineDefaults().def;

const tally = TH.counter(), ok = tally.ok, sleep = TH.sleep;

// ---- the picture ---------------------------------------------------------------------------------------------------
const draw = (m, palette) => { const c = new Canvas(N.NW, N.NH); N.drawNav(c, m, { palette: palette || 'colour' }); return c; };
/** Lit pixels in x0..x1: { n, cx } (count, mean x), and how many are bright white (the arrows and text in 'colour'). */
function lit(c, x0, x1, y0, y1) {
    let n = 0, sx = 0, white = 0;
    for (let y = y0 || 0; y < (y1 || c.h); y++) for (let x = Math.max(0, x0); x < Math.min(c.w, x1); x++) {
        const i = (y * c.w + x) * 4;
        if (c.d[i + 3] > 128) { n++; sx += x; }
        if (c.d[i + 3] > 200 && c.d[i] > 200 && c.d[i + 1] > 200 && c.d[i + 2] > 200) white++;
    }
    return { n: n, cx: n ? sx / n : 0, white: white };
}
ok(N.NW === 200 && N.NH === 76, 'a small picture: 200x76');
ok(lit(draw(null), 0, N.NW).n === 0, 'nothing to show: an empty (see-through) picture');
Object.keys(C.SAMPLES).forEach((k) => {
    let c = null;
    try { c = draw(C.SAMPLES[k]); } catch (e) { ok(false, k + ' draws: ' + e); return; }
    const all = lit(c, 0, N.NW);
    ok(all.n > 200 && all.white > 150, k + ': drawn in white (' + all.n + ' px, ' + all.white + ' white)');
    let r = N.NW - 1; while (r > 0 && lit(c, r, r + 1).n === 0) r--;
    ok(r <= N.NW - 1, k + ': inside the picture (last column ' + r + ')');
});
// the arrows are thick: a straight arrow's shaft is about 11 px wide
{
    const a = new Canvas(N.NW, N.NH), b = N.drawNav(a, { kind: 'turn', dir: 'STRAIGHT_ON', dist: '100', unit: 'm' }, { palette: 'colour' });
    let w = 0; for (let x = b.x; x < b.x + 68; x++) if (a.d[(60 * N.NW + x) * 4 + 3] > 128) w++;
    ok(w >= 10 && w <= 13, 'thick arrows: the shaft is ' + w + ' px wide');
}
// the arrow box (68 px) from where drawNav says it drew it
const arrowBox = (m) => { const c = new Canvas(N.NW, N.NH), b = N.drawNav(c, m, { palette: 'colour' }); return { c: c, x0: b.x }; };
const side = (m) => { const a = arrowBox(m); return lit(a.c, a.x0, a.x0 + 68).cx - (a.x0 + 34); };
// (hard turns: their stem stands on the other side; where they point is checked below)
['SLIGHT_LEFT'].forEach((d) => ok(side({ kind: 'turn', dir: d, dist: '100', unit: 'm' }) < -3, d + ': the arrow leans left (' + side({ kind: 'turn', dir: d, dist: '100', unit: 'm' }).toFixed(1) + ')'));
['SLIGHT_RIGHT'].forEach((d) => ok(side({ kind: 'turn', dir: d, dist: '100', unit: 'm' }) > 3, d + ': the arrow leans right'));
// a plain turn: its stem stands a little to the other side, its long arm reaches out to the turn's side (2026-11-10 drive)
{
    const reach = (d) => { const a = arrowBox({ kind: 'turn', dir: d, dist: '100', unit: 'm' }); return { l: lit(a.c, a.x0, a.x0 + 14).white, r: lit(a.c, a.x0 + 54, a.x0 + 68).white }; };
    const L = reach('LEFT'), R = reach('RIGHT');
    ok(L.l > 60 && L.r === 0, 'LEFT: the arm reaches out to the left (' + L.l + ' / ' + L.r + ')');
    ok(R.r > 60 && R.l === 0, 'RIGHT: the arm reaches out to the right (' + R.l + ' / ' + R.r + ')');
    const s = N.shapeOf({ kind: 'turn', dir: 'RIGHT' }).path, arm = s[2][0] - s[1][0];
    ok(arm >= 44, 'a plain turn arm is long (' + arm + ')');
}
ok(Math.abs(side({ kind: 'turn', dir: 'STRAIGHT_ON', dist: '100', unit: 'm' })) < 2, 'straight on: centred');
ok(side({ kind: 'branch', dir: 'BRANCH_LEFT', dist: '1', unit: 'km' }) < -3 && side({ kind: 'branch', dir: 'HIGHWAY_OUT_RIGHT', dist: '1', unit: 'km' }) > 3, 'exits lean to their side');
// the roundabout seen on the drive (left-hand traffic, driveDirection LEFT): exit 1 at 307, i.e. 53 degrees left
// of straight on (the car's angle is clockwise from straight on): out to the upper LEFT, as a first exit is there
{
    const a = arrowBox(C.SAMPLES.roundabout), cx = a.x0 + 34;
    const ur = lit(a.c, cx + 12, cx + 34, 0, 26).white, ul = lit(a.c, cx - 34, cx - 12, 0, 26).white;
    ok(ul > 20 && ur < 5, 'roundabout exit 1 at 307: the exit goes out upper left (' + ul + ' / ' + ur + ')');
    const b = arrowBox(C.SAMPLES.roundabout3), bx = b.x0 + 34;
    ok(lit(b.c, bx + 14, bx + 34, 18, 46).white > 20, 'roundabout exit 3 at 90 (clockwise): out to the right');
    // the car's clockwise angle as an anticlockwise one for drawing; without one, from the number (left traffic: left first)
    ok(N.exitAngleOf({ exitAngle: 307, side: 'left' }) === 53 && N.exitAngleOf({ exitAngle: 90, side: 'left' }) === 270, 'the car\'s angle: clockwise from straight on');
    ok(N.exitAngleOf({ exit: 1, side: 'left' }) === 90 && N.exitAngleOf({ exit: 3, side: 'left' }) === 270 && N.exitAngleOf({ exit: 1, side: 'right' }) === 270, 'no angle from the car: from the exit\'s number');
}
// lanes: under the distance, in the street's place; the highlighted lanes' arrows bright, the rest dim
{
    const c = new Canvas(N.NW, N.NH), b = N.drawNav(c, C.SAMPLES.lanes, { palette: 'colour' }), L = b.lanes;
    ok(L && L.w >= 18, 'lanes drawn (' + JSON.stringify(L) + ')');
    const cell = (i) => lit(c, Math.round(L.x + i * L.w + 3), Math.round(L.x + (i + 1) * L.w - 3), 42, 76);
    ok(cell(0).white > 15 && cell(1).white > 15, 'lanes 1 and 2 (straight on, highlighted): bright (' + cell(0).white + ', ' + cell(1).white + ')');
    ok(cell(2).white === 0 && cell(2).n > 5, 'lane 3 (right, not for this route): dim (' + cell(2).white + ' white, ' + cell(2).n + ' lit)');
    // eight lanes still fit
    // the arrow stays put while the distance counts down (it jumped as 800 m became 50 m: 2026-11-09 review)
    const boxAt = (dist, unit) => N.drawNav(new Canvas(N.NW, N.NH), { kind: 'turn', dir: 'LEFT', dist: dist, unit: unit, road: '' }, { palette: 'colour' }).x;
    const xs = [['800', 'm'], ['450', 'm'], ['50', 'm'], ['5', 'm'], ['1.2', 'km'], ['1', 'km'], ['0.3', 'mi'], ['900', 'ft']].map((d) => boxAt(d[0], d[1]));
    ok(xs.every((x) => x === xs[0]), 'the arrow stays put as the distance changes (' + xs.join(',') + ')');
    const many = Object.assign({}, C.SAMPLES.lanes, { lanes: { lanes: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ follow: i === 3 ? 'STRAIGHT_ON' : 'NONE', others: i === 3 ? [] : ['STRAIGHT_ON'], hi: i === 3, info: 'NONE' })), rec: 3, markers: [] } });
    const c8 = new Canvas(N.NW, N.NH), b8 = N.drawNav(c8, many, { palette: 'colour' });
    ok(b8.x >= 0 && b8.lanes.w >= 20 && b8.lanes.x + 6 * b8.lanes.w <= N.NW, 'eight lanes: six shown, full size (cells ' + b8.lanes.w.toFixed(1) + ' px)');
    const win = N.laneWindow(many.lanes);
    ok(win.lanes.length === 6 && win.lanes.some((l) => l.hi), 'the six round the lane to take');
    const edge = N.laneWindow({ lanes: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ follow: 'STRAIGHT_ON', follows: ['STRAIGHT_ON'], others: [], hi: i === 7, info: 'NONE' })), markers: [] });
    ok(edge.lanes[5].hi, 'the lane to take at the far edge: still shown');
}
ok(lit(draw(Object.assign({}, C.SAMPLES.left, { dist: null, unit: null, road: '' })), 0, N.NW).n > 200, 'a turn with no distance: the arrow alone');
// a long street is cut to fit; the arrow stays whole
{
    const m = Object.assign({}, C.SAMPLES.left, { road: 'A very long street name that would never fit on the head-up display at all' });
    const c = new Canvas(N.NW, N.NH), b = N.drawNav(c, m, { palette: 'colour' });
    ok(b.x >= 0 && lit(c, 0, b.x).n === 0, 'a long street is cut, the arrow stays in the picture (at ' + b.x + ')');
}
// text
ok(N.foldText('Example Straße') === 'Example Strasse' && N.foldText('Café Élysée') === 'Cafe Elysee' && N.foldText('Øster­gade') === 'Ostergade', 'street names folded to the HUD\'s fonts (' + N.foldText('Øster­gade') + ')');
// another script in it: no fragments ("ul. Lenina 5" came out ". 5"), no name; control characters and odd spaces cleaned
ok(N.foldText('ул. Ленина 5') === '' && N.foldText('国道1号 Route 1') === '' && N.foldText('רחוב 12') === '', 'a name in another script: left out, not fragments');
ok(N.foldText('King\u0007 St\u001b[31m') === 'King St[31m' && N.foldText('King St') === 'King St' && N.foldText('King​St') === 'KingSt', 'control characters out, odd spaces plain (' + N.foldText('King St') + ')');
// 2026-11-11 (photos): a long street line wraps onto a second line, a size smaller, instead of being cut with ...
{
    const wc = new Canvas(N.NW, N.NH), o = { font: 'label', literal: true };
    const L = N.wrap(wc, 'On your left: 32 Example Street', 15, 124, o, 2);
    ok(L.length === 2 && L.join(' ') === 'On your left: 32 Example Street' && L.every((l) => wc.textWidth(l, 15, o) <= 124), 'wrap: two whole lines, nothing lost (' + JSON.stringify(L) + ')');
    const LL = N.wrap(wc, 'Continue on the Western Distributor towards the Sydney Harbour Bridge', 15, 124, o, 2);
    ok(LL.length === 2 && /…$/.test(LL[1]) && !/…/.test(LL[0]) && LL.every((l) => wc.textWidth(l, 15, o) <= 124), 'wrap: too long for two lines: the second ends with ... (' + JSON.stringify(LL) + ')');
    ok(N.wrap(wc, 'High St', 15, 124, o, 2).join('|') === 'High St' && N.wrap(wc, '', 15, 124, o, 2).length === 0, 'wrap: short and empty');
    const inkRight = (m) => { const c = new Canvas(N.NW, N.NH); N.drawNav(c, m, { palette: 'colour' }); let mx = -1; for (let y = 0; y < N.NH; y++) for (let x = 0; x < N.NW; x++) if (c.d[(y * N.NW + x) * 4 + 3] > 40) mx = Math.max(mx, x); return { mx: mx, c: c }; };
    const rows = (c, x0) => { const r = []; for (let y = 0; y < N.NH; y++) { let on = false; for (let x = x0; x < N.NW; x++) if (c.d[(y * N.NW + x) * 4 + 3] > 40) on = true; r.push(on); } return r; };
    const long = inkRight({ kind: 'destination', dir: 'LEFT', side: 'left', flag: true, dist: '60', unit: 'm', road: 'On your left: 32 Example Street' });
    const r = rows(long.c, 120), runs = r.reduce((a, v, k) => a + (v && !r[k - 1] ? 1 : 0), 0);
    ok(long.mx <= N.NW - 1 && runs >= 3, 'a long street: inside the picture, the distance and two text lines (' + runs + ' rows of text)');
    ok(inkRight({ kind: 'turn', dir: 'STRAIGHT_ON', dist: '5', unit: 'm', road: 'Proceed to the route' }).mx <= N.NW - 2, 'one line that fits only smaller: drawn smaller, inside the picture');
}
ok(N.navKey(C.SAMPLES.left, {}) !== N.navKey(Object.assign({}, C.SAMPLES.left, { dist: '400' }), {}) && N.navKey(C.SAMPLES.left, {}) === N.navKey(Object.assign({}, C.SAMPLES.left), {}), 'the key changes with the distance, not otherwise');
ok(N.navKey(C.SAMPLES.left, { palette: 'amber' }) !== N.navKey(C.SAMPLES.left, { palette: 'colour' }), 'the key changes with the palette');
ok(lit(draw(C.SAMPLES.left, 'amber'), 0, N.NW).white === 0 && lit(draw(C.SAMPLES.left, 'amber'), 0, N.NW).n > 300, 'Night amber: in amber, not white');

// ---- every arrow the car's catalog can ask for ---------------------------------------------------------------------
{
    // the lists are the catalog's (reference/ is git-ignored: CI skips this cross-check)
    const CAT = path.join(ROOT, 'reference', 'someip-interfaces.json');
    if (fs.existsSync(CAT)) {
        const D = JSON.parse(fs.readFileSync(CAT, 'utf8')).datatypes, T = (n) => Object.keys(D['de.bmw.infotainment.navigation.GuidingTypes.' + n].items).sort();
        ok(JSON.stringify(T('TurnDirection')) === JSON.stringify(N.TURN_DIRECTIONS.slice().sort()), 'every TurnDirection in the catalog has an arrow');
        ok(JSON.stringify(T('BranchType')) === JSON.stringify(C.BRANCH_TYPES.slice().sort()), 'every BranchType in the catalog has an arrow');
        ok(JSON.stringify(T('ManeuverGeometry')) === JSON.stringify(C.GEOMETRIES.slice().sort()), 'every ManeuverGeometry in the catalog has an arrow');
    } else console.log('(the car\'s catalog is not here: its cross-check skipped)');
    ok(C.ALL_ARROWS.length >= 75, 'the arrows to check: ' + C.ALL_ARROWS.length);
    // each one draws, inside its 80 px box (at 1.0, centred in 100x100)
    C.ALL_ARROWS.forEach((m) => {
        const c = new Canvas(100, 100);
        N.drawArrow(c, m, 50, 50, 1, '#ffffff', [255, 255, 255, 89]);
        const all = lit(c, 0, 100), edge = lit(c, 0, 100, 0, 6).n + lit(c, 0, 100, 94, 100).n + lit(c, 0, 6).n + lit(c, 94, 100).n;
        ok(all.white > 150 && edge === 0, m.label + ': drawn, inside its box (' + all.white + ' px, ' + edge + ' outside)');
    });
    // where the bright path ends: left values left, right right, straight in the middle
    // where the arrow goes, sideways: its end against its start (a merge starts on one side and ends near the middle)
    const endX = (m) => { const s = N.shapeOf(m); return (s.path[s.path.length - 1][0] - s.path[0][0]) * s.mir; };
    const want = (name) => (/TAKE_(LEFT|RIGHT|CENTER)$/.test(name) ? null : /LEFT/.test(name) ? -1 : /RIGHT/.test(name) ? 1 : 0);
    N.TURN_DIRECTIONS.filter((d) => d !== 'NONE').concat(C.BRANCH_TYPES).forEach((d) => {
        const m = { kind: N.TURN_DIRECTIONS.indexOf(d) >= 0 ? 'turn' : 'branch', dir: d }, x = endX(m), w = want(d);
        ok(w === 0 ? Math.abs(x) < 1 : x * w > 3, d + ': the arrow ends ' + (w < 0 ? 'left' : w > 0 ? 'right' : 'straight on') + ' (' + x.toFixed(1) + ')');
    });
    C.GEOMETRIES.forEach((g) => {
        const r = /^EXIT_(LEFT|RIGHT)_TAKE_(LEFT|RIGHT)$/.exec(g), f = /^EXIT_(LEFT|RIGHT)_TWO_WAY/.exec(g);
        // an exit taken: its side; not taken: straight on; an exit's fork: the exit's side; a fork: the leg taken
        const w = r ? (r[1] === r[2] ? (r[1] === 'LEFT' ? -1 : 1) : 0) : f ? (f[1] === 'LEFT' ? -1 : 1) : /TAKE_LEFT$/.test(g) ? -1 : /TAKE_RIGHT$/.test(g) ? 1 : 0;
        const x = endX({ kind: 'branch', dir: 'NONE', geom: g });
        ok(w === 0 ? Math.abs(x) < 1 : x * w > 3, g + ': the arrow ends on the right side (' + x.toFixed(1) + ')');
    });
    // the head sits on a straight run (a bend under its base bulged out on one side: that side looked smaller)
    C.ALL_ARROWS.forEach((m) => {
        const s = N.shapeOf(m);
        if (!s.path) return;
        const p = s.path, a = p[p.length - 2], b = p[p.length - 1], l = Math.sqrt((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]));
        ok(l >= N.HEAD_RUN, m.label + ': the head on a straight run of ' + l.toFixed(1) + ' (at least ' + N.HEAD_RUN + ')');
    });
    // U-turns and hard turns point back down
    ['UTURN_LEFT', 'UTURN_RIGHT', 'HARD_LEFT', 'HARD_RIGHT'].forEach((d) => {
        const s = N.shapeOf({ kind: 'turn', dir: d }), p = s.path, a = p[p.length - 2], b = p[p.length - 1];
        ok(b[1] > a[1], d + ': the head points back down');
    });
    // left and right are mirror images, pixel for pixel, at the HUD's own size (no head bigger on one side)
    const mirrorDiff = (m1, m2) => {
        const a = new Canvas(N.NW, N.NH), b = new Canvas(N.NW, N.NH);
        N.drawArrow(a, m1, 100, 38, 0.85, '#ffffff', [255, 255, 255, 89]); N.drawArrow(b, m2, 100, 38, 0.85, '#ffffff', [255, 255, 255, 89]);
        let d = 0;
        for (let y = 0; y < N.NH; y++) for (let x = 0; x < N.NW; x++) if (Math.abs(a.d[(y * N.NW + x) * 4 + 3] - b.d[(y * N.NW + (199 - x)) * 4 + 3]) > 8) d++;
        return d;
    };
    const pairs = [];
    C.ALL_ARROWS.forEach((m) => {
        if (m.kind === 'roundabout' || m.kind === 'destination' || m.kind === 'transport') return;
        const key = m.geom || m.dir, other = key.replace(/LEFT/g, '\u0001').replace(/RIGHT/g, 'LEFT').replace(/\u0001/g, 'RIGHT');
        if (other !== key && /LEFT/.test(key.split('_').pop() + key)) pairs.push([m, Object.assign({}, m, m.geom ? { geom: other } : { dir: other })]);
    });
    pairs.forEach((p) => { const d = mirrorDiff(p[0], p[1]); ok(d === 0, (p[0].geom || p[0].dir) + ' mirrors ' + (p[1].geom || p[1].dir) + ' exactly (' + d + ' px differ)'); });
    ok(pairs.length >= 20, pairs.length + ' left / right pairs checked');
    // every roundabout exit (the car's angle: clockwise from straight on), both traffic sides, every 15 degrees
    for (let a = 0; a < 360; a += 15) ['left', 'right'].forEach((sd) => {
        const m = { kind: 'roundabout', exit: 1, exitAngle: a, side: sd }, P = N.roundaboutPlan(m), c = new Canvas(100, 100);
        N.drawArrow(c, m, 50, 50, 1, '#ffffff', [255, 255, 255, 89]);
        const tag = 'roundabout exit at ' + a + ' (' + sd + '-hand traffic)';
        if (P.back) {
            // back the way it came: in on the traffic side, out straight down on the other, two strokes with a gap
            const inX = sd === 'left' ? -1 : 1;
            const win = (x0, x1, y0, y1) => lit(c, Math.min(x0, x1), Math.max(x0, x1), y0, y1);
            const inS = win(50 + inX * 6, 50 + inX * 16, 70, 92), outS = win(50 - inX * 6, 50 - inX * 16, 70, 92), gap = win(48, 53, 68, 76);
            ok(inS.white > 20 && outS.white > 20 && gap.white === 0, tag + ': in and back out side by side, apart (' + inS.white + ', ' + outS.white + ', gap ' + gap.white + ')');
            return;
        }
        // the head where the plan says the exit leaves (drawing angle: anticlockwise from straight on)
        const G = N.roundaboutGeom(m), gx = G.tip[0] - G.c[0], gy = G.tip[1] - G.c[1], gl = Math.sqrt(gx * gx + gy * gy);
        const tx = Math.round(50 + G.tip[0] - gx / gl * 5), ty = Math.round(50 + G.tip[1] - gy / gl * 5);
        ok(Math.abs(G.tip[0]) <= 38.5 && Math.abs(G.tip[1]) <= 38.5, tag + ': the tip inside the box (' + G.tip.map((v) => v.toFixed(1)).join(', ') + ')');
        const near = lit(c, tx - 7, tx + 8, Math.max(0, ty - 7), Math.min(100, ty + 8)).white;
        ok(near > 15, tag + ': the head out there (' + near + ' px)');
        // the exit drawn within 30 degrees of the car's angle (a sharp first exit is pushed out at most that far)
        const want = (360 - a) % 360, got = ((180 + P.dir * P.tOut) % 360 + 360) % 360, off = Math.min(Math.abs(want - got), 360 - Math.abs(want - got));
        ok(off <= 30, tag + ': drawn ' + off + ' degrees from the car\'s angle');
    });
    // the way in and the way out's shaft stick out past the ring the same (2026-11-10 drive)
    [0, 90, 270, 307].forEach((a) => {
        const G = N.roundaboutGeom({ exitAngle: a, side: 'left' }), O = G.R + 4, IN = G.path[1], dx = IN[0] - G.c[0];
        const seenIn = G.path[0][1] + 4.5 - (G.c[1] + Math.sqrt(O * O - dx * dx));
        const seenOut = Math.sqrt(Math.pow(G.tip[0] - G.c[0], 2) + Math.pow(G.tip[1] - G.c[1], 2)) - 12 - O;
        ok(Math.abs(seenIn - seenOut) < 0.5, 'roundabout exit at ' + a + ': in and out stick out alike (' + seenIn.toFixed(1) + ' / ' + seenOut.toFixed(1) + ')');
    });
    // a sharp first exit (left traffic: back to the left, e.g. 210) goes a short way round, not a lap (2026-11-09 review)
    [195, 210, 225].forEach((a) => { const P = N.roundaboutPlan({ exitAngle: a, side: 'left' }); ok(!P.back && P.tOut - P.tIn <= 90, 'left traffic, exit at ' + a + ': a short way round (' + (P.tOut - P.tIn) + ' degrees)'); });
    [165, 150, 135].forEach((a) => { const P = N.roundaboutPlan({ exitAngle: a, side: 'right' }); ok(!P.back && P.tOut - P.tIn <= 90, 'right traffic, exit at ' + a + ': a short way round (' + (P.tOut - P.tIn) + ' degrees)'); });
    // straight back (180) and just short of it on the far side: the U-turn
    ok(N.roundaboutPlan({ exitAngle: 180, side: 'left' }).back && N.roundaboutPlan({ exitAngle: 165, side: 'left' }).back, 'left traffic, 180 and 165: the U-turn');
}

// ---- from the 2026-11-09 data review --------------------------------------------------------------------------------
{
    const endSide = (m) => { const s = N.shapeOf(m); return Math.sign((s.path[s.path.length - 1][0] - s.path[0][0]) * s.mir); };
    // a junction shape that contradicts the direction: the direction wins
    ok(endSide({ kind: 'turn', dir: 'LEFT', geom: 'EXIT_RIGHT_TAKE_RIGHT' }) === -1, 'LEFT with a right exit shape: drawn left');
    ok(endSide({ kind: 'branch', dir: 'BRANCH_RIGHT', geom: 'TWO_WAY_FORK_TAKE_LEFT' }) === 1, 'BRANCH_RIGHT with a left fork shape: drawn right');
    ok(N.shapeOf({ kind: 'branch', dir: 'BRANCH_RIGHT', geom: 'TWO_WAY_FORK_TAKE_RIGHT' }).dim.length === 1, 'an agreeing shape is used (the fork, its other leg dim)');
    // wide roads: the lanes to take always in the window; cut edges marked
    const L9 = (his, rec) => ({ lanes: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ follow: his.indexOf(i) >= 0 ? 'STRAIGHT_ON' : 'NONE', follows: his.indexOf(i) >= 0 ? ['STRAIGHT_ON'] : [], others: his.indexOf(i) >= 0 ? [] : ['STRAIGHT_ON'], hi: his.indexOf(i) >= 0, info: 'NONE' })), rec: rec, markers: [] });
    ok(N.laneWindow(L9([1, 8], 8)).lanes.some((l) => l.hi), '9 lanes, the lanes to take 1 and 8: one of them shown (round the recommended)');
    ok(N.laneWindow(L9([1, 8], null)).lanes.some((l) => l.hi), '... and with no recommended lane');
    const w = N.laneWindow(L9([4], 4));
    ok(w.cutL && w.cutR, 'lanes cut off on both sides: marked');
    // the picture key: the recommended lane decides the window when none is highlighted
    const k = (rec) => N.navKey({ kind: 'turn', dir: 'LEFT', dist: '1', unit: 'km', road: '', lanes: L9([], rec) }, {});
    ok(k(0) !== k(7), 'the key changes with the recommended lane');
    ok(N.navKey({ kind: 'turn', dir: 'LEFT', then: { kind: 'destination', dir: 'LEFT', flag: false, stop: 1, gap: null } }, {}) !==
        N.navKey({ kind: 'turn', dir: 'LEFT', then: { kind: 'destination', dir: 'LEFT', flag: false, stop: 2, gap: null } }, {}), 'and with the "then" stopover\'s number');
    // the "then" gap in the next turn's units: UK in yards, US in feet, metric in metres
    ok(N.gapText(100, 'mi', true) === '110 yd' && N.gapText(100, 'mi', false) === '350 ft' && N.gapText(100, 'm', false) === '100 m' && N.gapText(null, 'm') === '', 'gap text: yd / ft / m (' + N.gapText(100, 'mi', true) + ')');
    // an absurd distance text is cut, its unit kept, nothing past the edge
    const c = new Canvas(N.NW, N.NH);
    N.drawNav(c, { kind: 'turn', dir: 'LEFT', dist: '123456789012345', unit: 'km', road: '' }, { palette: 'colour' });
    let r = N.NW - 1; while (r > 0 && lit(c, r, r + 1).n === 0) r--;
    ok(r < N.NW - 1, 'a very long distance text: cut, inside the picture (last column ' + r + ')');
}

// ---- lanes: their own glyphs, one stem, turns leaving low --------------------------------------------------------
{
    const W = '#ffffff', D = [89, 89, 89, 255];
    const lane = (follows, others, hi, info) => ({ follow: follows[0] || 'NONE', follows: follows, others: others || [], hi: hi !== false, info: info || 'NONE' });
    /** One lane cell at HUD size (22x36, the glyph at 11, 18); bright / dim pixel boxes. */
    const cellOf = (l) => {
        const c = new Canvas(22, 36);
        N.drawLaneArrows(c, l, 11, 18, 1, W, D);
        const box = (pred) => { let x0 = 99, x1 = -1, y0 = 99, y1 = -1, n = 0; for (let y = 0; y < 36; y++) for (let x = 0; x < 22; x++) { const i = (y * 22 + x) * 4; if (c.d[i + 3] > 128 && pred(c.d[i])) { n++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } } return { n: n, x0: x0, x1: x1, y0: y0, y1: y1 }; };
        return { c: c, bright: box((r) => r > 200), dim: box((r) => r > 40 && r < 140), any: box(() => true) };
    };
    // each direction alone: inside its 22 px cell (the lines between lanes at its edges), not cut at top or bottom
    N.TURN_DIRECTIONS.filter((d) => d !== 'NONE').forEach((d) => {
        const b = cellOf(lane([d])).any;
        ok(b.n > 20 && b.x0 >= 1 && b.x1 <= 20 && b.y0 >= 1 && b.y1 <= 34, 'lane ' + d + ': inside its cell (x ' + b.x0 + '..' + b.x1 + ', y ' + b.y0 + '..' + b.y1 + ')');
    });
    // straight and right (the review's case): the straight head at the top, the turn's arm low, well apart
    const sr = cellOf(lane(['RIGHT'], ['STRAIGHT_ON']));
    ok(sr.dim.y0 <= 4 && sr.bright.x1 >= 17, 'straight on (dim) to the top, the right turn (bright) out to the side');
    let armTop = 99;
    for (let y = 0; y < 36; y++) for (let x = 15; x < 22; x++) { const i = (y * 22 + x) * 4; if (sr.c.d[i + 3] > 128 && sr.c.d[i] > 200) armTop = Math.min(armTop, y); }
    ok(armTop - sr.dim.y0 >= 12, 'the right turn\'s head well below the straight one\'s (' + armTop + ' against ' + sr.dim.y0 + ')');
    // right and U-turn (the drive's lane): apart, but for the stem they share
    const solo = (d) => { const c = new Canvas(22, 36); N.drawLaneArrows(c, lane([d]), 11, 18, 1, W, D); return c; };
    const r1 = solo('RIGHT'), u1 = solo('UTURN_RIGHT');
    let both = 0;
    for (let y = 0; y < 36; y++) for (let x = 0; x < 22; x++) { if (Math.abs(x - 11) <= 3) continue; const i = (y * 22 + x) * 4; if (r1.d[i + 3] > 128 && u1.d[i + 3] > 128) both++; }
    ok(both === 0, 'right turn and U-turn in one lane: apart but for their stem (' + both + ' px overlap)');
    // thinner than the big arrows: the stem about 3-4 px at the HUD's size
    let stem = 0;
    for (let x = 0; x < 22; x++) if (solo('STRAIGHT_ON').d[(28 * 22 + x) * 4 + 3] > 128) stem++;
    ok(stem >= 3 && stem <= 4, 'lane strokes thin: the stem ' + stem + ' px');
    // several arrows to take (directionsToFollow): all bright
    const two = cellOf(lane(['STRAIGHT_ON', 'RIGHT']));
    ok(two.bright.y0 <= 4 && two.bright.x1 >= 17 && two.dim.n === 0, 'straight on and right both to take: both bright');
    // a lane not for this route: dim only; blocked: a cross; more lanes than shown: three dots
    ok(cellOf(lane([], ['RIGHT'], false)).bright.n === 0, 'a lane not for this route: dim');
    const bl = cellOf(lane(['STRAIGHT_ON'], [], true, 'BLOCKED'));
    ok(bl.bright.n === 0 && bl.dim.n > 25, 'a blocked lane: its arrow and the cross over it both dim (not the brightest thing in the row)');
    ok(cellOf(lane([], [], false, 'ELLIPSIS')).any.n > 6 && cellOf(lane([], [], false, 'ELLIPSIS')).bright.n === 0, 'more lanes than shown: dim dots');
}

// ---- the layer in hud.js -------------------------------------------------------------------------------------------
// ---- iDrive 8's HUD (cluster-render's hello: hud:353x203, all of it shown): the tach and directions inside it ----
{
    const st = (v) => ({ get: (k) => v[k] });
    const id7 = Hud.placeOf(st({}));
    ok(!Hud.useScene('map:1088x480,panel:1920x720,hud:800x480') && Hud.scene().w === 800, 'iDrive 7\'s hello keeps the 800x480 scene');
    ok(Hud.useScene('map:874x749,hud:353x203,guide:702x213,widget:2240x896,popup:2240x896'), 'iDrive 8\'s hello changes the scene');
    const S = Hud.scene(), inS = (r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= S.w && r.y + r.h <= S.h;
    ok(S.w === 353 && S.h === 203, 'iDrive 8 scene 353x203 (' + S.w + 'x' + S.h + ')');
    const d = Hud.placeOf(st({}));
    ok(d.w === 353 && Math.abs(d.y + d.h / 2 - S.h / 2) <= 1, 'at 100 %: the tach as wide as the HUD, centred (' + JSON.stringify(d) + ')');
    ok(!Object.keys(Hud.outsideGlass(d)).length, 'at 100 %: all of it seen');
    let out = 0, n = 0;
    [40, 70, 100, 140].forEach((sz) => [-120, 0, 280].forEach((x) => [-120, 0, 220].forEach((y) => {
        const v = st({ hudSize: sz, hudX: x, hudY: y, hudNav: 'route' }), r = Hud.placeOf(v), nv = Hud.navPlaceOf(v);
        n++; if (!inS(r) || !inS(nv)) { out++; console.log('  out of the HUD at ' + sz + '% ' + x + ',' + y + ': ' + JSON.stringify([r, nv])); }
    })));
    ok(!out, 'every Size / Position: the tach and directions inside the HUD (' + n + ' tried)');
    ok(Hud.useScene('') && Hud.scene().w === 800, 'no targets in the hello: back to iDrive 7\'s scene');
    ok(JSON.stringify(Hud.placeOf(st({}))) === JSON.stringify(id7), 'iDrive 7\'s place unchanged after');
}

(async () => {
    fs.mkdirSync(SHM);
    fs.writeFileSync(path.join(SHM, 'redline'), JSON.stringify({ held: false, at: Date.now() }) + '\n');
    const v = Object.assign({}, def, { hud: 'on', hudStyle: 'standard', hudFps: 30 }), fns = [];
    const settings = { get: (k) => v[k], set: (k, x) => { v[k] = x; fns.forEach((f) => f(k, x)); }, onChange: (f) => fns.push(f) };
    let view = { show: null, giveWay: false }, modes = [];
    const nav = { view: (mode) => { modes.push(mode); return view; } };
    const src = { data: () => ({ rpm: 2500, gear: 3, stage: 'D', speed: 50, oil: 95, coolant: 92 }), shiftPoint: () => ({ rpm: 6200, cold: false }), redline: () => 6550,
        maxRpm: () => 8000, driveMode: () => 'sport', nav: nav };
    const lines = [];
    const log = { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) };
    const h = Hud.start({ settings: settings, log: log, dataDir: TMP }, src);
    await sleep(150);
    ok(cr.images().length === 1, 'no route: the tach alone');
    ok(modes.length > 0 && modes.every((m) => m === 'route'), 'Directions default: while a route runs');

    view = { show: C.SAMPLES.left, giveWay: false };
    await sleep(150);
    const imgs = cr.images();
    ok(imgs.length === 2, 'a turn: a second image layer (' + imgs.length + ')');
    const tach = cr.layers[imgs[0]], nl = cr.layers[imgs[1]] || {};
    // the glass's bottom right corner (x 120..680, y 120..360 seen), clear of the tach and of BMW's speed at the bottom left
    ok(nl.iw === N.NW && nl.ih === N.NH && nl.w === 200 && nl.h === 76 && nl.target === 'hud' && nl.x + nl.w === 672 && nl.y + nl.h === 356, 'the directions in the bottom right corner (' + [nl.x, nl.y, nl.w, nl.h].join(',') + ')');
    ok(nl.y >= tach.y + tach.h && nl.x >= 400, 'below the tach, in the right half');
    const navFrames = () => cr.frames.filter((f) => f.ref === imgs[1]);
    ok(navFrames().length === 1 && !navFrames()[0].rects, 'sent whole once');
    await sleep(150);
    ok(navFrames().length === 1, 'the same turn: nothing sent again');
    view = { show: Object.assign({}, C.SAMPLES.left, { dist: '400' }), giveWay: false };
    await sleep(120);
    ok(navFrames().length === 2 && navFrames()[1].rects && navFrames()[1].rects.length >= 1, 'nearer: only what changed is sent');

    // their own place: the tach's size and place don't move them, their own settings do
    settings.set('hudSize', 80); settings.set('hudX', -40); await sleep(100);
    const nl2 = cr.layers[imgs[1]];
    ok(nl2 && nl2.w === 200 && nl2.x === 472 && nl2.y === 280, 'the tach at 80 % and moved: the directions stay');
    settings.set('hudNavY', -20); settings.set('hudNavX', -40); await sleep(100);
    ok(cr.layers[imgs[1]].y === 260 && cr.layers[imgs[1]].x === 432, 'Directions left / right and up / down move them');
    settings.set('hudSize', 100); settings.set('hudX', 0); settings.set('hudNavY', 0); settings.set('hudNavX', 0); await sleep(100);

    // never over or under the tach (rev bar, gear, readouts, grade, arrows: all in its picture) or BMW's speed
    const ov = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    settings.set('hudSize', 130); settings.set('hudY', 40); settings.set('hudX', 60); await sleep(120);
    const T = cr.layers[cr.images()[0]], NL = cr.layers[cr.images()[1]];
    ok(NL && ov(T, NL) === 0 && ov(NL, Hud.BMW_SPEED) === 0, 'a big, low tach reaching the corner: the directions move clear of it (' + [NL && NL.x, NL && NL.y].join(',') + ')');
    settings.set('hudSize', 100); settings.set('hudY', 0); settings.set('hudX', 0); await sleep(100);
    let clash = 0, n = 0, farOut = 0;
    [70, 80, 90, 100, 110, 120, 130].forEach((sz) => { for (let x = -120; x <= 120; x += 20) for (let y = -40; y <= 60; y += 10) {
        const vv = { hudSize: sz, hudX: x, hudY: y }, st = { get: (k) => vv[k] }, t = Hud.placeOf(st), r = Hud.navPlaceOf(st), G = Hud.GLASS;
        n++;
        if (ov(r, t) || ov(r, Hud.BMW_SPEED)) clash++;
        if (sz <= 100 && Math.max(G.x - r.x, 0) + Math.max(r.x + r.w - G.x - G.w, 0) + Math.max(G.y - r.y, 0) + Math.max(r.y + r.h - G.y - G.h, 0) > 20) farOut++;
    } });
    ok(clash === 0, 'every tach size and position the settings allow (' + n + '): the directions cover nothing (' + clash + ' clash)');
    ok(farOut === 0, 'up to 100 %: never more than 20 px past the glass (' + farOut + ')');

    // the turn goes: the layer goes
    view = { show: null, giveWay: false };
    await sleep(120);
    ok(cr.images().length === 1, 'no turn: the directions layer dropped, the tach stays');

    // a route without readable turns: Redline out of the way, BMW's card shows
    view = { show: null, giveWay: true };
    await sleep(120);
    ok(cr.images().length === 0 && h.status() === 'HUD: giving way to BMW\'s directions', 'giving way: no layers (' + h.status() + ')');
    const claim = JSON.parse(fs.readFileSync(path.join(SHM, 'redline'), 'utf8'));
    // kept: with it let go, Cluster functions' map would take the HUD instead of BMW's card (2026-11-09 review)
    ok(claim.held === true, 'giving way: the HUD claim kept, so the card from BMW shows, not another app');
    ok(!lines.some((l) => /hidden in/.test(l)), 'giving way isn\'t logged as a driving-mode hide');
    view = { show: C.SAMPLES.exit, giveWay: false };
    await sleep(150);
    ok(cr.images().length === 2, 'a turn again: the tach and the directions back');

    // the renderer fails the directions layer: dropped, made again after 5 s (not left dead for the whole route)
    const navRef = cr.images()[1];
    cr.h.layer(navRef, 'error', 'test');
    await sleep(120);
    ok(cr.images().length === 1 && lines.some((l) => /directions layer failed, made again in 5 s/.test(l)), 'a failed directions layer: dropped and logged');
    await sleep(5000);
    ok(cr.images().length === 2 && cr.images()[1] !== navRef, 'made again after 5 s');

    // paused behind BMW's content: nothing sent; after it, sent whole
    const before = cr.frames.length;
    cr.h.target('hud', 'parked', 'bmw', '', false, false);
    view = { show: C.SAMPLES.roundabout, giveWay: false };
    await sleep(120);
    ok(cr.frames.length === before, 'parked: nothing drawn');
    cr.h.target('hud', 'shown', '', '', false, false);
    await sleep(120);
    const nref = cr.images()[1];
    ok(cr.frames.filter((f) => f.ref === nref && !f.rects).length >= 1, 'shown again: the directions sent whole');

    // Directions off
    settings.set('hudNav', 'off'); await sleep(120);
    ok(modes[modes.length - 1] === 'off', 'Directions off: asked as off');
    settings.set('hudNav', 'near'); await sleep(120);
    ok(modes[modes.length - 1] === 'near', 'Near turns: asked as near');
    settings.set('hudNav', 'route');

    // the test pattern shows where they go
    settings.set('hud', 'test'); await sleep(120);
    const r = Hud.navPlaceOf(settings);
    const whiteIn = (px) => { let n = 0; for (let y = r.y + 4; y < r.y + r.h - 4; y++) for (let x = r.x + 4; x < r.x + r.w - 4; x++) { const i = (y * 800 + x) * 4; if (px[i] > 200 && px[i + 1] > 200 && px[i + 2] > 200) n++; } return n; };
    const withNav = whiteIn(cr.frames[cr.frames.length - 1].px);
    settings.set('hudNav', 'off'); await sleep(120);
    const without = whiteIn(cr.frames[cr.frames.length - 1].px);
    ok(withNav - without > 300, 'test pattern: a sample turn where the directions go (' + withNav + ' white px, ' + without + ' with Directions off)');
    settings.set('hudNav', 'route');

    // iDrive 8's hello while the test pattern shows: drawn again, at the HUD's own 353x203, with the tach inside it
    settings.set('hud', 'test'); await sleep(120);
    cr.targets = 'map:874x749,hud:353x203,guide:702x213'; cr.h.ready(); await sleep(120);
    const L8 = cr.layers[Math.max.apply(null, cr.images())], F8 = cr.frames[cr.frames.length - 1];
    ok(L8 && L8.w === 353 && L8.h === 203 && F8.px.length === 353 * 203 * 4, 'iDrive 8: the test pattern at 353x203 (' + (L8 && L8.w + 'x' + L8.h) + ', ' + F8.px.length + ' bytes)');
    const edge = (x, y) => { const i = (y * 353 + x) * 4; return F8.px[i] > 200 && F8.px[i + 1] > 200 && F8.px[i + 2] > 200; };
    ok(edge(352, 100) && edge(100, 202) && edge(0, 100) && edge(100, 0), 'iDrive 8: the pattern\'s white border on all four sides');
    ok(lines.some((l) => /hud: scene 353x203/.test(l)), 'iDrive 8: the scene logged');
    cr.targets = 'hud'; cr.h.ready(); await sleep(120);
    const L7 = cr.layers[Math.max.apply(null, cr.images())];
    ok(L7 && L7.w === 800 && L7.h === 480, 'back on iDrive 7\'s hello: the test pattern at 800x480 again');
    settings.set('hud', 'on'); await sleep(120);

    ok(!lines.some((l) => /^hud \w+: /.test(l) && /Error/.test(l)), 'no errors in the HUD\'s log (' + lines.filter((l) => /Error/.test(l)).join(' / ').slice(0, 300) + ')');
    h.stop();
    console.log(tally.checks + ' checks, ' + tally.fails + ' failed');
    process.exit(tally.fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
