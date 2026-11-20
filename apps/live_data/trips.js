'use strict';
/**
 * trips.js - the trip computer. A trip runs from the engine's start until the engine has been off and
 * the car standing for END_MS (a stop to refuel, start-stop at the lights: the same trip). It adds up
 * the distance (the car's speed over time), the fuel (the fuel flow in l/h over time), the time
 * driving and standing, and the cost: the litres x the fuel price.
 *
 * Kept (data/trips.json, a few kB that never grow): the trip going on, the last KEEP trips, a total a
 * day for the last DAYS days and one over everything recorded. A finished trip keeps the price it
 * had; one that had none takes the price once it is set.
 *
 *   const tc = new Trips(savedObject);
 *   tc.feed(now, { speed, lph, src, running, odo, tank })   // about twice a second; null = not known now
 *       -> { started, ended }                               // ended: the finished trip (or null)
 *   tc.cur, tc.trips (oldest first), tc.total('today' | 'week' | 'month' | 'last' | 'all', now)
 *   tc.setPrice(1.79); tc.cost(trip); tc.toJSON()
 */
const END_MS = 10 * 60000;          // engine off and standing this long: the trip is over
const KEEP = 5, DAYS = 31;
const PRICE = 1.8;                  // the fuel price a new install starts with (a litre, in Settings' currency)
const MAX_DT = 5000;                // a longer gap between two samples isn't counted (the app was held up)
const DAY = 86400000;

