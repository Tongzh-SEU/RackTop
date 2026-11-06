use crate::{
    collector::{
        configured_ssh_command, configured_ssh_command_without_control, run_ssh_script,
    },
    models::{HistoryPoint, Server, UsagePoint},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};
use tokio::time::Duration;
use uuid::Uuid;

const REMOTE_COLLECTOR_SCRIPT: &str = concat!(include_str!("../assets/ascend-collector.sh"), include_str!("../assets/remote-history-collector.sh"));
const REMOTE_DAEMON_SCRIPT: &str = include_str!("../assets/remote-history-daemon.sh");
const REMOTE_DAEMON_LOCK_SCRIPT: &str = include_str!("../assets/remote-history-daemon-lock.sh");
const REMOTE_DAEMON_CLEANUP_SCRIPT: &str = include_str!("../assets/remote-history-daemon-cleanup.sh");
const REMOTE_USAGE_SCRIPT: &str = include_str!("../assets/remote-history-usage.sh");
const CLIENT_ID_FILENAME: &str = "remote-history-client-id";
const REMOTE_LIFECYCLE_SCRIPT: &str = include_str!("../assets/remote-history-lifecycle.sh");
const REMOTE_LEGACY_SCRIPT: &str = include_str!("../assets/remote-history-legacy.sh");
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

#[derive(Clone, Debug)]
pub struct ClientIdentity(Option<String>);

impl ClientIdentity {
    pub fn unavailable(error: &str) -> Self {
        eprintln!("{error}；远端历史功能暂不可用，原客户端关联已保留。");
        Self(None)
    }

