'use strict';
/**
 * mgu.js - the MGU App Kit runtime. Sits on top of BMW's oap-sdk and gives an
 * app everything it needs in a few calls:
 *
 *   const mgu = require('./kit/mgu');
 *   mgu.run({
 *     async start(ctx) {
 *       ctx.ui.onClick('BTN_RESET', () => ...);
 *       ctx.loop('MAIN', 4, async () => ctx.ui.image('MAIN_GFX', canvas));
 *     },
 *   });
 *
 * ctx = { app, ui, settings, log, theme(), signals, spec, dataDir }
 *
 * The screens / component names come from the app's app.json (see
 * kit/tools/build.py, which generates the RHMI layout from it). Every screen
 * is a real RHMI state rendered by the head unit's own HMI; graphics are PNGs
 * the app draws (canvas.js) and hands to the HMI as resources.
 */
const fs = require('fs');
const path = require('path');
const { OnlineApp, logging } = require('oap-sdk');
const themes = require('./themes');
const { Display } = require('./display');
const { HmiText } = require('./hmi-text');
const { listSheet } = require('./sheet');

const sdkLog = logging.getSDKLogger();
const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, 'app-spec.json'), 'utf8'));

/* ---------------- paths ---------------- */
// cwd of an OAP app is oap_<uid>/data; source is oap_<uid>/source
const APP_ROOT = path.resolve(__dirname, '..', '..', '..');
const DATA_DIR = fs.existsSync(path.join(APP_ROOT, 'data')) ? path.join(APP_ROOT, 'data') : process.cwd();
const RHMI_RES = path.join(APP_ROOT, 'rhmiData', 'resources');

