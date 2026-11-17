'use strict';
/**
 * qrlog_dict.js - makes the QR log's compression dictionary (kit/runtime/qrlog-dict-<n>.txt) from the log calls'
 * text in apps/ and kit/runtime/: deflate then finds a log's usual words there, so a code holds about twice the lines.
 *
 *   node kit/tools/qrlog_dict.js 2      writes kit/runtime/qrlog-dict-2.txt
 *
 * A code names its dictionary's number, and qrlog_decode.py reads each number's file: never change a published
 * file, make the next number and point kit/runtime/qrlog.js's DICT at it.
 */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const n = Number(process.argv[2]);
if (!(n > 0)) { console.error('usage: node kit/tools/qrlog_dict.js <number>'); process.exit(1); }
const out = path.join(ROOT, 'kit', 'runtime', 'qrlog-dict-' + n + '.txt');
if (fs.existsSync(out)) { console.error(out + ' exists: published dictionaries never change'); process.exit(1); }

const files = [];
const walk = (d) => fs.readdirSync(d).forEach((f) => {
    const p = path.join(d, f), st = fs.statSync(p);
    if (st.isDirectory()) { if (!/^(node_modules|locales|fonts|custom_clusters|\.git)$/.test(f)) walk(p); } else if (/\.js$/.test(f)) files.push(p);
});
walk(path.join(ROOT, 'apps')); walk(path.join(ROOT, 'kit', 'runtime'));
files.sort();

const count = new Map();
const add = (s) => { s = s.replace(/\\n/g, ' ').trim(); if (s.length >= 5) count.set(s, (count.get(s) || 0) + 1); };
for (const f of files) {
    const src = fs.readFileSync(f, 'utf8'), re = /\b(?:log|this\.log|ctx\.log|L)\.(?:info|warn|error|debug)\(([^;]*?)\);/g;
    let m;
    while ((m = re.exec(src))) (m[1].match(/'([^'\\]|\\.)*'|`[^`]*`|"([^"\\]|\\.)*"/g) || []).forEach((l) => add(l.slice(1, -1).replace(/\$\{[^}]*\}/g, ' ')));
}
// what the kit and the platform add around them (no head unit's own text)
['Error: ', 'failed due to { Error: ', 'Service unavailable for call ', 'promiseWithTimeout: ', ' timed out', 'SDK_ERROR ',
    'WARN ', 'ERROR ', ' (UTC)', '-- 20', 'starting ', 'mapped entry ', ' -> MAIN', 'display: renderer placement {"x":0,"y":0,"w":1920,"h":720']
    .forEach((s) => count.set(s, (count.get(s) || 0) + 50));
// the most used last (deflate reaches the end of a dictionary most cheaply), at most 30 000 bytes
const list = [...count.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).map((e) => e[0]);
let text = '';
for (let i = list.length - 1; i >= 0; i--) {
    if (Buffer.byteLength(list[i] + '\n' + text) > 30000) break;
    text = list[i] + '\n' + text;
}
fs.writeFileSync(out, text);
console.log(path.relative(ROOT, out) + ': ' + Buffer.byteLength(text) + ' bytes from ' + files.length + ' files');