    pub fn load_or_create(app_data_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(app_data_dir).map_err(|error| format!("无法创建 RackTop 数据目录：{error}"))?;
        let path = app_data_dir.join(CLIENT_ID_FILENAME);
        match fs::read_to_string(&path) {
            Ok(value) => return match Self::parse(&value) {
                Ok(identity) => Ok(identity),
                Err(_) => {
                    Ok(Self::unavailable("本机远端历史标识损坏；请从备份恢复原标识文件"))
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Ok(Self::unavailable(&format!("无法读取本机远端历史标识：{error}")));
            }
        }

        let id = Uuid::new_v4().to_string();
        let temporary = app_data_dir.join(format!(".{CLIENT_ID_FILENAME}.{}.tmp", Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&temporary) {
            Ok(mut file) => {
                let result = file.write_all(id.as_bytes()).and_then(|()| file.sync_all());
                drop(file);
                if let Err(error) = result {
                    let _ = fs::remove_file(&temporary);
                    return Err(format!("无法保存本机远端历史标识：{error}"));
                }
                match fs::hard_link(&temporary, &path) {
                    Ok(()) => {
                        let _ = fs::remove_file(&temporary);
                        #[cfg(unix)]
                        fs::File::open(app_data_dir).and_then(|directory| directory.sync_all())
                            .map_err(|error| format!("无法同步本机远端历史标识：{error}"))?;
                        Ok(Self(Some(id)))
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                        let _ = fs::remove_file(&temporary);
                        let value = fs::read_to_string(&path).map_err(|error| format!("无法读取本机远端历史标识：{error}"))?;
                        Self::parse(&value)
                    }
                    Err(error) => {
                        let _ = fs::remove_file(&temporary);
                        Err(format!("无法保存本机远端历史标识：{error}"))
                    }
                }
            }
            Err(error) => Err(format!("无法创建本机远端历史标识：{error}")),
        }
    }

    pub fn as_str(&self) -> &str {
        self.0.as_deref().unwrap_or("")
    }

    pub fn require(&self) -> Result<&str, String> {
        self.0.as_deref().ok_or_else(|| "本机远端历史标识损坏；已保留旧关联，远端历史操作暂不可用".into())
    }

    fn parse(value: &str) -> Result<Self, String> {
        Uuid::parse_str(value.trim())
            .map(|id| Self(Some(id.to_string())))
            .map_err(|_| "本机远端历史标识格式无效".to_string())
    }
}

pub(crate) fn remote_state_directory(server: &Server) -> String {
    format!(
        "$HOME/.racktop-managed/remote-history-store/{}",
        endpoint_state_component(&server.host, server.port)
    )
}

pub(crate) fn client_state_directory(server: &Server, client_id: &str) -> String {
    remote_state_directory_for_endpoint(&server.host, server.port, client_id)
}

fn remote_state_directory_for_endpoint(host: &str, port: u16, client_id: &str) -> String {
    format!("$HOME/.racktop-managed/remote-history-store/{}/instances/{:x}", endpoint_state_component(host, port), Sha256::digest(client_id.as_bytes()))
}

fn lifecycle_script(state: &str, action: &str) -> String {
    let (data, client) = state.rsplit_once("/instances/").expect("generated client path");
    let endpoint = data.rsplit('/').next().expect("generated endpoint");
    format!("RACKTOP_HISTORY_ENDPOINT=\"{endpoint}\"\nRACKTOP_HISTORY_CLIENT=\"{client}\"\nRACKTOP_HISTORY_ACTION=\"{action}\"\n{}", REMOTE_LIFECYCLE_SCRIPT.replace("\r\n", "\n").replace("# RACKTOP_LEGACY_SNAPSHOT", &REMOTE_LEGACY_SCRIPT.replace("\r\n", "\n")))
}

fn endpoint_state_component(host: &str, port: u16) -> String {
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
    format!("{host_slug}-{port}-{digest:x}")
}

#[cfg(test)]
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

pub async fn configure(server: &Server, password: Option<&str>, client_id: &str) -> Result<(), String> {
    if client_id.is_empty() {
        return Err("本机远端历史标识损坏；已保留旧关联，远端历史操作暂不可用".into());
    }
    if server.remote_history_enabled {
        install(server, password, client_id).await
    } else {
        disable(server, password, client_id).await
    }
}

pub async fn remove(
    server: &Server,
    password: Option<&str>,
    managed_public_key: Option<&str>,
    client_id: &str,
) -> Result<(), String> {
    if client_id.is_empty() {
        return Err("本机远端历史标识损坏；已保留旧关联，远端清理暂不可用".into());
    }
    let state = client_state_directory(server, client_id);
    let script = format!("{}\n{}", lifecycle_script(&state, "remove"), build_remove_script(&state, managed_public_key)?);
    let output =
        run_remote_cleanup_command(server, password, &script, Duration::from_secs(25)).await?;
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
    let script = compatibility_read_script(server, since, false);
    let output = run_remote_command(server, password, &script, Duration::from_secs(20)).await?;
    let mut seen = std::collections::HashSet::new();
    Ok(parse_history(&output)?.into_iter().filter(|point| seen.insert(point.timestamp)).collect())
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
    let script = compatibility_read_script(server, since, true);
    let output = run_remote_command(server, password, &script, Duration::from_secs(20)).await?;
    Ok(merge_compatibility_usage(&output))
}

fn compatibility_read_script(server: &Server, since: i64, usage: bool) -> String {
    let endpoint = endpoint_state_component(&server.host, server.port);
    let data_state = remote_state_directory(server);
    let reader = if usage {
        format!("( unset RACKTOP_HISTORY_LOCK; RACKTOP_STATE_DIR=\"$read_state\"; set -- {since}\n{}\n)", REMOTE_USAGE_SCRIPT.replace("\r\n", "\n"))
    } else {
        format!("history=\"$read_state/.history-v1.tsv\"; if [ -r \"$history\" ]; then awk -F '|' -v since={since} '($1 == \"v1\" || $1 == \"v2\" || $1 == \"v3\") && $2 >= since' \"$history\"; fi")
    };
    format!(r#"set -eu
umask 077
endpoint="{endpoint}"
base="$HOME/.racktop"
legacy="$base/remote-history/{endpoint}"
data_state="{data_state}"
mkdir -p "$HOME/.racktop-managed/remote-history-locks"
exec 6>"$HOME/.racktop-managed/remote-history-locks/{endpoint}.lock"
flock -w 10 6 || exit 41
{snapshot}
for read_state in "$data_state" "$data_state/legacy-endpoint" "$data_state/legacy-store" "$data_state/legacy-root"; do
  [ -d "$read_state" ] || continue
  {reader}
done
"#, snapshot = REMOTE_LEGACY_SCRIPT.replace("\r\n", "\n"))
}

pub(crate) fn merge_compatibility_usage(output: &str) -> Vec<UsagePoint> {
    // Compare measured coverage within each GPU/user/hour, not the bucket's
    // label: a v2 rollup may itself contain only a few minutes. Choose one
    // representation, retaining both raw sources rather than inventing a split
    // of an hourly aggregate. Current-store values win equal-coverage ties.
    let mut positions = std::collections::HashMap::<_, usize>::new();
    let mut points: Vec<UsagePoint> = Vec::new();
    for line in output.lines() {
        if let Ok(point) = parse_usage_line(line) {
            let key = (point.timestamp, point.bucket_seconds, point.gpu_uuid.clone(), point.username.clone());
            if let Some(&index) = positions.get(&key) {
                if point.coverage_seconds > points[index].coverage_seconds { points[index] = point; }
            } else {
                positions.insert(key, points.len());
                points.push(point);
            }
        }
    }
    let mut coverage = std::collections::HashMap::<_, (i64, i64)>::new();
    for point in &points {
        let key = (point.timestamp - point.timestamp.rem_euclid(3600), point.gpu_uuid.clone(), point.username.clone());
        let (minutes, hourly) = coverage.entry(key).or_default();
        if point.bucket_seconds == 60 { *minutes = minutes.saturating_add(point.coverage_seconds); }
        else { *hourly = point.coverage_seconds; }
    }
    points.into_iter().filter(|point| {
        let key = (point.timestamp - point.timestamp.rem_euclid(3600), point.gpu_uuid.clone(), point.username.clone());
        let (minutes, hourly) = coverage[&key];
        if point.bucket_seconds == 3600 { hourly >= minutes }
        else { hourly < minutes }
    }).collect()
}

async fn install(server: &Server, password: Option<&str>, client_id: &str) -> Result<(), String> {
    let script = build_install_script(server, client_id);
    let output = run_remote_command(server, password, &script, Duration::from_secs(25)).await?;
    if output.lines().any(|line| line.trim() == "__RACKTOP_REMOTE_HISTORY_READY__") {
        Ok(())
    } else if output.lines().any(|line| line.trim() == "__RACKTOP_REMOTE_HISTORY_STARTING__") {
        Err("远端历史 daemon 正在启动，请稍后重试".into())
    } else if output.lines().any(|line| line.trim() == "__RACKTOP_REMOTE_HISTORY_CLEANUP_PENDING__") {
        Err("旧版远端历史进程正在退出，等待清理完成后重试".into())
    } else if output.lines().any(|line| line.trim() == "__RACKTOP_REMOTE_HISTORY_LOCK_UNAVAILABLE__") {
        Err("远端系统没有可用的本地临时文件系统锁，远端历史 daemon 未启动".into())
    } else {
        Err("远端历史任务安装后未返回确认标记".into())
    }
}

fn build_install_script(server: &Server, client_id: &str) -> String {
    // Windows checkouts may expose bundled shell assets as CRLF. Normalize before
    // sending them to Linux, where a trailing CR changes `set -e` into an invalid option.
    let collector_script = REMOTE_COLLECTOR_SCRIPT.replace("\r\n", "\n");
    let state_dir = client_state_directory(server, client_id);
    let data_state_dir = remote_state_directory(server);
    let (state_data_path, client_component) = state_dir.rsplit_once("/instances/").expect("generated client state path");
    let endpoint = state_data_path.rsplit('/').next().expect("generated endpoint component");
    let daemon_lock_script = REMOTE_DAEMON_LOCK_SCRIPT.replace("\r\n", "\n");
    let daemon_cleanup_script = REMOTE_DAEMON_CLEANUP_SCRIPT.replace("\r\n", "\n");
    let daemon_script = REMOTE_DAEMON_SCRIPT
        .replace("# RACKTOP_DAEMON_LOCK", &daemon_lock_script)
        .replace("\r\n", "\n");
    let lifecycle = lifecycle_script(&state_dir, "register");
    let encoded = STANDARD.encode(collector_script);
    let daemon_encoded = STANDARD.encode(daemon_script);
    format!(
        r#"set -e
set -u
state="{state_dir}"
data_state="{data_state_dir}"
endpoint="{endpoint}"
export RACKTOP_HISTORY_ENDPOINT="$endpoint"
export RACKTOP_HISTORY_CLIENT="{client_component}"
command -v flock >/dev/null 2>&1 || {{ printf '远端历史需要 util-linux 的 flock 命令' >&2; exit 1; }}
command -v timeout >/dev/null 2>&1 || {{ printf '远端历史需要 timeout 命令' >&2; exit 1; }}
{daemon_lock_script}
{daemon_cleanup_script}
unset RACKTOP_DAEMON_LOCK_DIR
if racktop_acquire_install_lock; then
  :
else
  lock_status=$?
  if [ "$lock_status" -eq 1 ]; then
    printf '__RACKTOP_REMOTE_HISTORY_STARTING__\n'
  else
    printf '__RACKTOP_REMOTE_HISTORY_LOCK_UNAVAILABLE__\n'
  fi
  exit 0
fi
if racktop_acquire_daemon_lock; then
  :
else
  lock_status=$?
  if [ "$lock_status" -eq 1 ]; then
    if racktop_cleanup_legacy_daemons "$HOME/.racktop/.daemon.sh" "$HOME/.racktop/.collector.sh" \
        "$data_state/.daemon.sh" "$data_state/.collector.sh" \
        "$HOME/.racktop/remote-history-store/$endpoint/.daemon.sh" "$HOME/.racktop/remote-history-store/$endpoint/.collector.sh" \
        "$HOME/.racktop/remote-history/$endpoint/.daemon.sh" "$HOME/.racktop/remote-history/$endpoint/.collector.sh"; then
      if racktop_daemon_exists "$state/.daemon.sh" "" ""; then
        printf '__RACKTOP_REMOTE_HISTORY_READY__\n'
        exit 0
      fi
      if racktop_acquire_daemon_lock; then
        :
      else
        lock_status=$?
        if [ "$lock_status" -eq 1 ]; then
          printf '__RACKTOP_REMOTE_HISTORY_STARTING__\n'
        else
          printf '__RACKTOP_REMOTE_HISTORY_LOCK_UNAVAILABLE__\n'
        fi
        exit 0
      fi
    else
      printf '__RACKTOP_REMOTE_HISTORY_CLEANUP_PENDING__\n'
      exit 0
    fi
  else
    printf '__RACKTOP_REMOTE_HISTORY_LOCK_UNAVAILABLE__\n'
    exit 0
  fi
fi
if racktop_cleanup_legacy_daemons "$HOME/.racktop/.daemon.sh" "$HOME/.racktop/.collector.sh" \
  "$data_state/.daemon.sh" "$data_state/.collector.sh" \
  "$HOME/.racktop/remote-history-store/$endpoint/.daemon.sh" "$HOME/.racktop/remote-history-store/$endpoint/.collector.sh" \
  "$HOME/.racktop/remote-history/$endpoint/.daemon.sh" "$HOME/.racktop/remote-history/$endpoint/.collector.sh" \
  "$state/.daemon.sh" "$state/.collector.sh"; then
  :
else
  printf '__RACKTOP_REMOTE_HISTORY_CLEANUP_PENDING__\n'
  exit 0
fi
{lifecycle}
if racktop_daemon_exists "$state/.daemon.sh" "" ""; then
  printf '__RACKTOP_REMOTE_HISTORY_CLEANUP_PENDING__\n'
  exit 0
fi
chmod 700 "$state"
export RACKTOP_STATE_DIR="$data_state"
export RACKTOP_CLIENT_STATE_DIR="$state"
export RACKTOP_HISTORY_LOCK="$HOME/.racktop-managed/remote-history-locks/$endpoint.lock"
printf '%s' '{encoded}' | base64 -d > "$state/.collector.sh.$$"
printf '%s' '{daemon_encoded}' | base64 -d > "$state/.daemon.sh.$$"
mv "$state/.collector.sh.$$" "$state/.collector.sh"
mv "$state/.daemon.sh.$$" "$state/.daemon.sh"
chmod 700 "$state/.collector.sh" "$state/.daemon.sh"
touch "$state/.client-heartbeat"
touch "$data_state/.client-heartbeat"
export RACKTOP_DAEMON_LOCK_HELD=1
: > "$state/.daemon.log"
if command -v setsid >/dev/null 2>&1; then
  nohup setsid sh "$state/.daemon.sh" 5>&- 6>&- 7>&- 9>&- </dev/null >"$state/.daemon.log" 2>&1 &
else
  nohup sh "$state/.daemon.sh" 5>&- 6>&- 7>&- 9>&- </dev/null >"$state/.daemon.log" 2>&1 &
fi
flock -u 6
ready=0
for attempt in 1 2 3; do
  sleep 1
  if racktop_daemon_exists "$state/.daemon.sh" "" ""; then ready=1; break; fi
done
if [ "$ready" -ne 1 ]; then
  printf '__RACKTOP_REMOTE_HISTORY_STARTING__\n'
  exit 0
fi
flock -u 5
printf '__RACKTOP_REMOTE_HISTORY_READY__\n'
"#,
    )
}

#[cfg(test)]
fn build_disable_script(state_dir: &str) -> String {
    format!(
        "{}rm -f \"$state/.daemon.pid\"\nprintf '__RACKTOP_REMOTE_HISTORY_DISABLED__\\n'\n",
        stop_verified_daemon(state_dir),
    )
}

async fn disable(server: &Server, password: Option<&str>, client_id: &str) -> Result<(), String> {
    let state_dir = client_state_directory(server, client_id);
    let script = lifecycle_script(&state_dir, "disable");
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
    let (command, target) = configured_ssh_command(server, password)?;
    let output = run_ssh_script(command, &target, script, duration, &format!("连接 {} 同步历史超时", server.name)).await?;
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

async fn run_remote_cleanup_command(
    server: &Server,
    password: Option<&str>,
    script: &str,
    duration: Duration,
) -> Result<String, String> {
    let (command, target) = configured_ssh_command_without_control(server, password)?;
    let output = run_ssh_script(command, &target, script, duration, &format!("连接 {} 删除远端数据超时", server.name)).await?;
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
    use std::process::Stdio;

    #[cfg(unix)]
    struct ChildProcessGuard(std::process::Child);

    #[cfg(unix)]
    impl Drop for ChildProcessGuard {
        fn drop(&mut self) {
            if self.0.try_wait().ok().flatten().is_none() {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn installer_starts_a_managed_daemon_on_a_clean_host() {
        use std::os::unix::fs::PermissionsExt;
        let server: Server = serde_json::from_value(serde_json::json!({
            "id": "upgrade-test", "name": "upgrade-test", "host": "example.com", "port": 22,
            "username": "test", "tags": [], "samplingIntervalSeconds": 5,
            "historyRetentionDays": 90, "remoteHistoryEnabled": true,
            "authMethod": "sshAgent", "status": "unknown"
        })).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let bin = root.join("bin");
        fs::create_dir(&bin).unwrap();
        fs::create_dir(root.join("lock-root")).unwrap();
        let state = client_state_directory(&server, "upgrade-client").replace("$HOME", root.to_str().unwrap());
        let daemon = format!("{state}/.daemon.sh");
        for (name, body) in [
            ("flock", "exit 0"),
            ("stat", "case \"$*\" in *%T*) echo tmpfs ;; *%u*) id -u ;; *%a*) echo 700 ;; esac"),
            ("timeout", "exit 0"),
            ("ps", "case \"$*\" in *ppid=*) exit 0 ;; *) if [ -f \"$HOME/started\" ]; then printf '123 sh %s\\n' \"$TEST_DAEMON\"; fi ;; esac"),
            ("nohup", "touch \"$HOME/started\""),
        ] {
            let file = bin.join(name);
            fs::write(&file, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(file, fs::Permissions::from_mode(0o700)).unwrap();
        }

        let script = build_install_script(&server, "upgrade-client")
            .replace("/run/lock/racktop-$racktop_uid", "$HOME/lock-root/racktop-$racktop_uid")
            .replace("/dev/shm/racktop-$racktop_uid", "$HOME/lock-root/racktop-$racktop_uid");
        let output = std::process::Command::new("sh").arg("-c").arg(&script)
            .env("HOME", root)
            .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
            .env("TEST_DAEMON", &daemon)
            .output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert!(String::from_utf8_lossy(&output.stdout).contains("__RACKTOP_REMOTE_HISTORY_READY__"), "stdout={} stderr={}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        assert!(Path::new(&state).is_dir());
        assert!(Path::new(&format!("{state}/.collector.sh")).is_file());
        assert!(root.join("started").exists());
    }

    #[cfg(unix)]
    #[test]
    fn installer_stops_the_legacy_store_process_tree_before_migrating_without_changing_history() {
        use std::os::unix::fs::PermissionsExt;
        let server: Server = serde_json::from_value(serde_json::json!({
            "id": "upgrade-test", "name": "upgrade-test", "host": "example.com", "port": 22,
            "username": "test", "tags": [], "samplingIntervalSeconds": 5,
            "historyRetentionDays": 90, "remoteHistoryEnabled": true,
            "authMethod": "sshAgent", "status": "unknown"
        })).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let bin = root.join("bin");
        fs::create_dir(&bin).unwrap();
        fs::create_dir(root.join("lock-root")).unwrap();
        let endpoint = endpoint_state_component(&server.host, server.port);
        let data = format!("{}/.racktop/remote-history-store/{endpoint}", root.display());
        fs::create_dir_all(&data).unwrap();
        let legacy_daemon = format!("{data}/.daemon.sh");
        fs::write(&legacy_daemon, "#!/bin/sh\nsleep 300 &\nchild=$!\nprintf '%s\\n' \"$child\" > \"$HOME/legacy-child-pid\"\nwait \"$child\"\n").unwrap();
        let history = Path::new(&data).join(".history-v1.tsv");
        let original_history = "v1|3600|10|20|0|GPU-a,30,40\n";
        fs::write(&history, original_history).unwrap();

        let mut legacy = ChildProcessGuard(std::process::Command::new("sh")
            .arg(&legacy_daemon)
            .env("HOME", root)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn().unwrap());
        for _ in 0..100 {
            if root.join("legacy-child-pid").exists() { break; }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(root.join("legacy-child-pid").exists(), "legacy daemon fixture did not start");

        let ps = if Path::new("/bin/ps").exists() { "/bin/ps" } else { "/usr/bin/ps" };
        let ps_wrapper = format!(
            "#!/bin/sh\n{ps} \"$@\"\nstatus=$?\ncase \"$*\" in *ppid=*) ;; *) if [ -f \"$HOME/started\" ]; then printf '999 sh %s\\n' \"$TEST_DAEMON\"; fi ;; esac\nexit \"$status\"\n"
        );
        for (name, body) in [
            ("flock", "exit 0"),
            ("stat", "case \"$*\" in *%T*) echo tmpfs ;; *%u*) id -u ;; *%a*) echo 700 ;; esac"),
            ("timeout", "exit 0"),
            ("ps", ps_wrapper.as_str()),
            ("nohup", "touch \"$HOME/started\""),
        ] {
            let file = bin.join(name);
            fs::write(&file, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(file, fs::Permissions::from_mode(0o700)).unwrap();
        }

        let state = client_state_directory(&server, "upgrade-client").replace("$HOME", root.to_str().unwrap());
        let script = build_install_script(&server, "upgrade-client")
            .replace("/run/lock/racktop-$racktop_uid", "$HOME/lock-root/racktop-$racktop_uid")
            .replace("/dev/shm/racktop-$racktop_uid", "$HOME/lock-root/racktop-$racktop_uid");
        let output = std::process::Command::new("sh").arg("-c").arg(&script)
            .env("HOME", root)
            .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
            .env("TEST_DAEMON", format!("{state}/.daemon.sh"))
            .output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert!(String::from_utf8_lossy(&output.stdout).contains("__RACKTOP_REMOTE_HISTORY_READY__"), "stdout={} stderr={}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        assert!(legacy.0.try_wait().unwrap().is_some(), "legacy daemon still running after install");
        assert_eq!(fs::read_to_string(&history).unwrap(), original_history);
        assert!(root.join("started").exists(), "new managed daemon was not started; stdout={} stderr={}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_force_kills_a_legacy_process_tree_that_ignores_term() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let legacy_dir = root.join(".racktop");
        fs::create_dir_all(&legacy_dir).unwrap();
        let legacy_daemon = legacy_dir.join(".daemon.sh");
        fs::write(&legacy_daemon, "#!/bin/sh\ntrap '' TERM\nwhile :; do sleep 30; done\n").unwrap();
        fs::set_permissions(&legacy_daemon, fs::Permissions::from_mode(0o700)).unwrap();

        let mut legacy = ChildProcessGuard(std::process::Command::new("sh")
            .arg(&legacy_daemon)
            .env("HOME", root)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn().unwrap());
        std::thread::sleep(Duration::from_millis(100));

        let script = format!(
            "{}\nracktop_cleanup_legacy_daemons \"$HOME/.racktop/.daemon.sh\" \"\"\n",
            REMOTE_DAEMON_CLEANUP_SCRIPT.replace("\r\n", "\n")
        );
        let output = std::process::Command::new("sh").arg("-c").arg(script)
            .env("HOME", root)
            .output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert!(legacy.0.try_wait().unwrap().is_some(), "TERM-ignoring legacy daemon was not force-killed");
    }

    #[cfg(unix)]
    #[test]
    fn installer_reacquires_a_legacy_daemon_lock_and_starts_in_the_same_attempt() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let server: Server = serde_json::from_value(serde_json::json!({
            "id": "upgrade-test", "name": "upgrade-test", "host": "example.com", "port": 22,
            "username": "test", "tags": [], "samplingIntervalSeconds": 5,
            "historyRetentionDays": 90, "remoteHistoryEnabled": true,
            "authMethod": "sshAgent", "status": "unknown"
        })).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let bin = root.join("bin");
        fs::create_dir(&bin).unwrap();
        fs::create_dir(root.join("lock-root")).unwrap();
        let endpoint = endpoint_state_component(&server.host, server.port);
        let client_component = format!("{:x}", Sha256::digest("upgrade-client".as_bytes()));
        let uid = fs::metadata(root).unwrap().uid();
        let lock_root = root.join(format!("lock-root/racktop-{uid}"));
        fs::create_dir_all(&lock_root).unwrap();
        let _daemon_lock = fs::File::create(lock_root.join(format!("{endpoint}-{client_component}.lock"))).unwrap();
        fs::write(root.join("legacy-lock-held"), "held").unwrap();
        fs::write(root.join("legacy-running"), "running").unwrap();
        let legacy_daemon = root.join(".racktop/.daemon.sh");
        fs::create_dir_all(legacy_daemon.parent().unwrap()).unwrap();
        fs::write(&legacy_daemon, "#!/bin/sh\n").unwrap();
        let state = client_state_directory(&server, "upgrade-client").replace("$HOME", root.to_str().unwrap());

        let flock_wrapper = r#"#!/bin/sh
case "$*" in
  *"-n 8"*)
    attempts="$(cat "$HOME/daemon-lock-attempts" 2>/dev/null || printf 0)"
    attempts=$((attempts + 1))
    printf '%s\n' "$attempts" > "$HOME/daemon-lock-attempts"
    [ -e "$HOME/legacy-lock-held" ] && exit 1
    ;;
esac
exit 0
"#;
        let ps_wrapper = r#"#!/bin/sh
case "$*" in
  *ppid=*)
    if [ -f "$HOME/legacy-running" ]; then
      printf '99999999 1 S sh %s\n' "$TEST_LEGACY_DAEMON"
      rm -f "$HOME/legacy-running" "$HOME/legacy-lock-held"
    fi
    ;;
  *)
    if [ -f "$HOME/started" ]; then printf '99999999 sh %s\n' "$TEST_DAEMON"; fi
    ;;
esac
"#;
        for (name, body) in [
            ("flock", flock_wrapper),
            ("stat", "case \"$*\" in *%T*) echo tmpfs ;; *%u*) id -u ;; *%a*) echo 700 ;; esac"),
            ("timeout", "exit 0"),
            ("ps", ps_wrapper),
            ("nohup", "touch \"$HOME/started\""),
        ] {
            let file = bin.join(name);
            fs::write(&file, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(file, fs::Permissions::from_mode(0o700)).unwrap();
        }

        let script = build_install_script(&server, "upgrade-client")
            .replace("/run/lock/racktop-$racktop_uid", "$HOME/lock-root/racktop-$racktop_uid")
            .replace("/dev/shm/racktop-$racktop_uid", "$HOME/lock-root/racktop-$racktop_uid");
        let output = std::process::Command::new("sh").arg("-c").arg(&script)
            .env("HOME", root)
            .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
            .env("TEST_LEGACY_DAEMON", &legacy_daemon)
            .env("TEST_DAEMON", format!("{state}/.daemon.sh"))
            .output().unwrap();

        assert!(output.status.success(), "stdout={} stderr={}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        assert!(String::from_utf8_lossy(&output.stdout).contains("__RACKTOP_REMOTE_HISTORY_READY__"), "stdout={} stderr={}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        assert!(root.join("started").exists(), "the replacement daemon must start without waiting for the periodic retry");
        assert_eq!(fs::read_to_string(root.join("daemon-lock-attempts")).unwrap().trim(), "2");
    }

    #[cfg(unix)]
    #[test]
    fn installer_waits_for_legacy_cleanup_then_starts_on_a_later_retry() {
        use std::os::unix::fs::PermissionsExt;
        let server: Server = serde_json::from_value(serde_json::json!({
            "id": "upgrade-test", "name": "upgrade-test", "host": "example.com", "port": 22,
            "username": "test", "tags": [], "samplingIntervalSeconds": 5,
            "historyRetentionDays": 90, "remoteHistoryEnabled": true,
            "authMethod": "sshAgent", "status": "unknown"
        })).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let bin = root.join("bin");
        fs::create_dir(&bin).unwrap();
        fs::create_dir(root.join("lock-root")).unwrap();
        let data = remote_state_directory(&server).replace("$HOME", root.to_str().unwrap());
        fs::create_dir_all(&data).unwrap();
        let legacy_daemon = format!("{data}/.daemon.sh");
        fs::write(&legacy_daemon, "legacy daemon\n").unwrap();
        for (name, body) in [
            ("flock", "exit 0"),
            ("stat", "case \"$*\" in *%T*) echo tmpfs ;; *%u*) id -u ;; *%a*) echo 700 ;; esac"),
            ("timeout", "exit 0"),
            ("ps", "case \"$*\" in *ppid=*) case \"$TEST_PS_MODE\" in fail) exit 1 ;; D) printf '123 1 D sh %s\\n' \"$TEST_LEGACY_DAEMON\" ;; esac ;; *) if [ -f \"$HOME/started\" ]; then printf '456 sh %s\\n' \"$TEST_DAEMON\"; fi ;; esac"),
            ("nohup", "printf 'started\\n' >> \"$HOME/start-count\"; touch \"$HOME/started\""),
        ] {
            let file = bin.join(name);
            fs::write(&file, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(file, fs::Permissions::from_mode(0o700)).unwrap();
        }

        let script = build_install_script(&server, "upgrade-client")
            .replace("/run/lock/racktop-$racktop_uid", "$HOME/lock-root/racktop-$racktop_uid")
            .replace("/dev/shm/racktop-$racktop_uid", "$HOME/lock-root/racktop-$racktop_uid");
        let state = client_state_directory(&server, "upgrade-client").replace("$HOME", root.to_str().unwrap());
        for mode in ["D", "fail", "gone"] {
            let output = std::process::Command::new("sh").arg("-c").arg(&script)
                .env("HOME", root)
                .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
                .env("TEST_LEGACY_DAEMON", &legacy_daemon)
                .env("TEST_DAEMON", format!("{state}/.daemon.sh"))
                .env("TEST_PS_MODE", mode)
                .output().unwrap();
            assert!(output.status.success(), "mode={mode}: {}", String::from_utf8_lossy(&output.stderr));
            let marker = if mode == "gone" { "__RACKTOP_REMOTE_HISTORY_READY__" } else { "__RACKTOP_REMOTE_HISTORY_CLEANUP_PENDING__" };
            assert!(String::from_utf8_lossy(&output.stdout).contains(marker), "mode={mode}: {}", String::from_utf8_lossy(&output.stdout));
            assert_eq!(root.join("started").exists(), mode == "gone", "mode={mode}: unexpected replacement daemon state");
        }
        assert_eq!(fs::read_to_string(root.join("start-count")).unwrap().lines().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn installer_reports_unconfirmed_new_daemon_as_retryable_starting_state() {
        use std::os::unix::fs::PermissionsExt;
        let server: Server = serde_json::from_value(serde_json::json!({
            "id": "startup-test", "name": "startup-test", "host": "example.com", "port": 22,
            "username": "test", "tags": [], "samplingIntervalSeconds": 5,
            "historyRetentionDays": 90, "remoteHistoryEnabled": true,
            "authMethod": "sshAgent", "status": "unknown"
        })).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let bin = root.join("bin");
        fs::create_dir(&bin).unwrap();
        fs::create_dir(root.join("lock-root")).unwrap();
        for (name, body) in [
            ("flock", "case \"$*\" in *'-u 6'*) touch \"$HOME/launch-stage-reached\" ;; esac; exit 0"),
            ("stat", "case \"$*\" in *%T*) echo tmpfs ;; *%u*) id -u ;; *%a*) echo 700 ;; esac"),
            ("timeout", "exit 0"),
            ("ps", "exit 0"),
            ("sleep", "exit 0"),
            ("nohup", "exit 0"),
        ] {
            let file = bin.join(name);
            fs::write(&file, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(file, fs::Permissions::from_mode(0o700)).unwrap();
        }

        let script = build_install_script(&server, "startup-client")
            .replace("/run/lock/racktop-$racktop_uid", "$HOME/lock-root/racktop-$racktop_uid")
            .replace("/dev/shm/racktop-$racktop_uid", "$HOME/lock-root/racktop-$racktop_uid");
        let output = std::process::Command::new("sh").arg("-c").arg(&script)
            .env("HOME", root)
            .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
            .output().unwrap();

        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert!(String::from_utf8_lossy(&output.stdout).contains("__RACKTOP_REMOTE_HISTORY_STARTING__"), "stdout={} stderr={}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        let state = client_state_directory(&server, "startup-client").replace("$HOME", root.to_str().unwrap());
        assert!(Path::new(&state).join(".daemon.sh").exists());
        assert!(root.join("launch-stage-reached").exists());
    }

    #[cfg(unix)]
    #[test]
    fn installer_migrates_legacy_directories_without_releasing_the_install_lock() {
        use std::os::unix::fs::PermissionsExt;
        let server: Server = serde_json::from_value(serde_json::json!({
            "id": "upgrade-test", "name": "upgrade-test", "host": "example.com", "port": 22,
            "username": "test", "tags": [], "samplingIntervalSeconds": 5,
            "historyRetentionDays": 90, "remoteHistoryEnabled": true,
            "authMethod": "sshAgent", "status": "unknown"
        })).unwrap();
        let endpoint = endpoint_state_component(&server.host, server.port);
        for layout in ["remote-history", "remote-history-store"] {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path();
            let bin = root.join("bin");
            fs::create_dir(&bin).unwrap();
            fs::create_dir(root.join("lock-root")).unwrap();
            let legacy = root.join(format!(".racktop/{layout}/{endpoint}"));
            fs::create_dir_all(&legacy).unwrap();
            let history = "v1|3600|10|20|0|GPU-a,30,40\n";
            let usage = "v1|3600|GPU-a|alice|60|100|60\n";
            fs::write(legacy.join(".history-v1.tsv"), history).unwrap();
            fs::write(legacy.join(".usage-v1.tsv"), usage).unwrap();

            for (name, body) in [
                ("flock", "#!/usr/bin/env python3\nimport fcntl, sys\nfd = int(sys.argv[-1])\nif '-u' in sys.argv: flags = fcntl.LOCK_UN\nelse: flags = fcntl.LOCK_EX | (fcntl.LOCK_NB if '-n' in sys.argv else 0)\ntry: fcntl.flock(fd, flags)\nexcept BlockingIOError: sys.exit(1)\n"),
                ("stat", "#!/bin/sh\ncase \"$*\" in *%T*) echo tmpfs ;; *%u*) id -u ;; *%a*) echo 700 ;; esac\n"),
                ("timeout", "#!/bin/sh\nexit 0\n"),
                ("ps", "#!/bin/sh\ncase \"$*\" in *ppid=*) exit 0 ;; *) if [ -f \"$HOME/started\" ]; then printf '123 sh %s\\n' \"$TEST_DAEMON\"; fi ;; esac\n"),
                // The endpoint install lock must still be held after migration,
                // but the spawned daemon must not inherit its descriptor.
                ("nohup", "#!/usr/bin/env python3\nimport fcntl, os\nfrom pathlib import Path\ntry: os.fstat(5)\nexcept OSError: pass\nelse: raise RuntimeError('daemon inherited the endpoint install lock')\nlock_path = Path(os.environ['HOME'], 'lock-root', f'racktop-{os.getuid()}', os.environ['TEST_ENDPOINT'] + '.install.lock')\nwith lock_path.open('a') as lock:\n    try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)\n    except BlockingIOError: pass\n    else: raise RuntimeError('migration released the endpoint install lock')\nPath(os.environ['HOME'], 'started').touch()\n"),
            ] {
                let file = bin.join(name);
                fs::write(&file, body).unwrap();
                fs::set_permissions(file, fs::Permissions::from_mode(0o700)).unwrap();
            }

            let script = build_install_script(&server, "upgrade-client")
                .replace("/run/lock/racktop-$racktop_uid", "$HOME/lock-root/racktop-$racktop_uid")
                .replace("/dev/shm/racktop-$racktop_uid", "$HOME/lock-root/racktop-$racktop_uid");
            let state = client_state_directory(&server, "upgrade-client").replace("$HOME", root.to_str().unwrap());
            let output = std::process::Command::new("sh").arg("-c").arg(&script)
                .env("HOME", root)
                .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
                .env("TEST_DAEMON", format!("{state}/.daemon.sh"))
                .env("TEST_ENDPOINT", &endpoint)
                .output().unwrap();
            assert!(output.status.success(), "layout={layout}: stdout={} stderr={}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
            assert!(String::from_utf8_lossy(&output.stdout).contains("__RACKTOP_REMOTE_HISTORY_READY__"), "layout={layout}: {}", String::from_utf8_lossy(&output.stdout));
            assert!(root.join("started").exists(), "layout={layout}: new daemon was not started");
            let data = root.join(remote_state_directory(&server).strip_prefix("$HOME/").unwrap());
            assert_eq!(fs::read_to_string(data.join(".history-v1.tsv")).unwrap(), history);
            assert_eq!(fs::read_to_string(data.join(".usage-v1.tsv")).unwrap(), usage);
            assert_eq!(fs::read_to_string(legacy.join(".history-v1.tsv")).unwrap(), history);
            assert!(data.join(".legacy-reference").exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn concurrent_install_retries_run_the_unmodified_script_and_start_one_daemon() {
        use std::os::unix::fs::PermissionsExt;

        let server: Server = serde_json::from_value(serde_json::json!({
            "id": "concurrent-test", "name": "concurrent-test", "host": "example.com", "port": 22,
            "username": "test", "tags": [], "samplingIntervalSeconds": 5,
            "historyRetentionDays": 90, "remoteHistoryEnabled": true,
            "authMethod": "sshAgent", "status": "unknown"
        })).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let bin = root.join("bin");
        fs::create_dir(&bin).unwrap();
        fs::create_dir(root.join("lock-root")).unwrap();

        for (name, body) in [
            ("flock", "#!/usr/bin/env python3\nimport fcntl, sys\nfd = int(sys.argv[-1])\nif '-u' in sys.argv: flags = fcntl.LOCK_UN\nelse: flags = fcntl.LOCK_EX | (fcntl.LOCK_NB if '-n' in sys.argv else 0)\ntry: fcntl.flock(fd, flags)\nexcept BlockingIOError: sys.exit(1)\n"),
            ("stat", "#!/bin/sh\ncase \"$*\" in *%T*) echo tmpfs ;; *%u*) id -u ;; *%a*) echo 700 ;; esac\n"),
            ("timeout", "#!/bin/sh\nexit 0\n"),
            ("ps", "#!/bin/sh\nif [ -f \"$HOME/started\" ]; then printf '123 sh %s\\n' \"$TEST_DAEMON\"; fi\n"),
            ("nohup", "#!/bin/sh\nprintf 'started\\n' >> \"$HOME/start-count\"\ntouch \"$HOME/started\"\n"),
        ] {
            let file = bin.join(name);
            fs::write(&file, body).unwrap();
            fs::set_permissions(file, fs::Permissions::from_mode(0o700)).unwrap();
        }

        // This is the actual generated installer. A missing endpoint assignment
        // fails under set -u before the daemon lock can be acquired.
        let script = build_install_script(&server, "concurrent-client")
            .replace("/run/lock/racktop-$racktop_uid", "$HOME/lock-root/racktop-$racktop_uid")
            .replace("/dev/shm/racktop-$racktop_uid", "$HOME/lock-root/racktop-$racktop_uid");
        let endpoint_init = script.find("\nendpoint=\"").expect("installer initializes endpoint");
        let lock_acquire = script.find("if racktop_acquire_daemon_lock").expect("installer acquires daemon lock");
        assert!(endpoint_init < lock_acquire, "endpoint must be initialized before lock checks that use it");
        let daemon = client_state_directory(&server, "concurrent-client").replace("$HOME", root.to_str().unwrap());
        let daemon = format!("{daemon}/.daemon.sh");
        let path = format!("{}:/usr/bin:/bin", bin.display());

        let mut attempts = Vec::new();
        for _ in 0..8 {
            attempts.push(std::process::Command::new("sh")
                .arg("-c").arg(&script)
                .env("HOME", root)
                .env("PATH", &path)
                .env("TEST_DAEMON", &daemon)
                .stdout(Stdio::piped()).stderr(Stdio::piped())
                .spawn().unwrap());
        }
        for attempt in attempts {
            let output = attempt.wait_with_output().unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert!(
                stdout.contains("__RACKTOP_REMOTE_HISTORY_READY__")
                    || stdout.contains("__RACKTOP_REMOTE_HISTORY_STARTING__"),
                "unexpected install status: {stdout}"
            );
        }
        assert_eq!(fs::read_to_string(root.join("start-count")).unwrap().lines().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn compatibility_reader_keeps_root_and_recreated_endpoint_history_after_old_delete() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let bin = root.join("bin");
        fs::create_dir(&bin).unwrap();
        // Reader behavior only; lifecycle locking is exercised separately by
        // remoteHistoryLifecycle.test.js with real kernel locks.
        fs::write(bin.join("flock"), "#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(bin.join("flock"), fs::Permissions::from_mode(0o700)).unwrap();
        let server: Server = serde_json::from_value(serde_json::json!({
            "id": "test", "name": "test", "host": "gpu.example", "port": 22,
            "username": "test", "tags": [], "samplingIntervalSeconds": 2,
            "historyRetentionDays": 90, "authMethod": "sshAgent", "status": "offline"
        })).unwrap();
        let endpoint = endpoint_state_component(&server.host, server.port);
        let legacy = root.join(format!(".racktop/remote-history/{endpoint}"));
        let managed = root.join(remote_state_directory(&server).strip_prefix("$HOME/").unwrap());
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&managed).unwrap();
        for (path, timestamp) in [(&managed, 7200), (&legacy, 3600), (&root.join(".racktop"), 0)] {
            fs::write(path.join(".history-v1.tsv"), format!("v1|{timestamp}|10|20|0|GPU-a,25,40\n")).unwrap();
            fs::write(path.join(".usage-v1.tsv"), format!("v1|{timestamp}|GPU-a|alice|60|100|60\n")).unwrap();
        }
        let read = |usage| {
            let output = std::process::Command::new("sh").args(["-c", &compatibility_read_script(&server, 0, usage)])
                .env("HOME", root).env("PATH", format!("{}:{}", bin.display(), std::env::var("PATH").unwrap()))
                .output().unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            String::from_utf8(output.stdout).unwrap()
        };
        assert_eq!(parse_history(&read(false)).unwrap().len(), 3);
        assert_eq!(merge_compatibility_usage(&read(true)).len(), 3);
        // A recreated legacy file may contain a shorter row for the same
        // version/key. Snapshotting must retain the archived fuller coverage.
        fs::write(root.join(".racktop/.usage-v1.tsv"), "v2|3600|GPU-a|alice|3600|6000|3600\n").unwrap();
        assert_eq!(merge_compatibility_usage(&read(true)).iter().find(|point| point.bucket_seconds == 3600).unwrap().coverage_seconds, 3600);
        fs::write(root.join(".racktop/.usage-v1.tsv"), "v2|3600|GPU-a|alice|60|100|60\n").unwrap();
        assert_eq!(merge_compatibility_usage(&read(true)).iter().find(|point| point.bucket_seconds == 3600).unwrap().coverage_seconds, 3600);
        let archive = root.join(remote_state_directory(&server).strip_prefix("$HOME/").unwrap()).join("legacy-root/.usage-v1.tsv");
        assert!(fs::read_to_string(archive).unwrap().contains("v2|3600|GPU-a|alice|3600|6000|3600"));
        // Old reinstallation can replace a file rather than append. Preserve
        // already archived buckets as well as the newly created stream.
        fs::write(root.join(".racktop/.history-v1.tsv"), "v1|10800|10|20|0|GPU-a,25,40\n").unwrap();
        fs::write(root.join(".racktop/.usage-v1.tsv"), "v1|10800|GPU-a|alice|60|100|60\n").unwrap();
        assert_eq!(parse_history(&read(false)).unwrap().len(), 4);
        assert_eq!(merge_compatibility_usage(&read(true)).len(), 4);
        fs::remove_dir_all(root.join(".racktop")).unwrap();
        assert_eq!(parse_history(&read(false)).unwrap().len(), 4);
        assert_eq!(merge_compatibility_usage(&read(true)).len(), 4);
    }

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
    fn remote_state_directory_is_stable_per_client_and_unique_across_clients() {
        let first = remote_state_directory_for_endpoint("GPU.EXAMPLE.", 22, "client-a");
        let normalized = remote_state_directory_for_endpoint("gpu.example", 22, "client-a");
        let different_port = remote_state_directory_for_endpoint("gpu.example", 2222, "client-a");
        let different_host = remote_state_directory_for_endpoint("gpu2.example", 22, "client-a");
        let different_client = remote_state_directory_for_endpoint("gpu.example", 22, "client-b");

        assert_eq!(first, normalized);
        assert_ne!(first, different_port);
        assert_ne!(first, different_host);
        assert_ne!(first, different_client);
        assert!(first.starts_with("$HOME/.racktop-managed/remote-history-store/"));
    }

    #[test]
    fn client_identity_is_persistent_and_isolated_by_app_data_directory() {
        let directory = tempfile::tempdir().unwrap();
        let first_app = directory.path().join("first");
        let second_app = directory.path().join("second");
        let first = ClientIdentity::load_or_create(&first_app).unwrap();
        let reopened = ClientIdentity::load_or_create(&first_app).unwrap();
        let second = ClientIdentity::load_or_create(&second_app).unwrap();

        assert_eq!(first.as_str(), reopened.as_str());
        assert_ne!(first.as_str(), second.as_str());
        assert_eq!(fs::read_to_string(first_app.join(CLIENT_ID_FILENAME)).unwrap(), first.as_str());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(first_app.join(CLIENT_ID_FILENAME)).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn corrupted_client_identity_does_not_block_startup_or_replace_old_association() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(CLIENT_ID_FILENAME);
        fs::write(&path, "partial-id").unwrap();
        let first = ClientIdentity::load_or_create(directory.path()).unwrap();
        let second = ClientIdentity::load_or_create(directory.path()).unwrap();
        assert_eq!(first.as_str(), "");
        assert!(first.require().is_err());
        assert_eq!(second.as_str(), "");
        assert_eq!(fs::read_to_string(path).unwrap(), "partial-id");

        fs::write(directory.path().join(CLIENT_ID_FILENAME), [0xff, 0xfe]).unwrap();
        assert!(ClientIdentity::load_or_create(directory.path()).unwrap().require().is_err());
    }

    #[test]
    fn concurrent_client_identity_creation_publishes_one_complete_id() {
        let directory = tempfile::tempdir().unwrap();
        let identities = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8).map(|_| scope.spawn(|| {
                ClientIdentity::load_or_create(directory.path()).unwrap().as_str().to_owned()
            })).collect();
            handles.into_iter().map(|handle| handle.join().unwrap()).collect::<Vec<_>>()
        });
        assert!(Uuid::parse_str(&identities[0]).is_ok());
        assert!(identities.iter().all(|id| id == &identities[0]));
    }

    #[cfg(unix)]
    #[test]
    fn disabling_and_removing_one_client_preserves_the_other_clients_remote_state() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let state_a = remote_state_directory_for_endpoint("gpu.example", 22, "client-a");
        let state_b = remote_state_directory_for_endpoint("gpu.example", 22, "client-b");
        let path_a = root.join(state_a.strip_prefix("$HOME/").unwrap());
        let path_b = root.join(state_b.strip_prefix("$HOME/").unwrap());
        std::fs::create_dir_all(&path_a).unwrap();
        std::fs::create_dir_all(&path_b).unwrap();
        std::fs::write(path_a.join(".daemon.pid"), "99999999\n").unwrap();
        std::fs::write(path_b.join(".daemon.pid"), "88888888\n").unwrap();
        std::fs::write(path_a.join(".history-v1.tsv"), "client a history\n").unwrap();
        std::fs::write(path_b.join(".history-v1.tsv"), "client b history\n").unwrap();
        let shared = path_a.parent().unwrap().parent().unwrap();
        let shared_history = "legacy history\nnew history\n";
        std::fs::write(shared.join(".history-v1.tsv"), shared_history).unwrap();
        std::fs::write(shared.join(".usage-v1.tsv"), "shared usage\n").unwrap();
        // An offline installation remains associated even without a heartbeat.
        assert!(!path_b.join(".client-heartbeat").exists());

        let disabled = std::process::Command::new("sh")
            .arg("-c")
            .arg(build_disable_script(&state_a))
            .env("HOME", root)
            .output()
            .unwrap();
        assert!(disabled.status.success());
        assert!(!path_a.join(".daemon.pid").exists());
        assert!(path_b.join(".daemon.pid").exists());

        let remove = build_remove_script(&state_a, None).unwrap();
        let removed = std::process::Command::new("sh")
            .arg("-c")
            .arg(remove)
            .env("HOME", root)
            .output()
            .unwrap();
        assert!(removed.status.success(), "{}", String::from_utf8_lossy(&removed.stderr));
        assert!(!path_a.exists());
        assert_eq!(std::fs::read_to_string(path_b.join(".history-v1.tsv")).unwrap(), "client b history\n");
        assert_eq!(std::fs::read_to_string(shared.join(".history-v1.tsv")).unwrap(), shared_history);

        // Even the last known registration cannot prove that no legacy client
        // uses this directory: older versions never registered themselves.
        let removed_last = std::process::Command::new("sh")
            .arg("-c")
            .arg(build_remove_script(&state_b, None).unwrap())
            .env("HOME", root)
            .output()
            .unwrap();
        assert!(removed_last.status.success());
        assert!(!path_b.exists());
        assert_eq!(std::fs::read_to_string(shared.join(".history-v1.tsv")).unwrap(), shared_history);
        assert_eq!(std::fs::read_to_string(shared.join(".usage-v1.tsv")).unwrap(), "shared usage\n");
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
        let daemon_lock_script = REMOTE_DAEMON_LOCK_SCRIPT.replace("\r\n", "\n");
        let daemon_script = REMOTE_DAEMON_SCRIPT.replace("# RACKTOP_DAEMON_LOCK", &daemon_lock_script);
        let lock_dir = root.join(".racktop-locks");
        std::fs::create_dir(&lock_dir).unwrap();
        std::fs::write(state.join(".daemon.sh"), daemon_script).unwrap();
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
            .env("RACKTOP_HISTORY_ENDPOINT", "endpoint-a")
            .env("RACKTOP_HISTORY_CLIENT", "aa")
            .env("RACKTOP_DAEMON_LOCK_DIR", &lock_dir)
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
    fn collector_keeps_thirty_days_and_daemon_lock_is_independent_of_home_storage() {
        assert!(REMOTE_COLLECTOR_SCRIPT.contains("2592000"));
        assert!(REMOTE_COLLECTOR_SCRIPT.contains("value=(total > 0 ?"));
        assert!(REMOTE_COLLECTOR_SCRIPT.contains("umask 077"));
        assert!(REMOTE_COLLECTOR_SCRIPT.contains("$HOME/.racktop"));
        assert!(REMOTE_COLLECTOR_SCRIPT.contains(".history-v1.tsv"));
        assert!(REMOTE_DAEMON_SCRIPT.contains(".daemon.pid"));
        assert!(REMOTE_DAEMON_SCRIPT.contains(".client-heartbeat"));
        assert!(REMOTE_DAEMON_SCRIPT.contains("-gt 90"));
        assert!(REMOTE_DAEMON_SCRIPT.contains("sleep 60"));
        assert!(REMOTE_DAEMON_SCRIPT.contains("# RACKTOP_DAEMON_LOCK"));
        assert!(REMOTE_DAEMON_LOCK_SCRIPT.contains("/run/lock"));
        assert!(REMOTE_DAEMON_LOCK_SCRIPT.contains("stat -f -c %T"));
        assert!(REMOTE_DAEMON_LOCK_SCRIPT.contains("flock -n 8"));
        assert!(REMOTE_DAEMON_LOCK_SCRIPT.contains("racktop_daemon_exists"));
        assert!(REMOTE_DAEMON_LOCK_SCRIPT.contains("racktop_report_busy_daemon_status"));
        assert!(REMOTE_DAEMON_LOCK_SCRIPT.contains("__RACKTOP_REMOTE_HISTORY_STARTING__"));
        let daemon_script = REMOTE_DAEMON_SCRIPT
            .replace("# RACKTOP_DAEMON_LOCK", REMOTE_DAEMON_LOCK_SCRIPT)
            .replace("\r\n", "\n");
        assert!(daemon_script.contains("set -e\nset -u"));
        assert!(daemon_script.find("racktop_acquire_daemon_lock").unwrap() < daemon_script.find("mkdir -p \"$state_dir\"").unwrap());
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
    fn remote_daemon_install_locks_locally_before_shared_home_access() {
        // Windows checkouts may use CRLF, while the source assertions below
        // intentionally match LF-delimited Rust snippets.
        let source = include_str!("remote_history.rs").replace("\r\n", "\n");
        assert!(REMOTE_DAEMON_CLEANUP_SCRIPT.contains("ps -ww -u"));
        assert!(REMOTE_DAEMON_CLEANUP_SCRIPT.contains("kill -TERM"));
        assert!(REMOTE_DAEMON_CLEANUP_SCRIPT.contains("kill -KILL"));
        assert!(REMOTE_DAEMON_CLEANUP_SCRIPT.contains("ends_with_path(args, daemon)"));
        assert!(source.contains("nohup setsid sh \"$state/.daemon.sh\""));
        assert!(source.contains("replace(\"\\r\\n\", \"\\n\")"));
        assert!(source.contains("$state/.daemon.log"));
        let install_start = source.find("async fn install(").unwrap();
        let install_end = source[install_start..].find("#[cfg(test)]\nfn build_disable_script").unwrap() + install_start;
        let install = &source[install_start..install_end];
        let install_lock = install.find("if racktop_acquire_install_lock").unwrap();
        let lock = install.find("if racktop_acquire_daemon_lock").unwrap();
        let cleanup = install.find("if racktop_cleanup_legacy_daemons").unwrap();
        let lifecycle = install.find("{lifecycle}").unwrap();
        assert!(install_lock < lock && lock < cleanup && cleanup < lifecycle);
        assert!(install.contains("RACKTOP_DAEMON_LOCK_HELD=1"));
        assert!(install.contains("unset RACKTOP_DAEMON_LOCK_DIR"));
        assert!(install.contains("racktop_daemon_exists \"$state/.daemon.sh\" \"\" \"\""));
        assert_eq!(install.matches("if racktop_acquire_daemon_lock").count(), 2);
        assert!(install.contains("__RACKTOP_REMOTE_HISTORY_CLEANUP_PENDING__"));
        assert!(install.contains("flock -u 5"));
        assert!(!install.contains("$state/.install.lock"));
        assert!(!install.contains("pid=\"$(cat \"$state/.daemon.pid\""));
    }

    #[test]
    #[cfg(unix)]
    fn daemon_lock_busy_reports_ready_only_after_confirming_daemon_process() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let bin = root.join("bin");
        std::fs::create_dir(&bin).unwrap();
        for (name, body) in [
            ("ps", "printf '%s\\n' \"${RACKTOP_TEST_PS_OUTPUT:-}\""),
            ("sleep", "exit 0"),
        ] {
            let path = bin.join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let daemon = root.join(".daemon.sh");
        let run_status = |ps_output: &str| {
            std::process::Command::new("sh")
                .arg("-c")
                .arg(format!(
                    "{}\nracktop_report_busy_daemon_status \"$1\" \"\" \"\"",
                    REMOTE_DAEMON_LOCK_SCRIPT
                ))
                .arg("sh")
                .arg(&daemon)
                .env("PATH", format!("{}:{}", bin.display(), std::env::var("PATH").unwrap()))
                .env("RACKTOP_DAEMON_START_WAIT_SECONDS", "1")
                .env("RACKTOP_TEST_PS_OUTPUT", ps_output)
                .output()
                .unwrap()
        };

        let starting = run_status("");
        assert!(starting.status.success());
        assert_eq!(String::from_utf8_lossy(&starting.stdout).trim(), "__RACKTOP_REMOTE_HISTORY_STARTING__");

        let running = run_status(&format!("123 sh {}", daemon.display()));
        assert!(running.status.success());
        assert_eq!(String::from_utf8_lossy(&running.stdout).trim(), "__RACKTOP_REMOTE_HISTORY_READY__");
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
    #[test]
    fn compatibility_usage_does_not_mix_overlapping_old_and_new_hours() {
        let output = "__RACKTOP_SOURCE__\nv1|3600|GPU-a|alice|60|100|60\n__RACKTOP_SOURCE__\nv2|3600|GPU-a|alice|3600|900|3600\nv2|0|GPU-a|alice|3600|900|3600\n";
        let points = merge_compatibility_usage(output);
        assert_eq!(points.len(), 2);
        assert_eq!(points[0].bucket_seconds, 3600);
        assert_eq!(points[1].timestamp, 0);
        assert_eq!(points.iter().map(|point| point.active_seconds).sum::<i64>(), 7200);
        let disjoint = "v1|3600|GPU-a|alice|60|100|60\n__RACKTOP_SOURCE__\nv1|3600|GPU-a|alice|60|100|60\nv1|3660|GPU-a|alice|60|100|60\n";
        assert_eq!(merge_compatibility_usage(disjoint).len(), 2);
    }

    #[test]
    fn minute_rows_do_not_hide_other_gpus_users_or_complete_hour_rollups() {
        let output = "v1|3600|GPU-a|alice|60|100|60\nv2|3600|GPU-b|bob|3600|900|3600\nv2|3600|GPU-a|bob|3600|800|3600\nv1|3660|GPU-a|carol|60|200|60\nv2|3600|GPU-a|alice|3600|700|3600\n";
        let points = merge_compatibility_usage(output);
        assert_eq!(points.len(), 4);
        assert!(points.iter().any(|point| point.gpu_uuid == "GPU-b" && point.username == "bob"));
        assert!(points.iter().any(|point| point.gpu_uuid == "GPU-a" && point.username == "bob"));
        assert!(points.iter().any(|point| point.username == "carol" && point.bucket_seconds == 60));
        assert!(points.iter().any(|point| point.username == "alice" && point.active_seconds == 3600));
        let reversed = output.lines().rev().collect::<Vec<_>>().join("\n");
        assert_eq!(merge_compatibility_usage(&reversed).iter().map(|point| point.active_seconds).sum::<i64>(), 10860);
    }

    #[test]
    fn usage_merge_chooses_measured_coverage_and_does_not_count_duplicates() {
        let output = "v2|3600|GPU-a|alice|60|100|60\nv1|3600|GPU-a|alice|60|100|60\nv1|3660|GPU-a|alice|60|200|60\nv1|3660|GPU-a|alice|60|200|60\n";
        let points = merge_compatibility_usage(output);
        assert_eq!(points.len(), 2);
        assert!(points.iter().all(|point| point.bucket_seconds == 60));
        let complete = format!("{output}v2|3600|GPU-a|alice|3600|900|3600\n");
        let points = merge_compatibility_usage(&complete);
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].active_seconds, 3600);
        assert_eq!(points[0].coverage_seconds, 3600);
    }
}
