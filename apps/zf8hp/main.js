'use strict';

const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha, mix } = require('./kit/canvas');
const { fitText } = require('./kit/text-layout');
const { t: translate, getLanguage, plural } = require('./kit/i18n');
const C = require('./catalog');
const E = require('./egs');
const Reader = require('./reader');
const DEMO = require('./demo');

const PAGES = ['Live', 'Clutches', 'Shifts', 'Map', 'Thermal', 'Details', 'Reference'];
const PACKS = ['A', 'B', 'C', 'D', 'E'];
const BLUE = '#81c4ff', TEAL = '#49c9ba';
const CLUTCH_DIDS = ['413A', '4140', '4130', '4131', '418A', '4189', '418B', '418C'];
const DETAIL_DIDS = ['41A0', '41A1', '41B3', '41B4', '412F', '415F', '41B0', '41B1', '6081', '6090', 'DB03', 'DB04'];
const n = (v, digits) => E.finite(v) ? v.toFixed(digits || 0) : '--';
const signed = (v, digits) => E.finite(v) ? (v > 0 ? '+' : '') + n(v, digits) : '--';
function age(rec) {
    if (!rec || !rec.at) return 'not read';
    const seconds = Math.max(0, Math.round((Date.now() - rec.at) / 1000));
    return (rec.cached ? translate('saved') + ' ' : rec.error ? translate('last good') + ' ' : '')
        + (seconds < 60 ? seconds + translate('s ago') : seconds < 3600 ? Math.floor(seconds / 60) + translate('m ago') : Math.floor(seconds / 3600) + translate('h ago'));
}
function fit(cv, s, max, size) {
    if (getLanguage() === 'zh-CN') return fitText(cv, String(s || ''), size, max);
    s = String(s || '');
    while (s.length > 4 && cv.textWidth(s, size) > max) s = s.slice(0, -4) + '..';
    return s;
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const reader = new Reader(ctx);
        // temperatures come from the EGS in °C; shown in the unit picked in Settings (as M Vitals)
        const fahr = () => settings.get('tempUnit') === 'f';
        const tU = () => (fahr() ? '°F' : '°C');
        const T = (c) => (E.finite(c) ? (fahr() ? c * 9 / 5 + 32 : c) : null);
        const tN = (c, digits) => n(T(c), digits);
        // "-40..-20" / ">160" (°C bands from the catalog) in the picked unit
        const tRange = (s) => String(s).split('..').map((part) => part.replace(/-?\d+/, (x) => tN(Number(x)))).join('..');
        let page = 0, pack = 0, shift = 0, thermal = 0, graphMetric = 0, detailMode = 0, recordPage = 0;
        // px below the page where the kit runs the screen with no bar (G.pageBottom), else 0: the pages space their
        // rows with it so the last one ends G.MARGIN over the panels' bottom (512 + ex)
        let ex = 0;
        // where the kit runs the screen the Details lists scroll (scrolled): their offsets, and the records in view (read)
        const scroll = { faults: { y: 0, max: 0 }, records: { y: 0, max: 0 } };
        let recordIds = null;
        // row height for count G.table rows from top (rows start under its header) down to 4 over the panel's bottom,
        // their text in their middle (G.table's middle, rowList)
        const tableRow = (top, count) => Math.floor((508 + ex - top) / Math.max(1, count));
        // demo data: Always, or Auto while the diagnostic link is not up (no car)
        const demo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !(reader.diag && reader.diag.available));
        // the records, gear names and maps of the EGS on the car (reader.js: a variant's own catalog, else GSZFBCE's)
        const cat = () => (demo() ? C : reader.catalog);
        const records = () => demo() ? DEMO.records : reader.records;
        const rec = (d) => records()[d];
        const values = (d) => rec(d) && rec(d).ok ? rec(d).values : [];
        const value = (d, i) => values(d)[i || 0];
        const maps = () => E.shiftRecords(String(settings.get('mapFamily')), settings.get('shiftGroup'), cat());
        const chosen = () => { const xs = maps(); if (shift >= xs.length) shift = 0; return xs[shift]; };
        const family = () => String(settings.get('mapFamily'));
        const thermalDid = () => thermal % 2 ? '4440' : '4441';
        // a shift table with maps in this family: cold maps hold single upshifts only, KF2 has no skip downshifts
        const groupHas = (f, g) => !(/cold/.test(f) && g !== 'up') && E.shiftRecords(f, g, cat()).length > 0;
        // another map family, and the upshifts where it has no table for the current group (the page's buttons and View)
        function setFamily(f) {
            if (f === family()) return;
            settings.set('mapFamily', f);
            if (!groupHas(f, settings.get('shiftGroup'))) settings.set('shiftGroup', 'up');
        }

        function wanted() {
            let ds = ['6000', 'DA2E'];
            if (page === 0) ds = ds.concat(['DA2A', 'DA34', '6005', '601D', 'DA22', 'DB03']);
            if (page === 1) ds = ds.concat(CLUTCH_DIDS);
            if (page === 2) {
                ds = ds.concat(maps().map((x) => x.did), ['4133', '4134', '4136', '4137', '41B9', '41BA']);
                if (/cold/.test(family())) ds = ds.concat([family() === 'cold2' ? '41B7' : '41B6']);
            }
            if (page === 3 && chosen()) ds = ds.concat([E.mapValues(records(), chosen(), family()).did]);
            if (page === 4) ds = ds.concat(['4441', '4440', '6005', '601D']);
            if (page === 5) {
                if (detailMode === 0) ds = ds.concat(DETAIL_DIDS);
                if (detailMode === 2) ds = ds.concat(recordIds || Object.keys(cat().records).sort().slice(recordPage * 7, recordPage * 7 + 7));
            }
            reader.wantFaults = page === 5 && detailMode === 1;
            reader.setWanted(ds);
        }

        ui.onClick('BTN_PAGE', () => { page = (page + 1) % PAGES.length; wanted(); });
        // a finger dragged on a Details list, or the controller turned on it (cv.scroll): that list moves
        ctx.onScroll((dy) => {
            const s = page !== 5 ? null : detailMode === 1 ? scroll.faults : detailMode === 2 ? scroll.records : null;
            if (!s) return false;
            const y = G.clamp(s.y + dy, 0, s.max), moved = y !== s.y;
            s.y = y;
            return moved;
        });
        // full-screen layout: the kit shows the pages as header tabs (and leaves out the page button)
        // the current tab tapped again reads its page again (View where the HMI has the bar), unless the tap closed Settings
        ctx.onTab((i, closedSheet) => { if (i !== page) { page = i; wanted(); } else if (!closedSheet) reader.refresh(); });
        ui.onClick('BTN_SELECT', () => {
            if (page === 0) graphMetric = (graphMetric + 1) % 3;
            if (page === 1) pack = (pack + 1) % 5;
            if (page === 2 || page === 3) shift = (shift + 1) % Math.max(1, maps().length);
            if (page === 4) thermal = (thermal + 1) % 2;
            if (page === 5) {
                if (detailMode === 2) recordPage = (recordPage + 1) % Math.ceil(Object.keys(cat().records).length / 7);
                else detailMode = (detailMode + 1) % 3;
            }
            wanted();
        });
        ui.onClick('BTN_ACTION', () => {
            if (page === 2) { page = 3; wanted(); return; }
            if (page === 3) {
                const options = ['1', '2', 'cold1', 'cold2'];
                setFamily(options[(options.indexOf(family()) + 1) % options.length]);
                return;
            }
            if (page === 5) {
                if (detailMode === 2) { detailMode = 0; wanted(); return; }
            }
            reader.refresh();
        });
        // where the kit runs the screen every page picks its items itself (and the tabs refresh): no bar
        ['BTN_SELECT', 'BTN_ACTION'].forEach((b) => ctx.hideButton(b));
        // another family keeps the shift (its tables list the same shifts in the same order); another table starts at its first
        settings.onChange((key) => { if (key === 'shiftGroup' || shift >= maps().length) shift = 0; wanted(); });
        ui.onVisible((name, on) => { if (name === 'MAIN') { reader.setVisible(on); if (on) wanted(); } });
        reader.setVisible(ui.isVisible('MAIN'));
        wanted();
        reader.init().catch((e) => log.warn('EGS diagnostic link: ' + e));

        function subtitle(cv, t, left, right) {
            cv.text(left, 26, 76, 24, t.text, { font: 'bold' });
            if (right) cv.text(right, 1574, 76, 19, t.dim, { align: 'right' });
        }
        /** A dim note after the page's title head (the data's age, or the bar's hint where the HMI has the bar), cut at x end. */
        function afterHead(cv, t, head, note, end) {
            const x = 26 + cv.textWidth(head, 24, { font: 'bold' }) + 30;
            cv.text(fit(cv, note, end - x, 19), x, 76, 19, t.dim);
        }
        /** Where the kit runs the screen: pills of w px from x, the current one filled; a tap or the controller picks one. Returns the end x. */
        function choices(cv, t, x, y, labels, w, current, pick, key) {
            labels.forEach((label, i) => { x += G.button(cv, t, x, y, w, 40, label, () => pick(i), { key: key + i, primary: i === current }) + 10; });
            return x;
        }
        /**
         * A panel's label / value rows from y top, rh px each: one per row, striped as G.table's, the text in the
         * middle of the row (level with a G.table with middle beside them).
         */
        function rowList(cv, t, x, w, top, rh, rows) {
            rows.forEach((r, i) => {
                const ry = top + i * rh, ty = ry + rh / 2 + 10;
                if (i % 2) cv.fillRect(x + 10, ry, w - 20, rh, withAlpha('#ffffff', 0.03));
                cv.text(r[0], x + 18, ty, 24, t.dim);
                cv.text(r[1], x + w - 26, ty, 30, t.text, { align: 'right' });
            });
        }
        function freshness(ids) {
            if (demo()) return 'synthetic demo';
            const rs = ids.map(rec), missing = rs.filter((r) => !r || !r.ok).length;
            const old = rs.filter((r) => r && r.at).sort((a, b) => a.at - b.at)[0];
            const errors = rs.filter((r) => r && r.error).length;
            return (missing ? missing + ' pending  /  ' : '') + (errors ? errors + ' read error  /  ' : '') + (old ? age(old) : 'waiting for EGS');
        }
        function card(cv, t, x, w, title, text, unit, sub, color) {
            G.panel(cv, t, x, 44, w, 147, title);
            cv.text(text, x + 18, 145, 55, color || t.text, { font: 'num' });
            if (unit) cv.text(unit, x + w - 18, 142, 23, t.dim, { align: 'right' });
            if (sub) cv.text(sub, x + 18, 177, 17, t.dim);
        }
        function live(cv, t) {
            const oil = value('6000'), gear = cat().gearNames[value('DA2E')], selector = cat().selectorNames[value('DA2E', 1)];
            card(cv, t, 24, 374, 'Transmission oil', tN(oil), tU(), age(rec('6000')), BLUE);
            card(cv, t, 418, 374, 'Actual gear', gear || '--', selector || '', age(rec('DA2E')));
            card(cv, t, 812, 374, 'Turbine / input', n(value('DA2A')), 'rpm', age(rec('DA2A')));
            card(cv, t, 1206, 370, 'Output shaft', n(value('DA2A', 1)), 'rpm', 'Measured at the transmission');
            const names = ['ATF', 'EGS chip 1', 'EGS chip 2'], keys = ['oil', 'chip1', 'chip2'];
            G.panel(cv, t, 24, 210, 960, 302, (cv.own ? 'Temperature' : names[graphMetric]) + ' / current session');
            // where the kit runs the screen the plotted temperature is picked here (a tap or the controller), else Next item
            if (cv.own) choices(cv, t, 584, 222, ['ATF', 'Chip 1', 'Chip 2'], 120, graphMetric, (i) => { graphMetric = i; }, 'graph');
            else cv.text('Next item: next temperature', 966, 252, 19, t.dim, { align: 'right' });
            const hist = demo() ? DEMO.history : reader.history, points = hist.filter((p) => E.finite(p[keys[graphMetric]]));
            const px = 82, py = 284, pw = 864, ph = 172 + ex;
            [0, 0.5, 1].forEach((f) => {
                const y = py + ph * (1 - f);
                cv.line(px, y, px + pw, y, 1, withAlpha(t.text, 0.13));
                cv.text(tN(f * 140), px - 12, y + 6, 18, t.dim, { align: 'right' });
            });
            if (points.length > 1) {
                const start = points[0].t, end = Math.max(start + 1000, points[points.length - 1].t);
                cv.polyline(points.map((p) => [px + (p.t - start) / (end - start) * pw, py + ph * (1 - Math.max(0, Math.min(140, p[keys[graphMetric]])) / 140)]), 3, BLUE);
                cv.text(Math.round((end - start) / 60000) + ' min recorded', px, 488 + ex, 19, t.dim);
            } else cv.text('Waiting for fresh temperature samples', px + pw / 2, py + ph / 2 + 8, 24, t.dim, { align: 'center' });
            G.panel(cv, t, 1004, 210, 572, 302, 'Mechatronics / converter');
            // its records' age (saved values show as such) in its title line
            cv.text(fit(cv, freshness(['6005', '601D', 'DA34', 'DA22', 'DB03']), 220, 19), 1558, 252, 19, t.dim, { align: 'right' });
            const win = values('DB03');
            const rows = [['EGS chip 1', tN(value('6005')) + ' ' + tU()], ['EGS chip 2', tN(value('601D')) + ' ' + tU()],
                ['Engine speed', n(value('DA34')) + ' rpm'], ['Converter clutch', E.TCC[value('DA22')] || '--'],
                ['Reported oil-service window', win.length === 2 ? tN(win[0]) + '..' + tN(win[1]) + ' ' + tU() : '--']];
            rowList(cv, t, 1004, 572, 266, tableRow(266, rows.length), rows);
        }
        function clutches(cv, t) {
            // the page's title over the table, the pack's over its panel (so its rows have the whole panel), the data's age between
            const head = 'Clutch fill adaptation / A - E';
            subtitle(cv, t, head, null);
            afterHead(cv, t, head, freshness(CLUTCH_DIDS), 1076);
            cv.text('Pack ' + PACKS[pack] + ' / cold adaptation', 1126, 76, 24, t.text, { font: 'bold' });
            G.panel(cv, t, 24, 94, 1080, 418, 'Learned offsets');
            if (!cv.own) cv.text('Next item: next pack', 1086, 136, 19, t.dim, { align: 'right' });
            const cols = [{ label: 'Pack', w: 115 }, { label: 'Pressure mbar', w: 245, align: 'right' },
                { label: 'Fast fill ms', w: 230, align: 'right' }, { label: 'Time eval.', w: 225, align: 'right' }, { label: 'Pressure eval.', w: 225, align: 'right' }];
            const rows = PACKS.map((p, i) => [{ text: p, color: i === pack ? BLUE : t.text, font: 'bold' }, signed(value('413A', i)),
                signed(value('4140', i)), n(value('4130', i)), n(value('4131', i))]);
            // the selected pack's row (G.table's rows start 32 px under its top); where the kit runs the screen a row
            // tapped, or pressed with the controller, selects its pack, else Next item
            const rh = tableRow(189, PACKS.length);
            cv.roundRect(36, 189 + pack * rh, 1056, rh, 8, withAlpha(BLUE, 0.14));
            if (cv.own) PACKS.forEach((p, i) => cv.target(36, 189 + i * rh, 1056, rh, () => { pack = i; }, 'pack' + p, 8));
            G.table(cv, t, 44, 157, 1040, cols, rows, { rowH: rh, headerSize: 18, size: 29, middle: true });
            G.panel(cv, t, 1124, 94, 452, 418, null);
            const details = [['Cold correction (raw units)', signed(value('418A', pack))], ['Cold evaluations', n(value('4189', pack))],
                ['Cold shift counter', n(value('418B', pack))], ['Start evaluations', n(value('418C', pack))]];
            // its rows from under its top line down to its bottom (14 over it, as the lists'), the text in their middle
            rowList(cv, t, 1124, 452, 104, (394 + ex) / details.length, details);
        }
        function counterFor(s) {
            if (!s) return null;
            const f = family() === '2' || family() === 'cold2' ? 2 : 1;
            if (/cold/.test(family()) && s.toGear - s.fromGear === 1) return value(f === 2 ? '41BA' : '41B9', s.fromGear - 1);
            if (s.toGear > s.fromGear) return value(f === 2 ? '4136' : '4133', s.fromGear - 1);
            const xs = cat().shifts.filter((m) => m.family === f && m.toGear < m.fromGear);
            return value(f === 2 ? '4137' : '4134', xs.findIndex((m) => m.did === s.did));
        }
        /** Where the kit runs the screen: the map family picked on the page (else in Settings or with View). Returns the end x. */
        function familyButtons(cv, t, x, y) {
            [['1', 'KF1'], ['2', 'KF2'], ['cold1', 'Cold KF1'], ['cold2', 'Cold KF2']].forEach((f) => {
                x += G.button(cv, t, x, y, 120, 40, f[1], () => setFamily(f[0]), { key: 'family' + f[0], primary: family() === f[0] }) + 10;
            });
            return x;
        }
        function shifts(cv, t) {
            const xs = maps(), familyLabel = /cold/.test(family()) ? 'Cold KF' + family().slice(-1) : 'KF' + family();
            // where the kit runs the screen every shift of the table (rows are lower for KF1's 11 skip downshifts); where
            // the HMI has the bar the seven around the selected one (Next item)
            const first = cv.own ? 0 : Math.floor(shift / 7) * 7, shown = cv.own ? xs : xs.slice(first, first + 7);
            // where the kit runs the screen the family and table show on the panel's buttons: no page title, the panel
            // from the page's top; else the title says them
            const py = cv.own ? 44 : 94;
            if (!cv.own) subtitle(cv, t, 'Shift adaptation / ' + familyLabel + ' / ' + translate(settings.get('shiftGroup')), 'View / refresh: open selected map');
            G.panel(cv, t, 24, py, 1552, 512 - py, 'Per-shift map summary' + (shown.length < xs.length ? ' / ' + (first + 1) + '-' + (first + shown.length) + ' of ' + xs.length : ''));
            if (cv.own) {
                let bx = familyButtons(cv, t, 666, py + 12) + 20;
                [['up', 'Up'], ['down', 'Down'], ['skip', 'Skip']].forEach((g) => {
                    // (Settings.set tells its listeners even of the same value, which would reset the shift)
                    bx += G.button(cv, t, bx, py + 12, 110, 40, g[1], () => { if (settings.get('shiftGroup') !== g[0]) settings.set('shiftGroup', g[0]); },
                        { key: 'group' + g[0], primary: settings.get('shiftGroup') === g[0], busy: !groupHas(family(), g[0]) }) + 10;
                });
            }
            const top = py + 104, rh = Math.min(60, tableRow(top, shown.length));
            const rows = shown.map((s, i) => {
                const m = E.mapValues(records(), s, family()), z = E.summary(m.values);
                return [{ text: s.label, color: first + i === shift ? BLUE : t.text, font: 'bold' }, n(counterFor(s)),
                    z ? signed(z.min) : '--', z ? signed(z.mean, 1) : '--', z ? signed(z.max) : '--', z ? z.count + ' ' + plural(z.count, 'cells', 'cells') : 'not read', age(m.record)];
            });
            const cols = [{ label: 'Shift', w: 160 }, { label: 'Adapt. count', w: 220, align: 'right' }, { label: 'Min mbar', w: 220, align: 'right' },
                { label: 'Mean mbar', w: 220, align: 'right' }, { label: 'Max mbar', w: 220, align: 'right' }, { label: 'Map', w: 220, align: 'right' }, { label: 'Age', w: 240, align: 'right' }];
            // the selected shift's row; where the kit runs the screen a row tapped, or pressed with the controller, opens its map
            if (xs.length) cv.roundRect(36, top + (shift - first) * rh, 1528, rh, 8, withAlpha(BLUE, 0.14));
            if (cv.own) xs.forEach((s, i) => cv.target(36, top + i * rh, 1528, rh, () => { shift = i; page = 3; wanted(); }, 'shift' + s.did, 8));
            G.table(cv, t, 44, py + 70, 1512, cols, rows, { rowH: rh, size: Math.min(30, rh - 8), headerSize: 20, middle: true });
            if (!xs.length) cv.text('This map family has no selected shift group', 800, (py + 512 + ex) / 2 + 12, 28, t.dim, { align: 'center' });
        }
        function heatmap(cv, t) {
            const s = chosen(), m = E.mapValues(records(), s, family()), z = E.summary(m.values);
            const cold = /cold/.test(family()), fam = cold ? 'Cold KF' + family().slice(-1) : 'KF' + family();
            // where the kit runs the screen the family and shift show on the panels' buttons: no page title, the panels
            // from the page's top. Else the page's title over the map, the summary's over its panel (so the panel's
            // content has all of it), the bar's hint between
            const py = cv.own ? 44 : 94;
            if (!cv.own) {
                const head = 'Shift ' + (s ? s.label : '--') + ' / ' + fam;
                subtitle(cv, t, head, null);
                afterHead(cv, t, head, 'Next item: shift   /   View: map family', 1080);
                cv.text('Map summary', 1102, 76, 24, t.text, { font: 'bold' });
            }
            G.panel(cv, t, 24, py, 1056, 512 - py, 'Learned pressure offset / mbar');
            if (cv.own) familyButtons(cv, t, 550, py + 12);
            // the cells down to the panel's bottom: 8 rows of 8, or 4 of 6 (24-cell maps) twice as high
            const cols = m.values.length === 24 ? 6 : 8, rows = Math.ceil(m.values.length / cols), x0 = 112, y0 = py + 89, cw = 112;
            const ch = Math.floor((405 - py + ex) / Math.max(1, rows));
            for (let x = 0; x < cols; x++) cv.text(String(x + 1), x0 + x * cw + 51, py + 78, 19, t.dim, { align: 'center' });
            for (let y = 0; y < rows; y++) {
                cv.text(String(y + 1), 82, y0 + y * ch + Math.round(ch / 2) + 7, 19, t.dim, { align: 'right' });
                for (let x = 0; x < cols; x++) {
                    const v = m.values[y * cols + x];
                    if (!E.finite(v)) continue;
                    const a = Math.min(1, Math.abs(v) / Math.max(50, z ? Math.max(Math.abs(z.min), Math.abs(z.max)) : 50));
                    cv.fillRect(x0 + x * cw, y0 + y * ch, cw - 5, ch - 4, mix(t.panelBottom, v < 0 ? '#245d92' : '#217368', 0.12 + a * 0.7));
                    cv.text(signed(v), x0 + x * cw + 51, y0 + y * ch + Math.round(ch / 2) + 6, 21, t.text, { align: 'center', font: 'num' });
                }
            }
            if (!m.values.length) cv.text(m.error || 'Waiting for the selected map', 552, (py + 512 + ex) / 2 + 7, 25, t.dim, { align: 'center' });
            // its title in the panel where the kit runs the screen (over its line where the HMI has the bar)
            G.panel(cv, t, 1100, py, 476, 512 - py, cv.own ? 'Map summary' : null);
            const summary = [['Minimum', z ? signed(z.min) + ' mbar' : '--'], ['Mean', z ? signed(z.mean, 1) + ' mbar' : '--'],
                ['Maximum', z ? signed(z.max) + ' mbar' : '--'], ['Adaptation count', n(counterFor(s))], ['Updated', age(m.record)]];
            // where the kit runs the screen: every shift of the table under the panel's title, four a row, the one shown filled
            // (else Next item); the summary's rows from under them down to the panel's bottom, the text in their middle
            const xs = cv.own ? maps() : [];
            xs.forEach((x, i) => G.button(cv, t, 1118 + (i % 4) * 112, py + 62 + Math.floor(i / 4) * 50, 102, 40, x.label,
                () => { shift = i; wanted(); }, { key: 'mapShift' + x.did, primary: i === shift }));
            const top = xs.length ? py + 62 + Math.ceil(xs.length / 4) * 50 : py + 10;
            rowList(cv, t, 1100, 476, top, (498 + ex - top) / summary.length, summary);
        }
        function temperatures(cv, t) {
            const d = thermalDid(), vs = values(d), total = vs.reduce((a, b) => a + b, 0), max = Math.max.apply(null, [1].concat(vs));
            const totalText = 'Total recorded ' + n(total / 3600, 1) + ' h / ' + age(rec(d));
            const head = (thermal % 2 ? 'EGS electronics' : 'Transmission oil') + ' / lifetime temperature distribution';
            subtitle(cv, t, head, cv.own ? '' : totalText);
            // where the kit runs the screen: oil or electronics picked here (else Next item), the total left of it
            if (cv.own) {
                choices(cv, t, 1266, 48, ['Oil', 'Electronics'], 150, thermal, (i) => { thermal = i; wanted(); }, 'thermal');
                cv.text(totalText, 1246, 76, 19, t.dim, { align: 'right' });
            } else afterHead(cv, t, head, 'Next item: oil / electronics', 1574 - 30 - cv.textWidth(totalText, 19));
            for (let col = 0; col < 3; col++) {
                const x = 24 + col * 524;
                G.panel(cv, t, x, 94, 504, 418, col === 0 ? 'Cold / warm' : col === 1 ? 'Temperature bands' : 'Upper temperature bands');
                for (let row = 0; row < 8; row++) {
                    const i = col * 8 + row;
                    if (i >= cat().ranges.length) continue;
                    const y = Math.round(180 + row * (304 + ex) / 7), v = vs[i];
                    cv.fillRect(x + 14, y - 23, 474 * (E.finite(v) ? v / max : 0), 29, withAlpha(BLUE, 0.14));
                    cv.text(tRange(cat().ranges[i]) + ' ' + tU(), x + 18, y, 22, t.text);
                    cv.text(E.finite(v) ? n(v / 3600, 2) + ' h' : '--', x + 356, y, 23, t.text, { align: 'right', font: 'num' });
                    cv.text(E.finite(v) && total ? n(v / total * 100, 1) + '%' : '--', x + 484, y, 19, t.dim, { align: 'right' });
                }
            }
        }
        function faultRow(cv, t, r, y) {
            cv.text(r.code, 50, y, 28, t.text, { font: 'num' });
            cv.text('status 0x' + r.status.toString(16).toUpperCase(), 330, y, 24, t.dim);
        }
        function recordRow(cv, t, d, y) {
            const r = rec(d), meta = cat().records[d];
            cv.text(d, 44, y, 28, BLUE, { font: 'num' });
            cv.text(fit(cv, meta.name.replace(/^_/, ''), 690, 24), 160, y, 24, t.text);
            const deg = meta.fields[0] && meta.fields[0].unit === '°C';
            const v = r && r.ok ? (r.decoded ? r.values.slice(0, 5).map((x) => deg ? tN(x) : n(x, meta.fields[0] && meta.fields[0].unit === 'bar' ? 2 : 0)).join(' / ') + (deg ? ' ' + tU() : '') : r.bytes + ' bytes / raw') : r && r.error || 'not read';
            cv.text(fit(cv, v, 440, 27), 1320, y, 27, t.text, { align: 'right' });
            cv.text(age(r), 1554, y, 21, t.dim, { align: 'right' });
        }
        /**
         * A list in panel p scrolled by s (as Fault Scanner's): its rows from y top (unscrolled), height px in all, cut
         * to the panel from y clipTop. draw(sy, from, to) draws them moved up by sy, only those between from and to.
         */
        function scrolled(cv, t, p, s, key, clipTop, top, height, draw) {
            const end = p.y + p.h - 12;                  // the list's last row ends 12 over the panel's bottom
            s.max = Math.max(0, top + height - end);
            s.y = G.clamp(s.y, 0, s.max);
            const sy = G.smooth('zf8Scroll:' + key, s.y, 22);
            cv.clip(p.x, clipTop, p.w, p.y + p.h - 4 - clipTop);
            draw(sy, clipTop, p.y + p.h - 4);
            cv.noclip();
            if (!s.max) return;
            // where the list is: a bar at the panel's right edge
            const vis = end - clipTop, bh = Math.max(40, vis * vis / (vis + s.max));
            const bar = { x: p.x + p.w - 11, y: clipTop + (vis - bh) * sy / s.max, w: 6, h: bh };
            cv.roundRect(bar.x, bar.y, bar.w, bar.h, 3, withAlpha(t.text, 0.3));
            // the controller: the title's button first, then the list (its bar in the selection colour while on it)
            cv.scroll = { y: clipTop, bar };
        }
        function details(cv, t) {
            const ids = Object.keys(cat().records).sort(), all = ids.length;
            const head = ['Converter / learning / service data', 'EGS fault memory', 'All available diagnostic records'][detailMode];
            subtitle(cv, t, head, cv.own ? '' : detailMode === 2 ? 'Next item: next records / View: return to summary' : 'Next item: next details view');
            // the summary's age after its title, left of the view's pills (or the bar's hint)
            if (detailMode === 0) afterHead(cv, t, head, freshness(DETAIL_DIDS), cv.own ? 1136 : 1250);
            // the summary: three panels (below); the fault and record lists: one
            const p = detailMode === 0 ? null : G.panel(cv, t, 24, 94, 1552, 418, ['', 'Pending and confirmed faults / read only',
                cv.own ? translate('All') + ' ' + all + ' ' + plural(all, 'records', 'records') : 'Records ' + (recordPage * 7 + 1) + '-' + Math.min(all, recordPage * 7 + 7) + ' of ' + all][detailMode]);
            // where the kit runs the screen: the view picked here and its action in the panel (else Next item and View)
            if (cv.own) choices(cv, t, 1166, 48, ['Summary', 'Faults', 'Records'], 130, detailMode, (i) => { detailMode = i; wanted(); }, 'details');
            if (detailMode === 1) {
                // a read asked for (refresh) or under way: Read again waits for it; when the list was last read, left of it
                const reading = !demo() && reader.checked && (!reader.faultAttempt || (reader.faultAttempt > reader.faultsAt && Date.now() - reader.faultAttempt < 7000));
                if (cv.own) G.button(cv, t, 1396, 106, 160, 40, 'Read again', () => { reader.refresh(); }, { key: 'faults', busy: demo() || reading });
                const note = demo() ? 'synthetic demo' : reading ? 'reading' : reader.faultsAt ? 'read ' + age({ at: reader.faultsAt }) : 'not read yet';
                cv.text(note, cv.own ? 1376 : 1558, 136, 19, t.dim, { align: 'right' });
            }
            if (detailMode === 0) {
                // three panels side by side, their rows level: the converter clutch's learning, the gear engagement and
                // release learning (a column each for D1, D2 and R), the EGS's own data
                const w = 504, xs = [24, 548, 1072], top = 184, rh = tableRow(top, 4);
                G.panel(cv, t, xs[0], 94, w, 418, 'Converter clutch');
                G.panel(cv, t, xs[1], 94, w, 418, 'Gear engagement / release');
                G.panel(cv, t, xs[2], 94, w, 418, 'EGS / oil service');
                const list = (x, rows) => rowList(cv, t, x, w, top, rh, rows);
                list(xs[0], [['Fast-fill correction', signed(value('41A0'), 1) + ' ms'], ['Fast-fill evaluations', n(value('41A1'))],
                    ['Base-point adaptation', signed(value('41B3')) + ' mA'], ['Base-point evaluations', n(value('41B4'))]]);
                const dr = (label, d, fmt) => [{ text: label, color: t.dim }].concat([0, 1, 2].map((i) => fmt(value(d, i))));
                G.table(cv, t, xs[1] + 18, 152, w - 36, [{ label: '', w: 252, size: 24 }, { label: 'D1', w: 72, align: 'right' },
                    { label: 'D2', w: 72, align: 'right' }, { label: 'R', w: 72, align: 'right' }],
                    [dr('Engage, mbar', '412F', signed), dr('Engage evaluations', '415F', n),
                        dr('Release, mbar', '41B0', signed), dr('Release evaluations', '41B1', n)], { rowH: rh, size: 30, headerSize: 18, middle: true });
                const lt = value('6081'), win = values('DB03'), rpm = values('DB04');
                list(xs[2], [['Operating time (no standby)', n(E.finite(lt) ? lt / 60 : null, 1) + ' h'], ['Stationary adaptations', n(value('6090'))],
                    ['Oil-service temperature', win.length ? win.map((v) => tN(v)).join('..') + ' ' + tU() : '--'],
                    ['Oil-service speed', rpm.length ? rpm.join('..') + ' rpm' : '--']]);
            } else if (detailMode === 1) {
                const faults = demo() ? [] : reader.faults;
                if (faults === null) cv.text('Waiting for an EGS fault-memory response', 800, 310 + ex / 2, 29, t.dim, { align: 'center' });
                else if (!faults.length) cv.text('No pending or confirmed EGS faults returned', 800, 310 + ex / 2, 29, TEAL, { align: 'center' });
                // where the kit runs the screen every fault in one list, scrolled; else the first seven
                else if (cv.own) scrolled(cv, t, p, scroll.faults, 'faults', 152, 158, faults.length * 46 - 6, (sy, from, to) => faults.forEach((r, i) => {
                    const y = 158 + i * 46 - sy;
                    if (y + 40 < from || y > to) return;
                    faultRow(cv, t, r, y + 30);
                    if (i < faults.length - 1) cv.fillRect(44, y + 41, 1512, 1, withAlpha(t.text, 0.1));
                }));
                else faults.slice(0, 7).forEach((r, i) => faultRow(cv, t, r, 182 + i * 44));
            } else if (cv.own) {
                // every record in one list, scrolled; the ones in view (and one either side) are the ones read
                const RH = 56, top = 158;
                scrolled(cv, t, p, scroll.records, 'records', 152, top, all * RH - 6, (sy, from, to) => ids.forEach((d, i) => {
                    const y = top + i * RH - sy;
                    if (y + RH < from || y > to) return;
                    recordRow(cv, t, d, y + 35);
                    if (i < all - 1) cv.fillRect(44, y + 50, 1512, 1, withAlpha(t.text, 0.1));
                }));
                const first = Math.max(0, Math.floor(scroll.records.y / RH) - 1);
                const inView = ids.slice(first, first + Math.ceil((p.y + p.h - top) / RH) + 2);
                if (!recordIds || inView.join() !== recordIds.join()) { recordIds = inView; wanted(); }
            } else {
                if (recordIds) { recordIds = null; wanted(); }
                ids.slice(recordPage * 7, recordPage * 7 + 7).forEach((d, i) => recordRow(cv, t, d, 186 + i * 50));
            }
        }
        function reference(cv, t) {
            // no page title: the panels from the page's top, the controller on this car at the right of the matrix's title
            // the gear the EGS reports now (ISTGANG, read live; not a saved value): its row highlighted, none in P / N.
            // Read every live interval: one older than two of them (and 5 s) is not now, as with Refresh while visible off
            const gs = ['R', '1', '2', '3', '4', '5', '6', '7', '8'], r = rec('DA2E');
            const liveMs = Math.max(1, Number(settings.get('liveInterval')) || 2) * 1000;
            const fresh = demo() || (r && r.ok && !r.cached && Date.now() - r.at < Math.max(10000, 2 * liveMs + 5000));
            const cur = fresh ? gs.indexOf(cat().gearNames[value('DA2E')]) : -1, title = 'Applied elements';
            G.panel(cv, t, 24, 44, 795, 468, title);
            cv.text(fit(cv, 'Controller ' + (demo() ? '0F25D0' : reader.sgbd || 'not identified'), 795 - 66 - cv.textWidth(title, 26, { font: 'bold' }), 19),
                801, 86, 19, t.dim, { align: 'right' });
            const rows = gs.map((g, i) => [{ text: g, color: i === cur ? BLUE : t.text }].concat(PACKS.map((p) => cat().clutchMatrix[g].indexOf(p) >= 0 ? { text: 'ON', color: BLUE } : '-')));
            const rh = tableRow(135, gs.length);
            if (cur >= 0) cv.roundRect(36, 135 + cur * rh, 766, rh, 8, withAlpha(BLUE, 0.14));
            G.table(cv, t, 44, 103, 750, [{ label: 'Gear', w: 125 }].concat(PACKS.map((p) => ({ label: p, w: 125, align: 'center' }))), rows,
                { rowH: rh, size: 22, headerSize: 18, middle: true });
            G.panel(cv, t, 839, 44, 737, 468, 'Understanding the data');
            const lines = ['A / B: brakes. C / D / E: clutches.', 'Three elements transmit each forward ratio.',
                'Fill pressure and time: learned corrections.', 'Positive / negative offsets are both possible.',
                'KF1 / KF2 keep separate adaptation maps.', 'Cell indices do not reveal RPM/torque limits.',
                'Temperature tables show accumulated time.', 'Data source: BMW/ZF GSZFBCE rev. 15.000.'];
            lines.forEach((s, i) => cv.text(s, 859, 128 + i * (358 + ex) / 7, 23, i === 2 ? BLUE : t.text));
        }

        ctx.loop('MAIN', 5, () => {
            const t = ctx.theme(), cv = ctx.canvas(1600, 520).clear(t.bg);
            ex = G.pageBottom(cv) - G.BOTTOM;
            const state = demo() ? 'DEMO' : reader.status();
            G.frame(cv, t, PAGES, page, [{ text: 'EXPERIMENTAL', color: t.warn },
                { text: state, color: state === 'LIVE' ? BLUE : t.warn }]);
            // another EGS: its message in place of the page (whose controls would still answer under a cover)
            if (!demo() && reader.checked && !reader.supported) {
                cv.text('This EGS variant is not supported by the verified decoder', 800, 260 + ex / 2, 32, t.warn, { align: 'center' });
                cv.text('Unsupported EGS variant: ' + reader.sgbd, 800, 315 + ex / 2, 25, t.dim, { align: 'center' });
                cv.text('Settings: EGS variant, Try any (unverified) reads it anyway; values that don\'t fit show as errors', 800, 360 + ex / 2, 22, t.dim, { align: 'center' });
            } else [live, clutches, shifts, heatmap, temperatures, details, reference][page](cv, t);
            return ui.image('MAIN_GFX', cv);
        });
    },
});
