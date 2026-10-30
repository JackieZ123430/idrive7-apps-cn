'use strict';
/**
 * hu-stub.js - a stubbed head unit for running a built app (dist/<id>) on the PC: the RHMI ui, the
 * real Settings class, ctx and the kit/mgu module the app requires. No SDK, no SOME/IP.
 *
 *   const hu = headUnit('dist/redline', { dataDir, image: (name, cv) => ..., fresh: true, sets });
 *   hu.start();          // loads the app (its mgu.run(impl) gets hu.ctx)
 *
 * preview.js (default): frames on demand. ctx.loop only records each screen's draw function
 * (hu.loopFn draws one frame of the screen shown), every frame goes to the renderer stream, demo data.
 *
 * live: true (emu.js): as on the car. Screens open and close as the HMI's stack would, ctx.loop is
 * mgu.js's (paced by the renderer's ticks on MGU_RENDERD_SOCKET), bar buttons are components the kit
 * presses (ui.rhmi.getByName), the settings sheet is wired as mgu.js wires it, settings persist in
 * dataDir, and the signals stub takes raw values from the emulator (hu.feed). Run as a script it is
 * emu.js's app process:  node kit/tools/hu-stub.js <dist/id> <dataDir>  (IPC messages: runLive below).
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const EventEmitter = require('events');

function headUnit(stage, o) {
    o = o || {};
    const live = !!o.live, out = o.dataDir;
    const kitDir = path.join(stage, 'source', 'javascript', 'kit');
    const spec = JSON.parse(fs.readFileSync(path.join(kitDir, 'app-spec.json'), 'utf8'));
    const log = o.log || { info: console.log, warn: console.warn, error: console.error, debug: () => {} };
    const src = fs.readFileSync(path.join(kitDir, 'mgu.js'), 'utf8').replace(/\r\n/g, '\n');
    const { Settings } = (() => {
        // reuse the real Settings class without loading the SDK
        const m = src.match(/class Settings[\s\S]*?\n}\n/);
        const fn = new Function('fs', 'path', 'DATA_DIR', 'log', m[0] + '\nreturn { Settings };');
        return fn(fs, path, out, live ? log : console);
    })();

    const hu = new EventEmitter();
    const handlers = hu.handlers = {};
    const loops = hu.loops = {};
    const main = (spec.screens && spec.screens[0] && spec.screens[0].name) || 'MAIN';
    let shown = main;
    hu.loopFn = () => loops[shown] && loops[shown]();
    hu.spec = spec; hu.kitDir = kitDir; hu.log = log;
    const fresh = !fs.existsSync(path.join(out, 'settings.json'));
    const settings = hu.settings = new Settings(spec.settings);
    if (o.fresh) {
        try { fs.unlinkSync(settings.file); } catch (e) {}
        settings.values = {};
        for (const s of spec.settings || []) settings.values[s.key] = s.default;
        Object.assign(settings.values, { demo: 'on' }, o.sets);
    } else if (live) {
        if (fresh) settings.values.demo = 'on';          // first run: the demo drive
        Object.assign(settings.values, o.sets);
    }

    let display = null;
    const softImage = (n, cv) => ui._image(n, cv);
    const ui = hu.ui = live ? liveUi(hu, () => display, softImage) : {
        image: (name, cv) => display.present(name, cv, softImage),
        _image: (name, cv) => o.image(name, cv),
        text: async (n, t) => console.log('text', n, JSON.stringify(t)),
        cells: async (n, r, x) => console.log('cells', n, r, JSON.stringify(x)),
        rows: async (n, c) => console.log('rows', n, c),
        visible: async () => {}, enabled: async () => {}, checked: async () => {},
        onClick: (n, fn) => { handlers[n] = fn; },
        open: async (n) => { console.log('open', n); if (loops[n]) shown = n; }, close: async () => {},
        isVisible: (n) => !!process.env.MGU_RENDERD_FILE && n === shown, onVisible: () => {}, comp: () => ({}),
    };
    if (live) ui._image = (name, cv) => o.image(name, cv);
    const themeFn = () => require(path.join(kitDir, 'themes')).theme(settings.get('theme'));
    const { Display } = require(path.join(kitDir, 'display'));
    settings.onChange = settings.onChange || (() => {});
    display = hu.display = new Display(ui, log, spec, settings, themeFn);
    if (live) ui.display = display;
    else {
        // every frame goes to the stream, also unchanged ones (frames=<n> must stay in step with time)
        const send = display._send.bind(display);
        display._send = (n, x, s) => send(n, x, s, true);
    }
    const WIDGETS = hu.WIDGETS = [{ spawnId: 1, big: false, size: 1, visible: true }, { spawnId: 2, big: true, size: 2, visible: true }];
    hu.widgetFn = null;
    const ctx = hu.ctx = {
        ui, settings, spec, dataDir: out, log, display,
        canvas: (w, h) => display.canvas(w, h),
        onTab(fn) { display.onTab = fn; },
        // as kit/mgu.js: the kit's own screen (tabs, page buttons, sheets, scrolling) where the renderer has the app
        onTap(fn) { display.onTap = fn; },
        sheet: (sh) => display.openSheet(sh),
        hideButton(id) { display.hideButton(id); },
        onScroll(fn) { display.onScroll = fn; },
        onLayout(fn) { display.onLayout(fn); },
        controller: { grab(on) { display.grab(on); }, onInput(fn) { display.onCcu = fn; } },
        signals: live ? liveSignals(hu) : { watch: async (iface) => ({ iface, error: 'preview' }), proxy: async () => { throw new Error('preview'); } },
        theme: themeFn,
        loop: live ? liveLoop(hu) : (n, fps, fn) => { loops[n] = fn; return { stop() {}, kick() {} }; },
        // home-screen widget (app.json "startWidget"): preview places one small and one big ("render" draws them);
        // the emulator has no home screen
        widget: live ? { ready: false, active: () => false, instances: () => [], onChange() {}, onTap() {}, set: async () => {}, image() {}, loop() {} }
            : spec.startWidget ? {
                ready: true, active: () => true, instances: () => WIDGETS, onChange() {}, onTap() {}, set: async () => {},
                loop: (fps, fn) => { hu.widgetFn = fn; },
            } : null,
    };

    hu.start = () => {
        const realLoad = Module._load;
        const run = live ? async (impl) => {
            // as mgu.js: the settings screen / sheet, the app, then its entry state opened
            try { await wireSettings(src, kitDir, spec)(ctx); } catch (e) { log.error('settings screen', e); }
            try { await impl.start(ctx); } catch (e) { log.error('app start', e); }
            log.info('initialized');
            if (!o.closed) ui.open(main);           // (closed: started in the background, as after the user left it)
            return ctx;
        } : async (impl) => impl.start(ctx);
        Module._load = function (req) {
            if (/kit[\\/]mgu$/.test(req) || req === './kit/mgu') return { run, log: ctx.log, SPEC: spec, Settings };
            return realLoad.apply(this, arguments);
        };
        require(path.join(stage, 'source', 'javascript', 'app.js'));
    };
    return hu;
}

/** mgu.js's wireSettings (the Settings button: the drawn sheet, else the HMI's screen), taken from the app's kit. */
function wireSettings(src, kitDir, spec) {
    const m = src.match(/function wireSettings[\s\S]*?\n}\n/);
    if (!m) return () => {};
    return new Function('listSheet', 'SPEC', m[0] + '\nreturn wireSettings;')(require(path.join(kitDir, 'sheet')).listSheet, spec);
}

