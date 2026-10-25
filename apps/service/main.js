'use strict';
/**
 * Service - when the car's services are due (BMW Condition Based Service, CBS), and resetting an
 * item after the service is done.
 *
 *   Items : oil service, front / rear brake pads, gearbox oil, particulate filter, spark plugs
 *           (ConditionBasedServicesLegacy: one message per item, with the remaining distance and
 *           the due date), plus the other items of the car's service list (ConditionBasedServices
 *           cBSList: brake fluid, vehicle check, inspection, ...).
 *   Reset : ConditionBasedServicesLegacy.cBSReset = { item code, "reset" } - what the car's own
 *           service menu does. Press "Reset item" twice within 5 s. Only items the car reported
 *           can be reset (its own item code is sent).
 *
 * Read over SOME/IP from the head unit (no diagnostic requests). Two things differ between models
 * and are shown raw on the Diagnostics page (Settings): whether the remaining distance comes in
 * km or 10 km steps ("Car sends distance in"), and the layout of the service list entries
 * (unnamed bytes: item code and distance as read here are the likely ones).
 */
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');

const W = 1600, H = 520, PER_PAGE = 5;
const GO = '#2fd27a';
const LEGACY = 'de.bmw.infotainment.ConditionBasedServicesLegacy';
const LIST = 'de.bmw.infotainment.cbs.ConditionBasedServices';
const MESSAGES = ['cBSMessageEngineOil', 'cBSMessageBrakeFront', 'cBSMessageBrakeRear', 'cBSMessageGearOil',
    'cBSMessageParticleFilter', 'cBSMessageSparkPlug'];

// item codes (IDScopeCBS in the car's interface catalog) -> name; both forms arrive (name or number)
const CODES = {
    OELSERVICE: 1, BREMSBELAEGE_V: 2, BREMSFLUESSIGKEIT: 3, MIKROFILTER: 4, BREMSBELAEGE_H: 6,
    DIESELPARTIKELFILTER: 7, GETRIEBEOEL: 9, ZUENDKERZEN_ADAPTIV: 10, NOX_ADDITIV: 13, ZUENDKERZEN: 16,
    SICHTPRUEFUNGEN: 17, KUEHLFLUESSIGKEIT: 18, H2_CHECK: 19, UEBERGABEDURCHSICHT: 20, EINFAHRKONTROLLE: 21,
    ADDITIV_FUER_DIESELPARTIKELFILTER: 22, WASSERFILTER: 23, HU_HAUPTUNTERSUCHUNG: 32, AU_ABGASUNTERSUCHUNG: 33,
    GETRIEBEOEL_HAUPTGETRIEBE: 35, SICHTPRUEFUNG_ADAPTIV: 100,
};
const NAMES = {
    1: 'Oil service', 2: 'Brake pads front', 3: 'Brake fluid', 4: 'Microfilter', 6: 'Brake pads rear',
    7: 'Particulate filter', 9: 'Gearbox oil', 10: 'Spark plugs', 13: 'AdBlue (NOx additive)', 16: 'Spark plugs',
    17: 'Vehicle check', 18: 'Coolant', 19: 'H2 check', 20: 'Delivery check', 21: 'Running-in check',
    22: 'Particulate filter additive', 23: 'Water filter', 32: 'Statutory inspection', 33: 'Emissions test',
    35: 'Gearbox oil (main)', 100: 'Vehicle check',
};
const NAME_OF_CODE = {};
Object.keys(CODES).forEach((k) => { NAME_OF_CODE[CODES[k]] = k; });
const code = (v) => (typeof v === 'number' ? v : CODES[String(v)] !== undefined ? CODES[String(v)] : null);
const valid = (c) => c !== null && c !== 0 && c !== 5 && c !== 65535 && NAMES[c] !== undefined;

/** member of a legacy message by its start: 'remainingMileage' -> remainingMileageCBSMessageEngineOil */
const pick = (v, start) => { const k = v && Object.keys(v).find((n) => n.indexOf(start) === 0); return k ? v[k] : undefined; };
const n8 = (x) => (typeof x === 'number' ? x : null);

