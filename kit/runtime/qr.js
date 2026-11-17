'use strict';
/**
 * qr.js - a small QR code encoder (byte mode, error correction L or M, versions 1-40), for codes the kit draws
 * on screen (the QR log). Follows ISO/IEC 18004; written for the kit, no dependencies.
 *
 *   const q = encode(bytes, { version: 15, ecl: 'L' })   bytes: Buffer / array of 0-255
 *   q.size                                               modules a side (17 + 4 x version), no quiet zone
 *   q.get(x, y)                                          true = dark
 *   capacity(version, ecl)                               how many bytes fit in one code of that version
 */

// error correction codewords per block, and blocks, by level and version (index 0 unused)
const ECC = {
    L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
};
const BLOCKS = {
    L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
};
const FORMAT_BITS = { L: 1, M: 0 };

/** Modules that carry data (and error correction) in a code of this version. */
function rawModules(ver) {
    let n = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
        const a = Math.floor(ver / 7) + 2;
        n -= (25 * a - 10) * a - 55;
        if (ver >= 7) n -= 36;
    }
    return n;
}
const dataCodewords = (ver, ecl) => Math.floor(rawModules(ver) / 8) - ECC[ecl][ver] * BLOCKS[ecl][ver];
/** Bytes that fit in one code: the data codewords less the mode (4 bits) and count (8 or 16 bits). */
const capacity = (ver, ecl) => dataCodewords(ver, ecl) - (ver < 10 ? 2 : 3);

/* ---- Reed-Solomon over GF(256), polynomial 0x11D ---- */
function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11D);
        z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
}
function rsDivisor(degree) {
    const out = new Array(degree).fill(0);
    out[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < out.length; j++) {
            out[j] = gfMul(out[j], root);
            if (j + 1 < out.length) out[j] ^= out[j + 1];
        }
        root = gfMul(root, 0x02);
    }
    return out;
}
function rsRemainder(data, divisor) {
    const out = divisor.map(() => 0);
    for (const b of data) {
        const f = b ^ out.shift();
        out.push(0);
        divisor.forEach((c, i) => { out[i] ^= gfMul(c, f); });
    }
    return out;
}

/** The data codewords with error correction added and the blocks interleaved. */
function addEcc(data, ver, ecl) {
    const nb = BLOCKS[ecl][ver], ecLen = ECC[ecl][ver], raw = Math.floor(rawModules(ver) / 8);
    const shortCount = nb - raw % nb, shortLen = Math.floor(raw / nb);
    const div = rsDivisor(ecLen), blocks = [];
    for (let i = 0, k = 0; i < nb; i++) {
        const dat = data.slice(k, k + shortLen - ecLen + (i < shortCount ? 0 : 1));
        k += dat.length;
        const ecc = rsRemainder(dat, div);
        if (i < shortCount) dat.push(0);                  // a placeholder, left out below
        blocks.push(dat.concat(ecc));
    }
    const out = [];
    for (let i = 0; i < blocks[0].length; i++) {
        blocks.forEach((b, j) => { if (i !== shortLen - ecLen || j >= shortCount) out.push(b[i]); });
    }
    return out;
}

/* ---- the module matrix ---- */
class Matrix {
    constructor(ver) {
        this.ver = ver; this.size = ver * 4 + 17;
        this.m = []; this.fn = [];
        for (let i = 0; i < this.size; i++) { this.m.push(new Array(this.size).fill(false)); this.fn.push(new Array(this.size).fill(false)); }
    }
    set(x, y, dark) { this.m[y][x] = dark; this.fn[y][x] = true; }
    get(x, y) { return this.m[y][x]; }

