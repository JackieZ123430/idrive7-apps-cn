# mgu-render changelog

## Unreleased

- The controller gate (`mgu-inputgate.so`) can hold parts of the iDrive controller: the words `knob`, `press`, `tilt` in its file (`/run/mgu-renderd/inputgate`) name what the HMI doesn't get while an app grabs it; the parts not named stay the HMI's (an app that holds the knob and the press still lets a tilt leave it). An empty file, what every renderer writes today, holds all three as before, and so do words it doesn't know. The library carries the marker `mgu-inputgate-hold:` for renderers to find (mgu-store's mgu-render offers `controllerHold` then). Needs the gate rebuilt (`make build/mgu-inputgate.so` in the build image) and copied to `inputgate/tool/` with its version raised.

## idrive7-apps mgu-renderd 2.1.18

- The controller gate on iDrive 8 (to try, issue #152): whether the gate is loaded is now looked up in Hmi8 too (iDrive 8's HMI; HmiMain3D on iDrive 7), so apps there are offered the controller once `mgu-inputgate.so` runs in it. The HMI's surface is still looked up by `hmi_process` only (unchanged layout on iDrive 8).
- `mgu-app-install.sh inputgate` sets the gate up for `hmi8.service` / `Hmi8` on iDrive 8 (same boot guard: two starts without the HMI coming up healthy with it and it is left out), and takes the Store's renderer (`idrive7-renderd`) as the renderer it needs. iDrive 7 gets the same files as before.

## idrive7-apps mgu-renderd 2.1.17

- Beside IterioDev's renderer (his App Manager's service package, or the Store's `mgu-renderd` tool): it binds the same community socket and uses the same ivi ids, so the two cannot run together. While it is installed (its `mgu-renderd.service`, started with `--socket`) or a `mgu-renderd --socket` runs, this renderer stands down: it says so once, sets up nothing (socket, touch divert, layers) and looks again every 30 s; once it is gone it starts. Its apps and ours then draw on IterioDev's renderer.
- The kit installer (`mgu-app-install.sh renderd`) no longer overwrites a `mgu-renderd.service` that is not its own (IterioDev's has the same name), and the Store package's install step removes only the kit installer's unit (its marker line), never IterioDev's.

## idrive7-apps mgu-renderd 2.1.16

- Up to 64 apps connected at once (was 16). While this renderer has the community socket, IterioDev's apps connect to it as well as ours; with both sets installed on an iDrive 8 car the 16 slots filled and the later apps (ours among them) drew in the HMI's text screen (issue #152). A slot costs only while its app is connected, and pictures stay under the all-apps limit as before.

## idrive7-apps mgu-renderd 2.1.15

- iDrive 8 from the Store: the Store package is for iDrive 7 and iDrive 8 (component.json `mguHmi`). Its unit no longer passes iDrive 7's touch area (`touch_area=84,0,1836,720`): the renderer's built-in default for a 1920 x 720 screen is now that area (right of the back column, the title strip included, for the kit's page tabs), and a 2880 x 960 screen gets iDrive 8's app area. Same for `mgu-app-install.sh renderd`, which no longer looks for Hmi8 to leave it out. The page template step already does nothing on iDrive 8 (no HmiMain3D).

## idrive7-apps mgu-renderd 2.1.14

- Touch beside the MGU Store's renderer: our divert runs after the other renderers' (nft priority -299, theirs -300), so with both in, theirs sees a touch first. The Store's overlays are drawn over our apps: a tap on one is its own, and what it doesn't want comes on to us over lo. At the same priority the order was the tables', and once IterioDev's overlays were on, a tap could close our app as "the HMI was touched" (iDrive 8 car, issue #152).
- A touch handed to the HMI is logged with where it was and where it came from (the display, the Store's renderer, IterioDev's).

## idrive7-apps mgu-renderd 2.1.13

- Touch beside the MGU Store's renderer: the divert also takes the touches the Store's renderer (from port 30571) and IterioDev's (30569) hand on to the HMI over lo. The Store's renderer keeps its divert in all the time while an overlay of its claims (IterioDev's overlays), sees every touch first and passes the ones outside its claims to the HMI past our rule: on an iDrive 8 car our apps got no touch at all, and the taps reached the HMI under them (issue #152). Ours (30573) are not taken back: nothing loops.

## idrive7-apps mgu-renderd 2.1.12

- Layers: an app's layer goes on the centre screen through a connection made for it and closed again (as mgu-render's `src/relist.c`), not through the renderer's own. Winston applies a screen's `add_layer` to the layer list as the calling connection last saw it, so through the long-open connection every layer another program had put on the screen since the renderer started was taken off whenever an app was shown again. Seen on a car: a movie player's own layer flashed off on each BACK of its app (59 times in 34 BACKs; 0 in 8 with this change).
- Layers: an app's layer goes on top of the screen when it is first shown and before it is made visible (it could show under another program's layer for a frame); should that fail, it goes on through the renderer's own connection, as before (the app shows; other programs' layers may go).

## idrive7-apps mgu-renderd 2.1.11

- Foreground gate: a uuid that an earlier install's left-behind folder still claims goes to the install the app manager has registered (its registry, `oap_12201/data/apps`). Such an app drew in the HMI's own picture on every open, whichever the Renderer setting.

## idrive7-apps mgu-renderd 2.1.10

- Touch: the divert rule goes to nft in a file (`/tmp/mgu-render-nft-*`), and a load counts only when the table is then there. The nft of MainApp 6.5.5 cars cannot read a script from `-`: the rule never went in while the log said `touch: diverted`, and touches never reached the apps.

## idrive7-apps mgu-renderd 2.1.9

- Foreground gate on an app manager without `src-gen/de_bmw_infotainment_hmi_remote_RemoteHmiApplication.json` (MainApp 6.5.5's single bundle): the description is looked for in the `src-gen` folders of the packages under `/usr/lib`; without one the gate says `foreground unavailable` once and stays, and the renderer shows the apps as without a gate. Before, the gate exited at start every 5 s and the apps drew in the HMI's own picture.

## idrive7-apps mgu-renderd 2.1.8

upstream idrive7-apps 2.1.7, on this fork's 2.1.7:

- An app that sends faster than the renderer reads no longer grows its input buffer without limit: the renderer
  handles the whole messages after each read, holds at most one message being received (24 MiB and 128 KiB more)
  and reads about that much an app per wakeup, so one busy app does not hold up the others. A failed allocation
  closes that app's connection instead of crashing the renderer.
- Ramps: a ramp's row is freed with the app's resources (a new size or a disconnect). Before, rows were handed out
  in a ring of 256 shared by all apps, so after enough ramps one app's ramp took the row of another app's and
  drew in its colours. A ramp past the limits (64 an app, 256 rows for all apps) now gets an ERROR and is logged;
  a new row with no colours is cleared, not left with the last owner's.
- Foreground gate: a failed pipe or fork closes the pipes it opened, and a failed fork no longer leaves pid -1, which
  stopping the gate would have signalled (every process).
- js/mgu_render_client.js: a scale-only PLACE keeps the pictures, atlases and ramps, as the renderer does (they were
  uploaded again, and past 64 pictures refused); after a reconnect a message cut off with the old connection no
  longer blocks the new one's messages.
- Tests: test_gate, test_client_read, test_ramp, test_client_place and test_client_reconnect in `make test`.

## idrive7-apps mgu-renderd 2.1.7

- Apps fit the screen the HMI is shown on. The renderer finds the HMI's own surface (by its process, `hmi_process`)
  and follows where the compositor shows it and at what size; apps still lay out on the HMI's design size (1920 x
  720, or 2880 x 960 when the HMI's buffer has that size) and their layers are scaled and moved onto the HMI's
  rectangle, so they line up with the HMI's title strip, back column and status icons wherever it is: an iDrive 6
  retrofit's or an 8.8" screen, a custom display, the HMI centred on a larger one. Touch is mapped back to the
  design size. Before, everything was placed in 1920 x 720 screen px and ran off a smaller screen (issue #42).
  Until the HMI's surface is there, the centre output's mode is used, as before. In-page drawing (embed) is offered
  only while the HMI's buffer has the design size. The log names every output, the HMI's surface with its buffer
  and position, and the mapping (`screen: ...`). `ivi-probe dst <surface> x y w h` moves a surface, to try a
  screen size on the VM.
- 2.1.5 reverted: an app's layer is no longer put straight back when the HMI takes it off the screen. The HMI
  takes it off on purpose when it draws over a shown app (camera, call, popup, its own screens) and sets its layers
  again on each change of its scene, so the two kept undoing each other: the screen swapped between the HMI and the
  app (seen on a car; reproduced on the VM). As in 2.1.4 the layer goes back on top each time the app is shown;
  an app taken off while shown (the Store updating another app) stays blank until it is opened again.
- An HMI surface makes the layer apps yield the screen only while it is visible and has a size (its configuration). The camera / driver-assistance video (dasvideo, surface 0x198) can stay visible at 0x0 on no layer from boot, showing nothing: every app and the Store were then hidden until the next reboot (seen on the car: "surface 0x198 visible: layer apps yield the screen" at start, never hidden again).

## idrive7-apps mgu-renderd 2.1.5

- An app's layer taken off the centre screen while its app is shown (the compositor reports it: the layer's `screen` event with no output) goes straight back on, on top. The HMI's scene or the app manager's in-place update of another app could set the screen's layers without it while it stayed visible: a blank page until the app was shown again (seen on the car: the Store blank after it updated an app).

## idrive7-apps mgu-renderd 2.1.4

- An app's layer goes back on the centre screen, on top, each time it is shown: another renderer (the MGU Store's beside idrive7-apps') or the HMI could set the screen's layers without it, and the app then showed a black page (seen on the car after opening the Store, then an app).

## idrive7-apps mgu-renderd 2.1.3

- Merged with this repository's 2.0.2: serving the community socket, our layers and surfaces use the community
  renderer's ivi ids (`0x4d470000`, `0x4d470100`), so an app on ours and one on the Store's mgu-render (its own
  `0x4d520000`, `0x4d520100`) never share a layer or surface.
- `mgu-app-install.sh renderd` removes an `idrive7-renderd` installed through the Store (with the Store's deploy tool)
  before installing its own.
- The units pass `touch_area=84,0,1836,720`: apps may claim the title strip too, where the kit draws its page tabs
  (iDrive 7's default left it out, so a tab could not be tapped). Only what an app claims is its; the HMI's own icons
  there stay the HMI's.
- 2.0.2's touch hand-over (ours leaving touch to an installed mgu-render) is gone: each has its own divert (2.1.0).

## idrive7-apps mgu-renderd 2.1.2

- Installed from the Store (idrive7-renderd 2.1.2, which every app requires), it removes the old renderer it replaces
  (`idrive7-renderd-install.sh`, its postInstall, at every install): the kit installer's `mgu-renderd.service` and its
  enablement, `/var/opt/mgu-renderd/mgu-renderd` and the unit copies set aside in `/var/opt/mgu-renderd/retired/`. A
  `mgu-renderd` the Store installed itself stays. Then the HMI page template is made, as before.
- `mgu-app-install.sh`'s template unit (`mgu-renderd-hmi.service`) stands down once the Store's `idrive7-renderd` has
  taken its renderer over, so only the Store's template unit mounts (the original repository's Renderer 2.0.1).

## idrive7-apps mgu-renderd 2.1.1

- The HMI page template, its folder and the boot's copy of the HMI's widgets are readable by the HMI's user (0644
  files, 0755 folders) whatever umask the install runs with: with umask 077 the HMI showed an in-page app's page empty
  (robertnisipeanu/mgu-store mgu-render 0.6.1, pull request #48).

## idrive7-apps mgu-renderd 2.1.0

- Runs beside the MGU Store's mgu-render: the apps' renderer, the Store's its own. The touch divert has its own table
  and ports (`touch_table`, `touch_port`: `ip idrive7_render`, 30572 in and 30573 out; the Store's stays `ip mgu_render`,
  30570 and 30571), and on `lo` each lets the other's re-injections through. The units delete only that table when they stop.
- The apps connect to `/run/mgu-renderd/renderd.sock` first, the Store's `/run/mgu-render/render.sock` only when theirs is not there.
- In the Store the apps require it (idrive7-renderd 2.1.0), so updating the apps installs it again where it was removed.

## idrive7-apps mgu-renderd 2.0.0 (mgu-render 0.5.1)

- This repository's renderer is now mgu-render, from robertnisipeanu/mgu-store `native/mgu-render` (1d9dfec), built
  as `mgu-renderd` (`kit/renderd`) and installed by `mgu-app-install.sh renderd` as before: same unit, directory and
  socket (`/run/mgu-renderd/renderd.sock`, which it then binds itself: no link to make).
- `--socket`, `--group` and `--screen` (the first renderer's flags) map to `socket_path`, `socket_group` and `screen_id`;
  `socket_group` takes a group number too.
- Without a conf file or `-s foreground_gate=...`, the foreground gate is `foreground_gate.js` beside the binary when it is
  there; `foreground_gate=` turns it off.
- `shared_path` equal to `socket_path` serves no link.

## 0.5.1

- A zero-copy frame is committed once its GL commands are flushed (`glFlush`), relying on the GPU driver's implicit sync, so the renderer's loop is not held while the GPU draws; `embed_finish = 1` waits for the GPU (`glFinish`).
- A display-bridge app's frame (DOOM) on zero-copy is uploaded at its own size and scaled into the GPU buffer by GL, to the nearest pixel, black around it.
- While `/run/mgu-render/stats-log` exists, an embed app's stats line has the HMI's frame callbacks in that second and the time from commit to callback.

## 0.5.0

- Embed frames are drawn straight into GPU buffers the HMI's compositor shows (zero-copy): three linear XRGB8888 dmabufs from GBM (`libgbm.so.1`, loaded when needed), each the texture of an FBO, given to the compositor with `wl_drm`'s `create_prime_buffer`. Used when the compositor offers `wl_drm` v2 with PRIME and XRGB8888 and the renderer's EGL imports dmabufs; otherwise frames are read back into its shared memory as before, and so until mgu-render restarts once the compositor refused the buffers (a `wl_drm` protocol error; mgu-render reconnects at once) or they could not be made. The journal says `embed: zero-copy` or `embed: readback fallback (<why>)`, and lists the compositor's globals. `embed_zero_copy = 0` reads back always.
- With zero-copy, display-bridge's apps' pixels go into the GPU buffers too (drawn by GL as a picture): the HMI's compositor shows a GPU buffer with red and blue swapped once the surface id has shown a shared-memory buffer in that HMI run.
- Embed frames are drawn top-down, so a readback is one copy (no rows turned); anti-aliased edges can differ from 0.4.0's by a few levels.
- `tick_early` (on): an embed app gets its TICK once its last frame is drawn and no drawn frame waits, so it builds frame N+1 while the HMI shows frame N; that frame is drawn while the compositor still has the one before and committed at its frame callback.
- `readback_pbo` (on): the readback goes through a pixel buffer (GLES 3) and is copied into the compositor's buffer just before that frame is committed.
- STATS has a fourth word for native apps (1: the frames were drawn zero-copy), X_READY's caps have 32 (embed zero-copy), and while `/run/mgu-render/stats-log` exists each shown app's frames a second, render time and frame path are logged once a second.

## 0.4.1

- The HMI page template is made when mgu-render is installed or updated (`mgu-render-hmi.sh --build`, the deploy tool's `postInstall`; needs mgu-deploy 0.6.1), at low priority for at most 120 s, never before the HMI: `mgu-render-hmi.service` only mounts a template made for the installed HmiMain3D, the generator and the surface id, else leaves the stock widgets, so the HMI and the cluster's map start without waiting for it. An install whose boot-time build never finished gets its template with this update; embed is offered from the next start of the head unit.
- `/var/opt/mgu-render/status.json` says how the last build went: `template` `ok`, `building` or `failed`, the `stamp` it was for, the `reason` and, when it failed, `problem` (`In-page drawing unavailable: <reason>`), which the Store shows on the Renderer's page (mgu-updater 0.8.1, Store 0.9.7). A build the generator refuses (identifiers it cannot find in this HmiMain3D) is not tried again until the stamp changes; any other failure (the time limit, a signal, memory or disk) is tried again at the next install.

## 0.4.0

- Video, from IterioDev mgu-renderd 1.2.0 protocol 4, for third-party apps in the iterio and native dialects: a player writes decoded frames (I420, up to 2048×2048, BT.601 or BT.709, limited or full range) to `/dev/shm/mgu-video-<name>` in up to four slots; the app names the file (VIDEO 13, DROP_VIDEO 14) and draws op 19 where the picture goes, fitted into the box with its aspect kept and a corner radius, under and over its other ops. Each new frame draws the app's last frame again without a message from the app; a shown app still sends at least one message a second, as IterioDev's kit does. Only `/dev/shm/mgu-video-*` regular files of the app's uid, root or `nobody` (IterioDev's mgu-ytplay) are opened (no links); others get an ERROR. A video counts w×h×3 bytes towards limits of its own, 12 MiB an app and 32 MiB all apps; a frame size past them is logged and the frame shown before stays. A frame the file is too short for draws the frame shown before, and the app is not redrawn for it until seq changes. READY's version is 4, X_READY's caps have 16 (video), and `js/mgu_render_client.js` has `video()` and `videoOp()`. Video streams from IterioDev's kit, which its YouTube app (IterioDev/car-apps) draws with, replay unchanged (`make test`).

## 0.3.1

- iDrive 8: an app's screens drawn by the renderer show there (the renderer finds which app is in front on its HMI).

## 0.3.0

- display-bridge's apps (mgu-apps DOOM, draw_gallery, display_bridge_demo) draw through mgu-render, unchanged: it speaks display-bridge's protocol DBR1 (`src/dbr.c`; a connection whose first bytes are its magic) on display-bridge's socket `/dev/shm/display-bridge/bridge.sock`, a link to its own while nothing else listens there. Their frames (INDEX8 with a palette, XRGB, ARGB, RGBA; whole or in regions) go into a pixmap drawn fitted into the HMI page's box as display-bridge places them, each answered PRESENTED or DROPPED; touch on the picture comes as their TOUCH in frame pixels.
- Embed mode draws a frame as soon as it comes and commits it at the compositor's next frame callback (four buffers), so a frame is ready the moment the HMI is; display-bridge's apps' frames are written into the buffer on the CPU, with no GL readback.
- display-bridge's own units (`display-bridge.socket`, `.service`, `-hmi.service`) stand down while mgu-render is installed (a drop-in with `ConditionPathExists=!/var/opt/mgu-render/current/mgu-render`, from the next head-unit start): one embed provider, one page template, one foreground gate. Uninstalling mgu-render removes the drop-ins.

## 0.2.0

- Its own socket, `/run/mgu-render/render.sock`. The community renderers' socket `/run/mgu-renderd/renderd.sock` is a link to it while no other renderer is installed (none of `shared_yield`'s unit files present): made by the socket unit at its start (`mgu-render --share`) and kept by the daemon every 2 s, removed when another renderer is installed, never replacing or removing anything that is not that link but a socket nobody listens on while no other renderer is installed (0.1's own, left when its socket unit restarts). Needs mgu-deploy 0.4.0. Upstream's and IterioDev's renderers take the path at their start; mgu-render takes it back once they are removed.
- Layer apps on ivi layer `0x4d520000 + slot` and surface `0x4d520100 + slot`, apart from the community renderers' `0x4d47…`.
- Touch divert in its own table `ip mgu_render`, ports 30570 in and 30571 out; on `lo` re-injections from IterioDev's renderer (30569) and ours (30571) go on to the HMI. The unit deletes only that table when it stops.
- The controller gate's event socket `@mgu-renderd-ccu` is bound only while an app grabs, and its file touched only while that socket is ours: upstream's renderer keeps the controller for its apps.
- An update leaves a running daemon running (`keepRunning`); the new version runs from its next start.
- `js/mgu_render_client.js` connects to the own socket, then to the community one when nothing listens there.
