'use strict';
/**
 * control.js - which colour is on: the driver's own look (Colour and Animations tabs), a driving mode's look,
 * or the car's own colour.
 *
 *   look      the driver's look: { kind, upper: { rgb, bright }, lower: { rgb, bright }, speed }
 *   on        the look is on (false: the car's own colour)
 *   mode_<m>  a driving mode's look, 'original' (BMW's original colour in that mode), or null (nothing picked:
 *             the driver's look, or the car's)
 *   favs      up to six saved looks
 * Settings: follow (looks by driving mode), welcome (a sweep at each start), sportPulse (red for 1.5 s when
 * Sport is picked), nightDim (half the brightness at night), keep (the look back at each start), flashAlerts
 * (Redline's shift flash and other apps', from the file FLASH_FILE: { rgb, ms } written whole).
 * The car locked and left (parked or standby, nobody in it: away(true)): every light back to the car's own and nothing
 * renewed; someone back in (living, ignition, driving): the look again, with the welcome sweep when it is on.
 * Over the look (or the car's own colour), with their settings switched on (both off by default): turn(side) - while a turn signal is on, that side's
 * door lines blink green, fully on and off, as fast as the lights take it (setting turnGlow; hazards: both sides; not with
 * the car locked and left); doors(open) - an open door's line blinks red until it closes (setting doorRed; not with
 * the car locked and left, so a door left open does not keep the body module awake); with the hazards on (setting
 * hazardRed) every light pulses red, bright then dim, in place of the turn glow (not with the car locked and left). Left is
 * the driver's side on a left-hand drive car.
 */
const fs = require('fs');

const FLASH_FILE = process.env.MGU_AMBIENT_FLASH || '/dev/shm/mgu-ambient-flash.json';
const FAVS = 6;
const DEFAULT_LOOK = { kind: 'solid', upper: { rgb: [120, 60, 255], bright: 80 }, lower: { rgb: [120, 60, 255], bright: 80 }, speed: 2 };
const NIGHT = 0.5;
const GLOW = [0, 230, 60], RED = [255, 0, 0];
/* On one frame, dark the next (the light on at no brightness: black, not the car's own colour). */
const blink = (rgb) => (t, on) => (on ? { rgb, bright: 100 } : { rgb: [0, 0, 0], bright: 0 });
/* Bright one frame, dim the next (every light one colour: one write a bus, so it keeps about the hazards' pace). */
const PULSE_DIM = 15;
const pulse = (rgb) => (t, on) => ({ rgb, bright: on ? 100 : PULSE_DIM });
const DOORS = ['driver front', 'driver rear', 'passenger front', 'passenger rear'];
/* The lights by a side of the car (x across the cabin picture: the driver's side 0) and by a door. */
const sideOf = (l) => (l.x <= 0.15 ? 'driver' : l.x >= 0.85 ? 'passenger' : null);
const doorOf = (l) => {
    const n = String(l.name || '').toLowerCase(), side = /^driver/.test(n) ? 'driver' : /^passenger/.test(n) ? 'passenger' : null;
    if (!side || n.indexOf('door') < 0) return null;
    if (/ front door/.test(n) || / rear door/.test(n)) return side + (/ front door/.test(n) ? ' front' : ' rear');
    return side + (l.y < 0.5 ? ' front' : ' rear');        // the door's backlit decor: by where it sits
};
/* A door's line light. The turn glow and an open door's red blink only these (one write each a frame, ~2.4 blinks a
 * second on the car against ~0.8 with every light of a side); a car whose side or door has none blinks all of them. */
const isLine = (l) => / door line( 2)?$/i.test(String(l.name || ''));     // (2: a line's second strip)
const linesOf = (all, pick) => (l) => pick(l) && (isLine(l) || !all().some((x) => pick(x) && isLine(x)));

const copy = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
const valid = (l) => !!l && typeof l === 'object' && !!l.upper && Array.isArray(l.upper.rgb) && !!l.lower && Array.isArray(l.lower.rgb);

class Control {
    constructor(o) {
        this.settings = o.settings; this.lights = o.lights; this.ambient = o.ambient; this.log = o.log;
        this._mode = null; this._night = false; this._away = false; this._shown = null; this._flashAt = 0; this._poll = null;
        this._turn = null; this._doors = [];
    }

    look() { const l = this.settings.get('look'); return valid(l) ? copy(l) : copy(DEFAULT_LOOK); }
    on() { return !!this.settings.get('on'); }
    modeLook(m) { const l = this.settings.get('mode_' + m); return valid(l) ? copy(l) : null; }
    modeOriginal(m) { return this.settings.get('mode_' + m) === 'original'; }
    favs() { const f = this.settings.get('favs'); return Array.isArray(f) ? f.filter(valid).slice(0, FAVS) : []; }

    /** The look on now (null: the car's colour), and why: 'mode' or 'own'. */
    target() {
        if (this._away) return { look: null, why: 'away' };
        const follow = this.settings.get('follow') !== false && this._mode;
        if (follow && this.modeOriginal(this._mode)) return { look: null, why: 'mode' };
        const m = follow ? this.modeLook(this._mode) : null;
        if (m) return { look: m, why: 'mode' };
        return this.on() ? { look: this.look(), why: 'own' } : { look: null, why: 'car' };
    }

