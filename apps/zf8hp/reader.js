'use strict';

const fs = require('fs');
const path = require('path');
const C = require('./catalog');
const E = require('./egs');
const { Diag, parseDtcReply } = require('./kit/diag');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the EGS identification (22 F150) the decoders were checked on; others are read only with the setting EGS variant: Try any
const VERIFIED = '0F25D0';

// Every request made by this reader is fixed to EGS and to a read service.
// No reset, diagnostic session change, DTC clear, adaptation write or actuator command.
class Reader {
    constructor(ctx) {
        this.ctx = ctx;
        this.records = {};
        this.sgbd = null;
        this.checked = false;
        this.busy = false;
        this.current = '';
        this.lastGood = 0;
        this.lastError = '';
        this.faults = null;
        this.faultsAt = 0;
        this.faultAttempt = 0;
        this.history = [];
        this.wanted = [];
        this.visible = false;
        this.running = false;
        this.attempts = {};
        this.lastSave = 0;
        this.snapshotFile = path.join(ctx.dataDir, 'egs-snapshot.json');
        try {
            const old = JSON.parse(fs.readFileSync(this.snapshotFile, 'utf8'));
            if (old.sgbd && old.records) Object.keys(old.records).forEach((k) => {
                const r = old.records[k];
                if (C.records[k] && r && Array.isArray(r.values)) this.records[k] = Object.assign({}, r, { cached: true });
            });
        } catch (e) {}
    }

    async init() {
        this.diag = new Diag(this.ctx.signals, this.ctx.log);
        this.diag.quiet = true;
        await this.diag.init();
        this.running = true;
        this.pump().catch((e) => this.ctx.log.error('EGS reader: ' + e));
    }

    setVisible(on) { this.visible = !!on; }
    setWanted(ids) { this.wanted = Array.from(new Set(ids.filter((d) => C.records[d]))); }
    refresh() { this.wanted.forEach((d) => { delete this.attempts[d]; }); this.faultAttempt = 0; }

    async read(did) {
        if (!C.records[did] || !/^[0-9A-F]{4}$/.test(did)) throw new Error('Not an allowed read identifier');
        if (did !== 'F150' && !this.supported) return;
        const id = parseInt(did, 16), time = Date.now();
        this.current = did;
        this.attempts[did] = time;
        const accept = (b) => b && ((b[0] === 0x62 && b[1] === (id >> 8) && b[2] === (id & 255))
            || (b[0] === 0x7F && b[1] === 0x22));
        const uds = await this.diag.physical(0x18, 0x22, [id >> 8, id & 255], 1800, accept,
            { maxRetries: 0, callTimeoutMs: 2500, hardTimeoutMs: 6500, pendingTimeoutMs: 2500 });
        const got = E.decode(did, uds);
        if (got.ok) {
            this.records[did] = Object.assign(got, { at: Date.now(), cached: false });
            this.lastGood = Date.now();
            this.lastError = '';
            if (did === 'F150') {
                this.checked = true;
                this.sgbd = got.raw;
                if (!this.supported) this.lastError = 'Unsupported EGS variant: ' + got.raw;
                this.ctx.log.info('EGS identification ' + got.raw + ', verified=' + this.verified + ', read=' + this.supported);
            }
            if (!this.logged) this.logged = {};
            if (!this.logged[did]) {
                this.logged[did] = true;
                this.ctx.log.info('EGS ' + did + ' ' + got.bytes + ' bytes ' + (got.decoded ? 'decoded' : 'raw') + ' ' + got.values.slice(0, 6).join(','));
            }
            if (did === '6000' && E.finite(got.values[0])) {
                const a = this.records['6005'], b = this.records['601D'];
                this.history.push({ t: Date.now(), oil: got.values[0],
                    chip1: a && a.ok && Date.now() - a.at < 15000 ? a.values[0] : null,
                    chip2: b && b.ok && Date.now() - b.at < 15000 ? b.values[0] : null });
                const cutoff = Date.now() - 20 * 60000;
                this.history = this.history.filter((x) => x.t >= cutoff).slice(-1200);
            }
        } else {
            const err = !uds ? 'No response' : uds[0] === 0x7F ? 'NRC ' + uds[2].toString(16).toUpperCase() : got.error;
            this.lastError = did + ': ' + err;
            if (this.records[did] && this.records[did].ok) this.records[did].error = err;
            else this.records[did] = { ok: false, values: [], at: 0, error: err };
        }
        this.current = '';
    }

    async readFaults() {
        this.faultAttempt = Date.now();
        const b = await this.diag.physical(0x18, 0x19, [0x02, 0x0C], 1800,
            (r) => r && ((r[0] === 0x59 && r[1] === 0x02) || (r[0] === 0x7F && r[1] === 0x19)),
            { maxRetries: 0, callTimeoutMs: 2500, hardTimeoutMs: 6500 });
        const p = parseDtcReply(b, [0x02, 0x0C]);
        if (p.ok) { this.faults = p.dtcs; this.faultsAt = Date.now(); }
    }

    save() {
        const data = { format: 1, sgbd: this.sgbd, savedAt: Date.now(), records: this.records };
        try {
            fs.writeFileSync(this.snapshotFile + '.tmp', JSON.stringify(data));
            fs.renameSync(this.snapshotFile + '.tmp', this.snapshotFile);
            this.lastSave = Date.now();
        } catch (e) { this.ctx.log.warn('EGS snapshot: ' + e); }
    }

    async pump() {
        while (this.running) {
            const active = this.visible && this.ctx.settings.get('demo') !== 'on';
            if (!active || !this.diag.available || !this.diag.p) { await sleep(250); continue; }
            if (this.checked && !this.supported) { await sleep(1000); continue; }
            let next = !this.checked ? 'F150' : null;
            const now = Date.now(), liveMs = Math.max(1, Number(this.ctx.settings.get('liveInterval')) || 2) * 1000;
            if (!next) next = this.wanted.find((d) => (!this.attempts[d] || this.ctx.settings.get('autoRefresh') !== false)
                && now - (this.attempts[d] || 0) >= (/^(6000|6005|601D|DA2A|DA2E|DA34|DA22|602E)$/.test(d) ? liveMs : 30000));
            const faultDue = this.wantFaults && (!this.faultAttempt || this.ctx.settings.get('autoRefresh') !== false)
                && now - this.faultAttempt > 30000;
            if (!next && !faultDue) { await sleep(200); continue; }
            this.busy = true;
            try {
                if (next) await this.read(next);
                else await this.readFaults();
            } catch (e) {
                this.lastError = String(e.message || e);
                if (next) this.attempts[next] = Date.now();
            } finally { this.busy = false; this.current = ''; }
            if (this.supported && Date.now() - this.lastSave > 10000) this.save();
            if (!this.checked) await sleep(1500);
            else await sleep(180);
        }
    }

    /** The identified EGS is the one the decoders were checked on. */
    get verified() { return this.sgbd === VERIFIED; }
    /** Read it: verified, or another identified variant with the setting EGS variant: Try any. Every record is still
     * checked against its identifier and exact length, so a different layout shows as an error, not as numbers. */
    get supported() { return this.verified || (!!this.sgbd && this.ctx.settings.get('variants') === 'any'); }

    status() {
        if (!this.diag || !this.diag.available) return 'NO LINK';
        if (!this.checked) return 'IDENTIFYING';
        if (!this.supported) return 'OTHER EGS';
        return Date.now() - this.lastGood > 12000 ? 'LINK STALE' : this.verified ? 'LIVE' : 'LIVE · UNVERIFIED';
    }
}

module.exports = Reader;
