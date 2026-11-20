'use strict';
/**
 * hud_claim.js - which app shows on the head-up display when more than one can.
 *
 * A standing app (Cluster functions) shows on the HUD whenever it is on. Another app the driver turns on
 * for the HUD (Redline) takes it over until the car is switched off, then the standing app has it again.
 *
 *   - An app holding the HUD keeps a claim, /dev/shm/mgu-hud/<id>, touched every 2 s. It is on tmpfs, so a
 *     head-unit start clears it; a claim not touched for 6 s (its app stopped) counts for nothing.
 *   - The standing app gives way while another app's claim is fresh (HudClaim.others).
 *   - The standing app says it is there and on in /dev/shm/mgu-hud/<id>.standing ({"on": true}); an app that
 *     takes the HUD over turns its own HUD off again at the car's switch-off or the head unit's next start,
 *     only while such an app is there (HudClaim.standingOn).
 *   - Where /dev/shm/mgu-hud cannot be written, nothing counts as a new start (thisBoot() is true): nothing is
 *     handed back for want of a claim file.
 *
 *   const claim = new HudClaim(id, log)
 *   claim.hold(on)                    take the HUD (true) or give it back
 *   claim.thisBoot()                  this app held the HUD since the head unit started (or that cannot be told)
 *   HudClaim.others(id)               ids of the other apps holding the HUD now
 *   HudClaim.standing(id, on)         (the standing app) there, and on or off
 *   HudClaim.standingOn(id)           another app stands on the HUD (id: this app's own)
 */
const fs = require('fs');
const path = require('path');

/** Write a file whole or not at all: a temp file renamed over it (a reader or a power cut never sees half). */
function writeWhole(file, text) {
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
}

const DIR = process.env.MGU_HUD_CLAIMS || '/dev/shm/mgu-hud';
const TOUCH_MS = 2000, FRESH_MS = 6000;
const STANDING = '.standing';

/*
 * The claims' folder, made if it is not there (Node 8: no recursive mkdir; /dev/shm is there). Every app writes in
 * it, each as its own user, so it is opened as /tmp is (1777, sticky: anyone writes, only a file's owner removes
 * it); mkdir's mode alone would lose the group and other write to the umask. Only the app that made the folder can
 * open it: the others' chmod fails, and once tried it is not tried again until the folder is made anew.
 */
let opened = false;
function folder() {
    let made = false;
    try { fs.mkdirSync(DIR); made = true; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (opened && !made) return;
    opened = true;
    try { fs.chmodSync(DIR, 0o1777); } catch (e) { /* another app's folder: it opens it */ }
}

class HudClaim {
    constructor(id, log) {
        this.id = id;
        this.log = log;
        this.file = path.join(DIR, id);
        this.timer = null;
        this.failed = false;
    }

    hold(on) {
        if (!!on === !!this.timer) return;
        if (on) {
            this._touch();
            this.timer = setInterval(() => this._touch(), TOUCH_MS);
            if (this.timer.unref) this.timer.unref();
        } else {
            clearInterval(this.timer);
            this.timer = null;
            try { writeWhole(this.file, JSON.stringify({ held: false, at: Date.now() }) + '\n'); } catch (e) { /* tmpfs gone */ }
        }
    }

    // the file stays when given back (held false): the head unit has not restarted since. A folder that cannot be
    // written tells nothing: as the same start
    thisBoot() {
        if (fs.existsSync(this.file)) return true;
        try { folder(); if (!fs.statSync(DIR).isDirectory()) return true; fs.accessSync(DIR, fs.constants.W_OK); return false; } catch (e) { return true; }
    }

    _touch() {
        try {
            folder();
            writeWhole(this.file, JSON.stringify({ held: true, at: Date.now() }) + '\n');
            this.failed = false;
        } catch (e) {
            if (!this.failed && this.log) this.log.warn('HUD claim: ' + e.message);
            this.failed = true;
        }
    }

    static others(id) {
        let names = [];
        try { names = fs.readdirSync(DIR); } catch (e) { return []; }
        const now = Date.now();
        return names.filter((n) => {
            if (n === id || n.endsWith(STANDING) || n.endsWith('.tmp')) return false;     // .tmp: a claim being written
            try {
                const f = path.join(DIR, n);
                return now - fs.statSync(f).mtimeMs < FRESH_MS && JSON.parse(fs.readFileSync(f, 'utf8')).held === true;
            } catch (e) { return false; }
        });
    }

    static standing(id, on) {
        const f = path.join(DIR, id + STANDING);
        try {
            if (JSON.parse(fs.readFileSync(f, 'utf8')).on === !!on) return;
        } catch (e) { /* not written yet */ }
        try { folder(); writeWhole(f, JSON.stringify({ on: !!on }) + '\n'); } catch (e) { /* tmpfs gone */ }
    }

    static standingOn(id) {
        let names = [];
        try { names = fs.readdirSync(DIR); } catch (e) { return false; }
        return names.some((n) => {
            if (!n.endsWith(STANDING) || n === id + STANDING) return false;
            try { return JSON.parse(fs.readFileSync(path.join(DIR, n), 'utf8')).on === true; } catch (e) { return false; }
        });
    }
}

module.exports = { HudClaim, DIR };
