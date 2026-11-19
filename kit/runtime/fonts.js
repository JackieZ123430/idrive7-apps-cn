'use strict';
/**
 * fonts.js - loads the pre-baked glyph atlases (kit/runtime/fonts/*.json,
 * made by kit/tools/bake_fonts.py) and picks the best size for a request.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DIR = path.join(__dirname, 'fonts');
const families = Object.create(null);

function family(name) {
    if (families[name] !== undefined) return families[name];
    let fam = null;
    try {
        const j = JSON.parse(fs.readFileSync(path.join(DIR, name + '.json'), 'utf8'));
        fam = j.sizes.map((s) => ({
            size: s.size, ascent: s.ascent, descent: s.descent, atlasW: s.atlasW, atlasH: s.atlasH,
            glyphs: s.glyphs, _alpha: s.alpha, alpha: null, family: name, cacheKey: j.cacheKey || '',
        }));
    } catch (e) { fam = null; }
    families[name] = fam;
    return fam;
}

/** Smallest baked size >= requested (downscaling looks better), else largest. */
function get(name, size, text) {
    // Shared supplemental atlases avoid duplicating glyphs in every numeric size.
    if (text && /[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7ff]/.test(text)) name = 'korean';
    else if (text && /[\u3000-\u9fff\uff00-\uffef]/.test(text)) name = 'cjk';
    else if (text && /[\u0400-\u04ff]/.test(text)) name = 'cyrillic';
    const fam = family(name) || family('label');
    if (!fam) return null;
    let best = null;
    for (const f of fam) if (f.size >= size && (!best || f.size < best.size)) best = f;
    if (!best) best = fam[fam.length - 1];
    if (!best.alpha) best.alpha = zlib.inflateSync(Buffer.from(best._alpha, 'base64'));
    return best;
}

/*
 * GPU pieces of a tall atlas. The renderer keeps every app's atlases in one shared texture of two
 * 1024 x 4096 columns, first come first served, until it restarts. The Korean atlas (1024 x 2976)
 * needs one stretch of 2976 rows; once the English atlases of the apps running before it (HUD,
 * cluster, numbers) took more than 1120 rows of each column, it no longer fitted and every app's
 * Hangul was blank ("glyph atlas texture full") while Latin text still showed. Pieces of at most
 * PIECE_H rows fit in the gaps. Each piece is its own atlas (its own id, the same for every app
 * with this font file); the software path and measuring keep the whole atlas.
 */
const PIECE_H = 512;

function pieces(f) {
    if (f._pieces !== undefined) return f._pieces;
    if (!(f.atlasH > PIECE_H)) return (f._pieces = null);
    if (!f.alpha) f.alpha = zlib.inflateSync(Buffer.from(f._alpha, 'base64'));
    const drawn = Object.keys(f.glyphs).filter((k) => f.glyphs[k][2] && f.glyphs[k][3])
        .sort((a, b) => f.glyphs[a][1] - f.glyphs[b][1]);
    const list = [], of = Object.create(null);
    let cur = null;
    for (const k of drawn) {
        const g = f.glyphs[k];
        if (!cur || g[1] + g[3] > cur.y0 + PIECE_H) { cur = { y0: g[1], y1: g[1] + g[3] }; list.push(cur); }
        if (g[1] + g[3] > cur.y1) cur.y1 = g[1] + g[3];
        of[k] = list.length - 1;
    }
    f._pieceOf = of;
    f._pieces = list.map((p, i) => ({
        size: f.size, ascent: f.ascent, descent: f.descent, atlasW: f.atlasW, atlasH: p.y1 - p.y0,
        glyphs: f.glyphs, alpha: f.alpha.subarray(p.y0 * f.atlasW, p.y1 * f.atlasW), family: f.family,
        // the index before other characters: atlasId() sets the lowest bit, so keys ending in .0 / .1 met
        cacheKey: (f.cacheKey || '') + '/piece' + i + 'of' + list.length + 'x' + PIECE_H, y0: p.y0,
    }));
    return f._pieces;
}

/** The piece of f's atlas with glyph cp (f itself when f is short enough); its rows start at .y0. */
function piece(f, cp) {
    const p = pieces(f);
    if (!p) return f;
    const i = f._pieceOf[cp];
    return i === undefined ? f : p[i];
}

/** Whether a family's atlas is there (get() falls back to 'label' for one that isn't). */
function has(name) { return !!family(name); }

function measure(f, s) {
    let w = 0;
    for (const ch of s) { const g = f.glyphs[ch.codePointAt(0)] || f.glyphs[63]; if (g) w += g[6]; }
    return w;
}

module.exports = { get, has, measure, piece, PIECE_H };
