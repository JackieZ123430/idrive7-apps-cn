'use strict';
/**
 * renderd.js - connection from an app to mgu-renderd (kit/renderd), the GPU renderer.
 *
 *   const gpu = new RenderClient('car_vitals', log);
 *   gpu.on('ready', () => gpu.place({ x, y, w, h, scale, ox, oy }));
 *   gpu.on('tick', () => { ...record a frame...; gpu.frame(recorder); });
 *   gpu.show(true);
 *
 * Fonts, colour ramps and cached layers a frame uses are uploaded once per connection
 * (again after a reconnect or a resize). With `file` instead of a socket path the messages
 * are written to that file (for `mgu-renderd --replay`).
 */
const net = require('net');
const fs = require('fs');
const EventEmitter = require('events');
const rec = require('./record');

const SOCKET = process.env.MGU_RENDERD_SOCKET || '/run/mgu-renderd/renderd.sock';
const M = { HELLO: 1, PLACE: 2, SHOW: 3, ATLAS: 4, RAMP: 5, LAYER: 6, FRAME: 7, DROP_LAYER: 8, IMAGE: 9, GRAB: 10 };
const E = { READY: 101, TICK: 102, ERROR: 103, STATS: 104, CCU: 105 };

function msg(type, payload) {
    const len = payload ? payload.length : 0;
    const b = Buffer.allocUnsafe(8 + len + ((4 - (len & 3)) & 3));
    b.writeUInt32LE(type, 0); b.writeUInt32LE(b.length - 8, 4);
    if (len) payload.copy(b, 8);
    if (b.length > 8 + len) b.fill(0, 8 + len);
    return b;
}
function words(u32) { return Buffer.from(u32.buffer, u32.byteOffset, u32.byteLength); }

class RenderClient extends EventEmitter {
    constructor(appId, log, opts) {
        super();
        this.appId = appId;
        this.log = log || console;
        this.opts = opts || {};
        this.sock = null;
        this.connected = false;
        this.ready = false;
        this.screen = { w: 1920, h: 720 };
        this.placement = null;
        this.visible = false;
        this.inbuf = Buffer.alloc(0);
        this.sent = { atlas: new Set(), ramp: new Set(), layer: new Set(), image: new Map() };
        this.stats = null;
        this.waiting = false;        // a frame was sent, no tick back yet
        this.retry = null;
        this.closed = false;
        this.fd = null;              // file sink
    }

    /** Socket exists (the renderer is installed and running)? */
    static available(path) { try { return fs.statSync(path || SOCKET).isSocket(); } catch (e) { return false; } }

    connect() {
        if (this.opts.file) {
            this.fd = fs.openSync(this.opts.file, 'w');
            this.connected = this.ready = true;
            this._write(msg(M.HELLO, Buffer.from(this.appId)));
            setImmediate(() => this.emit('ready', this.screen));
            return this;
        }
        const path = this.opts.socket || SOCKET;
        const s = net.createConnection(path);
        this.sock = s;
        s.on('connect', () => {
            this.connected = true;
            this._reset();
            s.setNoDelay && s.setNoDelay(true);
            this._write(msg(M.HELLO, Buffer.from(this.appId)));
            if (this.placement) this._sendPlace();
            if (this.visible) this._write(this._u32msg(M.SHOW, [1]));
            if (this.grabbing) this._write(this._u32msg(M.GRAB, [1]));
        });
        s.on('data', (d) => this._data(d));
        s.on('error', (e) => { if (!this.errLogged) { this.errLogged = true; this.log.warn('renderd: ' + e.message); } });
        s.on('close', () => {
            const was = this.ready;
            this.connected = this.ready = false; this.sock = null; this.waiting = false;
            if (was) { this.log.warn('renderd: connection closed'); this.emit('close'); }
            if (!this.closed) this.retry = setTimeout(() => { this.retry = null; this.connect(); }, 3000);
        });
        return this;
    }
    /**
     * Have the iDrive controller to ourselves (the HMI ignores the knob, press and tilt while it
     * holds; BACK / MENU and the touchscreen still work). Needs mgu-inputgate.so in the HMI.
     * Holds while we are shown and repeated here every 0.5 s; released at once with grab(false).
     */
    grab(on) {
        on = !!on;
        if (on === !!this.grabbing) return;
        this.grabbing = on;
        if (this.grabTimer) { clearInterval(this.grabTimer); this.grabTimer = null; }
        if (on) this.grabTimer = setInterval(() => { if (this.connected) this._write(this._u32msg(M.GRAB, [1])); }, 500);
        if (this.connected) this._write(this._u32msg(M.GRAB, [on ? 1 : 0]));
    }
    close() {
        this.grab(false);
        this.closed = true;
        if (this.retry) clearTimeout(this.retry);
        if (this.sock) this.sock.destroy();
        if (this.fd !== null) { fs.closeSync(this.fd); this.fd = null; }
    }
    _reset() { this.sent.atlas.clear(); this.sent.ramp.clear(); this.sent.layer.clear(); this.sent.image.clear(); this.waiting = false; }
    _write(b) {
        if (this.fd !== null) { fs.writeSync(this.fd, b); return true; }
        return this.sock && this.connected ? this.sock.write(b) : false;
    }
    _u32msg(type, arr) { const u = new Uint32Array(arr); return msg(type, words(u)); }

