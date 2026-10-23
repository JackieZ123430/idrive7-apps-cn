/* ivi-probe - inspect and experiment with the MGU compositor (winston, ivi-controller 1.x).
 *   ivi-probe list                       screens, their layer order, layers and surfaces with properties
 *   ivi-probe order <screen> <ids...>    set a screen's layer render order (bottom first)
 *   ivi-probe test <x> <y> <w> <h> <above|below|top> [secs] [argb hex]
 *        show a solid test surface (ivi id 0x4d470001) on its own layer 0x4d470000,
 *        placed directly above / below the HMI layer (100) or on top of everything.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <wayland-client.h>
#include <wayland-egl.h>
#include <EGL/egl.h>
#include <GLES2/gl2.h>
#include "ivi-controller-client-protocol.h"
#include "ivi-application-client-protocol.h"

static struct wl_display *dpy;
static struct wl_compositor *comp;
static struct ivi_controller *ctl;
static struct ivi_application *iapp;
#define MAXN 128
static struct { uint32_t id; struct ivi_controller_screen *s; } screens[8]; static int nscreens;
static uint32_t layers[MAXN]; static int nlayers;
static uint32_t surfs[MAXN]; static int nsurfs;

static void c_screen(void *d, struct ivi_controller *c, uint32_t id, struct ivi_controller_screen *s) { screens[nscreens].id = id; screens[nscreens++].s = s; }
static void c_layer(void *d, struct ivi_controller *c, uint32_t id) { if (nlayers < MAXN) layers[nlayers++] = id; }
static void c_surface(void *d, struct ivi_controller *c, uint32_t id) { if (nsurfs < MAXN) surfs[nsurfs++] = id; }
static void c_error(void *d, struct ivi_controller *c, int32_t oid, int32_t ot, int32_t code, const char *t) { fprintf(stderr, "ivi error obj %d type %d code %d: %s\n", oid, ot, code, t ? t : ""); }
static const struct ivi_controller_listener ctl_l = { c_screen, c_layer, c_surface, c_error };

/* property printers */
static const char *cur;
static void p_vis(void *d, void *o, int32_t v) { printf("    %s visibility %d\n", cur, v); }
static void p_op(void *d, void *o, wl_fixed_t v) { printf("    %s opacity %.2f\n", cur, wl_fixed_to_double(v)); }
static void p_src(void *d, void *o, int32_t x, int32_t y, int32_t w, int32_t h) { printf("    %s src %d,%d %dx%d\n", cur, x, y, w, h); }
static void p_dst(void *d, void *o, int32_t x, int32_t y, int32_t w, int32_t h) { printf("    %s dst %d,%d %dx%d\n", cur, x, y, w, h); }
static void p_conf(void *d, void *o, int32_t w, int32_t h) { printf("    %s config %dx%d\n", cur, w, h); }
static void p_ori(void *d, void *o, int32_t v) {}
static void p_pix(void *d, void *o, int32_t v) { printf("    %s pixelformat %d\n", cur, v); }
static void p_slayer(void *d, void *o, struct ivi_controller_layer *l) { printf("    %s on layer %u\n", cur, l ? wl_proxy_get_id((struct wl_proxy *)l) : 0); }
static void p_stats(void *d, void *o, uint32_t a, uint32_t b, uint32_t c, uint32_t pid, const char *n) { printf("    %s pid %u (%s)\n", cur, pid, n ? n : "?"); }
static void p_destroyed(void *d, void *o) {}
static void p_content(void *d, void *o, int32_t v) { printf("    %s content %d\n", cur, v); }
static void p_lscreen(void *d, void *o, struct wl_output *out) { printf("    %s on screen %s\n", cur, out ? "yes" : "none"); }
static const struct ivi_controller_surface_listener surf_l = {
    (void *)p_vis, (void *)p_op, (void *)p_src, (void *)p_dst, (void *)p_conf, (void *)p_ori, (void *)p_pix, (void *)p_slayer, (void *)p_stats, (void *)p_destroyed, (void *)p_content };
static const struct ivi_controller_layer_listener layer_l = {
    (void *)p_vis, (void *)p_op, (void *)p_src, (void *)p_dst, (void *)p_conf, (void *)p_ori, (void *)p_lscreen, (void *)p_destroyed };

