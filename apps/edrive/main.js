'use strict';
/**
 * eDrive - what the high-voltage battery really gives you.
 *
 *   - real electric range: displayed charge x your own "range at 100%" for the
 *     outside temperature (cold / mild / hot bands, set in Settings)
 *   - battery health (SOH): usable capacity compared to a new battery
 *   - design capacity left: charge x SOH, i.e. how much of a NEW battery's
 *     full energy is still in the pack right now (also in kWh)
 *   - last charge: how much the HV battery gained on the last charge (also a
 *     charge done while the head unit was asleep: the charge at switch-off is
 *     kept and compared at the next start)
 *   - 12 V battery voltage
 *   - charge log page: every charge with energy, range and (optional) cost,
 *     monthly / all-time totals and a 14-day chart
 *
 * Charge, SOH and 12 V are read with UDS ReadDataByIdentifier over the head
 * unit's diagnostic link (kit/diag.js); the DIDs and scalings live in app.json
 * "config.battery" so they can be adjusted per model. Outside temperature and
 * speed come over SOME/IP.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { Canvas, withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { Diag, hex, NRC } = require('./kit/diag');

const W = 1600, H = 520;
const GO = '#2fd27a';
const PAGES = ['main', 'log', 'diag'];
const LOG_MAX = 200;             // charges kept in the log
const LOSS = 1.1;                // grid energy per kWh stored (charger + battery losses, estimate)
const KM_MI = 0.621371;
const VALUES = ['soc', 'soh', 'v12'];

/** Demo: charge drains, outside temperature swings across the cold threshold. */
class Demo {
    constructor() { this.t0 = Date.now(); }
    sample() {
        const s = (Date.now() - this.t0) / 1000;
        return {
            soc: 100 - (s * 0.8) % 95, soh: 91.5, ambient: 11 + 9 * Math.sin(s / 12), v12: 12.45 + 0.05 * Math.sin(s / 5),
            charge: { from: 28, to: 97, toT: this.t0 - 3 * 3600000, kwh: 7.6 },
        };
    }
    log() {
        if (!this._log) {
            // ~3 weeks of plausible charges, newest last
            this._log = [];
            let t = this.t0 - 21 * 86400000;
            for (let i = 0; i < 16; i++) {
                t += (0.8 + ((i * 37) % 10) / 10) * 86400000;
                const from = 12 + (i * 23) % 40, to = Math.min(100, from + 35 + (i * 17) % 50);
                this._log.push({ from, to, fromT: t - 4 * 3600000, toT: t, kwh: (to - from) / 100 * 12 * 0.915 });
            }
        }
        return this._log;
    }
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const cfg = Object.assign({ ecu: 7, soc: [], soh: [], v12: [], sohEverySec: 300, chargeMinPct: 3 },
            (ctx.spec.config && ctx.spec.config.battery) || {});
        const S = (ctx.spec.config && ctx.spec.config.scaling) || {};
        const sc = (k, raw) => {
            const c = S[k];
            if (!c || raw === undefined || raw === null || raw === c.invalid) return null;
            return raw * c.factor + (c.offset || 0);
        };

        /* ---------- persisted state: SOH, the last charge reading and the last charge session ---------- */
        const STATE = path.join(ctx.dataDir, 'battery.json');
        let st = {};
        try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')) || {}; } catch (e) { /* first run */ }
        if (st.lastCharge && !st.log) st.log = [st.lastCharge];      // saved by v1.1 (no log yet)
        let savedAt = 0;
        const save = () => {
            savedAt = Date.now();
            try { fs.writeFileSync(STATE, JSON.stringify(st)); } catch (e) { log.warn('save: ' + e); }
        };
        const live = { soc: null, socT: 0, soh: G.isNum(st.soh) ? st.soh : null, sohT: st.sohT || 0, v12: null, v12T: 0, ambient: null, speed: null };
        const raws = {};                       // 'ecu:did' -> { bytes, value, ok, why, t }
        const pick = { soc: 0, soh: 0, v12: 0 };   // index of the candidate that answered last

