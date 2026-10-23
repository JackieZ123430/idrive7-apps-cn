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
 *             arrow. Up top, in the HMI's title strip, a header with the app's name and its
 *             page tabs (G.frame); the HMI's status icons (clock, mic, profile) show through a
 *             see-through corner. At the bottom a slim 48 px button bar drawn by the kit in
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
    left: 84,                                   // keep the HMI's back arrow column (x 0..84) visible
    status: { x: 1340, h: 76 },                 // status icons top right (notifications .. clock)
};
/* full-screen layout, in the surface's pixels (it starts at HMI.left) */
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
        this.tickHandlers = [];
        this.bgShown = null;
        this.place = null;
        this.frames = 0; this.jsMs = 0; this.statT = Date.now();
        const canvasScreens = (spec.screens || []).filter((s) => s.kind === 'canvas');
        this.screen = canvasScreens[0] || null;
        if (!this.screen) return;
        this.ui.onVisible((name) => { if (name === this.screen.name) this._syncVisible(); });
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
            c.on('action', () => { this.pressed = b[0]; this.pressedT = Date.now(); this.lastWords = null; });
            c.on('focus', (ev) => {
                if (!ev || typeof ev.value !== 'boolean') return;          // (row-only events)
                if (ev.value) this.focused = b[0]; else if (this.focused === b[0]) this.focused = null;
                this.lastWords = null;
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
        G.onLayerDrop((id) => { if (this.gpu) this.gpu.dropLayer(id); });
        gpu.connect();
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
            const w = scr.w - HMI.left, h = scr.h, src = FULL.src;
            const ah = h - FULL.headH - FULL.barH;
            const s = Math.floor(Math.min(w / src.w, ah / src.h) * 1000) / 1000;
            pl = {
                x: HMI.left, y: 0, w, h, full: true,
                scale: s,
                ox: Math.round((w - src.w * s) / 2 - src.x * s),
                oy: Math.round(FULL.headH + (ah - src.h * s) / 2 - src.y * s),
            };
        }
        this.place = pl;
        this.gpu.place(pl);
        this.recorders.clear();             // text sizes depend on the scale
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
        r.chrome = this.active() && this.place.full ? { tabs: null } : null;
        return r;
    }

    /**
     * Show a frame. r: Recorder (or a canvas.js Canvas / PNG buffer from old code).
     * Returns a promise like ui.image.
     */
    present(name, r, softImage) {
        if (!(r instanceof Recorder)) return softImage(name, r);
        if (this.active()) {
            if (this.place.full && r.chrome) this._drawChrome(r);
            const w = r.words();
            // unchanged frame (parked car, steady values): nothing to send - but at least one a
            // second, the renderer hides an app that goes quiet for 3 s (hung app over the HMI)
            const now = Date.now();
            if (this.lastWords && now - this.lastSent < 1000 && this.lastWords.length === w.length && Buffer.from(w.buffer, w.byteOffset, w.byteLength).equals(this.lastWords)) return Promise.resolve();
            this.lastSent = now;
            this.gpu.frame(r);
            this.lastWords = Buffer.from(Buffer.from(w.buffer, w.byteOffset, w.byteLength));
            this._keep(name, r, softImage);
            this._stats();
            // the HMI's own image under the renderer's surface: a plain background, once
            const t = this.theme();
            if (this.bgShown !== t.bg) {
                this.bgShown = t.bg;
                return softImage(name, new Canvas(r.w, r.h).clear(t.bg));
            }
            return Promise.resolve();
        }
        this._keep(name, r, softImage);
        const cv = new Canvas(r.w, r.h);
        play(r.words(), cv);
        return softImage(name, cv);
    }

    /** Remember the last frame: resent as keepalive, or drawn in software when the GPU goes. */
    _keep(name, r, softImage) {
        const words = new Uint32Array(r.words());
        this.last = {
            name, softImage, w: r.w, h: r.h,
            frame: { words: () => words, atlases: new Set(r.atlases), ramps: new Set(r.ramps), layersUsed: new Set(r.layersUsed || []) },
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
        const sx = HMI.status.x - pl.x;                       // status icons start here
        // header across the top; the strip under the status icons gets its bottom edge too
        c.fillRect(sx, 0, W - sx, FULL.headH, t.bg);
        c.fillRect(sx, FULL.headH - 2, W - sx, 2, G.withAlpha('#ffffff', 0.22));
        G.header(c, t, 0, 0, sx, FULL.headH, this.screen.title || this.spec.title, tb.tabs, tb.sel, tb.badges);
        // slim bar: each label over its HMI button
        const by = H - FULL.barH;
        const btns = this.buttons().map((b) => ({ id: b.id, label: b.label, x: b.x - pl.x, w: b.w }));
        const flash = this.pressed && Date.now() - this.pressedT < 300 ? btns.findIndex((b) => b.id === this.pressed) : -1;
        const focus = btns.findIndex((b) => b.id === this.focused);
        if (btns.length) G.menuBar(c, t, 0, by, W, FULL.barH, btns, focus, 'slim', flash);
        // the HMI's status icons show through
        c.clip(sx, 0, W - sx, HMI.status.h).clear(0).noclip();
        r.xf(1, 0, 0).append(c).xf();
    }

    /** The HMI's bar buttons in screen pixels: [{ id, label, x, w }]. */
    buttons() {
        if (this._btns) return this._btns;
        const m = new Recorder(1, 1);
        let x = HMI.btn.x;
        this._btns = (this.screen.buttons || []).map((b) => {
            const label = String(b[1] || b[0]);
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
