'use strict';
/**
 * Live Adjustments - native live tweaks for the BMW MGU (iDrive 7), one tab each:
 *   Exhaust Flap - BMW's own 0x60FD on the DME (controller.js + adapters), always there;
 *   Engine Map / Max Cooling / Burbles / Active Sound - the tune picked in Settings
 *   ("Tuning software": Off, BM3, MHD) gets its own tabs (tune.js). Off sends nothing;
 *   xDrive - EXPERIMENTAL, xDrive off until the ignition cycle (xdrive.js), only with its setting on;
 *   xDrive live - read only: front / rear split, wheel slip, steering, yaw and g (xdrive_live.js), with that setting
 *   or once the car showed it has xDrive.
 *
 * Exhaust Flap modes: OEM (hand the flap back to the DME), OPEN (request it open) and
 * CLOSE (request it shut) — the bottom action buttons — and DRIVE MODE: the flap follows the
 * driving mode (auto.js: Sport -> Open, Comfort / Adaptive -> OEM, Eco Pro -> Close; saved with the
 * settings). On top (auto.js): Hold (Open / Close sent again every 15 s, the DME lets a tester's
 * command go after ~20 s) and "Close: hand back above" (Close paused above that engine speed, and
 * without a live engine speed). The command leaves the app only on a button press or, with Drive
 * mode chosen, on a driving mode change; opening the app sends nothing.
 * Control goes through a per-DME adapter over the car's own diagnostic link
 * (kit/diag.js, reused). With "Control source = Simulated" (the default) or when no
 * validated+armed adapter matches the car, it runs fully simulated and touches
 * nothing. The screen separates requested / accepted / confirmed and never shows a
 * request as done without a real read-back.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Canvas } = require('./kit/canvas');
const UI = require('./ui');
const { Controller, REFRESH_KEYS } = require('./controller');
const { TuneControl } = require('./tune');
const { XDriveControl } = require('./xdrive');
const { XDriveLive } = require('./xdrive_live');
const { rescan, EVERY_MS: RESCAN_MS } = require('./rescan');
const Car = require('./kit/car');
const { AutoFlap } = require('./auto');
const { PinLock } = require('./pin');

const FES = 'de.bmw.infotainment.drivingexcitement.FES';
const PIN_PAGES = ['Engine Map', 'Burbles'];   // behind the PIN when its setting is on (pin.js)
const RPM_STALE_MS = 5000;          // the Close rpm guard: an engine speed older than this is none

/** The tabs this car gets: Exhaust Flap always, the picked tune's pages, xDrive when switched on, xDrive live with
 * it or on a car that showed it has xDrive. */
function pagesFor(f, xdrive, live) {
    return ['Exhaust Flap'].concat(f.map ? ['Engine Map'] : [], f.cooling ? ['Max Cooling'] : [],
        f.burbles ? ['Burbles'] : [], f.asd ? ['Active Sound'] : [], xdrive ? ['xDrive'] : [], xdrive || live ? ['xDrive live'] : []);
}

