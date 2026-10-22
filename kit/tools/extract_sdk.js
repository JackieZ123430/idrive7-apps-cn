#!/usr/bin/env node
'use strict';
/**
 * extract_sdk.js - rebuild BMW's oap-sdk from an app on YOUR OWN head unit.
 *
 * BMW does not ship oap-sdk as a separate module: it is browserified into every
 * app's javascript/app.js. This tool takes one of those bundles and writes:
 *
 *   <out>/index.js       require('oap-sdk') - the SDK's public API (OnlineApp,
 *                        someipBuilders, RhmiApplication, ...) backed by the bundle
 *   <out>/package.json
 *   <out>/source/        every oap-sdk module as a readable file at its real path
 *                        (source/src/core/OnlineApp.js, ...) - for reading, not loading
 *
 *   node kit/tools/extract_sdk.js <path/to/app.js> [out_dir=oap-sdk]
 *
 * Good sources on the unit (any BMW OAP app works, x_call is always there):
 *   /var/opt/public/oap/oap_12204/source/javascript/app.js     (x_call)
 *   /usr/lib/oap-mainapp/preinstalled_apps/x_call@*.tgz        (javascript/app.js inside)
 *
 * Only the bundle's module table is built; no module code runs during extraction.
 */
const fs = require('fs');
const path = require('path');

const [src, outDir = path.join(__dirname, '..', '..', 'oap-sdk')] = process.argv.slice(2);
if (!src) { console.error('usage: extract_sdk.js <app.js> [out_dir]'); process.exit(2); }
const text = fs.readFileSync(src, 'utf8');

// Public API name -> file inside oap-sdk
const API = {
    OnlineApp: 'src/core/OnlineApp.js',
    NsmProxy: 'src/core/NsmProxy.js',
    config: 'src/config/config.js',
    logging: 'src/logging/logging.js',
    loggingLevel: 'src/logging/loggingLevel.js',
    SDKError: 'src/errors/SDKError.js',
    someipBuilders: 'src/someip/someipBuilders.js',
    RhmiApplication: 'src/rhmi/RhmiApplication.js',
    RhmiResourcesLocator: 'src/rhmi/RhmiResourcesLocator.js',
    telephony: 'src/telephony/telephony.js',
    getVin: 'src/utils/getVin.js',
    runtimeVariant: 'src/utils/runtimeVariant.js',
    appstart: 'src-gen/joynr-includes/telematics/appstart.js',
    guidance: 'src/navigation/guiding/guidance.js',
    map: 'src/navigation/map/map.js',
    MapKmlContentTypeConverters: 'src/navigation/map/MapKmlContentTypeConverters.js',
    poi: 'src/navigation/poi/poi.js',
};

// Browserify bundle: (function(){function r(e,n,t){...}return r})()({modules},{},[entry]);
const prelude = '(function(){function r(e,n,t){';
const tail = /,\{\},\[[\d,]*\]\)\s*;?\s*$/;
if (!text.startsWith(prelude) || !tail.test(text)) { console.error('not a browserify bundle'); process.exit(1); }
const body = text.replace(tail, ',{},[])');          // drop the entry so nothing app-specific runs

// Module table: id -> [factory, {requireName: id}]
let mods;
// eslint-disable-next-line no-new-func
new Function('__cap', prelude + '__cap(e);' + body.slice(prelude.length))((e) => { mods = e; });

