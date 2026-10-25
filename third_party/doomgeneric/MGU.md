# doomgeneric for the iDrive Doom app

The game engine of `apps/doom`: [doomgeneric](https://github.com/ozkl/doomgeneric) (GPL-2.0, see
`LICENSE`), upstream commit `e257a09`, with these changes (all in `mgu.patch`):

- `doomgeneric/doomgeneric_mgu.c` (new): the platform layer. Doom runs as WebAssembly inside the
  app's Node.js process; JavaScript (`apps/doom/doom-core.js`) gives the time and the keys and takes
  each 320 x 200 frame. Extra exports for the app: controller turning (`mgu_turn`, one mouse move
  per tic), game state, save / load, new game, next / previous weapon keys.
- `doomgeneric/i_video.c`: `MGU_RGBA` - frames in RGBA byte order with opaque alpha, as the GPU
  renderer takes them.

`build.sh` builds `apps/doom/doom.wasm` from this folder (the committed `doom.wasm` is built from
exactly this source).
