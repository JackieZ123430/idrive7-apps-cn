'use strict';
/**
 * controls.js - the iDrive controller -> Doom keys.
 *
 * Controller (live): the car sends the controller's own state (FrontCCU.statusRotaryEncoderState):
 *   turn the knob      aim (turn left / right, a fixed angle per click)
 *   push up / down     walk forward / back (held while pushed)
 *   push left / right  sidestep (held while pushed)
 *   press              fire (held while pressed) and use (doors, switches, respawn, next level)
 *   press twice fast   next weapon
 *
 * Bar (fallback, when no controller data comes: the VM, or a car that doesn't send it to apps):
 * the HMI's bar buttons are still there under the game (not drawn). The button the controller
 * rests on is held (Turn left, Walk, ...); pressing fires and uses; Weapon switches weapon.
 */
const { KEY } = require('./doom-core');

// FrontRotaryEncoderDeflection / FrontRotaryEncoderPushButton: the SDK hands enums over by name
// (numbers accepted too)
const DEFL = { MITTELSTELLUNG: 0, NORD_KURZ_GEDRUECKT: 1, NORD_LANG_GEDRUECKT: 2, NORD_UNWIRKSAM: 3, OST_KURZ_GEDRUECKT: 4,
    OST_LANG_GEDRUECKT: 5, OST_UNWIRKSAM: 6, SUED_KURZ_GEDRUECKT: 7, SUED_LANG_GEDRUECKT: 8, SUED_UNWIRKSAM: 9,
    WEST_KURZ_GEDRUECKT: 10, WEST_LANG_GEDRUECKT: 11, WEST_UNWIRKSAM: 12, SIGNAL_UNGUELTIG: 15 };
const PUSH = { KEINE_BETAETIGUNG: 0, DREHGEBER_KURZ_GEDRUECKT: 1, DREHGEBER_LANG_GEDRUECKT: 2, UNWIRKSAM: 3, SIGNAL_UNGUELTIG: 15 };
const num = (v, names) => (typeof v === 'number' ? v : v != null && names[v] != null ? names[v] : 15);
const DIR = { 1: 'N', 2: 'N', 4: 'E', 5: 'E', 7: 'S', 8: 'S', 10: 'W', 11: 'W' };
const PUSH_KEYS = { N: [KEY.UP], S: [KEY.DOWN], E: [KEY.SRIGHT], W: [KEY.SLEFT] };
// bar fallback: what each (hidden) bar button holds
const BAR = {
    BTN_STAND: [], BTN_WEAPON: [],
    BTN_BACK: [KEY.DOWN], BTN_TL: [KEY.LEFT], BTN_WL: [KEY.UP, KEY.LEFT],
    BTN_WALK: [KEY.UP], BTN_WR: [KEY.UP, KEY.RIGHT], BTN_TR: [KEY.RIGHT],
};
const MOVES = [KEY.UP, KEY.DOWN, KEY.SLEFT, KEY.SRIGHT];
// Doom angle per knob click: angleturn units of 0x8 per mouse step, 65536 = 360 degrees
const AIM_DEG = { slow: 4, normal: 7.5, fast: 12 };
const DOUBLE_MS = 350;

class Controls {
    /** game: Doom (key, turn); opts: { log, run(): bool, aim(): 'slow'|..., reversed(): bool, now() } */
    constructor(game, opts) {
        this.game = game; this.o = opts; this.log = opts.log;
        this.now = opts.now || Date.now;
        this.live = false;              // controller data arriving
        this.pos = null;                // knob counter
        this.push = null;               // 'N' 'E' 'S' 'W' or null
        this.pressed = false;
        this.pressT = 0;                // last press start
        this.lastPressT = -1e9;         // for double press
        this.msgT = 0; this.same = 0; this.lastMsg = '';
        this.cyclic = false;            // the car repeats unchanged messages (then a lost release is timed out)
        this.focused = null;            // bar fallback
        this.held = [];
        this.enabled = false;
        this.logged = 0;
        this.turned = 0;                // knob clicks seen (status / tests)
    }

