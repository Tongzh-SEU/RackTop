#!/bin/sh
set -eu
umask 077

state_dir="$HOME/.racktop"
pid_file="$state_dir/.daemon.pid"
collector="$state_dir/.collector.sh"
mkdir -p "$state_dir"

if [ -r "$pid_file" ]; then
  existing_pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then exit 0; fi
fi

printf '%s\n' "$$" > "$pid_file"
cleanup() { rm -f "$pid_file"; }
trap cleanup EXIT HUP INT TERM

while :; do
  "$collector" || true
  sleep 60
done
