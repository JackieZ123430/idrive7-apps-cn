'use strict';
// kit/runtime/hud_claim.js and Redline's side of it: a claim seen by the others while held and touched again, the
// standing app's marker on tmpfs, and Redline's HUD off again at a head-unit start (the standing app looked for a
// while) or the car's switch-off with a standing app there and hudHandBack on; on otherwise; the claim given
// back while the tach is hidden in Comfort / Eco Pro.
//   node kit/tools/test_hud_claim.js
const fs = require('fs');
const path = require('path');
const TH = require('./redline_test_harness');
const { TMP, SHM } = TH.claimsDir('hud-claim-');
const ROOT = TH.ROOT;
// a stand-in cluster-render: ready at once; pixels() answers nothing (whole pictures each time), no slot reports
TH.hookKit({ clusterRender: TH.fakeClusterRender({ pixels: undefined, status: false }) });
const { HudClaim } = require(path.join(ROOT, 'kit', 'runtime', 'hud_claim'));
const Hud = require(path.join(ROOT, 'apps', 'redline', 'hud'));

const tally = TH.counter(), ok = tally.ok, sleep = TH.sleep;
const log = { info() {}, warn() {}, error() {} };
const until = (check, ms) => new Promise((res) => { const end = Date.now() + ms; const poll = () => (check() || Date.now() > end ? res() : setTimeout(poll, 50)); poll(); });
const at = (id) => JSON.parse(fs.readFileSync(path.join(SHM, id), 'utf8')).at;
const rm = TH.rmTree;   // the head unit (and the node8-runtime CI job) is Node 8.16.2: no fs.rmSync

