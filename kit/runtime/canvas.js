'use strict';
/**
 * canvas.js - tiny anti-aliased RGBA canvas that encodes to PNG.
 *
 * Pure JavaScript (node 8 on the head unit has no native canvas). Apps draw
 * their gauges into a Canvas, write the PNG into rhmiData/ and hand the file
 * to the HMI (see mgu.js Screen.setImage). Coordinates are pixels, angles are
 * degrees clockwise from 12 o'clock (gauge convention).
 */
const zlib = require('zlib');
const fonts = require('./fonts');

/* ---------- colours ---------- */
const cache = Object.create(null);
function rgba(c) {
    if (Array.isArray(c)) return c.length === 4 ? c : [c[0], c[1], c[2], 255];
    if (cache[c]) return cache[c];
    let s = String(c).replace('#', '');
    if (s.length === 3) s = s.split('').map((x) => x + x).join('');
    const v = [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16),
        s.length >= 8 ? parseInt(s.slice(6, 8), 16) : 255];
    cache[c] = v;
    return v;
}
function mix(a, b, t) {
    a = rgba(a); b = rgba(b);
    return [0, 1, 2, 3].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
}
function withAlpha(c, a) { const v = rgba(c); return [v[0], v[1], v[2], Math.round(a * 255)]; }

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Colour at position f (0..1) of a ramp [c0, c1, ...] (evenly spaced stops). */
function ramp(stops, f) {
    if (stops.length === 1) return rgba(stops[0]);
    const x = clamp01(f) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x));
    return mix(stops[i], stops[i + 1], x - i);
}
const RAD = Math.PI / 180;

class Canvas {
    constructor(w, h) {
        this.w = w | 0; this.h = h | 0;
        this.d = new Uint8Array(this.w * this.h * 4);
    }

