'use strict';

// Redline's call watch (call.js, issue #181): the head unit's call state -> "a call is ringing".
//   node kit/tools/test_redline_call.js

const path = require('path');
const Call = require(path.join(__dirname, '..', '..', 'apps', 'redline', 'call'));
let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL ' + m); } };

// the binding may hand the enum over as a name or a wire number, bare or in a one-field object
ok(Call.stateOf('INCOMING') === 1 && Call.stateOf(1) === 1 && Call.stateOf({ aggregatedCallState: 'INCOMING' }) === 1, 'INCOMING as a name, number or wrapped');
ok(Call.stateOf('DISCONNECTED') === 0 && Call.stateOf('ACTIVE') === 2 && Call.stateOf('held') === 4, 'the other states');
ok(Call.stateOf(9) === null && Call.stateOf('RINGING') === null && Call.stateOf(null) === null && Call.stateOf({ a: 1, b: 2 }) === null, 'anything else: unknown');

let t = 0;
const lines = [];
const c = Call.start({ log: { info: (l) => lines.push(l) }, now: () => t });
const on = c.handlers()[Call.IFACE].aggregatedCallState;
ok(Call.IFACE === 'de.bmw.infotainment.connectivity.telephony.ConnectivityAggregator', 'the interface');
ok(!c.ringing(), 'nothing heard: not ringing (a unit without the interface works as before)');
on('INCOMING');
ok(c.ringing() && lines.some((l) => /^hud: phone ringing/.test(l)), 'INCOMING: ringing, logged with "hud: "');
on('INCOMING'); on('INCOMING');
ok(lines.length === 1, 'the same state again: logged once');
on('ACTIVE');
ok(!c.ringing() && lines[lines.length - 1] === 'hud: phone active', 'answered: not ringing');
on('DISCONNECTED');
ok(!c.ringing(), 'hung up: not ringing');
on('DIALING');
ok(!c.ringing(), 'an outgoing call: not ringing');
// a lost "call over": let go after MAX_RING_MS
on('INCOMING'); t += Call.MAX_RING_MS - 1;
ok(c.ringing(), 'ringing just under the limit: still ringing');
t += 2;
ok(!c.ringing() && lines.some((l) => /still ringing after/.test(l)), 'ringing past the limit: let go, logged');
on('weird'); on('weird');
ok(lines.filter((l) => /not read/.test(l)).length === 1, 'an unreadable value: logged once');

console.log('redline call: ' + checks + ' checks, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
