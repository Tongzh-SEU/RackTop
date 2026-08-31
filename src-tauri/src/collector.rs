use crate::models::{CpuProcessMetric, DiskMetric, GpuMetric, ManagedRunLaunchResult, ManagedRunRemoteStatus, ProcessMetric, Server, Snapshot, SystemMetric};
use crate::ssh_keys::expand_identity_path;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::{collections::{HashMap, HashSet}, process::Stdio, time::{SystemTime, UNIX_EPOCH}};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use tokio::{process::Command, time::{timeout, Duration}};

const REMOTE_SCRIPT: &str = r#"export LANG=C LC_ALL=C;
cleanup_marker="$HOME/.racktop/.cleanup-usercpu-redirection-v1";
if [ ! -e "$cleanup_marker" ]; then
  cleanup_lock="$HOME/.racktop/.cleanup-usercpu-redirection-v1.lock";
  if mkdir -p "$HOME/.racktop" && chmod 700 "$HOME/.racktop" && mkdir "$cleanup_lock" 2>/dev/null; then
    (
      trap 'rmdir "$cleanup_lock" 2>/dev/null || true' EXIT HUP INT TERM;
      cleanup_uid="$(id -u)";
      cleanup_cpu_count="$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf 0)";
      case "$cleanup_cpu_count" in
        ''|*[!0-9]*|0) ;;
        *)
          cleanup_expected="${cleanup_cpu_count}.00";
          cleanup_expected_size=$((${#cleanup_expected} + 1));
          cleanup_recovery="$HOME/.racktop/recovered-usercpu-redirection-v1";
          if mkdir -p "$cleanup_recovery" && chmod 700 "$cleanup_recovery"; then
            cleanup_complete=1;
            for cleanup_candidate in "$HOME"/*; do
              [ -f "$cleanup_candidate" ] && [ ! -L "$cleanup_candidate" ] || continue;
              cleanup_name="${cleanup_candidate##*/}";
              case "$cleanup_name" in ''|*[!0-9.]*|*.*.*|.*|*.) continue ;; esac;
              cleanup_owner="$(stat -c %u "$cleanup_candidate" 2>/dev/null || printf '')";
              cleanup_links="$(stat -c %h "$cleanup_candidate" 2>/dev/null || printf '')";
              cleanup_size="$(stat -c %s "$cleanup_candidate" 2>/dev/null || printf '')";
              [ "$cleanup_owner" = "$cleanup_uid" ] && [ "$cleanup_links" = 1 ] && [ "$cleanup_size" = "$cleanup_expected_size" ] || continue;
              [ "$(cat "$cleanup_candidate" 2>/dev/null)" = "$cleanup_expected" ] || continue;
              if [ -e "$cleanup_recovery/$cleanup_name" ]; then cleanup_complete=0; continue; fi;
              mv "$cleanup_candidate" "$cleanup_recovery/$cleanup_name" || cleanup_complete=0;
            done;
            [ "$cleanup_complete" = 1 ] && touch "$cleanup_marker";
          fi;
          ;;
      esac;
    ) </dev/null >/dev/null 2>&1 &
    cleanup_pid=$!;
    command -v renice >/dev/null 2>&1 && renice 19 -p "$cleanup_pid" >/dev/null 2>&1 || true;
    command -v ionice >/dev/null 2>&1 && ionice -c 3 -p "$cleanup_pid" >/dev/null 2>&1 || true;
  fi;
fi;
if [ "${RACKTOP_REMOTE_HISTORY:-0}" = "1" ]; then mkdir -p "$HOME/.racktop" && touch "$HOME/.racktop/.client-heartbeat"; fi;
printf '__RACKTOP_USER__\n'; id -un;
uid_min="$(awk '$1 == "UID_MIN" { print $2; exit }' /etc/login.defs 2>/dev/null)"; uid_min="${uid_min:-1000}";
printf '__RACKTOP_UIDMIN__\n%s\n' "$uid_min";
printf '__RACKTOP_HOST__\n'; hostname;
printf '__RACKTOP_OS__\n'; if [ -r /etc/os-release ]; then . /etc/os-release; printf '%s|%s\n' "${ID:-unknown}" "${PRETTY_NAME:-Linux}"; else printf 'unknown|Linux\n'; fi;
printf '__RACKTOP_CPUMODEL__\n'; if command -v lscpu >/dev/null 2>&1; then lscpu | awk -F: '/^Model name:/ {sub(/^[[:space:]]+/, "", $2); print $2; exit}'; else awk -F: '/^model name[[:space:]]*:/ {sub(/^[[:space:]]+/, "", $2); print $2; exit}' /proc/cpuinfo; fi;
printf '__RACKTOP_CPU1__\n'; head -n 1 /proc/stat;
sleep 0.25;
printf '__RACKTOP_CPU2__\n'; head -n 1 /proc/stat;
printf '__RACKTOP_LOAD__\n'; cat /proc/loadavg;
printf '__RACKTOP_MEM__\n'; grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo;
if [ "${RACKTOP_INCLUDE_DISKS:-1}" = "1" ]; then
  printf '__RACKTOP_DISK__\n';
  current_user="$(id -un)";
  home_mount="$(df -P -k "$HOME" 2>/dev/null | awk 'NR == 2 {print $6}')";
  home_used="$(du -skx "$HOME" 2>/dev/null | awk '{print $1; exit}')"; home_used="${home_used:-0}";
  if ! disk_rows="$(timeout -k 1 3 df -P -k -x tmpfs -x devtmpfs 2>/dev/null)"; then
    disk_rows="$(df -P -k -l -x tmpfs -x devtmpfs 2>/dev/null)";
  fi;
  printf '%s\n' "$disk_rows" | awk 'NR > 1 && $2 ~ /^[0-9]+$/ { print $6 "|" $3 "|" $2 "|" $4 }' | while IFS='|' read -r mount used total available; do
    case "$mount" in /sys|/sys/*|/proc|/proc/*|/dev|/dev/*|/run|/run/*|/boot/efi|/boot/efi/*|/snap/*|/var/lib/docker/*|/var/lib/containers/*|/var/lib/kubelet/*) continue ;; esac
    own=0;
    if [ "$mount" = "$home_mount" ]; then own="$home_used";
    else
      for candidate in "$mount/$current_user" "$mount/home/$current_user"; do
        if [ -d "$candidate" ]; then own="$(du -skx "$candidate" 2>/dev/null | awk '{print $1; exit}')"; own="${own:-0}"; break; fi;
      done;
    fi;
    [ "$own" -gt "$used" ] 2>/dev/null && own="$used";
    printf '%s|%s|%s|%s|%s\n' "$mount" "$used" "$total" "$available" "$own";
  done | head -n 16;
fi;
printf '__RACKTOP_USERCPU__\n'; ps -u "$(id -un)" -o pcpu= 2>/dev/null | awk -v n="$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf 1)" '{s+=$1} END {printf "%.2f\n", (n>0?s/n:s+0)}';
printf '__RACKTOP_ACCELERATOR__\n';
if command -v nvidia-smi >/dev/null 2>&1; then printf 'nvidia\n'; elif command -v npu-smi >/dev/null 2>&1; then printf 'ascend\n'; else printf 'nvidia\n'; fi;
printf '__RACKTOP_NVIDIA__\n';
if ! command -v nvidia-smi >/dev/null 2>&1 && command -v npu-smi >/dev/null 2>&1; then
  ascend_info="$(npu-smi info 2>&1)"; ascend_status=$?;
  if [ "$ascend_status" -eq 0 ]; then
    printf 'available\n';
    printf '__RACKTOP_GPU__\n';
    printf '%s\n' "$ascend_info" | awk -F '|' '
      function trim(value) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); return value }
      /^\|/ {
        for (i=2; i<NF; i++) field[i]=trim($i)
        if (field[2] ~ /^[0-9]+$/ && field[4] ~ /^(OK|Warning|Alarm|Failure)$/) {
          device=field[2]; name=field[3]; power=field[5]+0; temperature=field[6]+0; next
        }
        if (device != "" && field[2] ~ /^[0-9]+$/ && field[3] ~ /^[0-9]+$/ && field[4] ~ /:/) {
          split(field[7], memory, "/"); used=trim(memory[1])+0; total=trim(memory[2])+0;
          memory_percent=(total > 0 ? used/total*100 : 0);
          printf "%s, Ascend %s, NPU-%s-%s, %.2f, %.2f, %.2f, %.2f, %.2f, %.2f\n", device, name, device, field[2], field[5]+0, memory_percent, used, total, temperature, power
        }
      }';
  elif printf '%s\n' "$ascend_info" | grep -qi 'permission denied'; then printf 'permissionDenied\n%s\n' "$ascend_info";
  else printf 'failed\n%s\n' "$ascend_info"; fi;
elif ! command -v nvidia-smi >/dev/null 2>&1; then
  printf 'missing\n';
else
  nvidia_list="$(nvidia-smi -L 2>&1)"; nvidia_status=$?;
  if [ "$nvidia_status" -eq 0 ]; then nvidia_state=available;
  elif printf '%s\n' "$nvidia_list" | grep -q '^GPU [0-9][0-9]*:'; then nvidia_state=degraded;
  elif printf '%s\n' "$nvidia_list" | grep -qi 'permission denied'; then nvidia_state=permissionDenied;
  else nvidia_state=failed; fi;
  printf '%s\n' "$nvidia_state";
  if [ "$nvidia_state" != available ]; then printf '%s\n' "$nvidia_list"; fi;
  if [ "$nvidia_state" = available ] || [ "$nvidia_state" = degraded ]; then
    printf '__RACKTOP_GPU__\n';
    if [ "$nvidia_state" = available ]; then
      nvidia-smi --query-gpu=index,name,uuid,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>/dev/null || true;
    else
      printf '%s\n' "$nvidia_list" | sed -n 's/^GPU \([0-9][0-9]*\):.*/\1/p' | while read -r gpu_index; do
        nvidia-smi -i "$gpu_index" --query-gpu=index,name,uuid,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>/dev/null || true;
      done;
      printf '%s\n' "$nvidia_list" | awk '
        /^GPU [0-9][0-9]*:/ {
          value=$0; sub(/^GPU /, "", value); sub(/:.*/, "", value); next_index=value+1; next
        }
        /Unable to determine the device handle for gpu / {
          match($0, /gpu [0-9A-Fa-f:.]+/); bus=substr($0, RSTART+4, RLENGTH-4); sub(/:$/, "", bus);
          uuid=bus; gsub(/[^0-9A-Za-z]/, "_", uuid);
          printf "%d, Unavailable GPU (%s), unavailable-%s, 0, 0, 0, 0, 0, 0\n", next_index, bus, uuid; next_index++
        }';
    fi;
  fi;
