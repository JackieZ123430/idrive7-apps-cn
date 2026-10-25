'use strict';
/**
 * display.js - where an app's drawn screen goes.
 *
 * Apps draw each frame on ctx.canvas(W, H) (a record.js Recorder) and hand it to
 * ui.image(name, canvas). Then:
 *
 *   GPU path (mgu-renderd running): the recording goes to the renderer, which draws it on
 *   its own surface right over the app's area of the HMI screen, at display rate. ctx.loop
 *   is then paced by the renderer (one frame per screen refresh, up to 60 fps). The
 *   HMI's own image component only gets a plain background once.
 *
 *   Software path (no renderer): the recording is played into a canvas.js Canvas and handed
 *   to the HMI as a PNG, as before (a few frames per second).
 *
 * Layout (setting "layout"):
 *   full      (default) the renderer's surface covers the whole screen right of the HMI's back
 *             arrow. Up top, in the HMI's title strip, a compact header with the app's name and
 *             its page tabs (G.frame); right of it the strip is see-through, so the HMI's own
 *             status (radio station, phone signal, clock, mic, profile) shows. At the bottom a slim 48 px button bar drawn by the kit in
 *             place of the HMI's 120 px one: each label sits over the HMI button under it, so
 *             taps and controller presses land on the right one, and the HMI's focus events
 *             (Focusable=3 bar buttons) light up the button the iDrive controller is on. The
 *             page content is scaled up into everything in between.
 *   standard  the HMI's own title and bar; the renderer covers only the app's image area.
 */
const { Recorder, play } = require('./record');
const { Canvas } = require('./canvas');
const { RenderClient } = require('./renderd');
const G = require('./gauges');

/* HMI geometry on the 1920 x 720 centre display (measured on the unit's HMI) */
const HMI = {
    screen: { w: 1920, h: 720 },
    img: { x: 124, y: 82, w: 1600, h: 520 },   // canvas screen's image component
    // bar buttons: from x 132, each as wide as its label + 180 px. The label's width in the HMI
    // font = our 'label' font at 40 px x 1.465 (measured: "Next page" 412, "Previous page" 507,
    // "Settings" 370 px wide)
    btn: { x: 132, pad: 180, size: 40, k: 1.465 },
    left: 84,                                   // the HMI's back arrow column (x 0..84): kept see-through
    barTop: 596,                                // top of the HMI's own button bar (its 2 px edge line; body from 600)
    headBg: '#000000',                          // the HMI's title / status strip
    status: { x: 1340, h: 76 },                 // status icons top right (notifications .. clock)
};
/* full-screen layout, in the surface's pixels (it covers the whole screen) */
const FULL = {
    headH: 80,                                  // header in the HMI's title strip
    barH: 48,                                   // slim button bar
    // part of the app's 1600 x 520 drawing shown: the tab bar (y < 38) moves to the header and
    // the side margins are trimmed a little, so the content can be scaled up further
    src: { x: 12, y: 38, w: 1576, h: 482 },
};
const LAYOUTS = ['full', 'standard'];

