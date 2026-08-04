use crate::models::{CpuProcessMetric, GpuMetric, ProcessMetric, Server, Snapshot, SystemMetric};
use std::{collections::{HashMap, HashSet}, process::Stdio, time::{SystemTime, UNIX_EPOCH}};
use tokio::{process::Command, time::{timeout, Duration}};

const REMOTE_SCRIPT: &str = r#"export LANG=C LC_ALL=C;
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
printf '__RACKTOP_USERCPU__\n'; ps -u "$(id -un)" -o pcpu= 2>/dev/null | awk -v n="$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf 1)" '{s+=$1} END {printf "%.2f\n", n>0?s/n:s+0}';
printf '__RACKTOP_NVIDIA__\n';
if ! command -v nvidia-smi >/dev/null 2>&1; then
  printf 'missing\n';
elif ! nvidia-smi -L >/dev/null 2>&1; then
  printf 'failed\n'; nvidia-smi -L 2>&1 || true;
else
  printf 'available\n';
  printf '__RACKTOP_GPU__\n';
  nvidia-smi --query-gpu=index,name,uuid,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits;
fi;
if [ "${RACKTOP_INCLUDE_PROCESSES:-1}" = "1" ]; then
  printf '__RACKTOP_GPUPROC__\n';
  gpu_proc="";
  if command -v nvidia-smi >/dev/null 2>&1; then gpu_proc="$(nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null || true)"; printf '%s\n' "$gpu_proc"; fi;
  printf '__RACKTOP_GPUPMON__\n';
  if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi pmon -c 1 -s um 2>/dev/null || true; fi;
  printf '__RACKTOP_PS__\n';
  gpu_pids="$(printf '%s\n' "$gpu_proc" | cut -d, -f2 | tr -d ' ' | paste -sd, -)";
  ps -eo user=,uid=,pid=,ppid=,pgid=,pcpu=,pmem=,rss=,etime=,args= --sort=-pcpu 2>/dev/null | awk -v gpu_pids="$gpu_pids" -v uid_min="$uid_min" 'BEGIN { n=split(gpu_pids, ids, ","); for (i=1; i<=n; i++) if (ids[i] != "") gpu[ids[i]]=1 } { is_gpu=($3 in gpu); is_child=($4 in gpu); is_user=($2 >= uid_min); is_main=($3 == $5 && $6 > 0); has_memory=($8 > 1048576); if (is_gpu || (is_user && has_memory && (is_child || (is_main && main_count < 64)))) { print; if (!is_gpu && is_main && !is_child) main_count++ } }' || true;
fi;
printf '__RACKTOP_END__\n';"#;

pub async fn collect(server: &Server) -> Result<Snapshot, String> {
    collect_with_password(server, None, true).await
}

