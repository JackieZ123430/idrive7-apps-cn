'use strict';
/**
 * Part of Redline's experimental features; README.md in this folder has the whole picture
 * (settings, learning, files, logs, rules for this code).
 *
 * Redline on the head-up display, through cluster-render (robertnisipeanu/idrive-apps,
 * native/cluster-render): one image layer on its 'hud' target, an 800x480 scene the KOMBI
 * lays over BMW's own HUD content (speed, limit sign, guidance stay in their own slots).
 *
 *   - What the glass shows (G21, 2026-11-07 test pattern): about x 120..680, y 120..360 of the
 *     scene, BMW's speed and limit sign along its bottom from y ~325. The tach is a 400x130
 *     image centred at y 150 (a 520 px sample was far too big on the glass); "HUD size" scales
 *     it about its top centre, "HUD position" moves it. Both only move the layer, so they show
 *     at once.
 *   - Dark pixels are see-through on the HUD glass: drawn on alpha 0, lit parts at full
 *     brightness; unlit segments optionally faint ("dim").
 *   - cluster-render gives way to BMW's HUD pop-ups by itself; this module logs the target's
 *     state, including 'disabled' from its mapping guard.
 *   - Only the changed rectangle of each frame is sent (the bar moving is a narrow strip), at
 *     most 10 a second, nothing when the frame is the same.
 *   - Never throws: an uncaught error exits the app, MainApp's CorruptAppsHandler wipes an
 *     app's data on its first crash and uninstalls it on the second.
 *
 *   - Directions (setting "hudNav", hud-nav.js, nav.js): while a route runs, the next turn as a second picture
 *     (200x76) in the bottom right corner of the glass. With a route but no turn it can read, Redline steps aside so BMW's
 *     own card shows (the KOMBI hides it behind Redline).
 *   - The tyre widget (settings "hudTyreWidget" ..., hud-tyres.js, tyres.js): the four tyres in the same corner, the same
 *     layer, when the directions have nothing to show (while a tyre is low, by default).
 *
 * Settings: hud (off | on | test); groups "HUD style" (layout, colours, lights, grade, peak, shake,
 * unlit), "HUD readouts" (gear, boost, each temperature, the cold limit, smart temperatures, units),
 * "HUD position and size"; hudLead (also the screen's lights). README.md lists them.
 */
const fs = require('fs');
const path = require('path');
const { Canvas, withAlpha } = require('./kit/canvas');
// the drawing: layouts, palettes, readouts (hud-draw.js); this file decides what to show and when
const Draw = require('./hud-draw');
// Redline's own directions (the next turn, its distance, the street, the lanes), a picture in the bottom right corner
const HudNav = require('./hud-nav');
const TyresMod = require('./tyres');
const Fuel = require('./fuel');
const HudTyres = require('./hud-tyres');
const { HudClaim } = require('./kit/hud_claim');
// files written whole or not at all (the learned reaction lead)
const { writeAtomic } = require('./files');
const { drawHud, drawDown, gearText } = Draw;
let ClusterRender = null;
try { ClusterRender = require('./cluster_render_client').ClusterRender; } catch (e) { /* logged at start */ }

// the tach image (400x130); where it sits at 100 % is the scene's (SCENE below)
const IW = 400, IH = 130;
// frames a second: setting "hudFps" (10 / 20 / 30); the layer is made for the most, the timer paces it
const FPS_MAX = 30, FPS_DEFAULT = 20;
const READOUT_MS = 250;          // the readouts row is refreshed at most this often
const START_LOOK_MS = 30000;     // after a head-unit start: how long the standing HUD app is looked for
// the flash's on / off rhythm in ms (5 Hz), from the clock, so it looks the same at any frame rate
const BLINK_MS = 100;
// the redline shake: offsets (px) stepped every 100 ms while on the limiter. Each step moves the whole
// picture, so the whole frame goes out (~2 MB/s at 10 steps a second): off by default
const SHAKE = [[2, 1], [-2, -1], [1, -1], [-1, 1], [2, -1], [-2, 1]];
const WHITE = '#ffffff', YELLOW = '#ffc21a';
const CYAN = '#22e0ff', MAGENTA = '#ff3df0';
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const isNum = (x) => typeof x === 'number' && isFinite(x);

/** Canvas.d is a Uint8Array; the client copies from a Buffer (px.copy). Same memory, no copy. */
const asBuffer = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.length);

/**
 * Shift cue: when the shift lights start counting and when they flash, from how fast the revs
 * climb. st = state kept between frames ({}); returns { from, at, shift, limiter, rate, fallSince }:
 *   at     = the rpm the lights flash at: the shift point minus what the revs climb in the
 *            driver's reaction time (leadMs), at most 800 rpm early;
 *   from   = where the count starts: ~1 s of climb before 'at' (800..2000 rpm), so the count-in
 *            takes about as long in every gear. The span and the lead are taken while the revs
 *            climb and kept when they stop (a lift, a steady hold), so the lights then follow the
 *            revs down one step at a time instead of jumping; back to 1500 / no lead once the
 *            count is empty. Never climbed: 1500 and no lead;
 *   shift  = flashing now. Held at the point it fired at, so a noisy climb rate doesn't make it
 *            flicker; it ends on a gear change (the upshift), when the revs fall 12 % under the
 *            highest they reached while flashing (an upshift without a gear signal) or have been
 *            falling for 300 ms (a lift; a traction dip is shorter);
 *   limiter= on the limiter (within 40 of the redline): everything flashes; shift points are
 *            held 150 under it, so a shift on the point never looks like the limiter;
 *   fallSince = since when the revs have been falling (ms), or null.
 * Rate: smoothed rpm per second from successive samples, rises only (a lift or a shift resets it).
 * rpmShow (optional): the rpm drawn, between samples moved on along the climb (the HUD smooths it);
 * the count, the flash and the limiter go by it, the climb rate only by the real samples (rpm).
 */
function shiftCue(st, rpm, tMs, shift, redline, leadMs, gear, rpmShow, revFrom) {
    if (!isNum(rpm)) { st.rate = 0; st.on = false; st.fall = null; return { from: shift - 1500, at: shift, shift: false, limiter: false, rate: 0, fallSince: null }; }
    // Shift lights as a plain rev bar (setting lightMode "rev", issue #133): an even count from revFrom to the
    // redline, the flash at the redline; no lead, no climb rate, nothing learned
    if (isNum(revFrom)) {
        st.on = false; st.fall = null; st.rate = 0;
        const r = isNum(rpmShow) ? rpmShow : rpm, from = clamp(revFrom, 0, redline - 500);
        return { from: from, at: redline, shift: r >= redline, limiter: rpm >= redline - 40, rate: 0, fallSince: null };
    }
    let rising = false;
    // the same reading again (a frame drawn between two rpm samples) is no news: the rate is only
    // updated on a new sample, measured over the time since the last one; a reading unchanged for
    // 500 ms is a real standstill of the revs
    const fresh = !isNum(st.rpm) || rpm !== st.rpm || tMs - st.t >= 500;
    if (isNum(st.rpm) && tMs > st.t && fresh) {
        const r = (rpm - st.rpm) * 1000 / (tMs - st.t);
        rising = r > 300;
        st.rate = r <= 0 ? (r < -500 ? 0 : (st.rate || 0) * 0.7) : (st.rate ? st.rate * 0.5 + r * 0.5 : r);
        // falling: more than 150 rpm/s down, sample after sample
        if (r < -150) { if (st.fall == null) st.fall = st.t; } else st.fall = null;
    }
    if (fresh) { st.rpm = rpm; st.t = tMs; }
    const rate = st.rate || 0, climbing = rate > 300;
    // span and lead from frames where the revs really rose: the smoothed rate decays over a hold
    // or a lift, and following it would shrink the count while the rpm stands still
    if (climbing && rising) { st.span = clamp(rate * 1.0, 800, 2000); st.lead = Math.min(800, rate * leadMs / 1000); }
    const at = shift - (st.lead || 0);
    const from = at - (st.span || 1500);
    const r = isNum(rpmShow) ? rpmShow : rpm;
    if (!climbing && r <= from) { st.span = 0; st.lead = 0; }          // count empty: back to the plain span
    // latch: the flash point is held from the moment it fires
    const lifted = st.fall != null && tMs - st.fall >= 300;
    // a new gear (the upshift itself) ends the flash and starts the next gear's count afresh: in the
    // upper gears an upshift drops the revs only ~20 %, then they climb again at once, so neither
    // the drop nor a lift would end it
    const changed = typeof gear === 'number' && typeof st.gear === 'number' && gear !== st.gear;
    if (typeof gear === 'number') st.gear = gear;
    if (changed) { st.on = false; st.span = 0; st.lead = 0; }
    // without a gear signal: the revs 12 % under the highest they reached while flashing (an upshift
    // drops 18 % or more on an 8-speed, from wherever it was made; a traction dip less)
    // the drop and the limiter go by the real rpm: the drawn one runs ahead along the climb
    if (!st.on && r >= at && !lifted && !changed) { st.on = true; st.at = at; st.peak = rpm; }
    else if (st.on) {
        st.peak = Math.max(st.peak || rpm, rpm);
        if (rpm < st.peak * 0.88 || lifted) st.on = false;
    }
    return { from: from, at: st.on ? st.at : at, shift: st.on, limiter: rpm >= redline - 40, rate: rate, fallSince: st.fall == null ? null : st.fall };
}

const numOf = (settings, k, d) => { const v = Number(settings.get(k)); return isFinite(v) ? v : d; };
/** Setting lightMode "rev": the rpm the plain rev bar starts at (setting lightStart), else null (the shift count). */
const revOf = (settings) => (settings.get('lightMode') === 'rev' ? numOf(settings, 'lightStart', 4000) : null);

/**
 * The driver's reaction time from one hand upshift: flash = { rate (rpm/s), target (rpm), lead (ms asked
 * for) }, rpm: where the shift came. The flash came at most 800 rpm early (shiftCue caps the lead), so on a
 * fast climb it had less lead than asked for: the reaction is the lead it really had plus how late the shift
 * was (0..600 ms).
 */
function reactionMs(flash, rpm) {
    const effLead = Math.min(flash.lead, 800 / flash.rate * 1000);
    return clamp(effLead + (rpm - flash.target) / flash.rate * 1000, 0, 600);
}

/** Where the tach image shows in the HUD's scene (SCENE), from the size and position settings. */
function placeOf(settings) {
    // (smaller, further right and further down since 2.0.27: a small tach in the glass's bottom right corner)
    // 100 % is the scene's own size for the tach (iDrive 8's small HUD: as wide as it), never more than all of it
    const k = Math.min(clamp(numOf(settings, 'hudSize', 100), 40, 140) / 100 * SCENE.fit, SCENE.w / IW, SCENE.h / IH);
    const w = Math.round(IW * k), h = Math.round(IH * k);
    const x = Math.round((SCENE.w - IW) / 2) + Math.round((IW - w) / 2) + clamp(numOf(settings, 'hudX', 0), -120, 280);
    const y = SCENE.baseY + clamp(numOf(settings, 'hudY', 0), -120, 220);
    return { x: clamp(x, 0, SCENE.w - w), y: clamp(y, 0, SCENE.h - h), w: w, h: h };
}

/*
 * Where the directions go: the bottom right corner of the glass (the test pattern's 120 px frame, x 120..680,
 * y 120..360, seen whole on a G21), right of BMW's limit sign and speed at the bottom left; "hudNavX" / "hudNavY"
 * move them (px). Their own size: they don't scale or move with the tach.
 */
