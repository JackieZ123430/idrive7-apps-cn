'use strict';
/**
 * rescan.js - Engine Config: the engine unit (flaps armed) or the DSC (xDrive on) not found at start-up are looked for
 * again while the ignition is on. They sleep with the ignition off, and were otherwise looked for again only when a
 * setting changed (#147: xDrive stayed on the untested path, and the flaps found no engine unit, until then).
 * Every EVERY_MS for the first TRIES tries, then every SLOW_MS; reads only (the same identification as at start).
 *
 *   const tick = rescan({ car, dmeLost, xdrive, controller, log, repaint, now });  setInterval(tick, EVERY_MS)
 */
const EVERY_MS = 15000, SLOW_MS = 60000, TRIES = 4;

function rescan(o) {
    const now = o.now || Date.now;
    let busy = false, tries = 0, last = 0;
    return function tick() {
        const d = o.car.data(), on = d.condition >= 7 || d.rpm > 400;
        const x = o.xdrive, dme = o.dmeLost(), dsc = x.enabled && !x.index && !x.busy && !x.reading;
        if (!dme && !dsc) { tries = 0; return null; }
        if (busy || !on || d.demo || !o.controller.link || !o.controller.link.available) return null;
        if (tries >= TRIES && now() - last < SLOW_MS) return null;
        busy = true; tries++; last = now();
        if (tries <= TRIES) o.log.info('looking again (ignition on): ' + [dme && 'the engine unit', dsc && 'the DSC'].filter(Boolean).join(' and ') + ' not found yet');
        return Promise.resolve(dme && o.controller.refresh()).then(() => dsc && x.refresh()).then(() => o.repaint && o.repaint())
            .catch((e) => o.log.error('looking again', e)).then(() => { busy = false; });
    };
}

module.exports = { rescan, EVERY_MS, SLOW_MS, TRIES };
