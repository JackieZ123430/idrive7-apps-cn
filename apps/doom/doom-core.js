'use strict';
/**
 * doom-core.js - runs Doom (doomgeneric, compiled to WebAssembly: doom.wasm) inside the app.
 *
 *   const game = new Doom({ wasm, wadDir, dataDir, log, args: ['-skill', '3'] });
 *   game.start();
 *   game.key(true, KEY.UP);           // press / release Doom keys
 *   game.run();                       // ticks at 35 Hz; game.onFrame(rgba, w, h) after each drawn frame
 *
 * Node 8 has no WASI, so the few system calls the C library makes are done here over `fs`:
 * one preopened directory "/", where "/wad/..." is the bundled game data (read-only) and
 * everything else (config, save games) lives in the app's data folder. 64-bit arguments arrive
 * as two 32-bit halves (the build runs binaryen's --legalize-js-interface for Node 8).
 */
const fs = require('fs');
const path = require('path');

const KEY = { RIGHT: 0xae, LEFT: 0xac, UP: 0xad, DOWN: 0xaf, USE: 0xa2, FIRE: 0xa3, ESCAPE: 27, ENTER: 13, RSHIFT: 0x80 + 0x36, Y: 121, N: 110, NEXTW: 93, PREVW: 91, SLEFT: 0xa0, SRIGHT: 0xa1 };
const GS = { LEVEL: 0, INTERMISSION: 1, FINALE: 2, DEMO: 3 };
const PST = { LIVE: 0, DEAD: 1, REBORN: 2 };
const E = { OK: 0, BADF: 8, EXIST: 20, INVAL: 28, IO: 29, ISDIR: 31, NOENT: 44, NOSYS: 52 };
const TIC_MS = 1000 / 35;
/** milliseconds on a monotonic clock (the wall clock can jump: GPS / network time sync) */
function mono() { const t = process.hrtime(); return t[0] * 1000 + t[1] / 1e6; }

class Exit extends Error { constructor(code) { super('doom exited (' + code + ')'); this.code = code; } }

class Doom {
    constructor(opts) {
        this.o = opts;
        this.log = opts.log || console;
        this.fds = new Map();            // wasi fd -> { fd (node), pos, path }
        this.nextFd = 4;
        this.t0 = mono();
        this.dead = null;
        this.frameReady = false;
        this.timer = null;
        this.paused = false;
        this.onFrame = null;
        this.out = '';
    }

    /* ---------- memory helpers (views are made fresh: memory.grow detaches them) ---------- */
    get u8() { return new Uint8Array(this.mem.buffer); }
    get dv() { return new DataView(this.mem.buffer); }
    str(p, n) { return Buffer.from(this.mem.buffer, p, n).toString('utf8'); }

