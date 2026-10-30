/*
 * emu_gfx.c - mgu-renderd's GPU engine (kit/renderd/src/gfx.c, unchanged) in a browser, as WebAssembly on WebGL 2.
 *
 * One app (client) on a 1920 x 720 screen in layer mode, as the car shows it: the app's surface at its PLACE rect,
 * transparent around it, shown while SHOW is on and a frame is drawn. The bytes are the client's half of the socket
 * (PROTOCOL.md), whole or split anywhere; nothing goes back (READY, TICK, ERROR are the host's to fake). As on the
 * car, the newest FRAME is drawn once the bytes at hand are read (the daemon draws at the next vsync).
 *
 * handle() and the helpers it calls are src/main.c's (mgu-render by Robert Nisipeanu and IterioDev, from mgu-renderd,
 * idrive7-apps kit/renderd, MIT, Copyright (c) 2026 cauliflowermossgrape), without the compositor: no wayland, no
 * touch, controller, gate or video (their messages are checked as there and ignored), and embed mode is the HMI box
 * of the default config (embed_area) on the same screen.
 */
#include <GLES3/gl3.h>
#include <emscripten.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "dialect.h"
#include "gfx.h"
#include "proto.h"

#define MAX_MSG (24u << 20)
#define MAX_FEED (256u << 20)                              /* one emu_buf at most */
#define NERR 4
static const int embed_area[4] = { 104, 88, 1796, 632 };   /* config.c's default */

extern int emu_gl_context(void);                           /* emu_lib.js: WebGL 2 on Module.canvas, made current */
extern void emu_gl_destroy(void);                          /* emu_lib.js: the context lost and deleted */

typedef struct client {
    char app[64];
    int dialect, mode;
    gfx_client g;
    int placed, x, y, w, h;
    gfx_xf xf;
    int visible;
    uint32_t *frame; size_t frame_words, frame_cap;
    int dirty;
    uint32_t frames_shown;
    int dead;                                              /* a bad message: the daemon drops the client */
} client;

static client C;
static int scr_w, scr_h;
static uint8_t *in; static size_t inlen, incap;
static GLuint s_tex, s_fbo; static int s_w, s_h;          /* the app's surface */
static uint8_t *shot, *rows;
static char why[256];
static const char *oom;                                    /* why handle() failed, when not the message's fault */
static struct { uint32_t frames; double last_ms, sum_ms; } st;
static char errs[NERR][192]; static uint32_t nerr; static int atlas_full;   /* what the daemon sends as E_ERROR */

static void client_init(void) {
    memset(&C, 0, sizeof C);
    C.xf.s = 1; C.mode = MODE_LAYER; C.g.name = C.app;
}

static void send_error(client *c, const char *e) {
    snprintf(errs[nerr++ % NERR], sizeof errs[0], "%s: %s", c->app[0] ? c->app : "app", e);
    if (strstr(e, "glyph atlas texture full")) atlas_full = 1;
    fprintf(stderr, "%s: %s\n", c->app[0] ? c->app : "app", e);
}

/* ---------------- the screen ---------------- */

/* the surface: layer = the PLACE rect, embed = the HMI's box */
static void surf_rect(const client *c, int r[4]) {
    if (c->mode == MODE_EMBED) memcpy(r, embed_area, sizeof embed_area);
    else { r[0] = c->x; r[1] = c->y; r[2] = c->w; r[3] = c->h; }
}

/* main.c shown(): embed = the box's owner (embed_update: shown, has a frame), layer = a surface (PLACE) */
static int shown(const client *c) {
    if (c->dead || !s_fbo || !c->visible || !c->frames_shown) return 0;
    return c->mode == MODE_EMBED ? c->frame_words > 0 : c->placed;
}

static void surf_size(int w, int h) {
    if (s_fbo && w == s_w && h == s_h) return;
    if (!s_tex) { glGenTextures(1, &s_tex); glGenFramebuffers(1, &s_fbo); }
    glBindTexture(GL_TEXTURE_2D, s_tex);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glBindFramebuffer(GL_FRAMEBUFFER, s_fbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, s_tex, 0);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    s_w = w; s_h = h;
}

/* the screen: transparent, the surface over it while shown */
static void present(void) {
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glDisable(GL_SCISSOR_TEST);
    glViewport(0, 0, scr_w, scr_h);
    glClearColor(0, 0, 0, 0); glClear(GL_COLOR_BUFFER_BIT);
    if (!shown(&C)) return;
    int r[4]; surf_rect(&C, r);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, s_fbo);
    glBlitFramebuffer(0, 0, s_w, s_h, r[0], scr_h - r[1] - s_h, r[0] + s_w, scr_h - r[1], GL_COLOR_BUFFER_BIT, GL_NEAREST);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
}

