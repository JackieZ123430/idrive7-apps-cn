# Redline

A full-screen rev display in the style of the G20 Live Cockpit (Sport). It shows a wide slanted
rev bar, digital rpm, a big gear, speed, oil and water temperatures, and 12 shift lights. Upshifts
made by hand near your shift point are scored against it; everyday shifts well below it show as
CRUISE and the gearbox's own shifts (D / S) as AUTO, left out of the score. A cold-engine guard holds the shift point down until
the oil is warm. The main README's app table describes the screen itself.

This file is mostly about the **experimental** parts added on top. Each one is marked
*(experimental)* in Settings:

- [Head-up display](#head-up-display): the shift lights, rev bar, gear and temperatures on the HUD,
  next to BMW's own HUD content.
- [Shift cue](#shift-cue): shift lights that count you into the shift and flash early by your
  reaction time. The HUD and the screen share it.
- [Learning](#learning): the real rev limit, the best upshift rpm for each gear, and your reaction
  time, all learned from driving. The **Learned** page shows them, with resets.
- [Downshift cue](#downshift-cue): arrows by the gear while you brake, one for each gear you can
  drop without over-revving.

Tested on a 2021 330i G21 (B48, ZF 8HP, iDrive 7). It should work on other iDrive 7 G-series
cars with a HUD, but nobody has checked yet.

## Head-up display

The HUD output is by [@biscotit](https://github.com/biscotit).

### What you need

- **cluster-render**, installed from the MGU Store (Store page, *Cluster renderer*, from the
  `idrive-apps` source). It is the service that draws apps' layers on the cluster and the HUD.
  Redline works without it; the HUD then stays empty.
- A car with a HUD. iDrive 8 isn't supported.

### Setting it up

1. Settings → **Show on HUD (experimental)** → **Test pattern**. A full-scene pattern appears with
   the tach where it will sit, plus rulers and frames every 40 px. On a G21 only the inner
   (yellow, 120 px) frame is visible: about x 120–680, y 120–360 of the 800×480 scene. BMW's
   speed and limit sign sit along its bottom edge.
2. Use **HUD position and size** → *Size* and *Position* to move the tach. The pattern follows as you go.
3. Set **Show on HUD** to **On**.

### With Cluster functions

Cluster functions (the HUD map, turn signals and gear) stands on the HUD whenever it is on. Turning
Redline's HUD on takes the HUD over: Cluster functions gives way, except while Redline's tach is hidden.

In this fork *In Comfort / Eco Pro* is *Don't show* by default: Redline's HUD shows only in Sport (and
XtraBoost); in Comfort, Eco Pro, Adaptive and a plug-in hybrid's Hybrid and Electric it is hidden, and Cluster
functions has the HUD. A drive starts in Comfort, so it starts with Cluster functions, and Sport brings Redline's
tach up. *Give the HUD back to Cluster functions at switch-off* (on by default here) matters only when Redline
shows in Comfort too: then Redline's *Show on HUD* goes back to *Off* when the car is switched off or the head unit
starts again; turned off, Redline's HUD stays on from drive to drive.
Without Cluster functions installed, Redline's HUD stays on either way.
Both apps keep their state in `/dev/shm/mgu-hud` (`kit/runtime/hud_claim.js`), cleared at each head-unit start;
where it cannot be written, nothing is handed back. Cluster functions' side: TheoneLT83/Cluster-apps
`apps/robertn_waze_cluster/app/main.js` (`HudClaim.others`, `HudClaim.standing`, app id `robertn_waze_cluster`).

### What it shows

**Layouts** (*Layout*):

- **Standard:** the gear (P R N D or 1–8) with the downshift arrows under it; 12 round shift
  lights over a slanted rev bar; and a readouts row under the bar. A small yellow mark shows the
  shift point, a red one the redline, and a thin line where the revs peaked (*Peak marker*,
  dropping back after Redline's *Peak hold*).
- **Minimal:** the gear and larger shift lights only.
- **Split wings:** the gear in the centre, with 6 lights on each side filling in towards it and
  the bar underneath.
- **80s digital dash:** square lights, an LCD-style bar graph of 40 segments, and 7-segment digits
  for the gear and rpm.
- **VFD glow:** the same layout as a teal vacuum-fluorescent display, with unlit segments always
  faintly visible. It uses its own colours whatever *Colours* is set to.
- **Vector arcade:** the standard layout drawn in outlines only: rings, outlined segments and an
  outlined 7-segment gear.

Three layouts after BMW M's own head-up displays, in their colours (*Colours* doesn't change them):

- **Arc** (after the F80 / F82 M3 and M4): 8 curved shift lights (6 amber, 2 red; *Shift light
  style* Race or one colour uses those instead) over a curved band with a white rim and a tick per
  1000 rpm, ending in a yellow then red zone; the gear big under it. Readouts: the first beside the
  gear, two more at the far right, a fourth high on the left.
- **Ramp** (after the G80 / G82 M3 and M4, redrawn in 2.0.21 from a video of the car's HUD): a thick
  rail climbs from the 0 at the bottom left, bends round at the 2 and runs flat to the 8. A small
  rounded tab hangs from it every 1000 rpm, with a V cut into the rail over the numbered ones (0, 2,
  4, 6, 8) and each end an open cup. The revs hang under the rail as a warm white band up to a red
  sliver, a hairline gap wrapping each tab and splitting the band under it; past the revs the gauge
  is clear, only the rail. A thin red line inside the band marks the redline. Over the flat part 8
  slanted shift lights (6 yellow, 1 red, then a wide red one) appear with the count-in, light left to
  right and flash red at the shift. Squared digits for the scale, the gear and the first readout,
  which sits under a line beneath the gear (where the car shows the speed); the others are listed on
  the right.
- **Dial** (after the E60 M5): a ¾ dial round the gear: yellow-green, then an orange advance
  warning field (the last 1000 rpm before the redline), then red. The gear and readouts are in the
  dial's orange; the first readout bottom right (where the car shows the speed).
- **Pill** (a sim-racing telemetry look): one rounded panel. At its left the gear in a ring that fills
  round with the revs (green, yellow through the count-in, red at the shift point); the shift lights as
  a row of small dots along its top; up to three readouts as a small label over big 7-segment digits.
  Through the count-in the panel reddens; from the shift point (shift lights on) and on the limiter it
  flashes, solid red then grey with the ring and dots in red, and is grey again after the upshift. It follows *HUD colours*, the light fill and colours, the peak, the grade and the power
  bar (along its bottom).

*Shift light style* (Settings) works on Arc, Ramp and Dial as on the other layouts: M is the cars' own colours,
Race counts in green then red and flashes blue, one colour counts in white. With the HUD's *Shift
lights* off they don't count in or flash for the shift (the limiter still flashes); GT3 and left to
right make no difference here: Arc and Ramp fill left to right like the cars, Dial along its band.
On Dial the band is the shift lights too, so it stays with *Rev bar* off; on Ramp *Rev bar* off leaves the lights and the gear.

On all three the shift grade takes the first readout's place; with *Burst* a ring grows from the gear
(or the dial) and the lit band flashes the grade's colour. The whole band flashes red at the shift and
on the limiter, as in the cars.

**HUD drawing: a picture, not a shader.** The HUD is a 400x130 picture sent to cluster-render, only the
part that changed and only when it changes. Drawing the moving parts with a shader (a cluster-render effect
layer) was tried in 1.16 and left out, because of where the shader runs:

- The HUD is drawn by the **instrument cluster**, not the head unit. cluster-render hands it the HUD's
  content, shaders included, and the cluster's own graphics chip runs them.
- A shader for every layout (the lights, bar, digits and bands, with arrays of up to 40 colours and
  loops of up to 80 steps a pixel) **restarted the instrument cluster twice** within seconds on a G21
  (2026-11-09, cluster-render log: "Dcsm2 not available" 5 s and 2 s after the HUD was shown). The car
  showed brake, ABS and stability warnings and "Driver assistance restricted" until it had slept, and
  cluster-render's guard turned the HUD off.
- The likely cause is the cluster's GPU limits: OpenGL ES 2 only promises 16 uniform vectors a shader
  and many embedded chips stop at 64; this shader used about 70, and a lot of work a pixel. A desktop
  GPU (where it was checked, in WebGL) allows over 1000, so nothing showed there.
- A cluster restart while driving is a safety risk (speedometer, warning lights and driver assistance
  gone or limited for seconds), and a shader is sent whenever its layer is made: at start, after a
  cluster-render restart, or on a Sport / Comfort switch to another layout.
- What it would have saved is small: the picture path sends about 100 KB/s, where the cluster map sends
  about 3.8 MB/s. A smaller shader for the Arc alone (8 colours, ~22 uniform vectors) ran without trouble,
  but its shift lights felt slightly late next to the picture.

So every layout is a picture. A GPU path would need shaders kept well inside what the cluster takes, made
only while parked, and tested parked first.

**Gear font** (*Gear font*): Auto (Barlow SemiBold on Arc and Dial, Redline's own squared digits on Ramp, Ubuntu on the others),
Ubuntu or Barlow. Barlow (SIL Open Font License 1.1, `kit/runtime/fonts/OFL-Barlow.txt`) is the free
font closest to the BMW Type digits these HUDs use; BMW's own font can't be shipped. A font that is
missing falls back to Ubuntu.

**Palettes** (*Colours*): Colour (green / yellow / red), Night amber, Ice white.

**Choosing a look: the HUD looks tab.**

- **Live preview:** on the left, your HUD as set up at twice its size, playing a scripted drive.
  It counts in, flashes, shifts (graded spot on, early or late in turn), hits the limiter, then
  brakes with the downshift arrows counting up. It uses the HUD's own drawing code and your
  current settings, so every change shows in it at once.
- **Picking:** on the right, the layouts in three rows; tap one to use it. With more than nine they
  scroll sideways a column at a time (the arrows either side, by touch or the controller) instead of
  getting smaller, and the one in use is brought into view.
- **Sport or Comfort:** under the preview, **SPORT** and **COMFORT / ECO PRO** pick the setup you're
  looking at and changing; with Comfort picked, *Same as Sport*, *Its own* or *Don't show* beside it.
  Everything on the page then shows and changes that setup (size and position are shared).
- **Editing:** under that, five tabs, each showing its changes in the preview at once.
  Switches show a lit green dot when on.
  - **Look:** HUD colours (not on VFD and the M layouts, which keep their own), gear font, label
    size, and how the rpm reads (exact, steady, thousands).
  - **Gauge:** the shift lights (GT3, left to right, or off) and their colours (M, Race, one
    colour: the centre screen's too), which parts show (rev bar, gear, gear mode) and unlit
    segments (dim or hidden). Every part can be turned off, so the HUD can be, say, the lights alone.
  - **Readouts:** *Engine*: RPM, Boost, Torque, Power, G-force, Knock, Tyres. *Temps*: Oil, Water,
    Gearbox, Outside, the cold-engine limit, and *Only when cold or hot*. Up to four show, in this
    order; when more are on, the last plain ones give way, so a cold or hot reading keeps its place.
    *Engine / Electric* switches to the electrical readouts: *12 V*: Charge, Voltage (every car);
    *Hybrid*: Charge, Power, Temp, Voltage (only on a plug-in hybrid: see
    [Electrical](#electrical)).
  - **Alerts:** the shift grade (Burst / Simple / Off), the knock warning, the launch time, the
    peak marker, the limiter shake, and the downshift arrows (When braking / Always / Off; to every
    gear or the best one).
  - **Tyres** (only once the car has sent tyre pressures): the tyre widget. When it shows (when a tyre
    is low / always / off), its unit, its parts (the car, each tyre's target, the temperatures) and
    where its corner is (moving it moves the directions too). The preview shows it three times its
    size: your tyres, or a sample ([Tyres](#tyres)).
  - **Place:** smaller / bigger, and move left / right / up / down, live on the glass. Reset puts
    it back.
- **Play on HUD:** runs the same drive on the glass for 20 s (two loops). It's meant for when
  you're parked. Nothing is learned from it.
- Units (speed, temperature, torque, power, boost) are in *Settings → Units*. Everything above is
  also in Settings with *All HUD options here* on.

**Effects:**

- **Shift grade:** *Burst* (the default) pops the word in (PERFECT SHIFT for a spot-on shift, then
  EARLY, LATE, LIMITER or COLD REV), grows
  a ring from it and fades it out. *Simple* shows the plain word; *Off* shows nothing.
- **Shake on the limiter** (off by default): the whole picture jitters a couple of pixels while
  the bar, lights and gear flash red.

**Sport and Comfort** (two HUD setups): the car's driving mode (FES `statusFESVehicleDynamicSwitchHMI`,
as Live Data shows it) picks which one shows.

- **Sport** is used in Sport, Sport+, Sport Individual and XtraBoost, a mode it doesn't know, or when the car
  doesn't send the mode, so the HUD never disappears for lack of a signal. Adaptive counts as Comfort, and so do a
  plug-in hybrid's Hybrid, Electric and battery modes until the car is known to be a hybrid (then they have their own,
  below).
- **Comfort / Eco Pro** is one of three (*In Comfort / Eco Pro*, in Settings and on HUD looks):
  - *Same HUD as Sport*: one HUD for every mode.
  - *Its own HUD*: a setup of its own: layout, colours, readouts, alerts, everything on HUD looks.
    It starts as a copy of Sport's. On HUD looks, with **COMFORT / ECO PRO** picked, changing
    anything makes Comfort its own, so nothing needs switching on first.
  - *Don't show* (the default): Redline steps aside (BMW's own HUD shows) in Comfort and Eco Pro; it comes back as
    soon as the mode is Sport. Comfort's own setup, if it has one, is kept for later.
- **Hybrid / Electric** (only on a car known to be a plug-in hybrid): its Hybrid, Electric and battery modes, the
  same three choices (*In Hybrid / Electric*), but *Same HUD as Sport* by default: on a hybrid these are the everyday
  modes, where the power bar matters most. Its own tab on HUD looks.
- Each setup of its own also has its own size and position (PLACE on HUD looks, with that mode's tab picked): a
  small HUD in a corner for Comfort, say, and the full one for Sport. The HUD moves when the driving mode changes.
- Shared by all: units, the light colours and the downshift arrows (the centre screen uses those too).
- From 1.14 / 1.15, *In Comfort / Eco Pro: Hide* stays hidden, and *Shift lights and gear only*
  becomes Comfort's own setup without readouts or alerts.

HUD looks opens on the setup of the mode the car is in; *Play on HUD* plays the one picked there.

**The readouts row** (standard layout), left to right:

- **RPM:** the engine speed as a number (7-segment digits in the digital and VFD layouts).
- **Torque** (Nm, lb-ft or kgm) from the engine's own torque signal, and **power** (hp, PS or kW)
  worked out from torque and rpm. Both off by default.
- **Throttle** is left out for now: the accelerator pedal signal's scaling isn't confirmed (on a
  G21 it read 60-96 % at a light touch). It comes back once checked against the engine unit.
- **G-force:** sideways and forward / braking together, from the car's acceleration sensor. Off
  by default.
- **Outside temperature:** blue at 3 °C and below, where ice is possible. Off by default.
- **Boost:** in bar, from the iDrive sport display. It shows only once the car has sent a value
  that moves; some cars send a constant.
- **LIMIT:** the cold-engine shift point, while the cold guard holds it down.
- **Oil, water and gearbox temperatures.** On *Temperatures: only when cold or hot* (the
  default) a temperature shows only while it's cold, warming (oil under *Oil warm at*) or hot,
  so a warm car shows none.

At most four readouts fit; on a cold start the gearbox temperature gives way. For 1.5 s after
each upshift, the row shows that shift's grade instead (*Shift grade after each upshift*):
SPOT ON, EARLY, LATE, LIMITER or COLD REV, from Redline's scoring.

Black is see-through on the HUD glass, so everything is drawn on black. Unlit lights and bar
segments can be faint or hidden (*Unlit segments*).

The temperatures sit to the right of x 150. That's because BMW draws its driver-assistance
graphic (lanes, steering wheel, ACC distance) under the left of the bar.

Readout colours (Colour palette): blue is cold, yellow means the oil is still warming, white is
normal and red is hot. A reading with no data is left out.

### HUD settings (shown while the HUD is on)

Settings keeps the HUD short: **Show on HUD**, **HUD layout**, **In Comfort / Eco Pro** and **All HUD
options here**. Everything
else is on the **HUD looks** page, by picture and with a live preview. Switch *All HUD options here*
on to also list them in Settings, as five groups (*HUD: look*, *gauge*, *readouts*, *alerts*, *place*);
they set the Sport HUD (Comfort's own is set up on HUD looks). The rest of Settings is grouped too: *Shift point*, *Engine*, *Learning*, *Units* (all
five units, app-wide), *Screen*, and behind *Advanced settings*, the renderer and the HUD's frame
rate, readout refresh and hand-back. Every change shows on the HUD at once. The tables
below list them by what they do.

**HUD style:** how it looks.

| Setting | Values |
|---|---|
| Layout | Standard / Minimal / Split wings / 80s digital dash / VFD glow / Vector arcade / Arc / Ramp / Dial |
| Gear font | Auto (Barlow on Arc and Dial, squared on Ramp) / Ubuntu / Barlow |
| Colours | Colour / Night amber / Ice white (not for VFD, Arc, Ramp or Dial, which have their own) |
| Shift lights | GT3 (outside in, flash) / left to right / off |
| Shift grade after each upshift | Burst / Simple / Off |
| Peak marker | on / off |
| Shake on the limiter | on / off (off: each shake step resends the whole picture) |
| In Comfort / Eco Pro | Same HUD as Sport / Its own HUD (set up on HUD looks) / Don't show (BMW's own HUD) |
| Unlit segments | dim / hidden |

**HUD readouts:** what it shows, each on its own switch.

| Setting | Values |
|---|---|
| Gear | on / off |
| Speed | off (default) / on: KM/H or MPH (Settings → Units → *Speed unit*) first in the readouts; on Ramp it sits under the gear like the G80's. Off by default as BMW's own HUD shows the speed |
| RPM | on / off: a number in the readouts row; the 7-segment digits in the digital and VFD layouts |
| RPM readout | Exact (to 10 rpm, default) / Steady (to 50 rpm) / Thousands (KRPM 4.5) |
| Readouts refresh | 4 (default) / 10 / 20 a second. Faster sends more frames to the HUD while the numbers change (experimental) |
| Readout labels | Normal / Clearer (bigger, full brightness). Also under HUD looks → Look |
| Boost | on / off |
| Boost unit | bar / psi / kPa |
| Oil, Water, Gearbox temperature | on / off each |
| Cold-engine shift limit | on / off (the LIMIT readout while the cold guard holds the shift point down) |
| Launch time | on (default) / off: after a standing start, the 0-100 km/h (0-60 mph) time and its difference to your best, for 3 s ([Launch score](#launch-score)) |
| Knock warning | on (default) / off: KNOCK when the engine pulls timing ([Knock](#knock)) |
| Knock retard | off (default) / on: the degrees knock control takes, only while it takes some |
| Fuel use (experimental) | off (default) / on: the engine's fuel use, per 100 km while moving, per hour when stopped ([Fuel use](#fuel-use)) |
| Fuel use unit | l/100 km (default) / mpg (UK) / mpg (US) / km/l |
| Tyres | off (default) / on: TYRES over the four pressures in a 2x2 block (front over rear), each coloured against its target; on Arc, Ramp and Dial the worst tyre (TYRE RR 2.1) ([Tyres](#tyres)) |
| Tyre widget | when a tyre is low (default) / low or warming up / always / off: the four tyres in the directions' corner, when they have no turn ([Tyres](#tyres)) |
| Tyre widget: the car, tyre temperatures | on (default) / off each |
| Tyre widget: each tyre's target | off (default) / on: the target pressure small after each pressure, as "/2.5" |
| 12 V battery charge, 12 V battery voltage | off (default) / on each, on every car ([Electrical](#electrical)) |
| Hybrid battery charge, power, temperature, voltage | off (default) / on each; listed only on a plug-in hybrid ([Electrical](#electrical)) |
| Recovery / power bar ("Power bar" on HUD looks) | off (default) / on: regen and drive power drawn along the layout's own gauge; only on a plug-in hybrid ([Electrical](#electrical)) |
| Temperatures | only when cold or hot / always |
| Temperature unit | °C / °F, in the app and on the HUD (the cold and hot colours go by °C either way) |
| Torque unit | Nm / lb-ft / kgm, on the HUD and the Learned page's torque curve |
| Tyre pressure unit | bar (default) / psi / kPa, on the HUD |

At most four readouts fit the row; past that the last one gives way.

**HUD position and size:** set once.

| Setting | Values |
|---|---|
| Size | 40–130 %, scaled about the top centre |
| Position left / right, up / down | px (left to −120, right to +280; up to −120, so Minimal's lights can sit over BMW's own rev gauge, down to +220, so a small tach fits the glass's bottom right corner); moves the layer only. HUD looks → Place warns when the tach reaches outside the part of the glass you see (as measured on one car by [bimmer-lab](https://github.com/bimmer-lab/apps), `shared/visible.js`, MIT) |
| Frame rate | 10 / 20 / 30 fps (20); see [Performance](#performance) |

### Directions (experimental)

With Redline on the HUD, the KOMBI hides BMW's own direction card behind it (2026-11-09 drive). So while a
route runs, Redline draws the next turn itself: a small picture (200x76) in the bottom right corner of the glass,
right of BMW's limit sign and speed, which sit at the bottom left. It never covers the tach (rev bar, gear,
readouts, grade, downshift arrows) or BMW's speed: when the tach's *Size* or *Position* reaches the corner, the
directions move to the nearest clear place (under, beside or above the tach), the one reaching least past the
glass's edge. Checked for every size and position the settings allow.

```
[ tach ...................................... ]
                                   [arrow] 450 m
(50) ——— km/h                              Example Street     (or the lanes ▏↑▏↑▏↱▏ in its place)
```

- **Arrow:** thick and white (the HUD colours' text colour; Night amber draws it amber), roads not taken dim. One
  for every value in the car's catalog (`navigation.GuidingTypes`), each checked by the tests:
  - turns (`TurnDirection`): straight, slight / normal / hard left and right, U-turns; `NONE`: a dot;
  - branches (`BranchType`, 15): road branching off, two- and three-way forks, motorway exit (left, right, straight
    on), motorway entry (left, right, straight on), over- and underpass;
  - the exact junction shape (`detailedGeometry`, 31) when the car sends one: exit taken or passed, an exit that
    forks again, two- and three-way forks with the leg taken (the drive only sent `UNDEFINED`);
  - roundabouts: the way in, round and out at the exit's angle, the number inside. The car's `driveDirection` is
    the traffic side: `LEFT` (the drive, in Australia) goes round clockwise, `RIGHT` anticlockwise. Its
    `exitAngle` is read as degrees clockwise from straight on (the drive's exit 1 at 307 = 53° left, where a
    first exit is in left-hand traffic); without one, from the exit's number. Coming back the way you came (about
    180°): in on the traffic side and out beside it. Right-hand traffic hasn't been seen on a car yet;
  - keep left / right along the main road, lane change, the destination flag (with a pointer when it's on the left
    or right), a stopover pin with its number, a ferry, a car train;
  - not turns, and never shown in place of the next one: tunnels, borders, toll gates, speed cameras, dangerous
    curves, school zones, traffic, points of interest, placeholders. A kind newer than the catalog: a dot.
- **Distance** as the car formats it (`450 m`, `4.7 km`, `0.3 mi`); under it the **street** (accents dropped: the
  HUD's fonts are ASCII), or the **lanes** when there are some. Lanes are drawn like road markings, with thinner
  lines than the big arrow: one stem per lane, turns leaving low and straight on running to the top, so a
  straight-and-right lane keeps both heads apart. The arrows to take (`directionsToFollow`, which can be several) are
  bright in a lane to be in; everything else is dim. A blocked lane gets a cross; "more lanes than shown"
  (`ELLIPSIS`) three dots; the lines between lanes are solid or dashed as the car says. Bus, HOV, bike and toll lanes
  aren't marked yet. Right-aligned, so it hugs the corner.
- **Where it comes from:** BMW's guidance service, read-only, the same way for CarPlay, Android Auto and BMW's own
  navigation: the route's next events (`GuidanceEventList.queryContent`, asked once a second while a route runs),
  the lanes (`currentLaneGuiding`) and, for BMW's navigation, `conclusiveDart`. Proven on a G21 with CarPlay /
  Apple Maps; BMW navigation and Android Auto not yet. Waze over CarPlay gives the car no turns (checked on the
  G21, 2026-11-10), so it shows no directions: only apps that send their turns to the car can. The interfaces are the ones jaimeen77's Cluster Redline
  (jaimeen77-cmyk/apps, MPL-2.0) reads; Redline's decoder and drawing are its own (`nav.js`, `hud-nav.js`).
- **Safety:** a turn older than 3 s isn't shown: a slow or failed reply, a reply without a turn or a busy head unit
  shows the tach without an arrow, never a stale one. An old turn never comes back after a route ends or changes
  hands (a reply asked before that is dropped); a route ends when CarPlay / Android Auto stop guiding, BMW's
  guidance stops, the provider changes or a source reports itself gone. A direction the car sends that isn't in its
  catalog (by name or number) draws no arrow, only the "follow the route" dot; a junction shape that contradicts the
  direction is ignored. Lanes stay with the turn they came with and go with it.
  Two phones and no telling whose route (both say they're guiding, or BMW names one while the other is guiding): no
  arrow and no giving way, the tach stays (the check jaimeen77's Cluster Redline makes).
- **Giving way to BMW's card:** only for BMW's own navigation, when its route certainly runs and Redline has had
  no readable turn for 15 s (from the route's start, the last turn, or the directions coming back on). Never for a
  phone's route (CarPlay, Android Auto): BMW's card for it comes from the same turns Redline reads, so with none
  readable (Waze, for one) there is no card either, and stepping aside only left the HUD empty (issue #91). The tach
  then stays, without an arrow. And never for BMW's navigation once its turns have been read this drive: a reroute (a U-turn, Apple Maps working out the new route)
  shows the tach without an arrow until the new turns come, rather than BMW's card stuck on "Calculating Route" for
  the rest of the trip. Redline then leaves the HUD (tach
  included) for the rest of the route. It's for the route because of how the HUD slot works (cluster-render's
  README): when Redline lets go, the slot stays empty for about 3 s, then BMW's card is shown, and Redline asking
  again is only parked behind it until the card goes at the route's end. Coming back sooner would only blank the
  HUD again and again. Redline comes back when the route ends, or when nothing has answered for 60 s (a phone gone
  with its "guiding" flag left on); behind BMW's card if it's still there. While giving way Redline keeps its claim
  on the HUD, so Cluster functions doesn't put its map over BMW's card.
- **Load:** BMW's event list is asked once a second only while a route runs and the HUD and its directions are on;
  after a failed call the next waits 2 s, and a failed connection is tried again every 30 s. The timings use a
  clock that doesn't jump when the head unit sets its time. A picture is about 0.1 ms to draw and is redrawn only
  when what it shows changes. A directions layer the renderer fails is made again after 5 s.
- **The street line:** under the distance; one too long for the line wraps onto a second, a size smaller ("On your
  left: 32 / Example Street"), and only what doesn't fit in two lines ends with "…".
- **Then:** a turn close behind the next one is shown as "then" + a small arrow on the second line (the street's
  place), so you can pick the lane for both. CarPlay sends it without a distance, also for a turn kilometres on:
  shown after a turn, not after a straight on (a roundabout's straight-on exit included), and never the turn just
  made (CarPlay lists it after the new one for a moment); with BMW's own navigation, when the gap is 150 m or less, with the gap ("then <- 50 m", in yards for UK
  units). With lanes on the second line, the small arrow sits after the distance.
- **Settings:** *Directions on the HUD*: **While a route runs** (default) / **Near turns** (under 1 km, and
  whenever there are lanes) / **Off** (as before 2.0: Redline keeps the HUD, BMW's card stays hidden).
  Under *Advanced*: *Directions left / right* and *up / down* (px from the corner). The test pattern shows a sample
  turn where they go.
- A picture, like the rest of the HUD since 1.16.7 (no GPU drawing). It is redrawn only when what it shows
  changes (the distance counting down), and only the changed part is sent.

### What it does with BMW's content

- BMW's speed, limit sign and assistance graphics stay in their own HUD slots, which cluster-render never takes.
  BMW's direction card is hidden while Redline is on the HUD: [Directions](#directions-experimental).
- When BMW shows a pop-up on the HUD (media, lists), cluster-render moves the tach aside. It
  comes back about 1.5 s after the pop-up goes. Redline pauses drawing in the meantime.
- **A call ringing (since 2.0.42, issue #181).** BMW's call card could outlast cluster-render's pop-up wait, so the
  tach came back over it while the phone still rang. Redline now reads the head unit's call state
  (`ConnectivityAggregator.aggregatedCallState`) and stays off the HUD while a call rings. It keeps the HUD
  claim, so BMW's card shows, not Cluster functions' map. It comes back 2 s after the ringing stops (answered,
  declined or missed). Only ringing counts: during the call and on an outgoing call the tach shows as before.
  A ring lasting more than 90 s is let go, so a lost "call over" can't keep the tach off. The Learned page says
  *HUD: giving way to the call*. A unit without the interface installs and runs Redline as before.
- **The mapping guard (cluster-render's, not Redline's).**
  - Each time the cluster's display service goes away within 10 s of the HUD being mapped is a strike.
    That covers a cluster restart, and also, it seems, the cluster going off at switch-off. Two strikes turn the
    HUD off for good.
  - The Learned page then says *HUD: off after display errors*.
  - To get the HUD back, update Cluster renderer to a newer version from the MGU Store (a new version
    forgets the strikes; reinstalling the same one doesn't), or run this over SSH as root:
    `/var/opt/cluster-render/current/cluster-render guard-reset`. A Redline update doesn't clear it.
  - Since 2.0.22 Redline gives the guard nothing to strike at switch-off (issue #141):
    - a driving mode the car stops sending as it switches off keeps the last one. Before, an unknown mode counted
      as Sport, so in Comfort on *Don't show* the tach came back onto the HUD just as the cluster went off;
    - no new HUD layer is made while the car is off (vehicle state 5 or lower) or its drive readiness is starting
      (8) or ending (12). The Learned page says *HUD: waits for the car to be switched on*.
  - Since 2.0.34 (the user's cluster-render log: both strikes 1.5-2 s after a mapping at switch-off, none at start-up):
    - a tach already on the HUD is dropped when the car's drive readiness ends (12) or it is off (5 or lower), so
      cluster-render has nothing to map again as the cluster goes;
    - a vehicle state the car sends that Redline doesn't know (15, "no value", among them) holds back a new layer
      too: the last known state may be stale. Each new state is logged once (`vehicle state: …`);
    - when giving way to BMW's directions ends with nothing to show (the route over, as at switch-off), the tach
      comes back after 8 s, so the car's state can say first that it's switching off. With a turn to show, at once.
  - *Settings → Logs* shows the guard's strikes (below).

## Shift cue

The 12 lights are a **shift** light, not a rev scale:

- **Count-in.** The lights fill over about the last second before the shift. The rpm span comes
  from how fast the revs climb (800–2000 rpm), so the count takes about as long in 2nd as in 5th.
  In GT3 style the pairs light from both ends inwards: green, yellow, red.
- **Early flash.** All lights flash, by the clock at 5 Hz, early by your reaction time × the climb
  rate (at most 800 rpm), so that your shift lands on the shift point. *Shift lights early by*
  sets the reaction time; *Auto* learns it.
- **Ending the flash.**
  - A gear change ends it, and the next gear counts in afresh.
  - Without a gear signal, a drop of 12 % from the highest rpm while flashing ends it. An upshift
    drops 18 % or more on an 8-speed; a traction dip drops less.
  - Revs falling for 300 ms (a lift) also end it.
- **Lifting or holding.**
  - Lift before the shift point and the lights step back down one at a time.
  - Hold a steady rpm below the shift point and the count stays steady.
  - Hold past the shift point and the lights keep flashing.
- **Limiter.** Within 40 rpm of the redline, the bar, the lights and the gear all flash red.

The yellow mark is the shift point itself. The flash comes before it on purpose: in 1st, the revs
climb about 3000 rpm/s, so a 240 ms reaction means a flash about 700 rpm early.

**Rev bar instead** (Settings → Shift point → *Shift lights*: *Rev bar*, issue #133): the lights are a
plain rev scale. They fill evenly from *From* (4,000 rpm by default) to the redline, the same in every
gear and at any climb rate, and flash at the redline. No count-in, no early flash, and nothing is
learned from it. The centre screen and the HUD both follow it.

## Learning

All of it is on by default and can be frozen with **Learning (experimental) → Learn from
driving**. Values learned before stay in use. Nothing is ever learned from the demo drive. The
**Learned** page (third tab) shows everything, each with a Reset that you press and then confirm.
Its last row, CAR, says what Redline found the car to be: *Petrol car*, *Diesel car* or a hybrid (once
it has shown a high-voltage battery), and *Tyre sensors* or *No tyre sensors* (the tyre options appear
only with them).
On the software renderer, where the page has no buttons, the bar button *Reset learned* (pressed
twice within 5 s) resets them all.

### Redline (the real rev limit)

`limiter.js` watches for the plateau the engine makes on its limiter:

- in gear, moving and with warm oil;
- the rpm stays within a 200 rpm band, with no trend, for 500 ms;
- just before the plateau, the revs were climbing at 600 rpm/s or more. A limiter stops a climb
  dead; easing off to hold an rpm slows it first.

The first value needs **two** such plateaus within 100 rpm of each other. After that, only a
**higher** plateau changes it, for example after a tune. A pull that stops short never lowers it.
A frozen rpm reading (a stale signal) is ignored.

Which redline is used, first that has one: the *Redline* setting, then the learned limit, then the
engine's own (a V8's, below), then the engine profile (petrol 7000, diesel 5000).

A V8 with two engine units has its own Auto redline: **6500** for an N63, **7200** for an M car's S63 or S68.
The G-series V8s share their engine-unit index between the N63 and the S63 (and the S68 of an M5 / XM with that of
an M60i / 760i), so the engine unit's VIN is read once: only its maker code is kept. WBS (BMW M GmbH) means an M car; 5YM (BMW's US
plant, its X5 M and X6 M but some other X5 / X6 too) can't tell, so those keep the profile's 7000. The VIN itself is neither kept nor logged. It is asked only while the diagnostics link is open for the HUD's
knock or fuel readouts, and kept for the next start. The S68 of an M60i / 760i gets 6500 too, though it may cut in
lower (one spec site lists 6300 rpm). Not yet checked on a car; set *Redline* by hand if your engine
differs, or let Redline learn the limiter.

### Shift points, per gear

`shiftmap.js` learns two things:

- **The full-load torque curve**, from the car's crankshaft torque signal. It's binned every
  250 rpm. Each bin is the highest value confirmed by 3 samples within 5 %, so part throttle and
  spikes don't count. Only torque readings less than 300 ms old are used.
- **Each gear's rpm per km/h**, from steady samples above 20 km/h (a running median of 50).

The best upshift from gear g is the first rpm at which the next gear gives at least 99 % of the
wheel torque you have now. If that never happens before the redline, the point is the redline.
The 99 % means a flat-power engine settles on the earliest equally good point.

The learned point is held 150 rpm under the redline, so a shift on it never looks like the
limiter. **Minimum shift point** sets a floor, and the cold guard still lowers it while the oil is
cold.

To fill the curve, do a few full-throttle pulls, some from low rpm (kickdowns in 2nd–4th), up to
the redline. Until a gear is known, its shift point is *redline − Shift point before redline*.
**Shift point → Redline minus the setting below** turns the per-gear points off.

### Gearbox mode (D / S / M)

Redline reads the programme the cluster shows by the gear (MDrive, as Car Vitals does). In **D**
or **S** the gearbox picks the shift moment, so those shifts don't teach the reaction time, don't
get a grade on the HUD, and the downshift arrows (*while slowing down*) stay off. In **M**,
including paddling from D, everything works. If the car never sends the programme, nothing is held
back. The HUD can show the mode as a small letter by the gear (*HUD readouts → Gearbox mode*). The
log lists the raw values (`gearbox programme: …`), so the detection can be checked on a new car.

### Reaction time

With *Shift lights early by* on **Auto**, each upshift after a flash you could see (HUD shown,
lights on) checks how late it came: (shift rpm − shift point) ÷ climb rate. The lead then moves
30 % of the way to what would have hit the point, within 0–600 ms. On a fast climb the flash can
come at most 800 rpm early, so the lead it really had is used (not the one asked for); otherwise
quick shifts in 1st and 2nd would push the lead up and make higher gears flash too early. A shift that
comes more than 700 ms after the revs started falling (you lifted first) is not used.

## Downshift cue

Cyan arrows under the HUD gear, and beside the gear on the screen, show how many gears (up to 3)
you can drop without the revs passing that gear's shift point less 300 rpm. The rpm after a
downshift is your speed × that gear's learned rpm per km/h, so the arrows appear once the gear
ratios are learned.

*Downshift cue*:

- **While slowing down** (default): under braking of 6 km/h per second or more. Off-throttle
  coasting doesn't count.
- **Always**.
- **Off**.

*Downshift arrows show*:

- **Every gear you can drop** (default): as above.
- **Best gear**: only as far as the power band, the lowest rpm where the engine makes 90 % of its
  peak power on the learned torque curve. No arrows when you're already in it; the fewest drops that
  reach it; all you can drop when none does. Until the curve is learned, the same as Every gear.

## Knock

The engine unit's knock control, the same values Live Data shows (*Ignition and knock*): its ignition
retard (DID `554C`, the cylinders' mean, 0.375° steps) and knock detected (`4A36`), read twice a second
over read-only diagnostics while the HUD shows and the engine runs (the gearbox reader's link).
**KNOCK** shows where the grade goes when the retard reaches 2.25° or the engine flags knock, and stays
while it does; it goes before a grade or launch time. On Minimal and Split wings, which show no grades,
the gear turns red (Minimal also writes KNOCK under its lights). The *Knock retard* readout shows the
degrees, only from 0.75°. A car whose engine unit doesn't answer `554C` shows nothing (logged once:
`knock: the engine unit gives no knock retard`). The threshold is from the catalogue's scaling and not
yet checked on a car. A V8 with two engine units (N63, S63, S68: the master's SGBD index says so,
`kit/runtime/twin_dme.js`) has each bank's knock control in its own unit: the second one (`0x13`) is read too, and the
larger retard of the two banks and a knock flag from either count.

### Fuel use

*Fuel* (off by default, any car): the engine's fuel rate from the engine unit over read-only diagnostics, once a
second while the readout is on and the engine runs (the gearbox reader's link), smoothed over about 2 s. First
that answers: `5656` (fuel volume flow, ml/s), OBD `5E` (fuel rate, l/h), `4521` (fuel mass flow, over the
fuel's density). Shown as **L/100KM** while moving (or **MPG**, **MPG US**, **KM/L**: *Fuel use unit* in
Units), and as **L/H** (or **GAL/H**) under 5 km/h. Coasting with the fuel cut shows 0.0, and so does the engine off once it has given a rate (electric driving, auto start-stop). A car whose engine
unit answers none of them shows nothing (logged once). Not yet checked on a car. On a V8 with two engine units
`5656` is each unit's own bank, so the rate is both units' `5656` added, else OBD `5E` (the whole engine's); `4521`
isn't used there, and such a car shows no rate rather than half of it.

## Electrical

Read from the car itself, the way eDrive reads them (never from another app's files):

| Readout | Shows | From |
|---|---|---|
| KM/H / MPH | the car's speed in the app's *Speed unit* (setting *Speed*, off by default) | the car's signal `Vehicle2.statusCarSpeed2`, as the launch timer uses |
| 12V CHARGE | 12 V battery charge, % (yellow under 60, red under 40) | the car's signal `CDS.statusBattery2` |
| 12V | 12 V battery voltage, 0.1 V (yellow under 12.0, red under 11.5 or over 15.0) | UDS `F442` from the engine unit (`0x12`), else OBD `42`, a second engine unit, the gearbox unit (`0x18`) or the battery sensor (`402B`, `5853`): eDrive's list, the one that answers is kept |
| HV CHARGE | hybrid battery charge, % | UDS `DDBC` from the battery unit (SME `0x07`), every 5 s |
| HV KW | hybrid battery power, kW: + drives, − charging (regen) | pack voltage (`DDB4` / `DD68` / `DD66` / `DDEF`) × current (`DD69`) from the SME, twice a second |
| POWER (meter) | the recovery / power meter, like BMW's hybrid power meter, drawn along each layout's own gauge (not in the readouts row): *Ramp* a thin strip under its band (recovery down the climb, power along the flat, zero at the knee); *Arc* and *Dial* a ring inside / outside their band; *Standard* and *Vector* a strip of slanted segments under the rev bar; *80s digital* and *VFD* a row of bar-graph segments under the graph. Recovery green (blue on VFD) left of zero (to 40 kW), power right (to 80 kW, yellow near the end); no number (HV KW shows it). *Minimal* and *Split wings* have no readouts and no meter | the same as HV KW |
| HV TEMP | hybrid battery temperature (blue under 5 °C, red over 45 °C) | `Efficiencytainment2.statusBatteryTemperature` |
| HV VOLTS | pack voltage | `LSCDataSink.statusHighVoltageStorage` (or the SME's when it is read for power) |

Each shows only while the car sends it. **Petrol and diesel cars never see the hybrid ones**: not on the
HUD, not on *HUD looks*, not in Settings. They appear once the car shows a high-voltage battery: a 150–500 V
pack voltage in its signals that changes over at least 10 s (a stuck or "no value" reading such as 409.5 V
never counts), or the SME answering `DDBC` (asked once per start while the HUD is on, also while the driving
mode hides it, until found; logged `electrical: no high-voltage battery unit` on a car without one). A battery temperature alone
doesn't count: a 48 V mild hybrid, or a petrol car, may send one for another battery. Once found it is
remembered, and the log says what found it, with the raw value
(`electrical: high-voltage battery found (…)`). 2.0.12 clears it once: 2.0.0–2.0.8 could take a single odd
voltage for a hybrid battery, and a real hybrid finds it again within a drive.

**On a plug-in hybrid:** once the car is known to be one, its Hybrid, Electric and battery modes get their own
setup, *In Hybrid / Electric* (Settings, and a third tab on *HUD looks*), which follows Sport by default, so the
hybrid readouts and the power bar show in the car's everyday mode. Until then those modes count as Comfort.

The UDS reads are read-only, on the gearbox reader's link, only while a readout that needs them is on, and
only once that link is up. Each waits at most about a second for an answer, so a unit that stays quiet
doesn't hold up the knock and gearbox reads on the same link; one that doesn't answer three times is asked
once a minute. The hybrid battery's power, once it has answered in a drive, is treated as a hiccup when it misses:
the same reading is asked again (no search through the others), and every 2 s after a run of misses, so the
recovery / power meter is back within seconds rather than gone for up to a minute (seen on an X5 45e).

The electric share of the drive (KombiIF's power distribution) is left out until its scale is known: eDrive
doesn't show it either.

None is checked on a car yet: the 12 V ones can be checked on any car, the hybrid ones need a plug-in
hybrid. The power's sign (+ drive, − regen) is eDrive's, checked only on an X5 45e. A 48 V mild hybrid
shows only the 12 V ones (its 48 V battery is in eDrive).

## Tyres

Redline's own reading of the car's tyre pressure signals; nothing of Car Vitals is loaded or read. The
scaling is the one Car Vitals worked out on cars:

| Signal | What | Scaling |
|---|---|---|
| `TPMS.statusTyrePressure` | each tyre's pressure | 0.1 × raw in the car's pressure unit; 65532 and up = none |
| `TPMS.statusTargetTyrePressure` | each tyre's target | the same |
| `TPMS.statusTyreTemperature` | each tyre's temperature | the car's degrees + 40; 65535 = none |
| `Vehicle.statusNewCurrentUnitsStatusExt` | the car's units (bar / kPa / psi, °C / °F) | until the car says, told from the value: bar 0.5–6, psi 7–60, kPa 60–600 (psi means °F too) |

**Colours**, against each tyre's own target (Car Vitals' tyre card's bands): red under 85 %, orange
under 93 % or over 115 %, green between. Without a target, white. The tyre temperature is blue under
20 °C, orange over 90, red over 105.

**The Tyres readout** shows TYRES over the four pressures in a 2x2 block, front over rear. Where readouts
are a label and a value (Arc, Ramp, Dial) it is the worst tyre: the lowest against its target. While every
tyre is green it is a plain readout, so with more than four on it gives way like one.

**The tyre widget** is a second small picture beside the tach: the directions' (200×76, the glass's
bottom right corner, the same layer and place). The directions come first: while they have a turn to
show, the corner is theirs, and the tyres come back when it's done. In it: the car from above with the
unit inside, a tyre at each corner, and beside each its pressure big, then the tyre's temperature under
it. The colour says how each tyre is against its target, so the target itself is off by default; switched
on (*Target*), it shows small after the pressure as "/2.5". The car and the temperatures can be switched
off too; with no temperatures the pressures are bigger. Text that wouldn't fit its room (kPa,
*Clearer* labels) is drawn smaller. It uses the HUD colours.

**Warm-up:** each tyre in the car is blue while cold (20 °C and under) and turns green as it warms up,
green from 40 °C; orange and red when it runs hot, as above. The temperature under each pressure follows
it until the tyre is warm. The sensors measure the air in the tyre, which runs cooler than the tread.

It shows **when a tyre is low** (the default: red, under 85 % of its target; it goes when the tyre is
pumped up), **when low or warming up** (for a track day: up while any tyre is under 40 °C, gone once all
four are warm), **always**, or **never**. Set it up on *HUD looks → TYRES*; its corner moves with *MOVE*
there, which moves the directions too (*Directions left / right*, *up / down*). The TYRES tab, the Tyres
readout switch and these settings show only once the car has sent a tyre pressure, so a car without
tyre data never sees them. Logged `hud: low tyre RR: the tyre widget shows`.

The car sends the tyres every few seconds while driving; a value over 10 minutes old isn't shown. The
first raw values of each kind are logged (`tyres: raw pressure [...]`) to check the scaling on a new
car. Not yet checked on a car.

## Launch score

Each standing start is timed 0-100 km/h and 0-60 mph by the run timer Drag Timer uses
(`kit/run_timer.js`: the launch found from a standstill, crossings interpolated between speed samples).
On the HUD, for 3 s, the time in your speed unit and its difference to your best before it: green for a
new best, yellow within 0.1 s, red further off; it goes after knock and a shift grade. Bests are kept
in `launch.json` and forgotten with *Reset all* on the Learned page. Times outside 1.8-30 s (1.7-28 s
for 0-60) aren't counted.

## Files and logs

Everything lives in the app's `data/` folder on the head unit
(`/var/opt/public/oap/oap_<uid>/data/`):

| File | What | Size | Written |
|---|---|---|---|
| `redline.log`, `redline.log.1` | the app's log: at 256 KB it is renamed to `.1` over the older one | ≤ ~512 KB | on events, never per frame; the same kind of line at most every 10 min (`quietlog.js`) |
| `redline-nav.log`, `redline-nav.log.1` | the navigation probe: the same, at 256 KB | ≤ ~512 KB | only while the HUD shows directions (and 10 s after) |
| `redline-power.log`, `redline-power.log.1` | the car's own power meter and fuel-use displays, raw, with Redline's kW, l/h and speed beside them (to learn their scales) | ≤ ~512 KB | only while *Fuel* or the power bar is on, each value at most every 3 s, the first 30 min after each start |
| `settings.json` | settings | small | when a setting changes |
| `limiter.json` | learned redline | < 50 B | when it rises |
| `shiftmap.json` | torque bins and gear ratios | ~0.5–10 KB | at most every 5 min while learning, at most once a minute when a shift point moves |
| `hudlead.json` | learned reaction time | < 50 B | when it moves |
| `engine.json` | detected engine type | tiny | once |
| `launch.json` | best launch times (0-100 km/h, 0-60 mph) | < 100 B | on a new best |

Both logs keep at most two files, so Redline's logs never take more than about 1 MB: the oldest lines are
dropped as new ones come. A line that would repeat (a unit not answering, knock, a low tyre, a plateau on the
limiter) is written once, then again at most every 10 minutes with how many were held back (`(+12 like it)`);
each shift is not logged at all.

Learned files are written to a temp file and renamed, so a power cut can't corrupt them. On
load they are range-checked; a bad file is ignored and relearned.

### Shift values for other apps (`/dev/shm/redline/shift.json`)

While the car is live (never on the demo drive) Redline writes its shift values for other apps on the head unit,
so they needn't copy its scoring (bimmer-lab's HUD Widgets reads them, [bimmer-lab/apps#4](https://github.com/bimmer-lab/apps/issues/4)):

```json
{ "v": 1, "t": 1793560000000, "redline": 6550, "shiftPoints": { "1": 6200, "2": 6250, "3": 6300 },
  "gear": 2, "shiftNow": 6250, "cold": false, "leadMs": 240, "mode": "M",
  "lastShift": { "at": 1793559998000, "from": 2, "to": 3, "rpm": 6280, "target": 6250, "verdict": "SPOT ON" } }
```

`t` is when it was written (ms); a reader treats it as stale after a few seconds (Redline isn't running).
`shiftPoints` has gears 1-8 (learned, else the redline less *Shift point before redline*), `shiftNow` is the
current gear's point (lowered while the oil is cold: `cold`), `leadMs` the reaction lead, `mode` the gearbox
programme (D / S / M, or null). It is written about once a second and at each shift, to a temp file renamed over
it, so it's never read half-written; the folder is 0755 and the file 0644, readable by every app's user
(`shareshift.js`).

### Logs on the screen (Settings → Logs)

The last row of Settings, for when there's no SSH (a remote install). It shows the important lines, newest first:

- **Redline**: `redline.log`'s warnings and errors, each start and switch-off, and the HUD's, driving mode's, car state's
  and directions' lines.
- **Directions**: `redline-nav.log`'s probe, the guide coming and going, the `dir:` lines and errors.
- **Cluster renderer**: its own log (`/var/opt/cluster-render/log/cluster-render.log`): the mapping guard's strikes,
  the display service (Dcsm2) coming and going, heartbeat errors and each start (*cluster-render started*). Not its
  once-a-minute frame counts or each layer made: on a car those buried the strikes. If apps can't read the file, a
  note says so.

Long lines wrap (up to three lines), so the guard's line keeps how to clear it. The times are the head unit's,
UTC on the cars seen so far (the count on the right then says *times UTC*). With no log, the note says which
folder was looked in.

On top: what the HUD is doing, and cluster-render's guard (`guard: hud …: 1 strike`, or `disabled, 2 strikes`).

- **Touch:** pick a source, Refresh, Back to Settings; a finger scrolls the lines.
- **Controller:** turning scrolls, pressing picks the next source, left goes back.

Only the end of each file is read (96 KB, the older `.1` too when the newer one is shorter), when the view opens, a
source is picked or Refresh is tapped. Nothing is written. Only where the kit draws Settings (the GPU renderer);
the HMI's own settings screen has no such row.

### Over SSH

To see what was learned, run this from a computer on the car's hotspot:

```sh
ssh root@172.16.222.97 "grep -h -E 'limiter|shiftmap|hud: |gearbox|electrical|tyres' /var/opt/public/oap/oap_*/data/redline*.log | tail -n 60"
```

Useful lines:

- `hud: target …`: what cluster-render reports (shown, parked behind BMW's content, disabled).
- `redline-nav.log` (beside `redline.log`): the navigation probe, read-only, behind Redline's own HUD
  directions. What BMW's guidance service (`navigation.guiding.Guidance`: route state, which app
  guides, the next manoeuvre with its distance) and the CarPlay / Android Auto managers send, each change
  (the same turn or lanes getting nearer at most every 5 s), only while Redline's directions are on the glass
  (not while it gives way to BMW's card, is hidden, paused or off), and once per kind of manoeuvre every key it has. Coordinates
  are left out, street names are logged as their length only. The interfaces are the ones jaimeen77's Cluster
  Redline (jaimeen77-cmyk/apps) reads; all optional, so a car without them installs Redline as before.
  `dir: …` lines: what the directions show, one line per turn (`dir: turn LEFT 450 m <14 chars> lanes
  *STRAIGHT_ON,NONE`), `dir: giving way to BMW (no turn data)`, `dir: event list <error>`.
- `hud: route without readable turns, BMW's directions shown` / `hud: own directions`: Redline leaving the HUD
  to BMW's card and coming back.
- `hud: phone ringing, the tach gives way to the call card` / `hud: phone active` / `hud: phone none`: the
  call state as the head unit sends it (also `dialing`, `held`); `hud: call state not read: …` once if a car sends
  a value Redline doesn't know.
- `hud: rpm samples every N ms`: how often the car sends rpm.
- `limiter: learned …`
- `shiftmap: 3>4 at 5550`
- `hud: shift at … (N ms late), reaction lead now …`
- `gearbox: EGS 6000 = … C`
- `electrical: 12 V from 18:OBD 42`, `electrical: high-voltage battery found (…)`
- `tyres: the car sends tyre pressures: …`, `tyres: car units: …`, `tyres: raw pressure [...]`, `hud: low tyre RR: …`

## For developers

| File | What |
|---|---|
| `main.js` | The app: the screen pages, settings, scoring, and the wiring of everything below |
| `hud.js` | The HUD layer: connect, pace, smooth the rpm, decide what to show (readouts, grade, peak), send; `shiftCue()` (shared with the screen); the test pattern |
| `hud-draw.js` | Drawing the HUD image: the six layouts, the palettes, 7-segment digits, lights, bar and bar graph, readouts, grade burst, shake, downshift arrows; the cached static layer |
| `hud-theme.js` | What the HUD drawing files share: the grade colours, the grade burst's timing, label fitting |
| `nav.js` | Directions, the data: decodes the route events, `conclusiveDart` and the lanes into the next turn; freshness (3 s) and giving way to BMW's card |
| `navlog.js` | The navigation probe: subscribes to the guidance sources, asks the event list, writes `redline-nav.log`, hands every value to `nav.js` |
| `hud-nav.js` | Directions, the picture (200x76, bottom right corner): thick white arrows, distance, street or lanes |
| `call.js` | The phone ringing: the head unit's call state, so the HUD tach gives way to BMW's call card |
| `limiter.js` | Learned rev limit |
| `shiftmap.js` | Learned torque curve, gear ratios, per-gear shift points |
| `files.js` | `writeAtomic`: the learned files written whole or not at all (temp file, then rename) |
| `fuel.js` | Fuel use: the engine unit's fuel rate (read-only UDS / OBD), smoothed; the readout in l/100 km, mpg or km/l |
| `powerlog.js` | The car's own power meter and fuel-use displays logged raw to `redline-power.log` (scale learning) |
| `quietlog.js` | keeps redline.log small: the same kind of line at most every 10 minutes, with a count of the ones held back |
| `gearbox.js` | Gearbox oil temperature (EGS `0x18` over read-only UDS 22, or SOME/IP BasicDataSet) |
| `knock.js` | Knock retard from the engine unit (read-only UDS 22) |
| `electrical.js` | 12 V and hybrid battery readouts (car signals and read-only UDS; hybrid found by the app) |
| `tyres.js` | Tyre pressures, targets and temperatures from the car's signals; the Tyres readout and its colours |
| `hud-tyres.js` | Drawing the tyre widget (200×76, the directions' corner): the car from above with its four tyres |
| `cluster_render_client.js` | Vendored unchanged from robertnisipeanu/idrive-apps `native/cluster-render/js` (MPL-2.0) |

**Flow.** Car samples (about 10–20 a second) go to `main.js` `onSample`. From there they feed the
screen's shift cue, `limiter.feed`, and `shiftMap.feed` (with fresh torque). The HUD has its own
timer at the *Frame rate*. Each tick it reads `car.data()`, smooths the rpm between samples, runs
its own shift cue and draws. Upshifts detected in `main.js` go to `hud.upshift()` for the reaction
time.

**Rules.**

- **Node 8:** no `?.`, `??`, object spread, `Array.flat` or `Object.fromEntries`.
- **Never let an error escape** a timer, signal or render path: MainApp wipes an app's data the
  first time it exits unexpectedly, and uninstalls it the second time. Every HUD callback goes
  through `safe()`.
- **Two kinds of canvas.**
  - The tach and Learned pages draw on the kit's **Recorder** (`kit/runtime/record.js`), which has
    `quad` but no `convex` or `triangle`.
  - The HUD draws on a **Canvas** (`kit/runtime/canvas.js`). Its `.d` is straight-alpha RGBA,
    which is what cluster-render takes; wrap it in a Buffer before `cr.pixels`.
  - Use `blit` to composite, not `drawImage`: `drawImage` copies pixels without blending alpha.

**Performance (HUD).**

- No drawing while the target isn't showing: parked, waiting, unavailable or disabled. Keep
  drawing while it's idle or acquiring, because cluster-render only asks for the target once the
  layer has content.
- A frame whose inputs haven't changed is skipped.
- The static parts (unlit lights, dim track, red zone, labels) are drawn once per layout.
- Changes go out as up to three strips from a reused buffer: about 2–20 KB a frame. That is well
  inside cluster-render's upload budget (5500 KB/s, with up to half of it for the HUD), which is
  why 30 fps is affordable.

**Checking changes without a car.**

```sh
python kit/tools/build.py redline --preview-only
node kit/tools/preview.js dist/redline preview/redline wait=4 render BTN_PAGE render BTN_PAGE render --set hud=on
```

The preview forces demo data, so nothing is learned; seed `preview/redline/*.json` to see the
Learned page filled. The repo's own checks are in `.github/workflows/app-tests.yml`.
