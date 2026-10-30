#!/bin/bash
# build.sh - kit/renderd/src/gfx.c (unchanged) + emu_gfx.c -> kit/emu/web/gfx/mgu-gfx-wasm.{js,wasm}
#
# Needs Docker (the official Emscripten image, pinned; arm64 and x86-64). The output is committed, so the emulator
# needs no Docker: run this again after a change to kit/renderd/src/gfx.c, dialect.c, proto.h or this folder.
#   kit/emu/wasm/build.sh            EMSDK_IMAGE=emscripten/emsdk:<ver> to try another Emscripten
# Emscripten's library cache: $EM_CACHE_DIR (default ~/.cache/mgu-emu-emcache), outside the repository.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
IMAGE=${EMSDK_IMAGE:-emscripten/emsdk:6.0.12}
CACHE=${EM_CACHE_DIR:-$HOME/.cache/mgu-emu-emcache}
OUT=kit/emu/web/gfx
SRC=kit/renderd/src
TMP=$OUT/.build-$$                    # the outputs replace the committed ones only when the build succeeds
mkdir -p "$ROOT/$TMP" "$CACHE"
trap 'rm -rf "$ROOT/$TMP"' EXIT
docker run --rm -u "$(id -u):$(id -g)" -e EM_CACHE=/emcache -v "$CACHE:/emcache" -v "$ROOT:/src" -w /src "$IMAGE" \
    emcc -O3 -g0 -std=gnu11 -D_GNU_SOURCE -Wall -Wextra -Wno-unused-parameter -Wno-misleading-indentation -Werror \
    -I$SRC kit/emu/wasm/emu_gfx.c $SRC/gfx.c $SRC/dialect.c $SRC/log.c \
    --js-library kit/emu/wasm/emu_lib.js \
    -sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createMguGfxWasm -sENVIRONMENT=web \
    -sMIN_WEBGL_VERSION=2 -sMAX_WEBGL_VERSION=2 \
    -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=64MB -sFILESYSTEM=0 \
    -sEXPORTED_FUNCTIONS=_emu_init,_emu_error,_emu_buf,_emu_feed,_emu_reset,_emu_read,_emu_stats,_emu_app,_emu_err,_emu_destroy \
    -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP32,HEAPF64,UTF8ToString \
    -o $TMP/mgu-gfx-wasm.js
mv "$ROOT/$TMP/mgu-gfx-wasm.js" "$ROOT/$TMP/mgu-gfx-wasm.wasm" "$ROOT/$OUT/"
ls -l "$ROOT/$OUT"/mgu-gfx-wasm.*
