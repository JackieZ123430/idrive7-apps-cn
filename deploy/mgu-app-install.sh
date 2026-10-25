#!/bin/sh
# ============================================================================
# mgu-app-install.sh - install custom OAP apps on a BMW MGU (ID7) head unit.
# Runs ON the unit (or the QEMU VM) as root. Same script for both.
#
#   sh mgu-app-install.sh install <app@ver.mgu> [...]   install or update
#   sh mgu-app-install.sh verify <app@ver.mgu> [...]    would the unit accept it? (dry run of
#                                                       step 4 below; nothing is changed)
#   sh mgu-app-install.sh uninstall <app-id> [...]
#   sh mgu-app-install.sh list                          installed apps + state
#   sh mgu-app-install.sh status <app-id>               details + recent log
#   sh mgu-app-install.sh restore [backup-dir]          undo (newest backup)
#   sh mgu-app-install.sh apply                         restart the app platform
#   sh mgu-app-install.sh patch [--persist]             enable the custom-app
#                                                       provisioning hook (see below)
#   sh mgu-app-install.sh unpatch                       back to stock MainApp
#   sh mgu-app-install.sh renderd [--persist]           install / start the GPU renderer
#                                                       (mgu-renderd next to this script)
#   sh mgu-app-install.sh renderd-remove                stop and remove it
#
# Options (env):  NO_RESTART=1  don't restart oapcontroller after changes
#                 BACKUP_ROOT=<dir>   where backups go (default next to script)
#
# What "install" does - the same layout MainApp creates for BMW's own apps
# (checked against M Laptimer on this firmware, /var/opt/public/oap/oap_12219):
#   1. backs up the app registry (uids.txt + data/apps/*.json) first
#   2. picks a free service uid from the TOP of MainApp's range (12450 down),
#      or reuses the app's uid on update. MainApp gives its own apps the LOWEST
#      free uid (12203 up) from a list it only reloads on restart, so counting
#      up from the bottom could hand both the same uid (BMW app overwrites ours)
#   3. unpacks to /var/opt/public/oap/oap_<uid>/{source,rhmiData}, links the
#      platform's native node modules, creates data/kvs/share/security
#   4. generates someipInterfaces/ + acl.json from the app's manifest.json with
#      BMW's OWN generator (extracted from MainApp) and the unit's catalog
#   5. sets owner 12201:<uid>, modes and the POSIX ACLs that let the HMI read
#      the icon/graphics (without them the tile never appears)
#   6. registers it as a PREINSTALLED, manually-started app (the same entry the
#      stock M Laptimer has), so MainApp's provisioning reconcile keeps it
#   7. lists it in oap_12201/data/custom_apps.json and restarts oapcontroller
#      so MainApp picks it up (HMI reloads once)
# Nothing outside /var/opt/public/oap is written by install/uninstall.
#
# The provisioning hook ("patch"): MainApp only shows apps that BMW's signed
# provisioning data (Telematics, ProvSigned.xml) lists as enabled. Custom apps
# are not in it, so MainApp hides them. "patch" builds a copy of MainApp's
# main.js with one fallback added - "if the provisioning data for an app is
# empty, use its entry from custom_apps.json" - and BIND-MOUNTS it over the
# stock file. Stock main.js on the read-only rootfs is not changed; a reboot
# returns to stock unless --persist (a systemd drop-in that re-applies the
# bind mount when oapcontroller starts). "unpatch" undoes both.
# ============================================================================
set -u

