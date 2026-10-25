#!/bin/bash
# build.sh - doomgeneric -> apps/doom/doom.wasm (the iDrive Doom app's game engine)
#
# Needs: zig (C compiler for wasm32-wasi, e.g. `pip install ziglang==0.13.0`) and binaryen's wasm-opt
# (e.g. `npm install binaryen@119`). Override with ZIG="zig" / WASM_OPT=/path/to/wasm-opt.
# The car runs Node 8: WebAssembly MVP only, so sign-extension opcodes are lowered and 64-bit
# arguments of imports/exports are split for JavaScript (--legalize-js-interface).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ZIG=${ZIG:-"python3 -m ziglang"}
WASM_OPT=${WASM_OPT:-wasm-opt}
OUT=${OUT:-$HERE/../../apps/doom/doom.wasm}
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
cd "$HERE/doomgeneric"
SRCS=$(sed -n 's/^SRC_DOOM = //p' Makefile | tr ' ' '\n' | grep -v doomgeneric_xlib | sed 's/\.o$/.c/')
$ZIG cc -target wasm32-wasi -mcpu=mvp -mexec-model=reactor -O2 \
    -DMGU_RGBA -DDOOMGENERIC_RESX=320 -DDOOMGENERIC_RESY=200 -DNORMALUNIX -DLINUX -D_DEFAULT_SOURCE -Wno-everything \
    -o "$TMP/doom-raw.wasm" $SRCS doomgeneric_mgu.c
"$WASM_OPT" "$TMP/doom-raw.wasm" --enable-sign-ext --enable-mutable-globals --legalize-js-interface --signext-lowering -O2 -o "$OUT"
ls -l "$OUT"
