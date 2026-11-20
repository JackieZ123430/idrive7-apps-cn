'use strict';
// Redline's shift.json for other apps (apps/redline/shareshift.js; bimmer-lab/apps#4): written whole, readable by
// every user, at most once a second unless forced (a shift), never throwing; main.js writes it from live data only.
//   node kit/tools/test_redline_shareshift.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const TH = require('./redline_test_harness');
const ROOT = TH.ROOT;
const APP = path.join(ROOT, 'apps', 'redline');
const { ShiftShare } = require(path.join(APP, 'shareshift'));

const tally = TH.counter(), ok = tally.ok;
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-share-'));
const dir = path.join(base, 'redline');
const warns = [];
const share = new ShiftShare({ dir: dir, log: { warn: (m) => warns.push(m) } });
const V = { redline: 6550, shiftPoints: { 1: 6200, 2: 6250 }, gear: 2, shiftNow: 6250, cold: false, leadMs: 240, mode: 'M',
    lastShift: { at: 1, from: 1, to: 2, rpm: 6280, target: 6250, verdict: 'SPOT ON' } };

ok(share.write(V, false, 10000) === true, 'first write goes out (the folder is made)');
const file = path.join(dir, 'shift.json');
const j = JSON.parse(fs.readFileSync(file, 'utf8'));
ok(j.v === 1 && j.t === 10000 && j.redline === 6550 && j.shiftPoints['2'] === 6250 && j.shiftNow === 6250 && j.leadMs === 240 && j.mode === 'M' && j.lastShift.verdict === 'SPOT ON',
    'the file holds v, t and the values (' + JSON.stringify(j) + ')');
ok(fs.readdirSync(dir).filter((n) => /\.tmp$/.test(n)).length === 0, 'written whole: no temp file left behind');
if (process.platform !== 'win32') {
    ok((fs.statSync(dir).mode & 0o777) === 0o755 && (fs.statSync(file).mode & 0o777) === 0o644, 'folder 0755 and file 0644: readable by every app\'s user');
}
ok(share.write(Object.assign({}, V, { shiftNow: 6300 }), false, 10500) === false && JSON.parse(fs.readFileSync(file, 'utf8')).shiftNow === 6250, 'at most once a second');
ok(share.write(Object.assign({}, V, { shiftNow: 6300 }), true, 10600) === true && JSON.parse(fs.readFileSync(file, 'utf8')).shiftNow === 6300, 'a shift writes at once (force)');
ok(share.write(V, false, 11700) === true, 'a second later it writes again');
// a folder that can't be made: no throw, one warning
const bad = new ShiftShare({ dir: path.join(file, 'not-a-folder'), log: { warn: (m) => warns.push(m) } });
let threw = false;
try { bad.write(V, true); bad.write(V, true); } catch (e) { threw = true; }
ok(!threw && warns.length === 1, 'a failure never throws and is logged once (' + warns.length + ')');

// main.js: written from the sample loop and at each shift, never from the demo drive
const src = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');
ok(/require\('\.\/shareshift'\)/.test(src) && /shareShift\(true\)/.test(src) && /shareShift\(false\)/.test(src), 'main.js writes it each sample (throttled) and at each shift');
ok(/function shareShift\(force\) \{\s*const d = car\.data\(\);\s*if \(d\.demo\) return;/.test(src), 'main.js: never from the demo drive');

try { fs.rmSync ? fs.rmSync(base, { recursive: true, force: true }) : null; } catch (e) { /* temp */ }
console.log('redline shift.json: ' + tally.checks + ' checks, ' + tally.fails + ' failed');
process.exit(tally.fails ? 1 : 0);