static void render(client *c) {
    if (!c->dirty || c->dead) return;
    if (c->mode == MODE_EMBED ? !c->visible : !c->placed) return;   /* render_embed: the box's owner; render_layer: c->es */
    int r[4]; surf_rect(c, r);
    double t0 = emscripten_get_now();
    surf_size(r[2], r[3]);
    glBindFramebuffer(GL_FRAMEBUFFER, s_fbo);
    gfx_draw(&c->g, &c->xf, s_w, s_h, c->frame, c->frame_words, GFX_CLEAR);
    c->dirty = 0;
    c->frames_shown++;
    present();
    st.last_ms = emscripten_get_now() - t0; st.sum_ms += st.last_ms; st.frames++;
}

/* ---------------- messages (main.c) ---------------- */

static void set_dialect(client *c, int d) {
    c->dialect = d;
    c->g.upstream_ops = d == DIALECT_UPSTREAM;
}

static void hello(client *c, const uint8_t *p, uint32_t len) {
    if (hello_parse(p, len, c->app, sizeof c->app)) c->dialect = DIALECT_NATIVE;
}

static int set_mode(client *c, uint32_t mode) {
    if (mode != MODE_LAYER && mode != MODE_EMBED) return -1;
    if ((int)mode == c->mode) return 0;
    c->mode = (int)mode;
    c->frames_shown = 0;
    c->dirty = c->frame_words > 0;
    return 0;
}

static int claim(client *c, const uint32_t *w, size_t nw) {
    if (nw < 1 || w[0] > 16 || nw < 1 + 4 * (size_t)w[0]) return -1;
    return 0;
}

static int picture(client *c, const uint8_t *p, uint32_t len) {
    const uint32_t *w = (const uint32_t *)p;
    if (len < 12) return -1;
    uint32_t iw = w[1], ih = w[2];
    if (iw < 1 || ih < 1 || iw > GFX_IMG_SIDE || ih > GFX_IMG_SIDE || len != 12 + (size_t)iw * ih * 4) return -1;
    if (gfx_image_def(&c->g, w[0], (int)iw, (int)ih, p + 12) < 0) send_error(c, gfx_error());
    return 0;
}

static int grab(client *c, const uint32_t *w, size_t nw) { return nw < 1 ? -1 : 0; }

