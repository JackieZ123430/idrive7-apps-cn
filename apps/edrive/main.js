'use strict';
/**
 * eDrive - what the high-voltage battery really gives you.
 *
 *   - real electric range: displayed charge x the range a full battery gives at
 *     the outside temperature (RANGE_CURVE, scaled to your "range at 20 °C"),
 *     with a low-high spread
 *   - battery health (SOH): usable capacity compared to a new battery
 *   - energy in the battery now: charge x SOH x size when new (kWh)
 *   - last charge: how much the HV battery gained on the last charge (also a
 *     charge done while the head unit was asleep: the charge at switch-off is
 *     kept and compared at the next start)
 *   - 12 V battery voltage
 *   - charge log page: every charge with energy, range and (optional) cost,
 *     monthly / all-time totals and a 14-day chart
 *   - cars without a hybrid system: when the battery unit never answers but the
 *     rest of the car does, only the 12 V battery is shown (setting "Hybrid system")
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
const { Diag, hex } = require('./kit/diag');
const { DidReader } = require('./kit/dids');

const W = 1600, H = 520;
const GO = '#2fd27a';
const PAGES_HYBRID = ['main', 'log', 'diag'], PAGES_12V = ['main', 'diag'];
const LOG_MAX = 200;             // charges kept in the log
const LOSS = 1.1;                // grid energy per kWh stored (charger + battery losses, estimate)
const KM_MI = 0.621371;
const VALUES = ['soc', 'soh', 'v12'];
const V12_HIST = 120;            // 12 V samples kept (one per 30 s = 1 h)

/**
 * Range of a full battery by outside temperature, for a car doing 50 km at 20 °C:
 * [°C, low km, high km]. Linear in between; warmer than 20 °C counts as 20 °C, colder
 * than -10 °C continues the -10..0 slope (never below 30 % of the 20 °C range).
 * Scaled by the "range at 20 °C" setting.
 */
const RANGE_CURVE = [[-10, 20, 30], [0, 30, 38], [10, 40, 45], [20, 50, 50]];

/** Demo: charge drains, outside temperature swings across the cold threshold. */
class Demo {
    constructor() { this.t0 = Date.now(); }
    sample() {
        const s = (Date.now() - this.t0) / 1000;
        return {
            soc: 100 - (s * 0.8) % 95, soh: 91.5, ambient: 6 + 14 * Math.sin(s / 12), v12: 12.45 + 0.05 * Math.sin(s / 5),
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
        const cfg = Object.assign({ ecu: 7, soc: [], soh: [], v12: [], chargeMinPct: 3 },
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

        ctx.signals.watch('de.bmw.infrastructure.EnvironmentalInformation', '1', {
            ExteriorTemperature: (v) => { const a = sc('ambient', v.temperatureExterior); if (a !== null) live.ambient = a; },
        }, log).then((s) => log.info('ambient ' + (s.error ? 'error: ' + s.error : 'subscribed')));
        ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusCarSpeed2: (v) => { const k = v.speedVehicleCentreOfGravity; live.speed = k === 65535 || k == null ? null : k * 0.015625; },
        }, log).then((s) => log.info('speed ' + (s.error ? 'error: ' + s.error : 'subscribed')));

        // connect in the background: the screen must not wait for the diagnostic link
        const diag = new Diag(ctx.signals, log);
        diag.quiet = true;                     // polled every few seconds: keep the log file small
        diag.init();
        const demo = new Demo();
        const usingDemo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !diag.available && !live.socT);

