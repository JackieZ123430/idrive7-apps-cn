'use strict';
/*
 * The phone ringing (issue #181): the head unit's call state, so the HUD tach steps aside while a call rings.
 *
 * ConnectivityAggregator.aggregatedCallState is one value for all the phone's calls: DISCONNECTED 0,
 * INCOMING 1, ACTIVE 2, DIALING 3, HELD 4. Only INCOMING counts: that's when BMW's call card sits on the HUD.
 * (cluster-render already moves Redline aside for BMW's pop-ups, but takes the card as gone after a second or
 * two while the phone still rings, and the tach came back over it.)
 *
 * The interface is optional: a unit without it never sends anything, and Redline works as before.
 * A ring held longer than MAX_RING_MS is let go, so a lost "call over" can't keep the HUD off for good.
 */
const IFACE = 'de.bmw.infotainment.connectivity.telephony.ConnectivityAggregator';
const NAMES = { DISCONNECTED: 0, INCOMING: 1, ACTIVE: 2, DIALING: 3, HELD: 4 };
const LABEL = ['none', 'ringing', 'active', 'dialing', 'held'];
const MAX_RING_MS = 90000;

/** The call state as a number (the name or number the binding gives, bare or in a one-field object), else null. */
function stateOf(v) {
    if (v && typeof v === 'object') {
        const k = Object.keys(v);
        if (k.length !== 1) return null;
        v = v[k[0]];
    }
    if (typeof v === 'number') return v >= 0 && v <= 4 ? v : null;
    if (typeof v === 'string') { const n = NAMES[v.toUpperCase()]; return n === undefined ? null : n; }
    return null;
}

/** opts: { log, now }. Returns { handlers(), ringing(), state() }. */
function start(opts) {
    const log = opts.log, now = opts.now || Date.now;
    let st = null, ringAt = 0, odd = false, stale = false;
    const handlers = () => ({ [IFACE]: {
        aggregatedCallState: (v) => {
            const n = stateOf(v);
            if (n === null) { if (!odd) { odd = true; log.info('hud: call state not read: ' + JSON.stringify(v)); } return; }
            if (n === st) return;
            if (n === 1) { ringAt = now(); stale = false; }
            log.info('hud: phone ' + LABEL[n] + (n === 1 ? ', the tach gives way to the call card' : ''));
            st = n;
        },
    } });
    const ringing = () => {
        if (st !== 1) return false;
        if (now() - ringAt > MAX_RING_MS) {
            if (!stale) { stale = true; log.info('hud: still ringing after ' + MAX_RING_MS / 1000 + ' s, the tach back'); }
            return false;
        }
        return true;
    };
    return { handlers, ringing, state: () => st };
}

module.exports = { start, stateOf, IFACE, MAX_RING_MS };
