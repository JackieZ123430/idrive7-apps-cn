'use strict';

// Redline's Logs page reading (apps/redline/logview.js):
//   node kit/tools/test_redline_logview.js
// - the important lines only, newest first, from the end of the file (and of the older .1 when the newer is short);
// - a cut at the start of the tail never shows half a line;
// - a missing file is a note, never a throw; cluster-render's guard lines picked from its status reply.

const fs = require('fs');
const os = require('os');
const path = require('path');
const LogView = require(path.join(__dirname, '..', '..', 'apps', 'redline', 'logview'));

let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL ' + m); } };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-logview-'));

// parse: Redline's, the nav log's and a cluster-render-style line
let r = LogView.parse('2026-11-11T02:40:05.000Z WARN unit 0x07: no answer');
ok(r.level === 'WARN' && r.msg === 'unit 0x07: no answer' && r.at === Date.parse('2026-11-11T02:40:05.000Z'), 'parse: a Redline line');
r = LogView.parse('2026-11-11T02:40:05.000Z nav: guidance available');
ok(r.level === '' && r.msg === 'nav: guidance available', 'parse: a nav line (no level)');
r = LogView.parse('2026-11-11 02:40:05.123 [E] guard: hud 0x323 0x1000400 0 disabled at strike 2');
ok(r.level === 'ERROR' && /^guard:/.test(r.msg) && isFinite(r.at), 'parse: a cluster-render-style line (' + JSON.stringify(r) + ')');
r = LogView.parse('no time here');
ok(!isFinite(r.at) && r.msg === 'no time here' && LogView.stamp(r.at) === '', 'parse: a line without a time');

// load: the important lines, newest first
const f = path.join(dir, 'redline.log');
fs.writeFileSync(f, [
    '2026-11-11T02:10:01.000Z INFO starting redline 2.0.22',
    '2026-11-11T02:10:02.000Z INFO knock: nothing',
    '2026-11-11T02:10:03.000Z INFO driving mode: 0 -> not a mode, comfort kept',
    '2026-11-11T02:10:04.000Z INFO hud: target disabled by the mapping guard',
    '2026-11-11T02:10:05.000Z WARN unit 0x07: no answer',
    '2026-11-11T02:10:06.000Z INFO peaks reset',
].join('\n') + '\n');
let res = LogView.load('redline', dir);
ok(res.rows.length === 4 && res.note === '', 'redline: 4 important lines (' + res.rows.map((x) => x.msg).join(' | ') + ')');
ok(res.rows[0].msg === 'unit 0x07: no answer' && res.rows[3].msg === 'starting redline 2.0.22', 'redline: newest first');
ok(!res.rows.some((x) => /knock: nothing|peaks reset/.test(x.msg)), 'redline: everyday lines left out');

// the older file before it when the newer one is short
fs.writeFileSync(f + '.1', '2026-11-10T22:00:00.000Z ERROR older error\n');
res = LogView.load('redline', dir);
ok(res.rows[res.rows.length - 1].msg === 'older error', 'redline: the .1 file read when the newer is short');

// a tail cut mid-line: that line left out, never half shown
const big = path.join(dir, 'big.log'), pad = [];
for (let i = 0; i < 400; i++) pad.push('2026-11-11T03:00:' + String(i % 60).padStart(2, '0') + '.000Z WARN line ' + i + ' ' + 'x'.repeat(40));
fs.writeFileSync(big, pad.join('\n') + '\n');
res = LogView.load('redline', dir, { file: big, bytes: 4096 });
ok(res.rows.length > 10 && res.rows.every((x) => /^line \d+ x{40}$/.test(x.msg) && x.level === 'WARN'), 'tail: whole lines only');
ok(res.rows[0].msg.indexOf('line 399 ') === 0, 'tail: the last line first');
res = LogView.load('redline', dir, { file: big, bytes: 1024 * 1024 });
ok(res.rows.length === LogView.MAX_ROWS, 'at most ' + LogView.MAX_ROWS + ' rows (' + res.rows.length + ')');

// the nav log: the probe and its sources, not every value
fs.writeFileSync(path.join(dir, 'redline-nav.log'), [
    '2026-11-11T02:00:00.000Z nav: probe started (2026-11-11T02:00:00.000Z)',
    '2026-11-11T02:00:01.000Z nav: guidance guidanceState = "ACTIVE"',
    '2026-11-11T02:00:02.000Z nav: phone currentLaneGuiding = {"lanes":[]}',
    '2026-11-11T02:00:03.000Z nav: carplay not available',
].join('\n') + '\n');
res = LogView.load('nav', dir);
ok(res.rows.length === 3 && !res.rows.some((x) => /currentLaneGuiding/.test(x.msg)), 'nav: the probe, the guide and its sources (' + res.rows.map((x) => x.msg).join(' | ') + ')');

// missing files: a note, never a throw
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-logview-none-'));
res = LogView.load('redline', empty);
ok(res.rows.length === 0 && /No log/.test(res.note), 'redline: no file, a note');
res = LogView.load('cluster', empty, { file: path.join(empty, 'cluster-render.log') });
ok(res.rows.length === 0 && /cluster-render/.test(res.note), 'cluster: no file, a note (' + res.note + ')');
fs.writeFileSync(path.join(empty, 'redline.log'), '2026-11-11T02:10:02.000Z INFO knock: nothing\n');
res = LogView.load('redline', empty);
ok(res.rows.length === 0 && /Nothing important/.test(res.note), 'redline: nothing important, a note');

