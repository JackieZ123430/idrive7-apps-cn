'use strict';
/**
 * carview.js - the car as a see-through line drawing after a G20 saloon, nose up, seen from straight above or tilted
 * (a finger drags it: pitch leans the view back over the boot, roll turns it about its length to show a side), with its
 * ambient lights glowing inside at their places. The bonnet and boot are a little short, so more of the cabin shows.
 *
 *   drawCarView(cv, t, box, lights, colourOf, opts)
 *     box       { x, y, w, h }: the car fits its height, centred
 *     lights    [{ part, x, y, x2, y2, fault }] (lin.js), x 0..1 across from the driver's side, y 0..1 from the dash
 *     colourOf  (light) -> { rgb, bright } | null (null: the car's own colour, drawn dim grey)
 *     opts      { rhd (the driver on the right), pitch (0 straight above .. MAX_PITCH, degrees), roll (-MAX_ROLL .. MAX_ROLL) }
 *
 * The car in metres: x forward, y to the left, z up, the middle at 0. Lines nearer the eye are brighter.
 */
const L = 2.3, W = 0.92;
const MAX_PITCH = 55, MAX_ROLL = 40;

// the plan's half width along the car (v = x / L: 1 nose .. -1 tail): a round nose, a slim waist at the doors,
// the rear haunches a little wider, a squarer tail
const plan = (x) => {
    const v = x / L, p = v > 0 ? 3.2 : 5;
    const base = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(v), p)), 1 / p);
    return W * base * (0.95 + 0.03 * Math.exp(-Math.pow((x + 1.25) / 0.45, 2)) - 0.015 * Math.exp(-Math.pow((x - 0.1) / 0.6, 2)) + 0.02 * (v > 0.6 ? 0 : 1));
};
// the side profile: the top of the body (a short bonnet, the windscreen, the roof, the fastback rear window, a short boot)
const top = (x) => {
    if (x > 2.2) return 0.74 - (x - 2.2) * 2.2;
    if (x > 1.25) return 0.74 + 0.2 * (2.2 - x) / 0.95;
    if (x > 0.5) return 0.94 + 0.46 * Math.sin((1.25 - x) / 0.75 * Math.PI / 2);
    if (x > -0.75) return 1.4 - 0.02 * (0.5 - x) / 1.25;
    if (x > -1.65) return 1.38 - 0.4 * Math.sin((-0.75 - x) / 0.9 * Math.PI / 2);
    if (x > -2.2) return 0.98 - 0.02 * (-1.65 - x) / 0.55;
    return 0.96 - (-2.2 - x) * 2.4;
};
const belt = (x) => Math.min(top(x) - 0.01, 0.9 + 0.04 * (L - x) / (2 * L));
const inCabin = (x) => x < 1.25 && x > -1.65;
// the roof's half width (the glass's top edge), the side glass's foot, over the cabin
const roofW = (x) => plan(x) * (0.7 + 0.06 * Math.cos(((x + 0.2) / 1.45) * Math.PI / 2));

/* The section across the car at x, from the left sill over the top to the right sill: [y, z]. */
function section(x) {
    const hw = plan(x), b = belt(x), t = top(x), tw = inCabin(x) ? Math.min(hw * 0.9, roofW(x)) : hw * 0.86;
    const mid = (b + t) / 2;
    return [[hw * 0.94, 0.28], [hw, 0.5], [hw * 0.995, b], [(hw + tw) / 2 * 1.03, mid], [tw, t], [tw * 0.4, t + 0.02], [0, t + 0.025],
        [-tw * 0.4, t + 0.02], [-tw, t], [-(hw + tw) / 2 * 1.03, mid], [-hw * 0.995, b], [-hw, 0.5], [-hw * 0.94, 0.28]];
}

