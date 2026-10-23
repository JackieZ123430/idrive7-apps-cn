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
docker build -t mgu-renderd-build docker
docker run --rm -u $(id -u):$(id -g) -v $PWD:/src mgu-renderd-build make
# build/mgu-renderd, build/ivi-probe
```

`deploy/make-car-kit.sh` does this automatically when Docker is available, and puts the binary in the kit.

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

## Test without a car

```sh
node kit/tools/preview.js dist/car_vitals out render --gpu out/stream.bin   # what the GPU would get
docker run --rm -v $PWD/kit/renderd/build:/b -v $PWD/out:/o mgu-renderd-build \
    /lib64/ld-linux-x86-64.so.2 /b/mgu-renderd --replay /o/stream.bin --out /o/frame.pam
```

`tools/ivi-probe list` shows the compositor's screens, layers and surfaces.

## Protocol (src/proto.h)

Messages are `u32 type, u32 len, payload`. The client sends HELLO, PLACE (surface rect + logical
scale/offset), SHOW, ATLAS / RAMP / LAYER (uploaded once), FRAME (draw ops) and DROP_LAYER.
The daemon sends READY, TICK (send the next frame), STATS and ERROR. Colours are 0xRRGGBBAA.
Draw ops are listed in `proto.h`; `XF s ox oy` switches the transform for what follows (screen
pixels with `1 0 0`, back to the placement's with `0`), and a `CLEAR` inside a `CLIP` makes that
rectangle transparent.