// Give every oap-sdk module its path: start at the "oap-sdk/..." requires, then follow relative ones.
const norm = (p) => path.posix.normalize(p).replace(/\.js$/, '') + '.js';
const name = {};
const queue = [];
for (const entry of Object.values(mods)) {
    for (const [k, v] of Object.entries(entry[1])) {
        if (k.startsWith('oap-sdk/') && typeof v === 'number' && !name[v]) { name[v] = norm(k.slice(8)); queue.push(v); }
    }
}
while (queue.length) {
    const id = queue.shift();
    const here = path.posix.dirname(name[id]);
    for (const [k, v] of Object.entries(mods[id][1])) {
        if (!k.startsWith('.') || typeof v !== 'number' || name[v]) continue;
        const p = norm(path.posix.join(here, k));
        if (p.startsWith('..')) continue;                   // left the SDK (app or joynr code)
        name[v] = p;
        queue.push(v);
    }
}
const byPath = {};
for (const [id, p] of Object.entries(name)) byPath[p] = Number(id);
const ids = {};
for (const [api, p] of Object.entries(API)) if (byPath[p] !== undefined) ids[api] = byPath[p];
if (ids.OnlineApp === undefined || ids.someipBuilders === undefined) {
    console.error('this bundle does not contain the oap-sdk core (OnlineApp/someipBuilders) - try another app');
    process.exit(1);
}

// SDK version: the app's package.json (next to javascript/) names the oap-sdk it was built with
const appDir = path.dirname(path.dirname(path.resolve(src)));
let version = '0.0.0-extracted';
try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
    const v = (pkg.dependencies || {})['oap-sdk'];
    if (v) version = v.replace(/^[^\d]*/, '');
} catch (e) { /* no package.json next to the bundle */ }

// Keep only what the public API needs (the SDK plus the lodash/joynr/... it uses), not the app itself.
const keep = new Set();
const todo = Object.keys(name).map(Number);           // every SDK module, reachable from the API or not
while (todo.length) {
    const id = todo.pop();
    if (keep.has(id) || !mods[id]) continue;
    keep.add(id);
    for (const v of Object.values(mods[id][1])) if (typeof v === 'number') todo.push(v);
}
const table = [...keep].sort((a, b) => a - b)
    .map((id) => `${id}:[${mods[id][0].toString()},${JSON.stringify(mods[id][1])}]`).join(',\n');

const out = `/* oap-sdk ${version} - extracted by extract_sdk.js from ${path.basename(appDir)} (${path.basename(src)}).
   Generated locally from the user's own firmware; not for redistribution.
   Readable source of every module: ./source/ */
var __r = ${text.slice(0, text.indexOf(')()(') + 4)}{
${table}
},{},[]);
var __ids = ${JSON.stringify(ids)};
Object.keys(__ids).forEach(function (name) {
    Object.defineProperty(module.exports, name, { enumerable: true, configurable: true,
        get: function () { var m = __r(__ids[name]); return (m && m[name]) ? m[name] : m; } });
});
`;
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'index.js'), out);
fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({
    name: 'oap-sdk', version, main: 'index.js',
    description: 'Extracted locally from an OAP app bundle by extract_sdk.js',
}, null, 2) + '\n');

// Readable source tree
const srcDir = path.join(outDir, 'source');
fs.rmSync(srcDir, { recursive: true, force: true });
for (const [id, p] of Object.entries(name)) {
    const fn = mods[id][0].toString();
    const code = fn.slice(fn.indexOf('{') + 1, fn.lastIndexOf('}')).replace(/^\n/, '');
    const reqs = Object.keys(mods[id][1]);
    const head = `/* oap-sdk/${p}\n * requires: ${reqs.join(', ') || '-'} */\n`;
    fs.mkdirSync(path.join(srcDir, path.dirname(p)), { recursive: true });
    fs.writeFileSync(path.join(srcDir, p), head + code + (code.endsWith('\n') ? '' : '\n'));
}

console.log(`oap-sdk ${version} written to ${outDir}`);
console.log(`  API (${Object.keys(ids).length}): ${Object.keys(ids).join(', ')}`);
console.log(`  readable source: ${Object.keys(name).length} modules in ${srcDir}`);
const missing = Object.keys(API).filter((k) => ids[k] === undefined);
if (missing.length) console.log('  not in this bundle (only matters if your app uses them): ' + missing.join(', '));
