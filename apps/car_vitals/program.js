'use strict';
/**
 * program.js - M Vitals: S / M from the cluster's programme display. With the setting programSteady (a module such as
 * M-Track switches that signal between S and M to show the gear in the HUD, #193), M counts only once it has held
 * STEADY_MS with no S in between, as the paddles' M does; S meanwhile.
 *
 *   const p = new Program({ steady: () => bool, onChange: (v) => {} });  p.set('S' | 'M' | null);  p.value; p.recheck()
 */
const STEADY_MS = 2000;

class Program {
    constructor(o) {
        this.steady = o.steady; this.onChange = o.onChange || (() => {});
        this.now = o.now || Date.now; this.setTimer = o.setTimeout || setTimeout; this.clearTimer = o.clearTimeout || clearTimeout;
        this.raw = null; this.sAt = 0; this.timer = null; this.value = null;
    }

    set(p) {
        if (p === 'S' || (p === 'M' && this.raw !== 'M')) this.sAt = this.now();     // an S, or the moment M began
        this.raw = p;
        this.recheck();
    }

    recheck() {
        if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
        const wait = this.sAt + STEADY_MS - this.now();
        const v = this.steady() && this.raw === 'M' && wait > 0 ? 'S' : this.raw;
        if (v === 'S' && this.raw === 'M') this.timer = this.setTimer(() => { this.timer = null; this.recheck(); }, wait + 20);
        if (v !== this.value) { this.value = v; this.onChange(v); }
    }
}

module.exports = { Program, STEADY_MS };
