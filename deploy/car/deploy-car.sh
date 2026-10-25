#!/bin/sh
# ============================================================================
# deploy-car.sh - install the custom apps on a real BMW MGU head unit,
#                 persistently, with a full backup and a one-command restore.
#
# Copy this whole folder to the unit (USB stick or push-to-car.sh) and run as
# root from inside it:
#
#   sh deploy-car.sh check      dry run: checks the unit, lists every file that
#                               would be touched, test-builds the MainApp patch.
#                               Changes nothing.
#   sh deploy-car.sh install    1. backs up EVERY file it is going to touch and
#                                  verifies the backup (aborts if it can't)
#                               2. enables the custom-app provisioning hook,
#                                  persistent across reboots
#                               3. installs/updates every apps/*.mgu
#                               4. restarts the app platform once and verifies
#   sh deploy-car.sh restore    puts every touched file back exactly as it was
#                               before the FIRST install (the "stock" backup),
#                               removes the installed apps and the hook.
#   sh deploy-car.sh status     what is installed / active / backed up
#   sh deploy-car.sh backups    list backups
#
# Files this touches (and therefore backs up):
#   /var/opt/public/oap/oap_12201/security/uids.txt          app uid list
#   /var/opt/public/oap/oap_12201/data/apps/                 app registry
#   /var/opt/public/oap/oap_12201/data/custom_apps.json      (new) hook list
#   /var/opt/public/oap/_mgu_custom/                         (new) patched main.js
#   /etc/systemd/system/oapcontroller.service.d/50-mgu-custom-apps.conf  (new)
#   /var/opt/public/oap/oap_<12450 downwards>/               (new) the apps
#   /var/opt/mgu-renderd/                               (new) GPU renderer (mgu-renderd)
#   /etc/systemd/system/mgu-renderd.service                  (new) its unit, started with
#   /etc/systemd/system/oapcontroller.service.wants/mgu-renderd.service   oapcontroller
# MainApp's own /usr/lib/oap-mainapp/src/main.js is never written: the patched
# copy is bind-mounted over it at boot, and only while that file is unchanged
# (after a firmware update the hook switches itself off).
#
# Backups are kept in TWO places: ./backups/ next to this script and
# /var/opt/public/mgu_custom_backup/ on the unit. The first one ever made is the
# "stock" backup and is never overwritten; restore uses it by default.
# ============================================================================
set -u
SELF_DIR=$(cd "$(dirname "$0")" && pwd)
INSTALLER=$SELF_DIR/mgu-app-install.sh
OAP=/var/opt/public/oap
CUSTOM=$OAP/oap_12201/data/custom_apps.json
MAIN=$OAP/oap_12201
MAINJS=/usr/lib/oap-mainapp/src/main.js
DROPIN=/etc/systemd/system/oapcontroller.service.d/50-mgu-custom-apps.conf
PATCH_DIR=$OAP/_mgu_custom
NODE=${NODE:-/usr/bin/node}
BK_LOCAL=$SELF_DIR/backups
BK_UNIT=/var/opt/public/mgu_custom_backup
APP_UID_MIN=12203      # MainApp's app uid range starts here (ours are told apart below)
LOG=$SELF_DIR/deploy-car.log

# every path we may create or change (relative to /, for tar)
TOUCHED="var/opt/public/oap/oap_12201/security/uids.txt
var/opt/public/oap/oap_12201/data/apps
var/opt/public/oap/oap_12201/data/custom_apps.json
var/opt/public/oap/_mgu_custom
etc/systemd/system/oapcontroller.service.d/50-mgu-custom-apps.conf
var/opt/mgu-renderd
etc/systemd/system/mgu-renderd.service
etc/systemd/system/oapcontroller.service.wants/mgu-renderd.service"

say()  { echo "[deploy-car] $*"; echo "$(date '+%F %T') $*" >> "$LOG" 2>/dev/null; }
warn() { say "WARNING: $*"; }
die()  { say "ERROR: $*"; exit 1; }

need_root() { [ "$(id -u)" = 0 ] || die "run as root"; }

