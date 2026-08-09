use crate::{collector, models::{Project, ProjectDraft, ProjectPathCheck, ProjectSyncResult}, storage::Database};
use std::process::Stdio;
use tokio::{io::AsyncWriteExt, time::{timeout, Duration}};

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn path_basename(path: &str, fallback: &str) -> String {
    path.trim().trim_end_matches('/').rsplit('/').next().filter(|value| !value.is_empty() && *value != "~").unwrap_or(fallback).to_string()
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
    let script = format!(r#"requested={requested}; name={name};
case "$requested" in '~') requested="$HOME" ;; '~/'*) requested="$HOME/${{requested#~/}}" ;; esac
if [ ! -e "$requested" ]; then
  first_match="$(find "$HOME" -maxdepth 3 -mindepth 1 -name "$name" -print 2>/dev/null | head -n 1)"
  [ -z "$first_match" ] || requested="$first_match"
fi
if [ -e "$requested" ]; then
  if [ -d "$requested" ]; then kind=directory; files="$(find "$requested" -type f 2>/dev/null | wc -l | tr -d ' ')"; else kind=file; files=1; fi
  bytes="$(du -sb "$requested" 2>/dev/null | awk '{{print $1; exit}}')"; [ -n "$bytes" ] || bytes="$(du -sk "$requested" 2>/dev/null | awk '{{print $1 * 1024; exit}}')"; bytes="${{bytes:-0}}"
  printf '__RACKTOP_PATH__\tfound\t%s\t%s\t%s\n' "$kind" "$bytes" "$files"
  printf '__RACKTOP_RESOLVED__\t%s\n' "$requested"
else
  printf '__RACKTOP_PATH__\tmissing\tunknown\t0\t0\n'
  printf '__RACKTOP_RESOLVED__\t%s\n' "$requested"
  find "$HOME" -maxdepth 3 -mindepth 1 -name "$name" -print 2>/dev/null | head -n 8 | while IFS= read -r match; do printf '__RACKTOP_MATCH__\t%s\n' "$match"; done
fi"#, requested = shell_quote(requested_path), name = shell_quote(basename));
    match remote_output(server, password, script, 20).await {
        Ok(output) => {
            let mut exists = false;
            let mut is_directory = false;
            let mut size_bytes = 0;
            let mut file_count = 0;
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
                    }
                    Some("__RACKTOP_RESOLVED__") => suggested_path = fields.get(1).copied().unwrap_or(requested_path).to_string(),
                    Some("__RACKTOP_MATCH__") => if let Some(value) = fields.get(1) { matches.push((*value).to_string()); },
                    _ => {}
                }
            }
            ProjectPathCheck { server_id: server.id.clone(), requested_path: requested_path.into(), suggested_path, exists, is_directory, size_bytes, file_count, matches, error: None }
        }
        Err(error) => ProjectPathCheck { server_id: server.id.clone(), requested_path: requested_path.into(), suggested_path: requested_path.into(), exists: false, is_directory: false, size_bytes: 0, file_count: 0, matches: vec![], error: Some(error) },
    }
}

pub async fn suggest_paths(server: &crate::models::Server, password: Option<&str>, query: &str) -> Result<Vec<String>, String> {
    let script = format!(r#"query={query}
case "$query" in
  '~'|'~/') parent="$HOME"; prefix="" ;;
  '~/'*) rest="${{query#~/}}"; case "$rest" in */*) dir="${{rest%/*}}"; prefix="${{rest##*/}}"; parent="$HOME/$dir" ;; *) parent="$HOME"; prefix="$rest" ;; esac ;;
  /*) parent="${{query%/*}}"; prefix="${{query##*/}}"; [ -n "$parent" ] || parent=/ ;;
  *) case "$query" in */*) dir="${{query%/*}}"; prefix="${{query##*/}}"; parent="$HOME/$dir" ;; *) parent="$HOME"; prefix="$query" ;; esac ;;