/** The car's lines: [[points], kind]. */
function carLines() {
    const out = [];
    const N = 36, ST = [];
    for (let i = 0; i <= N; i++) ST.push(L * Math.cos(Math.PI * i / N));        // closer together at the ends, where it curves
    const secs = ST.map((x) => section(x).map(([y, z]) => [x, y, z]));
    for (let k = 0; k < secs[0].length; k++) {
        const kind = k === 0 || k === 12 ? 'sill' : k === 2 || k === 10 ? 'body' : k === 4 || k === 8 ? 'edge' : 'mesh';
        out.push([secs.map((s) => s[k]), kind]);
    }
    secs.forEach((pts, i) => { if (i % 3 === 0 && i > 0 && i < N) out.push([pts, 'mesh']); });
    // the windows: the side glass, the windscreen's and rear window's edges, the roof panel and its sunroof
    [1, -1].forEach((s) => {
        const xs = []; for (let i = 0; i <= 30; i++) xs.push(1.2 - 2.8 * i / 30);
        out.push([xs.map((x) => [x, s * plan(x) * 0.985, belt(x) + 0.03]), 'glass']);
        out.push([[[0.42, s * roofW(0.42), top(0.42) - 0.01], [0.38, s * plan(0.38) * 0.98, belt(0.38) + 0.03]], 'glass']);   // B pillar
        out.push([[[-0.62, s * roofW(-0.62), top(-0.62) - 0.01], [-0.7, s * plan(-0.7) * 0.98, belt(-0.7) + 0.03]], 'glass']);
        // doors' cuts, door handles
        [[1.15, 0.3], [0.05, 0.3], [-1.1, 0.32]].forEach(([x, z]) => out.push([[[x, s * plan(x) * 0.95, z], [x - 0.03, s * plan(x - 0.03), belt(x - 0.03)]], 'mesh']));
        [0.55, -0.55].forEach((x) => out.push([[[x, s * plan(x) * 1.005, 0.82], [x - 0.16, s * plan(x - 0.16) * 1.005, 0.82]], 'body']));
        // mirrors at the windscreen's foot, angled forward
        out.push([[[1.15, s * plan(1.15), 0.96], [1.02, s * (plan(1.02) + 0.2), 0.98], [0.9, s * (plan(0.9) + 0.16), 0.98], [0.95, s * plan(0.95), 0.96]], 'body']);
        // the wheels' arches and tyres
        [1.45, -1.42].forEach((cx) => {
            const ring = (r, yy, a0, a1, n) => { const pts = []; for (let a = 0; a <= n; a++) { const q = a0 + (a1 - a0) * a / n; pts.push([cx + r * Math.cos(q), s * yy, 0.34 + r * Math.sin(q)]); } return pts; };
            out.push([ring(0.33, plan(cx) * 0.97, 0, Math.PI * 2, 32), 'wheel']);
            out.push([ring(0.4, plan(cx) * 1.0, 0, Math.PI, 18), 'body']);
        });
        // the headlights, angled at the nose's corners; the tail lights round the rear corners
        out.push([[[2.18, s * 0.3, 0.74], [2.08, s * plan(2.08) * 0.8, 0.76], [1.92, s * plan(1.92) * 0.97, 0.78]], 'lamp']);
        out.push([[[-2.22, s * 0.4, 0.9], [-2.16, s * plan(-2.16) * 0.92, 0.9], [-1.98, s * plan(-1.98) * 0.99, 0.88]], 'tail']);
        // the bonnet's creases
        out.push([[[1.25, s * 0.42, top(1.25)], [2.1, s * 0.3, top(2.1) + 0.01]], 'mesh']);
    });
    const ac = (x, z, k, kind) => out.push([[[x, k * plan(x), z], [x, 0, z + 0.03], [x, -k * plan(x), z]], kind]);
    ac(1.22, top(1.22) + 0.01, 0.72, 'glass'); ac(0.5, top(0.5) - 0.01, 0.68, 'glass'); ac(-0.78, top(-0.78) - 0.01, 0.7, 'glass'); ac(-1.62, top(-1.62) + 0.01, 0.76, 'glass');
    // the sunroof
    out.push([[[0.36, 0.36, 1.43], [0.36, -0.36, 1.43], [-0.32, -0.36, 1.42], [-0.32, 0.36, 1.42], [0.36, 0.36, 1.43]], 'glass']);
    // inside: the dash, the console, the front seats and the rear bench, the steering wheel on the driver's side
    const box3 = (x0, x1, y0, y1, z) => [[x0, y0, z], [x0, y1, z], [x1, y1, z], [x1, y0, z], [x0, y0, z]];
    out.push([[[1.02, 0.78, 0.9], [1.08, 0, 0.92], [1.02, -0.78, 0.9]], 'inside']);
    out.push([box3(0.95, -0.2, 0.1, -0.1, 0.62), 'inside']);
    [0.42, -0.42].forEach((y) => {
        out.push([box3(0.35, -0.2, y + 0.24, y - 0.24, 0.55), 'inside']);           // the seat
        out.push([box3(-0.2, -0.32, y + 0.23, y - 0.23, 1.05), 'inside']);          // its back, upright
    });
    out.push([box3(-0.75, -1.25, 0.72, -0.72, 0.55), 'inside']);
    out.push([box3(-1.25, -1.36, 0.7, -0.7, 1.0), 'inside']);
    { const pts = []; for (let a = 0; a <= 24; a++) { const q = a / 24 * Math.PI * 2; pts.push([0.75, 0.42 + 0.18 * Math.cos(q), 0.88 + 0.18 * Math.sin(q)]); } out.push([pts, 'inside']); }
    // the kidneys
    [1, -1].forEach((s) => out.push([[[2.27, s * 0.03, 0.7], [2.25, s * 0.2, 0.7]], 'lamp']));
    return out;
}
const LINES = carLines();

