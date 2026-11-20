/*
 * Colour ramps (gfx.c) on Mesa's surfaceless EGL: all apps' ramps share the rows of one texture. An app that
 * reconnects or changes its size many times gets the rows it freed back, never a row another app still draws with,
 * and a ramp past the last free row is refused.
 *   EGL_PLATFORM=surfaceless build/host/test_ramp
 */
#include <EGL/egl.h>
#include <GLES2/gl2.h>
#include <stdio.h>
#include <string.h>
#include "gfx.h"
#include "proto.h"

static int fails;
#define CHECK(cond, what) do { if (cond) printf("ok   %s\n", what); else { printf("FAIL %s\n", what); fails++; } } while (0)

/* the colour in the middle of a 16x16 RAMPRECT of ramp `id` */
static uint32_t drawn(gfx_client *c, uint32_t id) {
    float f[8] = { 0, 0, 16, 16, 0, 0, 0, 16 };
    uint32_t ops[9] = { OP_RAMPRECT };
    memcpy(&ops[1], f, sizeof f);
    ops[6] = id;
    gfx_xf xf = { 1, 0, 0 };
    gfx_draw(c, &xf, 16, 16, ops, 9, GFX_CLEAR);
    uint8_t px[4];
    glReadPixels(8, 8, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, px);
    return (uint32_t)px[0] << 24 | (uint32_t)px[1] << 16 | (uint32_t)px[2] << 8 | px[3];
}

int main(void) {
    EGLDisplay d = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    EGLint ca[] = { EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT, EGL_NONE }, n;
    EGLint xa[] = { EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE }, pa[] = { EGL_WIDTH, 16, EGL_HEIGHT, 16, EGL_NONE };
    EGLConfig cfg;
    if (!eglInitialize(d, NULL, NULL) || !eglChooseConfig(d, ca, &cfg, 1, &n) || n < 1) { puts("FAIL no EGL"); return 1; }
    eglBindAPI(EGL_OPENGL_ES_API);
    EGLContext ctx = eglCreateContext(d, cfg, EGL_NO_CONTEXT, xa);
    EGLSurface pb = eglCreatePbufferSurface(d, cfg, pa);
    if (!eglMakeCurrent(d, pb, pb, ctx) || gfx_init() < 0) { puts("FAIL no GL context"); return 1; }

    const uint32_t red = 0xff0000ffu, blue = 0x0000ffffu;
    gfx_client a, b; memset(&a, 0, sizeof a); memset(&b, 0, sizeof b); a.name = "a"; b.name = "b";
    CHECK(gfx_ramp(&a, 1, 1, &red) == 0 && drawn(&a, 1) == red, "app a draws its red ramp");

    /* app b connects and leaves (or changes its size) 1000 times, a ramp each time */
    int clash = 0, refused = 0;
    for (int i = 0; i < 1000; i++) {
        if (gfx_ramp(&b, 1, 1, &blue) < 0) refused++;
        else if (b.ramp[0].row == a.ramp[0].row) clash++;
        gfx_client_free(&b);
    }
    CHECK(!refused, "b's ramp is taken each time (its freed row comes back)");
    CHECK(!clash, "b never gets the row a still holds");
    CHECK(drawn(&a, 1) == red, "a's ramp is still red");

    /* every row in use: 4 apps of 64 ramps (a's one among them) */
    gfx_client k[4]; memset(k, 0, sizeof k);
    int taken = 1;
    for (int i = 0; i < 4; i++) {
        k[i].name = "k";
        for (uint32_t id = 1; id <= 64 && taken < 256; id++) taken += gfx_ramp(&k[i], id, 1, &blue) == 0;
    }
    CHECK(taken == 256, "the 256 rows are given out");
    CHECK(gfx_ramp(&b, 1, 1, &blue) < 0 && strstr(gfx_error(), "rows already"), "the next app's ramp is refused");
    CHECK(drawn(&a, 1) == red, "a's ramp is still red");
    gfx_client_free(&k[2]);
    uint32_t none = drawn(&b, 99);                      /* no such ramp: the cleared surface */
    CHECK(gfx_ramp(&b, 1, 0, NULL) == 0 && drawn(&b, 1) == none, "once an app frees its rows, the next ramp gets one, "
          "cleared when it brings no colours");
    for (int i = 0; i < 4; i++) gfx_client_free(&k[i]);
    gfx_client_free(&a); gfx_client_free(&b);

    printf("%s\n", fails ? "FAILURES" : "ramp: all ok");
    return fails != 0;
}
