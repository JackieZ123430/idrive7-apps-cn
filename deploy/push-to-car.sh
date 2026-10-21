#!/bin/bash
# push-to-car.sh - copy the kit to the head unit over SSH and run a command there.
#
#   HU=root@<unit-ip> [PORT=22] deploy/push-to-car.sh check|install|restore|status
#
# The kit lands in /var/opt/mgu-custom-apps on the unit (persistent partition),
# so its backups/ folder stays on the car. Run make-car-kit.sh first.
# Without SSH: copy dist/mgu-custom-apps/ to a USB stick and on the unit run
#   cd /path/to/usb/mgu-custom-apps && sh deploy-car.sh check
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
KIT=$(dirname "$HERE")/dist/mgu-custom-apps
: "${HU:?set HU=root@<head unit address>}"
PORT=${PORT:-22}
DEST=${DEST:-/var/opt/mgu-custom-apps}
CMD=${1:-check}
[ -d "$KIT" ] || { echo "run deploy/make-car-kit.sh first"; exit 1; }
SSH=(ssh -p "$PORT" -o ConnectTimeout=10 "$HU")
# tar over ssh: the unit's busybox has no scp/sftp server in some builds
tar czf - -C "$KIT" . | "${SSH[@]}" "mkdir -p '$DEST' && tar xzf - -C '$DEST' && cd '$DEST' && md5sum -c KIT_SUMS >/dev/null && echo 'kit copied + verified'"
if [ "$CMD" = restore ]; then
    "${SSH[@]}" -t "cd '$DEST' && sh deploy-car.sh restore"     # asks to type YES
else
    "${SSH[@]}" "cd '$DEST' && sh deploy-car.sh $CMD"
fi
