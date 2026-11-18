'use strict';
/**
 * lever.js - Ambient config: three quick pulls of the headlight-flasher lever while parked (while driving too with the
 * setting strobeLeverDriving, for private property) start the strobe (Strobe page's Lever start, off until switched
 * on); three more while it flashes stop it.
 *
 * The car's Vehicle2.statusMainBeam_headlightFlasher is on while the high beam is on or the lever is pulled, so only a
 * short pulse counts as a pull: on for at most PULSE_MS, then off again. The first pull of a set comes after the beam
 * was off for at least ARM_MS, each next one within GAP_MS of the last; the PULLS-th is the set. Held longer it is the
 * high beam, and a slower pull starts a set over. After a set nothing counts for COOL_MS.
 *
 *   const lv = new Lever(); lv.beam(on, t) -> true once for each set of PULLS pulls (t: ms); lv.cool(t)
 */
const ARM_MS = 1000, PULSE_MS = 1500, GAP_MS = 1200, PULLS = 3, COOL_MS = 2000;

/* The signal's value: true on, false off, null not known (names or wire numbers). */
const beamOf = (v) => (v === 'EIN' || v === 1 ? true : v === 'AUS' || v === 0 ? false : null);

class Lever {
    constructor() { this.offAt = null; this.onAt = null; this.pull = false; this.count = 0; this.lastEnd = null; this.coolUntil = 0; }

    beam(on, t) {
        if (on === null) { this.offAt = null; this.onAt = null; this.count = 0; return false; }
        if (!on) {
            if (this.onAt !== null) {
                const counts = this.pull && t - this.onAt <= PULSE_MS && t >= this.coolUntil;
                this.count = counts ? this.count + 1 : 0;
                this.lastEnd = counts ? t : null;
                this.onAt = null;
            }
            if (this.offAt === null) this.offAt = t;
            if (this.count >= PULLS) { this.count = 0; return true; }
            return false;
        }
        if (this.onAt === null) {
            this.onAt = t;
            // the next pull of a set, or the first one after the beam was off long enough
            const next = this.count > 0 && this.lastEnd !== null && t - this.lastEnd <= GAP_MS;
            if (!next) this.count = 0;
            this.pull = next || (this.offAt !== null && t - this.offAt >= ARM_MS);
            this.offAt = null;
        }
        return false;
    }

    cool(t) { this.coolUntil = t + COOL_MS; this.count = 0; }
}

module.exports = { Lever, beamOf, ARM_MS, PULSE_MS, GAP_MS, PULLS, COOL_MS };
