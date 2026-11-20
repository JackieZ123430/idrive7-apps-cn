'use strict';
/**
 * Part of Redline's experimental features; README.md in this folder has the whole picture.
 *
 * Navigation probe: read-only. It records what BMW's guidance service and the CarPlay /
 * Android Auto managers send while a route runs, so Redline's own HUD directions can be built on what this car
 * really gives. It also hands every value to nav.js (the tap), which
 * decodes the next turn and the lanes for Redline's own directions on the HUD. The interfaces are the ones jaimeen77's Cluster Redline
 * reads (jaimeen77-cmyk/apps, MPL-2.0; only the interface names are taken from it, the code here is Redline's).
 *
 * Written to its own file, redline-nav.log beside redline.log, so a long route can't push the HUD's lines out of
 * redline.log; at most 2 x 256 KiB (the full file is renamed to .1 over the older one), and only while the HUD
 * shows directions (opts.onGlass, and 10 s after). Lines:
 *   nav: <source> <field> = <json>      every change of a field; the same thing nearer (only distances and
 *                                       times to the turn or destination changed) at most every 5 s
 *   nav: shape <kind>: <key paths>      once per kind of manoeuvre: every key it has
 * Lanes: Guidance.currentLaneGuiding and ProjectedModeGuiding.currentLaneGuiding (rows of lanes: the arrow to follow,
 * the other arrows, highlighted, bus / HOV / toll, markers, the recommended lane, the car's lane). Road names
 * (currentRoad) are not read, and the turns' descriptions (street names) are logged as their length only, so a log
 * shared doesn't say where the car drove.
 *   nav: <source> available | not available | error ...
 * Keys that look like coordinates are dropped. Never throws: everything is caught and logged.
 */
const fs = require('fs');
// the same "is a route running" as the directions use
const { routingOf, mono } = require('./nav');
const path = require('path');

const SOURCES = [
    { name: 'guidance', iface: 'de.bmw.infotainment.navigation.guiding.Guidance', inst: 'Main_Instance',
        fields: ['guidanceState', 'guidingProvider', 'conclusiveDart', 'currentLaneGuiding', 'nextIntersection'] },
    // where CarPlay / Android Auto hand BMW their lanes (read only; the car's catalog has a getter and a notifier)
    { name: 'phone', iface: 'de.bmw.infotainment.navigation.projectedmodeguiding.ProjectedModeGuiding', inst: 'Main_Instance',
        fields: ['currentLaneGuiding'] },
    { name: 'carplay', iface: 'de.bmw.infotainment.a4a.carplay.CarPlayManager', inst: 'CarPlayManagerInst1',
        fields: ['projectedGuidanceActive', 'projectedGuidanceMetadataAvailable'] },
    { name: 'androidauto', iface: 'de.bmw.infotainment.sdi.aap.androidautoprojectedmanager.AndroidAutoProjectedManager', inst: 'AndroidAutoProjectedManagerInst1',
        fields: ['projectedGuidanceActive', 'projectedGuidanceMetadataAvailable'] },
];
const MAX_BYTES = 256 * 1024, LINE = 3000, DIST_MS = 5000, GLASS_GRACE_MS = 10000;
/*
 * Phone navigation: CarPlay hands BMW its turns (ProjectedModeGuiding.updateEventsOnRoute) and they don't reach
 * Guidance.conclusiveDart (2026-11-09 drive: provider CAR_PLAY, conclusiveDart still empty). BMW lists them in
 * GuidanceEventList, read with queryContent (service 64283 v5, instance 128, method 4 in the car's catalog): the
 * events from the car's position on, turns and lanes included. Asked every second while a route runs.
 */
const EVENT_LIST = { iface: 'de.bmw.infotainment.navigation.guiding.GuidanceEventList', inst: 'Main_Instance', method: 'queryContent' };
// once a second: nav.js shows a turn for STALE_MS after its last reply. One failed call is tried again on the
// next tick (a 2 s wait after it would outlast the turn); two in a row wait CALL_BACKOFF_MS; FAILS_RECONNECT in
// a row drop the connection, made again after PROXY_RETRY_MS (a provider gone for good holds the shared queue)
const QUERY_MS = 1000, PROXY_RETRY_MS = 30000, CALL_BACKOFF_MS = 2000, FAILS_RECONNECT = 5;
/** The request: one view from the car's position (CCP), six events, turns, lanes, keep-left/right and destinations. */
function eventQuery() {
    return { viewConfigs: [{
        viewport: { startPoint: { anchorPoint: { standardReferencePoint: 'CCP' }, offsets: [] }, maxElementCount: 6, endPoints: [],
            includedTypes: ['INCLUDE_ACTIVE_MANEUVERS', 'INCLUDE_LANE_GUIDINGS', 'INCLUDE_ALONG_MAIN_ROAD', 'INCLUDE_DESTINATIONS'] },
        options: [], minimumUpdateIntervalMs: 1000, segmentItemRasterLength: 100,
    }] };
}
const COORD = /^(lat|lon|lng|latitude|longitude|wgs84|geo|coordinate|coordinates|position2d|geoPosition)$/i;

