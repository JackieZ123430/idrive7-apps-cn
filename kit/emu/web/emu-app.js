// emu-app.js - the emulator page: the app's renderer stream drawn by the car's draw engine (gfx/mgu-gfx.js,
// WebAssembly), mouse = touchscreen, keyboard / wheel = iDrive controller, the side panel. Protocol: kit/tools/emu.js.
const W = 1920, H = 720;
const $ = (s) => document.querySelector(s);
const el = (tag, attrs, ...kids) => {
  const e = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([k, v]) => { if (k === 'on') Object.entries(v).forEach(([n, f]) => e.addEventListener(n, f)); else if (k in e) e[k] = v; else e.setAttribute(k, v); });
  kids.forEach((k) => e.append(k));
  return e;
};
let canvas = $('#screen');
const stage = $('#stage');

/* ---------------- the renderer (may not be built yet) ---------------- */
// One renderer per app connection run; a new one (fresh canvas, the old one destroyed) for another app, after the
// WebGL context was lost, or when the shared glyph atlases are full (reset() keeps them, as the car's daemon does).
let gfx = null, gfxErr = null, gfxMod = null, gfxApp = null, gfxGen = 0, errSeen = 0;
let pending = null;         // bytes that come while a new renderer is being made wait for it
let awaitReset = false;     // a replay was asked for: bytes before its 'reset' are dropped
const gfxLog = (l) => (s) => addLog([[l, 'renderer: ' + s]]);
async function newGfx(app, replayAfter) {
  const gen = ++gfxGen;
  gfxApp = app; errSeen = 0;
  if (gfx) { try { gfx.destroy(); } catch (e) { /* lost already */ } gfx = null; }
  pending = [];
  const c = el('canvas', { id: 'screen', width: W, height: H });
  canvas.replaceWith(c); canvas = c;
  let g = null;
  try { g = await gfxMod.createGfx(c, { log: gfxLog('debug'), warn: gfxLog('warn'), onLost: () => { if (gen === gfxGen) renew('WebGL context lost'); } }); } catch (e) { gfxErr = e; console.warn('renderer:', e); }
  if (gen !== gfxGen) { if (g) g.destroy(); return; }    // a newer one was asked for meanwhile
  gfx = g;
  const q = pending; pending = null;
  if (replayAfter) { awaitReset = true; send({ t: 'replay' }); } else q.forEach(onBinary);
}
/** a new renderer with the connection so far (the server replays it) */
function renew(why) { addLog([['warn', 'renderer: ' + why + ': starting a new one']]); newGfx(gfxApp, true); }
try { gfxMod = await import('./gfx/mgu-gfx.js'); await newGfx(null); } catch (e) { gfxErr = e; console.warn('renderer:', e); }

/* ---------------- WebSocket ---------------- */
let ws = null;
const send = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
const S = { app: null, spec: null, values: {}, stack: [], closed: false, status: 'connecting', conn: { on: false }, focus: null, sig: null };
// what arrived from the app (for the stats and "renderer not built")
const rx = { frames: 0, msgs: 0, bytes: 0, types: {}, sawFrame: false, feedErr: null };
const NAMES = { 1: 'HELLO', 2: 'PLACE', 3: 'SHOW', 4: 'ATLAS', 5: 'RAMP', 6: 'LAYER', 7: 'FRAME', 8: 'DROP_LAYER', 9: 'IMAGE/CLAIM', 10: 'GRAB/IMAGE', 11: 'DROP_IMAGE', 12: 'FPS', 13: 'VIDEO', 14: 'DROP_VIDEO',
  0x4d520001: 'X_MODE', 0x4d520002: 'X_GRAB', 0x4d520003: 'X_PIXMAP', 0x4d520004: 'X_PIXELS', 0x4d520005: 'X_PALETTE' };

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { send({ t: 'fps', n: Number($('#fps').value) }); };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') { onText(JSON.parse(e.data)); return; }
    if (awaitReset) return;
    const u8 = new Uint8Array(e.data);
    if (pending) pending.push(u8); else onBinary(u8);
  };
  ws.onclose = () => { setStatus('disconnected'); setTimeout(connect, 1000); };
}

