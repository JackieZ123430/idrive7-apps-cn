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

## Build

Build in Ubuntu 18.04 (glibc 2.27, like the unit):

```sh
cd kit/renderd
docker build --platform linux/amd64 -t mgu-renderd-build docker      # x86-64 like the head unit, also on ARM machines
docker run --rm --platform linux/amd64 -u $(id -u):$(id -g) -v $PWD:/src mgu-renderd-build make
# build/mgu-renderd, build/ivi-probe
```

`deploy/make-car-kit.sh` (`kit/tools/make_kit.py`) does this automatically when Docker is
available, and puts the binary in the kit.

### Prebuilt binary

So nobody needs Linux or Docker just to install the apps, the binary is committed in
`prebuilt/mgu-renderd` (and the controller gate `prebuilt/mgu-inputgate.so`), with
`prebuilt/SOURCE_SHA256`: a fingerprint of `src/`, `inputgate/*.cpp`, `protocol/*.xml`, `docker/`
and the `Makefile` they were built from (line endings ignored, so a
Windows checkout matches). The kit builder:

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
journalctl -u mgu-renderd                 # its log (clients, errors)
```

The unit runs it as a throwaway user (`DynamicUser`) with only the groups it needs:
`mgu_wayland` (compositor), `video` (GPU) and `tm_oap_app` (the apps may use its socket).
`deploy-car.sh restore` removes it.

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

Messages are `u32 type, u32 len, payload`. The client sends HELLO, PLACE (surface rect + logical
scale/offset), SHOW, ATLAS / RAMP / LAYER (uploaded once), IMAGE (a pixel image: id, w, h + RGBA
bytes, sent again only when the app changes it, e.g. each frame of a game), FRAME (draw ops) and
DROP_LAYER, GRAB (the controller to this app, see above).
The daemon sends READY, TICK (send the next frame), STATS, ERROR and CCU (a controller event
held back from the HMI for this app). Colours are 0xRRGGBBAA.
Draw ops are listed in `proto.h`; `XF s ox oy` switches the transform for what follows (screen
pixels with `1 0 0`, back to the placement's with `0`), and a `CLEAR` inside a `CLIP` makes that
rectangle transparent. `IMAGE id ver x y w h` draws an uploaded pixel image scaled to the
rectangle (nearest pixel, so a 320 x 200 game stays sharp).
