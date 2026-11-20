'use strict';
/*
 * js/mgu_render_client.js against a fake socket that keeps pictures and layers as main.c does: a PLACE with a new
 * size drops them all, one with only a new scale keeps them (the app sends its layers again for the new scale). After a
 * scale-only PLACE the client must not upload pictures the renderer still holds as if they were gone: past the
 * renderer's 64 pictures they are refused and drawn blank.
 *   node test/test_client_place.js
 */
const { RenderClient } = require('../js/mgu_render_client');

let fails = 0;
const check = (cond, what) => { console.log((cond ? 'ok   ' : 'FAIL ') + what); if (!cond) fails++; };

// the renderer's side (main.c handle, gfx.c image_room): GFX_IMG_MAX pictures an app
const daemon = { w: 0, h: 0, images: new Map(), layers: new Set(), refused: 0, imageMsgs: 0, layerMsgs: 0 };
let inbuf = Buffer.alloc(0);
const sock = {
    write(b) {
        inbuf = Buffer.concat([inbuf, b]);
        while (inbuf.length >= 8) {
            const type = inbuf.readUInt32LE(0), len = inbuf.readUInt32LE(4);
            if (inbuf.length < 8 + len) break;
            const p = inbuf.slice(8, 8 + len);
            inbuf = inbuf.slice(8 + len);
            if (type === 2) {                          // PLACE
                const w = p.readInt32LE(8), h = p.readInt32LE(12);
                if (w !== daemon.w || h !== daemon.h) { daemon.images.clear(); daemon.layers.clear(); }
                daemon.w = w; daemon.h = h;
            } else if (type === 10) {                  // IMAGE
                const id = p.readUInt32LE(0);
                daemon.imageMsgs++;
                if (!daemon.images.has(id) && daemon.images.size >= 64) daemon.refused++;
                else daemon.images.set(id, true);
            } else if (type === 11) {                  // DROP_IMAGE
                daemon.images.delete(p.readUInt32LE(0));
            } else if (type === 6) {                   // LAYER
                daemon.layerMsgs++;
                daemon.layers.add(p.readUInt32LE(0));
            }
        }
        return true;
    },
    destroy() {},
};

const imageById = new Map();
for (let id = 1; id <= 100; id++) imageById.set(id, { w: 4, h: 4, data: Buffer.alloc(64, id) });
const layerById = new Map([[1, { w: 10, h: 10, words: new Uint32Array([1, 0]) }]]);
const kit = { imageById, layerById, atlasById: () => null, rampList: [], pack: (c) => c };
const gpu = new RenderClient('test', { info() {}, warn() {} }, { kit });
gpu.sock = sock;
gpu.connected = gpu.ready = gpu.native = true;

const range = (a, b) => { const s = new Set(); for (let i = a; i <= b; i++) s.add(i); return s; };
const frame = (images) => gpu.frame({ images, layersUsed: [1], words: () => new Uint32Array([1, 0]) });
const holds = (images) => [...images].every((id) => daemon.images.has(id));

gpu.place({ x: 0, y: 0, w: 800, h: 480, scale: 1, ox: 0, oy: 0 });
frame(range(1, 40));
check(daemon.images.size === 40 && !daemon.refused, '40 pictures uploaded');

gpu.place({ x: 0, y: 0, w: 800, h: 480, scale: 1.5, ox: 0, oy: 0 });
let msgs = daemon.imageMsgs;
frame(range(21, 60));
check(daemon.imageMsgs === msgs + 20, 'a new scale: the pictures the renderer keeps are not sent again');
check(daemon.layerMsgs === 2, 'a new scale: the layer is sent again for it');
frame(range(61, 100));
check(!daemon.refused, '40 more pictures are not refused (the client drops old ones first)');
check(holds(range(61, 100)), 'the renderer holds every picture the frame draws');

gpu.place({ x: 0, y: 0, w: 900, h: 480, scale: 1.5, ox: 0, oy: 0 });
msgs = daemon.imageMsgs;
frame(range(41, 80));
check(daemon.imageMsgs === msgs + 40 && holds(range(41, 80)) && !daemon.refused, 'a new size: all pictures are sent again');
check(daemon.layerMsgs === 3, 'a new size: the layer is sent again');

gpu.place({ x: 10, y: 0, w: 900, h: 480, scale: 1.5, ox: 0, oy: 0 });
msgs = daemon.imageMsgs;
frame(range(41, 80));
check(daemon.imageMsgs === msgs && daemon.layerMsgs === 3, 'a move: nothing is sent again');

console.log(fails ? 'test_client_place: ' + fails + ' failed' : 'test_client_place: all passed');
process.exit(fails ? 1 : 0);
