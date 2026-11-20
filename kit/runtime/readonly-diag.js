'use strict';
/**
 * readonly-diag.js - the head unit's diagnostic link (diag.js) restricted to READING.
 *
 * For apps that only look at the car (Live Data). The Diag underneath is private to this
 * module, and every request passes check() first, so nothing else can leave the head unit:
 *
 *   0x22 <DID>...   ReadDataByIdentifier, one to MAX_DIDS (8) identifiers, to one control unit
 *   0x22 F1 50      the same to all units at once (functional 0xDF): which units are there,
 *                   and their SGBD index (what BMW's diagnostic tools identify a unit by)
 *   0x01 / 0x09     OBD-II current data / vehicle information, one PID, to one unit
 *
 * Anything else throws before it reaches the transport: sessions (10), resets (11), clearing
 * faults (14), security access (27), communication control (28), dynamic identifiers (2C),
 * writes (2E), I/O control (2F), routines (31), downloads (34-37), tester present (3E), DTC
 * settings (85), any functional request but 22 F1 50, and a physical request to 0xDF.
 *
 * It also paces: one request at a time and at least gapMs between two (25 ms), a 1 s pause after a
 * unit answers busy (NRC 21), and a unit that didn't answer silentAfter requests in a row is skipped
 * until wake(address) (asleep, or not there).
 * stats: requests sent, replies and the time they took (ms / timed), ones without an answer (missed),
 * refused requests (blocked).
 *
 *   const link = new ReadOnlyDiag(ctx.signals, log);
 *   await link.init();
 *   const units = await link.discover();         // Map(address -> SGBD index '0F26E8' or '')
 *   const uds = await link.read(0x12, 0x4A36);   // the unit's reply (62 4A 36 ... / 7F 22 31), null when
 *                                                // it didn't answer, undefined when cancelled before sending
 *   link.readMany(0x12, [0x4402, 0x586F])        // several identifiers in one request: 62 44 02 <data> 58 6F <data>
 *   new DidReader(link, { ecu: 0x12 })           // kit/dids.js works on top of it (physical())
 *   link.cancel()                                // drop what is still queued (page left)
 */
const { Diag, hex, NRC, ALL } = require('./diag');

const READ = Object.freeze({ 0x22: 'ReadDataByIdentifier', 0x01: 'OBD current data', 0x09: 'OBD vehicle information' });
const MAX_DIDS = 8;                   // identifiers in one 22 request
const DISCOVER = Object.freeze([0xF1, 0x50]);
const LINKS = new WeakMap();          // ReadOnlyDiag -> its Diag, out of reach of the app

const byte = (b) => Number.isInteger(b) && b >= 0 && b <= 0xFF;
const show = (n) => (Number.isInteger(n) ? hex(n) : String(n));

