'use strict';
/**
 * Service - the car's service requirements (BMW Condition Based Service, CBS), as the iDrive's own
 * "Vehicle status > Service requirements" shows them.
 *
 *   Source : the instrument cluster's KombiInterface_2 over SOME/IP (what the HMI itself reads):
 *            cbsDataServiceList - one entry per item: id, colour, name, distance and date (texts the
 *            car formats in its own language and units); cbsDataSBA - the summary (next service).
 *   Details: requestCBSServiceHint(id) - the item's service hint text, as the iDrive's detail view.
 *
 * Reset (setting "Service reset", off by default): the instrument cluster's own CBS reset over UDS,
 * byte for byte what the workshop tool's CBS_RESET job sends (taken from a reset on a G20 330e):
 *   which items may be reset : 22 10 02 -> 3 bytes per item: id, reason it is blocked (0 = none), reserve
 *   reset one item           : 2E 10 01  01 <id> 64 1F 8000 0F FF 0F 3F FF 00
 *                              (1 item, availability 100 %, service count +1, everything else unchanged:
 *                              the cluster works out the new date / distance itself)
 *   check                    : 22 10 01 -> 12 bytes per item: id, .., [5] availability %, [4]&0x1F count
 * Only brake fluid (0x03) and the vehicle check (0x64) - the items kept in the cluster that were tried -
 * and only when the cluster itself reports no reason against it. Select the item with "Next item",
 * press "Reset service", then "Reset service" again within 15 s to confirm.
 */
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { Diag, hex, NRC } = require('./kit/diag');
const { fitText } = require('./kit/text-layout');

const W = 1600, H = 520, PER_PAGE = 5;
const GO = '#2fd27a';
const KOMBI = 'de.bmw.infotainment.KombiInterface_2';
const COLORS = { DEFAULT: 0, RED: 1, YELLOW: 2, GREEN: 3, ORANGE: 4 };
const KOMBI_ECU = 0x60;
const RESETTABLE = { 0x03: 'Brake fluid', 0x64: 'Vehicle check' };
const CONFIRM_MS = 15000;

/**
 * the object holding `key` somewhere inside v (unions arrive wrapped in their member's name). With
 * str: only where that key is a text - the hint answer nests { cBSServiceHint: { cBSServiceHint: "..." } }
 */
