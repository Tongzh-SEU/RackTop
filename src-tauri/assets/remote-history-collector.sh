#!/bin/sh
set -eu
umask 077

state_dir="$HOME/.racktop"
history_file="$state_dir/.history-v1.tsv"
usage_file="$state_dir/.usage-v1.tsv"
lock_dir="$state_dir/.collect.lock"
mkdir -p "$state_dir"
if ! mkdir "$lock_dir" 2>/dev/null; then exit 0; fi
trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT HUP INT TERM

now="$(date +%s)"
bucket=$((now - now % 60))
cpu_first="$(head -n 1 /proc/stat)"
sleep 0.25
cpu_second="$(head -n 1 /proc/stat)"
cpu_percent="$(printf '%s\n%s\n' "$cpu_first" "$cpu_second" | awk '
  NR == 1 { for (i=2; i<=NF; i++) total1 += $i; idle1=$5+$6 }
  NR == 2 { for (i=2; i<=NF; i++) total2 += $i; idle2=$5+$6 }
  END { total=total2-total1; idle=idle2-idle1; value=(total > 0 ? (1-idle/total)*100 : 0); printf "%.2f", value }
')"
memory_percent="$(awk '
  /^MemTotal:/ { total=$2 }
  /^MemAvailable:/ { available=$2 }
  END { value=(total > 0 ? (total-available)/total*100 : 0); printf "%.2f", value }
' /proc/meminfo)"
swap_percent="$(awk '
  /^SwapTotal:/ { total=$2 }
  /^SwapFree:/ { free=$2 }
  END { value=(total > 0 ? (total-free)/total*100 : 0); printf "%.2f", value }
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

printf 'v1|%s|%s|%s|%s|%s\n' "$bucket" "$cpu_percent" "$memory_percent" "$swap_percent" "$gpu_values" >> "$history_file"

if command -v nvidia-smi >/dev/null 2>&1; then
  usage_tmp="$state_dir/.usage-sample.$$"
  : > "$usage_tmp"
  nvidia-smi --query-gpu=uuid --format=csv,noheader,nounits 2>/dev/null | while IFS= read -r gpu_uuid; do
    gpu_uuid="$(printf '%s' "$gpu_uuid" | tr -d '[:space:]')"
    [ -n "$gpu_uuid" ] && printf '%s|%s|0|60\n' "$gpu_uuid" "__racktop_coverage__" >> "$usage_tmp"
  done
  nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory --format=csv,noheader,nounits 2>/dev/null | while IFS=, read -r gpu_uuid pid memory_mb; do
    gpu_uuid="$(printf '%s' "$gpu_uuid" | tr -d '[:space:]')"
    pid="$(printf '%s' "$pid" | tr -d '[:space:]')"
    memory_mb="$(printf '%s' "$memory_mb" | tr -cd '0-9.')"
    [ -n "$gpu_uuid" ] && [ -n "$pid" ] && [ -r "/proc/$pid/status" ] || continue
    username="$(ps -o user= -p "$pid" 2>/dev/null | awk '{print $1}')"
    process_name="$(ps -o comm= -p "$pid" 2>/dev/null | awk '{print $1}')"
    case "$username:$process_name" in
      root:*|unknown:*|gdm:*|lightdm:*|sddm:*|*:Xorg|*:Xwayland|*:gnome-shell|*:nvidia-persistenced|*:nvidia-powerd|*:nvitop|*:nvtop) continue ;;
    esac
    [ -n "$username" ] || username="其他"
    printf '%s|%s|%s|%s\n' "$gpu_uuid" "$username" "${memory_mb:-0}" 60 >> "$usage_tmp"
  done
  awk -F '|' -v now="$bucket" '{ key=$1 FS $2; memory[key]+=$3*60; active[key]=($2 == "__racktop_coverage__" ? 0 : 60); coverage[key]=$4 } END { for (key in coverage) { split(key,a,FS); printf "v1|%s|%s|%s|%d|%.2f|%d\n",now,a[1],a[2],active[key],memory[key],coverage[key] } }' "$usage_tmp" >> "$usage_file"
  rm -f "$usage_tmp"
fi
cutoff=$((now - 2592000))
temporary="$history_file.tmp.$$"
awk -F '|' -v cutoff="$cutoff" '$1 == "v1" && $2 >= cutoff' "$history_file" > "$temporary"
mv "$temporary" "$history_file"
if [ -r "$usage_file" ]; then
  usage_temporary="$usage_file.tmp.$$"
  awk -F '|' -v cutoff="$cutoff" '$1 == "v1" && $2 >= cutoff' "$usage_file" > "$usage_temporary"
  mv "$usage_temporary" "$usage_file"
fi
