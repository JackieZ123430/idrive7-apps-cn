'use strict';
/**
 * Part of Redline's experimental features; README.md in this folder has the whole picture.
 *
 * Redline's own directions on the HUD, the data side: what BMW's guidance
 * service says about the next turn and the lanes, decoded into one small object the HUD draws (hud-nav.js).
 *
 * Where it comes from (proven on a G21 with CarPlay / Apple Maps, 2026-11-09, Redline 1.16.5 probe):
 *   - GuidanceEventList.queryContent (navlog.js asks it while a route runs): viewContent[0].eventsInView[], each a
 *     union keyed by its kind (intersection, branch, roundabout, destinationManeuver, ...). The first is the next
 *     turn; a second one, when there, is the turn after it (its distance unit NONE).
 *   - Guidance.currentLaneGuiding and ProjectedModeGuiding.currentLaneGuiding (the same rows, ~1 Hz while lanes
 *     apply; rows: [] when none).
 *   - Guidance.conclusiveDart, the same union under .maneuver: BMW's own navigation (CarPlay leaves it empty).
 *   - Whether a route runs: Guidance.guidanceState / guidingProvider, CarPlay's and Android Auto's
 *     projectedGuidanceActive (guidanceState stays INACTIVE during CarPlay routes).
 * The interfaces are the ones jaimeen77's Cluster Redline reads (jaimeen77-cmyk/apps, MPL-2.0); none of its code
 * is used here, the decoder is Redline's own, written from the replies this car sent.
 *
 * The object (null when there's nothing to show):
 *   { kind, dir, geom, exit, exitAngle, side, flag, stop, dist: '450', unit: 'm', road, lanes, unreliable, t, src }
 *   kind: 'turn' (dir: TurnDirection: STRAIGHT_ON, LEFT, SLIGHT_LEFT, HARD_LEFT, UTURN_LEFT, the right ones, NONE),
 *         'branch' (dir: BranchType: BRANCH_LEFT, FORK_RIGHT, TRIPLE_FORK_STRAIGHT, HIGHWAY_OUT_RIGHT, OVERPASS...),
 *           both with geom: detailedGeometry (ManeuverGeometry: EXIT_RIGHT_TAKE_LEFT, THREE_WAY_FORK_TAKE_CENTER...)
 *           when the car gives one (null for UNDEFINED, the only value seen yet),
 *         'roundabout' (exit: the exit's number, exitAngle as the car gives it, side: the traffic side 'left' / 'right'),
 *         'keep' (dir LEFT / RIGHT: along the main road), 'lanechange' (dir LEFT / RIGHT),
 *         'destination' (dir: LEFT / CENTER / RIGHT / NOT_DIGITIZED; flag false: a stopover, stop its number),
 *         'transport' (dir FERRY / CAR_TRAIN: onto a ferry or a car train),
 *         'follow' (a kind not in the car's catalog: "follow the route")
 *   Not turns, skipped, so they never stand in for the next turn: points of interest, lane rows, traffic, route
 *   segments, tunnels, borders, toll gates, passive manoeuvres (straight through), speed cameras and limits,
 *   dangerous curves, school zones, placeholders (GAP / LOADING_INDICATOR).
 *   dist, unit: as the car formats them ('1' 'km', '450' 'm'); null when it gives none
 *   lanes: { lanes: [{ follow, others: [], hi, info }], rec, markers } or null
 *
 * Safety: a turn older than STALE_MS isn't shown. While a route runs and Redline has no turn it can read (for
 * GIVE_WAY_MS), view() says to give way, so the driver gets BMW's own card rather than nothing.
 * Never throws: everything is caught. Street names never go to a log (their length only).
 */

const STALE_MS = 3000;       // a turn or lanes older than this aren't shown
const NEAR_M = 1000;         // "Near turns": under this ("1 km" is not yet; lanes always)

const UNITS = { KM: 'km', METER: 'm', MILE_UK: 'mi', MILE_US: 'mi', YARD: 'yd', FEET: 'ft' };
const UNIT_M = { km: 1000, m: 1, mi: 1609.344, yd: 0.9144, ft: 0.3048 };

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' && isFinite(v) ? String(v) : null);

/*
 * The enums that decide an arrow, from the car's catalog (navigation.GuidingTypes, CommonTypes.DistanceUnit):
 * index = the number a firmware might send instead of the name. A value that is neither a name nor one of these
 * numbers gives no direction (the "follow the route" dot), never a guessed arrow.
 */
