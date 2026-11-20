#!/bin/sh
# Controller gate (mgu-inputgate): boot guard for mgu-inputgate.so in the HMI, installed by mgu-deploy from
# idrive7-apps' kit/renderd/inputgate/tool (as the Store's preload tools; the same as deploy/mgu-app-install.sh inputgate).
# The HMI: Hmi8 (hmi8.service) on iDrive 8, HmiMain3D (hmi.service) on iDrive 7.
if [ ! -e /usr/bin/HmiMain3D ] && [ -e /usr/bin/Hmi8 ]; then UNIT=hmi8.service; PROC=Hmi8; else UNIT=hmi.service; PROC=HmiMain3D; fi
D=/var/opt/mgu-inputgate; SO=$D/current/mgu-inputgate.so; RUN=/run/mgu-inputgate.env; N=$D/strikes; MAX=2
n=$(cat "$N" 2>/dev/null); case "$n" in ''|*[!0-9]*) n=0;; esac
# a version installed since the count was kept starts it again
v=$(readlink "$D/current" 2>/dev/null)
if [ "$(cat "$D/strikes.version" 2>/dev/null)" != "$v" ]; then n=0; echo 0 > "$N"; echo "$v" > "$D/strikes.version"; fi
other_preload() {   # the HMI's LD_PRELOAD libraries without ours: the unit's Environment= lines and the files its
                    # other drop-ins read (EnvironmentFile=, another preload tool's /run/<id>.env), so both load
    systemctl cat $UNIT --no-pager 2>/dev/null | awk '
        /^# \// { ours = index($0, "mgu-inputgate") > 0; next }
        ours { next }
        /^[ \t]*Environment=/ && index($0, "LD_PRELOAD=") {
            v = substr($0, index($0, "LD_PRELOAD=") + 11)
            q = index(v, "\""); if (q) v = substr(v, 1, q - 1)
            print "lib " v
        }
        /^[ \t]*EnvironmentFile=/ { f = substr($0, index($0, "=") + 1); sub(/^-/, "", f); print "file " f }' |
    while read -r kind v; do
        if [ "$kind" = file ]; then
            [ -f "$v" ] && sed -n 's/^[ \t]*LD_PRELOAD=//p' "$v" | tr -d '"'
        else
            echo "$v"
        fi
    done | tr ':' ' ' | tr ' ' '\n' | grep -v '^$' | grep -v 'mgu-inputgate' | awk '!seen[$0]++' | tr '\n' ' ' | sed 's/ $//'
}
case "${1:-}" in
boot)
    rm -f "$RUN"
    [ -f "$SO" ] || exit 0
    if [ "$n" -ge $MAX ]; then
        echo "mgu-inputgate left out: $PROC did not come up healthy with it $n times in a row (remove and install it again to retry)"
        exit 0
    fi
    echo $((n + 1)) > "$N"; sync
    other=$(other_preload)
    echo "LD_PRELOAD=${other:+$other }$SO" > "$RUN"
    ;;
check)   # (mgu-inputgate-check.service, after the HMI) the process has run with the library long enough
    sleep 120
    p=$(pidof $PROC 2>/dev/null | cut -d' ' -f1)
    if [ -n "$p" ] && grep -q "mgu-inputgate.so" "/proc/$p/maps" 2>/dev/null && systemctl is-active -q $UNIT; then
        up=$(cut -d. -f1 /proc/uptime); st=$(cut -d')' -f2 "/proc/$p/stat" | awk '{print $20}')
        if [ $((up - st / 100)) -ge 60 ]; then echo 0 > "$N"; sync; echo "mgu-inputgate: $PROC healthy with it"; fi
    fi
    # never exit: the head unit's lifecycle reboots the unit when a service stops
    while :; do sleep 86400; done
    ;;
esac
exit 0
