use crate::{
    collector::{classify_ssh_error, configured_ssh_command, configured_ssh_command_without_control},
    models::{HistoryPoint, Server, UsagePoint},
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::process::Stdio;
use tokio::time::{timeout, Duration};

const REMOTE_DIRECTORY: &str = "$HOME/.racktop";
const REMOTE_COLLECTOR_SCRIPT: &str = include_str!("../assets/remote-history-collector.sh");
const REMOTE_DAEMON_SCRIPT: &str = include_str!("../assets/remote-history-daemon.sh");
const REMOTE_REMOVE_SCRIPT: &str = r#"set -eu
state=$HOME/.racktop
if [ -r "$state/.daemon.pid" ]; then
  pid="$(cat "$state/.daemon.pid" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o args= 2>/dev/null | grep -F "$state/.daemon.sh" >/dev/null 2>&1; then
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  fi
fi
rm -rf -- "$state"
printf '__RACKTOP_REMOTE_HISTORY_REMOVED__\n'
"#;

pub async fn configure(server: &Server, password: Option<&str>) -> Result<(), String> {
    if server.remote_history_enabled {
        install(server, password).await
    } else {
        disable(server, password).await
    }
}

pub async fn remove(server: &Server, password: Option<&str>, managed_public_key: Option<&str>) -> Result<(), String> {
    let script = build_remove_script(managed_public_key)?;
    let output = run_remote_cleanup_command(server, password, &script, Duration::from_secs(8)).await?;
    if !output.lines().any(|line| line.trim() == "__RACKTOP_REMOTE_HISTORY_REMOVED__") {
        return Err("远端 RackTop 数据清理后未返回确认标记".into());
    }
    if managed_public_key.is_some() && !output.lines().any(|line| line.trim() == "__RACKTOP_SSH_ACCESS_REVOKED__") {
        return Err("远端免密登录撤销后未返回确认标记".into());
    }
    Ok(())
}

fn build_remove_script(managed_public_key: Option<&str>) -> Result<String, String> {
    let Some(public_key) = managed_public_key else {
        return Ok(REMOTE_REMOVE_SCRIPT.to_string());
    };
    let key_blob = public_key.split_whitespace().nth(1)
        .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=')))
        .ok_or("RackTop 专用公钥格式无效，无法撤销免密登录")?;
    STANDARD.decode(key_blob).map_err(|_| "RackTop 专用公钥格式无效，无法撤销免密登录".to_string())?;
    Ok(format!(r#"{REMOTE_REMOVE_SCRIPT}
authorized_keys="$HOME/.ssh/authorized_keys"
if [ -f "$authorized_keys" ]; then
  key_blob='{key_blob}'
  temporary="$authorized_keys.racktop.$$"
  awk -v key="$key_blob" '{{ keep=1; for (i=1; i<NF; i++) if ($i ~ /^(ssh-|ecdsa-|sk-)/ && $(i+1) == key) keep=0; if (keep) print }}' "$authorized_keys" > "$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$authorized_keys"
fi
printf '__RACKTOP_SSH_ACCESS_REVOKED__\n'
"#))
}

pub async fn fetch(server: &Server, password: Option<&str>, since_timestamp: i64) -> Result<Vec<HistoryPoint>, String> {
    if !server.remote_history_enabled { return Ok(Vec::new()); }
    let since = since_timestamp.max(0);
    let script = format!(
        "history={REMOTE_DIRECTORY}/.history-v1.tsv; if [ -r \"$history\" ]; then awk -F '|' -v since={since} '$1 == \"v1\" && $2 >= since' \"$history\"; fi"
    );
    let output = run_remote_command(server, password, &script, Duration::from_secs(20)).await?;
    parse_history(&output)
}

pub async fn fetch_usage(server: &Server, password: Option<&str>, since_timestamp: i64) -> Result<Vec<UsagePoint>, String> {
    if !server.remote_history_enabled { return Ok(Vec::new()); }
    let since = since_timestamp.max(0);
    let script = format!("usage={REMOTE_DIRECTORY}/.usage-v1.tsv; if [ -r \"$usage\" ]; then awk -F '|' -v since={since} '$1 == \"v1\" && $2 >= since' \"$usage\"; fi");
    let output = run_remote_command(server, password, &script, Duration::from_secs(20)).await?;
    Ok(output.lines().filter(|line| !line.trim().is_empty()).filter_map(|line| parse_usage_line(line).ok()).collect())
}

async fn install(server: &Server, password: Option<&str>) -> Result<(), String> {
    let encoded = STANDARD.encode(REMOTE_COLLECTOR_SCRIPT);
    let daemon_encoded = STANDARD.encode(REMOTE_DAEMON_SCRIPT);
    let script = format!(r#"set -eu
state={REMOTE_DIRECTORY}
mkdir -p "$state"
chmod 700 "$state"
printf '%s' '{encoded}' | base64 -d > "$state/.collector.sh"
printf '%s' '{daemon_encoded}' | base64 -d > "$state/.daemon.sh"
chmod 700 "$state/.collector.sh" "$state/.daemon.sh"
touch "$state/.client-heartbeat"
running=0
if [ -r "$state/.daemon.pid" ]; then
  pid="$(cat "$state/.daemon.pid" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o args= 2>/dev/null | grep -F "$state/.daemon.sh" >/dev/null 2>&1; then running=1; fi
fi
if [ "$running" -ne 1 ]; then
  rm -f "$state/.daemon.pid"
  if command -v setsid >/dev/null 2>&1; then
    nohup setsid "$state/.daemon.sh" </dev/null >/dev/null 2>&1 &
  else
    nohup "$state/.daemon.sh" </dev/null >/dev/null 2>&1 &
  fi
  ready=0
  for attempt in 1 2 3; do
    sleep 1
    pid="$(cat "$state/.daemon.pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then ready=1; break; fi
  done
  if [ "$ready" -ne 1 ]; then
    printf '远端历史常驻进程启动失败' >&2
    exit 43
  fi
fi
printf '__RACKTOP_REMOTE_HISTORY_READY__\n'
"#);
    let output = run_remote_command(server, password, &script, Duration::from_secs(25)).await?;
    if output.lines().any(|line| line.trim() == "__RACKTOP_REMOTE_HISTORY_READY__") { Ok(()) } else { Err("远端历史任务安装后未返回确认标记".into()) }
}

async fn disable(server: &Server, password: Option<&str>) -> Result<(), String> {
    let script = r#"state=$HOME/.racktop
if [ -r "$state/.daemon.pid" ]; then
  pid="$(cat "$state/.daemon.pid" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o args= 2>/dev/null | grep -F "$state/.daemon.sh" >/dev/null 2>&1; then
    kill "$pid" 2>/dev/null || true
  fi
  rm -f "$state/.daemon.pid"
fi
printf '__RACKTOP_REMOTE_HISTORY_DISABLED__\n'
"#;
    let output = run_remote_command(server, password, script, Duration::from_secs(15)).await?;
    if output.lines().any(|line| line.trim() == "__RACKTOP_REMOTE_HISTORY_DISABLED__") { Ok(()) } else { Err("远端历史任务停止后未返回确认标记".into()) }
}

async fn run_remote_command(server: &Server, password: Option<&str>, script: &str, duration: Duration) -> Result<String, String> {
    let (mut command, target) = configured_ssh_command(server, password)?;
    command.arg(target).arg(script).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let output = timeout(duration, command.output()).await.map_err(|_| format!("连接 {} 同步历史超时", server.name))?.map_err(|error| format!("无法启动系统 ssh：{error}"))?;
    if !output.status.success() {
        return Err(classify_ssh_error(String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

async fn run_remote_cleanup_command(server: &Server, password: Option<&str>, script: &str, duration: Duration) -> Result<String, String> {
    let (mut command, target) = configured_ssh_command_without_control(server, password)?;
    command.arg(target).arg(script).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let output = timeout(duration, command.output()).await.map_err(|_| format!("连接 {} 删除远端数据超时", server.name))?.map_err(|error| format!("无法启动系统 ssh：{error}"))?;
    if !output.status.success() {
        return Err(classify_ssh_error(String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn parse_history(output: &str) -> Result<Vec<HistoryPoint>, String> {
    Ok(output.lines().filter(|line| !line.trim().is_empty()).filter_map(|line| parse_history_line(line).ok()).collect())
}

fn parse_history_line(line: &str) -> Result<HistoryPoint, String> {
    let fields: Vec<&str> = line.split('|').collect();
    if fields.len() != 6 || fields[0] != "v1" { return Err("远端历史包含无法识别的记录".into()); }
    let timestamp = fields[1].parse::<i64>().map_err(|_| "远端历史时间戳无效".to_string())?;
    let cpu_utilization = parse_percent(fields[2])?;
    let memory_utilization = parse_percent(fields[3])?;
    let swap_utilization = parse_percent(fields[4])?;
    let mut gpu_utilizations = std::collections::HashMap::new();
    let mut gpu_memory_utilizations = std::collections::HashMap::new();
    for gpu in fields[5].split(';').filter(|value| !value.is_empty()) {
        let values: Vec<&str> = gpu.split(',').collect();
        if values.len() != 3 || values[0].is_empty() { return Err("远端 GPU 历史记录无效".into()); }
        gpu_utilizations.insert(values[0].to_string(), parse_percent(values[1])?);
        gpu_memory_utilizations.insert(values[0].to_string(), parse_percent(values[2])?);
    }
    Ok(HistoryPoint { timestamp, is_compacted: false, cpu_utilization, memory_utilization, swap_utilization, cpu_min: cpu_utilization, cpu_max: cpu_utilization, memory_min: memory_utilization, memory_max: memory_utilization, swap_min: swap_utilization, swap_max: swap_utilization, gpu_mins: gpu_utilizations.clone(), gpu_maxes: gpu_utilizations.clone(), gpu_memory_mins: gpu_memory_utilizations.clone(), gpu_memory_maxes: gpu_memory_utilizations.clone(), gpu_utilizations, gpu_memory_utilizations })
}

fn parse_percent(value: &str) -> Result<f64, String> {
    let number = value.trim().parse::<f64>().map_err(|_| "远端历史百分比无效".to_string())?;
    if !number.is_finite() { return Err("远端历史百分比无效".into()); }
    Ok(number.clamp(0.0, 100.0))
}

fn parse_usage_line(line: &str) -> Result<UsagePoint, String> {
    let fields: Vec<&str> = line.split('|').collect();
    if fields.len() != 7 || fields[0] != "v1" || fields[2].is_empty() || fields[3].is_empty() { return Err("远端使用分布包含无法识别的记录".into()); }
    let point = UsagePoint {
        timestamp: fields[1].parse().map_err(|_| "远端使用分布时间戳无效".to_string())?,
        gpu_uuid: fields[2].to_string(),
        username: fields[3].to_string(),
        active_seconds: fields[4].parse().map_err(|_| "远端活跃时间无效".to_string())?,
        memory_mb_seconds: fields[5].parse().map_err(|_| "远端显存积分无效".to_string())?,
        coverage_seconds: fields[6].parse().map_err(|_| "远端采样覆盖量无效".to_string())?,
    };
    if point.active_seconds < 0 || point.coverage_seconds <= 0 || !point.memory_mb_seconds.is_finite() || point.memory_mb_seconds < 0.0 { return Err("远端使用分布数值无效".into()); }
    Ok(point)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_remote_history_with_multiple_gpus() {
        let points = parse_history("v1|1722700800|12.50|40.25|3.00|GPU-a,80.00,50.00;GPU-b,0.00,1.25\n").unwrap();
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].timestamp, 1_722_700_800);
        assert_eq!(points[0].gpu_utilizations.get("GPU-a"), Some(&80.0));
        assert_eq!(points[0].gpu_memory_utilizations.get("GPU-b"), Some(&1.25));
    }

    #[test]
    fn skips_legacy_rows_with_blank_percentages_without_losing_valid_history() {
        let points = parse_history(
            "v1|1722700740||||GPU-a,0.00,0.06\nv1|1722700800|12.50|40.25|3.00|GPU-a,80.00,50.00\n",
        ).unwrap();
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].timestamp, 1_722_700_800);
    }

    #[test]
    fn collector_keeps_thirty_days_and_avoids_sensitive_process_data() {
        assert!(REMOTE_COLLECTOR_SCRIPT.contains("2592000"));
        assert!(REMOTE_COLLECTOR_SCRIPT.contains("value=(total > 0 ?"));
        assert!(REMOTE_COLLECTOR_SCRIPT.contains("umask 077"));
        assert!(REMOTE_COLLECTOR_SCRIPT.contains("$HOME/.racktop"));
        assert!(REMOTE_COLLECTOR_SCRIPT.contains(".history-v1.tsv"));
        assert!(REMOTE_DAEMON_SCRIPT.contains(".daemon.pid"));
        assert!(REMOTE_DAEMON_SCRIPT.contains(".client-heartbeat"));
        assert!(REMOTE_DAEMON_SCRIPT.contains("-gt 90"));
        assert!(REMOTE_DAEMON_SCRIPT.contains("sleep 60"));
        assert!(REMOTE_COLLECTOR_SCRIPT.contains("nvidia-smi --query-gpu=uuid,utilization.gpu,memory.used,memory.total"));
        assert!(REMOTE_COLLECTOR_SCRIPT.contains("--query-compute-apps=gpu_uuid,pid,used_memory"));
        assert!(REMOTE_COLLECTOR_SCRIPT.contains(".usage-v1.tsv"));
        assert!(REMOTE_COLLECTOR_SCRIPT.contains("__racktop_coverage__"));
        assert!(!REMOTE_COLLECTOR_SCRIPT.contains("command="));
        assert!(!REMOTE_COLLECTOR_SCRIPT.contains("args="));
    }

    #[test]
    fn remote_cleanup_script_targets_only_racktop_state() {
        assert!(REMOTE_REMOVE_SCRIPT.contains("state=$HOME/.racktop"));
        assert!(REMOTE_REMOVE_SCRIPT.contains("grep -F \"$state/.daemon.sh\""));
        assert!(REMOTE_REMOVE_SCRIPT.contains("kill -KILL \"$pid\""));
        assert!(REMOTE_REMOVE_SCRIPT.contains("rm -rf -- \"$state\""));
        assert!(!REMOTE_REMOVE_SCRIPT.contains("rm -rf -- $HOME"));
    }

    #[test]
    fn revocation_removes_only_the_matching_public_key_blob() {
        let directory = tempfile::tempdir().unwrap();
        let ssh_directory = directory.path().join(".ssh");
        std::fs::create_dir(&ssh_directory).unwrap();
        let authorized_keys = ssh_directory.join("authorized_keys");
        let matching_blob = STANDARD.encode(b"racktop-key-material");
        let other_blob = STANDARD.encode(b"another-key-material");
        let options_blob = STANDARD.encode(b"options-key-material");
        let original = format!(
            "ssh-ed25519 {matching_blob} racktop-managed:old-comment\nssh-ed25519 {other_blob} racktop-managed:same-looking-comment\nfrom=\"10.0.0.0/8\",no-agent-forwarding ssh-ed25519 {options_blob} constrained-key\nssh-ed25519 {matching_blob} duplicate-racktop-entry\n\n"
        );
        std::fs::write(&authorized_keys, original).unwrap();

        let script = build_remove_script(Some(&format!("ssh-ed25519 {matching_blob} ignored-comment"))).unwrap();
        let output = std::process::Command::new("sh")
            .arg("-c")
            .arg(script)
            .env("HOME", directory.path())
            .output()
            .unwrap();

        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert!(String::from_utf8_lossy(&output.stdout).contains("__RACKTOP_SSH_ACCESS_REVOKED__"));
        let filtered = std::fs::read_to_string(authorized_keys).unwrap();
        assert!(!filtered.contains(&matching_blob));
        assert!(filtered.contains(&format!("ssh-ed25519 {other_blob} racktop-managed:same-looking-comment")));
        assert!(filtered.contains(&format!("from=\"10.0.0.0/8\",no-agent-forwarding ssh-ed25519 {options_blob} constrained-key")));
        assert!(filtered.ends_with("\n\n"));
    }

    #[test]
    fn revocation_rejects_an_invalid_key_blob_before_running_ssh() {
        assert!(build_remove_script(Some("ssh-ed25519 not-a/base64'value")).is_err());
    }

    #[test]
    fn parses_privacy_scoped_usage_rows() {
        let point = parse_usage_line("v1|1722700800|GPU-a|alice|60|245760.00|60").unwrap();
        assert_eq!(point.username, "alice");
        assert_eq!(point.active_seconds, 60);
    }
}
