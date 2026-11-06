#!/bin/sh
# Keep the daemon lock on node-local tmpfs. RackTop homes may live on Ceph/NFS,
# where a stalled metadata operation must never be interpreted as a dead daemon.
racktop_select_daemon_lock_root() {
  racktop_uid="$(id -u)"
  racktop_lock_override="${1:-${RACKTOP_DAEMON_LOCK_DIR:-}}"
  if [ -n "$racktop_lock_override" ]; then
    racktop_lock_root="$racktop_lock_override"
    if [ -L "$racktop_lock_root" ] || [ ! -d "$racktop_lock_root" ] || [ ! -w "$racktop_lock_root" ]; then
      printf '__RACKTOP_REMOTE_HISTORY_LOCK_UNAVAILABLE__\n'
      return 2
    fi
  else
    racktop_lock_root=""
    for racktop_candidate in "/run/lock/racktop-$racktop_uid" "/dev/shm/racktop-$racktop_uid"; do
      racktop_parent="${racktop_candidate%/*}"
      [ -d "$racktop_parent" ] && [ -w "$racktop_parent" ] || continue
      racktop_lock_fs="$(stat -f -c %T "$racktop_parent" 2>/dev/null || true)"
      [ "$racktop_lock_fs" = tmpfs ] || continue
      [ ! -L "$racktop_candidate" ] || continue
      if [ ! -d "$racktop_candidate" ]; then (umask 077; mkdir "$racktop_candidate") 2>/dev/null || true; fi
      racktop_lock_owner="$(stat -c %u "$racktop_candidate" 2>/dev/null || true)"
      [ -d "$racktop_candidate" ] && [ ! -L "$racktop_candidate" ] && [ "$racktop_lock_owner" = "$racktop_uid" ] || continue
      chmod 700 "$racktop_candidate" 2>/dev/null || continue
      [ "$(stat -c %a "$racktop_candidate" 2>/dev/null || true)" = 700 ] || continue
      racktop_lock_root="$racktop_candidate"
      break
    done
    if [ -z "$racktop_lock_root" ]; then
      printf '__RACKTOP_REMOTE_HISTORY_LOCK_UNAVAILABLE__\n'
      return 2
    fi
  fi
}

racktop_acquire_install_lock() {
  racktop_select_daemon_lock_root "${1:-}" || return $?
  case "${RACKTOP_HISTORY_ENDPOINT:-}" in ''|*[!a-zA-Z0-9-]*) return 2 ;; esac
  # History migration/collectors use fd 9; keep installation serialization on
  # its own descriptor until the replacement daemon has been confirmed.
  exec 5>"$racktop_lock_root/$RACKTOP_HISTORY_ENDPOINT.install.lock" || {
    printf '__RACKTOP_REMOTE_HISTORY_LOCK_UNAVAILABLE__\n'
    return 2
  }
  if ! flock -n 5; then
    printf '__RACKTOP_REMOTE_HISTORY_LOCK_BUSY__\n'
    return 1
  fi
  return 0
}

racktop_acquire_daemon_lock() {
  racktop_select_daemon_lock_root "${1:-}" || return $?
  case "${RACKTOP_HISTORY_ENDPOINT:-}" in ''|*[!a-zA-Z0-9-]*) return 2 ;; esac
  case "${RACKTOP_HISTORY_CLIENT:-}" in ''|*[!a-f0-9]*) return 2 ;; esac
  racktop_lock_file="$racktop_lock_root/$RACKTOP_HISTORY_ENDPOINT-$RACKTOP_HISTORY_CLIENT.lock"
  exec 8>"$racktop_lock_file" || {
    printf '__RACKTOP_REMOTE_HISTORY_LOCK_UNAVAILABLE__\n'
    return 2
  }
  if ! flock -n 8; then
    printf '__RACKTOP_REMOTE_HISTORY_LOCK_BUSY__\n'
    return 1
  fi
  return 0
}

racktop_daemon_exists() {
  ps -ww -eo pid=,args= 2>/dev/null | awk -v current="$1" -v managed_root="$2" -v legacy_root="$3" '
    {
      args = $0
      sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "", args)
      if (args !~ /\/\.daemon\.sh$/) next
      if ((current != "" && index(args, current) > 0) ||
          (managed_root != "" && index(args, managed_root) > 0) ||
          (legacy_root != "" && index(args, legacy_root) > 0)) found = 1
    }
    END { exit !found }
  '
}

racktop_wait_for_daemon() {
  racktop_wait_attempts="$1"
  shift
  while [ "$racktop_wait_attempts" -gt 0 ]; do
    if racktop_daemon_exists "$@"; then return 0; fi
    sleep 1
    racktop_wait_attempts=$((racktop_wait_attempts - 1))
  done
  racktop_daemon_exists "$@"
}

racktop_report_busy_daemon_status() {
  if racktop_wait_for_daemon "${RACKTOP_DAEMON_START_WAIT_SECONDS:-5}" "$@"; then
    printf '__RACKTOP_REMOTE_HISTORY_READY__\n'
  else
    printf '__RACKTOP_REMOTE_HISTORY_STARTING__\n'
  fi
}
