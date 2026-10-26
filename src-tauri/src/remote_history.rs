use crate::{
    collector::{
        classify_ssh_error, configured_ssh_command, configured_ssh_command_without_control,
    },
    models::{HistoryPoint, Server, UsagePoint},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};
use std::process::Stdio;
use tokio::time::{Duration, timeout};

const REMOTE_COLLECTOR_SCRIPT: &str = concat!(include_str!("../assets/ascend-collector.sh"), include_str!("../assets/remote-history-collector.sh"));
const REMOTE_DAEMON_SCRIPT: &str = include_str!("../assets/remote-history-daemon.sh");
const REMOTE_USAGE_SCRIPT: &str = include_str!("../assets/remote-history-usage.sh");
const REMOTE_REMOVE_SCRIPT: &str = r#"set -eu
state="${RACKTOP_STATE_DIR:?}"
if [ -r "$state/.daemon.pid" ]; then
  pid="$(cat "$state/.daemon.pid" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o args= 2>/dev/null | grep -F "sh $state/.daemon.sh" >/dev/null 2>&1; then
    kill "$pid" 2>/dev/null || true
    sleep 1
    if kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o args= 2>/dev/null | grep -F "sh $state/.daemon.sh" >/dev/null 2>&1; then kill -KILL "$pid" 2>/dev/null || true; fi
  fi
fi
rm -rf -- "$state"
printf '__RACKTOP_REMOTE_HISTORY_REMOVED__\n'
"#;

pub(crate) fn remote_state_directory(server: &Server) -> String {
    remote_state_directory_for_endpoint(&server.host, server.port)
}

fn remote_state_directory_for_endpoint(host: &str, port: u16) -> String {
    let normalized_host = host
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let digest = Sha256::digest(format!("{normalized_host}:{port}").as_bytes());
    let host_slug: String = normalized_host
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .take(48)
        .collect();
    format!("$HOME/.racktop/remote-history/{host_slug}-{port}-{digest:x}")
}

fn stop_verified_daemon(state_dir: &str) -> String {
    format!(r#"state="{state_dir}"
if [ -r "$state/.daemon.pid" ]; then
  pid="$(cat "$state/.daemon.pid" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o args= 2>/dev/null | grep -F "sh $state/.daemon.sh" >/dev/null 2>&1; then
    kill "$pid" 2>/dev/null || true
    sleep 1
    if kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o args= 2>/dev/null | grep -F "sh $state/.daemon.sh" >/dev/null 2>&1; then kill -KILL "$pid" 2>/dev/null || true; fi
  fi
fi
"#)
}

fn stop_legacy_shared_daemon() -> &'static str {
    r#"legacy="$HOME/.racktop"
if [ -r "$legacy/.daemon.pid" ]; then
  legacy_pid="$(cat "$legacy/.daemon.pid" 2>/dev/null || true)"
  if [ -n "$legacy_pid" ] && kill -0 "$legacy_pid" 2>/dev/null && ps -p "$legacy_pid" -o args= 2>/dev/null | grep -F "sh $legacy/.daemon.sh" >/dev/null 2>&1; then
    kill "$legacy_pid" 2>/dev/null || true
    sleep 1
    if kill -0 "$legacy_pid" 2>/dev/null && ps -p "$legacy_pid" -o args= 2>/dev/null | grep -F "sh $legacy/.daemon.sh" >/dev/null 2>&1; then kill -KILL "$legacy_pid" 2>/dev/null || true; fi
  fi
fi
"#
}

pub async fn configure(server: &Server, password: Option<&str>) -> Result<(), String> {
    if server.remote_history_enabled {
        install(server, password).await
    } else {
        disable(server, password).await
    }
}

pub async fn remove(
    server: &Server,
    password: Option<&str>,
    managed_public_key: Option<&str>,
) -> Result<(), String> {
    let script = build_remove_script(&remote_state_directory(server), managed_public_key)?;
    let output =
        run_remote_cleanup_command(server, password, &script, Duration::from_secs(8)).await?;
    if !output
        .lines()
        .any(|line| line.trim() == "__RACKTOP_REMOTE_HISTORY_REMOVED__")
    {
        return Err("远端 RackTop 数据清理后未返回确认标记".into());
    }
    if managed_public_key.is_some()
        && !output
            .lines()
            .any(|line| line.trim() == "__RACKTOP_SSH_ACCESS_REVOKED__")
    {
        return Err("远端免密登录撤销后未返回确认标记".into());
    }
    Ok(())
}

