#!/bin/sh
set -e
set -u
umask 077

state_dir="${RACKTOP_CLIENT_STATE_DIR:-${RACKTOP_STATE_DIR:-$HOME/.racktop}}"
data_state_dir="${RACKTOP_STATE_DIR:-$state_dir}"
pid_file="$state_dir/.daemon.pid"
collector="$state_dir/.collector.sh"
heartbeat="$state_dir/.client-heartbeat"
mkdir -p "$state_dir"
exec 8>"$state_dir/.daemon.lock"
flock -n 8 || exit 0

if [ -r "$pid_file" ]; then
  existing_pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then exit 0; fi
fi

printf '%s\n' "$$" > "$pid_file"
cleanup() { rm -f "$pid_file"; }
trap cleanup EXIT
trap 'exit 0' HUP INT TERM

while :; do
  now="$(date +%s)"
  heartbeat_time="$(stat -c %Y "$heartbeat" 2>/dev/null || stat -f %m "$heartbeat" 2>/dev/null || printf 0)"
  case "$heartbeat_time" in *[!0-9]*|'') heartbeat_time=0 ;; esac
  # Instance collectors maintain a complete shared stream even while a client
  # is online, so offline clients (including older releases) can backfill.
  if [ -n "${RACKTOP_CLIENT_STATE_DIR:-}" ] || [ $((now - heartbeat_time)) -gt 90 ]; then
    touch "$data_state_dir/.client-heartbeat"
    RACKTOP_STATE_DIR="$data_state_dir" RACKTOP_CLIENT_STATE_DIR="$state_dir" sh "$collector" 8>&- || printf '采集失败或超过 60 秒\n' >&2
  fi
  sleep 60
done
