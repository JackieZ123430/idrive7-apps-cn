'use strict';
// Every arrow Redline's HUD directions can be asked for, and sample turns: for the tests and the preview renders,
// not shipped in the app (apps/redline/hud-nav.js draws them). The lists are the car's catalog's values
// (someip-interfaces.json, navigation.GuidingTypes); test_redline_hud_nav.js checks them against it when it's here.
const path = require('path');
const { TURN_DIRECTIONS } = require(path.join(__dirname, '..', '..', 'apps', 'redline', 'hud-nav'));

/*
 * Every value the car's catalog (someip-interfaces.json, navigation.GuidingTypes) has for what decides the arrow,
 * so the tests and the review sheet draw them all: TurnDirection, BranchType, ManeuverGeometry, Side,
 * DestinationPosition, MainRoadDirection, VehicleTransportationType.
 */
const BRANCH_TYPES = ['BRANCH_LEFT', 'BRANCH_RIGHT', 'FORK_LEFT', 'FORK_RIGHT', 'TRIPLE_FORK_LEFT', 'TRIPLE_FORK_STRAIGHT', 'TRIPLE_FORK_RIGHT',
    'HIGHWAY_OUT_LEFT', 'HIGHWAY_OUT_STRAIGHT', 'HIGHWAY_OUT_RIGHT', 'HIGHWAY_IN_LEFT', 'HIGHWAY_IN_STRAIGHT', 'HIGHWAY_IN_RIGHT', 'OVERPASS', 'UNDERPASS'];
const GEOMETRIES = ['EXIT_LEFT_TAKE_LEFT', 'EXIT_LEFT_TAKE_RIGHT', 'EXIT_RIGHT_TAKE_LEFT', 'EXIT_RIGHT_TAKE_RIGHT',
    'EXIT_LEFT_TWO_WAY_FORK_TAKE_LEFT_LEFT', 'EXIT_LEFT_TWO_WAY_FORK_TAKE_LEFT_RIGHT', 'EXIT_RIGHT_TWO_WAY_FORK_TAKE_RIGHT_LEFT', 'EXIT_RIGHT_TWO_WAY_FORK_TAKE_RIGHT_RIGHT',
    'THREE_WAY_FORK_TAKE_LEFT', 'THREE_WAY_FORK_TAKE_CENTER', 'THREE_WAY_FORK_TAKE_RIGHT',
    'THREE_WAY_FORK_OVERPASS_CENTER_TAKE_LEFT', 'THREE_WAY_FORK_OVERPASS_CENTER_TAKE_CENTER', 'THREE_WAY_FORK_OVERPASS_CENTER_TAKE_RIGHT',
    'THREE_WAY_FORK_UNDERPASS_CENTER_TAKE_LEFT', 'THREE_WAY_FORK_UNDERPASS_CENTER_TAKE_CENTER', 'THREE_WAY_FORK_UNDERPASS_CENTER_TAKE_RIGHT',
    'TWO_WAY_FORK_TAKE_LEFT', 'TWO_WAY_FORK_TAKE_RIGHT',
    'TWO_WAY_FORK_OVERPASS_LEFT_TAKE_LEFT', 'TWO_WAY_FORK_OVERPASS_LEFT_TAKE_RIGHT', 'TWO_WAY_FORK_OVERPASS_RIGHT_TAKE_LEFT', 'TWO_WAY_FORK_OVERPASS_RIGHT_TAKE_RIGHT',
    'TWO_WAY_FORK_UNDERPASS_LEFT_TAKE_LEFT', 'TWO_WAY_FORK_UNDERPASS_LEFT_TAKE_RIGHT', 'TWO_WAY_FORK_UNDERPASS_RIGHT_TAKE_LEFT', 'TWO_WAY_FORK_UNDERPASS_RIGHT_TAKE_RIGHT',
    'TWO_WAY_FORK_OVERPASS_LEFT_UNDERPASS_RIGHT_TAKE_LEFT', 'TWO_WAY_FORK_OVERPASS_LEFT_UNDERPASS_RIGHT_TAKE_RIGHT',
    'TWO_WAY_FORK_UNDERPASS_LEFT_OVERPASS_RIGHT_TAKE_LEFT', 'TWO_WAY_FORK_UNDERPASS_LEFT_OVERPASS_RIGHT_TAKE_RIGHT'];
