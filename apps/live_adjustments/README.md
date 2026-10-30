# Live Adjustments

Live tweaks over the head unit's own diagnostic link (InternalTasu, DME `0x12`), one tab
each. Opening the app only reads; a command leaves only on a button press.

## Exhaust Flap

BMW's own `0x2F` job on DID `0x60FD` (Bosch MG1 / DME8): `2F 60FD 03 03E8` open,
`2F 60FD 03 2328` close, `2F 60FD 00` hands the flap back to the DME. The *Exhaust Flap*
setting is the arm switch and ships **Disarmed** (simulated, nothing is sent). Tested on one
car with an MG1.

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
| Max Cooling | — | `2F 03 01` / `2F 03 00`, accepted on the echo |

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

**Other tuning software** (MG Flasher and others): add a choice to the `tuner` setting in
`app.json`, its tabs to `FEATURES` in `tune.js` and its commands there, with a test case in
`kit/tools/test_live_adjustments.js`. Contributions from owners who can capture the commands
on their own car are welcome; please test in the live emulator (`node kit/tools/emu.js
live_adjustments`) before opening a PR.

## Build and test

```sh
python3 kit/tools/build.py live_adjustments
node kit/tools/test_live_adjustments.js     # in-memory DMEs: off / MHD / BM3 / wrong tune / untuned
node kit/tools/test_bm3_protocol.js         # BM3 protocol and ROM profiles
```