/**
 * The RHMI as the app sees it on the car, minus the HMI's drawing: components are event emitters
 * (the kit and the emulator emit 'action' and 'focus' on them), the screens a stack (open pushes,
 * close / back pops), visibility and focus events as mgu.js's Ui raises them.
 */
// (visibility events: must match Ui._setVisible / onVisible in kit/runtime/mgu.js)
function liveUi(hu, displayOf, softImage) {
    const log = hu.log, comps = Object.create(null), vis = Object.create(null), visH = [], focusH = [];
    const comp = (n) => comps[n] || (comps[n] = Object.assign(new EventEmitter(), { name: n }));
    const stack = hu.stack = [];
    const setVis = (n, on) => {
        if (!!vis[n] === on) return;
        vis[n] = on;
        log.debug('state ' + n + (on ? ' visible' : ' hidden'));
        visH.forEach((fn) => { try { fn(n, on); } catch (e) { log.error(e); } });
    };
    const changed = () => hu.emit('screens', stack.slice());
    const ui = {
        rhmi: { getByName: comp },
        comp,
        image: (name, img) => displayOf().present(name, img, softImage),
        // the slim bar mirrors a bar button's text (as mgu.js Ui.text)
        text: async (n, t, row, cell) => { if (!row && (!cell || cell === 'Text')) displayOf().label(n, t); },
        cells: async () => {}, rows: async () => {}, selected: async () => {},
        visible: async () => {}, enabled: async () => {}, checked: async () => {},
        onClick: (n, fn) => comp(n).on('action', (ev) => {
            log.info('click ' + n);
            Promise.resolve().then(() => fn(ev || {})).catch((e) => log.error('click ' + n, e));
        }),
        // the HMI's own settings screen is not drawn here: the emulator's panel has the settings
        open: async (n) => {
            if (n === 'SETTINGS' || !(hu.spec.screens || []).some((s) => s.name === n)) { log.info('open ' + n + ': an HMI screen the emulator does not draw'); hu.emit('hmiscreen', n); return; }
            const top = stack[stack.length - 1];
            if (top === n) return;
            if (stack.indexOf(n) >= 0) stack.splice(stack.indexOf(n), 1);
            stack.push(n);
            if (top) setVis(top, false);
            setVis(n, true);
            changed();
        },
        close: async (n) => {
            const i = stack.indexOf(n);
            if (i < 0) return;
            const top = i === stack.length - 1;
            stack.splice(i, 1);
            if (top) { setVis(n, false); if (stack.length) setVis(stack[stack.length - 1], true); }
            changed();
        },
        /** HMI MENU / home: every screen of the app goes (the stack too: a tile opens the entry state again) */
        home: () => { const s = stack.splice(0); s.forEach((n) => setVis(n, false)); changed(); },
        isVisible: (n) => !!vis[n],
        onVisible: (fn) => visH.push(fn),
        hasFocus: () => true,
        onFocus: (fn) => focusH.push(fn),
        _invalidate: () => {},
        timing: { png: 0, push: 0 },
    };
    return ui;
}