        ctx.signals.watch('de.bmw.infrastructure.EnvironmentalInformation', '1', {
            ExteriorTemperature: (v) => { const a = sc('ambient', v.temperatureExterior); if (a !== null) live.ambient = a; },
        }, log).then((s) => log.info('ambient ' + (s.error ? 'error: ' + s.error : 'subscribed')));
        ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusCarSpeed2: (v) => { const k = v.speedVehicleCentreOfGravity; live.speed = k === 65535 || k == null ? null : k * 0.015625; },
        }, log).then((s) => log.info('speed ' + (s.error ? 'error: ' + s.error : 'subscribed')));

        const diag = await new Diag(ctx.signals, log).init();
        diag.quiet = true;                     // polled every few seconds: keep the log file small
        const demo = new Demo();
        const usingDemo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !diag.available && !live.socT);

        /* ---------- UDS reads ---------- */
        /** Read one candidate { ecu?, did, bytes, at, factor, offset, min, max }; returns the value or null. */
        async function readDid(c) {
            const ecu = c.ecu == null ? cfg.ecu : c.ecu, did = parseInt(c.did, 16);
            const r = { t: Date.now(), ok: false, value: null, bytes: '', why: '' };
            raws[ecu + ':' + c.did] = r;
            let uds;
            try { uds = await diag.physical(ecu, 0x22, [did >> 8, did & 0xFF], 4000); } catch (e) { r.why = String(e.message || e); return null; }
            if (!uds) { r.why = 'no reply'; return null; }
            r.bytes = uds.map((x) => hex(x)).join(' ');
            if (uds[0] === 0x7F) { r.why = 'NRC ' + hex(uds[2]) + (NRC[uds[2]] ? ' ' + NRC[uds[2]] : ''); return null; }
            if (uds[0] !== 0x62 || ((uds[1] << 8) | uds[2]) !== did) { r.why = 'unexpected reply'; return null; }
            const at = 3 + (c.at || 0), n = c.bytes || 1;
            if (uds.length < at + n) { r.why = 'reply too short'; return null; }
            let raw = 0;
            for (let i = 0; i < n; i++) raw = raw * 256 + uds[at + i];
            const v = raw * (c.factor == null ? 1 : c.factor) + (c.offset || 0);
            r.value = v;
            if ((c.min != null && v < c.min) || (c.max != null && v > c.max)) { r.why = 'out of range'; return null; }
            r.ok = true;
            return v;
        }

        /** Try a value's candidates, starting with the one that worked last. */
        async function readValue(key) {
            const list = cfg[key] || [];
            for (let k = 0; k < list.length; k++) {
                const i = (pick[key] + k) % list.length;
                const v = await readDid(list[i]);
                if (v !== null) { pick[key] = i; return v; }
            }
            return null;
        }

        /* ---------- last charge ----------
         * A charge = the charge level rising by >= chargeMinPct while the car stands still
         * (regen while driving doesn't count). The last reading is saved, so a charge done
         * while the head unit slept shows up as a jump at the next start. */
        const chargeKwh = (from, to) => (G.isNum(live.soh) ? (to - from) / 100 * settings.get('designKwh') * live.soh / 100 : null);
        function closeSession() {
            const s = st.session;
            st.session = null;
            if (s && s.to - s.from >= cfg.chargeMinPct) {
                st.lastCharge = { from: s.from, to: s.to, fromT: s.fromT, toT: s.toT, kwh: chargeKwh(s.from, s.to) };
                st.log = (st.log || []).concat([st.lastCharge]).slice(-LOG_MAX);
                log.info('charge ' + s.from.toFixed(1) + ' -> ' + s.to.toFixed(1) + ' %');
            }
            save();
        }
        function onSoc(soc, now) {
            const prev = st.lastSoc, moving = G.isNum(live.speed) && live.speed > 3;
            if (G.isNum(prev)) {
                if (soc > prev + 0.3 && !moving) {
                    if (!st.session) st.session = { from: prev, fromT: st.lastSocT || now };
                    st.session.to = soc; st.session.toT = now;
                    save();
                } else if (st.session && (soc < st.session.to - 0.5 || moving)) {
                    closeSession();
                }
            }
            st.lastSoc = soc; st.lastSocT = now;
            if (now - savedAt > 120000) save();
        }
        /** The charge to show: one in progress (big enough to count), else the last finished one. */
        function lastCharge() {
            const s = st.session;
            if (s && s.to - s.from >= cfg.chargeMinPct) return Object.assign({}, s, { kwh: chargeKwh(s.from, s.to), open: true });
            return st.lastCharge || null;
        }

        let busy = false, pollTimer = null;
        async function poll(forceSoh) {
            if (busy) return;
            busy = true;
            try {
                if (diag.available) {
                    const soc = await readValue('soc');
                    if (soc !== null) { live.soc = soc; live.socT = Date.now(); onSoc(soc, live.socT); }
                    if (forceSoh || live.soh === null || Date.now() - live.sohT > cfg.sohEverySec * 1000) {
                        const soh = await readValue('soh');
                        if (soh !== null) { live.soh = soh; live.sohT = Date.now(); st.soh = soh; st.sohT = live.sohT; save(); }
                    }
                    const v12 = await readValue('v12');
                    if (v12 !== null) { live.v12 = v12; live.v12T = Date.now(); }
                }
            } catch (e) { log.warn('poll: ' + e); }
            busy = false;
        }
        function schedule() {
            clearTimeout(pollTimer);
            pollTimer = setTimeout(() => poll(false).then(schedule), settings.get('poll') * 1000);
        }
        diag.on('available', (a) => { if (a) poll(false); });
        poll(true).then(schedule);

        /* ---------- derived values ---------- */
        function data() {
            if (usingDemo()) return Object.assign(demo.sample(), { demo: true, socAge: 0 });
            const maxAge = Math.max(60, settings.get('poll') * 4) * 1000, now = Date.now();
            return {
                soc: live.soc, soh: live.soh, ambient: live.ambient, demo: false,
                socAge: live.socT ? now - live.socT : null, stale: !(live.socT && now - live.socT < maxAge),
                v12: live.v12T && now - live.v12T < maxAge ? live.v12 : null, charge: lastCharge(),
            };
        }
        function band(tC) {
            if (!G.isNum(tC)) return 'mild';
            if (tC < settings.get('coldBelow')) return 'cold';
            if (tC > settings.get('hotAbove')) return 'hot';
            return 'mild';
        }
        const fullRange = (b) => settings.get({ cold: 'rangeCold', mild: 'rangeMild', hot: 'rangeHot' }[b]);

        /* ---------- units ---------- */
        const MI = () => settings.get('distUnit') === 'mi';
        const D = (km) => (G.isNum(km) ? (MI() ? km * KM_MI : km) : null);
        const dU = () => (MI() ? 'mi' : 'km');
        const F = () => settings.get('tempUnit') === 'f';
        const T = (c) => (G.isNum(c) ? (F() ? c * 9 / 5 + 32 : c) : null);
        const tU = () => (F() ? '°F' : '°C');
        const ago = (ms) => (ms == null ? 'not read yet' : ms < 60000 ? Math.max(0, Math.round(ms / 1000)) + ' s ago' : ms < 3600000 ? Math.round(ms / 60000) + ' min ago'
            : ms < 172800000 ? Math.round(ms / 3600000) + ' h ago' : Math.round(ms / 86400000) + ' days ago');

        /* ---------- drawing ---------- */
        let page = 0;
        ui.onClick('BTN_PAGE', () => { page = (page + 1) % PAGES.length; return render(); });
        ui.onClick('BTN_READ', () => poll(true).then(render));

        function header(cv, t, title, d) {
            cv.text(title, 24, 34, 24, t.dim, { font: 'bold', spacing: 3 });
            G.stripes(cv, t, 24, 44, 120);
            PAGES.forEach((p, i) => cv.circle(W - 196 + i * 22, 26, i === page ? 6 : 4, i === page ? t.accent : t.tick));
            if (d.demo) {
                cv.roundRect(W - 124, 12, 100, 30, 6, withAlpha(t.warn, 0.2));
                cv.text('DEMO', W - 74, 35, 22, t.warn, { align: 'center', font: 'bold', spacing: 2 });
            }
        }

        function battery(cv, t, x, y, w, h, soc) {
            const f = G.isNum(soc) ? G.clamp(soc / 100, 0, 1) : 0;
            const col = !G.isNum(soc) ? t.tick : soc < 10 ? t.crit : soc < 25 ? t.warn : GO;
            cv.strokeRoundRect(x, y, w, h, 14, 5, t.tick);
            cv.roundRect(x + w + 2, y + h * 0.3, 16, h * 0.4, 4, t.tick);
            const iw = w - 24, ih = h - 24, seg = iw / 10;
            for (let i = 0; i < 10; i++) cv.roundRect(x + 12 + i * seg, y + 12, seg - 6, ih, 5, f * 10 > i + 0.05 ? col : t.track);
            const i = Math.floor(f * 10), part = f * 10 - i;
            if (i < 10 && part > 0.05) cv.roundRect(x + 12 + i * seg, y + 12, (seg - 6) * part, ih, 5, withAlpha(col, 0.55));
        }

        function renderMain(cv, t, d) {
            const b = band(d.ambient), full = fullRange(b);
            const range = G.isNum(d.soc) ? d.soc / 100 * full : null;

            // ---- range
            G.panel(cv, t, 24, 64, 720, 440, 'Real electric range');
            const rs = G.isNum(range) ? String(Math.round(D(range))) : '--';
            const rw = cv.text(rs, 48, 268, 150, G.isNum(range) ? t.text : t.dim, { font: 'num' });
            cv.text(dU(), 62 + rw, 268, 44, t.dim, { font: 'bold' });
            if (d.stale && G.isNum(d.soc)) cv.text('charge read ' + ago(d.socAge), 720, 130, 20, t.warn, { align: 'right' });
            cv.text(G.isNum(d.soc) ? G.fmt(d.soc, 0) + ' % × ' + Math.round(D(full)) + ' ' + dU() + ' per full charge' : 'no charge reading - see Diagnostics page',
                48, 316, 24, t.dim);
            const bands = [
                ['cold', 'COLD', '< ' + Math.round(T(settings.get('coldBelow'))) + tU(), t.cold],
                ['mild', 'MILD', Math.round(T(settings.get('coldBelow'))) + '-' + Math.round(T(settings.get('hotAbove'))) + tU(), GO],
                ['hot', 'HOT', '> ' + Math.round(T(settings.get('hotAbove'))) + tU(), t.warn],
            ];
            bands.forEach(([k, name, span, col], i) => {
                const bx = 48 + i * 228, by = 344, on = k === b;
                cv.roundRect(bx, by, 212, 84, 10, on ? withAlpha(col, 0.25) : t.track);
                if (on) cv.fillRect(bx, by + 78, 212, 6, col);
                cv.text(name + '  ' + span, bx + 14, by + 32, 22, on ? col : t.dim, { font: 'bold', spacing: 1 });
                cv.text(Math.round(D(fullRange(k))) + ' ' + dU() + ' / 100%', bx + 14, by + 66, 24, on ? t.text : t.dim, { font: 'label' });
            });
            const amb = G.isNum(d.ambient) ? G.fmt(T(d.ambient), 1) + ' ' + tU() : 'n/a (mild assumed)';
            cv.text('OUTSIDE  ' + amb, 48, 480, 22, t.dim, { font: 'bold', spacing: 1.5 });
            // 12 V battery: resting ~12.4-12.8 V, 13.5-14.8 V while the DC/DC or alternator charges it
            const v = d.v12, vcol = !G.isNum(v) ? t.dim : v < 11.8 ? t.crit : v < 12.2 || v > 15.2 ? t.warn : t.text;
            const vw = cv.text(G.isNum(v) ? v.toFixed(2) + ' V' : 'n/a', 720, 482, 32, vcol, { font: 'bold', align: 'right' });
            cv.text('12 V BATTERY', 708 - vw, 480, 22, t.dim, { font: 'bold', spacing: 1.5, align: 'right' });

            // ---- charge + last charge
            G.panel(cv, t, 768, 64, 380, 440, 'Charge');
            battery(cv, t, 796, 118, 300, 100, d.soc);
            const ss = G.isNum(d.soc) ? G.fmt(d.soc, 0) : '--';
            const sw = cv.text(ss, 940, 318, 96, G.isNum(d.soc) ? t.text : t.dim, { font: 'num', align: 'center' });
            cv.text('%', 948 + sw / 2, 318, 36, t.dim, { font: 'bold' });
            cv.text(d.demo ? 'demo data' : 'read ' + ago(d.socAge), 958, 350, 20, t.dim, { align: 'center' });
            cv.fillRect(792, 368, 332, 1, t.tick);
            const c = d.charge;
            cv.text(c && c.open ? 'CHARGING / JUST CHARGED' : 'LAST CHARGE', 792, 398, 20, c && c.open ? GO : t.dim, { font: 'bold', spacing: 1.5 });
            if (c) {
                const add = c.to - c.from;
                const aw = cv.text('+' + add.toFixed(0) + ' %', 792, 446, 44, GO, { font: 'bold' });
                const extra = [G.isNum(c.kwh) ? c.kwh.toFixed(1) + ' kWh' : null, '+' + Math.round(D(add / 100 * fullRange('mild'))) + ' ' + dU()].filter(Boolean).join('  ·  ');
                cv.text(extra, 806 + aw, 444, 24, t.text, { font: 'label' });
                cv.text('from ' + Math.round(c.from) + ' to ' + Math.round(c.to) + ' %  ·  ' + (c.open ? 'now' : ago(Date.now() - c.toT)), 792, 484, 22, t.dim);
            } else {
                cv.text('no charge seen yet', 792, 444, 24, t.dim);
                cv.text('shows after the next charge', 792, 484, 20, t.dim);
            }

            // ---- health + design capacity left
            const soh = d.soh, left = G.isNum(d.soc) && G.isNum(soh) ? d.soc * soh / 100 : null;
            const kwh = settings.get('designKwh');
            G.stat(cv, t, 1172, 64, 404, 212, {
                label: 'Battery health (SOH)', value: soh, unit: '%', decimals: 1, size: 88,
                sub: G.isNum(soh) ? 'holds ' + G.fmt(kwh * soh / 100, 1) + ' of ' + kwh + ' kWh new' : 'not readable - see Diagnostics',
                zones: [{ from: 0, to: 70, color: 'crit' }, { from: 70, to: 80, color: 'warn' }],
            });
            G.stat(cv, t, 1172, 292, 404, 212, {
                label: 'Design capacity left', value: left, unit: '%', decimals: 0, size: 88,
                sub: G.isNum(left) ? G.fmt(kwh * left / 100, 1) + ' kWh of ' + kwh + ' kWh (new, full)' : 'needs charge + SOH',
                zones: [{ from: 0, to: 10, color: 'crit' }, { from: 10, to: 25, color: 'warn' }],
            });
        }

        const pad = (n) => (n < 10 ? '0' : '') + n;
        const dateOf = (ms) => { const x = new Date(ms); return pad(x.getDate()) + '.' + pad(x.getMonth() + 1) + '  ' + pad(x.getHours()) + ':' + pad(x.getMinutes()); };
        const price = () => settings.get('price') || 0;
        const money = (kwh) => (G.isNum(kwh) && price() > 0 ? (kwh * LOSS * price()).toFixed(2) + ' €' : null);

        function renderLog(cv, t, d) {
            const all = d.demo ? demo.log() : (st.log || []);
            const kwhOf = (c) => (G.isNum(c.kwh) ? c.kwh : 0);

            // ---- list, newest first
            G.panel(cv, t, 24, 64, 1040, 440, 'Charges' + (all.length ? '  (' + all.length + ')' : ''));
            const cols = [48, 230, 380, 590, 760, 920];
            ['DATE', 'ADDED', 'FROM - TO', 'ENERGY', 'RANGE', price() > 0 ? 'COST (EST.)' : ''].forEach((h, i) => cv.text(h, cols[i], 136, 18, t.dim, { font: 'bold', spacing: 1.5 }));
            cv.fillRect(48, 148, 992, 1, t.panelEdge);
            if (!all.length) {
                cv.text('No charges logged yet.', 544, 290, 32, t.dim, { align: 'center', font: 'bold' });
                cv.text('Every charge of at least ' + cfg.chargeMinPct + ' % is added here, also overnight charges', 544, 330, 22, t.dim, { align: 'center' });
                cv.text('(seen at the next start). Needs charge readings - see the Diagnostics page.', 544, 358, 22, t.dim, { align: 'center' });
            }
            all.slice(-8).reverse().forEach((c, i) => {
                const y = 186 + i * 40;
                if (i % 2 === 0) cv.roundRect(40, y - 28, 1008, 38, 8, withAlpha(t.track, 0.55));
                const add = c.to - c.from;
                cv.text(dateOf(c.toT), cols[0], y, 24, t.text, { font: 'label' });
                cv.text('+' + add.toFixed(0) + ' %', cols[1], y, 26, GO, { font: 'bold' });
                cv.text(Math.round(c.from) + ' - ' + Math.round(c.to) + ' %', cols[2], y, 24, t.dim, { font: 'label' });
                cv.text(G.isNum(c.kwh) ? c.kwh.toFixed(1) + ' kWh' : '-', cols[3], y, 24, t.text, { font: 'label' });
                cv.text('+' + Math.round(D(add / 100 * fullRange('mild'))) + ' ' + dU(), cols[4], y, 24, t.text, { font: 'label' });
                const m = money(c.kwh);
                if (m) cv.text(m, cols[5], y, 24, t.text, { font: 'label' });
            });

            // ---- totals + 14-day chart
            G.panel(cv, t, 1088, 64, 488, 440, 'Totals');
            const now = new Date(), monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
            const month = all.filter((c) => c.toT >= monthStart);
            const sum = (list) => list.reduce((a, c) => a + kwhOf(c), 0);
            const block = (y, label, list) => {
                cv.text(label, 1112, y, 18, t.dim, { font: 'bold', spacing: 1.5 });
                const kw = cv.text(sum(list).toFixed(1), 1112, y + 50, 48, t.text, { font: 'num' });
                cv.text('kWh', 1120 + kw, y + 50, 22, t.dim);
                const extra = [list.length + (list.length === 1 ? ' charge' : ' charges'), '+' + Math.round(D(list.reduce((a, c) => a + (c.to - c.from), 0) / 100 * fullRange('mild'))) + ' ' + dU(), money(sum(list))].filter(Boolean).join('  ·  ');
                cv.text(extra, 1552, y + 50, 20, t.dim, { align: 'right' });
            };
            block(132, 'THIS MONTH', month);
            block(222, 'ALL TIME', all);
            // kWh per day, last 14 days
            const day = 86400000, today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
            const days = [];
            for (let i = 13; i >= 0; i--) days.push(sum(all.filter((c) => c.toT >= today0 - i * day && c.toT < today0 - (i - 1) * day)));
            const top = Math.max(4, Math.max.apply(null, days));
            const gx = 1112, gy = 470, gh = 130, bw = 440 / 14;
            cv.text('KWH PER DAY, LAST 14 DAYS', gx, 326, 18, t.dim, { font: 'bold', spacing: 1.5 });
            days.forEach((v, i) => {
                const h = v > 0 ? Math.max(6, v / top * gh) : 0;
                cv.roundRect(gx + i * bw + 3, gy - gh, bw - 6, gh, 4, withAlpha(t.track, 0.6));
                if (h) cv.rampRect(gx + i * bw + 3, gy - h, bw - 6, h, 4, t.ramp || [t.accent]);
            });
            cv.text('today', gx + 440, gy + 26, 16, t.dim, { align: 'right' });
            cv.text('14 d ago', gx, gy + 26, 16, t.dim);
        }

        function renderDiag(cv, t, d) {
            G.panel(cv, t, 24, 64, 1552, 440, 'Battery diagnostics');
            const link = diag.p ? (diag.available ? 'link up' : 'link down') : 'no link (' + (diag.error || 'not started') + ')';
            cv.text('UDS 22 ReadDataByIdentifier  ·  ' + link + '  ·  ambient ' + (G.isNum(live.ambient) ? G.fmt(live.ambient, 1) + ' °C' : 'n/a')
                + '  ·  speed ' + (G.isNum(live.speed) ? G.fmt(live.speed, 0) + ' km/h' : 'n/a'), 48, 136, 24, t.text, { font: 'label' });
            const cols = [48, 160, 260, 380, 820, 1000, 1290];
            ['VALUE', 'ECU', 'DID', 'REPLY', 'DECODED', 'STATUS', 'READ'].forEach((h, i) => cv.text(h, cols[i], 180, 20, t.dim, { font: 'bold', spacing: 1.5 }));
            cv.fillRect(48, 190, 1504, 1, t.tick);
            let y = 224;
            VALUES.forEach((key) => (cfg[key] || []).forEach((c, i) => {
                const ecu = c.ecu == null ? cfg.ecu : c.ecu, r = raws[ecu + ':' + c.did];
                const used = pick[key] === i && r && r.ok;
                cv.text(key.toUpperCase() + (used ? ' *' : ''), cols[0], y, 24, used ? GO : t.text, { font: 'bold' });
                cv.text('0x' + hex(ecu), cols[1], y, 24, t.text, { font: 'label' });
                cv.text(c.did, cols[2], y, 24, t.text, { font: 'label' });
                const bytes = r ? r.bytes || '-' : '-';
                cv.text(bytes.length > 36 ? bytes.slice(0, 35) + '…' : bytes, cols[3], y, 22, t.dim, { font: 'label' });
                cv.text(r && G.isNum(r.value) ? G.fmt(r.value, key === 'v12' ? 2 : 1) : '-', cols[4], y, 24, t.text, { font: 'label' });
                cv.text(r ? (r.ok ? 'OK' : r.why) : 'not read', cols[5], y, 22, r && r.ok ? GO : r ? t.warn : t.dim, { font: 'label' });
                cv.text(r ? ago(Date.now() - r.t) : '-', cols[6], y, 22, t.dim, { font: 'label' });
                y += 36;
            }));
            cv.text('DIDs differ between models. If a value is n/a or wrong, edit config.battery in apps/edrive/app.json', 48, 440, 20, t.dim);
            cv.text('(ECU, DID, byte position, factor) and rebuild. Range bands and design capacity are in Settings.', 48, 468, 20, t.dim);
            if (d.demo) cv.text('Demo data is shown on the main page until the diagnostic link answers.', 1552, 468, 20, t.warn, { align: 'right' });
        }

        function render() {
            const t = ctx.theme(), d = data();
            const cv = new Canvas(W, H).clear(t.bg);
            header(cv, t, { main: 'EDRIVE', log: 'EDRIVE · CHARGE LOG', diag: 'EDRIVE · DIAGNOSTICS' }[PAGES[page]], d);
            if (PAGES[page] === 'diag') renderDiag(cv, t, d);
            else if (PAGES[page] === 'log') renderLog(cv, t, d);
            else renderMain(cv, t, d);
            return ui.image('MAIN_GFX', cv);
        }

        let loop = ctx.loop('MAIN', settings.get('fps'), render);
        settings.onChange((k) => {
            if (k === 'fps') { loop.stop(); loop = ctx.loop('MAIN', settings.get('fps'), render); }
            if (k === 'poll') schedule();
        });
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