function onBinary(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let show = false;
  for (let o = 0; o + 8 <= u8.length;) {
    const t = dv.getUint32(o, true), len = dv.getUint32(o + 4, true);
    rx.types[t] = (rx.types[t] || 0) + 1; rx.msgs++;
    if (t === 7) { rx.frames++; rx.sawFrame = true; }
    if (t === 3) show = true;
    o += 8 + len;
  }
  rx.bytes += u8.length;
  if (!gfx) return;
  let r = 0;
  try { r = gfx.feed(u8); } catch (e) { r = -1; rx.feedErr = e; }
  if (r === 1) { const ms = gfx.stats().lastMs; draws.n++; draws.sum += ms; if (ms > draws.max) draws.max = ms; }
  if (r < 0 && gfx.stats().lost) return;      // (onLost makes a new renderer)
  // a malformed message: the car's daemon ends the connection ("bad message"); the app reconnects
  if (r < 0 && !rx.dropped) {
    rx.dropped = true;
    const why = (gfx.stats().error || (rx.feedErr && rx.feedErr.message) || 'bad message');
    addLog([['error', 'renderer: client dropped: ' + why]]);
    send({ t: 'drop', why });
  }
  // the surface shown or hidden (SHOW, or the first frame after it): the menu hint may come or go, painted or not
  if (show || (r === 1 && !$('#overlay').hidden)) overlay();
}

function onText(m) {
  switch (m.t) {
  case 'hello':
    S.app = m.app;
    $('#touchroute').checked = m.touch !== false;
    $('#app').replaceChildren(...m.apps.map((id) => el('option', { value: id, textContent: id, selected: id === m.app })));
    buildPicker(m.apps, m.titles || {});
    if (m.bg) { const b = $('#bgimg'); b.src = '/bg?' + Date.now(); b.hidden = false; }
    $('#log').replaceChildren();
    break;
  case 'spec': S.spec = m.spec; S.values = m.values || {}; S.app = m.spec.id; $('#app').value = m.spec.id; P.busy = null; picker(); buildSettings(); renderHmi(); $('#version').textContent = m.spec.title + ' ' + m.spec.version; break;
  case 'settings': S.values = m.values; syncSettings(); break;
  case 'status': setStatus(m.s, m.text); break;
  case 'reset':
    awaitReset = false; rx.feedErr = null; rx.dropped = false; rx.types = {};
    if (!gfxMod) break;
    if (!gfx || (gfxApp !== null && m.app !== gfxApp) || gfx.stats().atlasFull) newGfx(m.app);
    else { gfxApp = m.app; errSeen = 0; gfx.reset(); }
    break;
  case 'log': addLog(m.lines); break;
  case 'conn': S.conn = m; break;
  case 'screens': S.stack = m.stack; S.closed = !!m.closed; renderHmi(); picker(); break;
  case 'focus': S.focus = m.id; renderHmi(); break;
  case 'soft': { const s = $('#soft'); if (m.png) { s.src = 'data:image/png;base64,' + m.png; s.hidden = false; } else { s.hidden = true; s.removeAttribute('src'); } break; }
  case 'sigmode': S.sig = m; syncSignals(); break;
  case 'touchmode': $('#touchroute').checked = !!m.on; break;
  case 'note': toast(m.s, true); break;
  default: break;
  }
  overlay();
}

/* ---------------- frames: tick after each drawn one, stats ---------------- */
// every figure in the panel is this page's, over one window (about a second): frames shown, what came in, the draws
let shown = 0, lastStat = performance.now(), rx0 = { frames: 0, msgs: 0, bytes: 0 };
// each draw (gfx.feed draws on arrival, between two refreshes too): the CPU time of its draw calls, not the GPU's
const draws = { n: 0, sum: 0, max: 0 };
function raf(now) {
  // the frames received were drawn on arrival (gfx.feed); this refresh shows them: the app may send the next
  if (rx.sawFrame) { rx.sawFrame = false; shown++; send({ t: 'tick' }); }
  if (now - lastStat >= 1000) {
    let st = null;
    try { st = gfx ? gfx.stats() : null; } catch (e) { /* destroyed */ }
    if (st) {
      // errors the car's renderer sends the app (ERROR): logged here and passed on
      if (st.errors.count > errSeen) st.errors.last.slice(0, Math.min(4, st.errors.count - errSeen)).reverse().forEach((s) => { addLog([['warn', 'renderer error: ' + s]]); send({ t: 'rerror', s }); });
      errSeen = st.errors.count;
      if (st.atlasFull && !pending) renew('glyph atlas full');
    }
    const dt = (now - lastStat) / 1000, per = (x) => Math.round(x / dt), fps = per(shown);
    const avg = draws.n ? draws.sum / draws.n : null, max = draws.n ? draws.max : null;
    if (st) send({ t: 'gstats', fps, avgMs: avg || 0, maxMs: max || 0 });
    const c = S.conn;
    // (not cross-origin isolated, e.g. another host's page: performance.now() in 0.1 ms steps)
    $('#rstats').textContent = `${fps} fps  ` + (st ? `draw (CPU${self.crossOriginIsolated ? '' : ', 0.1 ms steps'}) ${fmt(avg)} ms avg, ${fmt(max)} max` : 'renderer not built') +
      `\n${per(rx.frames - rx0.frames)} frames/s  ${per(rx.msgs - rx0.msgs)} msgs/s  ${kb((rx.bytes - rx0.bytes) / dt)}/s`;
    $('#rconn').textContent = c.on ? `${c.app} · ${c.dialect}${c.shown ? ' · shown' : ' · hidden'}${c.grab ? ' · controller held' : ''}${c.claims ? ' · ' + c.claims + ' claims' : ''}${c.fps ? ' · app cap ' + c.fps : ''}` +
      (c.place ? `\nplace ${c.place.x},${c.place.y} ${c.place.w}x${c.place.h} ×${(+c.place.s).toFixed(3)}` : '') : 'no app connected';
    shown = 0; draws.n = draws.sum = draws.max = 0; lastStat = now; rx0 = { frames: rx.frames, msgs: rx.msgs, bytes: rx.bytes };
    overlay();
  }
  requestAnimationFrame(raf);
}
const fmt = (x) => (x == null ? '-' : (+x).toFixed(3));
const kb = (b) => (b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' kB');

