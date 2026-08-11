pub mod collector;
pub mod models;
mod remote_history;
mod project_sync;
mod host_key;
mod ssh_config;
mod ssh_keys;
pub mod storage;
mod terminal;

use models::{AppSettings, HistoryHeatmapPoint, HistoryPoint, HostKeyInfo, IdleReservation, InteractionLogSummary, InteractionServerSummary, ManagedRunLaunchResult, ManagedRunRemoteStatus, Project, ProjectDraft, ProjectPathCheck, ProjectSyncProgress, ProjectSyncResult, RemoteCleanupResult, RemoteCleanupSweepResult, RemoteHistorySyncResult, Server, ServerDraft, Snapshot, UsageDistribution};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{atomic::{AtomicU64, Ordering}, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use storage::Database;
use terminal::TerminalManager;
use tauri::{image::Image, menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID}, tray::TrayIconBuilder, AppHandle, Emitter, Manager, State};

#[derive(Default)]
struct InteractionLogStore {
    next_id: AtomicU64,
    state: Mutex<InteractionLogState>,
}

#[derive(Default)]
struct InteractionLogState {
    sent_bytes: u64,
    response_bytes: u64,
    stored_bytes: u64,
    failure_count: u64,
    servers: HashMap<String, InteractionServerState>,
    interactions: HashMap<u64, String>,
}

struct InteractionServerState {
    id: u64,
    server_name: String,
    sent_bytes: u64,
    response_bytes: u64,
    stored_bytes: u64,
    last_started_at: i64,
    last_finished_at: Option<i64>,
    last_command: String,
    status: String,
    error: Option<String>,
}

impl InteractionLogStore {
    fn now_millis() -> i64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_millis() as i64).unwrap_or_default()
    }

    fn begin(&self, server: &Server, command: String) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let sent_bytes = command.len() as u64;
        if let Ok(mut state) = self.state.lock() {
            state.sent_bytes = state.sent_bytes.saturating_add(sent_bytes);
            state.interactions.insert(id, server.id.clone());
            let entry = state.servers.entry(server.id.clone()).or_insert_with(|| InteractionServerState {
                id,
                server_name: server.name.clone(),
                sent_bytes: 0,
                response_bytes: 0,
                stored_bytes: 0,
                last_started_at: 0,
                last_finished_at: None,
                last_command: String::new(),
                status: "success".into(),
                error: None,
            });
            entry.id = id;
            entry.server_name = server.name.clone();
            entry.sent_bytes = entry.sent_bytes.saturating_add(sent_bytes);
            entry.last_started_at = Self::now_millis();
            entry.last_finished_at = None;
            entry.last_command = command;
            entry.status = "running".into();
            entry.error = None;
        }
        id
    }

    fn finish(&self, id: u64, response_bytes: u64, stored_bytes: u64, error: Option<String>) {
        if let Ok(mut state) = self.state.lock() {
            state.response_bytes = state.response_bytes.saturating_add(response_bytes);
            state.stored_bytes = state.stored_bytes.saturating_add(stored_bytes);
            if error.is_some() {
                state.failure_count = state.failure_count.saturating_add(1);
            }
            if let Some(server_id) = state.interactions.remove(&id)
                && let Some(entry) = state.servers.get_mut(&server_id)
            {
                entry.response_bytes = entry.response_bytes.saturating_add(response_bytes);
                entry.stored_bytes = entry.stored_bytes.saturating_add(stored_bytes);
                if entry.id == id {
                    entry.last_finished_at = Some(Self::now_millis());
                    entry.status = if error.is_some() { "error".into() } else { "success".into() };
                    entry.error = error;
                }
            }
        }
    }

    fn summary(&self, local_storage_bytes: u64) -> Result<InteractionLogSummary, String> {
        let state = self.state.lock().map_err(|error| error.to_string())?;
        let mut servers: Vec<_> = state.servers.iter().map(|(server_id, entry)| InteractionServerSummary {
            server_id: server_id.clone(),
            server_name: entry.server_name.clone(),
            sent_bytes: entry.sent_bytes,
            response_bytes: entry.response_bytes,
            stored_bytes: entry.stored_bytes,
            last_started_at: entry.last_started_at,
            last_finished_at: entry.last_finished_at,
            last_command: entry.last_command.clone(),
            status: entry.status.clone(),
            error: entry.error.clone(),
        }).collect();
        servers.sort_by(|left, right| left.server_name.cmp(&right.server_name));
        Ok(InteractionLogSummary { sent_bytes: state.sent_bytes, response_bytes: state.response_bytes, stored_bytes: state.stored_bytes, local_storage_bytes, failure_count: state.failure_count, servers })
    }
}

