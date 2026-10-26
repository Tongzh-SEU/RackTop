#!/bin/sh
set -eu
umask 077
since="$1"
state_dir="${RACKTOP_STATE_DIR:-$HOME/.racktop}"
mkdir -p "$state_dir"
exec 9>"$state_dir/.usage.lock"
flock -w 10 9 || { printf '远端使用分布正忙，请稍后重试\n' >&2; exit 1; }
usage="$state_dir/.usage-v1.tsv"
protected="$state_dir/.usage-minute-hours"
[ -f "$usage" ] || : > "$usage"
[ -f "$protected" ] || : > "$protected"
temporary="$protected.$$"
trap 'rm -f "$temporary"' EXIT
# Once exported as minutes, keep that hour in minute form until retention expires.
# Otherwise a later hourly import would overlap previously imported minutes.
cutoff=$(($(date +%s) - 2592000 - 3600))
awk -F '|' -v since="$since" -v cutoff="$cutoff" '
  BEGIN { if (since >= cutoff) hours[since-since%3600]=1 }
  FILENAME == ARGV[1] { if ($1 >= cutoff) hours[$1]=1; next }
  $1 == "v1" && $2 >= since { hours[$2-$2%3600]=1 }
  END { for (hour in hours) print hour }
' "$protected" "$usage" > "$temporary"
mv "$temporary" "$protected"
awk -F '|' -v since="$since" '($1 == "v1" || $1 == "v2") && $2 >= since' "$usage"