// cluster-render: its guard and Dcsm2 lines
fs.writeFileSync(path.join(empty, 'cr.log'), [
    '2026-11-11T02:31:14.000Z INFO dcsm: Dcsm2 not available',
    '2026-11-11T02:31:14.000Z WARN guard: hud 0x323 0x1000400 0: strike 1 of 2: 3200 ms after mapping it (target shown)',
    '2026-11-11T02:31:15.000Z INFO upload: cap 4 MB/s',
].join('\n') + '\n');
res = LogView.load('cluster', empty, { file: path.join(empty, 'cr.log') });
ok(res.rows.length === 2 && /strike 1/.test(res.rows[0].msg), 'cluster: the strike and Dcsm2 going away (' + res.rows.map((x) => x.msg).join(' | ') + ')');

// cluster-render on a car (issue #141's photos): the strike, Dcsm2 and the heartbeat kept, the start shortened;
// the once-a-minute frame counts and each layer made left out (they buried the strikes)
fs.writeFileSync(path.join(empty, 'cr2.log'), [
    '2026-11-10T22:28:24.000Z ERROR dcsm: the KOMBI refused a heartbeat request: type 0x81, return code 0x43 (4894 sent, 4894 replies)',
    '2026-11-10T22:28:54.000Z INFO target hud: in the last 60 s its layers wrote 710 frames (0 ms from offer to flush on average), 3653 KB, 0 failed',
    '2026-11-10T22:46:39.000Z INFO client 2 (redline): image layer 19 on hud (overlay, z 0)',
    '2026-11-10T22:46:39.000Z INFO target hud: asking for scene 0x1000400 58756 ms after its release, which the display confirmed',
    '2026-11-10T22:46:40.000Z INFO dcsm: Dcsm2 not available',
    '2026-11-10T22:46:40.000Z WARN guard: hud 0x323 0x1000400 0: strike 1 of 2: 1460 ms after mapping it (target acquiring)',
    '2026-11-10T22:58:50.000Z INFO target hud: slot 0x323 class 0 scene 0x1000400 800x480, linger 3000 ms',
    '2026-11-10T22:58:50.000Z INFO ramses: 1794351530.212 [ Info ] ramses.Framework | Starting Ramses Client Application: cluster-render_ERamsesCommunicationUserInternal',
    '2026-11-10T22:58:56.000Z INFO dcsm: Dcsm2 available',
].join('\n') + '\n');
res = LogView.load('cluster', empty, { file: path.join(empty, 'cr2.log') });
ok(JSON.stringify(res.rows.map((x) => x.msg.slice(0, 22))) === JSON.stringify(['dcsm: Dcsm2 available', 'cluster-render started', 'guard: hud 0x323 0x100', 'dcsm: Dcsm2 not availab', 'dcsm: the KOMBI refused'].map((x) => x.slice(0, 22))),
    'cluster: the strike, Dcsm2, the heartbeat and the start; no frame counts or layers (' + res.rows.map((x) => x.msg).join(' | ') + ')');

// Redline's switch-off and the car's states kept
fs.writeFileSync(path.join(empty, 'sw.log'), [
    '2026-11-11T02:10:01.000Z INFO vehicle state: 15 (not known)',
    '2026-11-11T02:10:02.000Z INFO hud: dropped, the car is switching off (state 12)',
    '2026-11-11T02:10:03.000Z INFO shutdown requested by MainApp',
].join('\n') + '\n');
res = LogView.load('redline', empty, { file: path.join(empty, 'sw.log') });
ok(res.rows.length === 3, 'redline: the switch-off, the drop and the car\'s state (' + res.rows.map((x) => x.msg).join(' | ') + ')');
// no log: the note says where it looked
res = LogView.load('redline', path.join(empty, 'nowhere'));
ok(res.note.indexOf(path.join(empty, 'nowhere')) >= 0, 'redline: no log, the folder in the note (' + res.note + ')');
ok(typeof LogView.isUtc() === 'boolean', 'isUtc');

// errors: never a throw, and the note says which
// a CRLF file: no carriage return on the screen
fs.writeFileSync(path.join(empty, 'crlf.log'), '2026-11-11T02:10:05.000Z WARN crlf line\r\n');
res = LogView.load('redline', empty, { file: path.join(empty, 'crlf.log') });
ok(res.rows.length === 1 && res.rows[0].msg === 'crlf line', 'a CRLF line without its carriage return (' + JSON.stringify(res.rows[0] && res.rows[0].msg) + ')');
// a folder where the file should be
const asDir = path.join(empty, 'folder.log');
fs.mkdirSync(asDir);
res = LogView.load('redline', empty, { file: asDir });
ok(res.rows.length === 0 && /Could not read/.test(res.note), 'a folder for the file: a note (' + res.note + ')');
// refused: a file apps may not read (stat refused: a folder they may not enter; open refused: the file itself)
for (const which of ['statSync', 'openSync']) {
    const real = fs[which];
    fs[which] = function (p) { if (String(p).indexOf('cr.log') >= 0) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; } return real.apply(fs, arguments); };
    try { res = LogView.load('cluster', empty, { file: path.join(empty, 'cr.log') }); } catch (e) { res = { rows: [], note: 'threw ' + e }; }
    fs[which] = real;
    ok(res.rows.length === 0 && /Apps may not read/.test(res.note), 'cluster: ' + which + ' refused, "Apps may not read" (' + res.note + ')');
}

// the guard's lines in cluster-render's status reply
ok(JSON.stringify(LogView.guardLines('upload: cap 4\nguard: hud 0x323 0x1000400 0: disabled, 2 strikes\nslot 0x203 status 2')) ===
    JSON.stringify(['guard: hud 0x323 0x1000400 0: disabled, 2 strikes']), 'status: the guard line picked');
ok(LogView.guardLines(null).length === 0, 'status: none');

console.log('redline logview: ' + checks + ' checks, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