OAP=/var/opt/public/oap
MAIN=$OAP/oap_12201
UIDS=$MAIN/security/uids.txt
REG=$MAIN/data/apps
CUSTOM=$MAIN/data/custom_apps.json
CATALOG=/etc/oap/someip/someip-interfaces.json
MAINJS=/usr/lib/oap-mainapp/src/main.js
PATCH_DIR=$OAP/_mgu_custom
DROPIN=/etc/systemd/system/oapcontroller.service.d/50-mgu-custom-apps.conf
NODE=${NODE:-/usr/bin/node}
# GPU renderer (kit/renderd): apps draw through it at 60 fps when it runs, else in software
RENDERD_DIR=/var/opt/mgu-renderd
RENDERD_UNIT=mgu-renderd.service
APP_GID=12202          # tm_oap_app: every app has it, so they may use the renderer's socket
# MainApp's usableUidsAndGids is 12203..12450 and it allocates from the bottom;
# custom apps are allocated from the top so the two never meet.
FIRST_UID=12450
LAST_UID=12351
SELF_DIR=$(cd "$(dirname "$0")" && pwd)
BACKUP_ROOT=${BACKUP_ROOT:-$SELF_DIR/backups}
TMP=${TMPDIR:-/tmp}/mgu-app-install.$$
CHANGED=0
NEED_RESTART=0