/* ---------------- what covers the screen ---------------- */
function overlay() {
  const o = $('#overlay');
  let html = null;
  if (S.status === 'disconnected') html = '<div>Emulator not running</div><div class="mono">node kit/tools/emu.js &lt;app&gt;</div>';
  else if (S.status === 'exited') html = '<div>The app exited</div><div class="mono">see the log; save a file or press Restart</div>';
  else if (S.closed) html = null;                // (the HMI's app picker shows)
  else if (!gfx) {
    const top = Object.entries(rx.types).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t, n]) => `${NAMES[t] || t} ${n}`).join(' · ');
    html = '<div>Renderer not built</div><div class="mono">kit/emu/web/gfx/mgu-gfx.js: ' + esc(gfxErr ? String(gfxErr.message || gfxErr).slice(0, 140) : '') +
      '</div><div class="mono">received ' + rx.msgs + ' messages, ' + rx.frames + ' frames, ' + kb(rx.bytes) + (top ? '<br>' + top : '') + '</div>';
  } else if (menuOnly()) {
    // an HMI-native screen (a menu): the HMI draws it on the car, the emulator does not
    const m = topScreen(), btns = (m.items || []).filter((i) => i[0] === 'button').map((i) => i[2] || i[1]);
    html = '<div>' + esc(m.title || m.name) + ': the HMI\'s own menu screen, not drawn here</div><div class="mono">use the buttons under HMI in the panel' +
      (btns.length ? ': ' + esc(btns.join(' · ')) : '') + '</div>';
  }
  o.hidden = html === null;
  if (html !== null && o.dataset.html !== html) {
    o.innerHTML = html; o.dataset.html = html;
    const b = $('#reopen');
    if (b) b.onclick = () => send({ t: 'hmi', a: 'open' });
  }
}
/** the shown screen (the top of the app's stack) from the app's spec */
const topScreen = () => ((S.spec && S.spec.screens) || []).find((s) => s.name === S.stack[S.stack.length - 1]);
/** a menu screen on top and no surface of the app's shown (#soft, the HMI's image of a canvas screen, is not the menu) */
function menuOnly() {
  const m = topScreen();
  if (!m || m.kind !== 'menu') return false;
  try { return !gfx.stats().visible; } catch (e) { return false; }
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------------- touch: the mouse on the screen, in screen px ---------------- */
let down = null;
const at = (e) => { const r = stage.getBoundingClientRect(); return { x: Math.round((e.clientX - r.left) * W / r.width), y: Math.round((e.clientY - r.top) * H / r.height) }; };
stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('button, #picker')) return;
  try { stage.setPointerCapture(e.pointerId); } catch (x) { /* a pointer already gone */ }
  stage.focus({ preventScroll: true });
  down = e.pointerId;
  send(Object.assign({ t: 'touch', phase: 1 }, at(e)));
});
stage.addEventListener('pointermove', (e) => { if (down === e.pointerId) send(Object.assign({ t: 'touch', phase: 2 }, at(e))); });
const up = (e) => { if (down !== e.pointerId) return; down = null; send(Object.assign({ t: 'touch', phase: 3 }, at(e))); };
stage.addEventListener('pointerup', up);
stage.addEventListener('pointercancel', up);
// the focus ring only when Tab brought the focus here: Safari and Edge count stage.focus() (above, and at load) as :focus-visible
let tabbed = false;
document.addEventListener('keydown', (e) => { if (e.key === 'Tab') tabbed = true; }, true);
document.addEventListener('pointerdown', () => { tabbed = false; stage.classList.remove('kbd-focus'); }, true);
stage.addEventListener('focus', () => stage.classList.toggle('kbd-focus', tabbed));
stage.addEventListener('blur', () => stage.classList.remove('kbd-focus'));