const ENUMS = {
    TurnDirection: ['NONE', 'STRAIGHT_ON', 'LEFT', 'SLIGHT_LEFT', 'HARD_LEFT', 'RIGHT', 'SLIGHT_RIGHT', 'HARD_RIGHT', 'UTURN_RIGHT', 'UTURN_LEFT'],
    BranchType: [null, 'BRANCH_LEFT', 'BRANCH_RIGHT', 'HIGHWAY_IN_LEFT', 'HIGHWAY_IN_RIGHT', 'HIGHWAY_IN_STRAIGHT', 'HIGHWAY_OUT_LEFT', 'HIGHWAY_OUT_RIGHT',
        'HIGHWAY_OUT_STRAIGHT', 'FORK_LEFT', 'FORK_RIGHT', 'TRIPLE_FORK_LEFT', 'TRIPLE_FORK_RIGHT', 'TRIPLE_FORK_STRAIGHT', 'OVERPASS', 'UNDERPASS'],
    Side: [null, 'LEFT', 'RIGHT'],
    DestinationPosition: [null, 'LEFT', 'CENTER', 'RIGHT', 'NOT_DIGITIZED'],
    MainRoadDirection: ['LEFT', 'RIGHT'],
    VehicleTransportationType: ['FERRY', 'CAR_TRAIN'],
    AdditionalLaneInfo: ['NONE', 'ELLIPSIS', 'BUS', 'HOV', 'SCOOTER', 'BIKE', 'TOLL_ETC', 'TOLL_CASH', 'TOLL_ETC_CASH', 'BLOCKED'],
    LaneMarker: [null, 'SOLID', 'DASHED'],
    DistanceUnit: ['NONE', 'KM', 'MILE_UK', 'MILE_US', 'METER', 'YARD', 'FEET'],
    ProjectedModeGuidingProvider: ['NONE', 'CAR_PLAY', 'ANDROID_AUTO', 'CAR_LIFE', 'OTHER'],
    ManeuverGeometry: [null, 'TWO_WAY_FORK_TAKE_LEFT', 'TWO_WAY_FORK_TAKE_RIGHT', 'THREE_WAY_FORK_TAKE_LEFT', 'THREE_WAY_FORK_TAKE_CENTER',
        'THREE_WAY_FORK_TAKE_RIGHT', 'EXIT_LEFT_TAKE_LEFT', 'EXIT_LEFT_TAKE_RIGHT', 'EXIT_RIGHT_TAKE_LEFT', 'EXIT_RIGHT_TAKE_RIGHT',
        'EXIT_LEFT_TWO_WAY_FORK_TAKE_LEFT_LEFT', 'EXIT_LEFT_TWO_WAY_FORK_TAKE_LEFT_RIGHT', 'EXIT_RIGHT_TWO_WAY_FORK_TAKE_RIGHT_LEFT',
        'EXIT_RIGHT_TWO_WAY_FORK_TAKE_RIGHT_RIGHT', 'TWO_WAY_FORK_OVERPASS_LEFT_TAKE_LEFT', 'TWO_WAY_FORK_OVERPASS_LEFT_TAKE_RIGHT',
        'TWO_WAY_FORK_OVERPASS_RIGHT_TAKE_LEFT', 'TWO_WAY_FORK_OVERPASS_RIGHT_TAKE_RIGHT', 'TWO_WAY_FORK_UNDERPASS_LEFT_TAKE_LEFT',
        'TWO_WAY_FORK_UNDERPASS_LEFT_TAKE_RIGHT', 'TWO_WAY_FORK_UNDERPASS_RIGHT_TAKE_LEFT', 'TWO_WAY_FORK_UNDERPASS_RIGHT_TAKE_RIGHT',
        'TWO_WAY_FORK_OVERPASS_LEFT_UNDERPASS_RIGHT_TAKE_LEFT', 'TWO_WAY_FORK_OVERPASS_LEFT_UNDERPASS_RIGHT_TAKE_RIGHT',
        'TWO_WAY_FORK_UNDERPASS_LEFT_OVERPASS_RIGHT_TAKE_LEFT', 'TWO_WAY_FORK_UNDERPASS_LEFT_OVERPASS_RIGHT_TAKE_RIGHT',
        'THREE_WAY_FORK_OVERPASS_CENTER_TAKE_LEFT', 'THREE_WAY_FORK_OVERPASS_CENTER_TAKE_CENTER', 'THREE_WAY_FORK_OVERPASS_CENTER_TAKE_RIGHT',
        'THREE_WAY_FORK_UNDERPASS_CENTER_TAKE_LEFT', 'THREE_WAY_FORK_UNDERPASS_CENTER_TAKE_CENTER', 'THREE_WAY_FORK_UNDERPASS_CENTER_TAKE_RIGHT'],
};
/** An enum value as its catalog name, or null (not a name or number of that enum). */
function enumOf(type, v) {
    const names = ENUMS[type];
    if (typeof v === 'string') return names.indexOf(v) >= 0 ? v : null;
    if (typeof v === 'number' && v >= 0 && v < names.length && v === Math.floor(v)) return names[v];
    return null;
}