const NAV_RIGHT = 672, NAV_BOTTOM = 356, NAV_GAP = 4;
// what the directions must never cover or sit under: BMW's limit sign and speed along the glass's bottom left
// (2026-11-09 photos of the G21's test pattern: x ~120..340, y ~322..366), besides the tach itself
const BMW_SPEED = { x: 116, y: 320, w: 236, h: 48 };
// the glass the driver sees whole (the test pattern's 120 px frame on the G21)
const GLASS = { x: 120, y: 120, w: 560, h: 240 };
/** The part of the HUD's 800x480 scene seen through the windshield, measured from car photos by bimmer-lab
 * (github.com/bimmer-lab/apps shared/visible.js, MIT, 2026-11-05; it moves with the driver's eye height). */
const HUD_WINDOW = { x: 120, y: 100, w: 485, h: 278 };
/*
 * The HUD's scene: iDrive 7's 800x480, of which only part is seen (above), or the size cluster-render names
 * in its hello (iDrive 8: "hud:353x203", all of it shown, above the HUD's own speed bar: no BMW speed in it).
 * baseY: the tach's top at 100 % and Position 0; fit: its size at 100 %.
 */
const ID7_SCENE = { w: 800, h: 480, fit: 1, baseY: 140, window: HUD_WINDOW, glass: GLASS, speed: BMW_SPEED, navRight: NAV_RIGHT, navBottom: NAV_BOTTOM };
let SCENE = ID7_SCENE;
function sceneOf(targets) {
    const m = /(?:^|,)\s*hud:(\d+)x(\d+)/.exec(String(targets || ''));
    const w = m ? Number(m[1]) : 800, h = m ? Number(m[2]) : 480;
    if (w === 800 && h === 480 || w < 40 || h < 20) return ID7_SCENE;
    const fit = Math.min(1, w / IW, h / IH), all = { x: 0, y: 0, w: w, h: h };
    return { w: w, h: h, fit: fit, baseY: Math.round((h - Math.round(IH * fit)) / 2), window: all, glass: all,
        speed: { x: 0, y: 0, w: 0, h: 0 }, navRight: w - NAV_GAP, navBottom: h - NAV_GAP };
}
/** Use the scene cluster-render's hello names (its targets string); true when it changed. */
function useScene(targets) {
    const next = sceneOf(targets), changed = next.w !== SCENE.w || next.h !== SCENE.h;
    SCENE = next;
    return changed;
}
const overlapOf = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
/**
 * Where the directions go: the glass's bottom right corner ("hudNavX" / "hudNavY" move it), but never over or
 * under the tach (its rev bar, gear, readouts, grade and arrows are all inside placeOf's rectangle) or BMW's speed.
 * When the tach's Size / Position reach the corner, the next place that's clear is taken: under the tach, right
 * of it, left of it, above it; on the glass first. With nowhere clear, the place that covers least.
 */
function navPlaceOf(settings) {
    const w = HudNav.NW, h = HudNav.NH, t = placeOf(settings);
    const dx = clamp(Number(settings.get('hudNavX')) || 0, -400, 100), dy = clamp(Number(settings.get('hudNavY')) || 0, -200, 100);
    const at = (x, y) => ({ x: clamp(Math.round(x), 0, SCENE.w - w), y: clamp(Math.round(y), 0, SCENE.h - h), w: w, h: h });
    const corner = at(SCENE.navRight - w + dx, SCENE.navBottom - h + dy);
    const tries = [corner,
        at(corner.x, t.y + t.h + NAV_GAP),                  // under the tach
        at(t.x + t.w + NAV_GAP, corner.y),                  // right of it
        at(t.x - w - NAV_GAP, corner.y),                    // left of it
        at(corner.x, t.y - h - NAV_GAP)];                   // above it
    // covering anything weighs far more than reaching past the glass's edge (px outside it, summed per side)
    const G = SCENE.glass;
    const outside = (r) => Math.max(G.x - r.x, 0) + Math.max(r.x + r.w - G.x - G.w, 0) + Math.max(G.y - r.y, 0) + Math.max(r.y + r.h - G.y - G.h, 0);
    const cost = (r) => (overlapOf(r, t) + overlapOf(r, SCENE.speed)) * 1000 + outside(r);
    let best = tries[0];
    tries.forEach((r) => { if (cost(r) < cost(best)) best = r; });
    return best;
}
/** "hudNav": off / route (while a route runs, the default) / near (under 1 km, and lanes). */
function navModeOf(settings) { const m = settings.get('hudNav'); return m === 'off' || m === 'near' ? m : 'route'; }

/**
 * How far a place (placeOf) reaches outside the part of the scene seen (SCENE.window), in px per side ({} when it is all visible). style: Minimal
 * draws nothing in the picture's top MINIMAL_TOP px (its lights from 26, the D / S / M letter by the gear from
 * about 10), so only what's under them counts at the top.
 */
const MINIMAL_TOP = 9;
function outsideGlass(r, style) {
    if (style === 'minimal') { const d = Math.round(MINIMAL_TOP * r.h / IH); r = { x: r.x, y: r.y + d, w: r.w, h: r.h - d }; }
    const W = SCENE.window, o = {};
    if (r.x < W.x) o.left = W.x - r.x;
    if (r.x + r.w > W.x + W.w) o.right = r.x + r.w - (W.x + W.w);
    if (r.y < W.y) o.top = W.y - r.y;
    if (r.y + r.h > W.y + W.h) o.bottom = r.y + r.h - (W.y + W.h);
    return o;
}

/** The gear's font family for the setting "hudGearFont" (auto / ubuntu / barlow) on a layout. */
const M_STYLES = ['arc', 'ramp', 'dial'];
function gearFontOf(choice, style) {
    if (choice === 'barlow') return 'gear_barlow';
    if (choice === 'ubuntu') return 'gear';
    return style === 'ramp' ? 'square' : M_STYLES.indexOf(style) >= 0 ? 'gear_barlow' : 'gear';
}

const STYLES = ['standard', 'minimal', 'wings', 'digital', 'vfd', 'vector', 'arc', 'ramp', 'dial', 'pill'];
/*
 * The HUD's two setups ("profiles"): Sport, the HUD settings themselves (Sport / Sport+, and a mode not known),
 * and Comfort (Comfort / Eco Pro), which "hudComfortMode" makes the same as Sport, its own ("hudComfortSetup":
 * { key: value } over Sport's) or hidden (BMW's own HUD). The keys a profile has are PROFILE_KEYS; the rest is
 * the same in both: place and size, units, the light colours and the downshift arrows (the
 * centre screen uses those too).
 */
const PROFILE_KEYS = ['hudStyle', 'hudPalette', 'hudGearFont', 'hudLabels', 'hudRpmFormat', 'hudUnlit', 'hudLightStyle',
    'hudShowBar', 'hudShowGear', 'hudShowMode', 'hudShowSpeed', 'hudShowRpm', 'hudBoost', 'hudShowTorque', 'hudShowPower', 'hudShowG', 'hudShowKnock',
    'hudShowOil', 'hudShowWater', 'hudShowGearbox', 'hudShowOutside', 'hudShowLimit', 'hudTempsMode',
    'hudShowTyres', 'hudShowFuel', 'hudShowBattSoc', 'hudShowBattVolt', 'hudShowHvSoc', 'hudShowHvPower', 'hudShowHvBar', 'hudShowHvTemp', 'hudShowHvVolt',
    'hudChip', 'hudKnockWarn', 'hudLaunch', 'hudPeak', 'hudShake',
    // size and place: a setup of its own can sit elsewhere (2026-11-10: a small one in a corner for Comfort)
    'hudSize', 'hudX', 'hudY'];
/*
 * The setups besides Sport: Comfort (Comfort / Eco Pro, Adaptive) and, on a car known to be a plug-in hybrid
 * (hudHybridSeen), Hybrid (its Hybrid, Electric and battery modes; 2026-11-10: a hybrid's everyday mode, where its
 * power bar matters most, so it follows Sport by default where Comfort is hidden). Each: its mode setting ('same' as
 * Sport, 'own' or 'hide') and its own values over Sport's.
 */
const SETUPS = { comfort: { mode: 'hudComfortMode', setup: 'hudComfortSetup' }, hybrid: { mode: 'hudHybridMode', setup: 'hudHybridSetup' } };
/**
 * The profile a driving mode uses ('sport', 'comfort' or 'hybrid'): drive is 'sport', 'comfort', 'eco', 'hybrid' or
 * null. A hybrid mode is Comfort's until the car is known to be a hybrid (settings: hudHybridSeen).
 */
function profileOf(drive, settings) {
    if (drive === 'hybrid') return settings && settings.get('hudHybridSeen') === true ? 'hybrid' : 'comfort';
    return drive === 'comfort' || drive === 'eco' ? 'comfort' : 'sport';
}
/** A setup's mode: 'same' (as Sport), 'own' or 'hide' (Sport: always 'same'). */
function setupMode(settings, which) {
    const S = SETUPS[which];
    if (!S) return 'same';
    const m = settings.get(S.mode);
    return m === 'own' || m === 'hide' ? m : 'same';
}
/** Comfort: 'same' (as Sport), 'own' or 'hide'. */
function comfortMode(settings) { return setupMode(settings, 'comfort'); }
/** Sport's values of the profile keys (a copy: Comfort's own starts from it). */
function profileSnapshot(settings) { const o = {}; PROFILE_KEYS.forEach((k) => { o[k] = settings.get(k); }); return o; }
/**
 * One profile as settings: get(k) reads it (Comfort's own values over Sport's), set(k, v) writes it. A change to
 * Comfort while it follows Sport (or is hidden) gives it its own setup first, a copy of Sport's: so on the HUD
 * looks page nothing needs unlocking before it can be changed.
 */
function profileView(settings, which) {
    const S = SETUPS[which], comfort = !!S;
    const store = () => { const v = S && settings.get(S.setup); return v && typeof v === 'object' ? v : {}; };
    // its own setup: while it is its own, and while hidden when it has one (so it shows as it will come back)
    const own = () => comfort && (setupMode(settings, which) === 'own' || (setupMode(settings, which) === 'hide' && Object.keys(store()).length > 0));
    return {
        profile: comfort ? which : 'sport',
        get(k) {
            if (own() && PROFILE_KEYS.indexOf(k) >= 0) { const st = store(); if (Object.prototype.hasOwnProperty.call(st, k)) return st[k]; }
            return settings.get(k);
        },
        set(k, v) {
            if (!comfort || PROFILE_KEYS.indexOf(k) < 0) return settings.set(k, v);
            const st = Object.assign(profileSnapshot(settings), own() ? store() : {});
            st[k] = v;
            settings.set(S.setup, st);
            if (!own()) settings.set(S.mode, 'own');
            return undefined;
        },
        item: (k) => (settings.item ? settings.item(k) : null),
    };
}
/** A setup (Comfort, Hybrid) made its own (or back): its setup starts as Sport's when it has none. */
function setSetupMode(settings, which, mode) {
    const S = SETUPS[which];
    if (!S) return;
    const st = settings.get(S.setup);
    if (mode === 'own' && !(st && typeof st === 'object' && Object.keys(st).length)) settings.set(S.setup, profileSnapshot(settings));
    settings.set(S.mode, mode);
}
function setComfortMode(settings, mode) { setSetupMode(settings, 'comfort', mode); }
/**
 * Once, from 1.14 / 1.15's "In Comfort / Eco Pro" (hudComfort: all, lights, hide): hide stays hidden; "shift lights
 * and gear only" becomes Comfort's own setup without readouts and alerts. Returns what it did, or null.
 */
