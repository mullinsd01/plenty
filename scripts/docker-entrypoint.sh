#!/bin/sh
# Plenty container entrypoint.
#
#   docker run <image>                  start the web server (the default)
#   docker run <image> setup            migrations + product catalog + recipe library (idempotent: run it on every deploy)
#   docker run <image> migrate          migrations only
#   docker run <image> seed             recreate the demo household (App Review)
#   docker run <image> cron             run the scheduled jobs once
#   docker run <image> check            the go-live check (check:prod)
#   docker run <image> smoke            prove the image can read receipts
#   docker run <image> <anything else>  run it as given, e.g. `node tools/setup.cjs` or `sh`
#
# PLENTY_SETUP_ON_START=true runs `setup` before the server starts. Convenient on a single server; with more than
# one instance starting at once, run `setup` as a separate step instead (docs/deploy.md).
set -eu

# Started as root (the default), fix the ownership of the receipt-photo folder, then carry on as the unprivileged
# `node` user. Volumes and bind mounts (Fly volumes, Render disks, a host folder) usually arrive owned by root, and
# the app couldn't save photos into them. Started as another user (docker run --user ...), this is skipped.
if [ "$(id -u)" = "0" ]; then
  if [ "${STORAGE_DRIVER:-local}" = "local" ]; then
    dir="${STORAGE_DIR:-/data/uploads}"
    mkdir -p "$dir" 2>/dev/null || true
    # Only when the folder isn't already node's: a recursive chown on every start would be slow with many photos.
    if [ "$(stat -c %U "$dir" 2>/dev/null || echo node)" != "node" ]; then
      chown -R node:node "$dir" 2>/dev/null || echo "Warning: couldn't give the user 'node' ownership of $dir; saving receipt photos may fail." >&2
    fi
  fi
  exec setpriv --reuid=node --regid=node --init-groups "$0" "$@"
fi

cmd="${1:-serve}"

case "$cmd" in
  serve)
    if [ "${PLENTY_SETUP_ON_START:-}" = "true" ] || [ "${PLENTY_SETUP_ON_START:-}" = "1" ]; then
      echo "PLENTY_SETUP_ON_START is on: running setup before starting the server."
      node tools/setup.cjs
    fi
    # Docker sets HOSTNAME to the container id, which would make the server listen on that one address only.
    export HOSTNAME=0.0.0.0
    exec node server.js
    ;;
  migrate | setup | seed | cron | smoke)
    shift
    exec node "tools/$cmd.cjs" "$@"
    ;;
  check)
    shift
    exec node tools/check-prod.cjs "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
