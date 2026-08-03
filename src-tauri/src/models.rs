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
    pub auth_method: String,
    pub password: Option<String>,
    #[serde(default)]
    pub save_password: bool,
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
    pub cpu_utilization: f64,
    pub memory_utilization: f64,
    #[serde(default)]
    pub swap_utilization: f64,
    pub gpu_utilizations: HashMap<String, f64>,
    #[serde(default)]
    pub gpu_memory_utilizations: HashMap<String, f64>,
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
    pub reduce_motion: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            default_sampling_interval_seconds: 2,
            background_sampling_interval_seconds: 15,
            process_interval_seconds: 5,
            realtime_window_minutes: 30,
            history_enabled: true,
            history_retention_days: 30,
            idle_gpu_threshold: 10.0,
            idle_memory_threshold_mb: 40960.0,
            idle_duration_minutes: 10,
            temperature_threshold_celsius: 85.0,
            current_user_accent: "#0a84ff".into(),
            theme: "system".into(),
            reduce_motion: false,
        }
    }
}
