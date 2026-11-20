'use strict';
// Redline's own HUD directions, the data side (apps/redline/nav.js): the decoder, run on the replies a G21 sent with
// CarPlay / Apple Maps (2026-11-09, Redline 1.16.5's probe; street names already replaced by their length), then the
// tracker's freshness and give-way rules on a driven clock, then the probe's tap. Node 8 compatible.
//   node kit/tools/test_redline_nav.js
const fs = require('fs'), os = require('os'), path = require('path');
const APP = path.join(__dirname, '..', '..', 'apps', 'redline');
const Nav = require(path.join(APP, 'nav'));
const NavLog = require(path.join(APP, 'navlog'));

const TH = require('./redline_test_harness');
const tally = TH.counter(), ok = tally.ok;
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');

// ---- the car's replies -------------------------------------------------------------------------------------------
const FIX = path.join(__dirname, 'fixtures', 'redline-nav-carplay-2026-11-09.txt');
const rows = fs.readFileSync(FIX, 'utf8').trim().split('\n').map((l) => {
    const m = l.match(/^(\S+) nav: (\S+) (?:(\S+) )?= (.*)$/);
    return m ? { t: Date.parse(m[1]), src: m[2], field: m[3] || '', v: JSON.parse(m[4]) } : null;
}).filter((r) => r);
const replies = rows.filter((r) => r.src === 'events');
const laneRows = rows.filter((r) => r.field === 'currentLaneGuiding');
ok(replies.length === 149 && laneRows.length > 100, 'the fixture has the drive\'s replies (' + replies.length + ' events, ' + laneRows.length + ' lanes)');

// every reply decodes, its first event is a manoeuvre with a distance; the second (the turn after it) has none
const firsts = [], kinds = {};
replies.forEach((r, i) => {
    const d = Nav.decodeEvents(r.v);
    if (!d.ok) { ok(false, 'reply ' + i + ' decodes: ' + d.error); return; }
    ok(d.events.length === d.raw, 'reply ' + i + ': every event is a manoeuvre (' + d.events.length + '/' + d.raw + ')');
    const m = d.events[0];
    firsts.push(m);
    kinds[m.kind] = (kinds[m.kind] || 0) + 1;
    ok(m.dist && /^\d+(\.\d+)?$/.test(m.dist) && (m.unit === 'm' || m.unit === 'km'), 'reply ' + i + ': the next turn has a distance (' + m.dist + ' ' + m.unit + ')');
    ok(/^<\d+ chars>$/.test(m.road), 'reply ' + i + ': its description is the road (' + m.road + ')');
    if (d.events[1]) ok(d.events[1].dist === null && d.events[1].unit === null, 'reply ' + i + ': the turn after it, unit NONE: no distance');
});
eq(Object.keys(kinds).sort().map((k) => k + ' ' + kinds[k]), ['branch 41', 'destination 5', 'roundabout 13', 'turn 90'], 'the drive\'s next turns by kind');

// the first reply: left in 1 km
eq(Nav.decodeEvents(replies[0].v).events[0], { kind: 'turn', dir: 'LEFT', geom: null, exit: null, exitAngle: null, side: null, flag: null, stop: null, dist: '1', unit: 'km', uk: false, road: '<12 chars>', unreliable: false, dtd: 8985 },
    'first reply: a left turn in 1 km (rawDistance 1 isn\'t metres)');
// directions seen
const dirs = {};
firsts.filter((m) => m.kind === 'turn').forEach((m) => { dirs[m.dir] = true; });
eq(Object.keys(dirs).sort(), ['LEFT', 'RIGHT', 'STRAIGHT_ON'], 'turn directions seen');
// the motorway exit counted down from 4.7 km to metres
const exits = firsts.filter((m) => m.kind === 'branch');
ok(exits.every((m) => m.dir === 'BRANCH_LEFT'), 'the exit is BRANCH_LEFT');
ok(exits[0].dist === '5.1' && exits[0].unit === 'km' && exits.some((m) => m.dist === '4.7') && exits.some((m) => m.unit === 'm'), 'the exit counts down from 5.1 km into metres (' + exits[0].dist + ' ' + exits[0].unit + ')');
ok(Nav.metres(exits[0]) === 5100, '5.1 km is 5100 m');
// the roundabout: first exit at 307 degrees, island on the left
const rb = firsts.filter((m) => m.kind === 'roundabout')[0];
ok(rb.exit === 1 && rb.exitAngle === 307 && rb.side === 'left' && rb.dir === null, 'roundabout: exit 1 at 307, anticlockwise (' + Nav.describe(rb) + ')');
// arrival on the left
const dest = firsts.filter((m) => m.kind === 'destination')[0];
ok(dest.dir === 'LEFT', 'destination on the left');
// distances only ever count down for one turn (the same kind and direction in a row)
let rises = 0;
for (let i = 1; i < firsts.length; i++) {
    const a = firsts[i - 1], b = firsts[i];
    if (a.kind === b.kind && a.dir === b.dir && a.road === b.road && Nav.metres(b) > Nav.metres(a) + 150) rises++;
}
ok(rises <= 2, 'distances count down per turn (' + rises + ' rises)');
// metres() from the car's text
ok(Nav.metres({ dist: '1,234', unit: 'ft' }) === 1234 * 0.3048 && Nav.metres({ dist: '1,5', unit: 'km' }) === 1500, 'metres(): "1,234 ft" is thousands, "1,5 km" a decimal comma');
ok(Nav.metres({ dist: '450', unit: 'm' }) === 450 && Nav.metres({ dist: '0,5', unit: 'km' }) === 500 && Nav.metres({ dist: null, unit: null }) === null, 'metres() reads 450 m, 0,5 km, none');