class Display {
    constructor(ui, log, spec, settings, themeFn) {
        this.ui = ui; this.log = log; this.spec = spec; this.settings = settings; this.theme = themeFn;
        this.gpu = null;
        this.state = null;                 // canvas screen shown by the renderer (first canvas screen)
        this.recorders = new Map();
        this.lastWords = null; this.lastSent = 0;
        this.pressed = null; this.pressedT = 0;   // last pressed bar button (flash)
        this.focused = null;                         // bar button the iDrive controller is on
        this.labels = {};                            // bar labels the app changed (ui.text)
        this.barOff = 0;                             // how far the HMI has scrolled its bar left
        this.tickHandlers = [];
        this.bgShown = null;
        this.place = null;
        this.frames = 0; this.jsMs = 0; this.statT = Date.now();
        const canvasScreens = (spec.screens || []).filter((s) => s.kind === 'canvas');
        this.screen = canvasScreens[0] || null;
        if (!this.screen) return;
        this.ui.onVisible((name, v) => {
            if (name !== this.screen.name) return;
            if (v) this.barOff = 0;                   // the HMI builds the screen afresh
            this._syncVisible();
        });
        if (this.ui.onFocus) this.ui.onFocus((name) => { if (name === this.screen.name) { this._syncVisible(); this._lost(); } });
        settings.onChange((k) => {
            if (k === 'layout') { this._place(); this.lastWords = null; }
            if (k === 'theme') this.bgShown = null;
            if (k === 'renderer') this._mode();
        });
        this._mode();
        // slim bar: light the button the controller is on (HMI focus events) and flash on press
        (this.screen.buttons || []).forEach((b) => {
            const c = ui.rhmi && ui.rhmi.getByName(b[0]);
            if (!c || !c.on) return;
            // the bar is redrawn here at once: apps that draw only when their data changes
            // (Fault Scanner) would otherwise leave the highlight behind
            // the controller is on this screen's buttons, so no popup covers it: if the HMI never said
            // "focus back" after a popup (seen after an update + HMI restart: only the bar showed until
            // Settings and back), take this as the screen having focus again
            const inFront = () => { if (this.ui._setFocus) this.ui._setFocus(this.screen.name, true); };
            c.on('action', () => {
                inFront();
                this.pressed = b[0]; this.pressedT = Date.now(); this._repaint();
                setTimeout(() => this._repaint(), 320);              // end of the press flash
            });
            c.on('focus', (ev) => {
                if (!ev || typeof ev.value !== 'boolean') return;          // (row-only events)
                if (ev.value) { inFront(); this.focused = b[0]; this._scroll(); } else if (this.focused === b[0]) this.focused = null;
                this._repaint();
            });
        });
    }

    /** Start / stop the GPU path for the 'renderer' setting; wait for the socket if it isn't there yet. */
    _mode() {
        const want = (process.env.MGU_RENDERER || this.settings.get('renderer') || 'auto') !== 'software';
        if (this.poll) { clearInterval(this.poll); this.poll = null; }
        if (!want) {
            if (this.gpu) { this.gpu.show(false); this.gpu.close(); this.gpu = null; this.place = null; this._lost(); }
            this.log.info('display: software rendering (setting)');
            return;
        }
        if (this.gpu) return;
        const file = process.env.MGU_RENDERD_FILE;       // testing: write the stream for mgu-renderd --replay
        if (file || RenderClient.available()) { this._startGpu(file); return; }
        this.log.info('display: no mgu-renderd socket - software rendering until it appears');
        this.poll = setInterval(() => {
            if (RenderClient.available()) { clearInterval(this.poll); this.poll = null; this._startGpu(); }
        }, 5000);
    }

    _startGpu(file) {
        const gpu = this.gpu = new RenderClient(this.spec.id, this.log, file ? { file } : undefined);
        gpu.on('ready', () => { if (this.gpu !== gpu) return; this._place(); this._syncVisible(); });
        gpu.on('tick', () => { if (this.gpu === gpu) this.tickHandlers.forEach((fn) => fn()); });
        gpu.on('close', () => { if (this.gpu === gpu) this._lost(); });
        gpu.on('stats', (s) => { this.gpuStats = s; });
        gpu.on('ccu', (v) => { if (this.gpu === gpu && this.onCcu) this.onCcu(v); });
        G.onLayerDrop((id) => { if (this.gpu) this.gpu.dropLayer(id); });
        gpu.connect();
        if (this.grabbing) gpu.grab(true);
    }

    /** the iDrive controller to this app alone while on (GPU renderer + mgu-inputgate.so needed) */
    grab(on) {
        this.grabbing = !!on;
        if (this.gpu) this.gpu.grab(this.grabbing);
    }

    /** GPU path gone (or off): the HMI's own image shows again - push a frame now. */
    _lost() {
        this.lastWords = null; this.bgShown = null;
        this.ui._invalidate && this.ui._invalidate();
        // the HMI's image still shows the plain background: draw the last frame there at once
        // (apps that draw only on changes would otherwise leave it blank)
        const L = this.last;
        if (L && !this.active() && this.ui.isVisible(this.screen.name)) {
            const cv = new Canvas(L.w, L.h);
            play(L.frame.words(), cv);
            Promise.resolve(L.softImage(L.name, cv)).catch(() => {});
        }
        this.tickHandlers.forEach((fn) => fn());
    }

