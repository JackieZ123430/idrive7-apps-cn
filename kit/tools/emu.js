'use strict';
/**
 * emu.js - live emulator: a built app running with the real runtime, drawn in the browser by the car's
 * GPU draw engine (kit/renderd/src/gfx.c as WebAssembly, kit/emu/web/gfx/).
 *
 *   node kit/tools/emu.js redline [--port 8077] [--bg screenshot.png] [--no-touch]   ->  http://localhost:8077 (this computer only)
 *
 * Three parts in this process:
 *   app       python3 kit/tools/build.py <id>, then dist/<id> in a child node (hu-stub.js: a stubbed head
 *             unit, settings in preview/emu/<id>/). A save under apps/<id>/ or kit/runtime/ builds and
 *             restarts it; a failed build keeps the old one running.
 *   renderer  the daemon side of kit/renderd/PROTOCOL.md on a Unix socket (MGU_RENDERD_SOCKET for the app):
 *             HELLO -> X_READY (touch routing, controller gate) + READY, X_STATE, TICK when the browser has
 *             drawn the last frame (a page that has not ticked for 200 ms does not paint - a background tab, a
 *             hidden pane, a minimised window: the frames count as drawn when they come, at the FPS cap, until a
 *             page ticks at a refresh rate again), touch to the app inside its CLAIMs (CLOSED outside), the controller as
 *             X_CCU / CCU while the app grabs it. Every message the app sends goes to the browser unchanged;
 *             a malformed one ends the app's connection, as on the car ("bad message").
 *   page      kit/emu/web over http on 127.0.0.1, a WebSocket (RFC 6455, below) at /ws for this host's pages only.
 *             Cross-origin isolated (COOP + COEP: the page loads nothing from elsewhere), so performance.now() has
 *             µs steps for the draw times, not 0.1 ms.
 *
 * WebSocket, server -> page: binary = one or more whole client->renderer messages (gfx.feed); text = JSON
 *   {t:'hello', apps, titles, app, bg, touch}  on connect (titles: { id: app.json title }; icons at /icon/<id>.png)
 *   {t:'spec', spec, values}              the app's settings schema and screens; values after each change: {t:'settings', values}
 *   {t:'status', s, text}                 s: building | starting | running | exited | build-error (text: the build's output)
 *   {t:'reset', app}                      a new app connection follows (gfx.reset(); another app: a new renderer)
 *   {t:'log', lines: [[level, text]]}     the app's log
 *   {t:'conn', ...}                       the renderer's view: dialect, shown, grab, claims, place, fps cap
 *   {t:'screens', stack, closed}          the app's screen stack; closed: the user left it (the page shows the HMI's app picker)
 *   {t:'focus', id}                       the bar button the HMI's focus is on (controller not grabbed)
 *   {t:'soft', png}                       the HMI's own image of the app's screen (software path), base64 PNG
 *   {t:'note', s}                         a short message for the user (the app opened an HMI screen not drawn here)
 * page -> server: JSON
 *   {t:'tick'}                            the frames received so far are drawn: the app may send the next
 *   {t:'fps', n}                          cap (0: none)        {t:'gstats', fps, avgMs, maxMs}  the renderer's, for STATS
 *   {t:'touch', phase: 1|2|3, x, y}       screen px
 *   {t:'ccu', turn: n} | {t:'ccu', press: bool} | {t:'ccu', tilt: 'N'|'E'|'S'|'W'|null}
 *   {t:'hmi', a: 'back'|'home'|'open', screen}   {t:'click', id}  (an HMI button)
 *   {t:'set', k, v}  {t:'sig', mode: 'demo'|'manual', v: {rpm, speed, coolant, oil, gear, gLong, gLat, torque}}
 *   {t:'app', id}  {t:'restart'}
 *   {t:'drop', why}                       the page's renderer dropped the client: the connection is closed
 *   {t:'rerror', s}                       an error the renderer would send the app (ERROR)
 *   {t:'replay'}                          a new renderer on the page: the connection so far again
 *   {t:'touch-routing', on}               the renderer offers touch routing or not (--no-touch): the app reconnects;
 *                                         the pages get {t:'touchmode', on} (and hello.touch)
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn, fork } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const WEB = path.join(ROOT, 'kit', 'emu', 'web');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const PORT = Number(opt('--port', 8077));
const BG = (() => { const b = opt('--bg', null); return b ? path.resolve(b) : null; })();
// touch routing offered by the renderer (the Store's mgu-render: on; --no-touch or the page's switch: a renderer without
// it, where the kit draws the slim bar over the HMI's own buttons and every tap is the HMI's)
const Touch = { on: (() => { const i = args.indexOf('--no-touch'); if (i < 0) return true; args.splice(i, 1); return false; })() };
const HOSTS = ['localhost:' + PORT, '127.0.0.1:' + PORT];
const listApps = () => fs.readdirSync(path.join(ROOT, 'apps')).filter((d) => fs.existsSync(path.join(ROOT, 'apps', d, 'app.json'))).sort();
/** { id: title } from each app's app.json (the HMI's tile labels) */
const appTitles = () => listApps().reduce((o, id) => { try { o[id] = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', id, 'app.json'), 'utf8')).title || id; } catch (e) { o[id] = id; } return o; }, {});
let appId = args[0];
if (!appId || listApps().indexOf(appId) < 0) { console.error('usage: node kit/tools/emu.js <app> [--port 8077] [--bg file.png] [--no-touch]\napps: ' + listApps().join(' ')); process.exit(2); }
// (a short path: Unix socket paths are limited to ~104 bytes)
const SOCK = path.join(os.tmpdir(), 'mgu-emu-' + process.pid + '.sock');
const MAX_MSG = 24 << 20;                       // a bigger message ends the connection (PROTOCOL.md "Framing")
const PAGE_BEHIND = 8 << 20, PAGE_GONE = 64 << 20;   // bytes queued to a page: frames wait for it / it is closed

/* ---------------- WebSocket (RFC 6455), server side ---------------- */
const pages = new Set();
class Ws {
    constructor(sock, head) {
        this.sock = sock; this.buf = Buffer.alloc(0); this.frag = null; this.open = true; this.stale = false;
        sock.setNoDelay(true);
        sock.on('data', (d) => this._data(d));
        sock.on('close', () => { this.open = false; pages.delete(this); });
        sock.on('error', () => {});
        // a page that fell behind has missed frames: it gets the connection so far once it has read its backlog
        sock.on('drain', () => { if (this.stale && this.open) { this.stale = false; replay(this); } });
        if (head && head.length) this._data(head);
    }
    _data(d) {
        this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
        for (;;) {
            const b = this.buf;
            if (b.length < 2) return;
            const fin = b[0] & 0x80, op = b[0] & 15, masked = b[1] & 0x80;
            let len = b[1] & 127, o = 2;
            if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); o = 4; } else if (len === 127) { if (b.length < 10) return; len = b.readUInt32BE(2) * 4294967296 + b.readUInt32BE(6); o = 10; }
            if (!masked) { this.close(1002); return; }               // a client's frames are always masked
            if (len > 1 << 20) { this.close(1009); return; }
            const mo = o;
            o += 4;
            if (b.length < o + len) return;
            const p = Buffer.from(b.slice(o, o + len));
            for (let i = 0; i < p.length; i++) p[i] ^= b[mo + (i & 3)];
            this.buf = b.slice(o + len);
            if (op === 8) { this.close(); return; }
            if (op === 9) { this._frame(10, p); continue; }
            if (op === 10) continue;
            if (op === 0 && this.frag) {
                this.frag.parts.push(p);
                if (this.frag.parts.reduce((n, x) => n + x.length, 0) > 1 << 20) { this.close(1009); return; }
                if (fin) { const f = this.frag; this.frag = null; this._msg(f.op, Buffer.concat(f.parts)); }
                continue;
            }
            if (!fin) { this.frag = { op, parts: [p] }; continue; }
            this._msg(op, p);
        }
    }
    _msg(op, p) {
        if (op !== 1) return;
        let m;
        try { m = JSON.parse(p.toString('utf8')); } catch (e) { return; }
        if (!m || typeof m !== 'object') return;
        try { onPage(this, m); } catch (e) { console.error('page message: ' + (e.stack || e)); }
    }
    _frame(op, p) {
        if (!this.open) return;
        const n = p.length, h = Buffer.alloc(n < 126 ? 2 : n < 65536 ? 4 : 10);
        h[0] = 0x80 | op;
        if (n < 126) h[1] = n; else if (n < 65536) { h[1] = 126; h.writeUInt16BE(n, 2); } else { h[1] = 127; h.writeUInt32BE(Math.floor(n / 4294967296), 2); h.writeUInt32BE(n >>> 0, 6); }
        this.sock.write(h); this.sock.write(p);
    }
    send(x) {
        if (!this.open) return;
        const q = this.sock.writableLength;
        if (q > PAGE_GONE) { this.sock.destroy(); this.open = false; pages.delete(this); return; }
        if (Buffer.isBuffer(x)) {
            // frames for a page that does not keep up wait (it gets a replay when it has caught up)
            if (q > PAGE_BEHIND) { this.stale = true; return; }
            if (this.stale) return;
            this._frame(2, x);
        } else this._frame(1, Buffer.from(JSON.stringify(x)));
    }
    close(code) {
        if (!this.open) return;
        const p = Buffer.alloc(2); p.writeUInt16BE(code || 1000, 0);
        this._frame(8, p); this.open = false; pages.delete(this); this.sock.end();
    }
}
const toPages = (x) => pages.forEach((w) => w.send(x));

/* ---------------- http: the page, /bg, /ws (this computer only: 127.0.0.1, Host and Origin checked) ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.map': 'application/json' };
// another site's page in the browser (Origin) or a DNS name pointed at 127.0.0.1 (Host) gets nothing
const ours = (req) => HOSTS.indexOf(String(req.headers.host)) >= 0 && (!req.headers.origin || HOSTS.some((h) => req.headers.origin === 'http://' + h));
const server = http.createServer((req, res) => {
    const fail = (code) => { res.writeHead(code, { 'content-type': 'text/plain' }); res.end(String(code)); };
    try {
        if (!ours(req)) { fail(403); return; }
        let u;
        try { u = decodeURIComponent(req.url.split('?')[0]); } catch (e) { fail(400); return; }
        if (u.indexOf('\0') >= 0) { fail(400); return; }
        // an app's tile icon: /icon/<id>.png, for the ids in apps/ only
        const ic = /^\/icon\/([A-Za-z0-9_-]+)\.png$/.exec(u);
        if (ic && listApps().indexOf(ic[1]) < 0) { fail(404); return; }
        const f = ic ? path.join(ROOT, 'apps', ic[1], 'icon.png') : u === '/bg' && BG ? BG : path.join(WEB, u === '/' ? 'index.html' : path.normalize(u).replace(/^([/\\])+/, ''));
        if (!ic && f !== BG && f.indexOf(WEB + path.sep) !== 0) { fail(403); return; }
        fs.readFile(f, (e, d) => {
            if (e) { fail(404); return; }
            // (cross-origin isolated: a finer performance.now() for the draw times; everything the page loads is from here)
            res.writeHead(200, { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store',
                'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' });
            res.end(d);
        });
    } catch (e) { fail(500); }
});
server.on('clientError', (e, sock) => { try { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (x) { sock.destroy(); } });
server.on('upgrade', (req, sock, head) => {
    sock.on('error', () => {});
    const key = req.headers['sec-websocket-key'];
    if (req.url.split('?')[0] !== '/ws' || !key || String(req.headers.upgrade).toLowerCase() !== 'websocket' || !ours(req)) { sock.destroy(); return; }
    const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
    const ws = new Ws(sock, head);
    pages.add(ws);
    ws.send({ t: 'hello', apps: listApps(), titles: appTitles(), app: appId, bg: !!BG, touch: Touch.on });
    if (App.spec) ws.send({ t: 'spec', spec: App.spec, values: App.values });
    ws.send({ t: 'screens', stack: App.stack, closed: App.closed });
    ws.send(App.status);
    ws.send({ t: 'log', lines: App.log.slice(-300) });
    ws.send({ t: 'sigmode', mode: Sig.mode, v: Sig.v });
    if (App.soft) ws.send({ t: 'soft', png: App.soft });
    replay(ws);
});

/* ---------------- renderer daemon (kit/renderd/PROTOCOL.md) ---------------- */
const M = { HELLO: 1, PLACE: 2, SHOW: 3, ATLAS: 4, RAMP: 5, LAYER: 6, FRAME: 7, DROP_LAYER: 8, M9: 9, M10: 10, DROP_IMAGE: 11, FPS: 12, VIDEO: 13, DROP_VIDEO: 14 };
const E = { READY: 101, TICK: 102, ERROR: 103, STATS: 104, CCU: 105, TOUCH: 105, CLOSED: 106 };
const X = { MODE: 0x4d520001, GRAB: 0x4d520002, PIXMAP: 0x4d520003, PIXELS: 0x4d520004, PALETTE: 0x4d520005, READY: 0x4d520101, STATE: 0x4d520102, CCU: 0x4d520103 };
// shortest payload per type (bytes), as kit/renderd/src/main.c checks them; shorter: "bad message"
const MIN = { 2: 28, 3: 4, 4: 12, 5: 8, 6: 12, 8: 4, 9: 4, 10: 4, 11: 4, 12: 4, 13: 8, 14: 4 };
MIN[X.MODE] = 4; MIN[X.GRAB] = 4; MIN[X.PIXMAP] = 20; MIN[X.PIXELS] = 4; MIN[X.PALETTE] = 4 + 768;
const SCREEN = { w: 1920, h: 720 };
const BACK_COL = { w: 84, h: 530, head: 76 };   // the HMI's home (in its strip) and back arrow column: must match display.js HMI.left / colEnd / status.h
const T0 = Date.now();
let R = null;                                   // the app's connection
let pageFps = 60;
// late: no tick 200 ms after a frame; stalled: the pages do not paint (frames count as drawn when they come);
// reading: a stalled frame waits for the pages to take it; pageAt: the last page tick (ms)
const Tick = { busy: false, want: false, n: 0, last: 0, timer: null, headless: null, late: null, stalled: false, reading: null, pageAt: 0 };
/** a new app connection: no timer of the old one ticks it */
function tickReset() {
    clearTimeout(Tick.late); clearTimeout(Tick.reading); clearImmediate(Tick.reading);
    Object.assign(Tick, { busy: false, want: false, late: null, stalled: false, reading: null, pageAt: 0 });
}

/** A daemon->client message: u32 words (any number: written as its low 32 bits) or a raw payload. */
function msg(type, words, raw) {
    const p = raw || Buffer.alloc(words.length * 4);
    if (!raw) words.forEach((w, i) => p.writeUInt32LE((Number(w) || 0) >>> 0, i * 4));
    const b = Buffer.alloc(8 + p.length + ((4 - (p.length & 3)) & 3));
    b.writeUInt32LE(type, 0); b.writeUInt32LE(b.length - 8, 4); p.copy(b, 8);
    return b;
}
let connSent = '';
const connInfo = () => (R ? { t: 'conn', on: true, app: R.app, dialect: R.dialect || 'undecided', shown: R.visible, grab: R.grab, claims: R.claims.length, place: R.place, fps: R.fps } : { t: 'conn', on: false });
/** the renderer's view to the pages, when it changed */
const connChanged = () => { const c = connInfo(), j = JSON.stringify(c); if (j !== connSent) { connSent = j; toPages(c); } };
const toApp = (b) => { if (R && !R.sock.destroyed) R.sock.write(b); };
class Bad extends Error {}

const daemon = net.createServer((sock) => {
    if (R) { R.sock.destroy(); R = null; }
    const c = R = {
        sock, id: App.childId || appId, app: '?', dialect: null, visible: false, onScreen: false, grab: false, claims: [], place: null, fps: 0,
        cache: { hello: null, mode: null, place: null, claim: null, grab: null, fps: null, show: null, frame: null, res: new Map() },
        parts: [], n: 0, need: 8, gesture: null,
    };
    tickReset();
    toPages({ t: 'reset', app: c.id });
    const drop = (why) => { appLog('error', 'renderer: bad message (' + why + '), connection closed'); sock.destroy(); };
    sock.on('data', (d) => {
        if (R !== c || sock.destroyed) return;
        c.parts.push(d); c.n += d.length;
        if (c.n < c.need) return;
        const b = c.parts.length === 1 ? c.parts[0] : Buffer.concat(c.parts, c.n);
        let o = 0, bad = null;
        while (b.length - o >= 8) {
            const type = b.readUInt32LE(o), len = b.readUInt32LE(o + 4);
            if (len > MAX_MSG) { bad = len + ' bytes'; break; }
            if (b.length - o < 8 + len) break;
            try { handle(c, type, b.slice(o + 8, o + 8 + len), b.slice(o, o + 8 + len)); } catch (e) { bad = 'type ' + type + ': ' + (e instanceof Bad ? e.message : e); break; }
            o += 8 + len;
        }
        if (o) toPages(b.slice(0, o));
        if (bad) { drop(bad); return; }
        const rest = b.slice(o);
        c.parts = rest.length ? [Buffer.from(rest)] : []; c.n = rest.length;
        // the size is known from the header: a message over the limit ends the connection before it is buffered
        c.need = rest.length >= 8 ? 8 + rest.readUInt32LE(4) : 8;
        if (c.need > 8 + MAX_MSG) drop(rest.readUInt32LE(4) + ' bytes');
    });
    sock.on('error', () => {});
    sock.on('close', () => { if (R === c) { R = null; connChanged(); } });
});
daemon.on('error', (e) => { console.error('emu: renderer socket: ' + e.message); cleanup(1); });

/** One client->renderer message: what the daemon must know (dialect, placement, claims, grab, ticks) and the replay cache. Throws Bad for a malformed one. */
function handle(c, type, p, whole) {
    const C = c.cache, u = (i) => p.readUInt32LE(i * 4);
    if (MIN[type] && p.length < MIN[type]) throw new Bad(p.length + ' bytes');
    const res = (key, keep) => { C.res.delete(key); if (keep) C.res.set(key, [whole]); };
    switch (type) {
    case M.HELLO: {
        const f = p.toString('utf8').split('\0');
        c.app = f[0];
        C.hello = whole;
        c.touch = Touch.on;                 // (what this connection was offered: the app reads it here only)
        if (f.slice(1).indexOf('proto=mgu-render/1') >= 0) {
            c.dialect = 'native';
            // version 1, layer mode, caps: touch routing (if on) | controller gate | pixmaps; no embed; app area; pixmap side; 60 Hz
            toApp(msg(X.READY, [1, 1, (c.touch ? 1 : 0) | 2 | 8, 0, 0, 0, 0, 108, 82, 1790, 638, 2048, 60000]));
        }
        toApp(msg(E.READY, [4, SCREEN.w, SCREEN.h, c.touch ? 1 : 0]));
        appLog('info', 'renderer: ' + c.app + ' connected' + (c.dialect ? ', mgu-render/1' : ''));
        connChanged();
        break;
    }
    case X.MODE: C.mode = whole; if (c.place) wantTick(); break;
    case M.PLACE: {
        const pl = { x: p.readInt32LE(0), y: p.readInt32LE(4), w: p.readInt32LE(8), h: p.readInt32LE(12), s: p.readFloatLE(16), ox: p.readFloatLE(20), oy: p.readFloatLE(24) };
        if (pl.w < 1 || pl.h < 1 || pl.w > 4096 || pl.h > 4096 || !(pl.s > 0.05 && pl.s < 8)) throw new Bad('placement');
        // a new size or scale: the renderer drops the app's resources (the app sends them again)
        if (!c.place || pl.w !== c.place.w || pl.h !== c.place.h || pl.s !== c.place.s) C.res.clear();
        c.place = pl; C.place = whole;
        wantTick();
        break;
    }
    case M.SHOW:
        c.visible = !!u(0); C.show = whole;
        if (c.visible) wantTick(); else state(c);
        connChanged();
        break;
    case M.ATLAS: if (12 + u(1) * u(2) > p.length || u(1) > 4096 || u(2) > 4096) throw new Bad('atlas size'); res('atlas:' + u(0), true); break;
    case M.RAMP: if (u(1) > 64 || p.length < 8 + u(1) * 4) throw new Bad('ramp'); res('ramp:' + u(0), true); break;
    case M.LAYER: res('layer:' + u(0), true); break;
    case M.DROP_LAYER: res('layer:' + u(0), false); break;
    case M.FRAME:
        C.frame = whole;
        Tick.busy = true; wantTick();
        // nobody watching: take frames at 10 a second
        if (!pages.size && !Tick.headless) Tick.headless = setTimeout(() => { Tick.headless = null; drawn(); }, 100);
        else if (pages.size) late();
        break;
    case M.M9: {
        // upstream IMAGE or IterioDev's CLAIM (src/dialect.c)
        const w = p.length >= 12 ? u(1) : 0, h = p.length >= 12 ? u(2) : 0;
        if (!c.dialect) c.dialect = w >= 1 && w <= 4096 && h >= 1 && h <= 4096 && p.length >= 12 + w * h * 4 ? 'upstream' : 'iterio';
        if (c.dialect === 'upstream') {
            if (w < 1 || h < 1 || w > 4096 || h > 4096 || p.length < 12 + w * h * 4) throw new Bad('image size');
            res('img:' + u(0), true);
            break;
        }
        const n = u(0);
        if (n > 16 || p.length < 4 + n * 16) throw new Bad('claims');
        c.claims = [];
        for (let i = 0; i < n; i++) c.claims.push({ x: p.readFloatLE(4 + i * 16), y: p.readFloatLE(8 + i * 16), w: p.readFloatLE(12 + i * 16), h: p.readFloatLE(16 + i * 16) });
        C.claim = whole;
        connChanged();
        break;
    }
    case M.M10:
        if (!c.dialect) c.dialect = p.length === 4 ? 'upstream' : 'iterio';
        if (c.dialect === 'upstream') { c.grab = !!u(0); C.grab = whole; connChanged(); break; }
        if (p.length < 12 || u(1) < 1 || u(2) < 1 || u(1) > 1024 || u(2) > 1024 || p.length !== 12 + u(1) * u(2) * 4) throw new Bad('image size');
        res('img:' + u(0), true);
        break;
    case M.DROP_IMAGE: if (!c.dialect) c.dialect = 'iterio'; res('img:' + u(0), false); break;
    case M.FPS: if (c.dialect !== 'upstream') { c.fps = Math.min(1000, u(0)); C.fps = whole; connChanged(); } break;
    case M.VIDEO: if (c.dialect !== 'upstream') res('video:' + u(0), true); break;
    case M.DROP_VIDEO: res('video:' + u(0), false); break;
    case X.GRAB: c.grab = !!u(0); C.grab = whole; connChanged(); break;
    case X.PIXMAP: {
        const w = u(1), h = u(2), f = u(3);
        // (a bad size or format is the renderer's ERROR, not a dropped client: nothing to keep then)
        if (w < 1 || h < 1 || w > 2048 || h > 2048 || f < 1 || f > 3) { res('img:' + u(0), false); break; }
        C.res.delete('img:' + u(0));
        C.res.set('img:' + u(0), { pixmap: whole, w, h, bpp: f === 3 ? 1 : 4, px: null });
        break;
    }
    case X.PIXELS: pixels(C.res.get('img:' + u(0)), p); break;
    case X.PALETTE: res('pal:' + u(0), true); break;
    default: break;
    }
}

/**
 * X_PIXELS: the rects written into a copy of the pixmap here, so the replay is one full write
 * however many updates came (memory: the pixmap's size, at most 16 MiB).
 */
function pixels(e, p) {
    if (p.length < 8) throw new Bad('pixel rects');
    const n = p.readUInt32LE(4);
    if (n < 1 || n > 64 || p.length < 8 + n * 16) throw new Bad('pixel rects');
    if (!e || !e.pixmap) return;                    // no such pixmap: the renderer's ERROR
    if (!e.px) e.px = Buffer.alloc(e.w * e.h * e.bpp);
    let o = 8 + n * 16;
    for (let i = 0; i < n; i++) {
        const x = p.readUInt32LE(8 + i * 16), y = p.readUInt32LE(12 + i * 16), w = p.readUInt32LE(16 + i * 16), h = p.readUInt32LE(20 + i * 16);
        const row = w * e.bpp;
        if (x + w > e.w || y + h > e.h || o + row * h > p.length) throw new Bad('pixel rect');
        for (let r = 0; r < h; r++) p.copy(e.px, ((y + r) * e.w + x) * e.bpp, o + r * row, o + (r + 1) * row);
        o += row * h;
    }
}

/** A page that connects now (or made a new renderer) gets the connection so far: HELLO, placement, the resources, the last frame. */
function replay(ws) {
    ws.send(connInfo());
    if (!R || !R.cache.hello) return;
    const C = R.cache, list = [C.hello, C.mode, C.place];
    C.res.forEach((v, k) => {
        if (Array.isArray(v)) { list.push.apply(list, v); return; }
        list.push(v.pixmap);
        if (v.px) {
            const head = Buffer.alloc(24);
            head.writeUInt32LE(Number(k.slice(4)), 0); head.writeUInt32LE(1, 4); head.writeUInt32LE(v.w, 16); head.writeUInt32LE(v.h, 20);
            list.push(msg(X.PIXELS, null, Buffer.concat([head, v.px])));
        }
    });
    list.push(C.claim, C.grab, C.fps, C.show, C.frame);
    ws.send({ t: 'reset', app: R.id });
    ws.send(Buffer.concat(list.filter(Boolean)));
}

/** X_STATE (native): mode, on screen (shown with a frame drawn), in front (always: no foreground gate here). */
function state(c) {
    const on = c.visible && !!c.cache.frame;
    if (on === c.onScreen) return;
    if (c.dialect === 'native') toApp(msg(X.STATE, [1, on ? 1 : 0, 1]));
    c.onScreen = on;
    connChanged();
}

/* TICK: the app sends its next frame when the last one is drawn (the page's {t:'tick'}), at most fps a second */
function wantTick() { Tick.want = true; pump(); }
/**
 * A page ticks from requestAnimationFrame, which a page that is not painted (a background tab, a hidden pane, a
 * minimised window) does not run: no tick 200 ms after a frame, and the frames count as drawn when they come (pump
 * keeps the FPS cap, and a frame still queued to a page holds the next: the pages' reading paces it) until a page
 * ticks at a refresh rate again (two ticks within 100 ms: a hidden pane's stray tick about once a second is not).
 */
function late() {
    if (Tick.stalled) { afterRead(); return; }
    if (!Tick.late) Tick.late = setTimeout(() => { Tick.late = null; if (Tick.busy && pages.size) { Tick.stalled = true; drawn(); } }, 200);
}
/**
 * Stalled: the frame counts as drawn once nothing is queued to a page (written to the socket; polled, as 'drain'
 * comes only after a write over the socket's high-water mark). One wait at a time; a page that goes holds nothing.
 */
function afterRead() {
    if (Tick.reading) return;
    const poll = () => {
        Tick.reading = null;
        if (!Tick.stalled || !Tick.busy) return;
        if (Array.from(pages).some((x) => x.open && x.sock.writableLength)) { Tick.reading = setTimeout(poll, 2); return; }
        drawn();
    };
    Tick.reading = setImmediate(poll);
}
function drawn() { Tick.busy = false; if (R) state(R); pump(); }
function pump() {
    // (no ticks for a hidden app: it is not on screen, as when the user left it for the app picker)
    if (!R || !R.visible || !Tick.want || Tick.busy || Tick.timer) return;
    const caps = [pageFps, R.fps].filter((x) => x > 0), cap = caps.length ? Math.min.apply(null, caps) : 0;
    const wait = cap ? Tick.last + 1000 / cap - Date.now() : 0;
    if (wait > 1) { Tick.timer = setTimeout(() => { Tick.timer = null; pump(); }, wait); return; }
    Tick.want = false; Tick.last = Date.now();
    toApp(msg(E.TICK, [++Tick.n, Date.now() - T0]));
}

/* touch: a gesture that starts inside a claim is the app's (TOUCH, logical px); one outside goes to the HMI, which
   hides a claiming app (CLOSED). Without touch routing every gesture is the HMI's. The HMI's part: home and back in
   its column; a tap released elsewhere goes to the app process, which presses the HMI bar button under it (if any). */
function touch(m) {
    const c = R, x = Number(m.x), y = Number(m.y), ph = Number(m.phase);
    if (!isFinite(x) || !isFinite(y) || [1, 2, 3].indexOf(ph) < 0) return;
    if (ph === 1) {
        let mine = false;
        if (c && c.touch && c.visible && c.place && c.claims.length) {
            const lx = (x - c.place.x - c.place.ox) / c.place.s, ly = (y - c.place.y - c.place.oy) / c.place.s;
            mine = c.claims.some((r) => lx >= r.x && lx < r.x + r.w && ly >= r.y && ly < r.y + r.h);
            if (!mine) {
                // hidden until the app shows itself again: a page that connects meanwhile draws nothing
                toApp(msg(E.CLOSED, [])); c.visible = false; c.cache.show = msg(M.SHOW, [0]); state(c); connChanged();
            }
        }
        // the HMI's own column (the app's surface leaves it see-through): home at the top, back below
        const col = x < BACK_COL.w && y < BACK_COL.h;
        if (col) {
            const a = y < BACK_COL.head ? 'home' : 'back';
            toChild({ t: 'hmi', a }); appLog('info', 'HMI: ' + a);
        }
        // (with touch routing too: a tap outside the claims is the HMI's, so it presses an HMI bar button there, as on the car)
        Hmi.down = mine || col ? null : { x, y };
        if (c) c.gesture = mine;
    }
    if (ph === 3 && Hmi.down) {
        const d = Hmi.down;
        Hmi.down = null;
        if (Math.abs(x - d.x) < 30 && Math.abs(y - d.y) < 30) toChild({ t: 'tap', x: d.x, y: d.y });
    }
    if (!c || !c.gesture || !c.place) return;
    const lx = (x - c.place.x - c.place.ox) / c.place.s, ly = (y - c.place.y - c.place.oy) / c.place.s;
    const b = Buffer.alloc(12);
    b.writeUInt32LE(ph, 0); b.writeFloatLE(lx, 4); b.writeFloatLE(ly, 8);
    toApp(msg(E.TOUCH, null, b));
    if (ph === 3) c.gesture = false;
}
const Hmi = { down: null };          // a gesture the HMI has (where it went down)

/* the iDrive controller: FrontCCU state (knob counter, press, push). To the app as X_CCU / CCU while it grabs (and is
   shown); the FrontCCU signal always; the HMI moves its focus when nobody grabs */
const Ccu = { seq: 0, knob: 0, pb: 0, df: 0 };
const TILT = { N: 1, E: 4, S: 7, W: 10 };       // FrontCCU deflection, short push (display.js TILT, doom controls.js DEFL)
function ccu(m) {
    if (m.turn) {
        let n = Math.max(-64, Math.min(64, Math.round(Number(m.turn)) || 0));
        while (n) { const s = Math.max(-16, Math.min(16, n)); n -= s; Ccu.knob = (Ccu.knob + s) & 0xffff; ccuSend(); }
        return;
    }
    if (m.press !== undefined) Ccu.pb = m.press ? 1 : 0;
    if (m.tilt !== undefined) Ccu.df = TILT[m.tilt] || 0;
    ccuSend();
}
function ccuSend() {
    Ccu.seq = (Ccu.seq + 1) & 255;
    const grabbed = !!(R && R.grab && R.visible);
    if (grabbed) {
        const b = Buffer.alloc(8);
        b[0] = Ccu.seq; b.writeUInt16BE(Ccu.knob, 1); b[3] = Ccu.pb; b[4] = Ccu.df;
        toApp(msg(R.dialect === 'native' ? X.CCU : E.CCU, null, b));
    }
    toChild({ t: 'ccu', grabbed, ev: { seq: Ccu.seq, knob: Ccu.knob, pb: Ccu.pb, df: Ccu.df } });
}

// STATS once a second: the page's renderer numbers (the panel's figures are the page's own, in one window)
let gstats = null;
const u32 = (x) => Math.max(0, Math.min(0xffffffff, Math.round(Number(x)) || 0));
setInterval(() => {
    try {
        if (R && R.visible && gstats) toApp(msg(E.STATS, [u32(gstats.fps), u32(gstats.avgMs * 1000), u32(gstats.maxMs * 1000)].concat(R.dialect === 'native' ? [0] : [])));
    } catch (e) { console.error('emu: stats: ' + e); }
}, 1000).unref();

/* ---------------- the page's messages ---------------- */
const Sig = { mode: 'demo', v: { rpm: 900, speed: 0, coolant: 90, oil: 95, gear: 'P', gLong: 0, gLat: 0, torque: 40 } };
const SIG_KEYS = ['rpm', 'speed', 'coolant', 'oil', 'gLong', 'gLat', 'torque'];
function onPage(ws, m) {
    switch (m.t) {
    case 'tick': {
        // (stalled: a page that paints again ticks twice within 100 ms; a lone tick leaves the server's pace as it is)
        const now = Date.now();
        if (!Tick.stalled || now - Tick.pageAt < 100) { clearTimeout(Tick.late); Tick.late = null; Tick.stalled = false; }
        Tick.pageAt = now;
        if (Tick.busy) drawn();
        break;
    }
    case 'fps': pageFps = Math.max(0, Math.min(1000, Number(m.n) || 0)); pump(); break;
    case 'gstats': gstats = { fps: m.fps, avgMs: m.avgMs, maxMs: m.maxMs }; break;
    case 'touch': touch(m); break;
    case 'ccu': ccu(m); break;
    case 'hmi':
        if (['back', 'home', 'open'].indexOf(m.a) < 0) break;
        appLog('info', 'HMI: ' + m.a + (m.screen ? ' ' + m.screen : ''));
        if (m.a === 'open') {
            App.openNext = false;                       // (the app shown now is the one asked for)
            if (!App.child) { App.openNext = true; if (!App.building) build(); break; }   // crashed: start it, opened
        }
        toChild({ t: 'hmi', a: m.a, screen: m.screen && String(m.screen) });
        break;
    case 'click': toChild({ t: 'click', id: String(m.id) }); break;
    case 'set': toChild({ t: 'set', k: String(m.k), v: m.v }); break;
    case 'sig':
        Sig.mode = m.mode === 'manual' ? 'manual' : 'demo';
        if (m.v && typeof m.v === 'object') {
            SIG_KEYS.forEach((k) => { if (isFinite(Number(m.v[k]))) Sig.v[k] = Number(m.v[k]); });
            if (/^(P|R|N|D[1-9])$/.test(m.v.gear)) Sig.v.gear = m.v.gear;
        }
        toChild({ t: 'sig', mode: Sig.mode, v: Sig.v });
        pages.forEach((w) => { if (w !== ws) w.send({ t: 'sigmode', mode: Sig.mode, v: Sig.v }); });
        break;
    // another app (the panel's list, or its tile in the page's app picker): opened when it has started
    case 'app': if (listApps().indexOf(m.id) >= 0 && m.id !== appId) { appId = m.id; App.openNext = true; watch(); build(); } break;
    case 'restart': build(); break;
    // the page's renderer found a malformed message: end the connection as the car's daemon does
    case 'drop': if (R) { appLog('error', 'renderer: bad message (' + String(m.why).slice(0, 200) + '), connection closed'); R.sock.destroy(); } break;
    // what the car's renderer sends the app as ERROR (an upload past its limits, a bad pixmap, ...)
    case 'rerror': if (R) toApp(msg(E.ERROR, null, Buffer.from(String(m.s).slice(0, 256)))); break;
    case 'replay': replay(ws); break;
    // the renderer offers touch routing or not: the app reads that when it connects, so it reconnects now
    case 'touch-routing':
        if (!!m.on === Touch.on) break;
        Touch.on = !!m.on;
        appLog('info', 'emu: touch routing ' + (Touch.on ? 'on (the kit runs the screen)' : 'off (the slim bar over the HMI\'s buttons)'));
        toPages({ t: 'touchmode', on: Touch.on });
        toChild({ t: 'reconnect' });
        break;
    default: break;
    }
}

/* ---------------- the app: build, child process, live reload ---------------- */
const App = { lock: null, waiting: null, closed: false, opened: false, openNext: false, child: null, childId: null, gen: 0, exiting: null, deferred: null, loading: false, status: { t: 'status', s: 'starting' }, log: [], spec: null, values: null, stack: [], soft: null, building: null, again: false };
function appLog(l, s) {
    const lines = String(s).replace(/\s+$/, '').split('\n').map((x) => [l, x]);
    App.log.push.apply(App.log, lines);
    if (App.log.length > 2000) App.log.splice(0, App.log.length - 1500);
    toPages({ t: 'log', lines });
    if (l === 'error' || /^(emu|renderer):/.test(s)) console.log((l === 'error' ? '! ' : '  ') + lines.map((x) => x[1]).join('\n    '));
}
function setStatus(s, text, id) { App.status = { t: 'status', s, app: id || appId, text: text || '' }; toPages(App.status); console.log('emu: ' + (id || appId) + ' ' + s); }
const toChild = (m) => { if (App.child && App.child.connected) App.child.send(m); };

/**
 * Another emulator may build the same app (two instances watch the same apps/<id>), and the builds share dist/<id>:
 * a lock file (the owner's pid) per app, held from the build until the started app has read its modules (or the
 * build failed). A lock whose owner is gone is taken over at once.
 */
function lockBuild(id) {
    const f = path.join(ROOT, 'dist', '.emu-build-' + id + '.lock');
    try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, String(process.pid), { flag: 'wx' }); return f; } catch (e) {
        if (e.code !== 'EEXIST') return f;              // (dist/ not writable: build.py says why)
        let pid = 0;
        try { pid = Number(fs.readFileSync(f, 'utf8')) || 0; } catch (x) { /* just went */ }
        let alive = pid > 0;
        try { if (pid) process.kill(pid, 0); } catch (x) { alive = x.code === 'EPERM'; }
        if (!alive) { try { fs.unlinkSync(f); } catch (x) { /* raced */ } return lockBuild(id); }
        return null;
    }
}
function unlockBuild() {
    const f = App.lock;
    App.lock = null;
    if (f) try { if (fs.readFileSync(f, 'utf8') === String(process.pid)) fs.unlinkSync(f); } catch (e) { /* gone */ }
}
function build() {
    // (also not while a new app loads its modules from dist/: the build would rewrite them under it)
    if (App.building || App.loading) { App.again = true; return; }
    const id = appId, t0 = Date.now();
    if (App.lock && App.lock !== path.join(ROOT, 'dist', '.emu-build-' + id + '.lock')) unlockBuild();
    if (!App.lock) App.lock = lockBuild(id);
    if (!App.lock) {
        if (App.waiting !== id) { App.waiting = id; setStatus('building', 'waiting for another emulator\'s build of ' + id); appLog('info', 'emu: waiting for another emulator\'s build of ' + id); }
        App.building = setTimeout(() => { App.building = null; build(); }, 250);
        return;
    }
    App.waiting = null;
    setStatus('building');
    let outText = '';
    const p = App.building = spawn('python3', [path.join(ROOT, 'kit', 'tools', 'build.py'), id], { cwd: ROOT });
    p.stdout.on('data', (d) => { outText += d; });
    p.stderr.on('data', (d) => { outText += d; });
    p.on('error', (e) => { outText += String(e); });
    p.on('close', (code) => {
        App.building = null;
        if (App.again || id !== appId) { App.again = false; build(); return; }
        if (code !== 0) {
            unlockBuild();
            appLog('error', 'emu: build failed\n' + outText);
            // a newly chosen app that does not build: the one running stays the current app (watched, restarted)
            if (App.childId && id !== App.childId && App.child) { appId = App.childId; App.openNext = false; watch(); }
            setStatus('build-error', outText, id);
            if (App.deferred && !App.child) start(App.deferred);
            return;
        }
        appLog('info', 'emu: built ' + id + ' in ' + (Date.now() - t0) + ' ms');
        start(id);
        // (the lock goes when the started app has loaded: unlockBuild in start; a safety net if it never does)
        setTimeout(() => { if (!App.building && !App.loading) unlockBuild(); }, 15000);
    });
}