function migrateProfiles(settings) {
    const v = settings.values || {};
    if (v._hudProfiles) return null;
    let did = 'none';
    if (v.hudComfort === 'hide') { settings.set('hudComfortMode', 'hide'); did = 'hide'; }
    else if (v.hudComfort === 'lights') {
        const st = profileSnapshot(settings);
        ['hudShowSpeed', 'hudShowRpm', 'hudBoost', 'hudShowTorque', 'hudShowPower', 'hudShowG', 'hudShowKnock', 'hudShowOil', 'hudShowWater',
            'hudShowGearbox', 'hudShowOutside', 'hudShowLimit', 'hudPeak', 'hudShake', 'hudLaunch'].forEach((k) => { st[k] = false; });
        st.hudChip = 'off';
        settings.set('hudComfortSetup', st);
        settings.set('hudComfortMode', 'own');
        did = 'lights';
    }
    settings.set('_hudProfiles', 1);
    return did;
}

/**
 * The HUD's drawing options from the settings (also used by the HUD looks page): settings, or a profile of them
 * (profileView); drive ('sport', 'comfort', 'eco' or none): that mode's profile.
 */
function optsFrom(settings, drive) {
    if (drive) settings = profileView(settings, profileOf(drive, settings));
    const lights = settings.get('hudLightStyle') || 'gt3', on = (k) => settings.get(k) !== false;
    const layout = settings.get('hudStyle');
    const style = STYLES.indexOf(layout) > 0 ? layout : 'standard';
    return {
        style: style,
        // the gear's font: Auto is Barlow on the BMW-M-inspired layouts (arc, ramp, dial), Ubuntu on the rest
        // (hud-draw falls back to Ubuntu if a font's atlas is missing)
        gearFont: gearFontOf(settings.get('hudGearFont'), style),
        palette: settings.get('hudPalette') || 'colour',
        // readouts, each on its own switch
        gear: on('hudShowGear'), rpm: on('hudShowRpm'), bar: on('hudShowBar'), boost: on('hudBoost'), limit: on('hudShowLimit'),
        oil: on('hudShowOil'), coolant: on('hudShowWater'), gearbox: on('hudShowGearbox'),
        // the extra readouts are off unless switched on
        torque: settings.get('hudShowTorque') === true, power: settings.get('hudShowPower') === true,
        // the speed: off by default (BMW's own HUD shows it); first in the list, so on Ramp it sits under the gear like the G80's
        speed: settings.get('hudShowSpeed') === true,
        // throttle: off until the accelerator pedal's scaling is checked on a car (readoutsFor keeps it)
        throttle: false, g: settings.get('hudShowG') === true,
        outside: settings.get('hudShowOutside') === true,
        // tyres: the condensed readout (off unless switched on) in the unit set (Units, or the TYRES tab); the big
        // tyre widget is the directions' corner's (hud-tyres.js widgetOf)
        tyres: settings.get('hudShowTyres') === true,
        tyreUnit: ['psi', 'kpa'].indexOf(settings.get('hudTyreUnit')) >= 0 ? settings.get('hudTyreUnit') : 'bar',
        // electrical, off unless switched on: the 12 V on every car; the hybrid ones only once the car has shown a
        // high-voltage battery (hudHybridSeen, electrical.js), so a petrol or diesel car never has them
        soc12: settings.get('hudShowBattSoc') === true, volt12: settings.get('hudShowBattVolt') === true,
        hvSoc: hybridOn(settings, 'hudShowHvSoc'), hvPower: hybridOn(settings, 'hudShowHvPower'), hvTemp: hybridOn(settings, 'hudShowHvTemp'),
        hvVolt: hybridOn(settings, 'hudShowHvVolt'),
        // the recovery / power bar (BMW's hybrid power meter): hybrids only, like the readouts above
        hvBar: hybridOn(settings, 'hudShowHvBar'),
        // fuel use from the engine unit (fuel.js), off unless switched on; l/100 km, mpg (UK / US) or km/l
        fuel: settings.get('hudShowFuel') === true,
        fuelUnit: ['mpguk', 'mpgus', 'kml'].indexOf(settings.get('hudFuelUnit')) >= 0 ? settings.get('hudFuelUnit') : 'l100',
        torqueUnit: ['lbft', 'kgm'].indexOf(settings.get('hudTorqueUnit')) >= 0 ? settings.get('hudTorqueUnit') : 'nm',
        powerUnit: ['kw', 'ps'].indexOf(settings.get('hudPowerUnit')) >= 0 ? settings.get('hudPowerUnit') : 'hp',
        smartTemps: settings.get('hudTempsMode') !== 'always',
        boostUnit: settings.get('hudBoostUnit') || 'bar', fahrenheit: settings.get('hudTempUnit') === 'f',
        rpmFormat: ['50', 'k'].indexOf(String(settings.get('hudRpmFormat'))) >= 0 ? String(settings.get('hudRpmFormat')) : '10',
        readoutMs: Math.round(1000 / clamp(Number(settings.get('hudReadoutRate')) || 4, 1, 30)),
        clearLabels: settings.get('hudLabels') === 'clear',
        peak: on('hudPeak'),
        chip: (() => { const c = settings.get('hudChip'); return c === false || c === 'off' ? 'off' : c === 'simple' ? 'simple' : 'burst'; })(),
        shake: settings.get('hudShake') === true,
        lights: lights !== 'off', gt3: lights === 'gt3', dim: settings.get('hudUnlit') === 'dim', rev: revOf(settings),
        lightStyle: settings.get('lights'), warmOil: numOf(settings, 'warmOil', 80),
        mode: on('hudShowMode'),
        // knock (the engine unit's ignition retard): the warning on by default, the readout off
        knock: settings.get('hudShowKnock') === true, knockWarn: settings.get('hudKnockWarn') !== false,
        // the launch time (0-100 km/h or 0-60 mph) and its difference to the best, after a standing start
        launch: settings.get('hudLaunch') !== false, mph: settings.get('speedUnit') === 'mph',
    };
}

/** A hybrid readout's switch: on only when switched on and the car has a high-voltage battery. */
function hybridOn(settings, key) { return settings.get('hudHybridSeen') === true && settings.get(key) === true; }
/** The electrical readouts that need UDS reads (electrical.js start()): { hv, v12 }. */
function electricalWants(o) { return { hv: !!(o.hvSoc || o.hvPower || o.hvBar), hvSoc: !!o.hvSoc, hvKw: !!(o.hvPower || o.hvBar), v12: !!o.volt12 }; }

/**
 * The car's driving mode (FES statusFESVehicleDynamicSwitchHMI.actualValueModeDrivingExperience, a
 * name or a number, as Live Data and Live Adjustments read it) -> 'sport', 'comfort', 'eco' or null.
 * Adaptive, initialising and anything unknown are null: the HUD then shows as set up.
 */
function driveModeOf(raw) {
    if (raw === undefined || raw === null) return null;
    // Adaptive counts as Comfort, a plug-in hybrid's Hybrid / Electric / battery modes as 'hybrid' (Comfort's
    // setup until the car is known to be a hybrid: profileOf); only Sport and XtraBoost are Sport. Wire numbers:
    // 10 Adaptive, 15/16/23 PHEV Sport, 17-22 PHEV Hybrid / Electric / battery control, 28 Boost
    const n = Number(raw);
    if (!isNaN(n) && String(raw).trim() !== '') {
        return (n >= 1 && n <= 3) || n === 15 || n === 16 || n === 23 || n === 28 ? 'sport'
            : n >= 17 && n <= 22 ? 'hybrid' : (n >= 4 && n <= 6) || n === 10 ? 'comfort' : n >= 7 && n <= 9 ? 'eco' : null;
    }
    const s = String(raw).toUpperCase();
    return /SPORT|BOOST/.test(s) ? 'sport' : /HYBRID|ELECTRIC|BATTERY/.test(s) ? 'hybrid' : /ADAPTIV/.test(s) ? 'comfort' : /ECO/.test(s) ? 'eco'
        : /COMFORT|TRAFFIC/.test(s) ? 'comfort' : null;
}
/**
 * What the HUD does in this driving mode (setting hudComfort): 'all', 'lights' (shift lights, rev
 * bar and gear only) or 'hide'. Sport and an unknown mode always 'all'.
 */
function calmFor(drive, mode) {
    if (drive !== 'comfort' && drive !== 'eco' && drive !== 'hybrid') return 'all';
    return mode === 'hide' ? 'hide' : 'all';
}
/** o (optsFrom) with only the shift lights, rev bar and gear left on (Comfort / Eco Pro on "lights"). */
function calmOpts(o) {
    return Object.assign({}, o, { rpm: false, boost: false, torque: false, power: false, throttle: false, g: false, limit: false,
        oil: false, coolant: false, gearbox: false, outside: false, tyres: false, fuel: false, soc12: false, volt12: false, hvSoc: false, hvPower: false, hvBar: false, hvTemp: false,
        hvVolt: false, chip: 'off', peak: false, shake: false });
}

const TEMPS = [['OIL', 'oil', { cold: 60, hot: 130, warmOil: true }], ['WATER', 'coolant', { cold: 60, hot: 112 }], ['GEARBOX', 'gearbox', { cold: 50, hot: 120 }]];
// boost in the unit chosen: bar (1 decimal), psi or kPa (whole numbers); temperatures in °C or °F
const BOOST_UNITS = { bar: [1, 1, 'BOOST'], psi: [14.5038, 0, 'BOOST PSI'], kpa: [100, 0, 'BOOST KPA'] };
// torque from Nm: [factor, label, rounded to] (Nm and lb-ft to 5, kgm to 1); power from kW: [factor, label]
const TORQUE_UNITS = { nm: [1, 'TORQUE', 5], lbft: [0.737562, 'LB-FT', 5], kgm: [1 / 9.80665, 'KGM', 1] };
const POWER_UNITS = { hp: [1.34102, 'HP'], kw: [1, 'KW'], ps: [1.35962, 'PS'] };
const MAX_READOUTS = 4;
// the recovery / power bar's ends, kW: regen to 40, drive to 80 (a 330e's e-motor gives about 80 with XtraBoost);
// not yet checked on a car: the log of BMW's own power meter (powerlog.js) will tell
const HV_BAR_KW = [40, 80];
// the layouts that draw the power bar along their own gauge (hud-m.js; hud-draw.js under the bar), outside the
// readouts row (Minimal and Split wings have no readouts, and so no power bar)
const METER_STYLES = ['ramp', 'arc', 'dial', 'standard', 'vector', 'digital', 'vfd', 'pill'];
/** The RPM readout for format f: '10' (to 10, the default), '50', or 'k' (thousands, 4.5). */
function rpmItem(rpm, f) {
    const r = Math.max(0, rpm), step = f === '50' ? 50 : 10;
    if (f === 'k') return { label: 'KRPM', value: (Math.round(r / 100) / 10).toFixed(1), tone: 'text' };
    return { label: 'RPM', value: String(Math.round(r / step) * step), tone: 'text' };
}
const roundTo = (v, step) => Math.round(v / step) * step;
/**
 * The readouts row for o (optsFrom): d (rpm, oil, coolant), gearbox temperature, boost (bar), sp
 * ({ rpm, cold }), x (the extras: torque Nm, pedal %, gLat / gLong g, outside °C, and electrical.js's
 * soc12 %, v12 V, hvSoc %, hvKw, hvTemp °C, hvVolt V; any may be null).
 * In the order of the switches; at most four. When more are on, the last plain ones give way first:
 * a cold, warming or hot temperature (and the cold limit) keeps its place.
 * Fast values are rounded (torque to 5, 1 in kgm, throttle to 5 %, g to 0.05) so the row doesn't flicker.
 */