static void reg_global(void *d, struct wl_registry *r, uint32_t name, const char *iface, uint32_t ver) {
    if (!strcmp(iface, "wl_compositor")) comp = wl_registry_bind(r, name, &wl_compositor_interface, 1);
    else if (!strcmp(iface, "ivi_controller")) { ctl = wl_registry_bind(r, name, &ivi_controller_interface, 1); ivi_controller_add_listener(ctl, &ctl_l, NULL); }
    else if (!strcmp(iface, "wl_output")) wl_registry_bind(r, name, &wl_output_interface, 1);
    else if (!strcmp(iface, "ivi_application")) iapp = wl_registry_bind(r, name, &ivi_application_interface, 1);
    if (getenv("PROBE_GLOBALS")) printf("global %s v%u\n", iface, ver);
}
static void reg_remove(void *d, struct wl_registry *r, uint32_t n) {}
static const struct wl_registry_listener reg_l = { reg_global, reg_remove };

static int list(void) {
    printf("%d screens, %d layers, %d surfaces\n", nscreens, nlayers, nsurfs);
    for (int i = 0; i < nscreens; i++) printf("  screen %u\n", screens[i].id);
    for (int i = 0; i < nlayers; i++) {
        char nm[64]; snprintf(nm, sizeof nm, "layer %u(0x%x)", layers[i], layers[i]); cur = nm;
        printf("  %s\n", nm);
        struct ivi_controller_layer *l = ivi_controller_layer_create(ctl, layers[i], 0, 0);
        ivi_controller_layer_add_listener(l, &layer_l, NULL);
        wl_display_roundtrip(dpy); wl_display_roundtrip(dpy);
    }
    for (int i = 0; i < nsurfs; i++) {
        char nm[64]; snprintf(nm, sizeof nm, "surface %u(0x%x)", surfs[i], surfs[i]); cur = nm;
        printf("  %s\n", nm);
        struct ivi_controller_surface *s = ivi_controller_surface_create(ctl, surfs[i]);
        ivi_controller_surface_add_listener(s, &surf_l, NULL);
        ivi_controller_surface_send_stats(s);
        wl_display_roundtrip(dpy); wl_display_roundtrip(dpy);
    }
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: ivi-probe list | order <screen> <layer ids...> | test x y w h above|below|top [secs] [aarrggbb]\n"); return 2; }
    dpy = wl_display_connect(NULL);
    if (!dpy) { perror("wl_display_connect"); return 1; }
    struct wl_registry *reg = wl_display_get_registry(dpy);
    wl_registry_add_listener(reg, &reg_l, NULL);
    wl_display_roundtrip(dpy); wl_display_roundtrip(dpy);
    if (!ctl) { fprintf(stderr, "no ivi_controller\n"); return 1; }
    if (!strcmp(argv[1], "list")) return list();
    if (!strcmp(argv[1], "order") && argc >= 3) {
        struct wl_array a; wl_array_init(&a);
        for (int i = 3; i < argc; i++) *(uint32_t *)wl_array_add(&a, 4) = strtoul(argv[i], 0, 0);
        for (int i = 0; i < nscreens; i++) if (screens[i].id == strtoul(argv[2], 0, 0)) ivi_controller_screen_set_render_order(screens[i].s, &a);
        ivi_controller_commit_changes(ctl); wl_display_roundtrip(dpy); return 0;
    }
    if (!strcmp(argv[1], "test") && argc >= 7) {
        int x = atoi(argv[2]), y = atoi(argv[3]), w = atoi(argv[4]), h = atoi(argv[5]);
        int secs = argc > 7 ? atoi(argv[7]) : 10;
        unsigned col = argc > 8 ? strtoul(argv[8], 0, 16) : 0xc0ff0000;
        const uint32_t SID = getenv("PROBE_LID") ? (uint32_t)strtoul(getenv("PROBE_LID"), 0, 0) + 1 : 0x4d470001,
                       LID = getenv("PROBE_LID") ? (uint32_t)strtoul(getenv("PROBE_LID"), 0, 0) : 0x4d470000;
        struct wl_surface *ws = wl_compositor_create_surface(comp);
        struct wl_region *empty = wl_compositor_create_region(comp);
        wl_surface_set_input_region(ws, empty);            /* touches go through to the HMI */
        ivi_application_surface_create(iapp, SID, ws);
        struct wl_egl_window *win = wl_egl_window_create(ws, w, h);
        EGLDisplay ed = eglGetDisplay((EGLNativeDisplayType)dpy);
        eglInitialize(ed, 0, 0); eglBindAPI(EGL_OPENGL_ES_API);
        EGLint ca[] = { EGL_SURFACE_TYPE, EGL_WINDOW_BIT, EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT, EGL_NONE };
        EGLConfig cfg; EGLint n; eglChooseConfig(ed, ca, &cfg, 1, &n);
        EGLint xa[] = { EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE };
        EGLContext ec = eglCreateContext(ed, cfg, EGL_NO_CONTEXT, xa);
        EGLSurface es = eglCreateWindowSurface(ed, cfg, (EGLNativeWindowType)win, 0);
        eglMakeCurrent(ed, es, es, ec);
        glClearColor(((col >> 16) & 255) / 255.f, ((col >> 8) & 255) / 255.f, (col & 255) / 255.f, (col >> 24) / 255.f);
        glClear(GL_COLOR_BUFFER_BIT); eglSwapBuffers(ed, es);
        wl_display_roundtrip(dpy);
        struct ivi_controller_surface *cs = ivi_controller_surface_create(ctl, SID);
        ivi_controller_surface_set_source_rectangle(cs, 0, 0, w, h);
        ivi_controller_surface_set_destination_rectangle(cs, 0, 0, w, h);
        ivi_controller_surface_set_visibility(cs, 1);
        struct ivi_controller_layer *cl = ivi_controller_layer_create(ctl, LID, 1920, 720);
        ivi_controller_layer_set_source_rectangle(cl, 0, 0, w, h);
        ivi_controller_layer_set_destination_rectangle(cl, x, y, w, h);
        ivi_controller_layer_add_surface(cl, cs);
        ivi_controller_layer_set_visibility(cl, 1);
        ivi_controller_commit_changes(ctl);
        wl_display_roundtrip(dpy);
        /* screen order: put our layer relative to the HMI layer (100) in the current order */
        /* (current order is unknown to clients in v1: rebuild from the known layer list) */
        struct wl_array a; wl_array_init(&a);
        int placed = 0;
        for (int i = 0; i < nlayers; i++) {
            if (layers[i] == LID) continue;
            if (layers[i] == 100 && !strcmp(argv[6], "below")) { *(uint32_t *)wl_array_add(&a, 4) = LID; placed = 1; }
            *(uint32_t *)wl_array_add(&a, 4) = layers[i];
            if (layers[i] == 100 && !strcmp(argv[6], "above")) { *(uint32_t *)wl_array_add(&a, 4) = LID; placed = 1; }
        }
        if (!placed) *(uint32_t *)wl_array_add(&a, 4) = LID;
        const char *ps = getenv("PROBE_SCREEN");
        for (int i = 0; i < nscreens; i++) {
            if (ps && strcmp(ps, "all") && strtoul(ps, 0, 0) != screens[i].id) continue;
            if (!ps && i) break;
            if (getenv("PROBE_ADD")) ivi_controller_screen_add_layer(screens[i].s, cl);
            else ivi_controller_screen_set_render_order(screens[i].s, &a);
            printf("screen %u\n", screens[i].id);
        }
        printf("order:"); uint32_t *p; wl_array_for_each(p, &a) printf(" %u", *p); printf("\n");
        ivi_controller_commit_changes(ctl);
        wl_display_roundtrip(dpy);
        for (int t = 0; t < secs * 30; t++) {
            float k = (t % 60) / 60.f;
            glClearColor(((col >> 16) & 255) / 255.f * (0.5f + k / 2), ((col >> 8) & 255) / 255.f, (col & 255) / 255.f, (col >> 24) / 255.f);
            glClear(GL_COLOR_BUFFER_BIT); eglSwapBuffers(ed, es);
            wl_display_dispatch_pending(dpy); wl_display_flush(dpy);
        }
        ivi_controller_layer_destroy(cl, 1); ivi_controller_commit_changes(ctl); wl_display_roundtrip(dpy);
        return 0;
    }
    fprintf(stderr, "bad command\n"); return 2;
}
