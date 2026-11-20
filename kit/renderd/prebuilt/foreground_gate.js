#!/usr/bin/env node
/*
 * Foreground gate for mgu-render: reports which apps' screens the HMI
 * shows in front, so the renderer shows an app's surface only then. The renderer
 * starts it (foreground_gate) and reads its reports on the descriptor named by
 * MGU_RENDER_REPORT_FD (stdout without it, as when run by hand; the
 * SOME/IP library logs on stdout); it exits when its stdin, held open by the
 * renderer, closes.
 *
 * The HMI serves every app's RHMI as an instance of
 * de.bmw.infotainment.hmi.remote.RemoteHmiApplication (iDrive 7) or
 * remote2.RemoteHmiApplication2 (iDrive 8), described where the unit's app
 * manager keeps it (INTERFACES, the first there). The instance's uuid
 * field is the app's RHMI uuid, and its applicationStack field has a ROOT_APP
 * entry while the app's screen is in front. Installed apps live in
 * <apps>/oap_<uid>/, which only the app manager creates, with the RHMI uuid in
 * rhmiData/application.json. The app may rewrite that file, so a uuid that
 * more than one folder claims goes to the one the app manager has registered
 * and is ignored without exactly one, and the file is read only if it is a
 * regular file of at most 64 KiB. Each change prints one line:
 *
 *   foreground [uid ...]
 *
 *   node foreground_gate.js [--someip /usr/lib/someip.node]
 *       [--interface <RemoteHmiApplication interface json>] [--apps /var/opt/public/oap]
 *
 * Runs on the unit's Node 8, as root, with its SOME/IP binding (the one the
 * oap-sdk uses) and the interface description the app manager ships.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_APP_JSON = 65536;

const INTERFACES = [
    '/usr/lib/oap-mainapp/src-gen/de_bmw_infotainment_hmi_remote_RemoteHmiApplication.json',
    '/usr/lib/oap-mainapp21/src-gen/someip/de_bmw_infotainment_hmi_remote2_RemoteHmiApplication2.json'
];
const DEFAULTS = {
    someip: '/usr/lib/someip.node',
    interface: null,
    apps: '/var/opt/public/oap'
};

/* The interface description: where the app manager keeps it, else (another app manager build, MainApp
 * 6.5.5's single bundle has no src-gen of its own) the first such file in a src-gen folder of a package
 * under /usr/lib, two levels deep at most; null without one. */
function findInterface(root) {
    const known = INTERFACES.find((f) => fs.existsSync(f));
    if (known) {
        return known;
    }
    const want = /^de_bmw_infotainment_hmi_remote2?_RemoteHmiApplication2?\.json$/;
    const look = (dir, depth) => {
        let names = [];
        try {
            names = fs.readdirSync(dir);
        } catch (e) {
            return null;
        }
        const hit = names.find((n) => want.test(n));
        if (hit) {
            return path.join(dir, hit);
        }
        if (depth === 0) {
            return null;
        }
        for (const n of names) {
            const found = look(path.join(dir, n), depth - 1);
            if (found) {
                return found;
            }
        }
        return null;
    };
    let pkgs = [];
    try {
        pkgs = fs.readdirSync(root || '/usr/lib');
    } catch (e) {
        return null;
    }
    for (const p of pkgs) {
        const found = look(path.join(root || '/usr/lib', p, 'src-gen'), 2);
        if (found) {
            return found;
        }
    }
    return null;
}

/* The JSON in file when it is a regular file of at most max bytes, else null. */
function readJson(file, max) {
    let fd = -1;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
        const st = fs.fstatSync(fd);
        if (st.isFile() && st.size <= max) {
            const buf = Buffer.alloc(st.size);
            fs.readSync(fd, buf, 0, st.size, 0);
            return JSON.parse(buf.toString('utf8'));
        }
    } catch (e) {
        // missing or not JSON
    } finally {
        if (fd >= 0) {
            fs.closeSync(fd);
        }
    }
    return null;
}

/* The uids the app manager has registered: its registry, <apps>/oap_12201/data/apps/<appId>.json
 * (its own folder: an app cannot write there), each with the app's userId. */
function registeredUids(dir) {
    const out = new Set();
    let names = [];
    try {
        names = fs.readdirSync(path.join(dir, 'oap_12201', 'data', 'apps'));
    } catch (e) {
        return out;
    }
    names.filter((n) => /\.json$/.test(n)).forEach((n) => {
        const entry = readJson(path.join(dir, 'oap_12201', 'data', 'apps', n), MAX_APP_JSON);
        const uid = entry && entry.userId;
        if (typeof uid === 'number' && uid % 1 === 0) {
            out.add(uid);
        }
    });
    return out;
}