say()  { echo "[mgu-app] $*"; }
warn() { echo "[mgu-app] WARNING: $*" >&2; }
die()  { echo "[mgu-app] ERROR: $*" >&2; rm -rf "$TMP"; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root"
[ -d "$MAIN" ] || die "$MAIN not found - is this an MGU with the OAP platform (and /var/opt/public mounted)?"
[ -f "$UIDS" ] || die "$UIDS missing"
[ -x "$NODE" ] || die "node not found at $NODE"

uid_of() {      # app id -> uid from uids.txt
    sed -n "s/^\([0-9]*\)=$1\$/\1/p" "$UIDS" | head -1
}
app_of() {      # uid -> app id
    sed -n "s/^$1=\(.*\)\$/\1/p" "$UIDS" | head -1
}
# is_ours <id> <uid>: an app this tool installed (listed in custom_apps.json or built with
# the kit). Not decided by uid: MainApp can give its own apps any uid in the range too.
is_ours() {
    [ -f "$OAP/oap_$2/source/javascript/kit/app-spec.json" ] && return 0
    [ -f "$CUSTOM" ] && grep -q "\"$1\"" "$CUSTOM"
}
free_uid() {
    u=$FIRST_UID
    while [ $u -ge $LAST_UID ]; do
        if [ -z "$(app_of $u)" ] && [ ! -e "$OAP/oap_$u" ]; then echo $u; return 0; fi
        u=$((u - 1))
    done
    return 1
}

backup() {
    ts=$(date +%Y%m%d-%H%M%S)
    B=$BACKUP_ROOT/$ts
    mkdir -p "$B" || die "cannot create backup dir $B"
    cp -p "$UIDS" "$B/uids.txt"
    tar czf "$B/registry.tgz" -C "$MAIN/data" apps 2>/dev/null
    [ -f "$CUSTOM" ] && cp -p "$CUSTOM" "$B/custom_apps.json"
    echo "$B" > "$BACKUP_ROOT/latest"
    say "backup: $B"
}

ensure_newline() {   # the stock uids.txt has no trailing newline
    [ -s "$1" ] && [ -n "$(tail -c1 "$1")" ] && echo >> "$1"
    return 0
}

set_acls() {
    top=$1; u=$2
    # same grants as BMW's apps (M Laptimer): HMI must traverse the app dir and
    # read rhmiData; the rest stays private to the app and MainApp
    setfacl -m g:hmi_resourceaccess:r-x,g:nav_oap:--x,g:sps_necema:r-x,g:dumm_oap:--x "$top" 2>/dev/null \
        || setfacl -m g:5001:r-x "$top" || warn "setfacl failed on $top"
    setfacl -R -m g:hmi_resourceaccess:rX,g:12201:rwX,g:$u:rwX "$top/rhmiData" 2>/dev/null \
        || setfacl -R -m g:5001:rX,g:12201:rwX,g:$u:rwX "$top/rhmiData" || warn "setfacl failed on rhmiData"
    find "$top/rhmiData" -type d -exec setfacl -d -m g:hmi_resourceaccess:rX,g:12201:rwX,g:$u:rwX {} \; 2>/dev/null \
        || find "$top/rhmiData" -type d -exec setfacl -d -m g:5001:rX,g:12201:rwX,g:$u:rwX {} \;
}

custom_list() {    # custom_list add|del <id>  - maintain custom_apps.json
    "$NODE" -e '
        const fs = require("fs"), f = process.argv[1], op = process.argv[2], id = process.argv[3];
        let c = {}; try { c = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) {}
        if (op === "add") c[id] = c[id] || { "-appStartType": "manually", "-userLoginRequired": "false" };
        else delete c[id];
        fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");' "$CUSTOM" "$1" "$2" || warn "could not update $CUSTOM"
    chown 12201:12201 "$CUSTOM" 2>/dev/null; chmod 660 "$CUSTOM" 2>/dev/null
}

patch_active() { grep -q " $MAINJS " /proc/mounts; }

patch_mainapp() {
    if patch_active; then say "provisioning hook already active"; else
        command -v md5sum >/dev/null || die "md5sum not found"
        mkdir -p "$PATCH_DIR"
        "$NODE" "$SELF_DIR/mainapp-patch.js" "$MAINJS" "$PATCH_DIR/main.js" || die "patch failed - MainApp left stock"
        "$NODE" --check "$PATCH_DIR/main.js" || die "patched main.js does not parse - MainApp left stock"
        # remember which stock main.js the patch was made from: the boot hook
        # only applies it while the stock file is unchanged (a firmware update
        # brings a new MainApp - an old patched copy must never cover it)
        md5sum "$MAINJS" | cut -d' ' -f1 > "$PATCH_DIR/stock.md5"
        cat > "$PATCH_DIR/apply.sh" <<APPLY
#!/bin/sh
# mgu-custom-apps: bind-mount the patched MainApp main.js (provisioning hook).
# Runs before oapcontroller starts. Skips itself if MainApp was updated.
M=$MAINJS
D=$PATCH_DIR
grep -q " \$M " /proc/mounts && exit 0
[ -f \$D/main.js ] && [ -f \$D/stock.md5 ] || exit 0
if [ "\$(md5sum \$M | cut -d' ' -f1)" = "\$(cat \$D/stock.md5)" ]; then
    mount --bind \$D/main.js \$M
else
    echo "mgu-custom-apps: MainApp changed since the patch was made - hook NOT applied (re-run: mgu-app-install.sh unpatch && patch --persist)" > /dev/kmsg 2>/dev/null
fi
exit 0
APPLY
        chown -R 0:0 "$PATCH_DIR"
        chmod 755 "$PATCH_DIR" "$PATCH_DIR/main.js" "$PATCH_DIR/apply.sh"
        sh "$PATCH_DIR/apply.sh"
        patch_active || die "bind mount failed"
        say "provisioning hook active (bind mount; reboot = stock unless --persist)"
    fi
    if [ "${1:-}" = "--persist" ]; then
        rw=0
        if ! mkdir -p "$(dirname "$DROPIN")" 2>/dev/null || ! touch "$DROPIN" 2>/dev/null; then
            mount -o remount,rw / && rw=1 && mkdir -p "$(dirname "$DROPIN")" || die "cannot write $DROPIN"
        fi
        {
            echo "# added by mgu-app-install.sh - re-applies the custom-app provisioning hook."
            echo "# remove with: sh mgu-app-install.sh unpatch"
            echo "[Service]"
            # oapcontroller runs as tm_12001; "+" runs this step as root (mount needs it), "-" ignores failures
            echo "ExecStartPre=-+/bin/sh $PATCH_DIR/apply.sh"
        } > "$DROPIN"
        sync
        systemctl daemon-reload
        [ "$rw" = 1 ] && mount -o remount,ro / 2>/dev/null
        say "persisted: $DROPIN"
    fi
    CHANGED=1
}

unpatch_mainapp() {
    while patch_active; do umount "$MAINJS" || die "umount $MAINJS failed"; done
    if [ -f "$DROPIN" ]; then
        rw=0
        rm -f "$DROPIN" 2>/dev/null || { mount -o remount,rw / && rw=1 && rm -f "$DROPIN"; }
        systemctl daemon-reload
        [ "$rw" = 1 ] && mount -o remount,ro / 2>/dev/null
    fi
    rm -rf "$PATCH_DIR"
    say "MainApp back to stock"
    CHANGED=1
}

# gen <manifest.json> <uid> <outDir>: BMW's generator; on failure only its error line, not the
# whole minified generator source node prints with it
gen() {
    "$NODE" "$TMP/oapgen/gen.js" "$CATALOG" "$1" "$2" "$3" > "$TMP/gen.log" 2>&1 && return 0
    grep -m 1 '^[A-Za-z]*Error:' "$TMP/gen.log" | cut -c 1-400 >&2 || tail -n 3 "$TMP/gen.log" >&2
    return 1
}

# verify_one <app.mgu>: would install_one's interface generation pass on this unit? Only $TMP is
# written. Returns 1 (with the generator's reason) if not.
verify_one() {
    pkg=$1
    [ -f "$pkg" ] || die "no such file: $pkg"
    rm -rf "$TMP"; mkdir -p "$TMP/out"
    tar xzf "$pkg" -C "$TMP" || die "cannot unpack $pkg"
    [ -f "$TMP/meta.json" ] && [ -f "$TMP/source/manifest.json" ] && [ -f "$TMP/oapgen/gen.js" ] \
        || die "$pkg is not an MGU app bundle"
    id=$("$NODE" -e "process.stdout.write(require('$TMP/meta.json').id)")
    ver=$("$NODE" -e "process.stdout.write(require('$TMP/meta.json').version)")
    u=$(uid_of "$id"); [ -n "$u" ] || u=$FIRST_UID
    if gen "$TMP/source/manifest.json" "$u" "$TMP/out"; then
        say "$id $ver: accepted"; rm -rf "$TMP"; return 0
    fi
    echo "[mgu-app] ERROR: $id $ver is refused by this unit (its signals in app.json, see above)" >&2
    rm -rf "$TMP"; return 1
}

install_one() {
    pkg=$1
    [ -f "$pkg" ] || die "no such file: $pkg"
    rm -rf "$TMP"; mkdir -p "$TMP"
    tar xzf "$pkg" -C "$TMP" || die "cannot unpack $pkg"
    [ -f "$TMP/meta.json" ] && [ -d "$TMP/source" ] && [ -d "$TMP/rhmiData" ] || die "$pkg is not an MGU app bundle"
    id=$("$NODE" -e "process.stdout.write(require('$TMP/meta.json').id)")
    ver=$("$NODE" -e "process.stdout.write(require('$TMP/meta.json').version)")
    case "$id" in ''|*[!a-zA-Z0-9_-]*) die "bad app id '$id'";; esac

    u=$(uid_of "$id")
    if [ -n "$u" ]; then
        say "updating $id -> $ver (uid $u)"
        is_ours "$id" "$u" || die "$id is a BMW app (uid $u); refusing to overwrite it"
        update=1
    else
        u=$(free_uid) || die "no free uid in $LAST_UID..$FIRST_UID"
        say "installing $id $ver as uid $u"
        update=0
    fi
    top=$OAP/oap_$u

    # a running instance is NOT killed: MainApp counts an unexpected exit as a
    # crash (1st: wipes the app's data, 2nd: uninstalls it). Restart the
    # platform instead, which stops apps the proper way.
    for p in $(pidof node 2>/dev/null); do
        if [ "$(awk '/^Uid/{print $2}' /proc/$p/status 2>/dev/null)" = "$u" ]; then NEED_RESTART=1; fi
    done

    mkdir -p "$top"
    rm -rf "$top/source" "$top/rhmiData" "$top/someipInterfaces"
    cp -a "$TMP/source" "$top/source" || die "copy source failed"
    cp -a "$TMP/rhmiData" "$top/rhmiData" || die "copy rhmiData failed"
    for d in data kvs share security; do mkdir -p "$top/$d"; done
    # native platform modules, linked like the installer does
    mkdir -p "$top/source/node_modules"
    for n in certmgr codings ecu nare_logging necemapaths personalization smrf-native-cpp someip wscpp-client; do
        [ -e "/usr/lib/$n.node" ] && ln -sfn "/usr/lib/$n.node" "$top/source/node_modules/$n.node"
    done
    # someipInterfaces + acl.json with BMW's generator
    mkdir -p "$top/someipInterfaces"
    if ! gen "$top/source/manifest.json" "$u" "$top/someipInterfaces"; then
        [ $update = 0 ] && rm -rf "$top"        # a new app: leave no half-installed folder behind
        die "interface generation failed for $id (see above)"
    fi

    # ownership/modes as on stock installs. data/ kvs/ share/ security/ keep what the app
    # (or the platform) put in them: on an update, chowning their contents to 12201 leaves
    # e.g. data/.joynr unwritable for the app, which then crashes on its first start.
    chown -h 12201:$u "$top" "$top/data" "$top/kvs" "$top/share" "$top/security"
    chown -Rh 12201:$u "$top/source" "$top/someipInterfaces" "$top/rhmiData"
    chmod 750 "$top" "$top/source" "$top/someipInterfaces"
    chmod 770 "$top/data" "$top/kvs" "$top/share" "$top/security" "$top/rhmiData"
    find "$top/source" -type d -exec chmod 750 {} \;
    find "$top/source" -type f -exec chmod 640 {} \;
    find "$top/someipInterfaces" -type f -exec chmod 640 {} \;
    find "$top/rhmiData" -type d -exec chmod 770 {} \;
    find "$top/rhmiData" -type f -exec chmod 660 {} \;
    # the app (uid/gid $u) writes data/ (settings, log) and rhmiData/resources
    # (its drawn graphics) through the group bits, like BMW's apps
    set_acls "$top" "$u"

    # register
    if [ $update = 0 ]; then
        NEED_RESTART=1
        ensure_newline "$UIDS"
        echo "$u=$id" >> "$UIDS"
    fi
    # (re)write the registry entry: MainApp resets the flags to false while
    # the provisioning hook is not active, so a reinstall repairs that too
    printf '{"userId":%s,"provisioningCache":{"-allowed":"true","-appStartType":"manually","-enabled":"true","-userLoginRequired":"false","-updateMechanism":"PLATFORM"},"configStateQueueIndex":null,"installationSource":"PREINSTALLED"}' "$u" > "$REG/$id.json"
    chown 12201:12201 "$REG/$id.json"; chmod 660 "$REG/$id.json"
    custom_list add "$id"
    CHANGED=1
    say "installed $id $ver -> $top"
    rm -rf "$TMP"
}

