'use strict';
/*
 * Synthetic sessions for test/replay.sh, written to DIR:
 *   upstream-doom.bin       upstream dialect: a 320x200 game picture each frame (IMAGE 9), GRAB 10,
 *                           IMAGE op in upstream's layout, scaled 3x with nearest pixels
 *   iterio-pictures.bin     iterio dialect: CLAIM 9, premultiplied pictures (IMAGE 10) with corner
 *                           radius, DROP_IMAGE 11
 *   iterio-over-bytes.bin   nine 1024x1024 pictures, over an app's 32 MB
 *   native-index8.bin       mgu-render/1 through js/mgu_render_client.js: an INDEX8 pixmap written in
 *                           regions, a palette change, drawn 1:1
 *   native-index8-ref.bin   the same pictures as iterio pictures (expanded here), for comparison
 *   native-rgba.bin / native-rgba-ref.bin   the same with an RGBA pixmap
 *   mgu-video-replay-a, -b  frame files (I420, four colours; replay.sh puts them in /dev/shm): a 640x360
 *                           BT.709 limited range, newest frame in slot 2 of 3 (the others grey), and a 64x48
 *                           BT.601 full range
 *   iterio-video.bin        iterio dialect: VIDEO 13 both, fitted into wider / taller boxes with a corner
 *                           radius, under and over other ops, in a layer (not drawn there), DROP_VIDEO 14
 *   iterio-refused-path.bin, iterio-refused-dotdot.bin   a frame file outside /dev/shm/mgu-video-*: refused,
 *                           the frame still drawn
 *   refused-owner.bin       as those, naming /dev/shm/mgu-video-replay-owner: replay.sh replays it as an app whose
 *                           uid does not own the file (refused, drawn as iterio-refused-path) and as the owner
 *   native-video.bin / native-video-ref.bin   a video through js/mgu_render_client.js, and as iterio messages
 *
 *   node test/gen_sessions.js DIR
 *   node test/gen_sessions.js --check-video FILE.pam   iterio-video's last frame shows the videos' colours (exit 1 if not)
 */
const fs = require('fs');
const path = require('path');
const { RenderClient, imageOp, videoOp } = require('../js/mgu_render_client');

/* videos: four quadrants of (Y, U, V) each, and the colour the renderer must show for each */
const VIDEO_A = { file: '/dev/shm/mgu-video-replay-a', w: 640, h: 360, matrix: 1, full: 0, nslot: 3, slot: 2,
    quads: [[235, 128, 128], [16, 128, 128], [81, 90, 240], [145, 54, 34]] };
const VIDEO_B = { file: '/dev/shm/mgu-video-replay-b', w: 64, h: 48, matrix: 0, full: 1, nslot: 1, slot: 0,
    quads: [[200, 128, 128], [60, 128, 128], [110, 100, 170], [150, 150, 90]] };     /* mid tones: the range shows */
function videoFile(v) {
    const head = Buffer.alloc(64), ysz = v.w * v.h, cw = v.w / 2, csz = cw * (v.h / 2), fsz = ysz + 2 * csz;
    [0x4656474d, 1, v.w, v.h, 1, v.slot, v.nslot, v.matrix, v.full].forEach((x, i) => head.writeUInt32LE(x, i * 4));
    const fr = Buffer.alloc(fsz), q = (x, y) => (y < v.h / 2 ? 0 : 2) + (x < v.w / 2 ? 0 : 1);
    for (let y = 0; y < v.h; y++) for (let x = 0; x < v.w; x++) fr[y * v.w + x] = v.quads[q(x, y)][0];
    for (let y = 0; y < v.h / 2; y++) for (let x = 0; x < cw; x++) {
        fr[ysz + y * cw + x] = v.quads[q(x * 2, y * 2)][1]; fr[ysz + csz + y * cw + x] = v.quads[q(x * 2, y * 2)][2];
    }
    const slots = [];
    for (let s = 0; s < v.nslot; s++) slots.push(s === v.slot ? fr : Buffer.alloc(fsz, 0x80));
    return Buffer.concat([head].concat(slots));
}
function videoRgb(v, k) {
    const [Y, U, V] = v.quads[k];
    let y = Y / 255, u = U / 255 - 0.501961, w = V / 255 - 0.501961;
    if (!v.full) { y = (y - 0.062745) * 1.164384; u *= 1.138393; w *= 1.138393; }
    const c = v.matrix ? [y + 1.5748 * w, y - 0.187324 * u - 0.468124 * w, y + 1.8556 * u]
        : [y + 1.402 * w, y - 0.344136 * u - 0.714136 * w, y + 1.772 * u];
    return c.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255));
}
/* iterio-video's last frame, 840x360: A fitted into the whole width (bars x < 100, x >= 740), B into 120x100 at
   700,250 (120x90 from y 255), a half-black bar over A at y >= 320 under B, layer 7 at 110,10 (40x20 yellow) */