#[cfg(test)]
mod interaction_log_tests {
    use super::*;

    fn server(id: &str, name: &str) -> Server {
        Server {
            id: id.into(), name: name.into(), location: None, host: "10.0.0.1".into(), port: 22,
            username: "test".into(), ssh_alias: None, identity_file: None, proxy_jump: None, tags: vec![],
            sampling_interval_seconds: 2, history_retention_days: 90, remote_history_enabled: false,
            remote_history_last_sync_at: None, sort_order: 0, auth_method: "sshAgent".into(),
            status: "online".into(), last_error: None, last_seen_at: None,
        }
    }

    #[test]
    fn aggregates_session_traffic_and_latest_state_per_server() {
        let logs = InteractionLogStore::default();
        let first = server("a", "Alpha");
        let second = server("b", "Beta");
        let first_id = logs.begin(&first, "abc".into());
        logs.finish(first_id, 20, 7, None);
        let second_id = logs.begin(&second, "hello".into());
        logs.finish(second_id, 4, 0, Some("offline".into()));

        let summary = logs.summary(512).unwrap();
        assert_eq!(summary.sent_bytes, 8);
        assert_eq!(summary.response_bytes, 24);
        assert_eq!(summary.stored_bytes, 7);
        assert_eq!(summary.local_storage_bytes, 512);
        assert_eq!(summary.failure_count, 1);
        assert_eq!(summary.servers.len(), 2);
        assert_eq!(summary.servers[0].server_name, "Alpha");
        assert_eq!(summary.servers[1].status, "error");
    }

    #[test]
    fn overlapping_interactions_keep_all_bytes_without_overwriting_newer_state() {
        let logs = InteractionLogStore::default();
        let target = server("a", "Alpha");
        let old_id = logs.begin(&target, "old".into());
        let new_id = logs.begin(&target, "new".into());
        logs.finish(old_id, 11, 3, Some("old failure".into()));
        assert_eq!(logs.summary(0).unwrap().servers[0].status, "running");
        logs.finish(new_id, 7, 2, None);

        let summary = logs.summary(0).unwrap();
        assert_eq!(summary.response_bytes, 18);
        assert_eq!(summary.stored_bytes, 5);
        assert_eq!(summary.failure_count, 1);
        assert_eq!(summary.servers[0].response_bytes, 18);
        assert_eq!(summary.servers[0].status, "success");
    }
}

#[tauri::command]
fn get_interaction_log_summary(database: State<'_, Database>, logs: State<'_, InteractionLogStore>) -> Result<InteractionLogSummary, String> {
    logs.summary(database.storage_size_bytes())
}

#[tauri::command]
fn list_servers(database: State<'_, Database>) -> Result<Vec<Server>, String> {
    database.list_servers()
}

#[tauri::command]
fn save_server(database: State<'_, Database>, draft: ServerDraft) -> Result<Server, String> {
    database.save_server(draft)
}

#[tauri::command]
async fn delete_server(database: State<'_, Database>, server_id: String, revoke_ssh_access: bool) -> Result<RemoteCleanupResult, String> {
    let server = database.get_server(&server_id)?;
    let password = if server.auth_method == "password" { database.get_password(&server_id, false).unwrap_or(None) } else { None };
    let managed_public_key = if revoke_ssh_access {
        Some(ssh_keys::managed_public_key(&server)?.ok_or("这台服务器未使用 RackTop 专用密钥，无法自动撤销免密登录")?)
    } else {
        None
    };
    match remote_history::remove(&server, password.as_deref(), managed_public_key.as_deref()).await {
        Ok(()) => {
            database.delete_server(&server_id)?;
            let suffix = if revoke_ssh_access { "，并已撤销 RackTop 免密登录" } else { "" };
            Ok(RemoteCleanupResult { remote_cleaned: true, cleanup_pending: false, message: format!("已删除“{}”及其本地与远端 RackTop 数据{}", server.name, suffix) })
        }
        Err(error) => {
            let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|reason| reason.to_string())?.as_secs() as i64;
            database.enqueue_remote_cleanup(&server, now, &error, managed_public_key.as_deref())?;
            database.delete_server_record(&server_id, false)?;
            let scope = if revoke_ssh_access { "远端数据与免密授权" } else { "远端数据" };
            Ok(RemoteCleanupResult { remote_cleaned: false, cleanup_pending: true, message: format!("已删除“{}”的本地记录；{}清理将在重新连接后自动重试 24 小时", server.name, scope) })
        }
    }
}

