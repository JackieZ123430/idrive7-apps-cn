#!/usr/bin/env node
'use strict';
/**
 * extract_sdk.js - rebuild BMW's oap-sdk from an app on YOUR OWN head unit.
 *
 * BMW does not ship oap-sdk as a separate module: it is browserified into every
 * app's javascript/app.js. This tool takes one of those bundles, keeps all of
 * its modules, and writes oap-sdk/index.js that exposes the SDK's public API
 * (OnlineApp, someipBuilders, RhmiApplication, ...) as require('oap-sdk').
 *
 *   node kit/tools/extract_sdk.js <path/to/app.js> [out_dir=oap-sdk]
 *
 * Good sources on the unit (any BMW OAP app works, x_call is always there):
 *   /var/opt/public/oap/oap_12204/source/javascript/app.js     (x_call)
 *   /usr/lib/oap-mainapp/preinstalled_apps/x_call@*.tgz        (javascript/app.js inside)
 */
const fs = require('fs');
const path = require('path');

const [src, outDir = path.join(__dirname, '..', '..', 'oap-sdk')] = process.argv.slice(2);
if (!src) { console.error('usage: extract_sdk.js <app.js> [out_dir]'); process.exit(2); }
const text = fs.readFileSync(src, 'utf8');

// Public API name -> module path inside the bundle (as the bundle's require maps name it)
const API = {
    OnlineApp: /oap-sdk\/src\/core\/OnlineApp(\.js)?$/,
    NsmProxy: /oap-sdk\/src\/core\/NsmProxy(\.js)?$/,
    config: /oap-sdk\/src\/config\/config(\.js)?$/,
    logging: /oap-sdk\/src\/logging\/logging(\.js)?$/,
    loggingLevel: /oap-sdk\/src\/logging\/loggingLevel(\.js)?$/,
    SDKError: /oap-sdk\/src\/+errors\/SDKError(\.js)?$/,
    someipBuilders: /oap-sdk\/src\/someip\/someipBuilders(\.js)?$/,
    RhmiApplication: /oap-sdk\/src\/rhmi\/RhmiApplication(\.js)?$/,
    RhmiResourcesLocator: /oap-sdk\/src\/rhmi\/RhmiResourcesLocator(\.js)?$/,
    telephony: /oap-sdk\/src\/telephony\/telephony(\.js)?$/,
    getVin: /oap-sdk\/src\/utils\/getVin(\.js)?$/,
    runtimeVariant: /oap-sdk\/src\/utils\/runtimeVariant(\.js)?$/,
    appstart: /oap-sdk\/src-gen\/joynr-includes\/telematics\/appstart(\.js)?$/,
    guidance: /oap-sdk\/src\/navigation\/guiding\/guidance(\.js)?$/,
    map: /oap-sdk\/src\/navigation\/map\/map(\.js)?$/,
    MapKmlContentTypeConverters: /oap-sdk\/src\/navigation\/map\/MapKmlContentTypeConverters(\.js)?$/,
    poi: /oap-sdk\/src\/navigation\/poi\/poi(\.js)?$/,
};

// Every "path":id pair from the bundle's per-module require maps.
const ids = {};
const re = /"((?:\.\.?\/|oap-sdk)[^"]*)":(\d+)/g;
let m;
while ((m = re.exec(text))) {
    for (const [name, rx] of Object.entries(API)) if (!ids[name] && rx.test(m[1])) ids[name] = m[2];
}
if (!ids.OnlineApp || !ids.someipBuilders) {
    console.error('this bundle does not contain the oap-sdk core (OnlineApp/someipBuilders) - try another app');
    process.exit(1);
}

// Browserify bundle: (function(){...return r})()({modules},{},[entry]); - drop the entry so nothing app-specific runs.
const tail = /,\{\},\[\d+\]\)\s*;?\s*$/;
if (!tail.test(text)) { console.error('not a browserify bundle (unexpected ending)'); process.exit(1); }
const body = text.replace(tail, ',{},[])');

const out = `/* oap-sdk - extracted by extract_sdk.js from ${path.basename(path.dirname(path.dirname(src)))} (${path.basename(src)}).
   Generated locally from the user's own firmware; not for redistribution. */
var __r = ${body};
var __ids = ${JSON.stringify(ids)};
Object.keys(__ids).forEach(function (name) {
    Object.defineProperty(module.exports, name, { enumerable: true, configurable: true,
        get: function () { var m = __r(__ids[name]); return (m && m[name]) ? m[name] : m; } });
});
`;
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'index.js'), out);
fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({
    name: 'oap-sdk', version: '0.0.0-extracted', main: 'index.js',
    description: 'Extracted locally from an OAP app bundle by extract_sdk.js',
}, null, 2) + '\n');
console.log('oap-sdk written to ' + outDir + ' (' + Object.keys(ids).length + ' API entries: ' + Object.keys(ids).join(', ') + ')');
const missing = Object.keys(API).filter((k) => !ids[k]);
if (missing.length) console.log('not in this bundle (only matters if your app uses them): ' + missing.join(', '));
