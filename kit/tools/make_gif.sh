#!/bin/bash
# make_gif.sh OUT.gif APP SECONDS WARMUP [clicks...]
#
# Records an app's demo drive as an animated GIF through the real GPU renderer, offline:
# preview.js draws SECONDS x 60 frames in real time (after WARMUP seconds of demo data),
# mgu-renderd --replay renders every frame, ffmpeg turns them into a 50 fps GIF (the
# fastest rate GIF players honour), 1280 px wide.
#
#   kit/tools/make_gif.sh docs/media/redline.gif redline 6 6
#   kit/tools/make_gif.sh out.gif car_vitals 6 4 BTN_PAGE BTN_PAGE BTN_PAGE   # chassis page
#
# Needs: a build (dist/<app>), the mgu-renderd-build docker image and build/mgu-renderd
# (kit/renderd/README.md), ffmpeg. BG=<1920x720 png> puts a screenshot of the HMI under it
# (status icons, back arrow); without it the see-through parts are black.
# The demo drive loops every 46 s: pull 4-17 s, hard stop 19-25 s, corners 29-43 s
# (counted from app start; preview starts drawing ~1.5 s + WARMUP in).
set -e
out=$(realpath -m "$1"); app=$2; sec=$3; warm=$4; shift 4
root=$(cd "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
node "$root/kit/tools/preview.js" "$root/dist/$app" "$tmp/png" "$@" wait="$warm" frames=$((sec * 60)) \
    --gpu "$tmp/s.bin" > "$tmp/preview.log" 2>&1
docker run --rm -u "$(id -u):$(id -g)" -v "$root/kit/renderd/build:/b" -v "$tmp:/o" mgu-renderd-build \
    /lib64/ld-linux-x86-64.so.2 /b/mgu-renderd --replay /o/s.bin --out /o/last.pam --raw /o/s.rgba
total=$(( $(stat -c %s "$tmp/s.rgba") / (1920 * 720 * 4) )); skip=$(( total - sec * 60 ))
if [ -n "$BG" ]; then bg=(-loop 1 -i "$BG"); else bg=(-f lavfi -i color=black:s=1920x720); fi
ffmpeg -v error -y "${bg[@]}" -f rawvideo -pix_fmt rgba -s 1920x720 -r 60 -i "$tmp/s.rgba" -filter_complex \
    "[1:v]trim=start_frame=$skip,setpts=PTS-STARTPTS[a];[0:v][a]overlay=0:0:shortest=1,fps=50,scale=1280:-1:flags=lanczos,split[x][y];[x]palettegen=stats_mode=diff:max_colors=220[p];[y][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle" \
    "$out"
echo "$out: $sec s, $(( $(stat -c %s "$out") / 1024 )) KiB"