fn build_remove_script(state_dir: &str, managed_public_key: Option<&str>) -> Result<String, String> {
    let scoped_script = format!("RACKTOP_STATE_DIR=\"{state_dir}\"; {REMOTE_REMOVE_SCRIPT}");
    let Some(public_key) = managed_public_key else {
        return Ok(scoped_script);
    };
    let key_blob = public_key
        .split_whitespace()
        .nth(1)
        .filter(|value| {
            !value.is_empty()
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
        })
        .ok_or("RackTop 专用公钥格式无效，无法撤销免密登录")?;
    STANDARD
        .decode(key_blob)
        .map_err(|_| "RackTop 专用公钥格式无效，无法撤销免密登录".to_string())?;
    Ok(format!(
        r#"RACKTOP_STATE_DIR="{state_dir}"; {REMOTE_REMOVE_SCRIPT}
authorized_keys="$HOME/.ssh/authorized_keys"
if [ -f "$authorized_keys" ]; then
  key_blob='{key_blob}'
  temporary="$authorized_keys.racktop.$$"
  awk -v key="$key_blob" '{{ keep=1; for (i=1; i<NF; i++) if ($i ~ /^(ssh-|ecdsa-|sk-)/ && $(i+1) == key) keep=0; if (keep) print }}' "$authorized_keys" > "$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$authorized_keys"
fi
printf '__RACKTOP_SSH_ACCESS_REVOKED__\n'
"#
    ))
}

pub async fn fetch(
    server: &Server,
    password: Option<&str>,
    since_timestamp: i64,
) -> Result<Vec<HistoryPoint>, String> {
    if !server.remote_history_enabled {
        return Ok(Vec::new());
    }
    let since = since_timestamp.max(0);
    let state_dir = remote_state_directory(server);
    let script = format!(
        "history=\"{state_dir}/.history-v1.tsv\"; if [ -r \"$history\" ]; then awk -F '|' -v since={since} '($1 == \"v1\" || $1 == \"v2\" || $1 == \"v3\") && $2 >= since' \"$history\"; fi"
    );
    let output = run_remote_command(server, password, &script, Duration::from_secs(20)).await?;
    parse_history(&output)
}

pub async fn fetch_usage(
    server: &Server,
    password: Option<&str>,
    since_timestamp: i64,
) -> Result<Vec<UsagePoint>, String> {
    if !server.remote_history_enabled {
        return Ok(Vec::new());
    }
    let since = since_timestamp.max(0);
    let state_dir = remote_state_directory(server);
    let script = format!("RACKTOP_STATE_DIR=\"{state_dir}\"; set -- {since}\n{}", REMOTE_USAGE_SCRIPT.replace("\r\n", "\n"));
    let output = run_remote_command(server, password, &script, Duration::from_secs(20)).await?;
    Ok(output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| parse_usage_line(line).ok())
        .collect())
}

async fn install(server: &Server, password: Option<&str>) -> Result<(), String> {
    // Windows checkouts may expose bundled shell assets as CRLF. Normalize before
    // sending them to Linux, where a trailing CR changes `set -e` into an invalid option.
    let collector_script = REMOTE_COLLECTOR_SCRIPT.replace("\r\n", "\n");
    let daemon_script = REMOTE_DAEMON_SCRIPT.replace("\r\n", "\n");
    let state_dir = remote_state_directory(server);
    let encoded = STANDARD.encode(collector_script);
    let daemon_encoded = STANDARD.encode(daemon_script);
    let script = format!(
        r#"set -e
set -u
state="{state_dir}"
command -v flock >/dev/null 2>&1 || {{ printf '远端历史需要 util-linux 的 flock 命令' >&2; exit 1; }}
command -v timeout >/dev/null 2>&1 || {{ printf '远端历史需要 timeout 命令' >&2; exit 1; }}
{}
mkdir -p "$state"
chmod 700 "$state"
export RACKTOP_STATE_DIR="$state"
printf '%s' '{encoded}' | base64 -d > "$state/.collector.sh"
printf '%s' '{daemon_encoded}' | base64 -d > "$state/.daemon.sh"
chmod 700 "$state/.collector.sh" "$state/.daemon.sh"
touch "$state/.client-heartbeat"
running=0
if [ -r "$state/.daemon.pid" ]; then
  pid="$(cat "$state/.daemon.pid" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o args= 2>/dev/null | grep -F "sh $state/.daemon.sh" >/dev/null 2>&1; then running=1; fi
fi
if [ "$running" -ne 1 ]; then
  rm -f "$state/.daemon.pid"
  : > "$state/.daemon.log"
  if command -v setsid >/dev/null 2>&1; then
    nohup setsid sh "$state/.daemon.sh" </dev/null >"$state/.daemon.log" 2>&1 &
  else
    nohup sh "$state/.daemon.sh" </dev/null >"$state/.daemon.log" 2>&1 &
  fi
  ready=0
  for attempt in 1 2 3; do
    sleep 1
    pid="$(cat "$state/.daemon.pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then ready=1; break; fi
  done
  if [ "$ready" -ne 1 ]; then
    printf '远端历史常驻进程启动失败' >&2
    if [ -s "$state/.daemon.log" ]; then printf '：' >&2; tail -n 8 "$state/.daemon.log" >&2; fi
    exit 43
  fi
fi
printf '__RACKTOP_REMOTE_HISTORY_READY__\n'
"#,
        stop_legacy_shared_daemon()
    );
    let output = run_remote_command(server, password, &script, Duration::from_secs(25)).await?;
    if output
        .lines()
        .any(|line| line.trim() == "__RACKTOP_REMOTE_HISTORY_READY__")
    {
        Ok(())
    } else {
        Err("远端历史任务安装后未返回确认标记".into())
    }
}

