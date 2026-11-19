# Live Adjustments

Live tweaks over the head unit's own diagnostic link (InternalTasu, DME `0x12`), one tab
each. Opening the app only reads; a command leaves only on a button press (or, with Drive
mode chosen on the Exhaust Flap tab, on a driving mode change).

## Exhaust Flap

BMW's own `0x2F` job on DID `0x60FD` (Bosch MG1 / DME8): `2F 60FD 03 03E8` open,
`2F 60FD 03 2328` close, `2F 60FD 00` hands the flap back to the DME. The *Exhaust Flap*
setting is the arm switch and ships **Disarmed** (simulated, nothing is sent). Tested on one
car with an MG1 and on a G20 320i (B48).

G-series V8s (DME8FF_R at `0x12`, DME8FF_L at `0x13`: N63TU2/3, S63TU4, e.g. M550i, M50i, M5 F90):
each engine unit drives its bank's flap, so the command goes to both (the master's SGBD index
says it is a V8, then `0x13` is probed). BMW's SGBD takes the same `60FD` values there (1000 /
9000). A unit that refuses `60FD` but answers `22 631E` runs the controlled flap
(`GER_EL_AGK`): `2F 611E 03 <% x 81.92>` (open 100 %, closed 0 %), `2F 611E 00` hands it back.
Not yet tried on a V8 (#214).

The tab shows the rear silencer (`muffler_img.js`: the picture as ~16k cells on the device
pixel grid, drawn once into a cached layer; the software renderer gets it as pixels) with the
flap's butterfly turning in the right tailpipe, and four buttons:

| Button | What it does |
|---|---|
| Open | the flap open |
| Close | the flap closed (the rpm guard below) |
| OEM | the flap handed back to the DME |
| Drive mode | the flap follows the driving mode (FES) on every change: Sport / Sport+ / Sport Individual → Open; Comfort / Comfort+ / Comfort Individual / Adaptive → OEM; Eco Pro / Eco Pro+ / Eco Pro Individual → Close. On a plug-in hybrid (330e, X5 45e ...): Sport / Sport Individual / Sport+ / Boost → Open; Hybrid / Hybrid Comfort → OEM; Hybrid Eco / Electric / Electric Individual → Close. The line under the state word names the driving mode. Open, Close or OEM stop following it. Saved with the settings (key `driveLink`, not in the menu), so it is still on after the next start |

What the flap should do is `auto.js`; every command still goes through `controller.js`.

| Setting | Default | |
|---|---|---|
| Hold Open / Close | On | the DME lets a tester's command go after ~20 s: On sends Open / Close again every 15 s (armed only); Off lets the car take over |
| Close: hand back above | 4,000 rpm | 2,500 – 5,500 rpm or Never: Close is paused (OEM sent, the DME opens the flap as it needs) while the live engine speed is above it, and resumed 500 rpm below it. Open and OEM are never paused |

**No engine speed** (armed, a Close limit set, no live engine speed for 5 s): a manual Close
becomes OEM and stays OEM until Close is pressed again; Drive mode's Eco Pro becomes OEM and
Close comes back by itself once a live engine speed below the limit is back. Demo data never
counts as an engine speed. Tests: `kit/tools/test_live_adjustments_exhaust.js`.

## Tuned DME: BM3 and MHD

Engine Map, Burbles, Active Sound and Max Cooling are **not BMW jobs**: the tuner's code in
the DME handles them. Pick the tuning software the car runs in Settings, *Tuning software*,
and its tabs appear. It ships **Off**, and then nothing at all is sent — no detection, no
command — and no extra tab appears. Code: `tune.js`.

| Tab | BM3 | MHD |
|---|---|---|
| Engine Map | maps 1–4, memory write, confirmed by read-back | `2F 01 <map-1>`, accepted on the DME's echo |
| Burbles | aggression 0–12 in 0.5 steps, read-back, Off | — |
| Active Sound | ASD on / off (`2E 5FFD 00` / `01`), accepted, not read back | — |
| Max Cooling | — | `2F 03 01` / `2F 03 00`, accepted on the echo; **On only with the engine running** (live engine speed over 500 rpm, demo data never counts); Off always |

**BM3** (this replaces the separate BM3 Live app; `bm3_protocol.js`, `bm3_profiles.js`): when
BM3 is picked, the app reads the CustomROM marker and it must match a known ROM profile in
`bm3_profiles.js`. Unknown ROMs are rejected and no memory is written. `config.bm3MarkerAddress`
in `app.json` is the firmware-dependent marker location (limited validation). The profiles
hold only ROM identifiers and address / scale metadata, no tune contents. This app is
independent of and unaffiliated with bootmod3.

**MHD** commands come from captures a1-mapping attached to PR #23. MHD's own marker sits at a
ROM-dependent address (`0x807FF750` in that capture; another MG1 answered `7F 23 72` there),
so it is not read: a press counts only when the DME echoes it back. An untuned DME refuses it
and the tab says *Not available on this car*. No read-back of the active map is known, so the
screen says *accepted*, never *confirmed*.

**Validated on a car** (one MG1 with MHD multi-map): Engine Map and Max Cooling work from the
app. Over ENET, `2F 01 01` was echoed and the engine note changed (map 2), and `2F 01 02` made
the check engine light flash (MHD's map-change indication) — the map page says that is
normal. None of the DIDs MHD reads (`22 3010/3020/3030/3031/3032/37FE/586A/4098`) changed
between map 1 and map 2. BM3: limited smoke testing on one G22 (as the former BM3 Live app).

**PIN for Engine Map and Burbles** (setting, off by default): the Engine Map and Burbles tabs show a keypad
until the PIN is entered (one PIN, one unlock for both). Turned on, it asks for a new 4-digit PIN twice. It locks again whenever the app leaves the screen;
5 wrong PINs block it for 60 s. Turning the setting off asks for the PIN first. Only a salted hash is saved
(`mapPinCode`). Forgot it: delete the app's `settings.json` or reinstall the app.

**Other tuning software** (MG Flasher and others): add a choice to the `tuner` setting in
`app.json`, its tabs to `FEATURES` in `tune.js` and its commands there, with a test case in
`kit/tools/test_live_adjustments.js`. Contributions from owners who can capture the commands
on their own car are welcome; please test in the live emulator (`node kit/tools/emu.js
live_adjustments`) before opening a PR.

## xDrive (experimental)

Switches xDrive off (rear-wheel drive) until the next ignition cycle, using the DSC's own
diagnostic job `LMV_FUNKTION` (issue #28). The *xDrive (experimental)* setting ships **Off**:
then no tab appears and nothing is sent. Code: `xdrive.js`.

- DSC, diagnostic address `0x29`, DID `0xDBE1`: `22 DB E1` reads it (1 = xDrive on, 0 = off),
  `2E DB E1 00` switches xDrive off. A full ignition cycle (terminal 15 off, then on) brings
  xDrive back. On the DSC variants where `2E DB E1 01` was measured to bring it back at once
  (`ON_INDEX` in `xdrive.js`: DSC_G30N `0F2850`, G01 X3 M40i) the tab also has an **xDrive on**
  button - the same write with `01`, the same checks and double press. Elsewhere no "on" command
  is sent.
- The same job is in BMW's descriptions of both G-series DSC families (DSC_G20 and DSC_G30N), so
  the tab works on any G car whose DSC answers `22 DB E1`. If the DSC answers the write with "not
  in this session" (NRC `7E` / `7F`), the app opens the extended session (`10 03`) and sends the
  same write once more.
- The DBE1 path covers DSC_G20, DSC_G30N, DSC_G11, DSC_I1 and IB_G2X (and an unidentified DSC
  that answers the read). A car with another unit at `0x29` and a G VIP (`0x39`, VIP_G05 /
  VIP_G30N) uses the VIP's job instead: `2E DB 2F 00` (`STEUERN_LMV_FUNKTION_QDM`), sent with
  the engine running or the car READY, stationary in P. `22 DB 44` is read and logged but not
  shown as the mode (it read 0 in both modes on a G22); the front-axle torque shows the effect.
  This is the G05 xDrive45e (IB_G05, `0F2500`), where the DBE1 write was accepted and did nothing
  (issue #52).
  On an ICE G05 (diesel X5: IB_G05 `0F2500`, VIP `0F2520`, LMV `0F2180`) the VIP takes the same
  job with the engine **off** instead, as the DSC's DBE1: ignition on, P, stationary (measured:
  xDrive to RWD, front-axle torque ~0, back after an ignition cycle). With the engine running it
  answers NRC `33`, which there means the engine runs; the tab says to switch it off.
- The DSC accepts the DBE1 write only with the ignition on, engine **off**, selector in P, parking
  brake on and the car stationary; on a hybrid, READY with the engine stopped is allowed. The app
  also refuses unless live data shows the ignition on, the engine off, the car stationary and the
  selector not in R/N/D (it can't read the parking brake). Exception, measured on a G01 X3 M40i
  (DSC_G30N `0F2850`, `ENGINE_RUNNING_OK` in `xdrive.js`): that DSC takes the write with the
  engine **running** (P, parking brake, stationary) - and also in D during an auto start/stop
  engine stop with the parking brake off, so "stationary in P" stays this app's own gate there;
  the "Engine off" check is left out on that variant. With the car reporting ignition on
  (not READY) the engine counts as off whatever the rpm says: on some cars the rpm signal stays
  above 50 for minutes after switching off (issue #28). The button has to be pressed twice
  within 6 s.
- The G05 xDrive45e has the same VIP (`0F2520`) and takes the job the same way, with the engine off
  and the ignition on (confirmed in diagnostic mode, issue #52). Another VIP that answers NRC `33`
  may want an unlock this app doesn't do; the tab suggests diagnostic mode first.
- **Diagnostic mode:** where the DSC answers NRC `33` (security access) with every check green,
  switch the ignition on in diagnostic mode (press Start three times quickly, without the brake)
  and press again. That is how the write went through on a G26 (DSC_G20 `0F2510`, issue #63) and
  a G20 330e (issue #52); the tab says so.
- The mode comes from the transfer case itself when it has been read: the requested-torque
  qualifier in `22 DB 32` (bytes 7-8, also the last byte of `DB31`) is `0x20` / `0x21` while the
  LMV is active and `0xE8` after the OFF write (`(q & 0xC0) == 0xC0` = off; the same two values are
  in ezl0l's G22 samples and in the G01 logs), engine on or off. Right after an accepted write the
  LMV is read once more and the `command_accepted` line says `physicalEffect: verified_by_lmv`
  when its qualifier agrees. Without a DB32 answer the old rule holds: with the engine off DBE1
  reads 0 on the DSC_G20, so AWD / RWD from DBE1 is shown only once the engine is running (on the
  DSC_G30N `0F2850` DBE1 reads 1 with the engine off too). Started in the same ignition cycle, the
  cluster shows an all-wheel-drive notice. While xDrive is off the DSC stores DTC `480724` (LMV
  function unavailable, sub-function inactive); after the ON write it stays as a historic entry.
- Only the tab reads the DSC: the SGBD index (`22 F1 50`) once, then DBE1 every 4 s. A DSC that
  refuses the read (a rear-wheel-drive car) is never written to.
- Front-axle torque, to see the effect while driving: the transfer case (LMV, `0x19`), `22 DB 32`
  (`LMV_MOMENT`: actual and requested Nm, raw / 4), every second while the tab is shown (the Nm
  are shown with the engine running), plus the highest requested value while moving. With xDrive
  off it stays at 0 Nm (−1.75…−2.5 Nm on every launch to 66 km/h on the G01, against 256…433 Nm
  peaks before the write).
- Transfer case variant: one `22 F1 50` (SGBD index) to the LMV when the tab opens, shown next to
  the DSC variant. Known G-series units: `0F2180` (LMV-G ATC13, MPC5643L) and `0F29E0`
  (LMV-G ATC13_2, TC233L). Read only: the app never codes or flashes the transfer case, so there
  is no permanent xDrive off.

Research: ezl0l's G22 M440i tests (DSC_G20, SGBD index `0F2510`; gist linked on issue #28),
including a short closed-area drive where the LMV's front-axle torque request stayed at 0;
IterioDev confirmed it on a 2023 230i xDrive. G01 X3 M40i LCI 2022 (DSC_G30N `0F2850`, LMV
`0F29E0`): two closed-area drives with DB32 logged every 250 ms - write accepted with the engine
running, `2E DB E1 01` restores AWD at once, front torque −1.75 Nm after / 433 Nm before, RWD
persists after an engine start in the same ignition cycle. **Not established:** physical clutch
state, ABS / stability control in motion, other DSC variants, prolonged use. Use at your own risk.

## xDrive diagnostic logging

Lines prefixed `xdrive-diagnostic ` contain JSON for both DSC and VIP paths, including
unknown variants. They record identification, blocked/confirmation presses, each existing
write and session request, and the raw result (positive, negative, pending, unexpected,
no response or transport error). Exchange IDs pair requests and results; attempt IDs group
the two-press action. NRC names describe the response, not a diagnosis of its root cause.
In particular, `33` alone does not prove that the engine is running or establish the unlock
required by a particular ECU.

Snapshots include the app version, route/target, ECU indexes, available vehicle values,
the existing checks and recent read evidence with its age. Missing values are `null`;
the parking brake and per-signal freshness are explicitly unknown. The SDK does not
provide per-signal timestamps, so cached vehicle values must not be assumed fresh.
An accepted write is logged as `physicalEffect: "not_verified"`: neither DBE1 nor a
zero torque sample independently establishes the physical clutch state.

Successful polling replies are included for 60 seconds after the first confirmation
press; identification and failed exchanges are always recorded. Only the app's existing
polls are observed, while the tab is shown: logging adds no ECU requests, retries, security
unlock, reset or changes to the safety checks. It does not expose intermediate transport
frames consumed internally by `Diag.physical()`. Failed reads replace the last evidence
for that request with an explicit failure, not a cached successful value.

For an issue, share the `xdrive-diagnostic` lines from identification through the refusal
and subsequent normal reads, including `uds_request`/`uds_result` exchange IDs. These
records deliberately omit VIN, ECU serial numbers and arbitrary vehicle/config objects.
Review the rest of the app log for personal information before sharing it.

## Build and test

```sh
python3 kit/tools/build.py live_adjustments
node kit/tools/test_live_adjustments.js     # in-memory DMEs: off / MHD / BM3 / wrong tune / untuned; in-memory DSC: xDrive
node kit/tools/test_bm3_protocol.js         # BM3 protocol and ROM profiles
```
