'use strict';
/**
 * Part of Redline; README.md in this folder has the whole picture.
 *
 * The Logs page's reading: the important lines of Redline's own logs and of cluster-render's, newest first, for a
 * user with no SSH to read or send (issue #141: a remote install, the HUD off after display errors, no way to see
 * why). Read-only: only the end of each file (TAIL_BYTES, the older .1 file only when the newer one is shorter),
 * and only when the page opens or Refresh is tapped, never per frame. Writes nothing. Never throws: a file that
 * isn't there or can't be read gives no lines and a note.
 *
 * Sources:
 *   redline   redline.log (+ .1): warnings, errors, starts, and the HUD's, driving mode's and switch-off lines
 *   nav       redline-nav.log (+ .1): the probe starting, sources coming and going, the guide, the dir: lines, errors
 *   cluster   cluster-render's own log (its mapping guard's strikes and Dcsm2 coming and going), if apps may read it
 */
const fs = require('fs');
const path = require('path');

const TAIL_BYTES = 96 * 1024, MAX_ROWS = 200;
const CR_LOG = '/var/opt/cluster-render/log/cluster-render.log';
const LEVELS = /^(DEBUG|INFO|WARN|WARNING|ERROR|FATAL|SDK_\w+|[DIWEF])$/;

/** The last bytes of file as text ('' when it is missing), starting at a whole line. */
function tail(file, bytes) {
    let fd = -1;
    try {
        fd = fs.openSync(file, 'r');
        const size = fs.fstatSync(fd).size, from = Math.max(0, size - bytes), n = size - from;
        const buf = Buffer.alloc(n);
        let got = 0;
        while (got < n) { const r = fs.readSync(fd, buf, got, n - got, from + got); if (r <= 0) break; got += r; }
        let s = buf.slice(0, got).toString('utf8');
        if (from > 0) { const nl = s.indexOf('\n'); s = nl < 0 ? '' : s.slice(nl + 1); }
        return s;
    } finally { if (fd >= 0) try { fs.closeSync(fd); } catch (e) { /* closed */ } }
}

/** file's lines, oldest first, with the end of file.1 before them when file holds less than bytes. */
function linesOf(file, bytes) {
    const now = tail(file, bytes);
    let old = '';
    if (Buffer.byteLength(now) < bytes) { try { old = tail(file + '.1', bytes - Buffer.byteLength(now)); } catch (e) { old = ''; } }
    return (old + now).split('\n').filter((l) => l.trim());
}

/**
 * A log line as { at (ms, NaN when it has no time), level ('INFO', 'WARN', ... or ''), msg }. Redline's lines are
 * "<ISO time> <LEVEL> <message>", the nav log's "<ISO time> nav: <message>", cluster-render's start with a time too.
 */
function parse(line) {
    // (a CRLF file's carriage return, and any other control character, never reaches the screen)
    line = String(line).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    const m = /^(\d{4}-\d\d-\d\d[T ][\d:.]+Z?)\s+(.*)$/.exec(line);
    if (!m) return { at: NaN, level: '', msg: line };
    const at = Date.parse(m[1].replace(' ', 'T')), rest = m[2], sp = rest.indexOf(' ');
    const word = sp < 0 ? rest : rest.slice(0, sp), lv = word.replace(/[\[\]:]/g, '').toUpperCase();
    if (LEVELS.test(lv)) {
        const level = lv === 'WARNING' || lv === 'W' ? 'WARN' : lv === 'E' ? 'ERROR' : lv === 'F' ? 'FATAL' : lv === 'I' ? 'INFO' : lv === 'D' ? 'DEBUG' : lv;
        return { at: at, level: level, msg: sp < 0 ? '' : rest.slice(sp + 1) };
    }
    return { at: at, level: '', msg: rest };
}

const bad = (r) => /WARN|ERROR|FATAL/.test(r.level);
/** Which lines are worth showing, per source. */
const IMPORTANT = {
    redline: (r) => bad(r) || /^(starting |exit code|uncaught|shutdown|hud: |driving mode: |vehicle state: |nav: |first frame)/.test(r.msg) || /guard/i.test(r.msg),
    // (dir: what the directions show, a line per turn; giving way to BMW's card; the event list failing)
    nav: (r) => bad(r) || /^nav: (probe started|\w+ (available|not available|error)|error|tap error|no signals|dir: )/.test(r.msg) ||
        /guidanceState|guidingProvider|give way|giving way/i.test(r.msg),
    // (its guard, the cluster's display (Dcsm2) and heartbeats, and each start; not its once-a-minute frame counts
    // or each layer made, which buried the strikes on a car: issue #141's photos)
    cluster: (r) => bad(r) || /^guard:|^dcsm:|heartbeat|Starting Ramses Client Application/.test(r.msg),
};

/** The files of a source (dataDir: Redline's data folder). */
function fileOf(src, dataDir) {
    return src === 'cluster' ? CR_LOG : path.join(dataDir || '.', src === 'nav' ? 'redline-nav.log' : 'redline.log');
}

/**
 * load(src, dataDir[, opts]): { rows: [{ at, level, msg }] newest first (at most MAX_ROWS), note: '' or why there
 * are none }. opts: { file (another path, for tests), bytes }.
 */
function load(src, dataDir, opts) {
    const o = opts || {}, file = o.file || fileOf(src, dataDir), keep = IMPORTANT[src] || IMPORTANT.redline;
    try {
        // stat, not existsSync: a folder apps may not enter reads as missing there, and here says so
        if (!fs.statSync(file).isFile()) return { rows: [], note: 'Could not read ' + path.basename(file) + ': not a file' };
        const rows = linesOf(file, o.bytes || TAIL_BYTES).map(parse).filter(keep).map(tidy);
        return { rows: rows.slice(-MAX_ROWS).reverse(), note: rows.length ? '' : 'Nothing important in the last ' + Math.round((o.bytes || TAIL_BYTES) / 1024) + ' KB' };
    } catch (e) {
        const code = e && e.code;
        // (the folder said: a Redline that can't write its own log shows where it looked)
        if (code === 'ENOENT' || code === 'ENOTDIR') return { rows: [], note: src === 'cluster' ? 'No cluster-render log here (not installed, or an older Cluster renderer)' : 'No log yet in ' + path.dirname(file) };
        return { rows: [], note: code === 'EACCES' || code === 'EPERM' ? 'Apps may not read ' + file : 'Could not read ' + path.basename(file) + ': ' + (code || e) };
    }
}

/** A row as shown: cluster-render's start line (the renderer library's own, long) as "cluster-render started". */
function tidy(r) {
    return /Starting Ramses Client Application/.test(r.msg) ? { at: r.at, level: r.level, msg: 'cluster-render started' } : r;
}

/** Whether the head unit keeps its time in UTC (the cars seen so far: the stamps then aren't the car's clock). */
function isUtc() { return new Date().getTimezoneOffset() === 0; }

/** "11-11 03:02:41" in the head unit's time zone, UTC on the cars seen so far ('' without a time). */
function stamp(at) {
    if (!isFinite(at)) return '';
    const d = new Date(at), p = (n) => (n < 10 ? '0' : '') + n;
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** The guard's lines in cluster-render's status reply ("guard: hud 0x323 ...: disabled, 2 strikes"). */
function guardLines(text) {
    return String(text || '').split('\n').map((l) => l.trim()).filter((l) => /^guard:/.test(l));
}

module.exports = { load, parse, tail, linesOf, stamp, isUtc, guardLines, IMPORTANT, CR_LOG, TAIL_BYTES, MAX_ROWS };
