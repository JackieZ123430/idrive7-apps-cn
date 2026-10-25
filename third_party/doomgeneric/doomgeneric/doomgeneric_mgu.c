/*
 * doomgeneric_mgu.c - platform layer for the iDrive (MGU) app: Doom runs as WebAssembly inside
 * the app's Node.js process. JavaScript gives the time, feeds the keys and takes each frame
 * (320 x 200 RGBA in DG_ScreenBuffer) after doomgeneric_Tick().
 */
#include <stdint.h>
#include <string.h>
#include "doomgeneric.h"
#include "d_event.h"
#include "doomdef.h"
#include "doomstat.h"
#include "d_player.h"
#include "g_game.h"
#include "p_saveg.h"
#include "m_controls.h"
#include "i_video.h"
#include "r_main.h"
#include "w_wad.h"
#include "z_zone.h"
#include "mgu_hires.h"

#define IMPORT(name) __attribute__((import_module("env"), import_name(#name)))
#define EXPORT(name) __attribute__((export_name(#name)))

IMPORT(js_ticks) uint32_t js_ticks(void);
IMPORT(js_frame) void js_frame(void);

static uint16_t keyq[256];
static unsigned kr, kw;
static uint32_t frames;

EXPORT(mgu_key) void mgu_key(int pressed, int key) {
    keyq[kw & 255] = (uint16_t)(((pressed ? 1 : 0) << 8) | (key & 0xff));
    kw++;
    if (kw - kr > 256) kr = kw - 256;          /* full: drop the oldest */
}
EXPORT(mgu_screen) uint32_t mgu_screen(void) { return (uint32_t)(uintptr_t)DG_ScreenBuffer; }
EXPORT(mgu_width) int mgu_width(void) { return DOOMGENERIC_RESX; }
EXPORT(mgu_height) int mgu_height(void) { return DOOMGENERIC_RESY; }
EXPORT(mgu_frames) uint32_t mgu_frames(void) { return frames; }
/* controller turns: added up between tics, handed to Doom as one mouse move per tic
   (G_Responder keeps only the last mouse event of a tic) */
static int turn_acc;
EXPORT(mgu_turn) void mgu_turn(int dx) { turn_acc += dx; }
EXPORT(mgu_tick) void mgu_tick(void) {
    if (turn_acc) {
        event_t ev;
        memset(&ev, 0, sizeof ev);
        ev.type = ev_mouse; ev.data1 = 0; ev.data2 = turn_acc; ev.data3 = 0;
        D_PostEvent(&ev);
        turn_acc = 0;
    }
    doomgeneric_Tick();
}

/* args from JS: one string, words separated by '\n' (copied into a static buffer) */
static char argbuf[1024];
static char *argv[32];
EXPORT(mgu_argbuf) uint32_t mgu_argbuf(void) { return (uint32_t)(uintptr_t)argbuf; }
EXPORT(mgu_start) void mgu_start(void) {
    int argc = 0;
    char *p = argbuf;
    argbuf[sizeof argbuf - 1] = 0;
    while (*p && argc < 31) {
        argv[argc++] = p;
        while (*p && *p != '\n') p++;
        if (*p) *p++ = 0;
    }
    argv[argc] = 0;
    doomgeneric_Create(argc, argv);
    key_nextweapon = ']';                      /* the app's "next weapon" (unbound in vanilla) */
    key_prevweapon = '[';
}

