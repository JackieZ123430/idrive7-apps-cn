'use strict';
/**
 * Live Data - live values from the car and its control units, and nothing but reading.
 *
 * Pages (header tabs):
 *   Gauges   screens of your own (screens.js): a layout of dials, sport-display bars and big numbers,
 *            each showing one value. A gauge tapped or pressed opens a sheet (picker.js): a group (car
 *            signals, the trip computer, the engine unit), then its value; the layout and the screen's
 *            removal there too. A new install starts with two (screens.js DEFAULTS), up to 6; the next
 *            one starts on the page after the last. data/screens.json. The one Settings names is the
 *            home-screen widget.
 *   Trips    the trip computer (trips.js): every drive from engine start until the engine has been off for
 *            10 minutes, counted in the background from what the car sends - distance, fuel, time, cost
 *            (litres x the fuel price); this trip, the last 5, today, 7 / 30 days, all recorded, in
 *            data/trips.json (a few kB that never grow). Its values are gauge values too.
 *   Signals  what the car sends the head unit on its own over SOME/IP (signals.js: rpm, torque, tank,
 *            range, board computer, speed, gear, accelerations, tyres ...): no request to any unit, as fast
 *            as the car sends them. Subscribed while shown (and in the background for the trip computer).
 *   Energy   12 V battery and charging, and (when found) the 48 V battery and DC/DC converter.
 *   Engine   the engine unit's values worth a look, in groups (useful.js: temperatures, oil, fuel, boost,
 *            ignition, VANOS, mixture and wear), each from the first identifier the car answers.
 *   Units    "Scan units" asks all control units at once for their SGBD index (UDS 22 F1 50), which names
 *            each unit's type; a unit's page has its standard identification (std.js), the engine unit's
 *            the OBD-II data it supports, and every identifier its catalog lists except the curated
 *            battery/converter values reserved for Energy. "Read all" keeps what answered in data/scan-<address>.json.
 *   Widget   the home-screen widget (app.json startWidget): the big one a picture of that screen's gauges,
 *            redrawn up to "Widget redraws" a second, as far from the edges as "Widget picture" says (the
 *            HMI enlarges it, crops and fades its edges); the small one its values as text lines.
 *
 * Catalogs: the decoding of a unit type's identifiers (kit/sgbd.js format). builtin/ (in git) holds the
 * engine unit's that the Engine page uses and the SGBD index; a full one made with
 * kit/tools/sgbd_catalog.py (catalog/, not in git: BMW's tables) adds every identifier of its type.
 *
 * Where the kit runs the screen (mgu-render, full-screen layout) lists scroll, a finger or the controller
 * moves them, and the sheets are drawn over the page; elsewhere lists are paged and "Browse" gives the knob
 * the same jobs. Settings > "Show sources and unverified values" adds what a developer wants to see: the
 * identifier or signal each value comes from, signals whose scaling isn't known yet (raw numbers) and the
 * replies the units refused.
 *
 * Read-only by construction: the link (kit/readonly-diag.js) refuses every service but 22 and OBD
 * 01 / 09, one request at a time (at least 25 ms apart, the same whether the car moves or not), and this app
 * sends nothing while neither its screen nor its widget is shown (for the widget: only its values, more
 * slowly) - but the engine unit's fuel figure, once a second while the engine runs, for the trip computer
 * until the fuel signal's own scaling is learned. Values on screen from one unit go up to 8 in one request
 * (22 <DID> <DID> ...) once a request of its own showed how long each one's reply is.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { ScaledCanvas, withAlpha } = require('./kit/canvas');
const { Recorder, play } = require('./kit/record');
const { fitText } = require('./kit/text-layout');
const { ReadOnlyDiag, MAX_DIDS } = require('./kit/readonly-diag');
const { hex, NRC } = require('./kit/diag');
const { decode, format, split, SIZE } = require('./kit/sgbd');
const { ECU } = require('./kit/ecus');
const pack = require('./kit/pack');
const STD = require('./std');
const USEFUL = require('./useful');
const SIG = require('./signals');
const SCR = require('./screens');
const TRIPS = require('./trips');
const DEMO = require('./demo');
const PICK = require('./picker');
const PAGES = require('./pages');
const { t: translate, plural } = require('./kit/i18n');
const Sim = require('./kit/sim');
const TwinDme = require('./kit/twin_dme');

const W = 1600, H = 520, COLS = 5, CARDS = 30, ROWS = PAGES.ROWS, ROW_H = PAGES.ROW_H;
const GO = '#2fd27a';
const IDLE_MS = 30000;            // browsing: back to the buttons after this long untouched
// a full catalog made here first (catalog/), else the built-in one (builtin/); file by file
const LOCAL = pack.open(path.join(__dirname, 'catalog')), BUILTIN = pack.open(path.join(__dirname, 'builtin'));
const CAT = {
    has: (rel) => LOCAL.has(rel) || BUILTIN.has(rel),
    json: (rel) => (LOCAL.has(rel) ? LOCAL : BUILTIN).json(rel),
    get: (rel, key) => (LOCAL.has(rel) ? LOCAL : BUILTIN).get(rel, key),
};
const INDEX = CAT.json('sgbd_index.json');
// a unit type without a catalog of its own uses its family's; every value is still asked on the car
// (0x13: the second engine unit of a V8, DME8FF_L / DME98_L: the same identifiers as its master's, kit/twin_dme.js;
// only for a V8's index)
const CLOSEST = { 0x12: 'DME8FF_R', 0x13: 'DME8FF_R' };
const ABSENT = [0x11, 0x12, 0x31];   // NRCs that mean "this unit has no such value"

// the baked fonts are ASCII + a few signs: German letters spelled out
const ascii = (s) => String(s).replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/Ä/g, 'Ae')
    .replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss').replace(/µ/g, 'u').replace(/[^\x20-\x7e°²³±·]/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return dflt; } };
const hexs = (b) => Array.prototype.map.call(b, (x) => hex(x)).join(' ');
const need = (e) => e.f.reduce((m, f) => Math.max(m, f.at + (f.len || SIZE[f.t] || 1)), 0);
/** a value in the unit a Useful entry asks for: { n, u } (unit unchanged when there's no conversion) */
function convert(n, from, to) {
    if (!to || !from || from === to) return { n, u: to || from };
    const k = USEFUL.CONVERT[from] && USEFUL.CONVERT[from][to];
    return k ? { n: n * k, u: to } : { n, u: from };
}

