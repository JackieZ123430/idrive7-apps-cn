#!/bin/sh
# idrive7-renderd's install step (component.json postInstall, run as root from current/ at every install): the old
# GPU renderer it replaces is removed, then the HMI page template is made (mgu-render-hmi.sh --build).
# Removed: the kit installer's mgu-renderd.service (mgu-app-install.sh renderd) and its enablement, its program
# /var/opt/mgu-renderd/mgu-renderd, and the unit copies mgu-render and the iDrive7 Assistant set aside in
# /var/opt/mgu-renderd/retired/. A mgu-renderd the Store's deploy tool installed (/var/opt/mgu-renderd/current) stays.
# Nothing is stopped while the HMI runs: from the next start this renderer draws the apps.
S=${IDR_SYSTEMD:-/etc/systemd/system}
D=${IDR_OLD:-/var/opt/mgu-renderd}
cd "$(dirname "$0")" || exit 1
old=""
if [ ! -e "$D/current" ]; then
    for f in "$S/mgu-renderd.service" "$S/oapcontroller.service.wants/mgu-renderd.service" "$S/multi-user.target.wants/mgu-renderd.service"; do
        { [ -e "$f" ] || [ -L "$f" ]; } && old="$old $f"
    done
    [ -f "$D/mgu-renderd" ] && old="$old $D/mgu-renderd"
fi
[ -d "$D/retired" ] && old="$old $D/retired"
if [ -n "$old" ]; then
    RW=0
    if ! { touch "$S/.idrive7-rw" 2>/dev/null && rm -f "$S/.idrive7-rw"; }; then
        mount -o remount,rw / && RW=1 || echo "idrive7-renderd: the old renderer stays (root file system not writable)"
    fi
    for f in $old; do
        rm -rf "$f" 2>/dev/null && echo "idrive7-renderd: removed the old renderer's $f"
    done
    sync
    [ $RW = 1 ] && mount -o remount,ro / 2>/dev/null
    systemctl daemon-reload 2>/dev/null
fi
exec sh ./mgu-render-hmi.sh --build "$@"