/** The union's kind and its body: { kind, body } for { intersection: {...} } (null / undefined members ignored). */
function unionOf(e) {
    if (!isObj(e)) return null;
    const keys = Object.keys(e).filter((k) => isObj(e[k]));
    if (keys.length !== 1) return null;
    return { kind: keys[0], body: e[keys[0]] };
}

/** The street (or exit) name: the description's text pieces joined. '' when none. */
function roadOf(b) {
    const els = b && b.description && Array.isArray(b.description.elements) ? b.description.elements : [];
    return els.map((x) => (x && typeof x.text === 'string' ? x.text : '')).filter((s) => s).join(' ').trim();
}

/** Text safe for one log line or the HUD's fonts: no control characters, any space as a plain one. */
function safeLog(t) { return String(t).replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\s\u00a0\u2000-\u200b\u202f\u205f\u3000]+/g, ' ').trim(); }
const FRACTIONS = { '\u00bd': '.5', '\u00bc': '.25', '\u00be': '.75' };
/**
 * formattedDistance as the car gives it: { dist: '450', unit: 'm', uk }; unit NONE (or unknown): no distance.
 * The text made safe: control characters out, odd spaces plain, fractions (\u00bd mi) as decimals, a unit the car
 * put in the text too ("0 m") taken out. uk: UK miles and yards (the "then" gap in yards, not feet).
 */
function distOf(b) {
    const f = b && b.formattedDistance, unitName = f ? enumOf('DistanceUnit', f.unit) : null;
    let d = f ? str(f.distance) : null;
    const u = unitName ? UNITS[unitName] : null;
    if (d !== null) {
        d = safeLog(d).replace(/^(\d*)([\u00bd\u00bc\u00be])/, (x, n, fr) => (n || '0') + FRACTIONS[fr]);
        if (u) d = d.replace(new RegExp('\\s*' + u + '$', 'i'), '').trim();
    }
    if (!d || !u || !/\d/.test(d)) return { dist: null, unit: null, uk: false };
    return { dist: d, unit: u, uk: unitName === 'MILE_UK' || unitName === 'YARD' };
}

/** About how far, in metres, from the car's own text ('0,5' km = 500 m); null if it can't be read. */
function metres(m) {
    if (!m || !m.dist || !m.unit) return null;
    // "1,234" and "1 234" (thousands) are 1234, "1,5" (a decimal comma) is 1.5
    const t = String(m.dist).trim(), v = parseFloat(/^\d{1,3}([, ]\d{3})+$/.test(t) ? t.replace(/[, ]/g, '') : t.replace(',', '.'));
    return isFinite(v) ? v * UNIT_M[m.unit] : null;
}

/*
 * Union members (GuidanceEventUnion, 22 in the car's catalog) that aren't a manoeuvre: skipped. Most aren't asked
 * for (eventQuery's includedTypes), but if one comes it mustn't hide the turn after it.
 */
const SKIP = { pointOfInterest: 1, laneGuiding: 1, trafficEvent: 1, trafficFlowItem: 1, routeSegmentItem: 1, placeholderElement: 1,
    tunnel: 1, border: 1, tollgate: 1, passiveManeuver: 1, speedLimitAssist: 1, speedLimit: 1, speedCamera: 1, speedSectionCamera: 1,
    dangerousCurve: 1, schoolZone: 1 };
/** detailedGeometry when it says something (not UNDEFINED / NONE / missing). */
function geomOf(b) { return enumOf('ManeuverGeometry', b.detailedGeometry); }


/**
 * One route event (an eventsInView item, or conclusiveDart.maneuver) as Redline's object, without t / src / lanes.
 * null for kinds that aren't a manoeuvre (lane rows, points of interest, empty).
 */
