#!/bin/sh
# Replays sessions through the original daemons (test/reference) and mgu-render, offscreen with Mesa's
# llvmpipe, and compares every frame byte for byte (--raw) and the last one (--out).
#   test/replay.sh BUILD_DIR      (inside the test container: make test)
# Sessions: test/sessions/<dialect>/*.bin.gz (recorded from the kits' file sinks, test/sessions/README.md) and the synthetic ones
# test/gen_sessions.js writes. Streams named bad-* must end with "bad message" and exit 1 in both
# daemons, over-* and refused-* must log the refusal and still draw, *-video must show its videos' colours
# (the frame files go to /dev/shm/mgu-video-replay-* and mgu-video-test while it runs). refused-owner names a frame file
# another uid owns: mgu-render refuses it (drawn as the original draws a refused path) and shows it to the owner.
set -u
B=$1
S=$(cd "$(dirname "$0")" && pwd)
export LIBGL_ALWAYS_SOFTWARE=1 EGL_PLATFORM=surfaceless
CF="-O2 -g0 -w -std=gnu11 -I$B/protocol"
GEN="$B/protocol/ivi-application-protocol.c $B/protocol/ivi-controller-protocol.c"
LIBS="-lwayland-client -lwayland-egl -lEGL -lGLESv2 -lm"
for d in upstream iterio; do
    cc $CF -I"$S/reference/$d" -o "$B/ref-$d" "$S"/reference/$d/*.c $GEN $LIBS || exit 1
done
W=$B/replay
rm -rf "$W"; mkdir -p "$W/synthetic"
node "$S/gen_sessions.js" "$W/synthetic" >/dev/null || exit 1
# the kit's recorded iterio/video reads mgu-video-test: the same frame file as A
cp "$W"/synthetic/mgu-video-replay-* /dev/shm/ && cp "$W/synthetic/mgu-video-replay-a" /dev/shm/mgu-video-test || exit 1
trap 'rm -f /dev/shm/mgu-video-replay-* /dev/shm/mgu-video-test' EXIT
fail=0; n=0

run() {  # daemon stream outbase -> exit status in $rc, log in outbase.log
    "$1" --replay "$2" --out "$3.pam" --raw "$3.rgba" > "$3.log" 2>&1
    rc=$?
}

# against an original daemon
compare() {  # dialect stream
    name=$(basename "$2" .bin); o=$W/$1-$name
    run "$B/ref-$1" "$2" "$o.ref"; rref=$rc
    run "$B/mgu-render" "$2" "$o.our"; rour=$rc
    n=$((n + 1))
    case $name in
    bad-*)
        if [ $rref = 1 ] && [ $rour = 1 ] && grep -q 'bad message' "$o.ref.log" && grep -q 'bad message' "$o.our.log"; then
            echo "ok   $1/$name: refused by both"
        else
            echo "FAIL $1/$name: original exit $rref, mgu-render exit $rour"; sed 's/^/     /' "$o.our.log"; fail=1
        fi
        return ;;
    esac
    if [ $rref != 0 ] || [ $rour != 0 ]; then
        echo "FAIL $1/$name: original exit $rref, mgu-render exit $rour"; sed 's/^/     /' "$o.ref.log" "$o.our.log"; fail=1; return
    fi
    case $name in *over-*|*refused-*)
        grep -q 'at most\|use .* MB already\|not a /dev/shm/mgu-video-' "$o.our.log" || { echo "FAIL $1/$name: no refusal logged"; fail=1; return; } ;;
    esac
    case $name in *-video)
        node "$S/gen_sessions.js" --check-video "$o.our.pam" > "$o.check" ||
            { echo "FAIL $1/$name: not the videos' colours"; sed 's/^/     /' "$o.check" "$o.our.log"; fail=1; return; } ;;
    esac
    if cmp -s "$o.ref.rgba" "$o.our.rgba" && cmp -s "$o.ref.pam" "$o.our.pam"; then
        frames=$(sed -n 's/.*\] I \([0-9]*\) frames.*/\1/p' "$o.our.log")
        echo "ok   $1/$name: $frames frames identical ($(sed -n 's/.*, \([a-z]*\) dialect.*/\1/p' "$o.our.log") dialect)"
    else
        echo "FAIL $1/$name: frames differ"; python3 "$S/pamdiff.py" "$o.ref.pam" "$o.our.pam"; fail=1
    fi
}