    /* ---------- controller ---------- */
    raw(v) {
        if (!v) return;
        const key = JSON.stringify(v);
        if (this.logged < 40 && key !== this.lastMsg) { this.logged++; this.log.info('controller ' + key); }
        const t = this.now();
        if (key === this.lastMsg) { if (++this.same >= 5 && !this.cyclic) { this.cyclic = true; this.log.info('controller: sent cyclically'); } } else this.same = 0;
        this.lastMsg = key; this.msgT = t;
        const pushBtn = num(v.frontRotaryEncoderPushButton, PUSH), defl = num(v.frontRotaryEncoderDeflection, DEFL), pos = v.frontRotaryEncoderOperation;
        // no controller behind it (the VM): everything SIGNAL_UNGUELTIG, counter 65535
        const valid = pushBtn !== 15 || defl !== 15;
        if (!valid) return;
        if (!this.live) { this.live = true; this.log.info('controller: live (knob, push and press drive the game)'); }
        // knob: a counter, wrapping at 16 bits; big jumps (a reset) are skipped
        if (typeof pos === 'number') {
            if (this.pos !== null) {
                let d = ((pos - this.pos + 32768) & 0xffff) - 32768;
                if (Math.abs(d) <= 64 && d) {
                    this.turned += d;
                    if (this.enabled) this.game.turn(d * this.turnStep());
                }
            }
            this.pos = pos;
        }
        this.push = DIR[defl] || null;
        const p = pushBtn === 1 || pushBtn === 2;
        if (p && !this.pressed) this.onPress(t);
        this.pressed = p;
        this.apply();
    }

    /** mouse units per knob click (+ = right) */
    turnStep() {
        const deg = AIM_DEG[this.o.aim && this.o.aim()] || AIM_DEG.normal;
        return (this.o.reversed && this.o.reversed() ? -1 : 1) * deg / 360 * 65536 / 8;
    }

    onPress(t) {
        if (!this.enabled) return;
        if (t - this.lastPressT < DOUBLE_MS) this.tap(KEY.NEXTW);
        this.lastPressT = t; this.pressT = t;
        this.tap(KEY.USE);
    }

    /* ---------- bar fallback ---------- */
    barFocus(name, on) {
        if (on) this.focused = name; else if (this.focused === name) this.focused = null;
        this.apply();
    }
    /** a (hidden) bar button was pressed: the controller's press or a tap */
    barClick(name) {
        if (this.live) return null;           // the controller's own press reaches the HMI too: already handled
        if (!this.enabled) return null;
        if (name === 'BTN_WEAPON') { this.tap(KEY.NEXTW); return null; }
        this.tap(KEY.FIRE); this.tap(KEY.USE);
        return null;
    }

    /* ---------- keys ---------- */
    tap(k) { this.game.key(true, k); setTimeout(() => this.game.key(false, k), 120); }

    want() {
        if (!this.enabled) return [];
        let keys;
        if (this.live) {
            // a release lost on the way (UDP) is timed out when the car repeats its messages
            const stale = this.cyclic && this.now() - this.msgT > 1500;
            keys = (!stale && this.push ? PUSH_KEYS[this.push] : []).concat(!stale && this.pressed ? [KEY.FIRE] : []);
        } else keys = (BAR[this.focused] || []).slice();
        if (this.o.run && this.o.run() && keys.some((k) => MOVES.indexOf(k) >= 0 || k === KEY.LEFT || k === KEY.RIGHT)) keys.push(KEY.RSHIFT);
        return keys;
    }

    apply() {
        const keys = this.want();
        this.held.forEach((k) => { if (keys.indexOf(k) < 0) this.game.key(false, k); });
        keys.forEach((k) => { if (this.held.indexOf(k) < 0) this.game.key(true, k); });
        this.held = keys;
    }

    /** game running or not (paused: everything is let go) */
    enable(on) { this.enabled = !!on; this.apply(); }

    /** what the player is doing now, for the screen: { push, fire, focused } */
    status() { return { push: this.push, fire: this.pressed, focused: this.focused, live: this.live }; }
}

module.exports = { Controls, BAR, AIM_DEG };
