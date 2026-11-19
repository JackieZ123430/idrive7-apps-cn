'use strict';
// Ambient config (apps/ambient_config/others.js): IterioDev's Comfort tool counts as writing the lights only while its
// control socket is there (a socket, not any file) AND its own ambient colour or drive-mode colours are on in its
// data.json (unreadable settings: stand aside, as before). Comfort for the Seats app alone leaves the lights to us.
// Said once each way in the log, with a change event each time.
//   node kit/tools/test_ambient_others.js
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'others-'));
const sock = path.join(dir, 'ctl.sock'), data = path.join(dir, 'data.json');
process.env.MGU_AMBIENT_COMFORT = sock;
process.env.MGU_AMBIENT_COMFORT_DATA = data;
const { Others } = require(path.join(__dirname, '..', '..', 'apps', 'ambient_config', 'others'));

let fails = 0, checks = 0;
const ok = (c, msg) => { checks++; if (!c) { fails++; console.log('FAIL ' + msg); } };
const said = [];
const log = { info: (m) => said.push('info ' + m), warn: (m) => said.push('warn ' + m) };
const warns = () => said.filter((s) => s.startsWith('warn '));
const ambient = (a) => fs.writeFileSync(data, JSON.stringify({ ambient: a, memories: {}, settings: {} }));

const o = new Others({ log });
let changes = 0;
o.on('change', () => { changes++; });
o.check();
ok(o.comfort === false && o.running === false && changes === 0 && said.length === 0, 'not running: nothing said');
fs.writeFileSync(sock, '');
o.check();
ok(o.comfort === false && o.running === false && changes === 0, 'a plain file is not its socket');
fs.unlinkSync(sock);
const server = net.createServer().listen(sock, () => {
    // Comfort for the seats: no data.json yet, then its ambient off
    o.check();
    ok(o.running === true && o.comfort === false && changes === 0 && warns().length === 0, 'seats only (no settings yet): lights stay ours');
    ambient({ on: false, rgb: [254, 0, 0], modes: { on: false, rgb: {} } });
    o.check();
    ok(o.comfort === false && changes === 0, 'seats only (its ambient off): lights stay ours');
    // its own colour on: stand aside, said once
    ambient({ on: true, rgb: [0, 0, 254], modes: { on: false } });
    o.check(); o.check();
    ok(o.comfort === true && changes === 1 && warns().length === 1 && /writes the ambient lights/.test(warns()[0]), 'its colour on: stand aside, said once');
    // off again: ours again
    ambient({ on: false, modes: { on: false } });
    o.check();
    ok(o.comfort === false && changes === 2 && /no longer writes the ambient lights/.test(said[said.length - 1]), 'its colour off: ours again');
    // its drive-mode colours on: stand aside
    ambient({ on: false, modes: { on: true, rgb: { 1: [0, 254, 0] } } });
    o.check();
    ok(o.comfort === true && changes === 3, 'its drive-mode colours on: stand aside');
    // unreadable settings: stand aside as before
    fs.writeFileSync(data, '{not json');
    o.check();
    ok(o.comfort === true && changes === 3, 'unreadable settings: stay aside');
    ambient({ on: false });
    o.check();
    ok(o.comfort === false && changes === 4, 'readable and off: ours');
    fs.writeFileSync(data, '{not json');
    o.check();
    ok(o.comfort === true && changes === 5 && /cannot be read/.test(warns()[warns().length - 1]), 'unreadable: stand aside, said so');
    server.close(() => {
        o.check();
        ok(o.comfort === false && o.running === false && changes === 6 && said.some((s) => /no longer running/.test(s)), 'stopped: ours, said once more');
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`test_ambient_others: ${checks - fails}/${checks} checks pass`);
        process.exit(fails ? 1 : 0);
    });
});
