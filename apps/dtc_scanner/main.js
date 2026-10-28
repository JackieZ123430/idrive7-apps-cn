'use strict';
/**
 * Fault Scanner - reads the fault memory of every control unit over the head
 * unit's diagnostic transport (TASU, see diag.js) and can clear it.
 *
 *   Scan  : UDS 19 02 <mask> to all ECUs (0xDF), like BMW's own teleservice
 *           job READ_PRIMARY_DTCS; optional info memory 19 17 <mask> 01.
 *   Clear : UDS 14 FF FF FF to each control unit that reported faults
 *           (press twice to confirm), then scans again.
 *   Check Control: the active messages from CheckControlMaster, named via the
 *           cluster's KombiInterface_2 lists.
 *
 * Pages: faults (6 per page) -> Check Control -> control units that answered.
 * Fault codes are BMW hex codes (as BMW's diagnostic tools show them); the head unit has no
 * text database for them, so look them up by code + control unit.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { fitText } = require('./kit/text-layout');
const { Diag, parseDtcReply, statusInfo, hex, NRC } = require('./kit/diag');
const DEMO = require('./demo');

const W = 1600, H = 520, PER_PAGE = 6;
const GO = '#2fd27a';

// diagnostic addresses -> control unit (unknown ones show as "ECU 0x.."). The G20 entries are the
// car's own SVT (E-Sys / BimmerCode backup of a G20 330e: base variant per address); the rest are
// F-series addresses for other cars.
const ECU = {
    0x01: 'ACSM airbag', 0x06: 'ICAM cameras', 0x07: 'SME HV battery', 0x08: 'SRR corner radar',
    0x0D: 'HKFM tailgate', 0x10: 'BDC gateway', 0x12: 'DME engine', 0x13: 'DME 2', 0x14: 'OBC charger',
    0x18: 'EGS gearbox', 0x1D: 'TFM fuel tank', 0x20: 'SRR corner radar', 0x21: 'FRR front radar',
    0x23: 'SAS assist sensors', 0x28: 'SRR corner radar', 0x29: 'DSC brakes', 0x2A: 'SRR corner radar',
    0x2C: 'USS park sensors', 0x30: 'EPS steering', 0x37: 'RAM audio', 0x38: 'VTG xDrive',
    0x39: 'DSC brake booster', 0x3A: 'EME e-motor', 0x40: 'BDC body', 0x43: 'FLM headlight',
    0x44: 'FLM headlight', 0x45: 'DCS driver camera', 0x56: 'FZD roof', 0x5D: 'KAFAS camera',
    0x5E: 'GWS gear selector', 0x60: 'KOMBI cluster', 0x61: 'ATM telematics', 0x63: 'Head unit',
    0x64: 'PDC parking', 0x67: 'ZBE controller', 0x6D: 'SM seat module', 0x76: 'VDP dampers',
    0x78: 'IHKA climate',
};
// Fault texts, first match wins:
//  1. dtc_texts.js   this car's own coding tool export (kit/tools/dtc_texts.py; not in git)
//  2. known_texts.js a few hand-written ones (in git)
//  3. dtc_db/        a fault text database imported with kit/tools/dtc_texts.py --db (not in git: it is
//                    BMW's). Each unit's SGBD index (UDS 22 F1 50, what BMW's diagnostic tools identify it by)
//                    picks its texts: sgbd_index.json "<address> <index>" -> texts/<SGBD>.json;
//                    dtc_texts.json there holds "<address>:<code>" ones; unit_names.json names the unit.
//  4. dtc_db/code_texts.json  a fault code list (kit/tools/dtc_texts.py --codes) for faults with no
//                    text above: "<code>": text (any unit) or { "<address>": text } (those units only).
//  5. dtc_db/tables/ fault text tables (kit/tools/dtc_tables.py; BMW's, not in git), split so only the
//                    units that report faults are read: variant/<sgbd>.json the text for exactly that
//                    unit type, addr/<address>.json the text all types at that address agree on (both
//                    before 3.), codes.json code-only texts and ambiguous.json "<code>": how many
//                    different texts a code has (when nothing else knows it).
// The build packs dtc_db/ into one compressed file, dtc_db.pack (kit/runtime/pack.js): ~19 MB of
// texts take ~3.5 MB, and a lookup inflates only the few KB that hold its code.
const DB = require('./kit/pack').open(path.join(__dirname, 'dtc_db'));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } };
const req = (m) => { try { return require(m); } catch (e) { return {}; } };
const OWN = Object.assign({}, req('./known_texts'), req('./dtc_texts'));
const text = (key) => OWN[key] || DB.get('dtc_texts.json', key);
const SGBD = DB.json('sgbd_index.json');
const UNIT_NAMES = DB.json('unit_names.json');
const HAS_DB = Object.keys(SGBD).length > 0;
let ids = {};                     // "12" -> "0F26E8" (unit's SGBD index); '' = asked, gave none
const variant = (a) => {
    const v = ids[hex(a)] ? SGBD[hex(a) + ' ' + ids[hex(a)]] : null;
    return v && /^[A-Za-z0-9_]+$/.test(v) ? v : null;
};
// Normalize legacy German names, but preserve Unicode from translated/OEM text.
const ascii = (s) => String(s).replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/Ä/g, 'Ae')
    .replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss').replace(/[\x00-\x1f\x7f]/g, '');
// a summary where the texts for a unit family differ in wording but agree on the fault
// (not an exact BMW text)
const FAMILY = {
    '23:D1C604': 'Assist sensors: Unexpected Ethernet communication/link',
    '61:03178A': 'Telematics: Mobile network connection limited',
};
function describe(addr, rawCode) {
    const code = String(rawCode).trim().toUpperCase().replace(/^0X/, '').padStart(6, '0');
    const key = hex(addr) + ':' + code;
    const own = text(key);
    if (own) return ascii(own);
    const v = variant(addr);
    // exactly this unit type's text, else the one all unit types at this address agree on
    const iv = (v && DB.get('tables/variant/' + v.toLowerCase() + '.json', code)) || DB.get('tables/addr/' + hex(addr) + '.json', code);
    if (iv) return ascii(iv);
    const t = (v && DB.get('texts/' + v + '.json', code)) || text('*:' + code);   // "*:<code>": any unit
    if (t) return ascii(t);
    const c = DB.get('code_texts.json', code);
    const ct = (typeof c === 'string' ? c : c && c[hex(addr)]) || DB.get('tables/codes.json', code) || FAMILY[key];
    if (ct) return ascii(ct);
    // several different texts and the unit type unknown: say so rather than guess
    const n = DB.get('tables/ambiguous.json', code);
    return n > 0 ? n + ' possible texts (depends on unit type)' : null;
}
// a unit the database identified is named by what it is (same on every model); else the address table
const ecuName = (a) => {
    const v = variant(a);
    return (v && UNIT_NAMES[v] && ascii(UNIT_NAMES[v])) || ECU[a] || v || ('ECU 0x' + hex(a));
};

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const diag = await new Diag(ctx.signals, log).init();

        /* ---------- state ---------- */
        const FILE = path.join(ctx.dataDir, 'last_scan.json');
        let scan = null;              // { at, demo, ecus: [{ addr, dtcs: [{code,status,mem}], nrc }] }
        try { scan = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { /* none yet */ }
        const IDS = path.join(ctx.dataDir, 'ecu_ids.json');
        ids = readJson(IDS);
        let phase = 'idle', msg = '', replies = 0, busy = false, version = 0;
        const changed = () => { version++; loop && loop.kick(); };
        const useDemo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !diag.available);

        /* ---------- Check Control ---------- */
        const cc = new Map();          // ccmId -> { ecu, reason }
        const ccNames = new Map();     // id -> { name, color }
        const walk = (o, fn) => {
            if (!o || typeof o !== 'object') return;
            if (Array.isArray(o)) { o.forEach((x) => walk(x, fn)); return; }
            fn(o);
            Object.keys(o).forEach((k) => { if (o[k] && typeof o[k] === 'object') walk(o[k], fn); });
        };
        const names = (v) => walk(v, (o) => {
            const id = o.cCIdentifer !== undefined ? o.cCIdentifer : o.cCIdentifier;
            const nm = o.cCShortName || o.cCName;
            if (id !== undefined && nm) { ccNames.set(id, { name: String(nm), color: o.cCColor }); changed(); }
        });
        ctx.signals.watch('de.bmw.infotainment.checkcontrol.CheckControlMaster', '1', {
            basicList: (v) => walk(v, (o) => {
                if (o.ccmId === undefined) return;
                const on = o.activeState === 'AKTIV' || o.activeState === 0;
                if (on) cc.set(o.ccmId, { ecu: o.requestorDiagAddr, reason: String(o.reason) }); else cc.delete(o.ccmId);
                changed();
            }),
        }, log);
        ctx.signals.watch('de.bmw.infotainment.KombiInterface_2', '1', { ccList: names, newCCMessage: names }, log);

        /* ---------- scan / clear ---------- */
        async function doScan() {
            if (busy) return;
            busy = true; phase = 'scanning'; replies = 0; msg = ''; changed();
            ui.text('BTN_SCAN', 'Scanning...');
            try {
                if (useDemo()) {
                    for (let i = 1; i <= DEMO.ecus.length; i++) { await new Promise((r) => setTimeout(r, 180)); replies = i; changed(); }
                    scan = { at: Date.now(), demo: true, ecus: JSON.parse(JSON.stringify(DEMO.ecus)) };
                } else {
                    const mask = settings.get('scope') === 'all' ? 0xFF : 0x0C;
                    const byEcu = new Map();
                    const read = async (params, mem) => {
                        const res = await diag.functional(0x19, params, { onReply: (e, n) => { replies = Math.max(replies, n); changed(); } });
                        res.forEach((uds, addr) => {
                            const p = parseDtcReply(uds, params);
                            const e = byEcu.get(addr) || { addr, dtcs: [], nrc: null };
                            p.dtcs.forEach((d) => e.dtcs.push({ code: d.code, status: d.status, mem }));
                            if (!p.ok && mem === 'fault') e.nrc = p.nrc;
                            byEcu.set(addr, e);
                        });
                    };
                    await read([0x02, mask], 'fault');
                    // the info memory is extra: if it can't be read, keep the fault memory scan
                    let infoFailed = false;
                    if (settings.get('info')) {
                        msg = 'Reading info memory...'; changed();
                        try { await read([0x17, mask, 0x01], 'info'); } catch (e) { infoFailed = true; log.warn('info memory: ' + e); }
                    }
                    scan = { at: Date.now(), demo: false, ecus: Array.from(byEcu.values()), infoFailed };
                    try { fs.writeFileSync(FILE, JSON.stringify(scan)); } catch (e) { log.warn('save scan: ' + e); }
                    await identify(scan.ecus.map((e) => e.addr));
                }
                scan.ecus.sort((a, b) => b.dtcs.length - a.dtcs.length || a.addr - b.addr);
                const n = scan.ecus.reduce((s, e) => s + e.dtcs.length, 0);
                log.info('scan: ' + scan.ecus.length + ' control units, ' + n + ' faults');
                msg = !scan.ecus.length ? 'No control unit answered - ignition on?' : scan.infoFailed ? 'Info memory not read this time (unit busy) - scan again for it' : '';
                phase = 'done';
            } catch (e) {
                log.warn('scan failed: ' + e);
                phase = 'error'; msg = 'Scan failed: ' + e.message;
            }
            busy = false; page = 0;
            ui.text('BTN_SCAN', 'Scan again');
            changed();
        }

        /**
         * Ask every unit that answered the scan for its SGBD index once (22 F1 50), so the database can
         * give its faults a text and the unit its name; kept in data/ecu_ids.json (also the list of this
         * car's unit types). Read-only; a unit that refuses is not asked again, one that stays silent is.
         */
        async function identify(addrs) {
            const todo = HAS_DB ? addrs.filter((a) => ids[hex(a)] === undefined) : [];
            if (!todo.length) return;
            let i = 0;
            for (const a of todo) {
                msg = 'Identifying control units... ' + (++i) + '/' + todo.length; changed();
                try {
                    const r = await diag.physical(a, 0x22, [0xF1, 0x50], 3000,
                        (u) => (u[0] === 0x62 && u[1] === 0xF1 && u[2] === 0x50) || (u[0] === 0x7F && u[1] === 0x22));
                    if (!r) { log.info('unit ' + hex(a) + ': no answer to 22 F1 50 (asked again next scan)'); continue; }
                    ids[hex(a)] = r[0] === 0x62 && r.length >= 6 ? hex(((r[3] << 16) | (r[4] << 8) | r[5]) >>> 0, 6) : '';
                    log.info('unit ' + hex(a) + ': SGBD index ' + (ids[hex(a)] || 'none') + (variant(a) ? ' -> ' + variant(a) : ''));
                } catch (e) { log.warn('identify ' + hex(a) + ': ' + e); }
            }
            try { fs.writeFileSync(IDS, JSON.stringify(ids)); } catch (e) { log.warn('save ids: ' + e); }
            msg = '';
        }

        let clearArmed = null;
        const clearLabel = () => ui.text('BTN_CLEAR', clearArmed ? 'Yes, clear' : 'Clear all');
        async function doClear() {
            if (busy) return;
            const targets = scan ? scan.ecus.filter((e) => e.dtcs.some((d) => d.mem === 'fault')) : [];
            if (!targets.length) { msg = scan ? 'Nothing to clear' : 'Scan first, then clear'; changed(); return; }
            if (!clearArmed) {
                clearArmed = setTimeout(() => { clearArmed = null; clearLabel(); }, 5000);
                msg = 'Clears ' + targets.length + ' control unit(s) - press again within 5 s'; changed();
                return clearLabel();
            }
            clearTimeout(clearArmed); clearArmed = null; clearLabel();
            busy = true; phase = 'clearing'; changed();
            let ok = 0;
            for (const e of targets) {
                msg = 'Clearing ' + ecuName(e.addr) + '...'; changed();
                if (scan.demo) { await new Promise((r) => setTimeout(r, 400)); ok++; continue; }
                try {
                    const r = await diag.physical(e.addr, 0x14, [0xFF, 0xFF, 0xFF], 6000);
                    if (r && r[0] === 0x54) ok++;
                    else log.warn('clear ' + hex(e.addr) + ': ' + (r ? (r[0] === 0x7F ? NRC[r[2]] || hex(r[2]) : r.map((x) => hex(x)).join('')) : 'no answer'));
                } catch (err) { log.warn('clear ' + hex(e.addr) + ': ' + err); }
            }
            log.info('cleared ' + ok + '/' + targets.length);
            if (scan.demo) DEMO.ecus.forEach((e) => { e.dtcs = e.dtcs.filter((d) => d.mem !== 'fault' || (d.status & 1)); });
            busy = false;
            msg = 'Cleared ' + ok + ' of ' + targets.length + ' control unit(s) - scanning again';
            changed();
            await new Promise((r) => setTimeout(r, 1500));
            const keep = msg;
            await doScan();
            if (!msg) msg = keep.replace(' - scanning again', '');
            changed();
        }

        /* ---------- drawing ---------- */
        let page = 0;
        const faults = () => (scan ? [].concat(...scan.ecus.map((e) => e.dtcs.map((d) => Object.assign({ addr: e.addr }, d)))) : []);
        const pageCount = () => Math.max(1, Math.ceil(faults().length / PER_PAGE)) + 2;
        const when = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '. ' + p(d.getHours()) + ':' + p(d.getMinutes()); };
        const ccList = () => (scan && scan.demo ? DEMO.cc : Array.from(cc.entries()).map(([id, m]) => Object.assign({ id }, m, ccNames.get(id) || {})));

        /** txt cut with "..." to at most max px wide */
        function fit(cv, txt, size, max, opt) {
            return fitText(cv, txt, size, max, opt);
        }

        function tile(cv, t, x, label, value, sub, col) {
            G.panel(cv, t, x, 44, 374, 115, label);
            cv.text(value, x + 18, 142, 64, col, { font: 'num' });
            if (sub) cv.text(sub, x + 356, 142, 22, t.dim, { align: 'right' });
        }

        /** G20-style frame: tab bar with the page names along the top (fault pages share one tab). */
        function header(cv, t) {
            const fp = pageCount() - 2, sel = page < fp ? 0 : page === fp ? 1 : 2;
            G.frame(cv, t, ['Faults' + (fp > 1 ? '  ' + (Math.min(page, fp - 1) + 1) + '/' + fp : ''), 'Check Control', 'Control units'], sel,
                [(scan && scan.demo || (!scan && useDemo())) && { text: 'DEMO' }]);
        }

        function tiles(cv, t) {
            const f = faults(), active = f.filter((d) => d.status & 1).length, n = scan ? scan.ecus.length : null;
            const fm = f.filter((d) => d.mem === 'fault').length, im = f.length - fm;
            tile(cv, t, 24, 'Control units', phase === 'scanning' ? String(replies) : n === null ? '--' : String(n), phase === 'scanning' ? 'answering...' : 'answered', t.text);
            tile(cv, t, 414, 'Faults', scan ? String(fm) : '--', im ? '+ ' + im + ' info' : 'stored', !scan ? t.dim : fm ? t.warn : GO);
            tile(cv, t, 804, 'Active now', scan ? String(active) : '--', 'present right now', !scan ? t.dim : active ? t.crit : GO);
            const c = ccList().length;
            tile(cv, t, 1194, 'Check Control', String(c), 'messages', c ? t.warn : GO);
        }

        function listPanel(cv, t, title) {
            G.panel(cv, t, 24, 176, 1552, 336, title);
            let right = msg;
            if (!right && scan) right = 'Last scan ' + when(scan.at);
            if (phase === 'scanning' || phase === 'clearing') {
                const w = 300, x = 1552 - w, f = ((Date.now() / 1200) % 1);
                cv.roundRect(x, 195, w, 8, 4, t.track);
                cv.roundRect(x + f * (w - 80), 195, 80, 8, 4, t.accent);
                if (!msg) right = phase === 'scanning' ? 'Asking every control unit...' : '';
                cv.text(right, x - 20, 212, 22, t.text, { align: 'right' });
            } else if (right) {
                cv.text(right, 1552, 212, 22, phase === 'error' ? t.crit : t.dim, { align: 'right' });
            }
        }

        function drawFaults(cv, t) {
            const f = faults(), pages = Math.max(1, Math.ceil(f.length / PER_PAGE));
            listPanel(cv, t, 'Faults' + (pages > 1 ? '  ' + (page + 1) + '/' + pages : ''));
            if (!scan) {
                cv.text(phase === 'scanning' ? 'Scanning...' : 'Press "Scan now" (ignition on)', 800, 369, 32, t.dim, { align: 'center' });
                return;
            }
            if (!f.length && phase !== 'scanning') {
                cv.circle(800, 327, 40, withAlpha(GO, 0.2));
                cv.polyline([[782, 327], [796, 342], [820, 312]], 7, GO);     // check mark ('✓' isn't in the baked fonts)
                cv.text(scan.ecus.length ? 'No faults stored' : 'No answer', 800, 433, 32, t.text, { align: 'center', font: 'bold' });
                return;
            }
            f.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE).forEach((d, i) => {
                const y = 231 + i * 47;
                const s = statusInfo(d.status), col = t[s.sev] || t.dim;
                cv.roundRect(48, y, 170, 34, 6, withAlpha(col, 0.22));
                cv.text(s.label, 133, y + 25, 20, col, { align: 'center', font: 'bold', spacing: 0.5 });
                cv.text(d.code, 246, y + 28, 32, t.text, { font: 'bold', spacing: 1 });
                cv.text(fit(cv, ecuName(d.addr), 26, 680 - 420 - 16), 420, y + 27, 26, t.text);
                // the fault's text when known (cut to fit)
                const desc = describe(d.addr, d.code);
                const txt = desc ? (d.mem === 'info' ? 'INFO: ' : '') + desc : d.mem === 'info' ? 'INFO MEMORY' : '';
                if (txt) cv.text(fit(cv, txt, 22, 1552 - 680), 680, y + 27, 22, t.dim);
                if (i < PER_PAGE - 1) cv.fillRect(48, y + 40, 1504, 1, withAlpha(t.tick, 0.25));
            });
        }

        function drawCC(cv, t) {
            listPanel(cv, t, 'Check Control messages');
            const l = ccList();
            if (!l.length) { cv.text('No active Check Control messages', 800, 369, 30, t.dim, { align: 'center' }); return; }
            const COL = { RED: t.crit, YELLOW: t.warn, ORANGE: t.warn, GREEN: GO, WHITE: t.text };
            l.slice(0, PER_PAGE).forEach((m, i) => {
                const y = 231 + i * 47;
                cv.circle(66, y + 18, 9, COL[m.color] || t.dim);
                cv.text(m.name || 'Message ' + m.id, 92, y + 27, 28, t.text, { font: 'bold' });
                if (m.ecu !== undefined) cv.text(fit(cv, ecuName(m.ecu), 22, 420), 1552, y + 27, 22, t.dim, { align: 'right' });
                if (i < PER_PAGE - 1) cv.fillRect(48, y + 40, 1504, 1, withAlpha(t.tick, 0.25));
            });
            if (l.length > PER_PAGE) cv.text('+ ' + (l.length - PER_PAGE) + ' more', 1552, 506, 22, t.dim, { align: 'right' });
        }

        function drawEcus(cv, t) {
            listPanel(cv, t, 'Control units that answered');
            const l = scan ? scan.ecus.slice().sort((a, b) => a.addr - b.addr) : [];
            if (!l.length) { cv.text(scan ? 'No control unit answered' : 'Scan first', 800, 369, 30, t.dim, { align: 'center' }); return; }
            const cols = 5, cw = 296, ch = 55;
            l.slice(0, cols * 5).forEach((e, i) => {
                const x = 48 + (i % cols) * (cw + 8), y = 233 + Math.floor(i / cols) * ch;
                const act = e.dtcs.some((d) => d.status & 1), n = e.dtcs.length;
                const col = act ? t.crit : n ? t.warn : GO;
                cv.roundRect(x, y, cw, ch - 6, 6, withAlpha(col, 0.12));
                cv.fillRect(x, y, 5, ch - 6, col);
                cv.text(fit(cv, ecuName(e.addr), 22, cw - 120, { font: 'bold' }), x + 18, y + (e.nrc ? 23 : 32), 22, t.text, { font: 'bold' });
                if (e.nrc) cv.text(NRC[e.nrc] || 'NRC ' + hex(e.nrc), x + 18, y + 44, 20, t.dim);
                cv.text(n ? n + (n === 1 ? ' fault' : ' faults') : 'OK', x + cw - 12, y + 32, 22, col, { align: 'right', font: 'bold' });
            });
        }

        let drawn = -1;
        async function render(force) {
            if (!force && drawn === version && phase !== 'scanning' && phase !== 'clearing') return;
            drawn = version;
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const fp = pageCount() - 2;
            page = Math.min(page, pageCount() - 1);
            tiles(cv, t);
            if (page < fp) drawFaults(cv, t); else if (page === fp) drawCC(cv, t); else drawEcus(cv, t);
            header(cv, t);
            await ui.image('MAIN_GFX', cv);
        }

        ui.onClick('BTN_SCAN', () => { doScan(); });
        ui.onClick('BTN_CLEAR', () => { doClear(); });
        ui.onClick('BTN_PAGE', () => { page = (page + 1) % pageCount(); changed(); });
        // tabs: Faults (its pages: tapped again, or pushed through with the controller), Check Control, Control units
        ctx.onTab((i, step) => {
            const fp = pageCount() - 2;
            if (step > 0 && page < fp - 1) page++;
            else if (step < 0 && page > 0 && page < fp) page--;
            else if (step < 0 && page === fp) page = fp - 1;
            else if (i === 0 && !step && page < fp) page = (page + 1) % fp;
            else page = i === 0 ? 0 : fp + i - 1;
            changed();
        });

        var loop = ctx.loop('MAIN', 2, () => render(false));
        let scannedOnOpen = false;
        const maybeAuto = () => {
            if (scannedOnOpen || !settings.get('autoScan')) return;
            scannedOnOpen = true;
            setTimeout(doScan, 1500);       // give TASU's availability a moment
        };
        // back from Settings or an HMI popup: draw again at once, and once more when the renderer's surface
        // is up - this app only draws when something changed, so the screen would otherwise stay empty
        // until the next change (e.g. Next page)
        const redraw = () => { changed(); setTimeout(changed, 600); };
        ui.onVisible((name, on) => { if (name === 'MAIN' && on) { maybeAuto(); redraw(); } });
        if (ui.onFocus) ui.onFocus((name, on) => { if (name === 'MAIN' && on) redraw(); });
        if (ui.isVisible('MAIN')) maybeAuto();
        settings.onChange(() => changed());
        if (scan) ui.text('BTN_SCAN', 'Scan again');
        render(true).then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