uninstall_one() {
    id=$1
    u=$(uid_of "$id")
    [ -n "$u" ] || die "$id is not installed"
    is_ours "$id" "$u" || die "$id is a BMW app (uid $u); this tool only removes apps it installed"
    sed -i "/^$u=$id\$/d" "$UIDS"
    rm -f "$REG/$id.json"
    custom_list del "$id"
    rm -rf "$OAP/oap_$u"
    CHANGED=1
    say "removed $id (uid $u)"
}

list_apps() {
    hook=off; patch_active && hook=active; [ -f "$DROPIN" ] && hook="$hook (persistent)"
    echo "provisioning hook: $hook"
    printf '%-6s %-24s %-10s %-11s %s\n' UID APP VERSION SOURCE STATE
    sed 's/\r//' "$UIDS" | while IFS='=' read -r u id || [ -n "$u" ]; do
        [ -n "$u" ] || continue
        v=$(sed -n 's/.*"version"[^"]*"\([^"]*\)".*/\1/p' "$OAP/oap_$u/source/package.json" 2>/dev/null | head -1)
        src=$(sed -n 's/.*"installationSource":"\([A-Z]*\)".*/\1/p' "$REG/$id.json" 2>/dev/null)
        st=stopped
        for p in $(pidof node 2>/dev/null); do
            [ "$(awk '/^Uid/{print $2}' /proc/$p/status 2>/dev/null)" = "$u" ] && st="running(pid $p)"
        done
        [ -d "$OAP/oap_$u" ] || st=MISSING
        printf '%-6s %-24s %-10s %-11s %s\n' "$u" "$id" "${v:--}" "${src:--}" "$st"
    done
}

