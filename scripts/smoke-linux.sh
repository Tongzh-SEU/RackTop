#!/usr/bin/env bash
set -euo pipefail

APP_PATH="$(realpath "${1:?Usage: smoke-linux.sh /path/to/racktop}")"
TEST_DATA="$(mktemp -d)"
export XDG_DATA_HOME="$TEST_DATA/data"
export XDG_CONFIG_HOME="$TEST_DATA/config"
export XDG_CACHE_HOME="$TEST_DATA/cache"
APP_PID=""
cleanup() {
  if [ -n "$APP_PID" ]; then
    kill "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
  fi
  rm -rf "$TEST_DATA"
}
trap cleanup EXIT

"$APP_PATH" > "$TEST_DATA/app.log" 2>&1 &
APP_PID=$!
DATABASE_PATH="$XDG_DATA_HOME/com.racktop.desktop/racktop.sqlite"
for attempt in $(seq 1 30); do
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "RackTop exited before creating its database." >&2
    cat "$TEST_DATA/app.log"
    exit 1
  fi
  if [ -s "$DATABASE_PATH" ]; then
    break
  fi
  sleep 1
done
if [ ! -s "$DATABASE_PATH" ]; then
  echo "RackTop stayed alive but did not create its database at $DATABASE_PATH." >&2
  find "$TEST_DATA" -maxdepth 5 -type f -print >&2
  cat "$TEST_DATA/app.log"
  exit 1
fi
for attempt in 1 2; do
  timeout 10 "$APP_PATH"
  kill -0 "$APP_PID"
done
echo 'Linux startup, database creation, and repeated launch passed.'
