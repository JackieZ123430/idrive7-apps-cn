'use strict';
/**
 * Live Adjustments - native live tweaks for the BMW MGU (iDrive 7). Pages: Exhaust Flap, and on a
 * tuned DME (found by a read-only unlock check) Map (slot 1..4, MHD or BM3), Max cooling (MHD),
 * Burbles and Sound (Active Sound Design) (BM3).
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
        let angle = 0.18;
        let page = 0;
        let burble = 4;                       // the aggression picked on the Burbles page, sent on Apply

        // the three mode presses, each kicks a repaint (used by both the HMI bar and
        // the on-canvas buttons the kit draws when the app owns the screen)
        const press = (mode) => () =>
            Promise.resolve(controller.setMode(mode)).then(() => loop && (loop.kick ? loop.kick() : render())).catch((e) => log.error('action', e));
        const tune = (kind) => (value) =>
            Promise.resolve(controller.setTune(kind, value)).then(() => loop && (loop.kick ? loop.kick() : render())).catch((e) => log.error('action', e));
        const acts = { oem: press('OEM'), open: press('OPEN'), close: press('CLOSED'), map: tune('map'), cooling: tune('cooling'),
            burbles: tune('burbles'), asd: tune('asd'),
            burbleStep: (d) => { burble = Math.min(12, Math.max(0, burble + d)); if (loop.kick) loop.kick(); } };

        const render = async () => {
            const v = controller.view();
            const tgt = targetAngle(v);
            angle += (tgt - angle) * 0.25;            // simple ease per frame
            if (Math.abs(tgt - angle) < 0.003) angle = tgt;
            v.angle = angle;
            v.page = page;
            v.burble = burble;
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
        if (ctx.onTab) ctx.onTab((i) => { if (i >= 0 && i < UI.PAGES.length && i !== page) { page = i; if (loop.kick) loop.kick(); } });
        settings.onChange(() => controller.refresh().then(() => loop.kick && loop.kick()));

        await controller.start();        // read-only: detect DME + read state, no actuation
        await render();
        log.info('exhaust_control ready (source=' + controller.source + ', adapter=' + controller.adapter.name + ')');
    },
});
