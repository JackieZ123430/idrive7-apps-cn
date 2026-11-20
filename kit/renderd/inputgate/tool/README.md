# Controller gate, Store package (mgu-inputgate)

The Store installs the controller gate from this folder (mgu-repo.json `tools`, id `mgu-inputgate`), on iDrive 7 and iDrive 8.
It is the Store's own preload layout (a boot guard before the HMI, a check after it, a drop-in that reads
`/run/mgu-inputgate.env`), packed here because the Store's preload entry names one HMI unit and process:

- `guard.sh` picks the HMI when it runs: `Hmi8` / `hmi8.service` on iDrive 8, `HmiMain3D` / `hmi.service` on iDrive 7.
  Two starts without the HMI coming up healthy with the gate and it is left out (`/var/opt/mgu-inputgate/strikes`).
- The units order themselves against both HMI services; the drop-in goes to both (the one for the HMI the unit
  does not have is never read).
- Same unit and drop-in names as the Store's preload package (1.0.0), and `restart` / `recmgr` empty: an update writes
  the files and reloads systemd, nothing is stopped or restarted (a stopped service reboots the head unit). It loads
  at the next head-unit start.

`mgu-inputgate.so` is a copy of `../../prebuilt/mgu-inputgate.so` (the Store reads a tool's files from its own
folder): copy it here again whenever the gate is rebuilt, and raise the version in `component.json`.

What is held (1.2.0): while an app has the controller, the gate file (`/run/mgu-renderd/inputgate`) may name parts
with the words `knob`, `press`, `tilt`; the parts not named stay the HMI's. An empty file, or one without those
words, holds all three. Renderers that only touch the file, the older gates and the apps in this repository (they
never name parts) keep holding the whole controller, as before. The library carries `mgu-inputgate-hold:` so
mgu-store's mgu-render can offer `controllerHold` to the apps that want it.
