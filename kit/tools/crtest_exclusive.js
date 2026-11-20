'use strict';
/**
 * crtest_exclusive.js - on the head unit: does cluster-render's `exclusive` work between two apps on the
 * HUD? (Whether Redline can drop kit/runtime/hud_claim.js for it.) Not shipped in any app.
 *
 *   node crtest_exclusive.js /path/to/cluster_render_client.js
 *
 * Two clients, as two apps would be:
 *   0 s   A: a blue frame where Redline's tach sits (class overlay, z 0)
 *   6 s   B: a red frame, smaller, inside it, `exclusive: 1` (class overlay, z 1)
 *         expected: A's layer goes `suspended` and only the red frame shows on the glass;
 *         with Redline's tach up, Redline's log shows "hud: layer suspended" too
 *   16 s  B dropped. expected: A (and Redline) `shown` again
 *   22 s  A dropped, the end: PASS / FAIL from the events seen
 * Plain Node 8. Takes nothing from the car but the HUD for 22 s.
 */
const crPath = process.argv[2];
if (!crPath) { console.log('usage: node crtest_exclusive.js /path/to/cluster_render_client.js'); process.exit(2); }
const { ClusterRender } = require(require('path').resolve(crPath));

const W = 400, H = 130, X = 200, Y = 140;            // Redline's tach at its default place in the 800x480 scene
const t0 = Date.now();
const say = (s) => console.log(((Date.now() - t0) / 1000).toFixed(1) + ' s  ' + s);

/** An RGBA frame of w x h: a border t px wide in colour c (straight alpha), the rest see-through. */
function frame(w, h, t, c) {
    const b = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (x < t || y < t || x >= w - t || y >= h - t || Math.abs(x * h / w - y) < t / 2) {
            const i = (y * w + x) * 4; b[i] = c[0]; b[i + 1] = c[1]; b[i + 2] = c[2]; b[i + 3] = 255;
        }
    }
    return b;
}

const seen = { A: [], B: [] };
function client(name) {
    const cr = new ClusterRender('crtest_' + name.toLowerCase());
    cr.on('ready', () => say(name + ': connected (' + cr.backend + ', targets ' + cr.targets + ')'));
    cr.on('layer', (ref, state, reason) => { seen[name].push({ t: Date.now() - t0, state: state }); say(name + ': layer ' + state + (reason ? ' (' + reason + ')' : '')); });
    cr.on('target', (tname, state, holder, reason) => { if (tname === 'hud') say(name + ': target hud ' + state + (holder ? ' behind ' + holder : '') + (reason ? ' (' + reason + ')' : '')); });
    cr.on('refused', (op, ref, reason) => say(name + ': REFUSED ' + op + ' ' + ref + ': ' + reason));
    cr.connect();
    return cr;
}

const A = client('A');
const a = A.image({ target: 'hud', klass: 'overlay', z: 0, x: X, y: Y, w: W, h: H });
A.pixels(a, null, frame(W, H, 8, [40, 120, 255]));
say('A: blue frame up at ' + X + ',' + Y);

let B = null, b = 0;
setTimeout(() => {
    B = client('B');
    b = B.image({ target: 'hud', klass: 'overlay', z: 1, exclusive: 1, x: X + 100, y: Y + 25, w: 200, h: 80 });
    B.pixels(b, null, frame(200, 80, 8, [255, 40, 40]));
    say('B: red frame up, exclusive (A and anything under it should be suspended)');
}, 6000);
setTimeout(() => { B.drop(b); say('B: dropped (A should come back)'); setTimeout(() => B.close(), 500); }, 16000);
setTimeout(() => {
    A.drop(a);
    const during = seen.A.filter((e) => e.t > 6000 && e.t < 16000).map((e) => e.state);
    const after = seen.A.filter((e) => e.t >= 16000).map((e) => e.state);
    const bShown = seen.B.some((e) => e.state === 'shown');
    say('A during B: ' + (during.join(', ') || 'no events') + '; A after B: ' + (after.join(', ') || 'no events') + '; B shown: ' + bShown);
    const pass = bShown && during.indexOf('suspended') >= 0 && after.indexOf('shown') >= 0;
    console.log(pass ? 'PASS: exclusive suspends another app\'s HUD layer and gives it back'
        : 'FAIL or unclear: send this whole output (and what you saw on the glass)');
    setTimeout(() => { A.close(); process.exit(pass ? 0 : 1); }, 500);
}, 22000);
