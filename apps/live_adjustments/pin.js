'use strict';
/**
 * pin.js - the PIN in front of the Engine Map and Burbles tabs (setting "PIN for Engine Map and Burbles", issue #155).
 *
 * With the setting on, those tabs show a keypad instead of their buttons (one PIN, one unlock for both):
 *   - no PIN yet: choose 4 digits, then the same 4 again; saved (salted SHA-256 in the hidden setting
 *     mapPinCode, never the digits) and the tabs open
 *   - a PIN saved: the tabs open with it, until the app leaves the screen (lock())
 *   - 5 wrong PINs: no tries for 60 s
 *   - turning the setting off while they are locked asks for the PIN first (the setting goes back on
 *     until it is entered); with them open it is off at once and the PIN is forgotten
 * A forgotten PIN: delete the app's settings (or reinstall the app).
 *
 *   const pin = new PinLock({ get, set });   // the app's settings
 *   pin.locked()          true: show pin.view(page) and the keypad on those tabs
 *   pin.digit(n) / pin.back() / pin.lock() / pin.settingChanged(key, value)
 */
const crypto = require('crypto');

const LEN = 4, TRIES = 5, WAIT_MS = 60000;
const ON = 'mapPin', CODE = 'mapPinCode';

const hash = (salt, pin) => crypto.createHash('sha256').update(salt + ':' + pin).digest('hex');

class PinLock {
    constructor(o) {
        this.get = o.get; this.set = o.set; this.now = o.now || Date.now;
        this.open = false; this.entry = ''; this.first = null; this.msg = null; this.warn = false;
        this.tries = 0; this.until = 0; this.offPending = false;
    }

    enabled() { return this.get(ON) === true; }
    code() { const c = this.get(CODE); return c && c.salt && c.hash ? c : null; }
    locked() { return this.enabled() && (!this.code() || !this.open); }

    /** what the keypad shows: mode 'choose' | 'again' | 'enter', digits typed, a message, seconds still to wait */
    view(page) {
        const wait = Math.max(0, Math.ceil((this.until - this.now()) / 1000));
        const mode = this.code() ? 'enter' : this.first === null ? 'choose' : 'again';
        const title = mode === 'choose' ? 'Choose a 4-digit PIN' : mode === 'again' ? 'Enter the new PIN again'
            : this.offPending ? 'Enter the PIN to turn the lock off' : (page || 'Engine Map') + ' is locked';
        return { mode, title, digits: this.entry.length, len: LEN, wait, msg: wait ? 'Too many wrong PINs · try again in ' + wait + ' s' : this.msg, warn: wait > 0 || this.warn };
    }

    digit(n) {
        if (!this.locked() || this.now() < this.until || this.entry.length >= LEN) return;
        this.entry += String(n);
        if (this.entry.length === LEN) this._done();
    }
    back() { this.entry = this.entry.slice(0, -1); }

    /** the app left the screen: locked again, half-typed digits gone */
    lock() {
        this.open = false; this.entry = ''; this.first = null; this.msg = null; this.warn = false;
        if (this.offPending) { this.offPending = false; }
    }

    settingChanged(key, value) {
        if (key !== ON) return;
        if (value === true) { this.msg = null; return; }
        // off: only with the PIN (none chosen yet, or the tab open: at once)
        if (this.code() && !this.open) {
            this.offPending = true; this.entry = ''; this.msg = null;
            this.set(ON, true);
            return;
        }
        this._forget();
    }

    _done() {
        const pin = this.entry; this.entry = '';
        const c = this.code();
        if (!c) {
            if (this.first === null) { this.first = pin; this.msg = null; this.warn = false; return; }
            if (pin !== this.first) { this.first = null; this.msg = "The two PINs didn't match · choose again"; this.warn = true; return; }
            const salt = crypto.randomBytes(8).toString('hex');
            this.first = null; this.open = true; this.msg = null; this.warn = false;
            this.set(CODE, { salt, hash: hash(salt, pin) });
            return;
        }
        if (hash(c.salt, pin) === c.hash) {
            this.tries = 0; this.msg = null; this.warn = false;
            if (this.offPending) { this.offPending = false; this._forget(); this.set(ON, false); return; }
            this.open = true;
            return;
        }
        this.tries++;
        this.warn = true;
        if (this.tries >= TRIES) { this.tries = 0; this.until = this.now() + WAIT_MS; this.msg = null; }
        else this.msg = 'Wrong PIN · ' + (TRIES - this.tries) + (TRIES - this.tries === 1 ? ' try' : ' tries') + ' left';
    }

    _forget() {
        this.open = false; this.entry = ''; this.first = null; this.offPending = false; this.msg = null; this.warn = false;
        if (this.get(CODE) && Object.keys(this.get(CODE)).length) this.set(CODE, {});
    }
}

module.exports = { PinLock, LEN, TRIES, WAIT_MS };