function decodeEvent(e) {
    const u = unionOf(e);
    if (!u) return null;
    const b = u.body, d = distOf(b);
    if (SKIP[u.kind]) return null;
    const dtd = Number(b.distanceToDestination);
    const m = { kind: null, dir: null, geom: null, exit: null, exitAngle: null, side: null, flag: null, stop: null, dist: d.dist, unit: d.unit, uk: d.uk, road: roadOf(b), unreliable: b.unreliable === true,
        dtd: isFinite(dtd) && dtd >= 0 ? dtd : null };
    switch (u.kind) {
    case 'intersection':
        m.kind = 'turn'; m.dir = enumOf('TurnDirection', b.direction) || 'NONE'; m.geom = geomOf(b);
        break;
    case 'branch':
        m.kind = 'branch'; m.dir = enumOf('BranchType', b.branchType) || 'NONE'; m.geom = geomOf(b);
        break;
    case 'roundabout': {
        m.kind = 'roundabout';
        const n = Number(b.exitNumber), a = Number(b.exitAngle);
        // UInt8 / UInt16 in the catalog: 255 / 65535-like values are "unknown", not exit 255 or a 15 degree angle
        m.exit = isFinite(n) && n > 0 && n < 100 ? Math.round(n) : null;
        m.exitAngle = isFinite(a) && a >= -360 && a <= 720 ? ((a % 360) + 360) % 360 : null;
        // driveDirection: the traffic side (LEFT: drive on the left, clockwise roundabouts; seen: LEFT on the drive, in
        // Australia, with a lane for right turns and U-turns). exitAngle: degrees clockwise from straight on (hud-nav.js)
        // missing or unknown: left (the only side seen on a car yet; the arrow still points at the exit's angle)
        m.side = enumOf('Side', b.driveDirection) === 'RIGHT' ? 'right' : 'left';
        break;
    }
    case 'alongMainRoad':
        m.kind = 'keep'; m.dir = enumOf('MainRoadDirection', b.mainRoadDirection) || 'NONE';
        break;
    case 'laneChange':
        m.kind = 'lanechange'; m.dir = enumOf('Side', b.changeSide) || 'NONE';
        break;
    case 'destinationManeuver':
        m.kind = 'destination'; m.dir = enumOf('DestinationPosition', b.position) || 'CENTER';
        // a stopover on the way: isCheckeredFlag false (the drive's destination: true)
        m.flag = b.isCheckeredFlag !== false;
        m.stop = isFinite(Number(b.stopOverNumber)) && Number(b.stopOverNumber) > 0 ? Math.round(Number(b.stopOverNumber)) : null;
        break;
    case 'vehicleTransportation':
        m.kind = 'transport'; m.dir = enumOf('VehicleTransportationType', b.type) || 'FERRY';
        break;
    default:
        // a kind newer than the catalog: shown as "follow the route" (a dot) if it has a distance, logged by kind
        if (!b.formattedDistance) return null;
        m.kind = 'follow'; m.dir = u.kind;
    }
    return m;
}

/**
 * A queryContent reply: { ok, error, events: [decoded...], raw: number of events }. ok false: an error reply or no
 * view (the turn isn't known; not the same as "no turns ahead").
 */
function decodeEvents(reply) {
    const out = { ok: false, error: null, events: [], raw: 0, uids: [] };
    if (!isObj(reply)) { out.error = 'no reply'; return out; }
    const err = reply.GuidanceEventListError;
    if (err !== undefined && err !== 'NO_ERROR' && err !== 0) { out.error = String(err); return out; }
    const v = Array.isArray(reply.viewContent) ? reply.viewContent[0] : null;
    const evs = v && Array.isArray(v.eventsInView) ? v.eventsInView : null;
    if (!evs) { out.error = 'no view'; return out; }
    out.ok = true; out.raw = evs.length;
    evs.forEach((e) => {
        const body = e && isObj(e.maneuver) ? e.maneuver : e, m = decodeEvent(body);
        if (!m) return;
        // each event's uid (CarPlay numbers its turns 1, 2, 3...: an older turn has a smaller one), null without
        const u = unionOf(body), uid = u && u.body ? Number(u.body.uid) : NaN;
        out.events.push(m); out.uids.push(isFinite(uid) ? uid : null);
    });
    return out;
}

/** The kinds in a reply (the union keys), for the log. */
function kindsOf(reply) {
    const v = isObj(reply) && Array.isArray(reply.viewContent) ? reply.viewContent[0] : null;
    const evs = v && Array.isArray(v.eventsInView) ? v.eventsInView : [];
    return evs.map((e) => { const u = unionOf(e && isObj(e.maneuver) ? e.maneuver : e); return u ? u.kind : '?'; });
}

/** Guidance.conclusiveDart: its manoeuvre, or null (CarPlay leaves it at an empty pointOfInterest). */
function decodeDart(v) {
    return isObj(v) && isObj(v.maneuver) ? decodeEvent(v.maneuver) : null;
}

/**
 * currentLaneGuiding: { lanes: [{ follow, others, hi, info }], rec, markers } for the first row, or null (no rows).
 *   follow: the arrow to take in that lane (NONE: none, the lane isn't for this route), others: its other arrows,
 *   hi: highlighted (a lane to be in), info: additionalLaneInfo (NONE, bus, HOV...), rec: the recommended lane's
 *   index, markers: the lines between lanes (DASHED / SOLID), one more than lanes.
 */
