#!/bin/sh
# mgu-render-hmi-guard.sh DIR OUT - (idrive7-apps) mgu-render-hmi.sh behind a boot guard.
# Runs before the HMI (the -hmi unit). The page template is mounted into the HMI's widgets only while the HMI
# keeps coming up healthy with it: each start counts a strike in OUT/strikes, and the same HMI process running
# for a minute (checked 2 minutes after the start) clears it. Two starts in a row without that (an HMI that fails
# with the template reboots a car's head unit) and the template stays out, the stock widgets in, until it is made
# again (a new HmiMain3D or renderer version: OUT is replaced) or `mgu-app-install.sh renderd-embed` runs.
DIR=${1:-$(dirname "$0")}
OUT=${2:-$(dirname "$DIR")/hmi}
N=$OUT/strikes
MAX=2
if [ -d "$OUT" ] && ls "$OUT"/*.pbw >/dev/null 2>&1; then
    n=$(cat "$N" 2>/dev/null || echo 0)
    case $n in ''|*[!0-9]*) n=0 ;; esac
    if [ "$n" -ge $MAX ]; then
        rm -f "${MGU_RENDER_MARKER:-/run/mgu-render/hmi-template}"
        echo "mgu-render-hmi: page template left out: the HMI did not come up healthy with it $MAX times in a row"
        exit 0
    fi
    echo $((n + 1)) > "$N"
    ( sleep 60; p=$(pidof HmiMain3D | cut -d' ' -f1); sleep 60
      [ -n "$p" ] && [ "$(pidof HmiMain3D | cut -d' ' -f1)" = "$p" ] && systemctl is-active -q hmi.service && echo 0 > "$N"
    ) </dev/null >/dev/null 2>&1 &
fi
sh "$DIR/mgu-render-hmi.sh" "$DIR" "$OUT"
exit 0
