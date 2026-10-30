'use strict';
/**
 * UDS over TASU - the head unit's own diagnostic transport, used the same way
 * BMW's ts_diagnostic_service does (its tasuHandler / DTC read controllers):
 *
 *   request : sendTasuRequest{ sourceAddress 0xF2, targetAddress (0xDF = all ECUs),
 *             serviceID, subroutineID 0, udsData = the bytes after the service id }
 *   reply   : event sendTasuResponse{ udsResponse, errorCode }. The frame has a
 *             9-byte header: [2] 0x7F = rejected by the transport (code in [4]),
 *             [6] = address of the ECU that answered, UDS reply from [9] on.
 *
 * A functional (0xDF) request gets one reply per ECU; BMW collects them until
 * nothing arrives for a while. 0x7F xx 0x78 = "response pending" (wait longer).
 */
const EventEmitter = require('events');

const IFACE = 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu';
const INSTANCE = 'SystemFunctionsInternalTasuInst1';
const TESTER = 0xF2;
const ALL = 0xDF;

function toBytes(b) {
    if (!b) return [];
    if (Buffer.isBuffer(b) || b instanceof Uint8Array) return Array.prototype.slice.call(b);
    if (Array.isArray(b)) return b.slice();
    if (b.data) return toBytes(b.data);
    if (typeof b === 'object' && typeof b.length === 'number') return Array.prototype.slice.call(b);
    return [];
}
const hex = (n, w) => n.toString(16).toUpperCase().padStart(w || 2, '0');

const NRC = {
    0x10: 'general reject', 0x11: 'service not supported', 0x12: 'sub-function not supported', 0x13: 'bad length',
    0x21: 'busy', 0x22: 'conditions not correct', 0x31: 'out of range', 0x33: 'security access denied',
    0x72: 'programming failure', 0x78: 'pending', 0x7E: 'not supported in session', 0x7F: 'not supported in session',
};

class Diag extends EventEmitter {
    constructor(signals, log) {
        super();
        this.signals = signals; this.log = log;
        this.p = null; this.available = false; this.error = null;
        this.quiet = false;           // true: don't log every request (apps that poll)
    }

    async init() {
        try {
            this.p = await this.signals.proxy(IFACE, INSTANCE);
            await this.signals.on(this.p, 'sendTasuResponse', (v) => this._onResponse(v), this.log);
            await this.signals.onAvailable(this.p, (a) => { this.available = a; this.emit('available', a); });
            this.log.info('TASU proxy ready (available=' + this.available + ')');
        } catch (e) {
            this.error = String(e);
            this.log.warn('TASU: ' + e);
        }
        return this;
    }

    _onResponse(v) {
        const err = v && v.errorCode;
        if (err !== undefined && err !== 'NO_ERROR' && err !== 0) { this.emit('tasError', String(err)); return; }
        const b = toBytes(v && (v.udsResponse !== undefined ? v.udsResponse : v));
        if (b.length >= 5 && b[2] === 0x7F) { this.emit('tasReject', b[4]); return; }
        if (b.length < 10) { this.log.warn('short TASU frame ' + b.map((x) => hex(x)).join('')); return; }
        this.emit('frame', { ecu: b[6], uds: b.slice(9) });
    }

    /**
     * Send one request; resolves with the transport's verdict ('NO_ERROR', 'REQUEST_PENDING', ...).
     * The transport turns requests away while it is still busy with an earlier one (e.g. a second
     * functional request a few seconds after the first: APP_REQUEST_TEMPORARILY_NOT_ACCEPTED), so
     * such a verdict is retried a few times with a growing pause (1, 2, 3, 4 s).
     */
    async send(target, sid, data, opts) {
        if (!this.p) throw new Error(this.error || 'no diagnostic link');
        const d = data || [];
        const maxRetries = opts && opts.maxRetries != null ? opts.maxRetries : 4;
        const callTimeoutMs = opts && opts.callTimeoutMs || 8000;
        const retryBaseMs = opts && opts.retryBaseMs || 1000;
        if (!this.quiet) this.log.info('UDS -> ' + hex(target) + ': ' + hex(sid) + ' ' + d.map((x) => hex(x)).join(' '));
        for (let attempt = 0; ; attempt++) {
            const r = await this.signals.call(this.p, 'sendTasuRequest', {
                sourceAddress: TESTER, targetAddress: target, serviceID: sid, subroutineID: 0,
                udsDataLength: d.length, udsData: Buffer.from(d), deadlockTime: 0,
            }, callTimeoutMs);
            const v = r && typeof r === 'object' ? (r.TasuErrorEnum || Object.keys(r).map((k) => r[k]).find((x) => typeof x === 'string')) : r;
            const verdict = v === undefined ? 'NO_ERROR' : String(v);
            if (!/TEMPORARILY_NOT_ACCEPTED|BUSY/i.test(verdict) || attempt >= maxRetries) return verdict;
            this.log.info('transport busy (' + verdict + '), retrying');
            await new Promise((res) => setTimeout(res, retryBaseMs * (attempt + 1)));
        }
    }