// ---- lanes ---------------------------------------------------------------------------------------------------------
const lanes = laneRows.map((r) => Nav.decodeLanes(r.v));
ok(lanes.some((l) => l === null), 'rows: [] decode to no lanes');
const pats = {};
lanes.filter((l) => l).forEach((l) => { pats[l.lanes.map((x) => (x.hi ? '*' : '') + x.follow + (x.others.length ? '/' + x.others.join('+') : '')).join(' ') + ' rec' + l.rec] = true; });
eq(Object.keys(pats).sort(), [
    'NONE/LEFT *RIGHT/STRAIGHT_ON rec1',
    '*SLIGHT_LEFT NONE/STRAIGHT_ON NONE/STRAIGHT_ON rec0',
    '*STRAIGHT_ON *STRAIGHT_ON NONE/RIGHT rec1',
    '*STRAIGHT_ON NONE/RIGHT rec0',
    'NONE/STRAIGHT_ON *RIGHT/UTURN_RIGHT rec1',
].sort(), 'the drive\'s five lane pictures');
const three = lanes.filter((l) => l && l.lanes.length === 3 && l.lanes[2].others[0] === 'RIGHT')[0];
eq(three, { lanes: [{ follow: 'STRAIGHT_ON', follows: ['STRAIGHT_ON'], others: [], hi: true, info: 'NONE' }, { follow: 'STRAIGHT_ON', follows: ['STRAIGHT_ON'], others: [], hi: true, info: 'NONE' }, { follow: 'NONE', follows: [], others: ['RIGHT'], hi: false, info: 'NONE' }],
    rec: 1, markers: ['DASHED', 'DASHED', 'DASHED', 'DASHED'] }, '3 lanes: two straight on highlighted, the right one not');
// BMW's and the phone's lane lines are the same data
const phone = laneRows.filter((r) => r.src === 'phone'), bmw = laneRows.filter((r) => r.src === 'guidance');
ok(phone.every((p) => bmw.some((g) => JSON.stringify(g.v) === JSON.stringify(p.v))), 'the phone\'s lane rows are BMW\'s');

// ---- other shapes (not seen on the drive yet; the names are the service's) -------------------------------------
const fd = (d, u) => ({ distance: d, unit: u, rawDistance: 1 });
eq(Nav.decodeEvent({ alongMainRoad: { mainRoadDirection: 'LEFT', formattedDistance: fd('300', 'METER') } }).kind + Nav.decodeEvent({ alongMainRoad: { mainRoadDirection: 'LEFT', formattedDistance: fd('300', 'METER') } }).dir, 'keepLEFT', 'alongMainRoad: keep left');
eq(Nav.decodeEvent({ laneChange: { changeSide: 'RIGHT', formattedDistance: fd('200', 'METER') } }).kind, 'lanechange', 'laneChange');
eq(Nav.decodeEvent({ branch: { branchType: 'HIGHWAY_OUT_RIGHT', formattedDistance: fd('0.5', 'MILE_US') } }).unit, 'mi', 'miles');
eq(Nav.decodeEvent({ intersection: { direction: 'HARD_RIGHT', formattedDistance: fd('800', 'FEET') } }).unit, 'ft', 'feet');
eq(Nav.decodeEvent({ roundabout: { exitNumber: 3, exitAngle: -90, driveDirection: 'RIGHT', formattedDistance: fd('150', 'YARD') } }), { kind: 'roundabout', dir: null, geom: null, exit: 3, exitAngle: 270, side: 'right', flag: null, stop: null, dist: '150', unit: 'yd', uk: true, road: '', unreliable: false, dtd: null }, 'roundabout, left-hand traffic, angle wrapped');
eq(Nav.decodeEvent({ ferry: { formattedDistance: fd('2', 'KM') } }).kind, 'follow', 'an unknown kind with a distance: follow the route');
ok(Nav.decodeEvent({ pointOfInterest: { formattedDistance: fd('2', 'KM') } }) === null, 'a point of interest isn\'t a turn');
ok(Nav.decodeEvent({ laneGuiding: { lanes: [] } }) === null && Nav.decodeEvent(null) === null && Nav.decodeEvent({ a: {}, b: {} }) === null, 'not a manoeuvre: null');
ok(Nav.decodeEvent({ intersection: { direction: 'LEFT', formattedDistance: fd('', 'METER') } }).dist === null, 'an empty distance is none');
// replies that say nothing
eq(Nav.decodeEvents({ GuidanceEventListError: 'NOT_AVAILABLE' }), { ok: false, error: 'NOT_AVAILABLE', events: [], raw: 0, uids: [] }, 'an error reply');
eq(Nav.decodeEvents({ GuidanceEventListError: 'NO_ERROR', viewContent: [] }).error, 'no view', 'no view');
eq(Nav.decodeEvents({ GuidanceEventListError: 'NO_ERROR', viewContent: [{ eventsInView: [] }] }), { ok: true, error: null, events: [], raw: 0, uids: [] }, 'no events: ok, no turn');
ok(Nav.decodeEvents('x').ok === false && Nav.decodeEvents(null).ok === false, 'nonsense: not ok');
// enum values as numbers (another firmware): the turn still shows, with the number as its direction
ok(Nav.decodeEvent({ intersection: { direction: 2, formattedDistance: fd('100', 4) } }).dir === 'LEFT' && Nav.decodeEvent({ intersection: { direction: 2, formattedDistance: fd('100', 4) } }).unit === 'm', 'numeric enums: the catalog\'s numbers (direction 2 = LEFT, unit 4 = METER)');
// anything not a direction gives no arrow (the dot), never a guess (2026-11-09 bug review: these drew straight on)
ok(Nav.decodeEvent({ intersection: { formattedDistance: fd('100', 'METER') } }).dir === 'NONE', 'an intersection with no direction: NONE');
ok(Nav.decodeEvent({ intersection: { direction: 'WIGGLE', formattedDistance: fd('100', 'METER') } }).dir === 'NONE' && Nav.decodeEvent({ intersection: { direction: 42, formattedDistance: fd('100', 'METER') } }).dir === 'NONE', 'an unknown direction (name or number): NONE');
ok(Nav.decodeEvent({ branch: { formattedDistance: fd('100', 'METER') } }).dir === 'NONE', 'a branch with no type: NONE');
ok(Nav.decodeEvent({ roundabout: { exitNumber: 1, exitAngle: 90, driveDirection: 2, formattedDistance: fd('100', 'METER') } }).side === 'right', 'driveDirection 2 = RIGHT');
ok(Nav.decodeLanes({ rows: [{ lanes: [{ directionToFollow: 5, otherDirections: [1, 99], isHighlighted: true, additionalLaneInfo: 9 }] }] }).lanes[0].follow === 'RIGHT' &&
    Nav.decodeLanes({ rows: [{ lanes: [{ directionToFollow: 5, otherDirections: [1, 99], isHighlighted: true, additionalLaneInfo: 9 }] }] }).lanes[0].others.join() === 'STRAIGHT_ON' &&
    Nav.decodeLanes({ rows: [{ lanes: [{ directionToFollow: 5, otherDirections: [1, 99], isHighlighted: true, additionalLaneInfo: 9 }] }] }).lanes[0].info === 'BLOCKED', 'lanes with numbers: 5 = RIGHT, 1 = STRAIGHT_ON, 99 dropped, info 9 = BLOCKED');
