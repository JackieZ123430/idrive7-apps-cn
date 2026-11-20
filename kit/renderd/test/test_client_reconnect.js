'use strict';
/*
 * js/mgu_render_client.js on a real Unix socket: the renderer sends half a READY and dies, the client connects
 * again. The bytes cut off with the first connection must not stay in front of the new renderer's READY (it
 * read the next header from the middle of them and waited for a message that never came: a blank app).
 *   node test/test_client_reconnect.js
 */
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RenderClient } = require('../js/mgu_render_client');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'renderd-'));
const sock = path.join(dir, 'sock');
const done = (ok, what) => {
    console.log((ok ? 'ok   ' : 'FAIL ') + what);
    console.log(ok ? 'test_client_reconnect: all passed' : 'test_client_reconnect: 1 failed');
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(ok ? 0 : 1);
};
// X_READY (101): version, w, h
const ready = (w, h) => { const b = Buffer.alloc(20); b.writeUInt32LE(101, 0); b.writeUInt32LE(12, 4); b.writeUInt32LE(1, 8); b.writeUInt32LE(w, 12); b.writeUInt32LE(h, 16); return b; };
let n = 0;
const srv = net.createServer((s) => {
    n++;
    s.on('error', () => {});
    if (n === 1) { s.write(ready(800, 480).slice(0, 6)); setTimeout(() => s.destroy(), 50); }
    else s.write(ready(1920, 720));
});
srv.listen(sock, () => {
    const gpu = new RenderClient('test', { info() {}, warn() {}, error() {} }, { socket: sock, native: true });
    gpu.on('ready', (scr) => { gpu.close(); srv.close(); done(n === 2 && scr && scr.w === 1920, 'READY after a reconnect (connection ' + n + ', ' + JSON.stringify(scr) + ')'); });
    gpu.connect();
    setTimeout(() => done(false, 'READY after a reconnect: none in 5 s (' + gpu.inbuf.length + ' bytes held)'), 5000);
});