/** value without coordinate-like keys, functions or huge arrays. */
function clean(v, depth) {
    if (depth > 12) return '…';
    if (Array.isArray(v)) return v.slice(0, 40).map((x) => clean(x, depth + 1));
    if (v && typeof v === 'object') {
        const o = {};
        Object.keys(v).forEach((k) => {
            if (COORD.test(k) || typeof v[k] === 'function') return;
            // street and place names (a turn's description): only their length, so a log shared doesn't say where the car was
            if (k === 'text' && typeof v[k] === 'string') { o[k] = '<' + v[k].length + ' chars>'; return; }
            o[k] = clean(v[k], depth + 1);
        });
        return o;
    }
    if (typeof v === 'number' && !isFinite(v)) return String(v);
    return v;
}
/** Every key path in v (arrays as []), for the shape lines. */
function paths(v, pre, out) {
    if (Array.isArray(v)) { if (v.length) paths(v[0], pre + '[]', out); else out.push(pre + '[]'); return out; }
    if (v && typeof v === 'object') { Object.keys(v).forEach((k) => paths(v[k], pre ? pre + '.' + k : k, out)); return out; }
    out.push(pre);
    return out;
}
const json = (v, max) => { try { const s = JSON.stringify(clean(v, 0)), n = max || LINE; return s.length > n ? s.slice(0, n) + '…(' + s.length + ' chars)' : s; } catch (e) { return '"(' + e + ')"'; } };
/** The manoeuvre's kind (the union's one key), and the value with its distance taken out (to tell a new turn from a nearer one). */
function kindOf(dart) {
    const m = dart && typeof dart === 'object' ? dart.maneuver : null;
    const k = m && typeof m === 'object' ? Object.keys(m).filter((x) => m[x] !== undefined && m[x] !== null) : [];
    return k.length === 1 ? k[0] : k.length ? k.join('+') : 'none';
}
// what changes every second while the car drives towards the same turn (distances, times, progress)
const MOVING = { formattedDistance: 1, rawDistance: 1, distance: 1, timeStamp: 1, distanceToDestination: 1, travelTime: 1,
    timeToDestination: 1, remainingTime: 1, length: 1, bargraphProgress: 1, currentDistances: 1 };
function withoutDistance(v) {
    return JSON.stringify(v, (k, x) => (MOVING[k] ? undefined : x));
}

/**
 * start(ctx, log, tap): watches the sources; returns { stop(), status(), write(line) } (status: one short line,
 * for later use on the screen; write: a line of nav.js's in the same file). log: Redline's log, for one line at start
 * and errors. tap(source, field, value): every value as it comes, before the log's own filtering (nav.js);
 * tap('events', 'reply', reply) for each queryContent reply, tap('events', 'error', message) for each failure.
 */