/** a catalog by SGBD name: { sgbd, dids, meta, builtin } or null */
const catalogs = {};
function catalog(sgbd) {
    if (!sgbd) return null;
    if (catalogs[sgbd] !== undefined) return catalogs[sgbd];
    let c = null;
    if (CAT.has(sgbd + '.json')) {
        const dids = CAT.json(sgbd + '.json'), meta = CAT.json(sgbd + '.meta.json');
        if (meta && meta.order) c = { sgbd, dids, meta, builtin: !!meta.builtin };
    }
    catalogs[sgbd] = c;
    return c;
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const link = new ReadOnlyDiag(ctx.signals, log);
        link.init().catch((e) => log.warn('diagnostic link: ' + e));
        const useDemo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !link.available);
        const details = () => !!settings.get('details');
        // temperatures are read and kept in °C; shown in °F when Settings says so
        const fahrenheit = () => settings.get('tempUnit') === 'f';
        const shownUnit = (u) => (u === '°C' && fahrenheit() ? '°F' : u);
        const shownTemp = (v) => (v && typeof v.n === 'number' && v.u === '°C' && fahrenheit() ? Object.assign({}, v, { n: v.n * 1.8 + 32, u: '°F' }) : v);
        const formatShown = (x, f) => (x && !x.why && typeof x.value === 'number' && f && f.u === '°C' && fahrenheit()
            ? format(Object.assign({}, x, { value: x.value * 1.8 + 32, text: undefined }), Object.assign({}, f, { u: '°F' })) : format(x, f));

        /* ---------- state ---------- */
        const UNITS_FILE = path.join(ctx.dataDir, 'units.json');
        const scanFile = (u) => path.join(ctx.dataDir, 'scan-' + hex(u.addr) + '.json');
        let units = [];               // [{ addr, index, variant, sgbd, closest, res: { key: result }, ver }]
        let demoUnits = false, phase = 'idle', msg = '', busy = false, version = 0, layoutVer = 0, readCount = 0, refusedCount = 0;
        let sweep = null;             // Read all: { u, rows, i, at }
        const changed = () => { version++; if (loop) loop.kick(); };
        // the car signals' page, as a "unit" for the lists
        const SIGU = { sig: true, addr: 'sig', ver: 0, view: null };
        const relayout = () => { layoutVer++; units.forEach((u) => { u.view = null; u.eview = null; }); if (soloDme) soloDme.eview = null; if (soloSlave) soloSlave.view = null; SIGU.view = null; changed(); };

        function makeUnit(addr, index, demo) {
            const variant = index ? INDEX[hex(addr) + ' ' + index] || null : null;
            let sgbd = variant && catalog(variant) ? variant : null, closest = false;
            const near = CLOSEST[addr] && (addr !== 0x13 || !index || TwinDme.isTwinIndex(index));
            if (!sgbd && near && catalog(CLOSEST[addr])) { sgbd = CLOSEST[addr]; closest = true; }
            const u = { addr, index, variant, sgbd, closest, demo, res: {}, ver: 0, rows: null, energyRows: null, view: null, obd: null };
            // what an earlier Read all found (values from then, until read again)
            const old = readJson(scanFile(u), null);
            if (old && old.index === index && !!old.demo === !!demo && old.res) u.res = old.res;
            if (old && old.obd) u.obd = old.obd;
            return u;
        }
        (function restore() {
            const saved = readJson(UNITS_FILE, null);
            if (!saved || !saved.units) return;
            demoUnits = !!saved.demo;
            units = saved.units.map((s) => makeUnit(s.addr, s.index, demoUnits));
        })();
        const unitName = (u) => ECU[u.addr] || u.variant || 'ECU 0x' + hex(u.addr);
        // the engine unit (0x12) is there on every car this is for: its values are read with or without a scan
        let soloDme = null, soloSlave = null;       // the engine unit without a scan; a twin-unit engine's second one
        function engineUnit() {
            const u = units.find((x) => x.addr === 0x12);
            if (u) return u;
            const demo = useDemo();
            if (!soloDme || !!soloDme.demo !== demo) { soloDme = makeUnit(0x12, null, demo); layoutVer++; }
            return soloDme;
        }
        /*
         * A V8 with two engine units (kit/twin_dme.js): the master's SGBD index says so (asked once, the answer
         * kept), or a scan found a V8's second unit (0x13, with a V8's index). Its bank's
         * values then come from the second unit:
         * on the Engine page under "Bank 2", and for gauges. Never on demo data (the demo car is a B58).
         */
        const twin = new TwinDme(link, { dataDir: ctx.dataDir, log });
        let twinSeen = null;
        const isTwin = () => twin.twin === true || units.some((u) => u.addr === 0x13 && !u.demo && TwinDme.isTwinIndex(u.index));
        /** the twin state (or its cylinders per bank) changed: the Useful lists (what each unit lists) and the pages again */
        function twinCheck() {
            const now = isTwin() + ':' + twin.perBank;
            if (now === twinSeen) return;
            twinSeen = now;
            units.concat(soloDme ? [soloDme] : [], soloSlave ? [soloSlave] : []).forEach((u) => { u.useful = undefined; });
            relayout();
        }
        let slaveWokenT = 0;
        setInterval(() => {
            try {
                if (!useDemo() && link.available) twin.detect().then(twinCheck, () => {});
                twinCheck();
                // the second unit without a scan, given up on after misses in a row (asleep while the ignition came
                // on): asked again every 30 s, as a scan would (the master's own unit is woken by a scan)
                if (soloSlave && soloSlave.silent && Date.now() - slaveWokenT > 30000) { slaveWokenT = Date.now(); soloSlave.silent = false; link.wake(0x13); changed(); }
            } catch (e) { log.warn('engine units: ' + e); }
        }, 5000);
        /** the second engine unit (0x13) of a twin-unit engine, scanned or not; null on any other car and on demo data */
        function slaveUnit() {
            if (!isTwin() || useDemo()) return null;
            const u = units.find((x) => x.addr === 0x13);
            if (u) return u.demo ? null : u;
            if (!soloSlave) { soloSlave = makeUnit(0x13, null, false); layoutVer++; }
            return soloSlave;
        }
        /*
         * A Useful entry's name as shown: on a twin-unit engine the values each unit has for its own bank (those in
         * USEFUL.BANK2 but its cylinders') are "Bank 1: ..." on the master and "Bank 2: ..." on the second unit.
         */
        const PER_BANK = USEFUL.BANK2(4).reduce((m, g) => { g.items.forEach((i) => { if (!/, cylinder \d+$/.test(i.name)) m[i.name] = 1; }); return m; }, {});
        const bankName = (u, item) => (!u || !PER_BANK[item.name] || !isTwin() ? item.name
            : u.addr === 0x13 ? 'Bank 2: ' + item.name : u.addr === 0x12 ? 'Bank 1: ' + item.name : item.name);
        const unitAt = (addr) => (addr === 0x12 ? engineUnit() : addr === 0x13 ? slaveUnit() || units.find((y) => y.addr === addr) || null
            : units.find((y) => y.addr === addr) || null);

        /* ---------- values of a unit ---------- */
        // rows: one per value; key = what is asked ('F190', 'OBD 0C', '4A36'), field = which value of its reply
        function rowsOf(u, energy = false) {
            if (energy && u.energyRows) return u.energyRows;
            if (!energy && u.rows) return u.rows;
            const rows = [];
            const add = (key, e, kind) => e.f.forEach((f, i) => rows.push({ key, e, field: i, kind }));
            Object.keys(STD.IDENT).forEach((k) => add(k, STD.IDENT[k], 'std'));
            if (u.addr === 0x12) {
                Object.keys(STD.OBD).forEach((k) => add(k, STD.OBD[k], 'obd'));
                Object.keys(STD.INFO).forEach((k) => add(k, STD.INFO[k], 'std'));
            }
            const c = catalog(u.sgbd);
            if (c && (energy || !c.builtin || !USEFUL.bySgbd[u.sgbd])) { // curated battery catalogs are reserved for Energy
                c.meta.order.forEach((did) => {
                    const e = c.dids[did];
                    if (e.sid === undefined) { e.sid = 0x22; e.id = parseInt(did, 16); }
                    if (e.sid === 0x22 && (e.id >> 8) === 0xF1 && STD.IDENT[did]) return;     // already there
                    add(did, e, 'sgbd');
                });
            }
            if (energy) u.energyRows = rows; else u.rows = rows;
            return rows;
        }
        const enumsOf = (u, row) => (row.kind === 'sgbd' ? catalog(u.sgbd).meta.enums : STD.ENUMS);
        // what a result means for the lists: ok / absent (unit has no such value) / refused / silent / unread
        const state = (r) => (!r ? 'unread' : r.ok ? 'ok' : r.nrc !== undefined ? (ABSENT.indexOf(r.nrc) >= 0 ? 'absent' : 'refused') : 'silent');
        const obdSupported = (u, row) => row.kind !== 'obd' || (u.obd && u.obd.indexOf(row.e.id) >= 0);

        function nameOf(u, row) {
            const f = row.e.f[row.field];
            if (row.kind !== 'sgbd') return f.d || row.e.d;
            const de = f.d || row.e.d, multi = row.e.f.length > 1 && !f.d;
            let s = CAT.get(u.sgbd + '.en.json', de) || de;
            if (!s || s === '-') s = f.n && f.n !== '-' ? f.n : row.e.a;
            return ascii(s) + (multi ? ' (' + (row.field + 1) + ')' : '');
        }
        const sourceOf = (row) => (row.kind === 'sgbd' ? row.key + (row.e.f.length > 1 ? '.' + (row.field + 1) : '') : row.key);

        /* ---------- Useful (useful.js): the values worth a look, in groups ---------- */
        // each entry's candidates resolved to rows of this unit; one the unit type doesn't list is left out
        function usefulOf(u) {
            if (u.useful !== undefined) return u.useful;
            // items marked only: 'twin' / 'single' (useful.js) by the engine's units; the second unit: its bank's list
            const two = isTwin();
            const groups = u.addr === 0x13 ? (two ? USEFUL.BANK2(twin.perBank) : null) : USEFUL[u.addr] || USEFUL.bySgbd[u.sgbd];
            if (!groups) return (u.useful = null);
            const fits = (item) => !item.only || (item.only === 'twin') === two;
            const index = {};
            rowsOf(u, true).forEach((row) => { index[row.key + '/' + row.field] = row; });
            const find = (c) => index[c.indexOf('/') > 0 ? c : c + '/0'];
            u.useful = groups.map((g) => ({
                group: g.group,
                items: g.items.filter(fits).map((item) => {
                    const cands = (item.c || []).map(find).filter(Boolean), parts = item.minus ? item.minus.map(find) : null;
                    return (parts ? parts.every(Boolean) : cands.length) ? { item, cands, parts } : null;
                }).filter(Boolean),
            })).filter((g) => g.items.length);
            return u.useful;
        }
        // could the unit have it? (not refused as missing, OBD PID supported or not known yet)
        const maybe = (u, row) => state(u.res[row.key]) !== 'absent' && (row.kind !== 'obd' || !u.obd || u.obd.indexOf(row.e.id) >= 0);
        /** one candidate's value for an entry: { n, u } / { text } / { bad } (no data) / { why } / { s, r } (not read, refused ...) */
        function usefulOne(u, ur, row) {
            const it = ur.item, s = state(u.res[row.key]);
            if (s !== 'ok') return { s, r: u.res[row.key] };
            const v = valuesOf(u, row), x = v && v[row.field], f = row.e.f[row.field];
            if (!x || x.why) return { why: x ? x.why : '?' };
            if (it.bad && it.bad.indexOf(x.raw) >= 0) return { bad: true };
            if (it.map && it.map[x.raw] !== undefined) return { text: it.map[x.raw] };
            if (x.text !== undefined && x.text !== '') return { text: String(x.text) };
            if (typeof x.value !== 'number') return { text: String(x.value) };
            const c = convert(x.value, f.u, it.u);
            if (c.u === '°C' && c.n < -45) return { bad: true };          // an unset temperature (-48, -273)
            if (it.lin) c.n = it.lin[0] + it.lin[1] * c.n;
            return c;
        }
        /**
         * The candidate an entry shows and asks: the first with a real value or not read yet, else the first
         * that may have one, else the first (some identifiers are refused in one state and answer in another:
         * the oil life with the engine running; it is asked again every 30 s)
         */
        function active(u, ur) {
            const m = ur.cands.filter((r) => maybe(u, r));
            return m.find((r) => { const s = state(u.res[r.key]); return s === 'unread' || (s === 'ok' && !usefulOne(u, ur, r).bad); }) || m[0] || ur.cands[0] || null;
        }
        const usefulRows = (u, ur) => (ur.parts ? ur.parts : [active(u, ur)]).filter(Boolean);
        /** a Useful entry's value: what usefulOne gives (for a "minus" entry the difference of its two) */
        function usefulRaw(u, ur) {
            if (ur.parts) {
                const a = usefulOne(u, ur, ur.parts[0]), b = usefulOne(u, ur, ur.parts[1]);
                return typeof a.n === 'number' && typeof b.n === 'number' ? { n: a.n - b.n, u: a.u } : typeof a.n === 'number' ? b : a;
            }
            return active(u, ur) ? usefulOne(u, ur, active(u, ur)) : { s: 'absent' };
        }
        const refusal = (r) => (details() ? 'refused: ' + (NRC[r.nrc] || 'NRC ' + hex(r.nrc)) : 'not available');
        /** what a Useful entry shows: { text, dim, warn } */
        function usefulValue(u, ur) {
            const it = ur.item, v = shownTemp(usefulRaw(u, ur));
            if (typeof v.n === 'number') {
                const s = v.n.toFixed(it.d == null ? 2 : it.d);
                return { text: (/^-0(\.0+)?$/.test(s) ? s.slice(1) : s) + (v.u ? ' ' + v.u : '') };       // no "-0.00"
            }
            if (v.text !== undefined) return { text: v.text };
            if (v.bad) return { text: 'no data', dim: true };
            if (v.why) return { text: v.why, dim: true };
            if (v.s === 'refused') return { text: refusal(v.r), warn: details(), dim: !details() };
            if (v.s === 'silent') return { text: 'no reply', dim: true };
            if (v.s === 'absent') return { text: 'not available now', dim: true };
            return { text: '...', dim: true };
        }
        /** where a Useful entry's value comes from: its identifier ('4402', '4205 - 4201') */
        const usefulSource = (u, ur) => (ur.parts ? ur.item.minus.join(' - ') : ((a) => (a ? a.key + (a.field ? '/' + a.field : '') : ''))(active(u, ur)));

        /** a unit's page: the rows the Show setting lets through */
        function view(u) {
            const show = settings.get('show');
            if (u.view && u.view.ver === u.ver && u.view.show === show) return u.view.rows;
            const rows = rowsOf(u).filter((row) => {
                const s = state(u.res[row.key]);
                if (show === 'answering') return s === 'ok';
                if (show === 'all') return true;
                return maybe(u, row);          // (an OBD-II value until the unit said which it has: asked, then)
            });
            u.view = { ver: u.ver, show, rows };
            return rows;
        }
        /** the Engine page: the engine unit's Useful list, those it may have; for a type without one, its OBD-II values */
        function engineView() {
            const u = engineUnit(), s2 = slaveUnit(), ver = u.ver + ':' + (s2 ? s2.addr + '.' + s2.ver : '-');
            if (u.eview && u.eview.ver === ver) return u.eview.rows;
            const rows = [], groups = usefulOf(u);
            const mayHave = (x, ur) => (ur.parts ? ur.parts.every((p) => maybe(x, p)) : ur.cands.some((r) => maybe(x, r)));
            if (groups && groups.length) {
                groups.forEach((g) => {
                    if (g.group === '12 V') return;    // shown on Energy, but remains available to gauges
                    const items = g.items.filter((ur) => mayHave(u, ur));
                    if (!items.length) return;
                    rows.push({ header: g.group });
                    items.forEach((ur) => rows.push({ useful: ur }));
                });
                // a twin-unit engine: bank 2's values from its own unit, each row with that unit
                (s2 ? usefulOf(s2) || [] : []).forEach((g) => {
                    const items = g.items.filter((ur) => mayHave(s2, ur));
                    if (!items.length) return;
                    rows.push({ header: translate('Bank 2') + ': ' + translate(g.group) });
                    items.forEach((ur) => rows.push({ unit: s2, useful: ur }));
                });
            } else {
                const obd = rowsOf(u).filter((row) => row.kind === 'obd' && maybe(u, row));
                if (obd.length) { rows.push({ header: 'OBD-II' }); obd.forEach((row) => rows.push(row)); }
            }
            u.eview = { ver, rows };
            return rows;
        }
        /** Energy: only the 12 V, 48 V battery and converter values selected in useful.js. */
        function energyView() {
            const rows = [], energyUnits = [engineUnit()].concat(
                units.filter((u) => u.addr !== 0x12 && USEFUL.bySgbd[u.sgbd])
            );
            energyUnits.forEach((u) => {
                (usefulOf(u) || []).forEach((g) => {
                    if (g.group !== '12 V' && g.group !== '48 V battery' && g.group !== '48 V / 12 V converter') return;
                    const items = g.items.filter((ur) => (ur.parts ? ur.parts.every((p) => maybe(u, p)) : ur.cands.some((r) => maybe(u, r))));
                    if (!items.length) return;
                    rows.push({ header: g.group + ' · ' + unitName(u) });
                    items.forEach((useful) => rows.push({ unit: u, useful }));
                });
            });
            if (!units.some((u) => u.sgbd === 'BATT48')) {
                rows.push({ note: true, name: '48 V battery: scan required; absence is inconclusive', text: 'Not identified' });
            }
            if (!units.some((u) => u.sgbd === 'PCU48')) {
                const unsupported = units.some((u) => u.variant === 'PCU48_2');
                rows.push({ note: true, name: unsupported ? '48 V converter: PCU48_2' : '48 V converter: scan required',
                    text: unsupported ? 'Unsupported layout' : 'Not identified' });
            }
            return rows;
        }

        /* ---------- Car signals (signals.js): what the car sends the head unit on its own ---------- */
        // no request to any control unit; subscribed the first time they are shown, each field's newest
        // struct kept as it comes ('iface field' -> { v, t }); the demo's apart from the car's
        const SIG_FILE = path.join(ctx.dataDir, 'signals.json');
        const sigLast = {}, sigDemoLast = {}, demoSt = {}, sim = new Sim();
        const flow = new SIG.Flow(readJson(SIG_FILE, {}).fuelK), demoFlow = new SIG.Flow(0.0036);
        let sigVer = 0, sigDrawn = 0, sigSubs = null, sigAny = false, learnT = 0;
        const native = () => !!(ctx.signals.hasNative && ctx.signals.hasNative());
        const sigDemo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !sigAny && !native());
        const flowNow = () => (sigDemo() ? demoFlow : flow);
        // a signal shown without details: one whose scaling is known (raw numbers only with the details)
        const sigListed = (it) => details() || !it.raw;

        function sigFeed(i, f, v, demo) {
            if (!v || typeof v !== 'object') return;
            const t = Date.now(), key = i + ' ' + f;
            if (demo) sigDemoLast[key] = { v, t };
            else {
                // the first of each field to the log: what the car really sends (enum names or numbers ...)
                if (!sigLast[key]) log.info('signal ' + SIG.short(i) + '.' + f + ': ' + JSON.stringify(v).slice(0, 400));
                sigLast[key] = { v, t }; sigAny = true;
            }
            if (f === 'statusInjectionVolume') (demo ? demoFlow : flow).feed(v.injectionVolumeFuelEngine, t);
            sigVer++;
        }
        function sigStart() {
            if (sigSubs || !native()) return;
            sigSubs = [];
            const fields = SIG.fields();
            log.info('car signals: subscribing ' + Object.keys(fields).length + ' interfaces');
            Promise.all(Object.keys(fields).map((i) => {
                const h = {};
                fields[i].forEach((f) => { h[f] = (v) => sigFeed(i, f, v, false); });
                return ctx.signals.watch(i, '1', h, log, SIG.POLL[i] ? { pollMs: SIG.POLL[i] } : undefined).then((s) => { sigSubs.push(s); return s; });
            }).concat(
                // the car's pressure unit: boost and tyre pressures come in it
                ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle', '1', {
                    statusNewCurrentUnitsStatusExt: (v) => {
                        const p = SIG.pressUnitOf(v && v.unitOfMeasurementAirPressure);
                        if (p === SIG.units.press) return;
                        SIG.units.press = p;
                        log.info('car units: pressure ' + (p || '?'));
                    },
                }, log).then((s) => { sigSubs.push(s); return s; })
            )).then((all) => log.info('car signals: ' + all.map((s) => SIG.short(s.iface) + (s.error ? ' (error: ' + s.error + ')' : '')).join(' ')));
            setTimeout(() => {
                const names = (on) => sigSubs.filter((s) => !!s.available === on).map((s) => SIG.short(s.iface)).join(' ') || 'none';
                log.info('car signals after 15 s: offered ' + names(true) + '; not offered ' + names(false));
            }, 15000);
        }

        /** a signal's value now: { n, u } / { n, raw, x } / { text, dim } / { bad } / null (nothing came) */
        function sigValue(it, depth) {
            if (it.tc) return tripItem(it.tc);
            if (it.flow) {
                const fl = flowNow(), n = fl.lph(Date.now());
                if (n !== null) return { n, u: 'l/h' };
                return fl.last ? { text: fl.k ? '...' : 'calibrating', dim: true, calib: !fl.k } : null;
            }
            if (it.calc) {
                return it.calc((id) => {
                    const x = (depth || 0) < 3 && SIG.ITEMS[id] ? sigValue(SIG.ITEMS[id], (depth || 0) + 1) : null;
                    return x && ((typeof x.n === 'number' && !x.raw) || x.calib) ? x : null;
                });
            }
            const store = sigDemo() ? sigDemoLast : sigLast;
            let best = null;
            SIG.sourcesOf(it).forEach((s) => { const x = store[s.i + ' ' + s.f]; if (x && (!best || x.t > best.x.t)) best = { s, x }; });
            return best ? SIG.value(it, best.s, best.x.v) : null;
        }
        /** what a signal shows: { text, dim } */
        function sigText(it) {
            const v = shownTemp(sigValue(it));
            if (!v) return { text: sigSubs || sigDemo() ? 'no data' : '...', dim: true };
            if (v.bad) return { text: 'no data', dim: true };
            if (v.text !== undefined) return { text: v.text, dim: !!v.dim };
            if (v.raw) return { text: v.x ? '0x' + hex(v.n, 4) : String(v.n) };
            const s = v.n.toFixed(it.d == null ? 1 : it.d);
            return { text: (/^-0(\.0+)?$/.test(s) ? s.slice(1) : s) + (v.u ? ' ' + v.u : '') };
        }
        const sigSource = (it) => (it.tc ? 'trip computer' : it.calc || it.flow ? 'calculated' : SIG.short(it.i) + '.' + it.f) + (it.q ? '  ·  scale?' : it.raw ? '  ·  raw' : '');
        /** the Signals page's rows: group headings and the signals listed */
        function sigView() {
            const d = details(), c = SIGU.view;
            if (c && c.details === d) return c.rows;
            const rows = [];
            SIG.GROUPS.forEach((g) => {
                const items = g.items.filter((it) => !it.tc && sigListed(it));
                if (!items.length) return;
                rows.push({ header: g.group });
                items.forEach((it) => rows.push({ sig: it }));
            });
            if (!c || c.rows.length !== rows.length) SIGU.ver++;
            SIGU.view = { details: d, rows };
            return rows;
        }

        /**
         * The engine unit's fuel consumption (l/h) just read - its own figure or the fuel mass - that the
         * fuel signal learns its scaling from: { u, rows, got: { lph, t } | null }; rows = what to ask it for that
         */
        const FUEL = ['Fuel consumption', 'Fuel mass flow'];
        /*
         * A twin-unit engine (kit/twin_dme.js): 5656 is each unit's own bank ("LOKAL" in the SGBD), so the master's
         * only counts with the second unit's added; the engine's total (OBD 5E) is taken as it is, and the mass flow
         * (4521, not known to be the whole engine's) not at all. Half the engine's fuel would teach the fuel signal
         * a wrong scaling for good (data/signals.json).
         */
        const LOCAL_FUEL = ['5656'];
        function dmeFuel() {
            const u = engineUnit();
            if (u.demo) return null;
            const list = [], s2 = slaveUnit();
            (usefulOf(u) || []).forEach((g) => g.items.forEach((ur) => { if (FUEL.indexOf(ur.item.name) >= 0) list.push(ur); }));
            let got = null;
            const fresh = (x, row) => { const r = row && x.res[row.key]; return r && Date.now() - r.t <= 1500 ? r : null; };
            const lph = (x, ur, row) => { const v = usefulOne(x, ur, row); return typeof v.n === 'number' ? (v.u === 'kg/h' ? v.n / 0.745 : v.n) : null; };     // petrol: 0.745 kg a litre
            // one engine unit or two not known yet (the master's SGBD index not answered): asked, but nothing learned
            const unsure = !s2 && !twin.known() && !isTwin();
            if (!s2) {
                list.forEach((ur) => {
                    const row = active(u, ur), r = fresh(u, row);
                    if (got || !r) return;
                    const v = lph(u, ur, row);
                    if (v !== null) got = { lph: v, t: r.t };
                });
                return { u, rows: list.map((ur) => active(u, ur)).filter(Boolean), got: unsure ? null : got };
            }
            const rows = [], more = [];
            const cons = list.find((ur) => ur.item.name === 'Fuel consumption');
            const ur2 = ((usefulOf(s2) || []).find((g) => g.items.some((x) => x.item.name === 'Fuel consumption')) || { items: [] })
                .items.find((x) => x.item.name === 'Fuel consumption');
            // the first source that can give the whole engine's figure, and only that one is asked
            (cons ? cons.cands : []).some((row) => {
                if (!maybe(u, row)) return false;
                if (LOCAL_FUEL.indexOf(row.key) >= 0) {
                    // bank 2's figure: the same identifier on the second unit
                    const row2 = ur2 && ur2.cands.find((x) => x.key === row.key);
                    if (!row2 || !maybe(s2, row2)) return false;
                    rows.push(row); more.push(row2);
                    const r = fresh(u, row), r2 = fresh(s2, row2);
                    const a = r && lph(u, cons, row), b = r2 && lph(s2, ur2, row2);
                    if (typeof a === 'number' && typeof b === 'number') got = { lph: a + b, t: Math.min(r.t, r2.t) };
                    return true;
                }
                rows.push(row);
                const r = fresh(u, row), v = r && lph(u, cons, row);
                if (typeof v === 'number') got = { lph: v, t: r.t };
                return true;
            });
            return { u, rows, got, more: more.length ? { u: s2, rows: more } : null };
        }
        /** something that passes test(value) is shown: on the page on screen or on the home-screen widget */
        function shownBy(test) {
            if (widgetItems().some(test)) return true;
            if (!ui.isVisible('MAIN')) return false;
            const pg = current();
            if (pg.group === 'signals') return shownRows(pg).some((r) => r.sig && test({ isSig: true, sig: r.sig }));
            return itemsOf(pg).some(test);
        }
        const fuelShown = () => shownBy((x) => !!(x.isSig && x.sig && (x.sig.flow || x.sig.id === 'instant')));
        // the signals shown: subscribed then, redrawn up to 10 times a second, the demo fed, the fuel scaling learned
        const sigShown = () => shownBy((x) => !!x.isSig);
        // (a throw here would end the app: the unit then wipes its data, and removes it the second time)
        let sigErrs = 0;
        setInterval(() => { try { sigTick(); } catch (e) { if (sigErrs++ % 600 === 0) log.warn('car signals (' + sigErrs + 'x): ' + (e && e.stack || e)); } }, 100);
        function sigTick() {
            const shown = sigShown();
            if (!shown && !tripsOn()) return;      // the trip computer: subscribed, and the fuel scaling learned, in the background
            sigStart();
            if (shown && sigDemo()) { const t = Date.now(); SIG.demo(sim.sample(t), t, demoSt).forEach((x) => sigFeed(x[0], x[1], x[2], true)); }
            const d = !sigDemo() && flow.last ? dmeFuel() : null;
            if (d && d.got && d.got.t !== learnT) {
                learnT = d.got.t;
                if (flow.learn(d.got.lph, Date.now())) {
                    log.info('fuel signal: ' + flow.rate.toFixed(1) + ' counts/s at ' + d.got.lph.toFixed(2) + ' l/h -> ' + flow.k.toPrecision(4) + ' l/h per count/s (spread ' + flow.spread.toFixed(2) + ')');
                    try { fs.writeFileSync(SIG_FILE, JSON.stringify({ at: Date.now(), fuelK: flow.k })); } catch (e) { log.warn('save signals: ' + e); }
                }
            }
            if (shown && sigVer !== sigDrawn) { sigDrawn = sigVer; changed(); }
        }
        // the raw numbers of the values whose scaling is still to be checked, every minute while shown
        setInterval(() => { try { sigLogRaw(); } catch (e) { log.warn('car signals raw: ' + e); } }, 60000);
        function sigLogRaw() {
            if (!sigAny || !sigShown()) return;
            const parts = [];
            Object.keys(SIG.ITEMS).forEach((id) => {
                const it = SIG.ITEMS[id];
                if (!it.q && !it.raw) return;
                SIG.sourcesOf(it).forEach((s) => { const x = sigLast[s.i + ' ' + s.f]; if (x && s.m && x.v[s.m] !== undefined) parts.push(id + '=' + x.v[s.m]); });
            });
            const d = flow.last ? dmeFuel() : null;
            parts.push('fuel ' + (flow.rate === null ? '-' : flow.rate.toFixed(1)) + ' counts/s, k ' + (flow.k ? flow.k.toPrecision(4) : 'not learned')
                + (d && d.got ? ', engine unit ' + d.got.lph.toFixed(2) + ' l/h' : ''));
            log.info('car signals raw: ' + parts.join(' '));
        }

        /* ---------- Trip computer (trips.js): every drive, in the background ---------- */
        // fed twice a second from what the car sends (never the demo's): speed, engine, odometer, tank and the fuel
        // flow - the fuel signal once its scaling is learned, until then the engine unit's own figure (asked once a
        // second while the engine runs). data/trips.json: at a trip's start and end, every minute during one.
        const TRIPS_FILE = path.join(ctx.dataDir, 'trips.json');
        const tc = new TRIPS.Trips(readJson(TRIPS_FILE, null));
        let tcSaved = tc.ver, tcSavedAt = 0, tcDrawn = -1, tcErrs = 0;
        const tripsOn = () => settings.get('trips') !== false;
        const currency = () => settings.get('currency') || 'EUR';
        /** a car signal as the car sent it (never the demo's), null when none came (or it is older than maxAge) */
        function realValue(id, maxAge) {
            const it = SIG.ITEMS[id];
            let best = null;
            SIG.sourcesOf(it).forEach((src) => { const x = sigLast[src.i + ' ' + src.f]; if (x && (!best || x.t > best.x.t)) best = { src, x }; });
            if (!best || (maxAge && Date.now() - best.x.t > maxAge)) return null;
            const v = SIG.value(it, best.src, best.x.v);
            return v && !v.bad ? v : null;
        }
        const engineOn = () => { const r = realValue('running'); return !!r && (r.text === 'running' || r.text === 'starting'); };
        // the fuel signal's scaling not learned yet: the engine unit is asked for its fuel figure while the engine runs
        const tripsNeedDme = () => tripsOn() && !flow.k && engineOn() && !engineUnit().demo && !engineUnit().silent;
        function saveTrips() {
            try {
                fs.writeFileSync(TRIPS_FILE + '.tmp', JSON.stringify(tc));
                fs.renameSync(TRIPS_FILE + '.tmp', TRIPS_FILE);
                tcSaved = tc.ver; tcSavedAt = Date.now();
            } catch (e) { log.warn('save trips: ' + e); }
        }
        // the head unit going to sleep ends the app (kit/mgu.js): the trip so far is kept
        process.on('exit', () => { if (tc.ver !== tcSaved) saveTrips(); });
        /** the fuel flow now: { lph, src } (lph null: no figure) */
        function tripFuel(now) {
            if (flow.k && flow.last) { const v = flow.lph(now); if (v !== null) return { lph: v, src: 'signal' }; }
            const d = dmeFuel();
            if (d && d.got && now - d.got.t < 3000) return { lph: d.got.lph, src: 'engine unit' };
            return { lph: null, src: null };
        }
        const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const pad2 = (n) => (n < 10 ? '0' : '') + n;
        const clock = (ms) => { const d = new Date(ms); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
        const day = (ms) => { const d = new Date(ms); return d.getDate() + ' ' + MON[d.getMonth()]; };
        const dur = (ms) => Math.floor(ms / 3600000) + ':' + pad2(Math.floor(ms / 60000) % 60);
        const tripLine = (tr) => tr.km.toFixed(1) + ' km, ' + tr.l.toFixed(2) + ' l' + (TRIPS.per100(tr.km, tr.l) !== null ? ' (' + TRIPS.per100(tr.km, tr.l).toFixed(1) + ' l/100 km)' : '')
            + ', ' + dur(tr.driveMs) + ' h driving, ' + dur(tr.idleMs) + ' h standing, fuel from ' + (tr.src || 'nothing') + (tr.noFuelMs > 60000 ? ' (none for ' + dur(tr.noFuelMs) + ' h)' : '')
            + (tr.odo0 !== null ? ', odometer ' + tr.odo0 + '-' + tr.odo1 : '') + (tr.tank0 !== null ? ', tank ' + tr.tank0 + '-' + tr.tank1 + ' l' : '');
        function tripTick() {
            if (!tripsOn()) return;
            sigStart();
            const now = Date.now(), n = (id, age) => { const v = realValue(id, age); return v && typeof v.n === 'number' && !v.raw ? v.n : null; };
            const run = realValue('running'), f = tripFuel(now);
            const r = tc.feed(now, { speed: n('speed', 30000), lph: f.lph, src: f.src, running: run && run.text, odo: n('odo'), tank: n('tank') });
            if (r.ended) log.info('trip ended: ' + tripLine(r.ended));
            if (r.started) log.info('trip started' + (tc.cur.odo0 !== null ? ' at ' + tc.cur.odo0 + ' km' : '') + ', fuel from ' + (f.src || 'nothing yet'));
            if (r.started || r.ended || (tc.ver !== tcSaved && now - tcSavedAt > 60000)) saveTrips();
            if (tc.ver !== tcDrawn && ui.isVisible('MAIN')) { const pg = current(); if (pg.group === 'trips' || pg.group === 'gauges') { tcDrawn = tc.ver; changed(); } }
        }
        setInterval(() => { try { tripTick(); } catch (e) { if (tcErrs++ % 600 === 0) log.warn('trip computer (' + tcErrs + 'x): ' + (e && e.stack || e)); } }, 500);
        /** the trip computer's values as car signals (signals.js "Trip computer"): the trip going on, else the last */
        function tripItem(kind) {
            const tr = tc.cur || tc.trips[tc.trips.length - 1];
            if (!tr) return { text: 'no trip yet', dim: true };
            if (kind === 'km') return { n: tr.km, u: 'km' };
            if (kind === 'fuel') return { n: tr.l, u: 'l' };
            if (kind === 'time') return { text: dur(tr.driveMs + tr.idleMs) + ' h' };
            if (kind === 'avg') { const v = TRIPS.per100(tr.km, tr.l); return v === null ? { text: 'under 1 km', dim: true } : { n: v, u: 'l/100 km' }; }
            const c = tc.cost(tr);
            return c === null ? { text: 'set the fuel price', dim: true } : { n: c, u: currency() };
        }

        /* ---------- a gauge's value: a car signal, an engine value, or (a full catalog) any unit's ---------- */
        // key 'sig:<id>' / '<addr>:useful:<name>' / '<addr>:<identifier>:<field>'; fav = what is kept with it in
        // screens.json: { sig, name } / { addr, sgbd, useful, c, minus, u, name } / { addr, sgbd, key, field, name }
        const items = new Map();
        let itemsV = -1;
        function item(k, fav) {
            if (itemsV !== layoutVer) { items.clear(); itemsV = layoutVer; }
            let x = items.get(k);
            if (x) return x;
            if (fav.sig) x = { k, fav, isSig: true, sig: SIG.ITEMS[fav.sig] || null, unit: null };
            else {
                const u = unitAt(fav.addr);
                let useful = null, row = null;
                if (u && fav.useful) (usefulOf(u) || []).forEach((g) => g.items.forEach((ur) => { if (ur.item.name === fav.useful) useful = ur; }));
                else if (u) row = rowsOf(u).find((r) => r.key === fav.key && r.field === fav.field) || null;
                x = { k, fav, unit: u, useful, row };
            }
            items.set(k, x);
            return x;
        }
        // (bank 2's values of a twin-unit engine: "Bank 2: ..." where the master has the same name)
        const itemName = (x) => (x.isSig ? (x.sig ? x.sig.name : x.fav.name || '?') : x.useful ? bankName(x.unit, x.useful.item) : x.row ? nameOf(x.unit, x.row) : x.fav.name || '?');
        /** what a value shows: { text, dim, warn } */
        function itemText(x) {
            if (x.isSig) return x.sig ? sigText(x.sig) : { text: 'not in this version', dim: true };
            if (!x.unit) return { text: 'Scan units first', dim: true };
            return x.useful ? usefulValue(x.unit, x.useful) : x.row ? baseValue(x.unit, x.row) : { text: 'not in this unit type', dim: true };
        }
        /** a value's number for a gauge: { n, u, d } or null (nothing now, or not a number) */
        function itemNum(x) {
            if (x.isSig) {
                const v = x.sig && shownTemp(sigValue(x.sig));
                return v && typeof v.n === 'number' && !v.raw && !v.bad ? { n: v.n, u: v.u || '', d: x.sig.d == null ? 1 : x.sig.d } : null;
            }
            if (!x.unit) return null;
            if (x.useful) {
                const v = shownTemp(usefulRaw(x.unit, x.useful));
                return typeof v.n === 'number' ? { n: v.n, u: v.u || '', d: x.useful.item.d == null ? 2 : x.useful.item.d } : null;
            }
            const vals = x.row && state(x.unit.res[x.row.key]) === 'ok' ? valuesOf(x.unit, x.row) : null, y = vals && vals[x.row.field];
            return y && !y.why && typeof y.value === 'number' ? shownTemp({ n: y.value, u: x.row.e.f[x.row.field].u || '', d: Number.isInteger(y.value) ? 0 : 2 }) : null;
        }
        /** a catalog / standard value's text: { text, dim, warn } */
        function baseValue(u, row) {
            const r = u.res[row.key], s = state(r);
            if (s === 'ok') {
                const v = valuesOf(u, row), x = v && v[row.field];
                return { text: v ? ascii(formatShown(x, row.e.f[row.field])) : '?', dim: !!(x && x.why) };
            }
            if (!obdSupported(u, row)) return { text: u.obd ? 'not supported' : '...', dim: true };
            if (s === 'absent') return { text: 'not in this unit', dim: true };
            if (s === 'refused') return { text: refusal(r), warn: details(), dim: !details() };
            if (s === 'silent') return { text: 'no reply', dim: true };
            return { text: '...', dim: true };
        }
        /** the groups a gauge's value is chosen from (picker.js) */
        function pickGroups() {
            const out = [];
            const sigItem = (it) => ({ key: 'sig:' + it.id, fav: { sig: it.id, name: it.name }, name: it.name, text: () => sigText(it) });
            SIG.GROUPS.forEach((g) => {
                const list = g.items.filter(sigListed).map(sigItem);
                if (list.length) out.push({ name: g.items.every((it) => it.tc) ? g.group : translate('Car signals') + ': ' + translate(g.group), items: list });
            });
            const u = engineUnit();
            (usefulOf(u) || []).forEach((g) => out.push({
                name: translate('Engine unit') + ': ' + translate(g.group),
                items: g.items.map((ur) => ({
                    key: u.addr + ':useful:' + ur.item.name, name: bankName(u, ur.item), text: () => usefulValue(u, ur),
                    fav: { addr: u.addr, sgbd: u.sgbd, useful: ur.item.name, c: ur.item.c || ur.item.minus, minus: !!ur.item.minus, u: ur.item.u, name: ur.item.name },
                })),
            }));
            // a twin-unit engine's second unit: bank 2's values (named "Bank 2: ..." on a gauge)
            const s2 = slaveUnit();
            (s2 ? usefulOf(s2) || [] : []).forEach((g) => out.push({
                name: translate('Engine unit') + ', ' + translate('Bank 2') + ': ' + translate(g.group),
                items: g.items.map((ur) => ({
                    key: s2.addr + ':useful:' + ur.item.name, name: ur.item.name, text: () => usefulValue(s2, ur),
                    fav: { addr: s2.addr, sgbd: s2.sgbd, useful: ur.item.name, c: ur.item.c || ur.item.minus, minus: !!ur.item.minus, u: ur.item.u, name: 'Bank 2: ' + ur.item.name },
                })),
            }));
            // a unit with a full catalog (made here): every value it answered
            units.forEach((x) => {
                const c = catalog(x.sgbd);
                if (!c || c.builtin) return;
                const list = rowsOf(x).filter((row) => row.kind === 'sgbd' && state(x.res[row.key]) === 'ok').map((row) => ({
                    key: x.addr + ':' + row.key + ':' + row.field, name: nameOf(x, row), text: () => baseValue(x, row),
                    fav: { addr: x.addr, sgbd: x.sgbd, key: row.key, field: row.field, name: nameOf(x, row) },
                }));
                if (list.length) out.push({ name: unitName(x) + ': every value that answered', items: list });
            });
            return out;
        }

        /* ---------- Gauges: your own screens (screens.js) ---------- */
        // data/screens.json: { screens: [{ layout, slots: [{ k, fav } | null] }] }; a gauge keeps its value's
        // description. A new install (no file yet) starts with screens.js DEFAULTS. Written only when changed.
        const SCREENS_FILE = path.join(ctx.dataDir, 'screens.json');
        const filled = (sc) => sc.slots.some(Boolean);
        const loadSlot = (x) => (x && x.k && x.fav && typeof x.fav === 'object' ? { k: String(x.k), fav: x.fav } : null);
        const sigSlot = (id) => (SIG.ITEMS[id] ? { k: 'sig:' + id, fav: { sig: id, name: SIG.ITEMS[id].name } } : null);
        const savedScreens = readJson(SCREENS_FILE, null);
        let screens = savedScreens ? (savedScreens.screens || []).filter((sc) => sc && typeof sc === 'object')
            .map((sc) => ({ layout: SCR.layout(sc.layout).id, slots: (Array.isArray(sc.slots) ? sc.slots : []).slice(0, SCR.MAX_SLOTS).map(loadSlot) }))
            .filter(filled).slice(0, SCR.MAX_SCREENS)
            : SCR.DEFAULTS.map(([layout, ids]) => ({ layout, slots: ids.map(sigSlot) }));
        // the next screen, on the page after the last until a value is chosen for it
        let blank = { layout: SCR.LAYOUTS[0].id, slots: [] }, scrVer = 0;
        function saveScreens() {
            screens = screens.filter(filled);
            try { fs.writeFileSync(SCREENS_FILE, JSON.stringify({ screens })); } catch (e) { log.warn('save screens: ' + e); }
            scrVer++;
        }
        /** a screen's gauges in its layout's order (null: none chosen) */
        const slotsOf = (sc) => SCR.layout(sc.layout).slots.map((kind, i) => sc.slots[i] || null);
        const screenItems = (sc) => (sc ? slotsOf(sc).filter(Boolean).map((x) => item(x.k, x.fav)) : []);
        // the screen the home-screen widget shows (Settings), when there is one and a widget is on the home screen
        const widgetScreen = () => screens[(Number(settings.get('widget')) || 1) - 1] || null;
        const widgetOn = () => !!(ctx.widget && ctx.widget.active() && widgetScreen());
        const widgetItems = () => (widgetOn() ? screenItems(widgetScreen()) : []);

        // per value: the range seen (scales that grow), the peak held a moment, the last 5 minutes (the traces)
        const ranges = new Map(), peaks = new Map(), traces = new Map();
        const TRACE_MS = 2500, TRACE_N = 120;
        /** what a gauge shows: { empty } or { name, text, dim, warn, n, u, d, sc, peak, hist } */
        function slotData(slot) {
            if (!slot) return { empty: true };
            const x = item(slot.k, slot.fav), v = itemText(x), num = itemNum(x);
            const useful = x.useful ? x.useful.item.name : slot.fav.useful || null;
            const s = { name: ascii(itemName(x)), text: ascii(v.text), dim: !!v.dim, warn: !!v.warn, n: null, u: ascii(shownUnit(slot.fav.u || '')), d: 0 };
            if (!num) { s.sc = SCR.scale(slot.k, useful, s.u, ranges.get(slot.k) || null); return s; }
            const now = Date.now(), n = num.n;
            let r = ranges.get(slot.k), p = peaks.get(slot.k), tr = traces.get(slot.k);
            if (!r) ranges.set(slot.k, (r = { lo: n, hi: n }));
            r.lo = Math.min(r.lo, n); r.hi = Math.max(r.hi, n);
            if (!p || n >= p.v || now - p.t > SCR.PEAK_MS) peaks.set(slot.k, (p = { v: n, t: now }));
            if (!tr) traces.set(slot.k, (tr = { t: 0, pts: [] }));
            if (now - tr.t >= TRACE_MS) { tr.t = now; tr.pts.push(n); if (tr.pts.length > TRACE_N) tr.pts.shift(); }
            s.u = ascii(num.u);
            return Object.assign(s, { n: G.hold('scr|' + slot.k, n, 200), d: num.d, peak: p.v, hist: tr.pts, sc: SCR.scale(slot.k, useful, s.u, r) });
        }
        /** gauge i of screen sc shows choice c ([key, fav] or null: none) */
        function setSlot(sc, i, c) {
            while (sc.slots.length <= i) sc.slots.push(null);
            sc.slots[i] = c ? { k: c[0], fav: Object.assign({}, c[1]) } : null;
            if (sc === blank && filled(sc)) { screens.push(sc); blank = { layout: SCR.LAYOUTS[0].id, slots: [] }; }
            saveScreens();          // one left without values goes
            log.info('screen ' + (screens.indexOf(sc) + 1) + ': gauge ' + (i + 1) + ' = ' + (c ? c[0] : 'none'));
            stay(sc);
            changed();
        }
        function setLayout(sc, id) {
            sc.layout = SCR.layout(id).id;
            cursor = Math.min(cursor, SCR.layout(sc.layout).slots.length - 1);
            if (sc === blank) scrVer++; else saveScreens();
            buttons(); changed();
        }
        function removeScreen(sc) {
            screens = screens.filter((x) => x !== sc);
            saveScreens();
            log.info('screen removed, ' + screens.length + ' left');
            page = Math.max(0, Math.min(page, pages().length - 1)); cursor = 0;
            buttons(); changed();
        }
        /** a gauge tapped or pressed: the sheet to choose its value (drawn over the page, or on it with the knob) */
        function openGauge(i) {
            const pg = current(), sc = pg.screen;
            if (!sc) return;
            cursor = i;
            const cur = sc.slots[i] || null;
            openSheet(picker = PICK.valueSheet({
                title: translate('Gauge') + ' ' + (i + 1) + ' (' + translate(SCR.KINDS[SCR.layout(sc.layout).slots[i]] || 'gauge') + ')',
                groups: pickGroups, current: cur ? cur.k : null,
                choose: (c) => setSlot(sc, i, c),
                layouts: SCR.LAYOUTS, layout: sc.layout, setLayout: (id) => setLayout(sc, id),
                remove: sc === blank ? null : () => removeScreen(sc),
            }));
        }
        /** the fuel price */
        const nudgePrice = (by) => { tc.setPrice(Math.min(999, Math.max(0, tc.price + by))); changed(); };
        const priceSheet = () => PICK.priceSheet({
            price: () => tc.price, nudge: nudgePrice, currency,
            keep: () => { saveTrips(); log.info('fuel price: ' + tc.price.toFixed(2) + ' ' + currency()); buttons(); },
        });
        function openPrice() { openSheet(priceSheet()); }
        // also in Settings (#204: the Trips page's button was easy to miss)
        if (ctx.settingsRow) ctx.settingsRow({ label: 'Fuel price', value: () => (tc.price ? tc.price.toFixed(2) + ' ' + currency() + ' a litre' : 'Not set'), open: priceSheet });
        // a sheet the kit doesn't draw (no renderer that runs the screen): on the page, the knob drives it
        let inline = null, picker = null;
        const pickerItems = () => (picker ? picker.listed().map((it) => item(it.key, it.fav)) : []);
        function openSheet(sh) {
            sh.onClose = () => { if (picker === sh) picker = null; };
            if (ctx.sheet && ctx.sheet(sh)) return;
            inline = sh;
            inline.controller = true;
            if (!browsing) browse(true);
            buttons(); changed();
        }
        function dropInline() { if (inline) { inline.onClose(); inline = null; } }
        function inlineDone(r) {
            if (r === 'close') { dropInline(); buttons(); }
            changed();
        }

        /* ---------- pages: Gauges, Trips, Signals, Energy, Engine, Units (and each unit's values) ---------- */
        // scrolls: the kit runs the screen, so each list is one page that scrolls; else paged (render sets it)
        let page = 0, cursor = 0, pagesCache = null, scrolls = false;
        const lists = {};                 // scroll position of a list: key -> { y, max }
        const listKey = (pg) => (pg.group === 'units' ? 'unit:' + pg.unit.addr : pg.group);
        const scrollOf = (pg) => lists[listKey(pg)] || (lists[listKey(pg)] = { y: 0, max: 0 });
        function pages() {
            const eu = engineUnit();
            const s2 = slaveUnit();
            const v = [layoutVer, SIGU.ver, scrVer, tripsOn(), scrolls, eu.ver, s2 ? s2.ver : '-', units.map((u) => u.ver).join(',')].join(':');
            if (pagesCache && pagesCache.v === v) return pagesCache.list;
            const list = [], n = (rows) => (scrolls ? 1 : Math.max(1, Math.ceil(rows / ROWS)));
            const ns = screens.length + (screens.length < SCR.MAX_SCREENS ? 1 : 0);
            screens.forEach((sc, i) => list.push({ group: 'gauges', screen: sc, p: i, n: ns }));
            if (screens.length < SCR.MAX_SCREENS) list.push({ group: 'gauges', screen: blank, p: screens.length, n: ns, blank: true });
            if (tripsOn()) for (let p = 0; p < 2; p++) list.push({ group: 'trips', p, n: 2 });
            const sn = n(sigView().length);
            for (let p = 0; p < sn; p++) list.push({ group: 'signals', unit: SIGU, p, n: sn });
            const xn = n(energyView().length);
            for (let p = 0; p < xn; p++) list.push({ group: 'energy', p, n: xn });
            const en = n(engineView().length);
            for (let p = 0; p < en; p++) list.push({ group: 'engine', unit: eu, p, n: en });
            list.push({ group: 'units', unit: null, p: 0, n: 1 });
            units.forEach((u) => {
                const un = n(view(u).length);
                for (let p = 0; p < un; p++) list.push({ group: 'units', unit: u, p, n: un });
            });
            pagesCache = { v, list };
            return list;
        }
        const current = () => { const l = pages(); page = Math.max(0, Math.min(page, l.length - 1)); return l[page]; };
        /** a list page's rows: the whole list where it scrolls, else this page's */
        function listRows(pg) {
            const all = pg.group === 'signals' ? sigView() : pg.group === 'energy' ? energyView()
                : pg.group === 'engine' ? engineView() : pg.unit ? view(pg.unit) : [];
            return scrolls ? all : all.slice(pg.p * ROWS, pg.p * ROWS + ROWS);
        }
        /** the rows of a list in sight now (what is read): where it scrolls, those in the window */
        function shownRows(pg) {
            const rows = listRows(pg);
            if (!scrolls) return rows;
            const from = Math.max(0, Math.floor(scrollOf(pg).y / ROW_H) - 1);
            return rows.slice(from, from + ROWS + 3);
        }
        /** the values a page shows that gauges are made of (a screen; the picker's listed over it) */
        const itemsOf = (pg) => (pg.screen ? screenItems(pg.screen) : []).concat(pickerItems());
        function goUnit(u) { const i = pages().findIndex((pg) => pg.group === 'units' && pg.unit === u); if (i >= 0) { page = i; cursor = 0; } buttons(); changed(); }
        /** after the screens changed: the page of screen sc (or the new screen's) */
        function stay(sc) {
            const l = pages(), i = l.findIndex((x) => x.screen === sc);
            page = Math.max(0, i >= 0 ? i : l.findIndex((x) => x.blank));
        }

        /* ---------- reading ---------- */
        function record(u, row, reply) {
            const prev = u.res[row.key], r = { t: Date.now() };
            if (!reply) r.why = 'no reply';
            else if (reply[0] === 0x7F) r.nrc = reply[2];
            else {
                r.ok = 1; r.b = hexs(reply);
                // how long this identifier's reply is: what lets it share a request with others
                if (reply[0] === 0x62 && row.e.sid === 0x22) (u.len || (u.len = {}))[row.e.id] = reply.length - 3;
            }
            readCount++;
            if (state(prev) !== state(r)) u.ver++;
            u.res[row.key] = r;
            changed();
        }
        const valuesOf = (u, row) => {
            const r = u.res[row.key];
            if (!r || !r.ok || !r.b) return null;
            if (!r.vals) r.vals = decode(row.e, r.b.split(' ').map((x) => parseInt(x, 16)), enumsOf(u, row));
            return r.vals;
        };

        async function ask(u, sid, id, e) {
            if (u.demo) { await sleep(40); return DEMO.reply(u.addr, sid, id, e ? need(e) : 1, e); }
            if (sid === 0x22) return link.read(u.addr, id);
            return link.physical(u.addr, sid, [id], 1500, (r) => (r[0] === sid + 0x40 && r[1] === id) || (r[0] === 0x7F && r[1] === sid));
        }

        /** OBD service 01 asks which PIDs the engine unit has before any of them (bit maps 00, 20, 40 ...) */
        async function obdSupport(u) {
            const have = [];
            for (let base = 0; base <= 0xC0; base += 0x20) {
                const r = await ask(u, 0x01, base, null);
                if (r === undefined) return;            // cancelled: ask again next time
                if (!r || r[0] !== 0x41 || r.length < 6) break;
                for (let i = 0; i < 32; i++) if (r[2 + (i >> 3)] & (0x80 >> (i & 7))) have.push(base + 1 + i);
                if (have.indexOf(base + 0x20) < 0) break;
            }
            u.obd = have;
            u.ver++;
            log.info('unit ' + hex(u.addr) + ': OBD-II PIDs ' + (have.length ? have.map((p) => hex(p)).join(' ') : 'none'));
            changed();
        }

        async function readRow(u, row) {
            if (row.kind === 'obd' && !u.obd) await obdSupport(u);
            if (!obdSupported(u, row)) return;
            const reply = await ask(u, row.e.sid, row.e.id, row.e);
            if (reply === undefined) return;            // cancelled before it was sent (screen left, new scan)
            if (!u.demo && link.silent(u.addr)) { u.silent = true; changed(); }
            record(u, row, reply);
        }

        /**
         * Several identifiers of one unit in one request: each answered one recorded on its own; a reply that
         * is refused or doesn't add up three times sends this unit back to one identifier a request.
         */
        async function readRows(u, rows) {
            if (rows.length === 1) return readRow(u, rows[0]);
            const ids = rows.map((r) => r.e.id);
            let reply;
            if (u.demo) { await sleep(40); reply = DEMO.replyMany(u.addr, ids, rows.map((r) => need(r.e)), rows.map((r) => r.e)); } else reply = await link.readMany(u.addr, ids, 1500);
            if (reply === undefined) return;
            if (!u.demo && link.silent(u.addr)) { u.silent = true; changed(); }
            const parts = split(reply, u.len);
            if (!parts) {
                u.multiFails = (u.multiFails || 0) + 1;
                if (u.multiFails >= 3 || (reply && reply[0] === 0x7F)) {
                    u.multi = false;
                    log.info('unit ' + hex(u.addr) + ': one identifier a request (' + (reply ? hexs(reply.slice(0, 3)) : 'no reply') + ')');
                }
                return;
            }
            if (u.multi !== true) { u.multi = true; log.info('unit ' + hex(u.addr) + ': up to ' + MAX_DIDS + ' identifiers a request'); }
            rows.forEach((row) => {
                if (parts[row.e.id]) record(u, row, parts[row.e.id]);
                else (u.noBatch || (u.noBatch = {}))[row.key] = 1;      // left out of the reply: on its own from now on
            });
        }
        const batchable = (u, row) => u.multi !== false && row.e.sid === 0x22 && u.len && u.len[row.e.id] != null
            && !(u.noBatch && u.noBatch[row.key]) && state(u.res[row.key]) === 'ok';

        // live: the values in sight in turn, those of one unit together; none asked again within 100 ms,
        // one that didn't answer within 5 s (each wait for it holds the link up to 1.5 s), one refused as
        // missing within 30 s (it may answer in another state)
        // (fg: this app's screen is shown; else the widget's values, each asked again after 500 ms at the soonest)
        let liveNext = 0;
        function liveJob(fg) {
            const pg = fg ? current() : null, its = fg ? itemsOf(pg) : widgetItems();
            // what is shown: [unit, rows to ask] (a screen, the widget: each value from its own unit; a list: its rows in sight)
            const rowAsks = (u, r) => (r.header || r.sig ? [] : r.useful ? usefulRows(u, r.useful) : [r]);
            const shown = its.length ? its.filter((x) => x.unit).map((x) => [x.unit, x.useful ? usefulRows(x.unit, x.useful) : x.row ? [x.row] : []])
                : pg && pg.group === 'energy' ? shownRows(pg).filter((r) => r.unit).map((r) => [r.unit, rowAsks(r.unit, r)])
                    : pg && pg.unit && !pg.unit.sig ? shownRows(pg).map((r) => [r.unit || pg.unit, rowAsks(r.unit || pg.unit, r)]) : [];
            // the fuel signal's l/h shown but its scaling not learned yet, or the trip computer needing a fuel figure:
            // the engine unit's figures alongside (for the trip computer each once a second)
            if (!flow.k && !sigDemo()) {
                const want = flow.last && fuelShown() ? -1 : tripsNeedDme() ? 1000 : 0;
                if (want) {
                    const d = dmeFuel();
                    if (d && d.rows.length) shown.push([d.u, d.rows, want > 0 ? want : 0]);
                    if (d && d.more) shown.push([d.more.u, d.more.rows, want > 0 ? want : 0]);
                }
            }
            const todo = [], seen = {}, age = fg ? 100 : 500;
            shown.forEach(([u, rows, every]) => {
                if (u.silent) return;
                rows.forEach((row) => {
                    const id = u.addr + ':' + row.key;
                    if (seen[id]) return;
                    seen[id] = 1;
                    const r = u.res[row.key];
                    if (r && Date.now() - r.t < (state(r) === 'absent' ? 30000 : state(r) === 'silent' ? 5000 : every || age)) return;
                    todo.push({ u, row });
                });
            });
            if (!todo.length) return null;
            liveNext = (liveNext + 1) % todo.length;
            const first = todo[liveNext], rows = [first.row];
            for (let k = 1; k < todo.length && rows.length < MAX_DIDS && batchable(first.u, first.row); k++) {
                const x = todo[(liveNext + k) % todo.length];
                if (x.u === first.u && batchable(x.u, x.row)) rows.push(x.row);
            }
            return { u: first.u, rows };
        }
        function sweepJob() {
            if (!sweep) return null;
            const u = sweep.u;
            if (u.silent) { endSweep('stopped: ' + unitName(u) + ' stopped answering (ignition on?)'); return null; }
            while (sweep.i < sweep.rows.length) {
                const row = sweep.rows[sweep.i++];
                if (row.kind === 'obd' && u.obd && !obdSupported(u, row)) continue;
                return { u, row, sweep: true };
            }
            endSweep('');
            return null;
        }
        function save(u) {
            try {
                const res = {};
                Object.keys(u.res).forEach((k) => { const r = u.res[k]; res[k] = r.ok ? { ok: 1, b: r.b, t: r.t } : r.nrc !== undefined ? { nrc: r.nrc, t: r.t } : { why: r.why, t: r.t }; });
                fs.writeFileSync(scanFile(u), JSON.stringify({ at: Date.now(), addr: u.addr, index: u.index, variant: u.variant, sgbd: u.sgbd, demo: !!u.demo, obd: u.obd, res }));
            } catch (e) { log.warn('save scan: ' + e); }
        }
        function startSweep(u) {
            const seen = {}, rows = rowsOf(u).filter((row) => { if (seen[row.key]) return false; seen[row.key] = 1; return true; });
            sweep = { u, rows, i: 0, at: Date.now() };
            u.silent = false; link.wake(u.addr);
            log.info('read all: ' + unitName(u) + ' (' + (u.sgbd || 'no catalog') + '), ' + rows.length + ' identifiers');
            u.msg = ''; changed();
        }
        function endSweep(why) {
            if (!sweep) return;
            const u = sweep.u, n = sweep.rows.filter((r) => state(u.res[r.key]) === 'ok').length;
            log.info('read all ' + unitName(u) + ': ' + (why || 'done') + ', ' + n + ' answer, ' + Math.round((Date.now() - sweep.at) / 1000) + ' s');
            u.msg = why ? 'Read all ' + why : 'Read all done: ' + n + ' of ' + sweep.rows.length + ' answer';
            save(u);
            sweep = null;
            buttons(); changed();
        }

        // how fast it reads, every 30 s while shown (to the log, data/live_data.log)
        let statLast = { sent: 0, ms: 0, timed: 0, reads: 0, busy: 0, miss: 0, refused: 0 };
        setInterval(() => {
            const st = link.stats, sent = st.sent - statLast.sent, timed = st.timed - statLast.timed, reads = readCount - statLast.reads, bz = link.busy - statLast.busy;
            const miss = st.missed - statLast.miss, refused = refusedCount - statLast.refused;
            if (sent || reads) {
                log.info('reading: ' + sent + ' requests, ' + reads + ' values in 30 s' + (timed ? ', replies in ' + Math.round((st.ms - statLast.ms) / timed) + ' ms on average' : '')
                    + (bz ? ', transport busy ' + bz + ' times' : '') + (refused ? ' (' + refused + ' given up)' : '') + (miss ? ', ' + miss + ' without an answer' : ''));
            }
            statLast = { sent: st.sent, ms: st.ms, timed: st.timed, reads: readCount, busy: link.busy, miss: st.missed, refused: refusedCount };
        }, 30000);

        // one request at a time, only while the screen or a widget is shown
        let jobs = 0;
        (async function pump() {
            for (;;) {
                let job = null;
                try {
                    const fg = ui.isVisible('MAIN');
                    if ((fg || widgetOn() || tripsNeedDme()) && !busy) {
                        jobs++;
                        // Read all goes first, with the values in sight in between every few; else the widget's and the trip computer's only
                        job = fg ? (jobs % 4 && sweepJob()) || liveJob(true) || sweepJob() : liveJob(false);
                    }
                    if (!job) { await sleep(40); continue; }
                    if (job.rows) await readRows(job.u, job.rows); else await readRow(job.u, job.row);
                    if (!fg) await sleep(150);
                    if (job.sweep && sweep && sweep.i % 200 === 0) save(job.u);
                } catch (e) {
                    // the transport still busy after its retries (another app has it): counted, tried again soon
                    if (/transport refused/.test(e && e.message)) { refusedCount++; await sleep(100); continue; }
                    log.warn('read ' + (job ? hex(job.u.addr) + ' ' + (job.rows || [job.row]).map((r) => r.key).join(',') : '') + ': ' + e);
                    await sleep(500);
                }
            }
        })();

        /* ---------- Scan units ---------- */
        async function scanUnits() {
            if (busy) return;
            busy = true; phase = 'scanning'; msg = 'Asking every control unit...';
            if (sweep) endSweep('stopped');
            link.cancel(); link.wake();
            buttons(); changed();
            try {
                const demo = useDemo();
                let found = new Map();
                if (demo) {
                    for (const [a, idx] of DEMO.UNITS) { await sleep(120); found.set(a, idx); msg = 'Asking every control unit... ' + found.size; changed(); }
                } else {
                    found = (await link.discover()) || new Map();
                    if (!found.size) {
                        // nothing to the request to all units: ask the addresses a car has, one by one
                        log.info('22 F1 50 to all units: no answer - asking each address');
                        const addrs = Object.keys(ECU).map(Number);
                        for (let i = 0; i < addrs.length && ui.isVisible('MAIN'); i++) {
                            msg = 'Asking control unit ' + (i + 1) + ' of ' + addrs.length + '...'; changed();
                            const r = await link.read(addrs[i], 0xF150, 1200);
                            if (r) found.set(addrs[i], r[0] === 0x62 && r.length >= 6 ? hex(((r[3] << 16) | (r[4] << 8) | r[5]) >>> 0, 6) : '');
                        }
                        link.wake();
                    }
                }
                const before = new Map(units.map((u) => [u.addr, u]));
                units = Array.from(found.keys()).sort((a, b) => a - b).map((a) => {
                    const old = before.get(a);
                    return old && old.index === found.get(a) && !!old.demo === demo ? old : makeUnit(a, found.get(a), demo);
                });
                demoUnits = demo;
                units.forEach((u) => { u.silent = false; log.info('unit ' + hex(u.addr) + ': SGBD index ' + (u.index || 'none') + ' -> ' + (u.variant || 'unknown type') + (u.sgbd ? ', catalog ' + u.sgbd + (u.closest ? ' (closest)' : '') + (catalog(u.sgbd).builtin ? ' (built in)' : '') : '')); });
                try { fs.writeFileSync(UNITS_FILE, JSON.stringify({ at: Date.now(), demo, units: units.map((u) => ({ addr: u.addr, index: u.index, variant: u.variant })) })); } catch (e) { log.warn('save units: ' + e); }
                msg = units.length ? units.length + ' ' + plural(units.length, 'control units answered', 'control units answered') : 'No control unit answered - ignition on?';
                phase = 'done';
            } catch (e) {
                log.warn('scan units: ' + e);
                phase = 'error'; msg = 'Scan failed: ' + e.message;
            }
            busy = false; cursor = 0;
            relayout(); buttons();
        }

        /* ---------- the knob, where the kit doesn't run the screen (Browse) ---------- */
        let browsing = false, touched = 0, knobPos = null, pressed = false, pushed = null, gateT = 0, knobSeen = false;
        const PUSHES = { NORD_KURZ_GEDRUECKT: 'N', NORD_LANG_GEDRUECKT: 'N', OST_KURZ_GEDRUECKT: 'E', OST_LANG_GEDRUECKT: 'E',
            SUED_KURZ_GEDRUECKT: 'S', SUED_LANG_GEDRUECKT: 'S', WEST_KURZ_GEDRUECKT: 'W', WEST_LANG_GEDRUECKT: 'W' };
        const PUSH_NUM = { 1: 'N', 2: 'N', 4: 'E', 5: 'E', 7: 'S', 8: 'S', 10: 'W', 11: 'W' };
        function browse(on) {
            if (browsing === on) return;
            browsing = on; touched = Date.now(); knobPos = null;
            if (!on && inline) { if (inline.title === 'Fuel price') inline.back(); dropInline(); }      // (the price is kept)
            if (ctx.controller) ctx.controller.grab(on);
            log.info(on ? 'browsing with the knob' : 'browsing ended');
            buttons(); changed();
        }
        function move(d) {
            if (inline) { inline.move(d); changed(); return; }
            const pg = current();
            if (pg.screen) { cursor = Math.max(0, Math.min(SCR.layout(pg.screen.layout).slots.length - 1, cursor + d)); changed(); return; }
            if (pg.group === 'units' && !pg.unit) { cursor = Math.max(0, Math.min(units.length - 1, cursor + d)); changed(); return; }
            if (!pg.unit && pg.group !== 'trips' && pg.group !== 'energy') return;
            if (pg.group === 'trips') { turnPage(d > 0 ? 1 : -1); return; }
            // a list: row by row, on into the group's next / previous page
            const l = pages(), same = (x) => x.group === pg.group && x.unit === pg.unit;
            cursor += d;
            while (cursor >= listRows(current()).length && page < l.length - 1 && same(l[page + 1])) { cursor -= Math.max(1, listRows(current()).length); page++; }
            while (cursor < 0 && page > 0 && same(l[page - 1])) { page--; cursor += Math.max(1, listRows(current()).length); }
            cursor = Math.max(0, Math.min(listRows(current()).length - 1, cursor));
            changed();
        }
        function press() {
            if (inline) { inlineDone(inline.press()); return; }
            const pg = current();
            if (pg.screen) { openGauge(cursor); return; }                                          // a gauge: choose its value
            if (pg.group === 'units' && !pg.unit) { if (units[cursor]) goUnit(units[cursor]); return; }
            if (pg.group === 'trips' && pg.p === 1) openPrice();
        }
        function push(dir) {
            if (inline) { if (dir === 'W') inlineDone(inline.back()); return; }
            const l = pages();
            if (dir === 'N' || dir === 'S') { page = (page + (dir === 'S' ? 1 : l.length - 1)) % l.length; cursor = 0; buttons(); changed(); return; }
            // left / right: the next / previous tab
            const keys = tabKeys.length ? tabKeys : ['gauges'], i = keys.indexOf(groupOf(current()));
            openTab((i + (dir === 'E' ? 1 : keys.length - 1)) % keys.length, true);
        }
        function knob(v) {
            if (!v || !browsing || !ui.isVisible('MAIN')) return;
            const p = v.frontRotaryEncoderPushButton, dfl = v.frontRotaryEncoderDeflection, pos = v.frontRotaryEncoderOperation;
            if (p === 'SIGNAL_UNGUELTIG' || p === 15) return;
            if (!knobSeen) { knobSeen = true; log.info('knob: live'); }
            touched = Date.now();
            if (typeof pos === 'number') {
                if (knobPos !== null) {
                    const d = ((pos - knobPos + 32768) & 0xffff) - 32768;
                    if (d && Math.abs(d) <= 64) move(d);
                }
                knobPos = pos;
            }
            const isPressed = p === 1 || p === 2 || p === 'DREHGEBER_KURZ_GEDRUECKT' || p === 'DREHGEBER_LANG_GEDRUECKT';
            if (isPressed && !pressed) press();
            pressed = isPressed;
            const dir = typeof dfl === 'number' ? PUSH_NUM[dfl] : PUSHES[dfl];
            if (dir && dir !== pushed) push(dir);
            pushed = dir || null;
        }
        if (ctx.controller && ctx.controller.onInput) ctx.controller.onInput((v) => { gateT = Date.now(); knob(v); });
        // without the controller gate the car's own controller messages still come (the HMI acts on them too)
        ctx.signals.watch('de.bmw.infotainment.controlelements.FrontCCU', '1', {
            statusRotaryEncoderState: (v) => { if (Date.now() - gateT > 1000) knob(v); },
        }, log).then((s) => log.info('controller ' + (s.error ? 'error: ' + s.error : 'subscribed')));
        setInterval(() => { if (browsing && (Date.now() - touched > IDLE_MS || !ui.isVisible('MAIN'))) browse(false); }, 1000);

        /* ---------- the bar's buttons (where the kit runs the screen, the page has them instead) ---------- */
        const readAll = (u) => { if (sweep && sweep.u === u) endSweep('stopped'); else startSweep(u); buttons(); };
        function buttons() {
            const pg = current();
            ui.text('BTN_ACTION', inline ? 'Done' : pg.screen ? 'Layout: ' + SCR.layout(pg.screen.layout).name
                : pg.group === 'trips' ? (tc.price ? 'Fuel price: ' + tc.price.toFixed(2) + ' ' + currency() : 'Set the fuel price')
                    : pg.group === 'units' && pg.unit ? (sweep && sweep.u === pg.unit ? 'Stop reading' : 'Read all') : busy ? 'Scanning...' : 'Scan units');
            ui.text('BTN_BROWSE', browsing ? 'Stop browsing' : 'Browse');
        }
        ui.onClick('BTN_ACTION', () => {
            const pg = current();
            if (inline) { inlineDone(inline.back()); return; }
            if (pg.screen) { setLayout(pg.screen, SCR.nextLayout(pg.screen.layout)); return; }        // the next layout; its values stay (by position)
            if (pg.group === 'trips') { openPrice(); return; }
            if (pg.group === 'units' && pg.unit) { readAll(pg.unit); return; }
            scanUnits();
        });
        ui.onClick('BTN_PAGE', () => { dropInline(); page = (page + 1) % pages().length; cursor = 0; buttons(); changed(); });
        ui.onClick('BTN_BROWSE', () => browse(!browsing));
        if (ctx.hideButton) ['BTN_ACTION', 'BTN_BROWSE'].forEach((b) => ctx.hideButton(b));

        /* ---------- drawing ---------- */
        const fit = (cv, s, size, max, opt) => fitText(cv, s, size, max, opt);
        let gliding = false;              // a list still gliding to where it was scrolled: draw the next frame too
        const browseNote = (s) => (browsing ? s : null);

        function drawUnits(cv, t) {
            const p = G.panel(cv, t, 24, 52, 1552, 460, 'Control units');
            let bx = 42 + cv.textWidth('Control units', 26, { font: 'bold' }) + 28;
            bx += G.button(cv, t, bx, 62, 0, 38, busy ? 'Scanning...' : 'Scan units', scanUnits, { key: 'scan', busy, primary: !units.length }) + 12;
            const note = browseNote('knob: choose  ·  press: open') || msg || (units.length ? units.length + ' ' + plural(units.length, 'answered', 'answered') : '');
            if (busy) {
                const w = 300, x = 1552 - w, f = (Date.now() / 1200) % 1;
                cv.roundRect(x, 71, w, 8, 4, t.track);
                cv.roundRect(x + f * (w - 80), 71, 80, 8, 4, t.accent);
                cv.text(fit(cv, note, 22, x - 20 - bx), x - 20, 88, 22, t.text, { align: 'right' });
            } else if (note) cv.text(fit(cv, note, 22, 1552 - bx - 24), 1552, 88, 22, phase === 'error' ? t.crit : t.dim, { align: 'right' });
            if (!units.length) {
                const mid = Math.round((p.y + p.h) / 2) + 20;
                cv.text(busy ? 'Scanning...' : 'Scan units to see the car\'s control units (ignition on)', 800, mid, 30, t.dim, { align: 'center' });
                cv.text('Only reads: identification and live values, nothing is written or changed in the car.', 800, mid + 44, 22, t.dim, { align: 'center' });
                return;
            }
            const cw = 296, ch = 76;
            units.slice(0, CARDS).forEach((u, i) => {
                const x = 48 + (i % COLS) * (cw + 8), y = 116 + Math.floor(i / COLS) * (ch + 8);
                const on = browsing && i === cursor, col = u.silent ? t.dim : GO;
                cv.roundRect(x, y, cw, ch, 10, withAlpha('#b4bccc', on ? 0.16 : 0.07));
                cv.fillRect(x, y + 12, 4, ch - 24, u.silent ? t.dim : t.sel || t.accent);
                if (on) cv.strokeRoundRect(x, y, cw, ch, 10, 2, t.sel || t.accent);
                cv.text(fit(cv, unitName(u), 24, cw - 40, { font: 'bold' }), x + 20, y + 32, 24, t.text, { font: 'bold' });
                const sub = '0x' + hex(u.addr) + (u.variant ? '  ·  ' + u.variant : details() && u.index ? '  ·  index ' + u.index : '');
                cv.text(fit(cv, sub, 18, cw - 70), x + 20, y + 60, 18, t.dim);
                cv.circle(x + cw - 20, y + 54, 6, col);
                if (cv.own) cv.target(x, y, cw, ch, () => goUnit(u), 'unit:' + u.addr);      // a tap or press opens it
            });
            if (units.length > CARDS) cv.text('+ ' + (units.length - CARDS) + ' more', 1552, 506, 20, t.dim, { align: 'right' });
        }

        /** a unit's page: its identification, (engine) its OBD-II data, every identifier of its catalog */
        function drawUnit(cv, t, pg) {
            const u = pg.unit, all = view(u), rows = listRows(pg);
            const c = catalog(u.sgbd);
            const title = unitName(u) + (u.variant ? '  ·  ' + u.variant : '');
            let note = u.msg, progress = null;
            if (sweep && sweep.u === u) { progress = sweep.i / sweep.rows.length; note = 'Reading ' + sweep.i + ' / ' + sweep.rows.length; } else if (!note) {
                const ok = all.filter((r) => state(u.res[r.key]) === 'ok').length;
                note = (scrolls ? '' : (pg.p * ROWS + 1) + '-' + Math.min(all.length, pg.p * ROWS + ROWS) + ' ' + translate('of') + ' ' + all.length + '  ·  ') + ok + ' ' + translate('of') + ' ' + all.length + ' ' + translate('read');
                if (details() && c) note += '  ·  catalog ' + c.sgbd + (c.builtin ? ' (built in)' : '') + (u.closest ? ', the closest' : '');
                if (u.silent) note += '  ·  not answering';
            }
            gliding = PAGES.listPanel(cv, t, G, fit, {
                title, note: browseNote('knob: scroll  ·  push up / down: page') || note, progress, details: details(),
                buttons: [{ label: 'All units', run: () => openTab(tabKeys.indexOf('units')), key: 'units' },
                    { label: sweep && sweep.u === u ? 'Stop reading' : 'Read all', run: () => readAll(u), key: 'readall' }],
                rows: rows.map((row) => {
                    const s = state(u.res[row.key]), v = baseValue(u, row);
                    return { name: nameOf(u, row), source: sourceOf(row), text: v.text, dim: v.dim, warn: v.warn, dimName: s === 'absent' || !obdSupported(u, row) };
                }),
                scroll: scrolls ? scrollOf(pg) : null, key: listKey(pg), cursor: browsing ? cursor : -1,
                empty: 'Nothing to show (Settings: Unit pages show)',
            }) || gliding;
        }

        /** Engine: the engine unit's values worth a look */
        function drawEngine(cv, t, pg) {
            const u = engineUnit(), all = engineView(), rows = listRows(pg);
            const items = all.filter((r) => !r.header);
            const ok = items.filter((r) => { const x = r.unit || u; return r.useful ? usefulRows(x, r.useful).every((y) => state(x.res[y.key]) === 'ok') : state(x.res[r.key]) === 'ok'; }).length;
            const note = browseNote('knob: scroll  ·  push up / down: page') || (u.silent ? 'The engine unit isn\'t answering (ignition on?)'
                : (scrolls || items.length <= ROWS ? '' : translate('page') + ' ' + (pg.p + 1) + ' ' + translate('of') + ' ' + pg.n + '  ·  ') + ok + ' ' + translate('of') + ' ' + items.length + ' ' + translate('values read'));
            gliding = PAGES.listPanel(cv, t, G, fit, {
                title: 'Engine', note, noteColor: u.silent ? t.warn : null, details: details(),
                rows: rows.map((row) => {
                    if (row.header) return row;
                    const ru = row.unit || u;
                    // (bank 2's rows are under their own headers: their names as they are)
                    if (row.useful) { const v = usefulValue(ru, row.useful); return { name: row.unit ? row.useful.item.name : bankName(u, row.useful.item), source: (row.unit ? '13:' : '') + usefulSource(ru, row.useful), text: v.text, dim: v.dim, warn: v.warn }; }
                    const v = baseValue(u, row);
                    return { name: nameOf(u, row), source: sourceOf(row), text: v.text, dim: v.dim, warn: v.warn };
                }),
                scroll: scrolls ? scrollOf(pg) : null, key: listKey(pg), cursor: browsing ? cursor : -1,
                empty: u.demo ? 'Loading...' : 'The engine unit has no values to show',
            }) || gliding;
        }

        function drawEnergy(cv, t, pg) {
            const all = energyView(), rows = listRows(pg);
            const items = all.filter((r) => r.useful);
            const ok = items.filter((r) => usefulRows(r.unit, r.useful).every((x) => state(r.unit.res[x.key]) === 'ok')).length;
            const note = browseNote('knob: scroll  ·  push up / down: page')
                || (scrolls || items.length <= ROWS ? '' : translate('page') + ' ' + (pg.p + 1) + ' ' + translate('of') + ' ' + pg.n + '  ·  ')
                    + ok + ' ' + translate('of') + ' ' + items.length + ' ' + translate('values read');
            gliding = PAGES.listPanel(cv, t, G, fit, {
                title: 'Energy', note, details: details(),
                rows: rows.map((row) => {
                    if (row.header) return row;
                    if (row.note) return { name: row.name, text: row.text, dim: true };
                    const v = usefulValue(row.unit, row.useful);
                    return { name: row.useful.item.name, source: usefulSource(row.unit, row.useful), text: v.text, dim: v.dim, warn: v.warn };
                }),
                scroll: scrolls ? scrollOf(pg) : null, key: listKey(pg), cursor: browsing ? cursor : -1,
                empty: 'No battery or converter values are available',
            }) || gliding;
        }

        function drawSignals(cv, t, pg) {
            const all = sigView(), items = all.filter((r) => r.sig), rows = listRows(pg);
            const n = items.filter((r) => { const v = sigValue(r.sig); return v && !v.bad; }).length;
            const note = browseNote('knob: scroll  ·  push up / down: page') || (!sigSubs && !sigDemo() ? 'connecting...'
                : (scrolls ? '' : translate('page') + ' ' + (pg.p + 1) + ' ' + translate('of') + ' ' + pg.n + '  ·  ') + n + ' ' + translate('of') + ' ' + items.length + ' ' + translate('with a value'));
            gliding = PAGES.listPanel(cv, t, G, fit, {
                title: 'Car signals', note, details: details(),
                rows: rows.map((row) => {
                    if (row.header) return row;
                    const it = row.sig, v = sigText(it);
                    return { name: it.name, source: sigSource(it), sourceWarn: !!(it.q || it.raw), text: ascii(v.text), dim: v.dim };
                }),
                scroll: scrolls ? scrollOf(pg) : null, key: listKey(pg), cursor: browsing ? cursor : -1,
                empty: 'Nothing has come from the car yet',
            }) || gliding;
        }

        /** Trips: page 1 this trip (or the last) and the last 5, page 2 the totals and the fuel price */
        const f1 = (x) => (x === null || x === undefined ? '--' : x.toFixed(1)), f2 = (x) => (x === null || x === undefined ? '--' : x.toFixed(2));
        /** buttons right of a panel's title; y: the panel's top (each panel's own row, not the first one's) */
        function titleButtons(cv, t, title, list, y) {
            let bx = 42 + cv.textWidth(title, 26, { font: 'bold' }) + 28;
            const by = (y === undefined ? 52 : y) + 10;
            list.forEach((b) => { bx += G.button(cv, t, bx, by, 0, 38, b.label, b.run, b) + 12; });
        }
        function drawTrips(cv, t, pg) {
            const now = Date.now(), cur = tc.cur, last = tc.trips[tc.trips.length - 1], tr = cur || last, cu = currency();
            if (pg.p === 1) { drawTotals(cv, t, now, cu); return; }
            const title = cur ? 'This trip  ·  since ' + clock(cur.start) : last ? 'Last trip  ·  ' + day(last.start) + ', ' + clock(last.start) + ' - ' + clock(last.end) : 'Trip computer';
            G.panel(cv, t, 24, 52, 1552, 196, title);
            titleButtons(cv, t, title, [{ label: 'Totals', run: () => turnPage(1), key: 'totals' }]);
            if (!tr) cv.text(tripsOn() ? 'The first trip starts with the engine: every drive is counted, also while this screen is closed' : 'The trip computer is off (Settings)', 800, 170, 26, t.dim, { align: 'center' });
            else {
                const avg = TRIPS.per100(tr.km, tr.l), cost = tc.cost(tr), time = tr.driveMs + tr.idleMs;
                [
                    { label: 'Distance', value: tr.km, unit: 'km', decimals: 1 },
                    { label: 'Fuel used', value: tr.l, unit: 'l', decimals: 2 },
                    { label: 'Consumption', value: avg, unit: 'l/100 km', decimals: 1 },
                    { label: 'Cost', value: cost, unit: cost === null ? '' : cu, decimals: 2 },
                    { label: 'Time', text: dur(time), unit: 'h' },
                    { label: 'Average speed', value: time > 60000 ? tr.km / (time / 3600000) : null, unit: 'km/h', decimals: 0 },
                ].forEach((c, i) => G.readout(cv, t, 48 + i * 254, 108, Object.assign({ size: 54, labelSize: 18 }, c)));
                const notes = ['standing ' + f2(tr.lIdle) + ' l', 'top speed ' + Math.round(tr.vmax) + ' km/h'];
                if (tr.odo0 !== null) notes.push('odometer ' + tr.odo0 + ' - ' + tr.odo1 + ' km');
                if (tr.tank0 !== null) notes.push('tank ' + tr.tank0 + ' - ' + tr.tank1 + ' l');
                if (details()) {
                    const src = cur ? Object.keys(cur.src) : (tr.src || '').split('+').filter(Boolean);
                    notes.push(src.length ? 'fuel from the ' + src.map((x) => (x === 'signal' ? 'car signal' : x)).join(' and ') : 'no fuel figure yet');
                }
                cv.text(fit(cv, notes.join('  ·  '), 19, 1500), 48, 232, 19, t.dim);
                if (tr.noFuelMs > 60000) cv.text('no fuel figure for ' + dur(tr.noFuelMs) + ' h (not counted)', 1552, 88, 20, t.warn, { align: 'right' });
            }
            G.panel(cv, t, 24, 260, 1552, 252, 'Last ' + TRIPS.KEEP + ' trips');
            const cols = [{ label: 'Started', w: 240 }, { label: 'Time', w: 130, align: 'right' }, { label: 'Distance', w: 190, align: 'right' },
                { label: 'Fuel', w: 170, align: 'right' }, { label: 'l/100 km', w: 170, align: 'right' }, { label: 'Cost', w: 240, align: 'right' },
                { label: 'Top speed', w: 180, align: 'right' }, { label: 'Tank', w: 184, align: 'right' }];
            const rows = tc.trips.slice().reverse().map((x) => {
                const c = tc.cost(x);
                return [day(x.start) + ', ' + clock(x.start), dur(x.driveMs + x.idleMs) + ' h', f1(x.km) + ' km', f2(x.l) + ' l', f1(TRIPS.per100(x.km, x.l)),
                    c === null ? '--' : f2(c) + ' ' + cu, Math.round(x.vmax) + ' km/h', x.tank0 !== null ? x.tank0 + ' - ' + x.tank1 + ' l' : '--'];
            });
            G.table(cv, t, 48, 316, 1504, cols, rows, { rowH: 32, size: 22, empty: 'No finished trip yet' });
        }
        function drawTotals(cv, t, now, cu) {
            G.panel(cv, t, 24, 52, 1552, 300, 'Totals');
            titleButtons(cv, t, 'Totals', [{ label: 'Last trips', run: () => turnPage(-1), key: 'trips' }]);
            const cur = tc.cur, row = (name, x) => {
                if (!x || !x.n) return [name, '0', '--', '--', '--', '--'];
                const avg = TRIPS.per100(x.km, x.l);
                return [name, String(x.n), f1(x.km) + ' km', f2(x.l) + ' l', avg === null ? '--' : f1(avg), x.cost === null ? '--' : f2(x.cost) + ' ' + cu];
            };
            const rows = [
                row('This trip', cur ? { n: 1, km: cur.km, l: cur.l, cost: tc.cost(cur) } : null),
                row('Last ' + TRIPS.KEEP + ' trips', tc.total('last', now)),
                row('Today', tc.total('today', now)),
                row('Last 7 days', tc.total('week', now)),
                row('Last 30 days', tc.total('month', now)),
                row('All recorded' + (tc.all.since ? ' (since ' + day(tc.all.since) + ' ' + new Date(tc.all.since).getFullYear() + ')' : ''), tc.total('all', now)),
            ];
            G.table(cv, t, 48, 108, 1504, [{ label: '', w: 470 }, { label: 'Trips', w: 130, align: 'right' }, { label: 'Distance', w: 220, align: 'right' },
                { label: 'Fuel', w: 200, align: 'right' }, { label: 'l/100 km', w: 200, align: 'right' }, { label: 'Cost', w: 284, align: 'right' }], rows, { rowH: 36, size: 24 });
            G.panel(cv, t, 24, 364, 1552, 148, 'Fuel price');
            titleButtons(cv, t, 'Fuel price', [{ label: 'Change', run: openPrice, key: 'price' }], 364);
            G.readout(cv, t, 48, 414, { text: tc.price ? tc.price.toFixed(2) : 'not set', unit: tc.price ? cu + ' a litre' : '', size: 56 });
            const tx = 560;
            cv.text((cv.own ? 'Change it with the knob or the buttons.' : 'The Fuel price button, then the knob.') + ' This trip, and trips that had no price, follow it; the others keep theirs.', tx, 426, 20, t.dim);
            cv.text(flow.k || sigDemo() ? 'Fuel: from the car\'s own fuel signal' : 'Fuel: from the engine unit until the car\'s fuel signal has learned its scaling', tx, 458, 20, t.dim);
            cv.text('A trip runs from the engine start until the engine has been off for 10 minutes.  Currency: Settings.', tx, 490, 20, t.dim);
        }

        /** a screen of your own: its gauges (the one chosen marked while browsing) */
        function drawScreen(cv, t, pg) {
            const sc = pg.screen, hint = browsing ? 30 : 0, L = SCR.layout(sc.layout);
            SCR.draw(cv, t, G, L, slotsOf(sc).map(slotData), { x: 24, y: 52, w: 1552, h: 460 - hint }, false, browsing ? cursor : -1, fit);
            // a gauge tapped or pressed: the choice of its value
            if (cv.own) SCR.boxes(L, 24, 52, 1552, 460 - hint, false).forEach((b, i) => cv.target(b.x, b.y, b.w, b.h, () => openGauge(i), 'gauge:' + i));
            if (browsing) cv.text('knob: choose a gauge  ·  press: its value and the layout  ·  push up / down: page', 800, 506, 20, t.dim, { align: 'center' });
        }

        let drawn = -1, btnPage = null, tabKeys = [];
        const groupOf = (x) => x.group;
        /** the next (d 1) or previous (-1) page of the group shown, round (Units: its unit's pages) */
        function turnPage(d) {
            const l = pages(), pg = current(), idx = [];
            l.forEach((x, j) => { if (x.group === pg.group && (pg.group !== 'units' || x.unit === pg.unit)) idx.push(j); });
            if (idx.length < 2) return;
            page = idx[(idx.indexOf(page) + d + idx.length) % idx.length]; cursor = 0;
            buttons(); changed();
        }
        /** header tab i: its first page; the tab shown: its next page (Units on a unit's page: back to the list) */
        function openTab(i, fromKnob) {
            const key = tabKeys[i], pg = current(), l = pages();
            if (!key) return;
            dropInline();
            if (pg.group === key && !fromKnob) {
                if (key === 'units' && pg.unit) { page = l.findIndex((x) => x.group === 'units' && !x.unit); cursor = 0; buttons(); changed(); return; }
                turnPage(1); return;
            }
            const j = l.findIndex((x) => x.group === key);
            if (j >= 0) { page = j; cursor = 0; buttons(); changed(); }
        }
        if (ctx.onTab) ctx.onTab((i) => { try { openTab(i); } catch (e) { log.warn('tab: ' + e); } });
        // a finger dragged on a list or the controller turned on it (cv.scroll): the list moves
        if (ctx.onScroll) ctx.onScroll((dy) => {
            const pg = current();
            if (!pg.unit && pg.group !== 'energy') return false;
            const s = scrollOf(pg), y = G.clamp(s.y + dy, 0, s.max), moved = y !== s.y;
            s.y = y;
            if (moved) changed();
            return moved;
        });
        if (ctx.onLayout) ctx.onLayout(() => changed());
        async function render(force) {
            // a screen of your own every frame (its gauges glide), the rest when something changed (busy: the scan's moving bar)
            const pg0 = current();
            if (!force && drawn === version && !busy && !gliding && !pg0.screen && !(sweep && pg0.unit === sweep.u)) return;
            drawn = version;
            gliding = false;
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            if (!!cv.own !== scrolls) {
                // the kit runs the screen now, or no longer: lists scroll or are paged; the same list stays shown
                const g = pg0.group, u = pg0.unit;
                scrolls = !!cv.own; pagesCache = null;
                page = Math.max(0, pages().findIndex((x) => x.group === g && x.unit === u));
                cursor = 0;
            }
            const pg = current();
            if (pg !== btnPage) { btnPage = pg; buttons(); }       // the buttons of the page now (also after the knob changed it)
            if (inline) inline.draw(cv, t);
            else if (pg.screen) drawScreen(cv, t, pg);
            else if (pg.group === 'trips') drawTrips(cv, t, pg);
            else if (pg.group === 'signals') drawSignals(cv, t, pg);
            else if (pg.group === 'energy') drawEnergy(cv, t, pg);
            else if (pg.group === 'engine') drawEngine(cv, t, pg);
            else if (pg.unit) drawUnit(cv, t, pg);
            else drawUnits(cv, t);
            const pp = (x) => (x.n > 1 ? ' ' + (x.p + 1) + '/' + x.n : '');
            // [this page's tab?, label, key]
            const tabs = [[pg.group === 'gauges', pg.screen ? (pg.blank ? 'New screen' : 'Gauges' + pp(pg)) : 'Gauges', 'gauges']];
            if (tripsOn()) tabs.push([pg.group === 'trips', 'Trips', 'trips']);
            tabs.push([pg.group === 'signals', 'Signals' + (pg.group === 'signals' ? pp(pg) : ''), 'signals'],
                [pg.group === 'energy', 'Energy' + (pg.group === 'energy' ? pp(pg) : ''), 'energy'],
                [pg.group === 'engine', 'Engine' + (pg.group === 'engine' ? pp(pg) : ''), 'engine'],
                [pg.group === 'units', pg.group === 'units' && pg.unit ? ECU[pg.unit.addr] ? ECU[pg.unit.addr].split(' ')[0] + pp(pg) : 'Unit' + pp(pg) : 'Units', 'units']);
            tabKeys = tabs.map((x) => x[2]);
            const isDemo = (x) => (x.isSig ? !(x.sig && x.sig.tc) && sigDemo() : !!(x.unit && x.unit.demo));      // the trip computer's: always the car's
            const demoNow = pg.group === 'trips' ? false : pg.screen ? screenItems(pg.screen).some(isDemo) : pg.group === 'signals' ? sigDemo()
                : pg.group === 'energy' ? energyView().some((r) => r.unit && r.unit.demo)
                : pg.unit ? !!pg.unit.demo : demoUnits || (!units.length && useDemo());
            G.frame(cv, t, tabs.map((x) => x[1]), Math.max(0, tabs.findIndex((x) => x[0])),
                [demoNow && { text: 'DEMO' }, browsing && { text: 'KNOB', color: 'accent' }]);
            await ui.image('MAIN_GFX', cv);
        }

        /* ---------- home-screen widget: the screen Settings names ---------- */
        // big widget: a picture of its gauges (the HMI crops about 5 % of each edge, app.json startWidget.safe
        // keeps clear of that); small one: its values as the layout's text lines (it shows no picture)
        const wrec = {}, wcan = {}, wtext = {}, wlast = {};
        const wvalue = (d) => (G.isNum(d.n) ? SCR.numText(d) + (d.u ? ' ' + d.u : '') : d.text);
        function widgetCells(inst, sc) {
            const on = !inst.big, list = on && sc ? slotsOf(sc).map(slotData).filter((d) => !d.empty) : [];
            // one short line per text cell (each shows about 20 characters)
            const line = (d) => { if (!d) return ''; const v = wvalue(d); return SCR.short(d.name).slice(0, Math.max(4, 21 - v.length)) + ' ' + v; };
            const first = list[0], frac = first && G.isNum(first.n) ? G.clamp((first.n - first.sc.min) / (first.sc.max - first.sc.min), 0, 1) : null;
            const cells = {
                Title: [on ? 'Live Data' : '', 'Text'],
                TextRecordings: [on ? (sc ? line(list[0]) : 'Make a screen in the app') : '', 'Text'],
                TextCam: [on ? line(list[1]) : '', 'Text'],
                TimeElapsed: [on ? line(list[2]) : '', 'Text'],
                TimeRemaining: [on ? line(list[3]) : '', 'Text'],
                ProgressbarVisible: [on && frac !== null, 'Bool'],
                // the layout's progress bar takes a share 0..1 (a percentage showed it full at any value)
                Progress: [on && frac !== null ? Math.round(frac * 100) / 100 : 0, 'Float'],
            };
            const prev = wtext[inst.spawnId] || (wtext[inst.spawnId] = {});
            Object.keys(cells).forEach((k) => {
                const v = JSON.stringify(cells[k][0]);
                if (prev[k] === v) return;
                prev[k] = v;
                ctx.widget.set(inst.spawnId, k, cells[k][0], cells[k][1]);
            });
        }
        function renderWidget(inst) {
            // one out of sight: again every few seconds only (in case the HMI's "shown" never comes)
            if (!inst.visible && Date.now() - (wlast[inst.spawnId] || 0) < 3000) return null;
            wlast[inst.spawnId] = Date.now();
            const sc = widgetScreen();
            widgetCells(inst, sc);
            if (!inst.big) return null;
            const sw = ctx.spec.startWidget || {}, [w, h] = sw.size || [384, 256], key = w + 'x' + h;
            const scale = sw.scale || 1, rec = (wrec[key] || (wrec[key] = new Recorder(w, h, { textScale: scale }))).reset(), t = ctx.theme();
            const box = SCR.widgetBox(w, h, sw.safe, settings.get('widgetFit'));      // clear of the edges the HMI crops and fades
            if (sc) SCR.draw(rec, t, G, SCR.layout(sc.layout), slotsOf(sc).map(slotData), box, true, -1, fit);
            else {
                const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
                rec.text('Live Data', cx, cy - 6, 30, t.text, { align: 'center', font: 'bold' });
                rec.text(fit(rec, screens.length ? 'No Gauges ' + settings.get('widget') + ' (Settings)' : 'Make a screen in the app first', 16, box.w), cx, cy + 24, 16, t.text, { align: 'center' });
            }
            const cv = (wcan[key] || (wcan[key] = new ScaledCanvas(w, h, scale))).clear([0, 0, 0, 0]);
            play(rec.words(), cv);
            return cv.canvas;
        }
        if (ctx.widget) {
            ctx.widget.loop(() => settings.get('widgetFps') || 8, renderWidget);
            ctx.widget.onChange((why) => { if (why === 'resized' || why === 'placed') Object.keys(wtext).forEach((k) => delete wtext[k]); });
            // a tap opens the app (kit/mgu.js): on the widget's screen
            ctx.widget.onTap(() => {
                const i = pages().findIndex((x) => x.screen && x.screen === widgetScreen());
                if (i >= 0) { page = i; cursor = 0; dropInline(); changed(); }
            });
        }

        var loop = ctx.loop('MAIN', 4, () => render(false));
        let scannedOnOpen = false;
        const maybeAuto = () => {
            if (scannedOnOpen || !settings.get('autoScan')) return;
            scannedOnOpen = true;
            setTimeout(scanUnits, 1500);        // give the diagnostic link's availability a moment
        };
        const redraw = () => { changed(); setTimeout(changed, 600); };
        ui.onVisible((name, on) => {
            if (name !== 'MAIN') return;
            if (on) { maybeAuto(); redraw(); buttons(); } else { link.cancel(); browse(false); }
        });
        if (ui.onFocus) ui.onFocus((name, on) => { if (name === 'MAIN' && on) redraw(); });
        if (ui.isVisible('MAIN')) maybeAuto();
        settings.onChange((key) => {
            // the ranges, peaks and traces so far are in the unit shown before
            if (key === 'tempUnit') { ranges.clear(); peaks.clear(); traces.clear(); }
            relayout();
        });
        buttons();
        render(true).then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