fi;
if [ "${RACKTOP_INCLUDE_PROCESSES:-1}" = "1" ]; then
  printf '__RACKTOP_GPUPROC__\n';
  gpu_proc="";
  if command -v nvidia-smi >/dev/null 2>&1; then
    query_gpu_processes() {
      selector="$1";
      if nvidia_smi_processes="$(nvidia-smi $selector --query-compute-apps=gpu_uuid,pid,process_name,used_gpu_memory --format=csv,noheader,nounits 2>/dev/null)"; then
        printf '%s\n' "$nvidia_smi_processes"; return 0;
      fi;
      if nvidia_smi_processes="$(nvidia-smi $selector --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null)"; then
        printf '%s\n' "$nvidia_smi_processes"; return 0;
      fi;
      return 1;
    }
    if ! gpu_proc="$(query_gpu_processes '')"; then
      gpu_proc="$(printf '%s\n' "$nvidia_list" | sed -n 's/^GPU \([0-9][0-9]*\):.*/\1/p' | while read -r gpu_index; do query_gpu_processes "-i $gpu_index" || true; done)";
    fi;
    printf '%s\n' "$gpu_proc";
  elif command -v npu-smi >/dev/null 2>&1; then
    gpu_proc="$(npu-smi info 2>/dev/null | awk -F '|' '
      function trim(value) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); return value }
      /^\|/ { for (i=2; i<NF; i++) field[i]=trim($i); if (field[2] ~ /^[0-9]+$/ && field[4] ~ /^(OK|Warning|Alarm|Failure)$/) print field[2] }
    ' | sort -nu | while read -r npu_index; do
      npu-smi info -t proc-mem -i "$npu_index" 2>/dev/null | awk -F '|' '
        function trim(value) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); return value }
        /^\|/ { for (i=2; i<NF; i++) field[i]=trim($i); if (field[2] ~ /^[0-9]+$/ && field[3] ~ /^[0-9]+$/ && field[4] ~ /^[0-9]+$/) printf "NPU-%s-%s, %s, %s, %.2f\n", field[2], field[3], field[4], field[5], field[6]+0 }
      '
    done)";
    printf '%s\n' "$gpu_proc";
  fi;
  printf '__RACKTOP_GPUPMON__\n';
  if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi pmon -c 1 -s um 2>/dev/null || true; fi;
  printf '__RACKTOP_PS__\n';
  gpu_pids="$(printf '%s\n' "$gpu_proc" | cut -d, -f2 | tr -d ' ' | paste -sd, -)";
  ps -eo user:64=,uid=,pid=,ppid=,pgid=,pcpu=,pmem=,rss=,etime=,args= --sort=-pcpu 2>/dev/null | awk -v gpu_pids="$gpu_pids" -v uid_min="$uid_min" 'BEGIN { n=split(gpu_pids, ids, ","); for (i=1; i<=n; i++) if (ids[i] != "") gpu[ids[i]]=1 } { is_gpu=($3 in gpu); is_child=($4 in gpu); is_user=($2 >= uid_min); is_main=($3 == $5 && $6 > 0); has_memory=($8 > 1048576); if (is_gpu || (is_user && has_memory && (is_child || (is_main && main_count < 64)))) { print; if (!is_gpu && is_main && !is_child) main_count++ } }' || true;
fi;
printf '__RACKTOP_END__\n';"#;

pub async fn collect(server: &Server) -> Result<Snapshot, String> {
    collect_with_password(server, None, true, true).await
}

pub async fn collect_with_password(server: &Server, password: Option<&str>, include_processes: bool, include_disks: bool) -> Result<Snapshot, String> {
    collect_with_password_detailed(server, password, include_processes, include_disks).await.map(|result| result.snapshot)
}

pub struct CollectionResult {
    pub snapshot: Snapshot,
    pub response_bytes: u64,
}