function decodeLanes(v) {
    const row = isObj(v) && Array.isArray(v.rows) ? v.rows[0] : null;
    if (!isObj(row) || !Array.isArray(row.lanes) || !row.lanes.length) return null;
    // at most 16 (the HUD shows 6 of them, round the ones to take: hud-nav.js laneWindow)
    const lanes = row.lanes.slice(0, 16).map((l) => {
        l = isObj(l) ? l : {};
        // the arrows to take: directionsToFollow (a lane can be for straight on and right), else directionToFollow
        const list = (a) => (Array.isArray(a) ? a : []).map((x) => enumOf('TurnDirection', x)).filter((s) => s && s !== 'NONE');
        let follows = list(l.directionsToFollow);
        const one = enumOf('TurnDirection', l.directionToFollow) || 'NONE';
        if (one !== 'NONE' && follows.indexOf(one) < 0) follows = [one].concat(follows);
        const others = list(l.otherDirections).filter((s) => follows.indexOf(s) < 0);
        return { follow: follows[0] || 'NONE', follows: follows, others: others, hi: l.isHighlighted === true, info: enumOf('AdditionalLaneInfo', l.additionalLaneInfo) || 'NONE' };
    });
    const rec = Number(row.recommendedCarPositionLaneIndex);
    return {
        lanes: lanes,
        rec: isFinite(rec) && rec >= 0 && rec < lanes.length ? rec : null,
        markers: Array.isArray(row.laneMarkers) ? row.laneMarkers.map((x) => enumOf('LaneMarker', x)) : [],
    };
}

/** A route for certain: BMW's guidance active, or the phone's (CarPlay / Android Auto) guiding. */
function routeSure(r) { return r.state === 'ACTIVE' || r.state === 2 || r.carplay === true || r.aa === true; }
/**
 * Two phones and no telling whose turns these are: both say they're guiding, or BMW names one as the provider while
 * the other says it's guiding (the check jaimeen77's Cluster Redline makes: "navigation_provider_mismatch").
 * No arrow then (it could be the other phone's route), and no giving way either: the tach stays.
 */
function phonesMismatch(r) {
    if (r.carplay === true && r.aa === true) return true;
    return (r.provider === 'CAR_PLAY' && r.aa === true && r.carplay !== true) || (r.provider === 'ANDROID_AUTO' && r.carplay === true && r.aa !== true);
}
/** True while some navigation runs: BMW's own, or the phone's (CarPlay / Android Auto). */
function routingOf(r) {
    return r.state === 'ACTIVE' || r.state === 2 || r.carplay === true || r.aa === true ||
        (r.provider !== null && r.provider !== undefined && r.provider !== 'NONE' && r.provider !== 0);
}

/*
 * "Then": the turn after the next, when it comes close behind it (to be in the right lane for both: two lanes turn
 * right and the next turn is left: the left one of them). CarPlay sends a second turn only when Apple Maps shows
 * its own "Then" (the 2026-11-09 drive: a motorway exit then a right turn, straight on then right, a roundabout then
 * the destination), with no distance (unit NONE, rawDistance a fixed 500, the same distance to the destination):
 * shown as it comes. With a distance (BMW's own navigation lists every turn), shown only within THEN_M.
 */
const THEN_M = 150;          // 11 s at 50 km/h: time to pick the lane for both turns
/*
 * Two things the 2026-11-09 drive showed CarPlay doing (redline-nav-carplay-2026-11-09.txt), both seen on the HUD as
 * a "then" that made no sense (2026-11-10 drive: a roundabout straight on, "then" a left / right):
 *   - just after a turn, for one reply, the turn just made listed after the new one (07:27:33: straight on, "then"
 *     the right just taken). Its uid is older (smaller) than the new turn's: dropped (staleThen).
 *   - after a straight on, the turn after it however far it is (07:27:35: straight on, "then" a motorway exit 5.1 km
 *     on). The phone gives no gap (the second turn carries the first's distance to the destination). The two real
 *     "then"s of the drive came after a turn (an exit, then right 360 m on; a roundabout, then the destination
 *     250 m on). So with no gap known, no "then" after a straight on (a roundabout's straight-on exit included).
 */
const STRAIGHT_DEG = 30;     // a roundabout exit within this of straight on counts as straight on
/** Whether m goes straight on (no turn to make: its "then", with no gap, may be far away). */
function straightOn(m) {
    if (!m) return false;
    if (m.kind === 'turn') return m.dir === 'STRAIGHT_ON';
    if (m.kind === 'roundabout' && typeof m.exitAngle === 'number') return Math.min(m.exitAngle, 360 - m.exitAngle) <= STRAIGHT_DEG;
    return false;
}
/** Whether the second event is older than the first (the turn just made, still listed): uids from decodeEvents. */
function staleThen(uids) {
    return !!uids && typeof uids[0] === 'number' && typeof uids[1] === 'number' && uids[1] < uids[0];
}
/** The hint for the turn after a: { kind, dir, ..., gap: metres between them or null }, or null (none, or too far). */
function thenOf(a, b) {
    if (!a || !b || b.kind === 'follow') return null;
    const same = [a.kind, a.dir, a.geom, a.exit, a.road].join('|') === [b.kind, b.dir, b.geom, b.exit, b.road].join('|');
    // how far apart: shown only from the distances to the destination (exact); the turns' own texts are rounded
    // (300 m / 1.1 km), good enough to decide, not to print
    let gap = null, shown = false;
    if (a.dtd !== null && b.dtd !== null && a.dtd - b.dtd > 0) { gap = a.dtd - b.dtd; shown = true; }
    else if (metres(a) !== null && metres(b) !== null && metres(b) >= metres(a)) gap = metres(b) - metres(a);
    if (same && (gap === null || gap <= 0)) return null;           // the same turn listed twice
    // no distance at all: the phone decided it's close (it sends a second turn only then)
    if (gap === null) return b.dist === null && !straightOn(a) ? Object.assign({}, b, { gap: null }) : null;
    return gap <= THEN_M ? Object.assign({}, b, { gap: shown ? gap : null }) : null;
}