/* returns -1 to drop the client */
static int handle(client *c, uint32_t type, const uint8_t *p, uint32_t len) {
    const uint32_t *w = (const uint32_t *)p;
    size_t nw = len / 4;
    if (type >= 9 && type <= 11 && c->dialect == DIALECT_UNKNOWN) {
        int d = dialect_of(type, p, len);
        if (d == DIALECT_UNKNOWN) return -1;
        set_dialect(c, d);
    }
    switch (type) {
    case M_HELLO:
        hello(c, p, len);
        return 0;
    case 9:
        if (c->dialect == DIALECT_UPSTREAM) {
            if (nw < 3 || (uint64_t)w[1] * w[2] * 4 + 12 > len) return -1;
            if (!c->placed) return 0;
            if (gfx_image_upstream(&c->g, w[0], (int)w[1], (int)w[2], p + 12) < 0) send_error(c, gfx_error());
            return 0;
        }
        return claim(c, w, nw);
    case 10:
        if (c->dialect == DIALECT_UPSTREAM) return grab(c, w, nw);
        return picture(c, p, len);
    case 11:
        if (c->dialect == DIALECT_UPSTREAM) return 0;
        if (nw < 1) return -1;
        gfx_image_drop(&c->g, w[0]);
        return 0;
    case MI_FPS:
        return nw < 1 ? -1 : 0;
    case MI_VIDEO:                                         /* no /dev/shm here: op 19 draws nothing */
        if (c->dialect == DIALECT_UPSTREAM) return 0;
        return len < 8 ? -1 : 0;
    case MI_DROP_VIDEO:
        if (c->dialect == DIALECT_UPSTREAM) return 0;
        return nw < 1 ? -1 : 0;
    case M_PLACE: {
        if (nw < 7) return -1;
        int x = (int32_t)w[0], y = (int32_t)w[1], ww = (int32_t)w[2], hh = (int32_t)w[3];
        float s, ox, oy; memcpy(&s, &w[4], 4); memcpy(&ox, &w[5], 4); memcpy(&oy, &w[6], 4);
        if (ww < 1 || hh < 1 || ww > 4096 || hh > 4096 || !(s > 0.05f && s < 8)) return -1;
        int resize = !c->placed || ww != c->w || hh != c->h;
        c->x = x; c->y = y; c->w = ww; c->h = hh; c->xf.s = s; c->xf.ox = ox; c->xf.oy = oy;
        c->placed = 1;
        if (resize) {
            /* layers were rendered at the old scale: the app re-sends them (a new surface: nothing on it yet) */
            gfx_client_free(&c->g);
            c->frames_shown = 0;
        } else if (c->mode == MODE_EMBED) {
            c->dirty = c->frame_words > 0;
        }
        present();
        return 0;
    }
    case M_SHOW:
        if (nw < 1) return -1;
        if (c->mode == MODE_EMBED && w[0] && !c->visible && c->frame_words) { c->dirty = 1; c->frames_shown = 0; }  /* owner again */
        c->visible = w[0] != 0;
        present();
        return 0;
    case M_ATLAS: {
        if (nw < 3) return -1;
        uint32_t id = w[0], aw = w[1], ah = w[2];
        if (aw > 4096 || ah > 4096 || 12 + (size_t)aw * ah > len) return -1;
        if (gfx_atlas(&c->g, id, (int)aw, (int)ah, p + 12) < 0) send_error(c, gfx_error());
        return 0;
    }
    case M_RAMP:
        if (nw < 2 || w[1] > 64 || nw < 2 + (size_t)w[1]) return -1;
        gfx_ramp(&c->g, w[0], (int)w[1], w + 2);
        return 0;
    case M_LAYER: {
        if (nw < 3 || !c->placed) return nw < 3 ? -1 : 0;
        float lw, lh; memcpy(&lw, &w[1], 4); memcpy(&lh, &w[2], 4);
        if (gfx_layer_def(&c->g, w[0], lw, lh, c->xf.s, w + 3, nw - 3) < 0) send_error(c, gfx_error());
        return 0;
    }
    case M_DROP_LAYER:
        if (nw < 1) return -1;
        gfx_layer_drop(&c->g, w[0]);
        return 0;
    case M_FRAME:
        if (nw > c->frame_cap) {
            uint32_t *f = realloc(c->frame, (nw + 1024) * 4);
            if (!f) { oom = "out of memory"; return -1; }
            c->frame = f; c->frame_cap = nw + 1024;
        }
        memcpy(c->frame, p, nw * 4);
        c->frame_words = nw;
        c->dirty = 1;
        return 0;
    }
    if (c->dialect != DIALECT_NATIVE) return 0;           /* newer client: ignore */
    switch (type) {
    case X_MODE:
        if (nw < 1) return -1;
        return set_mode(c, w[0]);
    case X_GRAB:
        return grab(c, w, nw);
    case X_PIXMAP:
        if (nw < 5) return -1;
        if (gfx_pixmap_def(&c->g, w[0], (int)w[1], (int)w[2], (int)w[3], w[4] != 0) < 0) send_error(c, gfx_error());
        return 0;
    case X_PIXELS: {
        if (nw < 1) return -1;
        int r = gfx_pixmap_pixels(&c->g, w[0], p + 4, len - 4);
        if (r == -2) send_error(c, gfx_error());
        return r == -1 ? -1 : 0;
    }
    case X_PALETTE:
        if (len < 4 + 768) return -1;
        if (gfx_pixmap_palette(&c->g, w[0], p + 4) < 0) send_error(c, gfx_error());
        return 0;
    default:
        return 0;
    }
}

static void drop(client *c, const char *e) {
    snprintf(why, sizeof why, "%s: %s", c->app[0] ? c->app : "client", e);
    c->dead = 1;
    present();
}

/* ---------------- exports (mgu-gfx.js) ---------------- */

EMSCRIPTEN_KEEPALIVE int emu_init(int w, int h) {
    scr_w = w; scr_h = h;
    if (!emu_gl_context()) { snprintf(why, sizeof why, "no WebGL 2 context"); return -1; }
    if (gfx_init() < 0) { snprintf(why, sizeof why, "gfx_init: %s", gfx_error()); return -1; }
    client_init();
    present();
    return 0;
}

EMSCRIPTEN_KEEPALIVE const char *emu_error(void) { return why; }

/* room for n more bytes: write them there, then emu_feed(n) */
EMSCRIPTEN_KEEPALIVE uint8_t *emu_buf(uint32_t n) {
    if (n > MAX_FEED) return NULL;
    if (!in || incap - inlen < n) {
        size_t cap = incap ? incap : 262144;
        while (cap - inlen < n) cap *= 2;
        uint8_t *b = realloc(in, cap);
        if (!b) return NULL;
        in = b; incap = cap;
    }
    return in + inlen;
}

/* whole messages are handled, a partial one waits for the rest; then the newest frame is drawn.
   1: a frame drawn, 0: none, -1: the client is dropped (a bad message; emu_reset to start again) */