void DG_Init(void) {}
/* the 3D view in full resolution (mgu_hires.h): r_buffer (palette indexes) -> RGBA, each frame */
extern struct color colors[256];
static uint32_t view_rgba[RW_MAX * RH_MAX];
static int view_on;
static void view_convert(void) {
    uint32_t pal[256];
    int i, x, y;
    for (i = 0; i < 256; i++)
        pal[i] = 0xff000000u | ((uint32_t)colors[i].b << 16) | ((uint32_t)colors[i].g << 8) | colors[i].r;
    for (y = 0; y < r_height; y++) {
        const uint8_t *in = r_buffer + y * RPITCH;
        uint32_t *out = view_rgba + y * r_width;
        for (x = 0; x < r_width; x++) out[x] = pal[in[x]];
    }
}
void DG_DrawFrame(void) {
    view_on = mgu_view_drawn;
    if (view_on) view_convert();
    frames++; js_frame();
}
EXPORT(mgu_view_ptr) uint32_t mgu_view_ptr(void) { return (uint32_t)(uintptr_t)view_rgba; }
EXPORT(mgu_view_w) int mgu_view_w(void) { return r_width; }
EXPORT(mgu_view_h) int mgu_view_h(void) { return r_height; }
EXPORT(mgu_view_on) int mgu_view_on(void) { return view_on; }
/* render size of the 3D view (applied from the next frame) */
EXPORT(mgu_set_res) void mgu_set_res(int w, int h) {
    if (w < 320) w = 320; if (w > RW_MAX) w = RW_MAX;
    if (h < 100) h = 100; if (h > RH_MAX) h = RH_MAX;
    r_width = w & ~1; r_height = h & ~1;
    R_SetViewSize(10, 0);
}
/* a 64 x 64 flat (e.g. the status bar border FLOOR7_2) as RGBA, for the app to tile; 0 if missing */
static uint32_t flat_rgba[64 * 64];
EXPORT(mgu_flat) uint32_t mgu_flat(void) {
    int lump = W_CheckNumForName("FLOOR7_2"), i;
    const uint8_t *src;
    if (lump < 0) return 0;
    src = W_CacheLumpNum(lump, PU_STATIC);
    for (i = 0; i < 64 * 64; i++) {
        struct color c = colors[src[i]];
        flat_rgba[i] = 0xff000000u | ((uint32_t)c.b << 16) | ((uint32_t)c.g << 8) | c.r;
    }
    return (uint32_t)(uintptr_t)flat_rgba;
}
void DG_SleepMs(uint32_t ms) { (void)ms; }       /* JS paces the ticks; never block the event loop */
uint32_t DG_GetTicksMs(void) { return js_ticks(); }
int DG_GetKey(int *pressed, unsigned char *key) {
    if (kr == kw) return 0;
    uint16_t v = keyq[kr & 255]; kr++;
    *pressed = v >> 8; *key = (unsigned char)(v & 0xff);
    return 1;
}
void DG_SetWindowTitle(const char *title) { (void)title; }

/* no shell here (i_system.c uses it for a message box) */
int system(const char *cmd) { (void)cmd; return -1; }

/* game tic counter (for the app's status line and tests) */
extern int gametic;
EXPORT(mgu_gametic) int mgu_gametic(void) { return gametic; }

/* game state for the app: gamestate | playerstate << 8 | health << 16 (health clamped 0..255)
   | menu open << 31... kept simple: bit 30 = menu open */
extern boolean menuactive;
EXPORT(mgu_state) uint32_t mgu_state(void) {
    player_t *p = &players[consoleplayer];
    int h = p->health < 0 ? 0 : p->health > 255 ? 255 : p->health;
    return (uint32_t)gamestate | ((uint32_t)p->playerstate << 8) | ((uint32_t)h << 16) | (menuactive ? 1u << 30 : 0);
}
/* save / load a slot (Doom does it on its next tics) */
EXPORT(mgu_save) void mgu_save(int slot) { G_SaveGame(slot, "IDRIVE AUTOSAVE"); }
EXPORT(mgu_load) void mgu_load(int slot) { G_LoadGame(P_SaveGameFile(slot)); }
EXPORT(mgu_level) int mgu_level(void) { return gameepisode * 10 + gamemap; }
/* new game: skill 1..5 (as the -skill argument), episode 1..4, map 1 */
EXPORT(mgu_newgame) void mgu_newgame(int skill, int episode) {
    if (skill < 1) skill = 1; if (skill > 5) skill = 5;
    if (episode < 1) episode = 1; if (episode > 4) episode = 4;
    G_DeferedInitNew((skill_t)(skill - 1), episode, 1);
}
