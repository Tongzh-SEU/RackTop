#!/bin/sh
# Sourced by the installer/remover. Keep fd 6 locked through the caller's work;
# close it in spawned daemons. The lock lives outside deletable data directories.
set -eu
umask 077
endpoint="${RACKTOP_HISTORY_ENDPOINT:?}"
client="${RACKTOP_HISTORY_CLIENT:?}"
action="${RACKTOP_HISTORY_ACTION:?}"
case "$endpoint" in ''|*[!a-z0-9-]*) exit 40 ;; esac
case "$client" in ''|*[!a-f0-9]*) exit 40 ;; esac
base="$HOME/.racktop"
legacy="$base/remote-history/$endpoint"
data_state="$base/remote-history-store/$endpoint"
state="$data_state/instances/$client"
mkdir -p "$base/remote-history-locks" "$base/remote-history-store" "$base/remote-history"
exec 6>"$base/remote-history-locks/$endpoint.lock"
flock -w 10 6 || { printf '远端历史正在更新，请重试\n' >&2; exit 41; }

if [ -L "$data_state" ]; then printf '历史存储目录不能是链接\n' >&2; exit 42; fi
if [ -L "$legacy" ]; then
  [ "$(readlink "$legacy")" = "$data_state" ] || { printf '历史入口指向未知目录，已保留原数据\n' >&2; exit 42; }
elif [ -e "$legacy" ]; then
  [ -d "$legacy" ] || exit 42
  # Never replace a second directory created by an old client after unlinking.
  # Both copies remain intact; reporting an error is safer than losing a writer.
  if [ -e "$data_state" ]; then
    touch "$data_state/.legacy-reference"
    printf '检测到旧版重新创建的历史目录，已保留两份数据，暂不清理\n' >&2
    exit 42
  fi
  exec 9>"$legacy/.usage.lock"
  flock -w 10 9 || exit 41
  touch "$legacy/.legacy-reference"
  mv "$legacy" "$data_state"
  # An interruption after this move is recoverable: data and legacy pin moved
  # together, and the next invocation recreates only the compatibility link.
  exec 9>&-
fi

if [ "$action" = register ]; then
  mkdir -p "$state"
  chmod 700 "$data_state" "$state"
fi
if [ -d "$data_state" ] && [ ! -L "$legacy" ]; then ln -s "$data_state" "$legacy"; fi

# Old releases install their scripts at the shared root. Once seen, retain the
# legacy reference permanently, even after they remove the compatibility link.
if [ -d "$data_state" ] && { [ -e "$data_state/.daemon.sh" ] || [ -e "$data_state/.collector.sh" ]; }; then
  touch "$data_state/.legacy-reference"
fi

case "$action" in
  register) ;;
  disable|remove)
    if [ -r "$state/.daemon.pid" ]; then
      pid="$(cat "$state/.daemon.pid" 2>/dev/null || true)"
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o args= 2>/dev/null | grep -F "sh $state/.daemon.sh" >/dev/null 2>&1; then
        kill "$pid" 2>/dev/null || true
        sleep 1
        if kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o args= 2>/dev/null | grep -F "sh $state/.daemon.sh" >/dev/null 2>&1; then kill -KILL "$pid" 2>/dev/null || true; fi
      fi
    fi
    rm -f "$state/.daemon.pid"
    if [ "$action" = remove ]; then
      rm -rf -- "$state"
      referenced=0
      for registration in "$data_state/instances/"*; do
        if [ -d "$registration" ]; then referenced=1; break; fi
      done
      if [ -d "$data_state" ] && [ "$referenced" = 0 ] && [ ! -e "$data_state/.legacy-reference" ]; then
        # New writers also take fd 6, so the zero-reference check and deletion
        # cannot race a registration or an in-flight new collector.
        if [ -L "$legacy" ]; then rm -- "$legacy"; fi
        rm -rf -- "$data_state"
      fi
      printf '__RACKTOP_REMOTE_HISTORY_REMOVED__\n'
    else
      printf '__RACKTOP_REMOTE_HISTORY_DISABLED__\n'
    fi
    ;;
  *) exit 40 ;;
esac