pub async fn collect_with_password(server: &Server, password: Option<&str>, include_processes: bool) -> Result<Snapshot, String> {
    let (mut command, target) = configured_ssh_command(server, password)?;
    command.arg(target).arg(format!(
        "RACKTOP_INCLUDE_PROCESSES={} RACKTOP_REMOTE_HISTORY={};{REMOTE_SCRIPT}",
        if include_processes { 1 } else { 0 },
        if server.remote_history_enabled { 1 } else { 0 },
    )).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let output = timeout(Duration::from_secs(15), command.output()).await.map_err(|_| format!("连接 {} 超时（15 秒）", server.name))?.map_err(|error| format!("无法启动系统 ssh：{error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(classify_ssh_error(&stderr));
    }
    parse_snapshot(&server.id, &String::from_utf8_lossy(&output.stdout))
}

pub(crate) fn configured_ssh_command(server: &Server, password: Option<&str>) -> Result<(Command, String), String> {
    let mut command = Command::new("ssh");
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
    command.args(["-o", "ControlMaster=auto", "-o", "ControlPersist=600", "-o", "ControlPath=/tmp/racktop-%C"]);
    if let Some(identity) = server.identity_file.as_deref().filter(|value| !value.is_empty()) {
        command.args(["-i", identity]);
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

    let nvidia_lines = sections.get("NVIDIA").cloned().unwrap_or_default();
    let nvidia_smi = nvidia_lines.first().map(String::as_str).unwrap_or("missing").to_string();
    let nvidia_message = match nvidia_smi.as_str() {
        "available" => None,
        "missing" => Some("服务器未检测到 nvidia-smi；可能没有 NVIDIA GPU，或驱动工具未安装/不在 PATH 中。".into()),
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
    Ok(Snapshot { server_id: server_id.into(), hostname, username, os_id: os_id.into(), os_name: os_name.into(), timestamp, status: if nvidia_smi == "available" { "online".into() } else { "warning".into() }, system, gpus, processes, cpu_processes, processes_sampled, nvidia_smi, nvidia_message })
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
current_user="$(id -un)"
process_user="$(ps -o user= -p "$pid" 2>/dev/null | awk '{{print $1; exit}}')"
process_pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
if [ -z "$process_user" ] || [ -z "$process_pgid" ]; then printf '__RACKTOP_TERMINATE_NOT_FOUND__\n'; exit 44; fi
if [ "$process_user" != "$current_user" ]; then printf '__RACKTOP_TERMINATE_OWNER_MISMATCH__\n'; exit 45; fi
if [ "$process_pgid" != "$pid" ]; then printf '__RACKTOP_TERMINATE_NOT_LEADER__\n'; exit 46; fi
child_pids="$(pgrep -P "$pid" 2>/dev/null || true)"
kill -TERM -- "-$process_pgid" 2>/dev/null || true
sleep 3
remaining_user="$(ps -o user= -p "$pid" 2>/dev/null | awk '{{print $1; exit}}')"
remaining_pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
if [ "$remaining_user" = "$current_user" ] && [ "$remaining_pgid" = "$process_pgid" ]; then kill -KILL -- "-$process_pgid" 2>/dev/null || true; fi
pkill -TERM -P "$pid" 2>/dev/null || true
for child_pid in $child_pids; do kill -TERM "$child_pid" 2>/dev/null || true; done
sleep 2
pkill -KILL -P "$pid" 2>/dev/null || true
for child_pid in $child_pids; do
  child_user="$(ps -o user= -p "$child_pid" 2>/dev/null | awk '{{print $1; exit}}')"
  if [ "$child_user" = "$current_user" ]; then kill -KILL "$child_pid" 2>/dev/null || true; fi
done
printf '__RACKTOP_TERMINATE_OK__\n'"#))
}

pub async fn terminate_process_group(server: &Server, password: Option<&str>, pid: u32) -> Result<String, String> {
    let script = termination_script(pid)?;
    let (mut command, target) = configured_ssh_command(server, password)?;
    command.arg(target).arg(script).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let output = timeout(Duration::from_secs(12), command.output()).await.map_err(|_| format!("结束 PID {pid} 超时（12 秒）"))?.map_err(|error| format!("无法启动系统 ssh：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if output.status.success() && stdout.contains("__RACKTOP_TERMINATE_OK__") {
        return Ok(format!("已结束 PID {pid} 的进程组及残留子进程"));
    }
    if stdout.contains("__RACKTOP_TERMINATE_NOT_FOUND__") { return Err(format!("PID {pid} 已不存在，请刷新后重试")); }
    if stdout.contains("__RACKTOP_TERMINATE_OWNER_MISMATCH__") { return Err(format!("PID {pid} 不属于当前 SSH 用户，操作已阻止")); }
    if stdout.contains("__RACKTOP_TERMINATE_NOT_LEADER__") { return Err(format!("PID {pid} 不是进程组主进程，操作已阻止")); }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() { format!("无法结束 PID {pid}") } else { classify_ssh_error(&stderr) })
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
        assert!(script.contains("process_user"));
        assert!(script.contains("process_pgid"));
        assert!(script.contains("[ \"$process_pgid\" != \"$pid\" ]"));
        assert!(script.contains("kill -TERM -- \"-$process_pgid\""));
        assert!(script.contains("child_pids=\"$(pgrep -P \"$pid\""));
        assert!(script.contains("pkill -KILL -P \"$pid\""));
    }
}