    _check(verdict) {
        if (verdict !== 'NO_ERROR' && verdict !== 'REQUEST_PENDING' && verdict !== '0' && verdict !== '1') throw new Error('transport refused: ' + verdict);
    }

    /**
     * Functional request to all ECUs. Resolves with Map(ecu -> final UDS reply)
     * once no reply arrived for idleMs (BMW waits up to 10 s per reply).
     */
    async functional(sid, data, opts) {
        const idleMs = (opts && opts.idleMs) || 4000, maxMs = (opts && opts.maxMs) || 25000;
        const replies = new Map();
        let idle, hard, onFrame, onErr, finish, kick;
        const done = new Promise((resolve) => {
            finish = () => { clearTimeout(idle); clearTimeout(hard); this.removeListener('frame', onFrame); this.removeListener('tasError', onErr); resolve(replies); };
            kick = (ms) => { clearTimeout(idle); idle = setTimeout(finish, ms); };
            onFrame = (f) => {
                const pending = f.uds[0] === 0x7F && f.uds[2] === 0x78;
                if (!pending || !replies.has(f.ecu)) replies.set(f.ecu, f.uds);
                if (opts && opts.onReply && !pending) opts.onReply(f.ecu, replies.size);
                kick(pending ? 10000 : idleMs);
            };
            onErr = (e) => this.log.warn('TASU error during scan: ' + e);
            this.on('frame', onFrame); this.on('tasError', onErr);
        });
        try { this._check(await this.send(ALL, sid, data)); } catch (e) { finish(); throw e; }
        // timers from when the transport took the request (send() may have waited for it)
        if (!idle) kick(idleMs + 2000);          // first replies can take a moment
        hard = setTimeout(finish, maxMs);
        return done;
    }

    /**
     * Physical request to one ECU; resolves with its UDS reply (null on timeout).
     * accept(uds) (optional) skips replies that aren't ours - another app may be
     * talking to the same ECU at the same time.
     */
    async physical(target, sid, data, timeoutMs, accept, opts) {
        let t, hardTimer, onFrame, finish, done = false;
        const got = new Promise((resolve) => {
            finish = (v) => {
                if (done) return;
                done = true;
                clearTimeout(t); clearTimeout(hardTimer);
                this.removeListener('frame', onFrame); resolve(v);
            };
            onFrame = (f) => {
                if (f.ecu !== target) return;
                if (f.uds[0] === 0x7F && f.uds[2] === 0x78) {
                    clearTimeout(t);
                    t = setTimeout(() => finish(null), opts && opts.pendingTimeoutMs || 10000);
                    return;
                }
                if (accept && !accept(f.uds)) return;
                finish(f.uds);
            };
            this.on('frame', onFrame);
            if (opts && opts.hardTimeoutMs) hardTimer = setTimeout(() => finish(null), opts.hardTimeoutMs);
        });
        try { this._check(await this.send(target, sid, data, opts)); } catch (e) { finish(null); throw e; }
        if (!done && !t) t = setTimeout(() => finish(null), timeoutMs || 4000); // from when the transport took it
        return got;
    }
}

/**
 * Parse a 0x19 reply. params = the request bytes after 0x19 (e.g. [0x02, 0x0C]).
 * The DTC records start after the echoed request bytes + availability mask,
 * i.e. at 1 + params.length (BMW: offset 10 + params/2 in the full frame).
 */
function parseDtcReply(uds, params) {
    if (!uds || !uds.length) return { ok: false, nrc: null, dtcs: [] };
    if (uds[0] === 0x7F) return { ok: false, nrc: uds[2], dtcs: [] };
    if (uds[0] !== 0x59 || uds[1] !== params[0]) return { ok: false, nrc: null, dtcs: [] };
    const out = [];
    for (let i = 1 + params.length; i + 4 <= uds.length; i += 4) {
        out.push({ code: hex(((uds[i] << 16) | (uds[i + 1] << 8) | uds[i + 2]) >>> 0, 6), status: uds[i + 3] });
    }
    return { ok: true, nrc: null, dtcs: out };
}

/** ISO 14229 DTC status byte -> the label we show + severity. */
function statusInfo(b) {
    if (b & 0x01) return { label: 'ACTIVE', sev: 'crit' };
    if (b & 0x80) return { label: 'WARNING LAMP', sev: 'crit' };
    if (b & 0x04) return { label: 'PENDING', sev: 'warn' };
    if (b & 0x08) return { label: 'STORED', sev: 'warn' };
    return { label: 'HISTORY', sev: 'dim' };
}

module.exports = { Diag, parseDtcReply, statusInfo, toBytes, hex, NRC, ALL };