// the wrapped form ({ maneuver: { ... } }) and conclusiveDart
ok(Nav.decodeEvents({ viewContent: [{ eventsInView: [{ maneuver: { intersection: { direction: 'SLIGHT_LEFT', formattedDistance: fd('799', 'METER') } } }] }] }).events[0].dir === 'SLIGHT_LEFT', 'events wrapped in maneuver');
ok(Nav.decodeDart({ maneuver: { pointOfInterest: {} } }) === null && Nav.decodeDart({}) === null, 'CarPlay\'s empty conclusiveDart: nothing');
ok(Nav.decodeDart({ maneuver: { intersection: { direction: 'RIGHT', formattedDistance: fd('300', 'METER') } } }).dir === 'RIGHT', 'BMW\'s own conclusiveDart');
// the log line never carries the street
const named = Nav.decodeEvent({ intersection: { direction: 'LEFT', formattedDistance: fd('450', 'METER'), description: { elements: [{ text: 'Example' }, { text: 'Street' }] } } });
ok(named.road === 'Example Street' && Nav.describe(named) === 'turn LEFT 450 m <14 chars>', 'describe(): the road as its length (' + Nav.describe(named) + ')');

// ---- every kind in the car's catalog (GuidanceEventUnion, 22 members) -------------------------------------------
{
    const ev = (kind, body) => { const e = {}; e[kind] = Object.assign({ formattedDistance: fd('500', 'METER') }, body || {}); return e; };
    const TURNS = { intersection: 'turn', branch: 'branch', roundabout: 'roundabout', destinationManeuver: 'destination', laneChange: 'lanechange', alongMainRoad: 'keep', vehicleTransportation: 'transport' };
    const MEMBERS = ['pointOfInterest', 'intersection', 'tunnel', 'branch', 'roundabout', 'destinationManeuver', 'placeholderElement', 'laneGuiding', 'trafficEvent',
        'trafficFlowItem', 'routeSegmentItem', 'laneChange', 'tollgate', 'border', 'vehicleTransportation', 'passiveManeuver', 'speedLimitAssist', 'speedCamera',
        'speedSectionCamera', 'dangerousCurve', 'schoolZone', 'alongMainRoad'];
    MEMBERS.forEach((k) => {
        const m = Nav.decodeEvent(ev(k));
        if (TURNS[k]) ok(m && m.kind === TURNS[k], k + ': a manoeuvre (' + (m && m.kind) + ')');
        else ok(m === null && Nav.SKIP[k], k + ': not a turn, skipped');
    });
    // an info event ahead of the turn doesn't hide it
    const r = Nav.decodeEvents({ viewContent: [{ eventsInView: [ev('tunnel'), ev('tollgate', { tollGateType: 'TOLL_GATE' }), ev('placeholderElement', { type: 'LOADING_INDICATOR' }),
        ev('intersection', { direction: 'RIGHT', formattedDistance: fd('900', 'METER') })] }] });
    ok(r.events.length === 1 && r.events[0].dir === 'RIGHT' && r.events[0].dist === '900', 'a tunnel, a toll gate and a placeholder ahead: the turn after them is the next turn');
    // a kind newer than the catalog, with a distance: the dot, not a guess
    ok(Nav.decodeEvent(ev('hovercraft')).kind === 'follow', 'a kind newer than the catalog: follow the route');
    // detailedGeometry carried when it says something
    ok(Nav.decodeEvent(ev('branch', { branchType: 'HIGHWAY_OUT_RIGHT', detailedGeometry: 'EXIT_RIGHT_TWO_WAY_FORK_TAKE_RIGHT_LEFT' })).geom === 'EXIT_RIGHT_TWO_WAY_FORK_TAKE_RIGHT_LEFT', 'detailedGeometry kept');
    ok(Nav.decodeEvent(ev('intersection', { direction: 'LEFT', detailedGeometry: 'UNDEFINED' })).geom === null, 'UNDEFINED geometry: none');
    // stopovers, ferries, trains
    const stop = Nav.decodeEvent(ev('destinationManeuver', { position: 'RIGHT', isCheckeredFlag: false, stopOverNumber: 2 }));
    ok(stop.flag === false && stop.stop === 2 && /stopover 2/.test(Nav.describe(stop)), 'a stopover: no flag, its number (' + Nav.describe(stop) + ')');
    ok(Nav.decodeEvent(ev('destinationManeuver', { position: 'NOT_DIGITIZED', isCheckeredFlag: true, stopOverNumber: 0 })).dir === 'NOT_DIGITIZED', 'a destination off the map');
    ok(Nav.decodeEvent(ev('vehicleTransportation', { type: 'CAR_TRAIN' })).dir === 'CAR_TRAIN' && Nav.decodeEvent(ev('vehicleTransportation', { type: 'FERRY' })).dir === 'FERRY', 'ferry and car train');
    ok(Nav.decodeEvent(ev('intersection', { direction: 'NONE' })).dir === 'NONE', 'TurnDirection NONE kept (drawn as follow the route)');
    // the catalog itself, when it's here (reference/ is git-ignored: CI skips this)
    const CAT = path.join(__dirname, '..', '..', 'reference', 'someip-interfaces.json');
    if (fs.existsSync(CAT)) {
        const D = JSON.parse(fs.readFileSync(CAT, 'utf8')).datatypes, T = (n) => D['de.bmw.infotainment.navigation.GuidingTypes.' + n];
        eq(T('GuidanceEventUnion').members.map((x) => x.name).sort(), MEMBERS.slice().sort(), 'the catalog\'s union members are the ones checked');
        eq(Object.keys(T('DestinationPosition').items).sort(), ['CENTER', 'LEFT', 'NOT_DIGITIZED', 'RIGHT'], 'destination positions');
        eq(Object.keys(T('VehicleTransportationType').items).sort(), ['CAR_TRAIN', 'FERRY'], 'transport types');
    } else console.log('(the car\'s catalog is not here: its cross-check skipped)');
}

