use crate::{collector, models::{Project, ProjectDraft, ProjectPathCheck, ProjectSyncProgress, ProjectSyncResult}, storage::Database};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, process::Stdio, sync::{atomic::{AtomicBool, Ordering}, Arc, LazyLock, Mutex}, time::{SystemTime, UNIX_EPOCH}};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, process::Child, time::{timeout, Duration}};

struct ActiveSyncEntry {
    progress: ProjectSyncProgress,
    cancel: Arc<AtomicBool>,
}

static ACTIVE_SYNC_TARGETS: LazyLock<Mutex<HashMap<String, ActiveSyncEntry>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

struct ActiveSyncTarget(String);

impl Drop for ActiveSyncTarget {
    fn drop(&mut self) {
        if let Ok(mut targets) = ACTIVE_SYNC_TARGETS.lock() {
            targets.remove(&self.0);
        }
    }
}

fn acquire_sync_target(key: String, project_id: &str, target_server_id: &str, total_bytes: u64) -> Result<(ActiveSyncTarget, Arc<AtomicBool>), String> {
    let mut targets = ACTIVE_SYNC_TARGETS.lock().map_err(|error| error.to_string())?;
    if targets.contains_key(&key) {
        return Err("该目标目录正在同步，请等待当前任务完成".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    targets.insert(key.clone(), ActiveSyncEntry {
        progress: ProjectSyncProgress {
            project_id: project_id.into(), target_server_id: target_server_id.into(), transferred_bytes: 0, resumed_bytes: 0, total_bytes,
            started_at: SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_secs() as i64,
            state: "preparing".into(),
        },
        cancel: cancel.clone(),
    });
    Ok((ActiveSyncTarget(key), cancel))
}

fn update_sync_progress(key: &str, transferred_bytes: u64, state: &str) {
    if let Ok(mut targets) = ACTIVE_SYNC_TARGETS.lock() {
        if let Some(entry) = targets.get_mut(key) {
            entry.progress.transferred_bytes = transferred_bytes;
            entry.progress.state = state.into();
        }
    }
}

fn set_sync_resume_offset(key: &str, resumed_bytes: u64) {
    if let Ok(mut targets) = ACTIVE_SYNC_TARGETS.lock() {
        if let Some(entry) = targets.get_mut(key) {
            entry.progress.resumed_bytes = resumed_bytes;
            entry.progress.transferred_bytes = resumed_bytes;
        }
    }
}

pub fn list_progress() -> Vec<ProjectSyncProgress> {
    ACTIVE_SYNC_TARGETS.lock().map(|targets| targets.values().map(|entry| entry.progress.clone()).collect()).unwrap_or_default()
}

pub fn cancel(project_id: &str, target_server_id: &str) -> bool {
    let Ok(targets) = ACTIVE_SYNC_TARGETS.lock() else { return false };
    let Some(entry) = targets.values().find(|entry| entry.progress.project_id == project_id && entry.progress.target_server_id == target_server_id) else { return false };
    entry.cancel.store(true, Ordering::Release);
    true
}

fn normalized_sync_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed == "/" || trimmed == "~/" { trimmed.to_string() } else { trimmed.trim_end_matches('/').to_string() }
}

fn sync_artifact_id(project: &Project, target_server: &crate::models::Server, target_path: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(project.source_server_id.as_bytes());
    digest.update([0]);
    digest.update(project.source_path.as_bytes());
    digest.update([0]);
    digest.update(target_server.host.to_lowercase().as_bytes());
    digest.update(target_server.port.to_le_bytes());
    digest.update(target_server.username.as_bytes());
    digest.update(normalized_sync_path(target_path).as_bytes());
    format!("{:x}", digest.finalize())[..20].to_string()
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn remote_home_expansion(variable: &str) -> String {
    debug_assert!(variable.chars().all(|character| character.is_ascii_alphanumeric() || character == '_'));
    r#"case "$__PATH__" in '~') __PATH__="$HOME" ;; '~/'*) __PATH__="$HOME/${__PATH__#??}" ;; "$HOME/~/"*) __PATH__="$HOME/${__PATH__#"$HOME/~/"}" ;; esac"#
        .replace("__PATH__", variable)
}

fn path_basename(path: &str, fallback: &str) -> String {
    path.trim().trim_end_matches('/').rsplit('/').next().filter(|value| !value.is_empty() && *value != "~").unwrap_or(fallback).to_string()
}

fn path_check_signature(check: &ProjectPathCheck) -> String {
    format!("{}:{}:{}:{}:{}", check.exists as u8, check.is_directory as u8, check.size_bytes, check.file_count, check.modified_at.unwrap_or_default())
}

fn target_changed_since_sync(target: &crate::models::ProjectTarget, check: &ProjectPathCheck) -> bool {
    if !check.exists {
        return target.last_synced_at.is_some();
    }
    if target.last_synced_at.is_none() {
        return true;
    }
    target.synced_target_size_bytes != Some(check.size_bytes)
        || target.synced_target_file_count != Some(check.file_count)
        || target.synced_target_modified_at != check.modified_at
        || target.is_directory != check.is_directory
}

fn target_signature_guard(expected: &str) -> String {
    format!(r#"current_signature() {{ if [ ! -e "$target" ]; then printf '0:0:0:0:0'; elif [ -d "$target" ]; then stats="$(find "$target" -printf '%y\t%s\t%T@\n' 2>/dev/null | awk -F '\t' 'BEGIN {{ files=0; bytes=0; latest=0 }} {{ if ($1 == "f") {{ files += 1; bytes += $2 }} value=int($3); if (value > latest) latest=value }} END {{ printf "%d:%d:%d", bytes, files, latest }}')"; printf '1:1:%s' "$stats"; else bytes="$(stat -c '%s' "$target" 2>/dev/null)"; modified="$(stat -c '%Y' "$target" 2>/dev/null)"; printf '1:0:%s:1:%s' "${{bytes:-0}}" "${{modified:-0}}"; fi; }}; before="$(current_signature)"; if [ "$before" != {expected} ]; then printf 'RackTop: 目标目录在同步期间发生修改\n' >&2; exit 75; fi;"#, expected = shell_quote(expected))
}

fn target_publish_script(target_path: &str, artifact_id: &str, expected_target_signature: &str, is_directory: bool, source_size: u64) -> String {
    let target_path = shell_quote(target_path);
    let expand_target = remote_home_expansion("target");
    let signature_guard = target_signature_guard(expected_target_signature);
    if is_directory {
        format!(r#"target={target_path}; {expand_target}; parent="${{target%/*}}"; [ "$parent" = "$target" ] && parent="$HOME"; part="$parent/.racktop-sync-{artifact_id}.part"; meta="$parent/.racktop-sync-{artifact_id}.meta"; stage="$parent/.racktop-sync-{artifact_id}.stage"; backup="$parent/.racktop-sync-{artifact_id}.backup"; published=0; cleanup() {{ code=$?; rm -rf -- "$stage"; if [ "$published" = 0 ] && [ -e "$backup" ] && [ ! -e "$target" ]; then mv -- "$backup" "$target"; elif [ "$published" = 1 ]; then rm -rf -- "$backup"; fi; exit "$code"; }}; trap cleanup EXIT HUP INT TERM; cat >> "$part"; rm -rf -- "$stage"; mkdir -p "$stage"; tar -xf "$part" -C "$stage"; {signature_guard} [ ! -e "$target" ] || mv -- "$target" "$backup"; mv -- "$stage" "$target"; published=1; rm -rf -- "$backup"; rm -f -- "$part" "$meta""#)
    } else {
        format!(r#"target={target_path}; {expand_target}; parent="${{target%/*}}"; [ "$parent" = "$target" ] && parent="$HOME"; part="$parent/.racktop-sync-{artifact_id}.part"; meta="$parent/.racktop-sync-{artifact_id}.meta"; backup="$parent/.racktop-sync-{artifact_id}.backup"; published=0; cleanup() {{ code=$?; if [ "$published" = 0 ] && [ -e "$backup" ] && [ ! -e "$target" ]; then mv -- "$backup" "$target"; elif [ "$published" = 1 ]; then rm -rf -- "$backup"; fi; exit "$code"; }}; trap cleanup EXIT HUP INT TERM; cat >> "$part"; actual="$(stat -c '%s' "$part" 2>/dev/null)"; if [ "${{actual:-0}}" -ne {source_size} ]; then printf 'RackTop: 传输文件大小校验失败\n' >&2; exit 76; fi; {signature_guard} [ ! -e "$target" ] || mv -- "$target" "$backup"; mv -- "$part" "$target"; published=1; rm -rf -- "$backup"; rm -f -- "$meta""#)
    }
}

async fn stop_child(child: &mut Child) {
    let _ = child.kill().await;
    let _ = child.wait().await;
}

async fn wait_child_with_cancel(child: &mut Child, cancel: &AtomicBool) -> Result<std::process::ExitStatus, String> {
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err("__RACKTOP_PAUSED__".into());
        }
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            return Ok(status);
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

async fn remote_output(server: &crate::models::Server, password: Option<&str>, script: String, timeout_seconds: u64) -> Result<String, String> {
    let (mut command, target) = collector::configured_ssh_command(server, password)?;
    command.arg(target).arg(script).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let output = timeout(Duration::from_secs(timeout_seconds), command.output()).await.map_err(|_| format!("连接 {} 超时", server.name))?.map_err(|error| format!("无法启动系统 ssh：{error}"))?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if error.is_empty() { format!("{} 路径检测失败", server.name) } else { error });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

pub async fn check_path(server: &crate::models::Server, password: Option<&str>, requested_path: &str, basename: &str) -> ProjectPathCheck {
    let expand_requested = remote_home_expansion("requested");
    let script = format!(r#"requested={requested}; name={name};
{expand_requested}
if [ "$requested" = / ] || [ "$requested" = "$HOME" ]; then
  printf 'RackTop: 不允许使用根目录或 Home 根目录\n' >&2
  exit 64
fi
if [ ! -e "$requested" ]; then
  matches="$(find "$HOME" -maxdepth 3 -mindepth 1 -name "$name" -print 2>/dev/null | sort | head -n 8)"
fi
if [ -e "$requested" ]; then
  if [ -d "$requested" ]; then
    kind=directory
    stats="$(find "$requested" -printf '%y\t%s\t%T@\n' 2>/dev/null | awk -F '\t' 'BEGIN {{ files=0; bytes=0; latest=0 }} {{ if ($1 == "f") {{ files += 1; bytes += $2 }} value=int($3); if (value > latest) latest=value }} END {{ printf "%d %d %d", bytes, files, latest }}')"
    read -r bytes files modified <<EOF
$stats
EOF
  else
    kind=file
    files=1
    bytes="$(stat -c '%s' "$requested" 2>/dev/null)"
    modified="$(stat -c '%Y' "$requested" 2>/dev/null)"
  fi
  [ -n "$modified" ] || modified="$(stat -c '%Y' "$requested" 2>/dev/null)"; modified="${{modified:-0}}"
  bytes="${{bytes:-0}}"
  printf '__RACKTOP_PATH__\tfound\t%s\t%s\t%s\t%s\n' "$kind" "$bytes" "$files" "$modified"
  printf '__RACKTOP_RESOLVED__\t%s\n' "$requested"
else
  printf '__RACKTOP_PATH__\tmissing\tunknown\t0\t0\n'
  printf '__RACKTOP_RESOLVED__\t%s\n' "$requested"
fi
printf '%s\n' "$matches" | while IFS= read -r match; do [ -z "$match" ] || printf '__RACKTOP_MATCH__\t%s\n' "$match"; done"#, requested = shell_quote(requested_path), name = shell_quote(basename));
    match remote_output(server, password, script, 20).await {
        Ok(output) => {
            let mut exists = false;
            let mut is_directory = false;
            let mut size_bytes = 0;
            let mut file_count = 0;
            let mut modified_at = None;
            let mut suggested_path = requested_path.to_string();
            let mut matches = Vec::new();
            for line in output.lines() {
                let fields: Vec<_> = line.split('\t').collect();
                match fields.first().copied() {
                    Some("__RACKTOP_PATH__") => {
                        exists = fields.get(1) == Some(&"found");
                        is_directory = fields.get(2) == Some(&"directory");
                        size_bytes = fields.get(3).and_then(|value| value.parse().ok()).unwrap_or(0);
                        file_count = fields.get(4).and_then(|value| value.parse().ok()).unwrap_or(0);
                        modified_at = fields.get(5).and_then(|value| value.parse::<i64>().ok()).filter(|value| *value > 0);
                    }
                    Some("__RACKTOP_RESOLVED__") => suggested_path = fields.get(1).copied().unwrap_or(requested_path).to_string(),
                    Some("__RACKTOP_MATCH__") => if let Some(value) = fields.get(1) { matches.push((*value).to_string()); },
                    _ => {}
                }
            }
            ProjectPathCheck { server_id: server.id.clone(), requested_path: requested_path.into(), suggested_path, exists, is_directory, size_bytes, file_count, modified_at, matches, error: None }
        }
        Err(error) => ProjectPathCheck { server_id: server.id.clone(), requested_path: requested_path.into(), suggested_path: requested_path.into(), exists: false, is_directory: false, size_bytes: 0, file_count: 0, modified_at: None, matches: vec![], error: Some(error) },
    }
}

fn suggestion_script(query: &str) -> String {
    format!(r#"query={query}
case "$query" in
  '~'|'~/') mode=home; parent="$HOME"; prefix="" ;;
  '~/'*) mode=home; rest="${{query#??}}"; case "$rest" in */*) dir="${{rest%/*}}"; prefix="${{rest##*/}}"; parent="$HOME/$dir" ;; *) parent="$HOME"; prefix="$rest" ;; esac ;;
  "$HOME/~/"*) mode=absolute; query="$HOME/${{query#"$HOME/~/"}}"; parent="${{query%/*}}"; prefix="${{query##*/}}" ;;
  /*) mode=absolute; parent="${{query%/*}}"; prefix="${{query##*/}}"; [ -n "$parent" ] || parent=/ ;;
  *) mode=relative; case "$query" in */*) dir="${{query%/*}}"; prefix="${{query##*/}}"; parent="$HOME/$dir" ;; *) parent="$HOME"; prefix="$query" ;; esac ;;