function readoutsFor(d, gb, boost, sp, o, x) {
    const items = [];
    x = x || {};
    if (o.speed && isNum(x.kmh)) items.push({ label: o.mph ? 'MPH' : 'KM/H', value: String(Math.round(Math.max(0, x.kmh) * (o.mph ? 0.621371 : 1))), tone: 'text' });
    // the rpm as a number (the 7-segment layouts have their own digits): to 10, to 50, or in
    // thousands with one decimal (4.5), which reads at a glance like the tach's own numbers
    if (o.rpm && o.style !== 'digital' && o.style !== 'vfd' && isNum(d.rpm)) items.push(rpmItem(d.rpm, o.rpmFormat));
    if (o.boost) {
        const b = boost, u = BOOST_UNITS[o.boostUnit] || BOOST_UNITS.bar;
        if (isNum(b)) items.push({ label: u[2], value: (Math.max(0, b) * u[0]).toFixed(u[1]), tone: 'text' });
    }
    if (o.torque && isNum(x.torque)) {
        const u = TORQUE_UNITS[o.torqueUnit] || TORQUE_UNITS.nm;
        items.push({ label: u[1], value: String(roundTo(Math.max(0, x.torque) * u[0], u[2])), tone: 'text' });
    }
    // power from torque x rpm (kW = Nm x rpm / 9549)
    if (o.power && isNum(x.torque) && isNum(d.rpm)) {
        const u = POWER_UNITS[o.powerUnit] || POWER_UNITS.hp;
        items.push({ label: u[1], value: String(Math.round(Math.max(0, x.torque) * Math.max(0, d.rpm) / 9549 * u[0])), tone: 'text' });
    }
    if (o.throttle && isNum(x.pedal)) items.push({ label: 'THROTTLE', value: roundTo(clamp(x.pedal, 0, 100), 5) + '%', tone: 'text' });
    // combined g (sideways and forward / braking together)
    if (o.g && (isNum(x.gLat) || isNum(x.gLong))) {
        const g = Math.sqrt(Math.pow(x.gLat || 0, 2) + Math.pow(x.gLong || 0, 2));
        items.push({ label: 'G', value: roundTo(g, 0.05).toFixed(2), tone: 'text' });
    }
    if (o.limit && sp && sp.cold) items.push({ label: 'LIMIT', value: String(sp.rpm), tone: 'cold' });
    // knock: the ignition retard knock control takes, only while it takes some (0.75 degrees and up)
    if (o.knock && isNum(x.knock) && x.knock >= 0.75) items.push({ label: 'KNOCK', value: x.knock.toFixed(1) + '°', tone: x.knock >= 2.25 ? 'hot' : 'warm' });
    // fuel use (fuel.js): per 100 km / mpg / km per litre while moving, per hour under 5 km/h
    if (o.fuel) { const it = Fuel.fuelItem(x.fuelLph, x.kmh, o.fuelUnit); if (it) items.push(it); }
    TEMPS.forEach((t) => {
        if (!o[t[1]]) return;
        const v = t[1] === 'gearbox' ? gb : d[t[1]];
        if (!isNum(v)) return;
        const lim = t[2];
        // the bands are in °C whatever is shown
        const tone = v < lim.cold ? 'cold' : lim.warmOil && v < o.warmOil ? 'warm' : v > lim.hot ? 'hot' : 'text';
        if (o.smartTemps && tone === 'text') return;
        items.push({ label: t[0], value: Math.round(o.fahrenheit ? v * 9 / 5 + 32 : v) + '°', tone: tone });
    });
    // outside: blue at 3 °C and below (ice is possible)
    if (o.outside && isNum(x.outside)) items.push({ label: 'OUTSIDE', value: Math.round(o.fahrenheit ? x.outside * 9 / 5 + 32 : x.outside) + '°', tone: x.outside <= 3 ? 'cold' : 'text' });
    // tyres: TYRES and the four pressures (hud-draw's 2x2 block), or the worst one where readouts are a label and a value
    if (o.tyres) { const ty = TyresMod.readout(x.tyres, o.tyreUnit); if (ty) items.push(ty); }
    electricalItems(o, x).forEach((it) => items.push(it));
    // four fit the row legibly: the last plain readout gives way first, so a warning keeps its place
    // (on a cold start with boost, limit, oil, water and gearbox on, the gearbox goes)
    // (the layouts that draw the power bar along their own gauge, not in the row: it takes no place there)
    const free = METER_STYLES.indexOf(o.style) >= 0 ? items.filter((it) => it.bar).length : 0;
    const keep = (it) => free && it.bar;
    while (items.length - free > MAX_READOUTS) {
        let i = items.length - 1, last = -1;
        for (let j = items.length - 1; j >= 0 && last < 0; j--) if (!keep(items[j])) last = j;
        while (i >= 0 && (items[i].tone !== 'text' || keep(items[i]))) i--;
        items.splice(i >= 0 ? i : last, 1);
    }
    return items;
}

/**
 * The electrical readouts (each only with a value): 12 V charge (yellow under 60 %, red under 40 %), 12 V voltage
 * (to 0.1 V; yellow under 12.0, red under 11.5 or over 15.0), HV charge, HV power (+ drives, - regen; to 1 kW),
 * HV temperature (blue under 5 °C, red over 45 °C), pack voltage.
 */
function electricalItems(o, x) {
    const out = [];
    if (o.soc12 && isNum(x.soc12)) out.push({ label: '12V CHARGE', value: Math.round(x.soc12) + '%', tone: x.soc12 < 40 ? 'hot' : x.soc12 < 60 ? 'warm' : 'text' });
    if (o.volt12 && isNum(x.v12)) out.push({ label: '12V', value: x.v12.toFixed(1), tone: x.v12 < 11.5 || x.v12 > 15 ? 'hot' : x.v12 < 12 ? 'warm' : 'text' });
    if (o.hvSoc && isNum(x.hvSoc)) out.push({ label: 'HV CHARGE', value: Math.round(clamp(x.hvSoc, 0, 100)) + '%', tone: 'text' });
    if (o.hvPower && isNum(x.hvKw)) { const k = Math.round(x.hvKw); out.push({ label: 'HV KW', value: (k > 0 ? '+' : '') + k, tone: 'text' }); }
    // the recovery / power bar (hud-draw.js): regen left of zero, drive right, two columns wide when there's room
    if (o.hvBar && isNum(x.hvKw)) { const k = Math.round(x.hvKw); out.push({ label: 'POWER', value: (k > 0 ? '+' : '') + k, tone: 'text', bar: { v: x.hvKw, lo: -HV_BAR_KW[0], hi: HV_BAR_KW[1] }, wide: true }); }
    if (o.hvTemp && isNum(x.hvTemp)) out.push({ label: 'HV TEMP', value: Math.round(o.fahrenheit ? x.hvTemp * 9 / 5 + 32 : x.hvTemp) + '°', tone: x.hvTemp < 5 ? 'cold' : x.hvTemp > 45 ? 'hot' : 'text' });
    if (o.hvVolt && isNum(x.hvVolt)) out.push({ label: 'HV VOLTS', value: String(Math.round(x.hvVolt)), tone: 'text' });
    return out;
}

/*
 * A scripted 10 s drive for previews (the HUD looks page and "Play on HUD"): 3rd gear counting in
 * and flashing, an upshift (graded spot on, early or late in turn, by the loop), 4th onto the
 * limiter, braking with the downshift cue counting up, two downshifts, then cruising.
 * Returns what the HUD needs at t ms into it.
 */
const DEMO_MS = 10000;
function demoAt(tMs) {
    const loop = Math.floor(tMs / DEMO_MS), t = (tMs % DEMO_MS) / 1000;
    const lerp = (a, b, f) => a + (b - a) * clamp(f, 0, 1);
    const grades = ['SPOT ON', 'EARLY', 'LATE'], g = grades[loop % 3];
    const upAt = g === 'EARLY' ? 4800 : g === 'LATE' ? 6150 : 5650;       // the 3rd-gear shift rpm
    const climb3 = 3800, rate3 = 1000, tUp = (upAt - climb3) / rate3;
    let r = { rpm: 0, gear: 3, stage: 'D', shift: 5550, down: 0, chip: null, oil: 98, coolant: 92, gearbox: 81, boost: 0, mode: 'M', peak: 0 };
    if (t < tUp) { r.rpm = climb3 + rate3 * t; r.boost = lerp(0.4, 1.3, t / tUp); }
    else if (t < 4.8) {
        r.gear = 4; r.shift = 5750; r.chip = { verdict: g, at: tUp * 1000 };
        r.rpm = Math.min(6540, upAt * 0.79 + 800 * (t - tUp)); r.boost = 1.3; r.peak = upAt;
    } else if (t < 5.6) { r.gear = 4; r.shift = 5750; r.rpm = 6500 + (Math.floor(t * 20) % 2) * 40; r.boost = 1.3; r.peak = 6540; }
    else if (t < 7.6) {
        r.gear = 4; r.shift = 5750; r.rpm = lerp(6400, 2700, (t - 5.6) / 2); r.down = Math.min(3, Math.floor((t - 5.6) / 0.55)); r.peak = 6540;
    } else if (t < 8.6) { r.gear = t < 8.1 ? 3 : 2; r.shift = r.gear === 3 ? 5550 : 6400; r.rpm = r.gear === 3 ? 3500 : 4400; r.down = r.gear === 3 ? 2 : 1; }
    else { r.gear = 2; r.shift = 6400; r.rpm = lerp(4400, 3000, (t - 8.6) / 1.4); r.boost = 0.2; }
    r.chipAge = r.chip ? tMs % DEMO_MS - r.chip.at : 0;
    // the extras: full throttle while climbing, off while braking
    const pull = r.down || t >= 8.6 ? 0 : t >= 7.6 ? 0.3 : 1;
    r.pedal = pull * 100; r.torque = pull ? 180 + 220 * clamp(r.boost / 1.3, 0, 1) : 0;
    r.gLong = r.down ? -0.85 : pull * 0.45; r.gLat = 0.1; r.outside = 14;
    // the speed from the gear and revs (km/h per 1000 rpm, an 8-speed's 2nd to 4th)
    r.kmh = r.rpm / 1000 * ({ 2: 13.6, 3: 20.6, 4: 27 }[r.gear] || 20);
    // tyres for the previews: front right of target, rear left a little under, rear right well under
    r.tyres = { p: { FL: 2.4, FR: 2.4, RL: 2.5, RR: 2.1 }, tgt: { FL: 2.5, FR: 2.5, RL: 2.7, RR: 2.7 }, t: { FL: 59, FR: 61, RL: 69, RR: 70 } };
    return r;
}

/**
 * The scripted drive's frame tMs into it, as drawHud wants it: one for "Play on HUD" and the HUD looks
 * page's preview, so the preview shows what the glass does. o: optsFrom; cueState: kept between frames
 * ({}); lead: the reaction lead (ms); now: the clock for the cue, flash and shake (default tMs).
 */
