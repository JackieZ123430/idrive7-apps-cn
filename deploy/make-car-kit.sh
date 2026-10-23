#!/bin/sh
# make-car-kit.sh - build the apps and pack the car kit: dist/mgu-custom-apps(.tar.gz).
#
#   deploy/make-car-kit.sh                 # all apps in apps/
#   deploy/make-car-kit.sh car_vitals ...  # only these
#
# The work is done by kit/tools/make_kit.py (also runs on Windows: deploy\make-car-kit.cmd).
exec python3 "$(dirname "$0")/../kit/tools/make_kit.py" "$@"
