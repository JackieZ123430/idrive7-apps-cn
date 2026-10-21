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
        if (s.type === 'number') return String(v) + (s.unit ? ' ' + s.unit : '');
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
        return c ? this._try('text ' + name, c.setValue(row || 0, cell || 'Text', String(text), 'Text')) : Promise.resolve();
    }
    /** Set several cells of one row: ui.cells('LIST', 3, { Text1stCol: 'a', Text2ndCol: 'b' }) */
    cells(name, row, obj) {
        const c = this.comp(name);
        if (!c) return Promise.resolve();
        return Promise.all(Object.keys(obj).map((k) => this._try('cell ' + name + '.' + k, c.setValue(row, k, String(obj[k]), 'Text'))));
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
    onVisible(fn) { this._visHandlers.push(fn); }
    _setVisible(stateName, on) {
        if (this._visible[stateName] === on) return;
        this._visible[stateName] = on;
        log.debug('state ' + stateName + (on ? ' visible' : ' hidden'));
        this._visHandlers.forEach((fn) => { try { fn(stateName, on); } catch (e) { log.error(e); } });
    }

    /**
     * Show a drawn image (canvas.js Canvas or PNG Buffer) in a graphic cell.
     * The PNG goes to rhmiData/resources (readable by the HMI through the
     * install ACLs), gets a resource handle from the app's ResourceBundle, and
     * the old handle is released. Two alternating files avoid the HMI reading
     * a file while it is rewritten.
     */
    image(name, img, cell) {
        const st = this._img[name] || (this._img[name] = { n: 0, prev: null, busy: null, next: null });
        // coalesce: if a push is in flight, remember only the newest frame
        if (st.busy) { st.next = img; return st.busy; }
        const run = async (frame) => {
            const c = this.comp(name);
            if (!c) return;
            const rb = this.rhmi.getResourceBundle();
            // per-run file names: the HMI keeps state per resource path, so
            // names reused from an earlier run of the app get rejected
            const file = path.join(RHMI_RES, 'dyn_' + RUN_TAG + '_' + name.toLowerCase() + '_' + (st.n++ % 3) + '.png');
            const t0 = Date.now(), first = !st.shown;
            fs.writeFileSync(file, Buffer.isBuffer(frame) ? frame : frame.png());
            if (first) log.info('image ' + name + ': png written ' + (Date.now() - t0) + ' ms');
            await rb.createResourceHandles([file]);
            const handle = rb.getResourceHandle(file);
            if (first) log.info('image ' + name + ': handle ' + JSON.stringify(handle));
            await c.setValue(0, cell || 'Graphic', handle, 'Asset');
            if (first) { st.shown = true; log.info('image ' + name + ': shown after ' + (Date.now() - t0) + ' ms'); }
            if (st.prev && st.prev !== file) {
                const old = st.prev;
                rb.destroyResourceHandles([old]).catch((e) => { if (!st.destroyWarned) { st.destroyWarned = true; log.warn('destroy handle: ' + e); } });
            }
            st.prev = file;
        };
        st.busy = run(img).catch((e) => log.warn('image ' + name + ': ' + e)).then(() => {
            st.busy = null;
            if (st.next) { const n = st.next; st.next = null; return this.image(name, n, cell); }
        });
        return st.busy;
    }
}

/* ---------------- generic settings screen ---------------- */
function wireSettings(ctx) {
    const { ui, settings } = ctx;
    const schema = settings.schema;
    if (!schema.length || !ui.comp('SETTINGS')) return;
    const refresh = () => Promise.all(schema.map((s) => {
        const comp = 'SET_' + s.key.toUpperCase();
        if (s.type === 'bool') return Promise.all([ui.text(comp, s.label), ui.checked(comp, !!settings.get(s.key))]);
        return ui.cells(comp, 0, { Text1stCol: s.label, Text2ndCol: settings.display(s.key) });
    }));
    schema.forEach((s) => {
        ui.onClick('SET_' + s.key.toUpperCase(), () => { settings.cycle(s.key); return refresh(); });
    });
    if (ui.comp('BTN_SETTINGS')) ui.onClick('BTN_SETTINGS', () => refresh().then(() => ui.open('SETTINGS')));
    return refresh();
}

/* ---------------- run ---------------- */
async function run(impl) {
    try { return await runInner(impl); } catch (e) { fileLog('FATAL', 'start failed: ' + (e && e.stack || e)); throw e; }
}
async function runInner(impl) {
    const app = new OnlineApp();
    log.info('starting ' + SPEC.id + ' ' + SPEC.version);
    // lifecycle as BMW's M Laptimer does it: report ACTIVE as soon as the app
    // status channel is up (otherwise MainApp stops the app right after start),
    // report HMI visibility, and exit when MainApp asks us to shut down
    const active = () => Promise.resolve().then(() => app.registerActive())
        .then(() => log.info('registered active')).catch((e) => log.warn('registerActive: ' + e));
    app.on('appStatusProxyReady', active);
    app.on('shutdown', () => { log.info('shutdown requested by MainApp'); setTimeout(() => process.exit(0), 200); });
    await app.start();
    active();
    const ui = new Ui(app);
    const settings = new Settings(SPEC.settings);
    const ctx = {
        app, ui, settings, log, spec: SPEC, dataDir: DATA_DIR,
        signals: require('./signals'),
        theme: () => themes.theme(settings.get('theme')),
        /** Run fn about `fps` times a second while screen `stateName` is visible. */
        loop(stateName, fps, fn) {
            let timer = null, running = false, frames = 0;
            const tick = async () => {
                if (running) return;
                running = true;
                const t0 = Date.now();
                try { await fn(); } catch (e) { log.error('loop ' + stateName, e); }
                // every frame allocates image and PNG buffers; Node 8 frees them lazily, which lets
                // memory float up to the platform's limit (the app is then killed). Collect regularly.
                if (++frames % 3 === 0 && typeof global.gc === 'function') { try { global.gc(); } catch (e) { /* ignore */ } }
                running = false;
                const dt = Date.now() - t0;
                if (timer !== null) timer = setTimeout(tick, Math.max(30, 1000 / fps - dt));
            };
            const set = (on) => {
                if (on && timer === null) { timer = setTimeout(tick, 0); }
                if (!on && timer !== null) { clearTimeout(timer); timer = null; }
            };
            ui.onVisible((name, on) => { if (name === stateName) set(on); });
            if (ui.isVisible(stateName)) set(true);
            return { stop: () => set(false), kick: () => { if (timer !== null) { clearTimeout(timer); timer = setTimeout(tick, 0); } } };
        },
    };

    // visibility of our states (pauses rendering when the user leaves)
    (SPEC.screens || []).forEach((s) => {
        const st = ui.comp(s.name);
        if (st && st.on) st.on('visible', (ev) => ui._setVisible(s.name, !!(ev && ev.visible)));
    });
    ui.rhmi.on('applicationStackChanged', (stack) => {
        const shown = stack && Object.keys(stack).length > 0 && ('ROOT_APP' in stack);
        Promise.resolve().then(() => (shown ? app.registerHmiVisible() : app.unregisterHmiVisible()))
            .catch((e) => log.warn('hmi visible: ' + e));
        const open = [].concat.apply([], Object.keys(stack || {}).map((k) => stack[k] || []));
        (SPEC.screens || []).forEach((s) => {
            const st = ui.comp(s.name);
            if (st) ui._setVisible(s.name, open.indexOf(st.getId ? st.getId() : -1) >= 0);
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
