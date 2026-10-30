#!/bin/bash
# push-to-car.sh - copy the kit to the head unit over SSH and run a command there.
#
#   HU=root@<unit-ip> [PORT=22] [KEY=path/to/key] deploy/push-to-car.sh check|install|restore|status
#
# KEY = SSH private key file (chmod 600). Without KEY/PORT, ssh uses your
# ~/.ssh/config and agent as usual (so HU=<Host alias> works too).
# The kit lands in /var/opt/mgu-custom-apps on the unit (persistent partition),
# so its backups/ folder stays on the car. Run make-car-kit.sh first.
# Without SSH: copy dist/mgu-custom-apps/ to a USB stick and on the unit run
#   cd /path/to/usb/mgu-custom-apps && sh deploy-car.sh check
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
KIT=${KIT:-$(dirname "$HERE")/dist/mgu-custom-apps}   # Chinese kit: KIT=dist/mgu-custom-apps-zh-CN
: "${HU:?set HU=root@<head unit address>}"
DEST=${DEST:-/var/opt/mgu-custom-apps}
CMD=${1:-check}
[ -d "$KIT" ] || { echo "run deploy/make-car-kit.sh first"; exit 1; }
SSH=(ssh -o ConnectTimeout=10)
[ -n "${PORT:-}" ] && SSH+=(-p "$PORT")
if [ -n "${KEY:-}" ]; then
    [ -r "$KEY" ] || { echo "KEY: cannot read $KEY"; exit 1; }
    perm=$(stat -c %a "$KEY" 2>/dev/null || stat -f %Lp "$KEY")
    case "$perm" in *00) ;; *) echo "KEY: $KEY is mode $perm - ssh ignores keys others can read. Run: chmod 600 '$KEY'"; exit 1;; esac
    SSH+=(-i "$KEY" -o IdentitiesOnly=yes)
fi
SSH+=("$HU")
# remote commands start with LC_ALL=C: ssh sends the Mac's LANG/LC_*, which the unit lacks ("Failed to set default locale")
# tar over ssh: the unit's busybox has no scp/sftp server in some builds
# apps/ is replaced, not merged: old .mgu files left there would be installed too (old, then new)
# macOS tar (bsdtar) adds extended attributes (com.apple.provenance, ...) the unit's tar cannot restore
TAR=(tar czf -)
case $(tar --version 2>/dev/null) in *bsdtar*) TAR+=(--no-xattrs --no-mac-metadata --no-acls) ;; esac
COPYFILE_DISABLE=1 "${TAR[@]}" -C "$KIT" . | "${SSH[@]}" "export LC_ALL=C; mkdir -p '$DEST' && rm -rf '$DEST/apps' && tar xzf - -C '$DEST' && cd '$DEST' && md5sum -c KIT_SUMS >/dev/null && echo 'kit copied + verified'"
if [ "$CMD" = restore ]; then
    "${SSH[@]}" -t "export LC_ALL=C; cd '$DEST' && sh deploy-car.sh restore"     # asks to type YES
else
    "${SSH[@]}" "export LC_ALL=C; cd '$DEST' && sh deploy-car.sh $CMD"
fi