function find(v, key, str) {
    if (!v || typeof v !== 'object') return null;
    if (key in v && (!str || typeof v[key] === 'string')) return v;
    for (const k of Object.keys(v)) { const r = find(v[k], key, str); if (r) return r; }
    return null;
}
/** JSON without the item icons (each answer carries a PNG as a long list of byte numbers) */
const brief = (v) => JSON.stringify(v, (k, x) => (k === 'symbolData' ? '[icon]' : x));
const colour = (c) => (typeof c === 'number' ? c : COLORS[String(c)] !== undefined ? COLORS[String(c)] : 0);
const txt = (s) => String(s === undefined || s === null ? '' : s).replace(/[^\x20-\x7e]/g, (ch) => ({ 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue', 'ß': 'ss' }[ch] || ch)).replace(/[\x00-\x1f\x7f]/g, '').trim();

const DEMO = {
    list: [
        { id: 1, colour: 3, name: 'Engine oil', way: '12 300 km', date: '09/2027' },
        { id: 2, colour: 3, name: 'Front brakes', way: '21 800 km', date: '' },
        { id: 6, colour: 3, name: 'Rear brakes', way: '38 500 km', date: '' },
        { id: 3, colour: 2, name: 'Brake fluid', way: '', date: '11/2026' },
        { id: 17, colour: 3, name: 'Vehicle check', way: '9 800 km', date: '11/2027' },
        { id: 32, colour: 3, name: 'Statutory vehicle inspection', way: '', date: '05/2028' },
    ],
    sba: { text: 'Engine oil', way: '12 300 km', date: '09/2027', colour: 3 },
};

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const sig = ctx.signals;
        let list = null, sba = null, rawList = '', rawSba = '';
        let kombi = null, sel = 0, page = 0, msg = '', hint = null, version = 0;
        const changed = () => { version++; };
        const useDemo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !list && !sba);

        /* ---------- reading ---------- */
        sig.watch(KOMBI, '1', {
            cbsDataServiceList: (v) => {
                rawList = brief(v);
                const arr = Array.isArray(v) ? v : (v && (v.cbsDataServiceList || v.value)) || [];
                list = arr.map((e) => {
                    const s = find(e, 'cBSIdentifier') || {};
                    return { id: s.cBSIdentifier, colour: colour(s.cBSColor), name: txt(s.cBSServcieName || s.cBSServiceName),
                        way: txt(s.cBSServiceWay), date: txt(s.cBSServiceDate) };
                }).filter((e) => e.id !== undefined && e.name);
                log.info('service list: ' + list.length + ' item(s)');
                changed();
            },
            cbsDataSBA: (v) => {
                rawSba = brief(v);
                const s = find(v, 'cBSDataSBAText') || {};
                sba = { text: txt(s.cBSDataSBAText), way: txt(s.cBSDataSBADistance), date: txt(s.cBSDataSBADate), colour: colour(s.cBSDataSBAColor) };
                changed();
            },
        }, log, { pollMs: 60000 }).then((r) => {
            kombi = r;
            if (r.error) log.warn('KombiInterface_2: ' + r.error);
        });

        const items = () => (useDemo() ? DEMO.list : list || []);
        const summary = () => (useDemo() ? DEMO.sba : sba);

        /* ---------- details (the iDrive's detail view) ---------- */
        async function details() {
            const it = items()[sel];
            if (!it) return;
            hint = { name: it.name, text: 'Asking the car...' };
            changed();
            try {
                if (useDemo()) {
                    hint.text = 'Service due ' + [it.way && 'in ' + it.way, it.date && 'by ' + it.date].filter(Boolean).join(' or ') + ' (demo)';
                    changed();
                    return;
                }
                if (!kombi || !kombi.proxy) throw new Error('instrument cluster not reachable');
                const r = await sig.call(kombi.proxy, 'requestCBSServiceHint', { id: it.id }, 6000);
                const h = find(r, 'cBSServiceHint', true) || {};
                hint.text = [txt(h.cBSServiceHint), txt(h.cBSServiceWay), txt(h.cBSServiceDate)].filter(Boolean).join('   ') || 'No details for this item';
                log.info('hint ' + it.id + ': ' + brief(r));
            } catch (e) {
                log.warn('requestCBSServiceHint ' + it.id + ': ' + e);
                hint.text = 'Details not available (' + (e.message || e) + ')';
            }
            changed();
        }

        /* ---------- reset (the cluster's own CBS reset, see the top of this file) ---------- */
        let diag = null, reset = null;          // reset: { items: [{id, name}], i, at, busy }
        const showMsg = (s) => { hint = null; msg = s; log.info("msg: " + s); changed(); };
        const nrc = (r) => (r && r[0] === 0x7F ? 'refused: ' + (NRC[r[2]] || '0x' + hex(r[2])) : 'no answer from the instrument cluster');
        async function link() {
            if (!diag) { diag = new Diag(sig, log); await diag.init(); }
            if (!diag.p) throw new Error('no diagnostic link (' + (diag.error || 'not available') + ')');
            return diag;
        }
        /** the cluster's CBS record: { id: {avail, count} } */
        async function readCbs(d) {
            const r = await d.physical(KOMBI_ECU, 0x22, [0x10, 0x01], 5000, (u) => u[0] !== 0x62 || u[1] === 0x10);
            if (!r || r[0] !== 0x62) throw new Error(nrc(r));
            const out = {};
            for (let i = 3; i + 12 <= r.length; i += 12) out[r[i]] = { avail: r[i + 5], count: r[i + 4] & 0x1F };
            return out;
        }
        /** "Reset service": the first press asks the cluster and arms the reset of the selected item; a
         *  second press within 15 s confirms it. Anything else (Next item, Details) disarms it. */
        async function resetPress() {
            if (settings.get('resetOn') !== true) return showMsg('Reset is off - turn on "Service reset" in Settings');
            if (useDemo()) return showMsg('No reset in demo mode');
            if (reset && reset.busy) return;
            if (reset && reset.item && Date.now() - reset.at < CONFIRM_MS) return doReset();
            const its = items(), cur = its[sel];
            showMsg('Asking the instrument cluster what can be reset...');
            try {
                const d = await link();
                const r = await d.physical(KOMBI_ECU, 0x22, [0x10, 0x02], 5000, (u) => u[0] !== 0x62 || u[1] === 0x10);
                if (!r || r[0] !== 0x62) throw new Error(nrc(r));
                const ok = [];
                for (let i = 3; i + 3 <= r.length; i += 3) {
                    if (RESETTABLE[r[i]] && r[i + 1] === 0) ok.push(r[i]);
                }
                log.info('resettable: ' + ok.map((x) => hex(x)).join(',') + ' (reply ' + r.map((x) => hex(x)).join(' ') + ')');
                if (!ok.length) { reset = null; return showMsg('The instrument cluster allows no reset right now'); }
                // the selected item, if it is one that can be reset; else the only one there is
                const id = cur && ok.includes(cur.id) ? cur.id : ok.length === 1 ? ok[0] : null;
                if (id === null) {
                    reset = null;
                    return showMsg('Select ' + ok.map((x) => RESETTABLE[x]).join(' or ') + ' with "Next item", then "Reset service"');
                }
                const name = (cur && cur.id === id && cur.name) || RESETTABLE[id];
                reset = { item: { id, name }, at: Date.now(), busy: false };
                showMsg('Reset ' + name + '?  Press "Reset service" again to confirm (15 s)');
            } catch (e) {
                reset = null;
                log.warn('reset list: ' + e);
                showMsg('Reset not available: ' + (e.message || e));
            }
        }
        async function doReset() {
            const it = reset.item;
            reset.busy = true;
            showMsg('Resetting ' + it.name + '...');
            try {
                const d = await link();
                const before = (await readCbs(d).catch(() => ({})))[it.id];
                const r = await d.physical(KOMBI_ECU, 0x2E,
                    [0x10, 0x01, 0x01, it.id, 0x64, 0x1F, 0x80, 0x00, 0x0F, 0xFF, 0x0F, 0x3F, 0xFF, 0x00], 6000,
                    (u) => u[0] !== 0x6E || u[1] === 0x10);
                log.info('reset ' + it.name + ': ' + (r ? r.map((x) => hex(x)).join(' ') : 'no reply'));
                if (!r || r[0] !== 0x6E) throw new Error(nrc(r));
                const after = (await readCbs(d).catch(() => ({})))[it.id];
                showMsg(it.name + ' reset' + (after ? ': ' + after.avail + ' %' + (before ? ', service ' + before.count + ' -> ' + after.count : '') : '')
                    + ' - the list updates within a minute');
            } catch (e) {
                log.warn('reset ' + it.name + ': ' + e);
                showMsg(it.name + ' NOT reset: ' + (e.message || e));
            } finally {
                reset = null;
            }
        }

        /* ---------- drawing ---------- */
        const pages = () => (settings.get('diagPage') ? ['Service', 'Diagnostics'] : ['Service']);
        const COL = (t, c) => [t.dim, t.crit, t.warn, GO, t.warn][c] || t.dim;
        const LBL = ['', 'DUE NOW', 'DUE SOON', 'OK', 'DUE SOON'];

        function tile(cv, t, x, w, label, value, sub, col) {
            G.panel(cv, t, x, 44, w, 115, label);
            cv.text(value, x + 18, 142, 44, col, { font: 'num' });
            if (sub) cv.text(sub, x + w - 18, 142, 22, t.dim, { align: 'right' });
        }

        function fit(cv, s, size, max, opt) {
            return fitText(cv, s, size, max, opt);
        }

        function drawMain(cv, t, its) {
            const s = summary();
            const red = its.filter((i) => i.colour === 1).length, soon = its.filter((i) => i.colour === 2 || i.colour === 4).length;
            tile(cv, t, 24, 760, 'Next service', s ? s.way || s.date || '--' : '--', s ? fit(cv, s.text, 22, 380) : 'waiting for the car', s ? COL(t, s.colour) : t.dim);
            tile(cv, t, 804, 374, 'Due soon', String(soon), 'items', soon ? t.warn : GO);
            tile(cv, t, 1198, 378, 'Due now', String(red), 'items', red ? t.crit : GO);
            G.panel(cv, t, 24, 176, 1552, 336, 'Service requirements' + (its.length > PER_PAGE ? '  ' + (Math.floor(sel / PER_PAGE) + 1) + '/' + Math.ceil(its.length / PER_PAGE) : ''));
            // the bottom line: an item's details, or what the last button did (reset)
            const line = hint ? hint.name + ':  ' + hint.text : msg;
            if (line) {
                cv.roundRect(40, 470, 1520, 38, 8, withAlpha(t.accent, 0.12));
                cv.text(fit(cv, line, 22, 1490), 56, 496, 22, t.text);
            }
            if (!its.length) {
                cv.text('Waiting for the service data from the instrument cluster (ignition on)...', 800, 369, 28, t.dim, { align: 'center' });
                return;
            }
            const per = line ? PER_PAGE - 1 : PER_PAGE;          // the bottom line takes the last row
            const first = Math.floor(sel / per) * per;
            its.slice(first, first + per).forEach((it, i) => {
                const y = 232 + i * 55, col = COL(t, it.colour);
                if (first + i === sel) cv.roundRect(40, y - 4, 1520, 50, 8, withAlpha(t.accent, 0.18));
                cv.roundRect(48, y + 4, 8, 34, 4, col);
                cv.text(fit(cv, it.name, 30, 720, { font: 'bold' }), 76, y + 32, 30, t.text, { font: 'bold' });
                cv.text(it.way || '--', 1040, y + 32, 30, it.way ? t.text : t.dim, { align: 'right', font: 'bold' });
                cv.text(it.date || '--', 1250, y + 32, 28, it.date ? t.text : t.dim, { align: 'right' });
                if (LBL[it.colour]) {
                    cv.roundRect(1310, y + 6, 230, 34, 6, withAlpha(col, 0.22));
                    cv.text(LBL[it.colour], 1425, y + 31, 20, col, { align: 'center', font: 'bold', spacing: 0.5 });
                }
            });
        }

        function drawDiag(cv, t) {
            G.panel(cv, t, 24, 44, 1552, 468, 'Diagnostics - what the instrument cluster sends');
            const lines = [
                'KombiInterface_2: ' + (kombi ? (kombi.error ? 'error ' + kombi.error : kombi.available ? 'available' : 'not available yet') : 'connecting...'),
                'cbsDataSBA: ' + (rawSba || 'nothing received'),
                'cbsDataServiceList (' + (list ? list.length + ' items' : 'nothing received') + '):',
            ];
            let y = 96;
            lines.forEach((l) => { cv.text(fit(cv, l, 20, 1500), 48, y, 20, t.text); y += 32; });
            const chunk = 120;
            for (let i = 0; i < rawList.length && y < 500; i += chunk) { cv.text(rawList.slice(i, i + chunk), 48, y, 18, t.dim, { font: 'label' }); y += 26; }
        }

        let drawn = -1;
        async function render(force) {
            if (!force && drawn === version) return;
            drawn = version;
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const its = items();
            sel = Math.min(sel, Math.max(0, its.length - 1));
            page = Math.min(page, pages().length - 1);
            if (page === 0) drawMain(cv, t, its); else drawDiag(cv, t);
            G.frame(cv, t, pages(), page, [useDemo() && { text: 'DEMO' }]);
            await ui.image('MAIN_GFX', cv);
        }

        // Next item: through the list; after the last item the diagnostics page (when it is on), then back
        ui.onClick('BTN_SELECT', () => {
            const n = items().length;
            reset = reset && reset.busy ? reset : null;         // any other button disarms a reset
            hint = null; msg = '';
            if (page > 0) { page = 0; sel = 0; } else if (n && sel + 1 < n) sel++;
            else if (pages().length > 1) page = 1; else sel = 0;
            changed();
        });
        ui.onClick('BTN_DETAILS', () => { reset = reset && reset.busy ? reset : null; msg = ''; details(); });
        ui.onClick('BTN_RESET', () => { resetPress(); });
        ctx.onTab((i) => { if (i !== page) { page = i; sel = 0; msg = ''; changed(); } });

        ctx.loop('MAIN', 2, () => render(false));
        // back from Settings or a popup: draw again (this app only draws when something changed)
        const redraw = () => { changed(); setTimeout(changed, 600); };
        ui.onVisible((name, on) => { if (name === 'MAIN' && on) redraw(); });
        if (ui.onFocus) ui.onFocus((name, on) => { if (name === 'MAIN' && on) redraw(); });
        settings.onChange(() => changed());
        setInterval(changed, 2000);         // the diagnostics page shows live status
        render(true).then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
