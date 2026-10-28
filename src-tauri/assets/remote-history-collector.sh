#!/bin/sh
set -eu
umask 077

if [ "${RACKTOP_COLLECTOR_BOUNDED:-0}" != 1 ]; then
  exec timeout -k 5 60 env RACKTOP_COLLECTOR_BOUNDED=1 sh "$0"
fi

state_dir="${RACKTOP_STATE_DIR:-$HOME/.racktop}"
history_file="$state_dir/.history-v1.tsv"
usage_file="$state_dir/.usage-v1.tsv"
mkdir -p "$state_dir"
# Kernel locks are released even after SIGKILL or a reboot. Ignore the legacy directory lock.
exec 9>"$state_dir/.usage.lock"
flock -n 9 || exit 1

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

export LANG=C LC_ALL=C
racktop_probe_npu
racktop_accelerator=nvidia
if [ "$racktop_npu_status" -eq 0 ] || { ! command -v nvidia-smi >/dev/null 2>&1 && command -v npu-smi >/dev/null 2>&1; }; then racktop_accelerator=ascend; fi
query_history_gpus() {
  if [ "$racktop_accelerator" = ascend ]; then
    [ "$racktop_npu_status" -eq 0 ] || return 1
    racktop_npu_metrics | awk -F, '$3 !~ /unavailable-/ { printf "%s,%s,%s,%s\n", $3,$4,$6,$7 }'
  else
    nvidia-smi --query-gpu=uuid,utilization.gpu,memory.used,memory.total,name --format=csv,noheader,nounits 2>/dev/null
  fi
}
query_history_telemetry() {
  if [ "$racktop_accelerator" = ascend ]; then
    [ "$racktop_npu_status" -eq 0 ] || return 1
    racktop_npu_metrics | awk -F, '$3 !~ /unavailable-/ { printf "%s|%s|%s|\n", $3,$8,$9 }'
  else
    nvidia-smi --query-gpu=uuid,temperature.gpu,power.draw,fan.speed --format=csv,noheader,nounits 2>/dev/null | awk -F, '
      function trim(value) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); return value }
      function number(value) { return value ~ /^-?[0-9]+([.][0-9]+)?$/ }
      {
        uuid=trim($1); temperature=trim($2); power=trim($3); fan=trim($4)
        if (uuid == "") next
        if (!number(temperature)) temperature=""
        if (!number(power)) power=""
        if (!number(fan) || fan + 0 < 0 || fan + 0 > 100) fan=""
        printf "%s|%s|%s|%s\n", uuid,temperature,power,fan
      }
    '
  fi
}
query_history_processes() {
  if [ "$racktop_accelerator" = ascend ]; then
    [ "$racktop_npu_status" -eq 0 ] || return 1
    racktop_npu_processes | awk -F, '{ printf "%s,%s,%s\n", $1,$2,$4 }'
  else
    nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory --format=csv,noheader,nounits 2>/dev/null
  fi
}
gpu_values=""
if [ "$racktop_accelerator" = ascend ] || command -v nvidia-smi >/dev/null 2>&1; then
  gpu_sample="$state_dir/.gpu-history-sample.$$"
  telemetry_sample="$state_dir/.gpu-telemetry-sample.$$"
  occupancy_sample="$state_dir/.gpu-occupancy-sample.$$"
  : > "$gpu_sample"
  : > "$telemetry_sample"
  printf '__none__|0\n' > "$occupancy_sample"
  query_history_gpus | awk -F, '
    FILENAME != "-" {
      split($0, fields, /[[:space:]]+/)
      if (fields[1] == "MemTotal:") host_total = fields[2] + 0
      if (fields[1] == "MemAvailable:") { host_available = fields[2] + 0; has_available = 1 }
      next
    }
    {
      for (i=1; i<=NF; i++) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", $i) }
      used = $3 + 0
      total = $4 + 0
      name = tolower($5)
      unified = (name ~ /(^|[^a-z0-9])gb10([^a-z0-9]|$)/ || name ~ /(^|[^a-z0-9])dgx[[:space:]]+spark([^a-z0-9]|$)/)
      # GB10 reports N/A for framebuffer memory; CPU and GPU share host DRAM.
      if (unified && (total <= 0 || $3 !~ /^[0-9]+([.][0-9]+)?$/) && host_total > 0 && has_available) {
        available = host_available < 0 ? 0 : (host_available > host_total ? host_total : host_available)
        total = host_total / 1024
        used = (host_total - available) / 1024
      }
      memory = total > 0 ? used / total * 100 : 0
      printf "%s|%.2f|%.2f|%.2f\n", $1, $2 + 0, memory, total
    }
  ' /proc/meminfo - > "$gpu_sample" || true
  query_history_telemetry >> "$telemetry_sample" || true
  current_user="$(id -un 2>/dev/null || printf '')"
  query_history_processes | while IFS=, read -r gpu_uuid pid memory_mb; do
    gpu_uuid="$(printf '%s' "$gpu_uuid" | tr -d '[:space:]')"
    pid="$(printf '%s' "$pid" | tr -d '[:space:]')"
    memory_mb="$(printf '%s' "$memory_mb" | tr -cd '0-9.')"
    [ -n "$gpu_uuid" ] && [ -n "$pid" ] && [ -r "/proc/$pid/status" ] || continue
    username="$(ps -o user= -p "$pid" 2>/dev/null | awk '{print $1}')"
    process_name="$(ps -o comm= -p "$pid" 2>/dev/null | awk '{print tolower($1)}')"
    [ -n "$username" ] && [ "$username" != "$current_user" ] || continue
    case "$username:$process_name" in
      root:*|unknown:*|gdm:*|lightdm:*|sddm:*|*:xorg|*:xwayland|*:gnome-shell|*:nvidia-persistenced|*:nvidia-powerd|*:nvitop|*:nvtop|*:*vscode*|*:*code-server*|*:*cursor*|*:*codex*|*:*claude*|*:*tailscale*|*:*zerotier*|*:*openvpn*|*:*openconnect*|*:*wireguard*|*:*clash*|*:*mihomo*|*:*sing-box*|*:*v2ray*|*:*xray*|*:*cloudflared*) continue ;;
    esac
    printf '%s|%s\n' "$gpu_uuid" "${memory_mb:-0}" >> "$occupancy_sample"
  done
  gpu_values="$(awk -F '|' '
    FILENAME == ARGV[1] { occupied_memory[$1] += $2; next }
    FILENAME == ARGV[2] { temperature[$1]=$2; power[$1]=$3; fan[$1]=$4; next }
    {
      if (count++ > 0) printf ";"
      occupied = ($4 > 0 && occupied_memory[$1] / $4 * 100 > 3) ? 1 : 0
      printf "%s,%.2f,%.2f,%d,%s,%s,%s", $1, $2, $3, occupied, temperature[$1], power[$1], fan[$1]
    }
  ' "$occupancy_sample" "$telemetry_sample" "$gpu_sample")"
  rm -f "$gpu_sample" "$telemetry_sample" "$occupancy_sample"