pub async fn collect_with_password_detailed(server: &Server, password: Option<&str>, include_processes: bool, include_disks: bool) -> Result<CollectionResult, String> {
    let (mut command, target) = configured_ssh_command(server, password)?;
    command.arg(target).arg(format!(
        "RACKTOP_INCLUDE_PROCESSES={} RACKTOP_INCLUDE_DISKS={} RACKTOP_REMOTE_HISTORY={};{REMOTE_SCRIPT}",
        if include_processes { 1 } else { 0 },
        if include_disks { 1 } else { 0 },
        if server.remote_history_enabled { 1 } else { 0 },
    )).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let output = timeout(Duration::from_secs(30), command.output()).await.map_err(|_| format!("连接 {} 超时（30 秒）", server.name))?.map_err(|error| format!("无法启动系统 ssh：{error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(classify_ssh_error(&stderr));
    }
    let snapshot = parse_snapshot(&server.id, &String::from_utf8_lossy(&output.stdout))?;
    Ok(CollectionResult { snapshot, response_bytes: output.stdout.len() as u64 })
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

pub(crate) fn explicit_identity_file(server: &Server) -> Option<&str> {
    matches!(server.auth_method.as_str(), "privateKey" | "sshConfig")
        .then(|| server.identity_file.as_deref())
        .flatten()
        .filter(|value| !value.is_empty())
}

pub fn collection_display_command(server: &Server, include_processes: bool, include_disks: bool) -> String {
    let mut arguments = vec![
        "-o ConnectTimeout=8".to_string(),
        "-o ServerAliveInterval=5".to_string(),
        "-o ServerAliveCountMax=2".to_string(),
        "-o StrictHostKeyChecking=yes".to_string(),
    ];
    if server.auth_method == "password" {
        arguments.extend([
            "-o BatchMode=no".to_string(),
            "-o PreferredAuthentications=password,keyboard-interactive".to_string(),
            "-o PubkeyAuthentication=no".to_string(),
            "-o NumberOfPasswordPrompts=1".to_string(),
        ]);
    } else {
        arguments.push("-o BatchMode=yes".to_string());
    }
    if let Some(identity) = explicit_identity_file(server) {
        arguments.push("-o IdentitiesOnly=yes".to_string());
        arguments.push(format!("-i {}", shell_quote(identity)));
    }
    if let Some(proxy) = server.proxy_jump.as_deref().filter(|value| !value.is_empty()) {
        arguments.push(format!("-J {}", shell_quote(proxy)));
    }
    let target = server.ssh_alias.as_deref().filter(|value| !value.is_empty()).map(str::to_string).unwrap_or_else(|| {
        arguments.push(format!("-p {}", server.port));
        format!("{}@{}", server.username, server.host)
    });
    let remote_command = format!(
        "RACKTOP_INCLUDE_PROCESSES={} RACKTOP_INCLUDE_DISKS={} RACKTOP_REMOTE_HISTORY={};{REMOTE_SCRIPT}",
        if include_processes { 1 } else { 0 },
        if include_disks { 1 } else { 0 },
        if server.remote_history_enabled { 1 } else { 0 },
    );
    format!("ssh {} {} {}", arguments.join(" "), shell_quote(&target), shell_quote(&remote_command))
}

pub(crate) fn configured_ssh_command(server: &Server, password: Option<&str>) -> Result<(Command, String), String> {
    configured_ssh_command_with_control(server, password, false)
}

pub(crate) fn configured_ssh_command_without_control(server: &Server, password: Option<&str>) -> Result<(Command, String), String> {
    configured_ssh_command_with_control(server, password, false)
}

fn configured_ssh_command_with_control(server: &Server, password: Option<&str>, _use_control_master: bool) -> Result<(Command, String), String> {
    let mut command = Command::new("ssh");
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command.args(["-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2", "-o", "StrictHostKeyChecking=yes"]);
    if server.auth_method == "password" {
        let password = password.ok_or("没有可用密码；请重新编辑服务器并输入密码")?;
        let executable = std::env::current_exe().map_err(|error| format!("无法定位 RackTop SSH_ASKPASS：{error}"))?;
        command
            .args(["-o", "BatchMode=no", "-o", "PreferredAuthentications=password,keyboard-interactive", "-o", "PubkeyAuthentication=no", "-o", "NumberOfPasswordPrompts=1"])
            .env("SSH_ASKPASS", executable)
            .env("SSH_ASKPASS_REQUIRE", "force")
            .env("RACKTOP_ASKPASS_PASSWORD", password);
        #[cfg(unix)]
        command.env("DISPLAY", "racktop:0");
    } else {
        command.args(["-o", "BatchMode=yes"]);
    }
    #[cfg(unix)]
    if _use_control_master {
        command.args(["-o", "ControlMaster=auto", "-o", "ControlPersist=600", "-o", "ControlPath=/tmp/racktop-%C"]);
    } else {
        command.args(["-o", "ControlMaster=no", "-o", "ControlPath=none"]);
    }
    if let Some(identity) = explicit_identity_file(server) {
        command.args(["-o", "IdentitiesOnly=yes"]);
        command.arg("-i").arg(expand_identity_path(identity));
    }
    if let Some(proxy) = server.proxy_jump.as_deref().filter(|value| !value.is_empty()) {
        command.args(["-J", proxy]);
    }
    let target = if let Some(alias) = server.ssh_alias.as_deref().filter(|value| !value.is_empty()) {
        alias.to_string()
    } else {
        command.args(["-p", &server.port.to_string()]);
        format!("{}@{}", server.username, server.host)
    };
    Ok((command, target))
}

pub async fn install_nvidia_driver(server: &Server, password: Option<&str>) -> Result<String, String> {
    let (mut detect, target) = configured_ssh_command(server, password)?;
    detect.arg(&target).arg("if [ -r /etc/os-release ]; then . /etc/os-release; printf '%s' \"${ID:-unknown}\"; else printf unknown; fi").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let detected = timeout(Duration::from_secs(10), detect.output()).await.map_err(|_| "识别 Linux 发行版超时".to_string())?.map_err(|error| format!("无法启动系统 ssh：{error}"))?;
    if !detected.status.success() { return Err(classify_ssh_error(String::from_utf8_lossy(&detected.stderr).trim())); }
    let os_id = String::from_utf8_lossy(&detected.stdout).trim().to_ascii_lowercase();
    let install_script = match os_id.as_str() {
        "ubuntu" => "sudo -n sh -c 'apt-get update && apt-get install -y ubuntu-drivers-common && ubuntu-drivers autoinstall'",
        "debian" => "sudo -n sh -c 'apt-get update && apt-get install -y nvidia-driver'",
        _ => return Err(format!("暂不支持在 {os_id} 上自动安装。请复制界面提供的命令或参考 NVIDIA 官方文档。")),
    };
    let (mut install, target) = configured_ssh_command(server, password)?;
    install.arg(target).arg(install_script).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let output = timeout(Duration::from_secs(900), install.output()).await.map_err(|_| "NVIDIA 驱动安装超过 15 分钟，已停止等待；请登录服务器检查安装状态".to_string())?.map_err(|error| format!("无法启动系统 ssh：{error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.to_ascii_lowercase().contains("password is required") || stderr.to_ascii_lowercase().contains("a password is required") {
            return Err("服务器需要交互式 sudo 密码。RackTop 不会代填管理员密码；请复制安装命令并在终端执行。".into());
        }
        return Err(format!("驱动安装失败：{stderr}"));
    }
    Ok("安装命令执行完成。驱动通常需要重启服务器后生效；请重启后点击“重新检测”。".into())
}

pub(crate) fn classify_ssh_error(stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    if lower.contains("host key verification failed") || lower.contains("no host key is known") {
        "主机指纹尚未信任或已发生变化。为防止中间人攻击，RackTop 已阻止连接；请先用系统 ssh 核对并接受指纹。".into()
    } else if lower.contains("permission denied") {
        format!("SSH 认证失败：{stderr}")
    } else if lower.contains("connection refused") {
        format!("SSH 连接被拒绝：{stderr}")
    } else if lower.contains("connection closed by 127.0.0.1") || lower.contains("connect to host 127.0.0.1") {
        format!("本机 SSH 代理拒绝了连接：{stderr}。请确认代理正在运行；若此服务器不需要代理，请检查 ~/.ssh/config 中的 ProxyCommand / ProxyJump。")
    } else if lower.contains("no route to host") || lower.contains("operation timed out") {
        format!("服务器不可达：{stderr}")
    } else if stderr.is_empty() {
        "SSH 命令执行失败，未返回错误详情".into()
    } else {
        format!("SSH 连接失败：{stderr}")
    }
}

pub fn parse_snapshot(server_id: &str, output: &str) -> Result<Snapshot, String> {
    let sections = split_sections(output);
    let username = first_line(&sections, "USER").unwrap_or("unknown").to_string();
    let uid_min = first_line(&sections, "UIDMIN").and_then(|value| value.parse::<u32>().ok()).unwrap_or(1000);
    let hostname = first_line(&sections, "HOST").unwrap_or("unknown").to_string();
    let os = first_line(&sections, "OS").unwrap_or("unknown|Linux");
    let (os_id, os_name) = os.split_once('|').unwrap_or(("unknown", "Linux"));
    let cpu_model = first_line(&sections, "CPUMODEL").unwrap_or("未知 CPU").to_string();
    let cpu1 = parse_cpu(first_line(&sections, "CPU1").ok_or("采集输出缺少 /proc/stat 首次样本")?)?;
    let cpu2 = parse_cpu(first_line(&sections, "CPU2").ok_or("采集输出缺少 /proc/stat 第二次样本")?)?;
    let cpu_delta = cpu2.0.saturating_sub(cpu1.0);
    let idle_delta = cpu2.1.saturating_sub(cpu1.1);
    let cpu_utilization = if cpu_delta > 0 { (1.0 - idle_delta as f64 / cpu_delta as f64) * 100.0 } else { 0.0 };
    let mut system = SystemMetric { cpu_model, cpu_utilization: cpu_utilization.clamp(0.0, 100.0), ..Default::default() };
    if let Some(load) = first_line(&sections, "LOAD") {
        let values: Vec<f64> = load.split_whitespace().take(3).map(parse_number).collect();
        if values.len() == 3 { system.load1 = values[0]; system.load5 = values[1]; system.load15 = values[2]; }
    }
    if let Some(memory) = sections.get("MEM") { parse_memory(memory, &mut system); }
    system.current_user_cpu_utilization = first_line(&sections, "USERCPU").map(parse_number).unwrap_or_default();
    let disks = sections.get("DISK").map(|lines| lines.iter().filter_map(|line| parse_disk(line).ok()).collect()).unwrap_or_default();

    let accelerator_vendor = first_line(&sections, "ACCELERATOR").filter(|value| *value == "ascend").unwrap_or("nvidia").to_string();
    let nvidia_lines = sections.get("NVIDIA").cloned().unwrap_or_default();
    let nvidia_smi = nvidia_lines.first().map(String::as_str).unwrap_or("missing").to_string();
    let nvidia_message = match nvidia_smi.as_str() {
        "available" => None,
        "missing" => Some("服务器未检测到 nvidia-smi 或 npu-smi；可能没有受支持的加速卡，或驱动工具未安装/不在 PATH 中。".into()),
        _ => Some(nvidia_lines.iter().skip(1).cloned().collect::<Vec<_>>().join("\n").trim().to_string()).filter(|value| !value.is_empty()).or_else(|| Some("nvidia-smi 存在但无法执行，请检查驱动和权限。".into())),
    };
    let gpus: Vec<GpuMetric> = sections
        .get("GPU")
        .map(|lines| lines.iter().filter_map(|line| parse_gpu(line).ok()).collect::<Vec<_>>())
        .unwrap_or_default();
    let ps = parse_ps(sections.get("PS"));
    let pmon = parse_pmon(sections.get("GPUPMON"));
    let processes = parse_gpu_processes(sections.get("GPUPROC"), &gpus, &ps, &pmon, &username);
    let cpu_processes = parse_cpu_processes(&ps, &processes, &username, uid_min);
    let processes_sampled = sections.contains_key("GPUPROC");
    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_secs() as i64;
    Ok(Snapshot { server_id: server_id.into(), hostname, username, os_id: os_id.into(), os_name: os_name.into(), timestamp, status: if nvidia_smi == "available" { "online".into() } else { "warning".into() }, accelerator_vendor, system, gpus, disks, processes, cpu_processes, processes_sampled, nvidia_smi, nvidia_message })
}

fn parse_disk(line: &str) -> Result<DiskMetric, String> {
    let fields: Vec<&str> = line.split('|').collect();
    if !(4..=5).contains(&fields.len()) || !is_visible_disk_mount(fields[0]) { return Err("磁盘采样记录无效".into()); }
    let used_kb = fields[1].parse::<u64>().map_err(|_| "磁盘已用空间无效".to_string())?;
    let total_kb = fields[2].parse::<u64>().map_err(|_| "磁盘总空间无效".to_string())?;
    let available_kb = fields[3].parse::<u64>().map_err(|_| "磁盘可用空间无效".to_string())?;
    if total_kb == 0 || used_kb > total_kb { return Err("磁盘容量范围无效".into()); }
    let current_user_used_kb = fields.get(4).and_then(|value| value.parse::<u64>().ok()).unwrap_or_default().min(used_kb);
    Ok(DiskMetric { mount_point: fields[0].to_string(), used_bytes: used_kb.saturating_mul(1024), total_bytes: total_kb.saturating_mul(1024), available_bytes: available_kb.saturating_mul(1024), current_user_used_bytes: current_user_used_kb.saturating_mul(1024) })
}

fn is_visible_disk_mount(mount: &str) -> bool {
    !["/sys", "/proc", "/dev", "/run", "/boot/efi", "/snap", "/var/lib/docker", "/var/lib/containers", "/var/lib/kubelet"]
        .iter()
        .any(|prefix| mount == *prefix || mount.starts_with(&format!("{prefix}/")))
}

fn split_sections(output: &str) -> HashMap<String, Vec<String>> {
    let mut sections: HashMap<String, Vec<String>> = HashMap::new();
    let mut current: Option<String> = None;
    for raw_line in output.lines() {
        let line = raw_line.trim_end();
        if let Some(name) = line.strip_prefix("__RACKTOP_").and_then(|value| value.strip_suffix("__")) {
            if name == "END" { current = None; } else { current = Some(name.to_string()); sections.entry(name.to_string()).or_default(); }
        } else if let Some(section) = current.as_ref() {
            if !line.trim().is_empty() { sections.entry(section.clone()).or_default().push(line.trim().to_string()); }
        }
    }
    sections
}

fn first_line<'a>(sections: &'a HashMap<String, Vec<String>>, key: &str) -> Option<&'a str> { sections.get(key)?.first().map(String::as_str) }
fn parse_number(value: &str) -> f64 { value.trim().parse().unwrap_or(0.0) }

fn parse_cpu(line: &str) -> Result<(u64, u64), String> {
    let values: Vec<u64> = line.split_whitespace().skip(1).map(|value| value.parse().unwrap_or(0)).collect();
    if values.len() < 4 { return Err(format!("无效的 /proc/stat 输出：{line}")); }
    let total = values.iter().sum();
    let idle = values.get(3).copied().unwrap_or(0) + values.get(4).copied().unwrap_or(0);
    Ok((total, idle))
}

fn parse_memory(lines: &[String], system: &mut SystemMetric) {
    let mut values = HashMap::new();
    for line in lines {
        let mut parts = line.split_whitespace();
        if let (Some(key), Some(value)) = (parts.next(), parts.next()) { values.insert(key.trim_end_matches(':'), value.parse::<u64>().unwrap_or(0) * 1024); }
    }
    system.memory_total_bytes = *values.get("MemTotal").unwrap_or(&0);
    let available = *values.get("MemAvailable").unwrap_or(&0);
    system.memory_used_bytes = system.memory_total_bytes.saturating_sub(available);
    system.swap_total_bytes = *values.get("SwapTotal").unwrap_or(&0);
    system.swap_used_bytes = system.swap_total_bytes.saturating_sub(*values.get("SwapFree").unwrap_or(&0));
}

fn parse_gpu(line: &str) -> Result<GpuMetric, String> {
    let fields: Vec<&str> = line.split(',').map(str::trim).collect();
    if fields.len() < 9 { return Err(format!("无效的 nvidia-smi GPU 输出：{line}")); }
    Ok(GpuMetric { index: fields[0].parse().map_err(|_| format!("无效 GPU 索引：{}", fields[0]))?, name: fields[1].into(), uuid: fields[2].into(), utilization: parse_number(fields[3]).clamp(0.0, 100.0), memory_utilization: parse_number(fields[4]).clamp(0.0, 100.0), memory_used_mb: parse_number(fields[5]).max(0.0), memory_total_mb: parse_number(fields[6]).max(0.0), temperature_celsius: parse_number(fields[7]), power_watts: parse_number(fields[8]).max(0.0) })
}

#[derive(Default)]
struct PsInfo {
    uid: u32,
    parent_pid: u32,
    process_group_id: u32,
    username: String,
    cpu: f64,
    memory_percent: f64,
    rss_kb: u64,
    elapsed: String,
    command: String,
}

fn parse_ps(lines: Option<&Vec<String>>) -> HashMap<u32, PsInfo> {
    let mut result = HashMap::new();
    for line in lines.into_iter().flatten() {
        let mut parts = line.split_whitespace();
        let Some(username) = parts.next() else { continue }; let Some(uid_text) = parts.next() else { continue };
        let Some(pid_text) = parts.next() else { continue }; let Some(parent_pid_text) = parts.next() else { continue };
        let Some(process_group_text) = parts.next() else { continue }; let Some(cpu_text) = parts.next() else { continue };
        let Some(memory_text) = parts.next() else { continue }; let Some(rss_text) = parts.next() else { continue };
        let Some(elapsed) = parts.next() else { continue };
        let Ok(pid) = pid_text.parse::<u32>() else { continue };
        result.insert(pid, PsInfo { uid: uid_text.parse().unwrap_or(0), parent_pid: parent_pid_text.parse().unwrap_or(0), process_group_id: process_group_text.parse().unwrap_or(0), username: username.into(), cpu: parse_number(cpu_text), memory_percent: parse_number(memory_text), rss_kb: rss_text.parse().unwrap_or(0), elapsed: elapsed.into(), command: parts.collect::<Vec<_>>().join(" ") });
    }
    result
}

fn parse_pmon(lines: Option<&Vec<String>>) -> HashMap<(u32, u32), Option<f64>> {
    let mut result = HashMap::new();
    for line in lines.into_iter().flatten().filter(|line| !line.starts_with('#')) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 5 || fields[1] == "-" { continue; }
        let (Ok(gpu_index), Ok(pid)) = (fields[0].parse::<u32>(), fields[1].parse::<u32>()) else { continue };
        let sm_utilization = fields[3].parse::<f64>().ok().map(|value| value.clamp(0.0, 100.0));
        result.insert((gpu_index, pid), sm_utilization);
    }
    result
}