#[tauri::command]
fn reorder_servers(database: State<'_, Database>, server_ids: Vec<String>) -> Result<(), String> {
    database.reorder_servers(&server_ids)
}

#[tauri::command]
fn start_terminal(app: tauri::AppHandle, database: State<'_, Database>, terminals: State<'_, TerminalManager>, server_id: String, columns: u16, rows: u16, gpu_index: Option<u32>) -> Result<String, String> {
    let server = database.get_server(&server_id)?;
    let password = if server.auth_method == "password" { database.get_password(&server_id, true)? } else { None };
    terminals.start(app, &server, password.as_deref(), columns, rows, gpu_index)
}

#[tauri::command]
fn write_terminal(terminals: State<'_, TerminalManager>, session_id: String, data: String) -> Result<(), String> {
    terminals.write(&session_id, data.as_bytes())
}

#[tauri::command]
fn resize_terminal(terminals: State<'_, TerminalManager>, session_id: String, columns: u16, rows: u16) -> Result<(), String> {
    terminals.resize(&session_id, columns, rows)
}

#[tauri::command]
fn close_terminal(terminals: State<'_, TerminalManager>, session_id: String) -> Result<(), String> {
    terminals.close(&session_id)
}

#[tauri::command]
async fn collect_server(database: State<'_, Database>, logs: State<'_, InteractionLogStore>, server_id: String, include_processes: bool, include_disks: bool, record_history: bool, allow_credential_prompt: bool) -> Result<Snapshot, String> {
    let server = database.get_server(&server_id)?;
    let log_id = logs.begin(&server, collector::collection_display_command(&server, include_processes, include_disks));
    let password = match if server.auth_method == "password" { database.get_password(&server_id, allow_credential_prompt) } else { Ok(None) } {
        Ok(password) => password,
        Err(error) => {
            logs.finish(log_id, 0, 0, Some(error.clone()));
            return Err(error);
        }
    };
    match collector::collect_with_password_detailed(&server, password.as_deref(), include_processes, include_disks).await {
        Ok(collected) => {
            let response_bytes = collected.response_bytes;
            let snapshot = collected.snapshot;
            let mut stored_bytes = 0u64;
            let stored = (|| -> Result<(), String> {
                database.update_status(&server_id, &snapshot.status, snapshot.nvidia_message.as_deref(), Some(snapshot.timestamp))?;
                if record_history {
                    stored_bytes = serde_json::to_vec(&snapshot).map_err(|error| error.to_string())?.len() as u64;
                    database.save_snapshot(&snapshot)?;
                }
                if snapshot.processes_sampled {
                    let usage_rows = database.save_local_usage(&snapshot)?;
                    stored_bytes = stored_bytes.saturating_add((usage_rows as u64).saturating_mul(96));
                }
                Ok(())
            })();
            match stored {
                Ok(()) => {
                    logs.finish(log_id, response_bytes, stored_bytes, None);
                    Ok(snapshot)
                }
                Err(error) => {
                    logs.finish(log_id, response_bytes, stored_bytes, Some(error.clone()));
                    Err(error)
                }
            }
        }
        Err(error) => {
            logs.finish(log_id, 0, 0, Some(error.clone()));
            Err(error)
        }
    }
}

#[tauri::command]
async fn get_history(app: AppHandle, server_id: String, from_timestamp: i64, bucket_seconds: Option<i64>) -> Result<Vec<HistoryPoint>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let database = app.state::<Database>();
        match bucket_seconds.filter(|seconds| *seconds > 0) {
            Some(seconds) => database.get_compacted_history(&server_id, from_timestamp, seconds),
            None => database.get_history(&server_id, from_timestamp),
        }
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
fn get_history_heatmap(database: State<'_, Database>, server_id: String, from_timestamp: i64, timezone_offset_seconds: i64, gpu_uuids: Vec<String>) -> Result<Vec<HistoryHeatmapPoint>, String> {
    database.get_history_heatmap(&server_id, from_timestamp, timezone_offset_seconds, &gpu_uuids)
}

