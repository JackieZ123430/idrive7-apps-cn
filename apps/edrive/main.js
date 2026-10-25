'use strict';
/**
 * eDrive - what the high-voltage battery really gives you.
 *
 *   - real electric range: the charge above the one the engine starts at, divided by what
 *     this car uses: per km for driving (learned from electric-only driving, last ~60 km)
 *     plus per hour for climate control and the on-board electrics (heating when cold,
 *     A/C when hot: it costs range by the hour, so more of it in slow traffic). The hourly
 *     draw is learned per outside-temperature band, mostly from standing / creeping with
 *     the engine off; until then a typical draw for the temperature (AUX_KW) is used.
 *     Climate control on or off comes from the car (ClimateMaster.statusClimateSystemOn):
 *     off, only the on-board electrics are taken off the range (learned separately), so
 *     the range goes up when you switch the climate off and down when you switch it on.
 *     Before any electric driving is learned: the range a full battery gives at the outside
 *     temperature (RANGE_CURVE, scaled to your "range when full, 20 °C").
 *     The engine-start charge is learned from engine starts while driving at <= 20 %.
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
 * "config.battery" so they can be adjusted per model. Outside temperature,
 * speed and climate control on / off come over SOME/IP.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { Diag, hex } = require('./kit/diag');
const { DidReader } = require('./kit/dids');
const { RangeModel } = require('./range');

const W = 1600, H = 520;
const GO = '#2fd27a';
const PAGES_HYBRID = ['main', 'log', 'diag'], PAGES_12V = ['main', 'diag'];
const LOG_MAX = 200;             // charges kept in the log
const LOSS = 1.1;                // grid energy per kWh stored (charger + battery losses, estimate)
const KM_MI = 0.621371;
const VALUES = ['soc', 'soh', 'v12'];
const V12_HIST = 120;            // 12 V samples kept (one per 30 s = 1 h)
const RESERVE = 8;               // engine-start charge (%) until two engine starts have been seen

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
            climate: s % 30 < 20, ac: s % 30 < 10,
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
        // learned before 1.8 the use per km also held the climate draw: keep it, but light, so it relearns soon
        if (st.learn && st.rangeV !== 2) { const f = Math.min(1, 10 / st.learn.km); st.learn.km *= f; st.learn.pct *= f; }
        st.rangeV = 2;
        const model = new RangeModel(st);
        let savedAt = 0;
        const save = () => {
            savedAt = Date.now();
            try { fs.writeFileSync(STATE, JSON.stringify(st)); } catch (e) { log.warn('save: ' + e); }
        };
        const live = { soc: null, socT: 0, soh: G.isNum(st.soh) ? st.soh : null, sohT: st.sohT || 0, v12: null, v12T: 0, ambient: null, speed: null, rpm: null, rpmT: 0,
            climate: null, ac: null };

        /* ---------- electric driving: what the car really does per % ----------
         * seg = distance since the last charge reading, and whether the engine ran meanwhile.
         * At the next reading, a stretch driven with the engine off adds its km and % used to
         * st.learn (km per %); an engine start while driving at a low charge is where this car
         * stops driving electric (st.engineStarts). */
        const seg = { km: 0, engine: false, climate: null, climateMixed: false };
        let lastSpeedT = 0;
        const onSpeed = (kmh) => {
            const now = Date.now();
            if (lastSpeedT && G.isNum(kmh)) seg.km += kmh * G.clamp(now - lastSpeedT, 0, 2000) / 3600000;
            lastSpeedT = now;
        };
        const onRpm = (rpm) => {
            const was = live.rpm;
            live.rpm = rpm; live.rpmT = Date.now();
            if (rpm > 400) seg.engine = true;
            if (G.isNum(was) && was < 300 && rpm > 600 && G.isNum(live.speed) && live.speed > 3
                && G.isNum(live.soc) && Date.now() - live.socT < 60000 && live.soc <= 20) {
                st.engineStarts = (st.engineStarts || []).concat([Math.round(live.soc * 10) / 10]).slice(-5);
                log.info('engine started while driving at ' + live.soc.toFixed(1) + ' %');
                save();
            }
        };
        /** Charge at which the engine starts: the setting, or the median of the engine starts seen. */
        function reserve() {
            const s = settings.get('reserve');
            if (s != null && s !== 'auto' && isFinite(+s)) return +s;
            const e = (st.engineStarts || []).slice().sort((a, b) => a - b);
            return e.length >= 2 ? e[Math.floor(e.length / 2)] : RESERVE;
        }
        /* ---------- climate control on / off (per zone: on when any zone is on) ----------
         * Off, only the on-board electrics draw (model.auxRate). A reading stretch during which it was
         * switched on or off teaches nothing ('mixed'), so neither draw learns the other's. */
        const zones = { climate: {}, ac: {} };
        const rawClimate = {};                           // last values as received (Diagnostics page)
        const onZone = (what, on, zone) => {
            if (typeof on !== 'boolean') return;
            const z = zones[what];
            if (zone === 'ALL_ZONES') zone = 0;                          // enums may come as names
            if (!zone) Object.keys(z).forEach((k) => delete z[k]);      // ALL_ZONES (0) sets every zone
            z[zone || 0] = on;
        };
        /** every entry holding `key`, however the list arrives (plain, wrapped in the field's name, single) */
        const entries = (v, key, out) => {
            out = out || [];
            if (v && typeof v === 'object') {
                if (key in v) out.push(v);
                else Object.keys(v).forEach((k) => entries(v[k], key, out));
            }
            return out;
        };
        const one = (v, key) => { const e = entries(v, key)[0]; return e ? e[key] : undefined; };
        /* Climate counts as on (costing range) when the system is on and the A/C is on, or it is cold
         * enough that it heats. Automatic climate keeps the system itself on almost always, so that
         * alone would never change - the A/C button is what the driver switches. */
        const climateNow = () => {
            const sys = Object.keys(zones.climate).length ? Object.keys(zones.climate).some((k) => zones.climate[k]) : null;
            const ac = Object.keys(zones.ac).length ? Object.keys(zones.ac).some((k) => zones.ac[k]) : null;
            live.ac = ac;
            if (sys === false) return false;
            if (ac === null) return sys;
            return ac || (G.isNum(live.ambient) && live.ambient < 10);
        };
        const seen = (what, v) => {
            const raw = JSON.stringify(v);
            if (raw !== rawClimate[what]) { rawClimate[what] = raw; log.info('climate ' + what + ': ' + raw); }
        };
        const climateChanged = () => {
            const now = climateNow();
            if (now === null) return;
            if (live.climate !== null && now !== live.climate) { seg.climateMixed = true; log.info('climate control ' + (now ? 'on' : 'off')); }
            live.climate = now;
        };
        // ClimateMaster: lists, one entry per zone (not offered on every car)
        const onClimate = (what, key, v) => {
            seen(what, v);
            entries(v, key).forEach((e) => onZone(what, e[key], e.operationZone));
            climateChanged();
        };
        // Climate2 - from the vehicle gateway, what the HMI itself reads: A/C on / off, blower, compressor
        const ON = { 1: true, KLIMAANLAGE_EIN: true, 0: false, KLIMAANLAGE_AUS: false };
        const onAircon = (v) => {
            seen('A/C', v);
            const on = ON[one(v, 'statusAircon')];
            if (typeof on === 'boolean') { zones.ac = { 0: on }; climateChanged(); }
        };
        const onBlower = (v) => {
            seen('blower', v);
            const b = one(v, 'statusBlowerSettingDR');
            if (typeof b === 'number' && b < 255) { zones.climate = { 0: b > 0 }; climateChanged(); }
        };
        const onCompressor = (v) => { seen('compressor', v); live.acPower = one(v, 'actualValuePowerACCompressor'); };
        /** Climate during the stretch since the last charge reading: true / false / null / 'mixed'. */
        const stretchClimate = () => (seg.climateMixed ? 'mixed' : seg.climate);

        /** kWh in 1 % of charge today (size when new x health). */
        const kwhPerPct = () => settings.get('designKwh') * (G.isNum(live.soh) ? live.soh : 100) / 100 / 100;

        ctx.signals.watch('de.bmw.infrastructure.EnvironmentalInformation', '1', {
            ExteriorTemperature: (v) => { const a = sc('ambient', v.temperatureExterior); if (a !== null) live.ambient = a; },
        }, log).then((s) => log.info('ambient ' + (s.error ? 'error: ' + s.error : 'subscribed')));
        ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusCarSpeed2: (v) => { const k = v.speedVehicleCentreOfGravity; live.speed = k === 65535 || k == null ? null : k * 0.015625; onSpeed(live.speed); },
        }, log).then((s) => log.info('speed ' + (s.error ? 'error: ' + s.error : 'subscribed')));
        ctx.signals.watch('de.bmw.infotainment.vehicle.CDS', '1', {
            statusEngineSpeed2: (v) => { const r = sc('rpm', v.actualValueRPMEngineCrankshaft); if (r !== null && r >= 0 && r < 12000) onRpm(r); },
        }, log).then((s) => log.info('rpm ' + (s.error ? 'error: ' + s.error : 'subscribed')));
        ctx.signals.watch('de.bmw.infotainment.climate.climatemaster.ClimateMaster', '1', {
            // both are lists, one entry per zone
            statusClimateSystemOn: (v) => onClimate('climate', 'airConditioningOn', v),
            statusAirCondAC: (v) => onClimate('ac', 'acButton', v),
        }, log, { pollMs: 10000 }).then((s) => log.info('climate ' + (s.error ? 'error: ' + s.error : 'subscribed')));
        ctx.signals.watch('de.bmw.infotainment.climate.Climate2', '1', {
            statusACFront: onAircon,
            statusAirConditionDRStatus: onBlower,
            statusActualValuePowerACCompressor: onCompressor,
        }, log, { pollMs: 10000 }).then((s) => log.info('climate2 ' + (s.error ? 'error: ' + s.error : 'subscribed')));

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
            // since the last reading with the engine off throughout (and the car awake: rpm signal live):
            // standing / creeping teaches the climate + on-board draw per hour, driving the use per km
            const h = (now - (st.lastSocT || 0)) / 3600000;
            if (G.isNum(prev) && h < 120000 / 3600000 && !seg.engine && now - live.rpmT < 5000 && !st.session) {
                model.learn(prev - soc, h, seg.km, live.ambient, kwhPerPct(), stretchClimate());
            }
            seg.km = 0; seg.engine = G.isNum(live.rpm) && live.rpm > 400;
            seg.climate = live.climate; seg.climateMixed = false;
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
         * Any reply from the battery unit (even a refusal) = there is a hybrid system, for good
         * (st.hybrid is remembered, so a real hybrid is never switched off later).
         * No reply 3 times in a row while another unit answers (the 12 V read) = no hybrid system.
         * Cars where the 12 V can't be read either (seen on a G06 N63): 6 times in a row with the
         * diagnostic link up is enough. Remembered, so the next start shows the 12 V page straight away. */
        let smeMiss = 0, lastSocTry = 0;
        function detectHybrid(otherUnitAnswered) {
            const rs = (cfg.soc || []).map((c) => raws[reader.key(c)]);
            if (rs.some((r) => r && r.bytes)) {
                smeMiss = 0;
                if (st.noHybrid || !st.hybrid) { st.noHybrid = false; st.hybrid = true; save(); log.info('hybrid battery unit answers'); }
            } else if (rs.some((r) => r && r.why === 'no reply') && !st.hybrid) {
                if (++smeMiss >= (otherUnitAnswered ? 3 : 6) && !st.noHybrid) {
                    st.noHybrid = true; save(); log.info('no hybrid battery unit: 12 V only');
                }
            }
        }
        const isHybrid = () => (settings.get('hybrid') === 'yes' ? true : settings.get('hybrid') === 'no' ? false : !st.noHybrid);
        // the Diagnostics page (UDS replies per value) only when switched on in Settings: it is for tuning DIDs
        const pages = () => (isHybrid() ? PAGES_HYBRID : PAGES_12V).filter((p) => p !== 'diag' || settings.get('diagPage'));
        const diagHint = (s) => (settings.get('diagPage') ? s + ' - see Diagnostics page' : s);

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
                        // on "Read now", and after a failed read at most once an hour
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
                climate: live.climate, ac: live.ac,
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
        /**
         * Electric range at charge soc: { mid, lo, hi, kpp (km per %), learned, res (engine-start %), full,
         * auxKw (climate + on-board draw), auxLearned, auxKm (range it costs), climate }. Only the charge
         * above the engine-start point counts. Learned: % per km driving + (% per hour climate / typical
         * speed). climate: true / false / null (not known: as on); off, only the on-board draw counts.
         */
        function estimate(soc, tC, climate) {
            const res = reserve(), span = Math.max(1, 100 - res), use = G.isNum(soc) ? Math.max(0, soc - res) : null;
            const k = kwhPerPct(), m = model.range(use, tC, k, climate), aux = m ? m.aux : model.auxRate(tC, k, climate);
            const base = { res, auxKw: aux.rate * k, auxLearned: aux.learned, climate };
            if (m) {
                return Object.assign(base, {
                    mid: m.mid, lo: use === null ? null : m.mid * 0.9, hi: use === null ? null : m.mid * 1.1,
                    kpp: m.kpp, learned: true, full: m.kpp * span, auxKm: use === null ? null : m.noAux - m.mid,
                });
            }
            // before driving is learned: the temperature curve (it already holds typical climate use);
            // climate off gives back what typical climate use costs per km, above the on-board draw
            const r = rangeAt(tC);
            let f = 1;
            if (climate === false) {
                const onPerKm = span / r.mid, climPerKm = (model.auxRate(tC, k).rate - aux.rate) / model.evSpeed();
                f = onPerKm / Math.max(onPerKm * 0.5, onPerKm - Math.max(0, climPerKm));
            }
            const kpp = r.mid / span * f, mid = use === null ? null : use * kpp;
            return Object.assign(base, {
                mid, lo: use === null ? null : use * r.lo / span * f, hi: use === null ? null : use * r.hi / span * f,
                kpp, learned: false, full: kpp * span, auxKm: null,
            });
        }
        /** km a charge of +pct % adds (charge log). */
        const kmOf = (pct) => pct * estimate(null, live.ambient, live.climate).kpp;

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
            let state = diagHint('no reading yet'), col = t.dim;
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
                sub: 'last hour  ·  healthy at rest: 12.4-12.8 V',
            });
            cv.text(state, 1040, 114, 24, col, { font: 'bold', spacing: 1, align: 'right' });
            G.panel(cv, t, 1088, 44, 488, 225, 'Outside');
            cv.text(G.isNum(d.ambient) ? G.fmt(T(d.ambient), 1) : '--', 1112, 199, 96, G.isNum(d.ambient) ? t.text : t.dim, { font: 'num' });
            cv.text(tU(), 1552, 199, 32, t.dim, { align: 'right' });
            G.panel(cv, t, 1088, 287, 488, 225, 'No hybrid system');
            ['No high-voltage battery answered, so', 'eDrive shows the 12 V battery only.', 'Hybrid car? Settings > Hybrid system > Yes'].forEach((l, i) =>
                cv.text(l, 1112, 376 + i * 34, 22, i === 2 ? t.dim : t.text));
        }

        function renderMain(cv, t, d) {
            const e = estimate(d.soc, d.ambient, d.climate), has = G.isNum(d.soc);

            // ---- range: what is left until the engine starts
            G.panel(cv, t, 24, 44, 720, 468, 'Real electric range');
            const rw = cv.text(has ? String(Math.round(D(e.mid))) : '--', 48, 206, 130, has ? t.text : t.dim, { font: 'num' });
            cv.text(dU(), 62 + rw, 206, 40, t.dim, { font: 'bold' });
            if (has) cv.text(Math.round(D(e.lo)) + ' - ' + Math.round(D(e.hi)) + ' ' + dU(), 720, 150, 30, t.text, { font: 'bold', align: 'right' });
            cv.text('engine starts at ' + G.fmt(e.res, 0) + ' %', 720, 196, 26, t.dim, { align: 'right' });
            if (!has) cv.text(diagHint('no charge reading yet'), 48, 250, 24, t.dim);
            else if (d.stale) cv.text('charge read ' + ago(d.socAge), 48, 250, 24, t.warn);
            G.bar(cv, t, 48, 268, 672, 92, {
                label: 'Full: ' + Math.round(D(e.full)) + ' ' + dU(), value: has ? D(e.mid) : null, unit: dU(), max: D(e.full), niceMax: true, ramp: 'hot',
            });
            cv.text(e.learned ? 'from your last ' + Math.round(D(st.learn.km)) + ' ' + dU() + ' of electric driving'
                : 'estimate - learns as you drive electric', 48, 404, 24, t.dim);
            // climate control + on-board electrics: costs range by the hour (off: the on-board draw only)
            const ac = e.climate !== false && e.auxKw >= 1.5 ? t.warn : t.dim;
            const what = e.climate === false ? 'CLIMATE OFF  ·  ON-BOARD  ' : e.climate ? 'CLIMATE ON' + (d.ac ? ' (A/C)' : '') + '  ' : 'CLIMATE & ON-BOARD  ';
            cv.text(what + G.fmt(e.auxKw, 1) + ' kW' + (e.auxLearned ? '' : ' (typical)')
                + (G.isNum(e.auxKm) && has ? '  ·  -' + Math.round(D(e.auxKm)) + ' ' + dU() : ''), 48, 444, 22, ac, { font: 'bold', spacing: 1 });
            const amb = G.isNum(d.ambient) ? G.fmt(T(d.ambient), 1) + ' ' + tU() : '--';
            cv.text('OUTSIDE  ' + amb, 48, 486, 24, t.dim, { font: 'bold', spacing: 1 });
            // 12 V battery: resting ~12.4-12.8 V, 13.5-14.8 V while the DC/DC or alternator charges it
            const v = d.v12, vcol = !G.isNum(v) ? t.dim : v < 11.8 ? t.crit : v < 12.2 || v > 15.2 ? t.warn : t.text;
            const vw = cv.text(G.isNum(v) ? v.toFixed(2) + ' V' : '--', 720, 489, 32, vcol, { font: 'bold', align: 'right' });
            cv.text('12 V', 708 - vw, 486, 24, t.dim, { font: 'bold', spacing: 1, align: 'right' });

            // ---- charge + last charge
            G.panel(cv, t, 768, 44, 380, 468, 'Charge');
            battery(cv, t, 796, 101, 300, 106, d.soc);
            const ss = G.isNum(d.soc) ? G.fmt(d.soc, 0) : '--';
            const sw = cv.text(ss, 940, 320, 100, G.isNum(d.soc) ? t.text : t.dim, { font: 'num', align: 'center' });
            cv.text('%', 950 + sw / 2, 320, 36, t.dim, { font: 'bold' });
            cv.fillRect(792, 357, 332, 1, t.tick);
            const c = d.charge;
            cv.text(c && c.open ? 'CHARGING' : 'LAST CHARGE', 792, 393, 22, c && c.open ? GO : t.dim, { font: 'bold', spacing: 1.5 });
            if (c) {
                const add = c.to - c.from;
                const aw = cv.text('+' + add.toFixed(0) + ' %', 792, 446, 44, GO, { font: 'bold' });
                cv.text('+' + Math.round(D(kmOf(add))) + ' ' + dU(), 806 + aw, 444, 28, t.text, { font: 'bold' });
                cv.text(Math.round(c.from) + ' > ' + Math.round(c.to) + ' %  ·  ' + (c.open ? 'now' : ago(Date.now() - c.toT)), 792, 489, 24, t.dim);
            } else {
                cv.text('none yet', 792, 446, 28, t.dim);
            }

            // ---- battery: health (capacity vs. new) + energy in it now
            const soh = d.soh, kwh = settings.get('designKwh');
            const cap = G.isNum(soh) ? kwh * soh / 100 : null;                     // what a full charge holds today
            const now = G.isNum(cap) && G.isNum(d.soc) ? cap * d.soc / 100 : null;  // energy in the pack right now
            const bx = 1172, bw = 404;
            G.panel(cv, t, bx, 44, bw, 468, 'Battery health');
            const hc = !G.isNum(soh) ? t.dim : soh < 70 ? t.crit : soh < 80 ? t.warn : t.text;
            const hw = cv.text(G.isNum(soh) ? G.fmt(soh, 1) : '--', bx + 24, 180, 100, hc, { font: 'num' });
            cv.text('%', bx + 32 + hw, 180, 34, t.dim, { font: 'bold' });
            if (!G.isNum(soh)) cv.text(diagHint('not read yet'), bx + 24, 214, 22, t.dim);
            G.bar(cv, t, bx + 24, 222, bw - 48, 92, {
                label: 'Holds', value: cap, unit: 'kWh', decimals: 1, max: kwh, step: kwh / 4, scaleDecimals: kwh % 4 ? 1 : 0, ramp: 'hot',
                zones: [{ from: 0, to: kwh * 0.7, color: 'crit' }, { from: kwh * 0.7, to: kwh * 0.8, color: 'warn' }],
            });
            cv.fillRect(bx + 24, 348, bw - 48, 1, t.panelEdge);
            cv.text('IN THE BATTERY NOW', bx + 24, 386, 22, t.dim, { font: 'bold', spacing: 1.5 });
            const ew = cv.text(G.isNum(now) ? G.fmt(now, 1) : '--', bx + 24, 462, 72, G.isNum(now) ? t.text : t.dim, { font: 'num' });
            cv.text('kWh', bx + 34 + ew, 462, 28, t.dim);
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
            ['DATE', 'ADDED', 'FROM - TO', 'ENERGY', 'RANGE', price() > 0 ? 'COST' : ''].forEach((h, i) => cv.text(h, cols[i], 121, 22, t.dim, { font: 'bold', spacing: 1 }));
            cv.fillRect(48, 133, 992, 1, t.panelEdge);
            if (!all.length) {
                cv.text('No charges logged yet.', 544, 284, 32, t.dim, { align: 'center', font: 'bold' });
                cv.text('Every charge of ' + cfg.chargeMinPct + ' % or more shows up here,', 544, 330, 26, t.dim, { align: 'center' });
                cv.text('also overnight charges.', 544, 366, 26, t.dim, { align: 'center' });
            }
            all.slice(-8).reverse().forEach((c, i) => {
                const y = 174 + i * 43;
                if (i % 2 === 0) cv.roundRect(40, y - 28, 1008, 38, 8, withAlpha(t.track, 0.55));
                const add = c.to - c.from;
                cv.text(dateOf(c.toT), cols[0], y, 24, t.text, { font: 'label' });
                cv.text('+' + add.toFixed(0) + ' %', cols[1], y, 26, GO, { font: 'bold' });
                cv.text(Math.round(c.from) + ' - ' + Math.round(c.to) + ' %', cols[2], y, 24, t.dim, { font: 'label' });
                cv.text(G.isNum(c.kwh) ? c.kwh.toFixed(1) + ' kWh' : '-', cols[3], y, 24, t.text, { font: 'label' });
                cv.text('+' + Math.round(D(kmOf(add))) + ' ' + dU(), cols[4], y, 24, t.text, { font: 'label' });
                const m = money(c.kwh);
                if (m) cv.text(m, cols[5], y, 24, t.text, { font: 'label' });
            });

            // ---- totals + 14-day chart
            G.panel(cv, t, 1088, 44, 488, 468, 'Totals');
            const now = new Date(), monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
            const month = all.filter((c) => c.toT >= monthStart);
            const sum = (list) => list.reduce((a, c) => a + kwhOf(c), 0);
            const block = (y, label, list) => {
                cv.text(label, 1112, y, 22, t.dim, { font: 'bold', spacing: 1 });
                const kw = cv.text(sum(list).toFixed(1), 1112, y + 52, 48, t.text, { font: 'num' });
                cv.text('kWh', 1120 + kw, y + 52, 24, t.dim);
                const m = money(sum(list));
                if (m) cv.text(m, 1552, y + 52, 30, t.text, { align: 'right', font: 'bold' });
                cv.text(list.length + (list.length === 1 ? ' charge' : ' charges') + '  ·  +' + Math.round(D(kmOf(list.reduce((a, c) => a + (c.to - c.from), 0)))) + ' ' + dU(), 1552, y, 22, t.dim, { align: 'right' });
            };
            block(116, 'THIS MONTH', month);
            block(208, 'ALL TIME', all);
            // kWh per day, last 14 days
            const day = 86400000, today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
            const days = [];
            for (let i = 13; i >= 0; i--) days.push(sum(all.filter((c) => c.toT >= today0 - i * day && c.toT < today0 - (i - 1) * day)));
            const top = Math.max(4, Math.max.apply(null, days));
            const gx = 1112, gy = 470, gh = 132, bw = 440 / 14;
            cv.text('KWH PER DAY, 14 DAYS', gx, 318, 22, t.dim, { font: 'bold', spacing: 1 });
            days.forEach((v, i) => {
                const h = v > 0 ? Math.max(6, v / top * gh) : 0;
                cv.roundRect(gx + i * bw + 3, gy - gh, bw - 6, gh, 4, withAlpha(t.track, 0.6));
                if (h) cv.rampRect(gx + i * bw + 3, gy - h, bw - 6, h, 4, t.ramp || [t.accent]);
            });
            cv.text('today', gx + 440, gy + 28, 22, t.dim, { align: 'right' });
        }

        function renderDiag(cv, t, d) {
            G.panel(cv, t, 24, 44, 1552, 468, 'Battery diagnostics');
            const link = diag.p ? (diag.available ? 'link up' : 'link down') : 'no link (' + (diag.error || 'not started') + ')';
            cv.text('UDS 22 ReadDataByIdentifier / OBD 01  ·  ' + link + '  ·  ambient ' + (G.isNum(live.ambient) ? G.fmt(live.ambient, 1) + ' °C' : 'n/a')
                + '  ·  speed ' + (G.isNum(live.speed) ? G.fmt(G.hold('speed', live.speed), 0) + ' km/h' : 'n/a')
                + '  ·  climate ' + (live.climate === null ? 'n/a' : live.climate ? 'on' : 'off') + (live.ac ? ' (A/C)' : ''), 48, 121, 24, t.text, { font: 'label' });
            const cols = [48, 160, 260, 380, 820, 1000, 1290];
            ['VALUE', 'ECU', 'DID', 'REPLY', 'DECODED', 'STATUS', 'READ'].forEach((h, i) => cv.text(h, cols[i], 167, 22, t.dim, { font: 'bold', spacing: 1 }));
            const cr = ['A/C', 'blower', 'compressor', 'climate', 'ac'].map((k) => k + ' ' + (rawClimate[k] || '-')).join('   ');
            cv.text(cr.length > 130 ? cr.slice(0, 129) + "…" : cr, 48, 146, 18, t.dim, { font: 'label' });
            cv.fillRect(48, 178, 1504, 1, t.tick);
            let y = 214;
            VALUES.forEach((key) => (cfg[key] || []).forEach((c, i) => {
                const ecu = c.ecu == null ? cfg.ecu : c.ecu, r = raws[reader.key(c)];
                const used = pick[key] === i && r && r.ok;
                cv.text(key.toUpperCase() + (used ? ' *' : ''), cols[0], y, 24, used ? GO : t.text, { font: 'bold' });
                cv.text('0x' + hex(ecu), cols[1], y, 24, t.text, { font: 'label' });
                cv.text(DidReader.label(c), cols[2], y, 24, t.text, { font: 'label' });
                const bytes = r ? r.bytes || '-' : '-';
                cv.text(bytes.length > 36 ? bytes.slice(0, 35) + '…' : bytes, cols[3], y, 22, t.dim, { font: 'label' });
                cv.text(r && G.isNum(r.value) ? G.fmt(r.value, key === 'v12' ? 2 : 1) : '-', cols[4], y, 24, t.text, { font: 'label' });
                cv.text(r ? (r.ok ? 'OK' : r.why) : 'not read', cols[5], y, 22, r && r.ok ? GO : r ? t.warn : t.dim, { font: 'label' });
                cv.text(r ? ago(Date.now() - r.t) : '-', cols[6], y, 22, t.dim, { font: 'label' });
                y += 38;
            }));
            cv.text('A value n/a or wrong? Adjust config.battery in apps/edrive/app.json and rebuild.', 48, 474, 22, t.dim);
            if (d.demo) cv.text('Main page: demo data until the link answers', 1552, 474, 22, t.warn, { align: 'right' });
        }

        function render() {
            const t = ctx.theme(), d = data();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const pg = pages();
            if (page >= pg.length) page = 0;
            if (pg[page] === 'diag') renderDiag(cv, t, d);
            else if (pg[page] === 'log') renderLog(cv, t, d);
            else if (isHybrid()) renderMain(cv, t, d);
            else render12V(cv, t, d);
            header(cv, t, d);
            return ui.image('MAIN_GFX', cv);
        }

        // every screen refresh (60 fps) with the GPU renderer; 2 fps in software (PNG frames)
        ctx.loop('MAIN', 2, render);
        settings.onChange((k) => {
            if (k === 'poll') schedule();
        });
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
