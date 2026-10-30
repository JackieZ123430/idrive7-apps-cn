# Transmission Config (ZF 8HP) — experimental

**Experimental prototype for iDrive 7.** Manual smoke testing has been reported
on one G22. Compatibility with other controllers or firmware has not been
established. The app displays an EXPERIMENTAL badge on every page.

An independent iDrive 7 app for the verified GSZFBCE / SGBD `0F25D0` controller
on the G22. It reads EGS `0x18` through the MGU's InternalTasu service, without
an ENET cable after installation. A different EGS identification stops data
polling before these decoders are applied.

Pages: live oil and electronics temperatures, shaft and engine speeds, gear
and converter-clutch state; A–E fill-pressure and fast-fill-time corrections
and evaluation counters; KF1/KF2 upshift/downshift/skip maps; cold upshift
maps; accumulated oil/electronics temperature time in all 23 bands; converter
and engagement/release learning; EGS fault memory; a browser for all 108
selected records; and the standard 8HP applied-element reference matrix.

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

The app saves `data/egs-snapshot.json`, including raw payloads, decoded values
and timestamps. The current-session temperature trace is bounded to 20 minutes.

Controls: Next page cycles the seven views. Next item selects a pack/shift,
temperature source, details view or diagnostic-record batch. View opens a
selected shift map, changes the map family, refreshes data or saves the
snapshot, as explained on each page. The settings select KF1/KF2 and the
upshift/downshift/skip group.

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