#[tauri::command]
fn get_usage_distribution(database: State<'_, Database>, server_id: String, from_timestamp: i64, requested_days: i64) -> Result<UsageDistribution, String> {
    database.get_usage_distribution(&server_id, from_timestamp, requested_days)
}

#[tauri::command]
async fn configure_remote_history(database: State<'_, Database>, server_id: String) -> Result<(), String> {
    let server = database.get_server(&server_id)?;
    let password = if server.auth_method == "password" { database.get_password(&server_id, false)? } else { None };
    remote_history::configure(&server, password.as_deref()).await
}

#[tauri::command]
async fn sync_remote_history(database: State<'_, Database>, server_id: String) -> Result<RemoteHistorySyncResult, String> {
    let server = database.get_server(&server_id)?;
    if !server.remote_history_enabled {
        return Ok(RemoteHistorySyncResult { imported_count: 0, latest_timestamp: server.remote_history_last_sync_at });
    }
    if !database.get_settings()?.history_enabled {
        return Ok(RemoteHistorySyncResult { imported_count: 0, latest_timestamp: server.remote_history_last_sync_at });
    }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_secs() as i64;
    let since = database.remote_history_cursor(&server_id, now)?;
    let password = if server.auth_method == "password" { database.get_password(&server_id, false)? } else { None };
    let fetched_points = remote_history::fetch(&server, password.as_deref(), since).await?;
    let usage_points = remote_history::fetch_usage(&server, password.as_deref(), since).await?;
    let points: Vec<_> = fetched_points.iter().filter(|point| point.timestamp >= now - 31 * 86_400 && point.timestamp <= now + 300).cloned().collect();
    if !fetched_points.is_empty() && points.is_empty() {
        return Err("远端历史时间戳超出有效范围，请检查服务器系统时间和时区".into());
    }
    let latest_timestamp = points.iter().map(|point| point.timestamp).max().or(server.remote_history_last_sync_at);
    let imported_count = database.import_remote_history(&server_id, &points)?;
    let usage_imported = database.import_remote_usage(&server_id, &usage_points, now)?;
    Ok(RemoteHistorySyncResult { imported_count: imported_count + usage_imported, latest_timestamp })
}

#[tauri::command]
async fn retry_remote_cleanups(database: State<'_, Database>) -> Result<RemoteCleanupSweepResult, String> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_secs() as i64;
    let mut result = RemoteCleanupSweepResult { cleaned_names: Vec::new(), pending_names: Vec::new(), expired_names: Vec::new() };
    for task in database.list_remote_cleanup_tasks()? {
        if task.expires_at <= now {
            database.finish_remote_cleanup(&task.server.id, task.server.auth_method == "password")?;
            result.expired_names.push(task.server.name);
            continue;
        }
        let password = if task.server.auth_method == "password" { database.get_password(&task.server.id, false)? } else { None };
        match remote_history::remove(&task.server, password.as_deref(), task.managed_public_key.as_deref()).await {
            Ok(()) => {
                database.finish_remote_cleanup(&task.server.id, task.server.auth_method == "password")?;
                result.cleaned_names.push(task.server.name);
            }
            Err(error) => {
                database.update_remote_cleanup_error(&task.server.id, &error)?;
                result.pending_names.push(task.server.name);
            }
        }
    }
    Ok(result)
}

#[tauri::command]
fn list_idle_reservations(database: State<'_, Database>) -> Result<Vec<IdleReservation>, String> {
    database.list_idle_reservations()
}

#[tauri::command]
fn save_idle_reservation(database: State<'_, Database>, reservation: IdleReservation) -> Result<IdleReservation, String> {
    database.save_idle_reservation(reservation)
}

#[tauri::command]
fn delete_idle_reservation(database: State<'_, Database>, reservation_id: String) -> Result<(), String> {
    database.delete_idle_reservation(&reservation_id)
}

#[tauri::command]
fn list_projects(database: State<'_, Database>) -> Result<Vec<Project>, String> {
    database.list_projects()
}

#[tauri::command]
fn save_project(database: State<'_, Database>, draft: ProjectDraft) -> Result<Project, String> {
    database.save_project(draft)
}

#[tauri::command]
fn delete_project(database: State<'_, Database>, project_id: String) -> Result<(), String> {
    database.delete_project(&project_id)
}

