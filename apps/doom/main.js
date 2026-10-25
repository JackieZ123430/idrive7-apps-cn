'use strict';
/**
 * Doom - Freedoom: Phase 1 on the iDrive, for when you're parked.
 *
 * The game is doomgeneric (GPL-2, see LICENSE / NOTICE in this folder) compiled to WebAssembly
 * (doom.wasm, built by third_party/doomgeneric/build.sh) and run here at 35 tics a second
 * (doom-core.js). The engine draws the 3D view in full resolution (up to 1920 x 504, Doom's pixels
 * 1.2 tall: shown 1920 x 605) as its own picture; the status bar, menus and messages come in
 * Doom's 320 x 200 layer, see-through where the view is, drawn on top at 960 x 720 (4:3).
 * Pictures without a 3D view (intermission, automap, finale) are shown 4:3 alone.
 *
 * Screens:
 *   MAIN  the main menu, an HMI list: Play / Continue, New game, every setting.
 *   GAME  the game alone on the whole screen ("chrome": false: no header, no bar, no panels),
 *         as big as the display allows. BACK (the HMI's own) returns to the menu.
 *
 * Controls (controls.js): turn the controller to aim, push it to walk / sidestep, press to fire
 * and open doors, press twice for the next weapon.
 *
 * The game runs only while GAME is on screen and the car is parked; whenever it stops (BACK,
 * MENU, a popup or call, driving off, the app closing) it saves, and Play carries on from there.
 */
const path = require('path');
const mgu = require('./kit/mgu');
const { Recorder, setImage } = require('./kit/record');
const { Doom, GS } = require('./doom-core');
const { Controls } = require('./controls');

