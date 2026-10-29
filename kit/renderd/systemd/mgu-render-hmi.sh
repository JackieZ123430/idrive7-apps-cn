#!/bin/sh
# mgu-render's page template in the HMI's widgets.
#   mgu-render-hmi.sh [--build] [DIR [OUT]]
# DIR holds hmi_template.js and mgu-render.conf (default: this script's directory); OUT keeps the
# template (default: hmi beside DIR, DIR being <root>/current); status.json beside OUT says how its last build went.
#
# --build (the install runs it: component.json postInstall) makes the template from the installed
# HmiMain3D for the conf's embed_surface_id, unless OUT holds it for this stamp already (that binary,
# the generator and the id: its identifier numbers belong to one HmiMain3D build) or the last build
# for this stamp failed for good (the generator found HmiMain3D lacking what the template needs). The
# generator runs at nice 19, first in line for the out-of-memory killer, for at most 120 s; any other
# failure (that limit, a signal, memory or disk) is tried again at the next install.
#   status.json: {"template": "ok" | "building" | "failed", "stamp", "reason", "retry", "problem"}
#
# Without --build (mgu-render-hmi.service, before the HMI starts) nothing is generated: when OUT holds
# the template for this stamp, a copy of bmw/widget/ plus the template (the HMI loads every *.pbw in
# its widget directories) is made in /run and mounted over it, else the stock widgets stay. Nothing on
# /mnt/dataro is written, and the copy is made afresh at each boot. The marker tells the renderer the
# template is in place for this HMI start.
# Undo: umount /mnt/dataro/data/hmi/bmw/widget
set -eu
BUILD=
if [ "${1:-}" = --build ]; then BUILD=1; shift; fi
DIR=${1:-$(dirname "$0")}
OUT=${2:-$(dirname "$DIR")/hmi}
STATUS=$(dirname "$OUT")/status.json
HMI=${MGU_RENDER_HMI:-/usr/bin/HmiMain3D}
WIDGETS=${MGU_RENDER_WIDGETS:-/mnt/dataro/data/hmi/bmw/widget}
RUN=${MGU_RENDER_RUN:-/run/mgu-render/hmi-widget}
MARKER=${MGU_RENDER_MARKER:-/run/mgu-render/hmi-template}
NODE=${MGU_RENDER_NODE:-node}
LIMIT=${MGU_RENDER_LIMIT:-120}

# A JSON string's contents: control characters dropped, \ and " escaped, at most 200 characters.
json() { printf '%s' "$1" | tr -d '\000-\037' | cut -c1-200 | sed 's/\\/\\\\/g; s/"/\\"/g'; }
# status STATE REASON RETRY
status() {
	problem=
	[ "$1" = failed ] && problem="In-page drawing unavailable: $2"
	printf '{\n"template": "%s",\n"stamp": "%s",\n"reason": "%s",\n"retry": %s,\n"problem": "%s"\n}\n' \
		"$1" "$(json "$stamp")" "$(json "$2")" "$3" "$(json "$problem")" > "$STATUS.tmp"
	mv -f "$STATUS.tmp" "$STATUS"
}
# one value of status.json as written above, without its quotes
field() { sed -n "s/^\"$1\": //p" "$STATUS" 2>/dev/null | sed 's/,$//; s/^"//; s/"$//'; }
built() { [ "$(cat "$OUT/stamp" 2>/dev/null)" = "$stamp" ] && ls "$OUT"/*.pbw >/dev/null 2>&1; }

[ -n "$BUILD" ] || rm -f "$MARKER"
if [ ! -e "$HMI" ]; then
	# iDrive 8: no HmiMain3D, no page template
	[ -z "$BUILD" ] || rm -f "$STATUS"
	exit 0
fi
id=$(sed -n 's/^[[:space:]]*embed_surface_id[[:space:]]*=[[:space:]]*\([0-9A-Fa-fx]*\).*/\1/p' \
	"$DIR/mgu-render.conf" 2>/dev/null | tail -n 1)
id=${id:-0x500}
stamp="$(stat -L -c '%s %Y' "$HMI") $(md5sum < "$DIR/hmi_template.js" | cut -d' ' -f1) $id"

if [ -n "$BUILD" ]; then
	if built; then
		[ "$(field template)" = ok ] && [ "$(field stamp)" = "$stamp" ] || status ok "" false
		echo "mgu-render-hmi: the page template is in place for this HmiMain3D"
		exit 0
	fi
	if [ "$(field template)" = failed ] && [ "$(field stamp)" = "$stamp" ] && [ "$(field retry)" = false ]; then
		echo "mgu-render-hmi: no page template for this HmiMain3D: $(field reason)"
		exit 0
	fi
	status building "" true
	NEW=$OUT.new
	rm -rf "$NEW"
	mkdir -p "$NEW"
	"$NODE" "$DIR/hmi_template.js" --hmi "$HMI" --surface-id "$id" --out "$NEW" >/dev/null 2>"$NEW/log" &
	gen=$!
	# the unit's shell has renice, not nice
	renice -n 19 -p $gen >/dev/null 2>&1 || :
	{ echo 1000 > /proc/$gen/oom_score_adj; } 2>/dev/null || :
	(
		i=0
		while [ $i -lt "$LIMIT" ] && kill -0 $gen 2>/dev/null; do sleep 1; i=$((i + 1)); done
		if kill -0 $gen 2>/dev/null; then : > "$NEW/timeout"; kill -9 $gen 2>/dev/null || :; fi
	) >/dev/null 2>&1 &
	watch=$!
	rc=0
	wait $gen || rc=$?
	wait $watch || :
	if [ $rc -eq 0 ] && ls "$NEW"/*.pbw >/dev/null 2>&1; then
		rm -f "$NEW/log"
		echo "$stamp" > "$NEW/stamp"
		rm -rf "$OUT"
		mv "$NEW" "$OUT"
		status ok "" false
		echo "mgu-render-hmi: page template made: $(cd "$OUT" && ls *.pbw)"
		exit 0
	fi
	if [ -e "$NEW/timeout" ]; then
		reason="the page template took longer than $LIMIT s"; retry=true
	elif [ $rc -gt 128 ]; then
		reason="the page template generator stopped (signal $((rc - 128)))"; retry=true
	else
		reason=$(grep -v '^[[:space:]]*$' "$NEW/log" | tail -n 1)
		reason=${reason:-the page template generator exited $rc}
		retry=true; [ $rc -eq 1 ] && retry=false
	fi
	rm -rf "$NEW"
	status failed "$reason" $retry
	echo "mgu-render-hmi: no page template: $reason" >&2
	exit 0
fi

if ! built; then
	echo "mgu-render-hmi: no page template for this HmiMain3D; the stock widgets stay"
	exit 0
fi
# our own earlier mount only (another tool's mount over the same folder stays, and is copied)
if grep -q " ${RUN#/run} $WIDGETS " /proc/self/mountinfo; then
	umount "$WIDGETS"
fi
rm -rf "$RUN"
mkdir -p "$RUN"
cp -a "$WIDGETS"/. "$RUN"/
cp "$OUT"/*.pbw "$RUN"/
mount --bind "$RUN" "$WIDGETS"
touch "$MARKER"
echo "mgu-render-hmi: $(cd "$OUT" && ls *.pbw) added to $WIDGETS"
