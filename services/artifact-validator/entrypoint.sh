#!/bin/sh
set -eu
# Fail closed unless per-job kernel namespaces are available.
unshare --net --mount true
exec node /app/server.mjs