    start() {
        if (this.settings.get('keep') === false) this.settings.set('on', false);
        this._mode = this.ambient ? this.ambient.mode() : null;
        const t = this.target();
        if (this.settings.get('welcome') && t.look) this._show(Object.assign(copy(t.look), { kind: 'welcome', then: t.look }));
        else this.apply();
        if (this.ambient) this.ambient.on('change', () => this.mode(this.ambient.mode()));
        this._poll = setInterval(() => this._flashFile(), 300);
    }

    stop() { clearInterval(this._poll); }

    /** The driving mode changed. */
    mode(m) {
        if (m === this._mode) return;
        const was = this._mode;
        this._mode = m;
        const t = this.target();
        if (m === 'sport' && was && was !== 'sport' && this.settings.get('sportPulse')) {
            this._show(Object.assign(copy(t.look || this.look()), { kind: 'pulse', then: t.look }));
            return;
        }
        this.apply();
    }

    /** The car locked and left (true), or someone back in (false). */
    away(on) {
        on = !!on;
        if (on === this._away) return;
        this._away = on;
        this.log.info('ambient: ' + (on ? 'the car is parked: the car\'s own light' : 'someone is in the car: our colour again'));
        this.signals();
        const t = this.target();
        if (!on && this.settings.get('welcome') && t.look) this._show(Object.assign(copy(t.look), { kind: 'welcome', then: t.look }));
        else this.apply();
    }

    /** The turn signals: 'left', 'right', 'both' (hazards) or null. */
    turn(side) { this._turn = side || null; this.signals(); }
    /** The doors open: some of DOORS. */
    doors(open) { this._doors = (open || []).filter((d) => DOORS.indexOf(d) >= 0); this.signals(); }
    /** The turn signal's glow, the hazards' red pulse and the open doors' red, as the settings and the car say now. */
    signals() {
        const rhd = this.settings.get('drive') === 'rhd', side = (s) => (s === 'left') !== rhd ? 'driver' : 'passenger';
        const hazard = this.settings.get('hazardRed') === true && !this._away && this._turn === 'both';
        if (hazard !== this._hazard) {
            this._hazard = hazard;
            this.lights.overlay('hazard', hazard ? () => true : null, pulse(RED));
        }
        const turn = this.settings.get('turnGlow') === true && !this._away && !hazard ? this._turn : null;
        const sides = turn === 'both' ? ['driver', 'passenger'] : turn ? [side(turn)] : [];
        const all = () => this.lights.lights || [];
        const key = sides.join();
        if (key !== this._glow) {
            this._glow = key;
            this.lights.overlay('turn', sides.length ? linesOf(all, (l) => sides.indexOf(sideOf(l)) >= 0) : null, blink(GLOW));
        }
        const doors = this.settings.get('doorRed') === true && !this._away ? this._doors : [];
        if (doors.join() !== this._red) {
            this._red = doors.join();
            this.lights.overlay('doors', doors.length ? linesOf(all, (l) => doors.indexOf(doorOf(l)) >= 0) : null, blink(RED));
        }
    }

    night(on) { this._night = !!on; this.lights.dim(on && this.settings.get('nightDim') !== false ? NIGHT : 1); }

    apply() {
        const t = this.target();
        if (t.look) this._show(t.look); else { this._shown = null; this.lights.carColour(); }
    }

    _show(scene) {
        const key = JSON.stringify(scene);
        if (key === this._shown && this.lights.scene) return;
        this._shown = key;
        this.lights.show(scene);
    }

    /** By hand: change the driver's look (a part of it) and put it on. */
    setLook(patch) {
        const l = Object.assign(this.look(), copy(patch));
        this.settings.set('look', l);
        this.settings.set('on', true);
        this.apply();
        return l;
    }

    carColour() { this.settings.set('on', false); this.apply(); }

    /** A driving mode's look; 'original': BMW's original colour; null: nothing picked. */
    setModeLook(m, look) { this.settings.set('mode_' + m, look === 'original' ? look : look ? copy(look) : null); this.apply(); }

    /** Saves the look in the first free place (all six taken: instead of the oldest). */
    saveFav() {
        const f = this.favs();
        f.push(this.look());
        while (f.length > FAVS) f.shift();
        this.settings.set('favs', f);
        return f.length - 1;
    }
    useFav(i) { const f = this.favs()[i]; if (f) this.setLook(f); }
    dropFav(i) { const f = this.favs(); f.splice(i, 1); this.settings.set('favs', f); }

    _flashFile() {
        let st;
        try { st = fs.statSync(FLASH_FILE); } catch (e) { return; }
        if (st.mtimeMs <= this._flashAt) return;
        const first = !this._flashAt;
        this._flashAt = st.mtimeMs;
        if (first && Date.now() - st.mtimeMs > 2000) return;       // one left from before
        if (this.settings.get('flashAlerts') === false) return;
        try {
            const f = JSON.parse(fs.readFileSync(FLASH_FILE, 'utf8'));
            if (Array.isArray(f.rgb) && f.rgb.length === 3) this.lights.flash(f.rgb, Math.max(1000, Math.min(3000, Number(f.ms) || 1200)));
        } catch (e) { /* half-written: the next write */ }
    }
}

module.exports = { Control, DEFAULT_LOOK, FLASH_FILE, FAVS, NIGHT, DOORS, GLOW, RED, sideOf, doorOf };
