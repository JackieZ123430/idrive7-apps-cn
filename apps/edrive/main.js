'use strict';
/**
 * eDrive - what the high-voltage battery really gives you.
 *
 *   - real electric range: displayed charge x your own "range at 100%" for the
 *     outside temperature (cold / mild / hot bands, set in Settings)
 *   - battery health (SOH): usable capacity compared to a new battery
 *   - design capacity left: charge x SOH, i.e. how much of a NEW battery's
 *     full energy is still in the pack right now (also in kWh)
 *
 * Charge and SOH are read from the battery management unit with UDS
 * ReadDataByIdentifier over the head unit's diagnostic link (kit/diag.js);
 * the DIDs and scalings live in app.json "config.battery" so they can be
 * adjusted per model. Outside temperature comes over SOME/IP.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { Canvas, withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { Diag, hex, NRC } = require('./kit/diag');

const W = 1600, H = 520;
const GO = '#2fd27a';
const PAGES = ['main', 'diag'];
const KM_MI = 0.621371;

/** Demo: charge drains, outside temperature swings across the cold threshold. */
class Demo {
    constructor() { this.t0 = Date.now(); }
    sample() {
        const s = (Date.now() - this.t0) / 1000;
        return { soc: 100 - (s * 0.8) % 95, soh: 91.5, ambient: 11 + 9 * Math.sin(s / 12) };
    }
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const cfg = Object.assign({ ecu: 7, soc: [], soh: [], sohEverySec: 300 }, (ctx.spec.config && ctx.spec.config.battery) || {});
        const S = (ctx.spec.config && ctx.spec.config.scaling) || {};
        const sc = (k, raw) => {
            const c = S[k];
            if (!c || raw === undefined || raw === null || raw === c.invalid) return null;
            return raw * c.factor + (c.offset || 0);
        };

        /* ---------- state (SOH changes slowly: keep the last reading across restarts) ---------- */
        const STATE = path.join(ctx.dataDir, 'battery.json');
        let saved = {};
        try { saved = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { /* first run */ }
        const live = { soc: null, socT: 0, soh: G.isNum(saved.soh) ? saved.soh : null, sohT: saved.sohT || 0, ambient: null };
        const save = () => { try { fs.writeFileSync(STATE, JSON.stringify({ soh: live.soh, sohT: live.sohT })); } catch (e) { log.warn('save: ' + e); } };
        const raws = {};            // did -> { bytes, value, ok, why, t }
        const pick = { soc: 0, soh: 0 };   // index of the candidate that answered last

        ctx.signals.watch('de.bmw.infrastructure.EnvironmentalInformation', '1', {
            ExteriorTemperature: (v) => { const a = sc('ambient', v.temperatureExterior); if (a !== null) live.ambient = a; },
        }, log).then((s) => log.info('ambient ' + (s.error ? 'error: ' + s.error : 'subscribed')));

        const diag = await new Diag(ctx.signals, log).init();
        const demo = new Demo();
        const usingDemo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !diag.available && !live.socT);