(async () => {
    const a = new HudClaim('a', log);
    ok(!a.thisBoot() && HudClaim.others('b').length === 0, 'nothing held at the start');
    a.hold(true);
    const t1 = at('a');
    await sleep(2200);
    ok(at('a') > t1, 'touched again (the folder there already)');
    // each app runs as its own user: the folder is open to all (sticky) whatever the umask (no modes on Windows)
    if (process.platform !== 'win32') ok((fs.statSync(SHM).mode & 0o7777) === 0o1777, 'the claims folder is 1777, not ' + (fs.statSync(SHM).mode & 0o7777).toString(8));
    ok(HudClaim.others('b').join() === 'a' && HudClaim.others('a').length === 0, 'a held claim is seen by the others');
    // claims are written whole (a temp file renamed over it): one caught mid-write is not another app's claim
    fs.writeFileSync(path.join(SHM, 'a.123.tmp'), JSON.stringify({ held: true, at: Date.now() }) + '\n');
    ok(HudClaim.others('b').join() === 'a' && fs.readdirSync(SHM).filter((n) => n.endsWith('.tmp') && n !== 'a.123.tmp').length === 0, 'a claim being written is not a claim; no temp files left over');
    fs.unlinkSync(path.join(SHM, 'a.123.tmp'));
    a.hold(false);
    ok(HudClaim.others('b').length === 0 && a.thisBoot(), 'given back: not seen, still known for this boot');

    ok(!HudClaim.standingOn('redline'), 'no standing app');
    HudClaim.standing('robertn_waze_cluster', true);
    ok(HudClaim.standingOn('redline') && !HudClaim.standingOn('robertn_waze_cluster'), 'a standing app is seen by the others, not by itself');
    ok(HudClaim.others('x').indexOf('robertn_waze_cluster.standing') < 0, 'a standing marker is no claim');

    const settings = (over) => {
        const v = Object.assign({ hud: 'on', hudHandBack: true, hudComfortMode: 'same' }, over), fns = [];
        return { v, get: (k) => v[k], set: (k, x) => { v[k] = x; fns.forEach((f) => f(k, x)); }, onChange: (f) => fns.push(f) };
    };
    let cond, drive = 'sport';
    const start = (s) => Hud.start({ settings: s, log, dataDir: TMP }, { data: () => ({ condition: cond }), shiftPoint: () => ({}), redline: () => 6500,
        maxRpm: () => 7000, driveMode: () => drive });

    // a head unit start (no claim of Redline's on tmpfs): off again
    let s = settings();
    let h = start(s);
    ok(s.v.hud === 'off', 'a new head-unit start: Redline\'s HUD off, back to the standing app');
    h.stop();

    // the standing app comes after Redline: looked for, then off
    rm(path.join(SHM, 'redline'));
    HudClaim.standing('robertn_waze_cluster', false);
    s = settings(); h = start(s);
    ok(s.v.hud === 'on', 'no standing app yet: on');
    HudClaim.standing('robertn_waze_cluster', true);
    await until(() => s.v.hud === 'off', 6000);
    ok(s.v.hud === 'off', 'the standing app came within the start\'s look: off');
    h.stop();

    // hudHandBack off: stays on at a start
    rm(path.join(SHM, 'redline'));
    s = settings({ hudHandBack: false }); h = start(s);
    await sleep(2500);
    ok(s.v.hud === 'on', 'hudHandBack off: Redline\'s HUD stays on');
    h.stop();
    // and off is the default: not set at all, it stays on too
    const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'redline', 'app.json'), 'utf8')).settings.filter((x) => x.key === 'hudHandBack')[0];
    ok(spec && spec.default === true, 'hudHandBack is on by default (this fork: the map comes back)');
    rm(path.join(SHM, 'redline'));
    s = settings({ hudHandBack: undefined }); h = start(s);
    await sleep(2500);
    ok(s.v.hud === 'on', 'hudHandBack not set: Redline\'s HUD stays on');
    h.stop();

    // turned on in this boot: held until the car is switched off
    s = settings({ hud: 'off' }); h = start(s);
    s.set('hud', 'on');
    ok(HudClaim.others('robertn_waze_cluster').join() === 'redline', 'turned on: Redline holds the HUD');
    // hidden in Comfort: given back while hidden
    s.v.hudComfortMode = 'hide'; drive = 'comfort';
    await until(() => HudClaim.others('robertn_waze_cluster').length === 0, 3000);
    ok(HudClaim.others('robertn_waze_cluster').length === 0, 'tach hidden in Comfort: the claim given back');
    drive = 'sport';
    await until(() => HudClaim.others('robertn_waze_cluster').length === 1, 3000);
    ok(HudClaim.others('robertn_waze_cluster').join() === 'redline', 'back in Sport: held again');
    // Don't show in Comfort (Redline only in Sport): the switch-off keeps Redline's HUD on, nothing handed back
    cond = 10;
    await sleep(4500);       // the 2 s check has seen the car on (twice)
    cond = 5;
    await sleep(4500);
    ok(s.v.hud === 'on', 'Sport-only setup: switched off, Redline\'s HUD stays on (the next drive starts in Comfort)');
    // Same as Sport in Comfort: handed back at the switch-off
    s.v.hudComfortMode = 'same';
    cond = 10;
    await sleep(4500);
    ok(s.v.hud === 'on', 'still on while driving');
    cond = 5;
    await until(() => s.v.hud === 'off', 8000);
    ok(s.v.hud === 'off' && HudClaim.others('robertn_waze_cluster').length === 0, 'switched off: Redline\'s HUD off, the claim given back');
    h.stop();

    // without a standing app Redline keeps its HUD on
    rm(SHM);
    s = settings(); h = start(s);
    await sleep(2500);
    ok(s.v.hud === 'on', 'no standing app: Redline\'s HUD stays on after a start');
    // a claim folder that cannot be written: no new start
    rm(SHM);
    fs.writeFileSync(SHM, 'not a folder');
    HudClaim.standing('robertn_waze_cluster', true);
    ok(new HudClaim('redline', log).thisBoot(), 'an unwritable claim folder: not a new start');
    console.log('hud claim: ' + tally.checks + ' checks, ' + tally.fails + ' failed');
    process.exit(tally.fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });   // Node 8 exits 0 on a rejection