/** One short log line for a manoeuvre, without the street (its length only). */
function describe(m) {
    if (!m) return 'none';
    const kindOf = (x) => (x.kind === 'roundabout' ? 'roundabout exit ' + (x.exit || '?') + (x.exitAngle !== null && x.exitAngle !== undefined ? ' at ' + x.exitAngle : '') + ' (' + x.side + ')'
        : x.kind + ' ' + x.dir + (x.geom ? ' ' + x.geom : '') + (x.kind === 'destination' && x.flag === false ? ' stopover ' + (x.stop || '?') : ''));
    const what = kindOf(m);
    return what + ' ' + (m.dist ? safeLog(m.dist) + ' ' + m.unit : '-') + (m.road ? ' <' + m.road.length + ' chars>' : '') +
        (m.lanes ? ' lanes ' + m.lanes.lanes.map((l) => (l.hi ? '*' : '') + l.follow).join(',') : '') + (m.unreliable ? ' unreliable' : '') +
        (m.then ? ' then ' + kindOf(m.then) + (m.then.gap !== null ? ' after ' + Math.round(m.then.gap) + ' m' : '') : '');
}

/*
 * Giving way, and why it's rare and lasts for the route (2026-11-09 lifecycle review, cluster-render's README):
 * when Redline drops its layers the HUD slot stays mapped, empty and transparent for hud_linger_ms (3 s, after a
 * 250 ms fade): nothing shows, neither the tach nor BMW's card. Then BMW's card (parked behind Redline) is shown,
 * and Redline asking again is parked behind it until BMW unmaps it, at the route's end. So:
 *   - Redline gives way only after GIVE_WAY_MS with no readable turn on a route for certain, counted from the
 *     latest of the route's start, the last readable turn and the directions coming back on: short gaps (a slow or
 *     failed call, a reply without a turn, the shared native queue busy) show the tach without an arrow, never a
 *     stale one, and never blank the HUD.
 *   - Never for a guide whose turns it has read this drive (2026-11-10: a U-turn in a cul-de-sac, Apple Maps
 *     working out the new route for over 15 s, Redline gave way and BMW's card stuck on "Calculating Route" for the
 *     rest of the trip). Its turns will come again: the tach without an arrow until they do.
 *   - Once it has given way it stays out for the route (no flapping, no blank gaps): until the route ends, or no
 *     reply at all has come for BACK_MS (CarPlay unplugged with its "guiding" flag left on). Coming back while
 *     BMW's card is up only parks Redline behind it.
 */
const GIVE_WAY_MS = 15000;
const BACK_MS = 60000;
/** A clock that never jumps (the head unit's time is set from GPS, backwards or forwards): ms. */
function mono() { const t = process.hrtime(); return t[0] * 1000 + t[1] / 1e6; }

/**
 * The state behind the HUD's directions: fed the values as they come (with the time), asked for what to show.
 * now is a parameter everywhere so the tests can drive the clock.
 */
