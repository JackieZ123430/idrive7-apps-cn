'use strict';

const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha, mix } = require('./kit/canvas');
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
    return (rec.cached ? 'saved ' : rec.error ? 'last good ' : '') + (seconds < 60 ? seconds + 's' : seconds < 3600 ? Math.floor(seconds / 60) + 'm' : Math.floor(seconds / 3600) + 'h') + ' ago';
}
function fit(cv, s, max, size) {
    s = String(s || '');
    while (s.length > 4 && cv.textWidth(s, size) > max) s = s.slice(0, -4) + '..';
    return s;
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const reader = new Reader(ctx);
        let page = 0, pack = 0, shift = 0, thermal = 0, graphMetric = 0, detailMode = 0, recordPage = 0, matrixGear = 0;
        let message = '', messageUntil = 0;
        const demo = () => settings.get('demo') === 'on';
        const records = () => demo() ? DEMO.records : reader.records;
        const rec = (d) => records()[d];
        const values = (d) => rec(d) && rec(d).ok ? rec(d).values : [];
        const value = (d, i) => values(d)[i || 0];
        const maps = () => E.shiftRecords(String(settings.get('mapFamily')), settings.get('shiftGroup'));
        const chosen = () => { const xs = maps(); if (shift >= xs.length) shift = 0; return xs[shift]; };
        const family = () => String(settings.get('mapFamily'));
        const say = (s) => { message = s; messageUntil = Date.now() + 6000; };
        const thermalDid = () => thermal % 2 ? '4440' : '4441';

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
                if (detailMode === 2) ds = ds.concat(Object.keys(C.records).sort().slice(recordPage * 7, recordPage * 7 + 7));
            }
            reader.wantFaults = page === 5 && detailMode === 1;
            reader.setWanted(ds);
        }

        ui.onClick('BTN_PAGE', () => { page = (page + 1) % PAGES.length; wanted(); });
        ui.onClick('BTN_SELECT', () => {
            if (page === 0) graphMetric = (graphMetric + 1) % 3;
            if (page === 1) pack = (pack + 1) % 5;
            if (page === 2 || page === 3) shift = (shift + 1) % Math.max(1, maps().length);
            if (page === 4) thermal = (thermal + 1) % 2;
            if (page === 5) {
                if (detailMode === 2) recordPage = (recordPage + 1) % Math.ceil(Object.keys(C.records).length / 7);
                else detailMode = (detailMode + 1) % 3;
            }
            if (page === 6) matrixGear = (matrixGear + 1) % 9;
            wanted();
        });
        ui.onClick('BTN_ACTION', () => {
            if (page === 2) { page = 3; wanted(); return; }
            if (page === 3) {
                const options = ['1', '2', 'cold1', 'cold2'];
                settings.set('mapFamily', options[(options.indexOf(family()) + 1) % options.length]);
                return;
            }
            if (page === 5) {
                if (detailMode === 2) { detailMode = 0; wanted(); return; }
                if (detailMode === 0) { reader.save(); say('Snapshot saved in the app data folder'); }
            }
            reader.refresh();
            if (page !== 5) say('Refresh requested');
        });
        settings.onChange((key) => { if (key === 'mapFamily' || key === 'shiftGroup') shift = 0; wanted(); });
        ui.onVisible((name, on) => { if (name === 'MAIN') { reader.setVisible(on); if (on) wanted(); } });
        reader.setVisible(ui.isVisible('MAIN'));
        wanted();
        reader.init().catch((e) => log.warn('EGS diagnostic link: ' + e));

        function subtitle(cv, t, left, right) {
            cv.text(left, 26, 76, 24, t.text, { font: 'bold' });
            if (right) cv.text(right, 1574, 76, 19, t.dim, { align: 'right' });
        }
        function footer(cv, t, text) { cv.text(fit(cv, text, 1548, 18), 26, 507, 18, t.dim); }
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
            const oil = value('6000'), gear = C.gearNames[value('DA2E')], selector = C.selectorNames[value('DA2E', 1)];
            card(cv, t, 24, 374, 'Transmission oil', n(oil), 'C', age(rec('6000')), BLUE);
            card(cv, t, 418, 374, 'Actual gear', gear || '--', selector || '', age(rec('DA2E')));
            card(cv, t, 812, 374, 'Turbine / input', n(value('DA2A')), 'rpm', age(rec('DA2A')));
            card(cv, t, 1206, 370, 'Output shaft', n(value('DA2A', 1)), 'rpm', 'Measured at the transmission');
            const names = ['ATF', 'EGS chip 1', 'EGS chip 2'], keys = ['oil', 'chip1', 'chip2'];
            G.panel(cv, t, 24, 210, 960, 278, names[graphMetric] + ' / current session');
            const hist = demo() ? DEMO.history : reader.history, points = hist.filter((p) => E.finite(p[keys[graphMetric]]));
            const px = 82, py = 284, pw = 864, ph = 153;
            [0, 0.5, 1].forEach((f) => {
                const y = py + ph * (1 - f);
                cv.line(px, y, px + pw, y, 1, withAlpha(t.text, 0.13));
                cv.text(String(Math.round(f * 140)), px - 12, y + 6, 18, t.dim, { align: 'right' });
            });
            if (points.length > 1) {
                const start = points[0].t, end = Math.max(start + 1000, points[points.length - 1].t);
                cv.polyline(points.map((p) => [px + (p.t - start) / (end - start) * pw, py + ph * (1 - Math.max(0, Math.min(140, p[keys[graphMetric]])) / 140)]), 3, BLUE);
                cv.text(Math.round((end - start) / 60000) + ' min recorded', px, 470, 19, t.dim);
            } else cv.text('Waiting for fresh temperature samples', px + pw / 2, py + 85, 24, t.dim, { align: 'center' });
            G.panel(cv, t, 1004, 210, 572, 278, 'Mechatronics / converter');
            const win = values('DB03');
            const rows = [['EGS chip 1', n(value('6005')) + ' C'], ['EGS chip 2', n(value('601D')) + ' C'],
                ['Engine speed', n(value('DA34')) + ' rpm'], ['Converter clutch', E.TCC[value('DA22')] || '--'],
                ['Reported oil-service window', win.length === 2 ? n(win[0]) + '..' + n(win[1]) + ' C' : '--']];
            rows.forEach((r, i) => { cv.text(r[0], 1022, 287 + i * 39, 20, t.dim); cv.text(r[1], 1558, 287 + i * 39, 22, t.text, { align: 'right' }); });
            footer(cv, t, 'Next item: change plotted temperature.  ' + freshness(['6000', 'DA2A', 'DA34', '6005', '601D', 'DA22']));
        }
        function clutches(cv, t) {
            subtitle(cv, t, 'Clutch fill adaptation / A - E', freshness(CLUTCH_DIDS));
            G.panel(cv, t, 24, 94, 1080, 378, 'Learned offsets');
            const cols = [{ label: 'Pack', w: 115 }, { label: 'Pressure mbar', w: 245, align: 'right' },
                { label: 'Fast fill ms', w: 230, align: 'right' }, { label: 'Time eval.', w: 225, align: 'right' }, { label: 'Pressure eval.', w: 225, align: 'right' }];
            const rows = PACKS.map((p, i) => [{ text: p, color: i === pack ? BLUE : t.text, font: 'bold' }, signed(value('413A', i)),
                signed(value('4140', i)), n(value('4130', i)), n(value('4131', i))]);
            G.table(cv, t, 44, 157, 1040, cols, rows, { rowH: 48, headerSize: 18, size: 29 });
            G.panel(cv, t, 1124, 94, 452, 378, 'Pack ' + PACKS[pack] + ' / cold adaptation');
            const details = [['Cold correction (raw units)', signed(value('418A', pack))], ['Cold evaluations', n(value('4189', pack))],
                ['Cold shift counter', n(value('418B', pack))], ['Start evaluations', n(value('418C', pack))]];
            details.forEach((r, i) => { cv.text(r[0], 1142, 174 + i * 75, 21, t.dim); cv.text(r[1], 1554, 213 + i * 75, 33, BLUE, { align: 'right', font: 'num' }); });
            footer(cv, t, 'Pressure and fast-fill time are corrections to base calibration. Next item: select pack.');
        }
        function counterFor(s) {
            if (!s) return null;
            const f = family() === '2' || family() === 'cold2' ? 2 : 1;
            if (/cold/.test(family()) && s.toGear - s.fromGear === 1) return value(f === 2 ? '41BA' : '41B9', s.fromGear - 1);
            if (s.toGear > s.fromGear) return value(f === 2 ? '4136' : '4133', s.fromGear - 1);
            const xs = C.shifts.filter((m) => m.family === f && m.toGear < m.fromGear);
            return value(f === 2 ? '4137' : '4134', xs.findIndex((m) => m.did === s.did));
        }
        function shifts(cv, t) {
            const xs = maps(), familyLabel = /cold/.test(family()) ? 'Cold KF' + family().slice(-1) : 'KF' + family();
            const first = Math.floor(shift / 7) * 7;
            subtitle(cv, t, 'Shift adaptation / ' + familyLabel + ' / ' + settings.get('shiftGroup'), 'View / refresh: open selected map');
            G.panel(cv, t, 24, 94, 1552, 382, 'Per-shift map summary / ' + (first + 1) + '-' + Math.min(first + 7, xs.length) + ' of ' + xs.length);
            const rows = xs.slice(first, first + 7).map((s, i) => {
                const m = E.mapValues(records(), s, family()), z = E.summary(m.values);
                return [{ text: s.label, color: first + i === shift ? BLUE : t.text, font: 'bold' }, n(counterFor(s)),
                    z ? signed(z.min) : '--', z ? signed(z.mean, 1) : '--', z ? signed(z.max) : '--', z ? z.count + ' cells' : 'not read', age(m.record)];
            });
            const cols = [{ label: 'Shift', w: 160 }, { label: 'Adapt. count', w: 220, align: 'right' }, { label: 'Min mbar', w: 220, align: 'right' },
                { label: 'Mean mbar', w: 220, align: 'right' }, { label: 'Max mbar', w: 220, align: 'right' }, { label: 'Map', w: 220, align: 'right' }, { label: 'Age', w: 240, align: 'right' }];
            G.table(cv, t, 44, 154, 1512, cols, rows, { rowH: 37, size: 25, headerSize: 18 });
            if (!xs.length) cv.text('This map family has no selected shift group', 800, 330, 28, t.dim, { align: 'center' });
            footer(cv, t, 'Counts belong to adaptation learning. Map statistics are learned pressure offsets; they are not shift durations.');
        }
        function heatmap(cv, t) {
            const s = chosen(), m = E.mapValues(records(), s, family()), z = E.summary(m.values);
            const cold = /cold/.test(family()), fam = cold ? 'Cold KF' + family().slice(-1) : 'KF' + family();
            subtitle(cv, t, 'Shift ' + (s ? s.label : '--') + ' / ' + fam, 'Next item: shift   /   View: map family');
            G.panel(cv, t, 24, 94, 1056, 390, 'Learned pressure offset / mbar');
            const cols = m.values.length === 24 ? 6 : 8, rows = Math.ceil(m.values.length / cols), x0 = 112, y0 = 183, cw = 112, ch = 34;
            for (let x = 0; x < cols; x++) cv.text(String(x + 1), x0 + x * cw + 51, 172, 19, t.dim, { align: 'center' });
            for (let y = 0; y < rows; y++) {
                cv.text(String(y + 1), 82, y0 + y * ch + 24, 19, t.dim, { align: 'right' });
                for (let x = 0; x < cols; x++) {
                    const v = m.values[y * cols + x];
                    if (!E.finite(v)) continue;
                    const a = Math.min(1, Math.abs(v) / Math.max(50, z ? Math.max(Math.abs(z.min), Math.abs(z.max)) : 50));
                    cv.fillRect(x0 + x * cw, y0 + y * ch, cw - 5, ch - 4, mix(t.panelBottom, v < 0 ? '#245d92' : '#217368', 0.12 + a * 0.7));
                    cv.text(signed(v), x0 + x * cw + 51, y0 + y * ch + 23, 21, t.text, { align: 'center', font: 'num' });
                }
            }
            if (!m.values.length) cv.text(m.error || 'Waiting for the selected map', 552, 310, 25, t.dim, { align: 'center' });
            G.panel(cv, t, 1100, 94, 476, 390, fam + ' / map summary');
            const summary = [['Minimum', z ? signed(z.min) + ' mbar' : '--'], ['Mean', z ? signed(z.mean, 1) + ' mbar' : '--'],
                ['Maximum', z ? signed(z.max) + ' mbar' : '--'], ['Adaptation count', n(counterFor(s))], ['Updated', age(m.record)]];
            summary.forEach((r, i) => { cv.text(r[0], 1120, 177 + i * 59, 21, t.dim); cv.text(r[1], 1554, 204 + i * 59, 26, t.text, { align: 'right' }); });
            footer(cv, t, cold ? 'Rows: turbine-speed support-point index. Columns: torque support-point index; physical breakpoints not supplied.'
                : 'Rows and columns are storage-cell indices. Physical RPM/torque breakpoints are not supplied by this record.');
        }
        function temperatures(cv, t) {
            const d = thermalDid(), vs = values(d), total = vs.reduce((a, b) => a + b, 0), max = Math.max.apply(null, [1].concat(vs));
            subtitle(cv, t, (thermal % 2 ? 'EGS electronics' : 'Transmission oil') + ' / lifetime temperature distribution',
                'Total recorded ' + n(total / 3600, 1) + ' h / ' + age(rec(d)));
            for (let col = 0; col < 3; col++) {
                const x = 24 + col * 524;
                G.panel(cv, t, x, 94, 504, 390, col === 0 ? 'Cold / warm' : col === 1 ? 'Temperature bands' : 'Upper temperature bands');
                for (let row = 0; row < 8; row++) {
                    const i = col * 8 + row;
                    if (i >= C.ranges.length) continue;
                    const y = 177 + row * 40, v = vs[i];
                    cv.fillRect(x + 14, y - 23, 474 * (E.finite(v) ? v / max : 0), 29, withAlpha(BLUE, 0.14));
                    cv.text(C.ranges[i] + ' C', x + 18, y, 22, t.text);
                    cv.text(E.finite(v) ? n(v / 3600, 2) + ' h' : '--', x + 356, y, 23, t.text, { align: 'right', font: 'num' });
                    cv.text(E.finite(v) && total ? n(v / total * 100, 1) + '%' : '--', x + 484, y, 19, t.dim, { align: 'right' });
                }
            }
            footer(cv, t, 'Next item: oil / electronics. Historical time counters read from EGS; these are not recommended temperature limits.');
        }
        function details(cv, t) {
            subtitle(cv, t, ['Converter / learning / service data', 'EGS fault memory', 'All available diagnostic records'][detailMode],
                detailMode === 2 ? 'Next item: next records / View: return to summary' : 'Next item: next details view');
            G.panel(cv, t, 24, 94, 1552, 390, ['Additional measured data', 'Pending and confirmed faults / read only', 'Record ' + (recordPage * 7 + 1) + ' / ' + Object.keys(C.records).length][detailMode]);
            if (detailMode === 0) {
                const lt = value('6081'), win = values('DB03'), rpm = values('DB04');
                const left = [['EGS operating time (without standby)', n(E.finite(lt) ? lt / 60 : null, 1) + ' h'],
                    ['Stationary adaptation counter', n(value('6090'))], ['TCC fast-fill correction', signed(value('41A0'), 1) + ' ms'],
                    ['TCC fast-fill evaluation counter', n(value('41A1'))], ['TCC base-point adaptation', signed(value('41B3')) + ' mA'],
                    ['TCC base-point evaluation counter', n(value('41B4'))]];
                left.forEach((r, i) => { cv.text(r[0], 44, 177 + i * 45, 21, t.dim); cv.text(r[1], 795, 177 + i * 45, 26, t.text, { align: 'right' }); });
                const right = [['Engagement offset D1 / D2 / R', values('412F').map((v) => signed(v)).join(' / ') + ' mbar'],
                    ['Release offset D1 / D2 / R', values('41B0').map((v) => signed(v)).join(' / ') + ' mbar'],
                    ['Engagement evaluations', values('415F').map((v) => n(v)).join(' / ')], ['Release evaluations', values('41B1').map((v) => n(v)).join(' / ')],
                    ['EGS oil-service temperature window', win.length ? win.join('..') + ' C' : '--'], ['EGS oil-service RPM window', rpm.length ? rpm.join('..') + ' rpm' : '--']];
                right.forEach((r, i) => { cv.text(r[0], 840, 165 + i * 50, 20, t.dim); cv.text(r[1], 1552, 191 + i * 50, 24, BLUE, { align: 'right' }); });
                footer(cv, t, 'View / refresh: save snapshot. ' + freshness(DETAIL_DIDS));
            } else if (detailMode === 1) {
                const faults = demo() ? [] : reader.faults;
                if (faults === null) cv.text('Waiting for an EGS fault-memory response', 800, 302, 29, t.dim, { align: 'center' });
                else if (!faults.length) cv.text('No pending or confirmed EGS faults returned', 800, 302, 29, TEAL, { align: 'center' });
                else faults.slice(0, 7).forEach((r, i) => {
                    cv.text(r.code, 50, 182 + i * 40, 28, t.text, { font: 'num' });
                    cv.text('status 0x' + r.status.toString(16).toUpperCase(), 330, 182 + i * 40, 24, t.dim);
                });
                footer(cv, t, 'ReadDTCByStatusMask 0x0C / no erase command. ' + (reader.faultsAt ? age({ at: reader.faultsAt }) : 'Not read yet'));
            } else {
                const ids = Object.keys(C.records).sort().slice(recordPage * 7, recordPage * 7 + 7);
                ids.forEach((d, i) => {
                    const r = rec(d), y = 179 + i * 41, meta = C.records[d];
                    cv.text(d, 44, y, 24, BLUE, { font: 'num' });
                    cv.text(fit(cv, meta.name.replace(/^_/, ''), 690, 19), 150, y, 19, t.text);
                    const v = r && r.ok ? (r.decoded ? r.values.slice(0, 5).map((x) => n(x, meta.fields[0] && meta.fields[0].unit === 'bar' ? 2 : 0)).join(' / ') : r.bytes + ' bytes / raw') : r && r.error || 'not read';
                    cv.text(fit(cv, v, 440, 22), 1300, y, 22, t.text, { align: 'right' });
                    cv.text(age(r), 1554, y, 18, t.dim, { align: 'right' });
                });
                footer(cv, t, 'Raw-only records are saved without a guessed decoder. Snapshot keeps raw payloads and decoded values.');
            }
        }
        function reference(cv, t) {
            subtitle(cv, t, 'ZF 8HP / shift-element reference', 'Controller on this car: GSZFBCE / 0F25D0');
            G.panel(cv, t, 24, 94, 795, 390, 'Expected applied elements / reference');
            const gs = ['R', '1', '2', '3', '4', '5', '6', '7', '8'];
            const rows = gs.map((g, i) => [{ text: g, color: i === matrixGear ? BLUE : t.text }].concat(PACKS.map((p) => C.clutchMatrix[g].indexOf(p) >= 0 ? { text: 'ON', color: BLUE } : '-')));
            G.table(cv, t, 44, 153, 750, [{ label: 'Gear', w: 125 }].concat(PACKS.map((p) => ({ label: p, w: 125, align: 'center' }))), rows,
                { rowH: 30, size: 22, headerSize: 18 });
            G.panel(cv, t, 839, 94, 737, 390, 'Understanding the data');
            const lines = ['A / B: brakes. C / D / E: clutches.', 'Three elements transmit each forward ratio.',
                'Fill pressure and time: learned corrections.', 'Positive / negative offsets are both possible.',
                'KF1 / KF2 keep separate adaptation maps.', 'Cell indices do not reveal RPM/torque limits.',
                'Temperature tables show accumulated time.', 'Data source: BMW/ZF GSZFBCE rev. 15.000.'];
            lines.forEach((s, i) => cv.text(s, 859, 174 + i * 38, 23, i === 2 ? BLUE : t.text));
            footer(cv, t, 'Reference matrix: ZF external transmission training, 8HP power flow. Applied-element diagram, not a pressure measurement.');
        }

        ctx.loop('MAIN', 5, () => {
            const t = ctx.theme(), cv = ctx.canvas(1600, 520).clear(t.bg);
            const state = demo() ? 'DEMO' : reader.status();
            G.frame(cv, t, PAGES, page, [{ text: 'EXPERIMENTAL', color: t.warn },
                { text: state, color: state === 'LIVE' ? BLUE : t.warn }]);
            [live, clutches, shifts, heatmap, temperatures, details, reference][page](cv, t);
            if (!demo() && reader.checked && !reader.supported) {
                cv.fillRect(24, 94, 1552, 390, t.bg);
                cv.text('This EGS variant is not supported by the verified decoder', 800, 260, 32, t.warn, { align: 'center' });
                cv.text(reader.lastError, 800, 315, 25, t.dim, { align: 'center' });
            }
            if (message && Date.now() < messageUntil) {
                cv.fillRect(24, 478, 1552, 37, t.bg);
                cv.text(message, 800, 504, 22, BLUE, { align: 'center' });
            }
            return ui.image('MAIN_GFX', cv);
        });
    },
});