#[tauri::command]
async fn probe_project_paths(database: State<'_, Database>, draft: ProjectDraft) -> Result<Vec<ProjectPathCheck>, String> {
    project_sync::probe(&database, &draft).await
}

#[tauri::command]
async fn suggest_project_paths(database: State<'_, Database>, server_id: String, query: String) -> Result<Vec<String>, String> {
    let server = database.get_server(&server_id)?;
    let password = if server.auth_method == "password" { database.get_password(&server.id, false)? } else { None };
    project_sync::suggest_paths(&server, password.as_deref(), &query).await
}

#[tauri::command]
async fn inspect_project(database: State<'_, Database>, project_id: String) -> Result<Project, String> {
    let project = database.get_project(&project_id)?;
    project_sync::inspect(&database, &project).await
}

#[tauri::command]
async fn inspect_project_source(database: State<'_, Database>, project_id: String) -> Result<Project, String> {
    let project = database.get_project(&project_id)?;
    project_sync::inspect_source(&database, &project).await
}

#[tauri::command]
async fn sync_project(database: State<'_, Database>, project_id: String, target_server_id: String, force: bool) -> Result<ProjectSyncResult, String> {
    let project = database.get_project(&project_id)?;
    project_sync::sync(&database, &project, &target_server_id, force).await
}

#[tauri::command]
fn list_project_sync_progress() -> Vec<ProjectSyncProgress> {
    project_sync::list_progress()
}

#[tauri::command]
fn cancel_project_sync(project_id: String, target_server_id: String) -> Result<(), String> {
    if project_sync::cancel(&project_id, &target_server_id) { Ok(()) } else { Err("找不到正在运行的同步任务".into()) }
}

#[tauri::command]
fn import_ssh_config(path: Option<String>) -> Result<Vec<ServerDraft>, String> {
    let path = path.map(PathBuf::from).map(Ok).unwrap_or_else(ssh_config::default_config_path)?;
    ssh_config::import(&path)
}

#[tauri::command]
fn get_settings(database: State<'_, Database>) -> Result<AppSettings, String> {
    database.get_settings()
}

#[tauri::command]
fn save_settings(database: State<'_, Database>, settings: AppSettings) -> Result<AppSettings, String> {
    if settings.default_sampling_interval_seconds < 2 {
        return Err("前台采样间隔不能短于 2 秒".into());
    }
    if settings.background_sampling_interval_seconds < 5 || settings.process_interval_seconds < 2 {
        return Err("后台采样不能短于 5 秒，进程刷新不能短于 2 秒".into());
    }
    if settings.realtime_window_minutes < 10 || settings.history_retention_days == 0 {
        return Err("实时趋势窗口至少 10 分钟，历史保存至少 1 天".into());
    }
    database.save_settings(&settings)?;
    Ok(settings)
}

#[tauri::command]
async fn scan_host_key(database: State<'_, Database>, server_id: String) -> Result<HostKeyInfo, String> {
    let server = database.get_server(&server_id)?;
    host_key::scan(&server).await
}

#[tauri::command]
fn trust_host_key(database: State<'_, Database>, info: HostKeyInfo) -> Result<(), String> {
    let server = database.get_server(&info.server_id)?;
    host_key::trust(&server, &info)
}

#[tauri::command]
async fn install_nvidia_driver(database: State<'_, Database>, server_id: String, confirmed: bool) -> Result<String, String> {
    if !confirmed { return Err("必须在界面明确确认后才能安装驱动".into()); }
    let server = database.get_server(&server_id)?;
    let password = if server.auth_method == "password" { database.get_password(&server_id, true)? } else { None };
    collector::install_nvidia_driver(&server, password.as_deref()).await
}

#[tauri::command]
async fn terminate_process(database: State<'_, Database>, server_id: String, pid: u32, confirmed: bool) -> Result<String, String> {
    if !confirmed { return Err("必须在界面完成二次确认后才能结束进程".into()); }
    let server = database.get_server(&server_id)?;
    let password = if server.auth_method == "password" { database.get_password(&server_id, true)? } else { None };
    collector::terminate_process_tree(&server, password.as_deref(), pid).await
}

#[tauri::command]
async fn launch_managed_run(database: State<'_, Database>, server_id: String, run_id: String, working_directory: String, command: String, gpu_indices: Vec<u32>) -> Result<ManagedRunLaunchResult, String> {
    let server = database.get_server(&server_id)?;
    let password = if server.auth_method == "password" { database.get_password(&server_id, true)? } else { None };
    collector::launch_managed_run(&server, password.as_deref(), &run_id, &working_directory, &command, &gpu_indices).await
}