function Tracker() {
    const route = { state: null, provider: null, carplay: false, aa: false, since: null, sureSince: -Infinity, resetAt: -Infinity, sureSeen: false };
    let turn = null, turnAt = 0, dart = null, dartAt = 0, lanes = null, lanesAt = -Infinity, lastErr = null;
    // the last readable turn (giving way counts from it), the last reply of any kind, the current turn's identity
    let lastTurnAt = -Infinity, lastDataAt = -Infinity, turnKey = '';
    // given way for this route; when the directions were last asked for (coming back on after a pause restarts the count)
    let gaveWay = false, lastViewAt = -Infinity, resumedAt = -Infinity;
    // the guides whose turns Redline has read this drive (CAR_PLAY, ANDROID_AUTO, BMW): never given way to again
    const readable = {};
    // a phone left named as the provider after its route was cancelled, on a car that sends the phones' "guiding"
    // flags (sureSeen) with that flag off: it's BMW's own route now, not the phone's (2026-11-10 review: BMW's nav
    // started after a cancelled CarPlay route counted as CarPlay, read this drive, so Redline never gave way to it)
    const phoneOff = (p) => route.sureSeen && ((p === 'CAR_PLAY' && !route.carplay) || (p === 'ANDROID_AUTO' && !route.aa));
    const guide = () => {
        if (route.carplay) return 'CAR_PLAY';
        if (route.aa) return 'ANDROID_AUTO';
        const p = route.provider && route.provider !== 'NONE' && route.provider !== 0 ? String(route.provider) : 'BMW';
        return phoneOff(p) ? 'BMW' : p;
    };
    const keyOf = (m) => (m ? [m.kind, m.dir, m.geom, m.exit, m.exitAngle, m.road].join('|') : '');
    const seen = (m, now) => {
        if (!m) return;
        readable[guide()] = true;
        const k = keyOf(m), before = lastTurnAt;
        lastTurnAt = now;
        if (k === turnKey) return;
        // a new turn (a reroute, or the last one passed): lanes from before the old turn was last confirmed were the
        // old turn's (2026-11-09 review: a reroute to a U-turn kept the old turn's lanes for 3 s)
        if (turnKey !== '' && lanesAt <= before) lanes = null;
        turnKey = k;
    };
    /** Showing needs a route: once CarPlay / Android Auto / BMW said for certain, that; else the provider will do. */
    const routing = () => (route.sureSeen ? routeSure(route) : routingOf(route));
    const reset = (now) => { turn = null; dart = null; lanes = null; turnKey = ''; route.resetAt = now; };
    const self = {
        /** A field of one of the sources (navlog.js's names): guidance / phone / carplay / androidauto; 'available'. */
        field(src, name, v, now) {
            const was = routing(), wasSure = routeSure(route), oldProvider = route.provider;
            if (name === 'available') {
                // a source gone: its route flags with it (the car may not send "not guiding" first)
                if (v !== false) return;
                if (src === 'carplay') route.carplay = false;
                else if (src === 'androidauto') route.aa = false;
                else if (src === 'guidance') { route.state = null; route.provider = null; dart = null; }
            } else if (src === 'guidance' && name === 'guidanceState') route.state = v;
            // by name or number (the catalog's ProjectedModeGuidingProvider); something else kept as it came
            else if (src === 'guidance' && name === 'guidingProvider') route.provider = v === null || v === undefined ? null : enumOf('ProjectedModeGuidingProvider', v) || String(v);
            else if (name === 'projectedGuidanceActive') route[src === 'carplay' ? 'carplay' : 'aa'] = v === true;
            else if (name === 'conclusiveDart') { dart = decodeDart(v); dartAt = now; seen(dart, now); }
            else if (name === 'currentLaneGuiding') { lanes = decodeLanes(v); lanesAt = now; }
            if (routeSure(route)) route.sureSeen = true;
            // the phone named as the provider says it isn't guiding (CarPlay can stay the provider after a cancel,
            // also when Redline starts after it): its flag counts from now on, the provider alone no longer does
            if (name === 'projectedGuidanceActive' && v === false && route.provider === (src === 'carplay' ? 'CAR_PLAY' : 'ANDROID_AUTO')) route.sureSeen = true;
            // giving way counts from when the route became certain, not from the provider (it may be set long before)
            if (routeSure(route) && !wasSure) route.sureSince = now;
            const is = routing();
            if (is && !was) route.since = now;
            // the route ended (or stopped being certain: the provider may stay CAR_PLAY after a cancel) or changed
            // hands: nothing old comes back, nor a reply asked for before it; giving way is over
            if ((was && !is) || (wasSure && !routeSure(route)) || route.provider !== oldProvider) {
                reset(now);
                // (sureSeen stays: a car that sends "guiding" flags always does, so the provider alone never counts again)
                if (!is) { route.since = null; gaveWay = false; }
                // another provider took the route (BMW to the phone, or back): its turns may be readable, so giving
                // way starts over and counts from now
                else if (route.provider !== oldProvider) { gaveWay = false; route.sureSince = now; }
            }
        },
        /**
         * A queryContent reply; askedAt: when it was asked. One asked before the route ended or changed hands
         * (a 900 ms query in flight) is dropped: it would put the old route's arrow back.
         */
        events(reply, now, askedAt) {
            if (typeof askedAt === 'number' && askedAt <= route.resetAt) return { ok: false, error: 'from before the route changed', events: [], raw: 0, stale: true };
            const r = decodeEvents(reply);
            if (!r.ok) { lastErr = r.error; return r; }
            lastErr = null; lastDataAt = now;
            turn = r.events[0] ? Object.assign({}, r.events[0], { then: staleThen(r.uids) ? null : thenOf(r.events[0], r.events[1]) }) : null; turnAt = now;
            seen(turn, now);
            return r;
        },
        /** The query failed (timeout, refused): the old turn just goes stale. */
        failed(err) { lastErr = String(err); },
        routing: routing,
        /** The next turn, with its lanes, or null. Phone turns first, then BMW's own. */
        current(now) {
            // BMW's own turn is only sent when it changes (standing at the lights it doesn't): fresh while its
            // guidance is active
            const dartOk = dart && (now - dartAt <= STALE_MS || route.state === 'ACTIVE' || route.state === 2);
            let m = turn && now - turnAt <= STALE_MS ? turn : dartOk ? dart : null;
            if (!m) return null;
            // lanes stay with their turn (the car may send them only when they change); rows: [], the route ending or
            // a new turn clear them
            m = Object.assign({}, m, { lanes: lanes, t: m === turn ? turnAt : dartAt, src: m === turn ? 'events' : 'dart' });
            return m;
        },
        /**
         * What the HUD does: { show: object | null, giveWay }. mode: 'off' | 'route' | 'near'.
         * giveWay: Redline out of the way for BMW's card (see above).
         */
        view(mode, now) {
            // asked again after a pause (the HUD or its directions were off, Comfort hid it): the count starts again
            if (now - lastViewAt > 2000) resumedAt = now;
            lastViewAt = now;
            if (mode === 'off') return { show: null, giveWay: false };
            if (!routing()) { gaveWay = false; return { show: null, giveWay: false }; }
            if (phonesMismatch(route)) return { show: null, giveWay: false, mismatch: true };
            if (gaveWay) {
                // out for the route; back when nothing has answered for BACK_MS (a flag left on by a phone that's gone)
                if (now - Math.max(lastDataAt, route.sureSince, resumedAt) < BACK_MS) return { show: null, giveWay: true };
                gaveWay = false; resumedAt = now;
            }
            const m = self.current(now);
            if (!m) {
                // never for a phone's route (CarPlay, Android Auto): BMW's card for it is drawn from the same turns
                // Redline reads, so with none readable there's no card either, and stepping aside left the HUD empty
                // (2026-11-10, issue #91: Waze guiding, Cluster functions' map held off too). The tach stays, no arrow.
                const g = guide();
                if (g !== 'CAR_PLAY' && g !== 'ANDROID_AUTO' && routeSure(route) && !readable[g] && now - Math.max(route.sureSince, lastTurnAt, resumedAt) >= GIVE_WAY_MS) gaveWay = true;
                return { show: null, giveWay: gaveWay };
            }
            if (mode === 'near') {
                const d = metres(m);
                if (!m.lanes && (d === null || d >= NEAR_M)) return { show: null, giveWay: false };
            }
            return { show: m, giveWay: false };
        },
        error: () => lastErr,
    };
    return self;
}