/** mgu.js ctx.loop: once per renderer tick while the GPU renderer shows the screen, else about fps a second. */
// (a copy: must match ctx.loop in kit/runtime/mgu.js runInner, minus its gc and timing details)
function liveLoop(hu) {
    return (stateName, fps, fn) => {
        const { ui, display, log } = hu;
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
            if (frames % (gpuOn() ? 600 : 100) === 0) {
                log.info('loop ' + stateName + ': ' + (spent / (gpuOn() ? 600 : 100)).toFixed(1) + ' ms per frame in JS' + (gpuOn() ? ' (GPU renderer)' : ' (software, asked for ' + fps + ' fps)'));
                spent = 0;
            }
            schedule(dt);
        };
        const schedule = (dt) => {
            if (!on || timer !== null || running) return;
            // the renderer ticks when it can take the next frame; 250 ms is the safety net if none comes
            if (gpuOn()) timer = setTimeout(tick, display.gpu.waiting ? 250 : 16);
            else timer = setTimeout(tick, Math.max(15, 1000 / fps - (dt || 0)));
        };
        display.onTick(() => {
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
    };
}

/**
 * ctx.signals: watch() keeps the handlers; hu.feed(iface, field, value) calls them as a SOME/IP
 * notification would (the provider then counts as available). Methods (UDS, setters) fail.
 */
function liveSignals(hu) {
    const subs = hu.subs = {};
    const no = () => Promise.reject(new Error('emulator: no SOME/IP'));
    hu.feed = (iface, field, value, avail) => (subs[iface] || []).forEach((s) => {
        if (!s.h[field]) return;
        if (avail !== false) s.res.available = true;
        try { s.h[field](value); } catch (e) { hu.log.warn(iface + '.' + field + ': ' + e); }
    });
    return {
        watch: async (iface, inst, handlers) => {
            const res = { iface, available: false, proxy: null, error: null, shutdown: () => Promise.resolve() };
            (subs[iface] = subs[iface] || []).push({ h: handlers || {}, res });
            return res;
        },
        proxy: no, call: no, set: no, on: no, onAvailable: () => Promise.resolve(), hasNative: () => false,
        loadConfig: () => { throw new Error('emulator: no SOME/IP configs'); },
    };
}

/* ---------------- emu.js's app process ---------------- */

// README section 7; a copy: must match SCALE in kit/runtime/car.js. app.json "config.scaling" overrides, as in car.js
const SCALE = {
    rpm: { factor: 0.25, offset: 0 }, speed: { factor: 0.015625, offset: 0 }, accel: { factor: 0.002, offset: -65 },
    temp: { factor: 1, offset: -48 }, torque: { factor: 0.5, offset: -1023.5 },
};
// FrontCCU enum names (a copy: must match PUSH / DEFL in apps/doom/controls.js and TILT in kit/runtime/display.js)
const PUSH = ['KEINE_BETAETIGUNG', 'DREHGEBER_KURZ_GEDRUECKT', 'DREHGEBER_LANG_GEDRUECKT'];
const DEFL = { 0: 'MITTELSTELLUNG', 1: 'NORD_KURZ_GEDRUECKT', 4: 'OST_KURZ_GEDRUECKT', 7: 'SUED_KURZ_GEDRUECKT', 10: 'WEST_KURZ_GEDRUECKT' };

/**
 * IPC with emu.js. To it: {t:'log', l, s}, {t:'spec', spec, values}, {t:'settings', values},
 * {t:'screens', stack}, {t:'focus', id} (the HMI's focus, controller not grabbed), {t:'soft', name, png}
 * (a frame for the HMI's own image: the software path), {t:'loaded'} (the app's modules are read). From it: {t:'tap', x, y}
 * (a tap the HMI got: its bar buttons), {t:'reconnect'} (the renderer's caps changed), {t:'set', k, v}, {t:'sig', mode, v},
 * {t:'ccu', ev, grabbed}, {t:'click', id}, {t:'hmi', a: 'back'|'home'|'open', screen}.
 */
function runLive(stage, dataDir) {
    const send = (m) => { if (process.connected) process.send(m); };
    const fmt = (a) => a.map((x) => (x && x.stack) ? x.stack : (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
    const log = {};
    ['error', 'warn', 'info', 'debug'].forEach((l) => { log[l] = (...a) => { if (l !== 'debug' || process.env.MGU_DEBUG) send({ t: 'log', l, s: fmt(a) }); }; });
    console.log = log.info; console.info = log.info; console.warn = log.warn; console.error = log.error;
    fs.mkdirSync(dataDir, { recursive: true });
    // software path frames (renderer setting "software", or before the renderer is up): a few a second
    let softCv = null, softTimer = null, softT = 0;
    const flushSoft = () => {
        softTimer = null; softT = Date.now();
        const s = softCv; softCv = null;
        try { send({ t: 'soft', name: s.name, png: (Buffer.isBuffer(s.cv) ? s.cv : s.cv.png()).toString('base64') }); } catch (e) { log.warn('soft image: ' + e); }
    };
    const hu = headUnit(stage, {
        live: true, dataDir, log, closed: process.env.MGU_EMU_CLOSED === '1',
        image: (name, cv) => { softCv = { name, cv }; if (!softTimer) softTimer = setTimeout(flushSoft, Math.max(0, softT + 250 - Date.now())); return Promise.resolve(); },
    });
    const { spec, settings, ui } = hu;
    const values = () => Object.assign({}, settings.values);
    settings.onChange(() => send({ t: 'settings', values: values() }));
    hu.on('screens', (stack) => { send({ t: 'screens', stack }); focus(null); });
    hu.on('hmiscreen', (n) => send({ t: 'note', s: n === 'SETTINGS' ? 'The HMI\'s own settings screen opens here on the car: the panel has the settings.' : 'The HMI screen ' + n + ' is not drawn here.' }));
    send({ t: 'spec', spec: { id: spec.id, title: spec.title, version: spec.version, settings: spec.settings || [], screens: spec.screens || [] }, values: values() });

    // the HMI's focus over the shown screen's buttons, for the controller while the app does not hold it
    let focused = null;
    const focusables = () => {
        const sc = (spec.screens || []).find((s) => s.name === hu.stack[hu.stack.length - 1]);
        if (!sc) return [];
        return sc.kind === 'canvas' ? (sc.buttons || []).map((b) => b[0]) : (sc.items || []).filter((i) => i[0] === 'button').map((i) => i[1]);
    };
    const focus = (id) => {
        if (id === focused) return;
        if (focused) ui.comp(focused).emit('focus', { value: false });
        focused = id;
        if (id) ui.comp(id).emit('focus', { value: true });
        send({ t: 'focus', id });
    };
    const ccuLast = { k: 0, pb: 0, df: 0 };
    const hmiCcu = (ev) => {
        const k = ev.frontRotaryEncoderOperation, d = ((k - ccuLast.k + 32768) & 0xffff) - 32768;
        const pressed = ev.pb && !ccuLast.pb, tilt = ev.df && ev.df !== ccuLast.df ? ev.df : 0;
        Object.assign(ccuLast, { k, pb: ev.pb, df: ev.df });
        const f = focusables();
        if (d && f.length) { const i = f.indexOf(focused); focus(f[Math.max(0, Math.min(f.length - 1, i < 0 ? 0 : i + d))]); }
        if (pressed && focused && f.indexOf(focused) >= 0) ui.comp(focused).emit('action', {});
        if (tilt === 10) back();
    };
    const back = () => { const top = hu.stack[hu.stack.length - 1]; if (top) ui.close(top); };
    // a tap the renderer did not route to the app (no touch routing, or outside its claims): the HMI's own bar buttons
    // are under the kit's slim bar (display.js HMI.btn, barOff, barTop), so one under the tap is pressed, as the HMI does
    const { HMI } = require(path.join(hu.kitDir, 'display'));
    const hmiTap = (x, y) => {
        const d = hu.display, sc = d.screen;
        if (!sc || hu.stack[hu.stack.length - 1] !== sc.name || d.hmiBarHidden || y < HMI.barTop + 4) return;
        const b = d.buttons().find((q) => x >= q.x - d.barOff && x < q.x - d.barOff + q.w);
        if (b) { log.info('HMI: ' + b.id + ' tapped'); ui.comp(b.id).emit('action', {}); }
    };
    // the renderer's caps changed (touch routing): connect again now, as after the car's renderer restarted (the app
    // keeps its state; RenderClient's own retry would take 3 s)
    const reconnect = () => {
        const g = hu.display.gpu;
        if (!g || !g.sock) return;
        g.sock.once('close', () => setImmediate(() => {
            if (g.retry) { clearTimeout(g.retry); g.retry = null; }
            if (!g.closed && !g.sock) g.connect();
        }));
        g.sock.destroy();
    };

    // manual signals: raw values (README section 7) through the stub, 20 a second as the car sends them
    const S = Object.assign({}, SCALE, (spec.config && spec.config.scaling) || {});
    const raw = (k, v) => Math.round((v - (S[k].offset || 0)) / S[k].factor);
    let manual = null;
    setInterval(() => {
        const v = manual;
        if (!v) return;
        const gear = v.gear === 'P' || v.gear === 'N' ? 'N_OR_P' : v.gear === 'R' ? 'R' : 'G' + String(v.gear).replace(/^D/, '');
        hu.feed('de.bmw.infotainment.vehicle.CDS', 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: raw('rpm', v.rpm) });
        hu.feed('de.bmw.infotainment.vehicle.Vehicle2', 'statusCarSpeed2', { speedVehicleCentreOfGravity: raw('speed', v.speed) });
        hu.feed('de.bmw.infotainment.vehicle.CDS2', 'statusLongitudinalAccelerationMassCenter', { longitudinalAccelerationCentreOfGravity: raw('accel', v.gLong * 9.80665) });
        hu.feed('de.bmw.infotainment.vehicle.CDS2', 'statusLateralAccelerationMassCenter', { lateralAccelerationCentreOfGravity: raw('accel', v.gLat * 9.80665) });
        hu.feed('de.bmw.infotainment.vehicle.CDS', 'statusEngineTemperature', { temperatureEngineDrive: raw('temp', v.coolant), temperatureEngineOilDrive: raw('temp', v.oil) });
        hu.feed('de.bmw.infrastructure.VehicleInformation', 'statusGearboxDrive', { statusActualGearDrive: gear, statusActualStageDrive: /^D/.test(v.gear) ? 'D' : v.gear });
        hu.feed('de.bmw.infotainment.drivingexcitement.FES', 'statusActualValueTorque2', { actualValueTorqueCrankshaft: raw('torque', v.torque) });
    }, 50);

    process.on('message', (m) => {
        if (m.t === 'set') settings.set(m.k, m.v);
        else if (m.t === 'sig') {
            manual = m.mode === 'manual' ? m.v : null;
            const want = m.mode === 'manual' ? 'auto' : 'on';
            if (settings.get('demo') !== want) settings.set('demo', want);
        } else if (m.t === 'ccu') {
            const e = m.ev;
            // FrontCCU as the SDK hands it over (enums by name); the HMI acts on it unless the app holds the controller
            hu.feed('de.bmw.infotainment.controlelements.FrontCCU', 'statusRotaryEncoderState', {
                frontSequenceNumberOperatingElement: e.seq, frontRotaryEncoderOperation: e.knob,
                frontRotaryEncoderPushButton: PUSH[e.pb] || 'KEINE_BETAETIGUNG', frontRotaryEncoderDeflection: DEFL[e.df] || 'MITTELSTELLUNG',
            }, false);
            if (!m.grabbed) hmiCcu({ frontRotaryEncoderOperation: e.knob, pb: e.pb, df: e.df });
        } else if (m.t === 'click') ui.comp(m.id).emit('action', {});
        else if (m.t === 'tap') hmiTap(Number(m.x), Number(m.y));
        else if (m.t === 'reconnect') reconnect();
        else if (m.t === 'hmi') {
            if (m.a === 'back') back();
            else if (m.a === 'home') ui.home();
            else if (m.a === 'open') ui.open(m.screen || hu.stack[hu.stack.length - 1] || (spec.screens[0] || {}).name);
        }
    });
    process.on('disconnect', () => process.exit(0));
    hu.start();
    send({ t: 'loaded' });              // the app's modules are read: dist/ may be rebuilt now
}

if (require.main === module) runLive(path.resolve(process.argv[2]), path.resolve(process.argv[3]));

module.exports = { headUnit };