#[tauri::command]
async fn read_managed_run_log(database: State<'_, Database>, server_id: String, run_id: String, lines: u32) -> Result<String, String> {
    let server = database.get_server(&server_id)?;
    let password = if server.auth_method == "password" { database.get_password(&server_id, true)? } else { None };
    collector::read_managed_run_log(&server, password.as_deref(), &run_id, lines).await
}

#[tauri::command]
async fn get_managed_run_status(database: State<'_, Database>, server_id: String, run_id: String, pid: u32) -> Result<ManagedRunRemoteStatus, String> {
    let server = database.get_server(&server_id)?;
    let password = if server.auth_method == "password" { database.get_password(&server_id, true)? } else { None };
    collector::managed_run_status(&server, password.as_deref(), &run_id, pid).await
}

fn tray_pixel(rgba: &mut [u8], width: usize, x: usize, y: usize, alpha: u8) {
    if x >= width || y >= 18 { return; }
    let index = (y * width + x) * 4;
    rgba[index..index + 4].copy_from_slice(&[0, 0, 0, alpha]);
}

fn tray_rect(rgba: &mut [u8], width: usize, x: usize, y: usize, rect_width: usize, rect_height: usize, alpha: u8) {
    for draw_y in y..y + rect_height {
        for draw_x in x..x + rect_width {
            tray_pixel(rgba, width, draw_x, draw_y, alpha);
        }
    }
}

const TRAY_DIGITS: [[u8; 15]; 10] = [
    [1,1,1, 1,0,1, 1,0,1, 1,0,1, 1,1,1],
    [0,1,0, 1,1,0, 0,1,0, 0,1,0, 1,1,1],
    [1,1,1, 0,0,1, 1,1,1, 1,0,0, 1,1,1],
    [1,1,1, 0,0,1, 0,1,1, 0,0,1, 1,1,1],
    [1,0,1, 1,0,1, 1,1,1, 0,0,1, 0,0,1],
    [1,1,1, 1,0,0, 1,1,1, 0,0,1, 1,1,1],
    [1,1,1, 1,0,0, 1,1,1, 1,0,1, 1,1,1],
    [1,1,1, 0,0,1, 0,1,0, 0,1,0, 0,1,0],
    [1,1,1, 1,0,1, 1,1,1, 1,0,1, 1,1,1],
    [1,1,1, 1,0,1, 1,1,1, 0,0,1, 1,1,1],
];

fn tray_digit(rgba: &mut [u8], width: usize, x: usize, value: usize, alpha: u8) {
    for (index, pixel) in TRAY_DIGITS[value].iter().enumerate() {
        if *pixel == 0 { continue; }
        tray_rect(rgba, width, x + (index % 3) * 2, 4 + (index / 3) * 2, 2, 2, alpha);
    }
}

fn tray_count(rgba: &mut [u8], width: usize, x: usize, count: usize, alpha: u8) {
    let count = count.min(99);
    if count >= 10 {
        tray_digit(rgba, width, x, count / 10, alpha);
        tray_digit(rgba, width, x + 8, count % 10, alpha);
    } else {
        tray_digit(rgba, width, x + 4, count, alpha);
    }
}