fn parse_gpu_processes(lines: Option<&Vec<String>>, gpus: &[GpuMetric], ps: &HashMap<u32, PsInfo>, pmon: &HashMap<(u32, u32), Option<f64>>, current_user: &str) -> Vec<ProcessMetric> {
    lines.into_iter().flatten().filter_map(|line| {
        let fields: Vec<&str> = line.split(',').map(str::trim).collect();
        if fields.len() < 4 { return None; }
        let pid = fields[1].parse().ok()?;
        let info = ps.get(&pid);
        let username = info.map(|value| value.username.clone()).unwrap_or_else(|| "unknown".into());
        let gpu_index = gpus.iter().find(|gpu| gpu.uuid == fields[0]).map(|gpu| gpu.index).unwrap_or(0);
        Some(ProcessMetric { gpu_uuid: fields[0].into(), gpu_index, pid, parent_pid: info.map(|value| value.parent_pid).unwrap_or(0), username: username.clone(), command: info.filter(|value| !value.command.is_empty()).map(|value| value.command.clone()).unwrap_or_else(|| fields[2].into()), memory_used_mb: parse_number(fields[3]), sm_utilization: pmon.get(&(gpu_index, pid)).copied().flatten(), cpu_percent: info.map(|value| value.cpu).unwrap_or(0.0), elapsed: info.map(|value| value.elapsed.clone()).unwrap_or_else(|| "—".into()), is_current_user: username == current_user, is_group_leader: info.is_some_and(|value| value.process_group_id == pid) })
    }).collect()
}