/** The view: a point -> [screen x, screen y (down), depth (larger: nearer the eye)], before fitting. */
function viewer(pitchDeg, rollDeg) {
    const p = pitchDeg * Math.PI / 180, r = rollDeg * Math.PI / 180, cp = Math.cos(p), sp = Math.sin(p), cr = Math.cos(r), sr = Math.sin(r);
    return ([x, y, z]) => {
        const y1 = y * cr - z * sr, z1 = y * sr + z * cr;           // rolled about its length
        return [-y1, -(x * cp + z1 * sp), z1 * cp - x * sp];          // leaned back over the boot
    };
}

/** The cabin's light at fx across, fy from the dash, in metres: upper ones at the dash and the doors' tops, lower ones at the floor. */
function lightPoint(fx, fy, part) {
    return [0.95 - fy * 2.15, (0.5 - fx) * 2 * W * 0.86, part === 'upper' ? (fy < 0.2 ? 0.98 : 0.92) : 0.38];
}

const glow = (rgb, bright, a) => { const f = 0.25 + 0.75 * Math.max(0, Math.min(100, bright)) / 100; return [rgb[0], rgb[1], rgb[2], Math.round(255 * a * f)]; };
const COL = { inside: [140, 148, 160], sill: [210, 216, 224], body: [236, 240, 246], edge: [236, 240, 246], mesh: [150, 158, 170], glass: [140, 182, 225], wheel: [190, 196, 204], lamp: [255, 255, 255], tail: [255, 50, 60] };
const WID = { inside: 1.2, sill: 1.6, body: 2, edge: 1.8, mesh: 1, glass: 1.6, wheel: 1.6, lamp: 3, tail: 3 };