function demoFrame(tMs, o, cueState, lead, now) {
    if (!isNum(now)) now = tMs;
    const dm = demoAt(tMs), redline = 6550;
    const d = { rpm: dm.rpm, gear: dm.gear, stage: dm.stage, oil: dm.oil, coolant: dm.coolant, demo: true };
    const sp = { rpm: dm.shift, cold: false };
    const cue = shiftCue(cueState, d.rpm, now, sp.rpm, redline, lead, d.gear, d.rpm, o.rev);
    return {
        d: d, shift: sp.rpm, redline: redline, max: 8000, blink: cue.shift || cue.limiter ? Math.floor(now / BLINK_MS) % 2 === 0 : true, cue: cue,
        down: dm.down,
        peak: o.peak ? dm.peak : 0,
        chip: dm.chip && o.chip !== 'off' && dm.chipAge < 1500 ? { verdict: dm.chip.verdict, age: dm.chipAge, burst: o.chip === 'burst' } : null,
        shake: o.shake && cue.limiter ? SHAKE[Math.floor(now / 100) % SHAKE.length] : null,
        readouts: readoutsFor(d, dm.gearbox, dm.boost, sp, o, dm),
        mode: o.mode && (dm.mode === 'M' || dm.mode === 'S' || dm.mode === 'D') ? dm.mode : null,
        opts: o,
    };
}

/** The scene's test pattern: border, rulers every 40 px with labels, inset frames at 40/80/120 (those that fit), the tach at its place. */
function drawTestPattern(cv) {
    cv.clear();
    const SCENE_W = SCENE.w, SCENE_H = SCENE.h;
    const frame = (i, c) => {
        const w = SCENE_W - 2 * i, h = SCENE_H - 2 * i;
        cv.fillRect(i, i, w, 2, c); cv.fillRect(i, i + h - 2, w, 2, c);
        cv.fillRect(i, i, 2, h, c); cv.fillRect(i + w - 2, i, 2, h, c);
    };
    frame(0, WHITE);
    [[40, CYAN], [80, MAGENTA], [120, YELLOW]].filter((f) => 2 * f[0] + 40 <= Math.min(SCENE_W, SCENE_H)).forEach((f) => {
        frame(f[0], f[1]);
        cv.text(String(f[0]), f[0] + 6, f[0] + 22, 18, f[1], { font: 'bold' });
    });
    for (let x = 0; x <= SCENE_W; x += 40) {
        const major = x % 200 === 0, len = major ? 24 : 12;
        cv.fillRect(clamp(x - 1, 0, SCENE_W - 2), 0, 2, len, WHITE);
        cv.fillRect(clamp(x - 1, 0, SCENE_W - 2), SCENE_H - len, 2, len, WHITE);
        if (major && x > 0 && x < SCENE_W) cv.text(String(x), x, 44, 16, WHITE, { align: 'center', font: 'bold' });
    }
    for (let y = 0; y <= SCENE_H; y += 40) {
        const major = y % 120 === 0, len = major ? 24 : 12;
        cv.fillRect(0, clamp(y - 1, 0, SCENE_H - 2), len, 2, WHITE);
        cv.fillRect(SCENE_W - len, clamp(y - 1, 0, SCENE_H - 2), len, 2, WHITE);
        if (major && y > 0 && y < SCENE_H) cv.text(String(y), 30, y + 6, 16, WHITE, { font: 'bold' });
    }
    cv.fillRect(SCENE_W / 2 - 20, SCENE_H / 2 - 1, 40, 2, WHITE);
    cv.fillRect(SCENE_W / 2 - 1, SCENE_H / 2 - 20, 2, 40, WHITE);
}