/** Throws unless the request only reads (see the top of this file). Exported for the tests. */
function check(target, sid, data, functional) {
    if (!Array.isArray(data) || !data.every(byte)) throw new Error('read-only: bad request bytes');
    if (!byte(sid) || !READ[sid]) throw new Error('read-only: service ' + show(sid) + ' is not allowed');
    if (!byte(target)) throw new Error('read-only: bad address ' + show(target));
    if (sid === 0x22 && (data.length < 2 || data.length > 2 * MAX_DIDS || data.length % 2)) throw new Error('read-only: 22 takes 1 to ' + MAX_DIDS + ' identifiers');
    if (sid !== 0x22 && data.length !== 1) throw new Error('read-only: ' + show(sid) + ' takes exactly one PID');
    if (functional !== (target === ALL)) throw new Error('read-only: 0xDF only as a functional request');
    if (functional && !(sid === 0x22 && data[0] === DISCOVER[0] && data[1] === DISCOVER[1])) {
        throw new Error('read-only: only 22 F1 50 may go to all units');
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ReadOnlyDiag {
    constructor(signals, log, opts) {
        const diag = new Diag(signals, log);
        diag.quiet = true;            // polling: the requests aren't logged one by one
        // the transport is busy now and then (other apps and BMW's own services use it too): try again
        // soon (100, 200, 300, 400 ms) instead of after seconds, and count it rather than log each one
        diag.busyMs = (opts && opts.busyMs) || 100;
        diag.busyLog = false;
        LINKS.set(this, diag);
        this.log = log;
        this.gapMs = (opts && opts.gapMs) || 25;
        this.silentAfter = (opts && opts.silentAfter) || 5;
        this.misses = {};             // address -> requests in a row without an answer
        this.stats = { sent: 0, replies: 0, missed: 0, silent: 0, blocked: 0, ms: 0, timed: 0 };
        this.chain = Promise.resolve();
        this.next = 0;                // the earliest time the next request may go
        this.gen = 0;                 // cancel() counts it up: older queued requests are dropped
    }

    async init() { await LINKS.get(this).init(); return this; }
    get ready() { return !!LINKS.get(this).p; }
    get available() { return LINKS.get(this).available; }
    get error() { return LINKS.get(this).error; }
    /** how often the transport said busy so far */
    get busy() { return LINKS.get(this).busy; }

    /** Has this unit stopped answering? (skipped until wake()) */
    silent(target) { return (this.misses[target] || 0) >= this.silentAfter; }
    wake(target) { if (target === undefined) this.misses = {}; else delete this.misses[target]; }

    /** Drop every request still waiting in the queue: they resolve with undefined (not sent), not null. */
    cancel() { this.gen++; }

    /** Physical request (kit/dids.js calls this): the unit's reply bytes, or null. */
    physical(target, sid, data, timeoutMs, accept) {
        const d = Array.isArray(data) ? data.slice() : data;          // checked = sent: no change after the check
        try { check(target, sid, d, false); } catch (e) { return this.blocked(e); }
        if (this.silent(target)) return Promise.resolve(null);
        return this.queue(async () => {
            this.stats.sent++;
            const t0 = Date.now();
            const uds = await LINKS.get(this).physical(target, sid, d, timeoutMs || 1500, accept);
            if (uds) { this.stats.ms += Date.now() - t0; this.stats.timed++; }
            if (!uds) {
                this.stats.missed++;
                this.misses[target] = (this.misses[target] || 0) + 1;
                if (this.silent(target)) { this.stats.silent++; this.log.info('unit ' + hex(target) + ': no answer ' + this.silentAfter + ' times in a row - skipped until woken'); }
                return null;
            }
            this.misses[target] = 0;
            this.stats.replies++;
            if (uds[0] === 0x7F && uds[2] === 0x21) this.next = Math.max(this.next, Date.now() + 1000);      // busy: give it a second
            return uds;
        });
    }

    /** One identifier from one unit: its reply (positive 62 or refusal 7F 22), or null. */
    read(target, did, timeoutMs) {
        return this.readMany(target, [did], timeoutMs);
    }

    /**
     * Several identifiers in one request (at most MAX_DIDS): the reply has each answered one with its
     * data, in turn (62 <DID> <data> <DID> <data> ...; kit/sgbd.js split() takes it apart), or a refusal.
     */
    readMany(target, dids, timeoutMs) {
        const data = [];
        dids.forEach((did) => data.push((did >> 8) & 0xFF, did & 0xFF));
        return this.physical(target, 0x22, data, timeoutMs,
            (u) => (u[0] === 0x62 && dids.indexOf((u[1] << 8) | u[2]) >= 0) || (u[0] === 0x7F && u[1] === 0x22));
    }

    /**
     * 22 F1 50 to all units: Map(address -> SGBD index as 6 hex digits, '' when the unit refused).
     * Replies come in until none arrived for idleMs (diag.js functional()).
     */
    discover(opts) {
        const d = DISCOVER.slice();
        try { check(ALL, 0x22, d, true); } catch (e) { return this.blocked(e); }
        return this.queue(async () => {
            this.stats.sent++;
            const replies = await LINKS.get(this).functional(0x22, d, Object.assign({ idleMs: 3000, maxMs: 15000 }, opts));
            const out = new Map();
            replies.forEach((u, addr) => {
                out.set(addr, u[0] === 0x62 && u[1] === 0xF1 && u[2] === 0x50 && u.length >= 6 ? hex(((u[3] << 16) | (u[4] << 8) | u[5]) >>> 0, 6) : '');
            });
            this.stats.replies += out.size;
            return out;
        });
    }

    blocked(e) {
        this.stats.blocked++;
        this.log.error('blocked a diagnostic request: ' + e.message);
        return Promise.reject(e);
    }

    /** Run fn after the requests before it, at least gapMs after the last one ended. */
    queue(fn) {
        const gen = this.gen;
        const run = async () => {
            if (gen !== this.gen) return undefined;
            const wait = Math.max(0, this.next - Date.now());
            if (wait) await sleep(wait);
            if (gen !== this.gen) return undefined;
            try { return await fn(); } finally { this.next = Math.max(this.next, Date.now() + this.gapMs); }
        };
        const p = this.chain.then(run, run);
        this.chain = p.catch(() => {});
        return p;
    }
}

module.exports = { ReadOnlyDiag, check, READ, NRC, MAX_DIDS };
