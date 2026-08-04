pub mod collector;
pub mod models;
mod remote_history;
mod host_key;
mod ssh_config;
mod storage;
mod terminal;

use models::{AppSettings, HistoryHeatmapPoint, HistoryPoint, HostKeyInfo, IdleReservation, RemoteHistorySyncResult, Server, ServerDraft, Snapshot, UsageDistribution};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use storage::Database;
use terminal::TerminalManager;
use tauri::{image::Image, menu::{Menu, MenuBuilder, MenuItemBuilder}, tray::TrayIconBuilder, AppHandle, Emitter, Manager, State};

#[tauri::command]
fn list_servers(database: State<'_, Database>) -> Result<Vec<Server>, String> {
    database.list_servers()
}

#[tauri::command]
fn save_server(database: State<'_, Database>, draft: ServerDraft) -> Result<Server, String> {
    database.save_server(draft)
}

#[tauri::command]
fn delete_server(database: State<'_, Database>, server_id: String) -> Result<(), String> {
    database.delete_server(&server_id)
}

#[tauri::command]
fn reorder_servers(database: State<'_, Database>, server_ids: Vec<String>) -> Result<(), String> {
    database.reorder_servers(&server_ids)
}

#[tauri::command]
fn start_terminal(app: tauri::AppHandle, database: State<'_, Database>, terminals: State<'_, TerminalManager>, server_id: String, columns: u16, rows: u16, gpu_index: Option<u32>) -> Result<String, String> {
    let server = database.get_server(&server_id)?;
    let password = if server.auth_method == "password" { database.get_password(&server_id)? } else { None };
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
async fn collect_server(database: State<'_, Database>, server_id: String, include_processes: bool, record_history: bool) -> Result<Snapshot, String> {
    let server = database.get_server(&server_id)?;
    let password = if server.auth_method == "password" { database.get_password(&server_id)? } else { None };
    match collector::collect_with_password(&server, password.as_deref(), include_processes).await {
        Ok(snapshot) => {
            database.update_status(&server_id, &snapshot.status, snapshot.nvidia_message.as_deref(), Some(snapshot.timestamp))?;
            if record_history {
                database.save_snapshot(&snapshot)?;
            }
            Ok(snapshot)
        }
        Err(error) => Err(error),
    }
}

#[tauri::command]
fn get_history(database: State<'_, Database>, server_id: String, from_timestamp: i64) -> Result<Vec<HistoryPoint>, String> {
    database.get_history(&server_id, from_timestamp)
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
    let password = if server.auth_method == "password" { database.get_password(&server_id)? } else { None };
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
    let password = if server.auth_method == "password" { database.get_password(&server_id)? } else { None };
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
    let password = if server.auth_method == "password" { database.get_password(&server_id)? } else { None };
    collector::install_nvidia_driver(&server, password.as_deref()).await
}

#[tauri::command]
async fn terminate_process(database: State<'_, Database>, server_id: String, pid: u32, confirmed: bool) -> Result<String, String> {
    if !confirmed { return Err("必须在界面完成二次确认后才能结束进程".into()); }
    let server = database.get_server(&server_id)?;
    let password = if server.auth_method == "password" { database.get_password(&server_id)? } else { None };
    collector::terminate_process_group(&server, password.as_deref(), pid).await
}

fn tray_image() -> Image<'static> {
    let width = 18usize;
    let height = 18usize;
    let mut rgba = vec![0u8; width * height * 4];
    for x in 2..16 {
        let y = if x < 6 { 10 } else if x < 9 { 5 } else if x < 12 { 12 } else { 7 };
        for offset in 0..2 {
            let index = ((y + offset) * width + x) * 4;
            rgba[index..index + 4].copy_from_slice(&[255, 255, 255, 255]);
        }
    }
    Image::new_owned(rgba, width as u32, height as u32)
}

fn build_tray_menu(app: &AppHandle, summary: &str) -> Result<Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    let open = MenuItemBuilder::with_id("open", "打开 RackTop").build(app)?;
    let reservations = MenuItemBuilder::with_id("reservations", summary).build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
    Ok(MenuBuilder::new(app).items(&[&open, &reservations, &quit]).build()?)
}

#[tauri::command]
fn update_tray_summary(app: AppHandle, waiting: usize, current: usize, pending: usize) -> Result<(), String> {
    let summary = if waiting + current + pending == 0 { "预约摘要".to_string() } else { format!("预约 {} · 可用 {} · 待确认 {}", waiting, current, pending) };
    let menu = build_tray_menu(&app, &summary).map_err(|error| error.to_string())?;
    let tray = app.tray_by_id("racktop-tray").ok_or("找不到 RackTop 菜单栏图标")?;
    tray.set_menu(Some(menu)).map_err(|error| error.to_string())?;
    tray.set_tooltip(Some(&format!("RackTop · {summary}"))).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let app_data = app.path().app_data_dir().map_err(|error| Box::<dyn std::error::Error>::from(error))?;
            let database = Database::open(&app_data.join("racktop.sqlite")).map_err(|error| Box::<dyn std::error::Error>::from(std::io::Error::other(error)))?;
            app.manage(database);
            app.manage(TerminalManager::default());

            let menu = build_tray_menu(&app.handle(), "预约摘要")?;
            TrayIconBuilder::with_id("racktop-tray")
                .icon(tray_image())
                .tooltip("RackTop · GPU 与 CPU 监控")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" | "reservations" => {
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
        .invoke_handler(tauri::generate_handler![list_servers, save_server, delete_server, reorder_servers, start_terminal, write_terminal, resize_terminal, close_terminal, collect_server, get_history, get_history_heatmap, get_usage_distribution, configure_remote_history, sync_remote_history, list_idle_reservations, save_idle_reservation, delete_idle_reservation, import_ssh_config, get_settings, save_settings, scan_host_key, trust_host_key, install_nvidia_driver, terminate_process, update_tray_summary])
        .run(tauri::generate_context!())
        .expect("RackTop 启动失败");
}