/* ---------------- the controller: wheel and keys ---------------- */
let wheel = 0;
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  wheel += e.deltaMode === 1 ? e.deltaY / 3 : e.deltaMode === 2 ? e.deltaY * 3 : e.deltaY / 60;
  const n = Math.trunc(wheel);
  if (n) { wheel -= n; if (S.closed) pickMove(n); else send({ t: 'ccu', turn: n }); }
}, { passive: false });
const TILT = { ArrowUp: 'N', ArrowRight: 'E', ArrowDown: 'S', ArrowLeft: 'W' };
// keys belong to the panel's controls while one has the focus (and to the browser with a modifier)
const held = new Set();
const typing = (e) => !!(e.target.closest && e.target.closest('#panel, input, select, textarea, button')) || e.metaKey || e.ctrlKey || e.altKey;
document.addEventListener('keydown', (e) => {
  if (typing(e)) return;
  const k = e.key;
  // the app picker has the controller while it shows (the app is not on screen); BACK and HOME leave it there
  if (S.closed) {
    if (k === '[' || k === ']') pickMove(k === ']' ? 1 : -1);
    else if (TILT[k]) pickMove({ N: -5, S: 5, E: 1, W: -1 }[TILT[k]]);
    else if (k === 'Enter') { if (!e.repeat) pickOpen(P.focus); }
    else if (k === 'o' || k === 'O') pickOpen(P.tiles.findIndex((t) => t.id === S.app));
    else if (!(k === 'Backspace' || k === 'h' || k === 'H' || k === 'Home')) return;
    e.preventDefault();
    return;
  }
  if (k === '[' || k === ']') send({ t: 'ccu', turn: k === ']' ? 1 : -1 });
  else if (k === 'Enter') { if (!e.repeat) { held.add(k); send({ t: 'ccu', press: true }); } }
  else if (TILT[k]) { if (!e.repeat) { held.add(k); send({ t: 'ccu', tilt: TILT[k] }); } }
  else if (k === 'Backspace') send({ t: 'hmi', a: 'back' });
  else if (k === 'h' || k === 'H' || k === 'Home') send({ t: 'hmi', a: 'home' });
  else if (k === 'o' || k === 'O') send({ t: 'hmi', a: 'open' });
  else return;
  e.preventDefault();
});
document.addEventListener('keyup', (e) => {
  if (!held.delete(e.key)) return;              // (only a press or push this page sent)
  if (e.key === 'Enter') send({ t: 'ccu', press: false });
  else if (TILT[e.key]) send({ t: 'ccu', tilt: null });
});
window.addEventListener('blur', () => { send({ t: 'ccu', press: false }); send({ t: 'ccu', tilt: null }); });

/* ---------------- panel: app, HMI ---------------- */
function setStatus(s, text) {
  S.status = s;
  const p = $('#status'); p.textContent = s; p.className = 'pill ' + s;
  const b = $('#builderr');
  if (s === 'build-error') { b.textContent = text || ''; b.hidden = false; toast('Build failed: the app from the last good build keeps running'); } else if (s === 'running') { b.hidden = true; toast(null); }
  // a chosen app that did not build: the running one stays current (the server went back to it)
  if (s === 'build-error' && P.busy) { P.busy = null; if (S.app) $('#app').value = S.app; picker(); }
  overlay();
}
let toastT = null;
function toast(t, info) { const e = $('#toast'); clearTimeout(toastT); e.hidden = !t; e.classList.toggle('info', !!info); e.textContent = t || ''; if (t) toastT = setTimeout(() => { e.hidden = true; }, 6000); }
$('#app').onchange = (e) => { send({ t: 'app', id: e.target.value }); $('#log').replaceChildren(); };
$('#restart').onclick = () => send({ t: 'restart' });
$('#shot').onclick = () => screenshot().catch((e) => { console.warn('screenshot:', e); toast('Screenshot failed: ' + (e.message || e)); });