/** One object per arrow the car can ask for (label: the value it stands for). */
const ALL_ARROWS = [].concat(
    TURN_DIRECTIONS.map((d) => ({ kind: 'turn', dir: d, label: d })),
    BRANCH_TYPES.map((d) => ({ kind: 'branch', dir: d, label: d })),
    GEOMETRIES.map((g) => ({ kind: 'branch', dir: 'NONE', geom: g, label: g.replace('TWO_WAY_FORK', '2FORK').replace('THREE_WAY_FORK', '3FORK').replace(/DERPASS|ERPASS/g, '') })),
    [270, 315, 0, 45, 90, 180, 307].map((a, i) => ({ kind: 'roundabout', exit: i + 1, exitAngle: a, side: 'left', label: 'RB left ' + a })),
    [90, 0, 270, 180].map((a, i) => ({ kind: 'roundabout', exit: i + 1, exitAngle: a, side: 'right', label: 'RB right ' + a })),
    [{ kind: 'roundabout', exit: 2, exitAngle: null, side: 'left', label: 'RB exit 2, no angle' }],
    ['LEFT', 'CENTER', 'RIGHT', 'NOT_DIGITIZED'].map((d) => ({ kind: 'destination', dir: d, flag: true, label: 'DEST ' + d })),
    [{ kind: 'destination', dir: 'RIGHT', flag: false, stop: 2, label: 'STOPOVER 2' }],
    ['LEFT', 'RIGHT'].map((d) => ({ kind: 'keep', dir: d, label: 'ALONG MAIN ' + d })),
    ['LEFT', 'RIGHT'].map((d) => ({ kind: 'lanechange', dir: d, label: 'LANE CHANGE ' + d })),
    ['FERRY', 'CAR_TRAIN'].map((d) => ({ kind: 'transport', dir: d, label: d })),
    [{ kind: 'follow', dir: 'unknown', label: 'FOLLOW (unknown)' }]);

/** Sample turns for the tests and the previews. */
const SAMPLES = {
    left: { kind: 'turn', dir: 'LEFT', dist: '450', unit: 'm', road: 'Example Straße', lanes: null },
    lanes: { kind: 'turn', dir: 'STRAIGHT_ON', dist: '700', unit: 'm', road: 'Example Road',
        lanes: { lanes: [{ follow: 'STRAIGHT_ON', others: [], hi: true, info: 'NONE' }, { follow: 'STRAIGHT_ON', others: [], hi: true, info: 'NONE' }, { follow: 'NONE', others: ['RIGHT'], hi: false, info: 'NONE' }], rec: 1, markers: ['SOLID', 'DASHED', 'DASHED', 'SOLID'] } },
    exit: { kind: 'branch', dir: 'BRANCH_LEFT', dist: '4.7', unit: 'km', road: 'Exit 72', lanes: null },
    roundabout: { kind: 'roundabout', dir: null, exit: 1, exitAngle: 307, side: 'left', dist: '300', unit: 'm', road: 'Ring', lanes: null },
    roundabout3: { kind: 'roundabout', dir: null, exit: 3, exitAngle: 90, side: 'left', dist: '150', unit: 'm', road: '', lanes: null },
    uturn: { kind: 'turn', dir: 'UTURN_LEFT', dist: '200', unit: 'm', road: '', lanes: null },
    slight: { kind: 'turn', dir: 'SLIGHT_RIGHT', dist: '0.3', unit: 'mi', road: 'Sample Ave', lanes: null },
    hard: { kind: 'turn', dir: 'HARD_LEFT', dist: '25', unit: 'm', road: '', lanes: null },
    merge: { kind: 'branch', dir: 'HIGHWAY_IN_RIGHT', dist: '1', unit: 'km', road: '', lanes: null },
    keep: { kind: 'keep', dir: 'RIGHT', dist: '800', unit: 'ft', road: '', lanes: null },
    lanechange: { kind: 'lanechange', dir: 'LEFT', dist: '300', unit: 'm', road: '', lanes: null },
    destination: { kind: 'destination', dir: 'LEFT', dist: '50', unit: 'm', road: '', lanes: null },
    follow: { kind: 'follow', dir: 'ferry', dist: null, unit: null, road: '', lanes: null },
    exitLanes: { kind: 'turn', dir: 'RIGHT', dist: '300', unit: 'm', road: 'Am Beispielplatz',
        lanes: { lanes: [{ follow: 'NONE', others: ['LEFT'], hi: false, info: 'NONE' }, { follow: 'RIGHT', others: ['STRAIGHT_ON'], hi: true, info: 'NONE' }], rec: 1, markers: ['SOLID', 'DASHED', 'SOLID'] } },
};

module.exports = { TURN_DIRECTIONS, BRANCH_TYPES, GEOMETRIES, ALL_ARROWS, SAMPLES };