/** The running app goes; cb once it has exited (an app on its way out is waited for, whoever asked first). */
function stop(cb) {
    const ch = App.child;
    App.child = null;
    if (ch && ch.exitCode === null && ch.signalCode === null) {
        App.exiting = new Promise((res) => {
            const k = setTimeout(() => ch.kill('SIGKILL'), 1500);
            ch.once('exit', () => { clearTimeout(k); res(); });
        });
        ch.kill('SIGTERM');
    }
    (App.exiting || Promise.resolve()).then(cb);
}

/** dist/<id> in a new child (the newest start wins: one asked for while an old app exits replaces it). */
function start(id) {
    const gen = ++App.gen;
    stop(() => {
        if (gen !== App.gen || App.child) { if (!App.building) unlockBuild(); return; }
        // a build is rewriting dist/: it starts the app when it is done (or this one, should it fail)
        if (App.building) { App.deferred = id; return; }
        App.deferred = null;
        setStatus('starting', '', id);
        App.stack = []; App.soft = null;
        toPages({ t: 'soft', png: null });              // (the old app's picture in the HMI goes)
        const data = path.join(ROOT, 'preview', 'emu', id);
        fs.mkdirSync(data, { recursive: true });
        // the user left the app (the page shows the HMI's app picker): a rebuilt app starts without opening, as one
        // the car restarts in the background; a newly chosen app opens
        App.opened = false;
        const env = Object.assign({}, process.env, { MGU_RENDERD_SOCKET: SOCK, MGU_EMU_CLOSED: App.closed && !App.openNext ? '1' : '' });
        App.openNext = false;
        delete env.MGU_RENDERD_FILE;
        const ch = App.child = fork(path.join(__dirname, 'hu-stub.js'), [path.join(ROOT, 'dist', id), data], { cwd: data, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        App.childId = id; App.loading = true;
        const loaded = () => { if (App.child !== ch && App.child) return; App.loading = false; unlockBuild(); if (App.again) { App.again = false; build(); } };
        const lines = (l) => (d) => { if (App.child === ch) String(d).split('\n').filter((x) => x.trim()).forEach((x) => appLog(l, x)); };
        ch.stdout.on('data', lines('info'));
        ch.stderr.on('data', lines('error'));
        ch.on('error', (e) => appLog('error', 'emu: app process: ' + e.message));
        ch.on('message', (m) => {
            if (App.child !== ch) return;
            if (m.t === 'log') appLog(m.l, m.s);
            else if (m.t === 'loaded') loaded();
            else if (m.t === 'spec') {
                App.spec = m.spec; App.values = m.values;
                toPages({ t: 'spec', spec: m.spec, values: m.values });
                setStatus('running', '', id);
                toChild({ t: 'sig', mode: Sig.mode, v: Sig.v });
            } else if (m.t === 'settings') { App.values = m.values; toPages(m); }
            else if (m.t === 'screens') {
                // closed: the app's last screen went (BACK, HOME) - the HMI's app picker shows until it is opened again
                App.stack = m.stack;
                if (m.stack.length) { App.opened = true; App.closed = false; } else if (App.opened) App.closed = true;
                toPages({ t: 'screens', stack: m.stack, closed: App.closed });
            }
            else if (m.t === 'soft') { App.soft = m.png; toPages({ t: 'soft', png: m.png }); }
            else if (m.t === 'focus' || m.t === 'note') toPages(m);
        });
        ch.on('exit', (code, sig) => {
            if (App.child === ch || !App.child) loaded();
            if (App.child !== ch) return;
            App.child = null;
            setStatus('exited', 'exit ' + (sig || code), id);
            appLog('error', 'emu: the app exited (' + (sig || 'code ' + code) + '); save a file or press Restart');
        });
    });
}

let watchers = [];
function watch() {
    watchers.forEach((w) => w.close());
    let t = null;
    const kick = (dir) => (ev, f) => {
        if (f && /(^|[/\\])\.|~$|\.swp$/.test(f)) return;            // editor temp files
        clearTimeout(t);
        t = setTimeout(() => { appLog('info', 'emu: ' + path.relative(ROOT, path.join(dir, String(f || ''))) + ' changed'); build(); }, 150);
    };
    watchers = [path.join(ROOT, 'apps', appId), path.join(ROOT, 'kit', 'runtime')].map((d) => {
        let w;
        try { w = fs.watch(d, { recursive: true }, kick(d)); } catch (e) { w = fs.watch(d, kick(d)); }   // (recursive: macOS, Windows, Linux on Node 20+)
        w.on('error', (e) => appLog('warn', 'emu: watching ' + path.relative(ROOT, d) + ': ' + e.message));
        return w;
    });
}

/* ---------------- go ---------------- */
try { fs.unlinkSync(SOCK); } catch (e) {}
daemon.listen(SOCK, () => {
    server.listen(PORT, '127.0.0.1', () => {
        console.log('emu: http://localhost:' + PORT + '  (renderer socket ' + SOCK + ')');
        watch();
        build();
    });
});
server.on('error', (e) => { console.error('emu: ' + e.message); cleanup(1); });
function cleanup(code) {
    watchers.forEach((w) => w.close());
    if (App.building && App.building.kill) { try { App.building.kill(); } catch (e) { /* gone */ } }
    unlockBuild();
    const ch = App.child;
    if (ch) { try { ch.kill('SIGKILL'); } catch (e) {} }
    try { fs.unlinkSync(SOCK); } catch (e) {}
    process.exit(code || 0);
}
process.on('SIGINT', () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));
process.on('exit', () => { try { fs.unlinkSync(SOCK); } catch (e) {} });