        /* ---------- UDS reads ---------- */
        /** Read one candidate { did, bytes, at, factor, offset, min, max }; returns the value or null. */
        async function readDid(c) {
            const did = parseInt(c.did, 16), r = { t: Date.now(), ok: false, value: null, bytes: '', why: '' };
            raws[c.did] = r;
            let uds;
            try { uds = await diag.physical(cfg.ecu, 0x22, [did >> 8, did & 0xFF], 4000); } catch (e) { r.why = String(e.message || e); return null; }
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

        let busy = false, pollTimer = null;
        async function poll(forceSoh) {
            if (busy) return;
            busy = true;
            try {
                if (diag.available) {
                    const soc = await readValue('soc');
                    if (soc !== null) { live.soc = soc; live.socT = Date.now(); }
                    if (forceSoh || !live.sohT || Date.now() - live.sohT > cfg.sohEverySec * 1000 || live.soh === null) {
                        const soh = await readValue('soh');
                        if (soh !== null) { live.soh = soh; live.sohT = Date.now(); save(); }
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
        poll(true).then(schedule);

        /* ---------- derived values ---------- */
        function data() {
            if (usingDemo()) return Object.assign(demo.sample(), { demo: true, socAge: 0 });
            const socFresh = live.socT && Date.now() - live.socT < Math.max(60, settings.get('poll') * 4) * 1000;
            return { soc: live.soc, soh: live.soh, ambient: live.ambient, demo: false, socAge: live.socT ? Date.now() - live.socT : null, stale: !socFresh };
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
        const ago = (ms) => (ms == null ? 'never' : ms < 60000 ? Math.round(ms / 1000) + ' s ago' : ms < 3600000 ? Math.round(ms / 60000) + ' min ago'
            : ms < 172800000 ? Math.round(ms / 3600000) + ' h ago' : Math.round(ms / 86400000) + ' days ago');

        /* ---------- drawing ---------- */
        let page = 0;
        ui.onClick('BTN_PAGE', () => { page = (page + 1) % PAGES.length; return render(); });
        ui.onClick('BTN_READ', () => poll(true).then(render));

        function header(cv, t, title, d) {
            cv.text(title, 24, 34, 24, t.dim, { font: 'bold', spacing: 3 });
            G.stripes(cv, t, 24, 44, 120);
            PAGES.forEach((p, i) => cv.circle(W - 170 + i * 22, 26, i === page ? 6 : 4, i === page ? t.accent : t.tick));
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
            const iw = w - 24, ih = h - 24;
            for (let i = 0; i < 10; i++) {
                const sx = x + 12 + i * (iw / 10), sw = iw / 10 - 6;
                const on = f * 10 > i + 0.05;
                cv.roundRect(sx, y + 12, sw, ih, 5, on ? col : t.track);
            }
            if (f > 0 && f < 1) {
                // partial segment
                const i = Math.floor(f * 10), part = f * 10 - i;
                if (part > 0.05) cv.roundRect(x + 12 + i * (iw / 10), y + 12, (iw / 10 - 6) * part, ih, 5, withAlpha(col, 0.55));
            }
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
            // temperature bands
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

            // ---- charge
            G.panel(cv, t, 768, 64, 380, 440, 'Charge');
            battery(cv, t, 800, 140, 290, 130, d.soc);
            const ss = G.isNum(d.soc) ? G.fmt(d.soc, 0) : '--';
            const sw = cv.text(ss, 958 - 20, 420, 150, G.isNum(d.soc) ? t.text : t.dim, { font: 'num', align: 'center' });
            cv.text('%', 958 - 20 + sw / 2 + 8, 420, 44, t.dim, { font: 'bold' });
            cv.text(d.demo ? 'demo data' : 'read ' + ago(d.socAge), 958, 480, 20, t.dim, { align: 'center' });

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

        function renderDiag(cv, t, d) {
            G.panel(cv, t, 24, 64, 1552, 440, 'Battery diagnostics');
            const link = diag.p ? (diag.available ? 'link up' : 'link down') : 'no link (' + (diag.error || 'not started') + ')';
            cv.text('Battery control unit 0x' + hex(cfg.ecu) + '  ·  UDS 22 ReadDataByIdentifier  ·  ' + link
                + '  ·  ambient ' + (G.isNum(live.ambient) ? G.fmt(live.ambient, 1) + ' °C' : 'n/a'), 48, 136, 24, t.text, { font: 'label' });
            const cols = [48, 170, 330, 830, 1030, 1220];
            ['VALUE', 'DID', 'REPLY', 'DECODED', 'STATUS', 'READ'].forEach((h, i) => cv.text(h, cols[i], 186, 20, t.dim, { font: 'bold', spacing: 1.5 }));
            cv.fillRect(48, 196, 1504, 1, t.tick);
            let y = 232;
            ['soc', 'soh'].forEach((key) => (cfg[key] || []).forEach((c, i) => {
                const r = raws[c.did];
                const used = pick[key] === i && r && r.ok;
                cv.text(key.toUpperCase() + (used ? ' ←' : ''), cols[0], y, 24, used ? GO : t.text, { font: 'bold' });
                cv.text(c.did, cols[1], y, 24, t.text, { font: 'label' });
                const bytes = r ? r.bytes || '-' : '-';
                cv.text(bytes.length > 40 ? bytes.slice(0, 39) + '…' : bytes, cols[2], y, 22, t.dim, { font: 'label' });
                cv.text(r && G.isNum(r.value) ? G.fmt(r.value, 1) : '-', cols[3], y, 24, t.text, { font: 'label' });
                cv.text(r ? (r.ok ? 'OK' : r.why) : 'not read', cols[4], y, 22, r && r.ok ? GO : r ? t.warn : t.dim, { font: 'label' });
                cv.text(r ? ago(Date.now() - r.t) : '-', cols[5], y, 22, t.dim, { font: 'label' });
                y += 40;
            }));
            cv.text('DIDs differ between models. If a value is n/a or wrong, edit config.battery in apps/edrive/app.json', 48, 440, 20, t.dim);
            cv.text('(DID, byte position, factor) and rebuild. Range bands and design capacity are in Settings.', 48, 468, 20, t.dim);
            if (d.demo) cv.text('Demo data is shown on the main page until the diagnostic link answers.', 1552, 468, 20, t.warn, { align: 'right' });
        }

        function render() {
            const t = ctx.theme(), d = data();
            const cv = new Canvas(W, H).clear(t.bg);
            header(cv, t, PAGES[page] === 'diag' ? 'EDRIVE · DIAGNOSTICS' : 'EDRIVE', d);
            if (PAGES[page] === 'diag') renderDiag(cv, t, d); else renderMain(cv, t, d);
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
