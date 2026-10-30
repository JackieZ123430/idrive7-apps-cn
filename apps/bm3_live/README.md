# BM3 Live — experimental

**Experimental prototype for iDrive 7.** Manual smoke testing has been reported
on one G22. Compatibility with other vehicles, DME firmware and BM3 ROMs has
not been established. This is an independent project, unaffiliated with BMW
or bootmod3.

Four pages provide map-slot selection, exhaust-valve Open/Close/Auto, Active
Sound Design on/off, and burble aggression from 0 to 12 in 0.5 steps. The HMI
buttons below the screen perform the actions; the drawn cards are not touch
targets. Page selection and aggression selection do not send control commands.

The app uses the head unit's InternalTasu link to DME `0x12`. Identification
defines a temporary diagnostic identifier with service `2C` and reads the BM3
CustomROM marker. Map and burble writes require a unique match with the bundled
ROM-address metadata. A BMW software-reference identifier is not used as a
substitute for a BM3 ROM key. Unknown ROMs are rejected.

`profiles.js` contains only ROM identifiers and the address/scale/command
metadata used by these controls. It contains no tune contents, downloaded maps,
vehicle identifiers or account credentials. Listed profiles are not a claim
that every ROM has been tested. `config.bm3MarkerAddress` is a separate,
firmware-dependent marker location; the default has only limited validation.

This app **sends DME control/write requests** when an action button is pressed
and it is armed. **Safe by default:** the *Car commands* setting ships
**Disarmed**, and then nothing at all is sent to the car (no identification,
no map, valve, ASD or burble command). Set it to **Armed** in Settings only
after reading these notes.
Map changes and burble overrides are verified by memory readback. Burble
aggression uses a negative, scaled value repeated over a 24-byte timing table;
the duration setting is not changed. Individual aggression steps and firmware
variants have not all been exercised on a vehicle.

Exhaust-valve and ASD commands do not depend on the ROM lookup. They have only
limited vehicle validation. Their UI reports the last accepted command, since
the responses do not measure the valve's physical position or the current ASD
state. Valve Auto returns control to the DME.

An EXPERIMENTAL badge is always displayed. With no native diagnostic transport,
the local preview never sends vehicle commands. There are no automatic map,
burble, valve or ASD actions at startup.

Build and preview, after extracting the SDK from the owner's head unit:

```sh
python3 kit/tools/build.py bm3_live
node kit/tools/preview.js dist/bm3_live work/bm3-live-preview render BTN_PAGE render
```

Protocol tests use a synthetic ROM and an in-memory mock DME; no SDK, vehicle
connection, account or capture file is needed:

```sh
node kit/tools/test_bm3_live.js
```

Vehicle captures, logs, installed app data and SDK-bearing packages are local
artifacts and must not be committed or uploaded with bug reports.
