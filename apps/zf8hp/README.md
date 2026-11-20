# Transmission Config (ZF 8HP) — experimental

**Experimental prototype for iDrive 7.** Manual smoke testing has been reported
on one G22. Compatibility with other controllers or firmware has not been
established. The app displays an EXPERIMENTAL badge on every page.

An independent iDrive 7 app for the verified GSZFBCE / SGBD `0F25D0` controller
on the G22. It reads EGS `0x18` through the MGU's InternalTasu service, without
an ENET cable after installation. The hybrid 8HP of the G20 330e (SGBD `0F21E0`) is read too:
every record was read once on such a car; it has no torque converter, so its converter, lock-up and
histogram records are refused and shown as not on this EGS, its KF2 return-shift counters (`4137`) have 18
values, and five records with another length (`4143`, `4144`, `4440`, `4441`, `6090`) show raw. Any other
EGS identification stops data
polling before these decoders are applied, unless the setting *EGS variant* is
*Try any (unverified)*: it is then read with the same decoders and marked LIVE · UNVERIFIED.
Each record must still match its identifier and exact length, so a layout that differs shows as
an error.

Pages: live oil and electronics temperatures, shaft and engine speeds, gear
and converter-clutch state; A–E fill-pressure and fast-fill-time corrections
and evaluation counters; KF1/KF2 upshift/downshift/skip maps; cold upshift
maps; accumulated oil/electronics temperature time in all 23 bands; converter
and engagement/release learning; EGS fault memory; a browser for all 108
selected records; and the standard 8HP applied-element reference matrix.

**Other gearboxes.** BMW's index lists more 8HP controllers at `0x18`: `GSZFB1` (`0F21D0`) and the 8HP gen 4
`GSZF04GF` / `GSZF04GD` (`0F2D60`, `0F2D70`, `0F2D80`, `0F3530`, `0F3540`), which a V8 car (N63 / S63) may have.
Each variant in `reader.js` can carry its own catalog (`catalog: require('./catalog_<sgbd>')`, the shape of
`catalog.js`): the reader then asks and decodes only its records, and every page draws its gears and maps from it.
None is added yet: a catalog needs that SGBD's read schemas and one read on a car. To help, set *EGS variant* to
*Try any (unverified)*, open each page once, and send the app's log: it has the EGS identification and, for each
record, the length it answered or the code it refused with.

The data schema was extracted from BMW/ZF `GSZFBCE.prg`, revision 15.000.
Adaptation words are little endian; the thermal histograms and shaft-speed
records are big endian. Responses must match the identifier and exact schema
length. Fast-fill values are **adaptation corrections**, not absolute fill
durations. The evaluation counters are not claimed to be lifetime shift counts.

Normal shift-map cells have a factor of 0.01 bar; the UI converts them to mbar.
Cold-map cells have a factor of 10 mbar. Where physical map support points are
unavailable, the app shows cell indices instead of inventing RPM/torque axes.
Packed `4800`–`480F` records remain explicitly raw: their returned lengths do
not match a naive array of the advertised job outputs, so no guessed time or
distance values are displayed.

Temperature histograms are historical counters, not operating limits. The
oil-service temperature/RPM window comes from this EGS (`DB03`/`DB04`). It is
not presented as a complete oil-service procedure. Adaptation values have no
invented wear percentage or generic green/red pass criterion.

Polling is serialized, limited by a 180 ms inter-request gap, and paused when
the app's main screen is hidden. Live fields default to a two-second refresh;
maps and counters refresh every 30 seconds while their page is visible.
Saved values are marked as cached and carry timestamps. A cached snapshot
never establishes a live connection. Demo mode is explicit and off by default.

The reader sends only `22` (documented identifiers) and `19 02 0C` (pending and
confirmed faults), to EGS `0x18`. It has no adaptation-reset, DTC-clear,
programming, actuation or coding commands. Existing apps and their sources are
not changed by this addition.

The app saves `data/egs-snapshot.json` every 10 seconds while it reads a
supported EGS, including raw payloads, decoded values and timestamps. It loads
the file when it starts. The current-session temperature trace is bounded to
20 minutes.

Controls, full-screen layout (the kit runs the screen): the header tabs open
the seven views, and a tap on the current tab reads its data again (not when
the tap closes Settings). Each page has its own controls, which work with a
tap or the iDrive controller. Live selects the plotted temperature. Clutches
selects a pack row. Shifts selects the map family and the up/down/skip table,
and a shift row opens its map. Map selects the family and has a pill for each
shift of the table, the one shown filled. Thermal selects oil or electronics.
Details selects Summary, Faults or Records; Faults shows when the list was
last read and has Read again. The fault list and the list of all records
scroll with a finger or the controller; only the records in view are read.
Reference highlights the gear the EGS reported within the last two live
intervals, and names the controller on this car. There is no button bar, so
the pages use the full height of the screen.

Controls, standard layout (the HMI's bar): Next page cycles the seven views.
Next item selects a pack/shift, temperature source, details view or
diagnostic-record batch; Shifts shows seven shifts at a time, those around
the selected one. View opens a selected shift map, changes the map family or
refreshes data. The settings select KF1/KF2 and the upshift/downshift/skip
group.

On another EGS (not verified, and EGS variant not *Try any*), each page shows
only that message, with no controls.

Reference: [ZF external transmission training](https://w124performance.com/ISO/LR/ZF_Workbook-6-8HP.pdf),
8HP power flow and controller matrix, printed pages 97–108; adaptation
principles, pages 31–33. The shift-element diagram is a reference, not a
measurement of hydraulic pressure.

Build and checks:

```sh
python3 kit/tools/build.py zf8hp
node kit/tools/test_zf8hp.js
node kit/tools/preview.js dist/zf8hp work/zf8hp-preview render BTN_PAGE render
```

The decoder/reader tests run without the SDK and use synthetic data. An
optional local capture path may be passed to validate additional responses;
captures, real adaptation values, snapshots and installed app data are not
part of the public test fixtures.
