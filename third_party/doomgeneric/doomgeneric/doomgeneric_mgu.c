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
void DG_DrawFrame(void) { frames++; js_frame(); }
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
