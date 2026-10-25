//
// mgu_hires.h - the iDrive app's high-resolution 3D view.
//
// The 3D view is drawn into its own buffer (r_buffer, up to RW_MAX x RH_MAX, size chosen at run
// time with r_width / r_height) instead of the 320 x 200 screen. The status bar, menus, messages,
// intermission and automap stay in the 320 x 200 screen (I_VideoBuffer), where the part the view
// covers is filled with MGU_SEETHROUGH, a colour none of those graphics use: the app draws the
// view under that layer. The view keeps Doom's vertical field of view and widens the horizontal
// one to the buffer's shape (hor+), with Doom's 1.2-tall pixels (the app stretches it to 1.2).
//

#ifndef MGU_HIRES_H
#define MGU_HIRES_H

#include "doomtype.h"

#define RW_MAX          1920
#define RH_MAX          640
#define RPITCH          RW_MAX          // bytes per row of r_buffer
#define MGU_SEETHROUGH  16              // palette index unused by STCFN*, M_*, ST*, WI* graphics

extern int r_width, r_height;           // 3D view size (set before R_SetViewSize)
extern byte r_buffer[RW_MAX * RH_MAX];
extern boolean mgu_view_drawn;          // the last frame drew the 3D view

#endif
