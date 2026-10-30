// mgu-gfx.js - the head unit's GPU renderer (kit/renderd/src/gfx.c as WebAssembly, kit/emu/wasm) drawing into a canvas.
// GPL-3.0-or-later, as kit/renderd (kit/renderd/LICENSE), like the module it loads.
//
//   import { createGfx } from './gfx/mgu-gfx.js';
//   const gfx = await createGfx(canvas, { onLost });   // 1920 x 720; WebGL 2 context made here
//   gfx.feed(u8);         // client -> renderer bytes (PROTOCOL.md), any dialect; draws the newest FRAME. 1 drawn, 0 not, -1 dropped
//   gfx.reset();          // the app restarted: the next bytes start with HELLO again
//   gfx.stats();          // { frames, lastMs, avgMs, visible, place, dialect, app, error, lost, atlasFull, errors: { count, last } }
//   gfx.readPixels();     // the screen as shown: RGBA, rows top-down
//   gfx.destroy();        // the GL context and the module let go; later calls throw
// A lost WebGL context (the GPU reset, too many contexts) does not come back here: feed() returns -1, readPixels()
// throws, stats().lost; make a new renderer (destroy() this one first). opts.onLost is told once.
import createMguGfxWasm from './mgu-gfx-wasm.js';

const DIALECTS = ['undecided', 'upstream', 'iterio', 'native', 'display-bridge'];

export async function createGfx(canvas, opts = {}) {
    let lost = false, gone = false;
    const onLost = (e) => {
        e.preventDefault();
        if (lost || gone) return;
        lost = true;
        console.warn('[mgu-gfx] WebGL context lost: make a new renderer');
        if (opts.onLost) opts.onLost();
    };
    canvas.addEventListener('webglcontextlost', onLost);
    let M = await createMguGfxWasm({
        canvas,
        print: opts.log || ((s) => console.log('[mgu-gfx] ' + s)),
        printErr: opts.warn || ((s) => console.warn('[mgu-gfx] ' + s)),
    });
    const W = canvas.width, H = canvas.height;
    if (M._emu_init(W, H) < 0) {
        const e = M.UTF8ToString(M._emu_error());
        M._emu_destroy(); canvas.removeEventListener('webglcontextlost', onLost);
        throw new Error('mgu-gfx: ' + e);
    }
    let dead = false;
    const live = () => { if (gone) throw new Error('mgu-gfx: destroyed'); };
    return {
        feed(u8) {
            live();
            if (lost) return -1;
            if (!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8.buffer || u8, u8.byteOffset || 0, u8.byteLength);
            if (!u8.length) return dead ? -1 : 0;
            const p = M._emu_buf(u8.length);
            if (!p) throw new Error('mgu-gfx: out of memory (' + u8.length + ' bytes in one feed)');
            M.HEAPU8.set(u8, p);
            const r = M._emu_feed(u8.length);
            if (r < 0 && !dead) console.warn('[mgu-gfx] client dropped: ' + M.UTF8ToString(M._emu_error()));
            dead = r < 0;
            return r;
        },
        reset() { live(); dead = false; if (!lost) M._emu_reset(); },
        stats() {
            live();
            const p = M._emu_stats(), i = M.HEAP32.subarray(p >> 2, (p >> 2) + 12), f = M.HEAPF64.subarray((p + 48) >> 3, ((p + 48) >> 3) + 2);
            const last = [];
            for (let k = 0; k < Math.min(i[9], 4); k++) last.push(M.UTF8ToString(M._emu_err(k)));
            return {
                frames: i[0], lastMs: f[0], avgMs: f[1], visible: !lost && !!i[1],
                place: i[2] ? { x: i[3], y: i[4], w: i[5], h: i[6] } : null,
                dialect: DIALECTS[i[7]] || 'undecided',
                app: M.UTF8ToString(M._emu_app()),
                error: lost ? 'context lost' : i[8] ? M.UTF8ToString(M._emu_error()) : null,
                lost,
                atlasFull: !!i[10],             // the shared glyph atlas is full: text goes missing until a new renderer
                errors: { count: i[9], last },  // what the car sends as E_ERROR (newest first)
            };
        },
        readPixels() {
            live();
            if (lost) throw new Error('mgu-gfx: context lost');
            const p = M._emu_read();
            if (!p) throw new Error('mgu-gfx: readPixels failed');
            return M.HEAPU8.slice(p, p + W * H * 4);
        },
        destroy() {
            if (gone) return;
            gone = true;
            canvas.removeEventListener('webglcontextlost', onLost);
            M._emu_destroy();
            M = null;
        },
    };
}
