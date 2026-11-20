'use strict';
/**
 * Part of Redline's experimental features; README.md in this folder has the whole picture.
 *
 * Redline's live shift values for other apps on the head unit (bimmer-lab's HUD Widgets reads them: bimmer-lab/apps#4),
 * so they needn't port Redline's scoring: /dev/shm/redline/shift.json
 *   { v: 1, t (ms), redline, shiftPoints: { gear: rpm }, gear, shiftNow, cold, leadMs, mode,
 *     lastShift: { at, from, to, rpm, target, verdict } | null }
 * Written whole (a temp file renamed over it, so a reader never sees half of one), at most once a second and at each
 * shift, only while the car is live (never from the demo drive). The folder and file are readable by every user (each
 * app runs as its own). A reader treats it as stale when t is more than a few seconds old: Redline isn't running.
 */
const fs = require('fs');
const path = require('path');

const DIR = process.env.REDLINE_SHARE_DIR || '/dev/shm/redline';
const EVERY_MS = 1000;

class ShiftShare {
    /** opts: { dir (default DIR), log } */
    constructor(opts) {
        this.dir = (opts && opts.dir) || DIR;
        this.file = path.join(this.dir, 'shift.json');
        this.log = opts && opts.log;
        this.at = 0;
        this.warned = false;
    }

    /** The folder, made readable by all (0755; chmod as well: the umask may take bits off mkdir's mode). */
    _folder() {
        if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, 0o755);
        fs.chmodSync(this.dir, 0o755);
    }

    /**
     * Write the values (an object as in the header, without v and t) if a second has passed since the last write, or
     * now with force (a shift). Returns true when written. Never throws; the first failure is logged.
     */
    write(values, force, now) {
        now = typeof now === 'number' ? now : Date.now();
        if (!force && now - this.at < EVERY_MS) return false;
        this.at = now;
        const tmp = this.file + '.' + process.pid + '.tmp';
        try {
            this._folder();
            fs.writeFileSync(tmp, JSON.stringify(Object.assign({ v: 1, t: now }, values)) + '\n', { mode: 0o644 });
            fs.chmodSync(tmp, 0o644);
            fs.renameSync(tmp, this.file);
            return true;
        } catch (e) {
            try { fs.unlinkSync(tmp); } catch (e2) { /* not made */ }
            if (!this.warned && this.log) this.log.warn('shift.json: ' + e.message);
            this.warned = true;
            return false;
        }
    }
}

module.exports = { ShiftShare, DIR };