status_one() {
    id=$1; u=$(uid_of "$id")
    [ -n "$u" ] || die "$id is not installed"
    list_apps | sed -n "1p;/ $id /p"
    echo "--- crash history (MainApp):"
    grep -o "\"name\":\"$id\"[^}]*" "$MAIN/data/diagOapStartStopStatus.json" 2>/dev/null | tail -5 || true
    echo "--- app log ($OAP/oap_$u/data/$id.log):"
    tail -n 25 "$OAP/oap_$u/data/$id.log" 2>/dev/null || echo "(none yet - the app writes it once started)"
}

restore() {
    B=${1:-}
    [ -n "$B" ] || B=$(cat "$BACKUP_ROOT/latest" 2>/dev/null)
    [ -n "$B" ] && [ -f "$B/uids.txt" ] || die "no backup found (looked in $BACKUP_ROOT)"
    say "restoring registry from $B"
    # remove app dirs that the backup did not know about (installed after it)
    sed 's/\r//' "$UIDS" | while IFS='=' read -r u id || [ -n "$u" ]; do
        [ -n "$u" ] || continue
        if ! grep -q "^$u=$id\$" "$B/uids.txt" && is_ours "$id" "$u"; then
            say "  removing $id (uid $u)"; rm -rf "$OAP/oap_$u"
        fi
    done
    cp -p "$B/uids.txt" "$UIDS"
    rm -rf "$MAIN/data/apps" && tar xzf "$B/registry.tgz" -C "$MAIN/data"
    if [ -f "$B/custom_apps.json" ]; then cp -p "$B/custom_apps.json" "$CUSTOM"; else rm -f "$CUSTOM"; fi
    CHANGED=1
}

