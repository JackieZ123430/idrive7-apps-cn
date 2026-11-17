'use strict';
/**
 * lever.js - Ambient config: a short pull of the headlight-flasher lever while parked starts the strobe (Strobe page's
 * "Start with the flasher lever", off until switched on).
 *
 * The car's Vehicle2.statusMainBeam_headlightFlasher is on while the high beam is on or the lever is pulled, so only a
 * short pulse counts: the beam off for at least ARM_MS, then on for at most PULSE_MS, then off again. Held longer it is
 * the high beam, not a pull. After a start nothing counts for COOL_MS.
 *
 *   const lv = new Lever(); lv.beam(on, t) -> true once for each pull (t: ms); lv.cool(t)
 */
const ARM_MS = 1000, PULSE_MS = 1500, COOL_MS = 5000;

/* The signal's value: true on, false off, null not known (names or wire numbers). */
const beamOf = (v) => (v === 'EIN' || v === 1 ? true : v === 'AUS' || v === 0 ? false : null);

class Lever {
    constructor() { this.offAt = null; this.onAt = null; this.coolUntil = 0; }

    beam(on, t) {
        if (on === null) { this.offAt = null; this.onAt = null; return false; }
        if (!on) {
            const pulse = this.onAt !== null ? t - this.onAt : null, armed = this.armed;
            this.onAt = null; this.armed = false;
            if (this.offAt === null) this.offAt = t;
            return pulse !== null && armed && pulse <= PULSE_MS && t >= this.coolUntil;
        }
        if (this.onAt === null) {
            this.onAt = t;
            this.armed = this.offAt !== null && t - this.offAt >= ARM_MS;
            this.offAt = null;
        }
        return false;
    }

    cool(t) { this.coolUntil = t + COOL_MS; }
}

module.exports = { Lever, beamOf, ARM_MS, PULSE_MS, COOL_MS };