// ---- "then": the turn close behind the next one -------------------------------------------------------------------
{
    // the drive (CarPlay): a second turn with no distance; shown after a turn, not after a straight on (it may be
    // km on), and never the turn just made (2026-11-10 drive: a roundabout straight on, "then" a left / right)
    const two = replies.filter((r) => r.v.viewContent[0].eventsInView.length === 2);
    const T = Nav.Tracker();
    T.field('carplay', 'projectedGuidanceActive', true, 0);
    const shown = {};
    two.forEach((r) => {
        T.events(r.v, r.t); const v = T.view('route', r.t), e = Nav.decodeEvents(r.v).events;
        const key = e[0].kind + ' ' + (e[0].dir || e[0].exit) + ' > ' + e[1].kind + ' ' + (e[1].dir || '');
        shown[key] = (shown[key] || '') + (v.show && v.show.then ? 'y' : 'n');
    });
    const all = (k, c) => !!shown[k] && shown[k].split('').every((x) => x === c);
    ok(all('turn STRAIGHT_ON > turn RIGHT', 'n'), 'the drive, 07:27:33: straight on listed with the right just taken: no "then" (' + shown['turn STRAIGHT_ON > turn RIGHT'] + ')');
    ok(all('turn STRAIGHT_ON > branch BRANCH_LEFT', 'n'), 'the drive: straight on, the exit 5.1 km on: no "then"');
    ok(all('branch BRANCH_LEFT > turn RIGHT', 'y') && shown['branch BRANCH_LEFT > turn RIGHT'].length > 10, 'the drive: the motorway exit, then right: "then" every time');
    ok(all('roundabout 1 > destination LEFT', 'y'), 'the drive: the roundabout (exit 1, a turn), then the destination: "then"');
    ok(Nav.staleThen([3, 2]) && !Nav.staleThen([3, 4]) && !Nav.staleThen([3]) && !Nav.staleThen([null, 2]), 'an older second event is the turn just made');
    const nod = { kind: 'turn', dir: 'LEFT', dist: null, unit: null, dtd: 100, road: '' };
    ok(Nav.thenOf({ kind: 'roundabout', exit: 2, exitAngle: 10, dist: '300', unit: 'm', dtd: 100, road: '' }, nod) === null, 'a roundabout straight on (10 degrees), then a turn with no gap: no "then"');
    ok(Nav.thenOf({ kind: 'roundabout', exit: 1, exitAngle: 307, dist: '300', unit: 'm', dtd: 100, road: '' }, nod) !== null, 'a first roundabout exit (a turn), then a turn: "then"');
    const one = replies.filter((r) => r.v.viewContent[0].eventsInView.length === 1)[0];
    T.events(one.v, one.t);
    ok(T.view('route', one.t).show.then === null, 'one turn only: no "then"');
    const exitThenRight = two.map((r) => Nav.decodeEvents(r.v).events).filter((e) => e[0].kind === 'branch' && e[1].dir === 'RIGHT')[0];
    ok(exitThenRight && Nav.thenOf(exitThenRight[0], exitThenRight[1]).dir === 'RIGHT', 'the motorway exit, then right');
    ok(/then turn RIGHT$/.test(Nav.describe(Object.assign({}, exitThenRight[0], { lanes: null, then: Nav.thenOf(exitThenRight[0], exitThenRight[1]) }))), 'logged: "... then turn RIGHT"');
    // with distances (BMW's own navigation): only within THEN_M of the next turn
    const ev = (dir, d, dtd) => ({ kind: 'turn', dir: dir, dist: String(d), unit: 'm', dtd: dtd, road: '' });
    ok(Nav.thenOf(ev('RIGHT', 300, 5000), ev('LEFT', 350, 4950)).gap === 50, '50 m after: "then", 50 m (from the distances to the destination)');
    // from the turns' own rounded texts: close enough to decide, not exact enough to print (it wobbled 100 / 150 m)
    ok(Nav.thenOf(ev('RIGHT', 300, null), ev('LEFT', 420, null)) !== null && Nav.thenOf(ev('RIGHT', 300, null), ev('LEFT', 420, null)).gap === null, '120 m after (from the rounded texts): "then", no number');
    ok(Nav.thenOf(ev('RIGHT', 300, 5000), ev('RIGHT', 300, 5000)) === null, 'the same turn listed twice: no "then"');
    ok(Nav.thenOf(ev('RIGHT', 300, 5000), ev('LEFT', 700, 4600)) === null, '400 m after: no "then"');
    ok(Nav.thenOf(ev('RIGHT', 300, 5000), ev('LEFT', 300 + Nav.THEN_M, 5000 - Nav.THEN_M)) !== null, 'exactly ' + Nav.THEN_M + ' m: still "then"');
    ok(Nav.thenOf(ev('RIGHT', 300, null), { kind: 'turn', dir: 'LEFT', dist: '2', unit: 'km', dtd: null, road: '' }) === null, 'a later turn with a distance but no gap known: no "then"');
    ok(Nav.thenOf(ev('RIGHT', 300, 5000), { kind: 'follow', dir: 'x', dist: null, unit: null, dtd: null }) === null, 'an unknown kind after: no "then"');
}

