'use strict';
/**
 * others.js - another ambient light app's service running beside this app. IterioDev's Comfort tool (the service
 * behind his Ambient Light and Seats apps, github.com/IterioDev/car-apps) writes the same light modules through the
 * body controller, with its own colours every 2 minutes - but only while its own ambient colour or its drive-mode
 * colours are on (its data.json "ambient": on / modes.on). Its control socket is there exactly while it runs (systemd
 * RuntimeDirectory), and apps can see it (his apps connect to it).
 *
 * Comfort running for the seats alone (its ambient off) leaves the lights to this app: o.comfort is true only while
 * Comfort runs AND its ambient is on, or its settings cannot be read (then, as before, this app stands aside). Its
 * data.json is read, not its socket: a connection makes it ask the seat modules again, and its last client leaving
 * stops a seat move.
 *
 *   const o = new Others({ log }); o.start();
 *   o.comfort -> true while Comfort runs with its ambient on        o.running -> Comfort runs at all
 *   o.on('change', fn)
 */
const EventEmitter = require('events');
const fs = require('fs');

const COMFORT_SOCK = process.env.MGU_AMBIENT_COMFORT || '/run/iteriodev-comfort/ctl.sock';
const COMFORT_DATA = process.env.MGU_AMBIENT_COMFORT_DATA || '/var/opt/iteriodev-comfort/data.json';
const EVERY_MS = 10000;

class Others extends EventEmitter {
    constructor(o) {
        super();
        this.log = o && o.log; this.comfort = false; this._timer = null;
    }

    start() { this.check(); this._timer = setInterval(() => this.check(), EVERY_MS); return this; }

    stop() { clearInterval(this._timer); }

    /** Comfort's ambient: true (on: its colour or its drive-mode colours), false (off), null (cannot be read) */
    static lightsOn() {
        try {
            const a = JSON.parse(fs.readFileSync(COMFORT_DATA, 'utf8')).ambient;
            if (!a || typeof a !== 'object') return false;          // never set: its default is off
            return a.on === true || !!(a.modes && a.modes.on === true);
        } catch (e) { return e.code === 'ENOENT' ? false : null; }  // no file yet: nothing set, off
    }

    check() {
        let running = false;
        try { running = fs.statSync(COMFORT_SOCK).isSocket(); } catch (e) { /* not running */ }
        const lights = running ? Others.lightsOn() : false;
        const on = running && lights !== false;
        if (running !== this.running && this.log) {
            if (running) this.log.info('IterioDev\'s Comfort tool is running');
            else if (this.running !== undefined) this.log.info('IterioDev\'s Comfort tool is no longer running');
        }
        this.running = running;
        if (on === this.comfort) return;
        this.comfort = on;
        if (this.log) {
            if (on) this.log.warn(lights === null
                ? 'IterioDev\'s Comfort tool is running and its settings cannot be read: it may write the ambient lights too, so this app stands aside'
                : 'IterioDev\'s Comfort tool writes the ambient lights (its own colour or its drive-mode colours are on), so the colours jump between the two apps');
            else this.log.info('IterioDev\'s Comfort tool no longer writes the ambient lights');
        }
        this.emit('change');
    }
}

module.exports = { Others, COMFORT_SOCK, COMFORT_DATA };
