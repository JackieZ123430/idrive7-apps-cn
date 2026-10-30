# Live Adjustments

Live tweaks over the head unit's own diagnostic link (InternalTasu, DME `0x12`), one tab
each. Opening the app only reads; a command leaves only on a button press.

## Exhaust Flap

BMW's own `0x2F` job on DID `0x60FD` (Bosch MG1 / DME8): `2F 60FD 03 03E8` open,
`2F 60FD 03 2328` close, `2F 60FD 00` hands the flap back to the DME. The *Exhaust Flap*
setting is the arm switch and ships **Disarmed** (simulated, nothing is sent). Tested on one
car with an MG1.

## Tune functions

Engine Map (maps 1–4), Max Cooling and Burbles are **not BMW jobs**: they are handled by
the tuner's code inside the DME. They sit behind their own setting, *Tune functions*, which
ships **Disarmed**: then nothing at all is sent — no detection, no command — and no extra
tab appears. The screen never names the tuner. Code: `tune.js`.

| Tab | MHD-style | BM3 |
|---|---|---|
| Engine Map | `2F 01 <map-1>`, accepted on the DME's echo | memory write, confirmed by read-back |
| Max Cooling | `2F 03 01` / `2F 03 00`, accepted on the echo | — |
| Burbles | — | aggression 0–12 in 0.5 steps, read-back, Off |

**BM3** reuses the `bm3_live` protocol: `bm3_protocol.js` and `bm3_profiles.js` are verbatim
copies (each app is packaged alone on the car, so it can't `require()` another app). Re-copy
them when `bm3_live` changes. The CustomROM marker must match a known ROM profile; unknown
ROMs are rejected and the MHD-style commands are never sent to a BM3 ROM.

**MHD-style** commands come from captures a1-mapping attached to PR #23. MHD's own marker
sits at a ROM-dependent address (`0x807FF750` in that capture; another MG1 answered
`7F 23 72` there), so it is not detected by a memory read: when no BM3 ROM is found, Engine
Map and Max Cooling are offered and a press counts only when the DME echoes it back. An
untuned DME refuses it and the tab says *Not available on this car*. No read-back of the
active map is known, so the screen says *accepted*, never *confirmed*.

**Validated on a car** (one MG1 with MHD multi-map): Engine Map and Max Cooling work from the
app. Over ENET, `2F 01 01` was echoed and the engine note changed (map 2), and `2F 01 02` made
the check engine light flash (MHD's map-change indication) — the map page says that is
normal. None of the DIDs MHD reads (`22 3010/3020/3030/3031/3032/37FE/586A/4098`) changed
between map 1 and map 2.

**Not yet run on a car:** the BM3 path (Engine Map by read-back, Burbles). It is covered only
by the synthetic test below.

## Build and test

```sh
python3 kit/tools/build.py live_adjustments
node kit/tools/test_live_adjustments.js     # in-memory DMEs: disarmed / MHD-style / BM3 / untuned
```