// eased valve angle toward the current state (0 = shut, 1 = open)
function targetAngle(v) {
    const s = v.confirmed !== 'UNKNOWN' ? v.confirmed : v.requested;
    if (s === 'OPEN') return 1;
    if (s === 'CLOSED') return 0;
    if (s === 'OEM') return 0.18;          // DME in control: shown slightly ajar, dimmed
    return 0.5;
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const controller = new Controller(ctx);
        // engine speed for Max Cooling's rpm threshold: live values only, never the demo drive
        // xDrive (experimental) also wants speed and the selector: live values only as well
        const car = new Car(ctx, ['rpm', 'speed', 'gear', 'condition', 'accel']);
        const tune = new TuneControl(ctx, { rpm: () => { const d = car.data(); return d.demo ? null : d.rpm; } });
        const xdrive = new XDriveControl(ctx, car);
        const xlive = new XDriveLive(ctx, car);
        let angle = 0.18;
        let page = 'Exhaust Flap';          // by name: the tune's tabs come and go with the setting
        let loop = null;
        const repaint = () => (loop && loop.kick ? loop.kick() : render());
        // the Close rpm guard's engine speed: live and fresh only, never the demo drive
        const rpm = () => {
            const d = car.data();
            if (d.demo || !Number.isFinite(d.rpm) || d.rpm < 0 || !car.lastCar || Date.now() - car.lastCar > RPM_STALE_MS) return null;
            return d.rpm;
        };
        // what the flap should do (the buttons, Drive mode, hold, the rpm guard): every command goes through the controller
        const auto = new AutoFlap({ controller, get: (k) => settings.get(k), set: (k, v) => settings.set(k, v), rpm, log, onChange: () => repaint() });

        // the four mode presses, each kicks a repaint (used by both the HMI bar and
        // the on-canvas buttons the kit draws when the app owns the screen)
        const press = (mode) => () => { const p = auto.press(mode); repaint(); return p.then(repaint).catch((e) => log.error('action', e)); };
        // a tune action: repaint at once (shows "Sending…"), then again with the DME's answer
        const tuneAct = (fn) => () => { const p = fn(); repaint(); return p.then(repaint).catch((e) => log.error('tune', e)); };
        const acts = {
            oem: press('OEM'), open: press('OPEN'), close: press('CLOSED'), drive: press('DRIVE'),
            map: (n) => tuneAct(() => tune.setMap(n)),
            cooling: (on) => tuneAct(() => tune.setCooling(on)),
            aggDown: () => { tune.stepAggression(-0.5); repaint(); },
            aggUp: () => { tune.stepAggression(0.5); repaint(); },
            burblesApply: tuneAct(() => tune.applyBurbles(false)),
            burblesOff: tuneAct(() => tune.applyBurbles(true)),
            asd: (on) => tuneAct(() => tune.setAsd(on)),
            xdriveOff: tuneAct(() => xdrive.requestOff()),
            xdriveOn: tuneAct(() => xdrive.requestOn()),
        };
        // the PIN in front of the Engine Map and Burbles tabs (setting "PIN for Engine Map and Burbles"); locked again when the app leaves the screen
        const pin = new PinLock({ get: (k) => settings.get(k), set: (k, v) => settings.set(k, v) });
        acts.pinDigit = (n) => () => { pin.digit(n); repaint(); };
        acts.pinBack = () => { pin.back(); repaint(); };
        if (ui.onVisible) ui.onVisible((name, on) => { if (name === 'MAIN' && !on) pin.lock(); });
        const pages = () => pagesFor(tune.features(), xdrive.enabled, xlive.seen);

        const render = async () => {
            const v = controller.view();
            const tgt = targetAngle(v);
            angle += (tgt - angle) * 0.25;            // simple ease per frame
            if (Math.abs(tgt - angle) < 0.003) angle = tgt;
            v.angle = angle;
            v.requested = auto.desired;          // the word when there is no read-back
            v.selected = auto.selected();        // the button lit: DRIVE MODE, or the mode pressed (Close stays lit while paused)
            v.note = auto.note();
            const list = pages();
            if (list.indexOf(page) < 0) page = list[0];   // a tab that went away (disarmed / not detected)
            v.pages = list;
            v.page = page;
            v.tune = tune.view();
            v.pin = pin.locked() && PIN_PAGES.indexOf(page) >= 0 ? pin.view(page) : null;
            if (page === 'xDrive' || page === 'xDrive live') {
                const r = xdrive.tick();             // DBE1 read now and then, only on this tab
                if (r) r.then(repaint).catch((e) => log.error('xdrive', e));
                v.xdrive = xdrive.view();
                if (page === 'xDrive live') v.xlive = xlive.view();
            }
            const t = ctx.theme();
            const cv = ctx.canvas(UI.W, UI.H) || new Canvas(UI.W, UI.H);
            UI.draw(cv, G, t, v, acts);           // acts → the kit draws OEM/OPEN/CLOSE, active one red
            await ui.image('MAIN_GFX', cv);
        };

        loop = ctx.loop('MAIN', 20, render);

        // we draw the four mode buttons on the canvas (active = red, like the other
        // apps), so take them off the HMI bottom bar; SETTINGS stays in the bar.
        ['BTN_OPEN', 'BTN_CLOSE', 'BTN_OEM', 'BTN_DRIVE'].forEach((b) => ctx.hideButton && ctx.hideButton(b));
        ui.onClick('BTN_OPEN', acts.open);        // kept as a fallback if the bar button shows
        ui.onClick('BTN_CLOSE', acts.close);
        ui.onClick('BTN_OEM', acts.oem);
        ui.onClick('BTN_DRIVE', acts.drive);
        ui.onClick('BTN_PAGE', () => { const l = pages(); page = l[(l.indexOf(page) + 1) % l.length]; return render(); });
        ctx.onTab((i) => { const l = pages(); if (l[i]) page = l[i]; return render(); });
        // the DME is looked at again when the flap's or the tune's setting changes, or (armed) while none was found
        // yet: it may have been asleep at start-up. A theme change with the DME found sends nothing.
        const lost = () => controller.armedSetting && !(controller.ident && controller.ident.present);
        settings.onChange((key, value) => { pin.settingChanged(key, value); repaint(); });
        settings.onChange((key) => Promise.resolve((REFRESH_KEYS.indexOf(key) >= 0 || lost()) && controller.refresh())
            .then(() => key === 'tuner' && tune.refresh())
            .then(() => key === 'xdrive' && xdrive.refresh())
            .then(() => auto.settingsChanged(key))
            .then(repaint).catch((e) => log.error('settings', e)));

        // the driving mode (notified on change), also while the app is not on screen: Drive mode follows it
        ctx.signals.watch(FES, '1', {
            statusFESVehicleDynamicSwitchHMI: (s) => {
                const p = auto.driveMode(s && s.actualValueModeDrivingExperience);
                if (p) p.then(repaint);
            },
        }, log).then((s) => log.info('drive mode ' + (s && s.error ? 'error: ' + s.error : 'subscribed')));
        // the Close rpm guard, also while the app is not on screen
        setInterval(() => { auto.tick().catch((e) => log.error('rpm', e)); }, 250);

        await controller.start();        // read-only: detect DME + read state, no actuation
        await tune.start(controller.link);   // nothing at all while "Tuning software" is Off
        await xdrive.start(controller.link); // nothing at all while "xDrive (experimental)" is Off
        await xlive.start();
        // the diagnostic link often comes up after the app started (at boot): detect again then
        // (the car came up: the DME starts on its own strategy, so what is wanted - Drive mode's - goes again)
        if (controller.link) controller.link.onAvailable((on) => controller.refresh().then(() => tune.refresh())
            .then(() => xdrive.refresh()).then(() => (on ? auto.linkUp() : null)).then(repaint).catch((e) => log.error('link', e)));
        // the engine unit (armed) or the DSC (xDrive on) not found at start-up: looked for again, ignition on (rescan.js)
        setInterval(rescan({ car, dmeLost: lost, xdrive, controller, log, repaint }), RESCAN_MS);
        await render();
        log.info('exhaust_control ready (source=' + controller.source + ', adapter=' + controller.adapter.name + ')');
    },
});
