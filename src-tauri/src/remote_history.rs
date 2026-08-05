use crate::{
    collector::{classify_ssh_error, configured_ssh_command},
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

pub async fn remove(server: &Server, password: Option<&str>) -> Result<(), String> {
    let output = run_remote_command(server, password, REMOTE_REMOVE_SCRIPT, Duration::from_secs(20)).await?;
    if output.lines().any(|line| line.trim() == "__RACKTOP_REMOTE_HISTORY_REMOVED__") { Ok(()) } else { Err("远端 RackTop 数据清理后未返回确认标记".into()) }
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
    Ok(HistoryPoint { timestamp, cpu_utilization, memory_utilization, swap_utilization, gpu_utilizations, gpu_memory_utilizations })
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
    fn parses_privacy_scoped_usage_rows() {
        let point = parse_usage_line("v1|1722700800|GPU-a|alice|60|245760.00|60").unwrap();
        assert_eq!(point.username, "alice");
        assert_eq!(point.active_seconds, 60);
    }
}