fn is_system_cpu_process(info: &PsInfo) -> bool {
    let command = info.command.to_ascii_lowercase();
    let executable = command.split_whitespace().next().unwrap_or_default().rsplit('/').next().unwrap_or_default();
    const EXCLUDED_EXECUTABLES: &[&str] = &[
        "systemd", "wireplumber", "pipewire", "pipewire-pulse", "dbus-daemon", "gnome-shell", "xorg", "xwayland", "pulseaudio",
        "nvitop", "nvtop", "htop", "btop", "glances", "node_exporter",
        "tailscale", "tailscaled", "zerotier-one", "openvpn", "openconnect", "wg-quick", "wireguard", "clash", "mihomo", "sing-box", "v2ray", "xray", "cloudflared", "charon", "strongswan", "globalprotect", "forticlient", "vpnagentd",
    ];
    const EXCLUDED_COMMAND_PATTERNS: &[&str] = &[
        "nvitop", ".vscode-server", "code-server", ".cursor-server", "cursor-server", "codex", "claude", "pycharm_helpers", "remote-dev-server", "jetbrains",
    ];
    EXCLUDED_EXECUTABLES.contains(&executable) || EXCLUDED_COMMAND_PATTERNS.iter().any(|pattern| command.contains(pattern))
}

fn parse_cpu_processes(ps: &HashMap<u32, PsInfo>, gpu_processes: &[ProcessMetric], current_user: &str, uid_min: u32) -> Vec<CpuProcessMetric> {
    let gpu_pids: HashSet<u32> = gpu_processes.iter().map(|process| process.pid).collect();
    let child_pids: HashSet<u32> = ps.iter().filter(|(_, info)| gpu_pids.contains(&info.parent_pid)).map(|(pid, _)| *pid).collect();
    let mut entries: Vec<_> = ps.iter().filter(|(pid, info)| {
        let is_gpu_child = child_pids.contains(*pid);
        let is_active_main = **pid == info.process_group_id && info.cpu > 0.0;
        !gpu_pids.contains(*pid) && info.uid >= uid_min && info.rss_kb > 1024 * 1024 && !is_system_cpu_process(info) && (is_gpu_child || is_active_main)
    }).collect();
    entries.sort_by(|(left_pid, left), (right_pid, right)| right.cpu.total_cmp(&left.cpu).then_with(|| left_pid.cmp(right_pid)));

    let mut main_count = 0;
    entries.into_iter().filter(|(pid, _)| {
        if child_pids.contains(*pid) { true } else if main_count < 12 { main_count += 1; true } else { false }
    }).map(|(pid, info)| CpuProcessMetric {
        pid: *pid,
        parent_pid: info.parent_pid,
        username: info.username.clone(),
        command: info.command.clone(),
        cpu_percent: info.cpu,
        memory_percent: info.memory_percent,
        memory_used_bytes: info.rss_kb.saturating_mul(1024),
        elapsed: info.elapsed.clone(),
        is_current_user: info.username == current_user,
        is_group_leader: info.process_group_id == *pid,
    }).collect()
}

