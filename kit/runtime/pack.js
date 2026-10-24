'use strict';
/*
 * pack.js - read an app's data folder from the one compressed file the build makes of it
 * (kit/tools/build.py packs apps/<app>/<folder>/ into <folder>.pack, see kit/tools/pack_data.py).
 *
 *   const db = require('./kit/pack').open(path.join(__dirname, 'dtc_db'));
 *   db.json('sgbd_index.json')            // a whole (small) file, {} when missing
 *   db.get('tables/codes.json', '21F026')   // one key: only the part holding it is read
 *
 * Each file is stored deflated on its own; a big JSON object is split into parts by the first two
 * characters of its keys, so a lookup inflates a few KB instead of the whole table. Nothing is read
 * before it is asked for, and only the last few parts stay in memory. Without a .pack (preview,
 * development) the plain folder is read instead.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAGIC = 'MGUPACK1';
const KEEP = 48;                    // parsed parts kept in memory

function cache() {
    const m = new Map();
    return {
        get(k) { const v = m.get(k); if (v !== undefined) { m.delete(k); m.set(k, v); } return v; },
        set(k, v) { m.set(k, v); if (m.size > KEEP) m.delete(m.keys().next().value); return v; },
    };
}

function openPack(file) {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    if (head.toString('latin1', 0, 8) !== MAGIC) { fs.closeSync(fd); throw new Error(file + ': not a data pack'); }
    const ilen = head.readUInt32LE(8);
    const ibuf = Buffer.alloc(ilen);
    fs.readSync(fd, ibuf, 0, ilen, 12);
    // index: { files: { name: [offset, length] }, split: { name: true } }; offsets from the data start
    const index = JSON.parse(zlib.inflateRawSync(ibuf).toString('utf8'));
    const base = 12 + ilen, parts = cache();
    function part(name) {
        const hit = parts.get(name);
        if (hit !== undefined) return hit;
        const e = index.files[name];
        if (!e) return parts.set(name, {});
        const b = Buffer.alloc(e[1]);
        fs.readSync(fd, b, 0, e[1], base + e[0]);
        let v;
        try { v = JSON.parse(zlib.inflateRawSync(b).toString('utf8')); } catch (err) { v = {}; }
        return parts.set(name, v);
    }
    return {
        packed: true,
        has: (rel) => !!(index.files[rel] || index.split[rel]),
        json(rel) {
            if (!index.split[rel]) return part(rel);
            // a split file asked for whole: put its parts back together (avoid for big tables)
            const out = {};
            Object.keys(index.files).filter((n) => n.indexOf(rel + '#') === 0)
                .forEach((n) => Object.assign(out, part(n)));
            return out;
        },
        get(rel, key) {
            const k = String(key);
            return (index.split[rel] ? part(rel + '#' + k.slice(0, 2).toUpperCase()) : part(rel))[k];
        },
    };
}

function openFolder(dir) {
    const files = cache();
    const json = (rel) => {
        const hit = files.get(rel);
        if (hit !== undefined) return hit;
        let v;
        try { v = JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')); } catch (e) { v = {}; }
        return files.set(rel, v);
    };
    return {
        packed: false,
        has: (rel) => fs.existsSync(path.join(dir, rel)),
        json,
        get: (rel, key) => json(rel)[String(key)],
    };
}

/** dir = the data folder's path; dir + '.pack' is used when it is there. */
function open(dir) {
    const file = dir.replace(/[\\/]+$/, '') + '.pack';
    if (fs.existsSync(file)) {
        try { return openPack(file); } catch (e) { /* damaged: try the folder */ }
    }
    return openFolder(dir);
}

module.exports = { open, MAGIC };