const pad = (n) => (n < 10 ? '0' : '') + n;
const dayKey = (t) => { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const isNum = (x) => typeof x === 'number' && isFinite(x);
const num = (x) => (isNum(x) ? x : null);
const round = (x, d) => Math.round(x * Math.pow(10, d)) / Math.pow(10, d);
/** a total: its trips, km, litres, the cost of the litres that had a price, the litres that had none (lNp) */
const blank = () => ({ n: 0, km: 0, l: 0, cost: 0, lNp: 0 });
const SUMS = ['n', 'km', 'l', 'cost', 'lNp'];
const valid = (tr) => tr && isNum(tr.start) && isNum(tr.end) && isNum(tr.km) && isNum(tr.l);
function add(a, tr) {
    a.n++; a.km += tr.km; a.l += tr.l;
    if (tr.price) a.cost += tr.l * tr.price; else a.lNp += tr.l;
}

class Trips {
    constructor(saved) {
        const s = saved && typeof saved === 'object' ? saved : {};
        this.cur = s.cur && isNum(s.cur.start) && isNum(s.cur.end) ? Object.assign({ src: {} }, s.cur) : null;
        this.trips = Array.isArray(s.trips) ? s.trips.filter(valid).slice(-KEEP) : [];
        this.days = {};
        if (s.days && typeof s.days === 'object') Object.keys(s.days).forEach((k) => { if (/^\d{4}-\d\d-\d\d$/.test(k)) this.days[k] = Object.assign(blank(), s.days[k]); });
        this.all = Object.assign(blank(), { since: null }, s.all && typeof s.all === 'object' ? s.all : {});
        this.price = isNum(s.price) ? Math.max(0, s.price) : PRICE;      // (none saved yet: the default)
        this.last = null;           // when the last sample came (not saved: after a restart nothing is counted over the gap)
        this.ver = 0;               // changes with every sample counted
    }

    feed(now, x) {
        const on = x.running === 'running' || x.running === 'starting';
        const v = isNum(x.speed) && x.speed > 0 ? x.speed : 0, moving = v > 2;
        let ended = null, started = false;
        // a trip whose last sign of life is END_MS old is over (the engine was off, or the head unit asleep)
        if (this.cur && now - this.cur.end > END_MS) ended = this.finish();
        if (!this.cur) {
            this.last = now;
            if (!on && !moving) return { started, ended };
            this.cur = { start: now, end: now, km: 0, l: 0, lIdle: 0, driveMs: 0, idleMs: 0, noFuelMs: 0, vmax: 0,
                odo0: num(x.odo), odo1: num(x.odo), tank0: num(x.tank), tank1: num(x.tank), src: {} };
            this.ver++;
            return { started: true, ended };
        }
        const c = this.cur, dt = this.last === null ? 0 : now - this.last;
        this.last = now;
        if (on || moving) c.end = now;
        if (isNum(x.odo)) { if (c.odo0 === null) c.odo0 = x.odo; c.odo1 = x.odo; }
        if (isNum(x.tank)) { if (c.tank0 === null) c.tank0 = x.tank; c.tank1 = x.tank; }
        if (dt <= 0 || dt > MAX_DT) return { started, ended };
        c.km += v * dt / 3600000;
        if (v > c.vmax) c.vmax = v;
        if (moving) c.driveMs += dt; else if (on) c.idleMs += dt;
        if (isNum(x.lph) && x.lph >= 0) {
            const l = x.lph * dt / 3600000;
            c.l += l;
            if (!moving) c.lIdle += l;
            if (x.src) c.src[x.src] = 1;
        } else if (on) c.noFuelMs += dt;
        this.ver++;
        return { started, ended };
    }

    /** ends the trip going on; returns it as kept, or null (started and stopped without going anywhere) */
    finish() {
        const c = this.cur;
        this.cur = null; this.ver++;
        if (!c || (c.km < 0.1 && c.l < 0.05)) return null;
        const tr = {
            start: c.start, end: c.end, km: round(c.km, 3), l: round(c.l, 4), lIdle: round(c.lIdle, 4),
            driveMs: c.driveMs, idleMs: c.idleMs, noFuelMs: c.noFuelMs, vmax: round(c.vmax, 1),
            odo0: c.odo0, odo1: c.odo1, tank0: c.tank0, tank1: c.tank1, price: this.price || null, src: Object.keys(c.src || {}).join('+') || null,
        };
        this.trips.push(tr);
        while (this.trips.length > KEEP) this.trips.shift();
        const k = dayKey(tr.start);
        add(this.days[k] || (this.days[k] = blank()), tr);
        const oldest = dayKey(tr.end - (DAYS - 1) * DAY);
        Object.keys(this.days).forEach((d) => { if (d < oldest) delete this.days[d]; });
        add(this.all, tr);
        if (!this.all.since) this.all.since = tr.start;
        return tr;
    }

    setPrice(p) { this.price = isNum(p) && p > 0 ? round(p, 2) : 0; this.ver++; }
    /** what a trip cost: its own price, else the price now; null without either */
    cost(tr) {
        const p = tr && (tr.price || this.price);
        return p ? tr.l * p : null;
    }

    /**
     * A total: { n, km, l, cost } (cost null when there is fuel without a price). kind: 'last' (the last
     * KEEP trips), 'today', 'week' (7 days), 'month' (30 days), 'all'; all but 'last' with the trip going on.
     */
    total(kind, now) {
        const out = blank(), days = { today: 1, week: 7, month: 30 }[kind], from = days ? dayKey(now - (days - 1) * DAY) : null;
        if (kind === 'last') this.trips.forEach((tr) => add(out, tr));
        else if (kind === 'all') SUMS.forEach((k) => { out[k] = this.all[k] || 0; });
        else Object.keys(this.days).forEach((d) => { if (d >= from) SUMS.forEach((k) => { out[k] += this.days[d][k] || 0; }); });
        const c = this.cur;
        if (c && kind !== 'last' && (kind === 'all' || dayKey(c.start) >= from)) {
            out.n++; out.km += c.km; out.l += c.l; out.lNp += c.l;      // the trip going on: at the price now
        }
        const cost = out.cost + (this.price ? out.lNp * this.price : 0);
        return { n: out.n, km: out.km, l: out.l, cost: out.lNp > 1e-9 && !this.price ? null : cost };
    }

    toJSON() {
        return { v: 1, price: this.price, cur: this.cur, trips: this.trips, days: this.days, all: this.all };
    }
}

/** l/100 km of a distance and its fuel, null below 1 km */
const per100 = (km, l) => (km >= 1 ? l / km * 100 : null);

module.exports = { Trips, END_MS, KEEP, DAYS, PRICE, dayKey, per100 };