fi

printf 'v3|%s|%s|%s|%s|%s\n' "$bucket" "$cpu_percent" "$memory_percent" "$swap_percent" "$gpu_values" >> "$history_file"

if [ "$racktop_accelerator" = ascend ] || command -v nvidia-smi >/dev/null 2>&1; then
  usage_tmp="$state_dir/.usage-sample.$$"
  : > "$usage_tmp"
  query_history_gpus | cut -d, -f1 | while IFS= read -r gpu_uuid; do
    gpu_uuid="$(printf '%s' "$gpu_uuid" | tr -d '[:space:]')"
    [ -n "$gpu_uuid" ] && printf '%s|%s|0|60\n' "$gpu_uuid" "__racktop_coverage__" >> "$usage_tmp"
  done
  query_history_processes | while IFS=, read -r gpu_uuid pid memory_mb; do
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
awk -F '|' -v cutoff="$cutoff" '($1 == "v1" || $1 == "v2" || $1 == "v3") && $2 >= cutoff' "$history_file" > "$temporary"
mv "$temporary" "$history_file"
if [ -r "$usage_file" ]; then
  compact_before=$((now - 7200))
  compact_before=$((compact_before - compact_before % 3600))
  usage_compact_marker="$state_dir/.usage-compacted-through-v2"
  compacted_through="$(cat "$usage_compact_marker" 2>/dev/null || printf 0)"
  case "$compacted_through" in *[!0-9]*|'') compacted_through=0 ;; esac
  if [ "$compacted_through" -lt "$compact_before" ]; then
    usage_temporary="$usage_file.tmp.$$"
    protected_hours="$state_dir/.usage-minute-hours"
    [ -f "$protected_hours" ] || : > "$protected_hours"
    awk -F '|' -v cutoff="$cutoff" -v compact_before="$compact_before" '
      FILENAME == ARGV[1] { if ($1 >= cutoff-3600) protected[$1]=1; next }
      ($1 == "v1" || $1 == "v2") && $2 >= cutoff {
        if ($2 < compact_before && !protected[$2-$2%3600]) {
          hour=$2-$2%3600; key=hour FS $3 FS $4
          active[key]+=$5; memory[key]+=$6; coverage[key]+=$7
        } else print
      }
      END {
        for (key in active) {
          split(key,a,FS)
          printf "v2|%d|%s|%s|%d|%.2f|%d\n",a[1],a[2],a[3],active[key],memory[key],coverage[key]
        }
      }
    ' "$protected_hours" "$usage_file" > "$usage_temporary"
    mv "$usage_temporary" "$usage_file"
    printf '%s\n' "$compact_before" > "$usage_compact_marker"
  fi
fi
