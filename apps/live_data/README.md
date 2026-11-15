# Live Data

Live values from the car and its control units, a trip computer with the fuel cost, and gauge
screens of your own, one of them as the home-screen widget. It only reads: nothing is written,
coded, reset or actuated.

## Pages

| Tab | What it shows |
|---|---|
| **Gauges** | Screens of your own: dials, sport-display bars and big numbers (with the last 5 minutes as a trace and their min / max). Tap or press a gauge to choose its value: a group, then the value, with what each one reads now. The layout and the removal of a screen are in the same sheet. A new install starts with two screens: *Engine* (engine speed, oil, coolant, boost) and *Trip* (fuel consumption, and this trip's consumption, distance and cost). Up to 6; the next one starts on the page after the last. |
| **Trips** | The trip computer: this trip (or the last), the last 5 trips, today, the last 7 and 30 days and everything recorded: distance, fuel, consumption, cost, time, average and top speed, tank and odometer. A trip runs from the engine start until the engine has been off for 10 minutes, and it is counted in the background, also while the app is closed. The fuel price (1.80 a litre to start with, in Settings' currency, EUR by default) is set on the Totals page. |
| **Signals** | What the car sends the head unit on its own over SOME/IP (`signals.js`), with no request to any unit: engine speed, torque and power, the sport display's power / torque / boost, pedal, temperatures, fuel in the tank and range, odometer, the board computer's averages, speed, gear, driving mode, accelerations, yaw / roll / pitch rates, steering angle, outside temperature, battery, tyre pressures and temperatures. |
| **Energy** | The DME's 12 V battery and charging values; when the scan identifies supported units, the BATT48 battery's voltage, current, SOC, SOH and temperature, and the PCU48 converter's 12 V / 48 V voltage, current, power and energy-flow mode. Only values in view are read. A missing unit or unsupported layout is not evidence that the car lacks a 48 V system. |
| **Engine** | The engine unit's values worth a look, in groups (`useful.js`): engine, temperatures, oil (pressure, level, life, fuel in the oil), fuel (rail pressures, consumption, ethanol), fuel quality (the adapted octane, the time since refuelling, how many refuellings the engine unit counted as low, medium and high quality, and the last five with their mileage and quality: identifier 4035, also on the S63's master unit), boost and air, ignition and knock per cylinder, VANOS and Valvetronic, mixture and injector corrections, wear and service (spark plugs, particulate filter). The 12 V group is on Energy. Each value comes from the first identifier the car answers, and one the car doesn't have is left out. |
| **Units** | *Scan units* asks every control unit at once for its type (UDS `22 F1 50`). A unit's page has its identification (VIN, part, hardware and software numbers: ISO 14229 `22 F1xx`), the engine unit's also the OBD-II data it supports (SAE J1979 service 01 and 09), and every identifier its catalog lists except the curated built-in battery/converter values reserved for Energy. Full local catalogs retain their normal unit-page and *Read all* behavior. *Read all* asks each one once and keeps what answered in `data/scan-<address>.json`. |

The **home-screen widget** shows the screen *Settings > Home-screen widget shows* names: the big
widget as a picture of its gauges, the small one as text lines.

Where the kit runs the screen (the GPU renderer, *Screen layout: Full screen*) a finger or the
controller scrolls the lists and the sheets are drawn over the page. Elsewhere the lists are paged
(*Next page*) and *Browse* gives the knob the same jobs.

## How it reads

- **Only reading.** The diagnostic link the app has (`kit/runtime/readonly-diag.js`) refuses every
  service but `22` ReadDataByIdentifier and OBD-II `01` / `09`, and every functional request but
  `22 F1 50`, before anything reaches the transport. No session change, no tester present, no
  routine, no write, no clear. Car signals are only watched, never set or called.
- **Gently.** One request at a time, at least 25 ms apart, while the app's screen or its widget is
  shown; the values in sight only, up to 8 identifiers of one unit in a request once their reply
  lengths are known. A value a unit doesn't have (NRC 31) is asked again after 30 s at the soonest.
  In the background only the trip computer's fuel figure, once a second while the engine runs, until
  the car's fuel signal has learned its scaling.
- **Small files.** `data/trips.json` (a few kB that never grow), `screens.json`, `signals.json` (the
  fuel signal's scaling), `units.json` and the scans.

### Energy flow

On Energy, the converter mode indicates `48 V -> 12 V (buck)` or `12 V -> 48 V (boost)`.
This is the reported operating mode, not proof of actual power transfer or recuperation.
Both sides' signed currents and powers are shown separately, without inferring their sign convention.
For BATT48, a negative battery current means charging. The existing DME 12 V current remains
uninterpreted. Use *Scan units* to identify the 48 V controllers; `PCU48_2` has no supported mapping.
No battery-health verdict, efficiency estimate or vehicle-wide energy balance is calculated.

## Catalogs

A catalog tells how to decode a unit type's replies (the `kit/runtime/sgbd.js` format).

- **Built in** (`builtin/`, in git): the engine unit's identifiers that the Engine page uses
  (`DME8FF_R`, the B58 / B48 / B38 engines of the G series; 118 identifiers), the curated BATT48
  and PCU48 identifiers used by Energy, and the SGBD index that names unit types. Battery and
  converter layouts are static source mappings and have not yet been qualified on a vehicle.
- **Full** (`catalog/`, not in git): every readable identifier of a unit type, made from the public
  [EdiabasX SGBD reference](https://emdzej.github.io/ediabasx-docs-sgbd/) with
  `python3 kit/tools/sgbd_catalog.py <sgbd>` (and `--index`). With it, a unit's page lists every
  identifier of its type (1789 for `DME8FF_R`), and a gauge can show any value that answered.

The standard identification and OBD-II values (`std.js`) are public standards and work on any unit.

## Settings

| Setting | Default | |
|---|---|---|
| Unit pages show | What the unit may have | or only what answered, or everything its catalog lists |
| Scan units when opened | on | |
| Home-screen widget shows | Gauges 1 | and its picture size and redraws a second |
| Trip computer | on | counts every drive in the background |
| Currency | EUR | of the fuel price |
| Temperature unit | Celsius | every temperature, its gauge scale included, in °C or °F |
| Show sources and unverified values | off | the identifier or signal each value comes from, car signals whose scaling isn't known yet (raw numbers), the units' refusals |

## Build and test

```sh
python3 kit/tools/build.py live_data
node kit/tools/test_live_data.js          # read-only link, decoding, built-in catalog, defaults, picker, trip computer
node kit/tools/emu.js live_data           # the live emulator, with demo data
```