function checkVideo(file) {
    const b = fs.readFileSync(file), end = b.indexOf('ENDHDR\n') + 7, hdr = b.slice(0, end).toString();
    const w = +/WIDTH (\d+)/.exec(hdr)[1], h = +/HEIGHT (\d+)/.exec(hdr)[1];
    if (w !== 840 || h !== 360) { console.log(`${w}x${h}: want 840x360`); return false; }
    const at = (x, y) => Array.from(b.slice(end + (y * w + x) * 4, end + (y * w + x) * 4 + 3));
    const want = [[50, 180, [255, 0, 255]], [800, 100, [255, 0, 255]], [130, 20, [255, 255, 0]],
        [260, 340, videoRgb(VIDEO_A, 2).map((c) => Math.round(c * 127 / 255))]];
    [[260, 90], [580, 90], [260, 270], [580, 270]].forEach(([x, y], k) => want.push([x, y, videoRgb(VIDEO_A, k)]));
    [[730, 277], [790, 277], [730, 322], [790, 322]].forEach(([x, y], k) => want.push([x, y, videoRgb(VIDEO_B, k)]));
    let bad = 0;
    for (const [x, y, c] of want) {
        const got = at(x, y);
        if (!got.every((v, i) => Math.abs(v - c[i]) <= 3)) { bad++; console.log(`${x},${y}: ${got} want ${c}`); }
    }
    return !bad;
}
if (process.argv[2] === '--check-video') process.exit(checkVideo(process.argv[3]) ? 0 : 1);

const dir = process.argv[2];
fs.mkdirSync(dir, { recursive: true });

function msg(type, payload) {
    const len = payload ? payload.length : 0;
    const b = Buffer.alloc(8 + len + ((4 - (len & 3)) & 3));
    b.writeUInt32LE(type, 0); b.writeUInt32LE(b.length - 8, 4);
    if (len) payload.copy(b, 8);
    return b;
}
const u32 = (a) => Buffer.from(new Uint32Array(a).buffer);
const f32 = (a) => Buffer.from(new Float32Array(a).buffer);
const fbits = (v) => new Uint32Array(new Float32Array([v]).buffer)[0];
const place = (x, y, w, h, s) => msg(2, Buffer.concat([u32([x, y, w, h]), f32([s, 0, 0])]));
const OP = { CLEAR: 1, RECT: 2, RRECT: 4, LAYER: 12, IMAGE: 18, VIDEO: 19 };
const ops = (list) => msg(7, u32(list));

/* a game-like picture: bands that move with the frame number */
function game(f) {
    const px = Buffer.alloc(320 * 200 * 4);
    for (let y = 0; y < 200; y++) for (let x = 0; x < 320; x++) {
        const i = (y * 320 + x) * 4, v = (x + y * 2 + f * 7) & 255;
        px[i] = v; px[i + 1] = (x * 3) & 255; px[i + 2] = (y * 5 + f * 11) & 255; px[i + 3] = 255;
    }
    return px;
}

/* upstream */
{
    const out = [msg(1, Buffer.from('doom')), place(0, 0, 960, 600, 1)];
    for (let f = 0; f < 6; f++) {
        out.push(msg(9, Buffer.concat([u32([1, 320, 200]), game(f)])));
        out.push(msg(10, u32([1])));
        out.push(ops([OP.CLEAR, 0x101820ff, OP.IMAGE, 1, f, fbits(0), fbits(0), fbits(960), fbits(600),
            OP.RECT, fbits(10), fbits(10), fbits(100), fbits(20), 0xff0000ff]));
    }
    fs.writeFileSync(path.join(dir, 'upstream-doom.bin'), Buffer.concat(out));
}