renderd_unit() {   # the unit file text
    cat <<UNIT
# added by mgu-app-install.sh - GPU renderer for the custom apps (remove: sh mgu-app-install.sh renderd-remove)
[Unit]
Description=mgu-renderd (GPU renderer for custom apps)
After=winston.service
StartLimitIntervalSec=0

[Service]
# its own throwaway user: only the compositor (mgu_wayland), the GPU (video) and the apps' group
DynamicUser=yes
SupplementaryGroups=mgu_wayland video tm_oap_app
Environment=XDG_RUNTIME_DIR=/run/wayland
RuntimeDirectory=mgu-renderd
RuntimeDirectoryMode=0755
ExecStart=$RENDERD_DIR/mgu-renderd --group $APP_GID
Restart=always
RestartSec=3

[Install]
WantedBy=oapcontroller.service
UNIT
}

rootfs_rw_do() {   # run "$@" with / writable (remounts rw only if it has to)
    if "$@" 2>/dev/null; then return 0; fi
    mount -o remount,rw / || return 1
    "$@"; r=$?
    sync; mount -o remount,ro / 2>/dev/null
    return $r
}

install_renderd() {
    src=$SELF_DIR/mgu-renderd
    [ -f "$src" ] || die "mgu-renderd not found next to $0"
    # everything is put in place first and the running renderer is restarted only at the end, in
    # one step (the apps draw in software only for those few seconds); unchanged: not restarted
    same=0; cmp -s "$src" "$RENDERD_DIR/mgu-renderd" 2>/dev/null && same=1
    # a running binary can be replaced by rename: the old process keeps its copy until restarted
    mkdir -p "$RENDERD_DIR" && cp "$src" "$RENDERD_DIR/mgu-renderd.new" && mv "$RENDERD_DIR/mgu-renderd.new" "$RENDERD_DIR/mgu-renderd" || die "copy failed"
    chown -R 0:0 "$RENDERD_DIR"; chmod 755 "$RENDERD_DIR" "$RENDERD_DIR/mgu-renderd"
    if [ "${1:-}" = "--persist" ]; then
        rm -f "/run/systemd/system/$RENDERD_UNIT"
        renderd_unit > "$TMP.unit" || die "tmp"
        cmp -s "$TMP.unit" "/etc/systemd/system/$RENDERD_UNIT" || same=0
        rootfs_rw_do sh -c "cp '$TMP.unit' '/etc/systemd/system/$RENDERD_UNIT' && mkdir -p /etc/systemd/system/oapcontroller.service.wants && ln -sf '../$RENDERD_UNIT' '/etc/systemd/system/oapcontroller.service.wants/$RENDERD_UNIT'" || die "cannot write /etc/systemd/system/$RENDERD_UNIT"
        rm -f "$TMP.unit"
        say "renderer persisted (starts with the app platform)"
    else
        # runtime unit: gone after a reboot
        renderd_unit > "/run/systemd/system/$RENDERD_UNIT" || die "cannot write the runtime unit"
        same=0
    fi
    systemctl daemon-reload
    if [ $same = 1 ] && systemctl is-active -q "$RENDERD_UNIT"; then say "renderer unchanged and running"; return 0; fi
    systemctl restart "$RENDERD_UNIT" || die "renderer did not start: journalctl -u $RENDERD_UNIT"
    i=0; while [ $i -lt 10 ] && [ ! -S /run/mgu-renderd/renderd.sock ]; do sleep 1; i=$((i+1)); done
    if [ -S /run/mgu-renderd/renderd.sock ]; then say "renderer running - apps switch to it within a few seconds"
    else warn "renderer socket not up yet - see: journalctl -u $RENDERD_UNIT"; fi
}