esac
[ -d "$parent" ] || exit 0
find "$parent" -maxdepth 1 -mindepth 1 -name "$prefix*" -print 2>/dev/null | sort | head -n 12 | while IFS= read -r match; do
  case "$match" in "$HOME"/*) display="~/${{match#"$HOME"/}}" ;; *) display="$match" ;; esac
  [ -d "$match" ] && display="$display/"
  printf '__RACKTOP_SUGGEST__\t%s\n' "$display"
done"#, query = shell_quote(query));
    Ok(remote_output(server, password, script, 12).await?.lines().filter_map(|line| line.strip_prefix("__RACKTOP_SUGGEST__\t").map(str::to_string)).collect())
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
        targets.push(crate::models::ProjectTarget {
            server_id: target.server_id.clone(), path: check.suggested_path.clone(),
            status: if check.error.is_some() { "offline".into() } else if check.exists && target.status == "synced" { "synced".into() } else if check.exists { "found".into() } else { "missing".into() },
            exists: check.exists, is_directory: check.is_directory, size_bytes: check.size_bytes, file_count: check.file_count,
            last_checked_at: Some(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|error| error.to_string())?.as_secs() as i64),
            last_synced_at: target.last_synced_at, error: check.error,
        });
    }
    let error = source_check.error.as_deref();
    let status = if error.is_some() || !source_check.exists { "error" } else if targets.iter().any(|target| target.status == "offline") { "error" } else if targets.iter().any(|target| target.status != "synced") { "unknown" } else { "synced" };
    database.update_project_checks(&project.id, source_check.exists, source_check.is_directory, source_check.size_bytes, source_check.file_count, &targets, status, error)
}

pub async fn sync(database: &Database, project: &Project, target_server_id: &str) -> Result<ProjectSyncResult, String> {
    let source = database.get_server(&project.source_server_id)?;
    let target_server = database.get_server(target_server_id)?;
    let target = project.targets.iter().find(|target| target.server_id == target_server_id).ok_or("目标服务器不属于此项目")?;
    let source_password = if source.auth_method == "password" { database.get_password(&source.id, true)? } else { None };
    let target_password = if target_server.auth_method == "password" { database.get_password(&target_server.id, true)? } else { None };
    let basename = path_basename(&project.source_path, &project.name);
    let source_check = check_path(&source, source_password.as_deref(), &project.source_path, &basename).await;
    if !source_check.exists { return Err(source_check.error.unwrap_or_else(|| "主目录不存在".into())); }

    let (mut source_command, source_host) = collector::configured_ssh_command(&source, source_password.as_deref())?;
    let (mut target_command, target_host) = collector::configured_ssh_command(&target_server, target_password.as_deref())?;
    let source_path = shell_quote(&source_check.suggested_path);
    let target_path = shell_quote(&target.path);
    let source_script = if source_check.is_directory { format!("cd {source_path} && tar -cf - .") } else { format!("cat -- {source_path}") };
    let target_script = if source_check.is_directory {
        format!("target={target_path}; case \"$target\" in '~') target=\"$HOME\" ;; '~/'*) target=\"$HOME/${{target#~/}}\" ;; esac; mkdir -p \"$target\" && cd \"$target\" && tar -xf -")
    } else {
        format!("target={target_path}; case \"$target\" in '~/'*) target=\"$HOME/${{target#~/}}\" ;; esac; parent=\"${{target%/*}}\"; [ \"$parent\" = \"$target\" ] && parent=\"$HOME\"; mkdir -p \"$parent\"; tmp=\"$target.racktop-part-$$\"; cat > \"$tmp\" && mv -f \"$tmp\" \"$target\"")
    };
    source_command.arg(source_host).arg(source_script).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    target_command.arg(target_host).arg(target_script).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped());
    source_command.kill_on_drop(true);
    target_command.kill_on_drop(true);

    let transfer = async {
        let mut source_child = source_command.spawn().map_err(|error| format!("无法启动主服务器传输：{error}"))?;
        let mut target_child = target_command.spawn().map_err(|error| format!("无法启动目标服务器传输：{error}"))?;
        let mut source_stdout = source_child.stdout.take().ok_or("无法读取主服务器数据流")?;
        let mut target_stdin = target_child.stdin.take().ok_or("无法写入目标服务器数据流")?;
        let transferred = tokio::io::copy(&mut source_stdout, &mut target_stdin).await.map_err(|error| format!("同步数据流中断：{error}"))?;
        target_stdin.shutdown().await.map_err(|error| error.to_string())?;
        drop(target_stdin);
        let source_output = source_child.wait_with_output().await.map_err(|error| error.to_string())?;
        let target_output = target_child.wait_with_output().await.map_err(|error| error.to_string())?;
        if !source_output.status.success() { return Err(String::from_utf8_lossy(&source_output.stderr).trim().to_string()); }
        if !target_output.status.success() { return Err(String::from_utf8_lossy(&target_output.stderr).trim().to_string()); }
        Ok::<u64, String>(transferred)
    };
    let transferred = timeout(Duration::from_secs(6 * 60 * 60), transfer).await.map_err(|_| "同步超过 6 小时，已停止等待".to_string())??;
    database.mark_project_synced(&project.id, target_server_id, transferred)?;
    Ok(ProjectSyncResult { project_id: project.id.clone(), target_server_id: target_server_id.into(), transferred_bytes: transferred, message: format!("已同步到 {}", target_server.name) })
}