EMSCRIPTEN_KEEPALIVE int emu_feed(uint32_t n) {
    inlen += n;
    client *c = &C;
    if (c->dead) { inlen = 0; return -1; }
    if (inlen >= 4 && !memcmp(in, "DBR1", 4) && !c->app[0]) {
        c->dialect = DIALECT_DBR; inlen = 0; drop(c, "display-bridge (DBR1) apps are not emulated"); return -1;
    }
    size_t off = 0;
    while (inlen - off >= 8) {
        uint32_t type, len;
        memcpy(&type, in + off, 4); memcpy(&len, in + off + 4, 4);
        if (len > MAX_MSG) { inlen = 0; drop(c, "message too long"); return -1; }
        if (inlen - off - 8 < len) break;
        const uint8_t *pl = in + off + 8;
        uint8_t *tmp = NULL;
        if (((uintptr_t)pl & 3) != 0) {
            if (!(tmp = malloc(len + 4))) { inlen = 0; drop(c, "out of memory"); return -1; }
            memcpy(tmp, pl, len); pl = tmp;
        }
        oom = NULL;
        int rc = handle(c, type, pl, len);
        free(tmp);
        if (rc < 0) {
            char e[64]; snprintf(e, sizeof e, "%s %u (len %u)", oom ? oom : "bad message", type, len);
            inlen = 0; drop(c, e); return -1;
        }
        off += 8 + len;
    }
    if (off) { memmove(in, in + off, inlen - off); inlen -= off; }
    uint32_t f = st.frames;
    render(c);
    return st.frames != f;
}

EMSCRIPTEN_KEEPALIVE void emu_reset(void) {
    gfx_client_free(&C.g);
    free(C.frame);
    client_init();
    inlen = 0; why[0] = 0;
    if (incap > (4u << 20)) { free(in); in = NULL; incap = 0; }   /* after a big stream */
    memset(&st, 0, sizeof st);
    memset(errs, 0, sizeof errs); nerr = 0;              /* atlas_full stays: the atlas texture is shared */
    present();
}

/* the screen as shown, RGBA rows top-down (scr_w * scr_h * 4); NULL: out of memory or the GPU failed */
EMSCRIPTEN_KEEPALIVE uint8_t *emu_read(void) {
    size_t sz = (size_t)scr_w * scr_h * 4;
    if (!shot && !(shot = malloc(sz))) return NULL;
    memset(shot, 0, sz);
    if (!shown(&C)) return shot;
    int r[4]; surf_rect(&C, r);
    free(rows);
    if (!(rows = calloc((size_t)s_w * s_h, 4))) return NULL;
    while (glGetError() != GL_NO_ERROR) {}
    glBindFramebuffer(GL_FRAMEBUFFER, s_fbo);
    glReadPixels(0, 0, s_w, s_h, GL_RGBA, GL_UNSIGNED_BYTE, rows);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    if (glGetError() != GL_NO_ERROR) return NULL;
    for (int y = 0; y < s_h; y++) {
        int sy = r[1] + y, x0 = r[0] < 0 ? -r[0] : 0, x1 = r[0] + s_w > scr_w ? scr_w - r[0] : s_w;
        if (sy < 0 || sy >= scr_h || x1 <= x0) continue;
        memcpy(shot + ((size_t)sy * scr_w + r[0] + x0) * 4, rows + ((size_t)(s_h - 1 - y) * s_w + x0) * 4, (size_t)(x1 - x0) * 4);
    }
    return shot;
}

/* frames, visible, placed (embed: the box), x, y, w, h, dialect, dead, errors, atlas full, 0 (int32), then last and
   average ms (f64) */
EMSCRIPTEN_KEEPALIVE void *emu_stats(void) {
    static struct { int32_t i[12]; double ms[2]; } s;
    int r[4]; surf_rect(&C, r);
    int32_t v[12] = { (int32_t)st.frames, shown(&C), C.placed || C.mode == MODE_EMBED, r[0], r[1], r[2], r[3], C.dialect, C.dead,
                      (int32_t)nerr, atlas_full, 0 };
    memcpy(s.i, v, sizeof v);
    s.ms[0] = st.last_ms; s.ms[1] = st.frames ? st.sum_ms / st.frames : 0;
    return &s;
}

EMSCRIPTEN_KEEPALIVE const char *emu_app(void) { return C.app; }

/* the k-th newest error (0 = the last), "" when none */
EMSCRIPTEN_KEEPALIVE const char *emu_err(int k) {
    return k < 0 || k >= NERR || (uint32_t)k >= nerr ? "" : errs[(nerr - 1 - k) % NERR];
}

EMSCRIPTEN_KEEPALIVE void emu_destroy(void) { emu_gl_destroy(); }