        /* ---------- UDS reads (candidates per value, see kit/dids.js) ---------- */
        const reader = new DidReader(diag, { ecu: cfg.ecu });
        const raws = reader.raws, pick = reader.pick;      // for the Diagnostics page
        const readValue = (key) => reader.value(key, cfg[key]);

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
                } else if (st.session && (soc < st.session.to - 2 || moving)) {
                    // ends when driving off or on a real drop; small dips while parked (cabin
                    // pre-conditioning, display wobble) keep the session open
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

        /* ---------- hybrid system or not ----------
         * Any reply from the battery unit (even a refusal) = there is a hybrid system.
         * No reply 3 times in a row while another unit answers = no hybrid system:
         * remembered, so the next start shows the 12 V page straight away. */
        let smeMiss = 0, lastSocTry = 0;
        function detectHybrid(otherUnitAnswered) {
            const rs = (cfg.soc || []).map((c) => raws[(c.ecu == null ? cfg.ecu : c.ecu) + ':' + c.did]);
            if (rs.some((r) => r && r.bytes)) {
                smeMiss = 0;
                if (st.noHybrid || !st.hybrid) { st.noHybrid = false; st.hybrid = true; save(); log.info('hybrid battery unit answers'); }
            } else if (rs.some((r) => r && r.why === 'no reply') && otherUnitAnswered && !st.hybrid) {
                if (++smeMiss >= 3 && !st.noHybrid) { st.noHybrid = true; save(); log.info('no hybrid battery unit: 12 V only'); }
            }
        }
        const isHybrid = () => (settings.get('hybrid') === 'yes' ? true : settings.get('hybrid') === 'no' ? false : !st.noHybrid);
        const pages = () => (isHybrid() ? PAGES_HYBRID : PAGES_12V);

        // 12 V history (one sample per 30 s)
        const v12hist = [];
        const sample12 = () => {
            const v = usingDemo() ? demo.sample().v12 : (live.v12T && Date.now() - live.v12T < 120000 ? live.v12 : null);
            v12hist.push(v); if (v12hist.length > V12_HIST) v12hist.shift();
        };
        setTimeout(sample12, 8000);
        setInterval(sample12, 30000);

        let busy = false, pollTimer = null;
        let v12Fail = 0, v12Try = 0, sohFailT = 0;
        async function poll(forceSoh) {
            if (busy) return;
            busy = true;
            try {
                if (diag.available) {
                    // 12 V: every poll; after 3 failures in a row only every 5 minutes
                    let v12 = null;
                    if (v12Fail < 3 || forceSoh || Date.now() - v12Try > 300000) {
                        v12Try = Date.now();
                        v12 = await readValue('v12');
                        if (v12 !== null) { live.v12 = v12; live.v12T = Date.now(); v12Fail = 0; } else v12Fail++;
                    }
                    // without a hybrid system only re-check the battery unit every 5 minutes
                    const noHy = st.noHybrid && settings.get('hybrid') !== 'yes';
                    if (!noHy || forceSoh || Date.now() - lastSocTry > 300000) {
                        lastSocTry = Date.now();
                        const soc = await readValue('soc');
                        if (soc !== null) { live.soc = soc; live.socT = Date.now(); onSoc(soc, live.socT); }
                        detectHybrid(v12 !== null);
                        // health changes over months: read it once every "sohDays" (kept across restarts),
                        // on "Read battery now", and after a failed read at most once an hour
                        const sohDue = live.soh === null || Date.now() - live.sohT > settings.get('sohDays') * 86400000;
                        if (!st.noHybrid && (forceSoh || (sohDue && Date.now() - sohFailT > 3600000))) {
                            const soh = await readValue('soh');
                            if (soh !== null) { live.soh = soh; live.sohT = Date.now(); st.soh = soh; st.sohT = live.sohT; save(); }
                            else sohFailT = Date.now();
                        }
                    }
                }
            } catch (e) { log.warn('poll: ' + e); }
            busy = false;
        }
        function schedule() {
            clearTimeout(pollTimer);
            pollTimer = setTimeout(() => poll(false).then(schedule), settings.get('poll') * 1000);
        }
        diag.on('available', (a) => { if (a) poll(false); });
        poll(false).then(schedule);

        /* ---------- derived values ---------- */
        function data() {
            if (usingDemo()) return Object.assign(demo.sample(), { demo: true, socAge: 0 });
            const maxAge = Math.max(60, settings.get('poll') * 4) * 1000, now = Date.now();
            return {
                soc: live.soc, soh: live.soh, sohAge: live.sohT ? now - live.sohT : null, ambient: live.ambient, demo: false,
                socAge: live.socT ? now - live.socT : null, stale: !(live.socT && now - live.socT < maxAge),
                v12: live.v12T && now - live.v12T < maxAge ? live.v12 : null, charge: lastCharge(),
            };
        }
        /** Range of a full battery at tC: { lo, hi, mid } in km (no temperature: 10 °C assumed). */
        function rangeAt(tC) {
            const k = settings.get('range20') / 50, c = RANGE_CURVE;
            const t = G.isNum(tC) ? tC : 10;
            let lo, hi;
            if (t >= c[c.length - 1][0]) { lo = c[c.length - 1][1]; hi = c[c.length - 1][2]; }
            else if (t <= c[0][0]) {
                const d = c[0][0] - t, sl = (c[1][1] - c[0][1]) / (c[1][0] - c[0][0]), sh = (c[1][2] - c[0][2]) / (c[1][0] - c[0][0]);
                lo = Math.max(15, c[0][1] - sl * d); hi = Math.max(18, c[0][2] - sh * d);
            } else {
                let i = 0;
                while (t > c[i + 1][0]) i++;
                const f = (t - c[i][0]) / (c[i + 1][0] - c[i][0]);
                lo = c[i][1] + (c[i + 1][1] - c[i][1]) * f; hi = c[i][2] + (c[i + 1][2] - c[i][2]) * f;
            }
            return { lo: lo * k, hi: hi * k, mid: (lo + hi) / 2 * k };
        }
        const warmRange = () => settings.get('range20');

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
        ui.onClick('BTN_PAGE', () => { page = (page + 1) % pages().length; return render(); });
        ui.onClick('BTN_PREV', () => { const n = pages().length; page = (page + n - 1) % n; return render(); });
        ui.onClick('BTN_READ', () => poll(true).then(render));

        /** G20-style frame: tab bar with the page names along the top. */
        function header(cv, t, d) {
            const names = { main: isHybrid() ? 'Range' : '12 V battery', log: 'Charge log', diag: 'Diagnostics' };
            G.frame(cv, t, pages().map((p) => names[p]), page, [d.demo && { text: 'DEMO' }]);
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

        /** Cars without a hybrid system: the 12 V battery only. */
        function render12V(cv, t, d) {
            const v = d.v12;
            let state = 'no reading - see Diagnostics page', col = t.dim;
            if (G.isNum(v)) {
                if (v >= 13.2) { state = 'CHARGING  (engine / DC-DC running)'; col = GO; }
                else if (v >= 12.6) { state = 'FULL'; col = GO; }
                else if (v >= 12.4) { state = 'GOOD  (about 75 %)'; col = t.text; }
                else if (v >= 12.2) { state = 'HALF  (about 50 %) - drive or charge soon'; col = t.warn; }
                else { state = 'LOW - charge the battery'; col = t.crit; }
            }
            G.stat(cv, t, 24, 44, 1040, 468, {
                label: '12 V battery', value: v, unit: 'V', decimals: 2, size: 150, history: v12hist,
                zones: [{ from: 0, to: 12.2, color: 'crit' }, { from: 12.2, to: 12.4, color: 'warn' }],
                sub: 'last hour  ·  resting 12.4-12.8 V is healthy, 13.5-14.8 V while charging',
            });
            cv.text(state, 1040, 114, 24, col, { font: 'bold', spacing: 1, align: 'right' });
            G.panel(cv, t, 1088, 44, 488, 225, 'Outside');
            cv.text(G.isNum(d.ambient) ? G.fmt(T(d.ambient), 1) : '--', 1112, 199, 96, G.isNum(d.ambient) ? t.text : t.dim, { font: 'num' });
            cv.text(tU(), 1552, 199, 32, t.dim, { align: 'right' });
            G.panel(cv, t, 1088, 287, 488, 225, 'No hybrid system');
            ['No high-voltage battery answered, so', 'eDrive shows the 12 V battery only.', 'Hybrid car? Settings > Hybrid system > Yes'].forEach((l, i) =>
                cv.text(l, 1112, 376 + i * 34, 22, i === 2 ? t.dim : t.text));
        }

        /** Range of a full battery against outside temperature: low-high band, mid line, now marker. */
        function rangeChart(cv, t, x, y, w, h, tNow) {
            const T0 = -15, T1 = 25, top = settings.get('range20') * 1.08;
            const X = (c) => x + (c - T0) / (T1 - T0) * w, Y = (km) => y + h - km / top * h;
            for (let px = 0; px <= w; px += 2) {
                const r = rangeAt(T0 + px / w * (T1 - T0));
                cv.fillRect(x + px, Y(r.hi), 2, Math.max(1, Y(r.lo) - Y(r.hi)), withAlpha(t.accent, 0.22));
            }
            const mid = [];
            for (let px = 0; px <= w; px += 8) mid.push([x + px, Y(rangeAt(T0 + px / w * (T1 - T0)).mid)]);
            cv.polyline(mid, 2.5, t.accent);
            cv.fillRect(x, y + h, w, 1, t.tick);
            [-10, 0, 10, 20].forEach((c) => {
                cv.fillRect(X(c), y + h, 1, 6, t.tick);
                cv.text(Math.round(T(c)) + '°', X(c), y + h + 22, 16, t.dim, { align: 'center' });
                const r = rangeAt(c);
                cv.text(Math.round(D(r.lo)) + (r.hi - r.lo >= 1 ? '-' + Math.round(D(r.hi)) : ''), X(c), Y(r.hi) - 8, 16, t.dim, { align: 'center' });
            });
            if (G.isNum(tNow)) {
                const tx = X(G.clamp(tNow, T0, T1)), r = rangeAt(tNow);
                cv.fillRect(tx - 1, Y(r.mid), 2, y + h - Y(r.mid), withAlpha(t.text, 0.5));
                cv.circle(tx, Y(r.mid), 7, t.text);
                cv.circle(tx, Y(r.mid), 4, t.accent);
            }
        }

        function renderMain(cv, t, d) {
            const r = rangeAt(d.ambient), has = G.isNum(d.soc);
            const f = has ? d.soc / 100 : 0;

            // ---- range
            G.panel(cv, t, 24, 44, 720, 468, 'Real electric range');
            const rs = has ? String(Math.round(D(r.mid * f))) : '--';
            const rw = cv.text(rs, 48, 204, 130, has ? t.text : t.dim, { font: 'num' });
            cv.text(dU(), 62 + rw, 204, 40, t.dim, { font: 'bold' });
            if (d.stale && has) cv.text('charge read ' + ago(d.socAge), 720, 114, 20, t.warn, { align: 'right' });
            if (has) {
                cv.text('between ' + Math.round(D(r.lo * f)) + ' and ' + Math.round(D(r.hi * f)) + ' ' + dU(), 300, 159, 26, t.text, { font: 'bold' });
                cv.text(G.fmt(d.soc, 0) + ' % of ' + Math.round(D(r.mid)) + ' ' + dU() + ' (full battery at '
                    + (G.isNum(d.ambient) ? G.fmt(T(d.ambient), 0) + tU() : '10' + tU() + ', assumed') + ')', 300, 195, 20, t.dim);
            } else {
                cv.text('no charge reading - see Diagnostics page', 300, 195, 22, t.dim);
            }
            cv.text('FULL BATTERY RANGE BY OUTSIDE TEMPERATURE', 48, 255, 16, t.dim, { font: 'bold', spacing: 1.5 });
            rangeChart(cv, t, 64, 278, 640, 145, d.ambient);
            const amb = G.isNum(d.ambient) ? G.fmt(T(d.ambient), 1) + ' ' + tU() : 'n/a';
            cv.text('OUTSIDE  ' + amb, 48, 486, 22, t.dim, { font: 'bold', spacing: 1.5 });
            // 12 V battery: resting ~12.4-12.8 V, 13.5-14.8 V while the DC/DC or alternator charges it
            const v = d.v12, vcol = !G.isNum(v) ? t.dim : v < 11.8 ? t.crit : v < 12.2 || v > 15.2 ? t.warn : t.text;
            const vw = cv.text(G.isNum(v) ? v.toFixed(2) + ' V' : 'n/a', 720, 489, 32, vcol, { font: 'bold', align: 'right' });
            cv.text('12 V BATTERY', 708 - vw, 486, 22, t.dim, { font: 'bold', spacing: 1.5, align: 'right' });

            // ---- charge + last charge
            G.panel(cv, t, 768, 44, 380, 468, 'Charge');
            battery(cv, t, 796, 101, 300, 106, d.soc);
            const ss = G.isNum(d.soc) ? G.fmt(d.soc, 0) : '--';
            const sw = cv.text(ss, 940, 314, 96, G.isNum(d.soc) ? t.text : t.dim, { font: 'num', align: 'center' });
            cv.text('%', 948 + sw / 2, 314, 36, t.dim, { font: 'bold' });
            cv.text(d.demo ? 'demo data' : 'read ' + ago(d.socAge), 958, 348, 20, t.dim, { align: 'center' });
            cv.fillRect(792, 367, 332, 1, t.tick);
            const c = d.charge;
            cv.text(c && c.open ? 'CHARGING / JUST CHARGED' : 'LAST CHARGE', 792, 399, 20, c && c.open ? GO : t.dim, { font: 'bold', spacing: 1.5 });
            if (c) {
                const add = c.to - c.from;
                const aw = cv.text('+' + add.toFixed(0) + ' %', 792, 450, 44, GO, { font: 'bold' });
                const extra = [G.isNum(c.kwh) ? c.kwh.toFixed(1) + ' kWh' : null, '+' + Math.round(D(add / 100 * warmRange())) + ' ' + dU()].filter(Boolean).join('  ·  ');
                cv.text(extra, 806 + aw, 448, 24, t.text, { font: 'label' });
                cv.text('from ' + Math.round(c.from) + ' to ' + Math.round(c.to) + ' %  ·  ' + (c.open ? 'now' : ago(Date.now() - c.toT)), 792, 491, 22, t.dim);
            } else {
                cv.text('no charge seen yet', 792, 448, 24, t.dim);
                cv.text('shows after the next charge', 792, 491, 20, t.dim);
            }

            // ---- battery: health (capacity vs. new) + energy in it now
            const soh = d.soh, kwh = settings.get('designKwh');
            const cap = G.isNum(soh) ? kwh * soh / 100 : null;                     // what a full charge holds today
            const now = G.isNum(cap) && G.isNum(d.soc) ? cap * d.soc / 100 : null;  // energy in the pack right now
            const bx = 1172, bw = 404;
            G.panel(cv, t, bx, 44, bw, 468, 'Battery health (SOH)');
            const hc = !G.isNum(soh) ? t.dim : soh < 70 ? t.crit : soh < 80 ? t.warn : t.text;
            const hw = cv.text(G.isNum(soh) ? G.fmt(soh, 1) : '--', bx + 24, 178, 96, hc, { font: 'num' });
            cv.text('%', bx + 32 + hw, 178, 32, t.dim, { font: 'bold' });
            cv.text(G.isNum(soh) ? 'of the capacity it had new' : 'not readable - see Diagnostics', bx + 24, 214, 20, t.dim);
            G.bar(cv, t, bx + 24, 227, bw - 48, 68, {
                label: 'Holds', value: cap, unit: 'kWh', decimals: 1, max: kwh, ramp: 'hot',     // tach colours; amber / red when worn
                zones: [{ from: 0, to: kwh * 0.7, color: 'crit' }, { from: kwh * 0.7, to: kwh * 0.8, color: 'warn' }],
            });
            cv.text('of ' + kwh + ' kWh new', bx + bw - 24, 323, 18, t.dim, { align: 'right' });
            cv.fillRect(bx + 24, 342, bw - 48, 1, t.panelEdge);
            cv.text('ENERGY IN BATTERY NOW', bx + 24, 376, 18, t.dim, { font: 'bold', spacing: 1.5 });
            const ew = cv.text(G.isNum(now) ? G.fmt(now, 1) : '--', bx + 24, 444, 64, G.isNum(now) ? t.text : t.dim, { font: 'num' });
            cv.text('kWh', bx + 34 + ew, 444, 26, t.dim);
            cv.text(d.demo ? 'demo data' : G.isNum(soh) ? 'health read ' + ago(d.sohAge) : '', bx + 24, 489, 18, t.dim);
        }

        const pad = (n) => (n < 10 ? '0' : '') + n;
        const dateOf = (ms) => { const x = new Date(ms); return pad(x.getDate()) + '.' + pad(x.getMonth() + 1) + '  ' + pad(x.getHours()) + ':' + pad(x.getMinutes()); };
        const price = () => settings.get('price') || 0;
        const money = (kwh) => (G.isNum(kwh) && price() > 0 ? (kwh * LOSS * price()).toFixed(2) + ' €' : null);

        function renderLog(cv, t, d) {
            const all = d.demo ? demo.log() : (st.log || []);
            const kwhOf = (c) => (G.isNum(c.kwh) ? c.kwh : 0);

            // ---- list, newest first
            G.panel(cv, t, 24, 44, 1040, 468, 'Charges' + (all.length ? '  (' + all.length + ')' : ''));
            const cols = [48, 230, 380, 590, 760, 920];
            ['DATE', 'ADDED', 'FROM - TO', 'ENERGY', 'RANGE', price() > 0 ? 'COST (EST.)' : ''].forEach((h, i) => cv.text(h, cols[i], 121, 18, t.dim, { font: 'bold', spacing: 1.5 }));
            cv.fillRect(48, 133, 992, 1, t.panelEdge);
            if (!all.length) {
                cv.text('No charges logged yet.', 544, 284, 32, t.dim, { align: 'center', font: 'bold' });
                cv.text('Every charge of at least ' + cfg.chargeMinPct + ' % is added here, also overnight charges', 544, 327, 22, t.dim, { align: 'center' });
                cv.text('(seen at the next start). Needs charge readings - see the Diagnostics page.', 544, 357, 22, t.dim, { align: 'center' });
            }
            all.slice(-8).reverse().forEach((c, i) => {
                const y = 174 + i * 43;
                if (i % 2 === 0) cv.roundRect(40, y - 28, 1008, 38, 8, withAlpha(t.track, 0.55));
                const add = c.to - c.from;
                cv.text(dateOf(c.toT), cols[0], y, 24, t.text, { font: 'label' });
                cv.text('+' + add.toFixed(0) + ' %', cols[1], y, 26, GO, { font: 'bold' });
                cv.text(Math.round(c.from) + ' - ' + Math.round(c.to) + ' %', cols[2], y, 24, t.dim, { font: 'label' });
                cv.text(G.isNum(c.kwh) ? c.kwh.toFixed(1) + ' kWh' : '-', cols[3], y, 24, t.text, { font: 'label' });
                cv.text('+' + Math.round(D(add / 100 * warmRange())) + ' ' + dU(), cols[4], y, 24, t.text, { font: 'label' });
                const m = money(c.kwh);
                if (m) cv.text(m, cols[5], y, 24, t.text, { font: 'label' });
            });

            // ---- totals + 14-day chart
            G.panel(cv, t, 1088, 44, 488, 468, 'Totals');
            const now = new Date(), monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
            const month = all.filter((c) => c.toT >= monthStart);
            const sum = (list) => list.reduce((a, c) => a + kwhOf(c), 0);
            const block = (y, label, list) => {
                cv.text(label, 1112, y, 18, t.dim, { font: 'bold', spacing: 1.5 });
                const kw = cv.text(sum(list).toFixed(1), 1112, y + 50, 48, t.text, { font: 'num' });
                cv.text('kWh', 1120 + kw, y + 50, 22, t.dim);
                const extra = [list.length + (list.length === 1 ? ' charge' : ' charges'), '+' + Math.round(D(list.reduce((a, c) => a + (c.to - c.from), 0) / 100 * warmRange())) + ' ' + dU(), money(sum(list))].filter(Boolean).join('  ·  ');
                cv.text(extra, 1552, y + 50, 20, t.dim, { align: 'right' });
            };
            block(116, 'THIS MONTH', month);
            block(212, 'ALL TIME', all);
            // kWh per day, last 14 days
            const day = 86400000, today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
            const days = [];
            for (let i = 13; i >= 0; i--) days.push(sum(all.filter((c) => c.toT >= today0 - i * day && c.toT < today0 - (i - 1) * day)));
            const top = Math.max(4, Math.max.apply(null, days));
            const gx = 1112, gy = 476, gh = 138, bw = 440 / 14;
            cv.text('KWH PER DAY, LAST 14 DAYS', gx, 323, 18, t.dim, { font: 'bold', spacing: 1.5 });
            days.forEach((v, i) => {
                const h = v > 0 ? Math.max(6, v / top * gh) : 0;
                cv.roundRect(gx + i * bw + 3, gy - gh, bw - 6, gh, 4, withAlpha(t.track, 0.6));
                if (h) cv.rampRect(gx + i * bw + 3, gy - h, bw - 6, h, 4, t.ramp || [t.accent]);
            });
            cv.text('today', gx + 440, gy + 26, 16, t.dim, { align: 'right' });
            cv.text('14 d ago', gx, gy + 26, 16, t.dim);
        }

        function renderDiag(cv, t, d) {
            G.panel(cv, t, 24, 44, 1552, 468, 'Battery diagnostics');
            const link = diag.p ? (diag.available ? 'link up' : 'link down') : 'no link (' + (diag.error || 'not started') + ')';
            cv.text('UDS 22 ReadDataByIdentifier  ·  ' + link + '  ·  ambient ' + (G.isNum(live.ambient) ? G.fmt(live.ambient, 1) + ' °C' : 'n/a')
                + '  ·  speed ' + (G.isNum(live.speed) ? G.fmt(live.speed, 0) + ' km/h' : 'n/a'), 48, 121, 24, t.text, { font: 'label' });
            const cols = [48, 160, 260, 380, 820, 1000, 1290];
            ['VALUE', 'ECU', 'DID', 'REPLY', 'DECODED', 'STATUS', 'READ'].forEach((h, i) => cv.text(h, cols[i], 167, 20, t.dim, { font: 'bold', spacing: 1.5 }));
            cv.fillRect(48, 178, 1504, 1, t.tick);
            let y = 214;
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
                y += 38;
            }));
            cv.text('DIDs differ between models. If a value is n/a or wrong, edit config.battery in apps/edrive/app.json', 48, 444, 20, t.dim);
            cv.text('(ECU, DID, byte position, factor) and rebuild. Range at 20 °C, battery size and hybrid system are in Settings.', 48, 474, 20, t.dim);
            if (d.demo) cv.text('Demo data is shown on the main page until the diagnostic link answers.', 1552, 474, 20, t.warn, { align: 'right' });
        }

        function render() {
            const t = ctx.theme(), d = data();
            const cv = new Canvas(W, H).clear(t.bg);
            const pg = pages();
            if (page >= pg.length) page = 0;
            if (pg[page] === 'diag') renderDiag(cv, t, d);
            else if (pg[page] === 'log') renderLog(cv, t, d);
            else if (isHybrid()) renderMain(cv, t, d);
            else render12V(cv, t, d);
            header(cv, t, d);
            return ui.image('MAIN_GFX', cv);
        }

        let loop = ctx.loop('MAIN', settings.get('fps'), render);
        settings.onChange((k) => {
            if (k === 'fps') { loop.stop(); loop = ctx.loop('MAIN', settings.get('fps'), render); }
            if (k === 'poll') schedule();
            if (k === 'priceDown') {
                // tapping "price (down)" steps the price one step lower (the price row itself steps up)
                const steps = settings.item('price').steps, i = steps.indexOf(settings.get('price'));
                settings.set('price', steps[i < 0 ? steps.indexOf(0.25) : Math.max(0, i - 1)]);
            }
        });
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