/**
 * start(ctx, log, probe): the tracker, fed by the navigation probe (navlog.js's tap), and a line in redline-nav.log
 * for each change of what would show. Returns { tap, view(mode), routing() }. Times: mono().
 */
function start(ctx, log, probe) {
    const T = Tracker();
    let lastLine = '', lastGive = false;
    const note = (s) => { if (probe && probe.write) probe.write(s); };
    const tap = (src, name, v, askedAt) => {
        try {
            const now = mono();
            if (src === 'events') {
                if (name === 'reply') {
                    const r = T.events(v, now, askedAt);
                    if (r.stale) return;
                    if (!r.ok) note('dir: event list ' + safeLog(r.error));
                    else if (r.raw && !r.events.length) note('dir: no turn in ' + kindsOf(v).join(','));
                } else if (name === 'error') T.failed(v);
                return;
            }
            T.field(src, name, v, now);
        } catch (e) { note('dir: error ' + e); }
    };
    return {
        tap: tap,
        view(mode) {
            try {
                const v = T.view(mode, mono());
                const line = v.show ? describe(v.show) : v.giveWay ? 'giving way to BMW (no turn data)' : v.mismatch ? 'two phones, no telling whose route: no arrow' : 'none';
                // the distance counting down isn't a new line: what changed apart from it
                const core = line.replace(/ [\d.,]+ (km|m|mi|yd|ft)\b/, '');
                if (core !== lastLine) { lastLine = core; note('dir: ' + line); }
                if (v.giveWay !== lastGive) { lastGive = v.giveWay; if (log) log.info('hud: ' + (v.giveWay ? 'route without readable turns, BMW\'s directions shown' : 'own directions')); }
                return v;
            } catch (e) { return { show: null, giveWay: false }; }
        },
        routing: () => T.routing(),
    };
}

module.exports = { start, mono, BACK_MS, thenOf, THEN_M, straightOn, staleThen, SKIP, Tracker, decodeEvent, decodeEvents, decodeLanes, decodeDart, metres, describe, routingOf, STALE_MS, GIVE_WAY_MS };