esac
[ -d "$parent" ] || exit 0
find "$parent" -maxdepth 1 -mindepth 1 -type d -print 2>/dev/null | sort | while IFS= read -r match; do
  base="${{match##*/}}"
  case "$base" in "$prefix"*) ;; *) continue ;; esac
  case "$prefix:$base" in .*:*) ;; *:.*) continue ;; esac
  case "$mode" in home) display="~/${{match#"$HOME"/}}" ;; relative) display="${{match#"$HOME"/}}" ;; *) display="$match" ;; esac
  display="$display/"
  printf '__RACKTOP_SUGGEST__\t%s\n' "$display"
done | head -n 12"#, query = shell_quote(query))
}

pub async fn suggest_paths(server: &crate::models::Server, password: Option<&str>, query: &str) -> Result<Vec<String>, String> {
    let script = suggestion_script(query);
    Ok(remote_output(server, password, script, 12).await?.lines().filter_map(|line| line.strip_prefix("__RACKTOP_SUGGEST__\t").map(str::to_string)).collect())
}

async fn validate_same_server_paths(server: &crate::models::Server, password: Option<&str>, source_path: &str, target_path: &str) -> Result<(), String> {
    let expand_source = remote_home_expansion("source");
    let expand_target = remote_home_expansion("target");
    let script = format!(r#"source={source}; target={target}; {expand_source}; {expand_target};
source="$(readlink -m -- "$source")"; target="$(readlink -m -- "$target")"
if [ "$source" = / ] || [ "$source" = "$HOME" ] || [ "$target" = / ] || [ "$target" = "$HOME" ]; then
  printf 'RackTop: 不允许使用根目录或 Home 根目录\n' >&2; exit 64
fi
case "$target/" in "$source/"*) printf 'RackTop: 目标目录不能位于主目录内\n' >&2; exit 64 ;; esac
case "$source/" in "$target/"*) printf 'RackTop: 主目录不能位于目标目录内\n' >&2; exit 64 ;; esac"#,
        source = shell_quote(source_path), target = shell_quote(target_path));
    remote_output(server, password, script, 12).await.map(|_| ())
}

