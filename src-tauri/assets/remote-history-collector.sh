#!/bin/sh
set -eu
umask 077

state_dir="$HOME/.racktop"
history_file="$state_dir/.history-v1.tsv"
lock_dir="$state_dir/.collect.lock"
mkdir -p "$state_dir"
if ! mkdir "$lock_dir" 2>/dev/null; then exit 0; fi
trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT HUP INT TERM

now="$(date +%s)"
cpu_first="$(head -n 1 /proc/stat)"
sleep 0.25
cpu_second="$(head -n 1 /proc/stat)"
cpu_percent="$(printf '%s\n%s\n' "$cpu_first" "$cpu_second" | awk '
  NR == 1 { for (i=2; i<=NF; i++) total1 += $i; idle1=$5+$6 }
  NR == 2 { for (i=2; i<=NF; i++) total2 += $i; idle2=$5+$6 }
  END { total=total2-total1; idle=idle2-idle1; printf "%.2f", total > 0 ? (1-idle/total)*100 : 0 }
')"
memory_percent="$(awk '
  /^MemTotal:/ { total=$2 }
  /^MemAvailable:/ { available=$2 }
  END { printf "%.2f", total > 0 ? (total-available)/total*100 : 0 }
' /proc/meminfo)"
swap_percent="$(awk '
  /^SwapTotal:/ { total=$2 }
  /^SwapFree:/ { free=$2 }
  END { printf "%.2f", total > 0 ? (total-free)/total*100 : 0 }
' /proc/meminfo)"

gpu_values=""
if command -v nvidia-smi >/dev/null 2>&1; then
  gpu_values="$(nvidia-smi --query-gpu=uuid,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null | awk -F, '
    BEGIN { ORS="" }
    {
      for (i=1; i<=NF; i++) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", $i) }
      if (NR > 1) printf ";"
      memory = $4 > 0 ? $3 / $4 * 100 : 0
      printf "%s,%.2f,%.2f", $1, $2 + 0, memory
    }
  ' || true)"
fi

printf 'v1|%s|%s|%s|%s|%s\n' "$now" "$cpu_percent" "$memory_percent" "$swap_percent" "$gpu_values" >> "$history_file"
cutoff=$((now - 2592000))
temporary="$history_file.tmp.$$"
awk -F '|' -v cutoff="$cutoff" '$1 == "v1" && $2 >= cutoff' "$history_file" > "$temporary"
mv "$temporary" "$history_file"
