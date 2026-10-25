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
 * Read-only: the head unit offers no service reset on these cars (the reset is done in the
 * instrument cluster / by the workshop), so this app doesn't write anything.
 */
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');

const W = 1600, H = 520, PER_PAGE = 5;
const GO = '#2fd27a';
const KOMBI = 'de.bmw.infotainment.KombiInterface_2';
const COLORS = { DEFAULT: 0, RED: 1, YELLOW: 2, GREEN: 3, ORANGE: 4 };

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
const txt = (s) => String(s === undefined || s === null ? '' : s).replace(/[^\x20-\x7e]/g, (ch) => ({ 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue', 'ß': 'ss' }[ch] || '')).trim();

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
            s = String(s);
            if (cv.textWidth(s, size, opt) <= max) return s;
            while (s.length > 4 && cv.textWidth(s + '...', size, opt) > max) s = s.slice(0, -1);
            return s.trim() + '...';
        }

        function drawMain(cv, t, its) {
            const s = summary();
            const red = its.filter((i) => i.colour === 1).length, soon = its.filter((i) => i.colour === 2 || i.colour === 4).length;
            tile(cv, t, 24, 760, 'Next service', s ? s.way || s.date || '--' : '--', s ? fit(cv, s.text, 22, 380) : 'waiting for the car', s ? COL(t, s.colour) : t.dim);
            tile(cv, t, 804, 374, 'Due soon', String(soon), 'items', soon ? t.warn : GO);
            tile(cv, t, 1198, 378, 'Due now', String(red), 'items', red ? t.crit : GO);
            G.panel(cv, t, 24, 176, 1552, 336, 'Service requirements' + (its.length > PER_PAGE ? '  ' + (Math.floor(sel / PER_PAGE) + 1) + '/' + Math.ceil(its.length / PER_PAGE) : ''));
            if (!its.length) {
                cv.text('Waiting for the service data from the instrument cluster (ignition on)...', 800, 369, 28, t.dim, { align: 'center' });
                return;
            }
            const per = hint ? PER_PAGE - 1 : PER_PAGE;          // the details line takes the last row
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
            if (hint) {
                cv.roundRect(40, 470, 1520, 38, 8, withAlpha(t.accent, 0.12));
                cv.text(fit(cv, hint.name + ':  ' + hint.text, 22, 1490), 56, 496, 22, t.text);
            } else if (msg) cv.text(msg, 1552, 212, 22, t.dim, { align: 'right' });
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

        ui.onClick('BTN_SELECT', () => { const n = items().length; if (n) sel = (sel + 1) % n; hint = null; changed(); });
        ui.onClick('BTN_DETAILS', () => { details(); });
        ui.onClick('BTN_PAGE', () => { page = (page + 1) % pages().length; changed(); });

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