/* iterio */
function picture(w, h, seed) {
    const px = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, a = (x * 255 / (w - 1)) | 0;
        const r = (y * 4 + seed) & 255, g = (x * 2) & 255, b = 200;
        px[i] = (r * a + 127) / 255; px[i + 1] = (g * a + 127) / 255; px[i + 2] = (b * a + 127) / 255; px[i + 3] = a;
    }
    return px;
}
{
    const claim = msg(9, Buffer.concat([u32([2]), f32([0, 0, 400, 300, 500, 100, 200, 200])]));
    const out = [msg(1, Buffer.from('pictures')), place(0, 0, 800, 480, 1.25), claim,
        msg(10, Buffer.concat([u32([5, 64, 64]), picture(64, 64, 3)])),
        msg(10, Buffer.concat([u32([6, 100, 30]), picture(100, 30, 9)]))];
    const frame = (both) => ops([OP.CLEAR, 0x202830ff, OP.RRECT, fbits(20), fbits(20), fbits(300), fbits(200), fbits(18), 0x3d9bffff,
        OP.IMAGE, fbits(40), fbits(40), fbits(128), fbits(128), fbits(24), 5].concat(both ?
        [OP.IMAGE, fbits(200), fbits(60), fbits(200), fbits(60), fbits(0), 6] : []));
    out.push(frame(true), frame(true), msg(11, u32([6])), frame(true), frame(false));
    fs.writeFileSync(path.join(dir, 'iterio-pictures.bin'), Buffer.concat(out));
    /* nine 1024x1024 pictures: over the 32 MB an app may hold; the frame still draws */
    const over = [msg(1, Buffer.from('over-bytes')), place(0, 0, 200, 100, 1)];
    for (let i = 0; i < 9; i++) over.push(msg(10, Buffer.concat([u32([i + 1, 1024, 1024]), picture(1024, 1024, i)])));
    over.push(ops([OP.CLEAR, 0x000000ff, OP.IMAGE, fbits(0), fbits(0), fbits(200), fbits(100), fbits(0), 1]));
    fs.writeFileSync(path.join(dir, 'iterio-over-bytes.bin'), Buffer.concat(over));
}

/* native pixmaps, and the same pictures as iterio pictures */
function native(name, format) {
    const file = path.join(dir, `native-${name}.bin`);
    const gpu = new RenderClient('native-' + name, { info() {}, warn() {} }, { file });
    gpu.connect();
    gpu.place({ x: 0, y: 0, w: 640, h: 400, scale: 1, ox: 0, oy: 0 });
    const bpp = format === 'index8' ? 1 : 4;
    const data = Buffer.alloc(320 * 200 * bpp);
    let pal = Buffer.alloc(768);
    const setPal = (k) => { for (let i = 0; i < 256; i++) { pal[i * 3] = (i * k) & 255; pal[i * 3 + 1] = 255 - i; pal[i * 3 + 2] = (i * 7) & 255; } };
    const fill = (x0, y0, w, h, f) => {
        for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
            const v = (x * 3 + y + f * 40) & 255, i = (y * 320 + x) * bpp;
            if (bpp === 1) data[i] = v; else { data[i] = v; data[i + 1] = (255 - v); data[i + 2] = (x + f) & 255; data[i + 3] = 255; }
        }
    };
    const ref = [msg(1, Buffer.from('native-' + name + '-ref')), place(0, 0, 640, 400, 1)];
    const expand = () => {
        const px = Buffer.alloc(320 * 200 * 4);
        for (let i = 0; i < 320 * 200; i++) {
            if (bpp === 1) { const c = data[i] * 3; px[i * 4] = pal[c]; px[i * 4 + 1] = pal[c + 1]; px[i * 4 + 2] = pal[c + 2]; px[i * 4 + 3] = 255; }
            else data.copy(px, i * 4, i * 4, i * 4 + 4);
        }
        return px;
    };
    const frameOps = () => {
        const u = new Uint32Array([OP.CLEAR, 0x000000ff].concat(Array.from(imageOp(1, 160, 100, 320, 200, 0))));
        gpu.frameWords(u);
        ref.push(msg(10, Buffer.concat([u32([1, 320, 200]), expand()])), msg(7, Buffer.from(u.buffer)));
    };
    gpu.pixmap(1, 320, 200, format, 'nearest');
    setPal(1);
    if (bpp === 1) gpu.palette(1, pal);
    fill(0, 0, 320, 200, 0);
    gpu.pixels(1, [{ x: 0, y: 0, w: 320, h: 200 }], data);
    frameOps();
    fill(10, 20, 50, 40, 1); fill(200, 150, 120, 50, 2);
    gpu.pixels(1, [{ x: 10, y: 20, w: 50, h: 40 }, { x: 200, y: 150, w: 120, h: 50 }], data);
    frameOps();
    if (bpp === 1) { pal = Buffer.alloc(768); setPal(5); gpu.palette(1, pal); }
    fill(0, 199, 320, 1, 3);
    gpu.pixels(1, [{ x: 0, y: 199, w: 320, h: 1 }], data);
    frameOps();
    gpu.close();
    fs.writeFileSync(path.join(dir, `native-${name}-ref.bin`), Buffer.concat(ref));
}
native('index8', 'index8');
native('rgba', 'rgba');

