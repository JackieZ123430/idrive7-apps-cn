'use strict';
/**
 * linkqueue.js - eDrive: one request at a time on the diagnostic link. A queue rather than a plain chain, so a live
 * power read (urgent) goes ahead of the reads that wait - but after URGENT_RUN urgent turns in a row a read waiting
 * goes next: the power read ~3 times a second kept the link to itself, and the charge, the cells and the 12 V were
 * never read again (car 2026-11-16: "charge read 15 min ago" while driving). Urgent ones keep their order.
 *
 *   const exclusive = linkQueue(log);
 *   await exclusive(fn, urgent, label)     fn's result, after the turns ahead of it; exclusive.stalls: turns over 1.5 s
 */
const URGENT_RUN = 3, STALL_MS = 1500;

function linkQueue(log) {
    const queue = [];
    let pumping = false, urgentRun = 0;
    async function pump() {
        if (pumping) return;
        pumping = true;
        while (queue.length) {
            const wait = urgentRun >= URGENT_RUN ? queue.findIndex((x) => !x.urgent) : -1;
            const j = wait > 0 ? queue.splice(wait, 1)[0] : queue.shift(), t0 = Date.now();
            urgentRun = j.urgent ? urgentRun + 1 : 0;
            try { j.res(await j.fn()); } catch (e) { j.rej(e); }
            // one turn that holds the link this long delays every read behind it (the live power too): say which
            const ms = Date.now() - t0;
            if (ms > STALL_MS) { exclusive.stalls = (exclusive.stalls || 0) + 1; log.warn('link held ' + ms + ' ms by ' + j.label + (queue.length ? ' (' + queue.length + ' waiting)' : '')); }
        }
        pumping = false;
    }
    const exclusive = (fn, urgent, label) => new Promise((res, rej) => {
        const j = { fn, res, rej, urgent: !!urgent, label: label || (urgent ? 'urgent' : 'read') };
        if (urgent) { const k = queue.findIndex((x) => !x.urgent); queue.splice(k < 0 ? queue.length : k, 0, j); } else queue.push(j);
        pump();
    });
    return exclusive;
}

module.exports = { linkQueue, URGENT_RUN };
