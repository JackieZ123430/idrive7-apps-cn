#!/bin/bash
# make-car-kit.sh - build the apps and pack everything the head unit needs into
# one folder (+ .tar.gz) for a USB stick or push-to-car.sh.
#
#   deploy/make-car-kit.sh                 # all apps in apps/
#   deploy/make-car-kit.sh car_vitals ...  # only these
#
# Output: dist/mgu-custom-apps/  and  dist/mgu-custom-apps.tar.gz
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
KIT=$(dirname "$HERE")
OUT=$KIT/dist/mgu-custom-apps
APPS=("$@")
if [ ${#APPS[@]} -eq 0 ]; then
    for d in "$KIT"/apps/*/; do [ -f "$d/app.json" ] && APPS+=("$(basename "$d")"); done
fi
# GPU renderer (kit/renderd, built in Docker: see kit/renderd/README.md)
RD=$KIT/kit/renderd/build/mgu-renderd
# can't build a current renderer: say why and what the kit would ship instead, then ask.
# Not on a terminal (scripts, CI): no question, it goes on with the warning.
renderd_ask() {
    echo
    echo "!! $1"
    if [ -f "$RD" ] && [ -n "$(find "$KIT/kit/renderd/src" -newer "$RD" -type f)" ]; then
        echo "!! The kit would ship the existing build/mgu-renderd, which is OLDER than the source."
    elif [ -f "$RD" ]; then echo "!! The kit would ship the existing build/mgu-renderd (it matches the source)."
    else echo "!! The kit would ship no renderer: the apps then draw in software (PNG, a few fps)."; fi
    if [ -t 0 ]; then
        read -r -p "Continue anyway? [y/N] " a
        case "$a" in y|Y|yes|YES) ;; *) echo "stopped - nothing was built or packed"; exit 1 ;; esac
    else
        echo "!! (not a terminal: continuing)"
    fi
}
if command -v docker >/dev/null; then
    # make rebuilds only when the source changed, so a pulled update is never shipped stale.
    # Always x86-64 (the head unit's CPU), also on ARM machines (Apple Silicon: emulated)
    log=$(mktemp)
    if ! (cd "$KIT/kit/renderd" && { docker image inspect mgu-renderd-build >/dev/null 2>&1 || docker build --platform linux/amd64 -t mgu-renderd-build docker; } \
            && docker run --rm --platform linux/amd64 -u "$(id -u):$(id -g)" -v "$PWD:/src" mgu-renderd-build make) > "$log" 2>&1; then
        tail -n 15 "$log"; rm -f "$log"
        renderd_ask "The mgu-renderd build failed (output above)."
    fi
    rm -f "$log"
elif [ ! -f "$RD" ]; then
    renderd_ask "Docker isn't installed, so mgu-renderd can't be built (see kit/renderd/README.md)."
elif [ -n "$(find "$KIT/kit/renderd/src" -newer "$RD" -type f)" ]; then
    renderd_ask "kit/renderd/src is newer than build/mgu-renderd, and Docker isn't installed to rebuild it."
fi
rm -rf "$OUT"; mkdir -p "$OUT/apps"
for id in "${APPS[@]}"; do
    python3 "$KIT/kit/tools/build.py" "$id"
    ver=$(python3 -c "import json;print(json.load(open('$KIT/apps/$id/app.json'))['version'])")
    cp "$KIT/dist/$id@$ver.mgu" "$OUT/apps/"
done
cp "$HERE/car/deploy-car.sh" "$HERE/mgu-app-install.sh" "$HERE/mainapp-patch.js" "$HERE/car/README.txt" "$OUT/"
if [ -f "$RD" ]; then cp "$RD" "$OUT/mgu-renderd"; chmod 755 "$OUT/mgu-renderd"
else echo "note: no mgu-renderd build (needs Docker) - the kit installs the apps with software rendering only"; fi
chmod +x "$OUT"/*.sh
(cd "$OUT" && md5sum deploy-car.sh mgu-app-install.sh mainapp-patch.js apps/*.mgu $( [ -f mgu-renderd ] && echo mgu-renderd ) > KIT_SUMS)
tar czf "$KIT/dist/mgu-custom-apps.tar.gz" -C "$KIT/dist" mgu-custom-apps
cp "$HERE/push-to-car.ps1" "$KIT/dist/"                 # Windows: next to the .tar.gz
echo "kit: $OUT  ($(ls "$OUT/apps" | tr '\n' ' '))"
echo "     $KIT/dist/mgu-custom-apps.tar.gz"