    /** where a guest path points on disk: { file, ro } or null */
    resolve(p) {
        p = p.replace(/^\/+/, '').replace(/^\.\//, '');
        if (p.split('/').indexOf('..') >= 0) return null;
        if (p.indexOf('wad/') === 0) return { file: path.join(this.o.wadDir, p.slice(4)), ro: true };
        return { file: path.join(this.o.dataDir, 'doom', p), ro: false };
    }

    imports() {
        const self = this;
        const w = {
            fd_close(fd) { const f = self.fds.get(fd); if (!f) return E.BADF; try { fs.closeSync(f.fd); } catch (e) { /* ignore */ } self.fds.delete(fd); return E.OK; },
            fd_fdstat_get(fd, p) {
                const dv = self.dv;
                const type = fd <= 2 ? 2 : fd === 3 ? 3 : self.fds.has(fd) ? 4 : -1;
                if (type < 0) return E.BADF;
                for (let i = 0; i < 24; i++) dv.setUint8(p + i, 0);
                dv.setUint8(p, type);
                dv.setUint32(p + 8, 0xffffffff, true); dv.setUint32(p + 12, 0xffffffff, true);
                dv.setUint32(p + 16, 0xffffffff, true); dv.setUint32(p + 20, 0xffffffff, true);
                return E.OK;
            },
            fd_fdstat_set_flags() { return E.OK; },
            fd_prestat_get(fd, p) {
                if (fd !== 3) return E.BADF;
                const dv = self.dv; dv.setUint32(p, 0, true); dv.setUint32(p + 4, 1, true);
                return E.OK;
            },
            fd_prestat_dir_name(fd, p, n) { if (fd !== 3) return E.BADF; if (n >= 1) self.u8[p] = 47; return E.OK; },
            fd_read(fd, iovs, n, nread) {
                const f = self.fds.get(fd);
                if (!f) { self.dv.setUint32(nread, 0, true); return fd === 0 ? E.OK : E.BADF; }
                let total = 0;
                try {
                    for (let i = 0; i < n; i++) {
                        const dv = self.dv, b = dv.getUint32(iovs + i * 8, true), len = dv.getUint32(iovs + i * 8 + 4, true);
                        if (!len) continue;
                        const got = fs.readSync(f.fd, Buffer.from(self.mem.buffer, b, len), 0, len, f.pos);
                        f.pos += got; total += got;
                        if (got < len) break;
                    }
                } catch (e) { return E.IO; }
                self.dv.setUint32(nread, total, true);
                return E.OK;
            },
            fd_write(fd, iovs, n, nwritten) {
                let total = 0;
                const f = self.fds.get(fd);
                try {
                    for (let i = 0; i < n; i++) {
                        const dv = self.dv, b = dv.getUint32(iovs + i * 8, true), len = dv.getUint32(iovs + i * 8 + 4, true);
                        const buf = Buffer.from(self.mem.buffer, b, len);
                        if (fd === 1 || fd === 2) self.print(buf.toString('utf8'));
                        else if (f) { fs.writeSync(f.fd, buf, 0, len, f.pos); f.pos += len; } else return E.BADF;
                        total += len;
                    }
                } catch (e) { return E.IO; }
                self.dv.setUint32(nwritten, total, true);
                return E.OK;
            },
            fd_seek(fd, lo, hi, whence, out) {
                const f = self.fds.get(fd);
                if (!f) return E.BADF;
                const off = (hi | 0) * 4294967296 + (lo >>> 0);
                let base = 0;
                if (whence === 1) base = f.pos;
                else if (whence === 2) { try { base = fs.fstatSync(f.fd).size; } catch (e) { return E.IO; } }
                const np = base + off;
                if (np < 0) return E.INVAL;
                f.pos = np;
                const dv = self.dv; dv.setUint32(out, np >>> 0, true); dv.setUint32(out + 4, Math.floor(np / 4294967296), true);
                return E.OK;
            },
            path_open(dirfd, dirflags, p, plen, oflags, rbLo, rbHi, riLo, riHi, fdflags, out) {
                if (dirfd !== 3) return E.BADF;
                const r = self.resolve(self.str(p, plen));
                if (!r) return E.NOENT;
                const creat = oflags & 1, dir = oflags & 2, excl = oflags & 4, trunc = oflags & 8;
                const write = (rbLo & 0x40) !== 0 || creat || trunc;
                if (dir) { try { return fs.statSync(r.file).isDirectory() ? E.NOSYS : E.NOENT; } catch (e) { return E.NOENT; } }
                if (write && r.ro) return E.NOENT;
                let flag = write ? (trunc ? 'w+' : 'r+') : 'r';
                try {
                    if (write) {
                        mkdirp(path.dirname(r.file));
                        if (excl && fs.existsSync(r.file)) return E.EXIST;
                        if (!fs.existsSync(r.file)) { if (!creat) return E.NOENT; flag = 'w+'; }
                    }
                    const nfd = fs.openSync(r.file, flag);
                    if (fs.fstatSync(nfd).isDirectory()) { fs.closeSync(nfd); return E.ISDIR; }
                    const id = self.nextFd++;
                    self.fds.set(id, { fd: nfd, pos: 0, path: r.file });
                    self.dv.setUint32(out, id, true);
                    return E.OK;
                } catch (e) { return e.code === 'ENOENT' ? E.NOENT : E.IO; }
            },
            path_create_directory(dirfd, p, n) { const r = self.resolve(self.str(p, n)); if (!r || r.ro) return E.NOENT; try { mkdirp(r.file); return E.OK; } catch (e) { return E.IO; } },
            path_remove_directory() { return E.NOSYS; },
            path_unlink_file(dirfd, p, n) { const r = self.resolve(self.str(p, n)); if (!r || r.ro) return E.NOENT; try { fs.unlinkSync(r.file); return E.OK; } catch (e) { return E.NOENT; } },
            path_rename(fd1, p1, n1, fd2, p2, n2) {
                const a = self.resolve(self.str(p1, n1)), b = self.resolve(self.str(p2, n2));
                if (!a || !b || a.ro || b.ro) return E.NOENT;
                try { fs.renameSync(a.file, b.file); return E.OK; } catch (e) { return E.NOENT; }
            },
            proc_exit(code) { throw new Exit(code); },
            random_get(p, n) { const u = self.u8; for (let i = 0; i < n; i++) u[p + i] = (Math.random() * 256) | 0; return E.OK; },
        };
        const env = {
            js_ticks: () => Math.floor(mono() - self.t0) >>> 0,
            js_frame: () => { self.frameReady = true; },
        };
        return { wasi_snapshot_preview1: w, env };
    }

    print(s) {
        this.out += s;
        let i;
        while ((i = this.out.indexOf('\n')) >= 0) { const line = this.out.slice(0, i).trim(); this.out = this.out.slice(i + 1); if (line) this.log.info('doom: ' + line); }
    }

    /** Load and start the game (synchronous compile: a few seconds on the head unit, once). */
    start() {
        // Node 8's mkdirSync has no { recursive }: make the data folder by hand
        mkdirp(path.join(this.o.dataDir, 'doom'));
        const t = Date.now();
        const mod = new WebAssembly.Module(fs.readFileSync(this.o.wasm));
        this.inst = new WebAssembly.Instance(mod, this.imports());
        this.mem = this.inst.exports.memory;
        this.x = this.inst.exports;
        this.log.info('doom: wasm ready in ' + (Date.now() - t) + ' ms');
        this.x._initialize();
        const args = ['doom', '-iwad', '/wad/' + (this.o.wad || 'freedoom1.wad')].concat(this.o.args || []);
        const s = Buffer.from(args.join('\n') + '\0', 'utf8');
        if (s.length > 1024) throw new Error('doom: arguments too long');
        this.u8.set(s, this.x.mgu_argbuf());
        this.guard(() => this.x.mgu_start());
        this.w = this.x.mgu_width(); this.h = this.x.mgu_height();
    }

    guard(fn) {
        if (this.dead) return;
        try { fn(); } catch (e) {
            this.dead = e;
            this.stop();
            if (e instanceof Exit) this.log.info('doom: ' + e.message); else this.log.error('doom crashed', e);
            if (this.onDead) this.onDead(e);
        }
    }

    key(down, k) { if (!this.dead && this.x) this.x.mgu_key(down ? 1 : 0, k); }
    /** turn by a mouse-like amount (+ = right; 0x8 angle units each, 65536 = a full circle) */
    turn(dx) { if (!this.dead && this.x && dx) this.x.mgu_turn(Math.round(dx)); }

    /** { gamestate, playerstate, health, menu, level } */
    state() {
        if (!this.x || this.dead) return null;
        const v = this.x.mgu_state() >>> 0;
        return { gamestate: v & 0xff, playerstate: (v >> 8) & 0xff, health: (v >> 16) & 0xff, menu: !!(v & (1 << 30)), level: this.x.mgu_level() };
    }
    /** a saved game in this slot? (Doom keeps them as .savegame/doomsav<n>.dsg) */
    hasSave(slot) { return fs.existsSync(this.resolve('.savegame/doomsav' + slot + '.dsg').file); }
    /** Save now (while playing a level): Doom saves on its next tics, so a few are run at once. */
    save(slot) {
        const st = this.state();
        if (!st || st.gamestate !== GS.LEVEL || st.playerstate !== PST.LIVE || st.menu) return false;
        this.x.mgu_save(slot);
        this.steps(4);
        return true;
    }
    load(slot) {
        if (!this.x || this.dead || !this.hasSave(slot)) return false;
        this.x.mgu_load(slot);
        this.steps(2);
        return true;
    }
    /** start a new game (skill 1..5, episode 1..4) */
    newGame(skill, episode) { if (this.x && !this.dead) { this.x.mgu_newgame(skill | 0, episode | 0); } }
    /** run n tics right now (the game clock moves on with them) */
    steps(n) {
        for (let i = 0; i < n; i++) {
            this.t0 -= TIC_MS;
            if (this.tick() && this.onFrame) this.onFrame(this.frame(), this.w, this.h);
        }
    }

    /** The 3D view of the last frame in full resolution, or null when the frame had none
     *  (menu screens, intermission, automap): { px (RGBA, valid until the next tick), w, h }.
     *  Its pixels are 1.2 times taller than wide, like Doom's: show it stretched to h * 1.2.
     *  The 320 x 200 frame() then has the view's part see-through (alpha 0) to go on top. */
    view() {
        if (!this.x || this.dead || !this.x.mgu_view_on || !this.x.mgu_view_on()) return null;
        const w = this.x.mgu_view_w(), h = this.x.mgu_view_h();
        return { px: new Uint8Array(this.mem.buffer, this.x.mgu_view_ptr(), w * h * 4), w, h };
    }
    /** walking speed in % of Doom's own (20..100; running is not changed) */
    walk(percent) { if (this.x && !this.dead && this.x.mgu_walk) this.x.mgu_walk(percent | 0); }
    /** render size of the 3D view (up to 1920 x 640) */
    setRes(w, h) { if (this.x && !this.dead && this.x.mgu_set_res) this.x.mgu_set_res(w | 0, h | 0); }
    /** the status bar's border texture, 64 x 64 RGBA (for the sides of a wide screen), or null */
    flat() {
        const p = this.x && !this.dead && this.x.mgu_flat ? this.x.mgu_flat() : 0;
        return p ? new Uint8Array(this.mem.buffer, p, 64 * 64 * 4).slice() : null;
    }

    /** the last frame: RGBA bytes (a view into the game's memory, valid until the next tick) */
    frame() { return new Uint8Array(this.mem.buffer, this.x.mgu_screen(), this.w * this.h * 4); }

    /** One game step; returns true when a new frame was drawn. */
    tick() {
        this.frameReady = false;
        this.guard(() => this.x.mgu_tick());
        return this.frameReady;
    }

    /** Tick at 35 Hz, aligned to Doom's clock (each call then has a new tic: no busy waiting inside). */
    run() {
        if (this.timer || this.dead) return;
        const loop = () => {
            this.timer = null;
            if (this.paused || this.dead) return;
            if (this.tick() && this.onFrame) this.onFrame(this.frame(), this.w, this.h);
            const now = mono() - this.t0, next = (Math.floor(now / TIC_MS) + 1) * TIC_MS;
            this.timer = setTimeout(loop, Math.max(1, Math.ceil(next - now) + 1));
        };
        this.timer = setTimeout(loop, 0);
    }
    stop() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
    /** while paused the game clock stands still (no catching up afterwards) */
    pause(on) {
        on = !!on;
        if (on && !this.paused) this.pausedAt = mono();
        if (!on && this.paused && this.pausedAt != null) { this.t0 += mono() - this.pausedAt; this.pausedAt = null; }
        this.paused = on;
        if (on) this.stop(); else this.run();
    }
}

function mkdirp(d) {
    if (fs.existsSync(d)) return;
    mkdirp(path.dirname(d));
    try { fs.mkdirSync(d); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}

module.exports = { Doom, KEY, GS, PST, TIC_MS };
