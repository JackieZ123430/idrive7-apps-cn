# mgu-gfx: the car's GPU renderer in a browser

`kit/renderd/src/gfx.c`, the draw engine of `mgu-renderd`, compiled unchanged to WebAssembly and
drawn with WebGL 2 on the PC's GPU: the same shader, the same quads, the same pixels as on the
head unit, at well under a millisecond a frame (the Docker replay with llvmpipe takes ~180 ms).

| File | What |
|---|---|
| `emu_gfx.c` | one app on a 1920 x 720 screen: `handle()` from `src/main.c` without the compositor, the app's surface blitted at its PLACE rect |
| `emu_lib.js` | the WebGL 2 context (no multisampling: gfx.c anti-aliases by itself) |
| `build.sh` | Emscripten in Docker (`emscripten/emsdk:6.0.12`) -> `../web/gfx/mgu-gfx-wasm.{js,wasm}` |
| `../web/gfx/mgu-gfx.js` | the module to import |
| `../web/gfx/gfx-test.html` | feeds a stream, compares with `mgu-renderd --replay` |

The built files are committed, so nothing needs Docker. After a change to `gfx.c`, `dialect.c`,
`proto.h` or this folder: `kit/emu/wasm/build.sh` (the same input gives the same bytes; Emscripten's
cache goes to `~/.cache/mgu-emu-emcache`, or `$EM_CACHE_DIR`).

## API

```js
import { createGfx } from './gfx/mgu-gfx.js';
const gfx = await createGfx(canvas, { onLost });  // 1920 x 720 canvas; makes its WebGL 2 context
gfx.feed(u8);       // client -> renderer bytes (PROTOCOL.md), any dialect, split anywhere; 1 drawn, 0 not, -1 dropped
gfx.reset();        // the app restarted: the next bytes start with HELLO again
gfx.stats();        // { frames, lastMs, avgMs, visible, place: {x,y,w,h} | null, dialect, app, error,
                    //   lost, atlasFull, errors: { count, last: [newest first, up to 4] } }
gfx.readPixels();   // the screen as shown: Uint8Array RGBA 1920*720*4, rows top-down
gfx.destroy();      // the GL context and the module let go (browsers keep ~16 contexts); later calls throw
```

As on the car:

- `feed()` reads every whole message, then draws the newest FRAME (the daemon draws at the next
  vsync what came by then). Feed one FRAME at a time for every frame. At most 256 MB in one call.
- The surface shows at the PLACE rect while SHOW is on and a frame is drawn; the rest of the
  screen is transparent. A new size drops the app's layers, images and atlases (it sends them
  again); a move keeps the picture. Native `X_MODE 2` (embed) draws in the HMI box of the default
  config (104,88 1796x632), with or without PLACE; `stats().place` is then the box.
- A malformed message drops the client (`stats().error`); `reset()` takes the next one.
  Resource errors the car sends as E_ERROR (atlas or image refused) are in `stats().errors`.
- Glyph atlases are shared by every client since the start, as in the daemon: `reset()` keeps them.
  When the shared texture is full (`stats().atlasFull`: an app sent new atlases many times), text
  goes missing: `destroy()` and `createGfx()` again.
- A lost WebGL context does not come back: `feed()` returns -1, `readPixels()` throws,
  `stats().lost` and `error: 'context lost'`, and `onLost` is called once. Make a new renderer.
- `lastMs` / `avgMs` are the CPU time of the draw calls (the GPU runs after); `avgMs` is since
  the renderer was made. The browser rounds `performance.now()` to 0.1 ms unless the page is
  cross-origin isolated (`kit/tools/emu.js` sends COOP and COEP: µs steps). The emulator's panel
  takes `lastMs` after each `feed()` that drew, for the average and maximum of each second.

Parsed and ignored: GRAB, CLAIM, FPS, VIDEO / DROP_VIDEO (op 19 draws nothing: no `/dev/shm`).
Nothing goes back to the app: READY, TICK and STATS are the host's to send.
display-bridge's DBR1 apps are dropped.

## Test

```sh
python3 kit/tools/build.py redline
node kit/tools/preview.js dist/redline preview/redline-gpu/png wait=12 render --set coldGuard=false --gpu preview/redline-gpu/stream.bin
docker run --rm -v $PWD/kit/renderd/build:/b -v $PWD/preview/redline-gpu:/o mgu-renderd-build \
    /lib64/ld-linux-x86-64.so.2 /b/mgu-renderd --replay /o/stream.bin --out /o/frame.pam --raw /o/frames.rgba
python3 -m http.server 8765
# http://localhost:8765/kit/emu/web/gfx/gfx-test.html?stream=/preview/redline-gpu/stream.bin&ref=/preview/redline-gpu/frame.pam&raw=/preview/redline-gpu/frames.rgba
```

`&show` sends SHOW 1 first, for a stream recorded without one (Doom's): `--replay` draws the
surface either way. `&play` then plays it one frame a display frame.

Against `mgu-renderd --replay` (llvmpipe), Chrome on an Apple M5 Pro (ANGLE Metal), every frame:
the kit's apps (redline, car_vitals, gforce) and IterioDev's recorded screens differ by at most
3 of 255, mean 0.01-0.13; Doom and the pixmap / picture sessions are identical; nine mipmapped
1024 px pictures drawn small differ by at most 11 (the GPU makes the mipmaps).

## Licence

GPL-3.0-or-later, as `kit/renderd` (`kit/renderd/LICENSE`): `emu_gfx.c` holds code from
`kit/renderd/src/main.c`, and the build in `kit/emu/web/gfx` (`mgu-gfx-wasm.js`, `.wasm`, and the
loader `mgu-gfx.js`) contains `gfx.c`, `dialect.c` and `log.c`. Their complete source is
`kit/renderd/src` and this folder; `build.sh` rebuilds the module from it byte for byte. The parts
from this repository's first renderer are also MIT (`kit/renderd/LICENSE.mgu-renderd`).