preflight() {
    need_root
    [ -d "$MAIN" ] || die "$MAIN not found - not an MGU with the OAP platform?"
    [ -f "$MAIN/security/uids.txt" ] || die "uids.txt missing"
    [ -f "$MAINJS" ] || die "$MAINJS missing"
    [ -x "$NODE" ] || die "node not found ($NODE)"
    [ -f "$INSTALLER" ] && [ -f "$SELF_DIR/mainapp-patch.js" ] || die "kit incomplete (mgu-app-install.sh / mainapp-patch.js missing)"
    for t in tar md5sum mount umount systemctl; do command -v $t >/dev/null || die "'$t' not available"; done
    systemctl is-active oapcontroller.service >/dev/null 2>&1 || warn "oapcontroller is not active right now"
    # the patch must apply to THIS firmware's MainApp (stock file, not our mount)
    src=$MAINJS
    if grep -q " $MAINJS " /proc/mounts; then src=""; fi
    if [ -n "$src" ]; then
        "$NODE" "$SELF_DIR/mainapp-patch.js" "$src" /tmp/.mgu-patch-test.js >/dev/null 2>&1 \
            && "$NODE" --check /tmp/.mgu-patch-test.js 2>/dev/null \
            || { rm -f /tmp/.mgu-patch-test.js; die "MainApp on this unit is a version the patch does not know - nothing changed"; }
        rm -f /tmp/.mgu-patch-test.js
    fi
    ls "$SELF_DIR"/apps/*.mgu >/dev/null 2>&1 || warn "no apps/*.mgu in the kit"
}

meta() {   # path [root] -> "present uid:gid:mode md5" or "absent"
    p=${2:-}/$1
    if [ -e "$p" ]; then
        own=$("$NODE" -e 'const s=require("fs").lstatSync(process.argv[1]);process.stdout.write(s.uid+":"+s.gid+":"+(s.mode&0o7777).toString(8))' "$p" 2>/dev/null || echo "?")
        if [ -f "$p" ]; then sum=$(md5sum "$p" | cut -d' ' -f1); else sum=$(cd "$p" && find . -type f | sort | xargs md5sum 2>/dev/null | md5sum | cut -d' ' -f1); fi
        echo "present $own $sum"
    else
        echo "absent"
    fi
}

# The app list (uids.txt) and the registry (data/apps) must agree and stand still,
# otherwise a backup could capture MainApp half-way through (re)installing an app
# right after boot - restoring that would make it reinstall the app under a new uid.
platform_sig() {
    U=$OAP/oap_12201/security/uids.txt R=$OAP/oap_12201/data/apps
    while IFS='=' read -r uid name || [ -n "$name" ]; do
        [ -n "$name" ] || continue
        [ -f "$R/$name.json" ] || { echo "inconsistent: $name in uids.txt has no registry entry"; return; }
    done < "$U"
    d=$(cut -d= -f2 "$U" | sort | uniq -d | head -1)
    [ -z "$d" ] || { echo "inconsistent: $d listed twice in uids.txt"; return; }
    { cat "$U"; ls "$R"; cat "$R"/*.json 2>/dev/null; } | md5sum | cut -d' ' -f1
}
wait_settled() {
    prev="" i=0
    while [ $i -lt 36 ]; do
        sig=$(platform_sig)
        case "$sig" in inconsistent*) ;; *) [ "$sig" = "$prev" ] && return 0;; esac
        [ $i = 1 ] && say "waiting for the app platform to finish starting up ($sig)..."
        prev=$sig; i=$((i + 1)); sleep 5
    done
    die "the app platform is still busy (${sig}) - try again in a few minutes; nothing changed"
}

make_backup() {   # -> sets BK (the new backup dir name)
    wait_settled
    ts=$(date +%Y%m%d-%H%M%S)
    BK=$ts
    tmp=/tmp/mgu-bk.$$
    rm -rf "$tmp"; mkdir -p "$tmp" || die "cannot create $tmp"
    present=""
    for p in $TOUCHED; do [ -e "/$p" ] && present="$present $p"; done
    # shellcheck disable=SC2086
    if [ -n "$present" ]; then tar czf "$tmp/files.tgz" -C / $present || die "backup tar failed - nothing changed"; else tar czf "$tmp/files.tgz" -T /dev/null 2>/dev/null || : > "$tmp/files.tgz"; fi
    # the manifest describes what is IN the archive (the platform may rewrite files
    # while we work, so checksums of the live files could already be different)
    mkdir -p "$tmp/x"; tar xzf "$tmp/files.tgz" -C "$tmp/x" 2>/dev/null
    : > "$tmp/manifest.txt"
    for p in $TOUCHED; do
        case " $present " in *" $p "*) m=$(meta "$p" "$tmp/x"); [ "$m" = absent ] && die "backup archive is missing /$p - nothing changed"
                                 m="present $(meta "$p" | cut -d' ' -f2) ${m##* }";;   # owner/mode: live file, checksum: archive
                               *) m=absent;; esac
        echo "$p $m" >> "$tmp/manifest.txt"
    done
    rm -rf "$tmp/x"
    ls -d "$OAP"/oap_* 2>/dev/null | sed 's#.*/##' > "$tmp/oap-dirs.txt"
    # checksum of the STOCK main.js (while the hook is mounted, md5sum would read our copy)
    if grep -q " $MAINJS " /proc/mounts && [ -f "$PATCH_DIR/stock.md5" ]; then cp "$PATCH_DIR/stock.md5" "$tmp/mainjs.md5"
    else md5sum "$MAINJS" | cut -d' ' -f1 > "$tmp/mainjs.md5"; fi
    grep " $MAINJS " /proc/mounts > "$tmp/mounts.txt" 2>/dev/null
    systemctl is-active oapcontroller.service > "$tmp/oapcontroller.txt" 2>&1
    echo "made $(date) on $(hostname 2>/dev/null)" > "$tmp/info.txt"
    # verify: the archive lists every present path
    for p in $present; do tar tzf "$tmp/files.tgz" | grep -q "^$p" || die "backup verification failed for /$p - nothing changed"; done
    for dst in "$BK_LOCAL" "$BK_UNIT"; do
        mkdir -p "$dst/$ts" && cp -p "$tmp"/* "$dst/$ts/" || die "cannot write backup to $dst - nothing changed"
        (cd "$dst/$ts" && md5sum manifest.txt files.tgz oap-dirs.txt > SUMS)
        [ -e "$dst/stock" ] || echo "$ts" > "$dst/stock"
        echo "$ts" > "$dst/latest"
    done
    rm -rf "$tmp"
    say "backup $ts written + verified ($BK_LOCAL and $BK_UNIT)"
}

find_backup() {   # $1 = name|stock|latest -> echo dir
    want=${1:-stock}
    for root in "$BK_LOCAL" "$BK_UNIT"; do
        name=$want
        [ "$want" = stock ] || [ "$want" = latest ] && name=$(cat "$root/$want" 2>/dev/null)
        d=$root/$name
        if [ -n "$name" ] && [ -f "$d/manifest.txt" ] && (cd "$d" && md5sum -c SUMS >/dev/null 2>&1); then echo "$d"; return 0; fi
    done
    return 1
}

rootfs_rw() { touch /etc/.mgu-rw-test 2>/dev/null && { rm -f /etc/.mgu-rw-test; RW_DONE=0; return 0; }; mount -o remount,rw / && RW_DONE=1; }
rootfs_ro() { [ "${RW_DONE:-0}" = 1 ] && { sync; mount -o remount,ro / 2>/dev/null; }; RW_DONE=0; }

cmd_check() {
    preflight
    say "unit looks OK. MainApp patch test-built fine."
    say "would back up and possibly change:"
    echo "$TOUCHED" | while read -r p; do echo "    /$p  ($(meta "$p" | cut -d' ' -f1))"; done
    say "would install:"; for f in "$SELF_DIR"/apps/*.mgu; do [ -f "$f" ] && echo "    $(basename "$f")"; done
    if b=$(find_backup stock); then say "stock backup present: $b"; else say "no backup yet - install will create the stock backup first"; fi
}

cmd_install() {
    preflight
    make_backup
    export BACKUP_ROOT=$BK_LOCAL/$BK/installer NO_RESTART=1
    sh "$INSTALLER" patch --persist || die "enabling the hook failed - run: sh $0 restore"
    for f in "$SELF_DIR"/apps/*.mgu; do
        [ -f "$f" ] || continue
        sh "$INSTALLER" install "$f" || die "installing $(basename "$f") failed - run: sh $0 restore"
    done
    # GPU renderer: optional - without it the apps draw in software (slower, still fine)
    if [ -f "$SELF_DIR/mgu-renderd" ]; then
        sh "$INSTALLER" renderd --persist || warn "GPU renderer not installed - apps use software rendering"
    fi
    # WITH_HMI=1: the HMI as well, in the same go - one restart that also drops the old screens and
    # tiles the HMI keeps in memory (instead of the app platform now and the HMI separately later)
    if [ "${WITH_HMI:-0}" = 1 ]; then
        say "restarting the HMI and the app platform (screen goes black, ~1-2 min)"
        systemctl restart hmi.service || warn "HMI restart failed - the old screens go at the next reboot"
        sleep 5
    else
        say "restarting the app platform (screen reloads, ~1-2 min)"
    fi
    systemctl restart oapcontroller.service
    sleep 5
    systemctl is-active oapcontroller.service >/dev/null 2>&1 || warn "oapcontroller not active after restart"
    grep -q " $MAINJS " /proc/mounts && say "hook active" || warn "hook NOT active"
    [ -f "$DROPIN" ] && say "hook persistent ($DROPIN)" || warn "drop-in missing - hook won't survive a reboot"
    sh "$INSTALLER" list
    say "done. Undo everything with: sh $0 restore"
}

cmd_restore() {
    need_root
    B=$(find_backup "${1:-stock}") || die "no valid backup '${1:-stock}' found in $BK_LOCAL or $BK_UNIT"
    say "restoring from $B"
    if [ "${YES:-0}" != 1 ]; then
        printf "This removes the custom apps and puts the files back as in that backup. Type YES: "
        read -r ans; [ "$ans" = YES ] || die "aborted"
    fi
    RW_DONE=0
    X=/tmp/mgu-restore.$$
    rm -rf "$X"; mkdir -p "$X" || die "cannot create $X"
    # busybox tar exits non-zero on harmless "Failed to set file flags" - check the content instead
    tar xzf "$B/files.tgz" -C "$X" 2>/dev/null
    while read -r p state own sum; do
        [ "$state" = present ] && { [ -e "$X/$p" ] || die "backup archive is missing /$p - nothing changed"; }
    done < "$B/manifest.txt"
    # refuse a snapshot taken while MainApp was half-way through installing an app
    XU=$X/var/opt/public/oap/oap_12201/security/uids.txt XR=$X/var/opt/public/oap/oap_12201/data/apps
    if [ -f "$XU" ] && [ -d "$XR" ]; then
        while IFS='=' read -r uid name || [ -n "$name" ]; do
            [ -n "$name" ] || continue
            [ -f "$XR/$name.json" ] || { rm -rf "$X"; die "backup $(basename "$B") was taken while the platform was busy ($name has no registry entry) - pick another one (sh deploy-car.sh backups); nothing changed"; }
        done < "$XU"
        d=$(cut -d= -f2 "$XU" | sort | uniq -d | head -1)
        [ -z "$d" ] || { rm -rf "$X"; die "backup $(basename "$B") lists $d twice - pick another one (sh deploy-car.sh backups); nothing changed"; }
    fi
    # apps that appeared after the backup: ours are removed; anything else (a BMW
    # app MainApp installed meanwhile, e.g. x_call) is kept with its uid + registry entry
    UIDS=$OAP/oap_12201/security/uids.txt REG=$OAP/oap_12201/data/apps
    RMDIRS="" KEEP=""
    mkdir -p "$X/keep"
    for d in "$OAP"/oap_*; do
        n=$(basename "$d"); u=${n#oap_}
        case "$u" in *[!0-9]*|'') continue;; esac
        [ "$u" -ge $APP_UID_MIN ] || continue
        grep -qx "$n" "$B/oap-dirs.txt" && continue
        name=$(sed -n "s/^$u=//p" "$UIDS" 2>/dev/null | head -1)
        if [ -f "$d/source/javascript/kit/app-spec.json" ] || { [ -n "$name" ] && grep -q "\"$name\"" "$CUSTOM" 2>/dev/null; }; then
            RMDIRS="$RMDIRS $d"
        elif [ -n "$name" ]; then
            KEEP="$KEEP $u=$name"
            [ -f "$REG/$name.json" ] && cp -a "$REG/$name.json" "$X/keep/"
            say "  keeping $name ($n) - not one of ours, installed by the platform after the backup"
        fi
    done
    systemctl stop oapcontroller.service
    systemctl stop mgu-renderd.service 2>/dev/null
    while grep -q " $MAINJS " /proc/mounts; do umount "$MAINJS" || die "umount failed"; done
    for d in $RMDIRS; do say "  removing $(basename "$d")"; rm -rf "$d"; done
    while read -r p state own sum; do
        case "$p" in etc/*) rootfs_rw || die "cannot remount / rw";; esac
        rm -rf "/${p:?}"
        if [ "$state" = present ]; then
            mkdir -p "$(dirname "/$p")"
            cp -a "$X/$p" "/$p" || warn "could not restore /$p"
            case "$own" in *:*:*) o=${own%:*}; m=${own##*:}; chown "$o" "/$p" 2>/dev/null; chmod "$m" "/$p" 2>/dev/null;; esac
        fi
    done < "$B/manifest.txt"
    # verify before the platform starts touching the registry again
    bad=0
    while read -r p state own sum; do
        now=$(meta "$p")
        if [ "$state" = absent ]; then [ "$now" = absent ] || { warn "/$p still present"; bad=1; }
        else [ "$(echo "$now" | cut -d' ' -f3)" = "$sum" ] || { warn "/$p differs from backup"; bad=1; }; fi
    done < "$B/manifest.txt"
    # put the kept platform apps back into the restored lists
    for kv in $KEEP; do
        # replace any older line for the same app (it may have been reinstalled under a new uid)
        grep -v "=${kv#*=}\$" "$UIDS" > "$X/uids.new"; cat "$X/uids.new" > "$UIDS"
        [ -n "$(tail -c1 "$UIDS")" ] && echo >> "$UIDS"; echo "$kv" >> "$UIDS"
        [ -f "$X/keep/${kv#*=}.json" ] && cp -a "$X/keep/${kv#*=}.json" "$REG/"
        say "  re-registered ${kv#*=}"
    done
    rm -rf "$X"
    # backups made before the renderer existed don't list its files: remove them too
    if ! grep -q "mgu-renderd" "$B/manifest.txt"; then
        for p in etc/systemd/system/mgu-renderd.service etc/systemd/system/oapcontroller.service.wants/mgu-renderd.service var/opt/mgu-renderd; do
            if [ -e "/$p" ] || [ -L "/$p" ]; then
                case "$p" in etc/*) rootfs_rw || die "cannot remount / rw";; esac
                rm -rf "/${p:?}"; say "  removed /$p"
            fi
        done
        rmdir /etc/systemd/system/oapcontroller.service.wants 2>/dev/null
    fi
    rm -f /run/systemd/system/mgu-renderd.service
    systemctl daemon-reload
    rootfs_ro
    [ "$(md5sum "$MAINJS" | cut -d' ' -f1)" = "$(cat "$B/mainjs.md5")" ] || warn "MainApp main.js differs from backup time (firmware update?)"
    # the HMI keeps the removed apps' tiles in memory until it restarts; restart just
    # the HMI (screen goes black ~30-60 s), before MainApp re-registers the real apps
    if [ "${NO_HMI_RESTART:-0}" != 1 ]; then
        say "restarting the HMI to clear the removed app tiles (screen reloads)..."
        systemctl restart hmi.service || warn "HMI restart failed - the old tiles go away at the next reboot"
    fi
    systemctl start oapcontroller.service
    [ $bad = 0 ] && say "restore complete - all files match the backup" || warn "restore finished with differences (see above)"
}

cmd_status() {
    grep -q " $MAINJS " /proc/mounts && echo "hook: active" || echo "hook: off"
    [ -f "$DROPIN" ] && echo "hook: persistent" || echo "hook: not persistent"
    echo "renderer: $(systemctl is-active mgu-renderd.service 2>/dev/null)$([ -f /etc/systemd/system/mgu-renderd.service ] && echo ', persistent')"
    [ -f "$INSTALLER" ] && sh "$INSTALLER" list
    b=$(find_backup stock) && echo "stock backup: $b" || echo "stock backup: none"
}

cmd_backups() {
    for root in "$BK_LOCAL" "$BK_UNIT"; do
        echo "$root (stock=$(cat "$root/stock" 2>/dev/null), latest=$(cat "$root/latest" 2>/dev/null)):"
        ls "$root" 2>/dev/null | grep -v '^stock$\|^latest$' | sed 's/^/    /'
    done
}

case "${1:-}" in
    check)   cmd_check ;;
    install) cmd_install ;;
    restore) cmd_restore "${2:-stock}" ;;
    status)  cmd_status ;;
    backups) cmd_backups ;;
    *) sed -n '2,40p' "$0"; exit 2 ;;
esac