// ---- the tracker on a driven clock, asked as the HUD asks (every frame; here every 200 ms) ------------------------
/** view() every 200 ms from..to (as the HUD's tick does); the last answer. */
const drive = (T, from, to, mode) => { let v = null; for (let t = from; t <= to; t += 200) v = T.view(mode || 'route', t); return v; };
{
    // Redline started after a cancelled CarPlay route: CAR_PLAY still the provider, CarPlay says it isn't guiding
    const T = Nav.Tracker();
    T.field('guidance', 'guidingProvider', 'CAR_PLAY', 1000);
    T.field('carplay', 'projectedGuidanceActive', false, 1100);
    ok(!T.routing(), 'a CAR_PLAY provider left over, CarPlay not guiding: no route, the event list not asked');
    T.field('carplay', 'projectedGuidanceActive', true, 2000);
    ok(T.routing(), '... and a CarPlay route after it counts');
    // given way on a BMW route without readable turns, then CarPlay takes the route: giving way starts over
    const B = Nav.Tracker(), b0 = 5000000;
    B.field('guidance', 'guidanceState', 'ACTIVE', b0);
    ok(drive(B, b0, b0 + Nav.GIVE_WAY_MS + 2000).giveWay, 'BMW route, no readable turn: gave way');
    B.field('carplay', 'projectedGuidanceActive', true, b0 + 20000);
    B.field('guidance', 'guidingProvider', 'CAR_PLAY', b0 + 20050);
    ok(!B.view('route', b0 + 20100).giveWay, 'the route handed to CarPlay: not giving way any more (its turns may be readable)');
}
{
    const T = Nav.Tracker();
    const t0 = 1000000;
    ok(drive(T, t0, t0 + 1000).show === null && !T.view('route', t0 + 1000).giveWay, 'nothing running: nothing, no giving way');
    T.field('guidance', 'guidingProvider', 'CAR_PLAY', t0 + 1000);
    ok(T.routing() && !drive(T, t0 + 1000, t0 + 30000).giveWay, 'CarPlay as provider alone: routing, but never giving way on it (it may stay CAR_PLAY with no route)');
    T.field('carplay', 'projectedGuidanceActive', true, t0 + 30000);
    ok(!drive(T, t0 + 30000, t0 + 30000 + Nav.GIVE_WAY_MS - 200).giveWay, 'a route for certain, no turn yet: wait (the tach, no arrow) for ' + Nav.GIVE_WAY_MS + ' ms');
    T.events(replies[0].v, t0 + 40000, t0 + 39900);
    const v = drive(T, t0 + 40000, t0 + 40000);
    ok(v.show && v.show.kind === 'turn' && v.show.dist === '1' && !v.giveWay, 'a turn: shown');
    ok(T.view('off', t0 + 40200).show === null, 'Directions off: nothing');
    ok(drive(T, t0 + 40400, t0 + 40400, 'near').show === null, '"Near turns" at 1 km: not yet');
    T.events(replies.filter((r) => /"distance":"300","unit":"METER"/.test(JSON.stringify(r.v.viewContent[0].eventsInView[0])))[0].v, t0 + 41000, t0 + 40900);
    ok(drive(T, t0 + 40600, t0 + 41000, 'near').show !== null, '"Near turns" at 300 m: shown');
    ok(drive(T, t0 + 41000, t0 + 41000 + Nav.STALE_MS).show !== null, 'still fresh at ' + Nav.STALE_MS + ' ms');
    ok(drive(T, t0 + 41000 + Nav.STALE_MS, t0 + 41200 + Nav.STALE_MS).show === null, 'stale after ' + Nav.STALE_MS + ' ms: not shown (never a stale arrow)');
    // short gaps (a failed call, the 2 s back-off, a busy native queue) show the tach without an arrow, never blank
    ok(!drive(T, t0 + 41200 + Nav.STALE_MS, t0 + 41000 + Nav.GIVE_WAY_MS - 200).giveWay, 'up to ' + Nav.GIVE_WAY_MS + ' ms since the last turn: not giving way');
    // lanes stay with their turn; a new turn drops them; rows: [] clears them
    T.events(replies[0].v, t0 + 50000, t0 + 49900);
    T.field('guidance', 'currentLaneGuiding', laneRows[0].v, t0 + 50000);
    ok(drive(T, t0 + 49800, t0 + 50500).show.lanes.lanes.length === 3, 'lanes ride with the turn');
    T.events(replies[0].v, t0 + 54000, t0 + 53900);
    ok(drive(T, t0 + 50600, t0 + 54000).show.lanes !== null, 'lanes stay with their turn (the car may send them only when they change)');
    const other = replies.filter((r) => /"direction":"RIGHT"/.test(JSON.stringify(r.v.viewContent[0].eventsInView[0])))[0].v;
    T.events(other, t0 + 54200, t0 + 54100);
    ok(drive(T, t0 + 54200, t0 + 54200).show.lanes === null, 'a new turn (a reroute): the old turn\'s lanes are dropped at once');
    T.field('guidance', 'currentLaneGuiding', laneRows[0].v, t0 + 54400);
    ok(drive(T, t0 + 54400, t0 + 54400).show.lanes !== null, 'lanes sent after it: shown');
    T.field('guidance', 'currentLaneGuiding', { rows: [], carPositionLaneIndex: 255 }, t0 + 54600);
    ok(drive(T, t0 + 54600, t0 + 54600).show.lanes === null, 'rows: [] clears the lanes');
    // "Near turns": lanes always show
    T.events(replies[0].v, t0 + 55000, t0 + 54900);
    T.field('guidance', 'currentLaneGuiding', laneRows[0].v, t0 + 55000);
    ok(drive(T, t0 + 54800, t0 + 55000, 'near').show !== null, '"Near turns" far away but with lanes: shown');
    // a failed query doesn't clear a turn at once; it goes stale
    T.failed('timeout');
    ok(drive(T, t0 + 55200, t0 + 55400).show !== null && T.error() === 'timeout', 'a failed query: the turn stays until stale');
    // an error reply: the old turn goes stale, no new one
    T.events({ GuidanceEventListError: 'NOT_AVAILABLE' }, t0 + 55600, t0 + 55500);
    ok(drive(T, t0 + 55600, t0 + 55600).show.src === 'events' && T.error() === 'NOT_AVAILABLE', 'an error reply keeps the last turn until stale');
    // the route ends: nothing old comes back
    T.field('guidance', 'guidingProvider', 'NONE', t0 + 56000);
    T.field('carplay', 'projectedGuidanceActive', false, t0 + 56000);
    ok(!T.routing() && drive(T, t0 + 56000, t0 + 56400).show === null && !T.view('route', t0 + 56600).giveWay, 'the route ended: nothing, no giving way');
    // BMW's own navigation: conclusiveDart, fresh while its guidance is active (sent only when it changes)
    T.field('guidance', 'guidanceState', 'ACTIVE', t0 + 60000);
    T.field('guidance', 'conclusiveDart', { maneuver: { intersection: { direction: 'HARD_RIGHT', formattedDistance: fd('250', 'METER') } } }, t0 + 60000);
    const bm = drive(T, t0 + 60000, t0 + 60400).show;
    ok(bm && bm.src === 'dart' && bm.dir === 'HARD_RIGHT', 'BMW navigation: conclusiveDart shown');
    ok(drive(T, t0 + 60400, t0 + 90000).show.dir === 'HARD_RIGHT', 'standing at the lights 30 s (no new conclusiveDart): still shown, not given way');
    T.events(replies[0].v, t0 + 90200, t0 + 90100);
    ok(drive(T, t0 + 90200, t0 + 90200).show.src === 'events', 'the event list wins over conclusiveDart');
}