pub async fn probe(database: &Database, draft: &ProjectDraft) -> Result<Vec<ProjectPathCheck>, String> {
    let source = database.get_server(&draft.source_server_id)?;
    let source_password = if source.auth_method == "password" { database.get_password(&source.id, false)? } else { None };
    let basename = path_basename(&draft.source_path, &draft.name);
    let mut checks = vec![check_path(&source, source_password.as_deref(), &draft.source_path, &basename).await];
    for target in &draft.targets {
        let server = database.get_server(&target.server_id)?;
        let password = if server.auth_method == "password" { database.get_password(&server.id, false)? } else { None };
        checks.push(check_path(&server, password.as_deref(), &target.path, &basename).await);
    }
    Ok(checks)
}

pub async fn inspect(database: &Database, project: &Project) -> Result<Project, String> {
    let source = database.get_server(&project.source_server_id)?;
    let source_password = if source.auth_method == "password" { database.get_password(&source.id, false)? } else { None };
    let basename = path_basename(&project.source_path, &project.name);
    let source_check = check_path(&source, source_password.as_deref(), &project.source_path, &basename).await;
    let mut targets = Vec::new();
    for target in &project.targets {
        let server = database.get_server(&target.server_id)?;
        let password = if server.auth_method == "password" { database.get_password(&server.id, false)? } else { None };
        let check = check_path(&server, password.as_deref(), &target.path, &basename).await;
        let source_unchanged_since_sync = target.synced_source_size_bytes == Some(source_check.size_bytes)
            && target.synced_source_file_count == Some(source_check.file_count)
            && target.synced_source_modified_at == source_check.modified_at;
        let target_changed_since_sync = check.error.is_none() && check.exists && target_changed_since_sync(target, &check);
        let target_unchanged_since_sync = target.last_synced_at.is_some() && !target_changed_since_sync;
        targets.push(crate::models::ProjectTarget {
            server_id: target.server_id.clone(), path: check.suggested_path.clone(),
            status: if check.error.is_some() { "offline".into() } else if !check.exists { "missing".into() } else if target_changed_since_sync { "conflict".into() } else if source_unchanged_since_sync && target_unchanged_since_sync { "synced".into() } else { "found".into() },
            exists: check.exists, is_directory: check.is_directory, size_bytes: check.size_bytes, file_count: check.file_count,
            modified_at: check.modified_at,
            last_checked_at: Some(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|error| error.to_string())?.as_secs() as i64),
            last_synced_at: target.last_synced_at, synced_source_size_bytes: target.synced_source_size_bytes, synced_source_file_count: target.synced_source_file_count, synced_source_modified_at: target.synced_source_modified_at,
            synced_target_size_bytes: target.synced_target_size_bytes, synced_target_file_count: target.synced_target_file_count, synced_target_modified_at: target.synced_target_modified_at,
            error: if target_changed_since_sync {
                Some(if target.last_synced_at.is_some() { "目标内容已在上次同步后修改".into() } else { "目标目录已有内容，首次同步需要确认".into() })
            } else { check.error },
        });
    }
    let error = source_check.error.as_deref();
    let status = if error.is_some() || !source_check.exists { "error" } else if targets.iter().any(|target| matches!(target.status.as_str(), "offline" | "error" | "conflict")) { "error" } else if targets.iter().any(|target| target.status != "synced") { "unknown" } else { "synced" };
    database.update_project_checks(&project.id, source_check.exists, source_check.is_directory, source_check.size_bytes, source_check.file_count, source_check.modified_at, &targets, status, error)
}