async fn disable(server: &Server, password: Option<&str>) -> Result<(), String> {
    let state_dir = remote_state_directory(server);
    let script = format!(
        "{}rm -f \"$state/.daemon.pid\"\nprintf '__RACKTOP_REMOTE_HISTORY_DISABLED__\\n'\n",
        stop_verified_daemon(&state_dir),
    );
    let output = run_remote_command(server, password, &script, Duration::from_secs(15)).await?;
    if output
        .lines()
        .any(|line| line.trim() == "__RACKTOP_REMOTE_HISTORY_DISABLED__")
    {
        Ok(())
    } else {
        Err("远端历史任务停止后未返回确认标记".into())
    }
}

async fn run_remote_command(
    server: &Server,
    password: Option<&str>,
    script: &str,
    duration: Duration,
) -> Result<String, String> {
    let (mut command, target) = configured_ssh_command(server, password)?;
    command
        .arg(target)
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = timeout(duration, command.output())
        .await
        .map_err(|_| format!("连接 {} 同步历史超时", server.name))?
        .map_err(|error| format!("无法启动系统 ssh：{error}"))?;
    if !output.status.success() {
        return Err(classify_ssh_error(
            String::from_utf8_lossy(&output.stderr).trim(),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

async fn run_remote_cleanup_command(
    server: &Server,
    password: Option<&str>,
    script: &str,
    duration: Duration,
) -> Result<String, String> {
    let (mut command, target) = configured_ssh_command_without_control(server, password)?;
    command
        .arg(target)
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = timeout(duration, command.output())
        .await
        .map_err(|_| format!("连接 {} 删除远端数据超时", server.name))?
        .map_err(|error| format!("无法启动系统 ssh：{error}"))?;
    if !output.status.success() {
        return Err(classify_ssh_error(
            String::from_utf8_lossy(&output.stderr).trim(),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn parse_history(output: &str) -> Result<Vec<HistoryPoint>, String> {
    Ok(output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| parse_history_line(line).ok())
        .collect())
}

fn parse_history_line(line: &str) -> Result<HistoryPoint, String> {
    let fields: Vec<&str> = line.split('|').collect();
    if fields.len() != 6 || !matches!(fields[0], "v1" | "v2" | "v3") {
        return Err("远端历史包含无法识别的记录".into());
    }
    let timestamp = fields[1]
        .parse::<i64>()
        .map_err(|_| "远端历史时间戳无效".to_string())?;
    let cpu_utilization = parse_percent(fields[2])?;
    let memory_utilization = parse_percent(fields[3])?;
    let swap_utilization = parse_percent(fields[4])?;
    let mut gpu_utilizations = std::collections::HashMap::new();
    let mut gpu_memory_utilizations = std::collections::HashMap::new();
    let mut gpu_temperatures_celsius = std::collections::HashMap::new();
    let mut gpu_power_watts = std::collections::HashMap::new();
    let mut gpu_fan_speeds_percent = std::collections::HashMap::new();
    let mut gpu_other_user_occupancies = std::collections::HashMap::new();
    for gpu in fields[5].split(';').filter(|value| !value.is_empty()) {
        let values: Vec<&str> = gpu.split(',').collect();
        let expected_values = match fields[0] {
            "v1" => 3,
            "v2" => 4,
            "v3" => 7,
            _ => unreachable!(),
        };
        if values.len() != expected_values || values[0].is_empty() {
            return Err("远端 GPU 历史记录无效".into());
        }
        gpu_utilizations.insert(values[0].to_string(), parse_percent(values[1])?);
        gpu_memory_utilizations.insert(values[0].to_string(), parse_percent(values[2])?);
        if matches!(fields[0], "v2" | "v3") {
            gpu_other_user_occupancies.insert(
                values[0].to_string(),
                match values[3] {
                    "0" => false,
                    "1" => true,
                    _ => return Err("远端 GPU 占用状态无效".into()),
                },
            );
        }
        if fields[0] == "v3" {
            if let Some(value) = parse_optional_number(values[4]) {
                gpu_temperatures_celsius.insert(values[0].to_string(), value);
            }
            if let Some(value) = parse_optional_number(values[5]).filter(|value| *value >= 0.0) {
                gpu_power_watts.insert(values[0].to_string(), value);
            }
            if let Some(value) = parse_optional_number(values[6]).filter(|value| (0.0..=100.0).contains(value)) {
                gpu_fan_speeds_percent.insert(values[0].to_string(), Some(value));
            }
        }
    }
    Ok(HistoryPoint {
        telemetry_ranges: Default::default(),
        timestamp,
        is_compacted: false,
        cpu_utilization,
        memory_utilization,
        swap_utilization,
        cpu_min: cpu_utilization,
        cpu_max: cpu_utilization,
        memory_min: memory_utilization,
        memory_max: memory_utilization,
        swap_min: swap_utilization,
        swap_max: swap_utilization,
        gpu_mins: gpu_utilizations.clone(),
        gpu_maxes: gpu_utilizations.clone(),
        gpu_memory_mins: gpu_memory_utilizations.clone(),
        gpu_memory_maxes: gpu_memory_utilizations.clone(),
        gpu_utilizations,
        gpu_memory_utilizations,
        gpu_temperatures_celsius,
        gpu_power_watts,
        gpu_fan_speeds_percent,
        gpu_other_user_occupancies,
    })
}

fn parse_optional_number(value: &str) -> Option<f64> {
    let number = value.trim().parse::<f64>().ok()?;
    number.is_finite().then_some(number)
}

fn parse_percent(value: &str) -> Result<f64, String> {
    let number = value
        .trim()
        .parse::<f64>()
        .map_err(|_| "远端历史百分比无效".to_string())?;
    if !number.is_finite() {
        return Err("远端历史百分比无效".into());
    }
    Ok(number.clamp(0.0, 100.0))
}

fn parse_usage_line(line: &str) -> Result<UsagePoint, String> {
    let fields: Vec<&str> = line.split('|').collect();
    if fields.len() != 7 || !matches!(fields[0], "v1" | "v2") || fields[2].is_empty() || fields[3].is_empty() {
        return Err("远端使用分布包含无法识别的记录".into());
    }
    let point = UsagePoint {
        timestamp: fields[1]
            .parse()
            .map_err(|_| "远端使用分布时间戳无效".to_string())?,
        bucket_seconds: if fields[0] == "v2" { 3_600 } else { 60 },
        gpu_uuid: fields[2].to_string(),
        username: fields[3].to_string(),
        active_seconds: fields[4]
            .parse()
            .map_err(|_| "远端活跃时间无效".to_string())?,
        memory_mb_seconds: fields[5]
            .parse()
            .map_err(|_| "远端显存积分无效".to_string())?,
        coverage_seconds: fields[6]
            .parse()
            .map_err(|_| "远端采样覆盖量无效".to_string())?,
    };
    if point.active_seconds < 0
        || point.coverage_seconds <= 0
        || !point.memory_mb_seconds.is_finite()
        || point.memory_mb_seconds < 0.0
    {
        return Err("远端使用分布数值无效".into());
    }
    Ok(point)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Execute the shipped collector, including its history/usage pipeline, in an
    // isolated home with synthetic procfs and accelerator commands. No SSH/GPU.
    #[cfg(unix)]
    fn collect_fixture_history(gpus: &str, meminfo: &str) -> HistoryPoint {
        collect_fixture_history_with_telemetry(gpus, meminfo, "")
    }

    #[cfg(unix)]
    fn collect_fixture_history_with_telemetry(gpus: &str, meminfo: &str, telemetry: &str) -> HistoryPoint {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let bin = root.join("bin");
        let proc = root.join("proc");
        std::fs::create_dir(&bin).unwrap();
        std::fs::create_dir(&proc).unwrap();
        std::fs::write(proc.join("stat"), "cpu 100 0 20 880 0 0 0\n").unwrap();
        std::fs::write(proc.join("meminfo"), meminfo).unwrap();
        let gpu_file = root.join("gpus.csv");
        let telemetry_file = root.join("telemetry.csv");
        std::fs::write(&gpu_file, gpus).unwrap();
        std::fs::write(&telemetry_file, telemetry).unwrap();
        for (name, body) in [
            ("flock", "exit 0"),
            ("sleep", "exit 0"),
            ("npu-smi", "exit 1"),
            ("nvidia-smi", "case \"$*\" in *--query-compute-apps=*) exit 0 ;; *temperature.gpu*) cat \"$RACKTOP_TEST_TELEMETRY\" ;; *--query-gpu=*) cat \"$RACKTOP_TEST_GPUS\" ;; esac"),
        ] {
            let path = bin.join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let script = REMOTE_COLLECTOR_SCRIPT.replace("/proc/", &format!("{}/", proc.display()));
        let output = std::process::Command::new("sh")
            .arg("-c")
            .arg(script)
            .env("HOME", root)
            .env("RACKTOP_COLLECTOR_BOUNDED", "1")
            .env("RACKTOP_TEST_GPUS", gpu_file)
            .env("RACKTOP_TEST_TELEMETRY", telemetry_file)
            .env("PATH", format!("{}:{}", bin.display(), std::env::var("PATH").unwrap()))
            .output()
            .unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert!(output.stderr.is_empty(), "{}", String::from_utf8_lossy(&output.stderr));
        let history = std::fs::read_to_string(root.join(".racktop/.history-v1.tsv")).unwrap();
        let points = parse_history(&history).unwrap();
        assert_eq!(points.len(), 1);
        points.into_iter().next().unwrap()
    }

    #[cfg(unix)]
    const SHARED_MEMINFO: &str = "MemTotal: 125829120 kB\nMemAvailable: 41943040 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n";

    #[cfg(unix)]
    #[test]
    fn collector_records_gb10_shared_memory_and_utilization() {
        for name in ["NVIDIA GB10", "DGX Spark", "nvidia gb10"] {
            let point = collect_fixture_history(
                &format!("GPU-test, 25, [N/A], [N/A], {name}\n"),
                SHARED_MEMINFO,
            );
            assert_eq!(point.gpu_utilizations["GPU-test"], 25.0);
            assert_eq!(point.gpu_memory_utilizations["GPU-test"], 66.67);
            assert_eq!(point.gpu_memory_utilizations["GPU-test"], point.memory_utilization);
            assert!(!point.gpu_other_user_occupancies["GPU-test"]);
        }
    }

    #[cfg(unix)]
    #[test]
    fn collector_keeps_mixed_gpu_history_when_one_memory_query_is_na() {
        let point = collect_fixture_history(
            "GPU-shared, 25, [N/A], [N/A], NVIDIA GB10\nGPU-discrete, 80, 10240, 40960, NVIDIA A100\nGPU-unknown, 15, [N/A], [N/A], NVIDIA Future GPU\nGPU-gb100, 10, [N/A], [N/A], NVIDIA GB100\n",
            SHARED_MEMINFO,
        );
        assert_eq!(point.gpu_utilizations.len(), 4);
        assert_eq!(point.gpu_memory_utilizations["GPU-shared"], 66.67);
        assert_eq!(point.gpu_memory_utilizations["GPU-discrete"], 25.0);
        for uuid in ["GPU-unknown", "GPU-gb100"] {
            assert_eq!(point.gpu_memory_utilizations[uuid], 0.0);
            assert!(point.gpu_utilizations[uuid] > 0.0);
        }
    }

    #[cfg(unix)]
    #[test]
    fn collector_requires_host_available_memory_and_preserves_numeric_gpu_memory() {
        let missing = collect_fixture_history(
            "GPU-test, 25, [N/A], [N/A], NVIDIA GB10\n",
            "MemTotal: 125829120 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n",
        );
        assert_eq!(missing.gpu_memory_utilizations["GPU-test"], 0.0);
        assert_eq!(missing.gpu_utilizations["GPU-test"], 25.0);
        let full = collect_fixture_history(
            "GPU-test, 0, [N/A], [N/A], NVIDIA GB10\n",
            "MemTotal: 125829120 kB\nMemAvailable: 0 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n",
        );
        assert_eq!(full.gpu_memory_utilizations["GPU-test"], 100.0);
        let numeric = collect_fixture_history("GPU-test, 25, 10240, 40960, NVIDIA GB10\n", SHARED_MEMINFO);
        assert_eq!(numeric.gpu_memory_utilizations["GPU-test"], 25.0);
    }

    #[cfg(unix)]
    #[test]
    fn collector_persists_nvidia_temperature_power_and_fan_with_optional_metrics() {
        let point = collect_fixture_history_with_telemetry(
            "GPU-test, 25, 10240, 40960, NVIDIA RTX 4090\nGPU-no-fan, 10, 1024, 8192, NVIDIA RTX\n",
            SHARED_MEMINFO,
            "GPU-test, 58, 155.5, 42\nGPU-no-fan, 43, 90.2, [N/A]\n",
        );

        assert_eq!(point.gpu_temperatures_celsius["GPU-test"], 58.0);
        assert_eq!(point.gpu_power_watts["GPU-test"], 155.5);
        assert_eq!(point.gpu_fan_speeds_percent["GPU-test"], Some(42.0));
        assert_eq!(point.gpu_temperatures_celsius["GPU-no-fan"], 43.0);
        assert_eq!(point.gpu_power_watts["GPU-no-fan"], 90.2);
        assert!(!point.gpu_fan_speeds_percent.contains_key("GPU-no-fan"));
    }

    #[test]
    fn parses_v3_telemetry_and_keeps_legacy_rows_compatible() {
        let points = parse_history(
            "v1|1722700740|10|20|0|GPU-a,25,40\nv2|1722700800|11|21|0|GPU-a,30,50,1\nv3|1722700860|12|22|0|GPU-a,35,60,0,58.5,155.25,42;GPU-b,5,10,1,[N/A],[N/A],[N/A]\n",
        ).unwrap();

        assert_eq!(points.len(), 3);
        assert_eq!(points[0].gpu_temperatures_celsius.get("GPU-a"), None);
        assert_eq!(points[1].gpu_power_watts.get("GPU-a"), None);
        assert_eq!(points[2].gpu_temperatures_celsius["GPU-a"], 58.5);
        assert_eq!(points[2].gpu_power_watts["GPU-a"], 155.25);
        assert_eq!(points[2].gpu_fan_speeds_percent["GPU-a"], Some(42.0));
        assert!(!points[2].gpu_temperatures_celsius.contains_key("GPU-b"));
        assert!(!points[2].gpu_power_watts.contains_key("GPU-b"));
        assert!(!points[2].gpu_fan_speeds_percent.contains_key("GPU-b"));
    }

    #[test]
    fn remote_state_directory_is_stable_and_unique_per_endpoint() {
        let first = remote_state_directory_for_endpoint("GPU.EXAMPLE.", 22);
        let normalized = remote_state_directory_for_endpoint("gpu.example", 22);
        let different_port = remote_state_directory_for_endpoint("gpu.example", 2222);
        let different_host = remote_state_directory_for_endpoint("gpu2.example", 22);

        assert_eq!(first, normalized);
        assert_ne!(first, different_port);
        assert_ne!(first, different_host);
        assert!(first.starts_with("$HOME/.racktop/remote-history/"));
    }

    #[cfg(unix)]
    #[test]
    fn daemon_collects_gpu_telemetry_after_client_heartbeat_expires() {
        use std::{
            os::unix::fs::PermissionsExt,
            thread,
            time::{Duration, Instant},
        };

        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let state = root.join(".racktop/remote-history/endpoint-a");
        let other_state = root.join(".racktop/remote-history/endpoint-b");
        let bin = root.join("bin");
        let proc = root.join("proc");
        std::fs::create_dir_all(&state).unwrap();
        std::fs::create_dir_all(&other_state).unwrap();
        std::fs::write(other_state.join(".history-v1.tsv"), "other-endpoint-history\n").unwrap();
        std::fs::create_dir_all(root.join(".racktop")).unwrap();
        std::fs::write(root.join(".racktop/.history-v1.tsv"), "legacy-shared-history\n").unwrap();
        std::fs::create_dir(&bin).unwrap();
        std::fs::create_dir(&proc).unwrap();
        std::fs::write(proc.join("stat"), "cpu 100 0 20 880 0 0 0\n").unwrap();
        std::fs::write(proc.join("meminfo"), SHARED_MEMINFO).unwrap();
        std::fs::write(root.join("gpus.csv"), "GPU-daemon, 25, 1024, 8192, NVIDIA RTX\n").unwrap();
        std::fs::write(root.join("telemetry.csv"), "GPU-daemon, 56, 145.7, 42\n").unwrap();
        let collector = REMOTE_COLLECTOR_SCRIPT.replace("/proc/", &format!("{}/", proc.display()));
        std::fs::write(state.join(".collector.sh"), collector).unwrap();
        std::fs::write(state.join(".daemon.sh"), REMOTE_DAEMON_SCRIPT).unwrap();
        std::fs::write(state.join(".client-heartbeat"), "").unwrap();
        let stale_heartbeat = std::process::Command::new("touch")
            .args(["-t", "200001010000"])
            .arg(state.join(".client-heartbeat"))
            .status()
            .unwrap();
        assert!(stale_heartbeat.success());

        for (name, body) in [
            ("flock", "exit 0"),
            ("sleep", "case \"$1\" in 60) /bin/sleep 0.1 ;; *) /bin/sleep \"$@\" ;; esac"),
            ("npu-smi", "exit 1"),
            ("nvidia-smi", "case \"$*\" in *--query-compute-apps=*) exit 0 ;; *temperature.gpu*) cat \"$RACKTOP_TEST_TELEMETRY\" ;; *--query-gpu=*) cat \"$RACKTOP_TEST_GPUS\" ;; esac"),
        ] {
            let path = bin.join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }

        let mut daemon = std::process::Command::new("sh")
            .arg(state.join(".daemon.sh"))
            .env("HOME", root)
            .env("RACKTOP_STATE_DIR", &state)
            .env("RACKTOP_COLLECTOR_BOUNDED", "1")
            .env("RACKTOP_TEST_GPUS", root.join("gpus.csv"))
            .env("RACKTOP_TEST_TELEMETRY", root.join("telemetry.csv"))
            .env("PATH", format!("{}:{}", bin.display(), std::env::var("PATH").unwrap()))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let history_path = state.join(".history-v1.tsv");
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut collected = None;
        while Instant::now() < deadline {
            if let Ok(history) = std::fs::read_to_string(&history_path) {
                collected = parse_history(&history).ok().and_then(|points| {
                    points.into_iter().find(|point| point.gpu_temperatures_celsius.contains_key("GPU-daemon"))
                });
                if collected.is_some() { break; }
            }
            thread::sleep(Duration::from_millis(25));
        }
        let _ = daemon.kill();
        let _ = daemon.wait();

        let point = collected.expect("expired heartbeat should trigger a remote telemetry sample");
        assert_eq!(point.gpu_temperatures_celsius["GPU-daemon"], 56.0);
        assert_eq!(point.gpu_power_watts["GPU-daemon"], 145.7);
        assert_eq!(point.gpu_fan_speeds_percent["GPU-daemon"], Some(42.0));
        assert_eq!(
            std::fs::read_to_string(other_state.join(".history-v1.tsv")).unwrap(),
            "other-endpoint-history\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join(".racktop/.history-v1.tsv")).unwrap(),
            "legacy-shared-history\n"
        );
        assert!(history_path.exists());
    }

    #[test]
    fn parses_remote_history_with_multiple_gpus() {
        let points =
            parse_history("v1|1722700800|12.50|40.25|3.00|GPU-a,80.00,50.00;GPU-b,0.00,1.25\n")
                .unwrap();
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].timestamp, 1_722_700_800);
        assert_eq!(points[0].gpu_utilizations.get("GPU-a"), Some(&80.0));
        assert_eq!(points[0].gpu_memory_utilizations.get("GPU-b"), Some(&1.25));
        assert!(points[0].gpu_other_user_occupancies.is_empty());
    }

    #[test]
    fn parses_anonymous_gpu_occupancy_from_v2_history() {
        let points =
            parse_history("v2|1722700800|12.50|40.25|3.00|GPU-a,80.00,50.00,1;GPU-b,0.00,1.25,0\n")
                .unwrap();
        assert_eq!(
            points[0].gpu_other_user_occupancies.get("GPU-a"),
            Some(&true)
        );
        assert_eq!(
            points[0].gpu_other_user_occupancies.get("GPU-b"),
            Some(&false)
        );
    }

    #[test]
    fn skips_legacy_rows_with_blank_percentages_without_losing_valid_history() {
        let points = parse_history(
            "v1|1722700740||||GPU-a,0.00,0.06\nv1|1722700800|12.50|40.25|3.00|GPU-a,80.00,50.00\n",
        )
        .unwrap();
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
        let daemon_script = REMOTE_DAEMON_SCRIPT.replace("\r\n", "\n");
        assert!(daemon_script.contains("set -e\nset -u"));
        assert!(REMOTE_DAEMON_SCRIPT.contains("sh \"$collector\""));
        assert!(REMOTE_COLLECTOR_SCRIPT.contains("#!/bin/sh"));
        assert!(
            REMOTE_COLLECTOR_SCRIPT
                .contains("nvidia-smi --query-gpu=uuid,utilization.gpu,memory.used,memory.total")
        );
        assert!(REMOTE_COLLECTOR_SCRIPT.contains("--query-compute-apps=gpu_uuid,pid,used_memory"));
        assert!(REMOTE_COLLECTOR_SCRIPT.contains(".usage-v1.tsv"));
        assert!(REMOTE_COLLECTOR_SCRIPT.contains("v2|%d"));
        assert!(REMOTE_COLLECTOR_SCRIPT.contains("now - 7200"));
        assert!(REMOTE_COLLECTOR_SCRIPT.contains(".usage-compacted-through-v2"));
        assert!(REMOTE_COLLECTOR_SCRIPT.contains("__racktop_coverage__"));
        assert!(!REMOTE_COLLECTOR_SCRIPT.contains("command="));
        assert!(!REMOTE_COLLECTOR_SCRIPT.contains("args="));
    }

    #[test]
    fn remote_daemon_install_keeps_actionable_startup_diagnostics() {
        let source = include_str!("remote_history.rs");
        assert!(source.contains("nohup setsid sh \"$state/.daemon.sh\""));
        assert!(source.contains("replace(\"\\r\\n\", \"\\n\")"));
        assert!(source.contains("$state/.daemon.log"));
        assert!(source.contains("tail -n 8 \"$state/.daemon.log\""));
    }

    #[test]
    fn remote_cleanup_script_targets_only_racktop_state() {
        assert!(REMOTE_REMOVE_SCRIPT.contains("state=\"${RACKTOP_STATE_DIR:?}\""));
        assert!(REMOTE_REMOVE_SCRIPT.contains("grep -F \"sh $state/.daemon.sh\""));
        assert!(REMOTE_REMOVE_SCRIPT.contains("kill -KILL \"$pid\""));
        assert!(REMOTE_REMOVE_SCRIPT.contains("rm -rf -- \"$state\""));
        assert!(!REMOTE_REMOVE_SCRIPT.contains("rm -rf -- $HOME"));
    }

    #[test]
    fn removing_one_server_preserves_legacy_and_other_endpoint_history() {
        let directory = tempfile::tempdir().unwrap();
        let legacy = directory.path().join(".racktop");
        let first = legacy.join("remote-history/endpoint-a");
        let second = legacy.join("remote-history/endpoint-b");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        std::fs::write(legacy.join(".history-v1.tsv"), "legacy\n").unwrap();
        std::fs::write(first.join(".history-v1.tsv"), "first\n").unwrap();
        std::fs::write(second.join(".history-v1.tsv"), "second\n").unwrap();

        let output = std::process::Command::new("sh")
            .arg("-c")
            .arg(build_remove_script("$HOME/.racktop/remote-history/endpoint-a", None).unwrap())
            .env("HOME", directory.path())
            .output()
            .unwrap();

        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert!(!first.exists());
        assert_eq!(std::fs::read_to_string(legacy.join(".history-v1.tsv")).unwrap(), "legacy\n");
        assert_eq!(std::fs::read_to_string(second.join(".history-v1.tsv")).unwrap(), "second\n");
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

        let script = build_remove_script(
            "$HOME/.racktop/remote-history/test-endpoint",
            Some(&format!("ssh-ed25519 {matching_blob} ignored-comment")),
        )
        .unwrap();
        let output = std::process::Command::new("sh")
            .arg("-c")
            .arg(script)
            .env("HOME", directory.path())
            .output()
            .unwrap();

        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("__RACKTOP_SSH_ACCESS_REVOKED__"));
        let filtered = std::fs::read_to_string(authorized_keys).unwrap();
        assert!(!filtered.contains(&matching_blob));
        assert!(filtered.contains(&format!(
            "ssh-ed25519 {other_blob} racktop-managed:same-looking-comment"
        )));
        assert!(filtered.contains(&format!(
            "from=\"10.0.0.0/8\",no-agent-forwarding ssh-ed25519 {options_blob} constrained-key"
        )));
        assert!(filtered.ends_with("\n\n"));
    }

    #[test]
    fn revocation_rejects_an_invalid_key_blob_before_running_ssh() {
        assert!(build_remove_script(
            "$HOME/.racktop/remote-history/test-endpoint",
            Some("ssh-ed25519 not-a/base64'value")
        )
        .is_err());
    }

    #[test]
    fn parses_privacy_scoped_usage_rows() {
        let point = parse_usage_line("v1|1722700800|GPU-a|alice|60|245760.00|60").unwrap();
        assert_eq!(point.username, "alice");
        assert_eq!(point.active_seconds, 60);
        assert_eq!(point.bucket_seconds, 60);
        let hourly = parse_usage_line("v2|1722700800|GPU-a|alice|1800|7372800.00|3600").unwrap();
        assert_eq!(hourly.bucket_seconds, 3_600);
        assert_eq!(hourly.active_seconds, 1_800);
    }
}
