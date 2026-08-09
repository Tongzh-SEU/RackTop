use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub id: String,
    pub name: String,
    pub location: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub ssh_alias: Option<String>,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
    pub tags: Vec<String>,
    pub sampling_interval_seconds: u64,
    pub history_retention_days: u32,
    #[serde(default)]
    pub remote_history_enabled: bool,
    #[serde(default)]
    pub remote_history_last_sync_at: Option<i64>,
    #[serde(default)]
    pub sort_order: i64,
    pub auth_method: String,
    pub status: String,
    pub last_error: Option<String>,
    pub last_seen_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerDraft {
    pub id: Option<String>,
    pub name: String,
    pub location: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub ssh_alias: Option<String>,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub sampling_interval_seconds: u64,
    pub history_retention_days: u32,
    #[serde(default)]
    pub remote_history_enabled: bool,
    pub auth_method: String,
    pub password: Option<String>,
    #[serde(default)]
    pub save_password: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCleanupResult {
    pub remote_cleaned: bool,
    pub cleanup_pending: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCleanupSweepResult {
    pub cleaned_names: Vec<String>,
    pub pending_names: Vec<String>,
    pub expired_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionServerSummary {
    pub server_id: String,
    pub server_name: String,
    pub sent_bytes: u64,
    pub response_bytes: u64,
    pub stored_bytes: u64,
    pub last_started_at: i64,
    pub last_finished_at: Option<i64>,
    pub last_command: String,
    pub status: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionLogSummary {
    pub sent_bytes: u64,
    pub response_bytes: u64,
    pub stored_bytes: u64,
    pub local_storage_bytes: u64,
    pub failure_count: u64,
    pub servers: Vec<InteractionServerSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTarget {
    pub server_id: String,
    pub path: String,
    pub status: String,
    pub exists: bool,
    pub is_directory: bool,
    pub size_bytes: u64,
    pub file_count: u64,
    pub last_checked_at: Option<i64>,
    pub last_synced_at: Option<i64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub source_server_id: String,
    pub source_path: String,
    pub source_exists: bool,
    pub source_is_directory: bool,
    pub source_size_bytes: u64,
    pub source_file_count: u64,
    pub dataset_ids: Vec<String>,
    pub targets: Vec<ProjectTarget>,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_sync_at: Option<i64>,
    pub status: String,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTargetDraft {
    pub server_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDraft {
    pub id: Option<String>,
    pub name: String,
    pub kind: String,
    pub source_server_id: String,
    pub source_path: String,
    #[serde(default)]
    pub dataset_ids: Vec<String>,
    pub targets: Vec<ProjectTargetDraft>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPathCheck {
    pub server_id: String,
    pub requested_path: String,
    pub suggested_path: String,
    pub exists: bool,
    pub is_directory: bool,
    pub size_bytes: u64,
    pub file_count: u64,
    pub matches: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSyncResult {
    pub project_id: String,
    pub target_server_id: String,
    pub transferred_bytes: u64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuMetric {
    pub index: u32,
    pub uuid: String,
    pub name: String,
    pub utilization: f64,
    pub memory_utilization: f64,
    pub memory_used_mb: f64,
    pub memory_total_mb: f64,
    pub temperature_celsius: f64,
    pub power_watts: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskMetric {
    pub mount_point: String,
    pub used_bytes: u64,
    pub total_bytes: u64,
    pub available_bytes: u64,
    #[serde(default)]
    pub current_user_used_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMetric {
    pub gpu_uuid: String,
    pub gpu_index: u32,
    pub pid: u32,
    pub parent_pid: u32,
    pub username: String,
    pub command: String,
    pub memory_used_mb: f64,
    pub sm_utilization: Option<f64>,
    pub cpu_percent: f64,
    pub elapsed: String,
    pub is_current_user: bool,
    pub is_group_leader: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuProcessMetric {
    pub pid: u32,
    pub parent_pid: u32,
    pub username: String,
    pub command: String,
    pub cpu_percent: f64,
    pub memory_percent: f64,
    pub memory_used_bytes: u64,
    pub elapsed: String,
    pub is_current_user: bool,
    pub is_group_leader: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SystemMetric {
    #[serde(default)]
    pub cpu_model: String,
    pub cpu_utilization: f64,
    pub current_user_cpu_utilization: f64,
    pub load1: f64,
    pub load5: f64,
    pub load15: f64,
    pub memory_used_bytes: u64,
    pub memory_total_bytes: u64,
    pub swap_used_bytes: u64,
    pub swap_total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub server_id: String,
    pub hostname: String,
    pub username: String,
    pub os_id: String,
    pub os_name: String,
    pub timestamp: i64,
    pub status: String,
    pub system: SystemMetric,
    pub gpus: Vec<GpuMetric>,
    #[serde(default)]
    pub disks: Vec<DiskMetric>,
    pub processes: Vec<ProcessMetric>,
    #[serde(default)]
    pub cpu_processes: Vec<CpuProcessMetric>,
    #[serde(default)]
    pub processes_sampled: bool,
    pub nvidia_smi: String,
    pub nvidia_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPoint {
    pub timestamp: i64,
    #[serde(default)]
    pub is_compacted: bool,
    pub cpu_utilization: f64,
    pub memory_utilization: f64,
    #[serde(default)]
    pub swap_utilization: f64,
    pub gpu_utilizations: HashMap<String, f64>,
    #[serde(default)]
    pub gpu_memory_utilizations: HashMap<String, f64>,
    #[serde(default)]
    pub cpu_min: f64,
    #[serde(default)]
    pub cpu_max: f64,
    #[serde(default)]
    pub memory_min: f64,
    #[serde(default)]
    pub memory_max: f64,
    #[serde(default)]
    pub swap_min: f64,
    #[serde(default)]
    pub swap_max: f64,
    #[serde(default)]
    pub gpu_mins: HashMap<String, f64>,
    #[serde(default)]
    pub gpu_maxes: HashMap<String, f64>,
    #[serde(default)]
    pub gpu_memory_mins: HashMap<String, f64>,
    #[serde(default)]
    pub gpu_memory_maxes: HashMap<String, f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryHeatmapPoint {
    pub timestamp: i64,
    pub sample_count: i64,
    pub cpu_utilization: f64,
    pub memory_utilization: f64,
    pub gpu_utilizations: HashMap<String, f64>,
    pub gpu_memory_utilizations: HashMap<String, f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHistorySyncResult {
    pub imported_count: usize,
    pub latest_timestamp: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsagePoint {
    pub timestamp: i64,
    pub gpu_uuid: String,
    pub username: String,
    pub active_seconds: i64,
    pub memory_mb_seconds: f64,
    pub coverage_seconds: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageUserAggregate {
    pub username: String,
    pub active_seconds: i64,
    pub memory_mb_seconds: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDistribution {
    pub users: Vec<UsageUserAggregate>,
    pub covered_days: i64,
    pub requested_days: i64,
    pub coverage_gpu_seconds: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleReservation {
    pub id: String,
    pub name: String,
    pub filters: serde_json::Value,
    pub created_at: i64,
    pub expires_at: Option<i64>,
    pub notify_mode: String,
    pub status: String,
    #[serde(default)]
    pub matched_gpu_keys: Vec<String>,
    #[serde(default)]
    pub current_available_gpu_keys: Vec<String>,
    #[serde(default)]
    pub pending_confirmation_gpu_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyInfo {
    pub server_id: String,
    pub host: String,
    pub algorithm: String,
    pub fingerprint: String,
    pub key_line: String,
    pub changed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub default_sampling_interval_seconds: u64,
    pub background_sampling_interval_seconds: u64,
    pub process_interval_seconds: u64,
    pub realtime_window_minutes: u64,
    pub history_enabled: bool,
    pub history_retention_days: u32,
    pub idle_gpu_threshold: f64,
    pub idle_memory_threshold_mb: f64,
    pub idle_duration_minutes: u64,
    pub temperature_threshold_celsius: f64,
    pub current_user_accent: String,
    pub theme: String,
    #[serde(default = "default_menu_bar_mode")]
    pub menu_bar_mode: String,
    pub reduce_motion: bool,
    #[serde(default = "default_true")]
    pub show_add_server_guide: bool,
}

fn default_true() -> bool { true }
fn default_menu_bar_mode() -> String { "compact".into() }

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            default_sampling_interval_seconds: 2,
            background_sampling_interval_seconds: 15,
            process_interval_seconds: 5,
            realtime_window_minutes: 30,
            history_enabled: true,
            history_retention_days: 90,
            idle_gpu_threshold: 10.0,
            idle_memory_threshold_mb: 40960.0,
            idle_duration_minutes: 10,
            temperature_threshold_celsius: 85.0,
            current_user_accent: "#0a84ff".into(),
            theme: "system".into(),
            menu_bar_mode: default_menu_bar_mode(),
            reduce_motion: false,
            show_add_server_guide: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::AppSettings;

    #[test]
    fn new_install_keeps_local_history_for_ninety_days_by_default() {
        let settings = AppSettings::default();
        assert_eq!(settings.history_retention_days, 90);
        assert!(settings.history_enabled);
        assert_eq!(settings.menu_bar_mode, "compact");
    }

    #[test]
    fn existing_settings_default_to_compact_menu_bar() {
        let mut value = serde_json::to_value(AppSettings::default()).unwrap();
        value.as_object_mut().unwrap().remove("menuBarMode");
        let settings: AppSettings = serde_json::from_value(value).unwrap();
        assert_eq!(settings.menu_bar_mode, "compact");
    }
}