function drawCarView(cv, t, box, lights, colourOf, opts) {
    const o = opts || {};
    const pitch = Math.max(0, Math.min(MAX_PITCH, o.pitch || 0)), roll = Math.max(-MAX_ROLL, Math.min(MAX_ROLL, o.roll || 0));
    const pr = viewer(pitch, o.rhd ? -roll : roll);
    // a scale that stays as the view turns: the car's length fits the box's height from straight above
    const k = Math.min(box.h / (2 * L * 1.04), box.w / (2 * W * 1.5)), cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    const S = (p) => { const q = pr(p); return [cx + (o.rhd ? -q[0] : q[0]) * k, cy + (q[1] + 0.55 * Math.sin(pitch * Math.PI / 180)) * k, q[2]]; };
    // its shadow on the ground, then the body's mass: the plan at the belt filled dark
    const strip = (f, z, c) => { for (let i = 0; i < 40; i++) { const xa = L - 2 * L * i / 40, xb = L - 2 * L * (i + 1) / 40; cv.quad([S([xa, f(xa), z]), S([xa, -f(xa), z]), S([xb, -f(xb), z]), S([xb, f(xb), z])].map((q) => [q[0], q[1]]), c); } };
    strip((x) => plan(x) * 1.06, 0, [0, 0, 0, 120]);
    strip(plan, 0.5, [22, 25, 30, 235]);
    // the cabin's floor a shade lighter, the seats filled, so the lights' places read against them
    const flat = (x0, x1, y0, y1, z, c) => cv.quad([S([x0, y0, z]), S([x0, y1, z]), S([x1, y1, z]), S([x1, y0, z])].map((q) => [q[0], q[1]]), c);
    flat(1.0, -1.45, plan(0) * 0.86, -plan(0) * 0.86, 0.1, [27, 30, 36, 255]);
    [0.42, -0.42].forEach((y) => { flat(0.35, -0.2, y + 0.24, y - 0.24, 0.55, [60, 66, 78, 255]); flat(-0.2, -0.32, y + 0.23, y - 0.23, 1.05, [68, 74, 86, 255]); });
    flat(-0.75, -1.25, 0.72, -0.72, 0.55, [60, 66, 78, 255]); flat(-1.25, -1.36, 0.7, -0.7, 1.0, [68, 74, 86, 255]);
    flat(0.95, -0.2, 0.1, -0.1, 0.62, [40, 44, 52, 255]);
    const segs = [];
    LINES.forEach(([pts, kind]) => { const q = pts.map(S); for (let i = 1; i < q.length; i++) segs.push([q[i - 1], q[i], kind]); });
    let d0 = Infinity, d1 = -Infinity;
    segs.forEach(([a, b]) => { d0 = Math.min(d0, a[2], b[2]); d1 = Math.max(d1, a[2], b[2]); });
    segs.sort((a, b) => (a[0][2] + a[1][2]) - (b[0][2] + b[1][2]));
    const near = (d) => (d - d0) / Math.max(1e-6, d1 - d0);
    // the lights: an upper one a bright strip in a soft spread of its colour; a lower one a pool of light on the floor
    // round it (where a footwell or a door pocket lights), the lamp itself a dot in the middle
    const drawLights = () => {
        const pool = (l, c) => {
            const [x, y, z] = lightPoint(l.x, l.y, l.part), rgb = c.rgb, br = c.bright, r = 0.24;
            for (let ring = 3; ring >= 1; ring--) {
                const rr = r * ring / 3, pts = [];
                for (let a = 0; a < 16; a++) { const q = a / 16 * Math.PI * 2; pts.push(S([x + rr * Math.cos(q), y + rr * 0.8 * Math.sin(q), 0.08])); }
                for (let a = 1; a < 15; a++) cv.quad([pts[0], pts[a], pts[a + 1], pts[a + 1]].map((q) => [q[0], q[1]]), glow(rgb, br, 0.2));
            }
            return S([x, y, z]);
        };
        lights.forEach((l) => {
            const c = colourOf(l), rgb = c ? c.rgb : [90, 96, 104], br = c ? c.bright : 30;
            if (c && br <= 0) return;
            if (l.x2 != null) {
                const a = S(lightPoint(l.x, l.y, l.part)), b = S(lightPoint(l.x2, l.y2, l.part));
                if (c) [[22, 0.12], [13, 0.26], [8, 0.5]].forEach(([w, al]) => cv.line(a[0], a[1], b[0], b[1], w, glow(rgb, br, al)));
                cv.line(a[0], a[1], b[0], b[1], 4, glow(rgb, br, c ? 1 : 0.6));
                if (c) cv.line(a[0], a[1], b[0], b[1], 1.5, glow(rgb.map((v) => Math.round(v + (255 - v) * 0.7)), br, 0.95));
            } else {
                const p = c ? pool(l, c) : S(lightPoint(l.x, l.y, l.part));
                cv.circle(p[0], p[1], 4, glow(c ? rgb.map((v) => Math.round(v + (255 - v) * 0.5)) : rgb, br, c ? 1 : 0.6));
            }
            if (l.fault) { const p = S(lightPoint(l.x, l.y, l.part)); cv.circle(p[0], p[1], 6, t.warn || '#ffb000'); }
        });
    };
    // the far lines, the lights inside, then the near lines over them (see-through)
    let lit = false;
    segs.forEach(([a, b, kind]) => {
        const n = near((a[2] + b[2]) / 2);
        if (!lit && n > 0.55) { drawLights(); lit = true; }
        const c = COL[kind], al = kind === 'lamp' || kind === 'tail' ? 0.95 : kind === 'inside' ? 0.7 : (kind === 'mesh' ? 0.08 : 0.16) + (kind === 'mesh' ? 0.4 : 0.78) * n * n;
        cv.line(a[0], a[1], b[0], b[1], WID[kind], [c[0], c[1], c[2], Math.round(255 * al)]);
    });
    if (!lit) drawLights();
}

module.exports = { drawCarView, MAX_PITCH, MAX_ROLL };
