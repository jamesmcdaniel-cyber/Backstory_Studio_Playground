#!/bin/sh
set -eu
# The namespace has no external interfaces or routes. Its private loopback
# serves only this job's artifact and first-party runtime assets.
mount --make-rprivate /
if [ -d /.fly ]; then mount -t tmpfs -o mode=000,nosuid,nodev,noexec none /.fly; fi
ip link set lo up
exec setpriv --reuid="$1" --regid="$1" --clear-groups --no-new-privs node "$2"
