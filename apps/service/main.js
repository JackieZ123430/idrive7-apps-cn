'use strict';
/**
 * Service - the car's service items (CBS, Condition Based Service).
 *
 * The data lives in the car, not the head unit: the instrument cluster counts the items down
 * and keeps them; the head unit shows them and passes requests on. This app uses the head
 * unit's own interfaces for that:
 *
 *   list   : KombiInterface_2.cbsDataServiceList - every item as the cluster shows it
 *            (name, colour, distance and date as text, CBS id)
 *   details: ConditionBasedServicesLegacy.cBSMessage* - oil, brakes, gear oil, particle filter,
 *            spark plugs (logged; their units are not documented)
 *   reset  : ConditionBasedServicesLegacy.cBSReset = { iDScopeCBS: <item>, cBSReset: UMFANG_RUECKSETZEN }
 *            (press twice to confirm), the same request the cluster's own reset menu makes
 *   dates  : KombiIF.terminCBS = { iDCBS: HU | AU, yearCBS, monthCBS, dayCBS } - the legal
 *            inspection (HU) and emissions test (AU) due dates
 *
 * After a reset or a new date the list is read again, so the screen shows what the cluster
 * now says. Every request and answer goes to the log (data/service.log).
 */
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');

const W = 1600, H = 520, ROWS = 7;
const GO = '#2fd27a';
const LIST_IF = 'de.bmw.infotainment.KombiInterface_2';
const LEGACY_IF = 'de.bmw.infotainment.ConditionBasedServicesLegacy';
const DATES_IF = 'de.bmw.infotainment.KombiIF';

// CBS ids (IDScopeCBS), with English names for items the cluster sends without a text
const SCOPE = {
    1: ['OELSERVICE', 'Engine oil'], 2: ['BREMSBELAEGE_V', 'Front brake pads'], 3: ['BREMSFLUESSIGKEIT', 'Brake fluid'],
    4: ['MIKROFILTER', 'Microfilter'], 6: ['BREMSBELAEGE_H', 'Rear brake pads'], 7: ['DIESELPARTIKELFILTER', 'Particle filter'],
    9: ['GETRIEBEOEL', 'Gearbox oil'], 10: ['ZUENDKERZEN_ADAPTIV', 'Spark plugs'], 13: ['NOX_ADDITIV', 'NOx additive'],
    16: ['ZUENDKERZEN', 'Spark plugs'], 17: ['SICHTPRUEFUNGEN', 'Vehicle check'], 18: ['KUEHLFLUESSIGKEIT', 'Coolant'],
    19: ['H2_CHECK', 'Hydrogen check'], 20: ['UEBERGABEDURCHSICHT', 'Delivery inspection'], 21: ['EINFAHRKONTROLLE', 'Running-in check'],
    22: ['ADDITIV_FUER_DIESELPARTIKELFILTER', 'Particle filter additive'], 23: ['WASSERFILTER', 'Water filter'],
    32: ['HU_HAUPTUNTERSUCHUNG', 'Vehicle inspection'], 33: ['AU_ABGASUNTERSUCHUNG', 'Emissions test'],
    35: ['GETRIEBEOEL_HAUPTGETRIEBE', 'Main gearbox oil'], 100: ['SICHTPRUEFUNG_ADAPTIV', 'Vehicle check'],
};
// what each item means (bottom strip of the main screen)
const DESC = {
    1: 'Engine oil and filter change due on the date or after the distance shown.',
    2: 'Front brake pads: replacement due when the wear sensor says so.',
    3: 'Brake fluid change due on the date shown (every 2 years).',
    4: 'Cabin microfilter replacement.',
    6: 'Rear brake pads: replacement due when the wear sensor says so.',
    7: 'Diesel particle filter service.',
    9: 'Gearbox oil change.',
    10: 'Spark plug replacement (adaptive interval).',
    13: 'NOx additive (AdBlue) refill.',
    16: 'Spark plug replacement.',
    17: 'Next visual inspection due on the date shown, or after the distance shown.',
    18: 'Coolant change.',
    20: 'Delivery inspection.',
    21: 'Running-in check.',
    22: 'Particle filter additive refill.',
    23: 'Water filter replacement.',
    32: 'Statutory vehicle inspection (HU). Set its date on the Inspection dates page.',
    33: 'Statutory emissions test (AU). Set its date on the Inspection dates page.',
    35: 'Main gearbox oil change.',
    100: 'Next visual inspection due on the date shown, or after the distance shown.',
};
const NO_RESET = { 32: 'set its date on the Inspection dates page', 33: 'set its date on the Inspection dates page' };
const LEGACY_FIELDS = ['cBSMessageEngineOil', 'cBSMessageBrakeFront', 'cBSMessageBrakeRear', 'cBSMessageGearOil', 'cBSMessageParticleFilter', 'cBSMessageSparkPlug'];