remove_renderd() {
    systemctl stop "$RENDERD_UNIT" 2>/dev/null
    rm -f "/run/systemd/system/$RENDERD_UNIT"
    if [ -e "/etc/systemd/system/$RENDERD_UNIT" ] || [ -L "/etc/systemd/system/oapcontroller.service.wants/$RENDERD_UNIT" ]; then
        rootfs_rw_do sh -c "rm -f '/etc/systemd/system/$RENDERD_UNIT' '/etc/systemd/system/oapcontroller.service.wants/$RENDERD_UNIT'; rmdir /etc/systemd/system/oapcontroller.service.wants 2>/dev/null; true"
    fi
    systemctl daemon-reload
    rm -rf "$RENDERD_DIR"
    say "renderer removed (apps draw in software again)"
}

apply() {
    if [ "${NO_RESTART:-0}" = 1 ]; then say "NO_RESTART=1: run 'systemctl restart oapcontroller' later"; return; fi
    say "restarting the app platform (the HMI app list reloads, ~1-2 min)..."
    systemctl restart oapcontroller.service || warn "restart failed"
}

cmd=${1:-}; [ $# -gt 0 ] && shift
case "$cmd" in
    install)   [ $# -gt 0 ] || die "usage: $0 install <app.mgu>..."
               backup; for f in "$@"; do install_one "$f"; done
               patch_active || warn "provisioning hook not active: MainApp will hide the app. Run: sh $0 patch"
               if [ $NEED_RESTART = 1 ]; then apply; else say "updated in place - the new version runs on the next tile tap"; fi ;;
    verify)    [ $# -gt 0 ] || die "usage: $0 verify <app.mgu>..."
               bad=0; for f in "$@"; do verify_one "$f" || bad=1; done
               exit $bad ;;
    uninstall) [ $# -gt 0 ] || die "usage: $0 uninstall <app-id>..."
               # stop the platform first so MainApp doesn't see the app vanish
               # under it (it would try to "recover" it)
               backup; [ "${NO_RESTART:-0}" = 1 ] || systemctl stop oapcontroller.service
               for a in "$@"; do uninstall_one "$a"; done
               if [ "${NO_RESTART:-0}" = 1 ]; then apply; else say "starting the app platform..."; systemctl start oapcontroller.service; fi ;;
    list)      list_apps ;;
    status)    status_one "${1:-}" ;;
    restore)   restore "${1:-}"; apply ;;
    apply)     CHANGED=1; apply ;;
    patch)     patch_mainapp "${1:-}"; apply ;;
    unpatch)   unpatch_mainapp; apply ;;
    renderd)   install_renderd "${1:-}" ;;
    renderd-remove) remove_renderd ;;
    *) sed -n '2,19p' "$0"; exit 2 ;;
esac