fn targets_after_source_check(project: &Project, source_check: &ProjectPathCheck) -> Vec<crate::models::ProjectTarget> {
    project.targets.iter().cloned().map(|mut target| {
        if matches!(target.status.as_str(), "missing" | "offline" | "error" | "conflict") {
            return target;
        }
        let source_unchanged_since_sync = target.last_synced_at.is_some()
            && target.synced_source_size_bytes == Some(source_check.size_bytes)
            && target.synced_source_file_count == Some(source_check.file_count)
            && target.synced_source_modified_at == source_check.modified_at;
        target.status = if source_unchanged_since_sync { "synced".into() } else if target.exists { "found".into() } else { "unknown".into() };
        target
    }).collect()
}

pub async fn inspect_source(database: &Database, project: &Project) -> Result<Project, String> {
    let source = database.get_server(&project.source_server_id)?;
    let source_password = if source.auth_method == "password" { database.get_password(&source.id, false)? } else { None };
    let basename = path_basename(&project.source_path, &project.name);
    let source_check = check_path(&source, source_password.as_deref(), &project.source_path, &basename).await;
    let targets = targets_after_source_check(project, &source_check);
    let error = source_check.error.as_deref();
    let status = if error.is_some() || !source_check.exists { "error" } else if targets.iter().any(|target| matches!(target.status.as_str(), "offline" | "error")) { "error" } else if targets.iter().all(|target| target.status == "synced") { "synced" } else { "unknown" };
    database.update_project_checks(&project.id, source_check.exists, source_check.is_directory, source_check.size_bytes, source_check.file_count, source_check.modified_at, &targets, status, error)
}