/* ---------------- screenshot: the screen as shown, a 1920 x 720 PNG ---------------- */
// The HMI around the app (the stage's other parts: a copy of their HTML drawn as an SVG image, at 1920 x 720, so
// --u is 1 px) under the renderer's own picture of the app (gfx.readPixels, see-through where the HMI shows).
async function screenshot() {
  const out = el('canvas', { width: W, height: H }), g = out.getContext('2d');
  const copy = stage.cloneNode(true);
  copy.querySelectorAll('canvas, #overlay, #toast').forEach((e) => e.remove());
  copy.classList.remove('kbd-focus');
  copy.style.cssText = `width:${W}px;height:${H}px;border-radius:0;box-shadow:none`;
  // an SVG image loads nothing: its pictures go in as data URLs
  await Promise.all([...copy.querySelectorAll('img')].map(async (im) => {
    if (im.hidden || !im.getAttribute('src') || im.src.startsWith('data:')) return;
    try {
      const b = await (await fetch(im.src)).blob();
      im.src = await new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });
    } catch (e) { im.remove(); }
  }));
  const css = [...document.styleSheets].map((s) => { try { return [...s.cssRules].map((r) => r.cssText).join('\n'); } catch (e) { return ''; } }).join('\n');
  const bs = getComputedStyle(document.body);       // (the copy is outside <body>: its font and colour come along)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><foreignObject width="100%" height="100%">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="font:${bs.font.replace(/"/g, "'")};color:${bs.color}"><style>${css.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</style>${new XMLSerializer().serializeToString(copy)}</div></foreignObject></svg>`;
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  g.drawImage(img, 0, 0, W, H);
  // the app, as the renderer shows it (not while the HMI's app picker has the screen)
  if (gfx && getComputedStyle(canvas).visibility !== 'hidden') {
    const px = gfx.readPixels(), layer = el('canvas', { width: W, height: H });
    layer.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, px.length), W, H), 0, 0);
    g.drawImage(layer, 0, 0);
  }
  const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
  const a = el('a', { href: URL.createObjectURL(blob), download: `emulator-${S.app || 'screen'}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
document.querySelectorAll('[data-hmi]').forEach((b) => { b.onclick = () => send({ t: 'hmi', a: b.dataset.hmi }); });
$('#touchroute').onchange = (e) => send({ t: 'touch-routing', on: e.target.checked });
$('#fps').onchange = (e) => send({ t: 'fps', n: Number(e.target.value) });

function renderHmi() {
  $('#stack').textContent = S.stack.length ? S.stack.join(' › ') : S.closed ? '(left: the HMI\'s app picker)' : '(none open)';
  $('#soft').style.visibility = S.stack.length ? '' : 'hidden';       // the app's screen is gone: so is the HMI's image of it
  const screens = (S.spec && S.spec.screens) || [];
  $('#screens').replaceChildren(...(screens.length > 1 ? screens.map((s) => el('button', { textContent: 'Open ' + s.name, title: s.kind, on: { click: () => send({ t: 'hmi', a: 'open', screen: s.name }) } })) : []));
  // the shown screen's HMI buttons (the bar of a canvas screen, a menu's entries): pressed as the HMI would
  const top = topScreen();
  const btns = !top ? [] : top.kind === 'canvas' ? (top.buttons || []).map((b) => [b[0], b[1]]) : (top.items || []).filter((i) => i[0] === 'button').map((i) => [i[1], i[2]]);
  $('#hmibtns').replaceChildren(...btns.map(([id, label]) => el('button', { textContent: label || id, title: id, className: id === S.focus ? 'focus' : '', on: { click: () => send({ t: 'click', id }) } })));
}

/* ---------------- panel: settings, from the app's app.json ---------------- */
function buildSettings() {
  const f = $('#settings');
  f.replaceChildren();
  for (const s of S.spec.settings || []) {
    const id = 'set-' + s.key;
    let c;
    if (s.type === 'bool') c = el('input', { type: 'checkbox', id });
    else if (s.type === 'choice' || (s.type === 'number' && s.steps)) {
      const opts = s.type === 'choice' ? s.options : s.steps.map((v) => [v, v + (s.unit ? ' ' + s.unit : '')]);
      c = el('select', { id }, ...opts.map((o, i) => el('option', { value: String(i), textContent: o[1] })));
      c._vals = opts.map((o) => o[0]);
    } else c = el('input', { type: s.type === 'number' ? 'number' : 'text', id });
    c.dataset.key = s.key;
    c.onchange = () => {
      const v = c.type === 'checkbox' ? c.checked : c._vals ? c._vals[Number(c.value)] : s.type === 'number' ? Number(c.value) : c.value;
      send({ t: 'set', k: s.key, v });
    };
    f.append(el('div', { className: 'set-row' }, el('label', { htmlFor: id, textContent: s.label || s.key, title: s.key }), c));
  }
  syncSettings();
}
function syncSettings() {
  document.querySelectorAll('#settings [data-key]').forEach((c) => {
    if (c === document.activeElement && c.tagName !== 'SELECT') return;
    const v = S.values[c.dataset.key];
    if (c.type === 'checkbox') c.checked = !!v;
    else if (c._vals) { const i = c._vals.findIndex((x) => x === v || String(x) === String(v)); c.value = String(Math.max(0, i)); }
    else c.value = v == null ? '' : v;
  });
}

/* ---------------- panel: vehicle signals ---------------- */
const SIG = [
  ['rpm', 'Engine', 0, 9000, 50, 'rpm'], ['speed', 'Speed', 0, 320, 1, 'km/h'], ['coolant', 'Coolant', -20, 130, 1, '°C'], ['oil', 'Oil', -20, 150, 1, '°C'],
  ['torque', 'Torque', 0, 900, 5, 'Nm'], ['gLong', 'g long', -1.5, 1.5, 0.01, 'g'], ['gLat', 'g lat', -1.5, 1.5, 0.01, 'g'],
];
const GEARS = ['P', 'R', 'N', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'];
const sig = { mode: 'demo', v: { rpm: 900, speed: 0, coolant: 90, oil: 95, gear: 'P', gLong: 0, gLat: 0, torque: 40 } };
function buildSignals() {
  const box = $('#sliders');
  SIG.forEach(([k, label, min, max, step, unit]) => {
    const out = el('span');
    const r = el('input', { type: 'range', min, max, step, value: sig.v[k], id: 'sig-' + k, 'aria-label': label });
    const show = () => { out.textContent = (+r.value).toFixed(step < 1 ? 2 : 0) + ' ' + unit; };
    r.oninput = () => { sig.v[k] = Number(r.value); show(); manual(); };
    r._show = show; show();
    box.append(el('div', { className: 'slider' }, el('label', { htmlFor: 'sig-' + k, textContent: label }), r, out));
  });
  const g = el('select', { id: 'sig-gear' }, ...GEARS.map((x) => el('option', { value: x, textContent: x })));
  g.value = sig.v.gear;
  g.onchange = () => { sig.v.gear = g.value; manual(); };
  box.append(el('div', { className: 'slider' }, el('label', { htmlFor: 'sig-gear', textContent: 'Gear' }), g, el('span')));
  document.querySelectorAll('input[name=sigmode]').forEach((r) => { r.onchange = () => { sig.mode = r.value; send({ t: 'sig', mode: sig.mode, v: sig.v }); syncSignals(); }; });
}
let sigT = 0, sigTimer = null;
function manual() {
  // moving a slider is Manual mode; at most 30 updates a second
  if (sig.mode !== 'manual') { sig.mode = 'manual'; syncSignals(); }
  const go = () => { sigTimer = null; sigT = performance.now(); send({ t: 'sig', mode: 'manual', v: sig.v }); };
  if (!sigTimer) sigTimer = setTimeout(go, Math.max(0, sigT + 33 - performance.now()));
}
function syncSignals() {
  if (S.sig) { Object.assign(sig.v, S.sig.v); sig.mode = S.sig.mode; S.sig = null; SIG.forEach(([k]) => { const r = $('#sig-' + k); r.value = sig.v[k]; r._show(); }); $('#sig-gear').value = sig.v.gear; }
  document.querySelectorAll('input[name=sigmode]').forEach((r) => { r.checked = r.value === sig.mode; });
  $('#sliders').classList.toggle('off', sig.mode !== 'manual');
}

/* ---------------- log ---------------- */
function addLog(lines) {
  const box = $('#log'), stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
  for (const [l, s] of lines) box.append(el('div', { className: l, textContent: s }));
  while (box.childElementCount > 600) box.firstChild.remove();
  if (stick) box.scrollTop = box.scrollHeight;
}
$('#clearlog').onclick = () => $('#log').replaceChildren();

/* ---------------- the HMI's app picker ("Installed Apps") ----------------
 * Shown while the user has left the app (BACK on its last screen, HOME): the server's {t:'screens', closed}. The app
 * is then hidden as on the car (no SHOW, no ticks); the knob, push and press move the focus here. The current app's
 * tile opens it again ({t:'hmi', a:'open'}), another app's tile starts that one ({t:'app'}: it opens once started).
 * Sizes in the screen's 1920 x 720 px (emu.css .pk-*). */
// the order of the tiles on the car (the user's photo of it); apps not listed follow by name
const ORDER = ['brake_test', 'warmup', 'service', 'redline', 'gforce', 'edrive', 'dyno', 'dtc_scanner', 'draggy', 'doom', 'car_vitals'];
const PK = { cols: 5, row: 236, padTop: 18, padBottom: 30, view: 640, track: 590 };   // (emu.css: grid rows, padding, .pk-body / .pk-bar height)
const P = { tiles: [], focus: 0, scroll: 0, busy: null, shown: false };
function buildPicker(apps, titles) {
  const ids = ORDER.filter((k) => apps.includes(k)).concat(apps.filter((a) => !ORDER.includes(a)));
  P.tiles = ids.map((id) => ({ id, title: titles[id] || id }));
  $('.pk-grid').replaceChildren(...P.tiles.map((t, i) => {
    const icon = el('img', { src: '/icon/' + encodeURIComponent(t.id) + '.png', alt: '', draggable: false });
    t.el = el('div', { className: 'pk-tile', role: 'option', 'aria-label': t.title, 'data-i': i }, icon, el('span', { textContent: t.title }));
    return t.el;
  }));
  picker();
}
/** show or hide the picker for S.closed; on showing, the focus goes to the current app's tile */
function picker() {
  const on = S.closed && P.tiles.length > 0;
  if (on && !P.shown) { const i = P.tiles.findIndex((t) => t.id === S.app); pickFocus(i < 0 ? 0 : i); }
  P.shown = on;
  $('#picker').hidden = !on;
  stage.classList.toggle('pk', on);              // (the HMI's chrome: the picker's look, or a running app's)
  P.tiles.forEach((t) => t.el.classList.toggle('busy', t.id === P.busy));
  overlay();
}
const pkRows = () => Math.ceil(P.tiles.length / PK.cols);
const pkMax = () => Math.max(0, PK.padTop + pkRows() * PK.row + PK.padBottom - PK.view);
function pickScroll(y) {
  P.scroll = Math.max(0, Math.min(pkMax(), y));
  $('.pk-grid').style.transform = `translateY(calc(var(--u) * ${-P.scroll}))`;
  const content = PK.view + pkMax(), th = Math.max(40, PK.track * PK.view / content), tb = $('.pk-thumb');
  tb.style.height = `calc(var(--u) * ${th})`;
  tb.style.top = `calc(var(--u) * ${pkMax() ? (PK.track - th) * P.scroll / pkMax() : 0})`;
  $('.pk-bar').hidden = !pkMax();
}
function pickFocus(i) {
  P.focus = Math.max(0, Math.min(P.tiles.length - 1, i));
  P.tiles.forEach((t, k) => { t.el.classList.toggle('focus', k === P.focus); t.el.setAttribute('aria-selected', k === P.focus); });
  // the focused row whole in view
  const top = PK.padTop + Math.floor(P.focus / PK.cols) * PK.row;
  if (top < P.scroll + PK.padTop) pickScroll(top - PK.padTop);
  else if (top + PK.row > P.scroll + PK.view) pickScroll(top + PK.row - PK.view + PK.padBottom);
  else pickScroll(P.scroll);
}
const pickMove = (d) => pickFocus(P.focus + d);
function pickOpen(i) {
  const t = P.tiles[i];
  if (!t) return;
  pickFocus(i);
  if (t.id === P.busy) return;                    // (starting already)
  // the running app's tile opens it again; while another one starts, the running app's tile switches back to it
  if (t.id === S.app && !P.busy) { send({ t: 'hmi', a: 'open' }); return; }
  P.busy = t.id; picker();
  toast(null);
  send({ t: 'app', id: t.id });
}
// touch: a tap opens, a drag scrolls (in screen px: the stage's CSS size maps back to 1920 wide)
{
  const body = $('.pk-body');
  let d = null;
  body.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    try { body.setPointerCapture(e.pointerId); } catch (x) { /* gone */ }
    stage.focus({ preventScroll: true });           // (the keys drive the picker from here on)
    const tile = e.target.closest('.pk-tile');
    d = { id: e.pointerId, y: e.clientY, s: P.scroll, k: W / stage.getBoundingClientRect().width, i: tile ? Number(tile.dataset.i) : -1, drag: false };
  });
  body.addEventListener('pointermove', (e) => {
    if (!d || d.id !== e.pointerId) return;
    const dy = (e.clientY - d.y) * d.k;
    if (!d.drag && Math.abs(dy) > 14) d.drag = true;
    if (d.drag) pickScroll(d.s - dy);
  });
  const end = (e) => { if (!d || d.id !== e.pointerId) return; const x = d; d = null; if (e.type === 'pointerup' && !x.drag && x.i >= 0) pickOpen(x.i); };
  body.addEventListener('pointerup', end);
  body.addEventListener('pointercancel', end);
}

/* ---------------- layout: where the panel docks, the screen as large as fits, aspect kept ---------------- */
const DOCKS = ['left', 'bottom', 'right'];
const store = {        // per browser; storage may throw (private mode, blocked) or be empty: the page works without it
  get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* not kept */ } },
};
let dockPref = (() => {
  let q = null;
  try { q = new URLSearchParams(location.search).get('panel'); } catch (e) { /* no query */ }
  const saved = store.get('mgu-emu-panel');
  return DOCKS.includes(q) ? q : DOCKS.includes(saved) ? saved : 'right';
})();
const panelW = (vw) => Math.min(380, Math.max(280, vw * 0.24));        // emu.css --panel-w
/**
 * A side panel only where the screen keeps at least 60% of the window's width: windows from 900 px wide, or short
 * landscape ones from 640 px (a phone held sideways, where a bottom panel would leave the screen no height).
 * Elsewhere the panel goes to the bottom; the choice is kept for a wider window.
 */
const sideFits = (vw, vh) => (vw >= 900 || (vh < 500 && vw >= 640 && vw > vh)) && vw - panelW(vw) - 32 >= 0.6 * vw;
// bottom: the panel keeps 38% of the height (180..380 px); the screen and its legend get the rest. Short windows
// (under 500 px: a phone held sideways) keep 30% (at least 120 px) for it, and under 420 px the legend goes
const bottomPanelH = (vh) => (vh < 500 ? Math.max(120, vh * 0.3) : Math.min(380, Math.max(180, vh * 0.38)));
function dock() {
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  const side = sideFits(vw, vh), d = side || dockPref === 'bottom' ? dockPref : 'bottom';
  if (document.body.dataset.dock !== d) document.body.dataset.dock = d;
  document.body.classList.toggle('short', vh < 420);
  document.querySelectorAll('input[name=dock]').forEach((r) => { r.checked = r.value === d; r.disabled = !side && r.value !== 'bottom'; });
  $('#dock-hint').hidden = side || dockPref === 'bottom';
  return d;
}
document.querySelectorAll('input[name=dock]').forEach((r) => {
  // (click, not change: the Bottom already checked by the fallback is saved as the choice when clicked; arrow keys click too)
  r.onclick = () => { if (!r.checked) return; dockPref = r.value; store.set('mgu-emu-panel', dockPref); layout(); };
});
function layout() {
  const d = dock();
  const m = $('#main'), cs = getComputedStyle(m), px = (k) => parseFloat(cs[k]) || 0;
  const lg = $('#legend'), leg = lg.offsetParent ? lg.offsetHeight + px('rowGap') : 0;
  const aw = m.getBoundingClientRect().width - px('paddingLeft') - px('paddingRight');
  const ah = (d === 'bottom' ? document.body.clientHeight - bottomPanelH(document.body.clientHeight) : m.clientHeight) - px('paddingTop') - px('paddingBottom') - leg;
  const w = Math.max(120, Math.floor(Math.min(aw, ah * W / H)));
  if (stage.style.width !== w + 'px') stage.style.width = w + 'px';
  spreadLog(d);
}
// bottom: the log (the last section) takes the rest of its row, so it spreads over the columns the others leave free
function spreadLog(d) {
  const p = $('#panel'), log = $('#log').closest('section');
  let span = '';
  if (d === 'bottom') {
    const n = getComputedStyle(p).gridTemplateColumns.split(' ').length;
    const before = [...p.children].filter((e) => e.tagName === 'SECTION' && e !== log && !e.hidden).length;
    if (n - before % n > 1) span = 'span ' + (n - before % n);
  }
  if (log.style.gridColumn !== span) log.style.gridColumn = span;
}
// (the canvas keeps its 1920 x 720 pixels; pointer positions are mapped from the stage's box, whatever its size)
const ro = new ResizeObserver(() => layout());
ro.observe($('#main')); ro.observe($('#panel'));
window.addEventListener('resize', layout);
const clock = () => { $('#hmi-clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); };   // (24 h, as the car)
setInterval(clock, 10000); clock();

buildSignals();
layout();
connect();
requestAnimationFrame(raf);
stage.focus();
