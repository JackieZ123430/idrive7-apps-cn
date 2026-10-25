'use strict';
/**
 * Doom - Freedoom: Phase 1 on the iDrive, for when you're parked.
 *
 * The game is doomgeneric (GPL-2, see LICENSE in this folder) compiled to WebAssembly
 * (doom.wasm, built by doom-src/build.sh) and run here at 35 tics a second (doom-core.js).
 * Each frame (320 x 200) goes to the GPU renderer as a pixel image (kit setImage / OP_IMAGE).
 *
 * Controls (controls.js): turn the controller to aim, push it to walk / sidestep, press to fire
 * and open doors, press twice for the next weapon. No button bar on this screen: the game uses
 * the whole height. Settings: tap "Settings" at the bottom left of the touchscreen.
 *
 * The game pauses and saves itself while the car moves (over 3 km/h), when the screen is left or
 * covered (BACK, MENU, OPTION, a call) and when the app stops; it carries on from there.
 */
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Recorder, setImage } = require('./kit/record');
const { Doom, GS, PST } = require('./doom-core');
const { Controls } = require('./controls');

const W = 1600, H = 520, IMG = 1, SLOT = 0;
const MAX_KMH = 3;
const SKILLS = ['', 'Too young to die', 'Not too rough', 'Hurt me plenty', 'Ultra-Violence', 'Nightmare!'];

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;

        /* ---------- parked only ---------- */
        // only a real speed counts: the VM / a bench sends none or "invalid" (65535) -> playable.
        // A real speed that then goes quiet for 5 s counts as moving (safe side).
        let speed = null, validT = 0;
        ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusCarSpeed2: (v) => {
                const k = v && v.speedVehicleCentreOfGravity;
                if (typeof k === 'number' && k !== 65535) { speed = k * 0.015625; validT = Date.now(); }
            },
        }, log).then((s) => log.info('speed ' + (s.error ? 'error: ' + s.error : 'subscribed')));
        const moving = () => speed !== null && (Date.now() - validT > 5000 || speed > MAX_KMH);

        /* ---------- the game ---------- */
        const skill = () => Number(settings.get('skill')) || 3;
        const episode = () => Number(settings.get('episode')) || 1;
        const game = new Doom({
            wasm: path.join(__dirname, 'doom.wasm'), wadDir: __dirname, dataDir: ctx.dataDir, log,
            args: ['-skill', String(skill()), '-episode', String(episode()), '-mb', '16'],
        });
        let started = false, err = null, frames = 0, fps = 0, fpsT = Date.now(), fpsN = 0, note = '', noteT = 0;
        game.onFrame = (px, w, h) => {
            setImage(IMG, w, h, px);
            frames++; fpsN++;
            const now = Date.now();
            if (now - fpsT >= 1000) { fps = fpsN * 1000 / (now - fpsT); fpsN = 0; fpsT = now; }
        };
        game.onDead = (e) => { err = e; };
        const say = (s) => { note = s; noteT = Date.now(); log.info(s); };
        try {
            game.start(); started = true;
            if (game.load(SLOT)) say('Carrying on with the saved game');
        } catch (e) { err = e; log.error('doom start', e); }

        // difficulty / episode / "new game" in the settings start a new game
        settings.onChange((k, v) => {
            if (!started || err) return;
            if (k === 'skill' || k === 'episode') { game.newGame(skill(), episode()); say('New game: episode ' + episode() + ', ' + SKILLS[skill()]); }
            if (k === 'newgame' && v === 'new') { game.newGame(skill(), episode()); say('New game: episode ' + episode() + ', ' + SKILLS[skill()]); settings.set('newgame', 'continue'); }
        });

        /* ---------- controls ---------- */
        const ctl = new Controls(game, {
            log, run: () => settings.get('run') !== 'walk',
            aim: () => settings.get('aim'), reversed: () => settings.get('aimdir') === 'reversed',
        });
        ctx.signals.watch('de.bmw.infotainment.controlelements.FrontCCU', '1', {
            statusRotaryEncoderState: (v) => ctl.raw(v),
            // the buttons around the controller: only logged (the HMI uses them itself)
            statusPushButtonsState: (() => { let n = 0, last = ''; return (v) => { const s = JSON.stringify(v); if (s !== last && n++ < 20) log.info('buttons ' + s); last = s; }; })(),
        }, log).then((s) => log.info('controller ' + (s.error ? 'error: ' + s.error : 'subscribed')));
        const BTNS = ['BTN_OPTS', 'BTN_BACK', 'BTN_TL', 'BTN_WL', 'BTN_STAND', 'BTN_WALK', 'BTN_WR', 'BTN_TR', 'BTN_WEAPON'];
        BTNS.forEach((b) => {
            const c = ui.rhmi && ui.rhmi.getByName(b);
            if (c && c.on) c.on('focus', (ev) => { if (ev && typeof ev.value === 'boolean') ctl.barFocus(b, ev.value); });
            ui.onClick(b, () => { if (ctl.barClick(b) === 'settings') ui.open('SETTINGS'); });
        });

        /* ---------- run while shown and parked; save when it stops ---------- */
        const shown = () => ui.isVisible('MAIN') && (!ui.hasFocus || ui.hasFocus('MAIN'));
        let going = false;
        function sync() {
            const go = started && !err && !moving() && shown();
            if (go !== going) {
                going = go;
                if (!go) { ctl.enable(false); if (game.save(SLOT)) log.info('saved'); game.pause(true); }
                else { game.pause(false); ctl.enable(true); }
            }
            ctl.apply();
        }
        setInterval(sync, 200);
        if (ui.onFocus) ui.onFocus(() => sync());
        process.on('exit', () => { try { if (going) game.save(SLOT); } catch (e) { /* exiting */ } });

        /* ---------- drawing ---------- */
        function message() {
            if (err) return ['Doom stopped: ' + (err.message || err), true];
            if (moving()) return ['Parked only - the game waits while you drive', true];
            if (!frames) return ['Loading...', false];
            return null;
        }
        function lines(t) {
            const st = game.state() || {};
            const hp = st.health != null ? st.health : null;
            const lvl = st.level ? 'E' + Math.floor(st.level / 10) + 'M' + (st.level % 10) : '--';
            const where = st.gamestate === GS.LEVEL ? lvl : st.gamestate === GS.INTERMISSION ? 'Level done' : st.gamestate === GS.FINALE ? 'Episode done' : '--';
            return [
                ['Level', where],
                ['Health', hp == null ? '--' : st.playerstate === PST.DEAD ? 'Dead - press' : hp + ' %', hp != null && hp < 30 ? t.crit : t.text],
                ['Difficulty', SKILLS[skill()]],
                ['Game', !started || err ? 'Stopped' : moving() ? 'Parked only' : going ? 'Running' : 'Paused, saved', going ? '#2fd27a' : t.warn],
            ];
        }
        // controls panel: what each input does, the active one lit
        function controlsList() {
            const s = ctl.status();
            if (s.live) {
                return [
                    ['Turn', 'Aim', false],
                    ['Push up / down', 'Walk', s.push === 'N' || s.push === 'S'],
                    ['Push left / right', 'Sidestep', s.push === 'E' || s.push === 'W'],
                    ['Press', 'Fire / open', s.fire],
                    ['Press twice', 'Weapon', false],
                ];
            }
            const names = { BTN_OPTS: 'Settings', BTN_BACK: 'Back up', BTN_TL: 'Turn left', BTN_WL: 'Walk left', BTN_STAND: 'Stand', BTN_WALK: 'Walk', BTN_WR: 'Walk right', BTN_TR: 'Turn right', BTN_WEAPON: 'Weapon' };
            return BTNS.map((b) => [null, names[b], s.focused === b]);
        }

        // full-screen GPU layout: drawn in screen pixels, the game 4:3 over the whole height
        let sr = null;
        function drawFull(cv, t, pl) {
            const SW = pl.w, SH = pl.h, TOP = 80, LEFT = 84;
            if (!sr || sr.w !== SW) sr = new Recorder(SW, SH);
            sr.reset();
            const gh = SH - TOP, gw = Math.round(gh * 4 / 3), gx = LEFT + Math.round((SW - LEFT - gw) / 2);
            sr.fillRect(LEFT, TOP, SW - LEFT, gh, '#000000');
            if (frames) sr.image(IMG, gx, TOP, gw, gh);
            const m = message();
            if (m) {
                sr.fillRect(gx, TOP, gw, gh, [0, 0, 0, frames ? 170 : 255]);
                sr.text(m[0], gx + gw / 2, TOP + gh / 2 + 10, 28, m[1] ? t.warn : t.text, { align: 'center', font: 'bold' });
            } else if (note && Date.now() - noteT < 4000) {
                sr.fillRect(gx, TOP + gh - 56, gw, 56, [0, 0, 0, 160]);
                sr.text(note, gx + gw / 2, TOP + gh - 20, 24, t.text, { align: 'center', font: 'bold' });
            }
            // left: status, and the Settings tap target over the HMI's (hidden) first bar button
            const lx = LEFT + 16, lw = gx - LEFT - 32;
            let y = TOP + 52;
            sr.text('DOOM', lx, y, 34, t.accent, { font: 'bold', spacing: 4 });
            y += 56;
            lines(t).forEach(([a, b, c]) => {
                sr.text(a, lx, y, 20, t.dim);
                sr.text(String(b), lx, y + 34, 30, c || t.text, { font: 'bold' });
                y += 84;
            });
            const bx = 132, bw = Math.min(lw - (bx - lx), 300), by = 612, bh = 80;
            sr.strokeRoundRect(bx, by, bw, bh, 14, 2, G.withAlpha(t.text, 0.35));
            sr.text('Settings', bx + bw / 2, by + 36, 26, t.text, { align: 'center', font: 'bold' });
            sr.text(ctl.status().live ? 'tap here' : 'tap, or press here', bx + bw / 2, by + 64, 17, t.dim, { align: 'center' });
            // right: controls
            const rx = gx + gw + 24, rw = SW - rx - 16;
            y = TOP + 52;
            sr.text(ctl.status().live ? 'CONTROLLER' : 'CONTROLLER POSITION', rx, y, 20, t.dim, { font: 'bold', spacing: 2 });
            y += 26;
            const list = controlsList();
            const rowH = list.length > 6 ? 58 : 100;
            list.forEach(([a, b, on]) => {
                if (on) sr.roundRect(rx - 10, y, rw, rowH - 8, 10, G.withAlpha(t.accent, 0.35));
                if (a) { sr.text(a, rx, y + 30, 19, t.dim); sr.text(b, rx, y + 66, 28, t.text, { font: 'bold' }); }
                else sr.text(b, rx, y + rowH / 2 + 6, 24, on ? t.text : t.dim, { font: on ? 'bold' : undefined });
                y += rowH;
            });
            cv.xf(1, 0, 0).append(sr).xf();
        }
        // standard layout / software: the game 4:3 in the app's image area
        function drawPlain(cv, t) {
            const TOPY = G.TOP, GH = G.BOTTOM - G.TOP, GW = Math.round(GH * 4 / 3), GX = Math.round((W - GW) / 2);
            if (frames) cv.image(IMG, GX, TOPY, GW, GH);
            const m = message();
            if (m) {
                cv.fillRect(GX, TOPY, GW, GH, [0, 0, 0, frames ? 170 : 255]);
                cv.text(m[0], GX + GW / 2, TOPY + GH / 2 + 10, 28, m[1] ? t.warn : t.text, { align: 'center', font: 'bold' });
            }
            let y = TOPY + 40;
            lines(t).forEach(([a, b, c]) => { cv.text(a, 40, y, 20, t.dim); cv.text(String(b), 40, y + 32, 28, c || t.text, { font: 'bold' }); y += 80; });
        }
        function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear('#000000');
            if (cv.place && cv.place.full) drawFull(cv, t, cv.place); else drawPlain(cv, t);
            G.frame(cv, t, [], 0, []);
            return ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 35, render);
        log.info('doom app started');
    },
});
