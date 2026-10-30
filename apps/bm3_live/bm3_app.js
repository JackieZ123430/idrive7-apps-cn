'use strict';
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { Diag } = require('./kit/diag');
const { Bm3Protocol } = require('./protocol');
const profiles = require('./profiles');

const W = 1600, H = 520;
const MENU = ['Maps', 'Exhaust valve', 'Active Sound Design', 'Burbles'];
const ACTIONS = [
    ['Map 1', 'Map 2', 'Map 3', 'Map 4'],
    ['Open', 'Close', 'Auto', ''],
    ['ASD on', 'ASD off', '', ''],
    ['-0.5', '+0.5', 'Apply', 'Off'],
];

mgu.run({
    async start(ctx) {
        const { ui, log } = ctx;
        const preview = typeof ctx.signals.hasNative !== 'function' || !ctx.signals.hasNative();
        const diag = await new Diag(ctx.signals, log).init();
        diag.quiet = true;
        const protocol = new Bm3Protocol(diag, profiles, ctx.spec.config || {});
        let page = 0, map = null;
        let busy = false, lastValve = null, lastAsd = null, burbles = null, targetAgg = 1.5;
        let note = preview ? 'Local preview. No car commands are sent.' : 'Checking DME and BM3 ROM';
        let noteType = 'dim', version = 0, drawn = -1, loop;
        const changed = () => { version++; if (loop) loop.kick(); };

        async function connect() {
            if (preview || busy || !diag.available) return;
            busy = true; note = 'Verifying DME and BM3 CustomROM'; noteType = 'dim'; changed();
            try {
                await protocol.identify();
                map = await protocol.currentMap();
                try {
                    const state = await protocol.readBurbles();
                    const decoded = state.aggression;
                    burbles = !state.enabled ? 'off' : decoded === null ? 'custom' : decoded.toFixed(1);
                    if (state.enabled && decoded !== null && decoded <= 12) targetAgg = decoded;
                } catch (e) { burbles = null; log.warn('BM3 burble readback: ' + String(e.message || e)); }
                note = 'BM3 ROM ' + protocol.rom + ' / DME connected';
                noteType = 'go';
            } catch (e) {
                note = 'BM3 ROM read: ' + String(e.message || e);
                noteType = 'warn';
                log.warn('BM3 identification: ' + note);
            } finally { busy = false; changed(); }
        }
        diag.on('available', (on) => { if (on) connect(); else { protocol.profile = null; protocol.rom = null; burbles = null; note = 'Diagnostic link unavailable'; noteType = 'warn'; changed(); } });
        setTimeout(connect, 600);

        async function perform(index) {
            if (busy) return;
            if (!ACTIONS[page][index]) return;
            if (page === 3 && index < 2) {
                targetAgg = Math.max(0, Math.min(12, targetAgg + (index === 0 ? -0.5 : 0.5)));
                note = 'Burble aggression set to ' + targetAgg.toFixed(1) + '; press Apply to send';
                noteType = 'dim'; changed(); return;
            }
            if (preview) { note = 'Preview only. No command sent.'; noteType = 'dim'; changed(); return; }
            busy = true;
            const label = ACTIONS[page][index];
            note = 'Sending ' + label + '...'; noteType = 'dim'; changed();
            try {
                if (page === 0) {
                    if (!protocol.profile) await protocol.identify();
                    map = await protocol.setMap(index);
                    note = 'Map ' + (map + 1) + ' confirmed by DME readback';
                } else if (page === 1) {
                    const mode = ['open', 'close', 'auto'][index];
                    await protocol.setFlap(mode);
                    lastValve = mode;
                    note = 'Valve ' + mode + ': DME accepted command; position not measured';
                } else if (page === 2) {
                    lastAsd = await protocol.setAsd(index === 0);
                    note = 'ASD ' + (lastAsd ? 'on' : 'off') + ': DME accepted command; state not measured';
                } else if (page === 3) {
                    if (!protocol.profile) await protocol.identify();
                    const value = await protocol.setBurbles(index === 3 ? null : targetAgg);
                    burbles = value === null ? 'off' : value.toFixed(1);
                    note = 'Burbles ' + burbles + ' confirmed by DME readback';
                }
                noteType = 'go';
            } catch (e) {
                note = String(e.message || e);
                noteType = 'warn';
                log.warn('BM3 action ' + label + ': ' + note);
            } finally { busy = false; changed(); }
        }

        function select(next) {
            page = next; drawn = -1;
            const labels = ACTIONS[page];
            ['BTN_A', 'BTN_B', 'BTN_C', 'BTN_D'].forEach((id, i) => {
                ui.text(id, labels[i] || ' ');
                ui.enabled(id, !!labels[i]);
            });
            changed();
        }
        ui.onClick('BTN_PAGE', () => select((page + 1) % MENU.length));
        ui.onClick('BTN_PREV', () => select((page + MENU.length - 1) % MENU.length));
        ['BTN_A', 'BTN_B', 'BTN_C', 'BTN_D'].forEach((id, i) => ui.onClick(id, () => perform(i)));

        function card(cv, t, x, y, w, h, title, subtitle, active) {
            G.panel(cv, t, x, y, w, h, title);
            if (active) cv.roundRect(x + 18, y + h - 18, w - 36, 6, 3, t.accent);
            cv.text(subtitle, x + 20, y + 91, 22, active ? t.text : t.dim, { font: 'label' });
        }

        function content(cv, t) {
            const x = 24;
            cv.text(MENU[page], x, 89, 40, t.text, { font: 'bold' });
            if (page === 0) {
                cv.text('CustomROM ' + (protocol.rom || '--') + '   |   Current map ' + (map == null ? '--' : map + 1), x, 119, 23, t.dim);
                for (let i = 0; i < 4; i++) {
                    const xx = x + (i % 2) * 790, yy = 144 + Math.floor(i / 2) * 140;
                    card(cv, t, xx, yy, 762, 122, 'Map ' + (i + 1), map === i ? 'Active - DME readback' : 'Select with the button below', map === i);
                }
            } else if (page === 1) {
                cv.text('Open, close, or return control to the DME', x, 119, 23, t.dim);
                const names = ['Open', 'Close', 'Auto'];
                names.forEach((name, i) => card(cv, t, x + i * 528, 165, 500, 208, name,
                    'Last accepted: ' + (lastValve || 'none'), lastValve === name.toLowerCase()));
                cv.text('Command accepted does not confirm the physical valve position.', x, 410, 22, t.dim);
            } else if (page === 2) {
                cv.text('Choose the interior engine-sound mode', x, 119, 23, t.dim);
                card(cv, t, x, 165, 762, 208, 'ASD on', 'Last accepted: ' + (lastAsd === null ? 'none' : lastAsd ? 'on' : 'off'), lastAsd === true);
                card(cv, t, x + 790, 165, 762, 208, 'ASD off', 'Last accepted: ' + (lastAsd === null ? 'none' : lastAsd ? 'on' : 'off'), lastAsd === false);
                cv.text('The captured commands do not report the current ASD state.', x, 410, 22, t.dim);
            } else {
                cv.text('Live Adjust aggression: 0.0 to 12.0 in 0.5 steps', x, 119, 23, t.dim);
                card(cv, t, x, 165, 762, 208, 'Current DME state',
                    burbles === null ? 'Unknown' : burbles === 'off' ? 'Override off' : burbles === 'custom' ? 'Custom value' : burbles, false);
                card(cv, t, x + 790, 165, 762, 208, 'Selected aggression', targetAgg.toFixed(1), false);
                cv.text('Use -/+ to choose, Apply to enable, Off to disable. Duration is not changed.', x, 410, 22, t.dim);
            }
            cv.roundRect(x, 447, 1552, 55, 8, withAlpha(noteType === 'warn' ? t.warn : noteType === 'go' ? (t.go || '#2fd27a') : '#FFFFFF', 0.13));
            cv.text(note, x + 19, 483, 22, noteType === 'warn' ? t.warn : noteType === 'go' ? (t.go || '#2fd27a') : t.text, { font: 'label' });
        }

        async function render(force) {
            if (!force && drawn === version) return;
            drawn = version;
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            content(cv, t);
            G.frame(cv, t, ['Maps', 'Valve', 'ASD', 'Burbles'], page,
                [{ text: 'EXPERIMENTAL', color: t.warn }, preview && { text: 'PREVIEW' }]);
            await ui.image('MAIN_GFX', cv);
        }
        select(0);
        loop = ctx.loop('MAIN', 5, () => render(false));
        await render(true);
    },
});
