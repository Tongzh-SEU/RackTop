pub mod collector;
pub mod models;
mod host_key;
mod ssh_config;
mod storage;

use models::{AppSettings, HistoryPoint, HostKeyInfo, Server, ServerDraft, Snapshot};
use std::path::PathBuf;
use storage::Database;
use tauri::{image::Image, menu::{MenuBuilder, MenuItemBuilder}, tray::TrayIconBuilder, Emitter, Manager, State};

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
async fn collect_server(database: State<'_, Database>, server_id: String, include_processes: bool) -> Result<Snapshot, String> {
    let server = database.get_server(&server_id)?;
    let password = if server.auth_method == "password" { database.get_password(&server_id)? } else { None };
    match collector::collect_with_password(&server, password.as_deref(), include_processes).await {
        Ok(snapshot) => {
            database.update_status(&server_id, &snapshot.status, snapshot.nvidia_message.as_deref(), Some(snapshot.timestamp))?;
            database.save_snapshot(&snapshot)?;
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let app_data = app.path().app_data_dir().map_err(|error| Box::<dyn std::error::Error>::from(error))?;
            let database = Database::open(&app_data.join("racktop.sqlite")).map_err(|error| Box::<dyn std::error::Error>::from(std::io::Error::other(error)))?;
            app.manage(database);

            let open = MenuItemBuilder::with_id("open", "打开 RackTop").build(app)?;
            let connect = MenuItemBuilder::with_id("connect", "连接全部").build(app)?;
            let pause = MenuItemBuilder::with_id("pause", "暂停 / 继续采集").build(app)?;
            let idle = MenuItemBuilder::with_id("idle", "查看空闲 GPU").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&open, &connect, &pause, &idle, &quit]).build()?;
            TrayIconBuilder::new()
                .icon(tray_image())
                .tooltip("RackTop · GPU 与 CPU 监控")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" | "connect" | "pause" | "idle" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        let _ = app.emit("tray-action", event.id().as_ref());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![list_servers, save_server, delete_server, collect_server, get_history, import_ssh_config, get_settings, save_settings, scan_host_key, trust_host_key, install_nvidia_driver])
        .run(tauri::generate_context!())
        .expect("RackTop 启动失败");
}