    layout() {
        const v = this.settings.get('layout') || 'full';
        return LAYOUTS.indexOf(v) >= 0 ? v : 'full';
    }

    /** Renderer placement for the current layout. */
    _place() {
        if (!this.gpu || !this.gpu.ready) return;
        const scr = this.gpu.screen, v = this.layout();
        let pl;
        if (v === 'standard' || scr.w !== HMI.screen.w || scr.h !== HMI.screen.h) {
            pl = { x: HMI.img.x, y: HMI.img.y, w: HMI.img.w, h: HMI.img.h, scale: 1, ox: 0, oy: 0, full: false };
        } else {
            // the surface covers the whole screen, so the HMI's own bar can't show under the back
            // arrow column; the page content goes right of that column
            const w = scr.w - HMI.left, h = scr.h, src = FULL.src;
            const ah = h - this.headH() - this.barH();
            const s = Math.floor(Math.min(w / src.w, ah / src.h) * 1000) / 1000;
            pl = {
                x: 0, y: 0, w: scr.w, h, full: true,
                scale: s,
                ox: HMI.left + Math.round((w - src.w * s) / 2 - src.x * s),
                oy: Math.round(this.headH() + (ah - src.h * s) / 2 - src.y * s),
            };
        }
        this.place = pl;
        this.gpu.place(pl);
        this.recorders.clear();             // text sizes depend on the scale
        this.app = null; this.outRec = null;
        this.log.info('display: renderer placement ' + JSON.stringify(pl) + ' (layout ' + v + ')');
    }

    /** the screen is up and not covered by an HMI popup */
    _shown() { return this.ui.isVisible(this.screen.name) && (!this.ui.hasFocus || this.ui.hasFocus(this.screen.name)); }

    _syncVisible() {
        if (!this.gpu) return;
        const on = this._shown();
        this.gpu.show(on);
        if (on) this.lastWords = null;
    }

    /** GPU path usable for this screen right now? */
    active(stateName) {
        return !!(this.gpu && this.gpu.ready && this.place && (!stateName || stateName === this.screen.name) && this._shown());
    }

    /** The surface to draw a frame on (reused). */
    canvas(w, h) {
        const scale = this.active() ? this.place.scale : 1;
        const key = w + 'x' + h + '@' + scale;
        let r = this.recorders.get(key);
        if (!r) { r = new Recorder(w, h, { textScale: scale }); this.recorders.set(key, r); }
        r.reset();
        // full-screen layout: G.frame hands its tabs to the header instead of drawing them
        r.chrome = this.active() && this.place.full && this.screen.chrome !== false ? { tabs: null } : null;
        // where the frame lands on screen (apps that draw some parts in screen pixels, r.xf)
        r.place = this.active() ? this.place : null;
        return r;
    }

    /**
     * Show a frame. r: Recorder (or a canvas.js Canvas / PNG buffer from old code).
     * Returns a promise like ui.image.
     */
    present(name, r, softImage) {
        if (!(r instanceof Recorder)) return softImage(name, r);
        if (this.active()) {
            let out = r;
            if (this.place.full && r.chrome) {
                // keep the app's own part: the display redraws the header and bar over it by itself
                this.app = {
                    name, softImage, w: r.w, h: r.h, textScale: r.textScale, words: new Uint32Array(r.words()),
                    atlases: new Set(r.atlases), ramps: new Set(r.ramps), layersUsed: new Set(r.layersUsed || []), images: new Set(r.images || []), tabs: r.chrome.tabs,
                };
                out = this._compose();
            } else this.app = null;
            this._send(name, out, softImage, false);
            // the HMI's own image under the renderer's surface: a plain background, once
            const t = this.theme();
            if (this.bgShown !== t.bg) {
                this.bgShown = t.bg;
                return softImage(name, new Canvas(r.w, r.h).clear(t.bg));
            }
            return Promise.resolve();
        }
        this.app = null;
        this._keep(name, r, softImage);
        const cv = new Canvas(r.w, r.h);
        play(r.words(), cv);
        return softImage(name, cv);
    }