    functionPatterns() {
        const n = this.size;
        for (let i = 0; i < n; i++) { this.set(6, i, i % 2 === 0); this.set(i, 6, i % 2 === 0); }
        this.finder(3, 3); this.finder(n - 4, 3); this.finder(3, n - 4);
        const pos = this.alignPositions(), k = pos.length;
        for (let i = 0; i < k; i++) {
            for (let j = 0; j < k; j++) {
                if ((i === 0 && j === 0) || (i === 0 && j === k - 1) || (i === k - 1 && j === 0)) continue;
                this.align(pos[i], pos[j]);
            }
        }
        this.format('L', 0);                               // reserves the format areas; drawn again with the mask
        this.version();
    }
    finder(cx, cy) {
        for (let dy = -4; dy <= 4; dy++) {
            for (let dx = -4; dx <= 4; dx++) {
                const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
                if (x >= 0 && x < this.size && y >= 0 && y < this.size) this.set(x, y, d !== 2 && d !== 4);
            }
        }
    }
    align(cx, cy) {
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    alignPositions() {
        if (this.ver === 1) return [];
        const k = Math.floor(this.ver / 7) + 2;
        const step = this.ver === 32 ? 26 : Math.ceil((this.ver * 4 + 4) / (k * 2 - 2)) * 2;
        const out = [6];
        for (let p = this.size - 7; out.length < k; p -= step) out.splice(1, 0, p);
        return out;
    }
    format(ecl, mask) {
        const data = (FORMAT_BITS[ecl] << 3) | mask;
        let rem = data;
        for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
        const bits = ((data << 10) | rem) ^ 0x5412, bit = (i) => ((bits >>> i) & 1) !== 0, n = this.size;
        for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
        this.set(8, 7, bit(6)); this.set(8, 8, bit(7)); this.set(7, 8, bit(8));
        for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
        for (let i = 0; i < 8; i++) this.set(n - 1 - i, 8, bit(i));
        for (let i = 8; i < 15; i++) this.set(8, n - 15 + i, bit(i));
        this.set(8, n - 8, true);                          // the dark module
    }
    version() {
        if (this.ver < 7) return;
        let rem = this.ver;
        for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
        const bits = (this.ver << 12) | rem;
        for (let i = 0; i < 18; i++) {
            const dark = ((bits >>> i) & 1) !== 0, a = this.size - 11 + i % 3, b = Math.floor(i / 3);
            this.set(a, b, dark); this.set(b, a, dark);
        }
    }
    codewords(data) {
        let i = 0;
        const n = this.size;
        for (let right = n - 1; right >= 1; right -= 2) {
            if (right === 6) right = 5;
            for (let v = 0; v < n; v++) {
                for (let j = 0; j < 2; j++) {
                    const x = right - j, up = ((right + 1) & 2) === 0, y = up ? n - 1 - v : v;
                    if (!this.fn[y][x] && i < data.length * 8) {
                        this.m[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
                        i++;
                    }
                }
            }
        }
    }
    applyMask(mask) {
        const n = this.size;
        for (let y = 0; y < n; y++) {
            for (let x = 0; x < n; x++) {
                if (this.fn[y][x]) continue;
                let inv;
                switch (mask) {
                    case 0: inv = (x + y) % 2 === 0; break;
                    case 1: inv = y % 2 === 0; break;
                    case 2: inv = x % 3 === 0; break;
                    case 3: inv = (x + y) % 3 === 0; break;
                    case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
                    case 5: inv = (x * y) % 2 + (x * y) % 3 === 0; break;
                    case 6: inv = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
                    default: inv = ((x + y) % 2 + (x * y) % 3) % 2 === 0;
                }
                if (inv) this.m[y][x] = !this.m[y][x];
            }
        }
    }
    /** The standard's penalty score (lower = easier to read): runs, 2x2 blocks, finder look-alikes, dark balance. */
    penalty() {
        const n = this.size, m = this.m;
        let score = 0, dark = 0;
        const lineScore = (get) => {
            let s = 0, run = 1;
            for (let i = 1; i <= n; i++) {
                if (i < n && get(i) === get(i - 1)) { run++; continue; }
                if (run >= 5) s += run - 2;
                run = 1;
            }
            // 1:1:3:1:1 with four light modules on a side
            for (let i = 0; i + 10 < n + 4; i++) {
                const p = (k) => (k < 0 || k >= n ? false : get(k));
                const core = p(i) && !p(i + 1) && p(i + 2) && p(i + 3) && p(i + 4) && !p(i + 5) && p(i + 6);
                if (!core) continue;
                if (!p(i - 1) && !p(i - 2) && !p(i - 3) && !p(i - 4)) s += 40;
                else if (!p(i + 7) && !p(i + 8) && !p(i + 9) && !p(i + 10)) s += 40;
            }
            return s;
        };
        for (let y = 0; y < n; y++) score += lineScore((x) => m[y][x]);
        for (let x = 0; x < n; x++) score += lineScore((y) => m[y][x]);
        for (let y = 0; y + 1 < n; y++) {
            for (let x = 0; x + 1 < n; x++) {
                const c = m[y][x];
                if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
            }
        }
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) dark++;
        const total = n * n, k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
        return score + Math.max(0, k) * 10;
    }
}

/** The data bits: byte mode, the count, the bytes, the terminator and the padding, as codewords. */
function dataBits(bytes, ver, ecl) {
    const bits = [], put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
    put(4, 4);
    put(bytes.length, ver < 10 ? 8 : 16);
    for (const b of bytes) put(b, 8);
    const cap = dataCodewords(ver, ecl) * 8;
    put(0, Math.min(4, cap - bits.length));
    put(0, (8 - bits.length % 8) % 8);
    for (let pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) put(pad, 8);
    const out = [];
    for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    return out;
}

/**
 * A QR code of bytes. opts.version: that version (an error if the bytes don't fit), else the smallest that fits;
 * opts.ecl: 'L' (default, 7 % may be lost) or 'M' (15 %).
 */
function encode(bytes, opts) {
    const o = opts || {}, ecl = o.ecl === 'M' ? 'M' : 'L';
    const data = Array.prototype.slice.call(bytes || []);
    let ver = o.version;
    if (!ver) { ver = 1; while (ver < 40 && capacity(ver, ecl) < data.length) ver++; }
    if (ver < 1 || ver > 40 || capacity(ver, ecl) < data.length) throw new Error('QR: ' + data.length + ' bytes do not fit in version ' + ver);
    const words = addEcc(dataBits(data, ver, ecl), ver, ecl);
    const mx = new Matrix(ver);
    mx.functionPatterns();
    mx.codewords(words);
    let best = -1, bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
        mx.applyMask(mask); mx.format(ecl, mask);
        const s = mx.penalty();
        if (s < bestScore) { best = mask; bestScore = s; }
        mx.applyMask(mask);                                // undo (XOR)
    }
    mx.applyMask(best); mx.format(ecl, best);
    return { version: ver, ecl, size: mx.size, get: (x, y) => mx.get(x, y), mask: best };
}

module.exports = { encode, capacity };