fn render_tray_image(mode: &str, reservation_pending: usize, process_warnings: usize) -> (Vec<u8>, u32, u32) {
    let expanded = mode == "expanded";
    let width = if expanded { 78usize } else { 18usize };
    let mut rgba = vec![0u8; width * 18 * 4];
    for x in 2..16 {
        let y = if x < 6 { 10 } else if x < 9 { 5 } else if x < 12 { 12 } else { 7 };
        for offset in 0..2 {
            tray_pixel(&mut rgba, width, x, y + offset, 255);
        }
    }

    if !expanded && reservation_pending + process_warnings > 0 {
        tray_rect(&mut rgba, width, 13, 2, 3, 3, 255);
    }
    if expanded {
        let reservation_alpha = if reservation_pending > 0 { 255 } else { 76 };
        let process_alpha = if process_warnings > 0 { 255 } else { 76 };

        // Bell and its fixed-width two-digit counter.
        tray_rect(&mut rgba, width, 22, 3, 5, 1, reservation_alpha);
        tray_rect(&mut rgba, width, 20, 5, 1, 6, reservation_alpha);
        tray_rect(&mut rgba, width, 28, 5, 1, 6, reservation_alpha);
        tray_rect(&mut rgba, width, 21, 11, 7, 2, reservation_alpha);
        tray_rect(&mut rgba, width, 24, 14, 2, 1, reservation_alpha);
        tray_count(&mut rgba, width, 31, reservation_pending, reservation_alpha);

        // Terminal window with an exclamation mark and its warning counter.
        tray_rect(&mut rgba, width, 49, 4, 11, 1, process_alpha);
        tray_rect(&mut rgba, width, 49, 5, 1, 9, process_alpha);
        tray_rect(&mut rgba, width, 59, 5, 1, 9, process_alpha);
        tray_rect(&mut rgba, width, 49, 13, 11, 1, process_alpha);
        tray_rect(&mut rgba, width, 54, 7, 2, 4, process_alpha);
        tray_rect(&mut rgba, width, 54, 12, 2, 1, process_alpha);
        tray_count(&mut rgba, width, 62, process_warnings, process_alpha);
    }
    (rgba, width as u32, 18)
}

fn tray_image(mode: &str, reservation_pending: usize, process_warnings: usize) -> Image<'static> {
    let (rgba, width, height) = render_tray_image(mode, reservation_pending, process_warnings);
    Image::new_owned(rgba, width, height)
}

#[cfg(test)]
mod tray_image_tests {
    use super::render_tray_image;

    #[test]
    fn compact_and_expanded_images_keep_stable_dimensions() {
        let (compact, compact_width, compact_height) = render_tray_image("compact", 0, 0);
        let (compact_alert, alert_width, alert_height) = render_tray_image("compact", 1, 2);
        let (expanded, expanded_width, expanded_height) = render_tray_image("expanded", 0, 0);
        let (expanded_alert, expanded_alert_width, expanded_alert_height) = render_tray_image("expanded", 12, 3);

        assert_eq!((compact_width, compact_height), (18, 18));
        assert_eq!((alert_width, alert_height), (18, 18));
        assert_eq!((expanded_width, expanded_height), (78, 18));
        assert_eq!((expanded_alert_width, expanded_alert_height), (78, 18));
        assert_ne!(compact, compact_alert);
        assert_eq!(expanded.len(), expanded_alert.len());
        assert_ne!(expanded, expanded_alert);
    }
}

fn build_tray_menu(app: &AppHandle, reservation_pending: usize, process_warnings: usize) -> Result<Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    let open = MenuItemBuilder::with_id("open", "打开 RackTop").build(app)?;
    let reservations = MenuItemBuilder::with_id("reservations", format!("预约待处理  {}", reservation_pending)).build(app)?;
    let processes = MenuItemBuilder::with_id("mine-processes", format!("我的进程异常  {}", process_warnings)).build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
    Ok(MenuBuilder::new(app).item(&open).separator().items(&[&reservations, &processes]).separator().item(&quit).build()?)
}