// ---- two phones: no telling whose route (the check from jaimeen77's Cluster Redline) -----------------------------
{
    const mk = (provider, cp, aa) => { const T = Nav.Tracker(); if (provider !== undefined) T.field('guidance', 'guidingProvider', provider, 0); if (cp) T.field('carplay', 'projectedGuidanceActive', true, 0); if (aa) T.field('androidauto', 'projectedGuidanceActive', true, 0); T.events(replies[0].v, 500, 400); return T; };
    const at = (T, t) => drive(T, 0, t || 1000);
    ok(at(mk('CAR_PLAY', true, false)).show !== null, 'CarPlay named, CarPlay guiding: shown');
    ok(at(mk('ANDROID_AUTO', false, true)).show !== null, 'Android Auto named, Android Auto guiding: shown');
    const both = at(mk('CAR_PLAY', true, true));
    ok(both.show === null && both.mismatch && !both.giveWay, 'both phones guiding: no arrow, no giving way (the tach stays)');
    ok(at(mk('CAR_PLAY', false, true)).mismatch === true, 'CarPlay named, only Android Auto guiding: no arrow');
    ok(at(mk('ANDROID_AUTO', true, false)).mismatch === true, 'Android Auto named, only CarPlay guiding: no arrow');
    ok(at(mk(2, false, true)).show !== null && at(mk(1, false, true)).mismatch === true, 'providers by number (1 CarPlay, 2 Android Auto)');
    ok(!drive(mk('CAR_PLAY', true, true), 0, 1000 + Nav.GIVE_WAY_MS + 5000).giveWay, 'two phones for longer than ' + Nav.GIVE_WAY_MS + ' ms: still not giving way');
    ok(at(mk(undefined, true, false)).show !== null, 'no provider sent, CarPlay guiding: shown');
}

