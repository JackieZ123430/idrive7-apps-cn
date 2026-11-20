'use strict';
/**
 * ambient.js - the ambient light's colour: set by hand, or by the driving mode.
 *
 * The ambient light has the colours of BMW's own menu, numbered slots (FARBAUSWAHL_1..12 on the bus; which
 * colour a number is depends on the car). ComfortFunctionIuK.statusAmbientLightInteriorColour says which one is
 * on; ambientLightInteriorColour sets one. A set names only the slot and leaves every other field "not filled",
 * so brightness and the light's other modes stay as they are.
 *
 * The car's driving modes, each with its variants: Sport (Sport, Sport Plus, Sport Individual, XtraBoost), then on
 * petrol and diesel cars Comfort and Eco Pro, on plug-in hybrids Hybrid (with Hybrid Eco Pro) and Electric, and
 * Adaptive. A plug-in hybrid is known from the first PHEV mode the car reports (setting carKind, kept). Each mode
 * value the car sends is logged once.
 * Driving mode (FES statusFESVehicleDynamicSwitchHMI): when it changes to a mode with a colour set, that colour;
 * to one set to "Leave as is", the driver's own colour back (setting "restore"). The driver's own colour is the
 * last one not set by this app's driving modes: one chosen in BMW's menu or by hand here. One write at a time, at
 * most one each 1.5 s, and only a colour the car does not show already.
 *
 *   const a = new Ambient({ settings, signals, log });
 *   await a.start();
 *   a.slot() -> 1..12 | null        a.mode() -> one of MODES, or null        a.modes() -> this car's
 *   a.own() -> the driver's own colour | null       a.setSlot(n) by hand       a.on('change', fn)
 */
const EventEmitter = require('events');

const LIGHT = 'de.bmw.infotainment.misc.ComfortFunctionIuK';
const FES = 'de.bmw.infotainment.drivingexcitement.FES';
const SLOTS = 12;
const MIN_GAP_MS = 1500;
const MODES = ['sport', 'comfort', 'hybrid', 'electric', 'eco', 'adaptive'];
const KIND_MODES = { ice: ['sport', 'comfort', 'eco', 'adaptive'], hybrid: ['sport', 'hybrid', 'electric', 'adaptive'] };
const UNFILLED = 'SIGNAL_UNBEFUELLT';

// actualValueModeDrivingExperience's names and wire numbers
const BY_NAME = {
    SPORT_DYNAMIC: 1, SPORT_EXPERT: 2, SPORT_INDIVIDUAL: 3, COMFORT: 4, COMFORT_PLUS: 5, COMFORT_INDIVIDUAL: 6,
    ECO_PRO_EFFICIENT: 7, ECO_PRO_PLUS: 8, ECO_PRO_INDIVIDUAL: 9, ADAPTIVE: 10, PHEV_SPORT_STANDARD: 15, PHEV_SPORT_INDIVIDUAL: 16,
    PHEV_HYBRID_STANDARD: 17, PHEV_HYBRID_ECO: 18, PHEV_HYBRID_COMFORT: 19, PHEV_ELECTRIC_STANDARD: 20, PHEV_ELECTRIC_INDIVIDUAL: 21,
    PHEV_SPORT_PLUS: 23, BOOST: 28,
};
const BY_NUMBER = { 1: 'sport', 2: 'sport', 3: 'sport', 4: 'comfort', 5: 'comfort', 6: 'comfort', 7: 'eco', 8: 'eco', 9: 'eco', 10: 'adaptive',
    15: 'sport', 16: 'sport', 23: 'sport', 28: 'sport', 17: 'hybrid', 18: 'hybrid', 19: 'hybrid', 20: 'electric', 21: 'electric' };
const PHEV = [15, 16, 17, 18, 19, 20, 21, 22, 23];

/* actualValueModeDrivingExperience: a name or its wire number -> { mode (one of MODES or null), phev }, or null. */
function modeOf(raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    const n = typeof raw === 'number' || /^\d+$/.test(String(raw)) ? Number(raw) : BY_NAME[String(raw).toUpperCase()];
    // a name not in the table (another software level): by its words
    if (n === undefined) {
        const w = String(raw).toUpperCase();
        const mode = /ADAPTIV/.test(w) ? 'adaptive' : /ELECTRIC|ELEKTR/.test(w) ? 'electric' : /HYBRID/.test(w) ? 'hybrid' : /SPORT|BOOST/.test(w) ? 'sport'
            : /COMFORT/.test(w) ? 'comfort' : /ECO/.test(w) ? 'eco' : null;
        return mode ? { mode, phev: /PHEV|HYBRID|ELECTRIC/.test(w) } : null;
    }
    return { mode: BY_NUMBER[n] || null, phev: PHEV.indexOf(n) >= 0 };
}

/* statusMenuAmbientePanoramicRoofInteriorLighting: FARBAUSWAHL_n or n -> n (1..SLOTS), or null. */
function slotOf(raw) {
    const m = /^FARBAUSWAHL_(\d+)$/.exec(String(raw));
    const n = m ? Number(m[1]) : Number(raw);
    return Number.isInteger(n) && n >= 1 && n <= SLOTS ? n : null;
}