fn termination_script(pid: u32) -> Result<String, String> {
    if pid <= 1 { return Err("不能结束 PID 0 或 PID 1".into()); }
    Ok(format!(r#"pid={pid}
current_uid="$(id -u)"
process_uid="$(ps -o uid= -p "$pid" 2>/dev/null | tr -d ' ')"
process_start="$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//;s/ *$//')"
if [ -z "$process_uid" ] || [ -z "$process_start" ]; then printf '__RACKTOP_TERMINATE_NOT_FOUND__\n'; exit 44; fi
if [ "$process_uid" != "$current_uid" ]; then printf '__RACKTOP_TERMINATE_OWNER_MISMATCH__\n'; exit 45; fi
tree_pids="$pid"
frontier="$pid"
while [ -n "$frontier" ]; do
  next_frontier=""
  for parent_pid in $frontier; do
    children="$(pgrep -P "$parent_pid" 2>/dev/null || true)"
    if [ -n "$children" ]; then next_frontier="$next_frontier $children"; fi
  done
  frontier="$next_frontier"
  if [ -n "$frontier" ]; then tree_pids="$tree_pids $frontier"; fi
done
target_records=""
for target_pid in $tree_pids; do
  target_uid="$(ps -o uid= -p "$target_pid" 2>/dev/null | tr -d ' ')"
  target_start="$(ps -o lstart= -p "$target_pid" 2>/dev/null | sed 's/^ *//;s/ *$//')"
  if [ "$target_uid" = "$current_uid" ] && [ -n "$target_start" ]; then target_records="$target_records$target_pid|$target_uid|$target_start
"; fi
done
printf '%s' "$target_records" | while IFS='|' read -r target_pid target_uid target_start; do
  if [ -n "$target_pid" ]; then kill -TERM "$target_pid" 2>/dev/null || true; fi
done
sleep 3
printf '%s' "$target_records" | while IFS='|' read -r target_pid target_uid target_start; do
  [ -n "$target_pid" ] || continue
  remaining_uid="$(ps -o uid= -p "$target_pid" 2>/dev/null | tr -d ' ')"
  remaining_start="$(ps -o lstart= -p "$target_pid" 2>/dev/null | sed 's/^ *//;s/ *$//')"
  if [ "$remaining_uid" = "$target_uid" ] && [ "$remaining_start" = "$target_start" ]; then kill -KILL "$target_pid" 2>/dev/null || true; fi
done
sleep 1
if ! printf '%s' "$target_records" | while IFS='|' read -r target_pid target_uid target_start; do
  [ -n "$target_pid" ] || continue
  remaining_uid="$(ps -o uid= -p "$target_pid" 2>/dev/null | tr -d ' ')"
  remaining_start="$(ps -o lstart= -p "$target_pid" 2>/dev/null | sed 's/^ *//;s/ *$//')"
  if [ "$remaining_uid" = "$target_uid" ] && [ "$remaining_start" = "$target_start" ]; then exit 46; fi
done; then
  printf '__RACKTOP_TERMINATE_REMAINING__\n'
  exit 46
fi
printf '__RACKTOP_TERMINATE_OK__\n'"#))
}

pub async fn terminate_process_tree(server: &Server, password: Option<&str>, pid: u32) -> Result<String, String> {
    let script = termination_script(pid)?;
    let (mut command, target) = configured_ssh_command(server, password)?;
    command.arg(target).arg(script).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let output = timeout(Duration::from_secs(12), command.output()).await.map_err(|_| format!("结束 PID {pid} 超时（12 秒）"))?.map_err(|error| format!("无法启动系统 ssh：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if output.status.success() && stdout.contains("__RACKTOP_TERMINATE_OK__") {
        return Ok(format!("已结束 PID {pid} 的进程树"));
    }
    if stdout.contains("__RACKTOP_TERMINATE_NOT_FOUND__") { return Err(format!("PID {pid} 已不存在，请刷新后重试")); }
    if stdout.contains("__RACKTOP_TERMINATE_OWNER_MISMATCH__") { return Err(format!("PID {pid} 不属于当前 SSH 用户，操作已阻止")); }
    if stdout.contains("__RACKTOP_TERMINATE_REMAINING__") { return Err(format!("PID {pid} 的部分进程仍在运行，请在终端中检查进程状态")); }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() { format!("无法结束 PID {pid}") } else { classify_ssh_error(&stderr) })
}

fn validate_run_id(run_id: &str) -> Result<(), String> {
    if run_id.is_empty() || run_id.len() > 80 || !run_id.chars().all(|character| character.is_ascii_alphanumeric() || character == '-') {
        return Err("运行任务标识无效".into());
    }
    Ok(())
}

pub async fn launch_managed_run(server: &Server, password: Option<&str>, run_id: &str, working_directory: &str, task_command: &str, gpu_indices: &[u32], project_log_path: Option<&str>, accelerator_vendor: &str) -> Result<ManagedRunLaunchResult, String> {
    validate_run_id(run_id)?;
    if working_directory.trim().is_empty() { return Err("工作目录不能为空".into()); }
    if task_command.trim().is_empty() { return Err("启动命令不能为空".into()); }
    if task_command.len() > 32_768 || working_directory.len() > 4_096 || task_command.contains('\0') || working_directory.contains('\0') {
        return Err("工作目录或启动命令过长".into());
    }
    if let Some(path) = project_log_path {
        if path.len() > 4_096 || path.contains('\0') { return Err("项目日志路径无效".into()); }
    }
    let workdir = STANDARD.encode(working_directory.trim());
    let payload = STANDARD.encode(task_command.trim());
    let project_log = STANDARD.encode(project_log_path.unwrap_or("").trim());
    let gpu_csv = gpu_indices.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
    let visible_devices_variable = if accelerator_vendor == "ascend" { "ASCEND_RT_VISIBLE_DEVICES" } else { "CUDA_VISIBLE_DEVICES" };
    let script = format!(r#"set -eu
decode_base64() {{ printf '%s' "$1" | base64 -d 2>/dev/null || printf '%s' "$1" | base64 --decode; }}
workdir="$(decode_base64 '{workdir}')"
task_command="$(decode_base64 '{payload}')"
project_log_path="$(decode_base64 '{project_log}')"
case "$workdir" in '~') workdir="$HOME" ;; '~/'*) workdir="$HOME/${{workdir#\~/}}" ;; esac
if [ ! -d "$workdir" ]; then printf '__RACKTOP_RUN_DIR_MISSING__\n'; exit 42; fi
run_dir="$HOME/.racktop/runs/{run_id}"
mkdir -p "$run_dir"
if [ -n "$project_log_path" ]; then
  case "$project_log_path" in '~') project_log_path="$HOME" ;; '~/'*) project_log_path="$HOME/${{project_log_path#\~/}}" ;; /*) ;; *) project_log_path="$workdir/$project_log_path" ;; esac
  project_log_dir="$(dirname "$project_log_path")"
  mkdir -p "$project_log_dir"
  if [ -e "$project_log_path" ] && [ ! -L "$project_log_path" ]; then printf '__RACKTOP_PROJECT_LOG_EXISTS__%s\n' "$project_log_path"; exit 44; fi
  ln -sfn "$run_dir/output.log" "$project_log_path"
fi
launch_script="$run_dir/launch.sh"
{{
  printf '#!/bin/sh\n'
  printf 'export {visible_devices_variable}=%s\n' '{gpu_csv}'
  printf '%s\n' "$task_command"
  printf 'exit_code=$?\nprintf "%%s" "$exit_code" > "$HOME/.racktop/runs/{run_id}/exit-code"\nexit "$exit_code"\n'
}} > "$launch_script"
chmod 700 "$launch_script"
rm -f "$run_dir/exit-code"
cd "$workdir"
if command -v setsid >/dev/null 2>&1; then
  nohup setsid sh "$launch_script" > "$run_dir/output.log" 2>&1 < /dev/null &
else
  nohup sh "$launch_script" > "$run_dir/output.log" 2>&1 < /dev/null &
fi
pid=$!
printf '%s' "$pid" > "$run_dir/pid"
sleep 0.8
if ! kill -0 "$pid" 2>/dev/null; then printf '__RACKTOP_RUN_FAILED__\n'; tail -n 12 "$run_dir/output.log" 2>/dev/null; exit 43; fi
printf '__RACKTOP_RUN_OK__%s\n' "$pid"
"#);
    let (mut command, target) = configured_ssh_command(server, password)?;
    command.arg(target).arg(script).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let output = timeout(Duration::from_secs(15), command.output()).await.map_err(|_| "启动任务超时（15 秒）".to_string())?.map_err(|error| format!("无法启动系统 ssh：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.contains("__RACKTOP_RUN_DIR_MISSING__") { return Err(format!("远端工作目录不存在：{}", working_directory.trim())); }
    if stdout.contains("__RACKTOP_PROJECT_LOG_EXISTS__") { return Err(stdout.replace("__RACKTOP_PROJECT_LOG_EXISTS__", "项目日志路径已存在，未覆盖：").trim().to_string()); }
    if stdout.contains("__RACKTOP_RUN_FAILED__") { return Err(stdout.replace("__RACKTOP_RUN_FAILED__", "任务启动后立即退出：").trim().to_string()); }
    if output.status.success() {
        if let Some(pid) = stdout.lines().find_map(|line| line.strip_prefix("__RACKTOP_RUN_OK__").and_then(|value| value.trim().parse::<u32>().ok())) {
            return Ok(ManagedRunLaunchResult { pid, log_path: format!("~/.racktop/runs/{run_id}/output.log") });
        }
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() { "远端未返回任务 PID".into() } else { classify_ssh_error(&stderr) })
}

pub async fn read_managed_run_log(server: &Server, password: Option<&str>, run_id: &str, lines: u32) -> Result<String, String> {
    validate_run_id(run_id)?;
    let lines = lines.clamp(20, 1_000);
    let script = format!("tail -n {lines} \"$HOME/.racktop/runs/{run_id}/output.log\" 2>/dev/null || true");
    let (mut command, target) = configured_ssh_command(server, password)?;
    command.arg(target).arg(script).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let output = timeout(Duration::from_secs(10), command.output()).await.map_err(|_| "读取任务日志超时".to_string())?.map_err(|error| format!("无法启动系统 ssh：{error}"))?;
    if output.status.success() { return Ok(String::from_utf8_lossy(&output.stdout).to_string()); }
    Err(classify_ssh_error(String::from_utf8_lossy(&output.stderr).trim()))
}

pub async fn managed_run_status(server: &Server, password: Option<&str>, run_id: &str, pid: u32) -> Result<ManagedRunRemoteStatus, String> {
    validate_run_id(run_id)?;
    if pid <= 1 { return Err("任务 PID 无效".into()); }
    let script = format!(r#"exit_file="$HOME/.racktop/runs/{run_id}/exit-code"
if [ -f "$exit_file" ]; then printf 'exited:'; cat "$exit_file"; printf '\n';
elif kill -0 {pid} 2>/dev/null; then printf 'running\n';
else printf 'unknown\n'; fi"#);
    let (mut command, target) = configured_ssh_command(server, password)?;
    command.arg(target).arg(script).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let output = timeout(Duration::from_secs(8), command.output()).await.map_err(|_| "检查任务状态超时".to_string())?.map_err(|error| format!("无法启动系统 ssh：{error}"))?;
    if !output.status.success() { return Err(classify_ssh_error(String::from_utf8_lossy(&output.stderr).trim())); }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value == "running" { return Ok(ManagedRunRemoteStatus { status: "running".into(), exit_code: None }); }
    if let Some(code) = value.strip_prefix("exited:").and_then(|item| item.trim().parse::<i32>().ok()) {
        return Ok(ManagedRunRemoteStatus { status: "exited".into(), exit_code: Some(code) });
    }
    Ok(ManagedRunRemoteStatus { status: "unknown".into(), exit_code: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "__RACKTOP_USER__\ntongzh\n__RACKTOP_UIDMIN__\n1000\n__RACKTOP_HOST__\ngpu-box\n__RACKTOP_OS__\nubuntu|Ubuntu 22.04 LTS\n__RACKTOP_CPUMODEL__\nAMD EPYC 9654 96-Core Processor\n__RACKTOP_CPU1__\ncpu 100 0 20 880 0 0 0\n__RACKTOP_CPU2__\ncpu 120 0 30 950 0 0 0\n__RACKTOP_LOAD__\n0.06 0.11 0.09 1/100 1\n__RACKTOP_MEM__\nMemTotal: 100000 kB\nMemAvailable: 75000 kB\nSwapTotal: 1000 kB\nSwapFree: 900 kB\n__RACKTOP_USERCPU__\n5.50\n__RACKTOP_NVIDIA__\navailable\n__RACKTOP_GPU__\n0, NVIDIA GeForce RTX 4090 D, GPU-abc, 25, 10, 2048, 24564, 48, 110.5\n__RACKTOP_GPUPROC__\nGPU-abc, 4242, python, 2048\n__RACKTOP_GPUPMON__\n# gpu pid type sm mem\n0 4242 C 73 41 - - - - 2048 0 python\n__RACKTOP_PS__\ntongzh 1000 4242 1 4242 12.5 2.0 204800 01:20 python train.py\ntongzh 1000 4343 4242 4242 1.5 1.5 2097152 00:10 python data-loader.py\ntongzh 1000 5000 1 5000 0.8 1.2 1572864 00:30 python cpu-task.py\ntongzh 1000 5500 1 5500 0.9 0.5 1048576 00:20 python small-task.py\ntongzh 1000 5800 1 5800 1.2 1.4 1468006 00:20 /usr/bin/python3 /usr/bin/nvitop\ntongzh 1000 5900 1 5900 1.1 1.5 1572864 00:20 /home/tongzh/.vscode-server/bin/node server-main.js\ntongzh 1000 6000 1 6000 0.7 1.1 1153434 10:00 /usr/lib/systemd/systemd --user\nroot 0 99 1 99 0.2 1.2 1258291 10:00 systemd-worker\n__RACKTOP_END__\n";

    #[test]
    fn parses_realistic_snapshot() {
        let snapshot = parse_snapshot("server-1", SAMPLE).unwrap();
        assert_eq!(snapshot.hostname, "gpu-box");
        assert_eq!(snapshot.os_id, "ubuntu");
        assert_eq!(snapshot.system.cpu_model, "AMD EPYC 9654 96-Core Processor");
        assert_eq!(snapshot.gpus.len(), 1);
        assert_eq!(snapshot.processes.len(), 1);
        assert!(snapshot.processes_sampled);
        assert!(snapshot.processes[0].is_current_user);
        assert!(snapshot.processes[0].is_group_leader);
        assert_eq!(snapshot.processes[0].sm_utilization, Some(73.0));
        assert_eq!(snapshot.processes[0].parent_pid, 1);
        assert_eq!(snapshot.cpu_processes.len(), 2);
        assert!(snapshot.disks.is_empty());
        let disk = parse_disk("/mnt/data|250000|1000000|750000|50000").unwrap();
        assert_eq!(disk.used_bytes, 250_000 * 1024);
        assert_eq!(disk.total_bytes, 1_000_000 * 1024);
        assert_eq!(disk.current_user_used_bytes, 50_000 * 1024);
        assert!(parse_disk("/sys/firmware/efi/efivars|1|10|9|0").is_err());
        assert!(parse_disk("/boot/efi|1|10|9|0").is_err());
        assert!(parse_disk("/home|4|10|6|1").is_ok());
        assert_eq!(snapshot.cpu_processes[0].pid, 4343);
        assert_eq!(snapshot.cpu_processes[0].parent_pid, 4242);
        assert!(!snapshot.cpu_processes[0].is_group_leader);
        assert!(snapshot.cpu_processes.iter().any(|process| process.pid == 5000));
        assert!(!snapshot.cpu_processes.iter().any(|process| process.pid == 6000));
        assert!(!snapshot.cpu_processes.iter().any(|process| process.pid == 99));
        assert!(!snapshot.cpu_processes.iter().any(|process| process.pid == 5500));
        assert!(!snapshot.cpu_processes.iter().any(|process| process.pid == 5800));
        assert!(!snapshot.cpu_processes.iter().any(|process| process.pid == 5900));
        assert_eq!(snapshot.system.memory_used_bytes, 25_000 * 1024);
        assert!((snapshot.system.cpu_utilization - 30.0).abs() < 0.01);
    }

    #[test]
    fn keeps_healthy_gpus_when_one_device_handle_fails() {
        let output = SAMPLE.replacen(
            "available\n__RACKTOP_GPU__\n0, NVIDIA GeForce RTX 4090 D, GPU-abc, 25, 10, 2048, 24564, 48, 110.5",
            "degraded\nGPU 0: NVIDIA GeForce RTX 4090 (UUID: GPU-abc)\nUnable to determine the device handle for gpu 0000:D1:00.0: Unknown Error\n__RACKTOP_GPU__\n0, NVIDIA GeForce RTX 4090 D, GPU-abc, 25, 10, 2048, 24564, 48, 110.5\n1, Unavailable GPU (0000:D1:00.0), unavailable-0000_D1_00_0, 0, 0, 0, 0, 0, 0",
            1,
        );
        let snapshot = parse_snapshot("server-1", &output).unwrap();
        assert_eq!(snapshot.nvidia_smi, "degraded");
        assert_eq!(snapshot.status, "warning");
        assert_eq!(snapshot.gpus.len(), 2);
        assert_eq!(snapshot.gpus[0].uuid, "GPU-abc");
        assert_eq!(snapshot.gpus[1].uuid, "unavailable-0000_D1_00_0");
        assert_eq!(snapshot.gpus[1].index, 1);
        assert!(snapshot.nvidia_message.as_deref().unwrap_or_default().contains("0000:D1:00.0"));
        assert!(REMOTE_SCRIPT.contains("nvidia_state=degraded"));
    }

    #[test]
    fn clamps_out_of_range_gpu_telemetry() {
        let gpu = parse_gpu("0, NVIDIA Test, GPU-test, 104.2, -3, -1, 40960, 35, -4").unwrap();
        assert_eq!(gpu.utilization, 100.0);
        assert_eq!(gpu.memory_utilization, 0.0);
        assert_eq!(gpu.memory_used_mb, 0.0);
        assert_eq!(gpu.power_watts, 0.0);
    }

    #[test]
    fn classifies_changed_host_key() {
        assert!(classify_ssh_error("Host key verification failed").contains("中间人攻击"));
    }

    #[test]
    fn classifies_a_local_ssh_proxy_closing_the_connection() {
        assert!(classify_ssh_error("Connection closed by 127.0.0.1 port 7897").contains("本机 SSH 代理"));
    }

    #[test]
    fn excludes_development_and_monitoring_services_from_cpu_tasks() {
        for command in [
            "/usr/bin/python3 /usr/bin/nvitop",
            "/home/test/.vscode-server/bin/node server-main.js",
            "/home/test/.codex/bin/codex app-server",
            "/home/test/.local/bin/claude",
            "/usr/bin/mihomo -d /etc/mihomo",
            "/usr/sbin/openvpn --config client.conf",
        ] {
            assert!(is_system_cpu_process(&PsInfo { command: command.into(), ..Default::default() }));
        }
        assert!(!is_system_cpu_process(&PsInfo { command: "python train.py".into(), ..Default::default() }));
    }

    #[test]
    fn preserves_process_sampling_signal_when_process_query_is_skipped() {
        let process_start = SAMPLE.find("__RACKTOP_GPUPROC__").unwrap();
        let end = SAMPLE.find("__RACKTOP_END__").unwrap();
        let output = format!("{}{}", &SAMPLE[..process_start], &SAMPLE[end..]);
        let snapshot = parse_snapshot("server-1", &output).unwrap();
        assert!(!snapshot.processes_sampled);
        assert!(snapshot.processes.is_empty());
        assert!(snapshot.cpu_processes.is_empty());
    }

    #[test]
    fn termination_only_accepts_safe_process_ids() {
        assert!(termination_script(1).is_err());
        let script = termination_script(4242).unwrap();
        assert!(script.contains("process_uid"));
        assert!(script.contains("process_start"));
        assert!(script.contains("frontier=\"$pid\""));
        assert!(script.contains("pgrep -P \"$parent_pid\""));
        assert!(script.contains("target_records"));
        assert!(script.contains("kill -TERM \"$target_pid\""));
        assert!(script.contains("remaining_start"));
        assert!(script.contains("__RACKTOP_TERMINATE_REMAINING__"));
        assert!(!script.contains("kill -TERM -- \"-$process_pgid\""));
    }

    #[test]
    fn collector_prefers_standard_gpu_process_memory_field_with_legacy_fallback() {
        assert!(REMOTE_SCRIPT.contains("used_gpu_memory"));
        assert!(REMOTE_SCRIPT.contains("used_memory"));
        assert!(REMOTE_SCRIPT.contains("query_gpu_processes \"-i $gpu_index\""));
    }

    #[test]
    fn user_cpu_collection_cannot_be_parsed_as_an_awk_file_redirect() {
        assert!(REMOTE_SCRIPT.contains("printf \"%.2f\\n\", (n>0?s/n:s+0)"));
        assert!(!REMOTE_SCRIPT.contains("printf \"%.2f\\n\", n>0?s/n:s+0"));
    }

    #[test]
    fn disk_collection_falls_back_to_local_filesystems_when_a_network_mount_stalls() {
        assert!(REMOTE_SCRIPT.contains("timeout -k 1 3 df -P -k -x tmpfs -x devtmpfs"));
        assert!(REMOTE_SCRIPT.contains("df -P -k -l -x tmpfs -x devtmpfs"));
    }

    #[test]
    fn legacy_user_cpu_files_require_exact_content_before_recovery() {
        assert!(REMOTE_SCRIPT.contains("cleanup_expected=\"${cleanup_cpu_count}.00\""));
        assert!(REMOTE_SCRIPT.contains("[ \"$(cat \"$cleanup_candidate\" 2>/dev/null)\" = \"$cleanup_expected\" ]"));
        assert!(REMOTE_SCRIPT.contains("[ ! -L \"$cleanup_candidate\" ]"));
        assert!(REMOTE_SCRIPT.contains("[ \"$cleanup_links\" = 1 ]"));
        assert!(REMOTE_SCRIPT.contains("mv \"$cleanup_candidate\" \"$cleanup_recovery/$cleanup_name\""));
        assert!(!REMOTE_SCRIPT.contains("rm -f \"$cleanup_candidate\""));
    }

    #[test]
    fn legacy_user_cpu_recovery_runs_once_without_blocking_collection() {
        assert!(REMOTE_SCRIPT.contains("mkdir \"$cleanup_lock\" 2>/dev/null"));
        assert!(REMOTE_SCRIPT.contains(") </dev/null >/dev/null 2>&1 &"));
        assert!(REMOTE_SCRIPT.contains("renice 19 -p \"$cleanup_pid\""));
        assert!(REMOTE_SCRIPT.contains("ionice -c 3 -p \"$cleanup_pid\""));
        assert!(REMOTE_SCRIPT.contains("[ \"$cleanup_complete\" = 1 ] && touch \"$cleanup_marker\""));
        assert!(REMOTE_SCRIPT.find(") </dev/null >/dev/null 2>&1 &").unwrap()
            < REMOTE_SCRIPT.find("printf '__RACKTOP_USER__").unwrap());
    }

    #[test]
    fn legacy_user_cpu_recovery_marks_an_empty_scan_complete() {
        let loop_end = REMOTE_SCRIPT.find("[ \"$cleanup_complete\" = 1 ] && touch \"$cleanup_marker\"").unwrap();
        assert!(REMOTE_SCRIPT[..loop_end].contains("cleanup_complete=1"));
        assert!(!REMOTE_SCRIPT[..loop_end].contains("cleanup_found"));
    }

    #[test]
    fn recognizes_ascend_snapshots_without_changing_gpu_compatibility_fields() {
        let sample = SAMPLE.replace("__RACKTOP_NVIDIA__", "__RACKTOP_ACCELERATOR__\nascend\n__RACKTOP_NVIDIA__")
            .replace("NVIDIA GeForce RTX 4090 D, GPU-abc", "Ascend 910B, NPU-0-0");
        let snapshot = parse_snapshot("server-npu", &sample).unwrap();
        assert_eq!(snapshot.accelerator_vendor, "ascend");
        assert_eq!(snapshot.gpus[0].uuid, "NPU-0-0");
        assert!(REMOTE_SCRIPT.contains("npu-smi info"));
        assert!(REMOTE_SCRIPT.contains("Ascend"));
    }

    #[test]
    fn ssh_agent_ignores_stale_identity_file() {
        let server = Server {
            id: "server-1".into(), name: "GPU".into(), location: None, host: "example.com".into(), port: 22,
            username: "user".into(), ssh_alias: None, identity_file: Some("~/.ssh/stale_key".into()), proxy_jump: None,
            tags: Vec::new(), sampling_interval_seconds: 2, history_retention_days: 90, remote_history_enabled: false,
            remote_history_last_sync_at: None, sort_order: 0, auth_method: "sshAgent".into(), status: "unknown".into(),
            last_error: None, last_seen_at: None,
        };

        assert_eq!(explicit_identity_file(&server), None);
        assert!(!collection_display_command(&server, false, false).contains("stale_key"));
    }

    #[test]
    fn explicit_private_key_is_restricted_to_that_identity() {
        let server = Server {
            id: "server-1".into(), name: "GPU".into(), location: None, host: "example.com".into(), port: 22,
            username: "user".into(), ssh_alias: None, identity_file: Some("~/.ssh/id_ed25519".into()), proxy_jump: None,
            tags: Vec::new(), sampling_interval_seconds: 2, history_retention_days: 90, remote_history_enabled: false,
            remote_history_last_sync_at: None, sort_order: 0, auth_method: "privateKey".into(), status: "unknown".into(),
            last_error: None, last_seen_at: None,
        };
        let command = collection_display_command(&server, false, false);

        assert_eq!(explicit_identity_file(&server), Some("~/.ssh/id_ed25519"));
        assert!(command.contains("-o IdentitiesOnly=yes"));
        assert!(command.contains("-i '~/.ssh/id_ed25519'"));
    }

    #[test]
    fn keeps_driver_reported_gpu_process_when_ps_cannot_see_the_pid() {
        let output = SAMPLE.replace(
            "tongzh 1000 4242 1 4242 12.5 2.0 204800 01:20 python train.py\n",
            "",
        );
        let snapshot = parse_snapshot("server-1", &output).unwrap();
        assert_eq!(snapshot.processes.len(), 1);
        assert_eq!(snapshot.processes[0].pid, 4242);
        assert_eq!(snapshot.processes[0].username, "unknown");
        assert_eq!(snapshot.processes[0].command, "python");
        assert_eq!(snapshot.processes[0].memory_used_mb, 2048.0);
    }
}
