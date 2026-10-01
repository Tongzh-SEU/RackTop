# Shared by live collection and the remote history collector.
racktop_probe_npu() {
  racktop_npu_status=127
  racktop_npu_info=""
  if command -v npu-smi >/dev/null 2>&1; then
    racktop_npu_info="$(npu-smi info 2>&1)" && racktop_npu_status=0 || racktop_npu_status=$?
  fi
  if [ "$racktop_npu_status" -ne 0 ]; then
    for racktop_cann_env in \
      "${ASCEND_HOME_PATH:-}/set_env.sh" \
      /usr/local/Ascend/ascend-toolkit/set_env.sh \
      /usr/local/Ascend/ascend-toolkit/latest/set_env.sh \
      /usr/local/Ascend/cann-8.5.0/set_env.sh \
      /usr/local/Ascend/cann-8.5.0-beta.1/set_env.sh
    do
      [ -r "$racktop_cann_env" ] || continue
      . "$racktop_cann_env" >/dev/null 2>&1 || true
      command -v npu-smi >/dev/null 2>&1 || continue
      racktop_npu_info="$(npu-smi info 2>&1)" && racktop_npu_status=0 || racktop_npu_status=$?
      [ "$racktop_npu_status" -eq 0 ] && break
    done
  fi
}

racktop_npu_metrics() {
  printf '%s\n' "$racktop_npu_info" | awk -F '|' '
    function trim(value) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); return value }
    /^\|/ {
      for (i=2; i<NF; i++) field[i]=trim($i)
      if (field[2] ~ /^[0-9]+[[:space:]]+/ && field[3] ~ /^(OK|Warning|Alarm|Failure)$/) {
        device=field[2]; sub(/[[:space:]].*$/, "", device)
        name=field[2]; sub(/^[0-9]+[[:space:]]+/, "", name)
        metrics=field[4]; gsub(/[[:space:]]+/, " ", metrics); split(trim(metrics), metric, " ")
        health=field[3]; power=metric[1]+0; temperature=metric[2]+0
        hugepages=metrics; sub(/^[^ ]+ +[^ ]+ +/, "", hugepages)
        next
      }
      if (field[2] ~ /^[0-9]+$/ && field[4] ~ /^(OK|Warning|Alarm|Failure)$/) {
        device=field[2]; name=field[3]; health=field[4]; power=field[5]+0; temperature=field[6]+0; hugepages=field[7]
        next
      }
      if (device == "") next
      if (field[2] ~ /^[0-9]+$/ && field[3] ~ /:/) {
        chip=field[2]; bus=field[3]; usage=field[4]
        # Tokenize slash independently: 54469/ 65536 and 54469 / 65536 are equivalent.
        gsub(/\//, " / ", usage); gsub(/[[:space:]]+/, " ", usage)
        n=split(trim(usage), memory, " ")
        core=memory[1]; used=memory[n-2]; total=memory[n]
      } else if (field[2] ~ /^[0-9]+$/ && field[3] ~ /^[0-9]+$/ && field[4] ~ /:/) {
        chip=field[3]; bus=field[4]; core=field[5]
        split(field[7], memory, "/"); used=trim(memory[1]); total=trim(memory[2])
      } else next
      if (used !~ /^[0-9]+([.][0-9]+)?$/ || total !~ /^[0-9]+([.][0-9]+)?$/ || total+0 <= 0) {
        printf "%s, Ascend %s (HBM unavailable), unavailable-NPU-%s-%s, 0, 0, 0, 0, %.2f, %.2f\n", device, name, device, chip, temperature, power
      } else {
        printf "%s, Ascend %s, NPU-%s-%s, %.2f, %.2f, %.2f, %.2f, %.2f, %.2f, , , , , , , , %s, %s, %s, %s\n", device, name, device, chip, core+0, used/total*100, used, total, temperature, power, health, bus, chip, hugepages
      }
      device=""
    }'
}

racktop_npu_processes() {
  # The summary already includes every chip and process; proc-mem returns a different text layout.
  printf '%s\n' "$racktop_npu_info" | awk -F '|' '
    function trim(value) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); return value }
    /^\|/ {
      for (i=2; i<NF; i++) field[i]=trim($i)
      if (field[2] ~ /^[0-9]+[[:space:]]+[0-9]+$/ && field[3] ~ /^[0-9]+$/ && field[5] ~ /^[0-9]+([.][0-9]+)?$/) {
        split(field[2], ids, /[[:space:]]+/)
        printf "NPU-%s-%s, %s, %s, %.2f\n", ids[1], ids[2], field[3], field[4], field[5]
      } else if (field[2] ~ /^[0-9]+$/ && field[3] ~ /^[0-9]+$/ && field[4] ~ /^[0-9]+$/ && field[6] ~ /^[0-9]+([.][0-9]+)?$/) {
        printf "NPU-%s-%s, %s, %s, %.2f\n", field[2], field[3], field[4], field[5], field[6]
      }
    }'
}
