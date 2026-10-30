'use strict';
/**
 * Live Adjustments - native live tweaks for the BMW MGU (iDrive 7), one tab each:
 *   Exhaust Flap - BMW's own 0x60FD on the DME (controller.js + adapters), always there;
 *   Engine Map / Max Cooling / Burbles / Active Sound - the tune picked in Settings
 *   ("Tuning software": Off, BM3, MHD) gets its own tabs (tune.js). Off sends nothing.
 *
 * Exhaust Flap modes: OEM (hand the flap back to the DME), OPEN (request it open) and
 * CLOSE (request it shut) — the bottom action buttons. The command leaves the app only
 * on a button press; opening the app sends nothing.
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
const { Controller } = require('./controller');
const { TuneControl } = require('./tune');

/** The tabs this car gets: Exhaust Flap always, then the picked tune's pages. */
function pagesFor(f) {
    return ['Exhaust Flap'].concat(f.map ? ['Engine Map'] : [], f.cooling ? ['Max Cooling'] : [],
        f.burbles ? ['Burbles'] : [], f.asd ? ['Active Sound'] : []);
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
        const tune = new TuneControl(ctx);
        let angle = 0.18;
        let page = 'Exhaust Flap';          // by name: the tune's tabs come and go with the setting

        // the three mode presses, each kicks a repaint (used by both the HMI bar and
        // the on-canvas buttons the kit draws when the app owns the screen)
        const press = (mode) => () =>
            Promise.resolve(controller.setMode(mode)).then(() => loop && (loop.kick ? loop.kick() : render())).catch((e) => log.error('action', e));
        const repaint = () => (loop && loop.kick ? loop.kick() : render());
        // a tune action: repaint at once (shows "Sending…"), then again with the DME's answer
        const tuneAct = (fn) => () => { const p = fn(); repaint(); return p.then(repaint).catch((e) => log.error('tune', e)); };
        const acts = {
            oem: press('OEM'), open: press('OPEN'), close: press('CLOSED'),
            map: (n) => tuneAct(() => tune.setMap(n)),
            cooling: (on) => tuneAct(() => tune.setCooling(on)),
            aggDown: () => { tune.stepAggression(-0.5); repaint(); },
            aggUp: () => { tune.stepAggression(0.5); repaint(); },
            burblesApply: tuneAct(() => tune.applyBurbles(false)),
            burblesOff: tuneAct(() => tune.applyBurbles(true)),
            asd: (on) => tuneAct(() => tune.setAsd(on)),
        };
        const pages = () => pagesFor(tune.features());

        const render = async () => {
            const v = controller.view();
            const tgt = targetAngle(v);
            angle += (tgt - angle) * 0.25;            // simple ease per frame
            if (Math.abs(tgt - angle) < 0.003) angle = tgt;
            v.angle = angle;
            const list = pages();
            if (list.indexOf(page) < 0) page = list[0];   // a tab that went away (disarmed / not detected)
            v.pages = list;
            v.page = page;
            v.tune = tune.view();
            const t = ctx.theme();
            const cv = ctx.canvas(UI.W, UI.H) || new Canvas(UI.W, UI.H);
            UI.draw(cv, G, t, v, acts);           // acts → the kit draws OEM/OPEN/CLOSE, active one red
            await ui.image('MAIN_GFX', cv);
        };

        const loop = ctx.loop('MAIN', 20, render);

        // we draw the three mode buttons on the canvas (active = red, like the other
        // apps), so take them off the HMI bottom bar; SETTINGS stays in the bar.
        ['BTN_OPEN', 'BTN_CLOSE', 'BTN_OEM'].forEach((b) => ctx.hideButton && ctx.hideButton(b));
        ui.onClick('BTN_OPEN', acts.open);        // kept as a fallback if the bar button shows
        ui.onClick('BTN_CLOSE', acts.close);
        ui.onClick('BTN_OEM', acts.oem);
        ui.onClick('BTN_PAGE', () => { const l = pages(); page = l[(l.indexOf(page) + 1) % l.length]; return render(); });
        ctx.onTab((i) => { const l = pages(); if (l[i]) page = l[i]; return render(); });
        // the tune is looked at again only when it changes (a theme change sends nothing)
        settings.onChange((key) => controller.refresh().then(() => key === 'tuner' && tune.refresh())
            .then(repaint).catch((e) => log.error('settings', e)));

        await controller.start();        // read-only: detect DME + read state, no actuation
        await tune.start(controller.link);   // nothing at all while "Tuning software" is Off
        // the diagnostic link often comes up after the app started (at boot): detect again then
        if (controller.link) controller.link.onAvailable(() => controller.refresh().then(() => tune.refresh())
            .then(repaint).catch((e) => log.error('link', e)));
        await render();
        log.info('exhaust_control ready (source=' + controller.source + ', adapter=' + controller.adapter.name + ')');
    },
});