// ---- giving way: rare, and for the route (the HUD slot: 3 s blank, then BMW's card until the route ends) ---------
{
    // (BMW's own navigation: a phone's route never gives way, below)
    const T = Nav.Tracker(), t0 = 2000000;
    T.field('guidance', 'guidanceState', 'ACTIVE', t0);
    ok(!drive(T, t0, t0 + Nav.GIVE_WAY_MS - 200).giveWay && drive(T, t0 + Nav.GIVE_WAY_MS - 200, t0 + Nav.GIVE_WAY_MS).giveWay, 'a BMW route, no readable turn for ' + Nav.GIVE_WAY_MS + ' ms: give way');
    // 2026-11-10, issue #91: Waze guiding over the phone, no turns Redline can read: BMW's card has none either, so the
    // tach stays (no arrow) rather than an empty HUD, for CarPlay and for Android Auto
    ['carplay', 'androidauto'].forEach((src) => {
        const W = Nav.Tracker(), wEmpty = { GuidanceEventListError: 'NO_ERROR', viewContent: [{ eventsInView: [] }] };
        W.field(src, 'projectedGuidanceActive', true, 0);
        let gave = false;
        for (let t = 0; t < 90000; t += 1000) { W.events(wEmpty, t, t - 100); if (drive(W, t, t + 800).giveWay) gave = true; }
        ok(!gave && W.routing(), src + ' route, no readable turn for 90 s: never steps aside, the tach stays');
    });
    // turns coming back don't bring Redline back (the slot would be BMW's anyway): no flapping
    T.events(replies[0].v, t0 + 16000, t0 + 15900);
    ok(drive(T, t0 + 16000, t0 + 30000).giveWay, 'turns again: still out for the route (no flapping)');
    // one failed call every other second never gave way at all: a separate tracker
    const F = Nav.Tracker();
    F.field('guidance', 'guidanceState', 'ACTIVE', 0);
    let flaps = 0, prev = false;
    for (let t = 0; t < 120000; t += 200) {
        if (t % 2000 === 0 && t % 4000 !== 0) F.events(replies[0].v, t, t - 100);
        const g = F.view('route', t).giveWay;
        if (g !== prev) flaps++;
        prev = g;
    }
    ok(flaps === 0, 'every other call failing for 2 minutes: never gives way (' + flaps + ' changes)');
    // the route ends: back at once
    T.field('guidance', 'guidanceState', 'IDLE', t0 + 30200);
    ok(!drive(T, t0 + 30200, t0 + 30400).giveWay, 'the route ended: back');
    // a phone gone with its "guiding" flag left on (unplugged): after BACK_MS with nothing answering, back
    const U = Nav.Tracker();
    U.field('carplay', 'projectedGuidanceActive', true, 0);
    U.events(replies[0].v, 1000, 900);
    ok(!drive(U, 0, 1000 + Nav.BACK_MS + 400).giveWay, 'unplugged mid-route after its turns were read, the flag left on: the tach stays, no giving way');
    // never read (a route whose turns the event list doesn't give): gives way, back after BACK_MS of silence
    const U2 = Nav.Tracker(), empty = { GuidanceEventListError: 'NO_ERROR', viewContent: [{ eventsInView: [] }] };
    U2.field('guidance', 'guidanceState', 'ACTIVE', 0);
    U2.events(empty, 1000, 900);
    ok(drive(U2, 0, 1000 + Nav.GIVE_WAY_MS).giveWay, 'no turn ever read: gives way after ' + Nav.GIVE_WAY_MS + ' ms');
    ok(!drive(U2, 1000 + Nav.GIVE_WAY_MS, 1000 + Nav.BACK_MS + 400).giveWay, 'nothing answered for ' + Nav.BACK_MS + ' ms: back (behind the BMW card if there is one)');
    // 2026-11-10: a U-turn in a cul-de-sac, Apple Maps working out the new route (empty lists, the route flag off and
    // on): Redline never gives way to the BMW "Calculating Route" card; the arrow comes back with the new turns
    const RR = Nav.Tracker();
    RR.field('carplay', 'projectedGuidanceActive', true, 0);
    RR.events(replies[0].v, 1000, 900);
    let gave = false;
    for (let t = 2000; t < 40000; t += 1000) {
        RR.events(empty, t, t - 100);
        if (t === 10000) RR.field('carplay', 'projectedGuidanceActive', false, t);
        if (t === 12000) RR.field('carplay', 'projectedGuidanceActive', true, t);
        if (drive(RR, t, t + 800).giveWay) gave = true;
    }
    ok(!gave, 'rerouting for 38 s (no turns, the flag off and on): never gives way');
    RR.events(replies[0].v, 40000, 39900);
    ok(drive(RR, 40000, 40400).show !== null, 'the new route turn: the arrow is back');
    // the source reported gone: its flag with it
    const G = Nav.Tracker();
    G.field('carplay', 'projectedGuidanceActive', true, 0);
    G.events(replies[0].v, 500, 400);
    G.field('carplay', 'available', false, 1000);
    ok(!G.routing() && drive(G, 1000, 2000).show === null, 'CarPlay reported not available: the route is over, no old arrow');
    // a cancel where the provider stays CAR_PLAY: the route ends when the "guiding" flag goes
    const C2 = Nav.Tracker();
    C2.field('guidance', 'guidingProvider', 'CAR_PLAY', 0);
    C2.field('carplay', 'projectedGuidanceActive', true, 0);
    C2.events(replies[0].v, 1000, 900);
    C2.field('carplay', 'projectedGuidanceActive', false, 2000);
    ok(drive(C2, 2000, 2400).show === null && C2.events(replies[0].v, 2500, 1900).stale, 'cancelled, provider still CAR_PLAY: no arrow, the reply in flight dropped');
    ok(!C2.routing(), 'and no route (no polling on the provider alone once a flag was seen)');
    // then BMW's own nav starts, the provider still CAR_PLAY: BMW's route, not CarPlay's (whose turns were read), so
    // with no readable turn Redline gives way to BMW's card (2026-11-10 review)
    C2.field('guidance', 'guidanceState', 'ACTIVE', 3000);
    ok(C2.routing() && drive(C2, 3000, 3000 + Nav.GIVE_WAY_MS + 400).giveWay, 'BMW nav after a cancelled CarPlay route (provider left CAR_PLAY): gives way to BMW’s card');
    // the HUD or the directions off for a while, then on: the count starts again (no give way on the first frame)
    const R = Nav.Tracker();
    R.field('carplay', 'projectedGuidanceActive', true, 0);
    R.events(replies[0].v, 1000, 900);
    drive(R, 0, 2000);
    ok(!drive(R, 60000, 61000).giveWay, 'directions back on after a minute off: not giving way at once');
    // an identical provider sent again (an availability bounce) doesn't drop the turn
    const P = Nav.Tracker();
    P.field('guidance', 'guidingProvider', 'CAR_PLAY', 0);
    P.field('carplay', 'projectedGuidanceActive', true, 0);
    P.events(replies[0].v, 1000, 900);
    P.field('guidance', 'guidingProvider', 'CAR_PLAY', 1200);
    ok(drive(P, 1000, 1400).show !== null, 'the same provider sent again: the arrow stays');
}

