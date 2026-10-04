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