/* RHMI uuid -> uid of the installed apps. A uuid more than one folder claims (an earlier
 * install's folder left behind) goes to the one the app manager has registered, when exactly
 * one of them is; else it is left out. */
function readApps(dir, log) {
    const claims = new Map();
    let names = [];
    try {
        names = fs.readdirSync(dir);
    } catch (e) {
        log(`apps: ${e.message}`);
    }
    names.forEach((name) => {
        const m = /^oap_(\d+)$/.exec(name);
        if (!m) {
            return;
        }
        const desc = readJson(path.join(dir, name, 'rhmiData', 'application.json'), MAX_APP_JSON);
        const uuid = desc && desc.application && desc.application.uuid;
        if (typeof uuid === 'string') {
            claims.set(uuid, (claims.get(uuid) || []).concat(Number(m[1])));
        }
    });
    const apps = new Map();
    let registered = null;
    claims.forEach((uids, uuid) => {
        registered = uids.length > 1 ? registered || registeredUids(dir) : registered;
        const live = uids.length > 1 ? uids.filter((uid) => registered.has(uid)) : uids;
        if (live.length === 1) {
            apps.set(uuid, live[0]);
        } else {
            log(`uuid ${uuid} is claimed by uids ${uids.join(', ')}; none of them is shown in front`);
        }
    });
    return apps;
}

function hasRootApp(stack) {
    return stack instanceof Map ? stack.has('ROOT_APP')
        : !!stack && Object.prototype.hasOwnProperty.call(stack, 'ROOT_APP');
}

function startGate(opts) {
    const { someip, interfaceConfig, appsDir, write, log } = opts;
    const front = new Map();   // instance name -> its stack has ROOT_APP
    const shown = new Map();   // instance name in front -> its uuid
    let apps = readApps(appsDir, log);
    let last = null;

    const report = () => {
        const uids = new Set();
        shown.forEach((uuid) => {
            if (apps.has(uuid)) {
                uids.add(apps.get(uuid));
            }
        });
        const line = ['foreground'].concat([...uids].sort((a, b) => a - b)).join(' ');
        if (line !== last) {
            last = line;
            write(`${line}\n`);
        }
    };
    const fail = (name) => (e) => log(`${name}: ${e && e.message || e}`);

    /* The stack is subscribed once per instance, whether offered yet or not;
     * the uuid is read each time the instance comes to the front, as an
     * instance number is reused once its app is gone. */
    const watch = (name) => someip.buildProxy(interfaceConfig, name).then((proxy) => proxy.init().then(() => {
        const leave = () => {
            front.set(name, false);
            if (shown.delete(name)) {
                report();
            }
        };
        proxy.subscribeToAvailability((available) => {
            if (!available) {
                leave();
            }
        });
        return proxy.subscribe({
            name: 'applicationStack',
            onReceive: (stack) => {
                if (!hasRootApp(stack)) {
                    leave();
                    return;
                }
                front.set(name, true);
                proxy.getValue('uuid').then((uuid) => {
                    if (front.get(name)) {
                        apps = readApps(appsDir, log);
                        shown.set(name, uuid);
                        report();
                    }
                }).catch(fail(name));
            }
        });
    })).catch(fail(name));

    report();
    Object.keys(interfaceConfig.instances).forEach(watch);
}

if (require.main === module) {
    const opt = Object.assign({}, DEFAULTS);
    for (let i = 2; i + 1 < process.argv.length; i += 2) {
        opt[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
    }
    const reportFd = Number(process.env.MGU_RENDER_REPORT_FD) || 1;
    process.stdin.on('end', () => process.exit(0));
    process.stdin.resume();
    const log = (s) => process.stderr.write(`foreground gate: ${s}\n`);
    const iface = opt.interface || findInterface();
    let interfaceConfig = null;
    try {
        interfaceConfig = JSON.parse(fs.readFileSync(iface, 'utf8'));
    } catch (e) {
        // this unit's app manager has no description of the RHMI interface: the gate cannot tell which
        // app is in front, and says so once (the renderer then shows the apps as without a gate)
        log(`no RemoteHmiApplication interface description (${iface || 'none found'}): ${e.message}`);
        fs.writeSync(reportFd, 'foreground unavailable\n');
    }
    if (interfaceConfig) {
        startGate({
            someip: require(opt.someip),
            interfaceConfig,
            appsDir: opt.apps,
            write: (s) => fs.writeSync(reportFd, s),
            log
        });
    }
}

module.exports = { startGate, readApps, hasRootApp, findInterface };