    /** Send a frame to the renderer (skipped when identical to the last one, within a second). */
    _send(name, out, softImage, force) {
        const w = out.words();
        // unchanged frame (parked car, steady values): nothing to send - but at least one a
        // second, the renderer hides an app that goes quiet for 3 s (hung app over the HMI)
        const now = Date.now();
        if (!force && this.lastWords && now - this.lastSent < 1000 && this.lastWords.length === w.length && Buffer.from(w.buffer, w.byteOffset, w.byteLength).equals(this.lastWords)) return;
        this.lastSent = now;
        this.gpu.frame(out);
        this.lastWords = Buffer.from(Buffer.from(w.buffer, w.byteOffset, w.byteLength));
        this._keep(name, out, softImage);
        this._stats();
    }

    /** The app's last frame with the current header and bar. */
    _compose() {
        const a = this.app;
        const o = this.outRec && this.outRec.w === a.w && this.outRec.h === a.h ? this.outRec : (this.outRec = new Recorder(a.w, a.h, { textScale: a.textScale }));
        o.reset();
        o._grow(a.words.length); o.u.set(a.words, 0); o.n = a.words.length;
        a.atlases.forEach((x) => o.atlases.add(x)); a.ramps.forEach((x) => o.ramps.add(x));
        if (a.images) a.images.forEach((x) => o.images.add(x));
        if (a.layersUsed.size) { o.layersUsed = o.layersUsed || new Set(); a.layersUsed.forEach((x) => o.layersUsed.add(x)); }
        o.chrome = { tabs: a.tabs };
        this._drawChrome(o);
        return o;
    }

    /** Header / bar changed (focus, press): show it now, without waiting for the app's next frame. */
    _repaint() {
        this.lastWords = null;
        if (!this.app || !this.active() || !this.place.full) return;
        try { this._send(this.app.name, this._compose(), this.app.softImage, true); } catch (e) { this.log.warn('display: repaint ' + e); }
    }

    /** Remember the last frame: resent as keepalive, or drawn in software when the GPU goes. */
    _keep(name, r, softImage) {
        const words = new Uint32Array(r.words());
        this.last = {
            name, softImage, w: r.w, h: r.h,
            frame: { words: () => words, atlases: new Set(r.atlases), ramps: new Set(r.ramps), layersUsed: new Set(r.layersUsed || []), images: new Set(r.images || []) },
        };
        if (!this.keepTimer) {
            this.keepTimer = setInterval(() => {
                // apps that draw only on changes still send a frame every second (renderer watchdog)
                if (this.last && this.active() && Date.now() - this.lastSent >= 1000) { this.lastSent = Date.now(); this.gpu.frame(this.last.frame); }
            }, 500);
            if (this.keepTimer.unref) this.keepTimer.unref();
        }
    }

    _stats() {
        this.frames++;
        const now = Date.now();
        if (now - this.statT >= 10000) {
            const g = this.gpuStats;
            this.log.info('display: ' + Math.round(this.frames * 1000 / (now - this.statT)) + ' fps sent' +
                (g ? ', renderer ' + g.fps + ' fps, ' + (g.avgUs / 1000).toFixed(2) + ' ms per frame (max ' + (g.maxUs / 1000).toFixed(1) + ')' : ''));
            this.frames = 0; this.statT = now;
        }
    }

