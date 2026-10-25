# doomgeneric for the iDrive Doom app

The game engine of `apps/doom`: [doomgeneric](https://github.com/ozkl/doomgeneric) (GPL-2.0, see
`LICENSE`), upstream commit `e257a09`, with these changes (all in `mgu.patch`):

- `doomgeneric/doomgeneric_mgu.c` (new): the platform layer. Doom runs as WebAssembly inside the
  app's Node.js process; JavaScript (`apps/doom/doom-core.js`) gives the time and the keys and takes
  each 320 x 200 frame. Extra exports for the app: controller turning (`mgu_turn`, one mouse move
  per tic), game state, save / load, new game, next / previous weapon keys, the full-resolution
  3D view (`mgu_view_*`, `mgu_set_res`) and the status bar's border texture (`mgu_flat`).
- High-resolution 3D view (`mgu_hires.h`, `r_main.c`, `r_draw.c`, `r_plane.*`, `r_things.*`,
  `r_state.h`, `r_defs.h`, `d_main.c`): the view is drawn into its own buffer, up to 1920 x 640,
  size set at run time (`r_width` / `r_height`, default 1920 x 504). Doom's vertical field of view
  is kept and the horizontal one widened to the buffer's shape; the arrays sized by the screen
  width / height are sized for the maximum, and the visplane spans are 16-bit. The 320 x 200 screen
  keeps the status bar, menus, messages, intermission and automap; where the view is, it is filled
  with palette index 16 (`MGU_SEETHROUGH`, used by none of those graphics) for the app to draw the
  view under it. The screen wipe and the view border are off.
- `doomgeneric/i_video.c`: `MGU_RGBA` - frames in RGBA byte order with opaque alpha, as the GPU
  renderer takes them; the see-through marking over the 3D view becomes transparent (all zero).
  The palette (`colors`) is shared with the view conversion.

`build.sh` builds `apps/doom/doom.wasm` from this folder (the committed `doom.wasm` is built from
exactly this source).