/* ---------------- logging: SDK logger (DLT) + small rotating file ---------------- */
const LOG_FILE = path.join(DATA_DIR, SPEC.id + '.log');
const RUN_TAG = Date.now().toString(36);
// drop drawn frames left by earlier runs
try { fs.readdirSync(RHMI_RES).filter((f) => /^dyn_/.test(f)).forEach((f) => { try { fs.unlinkSync(path.join(RHMI_RES, f)); } catch (e) {} }); } catch (e) {}
function fileLog(level, msg) {
    try {
        const st = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE) : null;
        if (st && st.size > 256 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
        fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + level + ' ' + msg + '\n');
    } catch (e) { /* data dir not writable (host preview) */ }
}
// The SDK can swallow the first RHMI resource error and fail later with a misleading
// null entry-point factory. Preserve the original warnings/errors in the app log.
['warn', 'error'].forEach((level) => {
    const original = sdkLog[level];
    sdkLog[level] = (...args) => {
        const message = args.map((x) => x && x.stack || String(x)).join(' ');
        if (message.indexOf(SPEC.id + ': ') !== 0) fileLog('SDK_' + level.toUpperCase(), message);
        return original.apply(sdkLog, args);
    };
});
const log = {};
['error', 'warn', 'info', 'debug'].forEach((lvl) => {
    log[lvl] = (...a) => {
        const msg = a.map((x) => (x && x.stack) ? x.stack : (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
        try { sdkLog[lvl](SPEC.id + ': ' + msg); } catch (e) {}
        if (lvl !== 'debug' || process.env.MGU_DEBUG) fileLog(lvl.toUpperCase(), msg);
    };
});

// crashes otherwise only reach DLT; keep the reason next to the app's log
process.on('uncaughtException', (e) => { fileLog('FATAL', 'uncaught: ' + (e && e.stack || e)); process.exit(1); });
process.on('exit', (code) => fileLog(code ? 'FATAL' : 'INFO', 'exit code ' + code + ' rss=' + Math.round(process.memoryUsage().rss / 1048576) + 'MB'));

/* ---------------- settings (persisted in data/settings.json) ---------------- */
class Settings {
    constructor(schema) {
        this.schema = schema || [];
        this.file = path.join(DATA_DIR, 'settings.json');
        this.values = {};
        this.listeners = [];
        for (const s of this.schema) this.values[s.key] = s.default;
        try { Object.assign(this.values, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch (e) {}
        // one-time move of saved settings to the new default theme (M Tricolour); later choices are kept
        const th = this.item('theme');
        if (th && fs.existsSync(this.file) && this.values._themeV !== 2) {
            this.values.theme = th.default; this.values._themeV = 2;
            try { fs.writeFileSync(this.file, JSON.stringify(this.values, null, 1)); } catch (e) { /* read-only */ }
        }
        // a setting with "reset": n in app.json goes back to its default once when n changes
        // (a new default reaches cars that saved the old one); later choices are kept
        let changed = false;
        for (const it of this.schema) {
            const mark = '_reset_' + it.key;
            if (it.reset && this.values[mark] !== it.reset) { this.values[it.key] = it.default; this.values[mark] = it.reset; changed = true; }
        }
        if (changed && fs.existsSync(this.file)) try { fs.writeFileSync(this.file, JSON.stringify(this.values, null, 1)); } catch (e) { /* read-only */ }
    }
    get(key) { return this.values[key]; }
    set(key, value) {
        this.values[key] = value;
        try { fs.writeFileSync(this.file, JSON.stringify(this.values, null, 1)); } catch (e) { log.warn('settings save: ' + e); }
        this.listeners.forEach((fn) => { try { fn(key, value); } catch (e) { log.error(e); } });
    }
    onChange(fn) { this.listeners.push(fn); }
    item(key) { return this.schema.find((s) => s.key === key); }
    /** Human text for the current value of a setting. */
    display(key) {
        const s = this.item(key), v = this.values[key];
        if (!s) return String(v);
        if (s.type === 'choice') { const o = (s.options || []).find((x) => x[0] === v); return o ? o[1] : String(v); }
        if (s.type === 'number') return String(v) + (s.unit ? ' ' + s.unit : '') + (s.markDefault && v === s.default ? ' (default)' : '');
        if (s.type === 'bool') return v ? 'On' : 'Off';
        return String(v);
    }
    /** Advance a choice/number setting to its next value (wraps). */
    cycle(key) {
        const s = this.item(key);
        if (!s) return;
        if (s.type === 'bool') return this.set(key, !this.values[key]);
        const list = s.type === 'choice' ? s.options.map((o) => o[0]) : (s.steps || []);
        if (!list.length) return;
        const i = list.indexOf(this.values[key]);
        this.set(key, list[(i + 1) % list.length]);
    }
}

/* ---------------- UI wrapper ---------------- */
class Ui {
    constructor(app) {
        this.app = app;
        this.rhmi = app.rhmiApplication;
        this._img = Object.create(null);      // per-component dynamic image state
        this._visible = Object.create(null);  // stateName -> bool
        this._visHandlers = [];
        this._focus = Object.create(null);    // stateName -> false while a popup covers it
        this._focusHandlers = [];
        this.timing = { png: 0, push: 0 };    // ms spent encoding / handing images to the HMI
        this._cnText = new HmiText();
    }
    comp(name) {
        const c = this.rhmi && this.rhmi.getByName(name);
        if (!c) log.warn('no RHMI component named ' + name);
        return c;
    }
    _try(what, p) {
        let timer;
        const slow = new Promise((res) => { timer = setTimeout(() => { log.warn(what + ': no answer from HMI after 4 s'); res(); }, 4000); });
        return Promise.race([Promise.resolve(p), slow]).catch((e) => log.warn(what + ': ' + e)).then((v) => { clearTimeout(timer); return v; });
    }

    text(name, text, row, cell) {
        const c = this.comp(name);
        if (c && !row && (!cell || cell === 'Text') && this.display) this.display.label(name, text);   // slim bar mirrors it
        return c ? this._try('text ' + name, this._cnText.set(c, name, row || 0, cell || 'Text', text)) : Promise.resolve();
    }
    /** Set several cells of one row: ui.cells('LIST', 3, { Text1stCol: 'a', Text2ndCol: 'b' }) */
    cells(name, row, obj) {
        const c = this.comp(name);
        if (!c) return Promise.resolve();
        return Promise.all(Object.keys(obj).map((k) => this._try('cell ' + name + '.' + k, this._cnText.set(c, name, row, k, obj[k]))));
    }
    /** Selected row of a drop-down menu. */
    selected(name, row) {
        const c = this.comp(name);
        return c ? this._try('selected ' + name, c.setValue('SelectedItem', row, 'UInt')) : Promise.resolve();
    }
    rows(name, n) { const c = this.comp(name); return c ? this._try('rows ' + name, c.setRowCount(n)) : Promise.resolve(); }
    visible(name, on) { const c = this.comp(name); return c ? this._try('visible ' + name, c.setProperty('Visible', on ? 1 : 0, 'UInt')) : Promise.resolve(); }
    enabled(name, on) { const c = this.comp(name); return c ? this._try('enabled ' + name, c.setProperty('Enabled', on ? 1 : 0, 'UInt')) : Promise.resolve(); }
    checked(name, on, row) {
        const c = this.comp(name);
        if (!c) return Promise.resolve();
        // setValue creates the row if needed (setRowSelected only checks and fails)
        const p = c.setValue(row || 0, 'eParam_RowSelected', !!on, 'Bool');
        return this._try('checked ' + name, p);
    }
    /** Click handler; fn({ row, value }) */
    onClick(name, fn) {
        const c = this.comp(name);
        if (c) c.on('action', (ev) => { log.info('click ' + name); Promise.resolve().then(() => fn(ev || {})).catch((e) => log.error('click ' + name, e)); });
    }
    open(stateName) { return this._try('open ' + stateName, this.rhmi.openState(stateName)); }
    close(stateName) { return this._try('close ' + stateName, this.rhmi.closeState(stateName)); }
    isVisible(stateName) { return !!this._visible[stateName]; }
    /** false while an HMI popup covers the (visible) screen */
    hasFocus(stateName) { return this._focus[stateName] !== false; }
    onFocus(fn) { this._focusHandlers.push(fn); }
    _setFocus(stateName, on) {
        if (this.hasFocus(stateName) === on) return;
        this._focus[stateName] = on;
        log.info('state ' + stateName + (on ? ' has focus again' : ' covered by an HMI popup'));
        this._focusHandlers.forEach((fn) => { try { fn(stateName, on); } catch (e) { log.error(e); } });
    }
    /** forget what the HMI shows (the next image is pushed for sure) */
    _invalidate() { Object.keys(this._img).forEach((k) => { this._img[k].lastPx = null; }); }
    onVisible(fn) { this._visHandlers.push(fn); }
    _setVisible(stateName, on) {
        if (this._visible[stateName] === on) return;
        this._visible[stateName] = on;
        if (on) this._focus[stateName] = true;
        if (on) Object.keys(this._img).forEach((k) => { this._img[k].lastPx = null; });      // push the next frame for sure
        log.debug('state ' + stateName + (on ? ' visible' : ' hidden'));
        this._visHandlers.forEach((fn) => { try { fn(stateName, on); } catch (e) { log.error(e); } });
    }

    /**
     * Show a drawn image (canvas.js Canvas or PNG Buffer) in a graphic cell.
     * The PNG goes to rhmiData/resources (readable by the HMI through the
     * install ACLs), gets a resource handle from the app's ResourceBundle, and
     * an older handle is released.
     *
     * The HMI loads a new image after setValue has already returned. Releasing the previous
     * image right then made the screen blink black (~0.5 s) whenever loading was slow - mostly
     * the first minutes after the head unit starts. So the previous image stays until the next
     * frame is set (handles released two frames late), four files rotate so none is rewritten
     * while it may still be on screen or loading, and each file is written under a temporary
     * name and renamed into place, so the HMI never reads half a file.
     */
    image(name, img, cell) {
        if (this.display) return this.display.present(name, img, (n, cv) => this._image(n, cv, cell));
        return this._image(name, img, cell);
    }
    _image(name, img, cell) {
        const st = this._img[name] || (this._img[name] = { n: 0, live: [], busy: null, next: null });
        // coalesce: if a push is in flight, remember only the newest frame
        if (st.busy) { st.next = img; return st.busy; }
        const run = async (frame) => {
            const c = this.comp(name);
            if (!c) return;
            // a frame identical to the one on screen (parked car, steady values) is not encoded and
            // pushed again - that is most of a frame's cost. Re-sent every 5 s anyway, and after the
            // screen is opened again (_setVisible), in case the HMI dropped it.
            const px = Buffer.isBuffer(frame) ? null : Buffer.from(frame.d.buffer, frame.d.byteOffset, frame.d.length);
            if (px && st.shown && st.lastPx && Date.now() - st.lastPush < 5000 && px.equals(st.lastPx)) return;
            const rb = this.rhmi.getResourceBundle();
            // per-run file names: the HMI keeps state per resource path, so
            // names reused from an earlier run of the app get rejected
            const file = path.join(RHMI_RES, 'dyn_' + RUN_TAG + '_' + name.toLowerCase() + '_' + (st.n++ % 4) + '.png');
            const t0 = Date.now(), first = !st.shown;
            const png = Buffer.isBuffer(frame) ? frame : frame.png();
            const t1 = Date.now();
            fs.writeFileSync(file + '.tmp', png);
            fs.renameSync(file + '.tmp', file);
            if (first) log.info('image ' + name + ': png written ' + (Date.now() - t0) + ' ms');
            await rb.createResourceHandles([file]);
            const handle = rb.getResourceHandle(file);
            if (first) log.info('image ' + name + ': handle ' + JSON.stringify(handle));
            await c.setValue(0, cell || 'Graphic', handle, 'Asset');
            this.timing.png += t1 - t0; this.timing.push += Date.now() - t1;       // for the loop's log line
            if (px) { st.lastPx = Buffer.from(px); st.lastPush = Date.now(); }       // a copy: the canvas may be drawn on again
            if (first) { st.shown = true; log.info('image ' + name + ': shown after ' + (Date.now() - t0) + ' ms'); }
            // keep the image on screen and the one before it (the HMI may still show it while it
            // loads this one); release anything older
            st.live = st.live.filter((f) => f !== file).concat([file]);
            while (st.live.length > 2) {
                const old = st.live.shift();
                rb.destroyResourceHandles([old]).catch((e) => { if (!st.destroyWarned) { st.destroyWarned = true; log.warn('destroy handle: ' + e); } });
            }
        };
        st.busy = run(img).catch((e) => log.warn('image ' + name + ': ' + e)).then(() => {
            st.busy = null;
            if (st.next) { const n = st.next; st.next = null; return this._image(name, n, cell); }
        });
        return st.busy;
    }
}


/* ---------------- home-screen widget (app.json "startWidget") ----------------
 * How BMW's widgets work on this firmware (taken from MainApp and the Drive Recorder app):
 * the app ships rhmiDataStartWidget/ (kit/tools/build.py); MainApp finds it, offers the widget
 * in the home screen's widget list and, when one is placed, starts the app (if needed) and hands
 * it the widget's RHMI application (OnlineApp "startWidgetInitialized"). Each widget placed on the
 * home screen is a "spawn" of the one startWidget component: the app writes the layout's cells
 * per spawn (setValue(spawnId, cell, value, type)). widgetSize 1 = small, anything else = big.
 * The HMI's events (placed, removed, resized, shown, tapped) come through MainApp:
 * CREATE_START_WIDGET_RHMI_APP (with the events so far) and SEND_EVENTS later. The SDK the kit is
 * built with only knows the first, so patchStartWidgetEvents() adds the rest.
 */
function patchStartWidgetEvents(app) {
    const orig = app._createStartWidgetRhmiApplication;
    if (typeof orig !== 'function') { log.warn('widget: this SDK has no start widget support'); return; }
    const replay = (self, cfg, list) => {
        (list || []).forEach((ev) => {
            const c = self.startWidgetRhmiApplication && self.startWidgetRhmiApplication.getById(Number(ev.componentId));
            if (!c) return;
            if (cfg.components && cfg.components[ev.componentId]) Object.assign(c.spawnedInstances, cfg.components[ev.componentId]);
            const inst = (id) => (c.spawnedInstances[id] = c.spawnedInstances[id] || {});
            if (ev.type === 'created') { Object.assign(inst(ev.spawnId), { context: ev.context }, ev.widgetSize !== undefined ? { widgetSize: ev.widgetSize } : {}); c.emit('created', { spawnId: ev.spawnId, context: ev.context }); }
            else if (ev.type === 'resize') { inst(ev.spawnId).widgetSize = ev.widgetSize; c.emit('resize', { spawnId: ev.spawnId, widgetSize: ev.widgetSize }); }
            else if (ev.type === 'create') c.emit('create', { widgetSize: ev.widgetSize });
            else if (ev.type === 'action') c.emit('action', { spawnId: ev.spawnId, context: ev.context });
            else if (ev.type === 'visible') c.emit('visible', { spawnId: ev.spawnId, visible: ev.visible });
            else if (ev.type === 'abort' || ev.type === 'destroyed') { delete c.spawnedInstances[ev.spawnId]; c.emit(ev.type, { spawnId: ev.spawnId }); }
        });
    };
    app._createStartWidgetRhmiApplication = function (raw) {
        let cfg = null;
        try { cfg = JSON.parse(raw && raw.configData); } catch (e) { /* the SDK reports it */ }
        if (cfg && cfg.command === 'SEND_EVENTS') {
            // raw RHMI events, as the HMI sent them to MainApp: the component parses them itself
            const sw = this.startWidgetRhmiApplication;
            Object.keys(cfg.rhmiEvents || {}).forEach((id) => {
                const c = sw && sw.getById(Number(id));
                if (c) (cfg.rhmiEvents[id] || []).forEach((e) => { try { c.parseUserEvent(e); } catch (err) { log.warn('widget event: ' + err); } });
            });
            return Promise.resolve({});
        }
        return Promise.resolve(orig.call(this, raw)).then((r) => {
            if (cfg && Array.isArray(cfg.events)) replay(this, cfg, cfg.events);
            return r || {};
        });
    };
}

class Widget {
    constructor(spec) {
        this.spec = spec || {};
        this.comp = null;
        this.vis = Object.create(null);      // spawnId -> visible (unknown = true)
        this._img = Object.create(null);
        this._change = [];
        this._tap = [];
        this.timing = { png: 0, push: 0 };
    }
    get ready() { return !!this.comp; }
    /** Placed widgets: [{ spawnId, big, visible }]. */
    instances() {
        if (!this.comp) return [];
        return Object.keys(this.comp.spawnedInstances || {}).map((k) => {
            const i = this.comp.spawnedInstances[k] || {};
            return { spawnId: Number(k), big: i.widgetSize !== 1, size: i.widgetSize, visible: this.vis[k] !== false };
        });
    }
    /** A widget is on the home screen and showing. */
    active() { return this.instances().some((i) => i.visible); }
    onChange(fn) { this._change.push(fn); }
    onTap(fn) { this._tap.push(fn); }
    _changed(why) { log.info('widget ' + why + ': ' + JSON.stringify(this.instances())); this._change.forEach((fn) => { try { fn(why); } catch (e) { log.error(e); } }); }
    attach(rhmiApp) {
        const name = SPEC.id.toUpperCase() + '_WIDGET';
        const c = rhmiApp && rhmiApp.getByName(name);
        if (!c) { log.warn('widget: no component ' + name); return; }
        this.comp = c;
        c.on('created', (e) => { this.vis[e.spawnId] = true; this._static(e.spawnId); this._changed('placed'); });
        c.on('resize', (e) => { this._forget(e.spawnId); this._changed('resized'); });
        c.on('visible', (e) => { this.vis[e.spawnId] = !!e.visible; if (e.visible) this._forget(e.spawnId); this._changed(e.visible ? 'shown' : 'hidden'); });
        ['abort', 'destroyed'].forEach((n) => c.on(n, (e) => { delete this.vis[e.spawnId]; this._forget(e.spawnId); this._changed('removed'); }));
        c.on('action', (e) => { log.info('widget tapped (' + e.spawnId + ')'); this._tap.forEach((fn) => { try { fn(e); } catch (err) { log.error(err); } }); });
        this.instances().forEach((i) => this._static(i.spawnId));
        this._changed('ready');
    }
    _forget(spawnId) { const st = this._img[spawnId]; if (st) st.lastPx = null; }
    /** The layout's fixed cells (app.json startWidget.cells), written once per placed widget. */
    _static(spawnId) {
        const cells = this.spec.cells || {};
        Object.keys(cells).forEach((k) => {
            const [value, type] = cells[k];
            this.set(spawnId, k, value, type);
        });
    }
    set(spawnId, cell, value, type) {
        if (!this.comp) return Promise.resolve();
        if ((type || 'Text') === 'Text') value = widgetText(value);
        return Promise.resolve(this.comp.setValue(Number(spawnId), cell, value, type || 'Text'))
            .catch((e) => log.warn('widget ' + cell + ': ' + e));
    }
    /** Show a drawn image (canvas.js Canvas) in a placed widget (cell: app.json startWidget.image). */
    image(spawnId, img) {
        const st = this._img[spawnId] || (this._img[spawnId] = { n: 0, live: [], busy: null, next: null });
        if (st.busy) { st.next = img; return st.busy; }
        const cell = this.spec.image || 'BackgroundImage1';
        const run = async (frame) => {
            if (!this.comp) return;
            const px = Buffer.from(frame.d.buffer, frame.d.byteOffset, frame.d.length);
            if (st.lastPx && Date.now() - st.lastPush < 5000 && px.equals(st.lastPx)) return;
            const rb = this.comp.getResourceBundle();
            const file = path.join(RHMI_RES, 'dyn_' + RUN_TAG + '_w' + spawnId + '_' + (st.n++ % 4) + '.png');
            const t0 = Date.now(), png = frame.png(), t1 = Date.now();
            fs.writeFileSync(file + '.tmp', png);
            fs.renameSync(file + '.tmp', file);
            await rb.createResourceHandles([file]);
            await this.comp.setValue(Number(spawnId), cell, rb.getResourceHandle(file), 'Asset');
            this.timing.png += t1 - t0; this.timing.push += Date.now() - t1;
            if (!st.lastPush) log.info('widget ' + spawnId + ': first image in ' + (Date.now() - t0) + ' ms');
            st.lastPx = Buffer.from(px); st.lastPush = Date.now();
            st.live = st.live.filter((f) => f !== file).concat([file]);
            while (st.live.length > 2) rb.destroyResourceHandles([st.live.shift()]).catch(() => {});
        };
        st.busy = run(img).catch((e) => log.warn('widget image ' + spawnId + ': ' + e)).then(() => {
            st.busy = null;
            if (st.next) { const n = st.next; st.next = null; return this.image(spawnId, n); }
        });
        return st.busy;
    }
    /**
     * Run draw(instance) -> Canvas for every widget on screen, about `fps` times a second
     * (only while one is showing). The images are pushed as they finish; a slow push skips frames.
     */
    loop(fps, draw) {
        let frames = 0;
        const tick = async () => {
            // every placed widget, shown or not: a visibility event the app missed must not leave one blank
            const list = this.instances();
            if (list.length) {
                for (const i of list) {
                    try { const cv = await draw(i); if (cv) this.image(i.spawnId, cv); } catch (e) { log.error('widget draw', e); }
                }
                if (++frames % 3 === 0 && typeof global.gc === 'function') { try { global.gc(); } catch (e) { /* ignore */ } }
                if (frames % 200 === 0) {
                    log.info('widget loop: png ' + Math.round(this.timing.png / 200) + ' ms, hmi ' + Math.round(this.timing.push / 200) + ' ms per frame');
                    this.timing.png = 0; this.timing.push = 0;
                }
            }
            setTimeout(tick, list.length ? 1000 / Math.max(1, typeof fps === 'function' ? fps() : fps) : 1000);
        };
        setTimeout(tick, 0);
    }
}

/* ---------------- generic settings screen ---------------- */
function wireSettings(ctx) {
    const { ui, settings } = ctx;
    const schema = settings.schema;
    // the settings screen, or an app's own menu screen that shows them ("settings": true)
    if (!schema.length || !schema.some((s) => ui.comp('SET_' + s.key.toUpperCase()))) return;
    // choice / number settings are drop-downs (kit/tools/build.py): their rows are the values in this order
    const values = (s) => (s.type === 'choice' ? (s.options || []).map((o) => o[0]) : s.type === 'number' ? s.steps || [] : null);
    const refresh = () => Promise.all(schema.map((s) => {
        const comp = 'SET_' + s.key.toUpperCase();
        if (s.type === 'bool') return Promise.all([ui.text(comp, s.label), ui.checked(comp, !!settings.get(s.key))]);
        if (values(s)) return ui.selected(comp, Math.max(0, values(s).indexOf(settings.get(s.key))));
        // other types: two-row buttons in the wide settings state, label above, value below
        return ui.cells(comp, 0, { Text1stRow: s.label, Text2ndRow: settings.display(s.key) });
    }));
    schema.forEach((s) => {
        const comp = 'SET_' + s.key.toUpperCase();
        if (values(s)) {
            // the chosen row of the drop-down (the HMI shows the selection itself)
            ui.onClick(comp, (ev) => {
                const v = values(s)[ev && ev.row];
                if (v !== undefined && v !== settings.get(s.key)) settings.set(s.key, v);
            });
        } else ui.onClick(comp, () => { settings.cycle(s.key); return refresh(); });
    });
    // Settings: drawn over the page by the renderer (sheet.js) where the kit runs the screen,
    // else the HMI's settings screen. The HMI's screen shows the values chosen in either.
    settings.onChange(() => { if (!ctx.display.sheet) refresh(); });
    if (ui.comp('BTN_SETTINGS')) {
        ui.onClick('BTN_SETTINGS', () => {
            const d = ctx.display;
            if (d.sheet && d.sheet.settings) { d.closeSheet(); return null; }
            const sh = listSheet(settings, null, { version: SPEC.version });
            sh.settings = true;
            sh.onClose = () => refresh();
            if (d.openSheet(sh)) return null;
            return refresh().then(() => ui.open('SETTINGS'));
        });
    }
    return refresh();
}

// widget text cells: ASCII only, as before the Chinese text support. A widget has its own string
// bundle, without the app's SID_CN_DYNAMIC slots, so non-ASCII text can't go through StringIds there.
function widgetText(s) {
    return String(s).replace(/°/g, '').replace(/[^\x20-\x7e]/g, '');
}

/* ---------------- run ---------------- */
async function run(impl) {
    try { return await runInner(impl); } catch (e) {
        // log only: no process.exit here. On the car an unexpected exit makes CorruptAppsHandler
        // wipe the app's data, and a second one uninstalls a custom app.
        fileLog('FATAL', 'start failed: ' + (e && e.stack || e));
        throw e;
    }
}
async function runInner(impl) {
    const app = new OnlineApp();
    log.info('starting ' + SPEC.id + ' ' + SPEC.version);
    // interfaces this unit lacks, which the installer left out (app.json "_optional")
    try {
        const missing = JSON.parse(fs.readFileSync(path.join(__dirname, 'missing-interfaces.json'), 'utf8'));
        Object.keys(missing).forEach((i) => log.warn('this unit has no ' + i + ' - running without it: ' + missing[i]));
    } catch (e) { /* none missing */ }
    // lifecycle as BMW's M Laptimer does it: report ACTIVE as soon as the app
    // status channel is up (otherwise MainApp stops the app right after start),
    // report HMI visibility, and exit when MainApp asks us to shut down
    const active = () => Promise.resolve().then(() => app.registerActive())
        .then(() => log.info('registered active')).catch((e) => log.warn('registerActive: ' + e));
    app.on('appStatusProxyReady', active);
    app.on('shutdown', () => { log.info('shutdown requested by MainApp'); setTimeout(() => process.exit(0), 200); });
    // home-screen widget: MainApp hands it over (now or whenever one is placed)
    const widget = new Widget(SPEC.startWidget);
    if (SPEC.startWidget) {
        patchStartWidgetEvents(app);
        app.on('startWidgetInitialized', (rhmiApp) => { log.info('widget initialized'); widget.attach(rhmiApp); });
    }
    await app.start();
    active();
    const ui = new Ui(app);
    const settings = new Settings(SPEC.settings);
    const display = new Display(ui, log, SPEC, settings, () => themes.theme(settings.get('theme')));
    ui.display = display;
    const ctx = {
        app, ui, settings, log, spec: SPEC, dataDir: DATA_DIR, display, widget,
        signals: require('./signals'),
        theme: () => themes.theme(settings.get('theme')),
        /**
         * controller.grab(true): the iDrive controller's knob, press and tilt go to this app only
         * (the HMI stops moving its focus or opening its menus); BACK, MENU and the touchscreen
         * still work. Read the controller with signals (FrontCCU). Only while shown; release with
         * grab(false). Needs the GPU renderer and mgu-inputgate.so in the HMI (deploy-car.sh).
         */
        // onInput(fn): while grabbed, fn gets each controller event the HMI didn't (same fields
        // as FrontCCU.statusRotaryEncoderState, enums as numbers)
        controller: { grab(on) { display.grab(on); }, onInput(fn) { display.onCcu = fn; } },
        /**
         * onTab(fn): fn(i) when page tab i is tapped on the touchscreen (renderer with touch
         * routing), or pressed with the controller after turning onto it.
         */
        onTab(fn) { display.onTab = fn; },
        /** onTap(fn): fn(x, y) for a tap on the page (app drawing px), where the kit runs the screen. */
        onTap(fn) { display.onTap = fn; },
        /** Show a sheet (sheet.js) over the page; false where it can't be (software path, other renderers). */
        sheet(sh) { return display.openSheet(sh); },
        /** hideButton(id): leave bar button id out where the kit runs the screen (its job is on the page there). */
        hideButton(id) { display.hideButton(id); },
        /**
         * onScroll(fn): fn(dy) scrolls a page drawn with cv.scroll = true by dy px (+ = further down), from a
         * finger dragged on it or the controller turned while on it; returns false when already at that end.
         */
        onScroll(fn) { display.onScroll = fn; },
        /**
         * onLayout(fn): fn() when where the frame goes changed (the renderer came or went, touch routing, the
         * layout setting): an app that draws only when its data changes draws again then.
         */
        onLayout(fn) { display.onLayout(fn); },
        /** The surface to draw one frame on (record.js Recorder, reused): pass it to ui.image. */
        canvas(w, h) { return display.canvas(w, h); },
        /**
         * Run fn while screen `stateName` is visible: once per screen refresh (up to 60 fps)
         * when the GPU renderer shows it, else about `fps` times a second.
         */
        loop(stateName, fps, fn) {
            let timer = null, on = false, running = false, frames = 0, spent = 0;
            const gpuOn = () => display.active(stateName);
            const tick = async () => {
                timer = null;
                if (!on || running) return;
                running = true;
                const t0 = Date.now();
                try { await fn(); } catch (e) { log.error('loop ' + stateName, e); }
                running = false;
                const dt = Date.now() - t0;
                frames++; spent += dt;
                // software frames allocate image and PNG buffers; Node 8 frees them lazily, which lets
                // memory float up to the platform's limit (the app is then killed). Collect regularly.
                if (!gpuOn() && frames % 3 === 0 && typeof global.gc === 'function') { try { global.gc(); } catch (e) { /* ignore */ } }
                if (frames % (gpuOn() ? 600 : 100) === 0) {
                    const n = gpuOn() ? 600 : 100, tm = ui.timing, png = Math.round(tm.png / n), push = Math.round(tm.push / n), all = (spent / n).toFixed(1);
                    log.info('loop ' + stateName + ': ' + all + ' ms per frame in JS' + (gpuOn() ? ' (GPU renderer)' : ' (draw ' + Math.max(0, all - png - push) + ', png ' + png + ', hmi ' + push + '; asked for ' + fps + ' fps)'));
                    spent = 0; tm.png = 0; tm.push = 0;
                }
                schedule(dt);
            };
            const schedule = (dt) => {
                if (!on || timer !== null || running) return;
                if (gpuOn()) {
                    // the renderer sends a tick when it can take the next frame; if this frame was
                    // not sent (unchanged), look again shortly
                    // (a tick normally follows a sent frame; 250 ms is the safety net if none comes)
                    timer = setTimeout(tick, display.gpu.waiting ? 250 : 16);
                } else timer = setTimeout(tick, Math.max(15, 1000 / fps - (dt || 0)));
            };
            display.onTick(() => {
                // a tick from the renderer, or the renderer went away (then back to the timer)
                if (!on || running) return;
                if (timer !== null) { clearTimeout(timer); timer = null; }
                if (gpuOn()) tick(); else schedule(0);
            });
            const set = (v) => {
                on = v;
                if (on && timer === null && !running) timer = setTimeout(tick, 0);
                if (!on && timer !== null) { clearTimeout(timer); timer = null; }
            };
            ui.onVisible((name, v) => { if (name === stateName) set(v); });
            if (ui.isVisible(stateName)) set(true);
            return {
                stop: () => set(false),
                kick: () => { if (on && !running) { if (timer !== null) clearTimeout(timer); timer = setTimeout(tick, 0); } },
            };
        },
    };

    // visibility of our states (pauses rendering when the user leaves); the HMI's settings screen too (the
    // drawn screen gives way to it: display.js)
    const tracked = (SPEC.screens || []).concat(SPEC.settings && SPEC.settings.length ? [{ name: 'SETTINGS' }] : []);
    tracked.forEach((s) => {
        const st = ui.comp(s.name);
        if (st && st.on) st.on('visible', (ev) => ui._setVisible(s.name, !!(ev && ev.visible)));
        // a popup over the screen (options, warnings, calls) takes its focus: the display hides
        // the GPU overlay meanwhile, so the popup is never covered
        if (st && st.on) st.on('focus', (ev) => ui._setFocus(s.name, !(ev && ev.focus === false)));
    });
    ui.rhmi.on('applicationStackChanged', (stack) => {
        const shown = stack && Object.keys(stack).length > 0 && ('ROOT_APP' in stack);
        Promise.resolve().then(() => (shown ? app.registerHmiVisible() : app.unregisterHmiVisible()))
            .catch((e) => log.warn('hmi visible: ' + e));
        const open = [].concat.apply([], Object.keys(stack || {}).map((k) => stack[k] || []));
        tracked.forEach((s) => {
            const st = ui.comp(s.name);
            if (st) ui._setVisible(s.name, open.indexOf(st.getId ? st.getId() : -1) >= 0);
            // back in front (reopened after Home or another app): the HMI does not always say the
            // screen has its focus again, and without it the drawn screen stayed hidden
            if (st && shown && ui.isVisible(s.name)) ui._setFocus(s.name, true);
        });
    });

    // entry points (tiles): map them to the main screen once, up front, like
    // BMW's own apps do; a tap then only opens the mapped state
    const mainName = (SPEC.screens && SPEC.screens[0] && SPEC.screens[0].name) || 'MAIN';
    let entryUuids = [];
    try {
        const appDesc = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'rhmiData', 'application.json'), 'utf8'));
        entryUuids = ((appDesc.application && appDesc.application.entryPoints) || []).map((e) => e.uuid);
    } catch (e) { log.warn('no rhmiData/application.json: ' + e); }
    const mainState = ui.comp(mainName);
    const mapped = {};
    await Promise.all(entryUuids.map((uuid) => ui.rhmi.mapEntryState(uuid, mainState)
        .then(() => { mapped[uuid] = true; log.info('mapped entry ' + uuid + ' -> ' + mainName); })
        .catch((e) => log.error('map entry state', e))));
    let opening = null;
    const openEntry = (uuid) => {
        if (opening) return opening;   // MainApp can send the same tap twice
        const map = mapped[uuid] ? Promise.resolve() : ui.rhmi.mapEntryState(uuid, mainState).then(() => { mapped[uuid] = true; });
        opening = map
            .then(() => (mainState && mainState.updateResources ? mainState.updateResources().catch(() => {}) : null))
            .then(() => ui.rhmi.openEntryState(uuid))
            .then(() => ui._setVisible(mainName, true))
            .catch((e) => log.error('open entry state', e))
            .then(() => { opening = null; });
        return opening;
    };
    // a tap on the home-screen widget opens the app
    widget.onTap(() => { if (entryUuids[0]) openEntry(entryUuids[0]); });
    app.on('entryPointExecute', (uuid, reason, name) => {
        log.info('entry point ' + name + ' (' + reason + ')');
        openEntry(uuid);
    });

    // never let a UI call that the HMI does not answer block the app start:
    // MainApp shows "loading app" until initialized() is called
    const step = (what, p, ms) => {
        let timer;
        return Promise.race([
            Promise.resolve(p).then(() => log.info(what + ' done')),
            new Promise((res) => { timer = setTimeout(() => { log.warn(what + ' still pending after ' + ms + ' ms, continuing'); res(); }, ms); }),
        ]).catch((e) => log.error(what, e)).then(() => clearTimeout(timer));
    };
    // push every screen's rows to the HMI once (BMW apps do this via
    // updateResources before opening a state); until then the HMI has no rows
    // and lists render empty
    // (menu screens only: doing it on a canvas screen before its first image
    // makes every later createResourceHandles fail with INVALID_VALUE)
    await step('screen resources', Promise.all((SPEC.screens || []).filter((s) => s.kind !== 'canvas')
        .concat(SPEC.settings && SPEC.settings.length ? [{ name: 'SETTINGS' }] : [])
        .map((s) => ui.comp(s.name)).filter((st) => st && st.updateResources)
        .map((st) => st.updateResources())), 4000);
    await step('settings screen', wireSettings(ctx), 3000);
    if (impl && impl.start) await step('app start', Promise.resolve().then(() => impl.start(ctx)), 5000);
    await app.initialized();
    log.info('initialized (start reason ' + app.startReason + ')');
    // launched by a tile tap / bookmark: the execute event came before we
    // listened, so open the screen ourselves (M Laptimer does the same)
    const lastEntry = app.getLastExecutedEntryPointUuid && app.getLastExecutedEntryPointUuid();
    if (lastEntry && ['ENTRY_POINT', 'BOOKMARK', 'LUM'].indexOf(String(app.startReason)) >= 0) openEntry(lastEntry);
    process.on('unhandledRejection', (e) => log.error('unhandled', e));
    return ctx;
}

module.exports = { run, log, Settings, SPEC };