    _data(d) {
        this.inbuf = this.inbuf.length ? Buffer.concat([this.inbuf, d]) : d;
        while (this.inbuf.length >= 8) {
            const type = this.inbuf.readUInt32LE(0), len = this.inbuf.readUInt32LE(4);
            if (this.inbuf.length < 8 + len) break;
            const p = this.inbuf.slice(8, 8 + len);
            this.inbuf = this.inbuf.slice(8 + len);
            if (type === E.READY) {
                this.ready = true; this.errLogged = false;
                this.screen = { w: p.readUInt32LE(4), h: p.readUInt32LE(8) };
                this.log.info('renderd: connected, screen ' + this.screen.w + 'x' + this.screen.h);
                this.emit('ready', this.screen);
            } else if (type === E.TICK) {
                this.waiting = false;
                this.emit('tick', p.readUInt32LE(0), p.readUInt32LE(4));
            } else if (type === E.CCU && p.length >= 5) {
                // the controller event the HMI didn't get (we hold the grab): FrontCCU names
                this.emit('ccu', {
                    frontSequenceNumberOperatingElement: p[0], frontRotaryEncoderOperation: p.readUInt16BE(1),
                    frontRotaryEncoderPushButton: p[3], frontRotaryEncoderDeflection: p[4],
                });
            } else if (type === E.STATS) {
                this.stats = { fps: p.readUInt32LE(0), avgUs: p.readUInt32LE(4), maxUs: p.readUInt32LE(8) };
                this.emit('stats', this.stats);
            } else if (type === E.ERROR) {
                this.log.warn('renderd error: ' + p.toString());
            }
        }
    }

    /**
     * Where the surface goes: x, y, w, h in screen pixels; logical content is drawn at
     * device = logical * scale + (ox, oy) inside it.
     */
    place(pl) {
        const resize = !this.placement || pl.w !== this.placement.w || pl.h !== this.placement.h;
        if (this.placement && !resize && ['x', 'y', 'scale', 'ox', 'oy'].every((k) => pl[k] === this.placement[k])) return;
        const scaleChanged = this.placement && this.placement.scale !== pl.scale;
        this.placement = Object.assign({}, pl);
        if (resize || scaleChanged) this._reset();     // the renderer dropped our resources
        if (this.ready) this._sendPlace();
    }
    _sendPlace() {
        const p = this.placement, b = Buffer.alloc(28);
        b.writeInt32LE(p.x | 0, 0); b.writeInt32LE(p.y | 0, 4); b.writeInt32LE(p.w | 0, 8); b.writeInt32LE(p.h | 0, 12);
        b.writeFloatLE(p.scale, 16); b.writeFloatLE(p.ox || 0, 20); b.writeFloatLE(p.oy || 0, 24);
        this._write(msg(M.PLACE, b));
    }
    show(on) {
        on = !!on;
        if (on === this.visible) return;
        this.visible = on;
        if (this.ready) this._write(this._u32msg(M.SHOW, [on ? 1 : 0]));
    }

    _ensureAtlas(id) {
        if (this.sent.atlas.has(id)) return;
        const f = rec.atlasById(id);
        if (!f) return;
        const head = Buffer.alloc(12);
        head.writeUInt32LE(id, 0); head.writeUInt32LE(f.atlasW, 4); head.writeUInt32LE(f.atlasH, 8);
        this._write(msg(M.ATLAS, Buffer.concat([head, f.alpha])));
        this.sent.atlas.add(id);
    }
    _ensureRamp(id) {
        if (this.sent.ramp.has(id)) return;
        const stops = rec.rampList[id];
        if (!stops) return;
        const u = new Uint32Array(2 + stops.length);
        u[0] = id; u[1] = stops.length;
        stops.forEach((c, i) => { u[2 + i] = rec.pack(c); });
        this._write(msg(M.RAMP, words(u)));
        this.sent.ramp.add(id);
    }
    _ensureRes(r) {
        if (r.atlases) r.atlases.forEach((id) => this._ensureAtlas(id));
        if (r.ramps) r.ramps.forEach((id) => this._ensureRamp(id));
        if (r.layersUsed || r.sublayers) (r.layersUsed || r.sublayers).forEach((id) => this._ensureLayer(id));
        if (r.images) r.images.forEach((id) => this._ensureImage(id));
    }
    /** upload a pixel image when this connection hasn't got its current version */
    _ensureImage(id) {
        const im = rec.imageById.get(id);
        if (!im || !im.data) return;
        if (this.sent.image.get(id) === im.ver) return;
        const head = Buffer.alloc(12);
        head.writeUInt32LE(id, 0); head.writeUInt32LE(im.w, 4); head.writeUInt32LE(im.h, 8);
        const px = Buffer.from(im.data.buffer, im.data.byteOffset, im.w * im.h * 4);
        this._write(msg(M.IMAGE, Buffer.concat([head, px])));
        this.sent.image.set(id, im.ver);
    }
    _ensureLayer(id) {
        if (this.sent.layer.has(id)) return;
        const L = rec.layerById.get(id);
        if (!L) return;
        this._ensureRes(L);
        const head = Buffer.alloc(12);
        head.writeUInt32LE(id, 0); head.writeFloatLE(L.w, 4); head.writeFloatLE(L.h, 8);
        this._write(msg(M.LAYER, Buffer.concat([head, words(L.words)])));
        this.sent.layer.add(id);
    }
    dropLayer(id) {
        if (this.sent.layer.delete(id) && this.ready) this._write(this._u32msg(M.DROP_LAYER, [id]));
    }

    /** Send a recorded frame (record.js Recorder). Returns false if not connected. */
    frame(r) {
        if (!this.ready || !this.placement) return false;
        this._ensureRes(r);
        this.waiting = true;
        return this._write(msg(M.FRAME, words(r.words())));
    }
}

module.exports = { RenderClient, SOCKET };