function start(ctx, log, tap, opts) {
    // asked only while wanted (main.js: the HUD on and its directions on); the subscriptions themselves are passive
    const wanted = opts && typeof opts.wanted === 'function' ? opts.wanted : () => true;
    // whether a route runs: the directions' own answer when given (it ends a route the provider alone keeps open)
    const routingNow = opts && typeof opts.routing === 'function' ? opts.routing : () => routingOf(route);
    // directions on the glass now (hud.js); without it (the tests), whenever wanted
    const onGlass = opts && typeof opts.onGlass === 'function' ? opts.onGlass : null;
    const file = path.join(ctx.dataDir || '.', 'redline-nav.log');
    // written only while the HUD shows directions (and GLASS_GRACE_MS after): giving way to BMW's card, hidden in
    // Comfort, paused, or no renderer, nothing goes to flash (the values still reach the directions through tap)
    let glassAt = -Infinity;
    const writing = () => {
        if (!wanted()) return false;
        if (!onGlass) return true;
        let on = false;
        try { on = !!onGlass(); } catch (e) { /* no */ }
        if (on) glassAt = mono();
        return mono() - glassAt < GLASS_GRACE_MS;
    };
    // true only when the line was written (callers mark once-only state then, so a line dropped off the glass is retried)
    const write = (msg) => {
        try {
            if (!writing()) return false;
            const st = fs.existsSync(file) ? fs.statSync(file) : null;
            if (st && st.size > MAX_BYTES) fs.renameSync(file, file + '.1');
            fs.appendFileSync(file, new Date().toISOString() + ' nav: ' + msg + '\n');
            return true;
        } catch (e) { /* the log is best effort */ }
        return false;
    };
    const last = {}, shapes = {}, subs = [];
    const lastDist = {};
    // is a route running? (BMW's own, or the phone's)
    const route = { state: null, provider: null, carplay: false, aa: false };
    const routing = () => { try { return routingNow(); } catch (e) { return false; } };
    const tapped = (src, field, v, askedAt) => { if (tap) { try { tap(src, field, v, askedAt); } catch (e) { write('tap error: ' + e); } } };
    const got = (src, field, v) => {
        tapped(src, field, v);
        try {
            const key = src + '.' + field;
            if (src === 'guidance' && field === 'guidanceState') route.state = v;
            if (src === 'guidance' && field === 'guidingProvider') route.provider = v;
            if (field === 'projectedGuidanceActive') route[src === 'carplay' ? 'carplay' : 'aa'] = v === true;
            if (field === 'conclusiveDart') {
                const kind = kindOf(v);
                if (!shapes[kind] && write('shape ' + kind + ': ' + paths(clean(v, 0), '', []).join(' '))) shapes[kind] = true;
            }
            const s = json(v);
            if (last[key] === s) return;
            // the same thing getting nearer (a turn, the lanes): at most every DIST_MS per field
            const core = withoutDistance(v);
            if (last[key + ':core'] === core && mono() - (lastDist[key] || -Infinity) < DIST_MS) return;
            // marked only once written (off the glass the same value is tried again)
            if (write(src + ' ' + field + ' = ' + s)) { last[key + ':core'] = core; lastDist[key] = mono(); last[key] = s; }
        } catch (e) { write('error reading ' + src + '.' + field + ': ' + e); }
    };
    if (!ctx.signals || !ctx.signals.watch) { write('no signals here (preview)'); return { stop() {}, write: write }; }
    write('probe started (' + new Date().toISOString() + ')');
    if (log) log.info('nav: probe on, writing redline-nav.log');
    SOURCES.forEach((S) => {
        const handlers = {};
        S.fields.forEach((f) => { handlers[f] = (v) => got(S.name, f, v); });
        Promise.resolve().then(() => ctx.signals.watch(S.iface, S.inst, handlers, null)).then((res) => {
            subs.push(res);
            if (res.error) { write(S.name + ' not here: ' + String(res.error).slice(0, 200)); return; }
            write(S.name + ' connected' + (res.available ? ', available' : ', waiting for the provider'));
            // availability changes, logged
            // availability changes, logged and handed on (a source gone takes its route flags with it)
            let was = res.available;
            if (!was) tapped(S.name, 'available', false);
            const t = setInterval(() => { if (res.available !== was) { was = res.available; write(S.name + (was ? ' available' : ' not available')); tapped(S.name, 'available', was); } }, 2000);
            if (t.unref) t.unref();
            res.timer = t;
        }).catch((e) => write(S.name + ' error: ' + e));
    });
    // the event list, asked while a route runs; each new reply logged (the same events nearer: at most every 5 s)
    // a failed connection is tried again after PROXY_RETRY_MS (once at start-up would turn directions off for good);
    // after a failed call the next waits CALL_BACKOFF_MS (a provider that doesn't answer holds the shared native queue)
    let elProxy = null, proxyFailedAt = -Infinity, callFailedAt = -Infinity, callFails = 0, asking = false, lastEl = '', lastElCore = '', lastElAt = -Infinity, elErr = '';
    const ask = () => {
        const now = mono();
        if (asking || !routing() || !wanted() || !ctx.signals.proxy || !ctx.signals.call) return;
        if (callFails >= 2 && now - callFailedAt < CALL_BACKOFF_MS) return;
        if (!elProxy && now - proxyFailedAt < PROXY_RETRY_MS) return;
        asking = true;
        const askedAt = now;
        Promise.resolve().then(() => {
            if (elProxy) return elProxy;
            return ctx.signals.proxy(EVENT_LIST.iface, EVENT_LIST.inst).then((p) => { elProxy = p; write('events connected'); return p; },
                (e) => { proxyFailedAt = mono(); throw e; });
        }).then((p) => ctx.signals.call(p, EVENT_LIST.method, eventQuery(), 900)).then((reply) => {
            elErr = ''; callFails = 0;
            tapped('events', 'reply', reply, askedAt);
            const views = reply && reply.viewContent, events = views && views[0] && views[0].eventsInView;
            if (Array.isArray(events)) events.forEach((e) => {
                const k = kindOf({ maneuver: e && (e.maneuver || e) });
                if (!shapes['event ' + k] && write('shape event ' + k + ': ' + paths(clean(e, 0), '', []).join(' '))) shapes['event ' + k] = true;
            });
            const s = json(reply, 8000), core = withoutDistance(reply);
            if (s === lastEl) return;
            if (core === lastElCore && mono() - lastElAt < DIST_MS) return;
            if (write('events = ' + s)) { lastEl = s; lastElCore = core; lastElAt = mono(); }
        }).catch((e) => {
            const m = String(e && e.message || e).slice(0, 200);
            if (elProxy) {
                callFailedAt = mono();
                // failing again and again: drop the connection, made again after PROXY_RETRY_MS
                if (++callFails >= FAILS_RECONNECT) { elProxy = null; callFails = 0; proxyFailedAt = mono(); }
            }
            tapped('events', 'error', m);
            if (m !== elErr && write('events error: ' + m)) elErr = m;
        }).then(() => { asking = false; });
    };
    const elTimer = setInterval(ask, QUERY_MS);
    if (elTimer.unref) elTimer.unref();
    return {
        stop() { clearInterval(elTimer); subs.forEach((s) => { try { if (s.timer) clearInterval(s.timer); s.shutdown(); } catch (e) { /* gone */ } }); },
        write: write,
    };
}

module.exports = { start };