// shown with no car (VM, bench) or with demo data set to Always
const DEMO_ITEMS = [
    { id: 1, color: 'GREEN', name: 'Engine oil', way: '14800 km', date: '06/2027' },
    { id: 3, color: 'YELLOW', name: 'Brake fluid', way: '', date: '11/2026' },
    { id: 2, color: 'GREEN', name: 'Front brake pads', way: '32000 km', date: '' },
    { id: 6, color: 'GREEN', name: 'Rear brake pads', way: '41000 km', date: '' },
    { id: 17, color: 'GREEN', name: 'Vehicle check', way: '28000 km', date: '06/2028' },
    { id: 4, color: 'RED', name: 'Microfilter', way: '-200 km', date: '' },
    { id: 32, color: 'GREEN', name: 'Vehicle inspection', way: '', date: '03/2027', year: 27, month: 3 },
];

const scopeId = (v) => {
    if (typeof v === 'number') return v;
    const k = Object.keys(SCOPE).find((n) => SCOPE[n][0] === v);
    return k ? Number(k) : null;
};
const pad = (n) => (n < 10 ? '0' : '') + n;
const yearOf = (y) => (typeof y === 'number' && y < 100 ? 2000 + y : null);

/** One list entry of cbsDataServiceList (a union: the plain struct or the one with a symbol id). */
function itemOf(u) {
    if (!u || typeof u !== 'object') return null;
    const w = u.cBSDataServiceWithSymbolID || (u.cBSDataService && u.cBSDataService.cBSIdentifier !== undefined && u.cBSListSymbolID !== undefined ? u : null);
    const s = w ? w.cBSDataService : (u.cBSDataServiceStruct || u.cBSDataService || u);
    if (!s || s.cBSIdentifier === undefined) return null;
    return {
        id: s.cBSIdentifier, color: s.cBSColor, name: String(s.cBSServcieName || '').trim(),
        way: String(s.cBSServiceWay || '').trim(), date: String(s.cBSServiceDate || '').trim(),
        year: s.yearCBSDisplay, month: s.monthCBSDisplay, day: w ? w.dayCBSDisplay : undefined,
        avail: w ? w.cBSAvail : undefined, count: w ? w.cBSServCount : undefined,
    };
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;

        /* ---------- data from the car ---------- */
        let items = null, listAt = 0, carSeen = false;
        const legacy = {};                     // CBS id -> last cBSMessage* struct
        let listSub = null, legacySub = null, legacyP = null, datesSub = null, datesP = null;
        const startT = Date.now();
        let msg = '', msgCol = null, msgAt = 0;
        const say = (m, col) => { msg = m; msgCol = col || null; msgAt = Date.now(); log.info(m); };

        const onList = (v) => {
            const arr = Array.isArray(v) ? v : v && Array.isArray(v.cbsDataServiceList) ? v.cbsDataServiceList : null;
            if (!arr) { log.warn('service list: unexpected value ' + JSON.stringify(v).slice(0, 300)); return; }
            if (!listAt) log.info('service list (raw, first entry): ' + JSON.stringify(arr[0] || null).slice(0, 500));
            items = arr.map(itemOf).filter(Boolean);
            listAt = Date.now(); carSeen = true;
            log.info('service list: ' + items.map((i) => i.id + ' ' + (i.name || '?') + ' [' + i.color + '] ' + i.way + ' ' + i.date).join(' | '));
        };
        ctx.signals.watch(LIST_IF, '1', { cbsDataServiceList: onList }, log)
            .then((s) => { listSub = s; log.info('cluster service list: ' + (s.error ? 'error ' + s.error : 'subscribed')); });

        const legacyHandlers = {};
        LEGACY_FIELDS.forEach((f) => {
            legacyHandlers[f] = (v) => {
                const key = Object.keys(v || {}).find((k) => /^iDScope/.test(k));
                const id = scopeId(v && v[key]);
                if (id === null) return;
                legacy[id] = v; carSeen = true;
                log.info('cbs ' + f + ': ' + JSON.stringify(v));
            };
        });
        ctx.signals.watch(LEGACY_IF, '1', legacyHandlers, log)
            .then((s) => { legacySub = s; legacyP = s.proxy; log.info('CBS reset interface: ' + (s.error ? 'error ' + s.error : 'ready')); });
        // the iDrive's own date entry (Vehicle status > Service requirements) writes KombiIF.terminCBS
        ctx.signals.watch(DATES_IF, '1', {}, log)
            .then((s) => { datesSub = s; datesP = s.proxy; log.info('inspection dates interface: ' + (s.error ? 'error ' + s.error : 'ready')); });
        // whether the car offers each one (logged once a minute while it changes)
        let offered = '';
        setInterval(() => {
            const o = 'reset ' + !!(legacySub && legacySub.available) + ', dates ' + !!(datesSub && datesSub.available) + ', list ' + !!(listSub && listSub.available);
            if (o !== offered) { offered = o; log.info('offered by the car: ' + o); }
        }, 5000);

        const usingDemo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !carSeen && Date.now() - startT > 5000);
        let demoItems = DEMO_ITEMS.map((i) => Object.assign({}, i));
        const list = () => (usingDemo() ? demoItems : items || []);

        /** Read the list again (after a reset / new date): now, and once more a few seconds later. */
        function reread() {
            const p = listSub && listSub.proxy;
            if (!p) return;
            const once = () => p.getValue('cbsDataServiceList', 4000).then(onList).catch((e) => log.warn('re-read service list: ' + e));
            setTimeout(once, 1500); setTimeout(once, 6000);
        }

        /**
         * Write a field; enums are tried as names first (what the car sends), then as numbers.
         * Returns '' on success, else the error.
         */
        async function write(p, field, byName, byNumber) {
            if (!p) return 'interface not ready';
            for (const v of [byName, byNumber]) {
                if (!v) continue;
                try {
                    log.info('write ' + field + ' = ' + JSON.stringify(v));
                    await ctx.signals.set(p, field, v, 5000);
                    log.info('write ' + field + ': accepted');
                    return '';
                } catch (e) { log.warn('write ' + field + ' ' + JSON.stringify(v) + ': ' + e); var last = String(e.message || e); }
            }
            return last || 'refused';
        }

        /* ---------- MAIN: list + reset ---------- */
        let sel = 0, armed = null;
        const selected = () => { const l = list(); return l.length ? l[Math.min(sel, l.length - 1)] : null; };
        const nameOf = (i) => i.name || (SCOPE[i.id] ? SCOPE[i.id][1] : 'Service item ' + i.id);
        const resetLabel = () => ui.text('BTN_RESET', armed ? 'Yes, reset' : 'Reset item');
        const disarm = () => { clearTimeout(armed); armed = null; resetLabel(); };
        const resetBlock = (i) => (!i ? 'no item' : NO_RESET[i.id] ? NO_RESET[i.id] : !SCOPE[i.id] ? 'unknown item (id ' + i.id + ')'
            : !usingDemo() && !(legacySub && legacySub.available) ? 'this car offers no reset to the head unit' : '');

        ui.onClick('BTN_NEXT', () => { const n = list().length; if (n) sel = (sel + 1) % n; disarm(); });
        ui.onClick('BTN_RESET', async () => {
            const i = selected(), why = resetBlock(i);
            if (why) { say(nameOf(i || { id: 0 }) + ': can\'t reset - ' + why, ctx.theme().warn); return; }
            if (!armed) {
                armed = setTimeout(disarm, 6000); resetLabel();
                say('Service done? Press "Yes, reset" to confirm');
                return;
            }
            disarm();
            if (usingDemo()) {
                Object.assign(i, { color: 'GREEN', way: i.id === 1 ? '24000 km' : i.way, date: i.date ? 'in 2 years' : '' });
                say(nameOf(i) + ': reset (demo)', GO);
                return;
            }
            say('Resetting ' + nameOf(i) + '...');
            const err = await write(legacyP, 'cBSReset', { iDScopeCBS: SCOPE[i.id][0], cBSReset: 'UMFANG_RUECKSETZEN' },
                { iDScopeCBS: i.id, cBSReset: 1 });
            if (err) say(nameOf(i) + ': reset not accepted (' + err + ')', ctx.theme().crit);
            else { say(nameOf(i) + ': reset sent - reading the cluster again...', GO); reread(); }
        });
        ui.onClick('BTN_DATES', () => { disarm(); loadDates(); ui.open('DATES'); });

        /* ---------- DATES: HU / AU due month ---------- */
        // fields: 0 HU month, 1 HU year, 2 AU month, 3 AU year
        const dates = { HU: { m: 0, y: 0 }, AU: { m: 0, y: 0 } };
        let field = 0, saveArmed = null;
        function loadDates() {
            const now = new Date();
            [['HU', 32], ['AU', 33]].forEach(([k, id]) => {
                const it = list().find((i) => i.id === id), y = it && yearOf(it.year);
                dates[k] = y && it.month >= 1 && it.month <= 12 ? { m: it.month, y, had: true } : { m: now.getMonth() + 1, y: now.getFullYear() + 2, had: false };
            });
        }
        loadDates();
        const saveLabel = () => ui.text('BTN_SAVE', saveArmed ? 'Yes, save' : 'Save date');
        const saveDisarm = () => { clearTimeout(saveArmed); saveArmed = null; saveLabel(); };
        const fieldKey = () => (field < 2 ? 'HU' : 'AU');
        const step = (d) => {
            const k = fieldKey(), o = dates[k];
            if (field % 2 === 0) { o.m += d; if (o.m > 12) { o.m = 1; o.y++; } if (o.m < 1) { o.m = 12; o.y--; } } else o.y += d;
            o.y = G.clamp(o.y, 2000, 2099); saveDisarm();
        };
        ui.onClick('BTN_FIELD', () => { field = (field + 1) % 4; saveDisarm(); });
        ui.onClick('BTN_UP', () => step(1));
        ui.onClick('BTN_DOWN', () => step(-1));
        ui.onClick('BTN_SAVE', async () => {
            const k = fieldKey(), o = dates[k], label = (k === 'HU' ? 'Vehicle inspection' : 'Emissions test') + ' ' + pad(o.m) + '/' + o.y;
            if (!saveArmed) { saveArmed = setTimeout(saveDisarm, 6000); saveLabel(); say('Press "Yes, save" to set ' + label); return; }
            saveDisarm();
            if (usingDemo()) {
                const it = demoItems.find((i) => i.id === (k === 'HU' ? 32 : 33));
                if (it) Object.assign(it, { date: pad(o.m) + '/' + o.y, year: o.y - 2000, month: o.m });
                say(label + ' saved (demo)', GO);
                return;
            }
            say('Saving ' + label + '...');
            if (!(datesSub && datesSub.available)) { say(label + ': the instrument cluster is not reachable', ctx.theme().crit); return; }
            const v = { iDCBS: k, yearCBS: o.y - 2000, monthCBS: o.m, dayCBS: 255 };     // day 255 = not given, as the iDrive sends it
            const err = await write(datesP, 'terminCBS', v, Object.assign({}, v, { iDCBS: k === 'HU' ? 32 : 33 }));
            if (err) say(label + ': not accepted (' + err + ')', ctx.theme().crit);
            else { say(label + ' sent - reading the cluster again...', GO); reread(); }
        });

        /* ---------- drawing ---------- */
        const colOf = (t, c) => ({ GREEN: GO, YELLOW: t.warn, ORANGE: t.warn, RED: t.crit }[c] || t.dim);
        function fit(cv, txt, size, max, opt) {
            txt = String(txt);
            if (cv.textWidth(txt, size, opt) <= max) return txt;
            while (txt.length > 4 && cv.textWidth(txt + '...', size, opt) > max) txt = txt.slice(0, -1);
            return txt.trim() + '...';
        }
        function header(cv, t, page) {
            G.frame(cv, t, ['Service items', 'Inspection dates'], page, [usingDemo() && { text: 'DEMO' }]);
        }
        function message(cv, t, x, y, w) {
            if (!msg || Date.now() - msgAt > 20000) return;
            cv.text(fit(cv, msg, 22, w), x, y, 22, msgCol || t.text);
        }

        // ---- main screen helpers ----
        const kmOf = (i) => { const m = /(-?\d[\d.,\s]*)\s*(km|mi)/i.exec(i.way || ''); return m ? Number(m[1].replace(/[.,\s]/g, '')) : null; };
        const wayText = (i) => (!i.way ? '' : /^\d/.test(i.way) ? 'in ' + i.way : i.way);
        const dateText = (i) => i.date || (yearOf(i.year) && i.month ? pad(i.month) + '/' + yearOf(i.year) : '');
        function monthsTo(i) {
            const m = /(\d{1,2})\/(\d{4})/.exec(dateText(i));
            if (!m) return null;
            const now = new Date();
            return (Number(m[2]) - now.getFullYear()) * 12 + Number(m[1]) - (now.getMonth() + 1);
        }

        function drawMain() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg), l = list();
            if (sel >= l.length) sel = 0;

            // ---- top: next service, due soon, due now ----
            const withKm = l.filter((i) => kmOf(i) !== null).sort((a, b) => kmOf(a) - kmOf(b));
            const next = withKm[0];
            const dated = l.map((i) => [i, monthsTo(i)]).filter((x) => x[1] !== null).sort((a, b) => a[1] - b[1]);
            const soon = l.filter((i) => i.color === 'YELLOW' || i.color === 'ORANGE').length;
            const now = l.filter((i) => i.color === 'RED').length;
            const TY = G.TOP, TH = 112;
            G.panel(cv, t, 24, TY, 1000, TH, 'Next service');
            if (next) {
                cv.text(kmOf(next) + ' km', 42, TY + 96, 46, colOf(t, next.color), { font: 'num' });
                cv.text(fit(cv, nameOf(next), 22, 300), 330, TY + 92, 22, t.dim);
            } else cv.text('--', 42, TY + 96, 46, t.dim, { font: 'num' });
            const d = dated[0];
            cv.text('Service due in', 820, TY + 92, 20, t.dim, { align: 'right' });
            cv.text(!d ? '--' : d[1] < 0 ? 'overdue' : d[1] === 0 ? 'this month' : d[1] + (d[1] === 1 ? ' month' : ' months'),
                1000, TY + 94, 30, d && d[1] < 1 ? t.crit : t.text, { align: 'right', font: 'num' });
            G.panel(cv, t, 1036, TY, 264, TH, 'Due soon');
            cv.text(String(soon), 1280, TY + 96, 46, soon ? t.warn : GO, { align: 'right', font: 'num' });
            G.panel(cv, t, 1312, TY, 264, TH, 'Due now');
            cv.text('items', 1490, TY + 92, 20, t.dim, { align: 'right' });
            cv.text(String(now), 1556, TY + 96, 46, now ? t.crit : GO, { align: 'right', font: 'num' });

            // ---- list: service requirements ----
            const LY = TY + TH + 10, RH = 46, R0 = LY + 56, NR = 5;
            G.panel(cv, t, 24, LY, 1552, G.BOTTOM - LY, 'Service requirements');
            if (!l.length) {
                const why = !listSub ? 'Connecting to the instrument cluster...' : listSub.error ? 'No service data: ' + listSub.error : 'Waiting for the instrument cluster...';
                cv.text(why, 800, R0 + 100, 28, t.dim, { align: 'center' });
            }
            const first = Math.floor(sel / NR) * NR;
            if (l.length > NR) cv.text('page ' + (first / NR + 1) + ' / ' + Math.ceil(l.length / NR), 1556, LY + 40, 20, t.dim, { align: 'right' });
            l.slice(first, first + NR).forEach((i, k) => {
                const y = R0 + k * RH, on = first + k === sel;
                if (on) cv.roundRect(36, y, 1528, RH - 4, 6, withAlpha('#ffffff', 0.16));
                cv.roundRect(50, y + 8, 8, RH - 20, 3, colOf(t, i.color));
                cv.text(fit(cv, nameOf(i), 28, 760), 76, y + 32, 28, t.text, { font: 'bold' });
                cv.text(wayText(i) || '-', 1290, y + 31, 24, t.text, { align: 'right' });
                cv.text(dateText(i) || '-', 1544, y + 31, 24, t.text, { align: 'right' });
            });

            // ---- bottom strip: what the selected item means, or the last message ----
            const i = selected(), SY = R0 + NR * RH + 4, SH = G.BOTTOM - SY - 8;
            cv.roundRect(36, SY, 1528, SH, 6, withAlpha('#b4bccc', 0.18));
            const ty = SY + SH / 2 + 8;
            if (msg && Date.now() - msgAt < 20000) {
                cv.text(fit(cv, msg, 22, 1490), 52, ty, 22, msgCol || t.text);
            } else if (i) {
                const head = nameOf(i) + ':  ', hw = cv.textWidth(head, 22, { font: 'bold' });
                const tail = [wayText(i), dateText(i)].filter(Boolean).join('   ');
                const tw = tail ? cv.textWidth(tail, 22) + 30 : 0;
                cv.text(head, 52, ty, 22, t.text, { font: 'bold' });
                cv.text(fit(cv, DESC[i.id] || 'Service item ' + i.id + '.', 22, 1490 - hw - tw), 52 + hw, ty, 22, t.text);
                if (tail) cv.text(tail, 1548, ty, 22, t.dim, { align: 'right' });
            }
            header(cv, t, 0);
            return ui.image('MAIN_GFX', cv);
        }

        function drawDates() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            [['HU', 'Vehicle inspection (HU)', 24], ['AU', 'Emissions test (AU)', 812]].forEach(([k, title, x], n) => {
                const o = dates[k];
                G.panel(cv, t, x, G.TOP, 764, 330, title);
                const fm = field === n * 2, fy = field === n * 2 + 1;
                if (fm) cv.strokeRoundRect(x + 60, 120, 230, 150, 12, 4, t.accent);
                if (fy) cv.strokeRoundRect(x + 330, 120, 330, 150, 12, 4, t.accent);
                cv.text(pad(o.m), x + 175, 240, 96, t.text, { align: 'center', font: 'num' });
                cv.text('/', x + 310, 240, 72, t.dim, { align: 'center' });
                cv.text(String(o.y), x + 495, 240, 96, t.text, { align: 'center', font: 'num' });
                cv.text('month', x + 175, 300, 20, t.dim, { align: 'center' });
                cv.text('year', x + 495, 300, 20, t.dim, { align: 'center' });
                cv.text(o.had ? 'from the cluster' : 'not set in the cluster - choose the date', x + 382, 350, 20, t.dim, { align: 'center' });
            });
            G.panel(cv, t, 24, 392, 1552, 120, '');
            cv.text('"Next field" picks month / year, +1 / -1 change it, "Save date" sends it to the instrument cluster.', 48, 440, 22, t.dim);
            message(cv, t, 48, 486, 1500);
            header(cv, t, 1);
            return ui.image('DATES_GFX', cv);
        }

        ctx.loop('MAIN', 4, drawMain);
        ctx.loop('DATES', 4, drawDates);
        log.info('service app started');
    },
});