/** Bounding box of the pixels that differ between a and b (Uint8Arrays of w x h RGBA), or null. */
function changedBox(a, b, w, h) {
    const A = new Uint32Array(a.buffer, a.byteOffset, w * h), B = new Uint32Array(b.buffer, b.byteOffset, w * h);
    let x0 = w, x1 = -1, y0 = h, y1 = -1;
    for (let y = 0; y < h; y++) {
        const row = y * w;
        let l = -1, r = -1;
        for (let x = 0; x < w; x++) if (A[row + x] !== B[row + x]) { l = x; break; }
        if (l < 0) continue;
        for (let x = w - 1; x >= l; x--) if (A[row + x] !== B[row + x]) { r = x; break; }
        if (y < y0) y0 = y;
        y1 = y;
        if (l < x0) x0 = l;
        if (r > x1) x1 = r;
    }
    return y1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * The rows of rects rs of a w-wide RGBA image, packed tight one after another (what cr.pixels
 * takes), in a buffer reused between frames: cr.pixels copies it before returning.
 */
let packBuf = null;
function packRect(d, w, r) { return packRects(d, w, [r]); }
function packRects(d, w, rs) {
    let n = 0;
    rs.forEach((r) => { n += r.w * r.h * 4; });
    if (!packBuf || packBuf.length < n) packBuf = Buffer.alloc(Math.max(n, IW * IH * 4));
    const src = asBuffer(d);
    let off = 0;
    rs.forEach((r) => {
        for (let y = 0; y < r.h; y++) { src.copy(packBuf, off, ((r.y + y) * w + r.x) * 4, ((r.y + y) * w + r.x + r.w) * 4); off += r.w * 4; }
    });
    return packBuf.slice(0, n);
}

/** The changed boxes of a and b per horizontal band (lights, bar, text): a flash or a count at
 * both ends plus the bar's end make three small boxes, not one that spans them all. */
const BANDS = [[0, 20], [20, 60], [60, IH]];
function changedBoxes(a, b, w) {
    const out = [];
    BANDS.forEach((band) => {
        const y0 = band[0], h = band[1] - band[0];
        const r = changedBox(a.subarray(y0 * w * 4, (y0 + h) * w * 4), b.subarray(y0 * w * 4, (y0 + h) * w * 4), w, h);
        if (r) { r.y += y0; out.push(r); }
    });
    return out;
}

/**
 * Start the HUD output. src = { data() (car.data()), shiftPoint(oil, gear) -> { rpm }, redline(),
 * maxRpm(), gearbox (a GearboxTemp, optional) }.
 * Returns { stop, status() (a line for the screen, '' while off), upshift(rpm) (each upshift's
 * rpm: calibrates the reaction time), lead() (ms in use) }.
 */
function start(ctx, src) {
    const settings = ctx.settings, log = ctx.log;
    let cr = null, layer = 0, shown = '', lastTarget = '', timer = null, blink = false;
    let target = null;                                           // { state, holder, disabled } of 'hud'
    const cueState = {};
    let lastDemo = null;
    /*
     * Reaction time, learned ("HUD shift light early by" on Auto): each upshift after a flash
     * says how late it came: (shift rpm - shift point) / climb rate. The lead moves 30 % of the
     * way to the lead that would have hit it, within 0..600 ms; kept in data/hudlead.json.
     */
    const leadFile = path.join(ctx.dataDir || '.', 'hudlead.json');
    let learnedLead = 200, leadShifts = 0, flashInfo = null;
    try {
        const j = JSON.parse(fs.readFileSync(leadFile, 'utf8'));
        if (isNum(j.ms)) { learnedLead = clamp(Math.round(j.ms), 0, 600); leadShifts = isNum(j.n) && j.n > 0 ? Math.floor(j.n) : 0; }
    } catch (e) { /* none yet */ }
    let cur = null, prev = null, first = true, lastErr = 0;
    let hiddenLogged = false;     // the HUD is hidden by the driving mode (logged once each way)
    let offLogged = false;        // no new layer while the car is off or switching on / off (logged once each time)
    let crStatus = null;          // cluster-render's last status reply { t, text } (the Logs page asks for it)

    const safe = (name, fn) => function () {
        try { return fn.apply(null, arguments); } catch (e) {
            if (Date.now() - lastErr > 10000) { lastErr = Date.now(); log.error('hud ' + name + ': ' + (e && e.stack || e)); }
        }
    };
    const mode = () => settings.get('hud') || 'off';
    const num = (k, dflt) => { const v = Number(settings.get(k)); return isFinite(v) ? v : dflt; };
    const leadMs = () => { const v = num('hudLead', -1); return v < 0 ? learnedLead : v; };

    /**
     * The settings the HUD's place comes from: the driving mode's setup (its own size and place when it has its own),
     * the one being played on "Play on HUD".
     */
    const placeView = () => profileView(settings, Date.now() < demoUntil ? playProfile : profileOf(src.driveMode ? src.driveMode() : null, settings));
    const rect = () => placeOf(placeView());
    // where the layers were last put: a change of driving mode to a setup placed elsewhere moves them (tick)
    let placedKey = '';
    const rectKey = (r) => [r.x, r.y, r.w, r.h].join(',');

    /*
     * The directions' picture (hud-nav.js): its own image layer in the bottom right corner, made while there is a turn to show,
     * dropped when there isn't. Only what changed is sent (the distance counting down), nothing when it's the same.
     * The same corner shows the tyre widget (hud-tyres.js) when the directions have nothing: it is the directions' layer
     * and place, so the two never overlap and the directions always come first.
     */
    let navLayer = 0, navCur = null, navPrev = null, navFirst = true, navLast = '', navGiving = false;
    const dropNav = () => { if (cr && navLayer) cr.drop(navLayer); navLayer = 0; navLast = ''; corner = ''; };
    /** What the directions do now: { show, giveWay } (nothing while the demo plays or without the source). */
    // a directions layer the renderer refused or failed: made again after NAV_RETRY_MS (dropNav; the next tick)
    // timed on the monotonic clock: the head unit's wall clock is set from GPS and can jump back
    const monoMs = () => { const t = process.hrtime(); return t[0] * 1000 + t[1] / 1e6; };
    let navRefusedLogged = false, navFailedAt = -Infinity;
    const NAV_RETRY_MS = 5000;
    const navFailed = (why) => { log.warn('hud: directions layer ' + why + ', made again in ' + NAV_RETRY_MS / 1000 + ' s'); dropNav(); navFailedAt = monoMs(); };
    const navNow = (playing) => (src.nav && !playing ? src.nav.view(navModeOf(settings)) : { show: null, giveWay: false });
    // what the corner shows now: 'nav', 'tyres' or '' (for the tests and the log)
    let corner = '', tyreLowLogged = '', navShownAt = -Infinity;
    /** The tyre widget now: { ty, w } when it shows (setting "hudTyreWidget"; "Play on HUD" shows the sample), else null. */
    const tyreView = (playing) => {
        const w = HudTyres.widgetOf(settings);
        // the sample on "Play on HUD" only on a car that sends tyres (a car without never sees anything of them)
        if (playing) return w.show !== 'off' && settings.get('hudTyresSeen') === true ? { ty: HudTyres.SAMPLE, w: w } : null;
        const ty = src.tyres ? src.tyres.value() : null;
        const low = TyresMod.lowCorners(ty).join(',');
        if (low !== tyreLowLogged) { if (low) log.info('hud: low tyre ' + low + (w.show !== 'off' ? ': the tyre widget shows' : '')); tyreLowLogged = low; }
        return HudTyres.widgetShows(w, ty) ? { ty: ty, w: w } : null;
    };
    const drawNavLayer = (m, tv) => {
        corner = m ? 'nav' : tv ? 'tyres' : '';
        if (m) navShownAt = monoMs();
        if (!m && !tv) { dropNav(); return; }
        if (!navLayer) {
            if (monoMs() - navFailedAt < NAV_RETRY_MS) return;
            const r = navPlaceOf(placeView());
            navLayer = cr.image({ target: 'hud', klass: 'overlay', z: 0, x: r.x, y: r.y, w: r.w, h: r.h, iw: HudNav.NW, ih: HudNav.NH, fps: 5, sampling: 'bilinear' });
            if (!navLayer) { if (!navRefusedLogged) { navRefusedLogged = true; log.warn('hud: directions layer refused by the client'); } return; }
            navRefusedLogged = false;
            navCur = new Canvas(HudNav.NW, HudNav.NH); navPrev = new Canvas(HudNav.NW, HudNav.NH); navFirst = true; navLast = '';
        }
        const o = optsNow(), no = { palette: o.style === 'vfd' ? 'vfd' : o.palette };
        const key = m ? HudNav.navKey(m, no) : HudTyres.widgetKey(tv.ty, tv.w, no.palette);
        if (!navFirst && key === navLast) return;
        navLast = key;
        if (m) HudNav.drawNav(navCur, m, no); else HudTyres.drawWidget(navCur, tv.ty, tv.w, no.palette);
        if (navFirst) { if (cr.pixels(navLayer, null, asBuffer(navCur.d))) navFirst = false; }
        else {
            // one box (changedBoxes' bands are the tach's)
            const r = changedBox(navCur.d, navPrev.d, HudNav.NW, HudNav.NH);
            if (!r) return;
            cr.pixels(navLayer, [r], packRect(navCur.d, HudNav.NW, r));
        }
        const t = navPrev; navPrev = navCur; navCur = t;
    };

    const connect = safe('connect', () => {
        if (cr) return;
        if (!ClusterRender) { log.warn('hud: cluster_render_client.js is missing from the app'); return; }
        cr = new ClusterRender('redline');
        cr.on('ready', safe('ready', () => {
            first = true;
            log.info('hud: connected to cluster-render (' + cr.backend + ', targets ' + cr.targets + ')');
            // the HUD's size (iDrive 8's is 353x203): the tach moves there with the next frame, the test pattern is drawn again
            if (useScene(cr.targets)) {
                log.info('hud: scene ' + SCENE.w + 'x' + SCENE.h);
                if (shown === 'test') { shown = ''; showTestPattern(); }
            }
        }));
        cr.on('disconnected', safe('disconnected', () => log.warn('hud: cluster-render went away, reconnecting')));
        cr.on('target', safe('target', (name, state, holder, reason, guideDisabled, disabled) => {
            if (name !== 'hud') return;
            const s = disabled ? 'disabled by the mapping guard (as root: cluster-render guard-reset)'
                : state + (holder ? ' behind ' + holder : '') + (reason ? ' (' + reason + ')' : '');
            target = { state: state, holder: holder, disabled: disabled };
            if (s !== lastTarget) { lastTarget = s; log.info('hud: target ' + s); }
        }));
        // its status reply (the Logs page): the mapping guard's lines among it
        cr.on('status', safe('status', (text) => { crStatus = { t: Date.now(), text: String(text || '') }; }));
        cr.on('layer', safe('layer', (ref, state, reason) => {
            if (ref === layer) log.info('hud: layer ' + state + (reason ? ' (' + reason + ')' : ''));
            else if (navLayer && ref === navLayer) {
                log.info('hud: directions layer ' + state + (reason ? ' (' + reason + ')' : ''));
                if (state === 'error') navFailed('failed');
            }
        }));
        cr.on('refused', safe('refused', (op, ref, reason) => {
            log.warn('hud: refused ' + op + ' ' + ref + ': ' + reason);
            if (navLayer && ref === navLayer) navFailed('refused');
        }));
        cr.connect();
        log.info('hud: connecting to cluster-render');
    });

    // the UDS readers (gearbox, knock, electrical): stopped together whenever the tach isn't drawing
    // probe: hidden by the driving mode, but the one look for a hybrid battery still runs (start with nothing wanted
    // does only that, then stops): a plug-in hybrid's Hybrid / Electric modes count as Comfort, hidden by default, so
    // without it a hybrid would only be found in Sport (2026-11-10 review)
    const stopReads = (probe) => {
        [src.gearbox, src.knock, src.fuel].forEach((r) => { if (r) r.stop(); });
        if (src.electrical) { if (probe) src.electrical.start({}); else src.electrical.stop(); }
    };
    const stopTimer = () => { if (timer) clearInterval(timer); timer = null; stopReads(); };

    const dropLayer = safe('drop', () => { stopTimer(); dropNav(); if (cr && layer) cr.drop(layer); layer = 0; shown = ''; hiddenLogged = false; navGiving = false; });

    const disconnect = safe('disconnect', () => {
        dropLayer();
        if (cr) { cr.removeAllListeners(); cr.close(); cr = null; log.info('hud: off'); }
        lastTarget = ''; target = null;
    });

    const showTestPattern = safe('test', () => {
        if (shown === 'test') return;
        dropLayer();
        layer = cr.image({ target: 'hud', klass: 'overlay', x: 0, y: 0, w: SCENE.w, h: SCENE.h, fps: 1 });
        if (!layer) { log.warn('hud: test layer refused by the client'); return; }
        const cv = new Canvas(SCENE.w, SCENE.h);
        drawTestPattern(cv);
        const r = rect();
        // where the size and position settings put the tach: drawn there at that size, blended over the pattern
        // (a scaled copy of the 400x130 picture would lose its see-through and dim parts: drawImage is opaque)
        if (r.w === IW && r.h === IH) { const t = new Canvas(IW, IH); drawHud(t, sample()); cv.blit(t, r.x, r.y); }
        else Draw.drawLayer(Draw.scaled(cv, r.w / IW, r.x, r.y), sample());
        // where the directions go (setting "Directions"): a sample turn at 100 %, its frame at any size; the tyre
        // widget's sample there when the directions are off and the widget isn't (on a car that sends tyres)
        const tw = HudTyres.widgetOf(settings), tyresOn = tw.show !== 'off' && settings.get('hudTyresSeen') === true;
        if (navModeOf(settings) !== 'off' || tyresOn) {
            const nr = navPlaceOf(placeView());
            cv.strokeRoundRect(nr.x, nr.y, nr.w, nr.h, 6, 1, withAlpha(CYAN, 0.6));
            if (nr.w === HudNav.NW) {
                const t = new Canvas(HudNav.NW, HudNav.NH);
                if (navModeOf(settings) !== 'off') HudNav.drawNav(t, HudNav.SAMPLE, { palette: 'colour' }); else HudTyres.drawWidget(t, HudTyres.SAMPLE, tw, 'colour');
                cv.blit(t, nr.x, nr.y);
            }
        }
        if (!cr.pixels(layer, null, asBuffer(cv.d))) log.warn('hud: test pattern pixels refused');
        shown = 'test';
        log.info('hud: test pattern up');
    });

    /** What drawHud needs, now. */
    function frameData() {
        let now = Date.now();
        // the demo stops by itself once the car moves (it replaces the real lights on the glass)
        if (now < demoUntil && src.data().speed > 5) { demoUntil = 0; log.info('hud: demo stopped, the car moved'); }
        const playing = now < demoUntil, dm = playing ? demoAt(now - demoStart) : null;
        const d = dm ? null : src.data(), demoKey = dm ? 'play' : !!d.demo;
        if (demoKey !== lastDemo) { lastDemo = demoKey; Object.keys(cueState).forEach((k) => { delete cueState[k]; }); flashInfo = null; }
        const o = optsNow(), lights = o.lights;
        // "Play on HUD": the scripted drive instead of the car, for a few seconds (nothing is learned)
        if (dm) { const f = demoFrame(now - demoStart, o, cueState, leadMs(), now); blink = f.blink; return f; }
        const sp = src.shiftPoint(d.oil, d.gear), redline = src.redline();
        // the lights count into the shift and flash for it, early by the reaction time; 5 Hz flash
        const was = cueState.on, lead = leadMs();
        const show = smooth(d.rpm, now, Math.min(redline - 50, src.maxRpm()));
        const cue = shiftCue(cueState, d.rpm, now, sp.rpm, redline, lead, d.gear, show, o.rev);
        // the reaction time is learned only from flashes the driver could see: lights on, HUD shown (not from the
        // plain rev bar's flash at the redline: it has no lead)
        if (cue.shift && !was && !isNum(o.rev)) {
            const seen = lights && target && target.state === 'shown';
            flashInfo = seen ? { t: Date.now(), rate: cue.rate, target: sp.rpm, lead: lead, fall: null } : null;
        }
        // first moment the revs fell after the flash: a real upshift reports its new gear within
        // ~0.7 s of that; later, the driver lifted first and the shift says nothing about reaction
        if (flashInfo && flashInfo.fall === null && cue.fallSince !== null) flashInfo.fall = cue.fallSince;
        blink = cue.shift || cue.limiter ? Math.floor(now / BLINK_MS) % 2 === 0 : true;
        const gb = src.gearbox ? src.gearbox.value() : null;
        const mode = src.mode ? src.mode() : null;
        return {
            d: isNum(show) && show !== d.rpm ? Object.assign({}, d, { rpm: show }) : d, shift: sp.rpm, redline: redline, max: src.maxRpm(), blink: blink, cue: cue,
            down: src.downshift ? src.downshift() : 0,
            peak: o.peak ? (src.peak ? src.peak() : 0) : 0,
            chip: chipNow(o, now),
            shake: o.shake && cue.limiter ? SHAKE[Math.floor(now / 100) % SHAKE.length] : null,
            readouts: readouts(d, gb, sp, o),
            mode: o.mode && (mode === 'M' || mode === 'S' || mode === 'D') ? mode : null,
            opts: o,
        };
    }
    let demoStart = 0, demoUntil = 0;

    /*
     * The readouts row, left to right: rpm, boost (once the car has sent a moving value), torque,
     * power, throttle, g, the cold-engine shift limit (while the cold guard holds the shift point
     * down), then oil, water, gearbox and outside (readoutsFor).
     * Temperatures "smart": only one that is cold, warming (oil under "Oil warm at") or hot. Four at most.
     */
    const ro = { t: 0, v: [], o: null };
    function readouts(d, gb, sp, o) {
        // 4 times a second by default (setting "Readouts refresh"): power, torque and g change with
        // every sample; faster means more frames sent to the HUD (an options change shows at once)
        const now = Date.now();
        const ok = JSON.stringify(o);
        if (ok !== ro.o || now - ro.t >= (o.readoutMs || READOUT_MS) || now < ro.t) {
            ro.v = readoutsFor(d, gb, o.boost && src.boost ? src.boost() : null, sp, o, src.extras ? src.extras() : null);
            ro.t = now; ro.o = ok;
        }
        return ro.v;
    }

    /*
     * The car sends rpm 10-20 times a second; the HUD draws up to 30. Between two samples the bar is
     * moved on along the last climb (or fall), for at most 1.2 sample intervals and 150 ms, so it
     * moves smoothly instead of in steps; a new sample replaces the estimate. A gap over 300 ms is
     * no climb, nor is a jump faster than 8000 rpm/s (a glitch, not a climb); after the window the
     * real reading is drawn (revs held on the point must not run on into the limiter), and the
     * estimate never goes past the redline. Also measured: how often samples come (logged once, then every 10 minutes).
     */
    const sm = { r: null, t: 0, rate: 0, dt: 0, n: 0, logged: 0 };
    function smooth(rpm, now, max) {
        // max: the redline (the estimate stops there; the real reading may be above it)
        if (!isNum(rpm)) { sm.r = null; return rpm; }
        if (rpm !== sm.r || now - sm.t >= 500) {
            const dt = now - sm.t;
            sm.rate = sm.r !== null && dt > 15 && dt < 300 ? (rpm - sm.r) * 1000 / dt : 0;
            if (Math.abs(sm.rate) > 8000) sm.rate = 0;
            if (sm.r !== null && dt > 15 && dt < 300) { sm.dt = sm.dt ? sm.dt * 0.95 + dt * 0.05 : dt; sm.n++; }
            sm.r = rpm; sm.t = now;
            if (sm.n >= 200 && now - sm.logged > 600000) {
                sm.logged = now;
                log.info('hud: rpm samples every ' + Math.round(sm.dt) + ' ms (' + Math.round(1000 / sm.dt) + ' a second), drawn at ' + fps() + ' fps');
            }
            return rpm;
        }
        const win = Math.min(sm.dt ? sm.dt * 1.2 : 100, 150);
        if (Math.abs(sm.rate) < 200 || now - sm.t > win) return rpm;
        const est = clamp(Math.round(rpm + sm.rate * (now - sm.t) / 1000), 0, Math.max(rpm, max || 9000));
        return sm.rate > 0 ? Math.max(rpm, Math.min(est, max || 9000)) : est;
    }
    const fps = () => { const v = num('hudFps', FPS_DEFAULT); return v >= 30 ? 30 : v >= 20 ? 20 : 10; };

    /** The last upshift's grade while it shows: { verdict, age, burst } (src.chip(): { verdict, at }). */
    // where the grade shows, first that has one: knock (it can save the engine), the shift grade, the launch time
    function chipNow(o, now) {
        const k = knockChip(o, now);
        if (k) return k;
        const c = o.chip !== 'off' && src.chip ? src.chip() : null;
        if (c) return { verdict: c.verdict, age: now - c.at, burst: o.chip === 'burst' };
        return launchChip(o, now);
    }
    /*
     * The launch time for 3 s after a standing start: the time and its difference to the best before it,
     * green for a new best, yellow within 0.1 s, red further off. Held for 2.6 s (the grade's timeline holds 1.1 s),
     * then fades as a grade does.
     */
    function launchChip(o, now) {
        if (!o.launch || !src.launch) return null;
        const l = src.launch(now, o.mph);
        if (!l) return null;
        const a = now - l.at, sign = (x) => (x < 0 ? '-' : '+') + Math.abs(x).toFixed(2);
        return { verdict: 'LAUNCH', text: l.secs.toFixed(2) + (l.delta === null ? ' s' : '  ' + sign(l.delta)), tone: l.best ? 'low' : l.delta !== null && l.delta <= 0.1 ? 'mid' : 'high',
            age: a < 2600 ? Math.min(a, 1100) : a - 1500, burst: o.chip !== 'simple' };
    }
    /*
     * The knock warning: KNOCK where the grade shows, for 1.5 s after the engine last reported knock (it does
     * on every read while it knocks, so it stays up). Its burst plays once per spell, not on every read.
     */
    const kn = { start: 0, last: 0 };
    function knockChip(o, now) {
        if (!o.knockWarn || !src.knock) return null;
        const at = src.knock.value().at;
        if (!at || now - at > 1500) return null;
        if (at - kn.last > 1500 || !kn.start) kn.start = at;
        kn.last = at;
        return { verdict: 'KNOCK', age: now - kn.start, burst: o.chip !== 'simple' };
    }

    /** The drawing options from the settings. */
    // the profile of the driving mode; "Play on HUD" plays the one it was asked for
    let playProfile = 'sport';
    function optsNow() {
        if (Date.now() < demoUntil) return optsFrom(profileView(settings, playProfile));
        return optsFrom(settings, src.driveMode ? src.driveMode() || 'sport' : 'sport');
    }
    /** What the driving mode asks of the HUD now ('all', 'lights', 'hide'); "Play on HUD" always shows all. */
    function calm(playing) {
        if (playing) return 'all';
        const drive = src.driveMode ? src.driveMode() : null;
        return calmFor(drive, setupMode(settings, profileOf(drive, settings)));
    }

    /** Demo frame for the test pattern: 6300 rpm in 3rd, warm (temps in the unit chosen). */
    function sample() {
        const o = optsNow(), d = { rpm: 6300, gear: 3, stage: 'D', oil: 96, coolant: 97 };
        const deg = (c) => Math.round(o.fahrenheit ? c * 9 / 5 + 32 : c) + '°';
        return { d: d, shift: 6700, redline: 7000, max: 8000, blink: true, cue: shiftCue({}, 6300, 0, 6700, 7000, 0), down: 0, peak: 0, chip: null,
            readouts: [{ label: 'BOOST', value: '1.1', tone: 'text' }, { label: 'OIL', value: deg(d.oil), tone: 'text' }, { label: 'WATER', value: deg(d.coolant), tone: 'text' }], opts: o };
    }

    let lastKey = '';
    /**
     * Not drawn while the HUD can't show it: parked behind BMW's content, waiting to retry,
     * unavailable or disabled by the guard. Drawn in every other state: cluster-render only asks
     * for the target once the layer has content, so idle / acquiring must draw.
     */
    /**
     * No new HUD layer while the car is off (vehicle state 5 or lower), its drive readiness is starting (8) or
     * ending (12); a car that doesn't send its state (or not yet) isn't held back. cluster-render's mapping
     * guard counts the cluster's display going away within 10 s of the HUD being mapped as a strike, and two turn
     * the HUD off for good. At switch-off Redline used to map it just then (issue #141). A layer already there stays
     * at 8; at 12 or 5 and lower it is dropped (switchingOff).
     */
    function holdOff() {
        const d = src.data ? src.data() : {}, c = d.condition;
        // (a state the car sent that isn't known, "no value" among them: held too, the last known one may be stale)
        return d.conditionKnown === false || (isNum(c) && (c <= 5 || c === 8 || c === 12));
    }
    /**
     * The car switching off (12) or off (5 or lower): a tach already up is dropped too, so cluster-render has nothing
     * to map on the HUD as the cluster goes (it maps again by itself when BMW's content or a pop-up lets go).
     */
    function switchingOff() {
        const c = src.data ? src.data().condition : undefined;
        return isNum(c) && (c <= 5 || c === 12);
    }
    // the directions giving way ended with nothing to show (a route ending, as at switch-off): the tach back only after BACK_WAIT_MS,
    // so the car's state can say first that it's switching off
    const BACK_WAIT_MS = isNum(ctx.backWaitMs) ? ctx.backWaitMs : 8000;
    let backAt = 0;
    // a call ringing (src.ringing, issue #181): out of the way of BMW's call card until it stops ringing, then back
    // after CALL_BACK_MS, so the card has gone (answered, declined or missed) before the tach is drawn again
    const CALL_BACK_MS = isNum(ctx.callBackMs) ? ctx.callBackMs : 2000;
    let callGiving = false, callBackAt = 0;
    const paused = () => !!target && (target.disabled || target.state === 'parked' || target.state === 'waiting' || target.state === 'unavailable');
    const tick = safe('tick', () => {
        // cluster-render not up (lost, or not yet back): nothing is drawn, so nothing is read from the car either
        if (!cr || !cr.ready) { stopReads(); return; }
        // Comfort / Eco Pro on "Hide": the image is dropped (BMW's own HUD shows), the timer keeps
        // running to bring it back when the mode changes
        let nv = { show: null, giveWay: false };
        if (shown === 'tach') {
            const playing = Date.now() < demoUntil;
            nv = navNow(playing);
            // a route without a turn Redline can read: out of the way, so BMW's own card shows (nav.js logs it)
            // (over with a turn to show: back at once, it's the route going on)
            if (navGiving && !nv.giveWay && !nv.show) backAt = Date.now() + BACK_WAIT_MS;
            navGiving = nv.giveWay;
            const ring = !playing && !!(src.ringing && src.ringing());
            if (callGiving && !ring) { callBackAt = Date.now() + CALL_BACK_MS; backAt = Math.max(backAt, callBackAt); }
            callGiving = ring;
            const off = switchingOff();
            if (calm(playing) === 'hide' || nv.giveWay || ring || off) {
                dropNav();
                if (layer) {
                    cr.drop(layer); layer = 0;
                    // the old layer's target state isn't the new one's: forget it (keeping a guard
                    // stop), so a layer made again isn't held back waiting for a target event
                    if (target) target = { state: '', holder: '', disabled: target.disabled };
                }
                stopReads(true);
                // nothing of Redline's on the HUD. Comfort's hide: the standing app (Cluster functions) may show. Giving
                // way: keep the claim, so it's BMW's card that shows, not Cluster functions' map over it (2026-11-09 review)
                claim.hold(!!(nv.giveWay || ring));
                if (off) { if (!offLogged) { offLogged = true; log.info('hud: dropped, the car is switching off (state ' + src.data().condition + ')'); } }
                else if (!hiddenLogged && !nv.giveWay && !ring) { hiddenLogged = true; log.info('hud: hidden in ' + (src.driveMode ? src.driveMode() : '?') + ' mode'); }
                return;
            }
            if (!layer) {
                if (Date.now() < backAt) { stopReads(true); return; }
                if (holdOff()) {
                    stopReads(true);
                    if (!offLogged) { offLogged = true; log.info('hud: no new layer while the car is off or switching on / off (state ' + (src.data ? src.data().condition : '?') + ')'); }
                    return;
                }
                offLogged = false;
                makeLayer(); if (!layer) return;
            }
            claim.hold(true);
            if (hiddenLogged) { hiddenLogged = false; log.info('hud: back on'); }
        }
        if (!layer) return;
        // the driving mode's setup sits elsewhere (its own size and place): the layers move there
        if (shown === 'tach') {
            const pr = rect();
            if (rectKey(pr) !== placedKey) {
                cr.set(layer, pr); placedKey = rectKey(pr);
                if (navLayer) cr.set(navLayer, navPlaceOf(placeView()));
                log.info('hud: moved to ' + pr.x + ',' + pr.y + ' ' + pr.w + 'x' + pr.h + ' (the driving mode\'s own place)');
            }
        }
        // nothing to draw while the HUD isn't showing (behind BMW's content, disabled, unavailable):
        // the first frame after it is sent whole. No target event yet: draw (it may never come).
        if (paused()) {
            first = true; lastKey = ''; navFirst = true; navLast = '';
            stopReads();
            return;
        }
        // the directions: their own layer, redrawn only when what they show changes
        // a fault in the directions drops them, never the tach's frame
        // (the tyre widget in the same corner when the directions have nothing to show)
        if (shown === 'tach') { try { drawNavLayer(nv.show, nv.show ? null : tyreView(Date.now() < demoUntil)); } catch (e) { log.warn('hud: directions: ' + (e && e.stack || e)); dropNav(); } }
        // the gearbox unit is asked only while its readout is on
        // (with the options it draws with: "lights only" in Comfort / Eco Pro has no gearbox readout)
        const oNow = optsNow();
        if (src.gearbox) { if (oNow.gearbox) src.gearbox.start(); else src.gearbox.stop(); }
        // the electrical reads only for the readouts that need them (and, until known, one look for a hybrid battery)
        if (src.electrical) src.electrical.start(electricalWants(oNow));
        // the engine unit's knock values only while wanted and the engine runs
        if (src.knock) { const run = isNum(src.data().rpm) && src.data().rpm > 400; if ((oNow.knock || oNow.knockWarn) && run) src.knock.start(); else src.knock.stop(); }
        // and its fuel rate only while the fuel readout is on and the engine runs
        if (src.fuel) { const run = isNum(src.data().rpm) && src.data().rpm > 400; if (oNow.fuel && run) src.fuel.start(); else src.fuel.stop(); }
        const f = frameData();
        // the same inputs draw the same frame: skip it (idle, a steady cruise, no rpm)
        const key = frameKey(f);
        if (!first && key === lastKey) return;
        lastKey = key;
        drawHud(cur, f);
        if (first) {
            if (cr.pixels(layer, null, asBuffer(cur.d))) first = false;
        } else {
            const rs = changedBoxes(cur.d, prev.d, IW);
            if (!rs.length) return;
            cr.pixels(layer, rs, packRects(cur.d, IW, rs));
        }
        const t = prev; prev = cur; cur = t;
    });

    /** Everything drawHud's picture depends on, rounded to what shows (25 rpm ~ a pixel of bar). */
    function frameKey(f) {
        const d = f.d, c = f.cue, o = f.opts;
        const t = (v) => (isNum(v) ? Math.round(v) : '-');
        // the 7-segment layouts show the rpm to 10, the others draw a bar pixel per ~25 rpm
        const step = o.style === 'digital' || o.style === 'vfd' ? 10 : 25;
        // the burst moves until 500 ms and fades after 1200 ms; in between the picture stands still
        const age = f.chip && f.chip.burst ? (f.chip.age < 500 || f.chip.age > 1200 ? Math.floor(f.chip.age / 40) : 'h') : '';
        // the revs, the count-in and the peak only move the lights, the bar and the 7-segment digits: without them
        // (both switched off) the picture is the text, keyed by the readouts' values
        const moving = o.lights || o.bar !== false || o.style === 'digital' || o.style === 'vfd';
        return [moving && isNum(d.rpm) ? Math.round(d.rpm / step) : '-', gearText(d), f.down || 0, c.shift, c.limiter, (c.shift || c.limiter) ? f.blink : '',
            moving ? Math.round(c.from / 25) : '', moving ? Math.round(c.at / 25) : '', f.shift, f.redline, f.max, moving ? Math.round((f.peak || 0) / 25) : '',
            f.chip ? f.chip.verdict + (f.chip.text || '') + age : '', f.shake ? f.shake.join(',') : '', f.mode || '',
            f.readouts.map((r) => r.label + r.value + r.tone + (r.tyres ? r.tyres.join('/') : '')).join(','),
            o.style, o.palette, o.gear, o.rpm, o.bar, o.lights, o.gt3, o.dim, o.lightStyle, o.clearLabels, o.gearFont].join('|');
    }

    /** The tach's image layer at the current place and size, with fresh canvases (the next frame is sent whole). */
    function makeLayer() {
        const r = rect();
        // a picture, never a shader: the instrument cluster's renderer runs the HUD's shaders, and a heavy one
        // restarted the cluster on the car (1.16.1; README "HUD drawing")
        layer = cr.image({ target: 'hud', klass: 'overlay', z: 0, x: r.x, y: r.y, w: r.w, h: r.h, iw: IW, ih: IH, fps: FPS_MAX, sampling: 'bilinear' });
        if (!layer) { log.warn('hud: tach layer refused by the client'); return; }
        placedKey = rectKey(r);
        cur = new Canvas(IW, IH); prev = new Canvas(IW, IH); first = true; lastKey = '';
    }

    const showTach = safe('tach', () => {
        const r = rect();
        if (shown === 'tach') { if (layer) { cr.set(layer, r); placedKey = rectKey(r); } if (navLayer) cr.set(navLayer, navPlaceOf(placeView())); return; }
        dropLayer();
        // hidden by the driving mode: no layer yet, the timer makes it when the mode allows
        // (or the car off or switching on / off: the timer makes it once that's over, holdOff)
        const hidden = calm(Date.now() < demoUntil) === 'hide' || holdOff();
        if (!hidden) { makeLayer(); if (!layer) return; }
        claim.hold(!hidden);
        shown = 'tach';
        // (the gearbox unit is started by the tick, only while its readout shows)
        timer = setInterval(tick, Math.round(1000 / fps()));
        log.info('hud: tach on at ' + r.x + ',' + r.y + ' ' + r.w + 'x' + r.h);
    });

    /*
     * Shared with a standing HUD app (Cluster functions, kit/hud_claim.js): while Redline draws on the HUD it holds
     * it and the other gives way (not while its tach is hidden in Comfort / Eco Pro). With one there and setting
     * hudHandBack on, Redline's HUD lasts until the car is switched off (vehicle state from drive or ignition back to
     * parked) or the head unit starts again (on by default); off, it stays on.
     */
    const claim = new HudClaim('redline', log);
    // With In Comfort / Eco Pro on Don't show, Redline already gives the HUD back outside Sport (a drive starts in
    // Comfort: the standing app's HUD first, Redline's in Sport), so its HUD stays on and nothing is handed back.
    const handBack = (why) => {
        if (mode() === 'off' || !settings.get('hudHandBack') || comfortMode(settings) === 'hide' || !HudClaim.standingOn('redline')) return false;
        log.info('hud: ' + why + ': off, the HUD back to the app that stands on it');
        settings.set('hud', 'off');
        return true;
    };
    // a new start: the standing app may start after Redline, so it is looked for during START_LOOK_MS
    if (mode() !== 'off' && !claim.thisBoot()) {
        const t0 = Date.now();
        const look = setInterval(safe('start', () => {
            if (handBack('the head unit started again') || mode() === 'off' || Date.now() - t0 > START_LOOK_MS) clearInterval(look);
        }), 2000);
        if (look.unref) look.unref();
        handBack('the head unit started again');
    }
    let ignition = false;
    const condTimer = setInterval(safe('condition', () => {
        const c = src.data && src.data().condition;
        if (!isNum(c)) return;
        if (c >= 7) ignition = true;
        else if (c <= 5 && ignition) { ignition = false; handBack('the car was switched off'); }
    }), 2000);
    if (condTimer.unref) condTimer.unref();

    const apply = safe('apply', () => {
        const m = mode();
        claim.hold(m !== 'off');
        if (m === 'off') { disconnect(); return; }
        connect();
        if (!cr) return;
        if (m === 'test') showTestPattern(); else showTach();
    });

    const HUD_KEYS = ['hud', 'hudSize', 'hudX', 'hudY', 'hudNavX', 'hudNavY', 'hudNav'];
    settings.onChange(safe('setting', (key) => {
        if (key === 'hudFps' && timer) { clearInterval(timer); timer = setInterval(tick, Math.round(1000 / fps())); log.info('hud: ' + fps() + ' fps'); return; }
        if (HUD_KEYS.indexOf(key) < 0 && shown !== 'test') { first = true; return; }
        if (shown === 'test' && key !== 'hud') shown = '';         // redraw the pattern with the tach moved
        apply();
    }));
    apply();

    /** An upshift at rpm (its peak): if it followed a flash on a climb, learn the reaction time. */
    const upshift = safe('upshift', (rpm) => {
        const f = flashInfo;
        flashInfo = null;
        if (!f || !isNum(rpm) || Date.now() - f.t > 2000 || f.rate < 300) return;
        if (f.fall !== null && Date.now() - f.fall > 700) { log.debug('hud: shift after a lift, not used for the reaction time'); return; }
        // in D or S the gearbox picks the moment: only shifts made by hand (M) say anything about you
        const m = src.mode ? src.mode() : null;
        if (m === 'D' || m === 'S') return;
        const lateMs = (rpm - f.target) / f.rate * 1000;
        const ideal = reactionMs(f, rpm);
        const before = learnedLead;
        learnedLead = Math.round(clamp(learnedLead + (ideal - learnedLead) * 0.3, 0, 600) / 10) * 10;
        leadShifts++;
        log.debug('hud: shift at ' + Math.round(rpm) + ' for ' + f.target + ' (' + (lateMs >= 0 ? Math.round(lateMs) + ' ms late' : Math.round(-lateMs) + ' ms early') +
            '), reaction lead now ' + learnedLead + ' ms after ' + leadShifts + ' shifts');
        // written only when the lead moves (once settled, seldom)
        if (learnedLead !== before) writeAtomic(leadFile, JSON.stringify({ ms: learnedLead, n: leadShifts }), log);
    });

    // cluster-render is a separate install: the MGU Store's Cluster renderer
    const NOT_RUNNING = 'HUD: cluster-render not running · install Cluster renderer from the MGU Store';
    /** One line for Redline's screen: what the HUD is doing. */
    function status() {
        const m = mode();
        if (m === 'off') return '';
        if (!cr || !cr.ready) return NOT_RUNNING;
        if (target && target.disabled) return 'HUD: off after display errors';
        if (m === 'test') return 'HUD: test pattern';
        if (shown === 'tach' && !layer && (callGiving || Date.now() < callBackAt)) return 'HUD: giving way to the call';
        if (shown === 'tach' && !layer && navGiving) return 'HUD: giving way to BMW\'s directions';
        if (shown === 'tach' && !layer && holdOff()) return 'HUD: waits for the car to be switched on';
        if (shown === 'tach' && !layer) return 'HUD: hidden in Comfort / Eco Pro';
        const st = target ? target.state : '';
        if (st === 'shown') return 'HUD: on';
        if (st === 'parked' || st === 'waiting') return 'HUD: giving way to BMW';
        if (st === 'unavailable') return 'HUD: not available';
        return 'HUD: starting';
    }

    // frame: one frame's data without drawing (for tests)
    /** The learned reaction time for the Learned page: { ms, shifts, auto } (auto: the setting is on Auto). */
    function learned() { return { ms: leadMs(), shifts: leadShifts, auto: num('hudLead', -1) < 0 }; }
    /** Forget the learned reaction time (back to 200 ms). */
    function resetLead() {
        learnedLead = 200; leadShifts = 0;
        try { fs.unlinkSync(leadFile); } catch (e) { /* gone */ }
        log.info('hud: reaction time reset');
    }

    /** "Play on HUD": the scripted drive (demoAt) on the HUD for ms (two loops by default). */
    // profile: which setup plays ('sport' / 'comfort': the HUD looks page's)
    const play = safe('play', (ms, profile) => { playProfile = SETUPS[profile] ? profile : 'sport'; demoStart = Date.now(); demoUntil = demoStart + (ms || 2 * DEMO_MS); first = true; log.info('hud: playing the demo (' + playProfile + ')'); });
    const stopPlay = () => { demoUntil = 0; first = true; };

    return { stop: disconnect, status: status, upshift: upshift, lead: leadMs, learned: learned, resetLead: resetLead, frame: frameData,
        play: play, stopPlay: stopPlay, playing: () => Date.now() < demoUntil, corner: () => corner,
        /** Directions on the glass in the last tick or so (the nav log writes only then): drawn each tick while shown. */
        directionsShown: () => corner === 'nav' && monoMs() - navShownAt < 2000,
        /** Ask cluster-render for its status (the reply lands in crStatus); false when it isn't connected. */
        askStatus: () => { if (!cr || !cr.ready) return false; try { cr.status(); return true; } catch (e) { return false; } },
        /** cluster-render's last status reply { t, text }, or null. */
        crStatus: () => crStatus };
}

// writeAtomic: kept here too (it moved to files.js in 2.0) for code that calls Hud.writeAtomic
module.exports = { start, revOf, writeAtomic, navPlaceOf, BMW_SPEED, GLASS, sceneOf, useScene, scene: () => SCENE, optsFrom, PROFILE_KEYS, SETUPS, profileOf, comfortMode, setupMode, profileView, setComfortMode, setSetupMode, migrateProfiles, reactionMs, gearFontOf, M_STYLES, placeOf, outsideGlass, readoutsFor, rpmItem, electricalItems, electricalWants, MAX_READOUTS, METER_STYLES, driveModeOf, calmFor, calmOpts, demoAt, DEMO_MS, demoFrame, shiftCue, drawDown };
