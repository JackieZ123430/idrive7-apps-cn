'use strict';
/**
 * mainapp-patch.js - make MainApp show custom apps that the backend does not know.
 *
 *   node mainapp-patch.js <stock main.js> <patched main.js out>
 *
 * Why: MainApp asks the Telematics provisioning service for every app's
 * "-enabled/-allowed" flags. That data is a BMW-signed XML, so custom apps have
 * no entry and MainApp hides them (enabled=false).
 *
 * The patch adds ONE fallback in ProvisioningNotifier: when the provisioning
 * data for an app is empty, MainApp looks the app up in
 *   /var/opt/public/oap/oap_12201/data/custom_apps.json
 * and uses the defaults listed there. Apps provisioned by BMW are never touched;
 * an app missing from that file behaves exactly as stock.
 *
 * Node 8 compatible (runs on the head unit).
 */
const fs = require('fs');

const LIST = '/var/opt/public/oap/oap_12201/data/custom_apps.json';
const MARK = '/*mgu-custom-apps*/';
const CLASS_ANCHOR = 'class ProvisioningNotifier extends events_1.EventEmitter{';
const HOOK_ANCHOR = 'isMainapp&&section===mainAppSection&&(newProvisioning.installable_apps=this.modifyInstallableApps(newProvisioning.installable_apps))';

const HELPER = MARK + 'const __mguCustom=s=>{try{const c=JSON.parse(require("fs").readFileSync(' + JSON.stringify(LIST) +
    ',"utf8"))[s];return c?Object.assign({"-enabled":"true","-allowed":"true","-appStartType":"manually","-userLoginRequired":"false","-updateMechanism":"PLATFORM"},c):null}catch(e){return null}};';
const HOOK = 'if(isMainapp&&(!newProvisioning||0===Object.keys(newProvisioning).length)){const __c=__mguCustom(section);__c&&(logger.info(`${logPrefix} custom app provisioning for ${section}`),newProvisioning=__c)}';

function once(src, anchor, what) {
    const i = src.indexOf(anchor);
    if (i < 0 || src.indexOf(anchor, i + 1) >= 0) throw new Error(`anchor for ${what} not found exactly once - unknown MainApp version, not patching`);
    return i;
}

const [inFile, outFile] = process.argv.slice(2);
if (!inFile || !outFile) { console.error('usage: node mainapp-patch.js <main.js> <out>'); process.exit(2); }
let src = fs.readFileSync(inFile, 'utf8');
if (src.indexOf(MARK) >= 0) { console.error('input is already patched'); process.exit(3); }
const h = once(src, HOOK_ANCHOR, 'hook');
src = src.slice(0, h) + HOOK + src.slice(h);
const c = once(src, CLASS_ANCHOR, 'helper');
src = src.slice(0, c) + HELPER + src.slice(c);
fs.writeFileSync(outFile, src);
console.log('patched ->', outFile);