fn build_application_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    let about = MenuItemBuilder::with_id("menu-about", "关于 RackTop").build(app)?;
    let settings = MenuItemBuilder::with_id("menu-settings", "设置…").accelerator("CmdOrCtrl+,").build(app)?;
    let quit = MenuItemBuilder::with_id("menu-quit", "退出 RackTop").accelerator("CmdOrCtrl+Q").build(app)?;
    let racktop = SubmenuBuilder::new(app, "RackTop").items(&[&about, &settings]).separator().item(&quit).build()?;

    let edit = SubmenuBuilder::new(app, "编辑")
        .undo_with_text("撤销")
        .redo_with_text("重做")
        .separator()
        .cut_with_text("剪切")
        .copy_with_text("复制")
        .paste_with_text("粘贴")
        .select_all_with_text("全选")
        .build()?;

    let add_server = MenuItemBuilder::with_id("menu-add-server", "添加服务器…").accelerator("CmdOrCtrl+N").build(app)?;
    let import_config = MenuItemBuilder::with_id("menu-import-config", "导入 SSH Config…").build(app)?;
    let refresh_all = MenuItemBuilder::with_id("menu-refresh-all", "刷新全部服务器").accelerator("CmdOrCtrl+R").build(app)?;
    let servers = SubmenuBuilder::new(app, "服务器").items(&[&add_server, &import_config]).separator().item(&refresh_all).build()?;

    let fleet = MenuItemBuilder::with_id("menu-view-fleet", "算力总览").accelerator("CmdOrCtrl+1").build(app)?;
    let idle = MenuItemBuilder::with_id("menu-view-idle", "空闲算力").accelerator("CmdOrCtrl+2").build(app)?;
    let mine = MenuItemBuilder::with_id("menu-view-mine", "我的进程").accelerator("CmdOrCtrl+3").build(app)?;
    let logs = MenuItemBuilder::with_id("menu-view-logs", "日志").accelerator("CmdOrCtrl+L").build(app)?;
    let view = SubmenuBuilder::new(app, "查看").items(&[&fleet, &idle, &mine]).separator().item(&logs).build()?;

    let window = SubmenuBuilder::with_id(app, WINDOW_SUBMENU_ID, "窗口")
        .minimize_with_text("最小化")
        .maximize_with_text("缩放")
        .fullscreen_with_text("进入全屏幕")
        .separator()
        .bring_all_to_front_with_text("全部置于顶层")
        .build()?;

    let guide = MenuItemBuilder::with_id("menu-help-guide", "使用说明").build(app)?;
    let project = MenuItemBuilder::with_id("menu-help-project", "打开项目主页").build(app)?;
    let help = SubmenuBuilder::with_id(app, HELP_SUBMENU_ID, "帮助").items(&[&guide, &project]).build()?;

    Ok(MenuBuilder::new(app).items(&[&racktop, &edit, &servers, &view, &window, &help]).build()?)
}

#[tauri::command]
fn update_tray_summary(app: AppHandle, mode: String, reservation_pending: usize, process_warnings: usize) -> Result<(), String> {
    let mode = if mode == "expanded" { "expanded" } else { "compact" };
    let menu = build_tray_menu(&app, reservation_pending, process_warnings).map_err(|error| error.to_string())?;
    let tray = app.tray_by_id("racktop-tray").ok_or("找不到 RackTop 菜单栏图标")?;
    tray.set_menu(Some(menu)).map_err(|error| error.to_string())?;
    tray.set_icon_with_as_template(Some(tray_image(mode, reservation_pending, process_warnings)), true).map_err(|error| error.to_string())?;
    tray.set_tooltip(Some(&format!("RackTop · 预约待处理 {} · 我的进程异常 {}", reservation_pending, process_warnings))).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_data = app.path().app_data_dir().map_err(|error| Box::<dyn std::error::Error>::from(error))?;
            let database = Database::open(&app_data.join("racktop.sqlite")).map_err(|error| Box::<dyn std::error::Error>::from(std::io::Error::other(error)))?;
            app.manage(database);
            app.manage(TerminalManager::default());
            app.manage(InteractionLogStore::default());

            app.set_menu(build_application_menu(&app.handle())?)?;

            let menu = build_tray_menu(&app.handle(), 0, 0)?;
            TrayIconBuilder::with_id("racktop-tray")
                .icon(tray_image("compact", 0, 0))
                .icon_as_template(true)
                .tooltip("RackTop · GPU 与 CPU 监控")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" | "reservations" | "mine-processes" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        let _ = app.emit("tray-action", event.id().as_ref());
                    }
                    "quit" => {
                        app.state::<TerminalManager>().close_all();
                        app.exit(0)
                    },
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "menu-quit" => {
                app.state::<TerminalManager>().close_all();
                app.exit(0);
            }
            id if id.starts_with("menu-") => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                let _ = app.emit("app-menu-action", id);
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![list_servers, save_server, delete_server, retry_remote_cleanups, reorder_servers, start_terminal, write_terminal, resize_terminal, close_terminal, collect_server, get_interaction_log_summary, get_history, get_history_heatmap, get_usage_distribution, configure_remote_history, sync_remote_history, list_idle_reservations, save_idle_reservation, delete_idle_reservation, list_projects, save_project, delete_project, probe_project_paths, suggest_project_paths, inspect_project, inspect_project_source, sync_project, list_project_sync_progress, cancel_project_sync, import_ssh_config, get_settings, save_settings, scan_host_key, trust_host_key, install_nvidia_driver, terminate_process, launch_managed_run, read_managed_run_log, get_managed_run_status, update_tray_summary])
        .run(tauri::generate_context!())
        .expect("RackTop 启动失败");
}