/* The ambientLightInteriorColour struct that sets slot n and nothing else. */
function request(n) {
    return {
        controlMenuAmbientePanoramicRoofInteriorLighting: 'FARBAUSWAHL_' + n,
        controlModeAmbientePanoramicRoofInteriorLighting: UNFILLED,
        controlDynamicInteriorLighting: UNFILLED,
        controlDynamicAmbienteInteriorLighting: UNFILLED,
        controlHueInteriorLighting: 4095,
        controlHueValueLayer1IndividualGroup: 255,
        controlHueValueLayer2IndividualGroup: 255,
        controlHueValueLayer3IndividualGroup: 255,
        controlBrightnessValueBrightnessOffsetAmbientePanoramicRoofInteriorLighting: 255,
    };
}

class Ambient extends EventEmitter {
    constructor(o) {
        super();
        this.settings = o.settings;
        this.signals = o.signals;
        this.log = o.log;
        this.now = o.now || Date.now;
        this._slot = null;
        this._mode = null;
        this._own = null;
        this._ours = null;         // the slot this app's driving modes last set, until the car shows another
        this._proxy = null;
        this._busy = false;
        this._want = null;         // { n, why } waiting for the write before it or the gap
        this._last = -Infinity;
        this._timer = null;
        this.error = null;
        this.available = false;
    }

    slot() { return this._slot; }
    modes() { return KIND_MODES[this.settings.get('carKind') === 'hybrid' ? 'hybrid' : 'ice']; }
    mode() { return this._mode; }
    own() { return this._own; }

    async start() {
        const light = await this.signals.watch(LIGHT, '1', { statusAmbientLightInteriorColour: (v) => this.colour(v) }, this.log);
        this._proxy = light.proxy;
        this.available = !!light.proxy;
        if (light.error) { this.error = light.error; this.log.warn('ambient light: ' + light.error); }
        const fes = await this.signals.watch(FES, '1', { statusFESVehicleDynamicSwitchHMI: (v) => this.drive(v) }, this.log);
        if (fes.error) this.log.warn('driving mode: ' + fes.error);
        this.emit('change');
    }

    /* A status of the ambient light. */
    colour(v) {
        const n = slotOf(v && v.statusMenuAmbientePanoramicRoofInteriorLighting);
        if (n === null || n === this._slot) return;
        this._slot = n;
        if (n !== this._ours) {
            if (this._own !== n) this.log.info('ambient: colour ' + n + ' (the driver\'s own)');
            this._own = n;
            this._ours = null;
        }
        this.emit('change');
    }

    /* A status of the driving mode. */
    drive(v) {
        const raw = v && v.actualValueModeDrivingExperience;
        this._seen = this._seen || [];
        if (this._seen.length < 20 && this._seen.indexOf(String(raw)) < 0) { this._seen.push(String(raw)); this.log.info('ambient: the car sends driving mode ' + raw); }
        const got = modeOf(raw);
        if (!got) return;
        if (got.phev && this.settings.get('carKind') !== 'hybrid') {
            this.log.info('ambient: a plug-in hybrid\'s driving modes');
            this.settings.set('carKind', 'hybrid');
        }
        const m = got.mode;
        if (m === null || m === this._mode) return;
        this._mode = m;
        this.log.info('ambient: driving mode ' + m);
        this.follow();
        this.emit('change');
    }

    /* The colour the driving mode asks for, or the driver's own back; nothing while not following, or while any colour
     * is possible (slotsOff: the driving modes have looks of their own then, main.js). */
    follow() {
        if (this.slotsOff || !this.settings.get('follow') || !this._mode) return;
        const n = Number(this.settings.get(this._mode)) || 0;
        if (n >= 1 && n <= SLOTS) this._write(n, 'mode');
        else if (this.settings.get('restore') !== false && this._ours !== null && this._own !== null) this._write(this._own, 'own');
    }

    /* By hand: the driver's own colour from now. */
    setSlot(n) {
        if (!(n >= 1 && n <= SLOTS)) return;
        this._own = n;
        this._ours = null;
        this._write(n, 'hand');
    }

    _write(n, why) {
        this._want = { n, why };
        this._next();
    }

    _next() {
        if (this._busy || !this._want) return;
        const wait = this._last + MIN_GAP_MS - this.now();
        if (wait > 0) {
            if (!this._timer) this._timer = setTimeout(() => { this._timer = null; this._next(); }, wait);
            return;
        }
        const { n, why } = this._want;
        this._want = null;
        if (why === 'mode') this._ours = n;
        else if (why === 'own') this._ours = null;
        if (n === this._slot) return;
        if (!this._proxy) { this.log.warn('ambient: colour ' + n + ' not set: the car\'s ambient light does not answer'); return; }
        this._busy = true;
        this._last = this.now();
        this.log.info('ambient: setting colour ' + n + ' (' + ({ mode: 'driving mode ' + this._mode, own: 'the driver\'s own back', hand: 'by hand' })[why] + ')');
        Promise.resolve().then(() => this.signals.set(this._proxy, 'ambientLightInteriorColour', request(n)))
            .then(() => { this.error = null; }, (e) => { this.error = String(e && e.message || e); this.log.warn('ambient: setting colour ' + n + ': ' + this.error); })
            .then(() => { this._busy = false; this.emit('change'); this._next(); });
    }

    stop() { clearTimeout(this._timer); this._timer = null; }
}

module.exports = { Ambient, modeOf, slotOf, request, MODES, KIND_MODES, SLOTS, MIN_GAP_MS };
