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
rm -rf "$OUT"; mkdir -p "$OUT/apps"
for id in "${APPS[@]}"; do
    python3 "$KIT/kit/tools/build.py" "$id"
    ver=$(python3 -c "import json;print(json.load(open('$KIT/apps/$id/app.json'))['version'])")
    cp "$KIT/dist/$id@$ver.mgu" "$OUT/apps/"
done
cp "$HERE/car/deploy-car.sh" "$HERE/mgu-app-install.sh" "$HERE/mainapp-patch.js" "$HERE/car/README.txt" "$OUT/"
# GPU renderer (kit/renderd, built in Docker: see kit/renderd/README.md)
RD=$KIT/kit/renderd/build/mgu-renderd
if command -v docker >/dev/null; then
    # make rebuilds only when the source changed, so a pulled update is never shipped stale
    (cd "$KIT/kit/renderd" && { docker image inspect mgu-renderd-build >/dev/null 2>&1 || docker build -t mgu-renderd-build docker; } \
        && docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/src" mgu-renderd-build make >/dev/null) \
        || echo "note: mgu-renderd build failed - using the existing binary, if any"
elif [ -f "$RD" ] && [ -n "$(find "$KIT/kit/renderd/src" -newer "$RD" -type f)" ]; then
    echo "warning: kit/renderd/src is newer than build/mgu-renderd and there's no Docker to rebuild it: shipping the old renderer"
fi
if [ -f "$RD" ]; then cp "$RD" "$OUT/mgu-renderd"; chmod 755 "$OUT/mgu-renderd"
else echo "note: no mgu-renderd build (needs Docker) - the kit installs the apps with software rendering only"; fi
chmod +x "$OUT"/*.sh
(cd "$OUT" && md5sum deploy-car.sh mgu-app-install.sh mainapp-patch.js apps/*.mgu $( [ -f mgu-renderd ] && echo mgu-renderd ) > KIT_SUMS)
tar czf "$KIT/dist/mgu-custom-apps.tar.gz" -C "$KIT/dist" mgu-custom-apps
cp "$HERE/push-to-car.ps1" "$KIT/dist/"                 # Windows: next to the .tar.gz
echo "kit: $OUT  ($(ls "$OUT/apps" | tr '\n' ' '))"
echo "     $KIT/dist/mgu-custom-apps.tar.gz"
