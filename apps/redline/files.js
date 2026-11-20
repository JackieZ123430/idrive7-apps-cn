'use strict';
/** Redline's data files (README.md, "Files"): each written whole or not at all. */
const fs = require('fs');
const path = require('path');

/**
 * Write a small file whole or not at all (temp file, then rename): a power cut mid-write can't corrupt it.
 * Never throws; a failure is logged as "<what>: <error>" (what: "save <file name>" by default).
 */
function writeAtomic(file, text, log, what) {
    try { fs.writeFileSync(file + '.tmp', text); fs.renameSync(file + '.tmp', file); } catch (e) { if (log) log.warn((what || 'save ' + path.basename(file)) + ': ' + e); }
}

module.exports = { writeAtomic };