    clear(c) {
        const [r, g, b, a] = rgba(c || [0, 0, 0, 0]);
        const d = this.d;
        for (let i = 0; i < d.length; i += 4) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a; }
        return this;
    }

    /** src-over blend of colour c with coverage cov (0..1) at integer pixel. */
    _blend(x, y, c, cov) {
        if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
        const sa = (c[3] / 255) * cov;
        if (sa <= 0) return;
        const i = (y * this.w + x) * 4, d = this.d;
        const da = d[i + 3] / 255;
        const oa = sa + da * (1 - sa);
        if (oa <= 0) return;
        const k = da * (1 - sa);
        d[i] = (c[0] * sa + d[i] * k) / oa;
        d[i + 1] = (c[1] * sa + d[i + 1] * k) / oa;
        d[i + 2] = (c[2] * sa + d[i + 2] * k) / oa;
        d[i + 3] = oa * 255;
    }

    fillRect(x, y, w, h, c) {
        c = rgba(c);
        const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
        const x1 = Math.min(this.w, Math.ceil(x + w)), y1 = Math.min(this.h, Math.ceil(y + h));
        for (let py = y0; py < y1; py++) {
            const cy = clamp01(Math.min(py + 1, y + h) - Math.max(py, y));
            for (let px = x0; px < x1; px++) {
                const cx = clamp01(Math.min(px + 1, x + w) - Math.max(px, x));
                this._blend(px, py, c, cx * cy);
            }
        }
        return this;
    }

    /** Vertical gradient fill; stops = [[t, colour], ...] with t in 0..1. */
    gradientRect(x, y, w, h, stops) {
        const st = stops.map((s) => [s[0], rgba(s[1])]);
        for (let py = Math.max(0, y | 0); py < Math.min(this.h, y + h); py++) {
            const t = (py - y) / Math.max(1, h - 1);
            let k = 0;
            while (k < st.length - 2 && t > st[k + 1][0]) k++;
            const a = st[k], b = st[Math.min(k + 1, st.length - 1)];
            const tt = b[0] === a[0] ? 0 : clamp01((t - a[0]) / (b[0] - a[0]));
            this.fillRect(x, py, w, 1, mix(a[1], b[1], tt));
        }
        return this;
    }

    /** Anti-aliased rounded rectangle (fill). */
    roundRect(x, y, w, h, r, c) {
        c = rgba(c);
        r = Math.min(r, w / 2, h / 2);
        const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
        const x1 = Math.min(this.w, Math.ceil(x + w)), y1 = Math.min(this.h, Math.ceil(y + h));
        for (let py = y0; py < y1; py++) {
            for (let px = x0; px < x1; px++) {
                const cx = px + 0.5, cy = py + 0.5;
                const qx = Math.max(Math.abs(cx - (x + w / 2)) - (w / 2 - r), 0);
                const qy = Math.max(Math.abs(cy - (y + h / 2)) - (h / 2 - r), 0);
                const dist = Math.sqrt(qx * qx + qy * qy) - r;
                const cov = clamp01(0.5 - dist);
                if (cov > 0) this._blend(px, py, c, cov);
            }
        }
        return this;
    }

    /** Rounded-rectangle outline of the given stroke width. */
    strokeRoundRect(x, y, w, h, r, width, c) {
        c = rgba(c);
        r = Math.min(r, w / 2, h / 2);
        const x0 = Math.max(0, Math.floor(x - 1)), y0 = Math.max(0, Math.floor(y - 1));
        const x1 = Math.min(this.w, Math.ceil(x + w + 1)), y1 = Math.min(this.h, Math.ceil(y + h + 1));
        for (let py = y0; py < y1; py++) {
            for (let px = x0; px < x1; px++) {
                const cx = px + 0.5, cy = py + 0.5;
                const qx = Math.max(Math.abs(cx - (x + w / 2)) - (w / 2 - r), 0);
                const qy = Math.max(Math.abs(cy - (y + h / 2)) - (h / 2 - r), 0);
                const dist = Math.sqrt(qx * qx + qy * qy) - r;      // <0 inside
                const cov = clamp01(0.5 - dist) * clamp01(dist + width + 0.5);
                if (cov > 0) this._blend(px, py, c, cov);
            }
        }
        return this;
    }

    /**
     * Rounded card with a vertical gradient (stops as gradientRect). Only the
     * corner squares are shaded per pixel, so it costs about as much as a fillRect.
     */
    card(x, y, w, h, r, stops) {
        const st = stops.map((v) => [v[0], rgba(v[1])]);
        r = Math.min(r, w / 2, h / 2);
        const y0 = Math.max(0, Math.floor(y)), y1 = Math.min(this.h, Math.ceil(y + h));
        for (let py = y0; py < y1; py++) {
            const t = (py - y) / Math.max(1, h - 1);
            let k = 0;
            while (k < st.length - 2 && t > st[k + 1][0]) k++;
            const a = st[k], b = st[Math.min(k + 1, st.length - 1)];
            const c = mix(a[1], b[1], b[0] === a[0] ? 0 : clamp01((t - a[0]) / (b[0] - a[0])));
            const cy = py + 0.5;
            const inCorner = cy < y + r || cy > y + h - r;
            if (!inCorner) { this.fillRect(x, py, w, 1, c); continue; }
            const qy = Math.max(Math.abs(cy - (y + h / 2)) - (h / 2 - r), 0);
            const covY = clamp01(Math.min(py + 1, y + h) - Math.max(py, y));
            this.fillRect(x + r, py, w - 2 * r, covY, c);
            for (const [ex0, ex1] of [[x, x + r], [x + w - r, x + w]]) {
                for (let px = Math.max(0, Math.floor(ex0)); px < Math.min(this.w, Math.ceil(ex1)); px++) {
                    const qx = Math.max(Math.abs(px + 0.5 - (x + w / 2)) - (w / 2 - r), 0);
                    const cov = clamp01(0.5 - (Math.sqrt(qx * qx + qy * qy) - r)) * covY;
                    if (cov > 0) this._blend(px, py, rgba(c), cov);
                }
            }
        }
        return this;
    }

    /**
     * Rounded bar filled with a horizontal colour ramp. The ramp spans
     * spanX..spanX+spanW (default the bar itself), so a partly filled bar
     * keeps the colours of its position on the scale.
     */
    rampRect(x, y, w, h, r, stops, spanX, spanW) {
        if (w <= 0 || h <= 0) return this;
        r = Math.min(r, w / 2, h / 2);
        const sx = spanX == null ? x : spanX, sw = Math.max(1, spanW == null ? w : spanW);
        const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
        const x1 = Math.min(this.w, Math.ceil(x + w)), y1 = Math.min(this.h, Math.ceil(y + h));
        const col = [];
        for (let px = x0; px < x1; px++) col.push(ramp(stops, (px + 0.5 - sx) / sw));
        for (let py = y0; py < y1; py++) {
            for (let px = x0; px < x1; px++) {
                const qx = Math.max(Math.abs(px + 0.5 - (x + w / 2)) - (w / 2 - r), 0);
                const qy = Math.max(Math.abs(py + 0.5 - (y + h / 2)) - (h / 2 - r), 0);
                const cov = clamp01(0.5 - (Math.sqrt(qx * qx + qy * qy) - r));
                if (cov > 0) this._blend(px, py, col[px - x0], cov);
            }
        }
        return this;
    }

    /** Filled circle. */
    circle(cx, cy, r, c) { return this.arc(cx, cy, 0, r, 0, 360, c); }

    /**
     * Annulus sector (ring segment) from angle a0 to a1 (degrees, clockwise
     * from 12 o'clock), radii r0..r1. opts.round = round end caps.
     * opts.ramp = [c0, c1, ...] colours the ring by angle instead of c, spread
     * over opts.rampFrom..opts.rampTo (default a0..a1; rampTo < rampFrom runs it
     * anticlockwise), so a value arc keeps the
     * colour of its position on the scale.
     */
    arc(cx, cy, r0, r1, a0, a1, c, opts) {
        c = rgba(c);
        let lut = null, rf = 0, rs = 1;
        if (opts && opts.ramp) {
            rf = opts.rampFrom == null ? Math.min(a0, a1) : opts.rampFrom;
            rs = (opts.rampTo == null ? Math.max(a0, a1) : opts.rampTo) - rf;      // signed span
            if (Math.abs(rs) < 1e-6) rs = 1e-6;
            lut = [];
            for (let i = 0; i <= 64; i++) lut.push(ramp(opts.ramp, i / 64));
        }
        if (a1 < a0) { const t = a0; a0 = a1; a1 = t; }
        const full = a1 - a0 >= 360;
        const round = opts && opts.round && !full;
        const rm = (r0 + r1) / 2, hw = (r1 - r0) / 2;
        const capA = [a0 * RAD, a1 * RAD];
        const caps = round ? capA.map((a) => [cx + Math.sin(a) * rm, cy - Math.cos(a) * rm]) : null;
        const x0 = Math.max(0, Math.floor(cx - r1 - 1)), x1 = Math.min(this.w, Math.ceil(cx + r1 + 1));
        const y0 = Math.max(0, Math.floor(cy - r1 - 1)), y1 = Math.min(this.h, Math.ceil(cy + r1 + 1));
        const mid = ((a0 + a1) / 2) * RAD, half = ((a1 - a0) / 2) * RAD;
        for (let py = y0; py < y1; py++) {
            const dy = py + 0.5 - cy;
            for (let px = x0; px < x1; px++) {
                const dx = px + 0.5 - cx;
                const dd = Math.sqrt(dx * dx + dy * dy);
                if (dd > r1 + 1 || dd < r0 - 1) continue;
                let cov = clamp01(r1 - dd + 0.5) * (r0 > 0 ? clamp01(dd - r0 + 0.5) : 1);
                if (cov <= 0) continue;
                if (!full) {
                    // angle of the pixel, measured relative to the sector middle
                    let ang = Math.atan2(dx, -dy) - mid;
                    while (ang > Math.PI) ang -= 2 * Math.PI;
                    while (ang < -Math.PI) ang += 2 * Math.PI;
                    const outside = (Math.abs(ang) - half) * Math.max(dd, 1);   // px beyond the edge
                    let v = cov * clamp01(0.5 - outside);
                    if (round && v < 1) {
                        for (const p of caps) {
                            const ex = px + 0.5 - p[0], ey = py + 0.5 - p[1];
                            v = Math.max(v, clamp01(hw - Math.sqrt(ex * ex + ey * ey) + 0.5));
                        }
                    }
                    cov = v;
                }
                if (cov > 0) {
                    if (lut) {
                        // angle travelled from rampFrom in the ramp's direction (0..360)
                        const span = Math.abs(rs);
                        let da = (Math.atan2(dx, -dy) / RAD - rf) * (rs < 0 ? -1 : 1);
                        da = ((da % 360) + 360) % 360;
                        if (da > span + (360 - span) / 2) da -= 360;            // just before the start
                        c = lut[Math.round(clamp01(da / span) * 64)];
                    }
                    this._blend(px, py, c, cov);
                }
            }
        }
        return this;
    }

    /** Anti-aliased thick line with round caps. */
    line(xa, ya, xb, yb, width, c) {
        c = rgba(c);
        const hw = width / 2;
        const x0 = Math.max(0, Math.floor(Math.min(xa, xb) - hw - 1)), x1 = Math.min(this.w, Math.ceil(Math.max(xa, xb) + hw + 1));
        const y0 = Math.max(0, Math.floor(Math.min(ya, yb) - hw - 1)), y1 = Math.min(this.h, Math.ceil(Math.max(ya, yb) + hw + 1));
        const vx = xb - xa, vy = yb - ya, len2 = vx * vx + vy * vy || 1;
        for (let py = y0; py < y1; py++) {
            for (let px = x0; px < x1; px++) {
                const qx = px + 0.5 - xa, qy = py + 0.5 - ya;
                const t = clamp01((qx * vx + qy * vy) / len2);
                const ex = qx - vx * t, ey = qy - vy * t;
                const cov = clamp01(hw - Math.sqrt(ex * ex + ey * ey) + 0.5);
                if (cov > 0) this._blend(px, py, c, cov);
            }
        }
        return this;
    }

    /** Polyline (e.g. a history trace). pts = [[x,y],...] */
    polyline(pts, width, c) {
        for (let i = 1; i < pts.length; i++) this.line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], width, c);
        return this;
    }

    /** Fill the area under a trace down to baseline y (for sparkline glow). */
    fillUnder(pts, baseY, c) {
        c = rgba(c);
        for (let i = 1; i < pts.length; i++) {
            const [xa, ya] = pts[i - 1], [xb, yb] = pts[i];
            for (let px = Math.floor(xa); px < Math.ceil(xb); px++) {
                const t = xb === xa ? 0 : (px + 0.5 - xa) / (xb - xa);
                const top = ya + (yb - ya) * clamp01(t);
                this.fillRect(px, top, 1, baseY - top, c);
            }
        }
        return this;
    }

    /**
     * Text. font = family name baked by kit/tools/bake_fonts.py ('label', 'num').
     * align: 'left' | 'center' | 'right'; y is the BASELINE.
     * Returns the drawn width in px.
     */
    text(str, x, y, size, c, opts) {
        opts = opts || {};
        const f = fonts.get(opts.font || 'label', size);
        if (!f) return 0;
        c = rgba(c);
        const scale = size / f.size;
        const s = String(str);
        const w = fonts.measure(f, s) * scale + (opts.spacing || 0) * Math.max(0, s.length - 1);
        let pen = opts.align === 'center' ? x - w / 2 : opts.align === 'right' ? x - w : x;
        for (const ch of s) {
            const g = f.glyphs[ch.codePointAt(0)] || f.glyphs[63];
            if (!g) continue;
            const [gx, gy, gw, gh, ox, oy, adv] = g;
            if (gw && gh) this._blit(f, gx, gy, gw, gh, pen + ox * scale, y + oy * scale, scale, c);
            pen += adv * scale + (opts.spacing || 0);
        }
        return w;
    }

    textWidth(str, size, opts) {
        const f = fonts.get((opts && opts.font) || 'label', size);
        return f ? fonts.measure(f, String(str)) * (size / f.size) + ((opts && opts.spacing) || 0) * Math.max(0, String(str).length - 1) : 0;
    }

    /** Blit an alpha glyph from the atlas, scaled (bilinear) and tinted. */
    _blit(f, gx, gy, gw, gh, dx, dy, scale, c) {
        const A = f.alpha, AW = f.atlasW;
        const tw = gw * scale, th = gh * scale;
        const x0 = Math.floor(dx), y0 = Math.floor(dy);
        for (let py = Math.max(0, y0); py < Math.min(this.h, Math.ceil(dy + th)); py++) {
            const sy = (py + 0.5 - dy) / scale - 0.5;
            for (let px = Math.max(0, x0); px < Math.min(this.w, Math.ceil(dx + tw)); px++) {
                const sx = (px + 0.5 - dx) / scale - 0.5;
                const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
                const at = (xx, yy) => (xx < 0 || yy < 0 || xx >= gw || yy >= gh) ? 0 : A[(gy + yy) * AW + gx + xx];
                const v = scale === 1
                    ? at(Math.round(sx), Math.round(sy))
                    : at(ix, iy) * (1 - fx) * (1 - fy) + at(ix + 1, iy) * fx * (1 - fy) + at(ix, iy + 1) * (1 - fx) * fy + at(ix + 1, iy + 1) * fx * fy;
                if (v > 0) this._blend(px, py, c, v / 255);
            }
        }
    }

    /** Encode as PNG (RGBA, 8 bit). */
    png(level) {
        const w = this.w, h = this.h, d = this.d;
        const raw = Buffer.alloc((w * 4 + 1) * h);
        for (let y = 0; y < h; y++) {
            raw[y * (w * 4 + 1)] = 0;
            Buffer.from(d.buffer, d.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
        }
        const chunk = (type, body) => {
            const len = Buffer.alloc(4); len.writeUInt32BE(body.length, 0);
            const tb = Buffer.concat([Buffer.from(type, 'ascii'), body]);
            const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tb) >>> 0, 0);
            return Buffer.concat([len, tb, crc]);
        };
        const ihdr = Buffer.alloc(13);
        ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
        ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
        return Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            chunk('IHDR', ihdr),
            chunk('IDAT', zlib.deflateSync(raw, { level: level == null ? 4 : level })),
            chunk('IEND', Buffer.alloc(0)),
        ]);
    }
}

let CRC_T = null;
function crc32(buf) {
    if (!CRC_T) {
        CRC_T = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            CRC_T[n] = c;
        }
    }
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return c ^ -1;
}

module.exports = { Canvas, rgba, mix, ramp, withAlpha, RAD };
