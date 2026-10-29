# mgu-renderd: GPU renderer for the custom apps

Without it, an app draws each frame in JavaScript, encodes it as PNG and hands it to the HMI.
That gives a few frames per second. With it, the app only *records* its drawing commands
(`kit/runtime/record.js`) and sends them over a socket. `mgu-renderd` draws them with OpenGL ES
on its own compositor surface over the HMI, at display rate (60 fps), using the whole screen.

```
app (node)                          mgu-renderd (system service)               winston (compositor)
ctx.canvas() -> Recorder  --frame--> GLES2: one shader, analytic AA  ----> ivi surface over the HMI
gauges.js templates                  cached layers / glyph atlases            (layer on top, no input)
ctx.loop  <----------------tick----  wl_surface.frame (vsync)
```

## The engine: mgu-render

Since 2.0 the daemon is **mgu-render** by Robert Nisipeanu and IterioDev, from
[robertnisipeanu/mgu-store](https://github.com/robertnisipeanu/mgu-store) (`native/mgu-render`),
built here under the old name. It grew out of this folder's first renderer and keeps its drawing
code and wire protocol, so our apps run unchanged: their recorded sessions replay byte for byte
the same as through the first renderer (`make test`, below). On top of that it adds:

- **The other community apps.** It also speaks IterioDev's renderer protocol (his App Manager
  apps), display-bridge's (mgu-apps DOOM, draw_gallery), and its own, mgu-render/1
  ([PROTOCOL.md](PROTOCOL.md)): pixmaps, video frames from a player, state events.
- **Foreground gate.** `foreground_gate.js` (started by the renderer, Node) reads which app's
  screen the HMI has in front; an app's surface is hidden while another app is in front, on top
  of the app hiding itself. A gate that reads nothing changes nothing.