for d in upstream iterio; do
    mkdir -p "$W/recorded/$d"
    for z in "$S/sessions/$d"/*.bin.gz; do gunzip -c "$z" > "$W/recorded/$d/$(basename "$z" .gz)"; done
    for f in "$W/recorded/$d"/*.bin "$W/synthetic/$d"-*.bin; do
        [ -f "$f" ] && compare "$d" "$f"
    done
done

# native pixmaps vs the same pictures sent as iterio pictures, a native video vs the same as iterio messages, both
# through mgu-render
for k in index8 rgba video; do
    o=$W/native-$k
    run "$B/mgu-render" "$W/synthetic/native-$k.bin" "$o"; a=$rc
    run "$B/mgu-render" "$W/synthetic/native-$k-ref.bin" "$o.ref"; b=$rc
    run "$B/ref-iterio" "$W/synthetic/native-$k-ref.bin" "$o.orig"; c=$rc
    n=$((n + 1))
    if [ $a = 0 ] && [ $b = 0 ] && [ $c = 0 ] && cmp -s "$o.rgba" "$o.ref.rgba" && cmp -s "$o.rgba" "$o.orig.rgba" &&
        grep -q 'native dialect' "$o.log" && ! grep -q 'cannot open' "$o.log"; then
        if [ $k = video ]; then echo "ok   native/video: the client's video = the same as iterio messages in both daemons"
        else echo "ok   native/$k: pixmap regions + palette = the same pictures in both daemons"; fi
    else
        echo "FAIL native/$k: exits $a $b $c"; sed 's/^/     /' "$o.log"; python3 "$S/pamdiff.py" "$o.ref.pam" "$o.pam"; fail=1
    fi
done

# a frame file the app's uid does not own: refused (as the original draws iterio-refused-path), shown to its owner
cp /dev/shm/mgu-video-replay-a /dev/shm/mgu-video-replay-owner || exit 1
owner=$(id -u); other=$((owner + 1))
if [ "$owner" = 0 ]; then chown 4242 /dev/shm/mgu-video-replay-owner || exit 1; owner=4242; other=4243; fi
o=$W/refused-owner
"$B/mgu-render" --replay "$W/synthetic/refused-owner.bin" --uid $other --out "$o.pam" --raw "$o.rgba" > "$o.log" 2>&1; a=$?
"$B/mgu-render" --replay "$W/synthetic/refused-owner.bin" --uid $owner --out "$o.own.pam" --raw "$o.own.rgba" > "$o.own.log" 2>&1; b=$?
run "$B/ref-iterio" "$W/synthetic/iterio-refused-path.bin" "$o.orig"; c=$rc
n=$((n + 1))
if [ $a = 0 ] && [ $b = 0 ] && [ $c = 0 ] && grep -q "is not the app's (owner uid $owner)" "$o.log" && cmp -s "$o.rgba" "$o.orig.rgba" &&
    ! grep -q "not the app's" "$o.own.log" && ! cmp -s "$o.own.rgba" "$o.orig.rgba"; then
    echo "ok   refused-owner: another uid's frame file refused, drawn as a refused path; shown to its owner"
else
    echo "FAIL refused-owner: exits $a $b $c"; sed 's/^/     /' "$o.log" "$o.own.log"; fail=1
fi

# the two originals cannot read each other's sessions: what the dialect detection is for
run "$B/ref-iterio" "$W/recorded/upstream/doom.bin" "$W/control-iterio"; a=$rc
run "$B/ref-upstream" "$W/recorded/iterio/screen-car-data-sketches-A_dash.bin" "$W/control-upstream"; b=$rc
if [ $a = 1 ] && [ $b = 1 ]; then
    echo "ok   control: IterioDev's daemon refuses upstream's doom, upstream's refuses IterioDev's screen"
else
    echo "FAIL control: exits $a $b (expected each original to refuse the other dialect)"; fail=1
fi

echo "$n replays, $([ $fail = 0 ] && echo 'all identical' || echo 'FAILURES')"
exit $fail