const DEMO = [
    { code: 1, raw: 4200, date: { d: 255, m: 9, y: 27 } },
    { code: 2, raw: 21800, date: null },
    { code: 6, raw: 38500, date: null },
    { code: 3, raw: 65535, date: { d: 255, m: 3, y: 27 } },
    { code: 17, raw: 9800, date: { d: 255, m: 11, y: 26 } },
    { code: 32, raw: 65535, date: { d: 255, m: 5, y: 28 } },
];

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const sig = ctx.signals;
        const msgs = {};               // legacy field -> { code, raw, date, at, json }
        let list = [];                 // [{ code, raw, bytes }] from cBSList
        let listJson = '';
        let legacyRes = null, gotAny = false;
        let sel = 0, page = 0, msg = '', version = 0, busy = false;
        const changed = () => { version++; };
        const useDemo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !gotAny);

        /* ---------- reading ---------- */
        const onMessage = (field) => (v) => {
            const c = code(pick(v, 'iDScope'));
            const y = n8(pick(v, 'targetDateYear')), m = n8(pick(v, 'targetDateMonth')), d = n8(pick(v, 'targetDateDay'));
            msgs[field] = {
                code: c, raw: n8(pick(v, 'remainingMileage')), status: pick(v, 'statusScope'),
                date: m !== null && m >= 1 && m <= 12 && y !== null && y !== 255 ? { d, m, y } : null,
                at: Date.now(), json: JSON.stringify(v),
            };
            if (valid(c)) gotAny = true;
            changed();
        };
        const handlers = {};
        MESSAGES.forEach((f) => { handlers[f] = onMessage(f); });
        sig.watch(LEGACY, '1', handlers, log).then((r) => { legacyRes = r; if (r.error) log.warn('CBS: ' + r.error); });

        // the service list: 14 entries of unnamed bytes - Data1 = item code, Data8 (16 bit) = remaining
        // distance is the likely layout; shown raw on the Diagnostics page to check it on each model
        sig.watch(LIST, '1', {
            cBSList: (v) => {
                listJson = JSON.stringify(v);
                const entries = (v && (v.cBSKeyService || v[Object.keys(v).find((k) => /Service/.test(k))])) || [];
                list = entries.map((e) => {
                    const b = [];
                    for (let i = 1; i <= 11; i++) b.push(e['cBSKeyServiceData' + i]);
                    return { code: n8(b[0]), raw: n8(b[7]), bytes: b };
                });
                if (list.some((e) => valid(e.code))) gotAny = true;
                changed();
            },
        }, log, { pollMs: 60000 });

        /* ---------- items ---------- */
        const today = () => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()); };
        const scale = () => Number(settings.get('distScale')) || 1;
        function items() {
            let raw = [];
            if (useDemo()) raw = DEMO.map((x) => Object.assign({ src: 'demo' }, x));
            else {
                MESSAGES.forEach((f) => { const m = msgs[f]; if (m && valid(m.code)) raw.push(Object.assign({ src: 'msg', field: f }, m)); });
                if (settings.get('fromList')) {
                    list.forEach((e) => {
                        if (valid(e.code) && !raw.some((r) => r.code === e.code)) raw.push({ src: 'list', code: e.code, raw: e.raw, date: null });
                    });
                }
            }
            const soonKm = Number(settings.get('soonKm')) || 2000, soonDays = Number(settings.get('soonDays')) || 30;
            return raw.map((r) => {
                const km = r.raw !== null && r.raw !== undefined && r.raw !== 65535 && r.raw !== 0xFFFF ? r.raw * scale() : null;
                const due = r.date ? new Date(2000 + r.date.y, r.date.m - 1, r.date.d >= 1 && r.date.d <= 31 ? r.date.d : 1) : null;
                const days = due ? Math.round((due - today()) / 86400000) : null;
                const state = (km !== null && km <= 0) || (days !== null && days < 0) ? 'over'
                    : (km !== null && km < soonKm) || (days !== null && days <= soonDays) ? 'soon' : 'ok';
                return Object.assign({ name: NAMES[r.code] || 'Item ' + r.code, km, due, days, state }, r);
            }).sort((a, b) => ({ over: 0, soon: 1, ok: 2 }[a.state] - { over: 0, soon: 1, ok: 2 }[b.state])
                || (a.km === null ? 1e9 : a.km) - (b.km === null ? 1e9 : b.km));
        }

        /* ---------- reset ---------- */
        let armed = null;
        const resetLabel = () => ui.text('BTN_RESET', armed ? 'Yes, reset' : 'Reset item');
        async function doReset() {
            if (busy) return;
            const it = items()[sel];
            if (!it) { msg = 'No service item to reset'; changed(); return; }
            if (!armed) {
                armed = setTimeout(() => { armed = null; resetLabel(); msg = ''; changed(); }, 5000);
                msg = 'Reset "' + it.name + '"? Only after the service is done - press again within 5 s';
                changed();
                return resetLabel();
            }
            clearTimeout(armed); armed = null; resetLabel();
            busy = true; msg = 'Resetting ' + it.name + '...'; changed();
            try {
                if (it.src === 'demo') {
                    await new Promise((r) => setTimeout(r, 600));
                    const d = DEMO.find((x) => x.code === it.code);
                    if (d) { d.raw = it.code === 1 ? 15000 : d.raw; if (d.date) d.date.y += it.code === 1 ? 1 : 2; }
                } else {
                    if (!legacyRes || !legacyRes.proxy) throw new Error('the car\'s service data is not reachable');
                    try {
                        await sig.set(legacyRes.proxy, 'cBSReset', { iDScopeCBS: it.code, cBSReset: 1 });
                    } catch (e) {         // the binding may want the enum names instead of numbers
                        log.info('cBSReset with numbers: ' + e + ' - trying the names');
                        await sig.set(legacyRes.proxy, 'cBSReset', { iDScopeCBS: NAME_OF_CODE[it.code], cBSReset: 'UMFANG_RUECKSETZEN' });
                    }
                }
                log.info('reset sent: ' + it.name + ' (code ' + it.code + ')');
                msg = 'Reset sent: ' + it.name + '. The car shows the new interval in a moment.';
            } catch (e) {
                log.warn('reset ' + it.name + ': ' + e);
                msg = 'Reset not accepted: ' + (e.message || e);
            }
            busy = false;
            changed();
        }

        /* ---------- drawing ---------- */
        const pages = () => (settings.get('diagPage') ? ['Service', 'Diagnostics'] : ['Service']);
        const fmtKm = (km) => {
            if (km === null) return '--';
            const v = settings.get('unit') === 'mi' ? km * 0.621371 : km;
            return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (settings.get('unit') === 'mi' ? ' mi' : ' km');
        };
        const fmtDate = (d) => (d ? String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear() : '--');

        function tile(cv, t, x, w, label, value, sub, col) {
            G.panel(cv, t, x, 44, w, 115, label);
            cv.text(value, x + 18, 142, 48, col, { font: 'num' });
            if (sub) cv.text(sub, x + w - 18, 142, 22, t.dim, { align: 'right' });
        }

        function drawMain(cv, t, its) {
            const over = its.filter((i) => i.state === 'over').length, soon = its.filter((i) => i.state === 'soon').length;
            const next = its.find((i) => i.km !== null) || its[0];
            tile(cv, t, 24, 760, 'Next due', next ? fmtKm(next.km) : '--', next ? next.name : 'no data yet', next ? t.text : t.dim);
            tile(cv, t, 804, 374, 'Due soon', String(soon), 'items', soon ? t.warn : GO);
            tile(cv, t, 1198, 378, 'Overdue', String(over), 'items', over ? t.crit : GO);
            G.panel(cv, t, 24, 176, 1552, 336, 'Service items' + (its.length > PER_PAGE ? '  ' + (Math.floor(sel / PER_PAGE) + 1) + '/' + Math.ceil(its.length / PER_PAGE) : ''));
            if (msg) cv.text(msg, 1552, 212, 22, /not|No /.test(msg) ? t.crit : t.dim, { align: 'right' });
            if (!its.length) {
                cv.text('Waiting for the car\'s service data (ignition on)...', 800, 369, 30, t.dim, { align: 'center' });
                return;
            }
            const first = Math.floor(sel / PER_PAGE) * PER_PAGE;
            its.slice(first, first + PER_PAGE).forEach((it, i) => {
                const y = 232 + i * 55, col = { over: t.crit, soon: t.warn, ok: GO }[it.state];
                if (first + i === sel) cv.roundRect(40, y - 4, 1520, 50, 8, withAlpha(t.accent, 0.18));
                cv.roundRect(48, y + 4, 8, 34, 4, col);
                cv.text(it.name, 76, y + 32, 30, t.text, { font: 'bold' });
                if (it.src === 'list') cv.text('*', 76 + cv.textWidth(it.name, 30, { font: 'bold' }) + 6, y + 24, 24, t.dim);
                cv.text(fmtKm(it.km), 1000, y + 32, 30, it.km === null ? t.dim : t.text, { align: 'right', font: 'bold' });
                cv.text(fmtDate(it.due), 1210, y + 32, 28, it.due ? t.text : t.dim, { align: 'right' });
                const lbl = { over: 'OVERDUE', soon: 'DUE SOON', ok: 'OK' }[it.state];
                cv.roundRect(1310, y + 6, 230, 34, 6, withAlpha(col, 0.22));
                cv.text(lbl, 1425, y + 31, 20, col, { align: 'center', font: 'bold', spacing: 0.5 });
            });
            if (its.some((i) => i.src === 'list')) cv.text('* from the service list - check the distance on the Diagnostics page', 48, 506, 18, t.dim);
        }

        function drawDiag(cv, t) {
            G.panel(cv, t, 24, 44, 1552, 468, 'Diagnostics - what the car sends');
            let y = 96;
            MESSAGES.forEach((f) => {
                const m = msgs[f];
                cv.text(f.replace('cBSMessage', ''), 48, y, 22, t.text, { font: 'bold' });
                cv.text(m ? 'code ' + m.code + '  distance ' + m.raw + '  date ' + (m.date ? m.date.d + '/' + m.date.m + '/' + m.date.y : '-') +
                    '  status ' + m.status : 'nothing received', 330, y, 22, m ? t.text : t.dim);
                y += 34;
            });
            cv.text('Service list (Data1..11 per entry):', 48, y + 8, 22, t.text, { font: 'bold' });
            y += 42;
            const shown = list.filter((e) => e.bytes.some((b) => b !== 0 && b !== 255 && b !== 65535));
            if (!shown.length) cv.text(listJson ? 'all entries empty' : 'nothing received', 48, y, 22, t.dim);
            shown.slice(0, 6).forEach((e) => { cv.text(e.bytes.join('  '), 48, y, 20, t.text, { font: 'label' }); y += 28; });
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

        ui.onClick('BTN_SELECT', () => { const n = items().length; if (n) sel = (sel + 1) % n; msg = ''; changed(); });
        ui.onClick('BTN_RESET', () => { doReset(); });
        ui.onClick('BTN_PAGE', () => { page = (page + 1) % pages().length; changed(); });

        ctx.loop('MAIN', 2, () => render(false));
        // back from Settings or a popup: draw again (this app only draws when something changed)
        const redraw = () => { changed(); setTimeout(changed, 600); };
        ui.onVisible((name, on) => { if (name === 'MAIN' && on) redraw(); });
        if (ui.onFocus) ui.onFocus((name, on) => { if (name === 'MAIN' && on) redraw(); });
        settings.onChange(() => changed());
        setInterval(changed, 60000);          // dates move on
        render(true).then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