- **Touch routing.** Apps that claim an area (mgu-render/1, IterioDev's apps) get the touches
  that start there (an nft rule on the display's touch port, only while such an app is shown;
  a guard process removes it if the renderer dies). Our apps claim nothing: touch stays the HMI's.
- **In-page drawing.** Apps that ask for it draw inside their own HMI page instead of over it,
  through a page template made from the installed HMI: the HMI's title bar, popups, the camera,
  BACK and HOME then behave as on any stock page. Installed with the renderer (below); today's
  apps draw over the HMI as before.
- **Pixel pictures and video.** Pixmaps updated in regions (INDEX8 with a palette for a game, or
  RGBA), and video frames a player process writes to a file, drawn under and over the app's ops.

See [Using it in an app](#using-it-in-an-app) for how an app uses each of these.

[README.mgu-render.md](README.mgu-render.md) is its own README (internals, settings, the
car checklist); [CHANGELOG.md](CHANGELOG.md) its history. Its paths there (`/var/opt/mgu-render`,
`mgu-render.socket`) are those of its Store package; here it is installed as below.

What stays as it was:

- **No change for touch / iDrive.** The surface has an empty input region. Taps and the controller
  still go to the HMI's own screen underneath, and its buttons sit where they always were.
- **Fallback.** If the socket `/run/mgu-renderd/renderd.sock` is missing, or the setting
  *Renderer = Software* is chosen, apps draw in software as before. Same code, same look.
- **Full screen** (app setting *Screen layout*, default *Full screen*). The surface covers the
  whole 1920 x 720 screen right of the HMI's back-arrow column:
  - a header in the HMI's title strip with the app's name and page tabs (`G.frame`); the HMI's
    status icons (notifications, volume, voice, profile, clock) show through a corner the
    frame leaves transparent;
  - a 48 px button bar drawn by the kit instead of the HMI's 120 px one. Each label sits over
    the HMI button under it, so taps and presses still land on the right one. The bar buttons
    are built with `Focusable=3`, which makes the HMI send focus events, so the bar lights the
    button the iDrive controller is on;
  - the page content (the app's 1600 x 520 drawing without its tab row and a little side
    margin) scaled up into the rest, x 1.16.

  *Standard* keeps the HMI's own title and bar; the surface then covers only the image area.
  The display (`kit/runtime/display.js`) draws the header and bar in screen pixels after the
  page, using the `XF` transform op; software playback skips that part.
- **Never in the way.** The surface is hidden while the app's screen isn't shown, or while an
  HMI popup (options, warnings, calls) has its focus. The app then draws in software below the
  popup. Apps send a frame at least once a second; the renderer hides a surface that goes quiet
  for 3 s (hung app). It's destroyed when the app disconnects or exits.

Measured on the VM (Doom, a new game left alone for a minute, five runs alternating the first
renderer and this one): the same, 35 game frames a second, 60-80 frames a second shown, about
9 ms a frame, 3-6 % CPU.

## Build

Build in Ubuntu 18.04 (glibc 2.27, like the unit):

```sh
cd kit/renderd
docker build --platform linux/amd64 -t mgu-renderd-build docker      # x86-64 like the head unit, also on ARM machines
docker run --rm --platform linux/amd64 -u $(id -u):$(id -g) -v $PWD:/src mgu-renderd-build make
# build/mgu-renderd, build/mgu-inputgate.so, build/ivi-probe
docker run --rm --platform linux/amd64 -u $(id -u):$(id -g) -v $PWD:/src mgu-renderd-build make check-target
make test     # (Docker, Ubuntu 24.04 + Mesa) unit tests, and recorded sessions of every dialect replayed
              # through the original daemons (test/reference) and this one, frames compared byte for byte
```

`deploy/make-car-kit.sh` (`kit/tools/make_kit.py`) does the build automatically when Docker is
available, and puts the binary and its script files (`foreground_gate.js`, `hmi_template.js`,
`mgu-render-hmi.sh`) in the kit.

### Prebuilt binary

So nobody needs Linux or Docker just to install the apps, the binary is committed in
`prebuilt/mgu-renderd` (and the controller gate `prebuilt/mgu-inputgate.so`, and the script files),
with `prebuilt/SOURCE_SHA256`: a fingerprint of `src/`, `inputgate/*.cpp`, `protocol/*.xml`,
`docker/` and the `Makefile` they were built from (line endings ignored, so a Windows checkout
matches). The kit builder:

- **with Docker:** compiles the source (`make` skips it when nothing changed). If the source
  differs from the prebuilt's fingerprint, it copies the new binary to `prebuilt/` and updates
  the fingerprint: **commit both along with your source change**.
- **without Docker:** takes `prebuilt/` when its fingerprint matches the source. If it doesn't
  (the C code was changed but the prebuilt wasn't updated), it says so and asks before packing
  the older binary.

## Install

`deploy-car.sh install` installs it along with the apps. By hand on the unit / VM:

```sh
sh mgu-app-install.sh renderd --persist   # copy to /var/opt/mgu-renderd, unit, start
sh mgu-app-install.sh renderd             # same, but gone after a reboot (/run unit)
sh mgu-app-install.sh renderd-remove
journalctl -u mgu-renderd                 # its log (apps, the gate, touch, errors)
```

`renderd --persist` sets up everything:

| | what |
|---|---|
| `/var/opt/mgu-renderd/` | `mgu-renderd`, `foreground_gate.js`, the page template's `hmi_template.js`, `mgu-render-hmi.sh`, `mgu-render-hmi-guard.sh`, the licences; `hmi/` the template, `status.json` how its build went |
| `mgu-renderd.service` | the renderer, started with the app platform, as root in the compositor's group (the touch rule needs nft, the foreground gate SOME/IP as root) |
| `mgu-renderd-hmi.service` | before each HMI start: mounts the page template into the HMI's widgets |
| `display-bridge{.socket,.service,-hmi.service}.d/mgu-renderd.conf` | display-bridge (mgu-apps), if installed, stands down: the renderer serves its apps |

The renderer runs as

```
mgu-renderd -s socket_path=/run/mgu-renderd/renderd.sock -s socket_group=12202 -s embed_marker=/run/mgu-renderd-hmi/hmi-template
```

Settings are `-s key=value` (or `-c FILE`, see [mgu-render.conf](mgu-render.conf) for every key);
the old flags `--socket`, `--group` and `--screen` still work. It finds `foreground_gate.js`
beside itself; `-s foreground_gate=` turns the gate off. `deploy-car.sh restore` removes it all.

**Through the Store** (`mgu-repo.json`, tool `idrive7-renderd`): the same, packed by
[`prebuilt/component.json`](prebuilt/component.json) with the units in `prebuilt/`
(`idrive7-renderd.service`, `idrive7-renderd-hmi.service`), in `/var/opt/idrive7-renderd/current/`;
the template is made by the install (`postInstall`, needs mgu-deploy 0.6.1).

**Updating, and other renderers.** Any order works, and each was tested on the VM through a cold start:

| on the unit | what happens |
|---|---|
| this repository's earlier renderer (installer) | `renderd --persist` (and `deploy-car.sh`) replaces it in place: program, unit (root now), files |
| `idrive7-renderd` installed through the Store | `renderd --persist` removes it through the Store's own deploy tool (the Store then shows it removed), then installs its own |
| the installer's renderer, then `idrive7-renderd` from the Store | the Store takes it over (removes the installer's unit and program); the installer's template unit stands down |
| mgu-store's own **mgu-render** beside ours, in either order | both run. mgu-render serves the apps that use its socket (this kit's apps prefer it) and has the page template and touch; ours keeps the community socket for older apps, on its own ivi ids (`0x4d470000`/`0x4d470100`, as the first renderer), and leaves touch alone. mgu-render installed or removed while ours runs: ours restarts once (systemd starts it again at once) to hand the touch ports over |

### In-page drawing: the page template

The template is made from the installed `HmiMain3D` at install (up to 2 minutes, at low
priority) into `/var/opt/mgu-renderd/hmi/`, for that HMI build only. Before each HMI start,
`mgu-renderd-hmi.service` (at most 30 s) mounts a copy of the HMI's widget folder with the
template added, from `/run/mgu-renderd-hmi/`, over the original: nothing on the unit's
partitions is written, and without a template made for this `HmiMain3D` the stock widgets stay.
Apps are offered in-page drawing from the first head-unit start after the install.

**Boot guard.** An HMI that fails reboots a car's head unit, so the mount runs behind a guard
(`mgu-render-hmi-guard.sh`): each start counts a strike in `hmi/strikes`, and the same HMI process
running for a minute (checked 2 minutes after the start) clears it. Two starts in a row without
that, and the template stays out (the journal says so) until it is made again (a firmware or
renderer update) or `renderd-embed` runs.

```sh
sh mgu-app-install.sh renderd-embed          # make the template again (and reset the guard)
sh mgu-app-install.sh renderd-embed --now    # VM / bench only: restart the HMI with it now (on a car that reboots the unit)
sh mgu-app-install.sh renderd-embed-remove   # take it out (stock widgets from the next start; --now: now)
NO_EMBED=1 sh mgu-app-install.sh renderd --persist   # the renderer without in-page drawing
cat /var/opt/mgu-renderd/status.json         # the template's build: ok / failed and why
```

## Using it in an app

**Apps made with this kit** (`ctx.canvas`, `gauges.js`) need nothing: the kit speaks the protocol
below over `/run/mgu-renderd/renderd.sock` and draws on its own layer over the HMI, at 60 fps,
falling back to software without the renderer. The foreground gate and the rest apply by themselves.

**New features** (in-page drawing, pixmaps, video, touch, state events, a frame cap) are
mgu-render's own protocol, mgu-render/1 ([PROTOCOL.md](PROTOCOL.md)), through its client
[`js/mgu_render_client.js`](js/mgu_render_client.js) (Node 8, `net`/`fs`/`events` only; copy it into
the app). It connects to `/run/mgu-render/render.sock` (mgu-store's renderer) or
`/run/mgu-renderd/renderd.sock` (this one), whichever is there:

```js
const { RenderClient, imageOp } = require('./mgu_render_client');
const gpu = new RenderClient('my_app', log, { mode: 'embed', kit: require('./record') });
gpu.on('ready', (screen, info) => {
    if (!info) { /* an older renderer: draw in software */ return; }
    if (info.modes.indexOf('embed') < 0) gpu.mode('layer');        // no page template on this unit yet
    const box = gpu.mode() === 'embed' ? info.embedBox : info.appArea;
    gpu.place({ x: box.x, y: box.y, w: box.w, h: box.h, scale: 1, ox: 0, oy: 0 });
    gpu.show(true);
});
gpu.fps(30);                                        // optional: at most 30 frames a second
gpu.on('tick', () => gpu.frame(recorder));          // a kit Recorder, or gpu.frameWords(ops)
gpu.on('state', (s) => { /* { mode, onScreen, front } */ });
gpu.on('touch', (phase, x, y) => { /* in claimed areas: gpu.claim([{ x, y, w, h }]) */ });
gpu.connect();
```

- **In-page drawing** (`mode: 'embed'`): the page the app draws in must use the template as its
  state's widget. The RHMI page (`application.xml`) of such a state:

  ```xml
  <container id="1" type="state" widget="LT_State_A4A_WelcomeApp">
      <layoutGroup id="100" name="Titlebar"><component id="10" type="title"/></layoutGroup>
  </container>
  ```

  The picture is drawn in `info.embedBox` (104,88 1796x632 on iDrive 7) and shown only while
  that page is in front. Offered (`info.modes` has `embed`) once the template is mounted, i.e. from
  the first head-unit start after the install: fall back to `layer` until then. `build.py` has no
  screen kind for it yet; write the state as above.
- **Pixmaps**: `gpu.pixmap(1, 320, 200, 'index8', 'nearest')`, `gpu.palette(1, rgb768)`,
  `gpu.pixels(1, rects, indices)` for what changed, and `imageOp(1, x, y, w, h)` in each frame
  (`test/pixel_client.js` is a complete example).
- **Video** (`info.video`): a player writes decoded frames (I420) to `/dev/shm/mgu-video-<name>`
  (PROTOCOL.md, "Video"); the app names it with `gpu.video(1, path)` and draws `videoOp(1, x, y, w, h, r)`.
- **Touch** (`info.touch`): `gpu.claim([...])` areas; a touch that starts there comes as `touch`
  events and the HMI does not get it.
- **Controller**: `gpu.grab(true)` holds the knob, press and tilt back from the HMI while the app
  is shown (`info.controller`: the controller gate below is loaded); the events come as `ccu`.

More detail: [README.mgu-render.md](README.mgu-render.md) ("Apps", "Embed buffers", "Settings").

## Licence

This folder is **GPL-3.0-or-later** ([LICENSE](LICENSE)): mgu-render is Copyright (C) 2026 Robert
Nisipeanu and IterioDev under that licence. The parts it took from this repository's first
renderer stay MIT as well ([LICENSE.mgu-renderd](LICENSE.mgu-renderd)), as do the Wayland ivi
protocol files (DENSO, BMW Car IT; notice in each file) and the reference copies of both earlier
renderers in `test/reference/`. The controller gate (`inputgate/`) is this repository's, MIT
(its vsomeip headers MPL-2.0). The rest of the repository stays MIT.

## Controller gate (inputgate/)

`mgu-inputgate.so` lets a full-screen app (Doom) have the iDrive controller to itself. It is
loaded into the HMI (`HmiMain3D`) with `LD_PRELOAD`, through a drop-in for `hmi.service`. It hooks
CommonAPI-SomeIP's `Connection::handleProxyReceive`, which every SOME/IP notification for the HMI
passes through. While the gate is closed, it rewrites FrontCCU (service 0xb508) event 0x8002
(`RotaryEncoderStateFront`: sequence, knob position, press, tilt) for the HMI: knob still, not
pressed, centred. The real event goes on to the renderer over the abstract datagram socket
`@mgu-renderd-ccu`, and from there to the app as `E_CCU`. The buttons (event 0x8001) and touch are
never changed. When the gate opens, the knob position carries on from where the HMI last saw it,
so its focus doesn't jump.

The gate is closed only while `/run/mgu-renderd/inputgate` is younger than 0.7 s. The renderer
touches it every 0.2 s while an app that is shown and not hung has sent `GRAB 1` within the last
1.5 s (`ctx.controller.grab(true)` repeats it). Anything else (`GRAB 0`, the app closing or
crashing, the renderer stopping, a clock jump backwards) opens it.

```sh
sh mgu-app-install.sh inputgate             # copy next to the renderer + boot guard: loads at the next head-unit start
sh mgu-app-install.sh inputgate --now       # VM / bench only: restart the HMI with it now (on a car that reboots the unit)
sh mgu-app-install.sh inputgate-status      # loaded / set up / left out by the boot guard
sh mgu-app-install.sh inputgate-remove      # take it out (the HMI drops it at the next start; --now: restart it)
```

The HMI is never restarted on a car: `hmi.service` stops with SIGABRT and the head unit's crash
monitor reboots the whole unit for an aborted HMI. The guard (`mgu-inputgate-guard.service`,
before the HMI) copies the preload line to `/run/mgu-inputgate.env`, which the drop-in reads
with `EnvironmentFile=`, and counts the start; `mgu-inputgate-check.service` resets the count once
the HMI has run with the gate for a minute (checked 2 minutes after the start). Two starts in a
row without that: the guard leaves the gate out until it is installed again. Neither unit ever goes inactive
(the guard has `RemainAfterExit=yes`, the check keeps running after it is done): on this firmware
the lifecycle manager reboots the head unit when a service stops, not only when the HMI does.

`inputgate/vsomeip-include/` holds the vsomeip 3.1 compat interface headers it is compiled
against (MPL-2.0, as in their file headers).

## Test without a car

```sh
node kit/tools/preview.js dist/car_vitals out render --gpu out/stream.bin   # what the GPU would get
docker run --rm -v $PWD/kit/renderd/build:/b -v $PWD/out:/o mgu-renderd-build \
    /lib64/ld-linux-x86-64.so.2 /b/mgu-renderd --replay /o/stream.bin --out /o/frame.pam
```

`--out` gets the last frame. Add `--raw /o/frames.rgba` to also get every frame (raw RGBA,
1920 x 720, top row first), e.g. for a video: preview's `frames=<n>` draws n frames at 60 a
second in real time, and [`kit/tools/make_gif.sh`](../tools/make_gif.sh) turns that into a GIF.

`tools/ivi-probe list` shows the compositor's screens, layers and surfaces.

## Protocol (src/proto.h)

This is the protocol our apps speak (mgu-render calls it the upstream dialect); [PROTOCOL.md](PROTOCOL.md)
describes all of mgu-render's. Messages are `u32 type, u32 len, payload`. The client sends HELLO, PLACE (surface rect + logical
scale/offset), SHOW, ATLAS / RAMP / LAYER (uploaded once), IMAGE (a pixel image: id, w, h + RGBA
bytes, sent again only when the app changes it, e.g. each frame of a game), FRAME (draw ops) and
DROP_LAYER, GRAB (the controller to this app, see above).
The daemon sends READY, TICK (send the next frame), STATS, ERROR and CCU (a controller event
held back from the HMI for this app). Colours are 0xRRGGBBAA.
Draw ops are listed in `proto.h`; `XF s ox oy` switches the transform for what follows (screen
pixels with `1 0 0`, back to the placement's with `0`), and a `CLEAR` inside a `CLIP` makes that
rectangle transparent. `IMAGE id ver x y w h` draws an uploaded pixel image scaled to the
rectangle (nearest pixel, so a 320 x 200 game stays sharp).