const W = 1600, H = 520, IMG = 1, VIEW = 2, SIDE = 3, SLOT = 0;
const DETAIL = { full: [1920, 504], medium: [1440, 378], low: [960, 252] };
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
        let started = false, err = null, frames = 0, saved = false;
        let hasView = false;
        game.onFrame = (px, w, h) => {
            setImage(IMG, w, h, px);
            const v = game.view();
            hasView = !!v;
            if (v) setImage(VIEW, v.w, v.h, v.px);
            if (!frames) sideStrip(game.flat());     // (the palette is there once a frame is drawn)
            frames++;
        };
        // render resolution of the 3D view (the "detail" setting)
        let detail = null;
        function applyDetail() {
            const d = DETAIL[settings.get('detail')] ? settings.get('detail') : 'full';
            if (d !== detail && started && !err) { detail = d; game.setRes(DETAIL[d][0], DETAIL[d][1]); log.info('render ' + DETAIL[d].join(' x ')); }
        }
        // game frames per second (Doom's own rate is 35) -> log every 10 s while playing
        let fpsF = 0, fpsT = Date.now();
        setInterval(() => {
            const now = Date.now();
            if (frames > fpsF && going) log.info('game ' + ((frames - fpsF) * 1000 / (now - fpsT)).toFixed(1) + ' fps');
            fpsF = frames; fpsT = now;
        }, 10000);
        game.onDead = (e) => { err = e; menu(); };
        try {
            game.start(); started = true;
            saved = game.load(SLOT);
            if (saved) log.info('saved game loaded');
            game.pause(true);                      // runs only on the game screen
            applyDetail();
        } catch (e) { err = e; log.error('doom start', e); }

        /* ---------- main menu ---------- */
        function menu() {
            const st = (started && !err && game.state()) || {};
            let info;
            if (err) info = 'Doom stopped: ' + (err.message || err);
            else if (moving()) info = 'Parked only - the game waits while you drive';
            else if (st.gamestate === GS.LEVEL && (saved || frames)) {
                const lvl = 'E' + Math.floor(st.level / 10) + 'M' + (st.level % 10);
                info = (saved ? 'Saved game: ' : 'Game: ') + lvl + ', health ' + st.health + ' %';
            } else info = 'In the game, BACK returns here and saves';
            ui.text('BTN_PLAY', saved ? 'Continue' : 'Play');
            ui.text('MENU_INFO', info);
        }
        ui.onClick('BTN_PLAY', () => ui.open('GAME'));
        ui.onClick('BTN_NEW', () => {
            if (!started || err) return;
            game.newGame(skill(), episode());
            log.info('new game: episode ' + episode() + ', ' + SKILLS[skill()]);
            ui.open('GAME');
        });
        menu();
        setInterval(() => { if (ui.isVisible('MAIN')) menu(); }, 2000);

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
        const BTNS = ['BTN_BACK', 'BTN_TL', 'BTN_WL', 'BTN_STAND', 'BTN_WALK', 'BTN_WR', 'BTN_TR', 'BTN_WEAPON'];
        BTNS.forEach((b) => {
            const c = ui.rhmi && ui.rhmi.getByName(b);
            if (c && c.on) c.on('focus', (ev) => { if (ev && typeof ev.value === 'boolean') ctl.barFocus(b, ev.value); });
            ui.onClick(b, () => ctl.barClick(b));
        });

        /* ---------- run while the game screen is up and the car is parked; save when it stops ---------- */
        const shown = () => ui.isVisible('GAME') && (!ui.hasFocus || ui.hasFocus('GAME'));
        let going = false;
        function sync() {
            const go = started && !err && !moving() && shown();
            if (go !== going) {
                going = go;
                if (!go) {
                    ctl.enable(false);
                    if (game.save(SLOT)) { saved = true; log.info('saved'); }
                    game.pause(true);
                    menu();
                } else { game.pause(false); ctl.enable(true); }
            }
            ctl.apply();
            applyDetail();
        }
        setInterval(sync, 200);
        if (ui.onFocus) ui.onFocus(() => sync());
        process.on('exit', () => { try { if (going) game.save(SLOT); } catch (e) { /* exiting */ } });

        /* ---------- drawing: the game alone on the whole screen ---------- */
        // the status bar is 4:3 (960 wide): beside it, Doom's border texture, 160 x 32 game pixels a side
        function sideStrip(flat) {
            if (!flat) return;
            const sw = 160, sh = 32, px = new Uint8Array(sw * sh * 4);
            for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
                const s = ((y & 63) * 64 + (x & 63)) * 4, d = (y * sw + x) * 4;
                px[d] = flat[s]; px[d + 1] = flat[s + 1]; px[d + 2] = flat[s + 2]; px[d + 3] = 255;
            }
            setImage(SIDE, sw, sh, px);
        }
        let sr = null;
        function render() {
            const cv = ctx.canvas(W, H).clear('#000000');
            const pl = cv.place;
            const stop = err ? 'Doom stopped' : moving() ? 'Parked only - the game waits while you drive' : !frames ? 'Loading...' : null;
            if (pl && pl.full) {
                // screen pixels: the whole display is ours (1920 x 720)
                if (!sr || sr.w !== pl.w || sr.h !== pl.h) sr = new Recorder(pl.w, pl.h);
                sr.reset();
                sr.fillRect(0, 0, pl.w, pl.h, '#000000');
                const gw = Math.round(pl.h * 4 / 3), gx = Math.round((pl.w - gw) / 2);
                const vh = Math.round(pl.h * 168 / 200);       // the 3D view: all but the status bar
                if (stop) sr.text(stop, pl.w / 2, pl.h / 2 + 10, 30, '#ffffff', { align: 'center', font: 'bold' });
                else if (hasView) {
                    sr.image(VIEW, 0, 0, pl.w, vh);
                    if (gx > 0) { sr.image(SIDE, 0, vh, gx, pl.h - vh); sr.image(SIDE, gx + gw, vh, pl.w - gx - gw, pl.h - vh); }
                    sr.image(IMG, gx, 0, gw, pl.h);
                } else sr.image(IMG, gx, 0, gw, pl.h);
                cv.xf(1, 0, 0).append(sr).xf();
            } else {
                // software / standard layout: the game in the app's image area
                const gw = Math.round(H * 4 / 3);
                if (stop) cv.text(stop, W / 2, H / 2, 28, '#ffffff', { align: 'center', font: 'bold' });
                else {
                    if (hasView) cv.image(VIEW, 0, 0, W, Math.round(H * 168 / 200));
                    cv.image(IMG, Math.round((W - gw) / 2), 0, gw, H);
                }
            }
            return ui.image('GAME_GFX', cv);
        }
        ctx.loop('GAME', 35, render);
        log.info('doom app started');
    },
});