    /**
     * Full-screen layout: header, slim bar and the see-through status corner, appended to the
     * frame in the surface's own pixels (xf). Software playback skips this part.
     */
    _drawChrome(r) {
        const pl = this.place, t = this.theme(), W = pl.w, H = pl.h;
        const c = this.chromeRec || (this.chromeRec = new Recorder(W, H));
        c.reset();
        const tb = r.chrome.tabs || { tabs: [], sel: -1, badges: [] };
        // compact header in the HMI strip's own black, only as wide as its name, tabs and badges:
        // right of it the HMI's strip shows through (radio station, phone signal, status icons)
        const hx = HMI.left - pl.x;
        const end = G.header(c, Object.assign({}, t, { bg: HMI.headBg }), hx, 0, HMI.status.x - pl.x - hx, FULL.headH,
            this.screen.title || this.spec.title, tb.tabs, tb.sel, tb.badges, true, true);
        const sx = Math.min(HMI.status.x - pl.x, Math.ceil(end));
        // the strip's bottom edge continues under the see-through part
        c.fillRect(sx, 0, W - sx, FULL.headH, HMI.headBg);
        c.fillRect(sx, FULL.headH - 2, W - sx, 2, G.withAlpha('#ffffff', 0.22));
        // slim bar: each label over its HMI button
        const by = H - this.barH();
        const btns = this.buttons().map((b) => ({ id: b.id, label: b.label, x: b.x - this.barOff - pl.x, w: b.w }));
        const flash = this.pressed && Date.now() - this.pressedT < 300 ? btns.findIndex((b) => b.id === this.pressed) : -1;
        const focus = btns.findIndex((b) => b.id === this.focused);
        if (btns.length && this.barH()) G.menuBar(c, t, 0, by, W, FULL.barH, btns, focus, 'slim', flash);
        // the HMI's status icons and its back arrow column (home button, back arrow) show through;
        // the column under them is covered, so the HMI's own bar doesn't show at the bottom left
        c.clip(sx, 0, W - sx, HMI.status.h).clear(0).noclip();
        if (hx > 0) c.clip(0, 0, hx, HMI.barTop - pl.y).clear(0).noclip();
        r.xf(1, 0, 0).append(c).xf();
    }

    /** A bar button's text changed (ui.text): its width, and so the bar's layout, follow. */
    label(id, text) {
        if (!(this.screen && (this.screen.buttons || []).some((b) => b[0] === id))) return;
        if (this.labels[id] === String(text)) return;
        this.labels[id] = String(text);
        this._btns = null;
        this._scroll();
        this._repaint();
    }

    /**
     * Wider than the screen, the HMI scrolls its bar as little as needed to show the focused
     * button whole between x 132 and the screen's right edge (measured), and keeps that offset
     * until focus leaves the visible part again. The slim bar copies it, so each label stays over
     * the HMI button a tap lands on.
     */
    _scroll() {
        const f = this.buttons().find((b) => b.id === this.focused);
        if (!f) return;
        const right = HMI.screen.w;
        if (f.x + f.w - this.barOff > right) this.barOff = f.x + f.w - right;
        if (f.x - this.barOff < HMI.btn.x) this.barOff = f.x - HMI.btn.x;
        if (this.barOff < 0) this.barOff = 0;
    }

    /**
     * Height of the kit's slim bar: 0 for a screen with "bar": false in app.json (a game: its
     * bar buttons still exist in the HMI under the surface, for focus and taps, but aren't drawn).
     */
    barH() { return this.screen && (this.screen.bar === false || this.screen.chrome === false) ? 0 : FULL.barH; }
    /** Header height: 0 for "chrome": false (the app draws the whole screen itself, e.g. a game). */
    headH() { return this.screen && this.screen.chrome === false ? 0 : FULL.headH; }

    /** The HMI's bar buttons in screen pixels, unscrolled: [{ id, label, x, w }]. */
    buttons() {
        if (this._btns) return this._btns;
        const m = new Recorder(1, 1);
        let x = HMI.btn.x;
        this._btns = (this.screen.buttons || []).map((b) => {
            const label = this.labels[b[0]] != null ? this.labels[b[0]] : String(b[1] || b[0]);
            const w = Math.round(m.textWidth(label.replace(/[^\x20-\x7e]/g, ''), HMI.btn.size, { font: 'label' }) * HMI.btn.k) + HMI.btn.pad;
            const r = { id: b[0], label, x, w };
            x += w;
            return r;
        });
        return this._btns;
    }

    onTick(fn) { this.tickHandlers.push(fn); }
}

module.exports = { Display, HMI, FULL };