// ---- from the 2026-11-09 bug review ------------------------------------------------------------------------------
{
    const T = Nav.Tracker(), t0 = 5000000;
    T.field('carplay', 'projectedGuidanceActive', true, t0);
    T.events(replies[0].v, t0 + 1000, t0 + 900);
    // one reply with no turn in it (lane rows only) mustn't hide the HUD at once
    T.events(replies[0].v, t0 + 8000, t0 + 7900);
    T.events({ GuidanceEventListError: 'NO_ERROR', viewContent: [{ eventsInView: [{ laneGuiding: { lanes: [] } }] }] }, t0 + 9000, t0 + 8900);
    ok(!T.view('route', t0 + 9000).giveWay, 'a route running 9 s, one reply without a turn: not giving way at once');
    // a reply asked before the route ended lands after it: dropped, no old arrow
    T.field('carplay', 'projectedGuidanceActive', false, t0 + 20000);
    const late = T.events(replies[0].v, t0 + 20300, t0 + 19800);
    ok(late.stale && T.view('route', t0 + 20300).show === null, 'a reply asked before the route ended: dropped, no old arrow');
    // the same after the provider changes
    T.field('carplay', 'projectedGuidanceActive', true, t0 + 30000);
    T.events(replies[0].v, t0 + 30500, t0 + 30400);
    // the phone switched: Android Auto guiding, CarPlay stopped, BMW naming Android Auto
    T.field('androidauto', 'projectedGuidanceActive', true, t0 + 31000);
    T.field('carplay', 'projectedGuidanceActive', false, t0 + 31000);
    T.field('guidance', 'guidingProvider', 'ANDROID_AUTO', t0 + 31000);
    ok(T.events(replies[0].v, t0 + 31200, t0 + 30900).stale && T.view('route', t0 + 31200).show === null, 'a reply asked before the provider changed: dropped');
    ok(!T.events(replies[0].v, t0 + 32200, t0 + 31900).stale && T.view('route', t0 + 32200).show !== null, 'one asked after it: shown');
}

// ---- the drive replayed: what the HUD would have shown --------------------------------------------------------
{
    const T = Nav.Tracker();
    T.field('carplay', 'projectedGuidanceActive', true, replies[0].t - 1000);
    let shown = 0, gaps = 0;
    replies.forEach((r) => {
        T.events(r.v, r.t);
        const v = T.view('route', r.t + 500);
        if (v.show) shown++;
        if (v.giveWay) gaps++;
    });
    ok(shown === replies.length && gaps === 0, 'every reply of the drive shows a turn half a second later (' + shown + '/' + replies.length + ')');
}

// ---- the probe's tap feeds the tracker -----------------------------------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-dir-'));
const H = {};
let reply = replies[0].v;
const signals = {
    proxy: () => Promise.resolve({ fake: true }),
    call: () => Promise.resolve(reply),
    watch(iface, inst, handlers) { H[iface.split('.').pop()] = handlers; return Promise.resolve({ available: true, shutdown() {} }); },
};
const logged = [];
const log = { info: (m) => logged.push(m), warn: (m) => logged.push(m) };
let nav = null;
const probe = NavLog.start({ signals: signals, dataDir: dir }, log, (s, f, v) => nav.tap(s, f, v));
nav = Nav.start({}, log, probe);
setTimeout(() => {
    H.CarPlayManager.projectedGuidanceActive(true);
    H.Guidance.currentLaneGuiding(laneRows[0].v);
    setTimeout(() => {
        const v = nav.view('route');
        ok(v.show && v.show.kind === 'turn' && v.show.lanes && v.show.lanes.lanes.length === 3, 'probe -> tap -> tracker: the turn with its lanes');
        reply = { GuidanceEventListError: 'NO_ERROR', viewContent: [{ eventsInView: [{ intersection: { direction: 'RIGHT', formattedDistance: fd('50', 'METER'), description: { elements: [{ text: 'Example Street' }] } } }] }] };
        setTimeout(() => {
            ok(nav.view('route').show.dir === 'RIGHT', 'the next reply replaces the turn');
            const text = fs.readFileSync(path.join(dir, 'redline-nav.log'), 'utf8');
            ok(/ nav: dir: turn LEFT 1 km <\d+ chars> lanes \*STRAIGHT_ON,\*STRAIGHT_ON,NONE/.test(text) && / nav: dir: turn RIGHT 50 m <14 chars>/.test(text), 'what shows is logged, one line per turn');
            ok(!/Example/.test(text), 'no street names in the log');
            probe.stop();
            console.log(tally.checks + ' checks, ' + tally.fails + ' failed');
            process.exit(tally.fails ? 1 : 0);
        }, 1300);
    }, 1300);
}, 100);
