#!/bin/sh

racktop_legacy_process_snapshot() {
  racktop_legacy_daemon="$1"
  racktop_legacy_collector="$2"
  racktop_legacy_uid="$(id -u)"
  racktop_process_list="$(ps -ww -u "$racktop_legacy_uid" -o pid=,ppid=,stat=,args= 2>/dev/null)" || return 2
  printf '%s\n' "$racktop_process_list" |
    awk -v daemon="$racktop_legacy_daemon" -v collector="$racktop_legacy_collector" '
      function ends_with_path(args, path, offset) {
        if (path == "") return 0
        offset = length(args) - length(path)
        return offset > 0 && substr(args, offset + 1) == path && substr(args, offset, 1) == " "
      }
      {
        pid = $1
        parent[pid] = $2
        state[pid] = $3
        args = $4
        for (field = 5; field <= NF; field++) args = args " " $field
        if ((ends_with_path(args, daemon) || ends_with_path(args, collector)) &&
            args ~ /(^|[[:space:]])(sh|bash|dash|ksh)[[:space:]]/) {
          depth[pid] = 0
        }
      }
      END {
        for (pass = 0; pass < 256; pass++) {
          changed = 0
          for (pid in parent) {
            if (!(pid in depth) && (parent[pid] in depth)) {
              depth[pid] = depth[parent[pid]] + 1
              changed = 1
            }
          }
          if (!changed) break
        }
        for (pid in depth) printf "%d %s %s\n", depth[pid], pid, state[pid]
      }
    '
}

racktop_stop_legacy_daemons() {
  racktop_legacy_daemon="$1"
  racktop_legacy_collector="$2"

  while :; do
    racktop_snapshot="$(racktop_legacy_process_snapshot "$racktop_legacy_daemon" "$racktop_legacy_collector")" || return 1
    [ -n "$racktop_snapshot" ] || return 0
    if printf '%s\n' "$racktop_snapshot" | awk '$3 ~ /^D/ { found = 1 } END { exit !found }'; then
      return 1
    fi
    racktop_now="$(date +%s 2>/dev/null)" || return 1
    case "$racktop_now" in ''|*[!0-9]*) return 1 ;; esac
    [ "$racktop_now" -lt "$racktop_cleanup_deadline" ] || return 1

    racktop_deepest="$(printf '%s\n' "$racktop_snapshot" | awk 'BEGIN { depth = 0 } $1 > depth { depth = $1 } END { print depth }')"
    racktop_pids="$(printf '%s\n' "$racktop_snapshot" | awk -v depth="$racktop_deepest" '$1 == depth { print $2 }')"
    [ -n "$racktop_pids" ] || return 1
    # Stop collector children before their daemon parent.
    for racktop_pid in $racktop_pids; do
      kill -TERM "$racktop_pid" 2>/dev/null || true
    done
    sleep 1
  done
}

racktop_cleanup_legacy_daemons() {
  [ "$(( $# % 2 ))" -eq 0 ] || return 1
  racktop_cleanup_started="$(date +%s 2>/dev/null)" || return 1
  case "$racktop_cleanup_started" in ''|*[!0-9]*) return 1 ;; esac
  racktop_cleanup_deadline=$((racktop_cleanup_started + 8))
  while [ "$#" -gt 0 ]; do
    racktop_stop_legacy_daemons "$1" "$2" || return 1
    shift 2
  done
  return 0
}