/* video */
{
    for (const v of [VIDEO_A, VIDEO_B]) fs.writeFileSync(path.join(dir, path.basename(v.file)), videoFile(v));
    const video = (id, file) => msg(13, Buffer.concat([u32([id]), Buffer.from(file)]));
    const vop = (id, x, y, w, h, r) => [OP.VIDEO, fbits(x), fbits(y), fbits(w), fbits(h), fbits(r), id];
    const MAGENTA = 0xff00ffff;
    const out = [msg(1, Buffer.from('video')), place(0, 0, 840, 360, 1), msg(9, Buffer.concat([u32([1]), f32([0, 0, 840, 360])])),
        video(1, VIDEO_A.file), ops([OP.CLEAR, MAGENTA].concat(vop(1, 0, 0, 840, 360, 0))),
        video(2, VIDEO_B.file), video(3, VIDEO_A.file), msg(14, u32([3])),
        msg(6, Buffer.concat([u32([7]), f32([40, 20]), u32([OP.RECT, fbits(0), fbits(0), fbits(40), fbits(20), 0xffff00ff].concat(vop(1, 0, 0, 40, 20, 0)))])),
        ops([OP.CLEAR, MAGENTA].concat(vop(1, 0, 0, 840, 360, 0), [OP.LAYER, 7, fbits(110), fbits(10)],
            [OP.RECT, fbits(0), fbits(320), fbits(840), fbits(40), 0x00000080], vop(2, 700, 250, 120, 100, 12), vop(3, 0, 0, 50, 50, 0)))];
    fs.writeFileSync(path.join(dir, 'iterio-video.bin'), Buffer.concat(out));
    const refused = (file) => Buffer.concat([msg(1, Buffer.from('video')), place(0, 0, 200, 100, 1), msg(9, u32([0])),
        video(1, file), ops([OP.CLEAR, MAGENTA].concat(vop(1, 0, 0, 200, 100, 0)))]);
    fs.writeFileSync(path.join(dir, 'iterio-refused-path.bin'), refused('/etc/passwd'));
    fs.writeFileSync(path.join(dir, 'iterio-refused-dotdot.bin'), refused('/dev/shm/mgu-video-../../etc/passwd'));
    fs.writeFileSync(path.join(dir, 'refused-owner.bin'), refused('/dev/shm/mgu-video-replay-owner'));

    const gpu = new RenderClient('native-video', { info() {}, warn() {} }, { file: path.join(dir, 'native-video.bin') });
    gpu.connect();
    gpu.place({ x: 0, y: 0, w: 640, h: 400, scale: 1, ox: 0, oy: 0 });
    gpu.video(1, VIDEO_A.file);
    const u = new Uint32Array([OP.CLEAR, MAGENTA].concat(Array.from(videoOp(1, 20, 10, 600, 380, 16))));
    gpu.frameWords(u);
    gpu.close();
    fs.writeFileSync(path.join(dir, 'native-video-ref.bin'), Buffer.concat([msg(1, Buffer.from('native-video-ref')),
        place(0, 0, 640, 400, 1), video(1, VIDEO_A.file), msg(7, Buffer.from(u.buffer))]));
}
console.log('sessions in ' + dir);