pub async fn sync(database: &Database, project: &Project, target_server_id: &str, force: bool) -> Result<ProjectSyncResult, String> {
    let target = project.targets.iter().find(|target| target.server_id == target_server_id).ok_or("目标服务器不属于此项目")?;
    if target.status == "conflict" && !force {
        return Err("目标内容已在上次同步后修改，需要确认后才能覆盖同名内容".into());
    }
    let target_server = database.get_server(target_server_id)?;
    let target_key = format!("{}:{}:{}:{}", target_server.host.to_lowercase(), target_server.port, target_server.username, normalized_sync_path(&target.path));
    let (_active_target, cancel_signal) = acquire_sync_target(target_key.clone(), &project.id, target_server_id, project.source_size_bytes)?;
    database.mark_project_syncing(&project.id, target_server_id)?;

    let operation = async {
        let source = database.get_server(&project.source_server_id)?;
        let source_password = if source.auth_method == "password" { database.get_password(&source.id, true)? } else { None };
        let target_password = if target_server.auth_method == "password" { database.get_password(&target_server.id, true)? } else { None };
        let basename = path_basename(&project.source_path, &project.name);
        let source_check = check_path(&source, source_password.as_deref(), &project.source_path, &basename).await;
        if !source_check.exists { return Err(source_check.error.unwrap_or_else(|| "主目录不存在".into())); }
        let target_check_before = check_path(&target_server, target_password.as_deref(), &target.path, &basename).await;
        if let Some(error) = target_check_before.error.clone() { return Err(error); }
        if target_check_before.exists && target_changed_since_sync(target, &target_check_before) && !force {
            return Err("__RACKTOP_CONFLICT__:目标目录已有内容或已在上次同步后修改".into());
        }
        if source.host.eq_ignore_ascii_case(&target_server.host) && source.port == target_server.port && source.username == target_server.username {
            validate_same_server_paths(&source, source_password.as_deref(), &source_check.suggested_path, &target.path).await?;
        }

        let (mut source_command, source_host) = collector::configured_ssh_command(&source, source_password.as_deref())?;
        let (mut target_command, target_host) = collector::configured_ssh_command(&target_server, target_password.as_deref())?;
        let source_path = shell_quote(&source_check.suggested_path);
        let target_path = shell_quote(&target.path);
        let expand_target = remote_home_expansion("target");
        let artifact_id = sync_artifact_id(project, &target_server, &target.path);
        let source_signature = format!("{}:{}:{}:{}", source_check.size_bytes, source_check.file_count, source_check.modified_at.unwrap_or_default(), source_check.is_directory as u8);
        let expected_target_signature = path_check_signature(&target_check_before);
        let prepare_script = format!(r#"target={target_path}; {expand_target}; parent="${{target%/*}}"; [ "$parent" = "$target" ] && parent="$HOME"; [ "$target" != / ] && [ "$target" != "$HOME" ] || {{ printf 'RackTop: 不允许使用根目录或 Home 根目录\n' >&2; exit 64; }}; mkdir -p "$parent"; part="$parent/.racktop-sync-{artifact_id}.part"; meta="$parent/.racktop-sync-{artifact_id}.meta"; backup="$parent/.racktop-sync-{artifact_id}.backup"; [ -e "$target" ] || [ ! -e "$backup" ] || mv -- "$backup" "$target"; signature={signature}; stored="$(cat "$meta" 2>/dev/null)"; if [ "$stored" != "$signature" ]; then rm -f -- "$part"; printf '%s' "$signature" > "$meta"; fi; offset="$(stat -c '%s' "$part" 2>/dev/null)"; offset="${{offset:-0}}"; if [ {source_is_directory} -eq 0 ] && [ "$offset" -gt {source_size} ]; then rm -f -- "$part"; offset=0; fi; available_kb="$(df -Pk "$parent" | awk 'NR==2 {{print $4}}')"; existing_kb=0; [ -e "$target" ] && existing_kb="$(du -sk "$target" 2>/dev/null | awk '{{print $1}}')"; required_kb=$((({source_size} * 2 + 1023) / 1024 + existing_kb + 65536 - offset / 1024)); [ "$required_kb" -lt 65536 ] && required_kb=65536; if [ "${{available_kb:-0}}" -lt "$required_kb" ]; then printf 'RackTop: 目标磁盘空间不足，需要约 %s KB，可用 %s KB\n' "$required_kb" "${{available_kb:-0}}" >&2; exit 73; fi; printf '__RACKTOP_OFFSET__\t%s\n' "$offset""#, artifact_id = artifact_id, signature = shell_quote(&source_signature), source_size = source_check.size_bytes, source_is_directory = source_check.is_directory as u8);
        let prepared = remote_output(&target_server, target_password.as_deref(), prepare_script, 20).await?;
        let resume_offset = prepared.lines().find_map(|line| line.strip_prefix("__RACKTOP_OFFSET__\t")).and_then(|value| value.parse::<u64>().ok()).unwrap_or(0);
        set_sync_resume_offset(&target_key, resume_offset);
        update_sync_progress(&target_key, resume_offset, "transferring");
        let source_stream = if source_check.is_directory { format!("cd {source_path} && tar --sort=name -cf - .") } else { format!("cat -- {source_path}") };
        let source_script = if resume_offset > 0 { format!("{source_stream} | tail -c +{}", resume_offset.saturating_add(1)) } else { source_stream };
        let target_script = target_publish_script(&target.path, &artifact_id, &expected_target_signature, source_check.is_directory, source_check.size_bytes);
        source_command.arg(source_host).arg(source_script).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        target_command.arg(target_host).arg(target_script).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped());
        source_command.kill_on_drop(true);
        target_command.kill_on_drop(true);

        let transfer = async {
            let mut source_child = source_command.spawn().map_err(|error| format!("无法启动主服务器传输：{error}"))?;
            let mut target_child = target_command.spawn().map_err(|error| format!("无法启动目标服务器传输：{error}"))?;
            let mut source_stdout = source_child.stdout.take().ok_or("无法读取主服务器数据流")?;
            let mut target_stdin = target_child.stdin.take().ok_or("无法写入目标服务器数据流")?;
            let mut source_stderr = source_child.stderr.take().ok_or("无法读取主服务器错误信息")?;
            let mut target_stderr = target_child.stderr.take().ok_or("无法读取目标服务器错误信息")?;
            let source_stderr_task = tokio::spawn(async move { let mut value = Vec::new(); let _ = source_stderr.read_to_end(&mut value).await; value });
            let target_stderr_task = tokio::spawn(async move { let mut value = Vec::new(); let _ = target_stderr.read_to_end(&mut value).await; value });
            update_sync_progress(&target_key, resume_offset, "transferring");
            let transfer_result: Result<(u64, std::process::ExitStatus, std::process::ExitStatus), String> = async {
                let mut transferred = resume_offset;
                let mut buffer = vec![0_u8; 128 * 1024];
                loop {
                    if cancel_signal.load(Ordering::Acquire) { return Err("__RACKTOP_PAUSED__".into()); }
                    let read = loop {
                        if cancel_signal.load(Ordering::Acquire) { return Err("__RACKTOP_PAUSED__".into()); }
                        match timeout(Duration::from_millis(200), source_stdout.read(&mut buffer)).await {
                            Ok(result) => break result.map_err(|error| format!("同步数据流中断：{error}"))?,
                            Err(_) => continue,
                        }
                    };
                    if read == 0 { break; }
                    let mut written = 0;
                    while written < read {
                        if cancel_signal.load(Ordering::Acquire) { return Err("__RACKTOP_PAUSED__".into()); }
                        match timeout(Duration::from_millis(200), target_stdin.write(&buffer[written..read])).await {
                            Ok(Ok(0)) => return Err("目标服务器提前关闭了数据流".into()),
                            Ok(Ok(count)) => written += count,
                            Ok(Err(error)) => return Err(format!("同步数据流中断：{error}")),
                            Err(_) => continue,
                        }
                    }
                    transferred = transferred.saturating_add(read as u64);
                    update_sync_progress(&target_key, transferred, "transferring");
                }
                target_stdin.shutdown().await.map_err(|error| error.to_string())?;
                drop(target_stdin);
                update_sync_progress(&target_key, transferred, "publishing");
                let source_status = wait_child_with_cancel(&mut source_child, &cancel_signal).await?;
                let target_status = wait_child_with_cancel(&mut target_child, &cancel_signal).await?;
                Ok((transferred, source_status, target_status))
            }.await;
            if transfer_result.is_err() {
                stop_child(&mut source_child).await;
                stop_child(&mut target_child).await;
            }
            let source_error = String::from_utf8_lossy(&source_stderr_task.await.unwrap_or_default()).trim().to_string();
            let target_error = String::from_utf8_lossy(&target_stderr_task.await.unwrap_or_default()).trim().to_string();
            let (transferred, source_status, target_status) = transfer_result?;
            if !source_status.success() { return Err(if source_error.is_empty() { "主服务器数据流生成失败".into() } else { source_error }); }
            if !target_status.success() { return Err(if target_error.is_empty() { "目标服务器发布副本失败".into() } else { target_error }); }
            Ok::<u64, String>(transferred)
        };
        let transferred = timeout(Duration::from_secs(6 * 60 * 60), transfer).await.map_err(|_| "同步超过 6 小时，已停止等待".to_string())??;
        Ok::<_, String>((transferred, source_check.size_bytes, source_check.file_count, source_check.modified_at))
    }.await;

    match operation {
        Ok((transferred, source_size_bytes, source_file_count, source_modified_at)) => {
            let verify_password = if target_server.auth_method == "password" { database.get_password(&target_server.id, false)? } else { None };
            let target_check = check_path(&target_server, verify_password.as_deref(), &target.path, &path_basename(&target.path, &project.name)).await;
            if target_check.error.is_some() || !target_check.exists {
                let error = target_check.error.unwrap_or_else(|| "同步完成后无法验证目标目录".into());
                let _ = database.mark_project_sync_failed(&project.id, target_server_id, &error);
                return Err(error);
            }
            database.mark_project_synced(&project.id, target_server_id, source_size_bytes, source_file_count, source_modified_at, target_check.size_bytes, target_check.file_count, target_check.modified_at, target_check.is_directory)?;
            Ok(ProjectSyncResult { project_id: project.id.clone(), target_server_id: target_server_id.into(), transferred_bytes: transferred, message: format!("已同步到 {}", target_server.name) })
        }
        Err(error) => {
            if error == "__RACKTOP_PAUSED__" {
                let _ = database.mark_project_sync_paused(&project.id, target_server_id);
                Err("同步已暂停".into())
            } else if error.starts_with("__RACKTOP_CONFLICT__:") || error.contains("目标目录在同步期间发生修改") {
                let message = error.strip_prefix("__RACKTOP_CONFLICT__:").unwrap_or(&error);
                let _ = database.mark_project_sync_conflict(&project.id, target_server_id, message);
                Err(message.into())
            } else {
                let _ = database.mark_project_sync_failed(&project.id, target_server_id, &error);
                Err(error)
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::{acquire_sync_target, path_check_signature, remote_home_expansion, shell_quote, suggestion_script, target_changed_since_sync, target_publish_script, targets_after_source_check};
    use crate::{models::{Project, ProjectDraft, ProjectPathCheck, ProjectTarget, ProjectTargetDraft, ServerDraft}, storage::Database};
    use std::{fs, process::Command, time::{Duration, SystemTime, UNIX_EPOCH}};

    fn expand_remote_path(path: &str, home: &str) -> String {
        let script = format!(
            "HOME={home}; path={path}; {expand}; printf '%s' \"$path\"",
            home = shell_quote(home),
            path = shell_quote(path),
            expand = remote_home_expansion("path"),
        );
        let output = Command::new("sh").arg("-c").arg(script).output().expect("shell should run");
        assert!(output.status.success());
        String::from_utf8(output.stdout).expect("path should be utf-8")
    }

    #[test]
    fn expands_tilde_against_remote_home() {
        assert_eq!(expand_remote_path("~/projects/demo", "/mnt/tongzh"), "/mnt/tongzh/projects/demo");
    }

    #[test]
    fn repairs_legacy_home_tilde_path() {
        assert_eq!(expand_remote_path("/mnt/tongzh/~/projects/demo", "/mnt/tongzh"), "/mnt/tongzh/projects/demo");
    }

    #[test]
    fn preserves_absolute_path() {
        assert_eq!(expand_remote_path("/data/projects/demo", "/mnt/tongzh"), "/data/projects/demo");
    }

    #[test]
    fn path_suggestions_preserve_absolute_paths_and_hide_dot_directories() {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir(home.path().join("projects")).unwrap();
        fs::create_dir(home.path().join(".cache")).unwrap();
        let query = format!("{}/", home.path().display());
        let output = Command::new("sh").arg("-c").arg(suggestion_script(&query)).env("HOME", home.path()).output().unwrap();
        assert!(output.status.success());
        let suggestions = String::from_utf8(output.stdout).unwrap();
        assert!(suggestions.contains(&format!("__RACKTOP_SUGGEST__\t{}/projects/", home.path().display())));
        assert!(!suggestions.contains(".cache"));
        assert!(!suggestions.contains("~/"));
    }

    #[test]
    fn duplicate_sync_target_is_rejected_until_the_first_finishes() {
        let (first, _) = acquire_sync_target("server:path".into(), "project", "server", 100).unwrap();
        assert!(acquire_sync_target("server:path".into(), "project", "server", 100).is_err());
        let (second_path, _) = acquire_sync_target("server:other-path".into(), "project", "server", 100).unwrap();
        drop(second_path);
        drop(first);
        assert!(acquire_sync_target("server:path".into(), "project", "server", 100).is_ok());
    }

    #[test]
    fn source_only_check_marks_synced_target_as_changed_without_contacting_it() {
        let target = ProjectTarget {
            server_id: "target".into(), path: "~/demo".into(), status: "synced".into(), exists: true, is_directory: true,
            size_bytes: 10, file_count: 1, modified_at: Some(100), last_checked_at: Some(100), last_synced_at: Some(100),
            synced_source_size_bytes: Some(10), synced_source_file_count: Some(1), synced_source_modified_at: Some(100), error: None,
            synced_target_size_bytes: Some(10), synced_target_file_count: Some(1), synced_target_modified_at: Some(100),
        };
        let project = Project {
            id: "project".into(), name: "demo".into(), kind: "project".into(), source_server_id: "source".into(), source_path: "~/demo".into(),
            source_exists: true, source_is_directory: true, source_size_bytes: 10, source_file_count: 1, source_modified_at: Some(100),
            dataset_ids: vec![], targets: vec![target], created_at: 1, updated_at: 1, last_sync_at: Some(100), status: "synced".into(), last_error: None,
        };
        let changed = ProjectPathCheck {
            server_id: "source".into(), requested_path: "~/demo".into(), suggested_path: "~/demo".into(), exists: true, is_directory: true,
            size_bytes: 12, file_count: 2, modified_at: Some(120), matches: vec![], error: None,
        };
        assert_eq!(targets_after_source_check(&project, &changed)[0].status, "found");
    }

    #[test]
    fn target_signatures_detect_first_sync_and_later_divergence() {
        let target = ProjectTarget {
            server_id: "target".into(), path: "~/demo".into(), status: "synced".into(), exists: true, is_directory: true,
            size_bytes: 10, file_count: 1, modified_at: Some(100), last_checked_at: Some(100), last_synced_at: Some(100),
            synced_source_size_bytes: Some(10), synced_source_file_count: Some(1), synced_source_modified_at: Some(100),
            synced_target_size_bytes: Some(10), synced_target_file_count: Some(1), synced_target_modified_at: Some(100), error: None,
        };
        let matching = ProjectPathCheck {
            server_id: "target".into(), requested_path: "~/demo".into(), suggested_path: "~/demo".into(), exists: true, is_directory: true,
            size_bytes: 10, file_count: 1, modified_at: Some(100), matches: vec![], error: None,
        };
        assert!(!target_changed_since_sync(&target, &matching));
        assert_eq!(path_check_signature(&matching), "1:1:10:1:100");

        let mut changed = matching.clone();
        changed.modified_at = Some(101);
        assert!(target_changed_since_sync(&target, &changed));

        let mut first_sync = target;
        first_sync.last_synced_at = None;
        assert!(target_changed_since_sync(&first_sync, &matching));
    }

    #[test]
    fn publish_scripts_validate_before_atomic_replacement() {
        let directory = target_publish_script("~/projects/demo", "artifact", "1:1:10:1:100", true, 10);
        assert!(directory.contains("目标目录在同步期间发生修改"));
        assert!(directory.contains("mv -- \"$target\" \"$backup\""));
        assert!(directory.contains("mv -- \"$stage\" \"$target\""));
        assert!(!directory.contains("cp -a"));

        let file = target_publish_script("~/projects/demo.bin", "artifact", "0:0:0:0:0", false, 4_096);
        assert!(file.contains("-ne 4096"));
        assert!(file.contains("传输文件大小校验失败"));
        assert!(file.contains("mv -- \"$part\" \"$target\""));
    }

    fn integration_server_draft(name: &str, value: &str) -> ServerDraft {
        let (username, host) = value.split_once('@').expect("test server must use user@host");
        ServerDraft {
            id: None, name: name.into(), location: None, host: host.into(), port: 22, username: username.into(),
            ssh_alias: None, identity_file: None, proxy_jump: None, tags: vec![], sampling_interval_seconds: 2,
            history_retention_days: 1, remote_history_enabled: false, auth_method: "sshAgent".into(), password: None, save_password: false,
        }
    }

    #[tokio::test]
    #[ignore = "requires two explicitly supplied SSH test servers"]
    async fn real_ssh_sync_rejects_conflicts_and_publishes_an_exact_copy() {
        let source_address = std::env::var("RACKTOP_SYNC_TEST_SOURCE").expect("RACKTOP_SYNC_TEST_SOURCE=user@host is required");
        let target_address = std::env::var("RACKTOP_SYNC_TEST_TARGET").expect("RACKTOP_SYNC_TEST_TARGET=user@host is required");
        let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let source_path = format!("/tmp/racktop-sync-source-{suffix}");
        let target_path = format!("/tmp/racktop-sync-target-{suffix}");
        let database_dir = tempfile::tempdir().unwrap();
        let database = Database::open(&database_dir.path().join("integration.sqlite")).unwrap();
        let source = database.save_server(integration_server_draft("Integration source", &source_address)).unwrap();
        let target = database.save_server(integration_server_draft("Integration target", &target_address)).unwrap();

        let outcome: Result<(), String> = async {
            super::remote_output(&source, None, format!("mkdir -p {path}; printf 'source-v1' > {path}/model.txt", path = shell_quote(&source_path)), 15).await?;
            let project = database.save_project(ProjectDraft {
                id: None, name: "SSH integration".into(), kind: "project".into(), source_server_id: source.id.clone(), source_path: source_path.clone(),
                dataset_ids: vec![], targets: vec![ProjectTargetDraft { server_id: target.id.clone(), path: target_path.clone() }],
            })?;
            let inspected = super::inspect(&database, &project).await?;
            if inspected.targets[0].status != "missing" { return Err(format!("expected missing target, got {}", inspected.targets[0].status)); }
            super::sync(&database, &inspected, &target.id, false).await?;
            let first = super::remote_output(&target, None, format!("cat {path}/model.txt", path = shell_quote(&target_path)), 15).await?;
            if first != "source-v1" { return Err(format!("unexpected first copy: {first:?}")); }

            super::remote_output(&target, None, format!("printf 'target-change' > {path}/model.txt; printf 'remove-me' > {path}/target-only.txt", path = shell_quote(&target_path)), 15).await?;
            let current = database.get_project(&project.id)?;
            let conflicted = super::inspect(&database, &current).await?;
            if conflicted.targets[0].status != "conflict" { return Err(format!("expected conflict, got {}", conflicted.targets[0].status)); }
            if super::sync(&database, &conflicted, &target.id, false).await.is_ok() { return Err("conflicting target was overwritten without confirmation".into()); }
            super::sync(&database, &conflicted, &target.id, true).await?;
            let published = super::remote_output(&target, None, format!("cat {path}/model.txt; test ! -e {path}/target-only.txt", path = shell_quote(&target_path)), 15).await?;
            if published != "source-v1" { return Err(format!("unexpected exact copy: {published:?}")); }
            Ok(())
        }.await;

        let _ = super::remote_output(&source, None, format!("rm -rf -- {}", shell_quote(&source_path)), 15).await;
        let _ = super::remote_output(&target, None, format!("rm -rf -- {}", shell_quote(&target_path)), 15).await;
        outcome.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires two explicitly supplied SSH test servers"]
    async fn real_ssh_sync_pauses_and_resumes_from_the_partial_file() {
        let source_address = std::env::var("RACKTOP_SYNC_TEST_SOURCE").expect("RACKTOP_SYNC_TEST_SOURCE=user@host is required");
        let target_address = std::env::var("RACKTOP_SYNC_TEST_TARGET").expect("RACKTOP_SYNC_TEST_TARGET=user@host is required");
        let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let source_path = format!("/tmp/racktop-sync-resume-source-{suffix}.bin");
        let target_path = format!("/tmp/racktop-sync-resume-target-{suffix}.bin");
        let database_dir = tempfile::tempdir().unwrap();
        let database = std::sync::Arc::new(Database::open(&database_dir.path().join("resume.sqlite")).unwrap());
        let source = database.save_server(integration_server_draft("Resume source", &source_address)).unwrap();
        let target = database.save_server(integration_server_draft("Resume target", &target_address)).unwrap();
        let mut cleanup_artifact_id = None;

        let outcome: Result<(), String> = async {
            super::remote_output(&source, None, format!("dd if=/dev/zero of={} bs=1M count=256 status=none", shell_quote(&source_path)), 30).await?;
            let project = database.save_project(ProjectDraft {
                id: None, name: "Resume integration".into(), kind: "project".into(), source_server_id: source.id.clone(), source_path: source_path.clone(),
                dataset_ids: vec![], targets: vec![ProjectTargetDraft { server_id: target.id.clone(), path: target_path.clone() }],
            })?;
            let inspected = super::inspect(&database, &project).await?;
            let project_id = inspected.id.clone();
            let target_id = target.id.clone();
            let database_for_sync = database.clone();
            let task = tokio::spawn(async move { super::sync(&database_for_sync, &inspected, &target_id, false).await });
            let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
            let partial_bytes = loop {
                if let Some(progress) = super::list_progress().into_iter().find(|item| item.project_id == project_id && item.target_server_id == target.id) {
                    if progress.transferred_bytes >= 4 * 1024 * 1024 {
                        super::cancel(&project_id, &target.id);
                        break progress.transferred_bytes;
                    }
                }
                if tokio::time::Instant::now() >= deadline { return Err("同步在可暂停前超时".into()); }
                tokio::time::sleep(Duration::from_millis(20)).await;
            };
            let paused = task.await.map_err(|error| error.to_string())?;
            if paused.as_ref().err().is_none_or(|error| !error.contains("暂停")) { return Err(format!("预期暂停结果，实际为 {paused:?}")); }
            let paused_project = database.get_project(&project_id)?;
            if paused_project.targets[0].status != "paused" { return Err(format!("预期 paused，实际为 {}", paused_project.targets[0].status)); }
            let artifact_id = super::sync_artifact_id(&paused_project, &target, &target_path);
            cleanup_artifact_id = Some(artifact_id.clone());
            let part_path = format!("/tmp/.racktop-sync-{artifact_id}.part");
            let stored: u64 = super::remote_output(&target, None, format!("stat -c '%s' {}", shell_quote(&part_path)), 15).await?.trim().parse().map_err(|error| format!("无法读取断点文件：{error}"))?;
            if stored == 0 || stored > partial_bytes { return Err(format!("断点大小异常：stored={stored}, progress={partial_bytes}")); }

            let resumed = super::sync(&database, &paused_project, &target.id, false).await?;
            if resumed.transferred_bytes < stored { return Err("续传结果未包含已保存的断点".into()); }
            let target_size = super::remote_output(&target, None, format!("stat -c '%s' {}; test ! -e {}", shell_quote(&target_path), shell_quote(&part_path)), 15).await?;
            if target_size.trim() != (256_u64 * 1024 * 1024).to_string() { return Err(format!("续传文件大小不正确：{target_size:?}")); }
            Ok(())
        }.await;

        let _ = super::remote_output(&source, None, format!("rm -f -- {}", shell_quote(&source_path)), 15).await;
        let artifact_cleanup = cleanup_artifact_id.map(|artifact_id| format!(" /tmp/.racktop-sync-{artifact_id}.part /tmp/.racktop-sync-{artifact_id}.meta /tmp/.racktop-sync-{artifact_id}.stage /tmp/.racktop-sync-{artifact_id}.backup")).unwrap_or_default();
        let _ = super::remote_output(&target, None, format!("rm -rf -- {}{artifact_cleanup}", shell_quote(&target_path)), 15).await;
        outcome.unwrap();
    }
}
