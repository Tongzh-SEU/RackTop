#!/bin/sh
# Caller holds the managed endpoint lock. Snapshot old writers under the same
# usage lock they use, plus the directory lock used by v1.25.6. Never remove a
# lock owned by another collector, even if it looks stale.
snapshot_legacy_history() {
  source_dir="$1"
  archive_dir="$2"
  [ -r "$source_dir/.history-v1.tsv" ] || [ -r "$source_dir/.usage-v1.tsv" ] || return 0
  mkdir -p "$archive_dir"
  touch "$data_state/.legacy-reference"
  (
    collect_lock="$source_dir/.collect.lock"
    attempts=0
    while ! mkdir "$collect_lock" 2>/dev/null; do
      attempts=$((attempts + 1))
      if [ "$attempts" -ge 10 ]; then
        printf '旧版远端采集正在写入或锁尚未释放，请稍后重试\n' >&2
        exit 41
      fi
      sleep 1
    done
    trap 'rmdir "$collect_lock" 2>/dev/null || true' EXIT
    trap 'exit 41' HUP INT TERM
    exec 9>"$source_dir/.usage.lock"
    flock -w 10 9 || exit 41
    if [ -f "$source_dir/.usage-v1.tsv" ]; then
      # Once a minute stream was exported, old supported compactors must keep
      # those hours as minutes too, just as the regular usage reader does.
      touch "$source_dir/.usage-minute-hours"
      awk -F '|' '
        FILENAME == ARGV[1] { hours[$1]=1; next }
        $1 == "v1" { hours[$2-$2%3600]=1 }
        END { for (hour in hours) print hour }
      ' "$source_dir/.usage-minute-hours" "$source_dir/.usage-v1.tsv" > "$source_dir/.usage-minute-hours.$$"
      mv "$source_dir/.usage-minute-hours.$$" "$source_dir/.usage-minute-hours"
    fi
    for name in .history-v1.tsv .usage-v1.tsv .usage-minute-hours; do
      if [ -f "$source_dir/$name" ]; then
        set -- "$source_dir/$name"
        if [ -f "$archive_dir/$name" ]; then set -- "$@" "$archive_dir/$name"; fi
        case "$name" in
          .history-v1.tsv)
            awk -F '|' '!seen[$2]++' "$@" > "$archive_dir/$name.$$"
            ;;
          .usage-v1.tsv)
            # Preserve old-only buckets after an old app recreates/truncates a
            # file. Keep both representations for recovery; the reader uses a
            # rollup over overlapping minutes of that same GPU/user/hour.
            awk -F '|' '
              NF == 7 && ($1 == "v1" || $1 == "v2") && $7+0 > 0 {
                key=$1 FS $2 FS $3 FS $4
                if (!(key in rows)) order[++n]=key
                if (!(key in rows) || $7+0 > coverage[key]) { rows[key]=$0; coverage[key]=$7+0 }
              }
            !(NF == 7 && ($1 == "v1" || $1 == "v2") && $7+0 > 0) {
              key="raw" FS $0
              if (!(key in rows)) { order[++n]=key; rows[key]=$0 }
            }
              END { for (i=1; i<=n; i++) print rows[order[i]] }
            ' "$@" > "$archive_dir/$name.$$"
            ;;
          *) awk '!seen[$0]++' "$@" > "$archive_dir/$name.$$" ;;
        esac
        mv "$archive_dir/$name.$$" "$archive_dir/$name"
      fi
    done
  )
}
snapshot_legacy_history "$base" "$data_state/legacy-root"
if [ ! -L "$legacy" ]; then
  snapshot_legacy_history "$legacy" "$data_state/legacy-endpoint"
fi
previous_store="$base/remote-history-store/$endpoint"
if [ ! -L "$previous_store" ]; then
  snapshot_legacy_history "$previous_store" "$data_state/legacy-store"
fi
